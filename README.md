# Tenant Access Application

Tenant Access is a full-stack SAP Integration Suite / CPI utility with two main UI modules:

- `Message Monitoring Overview`
- `JMS Queues`
- `Tenant Assistant` chatbot overlay

The app has a React frontend and an Express backend. A user connects to a tenant with OAuth client credentials, then uses the app to:

- browse packages and artifacts
- trigger CPI flows
- view monitoring data stored in SAP HANA
- inspect payloads and export reports
- manage JMS queue messages with `Move`, `Retry`, and `Delete`
- ask the chatbot for the same operational data and actions available manually in the UI

## UI Structure

After tenant connection, the user lands on a simple launcher screen in [frontend/src/pages/TenantAccess.jsx](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/pages/TenantAccess.jsx) with two cards:

- `JMS Queues`
- `Message Monitoring Overview`

The chatbot is mounted globally in [frontend/src/App.jsx](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/App.jsx) through [frontend/src/components/AppChatbot.jsx](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/components/AppChatbot.jsx). It appears as a floating assistant button and can answer prompts about the same operational areas available from the UI.

Frontend routes are defined in [frontend/src/App.jsx](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/App.jsx):

- `/` -> Home
- `/login` -> Login
- `/tenant` -> Tenant Access
- `/status` -> Message Monitoring Overview
- `/jms-queues` -> JMS Queues
- `/unauthorized` -> Unauthorized

## Main Pages

### 1. Message Monitoring Overview

Implemented in [frontend/src/pages/StatusOverview.jsx](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/pages/StatusOverview.jsx).

This UI is used for:

- package selection
- artifact selection
- triggering CPI
- viewing latest HANA-backed monitoring records
- payload download
- Excel export
- sending Excel by email

### 2. JMS Queues

Implemented in [frontend/src/pages/JmsQueues.jsx](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/pages/JmsQueues.jsx).

This UI is used for:

- listing available JMS queues
- viewing queue messages
- filtering queues and messages
- loading broker resource details
- moving queue messages
- retrying queue messages
- deleting queue messages

### 3. Tenant Assistant Chatbot

Implemented in [frontend/src/components/AppChatbot.jsx](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/components/AppChatbot.jsx) with backend routing in [backend/server.js](C:/Users/yashwanth.gr/Desktop/Tenant-Access/backend/server.js).

The chatbot is rule-based and project-aware. It only answers prompts related to the application domain. If the prompt does not contain supported operational keywords, it responds with a not-applicable message.

Supported prompt areas:

- monitoring status
- error and failed messages
- reports
- payloads
- Excel export
- payload zip download
- email report sending
- packages
- artifacts
- JMS queues
- JMS queue messages
- JMS resource details
- JMS move
- JMS retry
- JMS delete

Example prompts:

```text
past hour error messages
show past hour error messages
show JMS queues
show messages in queue JMS_Queue_100
show JMS resources
move ID:10.147.158.688a3119dc16a96700:180 from JMS_Queue_100_DLQ to JMS_Queue_100
retry ID:10.147.158.688a3119dc16a96700:180 from JMS_Queue_100_DLQ
delete ID:10.147.158.688a3119dc16a96700:180 from JMS_Queue_100_DLQ
download excel report
download payload zip
send excel report to user@example.com
show packages
show artifacts for package All
```

Follow-up behavior:

- If the user asks for a count, such as `past hour error messages`, the chatbot gives the count and asks whether to show the rows.
- If the user replies `yes`, `show`, or `list`, the chatbot lists the pending result set.
- If the prompt is outside the supported application keywords, the chatbot returns `Not applicable question`.

## Current Frontend Runtime Config

[frontend/src/config.js](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/config.js) currently points to local backend:

```js
export const API_BASE_URL = "http://localhost:5000";
```

The deployed backend URL is still present as a commented line in that file.

## Backend Overview

Backend lives in [backend/server.js](C:/Users/yashwanth.gr/Desktop/Tenant-Access/backend/server.js).

Main responsibilities:

- tenant connection and OAuth token retrieval
- package and artifact discovery
- JMS queue and JMS message management
- CPI trigger calls
- HANA monitoring reads
- payload download
- Excel generation
- zip generation
- email sending

