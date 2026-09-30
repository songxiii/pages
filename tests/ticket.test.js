import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ticketFromLocation, validateSettings, responseData, DEFAULT_SETTINGS } from "../src/poker-entry.js";

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

test("首页兼容查询参数 ticket，普通访问继续加载游戏", () => {
  let destination;
  let app;
  const document = {
    createElement() { return {}; },
    body: { appendChild(script) { app = script; } },
  };
  const location = { search: "?ticket=v1.k1.query", hash: "", replace(url) { destination = url; } };
  runInNewContext(entryScript, { window: { location }, document });
  assert.equal(destination, "./p.html?ticket=v1.k1.query");
  location.search = "";
  runInNewContext(entryScript, { window: { location }, document });
  assert.equal(app.src, "./src/app.js");
});

test("活动页面提供验证、建房、等待和旁观房间视图", () => {
  for (const id of ["entry-form", "create-form", "stage-panel", "room-area", "seat-ring", "members-list"]) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.match(page, /type="module" src="\.\/src\/p\.js"/);
});

test("从 hash 或 query 读取 ticket，忽略其他参数", () => {
  assert.equal(ticketFromLocation({ search: "", hash: "#ticket=v1.k1.test%2Dvalue&x=1" }), "v1.k1.test-value");
  assert.equal(ticketFromLocation({ search: "?ticket=query", hash: "#ticket=hash" }), "query");
  assert.equal(ticketFromLocation({ search: "", hash: "" }), "");
});

test("创建设置按后端规则校验，默认值可用", () => {
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, startingStack: 100 }), /20 倍/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, maxSeats: 10 }), /2–9/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, bigBlind: 1 }), /大盲注/);
});

test("API 错误优先显示服务端说明", () => {
  assert.deepEqual(responseData({ code: 0, data: { entryState: "ROOM_READY" } }, 200), { entryState: "ROOM_READY" });
  assert.throws(() => responseData({ code: 409, errorMsg: "配置不可修改" }, 409), /配置不可修改/);
});
