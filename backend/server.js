require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const ExcelJS = require("exceljs");
const nodemailer = require("nodemailer");
const archiver = require("archiver");
const app = express();
const hana = require("@sap/hana-client");
app.use(cors());
app.use(express.json({ limit: '10mb' })); 
app.use(express.text({ type: "text/*" }));

const TOKEN_URL = process.env.TOKEN_URL;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const TRIGGER_CLIENT_ID =
    process.env.TRIGGER_CLIENT_ID ||
    process.env.IFLOW_CLIENT_ID ||
    CLIENT_ID;
const TRIGGER_CLIENT_SECRET =
    process.env.TRIGGER_CLIENT_SECRET ||
    process.env.IFLOW_CLIENT_SECRET ||
    CLIENT_SECRET;
const CPI_TRIGGER_ENDPOINT =
    process.env.CPI_TRIGGER_ENDPOINT ||
    "https://inccpidev.it-cpi001-rt.cfapps.eu10.hana.ondemand.com/http/Trigger";
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

const missingEnv = ["TOKEN_URL", "CLIENT_ID", "CLIENT_SECRET"].filter(
  (key) => !process.env[key]
);
if (missingEnv.length > 0) {
  console.warn(
    "Warning: missing .env variables:",
    missingEnv.join(", "),
    "– some CPI features may not work"
  );
}

const getMissingEnv = (keys) => keys.filter((key) => !process.env[key]);

function getConnection() {
  const missingHanaEnv = getMissingEnv(["HANA_SERVER", "HANA_USER", "HANA_PASSWORD"]);

  if (missingHanaEnv.length > 0) {
    throw new Error(
      `Missing HANA configuration: ${missingHanaEnv.join(", ")}. Add these values to the backend .env file and restart the server.`
    );
  }

  const conn = hana.createConnection();

  conn.connect({
    serverNode: process.env.HANA_SERVER,
    uid: process.env.HANA_USER,
    pwd: process.env.HANA_PASSWORD,
    encrypt: true,
    sslValidateCertificate: false
  });

  return conn;
}

const formatFileName = (fileName, fileType, fallbackPrefix = "payload") => {
  const trimmedName = (fileName || "").trim();
  const trimmedType = (fileType || "").trim().replace(/^\./, "");

  if (trimmedName) {
    if (!trimmedType || trimmedName.toLowerCase().endsWith(`.${trimmedType.toLowerCase()}`)) {
      return trimmedName;
    }
    return `${trimmedName}.${trimmedType}`;
  }

  if (trimmedType) {
    return `${fallbackPrefix}.${trimmedType}`;
  }

  return `${fallbackPrefix}.txt`;
};

const decodePayload = (payload) => {
  const rawPayload = typeof payload === "string" ? payload.trim() : "";

  if (!rawPayload) {
    return "";
  }

  try {
    return Buffer.from(rawPayload, "base64").toString("utf-8");
  } catch {
    return rawPayload;
  }
};

const mapReportRow = (row, index) => {
  const decodedPayload = decodePayload(row.PAYLOAD);
  const attachmentBase = (row.ATTACHMENT_NAME || row.PAYLOAD_FILE_NAME || "").trim();
  const attachmentStamp = row.ATTACHMENT_TIMESTAMP
    ? String(row.ATTACHMENT_TIMESTAMP).replace(/[^\dA-Za-z]+/g, "_")
    : "";
  const baseName = [
    attachmentBase || (row.MPL_ID ? `payload-${row.MPL_ID}` : `payload-${index + 1}`),
    attachmentStamp
  ]
    .filter(Boolean)
    .join("_");
  const fileName = formatFileName(
    baseName,
    row.PAYLOAD_FILE_TYPE,
    row.MPL_ID ? `payload-${row.MPL_ID}` : `payload-${index + 1}`
  );

  return {
    id: `${row.MPL_ID || "MPL"}-${row.LOG_START || index}-${index}`,
    mplId: row.MPL_ID || "",
    iflowName: row.IFLOW_NAME || "",
    status: row.STATUS || "",
    logStart: row.LOG_START || "",
    logEnd: row.LOG_END || "",
    errorInfo: row.ERROR_INFO || "-",
    attachmentName: row.ATTACHMENT_NAME || "-",
    attachmentTimestamp: row.ATTACHMENT_TIMESTAMP || "",
    payloadFileName: fileName,
    payloadFileType: row.PAYLOAD_FILE_TYPE || "txt",
    payloadMimeType: row.PAYLOAD_MIME_TYPE || "text/plain",
    payloadEncoding: row.PAYLOAD_ENCODING || "UTF-8",
    decodedPayload
  };
};

const sanitizeFileName = (value, fallback = "payload") => {
  const normalized = (value || fallback).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return normalized || fallback;
};

const getReportRows = (conn) => {
  const sql = `
    SELECT
      "MPL_ID",
      "IFLOW_NAME",
      "STATUS",
      TO_VARCHAR("LOG_START", 'YYYY-MM-DD HH24:MI:SS') AS "LOG_START",
      TO_VARCHAR("LOG_END", 'YYYY-MM-DD HH24:MI:SS') AS "LOG_END",
      "ERROR_INFO",
      "ATTACHMENT_NAME",
      TO_VARCHAR("ATTACHMENT_TIMESTAMP", 'YYYY-MM-DD HH24:MI:SS') AS "ATTACHMENT_TIMESTAMP",
      "PAYLOAD_FILE_NAME",
      "PAYLOAD_FILE_TYPE",
      "PAYLOAD_MIME_TYPE",
      "PAYLOAD_ENCODING",
      "PAYLOAD"
    FROM "HACKTHON-POC"."CPI_DATA"
    ORDER BY "CREATED_AT" DESC
  `;

  const rows = conn.exec(sql);
  return rows.map((row, index) => mapReportRow(row, index));
};

const getPayloadRow = (conn, mplId, logStart, attachmentTimestamp) => {
  const sql = `
    SELECT
      "MPL_ID",
      "LOG_START",
      "ATTACHMENT_TIMESTAMP",
      "PAYLOAD_FILE_NAME",
      "PAYLOAD_FILE_TYPE",
      "PAYLOAD_MIME_TYPE",
      "PAYLOAD_ENCODING",
      "PAYLOAD"
    FROM "HACKTHON-POC"."CPI_DATA"
    WHERE "MPL_ID" = ?
      AND TO_VARCHAR("LOG_START", 'YYYY-MM-DD HH24:MI:SS') = ?
      AND TO_VARCHAR("ATTACHMENT_TIMESTAMP", 'YYYY-MM-DD HH24:MI:SS') = ?
    ORDER BY "CREATED_AT" DESC
  `;

  const stmt = conn.prepare(sql);
  const rows = stmt.exec([mplId, logStart, attachmentTimestamp]);
  return rows[0];
};

const createReportsExcelBuffer = async (reports) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Monitoring Overview", {
    views: [{ state: "frozen", ySplit: 1 }]
  });

  sheet.columns = [
    { header: "MPL ID", key: "mplId", width: 34 },
    { header: "IFLOW NAME", key: "iflowName", width: 32 },
    { header: "STATUS", key: "status", width: 16 },
    { header: "LOG START", key: "logStart", width: 22 },
    { header: "LOG END", key: "logEnd", width: 22 },
    { header: "ERROR INFO", key: "errorInfo", width: 30 },
    { header: "ATTACHMENT NAME", key: "attachmentName", width: 26 },
    { header: "ATTACHMENT TIMESTAMP", key: "attachmentTimestamp", width: 24 },
    { header: "PAYLOAD", key: "payload", width: 120 }
  ];

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle" };

  reports.forEach((row) => {
    sheet.addRow({
      mplId: row.mplId || "",
      iflowName: row.iflowName || "",
      status: row.status || "",
      logStart: row.logStart || "",
      logEnd: row.logEnd || "",
      errorInfo: row.errorInfo || "",
      attachmentName: row.attachmentName || "",
      attachmentTimestamp: row.attachmentTimestamp || "",
      payload: row.decodedPayload || ""
    });
  });

  return workbook.xlsx.writeBuffer();
};

const createReportsZip = async (reports) => {
  const zipBaseName = sanitizeFileName(
    `${reports[0]?.iflowName || "iFlow"}_Payload_files`,
    "iFlow_Payload_files"
  );
  const archive = archiver("zip", { zlib: { level: 9 } });
  const chunks = [];
  const usedFileNames = new Set();

  const zipBufferPromise = new Promise((resolve, reject) => {
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("warning", reject);
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
  });

  reports.forEach((report, index) => {
    const baseName = sanitizeFileName(
      report.payloadFileName,
      `payload-${index + 1}.${report.payloadFileType || "txt"}`
    );

    let uniqueName = baseName;
    let suffix = 1;

    while (usedFileNames.has(uniqueName.toLowerCase())) {
      const extension = path.extname(baseName);
      const fileStem = extension ? baseName.slice(0, -extension.length) : baseName;
      uniqueName = `${fileStem}_${suffix}${extension}`;
      suffix += 1;
    }

    usedFileNames.add(uniqueName.toLowerCase());
    archive.append(report.decodedPayload || "", { name: uniqueName });
  });

  await archive.finalize();

  return {
    zipBuffer: await zipBufferPromise,
    zipFileName: `${zipBaseName}.zip`
  };
};

