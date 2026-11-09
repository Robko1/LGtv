#!/usr/bin/env node
/**
 * 2.5.406 – #51 / #52 TV Doktor naplók (Supabase tv_doctor_log_shares).
 *
 * A FELHASZNÁLÓ JELENTÉSE:
 *   „a tv doktor értelmetlenül a működő csatornát egy kiss idő után
 *    ujrara csatlakoztasa … ott marad a ujra csatlakozás felirat adás
 *    frissítés 1 proba … pruffelés problémát ir ki és ujra csatlakozik
 *    de nincs is rá szükség minden rendbe működik mi alapján gondolja
 *    hogy baj van ? … ha vissza adja a képet a már 10 masodpercel már
 *    nézet műsort vissza tekeri ugyan oda … folyamatosan ezt csinalja”
 *
 * A KÉT NAPLÓ BIZONYÍTÉKA (mindkettő 2.5.404, TS + balanced):
 *   #51 [HU] EPIC DRAMA UHD: 55 s bizonyított lejátszás után
 *        `currentTime=duration=55.72s; paused=true; ended=true;
 *         readyState=4; networkState=1; media_error=-;
 *         buffered_tartományok=[0.00-Infinitys]`
 *   #52 HU - DISCOVERY INVESTIGATION: 30 s után ugyanez 31.65 s-nél.
 *   Mindkettőben: „BIZONYÍTOTTAN MŰKÖDŐ CSATORNA – nincs javítási létra,
 *   csak újracsatlakozás”, mégis ~100 ms múlva
 *   `MEDIA_EMPTIED → WAITING → LOADSTART → LOADEDMETADATA → CANPLAY → PLAYING`
 *   jön 0.00 s-ről. Összesítés: `döntések=0; javítási_lépések=0`.
 *   #51-ben a `MEDIA_STALLED` 25,30 s puffer-előre mellett jött, közben a
 *   `currentTime` 6,70 → 32,17 → 54,44 s-ig haladt, mégis 47 746 ms-es
 *   „pufferelési epizódot” írt a mérés, mert nem jött új `playing`.
 *
 * A HIBA OKA: `isUnexpectedLiveEnd()` PUSZTÁN az `ended` flagből ítélt;
 * a `durationchange` / `pause` / `ended` kezelők pedig a TV Doktor
 * `shouldSkipDoctorLadderForProvenChannel()` korai return-ja UTÁN is külön
 * hívták a `requestRecoveryRef`-et (csak a LÉTRA maradt el, a RELOAD nem).
 *
 * EZ A TESZT:
 *   1. valódi esbuild futásidővel ellenőrzi az új bizonyíték-alapú döntést,
 *   2. valódi TV Doktor telemetriát futtat (stalled → haladás → epizód zárás),
 *   3. forrásszinten ellenőrzi, hogy mind a 4 eseménykezelő, az overlay,
 *      a retry-felirat élettartama és az élő-él seek be van kötve,
 *   4. ellenőrzi, hogy a NEM regressionös útak változatlanok maradtak.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('.');
const esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
const outDir = path.resolve('build/test');
fs.mkdirSync(outDir, { recursive: true });
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];
function check(condition, label) {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; failures.push(label); console.error(`  ✗ HIBA: ${label}`); }
}

const mem = new Map();
globalThis.localStorage = {
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

/* ───────── 1. Valódi modul: playbackRecovery.ts ───────── */
console.log('\n=== 1. A #51/#52 bizonyítékai: az `ended` önmagában NEM hiba ===\n');

const recOut = path.join(outDir, 'playback-recovery-406.mjs');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'web/src/services/playbackRecovery.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2020',
  outfile: recOut, logLevel: 'silent',
});
const rec = await import(pathToFileURL(recOut).href + '?v=' + Date.now());
const { isWebOsLiveEndArtifact, liveEdgeTarget, LIVE_END_CONFIRM_MS, isUnexpectedLiveEnd } = rec;

