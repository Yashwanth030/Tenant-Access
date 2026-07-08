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
const crypto = require("crypto");
const mcpTenantStore = new Map();
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
const BASE_URL = process.env.BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.AI_INTENT_API_KEY;
const AI_INTENT_MODEL = process.env.AI_INTENT_MODEL || "openrouter/auto";
const AI_INTENT_ENDPOINT =
  process.env.AI_INTENT_ENDPOINT ||
  (AI_INTENT_MODEL.includes("/")
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions");
const AI_INTENT_APP_URL = process.env.AI_INTENT_APP_URL || "http://localhost:5173";
const AI_INTENT_APP_NAME = process.env.AI_INTENT_APP_NAME || "Tenant Access";

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

    // Standard Cloud Foundry -rt mappings
    if (cleanedBaseUrl.includes("-rt.cfapps.")) {
        candidates.push(cleanedBaseUrl.replace("-rt.cfapps.", ".cfapps."));
    } else if (cleanedBaseUrl.includes(".cfapps.")) {
        candidates.push(cleanedBaseUrl.replace(".cfapps.", "-rt.cfapps."));
    }

    // Integration Suite specific -rt.integrationsuite mappings
    // Handles conversion between it-cpi001, integrationsuite and their runtime -rt hosts
    const match = cleanedBaseUrl.match(/https?:\/\/([^.]+)\.(it-cpi001|integrationsuite)(-rt)?\.cfapps\.(.+)$/i);
    if (match) {
        const subdomain = match[1];
        const regionDomain = match[4];
        const cleanSub = subdomain.endsWith("-rt") ? subdomain.slice(0, -3) : subdomain;
        
        candidates.push(`https://${cleanSub}.it-cpi001.cfapps.${regionDomain}`);
        candidates.push(`https://${cleanSub}-rt.it-cpi001.cfapps.${regionDomain}`);
        candidates.push(`https://${cleanSub}.integrationsuite.cfapps.${regionDomain}`);
        candidates.push(`https://${cleanSub}-rt.integrationsuite.cfapps.${regionDomain}`);
    }

    return [...new Set(candidates)];
};

