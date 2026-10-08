import test from "node:test";
import assert from "node:assert/strict";
import { ownSeat, tableLayout, raisePresets, handPositions, seatIndex, buyInOptions, memberAmounts, seatPositions, roomControls, handAwards, winningHandName, nextHandState, playerReady, waitingNextHand, memberStateText, needsChips, eligiblePlayerCount } from "../src/poker-table.js";

test("等人数只统计有可用筹码的在座成员，不计旁观者、起身者或未到账筹码", () => {
  const view = { game: { handId: "H1", phase: "complete" }, room: { playState: "RUNNING", nextHand: { status: "WAITING_PLAYERS" } }, roomMembers: [
    { seatIndex: 0, stack: 0, pendingBuyIn: 200 }, { seatIndex: 1, stack: 100 },
    { seatIndex: null, stack: 200 }, { seatIndex: 2, state: "STANDING", stack: 200 } ] };
  assert.equal(eligiblePlayerCount(view), 1);
  assert.equal(nextHandState(view, Date.now()).text, "等待可参局玩家 · 1/2");
  assert.equal(memberStateText(view, view.roomMembers[0]), "等待补筹码");
  const funded = { ...view, roomMembers: view.roomMembers.map((m, i) => i === 0 ? { ...m, stack: 200 } : m) };
  assert.equal(eligiblePlayerCount(funded), 2);
  assert.equal(nextHandState(funded, Date.now()).text, "人数已满足，等待服务端发牌…");
  assert.equal(eligiblePlayerCount({ ...view, roomMembers: [{ seatIndex: 0, stack: null }] }), null);
  assert.equal(eligiblePlayerCount({ ...view, room: { nextHand: { eligiblePlayerCount: 0 } } }), 0);
  assert.equal(eligiblePlayerCount({ ...view, room: { nextHand: { eligiblePlayerCount: 10 } } }), 1);
});

test("运行手牌中的零筹码全下仍可获胜，不显示等待补筹码", () => {
  const member = { userId: "u0", seatIndex: 0, stack: 0 };
  const view = { game: { phase: "flop", players: [{ ...member, allIn: true }] } };
  assert.equal(needsChips(view, member), false);
  assert.equal(memberStateText(view, member), "牌局中");
  assert.equal(needsChips({ game: { phase: "complete" } }, { ...member, stack: null }), false);
});

test("首次开始后取消准备展示和权限，连续游戏等待、暂停期间也不恢复准备", () => {
  const member = { userId: "a", seatIndex: 0, ready: true, state: "READY" };
  for (const playState of ["RUNNING", "PAUSED", "PAUSE_PENDING"]) {
    const view = { room: { playState }, self: { ...member, allowedCommands: ["READY", "UNREADY", "START_HAND"] }, roomMembers: [member] };
    assert.equal(playerReady(view, member), false);
    assert.equal(roomControls(view).canReady, false); assert.equal(roomControls(view).canUnready, false);
    assert.equal(memberStateText(view, member), "等待下一局");
  }
  assert.equal(playerReady({ game: { phase: "complete" } }, member), false);
});

test("下一局加入按用户身份与当前参局名单判断，不能因同座位继承上一人的牌", () => {
  const member = { userId: "new", seatIndex: 1 };
  const view = { game: { phase: "flop", players: [{ userId: "old", seatIndex: 1 }] } };
  assert.equal(waitingNextHand(view, member), true);
  assert.equal(memberStateText(view, member), "下一局加入");
  assert.equal(waitingNextHand(view, { ...member, seatIndex: null }), false);
  const joined = { ...view, game: { phase: "preflop", players: [member] } };
  assert.equal(waitingNextHand(joined, { ...member, participation: "WAITING_NEXT_HAND" }), false);
  assert.equal(memberStateText(joined, member), "牌局中");
});

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

