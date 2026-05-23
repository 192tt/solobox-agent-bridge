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

// 缓存匹配信息：roomId -> { peerPublicProfile, matchId }
const matchCache = new Map();

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

// ---------------------------------------------------------------------------
// LLM 由 Agent 容器注入，本文件不提供兜底实现
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 对话历史缓存（按 roomId 存储）
// ---------------------------------------------------------------------------

const conversationHistory = new Map();

function addToHistory(roomId, role, content) {
  if (!conversationHistory.has(roomId)) {
    conversationHistory.set(roomId, []);
  }
  const history = conversationHistory.get(roomId);
  history.push({ role, content, timestamp: Date.now() });
  // 只保留最近 20 条
  if (history.length > 20) {
    history.shift();
  }
}

function getHistory(roomId) {
  return conversationHistory.get(roomId) || [];
}

function clearHistory(roomId) {
  conversationHistory.delete(roomId);
}

// ---------------------------------------------------------------------------

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
          // 缓存对方资料
          if (message.payload.peerPublicProfile) {
            matchCache.set(message.payload.roomId, {
              peerPublicProfile: message.payload.peerPublicProfile,
              matchId: message.payload.matchId,
            });
          }
          // Send ready first
          send({
            type: "match.ready",
            messageId: generateId(),
            timestamp: Date.now(),
            payload: { roomId: message.payload.roomId },
          });
          const result = await handlers.match_start(message, createContext());
          if (result) {
            addToHistory(message.payload.roomId, "assistant", result.payload.content);
            send(result);
          }
        } catch (err) {
          log("error", "match_start handler error", err.message);
        }
      }
      break;

    case "peer.message":
      if (handlers.peer_message) {
        try {
          // 记录对方消息到历史
          addToHistory(message.payload.roomId, "user", message.payload.content);
          // 注入缓存的对方资料
          const cached = matchCache.get(message.payload.roomId);
          if (cached && cached.peerPublicProfile) {
            message.payload.peerPublicProfile = cached.peerPublicProfile;
          }
          const result = await handlers.peer_message(message, createContext());
          if (result) {
            addToHistory(message.payload.roomId, "assistant", result.payload.content);
            send(result);
          }
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
      clearHistory(message.payload.roomId);
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
        const val = process.env[opts.name];
        if (val) return val;
        throw new Error(`Missing required secret: ${opts.name}`);
      },
    },
    prompts: {
      match_conversation_system: `你是用户的商业社交 Agent，正在代表用户与另一位创业者/投资人进行专业破冰对话。
你的目标是：基于双方公开资料，发现技术互补、资源对接、业务合作的可能性。

规则：
1. 回复必须基于用户的实际资料和对方的资料，不要编造
2. 开场白要具体、有针对性，提及对方的赛道/城市/身份，不要泛泛地说"很高兴认识你"
3. 后续回复要承接对方的话题，提出具体的合作切入点或追问
4. 语气友好、专业、简洁（50-100字）
5. 不要重复同样的句式
6. 如果聊了两三轮还没找到合作点，可以主动提出交换联系方式或约线下见面`,
    },
    llm: {
      generate: async (opts) => {
        log("error", "llm.generate called but no LLM is configured. Please ensure your agent runtime (OpenClaw, Codex, Claude Code, etc.) provides an LLM implementation.");
        throw new Error("LLM not configured. This agent container does not provide a language model. Please use a container that injects llm.generate, or configure an external LLM provider in your agent runtime.");
      },
      collectStructuredProfile: async (prompt, opts) => {
        log("warn", "llm.collectStructuredProfile called but no LLM is configured.");
        return {};
      },
    },
    emit: async (msg) => send(msg),
    renderPrompt: (name, vars) => name,
    getHistory: (roomId) => getHistory(roomId),
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
  });
}

// Local HTTP API — allows the user's agent to communicate through this daemon.
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

    if (req.method === "GET" && url.pathname === "/schema") {
      res.writeHead(200);
      res.end(JSON.stringify({ schema: storedSchema }));
      return;
    }

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
    log("info", "  GET /schema — get profile schema");
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
