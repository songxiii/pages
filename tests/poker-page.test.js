import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { ticketFromLocation, ticketFragmentUrl, validateSettings, redactCredentials, normalizeWebSocketUrl } from "../src/poker-entry.js";

const tableScript = readFileSync(new URL("../src/poker-table.js", import.meta.url), "utf8").replace(/^export /gm, "");
const script = tableScript + "\n" + readFileSync(new URL("../src/p.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");

function element() {
  return {
    value: "", textContent: "", hidden: true, disabled: false, className: "", children: [],
    listeners: {}, attributes: {}, clientWidth: 400, clientHeight: 650,
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    remove() { this.removed = true; },
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
  const confirmations = [];
  const confirmResults = [...(options.confirmResults || [])];
  const intervals = new Map();
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
  runInNewContext(script, {
    POKER_API_BASE_URL: options.apiBase || "https://api.example.com",
    ticketFromLocation, ticketFragmentUrl, validateSettings, redactCredentials, normalizeWebSocketUrl,
    window: { confirm(value) { confirmations.push(value); return confirmResults.shift() ?? false; }, location: { href: "https://example.com/p.html#ticket=v1.k1.test", protocol: "https:", search: "", hash: "#ticket=v1.k1.test" } },
    WebSocket: FakeWebSocket, crypto: webcrypto,
    navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
    document: { body: element(), addEventListener() {}, getElementById(id) { return elements[id]; }, createElement: element },
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
        text: async () => JSON.stringify(next.body) };
    },
    AbortController, URL, URLSearchParams, Date, JSON,
    setTimeout: () => 1, clearTimeout() {},
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
  });
  return { elements, calls, storage, sockets, copied, intervals, confirmations };
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
  const settings = { maxSeats: 6, seatingType: 0, smallBlind: 10, bigBlind: 20, startingStack: 1000, turnSeconds: 30 };
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
  const settings = { maxSeats: 6, seatingType: 0, smallBlind: 10, bigBlind: 20, startingStack: 1000, turnSeconds: 30 };
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
  assert.equal(elements["online-count"].textContent, "1");
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
  assert.equal(elements["ws-status"].textContent, "连接错误");
  assert.match(elements["ws-detail"].textContent, /TLS.*1006/);
  await elements["connect-ws"].listeners.click();
  sockets[1].open();
  sockets[1].receive({ type: "AUTH_EXPIRED", payload: { message: "连接凭证已过期" } });
  sockets[1].onclose({ code: 4001, reason: "AUTH_EXPIRED" });
  assert.match(elements["ws-detail"].textContent, /连接凭证已过期.*4001.*AUTH_EXPIRED/);
  assert.equal(elements["ws-status"].textContent, "连接错误");
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
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  sockets[0].receive({ type: "SNAPSHOT", payload: gameSnapshot({ self: { ...self, seatIndex: null, allowedCommands: ["SIT_DOWN"] } }) });
  assert.equal(elements["fold-action"].disabled, true);
  const empty = elements["table-seats"].children.find((seat) => seat.className.includes(" empty"));
  assert.equal(empty.disabled, false);
  assert.equal(elements["ready-player"].hidden, true);
  empty.listeners.click();
  assert.equal(sockets[0].sent.at(-1).type, "SIT_DOWN");
  sockets[0].receive({ type: "ROOM_CLOSED" });
  assert.equal(elements["closed-panel"].hidden, false);
  assert.equal(elements["room-panel"].hidden, true);
});

test("本人换座后仍在正下方，D/SB/BB 随最新牌局正确换位，双人可同时显示庄位与小盲", async () => {
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
  assert.equal(descendants(seats[0]).find((node) => node.className === "seat-position").textContent, "BB");
  assert.equal(descendants(seats[1]).find((node) => node.className === "seat-position").textContent, "SB");
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
  const first = lobbySnapshot(); sockets[0].receive({ type: "SNAPSHOT", payload: first });
  const empty = elements["table-seats"].children.find((seat) => seat.attributes["data-seat-index"] === "4");
  empty.listeners.click(); empty.listeners.click();
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "SIT_DOWN").length, 1);
  assert.equal(sockets[0].sent.at(-1).payload.seatIndex, 4);
  assert.equal(sockets[0].sent.at(-1).payload.expectedRevision, 1);
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
  assert.equal(elements["pause-game"].hidden, true);
  elements["start-hand"].listeners.click();
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "START_HAND").length, 1);
});

