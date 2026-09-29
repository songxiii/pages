import { bestHand, legalActions } from "./engine.js";

const RANKS = "23456789TJQKA";
function value(card) { return RANKS.indexOf(card[0]) + 2; }

// The bot makes decisions from its own cards and the public board only.
export function chooseAiAction(game, random = Math.random) {
  const legal = legalActions(game);
  if (!legal) return null;
  const bot = game.players[1];
  const ranks = bot.hole.map(value);
  const suited = bot.hole[0][1] === bot.hole[1][1];
  let strength = ranks[0] === ranks[1] ? .65 + Math.max(...ranks) / 45 : Math.max(...ranks) / 27 + (suited ? .08 : 0);
  if (game.board.length >= 3) {
    const category = bestHand([...bot.hole, ...game.board]).score[0];
    strength = Math.max(strength, [0.2, .48, .62, .7, .8, .86, .94, .98, 1][category]);
  }
  const callRatio = legal.toCall / Math.max(1, bot.stack + bot.bet);
  if (legal.toCall && callRatio > .25 && strength < .55 && random() < .8) return { type: "fold" };
  if (legal.canRaise && strength > .72 && random() < .42) {
    return { type: "raise", amount: Math.min(legal.maxRaiseTo, legal.minRaiseTo) };
  }
  if (legal.canCall) return { type: "call" };
  return { type: "check" };
}
