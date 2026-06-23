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
  const label = itemType === "artifact" ? "Search artifact" : "Search package";
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
          toDisplayText(option.Id || option.Name || option.id || option.title) ===
          toDisplayText(value.Id || value.Name || value.id || value.title)
        }
        renderInput={(params) => (
          <TextField
            {...params}
            label={label}
            placeholder={`Search ${items.length} ${itemType === "artifact" ? "artifacts" : "packages"}`}
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
            <Typography sx={{ fontSize: 12, color: "#64748b", wordBreak: "break-word" }}>
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

                {message.items?.length > 0 && ["package", "artifact"].includes(message.items[0]?.type) && (
                  <SearchableChatItems items={message.items} />
                )}

                {message.items?.length > 0 && !["package", "artifact"].includes(message.items[0]?.type) && (
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
