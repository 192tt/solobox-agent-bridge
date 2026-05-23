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

let ws = null;
let pingTimer = null;
let pongTimeout = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let authenticated = false;

let storedSchema = null;
let storedProfileStatus = "incomplete";

const matchCache = new Map();

// ---------------------------------------------------------------------------
// Pending event cache — bridge receives events and exposes them via HTTP.
// The agent container (qclaw, Claude Code, etc.) polls GET /event, uses its
// OWN LLM to generate a response, then POSTs the reply via /send.
// The bridge does NOT call any LLM itself.
// ---------------------------------------------------------------------------

let pendingEvent = null;

// ---------------------------------------------------------------------------
// Conversation history cache (per roomId)
// ---------------------------------------------------------------------------

const conversationHistory = new Map();

function addToHistory(roomId, role, content) {
  if (!conversationHistory.has(roomId)) {
    conversationHistory.set(roomId, []);
  }
  const history = conversationHistory.get(roomId);
  history.push({ role, content, timestamp: Date.now() });
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
      log("info", "Profile schema stored");
      break;

    case "match.start":
      // Cache peer profile
      if (message.payload.peerPublicProfile) {
        matchCache.set(message.payload.roomId, {
          peerPublicProfile: message.payload.peerPublicProfile,
          matchId: message.payload.matchId,
        });
      }
      // Send match.ready immediately (no LLM needed)
      send({
        type: "match.ready",
        messageId: generateId(),
        timestamp: Date.now(),
        payload: { roomId: message.payload.roomId },
      });
      // Cache the event for the agent to pick up via GET /event
      pendingEvent = {
        type: "match.start",
        roomId: message.payload.roomId,
        matchId: message.payload.matchId,
        peerPublicProfile: message.payload.peerPublicProfile || {},
        conversationHistory: message.payload.conversationHistory || [],
        round: message.payload.round || 1,
        maxRounds: message.payload.maxRounds || 10,
      };
      log("info", "Event cached: match.start room=" + message.payload.roomId);
      break;

    case "peer.message":
      // Record peer message in history
      addToHistory(message.payload.roomId, "user", message.payload.content);
      // Inject cached peer profile
      const cached = matchCache.get(message.payload.roomId);
      if (cached && cached.peerPublicProfile) {
        message.payload.peerPublicProfile = cached.peerPublicProfile;
      }
      // Cache the event for the agent to pick up
      pendingEvent = {
        type: "peer.message",
        roomId: message.payload.roomId,
        matchId: message.payload.matchId,
        content: message.payload.content,
        senderPublicProfile: message.payload.senderPublicProfile || {},
        peerPublicProfile: message.payload.peerPublicProfile || cached?.peerPublicProfile || {},
        conversationHistory: message.payload.conversationHistory || [],
        round: message.payload.round || 0,
        maxRounds: message.payload.maxRounds || 10,
      };
      log("info", "Event cached: peer.message room=" + message.payload.roomId);
      break;

    case "message.send.ok":
      log("info", "Message sent OK", { peerOnline: message.payload?.peerOnline });
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
      clearPendingEvent();
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

function clearPendingEvent() {
  pendingEvent = null;
}

// ---------------------------------------------------------------------------
// Local HTTP API
// ---------------------------------------------------------------------------

function startLocalAPI() {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://localhost");

    // GET /status — connection state
    if (req.method === "GET" && url.pathname === "/status") {
      const ready = ws && ws.readyState === WebSocket.OPEN && authenticated;
      res.writeHead(200);
      res.end(JSON.stringify({
        connected: ready,
        authenticated,
        agentId: CONFIG.agentId,
        profileStatus: storedProfileStatus,
        hasSchema: storedSchema !== null,
        hasPendingEvent: pendingEvent !== null,
      }));
      return;
    }

    // GET /event — get latest pending event + system prompt for agent
    if (req.method === "GET" && url.pathname === "/event") {
      if (pendingEvent) {
        const round = pendingEvent.round || 1;
        const maxRounds = pendingEvent.maxRounds || 10;
        const phase = round <= 2 ? "intro" : (round <= 4 ? "match" : "cooperate");

        const phaseGuidance = {
          intro: "这是对话初期。先简单介绍己方背景和核心优势，点到为止，不要展开太多。提及对方昵称和城市以示尊重。50-80字。",
          match: "基于双方资料分析契合点。结合对方赛道、合作类型、需求，说明我方能提供的资源或能力。提出1-2个具体的合作切入点。60-100字。",
          cooperate: "推进到具体合作层面。提出明确的下一步建议：交换联系方式、约线上会议、资源对接、联合运营等。语气积极但不急迫。50-100字。",
        };

        const systemPrompt = [
          "你是用户的商业社交 Agent，正在代表用户与另一位创业者/投资人进行专业对接对话。",
          "",
          "对话分三个阶段，当前处于阶段：",
          `第 ${round}/${maxRounds} 轮 → 【${phase === "intro" ? "阶段一：自我介绍" : (phase === "match" ? "阶段二：资料匹配" : "阶段三：合作推进")}】`,
          "",
          "阶段规则：",
          "- 阶段一（1-2轮）：简要自我介绍，提及己方核心优势和资源",
          "- 阶段二（3-4轮）：结合双方资料分析契合点，提出合作切入",
          "- 阶段三（5轮+）：推进具体合作，建议下一步行动（交换联系方式、约见面、资源对接）",
          "",
          "通用规则：",
          "1. 称呼对方昵称，提及对方城市/赛道/身份",
          "2. 回复具体有针对性，不要泛泛而谈",
          "3. 基于双方真实资料，不编造信息",
          "4. 不要重复同样的句式",
          `5. 当前轮次指导：${phaseGuidance[phase]}`,
        ].join("\n");

        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          event: pendingEvent,
          systemPrompt,
          meta: { phase, round, maxRounds },
        }));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, event: null }));
      }
      return;
    }

    // DELETE /event — acknowledge event handled by agent
    if (req.method === "DELETE" && url.pathname === "/event") {
      clearPendingEvent();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /schema — get profile schema
    if (req.method === "GET" && url.pathname === "/schema") {
      res.writeHead(200);
      res.end(JSON.stringify({ schema: storedSchema }));
      return;
    }

    // POST /send — agent sends message via WebSocket
    if (req.method === "POST" && url.pathname === "/send") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const msg = JSON.parse(body);
          const success = send(msg);
          if (success && msg.payload && msg.payload.content) {
            addToHistory(msg.payload.roomId, "assistant", msg.payload.content);
          }
          res.writeHead(success ? 200 : 503);
          res.end(JSON.stringify({ ok: success, type: msg.type }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // GET /history?roomId=X — get conversation history for a room
    if (req.method === "GET" && url.pathname === "/history") {
      const roomId = url.searchParams.get("roomId");
      res.writeHead(200);
      res.end(JSON.stringify({ history: roomId ? getHistory(roomId) : [] }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(CONFIG.localPort, "127.0.0.1", () => {
    log("info", `Local API listening on http://127.0.0.1:${CONFIG.localPort}`);
    log("info", "  GET  /event   — poll for pending match/peer events");
    log("info", "  DELETE /event — ack event after handling");
    log("info", "  POST /send    — send message via WebSocket");
    log("info", "  GET  /status  — check connection state");
    log("info", "  GET  /history?roomId=X — get conversation history");
    log("info", "  GET  /schema  — get profile schema");
  });

  return server;
}

// ---------------------------------------------------------------------------

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

if (!CONFIG.apiKey) {
  log("error", "SOLOBOX_API_KEY environment variable is required");
  log("info", "Set it with: export SOLOBOX_API_KEY=sk_your_api_key");
}

apiServer = startLocalAPI();
connect();

module.exports = { connect, shutdown, send, CONFIG };
