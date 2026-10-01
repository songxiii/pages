import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ticketFromLocation, ticketFragmentUrl, validateSettings, redactCredentials } from "../src/poker-entry.js";

const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const entryScript = index.match(/<script>([\s\S]*?)<\/script>/)[1];
const page = readFileSync(new URL("../p.html", import.meta.url), "utf8");

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

test("首页将查询参数 ticket 转入 fragment，普通访问保留欢迎页", () => {
  let destination;
  const document = {
    createElement() { throw new Error("欢迎页不应加载游戏脚本"); },
  };
  const location = { search: "?ticket=v1.k1.query", hash: "", replace(url) { destination = url; } };
  runInNewContext(entryScript, { window: { location }, document });
  assert.equal(destination, "./p.html#ticket=v1.k1.query");
  location.search = "";
  destination = undefined;
  runInNewContext(entryScript, { window: { location }, document });
  assert.equal(destination, undefined);
});

test("活动页面提供身份、创建、等待、房间和连接视图", () => {
  for (const id of ["page-version", "system-version", "login-panel", "waiting-panel", "create-panel", "error-panel", "room-panel", "connection-panel", "ws-url"]) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.match(page, /页面版本 <time[^>]+>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\/time>/);
  assert.match(page, /type="module" src="\.\/src\/p\.js(?:\?[^\"]+)?"/);
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

test("建房设置遵循服务端限制，调试数据会遮盖凭证", () => {
  const valid = { maxSeats: "6", seatingType: "0", smallBlind: "10", bigBlind: "20", startingStack: "1000", turnSeconds: "30", durationMinutes: "120" };
  assert.equal(validateSettings(valid).startingStack, 1000);
  assert.throws(() => validateSettings({ ...valid, startingStack: "100" }), /20 倍/);
  assert.throws(() => validateSettings({ ...valid, maxSeats: "10" }), /2–9/);
  const redacted = redactCredentials({ headers: { Authorization: "Bearer abc" }, body: { ticket: "secret", wsToken: "ws" } });
  assert.equal(redacted.headers.Authorization, "••••••（已隐藏）");
  assert.equal(redacted.body.ticket, "••••••（已隐藏）");
  assert.equal(redacted.body.wsToken, "••••••（已隐藏）");
});
