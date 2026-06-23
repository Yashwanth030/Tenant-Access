# Complete API Endpoint Inventory + MCP Server Plan

## ─────────────────────────────────────────────
## PART A — ALL ENDPOINTS IN YOUR CODEBASE
## ─────────────────────────────────────────────

### A1. Your own Express backend routes (backend/server.js)

| Method | Route                    | What it does                                             | Needs tenant token? |
|--------|--------------------------|----------------------------------------------------------|---------------------|
| POST   | /connectTenant           | OAuth client-credentials → returns bearer token         | No (creates one)    |
| POST   | /getArtifacts            | List artifacts for one package or all packages           | Yes                 |
| POST   | /getMessages             | CPI MessageProcessingLogs with status/date filter        | Yes                 |
| POST   | /trigger-cpi             | Trigger a CPI iFlow via CPI_TRIGGER_ENDPOINT             | No (uses env creds) |
| POST   | /post-selection          | Alternative CPI trigger (iflowName + status + dates)    | No (uses env creds) |
| GET    | /latest-report           | Read monitoring rows from HANA CPI_DATA table            | No (uses HANA env)  |
| GET    | /payload-file            | Download single decoded payload from HANA                | No (uses HANA env)  |
| GET    | /export-reports-excel    | Generate Excel from HANA CPI_DATA and download           | No (uses HANA env)  |
| POST   | /send-excel-email        | Email the Excel to a recipient via SMTP                  | No (uses SMTP env)  |
| GET    | /download-reports-zip    | ZIP all payloads from HANA CPI_DATA and download         | No (uses HANA env)  |
| POST   | /jms-queues              | List all JMS queues from tenant                          | Yes                 |
| POST   | /jms-messages            | List messages inside one queue                           | Yes                 |
| POST   | /jms-resource-details    | Broker1 resource details (capacity, queue count etc)     | Yes                 |
| POST   | /jms-messages/move       | Move messages from one queue to another                  | Yes + CSRF          |
| POST   | /jms-messages/retry      | Retry failed messages in a queue                         | Yes + CSRF          |
| POST   | /jms-messages/delete     | Delete messages from a queue                             | Yes + CSRF          |
| POST   | /chatbot/query           | Current chatbot entry point                              | Yes (forwarded)     |
| GET    | /chatbot/capabilities    | List available chatbot tools                             | No                  |
| POST   | /cpi-data                | Debug: store incoming CPI webhook data                   | No                  |
| GET    | /cpi-data                | Debug: read stored CPI webhook data                      | No                  |

---

### A2. Internal SAP CPI OData APIs (called by your backend FROM server.js)

These are the real SAP APIs your backend wraps. The MCP tools will call your backend
routes which in turn call these — the MCP server never calls SAP directly.

| SAP OData Endpoint                                                              | Called by your route         |
|---------------------------------------------------------------------------------|------------------------------|
| GET  {base}/api/v1/IntegrationPackages                                          | /connectTenant, /getArtifacts|
| GET  {base}/api/v1/IntegrationPackages('{id}')/IntegrationDesigntimeArtifacts  | /getArtifacts                |
| GET  {base}/api/v1/MessageProcessingLogs                                        | /getMessages, /chatbot/query |
| GET  {base}/api/v1/MessageProcessingLogs('{mplId}')                             | enrichQueueMessages()        |
| GET  {base}/api/v1/Queues                                                       | /jms-queues                  |
| GET  {base}/api/v1/Queues('{key}')/Messages                                     | /jms-messages                |
| GET  {base}/api/v1/Queues('{key}')?$expand=Messages                             | /jms-messages (fallback)     |
| PATCH {base}/api/v1/Queues('{key}')?operation=move&target_queue=...&selector=.. | /jms-messages/move           |
| PATCH {base}/api/v1/Queues('{key}')?operation=retry&selector=...                | /jms-messages/retry          |
| DELETE {base}/api/v1/JmsMessages(Msgid='...',Name='...',Failed=true)            | /jms-messages/delete         |
| GET  {base}/api/v1/JmsBrokers('Broker1')                                        | /jms-resource-details        |
| POST {base}/$batch  (multipart/mixed)                                           | move/retry batch fallbacks   |

