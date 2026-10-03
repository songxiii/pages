import test from "node:test";
import assert from "node:assert/strict";
import { createPokerSound, pokerSoundEvents, SOUND_STORAGE_KEY } from "../src/poker-sound.js";
import { fakeSoundEnvironment } from "../test-support/poker-audio.js";

function snapshot() {
  return { self: { userId: "me", seatIndex: 0 }, room: { roomId: "R1", playState: "RUNNING" },
    roomMembers: [{ userId: "me", seatIndex: 0, ready: false, totalBuyIn: 1000 }],
    game: { handId: "H1", phase: "preflop", board: [], pot: 30, turn: 1, turnDeadline: "deadline1",
      players: [{ userId: "me", seatIndex: 0, stack: 990, bet: 10 }, { userId: "other", seatIndex: 1, stack: 980, bet: 20 }] } };
}
const copy = value => structuredClone(value);

test("首次进入、重复快照、换房和历史结算不重播音效", () => {
  const first = snapshot();
  assert.deepEqual(pokerSoundEvents(null, first), []);
  assert.deepEqual(pokerSoundEvents(first, copy(first)), []);
  assert.deepEqual(pokerSoundEvents(first, { ...first, room: { roomId: "R2" } }), []);
  const ended = copy(first); ended.game.phase = "complete"; ended.game.result = { winners: [0] };
  assert.deepEqual(pokerSoundEvents(null, ended), []);
  assert.deepEqual(pokerSoundEvents(ended, copy(ended)), []);
});

test("确认下注、跨轮下注、全下、弃牌和过牌各有对应音效", () => {
  const first = snapshot(), bet = copy(first);
  bet.game.players[1].stack -= 20; bet.game.pot += 20;
  assert.deepEqual(pokerSoundEvents(first, bet), ["chips"]);
  const flop = copy(bet); flop.game.phase = "flop"; flop.game.board = ["As", "Kh", "Td"]; flop.game.players.forEach(p => p.bet = 0);
  assert.deepEqual(pokerSoundEvents(first, flop), ["chips", "flip"]);
  const allIn = copy(bet); allIn.game.players[1].allInCommitted = true;
  assert.deepEqual(pokerSoundEvents(first, allIn), ["allIn"]);
  const fold = copy(first); fold.game.players[1].folded = true;
  assert.deepEqual(pokerSoundEvents(first, fold), ["fold"]);
  const check = copy(first); check.game.turnDeadline = "deadline2";
  assert.deepEqual(pokerSoundEvents(first, check), ["check"]);
});

test("只有本人行动提醒，新手发牌和翻牌去重", () => {
  const first = snapshot(), next = copy(first); next.game.turn = 0;
  assert.deepEqual(pokerSoundEvents(first, next), ["check", "yourTurn"]);
  assert.deepEqual(pokerSoundEvents(next, copy(next)), []);
  const newHand = copy(next); newHand.game.handId = "H2";
  assert.deepEqual(pokerSoundEvents(next, newHand), ["deal", "yourTurn"]);
  const spectator = copy(next); spectator.self = { userId: "watcher", seatIndex: null };
  const spectatorBefore = copy(first); spectatorBefore.self = spectator.self;
  assert.deepEqual(pokerSoundEvents(spectatorBefore, spectator), ["check"]);
  assert.deepEqual(pokerSoundEvents(first, spectator), []);
});

test("胜负、平局和旁观派奖使用本手身份，不继承同座位其他玩家的胜利", () => {
  const first = snapshot(), ended = copy(first); ended.game.phase = "complete";
  ended.game.result = { winners: [0] };
  assert.deepEqual(pokerSoundEvents(first, ended), ["win"]);
  ended.game.result.winners = [1]; assert.deepEqual(pokerSoundEvents(first, ended), ["lose"]);
  ended.game.result.winners = [0, 1]; assert.deepEqual(pokerSoundEvents(first, ended), ["draw"]);
  const watcher = copy(first); watcher.self.userId = "watcher";
  const watcherEnd = copy(ended); watcherEnd.self.userId = "watcher";
  assert.deepEqual(pokerSoundEvents(watcher, watcherEnd), ["payout"]);
  ended.game.players[1].allInCommitted = true;
  assert.deepEqual(pokerSoundEvents(first, ended), ["allIn", "draw"]);
});

test("本人入座、准备、带入和暂停确认后响，对手成员更新和在线状态不误响", () => {
  const first = snapshot(), next = copy(first);
  next.roomMembers[0].ready = true; assert.deepEqual(pokerSoundEvents(first, next), ["confirm"]);
  next.roomMembers[0].totalBuyIn += 200; assert.deepEqual(pokerSoundEvents(first, next), ["confirm", "chips"]);
  const paused = copy(first); paused.room.playState = "PAUSED"; assert.deepEqual(pokerSoundEvents(first, paused), ["confirm"]);
  const online = copy(first); online.roomMembers.push({ userId: "other", seatIndex: 1, ready: true }); online.roomMembers[0].online = true;
  assert.deepEqual(pokerSoundEvents(first, online), []);
});


