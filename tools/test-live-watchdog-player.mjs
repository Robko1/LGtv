#!/usr/bin/env node
/*
 * 2.5.418 – ÉLŐ ŐR A VALÓDI LEJÁTSZÓBAN (futásidejű teszt).
 *
 * A TÉNYLEGES VideoPlayer komponens fut jsdom-ban, egy szimulált webOS
 * videóelemmel és VIRTUÁLIS órával (így 30 perc / 2 óra nézés másodpercek
 * alatt lejátszható). A szimulátor a TV-naplókban látott viselkedést adja:
 *
 *   - raw TS indulás: ~2 mp múlva `playing`, 250 ms-onként `timeupdate`;
 *   - természetes megállás: `waiting` (readyState=2), a pozíció áll, majd
 *     `playing` UGYANOTT (a naplókban 4,7–16,8 mp);
 *   - hamis `stalled` események tökéletes lejátszás közben;
 *   - a kapcsolat lezárása: `durationchange` + `pause` + `ended`
 *     (ended=true, paused=true, duration=currentTime – #52 napló);
 *   - néma lefagyás: se esemény, se hiba, a pozíció örökre áll;
 *   - váratlan pause.
 *
 * AMIT BIZONYÍT:
 *   1. működő csatornát SOHA nem tölt újra (indulási megállás, hamis stalled,
 *      30 perc és 2 óra folyamatos nézés) – egyetlen kapcsolat marad;
 *   2. raw élő címre a lejátszó NEM nyit második kérést (XHR/fetch);
 *   3. valódi lefagyásnál (ended, néma megállás, beragadt pause, el sem
 *      induló adás) magától helyreáll, és a lejátszó nem ragad „szünet”-ben;
 *   4. mindez UGYANÚGY történik TV Doktor be/ki, gyors/kiegyensúlyozott/
 *      stabil pufferprofil és két különböző szolgáltató mellett;
 *   5. a néző által kért szünetet tiszteletben tartja;
 *   6. csatornaváltás után az őr nulláról mér.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const esbuild = createRequire(resolve('web/package.json'))('esbuild');
const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VideoPlayer } from './web/src/components/VideoPlayer';
import { INITIAL_SETTINGS } from './web/src/data/mockData';
import { getAppLogText, startManualLogging } from './web/src/services/appLog';
import { LIVE_WATCHDOG_DEFAULTS, resetLiveTimelineTrustForTests } from './web/src/services/liveWatchdog';
let root = null;
let setPlayingExternal = null;
const state = { playing: true, setPlayingCalls: [] };
function Harness({ channel, settings }) {
  const [playing, setPlaying] = useState(true);
  state.playing = playing;
  setPlayingExternal = setPlaying;
  const record = (value) => {
    state.setPlayingCalls.push(typeof value === 'function' ? 'fn' : value);
    setPlaying(value);
  };
  return <VideoPlayer channel={channel} settings={{ ...INITIAL_SETTINGS, ...settings }} isPlaying={playing}
    setIsPlaying={record} volume={0.5} onVolumeChange={() => {}} onToggleMute={() => {}} playbackActive={true} />;
}
window.testPlayer = {
  defaults: LIVE_WATCHDOG_DEFAULTS,
  mount(channel, settings) {
    if (root) root.unmount();
    state.setPlayingCalls = [];
    try { startManualLogging(); } catch { /* napló nélkül is fut */ }
    root = createRoot(document.getElementById('root'));
    root.render(<Harness channel={channel} settings={settings} />);
  },
  update(channel, settings) { root.render(<Harness channel={channel} settings={settings} />); },
  setPlaying(value) { if (setPlayingExternal) setPlayingExternal(value); },
  isPlaying() { return state.playing; },
  setPlayingCalls() { return state.setPlayingCalls.slice(); },
  log() { return getAppLogText(); },
  trust(value) { resetLiveTimelineTrustForTests(value); },
  unmount() { if (root) root.unmount(); root = null; },
};`;
const bundle = await esbuild.build({
  stdin: { contents: harness, resolveDir: resolve('.'), loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  nodePaths: [resolve('web/node_modules')], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
});

const vc = new VirtualConsole();
vc.on('jsdomError', (error) => { if (!/Not implemented/.test(error.message)) throw error; });
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(window) {
    window.__IPTV_DIRECT_LIVE_ZAP_TEST__ = false;

    /* ── VIRTUÁLIS ÓRA ── */
    const clock = { now: 1_800_000_000_000, seq: 0, timers: new Map() };
    window.__clock = clock;
    const add = (fn, delay, repeat, args) => {
      const id = ++clock.seq;
      const ms = Math.max(0, Number(delay) || 0);
      clock.timers.set(id, { id, at: clock.now + ms, fn, repeat: repeat ? Math.max(1, ms) : 0, args });
      return id;
    };
    window.setTimeout = (fn, delay, ...args) => add(fn, delay, false, args);
    window.setInterval = (fn, delay, ...args) => add(fn, delay, true, args);
    window.clearTimeout = (id) => { clock.timers.delete(id); };
    window.clearInterval = (id) => { clock.timers.delete(id); };
    window.requestAnimationFrame = (fn) => add(() => fn(clock.now), 16, false, []);
    window.cancelAnimationFrame = (id) => { clock.timers.delete(id); };
    window.Date.now = () => clock.now;
    const perfBase = clock.now;
    try { Object.defineProperty(window.performance, 'now', { configurable: true, value: () => clock.now - perfBase }); } catch { /* jsdom */ }

    /* ── HÁLÓZATI KÉMEK: semmi nem válaszol, de minden kérés rögzül ── */
    const sim = window.sim = { conn: null, loads: [], plays: [], requests: [], script: null, events: [] };
    window.fetch = (input) => { sim.requests.push({ kind: 'fetch', url: String(input && input.url ? input.url : input), at: clock.now }); return new Promise(() => {}); };
    window.XMLHttpRequest = class {
      constructor() { this.readyState = 0; this.status = 0; this.responseText = ''; this.response = null; }
      open(method, url) { sim.requests.push({ kind: 'xhr', url: String(url), at: clock.now }); }
      send() {} abort() {} setRequestHeader() {} overrideMimeType() {} addEventListener() {} removeEventListener() {}
      getResponseHeader() { return null; } getAllResponseHeaders() { return ''; }
    };

    /* ── SZIMULÁLT webOS VIDEÓELEM ── */
    const conns = new WeakMap();
    const alive = (conn) => conns.get(conn.video) === conn;
    const fire = (video, name) => {
      sim.events.push({ name, at: clock.now });
      video.dispatchEvent(new window.Event(name, { bubbles: true }));
    };
    const later = (ms, fn) => window.setTimeout(fn, ms);
    const open = (video, url) => {
      const script = Object.assign({ startDelayMs: 1800 }, sim.script ? sim.script(url, sim.loads.length) : {});
      const conn = {
        video, url, script, openedAt: clock.now, pos: 0, started: false, paused: false, ended: false,
        ready: 0, duration: Infinity, error: null, net: 2, stallUntil: 0, stallIndex: 0, frozen: false, pausedOnce: false,
      };
      sim.loads.push({ url, at: clock.now });
      conns.set(video, conn);
      sim.conn = conn;
      later(30, () => { if (alive(conn)) fire(video, 'loadstart'); });
      if (script.neverStarts) return;
      later(script.startDelayMs, () => {
        if (!alive(conn)) return;
        if (script.startError) {
          conn.error = { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' };
          conn.net = 3;
          fire(video, 'error');
          return;
        }
        conn.ready = 4;
        conn.started = true;
        ['loadedmetadata', 'loadeddata', 'canplay', 'playing'].forEach((name) => fire(video, name));
      });
    };
    window.setInterval(() => {
      const conn = sim.conn;
      if (!conn || !alive(conn) || !conn.started || conn.ended || conn.paused || conn.frozen || conn.error) return;
      const script = conn.script;
      if (conn.stallUntil) {
        if (clock.now < conn.stallUntil) return;
        conn.stallUntil = 0;
        conn.ready = 4;
        fire(conn.video, 'playing');
      }
      const stall = (script.stalls || [])[conn.stallIndex];
      if (stall && conn.pos >= stall.atPos) {
        conn.stallIndex += 1;
        conn.stallUntil = clock.now + stall.forMs;
        conn.ready = 2;
        fire(conn.video, 'waiting');
        if (script.stalledDuringStall) later(900, () => { if (alive(conn) && conn.stallUntil) fire(conn.video, 'stalled'); });
        return;
      }
      if (script.freezeAtPos != null && conn.pos >= script.freezeAtPos) {
        conn.frozen = true;
        conn.ready = script.freezeReady != null ? script.freezeReady : 2;
        if (conn.ready < 3) fire(conn.video, 'waiting');
        return;
      }
      if (script.endAtPos != null && conn.pos >= script.endAtPos) {
        conn.ended = true; conn.paused = true; conn.duration = conn.pos; conn.net = 1;
        ['durationchange', 'pause', 'ended'].forEach((name) => fire(conn.video, name));
        return;
      }
      if (script.pauseAtPos != null && !conn.pausedOnce && conn.pos >= script.pauseAtPos) {
        conn.pausedOnce = true; conn.paused = true;
        fire(conn.video, 'pause');
        return;
      }
      conn.pos += 0.25;
      fire(conn.video, 'timeupdate');
      if (script.spuriousStalledEverySeconds && Math.round(conn.pos * 4) % (script.spuriousStalledEverySeconds * 4) === 0) {
        fire(conn.video, 'stalled');
      }
    }, 250);

    const proto = window.HTMLMediaElement.prototype;
    const get = (name, getter) => Object.defineProperty(proto, name, { configurable: true, get: getter });
    get('paused', function paused() { const conn = conns.get(this); return conn ? conn.paused : (this.__paused ?? true); });
    get('ended', function ended() { const conn = conns.get(this); return conn ? conn.ended : false; });
    get('currentSrc', function currentSrc() { return this.getAttribute('src') || ''; });
    get('readyState', function readyState() { const conn = conns.get(this); return conn ? conn.ready : 0; });
    get('networkState', function networkState() { const conn = conns.get(this); return conn ? conn.net : 0; });
    get('error', function error() { const conn = conns.get(this); return conn ? conn.error : null; });
    get('duration', function duration() { const conn = conns.get(this); return conn ? conn.duration : NaN; });
    get('seeking', () => false);
    get('videoWidth', function videoWidth() { const conn = conns.get(this); return conn && conn.started ? 1920 : 0; });
    get('videoHeight', function videoHeight() { const conn = conns.get(this); return conn && conn.started ? 1080 : 0; });
    get('buffered', function buffered() {
      const conn = conns.get(this);
      if (!conn || !conn.started) return { length: 0, start: () => 0, end: () => 0 };
      // A TV-n a raw TS puffer-kijelzése megbízhatatlan: a teszt szándékosan
      // „sok puffert” mutat fagyás közben is – az őr nem dőlhet be neki.
      return { length: 1, start: () => 0, end: () => conn.pos + 30 };
    });
    Object.defineProperty(proto, 'currentTime', {
      configurable: true,
      get() { const conn = conns.get(this); return conn ? conn.pos : 0; },
      set() { /* a raw TS nem seekelhető */ },
    });
    proto.play = function play() {
      this.__paused = false;
      sim.plays.push({ at: clock.now, src: this.getAttribute('src') || '' });
      const conn = conns.get(this);
      if (conn && conn.paused && !conn.ended && conn.script.resumable !== false) {
        conn.paused = false;
        later(20, () => { if (alive(conn)) { fire(this, 'play'); fire(this, 'playing'); } });
      }
      return Promise.resolve();
    };
    proto.pause = function pause() {
      this.__paused = true;
      const conn = conns.get(this);
      if (conn && !conn.paused) {
        conn.paused = true;
        later(10, () => { if (alive(conn)) fire(this, 'pause'); });
      }
    };
    proto.load = function load() {
      const src = this.getAttribute('src');
      if (!src) { conns.delete(this); return; }
      open(this, src);
    };
    proto.canPlayType = () => 'maybe';
    proto.getVideoPlaybackQuality = () => ({ totalVideoFrames: 0, droppedVideoFrames: 0 });
  },
});
const { window } = dom;
const doc = window.document;
const script = doc.createElement('script');
script.textContent = bundle.outputFiles[0].text;
doc.body.appendChild(script);

const clock = window.__clock;
const sim = window.sim;
const timerErrors = [];
const immediate = () => new Promise((done) => setImmediate(done));
let fired = 0;
/** A virtuális óra előretekerése: minden esedékes időzítő sorrendben lefut. */
async function advance(ms) {
  const end = clock.now + ms;
  for (;;) {
    let next = null;
    for (const timer of clock.timers.values()) {
      if (timer.at > end) continue;
      if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer;
    }
    if (!next) break;
    if (next.at > clock.now) clock.now = next.at;
    if (next.repeat) next.at = clock.now + next.repeat; else clock.timers.delete(next.id);
    try { next.fn(...next.args); } catch (error) { timerErrors.push(error); }
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    fired += 1;
    if (fired % 400 === 0) await immediate();
  }
  clock.now = end;
  await immediate();
}

let passed = 0;
let failed = 0;
function check(condition, label, detail = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ HIBA: ${label}${detail ? ` — ${detail}` : ''}`); }
}

