#!/usr/bin/env node
/*
 * VIDEOPLAYER – VALÓDI FUTÁSIDEJŰ TESZT (jsdom + React).
 *
 * Nem forrásszöveget nézünk, hanem a TÉNYLEGES React komponenst futtatjuk
 * (esbuild-del csomagolva). A HTMLMediaElement-et a TV viselkedésére utánozzuk:
 *   • `play()` / `pause()` / `load()` hívásokat számoljuk,
 *   • képkocka-számlálót adunk (webOS élő adásnál a currentTime 0 marad),
 *   • késve érkező `pause`, `waiting`, `error`, `ended` eseményeket küldünk.
 *
 * Ezek a tesztek a két konkrét TV-hibát fogják meg:
 *   1. kép eltűnik újracsatlakozáskor, miközben a hang megy (fekete overlay),
 *   2. a film indulás után megáll / újratöltődik, és nem indul újra magától.
 *
 * Futtatás: node tools/test-player-runtime.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve('.');
const results = [];
let failed = false;

function check(ok, message) {
  const line = `${ok ? 'ok  ' : 'FAIL'} – ${message}`;
  results.push(line);
  console.log(line);
  if (!ok) failed = true;
}

function finish() {
  console.log(failed ? '\nHIBA: a VideoPlayer futásidejű tesztje nem futott át.'
    : '\nOK: a VideoPlayer futásidejű tesztje minden ellenőrzésen átment.');
  process.exit(failed ? 1 : 0);
}

const killer = setTimeout(() => {
  check(false, 'a futásidejű teszt 90 mp alatt nem fejeződött be');
  finish();
}, 90000);
killer.unref?.();

let JSDOM, VirtualConsole, esbuild;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
  esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
} catch (error) {
  console.log('KIPARANCSOLT: jsdom vagy esbuild hiányzik – npm install (gyökér + web)');
  clearTimeout(killer);
  process.exit(0);
}

/* ── 1. React-harness összecsomagolása a VALÓDI komponensből ──────────── */
const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VideoPlayer } from './web/src/components/VideoPlayer.tsx';
import { FullscreenLiveOsd } from './web/src/components/ChannelControls.tsx';
import { INITIAL_SETTINGS } from './web/src/data/mockData.ts';
import { startManualLogging, stopManualLogging, getAppLogText } from './web/src/services/appLog.ts';
import { attachSpeedDiagnostics } from './web/src/services/speedDiagnostics.ts';
attachSpeedDiagnostics();

let root = null;
let currentProps = {};
let setHarnessPlaying = null;
const spy = window.__MEDIA_SPY__;

function Harness(props) {
  const [isPlaying, setIsPlaying] = useState(true);
  setHarnessPlaying = setIsPlaying;
  return React.createElement(React.Fragment, null, React.createElement(VideoPlayer, {
    ...props,
    isPlaying: isPlaying,
    setIsPlaying: (value) => {
      spy.setIsPlaying.push(typeof value === 'function' ? 'fn' : value);
      setIsPlaying(value);
    },
    volume: 0.5,
    onVolumeChange: () => {},
    onToggleMute: () => {},
    settings: Object.assign({}, INITIAL_SETTINGS, props.settings || {}),
    playbackActive: props.playbackActive === undefined ? true : props.playbackActive,
    onEnded: () => { spy.onEnded += 1; },
  }), props.keepFullscreenOsdMounted ? React.createElement(FullscreenLiveOsd, { channel: props.channel }) : null);
}

