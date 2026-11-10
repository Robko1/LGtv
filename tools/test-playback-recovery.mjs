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
  bufferProfileTiming, bufferedAheadSeconds, effectiveStartupWatchdogMs, liveRecoveryUrl, liveRecoveryDelayMs, vodRecoveryDelayMs, isPrematureVodEnd,
  isUnexpectedLiveEnd,
  isVodRecoveryExhausted, VOD_MAX_NEVER_STARTED_ATTEMPTS,
  shouldAllowDiagnosticProbe, checkVodHttpStatus,
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
check([fastTiming, balancedTiming, stableTiming].every((timing) => effectiveStartupWatchdogMs(timing.startupWatchdogMs) >= 4500)
  && effectiveStartupWatchdogMs(9000) === 5000,
  'a csatornaindítás minden profilban legalább 4,5 mp-et kap, legfeljebb 5 mp-ig vár');
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

/* ── 3/b. 2.5.388 (#31 napló): egykapcsolatos szolgáltató, VOD-indítás ── */
check(VOD_MAX_NEVER_STARTED_ATTEMPTS === 4,
  'egy soha el nem indult film legfeljebb 4 automatikus próbát kap');
check([0, 1, 2, 3, 4, 20].every((n) => !isVodRecoveryExhausted(n, true)),
  'a MÁR JÁTSZOTT filmnél marad a folyamatos visszaállítás (nincs végleges feladás)');
check(!isVodRecoveryExhausted(3, false) && isVodRecoveryExhausted(4, false)
  && isVodRecoveryExhausted(9, false),
  'a soha el nem indult film a 4. próbánál megáll, kézi Újrapróbálás kell');
const neverStarted = [0, 1, 2, 3, 4, 20].map((n) => vodRecoveryDelayMs(n, 180, 8000, false));
const alreadyStarted = [0, 1, 2, 3, 4, 20].map((n) => vodRecoveryDelayMs(n, 180, 8000, true));
check(neverStarted[0] >= 2000 && neverStarted[1] >= 4000 && neverStarted[2] >= 6000
  && neverStarted.every((v, i) => i === 0 || v >= neverStarted[i - 1])
  && neverStarted.every((v) => v <= 8000),
  'a #31-ben mért 180/360/720/1440 ms helyett 2/4/6 mp-es, fokozatos, korlátos próbák jönnek');
check(alreadyStarted[0] === 800 && alreadyStarted[1] < neverStarted[1],
  'egy MÁR játszott film pufferelési megakadása továbbra is gyorsan visszaáll');

const stableProbe = {
  playbackStarted: true, readyState: 4,
  msSinceLastWaiting: null, msSinceMediaError: null, msSincePlaybackStart: 20000,
};
check(!shouldAllowDiagnosticProbe({ ...stableProbe, playbackStarted: false }),
  'fejléc-próba nem indul, mielőtt a videó ténylegesen elindult');
check(!shouldAllowDiagnosticProbe({ ...stableProbe, readyState: 0 }),
  'readyState=0 (kész=0) mellett nincs második kapcsolat');
check(!shouldAllowDiagnosticProbe({ ...stableProbe, msSincePlaybackStart: 900 }),
  'a film indítása után 900 ms-mal még nem próbálunk (a videóelem kapja a kapcsolatot)');
check(!shouldAllowDiagnosticProbe({ ...stableProbe, msSinceLastWaiting: 1200 }),
  'friss waiting/stalled után nem nyitunk második kapcsolatot');
check(!shouldAllowDiagnosticProbe({ ...stableProbe, msSinceMediaError: 5000 }),
  'friss médiahiba után nem nyitunk második kapcsolatot');
check(shouldAllowDiagnosticProbe(stableProbe)
  && !shouldAllowDiagnosticProbe(stableProbe, { minStableMs: 30000 }),
  '15 mp stabil lejátszás után engedélyezett a diagnosztika, a szigorúbb kapu pedig tilt');
check(shouldAllowDiagnosticProbe({ ...stableProbe, msSincePlaybackStart: 5000 },
  { minStableMs: 4000, minSinceErrorMs: 8000, minSinceWaitingMs: 4000 }),
  'a CC-felderítés rövidebb (4 mp) kaput használ, hogy a felirat ne késsen sokat');