const PROVIDERS = {
  A: { id: 'prov-A', host: 'http://162.19.241.120:8080' },
  B: { id: 'prov-B', host: 'http://tv.masik-szolgaltato.example:2095' },
};
let serial = 0;
function makeChannel(provider = 'A', ext = 'ts') {
  serial += 1;
  const info = PROVIDERS[provider];
  return {
    id: `live-${info.id}-${serial}`, name: `Csatorna ${serial} (${provider})`, number: serial,
    streamUrl: `${info.host}/live/user/pass/${1000 + serial}.${ext}`,
  };
}
const liveUrl = (url) => /\/live\//.test(String(url));
/** Új nézési szakasz: friss komponens, üres tároló, megadott szimulátor-forgatókönyv. */
async function start({ provider = 'A', ext = 'ts', settings = {}, scenario = () => ({}), trusted = true } = {}) {
  window.testPlayer.unmount();
  await advance(50);
  window.localStorage.clear();
  sim.loads = []; sim.plays = []; sim.requests = []; sim.events = []; sim.conn = null;
  sim.script = scenario;
  window.testPlayer.trust(trusted);
  const channel = makeChannel(provider, ext);
  const t0 = clock.now;
  window.testPlayer.mount(channel, { tvDoctorEnabled: false, bufferMode: 'balanced', streamFormat: ext === 'm3u8' ? 'hls' : 'ts', ...settings });
  await advance(100);
  return { channel, t0 };
}
const loadTimes = (t0) => sim.loads.map((load) => Math.round((load.at - t0) / 100) / 10);
const watchdogLines = () => window.testPlayer.log().split('\n').filter((line) => /ÉLŐ ŐR: ÚJRACSATLAKOZÁS/.test(line));
const video = () => doc.querySelector('video[data-iptv-player="true"]');

