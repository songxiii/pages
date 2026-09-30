// Activity table: the server owns cards, money, turns and legal actions.
export const PHASE_NAMES = { preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌", complete: "本局结束" };
const POSITIONS = [[27, 89], [11, 70], [11, 48], [16, 28], [35, 14], [65, 14], [84, 28], [89, 48], [89, 70]];
const SLOTS = { 2: [0, 5], 3: [0, 3, 6], 4: [0, 2, 5, 7], 5: [0, 2, 4, 6, 8], 6: [0, 2, 4, 5, 6, 8], 7: [0, 1, 2, 4, 5, 6, 7], 8: [0, 1, 2, 3, 4, 5, 6, 7], 9: [0, 1, 2, 3, 4, 5, 6, 7, 8] };
export const formatChips = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—";
const identity = (member) => member?.userId ?? member?.id;
export function seatIndex(player) { return player?.seatIndex ?? player?.seat ?? null; }
export function ownSeat(view) {
  if (view.self && (Object.hasOwn(view.self, "seatIndex") || Object.hasOwn(view.self, "seat")) && seatIndex(view.self) === null) return null;
  const explicit = seatIndex(view.self);
  if (explicit !== null) return Number(explicit);
  const id = identity(view.self);
  const member = (view.roomMembers || []).find((item) => id != null && String(identity(item)) === String(id));
  const seat = seatIndex(member);
  return seat === null ? null : Number(seat);
}
export function tableLayout(count, selfSeat = null) {
  const size = Math.min(9, Math.max(2, Math.floor(Number(count)) || 6));
  return SLOTS[size].map((slot, index) => ({ seatIndex: (index + (selfSeat ?? 0)) % size, x: POSITIONS[slot][0], y: POSITIONS[slot][1] }));
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
function safeAvatar(url) {
  try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : null; }
  catch { return null; }
}
export function createPokerTable({ document, onAction, onCommand }) {
  const $ = (id) => document.getElementById(id);
  let view = {}, game = null, connected = false, pending = false, pendingTimer = null;
  let lastHand = null, lastBoard = [], timer = null, deadline = null, currentTimer = null, currentSeconds = null;
  const node = (tag, className, value) => {
    const el = document.createElement(tag); el.className = className;
    if (value != null) el.textContent = String(value);
    return el;
  };
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
    pendingTimer = setTimeout(() => { pending = false; updateActions(); $("table-notice").textContent = "操作尚未确认，请重新连接以同步牌局。"; connected = false; updateActions(); }, 10000);
    onAction(action, amount);
  }
  function canAct() {
    const seat = ownSeat(view);
    return connected && !pending && game?.legal && seat !== null && seat === game.turn && game.phase !== "complete";
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
      button.addEventListener("click", () => act("raise", amount)); presets.append(button);
    }
    const controls = view.self?.allowedCommands || [];
    const availability = { "sit-down": "SIT_DOWN", "ready-player": "READY", "stand-up": "STAND_UP", "start-hand": "START_HAND" };
    let visible = false;
    for (const [id, command] of Object.entries(availability)) {
      $(id).hidden = !controls.includes(command); $(id).disabled = !connected || pending;
      visible ||= !$(id).hidden;
    }
    $("lobby-controls").hidden = !visible;
    $("seat-picker-label").hidden = !controls.includes("SIT_DOWN") || view.room?.settings?.seatingType !== 1;
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
    const players = (game?.players || []).map((p) => ({ ...p, seatIndex: Number(p.seatIndex ?? p.seat ?? p.id) }));
    if (game) game = { ...game, players, turn: game.turn == null ? null : Number(game.turn) };
    const members = view.roomMembers || [];
    const count = settings.maxSeats || Math.max(2, ...players.map((p) => p.seatIndex + 1));
    const handKey = game?.handId ?? game?.handNumber ?? null;
    const newHand = handKey !== null && handKey !== lastHand;
    const layout = tableLayout(count, selfSeat);
    const seats = $("table-seats"); seats.replaceChildren();
    const seatPicker = $("seat-picker"); seatPicker.replaceChildren();
    currentTimer = null; currentSeconds = null;
    for (const place of layout) {
      const player = players.find((p) => p.seatIndex === place.seatIndex);
      const member = members.find((m) => Number(seatIndex(m)) === place.seatIndex && seatIndex(m) !== null);
      const person = player || member;
      const mine = selfSeat === place.seatIndex;
      const current = game?.turn === place.seatIndex && game?.phase !== "complete";
      const el = node("div", "seat" + (!person ? " empty" : "") + (mine ? " self" : "")
        + (current ? " current" : "") + (person?.folded ? " folded" : "") + (person?.online === false ? " offline" : "")
        + (place.x > 50 ? " right" : "") + (place.y < 20 ? " top" : ""));
      el.style.setProperty("--x", place.x + "%"); el.style.setProperty("--y", place.y + "%"); el.style.setProperty("--hue", String((place.seatIndex * 59 + 220) % 360));
      const name = person?.nickname || person?.name || member?.nickname || "玩家";
      const avatar = node("div", "seat-avatar"); avatar.append(node("span", "avatar-monogram", person ? [...name][0] : "+"));
      const avatarUrl = safeAvatar(person?.avatarUrl || member?.avatarUrl);
      if (avatarUrl) { const img = node("img", ""); img.src = avatarUrl; img.alt = ""; img.referrerPolicy = "no-referrer"; img.addEventListener("error", () => img.remove()); avatar.append(img); }
      const label = node("div", "seat-label");
      if (person?.position) label.append(node("span", "seat-position", person.position));
      label.append(node("span", "seat-name", person ? name : "空座 " + (place.seatIndex + 1)));
      if (person) label.append(node("strong", "seat-stack", formatChips(person.stack)));
      if (person?.folded || person?.allIn || person?.online === false) label.append(node("span", "seat-state", person.folded ? "已弃牌" : person.allIn ? "ALL IN" : "离线"));
      if (game?.dealer != null && Number(game.dealer) === place.seatIndex) label.append(node("span", "dealer-button", "D"));
      el.append(avatar);
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
      if (!person) { const option = node("option", "", "座位 " + (place.seatIndex + 1)); option.value = String(place.seatIndex); seatPicker.append(option); }
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
    $("table-notice").textContent = !connected ? "正在同步牌局…" : !game ? "房间已连接，等待玩家入座和准备" : selfSeat === null ? "你正在旁观本场牌局" : canAct() ? "轮到你行动" : game.phase === "complete" ? "本局结束，等待下一手" : "等待其他玩家行动";
    deadline = Date.parse(game?.turnDeadline || "");
    if (currentSeconds) currentSeconds.hidden = !Number.isFinite(deadline);
    clearInterval(timer); updateClock();
    if (currentTimer && Number.isFinite(deadline)) timer = setInterval(updateClock, 1000);
    if (newHand) animateDeal(layout.filter((p) => players.find((player) => player.seatIndex === p.seatIndex && player.hole?.length)));
    lastHand = handKey; lastBoard = [...cards]; updateActions();
  }
  function animateDeal(layout) {
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
    setTimeout(() => layer.replaceChildren(), 2500);
  }
  $("fold-action").addEventListener("click", () => act("fold"));
  $("call-action").addEventListener("click", () => act(game?.legal?.canCheck ? "check" : "call"));
  $("raise-toggle").addEventListener("click", () => {
    if (!canAct() || !game.legal.canRaise) return;
    const input = $("raise-range"), legal = game.legal;
    input.min = legal.minRaiseTo; input.max = legal.maxRaiseTo; input.step = legal.chipUnit || 1; input.value = legal.minRaiseTo;
    $("raise-value").textContent = formatChips(input.value); $("raise-editor").hidden = !$("raise-editor").hidden;
    $("raise-toggle").setAttribute("aria-expanded", String(!$("raise-editor").hidden));
  });
  $("raise-range").addEventListener("input", () => { $("raise-value").textContent = formatChips($("raise-range").value); });
  $("raise-editor").addEventListener("submit", (event) => { event.preventDefault(); act("raise", Number($("raise-range").value)); });
  $("all-in-action").addEventListener("click", () => act("raise", game?.legal?.maxRaiseTo));
  for (const [id, command] of [["sit-down", "SIT_DOWN"], ["ready-player", "READY"], ["stand-up", "STAND_UP"], ["start-hand", "START_HAND"]]) {
    $(id).addEventListener("click", () => {
      if (!connected || pending || !view.self?.allowedCommands?.includes(command)) return;
      const payload = command === "SIT_DOWN" && view.room?.settings?.seatingType === 1 ? { seatIndex: Number($("seat-picker").value) } : {};
      if (command === "SIT_DOWN" && view.room?.settings?.seatingType === 1 && !$("seat-picker").children.length) return;
      pending = true; updateActions(); onCommand(command, payload);
      pendingTimer = setTimeout(() => { pending = false; connected = false; updateActions(); $("table-notice").textContent = "操作尚未确认，请重新连接以同步房间。"; }, 10000);
    });
  }
  return {
    render,
    setConnected(value, notice) { connected = value; updateActions(); if (notice) $("table-notice").textContent = notice; },
    reject(message) { clearTimeout(pendingTimer); pending = false; updateActions(); $("table-notice").textContent = message; },
    reset() { clearInterval(timer); clearTimeout(pendingTimer); lastHand = null; lastBoard = []; connected = false; pending = false; updateActions(); },
  };
}
