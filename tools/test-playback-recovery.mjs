#!/usr/bin/env node
/*
 * LEJÁTSZÁS-VISSZAÁLLÍTÁS – valódi futásidejű teszt.
 *
 * A `web/src/services/playbackRecovery.ts` modult a TÉNYLEGES forrásból
 * fordítjuk (esbuild → ESM), majd végigjátsszuk a webOS-en előforduló
 * eseteket:
 *   • élő MPEG-TS: a `currentTime` 0 marad, de a képkockák érkeznek,
 *   • valódi megakadás: sem képkocka, sem puffer nem halad,
 *   • keresés (seek), háttérbe kerülés,
 *   • korai `ended` esemény (a szolgáltató elvágta a VOD-kapcsolatot),
 *   • újracsatlakozási sorrend és visszalépési idők.
 *
 * Emellett ellenőrizzük, hogy a VideoPlayer és az appLog ténylegesen használja
 * ezeket az útakat (forrás-szintű ellenőrzések).
 *
 * Futtatás: node tools/test-playback-recovery.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

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
  console.log(failed ? '\nHIBA: a lejátszás-visszaállítás tesztje nem futott át.'
    : '\nOK: a lejátszás-visszaállítás minden ellenőrzése átment.');
  process.exit(failed ? 1 : 0);
}

const source = path.resolve('web/src/services/playbackRecovery.ts');
if (!fs.existsSync(source)) {
  check(false, `hiányzik a modul: ${source}`);
  finish();
}

let esbuild;
try {
  const requireFromWeb = createRequire(path.resolve('web/package.json'));
  esbuild = requireFromWeb('esbuild');
} catch {
  console.log('KIPARANCSOLT: az esbuild nem érhető el (cd web && npm install)');
  process.exit(0);
}

const outDir = path.resolve('build/test');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'playbackRecovery.mjs');
try {
  await esbuild.build({
    entryPoints: [source],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2020',
    outfile: outFile,
    logLevel: 'silent',
  });
} catch (error) {
  check(false, 'a modul fordítása sikertelen: ' + String(error).slice(0, 300));
  finish();
}

const mod = await import(pathToFileURL(outFile).href);
const {
  StallDetector, mediaProgressed, readMediaProgress,
  bufferProfileTiming, bufferedAheadSeconds, liveRecoveryUrl, liveRecoveryDelayMs, vodRecoveryDelayMs, isPrematureVodEnd,
  isUnexpectedLiveEnd,
} = mod;

/* ── 1. Mintavétel: a webOS nem minden API-t adja ki ─────────────────── */
const emptyVideo = { currentTime: 0, readyState: 0, buffered: { length: 0, end: () => 0 } };
const emptySample = readMediaProgress(emptyVideo, 1000);
check(emptySample.time === 0 && emptySample.frames === null && emptySample.bufferedEnd === null,
  'hiányzó webOS API-k esetén is érvényes minta készül (nincs kivétel)');

const frameVideo = {
  currentTime: 0,
  readyState: 4,
  buffered: { length: 1, end: () => 12.5 },
  getVideoPlaybackQuality: () => ({ totalVideoFrames: 120 }),
};
const frameSample = readMediaProgress(frameVideo, 2000);
check(frameSample.frames === 120 && frameSample.bufferedEnd === 12.5,
  'a képkocka-számláló és a puffer vége is bekerül a mintába');
const bufferedRanges = {
  length: 1,
  start: () => 0,
  end: () => 10,
};
check(bufferedAheadSeconds({ currentTime: 2, buffered: bufferedRanges }) === 8,
  'a puffer-tartalékot a lejátszási ponttól előre, nem abszolút végpontként méri');
check(bufferedAheadSeconds({ currentTime: 11, buffered: bufferedRanges }) === 0,
  'a lejátszási pont után maradt üres puffer nulla tartalékot ad');