test("快捷加注合并因最小值、最大值和取整产生的重复金额，限制值不显示虚假比例", () => {
  const game = { turn: 0, pot: 10, players: [{ seatIndex: 0, bet: 0 }],
    legal: { toCall: 0, canRaise: true, minRaiseTo: 6, maxRaiseTo: 8, chipUnit: 1 } };
  assert.deepEqual(raisePresets(game).map(({ amount, label }) => ({ amount, label })),
    [{ amount: 8, label: "最大加注" }, { amount: 6, label: "最小加注" }]);
  assert.deepEqual(raisePresets({ ...game, pot: 0 }).map((preset) => preset.amount), [6]);
  assert.deepEqual(raisePresets({ ...game, pot: 100 }).map((preset) => preset.amount), [8]);
  const rounded = raisePresets({ ...game, pot: 4, legal: { ...game.legal, minRaiseTo: 1, maxRaiseTo: 100 } });
  assert.deepEqual(rounded.map((preset) => preset.amount), [5, 3, 2]);
  assert.equal(rounded[2].label, "底池 50%");
  assert.equal(raisePresets({ ...game, legal: { ...game.legal, minRaiseTo: 8 } })[0].label, "最大加注");
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

test("2–9人庄盲位只保留标记，UTG等位置跳过空座保留弃牌者", () => {
  const early = { 3: [], 4: ["UTG"], 5: ["UTG", "CO"], 6: ["UTG", "HJ", "CO"],
    7: ["UTG", "UTG+1", "HJ", "CO"], 8: ["UTG", "UTG+1", "LJ", "HJ", "CO"],
    9: ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO"] };
  for (let count = 3; count <= 9; count++) {
    for (let dealer = 0; dealer < count; dealer++) {
      const sb = (dealer + 1) % count, bb = (dealer + 2) % count;
      const positions = seatPositions({ dealer, smallBlindSeat: sb, bigBlindSeat: bb,
        players: Array.from({ length: count }, (_, seatIndex) => ({ seatIndex, folded: seatIndex === 4 })) });
      assert.equal(positions.has(dealer), false); assert.equal(positions.has(sb), false); assert.equal(positions.has(bb), false);
      early[count].forEach((name, i) => assert.equal(positions.get((bb + 1 + i) % count), name));
    }
  }
  assert.deepEqual([...seatPositions({ dealer: 2, players: [{ seatIndex: 2, position: "SB" }, { seatIndex: 7, position: "BB" }] })], []);
  const game = { dealer: 0, smallBlindSeat: 2, bigBlindSeat: 3,
    players: [0, 2, 3, 5, 8].map((seatIndex) => ({ seatIndex, folded: seatIndex === 5 })) };
  assert.equal(seatPositions(game).get(5), "UTG"); assert.equal(seatPositions(game).get(8), "CO");
  assert.equal(seatPositions({ ...game, players: [...game.players, { seatIndex: 6, position: "UTG+1" }] }).get(6), "UTG+1");
  assert.equal(seatPositions(null).size, 0);
});


test("取消准备兼容仅授权起身的旧快照，仍拒绝牌局中、权限为空及活动关闭", () => {
  const lobby = { self: { userId: "u1", seatIndex: 0, roomState: "READY", allowedCommands: ["STAND_UP"] },
    room: { status: "WAITING" }, roomMembers: [{ userId: "u1", seatIndex: 0, state: "READY" }] };
  assert.equal(roomControls(lobby).canUnready, true);
  for (const overrides of [{ self: { ...lobby.self, allowedCommands: [] } }, { room: { status: "CLOSED" } },
    { activity: { status: "ENDED" } }, { activity: { status: "CANCELLED" } }, { game: { phase: "flop" } },
    { self: { ...lobby.self, seatIndex: null } }]) assert.equal(roomControls({ ...lobby, ...overrides }).canUnready, false);
});

test("赢家复用现有座号，单赢家取底池；多赢家不猜分配额，新payouts按用户和座位聚合", () => {
  const players = [{ userId: "a", seatIndex: 0, nickname: "甲" }, { userId: "b", seatIndex: 4, nickname: "乙" }];
  const game = { phase: "complete", pot: 300, players, result: { winners: [0] } };
  assert.deepEqual(handAwards(game), [{ seatIndex: 0, userId: "a", nickname: "甲", amount: 300 }]);
  assert.deepEqual(handAwards({ ...game, result: { winners: [0, 4] } }).map(a => a.amount), [null, null]);
  const split = { ...game, result: { winners: [0, 4], payouts: [
    { userId: "a", seatIndex: 0, amount: 100 }, { userId: "b", seatIndex: 4, amount: 150 }, { userId: "a", amount: 50 },
    { userId: "unknown", seatIndex: 0, amount: 1000 }, { seatIndex: 4, amount: -1 }, { seatIndex: 4, amount: "200" },
  ] } };
  assert.deepEqual(handAwards(split).map(a => [a.seatIndex, a.amount]), [[0, 150], [4, 150]]);
  assert.deepEqual(handAwards({ ...game, phase: "river" }), []);
});

test("下一局时间使用服务端截止；暂停、人数不足和过期时间有明确状态，不伪造自动发牌", () => {
  const now = Date.parse("2026-10-01T01:00:00Z");
  const game = { handId: "H1", phase: "complete" };
  const room = { playState: "RUNNING", nextHand: { status: "COUNTDOWN", sourceHandId: "H1", startsAt: "2026-10-01T01:00:10Z" } };
  assert.equal(nextHandState({ game, room }, now).text, "下一局 · 10s");
  assert.equal(nextHandState({ game, room }, now + 8000).seconds, 2);
  assert.equal(nextHandState({ game, room }, now + 10000).text, "正在等待服务端发牌…");
  assert.equal(nextHandState({ game, room: { ...room, playState: "PAUSED" } }, now).text, "等待服务端继续牌局");
  assert.equal(nextHandState({ game, room: { nextHand: { status: "WAITING_PLAYERS" } } }, now).text, "等待至少两名可参局玩家");
  assert.equal(nextHandState({ game: { ...game, phase: "preflop" }, room }, now).visible, false);
  assert.equal(nextHandState({ game: { ...game, handId: "H2" }, room }, now).visible, false);
  assert.equal(nextHandState({ game, room: { status: "CLOSED" } }, now).visible, false);
  assert.equal(nextHandState({ game }, now, now + 10000).text, "结算展示 · 10s");
  assert.equal(nextHandState({ game }, now + 10000, now + 10000).text, "等待服务端开启下一局");
});


test("赢家牌型按参局玩家顺序映射稀疏座号，缺牌型不推测底牌", () => {
  const game = { phase: "complete", players: [{ seatIndex: 7 }, { seatIndex: 2 }], result: { hands: ["同花", "一对"] } };
  assert.equal(winningHandName(game, 7), "同花");
  assert.equal(winningHandName(game, 2), "一对");
  assert.equal(winningHandName({ ...game, phase: "river" }, 7), "");
  assert.equal(winningHandName(game, 0), "");
  for (const hands of [null, [], "同花"]) assert.equal(winningHandName({ ...game, result: { hands } }, 7), "牌型待公布");
  const foldWin = { ...game, players: [{ seatIndex: 7 }, { seatIndex: 2, folded: true }], result: { hands: null } };
  assert.equal(winningHandName(foldWin, 7), "其他玩家弃牌");
  assert.equal(winningHandName({ ...foldWin, result: game.result }, 2), "");
});
