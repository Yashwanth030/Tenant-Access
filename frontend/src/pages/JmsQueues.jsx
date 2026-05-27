import React, { useCallback, useEffect, useMemo, useState } from "react";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import DriveFileMoveOutlinedIcon from "@mui/icons-material/DriveFileMoveOutlined";
import FormatListBulletedRoundedIcon from "@mui/icons-material/FormatListBulletedRounded";
import MoreHorizRoundedIcon from "@mui/icons-material/MoreHorizRounded";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  Menu,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography
} from "@mui/material";
import TopBar from "../components/TopBar";
import { API_BASE_URL } from "../config";

const JMS_QUEUE_WARNING_THRESHOLD = 27;
const JMS_BROKER_KEY = "Broker1";
const MB_DIVISOR = 1024 * 1024;

const messageFields = [
  { key: "messageId", label: "Message ID", color: "#0b63ce", isLinkish: true },
  { key: "status", label: "Status", toneMap: { Failed: "#c62828", Waiting: "#9a6700", Available: "#2e7d32" } },
  { key: "dueAt", label: "Due At" },
  { key: "createdAt", label: "Created At" },
  { key: "retainUntil", label: "Retain Until" },
  { key: "retryCount", label: "Retry Count" },
  { key: "nextRetryOn", label: "Next Retry On" },
  { key: "correlationId", label: "Correlation ID", color: "#0b63ce", isLinkish: true },
  { key: "iflowName", label: "iFlow Name" },
  { key: "packageName", label: "Package Name" }
];

const getErrorDetail = (data, fallback) => {
  if (typeof data?.detail === "string") {
    return data.detail;
  }

  if (data?.detail?.message) {
    return data.detail.message;
  }

  if (data?.detail?.error?.message?.value) {
    return data.detail.error.message.value;
  }

  return data?.message || fallback;
};

const formatCapacityMb = (valueInBytes) => `${(Number(valueInBytes || 0) / MB_DIVISOR).toFixed(2)} MB`;

const clampPercent = (value) => Math.max(0, Math.min(100, value));

const getAvailabilityLabel = (isHigh) => (Number(isHigh) > 0 ? "High" : "Available");