// A webOS-en XHR fut; Node-ban a fetch-tartalékot ellenőrizzük.
const originalFetch = globalThis.fetch;
const fakeResponse = (status, headers = {}) => ({
  status,
  headers: { get: (key) => headers[key.toLowerCase()] ?? null },
  body: undefined,
});
globalThis.fetch = async () => fakeResponse(403, { 'content-type': 'text/html' });
const deniedCheck = await checkVodHttpStatus('http://panel.example/movie/1.mkv', 1000);
check(deniedCheck.status === 403 && /egykapcsolatos/.test(deniedCheck.verdict),
  'a 403-as válasz a naplóban egykapcsolatos/jogosultsági elutításként jelenik meg');
globalThis.fetch = async () => fakeResponse(206, { 'content-type': 'video/x-matroska', 'content-range': 'bytes 0-1/1745323008' });
const okCheck = await checkVodHttpStatus('http://panel.example/movie/1.mkv', 1000);
check(okCheck.status === 206 && okCheck.rangeSupported && /dekódolni/.test(okCheck.verdict),
  'a 206-os válasz megmondja: a fájl elérhető, a TV dekódolása a gond');
globalThis.fetch = async () => fakeResponse(404);
check((await checkVodHttpStatus('http://panel.example/movie/1.mkv', 1000)).verdict.includes('nem található'),
  'a 404-es válasz hiányzó filmfájlként jelenik meg');
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
check((await checkVodHttpStatus('http://panel.example/movie/1.mkv', 1000)).error.length > 0,
  'a hálózati hiba sem dob kivételt a lejátszó felé');
globalThis.fetch = originalFetch;

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
const SPEED = fs.readFileSync(path.resolve('web/src/services/speedDiagnostics.ts'), 'utf8');
const APP = fs.readFileSync(path.resolve('web/src/App.tsx'), 'utf8');
const CHANNEL_LIST = fs.readFileSync(path.resolve('web/src/components/ChannelList.tsx'), 'utf8');
check(/if \(!isVod \|\| !isPlaying\) return;/.test(PLAYER)
  && /new StallDetector\(7000\)/.test(PLAYER)
  && !/new StallDetector\(isVod \? 7000 : bufferTiming\(\)\.stallDetectorMs\)/.test(PLAYER),
  'az idővonal-/képkocka-watchdog kizárólag VOD-nál indul; élő TV-n teljesen ki van kapcsolva');
check(/puffer-előre=/.test(PLAYER)
  && /bufferedAheadSeconds/.test(PLAYER)
  && /PUFFERELÉSI ŐR: HELYI FOLYTATÁSI PRÓBA/.test(PLAYER)
  && /video\.play\(\)/.test(PLAYER),
  'a watchdog a lejátszási pont előtti valódi tartalékot méri, és röviden megerősít, ha még van puffer');
check(/PUFFERELÉSI WATCHDOG: ÚJRATÖLTÉS KIHAGYVA/.test(PLAYER)
  && /WAITING JELZÉS KIHAGYVA/.test(PLAYER)
  && /STALLED JELZÉS KIHAGYVA/.test(PLAYER)
  && /LEJÁTSZÁS-FIGYELŐ: ÚJRATÖLTÉS KIHAGYVA/.test(PLAYER),
  'elegendő puffer és readyState mellett a normál lejátszó nem indít felesleges újratöltést vagy pufferfeliratot');
check(/const loadKey = streamUrl;/.test(PLAYER)
  && !/const loadKey = `\$\{streamUrl\}\|\$\{settings\.bufferMode\}`/.test(PLAYER),
  'a pufferprofil váltása nem indítja újra mesterségesen az aktuális forrást');
check(/requestRecoveryRef\.current\('idővonal megakadt'\)/.test(PLAYER),
  'a megakadás automatikus újracsatlakozást indít');
check(/bufferWatchdogRef\.current !== null \|\| recoveryTimerRef\.current !== null \|\| autoRetryTimerRef\.current !== null/.test(PLAYER),
  'a puffer-watchdog és a képkocka-őr nem indíthat párhuzamos recovery-kört');
check(/liveRecoveryUrl\(attempt, recoveryPrimaryUrl, recoveryFallbackUrl\)/.test(PLAYER),
  'az élő újracsatlakozás az aktuális vagy elsődleges címmel kezd');
