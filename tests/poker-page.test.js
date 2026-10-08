import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { ticketFromLocation, ticketFragmentUrl, validateSettings, redactCredentials, normalizeWebSocketUrl } from "../src/poker-entry.js";
import { fakeSoundEnvironment } from "../test-support/poker-audio.js";

const tableScript = readFileSync(new URL("../src/poker-table.js", import.meta.url), "utf8").replace(/^export /gm, "").replace(/^import .*;\n/gm, "");
const sessionScript = readFileSync(new URL("../src/poker-session.js", import.meta.url), "utf8").replace(/^export /gm, "");
const historyScript = readFileSync(new URL("../src/poker-history.js", import.meta.url), "utf8").replace(/^export /gm, "");
const soundScript = readFileSync(new URL("../src/poker-sound.js", import.meta.url), "utf8").replace(/^export /gm, "");
const bettingScript = readFileSync(new URL("../src/poker-betting.js", import.meta.url), "utf8").replace(/^export /gm, "");
const script = bettingScript + "\n" + sessionScript + "\n" + tableScript + "\n" + historyScript + "\n" + soundScript + "\n" + readFileSync(new URL("../src/p.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");

function element() {
  return {
    value: "", textContent: "", hidden: true, disabled: false, className: "", children: [],
    listeners: {}, attributes: {}, clientWidth: 400, clientHeight: 650,
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; },
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    remove() { this.removed = true; },
    showModal() { this.open = true; },
    close(value = "") { this.open = false; this.returnValue = value; this.listeners.close?.(); },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    querySelector() { return this.submitButton ||= element(); },
    replaceChildren(...items) { this.children = items; },
    append(...items) { this.children.push(...items); },
  };
}

function mount(responses, initialToken = "", options = {}) {
  const page = readFileSync(new URL("../p.html", import.meta.url), "utf8");
  const ids = [...page.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  const calls = [];
  const sockets = [];
  const copied = [];
  const intervals = new Map();
  const timeouts = new Map();
  let timerId = 0;
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.sent = []; this.readyState = 0; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: "" }); }
    open() { this.readyState = 1; this.onopen(); }
    receive(frame) { this.onmessage({ data: JSON.stringify(frame) }); }
  }
  const storage = new Map(initialToken ? [["poker-entry-access-token", initialToken]] : []);
  class FakeFormData {
    constructor(form) { this.entries = Object.entries(form.fields || {}); }
    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  }
  const document = { body: element(), documentElement: element(), listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    getElementById(id) { return elements[id]; }, createElement: element };
  runInNewContext(script, {
    POKER_API_BASE_URL: options.apiBase || "https://api.example.com",
    ticketFromLocation, ticketFragmentUrl, validateSettings, redactCredentials, normalizeWebSocketUrl,
    window: { ...options.sound?.window, localStorage: options.sound?.localStorage, location: { href: "https://example.com/p.html#ticket=v1.k1.test", protocol: "https:", search: "", hash: "#ticket=v1.k1.test" } },
    WebSocket: FakeWebSocket, crypto: webcrypto,
    navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
    document,
    history: { replaceState() {} },
    sessionStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, value); },
      removeItem(key) { storage.delete(key); },
    },
    FormData: FakeFormData,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const next = responses.shift();
      assert.ok(next, "unexpected HTTP request");
      if (next.error) throw next.error;
      return { status: next.status, ok: next.status >= 200 && next.status < 300,
        text: async () => next.raw ?? JSON.stringify(next.body) };
    },
    AbortController, URL, URLSearchParams, Date: options.Date || Date, JSON,
    setTimeout(fn) { const id = ++timerId; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
  });
  return { elements, calls, storage, sockets, copied, intervals, timeouts, document };
}

const version = "20260930112134";
const activity = { activityId: "A123", title: "周末牌局", status: "UPCOMING" };
const self = { id: "1", nickname: "创建人", role: "CREATOR", roomState: "WATCHING" };
const counts = { activityParticipantCount: 2, roomMemberCount: 1, onlineCount: 0, seatedCount: 0 };

test("打开链接立即请求主入口；无令牌时显示服务版本和验证入口", async () => {
  const { elements, calls } = mount([{ status: 401, body: {
    code: 401, message: "请先登录", data: null, error: "BusinessException: 请先登录", systemVersion: version,
  } }]);
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/api/poker/v1/entry");
  assert.deepEqual(JSON.parse(calls[0].options.body), { ticket: "v1.k1.test" });
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(elements["system-version"].textContent, version);
  assert.equal(elements["login-panel"].hidden, false);
  assert.match(elements["debug-response"].textContent, /BusinessException/);
});

test("普通成员遇到未建房时看到联系创建人提示", async () => {
  const { elements } = mount([{ status: 200, body: {
    code: 0, message: "success", systemVersion: version,
    data: { entryState: "WAITING_FOR_CREATOR", canCreate: false,
      activity, self: { ...self, role: "MEMBER" }, counts },
  } }], "access-token");
  await new Promise(setImmediate);
  assert.equal(elements["waiting-panel"].hidden, false);
  assert.equal(elements["create-panel"].hidden, true);
});

test("首次 401 后输入 Bearer token 会重试主入口", async () => {
  const { elements, calls, storage } = mount([
    { status: 401, body: { code: 401, message: "请先登录", data: null, systemVersion: version } },
    { status: 200, body: { code: 0, message: "success", data: {
      entryState: "WAITING_FOR_CREATOR", canCreate: false, activity, self: { ...self, role: "MEMBER" }, counts,
    }, systemVersion: version } },
  ]);
  await new Promise(setImmediate);
  elements["access-token"].value = "new-access-token";
  elements["login-form"].listeners.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Authorization, "Bearer new-access-token");
  assert.equal(storage.get("poker-entry-access-token"), "new-access-token");
  assert.equal(elements["waiting-panel"].hidden, false);
});

test("跨域或网络错误显示可重试错误状态", async () => {
  const { elements } = mount([{ error: new TypeError("Failed to fetch") }], "access-token");
  await new Promise(setImmediate);
  assert.equal(elements["error-panel"].hidden, false);
  assert.match(elements["error-detail"].textContent, /跨域/);
  assert.equal(elements["system-version"].textContent, "未返回");
});

test("已有房间直接展示牌桌并自动连接 WebSocket", async () => {
  const settings = { maxSeats: 6, seatingType: 0, smallBlind: 10, bigBlind: 20, startingStack: 1000, turnSeconds: 30, durationMinutes: 120 };
  const { elements, calls } = mount([{ status: 200, body: {
    code: 0, message: "success", systemVersion: version,
    data: { entryState: "ROOM_READY", created: false, activity, self, counts,
      room: { roomId: "A123", name: "周末牌局", status: "WAITING", settings },
      roomMembers: [{ id: "1", nickname: "创建人", state: "WATCHING", stack: 1000, online: false }],
      connection: { url: "wss://api.example.com/ws/poker/v1", wsToken: "secret", protocolVersion: 1, expiresAt: new Date(Date.now() + 60000).toISOString() } },
  } }], "access-token");
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  assert.equal(elements["room-panel"].hidden, false);
  assert.equal(elements["create-panel"].hidden, true);
  assert.equal(elements["room-title"].textContent, "周末牌局");
  assert.equal(elements["ws-url"].textContent, "wss://api.example.com/ws/poker/v1");
});

test("创建人选择配置建房后显示房间和 WebSocket 链接", async () => {
  const settings = { maxSeats: 6, seatingType: 0, smallBlind: 10, bigBlind: 20, startingStack: 1000, turnSeconds: 30, durationMinutes: 120 };
  const { elements, calls } = mount([
    { status: 200, body: { code: 0, message: "success", systemVersion: version,
      data: { entryState: "READY_TO_CREATE", canCreate: true, activity, self, counts } } },
    { status: 200, body: { code: 0, message: "success", systemVersion: version,
      data: { entryState: "ROOM_CREATED", created: true, activity, self, counts,
        room: { roomId: "A123", name: "周末牌局", status: "WAITING", settings },
        roomMembers: [{ id: "1", nickname: "创建人", state: "WATCHING", stack: 1000, online: false }],
        connection: { url: "wss://api.example.com/ws/poker/v1", wsToken: "secret", protocolVersion: 1, expiresAt: new Date(Date.now() + 60000).toISOString() } } } },
  ], "access-token");
  await new Promise(setImmediate);
  assert.equal(elements["create-panel"].hidden, false);
  elements["create-form"].fields = Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, String(value)]));
  await elements["create-form"].listeners.submit({ preventDefault() {} });
  assert.equal(calls[1].url, "https://api.example.com/api/poker/v1/rooms");
  assert.equal(calls[1].options.headers.Authorization, "Bearer access-token");
  assert.deepEqual(JSON.parse(calls[1].options.body).settings, settings);
  assert.equal(elements["room-panel"].hidden, false);
  assert.equal(elements["connection-panel"].hidden, false);
  assert.equal(elements["ws-url"].textContent, "wss://api.example.com/ws/poker/v1");
  assert.equal(elements["system-version"].textContent, version);
  assert.doesNotMatch(elements["debug-response"].textContent, /secret/);
});

const cloudBase = "https://springboot-thzo-281960-9-1453811837.sh.run.tcloudbase.com";
const publicWsUrl = cloudBase.replace("https:", "wss:") + "/ws/poker/v1";
function roomResponse(connectionOverrides = {}, dataOverrides = {}) {
  return { status: 200, body: { code: 0, message: "success", systemVersion: version,
    data: { entryState: "ROOM_READY", activity, self, counts,
      room: { roomId: "A123", name: "周末牌局", status: "WAITING" },
      connection: { url: publicWsUrl.replace("/ws/", ":80/ws/"), wsToken: "secret",
        protocolVersion: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), ...connectionOverrides },
      ...dataOverrides } } };
}

test("仅修正与 HTTPS API 同域的云托管 WSS 80 端口，保留路径和查询参数", () => {
  assert.equal(normalizeWebSocketUrl(publicWsUrl.replace("/ws/", ":80/ws/") + "?v=1", cloudBase), publicWsUrl + "?v=1");
  for (const url of [
    publicWsUrl, publicWsUrl.replace("/ws/", ":8443/ws/"),
    "wss://custom.example.com:80/ws/poker/v1", "ws://localhost:80/ws/poker/v1",
  ]) assert.equal(normalizeWebSocketUrl(url, cloudBase), new URL(url).href);
  const otherHost = "wss://other.sh.run.tcloudbase.com:80/ws/poker/v1";
  assert.equal(normalizeWebSocketUrl(otherHost, cloudBase), otherHost);
});

test("展示、复制、连接使用修正后的云托管地址，并完成 AUTH、心跳及房间同步", async () => {
  const { elements, sockets, copied, intervals } = mount([roomResponse()], "", { apiBase: cloudBase });
  await new Promise(setImmediate);
  assert.equal(elements["ws-url"].textContent, publicWsUrl);
  assert.match(elements["debug-response"].textContent, /:80\/ws/);
  await elements["copy-ws-url"].listeners.click();
  assert.deepEqual(copied, [publicWsUrl]);
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  assert.equal(socket.url, publicWsUrl);
  socket.open();
  assert.equal(elements["ws-status"].textContent, "正在认证");
  assert.equal(socket.sent[0].type, "AUTH");
  assert.deepEqual(socket.sent[0].payload, { wsToken: "secret" });
  assert.ok(socket.sent[0].requestId);
  socket.receive({ type: "AUTH_OK", systemVersion: "20260930200000" });
  assert.equal(elements["ws-status"].textContent, "已连接");
  assert.equal(elements["system-version"].textContent, "20260930200000");
  assert.equal(intervals.size, 1);
  [...intervals.values()][0]();
  assert.equal(socket.sent[1].type, "PING");
  socket.receive({ type: "SNAPSHOT", payload: { counts: { ...counts, onlineCount: 1 } } });
  assert.equal(elements["online-count"], undefined);
  socket.onclose({ code: 4001, reason: "AUTH_TIMEOUT" });
  assert.match(elements["ws-detail"].textContent, /4001.*AUTH_TIMEOUT/);
  assert.equal(intervals.size, 0);
});

test("过期凭证通过主入口刷新，使用新 wsToken 认证", async () => {
  const { elements, calls, sockets } = mount([
    roomResponse({ expiresAt: "2000-01-01T00:00:00Z" }),
    roomResponse({ wsToken: "fresh-secret" }),
  ], "", { apiBase: cloudBase });
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, cloudBase + "/api/poker/v1/entry");
  sockets[0].open();
  assert.equal(sockets[0].sent[0].payload.wsToken, "fresh-secret");
});

test("刷新后房间已关闭或凭证仍过期时不建立 WebSocket", async () => {
  for (const next of [
    roomResponse({}, { entryState: "ROOM_CLOSED", connection: null }),
    roomResponse({ expiresAt: "2000-01-01T00:00:00Z" }),
  ]) {
    const { elements, sockets } = mount([
      roomResponse({ expiresAt: "2000-01-01T00:00:00Z" }), next,
    ], "", { apiBase: cloudBase });
    await new Promise(setImmediate);
    assert.equal(sockets.length, 0);
  }
});

