import { legalActions, potSize } from "./engine.js";

// This is the only representation of a game sent to a remote browser.
export function playerView(game, seat) {
  const reveal = game.phase === "complete" && Boolean(game.result?.hands);
  return {
    mode: game.mode,
    handNumber: game.handNumber,
    phase: game.phase,
    board: [...game.board],
    dealer: game.dealer,
    turn: game.turn,
    pot: potSize(game),
    players: game.players.map((player) => ({
      id: player.id,
      name: player.name,
      stack: player.stack,
      bet: player.bet,
      folded: player.folded,
      allIn: player.allIn,
      hole: player.id === seat || reveal ? [...player.hole] : player.hole.map(() => null),
    })),
    legal: game.turn === seat ? legalActions(game) : null,
    result: game.result,
    log: [...game.log],
  };
}