check(!mediaProgressed(frameSample, { ...frameSample, bufferedEnd: 20, at: 3000 }),
  'élő adásnál a PUFFER növekedése önmagában NEM jelent haladást, ha a képkockák állnak');
check(mediaProgressed(frameSample, { ...frameSample, frames: 121, at: 3000 }),
  'egy új dekódolt képkocka már haladás (currentTime = 0 mellett is)');
check(mediaProgressed(emptySample, { ...emptySample, time: 1.5, at: 3000 }),
  'VOD-nál az idővonal haladása haladás');
check(!mediaProgressed(frameSample, { ...frameSample, at: 3000 }),
  'azonos minták (= semmi sem halad) megakadásnak számítanak');
check(!mediaProgressed(
  { at: 0, time: 12, frames: null, bufferedEnd: 20, readyState: 4 },
  { at: 1000, time: 12, frames: null, bufferedEnd: 35, readyState: 4 },
), 'már futó idővonalnál a puffer növekedése nem rejti el a dekóder fagyását');
check(!mediaProgressed(
  { at: 0, time: 0, frames: null, bufferedEnd: 3, readyState: 3 },
  { at: 1000, time: 0, frames: null, bufferedEnd: 7, readyState: 3 },
), 'futó watchdognál a 0 idővonal puffer-növekedése nem hamisít haladást');
check(mediaProgressed(
  { at: 0, time: 0, frames: null, bufferedEnd: 3, readyState: 3 },
  { at: 1000, time: 0, frames: null, bufferedEnd: 7, readyState: 3 },
  true,
), 'külön indulási mintavételnél a puffer feltöltése még haladási jel lehet');
check(mediaProgressed({ ...frameSample, time: 500 }, { ...frameSample, time: 100, at: 3000 }),
  'visszafelé tekerés (= keresés) nem számít megakadásnak');

/* ── 2. Profilpolitika: gyors indulás, külön pufferőr ─────────────────── */
const fastTiming = bufferProfileTiming('fast');
const balancedTiming = bufferProfileTiming('balanced');
const stableTiming = bufferProfileTiming('stable');
check(fastTiming.startupWatchdogMs < balancedTiming.startupWatchdogMs
  && balancedTiming.startupWatchdogMs < stableTiming.startupWatchdogMs,
  'a profilok indulási őre gyors/kiegyensúlyozott/stabil sorrendű');
check(fastTiming.bufferWatchdogMs > fastTiming.startupWatchdogMs
  && balancedTiming.bufferWatchdogMs > balancedTiming.startupWatchdogMs,
  'a már futó adás pufferőre türelmesebb, mint a csatornaindítási fallback');
check(fastTiming.retryMs < balancedTiming.retryMs
  && fastTiming.minBufferAheadSeconds < balancedTiming.minBufferAheadSeconds
  && balancedTiming.minBufferAheadSeconds < stableTiming.minBufferAheadSeconds
  && stableTiming.retryMs === 80,
  'a gyors/kiegyensúlyozott recovery és a puffer-tartalék profilfüggő, a stabil recovery kompatibilis marad');

/* ── 3. StallDetector ────────────────────────────────────────────────── */
const detector = new StallDetector(4000);
const stalled = { at: 0, time: 0, frames: 10, bufferedEnd: 5, readyState: 3 };
const timeline = [0, 1000, 2000, 3000, 4000, 5000];
const verdicts = timeline.map((at) => detector.observe({ ...stalled, at }, at));
check(verdicts[0] === false && verdicts[3] === false && verdicts[4] === true,
  '4 mpnyi valódi megakadás után jelez, előtte nem');
detector.reset();
check(detector.observe({ ...stalled, at: 0 }, 0) === false
  && detector.observe({ ...stalled, at: 4000, frames: 11 }, 4000) === false,
  'egy új képkocka nullázza a megakadás-számlálót');
detector.reset();
detector.observe({ ...stalled, at: 0 }, 0);
check(detector.observe({ ...stalled, at: 9000 }, 9000) === false,
  'háttérbe kerülés (5 mp-nél hosszabb szünet) nem indít hamis újracsatlakozást');

