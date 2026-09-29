import test from "node:test";
import assert from "node:assert/strict";
import { ticketFromLocation } from "../src/ticket.js";

test("从 URL 查询参数或片段读取 ticket", () => {
  assert.deepEqual(ticketFromLocation(new URL("https://example.com/index.html?ticket=v1.k1.query")), {
    value: "v1.k1.query",
    source: "query",
  });
  assert.deepEqual(ticketFromLocation(new URL("https://example.com/index.html#ticket=v1.k1.fragment")), {
    value: "v1.k1.fragment",
    source: "fragment",
  });
  assert.equal(ticketFromLocation(new URL("https://example.com/index.html#room=123")), null);
});