---

### A3. External services called by your backend

| Service        | URL pattern                                     | Used for                         |
|----------------|-------------------------------------------------|----------------------------------|
| SAP OAuth      | {tokenUrl}/oauth/token                          | Getting bearer token             |
| CPI Trigger    | CPI_TRIGGER_ENDPOINT env var                    | Triggering iFlow                 |
| HANA           | HANA_SERVER env var (hana-client SDK)           | CPI_DATA table reads             |
| SMTP           | SMTP_HOST:SMTP_PORT                             | Sending Excel email              |
| OpenRouter     | https://openrouter.ai/api/v1/chat/completions   | AI intent + summarization        |

---

## ─────────────────────────────────────────────
## PART B — MCP SERVER ARCHITECTURE
## ─────────────────────────────────────────────

### How it fits together

```
User types in chatbot (AppChatbot.jsx)
        │
        ▼
POST /chatbot/query  (Express backend — server.js)
        │
        ▼
MCP Client (inside server.js handleChatbotPrompt)
  → sends: system prompt + ALL MCP tool schemas + user query
  → to: OpenRouter (with tool_use / function_calling support)
        │
        ▼
OpenRouter picks ONE tool + fills parameters
        │
        ▼
MCP Server executes that tool
  (calls your existing backend functions: getJmsQueueRecords,
   fetchPackages, fetchArtifactsForPackage, etc. — already written!)
        │
        ▼
Raw data returned to MCP Client
        │
        ▼
Second OpenRouter call: "summarize this result in 1-2 sentences"
        │
        ▼
{ message, items, actions } returned to frontend
```

Key point: the MCP server is NOT a separate process.
It is an in-process tool registry inside server.js.
Your existing functions (getJmsQueueRecords, fetchTenantMonitoringLogs, etc.)
become the tool implementations — zero rewrite needed.

---

### MCP Tool definitions (one per backend capability)

Each tool has:
- name         → matches TENANT_CHAT_TOOLS key
- description  → what OpenRouter reads to pick the tool
- inputSchema  → JSON Schema for the parameters OpenRouter fills in
- handler      → which existing server.js function to call

```
┌─────────────────────────────┬─────────────────────────────────────────────────┐
│ Tool name                   │ Handler (existing function in server.js)         │
├─────────────────────────────┼─────────────────────────────────────────────────┤
│ list_packages               │ fetchPackages(baseUrl, token)                   │
│ list_artifacts              │ fetchArtifactsForPackage(baseUrl, token, pkgId) │
│ get_monitoring_logs         │ fetchTenantMonitoringLogs({baseUrl,token,prompt})│
│ get_monitoring_overview     │ getMonitoringOverviewData({prompt,token,baseUrl})│
│ export_monitoring_excel     │ returns download action → /export-reports-excel  │
│ download_payload_zip        │ returns download action → /download-reports-zip  │
│ send_monitoring_email       │ calls /send-excel-email with email param         │
│ list_jms_queues             │ getJmsQueueRecords(baseUrl, token)               │
│ list_jms_messages           │ getJmsMessagesForQueue(baseUrl,token,name,key)   │
│ get_jms_resources           │ getJmsBrokerResource(baseUrl, token, 'Broker1') │
│ move_jms_message            │ moveJmsMessage(baseUrl,token,src,tgt,id,failed) │
│ retry_jms_message           │ retryJmsMessage(baseUrl,token,queue,id,failed)  │
│ delete_jms_message          │ deleteJmsMessage(baseUrl,token,queue,id,failed) │
│ trigger_cpi_flow            │ POST /trigger-cpi (existing route)               │
└─────────────────────────────┴─────────────────────────────────────────────────┘
```

---

## ─────────────────────────────────────────────
## PART C — FULL FILE CHANGE PLAN
## ─────────────────────────────────────────────

### Files to create