Backend dependencies are defined in [backend/package.json](C:/Users/yashwanth.gr/Desktop/Tenant-Access/backend/package.json).

## Backend API List

These are the current backend endpoints implemented in `server.js`.

### Tenant Connection

#### `POST /connectTenant`

Connects to SAP tenant using:

- `clientId`
- `clientSecret`
- `tokenUrl`
- `baseUrl`

Request body:

```json
{
  "clientId": "your-client-id",
  "clientSecret": "your-client-secret",
  "tokenUrl": "https://<tenant>.authentication.<region>.hana.ondemand.com/oauth/token",
  "baseUrl": "https://<tenant>.it-cpi001.cfapps.<region>.hana.ondemand.com"
}
```

Response:

```json
{
  "message": "Tenant Connected Successfully",
  "packages": [],
  "token": "access-token",
  "baseUrl": "resolved-base-url",
  "credentialSource": "trigger-env or request-env"
}
```

### Package And Artifact APIs

#### `POST /getArtifacts`

Fetches artifacts for one package or for all packages.

Request body:

```json
{
  "packageId": "All",
  "token": "tenant-access-token",
  "baseUrl": "https://<tenant>.it-cpi001.cfapps.<region>.hana.ondemand.com"
}
```

Response includes:

- `artifacts`
- `packages`
- `baseUrl`
- `cached`
- `partial`
- `failedPackages`

### Chatbot API

#### `POST /chatbot/query`

Processes a prompt and dispatches it to the same backend capabilities used by the manual UI.

Request body:

```json
{
  "prompt": "past hour error messages",
  "token": "tenant-access-token",
  "baseUrl": "https://<tenant>.it-cpi001.cfapps.<region>.hana.ondemand.com",
  "packages": []
}
```

Response shape:

```json
{
  "message": "Found 5 matching monitoring message(s) in the past hour. Do you want to see them?",
  "items": [],
  "pendingItems": [],
  "actions": [],
  "notApplicable": false
}
```

Main response fields:

- `message`: chatbot text shown to the user
- `items`: rows to display immediately
- `pendingItems`: rows saved for a follow-up `yes`, `show`, or `list`
- `actions`: downloadable or executable actions, such as Excel export
- `notApplicable`: true when the prompt is outside the application domain

Supported backend dispatch:

- monitoring report count/list from HANA
- error and status filtering
- payload zip action
- Excel download action
- email action when an email address is provided
- package listing from local session data
- artifact listing from CPI APIs
- JMS queue listing
- JMS queue message listing
- JMS resource details
- JMS move execution
- JMS retry execution
- JMS delete execution

### Message Monitoring Overview APIs

These are used by the `Message Monitoring Overview` UI.

#### `POST /getMessages`

Reads CPI message processing logs from the tenant API.

Request body:

```json
{
  "token": "tenant-access-token",
  "baseUrl": "https://<tenant>.it-cpi001.cfapps.<region>.hana.ondemand.com",
  "status": "COMPLETED",
  "artifactName": "All",
  "fromDate": "2026-03-01T00:00:00",
  "toDate": "2026-03-10T23:59:59"
}
```

#### `POST /trigger-cpi`

Triggers CPI with selected filter values.

Typical request:

```json
{
  "BASE_URL": "https://<tenant>.it-cpi001.cfapps.<region>.hana.ondemand.com",
  "IFLOW_NAME": "All",
  "STATUS": "",
  "FROM_DATE": "2026-03-01T00:00:00",
  "TO_DATE": "2026-03-10T23:59:59"
}
```

#### `POST /post-selection`

Alternative CPI trigger endpoint.

Request body:

```json
{
  "iflowName": "IF_SAMPLE",
  "status": "COMPLETED",
  "fromDate": "2026-03-01T00:00:00",
  "toDate": "2026-03-10T23:59:59"
}
```

#### `GET /latest-report`

Returns monitoring rows from HANA.

Response:

```json
{
  "reports": []
}
```

#### `GET /payload-file`

Fetches a single payload file.

Query params:

- `mplId`
- `logStart`
- `attachmentTimestamp`

#### `GET /export-reports-excel`

Exports the current monitoring report as Excel.

#### `POST /send-excel-email`

Emails the generated Excel file.

Request body:

