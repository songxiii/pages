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

test("p.html 仅将 ticket 作为 JSON 提交，并显示错误响应内容", () => {
  const result = { textContent: "" };
  let request;
  class FakeRequest {
    constructor() { request = this; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.header = [name, value]; }
    send(body) {
      this.body = body;
      this.status = 401;
      this.responseText = '{"code":401,"message":"链接无效"}';
      this.onload();
    }
  }
  runInNewContext(pageScript, {
    window: { location: { search: "", hash: "#ticket=v1.k1.test" } },
    document: { getElementById() { return result; } },
    XMLHttpRequest: FakeRequest,
  });
  assert.equal(request.method, "POST");
  assert.equal(request.header[0], "Content-Type");
  assert.equal(request.header[1], "application/json");
  assert.deepEqual(JSON.parse(request.body), { ticket: "v1.k1.test" });
  assert.match(result.textContent, /链接无效/);
});
