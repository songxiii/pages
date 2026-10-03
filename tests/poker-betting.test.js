import test from "node:test";
import assert from "node:assert/strict";
import { createPokerBettingRules, validPokerRaise } from "../src/poker-betting.js";

function table({ bigBlind = 20, phase = "preflop", count = 6, storage } = {}) {
  let rules = createPokerBettingRules({ storage: storage ?? null });
  const view = { self: { userId: "self" }, room: { roomId: "room", settings: { bigBlind, smallBlind: bigBlind / 2 } },
    game: { handId: "H1", phase, turn: 0, smallBlindSeat: count - 2, bigBlindSeat: count - 1,
      players: Array.from({ length: count }, (_, seatIndex) => ({ seatIndex, stack: 1000,
        bet: phase === "preflop" ? seatIndex === count - 1 ? bigBlind : seatIndex === count - 2 ? bigBlind / 2 : 0 : 0 })),
      legal: { canRaise: false, minRaiseTo: 9999, maxRaiseTo: 1, chipUnit: 1 } } };
  rules.observe(view);
  const legal = (seat = view.game.turn) => rules.legal({ ...view.game, turn: seat });
  function act(seat, total, next, allIn = false) {
    assert.equal(view.game.turn, seat);
    const player = view.game.players[seat];
    player.stack = allIn ? 0 : player.stack - (total - player.bet);
    player.bet = total; player.allIn = allIn;
    view.game.turn = next;
    rules.observe(view);
    return legal();
  }
  return { view, legal, act, observe: () => rules.observe(view),
    reconnect: () => { rules = createPokerBettingRules({ storage }); rules.observe(view); } };
}

test("完整加注按增量计算，较大完整加注更新下一次下限", () => {
  const t = table();
  assert.equal(t.legal().minRaiseTo, 40);
  assert.equal(t.act(0, 60, 1).minRaiseTo, 100);
  assert.equal(t.act(1, 120, 2).minRaiseTo, 180);
  assert.equal(t.legal().canRaise, true); // Computed locally despite incorrect server legal fields.
});

test("翻牌 bet20、raise50、raise100 的最小再加注分别为40、80、150", () => {
  const t = table({ phase: "flop" });
  assert.equal(t.act(0, 20, 1).minRaiseTo, 40);
  assert.equal(t.act(1, 50, 2).minRaiseTo, 80);
  assert.equal(t.act(2, 100, 3).minRaiseTo, 150);
});

test("raise60、短全下80：未行动者最低120，原加注者只能补20", () => {
  const t = table(); t.act(0, 60, 1);
  const c = t.act(1, 80, 2, true);
  assert.equal(c.minRaiseTo, 120); assert.equal(c.canRaise, true);
  assert.equal(validPokerRaise(c, 100), false);
  t.act(2, 80, 0);
  assert.equal(t.legal().canRaise, false); assert.equal(t.legal().toCall, 20);
  assert.equal(validPokerRaise(t.legal(), 1000), false); // All-in cannot bypass closed raise rights.
});

test("短全下后未行动者完整raise120，A最低再加160", () => {
  const t = table(); t.act(0, 60, 1); t.act(1, 80, 2, true);
  const a = t.act(2, 120, 0);
  assert.equal(a.canRaise, true); assert.equal(a.minRaiseTo, 160);
});

test("all-in99差1不重开，all-in100刚好重开，超过50%也不能重开", () => {
  for (const total of [80, 81, 99, 100]) {
    const t = table(); t.act(0, 60, 1); const a = t.act(1, total, 0, true);
    assert.equal(a.canRaise, total === 100);
    assert.equal(a.fullRaise, 40);
    if (total === 100) assert.equal(a.minRaiseTo, 140);
  }
});

test("多个短全下累计按各自行动起点：A可以加，跟过75的E不能加", () => {
  const t = table(); t.act(0, 60, 1); t.act(1, 75, 2, true);
  t.act(2, 75, 3); t.act(3, 90, 4, true); t.act(4, 105, 0, true);
  assert.equal(t.legal().canRaise, true); assert.equal(t.legal().minRaiseTo, 145);
  assert.equal(t.legal().fullRaise, 40);
  t.act(0, 105, 2);
  assert.equal(t.legal().canRaise, false); assert.equal(t.legal().toCall, 30);
});

