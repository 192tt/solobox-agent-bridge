const WebSocket = require("ws");
const http = require("http");

const CONFIG = {
  url: process.env.SOLOBOX_WS_URL || "ws://124.220.221.242/ws/agent/connect/",
  apiKey: process.env.SOLOBOX_API_KEY || "",
  agentId: process.env.SOLOBOX_AGENT_ID || "agent-" + Date.now(),
  containerType: process.env.SOLOBOX_CONTAINER_TYPE || "claude-code",
  protocolVersion: "1.0.0",
  capabilities: ["profile_collect", "match_conversation"],
  localPort: parseInt(process.env.SOLOBOX_LOCAL_PORT || "9876", 10),
  heartbeat: {
    intervalSeconds: 30,
    timeoutSeconds: 60,
  },
  reconnect: {
    maxRetries: Infinity,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    backoff: "exponential",
  },
};

const handlers = {
  setup: require("./handlers/setup"),
  profile_collect: require("./handlers/profile_collect"),
  match_start: require("./handlers/match_start"),
  peer_message: require("./handlers/peer_message"),
};

let ws = null;
let pingTimer = null;
let pongTimeout = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let authenticated = false;

// Stored server state, populated by incoming events
let storedSchema = null;
let storedProfileStatus = "incomplete";

function log(level, msg, data) {
  const ts = new Date().toISOString();
  if (data) {
    console[level](`[${ts}] [${level.toUpperCase()}] ${msg}`, data);
  } else {
    console[level](`[${ts}] [${level.toUpperCase()}] ${msg}`);
  }
}

function send(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("warn", "Cannot send, socket not open", { readyState: ws ? ws.readyState : "null" });
    return false;
  }
  const data = JSON.stringify(message);
  ws.send(data);
  log("debug", "Sent", message.type);
  return true;
}

function sendAuth() {
  if (!CONFIG.apiKey) {
    log("error", "SOLOBOX_API_KEY not configured");
    return false;
  }
  return send({
    type: "auth",
    messageId: generateId(),
    timestamp: Date.now(),
    payload: {
      apiKey: CONFIG.apiKey,
      agentId: CONFIG.agentId,
      containerType: CONFIG.containerType,
      protocolVersion: CONFIG.protocolVersion,
      capabilities: CONFIG.capabilities,
    },
  });
}

function sendPong() {
  return send({
    type: "pong",
    messageId: generateId(),
    timestamp: Date.now(),
    payload: {},
  });
}

function generateId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function resetHeartbeat() {
  clearTimeout(pongTimeout);
  clearInterval(pingTimer);

  pongTimeout = setTimeout(() => {
    log("warn", "Heartbeat timeout, closing connection");
    if (ws) {
      ws.terminate();
    }
  }, CONFIG.heartbeat.timeoutSeconds * 1000);

  // Send client-side pings to detect dead connections
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, CONFIG.heartbeat.intervalSeconds * 1000);
}

function clearHeartbeat() {
  clearTimeout(pongTimeout);
  clearInterval(pingTimer);
  pongTimeout = null;
  pingTimer = null;
}