```
backend/
  mcp/
    toolRegistry.js    ← defines every MCP tool (name, description, inputSchema)
    toolHandlers.js    ← maps tool name → existing server.js function call
    mcpClient.js       ← sends tools + prompt to OpenRouter, parses tool_call back
    summarizer.js      ← second OpenRouter call: turns raw data → natural sentence
  server.js            ← replace handleChatbotPrompt to use MCP client (small change)

frontend/
  src/components/
    AppChatbot.jsx     ← no structural change needed; minor UX improvements optional
```

### Changes to existing files

```
backend/server.js
  - Keep ALL existing route handlers and helper functions (nothing removed)
  - Replace handleChatbotPrompt() body to call mcpClient instead of
    classifyChatbotIntent + executeTenantChatTool
  - Export (or move) the core functions so toolHandlers.js can import them:
      getJmsQueueRecords, getJmsMessagesForQueue, getJmsBrokerResource,
      moveJmsMessage, retryJmsMessage, deleteJmsMessage,
      fetchPackages, fetchArtifactsForPackage, fetchArtifactsForPackagesInBatches,
      fetchTenantMonitoringLogs, enrichQueueMessages
  - Add require('./mcp/mcpClient') at top
```

---

## ─────────────────────────────────────────────
## PART D — EXACT CODE FOR EACH NEW FILE
## ─────────────────────────────────────────────

### backend/mcp/toolRegistry.js

