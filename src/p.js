import { createPokerTable, formatChips, safeAvatar, memberAmounts } from "./poker-table.js?v=20261001-unready-board";
import { POKER_API_BASE_URL } from "./poker-config.js";
import { ticketFromLocation, ticketFragmentUrl, validateSettings, redactCredentials, normalizeWebSocketUrl } from "./poker-entry.js";

const $ = (id) => document.getElementById(id);
const apiBase = POKER_API_BASE_URL.replace(/\/$/, "");
const ticket = ticketFromLocation(window.location);
const fragmentUrl = ticketFragmentUrl(window.location);
if (fragmentUrl) history.replaceState(null, "", fragmentUrl);

const stateNames = { WATCHING: "旁观中", STANDING: "已起身", SEATED: "已入座", READY: "已准备", IN_HAND: "牌局中" };
const activityNames = { UPCOMING: "即将开始", FULL: "人数已满", ENDED: "已结束", CANCELLED: "已取消" };
const number = (value) => Number(value || 0).toLocaleString("zh-CN");
const tokenStorageKey = "poker-entry-access-token";
let accessToken = readStoredToken();
let view = null;
let connection = null;
let socket = null;
let socketEpoch = 0;
let pingTimer = null;
let handshakeTimer = null;
let busy = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastWsRequest = null;
let lastHttpDiagnostic = null;
const wsRequests = new Map();
const table = createPokerTable({ document,
  onAction: (action, amount) => sendCommand("ACTION", { action, ...(amount == null ? {} : { amount }), handId: view?.game?.handId ?? view?.game?.handNumber, expectedRevision: view?.revision }),
  onCommand: (type, payload) => { sendCommand(type, payload); toggleDrawer("room-details", "room-menu", false); },
  onError: (detail, awaitingReply = false) => showError(detail, awaitingReply
    ? { request: lastWsRequest, response: { error: detail, received: false } } : undefined),
  confirmStand: confirmStanding,
});
const debug = new URLSearchParams(window.location.search).get("debug") === "1";
$("debug-panel").hidden = !debug;

