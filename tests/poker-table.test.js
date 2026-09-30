import test from "node:test";
import assert from "node:assert/strict";
import { ownSeat, tableLayout, raisePresets, handPositions, seatIndex, buyInOptions, memberAmounts, seatPositions } from "../src/poker-table.js";

test("成员盈亏优先使用服务字段，兼容账本差额，缺失金额不能冒充零", () => {
  assert.deepEqual(memberAmounts({ totalBuyIn: 1000, stack: 800, netChips: 50 }), { totalBuyIn: 1000, netChips: 50 });
  assert.deepEqual(memberAmounts({ totalBuyIn: "1000", stack: 800, pendingBuyIn: 400 }), { totalBuyIn: 1000, netChips: -200 });
  assert.deepEqual(memberAmounts({ totalBuyIn: 0, netChips: 0 }), { totalBuyIn: 0, netChips: 0 });
  for (const value of [undefined, null, "", true, "invalid", Infinity]) {
    assert.deepEqual(memberAmounts({ totalBuyIn: value, netChips: value, stack: 200 }), { totalBuyIn: null, netChips: null });
  }
});

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


test("带入下拉只接受服务规定的安全整数、范围和增量，缺配置不能提交", () => {
  const buyIn = { minAmount: 200, maxAmount: 1000, step: 200, options: [200, 200, 400, 300, 0, -200, 1200, "600", Number.MAX_SAFE_INTEGER + 1] };
  assert.deepEqual(buyInOptions({ room: { buyIn } }), [200, 400]);
  assert.deepEqual(buyInOptions({ room: { buyIn: { ...buyIn, step: 0 } } }), []);
  assert.deepEqual(buyInOptions({}), []);
});

test("2–9人按本手参局顺序显示中文盲位和庄位、UTG等位置，跳过空座保留弃牌者", () => {
  const early = { 3: [], 4: ["UTG"], 5: ["UTG", "CO"], 6: ["UTG", "HJ", "CO"],
    7: ["UTG", "UTG+1", "HJ", "CO"], 8: ["UTG", "UTG+1", "LJ", "HJ", "CO"],
    9: ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO"] };
  for (let count = 3; count <= 9; count++) {
    for (let dealer = 0; dealer < count; dealer++) {
      const sb = (dealer + 1) % count, bb = (dealer + 2) % count;
      const positions = seatPositions({ dealer, smallBlindSeat: sb, bigBlindSeat: bb,
        players: Array.from({ length: count }, (_, seatIndex) => ({ seatIndex, folded: seatIndex === 4 })) });
      assert.equal(positions.get(dealer), "庄位"); assert.equal(positions.get(sb), "小盲"); assert.equal(positions.get(bb), "大盲");
      early[count].forEach((name, i) => assert.equal(positions.get((bb + 1 + i) % count), name));
    }
  }
  assert.deepEqual([...seatPositions({ dealer: 2, players: [{ seatIndex: 2, position: "SB" }, { seatIndex: 7, position: "BB" }] })], [[2, "庄位/小盲"], [7, "大盲"]]);
  const game = { dealer: 0, smallBlindSeat: 2, bigBlindSeat: 3,
    players: [0, 2, 3, 5, 8].map((seatIndex) => ({ seatIndex, folded: seatIndex === 5 })) };
  assert.equal(seatPositions(game).get(5), "UTG"); assert.equal(seatPositions(game).get(8), "CO");
  assert.equal(seatPositions({ ...game, players: [...game.players, { seatIndex: 6, position: "UTG+1" }] }).get(6), "UTG+1");
  assert.equal(seatPositions(null).size, 0);
});