```js
// Every tool the AI can pick from.
// description is what OpenRouter reads — be specific about filters/params.

const MCP_TOOLS = [
  {
    name: "list_packages",
    description:
      "List all SAP CPI integration packages in the connected tenant. " +
      "Use when the user asks about packages, package names, or wants to browse content.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "list_artifacts",
    description:
      "List integration artifacts (iFlows) inside a specific package, or all packages. " +
      "Use when the user asks about artifacts, iFlows, or content inside a package. " +
      "If a package name is mentioned, extract it into packageName. Otherwise leave empty for all.",
    inputSchema: {
      type: "object",
      properties: {
        packageName: {
          type: "string",
          description: "Exact or partial package name/ID to filter by. Leave empty for all packages."
        }
      },
      required: []
    }
  },
  {
    name: "get_monitoring_logs",
    description:
      "Fetch message processing logs from the tenant. " +
      "Use for: error messages, failed messages, completed messages, monitoring status, " +
      "past hour errors, today's failures, messages in a date range. " +
      "status filter: FAILED, COMPLETED, PROCESSING, RETRY. " +
      "range filter: 'past hour', 'today', 'past day', 'past week'.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["FAILED", "COMPLETED", "PROCESSING", "RETRY", ""],
          description: "Filter by message status. Leave empty for all statuses."
        },
        range: {
          type: "string",
          enum: ["past hour", "today", "past day", "past week", ""],
          description: "Time range for log retrieval."
        },
        outputMode: {
          type: "string",
          enum: ["list", "count", "summary"],
          description: "How to present results. Default: summary with count then list on follow-up."
        }
      },
      required: []
    }
  },
  {
    name: "get_monitoring_overview",
    description:
      "Show a dashboard summary of monitoring data including status breakdown, " +
      "available data fields, and quick stats. Use when user asks 'what monitoring data is available', " +
      "'show dashboard', 'overview', or a general monitoring question without specific filters.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "export_monitoring_excel",
    description:
      "Export the current monitoring report as an Excel file for download. " +
      "Use when user asks to download Excel, export report, convert to Excel.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "download_payload_zip",
    description:
      "Download all payload files from the latest monitoring report as a ZIP archive. " +
      "Use when user asks to download payloads, download all files, get zip, payload zip.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "send_monitoring_email",
    description:
      "Send the monitoring Excel report to an email address. " +
      "Use when user mentions email, send report, mail report. Extract the email address if present.",
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Recipient email address. Ask if not provided."
        }
      },
      required: []
    }
  },
  {
    name: "list_jms_queues",
    description:
      "List all JMS queues in the tenant. " +
      "Use for: show queues, how many queues, JMS queues, all queues. " +
      "If user asks for failed/error/stopped/DLQ queues, set healthFilter to 'failed'.",
    inputSchema: {
      type: "object",
      properties: {
        healthFilter: {
          type: "string",
          enum: ["failed", "error", "stopped", "dlq", "all", ""],
          description: "Filter to only show queues with problems. Leave empty for all."
        }
      },
      required: []
    }
  },
  {
    name: "list_jms_messages",
    description:
      "List messages inside a specific JMS queue. " +
      "Use when user asks about messages in a queue, what is in a queue, queue contents. " +
      "queueName is required — ask the user if not provided.",
    inputSchema: {
      type: "object",
      properties: {
        queueName: {
          type: "string",
          description: "Name of the JMS queue to fetch messages from. Required."
        }
      },
      required: ["queueName"]
    }
  },
  {
    name: "get_jms_resources",
    description:
      "Get JMS broker resource details: capacity, queue count, thresholds. " +
      "Use when user asks about JMS resources, broker usage, capacity, queue limits.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "move_jms_message",
    description:
      "Move a JMS message from one queue to another. " +
      "Requires messageId (format: ID:...), sourceQueue, and targetQueue. " +
      "Ask for anything missing before executing.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "JMS message ID, format: ID:xxxxxxxxxxxxxxxx. Required."
        },
        sourceQueue: {
          type: "string",
          description: "Source queue name. Required."
        },
        targetQueue: {
          type: "string",
          description: "Target queue name. Required."
        }
      },
      required: ["messageId", "sourceQueue", "targetQueue"]
    }
  },
  {
    name: "retry_jms_message",
    description:
      "Retry a failed JMS message. " +
      "Requires messageId and sourceQueue. Ask for anything missing.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "JMS message ID. Required."
        },
        sourceQueue: {
          type: "string",
          description: "Queue the message is in. Required."
        }
      },
      required: ["messageId", "sourceQueue"]
    }
  },
  {
    name: "delete_jms_message",
    description:
      "Delete a JMS message permanently from a queue. " +
      "Requires messageId and sourceQueue. This is destructive — confirm if not explicit.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "JMS message ID. Required."
        },
        sourceQueue: {
          type: "string",
          description: "Queue the message is in. Required."
        }
      },
      required: ["messageId", "sourceQueue"]
    }
  },
  {
    name: "trigger_cpi_flow",
    description:
      "Trigger a CPI integration flow. " +
      "Use when user asks to trigger, run, execute, start an iFlow. " +
      "Works best through the Monitoring Overview UI for full control.",
    inputSchema: {
      type: "object",
      properties: {
        iflowName: {
          type: "string",
          description: "Name of the iFlow to trigger. Use empty string for all."
        },
        status: {
          type: "string",
          description: "Status filter (COMPLETED, FAILED, etc.) or empty for all."
        },
        fromDate: {
          type: "string",
          description: "ISO datetime string for start of range."
        },
        toDate: {
          type: "string",
          description: "ISO datetime string for end of range."
        }
      },
      required: []
    }
  }
];

// Convert to OpenRouter/OpenAI function-calling format
const getMcpToolsForOpenRouter = () =>
  MCP_TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));

module.exports = { MCP_TOOLS, getMcpToolsForOpenRouter };
```

---

### backend/mcp/toolHandlers.js