const JmsQueues = () => {
  const token = localStorage.getItem("token");
  const baseUrl = localStorage.getItem("baseUrl");
  const [queues, setQueues] = useState([]);
  const [selectedQueue, setSelectedQueue] = useState("");
  const [messages, setMessages] = useState([]);
  const [queuesLoading, setQueuesLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState("");
  const [showQueueDetails, setShowQueueDetails] = useState(false);
  const [queueFilter, setQueueFilter] = useState("");
  const [messageFilter, setMessageFilter] = useState("");
  const [selectedMessageIds, setSelectedMessageIds] = useState([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [targetQueueName, setTargetQueueName] = useState("");
  const [moveLoading, setMoveLoading] = useState(false);
  const [retryLoading, setRetryLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState("");
  const [resourceDetails, setResourceDetails] = useState(null);
  const [resourceLoading, setResourceLoading] = useState(false);
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false);
  const [queueActionsAnchorEl, setQueueActionsAnchorEl] = useState(null);
  const [queueActionsTarget, setQueueActionsTarget] = useState(null);
  const [messageActionsAnchorEl, setMessageActionsAnchorEl] = useState(null);

  const filteredQueues = useMemo(() => {
    const normalizedFilter = queueFilter.trim().toLowerCase();
    if (!normalizedFilter) {
      return queues;
    }

    return queues.filter((queue) => queue.name.toLowerCase().includes(normalizedFilter));
  }, [queueFilter, queues]);

  const filteredMessages = useMemo(() => {
    const normalizedFilter = messageFilter.trim().toLowerCase();
    if (!normalizedFilter) {
      return messages;
    }

    return messages.filter((message) =>
      [message.jmsMessageId, message.messageId, message.correlationId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedFilter))
    );
  }, [messageFilter, messages]);

  const allVisibleMessageIds = useMemo(
    () => filteredMessages.map((message) => message.id),
    [filteredMessages]
  );

  const allVisibleSelected =
    allVisibleMessageIds.length > 0 &&
    allVisibleMessageIds.every((messageId) => selectedMessageIds.includes(messageId));

  const hasPartialSelection =
    allVisibleMessageIds.some((messageId) => selectedMessageIds.includes(messageId)) &&
    !allVisibleSelected;

  const toggleMessageSelection = (messageId) => {
    setSelectedMessageIds((currentIds) =>
      currentIds.includes(messageId)
        ? currentIds.filter((id) => id !== messageId)
        : [...currentIds, messageId]
    );
  };

  const toggleSelectAllVisible = () => {
    setSelectedMessageIds((currentIds) => {
      if (allVisibleSelected) {
        return currentIds.filter((id) => !allVisibleMessageIds.includes(id));
      }

      return Array.from(new Set([...currentIds, ...allVisibleMessageIds]));
    });
  };

  const toggleSelectionMode = () => {
    setSelectionMode((currentValue) => {
      if (currentValue) {
        setSelectedMessageIds([]);
      }

      return !currentValue;
    });
  };

  const selectedMessages = useMemo(
    () => messages.filter((message) => selectedMessageIds.includes(message.id)),
    [messages, selectedMessageIds]
  );

  const hasSelectedMessages = selectedMessages.length > 0;

  const hasWaitingMessages = useMemo(
    () => selectedMessages.some((message) => message.status === "Waiting"),
    [selectedMessages]
  );

  const startedQueuesCount = useMemo(
    () => queues.filter((queue) => queue.state === "Started").length,
    [queues]
  );

  const stoppedQueuesCount = Math.max(queues.length - startedQueuesCount, 0);

  const resourceSummary = useMemo(() => {
    if (!resourceDetails) {
      return null;
    }

    const queueUsagePercent = resourceDetails.maxQueueNumber > 0
      ? clampPercent((resourceDetails.queueNumber / resourceDetails.maxQueueNumber) * 100)
      : 0;
    const capacityUsagePercent = resourceDetails.maxCapacity > 0
      ? clampPercent((resourceDetails.capacity / resourceDetails.maxCapacity) * 100)
      : 0;
    const isCritical = resourceDetails.queueNumber > JMS_QUEUE_WARNING_THRESHOLD;

    return {
      ...resourceDetails,
      isCritical,
      queueUsagePercent,
      capacityUsagePercent,
      currentCapacityLabel: formatCapacityMb(resourceDetails.capacity),
      maxCapacityLabel: `${Math.round(resourceDetails.maxCapacity / MB_DIVISOR)} MB`,
      queueUsageLabel: `OK(${resourceDetails.capacityOk}) / Critical(${resourceDetails.capacityWarning}) / Error(${resourceDetails.capacityError})`,
      queueStateLabel: `Started(${startedQueuesCount}) / Stopped(${stoppedQueuesCount})`,
      transactionsLabel: getAvailabilityLabel(resourceDetails.isTransactedSessionsHigh),
      providersLabel: getAvailabilityLabel(resourceDetails.isProducersHigh),
      consumersLabel: getAvailabilityLabel(resourceDetails.isConsumersHigh)
    };
  }, [resourceDetails, startedQueuesCount, stoppedQueuesCount]);

  const loadQueues = useCallback(async (options = {}) => {
    const { preserveSelection = false } = options;

    setQueuesLoading(true);
    setError("");

    if (!preserveSelection) {
      setMessages([]);
      setSelectedQueue("");
      setSelectedMessageIds([]);
      setSelectionMode(false);
    }

    try {
      const response = await fetch(`${API_BASE_URL}/jms-queues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, baseUrl })
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(getErrorDetail(data, "Failed to load JMS queues."));
      }

      setQueues(Array.isArray(data.queues) ? data.queues : []);
    } catch (loadError) {
      console.error("failed to load JMS queues", loadError);
      setError(loadError.message || "Failed to load JMS queues.");
    } finally {
      setQueuesLoading(false);
    }
  }, [baseUrl, token]);

  const loadMessages = useCallback(async (queue) => {
    setShowQueueDetails(true);
    setSelectedQueue(queue.key || queue.name);
    setMessages([]);
    setMessagesLoading(true);
    setError("");
    setSelectedMessageIds([]);
    setSelectionMode(false);

    try {
      const response = await fetch(`${API_BASE_URL}/jms-messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          baseUrl,
          queueName: queue.name,
          queueKey: queue.key || queue.name
        })
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(getErrorDetail(data, "Failed to load JMS messages."));
      }

      setMessages(Array.isArray(data.messages) ? data.messages : []);
    } catch (loadError) {
      console.error("failed to load JMS messages", loadError);
      setError(loadError.message || "Failed to load JMS messages.");
    } finally {
      setMessagesLoading(false);
    }
  }, [baseUrl, token]);

  const openMoveDialog = () => {
    setTargetQueueName("");
    setMoveDialogOpen(true);
  };

  const selectedQueueRecord = useMemo(
    () => queues.find((queue) => (queue.key || queue.name) === selectedQueue) || null,
    [queues, selectedQueue]
  );

  const closeMoveDialog = () => {
    if (moveLoading) {
      return;
    }

    setMoveDialogOpen(false);
    setTargetQueueName("");
  };

  const handleMoveMessages = async () => {
    if (!targetQueueName || !selectedQueue || selectedMessages.length === 0) {
      return;
    }

    setMoveLoading(true);
    setError("");

    try {
      const sourceQueue = queues.find((queue) => (queue.key || queue.name) === selectedQueue);
      const response = await fetch(`${API_BASE_URL}/jms-messages/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          baseUrl,
          sourceQueueName: sourceQueue?.name || selectedQueue,
          targetQueueName,
          messages: selectedMessages.map((message) => ({
            jmsMessageId: message.jmsMessageId,
            failed: message.failed
          }))
        })
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(getErrorDetail(data, "Failed to move JMS messages."));
      }

      closeMoveDialog();
      await loadQueues({ preserveSelection: true });

      if (sourceQueue) {
        await loadMessages(sourceQueue);
      }
    } catch (moveError) {
      console.error("failed to move JMS messages", moveError);
      setError(moveError.message || "Failed to move JMS messages.");
    } finally {
      setMoveLoading(false);
    }
  };

  const refreshCurrentQueue = useCallback(async () => {
    await loadQueues({ preserveSelection: true });

    if (selectedQueueRecord) {
      await loadMessages(selectedQueueRecord);
    }
  }, [loadMessages, loadQueues, selectedQueueRecord]);

  const handleRetryMessages = async () => {
    if (!selectedQueueRecord || selectedMessages.length === 0) {
      return;
    }

    setRetryLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE_URL}/jms-messages/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          baseUrl,
          sourceQueueName: selectedQueueRecord.name,
          messages: selectedMessages.map((message) => ({
            jmsMessageId: message.jmsMessageId,
            failed: message.failed
          }))
        })
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(getErrorDetail(data, "Failed to retry JMS messages."));
      }

      await refreshCurrentQueue();
    } catch (retryError) {
      console.error("failed to retry JMS messages", retryError);
      setError(retryError.message || "Failed to retry JMS messages.");
    } finally {
      setRetryLoading(false);
    }
  };

  const openDeleteDialog = () => {
    if (!selectedQueueRecord || selectedMessages.length === 0) {
      return;
    }

    setDeleteConfirmationText("");
    setDeleteDialogOpen(true);
  };

  const closeDeleteDialog = () => {
    if (deleteLoading) {
      return;
    }

    setDeleteDialogOpen(false);
    setDeleteConfirmationText("");
  };

  const handleDeleteMessages = async () => {
    if (!selectedQueueRecord || selectedMessages.length === 0) {
      return;
    }

    setDeleteLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE_URL}/jms-messages/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          baseUrl,
          sourceQueueName: selectedQueueRecord.name,
          messages: selectedMessages.map((message) => ({
            jmsMessageId: message.jmsMessageId,
            failed: message.failed
          }))
        })
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(getErrorDetail(data, "Failed to delete JMS messages."));
      }

      closeDeleteDialog();
      await refreshCurrentQueue();
    } catch (deleteError) {
      console.error("failed to delete JMS messages", deleteError);
      setError(deleteError.message || "Failed to delete JMS messages.");
    } finally {
      setDeleteLoading(false);
    }
  };

  const loadJmsResourceDetails = async () => {
    setResourceLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE_URL}/jms-resource-details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          baseUrl,
          brokerKey: JMS_BROKER_KEY
        })
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(getErrorDetail(data, "Failed to load JMS resource details."));
      }

      setResourceDetails(data.resource || null);
    } catch (loadError) {
      console.error("failed to load JMS resource details", loadError);
      setError(loadError.message || "Failed to load JMS resource details.");
    } finally {
      setResourceLoading(false);
    }
  };

  const openQueueDetails = () => {
    setShowQueueDetails(true);

    if (!resourceLoading) {
      void loadJmsResourceDetails();
    }
  };

  const openQueueActionsMenu = (event, queue) => {
    event.stopPropagation();
    setQueueActionsAnchorEl(event.currentTarget);
    setQueueActionsTarget(queue);
  };

  const closeQueueActionsMenu = () => {
    setQueueActionsAnchorEl(null);
    setQueueActionsTarget(null);
  };

  const openMessageActionsMenu = (event) => {
    setMessageActionsAnchorEl(event.currentTarget);
  };

  const closeMessageActionsMenu = () => {
    setMessageActionsAnchorEl(null);
  };

  const reloadCurrentSelection = async () => {
    closeMessageActionsMenu();
    await refreshCurrentQueue();
  };

  useEffect(() => {
    loadQueues();
  }, [loadQueues]);

  return (
    <Box sx={{ minHeight: "100vh", background: "#f6f8fb", pb: 6 }}>
      <TopBar />
      <Container maxWidth="xl" sx={{ pt: { xs: 3, md: 5 } }}>
        <Stack spacing={2.5}>
<Paper
  elevation={0}
  sx={{
    p: { xs: 2.5, md: 3 },
    borderRadius: 2,
    border: "1px solid rgba(15, 23, 42, 0.08)",
    background: "rgba(13, 129, 182, 0.8)",
    color: "#ffffff"
  }}
>
  <Stack
    direction={{ xs: "column", sm: "row" }}
    justifyContent="space-between"
    alignItems={{ xs: "flex-start", sm: "center" }}
    spacing={1.5}
  >
    {/* LEFT TEXT */}
    <Box>
      <Typography variant="h5" fontWeight="bold">
        JMS Queues
      </Typography>
    </Box>

    {/* RIGHT BUTTON */}
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25}>
      <Button
        variant="contained"
        startIcon={<RefreshRoundedIcon />}
        onClick={loadQueues}
        disabled={queuesLoading}
        sx={{
          borderRadius: 2,
          backgroundColor: "#ffffff",
          color: "#0d81b6",

          "& .MuiSvgIcon-root": {
            color: "#0d81b6"
          },

          "&:hover": {
            backgroundColor: "#e0f2fe"
          }
        }}
      >
        {queuesLoading ? "Loading..." : "Refresh"}
      </Button>
    </Stack>
  </Stack>
</Paper>

          {error && (
            <Box
              sx={{
                borderRadius: 2.5,
                border: "1px solid #fecaca",
                background: "#fef2f2",
                color: "#b91c1c",
                px: 2,
                py: 1.5
              }}
            >
              <Typography variant="body2" fontWeight={600}>{error}</Typography>
            </Box>
          )}

          <Paper
            elevation={0}
            sx={{
              width: "100%",
              maxWidth: 320,
              border: "1px solid #d7dee8",
              borderRadius: 3,
              background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
              boxShadow: "0 14px 28px rgba(15, 23, 42, 0.06)",
              overflow: "hidden"
            }}
          >
            <Button
              fullWidth
              onClick={openQueueDetails}
              disabled={queuesLoading || queues.length === 0}
              sx={{
                minHeight: 196,
                px: 3,
                py: 3,
                display: "flex",
                alignItems: "stretch",
                justifyContent: "space-between",
                textTransform: "none",
                color: "inherit"
              }}
            >
              <Stack justifyContent="space-between" alignItems="flex-start" sx={{ height: "100%" }}>
                <Typography variant="h5" fontWeight={800} color="#1f2937">
                  Message Queues
                </Typography>
                <Typography variant="h3" sx={{ fontSize: { xs: 54, md: 64 }, color: "#6f89a5", fontWeight: 600 }}>
                  {queuesLoading ? <CircularProgress size={42} /> : queues.length}
                </Typography>
                <Typography variant="body1" color="#516b89" fontWeight={600}>
                  Available queues
                </Typography>
              </Stack>
              <Stack justifyContent="flex-end" alignItems="flex-end">
                <ArrowForwardRoundedIcon sx={{ fontSize: 28, color: "#0b84d6" }} />
              </Stack>
            </Button>
          </Paper>

          {resourceSummary && (
            <Box
              sx={{
                borderRadius: 2,
                border: resourceSummary.isCritical ? "1px solid #facc15" : "1px solid #bfdbfe",
                background: resourceSummary.isCritical ? "#fff8db" : "#eff6ff",
                px: 2,
                py: 1.5
              }}
            >
              <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap">
                {resourceSummary.isCritical ? (
                  <WarningAmberRoundedIcon sx={{ color: "#b45309" }} />
                ) : (
                  <InfoOutlinedIcon sx={{ color: "#1d4ed8" }} />
                )}
                <Typography sx={{ fontSize: 16, color: "#1f2937" }}>
                  {resourceSummary.isCritical
                    ? "JMS Resources: Critical."
                    : "JMS Resource Details."}
                </Typography>
                <Button
                  variant="text"
                  onClick={() => setResourceDialogOpen(true)}
                  sx={{
                    minWidth: 0,
                    p: 0,
                    textTransform: "none",
                    fontWeight: 700,
                    color: "#0b63ce",
                    "&:hover": {
                      background: "transparent",
                      textDecoration: "underline"
                    }
                  }}
                >
                  Details
                </Button>
              </Stack>
            </Box>
          )}

          {showQueueDetails && (
            <Stack direction={{ xs: "column", md: "row" }} spacing={2.5} alignItems="stretch">
              <Paper
                elevation={0}
                sx={{
                  width: { xs: "100%", md: 420 },
                  border: "1px solid #d7dee8",
                  borderRadius: 3,
                  overflow: "hidden",
                  background: "#ffffff",
                  boxShadow: "0 14px 28px rgba(15, 23, 42, 0.05)"
                }}
              >
                <Stack spacing={1.5} sx={{ px: 2.25, py: 1.75, borderBottom: "1px solid #d7dee8", background: "#fbfdff" }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography variant="h5" fontWeight={800}>
                      Queues ({queues.length})
                    </Typography>
                    <IconButton size="small">
                      <MoreHorizRoundedIcon />
                    </IconButton>
                  </Stack>
                  <TextField
                    size="small"
                    placeholder="Filter by Name"
                    value={queueFilter}
                    onChange={(event) => setQueueFilter(event.target.value)}
                    slotProps={{
                      input: {
                        startAdornment: (
                          <InputAdornment position="start">
                            <SearchRoundedIcon fontSize="small" />
                          </InputAdornment>
                        )
                      }
                    }}
                    sx={{
                      maxWidth: 280,
                      "& .MuiOutlinedInput-root": {
                        borderRadius: 2,
                        backgroundColor: "#ffffff"
                      }
                    }}
                  />
                </Stack>
                <Stack sx={{ maxHeight: 620, overflow: "auto" }}>
                  {queuesLoading ? (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 5 }}>
                      <CircularProgress size={28} />
                    </Box>
                  ) : filteredQueues.length === 0 ? (
                    <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                      No queues found.
                    </Typography>
                  ) : (
                    filteredQueues.map((queue) => (
                      <Box
                        key={queue.key || queue.name}
                        onClick={() => loadMessages(queue)}
                        sx={{
                          px: 2.25,
                          py: 1.8,
                          bgcolor: selectedQueue === (queue.key || queue.name) ? "#edf6ff" : "#ffffff",
                          borderBottom: "1px solid #eef2f6",
                          borderLeft: selectedQueue === (queue.key || queue.name) ? "3px solid #0b63ce" : "3px solid transparent",
                          cursor: "pointer",
                          transition: "all 0.2s ease",
                          "&:hover": {
                            bgcolor: "#f0f8ff"
                          }
                        }}
                      >
                        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
                          <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography
                              sx={{
                                fontSize: 16,
                                fontWeight: 500,
                                color: "#3d5d87",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap"
                              }}
                            >
                              {queue.name}
                            </Typography>
                            <Stack spacing={0.35} sx={{ mt: 1.25 }}>
                              <Typography variant="body2" sx={{ color: "#4f6b8a" }}>
                                Access Type:
                                {" "}
                                <Box component="span" sx={{ color: "#1f2937" }}>{queue.accessType}</Box>
                              </Typography>
                              <Typography variant="body2" sx={{ color: "#4f6b8a" }}>
                                Usage:
                                {" "}
                                <Box component="span" sx={{ color: queue.usage === "OK" ? "#2e7d32" : "#c62828" }}>{queue.usage}</Box>
                              </Typography>
                              <Typography variant="body2" sx={{ color: "#4f6b8a" }}>
                                State:
                                {" "}
                                <Box component="span" sx={{ color: queue.state === "Started" ? "#2e7d32" : "#c62828" }}>{queue.state}</Box>
                              </Typography>
                              <Typography variant="body2" sx={{ color: "#4f6b8a" }}>
                                Entries:
                                {" "}
                                <Box component="span" sx={{ color: "#1f2937" }}>{queue.entries ?? 0}</Box>
                              </Typography>
                            </Stack>
                          </Box>
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <IconButton
                              size="small"
                              onClick={(event) => openQueueActionsMenu(event, queue)}
                            >
                              <MoreHorizRoundedIcon fontSize="small" />
                            </IconButton>
                            <IconButton size="small" onClick={(event) => {
                              event.stopPropagation();
                              loadMessages(queue);
                            }}>
                              <ArrowForwardRoundedIcon fontSize="small" />
                            </IconButton>
                          </Stack>
                        </Stack>
                      </Box>
                    ))
                  )}
                </Stack>
              </Paper>

              <Paper
                elevation={0}
                sx={{
                  flex: 1,
                  border: "1px solid #d7dee8",
                  borderRadius: 3,
                  overflow: "hidden",
                  background: "#ffffff",
                  boxShadow: "0 14px 28px rgba(15, 23, 42, 0.05)"
                }}
              >
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  justifyContent="space-between"
                  alignItems={{ xs: "flex-start", sm: "center" }}
                  spacing={1.5}
                  sx={{ px: 2.5, py: 2, borderBottom: "1px solid #d7dee8", background: "#fbfdff" }}
                >
                  <Box>
                    <Typography variant="h5" fontWeight={800}>Messages ({filteredMessages.length})</Typography>
                  </Box>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ width: { xs: "100%", sm: "auto" } }}>
                    <TextField
                      size="small"
                      placeholder="Message ID, Correlation ID"
                      value={messageFilter}
                      onChange={(event) => setMessageFilter(event.target.value)}
                      slotProps={{
                        input: {
                          startAdornment: (
                            <InputAdornment position="start">
                              <SearchRoundedIcon fontSize="small" />
                            </InputAdornment>
                          )
                        }
                      }}
                      sx={{
                        minWidth: { xs: "100%", sm: 300 },
                        "& .MuiOutlinedInput-root": {
                          borderRadius: 2,
                          backgroundColor: "#ffffff"
                        }
                      }}
                    />
                    <Button
                      variant="text"
                      startIcon={<DriveFileMoveOutlinedIcon />}
                      disabled={!selectionMode || !hasSelectedMessages || moveLoading || retryLoading || deleteLoading}
                      onClick={openMoveDialog}
                      sx={{ textTransform: "none", fontWeight: 600, color: hasSelectedMessages ? "#0b63ce" : "#91b8ee" }}
                    >
                      {moveLoading ? "Moving..." : "Move"}
                    </Button>
                    <Button
                      variant="text"
                      startIcon={<ReplayRoundedIcon />}
                      disabled={!selectionMode || !hasSelectedMessages || moveLoading || retryLoading || deleteLoading || hasWaitingMessages}
                      onClick={handleRetryMessages}
                      sx={{ textTransform: "none", fontWeight: 600, color: hasSelectedMessages && !hasWaitingMessages ? "#0b63ce" : "#91b8ee" }}
                      title={hasWaitingMessages ? "Cannot retry messages with 'Waiting' status" : ""}
                    >
                      {retryLoading ? "Retrying..." : "Retry"}
                    </Button>
                    <Button
                      variant="text"
                      startIcon={<DeleteOutlineRoundedIcon />}
                      disabled={!selectionMode || !hasSelectedMessages || deleteLoading}
                      onClick={openDeleteDialog}
                      sx={{ textTransform: "none", fontWeight: 600, color: hasSelectedMessages ? "#0b63ce" : "#91b8ee" }}
                    >
                      {deleteLoading ? "Deleting..." : "Delete"}
                    </Button>
                    <IconButton size="small" sx={{ color: selectionMode ? "#0b63ce" : "#5f7fa5" }} onClick={toggleSelectionMode}>
                      <FormatListBulletedRoundedIcon />
                    </IconButton>
                    <IconButton size="small" sx={{ color: "#0b63ce" }} onClick={openMessageActionsMenu}>
                      <MoreHorizRoundedIcon />
                    </IconButton>
                    {messagesLoading && <CircularProgress size={22} />}
                  </Stack>
                </Stack>

                <Stack sx={{ maxHeight: 620, overflow: "auto", background: "#ffffff" }}>
                  {!selectedQueue ? (
                    <Typography sx={{ p: 3, color: "#64748b" }}>
                      Select a queue to view messages.
                    </Typography>
                  ) : messagesLoading ? (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 5 }}>
                      <CircularProgress size={24} />
                    </Box>
                  ) : filteredMessages.length === 0 ? (
                    <Typography sx={{ p: 3, color: "#64748b" }}>
                      No messages found in this queue.
                    </Typography>
                  ) : (
                    <>
                      <Box
                        sx={{
                          px: 2.25,
                          py: 1.2,
                          borderBottom: "1px solid #dde6ef",
                          backgroundColor: "#ffffff"
                        }}
                      >
                        <Stack direction="row" spacing={1.5} alignItems="center">
                          {selectionMode && (
                            <Checkbox
                              checked={allVisibleSelected}
                              indeterminate={hasPartialSelection}
                              onChange={toggleSelectAllVisible}
                              sx={{ p: 0.5, color: "#6b85a4" }}
                            />
                          )}
                          <Typography sx={{ fontSize: 15, fontWeight: 700, color: "#24364d" }}>
                            JMS Message ID
                          </Typography>
                        </Stack>
                      </Box>
                      {filteredMessages.map((message, index) => (
                        <Box
                          key={message.id}
                          sx={{
                            px: 2.25,
                            py: 2.25,
                            backgroundColor: index % 2 === 1 ? "#f4f7fb" : "#ffffff",
                            borderBottom: "1px solid #dde6ef"
                          }}
                        >
                          <Stack direction="row" spacing={1.5} alignItems="flex-start">
                            {selectionMode && (
                              <Checkbox
                                checked={selectedMessageIds.includes(message.id)}
                                onChange={() => toggleMessageSelection(message.id)}
                                sx={{ p: 0.5, mt: 0.1, color: "#6b85a4" }}
                              />
                            )}
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <Typography
                                sx={{
                                  fontSize: 16,
                                  fontWeight: 500,
                                  color: "#1f2937",
                                  wordBreak: "break-word"
                                }}
                              >
                                {message.jmsMessageId || "-"}
                              </Typography>
                              <Stack spacing={0.7} sx={{ mt: 1.5 }}>
                                {messageFields.map((field) => {
                                  const value = message[field.key];
                                  const displayValue = value || "-";
                                  return (
                                    <Typography key={`${message.id}-${field.key}`} sx={{ fontSize: 15, color: "#4f6b8a", lineHeight: 1.45 }}>
                                      {field.label}
                                      :{" "}
                                      <Box
                                        component="span"
                                        sx={{
                                          color:
                                            field.key === "status"
                                              ? field.toneMap?.[value] || "#1f2937"
                                              : field.color || "#1f2937",
                                          fontWeight: field.key === "status" || field.isLinkish ? 500 : 400,
                                          wordBreak: "break-word"
                                        }}
                                      >
                                        {displayValue}
                                      </Box>
                                    </Typography>
                                  );
                                })}
                              </Stack>
                            </Box>
                          </Stack>
                        </Box>
                      ))}
                    </>
                  )}
                </Stack>
              </Paper>
            </Stack>
          )}
        </Stack>
      </Container>

      <Dialog open={moveDialogOpen} onClose={closeMoveDialog} fullWidth maxWidth="sm">
        <DialogTitle>Move Messages</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Selected messages: {selectedMessages.length}
            </Typography>
            <TextField
              select
              label="Target Queue"
              value={targetQueueName}
              onChange={(event) => setTargetQueueName(event.target.value)}
              fullWidth
            >
              {queues
                .filter((queue) => queue.name !== (queues.find((queue) => (queue.key || queue.name) === selectedQueue)?.name || selectedQueue))
                .map((queue) => (
                  <MenuItem key={queue.key || queue.name} value={queue.name}>
                    {queue.name}
                  </MenuItem>
                ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeMoveDialog} disabled={moveLoading}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleMoveMessages}
            disabled={!targetQueueName || moveLoading || selectedMessages.length === 0}
          >
            {moveLoading ? "Moving..." : "Move"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={deleteDialogOpen} onClose={closeDeleteDialog} fullWidth maxWidth="sm">
        <DialogTitle sx={{ fontWeight: 700 }}>Delete Messages</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Stack spacing={2}>
            <Typography sx={{ color: "#24364d", lineHeight: 1.5 }}>
              Are you sure you want to delete {selectedMessages.length} selected message{selectedMessages.length === 1 ? "" : "s"} from the{" "}
              "{selectedQueueRecord?.name || selectedQueue}" queue?
            </Typography>
            <Typography sx={{ color: "#4f6b8a", lineHeight: 1.5 }}>
              This action removes the selected message{selectedMessages.length === 1 ? "" : "s"} from the tenant queue.
            </Typography>
            <Typography sx={{ color: "#24364d", fontWeight: 600 }}>
              Type DELETE to confirm
            </Typography>
            <TextField
              value={deleteConfirmationText}
              onChange={(event) => setDeleteConfirmationText(event.target.value)}
              fullWidth
              autoFocus
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={closeDeleteDialog} disabled={deleteLoading}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleDeleteMessages}
            disabled={deleteLoading || deleteConfirmationText.trim().toUpperCase() !== "DELETE"}
          >
            {deleteLoading ? "Deleting..." : "Delete"}
          </Button>
        </DialogActions>
      </Dialog>

      <Menu
        anchorEl={queueActionsAnchorEl}
        open={Boolean(queueActionsAnchorEl)}
        onClose={closeQueueActionsMenu}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.5,
              minWidth: 148,
              borderRadius: 2,
              border: "1px solid #d7dee8",
              boxShadow: "0 16px 32px rgba(15, 23, 42, 0.14)"
            }
          }
        }}
      >
        <MenuItem
          onClick={() => {
            closeQueueActionsMenu();
            if (queueActionsTarget) {
              setSelectedQueue(queueActionsTarget.key || queueActionsTarget.name);
            }
          }}
        >
          Retry
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (queueActionsTarget) {
              setSelectedQueue(queueActionsTarget.key || queueActionsTarget.name);
            }
            closeQueueActionsMenu();
          }}
        >
          Move
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (queueActionsTarget) {
              setSelectedQueue(queueActionsTarget.key || queueActionsTarget.name);
            }
            closeQueueActionsMenu();
            if (!resourceDetails && !resourceLoading) {
              void loadJmsResourceDetails();
            }
            setResourceDialogOpen(true);
          }}
        >
          Usage
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (queueActionsTarget) {
              setSelectedQueue(queueActionsTarget.key || queueActionsTarget.name);
            }
            closeQueueActionsMenu();
          }}
        >
          Delete
        </MenuItem>
      </Menu>

      <Menu
        anchorEl={messageActionsAnchorEl}
        open={Boolean(messageActionsAnchorEl)}
        onClose={closeMessageActionsMenu}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.5,
              minWidth: 160,
              borderRadius: 2,
              border: "1px solid #d7dee8",
              boxShadow: "0 16px 32px rgba(15, 23, 42, 0.14)"
            }
          }
        }}
      >
        <MenuItem onClick={() => void reloadCurrentSelection()}>Reload</MenuItem>
        <MenuItem onClick={closeMessageActionsMenu}>Settings</MenuItem>
      </Menu>

      <Dialog
        open={resourceDialogOpen}
        onClose={() => setResourceDialogOpen(false)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle sx={{ fontWeight: 800 }}>JMS Resources</DialogTitle>
        <DialogContent dividers sx={{ px: { xs: 2, sm: 4 }, py: 3 }}>
          {resourceSummary ? (
            <Stack spacing={4}>
              <Stack spacing={1.5}>
                <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1}>
                  <Typography sx={{ fontSize: 18, color: "#516b89" }}>Number of Queues:</Typography>
                  <Typography sx={{ fontSize: 18, color: "#516b89" }}>
                    Maximum Available: {resourceSummary.maxQueueNumber} Queues
                  </Typography>
                </Stack>
                <Box sx={{ pl: { xs: 0, sm: 24 } }}>
                  <Typography
                    sx={{
                      mb: 1,
                      textAlign: "right",
                      fontSize: 18,
                      fontWeight: 800,
                      color: resourceSummary.isCritical ? "#c2410c" : "#2e7d32"
                    }}
                  >
                    {resourceSummary.queueNumber} Queues
                  </Typography>
                  <Box
                    sx={{
                      position: "relative",
                      height: 26,
                      border: "1px solid #d7dee8",
                      background: "#f3f4f6",
                      overflow: "visible"
                    }}
                  >
                    <Box
                      sx={{
                        width: `${resourceSummary.queueUsagePercent}%`,
                        maxWidth: "100%",
                        height: "100%",
                        background: resourceSummary.isCritical ? "#ef6c00" : "#2e7d32"
                      }}
                    />
                    <Box
                      sx={{
                        position: "absolute",
                        top: -6,
                        bottom: -6,
                        left: `${clampPercent((JMS_QUEUE_WARNING_THRESHOLD / Math.max(resourceSummary.maxQueueNumber || 1, 1)) * 100)}%`,
                        borderLeft: "2px dashed #ef6c00"
                      }}
                    />
                  </Box>
                </Box>
              </Stack>

              <Stack spacing={1.5}>
                <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1}>
                  <Typography sx={{ fontSize: 18, color: "#516b89" }}>Capacity:</Typography>
                  <Typography sx={{ fontSize: 18, color: "#516b89" }}>
                    Maximum Available: {resourceSummary.maxCapacityLabel}
                  </Typography>
                </Stack>
                <Box sx={{ pl: { xs: 0, sm: 24 } }}>
                  <Typography sx={{ mb: 1, fontSize: 18, fontWeight: 800, color: "#2e7d32" }}>
                    {resourceSummary.currentCapacityLabel}
                  </Typography>
                  <Box
                    sx={{
                      position: "relative",
                      height: 26,
                      border: "1px solid #8aa2c4",
                      background: "#f3f4f6",
                      overflow: "visible"
                    }}
                  >
                    <Box
                      sx={{
                        width: `${resourceSummary.capacityUsagePercent}%`,
                        maxWidth: "100%",
                        height: "100%",
                        background: "#34a853"
                      }}
                    />
                  </Box>
                </Box>
              </Stack>

              <Stack spacing={1.1}>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                  <Typography sx={{ minWidth: 140, textAlign: { xs: "left", sm: "right" }, color: "#516b89", fontSize: 17 }}>
                    Queue Usage:
                  </Typography>
                  <Typography sx={{ color: "#2e7d32", fontSize: 17 }}>
                    {resourceSummary.queueUsageLabel}
                  </Typography>
                </Stack>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                  <Typography sx={{ minWidth: 140, textAlign: { xs: "left", sm: "right" }, color: "#516b89", fontSize: 17 }}>
                    Queue State:
                  </Typography>
                  <Typography sx={{ color: "#2e7d32", fontSize: 17 }}>
                    {resourceSummary.queueStateLabel}
                  </Typography>
                </Stack>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                  <Typography sx={{ minWidth: 140, textAlign: { xs: "left", sm: "right" }, color: "#516b89", fontSize: 17 }}>
                    Transactions:
                  </Typography>
                  <Typography sx={{ color: resourceSummary.transactionsLabel === "Available" ? "#2e7d32" : "#b45309", fontSize: 17 }}>
                    {resourceSummary.transactionsLabel}
                  </Typography>
                </Stack>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                  <Typography sx={{ minWidth: 140, textAlign: { xs: "left", sm: "right" }, color: "#516b89", fontSize: 17 }}>
                    Providers:
                  </Typography>
                  <Typography sx={{ color: resourceSummary.providersLabel === "Available" ? "#2e7d32" : "#b45309", fontSize: 17 }}>
                    {resourceSummary.providersLabel}
                  </Typography>
                </Stack>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                  <Typography sx={{ minWidth: 140, textAlign: { xs: "left", sm: "right" }, color: "#516b89", fontSize: 17 }}>
                    Consumers:
                  </Typography>
                  <Typography sx={{ color: resourceSummary.consumersLabel === "Available" ? "#2e7d32" : "#b45309", fontSize: 17 }}>
                    {resourceSummary.consumersLabel}
                  </Typography>
                </Stack>
              </Stack>
            </Stack>
          ) : (
            <Typography color="text.secondary">Run the JMS resource check to view details.</Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResourceDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default JmsQueues;
