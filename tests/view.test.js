import test from "node:test";
import assert from "node:assert/strict";
import { act, createGame, startHand } from "../src/engine.js";
import { playerView } from "../src/view.js";

test("在线视图不会泄露对方底牌、牌堆或未轮到玩家的操作", () => {
  const game = createGame({ mode: "online", names: ["甲", "乙"] });
  startHand(game);
  const left = playerView(game, 0);
  const right = playerView(game, 1);
  assert.equal(left.players[0].hole.length, 2);
  assert.deepEqual(left.players[1].hole, [null, null]);
  assert.deepEqual(right.players[0].hole, [null, null]);
  assert.equal(right.players[1].hole.length, 2);
  assert.equal(left.deck, undefined);
  assert.equal(right.deck, undefined);
  assert.ok(left.legal);
  assert.equal(right.legal, null);
});

test("弃牌结束时仍隐藏弃牌者底牌", () => {
  const game = createGame({ mode: "online", names: ["甲", "乙"] });
  startHand(game);
  act(game, "fold");
  const view = playerView(game, 1);
  assert.deepEqual(view.players[0].hole, [null, null]);
  assert.equal(view.result.hands, null);
});
