#!/usr/bin/env node
/*
 * 2.5.418 – ÉLŐ ŐR: döntési logika a VALÓDI TV-naplók idővonalain.
 *
 * A teszt a tényleges forrást (web/src/services/liveWatchdog.ts) futtatja
 * esbuild-del, és a Supabase-be feltöltött TV-naplókból (#52, #60–#64)
 * kimért idővonalakat játssza vissza másodperces mintavétellel:
 *
 *   A) NEM SZABAD beavatkozni (hamis riasztás):
 *      - frissen indított csatorna természetes megállása 7–10 mp-nél, ami
 *        4,7–17 mp alatt MAGÁTÓL megoldódik (a régi 4,5 mp-es őr itt töltött
 *        újra minden csatornát),
 *      - 10 mp-enként ismétlődő rövid újrapufferelés,
 *      - 2 óra (és 24 óra) hibátlan lejátszás,
 *      - a néző által kért szünet, háttérbe tett alkalmazás, már ütemezett
 *        újracsatlakozás, lassan (21 mp) induló csatorna,
 *      - olyan TV, ahol az élő idővonal soha nem mozdul.
 *
 *   B) BE KELL avatkozni (valódi lefagyás):
 *      - `ended` (a szolgáltató lezárta a kapcsolatot; #52: 31,65 mp-nél),
 *      - váratlan pause, ami nem folytatódik,
 *      - tartós, haladás nélküli állapot,
 *      - 30 mp alatt el sem induló adás.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
const outDir = path.resolve('build/test');
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'live-watchdog.mjs');
await esbuild.build({
  entryPoints: [path.resolve('web/src/services/liveWatchdog.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
});
const wd = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
const {
  LiveWatchdog, LIVE_WATCHDOG_DEFAULTS, LONGEST_OBSERVED_NATURAL_REBUFFER_MS,
  resetLiveTimelineTrustForTests, isLiveTimelineTrusted, isContinuousLiveStreamUrl,
  liveWatchdogReasonText,
} = wd;

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ HIBA: ${label}`); }
}

/*
 * Idővonal-szimulátor. A `segments` egymást követő szakaszok listája:
 *   { play: ms }            – a kép halad (currentTime a faliórával nő)
 *   { stall: ms }           – a kép áll (waiting / néma megállás), nem paused
 *   { pause: ms }           – paused=true (váratlan szünet)
 *   { ended: ms }           – ended=true, paused=true
 *   { startup: ms }         – még nincs `playing`
 *   { inactive: ms, ... }   – a néző nem kér lejátszást / háttér / recovery fut
 * A visszatérés: az őr összes nem-„none” döntése időbélyeggel.
 */
function run(segments, { config, tickMs = 1000, startAt = 1_000_000, watchdog, trusted = true } = {}) {
  resetLiveTimelineTrustForTests(trusted);
  const dog = watchdog || new LiveWatchdog(config);
  let now = startAt;
  let position = 0;
  let started = false;
  dog.reset(now);
  const actions = [];
  let stableCount = 0;
  for (const segment of segments) {
    const kind = Object.keys(segment).find((key) => ['play', 'stall', 'pause', 'ended', 'startup', 'inactive'].includes(key));
    const duration = segment[kind];
    const end = now + duration;
    if (kind !== 'startup' && kind !== 'inactive') started = true;
    if (segment.started === false) started = false;
    while (now < end) {
      const step = Math.min(tickMs, end - now);
      now += step;
      if (kind === 'play') position += step / 1000;
      const decision = dog.observe({
        now,
        currentTime: segment.frozenTimeline ? 0 : position,
        paused: kind === 'pause' || kind === 'ended' || Boolean(segment.paused),
        ended: kind === 'ended',
        hasError: Boolean(segment.hasError),
        seeking: Boolean(segment.seeking),
      }, { active: kind !== 'inactive', playbackStarted: started });
      if (decision.becameStable) stableCount += 1;
      if (decision.action !== 'none') {
        actions.push({ at: now - startAt, action: decision.action, reason: decision.reason, elapsedMs: decision.elapsedMs });
        if (segment.stopOnAction) return { actions, stableCount, dog, now, position };
      }
    }
  }
  return { actions, stableCount, dog, now, position };
}

console.log('\n=== 1. Beállítások: a határ a mért természetes újrapufferelés fölött van ===\n');
check(LONGEST_OBSERVED_NATURAL_REBUFFER_MS >= 16809,
  'a naplókban mért leghosszabb, magától megoldódó megállás (16 809 ms) rögzítve');
