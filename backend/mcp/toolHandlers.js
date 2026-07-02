const axios = require("axios");
const { getResourceConfig } = require("../sap/resourceRegistry");
const { 
  fetchODataResource, 
  filterRowsByText,
  deleteODataResource,
  updateODataResource,
  downloadODataResourceStream
} = require("../sap/tenantApiClient");


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

const buildMonitoringPrompt = ({ status = "", range = "", timeRange = "", outputMode = "summary" }) =>
  [
    outputMode === "list" ? "show" : outputMode === "count" ? "count" : "summarize",
    status ? status.toLowerCase() : "",
    range || timeRange,
    "messages"
  ]
    .filter(Boolean)
    .join(" ");

const cleanUrl = (url) => String(url || "").trim().replace(/\/+$/, "");

const fetchRegisteredResource = async (toolName, params, tenantContext, overrides = {}) => {
  const tenantError = requireTenantConnection(tenantContext);
  if (tenantError) return tenantError;

  const config = getResourceConfig(toolName);
  if (!config) {
    return fetchODataResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: overrides.resources || [],
      queryParams: overrides.queryParams || {},
      textFilters: overrides.textFilters || [],
      preferNonEmpty: overrides.preferNonEmpty,
      emptyMessage: overrides.emptyMessage,
      itemType: overrides.itemType || "integration-resource"
    });
  }

  return fetchODataResource({
    token: tenantContext.token,
    baseUrl: tenantContext.baseUrl,
    resourceNames: overrides.resources || config.resources,
    queryParams: { ...config.queryParams, ...(overrides.queryParams || {}) },
    textFilters: overrides.textFilters || [],
    preferNonEmpty: overrides.preferNonEmpty ?? config.preferNonEmpty,
    emptyMessage: overrides.emptyMessage || config.emptyMessage,
    itemType: overrides.itemType || config.itemType
  });
};

const groupReportsByArtifact = (reports) => {
  const grouped = new Map();

  reports.forEach((report) => {
    const artifactName = report.iflowName || report.IntegrationFlowName || "Unknown";
    const existing =
      grouped.get(artifactName) ||
      {
        type: "message-status-overview",
        artifactName,
        FAILED: 0,
        RETRY: 0,
        COMPLETED: 0,
        PROCESSING: 0,
        ESCALATED: 0,
        CANCELLED: 0,
        DISCARDED: 0,
        ABANDONED: 0,
        total: 0
      };
    const status = String(report.status || report.Status || "UNKNOWN").toUpperCase();
    if (Object.prototype.hasOwnProperty.call(existing, status)) {
      existing[status] += 1;
    }
    existing.total += 1;
    grouped.set(artifactName, existing);
  });

  return Array.from(grouped.values()).sort((left, right) => right.total - left.total);
};

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

const normalizeStatusValue = (value) => {
  const text = normalizeAllValue(value);
  return text ? text.toUpperCase() : "";
};

