// Short, locally synthesized effects. Audio is unlocked only by a user gesture.
export const SOUND_STORAGE_KEY = "poker-sound-enabled";
const soundId = person => person?.userId ?? person?.id;
const soundSeat = person => {
  if (!person) return null;
  if (Object.hasOwn(person, "seatIndex")) return person.seatIndex;
  if (Object.hasOwn(person, "seat")) return person.seat;
  return person.seatNo == null ? null : Number(person.seatNo) - 1;
};
const soundHand = game => game?.handId ?? game?.handNumber;
const soundPlayerKey = player => String(soundId(player) ?? "seat:" + soundSeat(player));
function selfSoundPlayer(view) {
  return view?.game?.players?.find(player => soundId(player) != null && soundId(view.self) != null
    ? String(soundId(player)) === String(soundId(view.self))
    : soundSeat(view.self) != null && Number(soundSeat(player)) === Number(soundSeat(view.self)));
}

// Compare confirmed snapshots, never button intent. Initial/reconnect snapshots are silent.
export function pokerSoundEvents(previous, next) {
  if (!previous || !next || previous.room?.roomId !== next.room?.roomId
      || String(soundId(previous.self)) !== String(soundId(next.self))) return [];
  const events = [], before = previous.game, game = next.game;
  const sameHand = before && game && soundHand(before) === soundHand(game);
  if (game && !sameHand && game.phase !== "complete") events.push("deal");
  if (sameHand && before.phase !== "complete") {
    const oldPlayers = new Map((before.players || []).map(p => [soundPlayerKey(p), p]));
    const players = game.players || [];
    const changed = predicate => players.some(p => oldPlayers.has(soundPlayerKey(p)) && predicate(p, oldPlayers.get(soundPlayerKey(p))));
    const allIn = changed((p, old) => !p.folded && (p.allInCommitted || p.allIn) && !(old.allInCommitted || old.allIn));
    const folded = changed((p, old) => p.folded && !old.folded);
    const spent = Number(game.pot) > Number(before.pot)
      || changed((p, old) => Number(p.stack) < Number(old.stack));
    const actionChanged = before.turn !== game.turn || before.turnDeadline !== game.turnDeadline || before.phase !== game.phase;
    if (allIn) events.push("allIn");
    else if (folded) events.push("fold");
    else if (spent) events.push("chips");
    else if (actionChanged && before.turn != null && game.phase !== "complete") events.push("check");
    if ((game.board?.length || 0) > (before.board?.length || 0)) events.push("flip");
    if (game.phase === "complete") {
      const own = selfSoundPlayer(next), winners = game.result?.winners || [];
      if (winners.length) events.push(!own ? "payout" : winners.some(seat => Number(seat) === Number(soundSeat(own)))
        ? winners.length > 1 ? "draw" : "win" : "lose");
    }
  }
  const own = selfSoundPlayer(next);
  const turnKey = value => [soundHand(value), value?.turn, value?.turnDeadline].join(":");
  if (own && !own.folded && game.phase !== "complete" && Number(soundSeat(own)) === Number(game.turn)
      && game.turn != null && (!before || turnKey(before) !== turnKey(game))) events.push("yourTurn");
  const oldMember = previous.roomMembers?.find(p => String(soundId(p)) === String(soundId(previous.self))) || previous.self;
  const member = next.roomMembers?.find(p => String(soundId(p)) === String(soundId(next.self))) || next.self;
  if (soundSeat(oldMember) !== soundSeat(member) || Boolean(oldMember?.ready) !== Boolean(member?.ready)) events.push("confirm");
  if (Number(member?.totalBuyIn) > Number(oldMember?.totalBuyIn)) events.push("chips");
  if (previous.room?.playState !== next.room?.playState && next.room?.playState) events.push("confirm");
  return [...new Set(events)];
}

