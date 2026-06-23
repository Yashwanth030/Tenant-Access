const MONITORING_SELECTION_PROPERTIES = {
  packageName: {
    type: "string",
    description: "Package name or ID selected by the user. Required before triggering CPI."
  },
  iflowName: {
    type: "string",
    description: "iFlow/artifact name. Use All only if the user explicitly asks for all flows."
  },
  status: {
    type: "string",
    enum: [
      "All",
      "COMPLETED",
      "FAILED",
      "PROCESSING",
      "RETRY",
      "ESCALATED",
      "CANCELLED",
      "DISCARDED",
      "ABANDONED",
      ""
    ],
    description: "Monitoring status filter."
  },
  range: {
    type: "string",
    enum: ["Last Hour", "Last Day", "Last Week", "Last Month", "Custom", ""],
    description: "Named time range."
  },
  fromDate: {
    type: "string",
    description: "Custom range start datetime."
  },
  toDate: {
    type: "string",
    description: "Custom range end datetime."
  }
};

const MCP_TOOLS = [
  {
    name: "list_packages",
    description:
      "List all SAP CPI integration packages in the connected tenant. Use for packages, package names, or browsing tenant content.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "list_artifacts",
    description:
      "List SAP CPI integration artifacts or iFlows inside a package, or across all packages. Extract packageName when the user names a package.",
    inputSchema: {
      type: "object",
      properties: {
        packageName: {
          type: "string",
          description: "Exact or partial package name or ID. Leave empty to list artifacts from all packages."
        }
      },
      required: []
    }
  },
  {
    name: "get_monitoring_logs",
    description:
      "Fetch SAP CPI message processing logs. Use for failed, completed, processing, retry, error, count, or date/range monitoring questions.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["FAILED", "COMPLETED", "PROCESSING", "RETRY", ""],
          description: "Message status filter. Leave empty for all statuses."
        },
        range: {
          type: "string",
          enum: ["past hour", "today", "past day", "past week", ""],
          description: "Natural time range to apply."
        },
        outputMode: {
          type: "string",
          enum: ["list", "count", "summary"],
          description: "Preferred presentation mode. Use summary by default."
        }
      },
      required: []
    }
  },
  {
    name: "get_monitoring_overview",
    description:
      "Show monitoring overview or dashboard summary with status breakdown and recent monitoring data.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "export_monitoring_excel",
    description:
      "Prepare an Excel report for a specific package/iFlow, status, and time range. This must trigger CPI first so HANA is refreshed before download. Do not download whatever is already in HANA.",
    inputSchema: {
      type: "object",
      properties: MONITORING_SELECTION_PROPERTIES,
      required: []
    }
  },
  {
    name: "download_payload_zip",
    description:
      "Prepare a payload ZIP for a specific package/iFlow, status, and time range. This must trigger CPI first so HANA contains the requested payloads before ZIP download. Do not download stale existing HANA data.",
    inputSchema: {
      type: "object",
      properties: MONITORING_SELECTION_PROPERTIES,
      required: []
    }
  },
  {
    name: "download_payload_file",
    description:
      "Create a download action for one decoded payload file from a monitoring row. Requires mplId, logStart, and attachmentTimestamp.",
    inputSchema: {
      type: "object",
      properties: {
        mplId: {
          type: "string",
          description: "Message processing log ID for the payload."
        },
        logStart: {
          type: "string",
          description: "Log start timestamp exactly as shown in the monitoring row."
        },
        attachmentTimestamp: {
          type: "string",
          description: "Attachment timestamp exactly as shown in the monitoring row."
        }
      },
      required: ["mplId", "logStart", "attachmentTimestamp"]
    }
  },
  {
    name: "send_monitoring_email",
    description:
      "Prepare sending a monitoring Excel report by email for a specific package/iFlow, status, and time range. This must trigger CPI first so HANA is refreshed before email/export.",
    inputSchema: {
      type: "object",
      properties: {
        ...MONITORING_SELECTION_PROPERTIES,
        email: {
          type: "string",
          description: "Recipient email address."
        }
      },
      required: []
    }
  },
  {
    name: "list_jms_queues",
    description:
      "List JMS queues in the tenant. Use for queue inventory, queue count, failed queues, DLQ queues, or JMS health questions.",
    inputSchema: {
      type: "object",
      properties: {
        healthFilter: {
          type: "string",
          enum: ["failed", "error", "stopped", "dlq", "all", ""],
          description: "Use failed/error/stopped/dlq for problem queues, otherwise all."
        }
      },
      required: []
    }
  },
  {
    name: "list_jms_messages",
    description:
      "List messages inside a specific JMS queue. queueName is required; ask a clarification question if it is missing.",
    inputSchema: {
      type: "object",
      properties: {
        queueName: {
          type: "string",
          description: "Name or key of the JMS queue."
        }
      },
      required: ["queueName"]
    }
  },
  {
    name: "get_jms_resources",
    description:
      "Get JMS broker resource details such as capacity, limits, queue count, and resource utilization.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "move_jms_message",
    description:
      "Move a JMS message from one queue to another. Requires messageId, sourceQueue, and targetQueue.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "JMS message ID."
        },
        sourceQueue: {
          type: "string",
          description: "Queue currently containing the message."
        },
        targetQueue: {
          type: "string",
          description: "Queue to move the message into."
        }
      },
      required: ["messageId", "sourceQueue", "targetQueue"]
    }
  },
  {
    name: "retry_jms_message",
    description:
      "Retry a failed JMS message from a queue. Requires messageId and sourceQueue.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "JMS message ID."
        },
        sourceQueue: {
          type: "string",
          description: "Queue currently containing the failed message."
        }
      },
      required: ["messageId", "sourceQueue"]
    }
  },
  {
    name: "delete_jms_message",
    description:
      "Delete a JMS message permanently from a queue. Requires messageId and sourceQueue. Use only when the user explicitly asks to delete.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "JMS message ID."
        },
        sourceQueue: {
          type: "string",
          description: "Queue currently containing the message."
        }
      },
      required: ["messageId", "sourceQueue"]
    }
  },
  {
    name: "trigger_cpi_flow",
    description:
      "Trigger CPI for a selected package/iFlow, status, and date range so HANA is populated with the exact requested monitoring data before export, ZIP, payload, or email actions.",
    inputSchema: {
      type: "object",
      properties: MONITORING_SELECTION_PROPERTIES,
      required: []
    }
  }
];

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