test("握手和认证错误在后续 close 事件后仍可见", async () => {
  const { elements, sockets } = mount([roomResponse()], "", { apiBase: cloudBase });
  await new Promise(setImmediate);
  sockets[0].onerror();
  sockets[0].onclose({ code: 1006, reason: "" });
  assert.equal(elements["ws-status"].textContent, "重连中");
  assert.match(elements["ws-detail"].textContent, /TLS.*1006/);
  await elements["connect-ws"].listeners.click();
  sockets[1].open();
  sockets[1].receive({ type: "AUTH_EXPIRED", payload: { message: "连接凭证已过期" } });
  sockets[1].onclose({ code: 4001, reason: "AUTH_EXPIRED" });
  assert.match(elements["ws-detail"].textContent, /连接凭证已过期.*4001.*AUTH_EXPIRED/);
  assert.equal(elements["ws-status"].textContent, "重连中");
});

test("HTTPS 页面拒绝明文 WS 地址，旧连接事件不影响新连接", async () => {
  const invalid = mount([roomResponse({ url: "ws://localhost/ws/poker/v1" })]);
  await new Promise(setImmediate);
  assert.equal(invalid.sockets.length, 0);
  assert.equal(invalid.elements["ws-status"].textContent, "连接地址无效");

  const { elements, sockets, intervals } = mount([roomResponse()], "", { apiBase: cloudBase });
  await new Promise(setImmediate);
  await elements["connect-ws"].listeners.click();
  sockets[1].open();
  sockets[1].receive({ type: "AUTH_OK" });
  sockets[0].onerror();
  sockets[0].onclose({ code: 1006, reason: "" });
  assert.equal(elements["ws-status"].textContent, "已连接");
  assert.equal(intervals.size, 1);
});

function gameSnapshot(overrides = {}) {
  return { revision: 1, self: { ...self, seatIndex: 0, roomState: "IN_HAND", allowedCommands: [] },
    room: { roomId: "A123", settings: { maxSeats: 6, smallBlind: 1, bigBlind: 2, turnSeconds: 30 } },
    game: { handId: "H1", handNumber: 1, phase: "preflop", board: [], turn: 0, dealer: 1, pot: 6,
      players: [{ seatIndex: 0, nickname: "本人", stack: 200, bet: 0, hole: ["Jc", "7h"] },
        { seatIndex: 1, nickname: "对手", stack: 197, bet: 3, hole: ["As", "Ah"] }],
      legal: { toCall: 3, canFold: true, canCall: true, canCheck: false, canRaise: true, minRaiseTo: 6, maxRaiseTo: 200 } }, ...overrides };
}
function authenticate(socket) { socket.open(); socket.receive({ type: "AUTH_OK" }); }
function descendants(root) { return [root, ...root.children.flatMap(descendants)]; }

test("点击头像展示昵称及安全头像；本人手牌反复翻转、同步保留隐藏、新手恢复", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  first.game.players[0].avatarUrl = "https://example.com/me.jpg";
  first.game.players[1].nickname = "<对手>";
  first.game.players[1].avatarUrl = "javascript:alert(1)";
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  const avatar = (index) => descendants(elements["table-seats"].children[index]).find(n => n.className === "seat-avatar");
  const mine = () => descendants(elements["table-seats"].children[0]).filter(n => n.className.includes("hole-flip") && n.className.startsWith("card"));
  const sentCount = sockets[0].sent.length;
  avatar(1).listeners.click();
  assert.equal(elements["player-profile"].hidden, false);
  assert.equal(elements["player-profile-name"].textContent, "<对手>");
  assert.equal(elements["player-profile-avatar"].children.length, 1);
  assert.ok(mine().every(n => !n.className.includes("is-hidden")));
  avatar(0).listeners.click();
  assert.equal(elements["player-profile-name"].textContent, "本人");
  assert.ok(elements["player-profile-avatar"].children.some(n => n.src === "https://example.com/me.jpg"));
  assert.ok(mine().every(n => n.className.includes("is-hidden") && n.attributes["aria-label"] === "隐藏底牌"));
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, game: { ...first.game, pot: 12 } } });
  assert.ok(mine().every(n => n.className.includes("is-hidden")));
  avatar(0).listeners.click();
  assert.deepEqual(mine().map(n => n.attributes["aria-label"]), ["J♣", "7♥"]);
  avatar(0).listeners.click();
  elements["close-player-profile"].listeners.click();
  assert.equal(elements["player-profile"].hidden, true);
  assert.ok(mine().every(n => n.className.includes("is-hidden")));
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 3, game: { ...first.game, handId: "H2" } } });
  assert.ok(mine().every(n => !n.className.includes("is-hidden")));
  assert.equal(sockets[0].sent.length, sentCount);
});

test("底池筹码堆随权威金额更新，零底池清空，点击桌面和Escape关闭头像信息", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot(); sockets[0].receive({ type: "SNAPSHOT", payload: first });
  const initialCount = descendants(elements["pot-chips"]).filter(n => n.className === "chip pot-chip").length;
  assert.equal(elements["pot-chips"].hidden, false);
  assert.ok(initialCount > 0);
  const avatar = descendants(elements["table-seats"].children[1]).find(n => n.className === "seat-avatar");
  avatar.listeners.click();
  elements["table-stage"].listeners.click({ target: { closest: () => null } });
  assert.equal(elements["player-profile"].hidden, true);
  avatar.listeners.click(); elements["table-stage"].listeners.keydown({ key: "Escape" });
  assert.equal(elements["player-profile"].hidden, true);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, game: { ...first.game, pot: 2000 } } });
  assert.ok(descendants(elements["pot-chips"]).filter(n => n.className === "chip pot-chip").length > initialCount);
  assert.equal(elements["table-pot"].textContent, "2,000");
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 3, game: { ...first.game, pot: 0 } } });
  assert.equal(elements["pot-chips"].hidden, true);
  assert.equal(elements["pot-chips"].children.length, 0);
});

test("403 与解密错误只给对应提示，不展示登录表单或旧房间", async () => {
  for (const [status, detail] of [[403, "你不是活动成员"], [400, "ticket 解密失败"]]) {
    const { elements, sockets } = mount([{ status, body: { code: status, message: detail } }]);
    await new Promise(setImmediate);
    assert.equal(elements["error-panel"].hidden, false);
    assert.equal(elements["error-detail"].textContent, detail);
    assert.equal(elements["login-panel"].hidden, true);
    assert.equal(elements["message"].textContent, "");
    assert.equal(elements["debug-panel"].hidden, true);
    assert.equal(sockets.length, 0);
  }
});

test("自动认证后等到快照才允许行动，发送操作后等待服务端确认且不修改筹码", async () => {
  const { elements, sockets } = mount([roomResponse({}, { ...gameSnapshot(), entryState: "ROOM_READY" })]);
  await new Promise(setImmediate);
  assert.equal(sockets.length, 1);
  authenticate(sockets[0]);
  assert.equal(elements["fold-action"].disabled, true);
  sockets[0].receive({ type: "SNAPSHOT", payload: gameSnapshot() });
  assert.equal(elements["fold-action"].disabled, false);
  elements["call-action"].listeners.click();
  assert.equal(elements["call-action"].disabled, true);
  const action = sockets[0].sent.at(-1);
  assert.equal(action.type, "ACTION");
  assert.equal(action.payload.action, "call");
  assert.equal(action.payload.handId, "H1");
  assert.equal(action.payload.expectedRevision, 1);
  elements["call-action"].listeners.click();
  assert.equal(sockets[0].sent.filter((f) => f.type === "ACTION").length, 1);
  assert.ok(descendants(elements["table-seats"]).some((e) => e.className === "seat-stack" && e.textContent === "200"));
  sockets[0].receive({ type: "ERROR", payload: { message: "下注已过期" } });
  assert.equal(elements["ws-status"].textContent, "已连接");
  assert.equal(elements["table-notice"].textContent, "下注已过期");
});

test("隐藏对手底牌，忽略旧快照，同一手不重复发牌；新手触发两轮动画", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot(); sockets[0].receive({ type: "SNAPSHOT", payload: first });
  assert.equal(elements["deal-layer"].children.length, 4);
  const originalFlights = elements["deal-layer"].children;
  const cards = descendants(elements["table-seats"]).filter((e) => e.className.startsWith("card"));
  assert.equal(cards.filter((e) => e.className.includes("back")).length, 2);
  assert.ok(!descendants(elements["table-seats"]).some((e) => e.attributes["aria-label"] === "A♠"));
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, game: { ...first.game, pot: 12, board: ["As", "Th", "2d"] } } });
  assert.equal(elements["table-pot"].textContent, "12");
  assert.equal(elements["deal-layer"].children, originalFlights);
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  assert.equal(elements["table-pot"].textContent, "12");
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 3, game: { ...first.game, handId: "H2", handNumber: 2 } } });
  assert.notEqual(elements["deal-layer"].children, originalFlights);
});

test("旁观者不可行动；服务端授权后才显示入座准备选项；关房移除牌桌", async () => {
  const { elements, sockets } = mount([roomResponse(), roomResponse({}, { entryState: "ROOM_CLOSED", connection: null })]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  sockets[0].receive({ type: "SNAPSHOT", payload: gameSnapshot({ self: { ...self, seatIndex: null, allowedCommands: ["SIT_DOWN"] } }) });
  assert.equal(elements["fold-action"].disabled, true);
  const empty = elements["table-seats"].children.find((seat) => seat.className.includes(" empty"));
  assert.equal(empty.disabled, false);
  assert.equal(elements["ready-player"].hidden, true);
  empty.listeners.click();
  assert.equal(sockets[0].sent.at(-1).type, "SIT_DOWN");
  sockets[0].receive({ type: "ROOM_CLOSED" });
  assert.equal(elements["settlement-panel"].hidden, false);
  assert.equal(elements["room-panel"].hidden, true);
});

test("本人换座后仍在正下方，D/SB/BB 随最新牌局正确换位，双人同时保留D和SB且不显示中文位置", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot({ room: { settings: { maxSeats: 2 } } });
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  let seats = elements["table-seats"].children;
  assert.equal(seats.length, 2);
  const selfSeat = seats.find((seat) => seat.className.includes(" self"));
  assert.equal(selfSeat.style.values["--x"], "50%");
  assert.equal(selfSeat.style.values["--y"], "89%");
  const badges = (seat) => descendants(seat).filter((node) => node.className.startsWith("seat-marker ")).map((node) => node.textContent);
  assert.deepEqual(badges(seats.find((seat) => seat.attributes["data-seat-index"] === "1")), ["D", "SB"]);
  assert.deepEqual(badges(selfSeat), ["BB"]);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, self: { ...first.self, seatIndex: 1 }, game: { ...first.game, dealer: 0, smallBlindSeat: 0, bigBlindSeat: 1 } } });
  seats = elements["table-seats"].children;
  assert.equal(seats[0].attributes["data-seat-index"], "1");
  assert.equal(seats[0].style.values["--x"], "50%");
  assert.deepEqual(badges(seats[0]), ["BB"]);
  assert.deepEqual(badges(seats[1]), ["D", "SB"]);
  assert.ok(!descendants(elements["table-seats"]).some(node => node.className === "seat-position"));
});

function lobbySnapshot(overrides = {}) {
  return { revision: 1,
    self: { userId: "host", nickname: "房主", role: "CREATOR", seatIndex: null, roomState: "WATCHING", allowedCommands: ["SIT_DOWN", "START_HAND"] },
    room: { roomId: "A123", status: "WAITING", playState: "WAITING", settings: { maxSeats: 6, seatingType: 0 } },
    roomMembers: [{ userId: "u1", nickname: "已落座成员", seatIndex: 1, state: "SEATED", stack: 200 }],
    counts: { seatedCount: 1 }, game: null, ...overrides };
}

test("点击虚线座位发送真实座位号，重复点击被锁定，确认落座后显示头像昵称并居中", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = lobbySnapshot({ room: { ...lobbySnapshot().room, settings: { ...lobbySnapshot().room.settings, seatingType: 1 } } }); sockets[0].receive({ type: "SNAPSHOT", payload: first });
  const empty = elements["table-seats"].children.find((seat) => seat.attributes["data-seat-index"] === "4");
  empty.listeners.click(); empty.listeners.click();
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "SIT_DOWN").length, 1);
  assert.equal(sockets[0].sent.at(-1).payload.seatIndex, 4);
  assert.deepEqual(sockets[0].sent.at(-1).payload, { seatIndex: 4 });
  assert.equal(empty.disabled, true);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2,
    self: { ...first.self, seatIndex: 4, roomState: "SEATED", avatarUrl: "https://example.com/avatar.jpg", allowedCommands: ["STAND_UP", "START_HAND"] },
    roomMembers: [...first.roomMembers, { userId: "host", nickname: "房主昵称", seatIndex: 4, state: "SEATED", stack: 200 }] } });
  const mine = elements["table-seats"].children.find((seat) => seat.className.includes(" self"));
  assert.equal(mine.attributes["data-seat-index"], "4");
  assert.equal(mine.style.values["--x"], "50%");
  assert.equal(descendants(mine).find((node) => node.className === "seat-name").textContent, "房主昵称");
  assert.ok(descendants(mine).some((node) => node.src === "https://example.com/avatar.jpg"));
  assert.equal(elements["stand-up"].hidden, false);
  assert.equal(elements["start-hand"].disabled, false);
});

test("仅房主可控制游戏，按实际成员列表限制两人开局，服务端错误授权普通成员也不会显示管理项", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = lobbySnapshot({ counts: { seatedCount: 9 } });
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  assert.equal(elements["host-controls"].hidden, false);
  assert.equal(elements["start-hand"].disabled, true);
  elements["start-hand"].listeners.click();
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "START_HAND").length, 0);
  const members = [...first.roomMembers, { userId: "u2", seatIndex: 3, state: "SEATED" }];
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, roomMembers: members } });
  assert.equal(elements["start-hand"].disabled, false);
  elements["start-hand"].listeners.click();
  assert.equal(sockets[0].sent.at(-1).type, "START_HAND");
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 3, roomMembers: members,
    self: { ...first.self, role: "MEMBER", allowedCommands: ["START_HAND", "PAUSE_GAME", "RESUME_GAME"] } } });
  assert.equal(elements["host-controls"].hidden, true);
  assert.equal(elements["start-hand"].hidden, true);
  assert.equal(elements["pause-game"], undefined);
  elements["start-hand"].listeners.click();
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "START_HAND").length, 1);
});

