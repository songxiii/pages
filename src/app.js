import { act, createGame, PHASE_LABELS, startHand } from "./engine.js";
import { chooseAiAction } from "./ai.js";
import { playerView } from "./view.js";
import { POKER_WS_URL } from "./config.js";

const $ = (id) => document.getElementById(id);
const number = (value) => Number(value).toLocaleString("zh-CN");
const query = new URLSearchParams(location.search);
const savedServer = localStorage.getItem("pokerWsUrl") || POKER_WS_URL;
$("server-url").value = query.get("server") || savedServer;
$("player-name").value = localStorage.getItem("pokerPlayerName") || "";
if (query.get("room")) $("room-code").value = query.get("room").toUpperCase();

let mode = null;
let game = null;
let state = null;
let socket = null;
let seat = 0;
let roomCode = "";
let token = "";
let aiTimer = null;
let connecting = false;
let connectionEpoch = 0;
let reconnectTimer = null;

function show(which) {
  for (const id of ["welcome", "room-panel", "game-section"]) $(id).classList.toggle("hidden", id !== which);
}
function setText(id, text) { $(id).textContent = text; }
function error(message) { setText("action-error", message || ""); }
function roomMessage(message) { setText("room-message", message || ""); }
function button(label, style, handler) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = style;
  element.textContent = label;
  element.addEventListener("click", handler);
  return element;
}
function card(code) {
  const element = document.createElement("span");
  element.className = "card";
  if (code === undefined) {
    element.classList.add("slot");
  } else if (!code) {
    element.classList.add("back");
    element.textContent = "♠";
    element.setAttribute("aria-label", "背面朝上的牌");
  } else {
    const suits = { s: "♠", h: "♥", d: "♦", c: "♣" };
    if (code[1] === "h" || code[1] === "d") element.classList.add("red");
    const rank = document.createElement("span");
    rank.textContent = code[0] === "T" ? "10" : code[0];
    const suit = document.createElement("span");
    suit.className = "suit";
    suit.textContent = suits[code[1]];
    element.append(rank, suit);
    element.setAttribute("aria-label", `${rank.textContent}${suit.textContent}`);
  }
  return element;
}
function cards(id, values, slots = 0) {
  const container = $(id);
  container.replaceChildren(...values.map(card), ...Array.from({ length: Math.max(0, slots - values.length) }, () => card(undefined)));
}
function snapshot() { return mode === "solo" && game ? playerView(game, 0) : state?.game || null; }
function render() {
  const view = snapshot();
  if (!view) { renderWaiting(); return; }
  const own = view.players[seat];
  const other = view.players[1 - seat];
  const finished = view.phase === "complete";
  const playerWon = view.result?.winners?.includes(seat);
  setText("player-label", own.name);
  setText("opponent-name", other.name);
  setText("player-avatar", own.name.slice(0, 1));
  setText("opponent-avatar", other.name.slice(0, 1));
  setText("player-stack", `${number(own.stack)} 筹码${own.bet ? ` · 已下注 ${own.bet}` : ""}`);
  setText("opponent-stack", `${number(other.stack)} 筹码${other.bet ? ` · 已下注 ${other.bet}` : ""}`);
  $("player-dealer").classList.toggle("hidden", view.dealer !== seat);
  $("opponent-dealer").classList.toggle("hidden", view.dealer === seat);
  setText("pot-amount", number(view.pot));
  setText("phase-label", PHASE_LABELS[view.phase] || "等待发牌");
  cards("player-cards", own.hole);
  cards("opponent-cards", other.hole);
  cards("board-cards", view.board, 5);
  setText("status-title", finished ? (view.result?.winners?.length === 2 ? "平局" : playerWon ? "你赢了这一局" : "本局结束") : view.turn === seat ? "轮到你行动" : `等待${other.name}行动`);
  setText("status-detail", finished ? view.result?.message || "" : `第 ${view.handNumber} 局 · ${PHASE_LABELS[view.phase]}`);
  const log = $("game-log");
  log.replaceChildren(...view.log.slice(0, 4).map((message) => { const item = document.createElement("li"); item.textContent = message; return item; }));
  renderControls(view);
}
function renderWaiting() {
  $("player-dealer").classList.add("hidden");
  $("opponent-dealer").classList.add("hidden");
  setText("opponent-name", state?.room?.seats?.[1 - seat]?.name || "等待朋友");
  setText("player-label", state?.room?.seats?.[seat]?.name || "你");
  setText("opponent-avatar", (state?.room?.seats?.[1 - seat]?.name || "朋").slice(0, 1));
  setText("player-avatar", (state?.room?.seats?.[seat]?.name || "你").slice(0, 1));
  setText("opponent-stack", "尚未入座");
  setText("player-stack", "1,000 筹码");
  setText("pot-amount", "0");
  setText("phase-label", "等待发牌");
  setText("status-title", state?.room?.seats?.every(Boolean) ? "两位玩家已入座" : "等待朋友加入");
  setText("status-detail", "把房间码或邀请链接发给朋友。");
  cards("opponent-cards", []);
  cards("player-cards", []);
  cards("board-cards", [], 5);
  $("game-log").replaceChildren();
  const controls = $("controls");
  controls.replaceChildren();
  if (state?.room?.seats?.every(Boolean) && seat === 0) controls.append(button("开始发牌", "primary", () => send({ type: "start_game" })));
  else {
    const note = document.createElement("span");
    note.className = "muted";
    note.textContent = seat === 0 ? "朋友入座后即可开始" : "等待房主开始";
    controls.append(note);
  }
}
function renderControls(view) {
  const controls = $("controls");
  controls.replaceChildren();
  const own = view.players[seat];
  if (view.phase === "complete") {
    if (view.players.every((player) => player.stack > 0)) {
      if (mode === "solo" || seat === 0) controls.append(button("下一局", "primary", nextHand));
      else controls.append(note("等待房主开始下一局"));
    } else if (mode === "solo" || seat === 0) {
      controls.append(button("重新开始", "primary", resetGame));
    } else controls.append(note("等待房主重开牌桌"));
    return;
  }
  if (view.turn !== seat || !view.legal) {
    controls.append(note(own.allIn ? "你已全下，等待结算" : "等待对手行动"));
    return;
  }
  const legal = view.legal;
  controls.append(button("弃牌", "secondary", () => doAction("fold")));
  if (legal.canCheck) controls.append(button("过牌", "secondary", () => doAction("check")));
  if (legal.canCall) controls.append(button(legal.toCall >= own.stack ? `全下 ${own.stack}` : `跟注 ${legal.toCall}`, "primary", () => doAction("call")));
  if (legal.canRaise) {
    const field = document.createElement("label");
    field.className = "raise-field";
    field.textContent = "加注到";
    const input = document.createElement("input");
    input.type = "number";
    input.min = Math.min(legal.minRaiseTo, legal.maxRaiseTo);
    input.max = legal.maxRaiseTo;
    input.value = input.min;
    input.id = "raise-amount";
    const raise = button("加注", "secondary", () => doAction("raise", Number(input.value)));
    field.append(input, raise);
    controls.append(field, note(`可加注到 ${input.min}–${input.max} 筹码（本轮总下注）`, "raise-hint"));
  }
}
function note(text, className = "muted") { const el = document.createElement("span"); el.className = className; el.textContent = text; return el; }
function doAction(type, amount) {
  error("");
  if (mode === "solo") {
    try { act(game, type, amount); render(); queueAi(); } catch (cause) { error(cause.message); }
  } else send({ type: "action", action: type, amount });
}
function queueAi() {
  clearTimeout(aiTimer);
  if (mode !== "solo" || !game || game.phase === "complete" || game.turn !== 1) return;
  aiTimer = setTimeout(() => {
    if (mode !== "solo" || game.turn !== 1) return;
    try { const choice = chooseAiAction(game); act(game, choice.type, choice.amount); render(); queueAi(); }
    catch (cause) { error(cause.message); }
  }, 650);
}
function nextHand() {
  error("");
  if (mode === "solo") {
    try { startHand(game); render(); queueAi(); } catch (cause) { error(cause.message); }
  } else send({ type: "next_hand" });
}
function resetGame() {
  error("");
  if (mode === "solo") {
    game = createGame(); startHand(game); render(); queueAi();
  } else send({ type: "reset_game" });
}
function startSolo() {
  leave(false);
  mode = "solo"; seat = 0; game = createGame(); startHand(game);
  setText("game-mode", "SINGLE PLAYER"); setText("game-title", "单人练习");
  setText("connection-status", "本地游戏");
  $("invite").classList.add("hidden");
  show("game-section"); render(); queueAi();
}
function endpoint() {
  const value = $("server-url").value.trim();
  if (!value) throw new Error("请先填写 Java WebSocket 服务地址");
  const parsed = new URL(value);
  if (!["wss:", "ws:"].includes(parsed.protocol)) throw new Error("服务地址必须以 wss:// 或 ws:// 开头");
  if (parsed.protocol === "ws:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) throw new Error("外网联机服务必须使用 wss://");
  if (location.protocol === "https:" && parsed.protocol !== "wss:") throw new Error("GitHub Pages 页面必须连接 wss:// 服务");
  localStorage.setItem("pokerWsUrl", parsed.href);
  return parsed.href;
}
function playerName() {
  const name = $("player-name").value.trim().slice(0, 16) || "玩家";
  localStorage.setItem("pokerPlayerName", name);
  return name;
}
function createRoom() {
  if (connecting) return;
  try {
    connecting = true; roomMessage("正在创建房间…");
    roomCode = ""; token = "";
    connect(endpoint(), { type: "create_room", name: playerName() });
  } catch (cause) { connecting = false; roomMessage(cause.message); }
}
function joinRoom() {
  if (connecting) return;
  try {
    connecting = true;
    roomCode = $("room-code").value.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(roomCode)) throw new Error("请输入 6 位房间码");
    token = localStorage.getItem(`pokerToken:${roomCode}`) || "";
    roomMessage("正在连接房间…");
    connect(endpoint(), { type: "join_room", code: roomCode, token, name: playerName() });
  } catch (cause) { connecting = false; roomMessage(cause.message); }
}
function connect(url, initialMessage) {
  clearTimeout(reconnectTimer);
  socket?.close();
  const epoch = ++connectionEpoch;
  socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    if (epoch !== connectionEpoch) return;
    socket.send(JSON.stringify(initialMessage));
  });
  socket.addEventListener("message", (event) => {
    if (epoch !== connectionEpoch) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === "error") { connecting = false; roomMessage(message.error); error(message.error); return; }
      if (message.type === "room_created" || message.type === "room_joined") {
        if (!/^[A-Z2-9]{6}$/.test(message.code) || typeof message.token !== "string" || !message.token) throw new Error("后端返回的房间信息无效");
        roomCode = message.code; token = message.token; seat = message.seat;
        localStorage.setItem(`pokerToken:${roomCode}`, token);
        connecting = false; roomMessage("");
        return;
      }
      if (message.type !== "state") return;
      if (!message.room || !Array.isArray(message.room.seats) || ![0, 1].includes(message.seat)) throw new Error("后端返回的牌桌状态无效");
      mode = "online"; seat = message.seat; state = message; roomCode = message.code || roomCode;
      connecting = false;
      setText("game-mode", "ONLINE ROOM"); setText("game-title", "在线对战");
      setText("invite-code", roomCode);
      setText("connection-status", message.room.connected?.[1 - seat] ? "● 双方在线" : "● 等待对手在线");
      $("invite").classList.remove("hidden");
      show("game-section"); error(""); render();
    } catch (cause) { error(cause.message); }
  });
  socket.addEventListener("close", () => {
    if (epoch !== connectionEpoch) return;
    connecting = false;
    if (mode === "online" && roomCode && token) {
      setText("connection-status", "● 连接中断，正在重连");
      reconnectTimer = setTimeout(() => connect(url, { type: "join_room", code: roomCode, token, name: playerName() }), 2500);
    } else roomMessage("连接失败，请检查 WebSocket 地址和服务状态。");
  });
  socket.addEventListener("error", () => roomMessage("无法连接联机服务。"));
}
function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) { error("连接已中断，请刷新页面重连"); return; }
  socket.send(JSON.stringify(payload));
}
function leave(showHome = true) {
  clearTimeout(aiTimer);
  clearTimeout(reconnectTimer);
  connectionEpoch += 1;
  socket?.close(); socket = null; game = null; state = null; mode = null; connecting = false;
  if (showHome) { history.replaceState(null, "", location.pathname); show("welcome"); }
}

$("solo-start").addEventListener("click", startSolo);
$("online-open").addEventListener("click", () => { roomMessage(""); show("room-panel"); });
$("room-back").addEventListener("click", () => leave());
$("create-room").addEventListener("click", createRoom);
$("join-room").addEventListener("click", joinRoom);
$("leave-game").addEventListener("click", () => leave());
$("copy-invite").addEventListener("click", async () => {
  try {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ room: roomCode, server: endpoint() }).toString();
    await navigator.clipboard.writeText(url.href);
    $("copy-invite").textContent = "已复制";
  } catch (cause) { error(cause.message || "复制失败，请手动复制浏览器地址"); }
});
if (query.get("room")) show("room-panel");
