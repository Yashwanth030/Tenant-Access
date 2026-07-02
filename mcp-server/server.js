import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";
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

const isSse = process.argv.includes("--sse") || process.env.PORT || process.env.SSE;

if (isSse) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  let activeTransports = [];

  app.get("/sse", async (req, res) => {
    console.log("New SSE client connection requested");
    const transport = new SSEServerTransport("/messages", res);
    activeTransports.push(transport);

    await server.connect(transport);

    req.on("close", () => {
      console.log("SSE client connection closed");
      activeTransports = activeTransports.filter((t) => t !== transport);
    });
  });

  app.post("/messages", async (req, res) => {
    for (const transport of activeTransports) {
      try {
        await transport.handlePostMessage(req, res);
        return;
      } catch (err) {
        // Search next transport session
      }
    }
    res.status(400).send("No active session matches the message");
  });

  const port = process.env.PORT || 5001;
  app.listen(port, () => {
    console.log(`MCP SSE Server listening on port ${port}`);
    console.log(`SSE URL: http://localhost:${port}/sse`);
  });
} else {
  const transport = new StdioServerTransport();
  server.connect(transport).catch((error) => {
    console.error("MCP server failed to start:", error);
    process.exit(1);
  });
  console.log("MCP Stdio Server running");
}