```json
{
  "from": "sender@example.com",
  "to": "receiver@example.com",
  "subject": "Monitoring Overview of Iflow"
}
```

#### `GET /download-reports-zip`

Downloads all available payload files as a zip archive.

### JMS Queues APIs

These are used by the `JMS Queues` UI.

#### `POST /jms-queues`

Fetches queue list.

Request body:

```json
{
  "token": "tenant-access-token",
  "baseUrl": "https://<tenant>.it-cpi001.cfapps.<region>.hana.ondemand.com"
}
```

Response:

```json
{
  "queues": [
    {
      "id": "queue-id",
      "key": "queue-id",
      "name": "JMS_Queue_100",
      "accessType": "Non-Exclusive",
      "usage": "OK",
      "state": "Started",
      "entries": 5
    }
  ]
}
```

#### `POST /jms-messages`

Fetches messages for a selected queue.

Request body:

```json
{
  "token": "tenant-access-token",
  "baseUrl": "https://<tenant>.it-cpi001.cfapps.<region>.hana.ondemand.com",
  "queueName": "JMS_Queue_100",
  "queueKey": "JMS_Queue_100"
}
```

Response:

```json
{
  "messages": [
    {
      "id": "internal-id",
      "jmsMessageId": "ID:10.147.158.688a3119dc16a96700:180",
      "messageId": "correlation-or-mpl-id",
      "failed": true,
      "status": "Failed",
      "dueAt": "2026-04-29 12:00:00",
      "createdAt": "2026-04-29 11:00:00",
      "retainUntil": "2026-05-01 11:00:00",
      "retryCount": "3",
      "nextRetryOn": "2026-04-29 12:30:00",
      "correlationId": "correlation-id",
      "iflowName": "SampleIflow",
      "packageName": "SamplePackage"
    }
  ]
}
```

#### `POST /jms-resource-details`

Fetches broker resource details for `Broker1`.

Request body:

```json
{
  "token": "tenant-access-token",
  "baseUrl": "https://<tenant>.it-cpi001.cfapps.<region>.hana.ondemand.com",
  "brokerKey": "Broker1"
}
```

#### `POST /jms-messages/move`

Moves selected JMS messages from one queue to another.

Request body:

```json
{
  "token": "tenant-access-token",
  "baseUrl": "https://<tenant>.it-cpi001.cfapps.<region>.hana.ondemand.com",
  "sourceQueueName": "JMS_Queue_100_DLQ",
  "targetQueueName": "JMS_Queue_100",
  "messages": [
    {
      "jmsMessageId": "ID:10.147.158.688a3119dc16a96700:180",
      "failed": true
    }
  ]
}
```

Current behavior:

- first tries a direct API route against `.../api/v1`
- fetches CSRF token from `.../api/v1/`
- loads queue entity
- sends direct queue move request using:

```text
PATCH /api/v1/Queues('<sourceQueue>')?operation=move&target_queue=<targetQueue>&selector=JMSMessageID='<messageId>'
```

- if direct route fails, backend still has fallback move attempts

This direct route is the one currently proven to work from your backend.

#### `POST /jms-messages/retry`

Retries selected JMS messages.

Request body:

```json
{
  "token": "tenant-access-token",
  "baseUrl": "https://<tenant>.it-cpi001.cfapps.<region>.hana.ondemand.com",
  "sourceQueueName": "JMS_Queue_100_DLQ",
  "messages": [
    {
      "jmsMessageId": "ID:10.147.158.688a3119dc16a96700:180",
      "failed": true
    }
  ]
}
```

Current retry flow in backend:

- tries direct queue retry first:

```text
PATCH /api/v1/Queues('<sourceQueue>')?operation=retry&selector=JMSMessageID='<messageId>'
```

- if that fails, tries batch-based retry
- if that also fails, tries a direct `JmsMessages(...)` merge-style fallback
- route currently exists and is testable from UI

#### `POST /jms-messages/delete`

Deletes selected JMS messages.

Request body:

```json
{
  "token": "tenant-access-token",
  "baseUrl": "https://<tenant>.it-cpi001.cfapps.<region>.hana.ondemand.com",
  "sourceQueueName": "JMS_Queue_100_DLQ",
  "messages": [
    {
      "jmsMessageId": "ID:10.147.158.688a3119dc16a96700:180",
      "failed": true
    }
  ]
}
```

