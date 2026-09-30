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
let busy = false;

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
function message(value, error = false) {
  text("message", value);
  $("message").className = "message" + (error ? " error" : "");
}
function setWsStatus(value) { text("ws-status", value); }
function showPanel(id) {
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
  text("debug-request", JSON.stringify(redactCredentials({
    url: apiBase + path, headers, body: requestBody,
  }), null, 2));
  text("debug-response", typeof response === "string" ? response
    : JSON.stringify(redactCredentials(response), null, 2));
}
async function post(path, requestBody) {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = "Bearer " + accessToken;
  showDebug(path, headers, requestBody, "等待响应…");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(apiBase + path, {
      method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
      headers, body: JSON.stringify(requestBody), signal: controller.signal,
    });
    const raw = await response.text();
    let envelope;
    try { envelope = JSON.parse(raw); }
    catch {
      showDebug(path, headers, requestBody, { httpStatus: response.status, body: raw });
      throw new Error("服务返回了非 JSON 内容");
    }
    showDebug(path, headers, requestBody, { httpStatus: response.status, body: envelope });
    updateSystemVersion(envelope.systemVersion);
    if (!response.ok || envelope.code !== 0 || !envelope.data) {
      const error = new Error(envelope.message || envelope.errorMsg || "请求失败");
      error.status = response.status;
      error.code = envelope.code;
      throw error;
    }
    return envelope.data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请重试");
    if (error.name === "TypeError") {
      updateSystemVersion(null);
      const detail = "网络连接失败或跨域访问受阻；请确认服务允许 " + new URL(window.location.href).origin;
      showDebug(path, headers, requestBody, { error: detail });
      throw new Error(detail);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
function clearSocket() {
  socketEpoch++;
  clearInterval(pingTimer);
  pingTimer = null;
  if (socket) {
    const old = socket;
    socket = null;
    old.close();
  }
}
function returnToLogin() {
  clearSocket();
  accessToken = "";
  storeToken("");
  $("access-token").value = "";
  $("activity-panel").hidden = true;
  showPanel("login-panel");
}
async function enterRoom() {
  if (busy || !ticket) {
    if (!ticket) message("活动链接缺少 ticket，请从活动入口重新打开。", true);
    return false;
  }
  setBusy(true);
  message("正在校验身份与活动资格…");
  try {
    const data = await post("/api/poker/v1/entry", { ticket });
    applyView(data);
    message("");
    return true;
  } catch (error) {
    message(error.message, true);
    if (error.status === 401 || error.status === 403 || error.code === 401 || error.code === 403) {
      returnToLogin();
    } else if (!view) {
      text("error-detail", error.message);
      showPanel("error-panel");
    }
    return false;
  } finally {
    setBusy(false);
  }
}
async function createRoom(event) {
  event.preventDefault();
  if (busy || !ticket || !view?.canCreate) return;
  let settings;
  try { settings = validateSettings(Object.fromEntries(new FormData($("create-form")))); }
  catch (error) { text("settings-error", error.message); return; }
  text("settings-error", "");
  setBusy(true);
  message("正在创建房间…");
  try {
    const data = await post("/api/poker/v1/rooms", { ticket, settings });
    applyView(data);
    message(data.created ? "房间已创建，你已自动加入并处于旁观状态。" : "房间已存在，已进入原房间。");
  } catch (error) {
    message(error.message, true);
    if (error.status === 401 || error.status === 403 || error.code === 401 || error.code === 403) {
      returnToLogin();
    } else if (error.status === 409 || error.code === 409) {
      // A concurrent creator request may already have created the room.
      setBusy(false);
      await enterRoom();
    }
  } finally {
    setBusy(false);
  }
}
function applyView(data) {
  view = data;
  $("activity-panel").hidden = false;
  const activity = data.activity || {};
  const self = data.self || {};
  const counts = data.counts || {};
  text("activity-title", activity.title || "活动");
  text("activity-id", activity.activityId ? "活动编号 " + activity.activityId : "");
  text("activity-status", activityNames[activity.status] || activity.status || "活动");
  text("self-name", self.nickname || "活动成员");
  text("self-role", self.role === "CREATOR" ? "活动创建人" : "活动成员");
  text("activity-count", number(counts.activityParticipantCount));
  switch (data.entryState) {
    case "READY_TO_CREATE":
      showPanel(data.canCreate ? "create-panel" : "waiting-panel");
      break;
    case "WAITING_FOR_CREATOR":
      showPanel("waiting-panel");
      break;
    case "ROOM_CLOSED":
      clearSocket();
      showPanel("closed-panel");
      break;
    case "ROOM_READY":
    case "ROOM_CREATED":
      showPanel("room-panel");
      renderRoom();
      break;
    default:
      message(data.notice || "暂时无法进入房间。", true);
      showPanel("waiting-panel");
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
  text("room-title", room.name || "活动房间");
  text("room-id", room.roomId ? "房间编号 " + room.roomId : "");
  text("room-status", room.status === "WAITING" ? "等待开局" : room.status === "PLAYING" ? "牌局进行中" : room.status || "房间");
  text("room-member-count", number(counts.roomMemberCount));
  text("online-count", number(counts.onlineCount));
  text("seated-count", number(counts.seatedCount));
  text("self-state", stateNames[self.roomState] || self.roomState || "旁观中");
  const list = $("room-settings");
  list.replaceChildren();
  addDefinition(list, "座位上限", (settings.maxSeats || "—") + " 人");
  addDefinition(list, "落座方式", settings.seatingType === 1 ? "自主选座" : "随机落座");
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
    const name = document.createElement("strong");
    name.textContent = member.nickname || "房间成员";
    const detail = document.createElement("small");
    detail.textContent = (stateNames[member.state] || member.state || "旁观中")
      + " · " + (member.online ? "在线" : "离线");
    element.append(name, detail);
    people.append(element);
  }
  connection = view.connection || connection;
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
async function connectWebSocket() {
  if (busy || !connection?.url) return;
  const expiresAt = Date.parse(connection.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    if (!await enterRoom()) return;
  }
  if (!["ROOM_READY", "ROOM_CREATED"].includes(view?.entryState)
      || !connection?.url || !connection?.wsToken) return;
  if (Date.parse(connection.expiresAt) <= Date.now()) {
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
  const epoch = ++socketEpoch;
  let failure = "";
  setWsStatus("正在连接");
  text("ws-detail", "正在连接 " + url.href);
  try { socket = new WebSocket(url.href); }
  catch {
    setWsStatus("连接失败");
    text("ws-detail", "无法建立连接，请检查 WebSocket 地址。");
    return;
  }
  const current = socket;
  current.onopen = () => {
    if (epoch !== socketEpoch) return;
    setWsStatus("正在认证");
    text("ws-detail", "连接已建立，正在验证连接凭证…");
    current.send(JSON.stringify({ type: "AUTH", requestId: requestId(),
      payload: { wsToken: attemptConnection.wsToken } }));
  };
  current.onmessage = (event) => {
    if (epoch !== socketEpoch) return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.systemVersion) updateSystemVersion(frame.systemVersion);
    if (frame.type === "AUTH_OK") {
      setWsStatus("已连接");
      text("ws-detail", "认证成功，正在同步房间状态。");
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({
          type: "PING", requestId: requestId(), payload: { clientTime: new Date().toISOString() },
        }));
      }, 20000);
    } else if (frame.type === "SNAPSHOT" && frame.payload) {
      view = { ...view, ...frame.payload, connection };
      renderRoom();
    } else if (frame.type === "ERROR" || frame.type === "AUTH_EXPIRED") {
      failure = frame.payload?.message || "WebSocket 连接失败";
      message(failure, true);
      text("ws-detail", failure);
      setWsStatus("连接错误");
    }
  };
  current.onerror = () => {
    if (epoch !== socketEpoch) return;
    failure = "连接失败，请检查服务端公网 WSS 地址、TLS 和允许的 Origin。";
    setWsStatus("连接失败");
    text("ws-detail", failure);
  };
  current.onclose = (event) => {
    if (epoch !== socketEpoch) return;
    clearInterval(pingTimer);
    pingTimer = null;
    socket = null;
    setWsStatus(failure ? "连接错误" : "已断开");
    text("ws-detail", [failure, "连接已关闭（" + event.code + "）", event.reason].filter(Boolean).join(" · "));
  };
}

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  accessToken = $("access-token").value.trim().replace(/^Bearer\s+/i, "");
  storeToken(accessToken);
  enterRoom();
});
$("create-form").addEventListener("submit", createRoom);
$("refresh-entry").addEventListener("click", enterRoom);
$("retry-entry").addEventListener("click", enterRoom);
$("connect-ws").addEventListener("click", connectWebSocket);
$("copy-ws-url").addEventListener("click", async () => {
  if (!connection?.url) return;
  try { await navigator.clipboard.writeText(normalizeWebSocketUrl(connection.url, apiBase)); message("WebSocket 链接已复制。"); }
  catch { message("复制失败，请手动选择链接。", true); }
});
if (ticket) enterRoom();
else {
  message("活动链接缺少 ticket，请从活动入口重新打开。", true);
  text("error-detail", "当前链接没有 ticket，无法验证活动身份。");
  $("retry-entry").hidden = true;
  showPanel("error-panel");
}