function getReconnectDelay() {
  if (CONFIG.reconnect.backoff === "exponential") {
    const delay = CONFIG.reconnect.baseDelayMs * Math.pow(2, reconnectAttempt);
    return Math.min(delay, CONFIG.reconnect.maxDelayMs);
  }
  return CONFIG.reconnect.baseDelayMs;
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  const delay = getReconnectDelay();
  log("info", `Reconnecting in ${delay}ms (attempt ${reconnectAttempt + 1})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempt++;
    connect();
  }, delay);
}

function cancelReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

async function handleMessage(message) {
  log("info", "Received", message.type);

  switch (message.type) {
    case "auth.ok":
      authenticated = true;
      reconnectAttempt = 0;
      storedProfileStatus = message.payload.profileStatus || "incomplete";
      log("info", "Authenticated successfully", message.payload);
      break;

    case "ping":
      sendPong();
      resetHeartbeat();
      break;

    case "pong":
      resetHeartbeat();
      break;

    case "profile.schema":
      storedSchema = message.payload;
      log("info", "Profile schema stored, waiting for user to fill in via agent");
      break;

    case "match.start":
      if (handlers.match_start) {
        try {
          // Send ready first
          send({
            type: "match.ready",
            messageId: generateId(),
            timestamp: Date.now(),
            payload: { roomId: message.payload.roomId },
          });
          const result = await handlers.match_start(message, createContext());
          if (result) send(result);
        } catch (err) {
          log("error", "match_start handler error", err.message);
        }
      }
      break;

    case "peer.message":
      if (handlers.peer_message) {
        try {
          const result = await handlers.peer_message(message, createContext());
          if (result) send(result);
        } catch (err) {
          log("error", "peer_message handler error", err.message);
        }
      }
      break;

    case "takeover.notice":
      log("info", "Takeover notice", message.payload);
      break;

    case "profile.submit.ok":
      log("info", "Profile submit acknowledged", message.payload);
      break;

    case "match.end":
      log("info", "Match ended", message.payload);
      break;

    case "error":
      log("error", "Server error", message.payload);
      if (message.payload && message.payload.code === "AUTH_FAILED") {
        log("error", "Auth failed, stopping reconnect");
        authenticated = false;
        cancelReconnect();
        if (ws) ws.close();
      }
      break;

    default:
      log("debug", "Unhandled message type", message.type);
  }
}

function createContext() {
  return {
    secrets: {
      get: async (key) => process.env[key] || null,
      set: async (key, value) => {
        process.env[key] = value;
      },
    },
    user: {
      promptSecret: async (opts) => {
        // In a real container this would prompt the user; here we return env
        const val = process.env[opts.name];
        if (val) return val;
        throw new Error(`Missing required secret: ${opts.name}`);
      },
    },
    prompts: {},
    llm: {
      generate: async (opts) => {
        log("warn", "llm.generate called but no LLM configured, returning placeholder");
        return { text: "你好，很高兴认识你！期待进一步交流。" };
      },
      collectStructuredProfile: async (prompt, opts) => {
        log("warn", "llm.collectStructuredProfile called but no LLM configured");
        return {};
      },
    },
    emit: async (msg) => send(msg),
    renderPrompt: (name, vars) => name,
  };
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    log("debug", "Already connected or connecting");
    return;
  }

  log("info", `Connecting to ${CONFIG.url}`);

  ws = new WebSocket(CONFIG.url);

  ws.on("open", () => {
    log("info", "WebSocket connected");
    resetHeartbeat();
    sendAuth();
  });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(message);
    } catch (err) {
      log("error", "Failed to parse message", err.message);
    }
  });

  ws.on("ping", () => {
    resetHeartbeat();
  });

  ws.on("pong", () => {
    resetHeartbeat();
  });

  ws.on("close", (code, reason) => {
    log("warn", `WebSocket closed (code=${code}, reason=${reason})`);
    authenticated = false;
    clearHeartbeat();
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    log("error", "WebSocket error", err.message);
    // ws.on("close") will fire after this
  });
}

// Local HTTP API — allows the user's agent to communicate through this daemon.
// The daemon maintains the WebSocket; the agent (Claude Code etc.) sends
// commands via POST http://localhost:9876/send.
function startLocalAPI() {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://localhost");

    // GET /status — check connection state
    if (req.method === "GET" && url.pathname === "/status") {
      const ready = ws && ws.readyState === WebSocket.OPEN && authenticated;
      res.writeHead(200);
      res.end(JSON.stringify({
        connected: ready,
        authenticated,
        agentId: CONFIG.agentId,
        profileStatus: storedProfileStatus,
        hasSchema: storedSchema !== null,
      }));
      return;
    }

    // GET /schema — get stored profile schema
    if (req.method === "GET" && url.pathname === "/schema") {
      res.writeHead(200);
      res.end(JSON.stringify({ schema: storedSchema }));
      return;
    }

    // POST /send — send a message through the WebSocket
    if (req.method === "POST" && url.pathname === "/send") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const msg = JSON.parse(body);
          const success = send(msg);
          res.writeHead(success ? 200 : 503);
          res.end(JSON.stringify({ ok: success, type: msg.type }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(CONFIG.localPort, "127.0.0.1", () => {
    log("info", `Local API listening on http://127.0.0.1:${CONFIG.localPort}`);
    log("info", "  POST /send  — send message via WebSocket");
    log("info", "  GET /status — check connection state");
    log("info", "  GET /schema — get stored profile schema");
  });

  return server;
}

let apiServer = null;

function shutdown() {
  log("info", "Shutting down");
  clearHeartbeat();
  cancelReconnect();
  if (apiServer) {
    apiServer.close();
    apiServer = null;
  }
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

// Validate required config
if (!CONFIG.apiKey) {
  log("error", "SOLOBOX_API_KEY environment variable is required");
  log("info", "Set it with: export SOLOBOX_API_KEY=sk_your_api_key");
  log("info", "Optional: SOLOBOX_AGENT_ID, SOLOBOX_CONTAINER_TYPE, SOLOBOX_LOCAL_PORT");
}

// Start
apiServer = startLocalAPI();
connect();

module.exports = { connect, shutdown, send, CONFIG };