test("TDA官方翻牌100、125、call125、200：A重开，C未重开", () => {
  const t = table({ phase: "flop", bigBlind: 100 });
  t.act(0, 100, 1); t.act(1, 125, 2, true); t.act(2, 125, 3); t.act(3, 200, 0, true);
  assert.equal(t.legal().canRaise, true); assert.equal(t.legal().minRaiseTo, 300);
  t.act(0, 200, 2);
  assert.equal(t.legal().canRaise, false); assert.equal(t.legal().toCall, 75);
});

test("盲注不算行动：call40、all-in70后BB能加110，UTG不能再加", () => {
  const t = table({ bigBlind: 40 }); t.act(0, 40, 1); t.act(1, 70, 5, true);
  assert.equal(t.legal().canRaise, true); assert.equal(t.legal().minRaiseTo, 110);
  t.act(5, 70, 0);
  assert.equal(t.legal().canRaise, false); assert.equal(t.legal().toCall, 30);
});

test("不足最小加注只允许用尽筹码，跟注不足筹码时显示实际全下跟注金额", () => {
  const t = table(); t.act(0, 60, 1); t.act(1, 80, 2, true);
  t.view.game.players[2].stack = 95; t.observe();
  const legal = t.legal();
  assert.equal(legal.shortAllInOnly, true); assert.equal(legal.minimumFullRaiseTo, 120);
  assert.equal(validPokerRaise(legal, 94), false); assert.equal(validPokerRaise(legal, 95), true);
  t.view.game.players[2].stack = 50; t.observe();
  assert.equal(t.legal().canRaise, false); assert.equal(t.legal().toCall, 50);
});

test("过牌后面对不足BB的首次全下仍可加注至BB", () => {
  const t = table({ phase: "flop", bigBlind: 100 });
  t.act(0, 0, 1); t.act(1, 50, 0, true);
  assert.equal(t.legal().canRaise, true); assert.equal(t.legal().minRaiseTo, 100);
  assert.equal(t.act(0, 100, 2).minRaiseTo, 200);
});

test("重复快照不重置个人行动记录；换街、新手、换房间重置", () => {
  const t = table(); t.act(0, 60, 1); t.act(1, 80, 0, true);
  t.observe(); t.observe(); assert.equal(t.legal().canRaise, false);
  for (const change of [() => { t.view.game.phase = "flop"; }, () => { t.view.game.handId = "H2"; }, () => { t.view.room.roomId = "other"; }]) {
    change(); t.view.game.players.forEach(p => { p.bet = 0; }); t.observe();
    assert.equal(t.legal().canRaise, true); assert.equal(t.legal().fullRaise, 20);
  }
});

test("刷新或重连恢复本地记录；漏掉多次下注不猜加注权，下轮恢复", () => {
  const values = new Map(), storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
  const t = table({ storage }); t.act(0, 60, 1); t.act(1, 80, 0, true); t.reconnect();
  assert.equal(t.legal().canRaise, false); assert.equal(t.legal().fullRaise, 40);
  t.view.game.players[2].bet = 120; t.view.game.players[3].bet = 180; t.observe();
  assert.equal(t.legal().canRaise, false); assert.match(t.legal().raiseReason, /记录不完整/);
  t.view.game.phase = "flop"; t.view.game.players.forEach(p => { p.bet = 0; }); t.observe();
  assert.equal(t.legal().canRaise, true);
});

test("首次进入已经下注的轮次与不可用存储不会误放行加注", () => {
  const t = table(); t.act(0, 60, 1);
  for (const storage of [null, { getItem() { throw Error(); }, setItem() { throw Error(); } },
    { getItem: () => "broken", setItem() {} }]) {
    const rules = createPokerBettingRules({ storage }); rules.observe(t.view);
    assert.equal(rules.legal(t.view.game).canRaise, false);
  }
});

test("仅剩一个未全下玩家不能向全下者加注；提交拒绝非整数和不合法单位", () => {
  const t = table({ count: 2 }); t.act(0, 60, 1); t.act(1, 80, 0, true);
  assert.equal(t.legal().canRaise, false);
  const legal = { canRaise: true, minRaiseTo: 120, maxRaiseTo: 199, chipUnit: 2 };
  for (const amount of [NaN, Infinity, 120.5, 121, 100, 200]) assert.equal(validPokerRaise(legal, amount), false);
  assert.equal(validPokerRaise(legal, 120), true); assert.equal(validPokerRaise(legal, 199), true);
});