function readStoredToken() {
  try { return sessionStorage.getItem(tokenStorageKey) || ""; }
  catch { return ""; }
}
function storeToken(token) {
  try {
    if (token) sessionStorage.setItem(tokenStorageKey, token);
    else sessionStorage.removeItem(tokenStorageKey);
  } catch { /* Private browsing may block storage. This page still works in memory. */ }
}
function text(id, value) { $(id).textContent = value == null ? "" : String(value); }
function diagnosticText(value) {
  let result = typeof value === "string" ? value : JSON.stringify(redactCredentials(value), null, 2) ?? "";
  for (const secret of [ticket, accessToken, connection?.wsToken]) {
    if (secret) result = result.split(secret).join("••••••（已隐藏）");
  }
  return result;
}
function showError(detail, diagnostic = {}) {
  text("error-dialog-message", detail);
  text("error-request", diagnosticText(diagnostic.request ?? "未发送接口请求（浏览器或本地检查）"));
  text("error-response", diagnosticText(diagnostic.response ?? { error: detail, received: false }));
  $("error-diagnostics").open = false;
  $("show-error").hidden = false;
  if (!$("error-dialog").open) $("error-dialog").showModal();
}
function message(value, error = false, diagnostic) {
  if (error) { showError(value, diagnostic); value = ""; }
  text("message", value);
  $("message").className = "message" + (error ? " error" : "");
}
function setWsStatus(value) {
  text("ws-status", value);
  $("ws-status").setAttribute("data-connected", String(value === "已连接"));
}
function showPanel(id) {
  $("loading-panel").hidden = true;
  document.body.classList.toggle("room-mode", id === "room-panel");
  $("room-menu").hidden = id !== "room-panel";
  if (id !== "room-panel") $("room-details").hidden = true;
  for (const panel of ["login-panel", "waiting-panel", "create-panel", "closed-panel", "error-panel", "room-panel", "connection-panel"]) {
    $(panel).hidden = panel !== id && !(id === "room-panel" && panel === "connection-panel");
  }
}
function setBusy(value) {
  busy = value;
  for (const id of ["create-room", "refresh-entry", "retry-entry", "connect-ws"]) $(id).disabled = value;
  $("login-form").querySelector("button").disabled = value;
}
function updateSystemVersion(value) {
  text("system-version", /^\d{14}$/.test(String(value || "")) ? value : "未返回");
}
function showDebug(path, headers, requestBody, response) {
  text("debug-endpoint", "POST " + path);
  text("debug-request", diagnosticText({ url: apiBase + path, method: "POST", headers, body: requestBody }));
  text("debug-response", diagnosticText(response));
}
async function post(path, requestBody) {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = "Bearer " + accessToken;
  showDebug(path, headers, requestBody, "等待响应…");
  const diagnostic = { request: { url: apiBase + path, method: "POST", headers, body: requestBody },
    response: { received: false, error: "等待响应…" } };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(apiBase + path, {
      method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
      headers, body: JSON.stringify(requestBody), signal: controller.signal,
    });
    const raw = await response.text();
    diagnostic.response = { httpStatus: response.status, body: raw };
    let envelope;
    try { envelope = JSON.parse(raw); }
    catch {
      showDebug(path, headers, requestBody, { httpStatus: response.status, body: raw });
      throw new Error("服务返回了非 JSON 内容");
    }
    diagnostic.response = { httpStatus: response.status, body: envelope };
    showDebug(path, headers, requestBody, diagnostic.response);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("服务返回了无效的接口响应");
    updateSystemVersion(envelope.systemVersion);
    if (!response.ok || envelope.code !== 0 || !envelope.data) {
      const error = new Error(envelope.message || envelope.errorMsg || "请求失败");
      error.status = response.status;
      error.code = envelope.code;
      throw error;
    }
    lastHttpDiagnostic = { request: diagnosticText(diagnostic.request), response: diagnosticText(diagnostic.response) };
    return envelope.data;
  } catch (cause) {
    let error = cause;
    if (cause.name === "AbortError") {
      error = new Error("请求超时，请重试");
      diagnostic.response = { received: false, error: error.message };
    } else if (cause.name === "TypeError") {
      updateSystemVersion(null);
      error = new Error("网络连接失败或跨域访问受阻；请确认服务允许 " + new URL(window.location.href).origin);
      diagnostic.response = { received: false, error: error.message, browserError: cause.message };
    }
    showDebug(path, headers, requestBody, diagnostic.response);
    // Store a redacted copy before login recovery clears the current credentials.
    error.diagnostic = { request: diagnosticText(diagnostic.request), response: diagnosticText(diagnostic.response) };
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
function clearSocket() {
  socketEpoch++;
  clearInterval(pingTimer);
  clearTimeout(handshakeTimer);
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  table.setConnected(false);
  pingTimer = null;
  if (socket) {
    const old = socket;
    socket = null;
    old.close();
  }
}
function returnToLogin(detail = "请返回活动入口，登录后重新打开。") {
  clearSocket();
  accessToken = "";
  storeToken("");
  $("access-token").value = "";
  $("activity-panel").hidden = true;
  text("login-detail", detail);
  view = null; connection = null; table.reset();
  message(""); setWsStatus("待验证");
  showPanel("login-panel");
}
async function enterRoom(autoConnect = true, background = false) {
  let success = false;
  if (busy || !ticket) {
    if (!ticket) message("活动链接缺少 ticket，请从活动入口重新打开。", true);
    return false;
  }
  setBusy(true);
  table.setConnected(false);
  if (!background) message("正在校验身份与活动资格…");
  try {
    const data = await post("/api/poker/v1/entry", { ticket });
    applyView(data);
    message("");
    success = true;
    return true;
  } catch (error) {
    if (background && (!error.status || error.status >= 500)) {
      setWsStatus("重连中");
      text("ws-detail", "重新检查房间失败，正在尝试恢复连接。");
      scheduleReconnect(socketEpoch);
      return false;
    }
    message(error.message, true, error.diagnostic);
    if (error.status === 401 || error.status === 403 || error.code === 401 || error.code === 403) {
      if (error.status === 401 || error.code === 401) returnToLogin(error.message);
      else showEntryError(error.message, "无权进入本场活动");
    } else {
      showEntryError(error.message);
    }
    return false;
  } finally {
    setBusy(false);
    if (success && autoConnect && connection) await connectWebSocket();
  }
}
function showEntryError(detail, title = "暂时无法进入") {
  clearSocket(); table.reset(); view = null; connection = null;
  text("error-title", title); text("error-detail", detail);
  message(""); showPanel("error-panel"); setWsStatus("无法进入");
}
async function createRoom(event) {
  event.preventDefault();
  if (busy || !ticket || !view?.canCreate) return;
  let settings;
  try { settings = validateSettings(Object.fromEntries(new FormData($("create-form")))); }
  catch (error) { text("settings-error", error.message); showError(error.message); return; }
  text("settings-error", "");
  let success = false;
  setBusy(true);
  message("正在创建房间…");
  try {
    const data = await post("/api/poker/v1/rooms", { ticket, settings });
    applyView(data);
    success = true;
    message("");
  } catch (error) {
    message(error.message, true, error.diagnostic);
    if (error.status === 401 || error.status === 403 || error.code === 401 || error.code === 403) {
      if (error.status === 401 || error.code === 401) returnToLogin(error.message);
      else showEntryError(error.message, "无权创建房间");
    } else if (error.status === 409 || error.code === 409) {
      // A concurrent creator request may already have created the room.
      setBusy(false);
      await enterRoom();
    }
  } finally {
    setBusy(false);
    if (success && connection) await connectWebSocket();
  }
}
function applyView(data) {
  view = data;
  $("activity-panel").hidden = !data.canCreate;
  const activity = data.activity || {};
  const self = data.self || {};
  const counts = data.counts || {};
  text("activity-title", activity.title || "活动");
  text("activity-id", activity.activityId ? "活动编号 " + activity.activityId : "");
  text("activity-status", activityNames[activity.status] || activity.status || "活动");
  text("self-name", self.nickname || "活动成员");
  text("self-role", self.role === "CREATOR" ? "活动创建人" : "活动成员");
  text("activity-count", number(counts.activityParticipantCount));
  if (!["ROOM_READY", "ROOM_CREATED"].includes(data.entryState)) {
    clearSocket(); connection = null; table.reset();
    setWsStatus(data.canCreate ? "待开房" : "活动入口");
  }
  switch (data.entryState) {
    case "READY_TO_CREATE":
      showPanel(data.canCreate ? "create-panel" : "waiting-panel");
      break;
    case "WAITING_FOR_CREATOR":
      showPanel(data.canCreate ? "create-panel" : "waiting-panel");
      break;
    case "ROOM_CLOSED":
      clearSocket();
      showPanel("closed-panel");
      break;
    case "ROOM_READY":
    case "ROOM_CREATED":
      showPanel("room-panel");
      renderRoom();
      if (!connection?.url || !connection?.wsToken) {
        setWsStatus("未连接"); table.setConnected(false, "房间连接信息不完整，请打开菜单重新检查。");
        showError("房间连接信息不完整，请打开菜单重新检查。", lastHttpDiagnostic ?? undefined);
      }
      break;
    default:
      showEntryError(data.notice || "活动信息无法识别，请从活动入口重新打开。");
      showError($("error-detail").textContent, lastHttpDiagnostic ?? undefined);
  }
}
function addDefinition(parent, label, value) {
  const row = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = value;
  row.append(dt, dd);
  parent.append(row);
}
function renderRoom() {
  const room = view.room || {};
  const settings = room.settings || {};
  const self = view.self || {};
  const counts = view.counts || {};
  const members = Array.isArray(view.roomMembers) ? view.roomMembers : [];
  const own = members.find((member) => String(member.id || member.userId) === String(self.id || self.userId));
  text("room-title", view.activity?.title || room.name || "活动房间");
  text("room-status", room.playState === "PAUSE_PENDING" ? "本局结束后暂停" : room.playState === "PAUSED" ? "已暂停" : room.status === "WAITING" ? "等待开局" : room.status === "PLAYING" ? "牌局进行中" : room.status || "房间");
  text("room-member-count", number(counts.roomMemberCount));
  text("online-count", number(counts.onlineCount));
  text("seated-count", number(counts.seatedCount));
  text("self-state", stateNames[self.roomState] || self.roomState || "旁观中");
  const list = $("room-settings");
  list.replaceChildren();
  addDefinition(list, "座位上限", (settings.maxSeats || "—") + " 人");
  addDefinition(list, "落座方式", Number(settings.seatingType) === 1 ? "自主选座" : "随机落座");
  addDefinition(list, "盲注", number(settings.smallBlind) + " / " + number(settings.bigBlind));
  addDefinition(list, "初始筹码", number(settings.startingStack));
  addDefinition(list, "行动时限", (settings.turnSeconds || "—") + " 秒");
  addDefinition(list, "本人当前筹码", own ? number(own.stack) : "—");
  const people = $("members-list");
  people.replaceChildren();
  if (!members.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "暂无已进入房间的成员。";
    people.append(empty);
  }
  for (const member of members) {
    const element = document.createElement("div");
    element.className = "member";
    const avatar = document.createElement("div");
    avatar.className = "member-avatar";
    const monogram = document.createElement("span");
    monogram.textContent = [...(member.nickname || "房间成员")][0];
    avatar.append(monogram);
    const avatarUrl = safeAvatar(member.avatarUrl);
    if (avatarUrl) {
      const img = document.createElement("img");
      img.src = avatarUrl; img.alt = ""; img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => img.remove());
      avatar.append(img);
    }
    const profile = document.createElement("div");
    profile.className = "member-profile";
    const name = document.createElement("strong");
    name.textContent = member.nickname || "房间成员";
    const detail = document.createElement("small");
    detail.textContent = (stateNames[member.state] || member.state || "旁观中")
      + " · " + (member.online ? "在线" : "离线");
    profile.append(name, detail);
    const balance = document.createElement("div");
    balance.className = "member-balance";
    const { totalBuyIn, netChips } = memberAmounts(member);
    const profit = document.createElement("strong");
    profit.className = "member-profit" + (netChips > 0 ? " profit-positive" : netChips < 0 ? " profit-negative" : "");
    profit.textContent = netChips === null ? "—" : netChips > 0 ? "+" + formatChips(netChips)
      : netChips < 0 ? formatChips(netChips) : "0";
    const buyIn = document.createElement("small");
    buyIn.className = "member-buy-in";
    buyIn.textContent = "累计带入 " + (totalBuyIn === null ? "—" : formatChips(totalBuyIn));
    balance.append(profit, buyIn);
    element.append(avatar, profile, balance);
    people.append(element);
  }
  table.render(view);
  connection = view.connection || null;
  let wsUrl = connection?.url;
  try { if (wsUrl) wsUrl = normalizeWebSocketUrl(wsUrl, apiBase); }
  catch { /* Keep invalid server URLs visible for diagnosis. */ }
  text("ws-url", wsUrl || "服务端未返回连接地址");
  text("protocol-version", connection?.protocolVersion ?? "—");
  text("ws-expires", connection?.expiresAt ? new Date(connection.expiresAt).toLocaleString("zh-CN") : "—");
  $("connect-ws").disabled = !connection?.url || !connection?.wsToken;
}
function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
function sendWsFrame(current, frame) {
  if (frame.type !== "PING") {
    lastWsRequest = { transport: "WebSocket", url: current.url, frame: redactCredentials(frame) };
    wsRequests.set(frame.requestId, lastWsRequest);
    if (wsRequests.size > 32) wsRequests.delete(wsRequests.keys().next().value);
  }
  current.send(JSON.stringify(frame));
}
function sendCommand(type, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN || $("ws-status").textContent !== "已连接") {
    const detail = "连接已断开，请重新连接后操作。";
    table.reject(detail); table.setConnected(false); return;
  }
  sendWsFrame(socket, { type, requestId: requestId(), payload });
}
function scheduleReconnect(epoch) {
  clearTimeout(reconnectTimer);
  if (reconnectAttempts >= 3) {
    setWsStatus("未连接");
    table.setConnected(false, "自动重连未成功，请在菜单中重新连接。");
    return;
  }
  const attempt = ++reconnectAttempts;
  setWsStatus("重连中");
  table.setConnected(false, "连接暂不可用，正在自动重试（" + attempt + "/3）…");
  reconnectTimer = setTimeout(() => { if (epoch === socketEpoch) enterRoom(true, true); }, [1500, 3000, 6000][attempt - 1]);
}
async function connectWebSocket() {
  if (busy || !connection?.url) return;
  const expiresAt = Date.parse(connection.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    if (!await enterRoom(false)) return;
  }
  if (!["ROOM_READY", "ROOM_CREATED"].includes(view?.entryState)
      || !connection?.url || !connection?.wsToken) return;
  if (!Number.isFinite(Date.parse(connection.expiresAt)) || Date.parse(connection.expiresAt) <= Date.now()) {
    setWsStatus("凭证已过期");
    text("ws-detail", "服务端返回的连接凭证已过期，请重新请求主入口。");
    return;
  }
  const attemptConnection = { ...connection };
  clearSocket();
  let url;
  try {
    url = new URL(normalizeWebSocketUrl(attemptConnection.url, apiBase));
    if (!["wss:", "ws:"].includes(url.protocol)
        || (window.location.protocol === "https:" && url.protocol !== "wss:")) throw new Error();
  } catch {
    setWsStatus("连接地址无效");
    text("ws-detail", "请检查服务端返回的 WebSocket 地址；HTTPS 页面需要 wss:// 地址。");
    return;
  }
  wsRequests.clear();
  lastWsRequest = { transport: "WebSocket", url: url.href, operation: "CONNECT" };
  const epoch = ++socketEpoch;
  let failure = "";
  let authenticated = false;
  let lastRevision = -1;
  let lastMessageAt = Date.now();
  setWsStatus("正在连接");
  text("ws-detail", "正在连接 " + url.href);
  try { socket = new WebSocket(url.href); }
  catch {
    setWsStatus("连接失败");
    text("ws-detail", "无法建立连接，请检查 WebSocket 地址。");
    return;
  }
  const current = socket;
  handshakeTimer = setTimeout(() => {
    if (epoch !== socketEpoch) return;
    failure = "连接或认证超时，请稍后重试。";
    table.setConnected(false, failure); current.close(4001, "AUTH_TIMEOUT");
  }, 15000);
  current.onopen = () => {
    if (epoch !== socketEpoch) return;
    setWsStatus("正在认证");
    text("ws-detail", "连接已建立，正在验证连接凭证…");
    sendWsFrame(current, { type: "AUTH", requestId: requestId(),
      payload: { wsToken: attemptConnection.wsToken } });
  };
  current.onmessage = (event) => {
    if (epoch !== socketEpoch) return;
    let frame;
    try { frame = JSON.parse(event.data); } catch {
      showError("服务端返回了无效的 WebSocket 消息", { request: lastWsRequest, response: event.data }); return;
    }
    if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return;
    lastMessageAt = Date.now();
    if (frame.systemVersion) updateSystemVersion(frame.systemVersion);
    if (frame.type === "AUTH_OK") {
      authenticated = true;
      clearTimeout(handshakeTimer);
      handshakeTimer = setTimeout(() => {
        if (epoch !== socketEpoch) return;
        failure = "服务端尚未推送牌局状态，请稍后重试。";
        table.setConnected(false, failure); current.close(4001, "SNAPSHOT_TIMEOUT");
      }, 15000);
      setWsStatus("已连接");
      table.setConnected(false, "房间已连接，等待牌局同步…");
      text("ws-detail", "认证成功，正在同步房间状态。");
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (Date.now() - lastMessageAt > 60000) { current.close(4001, "HEARTBEAT_TIMEOUT"); return; }
        if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({
          type: "PING", requestId: requestId(), payload: { clientTime: new Date().toISOString() },
        }));
      }, 20000);
    } else if (frame.type === "SNAPSHOT" && frame.payload && authenticated) {
      clearTimeout(handshakeTimer);
      const revision = frame.payload.revision;
      if (Number.isFinite(revision) && revision <= lastRevision) return;
      if (Number.isFinite(revision)) lastRevision = revision;
      view = { ...view, ...frame.payload, self: { ...view.self, ...frame.payload.self }, room: { ...view.room, ...frame.payload.room }, connection };
      if (view.entryState === "ROOM_CLOSED" || view.room?.status === "CLOSED") {
        clearSocket(); table.reset(); connection = null; showPanel("closed-panel"); return;
      }
      reconnectAttempts = 0;
      message("");
      table.setConnected(true);
      renderRoom();
    } else if (frame.type === "ROOM_CLOSED" && authenticated) {
      clearSocket(); table.reset(); connection = null; showPanel("closed-panel");
    } else if (frame.type === "ERROR" || frame.type === "AUTH_EXPIRED") {
      const detail = frame.payload?.message || "操作未完成，请稍后重试";
      table.reject(detail);
      const failedRequest = frame.requestId ? wsRequests.get(frame.requestId) ?? { requestId: frame.requestId, note: "未找到对应请求" } : lastWsRequest;
      message(detail, true, { request: failedRequest, response: frame });
      if (frame.type === "AUTH_EXPIRED" || !authenticated) {
        failure = detail; authenticated = false;
        table.setConnected(false, detail);
        text("ws-detail", failure); setWsStatus("连接错误");
      }
    }
  };
  current.onerror = () => {
    if (epoch !== socketEpoch) return;
    failure = "连接失败，请检查服务端公网 WSS 地址、TLS 和允许的 Origin。";
    table.setConnected(false, "连接失败，请打开房间菜单重新连接。");
    setWsStatus("连接失败");
    text("ws-detail", failure);
  };
  current.onclose = (event) => {
    if (epoch !== socketEpoch) return;
    clearInterval(pingTimer);
    clearTimeout(handshakeTimer);
    pingTimer = null;
    socket = null;
    table.setConnected(false, "连接已断开，正在尝试恢复…");
    setWsStatus(failure ? "连接错误" : "已断开");
    text("ws-detail", [failure, "连接已关闭（" + event.code + "）", event.reason].filter(Boolean).join(" · "));
    if (event.code !== 1000 && event.code !== 4003) scheduleReconnect(epoch);
    else table.setConnected(false, "连接已断开，请打开房间菜单重新连接。");
  };
}

