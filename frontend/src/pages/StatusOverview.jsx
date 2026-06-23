import React, { useEffect, useMemo, useRef, useState } from "react";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import { js_beautify } from "js-beautify";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Container,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  IconButton,
  MenuItem,
  Paper,
  Pagination,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography
} from "@mui/material";
import xmlFormatter from "xml-formatter";
import TopBar from "../components/TopBar";
import { API_BASE_URL } from "../config";

const timeOptions = ["Last Hour", "Last Day", "Last Week", "Last Month", "Custom"];
const statusOptions = [
  "All",
  "COMPLETED",
  "FAILED",
  "PROCESSING",
  "RETRY",
  "ESCALATED",
  "CANCELLED",
  "DISCARDED",
  "ABANDONED"
];

const getMplId = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const match = text.match(/MPL ID[^:]*:\s*([A-Za-z0-9]+)/i);
  return match ? match[1] : "";
};

const toDateTimeInputValue = (date) => {
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - offset * 60000);
  return localDate.toISOString().slice(0, 16);
};

const toCpiDateTime = (value) => {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:00`;
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

const getRangeForTime = (timeRange, customFromDate, customToDate) => {
  const now = new Date();

  switch (timeRange) {
    case "Last Hour":
      return {
        fromDate: toCpiDateTime(new Date(now.getTime() - 60 * 60 * 1000)),
        toDate: toCpiDateTime(now)
      };
    case "Last Day":
      return {
        fromDate: toCpiDateTime(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
        toDate: toCpiDateTime(now)
      };
    case "Last Week":
      return {
        fromDate: toCpiDateTime(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
        toDate: toCpiDateTime(now)
      };
    case "Last Month":
      return {
        fromDate: toCpiDateTime(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)),
        toDate: toCpiDateTime(now)
      };
    default:
      return {
        fromDate: toCpiDateTime(customFromDate),
        toDate: toCpiDateTime(customToDate)
      };
  }
};

const DEFAULT_ROWS_PER_PAGE = 20;
const rowsPerPageOptions = [10, 20, 30, 40, 50];

const getBeautifiedPayload = (payloadText) => {
  const raw = typeof payloadText === "string" ? payloadText.trim() : "";

  if (!raw) {
    return { type: "raw", content: "" };
  }

  if (raw.startsWith("<")) {
    try {
      return {
        type: "xml",
        content: xmlFormatter(raw, {
          indentation: "  ",
          collapseContent: true,
          lineSeparator: "\n"
        })
      };
    } catch {
      return { type: "raw", content: raw };
    }
  }

  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const parsedJson = JSON.parse(raw);
      return {
        type: "json",
        content: js_beautify(JSON.stringify(parsedJson), {
          indent_size: 2,
          preserve_newlines: true
        })
      };
    } catch {
      return { type: "raw", content: raw };
    }
  }

  return { type: "raw", content: raw };
};

const StatusOverview = () => {
  const token = localStorage.getItem("token");
  const baseUrl = localStorage.getItem("baseUrl");
  const [packages, setPackages] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("packages") || "[]");
    } catch {
      return [];
    }
  });
  const [selectedPackage, setSelectedPackage] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [selectedArtifact, setSelectedArtifact] = useState("All");
  const [status, setStatus] = useState("All");
  const [timeRange, setTimeRange] = useState("Last Day");
  const [fromDate, setFromDate] = useState(() =>
    toDateTimeInputValue(new Date(Date.now() - 24 * 60 * 60 * 1000))
  );
  const [toDate, setToDate] = useState(() => toDateTimeInputValue(new Date()));
  const [loading, setLoading] = useState(false);
  const [artifactsLoading, setArtifactsLoading] = useState(true);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [downloadAllLoading, setDownloadAllLoading] = useState(false);
  const [excelLoading, setExcelLoading] = useState(false);
  const [feedbackType, setFeedbackType] = useState("");
  const [excelDialogOpen, setExcelDialogOpen] = useState(false);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailFrom, setEmailFrom] = useState("");
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailSending, setEmailSending] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [reports, setReports] = useState([]);
  const [selectedPayloadRow, setSelectedPayloadRow] = useState(null);
  const [payloadViewMode, setPayloadViewMode] = useState("raw");
  const [resolvedBaseUrl, setResolvedBaseUrl] = useState(baseUrl || "");
  const [hasTriggeredFetch, setHasTriggeredFetch] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(DEFAULT_ROWS_PER_PAGE);
  const artifactRequestIdRef = useRef(0);
  const artifactCacheRef = useRef(new Map());

  const loadReports = async () => {
    setReportsLoading(true);
    setFeedback("");
    setFeedbackType("");

    try {
      const response = await fetch(`${API_BASE_URL}/latest-report`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to load reports.");
      }

      setReports(Array.isArray(data.reports) ? data.reports : []);
      setHasTriggeredFetch(true);
      setCurrentPage(1);
    } catch (reportError) {
      console.error("failed to load reports", reportError);
      setFeedback("Failed to load data.");
      setFeedbackType("error");
    } finally {
      setReportsLoading(false);
    }
  };

  useEffect(() => {
    const requestId = ++artifactRequestIdRef.current;
    const controller = new AbortController();

    async function loadArtifacts() {
      if (!token || !baseUrl) {
        if (artifactRequestIdRef.current === requestId) {
          setArtifacts([]);
          setArtifactsLoading(false);
        }
        return;
      }

      const shouldLoadArtifacts =
        Boolean(selectedPackage?.Id);

      if (!shouldLoadArtifacts) {
        if (artifactRequestIdRef.current === requestId) {
          setArtifacts([]);
          setSelectedArtifact("All");
          setArtifactsLoading(false);
          setError("");
        }
        return;
      }

      const cacheKey = `${resolvedBaseUrl || baseUrl || ""}::${selectedPackage.Id}`;
      const cachedArtifacts = artifactCacheRef.current.get(cacheKey);

      if (cachedArtifacts) {
        if (artifactRequestIdRef.current === requestId) {
          setArtifacts(cachedArtifacts);
          setSelectedArtifact((currentArtifact) =>
            currentArtifact === "All" || cachedArtifacts.some((artifact) => artifact.Name === currentArtifact)
              ? currentArtifact
              : "All"
          );
          setArtifactsLoading(false);
          setError("");
        }
        return;
      }

      setArtifactsLoading(true);
      setError("");

      try {
        const resp = await fetch(`${API_BASE_URL}/getArtifacts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            packageId: selectedPackage.Id,
            token,
            baseUrl
          })
        });
        const data = await resp.json();

        if (!resp.ok) {
          throw new Error(data.message || data.detail || "Failed to load artifacts.");
        }

        if (artifactRequestIdRef.current !== requestId) {
          return;
        }

        const nextArtifacts = Array.from(
          new Map((data.artifacts || []).map((artifact) => [artifact.Name, artifact])).values()
        );
        artifactCacheRef.current.set(cacheKey, nextArtifacts);
        setArtifacts(nextArtifacts);
        setSelectedArtifact((currentArtifact) =>
          currentArtifact === "All" || nextArtifacts.some((artifact) => artifact.Name === currentArtifact)
            ? currentArtifact
            : "All"
        );
        if (Array.isArray(data.packages)) {
          setPackages(data.packages);
          localStorage.setItem("packages", JSON.stringify(data.packages));
        }
        if (data.baseUrl) {
          localStorage.setItem("baseUrl", data.baseUrl);
          setResolvedBaseUrl(data.baseUrl);
        }
      } catch (loadError) {
        if (loadError.name === "AbortError" || artifactRequestIdRef.current !== requestId) {
          return;
        }
        console.error("failed to load artifacts", loadError);
        setError("Failed to load artifacts.");
      } finally {
        if (artifactRequestIdRef.current === requestId) {
          setArtifactsLoading(false);
        }
      }
    }

    loadArtifacts();

    return () => {
      controller.abort();
    };
  }, [token, baseUrl, selectedPackage, resolvedBaseUrl]);

  useEffect(() => {
    artifactCacheRef.current.clear();
  }, [token, baseUrl]);

  const packageOptions = useMemo(() => {
    const uniquePackages = Array.from(
      new Map(
        packages.map((pkg) => [pkg.Id || `${pkg.Name || "Unnamed Package"}-${pkg.Version || ""}`, pkg])
      ).values()
    );

    return uniquePackages
      .slice()
      .sort((left, right) =>
        (left.Name || left.Id || "").localeCompare(right.Name || right.Id || "")
      );
  }, [packages]);

  const artifactOptions = useMemo(
    () => ["All", ...artifacts.map((artifact) => artifact.Name).sort((left, right) => left.localeCompare(right))],
    [artifacts]
  );

  const triggerIflow = async () => {
    setError("");
    setFeedback("");
    setFeedbackType("");
    setReports([]);
    setSelectedPayloadRow(null);
    setHasTriggeredFetch(false);

    const range = getRangeForTime(timeRange, fromDate, toDate);

    if (!selectedPackage?.Id) {
      setError("Select package.");
      return;
    }

    if (timeRange === "Custom" && (!range.fromDate || !range.toDate)) {
      setError("Select from and to date.");
      return;
    }

    if (timeRange === "Custom" && new Date(fromDate) > new Date(toDate)) {
      setError("'From' date cannot be after 'To' date.");
      return;
    }

    setLoading(true);

    try {
      const payload = {
        BASE_URL: resolvedBaseUrl || baseUrl || "",
        IFLOW_NAME: selectedArtifact === "All" ? "" : selectedArtifact,
        STATUS: status === "All" ? "" : status,
        FROM_DATE: toCpiDateValue(range.fromDate),
        TO_DATE: toCpiDateValue(range.toDate)
      };

      const response = await fetch(`${API_BASE_URL}/trigger-cpi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      let responseBody;
      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }

      setFeedback("Triggered. Fetching latest data...");
      setFeedbackType("info");
      setHasTriggeredFetch(true);
      setTimeout(() => {
        loadReports();
      }, 2000);

      const mplId = getMplId(responseBody?.response || responseBody);
      setFeedback(
        response.ok
          ? "Completed."
          : mplId
            ? `Trigger failed. MPL ID: ${mplId}`
            : "Trigger failed."
      );
      setFeedbackType(response.ok ? "success" : "warning");
    } catch (requestError) {
      console.error("failed to trigger CPI:", requestError);
      setFeedback("Trigger failed.");
      setFeedbackType("error");
    } finally {
      setLoading(false);
    }
  };

  const downloadPayload = (row) => {
    const blob = new Blob([row.decodedPayload || ""], {
      type: row.payloadMimeType || "text/plain"
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = row.payloadFileName || "payload.txt";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);
  };

  const downloadAllPayloads = async () => {
    setDownloadAllLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/download-reports-zip`);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "Failed to download zip file.");
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const fileName = reports[0]?.iflowName
        ? `${reports[0].iflowName}_Payload_files.zip`
        : "iFlow_Payload_files.zip";

      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
    } catch (downloadError) {
      console.error("failed to download payload zip", downloadError);
      setFeedback("Failed to download all payload files.");
      setFeedbackType("error");
    } finally {
      setDownloadAllLoading(false);
    }
  };

  const downloadExcelReport = async () => {
    setExcelLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/export-reports-excel`);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "Failed to export Excel.");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const fileName = reports[0]?.iflowName
        ? `${reports[0].iflowName}.xlsx`
        : "Monitoring_Overview.xlsx";
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      console.error("excel export failed", error);
      setFeedback("Failed to export Excel.");
      setFeedbackType("error");
    } finally {
      setExcelLoading(false);
    }
  };

  const openExcelOptions = () => {
    const iflowName = reports[0]?.iflowName || "Iflow";
    setEmailSubject(`Monitoring Overview of ${iflowName}`);
    setExcelDialogOpen(true);
  };

  const openEmailDialog = () => {
    setExcelDialogOpen(false);
    setEmailDialogOpen(true);
  };

  const sendExcelEmail = async () => {
    setEmailSending(true);
    try {
      const response = await fetch(`${API_BASE_URL}/send-excel-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: emailFrom,
          to: emailTo,
          subject: emailSubject
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "Failed to send email.");
      }

      setFeedback("Email sent.");
      setFeedbackType("success");
      setTimeout(() => {
        setFeedback("");
        setFeedbackType("");
      }, 5000);
      setEmailDialogOpen(false);
    } catch (error) {
      console.error("email send failed", error);
      setFeedback("Failed to send email.");
      setFeedbackType("error");
    } finally {
      setEmailSending(false);
    }
  };

  const filteredReports = useMemo(() => {
    return reports.filter((report) => {
      const hasValidMplId = Boolean(String(report.mplId || "").trim());

      if (!hasValidMplId) {
        return false;
      }

      const matchesArtifact =
        selectedArtifact === "All" || !selectedArtifact || report.iflowName === selectedArtifact;
      const matchesStatus = status === "All" || report.status === status;

      return matchesArtifact && matchesStatus;
    });
  }, [reports, selectedArtifact, status]);

  const pageCount = Math.max(1, Math.ceil(filteredReports.length / rowsPerPage));

  const paginatedReports = useMemo(() => {
    const startIndex = (currentPage - 1) * rowsPerPage;
    return filteredReports.slice(startIndex, startIndex + rowsPerPage);
  }, [filteredReports, currentPage, rowsPerPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedArtifact, status, reports, rowsPerPage]);

  const beautifiedPayload = useMemo(
    () => getBeautifiedPayload(selectedPayloadRow?.decodedPayload || ""),
    [selectedPayloadRow]
  );

  const payloadContent =
    payloadViewMode === "beautified" && beautifiedPayload.type !== "raw"
      ? beautifiedPayload.content
      : selectedPayloadRow?.decodedPayload || "No payload available.";

  return (
    <Box sx={{ minHeight: "100vh", pb: 8, background: "#ffffff" }}>
      <TopBar />
      <Container maxWidth="lg" sx={{ pt: { xs: 3, md: 5 } }}>
        <Stack spacing={2.5}>
          <Paper
            elevation={0}
            sx={{
              p: { xs: 2.5, md: 3 },
              borderRadius: 2,
              border: "1px solid rgba(15, 23, 42, 0.08)",
              color:"white",
              background:
                "rgba(13, 129, 182, 0.8) 100%"
            }}
          >
            <Stack
              direction={{ xs: "column", sm: "row" }}
              justifyContent="space-between"
              alignItems={{ xs: "flex-start", sm: "center" }}
              spacing={1.5}
            >
              <Typography variant="h5">Status Overview</Typography>
            </Stack>
          </Paper>

          <Paper
            elevation={0}
            sx={{
              p: { xs: 2.5, md: 3 },
              borderRadius: 2,
              border: "1px solid rgba(15, 23, 42, 0.08)",
              boxShadow: "0 24px 60px rgba(37, 99, 235, 0.08)"
            }}
          >
            <Stack spacing={2}>
              <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                <Autocomplete
                  fullWidth
                  options={packageOptions}
                  value={selectedPackage}
                  onChange={(_, value) => {
                    setSelectedPackage(value || null);
                    setSelectedArtifact("All");
                    setArtifacts([]);
                    setError("");
                  }}
                  getOptionLabel={(option) =>
                    typeof option === "string" ? option : option.Name || option.Id || "Unnamed Package"
                  }
                  isOptionEqualToValue={(option, value) =>
                    Boolean(option?.Id && value?.Id && option.Id === value.Id)
                  }
                  renderOption={(props, option) => {
                    const { key: _KEY, ...optionProps } = props;
                    const optionKey =
                      typeof option === "string"
                        ? option
                        : option.Id || `${option.Name || "Unnamed Package"}-${option.Version || ""}`;

                    return (
                      <Box component="li" key={optionKey} {...optionProps}>
                        {typeof option === "string"
                          ? option
                          : option.Name || option.Id || "Unnamed Package"}
                      </Box>
                    );
                  }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Package"
                      placeholder="Select package"
                      helperText="Select a package first."
                    />
                  )}
                />
              </Stack>

              <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                <Autocomplete
                  fullWidth
                  options={artifactOptions}
                  value={selectedArtifact}
                  onChange={(_, value) => setSelectedArtifact(value || "All")}
                  disabled={!selectedPackage?.Id || artifactsLoading}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Artifact"
                      helperText={
                        !selectedPackage?.Id
                          ? "Select package first."
                          : "Filter by artifact name."
                      }
                      InputProps={{
                        ...params.InputProps,
                        endAdornment: (
                          <>
                            {artifactsLoading ? (
                              <InputAdornment position="end">
                                <CircularProgress size={16} />
                              </InputAdornment>
                            ) : null}
                            {params.InputProps.endAdornment}
                          </>
                        )
                      }}
                    />
                  )}
                />
                <Autocomplete
                  fullWidth
                  options={statusOptions}
                  value={status}
                  onChange={(_, value) => setStatus(value || "All")}
                  renderInput={(params) => <TextField {...params} label="Status" />}
                />
                <Autocomplete
                  fullWidth
                  options={timeOptions}
                  value={timeRange}
                  onChange={(_, value) => setTimeRange(value || "Last Day")}
                  renderInput={(params) => <TextField {...params} label="Time" />}
                />
              </Stack>

              {timeRange === "Custom" && (
                <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                  <TextField
                    fullWidth
                    label="From"
                    type="datetime-local"
                    value={fromDate}
                    onChange={(event) => setFromDate(event.target.value)}
                    slotProps={{ inputLabel: { shrink: true } }}
                  />
                  <TextField
                    fullWidth
                    label="To"
                    type="datetime-local"
                    value={toDate}
                    onChange={(event) => setToDate(event.target.value)}
                    slotProps={{ inputLabel: { shrink: true } }}
                  />
                </Stack>
              )}

              {artifactsLoading && (
                <Alert severity="info" icon={<CircularProgress size={18} color="inherit" />}>
                  Loading artifacts...
                </Alert>
              )}

              {error && <Alert severity="error">{error}</Alert>}
              {feedback && (
                <Alert severity={feedbackType || (feedback === "Completed." ? "success" : "warning")}>
                  {feedback}
                </Alert>
              )}

              {/* {resolvedBaseUrl && (
                <Typography variant="body2" color="text.secondary">
                  Active tenant: {resolvedBaseUrl}
                </Typography>
              )} */}

              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                <Button
                  variant="contained"
                  startIcon={<SendRoundedIcon />}
                  onClick={triggerIflow}
                  disabled={loading || artifactsLoading || !selectedPackage?.Id}
                  sx={{ borderRadius: 2, minWidth: 132 }}
                >
                  {loading ? "Sending..." : "Trigger"}
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<RefreshRoundedIcon />}
                  onClick={() => {
                    setSelectedPackage(null);
                    setSelectedArtifact("All");
                    setStatus("All");
                    setTimeRange("Last Day");
                    setFromDate(toDateTimeInputValue(new Date(Date.now() - 24 * 60 * 60 * 1000)));
                    setToDate(toDateTimeInputValue(new Date()));
                    setFeedback("");
                    setFeedbackType("");
                    setError("");
                    setReports([]);
                    setSelectedPayloadRow(null);
                    setPayloadViewMode("raw");
                    setHasTriggeredFetch(false);
                    setCurrentPage(1);
                    setRowsPerPage(DEFAULT_ROWS_PER_PAGE);
                  }}
                  sx={{ borderRadius: 2, minWidth: 132 }}
                >
                  Reset
                </Button>
              </Stack>
            </Stack>
          </Paper>

          <Paper
            elevation={0}
            sx={{
              p: { xs: 1.5, md: 2 },
              borderRadius: 1,
              border: "1px solid #cbd5e1",
              boxShadow: "0 10px 24px rgba(15, 23, 42, 0.06)",
              background: "#ffffff"
            }}
          >
            <Stack spacing={2}>
              <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1.5}>
                <Typography
                  variant="h6"
                  sx={{
                    fontWeight: 800,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    color: "primary.dark",
                    position: "relative",
                    width: "fit-content",
                    "&::after": {
                      content: '""',
                      position: "absolute",
                      left: 0,
                      bottom: -6,
                      width: "62%",
                      height: 3,
                      borderRadius: 999,
                      background: "linear-gradient(90deg, #0b84d6 0%, #4cc3ff 100%)"
                    }
                  }}
                >
                  Monitoring Overview
                </Typography>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25}>
                  <Button
                    variant="outlined"
                    startIcon={<RefreshRoundedIcon />}
                    onClick={loadReports}
                    disabled={reportsLoading}
                    sx={{ borderRadius: 2, alignSelf: "flex-start" }}
                  >
                    {reportsLoading ? "Loading..." : "Refresh"}
                  </Button>
                  <Button
                    variant="outlined"
                    startIcon={<DownloadRoundedIcon />}
                    onClick={openExcelOptions}
                    disabled={!hasTriggeredFetch || reportsLoading || reports.length === 0 || excelLoading}
                    sx={{ borderRadius: 2, alignSelf: "flex-start" }}
                  >
                    {excelLoading ? "Converting..." : "Convert to Excel"}
                  </Button>
                  <Button
                    variant="contained"
                    startIcon={<DownloadRoundedIcon />}
                    onClick={downloadAllPayloads}
                    disabled={!hasTriggeredFetch || reportsLoading || downloadAllLoading || reports.length === 0}
                    sx={{ borderRadius: 2, alignSelf: "flex-start" }}
                  >
                    {downloadAllLoading ? "Downloading..." : "All payloads"}
                  </Button>
                </Stack>
              </Stack>

              <TableContainer
                sx={{
                  borderRadius: 0.5,
                  border: "1px solid #cbd5e1",
                  backgroundColor: "#ffffff",
                  overflow: "auto"
                }}
              >
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell
                        sx={{
                          bgcolor: "#e2e8f0",
                          color: "#0f172a",
                          fontWeight: 800,
                          borderRight: "1px solid #cbd5e1"
                        }}
                      >
                        MPL ID
                      </TableCell>
                      <TableCell
                        sx={{
                          bgcolor: "#e2e8f0",
                          color: "#0f172a",
                          fontWeight: 800,
                          borderRight: "1px solid #cbd5e1"
                        }}
                      >
                        IFLOW NAME
                      </TableCell>
                      <TableCell
                        sx={{
                          bgcolor: "#e2e8f0",
                          color: "#0f172a",
                          fontWeight: 800,
                          borderRight: "1px solid #cbd5e1"
                        }}
                      >
                        STATUS
                      </TableCell>
                      <TableCell
                        sx={{
                          bgcolor: "#e2e8f0",
                          color: "#0f172a",
                          fontWeight: 800,
                          borderRight: "1px solid #cbd5e1"
                        }}
                      >
                        LOG START
                      </TableCell>
                      <TableCell
                        sx={{
                          bgcolor: "#e2e8f0",
                          color: "#0f172a",
                          fontWeight: 800,
                          borderRight: "1px solid #cbd5e1"
                        }}
                      >
                        LOG END
                      </TableCell>
                      <TableCell
                        sx={{
                          bgcolor: "#e2e8f0",
                          color: "#0f172a",
                          fontWeight: 800,
                          borderRight: "1px solid #cbd5e1"
                        }}
                      >
                        ERROR INFO
                      </TableCell>
                      <TableCell
                        sx={{
                          bgcolor: "#e2e8f0",
                          color: "#0f172a",
                          fontWeight: 800,
                          borderRight: "1px solid #cbd5e1"
                        }}
                      >
                        ATTACHMENT NAME
                      </TableCell>
                      <TableCell
                        sx={{
                          bgcolor: "#e2e8f0",
                          color: "#0f172a",
                          fontWeight: 800,
                          borderRight: "1px solid #cbd5e1"
                        }}
                      >
                        ATTACHMENT TIMESTAMP
                      </TableCell>
                      <TableCell
                        sx={{
                          bgcolor: "#e2e8f0",
                          color: "#0f172a",
                          fontWeight: 800,
                          
                        }}
                      >
                        PAYLOAD
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {reportsLoading ? (
                      <TableRow>
                        <TableCell colSpan={9} align="center">
                          <CircularProgress size={22} />
                        </TableCell>
                      </TableRow>
                    ) : filteredReports.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} align="center">
                          {hasTriggeredFetch
                            ? "No records found for the selected filters."
                            : "Trigger the iFlow first to fetch data."}
                        </TableCell>
                      </TableRow>
                    ) : (
                      paginatedReports.map((row, index) => (
                        <TableRow
                          key={row.id}
                          hover
                          sx={{
                            bgcolor: index % 2 === 0 ? "#ffffff" : "#f8fafc",
                            "& td": {
                              borderBottom: "1px solid #e2e8f0",
                              borderRight: "1px solid #e2e8f0",
                              py: 1.1,
                              verticalAlign: "top"
                            },
                            "&:hover": {
                              bgcolor: "#eff6ff"
                            }
                          }}
                        >
                          <TableCell>{row.mplId || "-"}</TableCell>
                          <TableCell>{row.iflowName || "-"}</TableCell>
                          <TableCell>{row.status || "-"}</TableCell>
                          <TableCell>{row.logStart ? `${row.logStart} IST` : "-"}</TableCell>
                          <TableCell>{row.logEnd ? `${row.logEnd} IST` : "-"}</TableCell>
                          <TableCell>{row.errorInfo || "-"}</TableCell>
                          <TableCell>{row.attachmentName || "-"}</TableCell>
                          <TableCell>{row.attachmentTimestamp ? `${row.attachmentTimestamp} IST` : "-"}</TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={0.25} alignItems="center">
                              {/* <Button
                                size="small"
                                variant="text"
                                onClick={() => downloadPayload(row)}
                                sx={{
                                  minWidth: 0,
                                  px: 0.5,
                                  textTransform: "none",
                                  fontWeight: 600,
                                  justifyContent: "flex-start",
                                  maxWidth: 120
                                }}
                              >
                                <Box
                                  component="span"
                                  sx={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    textDecoration: "underline"
                                  }}
                                >
                                  {row.payloadFileName || "-"}
                                </Box>
                              </Button> */}
                              <IconButton
                                size="small"
                                aria-label={`view ${row.payloadFileName}`}
                                onClick={() => {
                                  setSelectedPayloadRow(row);
                                  setPayloadViewMode("raw");
                                }}
                              >
                                <VisibilityRoundedIcon fontSize="small" />
                              </IconButton>

                              <IconButton
                                size="small"
                                aria-label={`download ${row.payloadFileName}`}
                                onClick={() => downloadPayload(row)}
                              >
                                <DownloadRoundedIcon fontSize="small" />
                              </IconButton>
                            </Stack>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>

              {filteredReports.length > 0 && (
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  justifyContent="space-between"
                  alignItems={{ xs: "flex-start", sm: "center" }}
                  spacing={1.5}
                >
                  <Stack
                    direction={{ xs: "column", sm: "row" }}
                    spacing={1.5}
                    alignItems={{ xs: "flex-start", sm: "center" }}
                  >
                    <Typography variant="body2" color="text.secondary">
                      Showing {(currentPage - 1) * rowsPerPage + 1}-
                      {Math.min(currentPage * rowsPerPage, filteredReports.length)} of {filteredReports.length}
                    </Typography>
                    <TextField
                      select
                      size="small"
                      label="select rows/page"
                      value={rowsPerPage}
                      onChange={(event) => setRowsPerPage(Number(event.target.value))}
                      sx={{ minWidth: 140 }}
                    >
                      {rowsPerPageOptions.map((option) => (
                        <MenuItem key={option} value={option}>
                          {option}
                        </MenuItem>
                      ))}
                    </TextField>
                  </Stack>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Pagination
                      count={pageCount}
                      page={currentPage}
                      onChange={(_, page) => setCurrentPage(page)}
                      color="primary"
                      size="small"
                      siblingCount={0}
                      boundaryCount={1}
                    />
                  </Stack>
                </Stack>
              )}
            </Stack>
          </Paper>
        </Stack>
      </Container>

      <Dialog
        open={Boolean(selectedPayloadRow)}
        onClose={() => setSelectedPayloadRow(null)}
        fullWidth
        maxWidth="lg"
      >
        <DialogTitle>Payload View</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              File: {selectedPayloadRow?.payloadFileName || "-"}
            </Typography>
            {payloadViewMode === "beautified" && beautifiedPayload.type === "raw" && (
              <Alert severity="info">
                Beautify is available only for valid XML or JSON payloads.
              </Alert>
            )}
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 2,
                minHeight: 320,
                overflow: "auto",
                borderRadius: 2,
                bgcolor: "rgba(15, 23, 42, 0.04)",
                color: "text.primary",
                fontSize: 13,
                fontFamily: '"Consolas", "Courier New", monospace',
                whiteSpace: "pre-wrap",
                wordBreak: "break-word"
              }}
            >
              {payloadContent}
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() =>
              setPayloadViewMode((mode) => (mode === "beautified" ? "raw" : "beautified"))
            }
            disabled={beautifiedPayload.type === "raw"}
          >
            {payloadViewMode === "beautified"
              ? "Show Raw"
              : beautifiedPayload.type === "json"
                ? "Beautify JSON"
                : "Beautify XML"}
          </Button>
          <Button onClick={() => setSelectedPayloadRow(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={excelDialogOpen}
        onClose={() => setExcelDialogOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Convert to Excel</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Stack spacing={2}>
            <Button
              variant="contained"
              onClick={downloadExcelReport}
              disabled={excelLoading}
            >
              {excelLoading ? "Converting..." : "Download Excel"}
            </Button>
            <Button variant="outlined" onClick={openEmailDialog}>
              Send Email
            </Button>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExcelDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={emailDialogOpen}
        onClose={() => setEmailDialogOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Send Email</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Stack spacing={2}>
            <TextField
              label="From"
              value={emailFrom}
              onChange={(event) => setEmailFrom(event.target.value)}
            />
            <TextField
              label="To"
              value={emailTo}
              onChange={(event) => setEmailTo(event.target.value)}
            />
            <TextField
              label="Subject"
              value={emailSubject}
              onChange={(event) => setEmailSubject(event.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEmailDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={sendExcelEmail}
            disabled={!emailTo || emailSending}
          >
            {emailSending ? "Sending..." : "Send"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default StatusOverview;
