#!/usr/bin/env node
/**
 * 2.5.403 – #46 ([HU] M2 UHD, 115 kB rendszernapló + Supabase tv_doctor_events).
 *
 * A FELHASZNÁLÓ JELENTÉSE:
 *   „M2 UHD teljesen katasztrófa. Egy bizonyíthatóan működő csatornát a
 *    TV Doktor nem próbál meg javítani, mégis »A csatorna jelenleg nem
 *    működik« feliratot dob. Csak ts próbálkozások és semmi, a 16 fajta
 *    hiba próbálkozás beállítás helyett csak a kiegyensúlyozott profilt
 *    használja.”
 *
 * A #46 BIZONYÍTÉKA (rendszernapló):
 *   ord 333/334:  playing 1614 ms → SIKERES
 *   ord 364/365:  playing 4512 / 1385 ms → SIKERES
 *   ord 381/382:  playing 1431 ms → SIKERES
 *   ord 387:      t=39.75 s; duration=39.75 s (bizonyított lejátszás)
 *   ord 438/440:  „próbák=5/6; ok=a csatorna nem működik, végtelen ciklus
 *                  megelőzve” + „A csatorna jelenleg nem működik”
 *   5× „ÉLŐ ÚJRACSATLAKOZÁS (TV DOKTOR 1/8); puffer=balanced”, 0× 2/8.
 *
 * A SUPABASE BIZONYÍTÉKA (`hu:m2-uhd`, 2026-11-08 23:21–23:23):
 *   repair_attempt ts/balanced ×2, hls/balanced ×1, ts/adaptive-3 ×1,
 *   buffer_test ts/adaptive-3 ×1, speed_test hls/fast ×1, diagnostic ×7.
 *   Vagyis a felhő is azt mutatja: alig néhány, többségében azonos próba.
 *
 * EZ A TESZT a valódi kliens modult futtatja (esbuild + hamis Storage), és
 * a `VideoPlayer.tsx` tényleges újracsatlakozási ágát is forrásszinten ellenőrzi.
 * A feliratok/elnevezések, a 8 doboz és a kézi SÁRGA napló NEM változhatnak.
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
const storage = {
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.localStorage = storage;

const out = path.join(outDir, 'tv-doctor-recovery-403.mjs');
await esbuild.build({
  stdin: {
    contents: `export {
      planLiveRecoveryVariant, recordDoctorRecoveryVariant,
      LIVE_RECOVERY_VARIANT_COUNT, DOCTOR_LIVE_RECOVERY_BUFFER_ORDER,
      shouldSkipDoctorLadderForProvenChannel, canDeclareChannelDead,
      canDoctorIntervene, planDoctorRepairStep, setTvDoctorCloudHook,
      DOCTOR_HEALTHY_PLAYBACK_MS, MAX_INTERVENTIONS_PER_MINUTE,
      MAX_DOCTOR_REPAIR_STEPS, getDoctorBufferConfig,
      clearTvDoctorMemory, setTvDoctorHungarianChannelScope,
    } from './web/src/services/tvDoctor.ts';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  nodePaths: [path.join(ROOT, 'web/node_modules')], logLevel: 'silent',
});
const d = await import(pathToFileURL(out).href + '?v=' + Date.now());
const doctor = read('web/src/services/tvDoctor.ts');
const cloud = read('web/src/services/tvDoctorCloud.ts');
const player = read('web/src/components/VideoPlayer.tsx');
const modal = read('web/src/components/TvDoctorStatusModal.tsx');

/* ───────── 1. A #46 PONTOK: bizonyított lejátszás → NINCS halott ítélet ───────── */
console.log('\n=== 1. A bizonyítottan működő M2 UHD SOHA nem „nem működik” ===\n');

check(d.DOCTOR_HEALTHY_PLAYBACK_MS === 15000,
  'a bizonyított lejátszás küszöbe 15 s (a #46 16.48 / 15.76 / 39.75 s-e fölötte van)');