function mount(saved) {
  const env = fakeSoundEnvironment(saved);
  env.sound = createPokerSound({ document: env.document, window: env.window, storage: env.localStorage, button: env.button });
  return env;
}

test("默认开启但用户交互之前不创建音频，关闭后立即停止含延时的全部声音并持久保存", () => {
  const env = mount(); assert.equal(env.sound.enabled, true); assert.equal(env.attributes["aria-pressed"], "true");
  env.sound.play("chips"); assert.equal(env.contexts.length, 0);
  env.listeners.pointerdown(); env.sound.play("win"); assert.equal(env.nodes.length, 4);
  env.button.click(); assert.equal(env.sound.enabled, false); assert.equal(env.attributes["aria-pressed"], "false");
  assert.equal(env.storage.get(SOUND_STORAGE_KEY), "false");
  assert.ok(env.nodes.every(n => n.stops.length === 2 && n.disconnected));
  env.sound.play("chips"); assert.equal(env.nodes.length, 4);
  const reload = mount(env.storage.get(SOUND_STORAGE_KEY)); reload.listeners.pointerdown();
  assert.equal(reload.sound.enabled, false); assert.equal(reload.contexts.length, 0);
});

test("静音期间推进音效基线，重新开启不补播过去下注，重连首个快照静音", () => {
  const env = mount("false"), first = snapshot(); env.sound.observe(first);
  const bet = copy(first); bet.game.pot += 20; env.sound.observe(bet);
  env.sound.setEnabled(true); const count = env.nodes.length;
  env.sound.observe(copy(bet)); assert.equal(env.nodes.length, count);
  env.sound.baseline(); const complete = copy(bet); complete.game.phase = "complete"; complete.game.result = { winners: [0] };
  env.sound.observe(complete); assert.equal(env.nodes.length, count);
});

test("行动最后十秒、开手最后三秒提示，重复或倒退秒数不重响，到零及离线不响", () => {
  const env = mount(); env.listeners.keydown();
  env.sound.countdown("turn", "H1:0:deadline", 11); assert.equal(env.nodes.length, 0);
  env.sound.countdown("turn", "H1:0:deadline", 10); assert.equal(env.nodes.length, 1);
  env.sound.countdown("turn", "H1:0:deadline", 10); env.sound.countdown("turn", "H1:0:deadline", 11);
  assert.equal(env.nodes.length, 1);
  env.sound.countdown("turn", "H1:0:deadline", 3); assert.equal(env.nodes.length, 2);
  env.sound.countdown("turn", "H1:0:deadline", 0); env.sound.countdown("turn", "H1:0:deadline", 2, false);
  assert.equal(env.nodes.length, 2);
  env.sound.countdown("nextHand", "startsAt", 4); assert.equal(env.nodes.length, 2);
  env.sound.countdown("nextHand", "startsAt", 3); env.sound.countdown("nextHand", "startsAt", 3); assert.equal(env.nodes.length, 3);
  env.sound.countdown("turn", "H1:0:newDeadline", 10); assert.equal(env.nodes.length, 4);
});

test("后台立即停止声音，恢复不补播漏过的倒计时；跨标签关闭同步静音", () => {
  const env = mount(); env.listeners.pointerdown(); env.sound.play("win");
  env.document.hidden = true; env.listeners.visibilitychange(); assert.ok(env.nodes.every(n => n.disconnected));
  env.sound.countdown("turn", "H1", 3); assert.equal(env.nodes.length, 4);
  env.document.hidden = false; env.sound.countdown("turn", "H1", 3); assert.equal(env.nodes.length, 4);
  env.storage.set(SOUND_STORAGE_KEY, "false"); env.windowListeners.storage({ key: SOUND_STORAGE_KEY });
  assert.equal(env.sound.enabled, false); env.sound.play("confirm"); assert.equal(env.nodes.length, 4);
});

test("全部音效可生成，结束后释放节点，音频或存储不可用仍可关闭开关", () => {
  const env = mount(); env.listeners.pointerdown();
  for (const name of ["click", "confirm", "chips", "allIn", "fold", "check", "deal", "flip", "yourTurn", "tick", "urgent", "win", "lose", "draw", "payout", "error"]) env.sound.play(name);
  assert.ok(env.nodes.length > 30);
  env.nodes.forEach(n => n.onended()); assert.ok(env.nodes.every(n => n.disconnected));
  delete env.window.AudioContext;
  const sound = createPokerSound({ document: env.document, window: env.window, button: env.button,
    storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } });
  assert.equal(sound.enabled, true); env.listeners.pointerdown();
  assert.doesNotThrow(() => { sound.play("chips"); sound.setEnabled(false); sound.setEnabled(true); });
});