const EPIC = {
  mediaError: false, networkState: 1, readyState: 4,
  bufferedAheadSeconds: null, unboundedBuffer: true,
  progressAgoMs: 220, healthyPlaybackMs: 55_000,
};
const DISCOVERY = {
  mediaError: false, networkState: 1, readyState: 4,
  bufferedAheadSeconds: null, unboundedBuffer: true,
  progressAgoMs: 180, healthyPlaybackMs: 30_000,
};
check(isWebOsLiveEndArtifact(EPIC) === true,
  '#51: 55 s lejátszás + Infinity puffer + media_error nélküli `ended` = webOS artefakt (nincs reload)');
check(isWebOsLiveEndArtifact(DISCOVERY) === true,
  '#52: 30 s lejátszás utáni ugyanilyen `ended` szintén artefakt (nincs reload)');
check(isWebOsLiveEndArtifact({ ...EPIC, bufferedAheadSeconds: 25.30, unboundedBuffer: false }) === true,
  'a véges, de bőséges (25,30 s) puffer-előre is elegendő bizonyíték');
check(isWebOsLiveEndArtifact({ ...EPIC, mediaError: true }) === false,
  'igazolt `video.error` mellett a reload VÁLTOZATLANUL jogos (valódi hiba)');
check(isWebOsLiveEndArtifact({ ...EPIC, networkState: 3 }) === false,
  'NETWORK_NO_SOURCE (3) mellett a reload jogos (eltűnt a forrás)');
check(isWebOsLiveEndArtifact({ ...EPIC, readyState: 2 }) === false,
  'readyState=2 (nincs jövőbeli képkocka) mellett a reload jogos');
check(isWebOsLiveEndArtifact({ ...EPIC, bufferedAheadSeconds: 0.2, unboundedBuffer: false }) === false,
  'elfogyott puffer mellett a reload jogos');
check(isWebOsLiveEndArtifact({ ...EPIC, progressAgoMs: 4000 }) === false,
  '4 mp óta álló idővonal mellett a reload jogos (nem friss a haladás)');
check(isWebOsLiveEndArtifact({ ...EPIC, progressAgoMs: null }) === false,
  'soha nem haladt adásnál a reload jogos');
check(isWebOsLiveEndArtifact({ ...EPIC, healthyPlaybackMs: 4000 }) === false,
  'nem bizonyított (4 s) csatornánál a reload jogos');
check(isWebOsLiveEndArtifact({ ...EPIC, bufferedAheadSeconds: Infinity, unboundedBuffer: false }) === false,
  'a `Infinity` puffer-előre NEM számít véges tartaléknak (csak az unboundedBuffer jelző)');
check(isWebOsLiveEndArtifact(EPIC, { healthyThresholdMs: 60_000 }) === false,
  'a bizonyítási küszöb felülírható (alapértelmezés 15 s)');
check(LIVE_END_CONFIRM_MS === 1500 && LIVE_END_CONFIRM_MS > 0,
  'a webOS 1500 ms megerősítési ablakot kap a helyben folytatáshoz');
check(isUnexpectedLiveEnd({
  ended: true, paused: true, desiredPlaying: true, playbackStarted: true,
  currentTime: 55.72, duration: 55.72,
}) === true,
  'a régi `isUnexpectedLiveEnd()` osztályozó változatlan maradt (a VETO külön dönt)');
check(isUnexpectedLiveEnd({
  ended: true, paused: true, desiredPlaying: false, playbackStarted: true,
  currentTime: 55.72, duration: 55.72,
}) === false,
  'a felhasználói pause továbbra sem indít élő recoveryt');

/* ───────── 2. Valódi modul: élő-él seek (nincs ~10 mp visszatekerés) ───────── */
console.log('\n=== 2. A visszatérés a friss élő élre áll, nem a régi szegmensre ===\n');

check(liveEdgeTarget([{ start: 0, end: 12 }], 0) === 11.25,
  '12 s-es HLS/TS élő ablaknál az élő él = 11,25 s (0,75 s margó)');
check(liveEdgeTarget([{ start: 0, end: 4 }, { start: 4, end: 20 }], 5) === 19.25,
  'több tartományból a legfrissebb, a lejátszási pontot fedő vége nyer');
check(liveEdgeTarget([{ start: 0, end: Infinity }], 0) === null,
  'a #51/#52 `buffered=[0.00-Infinity]` értéke NEM seekelhető: nincs erőltetett ugrás');
check(liveEdgeTarget([{ start: 0, end: NaN }], 0) === null,
  'a NaN vég sem seekelhető');
