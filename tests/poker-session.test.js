import test from "node:test";
import assert from "node:assert/strict";
import { roomEnded, sessionClock, settlementShowAt, settlementRows, settlementStats } from "../src/poker-session.js";
import { roomControls } from "../src/poker-table.js";
import { validateSettings } from "../src/poker-entry.js";

const now = Date.parse("2026-10-02T00:00:00Z");
test("房间计时按绝对截止，暂停不冻结，到零不在前端结束当前手", () => {
  const view = { room: { playState: "PAUSED", timing: { endsAt: new Date(now + 3661000).toISOString() } }, game: { phase: "flop" } };
  assert.equal(sessionClock(view, now).text, "剩余 01:01:01");
  assert.equal(sessionClock(view, now + 3661000).text, "时间已到 · 本手结束后结算");
  assert.equal(roomEnded(view), false);
  assert.equal(sessionClock({ room: {} }, now).visible, false);
  assert.equal(sessionClock({ room: { timing: { status: "ENDING" } } }, now).text, "时间已到 · 等待结算");
});
test("到时即使快照误授权也禁止新开局、继续、带入与入座，结算展示截止使用服务端时间", () => {
  const view = { self: { userId: "a", role: "CREATOR", seatIndex: 0, allowedCommands: ["START_HAND", "RESUME_GAME", "READY", "BUY_IN", "SIT_DOWN"] },
    room: { playState: "PAUSED", timing: { endsAt: new Date(now).toISOString() } },
    roomMembers: [{ userId: "a", seatIndex: 0 }, { userId: "b", seatIndex: 1 }] };
  const controls = roomControls(view, now);
  assert.equal(controls.canStart, false); assert.equal(controls.canResume, false); assert.equal(controls.canReady, false); assert.equal(controls.canBuyIn, false);
  assert.equal(roomControls({ ...view, self: { ...view.self, seatIndex: null } }, now).canSit, false);
  assert.equal(settlementShowAt({ room: { timing: { endedAt: new Date(now).toISOString() } } }, now + 4000), now + 10000);
  assert.equal(settlementShowAt({ settlement: { showAt: new Date(now + 8000).toISOString() } }, now), now + 8000);
});
test("结算按净盈利排序，零、亏损和缺失值不混淆，排序不修改服务端对象", () => {
  const report = { players: [{ userId: "negative", netChips: -100, handsPlayed: 0 }, { userId: "unknown", netChips: null },
    { userId: "zero", netChips: 0, totalBuyIn: 0 }, { userId: "positive", netChips: 100, totalBuyIn: 200, handsPlayed: 5 }] };
  const rows = settlementRows(report);
  assert.deepEqual(rows.map(p => p.userId), ["positive", "zero", "negative", "unknown"]);
  assert.equal(report.players[0].userId, "negative");
  assert.equal(rows[3].netChips, null); assert.equal(rows[3].handsPlayed, null);
  assert.equal(rows[1].totalBuyIn, 0);
  assert.deepEqual(settlementStats({ totalHands: 0, totalPot: "10", maxPot: -1, totalBuyIn: Number.MAX_SAFE_INTEGER + 1 }),
    { totalHands: 0, totalPot: null, maxPot: null, totalBuyIn: null });
});
test("游戏时长随创建请求提交且拒绝未选、超范围和非整数时长", () => {
  const valid = { maxSeats: 6, seatingType: 1, smallBlind: 1, bigBlind: 2, startingStack: 200, turnSeconds: 30, durationMinutes: 120 };
  assert.equal(validateSettings(valid).durationMinutes, 120);
  for (const durationMinutes of [null, 0, 15, 121, 1000, 90.5]) assert.throws(() => validateSettings({ ...valid, durationMinutes }));
});