const createMailTransport = () => {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP configuration is incomplete");
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });
};

const cleanUrl = (url) => url?.trim().replace(/\/+$/, "");
const artifactCache = new Map();
const ARTIFACT_CACHE_TTL_MS = 5 * 60 * 1000;
const ARTIFACT_RETRY_LIMIT = 8;
const ARTIFACT_BATCH_CONCURRENCY = 4;
const messageProcessingLogCache = new Map();

const buildBaseUrlCandidates = (baseUrl) => {
    const cleanedBaseUrl = cleanUrl(baseUrl);

    if (!cleanedBaseUrl) {
        return [];
    }

    const candidates = [cleanedBaseUrl];

    if (cleanedBaseUrl.includes("-rt.cfapps.")) {
        candidates.push(cleanedBaseUrl.replace("-rt.cfapps.", ".cfapps."));
    } else if (cleanedBaseUrl.includes(".cfapps.")) {
        candidates.push(cleanedBaseUrl.replace(".cfapps.", "-rt.cfapps."));
    }

    return [...new Set(candidates)];
};

const tenantHeaders = (token) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/json"
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createMultipartBoundary = (prefix) =>
  `${prefix}_${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

const extractCookieHeader = (setCookieHeader) => {
  if (!Array.isArray(setCookieHeader) || setCookieHeader.length === 0) {
    return "";
  }

  return setCookieHeader
    .map((entry) => String(entry).split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
};

const isAuthoritativeTenantError = (error) => {
  const status = Number(error?.response?.status || 0);
  const code = String(error?.response?.data?.error?.code || "").trim().toLowerCase();

  if (status === 400 || status === 401 || status === 403 || status === 405 || status === 409 || status === 501) {
    return true;
  }

  return code === "not implemented";
};

const buildIntegrationSuiteODataCandidates = (baseUrl) => {
  const cleanedBaseUrl = cleanUrl(baseUrl);

  if (!cleanedBaseUrl) {
    return [];
  }

  const candidates = [];

  try {
    let fixedUrl = cleanedBaseUrl;

    if (fixedUrl.includes("it-cpi001")) {
      fixedUrl = fixedUrl.replace("it-cpi001", "integrationsuite");
    }

    const fixed = new URL(fixedUrl);
    candidates.push(`${fixed.origin}/api/v1`);

    const original = new URL(cleanedBaseUrl);
    candidates.push(`${original.origin}/api/v1`);
  } catch {
    // Ignore malformed URLs and let callers surface the original issue.
  }

  return [...new Set(candidates.map(cleanUrl).filter(Boolean))];
};

const buildIntegrationSuiteApiCandidates = (baseUrl) => {
  const cleanedBaseUrl = cleanUrl(baseUrl);

  if (!cleanedBaseUrl) {
    return [];
  }

  const candidates = [];

  try {
    const url = new URL(cleanedBaseUrl);
    const hostnameParts = url.hostname.split(".");

    if (hostnameParts.length > 2 && hostnameParts[1] !== "integrationsuite") {
      const integrationSuiteParts = [...hostnameParts];
      integrationSuiteParts[1] = "integrationsuite";
      candidates.push(`${url.protocol}//${integrationSuiteParts.join(".")}/api/v1`);
    }

    candidates.push(`${url.origin}/api/v1`);
  } catch {
    // Ignore malformed URLs and let callers surface the original issue.
  }

  return [...new Set(candidates.map(cleanUrl).filter(Boolean))];
};

const fetchPackages = async (baseUrl, token) => {
    const candidates = buildBaseUrlCandidates(baseUrl);
    let lastError;
    const failedCandidates = [];

    for (const candidate of candidates) {
        try {
            const packageResponse = await axios.get(`${candidate}/api/v1/IntegrationPackages`, {
                headers: tenantHeaders(token),
                timeout: 30000
            });

            return {
                apiBaseUrl: candidate,
                packages: packageResponse.data?.d?.results || []
            };
        } catch (error) {
            lastError = error;
            failedCandidates.push({
                candidate,
                detail: error.response?.data || error.message
            });
        }
    }

    failedCandidates.forEach((entry) => {
        console.warn(`fetchPackages failed for ${entry.candidate}:`, entry.detail);
    });

    throw lastError;
};

const fetchArtifactsForPackage = async (baseUrl, token, packageId) => {
    const candidates = buildBaseUrlCandidates(baseUrl);
    const encodedPackageId = encodeURIComponent(packageId);

    for (const candidate of candidates) {
        for (let attempt = 1; attempt <= ARTIFACT_RETRY_LIMIT; attempt += 1) {
            try {

               
                const artifactResponse = await axios.get(
                    `${candidate}/api/v1/IntegrationPackages('${encodedPackageId}')/IntegrationDesigntimeArtifacts`,
                    {
                        headers: tenantHeaders(token),
                        timeout: 60000
                    }
                );

                return artifactResponse.data?.d?.results || [];
            } catch (error) {
                const statusCode = error.response?.status;
                const retriable = statusCode === 429 || error.code === "ECONNRESET";

                if (statusCode === 404) {
                    break;
                }

                if (!retriable) {
                    console.warn(
                        `fetchArtifacts failed for package ${packageId} on ${candidate}:`,
                        error.response?.data || error.message
                    );
                    throw error;
                }

                const retryAfterSeconds = Number(error.response?.headers?.["retry-after"] || 0);
                const backoffMs =
                    retryAfterSeconds > 0
                        ? retryAfterSeconds * 1000
                        : Math.min(1000 * 2 ** (attempt - 1), 10000);

                console.warn(
                    `Retrying artifacts for package ${packageId} on ${candidate}. Attempt ${attempt}/${ARTIFACT_RETRY_LIMIT}.`,
                    error.response?.data || error.message
                );

                await wait(backoffMs);
            }
        }
    }

    throw new Error(`Failed to fetch artifacts for package ${packageId} after retries.`);
};

const fetchArtifactsForPackagesInBatches = async (baseUrl, token, packages) => {
    const results = [];
    const failedPackages = [];

    for (let index = 0; index < packages.length; index += ARTIFACT_BATCH_CONCURRENCY) {
        const batch = packages.slice(index, index + ARTIFACT_BATCH_CONCURRENCY);
        const batchResults = await Promise.allSettled(
            batch.map(async (pkg) => ({
                packageId: pkg.Id,
                artifacts: await fetchArtifactsForPackage(baseUrl, token, pkg.Id)
            }))
        );

        batchResults.forEach((result, batchIndex) => {
            const packageId = batch[batchIndex]?.Id;

            if (result.status === "fulfilled") {
                results.push(result.value);
                return;
            }

            failedPackages.push({
                packageId,
                error: result.reason?.message || String(result.reason || "Unknown artifact fetch error")
            });

            console.warn(
                `Skipping artifacts for package ${packageId} after batch failure:`,
                result.reason?.response?.data || result.reason?.message || result.reason
            );
        });
    }

    return { results, failedPackages };
};

const getArtifactCacheEntry = (cacheKey) => {
    const cachedArtifacts = artifactCache.get(cacheKey);

    if (!cachedArtifacts || cachedArtifacts.expiresAt <= Date.now()) {
        if (cachedArtifacts) {
            artifactCache.delete(cacheKey);
        }

        return null;
    }

    return cachedArtifacts;
};

const getTimedCacheEntry = (cache, cacheKey) => {
  const cachedValue = cache.get(cacheKey);

  if (!cachedValue || cachedValue.expiresAt <= Date.now()) {
    if (cachedValue) {
      cache.delete(cacheKey);
    }

    return null;
  }

  return cachedValue.value;
};

const setTimedCacheEntry = (cache, cacheKey, value, ttlMs) => {
  cache.set(cacheKey, {
    value,
    expiresAt: Date.now() + ttlMs
  });
};

const getTriggerCredentials = () => {
    if (TRIGGER_CLIENT_ID && TRIGGER_CLIENT_SECRET) {
        return {
            clientId: TRIGGER_CLIENT_ID,
            clientSecret: TRIGGER_CLIENT_SECRET,
            source: "trigger-env"
        };
    }

    return null;
};

app.post("/connectTenant", async (req, res) => {
    let { clientId, clientSecret, tokenUrl, baseUrl } = req.body;

    tokenUrl = cleanUrl(tokenUrl);
    baseUrl  = cleanUrl(baseUrl);

    if (!tokenUrl || !baseUrl) {
        return res.status(400).json({ message: "tokenUrl and baseUrl are required." });
    }

    try {
        const tokenEndpoint = tokenUrl.endsWith("/oauth/token")
            ? tokenUrl
            : `${tokenUrl}/oauth/token`;

        const tokenResponse = await axios.post(
            tokenEndpoint,
            "grant_type=client_credentials",
            {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                auth: { username: clientId, password: clientSecret }
            }
        );

        const token = tokenResponse.data.access_token;

        const { apiBaseUrl, packages } = await fetchPackages(baseUrl, token);

        res.json({
            message: "Tenant Connected Successfully",
            packages,
            token: token,
            credentialSource: "tenant-session",
            baseUrl: apiBaseUrl
        });

    } catch (error) {
        console.error("connectTenant error:", error.response?.data || error.message);
        const status = error.response?.status;
        const message = status === 401
            ? "Tenant Connection Failed: invalid client credentials or token URL."
            : "Tenant Connection Failed";
        res.status(500).json({
            message,
            detail: error.response?.data || error.message
        });
    }
});