test("整场倒计时等待首次开始成功，服务器时间校准且刷新与重复快照不重置", async () => {
  let now = Date.now(); class ClockDate extends Date { static now() { return now; } }
  const serverTime = () => new Date(now + 60000).toISOString();
  const lobby = lobbySnapshot();
  lobby.room.settings.durationMinutes = 120;
  lobby.room.timing = { status: "WAITING", startedAt: null, endsAt: null };
  lobby.roomMembers.push({ userId: "u2", seatIndex: 2, state: "SEATED", stack: 200 });
  lobby.serverTime = serverTime();
  const { elements, sockets, intervals } = mount([roomResponse({}, lobby)], "", { Date: ClockDate });
  await new Promise(setImmediate); authenticate(sockets[0]);
  sockets[0].receive({ type: "SNAPSHOT", payload: lobby });
  assert.equal(elements["session-countdown"].textContent, "等待房主开始游戏");
  now += 3 * 60 * 60 * 1000;
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...lobby, revision: 2, serverTime: serverTime() } });
  for (const tick of intervals.values()) tick();
  assert.equal(elements["session-countdown"].textContent, "等待房主开始游戏");
  elements["start-hand"].listeners.click();
  assert.deepEqual(sockets[0].sent.at(-1).payload, {});
  assert.equal(sockets[0].sent.at(-1).type, "START_HAND");
  assert.equal(elements["session-countdown"].textContent, "等待房主开始游戏");
  sockets[0].receive({ type: "ERROR", requestId: sockets[0].sent.at(-1).requestId,
    payload: { message: "开局条件发生变化，请重试" } });
  assert.equal(elements["session-countdown"].textContent, "等待房主开始游戏");
  assert.equal(elements["start-hand"].disabled, false);
  elements["start-hand"].listeners.click();
  assert.equal(sockets[0].sent.at(-1).type, "START_HAND");
  const started = { ...gameSnapshot(), revision: 3, serverTime: serverTime(),
    room: { ...lobby.room, status: "PLAYING", playState: "RUNNING",
      timing: { status: "OPEN", startedAt: serverTime(), endsAt: new Date(now + 60000 + 120 * 60000).toISOString() } } };
  sockets[0].receive({ type: "SNAPSHOT", payload: started });
  assert.equal(elements["session-countdown"].textContent, "剩余 02:00:00");
  now += 65000;
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...started, revision: 4, serverTime: serverTime() } });
  for (const tick of intervals.values()) tick();
  assert.equal(elements["session-countdown"].textContent, "剩余 01:58:55");
  const refreshed = mount([roomResponse({ expiresAt: new Date(now + 60000).toISOString() }, { ...started, serverTime: serverTime() })], "", { Date: ClockDate });
  await new Promise(setImmediate);
  assert.equal(refreshed.elements["session-countdown"].textContent, "剩余 01:58:55");
  assert.ok(!refreshed.sockets[0].sent.some(frame => frame.type === "START_HAND"));
});

test("服务端授权暂停、继续和关闭也不恢复入口或发送对应命令", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot({
    self: { ...self, seatIndex: 0, roomState: "IN_HAND", allowedCommands: ["PAUSE_GAME", "RESUME_GAME", "CLOSE_GAME", "START_HAND"] },
  });
  const sent = sockets[0].sent.length;
  for (const [index, playState] of ["RUNNING", "PAUSE_PENDING", "PAUSED"].entries()) {
    sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: index + 1,
      room: { ...first.room, playState }, game: { ...first.game, phase: playState === "PAUSED" ? "complete" : "preflop" } } });
    for (const id of ["pause-game", "resume-game", "close-game", "close-game-dialog", "play-state-notice"]) {
      assert.equal(elements[id], undefined);
    }
    assert.doesNotMatch(elements["host-control-detail"].textContent, /暂停|关闭|房主继续/);
    assert.doesNotMatch(elements["table-notice"].textContent, /暂停|关闭|房主继续/);
    assert.equal(elements["start-hand"].hidden, true);
    elements["start-hand"].listeners.click();
    assert.equal(elements["call-action"].disabled, playState === "PAUSED");
  }
  assert.equal(sockets[0].sent.length, sent);
});

test("开局后本手和等待下一手都隐藏准备，新成员标明下局加入且不获当前手牌", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const member = { userId: "new", seatIndex: 3, nickname: "新玩家", ready: true, state: "READY", participation: "WAITING_NEXT_HAND", stack: 200 };
  const first = gameSnapshot({ self: { ...member, roomState: "READY", allowedCommands: ["READY", "UNREADY", "STAND_UP"] },
    roomMembers: [member], room: { playState: "RUNNING", settings: { maxSeats: 6 } } });
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  assert.equal(elements["ready-player"].hidden, true); assert.equal(elements["unready-player"].hidden, true);
  assert.equal(elements["self-state"].textContent, "下局加入");
  assert.ok(descendants(elements["table-seats"]).some(node => node.className === "seat-next-hand" && node.textContent === "下局加入"));
  assert.ok(!descendants(elements["table-seats"]).some(node => node.className === "seat-readiness"));
  assert.equal(elements["call-action"].disabled, true);
  const seat = elements["table-seats"].children.find(node => node.getAttribute("data-seat-index") === "3");
  assert.ok(!descendants(seat).some(node => node.className === "hole-cards"));
  const complete = { ...first, revision: 2, game: { ...first.game, phase: "complete", legal: null } };
  sockets[0].receive({ type: "SNAPSHOT", payload: complete });
  assert.equal(elements["self-state"].textContent, "下局加入");
  assert.equal(elements["ready-player"].hidden, true); assert.equal(elements["unready-player"].hidden, true);
  const next = { ...first, revision: 3, game: { ...first.game, handId: "H2", turn: 3, players: [...first.game.players, { ...member, hole: ["As", "Ks"] }] } };
  sockets[0].receive({ type: "SNAPSHOT", payload: next });
  assert.equal(elements["self-state"].textContent, "牌局中");
  assert.ok(!descendants(elements["table-seats"]).some(node => node.className === "seat-next-hand"));
  assert.equal(elements["call-action"].disabled, false);
});

test("本手起身经自定义确认只发 STAND_UP，服务端确认后转旁观并保留弃牌特效", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot(); first.self.allowedCommands = ["STAND_UP"];
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  const confirmed = elements["stand-up"].listeners.click();
  assert.match(elements["stand-dialog-description"].textContent, /立即放弃本手.*底池/);
  elements["confirm-stand"].listeners.click(); await confirmed;
  assert.deepEqual(sockets[0].sent.at(-1).payload, {}); assert.equal(sockets[0].sent.at(-1).type, "STAND_UP");
  assert.ok(!sockets[0].sent.some(frame => frame.type === "ACTION"));
  assert.equal(elements["stand-up"].hidden, false);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, self: { ...first.self, seatIndex: null, allowedCommands: [] },
    game: { ...first.game, turn: 1, legal: null, players: first.game.players.map((p, i) => ({ ...p, folded: i === 0 })) } } });
  assert.equal(elements["stand-up"].hidden, true); assert.equal(elements["call-action"].disabled, true);
  assert.ok(descendants(elements["table-seats"]).some(node => node.className === "seat-state" && node.textContent === "已弃牌"));
});

test("服务端主动结束时继续完成当前手并显示结算提示", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first,
    room: { ...first.room, timing: { status: "ENDING", reason: "HOST_CLOSED" } } } });
  assert.equal(elements["call-action"].disabled, false);
  assert.match(elements["session-countdown"].textContent, /房主已结束本场/);
  assert.equal(elements["start-hand"].disabled, true);
});

test("旧服务没有本手起身授权时说明原因，不假装完成", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  sockets[0].receive({ type: "SNAPSHOT", payload: gameSnapshot() });
  assert.equal(elements["stand-up"].disabled, true); assert.match(elements["stand-detail"].textContent, /尚未授权/);
  await elements["stand-up"].listeners.click();
  assert.ok(!sockets[0].sent.some(frame => ["STAND_UP", "CLOSE_GAME"].includes(frame.type)));
});

test("起身确认期间进入新手牌，不能沿用旧确认放弃新手", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot(); first.self.allowedCommands = ["STAND_UP"];
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  const confirmed = elements["stand-up"].listeners.click();
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, game: { ...first.game, handId: "H2" } } });
  elements["confirm-stand"].listeners.click(); await confirmed;
  assert.ok(!sockets[0].sent.some(frame => frame.type === "STAND_UP"));
  assert.match(elements["error-dialog-message"].textContent, /重新确认/);
});

test("起身使用页面确认动画，取消不发请求，确认后发 STAND_UP，旁观者隐藏选项", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = lobbySnapshot({ self: { userId: "u1", role: "MEMBER", seatIndex: 1, roomState: "SEATED", allowedCommands: ["STAND_UP"] } });
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  assert.equal(elements["host-controls"].hidden, true);
  const cancelled = elements["stand-up"].listeners.click();
  assert.equal(elements["stand-dialog"].open, true);
  elements["cancel-stand"].listeners.click(); await cancelled;
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "STAND_UP").length, 0);
  const accepted = elements["stand-up"].listeners.click();
  elements["confirm-stand"].listeners.click(); await accepted;
  assert.equal(sockets[0].sent.at(-1).type, "STAND_UP");
  assert.deepEqual(sockets[0].sent.at(-1).payload, {});
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, self: { ...first.self, seatIndex: null }, roomMembers: [] } });
  assert.equal(elements["stand-up"].hidden, true);
  await elements["stand-up"].listeners.click();
  assert.equal(elements["stand-dialog"].open, false);
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "STAND_UP").length, 1);
});

test("页面不显示品牌名称，菜单标题优先使用活动名称", async () => {
  const { elements } = mount([roomResponse({}, { activity: { title: "周末活动" }, room: { name: "另一个房间名" } })]);
  await new Promise(setImmediate);
  assert.equal(elements["room-title"].textContent, "周末活动");
  const html = readFileSync(new URL("../p.html", import.meta.url), "utf8");
  const header = html.match(/<header[\s\S]*?<\/header>/)[0];
  assert.doesNotMatch(header, /♠|活动专属牌局|page-title|brand/);
  assert.doesNotMatch(html, /算法培训班|桌边|table-wordmark/);
});

test("随机落座发送空 payload，准备、起身和开始不夹带 Java 不接受的 revision 字段", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = lobbySnapshot(); sockets[0].receive({ type: "SNAPSHOT", payload: first });
  elements["table-seats"].children.find((seat) => seat.className.includes(" empty")).listeners.click();
  assert.equal(sockets[0].sent.at(-1).type, "SIT_DOWN");
  assert.deepEqual(sockets[0].sent.at(-1).payload, {});
  const seated = { ...first, revision: 2, self: { ...first.self, seatIndex: 2, allowedCommands: ["READY", "START_HAND", "STAND_UP"] },
    roomMembers: [...first.roomMembers, { userId: "host", seatIndex: 2, state: "SEATED" }] };
  for (const [id, type] of [["ready-player", "READY"], ["start-hand", "START_HAND"], ["stand-up", "STAND_UP"]]) {
    sockets[0].receive({ type: "SNAPSHOT", payload: { ...seated, revision: seated.revision++ } });
    const completion = elements[id].listeners.click();
    if (type === "STAND_UP") { elements["confirm-stand"].listeners.click(); await completion; }
    assert.equal(sockets[0].sent.at(-1).type, type);
    assert.deepEqual(sockets[0].sent.at(-1).payload, {});
  }
});

test("旧快照缺少 allowedCommands 仍可申请落座，明确禁止落座则显示原因且不发送", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = lobbySnapshot(); delete first.self.allowedCommands;
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  elements["table-seats"].children.find((seat) => seat.className.includes(" empty")).listeners.click();
  assert.equal(sockets[0].sent.at(-1).type, "SIT_DOWN");
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, self: { ...first.self, allowedCommands: [] } } });
  const button = elements["table-seats"].children.find((seat) => seat.className.includes(" empty"));
  assert.equal(button.disabled, false);
  button.listeners.click();
  assert.match(elements["table-notice"].textContent, /暂不允许落座/);
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "SIT_DOWN").length, 1);
});

test("连接未就绪及当前牌局不允许落座时，点击空座始终显示原因", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate);
  elements["table-seats"].children.find((seat) => seat.className.includes(" empty")).listeners.click();
  assert.match(elements["table-notice"].textContent, /连接尚未就绪/);
  authenticate(sockets[0]);
  sockets[0].receive({ type: "SNAPSHOT", payload: gameSnapshot({ self: { ...self, seatIndex: null, allowedCommands: [] } }) });
  elements["table-seats"].children.find((seat) => seat.className.includes(" empty")).listeners.click();
  assert.match(elements["table-notice"].textContent, /等本局结束/);
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "SIT_DOWN").length, 0);
});