check(d.canDeclareChannelDead({ healthyPlaybackMs: 39_750 }) === false,
  '39.75 s bizonyított lejátszás után NEM lehet halottnak nyilvánítani a csatornát');
check(d.canDeclareChannelDead({ healthyPlaybackMs: 16_480 }) === false,
  '16.48 s (az első #46 playing) is elég a védelemhez');
check(d.canDeclareChannelDead({ healthyPlaybackMs: 0 }) === true,
  'a soha nem játszott csatorna továbbra is leállítható (nincs végtelen ciklus)');

/* A #46-ben a TLC-védelem minden eseménynél korai return-t adott → 0× 2/8. */
check(d.shouldSkipDoctorLadderForProvenChannel({
  trigger: 'unexpected_end', healthyPlaybackMs: 39_750, mediaError: false,
}) === true,
  'az ELSŐ véges idővonal után még csak újracsatlakozunk (TLC-védelem megmarad)');
check(d.shouldSkipDoctorLadderForProvenChannel({
  trigger: 'unexpected_end', healthyPlaybackMs: 39_750, mediaError: false,
  consecutiveFailures: 1,
}) === true,
  'a második próbánál sem ugrunk azonnal formátumot');
check(d.shouldSkipDoctorLadderForProvenChannel({
  trigger: 'unexpected_end', healthyPlaybackMs: 39_750, mediaError: false,
  consecutiveFailures: 2,
}) === false,
  'a 3. egymás utáni hiba után a javítási létra MÁR jogos (#46: eddig soha nem volt az)');
check(d.shouldSkipDoctorLadderForProvenChannel({
  trigger: 'unexpected_pause', healthyPlaybackMs: 39_750, mediaError: false,
  consecutiveFailures: 5,
}) === false,
  'az 5–6. próbánál a teljes létra jogos, nem ragadunk 1/8-nál');
check(d.shouldSkipDoctorLadderForProvenChannel({
  trigger: 'media_error', healthyPlaybackMs: 39_750, mediaError: true,
  consecutiveFailures: 9,
}) === false,
  'igazolt médiahiba továbbra is azonnal indítja a létrát');
check(d.shouldSkipDoctorLadderForProvenChannel({
  trigger: 'unexpected_end', healthyPlaybackMs: 4_000, mediaError: false,
  consecutiveFailures: 0,
}) === false,
  '4 mp lejátszás után a létra változatlanul jogos (nem bizonyított csatorna)');

/* A generic backoff attempt>=5 ágának bekötése a forrásban. */
check(/const provenWorkingChannel = tvDoctorEnabledRef\.current\s*\n\s*&& !canDeclareChannelDead\(\{ healthyPlaybackMs: recoveryDocState\.healthyPlaybackMs \}\)/.test(player),
  'az újracsatlakozási backoff is megvizsgálja a bizonyított lejátszást');
check(/if \(attempt >= 5 && !provenWorkingChannel\)/.test(player),
  'a végleges „nem működik” felirat CSAK nem bizonyított csatornánál fut le');
check(/if \(attempt >= 5 && provenWorkingChannel\)/.test(player),
  'bizonyított csatornánál külön, NEM hibás ág fut tovább');
check(/BIZONYÍTOTTAN MŰKÖDŐ CSATORNA – NINCS VÉGLEGES LEÁLLÍTÁS/.test(player),
  'a naplóban is egyértelmű: nincs végleges leállítás (a #46-ben ez a sor hiányzott)');
check(/setErrorMessage\('A csatorna jelenleg nem működik – az automatikus újrapróbálás leállt\.'\)/.test(player),
  'a felirat szövege VÁLTOZATLAN marad (csak a feltétel szigorodott)');
