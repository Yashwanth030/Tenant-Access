import axios from "axios";
import { AsyncLocalStorage } from "node:async_hooks";

export const tokenStorage = new AsyncLocalStorage();


const DEFAULT_BACKEND_URL = "http://localhost:5000";
const TENANT_CONTEXT_TTL_MS = 45 * 60 * 1000;

let cachedTenantContext = null;

const cleanUrl = (value) => String(value || "").trim().replace(/\/+$/, "");

const getBackendUrl = () => cleanUrl(process.env.BACKEND_URL || DEFAULT_BACKEND_URL);

const isFreshTenantContext = (context) =>
  context?.token && context?.baseUrl && context?.createdAt && Date.now() - context.createdAt < TENANT_CONTEXT_TTL_MS;

const getConfiguredTenantContext = () => {
  const token = String(process.env.TENANT_TOKEN || "").trim();
  const baseUrl = cleanUrl(process.env.TENANT_BASE_URL || process.env.BASE_URL || "");

  if (!token || !baseUrl) {
    return null;
  }

  return {
    token,
    baseUrl,
    packages: [],
    source: "env",
    createdAt: Date.now()
  };
};

const connectTenantThroughBackend = async () => {
  const backendUrl = getBackendUrl();
  const clientId = String(process.env.CLIENT_ID || "").trim();
  const clientSecret = String(process.env.CLIENT_SECRET || "").trim();
  const tokenUrl = cleanUrl(process.env.TOKEN_URL || "");
  const baseUrl = cleanUrl(process.env.BASE_URL || process.env.TENANT_BASE_URL || "");

  const missing = [];
  if (!clientId) missing.push("CLIENT_ID");
  if (!clientSecret) missing.push("CLIENT_SECRET");
  if (!tokenUrl) missing.push("TOKEN_URL");
  if (!baseUrl) missing.push("BASE_URL");

  if (missing.length > 0) {
    throw new Error(`Missing tenant configuration for MCP server: ${missing.join(", ")}`);
  }

  const response = await axios.post(
    `${backendUrl}/connectTenant`,
    { clientId, clientSecret, tokenUrl, baseUrl },
    { timeout: 60000 }
  );

  return {
    token: response.data?.token,
    baseUrl: cleanUrl(response.data?.baseUrl || baseUrl),
    packages: Array.isArray(response.data?.packages) ? response.data.packages : [],
    source: "backend-connectTenant",
    createdAt: Date.now()
  };
};

const getTenantContext = async () => {
  const token = tokenStorage.getStore();

  if (token) {
    try {
      const backendUrl = getBackendUrl();
      const response = await axios.get(`${backendUrl}/mcp/tenant-context`, {
        params: { token },
        timeout: 15000
      });

      const { token: cpiToken, baseUrl, packages } = response.data || {};
      if (!cpiToken || !baseUrl) {
        throw new Error("Invalid tenant context returned from backend.");
      }

      return {
        token: cpiToken,
        baseUrl,
        packages: Array.isArray(packages) ? packages : [],
        source: `mcp-token-${token}`
      };
    } catch (err) {
      console.error(`Error fetching tenant context for token ${token}:`, err.message);
      throw new Error(`Failed to retrieve tenant context: ${err.message}`);
    }
  }

  // Prevent fallback to local .env credentials when running as an exposed SSE server for security.
  const isSse = process.argv.includes("--sse") || process.env.SSE === "true";
  if (isSse) {
    throw new Error("Access denied: A valid tenant session token is required to execute tools.");
  }

  if (isFreshTenantContext(cachedTenantContext)) {
    return cachedTenantContext;
  }

  cachedTenantContext = getConfiguredTenantContext() || (await connectTenantThroughBackend());

  if (!cachedTenantContext?.token || !cachedTenantContext?.baseUrl) {
    throw new Error("Unable to build tenant context for MCP tool call.");
  }

  return cachedTenantContext;
};

const buildPrompt = (toolName, args = {}) => {
  switch (toolName) {
    case "list_jms_queues": {
      const healthFilter = String(args.healthFilter || "").trim();
      return healthFilter && healthFilter !== "all"
        ? `show ${healthFilter} JMS queues`
        : "show all JMS queues";
    }

    case "get_monitoring_logs": {
      const parts = ["show"];
      if (args.status && args.status !== "All") parts.push(String(args.status).toLowerCase());
      parts.push("message logs");
      if (args.timeRange) parts.push(String(args.timeRange));
      if (args.packageName) parts.push(`for package ${args.packageName}`);
      if (args.artifactName) parts.push(`for artifact ${args.artifactName}`);
      if (args.messageId) parts.push(`with message id ${args.messageId}`);
      if (args.correlationId) parts.push(`with correlation id ${args.correlationId}`);
      return parts.join(" ");
    }

    case "get_pgp_keys": {
      const parts = ["get PGP keys"];
      if (args.keyName) parts.push(`matching ${args.keyName}`);
      if (args.keyring) parts.push(`in keyring ${args.keyring}`);
      if (args.runtimeLocationId) parts.push(`for runtime ${args.runtimeLocationId}`);
      return parts.join(" ");
    }

    default:
      return toolName;
  }
};

const callChatbotBridge = async (toolName, args = {}) => {
  const tenantContext = await getTenantContext();
  const response = await axios.post(
    `${getBackendUrl()}/chatbot/tools/execute`,
    {
      toolName,
      params: args,
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      packages: tenantContext.packages || []
    },
    { timeout: 120000 }
  );

  return response.data;
};

const formatItem = (item) => {
  const type = item.type || item.resource || "item";

  if (type === "jms-queue") {
    return `- ${item.name || item.key || item.id} | entries: ${item.entries ?? 0} | state: ${item.state || "n/a"} | usage: ${item.usage || "n/a"}`;
  }

  if (type === "report") {
    return `- ${item.iflowName || item.IntegrationFlowName || item.artifactName || "Unknown"} | ${item.status || item.Status || "n/a"} | ${item.logStart || item.LogStart || item.timestamp || "n/a"}`;
  }

  if (item.UserId || item.UserID || item.KeyId || item.KeyID || item.ValidityState) {
    return `- ${item.UserId || item.UserID || item.Name || item.Id || "PGP key"} | ${item.KeyId || item.KeyID || "no key id"} | ${item.ValidityState || item.validityState || "n/a"}`;
  }

  return `- ${JSON.stringify(item)}`;
};

const formatToolResponse = (toolName, args, data) => {
  const message = data?.message || "Tool completed.";
  const items = Array.isArray(data?.items) ? data.items : [];
  const pendingItems = Array.isArray(data?.pendingItems) ? data.pendingItems : [];
  const debugTool = data?.debug?.tool || data?.toolName || toolName;

  const lines = [
    `Executed tool: ${toolName} with arguments: ${JSON.stringify(args)}`,
    message + `\nBackend tool: ${debugTool}`
  ];

  if (items.length > 0) {
    lines.push("", `Returned ${items.length} item(s):`);
    lines.push(...items.slice(0, 20).map(formatItem));
  }

  if (pendingItems.length > 0) {
    lines.push("", `${pendingItems.length} more item(s) are available in the backend response.`);
  }

  return lines.join("\n");
};

export const executeTool = async (toolName, args = {}) => {
  try {
    const result = await callChatbotBridge(toolName, args);
    return {
      content: [{ type: "text", text: formatToolResponse(toolName, args, result) }]
    };
  } catch (error) {
    const detail = error.response?.data?.message || error.response?.data?.detail || error.message;
    return {
      content: [{ type: "text", text: `Error running ${toolName}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` }],
      isError: true
    };
  }
};

export default { executeTool };