check(LIVE_WATCHDOG_DEFAULTS.stallReconnectMs >= LONGEST_OBSERVED_NATURAL_REBUFFER_MS + 5000,
  `a haladás nélküli határ (${LIVE_WATCHDOG_DEFAULTS.stallReconnectMs} ms) legalább 5 mp-cel a természetes megállás fölött`);
check(LIVE_WATCHDOG_DEFAULTS.stallReconnectMs > 4500 * 4,
  'a régi, hamisan riasztó 4 500 ms-es határnak több mint a négyszerese');
check(new LiveWatchdog({ stallReconnectMs: 4500 }).config.stallReconnectMs > LONGEST_OBSERVED_NATURAL_REBUFFER_MS,
  'hibás (túl rövid) beállítás sem viheti a határt a természetes megállás alá');
check(LIVE_WATCHDOG_DEFAULTS.endedConfirmMs <= 1500 && LIVE_WATCHDOG_DEFAULTS.pauseResumeMs <= 2000,
  'az ended és a váratlan pause gyorsan (≤ 1,5–2 mp) kap választ');
check(LIVE_WATCHDOG_DEFAULTS.startupReconnectMs >= 25000,
  'az indulási határ türelmes (a naplóban 21 mp-ig induló csatorna is volt)');

console.log('\n=== 2. HAMIS RIASZTÁS TILOS: frissen indított csatorna természetes megállása ===\n');
/* #62–#64: `waiting` 7,5–10 mp pozíciónál, `playing` UGYANOTT ennyi ms múlva. */
const observedSelfRecoveryMs = [11677, 16809, 8960, 9345, 9087, 12219, 9853, 10710, 9476, 9707, 4724, 9792, 9082, 15912];
let falseAlarms = 0;
let oldWatchdogWouldFire = 0;
for (const waitMs of observedSelfRecoveryMs) {
  const result = run([
    { startup: 2500 },
    { play: 8200 },
    { stall: waitMs },
    { play: 9500 },
    { stall: 7900 },          // a naplókban gyakori 2. megállás 17–18 mp-nél
    { play: 600_000 },
  ]);
  falseAlarms += result.actions.length;
  if (waitMs >= 4500) oldWatchdogWouldFire += 1;
}
check(falseAlarms === 0,
  `mind a ${observedSelfRecoveryMs.length} mért indulási megállás (4,7–16,8 mp) beavatkozás NÉLKÜL megy át`);
check(oldWatchdogWouldFire === observedSelfRecoveryMs.length,
  `ugyanezekbe a régi 4,5 mp-es őr ${oldWatchdogWouldFire}/${observedSelfRecoveryMs.length} esetben töltött volna bele (ez volt a hiba)`);
{
  /* #64, 3. váltás: 10 mp-enként rövid megállás (27,8 / 37,0 / 48,1 / 57,7 mp; 0,5–7,5 mp). */
  const result = run([
    { startup: 2400 }, { play: 8300 }, { stall: 11600 }, { play: 9500 }, { stall: 7900 },
    { play: 10100 }, { stall: 7500 }, { play: 9200 }, { stall: 500 }, { play: 11100 }, { stall: 6400 },
    { play: 9600 }, { stall: 3100 }, { play: 1_800_000 },
  ]);
  check(result.actions.length === 0, 'a 10 mp-enként ismétlődő rövid újrapufferelés sem indít újratöltést');
}
{
  const result = run([{ startup: 2000 }, { play: 8000 }, { stall: LONGEST_OBSERVED_NATURAL_REBUFFER_MS + 4000 }, { play: 60000 }]);
  check(result.actions.length === 0, 'még a mért maximumnál 4 mp-cel hosszabb (21 mp) megállás is beavatkozás nélkül megy át');
}