test("HTTP 异常弹框显示对应请求及返回，隐藏凭证，关闭后可重新查看且后续请求不会覆盖详情", async () => {
  const { elements } = mount([
    { status: 403, body: { code: 403, message: "无活动权限", error: "BusinessException", wsToken: "returned-secret" } },
    { status: 200, body: { code: 0, data: { entryState: "WAITING_FOR_CREATOR", activity, self, counts } } },
  ], "access-secret");
  await new Promise(setImmediate);
  assert.equal(elements["error-dialog"].open, true);
  assert.equal(elements["error-dialog-message"].textContent, "无活动权限");
  assert.equal(elements["error-diagnostics"].open, false);
  assert.match(elements["error-request"].textContent, /POST.*|api\/poker\/v1\/entry/);
  assert.match(elements["error-request"].textContent, /已隐藏/);
  assert.doesNotMatch(elements["error-request"].textContent, /v1.k1.test|access-secret/);
  assert.match(elements["error-response"].textContent, /403.*|BusinessException/);
  assert.doesNotMatch(elements["error-response"].textContent, /returned-secret/);
  const original = elements["error-response"].textContent;
  elements["close-error"].listeners.click();
  assert.equal(elements["error-dialog"].open, false);
  assert.equal(elements["show-error"].hidden, false);
  await elements["retry-entry"].listeners.click();
  elements["show-error"].listeners.click();
  assert.equal(elements["error-dialog"].open, true);
  assert.equal(elements["error-response"].textContent, original);
});

test("非 JSON 响应及无响应的网络错误仍提供真实诊断信息", async () => {
  for (const response of [
    { status: 502, raw: "<html>upstream unavailable</html>" },
    { error: new TypeError("Failed to fetch") },
    { error: Object.assign(new Error("aborted"), { name: "AbortError" }) },
  ]) {
    const { elements } = mount([response]);
    await new Promise(setImmediate);
    assert.equal(elements["error-dialog"].open, true);
    assert.match(elements["error-request"].textContent, /api\/poker\/v1\/entry/);
    if (response.raw) assert.match(elements["error-response"].textContent, /502.*|upstream unavailable/);
    else assert.match(elements["error-response"].textContent, /"received": false/);
    if (response.error?.name === "AbortError") assert.match(elements["error-dialog-message"].textContent, /超时/);
  }
});

test("WebSocket 错误按 requestId 展示对应操作，不被后来的其他请求覆盖", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const snapshot = lobbySnapshot();
  sockets[0].receive({ type: "SNAPSHOT", payload: snapshot });
  elements["table-seats"].children.find((seat) => seat.className.includes(" empty")).listeners.click();
  const sit = sockets[0].sent.at(-1);
  sockets[0].receive({ type: "ERROR", requestId: sit.requestId, payload: { message: "落座失败", code: "SEAT_TAKEN", detail: { currentSeat: 1 } } });
  assert.equal(elements["error-dialog"].open, true);
  assert.match(elements["error-request"].textContent, /SIT_DOWN/);
  assert.match(elements["error-response"].textContent, /SEAT_TAKEN/);
  elements["close-error"].listeners.click();
  sockets[0].receive({ type: "AUTH_EXPIRED", requestId: sockets[0].sent[0].requestId, payload: { message: "认证失效" } });
  assert.match(elements["error-request"].textContent, /AUTH/);
  assert.doesNotMatch(elements["error-request"].textContent, /SIT_DOWN|secret/);
  assert.match(elements["error-request"].textContent, /已隐藏/);
});

test("操作超时弹框包含已发送的操作与未收到响应说明", async () => {
  const { elements, sockets, timeouts } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  sockets[0].receive({ type: "SNAPSHOT", payload: lobbySnapshot() });
  elements["table-seats"].children.find((seat) => seat.className.includes(" empty")).listeners.click();
  [...timeouts.values()].at(-1)();
  assert.equal(elements["error-dialog"].open, true);
  assert.match(elements["error-dialog-message"].textContent, /尚未确认/);
  assert.match(elements["error-request"].textContent, /SIT_DOWN/);
  assert.match(elements["error-response"].textContent, /"received": false/);
});

test("右上角帮助及全屏功能已移除，不调用浏览器原生确认", () => {
  const page = readFileSync(new URL("../p.html", import.meta.url), "utf8");
  assert.doesNotMatch(page, /id="(?:help-button|fullscreen-button|help-panel)"/);
  assert.doesNotMatch(script, /window\.confirm|requestFullscreen|exitFullscreen/);
});

test("房间菜单不包含房间 ID 展示节点", () => {
  const page = readFileSync(new URL("../p.html", import.meta.url), "utf8");
  assert.doesNotMatch(page, /id="room-id"|房间编号/);
});

test("连接失败和关闭仅显示状态，背景重试 HTTP 失败保留牌桌、不弹框，三次后允许手动重连", async () => {
  const { elements, sockets, timeouts, calls } = mount([roomResponse(),
    { error: new TypeError("offline") }, { error: new TypeError("offline") }, { error: new TypeError("offline") }]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  sockets[0].receive({ type: "SNAPSHOT", payload: lobbySnapshot() });
  sockets[0].onerror(); sockets[0].onclose({ code: 1006, reason: "" });
  assert.equal(elements["error-dialog"].open, undefined);
  assert.equal(elements["ws-status"].textContent, "重连中");
  for (let i = 0; i < 3; i++) {
    [...timeouts.values()].at(-1)(); await new Promise(setImmediate);
    assert.equal(elements["room-panel"].hidden, false);
    assert.equal(elements["error-dialog"].open, undefined);
  }
  assert.equal(calls.length, 4);
  assert.equal(elements["ws-status"].textContent, "未连接");
  assert.match(elements["table-notice"].textContent, /自动重连未成功/);
});

test("准备状态显示在头像边，已准备可取消，收到快照后才切换回准备按钮", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const snapshot = lobbySnapshot({ self: { userId: "u1", seatIndex: 1, roomState: "READY", allowedCommands: ["UNREADY", "STAND_UP"] },
    roomMembers: [{ userId: "u1", seatIndex: 1, state: "READY", ready: true, nickname: "已准备玩家", stack: 200 }] });
  sockets[0].receive({ type: "SNAPSHOT", payload: snapshot });
  assert.ok(descendants(elements["table-seats"]).some((node) => node.className === "seat-readiness" && node.textContent === "已准备"));
  assert.equal(elements["ready-player"].hidden, true);
  assert.equal(elements["unready-player"].hidden, false);
  elements["unready-player"].listeners.click();
  assert.equal(sockets[0].sent.at(-1).type, "UNREADY"); assert.deepEqual(sockets[0].sent.at(-1).payload, {});
  assert.equal(elements["unready-player"].disabled, true);
  assert.ok(descendants(elements["table-seats"]).some((node) => node.className === "seat-readiness"));
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...snapshot, revision: 2,
    self: { ...snapshot.self, roomState: "SEATED", allowedCommands: ["READY", "STAND_UP"] },
    roomMembers: [{ ...snapshot.roomMembers[0], state: "SEATED", ready: false }] } });
  assert.equal(elements["unready-player"].hidden, true);
  assert.equal(elements["ready-player"].hidden, false);
  assert.ok(!descendants(elements["table-seats"]).some((node) => node.className === "seat-readiness"));
});

test("兼容Java取消准备命令已实现但快照只授权起身，带入仍需明确授权", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  sockets[0].receive({ type: "SNAPSHOT", payload: lobbySnapshot({ self: { userId: "u1", seatIndex: 1, roomState: "READY", allowedCommands: ["STAND_UP"] },
    roomMembers: [{ userId: "u1", seatIndex: 1, state: "READY" }] }) });
  assert.equal(elements["unready-player"].disabled, false);
  assert.equal(elements["ready-detail"].hidden, true);
  assert.equal(elements["submit-buy-in"].disabled, true);
  elements["unready-player"].listeners.click();
  assert.equal(sockets[0].sent.at(-1).type, "UNREADY");
  assert.deepEqual(sockets[0].sent.at(-1).payload, {});
  assert.equal(elements["unready-player"].disabled, true);
  assert.ok(descendants(elements["table-seats"]).some((node) => node.className === "seat-readiness"));
  sockets[0].receive({ type: "SNAPSHOT", payload: lobbySnapshot({ revision: 2,
    self: { userId: "u1", seatIndex: 1, roomState: "SEATED", allowedCommands: ["READY", "STAND_UP"] },
    roomMembers: [{ userId: "u1", seatIndex: 1, state: "SEATED" }] }) });
  assert.equal(elements["unready-player"].hidden, true);
  assert.ok(!descendants(elements["table-seats"]).some((node) => node.className === "seat-readiness"));
  elements["buy-in-form"].listeners.submit({ preventDefault() {} });
  assert.ok(!sockets[0].sent.some((frame) => frame.type === "BUY_IN"));
});

const buyIn = { minAmount: 200, maxAmount: 2000, step: 200, options: [200, 400, 1000, 2000] };
test("带入筹码在两局之间收到确认后更新余额，牌局中仅显示待到账，本局结束后用账本余额", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = lobbySnapshot({ self: { userId: "host", seatIndex: 0, allowedCommands: ["BUY_IN"] },
    room: { ...lobbySnapshot().room, buyIn }, roomMembers: [{ userId: "host", nickname: "本人", seatIndex: 0, state: "SEATED", stack: 200 }] });
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  assert.equal(elements["submit-buy-in"].disabled, false);
  elements["buy-in-amount"].value = "400";
  elements["buy-in-form"].listeners.submit({ preventDefault() {} });
  assert.equal(sockets[0].sent.at(-1).type, "BUY_IN"); assert.deepEqual(sockets[0].sent.at(-1).payload, { amount: 400 });
  assert.match(elements["buy-in-balance"].textContent, /当前筹码 200/);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, roomMembers: [{ ...first.roomMembers[0], stack: 600 }] } });
  assert.match(elements["buy-in-balance"].textContent, /当前筹码 600/);
  const running = gameSnapshot({ revision: 3, room: { settings: { maxSeats: 6 }, buyIn },
    self: { userId: "host", seatIndex: 0, roomState: "IN_HAND", allowedCommands: ["BUY_IN"] },
    roomMembers: [{ ...first.roomMembers[0], stack: 200, state: "IN_HAND" }] });
  sockets[0].receive({ type: "SNAPSHOT", payload: running });
  elements["buy-in-amount"].value = "400"; elements["buy-in-form"].listeners.submit({ preventDefault() {} });
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...running, revision: 4,
    roomMembers: [{ ...running.roomMembers[0], pendingBuyIn: 400 }] } });
  assert.match(elements["buy-in-balance"].textContent, /当前筹码 200 · 待到账 \+400/);
  assert.ok(descendants(elements["table-seats"]).some((node) => node.className === "seat-stack" && node.textContent === "200"));
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...running, revision: 5,
    game: { ...running.game, phase: "complete" }, roomMembers: [{ ...running.roomMembers[0], stack: 600, pendingBuyIn: 0, state: "SEATED" }] } });
  assert.match(elements["buy-in-balance"].textContent, /当前筹码 600/);
  assert.ok(descendants(elements["table-seats"]).some((node) => node.className === "seat-stack" && node.textContent === "600"));
});

test("打开起身确认后状态变化不再允许起身，确认也不发送过时命令", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  sockets[0].receive({ type: "SNAPSHOT", payload: lobbySnapshot({ self: { userId: "u1", seatIndex: 1, allowedCommands: ["STAND_UP"] } }) });
  const completion = elements["stand-up"].listeners.click();
  sockets[0].receive({ type: "SNAPSHOT", payload: gameSnapshot({ revision: 2 }) });
  elements["confirm-stand"].listeners.click(); await completion;
  assert.ok(!sockets[0].sent.some((frame) => frame.type === "STAND_UP"));
});

// Observe the opening street before its first bet; current totals alone are not history.
function seedRaiseRound(socket) {
  const first = gameSnapshot({ revision: 0 }); first.game.phase = "flop"; first.game.turn = 1;
  first.game.players.forEach(p => { p.bet = 0; p.stack = 200; });
  socket.receive({ type: "SNAPSHOT", payload: first });
}

test("加注先打开金额面板，快捷金额和全下只选择，确认后才发送一次 ACTION", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  seedRaiseRound(sockets[0]);
  const snapshot = gameSnapshot(); snapshot.game.phase = "flop";
  sockets[0].receive({ type: "SNAPSHOT", payload: snapshot });
  elements["raise-toggle"].listeners.click();
  assert.equal(elements["raise-editor"].hidden, false);
  assert.match(elements["raise-limits"].textContent, /6.*200/);
  elements["raise-presets"].children[0].listeners.click();
  assert.ok(Number(elements["raise-range"].value) >= 6);
  assert.equal(sockets[0].sent.filter((f) => f.type === "ACTION").length, 0);
  elements["all-in-action"].listeners.click();
  assert.equal(Number(elements["raise-range"].value), 200);
  assert.equal(sockets[0].sent.filter((f) => f.type === "ACTION").length, 0);
  elements["close-raise"].listeners.click();
  assert.equal(elements["raise-editor"].hidden, true);
  elements["raise-toggle"].listeners.click();
  elements["raise-range"].value = "20"; elements["raise-range"].listeners.input();
  elements["raise-editor"].listeners.submit({ preventDefault() {} });
  elements["raise-editor"].listeners.submit({ preventDefault() {} });
  const sent = sockets[0].sent.filter((f) => f.type === "ACTION");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.action, "raise"); assert.equal(sent[0].payload.amount, 20);
  assert.equal(elements["raise-editor"].hidden, true);
});

