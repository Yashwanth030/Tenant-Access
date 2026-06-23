let deps = null;

const configureToolHandlers = (dependencies) => {
  deps = dependencies;
};

const getDeps = () => {
  if (!deps) {
    throw new Error("MCP tool handlers are not configured.");
  }

  return deps;
};

const requireTenantConnection = (tenantContext) => {
  if (!tenantContext?.token || !tenantContext?.baseUrl) {
    return { error: "Connect a tenant first, then I can fetch that live tenant data." };
  }

  return null;
};

const buildMonitoringPrompt = ({ status = "", range = "", outputMode = "summary" }) =>
  [
    outputMode === "list" ? "show" : outputMode === "count" ? "count" : "summarize",
    status ? status.toLowerCase() : "",
    range,
    "messages"
  ]
    .filter(Boolean)
    .join(" ");

const toCpiDateValue = (value) => {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getRangeForTime = (range, fromDate, toDate) => {
  const normalizedRange = String(range || "").trim().toLowerCase();
  const now = new Date();

  if (normalizedRange === "last hour" || normalizedRange === "past hour") {
    return {
      fromDate: toCpiDateValue(new Date(now.getTime() - 60 * 60 * 1000)),
      toDate: toCpiDateValue(now),
      label: "Last Hour"
    };
  }

  if (normalizedRange === "last day" || normalizedRange === "past day" || normalizedRange === "today") {
    return {
      fromDate: toCpiDateValue(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
      toDate: toCpiDateValue(now),
      label: "Last Day"
    };
  }

  if (normalizedRange === "last week" || normalizedRange === "past week") {
    return {
      fromDate: toCpiDateValue(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
      toDate: toCpiDateValue(now),
      label: "Last Week"
    };
  }

  if (normalizedRange === "last month" || normalizedRange === "past month") {
    return {
      fromDate: toCpiDateValue(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)),
      toDate: toCpiDateValue(now),
      label: "Last Month"
    };
  }

  return {
    fromDate: toCpiDateValue(fromDate),
    toDate: toCpiDateValue(toDate),
    label: "Custom"
  };
};

const normalizeAllValue = (value) => {
  const text = String(value || "").trim();
  return text.toLowerCase() === "all" ? "" : text;
};

const validateMonitoringSelection = (params = {}, tenantContext = {}, extraRequired = []) => {
  const packageName = String(params.packageName || params.packageId || "").trim();
  const iflowName = String(params.iflowName || params.artifactName || "").trim();
  const status = String(params.status || "").trim();
  const range = getRangeForTime(params.range, params.fromDate, params.toDate);
  const missing = [];

  if (!tenantContext.baseUrl) missing.push("tenant base URL");
  if (!packageName) missing.push("package");
  if (!iflowName) missing.push("iFlow/artifact or All");
  if (!status) missing.push("status or All");
  if (!range.fromDate || !range.toDate) missing.push("time range");

  extraRequired.forEach((field) => {
    if (!String(params[field] || "").trim()) {
      missing.push(field);
    }
  });

  if (missing.length > 0) {
    return {
      error: `Before I can prepare that report, tell me the ${missing.join(", ")}. I need package, iFlow, status, and time range so I can trigger CPI first instead of using stale HANA data.`,
      needsClarification: true
    };
  }

  return {
    packageName,
    iflowName,
    status,
    range,
    triggerPayload: {
      BASE_URL: tenantContext.baseUrl,
      IFLOW_NAME: normalizeAllValue(iflowName),
      STATUS: normalizeAllValue(status),
      FROM_DATE: range.fromDate,
      TO_DATE: range.toDate
    }
  };
};

const buildPostTriggerActions = ({ requestedAction, params }) => {
  if (requestedAction === "excel") {
    return [{ label: "Download Excel", url: "/export-reports-excel", method: "GET" }];
  }

  if (requestedAction === "payload_zip") {
    return [{ label: "Download Payload ZIP", url: "/download-reports-zip", method: "GET" }];
  }

  if (requestedAction === "email") {
    return [
      {
        label: `Send Excel to ${params.email}`,
        endpoint: "/send-excel-email",
        method: "POST",
        body: { to: params.email }
      }
    ];
  }

  return [
    { label: "Download Excel", url: "/export-reports-excel", method: "GET" },
    { label: "Download Payload ZIP", url: "/download-reports-zip", method: "GET" }
  ];
};

const buildTriggerFirstResponse = ({ params, tenantContext, requestedAction, label, extraRequired = [] }) => {
  const selection = validateMonitoringSelection(params, tenantContext, extraRequired);
  if (selection.error) {
    return selection;
  }

  const postTriggerActions = buildPostTriggerActions({ requestedAction, params });

  return {
    message:
      `I have the filters for ${selection.packageName}. Trigger CPI first for ${selection.iflowName}, ${selection.status}, ${selection.range.label}; after HANA is refreshed, use the generated report download/email action.`,
    items: [],
    actions: [
      {
        label,
        endpoint: "/trigger-cpi",
        method: "POST",
        body: selection.triggerPayload,
        successMessage:
          "Triggered CPI with those filters. Wait a moment for HANA to refresh, then use the next action for the generated HANA data.",
        nextActions: postTriggerActions
      }
    ],
    rawData: {
      action: "trigger_required_before_export",
      requestedAction,
      packageName: selection.packageName,
      iflowName: selection.iflowName,
      status: selection.status,
      range: selection.range,
      nextStep:
        "Trigger CPI first. After the iFlow writes the selected data to HANA, request the Excel, ZIP, or email action."
    }
  };
};

const TOOL_HANDLERS = {
  list_packages: async (params, { token, baseUrl, packages = [] }) => {
    const { fetchPackages } = getDeps();

    if (token && baseUrl) {
      const { packages: livePackages } = await fetchPackages(baseUrl, token);
      return {
        items: livePackages.map((pkg) => ({ type: "package", ...pkg })),
        rawData: { total: livePackages.length, packages: livePackages.slice(0, 20) }
      };
    }

    return {
      items: packages.map((pkg) => ({ type: "package", ...pkg })),
      rawData: { total: packages.length, packages: packages.slice(0, 20) }
    };
  },

  list_artifacts: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const {
      fetchPackages,
      fetchArtifactsForPackage,
      fetchArtifactsForPackagesInBatches,
      resolvePackageForPrompt
    } = getDeps();
    const { token, baseUrl } = tenantContext;
    const packageName = String(params?.packageName || "").trim();
    const { apiBaseUrl, packages } = await fetchPackages(baseUrl, token);

    if (!packageName) {
      const { results, failedPackages = [] } = await fetchArtifactsForPackagesInBatches(apiBaseUrl, token, packages);
      const artifacts = results.flatMap((result) =>
        result.artifacts.map((artifact) => ({
          type: "artifact",
          packageId: result.packageId,
          ...artifact
        }))
      );

      return {
        items: artifacts,
        rawData: { total: artifacts.length, packageCount: packages.length, failedPackages }
      };
    }

    const resolution = resolvePackageForPrompt(`artifacts inside ${packageName} package`, packages);
    if (!resolution.packageId) {
      return {
        message: resolution.matches?.length
          ? `I found ${resolution.matches.length} matching packages. Which package should I use?`
          : `I could not find a package matching "${packageName}".`,
        needsClarification: true,
        items: (resolution.matches || []).map((pkg) => ({ type: "package", ...pkg })),
        rawData: { requestedPackage: packageName, matches: resolution.matches?.length || 0 }
      };
    }

    const artifacts = await fetchArtifactsForPackage(apiBaseUrl, token, resolution.packageId);
    return {
      items: artifacts.map((artifact) => ({ type: "artifact", packageId: resolution.packageId, ...artifact })),
      rawData: { packageId: resolution.packageId, total: artifacts.length, sample: artifacts.slice(0, 10) }
    };
  },

  get_monitoring_logs: async (params, { token, baseUrl }) => {
    const { fetchTenantMonitoringLogs } = getDeps();
    const result = await fetchTenantMonitoringLogs({
      baseUrl,
      token,
      prompt: buildMonitoringPrompt(params || {})
    });

    return {
      items: result.reports.slice(0, 10).map((report) => ({ type: "report", ...report })),
      pendingItems: result.reports.slice(10).map((report) => ({ type: "report", ...report })),
      rawData: {
        totalCount: result.totalCount,
        returnedCount: result.reports.length,
        range: result.range?.label || "all time",
        source: result.source || "tenant",
        sample: result.reports.slice(0, 3)
      }
    };
  },

  get_monitoring_overview: async (params, { token, baseUrl }) => {
    const { getMonitoringOverviewData } = getDeps();
    const result = await getMonitoringOverviewData({
      prompt: "show monitoring overview",
      token,
      baseUrl
    });

    const statusBreakdown = result.reports.reduce((acc, report) => {
      const status = report.status || "UNKNOWN";
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});

    return {
      items: result.reports.slice(0, 10).map((report) => ({ type: "report", ...report })),
      pendingItems: result.reports.slice(10).map((report) => ({ type: "report", ...report })),
      actions: [
        { label: "Download Excel", url: "/export-reports-excel", method: "GET" },
        { label: "Download Payload ZIP", url: "/download-reports-zip", method: "GET" }
      ],
      rawData: {
        totalCount: result.totalCount,
        returnedCount: result.reports.length,
        source: result.source,
        range: result.range?.label || "all time",
        statusBreakdown
      }
    };
  },

  export_monitoring_excel: async (params, tenantContext) =>
    buildTriggerFirstResponse({
      params,
      tenantContext,
      requestedAction: "excel",
      label: "Trigger CPI for Excel"
    }),

  download_payload_zip: async (params, tenantContext) =>
    buildTriggerFirstResponse({
      params,
      tenantContext,
      requestedAction: "payload_zip",
      label: "Trigger CPI for Payload ZIP"
    }),

  download_payload_file: async (params) => {
    const mplId = String(params?.mplId || "").trim();
    const logStart = String(params?.logStart || "").trim();
    const attachmentTimestamp = String(params?.attachmentTimestamp || "").trim();

    if (!mplId || !logStart || !attachmentTimestamp) {
      return {
        message: "Please provide the MPL ID, log start, and attachment timestamp for the payload.",
        needsClarification: true,
        items: [],
        actions: [],
        rawData: { action: "payload_file_needs_identifiers" }
      };
    }

    const query = new URLSearchParams({ mplId, logStart, attachmentTimestamp }).toString();
    return {
      items: [],
      actions: [{ label: "Download Payload", url: `/payload-file?${query}`, method: "GET" }],
      rawData: { action: "payload_file_download_ready", mplId, logStart, attachmentTimestamp }
    };
  },

  send_monitoring_email: async (params, tenantContext) => {
    const email = String(params?.email || "").trim();
    if (!email) {
      return {
        message: "Please provide the recipient email address.",
        needsClarification: true,
        items: [],
        actions: [],
        rawData: { action: "email_needs_address" }
      };
    }

    return buildTriggerFirstResponse({
      params,
      tenantContext,
      requestedAction: "email",
      label: "Trigger CPI for Email Report",
      extraRequired: ["email"]
    });
  },

  list_jms_queues: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const { getJmsQueueRecords, filterProblemJmsQueues } = getDeps();
    const queues = await getJmsQueueRecords(tenantContext.baseUrl, tenantContext.token);
    const healthFilter = String(params?.healthFilter || "").trim().toLowerCase();
    const filtered =
      healthFilter && healthFilter !== "all" ? filterProblemJmsQueues(queues) : queues;

    return {
      items: filtered.map((queue) => ({ type: "jms-queue", ...queue })),
      rawData: { total: queues.length, returned: filtered.length, healthFilter: healthFilter || "all" }
    };
  },

  list_jms_messages: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const queueName = String(params?.queueName || "").trim();
    if (!queueName) {
      return { error: "Which JMS queue should I inspect?", needsClarification: true };
    }

    const { getJmsMessagesForQueue, enrichQueueMessages } = getDeps();
    const messages = await getJmsMessagesForQueue(
      tenantContext.baseUrl,
      tenantContext.token,
      queueName,
      queueName
    );
    const enrichedMessages = await enrichQueueMessages(tenantContext.baseUrl, tenantContext.token, messages);

    return {
      items: enrichedMessages.map((message) => ({ type: "jms-message", ...message })),
      rawData: { queue: queueName, total: enrichedMessages.length, sample: enrichedMessages.slice(0, 5) }
    };
  },

  get_jms_resources: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const { getJmsBrokerResource } = getDeps();
    const resource = await getJmsBrokerResource(tenantContext.baseUrl, tenantContext.token, "Broker1");
    return {
      items: [{ type: "resource", ...resource }],
      rawData: resource
    };
  },

  move_jms_message: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const messageId = String(params?.messageId || "").trim();
    const sourceQueue = String(params?.sourceQueue || "").trim();
    const targetQueue = String(params?.targetQueue || "").trim();
    if (!messageId || !sourceQueue || !targetQueue) {
      return {
        error: "I need messageId, sourceQueue, and targetQueue to move a JMS message.",
        needsClarification: true
      };
    }

    const { moveJmsMessage } = getDeps();
    await moveJmsMessage(tenantContext.baseUrl, tenantContext.token, sourceQueue, targetQueue, messageId, true);
    return { items: [], rawData: { moved: true, messageId, sourceQueue, targetQueue } };
  },

  retry_jms_message: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const messageId = String(params?.messageId || "").trim();
    const sourceQueue = String(params?.sourceQueue || "").trim();
    if (!messageId || !sourceQueue) {
      return { error: "I need messageId and sourceQueue to retry a JMS message.", needsClarification: true };
    }

    const { retryJmsMessage } = getDeps();
    await retryJmsMessage(tenantContext.baseUrl, tenantContext.token, sourceQueue, messageId, true);
    return { items: [], rawData: { retried: true, messageId, sourceQueue } };
  },

  delete_jms_message: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const messageId = String(params?.messageId || "").trim();
    const sourceQueue = String(params?.sourceQueue || "").trim();
    if (!messageId || !sourceQueue) {
      return { error: "I need messageId and sourceQueue to delete a JMS message.", needsClarification: true };
    }

    const { deleteJmsMessage } = getDeps();
    await deleteJmsMessage(tenantContext.baseUrl, tenantContext.token, sourceQueue, messageId, true);
    return { items: [], rawData: { deleted: true, messageId, sourceQueue } };
  },

  trigger_cpi_flow: async (params, tenantContext) =>
    buildTriggerFirstResponse({
      params,
      tenantContext,
      requestedAction: "trigger",
      label: "Trigger CPI"
    })
};

const executeMcpTool = async (toolName, params, tenantContext) => {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    return { error: `Tool "${toolName}" is not implemented.` };
  }

  return handler(params || {}, tenantContext || {});
};

module.exports = { TOOL_HANDLERS, configureToolHandlers, executeMcpTool };