```js
/**
 * Maps every MCP tool name to a function that:
 * 1. Takes (params, tenantContext) where params come from OpenRouter tool_call
 * 2. Calls the matching existing server.js function
 * 3. Returns { items, actions, rawData } — rawData goes to summarizer
 *
 * tenantContext = { token, baseUrl, packages }
 * All business logic stays in server.js — this is just the wiring layer.
 */

const {
  fetchPackages,
  fetchArtifactsForPackage,
  fetchArtifactsForPackagesInBatches,
  fetchTenantMonitoringLogs,
  getMonitoringOverviewData,
  getJmsQueueRecords,
  getJmsMessagesForQueue,
  getJmsBrokerResource,
  enrichQueueMessages,
  moveJmsMessage,
  retryJmsMessage,
  deleteJmsMessage,
  filterProblemJmsQueues,
  resolvePackageForPrompt
} = require("../server"); // adjust path if you split into modules

const TOOL_HANDLERS = {

  list_packages: async (params, { token, baseUrl, packages }) => {
    if (token && baseUrl) {
      const { packages: live } = await fetchPackages(baseUrl, token);
      return { items: live.map((p) => ({ type: "package", ...p })), rawData: live };
    }
    return { items: packages.map((p) => ({ type: "package", ...p })), rawData: packages };
  },

  list_artifacts: async (params, { token, baseUrl, packages }) => {
    const { packageName } = params;
    if (!token || !baseUrl) {
      return { error: "Connect a tenant first to fetch artifacts." };
    }
    const { apiBaseUrl, packages: allPkgs } = await fetchPackages(baseUrl, token);

    if (!packageName) {
      // All packages
      const { results } = await fetchArtifactsForPackagesInBatches(apiBaseUrl, token, allPkgs);
      const artifacts = results.flatMap((r) => r.artifacts);
      return { items: artifacts.map((a) => ({ type: "artifact", ...a })), rawData: { count: artifacts.length } };
    }

    // Resolve package name → ID
    const { packageId, requestedPackage, matches } = resolvePackageForPrompt(
      `artifacts inside ${packageName} package`, allPkgs
    );

    if (!packageId) {
      return {
        message: matches.length
          ? `Found ${matches.length} package(s) matching "${requestedPackage}". Which one?`
          : `No package matching "${requestedPackage}" found.`,
        items: matches.map((p) => ({ type: "package", ...p })),
        rawData: { matches: matches.length }
      };
    }

    const artifacts = await fetchArtifactsForPackage(apiBaseUrl, token, packageId);
    return {
      items: artifacts.map((a) => ({ type: "artifact", ...a })),
      rawData: { packageId, count: artifacts.length }
    };
  },

  get_monitoring_logs: async (params, { token, baseUrl }) => {
    const { status = "", range = "", outputMode = "summary" } = params;
    const prompt = [
      outputMode === "list" ? "show" : "count",
      status ? status.toLowerCase() : "",
      range || ""
    ].filter(Boolean).join(" ") + " messages";

    const result = await fetchTenantMonitoringLogs({ baseUrl, token, prompt });
    const items = result.reports.slice(0, 10).map((r) => ({ type: "report", ...r }));

    return {
      items,
      pendingItems: result.reports.slice(10).map((r) => ({ type: "report", ...r })),
      rawData: {
        totalCount: result.totalCount,
        status: status || "ALL",
        range: result.range?.label || "all time",
        sample: result.reports.slice(0, 3)
      }
    };
  },

  get_monitoring_overview: async (params, { token, baseUrl }) => {
    const { reports, range, source, totalCount } = await getMonitoringOverviewData({
      prompt: "show monitoring overview",
      token,
      baseUrl
    });
    return {
      items: reports.slice(0, 5).map((r) => ({ type: "report", ...r })),
      actions: [
        { label: "Download Excel", url: "/export-reports-excel", method: "GET" },
        { label: "Download Payload ZIP", url: "/download-reports-zip", method: "GET" }
      ],
      rawData: { totalCount, source, range: range?.label }
    };
  },

  export_monitoring_excel: async () => ({
    items: [],
    actions: [{ label: "Download Excel", url: "/export-reports-excel", method: "GET" }],
    rawData: { action: "excel_download" }
  }),

  download_payload_zip: async () => ({
    items: [],
    actions: [{ label: "Download Payload ZIP", url: "/download-reports-zip", method: "GET" }],
    rawData: { action: "payload_zip_download" }
  }),

  send_monitoring_email: async (params) => {
    const { email } = params;
    if (!email) {
      return {
        message: "Please provide a recipient email address.",
        needsClarification: true,
        items: [],
        rawData: { action: "email_needs_address" }
      };
    }
    return {
      items: [],
      actions: [{
        label: `Send Excel to ${email}`,
        endpoint: "/send-excel-email",
        method: "POST",
        body: { to: email }
      }],
      rawData: { action: "email_ready", to: email }
    };
  },

  list_jms_queues: async (params, { token, baseUrl }) => {
    if (!token || !baseUrl) return { error: "Connect a tenant first." };
    const queues = await getJmsQueueRecords(baseUrl, token);
    const { healthFilter = "" } = params;

    const filtered = healthFilter && healthFilter !== "all"
      ? filterProblemJmsQueues(queues)
      : queues;

    return {
      items: filtered.map((q) => ({ type: "jms-queue", ...q })),
      rawData: { total: queues.length, filtered: filtered.length, healthFilter }
    };
  },

  list_jms_messages: async (params, { token, baseUrl }) => {
    if (!token || !baseUrl) return { error: "Connect a tenant first." };
    const { queueName } = params;
    if (!queueName) return { error: "Queue name is required.", needsClarification: true };

    const messages = await getJmsMessagesForQueue(baseUrl, token, queueName, queueName);
    const enriched = await enrichQueueMessages(baseUrl, token, messages);
    return {
      items: enriched.map((m) => ({ type: "jms-message", ...m })),
      rawData: { queue: queueName, count: enriched.length }
    };
  },

  get_jms_resources: async (params, { token, baseUrl }) => {
    if (!token || !baseUrl) return { error: "Connect a tenant first." };
    const resource = await getJmsBrokerResource(baseUrl, token, "Broker1");
    return {
      items: [{ type: "resource", ...resource }],
      rawData: resource
    };
  },

  move_jms_message: async (params, { token, baseUrl }) => {
    const { messageId, sourceQueue, targetQueue } = params;
    if (!messageId || !sourceQueue || !targetQueue) {
      return {
        error: "Need messageId, sourceQueue, and targetQueue to move a message.",
        needsClarification: true
      };
    }
    await moveJmsMessage(baseUrl, token, sourceQueue, targetQueue, messageId, true);
    return {
      items: [],
      rawData: { moved: true, messageId, from: sourceQueue, to: targetQueue }
    };
  },

  retry_jms_message: async (params, { token, baseUrl }) => {
    const { messageId, sourceQueue } = params;
    if (!messageId || !sourceQueue) {
      return { error: "Need messageId and sourceQueue.", needsClarification: true };
    }
    await retryJmsMessage(baseUrl, token, sourceQueue, messageId, true);
    return {
      items: [],
      rawData: { retried: true, messageId, queue: sourceQueue }
    };
  },

  delete_jms_message: async (params, { token, baseUrl }) => {
    const { messageId, sourceQueue } = params;
    if (!messageId || !sourceQueue) {
      return { error: "Need messageId and sourceQueue.", needsClarification: true };
    }
    await deleteJmsMessage(baseUrl, token, sourceQueue, messageId, true);
    return {
      items: [],
      rawData: { deleted: true, messageId, queue: sourceQueue }
    };
  },

  trigger_cpi_flow: async (params) => ({
    message:
      "CPI trigger works best through the Monitoring Overview UI. " +
      "Open it from the main screen, pick package, artifact, status, date range, then click Trigger.",
    items: [],
    rawData: { action: "cpi_trigger_guide" }
  })
};

module.exports = { TOOL_HANDLERS };
```