test("加注面板合并重复金额，选择后只高亮一个快捷选项", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  seedRaiseRound(sockets[0]);
  const snapshot = gameSnapshot(); snapshot.game.phase = "flop";
  snapshot.game.players[0].stack = 8;
  snapshot.game.pot = 3;
  snapshot.game.legal = { ...snapshot.game.legal, toCall: 0, minRaiseTo: 6, maxRaiseTo: 8 };
  sockets[0].receive({ type: "SNAPSHOT", payload: snapshot });
  elements["raise-toggle"].listeners.click();
  const buttons = elements["raise-presets"].children;
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons.map((button) => button.getAttribute("data-raise-amount")), ["8", "6"]);
  assert.deepEqual(buttons.map((button) => button.children[1].textContent), ["最大加注", "最小加注"]);
  assert.equal(elements["raise-presets"].style.values["--preset-count"], "2");
  buttons[0].listeners.click();
  assert.equal(Number(elements["raise-range"].value), 8);
  assert.equal(buttons.filter((button) => button.getAttribute("aria-pressed") === "true").length, 1);
  assert.ok(!sockets[0].sent.some((frame) => frame.type === "ACTION"));
});

function bettingRound(socket, selfSeat = 0, stack = 1000) {
  const view = gameSnapshot(); view.revision = 1; view.self.seatIndex = selfSeat;
  view.room.settings.smallBlind = 10; view.room.settings.bigBlind = 20;
  view.game.turn = 0; view.game.smallBlindSeat = 4; view.game.bigBlindSeat = 5;
  view.game.players = Array.from({ length: 6 }, (_, seatIndex) => ({ seatIndex, nickname: "玩家" + seatIndex,
    stack: seatIndex === selfSeat ? stack : 1000, bet: seatIndex === 4 ? 10 : seatIndex === 5 ? 20 : 0,
    folded: false, allIn: false, hole: seatIndex === selfSeat ? ["Jc", "7h"] : [null, null] }));
  // Deliberately incorrect capabilities: front-end rules must control the UI.
  view.game.legal = { canRaise: true, canCall: true, minRaiseTo: 1, maxRaiseTo: 9999, toCall: 1 };
  const send = () => socket.receive({ type: "SNAPSHOT", payload: view }); send();
  return { view, act(seat, total, next, allIn = false) {
    const p = view.game.players[seat]; p.stack = allIn ? 0 : p.stack - (total - p.bet);
    p.bet = total; p.allIn = allIn; view.game.turn = next; view.revision++; send();
  } };
}

test("页面在短全下后以120为下限，滑杆纠正100，提交前再次拦截非法金额", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const round = bettingRound(sockets[0], 2); round.act(0, 60, 1); round.act(1, 80, 2, true);
  assert.equal(elements["raise-toggle"].disabled, false);
  elements["raise-toggle"].listeners.click();
  assert.equal(Number(elements["raise-range"].min), 120);
  assert.equal(Number(elements["raise-range"].max), 1000);
  assert.ok(elements["raise-presets"].children.every(b => Number(b.attributes["data-raise-amount"]) >= 120));
  elements["raise-range"].value = "100";
  elements["raise-editor"].listeners.submit({ preventDefault() {} });
  assert.equal(sockets[0].sent.filter(f => f.type === "ACTION").length, 0);
  assert.match(elements["error-dialog-message"].textContent, /120/);
  elements["raise-range"].listeners.input();
  assert.equal(Number(elements["raise-range"].value), 120);
  elements["raise-editor"].listeners.submit({ preventDefault() {} });
  assert.equal(sockets[0].sent.find(f => f.type === "ACTION").payload.amount, 120);
});

test("页面单独短全下不重开A，关闭加注面板及全下入口，仍可跟注20", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const round = bettingRound(sockets[0]); elements["raise-toggle"].listeners.click();
  round.act(0, 60, 1); round.act(1, 80, 2, true); round.act(2, 80, 0);
  for (const id of ["raise-toggle", "raise-range", "all-in-action", "confirm-raise"]) assert.equal(elements[id].disabled, true);
  assert.equal(elements["raise-editor"].hidden, true);
  assert.match(elements["table-notice"].textContent, /加注权未重新开放/);
  elements["all-in-action"].listeners.click(); elements["raise-toggle"].listeners.click();
  elements["raise-range"].value = "1000"; elements["raise-editor"].listeners.submit({ preventDefault() {} });
  assert.equal(sockets[0].sent.filter(f => f.type === "ACTION").length, 0);
  assert.equal(elements["call-action"].children[1].textContent, "20");
  elements["call-action"].listeners.click();
  assert.equal(sockets[0].sent.find(f => f.type === "ACTION").payload.action, "call");
});

test("页面不足完整加注允许且只允许真实短码全下95", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const round = bettingRound(sockets[0], 2, 95); round.act(0, 60, 1); round.act(1, 80, 2, true);
  elements["raise-toggle"].listeners.click();
  assert.equal(Number(elements["raise-range"].min), 95); assert.equal(Number(elements["raise-range"].max), 95);
  assert.match(elements["raise-limits"].textContent, /120.*短码全下.*95/);
  assert.equal(elements["raise-presets"].children.length, 1);
  elements["raise-range"].value = "94"; elements["raise-editor"].listeners.submit({ preventDefault() {} });
  assert.equal(sockets[0].sent.filter(f => f.type === "ACTION").length, 0);
  elements["all-in-action"].listeners.click(); elements["raise-editor"].listeners.submit({ preventDefault() {} });
  assert.equal(sockets[0].sent.find(f => f.type === "ACTION").payload.amount, 95);
});

test("首次进入下注中途暂禁加注，新街恢复且旧面板金额不会绕过新下限", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const view = gameSnapshot(); sockets[0].receive({ type: "SNAPSHOT", payload: view });
  assert.equal(elements["raise-toggle"].disabled, true); assert.match(elements["table-notice"].textContent, /记录不完整/);
  view.revision++; view.game.phase = "flop"; view.game.players.forEach(p => { p.bet = 0; });
  sockets[0].receive({ type: "SNAPSHOT", payload: view });
  assert.equal(elements["raise-toggle"].disabled, false);
  elements["raise-toggle"].listeners.click(); assert.equal(Number(elements["raise-range"].min), 2);
  view.revision++; view.game.turn = 1; sockets[0].receive({ type: "SNAPSHOT", payload: view });
  view.revision++; view.game.players[1].bet = 20; view.game.turn = 0;
  sockets[0].receive({ type: "SNAPSHOT", payload: view });
  elements["raise-toggle"].listeners.click(); assert.equal(Number(elements["raise-range"].min), 40);
  elements["raise-range"].value = "2"; elements["raise-editor"].listeners.submit({ preventDefault() {} });
  assert.equal(sockets[0].sent.filter(f => f.type === "ACTION").length, 0);
});

test("成员列表展示头像、盈亏符号和累计带入，快照更新金额且缺失值不显示零", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = lobbySnapshot({ roomMembers: [
    { userId: "a", nickname: "盈利成员", avatarUrl: "https://example.com/a.jpg", totalBuyIn: 1000, stack: 900, netChips: 120.5, online: true, seatIndex: 4, state: "SEATED" },
    { userId: "b", nickname: "亏损成员", avatarUrl: "javascript:alert(1)", totalBuyIn: 800, stack: 700, netChips: -100 },
    { userId: "c", nickname: "持平成员", totalBuyIn: 0, netChips: 0 },
    { userId: "d", nickname: "缺少账本", stack: 200 },
  ] });
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  const rows = elements["members-list"].children;
  const find = (row, cls) => descendants(row).find((node) => node.className.split(" ").includes(cls));
  assert.equal(find(rows[0], "member-profit").textContent, "+120.5");
  assert.equal(find(rows[0], "member-profit").className, "member-profit profit-positive");
  assert.equal(find(rows[0], "member-buy-in").textContent, "累计带入 1,000");
  assert.ok(!descendants(rows[0]).some((node) => /号位/.test(node.textContent)));
  assert.ok(!descendants(find(rows[0], "member-balance")).some((node) => /盈利|亏损/.test(node.textContent)));
  const image = descendants(rows[0]).find((node) => node.src);
  assert.equal(image.src, "https://example.com/a.jpg");
  image.listeners.error(); assert.equal(image.removed, true);
  assert.equal(find(rows[1], "member-profit").textContent, "-100");
  assert.equal(find(rows[1], "member-profit").className, "member-profit profit-negative");
  assert.ok(!descendants(rows[1]).some((node) => node.src));
  assert.equal(find(rows[2], "member-profit").textContent, "0");
  assert.equal(find(rows[2], "member-profit").className, "member-profit");
  assert.equal(find(rows[2], "member-buy-in").textContent, "累计带入 0");
  assert.equal(find(rows[3], "member-profit").textContent, "—");
  assert.equal(find(rows[3], "member-buy-in").textContent, "累计带入 —");
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2,
    roomMembers: [{ ...first.roomMembers[0], totalBuyIn: 1400, netChips: -80 }] } });
  assert.equal(find(elements["members-list"].children[0], "member-profit").textContent, "-80");
  assert.equal(find(elements["members-list"].children[0], "member-buy-in").textContent, "累计带入 1,400");
});

test("随机落座使用服务端真实座号，不同座号均旋转到正下方且不变成一号位", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  let revision = 1;
  for (const assigned of [4, 2, 0, 5]) {
    const first = lobbySnapshot({ revision: revision++ });
    sockets[0].receive({ type: "SNAPSHOT", payload: first });
    elements["table-seats"].children.find((seat) => seat.attributes["data-seat-index"] === "3").listeners.click();
    assert.deepEqual(sockets[0].sent.at(-1).payload, {});
    sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: revision++, self: { ...first.self, seatIndex: assigned },
      roomMembers: [...first.roomMembers, { userId: "host", nickname: "本人", seatIndex: assigned, state: "SEATED" }] } });
    const mine = elements["table-seats"].children.find((seat) => seat.className.includes(" self"));
    assert.equal(mine.attributes["data-seat-index"], String(assigned));
    assert.equal(mine.style.values["--x"], "50%");
    assert.equal(mine.style.values["--y"], "89%");
    assert.ok(!descendants(mine).some((node) => node.className === "seat-number"));
    assert.equal(elements["table-notice"].textContent, "已入座，等待房主开始游戏");
    const empty = elements["table-seats"].children.find((seat) => seat.className.includes(" empty"));
    assert.equal(descendants(empty).find((node) => node.className === "seat-name").textContent, "空座");
    assert.equal(empty.attributes["aria-label"], "空座，点击落座");
  }
});

test("本手结算明确标记赢家并把底池动画移向赢家，重复快照不重复播放，成员筹码用账本", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot(); sockets[0].receive({ type: "SNAPSHOT", payload: first });
  const player = first.game.players[0];
  const complete = { ...first, revision: 2, game: { ...first.game, phase: "complete", pot: 300, result: { winners: [player.seatIndex], message: "本手已结算", hands: null } },
    roomMembers: [{ ...player, stack: 500, state: "SEATED", totalBuyIn: 200 }] };
  sockets[0].receive({ type: "SNAPSHOT", payload: complete });
  const winner = elements["table-seats"].children.find(s => s.className.includes(" winner"));
  assert.ok(winner); assert.equal(winner.attributes["data-seat-index"], String(player.seatIndex));
  assert.match(elements["table-result"].textContent, /\+300.*获胜/);
  assert.equal(descendants(winner).find(n => n.className === "seat-win").textContent, "获胜 +300");
  assert.equal(elements["pot-label"].textContent, "已分配底池");
  const chips = elements["payout-layer"].children;
  assert.equal(chips.length, 6); assert.ok(chips.every(n => n.attributes["data-winner-seat"] === String(player.seatIndex)));
  assert.ok(!descendants(elements["members-list"]).some(n => n.className === "member-stack" || n.textContent.startsWith("当前筹码")));
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...complete, revision: 3 } });
  assert.equal(elements["payout-layer"].children[0], chips[0]);
  assert.equal(elements["victory-layer"].hidden, false);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 4, game: { ...first.game, handId: "H2" } } });
  assert.equal(elements["payout-layer"].children.length, 0);
  assert.equal(elements["next-hand-countdown"].hidden, true);
  assert.equal(elements["victory-layer"].hidden, true);
  assert.equal(elements["victory-confetti"].children.length, 0);
  assert.ok(!elements["table-seats"].children.some(s => s.className.includes(" winner")));
});

test("重连直接看到结算只显示赢家，不重放派奖；多赢家无分配字段不捏造金额", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, game: { ...first.game, phase: "complete",
    result: { winners: first.game.players.map(p => p.seatIndex), hands: null } } } });
  assert.equal(elements["payout-layer"].children.length, 0);
  assert.equal(elements["victory-layer"].hidden, true);
  const badges = descendants(elements["table-seats"]).filter(n => n.className === "seat-win");
  assert.equal(badges.length, first.game.players.length); assert.ok(badges.every(n => n.textContent === "获胜"));
});

