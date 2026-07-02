const axios = require("axios");
const { redactSensitiveFields } = require("./redactSensitiveFields");

const cleanUrl = (url) => String(url || "").trim().replace(/\/+$/, "");

const buildTenantRootCandidates = (baseUrl) => {
  const cleanedBaseUrl = cleanUrl(baseUrl);
  if (!cleanedBaseUrl) return [];

  const stripSuffix = (url) => {
    return url
      .replace(/\/odata\/api\/v1$/, "")
      .replace(/\/api\/v1$/, "")
      .replace(/\/odata\/v1$/, "");
  };

  const roots = [stripSuffix(cleanedBaseUrl)];

  if (cleanedBaseUrl.includes("-rt.cfapps.")) {
    roots.push(stripSuffix(cleanedBaseUrl.replace("-rt.cfapps.", ".cfapps.")));
    roots.push(stripSuffix(cleanedBaseUrl.replace("-rt.cfapps.", "-trial.cfapps.")));
  } else if (cleanedBaseUrl.includes(".cfapps.")) {
    roots.push(stripSuffix(cleanedBaseUrl.replace(".cfapps.", "-rt.cfapps.")));
    roots.push(stripSuffix(cleanedBaseUrl.replace(".cfapps.", "-trial.cfapps.")));
  }

  if (cleanedBaseUrl.includes("it-cpi001")) {
    roots.push(stripSuffix(cleanedBaseUrl.replace("it-cpi001", "integrationsuite")));
    roots.push(stripSuffix(cleanedBaseUrl.replace("it-cpi001", "integrationsuite-trial")));
  }

  try {
    const original = new URL(stripSuffix(cleanedBaseUrl));
    const hostnameParts = original.hostname.split(".");
    if (hostnameParts.length > 2) {
      if (hostnameParts[1] !== "integrationsuite") {
        const parts = [...hostnameParts];
        parts[1] = "integrationsuite";
        roots.push(`${original.protocol}//${parts.join(".")}`);
      }
      if (hostnameParts[1] !== "integrationsuite-trial") {
        const parts = [...hostnameParts];
        parts[1] = "integrationsuite-trial";
        roots.push(`${original.protocol}//${parts.join(".")}`);
      }
    }
  } catch {
    // Keep the explicit roots collected above.
  }

  return [...new Set(roots.map(cleanUrl).filter(Boolean))];
};

const buildApiBaseCandidates = (baseUrl) => {
  const roots = buildTenantRootCandidates(baseUrl);
  const candidates = [];
  for (const root of roots) {
    candidates.push(`${root}/api/v1`);
    candidates.push(`${root}/odata/api/v1`);
  }
  return [...new Set(candidates)];
};

const buildTenantHeaders = (token, { csrfToken = "", cookie = "" } = {}) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "DataServiceVersion": "2.0"
  };

  if (csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }

  if (cookie) {
    headers.Cookie = cookie;
  }

  return headers;
};

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

const sanitizeErrorDetail = (error) => {
  const status = error?.response?.status;
  const message =
    error?.response?.data?.error?.message?.value ||
    error?.response?.data?.message ||
    error?.message ||
    "Request failed";

  return {
    status: status || null,
    message: typeof message === "string" ? message : JSON.stringify(message)
  };
};

