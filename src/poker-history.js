// History is a server-owned, per-viewer projection. Never infer hidden cards or past hands.
export function createPokerHistory({ document, request, getRoom, formatChips, safeAvatar, onOpen = () => {} }) {
  const el = id => document.getElementById(id);
  const streets = ["PREFLOP", "FLOP", "TURN", "RIVER"];
  const actionNames = { CHECK: "过牌", CALL: "跟注", BET: "下注", RAISE: "加注", ALL_IN: "全下", FOLD: "弃牌", POST_SMALL_BLIND: "小盲", POST_BIG_BLIND: "大盲", REFUND: "退回" };
  let data = null, loading = false, epoch = 0, retry = null;
  const node = (tag, className, value) => {
    const result = document.createElement(tag); result.className = className;
    if (value != null) result.textContent = String(value);
    return result;
  };
  function controls() {
    const disabled = loading || !data?.hand;
    for (const [id, target] of [["history-first", data?.firstHandNumber], ["history-prev", data?.previousHandNumber], ["history-next", data?.nextHandNumber], ["history-last", data?.lastHandNumber]]) {
      el(id).disabled = disabled || target == null || target === data?.hand?.handNumber;
    }
    el("refresh-history").disabled = loading;
    el("refresh-history").textContent = retry ? "重试" : "刷新最新牌局";
    el("history-scroll").setAttribute("aria-busy", String(loading));
  }
  function historyCard(value) {
    value = typeof value === "string" ? value.toUpperCase() : value;
    const valid = typeof value === "string" && /^(?:[2-9TJQKA]|10)[SHDC]$/.test(value);
    const card = node("span", "history-card" + (valid ? "" : " history-card-back"));
    if (!valid) { card.setAttribute("aria-label", "未公开底牌"); return card; }
    const suit = value.slice(-1), rank = value.slice(0, -1).replace("T", "10");
    const symbols = { S: "♠", H: "♥", D: "♦", C: "♣" };
    card.setAttribute("data-suit", suit); card.setAttribute("aria-label", rank + symbols[suit]);
    card.append(node("b", "", rank), node("span", "", symbols[suit]));
    return card;
  }
  function cards(values) {
    const group = node("div", "history-cards");
    values.forEach(value => group.append(historyCard(value)));
    return group;
  }
  function actionText(action) {
    const type = String(action.type || "").toUpperCase();
    const amount = Number.isSafeInteger(action.amount) && action.amount >= 0 ? action.amount : null;
    return (actionNames[type] || "未知操作") + (amount !== null && !["CHECK", "FOLD"].includes(type) ? " " + formatChips(amount) : "") + (action.source === "TIMEOUT" ? "（超时）" : "");
  }
  function renderHand() {
    const hand = data.hand;
    el("history-hand").hidden = !hand;
    el("history-position").textContent = data.position + " / " + data.totalHands;
    el("history-coverage").hidden = data.coverage?.status !== "PARTIAL";
    el("history-coverage").textContent = data.coverage?.status === "PARTIAL" ? data.coverage.message || "早期牌局未保存，仅展示已有历史。" : "";
    el("history-players").replaceChildren();
    if (!hand) { el("history-status").textContent = "暂无已结算的历史牌局。"; return; }
    el("history-status").textContent = "";
    el("history-hand-number").textContent = "第 " + hand.handNumber + " 手";
    el("history-hand-id").textContent = "牌局 ID：" + hand.handId;
    const time = Date.parse(hand.settledAt || hand.startedAt || "");
    el("history-time").textContent = Number.isFinite(time) ? new Date(time).toLocaleString("zh-CN", { hour12: false }) : "时间未提供";
    el("history-time").setAttribute("datetime", Number.isFinite(time) ? new Date(time).toISOString() : "");
    el("history-pot").textContent = "底池 " + formatChips(hand.pot);
    el("history-blinds").textContent = "盲注 " + formatChips(hand.smallBlind) + " / " + formatChips(hand.bigBlind);
    const board = Array.isArray(hand.board) ? hand.board.slice(0, 5) : [];
    for (const player of hand.players) {
      const mine = String(player.userId) === String(getRoom()?.userId);
      const visibleHole = mine || player.holeCardsRevealed === true && player.folded !== true;
      const row = node("article", "history-player" + (mine ? " is-self" : ""));
      row.setAttribute("data-user-id", String(player.userId));
      const profile = node("div", "history-profile"), avatar = node("div", "history-avatar", [...(player.nickname || "玩家")][0]);
      const avatarUrl = safeAvatar(player.avatarUrl);
      if (avatarUrl) {
        const img = node("img", ""); img.src = avatarUrl; img.alt = ""; img.referrerPolicy = "no-referrer";
        img.addEventListener("error", () => img.remove()); avatar.append(img);
      }
      if (player.position) avatar.append(node("span", "history-role", player.position));
      const name = node("span", "history-name", player.nickname || "玩家"); name.setAttribute("title", player.nickname || "玩家");
      profile.append(avatar, name); row.append(profile);
      const actions = (Array.isArray(player.actions) ? player.actions : []).filter(action => action && streets.includes(action.street))
        .sort((a, b) => a.sequence - b.sequence);
      const foldedOn = actions.find(action => action.type === "FOLD")?.street;
      for (const [index, street] of streets.entries()) {
        const cell = node("div", "history-street");
        const reached = !foldedOn || index <= streets.indexOf(foldedOn);
        if (index === 0) cell.append(cards(visibleHole ? [player.holeCards?.[0], player.holeCards?.[1]] : [null, null]));
        else if (reached) cell.append(cards(index === 1 ? board.slice(0, 3) : board.slice(index + 1, index + 2)));
        if (index === 0 && visibleHole && player.handName) cell.append(node("span", "history-hand-name", player.handName));
        const streetActions = actions.filter(action => action.street === street);
        streetActions.forEach(action => cell.append(node("span", "history-action" + (action.type === "FOLD" ? " is-fold" : ""), actionText(action))));
        if (!streetActions.length && reached) cell.append(node("span", "history-action history-no-action", "—"));
        row.append(cell);
      }
      const net = Number.isSafeInteger(player.netChips) ? player.netChips : null;
      row.append(node("strong", "history-profit" + (net > 0 ? " profit-positive" : net < 0 ? " profit-negative" : ""), net === null ? "—" : (net > 0 ? "+" : "") + formatChips(net)));
      el("history-players").append(row);
    }
    el("history-scroll").scrollTop = 0;
  }
  function validate(result, roomId) {
    const handNumber = value => Number.isSafeInteger(value) && value > 0;
    if (!result || String(result.roomId) !== String(roomId) || !Number.isSafeInteger(result.totalHands) || result.totalHands < 0
        || !Number.isSafeInteger(result.position) || result.position < 0 || result.position > result.totalHands
        || (result.totalHands > 0 && (!result.position || !handNumber(result.hand?.handNumber) || result.hand.handId == null || !Array.isArray(result.hand.players)))
        || (result.totalHands === 0 && (result.hand != null || result.position !== 0))) throw new Error("历史牌局响应格式不完整，请稍后重试。");
    if (result.totalHands > 0 && (![result.firstHandNumber, result.lastHandNumber, result.throughHandNumber].every(handNumber)
        || result.hand.handNumber < result.firstHandNumber || result.hand.handNumber > result.lastHandNumber || result.lastHandNumber > result.throughHandNumber
        || (result.previousHandNumber != null && (!handNumber(result.previousHandNumber) || result.previousHandNumber >= result.hand.handNumber))
        || (result.nextHandNumber != null && (!handNumber(result.nextHandNumber) || result.nextHandNumber <= result.hand.handNumber)))) throw new Error("历史牌局分页信息不完整，请稍后重试。");
    return result;
  }
  async function load(handNumber = null, throughHandNumber = null) {
    if (loading || !el("history-dialog").open) return;
    const room = getRoom();
    if (room?.roomId == null) return;
    const current = ++epoch;
    loading = true; retry = null; controls();
    el("history-status").textContent = "正在加载牌局…";
    try {
      const result = await request("/api/poker/v1/rooms/history", { ticket: room.ticket, roomId: String(room.roomId),
        ...(handNumber == null ? {} : { handNumber }), ...(throughHandNumber == null ? {} : { throughHandNumber }) });
      if (current !== epoch || !el("history-dialog").open) return;
      data = validate(result, room.roomId); renderHand();
    } catch (error) {
      if (current !== epoch || !el("history-dialog").open) return;
      retry = { handNumber, throughHandNumber };
      el("history-status").textContent = error.status === 404 || error.status === 405 || error.status === 501
        ? "服务端暂未提供历史牌局接口，请稍后重试。" : "历史牌局加载失败：" + error.message;
    } finally {
      if (current === epoch) { loading = false; controls(); }
    }
  }
  function close() {
    epoch++; loading = false; el("room-history").setAttribute("aria-expanded", "false");
    if (el("history-dialog").open) el("history-dialog").close();
  }
  function reset() {
    close(); data = null; retry = null;
    el("history-hand").hidden = true; el("history-coverage").hidden = true;
    el("history-players").replaceChildren(); el("history-position").textContent = "0 / 0"; controls();
  }
  el("room-history").addEventListener("click", () => {
    reset(); onOpen(); el("history-dialog").showModal(); el("room-history").setAttribute("aria-expanded", "true"); load();
  });
  el("close-history").addEventListener("click", close);
  el("history-dialog").addEventListener("cancel", event => { event.preventDefault(); close(); });
  el("history-dialog").addEventListener("click", event => { if (event.target === el("history-dialog")) close(); });
  for (const [id, key] of [["history-first", "firstHandNumber"], ["history-prev", "previousHandNumber"], ["history-next", "nextHandNumber"], ["history-last", "lastHandNumber"]]) {
    el(id).addEventListener("click", () => { if (!el(id).disabled) load(data[key], data.throughHandNumber); });
  }
  el("refresh-history").addEventListener("click", () => retry ? load(retry.handNumber, retry.throughHandNumber) : load());
  controls();
  return { close, reset };
}