test("零筹码等人数时提示补筹码，确认到账后服务端直接发下一手，不发准备或开始命令", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  const buyIn = { minAmount: 200, maxAmount: 2000, step: 200, options: [200, 400] };
  const waiting = { ...first, self: { ...first.self, stack: 0, allowedCommands: ["BUY_IN", "STAND_UP"] },
    roomMembers: [{ userId: "1", seatIndex: 0, nickname: "本人", stack: 0 }, { userId: "other", seatIndex: 1, nickname: "对手", stack: 200 }],
    room: { ...first.room, buyIn, playState: "RUNNING", nextHand: { status: "WAITING_PLAYERS", sourceHandId: "H1" } },
    game: { ...first.game, phase: "complete", legal: null, turn: null } };
  sockets[0].receive({ type: "SNAPSHOT", payload: waiting });
  assert.equal(elements["next-hand-countdown"].textContent, "等待可参局玩家 · 1/2");
  assert.equal(elements["self-state"].textContent, "等待补筹码");
  assert.match(elements["table-notice"].textContent, /筹码为零/);
  assert.match(elements["buy-in-detail"].textContent, /无需重新准备/);
  assert.equal(elements["start-hand"].hidden, true); assert.equal(elements["ready-player"].hidden, true);
  assert.ok(descendants(elements["table-seats"]).some(node => node.className === "seat-state" && node.textContent === "等待补筹码"));
  elements["buy-in-amount"].value = "200"; elements["buy-in-form"].listeners.submit({ preventDefault() {} });
  assert.equal(sockets[0].sent.at(-1).type, "BUY_IN");
  assert.equal(elements["self-state"].textContent, "等待补筹码");
  const funded = { ...waiting, revision: 2, self: { ...waiting.self, stack: 200 },
    roomMembers: waiting.roomMembers.map((member, i) => i === 0 ? { ...member, stack: 200 } : member) };
  sockets[0].receive({ type: "SNAPSHOT", payload: funded });
  assert.equal(elements["next-hand-countdown"].textContent, "人数已满足，等待服务端发牌…");
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...funded, revision: 3, room: { ...funded.room, nextHand: { status: "IDLE" } },
    game: { ...first.game, handId: "H2", handNumber: 2 } } });
  assert.equal(elements["next-hand-countdown"].hidden, true);
  assert.match(elements["table-phase"].textContent, /第 2 手/);
  assert.equal(elements["call-action"].disabled, false);
  assert.ok(!sockets[0].sent.some(frame => ["READY", "START_HAND", "RESUME_GAME"].includes(frame.type)));
});

test("十秒倒计时不被新快照重置，到零不发送开始指令，服务端新手到达后自动进入", async () => {
  let now = Date.now(); class ClockDate extends Date { static now() { return now; } }
  const { elements, sockets, intervals } = mount([roomResponse()], "", { Date: ClockDate });
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot(); sockets[0].receive({ type: "SNAPSHOT", payload: first });
  const complete = { ...first, revision: 2, serverTime: new Date(now).toISOString(),
    self: { ...first.self, role: "CREATOR", allowedCommands: ["START_HAND"] },
    room: { ...first.room, playState: "RUNNING", nextHand: { status: "COUNTDOWN", sourceHandId: first.game.handId, startsAt: new Date(now + 10000).toISOString() } },
    game: { ...first.game, phase: "complete", result: { winners: [first.game.players[0].seatIndex], hands: null } } };
  sockets[0].receive({ type: "SNAPSHOT", payload: complete });
  assert.equal(elements["next-hand-countdown"].textContent, "下一手 · 10s");
  assert.equal(elements["start-hand"].hidden, true);
  now += 6000;
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...complete, revision: 3, serverTime: new Date(now).toISOString() } });
  assert.equal(elements["next-hand-countdown"].textContent, "下一手 · 4s");
  now += 4000; for (const tick of intervals.values()) tick();
  assert.equal(elements["next-hand-countdown"].textContent, "正在等待服务端发牌…");
  assert.ok(!sockets[0].sent.some(f => ["READY", "START_HAND"].includes(f.type)));
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 4, game: { ...first.game, handId: "H2", handNumber: 2 } } });
  assert.equal(elements["next-hand-countdown"].hidden, true); assert.match(elements["table-phase"].textContent, /第 2 手/);
});

test("结算后起身或换人占座不把旧赢家和底牌显示到新用户身上", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  first.game.players = first.game.players.map((player, index) => ({ ...player, userId: "old-" + index }));
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  const player = first.game.players[0];
  const completed = { ...first, revision: 2, self: { ...first.self, seatIndex: null },
    game: { ...first.game, phase: "complete", players: first.game.players.map((p, i) => ({ ...p, allInCommitted: i === 0, folded: i === 1 })), result: { winners: [player.seatIndex], hands: ["同花"] } },
    roomMembers: [{ userId: "new-user", nickname: "新玩家", seatIndex: player.seatIndex, stack: 200, state: "SEATED" }] };
  sockets[0].receive({ type: "SNAPSHOT", payload: completed });
  const seat = elements["table-seats"].children.find(s => s.attributes["data-seat-index"] === String(player.seatIndex));
  assert.equal(descendants(seat).find(n => n.className === "seat-name").textContent, "新玩家");
  assert.ok(!seat.className.includes(" winner"));
  assert.ok(!/all-in|folded|folding/.test(seat.className));
  assert.ok(!descendants(seat).some(n => n.className === "hole-cards"));
  assert.equal(elements["payout-layer"].children.length, 0);
  assert.equal(elements["deal-layer"].children.length, 0);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...completed, revision: 3, roomMembers: [] } });
  assert.ok(elements["table-seats"].children.every(s => s.className.includes(" empty")));
});

test("旧服务结算展示十秒不因快照更新重置，历史停止状态等待服务端继续", async () => {
  let now = Date.now(); class ClockDate extends Date { static now() { return now; } }
  const { elements, sockets, intervals } = mount([roomResponse()], "", { Date: ClockDate });
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot(); const complete = { ...first, game: { ...first.game, phase: "complete", result: { winners: [first.game.players[0].seatIndex] } } };
  sockets[0].receive({ type: "SNAPSHOT", payload: complete });
  assert.equal(elements["next-hand-countdown"].textContent, "结算展示 · 10s");
  now += 6000; sockets[0].receive({ type: "SNAPSHOT", payload: { ...complete, revision: 2 } });
  assert.equal(elements["next-hand-countdown"].textContent, "结算展示 · 4s");
  now += 4000; for (const tick of intervals.values()) tick();
  assert.equal(elements["next-hand-countdown"].textContent, "等待服务端开启下一手");
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...complete, revision: 3, room: { ...complete.room, playState: "PAUSED" } } });
  assert.equal(elements["next-hand-countdown"].textContent, "等待服务端继续牌局");
});

test("摊牌时即使服务误传底牌也不公开弃牌对手，本人仍可看自己的牌", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  const players = first.game.players.map(p => ({ ...p, folded: true }));
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first,
    game: { ...first.game, phase: "complete", players, result: { hands: [null, null] } } } });
  const seats = elements["table-seats"].children;
  const mine = descendants(seats[0]).find(n => n.className === "hole-cards");
  const opponent = descendants(seats[1]).find(n => n.className === "hole-cards");
  assert.ok(mine.children.every(n => !n.className.includes("back")));
  assert.ok(opponent.children.every(n => n.className.includes("back")));
});

test("全下与弃牌状态沿用本手玩家，下注金额展示本轮累计且结算后清除", async () => {
  let now = Date.now(); class ClockDate extends Date { static now() { return now; } }
  const { elements, sockets } = mount([roomResponse()], "", { Date: ClockDate });
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot(); sockets[0].receive({ type: "SNAPSHOT", payload: first });
  const next = { ...first, revision: 2, game: { ...first.game,
    players: first.game.players.map((p, i) => ({ ...p, folded: i === 1, allIn: i === 0, bet: 200 })) } };
  sockets[0].receive({ type: "SNAPSHOT", payload: next });
  let seats = elements["table-seats"].children;
  assert.ok(seats[0].className.includes(" all-in"));
  assert.equal(descendants(seats[0]).find(n => n.className === "seat-state").textContent, "ALL IN");
  assert.ok(seats[1].className.includes(" folding"));
  assert.equal(descendants(seats[0]).find(n => n.className === "seat-bet").attributes["aria-label"], "本轮下注 200");
  now += 1000;
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...next, revision: 3 } });
  assert.ok(!elements["table-seats"].children[1].className.includes(" folding"));
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...next, revision: 4,
    roomMembers: next.game.players.map(p => ({ ...p, folded: false, allIn: false, stack: 300 })),
    game: { ...next.game, phase: "complete", players: next.game.players.map(p => ({ ...p, allIn: false })), result: { hands: [] } } } });
  seats = elements["table-seats"].children;
  assert.ok(seats[0].className.includes(" all-in"));
  assert.ok(seats[1].className.includes(" folded"));
  assert.ok(!descendants(elements["table-seats"]).some(n => n.className === "seat-bet"));
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 5, game: { ...first.game, handId: "H2" } } });
  assert.ok(!elements["table-seats"].children.some(s => /all-in|folding|folded/.test(s.className)));
});

test("全下直接结算通过 allInCommitted 展示特效，不依赖派奖后的余额为零", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, game: { ...first.game, phase: "complete",
    players: first.game.players.map((p, i) => ({ ...p, allInCommitted: i === 0, allIn: false, stack: 400 })), result: {} } } });
  assert.ok(elements["table-seats"].children[0].className.includes(" all-in"));
  assert.ok(!elements["table-seats"].children[1].className.includes(" all-in"));
});

test("行动倒计时使用服务器时间，最后十秒标红，离线仍计时但不在客户端伪造弃牌", async () => {
  let now = Date.now(); class ClockDate extends Date { static now() { return now; } }
  const { elements, sockets, intervals } = mount([roomResponse()], "", { Date: ClockDate });
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, serverTime: new Date(now + 60000).toISOString(),
    game: { ...first.game, turnDeadline: new Date(now + 81000).toISOString(), players: first.game.players.map(p => ({ ...p, online: false })) } } });
  const mine = elements["table-seats"].children[0];
  const seconds = descendants(mine).find(n => n.className === "turn-seconds");
  assert.equal(seconds.textContent, "21s"); assert.equal(mine.attributes["data-urgent"], "false");
  now += 11000; for (const tick of intervals.values()) tick();
  assert.equal(seconds.textContent, "10s"); assert.equal(mine.attributes["data-urgent"], "true");
  now += 10000; for (const tick of intervals.values()) tick();
  assert.equal(seconds.textContent, "0s");
  assert.ok(!mine.className.includes(" folded"));
  assert.ok(!sockets[0].sent.some(f => f.type === "ACTION"));
  assert.equal(elements["fold-action"].disabled, true);
});