app.post("/getArtifacts", async (req, res) => {
    let { packageId, token, baseUrl } = req.body;
    baseUrl = cleanUrl(baseUrl);

    try {
        let artifacts = [];
        let failedPackages = [];
        const { apiBaseUrl, packages } = await fetchPackages(baseUrl, token);
        const cacheKey = `${apiBaseUrl}::${packageId || "All"}`;
        const cachedArtifacts = getArtifactCacheEntry(cacheKey);

        if (cachedArtifacts) {
            return res.json({
                artifacts: cachedArtifacts.artifacts,
                packages,
                baseUrl: apiBaseUrl,
                cached: true
            });
        }

        if (!packageId || packageId === "All") {
            const cachedPackageArtifacts = [];
            const missingPackages = [];

            packages.forEach((pkg) => {
                const packageCacheKey = `${apiBaseUrl}::${pkg.Id}`;
                const cachedPackage = getArtifactCacheEntry(packageCacheKey);

                if (cachedPackage) {
                    cachedPackageArtifacts.push(cachedPackage.artifacts);
                } else {
                    missingPackages.push(pkg);
                }
            });

            const {
                results: fetchedPackageResults,
                failedPackages: nextFailedPackages
            } = missingPackages.length
                ? await fetchArtifactsForPackagesInBatches(apiBaseUrl, token, missingPackages)
                : { results: [], failedPackages: [] };

            failedPackages = nextFailedPackages;

            fetchedPackageResults.forEach(({ packageId: fetchedPackageId, artifacts: fetchedArtifacts }) => {
                artifactCache.set(`${apiBaseUrl}::${fetchedPackageId}`, {
                    artifacts: fetchedArtifacts,
                    expiresAt: Date.now() + ARTIFACT_CACHE_TTL_MS
                });
            });

            artifacts = [
                ...cachedPackageArtifacts.flat(),
                ...fetchedPackageResults.flatMap(({ artifacts: fetchedArtifacts }) => fetchedArtifacts)
            ];
        } else {
            artifacts = await fetchArtifactsForPackage(apiBaseUrl, token, packageId);
            artifactCache.set(`${apiBaseUrl}::${packageId}`, {
                artifacts,
                expiresAt: Date.now() + ARTIFACT_CACHE_TTL_MS
            });
        }

        artifactCache.set(cacheKey, {
            artifacts,
            expiresAt: Date.now() + ARTIFACT_CACHE_TTL_MS
        });

        res.json({
            artifacts,
            packages,
            baseUrl: apiBaseUrl,
            partial: packageId === "All",
            failedPackages: packageId === "All" ? failedPackages : []
        });

    } catch (error) {
        console.error("getArtifacts error:", error.response?.data || error.message);
        res.status(500).json({ message: "Failed to fetch artifacts" });
    }
});

const parseSapDate = (sapDate) => {
    if (!sapDate) return null;
    const match = sapDate.match(/\/Date\((\d+)\)\//);
    return match ? parseInt(match[1]) : null;
};

const unwrapODataResults = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.d?.results)) {
    return payload.d.results;
  }

  if (Array.isArray(payload?.value)) {
    return payload.value;
  }

  if (payload?.d && typeof payload.d === "object") {
    return [payload.d];
  }

  if (payload && typeof payload === "object") {
    return [payload];
  }

  return [];
};

const firstNonEmpty = (...values) =>
  values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");

const formatSapTimestamp = (value) => {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    if (/^\d{10,17}$/.test(value.trim())) {
      const numericValue = Number(value.trim());
      if (!Number.isNaN(numericValue)) {
        return new Date(numericValue).toLocaleString("en-IN", { hour12: false });
      }
    }

    const sapDate = parseSapDate(value);
    if (sapDate) {
      return new Date(sapDate).toLocaleString("en-IN", { hour12: false });
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toLocaleString("en-IN", { hour12: false });
    }

    return value;
  }

  if (typeof value === "number") {
    return new Date(value).toLocaleString("en-IN", { hour12: false });
  }

  return String(value);
};

const normalizeKey = (value) => String(value || "").replace(/[\s_\-]/g, "").toLowerCase();

const flattenObject = (input, prefix = "", depth = 0, maxDepth = 4) => {
  if (input === null || input === undefined || depth > maxDepth) {
    return {};
  }

  if (typeof input !== "object") {
    return prefix ? { [prefix]: input } : {};
  }

  if (Array.isArray(input)) {
    return input.reduce((acc, item, index) => {
      const nextPrefix = prefix ? `${prefix}[${index}]` : `[${index}]`;
      return { ...acc, ...flattenObject(item, nextPrefix, depth + 1, maxDepth) };
    }, {});
  }

  return Object.entries(input).reduce((acc, [key, value]) => {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === "object") {
      return { ...acc, ...flattenObject(value, nextPrefix, depth + 1, maxDepth) };
    }

    return { ...acc, [nextPrefix]: value };
  }, {});
};

const findNestedValue = (input, aliases, maxDepth = 4) => {
  const aliasSet = new Set(aliases.map(normalizeKey));
  const visited = new Set();

  const walk = (value, depth) => {
    if (value === null || value === undefined || depth > maxDepth) {
      return undefined;
    }

    if (typeof value !== "object") {
      return undefined;
    }

    if (visited.has(value)) {
      return undefined;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1);
        if (found !== undefined && found !== null && String(found).trim() !== "") {
          return found;
        }
      }
      return undefined;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      if (aliasSet.has(normalizeKey(key))) {
        if (nestedValue !== undefined && nestedValue !== null && String(nestedValue).trim() !== "") {
          return nestedValue;
        }
      }
    }

    for (const nestedValue of Object.values(value)) {
      const found = walk(nestedValue, depth + 1);
      if (found !== undefined && found !== null && String(found).trim() !== "") {
        return found;
      }
    }

    return undefined;
  };

  return walk(input, 0);
};

const findValueInNamedCollection = (input, aliases, maxDepth = 4) => {
  const aliasSet = new Set(aliases.map(normalizeKey));
  const visited = new Set();

  const walk = (value, depth) => {
    if (value === null || value === undefined || depth > maxDepth) {
      return undefined;
    }

    if (typeof value !== "object") {
      return undefined;
    }

    if (visited.has(value)) {
      return undefined;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") {
          const keyName = firstNonEmpty(item.Name, item.name, item.Key, item.key, item.Property, item.property);
          const keyValue = firstNonEmpty(item.Value, item.value, item.Content, item.content);

          if (keyName && aliasSet.has(normalizeKey(keyName)) && keyValue !== undefined && keyValue !== null && String(keyValue).trim() !== "") {
            return keyValue;
          }
        }

        const found = walk(item, depth + 1);
        if (found !== undefined && found !== null && String(found).trim() !== "") {
          return found;
        }
      }
      return undefined;
    }

    for (const nestedValue of Object.values(value)) {
      const found = walk(nestedValue, depth + 1);
      if (found !== undefined && found !== null && String(found).trim() !== "") {
        return found;
      }
    }

    return undefined;
  };

  return walk(input, 0);
};

