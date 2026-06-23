const MESSAGE_STATUSES = [
  "All",
  "FAILED",
  "RETRY",
  "COMPLETED",
  "PROCESSING",
  "ESCALATED",
  "CANCELLED",
  "DISCARDED",
  "ABANDONED",
  ""
];

const TIME_RANGES = [
  "past minute",
  "past hour",
  "past 24 hours",
  "past day",
  "past week",
  "past month",
  "today",
  "Last Hour",
  "Last Day",
  "Last Week",
  "Last Month",
  "Custom",
  ""
];

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
    enum: MESSAGE_STATUSES,
    description: "Monitoring status filter."
  },
  range: {
    type: "string",
    enum: TIME_RANGES,
    description: "Named time range."
  },
  fromDate: {
    type: "string",
    description: "Custom range start date. Date-only values such as 2026-02-01 are preferred."
  },
  toDate: {
    type: "string",
    description: "Custom range end date. Date-only values such as 2026-03-01 are preferred."
  }
};

const MCP_TOOLS = [
  {
    name: "get_tenant_overview",
    description:
      "Show the SAP Integration Suite monitor dashboard summary: total messages, failed, retry, completed, integration content counts, security counts, locks, stores, and usage where available.",
    inputSchema: {
      type: "object",
      properties: {
        timeRange: {
          type: "string",
          enum: TIME_RANGES,
          description: "Time window for message counts. Default: past hour."
        }
      },
      required: []
    }
  },
  {
    name: "get_message_status_overview",
    description:
      "Show Message Status Overview grouped by artifact/iFlow with counts for FAILED, RETRY, COMPLETED, PROCESSING, ESCALATED, CANCELLED, DISCARDED, ABANDONED, and total.",
    inputSchema: {
      type: "object",
      properties: {
        timeRange: {
          type: "string",
          enum: TIME_RANGES,
          description: "Time window for message counts."
        },
        status: {
          type: "string",
          enum: MESSAGE_STATUSES,
          description: "Optional status filter."
        },
        artifactName: {
          type: "string",
          description: "Optional artifact/iFlow name filter."
        },
        packageName: {
          type: "string",
          description: "Optional package name filter."
        }
      },
      required: []
    }
  },
  {
    name: "get_monitoring_logs",
    description:
      "Fetch individual CPI message processing log entries with filters for all statuses, time ranges, package, artifact, message ID, correlation ID, or application message ID.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: MESSAGE_STATUSES,
          description: "Message status filter. Leave empty or All for all statuses."
        },
        range: {
          type: "string",
          enum: TIME_RANGES,
          description: "Natural time range to apply."
        },
        artifactName: {
          type: "string",
          description: "Optional iFlow/artifact filter."
        },
        packageName: {
          type: "string",
          description: "Optional package filter."
        },
        messageId: {
          type: "string",
          description: "Optional MPL/message/correlation/application message ID."
        },
        outputMode: {
          type: "string",
          enum: ["list", "count", "summary"],
          description: "Preferred presentation mode."
        }
      },
      required: []
    }
  },
  {
    name: "get_monitoring_overview",
    description:
      "Show monitoring dashboard summary from tenant logs or saved HANA report data, including status breakdown and recent rows.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: MESSAGE_STATUSES,
          description: "Optional status filter."
        },
        timeRange: {
          type: "string",
          enum: TIME_RANGES,
          description: "Optional time range filter."
        }
      },
      required: []
    }
  },
  {
    name: "get_integration_content",
    description:
      "List integration artifacts with runtime/design status such as Started, Error, Stopped, All. Use for integration content, started artifacts, error artifacts, stopped iFlows.",
    inputSchema: {
      type: "object",
      properties: {
        runtimeStatus: {
          type: "string",
          enum: ["All", "Started", "Error", "Stopped", ""],
          description: "Runtime/design status filter."
        },
        packageName: {
          type: "string",
          description: "Optional package filter."
        },
        artifactName: {
          type: "string",
          description: "Optional artifact/iFlow filter."
        }
      },
      required: []
    }
  },
  {
    name: "list_packages",
    description:
      "List all SAP CPI integration packages in the connected tenant. Use for packages, package names, or browsing content.",
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
    name: "get_security_materials",
    description:
      "Get security material count/list from the tenant. Use for security materials, credentials, OAuth material, user credential material, or security artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Optional security material name filter."
        }
      },
      required: []
    }
  },
  {
    name: "get_keystores",
    description:
      "Get keystore entries, certificates, key pairs, or keystore counts from the tenant.",
    inputSchema: {
      type: "object",
      properties: {
        alias: {
          type: "string",
          description: "Optional certificate/key alias filter."
        }
      },
      required: []
    }
  },
  {
    name: "get_pgp_keys",
    description:
      "Get PGP public/private keys from the tenant. Use for PGP keys, encryption keys, signing keys, or PGP key count.",
    inputSchema: {
      type: "object",
      properties: {
        keyName: {
          type: "string",
          description: "Optional PGP key name filter."
        }
      },
      required: []
    }
  },
  {
    name: "get_access_policies",
    description:
      "Get access policies from the tenant. Use for access policies, authorization policies, or policy artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Optional access policy name filter."
        }
      },
      required: []
    }
  },
  {
    name: "get_user_roles",
    description:
      "Get user roles configured in the tenant. Use for user roles, role artifacts, or role counts.",
    inputSchema: {
      type: "object",
      properties: {
        roleName: {
          type: "string",
          description: "Optional user role name filter."
        }
      },
      required: []
    }
  },
  {
    name: "get_data_stores",
    description:
      "List data stores or data store entries. Use for data stores, stored messages, data store count, or a specific data store name.",
    inputSchema: {
      type: "object",
      properties: {
        dataStoreName: {
          type: "string",
          description: "Optional data store name filter."
        },
        entryId: {
          type: "string",
          description: "Optional data store entry ID."
        }
      },
      required: []
    }
  },
  {
    name: "get_variables",
    description:
      "List tenant variables or global variables. Use for variables, variable count, or variable value lookup.",
    inputSchema: {
      type: "object",
      properties: {
        variableName: {
          type: "string",
          description: "Optional variable name filter."
        }
      },
      required: []
    }
  },
  {
    name: "get_number_ranges",
    description:
      "List number ranges configured in the tenant. Use for number ranges, current numbers, or number range count.",
    inputSchema: {
      type: "object",
      properties: {
        numberRangeName: {
          type: "string",
          description: "Optional number range name filter."
        }
      },
      required: []
    }
  },
  {
    name: "get_partner_directory",
    description:
      "Get partner directory entries. Use for partner directory, partners, B2B partners, partner ID lookup, or partner count.",
    inputSchema: {
      type: "object",
      properties: {
        partnerId: {
          type: "string",
          description: "Optional partner ID filter."
        }
      },
      required: []
    }
  },
  {
    name: "get_message_locks",
    description:
      "Get message locks and designtime artifact locks. Use for message locks, artifact locks, lock counts, or manage locks dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        lockType: {
          type: "string",
          enum: ["message", "designtime", "all", ""],
          description: "Lock category to fetch."
        }
      },
      required: []
    }
  },
  {
    name: "get_system_logs",
    description:
      "Get system log files or system log metadata. Use for system logs, log files, runtime logs, or system log download/list requests.",
    inputSchema: {
      type: "object",
      properties: {
        logName: {
          type: "string",
          description: "Optional system log name filter."
        }
      },
      required: []
    }
  },
  {
    name: "get_usage_details",
    description:
      "Get usage details such as current month message usage. Use for message usage, monthly usage, usage count, or tenant usage dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["current month", "last month", "today", ""],
          description: "Usage period."
        }
      },
      required: []
    }
  },
  {
    name: "get_connectivity_tests",
    description:
      "Get connectivity test information/results. Use for connectivity tests, connection tests, endpoint test status, or test count.",
    inputSchema: {
      type: "object",
      properties: {
        testName: {
          type: "string",
          description: "Optional connectivity test name filter."
        }
      },
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
      "List JMS queues in the tenant. Use for queue inventory, queue count, failed queues, DLQ queues, stopped queues, or JMS health questions.",
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
        },
        statusFilter: {
          type: "string",
          enum: ["Failed", "Waiting", "All", ""],
          description: "Optional JMS message status filter."
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

module.exports = { MCP_TOOLS, getMcpToolsForOpenRouter, MESSAGE_STATUSES, TIME_RANGES };
