import React, { useEffect, useState } from "react";
import {
  Box,
  Button,
  Container,
  Paper,
  Stack,
  TextField,
  Typography,
  Alert,
  InputAdornment,
  CircularProgress
} from "@mui/material";

import CableRoundedIcon from "@mui/icons-material/CableRounded";
import HubRoundedIcon from "@mui/icons-material/HubRounded";
import VpnKeyRoundedIcon from "@mui/icons-material/VpnKeyRounded";
import KeyRoundedIcon from "@mui/icons-material/KeyRounded";

import { useNavigate } from "react-router-dom";
import TopBar from "../components/TopBar";
import { API_BASE_URL } from "../config";

const hasStoredTenantSession = () => {
  try {
    return Boolean(
      localStorage.getItem("tenantAccessComplete") === "true" &&
      localStorage.getItem("token") &&
      localStorage.getItem("baseUrl")
    );
  } catch {
    return false;
  }
};

const TenantAccess = () => {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(hasStoredTenantSession);
  const [queueCount, setQueueCount] = useState(0);
  const [queueCountLoading, setQueueCountLoading] = useState(false);

  const navigate = useNavigate();

  const loadQueueCount = async () => {
    const token = localStorage.getItem("token");
    const baseUrl = localStorage.getItem("baseUrl");

    if (!token || !baseUrl) return;

    setQueueCountLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/jms-queues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, baseUrl })
      });

      const data = await response.json();

      if (response.ok && data.queues) {
        setQueueCount(data.queues.length);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setQueueCountLoading(false);
    }
  };

  useEffect(() => {
    if (isConnected) loadQueueCount();
  }, [isConnected]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage("");
    setIsError(false);

    const cleanToken = tokenUrl.trim().replace(/\/+$/, "");
    const cleanBase = baseUrl.trim().replace(/\/+$/, "");

    if (cleanToken === cleanBase) {
      setIsError(true);
      setMessage("Token URL and Base URL cannot be the same.");
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/connectTenant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          clientSecret,
          tokenUrl: cleanToken,
          baseUrl: cleanBase
        })
      });

      const result = await response.json();

      if (result.packages) {
        setMessage(result.message);
        setIsError(false);

        localStorage.setItem("token", result.token);
        localStorage.setItem("baseUrl", result.baseUrl || cleanBase);
        localStorage.setItem("packages", JSON.stringify(result.packages || []));
        localStorage.setItem("tenantAccessComplete", "true");

        setIsConnected(true);
      } else {
        setIsError(true);
        setMessage(result.message || "Connection Failed");
      }
    } catch {
      setIsError(true);
      setMessage("Connection Failed. Please check credentials.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: "100vh",
        background: "linear-gradient(120deg, #ffffff, #ffffff)",
        display: "flex",
        flexDirection: "column"
      }}
    >
      <TopBar />

      {message && (
        <Box
          sx={{
            position: "absolute",
            top: 110,
            left: { xs: 16, md: 24 },
            zIndex: 2,
            width: { xs: "calc(100% - 32px)", sm: 360 }
          }}
        >
          <Alert severity={isError ? "error" : "success"}>
            {message}
          </Alert>
        </Box>
      )}

      <Container
        maxWidth={isConnected ? "md" : "sm"}
        sx={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        {isConnected ? (
<Paper
  sx={{
    width: "100%",
    maxWidth: 720,
    p: 4,
    borderRadius: 3,
    background: "rgba(13, 129, 182, 0.8)",
    backdropFilter: "blur(12px)",
    boxShadow: "0 25px 60px rgba(0,0,0,0.08)"
  }}
>
  <Stack spacing={4} alignItems="center">

    <Typography
      sx={{
        fontSize: 32,
        fontWeight: 700,
        letterSpacing: "0.5px",
        color: "#ffffff",
        fontFamily: "Inter, sans-serif"
      }}
    >
      Monitoring Status Overview
    </Typography>

    <Stack direction="row" spacing={4}>
     
      <Paper
        onClick={() => navigate("/jms-queues")}
        sx={{
          width: 270,
          height: 210,
          borderRadius: 4,
          background: "#ffffff",
          border: "1px solid rgba(0,0,0,0.06)",
          p: 3,
          cursor: "pointer",
          position: "relative",
          transition: "all 0.3s ease",
          boxShadow: "0 8px 20px rgba(0,0,0,0.06)",

          "&:hover": {
            background: "#e9e9e9",
            transform: "translateY(-2px)",
            boxShadow: "0 20px 40px rgba(0,0,0,0.12)"
          }
        }}
      >
        <Typography
          sx={{
            fontSize: 24,
            fontWeight: 600,
            color: "#1e293b"
          }}
        >
          JMS Queues
        </Typography>
        {queueCountLoading ? (
          <CircularProgress
            sx={{ position: "absolute", bottom: 45, right: 45 }}
          />
        ) : (
          <>
            <Typography
              sx={{
                position: "absolute",
                bottom: 40,
                right: 25,
                fontSize: 58,
                fontWeight: 600,
                color: "#94a3b8"
              }}
            >
              {queueCount}
            </Typography>

            <Typography
              sx={{
                position: "absolute",
                bottom: 15,
                left: 20,
                fontSize: 16,
                color: "#94a3b8"
              }}
            >
              Queues
            </Typography>
          </>
        )}
      </Paper>
 <Paper
        onClick={() => navigate("/status")}
        sx={{
          width: 270,
          height: 210,
          borderRadius: 4,
          background: "#ffffff",
          border: "1px solid rgba(0,0,0,0.06)",
          p: 3,
          cursor: "pointer",
          transition: "all 0.3s ease",
          boxShadow: "0 8px 20px rgba(0,0,0,0.06)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",  
          "&:hover": {
            background: "#e9e9e9",
            transform: "translateY(-2px)",
            boxShadow: "0 20px 40px rgba(0,0,0,0.12)"
          }
        }}
      >
        <Typography
          sx={{
            fontSize: 24,
            fontWeight: 500,
            lineHeight: 1.3,
            color: "#0f172a"
          }}
        >
          Message <br />
          Monitoring <br />
          Overview
        </Typography>
      </Paper>
    </Stack>
  </Stack>
</Paper>
        ) : (
          <Paper sx={{ width: "100%", p: 4 }}>
            <Stack spacing={2} component="form" onSubmit={handleSubmit}>
              <Typography variant="h4">Access Tenant</Typography>

              <TextField
                placeholder="Client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                fullWidth
              />

              <TextField
                placeholder="Client Secret"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                fullWidth
              />

              <TextField
                placeholder="Token URL"
                value={tokenUrl}
                onChange={(e) => setTokenUrl(e.target.value)}
                fullWidth
              />

              <TextField
                placeholder="Base URL"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                fullWidth
              />

              <Button type="submit" variant="contained">
                {isLoading ? "Connecting..." : "Connect"}
              </Button>
            </Stack>
          </Paper>
        )}
      </Container>
    </Box>
  );
};

export default TenantAccess;