const encodeODataKey = (value) => encodeURIComponent(String(value).replace(/'/g, "''"));

const getQueueAccessType = (exclusive) => {
  const normalized = String(exclusive ?? "").trim();
  return normalized === "0" ? "Non-Exclusive" : "Exclusive";
};

const getQueueUsage = (active) => {
  const normalized = String(active ?? "").trim();
  return normalized === "1" ? "OK" : "Stopped";
};

const getQueueState = (state) => {
  const normalized = String(state ?? "").trim();
  return normalized === "0" ? "Started" : "Stopped";
};

const mapQueueRecord = (queue, index) => ({
  id:
    firstNonEmpty(
      queue.Id,
      queue.Key,
      queue.Name,
      queue.QueueName,
      queue.StoreName,
      queue.MessageStoreName,
      `queue-${index + 1}`
    ),
  key: firstNonEmpty(
    queue.Id,
    queue.Key,
    queue.QueueName,
    queue.Name,
    queue.StoreName,
    queue.MessageStoreName,
    `queue-${index + 1}`
  ),
  name: firstNonEmpty(
    queue.Name,
    queue.QueueName,
    queue.StoreName,
    queue.MessageStoreName,
    queue.Id,
    `Queue ${index + 1}`
  ),
  accessType: firstNonEmpty(queue.AccessType, queue.Access_Mode, getQueueAccessType(queue.Exclusive), ""),
  usage: getQueueUsage(queue.Active),
  state: getQueueState(queue.State),
  entries:
    Number(
      firstNonEmpty(
        queue.NumbOfMsgs,
        queue.NumberOfMessages,
        queue.Entries,
        queue.EntryCount,
        queue.MessageCount,
        0
      )
    ) || 0
});

const collectNestedMessageRows = (payload) => {
  const directRows = unwrapODataResults(payload);

  if (directRows.length > 0) {
    return directRows;
  }

  const nestedCandidates = [
    payload?.d?.Messages,
    payload?.d?.Entries,
    payload?.Messages,
    payload?.Entries
  ];

  for (const candidate of nestedCandidates) {
    const rows = unwrapODataResults(candidate);
    if (rows.length > 0) {
      return rows;
    }
  }

  return [];
};

const queueMessageAliases = {
  id: ["Id", "id", "Msgid", "MsgId", "MessageId", "messageId", "MessageID", "JMSMessageId", "jmsMessageId", "JMSMessageID"],
  jmsMessageId: ["Msgid", "MsgId", "JMSMessageId", "jmsMessageId", "JMSMessageID", "JmsMessageId", "JmsMessageID", "JMS_MESSAGE_ID", "JMSMessageIDString", "JMSCorrelationId", "JMSMessageIDValue"],
  messageId: ["Mplid", "MplId", "MPLID", "SapMplCorrelationId", "MessageId", "messageId", "MessageID", "MsgId", "MsgID", "MESSAGE_ID", "SAPMessageId", "CorrelationId", "SAP_MessageProcessingLogID"],
  status: ["Failed", "Status", "status", "State", "state", "ProcessingStatus", "MESSAGE_STATUS", "DeliveryStatus"],
  dueAt: ["OverdueAt", "DueAt", "dueAt", "DueDate", "VisibleAt", "NextVisibleAt", "DUE_AT"],
  createdAt: ["CreatedAt", "createdAt", "CreatedOn", "CreatedDate", "EnqueueTime", "Timestamp", "timestamp", "CREATED_AT", "Created", "InsertedAt"],
  retainUntil: ["ExpirationDate", "RetainUntil", "retainUntil", "RetentionEnd", "ExpiresAt", "ExpiryDate", "RETAIN_UNTIL", "ExpirationTime"],
  retryCount: ["RetryCount", "retryCount", "RedeliveryCount", "DeliveryAttempt", "AttemptCount", "RETRY_COUNT", "Retries"],
  nextRetryOn: ["NextRetry", "NextRetryOn", "nextRetryOn", "NextRetryAt", "NextVisibleAt", "NEXT_RETRY_ON"],
  correlationId: ["SapMplCorrelationId", "CorrelationId", "correlationId", "SapCorrelationId"]
};

const pickMessageValue = (message, aliases) =>
  firstNonEmpty(
    ...aliases.map((alias) => message?.[alias]),
    findNestedValue(message, aliases),
    findValueInNamedCollection(message, aliases)
  );

const mapQueueMessage = (message, index) => ({
  id: firstNonEmpty(pickMessageValue(message, queueMessageAliases.id), `message-${index + 1}`),
  jmsMessageId: firstNonEmpty(pickMessageValue(message, queueMessageAliases.jmsMessageId), message?.id),
  messageId: firstNonEmpty(
    pickMessageValue(message, queueMessageAliases.messageId),
    pickMessageValue(message, ["MessageGuid", "messageGuid", "MessageUUID", "messageUUID"])
  ),
  failed: typeof pickMessageValue(message, ["Failed"]) === "boolean" ? pickMessageValue(message, ["Failed"]) : false,
  status:
    typeof pickMessageValue(message, ["Failed"]) === "boolean"
      ? (pickMessageValue(message, ["Failed"]) ? "Failed" : "Waiting")
      : pickMessageValue(message, queueMessageAliases.status),
  dueAt: formatSapTimestamp(pickMessageValue(message, queueMessageAliases.dueAt)),
  createdAt: formatSapTimestamp(pickMessageValue(message, queueMessageAliases.createdAt)),
  retainUntil: formatSapTimestamp(pickMessageValue(message, queueMessageAliases.retainUntil)),
  retryCount: firstNonEmpty(pickMessageValue(message, queueMessageAliases.retryCount), "0"),
  nextRetryOn: (() => {
    const nextRetryValue = pickMessageValue(message, queueMessageAliases.nextRetryOn);
    return nextRetryValue === "0" || nextRetryValue === 0 ? "" : formatSapTimestamp(nextRetryValue);
  })(),
  correlationId: pickMessageValue(message, queueMessageAliases.correlationId),
  iflowName: "",
  packageName: "",
  rawFields: flattenObject(message)
});

const fetchMessageProcessingLog = async (baseUrl, token, mplId) => {
  const cacheKey = `${baseUrl}::mpl::${mplId}`;
  const cachedValue = getTimedCacheEntry(messageProcessingLogCache, cacheKey);

  if (cachedValue) {
    return cachedValue;
  }

  const candidates = buildBaseUrlCandidates(baseUrl);
  let lastError;

  for (const candidate of candidates) {
    try {
      const response = await axios.get(
        `${candidate}/api/v1/MessageProcessingLogs('${encodeODataKey(mplId)}')`,
        {
          headers: tenantHeaders(token),
          params: {
            $format: "json"
          },
          timeout: 30000
        }
      );

      const mpl = response.data?.d || response.data;
      const enriched = {
        iflowName: mpl?.IntegrationFlowName || mpl?.IntegrationArtifact?.Name || "",
        packageName: mpl?.IntegrationArtifact?.PackageName || mpl?.IntegrationArtifact?.PackageId || "",
        status: mpl?.Status || mpl?.CustomStatus || "",
        correlationId: mpl?.CorrelationId || mpl?.MessageGuid || ""
      };

      setTimedCacheEntry(messageProcessingLogCache, cacheKey, enriched, ARTIFACT_CACHE_TTL_MS);
      return enriched;
    } catch (error) {
      lastError = error;
      console.warn(
        `fetchMessageProcessingLog failed for ${candidate} and MPL ${mplId}:`,
        error.response?.data || error.message
      );
    }
  }

  throw lastError;
};

const enrichQueueMessages = async (baseUrl, token, messages) => {
  const enrichedMessages = await Promise.all(
    messages.map(async (message) => {
      if (!message.messageId) {
        return message;
      }

      try {
        const mplDetails = await fetchMessageProcessingLog(baseUrl, token, message.messageId);
        return {
          ...message,
          status: message.status || mplDetails.status,
          correlationId: mplDetails.correlationId || message.correlationId,
          iflowName: mplDetails.iflowName || "",
          packageName: mplDetails.packageName || ""
        };
      } catch {
        return message;
      }
    })
  );

  return enrichedMessages;
};

const moveJmsMessage = async (baseUrl, token, sourceQueueName, targetQueueName, jmsMessageId, failed) => {
  try {
    await moveJmsMessageDirect(baseUrl, token, sourceQueueName, targetQueueName, jmsMessageId);
    return;
  } catch (directError) {
    console.warn(
      `moveJmsMessage direct API route failed for ${jmsMessageId} from ${sourceQueueName} to ${targetQueueName}:`,
      directError.response?.data || directError.message
    );
  }

  try {
    await moveJmsMessageViaBatch(baseUrl, token, sourceQueueName, targetQueueName, jmsMessageId);
    return;
  } catch (batchError) {
    console.warn(
      `moveJmsMessage via SAP UI batch route failed for ${jmsMessageId} from ${sourceQueueName} to ${targetQueueName}:`,
      batchError.response?.data || batchError.message
    );
  }

  const candidates = buildBaseUrlCandidates(baseUrl);
  const encodedMessageId = encodeODataKey(jmsMessageId);
  const encodedSourceQueue = encodeODataKey(sourceQueueName);
  const encodedTargetQueue = encodeODataKey(targetQueueName);
  let lastError;

  for (const candidate of candidates) {
    try {
      await axios.put(
        `${candidate}/api/v1/JmsMessages(Msgid='${encodedMessageId}',Name='${encodedSourceQueue}',Failed=${failed ? "true" : "false"})/$links/Queue`,
        {
          uri: `${candidate}/api/v1/Queues('${encodedTargetQueue}')`
        },
        {
          headers: {
            ...tenantHeaders(token),
            "Content-Type": "application/json"
          },
          timeout: 30000
        }
      );

      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `moveJmsMessage failed for ${jmsMessageId} from ${sourceQueueName} to ${targetQueueName} on ${candidate}:`,
        error.response?.data || error.message
      );

      if (isAuthoritativeTenantError(error)) {
        throw error;
      }
    }
  }

  throw lastError || new Error("Failed to move JMS message.");
};

const buildJmsMessageEntityPath = (sourceQueueName, jmsMessageId, failed) => {
  const encodedMessageId = encodeODataKey(jmsMessageId);
  const encodedSourceQueue = encodeODataKey(sourceQueueName);
  return `/api/v1/JmsMessages(Msgid='${encodedMessageId}',Name='${encodedSourceQueue}',Failed=${failed ? "true" : "false"})`;
};

const getJmsMessageEntity = async (candidate, token, sourceQueueName, jmsMessageId, failed) => {
  const entityPath = buildJmsMessageEntityPath(sourceQueueName, jmsMessageId, failed);
  const response = await axios.get(`${candidate}${entityPath}`, {
    headers: tenantHeaders(token),
    params: {
      $format: "json"
    },
    timeout: 30000
  });

  return {
    entityPath,
    entityUrl: `${candidate}${entityPath}`,
    entity: response.data?.d || response.data
  };
};

const buildODataJmsMessageEntityPath = (sourceQueueName, jmsMessageId, failed) => {
  const encodedMessageId = encodeODataKey(jmsMessageId);
  const encodedSourceQueue = encodeODataKey(sourceQueueName);
  return `/JmsMessages(Msgid='${encodedMessageId}',Name='${encodedSourceQueue}',Failed=${failed ? "true" : "false"})`;
};

const getODataCsrfContext = async (serviceBaseUrl, token) => {
  const candidatePaths = [
    `${serviceBaseUrl}`,
    `${serviceBaseUrl}/$metadata`,
    `${serviceBaseUrl}/Queues?$top=1&$format=json`
  ];
  let lastError;

  for (const candidatePath of candidatePaths) {
    try {
      const response = await axios.get(candidatePath, {
        headers: {
          ...tenantHeaders(token),
          "x-csrf-token": "Fetch"
        },
        responseType: "text",
        timeout: 30000
      });

      const csrfToken = response.headers["x-csrf-token"];
      if (csrfToken) {
        return {
          csrfToken,
          cookieHeader: extractCookieHeader(response.headers["set-cookie"])
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return {
    csrfToken: "",
    cookieHeader: ""
  };
};

const buildMoveApiCandidates = (baseUrl) => {
  const cleanedBaseUrl = cleanUrl(baseUrl);

  if (!cleanedBaseUrl) {
    return [];
  }

  const candidates = [];

  try {
    let fixedUrl = cleanedBaseUrl;
    if (fixedUrl.includes("integrationsuite")) {
      fixedUrl = fixedUrl.replace("integrationsuite", "it-cpi001");
    }

    const fixed = new URL(fixedUrl);
    candidates.push(`${fixed.origin}/api/v1`);

    const original = new URL(cleanedBaseUrl);
    candidates.push(`${original.origin}/api/v1`);
  } catch {
    // Ignore malformed URLs and let callers surface the original issue.
  }

  return [...new Set(candidates.map(cleanUrl).filter(Boolean))];
};

const getApiCsrfContext = async (serviceBaseUrl, token) => {
  const candidatePaths = [
    `${serviceBaseUrl}/`,
    `${serviceBaseUrl}`,
    `${serviceBaseUrl}/Queues?$top=1&$format=json`
  ];
  let lastError;

  for (const candidatePath of candidatePaths) {
    try {
      const response = await axios.get(candidatePath, {
        headers: {
          ...tenantHeaders(token),
          "x-csrf-token": "Fetch"
        },
        responseType: "text",
        timeout: 30000
      });

      const csrfToken = response.headers["x-csrf-token"];

      if (csrfToken) {
        return {
          csrfToken,
          cookieHeader: extractCookieHeader(response.headers["set-cookie"])
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return {
    csrfToken: "",
    cookieHeader: ""
  };
};

const moveJmsMessageDirect = async (baseUrl, token, sourceQueueName, targetQueueName, jmsMessageId) => {
  const candidates = buildMoveApiCandidates(baseUrl);
  const selector = `JMSMessageID='${jmsMessageId}'`;
  let lastError;

  for (const serviceBaseUrl of candidates) {
    try {
      const { csrfToken, cookieHeader } = await getApiCsrfContext(serviceBaseUrl, token);

      if (!csrfToken) {
        throw new Error(`Missing CSRF token from ${serviceBaseUrl}.`);
      }

      const queueResponse = await axios.get(
        `${serviceBaseUrl}/Queues('${encodeODataKey(sourceQueueName)}')`,
        {
          headers: tenantHeaders(token),
          params: { $format: "json" },
          timeout: 30000
        }
      );

      const queueEntity = queueResponse.data?.d || queueResponse.data || {};
      const payload = {
        ...(queueEntity && typeof queueEntity === "object" ? queueEntity : {})
      };

      await axios.request({
        method: "PATCH",
        url:
          `${serviceBaseUrl}/Queues('${encodeODataKey(sourceQueueName)}')` +
          `?operation=move&target_queue=${encodeURIComponent(targetQueueName)}` +
          `&selector=${encodeURIComponent(selector)}`,
        data: payload,
        headers: {
          ...tenantHeaders(token),
          "x-csrf-token": csrfToken,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          "Content-Type": "application/json"
        },
        timeout: 30000
      });
      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `moveJmsMessageDirect failed for ${jmsMessageId} from ${sourceQueueName} to ${targetQueueName} on ${serviceBaseUrl}:`,
        error.response?.data || error.message
      );
    }
  }

  throw lastError || new Error("Failed to move JMS message directly.");
};

const getODataJmsMessageEntity = async (serviceBaseUrl, token, sourceQueueName, jmsMessageId, failed) => {
  const entityPath = buildODataJmsMessageEntityPath(sourceQueueName, jmsMessageId, failed);
  const response = await axios.get(`${serviceBaseUrl}${entityPath}`, {
    headers: tenantHeaders(token),
    params: {
      $format: "json"
    },
    timeout: 30000
  });

  return {
    entityPath,
    entityUrl: `${serviceBaseUrl}${entityPath}`,
    entity: response.data?.d || response.data
  };
};

const buildRetryBatchBody = ({ entityPath, entityUrl, entityPayload, csrfToken }) => {
  const batchBoundary = createMultipartBoundary("batch");
  const changeSetBoundary = createMultipartBoundary("changeset");
  const lines = [
    `--${batchBoundary}`,
    `Content-Type: multipart/mixed; boundary=${changeSetBoundary}`,
    "",
    `--${changeSetBoundary}`,
    "Content-Type: application/http",
    "Content-Transfer-Encoding: binary",
    "",
    `MERGE ${entityPath} HTTP/1.1`,
    "sap-cancel-on-close: false",
    "sap-contextid-accept: header",
    "Accept: application/json",
    `x-csrf-token: ${csrfToken}`,
    "Accept-Language: en",
    "DataServiceVersion: 2.0",
    "MaxDataServiceVersion: 2.0",
    "X-Requested-With: XMLHttpRequest",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(entityPayload, "utf8")}`,
    "",
    entityPayload,
    `--${changeSetBoundary}--`,
    `--${batchBoundary}--`,
    ""
  ];

  return {
    batchBoundary,
    body: lines.join("\r\n")
  };
};

const buildMoveBatchBody = ({ sourceQueueName, targetQueueName, jmsMessageId, csrfToken }) => {
  const batchBoundary = createMultipartBoundary("batch");
  const changeSetBoundary = createMultipartBoundary("changeset");
  const selector = `JMSMessageID='${jmsMessageId}'`;
  const movePath =
    `Queues('${encodeODataKey(sourceQueueName)}')` +
    `?operation=move&target_queue=${encodeURIComponent(targetQueueName)}` +
    `&selector=${encodeURIComponent(selector)}`;
  const lines = [
    `--${batchBoundary}`,
    `Content-Type: multipart/mixed; boundary=${changeSetBoundary}`,
    "",
    `--${changeSetBoundary}`,
    "Content-Type: application/http",
    "Content-Transfer-Encoding: binary",
    "",
    `MERGE ${movePath} HTTP/1.1`,
    "sap-cancel-on-close: false",
    "sap-contextid-accept: header",
    "Accept: application/json",
    "Accept-Language: en",
    "DataServiceVersion: 2.0",
    "MaxDataServiceVersion: 2.0",
    "X-Requested-With: XMLHttpRequest",
    `x-csrf-token: ${csrfToken}`,
    "",
    `--${changeSetBoundary}--`,
    `--${batchBoundary}`,
    "Content-Type: application/http",
    "Content-Transfer-Encoding: binary",
    "",
    `GET Queues('${encodeODataKey(sourceQueueName)}')/Messages HTTP/1.1`,
    "sap-cancel-on-close: true",
    "sap-contextid-accept: header",
    "Accept: application/json",
    "x-csrf-token: " + csrfToken,
    "Accept-Language: en",
    "DataServiceVersion: 2.0",
    "MaxDataServiceVersion: 2.0",
    "X-Requested-With: XMLHttpRequest",
    "",
    `--${batchBoundary}--`,
    ""
  ];

  return {
    batchBoundary,
    body: lines.join("\r\n")
  };
};

const moveJmsMessageViaBatch = async (baseUrl, token, sourceQueueName, targetQueueName, jmsMessageId) => {
  const candidates = buildIntegrationSuiteODataCandidates(baseUrl);
  let lastError;

  for (const serviceBaseUrl of candidates) {
    try {
      const { csrfToken, cookieHeader } = await getODataCsrfContext(serviceBaseUrl, token);

      if (!csrfToken) {
        throw new Error(`Missing CSRF token from ${serviceBaseUrl}.`);
      }

      const { batchBoundary, body } = buildMoveBatchBody({
        sourceQueueName,
        targetQueueName,
        jmsMessageId,
        csrfToken
      });

      const response = await axios.post(`${serviceBaseUrl}/$batch`, body, {
        headers: {
          ...tenantHeaders(token),
          "x-csrf-token": csrfToken,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          "Content-Type": `multipart/mixed; boundary=${batchBoundary}`
        },
        responseType: "text",
        timeout: 30000,
        transformResponse: [(value) => value]
      });

      const batchText = String(response.data || "");
      if (/HTTP\/1\.1 4\d\d/i.test(batchText) || /HTTP\/1\.1 5\d\d/i.test(batchText) || /Internal Server Error/i.test(batchText)) {
        const error = new Error("Tenant batch move operation failed.");
        error.response = {
          status: 500,
          data: {
            error: {
              code: "Batch Move Failed",
              message: {
                lang: "en",
                value: batchText
              }
            },
            raw: batchText
          }
        };
        throw error;
      }

      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `moveJmsMessageViaBatch failed for ${jmsMessageId} from ${sourceQueueName} to ${targetQueueName} on ${serviceBaseUrl}:`,
        error.response?.data || error.message
      );
    }
  }

  throw lastError || new Error("Failed to move JMS message via batch.");
};

const retryJmsMessageViaBatch = async (baseUrl, token, sourceQueueName, jmsMessageId, failed) => {
  const candidates = buildIntegrationSuiteODataCandidates(baseUrl);
  let lastError;

  for (const serviceBaseUrl of candidates) {
    try {
      const { csrfToken, cookieHeader } = await getODataCsrfContext(serviceBaseUrl, token);

      if (!csrfToken) {
        throw new Error(`Missing CSRF token from ${serviceBaseUrl}.`);
      }

      const { entityPath, entityUrl, entity } = await getODataJmsMessageEntity(
        serviceBaseUrl,
        token,
        sourceQueueName,
        jmsMessageId,
        failed
      );

      const entityPayload = JSON.stringify({
        ...(entity && typeof entity === "object" ? entity : {}),
        __metadata: {
          ...(entity?.__metadata || {}),
          uri: entityUrl
        }
      });
      const { batchBoundary, body } = buildRetryBatchBody({
        entityPath,
        entityUrl,
        entityPayload,
        csrfToken
      });

      const response = await axios.post(`${serviceBaseUrl}/$batch`, body, {
        headers: {
          ...tenantHeaders(token),
          "x-csrf-token": csrfToken,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          "Content-Type": `multipart/mixed; boundary=${batchBoundary}`
        },
        responseType: "text",
        timeout: 30000,
        transformResponse: [(value) => value]
      });

      const batchText = String(response.data || "");
      if (/Internal Server Error/i.test(batchText) || /Error during operation retry or queue config change operation/i.test(batchText)) {
        const error = new Error("Error during operation retry or queue config change operation");
        error.response = {
          status: 500,
          data: {
            error: {
              code: "Internal Server Error",
              message: {
                lang: "en",
                value: "Error during operation retry or queue config change operation"
              }
            },
            raw: batchText
          }
        };
        throw error;
      }

      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `retryJmsMessageViaBatch failed for ${jmsMessageId} in ${sourceQueueName} on ${serviceBaseUrl}:`,
        error.response?.data || error.message
      );
    }
  }

  throw lastError || new Error("Failed to retry JMS message via batch.");
};

const retryJmsMessageDirect = async (baseUrl, token, sourceQueueName, jmsMessageId, failed) => {
  const candidates = buildMoveApiCandidates(baseUrl);
  const selector = `JMSMessageID='${jmsMessageId}'`;
  let lastError;

  for (const serviceBaseUrl of candidates) {
    try {
      const { csrfToken, cookieHeader } = await getApiCsrfContext(serviceBaseUrl, token);

      if (!csrfToken) {
        throw new Error(`Missing CSRF token from ${serviceBaseUrl}.`);
      }

      const queueResponse = await axios.get(
        `${serviceBaseUrl}/Queues('${encodeODataKey(sourceQueueName)}')`,
        {
          headers: tenantHeaders(token),
          params: { $format: "json" },
          timeout: 30000
        }
      );

      const queueEntity = queueResponse.data?.d || queueResponse.data || {};
      const payload = {
        ...(queueEntity && typeof queueEntity === "object" ? queueEntity : {})
      };

      await axios.request({
        method: "PATCH",
        url:
          `${serviceBaseUrl}/Queues('${encodeODataKey(sourceQueueName)}')` +
          `?operation=retry&selector=${encodeURIComponent(selector)}`,
        data: payload,
        headers: {
          ...tenantHeaders(token),
          "x-csrf-token": csrfToken,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          "Content-Type": "application/json"
        },
        timeout: 30000
      });
      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `retryJmsMessageDirect failed for ${jmsMessageId} in ${sourceQueueName} on ${serviceBaseUrl}:`,
        error.response?.data || error.message
      );
    }
  }

  throw lastError || new Error("Failed to retry JMS message directly.");
};
const retryJmsMessageSimple = async (baseUrl, token, queueName, jmsMessageId, failed) => {
  const candidates = buildBaseUrlCandidates(baseUrl);

  for (const candidate of candidates) {
    try {

      const csrfRes = await axios.get(`${candidate}/api/v1/`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-csrf-token": "fetch"
        }
      });

      const csrfToken = csrfRes.headers["x-csrf-token"];
      const cookie = extractCookieHeader(csrfRes.headers["set-cookie"]);

      if (!csrfToken) throw new Error("No CSRF token");

      const url = `${candidate}/api/v1/JmsMessages(Msgid='${encodeODataKey(jmsMessageId)}',Name='${encodeODataKey(queueName)}',Failed=${failed ? "true" : "false"})`;

      await axios.patch(
        url,
        {}, // empty body
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "x-csrf-token": csrfToken,
            ...(cookie ? { Cookie: cookie } : {}),
            "Content-Type": "application/json",
            Accept: "application/json"
          }
        }
      );
      return;

    } catch (err) {
      console.warn("Retry simple failed:", err.response?.data || err.message);
    }
  }

  throw new Error("Retry failed for all candidates");
};
const retryJmsMessage = async (baseUrl, token, sourceQueueName, jmsMessageId, failed) => {
  try {
    await retryJmsMessageDirect(baseUrl, token, sourceQueueName, jmsMessageId, failed);
    return;
  } catch (directError) {
    console.warn(
      `retryJmsMessage direct API route failed for ${jmsMessageId} in ${sourceQueueName}:`,
      directError.response?.data || directError.message
    );
  }

  try {
    await retryJmsMessageViaBatch(baseUrl, token, sourceQueueName, jmsMessageId, failed);
    return;
  } catch (batchError) {
    console.warn(
      `retryJmsMessage via SAP UI batch route failed for ${jmsMessageId} in ${sourceQueueName}:`,
      batchError.response?.data || batchError.message
    );

    const candidates = buildBaseUrlCandidates(baseUrl);
    let lastError = batchError;

    for (const candidate of candidates) {
      try {
        const { entityUrl, entity } = await getJmsMessageEntity(
          candidate,
          token,
          sourceQueueName,
          jmsMessageId,
          failed
        );

        const mergePayload =
          entity && typeof entity === "object"
            ? {
                ...entity,
                __metadata: {
                  ...(entity.__metadata || {}),
                  uri: entityUrl
                }
              }
            : {
                __metadata: { uri: entityUrl }
              };

        await axios.request({
          method: "MERGE",
          url: entityUrl,
          data: mergePayload,
          headers: {
            ...tenantHeaders(token),
            "Content-Type": "application/json",
            "DataServiceVersion": "2.0",
            "MaxDataServiceVersion": "2.0",
            "X-Requested-With": "XMLHttpRequest"
          },
          timeout: 30000
        });

        return;
      } catch (error) {
        lastError = error;
        console.warn(
          `retryJmsMessage MERGE failed for ${jmsMessageId} in ${sourceQueueName} on ${candidate}:`,
          error.response?.data || error.message
        );

        if (isAuthoritativeTenantError(error)) {
          throw error;
        }
      }
    }

    throw lastError || new Error("Failed to retry JMS message.");
  }
};

const deleteJmsMessage = async (baseUrl, token, sourceQueueName, jmsMessageId, failed) => {
  const candidates = buildBaseUrlCandidates(baseUrl);
  let lastError;

  for (const candidate of candidates) {
    try {
      const entityPath = buildJmsMessageEntityPath(sourceQueueName, jmsMessageId, failed);

      await axios.delete(`${candidate}${entityPath}`, {
        headers: {
          ...tenantHeaders(token),
          "DataServiceVersion": "2.0",
          "MaxDataServiceVersion": "2.0",
          "X-Requested-With": "XMLHttpRequest"
        },
        timeout: 30000
      });

      return;
    } catch (error) {
      lastError = error;
      console.warn(
        `deleteJmsMessage failed for ${jmsMessageId} in ${sourceQueueName} on ${candidate}:`,
        error.response?.data || error.message
      );

      if (isAuthoritativeTenantError(error)) {
        throw error;
      }
    }
  }

  throw lastError || new Error("Failed to delete JMS message.");
};

const getJmsQueueRecords = async (baseUrl, token) => {
  const candidates = buildBaseUrlCandidates(baseUrl);
  let lastError;

  for (const candidate of candidates) {
    try {
      const response = await axios.get(`${candidate}/api/v1/Queues`, {
        headers: tenantHeaders(token),
        params: {
          $format: "json",
          $top: 500
        },
        timeout: 30000
      });

      const rows = unwrapODataResults(response.data);
      const normalizedQueues = rows
        .map(mapQueueRecord)
        .filter((queue) => queue.name)
        .sort((left, right) => left.name.localeCompare(right.name));

      return Array.from(new Map(normalizedQueues.map((queue) => [queue.name, queue])).values());
    } catch (error) {
      lastError = error;
      console.warn("getJmsQueueRecords failed for", candidate, error.response?.data || error.message);
    }
  }

  throw lastError || new Error("Unable to fetch JMS queues.");
};

const toSafeNumber = (value, fallback = 0) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
};

const mapJmsBrokerResource = (broker) => ({
  key: firstNonEmpty(broker?.Key, broker?.Id, broker?.Name, "Broker1"),
  capacity: toSafeNumber(firstNonEmpty(broker?.Capacity, broker?.capacity, 0)),
  maxCapacity: toSafeNumber(firstNonEmpty(broker?.MaxCapacity, broker?.maxCapacity, 0)),
  queueNumber: toSafeNumber(firstNonEmpty(broker?.QueueNumber, broker?.queueNumber, 0)),
  maxQueueNumber: toSafeNumber(firstNonEmpty(broker?.MaxQueueNumber, broker?.maxQueueNumber, 0)),
  capacityOk: toSafeNumber(firstNonEmpty(broker?.CapacityOk, broker?.capacityOk, 0)),
  capacityWarning: toSafeNumber(firstNonEmpty(broker?.CapacityWarning, broker?.capacityWarning, 0)),
  capacityError: toSafeNumber(firstNonEmpty(broker?.CapacityError, broker?.capacityError, 0)),
  isQueuesHigh: toSafeNumber(firstNonEmpty(broker?.IsQueuesHigh, broker?.isQueuesHigh, 0)),
  isMessageSpoolHigh: toSafeNumber(firstNonEmpty(broker?.IsMessageSpoolHigh, broker?.isMessageSpoolHigh, 0)),
  isTransactedSessionsHigh: toSafeNumber(firstNonEmpty(broker?.IsTransactedSessionsHigh, broker?.isTransactedSessionsHigh, 0)),
  isConsumersHigh: toSafeNumber(firstNonEmpty(broker?.IsConsumersHigh, broker?.isConsumersHigh, 0)),
  isProducersHigh: toSafeNumber(firstNonEmpty(broker?.IsProducersHigh, broker?.isProducersHigh, 0))
});

const getJmsBrokerResource = async (baseUrl, token, brokerKey = "Broker1") => {
  const candidates = buildBaseUrlCandidates(baseUrl);
  const encodedBrokerKey = encodeODataKey(brokerKey);
  let lastError;

  for (const candidate of candidates) {
    try {
      const response = await axios.get(`${candidate}/api/v1/JmsBrokers('${encodedBrokerKey}')`, {
        headers: tenantHeaders(token),
        params: {
          $format: "json"
        },
        timeout: 30000
      });

      const brokerPayload = response.data?.d || response.data;
      return mapJmsBrokerResource(brokerPayload);
    } catch (error) {
      lastError = error;
      console.warn(
        `getJmsBrokerResource failed for ${candidate} and broker ${brokerKey}:`,
        error.response?.data || error.message
      );
    }
  }

  throw lastError || new Error(`Unable to fetch JMS broker resource details for ${brokerKey}.`);
};

const getJmsMessagesForQueue = async (baseUrl, token, queueName, queueKey) => {
  const candidates = buildBaseUrlCandidates(baseUrl);
  const queueIdentifiers = Array.from(
    new Set(
      [queueName, queueKey]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
  let lastError;

  for (const candidate of candidates) {
    for (const queueIdentifier of queueIdentifiers) {
      const encodedQueueKey = encodeODataKey(queueIdentifier);
      const resourcePaths = [
        `/api/v1/Queues('${encodedQueueKey}')/Messages`,
        `/api/v1/Queues('${encodedQueueKey}')?$expand=Messages`,
        `/api/v1/Queues('${encodedQueueKey}')?$expand=Entries`
      ];

      for (const resourcePath of resourcePaths) {
        try {
          const response = await axios.get(`${candidate}${resourcePath}`, {
            headers: tenantHeaders(token),
            params: {
              $format: "json",
              $top: 200
            },
            timeout: 30000
          });

          const rows = collectNestedMessageRows(response.data);
          if (rows.length > 0 || resourcePath.includes("/Messages")) {
            return rows.map(mapQueueMessage);
          }
        } catch (error) {
          lastError = error;

          console.warn(
            `getJmsMessagesForQueue failed for ${candidate}${resourcePath}:`,
            error.response?.data || error.message
          );

          if (error.response?.status === 404) {
            continue;
          }
        }
      }
    }
  }

  throw lastError || new Error(`Unable to fetch messages for queue ${queueName || queueKey}.`);
};

app.post("/jms-queues", async (req, res) => {
  let { token, baseUrl } = req.body || {};
  baseUrl = cleanUrl(baseUrl);

  if (!token || !baseUrl) {
    return res.status(400).json({ message: "token and baseUrl are required." });
  }

  try {
    const queues = await getJmsQueueRecords(baseUrl, token);
    return res.json({ queues });
  } catch (error) {
    console.error("jms-queues error:", error.response?.data || error.message);
    return res.status(500).json({
      message: "Failed to fetch JMS queues.",
      detail: error.response?.data || error.message
    });
  }
});

app.post("/jms-messages", async (req, res) => {
  let { token, baseUrl, queueName, queueKey } = req.body || {};
  baseUrl = cleanUrl(baseUrl);

  if (!token || !baseUrl || (!queueName && !queueKey)) {
    return res.status(400).json({ message: "token, baseUrl, and queueName or queueKey are required." });
  }

  try {
    const messages = await getJmsMessagesForQueue(baseUrl, token, queueName, queueKey);
    const enrichedMessages = await enrichQueueMessages(baseUrl, token, messages);
    return res.json({ messages: enrichedMessages });
  } catch (error) {
    console.error("jms-messages error:", error.response?.data || error.message);
    return res.status(500).json({
      message: "Failed to fetch JMS messages.",
      detail: error.response?.data || error.message
    });
  }
});

app.post("/jms-resource-details", async (req, res) => {
  let { token, baseUrl, brokerKey } = req.body || {};
  baseUrl = cleanUrl(baseUrl);

  if (!token || !baseUrl) {
    return res.status(400).json({ message: "token and baseUrl are required." });
  }

  try {
    const resource = await getJmsBrokerResource(baseUrl, token, brokerKey || "Broker1");
    return res.json({ resource });
  } catch (error) {
    console.error("jms-resource-details error:", error.response?.data || error.message);
    return res.status(500).json({
      message: "Failed to fetch JMS resource details.",
      detail: error.response?.data || error.message
    });
  }
});

app.post("/jms-messages/move", async (req, res) => {
  let { token, baseUrl, sourceQueueName, targetQueueName, messages } = req.body || {};
  baseUrl = cleanUrl(baseUrl);

  if (!token || !baseUrl || !sourceQueueName || !targetQueueName || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      message: "token, baseUrl, sourceQueueName, targetQueueName, and messages are required."
    });
  }

  try {
    await Promise.all(
      messages.map((message) =>
        moveJmsMessage(
          baseUrl,
          token,
          sourceQueueName,
          targetQueueName,
          message.jmsMessageId,
          Boolean(message.failed)
        )
      )
    );

    return res.json({ message: "Messages moved successfully." });
  } catch (error) {
    console.error("jms-messages/move error:", error.response?.data || error.message);
    return res.status(500).json({
      message: "Failed to move JMS messages.",
      detail: error.response?.data || error.message
    });
  }
});

app.post("/jms-messages/retry", async (req, res) => {
  let { token, baseUrl, sourceQueueName, messages } = req.body || {};
  baseUrl = cleanUrl(baseUrl);

  if (!token || !baseUrl || !sourceQueueName || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      message: "token, baseUrl, sourceQueueName, and messages are required."
    });
  }

  try {
await Promise.all(
  messages.map((message) =>
    retryJmsMessageSimple(
      baseUrl,
      token,
      sourceQueueName,
      message.jmsMessageId,
      Boolean(message.failed)
    )
  )
);

    return res.json({ message: "Messages retried successfully." });
  } catch (error) {
    console.error("jms-messages/retry error:", error.response?.data || error.message);
    return res.status(500).json({
      message: "Failed to retry JMS messages.",
      detail: error.response?.data || error.message
    });
  }
});

app.post("/jms-messages/delete", async (req, res) => {
  let { token, baseUrl, sourceQueueName, messages } = req.body || {};
  baseUrl = cleanUrl(baseUrl);

  if (!token || !baseUrl || !sourceQueueName || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      message: "token, baseUrl, sourceQueueName, and messages are required."
    });
  }

  try {
    await Promise.all(
      messages.map((message) =>
        deleteJmsMessage(
          baseUrl,
          token,
          sourceQueueName,
          message.jmsMessageId,
          Boolean(message.failed)
        )
      )
    );

    return res.json({ message: "Messages deleted successfully." });
  } catch (error) {
    console.error("jms-messages/delete error:", error.response?.data || error.message);
    return res.status(500).json({
      message: "Failed to delete JMS messages.",
      detail: error.response?.data || error.message
    });
  }
});

app.post("/getMessages", async (req, res) => {
    let { token, baseUrl, status, artifactName, fromDate, toDate } = req.body;
    baseUrl = cleanUrl(baseUrl);

    try {
        const params = new URLSearchParams();

        if (status && status !== "All") {
            params.append("$filter", `Status eq '${status}'`);
        }

        params.append("$orderby", "LogStart desc");
        params.append("$top", "200");

        const url = `${baseUrl}/api/v1/MessageProcessingLogs?${params.toString()}`;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json"
            }
        });

        let messages = response.data.d.results;
        if (artifactName && artifactName !== "All") {
            messages = messages.filter(msg => msg.IntegrationFlowName === artifactName);
        }
        if (fromDate && toDate) {
            const fromMs = new Date(fromDate).getTime();
            const toMs   = new Date(toDate).getTime();

            messages = messages.filter(msg => {
                const logMs = parseSapDate(msg.LogStart);
                if (logMs === null) return false;
                return logMs >= fromMs && logMs <= toMs;
            });
        }

        res.json({ messages });

    } catch (error) {
        console.error("getMessages error:", error.response?.data || error.message);
        res.status(500).json({
            message: "Failed to fetch messages",
            detail: error.response?.data || error.message
        });
    }
});


async function getAccessToken() {
    if (!TOKEN_URL || !CLIENT_ID || !CLIENT_SECRET) {
        throw new Error("OAuth configuration is incomplete");
    }
    const tokenResponse = await axios.post(
        TOKEN_URL,
        "grant_type=client_credentials",
        {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            auth: { username: CLIENT_ID, password: CLIENT_SECRET }
        }
    );
    return tokenResponse.data.access_token;
}

let cpiMessages = [];

app.post("/cpi-data", (req, res) => {
    const payload = req.body;
    const message = {
        timestamp: new Date().toISOString(),
        content: payload
    };
    cpiMessages.push(message);
    console.log("\nCPI DATA RECEIVED");
    console.log(payload);
    res.status(200).send("CPI data received");
});

app.get("/cpi-data", (req, res) => {
    if (cpiMessages.length === 0) {
        return res.send("No CPI data received yet.");
    }
    const formattedData = cpiMessages
        .map(
            (msg) =>
                `Timestamp: ${msg.timestamp}\n${msg.content}`
        )
        .join("\n\n----------------------------------\n\n");
    res.setHeader("Content-Type", "text/plain");
    res.send(formattedData);
});

app.post("/trigger-cpi", async (req, res) => {
    if (!CPI_TRIGGER_ENDPOINT) {
        return res.status(500).json({ message: "CPI trigger endpoint not configured." });
    }
    try {
        const missingTriggerEnv = getMissingEnv(["TRIGGER_CLIENT_ID", "TRIGGER_CLIENT_SECRET"]).filter(
            (key) => !process.env[key] && !process.env[key.replace("TRIGGER_", "IFLOW_")] && !process.env[key.replace("TRIGGER_", "")]
        );
        const credentials = getTriggerCredentials();

        if (!credentials) {
            return res.status(500).json({
                message: missingTriggerEnv.length
                    ? `CPI client credentials not configured. Missing: ${missingTriggerEnv.join(", ")}`
                    : "CPI client credentials not configured."
            });
        }

        const response = await axios.post(CPI_TRIGGER_ENDPOINT, req.body, {
            headers: {
                Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`,
                "Content-Type": "application/json"
            },
            timeout: 120000,
            validateStatus: () => true
        });

        const payload = typeof response.data === "string"?response.data:JSON.stringify(response.data, null, 2);

        console.log("trigger-cpi status:", response.status);
        console.log("trigger-cpi payload:", req.body);
        return res.status(response.status).send(payload);
    } catch (err) {
        console.error("trigger-cpi error:", err.response?.data || err.message);
        const errorPayload = typeof err.response?.data==="string"?err.response.data:JSON.stringify(err.response?.data || err.message, null, 2);
        res.setHeader("Content-Type", "text/plain");
        return res.status(500).send(errorPayload);
    }
});

app.post("/post-selection", async (req, res) => {
    const { iflowName, status, fromDate, toDate } = req.body;

    if (!iflowName || !status || !fromDate || !toDate) {
        return res.status(400).json({
            message: "iflowName, status, fromDate, and toDate are required."
        });
    }
    if (!CPI_TRIGGER_ENDPOINT) {
        return res.status(500).json({ message: "CPI trigger endpoint not configured." });
    }
    try {
        const accessToken = await getAccessToken();
        const payload = {
            iflowName,
            status,
            fromDate,
            toDate
        };
        const response = await axios.post(CPI_TRIGGER_ENDPOINT, payload, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            validateStatus: () => true
        });
        return res.status(response.status).json({
            message: "Posted to CPI successfully.",
            payload,
            response: response.data
        });
    } catch (error) {
        console.error("post-selection error:", error.response?.data || error.message);
        return res.status(500).json({
            message: "Failed to post selection to CPI.",
            detail: error.response?.data || error.message
        });
    }
});

app.get("/latest-report", async (req, res) => {
  let conn;
  try {
    conn = getConnection();
    const reports = getReportRows(conn);
    if (!reports.length) {
      return res.json({ reports: [] });
    }
    res.json({ reports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.disconnect();
  }
});

app.get("/payload-file", async (req, res) => {
  const { mplId, logStart, attachmentTimestamp } = req.query;
  if (!mplId || !logStart || !attachmentTimestamp) {
    return res.status(400).json({ message: "mplId, logStart, attachmentTimestamp are required." });
  }

  let conn;
  try {
    conn = getConnection();
    const row = getPayloadRow(conn, mplId, logStart, attachmentTimestamp);
    if (!row) {
      return res.status(404).json({ message: "Payload not found." });
    }

    const decoded = decodePayload(row.PAYLOAD);
    const filename = formatFileName(row.PAYLOAD_FILE_NAME, row.PAYLOAD_FILE_TYPE, `payload-${mplId}`);
    res.setHeader("Content-Type", row.PAYLOAD_MIME_TYPE || "text/plain");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    return res.send(decoded);
  } catch (err) {
    return res.status(500).json({ message: "Failed to load payload.", detail: err.message });
  } finally {
    if (conn) conn.disconnect();
  }
});

app.get("/export-reports-excel", async (req, res) => {
  let conn;
  try {
    conn = getConnection();
    const reports = getReportRows(conn);
    if (!reports.length) {
      return res.status(404).json({ message: "No report data available." });
    }

    const buffer = await createReportsExcelBuffer(reports);
    const fileName = `${reports[0]?.iflowName || "Monitoring_Overview"}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({ message: "Failed to export Excel.", detail: err.message });
  } finally {
    if (conn) conn.disconnect();
  }
});

app.post("/send-excel-email", async (req, res) => {
  const { from, to, subject } = req.body || {};

  if (!to) {
    return res.status(400).json({ message: "Recipient address is required." });
  }

  let conn;
  try {
    conn = getConnection();
    const reports = getReportRows(conn);
    if (!reports.length) {
      return res.status(404).json({ message: "No report data available." });
    }

    const buffer = await createReportsExcelBuffer(reports);
    const fileName = `${reports[0]?.iflowName || "Monitoring_Overview"}.xlsx`;
    const mailSubject = subject || `Monitoring Overview of ${reports[0]?.iflowName || "Iflow"}`;

    const transporter = createMailTransport();
    await transporter.sendMail({
      from: from || SMTP_FROM,
      to,
      subject: mailSubject,
      text: "Please find the monitoring overview attached.",
      attachments: [
        {
          filename: fileName,
          content: buffer,
          contentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }
      ]
    });

    return res.json({ message: "Email sent successfully." });
  } catch (err) {
    return res.status(500).json({
      message: "Failed to send email.",
      detail: err.message
    });
  } finally {
    if (conn) conn.disconnect();
  }
});

app.get("/download-reports-zip", async (req, res) => {
  let conn;
  try {
    conn = getConnection();
    const reports = getReportRows(conn);

    if (!reports.length) {
      return res.status(404).json({ message: "No payload files found to download." });
    }

    const { zipBuffer, zipFileName } = await createReportsZip(reports);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFileName}"`);
    res.send(zipBuffer);
  } catch (err) {
    res.status(500).json({ error: typeof err === "string" ? err : err.message });
  } finally {
    if (conn) conn.disconnect();
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