check(/urls: alternative \? \[primaryUrl, alternative\.url\] : \[primaryUrl\]/.test(PLAYER)
  && /liveRecoveryOnlyRef\.current = true/.test(PLAYER),
  'a két külön formátum-próba után nincs azonnali TS/HLS ciklus, csak kontrollált recovery');
check(/const isActiveMediaEvent = \(video: HTMLVideoElement\): boolean =>/.test(PLAYER)
  && /RÉGI MÉDIAESEMÉNY KIHAGYVA/.test(PLAYER),
  'a későn érkező régi src médiaeseménye nem írhatja át az új csatorna állapotát');
check(!/const attemptTimeoutMs = effectiveStartupWatchdogMs\(startupWatchdogMs\)/.test(PLAYER)
  && /indulási-őr=\$\{isVodRef\.current \? \(tvDoctorEnabledRef\.current \?/.test(PLAYER)
  && /LIVE_WATCHDOG_DEFAULTS\.stallReconnectMs \+ ' ms haladás nélkül \(élő őr\)'/.test(PLAYER)
  && /if \(!isVodRef\.current\) return;/.test(PLAYER.slice(PLAYER.indexOf('const armBufferWatchdog'), PLAYER.indexOf('const armBufferWatchdog') + 900)),
  'az élő ZAP-ŐR és az esemény-alapú puffer-watchdog KI van kapcsolva; élőn csak a haladás-alapú élő őr fut; a VOD külön marad');
check(/vodRecoveryRef\.current\('korai ended esemény'\)/.test(PLAYER)
  && /isPrematureVodEnd\(position, duration\)/.test(PLAYER),
  'a VOD korai ended eseménye visszaállítást indít, nem következő részt');
check(/ÉLŐ ENDED JELZÉS; \$\{liveEndWillRecover \? 'az élő őr megerősítés után újracsatlakozik'/.test(PLAYER)
  && /ÉLŐ PAUSE\/ENDED JELZÉS; az élő őr megerősítés után újracsatlakozik/.test(PLAYER)
  && /ÉLŐ VÉGES IDŐVONAL-JELZÉS; az élő őr megerősítés után újracsatlakozik/.test(PLAYER)
  && !/automatikus újratöltés és watchdog TILTVA/.test(PLAYER),
  '2.5.418: az élő ended, pause és durationchange után nem fagy be végleg a kép – az élő őr megerősítés után újracsatlakozik');
const audioTrackEffect = PLAYER.slice(PLAYER.indexOf('const refreshHtmlAudioTracks'), PLAYER.indexOf('const refreshHtmlAudioTracks') + 5000);
check(/addEventListener\('durationchange'/.test(audioTrackEffect)
  && /setTimeout\(refreshHtmlAudioTracks/.test(audioTrackEffect)
  && !/setInterval\(refreshHtmlAudioTracks/.test(audioTrackEffect),
  'a hangsáv-lista nem fut állandó 1 mp-es pollinggal, csak események és indulási ellenőrzések dolgoznak');
check(!/liveDurationRecoveryTimerRef/.test(PLAYER)
  && !/liveEndArtifactRef/.test(PLAYER),
  'az élő duration/ended időzített recovery teljesen megszűnt');
check(/lastPlayedRef\.current\.url === directLiveStreamUrl/.test(PLAYER)
  && !/formatOfUrl\(lastPlayedRef\.current\.url\) === formatOfUrl\(directLiveStreamUrl\)/.test(PLAYER),
  'azonos csatornaazonosító és TS/HLS forma mellett is újratölt, ha a másik szolgáltató stream URL-je eltér');
check(/previousDiagnostic\.streamUrl === url/.test(PLAYER) && /streamUrl: url,/.test(PLAYER),
  'a csatornaváltási mérés sem olvasztja össze a két szolgáltató azonos nevű/ID-jű streamjét');
check(PLAYER.includes("const variantChannelId = `${String(channelRef.current?.id || '')}|${streamUrl}`;"),
  'a helyreállítási próbálkozási létra szolgáltatóváltáskor új csatornaként indul');
check(/const channelKey = `\$\{providerScopeId\}::\$\{channelId\}`/.test(PLAYER)
  && /\[channel\?\.id, providerScopeId, isVod/.test(PLAYER),
  'az azonos ID-jű csatornák mentett hangsávja szolgáltatónként külön töltődik be');
check(/name === 'AbortError'/.test(PLAYER),
  'a gyors forrásváltás AbortError-ja NEM számít lejátszási hibának');
check(/switchInProgressRef\.current\) return;/.test(PLAYER),
  'a belső pause/play események nem írják át a lejátszási szándékot');
/*
 * 2.5.165: a felhasználó kérése – a csatornaváltás közötti háttér és a
 * betöltés felirat háttere FEKETE (korábban világoskék/türkiz volt). A réteg
 * továbbra is csak a „még nincs képkocka” ágban jelenik meg, tehát a már
 * futó adást nem takarja el.
 * 2.5.246/2.5.262: teljes képernyőn korábban átlátszóak voltak a rétegek.
 * 2.5.264 (#11): a #11 napló szerint a képkocka csak két képkockával később
 * érkezik, ezért teljes képernyőn MOST MINDIG FEKETE a konténer/poszter/videó
 * (csak a natív áadás, nativeHandoff esetén átlátszó) – így csatornaváltáskor a
 * főoldal többé nem villan be a teljes képernyős nézetbe.
 */
check(/currentStreamHasFrame \? \(/.test(PLAYER) && /data-playback-loading=""/.test(PLAYER)
  && /data-playback-loading="" className="[^"]*bg-black z-10 pointer-events-none"/.test(PLAYER),
  'a töltő réteg csak képkocka előtt jelenik meg, és mindig FEKETE (2.5.165 + 2.5.262)');
check(!/fsLayerSeeThrough/.test(PLAYER.replace(/\*[^]*?\*\//g, '')),
  'a régi fsLayerSeeThrough (képkocka-függő átlátszóság) megszűnt (2.5.264)');
check(/\$\{nativeHandoff \? 'bg-transparent' : 'bg-black'\}/.test(PLAYER)
  && /className="absolute inset-0 z-\[1\] flex flex-col items-center justify-center gap-3 bg-black pointer-events-none"/.test(PLAYER)
  && /className=\{isLead \? 'block h-full w-full bg-black' : 'hidden'\}/.test(PLAYER), // 2.5.279: két slot, a fő mindig fekete
  'teljes képernyőn a konténer/poszter/videó MINDIG fekete, csak nativeHandoff esetén átlátszó (2.5.264, #11)');
check(!/bg-\[#0b1c24\]|bg-\[#0d2630\]/.test(PLAYER),
  'a lejátszó dobozán nincs többé világoskék (türkiz) háttér');
check(/data-playback-status/.test(PLAYER)
  && /isFullscreen/.test(PLAYER)
  && /top-3 right-3/.test(PLAYER)
  && /bottom-3 left-3/.test(PLAYER),
  'fullscreenben a kis pörgő jelző az óra alatt jobb felül, normál nézetben bal alul marad');
check(/'waiting'/.test(SPEED) && /'stalled'/.test(SPEED)
  && /'error'/.test(SPEED) && /'seeking'/.test(SPEED)
  && /puffer-előre=/.test(SPEED)
  && /requestRecoveryRef\.current\('pufferelés elakadt'\)/.test(PLAYER),
  'a kézi eseménynapló a médiahibát, seeket, várakozást és puffert is rögzíti');
check(/böngésző stream-kérés elindult/.test(SPEED)
  && /első stream-metaadat megérkezett/.test(SPEED)
  && /első lejátszható médiaadat megérkezett/.test(SPEED)
  && /a puffer először lejátszható/.test(SPEED),
  'a kézi napló Resource Timing nélkül is méri a kérésindítást, metaadatot, első médiaadatot és lejátszhatóságot');
check(/isVerbosePlaybackLogging\(\)/.test(PLAYER) && /isVerbosePlaybackLogging\(\)/.test(APPLOG),
  'a részletes diagnosztika csak a hibakeresési ablakban fut');
check(!/runtimeDiagnosticState\(/.test(PLAYER)
  && !/getBoundingClientRect\(\)/.test(PLAYER.slice(PLAYER.indexOf('const videoDiagnosticState'), PLAYER.indexOf('const isActiveMediaEvent'))),
  'a célzott napló nem járja be az erőforrásokat és nem kényszerít layout-mérést');
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
  && /if \(!activeProvider \|\| activeProvider\.type !== 'xtream'\) \{\s*setLocalEpg\(\{\}\);/.test(CHANNEL_LIST)
  && /if \(!isActive\) return;/.test(CHANNEL_LIST)
  && /if \(!epgActive \|\| !epgReady\) return;/.test(CHANNEL_LIST)
  && /const epgActive = isActive && !epgPaused;/.test(CHANNEL_LIST),
  'a rejtett filmnézetben az EPG-munka nem fut háttérben, de az adat megmarad – visszatéréskor villámgyorsan, szaggatás nélkül (2.5.245)');
// 2.5.239: a formázó a TV saját időzónáját használja (localFormatter), de
// továbbra is EGYETLEN, gyorsítótárazott Intl példány.
check(/localFormatter\(\)\.formatToParts\(date\)/.test(APPLOG)
  && /stampFormatter = new Intl\.DateTimeFormat/.test(APPLOG),
  'az időbélyeg-formázó gyorsítótárazott (nincs új Intl példány soronként)');
check(/MIN_FORCE_INTERVAL_MS/.test(APPLOG),
  'a nagy napló szinkron írása összevont (nem minden kritikus sornál ír 1 MB-ot)');
check(/data-player-retry=""/.test(PLAYER) && /retryButtonRef/.test(PLAYER),
  'a hibaképernyő végre tartalmaz távirányítóval elérhető Újrapróbálás gombot');
check(!/A csatorna négy indítási próbálkozás után sem indult el/.test(PLAYER),
  'nincs többé végleges, négy próba utáni feladás');

/* 2.5.388: a #31-es napló négy hibája a TÉNYLEGES kódban is javítva van. */
const SUBTITLES = fs.readFileSync(path.resolve('web/src/services/embeddedSubtitleService.ts'), 'utf8');
const RECOVERY = fs.readFileSync(path.resolve('web/src/services/playbackRecovery.ts'), 'utf8');
check(/isVodRecoveryExhausted\(/.test(PLAYER) && /vodRecoveryBlockedRef/.test(PLAYER)
  && /VOD NEM INDULT EL – AUTOMATIKUS ÚJRAPRÓBÁLÁS LEÁLLÍTVA/.test(PLAYER)
  && /setErrorMessage\(\s*'Ez a film most nem indítható el/.test(PLAYER),
  'a soha el nem indult film 4 próba után tiszta „film nem elérhető” állapotot kap (nincs 40 mp-es kör)');
check(/vodHttpCheckedUrlRef/.test(PLAYER) && /VOD ELÉRHETŐSÉG-ELLENŐRZÉS/.test(PLAYER)
  && /export async function checkVodHttpStatus/.test(RECOVERY),
  'egyetlen HTTP-ellenőrzés dönti el a naplóban: 403/429, 404 vagy dekódolási hiba');
check(/if \(video\.readyState < 2\) hasVodData = false/.test(PLAYER)
  && !/hasVodData = hasVodData \|\| video\.buffered\.length > 0/.test(PLAYER),
  'a VOD indulási őr nem ad 3,5 mp türelmet a kész=0 / üres puffer állapotra');
check(/abortActiveStreamProbes/.test(PLAYER) && /export function abortActiveStreamProbes/.test(SUBTITLES)
  && /inFlightProbes/.test(SUBTITLES) && /bytes=0-\$\{PROBE_MAX_BYTES - 1\}/.test(SUBTITLES)
  && /xhr\.timeout = 8000/.test(SUBTITLES),
  'a fejléc-próbák címenként egyetlen Range-kérést nyitnak, 8 mp-es időkorláttal, forrásváltáskor megszakadnak');
check(/diagnosticProbeAllowedRef/.test(PLAYER) && /PROBE_STABLE_DELAY_MS = 15000/.test(PLAYER)
  && /BEÁGYAZOTT FELIRAT \(CC\) PRÓBA KIHAGYVA/.test(PLAYER)
  && /export function shouldAllowDiagnosticProbe/.test(RECOVERY),
  'a képminőség- és CC-próbák csak stabil lejátszás után nyitnak kapcsolatot (egykapcsolatos szolgáltató)');
check(/if \(vodRecoveryBlockedRef\.current\)/.test(PLAYER)
  && /NINCS ÚJABB JAVÍTÁSI LÉPÉS/.test(PLAYER),
  'a TV Doktor a leállított filmnél nem indít több 8 lépéses javítási létrát');

try { fs.rmSync(outFile, { force: true }); } catch { /* nem kritikus */ }
finish();