$("close-error").addEventListener("click", () => $("error-dialog").close());
$("show-error").addEventListener("click", () => { if (!$("error-dialog").open) $("error-dialog").showModal(); });
let resolveStanding = null;
function confirmStanding() {
  return new Promise((resolve) => {
    resolveStanding = resolve;
    $("stand-dialog").returnValue = "";
    $("stand-dialog").showModal();
  });
}
$("cancel-stand").addEventListener("click", () => $("stand-dialog").close("cancel"));
$("confirm-stand").addEventListener("click", () => $("stand-dialog").close("confirm"));
$("stand-dialog").addEventListener("close", () => {
  const resolve = resolveStanding; resolveStanding = null;
  resolve?.($("stand-dialog").returnValue === "confirm");
});
if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => table.resize()).observe($("table-stage"));

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  accessToken = $("access-token").value.trim().replace(/^Bearer\s+/i, "");
  storeToken(accessToken);
  enterRoom();
});
$("create-form").addEventListener("submit", createRoom);
$("create-form").addEventListener("change", (event) => {
  const form = $("create-form"), small = form.elements.smallBlind, big = form.elements.bigBlind, stack = form.elements.startingStack;
  if (event.target === small) big.value = String(Number(small.value) * 2);
  for (const option of big.options) option.disabled = Number(option.value) < Number(small.value);
  if (Number(big.value) < Number(small.value)) big.value = String(Number(small.value) * 2);
  for (const option of stack.options) option.disabled = Number(option.value) < Number(big.value) * 20;
  if (Number(stack.value) < Number(big.value) * 20) stack.value = [...stack.options].find((option) => !option.disabled).value;
});
function toggleDrawer(id, button, open) { $(id).hidden = !open; $(button).setAttribute("aria-expanded", String(open)); }
$("room-menu").addEventListener("click", () => toggleDrawer("room-details", "room-menu", $("room-details").hidden));
$("close-details").addEventListener("click", () => toggleDrawer("room-details", "room-menu", false));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") toggleDrawer("room-details", "room-menu", false); });
$("refresh-room").addEventListener("click", () => { reconnectAttempts = 0; return enterRoom(); });
$("retry-login").addEventListener("click", enterRoom);
$("refresh-entry").addEventListener("click", enterRoom);
$("retry-entry").addEventListener("click", enterRoom);
$("connect-ws").addEventListener("click", () => { reconnectAttempts = 0; return connectWebSocket(); });
$("copy-ws-url").addEventListener("click", async () => {
  if (!connection?.url) return;
  try { await navigator.clipboard.writeText(normalizeWebSocketUrl(connection.url, apiBase)); message("WebSocket 链接已复制。"); }
  catch { message("复制失败，请手动选择链接。", true); }
});
if (ticket) enterRoom();
else {
  showEntryError("活动链接不完整，请从活动入口重新打开。", "活动链接无效");
  $("retry-entry").hidden = true;
  showError("活动链接不完整，请从活动入口重新打开。");
}
