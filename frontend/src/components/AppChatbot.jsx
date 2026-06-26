import React, { useEffect, useRef, useState } from "react";
import ChatRoundedIcon from "@mui/icons-material/ChatRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import {
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Drawer,
  Fab,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import { API_BASE_URL } from "../config";

const starterPrompts = [
  "Errors last hour",
  "Show JMS queues",
  "Show JMS resources",
  "Download Excel"
];

const getStoredPackages = () => {
  try {
    return JSON.parse(localStorage.getItem("packages") || "[]");
  } catch {
    return [];
  }
};

const toDisplayText = (value, fallback = "") => {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toDisplayText(entry)).filter(Boolean).join(", ") || fallback;
  }

  if (value.__deferred?.uri) {
    return value.__deferred.uri;
  }

  if (value.Name || value.Id || value.Value || value.value || value.Message || value.message) {
    return toDisplayText(value.Name || value.Id || value.Value || value.value || value.Message || value.message, fallback);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
};


const formatDate = (value) => {
  if (!value) return "";
  if (typeof value === "string") {
    const match = value.match(/\/Date\((\d+)\)\//);
    if (match) {
      return new Date(parseInt(match[1])).toLocaleString("en-IN", { hour12: false });
    }
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toLocaleString("en-IN", { hour12: false });
  }
  return String(value);
};

const formatItem = (item) => {
  if (item.type === "report") {
    return {
      title: toDisplayText(item.mplId || item.iflowName, "Monitoring row"),
      meta: [item.status, item.iflowName, item.logStart].map((value) => toDisplayText(value)).filter(Boolean).join(" | "),
      detail: item.errorInfo && item.errorInfo !== "-" ? toDisplayText(item.errorInfo) : toDisplayText(item.payloadFileName)
    };
  }

  if (item.type === "jms-queue") {
    return {
      title: toDisplayText(item.name || item.key, "Queue"),
      meta: [`State: ${toDisplayText(item.state, "-")}`, `Entries: ${toDisplayText(item.entries ?? 0)}`].join(" | "),
      detail: [`Access: ${toDisplayText(item.accessType, "-")}`, `Usage: ${toDisplayText(item.usage, "-")}`].join(" | ")
    };
  }

  if (item.type === "jms-message") {
    return {
      title: toDisplayText(item.jmsMessageId || item.messageId, "JMS message"),
      meta: [item.status, item.createdAt, item.retryCount ? `Retries: ${item.retryCount}` : ""].map((value) => toDisplayText(value)).filter(Boolean).join(" | "),
      detail: [item.iflowName, item.correlationId].map((value) => toDisplayText(value)).filter(Boolean).join(" | ")
    };
  }

  if (item.type === "artifact") {
    return {
      title: toDisplayText(item.Name || item.Id, "Artifact"),
      meta: [item.Type, item.Status].map((value) => toDisplayText(value)).filter(Boolean).join(" | "),
      detail: toDisplayText(item.PackageId || item.PackageName)
    };
  }

  if (item.type === "pgp-key") {
    const validUntil = item.ValidityEnd || item.Validity || item.ValidUntil;
    return {
      title: toDisplayText(item.Alias || item.KeyId || "PGP Key"),
      meta: [
        item.KeyType ? `Type: ${item.KeyType}` : "",
        item.Owner ? `Owner: ${item.Owner}` : "",
        item.KeyId ? `Key ID: ${item.KeyId}` : ""
      ].filter(Boolean).join(" | "),
      detail: [
        validUntil ? `Valid Until: ${formatDate(validUntil)}` : "",
        item.ValidityStart ? `Valid From: ${formatDate(item.ValidityStart)}` : "",
        item.CreatedBy ? `Created By: ${item.CreatedBy}` : ""
      ].filter(Boolean).join(" \n ")
    };
  }

  if (item.type === "keystore-entry") {
    const validUntil = item.ValidityEnd || item.Validity || item.ValidUntil;
    const validFrom = item.ValidityStart || item.ValidFrom;
    return {
      title: toDisplayText(item.Alias || "Keystore Entry"),
      meta: [
        item.Type ? `Type: ${item.Type}` : "",
        item.KeySize ? `Size: ${item.KeySize} bits` : "",
        validUntil ? `Valid Until: ${formatDate(validUntil)}` : ""
      ].filter(Boolean).join(" | "),
      detail: [
        item.Owner ? `Owner: ${item.Owner}` : "",
        item.Issuer ? `Issuer: ${item.Issuer}` : "",
        item.Subject ? `Subject: ${item.Subject}` : "",
        validFrom ? `Valid From: ${formatDate(validFrom)}` : ""
      ].filter(Boolean).join(" \n ")
    };
  }

  if (item.type === "security-material") {
    const lastMod = item.LastModifiedTime || item.ModifiedAt || item.LastModifiedBy;
    return {
      title: toDisplayText(item.Name || "Security Material"),
      meta: [
        item.Type ? `Type: ${item.Type}` : "",
        item.User ? `User: ${item.User}` : ""
      ].filter(Boolean).join(" | "),
      detail: [
        item.Description ? `Description: ${item.Description}` : "",
        lastMod ? `Modified: ${formatDate(lastMod)}` : ""
      ].filter(Boolean).join(" \n ")
    };
  }

  if (item.type === "access-policy") {
    return {
      title: toDisplayText(item.Id || "Access Policy"),
      meta: [
        item.UserRole ? `Role: ${item.UserRole}` : "",
        item.ArtifactId ? `Artifact: ${item.ArtifactId}` : ""
      ].filter(Boolean).join(" | "),
      detail: toDisplayText(item.Description)
    };
  }

  if (item.type === "user-role") {
    return {
      title: toDisplayText(item.RoleName || "User Role"),
      meta: "",
      detail: toDisplayText(item.Description)
    };
  }

  if (item.type === "data-store") {
    const isEntry = item.Id !== undefined;
    const expiry = item.RetainUntil || item.ExpiresAt || item.DueAt;
    const created = item.CreatedAt || item.UpdatedAt;
    return {
      title: toDisplayText(item.DataStoreName || "Data Store"),
      meta: [
        item.Type ? `Type: ${item.Type}` : "",
        isEntry ? `Entry ID: ${item.Id}` : "",
        item.Status ? `Status: ${item.Status}` : "",
        item.NumberOfMessages ? `Messages: ${item.NumberOfMessages}` : ""
      ].filter(Boolean).join(" | "),
      detail: [
        item.IntegrationFlow ? `iFlow/Artifact: ${item.IntegrationFlow}` : "",
        item.MessageId ? `Message ID: ${item.MessageId}` : "",
        created ? `Created At: ${formatDate(created)}` : "",
        expiry ? `Expires/Due: ${formatDate(expiry)}` : ""
      ].filter(Boolean).join(" \n ")
    };
  }

  if (item.type === "variable") {
    return {
      title: toDisplayText(item.VariableName || item.Name || "Variable"),
      meta: [
        item.Visibility ? `Visibility: ${item.Visibility}` : "",
        item.IntegrationFlow ? `iFlow: ${item.IntegrationFlow}` : ""
      ].filter(Boolean).join(" | "),
      detail: [
        item.UpdatedAt ? `Updated: ${formatDate(item.UpdatedAt)}` : "",
        item.RetainUntil ? `Retain Until: ${formatDate(item.RetainUntil)}` : ""
      ].filter(Boolean).join(" \n ")
    };
  }

  if (item.type === "number-range") {
    return {
      title: toDisplayText(item.Name || "Number Range"),
      meta: `Current: ${toDisplayText(item.CurrentValue ?? "-")} / Max: ${toDisplayText(item.MaxValue ?? "-")}`,
      detail: [
        item.MinValue ? `Min: ${item.MinValue}` : "",
        item.Rotate ? `Rotate: ${item.Rotate}` : "",
        item.Description ? `Description: ${item.Description}` : "",
        item.DeployedOn ? `Deployed On: ${formatDate(item.DeployedOn)}` : ""
      ].filter(Boolean).join(" \n ")
    };
  }

  if (item.type === "partner-directory-entry") {
    return {
      title: toDisplayText(item.Id || "Partner Entry"),
      meta: [
        item.Pid ? `Partner ID: ${item.Pid}` : "",
        item.Type ? `Type: ${item.Type}` : ""
      ].filter(Boolean).join(" | "),
      detail: toDisplayText(item.Value)
    };
  }

  if (item.type === "message-lock") {
    return {
      title: toDisplayText(item.MessageId || "Message Lock"),
      meta: [
        item.LockOwner ? `Owner: ${item.LockOwner}` : "",
        item.ArtifactId ? `Artifact: ${item.ArtifactId}` : ""
      ].filter(Boolean).join(" | "),
      detail: item.LockTime ? `Locked At: ${formatDate(item.LockTime)}` : ""
    };
  }

  if (item.type === "system-log") {
    const sizeStr = item.FileSize ? `${(Number(item.FileSize) / 1024).toFixed(2)} KB` : "";
    return {
      title: toDisplayText(item.LogFileName || "System Log"),
      meta: [
        sizeStr ? `Size: ${sizeStr}` : "",
        item.Date ? `Date: ${formatDate(item.Date)}` : ""
      ].filter(Boolean).join(" | "),
      detail: ""
    };
  }

  if (item.type === "usage-detail") {
    return {
      title: item.Date ? `Usage on ${formatDate(item.Date)}` : "Usage Detail",
      meta: item.Count ? `Count: ${item.Count}` : "",
      detail: toDisplayText(item.Resource)
    };
  }

  if (item.type === "connectivity-test") {
    return {
      title: `Test to ${toDisplayText(item.Host)}:${toDisplayText(item.Port)}`,
      meta: [
        item.Protocol ? `Protocol: ${item.Protocol}` : "",
        item.Status ? `Status: ${item.Status}` : ""
      ].filter(Boolean).join(" | "),
      detail: toDisplayText(item.Message || item.Detail)
    };
  }

  if (item.type === "package") {
    return {
      title: toDisplayText(item.Name || item.Id, "Package"),
      meta: toDisplayText(item.Id),
      detail: item.Version ? `Version: ${toDisplayText(item.Version)}` : ""
    };
  }

  if (item.type === "resource") {
    return {
      title: toDisplayText(item.key, "JMS Resource"),
      meta: `Queues: ${toDisplayText(item.queueNumber)}/${toDisplayText(item.maxQueueNumber)}`,
      detail: `Capacity: ${toDisplayText(item.capacity)}/${toDisplayText(item.maxCapacity)}`
    };
  }

  if (item.type === "tenant-overview") {
    return {
      title: "Tenant overview",
      meta: [
        `Messages: ${toDisplayText(item.messages ?? 0)}`,
        `Failed: ${toDisplayText(item.failedMessages ?? 0)}`,
        `Completed: ${toDisplayText(item.completedMessages ?? 0)}`
      ].join(" | "),
      detail: [
        `Packages: ${toDisplayText(item.packages ?? 0)}`,
        `Artifacts: ${toDisplayText(item.artifacts ?? 0)}`,
        `Error artifacts: ${toDisplayText(item.errorArtifacts ?? 0)}`
      ].join(" | ")
    };
  }

  if (item.type === "message-status-overview") {
    return {
      title: toDisplayText(item.artifactName, "Artifact"),
      meta: [
        `Failed: ${toDisplayText(item.FAILED ?? 0)}`,
        `Retry: ${toDisplayText(item.RETRY ?? 0)}`,
        `Completed: ${toDisplayText(item.COMPLETED ?? 0)}`
      ].join(" | "),
      detail: [
        `Processing: ${toDisplayText(item.PROCESSING ?? 0)}`,
        `Escalated: ${toDisplayText(item.ESCALATED ?? 0)}`,
        `Total: ${toDisplayText(item.total ?? 0)}`
      ].join(" | ")
    };
  }

  if (item.type === "integration-resource") {
    return {
      title: toDisplayText(item.Name || item.Id || item.NameId || item.Alias || item.resource, item.resource || "Resource"),
      meta: toDisplayText(item.Type || item.Kind || item.Status || item.ModifiedAt || item.CreatedAt),
      detail: toDisplayText(item.Description || item.Value || item.Url || item.User || item.PackageId)
    };
  }

  return {
    title: toDisplayText(item.title || item.name, "Item"),
    meta: toDisplayText(item.status),
    detail: toDisplayText(item.detail)
  };
};

const SearchableChatItems = ({ items }) => {
  const [selectedItem, setSelectedItem] = useState(items[0] || null);
  const itemType = items[0]?.type;

  const getLabel = (type) => {
    switch (type) {
      case "artifact": return "Search artifact";
      case "pgp-key": return "Search PGP key";
      case "package": return "Search package";
      case "keystore-entry": return "Search Keystore Entry / Certificate";
      case "security-material": return "Search Security Material";
      case "access-policy": return "Search Access Policy";
      case "user-role": return "Search User Role";
      case "data-store": return "Search Data Store";
      case "variable": return "Search Variable";
      case "number-range": return "Search Number Range";
      case "partner-directory-entry": return "Search Partner Directory Entry";
      case "message-lock": return "Search Message Lock";
      case "system-log": return "Search System Log File";
      case "usage-detail": return "Search Usage Detail";
      case "connectivity-test": return "Search Connectivity Test Endpoint";
      default: return "Search item";
    }
  };

  const getPlaceholder = (type) => {
    switch (type) {
      case "artifact": return "artifacts";
      case "pgp-key": return "PGP keys";
      case "package": return "packages";
      case "keystore-entry": return "keystore entries";
      case "security-material": return "security materials";
      case "access-policy": return "access policies";
      case "user-role": return "user roles";
      case "data-store": return "data stores";
      case "variable": return "variables";
      case "number-range": return "number ranges";
      case "partner-directory-entry": return "partner directory entries";
      case "message-lock": return "message locks";
      case "system-log": return "system logs";
      case "usage-detail": return "usage details";
      case "connectivity-test": return "connectivity tests";
      default: return "items";
    }
  };

  const label = getLabel(itemType);
  const placeholder = getPlaceholder(itemType);
  const selected = selectedItem ? formatItem(selectedItem) : null;

  return (
    <Stack spacing={1.25} sx={{ mt: 1.25 }}>
      <Autocomplete
        size="small"
        options={items}
        value={selectedItem}
        onChange={(_, value) => setSelectedItem(value)}
        getOptionLabel={(option) => {
          const formatted = formatItem(option);
          return [formatted.title, formatted.meta].filter(Boolean).join(" - ");
        }}
        isOptionEqualToValue={(option, value) =>
          toDisplayText(option.Id || option.Name || option.id || option.title || option.Alias) ===
          toDisplayText(value.Id || value.Name || value.id || value.title || value.Alias)
        }
        renderInput={(params) => (
          <TextField
            {...params}
            label={label}
            placeholder={`Search ${items.length} ${placeholder}`}
          />
        )}
      />

      {selected && (
        <Box sx={{ borderTop: "1px solid #e5edf5", pt: 1 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 700, color: "#0f172a", wordBreak: "break-word" }}>
            {toDisplayText(selected.title)}
          </Typography>
          {selected.meta && (
            <Typography sx={{ fontSize: 12, color: "#516b89", wordBreak: "break-word" }}>
              {toDisplayText(selected.meta)}
            </Typography>
          )}
          {selected.detail && (
            <Typography sx={{ fontSize: 12, color: "#64748b", wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
              {toDisplayText(selected.detail)}
            </Typography>
          )}
        </Box>
      )}
    </Stack>
  );
};

const downloadFromAction = async (action) => {
  const response = await fetch(`${API_BASE_URL}${action.url}`);
  if (!response.ok) {
    throw new Error("Download failed.");
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = action.label.toLowerCase().includes("excel")
    ? "Monitoring_Overview.xlsx"
    : action.label.toLowerCase().includes("payload")
      ? "datastore_entry_payload.txt"
      : "iFlow_Payload_files.zip";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
};

const readActionResponse = async (response) => {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  return { message: text || (response.ok ? "Action completed." : "Action failed.") };
};

const AppChatbot = () => {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState([
    {
      role: "bot",
      text: "Hi, How can i help you today?",
      items: [],
      actions: []
    }
  ]);
  const [loading, setLoading] = useState(false);
  const [pendingItems, setPendingItems] = useState([]);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const sendPrompt = async (value = prompt) => {
    const cleanPrompt = String(value || "").trim();
    if (!cleanPrompt || loading) {
      return;
    }

    setPrompt("");
    setMessages((current) => [...current, { role: "user", text: cleanPrompt, items: [], actions: [] }]);

    if (/^(yes|show|list)$/i.test(cleanPrompt) && pendingItems.length > 0) {
      setMessages((current) => [
        ...current,
        {
          role: "bot",
          text: `Showing ${pendingItems.length} item(s).`,
          items: pendingItems,
          actions: []
        }
      ]);
      setPendingItems([]);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/chatbot/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: cleanPrompt,
          token: localStorage.getItem("token"),
          baseUrl: localStorage.getItem("baseUrl"),
          packages: getStoredPackages()
        })
      });
      const data = await response.json();

      if (!response.ok) {
        const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail || "");
        throw new Error([data.message, detail].filter(Boolean).join(" "));
      }

      setPendingItems(Array.isArray(data.pendingItems) ? data.pendingItems : []);
      setMessages((current) => [
        ...current,
        {
          role: "bot",
          text: toDisplayText(data.message, "Done."),
          items: Array.isArray(data.items) ? data.items : [],
          actions: Array.isArray(data.actions) ? data.actions : []
        }
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          role: "bot",
          text: toDisplayText(error.message, "I could not process that request."),
          items: [],
          actions: []
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const runAction = async (action) => {
    try {
      if (action.method === "GET" && action.url) {
        await downloadFromAction(action);
        return;
      }

      if (action.endpoint) {
        const response = await fetch(`${API_BASE_URL}${action.endpoint}`, {
          method: action.method || "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action.body || {})
        });
        const data = await readActionResponse(response);
        if (!response.ok) {
          throw new Error(toDisplayText(data.message, "Action failed."));
        }

        setMessages((current) => [
          ...current,
          {
            role: "bot",
            text: action.successMessage || toDisplayText(data.message, "Action completed."),
            items: [],
            actions: Array.isArray(action.nextActions) ? action.nextActions : []
          }
        ]);
      }
    } catch (error) {
      setMessages((current) => [
        ...current,
        { role: "bot", text: toDisplayText(error.message, "Action failed."), items: [], actions: [] }
      ]);
    }
  };

  return (
    <>
      <Tooltip title="Assistant">
        <Fab
          color="primary"
          onClick={() => setOpen(true)}
          sx={{
            position: "fixed",
            right: 24,
            bottom: 24,
            zIndex: 1200,
            backgroundColor: "#0b84d6"
          }}
        >
          <ChatRoundedIcon />
        </Fab>
      </Tooltip>

      <Drawer anchor="right" open={open} onClose={() => setOpen(false)}>
        <Box sx={{ width: { xs: "100vw", sm: 520 }, height: "100%", display: "flex", flexDirection: "column" }}>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{
              px: 2.5,
              py: 2,
              color: "#ffffff",
              background: "#0b84d6"
            }}
          >
            <Box>
              <Typography sx={{ fontWeight: 900, letterSpacing: 0.2 }}>Tenant Assistant</Typography>
            </Box>
            <IconButton onClick={() => setOpen(false)} sx={{ color: "#ffffff" }}>
              <CloseRoundedIcon />
            </IconButton>
          </Stack>

          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{
              px: 2,
              py: 1.5,
              borderBottom: "1px solid #dbe7ef",
              flexWrap: "wrap",
              backgroundColor: "#f7fbfc"
            }}
          >
            {starterPrompts.map((starter) => (
              <Button
                key={starter}
                size="small"
                variant="outlined"
                onClick={() => sendPrompt(starter)}
                sx={{
                  borderRadius: 999,
                  whiteSpace: "nowrap",
                  textTransform: "none",
                  fontWeight: 700,
                  borderColor: "#7cc7d1",
                  color: "#075163",
                  backgroundColor: "#ffffff"
                }}
              >
                {starter}
              </Button>
            ))}
          </Stack>

          <Stack
            ref={scrollRef}
            spacing={1.75}
            sx={{
              flex: 1,
              overflowY: "auto",
              p: 2,
              background:
                "radial-gradient(circle at top left, rgba(22,160,133,0.12), transparent 34%), linear-gradient(180deg, #f6fafb 0%, #eef5f7 100%)"
            }}
          >
            {messages.map((message, index) => (
              <Paper
                key={`${message.role}-${index}`}
                elevation={0}
                sx={{
                  alignSelf: message.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: message.role === "user" ? "82%" : "90%",
                  p: 1.75,
                  borderRadius: message.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                  border: "1px solid rgba(8, 65, 84, 0.12)",
                  boxShadow: "0 10px 26px rgba(15, 52, 67, 0.08)",
                  backgroundColor: message.role === "user" ? "#d9f4f7" : "#ffffff"
                }}
              >
                <Typography sx={{ fontSize: 14, color: "#1f2937", whiteSpace: "pre-wrap" }}>
                  {toDisplayText(message.text)}
                </Typography>

                {message.items?.length > 0 && [
                  "package", "artifact", "pgp-key", "keystore-entry", "security-material",
                  "access-policy", "user-role", "data-store", "variable", "number-range",
                  "partner-directory-entry", "message-lock", "system-log", "usage-detail", "connectivity-test"
                ].includes(message.items[0]?.type) && (
                  <SearchableChatItems items={message.items} />
                )}

                {message.items?.length > 0 && ![
                  "package", "artifact", "pgp-key", "keystore-entry", "security-material",
                  "access-policy", "user-role", "data-store", "variable", "number-range",
                  "partner-directory-entry", "message-lock", "system-log", "usage-detail", "connectivity-test"
                ].includes(message.items[0]?.type) && (
                  <Stack spacing={1} sx={{ mt: 1.25 }}>
                    {message.items.map((item, itemIndex) => {
                      const formatted = formatItem(item);
                      return (
                        <Box key={`${toDisplayText(formatted.title)}-${itemIndex}`} sx={{ borderTop: "1px solid #e5edf5", pt: 1 }}>
                          <Typography sx={{ fontSize: 13, fontWeight: 700, color: "#0f172a", wordBreak: "break-word" }}>
                            {toDisplayText(formatted.title)}
                          </Typography>
                          {formatted.meta && (
                            <Typography sx={{ fontSize: 12, color: "#516b89", wordBreak: "break-word" }}>
                              {toDisplayText(formatted.meta)}
                            </Typography>
                          )}
                          {formatted.detail && (
                            <Typography sx={{ fontSize: 12, color: "#64748b", wordBreak: "break-word" }}>
                              {toDisplayText(formatted.detail)}
                            </Typography>
                          )}
                        </Box>
                      );
                    })}
                  </Stack>
                )}

                {message.actions?.length > 0 && (
                  <Stack direction="row" spacing={1} sx={{ mt: 1.25, flexWrap: "wrap" }}>
                    {message.actions.map((action) => (
                      <Button
                        key={action.label}
                        size="small"
                        variant="contained"
                        startIcon={action.method === "GET" ? <DownloadRoundedIcon /> : undefined}
                        onClick={() => runAction(action)}
                        sx={{ textTransform: "none" }}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </Stack>
                )}
              </Paper>
            ))}
            {loading && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ color: "#64748b" }}>
                <CircularProgress size={16} />
                <Typography sx={{ fontSize: 13 }}>Working...</Typography>
              </Stack>
            )}
          </Stack>

          <Stack direction="row" spacing={1} sx={{ p: 2, borderTop: "1px solid #d7dee8", backgroundColor: "#ffffff" }}>
            <TextField
              size="small"
              fullWidth
              value={prompt}
              placeholder="Example: past hour error messages"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  sendPrompt();
                }
              }}
            />
            <IconButton
              onClick={() => sendPrompt()}
              disabled={loading || !prompt.trim()}
              sx={{
                color: "#ffffff",
                backgroundColor: "#0b6b7d",
                "&:hover": { backgroundColor: "#075163" },
                "&.Mui-disabled": { color: "#94a3b8", backgroundColor: "#e2e8f0" }
              }}
            >
              <SendRoundedIcon />
            </IconButton>
          </Stack>
        </Box>
      </Drawer>
    </>
  );
};

export default AppChatbot;
