import test from "node:test";
import assert from "node:assert/strict";
import { ownSeat, tableLayout, raisePresets } from "../src/poker-table.js";

test("2–9 人的座位布局保持唯一座位，旋转本人到底部且不修改服务端座位编号", () => {
  for (let count = 2; count <= 9; count++) {
    const layout = tableLayout(count, count - 1);
    assert.equal(layout.length, count);
    assert.equal(new Set(layout.map((seat) => seat.seatIndex)).size, count);
    assert.equal(layout[0].seatIndex, count - 1);
    assert.equal(layout[0].y, 89);
  }
});

test("明确的旁观状态不从旧成员数据恢复座位，兼容成员列表中的零号座位", () => {
  const roomMembers = [{ userId: "u0", seatIndex: 0 }];
  assert.equal(ownSeat({ self: { userId: "u0", seatIndex: null }, roomMembers }), null);
  assert.equal(ownSeat({ self: { userId: "u0" }, roomMembers }), 0);
});

test("快捷加注包含本人本轮下注和跟注，按筹码单位取整并限制合法范围", () => {
  const game = { turn: 0, pot: 10, players: [{ seatIndex: 0, bet: 2 }],
    legal: { toCall: 3, canRaise: true, minRaiseTo: 10, maxRaiseTo: 20, chipUnit: 2 } };
  assert.deepEqual(raisePresets(game).map((preset) => preset.amount), [20, 16, 12, 10]);
  assert.deepEqual(raisePresets({ ...game, legal: null }), []);
});
