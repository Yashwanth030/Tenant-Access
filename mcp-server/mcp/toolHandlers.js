import axios from "axios";

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
  const prompt = buildPrompt(toolName, args);
  const response = await axios.post(
    `${getBackendUrl()}/chatbot/query`,
    {
      prompt,
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      packages: tenantContext.packages || []
    },
    { timeout: 120000 }
  );

  return {
    prompt,
    data: response.data
  };
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

const formatToolResponse = ({ prompt, data }) => {
  const message = data?.message || "Tool completed.";
  const items = Array.isArray(data?.items) ? data.items : [];
  const pendingItems = Array.isArray(data?.pendingItems) ? data.pendingItems : [];
  const debugTool = data?.debug?.tool ? `\nBackend tool: ${data.debug.tool}` : "";

  const lines = [`Prompt sent to backend bridge: ${prompt}`, message + debugTool];

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
      content: [{ type: "text", text: formatToolResponse(result) }]
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