/* ── 3. Újracsatlakozási politika ────────────────────────────────────── */
const TS = 'http://panel.example/live/u/p/1.ts';
const HLS = 'http://panel.example/live/u/p/1.m3u8';
check([0, 1, 2, 3, 4, 5].map((n) => liveRecoveryUrl(n, TS, HLS)).join('|')
  === [TS, TS, HLS, TS, TS, HLS].join('|'),
  'az első két próba az EREDETI cím, utána ritkábban a másik formátum (egy fallback után két eredeti próba)');
check(liveRecoveryUrl(8, TS, null) === TS,
  'tartalék cím nélkül nem próbálunk nem létező URL-t');
const liveDelays = [0, 1, 2, 3, 4, 10].map((n) => liveRecoveryDelayMs(n, 50));
check(liveDelays.every((value, i) => i === 0 || value >= liveDelays[i - 1]) && liveDelays.at(-1) <= 6000,
  'az élő újrapróbák fokozatosan ritkulnak, de 6 mp-nél nem lassabbak');
const vodDelays = [0, 1, 2, 3, 4, 20].map((n) => vodRecoveryDelayMs(n, 200));
check(vodDelays.every((value, i) => i === 0 || value >= vodDelays[i - 1]) && vodDelays.at(-1) <= 8000,
  'a VOD újrapróbák is korlátosak (max. 8 mp)');

/* ── 4. Korai `ended` esemény ────────────────────────────────────────── */
check(isPrematureVodEnd(100, 3600), 'a film közben érkező ended = kapcsolat-szakadás');
check(!isPrematureVodEnd(3599, 3600), 'a film VÉGÉN érkező ended = valódi befejezés');
check(!isPrematureVodEnd(100, NaN), 'ismeretlen hossznál nem találgatunk (nincs hamis visszaállítás)');
check(!isPrematureVodEnd(100, 0), '0 hosszú streamnél nincs korai vég');
check(isUnexpectedLiveEnd({
  ended: true, paused: true, desiredPlaying: true, playbackStarted: true,
  currentTime: 85.778, duration: 85.778,
}), 'a futó live adás véges ended/durationchange állapota recoveryt kér');
check(!isUnexpectedLiveEnd({
  ended: true, paused: true, desiredPlaying: false, playbackStarted: true,
  currentTime: 85.778, duration: 85.778,
}), 'a felhasználói pause nem indul újra ended esemény miatt');
check(!isUnexpectedLiveEnd({
  ended: true, paused: true, desiredPlaying: true, playbackStarted: false,
  currentTime: 0, duration: 0,
}), 'a sikertelen indulási próbát az indulási watchdog kezeli, nem a live ended recovery');

/* ── 5. A lejátszó TÉNYLEGESEN használja az új logikát ──────────────── */
const PLAYER = fs.readFileSync(path.resolve('web/src/components/VideoPlayer.tsx'), 'utf8');
const APPLOG = fs.readFileSync(path.resolve('web/src/services/appLog.ts'), 'utf8');
const APP = fs.readFileSync(path.resolve('web/src/App.tsx'), 'utf8');
const CHANNEL_LIST = fs.readFileSync(path.resolve('web/src/components/ChannelList.tsx'), 'utf8');
check(/new StallDetector\(isVod \? 7000 : bufferTiming\(\)\.stallDetectorMs\)/.test(PLAYER),
  'a lejátszó egységes, profilfüggő képkocka-alapú figyelőt használ élőre és VOD-ra');
check(/puffer-előre=/.test(PLAYER)
  && /bufferedAheadSeconds/.test(PLAYER)
  && /PUFFERELÉSI ŐR HALASZTVA/.test(PLAYER),
  'a watchdog a lejátszási pont előtti valódi tartalékot méri, és röviden megerősít, ha még van puffer');