export function createPokerSound({ document, window, storage, button }) {
  let enabled = true, context = null, previous = null;
  const voices = new Set(), countdowns = new Map();
  try { enabled = storage?.getItem(SOUND_STORAGE_KEY) !== "false"; } catch { /* In-memory preference still works. */ }
  function updateButton() {
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("aria-label", enabled ? "音效已开启，点击关闭" : "音效已关闭，点击开启");
    button.setAttribute("title", enabled ? "关闭音效" : "开启音效");
    button.setAttribute("data-enabled", String(enabled));
  }
  function stop() {
    for (const voice of voices) { try { voice.source.stop(); } catch { /* Already ended. */ } voice.source.disconnect(); voice.gain.disconnect(); }
    voices.clear();
  }
  function unlock() {
    if (!enabled || document.hidden) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!context && AudioContext) context = new AudioContext();
      if (context?.state === "suspended" || context?.state === "interrupted") context.resume()?.catch(() => {});
    } catch { /* Audio support or autoplay restrictions must never block a game action. */ }
  }
  function voice(source, start, duration, volume) {
    const gain = context.createGain();
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + .008);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    source.connect(gain); gain.connect(context.destination);
    const entry = { source, gain }; voices.add(entry);
    source.onended = () => { voices.delete(entry); source.disconnect(); gain.disconnect(); };
    source.start(start); source.stop(start + duration + .01);
  }
  function tone(frequency, start, duration = .10, volume = .045, type = "sine") {
    const source = context.createOscillator(); source.type = type;
    source.frequency.setValueAtTime(frequency, start); voice(source, start, duration, volume);
  }
  function rustle(start, duration, volume, bright = false) {
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
    const data = buffer.getChannelData(0);
    // Filter the noise in the buffer so cards sound soft and chips sound crisp.
    let last = 0;
    for (let i = 0; i < data.length; i++) { last = .65 * last + .35 * (Math.random() * 2 - 1); data[i] = bright ? (Math.random() * 2 - 1) * .55 : last; }
    const source = context.createBufferSource(); source.buffer = buffer; voice(source, start, duration, volume);
  }
  function play(name, delay = 0) {
    if (!enabled || document.hidden || !context || context.state !== "running") return;
    try {
      const start = context.currentTime + .005 + delay;
      const melody = (notes, step = .11, duration = .15) => notes.forEach((note, i) => tone(note, start + i * step, duration));
      switch (name) {
        case "click": tone(640, start, .045, .025); break;
        case "confirm": melody([520, 780]); break;
        case "chips": [0, .055, .11].forEach(offset => { rustle(start + offset, .05, .10, true); tone(1500, start + offset, .045, .018, "triangle"); }); break;
        case "allIn": melody([440, 660, 880], .09); rustle(start, .12, .10, true); break;
        case "fold": rustle(start, .16, .14); tone(220, start, .12, .025); break;
        case "check": tone(360, start, .055, .04, "triangle"); tone(360, start + .07, .055, .03, "triangle"); break;
        case "deal": [0, .11, .22, .33].forEach(offset => rustle(start + offset, .08, .16)); break;
        case "flip": rustle(start, .13, .18); tone(900, start + .04, .08, .025); break;
        case "yourTurn": melody([660, 880], .12); break;
        case "tick": tone(880, start, .06, .03); break;
        case "urgent": tone(1200, start, .08, .045); break;
        case "win": melody([523, 659, 784, 1047], .13, .22); break;
        case "lose": melody([392, 330, 262], .16, .18); break;
        case "draw": melody([523, 659, 523], .13); break;
        case "payout": melody([660, 880, 1047]); break;
        case "error": melody([240, 190], .12, .12); break;
      }
    } catch { stop(); }
  }
  function baseline(view = null) { previous = view; countdowns.clear(); }
  function observe(view) {
    const events = pokerSoundEvents(previous, view);
    if (soundHand(previous?.game) !== soundHand(view?.game)) countdowns.clear();
    previous = view;
    events.forEach((event, i) => play(event, i * .12));
  }
  function countdown(kind, key, seconds, eligible = true) {
    if (!eligible || !Number.isInteger(seconds) || seconds < 1 || seconds > (kind === "turn" ? 10 : 3)) return;
    // Timers and snapshots can both tick. Never repeat or replay missed seconds.
    const id = kind + ":" + key, last = countdowns.get(id);
    if (last != null && seconds >= last) return;
    if (countdowns.size > 32) countdowns.clear();
    countdowns.set(id, seconds);
    play(seconds <= 3 ? "urgent" : "tick");
  }
  function setEnabled(value) {
    enabled = Boolean(value);
    try { storage?.setItem(SOUND_STORAGE_KEY, String(enabled)); } catch { /* Keep preference for this page. */ }
    updateButton();
    if (enabled) { unlock(); play("confirm"); } else stop();
  }
  updateButton();
  button.addEventListener("click", () => setEnabled(!enabled));
  document.addEventListener("pointerdown", unlock, { capture: true, passive: true });
  document.addEventListener("keydown", unlock, { capture: true });
  document.addEventListener("click", event => {
    const target = event.target?.closest?.("button");
    if (target && target !== button && !target.disabled) play("click");
  }, true);
  document.addEventListener("change", event => { if (event.target?.matches?.("select")) play("click"); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  window.addEventListener?.("pagehide", stop);
  window.addEventListener?.("storage", event => {
    if (event.key === SOUND_STORAGE_KEY || event.key === null) {
      try { enabled = storage?.getItem(SOUND_STORAGE_KEY) !== "false"; } catch { return; }
      updateButton(); if (!enabled) stop();
    }
  });
  return { play, observe, baseline, countdown, stop, setEnabled, get enabled() { return enabled; } };
}
