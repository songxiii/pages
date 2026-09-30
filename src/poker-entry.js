export const DEFAULT_SETTINGS = Object.freeze({
  maxSeats: 6,
  seatingType: 0,
  smallBlind: 10,
  bigBlind: 20,
  startingStack: 1000,
  turnSeconds: 30,
});

export function ticketFromLocation(location) {
  const query = new URLSearchParams(location.search || "");
  const fragment = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  return query.get("ticket") || fragment.get("ticket") || "";
}

export function ticketFragmentUrl(location) {
  const ticket = ticketFromLocation(location);
  if (!ticket) return null;
  const url = new URL(location.href);
  if (!url.searchParams.has("ticket")) return null;
  url.searchParams.delete("ticket");
  url.hash = "ticket=" + encodeURIComponent(ticket);
  return url.pathname + url.search + url.hash;
}

export function redactCredentials(value) {
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /^(authorization|ticket|wstoken|accesstoken|refreshtoken)$/i.test(key)
        ? "••••••（已隐藏）" : redactCredentials(item),
    ]));
  }
  return value;
}

export function validateSettings(raw) {
  const settings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = Number(raw[key]);
    if (!Number.isSafeInteger(value)) throw new Error("房间配置必须填写有效整数");
    settings[key] = value;
  }
  if (settings.maxSeats < 2 || settings.maxSeats > 9) throw new Error("座位上限应为 2–9 人");
  if (![0, 1].includes(settings.seatingType)) throw new Error("请选择落座方式");
  if (settings.smallBlind < 1 || settings.bigBlind < settings.smallBlind) throw new Error("大盲注不得小于小盲注");
  if (settings.startingStack < settings.bigBlind * 20) throw new Error("初始筹码至少为大盲注的 20 倍");
  if (settings.turnSeconds < 10 || settings.turnSeconds > 120) throw new Error("行动时限应为 10–120 秒");
  return settings;
}

export function responseData(response, httpStatus) {
  if (!response || response.code !== 0 || !response.data || typeof response.data !== "object") {
    const message = response?.errorMsg || (response?.message && response.message !== "success" ? response.message : "");
    const error = new Error(message || `请求失败（HTTP ${httpStatus}）`);
    error.status = httpStatus === 200 && Number.isInteger(response?.code) ? response.code : httpStatus;
    throw error;
  }
  return response.data;
}