check(/const loadKey = streamUrl;/.test(PLAYER)
  && !/const loadKey = `\$\{streamUrl\}\|\$\{settings\.bufferMode\}`/.test(PLAYER),
  'a pufferprofil váltása nem indítja újra mesterségesen az aktuális forrást');
check(/requestRecoveryRef\.current\('idővonal megakadt'\)/.test(PLAYER),
  'a megakadás automatikus újracsatlakozást indít');
check(/liveRecoveryUrl\(attempt, recoveryPrimaryUrl, recoveryFallbackUrl\)/.test(PLAYER),
  'az élő újracsatlakozás az aktuális vagy elsődleges címmel kezd');
check(/urls: alternative \? \[primaryUrl, alternative\.url\] : \[primaryUrl\]/.test(PLAYER)
  && /liveRecoveryOnlyRef\.current = true/.test(PLAYER),
  'a két külön formátum-próba után nincs azonnali TS/HLS ciklus, csak kontrollált recovery');
check(/const isActiveMediaEvent = \(video: HTMLVideoElement\): boolean =>/.test(PLAYER)
  && /RÉGI MÉDIAESEMÉNY KIHAGYVA/.test(PLAYER),
  'a későn érkező régi src médiaeseménye nem írhatja át az új csatorna állapotát');
check(/hasStartupData/.test(PLAYER)
  && /türelmi idő indul/.test(PLAYER)
  && /türelmi idő után sem indult/.test(PLAYER),
  'a késői playing esemény kap türelmi időt, de nem maradhat végtelenül elakadt');
check(/vodRecoveryRef\.current\('korai ended esemény'\)/.test(PLAYER)
  && /isPrematureVodEnd\(position, duration\)/.test(PLAYER),
  'a VOD korai ended eseménye visszaállítást indít, nem következő részt');
