const axios = require("axios");
const { redactSensitiveFields } = require("./redactSensitiveFields");

const cleanUrl = (url) => String(url || "").trim().replace(/\/+$/, "");

const buildTenantRootCandidates = (baseUrl) => {
  const cleanedBaseUrl = cleanUrl(baseUrl);
  if (!cleanedBaseUrl) return [];

  const roots = [cleanedBaseUrl.replace(/\/api\/v1$/, "")];

  if (cleanedBaseUrl.includes("-rt.cfapps.")) {
    roots.push(cleanedBaseUrl.replace("-rt.cfapps.", ".cfapps.").replace(/\/api\/v1$/, ""));
  } else if (cleanedBaseUrl.includes(".cfapps.")) {
    roots.push(cleanedBaseUrl.replace(".cfapps.", "-rt.cfapps.").replace(/\/api\/v1$/, ""));
  }

  if (cleanedBaseUrl.includes("it-cpi001")) {
    roots.push(cleanedBaseUrl.replace("it-cpi001", "integrationsuite").replace(/\/api\/v1$/, ""));
  }

  try {
    const original = new URL(cleanedBaseUrl.replace(/\/api\/v1$/, ""));
    const hostnameParts = original.hostname.split(".");
    if (hostnameParts.length > 2 && hostnameParts[1] !== "integrationsuite") {
      const parts = [...hostnameParts];
      parts[1] = "integrationsuite";
      roots.push(`${original.protocol}//${parts.join(".")}`);
    }
  } catch {
    // Keep the explicit roots collected above.
  }

  return [...new Set(roots.map(cleanUrl).filter(Boolean))];
};

const buildApiBaseCandidates = (baseUrl) =>
  buildTenantRootCandidates(baseUrl).map((root) => `${root}/api/v1`);

const buildTenantHeaders = (token, { csrfToken = "", cookie = "" } = {}) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
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
  maxItems = 25
}) => {
  if (!token || !baseUrl) {
    return { error: "Connect a tenant first, then I can fetch that live tenant data." };
  }

  const apiBases = buildApiBaseCandidates(baseUrl);
  const attempts = [];
  let emptySuccess = null;

  for (const apiBase of apiBases) {
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
      "This SAP Integration Suite area is not available on the connected tenant through the standard OData APIs we tried. Confirm the endpoint in SAP cockpit network inspect and update the resource registry.",
    items: [],
    actions: [],
    rawData: {
      attemptedResources: attempts.slice(0, 12)
    }
  };
};

module.exports = {
  buildApiBaseCandidates,
  buildTenantHeaders,
  unwrapODataResults,
  buildQueryString,
  filterRowsByText,
  fetchODataResource,
  redactSensitiveFields
};
