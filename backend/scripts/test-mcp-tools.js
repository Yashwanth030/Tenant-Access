/**
 * Direct MCP tool smoke test (no AI).
 *
 * Usage:
 *   node scripts/test-mcp-tools.js
 *
 * Requires backend/.env with tenant OAuth values OR pass env vars:
 *   CLIENT_ID, CLIENT_SECRET, TOKEN_URL, BASE_URL
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const axios = require("axios");
const { MCP_TOOLS } = require("../mcp/toolRegistry");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

const SAMPLE_PARAMS = {
  get_tenant_overview: { timeRange: "past hour" },
  get_message_status_overview: { timeRange: "past hour" },
  get_monitoring_logs: { status: "FAILED", range: "past hour", outputMode: "count" },
  get_monitoring_overview: { timeRange: "past hour" },
  get_integration_content: { runtimeStatus: "All" },
  list_packages: {},
  list_artifacts: { packageName: "" },
  get_security_materials: {},
  get_keystores: {},
  get_pgp_keys: {},
  get_access_policies: {},
  get_user_roles: {},
  get_data_stores: {},
  get_variables: {},
  get_number_ranges: {},
  get_partner_directory: {},
  get_message_locks: { lockType: "all" },
  get_system_logs: {},
  get_usage_details: { period: "current month" },
  get_connectivity_tests: {},
  export_monitoring_excel: {
    packageName: "REPLACE_PACKAGE",
    iflowName: "All",
    status: "All",
    range: "past hour"
  },
  download_payload_zip: {
    packageName: "REPLACE_PACKAGE",
    iflowName: "All",
    status: "All",
    range: "past hour"
  },
  download_payload_file: {
    mplId: "REPLACE",
    logStart: "REPLACE",
    attachmentTimestamp: "REPLACE"
  },
  send_monitoring_email: {
    packageName: "REPLACE_PACKAGE",
    iflowName: "All",
    status: "All",
    range: "past hour",
    email: "test@example.com"
  },
  list_jms_queues: { healthFilter: "all" },
  list_jms_messages: { queueName: "REPLACE_QUEUE" },
  get_jms_resources: {},
  move_jms_message: {
    messageId: "REPLACE",
    sourceQueue: "REPLACE",
    targetQueue: "REPLACE"
  },
  retry_jms_message: { messageId: "REPLACE", sourceQueue: "REPLACE" },
  delete_jms_message: { messageId: "REPLACE", sourceQueue: "REPLACE" },
  trigger_cpi_flow: {
    packageName: "REPLACE_PACKAGE",
    iflowName: "All",
    status: "All",
    range: "past hour"
  }
};

const connectTenant = async () => {
  const payload = {
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    tokenUrl: process.env.TOKEN_URL,
    baseUrl: process.env.BASE_URL
  };

  const response = await axios.post(`${BACKEND_URL}/connectTenant`, payload, { timeout: 60000 });
  return {
    token: response.data.token,
    baseUrl: response.data.baseUrl,
    packages: response.data.packages || []
  };
};

const run = async () => {
  console.log("Connecting tenant...");
  const session = await connectTenant();

  const results = [];

  for (const tool of MCP_TOOLS) {
    const params = SAMPLE_PARAMS[tool.name] || {};
    try {
      const response = await axios.post(
        `${BACKEND_URL}/chatbot/tools/execute`,
        {
          toolName: tool.name,
          params,
          token: session.token,
          baseUrl: session.baseUrl,
          packages: session.packages
        },
        { timeout: 120000 }
      );

      const data = response.data;
      const ok = response.status === 200 && !data.error;
      results.push({
        tool: tool.name,
        ok,
        items: Array.isArray(data.items) ? data.items.length : 0,
        message: data.message || data.error || "",
        resource: data.rawData?.resource || ""
      });
      console.log(`${ok ? "OK" : "WARN"}  ${tool.name}  items=${results.at(-1).items}  resource=${results.at(-1).resource}`);
    } catch (error) {
      results.push({
        tool: tool.name,
        ok: false,
        items: 0,
        message: error.response?.data?.message || error.message,
        resource: ""
      });
      console.log(`FAIL  ${tool.name}  ${results.at(-1).message}`);
    }
  }

  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\nSummary: ${passed}/${results.length} tools returned without error.`);
  console.log("Review WARN/FAIL rows and update backend/sap/resourceRegistry.js from SAP cockpit inspect.");
};

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
