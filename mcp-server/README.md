# Tenant Access MCP Server

Standalone phase-1 MCP server for this repo.

It leaves the existing backend unchanged and exposes three MCP tools:

- `list_jms_queues`
- `get_monitoring_logs`
- `get_pgp_keys`

For phase 1, tools call the existing backend `/chatbot/query` route as a bridge. Later phases can move each tool to clean `/api/*` backend endpoints without changing the MCP tool names.

## Setup

```powershell
cd mcp-server
npm install
Copy-Item .env.example .env
npm start
```

The server loads `../backend/.env` automatically. `mcp-server/.env` can override values.

## Claude Desktop Config

Use an absolute path:

```json
{
  "mcpServers": {
    "tenant-access-sap-cpi": {
      "command": "node",
      "args": [
        "C:\\Users\\yashwanth.gr\\Desktop\\Tenant-Access\\mcp-server\\server.js"
      ]
    }
  }
}
```

Restart Claude Desktop after editing the config.
