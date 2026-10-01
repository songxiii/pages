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

export function normalizeWebSocketUrl(value, apiBase) {
  const url = new URL(value);
  const api = new URL(apiBase);
  // CloudBase responses may include :80 even though the public endpoint uses HTTPS.
  if (url.protocol === "wss:" && url.port === "80"
      && api.protocol === "https:" && url.hostname === api.hostname
      && url.hostname.endsWith(".run.tcloudbase.com")) {
    url.port = api.port;
  }
  return url.href;
}

export function validateSettings(raw) {
  const settings = {};
  for (const key of ["maxSeats", "seatingType", "smallBlind", "bigBlind", "startingStack", "turnSeconds", "durationMinutes"]) {
    if (raw[key] == null || raw[key] === "") throw new Error("请填写完整房间配置");
    const value = Number(raw[key]);
    if (!Number.isSafeInteger(value)) throw new Error("房间配置必须为有效整数");
    settings[key] = value;
  }
  if (settings.maxSeats < 2 || settings.maxSeats > 9) throw new Error("座位上限应为 2–9 人");
  if (![0, 1].includes(settings.seatingType)) throw new Error("请选择落座方式");
  if (settings.smallBlind < 1 || settings.bigBlind < settings.smallBlind) throw new Error("大盲注不得小于小盲注");
  if (settings.startingStack < settings.bigBlind * 20) throw new Error("初始筹码至少为大盲注的 20 倍");
  if (settings.turnSeconds < 10 || settings.turnSeconds > 120) throw new Error("行动时限应为 10–120 秒");
  if (![30, 60, 90, 120, 180, 240, 360, 480].includes(settings.durationMinutes)) throw new Error("请选择有效的游戏时长（30–480 分钟）");
  return settings;
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
