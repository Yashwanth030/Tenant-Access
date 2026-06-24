import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./mcp/toolRegistry.js";
import { executeTool } from "./mcp/toolHandlers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../backend/.env") });
dotenv.config({ path: path.resolve(__dirname, ".env"), override: true });

const server = new Server(
  {
    name: "tenant-access-sap-cpi",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params || {};
  return executeTool(name, args);
});

const transport = new StdioServerTransport();

server.connect(transport).catch((error) => {
  console.error("MCP server failed to start:", error);
  process.exit(1);
});