console.log('\n=== 3. HAMIS RIASZTÁS TILOS: hosszú, hibátlan lejátszás ===\n');
{
  const twoHours = run([{ startup: 2200 }, { play: 2 * 60 * 60 * 1000 }]);
  check(twoHours.actions.length === 0, '2 óra folyamatos lejátszás: 0 beavatkozás (a felhasználó mérése)');
  check(twoHours.stableCount === 1, 'a „stabil adás” jelzés betöltésenként pontosan egyszer érkezik');
  const day = run([{ startup: 2200 }, { play: 24 * 60 * 60 * 1000 }], { tickMs: 1000 });
  check(day.actions.length === 0, '24 óra folyamatos lejátszás: 0 beavatkozás');
}
{
  // Akadozó főszál: a mintavétel 26 mp-re kimarad, közben a kép haladt.
  resetLiveTimelineTrustForTests(true);
  const dog = new LiveWatchdog();
  let now = 5_000_000;
  dog.reset(now);
  let position = 0;
  const actions = [];
  const sample = (advanceMs) => {
    now += advanceMs; position += advanceMs / 1000;
    const decision = dog.observe({ now, currentTime: position, paused: false, ended: false, hasError: false }, { active: true, playbackStarted: true });
    if (decision.action !== 'none') actions.push(decision);
  };
  for (let i = 0; i < 20; i += 1) sample(1000);
  sample(26000);
  for (let i = 0; i < 20; i += 1) sample(1000);
  check(actions.length === 0, 'kimaradó mintavétel (26 mp-es főszál-akadás) haladó kép mellett nem riaszt');
}
{
  const result = run([{ startup: 2000 }, { play: 30000 }, { play: 5000, seeking: true }, { play: 30000 }]);
  check(result.actions.length === 0, 'keresés / élő élre ugrás nem megakadás');
}

console.log('\n=== 4. HAMIS RIASZTÁS TILOS: a néző szándéka és a foglalt állapotok ===\n');
{
  const result = run([{ startup: 2000 }, { play: 60000 }, { inactive: 600_000, paused: true }, { play: 60000 }]);
  check(result.actions.length === 0, 'a néző által kért 10 perces szünet: sem folytatás, sem újratöltés');
  const after = run([{ startup: 2000 }, { play: 60000 }, { inactive: 600_000, paused: true }, { stall: 20000 }, { play: 30000 }]);
  check(after.actions.length === 0, 'szünet után a megakadás-mérés nulláról indul (a szünet ideje nem számít bele)');
}
{
  const result = run([{ startup: 2000 }, { play: 30000 }, { inactive: 120_000 }, { play: 30000 }]);
  check(result.actions.length === 0, 'háttérbe tett alkalmazás / már ütemezett újracsatlakozás alatt az őr nem indít másodikat');
}
{
  const result = run([{ startup: 21000 }, { play: 60000 }]);
  check(result.actions.length === 0, 'a naplóban látott 21 mp-es lassú indulás nem vált ki újrapróbát');
}
{
  const result = run([{ startup: 2000 }, { stall: 40000, hasError: true }]);
  check(result.actions.length === 0, 'médiahiba mellett az őr hallgat (azt az `error` útvonal kezeli, nincs dupla újratöltés)');
}
{
  // Régi webOS: az élő TS idővonala mindig 0 – a haladás hiánya semmit nem bizonyít.
  const result = run([{ startup: 2000 }, { stall: 3_600_000, frozenTimeline: true }], { trusted: false });
  check(result.actions.length === 0, 'soha nem mozduló idővonalú TV-n nincs időzített újratöltés');
  check(isLiveTimelineTrusted() === false, 'ilyen TV-n az idővonal nem válik „megbízhatóvá”');
  const ended = run([{ startup: 2000 }, { stall: 30000, frozenTimeline: true }, { ended: 5000, stopOnAction: true }], { trusted: false });
  check(ended.actions.length === 1 && ended.actions[0].reason === 'ended',
    '…de az `ended` végállapotot ott is kezeljük');
}

console.log('\n=== 5. VALÓDI LEFAGYÁS: ended (#52 – a szolgáltató lezárta a kapcsolatot) ===\n');
{
  const result = run([{ startup: 1700 }, { play: 31650 }, { ended: 60000, stopOnAction: true }]);
  const first = result.actions[0];
  check(result.actions.length === 1 && first.action === 'reconnect' && first.reason === 'ended',
    '31,65 mp-nél érkező ended → újracsatlakozás');
  const reaction = first.at - (1700 + 31650);
  check(reaction >= LIVE_WATCHDOG_DEFAULTS.endedConfirmMs && reaction <= 2500,
    `a reakció ${reaction} ms (megerősítés után, de 2,5 mp-en belül) – nem marad fagyott kép`);
  const transient = run([{ startup: 1700 }, { play: 20000 }, { ended: 400 }, { play: 60000 }], { tickMs: 200 });
  check(transient.actions.length === 0, 'a megerősítési időn belül magától eltűnő ended-jelzés nem tölt újra');
  const repeat = run([{ startup: 1700 }, { play: 31650 }, { ended: 5200 }]);
  check(repeat.actions.length >= 2 && repeat.actions.every((item) => item.reason === 'ended'),
    'ha az első kérés elveszne, az őr megismétli (nem ragad be)');
}