try {
  console.log('\n=== 1. Működő csatorna: indulási megállás után NINCS újratöltés (a felhasználó „rossz” szolgáltatója) ===\n');
  /* #62–#64 naplók: waiting 8,2 mp-nél, magától folytatódik; gyakori 2. megállás 17,7 mp-nél. */
  for (const waitMs of [4724, 9345, 11677, 16809]) {
    const { t0 } = await start({
      scenario: () => ({ stalls: [{ atPos: 8.25, forMs: waitMs }, { atPos: 17.75, forMs: 7900 }], stalledDuringStall: true, spuriousStalledEverySeconds: 7 }),
    });
    await advance(5 * 60 * 1000);
    check(sim.loads.length === 1 && watchdogLines().length === 0,
      `${(waitMs / 1000).toFixed(1)} mp-es természetes megállás + 2. megállás + hamis stalled: egyetlen kapcsolat marad, 5 percig nincs újratöltés`,
      `kapcsolatok=${JSON.stringify(loadTimes(t0))}`);
    check(sim.conn.pos > 250 && video().currentTime === sim.conn.pos && window.testPlayer.isPlaying() === true,
      'a kép a megállások után ugyanazon a kapcsolaton megy tovább');
  }

  console.log('\n=== 2. Raw élő címre nincs második kérés (egykapcsolatos szolgáltató) ===\n');
  {
    await start({ scenario: () => ({}) });
    await advance(60 * 1000);
    const extra = sim.requests.filter((request) => liveUrl(request.url));
    check(extra.length === 0,
      'TS élő adás mellett 60 mp alatt EGYETLEN XHR/fetch sem megy a stream címére (a 3,5 mp-es fejlécpróba megszűnt; kézi naplózás mellett sem)',
      JSON.stringify(extra));
    check(sim.loads.length === 1, 'a szolgáltató felé pontosan egy kapcsolat él');
  }

  console.log('\n=== 3. Hosszú, hibátlan nézés: 30 perc és 2 óra ===\n');
  {
    const { t0 } = await start({ scenario: () => ({ spuriousStalledEverySeconds: 5 }) });
    await advance(30 * 60 * 1000);
    check(sim.loads.length === 1 && watchdogLines().length === 0,
      '30 perc folyamatos adás 5 mp-enkénti hamis `stalled` eseménnyel: 0 újratöltés', JSON.stringify(loadTimes(t0)));
    await advance(90 * 60 * 1000);
    check(sim.loads.length === 1 && watchdogLines().length === 0 && sim.conn.pos > 7100,
      '2 óra folyamatos adás: 0 újratöltés, ugyanaz az egy kapcsolat (a felhasználó mérése)', `pos=${sim.conn.pos}`);
    check(sim.requests.filter((request) => liveUrl(request.url)).length === 0, '2 óra alatt sem nyílt második kérés a stream címére');
  }

  console.log('\n=== 4. Valódi lefagyás: `ended` – a szolgáltató lezárta a kapcsolatot (#52: 31,65 mp) ===\n');
  {
    const { t0, channel } = await start({ scenario: (url, index) => (index === 0 ? { endAtPos: 31.75 } : {}) });
    await advance(31.75 * 1000 + 1800 + 200);
    check(sim.conn.ended === true && sim.loads.length === 1, 'a szimulált TV `ended` állapotba került (paused=true, duration=currentTime)');
    const endedAt = clock.now;
    await advance(6000);
    check(sim.loads.length === 2, 'az élő őr újracsatlakozott', JSON.stringify(loadTimes(t0)));
    const gap = sim.loads[1] ? sim.loads[1].at - endedAt : -1;
    check(gap >= 0 && gap <= 3000, `az új kapcsolat ${gap} ms-on belül megnyílt (nem marad fagyott kép)`);
    check(sim.loads[1] && sim.loads[1].url === channel.streamUrl, 'ugyanarra a címre csatlakozik vissza (nincs formátumváltás)');
    await advance(60 * 1000);
    check(sim.loads.length === 2 && sim.conn.pos > 40 && !sim.conn.ended, 'az újracsatlakozás után az adás megy tovább, további újratöltés nélkül');
    check(window.testPlayer.isPlaying() === true && !window.testPlayer.setPlayingCalls().includes(false),
      'a lejátszó közben egyszer sem került „szünet” állapotba (régen itt ragadt be végleg)', JSON.stringify(window.testPlayer.setPlayingCalls()));
    check(watchdogLines().length === 1 && /élő adás vége/.test(watchdogLines()[0]), 'a naplóban egyetlen, okkal ellátott ÉLŐ ŐR sor van');
  }

  console.log('\n=== 5. Valódi lefagyás: néma megállás (se esemény, se hiba) – a felhasználó „befagyó” szolgáltatója ===\n');
  for (const freezeReady of [2, 4]) {
    const { t0, channel } = await start({ scenario: (url, index) => (index === 0 ? { freezeAtPos: 40, freezeReady } : {}) });
    await advance(1800 + 40000 + 300);
    const frozenAt = clock.now;
    check(sim.conn.frozen === true, `a kép megállt 40 mp-nél (readyState=${freezeReady}, a „puffer” közben 30 mp-et mutat)`);
    await advance(window.testPlayer.defaults.stallReconnectMs - 3000);
    check(sim.loads.length === 1, `${(window.testPlayer.defaults.stallReconnectMs - 3000) / 1000} mp megállásnál még NINCS újratöltés (türelmes határ)`);
    await advance(6000);
    check(sim.loads.length === 2 && sim.loads[1].url === channel.streamUrl, 'a határ után az őr ugyanarra a címre újracsatlakozik', JSON.stringify(loadTimes(t0)));
    const reaction = sim.loads[1] ? sim.loads[1].at - frozenAt : -1;
    check(reaction >= window.testPlayer.defaults.stallReconnectMs - 600 && reaction <= window.testPlayer.defaults.stallReconnectMs + 3000,
      `a helyreállítás ${Math.round(reaction / 100) / 10} mp megállás után indult`);
    await advance(3 * 60 * 1000);
    check(sim.loads.length === 2 && sim.conn.pos > 150, 'utána az adás 3 percig megy, újabb újratöltés nélkül');
    check(window.testPlayer.isPlaying() === true, 'a lejátszó állapota végig „lejátszás”');
  }

  console.log('\n=== 6. Váratlan pause ===\n');
  {
    const { t0 } = await start({ scenario: () => ({ pauseAtPos: 20, resumable: true }) });
    await advance(1800 + 20000 + 300);
    check(video().paused === true, 'a TV váratlanul szünetbe tette az adást');
    const playsBefore = sim.plays.length;
    await advance(4000);
    check(sim.plays.length > playsBefore && video().paused === false && sim.loads.length === 1,
      'az őr HELYBEN folytatta (`play()`), újratöltés nélkül', JSON.stringify(loadTimes(t0)));
    check(window.testPlayer.isPlaying() === true, 'a lejátszó nem ragadt „szünet” állapotban');
    await advance(60000);
    check(sim.loads.length === 1 && sim.conn.pos > 60, 'utána normálisan megy tovább');
  }
  {
    const { t0 } = await start({ scenario: (url, index) => (index === 0 ? { pauseAtPos: 20, resumable: false } : {}) });
    await advance(1800 + 20000 + 300);
    const pausedAt = clock.now;
    await advance(6000);
    check(sim.loads.length === 1, 'beragadt pause: 6 mp-ig csak helyi folytatási próbák vannak');
    await advance(8000);
    check(sim.loads.length === 2, 'tartós (≈10 mp) szünet után újracsatlakozik', JSON.stringify(loadTimes(t0)));
    const reaction = sim.loads[1] ? sim.loads[1].at - pausedAt : -1;
    check(reaction >= 9000 && reaction <= 13500, `az újracsatlakozás ${Math.round(reaction / 100) / 10} mp után jött`);
  }

  console.log('\n=== 7. A néző által kért szünet tiszteletben tartása ===\n');
  {
    await start({ scenario: () => ({}) });
    await advance(30000);
    window.testPlayer.setPlaying(false);
    await advance(500);
    check(video().paused === true, 'a néző szünetet kért, a videó megállt');
    const playsBefore = sim.plays.length;
    await advance(10 * 60 * 1000);
    check(sim.loads.length === 1 && sim.plays.length === playsBefore && video().paused === true,
      '10 perc kért szünet alatt az őr sem folytatást, sem újratöltést nem kért');
    window.testPlayer.setPlaying(true);
    await advance(20000);
    check(video().paused === false && sim.loads.length === 1, 'a néző folytatja: az adás megy tovább, az őr nem tölt újra');
  }

  console.log('\n=== 8. El sem induló adás ===\n');
  {
    const { t0 } = await start({ scenario: (url, index) => (index === 0 ? { neverStarts: true } : {}) });
    await advance(25000);
    check(sim.loads.length === 1, '25 mp-ig türelmesen vár (nincs elhamarkodott újratöltés)');
    await advance(10000);
    check(sim.loads.length === 2, '30 mp után újrapróbálja', JSON.stringify(loadTimes(t0)));
    await advance(60000);
    check(sim.loads.length === 2 && sim.conn.pos > 40, 'a második próbán elindult adás megy tovább');
  }

  console.log('\n=== 9. Azonos viselkedés: TV Doktor be/ki × pufferprofil × szolgáltató ===\n');
  const scenarios = {
    'természetes megállás (16,8 mp)': { script: () => ({ stalls: [{ atPos: 8.25, forMs: 16809 }, { atPos: 17.75, forMs: 7900 }] }), runMs: 120000 },
    'ended 31,75 mp-nél': { script: (url, index) => (index === 0 ? { endAtPos: 31.75 } : {}), runMs: 120000 },
    'néma lefagyás 40 mp-nél': { script: (url, index) => (index === 0 ? { freezeAtPos: 40, freezeReady: 4 } : {}), runMs: 150000 },
  };
  for (const [label, item] of Object.entries(scenarios)) {
    const timelines = [];
    for (const provider of ['A', 'B']) {
      for (const tvDoctorEnabled of [false, true]) {
        for (const bufferMode of ['fast', 'balanced', 'stable']) {
          const { t0, channel } = await start({ provider, settings: { tvDoctorEnabled, bufferMode }, scenario: item.script });
          await advance(item.runMs);
          const sameUrl = sim.loads.every((load) => load.url === channel.streamUrl);
          const extra = sim.requests.filter((request) => liveUrl(request.url)).length;
          timelines.push({ key: `${provider}/${tvDoctorEnabled ? 'Doktor be' : 'Doktor ki'}/${bufferMode}`, loads: sim.loads.length, at: loadTimes(t0), sameUrl, extra, playing: window.testPlayer.isPlaying(), pos: sim.conn.pos });
        }
      }
    }
    const first = timelines[0];
    const sameCount = timelines.every((entry) => entry.loads === first.loads);
    // A recovery saját (profil szerinti) rövid késleltetése legfeljebb ±1,5 mp eltérést adhat.
    const sameTiming = timelines.every((entry) => entry.at.every((value, index) => Math.abs(value - first.at[index]) <= 1.5));
    check(sameCount && sameTiming,
      `${label}: mind a 12 kombinációban ugyanannyi kapcsolat (${first.loads}) ugyanakkor`,
      JSON.stringify(timelines.map((entry) => [entry.key, entry.at])));
    check(timelines.every((entry) => entry.sameUrl && entry.extra === 0 && entry.playing === true && entry.pos > 30),
      `${label}: mindenhol ugyanaz a cím, nincs második kérés, a végén megy az adás`,
      JSON.stringify(timelines.filter((entry) => !(entry.sameUrl && entry.extra === 0 && entry.playing && entry.pos > 30))));
  }

  console.log('\n=== 10. Csatornaváltás: az őr nulláról mér ===\n');
  {
    let firstUrl = '';
    const { channel } = await start({
      scenario: (url) => {
        if (!firstUrl) firstUrl = url;
        return url === firstUrl ? { freezeAtPos: 30 } : { stalls: [{ atPos: 8.25, forMs: 16809 }] };
      },
    });
    await advance(1800 + 30000 + 20000);
    check(firstUrl === channel.streamUrl, 'az első csatorna a saját címén indult');
    check(sim.loads.length === 1 && sim.conn.frozen, 'az első csatorna 20 mp óta áll (az őr még vár)');
    const next = makeChannel('B', 'ts');
    window.testPlayer.update(next, { tvDoctorEnabled: false, bufferMode: 'balanced', streamFormat: 'ts' });
    await advance(200);
    check(sim.loads.length === 2 && sim.loads[1].url === next.streamUrl, 'a néző csatornát váltott (másik szolgáltató csatornája)');
    await advance(2 * 60 * 1000);
    check(sim.loads.length === 2 && sim.conn.pos > 80,
      'az új csatorna 16,8 mp-es természetes megállását az előző csatornán felgyűlt 20 mp NEM terheli – nincs újratöltés',
      `kapcsolatok=${sim.loads.length}`);
  }

  console.log('\n=== 11. Óránként lezáró szolgáltató: kikapcsolt TV Doktorral sem jön „nem működik” hiba ===\n');
  {
    const { channel } = await start({ settings: { tvDoctorEnabled: false }, scenario: () => ({ endAtPos: 60 }) });
    await advance(10 * 60 * 1000);
    const text = doc.getElementById('root').textContent || '';
    check(sim.loads.length >= 8, `10 perc alatt ${sim.loads.length - 1} lezárás után mindig visszacsatlakozott`);
    check(sim.loads.every((load) => load.url === channel.streamUrl), 'mindig ugyanarra a címre (az egészséges szakaszok nullázzák a számlálót, nincs formátumváltás)');
    check(!/nem működik/.test(text) && window.testPlayer.isPlaying() === true,
      'nincs „A csatorna jelenleg nem működik” hibaképernyő, a lejátszó megy tovább');
  }

  console.log('\n=== 12. HLS élő adás ===\n');
  {
    const { t0 } = await start({ ext: 'm3u8', scenario: (url, index) => (index === 0 ? { stalls: [{ atPos: 12, forMs: 9000 }], freezeAtPos: 50 } : {}) });
    await advance(1800 + 12000 + 9000 + 38000 + 500);
    check(sim.loads.length === 1, 'HLS-en a rövid újrapufferelés sem tölt újra');
    await advance(window.testPlayer.defaults.stallReconnectMs + 4000);
    check(sim.loads.length === 2, 'HLS-en a valódi megállást ugyanúgy helyreállítja', JSON.stringify(loadTimes(t0)));
  }

  check(timerErrors.length === 0, 'a szimuláció közben egyetlen időzítő sem dobott kivételt', timerErrors.map((error) => String(error && error.stack ? error.stack : error)).slice(0, 2).join(' | '));
} finally {
  window.testPlayer.unmount();
  window.close();
}

console.log(`\n=== EREDMÉNY: ${passed}/${passed + failed} ellenőrzés ===`);
if (failed) process.exit(1);
console.log('OK: az élő őr a valódi lejátszóban működő adást nem tölt újra, a lefagyottat helyreállítja – TV Doktortól, pufferprofiltól és szolgáltatótól függetlenül.');