---

### backend/mcp/mcpClient.js

```js
/**
 * MCP Client — the brain of the new chatbot flow.
 *
 * Flow:
 *  1. Build system prompt + inject all MCP tool schemas
 *  2. Call OpenRouter with tool_choice="auto" and the tool list
 *  3. OpenRouter returns a tool_call with name + arguments
 *  4. Execute the tool via TOOL_HANDLERS
 *  5. Call summarizer to turn raw data → natural sentence
 *  6. Return { message, items, actions, pendingItems }
 */

require("dotenv").config();
const axios = require("axios");
const { getMcpToolsForOpenRouter } = require("./toolRegistry");
const { TOOL_HANDLERS } = require("./toolHandlers");
const { summarizeToolResult } = require("./summarizer");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.AI_INTENT_API_KEY;
const AI_INTENT_APP_URL = process.env.AI_INTENT_APP_URL || "http://localhost:5173";
const AI_INTENT_APP_NAME = process.env.AI_INTENT_APP_NAME || "Tenant Access";

// Fallback model chain — same key, tried in order
const MODEL_CHAIN = [
  process.env.AI_INTENT_MODEL || "nex-agi/nex-n2-pro:free",
  "meta-llama/llama-3.1-8b-instruct:free",
  "google/gemini-flash-1.5:free",
  "mistralai/mistral-7b-instruct:free"
].filter((m, i, a) => m && a.indexOf(m) === i);

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const MCP_SYSTEM_PROMPT = `
You are a helpful assistant for SAP Integration Suite operations.
You have access to tools that can fetch live data from the connected tenant.
When a user asks a question:
- Call the most appropriate tool.
- Fill in only the parameters that are clearly stated in the user message.
- If required parameters are missing for action tools (move, retry, delete),
  do NOT guess — instead respond with a clarification question (no tool call).
