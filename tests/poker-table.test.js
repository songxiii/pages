import test from "node:test";
import assert from "node:assert/strict";
import { ownSeat, tableLayout, raisePresets, handPositions, seatIndex } from "../src/poker-table.js";

test("2–9 人所有本人座位都在正下方，保留真实座位编号与顺序，布局左右平衡", () => {
  for (let count = 2; count <= 9; count++) {
    for (let self = 0; self < count; self++) {
      const layout = tableLayout(count, self);
      assert.equal(layout.length, count);
      assert.equal(new Set(layout.map((seat) => seat.seatIndex)).size, count);
      assert.deepEqual(layout[0], { seatIndex: self, x: 50, y: 89 });
      assert.deepEqual(layout.map((seat) => seat.seatIndex), Array.from({ length: count }, (_, i) => (self + i) % count));
      assert.equal(layout.reduce((sum, seat) => sum + seat.x, 0) / count, 50);
      assert.equal(new Set(layout.map((seat) => `${seat.x},${seat.y}`)).size, count);
    }
  }
  assert.equal(tableLayout(2, 1)[1].x, 50);
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

test("多人大盲小盲跳过未参局空座，不随本轮下注或弃牌变化", () => {
  const players = [0, 3, 7].map((seatIndex) => ({ seatIndex, bet: 80, folded: seatIndex === 3 }));
  assert.deepEqual(handPositions({ dealer: 0, players }), { dealer: 0, smallBlindSeat: 3, bigBlindSeat: 7 });
  assert.deepEqual(handPositions({ dealer: 7, players }), { dealer: 7, smallBlindSeat: 0, bigBlindSeat: 3 });
});

test("双人庄家同时是小盲，大盲为另一位玩家", () => {
  const players = [{ seatIndex: 2 }, { seatIndex: 8 }];
  assert.deepEqual(handPositions({ dealer: 8, players }), { dealer: 8, smallBlindSeat: 8, bigBlindSeat: 2 });
});

test("优先服务端盲注座位，兼容位置标签，明确 null 时不自行补盲位", () => {
  const players = [{ seatIndex: 0, position: "BTN" }, { seatIndex: 1, position: "SB" }, { seatIndex: 2, position: "BB" }];
  assert.deepEqual(handPositions({ players }), { dealer: 0, smallBlindSeat: 1, bigBlindSeat: 2 });
  assert.deepEqual(handPositions({ dealer: 0, smallBlindSeat: 2, bigBlindSeat: 1, players }), { dealer: 0, smallBlindSeat: 2, bigBlindSeat: 1 });
  assert.deepEqual(handPositions({ dealer: 0, smallBlindSeat: null, bigBlindSeat: 1, players }), { dealer: 0, smallBlindSeat: null, bigBlindSeat: 1 });
  assert.deepEqual(handPositions(null), { dealer: null, smallBlindSeat: null, bigBlindSeat: null });
});

test("兼容 Java 旧视图的 1 基 seatNo，显式 seatIndex=null 优先代表旁观", () => {
  assert.equal(seatIndex({ seatNo: 1 }), 0);
  assert.equal(seatIndex({ seatNo: 9 }), 8);
  assert.equal(seatIndex({ seatNo: null }), null);
  assert.equal(seatIndex({ seatIndex: null, seatNo: 4 }), null);
  assert.equal(ownSeat({ self: { userId: "u1", seatNo: 4 } }), 3);
});