window.__IPTV_TEST__ = {
  mount(props) {
    if (root) { root.unmount(); root = null; }
    currentProps = props || {};
    const el = document.getElementById('root');
    root = createRoot(el);
    root.render(React.createElement(Harness, currentProps));
  },
  update(props) {
    currentProps = Object.assign({}, currentProps, props || {});
    if (root) root.render(React.createElement(Harness, currentProps));
  },
  setPlaying(value) { if (setHarnessPlaying) setHarnessPlaying(value); },
  // Kézi hibakeresési napló – a képminőség-minta ellenőrzéséhez.
  startLogging() { return startManualLogging(); },
  stopLogging() { return stopManualLogging('teszt leállítás'); },
  logText() { return getAppLogText(); },
  unmount() { if (root) { root.unmount(); root = null; } },
};
`;

const outDir = path.resolve('build/test');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'player-runtime-bundle.js');
try {
  await esbuild.build({
    stdin: {
      contents: harness,
      resolveDir: ROOT,
      sourcefile: 'player-harness.tsx',
      loader: 'tsx',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    jsx: 'automatic',
    nodePaths: [path.resolve('web/node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' },
    outfile: outFile,
    logLevel: 'silent',
  });
} catch (error) {
  check(false, 'a React-komponens csomagolása sikertelen: ' + ((error && error.stack) ? error.stack.slice(0, 1200) : String(error)));
  console.error(error);
  clearTimeout(killer);
  finish();
}

/* ── 2. Böngésző-környezet webOS-szerű médiaelem-mockkal ──────────────── */
const vc = new VirtualConsole();
vc.on('jsdomError', () => { /* a hiányzó TV-API-k nem érdekelnek */ });
vc.on('error', () => { /* a React figyelmeztetései nem buktatják a tesztet */ });

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/index.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.__IPTV_DIRECT_LIVE_ZAP_TEST__ = false; // a régi recovery/fallback regressziós tesztjeihez
    const spy = { play: 0, pause: 0, load: 0, setIsPlaying: [], onEnded: 0 };
    window.__MEDIA_SPY__ = spy;
    const proto = window.HTMLMediaElement.prototype;
    Object.defineProperty(proto, 'paused', {
      configurable: true,
      get() { return this.__paused === undefined ? true : this.__paused; },
    });
    proto.play = function () {
      this.__paused = false;
      spy.play += 1;
      return Promise.resolve();
    };
    proto.pause = function () {
      this.__paused = true;
      spy.pause += 1;
    };
    proto.load = function () { spy.load += 1; };
    Object.defineProperty(proto, 'currentSrc', {
      configurable: true,
      get() { return this.getAttribute('src') || ''; },
    });
    Object.defineProperty(proto, 'readyState', { configurable: true, get() { return 4; } });
    Object.defineProperty(proto, 'networkState', { configurable: true, get() { return 2; } });
    Object.defineProperty(proto, 'error', { configurable: true, get() { return null; } });
    Object.defineProperty(proto, 'duration', { configurable: true, writable: true, value: 3600 });
    Object.defineProperty(proto, 'buffered', {
      configurable: true,
      get() { return { length: 1, end: () => 30 }; },
    });
    // A dekódolt képkockák mindig haladnak, mint egy egészséges TV-adásnál:
    // így a figyelő maga nem indít újracsatlakozást a rövid teszt alatt.
    proto.getVideoPlaybackQuality = () => ({ totalVideoFrames: Date.now() });
    proto.canPlayType = () => 'maybe';
    window.fetch = () => new Promise(() => {});
    window.XMLHttpRequest = class {
      open() {} send() {} abort() {} setRequestHeader() {}
      addEventListener() {} removeEventListener() {}
    };
    window.alert = () => {};
    window.confirm = () => true;
    window.prompt = () => null;
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = () => ({
        matches: false, media: '', onchange: null,
        addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      });
    }
  },
});

const { window } = dom;
const doc = window.document;
// A valós, célzott CSS-szabályt alkalmazzuk az igazi React-lejátszóra és
// FullscreenLiveOsd-re; a teszt a késlekedő App-komponens OSD-jét szimulálja.
const css = fs.readFileSync(path.resolve('web/src/index.css'), 'utf8');
const fullscreenOsdRule = css.match(/body:not\(\.iptv-tv-fullscreen\)\s*\[data-fullscreen-osd\]\s*\{[^}]*\}/)?.[0];
if (!fullscreenOsdRule) { check(false, 'hiányzik a fullscreen OSD védő CSS-szabály'); clearTimeout(killer); finish(); }
const style = doc.createElement('style');
style.textContent = fullscreenOsdRule;
doc.head.appendChild(style);
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const video = () => doc.querySelector('video[data-iptv-player="true"]');
const fire = (element, type) => element.dispatchEvent(new window.Event(type, { bubbles: true }));

async function waitFor(predicate, timeoutMs = 5000, label = 'feltétel') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick(25);
  }
  console.log('  (időtúllépés: ' + label + ')');
  return false;
}

/* A bundle betöltése és a React felépülése. */
const script = doc.createElement('script');
script.textContent = fs.readFileSync(outFile, 'utf8');
doc.body.appendChild(script);

check(typeof window.__IPTV_TEST__?.mount === 'function', 'a valódi VideoPlayer bundle betöltődik és mountolható');

const LIVE = {
  id: 'ch-atv',
  name: '[HU] ATV',
  streamUrl: 'http://panel.example/live/user/pass/1001.ts',
  logo: '',
  group: 'HU',
};
const VOD_URL = 'http://panel.example/movie/user/pass/4242.mkv';

/* ── 3. ÉLŐ TV: késői pause esemény nem állítja meg az új streamet ────── */
window.__IPTV_TEST__.mount({ channel: LIVE });
check(await waitFor(() => Boolean(video()), 5000, 'videóelem'), 'az élő lejátszó létrehozza a HTML5 videóelemet');
check(await waitFor(() => window.__MEDIA_SPY__.play > 0, 3000, 'első play()'), 'az élő adás azonnal play()-t hív (nincs fix várakozás)');
check(String(video()?.getAttribute('src') || '').includes('1001.ts'), 'az első próba a megjegyzett/eredeti MPEG-TS cím');

fire(video(), 'playing');
await tick(80);
const pauseBeforeStale = window.__MEDIA_SPY__.pause;
// A régi forrásból késve érkező pause esemény: a videó MÁR játszik.
fire(video(), 'pause');
await tick(120);
check(window.__MEDIA_SPY__.pause === pauseBeforeStale,
  'a késve érkező pause esemény NEM állítja meg a már futó csatornát');
check(!window.__MEDIA_SPY__.setIsPlaying.includes(false),
  'a belső pause nem ír át false-ra a lejátszási szándékot');

/* ── 3b. TÁVIRÁNYÍTÓ: Play / Pause továbbra is működik ────────────────── */
const pauseBeforeRemote = window.__MEDIA_SPY__.pause;
window.__IPTV_TEST__.setPlaying(false);
await tick(100);
check(window.__MEDIA_SPY__.pause > pauseBeforeRemote,
  'a távirányító Pause gombja valóban megállítja a videót');
const playBeforeRemote = window.__MEDIA_SPY__.play;
window.__IPTV_TEST__.setPlaying(true);
await tick(100);
check(window.__MEDIA_SPY__.play > playBeforeRemote,
  'a távirányító Play gombja valóban újraindítja a videót');

/* ── 3c. GYORS CSATORNAVÁLTÁS: az új cím azonnal, újrahívás nélkül ───── */
const playBeforeZap = window.__MEDIA_SPY__.play;
const zapStartedAt = Date.now();
window.__IPTV_TEST__.update({ channel: { ...LIVE, id: 'ch-duna', name: 'Duna', streamUrl: 'http://panel.example/live/user/pass/2002.ts' } });
const zapOk = await waitFor(() => String(video()?.getAttribute('src') || '').includes('2002.ts'), 2000, 'új csatorna');
check(zapOk, 'a csatornaváltás AZONNAL átírja a videó forrását');
check(Date.now() - zapStartedAt < 1000, `nincs beépített várakozás a váltásnál (${Date.now() - zapStartedAt} ms)`);
await tick(100);
check(window.__MEDIA_SPY__.play > playBeforeZap, 'az új csatornát azonnal elindítja');
fire(video(), 'playing');
await tick(60);

/* ── 4. Pufferelésnél NEM tűnik el a kép (nincs fekete takaróréteg) ──── */
fire(video(), 'waiting');
await tick(80);
check(doc.querySelector('.bg-black.z-10') === null,
  'van képkocka után a pufferelés NEM tesz fekete réteget a képre');
check(/Pufferelés|Újracsatlakozás/.test(doc.body.textContent || ''),
  'helyette egy kis, átlátszó állapotjelző jelenik meg');
fire(video(), 'playing');
await tick(60);

/* ── 5. Élő streamhiba után automatikusan újracsatlakozik ─────────────── */
const playBeforeError = window.__MEDIA_SPY__.play;
const srcBeforeError = video()?.getAttribute('src');
fire(video(), 'error');
await tick(80);
check(!/A csatornát nem lehet be tölteni/.test(doc.body.textContent || ''),
  'egyetlen streamhiba NEM eredményez végleges fekete hibaképernyőt');
check(await waitFor(() => window.__MEDIA_SPY__.play > playBeforeError, 4000, 'élő újracsatlakozás'),
  'a streamhiba után magától újraindul a lejátszás');
check(video()?.getAttribute('src') === srcBeforeError,
  'az első két újrapróba UGYANAZT a címet használja (nincs felesleges formátumugrás)');

window.__IPTV_TEST__.unmount();
await tick(80);

/* ── 6. VOD: korai ended → visszaállás a pozícióra, nem „következő rész” ─ */
const spy = window.__MEDIA_SPY__;
spy.onEnded = 0;
spy.load = 0;
const playBeforeVod = spy.play;
const vodVisibility = [];
let toggleVodOverlay = null;
window.__IPTV_TEST__.mount({ channel: LIVE, customStreamUrl: VOD_URL, customTitle: 'Teszt film',
  onOverlayVisibilityChange: (visible) => vodVisibility.push(visible),
  onRegisterOsdToggle: (toggle) => { toggleVodOverlay = toggle; } });
check(await waitFor(() => Boolean(video()), 5000, 'VOD videóelem'), 'a film/sorozat lejátszó is létrejön');
check(String(video()?.getAttribute('src') || '') === VOD_URL, 'a VOD az EREDETI címet tölti (nincs .mkv → .m3u8 átírás)');
check(await waitFor(() => !!toggleVodOverlay && doc.querySelector('[data-tv-player]')?.classList.contains('iptv-fs')), 'a VOD OSD kapcsolója regisztrálva van');
// A fullscreen kezdeti effektje először megnyitja az OSD-t; ne versenyezzünk vele.
await tick(200);
check(vodVisibility.at(-1) === true, 'a VOD OSD kezdetben látható');
toggleVodOverlay();
check(await waitFor(() => vodVisibility.at(-1) === false), 'a VOD OSD elrejtése továbbra is false jelzést ad');
toggleVodOverlay();
check(await waitFor(() => vodVisibility.at(-1) === true), 'a VOD OSD visszakapcsolása továbbra is true jelzést ad');
fire(video(), 'playing');
await tick(80);

try { video().currentTime = 100; } catch { /* jsdom */ }
fire(video(), 'timeupdate');
await tick(40);
const loadsBeforeEnd = spy.load;
fire(video(), 'ended');
await tick(80);
check(spy.onEnded === 0, 'a film KÖZEPÉN jövő ended NEM indítja a következő részt');
check(await waitFor(() => spy.load > loadsBeforeEnd, 4000, 'VOD visszaállítás'),
  'a korai ended után a lejátszó magától újratölti ugyanazt a címet');
fire(video(), 'loadedmetadata');
await tick(80);
check(Math.abs(Number(video()?.currentTime || 0) - 100) < 2,
  'a visszaállítás a legutolsó ismert pozícióról (100 mp) folytatja');
check(spy.play > playBeforeVod, 'a visszaállítás után újra play() fut');

/* ── 7. VOD: a VALÓDI filmvég továbbra is jelzést ad ─────────────────── */
try { video().currentTime = 3599; } catch { /* jsdom */ }
fire(video(), 'timeupdate');
await tick(40);
fire(video(), 'ended');
await tick(80);
check(spy.onEnded === 1, 'a film tényleges VÉGÉN viszont meghívódik az onEnded (következő rész)');

/* ── 8. VOD hiba esemény: nincs végleges hibaképernyő ─────────────────── */
const loadsBeforeVodError = spy.load;
fire(video(), 'error');
await tick(80);
check(!/A csatornát nem lehet be tölteni/.test(doc.body.textContent || ''),
  'a VOD hibája sem ír ki végleges fekete hibaképernyőt');
check(await waitFor(() => spy.load > loadsBeforeVodError, 4000, 'VOD hiba utáni újrapróba'),
  'a VOD hiba után is automatikusan újrapróbálkozik');

window.__IPTV_TEST__.unmount();
await tick(80);

/* ── 9. Automatikus magyar hangsáv NEM tölti újra a filmet ─────────────── */
const tracks = [
  { label: 'English', language: 'en', get enabled() { return true; }, set enabled(_value) {} },
  { label: 'Magyar', language: 'hu', get enabled() { return false; }, set enabled(_value) {} },
];
window.__IPTV_TEST__.mount({
  channel: LIVE,
  customStreamUrl: VOD_URL,
  customTitle: 'Kétnyelvű film',
  settings: { preferredAudioLang: 'Magyar' },
});
check(await waitFor(() => Boolean(video()), 5000, 'kétnyelvű film'), 'a kétnyelvű film is elindul');
const v = video();
Object.defineProperty(v, 'audioTracks', {
  configurable: true,
  get() { return tracks; },
});
fire(v, 'playing');
await tick(50);
// A hangsávlista késve érkezik meg a TV-ről.
fire(v, 'loadedmetadata');
await tick(80);
const loadsBeforeAudio = spy.load;
await tick(700);
check(spy.load === loadsBeforeAudio,
  'az AUTOMATIKUS (magyar) hangsávválasztás NEM nyitja újra a forrást – a film nem áll meg');

window.__IPTV_TEST__.unmount();
await tick(80);

/* ── 10. Célzott sebességmérés: manuális indítás futó adás mellett ── */
window.__IPTV_TEST__.mount({ channel: LIVE });
check(await waitFor(() => Boolean(video()), 5000, 'sebességmérés videó'), 'a sebességméréshez létrejön a videóelem');
const testVideo = video();
fire(testVideo, 'playing');
window.__IPTV_TEST__.startLogging();
fire(testVideo, 'waiting');
await tick(50);
fire(testVideo, 'playing');
const speedLog = window.__IPTV_TEST__.logText();
check(/már futó lejátszás megfigyelése/.test(speedLog), 'a kézi indítás megfigyeli a már futó adást');
check(/média waiting/.test(speedLog) && /média playing.*várakozás=/.test(speedLog), 'a pufferelés kezdete és időtartama bekerül a naplóba');
check(!/KÉPMINŐSÉG;/.test(speedLog), 'a felesleges képminőség-mintavétel nem fut');
window.__IPTV_TEST__.stopLogging();
window.__IPTV_TEST__.unmount();
await tick(80);

/* Az igazi lejátszó gyors BE–KI–BE váltása: a régi EPG/fókusz callback
 * nem futhat le az új teljes képernyő alatt. A rAF-et kézzel léptetjük. */
let surfaceZap = 0;
const liveHomeOsdVisibility = [];
window.__IPTV_TEST__.mount({ channel: LIVE, keepFullscreenOsdMounted: true, onPrevChannel: () => surfaceZap++, onNextChannel: () => surfaceZap++, onOverlayVisibilityChange: (visible) => liveHomeOsdVisibility.push(visible) });
check(await waitFor(() => Boolean(video()), 5000, 'fullscreen teszt videó'), 'fullscreen teszthez élő videó létrejön');
await tick(100);
const surface = doc.querySelector('[data-tv-player]');
surface.dispatchEvent(new window.MouseEvent('mousedown', {bubbles:true, clientY:200}));
surface.dispatchEvent(new window.MouseEvent('mouseup', {bubbles:true, clientY:20}));
surface.dispatchEvent(new window.MouseEvent('click', {bubbles:true}));
surface.dispatchEvent(new window.MouseEvent('click', {bubbles:true}));
surface.dispatchEvent(new window.Event('touchstart', {bubbles:true}));
surface.dispatchEvent(new window.Event('touchend', {bubbles:true}));
await tick(350);
check(surfaceZap === 0 && !surface.classList.contains('iptv-fs'),
  'a videófelület érintése, dupla kattintása és húzása nem vált módot vagy csatornát');
const savedRaf = window.requestAnimationFrame;
const savedCancel = window.cancelAnimationFrame;
let frameId = 0;
const frames = new Map();
window.requestAnimationFrame = (fn) => { frames.set(++frameId, fn); return frameId; };
window.cancelAnimationFrame = (id) => frames.delete(id);
const nextFrame = () => { const batch = [...frames.values()]; frames.clear(); for (const fn of batch) fn(window.performance.now()); };
let restores = 0;
let focusList = 0;
const onRestore = () => { restores++; };
const onFocus = () => { focusList++; };
window.addEventListener('iptv-player-restored', onRestore);
window.addEventListener('iptv-focus-selected-channel', onFocus);
const player = () => doc.querySelector('[data-tv-player]');
const originalVideo = video();
const originalSrc = originalVideo.getAttribute('src');
const playBeforeFullscreen = spy.play;
const enter = () => window.dispatchEvent(new window.CustomEvent('iptv-enter-fullscreen'));
const exit = () => player().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
enter();
check(await waitFor(() => player()?.classList.contains('iptv-fs')), 'belépéskor fullscreen osztály');
const fullscreenOsd = () => doc.querySelector('[data-fullscreen-osd]');
check(!!fullscreenOsd() && window.getComputedStyle(fullscreenOsd()).display !== 'none', 'a valódi fullscreen OSD teljes képernyőn látható');
await tick(40);
check(doc.querySelector('[data-player-osd]')?.classList.contains('invisible'), 'az élő lejátszó saját overlaye teljes képernyőn rejtett');
check(liveHomeOsdVisibility.length > 0 && liveHomeOsdVisibility.every(Boolean), 'élő teljes képernyőn a főoldali OSD nem kap display:none jelzést');
exit();
check(await waitFor(() => !player()?.classList.contains('iptv-fs')), 'kilépéskor a fullscreen osztály azonnal eltűnik');
check(!!fullscreenOsd() && window.getComputedStyle(fullscreenOsd()).display === 'none', 'a még mountolt fullscreen OSD és árnyéka azonnal eltűnik');
await tick(40);
enter();
check(await waitFor(() => player()?.classList.contains('iptv-fs')), 'gyors visszalépés után ismét fullscreen');
check(!!fullscreenOsd() && window.getComputedStyle(fullscreenOsd()).display !== 'none', 'gyors új belépéskor a fullscreen OSD ismét látható');
await tick(40);
nextFrame(); nextFrame(); nextFrame();
check(restores === 0 && focusList === 0, 'az elavult visszatérés nem indít EPG-t és nem viszi el a fókuszt');
check(video() === originalVideo && video().getAttribute('src') === originalSrc && spy.play === playBeforeFullscreen,
  'váltás közben ugyanaz a videó és stream marad, új play nélkül');
player().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
check(await waitFor(() => !player()?.classList.contains('iptv-fs')), 'Vissza gombbal a második kilépés is megtörtént');
check(!!fullscreenOsd() && window.getComputedStyle(fullscreenOsd()).display === 'none', 'második kilépéskor sem szivárog át az OSD');
await tick(40);
nextFrame();
check(restores === 0, 'az EPG nem indul újra az első rAF-nál');
nextFrame();
check(restores === 1 && focusList === 1, 'a tényleges visszatérés után a fókusz és az EPG egyszer helyreáll');
check(liveHomeOsdVisibility.every(Boolean), 'gyors élő BE–KI–BE váltáskor is végig megmarad az OSD helye');
window.removeEventListener('iptv-player-restored', onRestore);
window.removeEventListener('iptv-focus-selected-channel', onFocus);
window.__IPTV_TEST__.unmount();
window.requestAnimationFrame = savedRaf;
window.cancelAnimationFrame = savedCancel;
try { fs.rmSync(outFile, { force: true }); } catch { /* nem kritikus */ }
clearTimeout(killer);
try { window.close(); } catch { /* nem kritikus */ }
finish();
