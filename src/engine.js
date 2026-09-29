export const PHASES = ["preflop", "flop", "turn", "river"];
export const PHASE_LABELS = {
  preflop: "翻牌前",
  flop: "翻牌圈",
  turn: "转牌圈",
  river: "河牌圈",
  complete: "本局结束",
};

const SUITS = ["s", "h", "d", "c"];
const RANKS = "23456789TJQKA";
const HAND_NAMES = ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"];

function secureRandom() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 0x100000000;
}

export function shuffledDeck(random = secureRandom) {
  const deck = SUITS.flatMap((suit) => [...RANKS].map((rank) => `${rank}${suit}`));
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2;
}

function straightHigh(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let i = 0; i <= unique.length - 5; i += 1) {
    if (unique[i] - unique[i + 4] === 4) return unique[i];
  }
  return 0;
}

function scoreFive(cards) {
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every((card) => card[1] === cards[0][1]);
  const straight = straightHigh(values);
  if (flush && straight) return [8, straight];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...values];
  if (straight) return [4, straight];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map(([value]) => value).sort((a, b) => b - a)];
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairs = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    return [2, ...pairs, groups[2][0]];
  }
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map(([value]) => value).sort((a, b) => b - a)];
  return [0, ...values];
}

export function compareScores(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function bestHand(cards) {
  if (cards.length < 5 || cards.length > 7) throw new Error("需要 5 至 7 张牌才能判断牌型");
  let best = null;
  for (let a = 0; a < cards.length - 4; a += 1) {
    for (let b = a + 1; b < cards.length - 3; b += 1) {
      for (let c = b + 1; c < cards.length - 2; c += 1) {
        for (let d = c + 1; d < cards.length - 1; d += 1) {
          for (let e = d + 1; e < cards.length; e += 1) {
            const handCards = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const score = scoreFive(handCards);
            if (!best || compareScores(score, best.score) > 0) best = { score, cards: handCards };
          }
        }
      }
    }
  }
  return { ...best, name: HAND_NAMES[best.score[0]] };
}

export function createGame({ mode = "solo", names = ["你", "电脑"], startingStack = 1000, smallBlind = 10, bigBlind = 20 } = {}) {
  if (names.length !== 2) throw new Error("当前版本支持两名玩家");
  return {
    mode,
    players: names.map((name, id) => ({ id, name, stack: startingStack, hole: [], bet: 0, committed: 0, folded: false, allIn: false })),
    smallBlind,
    bigBlind,
    dealer: 1,
    handNumber: 0,
    phase: "complete",
    board: [],
    deck: [],
    currentBet: 0,
    minRaise: bigBlind,
    pending: [],
    turn: null,
    result: null,
    log: [],
  };
}

export function potSize(game) {
  return game.players.reduce((sum, player) => sum + player.committed, 0);
}

function pay(player, amount) {
  const paid = Math.min(player.stack, amount);
  player.stack -= paid;
  player.bet += paid;
  player.committed += paid;
  player.allIn = player.stack === 0;
  return paid;
}

function draw(game, count) {
  if (game.deck.length < count) throw new Error("牌堆数量不足");
  return game.deck.splice(0, count);
}

function log(game, message) {
  game.log.unshift(message);
  game.log = game.log.slice(0, 20);
}

export function startHand(game, deck = shuffledDeck()) {
  if (game.phase !== "complete") throw new Error("当前牌局尚未结束");
  if (game.players.some((player) => player.stack === 0)) throw new Error("有玩家筹码耗尽，请重新开始");
  const validCards = new Set(SUITS.flatMap((suit) => [...RANKS].map((rank) => `${rank}${suit}`)));
  if (new Set(deck).size !== 52 || deck.length !== 52 || deck.some((card) => !validCards.has(card))) {
    throw new Error("牌堆必须包含标准的 52 张不同扑克牌");
  }
  game.handNumber += 1;
  game.dealer = 1 - game.dealer;
  game.phase = "preflop";
  game.board = [];
  game.deck = [...deck];
  game.currentBet = 0;
  game.minRaise = game.bigBlind;
  game.pending = [];
  game.turn = null;
  game.result = null;
  game.log = [];
  game.players.forEach((player) => {
    player.hole = [];
    player.bet = 0;
    player.committed = 0;
    player.folded = false;
    player.allIn = false;
  });
  for (let i = 0; i < 2; i += 1) {
    game.players[game.dealer].hole.push(...draw(game, 1));
    game.players[1 - game.dealer].hole.push(...draw(game, 1));
  }
  const small = game.players[game.dealer];
  const big = game.players[1 - game.dealer];
  pay(small, game.smallBlind);
  pay(big, game.bigBlind);
  game.currentBet = Math.max(small.bet, big.bet);
  game.pending = [game.dealer, 1 - game.dealer].filter((id) => !game.players[id].allIn);
  game.turn = game.pending[0] ?? null;
  log(game, `第 ${game.handNumber} 局开始，盲注 ${game.smallBlind}/${game.bigBlind}`);
  advanceIfReady(game);
  return game;
}

export function legalActions(game) {
  if (game.phase === "complete" || game.turn === null) return null;
  const player = game.players[game.turn];
  const toCall = Math.max(0, game.currentBet - player.bet);
  const maxRaiseTo = player.bet + player.stack;
  const minRaiseTo = game.currentBet === 0 ? game.bigBlind : game.currentBet + game.minRaise;
  return {
    toCall,
    canCheck: toCall === 0,
    canCall: toCall > 0,
    canRaise: maxRaiseTo > game.currentBet && game.players[1 - game.turn].stack > 0,
    minRaiseTo,
    maxRaiseTo,
  };
}

function awardFold(game) {
  const winner = game.players.find((player) => !player.folded);
  const amount = potSize(game);
  winner.stack += amount;
  game.phase = "complete";
  game.turn = null;
  game.pending = [];
  game.result = { winners: [winner.id], message: `${winner.name} 获胜，赢得 ${amount} 筹码`, hands: null };
  log(game, game.result.message);
}

function showdown(game) {
  const [first, second] = game.players;
  const contested = Math.min(first.committed, second.committed);
  for (const player of game.players) {
    const refund = player.committed - contested;
    if (refund > 0) {
      player.stack += refund;
      player.committed -= refund;
      log(game, `${player.name} 收回未被跟注的 ${refund} 筹码`);
    }
  }
  const hands = game.players.map((player) => bestHand([...player.hole, ...game.board]));
  const comparison = compareScores(hands[0].score, hands[1].score);
  const pot = potSize(game);
  const winners = comparison === 0 ? [0, 1] : [comparison > 0 ? 0 : 1];
  if (winners.length === 1) {
    game.players[winners[0]].stack += pot;
  } else {
    const share = Math.floor(pot / 2);
    game.players[0].stack += share;
    game.players[1].stack += share;
    game.players[1 - game.dealer].stack += pot % 2;
  }
  game.phase = "complete";
  game.turn = null;
  game.pending = [];
  const message = winners.length === 1
    ? `${game.players[winners[0]].name} 以${hands[winners[0]].name}赢得 ${pot} 筹码`
    : `平局，双方各分得 ${Math.floor(pot / 2)} 筹码`;
  game.result = { winners, message, hands: hands.map((hand) => hand.name) };
  log(game, message);
}

function advanceIfReady(game) {
  if (game.phase === "complete") return;
  if (game.players.filter((player) => !player.folded).length === 1) {
    awardFold(game);
    return;
  }
  if (game.pending.length && game.players.every((player) => !player.allIn)) return;
  if (game.pending.length === 1) {
    const actor = game.players[game.pending[0]];
    if (game.currentBet > actor.bet) {
      game.turn = actor.id;
      return;
    }
  }
  while (game.phase !== "complete") {
    const phaseIndex = PHASES.indexOf(game.phase);
    if (phaseIndex === PHASES.length - 1) {
      showdown(game);
      return;
    }
    game.phase = PHASES[phaseIndex + 1];
    game.board.push(...draw(game, game.phase === "flop" ? 3 : 1));
    game.players.forEach((player) => { player.bet = 0; });
    game.currentBet = 0;
    game.minRaise = game.bigBlind;
    game.pending = [1 - game.dealer, game.dealer].filter((id) => !game.players[id].allIn);
    game.turn = game.pending[0] ?? null;
    log(game, `${PHASE_LABELS[game.phase]}：发出${game.phase === "flop" ? "三张" : "一张"}公共牌`);
    if (game.pending.length === 2) return;
  }
}

export function act(game, type, amount = 0) {
  const legal = legalActions(game);
  if (!legal) throw new Error("当前没有可操作的玩家");
  const player = game.players[game.turn];
  const opponent = game.players[1 - game.turn];
  if (type === "fold") {
    player.folded = true;
    log(game, `${player.name} 弃牌`);
  } else if (type === "check") {
    if (!legal.canCheck) throw new Error("当前必须跟注或弃牌");
    log(game, `${player.name} 过牌`);
  } else if (type === "call") {
    if (!legal.canCall) throw new Error("当前无需跟注");
    const paid = pay(player, legal.toCall);
    log(game, `${player.name} ${player.allIn ? "全下" : "跟注"} ${paid}`);
  } else if (type === "raise") {
    const target = Number(amount);
    if (!Number.isInteger(target) || !legal.canRaise || target <= game.currentBet || target > legal.maxRaiseTo) {
      throw new Error("加注金额无效");
    }
    if (target < legal.minRaiseTo && target !== legal.maxRaiseTo) throw new Error(`最少加注到 ${legal.minRaiseTo}`);
    pay(player, target - player.bet);
    const increase = target - game.currentBet;
    if (increase >= game.minRaise) game.minRaise = increase;
    game.currentBet = target;
    game.pending = opponent.allIn ? [] : [opponent.id];
    log(game, `${player.name} ${player.allIn ? "全下至" : "加注至"} ${target}`);
  } else {
    throw new Error("未知操作");
  }
  if (type !== "raise") game.pending = game.pending.filter((id) => id !== player.id);
  game.turn = game.pending[0] ?? null;
  advanceIfReady(game);
  return game;
}