const tenantHeaders = (token) => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest"
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
  const baseCandidates = buildBaseUrlCandidates(baseUrl);
  const candidates = baseCandidates.flatMap(url => [
    `${url}/api/v1`,
    url.includes("integrationsuite") ? `${url.replace("integrationsuite", "integrationsuite-trial")}/api/v1` : null
  ]).filter(Boolean);
  return [...new Set(candidates)];
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

    if (hostnameParts.length > 2) {
      if (hostnameParts[1] !== "integrationsuite") {
        const integrationSuiteParts = [...hostnameParts];
        integrationSuiteParts[1] = "integrationsuite";
        candidates.push(`${url.protocol}//${integrationSuiteParts.join(".")}/api/v1`);
      }
      if (hostnameParts[1] !== "integrationsuite-trial") {
        const integrationSuiteParts = [...hostnameParts];
        integrationSuiteParts[1] = "integrationsuite-trial";
        candidates.push(`${url.protocol}//${integrationSuiteParts.join(".")}/api/v1`);
      }
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
    let { clientId, clientSecret, tokenUrl, baseUrl, mcpToken } = req.body;

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

        const finalToken = mcpToken || crypto.randomBytes(24).toString("hex");
        mcpTenantStore.set(finalToken, {
            clientId,
            clientSecret,
            tokenUrl,
            baseUrl: apiBaseUrl,
            accessToken: token,
            packages: packages || [],
            lastRefreshed: Date.now()
        });

        let host = req.headers["x-forwarded-host"] || req.get("host") || "localhost:5000";
        if (req.headers.referer && host.includes("localhost")) {
            try {
                const refUrl = new URL(req.headers.referer);
                host = refUrl.host;
            } catch (e) {}
        }
        const mcpHost = host.replace(/port\d+/, "port5001");
        const protocol = host.includes("-workspaces-ws-") ? "https" : req.protocol;
        const mcpServerUrl = `${protocol}://${mcpHost}/sse?token=${finalToken}`;

        res.json({
            message: "Tenant Connected Successfully",
            packages,
            token: token,
            credentialSource: "tenant-session",
            baseUrl: apiBaseUrl,
            mcpToken: finalToken,
            mcpServerUrl
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

const refreshTenantToken = async (tenantConfig) => {
    const tokenEndpoint = tenantConfig.tokenUrl.endsWith("/oauth/token")
        ? tenantConfig.tokenUrl
        : `${tenantConfig.tokenUrl}/oauth/token`;

    const tokenResponse = await axios.post(
        tokenEndpoint,
        "grant_type=client_credentials",
        {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            auth: { username: tenantConfig.clientId, password: tenantConfig.clientSecret }
        }
    );

    tenantConfig.accessToken = tokenResponse.data.access_token;
    tenantConfig.lastRefreshed = Date.now();
    return tenantConfig.accessToken;
};

app.get("/mcp/tenant-context", async (req, res) => {
    const { token } = req.query;
    if (!token) {
        return res.status(400).json({ error: "Token is required." });
    }

    const tenantConfig = mcpTenantStore.get(token);
    if (!tenantConfig) {
        return res.status(404).json({ error: "Invalid token or tenant context not found." });
    }

    try {
        // Refresh token if it is older than 45 minutes
        if (Date.now() - tenantConfig.lastRefreshed > 45 * 60 * 1000) {
            await refreshTenantToken(tenantConfig);
        }

        res.json({
            token: tenantConfig.accessToken,
            baseUrl: tenantConfig.baseUrl,
            packages: tenantConfig.packages || []
        });
    } catch (err) {
        console.error("Error refreshing MCP tenant token:", err.message);
        // Fallback to cached token
        res.json({
            token: tenantConfig.accessToken,
            baseUrl: tenantConfig.baseUrl,
            packages: tenantConfig.packages || []
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

const sapDateToMs = (value) => {
  if (!value) {
    return 0;
  }

  if (typeof value === "number") {
    return value;
  }

  const text = String(value).trim();
  const sapMs = parseSapDate(text);
  if (sapMs) {
    return sapMs;
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
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

const isProblemJmsQueue = (queue) => {
  const name = String(queue.name || queue.key || "").toLowerCase();
  const state = String(queue.state || "").toLowerCase();
  const usage = String(queue.usage || "").toLowerCase();
  const accessType = String(queue.accessType || "").toLowerCase();

  return (
    /\b(dlq|dead|failed|failure|error|exception)\b/i.test(name) ||
    name.includes("_dlq") ||
    name.includes("-dlq") ||
    state.includes("fail") ||
    state.includes("error") ||
    state.includes("stopped") ||
    usage.includes("fail") ||
    usage.includes("error") ||
    usage.includes("stopped") ||
    accessType.includes("error")
  );
};

const filterProblemJmsQueues = (queues) => queues.filter(isProblemJmsQueue);

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
  const baseCandidates = buildBaseUrlCandidates(baseUrl);
  return baseCandidates.map(url => `${url}/api/v1`);
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

const decodeJmsMessageId = (id) => {
  const idStr = String(id || "").trim();
  if (idStr.startsWith("x-hex-")) {
    try {
      return Buffer.from(idStr.substring(6), "hex").toString("utf-8");
    } catch (e) {
      console.warn("Failed to decode hex JMS Message ID:", e.message);
    }
  }
  return idStr;
};

const moveJmsMessageDirect = async (baseUrl, token, sourceQueueName, targetQueueName, jmsMessageId) => {
  const candidates = buildMoveApiCandidates(baseUrl);
  const cleanId = decodeJmsMessageId(jmsMessageId);
  const selector = `JMSMessageID='${cleanId}'`;
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
  const cleanId = decodeJmsMessageId(jmsMessageId);
  const selector = `JMSMessageID='${cleanId}'`;
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
    "Content-Type: application/json",
    "Content-Length: 2",
    `x-csrf-token: ${csrfToken}`,
    "",
    "{}",
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

const normalizePrompt = (value) => String(value || "").trim();

const TENANT_CHAT_TOOLS = {
  get_monitoring_overview: {
    label: "Monitoring overview",
    category: "monitoring",
    mode: "live-or-saved",
    method: "GET",
    resources: ["MessageProcessingLogs", "HANA CPI_DATA"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Summarizes the same monitoring data shown in the Monitoring Overview UI."
  },
  get_monitoring_logs: {
    label: "Message processing logs",
    category: "monitoring",
    mode: "live-or-saved",
    method: "GET",
    resources: ["MessageProcessingLogs"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Fetches tenant message logs with status, time-range, and list/count output."
  },
  export_monitoring_excel: {
    label: "Monitoring Excel export",
    category: "monitoring",
    mode: "saved-report",
    method: "GET",
    resources: ["HANA CPI_DATA"],
    auth: "app-backend",
    csrf: false,
    description: "Creates the Excel export for the latest saved monitoring report."
  },
  download_payload_zip: {
    label: "Payload ZIP export",
    category: "monitoring",
    mode: "saved-report",
    method: "GET",
    resources: ["HANA CPI_DATA"],
    auth: "app-backend",
    csrf: false,
    description: "Creates a ZIP of saved payload files."
  },
  send_monitoring_email: {
    label: "Email monitoring report",
    category: "monitoring",
    mode: "saved-report",
    method: "POST",
    resources: ["HANA CPI_DATA", "SMTP"],
    auth: "app-backend",
    csrf: false,
    description: "Sends the saved monitoring Excel report to a recipient."
  },
  list_packages: {
    label: "Integration packages",
    category: "integration-content",
    mode: "live",
    method: "GET",
    resources: ["IntegrationPackages"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists packages from the connected tenant."
  },
  list_artifacts: {
    label: "Integration artifacts",
    category: "integration-content",
    mode: "live",
    method: "GET",
    resources: ["IntegrationPackages/IntegrationDesigntimeArtifacts"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists artifacts for one package or all packages from the connected tenant."
  },
  list_jms_queues: {
    label: "JMS queues",
    category: "jms",
    mode: "live",
    method: "GET",
    resources: ["Queues"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists JMS queues from the connected tenant."
  },
  list_jms_messages: {
    label: "JMS queue messages",
    category: "jms",
    mode: "live",
    method: "GET",
    resources: ["Queues/Messages"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists messages for a selected JMS queue."
  },
  get_jms_resources: {
    label: "JMS broker resources",
    category: "jms",
    mode: "live",
    method: "GET",
    resources: ["JmsBrokers"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Reads JMS broker queue and capacity usage."
  },
  move_jms_message: {
    label: "Move JMS message",
    category: "jms",
    mode: "live-action",
    method: "PATCH/POST batch",
    resources: ["Queues", "JmsMessages"],
    auth: "tenant-bearer-token",
    csrf: true,
    description: "Moves a JMS message between queues using tenant CSRF-protected calls."
  },
  retry_jms_message: {
    label: "Retry JMS message",
    category: "jms",
    mode: "live-action",
    method: "PATCH/MERGE/POST batch",
    resources: ["Queues", "JmsMessages"],
    auth: "tenant-bearer-token",
    csrf: true,
    description: "Retries a failed JMS message using tenant CSRF-protected calls."
  },
  delete_jms_message: {
    label: "Delete JMS message",
    category: "jms",
    mode: "live-action",
    method: "DELETE",
    resources: ["JmsMessages"],
    auth: "tenant-bearer-token",
    csrf: true,
    description: "Deletes a JMS message from the connected tenant."
  },
  trigger_cpi_flow: {
    label: "Trigger CPI flow",
    category: "cpi-trigger",
    mode: "live-action",
    method: "POST",
    resources: ["Configured CPI trigger endpoint"],
    auth: "trigger-client-credentials",
    csrf: false,
    description: "Guides CPI trigger requests through the existing Monitoring Overview flow."
  },
  get_pgp_keys: {
    label: "PGP public keys",
    category: "security",
    mode: "live",
    method: "GET",
    resources: ["PgpKeyEntries"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists PGP keys from the connected tenant."
  },
  get_security_materials: {
    label: "Security materials",
    category: "security",
    mode: "live",
    method: "GET",
    resources: ["UserCredentials", "OAuth2ClientCredentials", "SecureParameters"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists security materials from the connected tenant."
  },
  get_keystores: {
    label: "Keystores and certificates",
    category: "security",
    mode: "live",
    method: "GET",
    resources: ["KeystoreEntries"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists keystore entries and certificates from the connected tenant."
  },
  get_access_policies: {
    label: "Access policies",
    category: "security",
    mode: "live",
    method: "GET",
    resources: ["AccessPolicies"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists access policies from the connected tenant."
  },
  get_user_roles: {
    label: "User roles",
    category: "security",
    mode: "live",
    method: "GET",
    resources: ["UserRoles"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists user roles from the connected tenant."
  },
  get_data_stores: {
    label: "Data stores",
    category: "operations",
    mode: "live",
    method: "GET",
    resources: ["DataStores"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists data stores from the connected tenant."
  },
  get_variables: {
    label: "Variables",
    category: "operations",
    mode: "live",
    method: "GET",
    resources: ["Variables"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists variables from the connected tenant."
  },
  get_number_ranges: {
    label: "Number ranges",
    category: "operations",
    mode: "live",
    method: "GET",
    resources: ["NumberRanges"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists number ranges from the connected tenant."
  },
  get_partner_directory: {
    label: "Partner directory",
    category: "operations",
    mode: "live",
    method: "GET",
    resources: ["PartnerDirectoryEntries"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists partner directory entries from the connected tenant."
  },
  get_message_locks: {
    label: "Message locks",
    category: "operations",
    mode: "live",
    method: "GET",
    resources: ["MessageLocks"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists message locks from the connected tenant."
  },
  get_system_logs: {
    label: "System log files",
    category: "operations",
    mode: "live",
    method: "GET",
    resources: ["SystemLogFiles"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists system log files from the connected tenant."
  },
  get_usage_details: {
    label: "Usage details",
    category: "operations",
    mode: "live",
    method: "GET",
    resources: ["UsageDetails"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists usage details from the connected tenant."
  },
  get_connectivity_tests: {
    label: "Connectivity tests",
    category: "connectivity",
    mode: "live",
    method: "GET",
    resources: ["ConnectivityTests"],
    auth: "tenant-bearer-token",
    csrf: false,
    description: "Lists connectivity test endpoints from the connected tenant."
  }
};

const getTenantIdFromBaseUrl = (baseUrl) => {
  const cleanedBaseUrl = cleanUrl(baseUrl);

  if (!cleanedBaseUrl) {
    return "";
  }

  try {
    return new URL(cleanedBaseUrl).hostname.toLowerCase();
  } catch {
    return cleanedBaseUrl.toLowerCase();
  }
};

const createChatbotTenantContext = ({ token, baseUrl, packages }) => {
  const cleanedBaseUrl = cleanUrl(baseUrl) || BASE_URL;

  return {
    token,
    baseUrl: cleanedBaseUrl,
    tenantId: getTenantIdFromBaseUrl(cleanedBaseUrl),
    packages: Array.isArray(packages) ? packages : [],
    hasTenantConnection: Boolean(token && cleanedBaseUrl)
  };
};

const hasAnyTerm = (text, terms) => terms.some((term) => text.includes(term));

const classifyChatbotIntent = (prompt) => {
  const text = normalizePrompt(prompt);
  const normalized = text.toLowerCase();

  const parseDateToYmd = (dateStr) => {
    if (!dateStr) return "";
    const cleanStr = String(dateStr).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleanStr)) {
      return cleanStr;
    }
    const dMmmY = cleanStr.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,10})[-/\s](\d{4})$/);
    if (dMmmY) {
      const day = String(dMmmY[1]).padStart(2, "0");
      const monthStr = dMmmY[2].toLowerCase().substring(0, 3);
      const year = dMmmY[3];
      const months = {
        jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
        jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
      };
      const month = months[monthStr];
      if (month) {
        return `${year}-${month}-${day}`;
      }
    }
    try {
      const d = new Date(cleanStr);
      if (!isNaN(d.getTime())) {
        const pad = (val) => String(val).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      }
    } catch {}
    return "";
  };

  const isDirectB = 
    /^(?:Option\s+)?B$/i.test(normalized) || 
    /\b(?:run|trigger|export|download|test)\s+(?:Option\s+)?B\b/i.test(normalized) ||
    /B\s+that\s+also\s+in\s+chatbot/i.test(normalized);

  if (isDirectB) {
    return {
      tool: "export_monitoring_excel",
      confidence: 1.0,
      reason: "option-b-direct-keyword",
      prompt: text,
      filters: {
        packageName: "Siva_Demo",
        iflowName: "SAMPLE_TEST_2",
        status: "COMPLETED",
        range: "Custom",
        fromDate: "2026-02-01",
        toDate: "2026-06-01"
      }
    };
  }

  // Match Option B structure: "Siva_Demo / SAMPLE_TEST_2 / 1-Feb-2026 to 1-Jun-2026 / COMPLETED"
  const optionBMatch = text.match(/(?:Option\s+B:?)?\s*([a-zA-Z0-9_.-]+)\s*\/\s*([a-zA-Z0-9_.-]+)\s*\/\s*([^/]+?)\s*\/\s*([a-zA-Z0-9_-]+)/i);
  if (optionBMatch) {
    const packageName = optionBMatch[1].trim();
    const iflowName = optionBMatch[2].trim();
    const rangeRaw = optionBMatch[3].trim();
    const status = optionBMatch[4].trim();

    let fromDate = "";
    let toDate = "";
    const rangeParts = rangeRaw.split(/\s+to\s+|\s+-\s+/i);
    if (rangeParts.length === 2) {
      fromDate = parseDateToYmd(rangeParts[0].trim());
      toDate = parseDateToYmd(rangeParts[1].trim());
    }

    return {
      tool: "export_monitoring_excel",
      confidence: 1.0,
      reason: "option-b-direct-match",
      prompt: text,
      filters: {
        packageName,
        iflowName,
        status,
        range: "Custom",
        fromDate,
        toDate
      }
    };
  }
  const wantsExport = hasAnyTerm(normalized, ["download", "export", "excel", "zip"]);
  const wantsPayload = hasAnyTerm(normalized, ["payload", "attachment"]);
  const wantsEmail = hasAnyTerm(normalized, ["email", "mail", "send report"]);
  const wantsOverview =
    hasAnyTerm(normalized, ["what all", "what data", "available data", "overview", "dashboard", "interface"]) &&
    hasAnyTerm(normalized, ["monitor", "message", "data", "field", "column", "show"]);

  if (!text) {
    return { tool: "unsupported", confidence: 0, reason: "empty-prompt", prompt: text };
  }

  if (hasAnyTerm(normalized, ["pgp", "pgp key", "pgp keys"])) {
    return { tool: "get_pgp_keys", confidence: 0.95, reason: "pgp-key-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["security material", "security materials", "user credentials", "oauth credentials"])) {
    return { tool: "get_security_materials", confidence: 0.95, reason: "security-material-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["keystore", "keystores", "certificate", "certificates", "keystore entries"])) {
    return { tool: "get_keystores", confidence: 0.95, reason: "keystore-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["access policy", "access policies", "authorization groups"])) {
    return { tool: "get_access_policies", confidence: 0.95, reason: "access-policy-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["user role", "user roles"])) {
    return { tool: "get_user_roles", confidence: 0.95, reason: "user-role-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["data store", "data stores", "datastore", "datastores"])) {
    return { tool: "get_data_stores", confidence: 0.95, reason: "data-store-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["variable", "variables"])) {
    return { tool: "get_variables", confidence: 0.95, reason: "variable-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["number range", "number ranges"])) {
    return { tool: "get_number_ranges", confidence: 0.95, reason: "number-range-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["partner directory", "partners", "partner entries"])) {
    return { tool: "get_partner_directory", confidence: 0.95, reason: "partner-directory-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["message lock", "message locks", "locks"])) {
    return { tool: "get_message_locks", confidence: 0.95, reason: "message-lock-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["system log", "system logs", "log files"])) {
    return { tool: "get_system_logs", confidence: 0.95, reason: "system-log-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["usage details", "usage", "message statistics", "statistics"])) {
    return { tool: "get_usage_details", confidence: 0.95, reason: "usage-detail-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["connectivity test", "connectivity tests", "endpoints", "connectivity"])) {
    return { tool: "get_connectivity_tests", confidence: 0.95, reason: "connectivity-test-request", prompt: text };
  }

  if (wantsEmail) {
    return { tool: "send_monitoring_email", confidence: 0.92, reason: "email-report-request", prompt: text };
  }

  if (wantsExport && hasAnyTerm(normalized, ["excel", "report"])) {
    return { tool: "export_monitoring_excel", confidence: 0.94, reason: "excel-export-request", prompt: text };
  }

  if (wantsExport && (wantsPayload || normalized.includes("zip"))) {
    return { tool: "download_payload_zip", confidence: 0.94, reason: "payload-export-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["jms", "queue", "broker", "retry", "delete", "move"])) {
    if (hasAnyTerm(normalized, ["move"])) {
      return { tool: "move_jms_message", confidence: 0.9, reason: "jms-move-request", prompt: text };
    }

    if (hasAnyTerm(normalized, ["retry"])) {
      return { tool: "retry_jms_message", confidence: 0.9, reason: "jms-retry-request", prompt: text };
    }

    if (hasAnyTerm(normalized, ["delete", "remove"])) {
      return { tool: "delete_jms_message", confidence: 0.9, reason: "jms-delete-request", prompt: text };
    }

    if (hasAnyTerm(normalized, ["resource", "capacity", "usage", "broker"])) {
      return { tool: "get_jms_resources", confidence: 0.88, reason: "jms-resource-request", prompt: text };
    }

    if (hasAnyTerm(normalized, ["message", "messages"]) && !normalized.includes("queues")) {
      return { tool: "list_jms_messages", confidence: 0.82, reason: "jms-message-request", prompt: text };
    }

    return { tool: "list_jms_queues", confidence: 0.86, reason: "jms-queue-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["artifact", "artifacts", "iflow"])) {
    if (hasAnyTerm(normalized, ["trigger", "run", "execute"])) {
      return { tool: "trigger_cpi_flow", confidence: 0.78, reason: "cpi-trigger-request", prompt: text };
    }

    return { tool: "list_artifacts", confidence: 0.86, reason: "artifact-request", prompt: text };
  }

  if (hasAnyTerm(normalized, ["package", "packages"])) {
    return { tool: "list_packages", confidence: 0.86, reason: "package-request", prompt: text };
  }

  if (
    wantsOverview ||
    hasAnyTerm(normalized, ["monitoring", "monitor", "status", "failed", "failure", "error", "completed", "processing", "message", "messages", "report", "reports", "payload"])
  ) {
    return {
      tool: wantsOverview ? "get_monitoring_overview" : "get_monitoring_logs",
      confidence: wantsOverview ? 0.88 : 0.82,
      reason: wantsOverview ? "monitoring-overview-request" : "monitoring-log-request",
      prompt: text
    };
  }

  return { tool: "unsupported", confidence: 0.1, reason: "no-supported-tool", prompt: text };
};

const CHATBOT_INTENT_SCHEMA = {
  tool: Object.keys(TENANT_CHAT_TOOLS).concat("unsupported"),
  filters: {
    status: ["FAILED", "COMPLETED", "PROCESSING", "RETRY", "ANY"],
    health: ["failed", "error", "stopped", "dlq", "any"],
    range: ["past hour", "today", "past day", "past week", "custom", ""],
    packageName: "string",
    queueName: "string",
    messageId: "string",
    sourceQueue: "string",
    targetQueue: "string",
    email: "string",
    exportType: ["excel", "payload_zip", ""]
  },
  output: ["summary", "list", "count", "searchable_select", "download", "action", "clarification"]
};

const buildAiToolListForPrompt = () =>
  Object.entries(TENANT_CHAT_TOOLS).map(([name, tool]) => ({
    name,
    category: tool.category,
    mode: tool.mode,
    csrf: tool.csrf,
    description: tool.description
  }));

const extractJsonObject = (value) => {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
};

const normalizeAiIntentTool = (tool) => {
  const cleanTool = String(tool || "").trim();
  return TENANT_CHAT_TOOLS[cleanTool] || cleanTool === "unsupported" ? cleanTool : "unsupported";
};

const normalizeAiFilters = (filters) => {
  const input = filters && typeof filters === "object" ? filters : {};

  return {
    status: firstNonEmpty(input.status, input.messageStatus, input.monitoringStatus, ""),
    health: firstNonEmpty(input.health, input.queueHealth, ""),
    range: firstNonEmpty(input.range, input.timeRange, ""),
    packageName: firstNonEmpty(input.packageName, input.packageId, input.package, ""),
    queueName: firstNonEmpty(input.queueName, input.queue, ""),
    messageId: firstNonEmpty(input.messageId, input.jmsMessageId, input.mplId, ""),
    sourceQueue: firstNonEmpty(input.sourceQueue, input.fromQueue, ""),
    targetQueue: firstNonEmpty(input.targetQueue, input.toQueue, ""),
    email: firstNonEmpty(input.email, input.to, input.recipient, ""),
    exportType: firstNonEmpty(input.exportType, input.downloadType, "")
  };
};

const validateAiIntent = (candidate, originalPrompt) => {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const tool = normalizeAiIntentTool(candidate.tool);
  const output = CHATBOT_INTENT_SCHEMA.output.includes(candidate.output) ? candidate.output : "";
  const confidence = Number(candidate.confidence);

  return {
    tool,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.6,
    reason: firstNonEmpty(candidate.reason, candidate.intent, "ai-intent"),
    prompt: normalizePrompt(originalPrompt),
    filters: normalizeAiFilters(candidate.filters),
    output,
    needsClarification: Boolean(candidate.needsClarification),
    clarification: firstNonEmpty(candidate.clarification, candidate.question, "")
  };
};

const getDynamicExamplesForAi = async () => {
  // Return static examples - dynamic fetching can be added later
  // For now, use reliable examples that work with the rule-based fallback
  return {
    examples: [
      {
        prompt: "show artifacts inside a package",
        result: {
          tool: "list_artifacts",
          filters: { packageName: "packages" },
          output: "searchable_select",
          confidence: 0.95
        }
      },
      {
        prompt: "List out all the JMS Queues which has failed",
        result: {
          tool: "list_jms_queues",
          filters: { health: "failed" },
          output: "list",
          confidence: 0.95
        }
      },
      {
        prompt: "show failed messages today",
        result: {
          tool: "get_monitoring_logs",
          filters: { status: "FAILED", range: "today" },
          output: "list",
          confidence: 0.95
        }
      }
    ]
  };
};

const analyzePromptWithAi = async ({ prompt }) => {
  if (!OPENAI_API_KEY) {
    return null;
  }

  const cleanPrompt = normalizePrompt(prompt);
  if (!cleanPrompt) {
    return null;
  }

  try {
    // First, try to classify with rule-based system for task queries
    const fallbackIntent = classifyChatbotIntent(prompt);
    
    // If rule-based system found a valid tool (not unsupported), use it
    if (fallbackIntent && fallbackIntent.tool !== "unsupported" && fallbackIntent.confidence > 0.6) {
      return fallbackIntent;
    }

    // For other queries, use natural language response
    const response = await axios.post(
      AI_INTENT_ENDPOINT,
      {
        model: AI_INTENT_MODEL,
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content:
              "You are a helpful SAP Integration Suite tenant assistant. Answer questions naturally and conversationally. " +
              "If the user asks about monitoring, errors, JMS queues, packages, artifacts, or integration suite features, provide helpful guidance. " +
              "You can help with: tenant errors, monitoring status, JMS queues, resources, packages, artifacts, payloads, exports, move/retry/delete operations. " +
              "Be friendly and concise. Never share sensitive credentials or secrets."
          },
          {
            role: "user",
            content: cleanPrompt
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          ...(AI_INTENT_ENDPOINT.includes("openrouter.ai")
            ? {
                "HTTP-Referer": AI_INTENT_APP_URL,
                "X-Title": AI_INTENT_APP_NAME
              }
            : {})
        },
        timeout: 15000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (content) {
      // Return the natural language response
      return {
        tool: "natural_response",
        message: content,
        confidence: 0.9
      };
    }
    return null;
  } catch (error) {
    console.warn("AI analysis failed:", error.response?.data || error.message);
    return null;
  }
};

const mergeIntentFallback = (aiIntent, fallbackIntent) => {
  // If AI has a natural response, use it directly
  if (aiIntent && aiIntent.tool === "natural_response" && aiIntent.message) {
    return aiIntent;
  }

  if (!aiIntent || aiIntent.tool === "unsupported" || aiIntent.confidence < 0.45) {
    return { ...fallbackIntent, source: "rules" };
  }

  return {
    ...fallbackIntent,
    ...aiIntent,
    prompt: fallbackIntent.prompt,
    source: "ai"
  };
};

const parseChatTimeRange = (prompt) => {
  const normalized = prompt.toLowerCase();
  const now = Date.now();
  const numberMatch = normalized.match(/(?:last|past)\s+(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks|month|months)/);

  if (numberMatch) {
    const amount = Number(numberMatch[1]);
    const unit = numberMatch[2];
    const multipliers = {
      minute: 60 * 1000,
      minutes: 60 * 1000,
      hour: 60 * 60 * 1000,
      hours: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
      months: 30 * 24 * 60 * 60 * 1000
    };

    return {
      label: `past ${amount} ${unit}`,
      fromMs: now - amount * multipliers[unit],
      toMs: now
    };
  }

  if (normalized.includes("past hour") || normalized.includes("last hour")) {
    return { label: "past hour", fromMs: now - 60 * 60 * 1000, toMs: now };
  }

  if (normalized.includes("today")) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { label: "today", fromMs: start.getTime(), toMs: now };
  }

  if (normalized.includes("last day") || normalized.includes("past day")) {
    return { label: "past day", fromMs: now - 24 * 60 * 60 * 1000, toMs: now };
  }

  if (normalized.includes("last week") || normalized.includes("past week")) {
    return { label: "past week", fromMs: now - 7 * 24 * 60 * 60 * 1000, toMs: now };
  }

  return null;
};

const reportTimeMs = (report) => sapDateToMs(report.logStart);

const filterReportsForPrompt = (reports, prompt) => {
  const normalized = prompt.toLowerCase();
  const range = parseChatTimeRange(prompt);
  let filtered = reports;

  if (range) {
    filtered = filtered.filter((report) => {
      const timeMs = reportTimeMs(report);
      return timeMs >= range.fromMs && timeMs <= range.toMs;
    });
  }

  if (normalized.includes("error") || normalized.includes("failed")) {
    filtered = filtered.filter((report) =>
      String(report.status || "").toLowerCase().includes("fail") ||
      String(report.errorInfo || "").trim().replace("-", "")
    );
  } else if (normalized.includes("completed")) {
    filtered = filtered.filter((report) => String(report.status || "").toUpperCase() === "COMPLETED");
  } else if (normalized.includes("processing")) {
    filtered = filtered.filter((report) => String(report.status || "").toUpperCase() === "PROCESSING");
  } else if (normalized.includes("retry")) {
    filtered = filtered.filter((report) => String(report.status || "").toUpperCase().includes("RETRY"));
  }

  return { filtered, range };
};

const toChatbotTextValue = (value, fallback = "") => {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toChatbotTextValue(entry)).filter(Boolean).join(", ") || fallback;
  }

  if (value.__deferred) {
    return fallback;
  }

  return toChatbotTextValue(value.Name || value.Id || value.Value || value.value || value.Message || value.message, fallback);
};

const firstTextValue = (...values) => {
  for (const value of values) {
    const text = toChatbotTextValue(value).trim();
    if (text) {
      return text;
    }
  }

  return "";
};

const mapTenantMonitoringLog = (message, index) => ({
  id: firstTextValue(message.MessageGuid, message.Id, message.MplId, `tenant-message-${index}`),
  mplId: firstTextValue(message.MessageGuid, message.MplId, message.Id),
  iflowName: firstTextValue(message.IntegrationFlowName, message.IntegrationArtifact?.Name),
  status: firstTextValue(message.Status, message.CustomStatus),
  logStart: formatSapTimestamp(message.LogStart),
  logStartMs: sapDateToMs(message.LogStart),
  logEnd: formatSapTimestamp(message.LogEnd),
  errorInfo: firstTextValue(
    message.ErrorInformation,
    message.ErrorMessage,
    message.ApplicationMessage,
    message.CustomStatus,
    "-"
  ),
  correlationId: firstTextValue(message.CorrelationId),
  payloadFileName: ""
});

const toODataDateTime = (timeMs) => {
  const date = new Date(timeMs);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};

const fetchTenantMonitoringLogs = async ({ baseUrl, token, prompt }) => {
  const normalized = prompt.toLowerCase();
  const range = parseChatTimeRange(prompt);
  const candidates = buildBaseUrlCandidates(baseUrl);
  let lastError;

  for (const candidate of candidates) {
    try {
      const params = new URLSearchParams();
      const filters = [];

      if (normalized.includes("error") || normalized.includes("failed")) {
        filters.push("Status eq 'FAILED'");
      } else if (normalized.includes("completed")) {
        filters.push("Status eq 'COMPLETED'");
      } else if (normalized.includes("processing")) {
        filters.push("Status eq 'PROCESSING'");
      } else if (normalized.includes("retry")) {
        filters.push("Status eq 'RETRY'");
      }

      if (range) {
        filters.push(`LogStart ge datetime'${toODataDateTime(range.fromMs)}'`);
        filters.push(`LogStart le datetime'${toODataDateTime(range.toMs)}'`);
      }

      if (filters.length > 0) {
        params.append("$filter", filters.join(" and "));
      }

      params.append("$orderby", "LogStart desc");
      params.append("$top", "1000");
      params.append("$inlinecount", "allpages");

      const response = await axios.get(`${candidate}/api/v1/MessageProcessingLogs?${params.toString()}`, {
        headers: tenantHeaders(token),
        timeout: 30000
      });

      let rows = unwrapODataResults(response.data).map(mapTenantMonitoringLog);
      const totalCount = Number(response.data?.d?.__count || rows.length);

      return { reports: rows, range, source: "tenant", totalCount };
    } catch (error) {
      lastError = error;
      if (error.response?.status === 404) {
        continue;
      }
    }
  }

  throw lastError || new Error("Unable to fetch tenant monitoring logs.");
};

const summarizeReports = (reports) => {
  const summary = reports.reduce((acc, report) => {
    const key = report.status || "UNKNOWN";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return Object.entries(summary)
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ") || "No reports";
};

const toChatItems = (rows, type, limit = 10) =>
  rows.slice(0, limit).map((row) => ({ type, ...row }));

const toSearchableChatItems = (rows, type, limit = 500) =>
  rows.slice(0, limit).map((row) => ({ type, ...row }));

const extractQuotedValue = (prompt, key) => {
  const regex = new RegExp(`${key}\\s+["']([^"']+)["']`, "i");
  return prompt.match(regex)?.[1] || "";
};

const extractAfterKeyword = (prompt, key) => {
  const regex = new RegExp(`${key}\\s+([^,]+)`, "i");
  return prompt.match(regex)?.[1]?.trim() || "";
};

const normalizePackageLookup = (value) =>
  String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

const cleanPackageCandidate = (value) =>
  String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+(package|artifacts?|iflow|i-flow)$/i, "")
    .trim();

const extractPackageNameFromArtifactPrompt = (prompt) => {
  const text = String(prompt || "").trim();
  const patterns = [
    /\binside\s+["']?(.+?)["']?\s+package\b/i,
    /\bin\s+["']?(.+?)["']?\s+package\b/i,
    /\bfrom\s+["']?(.+?)["']?\s+package\b/i,
    /\bfor\s+["']?(.+?)["']?\s+package\b/i,
    /\bpackage\s+["']?(.+?)["']?(?:\s+(?:package|artifacts?|iflow|i-flow))?$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const candidate = cleanPackageCandidate(match[1]);
      if (candidate && !/^(all|the|this|that)$/i.test(candidate)) {
        return candidate;
      }
    }
  }

  return cleanPackageCandidate(extractQuotedValue(text, "package") || extractAfterKeyword(text, "package"));
};

const resolvePackageForPrompt = (prompt, packages = []) => {
  const requestedPackage = extractPackageNameFromArtifactPrompt(prompt);

  if (!requestedPackage || /^all$/i.test(requestedPackage)) {
    return { packageId: "All", requestedPackage: requestedPackage || "All", matches: [] };
  }

  const normalizedRequest = normalizePackageLookup(requestedPackage);
  const candidates = packages
    .map((pkg) => ({
      pkg,
      id: String(pkg.Id || "").trim(),
      name: String(pkg.Name || "").trim()
    }))
    .filter((entry) => entry.id || entry.name);

  const exactMatch = candidates.find(
    (entry) =>
      normalizePackageLookup(entry.id) === normalizedRequest ||
      normalizePackageLookup(entry.name) === normalizedRequest
  );

  if (exactMatch) {
    return {
      packageId: exactMatch.id || exactMatch.name,
      requestedPackage,
      matches: [exactMatch.pkg]
    };
  }

  const fuzzyMatches = candidates.filter((entry) => {
    const normalizedId = normalizePackageLookup(entry.id);
    const normalizedName = normalizePackageLookup(entry.name);
    return normalizedId.includes(normalizedRequest) || normalizedName.includes(normalizedRequest);
  });

  if (fuzzyMatches.length === 1) {
    return {
      packageId: fuzzyMatches[0].id || fuzzyMatches[0].name,
      requestedPackage,
      matches: [fuzzyMatches[0].pkg]
    };
  }

  return {
    packageId: "",
    requestedPackage,
    matches: fuzzyMatches.map((entry) => entry.pkg)
  };
};

const extractMessageId = (prompt) => {
  const match = prompt.match(/ID:[A-Za-z0-9.:_-]+/i);
  return match ? match[0] : "";
};

const extractQueueOperationParts = (prompt) => {
  const text = String(prompt || "").trim();
  const moveMatch = text.match(/\bmove\b\s+(ID:[^\s,]+)\s+\bfrom\b\s+(.+?)\s+\bto\b\s+([^\s,]+)/i);
  const retryOrDeleteMatch = text.match(/\b(?:retry|delete|deleted)\b\s+(ID:[^\s,]+)\s+(?:\bfrom\b|\bin\b|\bqueue\b)?\s*([^\s,]+)/i);

  if (moveMatch) {
    return {
      messageId: moveMatch[1],
      sourceQueue: moveMatch[2].trim(),
      targetQueue: moveMatch[3].trim()
    };
  }

  if (retryOrDeleteMatch) {
    return {
      messageId: retryOrDeleteMatch[1],
      sourceQueue: retryOrDeleteMatch[2].trim(),
      targetQueue: ""
    };
  }

  return {
    messageId: extractMessageId(text),
    sourceQueue: extractQuotedValue(text, "from") || extractQuotedValue(text, "queue"),
    targetQueue: extractQuotedValue(text, "to") || extractQuotedValue(text, "target")
  };
};

const extractEmailAddress = (prompt) => prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";

const buildChatbotUnsupportedResponse = () => ({
  notApplicable: true,
  message: "Not applicable question. Ask about monitoring status, errors, reports, payloads, packages, artifacts, JMS queues, move, retry, delete, export, or email.",
  items: [],
  actions: []
});

const getChatbotReports = () => {
  let conn;
  try {
    conn = getConnection();
    return getReportRows(conn);
  } finally {
    if (conn) {
      conn.disconnect();
    }
  }
};

const getMonitoringOverviewData = async ({ prompt, token, baseUrl }) => {
  if (token && baseUrl) {
    try {
      const liveResult = await fetchTenantMonitoringLogs({ baseUrl, token, prompt });
      return {
        reports: liveResult.reports,
        range: liveResult.range,
        source: "tenant",
        totalCount: Number.isFinite(liveResult.totalCount) ? liveResult.totalCount : liveResult.reports.length
      };
    } catch (error) {
      console.warn("getMonitoringOverviewData tenant fallback:", error.response?.data || error.message);
    }
  }

  const savedResult = filterReportsForPrompt(getChatbotReports(), prompt);
  return {
    reports: savedResult.filtered,
    range: savedResult.range,
    source: "saved report",
    totalCount: savedResult.filtered.length
  };
};

const buildOperationalPromptFromIntent = (intent) => {
  const filters = intent.filters || {};
  const parts = [];

  if (intent.output === "list" || intent.output === "searchable_select") {
    parts.push("show");
  } else if (intent.output === "count") {
    parts.push("count");
  }

  if (filters.status && filters.status !== "ANY") {
    parts.push(filters.status.toLowerCase());
  }

  if (filters.health && filters.health !== "any") {
    parts.push(filters.health);
  }

  if (filters.range) {
    parts.push(filters.range);
  }

  if (intent.tool === "list_artifacts") {
    parts.push("artifacts");
    if (filters.packageName) {
      parts.push(`inside ${filters.packageName} package`);
    }
  } else if (intent.tool === "list_packages") {
    parts.push("packages");
  } else if (intent.tool === "list_jms_queues") {
    parts.push("JMS queues");
  } else if (intent.tool === "list_jms_messages") {
    parts.push("JMS messages");
    if (filters.queueName) {
      parts.push(`in queue ${filters.queueName}`);
    }
  } else if (intent.tool === "get_jms_resources") {
    parts.push("JMS resources");
  } else if (intent.tool === "move_jms_message") {
    return `move ${filters.messageId} from ${filters.sourceQueue} to ${filters.targetQueue}`;
  } else if (intent.tool === "retry_jms_message") {
    return `retry ${filters.messageId} from ${filters.sourceQueue || filters.queueName}`;
  } else if (intent.tool === "delete_jms_message") {
    return `delete ${filters.messageId} from ${filters.sourceQueue || filters.queueName}`;
  } else {
    parts.push("monitoring messages");
  }

  if (filters.email) {
    parts.push(`to ${filters.email}`);
  }

  const builtPrompt = parts.filter(Boolean).join(" ").trim();
  return builtPrompt || intent.prompt;
};

const handleMonitoringOverviewPrompt = async ({ prompt, token, baseUrl }) => {
  const { reports, range, source, totalCount } = await getMonitoringOverviewData({ prompt, token, baseUrl });
  const rangeText = range ? ` for the ${range.label}` : "";
  const sourceText = source === "tenant" ? "connected tenant" : source;
  const visibleColumns = [
    "MPL ID",
    "iFlow name",
    "status",
    "log start",
    "log end",
    "error information",
    "correlation ID",
    "payload/attachment details"
  ];
  const latestItems = toChatItems(reports, "report", 5);

  return {
    message:
      `Monitoring overview is loaded from the ${sourceText}${rangeText}. ` +
      `I found ${totalCount} message(s). Status summary: ${summarizeReports(reports)}.\n\n` +
      `Data available: ${visibleColumns.join(", ")}. You can ask for counts, lists, failed/completed/processing messages, specific time ranges, payload export, Excel export, or email report.`,
    items: latestItems,
    actions: [
      { label: "Download Excel", url: "/export-reports-excel", method: "GET" },
      { label: "Download Payload ZIP", url: "/download-reports-zip", method: "GET" }
    ]
  };
};

const handleMonitoringChatPrompt = async ({ prompt, token, baseUrl, intent }) => {
  const operationalPrompt = intent ? buildOperationalPromptFromIntent(intent) : prompt;
  const normalized = operationalPrompt.toLowerCase();
  const wantsList = /(show|list|view|display|give|get)\b/.test(normalized);
  const wantsPayload = normalized.includes("payload");
  const wantsExcel = normalized.includes("excel");
  const wantsZip = normalized.includes("zip") || normalized.includes("all payload");
  const wantsEmail = normalized.includes("email") || normalized.includes("send");
  const canUseLiveTenant = token && baseUrl && !wantsPayload && !wantsExcel && !wantsZip && !wantsEmail;
  let filtered = [];
  let range = parseChatTimeRange(operationalPrompt);
  let source = "saved report";
  let totalCount = null;

  if (canUseLiveTenant) {
    try {
      const liveResult = await fetchTenantMonitoringLogs({ baseUrl, token, prompt: operationalPrompt });
      filtered = liveResult.reports;
      range = liveResult.range || range;
      source = "tenant";
      totalCount = Number.isFinite(liveResult.totalCount) ? liveResult.totalCount : filtered.length;
    } catch {
      const savedResult = filterReportsForPrompt(getChatbotReports(), operationalPrompt);
      filtered = savedResult.filtered;
      range = savedResult.range || range;
      source = "saved report fallback";
      totalCount = filtered.length;
    }
  } else {
    const savedResult = filterReportsForPrompt(getChatbotReports(), operationalPrompt);
    filtered = savedResult.filtered;
    range = savedResult.range || range;
    totalCount = filtered.length;
  }

  const rangeText = range ? ` in the ${range.label}` : "";
  const sourceText = source === "tenant" ? " from the tenant" : ` from the ${source}`;
  const countText = Number.isFinite(totalCount) ? totalCount : filtered.length;

  if (wantsEmail) {
    const to = intent?.filters?.email || extractEmailAddress(operationalPrompt);
    return {
      message: to
        ? `I can send the latest monitoring Excel report to ${to}. Use the email action to send it.`
        : "I can send the latest monitoring Excel report, but I need a recipient email address.",
      items: [],
      actions: to ? [{ label: "Send Excel Email", endpoint: "/send-excel-email", method: "POST", body: { to } }] : []
    };
  }

  if (wantsExcel) {
    return {
      message: "The monitoring Excel export is available.",
      items: [],
      actions: [{ label: "Download Excel", url: "/export-reports-excel", method: "GET" }]
    };
  }

  if (wantsZip || wantsPayload) {
    return {
      message: wantsPayload && filtered.length
        ? `Found ${filtered.length} matching monitoring rows${rangeText}. You can download all payloads or open individual payloads from the overview.`
        : "The payload zip download is available for the latest monitoring report.",
      items: toChatItems(filtered, "report", 5),
      actions: [{ label: "Download Payload ZIP", url: "/download-reports-zip", method: "GET" }]
    };
  }

  if (wantsList) {
    return {
      message: `Found ${countText} matching monitoring message(s)${rangeText}${sourceText}.`,
      items: toChatItems(filtered, "report", 10),
      actions: []
    };
  }

  return {
    message: `Found ${countText} matching monitoring message(s)${rangeText}${sourceText}. Do you want to see them? Status summary: ${summarizeReports(filtered)}.`,
    items: [],
    pendingItems: toChatItems(filtered, "report", 10),
    actions: []
  };
};

const handleJmsChatPrompt = async ({ prompt, token, baseUrl, intent }) => {
  if (!token || !baseUrl) {
    return {
      message: "Connect a tenant first, then I can work with JMS queues.",
      items: [],
      actions: []
    };
  }

  const operationalPrompt = intent ? buildOperationalPromptFromIntent(intent) : prompt;
  const normalized = operationalPrompt.toLowerCase();
  const extractedParts = extractQueueOperationParts(operationalPrompt);
  const messageId = firstNonEmpty(intent?.filters?.messageId, extractedParts.messageId);
  const sourceQueue = firstNonEmpty(intent?.filters?.sourceQueue, intent?.filters?.queueName, extractedParts.sourceQueue);
  const targetQueue = firstNonEmpty(intent?.filters?.targetQueue, extractedParts.targetQueue);
  const wantsProblemQueues =
    hasAnyTerm(String(intent?.filters?.health || "").toLowerCase(), ["failed", "failure", "error", "stopped", "dlq"]) ||
    hasAnyTerm(normalized, ["failed queue", "failed queues", "failure queue", "failure queues", "error queue", "error queues", "stopped queue", "stopped queues", "dlq", "dead letter"]) ||
    (hasAnyTerm(normalized, ["failed", "failure", "error", "stopped"]) && hasAnyTerm(normalized, ["queue", "queues", "jms"]));

  if (normalized.includes("resource") || normalized.includes("broker") || normalized.includes("usage")) {
    try {
      const resource = await getJmsBrokerResource(baseUrl, token, "Broker1");
      return {
        message: `JMS resources loaded. Queues: ${resource.queueNumber}/${resource.maxQueueNumber}, capacity: ${formatCapacityMb(resource.capacity)} of ${formatCapacityMb(resource.maxCapacity)}.`,
        items: [{ type: "resource", ...resource }],
        actions: []
      };
    } catch (error) {
      const queues = await getJmsQueueRecords(baseUrl, token);
      return {
        message: `I could not fetch Broker1 resource details, but I loaded ${queues.length} JMS queue(s) from the tenant.`,
        items: toChatItems(queues, "jms-queue", 20),
        actions: []
      };
    }
  }

  if (normalized.includes("move")) {
    if (!messageId || !sourceQueue || !targetQueue) {
      return {
        message: "To move a JMS message, include message ID, source queue, and target queue. Example: move ID:... from JMS_Queue_100_DLQ to JMS_Queue_100.",
        items: [],
        actions: []
      };
    }

    await moveJmsMessage(baseUrl, token, sourceQueue, targetQueue, messageId, true);
    return {
      message: `Moved ${messageId} from ${sourceQueue} to ${targetQueue}.`,
      items: [],
      actions: []
    };
  }

  if (normalized.includes("retry")) {
    if (!messageId || !sourceQueue) {
      return {
        message: "To retry a JMS message, include message ID and queue. Example: retry ID:... from JMS_Queue_100_DLQ.",
        items: [],
        actions: []
      };
    }

    await retryJmsMessage(baseUrl, token, sourceQueue, messageId, true);
    return {
      message: `Retry triggered for ${messageId} in ${sourceQueue}.`,
      items: [],
      actions: []
    };
  }

  if (normalized.includes("delete") || normalized.includes("deleted")) {
    if (!messageId || !sourceQueue) {
      return {
        message: "To delete a JMS message, include message ID and queue. Example: delete ID:... from JMS_Queue_100_DLQ.",
        items: [],
        actions: []
      };
    }

    await deleteJmsMessage(baseUrl, token, sourceQueue, messageId, true);
    return {
      message: `Deleted ${messageId} from ${sourceQueue}.`,
      items: [],
      actions: []
    };
  }

  const queues = await getJmsQueueRecords(baseUrl, token);

  if (wantsProblemQueues) {
    const problemQueues = filterProblemJmsQueues(queues);

    return {
      message: problemQueues.length
        ? `Found ${problemQueues.length} JMS queue(s) that look failed, stopped, error-related, or DLQ-like.`
        : "I did not find any JMS queues with failed/error/stopped/DLQ indicators in the queue summary. To inspect failed messages, ask for messages in a specific queue.",
      items: toChatItems(problemQueues, "jms-queue", 30),
      actions: []
    };
  }

  if (sourceQueue && !normalized.includes("queues")) {
    const messages = await enrichQueueMessages(baseUrl, token, await getJmsMessagesForQueue(baseUrl, token, sourceQueue, sourceQueue));
    return {
      message: `Found ${messages.length} message(s) in ${sourceQueue}.`,
      items: toChatItems(messages, "jms-message", 10),
      actions: []
    };
  }

  return {
    message: `Found ${queues.length} JMS queue(s).`,
    items: toChatItems(queues, "jms-queue", 20),
    actions: []
  };
};

const handlePackageChatPrompt = async ({ prompt, token, baseUrl, packages = [], intent }) => {
  const operationalPrompt = intent ? buildOperationalPromptFromIntent(intent) : prompt;
  const normalized = operationalPrompt.toLowerCase();

  if (normalized.includes("artifact")) {
    if (!token || !baseUrl) {
      return { message: "Connect a tenant first, then I can fetch artifacts.", items: [], actions: [] };
    }

    const { apiBaseUrl, packages: fetchedPackages } = await fetchPackages(baseUrl, token);

    const packagePrompt = intent?.filters?.packageName
      ? `show artifacts inside ${intent.filters.packageName} package`
      : operationalPrompt;
    const { packageId, requestedPackage, matches } = resolvePackageForPrompt(packagePrompt, fetchedPackages);

    if (!packageId) {
      return {
        message: matches.length
          ? `I found ${matches.length} package(s) matching "${requestedPackage}". Select the exact package first, then I will fetch only that package's artifacts.`
          : `I could not find a package matching "${requestedPackage}" in the connected tenant.`,
        items: toSearchableChatItems(matches, "package"),
        actions: []
      };
    }

    const artifacts = packageId === "All"
      ? (await fetchArtifactsForPackagesInBatches(apiBaseUrl, token, fetchedPackages)).results.flatMap((entry) => entry.artifacts)
      : await fetchArtifactsForPackage(apiBaseUrl, token, packageId);

    return {
      message: `Found ${artifacts.length} artifact(s) for ${packageId}.`,
      items: toSearchableChatItems(artifacts, "artifact"),
      actions: []
    };
  }

  if (token && baseUrl) {
    const { packages: fetchedPackages } = await fetchPackages(baseUrl, token);
    return {
      message: `Found ${fetchedPackages.length} package(s) from the connected tenant.`,
      items: toSearchableChatItems(fetchedPackages, "package"),
      actions: []
    };
  }

  return {
    message: `Found ${packages.length} package(s) from the current session cache.`,
    items: toSearchableChatItems(packages, "package"),
    actions: []
  };
};

const executeTenantChatTool = async ({ intent, tenantContext }) => {
  const prompt = intent.prompt;
  const { token, baseUrl, packages } = tenantContext;

  switch (intent.tool) {
    case "get_monitoring_overview":
      return handleMonitoringOverviewPrompt({ prompt, token, baseUrl });
    case "get_monitoring_logs":
      return handleMonitoringChatPrompt({ prompt, token, baseUrl, intent });
    case "export_monitoring_excel":
    case "download_payload_zip":
    case "send_monitoring_email":
    case "trigger_cpi_flow":
      try {
        const mcpResult = await executeMcpTool(intent.tool, intent.filters || {}, tenantContext);
        return mcpResult;
      } catch (error) {
        console.error(`executeMcpTool for ${intent.tool} failed in chatbot:`, error);
        return handleMonitoringChatPrompt({ prompt, token, baseUrl, intent });
      }
    case "get_pgp_keys":
    case "get_security_materials":
    case "get_keystores":
    case "get_access_policies":
    case "get_user_roles":
    case "get_data_stores":
    case "get_variables":
    case "get_number_ranges":
    case "get_partner_directory":
    case "get_message_locks":
    case "get_system_logs":
    case "get_usage_details":
    case "get_connectivity_tests":
      try {
        const mcpResult = await executeMcpTool(intent.tool, intent.filters || {}, tenantContext);
        return mcpResult;
      } catch (error) {
        console.error(`executeMcpTool for ${intent.tool} failed in chatbot:`, error);
        const resourceName = intent.tool.replace("get_", "").replace("_", " ");
        return { message: `Failed to fetch ${resourceName}.`, items: [], actions: [] };
      }
    case "list_packages":
    case "list_artifacts":
      return handlePackageChatPrompt({ prompt, token, baseUrl, packages, intent });
    case "list_jms_queues":
    case "list_jms_messages":
    case "get_jms_resources":
    case "move_jms_message":
    case "retry_jms_message":
    case "delete_jms_message":
      return handleJmsChatPrompt({ prompt, token, baseUrl, intent });
    default:
      return buildChatbotUnsupportedResponse();
  }
};

const attachChatbotTrace = (response, intent, tenantContext) => ({
  ...response,
  intent: {
    tool: intent.tool,
    confidence: intent.confidence,
    reason: intent.reason,
    source: intent.source || "rules",
    filters: intent.filters || {},
    output: intent.output || "",
    category: TENANT_CHAT_TOOLS[intent.tool]?.category || "unsupported",
    requiresCsrf: Boolean(TENANT_CHAT_TOOLS[intent.tool]?.csrf),
    requiresTenantConnection: TENANT_CHAT_TOOLS[intent.tool]?.auth === "tenant-bearer-token"
  },
  tenant: {
    connected: tenantContext.hasTenantConnection,
    tenantId: tenantContext.tenantId
  }
});

const { configureMcpTools, runMcpChat, promptHeuristicSaysNoList } = require("./mcp/mcpClient");
const { executeMcpTool } = require("./mcp/toolHandlers");
const { MCP_TOOLS } = require("./mcp/toolRegistry");

configureMcpTools({
  fetchPackages,
  fetchArtifactsForPackage,
  fetchArtifactsForPackagesInBatches,
  fetchTenantMonitoringLogs,
  getMonitoringOverviewData,
  getJmsQueueRecords,
  getJmsMessagesForQueue,
  getJmsBrokerResource,
  enrichQueueMessages,
  moveJmsMessage,
  retryJmsMessage,
  deleteJmsMessage,
  filterProblemJmsQueues,
  resolvePackageForPrompt
});

const handleChatbotPrompt = async ({ prompt, token, baseUrl, packages }) => {
  const tenantContext = createChatbotTenantContext({ token, baseUrl, packages });

  // Direct rule-based bypass for high confidence direct prompts (like Option B)
  const directIntent = classifyChatbotIntent(prompt);
  if (directIntent && directIntent.confidence > 0.95) {
    const response = await executeTenantChatTool({ intent: directIntent, tenantContext });
    if (promptHeuristicSaysNoList(prompt)) {
      response.items = [];
      if (response.pendingItems) response.pendingItems = [];
    }
    return attachChatbotTrace(response, directIntent, tenantContext);
  }

  const hasAiKey = Boolean(process.env.OPENAI_API_KEY || process.env.AI_INTENT_API_KEY);

  if (hasAiKey) {
    try {
      const mcpResponse = await runMcpChat({ prompt, tenantContext });
      return {
        ...mcpResponse,
        tenant: {
          connected: tenantContext.hasTenantConnection,
          tenantId: tenantContext.tenantId
        }
      };
    } catch (error) {
      console.warn("MCP chat failed, falling back to rules:", error.response?.data || error.message);
    }
  }

  const fallbackIntent = classifyChatbotIntent(prompt);
  const aiIntent = await analyzePromptWithAi({ prompt });
  const intent = mergeIntentFallback(aiIntent, fallbackIntent);

  // If AI has a natural response, return it directly
  if (intent.tool === "natural_response" && intent.message) {
    return attachChatbotTrace(
      {
        message: intent.message,
        items: [],
        actions: []
      },
      intent,
      tenantContext
    );
  }

  if (intent.tool === "unsupported") {
    return attachChatbotTrace(buildChatbotUnsupportedResponse(), intent, tenantContext);
  }

  if (intent.needsClarification && intent.clarification) {
    return attachChatbotTrace(
      {
        message: intent.clarification,
        items: [],
        actions: []
      },
      intent,
      tenantContext
    );
  }

  const tool = TENANT_CHAT_TOOLS[intent.tool];
  if (tool?.auth === "tenant-bearer-token" && !tenantContext.hasTenantConnection) {
    return attachChatbotTrace(
      {
        message: "Connect a tenant first, then I can fetch that data with the correct tenant credentials.",
        items: [],
        actions: []
      },
      intent,
      tenantContext
    );
  }

  const response = await executeTenantChatTool({ intent, tenantContext });
  if (promptHeuristicSaysNoList(prompt)) {
    response.items = [];
    if (response.pendingItems) response.pendingItems = [];
  }
  return attachChatbotTrace(response, intent, tenantContext);
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

app.get("/chatbot/capabilities", (req, res) => {
  const tools = Object.entries(TENANT_CHAT_TOOLS).map(([name, config]) => ({
    name,
    ...config
  }));

  return res.json({
    tools,
    total: tools.length,
    aiIntent: {
      enabled: Boolean(OPENAI_API_KEY),
      model: AI_INTENT_MODEL
    },
    note: "These are backend-controlled tenant tools. Secrets and tokens are never exposed by this endpoint."
  });
});

app.post("/chatbot/query", async (req, res) => {
  let { prompt, token, baseUrl, packages } = req.body || {};
  baseUrl = cleanUrl(baseUrl);

  try {
    const response = await handleChatbotPrompt({
      prompt,
      token,
      baseUrl,
      packages: Array.isArray(packages) ? packages : []
    });

    return res.json(response);
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error("chatbot/query error:", detail);
    return res.json({
      message: `I could not complete that tenant action. ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
      items: [],
      actions: []
    });
  }
});

app.post("/chatbot/tools/execute", async (req, res) => {
  let { toolName, params, token, baseUrl, packages } = req.body || {};
  baseUrl = cleanUrl(baseUrl);

  const allowedTools = new Set(MCP_TOOLS.map((tool) => tool.name));
  if (!toolName || !allowedTools.has(toolName)) {
    return res.status(400).json({
      message: "toolName is required and must be one of the registered MCP tools.",
      allowedTools: [...allowedTools]
    });
  }

  if (!token || !baseUrl) {
    return res.status(400).json({
      message: "token and baseUrl are required. Connect a tenant first."
    });
  }

  try {
    const tenantContext = createChatbotTenantContext({
      token,
      baseUrl,
      packages: Array.isArray(packages) ? packages : []
    });
    const result = await executeMcpTool(toolName, params || {}, tenantContext);

    return res.json({
      toolName,
      ...result,
      tenant: {
        connected: tenantContext.hasTenantConnection,
        tenantId: tenantContext.tenantId
      }
    });
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error(`chatbot/tools/execute ${toolName} error:`, detail);
    return res.status(500).json({
      message: `Tool execution failed for ${toolName}.`,
      detail: typeof detail === "string" ? detail : JSON.stringify(detail)
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
        retryJmsMessage(
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

app.get("/datastore-entries/download", async (req, res) => {
  const { id, dataStoreName, integrationFlow, type, token, baseUrl } = req.query || {};
  if (!id || !dataStoreName || !integrationFlow || !token || !baseUrl) {
    return res.status(400).send("Missing required parameters (id, dataStoreName, integrationFlow, token, baseUrl).");
  }

  try {
    const { downloadODataResourceStream } = require("./sap/tenantApiClient");
    const formattedType = type || "Default";
    const resourcePath = `DataStoreEntries(Id='${encodeURIComponent(id)}',DataStoreName='${encodeURIComponent(dataStoreName)}',IntegrationFlow='${encodeURIComponent(integrationFlow)}',Type='${encodeURIComponent(formattedType)}')/$value`;

    const payload = await downloadODataResourceStream({
      token,
      baseUrl,
      resourcePath
    });

    res.setHeader("Content-Disposition", `attachment; filename="payload_${id}.txt"`);
    res.setHeader("Content-Type", "text/plain");
    return res.send(payload);
  } catch (error) {
    console.error("Download data store entry error:", error.message);
    return res.status(500).send(`Failed to download data store entry payload: ${error.message}`);
  }
});

const PORT = process.env.PORT || 5000;

module.exports = {
  app,
  fetchPackages,
  fetchArtifactsForPackage,
  fetchArtifactsForPackagesInBatches,
  fetchTenantMonitoringLogs,
  getMonitoringOverviewData,
  getJmsQueueRecords,
  getJmsMessagesForQueue,
  getJmsBrokerResource,
  enrichQueueMessages,
  moveJmsMessage,
  retryJmsMessage,
  deleteJmsMessage,
  filterProblemJmsQueues,
  resolvePackageForPrompt
};

app.use(express.static(path.join(__dirname, "../frontend/dist")));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/dist/index.html"));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