function finalSnapshot(now = Date.now()) {
  const first = gameSnapshot();
  return { ...first, entryState: "ROOM_CLOSED", revision: 10, activity, connection: null, serverTime: new Date(now).toISOString(),
    room: { ...first.room, status: "CLOSED", settings: { ...first.room.settings, durationMinutes: 120 },
      timing: { status: "ENDED", endsAt: new Date(now - 30000).toISOString(), endedAt: new Date(now).toISOString() } },
    game: { ...first.game, phase: "complete", turn: null, legal: null, result: { winners: [0], hands: null } },
    settlement: { status: "FINAL", endedAt: new Date(now).toISOString(), showAt: new Date(now + 10000).toISOString(),
      totalHands: 3, totalBuyIn: 600, totalPot: 24, maxPot: 16,
      players: [{ userId: "2", nickname: "亏损成员", totalBuyIn: 200, handsPlayed: 3, netChips: -100 },
        { userId: "3", nickname: "持平成员", totalBuyIn: 200, handsPlayed: 0, netChips: 0 },
        { userId: "1", nickname: "本人", avatarUrl: "https://example.com/avatar.jpg", totalBuyIn: 200, handsPlayed: 3, netChips: 100 }] } };
}
test("已结束房间打开或刷新立即展示完整结算排名，不连接 WS 或等待十秒", async () => {
  const closed = finalSnapshot();
  const { elements, sockets } = mount([{ status: 200, body: { code: 0, data: closed } }]);
  await new Promise(setImmediate);
  assert.equal(sockets.length, 0); assert.equal(elements["settlement-panel"].hidden, false);
  assert.equal(elements["room-panel"].hidden, true);
  assert.equal(elements["settlement-total-hands"].textContent, "3");
  assert.equal(elements["settlement-total-pot"].textContent, "24");
  const rows = elements["settlement-players"].children;
  assert.deepEqual(rows.map(p => p.attributes["data-user-id"]), ["1", "3", "2"]);
  assert.match(rows[0].className, /is-self/);
  assert.equal(descendants(rows[0]).find(p => p.className.includes("settlement-profit")).textContent, "+100");
  assert.equal(descendants(rows[1]).find(p => p.className.includes("settlement-profit")).textContent, "0");
  assert.match(descendants(rows[2]).find(p => p.className.includes("settlement-profit")).className, /profit-negative/);
  assert.equal(descendants(rows[2]).find(p => p.className === "settlement-hands").textContent, "手数 3");
  assert.equal(descendants(rows[2]).find(p => p.className === "settlement-buy-in").textContent, "带入 200");
});
test("到期不结束未完成手牌，最终关房快照后按服务端截止十秒自动进入结算", async () => {
  let now = Date.now(); class ClockDate extends Date { static now() { return now; } }
  const { elements, sockets, intervals } = mount([roomResponse()], "", { Date: ClockDate });
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, serverTime: new Date(now + 60000).toISOString(),
    room: { ...first.room, timing: { status: "OPEN", endsAt: new Date(now + 65000).toISOString() } } } });
  assert.equal(elements["session-countdown"].textContent, "剩余 00:00:05");
  now += 5000; for (const tick of intervals.values()) tick();
  assert.equal(elements["session-countdown"].textContent, "时间已到 · 本手结束后结算");
  assert.equal(elements["fold-action"].disabled, false);
  assert.equal(elements["settlement-panel"].hidden, true);
  const closed = finalSnapshot(now + 60000);
  elements["room-details"].hidden = false; elements["stand-dialog"].showModal();
  sockets[0].receive({ type: "SNAPSHOT", payload: closed });
  assert.equal(elements["room-details"].hidden, true); assert.equal(elements["stand-dialog"].open, false);
  assert.equal(elements["settlement-panel"].hidden, true);
  assert.equal(elements["session-countdown"].textContent, "结算 · 10s");
  assert.equal(elements["fold-action"].disabled, true);
  now += 4000; for (const tick of intervals.values()) tick();
  assert.equal(elements["session-countdown"].textContent, "结算 · 6s");
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...closed, revision: 11 } });
  assert.equal(elements["session-countdown"].textContent, "结算 · 6s");
  now += 6000; for (const tick of intervals.values()) tick();
  assert.equal(elements["room-panel"].hidden, true); assert.equal(elements["settlement-panel"].hidden, false);
  assert.equal(elements["settlement-players"].children.length, 3);
  assert.ok(!sockets[0].sent.some(f => ["READY", "START_HAND", "RESUME_GAME"].includes(f.type)));
});
test("缺少结算字段不能用当前成员伪造整场统计，结算页不提供重新获取入口", async () => {
  const closed = { ...finalSnapshot(), settlement: null };
  const { elements, calls, sockets } = mount([{ status: 200, body: { code: 0, data: closed } }]);
  await new Promise(setImmediate);
  assert.equal(elements["settlement-total-hands"].textContent, "—");
  assert.equal(elements["settlement-players"].children.length, 0);
  assert.match(elements["settlement-notice"].textContent, /尚未返回完整结算.*刷新页面/);
  assert.equal(elements["refresh-settlement"], undefined);
  assert.equal(calls.length, 1); assert.equal(sockets.length, 0);
});
test("旧 ROOM_CLOSED 仅通知时重新读取权威结算，不把旧手牌视为完成", async () => {
  const { elements, sockets, calls } = mount([roomResponse(), { status: 200, body: { code: 0, data: finalSnapshot() } }]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  sockets[0].receive({ type: "SNAPSHOT", payload: gameSnapshot() });
  sockets[0].receive({ type: "ROOM_CLOSED", payload: { message: "房间已关闭" } });
  await new Promise(setImmediate);
  assert.equal(calls.length, 2); assert.equal(elements["settlement-panel"].hidden, false);
  assert.equal(elements["settlement-total-pot"].textContent, "24");
  assert.equal(elements["payout-layer"].children.length, 0);
});

test("未冻结报告不显示为最终统计，也不会自动重新获取结算", async () => {
  const closed = finalSnapshot();
  const { elements, calls, sockets } = mount([
    { status: 200, body: { code: 0, data: { ...closed, settlement: { ...closed.settlement, status: "DRAFT" } } } },
  ]);
  await new Promise(setImmediate);
  assert.equal(elements["settlement-panel"].hidden, false);
  assert.equal(elements["settlement-total-pot"].textContent, "—");
  assert.equal(elements["settlement-players"].children.length, 0);
  assert.equal(calls.length, 1); assert.equal(sockets.length, 0);
});

function historyResponse(handNumber = 3, overrides = {}) {
  return { status: 200, body: { code: 0, message: "success", systemVersion: version, data: {
    roomId: "A123", throughHandNumber: 3, totalHands: 3, position: handNumber,
    firstHandNumber: 1, lastHandNumber: 3, previousHandNumber: handNumber > 1 ? handNumber - 1 : null,
    nextHandNumber: handNumber < 3 ? handNumber + 1 : null, coverage: { status: "COMPLETE" },
    hand: { handId: "A123-H" + handNumber, handNumber, settledAt: "2026-10-03T05:56:00Z", pot: 200, smallBlind: 1, bigBlind: 2,
      board: ["2d", "5c", "6h", "8c", "2h"], players: [
        { userId: "1", nickname: "本人", position: "BB", holeCards: ["Qh", "8d"], handName: "两对", netChips: 100,
          actions: [{ sequence: 5, street: "PREFLOP", type: "CALL", amount: 2 }, { sequence: 1, street: "PREFLOP", type: "POST_BIG_BLIND", amount: 2 }, { sequence: 9, street: "TURN", type: "BET", amount: 50 }] },
        { userId: "2", nickname: "<对手>", avatarUrl: "javascript:alert(1)", position: "SB", holeCards: [null, null], folded: true, netChips: -100,
          actions: [{ sequence: 8, street: "FLOP", type: "FOLD", source: "TIMEOUT" }] },
      ] }, ...overrides,
  } } };
}

test("历史入口按需查询本房间，逐人显示底牌、按序动作和红正绿负盈亏", async () => {
  const { elements, calls } = mount([roomResponse(), historyResponse()], "access-token");
  await new Promise(setImmediate);
  assert.equal(elements["room-history"].hidden, false);
  assert.equal(calls.length, 1);
  elements["room-menu"].listeners.click();
  elements["room-history"].listeners.click();
  await new Promise(setImmediate);
  assert.equal(elements["room-details"].hidden, true);
  assert.equal(elements["history-dialog"].open, true);
  assert.equal(elements["room-history"].attributes["aria-expanded"], "true");
  assert.equal(calls[1].url, "https://api.example.com/api/poker/v1/rooms/history");
  assert.equal(calls[1].options.headers.Authorization, "Bearer access-token");
  assert.deepEqual(JSON.parse(calls[1].options.body), { ticket: "v1.k1.test", roomId: "A123" });
  assert.equal(elements["history-position"].textContent, "3 / 3");
  const rows = elements["history-players"].children;
  assert.equal(rows.length, 2);
  assert.match(rows[0].className, /is-self/);
  assert.equal(rows[0].children[1].children[0].children[0].attributes["aria-label"], "Q♥");
  assert.deepEqual(Array.from(rows[0].children[1].children.slice(2), x => x.textContent), ["大盲 2", "跟注 2"]);
  assert.equal(rows[0].children[5].textContent, "+100");
  assert.match(rows[0].children[5].className, /profit-positive/);
  assert.equal(rows[1].children[5].textContent, "-100");
  assert.match(rows[1].children[5].className, /profit-negative/);
  assert.equal(descendants(rows[1]).filter(x => /history-card-back/.test(x.className)).length, 2);
  assert.equal(descendants(rows[1]).filter(x => x.src).length, 0);
  assert.equal(rows[1].children[0].children[1].textContent, "<对手>");
  assert.equal(rows[1].children[2].children[1].textContent, "弃牌（超时）");
  assert.equal(rows[1].children[3].children.length, 0);
  assert.equal(rows[1].children[4].children.length, 0);
});

test("历史首末和前后导航使用固定范围，刷新及重开查询最新，端点不能越界", async () => {
  const { elements, calls } = mount([roomResponse(), historyResponse(), historyResponse(2), historyResponse(1), historyResponse(3), historyResponse(), historyResponse()]);
  await new Promise(setImmediate); elements["room-history"].listeners.click(); await new Promise(setImmediate);
  assert.equal(elements["history-next"].disabled, true); assert.equal(elements["history-last"].disabled, true);
  elements["history-next"].listeners.click(); assert.equal(calls.length, 2);
  elements["history-prev"].listeners.click(); await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(calls[2].options.body), { ticket: "v1.k1.test", roomId: "A123", handNumber: 2, throughHandNumber: 3 });
  elements["history-first"].listeners.click(); await new Promise(setImmediate);
  assert.equal(elements["history-position"].textContent, "1 / 3");
  assert.equal(elements["history-first"].disabled, true); assert.equal(elements["history-prev"].disabled, true);
  elements["history-last"].listeners.click(); await new Promise(setImmediate);
  assert.equal(JSON.parse(calls[4].options.body).handNumber, 3);
  elements["refresh-history"].listeners.click(); await new Promise(setImmediate);
  assert.equal(JSON.parse(calls[5].options.body).throughHandNumber, undefined);
  elements["close-history"].listeners.click();
  assert.equal(elements["history-dialog"].open, false); assert.equal(elements["room-history"].attributes["aria-expanded"], "false");
  elements["room-history"].listeners.click(); await new Promise(setImmediate);
  assert.equal(JSON.parse(calls[6].options.body).handNumber, undefined);
});

test("历史空记录、早期记录缺失和接口未部署均有可恢复提示", async () => {
  const empty = historyResponse(3, { totalHands: 0, position: 0, hand: null });
  const { elements, calls } = mount([roomResponse(), { status: 404, body: { code: 404, message: "Not found" } }, empty,
    historyResponse(3, { coverage: { status: "PARTIAL", message: "仅保存第 3 手之后的记录" } })]);
  await new Promise(setImmediate); elements["room-history"].listeners.click(); await new Promise(setImmediate);
  assert.match(elements["history-status"].textContent, /暂未提供/);
  assert.equal(elements["refresh-history"].textContent, "重试");
  assert.equal(elements["error-dialog"].open, undefined);
  elements["refresh-history"].listeners.click(); await new Promise(setImmediate);
  assert.match(elements["history-status"].textContent, /暂无已结算/);
  assert.equal(elements["history-hand"].hidden, true); assert.equal(elements["history-next"].disabled, true);
  elements["refresh-history"].listeners.click(); await new Promise(setImmediate);
  assert.equal(calls.length, 4); assert.equal(elements["history-coverage"].hidden, false);
  assert.equal(elements["history-coverage"].textContent, "仅保存第 3 手之后的记录");
});

test("失败重试保留切换目标，错误房间响应不会覆盖已显示的历史", async () => {
  const { elements, calls } = mount([roomResponse(), historyResponse(), { status: 500, body: { code: 500, message: "查询失败" } }, historyResponse(2), historyResponse(3, { roomId: "B999" })]);
  await new Promise(setImmediate); elements["room-history"].listeners.click(); await new Promise(setImmediate);
  elements["history-prev"].listeners.click(); await new Promise(setImmediate);
  assert.match(elements["history-status"].textContent, /加载失败/);
  assert.equal(elements["history-position"].textContent, "3 / 3");
  elements["refresh-history"].listeners.click(); await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(calls[3].options.body), JSON.parse(calls[2].options.body));
  assert.equal(elements["history-position"].textContent, "2 / 3");
  elements["refresh-history"].listeners.click(); await new Promise(setImmediate);
  assert.match(elements["history-status"].textContent, /响应格式不完整/);
  assert.equal(elements["history-position"].textContent, "2 / 3");
});

test("关闭面板后忽略迟到历史响应，避免重新渲染及恢复分页", async () => {
  const { elements } = mount([roomResponse(), historyResponse()]);
  await new Promise(setImmediate);
  elements["room-history"].listeners.click(); elements["close-history"].listeners.click();
  await new Promise(setImmediate);
  assert.equal(elements["history-dialog"].open, false);
  assert.equal(elements["history-hand"].hidden, true);
  assert.equal(elements["history-position"].textContent, "0 / 0");
  assert.equal(elements["room-history"].attributes["aria-expanded"], "false");
});

test("房间最终结算仍可查历史，无房间的等待页面不显示入口", async () => {
  const closed = roomResponse({}, { entryState: "ROOM_CLOSED", room: { roomId: "A123", status: "CLOSED" } });
  const final = mount([closed, historyResponse()]);
  await new Promise(setImmediate);
  assert.equal(final.elements["settlement-panel"].hidden, false);
  assert.equal(final.elements["room-history"].hidden, false);
  final.elements["room-history"].listeners.click(); await new Promise(setImmediate);
  assert.equal(final.elements["history-position"].textContent, "3 / 3");
  const waiting = mount([roomResponse({}, { entryState: "WAITING_FOR_CREATOR", room: null })]);
  await new Promise(setImmediate); assert.equal(waiting.elements["room-history"].hidden, true);
});

test("历史只公开合法摊牌，服务误传的弃牌对手底牌和牌型仍被隐藏", async () => {
  const response = historyResponse();
  const opponent = response.body.data.hand.players[1];
  Object.assign(opponent, { holeCards: ["As", "Ah"], holeCardsRevealed: true, handName: "四条", folded: true });
  const publicResponse = historyResponse();
  Object.assign(publicResponse.body.data.hand.players[1], { holeCards: ["As", "Ah"], holeCardsRevealed: true, handName: "两对", folded: false, actions: [] });
  const { elements } = mount([roomResponse(), response, publicResponse]);
  await new Promise(setImmediate); elements["room-history"].listeners.click(); await new Promise(setImmediate);
  const hidden = elements["history-players"].children[1];
  assert.equal(descendants(hidden).filter(x => /history-card-back/.test(x.className)).length, 2);
  assert.equal(descendants(hidden).find(x => x.className === "history-hand-name"), undefined);
  elements["refresh-history"].listeners.click(); await new Promise(setImmediate);
  const visible = elements["history-players"].children[1];
  assert.equal(descendants(visible).filter(x => /history-card-back/.test(x.className)).length, 0);
  assert.equal(visible.children[1].children[0].children[0].attributes["aria-label"], "A♠");
});

test("历史手数不连续时使用实际序号及相邻记录导航", async () => {
  const first = historyResponse(102, { throughHandNumber: 102, totalHands: 2, position: 2, firstHandNumber: 100, lastHandNumber: 102, previousHandNumber: 100, nextHandNumber: null, coverage: { status: "PARTIAL" } });
  const second = historyResponse(100, { throughHandNumber: 102, totalHands: 2, position: 1, firstHandNumber: 100, lastHandNumber: 102, previousHandNumber: null, nextHandNumber: 102, coverage: { status: "PARTIAL" } });
  const { elements, calls } = mount([roomResponse(), first, second]);
  await new Promise(setImmediate); elements["room-history"].listeners.click(); await new Promise(setImmediate);
  assert.equal(elements["history-position"].textContent, "2 / 2");
  elements["history-prev"].listeners.click(); await new Promise(setImmediate);
  assert.equal(JSON.parse(calls[2].options.body).handNumber, 100);
  assert.equal(elements["history-position"].textContent, "1 / 2");
});