- For general questions about monitoring, queues, packages, artifacts: always call a tool.
- After getting tool results, summarize concisely in 1-2 sentences.
`.trim();

const callOpenRouterWithTools = async (messages, tools, model) => {
  const response = await axios.post(
    OPENROUTER_URL,
    {
      model,
      temperature: 0.2,
      messages,
      tools,
      tool_choice: "auto"
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": AI_INTENT_APP_URL,
        "X-Title": AI_INTENT_APP_NAME
      },
      timeout: 20000
    }
  );
  return response.data?.choices?.[0]?.message;
};

const runMcpChat = async ({ prompt, tenantContext }) => {
  if (!OPENAI_API_KEY) {
    return {
      message: "AI is not configured. Add OPENAI_API_KEY to backend .env.",
      items: [],
      actions: []
    };
  }

  const tools = getMcpToolsForOpenRouter();
  const messages = [
    { role: "system", content: MCP_SYSTEM_PROMPT },
    { role: "user", content: prompt }
  ];

  let aiMessage = null;
  let usedModel = null;

  // Try each model until one responds with a tool_call or text
  for (const model of MODEL_CHAIN) {
    try {
      aiMessage = await callOpenRouterWithTools(messages, tools, model);
      usedModel = model;
      if (aiMessage) break;
    } catch (err) {
      console.warn(`MCP: model ${model} failed:`, err.response?.data || err.message);
    }
  }

  if (!aiMessage) {
    return {
      message: "Could not reach AI service. Check OPENAI_API_KEY and model config.",
      items: [],
      actions: []
    };
  }

  // Case 1: AI decided to call a tool
  if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
    const toolCall = aiMessage.tool_calls[0]; // take first tool call
    const toolName = toolCall.function?.name;
    let toolParams = {};

    try {
      toolParams = JSON.parse(toolCall.function?.arguments || "{}");
    } catch {
      toolParams = {};
    }

    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      return {
        message: `Tool "${toolName}" is not implemented.`,
        items: [],
        actions: []
      };
    }

    let toolResult;
    try {
      toolResult = await handler(toolParams, tenantContext);
    } catch (err) {
      return {
        message: `Error running ${toolName}: ${err.response?.data?.message || err.message}`,
        items: [],
        actions: []
      };
    }

    // If tool returned a pre-built message (clarification, error) use it directly
    if (toolResult.error || toolResult.needsClarification) {
      return {
        message: toolResult.error || toolResult.message || "Please provide more details.",
        items: toolResult.items || [],
        actions: toolResult.actions || []
      };
    }

    // Summarize the raw data into a natural sentence
    const summary = await summarizeToolResult({
      prompt,
      toolName,
      rawData: toolResult.rawData
    });

    return {
      message: summary || toolResult.message || `Done: ${toolName}`,
      items: toolResult.items || [],
      pendingItems: toolResult.pendingItems || [],
      actions: toolResult.actions || [],
      debug: { tool: toolName, model: usedModel, params: toolParams }
    };
  }

  // Case 2: AI responded with plain text (clarification, greeting, unsupported)
  return {
    message: aiMessage.content || "I could not understand that request.",
    items: [],
    actions: [],
    debug: { tool: "none", model: usedModel }
  };
};

module.exports = { runMcpChat };
```

