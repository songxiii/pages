// Session deadlines and final statistics are server-owned; never settle chips locally.
const statistic = value => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
const nonnegativeStatistic = value => { const number = statistic(value); return number !== null && number >= 0 ? number : null; };
export function roomEnded(view) {
  return view?.entryState === "ROOM_CLOSED" || view?.room?.status === "CLOSED" || view?.room?.timing?.status === "ENDED";
}
export function roomEnding(view, now = Date.now()) {
  const end = Date.parse(view?.room?.timing?.endsAt || "");
  return roomEnded(view) || view?.room?.timing?.status === "ENDING" || Number.isFinite(end) && now >= end;
}
export function sessionClock(view, now = Date.now()) {
  if (roomEnded(view)) return { visible: true, text: "本场已结束", status: "ENDED", seconds: 0 };
  const end = Date.parse(view?.room?.timing?.endsAt || "");
  if (view?.room?.timing?.status === "ENDING" || Number.isFinite(end) && now >= end) {
    const reason = view?.room?.timing?.reason === "HOST_CLOSED" ? "房主已结束本场" : "时间已到";
    return { visible: true, text: reason + (view?.game && view.game.phase !== "complete" ? " · 本局结束后结算" : " · 等待结算"), status: "ENDING", seconds: 0 };
  }
  if (!Number.isFinite(end)) return view?.room?.timing?.status === "WAITING"
    ? { visible: true, text: "等待房主开始游戏", status: "WAITING", seconds: null }
    : { visible: false, status: "UNKNOWN", seconds: null };
  const seconds = Math.max(0, Math.ceil((end - now) / 1000));
  const pad = value => String(value).padStart(2, "0");
  return { visible: true, status: "OPEN", seconds,
    text: "剩余 " + pad(Math.floor(seconds / 3600)) + ":" + pad(Math.floor(seconds % 3600 / 60)) + ":" + pad(seconds % 60) };
}
export function settlementShowAt(view, now = Date.now()) {
  const explicit = Date.parse(view?.settlement?.showAt || "");
  if (Number.isFinite(explicit)) return explicit;
  const ended = Date.parse(view?.room?.timing?.endedAt || view?.settlement?.endedAt || "");
  return Number.isFinite(ended) ? ended + 10000 : now + 10000;
}
export function settlementRows(settlement) {
  const players = Array.isArray(settlement?.players) ? settlement.players : [];
  return players.filter(p => p && (p.userId != null || p.id != null)).map(p => ({ ...p,
    userId: String(p.userId ?? p.id), netChips: statistic(p.netChips),
    totalBuyIn: nonnegativeStatistic(p.totalBuyIn),
    handsPlayed: nonnegativeStatistic(p.handsPlayed),
  })).sort((a, b) => {
    if (a.netChips === null || b.netChips === null) return a.netChips === b.netChips ? 0 : a.netChips === null ? 1 : -1;
    if (a.netChips !== b.netChips) return a.netChips > b.netChips ? -1 : 1;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
}
export function settlementStats(settlement) {
  return Object.fromEntries(["totalHands", "totalBuyIn", "totalPot", "maxPot"].map(key => {
    const value = statistic(settlement?.[key]);
    return [key, value !== null && value >= 0 ? value : null];
  }));
}
