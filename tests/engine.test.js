import test from "node:test";
import assert from "node:assert/strict";
import { act, bestHand, compareScores, createGame, legalActions, potSize, shuffledDeck, startHand } from "../src/engine.js";

const orderedDeck = shuffledDeck(() => 0.5);

test("牌型比较识别同花顺、四条和 A 到 5 的顺子", () => {
  const straightFlush = bestHand(["As", "Ks", "Qs", "Js", "Ts", "2d", "3c"]);
  const quads = bestHand(["Ah", "Ad", "Ac", "As", "Kd", "2c", "3h"]);
  const wheel = bestHand(["Ah", "2d", "3c", "4s", "5h", "Kd", "Qc"]);
  assert.equal(straightFlush.name, "同花顺");
  assert.equal(quads.name, "四条");
  assert.deepEqual(wheel.score, [4, 5]);
  assert.equal(compareScores(straightFlush.score, quads.score), 1);
});

test("相同牌型正确比较踢脚牌", () => {
  const strong = bestHand(["As", "Ah", "Kd", "Qc", "9s", "2d", "3c"]);
  const weak = bestHand(["Ad", "Ac", "Jd", "Tc", "9h", "2s", "3d"]);
  assert.equal(compareScores(strong.score, weak.score), 1);
});

test("盲注、跟注与过牌推进到翻牌圈", () => {
  const game = createGame();
  startHand(game, orderedDeck);
  assert.equal(game.dealer, 0);
  assert.equal(game.turn, 0);
  assert.equal(potSize(game), 30);
  assert.equal(legalActions(game).toCall, 10);
  act(game, "call");
  assert.equal(game.turn, 1);
  act(game, "check");
  assert.equal(game.phase, "flop");
  assert.equal(game.board.length, 3);
  assert.equal(game.turn, 1);
  assert.equal(potSize(game), 40);
});

test("弃牌后底池支付给另一位玩家，总筹码守恒", () => {
  const game = createGame();
  startHand(game, orderedDeck);
  act(game, "fold");
  assert.deepEqual(game.result.winners, [1]);
  assert.equal(game.players[0].stack + game.players[1].stack, 2000);
  assert.equal(game.phase, "complete");
});

test("短筹码全下只争夺匹配的筹码，退回多余下注", () => {
  const game = createGame({ startingStack: 100 });
  game.players[1].stack = 30;
  startHand(game, orderedDeck);
  act(game, "raise", 100);
  act(game, "call");
  assert.equal(game.phase, "complete");
  assert.equal(game.board.length, 5);
  assert.equal(game.players[0].stack + game.players[1].stack, 130);
  assert.equal(game.players[0].committed, 30);
  assert.equal(game.players[1].committed, 30);
});

test("非法过牌和低于最小加注会被拒绝", () => {
  const game = createGame();
  startHand(game, orderedDeck);
  assert.throws(() => act(game, "check"), /必须跟注/);
  assert.throws(() => act(game, "raise", 25), /最少加注/);
});
