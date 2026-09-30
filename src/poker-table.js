// Activity table: the server owns cards, money, turns and legal actions.
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
export function playerReady(view, member) {
  if (view.game && view.game.phase !== "complete") return false;
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
  return [1.25, .75, .5, .33].map((ratio) => ({ ratio, amount: Math.min(legal.maxRaiseTo,
    Math.max(legal.minRaiseTo, Math.ceil((bet + call + (pot + call) * ratio) / step) * step)) }));
}
export function roomControls(view) {
  const own = ownSeat(view);
  const members = Array.isArray(view.roomMembers) ? view.roomMembers : view.game?.players || [];
  const seated = [...new Set(members.filter((member) => !["WATCHING", "STANDING"].includes(member.state))
    .map((member) => seatIndex(member)).filter((seat) => seat !== null && Number.isInteger(Number(seat)) && Number(seat) >= 0).map(Number))];
  const host = ["CREATOR", "HOST"].includes(view.self?.role) || view.self?.isHost === true;
  const inHand = Boolean(view.game && view.game.phase !== "complete");
  const playState = view.room?.playState || (view.room?.status === "PAUSED" ? "PAUSED" : inHand || view.room?.status === "PLAYING" ? "RUNNING" : "WAITING");
  const paused = playState === "PAUSED", pausePending = playState === "PAUSE_PENDING";
  const allowed = Array.isArray(view.self?.allowedCommands) ? view.self.allowedCommands : [];
  // Older snapshots omit command capabilities. Java still validates the request.
  const canSit = own === null && (Array.isArray(view.self?.allowedCommands) ? allowed.includes("SIT_DOWN")
    : !inHand && view.room?.status !== "CLOSED" && !["ENDED", "CANCELLED"].includes(view.activity?.status));
  const member = members.find((member) => identity(member) != null && String(identity(member)) === String(identity(view.self)));
  const ready = own !== null && playerReady(view, member || { ...view.self, state: view.self?.roomState });
  const readyCount = members.filter((m) => seatIndex(m) !== null && playerReady(view, m)).length;
  return { host, seatedCount: seated.length, readyCount, seated: own !== null, ready, inHand, paused, pausePending,
    canSit,
    canStand: own !== null && allowed.includes("STAND_UP"),
    canReady: own !== null && !inHand && !ready && allowed.includes("READY"),
    canUnready: own !== null && !inHand && ready && allowed.includes("UNREADY"),
    canBuyIn: allowed.includes("BUY_IN") && buyInOptions(view).length > 0,
    canStart: host && seated.length >= 2 && !inHand && !paused && !pausePending && allowed.includes("START_HAND"),
    canPause: host && !paused && !pausePending && (inHand || playState === "RUNNING") && allowed.includes("PAUSE_GAME"),
    canResume: host && paused && !inHand && seated.length >= 2 && allowed.includes("RESUME_GAME"),
  };
}
export function memberAmounts(member) {
  const amount = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean"
    && Number.isFinite(Number(value)) ? Number(value) : null;
  const totalBuyIn = amount(member.totalBuyIn), stack = amount(member.stack);
  return { totalBuyIn, netChips: amount(member.netChips) ?? (totalBuyIn !== null && stack !== null ? stack - totalBuyIn : null) };
}
export function safeAvatar(url) {
  try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : null; }
  catch { return null; }
}
export function createPokerTable({ document, onAction, onCommand, onError = () => {}, confirmStand = () => false }) {
  const $ = (id) => document.getElementById(id);
  let view = {}, game = null, connected = false, pending = false, pendingTimer = null;
  let lastHand = null, lastBoard = [], timer = null, deadline = null, currentTimer = null, currentSeconds = null;
  let lastLayoutKey = null, dealCleanupTimer = null;
  let seatButtons = [], openSeats = new Set();
  let standConfirmOpen = false;
  function currentLayout() {
    return tableLayout(view.room?.settings?.maxSeats || Math.max(2, ...(game?.players || []).map((p) => p.seatIndex + 1)), ownSeat(view));
  }
  function resize() {
    const stage = $("table-stage");
    // Reserve one caption line for hand positions on short portrait screens.
    stage.style.setProperty("--seat-size", Math.max(24, Math.min(76, stage.clientWidth * .15, stage.clientHeight * .115 - (game ? 10 : 0))) + "px");
    const layout = currentLayout();
    for (const el of $("table-seats").children) {
      const place = layout.find((p) => String(p.seatIndex) === el.getAttribute("data-seat-index"));
      if (!place) continue;
      el.style.setProperty("--x", place.x + "%"); el.style.setProperty("--y", place.y + "%");
      el.classList.toggle("right", place.x > 50); el.classList.toggle("top", place.y < 25); el.classList.toggle("bottom", place.y > 80);
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
  function act(action, amount) {
    if (!canAct()) return;
    const legal = game.legal;
    if (action === "check" && !legal.canCheck || action === "call" && !legal.canCall || action === "fold" && legal.canFold === false) return;
    if (action === "raise" && (!legal.canRaise || !Number.isFinite(amount) || amount < legal.minRaiseTo || amount > legal.maxRaiseTo)) return;
    pending = true; updateActions();
    $("table-notice").textContent = "正在提交操作…";
    $("raise-editor").hidden = true; $("raise-toggle").setAttribute("aria-expanded", "false");
    pendingTimer = setTimeout(() => { pending = false; connected = false; updateActions(); reportError("操作尚未确认，请重新连接以同步牌局。", true); }, 10000);
    onAction(action, amount);
  }
  function canAct() {
    const seat = ownSeat(view);
    return connected && !pending && !roomControls(view).paused && game?.legal && seat !== null && seat === game.turn && game.phase !== "complete";
  }
  function chooseRaise(amount) {
    if (!canAct() || !game.legal.canRaise) return;
    const input = $("raise-range");
    input.min = game.legal.minRaiseTo; input.max = game.legal.maxRaiseTo; input.step = game.legal.chipUnit || 1;
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
    if (!enabled) { $("raise-editor").hidden = true; $("raise-toggle").setAttribute("aria-expanded", "false"); }
    const presets = $("raise-presets"); presets.replaceChildren();
    for (const { ratio, amount } of enabled ? raisePresets(game) : []) {
      const button = node("button", ""); button.type = "button";
      const label = node("span", "", "加注"); label.append(node("b", "", formatChips(amount)));
      button.append(label, node("small", "", Math.round(ratio * 100) + "%"));
      button.setAttribute("data-raise-amount", String(amount)); button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => chooseRaise(amount)); presets.append(button);
    }
    const controls = roomControls(view), enabledControl = connected && !pending;
    for (const button of seatButtons) {
      // Keep unavailable seats clickable to explain why sitting is not possible.
      button.disabled = pending;
      button.setAttribute("aria-disabled", String(!enabledControl || !controls.canSit));
      button.setAttribute("title", controls.seated ? "请先从菜单起身再选择其他座位" : "点击落座");
    }
    $("host-controls").hidden = !controls.host;
    $("player-controls").hidden = !controls.seated;
    $("stand-up").hidden = !controls.seated;
    $("stand-up").disabled = !enabledControl || !controls.canStand;
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
      : controls.inHand ? "本局中追加的筹码将在本局结束后到账。" : "追加筹码将在确认后立即到账。";
    $("start-hand").hidden = !controls.host || controls.paused;
    $("start-hand").disabled = !enabledControl || !controls.canStart;
    $("pause-game").hidden = !controls.host || controls.paused;
    $("pause-game").disabled = !enabledControl || !controls.canPause;
    $("pause-game").textContent = controls.pausePending ? "已申请本局结束后暂停" : "暂停游戏（本局结束后生效）";
    $("resume-game").hidden = !controls.host || !controls.paused;
    $("resume-game").disabled = !enabledControl || !controls.canResume;
    $("host-control-detail").textContent = controls.pausePending ? "当前这手继续进行，结算完成后暂停，不再发下一手。"
      : controls.paused ? (controls.seatedCount < 2 ? "游戏已暂停，至少 2 人落座后可继续。" : "游戏已暂停，继续后恢复发牌。")
      : controls.seatedCount < 2 ? "至少需要 2 人落座，目前 " + controls.seatedCount + " 人。"
      : controls.inHand ? "牌局进行中，暂停会在本局结束后生效。" : controls.canStart ? "已有 " + controls.seatedCount + " 人落座，可以开始游戏。" : "已落座 " + controls.seatedCount + " 人，已准备 " + controls.readyCount + " 人，等待开局条件满足。";
    $("play-state-notice").hidden = !controls.paused && !controls.pausePending;
    $("play-state-notice").textContent = controls.paused ? "游戏已暂停 · 等待房主继续" : "房主已申请暂停 · 本局结束后生效";
  }
  function command(type, payload = {}) {
    if (pending) { reportError("正在处理上一项操作，请稍候…"); return; }
    if (!connected) { $("table-notice").textContent = "牌桌连接尚未就绪，请稍候或在菜单中重新连接。"; return; }
    const controls = roomControls(view);
    const permission = { SIT_DOWN: controls.canSit && openSeats.has(payload.seatIndex), READY: controls.canReady,
      UNREADY: controls.canUnready, BUY_IN: controls.canBuyIn && buyInOptions(view).includes(payload.amount),
      STAND_UP: controls.canStand, START_HAND: controls.canStart, PAUSE_GAME: controls.canPause, RESUME_GAME: controls.canResume };
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
    if (!currentTimer || !deadline) return;
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    currentTimer.style.setProperty("--time", Math.min(100, seconds / (view.room?.settings?.turnSeconds || 30) * 100) + "%");
    currentSeconds.textContent = seconds + "s";
    if (!seconds) { connected = false; updateActions(); $("table-notice").textContent = "行动时间已到，等待服务端更新…"; }
  }
  function render(nextView) {
    view = nextView; game = view.game || null; pending = false; clearTimeout(pendingTimer);
    const settings = view.room?.settings || {};
    const selfSeat = ownSeat(view);
    // `id` in the old two-player protocol is a seat; activity protocol uses explicit seatIndex.
    const players = (game?.players || []).map((p) => ({ ...p, seatIndex: Number(seatIndex(p) ?? p.id) }));
    if (game) game = { ...game, players, turn: game.turn == null ? null : Number(game.turn) };
    const members = view.roomMembers || [];
    const handKey = game?.handId ?? game?.handNumber ?? null;
    const newHand = handKey !== null && handKey !== lastHand;
    const layout = currentLayout();
    const roles = handPositions(game);
    const positions = seatPositions(game);
    const layoutKey = layout.length + ":" + selfSeat;
    if (layoutKey !== lastLayoutKey) {
      clearTimeout(dealCleanupTimer); $("deal-layer").replaceChildren(); lastLayoutKey = layoutKey;
    }
    $("table-stage").setAttribute("data-seat-count", String(layout.length));
    const seats = $("table-seats"); seats.replaceChildren();
    seatButtons = []; openSeats = new Set();
    currentTimer = null; currentSeconds = null;
    for (const place of layout) {
      const player = players.find((p) => p.seatIndex === place.seatIndex);
      const member = members.find((m) => Number(seatIndex(m)) === place.seatIndex && seatIndex(m) !== null);
      const person = game?.phase === "complete" ? member || player : player || member;
      const mine = selfSeat === place.seatIndex;
      const current = game?.turn === place.seatIndex && game?.phase !== "complete";
      const el = node(person ? "div" : "button", "seat" + (!person ? " empty" : "") + (mine ? " self" : "")
        + (current ? " current" : "") + (person?.folded ? " folded" : "") + (person?.online === false ? " offline" : "")
        + (place.x > 50 ? " right" : "") + (place.y < 25 ? " top" : "") + (place.y > 85 ? " bottom" : ""));
      el.setAttribute("data-seat-index", String(place.seatIndex));
      if (!person) {
        el.type = "button"; el.setAttribute("aria-label", "空座，点击落座");
        el.addEventListener("click", () => command("SIT_DOWN", { seatIndex: place.seatIndex }));
        seatButtons.push(el); openSeats.add(place.seatIndex);
      }
      el.style.setProperty("--x", place.x + "%"); el.style.setProperty("--y", place.y + "%"); el.style.setProperty("--hue", String((place.seatIndex * 59 + 220) % 360));
      const name = person?.nickname || person?.name || member?.nickname || (mine ? view.self?.nickname : null) || "玩家";
      const avatar = node("div", "seat-avatar"); avatar.append(node("span", "avatar-monogram", person ? [...name][0] : "+"));
      const avatarUrl = safeAvatar(person?.avatarUrl || member?.avatarUrl || (mine ? view.self?.avatarUrl : null));
      if (avatarUrl) { const img = node("img", ""); img.src = avatarUrl; img.alt = ""; img.referrerPolicy = "no-referrer"; img.addEventListener("error", () => img.remove()); avatar.append(img); }
      const label = node("div", "seat-label");
      const position = person ? positions.get(place.seatIndex) : null;
      if (position) label.append(node("span", "seat-position", position));
      label.append(node("span", "seat-name", person ? name : "空座"));
      if (person) label.append(node("strong", "seat-stack", formatChips(person.stack)));
      if (person?.folded || person?.allIn || person?.online === false) label.append(node("span", "seat-state", person.folded ? "已弃牌" : person.allIn ? "ALL IN" : "离线"));
      const markers = node("div", "seat-markers");
      for (const [role, seat, title] of [["D", roles.dealer, "庄位"], ["SB", roles.smallBlindSeat, "小盲"], ["BB", roles.bigBlindSeat, "大盲"]]) {
        if (seat !== place.seatIndex) continue;
        const badge = node("span", "seat-marker " + (role === "D" ? "dealer-button" : role === "SB" ? "small-blind-marker" : "big-blind-marker"), role);
        badge.setAttribute("title", title); badge.setAttribute("aria-label", title); markers.append(badge);
      }
      if (markers.children.length) label.append(markers);
      el.append(avatar);
      if (person && playerReady(view, member || person)) el.append(node("span", "seat-readiness", "已准备"));
      if (player?.hole?.length) {
        const hole = node("div", "hole-cards");
        // Never reveal another player's hole cards before an explicit showdown.
        const visible = mine || (game.phase === "complete" && Boolean(game.result?.hands));
        player.hole.slice(0, 2).forEach((value, i) => hole.append(card(visible ? value : null, newHand, i * 130 + place.seatIndex * 60)));
        el.append(hole);
      }
      el.append(label);
      if (Number(person?.bet) > 0) { const bet = node("div", "seat-bet"); bet.append(node("span", "chip"), node("span", "", formatChips(person.bet))); el.append(bet); }
      if (current) { const bar = node("div", "turn-timer"), progress = node("span", ""); bar.append(progress); el.append(bar); currentTimer = progress; currentSeconds = node("span", "turn-seconds"); el.append(currentSeconds); }
      seats.append(el);
    }
    const board = $("board-cards"); board.replaceChildren();
    const cards = (game?.board || []).slice(0, 5);
    for (let i = 0; i < 5; i++) {
      if (cards[i]) board.append(card(cards[i], newHand || cards[i] !== lastBoard[i], i * 90));
      else { const placeholder = node("span", "card placeholder"); placeholder.setAttribute("aria-hidden", "true"); board.append(placeholder); }
    }
    $("table-blinds").textContent = "NLHE " + formatChips(settings.smallBlind) + " / " + formatChips(settings.bigBlind);
    $("table-pot").textContent = formatChips(game?.pot ?? 0);
    $("table-phase").textContent = game ? "第 " + (game.handNumber ?? "—") + " 手 · " + (PHASE_NAMES[game.phase] || "牌局进行中") : "等待开局";
    $("table-result").textContent = game?.result?.message || "";
    $("table-notice").textContent = !connected ? "正在同步牌局…" : roomControls(view).paused ? "游戏已暂停，等待房主继续"
      : !game ? (selfSeat === null ? (Number(settings.seatingType) === 0 ? "点击任意空座随机落座，由房主开始游戏" : "点击虚线空座落座，由房主开始游戏") : "已入座，等待房主开始游戏")
      : selfSeat === null ? "你正在旁观本场牌局" : canAct() ? "轮到你行动" : game.phase === "complete" ? "本局结束，等待下一手" : "等待其他玩家行动";
    deadline = Date.parse(game?.turnDeadline || "");
    if (currentSeconds) currentSeconds.hidden = !Number.isFinite(deadline);
    clearInterval(timer); updateClock();
    if (currentTimer && Number.isFinite(deadline)) timer = setInterval(updateClock, 1000);
    if (newHand) animateDeal(layout.filter((p) => players.find((player) => player.seatIndex === p.seatIndex && player.hole?.length)));
    lastHand = handKey; lastBoard = [...cards]; updateActions(); resize();
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
  $("call-action").addEventListener("click", () => act(game?.legal?.canCheck ? "check" : "call"));
  $("raise-toggle").addEventListener("click", () => {
    if (!canAct() || !game.legal.canRaise) return;
    chooseRaise(game.legal.minRaiseTo);
    $("raise-limits").textContent = "可加注 " + formatChips(game.legal.minRaiseTo) + " – " + formatChips(game.legal.maxRaiseTo);
    $("raise-editor").hidden = !$("raise-editor").hidden;
    $("raise-toggle").setAttribute("aria-expanded", String(!$("raise-editor").hidden));
  });
  $("close-raise").addEventListener("click", () => { $("raise-editor").hidden = true; $("raise-toggle").setAttribute("aria-expanded", "false"); });
  $("raise-range").addEventListener("input", () => chooseRaise(Number($("raise-range").value)));
  $("raise-editor").addEventListener("submit", (event) => { event.preventDefault(); act("raise", Number($("raise-range").value)); });
  $("all-in-action").addEventListener("click", () => chooseRaise(game?.legal?.maxRaiseTo));
  $("stand-up").addEventListener("click", async () => {
    if (!connected || pending || standConfirmOpen || !roomControls(view).canStand) return;
    standConfirmOpen = true;
    try { if (await confirmStand() && connected && !pending && roomControls(view).canStand) command("STAND_UP"); }
    finally { standConfirmOpen = false; }
  });
  for (const [id, type] of [["ready-player", "READY"], ["unready-player", "UNREADY"], ["start-hand", "START_HAND"], ["pause-game", "PAUSE_GAME"], ["resume-game", "RESUME_GAME"]]) {
    $(id).addEventListener("click", () => command(type, type === "PAUSE_GAME" ? { afterCurrentHand: true } : {}));
  }
  $("buy-in-form").addEventListener("submit", (event) => { event.preventDefault(); command("BUY_IN", { amount: Number($("buy-in-amount").value) }); });

  return {
    render,
    resize,
    setConnected(value, notice) { connected = value; updateActions(); if (notice) $("table-notice").textContent = notice; },
    reject(message) { clearTimeout(pendingTimer); pending = false; updateActions(); $("table-notice").textContent = message; },
    reset() { clearInterval(timer); clearTimeout(pendingTimer); clearTimeout(dealCleanupTimer); $("deal-layer").replaceChildren(); lastLayoutKey = null; lastHand = null; lastBoard = []; connected = false; pending = false; updateActions(); },
  };
}