check(/isUnexpectedLiveEnd\(endState\)/.test(PLAYER)
  && /requestRecoveryRef\.current\(`élő adás vége/.test(PLAYER)
  && /requestRecoveryRef\.current\(`élő véges idővonal/.test(PLAYER)
  && /isUnexpectedLiveEnd\(pausedEndState\)/.test(PLAYER),
  'a live ended, pause/ended és a tartósan véges durationchange ugyanazon csatornán recoveryt indít');
const audioTrackEffect = PLAYER.slice(PLAYER.indexOf('const refreshHtmlAudioTracks'), PLAYER.indexOf('const refreshHtmlAudioTracks') + 5000);
check(/addEventListener\('durationchange'/.test(audioTrackEffect)
  && /setTimeout\(refreshHtmlAudioTracks/.test(audioTrackEffect)
  && !/setInterval\(refreshHtmlAudioTracks/.test(audioTrackEffect),
  'a hangsáv-lista nem fut állandó 1 mp-es pollinggal, csak események és indulási ellenőrzések dolgoznak');
check(/liveDurationRecoveryTimerRef/.test(PLAYER)
  && /generation !== streamLoadGenerationRef\.current/.test(PLAYER),
  'a késői live duration recovery időzítője csatornagenerációval védett');
check(/name === 'AbortError'/.test(PLAYER),
  'a gyors forrásváltás AbortError-ja NEM számít lejátszási hibának');
check(/switchInProgressRef\.current\) return;/.test(PLAYER),
  'a belső pause/play események nem írják át a lejátszási szándékot');
/*
 * 2.5.147: a teljes képernyős töltő réteg továbbra is csak a „még nincs
 * képkocka” ágban jelenik meg, de már NEM tiszta fekete (a kész felület
 * hátteréhez illő sötét türkiz), így a váltás pillanatában sem villanhat be
 * fekete felület.
 */
check(/currentStreamHasFrame \? \(/.test(PLAYER) && /bg-\[#0b1c24\] z-10/.test(PLAYER),
  'van képkocka után a töltőjelző NEM takarja el a képet fekete réteggel');
check(!/bg-black z-10/.test(PLAYER),
  'a teljes képernyős töltő réteg újra tiszta fekete');
check(/data-playback-status/.test(PLAYER)
  && /isFullscreen/.test(PLAYER)
  && /top-3 right-3/.test(PLAYER)
  && /bottom-3 left-3/.test(PLAYER),
  'fullscreenben a kis pörgő jelző az óra alatt jobb felül, normál nézetben bal alul marad');
check(/logLiveMediaEvent\('waiting'/.test(PLAYER)
  && /logLiveMediaEvent\('stalled'/.test(PLAYER)
  && /logLiveMediaEvent\('error'/.test(PLAYER)
  && /requestRecoveryRef\.current\('pufferelés elakadt'\)/.test(PLAYER)
  && /logLiveTimeline\(video\)/.test(PLAYER)
  && /seekable=/.test(PLAYER)
  && /buffered=/.test(PLAYER),
  'a kézi élő napló a médiahibát, idővonalat, seeket és puffert is rögzíti');
check(/isVerbosePlaybackLogging\(\)/.test(PLAYER) && /isVerbosePlaybackLogging\(\)/.test(APPLOG),
  'a részletes diagnosztika csak a hibakeresési ablakban fut');
check(/runtimeDiagnosticCacheRef/.test(PLAYER)
  && /now - cached\.at < 5000/.test(PLAYER)
  && /erőforrás-pillanatkép=gyorsítótár/.test(PLAYER),
  'a kézi erőforrás-mérés localStorage-bejárása legfeljebb ötmásodpercenként fut');
check(/const isRecoveryAttempt = Boolean/.test(PLAYER)
  && /ÉLŐ ÚJRACSATLAKOZÁSI PRÓBA START/.test(PLAYER)
  && /CSATORNAVÁLTÁS START/.test(PLAYER),
  'a recovery-próbák külön naplósort kapnak, nem zajosítják a kézi csatornaváltási START mérőszámot');
check(/startRuntimeWatchdog\(\)/.test(APPLOG)
  && !/startRuntimeWatchdog\(\);/.test(fs.readFileSync(path.resolve('web/src/main.tsx'), 'utf8'))
  && /stopRuntimeWatchdog\(\)/.test(APPLOG),
  'a runtime watchdog csak kézi naplózáskor indul és leállításkor felszabadul');
check(/PERSIST_DELAY_MS = 5000/.test(APPLOG)
  && /trim\(\);/.test(APPLOG),
  'a diagnosztikai napló összevontan ment és nem soronként végzi a lejárat-ellenőrzést');
check(/activeView !== 'live' \|\| customStreamUrl/.test(APP)
  && /isActive=\{activeView === 'live'/.test(APP)
  && /if \(!isActive \|\| !activeProvider \|\| activeProvider\.type !== 'xtream'\) \{/.test(CHANNEL_LIST)
  && /if \(!epgActive \|\| !epgReady\) return;/.test(CHANNEL_LIST)
  && /const epgActive = isActive && !epgPaused;/.test(CHANNEL_LIST),
  'a rejtett filmnézetben az EPG-előtöltés és az óra nem fut háttérben');
check(/dublinFormatter\(\)\.formatToParts\(date\)/.test(APPLOG),
  'az időbélyeg-formázó gyorsítótárazott (nincs új Intl példány soronként)');
check(/MIN_FORCE_INTERVAL_MS/.test(APPLOG),
  'a nagy napló szinkron írása összevont (nem minden kritikus sornál ír 1 MB-ot)');
check(/data-player-retry=""/.test(PLAYER) && /retryButtonRef/.test(PLAYER),
  'a hibaképernyő végre tartalmaz távirányítóval elérhető Újrapróbálás gombot');
check(!/A csatorna négy indítási próbálkozás után sem indult el/.test(PLAYER),
  'nincs többé végleges, négy próba utáni feladás');

try { fs.rmSync(outFile, { force: true }); } catch { /* nem kritikus */ }
finish();