console.log('\n=== 6. VALÓDI LEFAGYÁS: váratlan pause ===\n');
{
  const resumed = run([{ startup: 2000 }, { play: 40000 }, { pause: 3500 }, { play: 60000 }]);
  check(resumed.actions.length === 1 && resumed.actions[0].action === 'resume',
    'váratlan pause → ELŐBB helyi folytatás (`play()`), nincs újratöltés');
  check(resumed.actions[0].elapsedMs >= LIVE_WATCHDOG_DEFAULTS.pauseResumeMs && resumed.actions[0].elapsedMs <= 2500,
    'a helyi folytatás 1,5–2,5 mp-en belül megtörténik');
  const stuck = run([{ startup: 2000 }, { play: 40000 }, { pause: 12000, stopOnAction: false }]);
  const resumes = stuck.actions.filter((item) => item.action === 'resume');
  const reconnects = stuck.actions.filter((item) => item.action === 'reconnect');
  check(resumes.length >= 2 && reconnects.length === 1 && reconnects[0].reason === 'paused',
    'ha a folytatás nem sikerül: több helyi próba, majd EGY újracsatlakozás');
  check(reconnects[0].elapsedMs >= LIVE_WATCHDOG_DEFAULTS.pauseReconnectMs && reconnects[0].elapsedMs <= 11000,
    'az újracsatlakozás ~10 mp tartós szünet után jön');
  const short = run([{ startup: 2000 }, { play: 40000 }, { pause: 900 }, { play: 60000 }], { tickMs: 300 });
  check(short.actions.length === 0, 'pillanatnyi (< 1,5 mp) pause-villanás semmit nem vált ki');
}

console.log('\n=== 7. VALÓDI LEFAGYÁS: tartós, haladás nélküli állapot ===\n');
{
  const result = run([{ startup: 2000 }, { play: 45000 }, { stall: 120000, stopOnAction: true }]);
  const first = result.actions[0];
  check(result.actions.length === 1 && first.action === 'reconnect' && first.reason === 'stalled',
    'végleg megálló kép → újracsatlakozás');
  const frozenFor = first.at - (2000 + 45000);
  check(frozenFor >= LIVE_WATCHDOG_DEFAULTS.stallReconnectMs && frozenFor <= LIVE_WATCHDOG_DEFAULTS.stallReconnectMs + 1500,
    `a beavatkozás ${frozenFor} ms megállás után jön (nem korábban, nem sokkal később)`);
  const early = run([{ startup: 2000 }, { play: 45000 }, { stall: LIVE_WATCHDOG_DEFAULTS.stallReconnectMs - 1000 }, { play: 30000 }]);
  check(early.actions.length === 0, 'a határ előtt 1 mp-cel továbbinduló kép: nincs újratöltés');
  // Újracsatlakozás után az új kapcsolat természetes megállása megint nem riaszthat.
  const dog = result.dog;
  const afterReconnect = run([{ startup: 2500 }, { play: 8200 }, { stall: 16809 }, { play: 120000 }], { watchdog: dog });
  check(afterReconnect.actions.length === 0,
    'újracsatlakozás (reset) után az új kapcsolat természetes megállása megint beavatkozás nélkül megy át');
  const dead = run([{ startup: 2000 }, { play: 45000 }, { stall: 130000 }]);
  check(dead.actions.length >= 4 && dead.actions.every((item) => item.reason === 'stalled'),
    'ha a hívó nem tölt újra, az őr ~25 mp-enként újra jelez (nem némul el)');
  const silentReady = run([{ startup: 2000 }, { play: 25900 }, { stall: 60000, stopOnAction: true }]);
  check(silentReady.actions.length === 1,
    'néma megállás (readyState=4, „van puffer”, de az idővonal áll) is helyreáll – a puffer-kijelzés nem téveszti meg');
}

console.log('\n=== 8. VALÓDI LEFAGYÁS: el sem induló adás ===\n');
{
  const result = run([{ startup: 100000 }]);
  check(result.actions.length === 3 && result.actions.every((item) => item.action === 'reconnect' && item.reason === 'startup'),
    '30 mp alatt el sem induló adás → újrapróba, 30 mp-enként ismételve');
  check(result.actions[0].at >= 30000 && result.actions[0].at <= 31000, 'az első indulási újrapróba 30 mp-nél jön');
}

