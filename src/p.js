import { POKER_API_BASE_URL } from "./poker-config.js";
import { ticketFromLocation, validateSettings, responseData } from "./poker-entry.js";

const $ = (id) => document.getElementById(id);
const ticket = ticketFromLocation(window.location);
const apiBase = POKER_API_BASE_URL.replace(/\/$/, "");
const number = (value) => Number(value || 0).toLocaleString("zh-CN");
const stateNames = { WATCHING: "旁观中", STANDING: "已起身", SEATED: "已入座", READY: "已准备", IN_HAND: "牌局中" };
const activityNames = { UPCOMING: "进行中", FULL: "人数已满", ENDED: "已结束", CANCELLED: "已取消" };

let accessToken = "";
let view = null;
let socket = null;
let socketEpoch = 0;
let pingTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let busy = false;

function showNotice(message, error = false) {
  const element = $("notice");
  element.textContent = message || "";
  element.hidden = !message;
  element.classList.toggle("error", error);
}

function setConnection(label, kind = "") {
  $("connection-label").textContent = label;
  $("connection-dot").parentElement.className = "connection " + kind;
}

function disableForms(disabled) {
  $("enter-button").disabled = disabled;
  $("create-button").disabled = disabled;
  $("refresh-button").disabled = disabled;
  $("reconnect-button").disabled = disabled;
}

function stopSocket() {
  socketEpoch++;
  clearInterval(pingTimer);
  clearTimeout(reconnectTimer);
  pingTimer = null;
  reconnectTimer = null;
  if (socket) {
    const previous = socket;
    socket = null;
    previous.close();
  }
}