test("暂停请求明确等待本局结束，申请后仍允许本手行动，结算后暂停并可继续游戏", async () => {
  const { elements, sockets } = mount([roomResponse()]);
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = gameSnapshot({
    room: { playState: "RUNNING", settings: { maxSeats: 2 } },
    self: { ...self, seatIndex: 0, roomState: "IN_HAND", allowedCommands: ["PAUSE_GAME", "START_HAND"] },
    roomMembers: [{ seatIndex: 0, state: "IN_HAND" }, { seatIndex: 1, state: "IN_HAND" }],
  });
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  assert.equal(elements["start-hand"].disabled, true);
  assert.equal(elements["pause-game"].disabled, false);
  elements["pause-game"].listeners.click();
  assert.equal(sockets[0].sent.at(-1).type, "PAUSE_GAME");
  assert.equal(sockets[0].sent.at(-1).payload.afterCurrentHand, true);
  assert.equal(elements["table-phase"].textContent, "第 1 手 · 翻牌前");
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, room: { ...first.room, playState: "PAUSE_PENDING" } } });
  assert.equal(elements["pause-game"].disabled, true);
  assert.equal(elements["call-action"].disabled, false);
  assert.equal(elements["play-state-notice"].hidden, false);
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 3,
    self: { ...first.self, allowedCommands: ["RESUME_GAME"] },
    room: { ...first.room, playState: "PAUSED" }, game: { ...first.game, phase: "complete", legal: null } } });
  assert.equal(elements["call-action"].disabled, true);
  assert.equal(elements["resume-game"].hidden, false);
  assert.equal(elements["resume-game"].disabled, false);
  elements["resume-game"].listeners.click();
  assert.equal(sockets[0].sent.at(-1).type, "RESUME_GAME");
});

test("所有已落座成员可起身，取消 confirm 不发送操作，确认后才发送；旁观者不显示起身", async () => {
  const { elements, sockets, confirmations } = mount([roomResponse()], "", { confirmResults: [false, true] });
  await new Promise(setImmediate); authenticate(sockets[0]);
  const first = lobbySnapshot({ self: { userId: "u1", role: "MEMBER", seatIndex: 1, roomState: "SEATED", allowedCommands: ["STAND_UP"] } });
  sockets[0].receive({ type: "SNAPSHOT", payload: first });
  assert.equal(elements["host-controls"].hidden, true);
  assert.equal(elements["stand-up"].hidden, false);
  elements["stand-up"].listeners.click();
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "STAND_UP").length, 0);
  assert.equal(elements["stand-up"].disabled, false);
  elements["stand-up"].listeners.click();
  assert.equal(confirmations.length, 2);
  assert.equal(sockets[0].sent.at(-1).type, "STAND_UP");
  sockets[0].receive({ type: "SNAPSHOT", payload: { ...first, revision: 2, self: { ...first.self, seatIndex: null }, roomMembers: [] } });
  assert.equal(elements["stand-up"].hidden, true);
  elements["stand-up"].listeners.click();
  assert.equal(confirmations.length, 2);
  assert.equal(sockets[0].sent.filter((frame) => frame.type === "STAND_UP").length, 1);
});

test("品牌固定为算法培训班，不随活动名变化，页头不包含黑桃和副标题", async () => {
  const { elements } = mount([roomResponse()]);
  await new Promise(setImmediate);
  assert.equal(elements["page-title"].textContent, "算法培训班");
  const html = readFileSync(new URL("../p.html", import.meta.url), "utf8");
  const header = html.match(/<header[\s\S]*?<\/header>/)[0];
  assert.doesNotMatch(header, /♠|活动专属牌局|page-subtitle/);
  assert.doesNotMatch(html, /桌边/);
});
