import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ticketFromLocation, ticketFragmentUrl, validateSettings, redactCredentials } from "../src/poker-entry.js";

const script = readFileSync(new URL("../src/p.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");

function element() {
  return {
    value: "", textContent: "", hidden: true, disabled: false, className: "", children: [],
    listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    querySelector() { return this.submitButton ||= element(); },
    replaceChildren(...items) { this.children = items; },
    append(...items) { this.children.push(...items); },
  };
}

function mount(responses, initialToken = "") {
  const ids = ["message", "system-version", "login-panel", "waiting-panel", "create-panel",
    "closed-panel", "error-panel", "error-detail", "room-panel", "connection-panel", "login-form", "access-token", "create-form",
    "create-room", "refresh-entry", "retry-entry", "connect-ws", "copy-ws-url", "settings-error", "activity-panel",
    "activity-title", "activity-id", "activity-status", "self-name", "self-role", "activity-count",
    "room-title", "room-id", "room-status", "room-member-count", "online-count", "seated-count",
    "self-state", "room-settings", "members-list", "ws-url", "protocol-version", "ws-expires",
    "ws-status", "debug-endpoint", "debug-request", "debug-response"];
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  const calls = [];
  const storage = new Map(initialToken ? [["poker-entry-access-token", initialToken]] : []);
  class FakeFormData {
    constructor(form) { this.entries = Object.entries(form.fields || {}); }
    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  }
  runInNewContext(script, {
    POKER_API_BASE_URL: "https://api.example.com",
    ticketFromLocation, ticketFragmentUrl, validateSettings, redactCredentials,
    window: { location: { href: "https://example.com/p.html#ticket=v1.k1.test", search: "", hash: "#ticket=v1.k1.test" } },
    document: { getElementById(id) { return elements[id]; }, createElement: element },
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
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  });
  return { elements, calls, storage };
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

test("已有房间直接展示房间信息和 WebSocket 地址", async () => {
  const settings = { maxSeats: 6, seatingType: 0, smallBlind: 10, bigBlind: 20, startingStack: 1000, turnSeconds: 30 };
  const { elements, calls } = mount([{ status: 200, body: {
    code: 0, message: "success", systemVersion: version,
    data: { entryState: "ROOM_READY", created: false, activity, self, counts,
      room: { roomId: "A123", name: "周末牌局", status: "WAITING", settings },
      roomMembers: [{ id: "1", nickname: "创建人", state: "WATCHING", stack: 1000, online: false }],
      connection: { url: "wss://api.example.com/ws/poker/v1", wsToken: "secret", protocolVersion: 1, expiresAt: "2026-09-30T04:00:00Z" } },
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
        connection: { url: "wss://api.example.com/ws/poker/v1", wsToken: "secret", protocolVersion: 1, expiresAt: "2026-09-30T04:00:00Z" } } } },
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
