// TDA 2026 rules 45 / 49. Money and turns still come from confirmed snapshots.
// Keep full raise size separate from each player's last response to the wager.
export function createPokerBettingRules({ storage } = {}) {
  if (storage === undefined) {
    try { storage = globalThis.sessionStorage; } catch { /* Storage can be disabled. */ }
  }
  const storageKey = "poker-betting-round-v1";
  let round = null;
  const chips = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const snapshot = (game) => ({ turn: game.turn, deadline: game.turnDeadline,
    players: game.players.map(p => ({ seat: p.seatIndex, bet: chips(p.bet), stack: chips(p.stack),
      folded: Boolean(p.folded), allIn: Boolean(p.allIn) })) });
  function persist() {
    try { storage?.setItem(storageKey, JSON.stringify(round)); } catch { /* In-memory tracking still works. */ }
  }
  function observe(view) {
    const game = view.game;
    if (!game) { round = null; return; }
    if (game.phase === "complete") { round = null; persist(); return; }
    const bigBlind = chips(view.room?.settings?.bigBlind) || 1;
    const key = JSON.stringify([view.room?.roomId, view.self?.userId ?? view.self?.id,
      game.handId ?? game.handNumber, game.phase]);
    const next = snapshot(game);
    const highest = Math.max(game.phase === "preflop" ? bigBlind : 0, ...next.players.map(p => p.bet));
    if (round?.key !== key) {
      round = null;
      try {
        const saved = JSON.parse(storage?.getItem(storageKey) || "null");
        if (saved?.key === key && typeof saved.complete === "boolean" && Number.isSafeInteger(saved.fullRaise) && saved.fullRaise >= bigBlind
            && Number.isSafeInteger(saved.highest) && saved.highest >= 0
            && Array.isArray(saved.responses) && saved.responses.every(item => Array.isArray(item)
              && item.length === 2 && Number.isSafeInteger(item[0]) && Number.isSafeInteger(item[1]) && item[1] >= 0)
            && Array.isArray(saved.previous?.players) && saved.previous.players.every(p => p
              && Number.isSafeInteger(p.seat) && Number.isSafeInteger(p.bet) && p.bet >= 0)) round = saved;
      } catch { /* A fresh browser may have no record of this street. */ }
    }
    if (!round) {
      // Blind posts are not voluntary actions. A nonzero mid-street snapshot
      // cannot reveal the order or size of earlier raises, so never guess it.
      const initial = game.phase === "preflop"
        ? next.players.every(p => p.bet <= (p.seat === game.bigBlindSeat ? bigBlind
          : p.seat === game.smallBlindSeat ? chips(view.room?.settings?.smallBlind) : 0))
        : highest === 0;
      round = { key, highest, fullRaise: bigBlind, complete: initial, responses: [], previous: next };
    } else {
      const previous = round.previous;
      const changed = next.players.filter(p => p.bet !== previous.players.find(old => old.seat === p.seat)?.bet);
      const actor = next.players.find(p => p.seat === previous.turn);
      const oldActor = previous.players.find(p => p.seat === previous.turn);
      const acted = actor && oldActor && (actor.bet !== oldActor.bet || actor.folded !== oldActor.folded
        || next.turn !== previous.turn || next.deadline !== previous.deadline);
      if (highest < round.highest || changed.length > 1
          || changed.some(p => p.seat !== previous.turn || p.bet < previous.players.find(old => old.seat === p.seat)?.bet)
          || next.players.length !== previous.players.length) round.complete = false;
      if (round.complete && acted) {
        const increment = highest - round.highest;
        if (highest > round.highest && (increment >= round.fullRaise || round.highest < bigBlind && highest >= bigBlind)) {
          round.fullRaise = round.highest < bigBlind ? highest : increment;
        }
        round.responses = round.responses.filter(([seat]) => seat !== actor.seat);
        round.responses.push([actor.seat, highest]);
      }
      round.highest = highest;
      round.previous = next;
    }
    persist();
  }
  function legal(game) {
    if (!game?.legal || !round) return game?.legal;
    const player = game.players.find(p => p.seatIndex === game.turn);
    if (!player) return { ...game.legal, canRaise: false };
    const bet = chips(player.bet), stack = chips(player.stack), maxRaiseTo = bet + stack;
    const toCall = Math.max(0, round.highest - bet);
    const last = round.responses.find(([seat]) => seat === player.seatIndex)?.[1];
    // A check facing an opening wager retains raise rights, including a short opening all-in.
    const reopened = last === undefined || last === 0 || round.highest - last >= round.fullRaise;
    const opponent = game.players.some(p => p.seatIndex !== player.seatIndex && !p.folded && !p.allIn && chips(p.stack) > 0);
    const canRaise = round.complete && reopened && opponent && !player.folded && !player.allIn && stack > toCall;
    const minimumFullRaiseTo = round.highest < round.fullRaise ? round.fullRaise : round.highest + round.fullRaise;
    const reason = !round.complete ? "本轮行动记录不完整，暂时只能跟注或弃牌；下一轮恢复加注。"
      : !reopened ? "短码全下未达到完整加注，加注权未重新开放；只能跟注或弃牌。" : "";
    return { ...game.legal, canFold: true, canCheck: toCall === 0, canCall: toCall > 0,
      toCall: Math.min(toCall, stack), canRaise, maxRaiseTo,
      minRaiseTo: Math.min(minimumFullRaiseTo, maxRaiseTo), minimumFullRaiseTo,
      fullRaise: round.fullRaise, shortAllInOnly: canRaise && maxRaiseTo < minimumFullRaiseTo,
      raiseReason: reason, chipUnit: chips(game.legal.chipUnit) || 1 };
  }
  function reset() { round = null; }
  return { observe, legal, reset };
}

export function validPokerRaise(legal, amount) {
  return Boolean(legal?.canRaise && Number.isSafeInteger(amount) && amount >= legal.minRaiseTo
    && amount <= legal.maxRaiseTo && (amount === legal.maxRaiseTo || amount % (legal.chipUnit || 1) === 0));
}