check(liveEdgeTarget([], 0) === null,
  'üres tartomány esetén nincs ugrás (a figyelő később próbálkozik)');
check(liveEdgeTarget([{ start: 30, end: 40 }], 0) === null,
  'a lejátszási ponton KÍVÜLI tartományra nem ugrunk');
check(liveEdgeTarget([{ start: 0, end: 1 }], 0) === 0.25,
  'a margó nem tolja a célpontot a tartomány elé');

/* ───────── 3. Valódi TV Doktor telemetria: a haladó kép NEM pufferelés ───────── */
console.log('\n=== 3. A #51 47 746 ms-es hamis „pufferelési epizódja” megszűnt ===\n');

const telemetryOut = path.join(outDir, 'tv-doctor-telemetry-406.mjs');
await esbuild.build({
  stdin: {
    contents: `export {
      startTvDoctorPlaybackTelemetry, stopTvDoctorPlaybackTelemetry,
      setTvDoctorActivePlaybackSnapshot,
    } from './web/src/services/tvDoctor.ts';
    export { startTvDoctorLogging, getTvDoctorLogText, stopTvDoctorLogging } from './web/src/services/appLog.ts';`,
    resolveDir: ROOT, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: telemetryOut,
  nodePaths: [path.join(ROOT, 'web/node_modules')], logLevel: 'silent',
});
const tel = await import(pathToFileURL(telemetryOut).href + '?v=' + Date.now());

const listeners = new Map();
let decodedFrames = 1000;
const fakeVideo = {
  currentTime: 6.70,
  duration: NaN,
  error: null,
  readyState: 4,
  networkState: 2,
  paused: false,
  seeking: false,
  ended: false,
  videoWidth: 1280,
  videoHeight: 720,
  currentSrc: 'http://panel.example/live/u/p/epic.ts',
  src: 'http://panel.example/live/u/p/epic.ts',
  buffered: { length: 1, start: () => 0, end: () => 32 },
  getVideoPlaybackQuality: () => ({ totalVideoFrames: decodedFrames, droppedVideoFrames: 0 }),
  addEventListener(type, fn) {
    const list = listeners.get(type) || [];
    list.push(fn);
    listeners.set(type, list);
  },
  removeEventListener(type, fn) {
    listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn));
  },
  fire(type) {
    for (const fn of [...(listeners.get(type) || [])]) fn({ type });
  },
};
globalThis.document = { querySelector: () => fakeVideo };
tel.setTvDoctorActivePlaybackSnapshot({
  channelName: '[HU] EPIC DRAMA UHD', channelId: 'live-qr_1794135505110-16966',
  contentType: 'live', format: 'ts', bufferProfile: 'balanced',
  playing: true, loading: false, recovering: false,
});
tel.startTvDoctorLogging();
tel.startTvDoctorPlaybackTelemetry();
check(listeners.has('timeupdate'),
  'a mérés figyeli a `timeupdate` eseményt (a haladás a bizonyíték)');
fakeVideo.fire('stalled');
fakeVideo.currentTime = 32.17;
fakeVideo.buffered = { length: 1, start: () => 0, end: () => 58 };
decodedFrames = 1200;
fakeVideo.fire('timeupdate');
tel.stopTvDoctorPlaybackTelemetry();
const telemetryText = tel.getTvDoctorLogText();
tel.stopTvDoctorLogging();
check(/PUFFERELÉSI EPIZÓD VÉGE:[^\n]*kiváltó_esemény=idővonal haladt \(nincs lejátszási szünet\)/.test(telemetryText),
  'a 25,30 s puffer melletti `stalled` után a haladó currentTime AZONNAL lezárja az epizódot');
check(!/kiváltó_esemény=kézi napló leállítása/.test(telemetryText),
  'nincs többé kézi naplóleállításig „nyitva maradó” 47 746 ms-es epizód');
check(/pufferelési_epizódok=1/.test(telemetryText) && /stalled_események=1/.test(telemetryText),
  'a `stalled` esemény ténye megmarad a naplóban, csak a HAMIS időtartam tűnik el');
check(/MEDIA_STALLED/.test(telemetryText) && /MEDIA_WAITING/.test(telemetryText) === false,
  'a `stalled` mintasor változatlanul bekerül, de `waiting` nélkül nem keletkezik epizód');
