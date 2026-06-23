const axios = require("axios");

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

const tenantHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/json"
});

const unwrapODataResults = (payload) => {
  if (Array.isArray(payload?.d?.results)) return payload.d.results;
  if (Array.isArray(payload?.d)) return payload.d;
  if (Array.isArray(payload?.value)) return payload.value;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload)) return payload;
  if (payload?.d && typeof payload.d === "object") return [payload.d];
  if (payload && typeof payload === "object") return [payload];
  return [];
};

const buildApiBaseCandidates = (baseUrl) => {
  const cleanedBaseUrl = cleanUrl(baseUrl);
  if (!cleanedBaseUrl) return [];

  const candidates = [];

  try {
    const url = new URL(cleanedBaseUrl);
    candidates.push(`${url.origin}/api/v1`);

    const parts = url.hostname.split(".");
    if (parts.length > 2 && parts[1] !== "integrationsuite") {
      const integrationSuiteParts = [...parts];
      integrationSuiteParts[1] = "integrationsuite";
      candidates.push(`${url.protocol}//${integrationSuiteParts.join(".")}/api/v1`);
    }

    if (url.hostname.includes("-rt.cfapps.")) {
      candidates.push(`${url.protocol}//${url.hostname.replace("-rt.cfapps.", ".cfapps.")}/api/v1`);
    }
  } catch {
    candidates.push(cleanedBaseUrl);
  }

  return [...new Set(candidates.map(cleanUrl).filter(Boolean))];
};

const buildQueryString = (params = {}) => {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      searchParams.append(key, value);
    }
  });
  const query = searchParams.toString();
  return query ? `?${query}` : "";
};

const filterRowsByText = (rows, filters = []) => {
  const activeFilters = filters.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  if (activeFilters.length === 0) return rows;

  return rows.filter((row) => {
    const searchable = JSON.stringify(row).toLowerCase();
    return activeFilters.every((filter) => searchable.includes(filter));
  });
};

const fetchCandidateResource = async ({ token, baseUrl, resourceNames, queryParams, textFilters = [] }) => {
  const tenantError = requireTenantConnection({ token, baseUrl });
  if (tenantError) return tenantError;

  const apiBases = buildApiBaseCandidates(baseUrl);
  const attempts = [];

  for (const apiBase of apiBases) {
    for (const resourceName of resourceNames) {
      const endpoint = `${apiBase}/${resourceName}${buildQueryString(queryParams)}`;
      try {
        const response = await axios.get(endpoint, {
          headers: tenantHeaders(token),
          timeout: 30000
        });
        const rows = filterRowsByText(unwrapODataResults(response.data), textFilters);
        return {
          items: rows.slice(0, 25).map((row) => ({ type: "integration-resource", resource: resourceName, ...row })),
          pendingItems: rows.slice(25).map((row) => ({ type: "integration-resource", resource: resourceName, ...row })),
          rawData: { resource: resourceName, total: rows.length, sample: rows.slice(0, 5) }
        };
      } catch (error) {
        attempts.push({
          resourceName,
          status: error.response?.status,
          detail: error.response?.data?.error?.message?.value || error.response?.data?.message || error.message
        });
      }
    }
  }

  return {
    message:
      "I know this SAP Integration Suite area, but this backend does not have a confirmed API endpoint for it yet on the connected tenant.",
    items: [],
    actions: [],
    rawData: { attemptedResources: attempts.slice(0, 8) }
  };
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
      STATUS: normalizeStatusValue(status),
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
        const artifactResult = await fetchArtifactsForPackagesInBatches(packageResult.apiBaseUrl, token, livePackages);
        const artifacts = artifactResult.results.flatMap((entry) => entry.artifacts || []);
        artifactCount = artifacts.length;
        artifactErrorCount = artifacts.filter((artifact) => /error/i.test(JSON.stringify(artifact))).length;
        artifactStartedCount = artifacts.filter((artifact) => /started/i.test(JSON.stringify(artifact))).length;
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

  get_security_materials: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: ["SecurityMaterials", "SecurityMaterial", "UserCredentials", "OAuth2ClientCredentials"],
      textFilters: [params?.name]
    }),

  get_keystores: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: ["KeystoreEntries", "Keystores", "KeyStoreEntries", "CertificateUserMappings"],
      textFilters: [params?.alias]
    }),

  get_pgp_keys: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: ["PGPKeys", "PgpKeys", "PublicPGPKeys", "PrivatePGPKeys"],
      textFilters: [params?.keyName]
    }),

  get_access_policies: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: ["AccessPolicies", "AccessPolicyArtifacts"],
      textFilters: [params?.name]
    }),

  get_user_roles: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: ["UserRoles", "UserRoleArtifacts", "Roles"],
      textFilters: [params?.roleName]
    }),

  get_data_stores: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: ["DataStores", "DataStoreEntries", "DataStore"],
      textFilters: [params?.dataStoreName, params?.entryId]
    }),

  get_variables: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: ["Variables", "GlobalVariables", "VariableArtifacts"],
      textFilters: [params?.variableName]
    }),

  get_number_ranges: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: ["NumberRanges", "NumberRangeObjects"],
      textFilters: [params?.numberRangeName]
    }),

  get_partner_directory: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: ["PartnerDirectoryEntries", "PartnerDirectory", "Partners"],
      textFilters: [params?.partnerId]
    }),

  get_message_locks: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames:
        params?.lockType === "designtime"
          ? ["DesigntimeArtifactLocks", "ArtifactLocks"]
          : params?.lockType === "message"
            ? ["MessageLocks"]
            : ["MessageLocks", "DesigntimeArtifactLocks", "ArtifactLocks"]
    }),

  get_system_logs: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: ["SystemLogFiles", "SystemLogs", "LogFiles"],
      textFilters: [params?.logName]
    }),

  get_usage_details: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: ["UsageDetails", "MessageUsage", "Usage"],
      textFilters: [params?.period]
    }),

  get_connectivity_tests: async (params, tenantContext) =>
    fetchCandidateResource({
      token: tenantContext.token,
      baseUrl: tenantContext.baseUrl,
      resourceNames: ["ConnectivityTests", "ConnectionTests"],
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
