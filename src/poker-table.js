// Activity table: the server owns cards, money and turns; the browser limits NLHE betting.
import { roomEnding, roomEnded } from "./poker-session.js?v=20261003-room-lifecycle";
import { createPokerBettingRules, validPokerRaise } from "./poker-betting.js?v=20261003-tda";
export const PHASE_NAMES = { preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌", complete: "本局结束" };
// Clockwise visual order starts with the receiving player's seat at bottom center.
// Each capacity has its own balanced layout; unoccupied seats keep their places.
const SEAT_LAYOUTS = {
  2: [[50, 89], [50, 14]],
  3: [[50, 89], [13, 32], [87, 32]],
  4: [[50, 89], [11, 49], [50, 14], [89, 49]],
  5: [[50, 89], [11, 62], [27, 20], [73, 20], [89, 62]],
  6: [[50, 89], [11, 64], [18, 30], [50, 14], [82, 30], [89, 64]],
  7: [[50, 89], [11, 70], [11, 44], [34, 16], [66, 16], [89, 44], [89, 70]],
  8: [[50, 89], [11, 73], [11, 48], [25, 23], [50, 13], [75, 23], [89, 48], [89, 73]],
  9: [[50, 89], [11, 74], [11, 53], [11, 32], [34, 13], [66, 13], [89, 32], [89, 53], [89, 74]],
};
export const formatChips = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—";
const identity = (member) => member?.userId ?? member?.id;
export function seatIndex(player) {
  if (!player) return null;
  if (Object.hasOwn(player, "seatIndex")) return player.seatIndex ?? null;
  if (Object.hasOwn(player, "seat")) return player.seat ?? null;
  const storedSeat = Number(player.seatNo);
  return player.seatNo != null && Number.isInteger(storedSeat) && storedSeat > 0 ? storedSeat - 1 : null;
}
export function ownSeat(view) {
  if (view.self && (Object.hasOwn(view.self, "seatIndex") || Object.hasOwn(view.self, "seat") || Object.hasOwn(view.self, "seatNo")) && seatIndex(view.self) === null) return null;
  const explicit = seatIndex(view.self);
  if (explicit !== null) return Number(explicit);
  const id = identity(view.self);
  const member = (view.roomMembers || []).find((item) => id != null && String(identity(item)) === String(id));
  const seat = seatIndex(member);
  return seat === null ? null : Number(seat);
}
export function tableLayout(count, selfSeat = null) {
  const size = Math.min(9, Math.max(2, Math.floor(Number(count)) || 6));
  const anchor = Number.isInteger(selfSeat) && selfSeat >= 0 && selfSeat < size ? selfSeat : 0;
  return SEAT_LAYOUTS[size].map(([x, y], index) => ({ seatIndex: (index + anchor) % size, x, y }));
}
export function roomStarted(view) {
  return Boolean(view.game || view.room?.hasStarted || ["RUNNING", "PAUSED", "PAUSE_PENDING"].includes(view.room?.playState) || view.room?.status === "PLAYING");
}
export function handParticipant(view, member) {
  const id = identity(member), seat = seatIndex(member);
  return (view.game?.players || []).find(player => id != null && identity(player) != null
    ? String(identity(player)) === String(id) : seat !== null && Number(seatIndex(player)) === Number(seat));
}
export function waitingNextHand(view, member) {
  if (!roomStarted(view) || roomEnded(view) || seatIndex(member) === null) return false;
  if (view.game?.phase !== "complete" && handParticipant(view, member)) return false;
  return member?.participation === "WAITING_NEXT_HAND" || member?.state === "WAITING_NEXT_HAND"
    || Boolean(view.game && view.game.phase !== "complete" && !handParticipant(view, member));
}
export function needsChips(view, member) {
  if (!roomStarted(view) || roomEnded(view) || seatIndex(member) === null) return false;
  // A zero-stack player in the running hand may be ALL IN, still eligible to win.
  if (view.game && view.game.phase !== "complete" && handParticipant(view, member)) return false;
  return typeof member?.stack === "number" && Number.isFinite(member.stack) && member.stack <= 0;
}
export function eligiblePlayerCount(view) {
  const count = view.room?.nextHand?.eligiblePlayerCount;
  if (Number.isInteger(count) && count >= 0 && count <= 9) return count;
  if (!Array.isArray(view.roomMembers)) return null;
  const seated = view.roomMembers.filter(member => seatIndex(member) !== null && !["WATCHING", "STANDING"].includes(member.state));
  if (seated.some(member => typeof member.stack !== "number" || !Number.isFinite(member.stack))) return null;
  return new Set(seated.filter(member => member.stack > 0).map(member => Number(seatIndex(member)))).size;
}
export function memberStateText(view, member) {
  if (needsChips(view, member)) return "等待补筹码";
  if (waitingNextHand(view, member)) return "下局加入";
  if (seatIndex(member) === null) return "旁观中";
  if (roomStarted(view)) {
    const player = handParticipant(view, member);
    return view.game?.phase !== "complete" && player ? (player.folded ? "已弃牌" : "牌局中") : "等待下一手";
  }
  return playerReady(view, member) ? "已准备" : "已入座";
}
export function playerReady(view, member) {
  if (roomStarted(view)) return false;
  const mine = identity(member) != null && String(identity(member)) === String(identity(view.self))
    || seatIndex(member) !== null && ownSeat(view) !== null && Number(seatIndex(member)) === ownSeat(view);
  return member?.ready === true || member?.state === "READY" || (mine && (view.self?.ready === true || view.self?.roomState === "READY"));
}
export function buyInOptions(view) {
  const config = view.room?.buyIn;
  if (!config || !Number.isSafeInteger(config.minAmount) || !Number.isSafeInteger(config.maxAmount)
      || config.minAmount <= 0 || config.maxAmount < config.minAmount || !Number.isSafeInteger(config.step) || config.step <= 0) return [];
  const base = Number(view.room?.settings?.startingStack) || config.minAmount;
  const values = Array.isArray(config.options) ? config.options : [config.minAmount, base, base * 2, base * 5, config.maxAmount];
  return [...new Set(values.filter((amount) => Number.isSafeInteger(amount) && amount >= config.minAmount && amount <= config.maxAmount
    && (amount - config.minAmount) % config.step === 0))].sort((a, b) => a - b);
}
// Prefer authoritative hand roles; the fallback uses participants, not room capacity
// or bet amounts (which change after raises). Explicit null supports a dead button.
export function handPositions(game) {
  if (!game) return { dealer: null, smallBlindSeat: null, bigBlindSeat: null };
  const validSeat = (value) => value != null && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) < 9 ? Number(value) : null;
  const players = (game.players || []).map((player) => ({ ...player, seatIndex: validSeat(player.seatIndex ?? player.seat ?? player.id) }));
  const seats = [...new Set(players.map((player) => player.seatIndex).filter((seat) => seat !== null))].sort((a, b) => a - b);
  const taggedSeat = (position) => players.find((player) => String(player.position || "").toUpperCase() === position)?.seatIndex ?? null;
  const dealer = Object.hasOwn(game, "dealer") ? validSeat(game.dealer) : taggedSeat("BTN");
  const afterDealer = dealer === null ? [] : [...seats.filter((seat) => seat > dealer), ...seats.filter((seat) => seat <= dealer)];
  const smallBlindSeat = Object.hasOwn(game, "smallBlindSeat") ? validSeat(game.smallBlindSeat)
    : taggedSeat("SB") ?? (seats.length >= 2 && dealer !== null ? (seats.length === 2 && seats.includes(dealer) ? dealer : afterDealer[0]) : null);
  const bigBlindSeat = Object.hasOwn(game, "bigBlindSeat") ? validSeat(game.bigBlindSeat)
    : taggedSeat("BB") ?? (seats.length >= 2 && dealer !== null ? (seats.length === 2 ? afterDealer[0] : afterDealer[1]) : null);
  return { dealer, smallBlindSeat, bigBlindSeat };
}
// Positions belong to this hand's participants, including folded players, not to empty room seats.
export function seatPositions(game) {
  const labels = new Map();
  if (!game) return labels;
  const roles = handPositions(game);
  const players = game.players || [];
  const seats = [...new Set(players.map((p) => seatIndex(p)).filter((s) => s !== null).map(Number))].sort((a, b) => a - b);
  const earlyPositions = { 1: ["UTG"], 2: ["UTG", "CO"], 3: ["UTG", "HJ", "CO"],
    4: ["UTG", "UTG+1", "HJ", "CO"], 5: ["UTG", "UTG+1", "LJ", "HJ", "CO"],
    6: ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO"] };
  if (roles.bigBlindSeat !== null && roles.dealer !== null && roles.smallBlindSeat !== null) {
    const afterBlind = [...seats.filter((s) => s > roles.bigBlindSeat), ...seats.filter((s) => s <= roles.bigBlindSeat)];
    const early = afterBlind.filter((s) => !Object.values(roles).includes(s));
    early.forEach((s, i) => labels.set(s, earlyPositions[early.length]?.[i] || ""));
  }
  for (const player of players) {
    const supplied = String(player.position || "").toUpperCase();
    if (supplied && !["BTN", "D", "SB", "BB"].includes(supplied)) labels.set(Number(seatIndex(player)), supplied);
  }
  for (const s of seats) {
    const names = [];
    if (s === roles.dealer) names.push("庄位");
    if (s === roles.smallBlindSeat) names.push("小盲");
    if (s === roles.bigBlindSeat) names.push("大盲");
    if (names.length) labels.set(s, names.join("/"));
  }
  return labels;
}
export function raisePresets(game) {
  const legal = game?.legal;
  if (!legal?.canRaise || !Number.isFinite(legal.minRaiseTo) || !Number.isFinite(legal.maxRaiseTo)
      || legal.minRaiseTo > legal.maxRaiseTo) return [];
  const self = (game.players || []).find((p) => seatIndex(p) === game.turn);
  const bet = Number(self?.bet || 0), call = Number(legal.toCall || 0), pot = Number(game.pot || 0);
  const step = Number(legal.chipUnit) > 0 ? Number(legal.chipUnit) : 1;
  const presets = new Map();
  for (const ratio of [1.25, .75, .5, .33]) {
    const amount = Math.min(legal.maxRaiseTo,
      Math.max(legal.minRaiseTo, Math.ceil((bet + call + (pot + call) * ratio) / step) * step));
    const label = legal.shortAllInOnly ? "短码全下" : amount === legal.maxRaiseTo ? "最大加注" : amount === legal.minRaiseTo ? "最小加注" : "底池 " + Math.round(ratio * 100) + "%";
    if (!presets.has(amount)) presets.set(amount, { ratio, amount, label });
  }
  return [...presets.values()];
}
export function roomControls(view, now = Date.now()) {
  const own = ownSeat(view);
  const members = Array.isArray(view.roomMembers) ? view.roomMembers : view.game?.players || [];
  const seated = [...new Set(members.filter((member) => !["WATCHING", "STANDING"].includes(member.state))
    .map((member) => seatIndex(member)).filter((seat) => seat !== null && Number.isInteger(Number(seat)) && Number(seat) >= 0).map(Number))];
  const host = ["CREATOR", "HOST"].includes(view.self?.role) || view.self?.isHost === true;
  const inHand = Boolean(view.game && view.game.phase !== "complete");
  const playState = view.room?.playState || (view.room?.status === "PAUSED" ? "PAUSED" : inHand || view.room?.status === "PLAYING" ? "RUNNING" : "WAITING");
  const paused = playState === "PAUSED", pausePending = playState === "PAUSE_PENDING";
  const autoContinuing = playState === "RUNNING" && ["COUNTDOWN", "WAITING_PLAYERS"].includes(view.room?.nextHand?.status);
  const ending = roomEnding(view, now), closed = roomEnded(view);
  const allowed = Array.isArray(view.self?.allowedCommands) ? view.self.allowedCommands : [];
  // Older snapshots omit command capabilities. Java still validates the request.
  const canSit = !ending && own === null && (Array.isArray(view.self?.allowedCommands) ? allowed.includes("SIT_DOWN")
    : !inHand && view.room?.status !== "CLOSED" && !["ENDED", "CANCELLED"].includes(view.activity?.status));
  const member = members.find((member) => identity(member) != null && String(identity(member)) === String(identity(view.self)));
  const started = roomStarted(view);
  const ready = own !== null && playerReady(view, member || { ...view.self, state: view.self?.roomState });
  const readyCount = members.filter((m) => seatIndex(m) !== null && playerReady(view, m)).length;
  return { host, seatedCount: seated.length, readyCount, seated: own !== null, ready, started, inHand, paused, pausePending, autoContinuing, ending,
    canSit,
    canStand: !closed && own !== null && allowed.includes("STAND_UP"),
    canReady: !ending && !started && own !== null && !ready && allowed.includes("READY"),
    // Current Java accepts UNREADY but older view builders only advertise STAND_UP for ready players.
    // That permission confirms lobby participation; the server still validates cancellation atomically.
    canUnready: !ending && !started && own !== null && ready && view.room?.status !== "CLOSED"
      && !["ENDED", "CANCELLED"].includes(view.activity?.status)
      && (allowed.includes("UNREADY") || allowed.includes("STAND_UP")),
    canBuyIn: !ending && allowed.includes("BUY_IN") && buyInOptions(view).length > 0,
    canStart: !ending && !started && host && seated.length >= 2 && allowed.includes("START_HAND"),
    canPause: !ending && host && !paused && !pausePending && (inHand || playState === "RUNNING") && allowed.includes("PAUSE_GAME"),
    canResume: !ending && host && paused && !inHand && seated.length >= 2 && allowed.includes("RESUME_GAME"),
    canClose: !ending && host && allowed.includes("CLOSE_GAME"),
  };
}
export function memberAmounts(member) {
  const amount = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean"
    && Number.isFinite(Number(value)) ? Number(value) : null;
  const totalBuyIn = amount(member.totalBuyIn), stack = amount(member.stack);
  return { totalBuyIn, netChips: amount(member.netChips) ?? (totalBuyIn !== null && stack !== null ? stack - totalBuyIn : null) };
}
// Existing Java supplies winner seats and final pot. Never guess unequal side-pot splits.
export function handAwards(game) {
  if (game?.phase !== "complete") return [];
  const players = game.players || [], awards = new Map();
  const validSeat = (value) => value != null && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) < 9;
  for (const payout of Array.isArray(game.result?.payouts) ? game.result.payouts : []) {
    const player = payout.userId != null ? players.find((p) => String(identity(p)) === String(payout.userId))
      : players.find((p) => validSeat(payout.seatIndex) && Number(seatIndex(p)) === Number(payout.seatIndex));
    if (payout.userId != null && !player) continue;
    const seat = player ? seatIndex(player) : payout.seatIndex;
    if (!validSeat(seat) || !Number.isSafeInteger(payout.amount) || payout.amount <= 0) continue;
    const previous = awards.get(Number(seat));
    const amount = (previous?.amount || 0) + payout.amount;
    if (!Number.isSafeInteger(amount)) continue;
    awards.set(Number(seat), { seatIndex: Number(seat), userId: payout.userId ?? identity(player), nickname: player?.nickname || "玩家", amount });
  }
  for (const seat of Array.isArray(game.result?.winners) ? game.result.winners : []) {
    if (!validSeat(seat) || awards.has(Number(seat))) continue;
    const player = players.find((p) => Number(seatIndex(p)) === Number(seat));
    awards.set(Number(seat), { seatIndex: Number(seat), userId: identity(player), nickname: player?.nickname || "玩家", amount: null });
  }
  if (awards.size === 1 && !Array.isArray(game.result?.payouts) && Number.isSafeInteger(game.pot) && game.pot > 0) {
    awards.values().next().value.amount = game.pot;
  }
  return [...awards.values()];
}
export function nextHandState(view, now, fallbackDeadline = null) {
  const status = view.room?.nextHand?.status;
  if (view.game && view.room?.nextHand?.sourceHandId != null && String(view.room.nextHand.sourceHandId) !== String(view.game.handId)) return { visible: false };
  if (view.room?.status === "CLOSED" || ["ENDED", "CANCELLED"].includes(view.activity?.status)) return { visible: false };
  if (view.game && view.game.phase !== "complete") return { visible: false };
  if (roomEnding(view, now)) return { visible: true, text: view.room?.timing?.reason === "HOST_CLOSED" ? "房主已结束本场，等待结算" : "本场到时，等待结算" };
  if (view.room?.playState === "PAUSED" || view.room?.playState === "PAUSE_PENDING" || status === "PAUSED") return { visible: true, text: "游戏已暂停" };
  if (status === "WAITING_PLAYERS") {
    const count = eligiblePlayerCount(view);
    return { visible: true, waitingPlayers: true, eligiblePlayerCount: count,
      text: count === null ? "等待至少两名可参局玩家" : count < 2 ? "等待可参局玩家 · " + count + "/2" : "人数已满足，等待服务端发牌…" };
  }
  if (status === "COUNTDOWN") {
    const deadline = Date.parse(view.room.nextHand.startsAt);
    if (Number.isFinite(deadline)) {
      const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
      return { visible: true, seconds, text: seconds ? "下一手 · " + seconds + "s" : "正在等待服务端发牌…" };
    }
    return { visible: true, text: "正在同步下一手时间…" };
  }
  if (view.game?.phase !== "complete" || fallbackDeadline === null) return { visible: false };
  const seconds = Math.max(0, Math.ceil((fallbackDeadline - now) / 1000));
  return { visible: true, seconds, text: seconds ? "结算展示 · " + seconds + "s" : "等待服务端开启下一手" };
}
export function safeAvatar(url) {
  try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : null; }
  catch { return null; }
}
export function createPokerTable({ document, onAction, onCommand, onError = () => {}, onCountdown = () => {}, confirmStand = () => false, confirmClose = () => false }) {
  const $ = (id) => document.getElementById(id);
  const betting = createPokerBettingRules();
  let view = {}, game = null, connected = false, pending = false, pendingTimer = null;
  let lastHand = null, lastBoard = [], timer = null, deadline = null, currentTimer = null, currentSeconds = null, currentSeat = null;
  let lastLayoutKey = null, dealCleanupTimer = null;
  let activeHandSeen = null, lastPaidHand = null, payoutCleanupTimer = null, nextHandTimer = null;
  let fallbackHand = null, fallbackDeadline = null, serverOffset = 0;
  let avatarTargets = new Map();
  let playerStates = new Map(), foldEffects = new Map();
  let seatButtons = [], openSeats = new Set();
  let standConfirmOpen = false, closeConfirmOpen = false;
  let holeCardsHidden = false, selfCards = [], selectedProfile = null;
  let profiles = new Map();
  function currentLayout() {
    const layout = tableLayout(view.room?.settings?.maxSeats || Math.max(2, ...(game?.players || []).map((p) => p.seatIndex + 1)), ownSeat(view));
    // Lifted hole cards need a little clearance below the header at the top seats.
    return game ? layout.map(p => p.y < 25 ? { ...p, y: p.y + 2 } : p) : layout;
  }
  function resize() {
    const stage = $("table-stage");
    // Reserve caption space for positions and action status on short portrait screens.
    const statusLine = [...$("table-seats").children].some(el => /\b(folded|all-in|offline|waiting-chips)\b/.test(el.className)) ? 10 : 0;
    stage.style.setProperty("--seat-size", Math.max(24, Math.min(76, stage.clientWidth * .15, stage.clientHeight * .115 - (game ? 10 : 0) - statusLine)) + "px");
    const layout = currentLayout();
    for (const el of $("table-seats").children) {
      const place = layout.find((p) => String(p.seatIndex) === el.getAttribute("data-seat-index"));
      if (!place) continue;
      el.style.setProperty("--x", place.x + "%"); el.style.setProperty("--y", place.y + "%");
      el.classList.toggle("right", place.x > 50); el.classList.toggle("top", place.y <= 25); el.classList.toggle("bottom", place.y > 80);
    }
  }
  const node = (tag, className, value) => {
    const el = document.createElement(tag); el.className = className;
    if (value != null) el.textContent = String(value);
    return el;
  };
  function reportError(detail, awaitingReply = false) {
    $("table-notice").textContent = detail;
    onError(detail, awaitingReply);
  }
  function card(value, reveal = false, delay = 0) {
    const match = typeof value === "string" && value.match(/^([2-9TJQKA])([shdc])$/i);
    const el = node("span", "card" + (!match ? " back" : /[hd]/i.test(match[2]) ? " red" : "") + (reveal ? " revealing" : ""));
    el.style.setProperty("--delay", delay + "ms");
    if (match) {
      const rank = match[1].toUpperCase() === "T" ? "10" : match[1].toUpperCase();
      const suit = { s: "♠", h: "♥", d: "♦", c: "♣" }[match[2].toLowerCase()];
      el.append(node("span", "rank", rank), node("span", "suit", suit));
      el.setAttribute("aria-label", rank + suit);
    } else el.setAttribute("aria-label", "隐藏底牌");
    return el;
  }
  function ownCard(value, reveal, delay) {
    const el = card(value, reveal, delay);
    if (!/^[2-9TJQKA][shdc]$/i.test(value || "")) return el;
    const front = node("span", "hole-face hole-front");
    front.append(...el.children);
    const back = node("span", "hole-face hole-back", "♠");
    const inner = node("span", "hole-flip-inner"); inner.append(front, back); el.append(inner);
    el.className += " hole-flip";
    const entry = { el, front, back, label: el.getAttribute("aria-label") };
    selfCards.push(entry); updateOwnCard(entry);
    return el;
  }
  function updateOwnCard({ el, front, back, label }) {
    el.className = el.className.replace(/\s(?:is-hidden|back)\b/g, "") + (holeCardsHidden ? " is-hidden back" : "");
    el.setAttribute("aria-label", holeCardsHidden ? "隐藏底牌" : label);
    front.setAttribute("aria-hidden", String(holeCardsHidden));
    back.setAttribute("aria-hidden", String(!holeCardsHidden));
  }
  function closeProfile() {
    selectedProfile = null; $("player-profile").hidden = true;
    for (const { avatar } of profiles.values()) avatar.setAttribute("aria-expanded", "false");
  }
  function updateProfile() {
    const profile = profiles.get(selectedProfile);
    if (!profile) { closeProfile(); return; }
    const { name, avatarUrl, mine, place } = profile;
    const portrait = $("player-profile-avatar"); portrait.replaceChildren(node("span", "", [...name][0]));
    if (avatarUrl) {
      const img = node("img", ""); img.src = avatarUrl; img.alt = name + "的头像"; img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => img.remove()); portrait.append(img);
    }
    $("player-profile-name").textContent = name;
    $("player-profile-hint").hidden = !mine || !selfCards.length;
    $("player-profile-hint").textContent = holeCardsHidden ? "手牌已隐藏 · 再点头像翻开" : "手牌已翻开 · 再点头像隐藏";
    $("player-profile").style.setProperty("--profile-x", place.x + "%");
    $("player-profile").style.setProperty("--profile-y", (place.y > 50 ? place.y - 27 : place.y + 10) + "%");
    $("player-profile").hidden = false;
    for (const [key, { avatar }] of profiles) avatar.setAttribute("aria-expanded", String(key === selectedProfile));
  }
  function renderPotChips(amount) {
    const container = $("pot-chips"); container.replaceChildren();
    container.hidden = !(Number(amount) > 0);
    if (container.hidden) return;
    // Decorative stacks grow with the pot; the adjacent amount remains authoritative.
    const level = Math.min(12, Math.max(1, Math.ceil(Math.log2(1 + Number(amount) / Math.max(1, Number(view.room?.settings?.bigBlind) || 1)))));
    const stackCount = Math.min(3, Math.ceil(level / 4));
    for (let i = 0; i < stackCount; i++) {
      const stack = node("span", "pot-chip-stack");
      for (let j = 0; j < Math.min(4, level - i * 4); j++) {
        const chip = node("span", "chip pot-chip"); chip.style.setProperty("--chip-level", String(j)); stack.append(chip);
      }
      container.append(stack);
    }
  }
  function act(action, amount) {
    if (!canAct()) return;
    const legal = game.legal;
    if (action === "check" && !legal.canCheck || action === "call" && !legal.canCall || action === "fold" && legal.canFold === false) return;
    if (action === "raise" && !validPokerRaise(legal, amount)) {
      reportError(legal.raiseReason || (legal.shortAllInOnly ? "筹码不足完整加注，只能全下至 " : "最小加注至 ") + formatChips(legal.minRaiseTo));
      return;
    }
    pending = true; updateActions();
    $("table-notice").textContent = "正在提交操作…";
    $("raise-editor").hidden = true; $("raise-toggle").setAttribute("aria-expanded", "false");
    pendingTimer = setTimeout(() => { pending = false; connected = false; updateActions(); reportError("操作尚未确认，请重新连接以同步牌局。", true); }, 10000);
    onAction(action, amount);
  }
  function canAct() {
    const seat = ownSeat(view);
    const participant = handParticipant(view, { ...view.self, seatIndex: seat });
    return connected && !pending && !roomEnded(view) && !roomControls(view, Date.now() + serverOffset).paused && participant && !participant.folded && game?.legal && seat !== null && seat === game.turn && game.phase !== "complete";
  }
  function chooseRaise(amount) {
    if (!canAct() || !game.legal.canRaise) return;
    const input = $("raise-range");
    input.min = game.legal.minRaiseTo; input.max = game.legal.maxRaiseTo; input.step = game.legal.chipUnit || 1;
    if (!Number.isFinite(amount)) amount = game.legal.minRaiseTo;
    amount = Math.min(game.legal.maxRaiseTo, Math.max(game.legal.minRaiseTo,
      amount === game.legal.maxRaiseTo ? amount : Math.ceil(amount / input.step) * input.step));
    input.value = amount;
    $("raise-value").textContent = formatChips(amount);
    for (const button of $("raise-presets").children) button.setAttribute("aria-pressed", String(Number(button.getAttribute("data-raise-amount")) === Number(amount)));
  }
  function updateActions() {
    const enabled = Boolean(canAct()), legal = game?.legal || {};
    $("fold-action").disabled = !enabled || legal.canFold === false;
    $("call-action").disabled = !enabled || !(legal.canCheck || legal.canCall);
    $("call-action").replaceChildren(node("span", "", legal.canCheck ? "过牌" : "跟注"));
    if (!legal.canCheck && legal.canCall) $("call-action").append(node("b", "", formatChips(legal.toCall)));
    $("raise-toggle").disabled = !enabled || !legal.canRaise;
    $("raise-toggle").setAttribute("title", legal.raiseReason || "选择加注金额");
    for (const id of ["raise-range", "all-in-action", "confirm-raise"]) $(id).disabled = !enabled || !legal.canRaise;
    if (!enabled || !legal.canRaise) { $("raise-editor").hidden = true; $("raise-toggle").setAttribute("aria-expanded", "false"); }
    else if (!$("raise-editor").hidden) chooseRaise(Number($("raise-range").value));
    if (enabled && legal.raiseReason) $("table-notice").textContent = legal.raiseReason;
    const presets = $("raise-presets"); presets.replaceChildren();
    const options = enabled ? raisePresets(game) : [];
    presets.style.setProperty("--preset-count", String(Math.max(1, options.length)));
    for (const { label: description, amount } of options) {
      const button = node("button", ""); button.type = "button";
      const label = node("span", "", "加注"); label.append(node("b", "", formatChips(amount)));
      button.append(label, node("small", "", description));
      button.setAttribute("data-raise-amount", String(amount)); button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => chooseRaise(amount)); presets.append(button);
    }
    const controls = roomControls(view, Date.now() + serverOffset), enabledControl = connected && !pending;
    const eligibleCount = eligiblePlayerCount(view);
    for (const button of seatButtons) {
      // Keep unavailable seats clickable to explain why sitting is not possible.
      button.disabled = pending || roomEnded(view);
      button.setAttribute("aria-disabled", String(!enabledControl || !controls.canSit));
      button.setAttribute("title", controls.seated ? "请先从菜单起身再选择其他座位" : "点击落座");
    }
    $("host-controls").hidden = !controls.host;
    $("player-controls").hidden = !controls.seated;
    $("stand-up").hidden = !controls.seated;
    $("stand-up").disabled = !enabledControl || !controls.canStand;
    $("stand-detail").hidden = !controls.seated || !controls.inHand;
    $("stand-detail").textContent = controls.canStand ? "起身将立即放弃本手，已下注筹码留在底池，随后转为旁观。" : "服务端尚未授权本手起身，需要支持起身时立即弃牌。";
    $("ready-player").hidden = !controls.canReady;
    $("ready-player").disabled = !enabledControl || !controls.canReady;
    $("unready-player").hidden = !controls.ready;
    $("unready-player").disabled = !enabledControl || !controls.canUnready;
    $("ready-detail").hidden = !controls.ready || controls.canUnready;
    $("ready-detail").textContent = "已准备，当前房间暂不支持取消准备。";
    const ownMember = (view.roomMembers || []).find((member) => identity(member) != null && String(identity(member)) === String(identity(view.self)));
    const handPlayer = game?.phase !== "complete" ? game?.players?.find((p) => p.seatIndex === ownSeat(view)) : null;
    const pendingBuyIn = Number(view.self?.pendingBuyIn ?? ownMember?.pendingBuyIn ?? 0);
    $("buy-in-balance").textContent = "当前筹码 " + formatChips(handPlayer?.stack ?? ownMember?.stack ?? view.self?.stack ?? 0)
      + (pendingBuyIn > 0 ? " · 待到账 +" + formatChips(pendingBuyIn) : "");
    const amounts = buyInOptions(view), select = $("buy-in-amount"), chosen = Number(select.value);
    select.replaceChildren(...amounts.map((amount) => { const option = node("option", "", formatChips(amount)); option.value = String(amount); return option; }));
    select.value = String(amounts.includes(chosen) ? chosen : amounts[0] ?? "");
    select.disabled = !enabledControl || !controls.canBuyIn;
    $("submit-buy-in").disabled = !enabledControl || !controls.canBuyIn;
    $("buy-in-detail").textContent = !controls.canBuyIn ? "当前房间暂未开放带入筹码。"
      : pendingBuyIn > 0 ? "带入已确认，本局结算后到账。可继续追加。"
      : controls.inHand ? "本局中追加的筹码将在本局结束后到账。"
      : view.room?.nextHand?.status === "WAITING_PLAYERS" ? "追加确认后立即到账，补足筹码后自动参局，无需重新准备。" : "追加筹码将在确认后立即到账。";
    $("start-hand").hidden = !controls.host || controls.started;
    $("start-hand").disabled = !enabledControl || !controls.canStart;
    $("pause-game").hidden = !controls.host || controls.paused;
    $("pause-game").disabled = !enabledControl || !controls.canPause;
    $("pause-game").textContent = controls.pausePending ? "已申请本局结束后暂停" : "暂停游戏（本局结束后生效）";
    $("resume-game").hidden = !controls.host || !controls.paused;
    $("resume-game").disabled = !enabledControl || !controls.canResume;
    $("close-game").hidden = !controls.host;
    $("close-game").disabled = !enabledControl || !controls.canClose;
    $("close-game-detail").hidden = !controls.host;
    $("close-game-detail").textContent = controls.ending ? "本场已申请结束，当前手牌结算后进入最终结算。"
      : controls.canClose ? "关闭后不再发下一手，当前手牌结算后进入最终结算。" : "服务端尚未开放关闭游戏。";
    $("host-control-detail").textContent = controls.pausePending ? "当前这手继续进行，结算完成后暂停，不再发下一手。"
      : controls.paused ? (controls.seatedCount < 2 ? "游戏已暂停，至少 2 人落座后可继续。" : "游戏已暂停，继续后恢复发牌。")
      : controls.started && view.room?.nextHand?.status === "WAITING_PLAYERS" ? (eligibleCount !== null && eligibleCount >= 2
        ? "人数已满足，等待服务端发牌，无需重新开始。" : "有可用筹码的在座玩家不足 2 人时等待；人数恢复后由服务端自动开局，无需准备或再次开始。")
      : controls.seatedCount < 2 ? "至少需要 2 人落座，目前 " + controls.seatedCount + " 人。"
      : controls.inHand ? (controls.canPause ? "牌局进行中，暂停会在本局结束后生效。" : "牌局进行中，服务端尚未授权暂停游戏。")
      : controls.started ? "游戏已开始，每手结束后自动继续，无需重新准备或开始。" : controls.canStart ? "已有 " + controls.seatedCount + " 人落座，可以开始游戏。" : "已落座 " + controls.seatedCount + " 人，已准备 " + controls.readyCount + " 人，等待开局条件满足。";
    $("play-state-notice").hidden = roomEnded(view) || !controls.paused && !controls.pausePending;
    $("play-state-notice").textContent = controls.paused ? "游戏已暂停 · 等待房主继续" : "房主已申请暂停 · 本局结束后生效";
  }
  function command(type, payload = {}) {
    if (pending) { reportError("正在处理上一项操作，请稍候…"); return; }
    if (!connected) { $("table-notice").textContent = "牌桌连接尚未就绪，请稍候或在菜单中重新连接。"; return; }
    const controls = roomControls(view, Date.now() + serverOffset);
    const permission = { SIT_DOWN: controls.canSit && openSeats.has(payload.seatIndex), READY: controls.canReady,
      UNREADY: controls.canUnready, BUY_IN: controls.canBuyIn && buyInOptions(view).includes(payload.amount),
      STAND_UP: controls.canStand, START_HAND: controls.canStart, PAUSE_GAME: controls.canPause, RESUME_GAME: controls.canResume, CLOSE_GAME: controls.canClose };
    if (!permission[type]) {
      if (type === "SIT_DOWN") reportError(controls.seated ? "你已落座，请先在菜单中确认起身。"
        : !openSeats.has(payload.seatIndex) ? "该座位已有人入座，请选择其他空座。"
        : controls.inHand ? "本局正在进行，请等本局结束后落座。" : "房间暂不允许落座，请稍后重新检查房间。");
      return;
    }
    pending = true; updateActions();
    $("table-notice").textContent = type === "SIT_DOWN" ? (Number(view.room?.settings?.seatingType) === 0 ? "正在随机落座…" : "正在落座…") : type === "PAUSE_GAME" ? "正在申请本局结束后暂停…" : "正在提交操作…";
    pendingTimer = setTimeout(() => { pending = false; connected = false; updateActions(); reportError("操作尚未确认，请重新连接以同步房间。", true); }, 10000);
    // Current Java rejects extra lifecycle fields. Revision belongs to ACTION only.
    const commandPayload = type === "SIT_DOWN" && Number(view.room?.settings?.seatingType) === 0 ? {} : payload;
    onCommand(type, commandPayload);
  }

  function updateClock() {
    if (!currentTimer || !Number.isFinite(deadline)) return;
    const seconds = Math.max(0, Math.ceil((deadline - Date.now() - serverOffset) / 1000));
    currentTimer.style.setProperty("--time", Math.min(100, seconds / (view.room?.settings?.turnSeconds || 30) * 100) + "%");
    currentSeconds.textContent = seconds + "s";
    currentSeat.setAttribute("data-urgent", String(seconds <= 10));
    onCountdown("turn", [game?.handId ?? game?.handNumber, game?.turn, game?.turnDeadline].join(":"), seconds, connected && canAct());
    if (!seconds) { connected = false; updateActions(); $("table-notice").textContent = "行动时间已到，等待服务端更新…"; }
  }
  function updateNextHandClock() {
    const state = nextHandState(view, Date.now() + serverOffset, fallbackDeadline);
    $("next-hand-countdown").hidden = !state.visible;
    $("next-hand-countdown").textContent = state.text || "";
    $("next-hand-countdown").setAttribute("data-seconds", state.seconds == null ? "" : String(state.seconds));
    onCountdown("nextHand", view.room?.nextHand?.startsAt, state.seconds,
      connected && view.room?.nextHand?.status === "COUNTDOWN" && !roomEnded(view));
  }
  function render(nextView) {
    view = nextView; game = view.game || null; pending = false; clearTimeout(pendingTimer);
    const settings = view.room?.settings || {};
    const selfSeat = ownSeat(view);
    // `id` in the old two-player protocol is a seat; activity protocol uses explicit seatIndex.
    const players = (game?.players || []).map((p) => ({ ...p, seatIndex: Number(seatIndex(p) ?? p.id) }));
    if (game) {
      game = { ...game, players, turn: game.turn == null ? null : Number(game.turn), ...handPositions({ ...game, players }) };
      betting.observe({ ...view, game });
      game = { ...game, legal: betting.legal(game) };
    } else betting.observe(view);
    const members = view.roomMembers || [];
    const eligibleCount = eligiblePlayerCount(view);
    const handKey = game?.handId ?? game?.handNumber ?? null;
    const newHand = handKey !== null && handKey !== lastHand;
    if (!game || newHand || selfSeat === null) holeCardsHidden = false;
    selfCards = []; profiles = new Map();
    if (!game || newHand) { playerStates = new Map(); foldEffects = new Map(); }
    const nextPlayerStates = new Map();
    const serverTime = Date.parse(view.serverTime || "");
    serverOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
    const awards = handAwards(game);
    if (game && game.phase !== "complete") activeHandSeen = handKey;
    if (game?.phase === "complete" && handKey !== fallbackHand) {
      fallbackHand = handKey;
      const settledAt = Date.parse(game.result?.settledAt || "");
      fallbackDeadline = (Number.isFinite(settledAt) ? settledAt : Date.now() + serverOffset) + 10000;
    }
    if (!game || game.phase !== "complete") { fallbackHand = null; fallbackDeadline = null; }
    const layout = currentLayout();
    const roles = handPositions(game);
    const positions = seatPositions(game);
    const layoutKey = layout.length + ":" + selfSeat;
    if (layoutKey !== lastLayoutKey) {
      clearTimeout(dealCleanupTimer); $("deal-layer").replaceChildren(); lastLayoutKey = layoutKey;
      clearTimeout(payoutCleanupTimer); $("payout-layer").replaceChildren();
    }
    if (game?.phase === "complete") { clearTimeout(dealCleanupTimer); $("deal-layer").replaceChildren(); }
    if (!game || newHand || game.phase !== "complete") { clearTimeout(payoutCleanupTimer); $("payout-layer").replaceChildren(); }
    $("table-stage").setAttribute("data-seat-count", String(layout.length));
    const seats = $("table-seats"); seats.replaceChildren();
    seatButtons = []; openSeats = new Set();
    avatarTargets = new Map();
    currentTimer = null; currentSeconds = null; currentSeat = null;
    for (const place of layout) {
      const player = players.find((p) => p.seatIndex === place.seatIndex);
      const member = members.find((m) => Number(seatIndex(m)) === place.seatIndex && seatIndex(m) !== null);
      const person = game?.phase === "complete" ? (Array.isArray(view.roomMembers) ? member : player) : player || member;
      const chipWait = person && needsChips(view, member || person);
      const sameParticipant = !person || !player || identity(person) == null || identity(player) == null || String(identity(person)) === String(identity(player));
      const playerKey = String(identity(player) ?? place.seatIndex);
      const previous = playerStates.get(playerKey);
      const folded = Boolean(player?.folded);
      const allIn = !folded && Boolean(player?.allInCommitted || player?.allIn || previous?.allIn);
      if (player) {
        nextPlayerStates.set(playerKey, { folded, allIn });
        if (folded && previous && !previous.folded) foldEffects.set(playerKey, Date.now());
      }
      const folding = sameParticipant && folded && foldEffects.has(playerKey) && Date.now() - foldEffects.get(playerKey) < 700;
      const mine = selfSeat === place.seatIndex;
      const current = game?.turn === place.seatIndex && game?.phase !== "complete";
      const award = person && awards.find((item) => item.seatIndex === place.seatIndex
        && (item.userId == null || identity(person) == null || String(item.userId) === String(identity(person))));
      const el = node(person ? "div" : "button", "seat" + (!person ? " empty" : "") + (mine ? " self" : "")
        + (award ? " winner" : "")
        + (current ? " current" : "") + (person && sameParticipant && folded ? " folded" : "")
        + (person && sameParticipant && allIn && !chipWait ? " all-in" : "") + (chipWait ? " waiting-chips" : "") + (folding && person ? " folding" : "") + (person?.online === false ? " offline" : "")
        + (place.x > 50 ? " right" : "") + (place.y <= 25 ? " top" : "") + (place.y > 85 ? " bottom" : ""));
      el.setAttribute("data-seat-index", String(place.seatIndex));
      if (folding) el.style.setProperty("--fold-delay", -(Date.now() - foldEffects.get(playerKey)) + "ms");
      if (!person) {
        el.type = "button"; el.setAttribute("aria-label", "空座，点击落座");
        el.addEventListener("click", () => command("SIT_DOWN", { seatIndex: place.seatIndex }));
        seatButtons.push(el); openSeats.add(place.seatIndex);
      }
      el.style.setProperty("--x", place.x + "%"); el.style.setProperty("--y", place.y + "%"); el.style.setProperty("--hue", String((place.seatIndex * 59 + 220) % 360));
      const name = person?.nickname || person?.name || member?.nickname || (mine ? view.self?.nickname : null) || "玩家";
      const avatar = node(person ? "button" : "div", "seat-avatar"); avatar.append(node("span", "avatar-monogram", person ? [...name][0] : "+"));
      if (award) avatarTargets.set(place.seatIndex, avatar);
      const avatarUrl = safeAvatar(person?.avatarUrl || member?.avatarUrl || (mine ? view.self?.avatarUrl : null));
      if (avatarUrl) { const img = node("img", ""); img.src = avatarUrl; img.alt = ""; img.referrerPolicy = "no-referrer"; img.addEventListener("error", () => img.remove()); avatar.append(img); }
      if (person) {
        const key = String(identity(person) ?? "seat:" + place.seatIndex);
        avatar.type = "button"; avatar.setAttribute("aria-label", "查看" + name + "的头像和昵称" + (mine && player?.hole?.length ? "，切换手牌显示" : ""));
        avatar.setAttribute("aria-controls", "player-profile"); avatar.setAttribute("aria-expanded", "false");
        profiles.set(key, { avatar, name, avatarUrl, mine, place });
        avatar.addEventListener("click", () => {
          if (mine && selfCards.length) {
            holeCardsHidden = !holeCardsHidden; selfCards.forEach(updateOwnCard);
          }
          selectedProfile = key; updateProfile();
        });
      }
      const label = node("div", "seat-label");
      const position = person ? positions.get(place.seatIndex) : null;
      if (position) label.append(node("span", "seat-position", position));
      label.append(node("span", "seat-name", person ? name : "空座"));
      if (person) label.append(node("strong", "seat-stack", formatChips(person.stack)));
      if (person && (chipWait || sameParticipant && (folded || allIn) || person.online === false)) {
        const state = node("span", "seat-state", chipWait ? "等待补筹码" : sameParticipant && folded ? "已弃牌" : sameParticipant && allIn ? "ALL IN" : "离线");
        state.setAttribute("role", "status"); label.append(state);
      }
      const markers = node("div", "seat-markers");
      for (const [role, seat, title] of [["D", roles.dealer, "庄位"], ["SB", roles.smallBlindSeat, "小盲"], ["BB", roles.bigBlindSeat, "大盲"]]) {
        if (seat !== place.seatIndex) continue;
        const badge = node("span", "seat-marker " + (role === "D" ? "dealer-button" : role === "SB" ? "small-blind-marker" : "big-blind-marker"), role);
        badge.setAttribute("title", title); badge.setAttribute("aria-label", title); markers.append(badge);
      }
      if (markers.children.length) {
        label.className += " has-markers" + (markers.children.length > 1 ? " dual-markers" : ""); label.append(markers);
      }
      el.append(avatar);
      if (award) {
        const badge = node("span", "seat-win", award.amount === null ? "获胜" : "获胜 +" + formatChips(award.amount));
        badge.setAttribute("title", name + " " + badge.textContent); el.append(badge);
      }
      if (person && playerReady(view, member || person)) el.append(node("span", "seat-readiness", "已准备"));
      if (person && !chipWait && waitingNextHand(view, member || person)) el.append(node("span", "seat-next-hand", "下局加入"));
      if (person && player?.hole?.length && (game.phase !== "complete" || sameParticipant)) {
        const hole = node("div", "hole-cards");
        hole.setAttribute("data-compact", String(!mine && game.phase !== "complete"));
        // Folded opponents stay private even if a malformed snapshot contains their cards.
        const visible = mine || (game.phase === "complete" && Boolean(game.result?.hands) && !folded);
        player.hole.slice(0, 2).forEach((value, i) => hole.append(mine
          ? ownCard(value, newHand, i * 130 + place.seatIndex * 60)
          : card(visible ? value : null, newHand, i * 130 + place.seatIndex * 60)));
        el.append(hole);
      }
      el.append(label);
      if (person && sameParticipant && game?.phase !== "complete" && Number(player?.bet) > 0) {
        const bet = node("div", "seat-bet"); bet.setAttribute("aria-label", "本轮下注 " + formatChips(player.bet));
        bet.append(node("span", "chip"), node("span", "", formatChips(player.bet))); el.append(bet);
      }
      if (current) { const bar = node("div", "turn-timer"), progress = node("span", ""); bar.append(progress); el.append(bar); currentTimer = progress; currentSeconds = node("span", "turn-seconds"); el.append(currentSeconds); currentSeat = el; }
      seats.append(el);
    }
    playerStates = nextPlayerStates;
    updateProfile();
    const board = $("board-cards"); board.replaceChildren();
    const cards = (game?.board || []).slice(0, 5);
    for (let i = 0; i < 5; i++) {
      if (cards[i]) board.append(card(cards[i], newHand || cards[i] !== lastBoard[i], i * 90));
      else { const placeholder = node("span", "card placeholder"); placeholder.setAttribute("aria-hidden", "true"); board.append(placeholder); }
    }
    $("table-blinds").textContent = "NLHE " + formatChips(settings.smallBlind) + " / " + formatChips(settings.bigBlind);
    $("table-pot").textContent = formatChips(game?.pot ?? 0);
    renderPotChips(game?.pot ?? 0);
    $("pot-label").textContent = awards.length ? "已分配底池" : "底池";
    $("table-phase").textContent = game ? "第 " + (game.handNumber ?? "—") + " 手 · " + (PHASE_NAMES[game.phase] || "牌局进行中") : "等待开局";
    $("table-result").textContent = awards.length ? awards.map((award) => award.nickname + (award.amount === null ? "" : " +" + formatChips(award.amount))).join("、") + " 获胜" : game?.result?.message || "";
    $("table-result").setAttribute("title", $("table-result").textContent);
    $("table-notice").textContent = !connected ? "正在同步牌局…" : roomControls(view, Date.now() + serverOffset).paused ? "游戏已暂停，等待房主继续"
      : !game ? (selfSeat === null ? (Number(settings.seatingType) === 0 ? "点击任意空座随机落座，由房主开始游戏" : "点击虚线空座落座，由房主开始游戏") : "已入座，等待房主开始游戏")
      : game.phase === "complete" && view.room?.nextHand?.status === "WAITING_PLAYERS"
        ? (selfSeat !== null && needsChips(view, (members.find(member => Number(seatIndex(member)) === selfSeat && seatIndex(member) !== null) || { ...view.self, seatIndex: selfSeat }))
          ? "筹码为零，请在菜单补充筹码；到账后自动参局"
          : eligibleCount !== null && eligibleCount >= 2 ? "人数已满足，等待服务端发牌…" : "等待可参局玩家，补筹码或新玩家落座后由服务端自动开局")
      : selfSeat === null ? "你正在旁观本场牌局" : waitingNextHand(view, { ...view.self, seatIndex: selfSeat }) ? "已落座 · 下局加入，本手结束后自动参局"
      : canAct() ? "轮到你行动" : game.phase === "complete" ? "本局结束，等待下一手" : "等待其他玩家行动";
    deadline = Date.parse(game?.turnDeadline || "");
    if (currentSeconds) currentSeconds.hidden = !Number.isFinite(deadline);
    clearInterval(timer); updateClock();
    if (currentTimer && Number.isFinite(deadline)) timer = setInterval(updateClock, 1000);
    if (newHand && game?.phase !== "complete") animateDeal(layout.filter((p) => players.find((player) => player.seatIndex === p.seatIndex && player.hole?.length)));
    lastHand = handKey; lastBoard = [...cards]; updateActions(); resize();
    clearInterval(nextHandTimer); updateNextHandClock();
    if (game?.phase === "complete" || view.room?.nextHand?.status === "COUNTDOWN") nextHandTimer = setInterval(updateNextHandClock, 250);
    if (game?.phase === "complete" && handKey !== null && activeHandSeen === handKey && lastPaidHand !== handKey && awards.length) {
      lastPaidHand = handKey; animatePayout(awards);
    }
  }
  function animatePayout(awards) {
    clearTimeout(payoutCleanupTimer);
    const layer = $("payout-layer"); layer.replaceChildren();
    const stage = $("table-stage").getBoundingClientRect(), pot = $("table-pot").getBoundingClientRect();
    const startX = pot.left + pot.width / 2 - stage.left, startY = pot.top + pot.height / 2 - stage.top;
    awards.forEach((award, winnerIndex) => {
      const avatar = avatarTargets.get(award.seatIndex);
      if (!avatar) return;
      const target = avatar.getBoundingClientRect();
      for (let i = 0; i < 6; i++) {
        const chip = node("span", "payout-chip chip");
        chip.setAttribute("data-winner-seat", String(award.seatIndex));
        chip.style.setProperty("--start-x", startX + "px"); chip.style.setProperty("--start-y", startY + "px");
        chip.style.setProperty("--dx", target.left + target.width / 2 - stage.left - startX + "px");
        chip.style.setProperty("--dy", target.top + target.height / 2 - stage.top - startY + "px");
        chip.style.setProperty("--delay", winnerIndex * 90 + i * 65 + "ms");
        chip.addEventListener("animationend", () => chip.remove()); layer.append(chip);
      }
    });
    payoutCleanupTimer = setTimeout(() => layer.replaceChildren(), 2400);
  }
  function animateDeal(layout) {
    clearTimeout(dealCleanupTimer);
    const layer = $("deal-layer"); layer.replaceChildren();
    const stage = $("table-stage");
    for (let round = 0; round < 2; round++) layout.forEach((place, index) => {
      const el = node("span", "flying-card");
      el.style.setProperty("--dx", ((place.x - 50) / 100 * stage.clientWidth) + "px");
      el.style.setProperty("--dy", ((place.y - 44) / 100 * stage.clientHeight - 30) + "px");
      el.style.setProperty("--rotation", (round === 0 ? -12 : 10) + "deg");
      el.style.setProperty("--delay", (round * layout.length + index) * 85 + "ms");
      el.addEventListener("animationend", () => el.remove()); layer.append(el);
    });
    dealCleanupTimer = setTimeout(() => layer.replaceChildren(), 2500);
  }
  $("fold-action").addEventListener("click", () => act("fold"));
  $("close-player-profile").addEventListener("click", closeProfile);
  $("table-stage").addEventListener("click", (event) => {
    if (!event.target.closest(".seat-avatar, #player-profile")) closeProfile();
  });
  $("table-stage").addEventListener("keydown", (event) => { if (event.key === "Escape") closeProfile(); });
  $("call-action").addEventListener("click", () => act(game?.legal?.canCheck ? "check" : "call"));
  $("raise-toggle").addEventListener("click", () => {
    if (!canAct() || !game.legal.canRaise) return;
    chooseRaise(game.legal.minRaiseTo);
    $("raise-limits").textContent = game.legal.shortAllInOnly
      ? "完整加注至少至 " + formatChips(game.legal.minimumFullRaiseTo) + "，当前只能短码全下至 " + formatChips(game.legal.maxRaiseTo)
      : "可加注 " + formatChips(game.legal.minRaiseTo) + " – " + formatChips(game.legal.maxRaiseTo);
    $("raise-editor").hidden = !$("raise-editor").hidden;
    $("raise-toggle").setAttribute("aria-expanded", String(!$("raise-editor").hidden));
  });
  $("close-raise").addEventListener("click", () => { $("raise-editor").hidden = true; $("raise-toggle").setAttribute("aria-expanded", "false"); });
  $("raise-range").addEventListener("input", () => chooseRaise(Number($("raise-range").value)));
  $("raise-editor").addEventListener("submit", (event) => { event.preventDefault(); act("raise", Number($("raise-range").value)); });
  $("all-in-action").addEventListener("click", () => chooseRaise(game?.legal?.maxRaiseTo));
  $("stand-up").addEventListener("click", async () => {
    if (!connected || pending || standConfirmOpen || !roomControls(view, Date.now() + serverOffset).canStand) return;
    standConfirmOpen = true;
    const abandoningHand = Boolean(game && game.phase !== "complete" && handParticipant(view, { ...view.self, seatIndex: ownSeat(view) }));
    const confirmedHand = game?.phase !== "complete" ? game?.handId ?? game?.handNumber : null;
    try {
      if (!await confirmStand({ abandoningHand }) || !connected || pending || !roomControls(view, Date.now() + serverOffset).canStand) return;
      const currentHand = game?.phase !== "complete" ? game?.handId ?? game?.handNumber : null;
      if (currentHand !== confirmedHand) { reportError("牌局已变化，请重新确认起身。"); return; }
      command("STAND_UP");
    }
    finally { standConfirmOpen = false; }
  });
  $("close-game").addEventListener("click", async () => {
    if (!connected || pending || closeConfirmOpen || !roomControls(view, Date.now() + serverOffset).canClose) return;
    closeConfirmOpen = true;
    try { if (await confirmClose() && connected && !pending && roomControls(view, Date.now() + serverOffset).canClose) command("CLOSE_GAME", { afterCurrentHand: true }); }
    finally { closeConfirmOpen = false; }
  });
  for (const [id, type] of [["ready-player", "READY"], ["unready-player", "UNREADY"], ["start-hand", "START_HAND"], ["pause-game", "PAUSE_GAME"], ["resume-game", "RESUME_GAME"]]) {
    $(id).addEventListener("click", () => command(type, type === "PAUSE_GAME" ? { afterCurrentHand: true } : {}));
  }
  $("buy-in-form").addEventListener("submit", (event) => { event.preventDefault(); command("BUY_IN", { amount: Number($("buy-in-amount").value) }); });

  return {
    render,
    resize,
    updateControls: updateActions,
    setConnected(value, notice) { connected = value; updateActions(); if (notice) $("table-notice").textContent = notice; },
    reject(message) { clearTimeout(pendingTimer); pending = false; updateActions(); $("table-notice").textContent = message; },
    reset() { clearInterval(timer); clearInterval(nextHandTimer); clearTimeout(pendingTimer); clearTimeout(dealCleanupTimer); clearTimeout(payoutCleanupTimer);
      betting.reset();
      holeCardsHidden = false; selfCards = []; closeProfile();
      $("deal-layer").replaceChildren(); $("payout-layer").replaceChildren(); $("next-hand-countdown").hidden = true;
      lastLayoutKey = null; lastHand = null; lastBoard = []; activeHandSeen = null; lastPaidHand = null; fallbackHand = null; fallbackDeadline = null;
      connected = false; pending = false; updateActions(); },
  };
}