test("真实页面默认开启音效，服务端确认下注才响，重复快照和重连不重播，关开均保留牌局", async () => {
  const sound = fakeSoundEnvironment();
  const { elements, sockets, document } = mount([roomResponse()], "", { sound });
  await new Promise(setImmediate); authenticate(sockets[0]);
  assert.equal(elements["sound-toggle"].attributes["aria-pressed"], "true");
  const first = gameSnapshot(); sockets[0].receive({ type: "SNAPSHOT", payload: first });
  document.listeners.pointerdown(); assert.equal(sound.nodes.length, 0);
  elements["call-action"].listeners.click(); assert.equal(sound.nodes.length, 0);
  const bet = { ...first, revision: 2, game: { ...first.game, pot: 9,
    players: first.game.players.map((p, i) => i ? p : { ...p, stack: 197, bet: 3 }) } };
  sockets[0].receive({ type: "SNAPSHOT", payload: bet });
  const played = sound.nodes.length; assert.ok(played > 0);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...bet, revision: 3 } }); assert.equal(sound.nodes.length, played);
  elements["sound-toggle"].listeners.click();
  assert.ok(sound.nodes.every(n => n.disconnected)); assert.equal(sound.storage.get("poker-sound-enabled"), "false");
  const ended = { ...bet, revision: 4, game: { ...bet.game, phase: "complete", result: { winners: [0] } } };
  sockets[0].receive({ type: "SNAPSHOT", payload: ended }); assert.equal(sound.nodes.length, played);
  assert.match(elements["table-result"].textContent, /获胜/);
  elements["sound-toggle"].listeners.click(); assert.equal(sound.storage.get("poker-sound-enabled"), "true");
  const enabledCount = sound.nodes.length;
  await elements["connect-ws"].listeners.click(); authenticate(sockets[1]);
  sockets[1].receive({ type: "SNAPSHOT", payload: ended }); assert.equal(sound.nodes.length, enabledCount);
});

test("音效关闭状态在页面初始化恢复；行动和下一手计时随服务端时间提示且每秒去重", async () => {
  const saved = fakeSoundEnvironment("false");
  const muted = mount([roomResponse()], "", { sound: saved }); await new Promise(setImmediate);
  assert.equal(muted.elements["sound-toggle"].attributes["aria-pressed"], "false");
  muted.document.listeners.pointerdown(); assert.equal(saved.contexts.length, 0);

  let now = Date.now(); class ClockDate extends Date { static now() { return now; } }
  const sound = fakeSoundEnvironment();
  const { elements, sockets, document, intervals } = mount([roomResponse()], "", { sound, Date: ClockDate });
  await new Promise(setImmediate); authenticate(sockets[0]); document.listeners.pointerdown();
  const first = gameSnapshot(); first.serverTime = new Date(now).toISOString(); first.game.turnDeadline = new Date(now + 11000).toISOString();
  sockets[0].receive({ type: "SNAPSHOT", payload: first }); assert.equal(sound.nodes.length, 0);
  now += 1000; for (const tick of intervals.values()) tick(); assert.equal(sound.nodes.length, 1);
  for (const tick of intervals.values()) tick(); assert.equal(sound.nodes.length, 1);
  now += 1000; for (const tick of intervals.values()) tick(); assert.equal(sound.nodes.length, 2);
  sockets[0].onclose({ code: 1006 }); now += 1000;
  for (const tick of intervals.values()) tick(); assert.equal(sound.nodes.length, 2);

  await elements["connect-ws"].listeners.click(); authenticate(sockets[1]);
  const completed = { ...first, revision: 2, serverTime: new Date(now).toISOString(),
    room: { ...first.room, playState: "RUNNING", nextHand: { status: "COUNTDOWN", startsAt: new Date(now + 4000).toISOString() } },
    game: { ...first.game, phase: "complete", turn: null, result: { winners: [0] } } };
  sockets[1].receive({ type: "SNAPSHOT", payload: completed }); assert.equal(sound.nodes.length, 2);
  now += 1000; for (const tick of intervals.values()) tick(); assert.equal(sound.nodes.length, 3);
  sockets[1].receive({ type: "SNAPSHOT", payload: { ...completed, revision: 3, serverTime: new Date(now).toISOString() } });
  assert.equal(sound.nodes.length, 3);
  assert.equal(elements["next-hand-countdown"].textContent, "下一手 · 3s");
});

test("弃牌周边倒计时跟随服务器截止平滑缩减，刷新快照不重置，归零不发送弃牌", async () => {
  let now = Date.now(); class ClockDate extends Date { static now() { return now; } }
  const { elements, sockets, intervals } = mount([roomResponse()], "", { Date: ClockDate });
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  first.room.settings.turnSeconds = 30;
  first.serverTime = new Date(now + 60000).toISOString();
  first.game.turnDeadline = new Date(now + 90000).toISOString();
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  assert.equal(elements["fold-countdown-ring"].hidden, false);
  assert.equal(elements["fold-countdown-seconds"].textContent, "30s");
  assert.equal(Number(elements["fold-action"].style.values["--action-countdown-offset"]), 0);
  now += 7500; for (const tick of intervals.values()) tick();
  assert.equal(elements["fold-countdown-seconds"].textContent, "23s");
  assert.equal(Number(elements["fold-action"].style.values["--action-countdown-offset"]), 25);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, serverTime: new Date(now + 60000).toISOString() } });
  assert.equal(Number(elements["fold-action"].style.values["--action-countdown-offset"]), 25);
  now += 12500; for (const tick of intervals.values()) tick();
  assert.equal(elements["fold-countdown-seconds"].textContent, "10s");
  assert.equal(elements["fold-action"].attributes["data-urgent"], "true");
  now += 10000; for (const tick of intervals.values()) tick();
  assert.equal(elements["fold-countdown-seconds"].textContent, "0s");
  assert.equal(Number(elements["fold-action"].style.values["--action-countdown-offset"]), 100);
  assert.equal(elements["fold-action"].disabled, true);
  assert.equal(sockets[0].sent.filter(frame => frame.type === "ACTION").length, 0);
});

test("弃牌计时圈只显示本人当前行动，提交、换人、旁观、缺截止及结算及时清除", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  first.game.turnDeadline = new Date(Date.now() + 20000).toISOString();
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  assert.equal(elements["fold-countdown-ring"].hidden, false);
  sockets[0].onclose({ code: 1000, reason: "" });
  assert.equal(elements["fold-action"].disabled, true);
  assert.equal(elements["fold-countdown-ring"].hidden, false);
  await elements["connect-ws"].listeners.click(); authenticate(sockets[1]);
  sockets[1].receive({ type: "SNAPSHOT", payload: first });
  elements["fold-action"].listeners.click();
  assert.equal(elements["fold-countdown-ring"].hidden, true);
  assert.equal(elements["fold-countdown-seconds"].hidden, true);
  for (const [index, overrides] of [
    { game: { ...first.game, turn: 1 } },
    { self: { ...first.self, seatIndex: null, roomState: "WATCHING" } },
    { game: { ...first.game, turnDeadline: null } },
    { game: { ...first.game, phase: "complete", turn: null, result: {} } },
  ].entries()) {
    sockets[1].receive({ type: "SNAPSHOT", payload: { ...first, ...overrides, revision: index + 2 } });
    assert.equal(elements["fold-countdown-ring"].hidden, true);
    assert.equal(elements["fold-countdown-seconds"].textContent, "");
    assert.equal(elements["fold-action"].attributes["aria-label"], "弃牌");
  }
});

test("可过牌时倒计时围绕过牌按钮，归零只等待服务端，不由前端发送动作", async () => {
  let now = Date.now(); class ClockDate extends Date { static now() { return now; } }
  const { elements, sockets, intervals } = mount([roomResponse()], "", { Date: ClockDate });
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  first.serverTime = new Date(now + 60000).toISOString();
  first.game = { ...first.game, phase: "flop", board: ["2d", "5c", "6h"],
    players: first.game.players.map(p => ({ ...p, bet: 0 })),
    legal: { ...first.game.legal, canCheck: true, canCall: false, toCall: 0 },
    turnDeadline: new Date(now + 90000).toISOString() };
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  assert.equal(elements["call-action"].children[0].textContent, "过牌");
  assert.equal(elements["call-action"].children[1], elements["check-countdown-ring"]);
  assert.equal(elements["check-countdown-ring"].hidden, false);
  assert.equal(elements["fold-countdown-ring"].hidden, true);
  assert.equal(elements["check-countdown-seconds"].textContent, "30s");
  assert.equal(Number(elements["call-action"].style.values["--action-countdown-offset"]), 0);
  now += 15000; for (const tick of intervals.values()) tick();
  assert.equal(elements["check-countdown-seconds"].textContent, "15s");
  assert.equal(Number(elements["call-action"].style.values["--action-countdown-offset"]), 50);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, serverTime: new Date(now + 60000).toISOString() } });
  assert.equal(elements["check-countdown-seconds"].textContent, "15s");
  now += 15000; for (const tick of intervals.values()) tick();
  assert.equal(elements["check-countdown-seconds"].textContent, "0s");
  assert.equal(Number(elements["call-action"].style.values["--action-countdown-offset"]), 100);
  assert.equal(elements["call-action"].disabled, true);
  assert.equal(sockets[0].sent.filter(frame => frame.type === "ACTION").length, 0);
});

test("快照在过牌和跟注之间切换时，计时圈只挂到一个按钮，不重置服务端截止", async () => {
  let now = Date.now(); class ClockDate extends Date { static now() { return now; } }
  const { elements, sockets, intervals } = mount([roomResponse()], "", { Date: ClockDate });
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot(); first.serverTime = new Date(now).toISOString();
  first.game.turnDeadline = new Date(now + 30000).toISOString();
  const free = { ...first.game, phase: "flop", players: first.game.players.map(p => ({ ...p, bet: 0 })),
    legal: { ...first.game.legal, canCheck: true, canCall: false, toCall: 0 } };
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, game: free } });
  now += 5000; for (const tick of intervals.values()) tick();
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, serverTime: new Date(now).toISOString() } });
  assert.equal(elements["check-countdown-ring"].hidden, true);
  assert.equal(elements["check-countdown-seconds"].textContent, "");
  assert.equal(elements["fold-countdown-ring"].hidden, false);
  assert.equal(elements["fold-countdown-seconds"].textContent, "25s");
  assert.equal(elements["call-action"].children[0].textContent, "跟注");
  assert.equal(elements["call-action"].children[1].textContent, "3");
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 3, game: free, serverTime: new Date(now).toISOString() } });
  assert.equal(elements["check-countdown-ring"].hidden, false);
  assert.equal(elements["check-countdown-seconds"].textContent, "25s");
  assert.equal(elements["fold-countdown-ring"].hidden, true);
  assert.equal(elements["fold-countdown-seconds"].textContent, "");
  elements["call-action"].listeners.click();
  assert.equal(elements["check-countdown-ring"].hidden, true);
  assert.equal(elements["fold-countdown-ring"].hidden, true);
  const action = sockets[0].sent.filter(frame => frame.type === "ACTION").at(-1);
  assert.equal(action.payload.action, "check");
});


test("座位和成员列表不展示在线离线，也不因断线降低头像亮度", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  first.game.players = first.game.players.map((p, i) => ({ ...p, online: i === 0 }));
  first.roomMembers = first.game.players.map(p => ({ ...p, state: "IN_HAND" }));
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  for (const id of ["table-seats", "members-list"]) {
    assert.ok(!descendants(elements[id]).some(n => /在线|离线/.test(n.textContent)));
    assert.ok(!descendants(elements[id]).some(n => /\boffline\b/.test(n.className)));
  }
  assert.equal(elements["online-count"], undefined);
});

test("多赢家展示各自牌型和奖额，胜利画面只播一次，到时收起仍保留座位高亮", async () => {
  const { elements, sockets, timeouts } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot();
  first.game.players = [
    { seatIndex: 4, userId: "a", nickname: "甲", stack: 200, hole: ["Ah", "Kh"] },
    { seatIndex: 1, userId: "b", nickname: "乙", stack: 200, hole: ["As", "Ks"] },
  ];
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  const ended = { ...first, revision: 2, game: { ...first.game, phase: "complete", result: {
    winners: [1, 4], hands: ["同花", "顺子"], payouts: [{ userId: "a", amount: 120 }, { userId: "b", amount: 80 }],
  } } };
  sockets[0].receive({ type: "SNAPSHOT", payload: ended });
  assert.equal(elements["victory-layer"].hidden, false);
  assert.equal(elements["victory-title"].textContent, "共同获胜");
  assert.deepEqual(Array.from(elements["victory-winners"].children, n => Array.from(n.children, c => c.textContent)), [["甲", "同花 +120"], ["乙", "顺子 +80"]]);
  const confetti = elements["victory-confetti"].children;
  assert.equal(confetti.length, 36);
  const winners = elements["table-seats"].children.filter(n => n.className.includes(" winner"));
  assert.deepEqual(Array.from(winners, n => descendants(n).find(c => c.className === "seat-hand-name").textContent), ["顺子", "同花"]);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...ended, revision: 3 } });
  assert.equal(elements["victory-confetti"].children[0], confetti[0]);
  for (const callback of [...timeouts.values()]) callback();
  assert.equal(elements["victory-layer"].hidden, true);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...ended, revision: 4 } });
  assert.equal(elements["victory-layer"].hidden, true);
  assert.equal(elements["table-seats"].children.filter(n => n.className.includes(" winner")).length, 2);
});