async function post(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const result = await fetch(apiBase + path, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let response;
    try { response = await result.json(); }
    catch { throw new Error("服务返回了无法读取的内容，请稍后重试"); }
    return responseData(response, result.status);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请检查网络后重试");
    if (error instanceof TypeError) throw new Error("无法连接服务，请检查网络或页面来源是否已获跨域许可");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function enterRoom({ reconnect = false } = {}) {
  if (busy) return;
  if (!ticket) { showNotice("活动链接缺少 ticket，请从活动入口重新打开。", true); return; }
  if (!accessToken) { showNotice("请先输入当前账号的 access token。", true); return; }
  busy = true;
  disableForms(true);
  if (!reconnect) showNotice("正在核对身份与活动资格…");
  try {
    const data = await post("/api/poker/v1/entry", { ticket });
    stopSocket();
    view = data;
    renderView();
    showNotice("");
    if (data.entryState === "ROOM_CREATED" || data.entryState === "ROOM_READY") {
      if (!reconnect) reconnectAttempts = 0;
      connect(data.connection);
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      stopSocket();
      view = null;
      accessToken = "";
      $("access-token").value = "";
      $("login-panel").hidden = false;
      $("activity-panel").hidden = true;
      $("create-panel").hidden = true;
      $("stage-panel").hidden = true;
      $("room-area").hidden = true;
    } else if (!view || !reconnect) {
      $("login-panel").hidden = false;
    }
    setConnection("连接中断", "disconnected");
    showNotice(error.message, true);
  } finally {
    busy = false;
    disableForms(false);
  }
}

async function createRoom() {
  if (busy || !view?.canCreate || view.entryState !== "READY_TO_CREATE") return;
  let body = { ticket };
  try {
    if ($("custom-settings").checked) {
      const form = $("create-form");
      body.settings = validateSettings(Object.fromEntries(new FormData(form)));
    }
  } catch (error) { showNotice(error.message, true); return; }
  busy = true;
  disableForms(true);
  showNotice("正在创建房间，请稍候…");
  try {
    const data = await post("/api/poker/v1/rooms", body);
    stopSocket();
    view = data;
    renderView();
    if (data.entryState === "ROOM_CREATED" || data.entryState === "ROOM_READY") {
      connect(data.connection);
      showNotice(data.created ? "房间已创建，你已以旁观身份进入。初始筹码已记入本人账本。" : "房间已存在，已读取当前配置并进入。");
    }
  } catch (error) {
    showNotice(error.message, true);
    if (/配置不可修改|房间已创建/.test(error.message)) {
      // Read the existing room without resending settings.
      busy = false;
      await enterRoom({ reconnect: true });
    }
  } finally {
    busy = false;
    disableForms(false);
  }
}

function connect(connection) {
  if (!connection?.url || !connection.wsToken) {
    setConnection("连接信息缺失", "disconnected");
    showNotice("房间已进入，但服务没有返回 WebSocket 连接信息。请稍后重试。", true);
    return;
  }
  let url;
  try {
    url = new URL(connection.url);
    if (!["wss:", "ws:"].includes(url.protocol) || (location.protocol === "https:" && url.protocol !== "wss:")) throw new Error();
  } catch {
    setConnection("连接地址无效", "disconnected");
    showNotice("服务返回的实时连接地址无效，请联系管理员。", true);
    return;
  }
  setConnection("正在连接");
  const epoch = ++socketEpoch;
  try { socket = new WebSocket(url.href); }
  catch { scheduleReconnect(epoch); return; }
  const currentSocket = socket;
  currentSocket.onopen = () => {
    if (epoch !== socketEpoch) return;
    currentSocket.send(JSON.stringify({
      type: "AUTH",
      requestId: requestId(),
      payload: { wsToken: connection.wsToken },
    }));
  };
  currentSocket.onmessage = (event) => {
    if (epoch !== socketEpoch) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "AUTH_OK") {
      reconnectAttempts = 0;
      setConnection("实时连接已建立", "connected");
      pingTimer = setInterval(() => {
        if (currentSocket.readyState === WebSocket.OPEN) {
          currentSocket.send(JSON.stringify({
            type: "PING",
            requestId: requestId(),
            payload: { clientTime: new Date().toISOString() },
          }));
        }
      }, 20000);
    } else if (message.type === "SNAPSHOT" && message.payload) {
      view = { ...view, ...message.payload };
      renderView();
    } else if (message.type === "AUTH_EXPIRED") {
      showNotice(message.payload?.message || "登录或活动权限已失效，请重新验证。", true);
      currentSocket.close();
    } else if (message.type === "ERROR" && message.payload?.code !== 501) {
      showNotice(message.payload?.message || "实时连接发生错误", true);
    }
  };
  currentSocket.onerror = () => {
    if (epoch === socketEpoch) setConnection("连接中断", "disconnected");
  };
  currentSocket.onclose = () => {
    if (epoch !== socketEpoch) return;
    clearInterval(pingTimer);
    pingTimer = null;
    socket = null;
    setConnection("连接中断", "disconnected");
    scheduleReconnect(epoch);
  };
}

function scheduleReconnect(epoch) {
  if (epoch !== socketEpoch) return;
  if (reconnectAttempts >= 4) {
    showNotice("实时连接未恢复。请点击“重新连接”重试。", true);
    return;
  }
  reconnectAttempts++;
  const seconds = Math.min(3 * 2 ** (reconnectAttempts - 1), 15);
  setConnection(seconds + " 秒后重连", "disconnected");
  reconnectTimer = setTimeout(() => {
    if (epoch === socketEpoch) enterRoom({ reconnect: true });
  }, seconds * 1000);
}

function text(id, value) { $(id).textContent = value == null ? "" : String(value); }
function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
function clearAndAppend(id, nodes) { $(id).replaceChildren(...nodes); }
function avatar(name, url) {
  const element = document.createElement("span");
  element.className = "avatar";
  element.textContent = (name || "人").slice(0, 1);
  if (typeof url === "string" && /^https:\/\//i.test(url)) {
    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.onload = () => element.replaceChildren(img);
    img.src = url;
  }
  return element;
}

function renderStage(kicker, title, copy, symbol, canRefresh) {
  $("stage-panel").hidden = false;
  text("stage-kicker", kicker);
  text("stage-title", title);
  text("stage-copy", copy);
  text("stage-symbol", symbol);
  $("refresh-button").hidden = !canRefresh;
}

function renderView() {
  if (!view) return;
  $("login-panel").hidden = true;
  $("activity-panel").hidden = false;
  $("create-panel").hidden = true;
  $("stage-panel").hidden = true;
  $("room-area").hidden = true;
  const activity = view.activity || {};
  const self = view.self || {};
  const counts = view.counts || {};
  text("header-user", self.nickname || "活动成员");
  text("activity-title", activity.title || "活动牌桌");
  text("activity-id", activity.activityId ? "活动编号  /  " + activity.activityId : "");
  text("activity-status", activityNames[activity.status] || activity.status || "活动");
  text("self-role", self.role === "CREATOR" ? "活动创建人" : "活动成员");
  text("activity-count", number(counts.activityParticipantCount));
  text("room-count", number(counts.roomMemberCount));

  switch (view.entryState) {
    case "READY_TO_CREATE":
      if (view.canCreate) $("create-panel").hidden = false;
      else renderStage("等待牌桌", "房间尚未建立", "请稍后刷新房间状态。", "◇", true);
      break;
    case "WAITING_FOR_CREATOR":
      renderStage("WAITING / 等待创建人", "牌桌还没开", "活动创建人建房后，你就可以进入。稍后刷新房间状态即可。", "◇", true);
      break;
    case "ROOM_CLOSED":
      renderStage("CLOSED / 房间已关闭", "本场牌桌已结束", "房间已关闭，无法重新进入。", "♠", false);
      break;
    case "ROOM_CREATED":
    case "ROOM_READY":
      $("room-area").hidden = false;
      renderRoom();
      break;
    default:
      renderStage("房间状态", "暂时无法进入", view.notice || "请稍后重试。", "◇", true);
  }
}

function renderRoom() {
  const room = view.room || {};
  const settings = room.settings || {};
  const self = view.self || {};
  const counts = view.counts || {};
  const members = Array.isArray(view.roomMembers) ? view.roomMembers : [];
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const mine = members.find((member) => String(member.userId) === String(self.userId));
  text("room-title", room.name || "你的牌桌");
  text("table-name", room.name || "活动牌桌");
  text("table-subtitle", room.roomId ? "ROOM  /  " + room.roomId : "等待成员加入");
  text("online-count", number(counts.onlineCount));
  text("seated-count", number(counts.seatedCount));
  text("ready-count", number(counts.readyCount));
  text("max-seats", number(settings.maxSeats || 6));
  text("self-name", self.nickname || "你");
  text("self-state", stateNames[self.roomState] || self.roomState || "旁观中");
  const balance = $("self-stack");
  balance.textContent = mine ? number(mine.stack) + " " : "— ";
  const unit = document.createElement("span");
  unit.textContent = "CHIPS";
  balance.append(unit);
  const selfAvatar = avatar(self.nickname, self.avatarUrl);
  selfAvatar.id = "self-avatar";
  $("self-avatar").replaceWith(selfAvatar);

  const rows = [
    ["座位", (settings.maxSeats || 6) + " 人 · " + (settings.seatingType === 1 ? "自主选座" : "随机落座")],
    ["盲注", number(settings.smallBlind) + " / " + number(settings.bigBlind)],
    ["初始筹码", number(settings.startingStack)],
    ["行动时限", (settings.turnSeconds || 30) + " 秒"],
  ];
  clearAndAppend("room-settings", rows.map(([label, value]) => {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    row.append(dt, dd);
    return row;
  }));

  const maxSeats = Math.max(2, Math.min(Number(settings.maxSeats) || 6, 9));
  const seatByNo = new Map(seats.map((seat) => [Number(seat.seatNo), seat]));
  clearAndAppend("seat-ring", Array.from({ length: maxSeats }, (_, index) => {
    const no = index + 1;
    const seat = seatByNo.get(no);
    const position = -Math.PI / 2 + (index * 2 * Math.PI) / maxSeats;
    const element = document.createElement("div");
    element.className = "table-seat" + (seat ? " occupied" : "");
    element.style.left = (50 + 42 * Math.cos(position)) + "%";
    element.style.top = (50 + 34 * Math.sin(position)) + "%";
    const title = document.createElement("b");
    title.textContent = seat ? seat.nickname || "玩家" : "＋";
    const detail = document.createElement("span");
    detail.textContent = seat ? number(seat.stack) + " 筹码" : no + " 号空位";
    element.append(title, detail);
    return element;
  }));

  text("member-total", members.length);
  clearAndAppend("members-list", members.length ? members.map((member) => {
    const card = document.createElement("div");
    card.className = "member";
    const name = document.createElement("div");
    name.className = "member-name";
    const strong = document.createElement("strong");
    strong.textContent = member.nickname || "活动成员";
    const small = document.createElement("small");
    small.textContent = (String(member.userId) === String(self.userId) ? "你 · " : "") + (stateNames[member.state] || member.state || "房间成员");
    name.append(strong, small);
    const online = document.createElement("span");
    online.className = "member-online" + (member.online ? " live" : "");
    online.textContent = member.online ? "● 在线" : "○ 离线";
    const stack = document.createElement("span");
    stack.className = "member-stack";
    stack.textContent = number(member.stack);
    card.append(avatar(member.nickname, member.avatarUrl), name, online, stack);
    return card;
  }) : [Object.assign(document.createElement("div"), { className: "empty-members", textContent: "还没有成员进入房间。" })]);
}

$("entry-form").addEventListener("submit", (event) => {
  event.preventDefault();
  accessToken = $("access-token").value.trim().replace(/^Bearer\s+/i, "");
  enterRoom();
});
$("create-form").addEventListener("submit", (event) => { event.preventDefault(); createRoom(); });
$("custom-settings").addEventListener("change", (event) => { $("settings-grid").hidden = !event.target.checked; });
$("refresh-button").addEventListener("click", () => enterRoom());
$("reconnect-button").addEventListener("click", () => { stopSocket(); reconnectAttempts = 0; enterRoom({ reconnect: true }); });
$("toggle-token").addEventListener("click", () => {
  const input = $("access-token");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  $("toggle-token").textContent = visible ? "显示" : "隐藏";
  $("toggle-token").setAttribute("aria-label", visible ? "显示令牌" : "隐藏令牌");
});
if (ticket) {
  // Keep the identity-bound ticket in memory; clear it from browser history and referrers.
  history.replaceState(null, "", window.location.pathname);
} else {
  showNotice("活动链接缺少 ticket，请从活动入口重新打开。", true);
  $("enter-button").disabled = true;
}