const fetchODataResource = async ({
  token,
  baseUrl,
  resourceNames,
  queryParams = {},
  textFilters = [],
  preferNonEmpty = false,
  emptyMessage = "",
  itemType = "integration-resource",
  maxItems = 500
}) => {
  if (!token || !baseUrl) {
    return { error: "Connect a tenant first, then I can fetch that live tenant data." };
  }

  const apiBases = buildApiBaseCandidates(baseUrl);
  const attempts = [];
  const deadBases = new Set();
  let emptySuccess = null;

  for (const apiBase of apiBases) {
    if (deadBases.has(apiBase)) {
      continue;
    }

    for (const resourceName of resourceNames) {
      const endpoint = `${apiBase}/${resourceName}${buildQueryString(queryParams)}`;

      try {
        const response = await axios.get(endpoint, {
          headers: buildTenantHeaders(token),
          timeout: 30000,
          validateStatus: (status) => status >= 200 && status < 500
        });

        if (response.status >= 400) {
          attempts.push({
            resourceName,
            apiBase,
            status: response.status,
            detail: response.data?.error?.message?.value || response.statusText
          });
          continue;
        }

        const rawRows = unwrapODataResults(response.data);
        const rows = filterRowsByText(redactSensitiveFields(rawRows), textFilters);
        const result = {
          items: rows.slice(0, maxItems).map((row) => ({
            type: itemType,
            resource: resourceName,
            ...row
          })),
          pendingItems: rows.slice(maxItems).map((row) => ({
            type: itemType,
            resource: resourceName,
            ...row
          })),
          rawData: {
            resource: resourceName,
            apiBase,
            total: rows.length,
            sample: redactSensitiveFields(rows.slice(0, 5))
          }
        };

        if (!preferNonEmpty || rows.length > 0) {
          return result;
        }

        emptySuccess ||= result;
        attempts.push({ resourceName, apiBase, status: response.status, detail: "Returned 0 rows." });
      } catch (error) {
        const detail = sanitizeErrorDetail(error);
        attempts.push({ resourceName, apiBase, ...detail });

        // If it's a network or connection/timeout error, mark the candidate base as dead
        if (
          error.code === "ECONNABORTED" ||
          error.code === "ETIMEDOUT" ||
          error.code === "ENOTFOUND" ||
          error.code === "ECONNREFUSED" ||
          error.message?.toLowerCase().includes("timeout") ||
          error.message?.toLowerCase().includes("network")
        ) {
          deadBases.add(apiBase);
          break; // Stop querying resources on this unreachable hostname
        }
      }
    }
  }

  if (emptySuccess) {
    return {
      ...emptySuccess,
      message: emptyMessage || emptySuccess.message,
      rawData: {
        ...emptySuccess.rawData,
        attemptedResources: attempts.slice(0, 12)
      }
    };
  }

  return {
    message:
      emptyMessage ||
      "This resource is currently not accessible on the connected tenant. Please verify that your credentials have sufficient permissions, or access this area directly via the SAP Integration Suite cockpit.",
    items: [],
    actions: [],
    rawData: {
      attemptedResources: attempts.slice(0, 12)
    }
  };
};

const deleteODataResource = async ({ token, baseUrl, resourcePath }) => {
  if (!token || !baseUrl) {
    return { error: "Connect a tenant first, then I can run that live tenant operation." };
  }

  const apiBases = buildApiBaseCandidates(baseUrl);
  let lastError;

  for (const apiBase of apiBases) {
    const endpoint = `${apiBase}/${resourcePath}`;
    try {
      await axios.delete(endpoint, {
        headers: {
          ...buildTenantHeaders(token),
          "MaxDataServiceVersion": "2.0",
          "X-Requested-With": "XMLHttpRequest"
        },
        timeout: 15000
      });
      return { success: true };
    } catch (error) {
      lastError = error;
      console.warn(`deleteODataResource failed on ${apiBase}/${resourcePath}:`, error.response?.data || error.message);
    }
  }

  throw lastError || new Error(`Delete failed for ${resourcePath}`);
};

const updateODataResource = async ({ token, baseUrl, resourcePath, payload, isStream = false }) => {
  if (!token || !baseUrl) {
    return { error: "Connect a tenant first, then I can run that live tenant operation." };
  }

  const apiBases = buildApiBaseCandidates(baseUrl);
  let lastError;

  for (const apiBase of apiBases) {
    const endpoint = `${apiBase}/${resourcePath}`;
    try {
      const headers = {
        ...buildTenantHeaders(token),
        "MaxDataServiceVersion": "2.0",
        "X-Requested-With": "XMLHttpRequest"
      };

      if (isStream) {
        headers["Content-Type"] = "text/plain";
      } else {
        headers["Content-Type"] = "application/json";
      }

      await axios.put(endpoint, payload, { headers, timeout: 15000 });
      return { success: true };
    } catch (error) {
      lastError = error;
      console.warn(`updateODataResource failed on ${apiBase}/${resourcePath}:`, error.response?.data || error.message);
    }
  }

  throw lastError || new Error(`Update failed for ${resourcePath}`);
};

const downloadODataResourceStream = async ({ token, baseUrl, resourcePath }) => {
  if (!token || !baseUrl) {
    return { error: "Connect a tenant first, then I can run that live tenant operation." };
  }

  const apiBases = buildApiBaseCandidates(baseUrl);
  let lastError;

  for (const apiBase of apiBases) {
    const endpoint = `${apiBase}/${resourcePath}`;
    try {
      const headers = {
        ...buildTenantHeaders(token),
        Accept: "*/*",
        "X-Requested-With": "XMLHttpRequest"
      };

      const response = await axios.get(endpoint, {
        headers,
        responseType: "text",
        timeout: 20000
      });

      return response.data;
    } catch (error) {
      lastError = error;
      console.warn(`downloadODataResourceStream failed on ${apiBase}/${resourcePath}:`, error.response?.data || error.message);
    }
  }

  throw lastError || new Error(`Download stream failed for ${resourcePath}`);
};

module.exports = {
  buildApiBaseCandidates,
  buildTenantHeaders,
  unwrapODataResults,
  buildQueryString,
  filterRowsByText,
  fetchODataResource,
  redactSensitiveFields,
  deleteODataResource,
  updateODataResource,
  downloadODataResourceStream
};
