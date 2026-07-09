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
import { executeTool, tokenStorage } from "./mcp/toolHandlers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../backend/.env") });
dotenv.config({ path: path.resolve(__dirname, ".env"), override: true });

const createMcpServer = () => {
  const mcpServer = new Server(
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

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params || {};
    return executeTool(name, args);
  });

  return mcpServer;
};

const isSse = process.argv.includes("--sse") || process.env.SSE === "true";

if (isSse) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  let activeTransports = [];

  app.get("/sse", async (req, res) => {
    const { token } = req.query;
    console.log(`New SSE client connection requested. Token: ${token || "none"}`);
    
    const messageUrl = token ? `/messages?token=${encodeURIComponent(token)}` : "/messages";
    const transport = new SSEServerTransport(messageUrl, res);
    transport.token = token;
    
    activeTransports.push(transport);

    const connectionServer = createMcpServer();
    await connectionServer.connect(transport);

    req.on("close", () => {
      console.log(`SSE client connection closed. Token: ${token || "none"}`);
      activeTransports = activeTransports.filter((t) => t !== transport);
    });
  });

  app.post("/messages", async (req, res) => {
    const token = req.query.token;
    
    await tokenStorage.run(token, async () => {
      for (const transport of activeTransports) {
        try {
          if (transport.token !== token) {
            continue;
          }
          await transport.handlePostMessage(req, res);
          return;
        } catch (err) {
          // Search next transport session
        }
      }
      res.status(400).send("No active session matches the message");
    });
  });

  const port = (process.env.PORT && process.env.PORT !== "5000") ? process.env.PORT : 5001;
  app.listen(port, () => {
    console.log(`MCP SSE Server listening on port ${port}`);
    console.log(`SSE URL: http://localhost:${port}/sse`);
  });
} else {
  const transport = new StdioServerTransport();
  const connectionServer = createMcpServer();
  connectionServer.connect(transport).catch((error) => {
    console.error("MCP server failed to start:", error);
    process.exit(1);
  });
  console.log("MCP Stdio Server running");
}
