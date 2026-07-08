# MCP Multi-Tenant Architecture & Code Logic Explanation

This document explains how the dynamic multi-tenant credentials mapping works, detailing both the **Web Application** view and the **MCP Server** view, and how they bridge together to achieve tenant isolation.

---

## 1. The Core Challenge we Solved

* **Web Application:** Stateful. The React UI stores the current tenant OAuth token and Base URL directly in the user's browser `localStorage`. When the user makes calls, the browser sends these credentials in the request body. Therefore, different users on different computers automatically hit their own tenants.
* **MCP Server:** Stateless background process. Claude.ai connects directly to the MCP server URL. By default, an MCP server runs globally with a single set of credentials loaded from a `.env` file. If User A and User B both connected their Claude clients to the same MCP server, they would both see the same tenant.

We solved this by creating a **Secure Token-Based Routing Bridge**.

---

## 2. Component Architecture Overview

```
 [ User A Browser ]               [ Claude.ai User A ]
        │                                 │
(Connects Tenant)                  (Executes MCP Tool)
        │                                 │  sse?token=userA_token
        ▼                                 ▼
┌──────────────────────────────────────────────────┐
│              EXPRESS BACKEND SERVER              │
│                                                  │
│   ┌──────────────────────────────────────────┐   │
│   │        mcpTenantStore (Memory Map)       │   │
│   │                                          │   │
│   │   userA_token ──► Tenant A Credentials   │   │
│   │   userB_token ──► Tenant B Credentials   │   │
│   └──────────────────────────────────────────┘   │
│                         ▲                        │
│                         │ fetches context        │
└─────────────────────────┼────────────────────────┘
                          │
┌─────────────────────────┼────────────────────────┐
│               STANDALONE MCP SERVER              │
│                         │                        │
│   ┌─────────────────────┴────────────────────┐   │
│   │     AsyncLocalStorage (Request Scope)    │   │
│   │                                          │   │
│   │   Current async context = userA_token    │   │
│   └──────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
                          │
                          ▼
             [ SAP CPI Tenant A (Target) ]
```

---

## 3. Detailed Logic & Workflows

### A. Web Application Workflow (Registration)
1. **Mounting:** When the React UI mounts ([TenantAccess.jsx](file:///c:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/pages/TenantAccess.jsx)), it checks `localStorage` for a persistent `mcpToken`. If none exists, it generates a unique ID (e.g., `mcp_userA123`) and saves it. This token remains constant for this browser.
2. **Connecting:** When the user enters their CPI credentials (Client ID, Secret, URLs) and clicks **Connect**, the frontend sends this `mcpToken` alongside the credentials to the backend.
3. **Registering:** The backend ([server.js](file:///c:/Users/yashwanth.gr/Desktop/Tenant-Access/backend/server.js)) validates the credentials with SAP BTP. If successful, it stores the credentials in `mcpTenantStore` (an in-memory map) keyed by `mcpToken`:
   ```javascript
   mcpTenantStore.set(mcpToken, { clientId, clientSecret, baseUrl, accessToken, lastRefreshed })
   ```
4. **Link Generation:** The backend calculates the public-facing URL and appends the token as a query parameter (e.g., `https://.../sse?token=mcp_userA123`) and returns it. The UI displays this URL to the user.

---

### B. MCP Server Workflow (Execution & Isolation)
When the user registers `https://.../sse?token=mcp_userA123` in Claude.ai, the system isolates execution using three layers of code logic:

#### Layer 1: Query Parameter Transport (SSE)
* When Claude establishes the SSE stream, it hits the `/sse` route. The MCP server extracts `token = mcp_userA123` and binds it to that connection session's `transport` object.
* It sends the client a session-specific postback endpoint: `/messages?token=mcp_userA123`.

#### Layer 2: AsyncLocalStorage Context Wrapper
* When Claude executes a tool, it POSTs a message to `/messages?token=mcp_userA123`.
* In the MCP server ([server.js](file:///c:/Users/yashwanth.gr/Desktop/Tenant-Access/mcp-server/server.js)), we intercept this request and run the processing logic inside **`AsyncLocalStorage`**:
  ```javascript
  tokenStorage.run(token, async () => {
      // Any code executing inside this block will have access to `token`
      await transport.handlePostMessage(req, res);
  });
  ```
  This is a Node.js core feature that tracks state across asynchronous callbacks without having to pass variables through every function signature.

#### Layer 3: Dynamic Tenant Resolution
* Inside the tool execution wrapper ([toolHandlers.js](file:///c:/Users/yashwanth.gr/Desktop/Tenant-Access/mcp-server/mcp/toolHandlers.js)), the tool needs to call SAP CPI.
* It calls `getTenantContext()`, which extracts the active token from `tokenStorage`:
  ```javascript
  const token = tokenStorage.getStore(); // returns "mcp_userA123"
  ```
* If a token exists, it calls the backend via `GET /mcp/tenant-context?token=mcp_userA123`.
* The backend fetches the credentials from its `mcpTenantStore` map, verifies if the BTP OAuth token is expired (refreshing it automatically if older than 45 minutes), and returns the active credentials.
* The tool handler uses these credentials to make the SAP CPI call, ensuring User A's queries only ever hit Tenant A!
* **Security Enforcement:** If the MCP server is running in `sse` mode and a request lacks a valid token, the server **denies access** and throws an error rather than falling back to the `.env` credentials. The `.env` fallback is strictly restricted to local command-line development (`stdio` mode) to guarantee that your server credentials are never exposed over the network.