check(/if \(attempt >= 5 && !provenWorkingChannel\) \{[\s\S]{0,900}setErrorMessage\('A csatorna jelenleg nem működik/.test(player)
  && !/if \(attempt >= 5 && provenWorkingChannel\) \{[\s\S]{0,900}setHasError\(true\)/.test(player),
  'bizonyított csatornánál a `setHasError(true)` / „nem működik” NEM hívódik meg');

/* ───────── 2. A 16 KÜLÖNBÖZŐ HIBA-/ÚJRACSATLAKOZÁSI BEÁLLÍTÁS ───────── */
console.log('\n=== 2. 16 beállítás: 8 pufferprofil × 2 formátum, nem csak TS + balanced ===\n');

check(d.LIVE_RECOVERY_VARIANT_COUNT === 16,
  'a mátrix pontosan 16 különböző beállítás (a felhasználó által megadott szám)');
check(d.DOCTOR_LIVE_RECOVERY_BUFFER_ORDER.length === 8,
  '8 különböző pufferprofil van a létrában');
check(new Set(d.DOCTOR_LIVE_RECOVERY_BUFFER_ORDER).size === 8,
  'a 8 pufferprofil mindegyike különböző (nincs ismétlődő balanced)');

const variants = Array.from({ length: 16 }, (_, i) => d.planLiveRecoveryVariant({
  attempt: i, primaryFormat: 'ts', baseDelayMs: 60,
}));
const keys = variants.map((v) => `${v.format}|${v.bufferProfile}`);
check(new Set(keys).size === 16,
  'a 16 variáns MINDEGYIKE más formátum/puffer páros');
check(variants.filter((v) => v.format === 'hls').length === 8,
  '8 HLS-próba van (a #46-ben HLS csak elvétve, hibásan jelent meg)');
check(variants.filter((v) => v.format === 'ts').length === 8,
  '8 TS-próba van (nem „csak ts”, hanem fele-fele)');
check(variants.filter((v) => v.bufferProfile === 'balanced').length === 2,
  'a `balanced` csak 2/16 próbánál szerepel (#46-ben 10/10 volt)');
check(variants.every((v) => v.index >= 1 && v.index <= 16 && v.total === 16 && v.cycle === 0),
  'minden variáns 1..16 sorszámú, az első körben');
check(variants.every((v) => v.timing && v.timing.startupWatchdogMs > 0 && v.timing.minBufferAheadSeconds > 0),
  'minden variánshoz TÉNYLEGES indulási-őr / puffer-cél tartozik');
check(new Set(variants.map((v) => v.timing.minBufferAheadSeconds)).size >= 6,
  'legalább 6 különböző puffer-cél is fut (nem csak 3.0 s)');
check(variants[15].delayMs > variants[0].delayMs,
  'a várakozás fokozatosan nő, nem pörög végtelenül gyorsan');

const secondCycle = d.planLiveRecoveryVariant({ attempt: 16, primaryFormat: 'ts' });
check(secondCycle.index === 1 && secondCycle.cycle === 1 && secondCycle.bufferProfile === 'balanced',
  'a 17. próba a 16 variáns 2. körét kezdi, nem áll le „nem működik”-kel');
check(d.planLiveRecoveryVariant({ attempt: 16, primaryFormat: 'ts' }).delayMs
  > d.planLiveRecoveryVariant({ attempt: 0, primaryFormat: 'ts' }).delayMs,
  'a 2. kör lassabb, mint az első (a TV-t nem terheljük)');
const fromHls = d.planLiveRecoveryVariant({ attempt: 1, primaryFormat: 'hls' });
check(fromHls.format === 'ts' && fromHls.useAlternateFormat === true,
  'HLS elsődleges formátumnál a másik variáns TS-re vált');

/* A variáns TÉNYLEGESEN be van kötve az újracsatlakozásba. */
check(/const recoveryVariant = tvDoctorEnabledRef\.current && variantAttempt >= 1/.test(player),
  'a 2. újracsatlakozástól a 16 variáns tervezője fut');
check(/const liveRecoveryVariantRef = useRef\(0\)/.test(player),
  'a variánsoknak KÜLÖN, stabil számlálójuk van (#46: a `playing` mindig 0-ra állította a régit)');
check(/const variantAttempt = liveRecoveryVariantRef\.current\+\+/.test(player),
  'minden újracsatlakozás lépteti a variáns-számlálót, függetlenül a rövid `playing`-től');
check(/attempt: variantAttempt - 1/.test(player),
  'a variáns-számláló 0-alapúan megy át a 16 beállítás tervezőjébe');
check(/variantNow - liveRecoveryVariantLastAtRef\.current > 90_000/.test(player),
  '90 mp hibamentes lejátszás után új ciklus indulhat (nincs végtelen pörgés)');
check(/liveRecoveryVariantRef\.current,\n/.test(player),
  'a TLC-védelem is a stabil variáns-számlálót használja az ismétlődő hibák felismerésére');
check(/const nativeBufferMode = doctorSessionRef\.current\.activeBufferTiming/.test(player),
  'a natív híd is a kiválasztott pufferprofilt kapja, nem mindig `balanced`-et');
check(/const liveRecoveryVariantChannelRef = useRef\(''\)/.test(player)
  && /if \(liveRecoveryVariantChannelRef\.current !== variantChannelId\)/.test(player),
  'a forrásbetöltő effect CSAK valódi csatornaváltáskor nullázza a létrát, HLS↔TS újracsatlakozáskor NEM');
/* A rövid `playing` NEM nullázhatja a variáns-számlálót. */
const shortPlayingBlock = player.slice(player.indexOf('if (!isVod) {\n                recoveryAttemptRef.current = 0;'), player.indexOf('if (!isVod) {\n                recoveryAttemptRef.current = 0;') + 700);
check(shortPlayingBlock.length > 100 && !/liveRecoveryVariantRef\.current = 0/.test(shortPlayingBlock),
  'a rövid `playing` esemény NEM állítja vissza a 16 beállítás létráját 1/16-ra');
check(/recoveryDocState\.activeBufferProfile = recoveryVariant\.bufferProfile/.test(player),
  'az új pufferprofil TÉNYLEGESEN beállításra kerül');
check(/recoveryDocState\.activeBufferTiming = recoveryVariant\.timing/.test(player),
  'a `bufferTiming()` innentől az új indulási-őrt / lejátszás-őrt / puffer-célt adja');
check(/nextUrl = recoveryVariant\.useAlternateFormat \? alternateUrl : recoveryPrimaryUrl/.test(player),
  'a HLS ↔ TS formátumcsere TÉNYLEGESEN megtörténik az URL-ben');
check(/delayMs = recoveryVariant\.delayMs/.test(player),
  'a variáns várakozása is érvényesül');
check(/recordDoctorRecoveryVariant\(\{ channel: channelRef\.current, variant: recoveryVariant, reason \}\)/.test(player),
  'minden variáns bekerül a TV Doktor naplójába és a Supabase-be');
check(/TV DOKTOR ÚJRACSATLAKOZÁSI VÁLTOZAT/.test(player),
  'a rendszernaplóban soronként látszik, melyik a 16 beállítás közül futott');
check(/pufferprofil=\$\{tvDoctorEnabledRef\.current && doctorSessionRef\.current\.activeBufferTiming/.test(player),
  'a CSATORNAVÁLTÁS/ÚJRACSATLAKOZÁS START sor a VALÓDI profilt írja, nem mindig `balanced`-et');
check(/variáns=\$\{recoveryVariant\.index\}\/\$\{recoveryVariant\.total\}/.test(player),
  'az „ÉLŐ ÚJRACSATLAKOZÁS” sor is tartalmazza a variáns sorszámát');
check(/Javítás \$\{recoveryVariant\.index\}\/\$\{recoveryVariant\.total\}/.test(player),
  'a képernyőn is látszik a javítás sorszáma, nem csak „Adás frissítése”');

/* ───────── 3. A felhő-esemény: a Supabase-ben is 16 különböző sor ───────── */
console.log('\n=== 3. A Supabase tv_doctor_events is a 16 variánst mutatja ===\n');

const cloudEvents = [];
d.setTvDoctorCloudHook((p) => cloudEvents.push(p));
const M2 = { id: 'm2-uhd', name: '[HU] M2 UHD', streamUrl: 'http://p.example/live/m2.ts', countryCode: 'HU' };
d.setTvDoctorHungarianChannelScope(true);
for (let i = 0; i < 16; i += 1) {
  d.recordDoctorRecoveryVariant({
    channel: M2,
    variant: d.planLiveRecoveryVariant({ attempt: i, primaryFormat: 'ts' }),
    reason: 'élő adás vége',
  });
}
check(cloudEvents.length === 16, '16 `repair_attempt` esemény íródik a felhőbe');
check(cloudEvents.every((e) => e.eventType === 'repair_attempt'), 'mindegyik `repair_attempt`');
check(new Set(cloudEvents.map((e) => `${e.event.playbackFormat}|${e.event.bufferProfile}`)).size === 16,
  'a Supabase-ben 16 KÜLÖNBÖZŐ formátum/puffer páros van (#46-ben 4 féle volt)');
check(cloudEvents[0].event.channelKey === 'hu:m2-uhd',
  'a kanonikus `hu:m2-uhd` kulcs változatlan (2.5.401 eredménye)');
check(cloudEvents.every((e) => e.event.details?.recoveryVariant === true && e.event.details?.maxSteps === 16),
  'minden sor jelöli, hogy a 16 variánsos újracsatlakozásból jön');
check(cloudEvents.every((e) => e.event.details?.step >= 1 && e.event.details?.step <= 16),
  'a `details.step` 1..16, nem ragad 1/8-nál');
check(cloudEvents.filter((e) => e.event.playbackFormat === 'hls').length === 8,
  'a felhőben is 8 HLS + 8 TS próba van');
check(/const isRecoveryVariant = details\.recoveryVariant === true/.test(cloud),
  'a felhő felismeri a 16 variánsos újracsatlakozási eseményt');
check(/const maxStepsCap = isRecoveryVariant \? 16 : 8/.test(cloud),
  'a `maxSteps` NEM vágódik 8-ra a variánsoknál (#46: 4 féle próba volt csak)');
check(/Boolean\(item\.details\?\.recoveryVariant\) === isRecoveryVariant/.test(cloud),
  'a 16 variáns KÜLÖN keretet kap, nem ütik ki egymást a 8-as kategórialimitben');
check(/recoveryVariant: isRecoveryVariant \|\| undefined/.test(cloud),
  'a `tv_doctor_events.details` is jelöli a variánst a későbbi elemzéshez');
check(/MAX_CHANNEL_ROUTES/.test(cloud) && /MAX_CHANNEL_ROUTES\s*=\s*8/.test(doctor),
  'a 8 TANULÁSI DOBOZ változatlan marad (csak az események száma nő 16-ra)');
d.setTvDoctorCloudHook(null);

/* ───────── 4. A javítási létra nem ragad 1/8-nál ───────── */
console.log('\n=== 4. A létra 1 → 8-ig lép, nincs visszaesés 1/8-re ===\n');

check(d.MAX_DOCTOR_REPAIR_STEPS === 8, 'a tanulási dobozok száma változatlanul 8');
check(/state\.repairStep = state\.healthyPlaybackMs >= DOCTOR_HEALTHY_PLAYBACK_MS\s*\n\s*\? Math\.min\(MAX_DOCTOR_REPAIR_STEPS - 1, state\.repairStep\)\s*\n\s*: 0/.test(player),
  'a 12 mp-es elavulás-őr NEM nullázza vissza a lépést bizonyított csatornánál');
check(/provenWorking: !canDeclareChannelDead\(\{ healthyPlaybackMs: docState\.healthyPlaybackMs \}\)/.test(player),
  'a létra megkapja a „bizonyítottan működő” jelzést a magasabb próbalimithez');
check(/const interventionLimit = provenWorking \? LIVE_RECOVERY_VARIANT_COUNT : MAX_INTERVENTIONS_PER_MINUTE/.test(doctor),
  'bizonyított csatornánál 16 próba/perc engedett, nem 8');
check(d.canDoctorIntervene('hu:m2-uhd') === true, 'a beavatkozási kapu alapból enged');
check(d.MAX_INTERVENTIONS_PER_MINUTE === 8, 'a nem bizonyított csatorna 8/perces védelme megmarad');

/* Valódi létra futtatás egy bizonyított M2 UHD-n 1..8-ig. */
const ladderStore = {
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
const steps = [];
for (let step = 1; step <= 8; step += 1) {
  const p = d.planDoctorRepairStep({
    channel: M2,
    trigger: step <= 2 ? 'unexpected_end' : 'media_error',
    step,
    currentFormat: 'ts',
    currentBufferProfile: 'balanced',
    streamUrl: M2.streamUrl,
    tsUrl: M2.streamUrl,
    hlsUrl: 'http://p.example/live/m2.m3u8',
    storage: ladderStore,
    provenWorking: true,
  });
  steps.push(p);
}
check(steps.every((p, i) => p.step === i + 1), 'a létra 1/8, 2/8, …, 8/8-ig halad');
check(new Set(steps.map((p) => p.strategyId)).size >= 6,
  'legalább 6 KÜLÖNBÖZŰ javítási stratégia fut (#46-ben 5× ugyanaz az 1/8 volt)');
check(steps.some((p) => p.nextFormat === 'hls'), 'a létra ténylegesen kipróbálja a HLS-t');
check(steps.some((p) => p.nextBufferProfile !== 'balanced'), 'a létra ténylegesen vált pufferprofilt');
check(!steps.some((p) => p.strategyId === 'intervention_rate_limited'),
  'a bizonyított csatornát a 8/perces limit NEM fogja vissza');
check(!steps.slice(0, 7).some((p) => p.exhausted === true),
  'a 8. lépés előtt nincs „kimerült / nem működik” ítélet');

/* ───────── 5. Változatlan követelmények (2.5.397/399/401) ───────── */
console.log('\n=== 5. A korábbi elfogadási feltételek változatlanok ===\n');

check(/MAX_CHANNEL_ROUTES\s*=\s*8/.test(doctor), 'pontosan 8 tanulási doboz (1 alap + 7 tanult)');
check(/(szükség esetén beavatkozik|TV DOKTOR)/.test(modal), 'a TV Doktor feliratai/elnevezései változatlanok');
check(/discardSentAppLog|clearAppLog/.test(read('web/src/services/appLog.ts')),
  'a kézi SÁRGA diagnosztikai napló teljes küldése változatlan');
check(/clearTvDoctorBaselinesInCloud/.test(read('web/src/services/tvDoctorCloud.ts')),
  'a „Memória: 0” teljes felhőbeli törlése változatlan');
check(/tv_doctor_baselines_clear/.test(read('web/src/services/tvDoctorCloud.ts'))
  && /tv_doctor_routes_upsert/.test(read('web/src/services/tvDoctorCloud.ts'))
  && /baselines_clear/.test(read('supabase/migrations/20261108213252_tv_doctor_full_reset_true_upsert.sql')),
  'a true-upsert / baselines_clear útvonal változatlan (kliens + migráció)');
check(/normalizeSavedLayoutChannelKey/.test(doctor) && /hu:m2-uhd/.test(doctor + read('tools/test-tv-doctor-learning-401.mjs')),
  'a `HU - …` ≡ `[HU] …` kanonikus kulcs változatlan');

console.log(`\n${'='.repeat(78)}`);
console.log(`  TV DOKTOR #46 / M2 UHD REGRESSZIÓ: ${passed}/${passed + failed} ellenőrzés, ${failed} hiba`);
console.log('='.repeat(78));
if (failed) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
