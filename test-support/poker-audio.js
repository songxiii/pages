import { SOUND_STORAGE_KEY } from "../src/poker-sound.js";

export function fakeSoundEnvironment(saved = null) {
  const contexts = [], nodes = [], storage = new Map(saved == null ? [] : [[SOUND_STORAGE_KEY, saved]]);
  const listeners = {}, windowListeners = {}, attributes = {};
  const param = () => ({ setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => { const source = { frequency: param(), connect() {}, disconnect() { this.disconnected = true; },
    start(time) { this.started = time; }, stop(time) { this.stops ||= []; this.stops.push(time); } }; nodes.push(source); return source; };
  class AudioContext {
    constructor() { this.state = "running"; this.currentTime = 0; this.sampleRate = 8000; contexts.push(this); }
    createOscillator() { return node(); }
    createBufferSource() { return node(); }
    createGain() { return { gain: param(), connect() {}, disconnect() {} }; }
    createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    resume() { this.state = "running"; return Promise.resolve(); }
  }
  const document = { hidden: false, addEventListener(type, fn) { listeners[type] = fn; } };
  const window = { AudioContext, addEventListener(type, fn) { windowListeners[type] = fn; } };
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const button = { setAttribute(key, value) { attributes[key] = value; }, addEventListener(type, fn) { this[type] = fn; } };
  return { contexts, nodes, storage, listeners, windowListeners, attributes, document, window, localStorage, button };
}