---

### backend/mcp/summarizer.js

```js
/**
 * Takes already-fetched tool data and asks OpenRouter to write
 * one short human-readable sentence describing it.
 * The model is NOT allowed to invent data — it only describes what is given.
 */

const axios = require("axios");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.AI_INTENT_API_KEY;
const AI_INTENT_APP_URL = process.env.AI_INTENT_APP_URL || "http://localhost:5173";

const SUMMARIZER_MODEL = process.env.AI_INTENT_MODEL || "nex-agi/nex-n2-pro:free";

const summarizeToolResult = async ({ prompt, toolName, rawData }) => {
  if (!OPENAI_API_KEY || !rawData) return null;

  const systemPrompt =
    "You write ONE short, friendly sentence (max 25 words) summarizing a data result for a user. " +
    "Only describe what is in the JSON. Never invent numbers or names not present. " +
    "If result is empty or zero, say so plainly. No markdown.";

  const userMessage = JSON.stringify({
    userAskedFor: prompt,
    toolUsed: toolName,
    result: rawData
  });

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: SUMMARIZER_MODEL,
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": AI_INTENT_APP_URL,
          "X-Title": "Tenant Access"
        },
        timeout: 10000
      }
    );

    return response.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn("Summarizer failed:", err.response?.data || err.message);
    return null;
  }
};

module.exports = { summarizeToolResult };
```

---

### Change to handleChatbotPrompt in server.js

```js
// REPLACE the existing handleChatbotPrompt function with this:

const { runMcpChat } = require("./mcp/mcpClient");

const handleChatbotPrompt = async ({ prompt, token, baseUrl, packages }) => {
  const tenantContext = createChatbotTenantContext({ token, baseUrl, packages });

  // Try MCP/AI path first
  if (process.env.OPENAI_API_KEY || process.env.AI_INTENT_API_KEY) {
    try {
      const result = await runMcpChat({ prompt, tenantContext });
      return {
        ...result,
        tenant: {
          connected: tenantContext.hasTenantConnection,
          tenantId: tenantContext.tenantId
        }
      };
    } catch (err) {
      console.warn("MCP chat failed, falling back to rules:", err.message);
    }
  }

  // Fallback: existing rule-based system (keep this — it works when AI is down)
  const fallbackIntent = classifyChatbotIntent(prompt);
  if (fallbackIntent.tool === "unsupported") {
    return attachChatbotTrace(buildChatbotUnsupportedResponse(), fallbackIntent, tenantContext);
  }
  const response = await executeTenantChatTool({ intent: fallbackIntent, tenantContext });
  return attachChatbotTrace(response, fallbackIntent, tenantContext);
};
```

---

## PART E — .env additions needed

```
# Already have:
OPENAI_API_KEY=your_rotated_openrouter_key_here
AI_INTENT_MODEL=nex-agi/nex-n2-pro:free
AI_INTENT_APP_URL=http://localhost:5173
AI_INTENT_APP_NAME=Tenant Access

# Optional: override summarizer model separately
# AI_SUMMARIZER_MODEL=meta-llama/llama-3.1-8b-instruct:free
```

---

## PART F — Build order (do in this exact order)

1. Rotate your OpenRouter key at openrouter.ai/keys
2. Create backend/mcp/ folder
3. Create toolRegistry.js   (copy from Part D above)
4. Extract/export core functions from server.js (getJmsQueueRecords etc.)
5. Create toolHandlers.js   (copy from Part D above, fix import path)
6. Create summarizer.js     (copy from Part D above)
7. Create mcpClient.js      (copy from Part D above)
8. Replace handleChatbotPrompt in server.js (Part D last section)
9. Test with: "show JMS queues", "artifacts in meena_demo package",
              "past hour failed messages", "list failed queues"
10. Add more models to MODEL_CHAIN if free-tier rate limits hit