Delete uses:

```text
DELETE /api/v1/JmsMessages(Msgid='<msgId>',Name='<queueName>',Failed=true|false)
```

This path is currently working.

### Debug APIs

#### `POST /cpi-data`
#### `GET /cpi-data`

Temporary in-memory debug endpoints for received CPI data.

## How The Two UIs Work

### Message Monitoring Overview Flow

1. Connect tenant on `/tenant`
2. Frontend stores:
   - `token`
   - `baseUrl`
   - `packages`
   - `tenantAccessComplete`
3. Open `/status`
4. Load monitoring data from backend
5. Trigger CPI, refresh reports, download payloads, export Excel, or send email

### JMS Queues Flow

1. Connect tenant on `/tenant`
2. Open `/jms-queues`
3. Frontend loads queue list through `/jms-queues`
4. Select queue to load queue messages through `/jms-messages`
5. Use:
   - `Move`
   - `Retry`
   - `Delete`
   - `Usage`

Frontend notes from current code:

- `Retry` button is disabled if any selected message has status `Waiting`
- `Delete` uses typed confirmation: user must type `DELETE`
- `Move` opens target queue dialog

### Tenant Assistant Chatbot Flow

1. User clicks the floating assistant button.
2. User enters a prompt.
3. Frontend sends `POST /chatbot/query` with:
   - prompt
   - tenant token
   - tenant base URL
   - stored packages
4. Backend checks whether the prompt belongs to the supported app domain.
5. Backend dispatches to monitoring, packages/artifacts, or JMS logic.
6. Frontend renders:
   - text answer
   - matching rows
   - follow-up list results
   - download/action buttons

## Environment Variables

Create `backend/.env`.

### Required for tenant OAuth

- `TOKEN_URL`
- `CLIENT_ID`
- `CLIENT_SECRET`

### Required for CPI triggering

- `CPI_TRIGGER_ENDPOINT`

Optional trigger credentials:

- `TRIGGER_CLIENT_ID`
- `TRIGGER_CLIENT_SECRET`
- fallback to `IFLOW_CLIENT_ID`
- fallback to `IFLOW_CLIENT_SECRET`
- fallback to `CLIENT_ID`
- fallback to `CLIENT_SECRET`

### Required for HANA

- `HANA_SERVER`
- `HANA_USER`
- `HANA_PASSWORD`

### Required for Email

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`

Optional:

- `SMTP_FROM`

## Local Development

### Backend

```powershell
cd backend
npm install
npm start
```

or

```powershell
cd backend
npm run dev
```

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

### Frontend Build

```powershell
cd frontend
npm run build
```

## Important Notes

- App login is still local UI login, not SAP IAS
- current frontend API base is local backend
- JMS `Move` direct API route is working from backend
- JMS `Delete` is working
- JMS `Retry` route exists and should be tested against your tenant with failed messages
- HANA monitoring data is still a core part of the `Message Monitoring Overview` UI
- Chatbot support is rule-based and limited to project features already available manually

## Quick Test Flow

1. Start backend
2. Start frontend
3. Log in with local app credentials
4. Connect tenant on `/tenant`
5. Test `Message Monitoring Overview`
6. Test `JMS Queues`
7. For JMS:
   - load queues
   - open a queue
   - select failed messages
   - test `Move`
   - test `Retry`
   - test `Delete`
8. For chatbot:
   - click the assistant button
   - ask `past hour error messages`
   - reply `yes`
   - ask `show JMS queues`
   - ask `download excel report`

## Files To Know

- [backend/server.js](C:/Users/yashwanth.gr/Desktop/Tenant-Access/backend/server.js)
- [backend/package.json](C:/Users/yashwanth.gr/Desktop/Tenant-Access/backend/package.json)
- [frontend/src/App.jsx](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/App.jsx)
- [frontend/src/config.js](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/config.js)
- [frontend/src/pages/TenantAccess.jsx](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/pages/TenantAccess.jsx)
- [frontend/src/pages/StatusOverview.jsx](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/pages/StatusOverview.jsx)
- [frontend/src/pages/JmsQueues.jsx](C:/Users/yashwanth.gr/Desktop/Tenant-Access/frontend/src/pages/JmsQueues.jsx)