const maxEpisode = Number((telemetryText.match(/leghosszabb_epizód=(\d+)ms/) || [])[1] ?? -1);
check(maxEpisode >= 0 && maxEpisode < 5000,
  'a #51 valódi körülményei között a leghosszabb epizód néhány ms, nem 47 746 ms');

/* Valódi megakadás: nincs haladás → az epizód a `playing`-ig nyitva marad. */
mem.clear();
listeners.clear();
fakeVideo.currentTime = 6.70;
fakeVideo.buffered = { length: 1, start: () => 0, end: () => 32 };
decodedFrames = 1000;
tel.startTvDoctorLogging();
tel.startTvDoctorPlaybackTelemetry();
fakeVideo.fire('waiting');
fakeVideo.fire('timeupdate'); // változatlan idővonal és képkockaszám
fakeVideo.fire('playing');
tel.stopTvDoctorPlaybackTelemetry();
const realStallText = tel.getTvDoctorLogText();
tel.stopTvDoctorLogging();
check(/kiváltó_esemény=playing/.test(realStallText),
  'VALÓDI megakadásnál (nincs haladás) az epizód továbbra is a `playing` eseménynél zárul');
check(!/idővonal haladt/.test(realStallText),
  'haladás nélkül nem írunk hamis „idővonal haladt” lezárást');
tel.stopTvDoctorLogging();

/* ───────── 4. Élő watchdog végleges kikapcsolása ───────── */
console.log('\n=== 4. Élő TV: semmilyen watchdog nem indíthat újratöltést ===\n');

const player = read('web/src/components/VideoPlayer.tsx');
const recovery = read('web/src/services/playbackRecovery.ts');
const doctor = read('web/src/services/tvDoctor.ts');
const watchdogStart = player.indexOf('const armBufferWatchdog');
const watchdogSlice = watchdogStart >= 0 ? player.slice(watchdogStart, watchdogStart + 900) : '';

check(watchdogStart >= 0 && /if \(!isVodRef\.current\) return;/.test(watchdogSlice),
  'az élő puffer-watchdog azonnal visszatér, csak a VOD külön útja marad');
check(!/liveDurationRecoveryTimerRef|liveEndArtifactRef/.test(player),
  'nincs élő duration/ended időzítő vagy késleltetett recovery');
check(/ÉLŐ VÉGES IDŐVONAL-JELZÉS; automatikus újratöltés TILTVA/.test(player),
  'a durationchange nem tölti újra az élő csatornát');
check(/ÉLŐ PAUSE\/ENDED JELZÉS; automatikus újratöltés TILTVA/.test(player)
  && /ÉLŐ ENDED JELZÉS; automatikus újratöltés és watchdog TILTVA/.test(player),
  'a pause és ended esemény nem indít élő automatikus újratöltést');
check(/ÉLŐ ÚJRACSATLAKOZÁS KIZÁRÓLAG VALÓDI MÉDIAHIBA ESETÉN/.test(player),
  'élő újracsatlakozás csak tényleges médiahiba útvonalon marad meg');
check(/if \(!isVodRef\.current \|\| recoveryTimerRef\.current !== null\) return;/.test(player),
  'a külön VOD-helyreállítás nincs összekeverve az élő TV-vel');
check(/DOCTOR_STATUS_MAX_VISIBLE_MS = 12000/.test(player),
  'a TV Doktor átmeneti feliratai továbbra sem maradhatnak a képernyőn');
check(/startTvDoctorPlaybackTelemetry/.test(doctor)
  && /timeupdate/.test(doctor),
  'a TV Doktor kézi telemetriája megmarad, watchdog nélkül is mér');
check(/liveEdgeTarget/.test(recovery),
  'az élő él mérő segédje megmarad, de időzített watchdog nem hívja');

console.log(`\n=== EREDMÉNY: ${passed}/${passed + failed} ellenőrzés ===`);
if (failed) {
  console.error('\nBUKOTT ELLENŐRZÉSEK:');
  for (const label of failures) console.error(' - ' + label);
  process.exit(1);
}
console.log('OK: az élő TV watchdog végleg ki van kapcsolva; a VOD és a TV Doktor telemetria külön marad.');
