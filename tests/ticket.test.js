import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ticketFromLocation, ticketFragmentUrl } from "../src/poker-entry.js";

const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const entryScript = index.match(/<script>([\s\S]*?)<\/script>/)[1];
const page = readFileSync(new URL("../p.html", import.meta.url), "utf8");
const pageScript = readFileSync(new URL("../src/p.js", import.meta.url), "utf8");

test("首页将 hash ticket 转到 p.html，保留在 hash 中", () => {
  let destination;
  runInNewContext(entryScript, {
    window: {
      location: {
        search: "",
        hash: "#ticket=v1.k1.test%2Dvalue",
        replace(url) { destination = url; },
      },
    },
    document: { createElement() { throw new Error("不应加载游戏脚本"); } },
  });
  assert.equal(destination, "./p.html#ticket=v1.k1.test-value");
});

test("首页将查询参数 ticket 转入 fragment，普通访问继续加载游戏", () => {
  let destination;
  let app;
  const document = {
    createElement() { return {}; },
    body: { appendChild(script) { app = script; } },
  };
  const location = { search: "?ticket=v1.k1.query", hash: "", replace(url) { destination = url; } };
  runInNewContext(entryScript, { window: { location }, document });
  assert.equal(destination, "./p.html#ticket=v1.k1.query");
  location.search = "";
  runInNewContext(entryScript, { window: { location }, document });
  assert.equal(app.src, "./src/app.js");
});

test("活动页面只展示版本、请求接口、请求内容和返回内容", () => {
  for (const id of ["page-version", "endpoint", "endpoint-url", "access-token", "request-body", "request-preview", "response-body"]) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(page, /id="room-area"|id="stage-panel"|id="ws-traces"/);
  assert.match(page, /页面版本 <time[^>]+>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\/time>/);
  assert.match(page, /type="module" src="\.\/src\/p\.js"/);
});

test("从 hash 或 query 读取 ticket，忽略其他参数", () => {
  assert.equal(ticketFromLocation({ search: "", hash: "#ticket=v1.k1.test%2Dvalue&x=1" }), "v1.k1.test-value");
  assert.equal(ticketFromLocation({ search: "?ticket=query", hash: "#ticket=hash" }), "query");
  assert.equal(ticketFromLocation({ search: "", hash: "" }), "");
});

test("旧查询参数链接转成可刷新的 fragment 链接", () => {
  assert.equal(ticketFragmentUrl({
    href: "https://example.com/p.html?ticket=v1.k1.test&mode=1",
    search: "?ticket=v1.k1.test&mode=1",
    hash: "",
  }), "/p.html?mode=1#ticket=v1.k1.test");
  assert.equal(ticketFragmentUrl({
    href: "https://example.com/p.html#ticket=v1.k1.test",
    search: "",
    hash: "#ticket=v1.k1.test",
  }), null);
});

test("调试页展示实际请求和服务端原始响应，并能切换建房接口", async () => {
  const ids = ["endpoint", "endpoint-url", "access-token", "request-body", "request-preview",
    "request-error", "send-request", "response-status", "response-body"];
  const elements = Object.fromEntries(ids.map((id) => [id, {
    value: "",
    textContent: "",
    className: "",
    disabled: false,
    listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
  }]));
  elements.endpoint.value = "/api/poker/v1/entry";
  const calls = [];
  const response = { code: 0, message: "success", data: { entryState: "READY_TO_CREATE" } };
  runInNewContext(pageScript.replace(/^import .*;\n/gm, ""), {
    POKER_API_BASE_URL: "https://api.example.com",
    ticketFromLocation,
    ticketFragmentUrl,
    window: { location: { href: "https://example.com/p.html#ticket=v1.k1.test", search: "", hash: "#ticket=v1.k1.test" } },
    document: { getElementById(id) { return elements[id]; } },
    history: { replaceState() {} },
    performance: { now: () => 100 },
    setTimeout: () => 1,
    clearTimeout() {},
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, ok: true, headers: new Map([["content-type", "application/json"]]),
        text: async () => JSON.stringify(response) };
    },
    AbortController,
    URL,
    JSON,
  });
  assert.match(elements["request-body"].value, /v1\.k1\.test/);
  elements["access-token"].value = "abc123";
  elements["access-token"].listeners.input();
  assert.match(elements["request-preview"].textContent, /Bearer abc123/);
  await elements["send-request"].listeners.click();
  assert.equal(calls[0].url, "https://api.example.com/api/poker/v1/entry");
  assert.equal(calls[0].options.headers.Authorization, "Bearer abc123");
  assert.deepEqual(JSON.parse(calls[0].options.body), { ticket: "v1.k1.test" });
  assert.match(elements["response-body"].textContent, /READY_TO_CREATE/);

  elements.endpoint.value = "/api/poker/v1/rooms";
  elements.endpoint.listeners.change();
  elements["request-body"].value = JSON.stringify({ ticket: "v1.k1.test", settings: { maxSeats: 6 } });
  elements["request-body"].listeners.input();
  await elements["send-request"].listeners.click();
  assert.equal(calls[1].url, "https://api.example.com/api/poker/v1/rooms");
  assert.deepEqual(JSON.parse(calls[1].options.body).settings, { maxSeats: 6 });
});
