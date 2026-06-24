export const TOOLS = [
  {
    name: "list_jms_queues",
    description:
      "List JMS queues in the connected SAP Cloud Integration tenant. Use for queue inventory, queue count, failed queues, DLQ queues, stopped queues, or JMS health questions.",
    inputSchema: {
      type: "object",
      properties: {
        healthFilter: {
          type: "string",
          enum: ["all", "failed", "error", "stopped", "dlq", ""],
          description: "Use failed/error/stopped/dlq for problem queues, otherwise all."
        }
      },
      required: []
    }
  },
  {
    name: "get_monitoring_logs",
    description:
      "Fetch SAP Cloud Integration message processing logs with filters for status, time range, package, artifact, message ID, correlation ID, or application message ID.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["All", "Failed", "Retry", "Completed", "Processing", "Escalated", "Cancelled", "Discarded", "Abandoned", ""],
          description: "Optional message status filter."
        },
        timeRange: {
          type: "string",
          enum: ["past minute", "past hour", "past 24 hours", "past week", "past month", "today", "custom", ""],
          description: "Optional time window. Defaults to past hour in the backend chatbot path."
        },
        artifactName: {
          type: "string",
          description: "Optional iFlow/artifact filter."
        },
        packageName: {
          type: "string",
          description: "Optional integration package filter."
        },
        messageId: {
          type: "string",
          description: "Optional message processing log ID filter."
        },
        correlationId: {
          type: "string",
          description: "Optional correlation ID filter."
        }
      },
      required: []
    }
  },
  {
    name: "get_pgp_keys",
    description:
      "Get PGP public/private keys from the connected SAP Cloud Integration tenant. Use for PGP keys, encryption keys, signing keys, or PGP key count.",
    inputSchema: {
      type: "object",
      properties: {
        keyName: {
          type: "string",
          description: "Optional PGP key name, key ID, or user ID filter."
        },
        keyring: {
          type: "string",
          enum: ["pubring", "secring", "system", ""],
          description: "Optional desired keyring context. Phase 1 forwards this as prompt context only."
        },
        runtimeLocationId: {
          type: "string",
          description: "Optional runtime context such as cloudintegration. Phase 1 forwards this as prompt context only."
        }
      },
      required: []
    }
  }
];

export default TOOLS;
