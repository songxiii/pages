import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const entryScript = index.match(/<script>([\s\S]*?)<\/script>/)[1];
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

function runPageWithResponse(responseText, status) {
  const elements = {
    result: { textContent: "" },
    profile: { hidden: true },
    avatar: { hidden: true, src: "", alt: "" },
    "avatar-fallback": { hidden: false, textContent: "人" },
    "user-name": { textContent: "" },
    "activity-id": { textContent: "" },
  };
  let request;
  class FakeRequest {
    constructor() { request = this; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.header = [name, value]; }
    send(body) {
      this.body = body;
      this.status = status;
      this.responseText = responseText;
      this.onload();
    }
  }
  runInNewContext(pageScript, {
    window: { location: { search: "", hash: "#ticket=v1.k1.test" } },
    document: { getElementById(id) { return elements[id]; } },
    XMLHttpRequest: FakeRequest,
  });
  return { elements, request };
}

test("p.html 仅将 ticket 作为 JSON 提交，并显示错误响应内容", () => {
  const { elements, request } = runPageWithResponse('{"code":401,"message":"链接无效"}', 401);
  assert.equal(request.method, "POST");
  assert.equal(request.header[0], "Content-Type");
  assert.equal(request.header[1], "application/json");
  assert.deepEqual(JSON.parse(request.body), { ticket: "v1.k1.test" });
  assert.match(elements.result.textContent, /链接无效/);
  assert.equal(elements.profile.hidden, true);
});

test("p.html 显示成功响应中的头像、姓名和活动 ID", () => {
  const response = { code: 0, data: { username: "小明", avatarUrl: "https://example.com/avatar.png", openid: "private", activityId: "A123" }, message: "success" };
  const { elements } = runPageWithResponse(JSON.stringify(response), 200);
  assert.equal(elements.profile.hidden, false);
  assert.equal(elements["user-name"].textContent, "小明");
  assert.equal(elements["activity-id"].textContent, "A123");
  assert.equal(elements.avatar.src, "https://example.com/avatar.png");
  elements.avatar.onload();
  assert.equal(elements.avatar.hidden, false);
  assert.equal(elements["avatar-fallback"].hidden, true);
  assert.deepEqual(JSON.parse(elements.result.textContent), response);
});