const validateMonitoringSelection = (params = {}, tenantContext = {}, extraRequired = []) => {
  const packageName = String(params.packageName || params.packageId || "").trim();
  const iflowName = String(params.iflowName || params.artifactName || "").trim();
  const statusRaw = String(params.status || "").trim();
  const range = getRangeForTime(params.range || params.timeRange, params.fromDate, params.toDate);
  const missing = [];

  if (!tenantContext.baseUrl) missing.push("tenant base URL");
  if (!packageName) missing.push("package");
  if (!iflowName) missing.push("iFlow/artifact or All");
  if (!statusRaw) missing.push("status or All");
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

  const ensureCpiFromDateTime = (dateStr) => {
    if (!dateStr) return "";
    if (dateStr.includes("T")) return dateStr;
    return `${dateStr}T00:00:00`;
  };

  const ensureCpiToDateTime = (dateStr) => {
    if (!dateStr) return "";
    if (dateStr.includes("T")) return dateStr;
    return `${dateStr}T23:59:59`;
  };

  return {
    packageName,
    iflowName,
    status: statusRaw,
    range,
    triggerPayload: {
      BASE_URL: tenantContext.baseUrl,
      IFLOW_NAME: normalizeAllValue(iflowName),
      STATUS: normalizeStatusValue(statusRaw),
      FROM_DATE: ensureCpiFromDateTime(range.fromDate),
      TO_DATE: ensureCpiToDateTime(range.toDate)
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
  get_tenant_overview: async (params, { token, baseUrl, packages = [] }) => {
    const { fetchPackages, fetchArtifactsForPackagesInBatches, getMonitoringOverviewData } = getDeps();
    const monitoring = await getMonitoringOverviewData({
      prompt: `${params?.timeRange || "past hour"} monitoring overview`,
      token,
      baseUrl
    });
    const reports = monitoring.reports || [];
    const statusBreakdown = reports.reduce((acc, report) => {
      const status = String(report.status || "UNKNOWN").toUpperCase();
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});

    let livePackages = packages;
    let artifactCount = 0;
    let artifactErrorCount = 0;
    let artifactStartedCount = 0;

    if (token && baseUrl) {
      try {
        const packageResult = await fetchPackages(baseUrl, token);
        livePackages = packageResult.packages || [];
        
        // Fast path: fetch all deployed runtime artifacts directly to avoid batch loop timeouts
        const runtimeRes = await fetchODataResource({
          token,
          baseUrl,
          resourceNames: ["IntegrationRuntimeArtifacts"],
          queryParams: {
            $format: "json",
            $top: "5000",
            $select: "Id,Status"
          },
          itemType: "integration-artifact"
        });
        
        const runtimeArtifacts = runtimeRes.items || [];
        artifactCount = runtimeArtifacts.length;
        artifactErrorCount = runtimeArtifacts.filter((art) => /error/i.test(art.Status || "")).length;
        artifactStartedCount = runtimeArtifacts.filter((art) => /started/i.test(art.Status || "") || /running/i.test(art.Status || "")).length;
      } catch (error) {
        console.warn("get_tenant_overview artifact summary failed:", error.response?.data || error.message);
      }
    }

    return {
      items: [
        {
          type: "tenant-overview",
          messages: reports.length,
          packages: livePackages.length,
          artifacts: artifactCount,
          failedMessages: statusBreakdown.FAILED || 0,
          retryMessages: statusBreakdown.RETRY || 0,
          completedMessages: statusBreakdown.COMPLETED || 0,
          processingMessages: statusBreakdown.PROCESSING || 0,
          errorArtifacts: artifactErrorCount,
          startedArtifacts: artifactStartedCount
        }
      ],
      rawData: {
        source: monitoring.source,
        totalMessages: monitoring.totalCount || reports.length,
        packageCount: livePackages.length,
        artifactCount,
        artifactErrorCount,
        artifactStartedCount,
        statusBreakdown
      }
    };
  },

  get_message_status_overview: async (params, { token, baseUrl }) => {
    const { fetchTenantMonitoringLogs } = getDeps();
    const result = await fetchTenantMonitoringLogs({
      baseUrl,
      token,
      prompt: buildMonitoringPrompt({
        status: params?.status,
        range: params?.timeRange || params?.range,
        outputMode: "list"
      })
    });
    const filteredReports = filterRowsByText(result.reports || [], [
      params?.artifactName,
      params?.packageName
    ]);
    const overview = groupReportsByArtifact(filteredReports);

    return {
      items: overview.slice(0, 15),
      pendingItems: overview.slice(15),
      rawData: {
        totalArtifacts: overview.length,
        totalMessages: filteredReports.length,
        range: result.range?.label || params?.timeRange || "all time",
        sample: overview.slice(0, 5)
      }
    };
  },

  list_packages: async (params, { token, baseUrl, packages = [] }) => {
    const { fetchPackages } = getDeps();
    const searchName = String(params?.packageName || params?.name || "").trim().toLowerCase();

    let livePackages = [];
    if (token && baseUrl) {
      const { packages: fetched } = await fetchPackages(baseUrl, token);
      livePackages = fetched || [];
    } else {
      livePackages = packages || [];
    }

    let filteredPackages = livePackages;
    if (searchName) {
      filteredPackages = livePackages.filter(pkg => 
        String(pkg.Id || "").toLowerCase().includes(searchName) || 
        String(pkg.Name || "").toLowerCase().includes(searchName)
      );
    }

    return {
      items: filteredPackages.map((pkg) => ({ type: "package", ...pkg })),
      rawData: { 
        total: filteredPackages.length, 
        packages: filteredPackages.slice(0, 20),
        searchFiltered: Boolean(searchName)
      }
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
    const reports = filterRowsByText(result.reports || [], [
      params?.artifactName,
      params?.packageName,
      params?.messageId
    ]);

    return {
      items: reports.slice(0, 10).map((report) => ({ type: "report", ...report })),
      pendingItems: reports.slice(10).map((report) => ({ type: "report", ...report })),
      rawData: {
        totalCount: result.totalCount,
        returnedCount: reports.length,
        range: result.range?.label || "all time",
        source: result.source || "tenant",
        sample: reports.slice(0, 3)
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

  get_integration_content: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const { fetchPackages, fetchArtifactsForPackage, fetchArtifactsForPackagesInBatches, resolvePackageForPrompt } = getDeps();
    const { apiBaseUrl, packages } = await fetchPackages(tenantContext.baseUrl, tenantContext.token);
    const packageName = String(params?.packageName || "").trim();
    let artifacts = [];

    if (packageName) {
      const resolution = resolvePackageForPrompt(`artifacts inside ${packageName} package`, packages);
      if (!resolution.packageId) {
        return {
          message: `I could not find a package matching "${packageName}".`,
          items: (resolution.matches || []).map((pkg) => ({ type: "package", ...pkg })),
          rawData: { requestedPackage: packageName, matches: resolution.matches?.length || 0 }
        };
      }
      artifacts = (await fetchArtifactsForPackage(apiBaseUrl, tenantContext.token, resolution.packageId)).map((artifact) => ({
        packageId: resolution.packageId,
        ...artifact
      }));
    } else {
      const artifactResults = await fetchArtifactsForPackagesInBatches(apiBaseUrl, tenantContext.token, packages);
      artifacts = artifactResults.results.flatMap((entry) =>
        (entry.artifacts || []).map((artifact) => ({ packageId: entry.packageId, ...artifact }))
      );
    }

    const runtimeStatus = String(params?.runtimeStatus || "").trim().toLowerCase();
    const filtered = filterRowsByText(
      artifacts.filter((artifact) => {
        if (!runtimeStatus || runtimeStatus === "all") return true;
        return JSON.stringify(artifact).toLowerCase().includes(runtimeStatus);
      }),
      [params?.artifactName]
    );

    return {
      items: filtered.slice(0, 20).map((artifact) => ({ type: "artifact", ...artifact })),
      pendingItems: filtered.slice(20).map((artifact) => ({ type: "artifact", ...artifact })),
      rawData: {
        total: filtered.length,
        runtimeStatus: runtimeStatus || "all",
        packageName: packageName || "all",
        sample: filtered.slice(0, 5)
      }
    };
  },

  get_security_materials: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const resources = ["UserCredentials", "OAuth2ClientCredentials", "SecureParameters"];
    const allItems = [];
    const attempted = [];

    for (const resourceName of resources) {
      try {
        const res = await fetchODataResource({
          token: tenantContext.token,
          baseUrl: tenantContext.baseUrl,
          resourceNames: [resourceName],
          queryParams: {
            $format: "json"
          },
          textFilters: [params?.name],
          itemType: "security-material"
        });

        if (res.items && res.items.length > 0) {
          allItems.push(...res.items);
        }
        if (res.rawData?.attemptedResources) {
          attempted.push(...res.rawData.attemptedResources);
        }
      } catch (err) {
        attempted.push({ resourceName, status: 500, detail: err.message });
      }
    }

    return {
      items: allItems.slice(0, 500),
      pendingItems: allItems.slice(500),
      rawData: {
        total: allItems.length,
        attemptedResources: attempted
      }
    };
  },

  get_keystores: async (params, tenantContext) =>
    fetchRegisteredResource("get_keystores", params, tenantContext, {
      textFilters: [params?.alias]
    }),

  get_pgp_keys: async (params, tenantContext) =>
    fetchRegisteredResource("get_pgp_keys", params, tenantContext, {
      textFilters: [params?.keyName]
    }),

  get_access_policies: async (params, tenantContext) =>
    fetchRegisteredResource("get_access_policies", params, tenantContext, {
      textFilters: [params?.name]
    }),

  get_user_roles: async (params, tenantContext) =>
    fetchRegisteredResource("get_user_roles", params, tenantContext, {
      textFilters: [params?.roleName]
    }),

  get_data_stores: async (params, tenantContext) =>
    fetchRegisteredResource("get_data_stores", params, tenantContext, {
      resources: params?.entryId ? ["DataStoreEntries"] : undefined,
      textFilters: [params?.dataStoreName, params?.entryId]
    }),

  get_variables: async (params, tenantContext) =>
    fetchRegisteredResource("get_variables", params, tenantContext, {
      textFilters: [params?.variableName]
    }),

  get_number_ranges: async (params, tenantContext) =>
    fetchRegisteredResource("get_number_ranges", params, tenantContext, {
      textFilters: [params?.numberRangeName]
    }),

  get_partner_directory: async (params, tenantContext) =>
    fetchRegisteredResource("get_partner_directory", params, tenantContext, {
      textFilters: [params?.partnerId]
    }),

  get_message_locks: async (params, tenantContext) => {
    const lockType = String(params?.lockType || "").trim().toLowerCase();
    const resources =
      lockType === "designtime"
        ? ["DesigntimeArtifactLocks"]
        : lockType === "message"
          ? ["MessageLocks"]
          : undefined;

    return fetchRegisteredResource("get_message_locks", params, tenantContext, { resources });
  },

  get_system_logs: async (params, tenantContext) =>
    fetchRegisteredResource("get_system_logs", params, tenantContext, {
      textFilters: [params?.logName]
    }),

  get_usage_details: async (params, tenantContext) =>
    fetchRegisteredResource("get_usage_details", params, tenantContext, {
      textFilters: [params?.period]
    }),

  get_connectivity_tests: async (params, tenantContext) =>
    fetchRegisteredResource("get_connectivity_tests", params, tenantContext, {
      textFilters: [params?.testName]
    }),

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

  delete_variable: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const variableName = String(params?.variableName || "").trim();
    const integrationFlow = String(params?.integrationFlow || "globally_defined").trim();
    if (!variableName) {
      return { error: "I need variableName to delete a variable.", needsClarification: true };
    }

    const resourcePath = `Variables(VariableName='${encodeURIComponent(variableName)}',IntegrationFlow='${encodeURIComponent(integrationFlow)}')`;
    await deleteODataResource({ token: tenantContext.token, baseUrl: tenantContext.baseUrl, resourcePath });
    return { items: [], rawData: { deleted: true, variableName, integrationFlow } };
  },

  update_variable: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const variableName = String(params?.variableName || "").trim();
    const integrationFlow = String(params?.integrationFlow || "globally_defined").trim();
    const value = String(params?.value || "");
    if (!variableName) {
      return { error: "I need variableName to update a variable.", needsClarification: true };
    }

    const resourcePath = `Variables(VariableName='${encodeURIComponent(variableName)}',IntegrationFlow='${encodeURIComponent(integrationFlow)}')/$value`;
    await updateODataResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourcePath,
      payload: value,
      isStream: true
    });
    return { items: [], rawData: { updated: true, variableName, integrationFlow } };
  },

  delete_number_range: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const numberRangeName = String(params?.numberRangeName || "").trim();
    if (!numberRangeName) {
      return { error: "I need numberRangeName to delete a number range.", needsClarification: true };
    }

    const resourcePath = `NumberRanges('${encodeURIComponent(numberRangeName)}')`;
    await deleteODataResource({ token: tenantContext.token, baseUrl: tenantContext.baseUrl, resourcePath });
    return { items: [], rawData: { deleted: true, numberRangeName } };
  },

  update_number_range: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const numberRangeName = String(params?.numberRangeName || "").trim();
    const currentValue = String(params?.currentValue || "").trim();
    if (!numberRangeName || !currentValue) {
      return { error: "I need numberRangeName and currentValue to update a number range.", needsClarification: true };
    }

    const numericValue = parseInt(currentValue, 10);
    if (isNaN(numericValue)) {
      return { error: "currentValue must be a valid integer.", needsClarification: true };
    }

    const resourcePath = `NumberRanges('${encodeURIComponent(numberRangeName)}')`;
    const payload = {
      Name: numberRangeName,
      CurrentValue: numericValue
    };
    await updateODataResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourcePath,
      payload,
      isStream: false
    });
    return { items: [], rawData: { updated: true, numberRangeName, currentValue: numericValue } };
  },

  delete_data_store: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const dataStoreName = String(params?.dataStoreName || "").trim();
    const integrationFlow = String(params?.integrationFlow || "").trim();
    const type = String(params?.type || "Default").trim();
    if (!dataStoreName || !integrationFlow) {
      return { error: "I need dataStoreName and integrationFlow to delete a data store.", needsClarification: true };
    }

    const resourcePath = `DataStores(DataStoreName='${encodeURIComponent(dataStoreName)}',IntegrationFlow='${encodeURIComponent(integrationFlow)}',Type='${encodeURIComponent(type)}')`;
    await deleteODataResource({ token: tenantContext.token, baseUrl: tenantContext.baseUrl, resourcePath });
    return { items: [], rawData: { deleted: true, dataStoreName, integrationFlow, type } };
  },

  delete_data_store_entry: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const entryId = String(params?.entryId || "").trim();
    const dataStoreName = String(params?.dataStoreName || "").trim();
    const integrationFlow = String(params?.integrationFlow || "").trim();
    const type = String(params?.type || "Default").trim();
    if (!entryId || !dataStoreName || !integrationFlow) {
      return { error: "I need entryId, dataStoreName, and integrationFlow to delete an entry.", needsClarification: true };
    }

    const resourcePath = `DataStoreEntries(Id='${encodeURIComponent(entryId)}',DataStoreName='${encodeURIComponent(dataStoreName)}',IntegrationFlow='${encodeURIComponent(integrationFlow)}',Type='${encodeURIComponent(type)}')`;
    await deleteODataResource({ token: tenantContext.token, baseUrl: tenantContext.baseUrl, resourcePath });
    return { items: [], rawData: { deleted: true, entryId, dataStoreName, integrationFlow, type } };
  },

  download_data_store_entry_payload: async (params, tenantContext) => {
    const tenantError = requireTenantConnection(tenantContext);
    if (tenantError) return tenantError;

    const entryId = String(params?.entryId || "").trim();
    const dataStoreName = String(params?.dataStoreName || "").trim();
    const integrationFlow = String(params?.integrationFlow || "").trim();
    const type = String(params?.type || "Default").trim();
    if (!entryId || !dataStoreName || !integrationFlow) {
      return { error: "I need entryId, dataStoreName, and integrationFlow to download an entry's payload.", needsClarification: true };
    }

    return {
      message: `Click below to download the message payload for entry "${entryId}".`,
      items: [],
      actions: [
        {
          label: "Download Payload File",
          method: "GET",
          url: `/datastore-entries/download?id=${encodeURIComponent(entryId)}&dataStoreName=${encodeURIComponent(dataStoreName)}&integrationFlow=${encodeURIComponent(integrationFlow)}&type=${encodeURIComponent(type)}&token=${encodeURIComponent(tenantContext.token)}&baseUrl=${encodeURIComponent(tenantContext.baseUrl)}`
        }
      ]
    };
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