console.log('\n=== 9. A döntés nem függ a TV Doktortól, a pufferprofiltól és a szolgáltatótól ===\n');
{
  const source = fs.readFileSync(path.resolve('web/src/services/liveWatchdog.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check(!/^import /m.test(code), 'az őr önálló modul: semmit nem importál (nincs rejtett függés)');
  check(!/tvDoctor|doctor|bufferMode|bufferProfile|provider|settings/i.test(code),
    'az őr kódjában nincs TV Doktor-, pufferprofil-, beállítás- vagy szolgáltató-hivatkozás');
  const player = fs.readFileSync(path.resolve('web/src/components/VideoPlayer.tsx'), 'utf8');
  const start = player.indexOf('2.5.418 – ÉLŐ ŐR (mintavétel másodpercenként)');
  const end = player.indexOf('FILM / SOROZAT VISSZAÁLLÍTÁSA', start);
  const effect = player.slice(start, end);
  const observeCall = effect.slice(effect.indexOf('const active = '), effect.indexOf('if (decision.becameStable)'));
  check(start > 0 && end > start && observeCall.length > 200, 'a lejátszóban megvan az élő őr mintavevője');
  check(!/tvDoctorEnabledRef|bufferTiming\(|bufferModeRef|settings\./.test(observeCall),
    'a lejátszó az őr bemenetébe sem kever TV Doktor kapcsolót vagy pufferprofilt');
  check(/\[isVod, playbackActive, nativeHandoff\]/.test(effect),
    'az őr élettartama nem függ az `isPlaying` állapottól (az ended/pause nem állíthatja le)');
}

console.log('\n=== 10. Egykapcsolatos szolgáltató védelme: raw élő streamre nincs második kérés ===\n');
check(isContinuousLiveStreamUrl('http://host:8080/live/u/p/1096.ts') === true, 'a .ts élő cím folyamatos (második kapcsolat tilos)');
check(isContinuousLiveStreamUrl('http://host:8080/u/p/1096') === true, 'a kiterjesztés nélküli élő cím is folyamatos');
check(isContinuousLiveStreamUrl('http://host:8080/live/u/p/1096.ts?token=abc.m3u8') === true, 'a lekérdezés szövege nem téveszti meg');
check(isContinuousLiveStreamUrl('http://host:8080/live/u/p/1096.m3u8') === false, 'a HLS lista rövid, lezáruló kérés (megengedett)');
check(isContinuousLiveStreamUrl('http://host:8080/live/u/p/1096.M3U8?x=1') === false, 'HLS nagybetűvel és lekérdezéssel is felismerve');
check(isContinuousLiveStreamUrl('') === false, 'üres címre nincs döntés');
{
  const subtitle = fs.readFileSync(path.resolve('web/src/services/liveSubtitleService.ts'), 'utf8');
  const probeBody = subtitle.slice(subtitle.indexOf('export async function probeLiveSubtitles'), subtitle.indexOf('export async function probeLiveSubtitles') + 1400);
  const codecBody = subtitle.slice(subtitle.indexOf('export async function probeLiveStreamCodecs'), subtitle.indexOf('export async function probeLiveStreamCodecs') + 600);
  check(/if \(isContinuousLiveStreamUrl\(url\)\) return \[\];/.test(probeBody)
    && probeBody.indexOf('isContinuousLiveStreamUrl(url)') < probeBody.indexOf('fetchLiveHead(url)'),
    'a felirat-fejlécpróba raw élő címre a hálózati kérés ELŐTT visszatér');
  check(/if \(isContinuousLiveStreamUrl\(url\)\) return null;/.test(codecBody)
    && codecBody.indexOf('isContinuousLiveStreamUrl(url)') < codecBody.indexOf('fetchLiveProgram(url)'),
    'a kodek-fejlécpróba (kézi napló) raw élő címre a hálózati kérés ELŐTT visszatér');
}

console.log('\n=== 11. Ok-szövegek ===\n');
check(/^élő adás vége/.test(liveWatchdogReasonText('ended', 1200)),
  'az ended ok-szövege az „élő adás vége” előtaggal a recovery külön számlálóját használja');
check(/25(\.0)? mp/.test(liveWatchdogReasonText('stalled', 25000)) && /nem halad/.test(liveWatchdogReasonText('stalled', 25000)),
  'a megakadás ok-szövege tartalmazza a mért időt');
check(/szünet/.test(liveWatchdogReasonText('paused', 10000)) && /sem indult el/.test(liveWatchdogReasonText('startup', 30000)),
  'a pause és az indulás ok-szövege egyértelmű');

console.log(`\n=== EREDMÉNY: ${passed}/${passed + failed} ellenőrzés ===`);
if (failed) process.exit(1);
console.log('OK: az élő őr a valódi naplók idővonalain nem riaszt hamisan, a valódi lefagyást pedig helyreállítja.');
