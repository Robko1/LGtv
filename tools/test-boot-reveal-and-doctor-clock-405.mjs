#!/usr/bin/env node
/**
 * 2.5.405 / #50 (TV Doktor / Supabase) + 2.5.406 (gyors indulás, nincs 2. takarókép).
 *
 * A 2.5.405 / #49 8 s videó-kapuja, 12 s kemény korlátja, 14 s HTML
 * vészfogója és a MÁSODIK `#tv-curtain` takaróréteg a felhasználó mérése
 * szerint ~(kétszeresére) LASSÍTOTTA az IPK indulását: „sokkal lassab igy az
 * indulás … nem eszt kértem … már van takaró kép nem kell még egy!”
 * A 2.5.406 ezért visszaállítja a bevált gyors indulást (0 ms videó-kapu,
 * 1,5 s gyors háló, 9 s kemény korlát, natív splash az első React gyermeknél),
 * és KIKAPCSOLJA az automatikus kézi hiba naplót (csak kézi indítás).
 *
 * A #50 NAPLÓ + ÉLŐ SUPABASE BIZONYÍTÉKA:
 *   a bal felső 4 kártya `Mikor:` 00:xx-et mutatott, a fejléc sárga órája
 *   01:xx-et. A napló (`dateTimeText` → Europe/Dublin) helyes; a felhasználói
 *   kártyáknak a TV HELYI idejét kell mutatniuk. A `tv_doctor_events`-ben
 *   már él a 2.5.403 16 variánsa: `Próba 3 / 16: TS + fast •
 *   recovery_buffer_profile • recoveryVariant=true`, de a kliens és az Edge
 *   Function bootstrap 8-ra vágta a lépésszámot / eseményszámot.
 *
 * Ez a teszt forrásszinten ÉS valódi esbuild + Storage futásidőben ellenőriz.
 */
process.env.TZ = 'Europe/Budapest';

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

const main = read('web/src/main.tsx');
const app = read('web/src/App.tsx');
const indexHtml = read('web/index.html');
const player = read('web/src/components/VideoPlayer.tsx');
const modal = read('web/src/components/TvDoctorStatusModal.tsx');
const clock = read('web/src/utils/clock.ts');
const doctor = read('web/src/services/tvDoctor.ts');
const guide = read('web/src/services/epgGuide.ts');
const appLog = read('web/src/services/appLog.ts');
const edge = read('supabase/functions/tv-doctor/index.ts');

/* ============ 1. 2.5.406 – GYORS INDULÁS, NINCS MÁSODIK TAKARÓKÉP ============ */
console.log('\n=== 1. 2.5.406: gyors IPK-indulás, nincs extra takaróréteg ===\n');

check(/const VIDEO_WAIT_MS = 0;/.test(main),
  'NINCS 8 s mesterséges videó-képkocka várakozás (vissza a gyors 0 ms-re)');
check(/const LOGO_WAIT_MS = 0;/.test(main),
  'a logókra továbbra sincs mesterséges várakozás');
check(!/BOOT_MAX_REVEAL_MS/.test(main) && /if \(elapsed > 9000\)/.test(main),
  'a kemény korlát vissza 9 s-re (nincs 12 s-es lassú boot)');
check(!/bootDataReady/.test(main),
  'a bootDataReady / mentett HU EPG kapu teljesen kikerült a felfedésből');
check(/if \(chromeOk && \(listOk \|\| onlyDialog\)\)/.test(main),
  'a fő felfedési kapu újra azonnal enged, ha a fejléc + lista kész');
check(/elapsed > BOOT_FAST_REVEAL_MS && chromeOk && bootState\(\) !== "checking"\s*\n\s*&& liveListReady\(\) && listOk\)/.test(main),
  'az 1,5 s gyors háló visszanyerte az eredeti, gyors feltételét');
check(/if \(elapsed > 3500 && chromeReady\(\) && bootState\(\) === "checking"\)/.test(main),
  'a 3,5 s tároló-próba háló sem vár extra kapukra');
check(/window\.setTimeout\(releaseNativeSplash, 0\)/.test(main)
  && /window\.setTimeout\(releaseNativeSplash, 16\)/.test(main),
  'a natív splash AZ ELSŐ React gyermeknél, extra várakozás nélkül megy le');
check(/if \(nativeSplashReleased\) return;/.test(main),
  'a `notifyAppLoaded` így is PONTOSAN EGYSZER fut');
check(!/tv-curtain/.test(indexHtml) && !/14000/.test(indexHtml),
  'az index.html-ben NINCS második takaróréteg és 14 s-es vészfogó');
check(!/tv-curtain/.test(main),
  'a felfedés sem keres többé saját takaróréteget');
check(/window\.__IPTV_AUDIO_GATE__ = true;/.test(indexHtml)
  && /__IPTV_AUDIO_GATE__ = false/.test(main) && /'iptv-audio-open'/.test(main),
  'a hangzár változatlan: HTML-ben zár, a gyors felfedéskor NYÍLIK (nincs néma lejátszás)');
check(/iptv-revealed/.test(main) && /__IPTV_APP_READY__/.test(main),
  'a kész-jelzők megmaradnak (a smoke teszt és a webos.js UI-őre miatt)');
check(!/restoreHuGuideForBoot/.test(app) && !/restoreHuGuideForBoot/.test(guide),
  'a mentett HU EPG NEM töltődik vissza a takaró alatt (nincs extra indulási munka)');
check(!/__IPTV_BOOT_DATA_READY__/.test(app),
  'az App nem jelez boot-adatkészséget (nem kell rá várni)');
check(!/bootDataReady/.test(appLog) && !/12 s kemény korlát/.test(appLog),
  'a kézi napló fejléce sem hivatkozik a megszüntetett 12 s kapura');
check(/TEST_STARTUP_DIAGNOSTICS = false/.test(read('web/src/services/diagnosticsConfig.ts')),
  'az AUTOMATIKUS kézi hiba napló KI van kapcsolva: csak kézi (SÁRGA) indítás van');
check(!/startAutomaticTestLogging/.test(read('web/src/services/diagnosticsBootstrap.ts'))
  && /installCrashHandlers\(\)/.test(read('web/src/services/diagnosticsBootstrap.ts')),
  'a bootstrap NEM indít automatikus naplót, csak passzív crash-handlereket telepít');
check(/9 másodperc alatt/.test(main) && !/12 másodperc alatt/.test(main),
  'a kemény korlát naplóüzenete is visszaállt 9 s-re');

/* ===================== 2. #50 – 4 KÁRTYA TV-HELYI IDEJE ===================== */
console.log('\n=== 2. #50: a bal felső 4 kártya a TV óráját mutatja, a NAPLÓ nem változik ===\n');

check(/export function formatDeviceClock/.test(clock)
  && /export function formatDeviceDateTime/.test(clock)
  && /date\.getHours\(\)/.test(clock),
  'új TV rendszer-helyi, másodperces formázó (`getHours`, nincs kézi eltolás)');
check(/import \{ formatDeviceClock, formatDeviceDateTime \} from '\.\.\/utils\/clock'/.test(modal),
  'a TV Doktor panel importálja a TV-helyi formázót');
check(/const formatPanelClock = \(ts: number\): string => formatDeviceClock\(ts\);/.test(modal),
  'a 4 kártya külön `formatPanelClock()`-ot kap');
check(/Mikor: \$\{formatPanelClock\(stat\.lastAt\)\}/.test(modal),
  'a `Mikor:` sor már a TV-helyi órát használja (#50: +1 óra)');
check(/formatDeviceDateTime\(stat\.lastAt\)/.test(modal),
  'a kártya teljes dátum tooltipje is TV-helyi');
check(/const formatLogClock = \(ts: number\): string => \{[\s\S]{0,220}dateTimeText\(ts\)/.test(modal),
  'a NAPLÓLISTA formázója VÁLTOZATLANUL `dateTimeText()` / Europe/Dublin');
check(/formatLogClock\(entry\.at\)/.test(modal),
  'a kézi SÁRGA / TV DOKTOR napló sorai nem tolódnak el');
check(/const lastSyncText = doctorCloud\.lastSyncAt[\s\S]{0,700}dateTimeText\(parsed\)/.test(modal),
  'az `Utolsó szinkron` marad Dublin-formázóval (#50: 01:05 = a TV órája)');
check(/timeZone: 'Europe\/Dublin'/.test(appLog),
  'az appLog globális napló-időzónáját NEM változtattuk meg');

/* Futásidejű: ugyanaz az epoch 01:05:33 a TV-n, 00:05:33 a naplóban. */
const clockOut = path.join(outDir, 'clock-405.mjs');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'web/src/utils/clock.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: clockOut, logLevel: 'silent',
});
const clockMod = await import(pathToFileURL(clockOut).href + '?v=' + Date.now());
const epoch = Date.UTC(2026, 10, 9, 0, 5, 33);
const dublin = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(new Date(epoch));
check(clockMod.formatDeviceClock(epoch) === '01:05:33',
  `TV-helyi óra = 01:05:33 (kapott: ${clockMod.formatDeviceClock(epoch)})`);
check(dublin === '00:05:33',
  `a napló Dublin-órája = 00:05:33 (kapott: ${dublin})`);
check(clockMod.formatDeviceClock(epoch) !== dublin,
  'a két nézet pontosan 1 órával tér el – ezt a #50 kártya-eltérést javítottuk');
check(clockMod.formatDeviceDateTime(epoch).startsWith('2026-11-09 01:05:33'),
  'a teljes TV-helyi dátum is a TV óráját mutatja');

/* ===================== 3. #50 – 16 VARIÁNS A SUPABASE-BEN IS ===================== */
console.log('\n=== 3. #50: a 16 variáns lépésszáma nem vágódik 8-ra ===\n');

check(/const channelKey = record\?\.channelKey \|\| \(channel \? normalizeChannelDoctorKey\(channel\) : ''\)/.test(doctor),
  'helyi rekord nélkül is a kanonikus `hu:…` kulcs illeszti a felhős naplósort');
check(/const channelId = typeof item\.channelId === 'string'/.test(doctor),
  'a `mergeCloudDoctorLogs()` megőrzi a felhős `channelId`-t is');
check(/export const MAX_DOCTOR_LOG_STEPS = 16;/.test(doctor)
  && /function clampDoctorLogMaxSteps/.test(doctor),
  'a kliens 16-os lépéskeretet vezetett be (a 8 doboz változatlan)');
check(/const recoveryVariant = details\.recoveryVariant === true/.test(doctor)
  && /rawMaxSteps = details\.maxSteps \?\? \(recoveryVariant \? MAX_DOCTOR_LOG_STEPS : 8\)/.test(doctor),
  'a `mergeCloudDoctorLogs()` felismeri a felhő 16 variánsos eseményét');
check(!/Math\.max\(1, Math\.min\(8, Math\.round\(Number\(details\.step\)\)\)\)/.test(doctor),
  'a régi 8-as `details.step` vágás eltűnt');
check(/const maxSteps = Math\.max\(1, Math\.min\(16, Number\(entry\.operationMaxSteps\) \|\| 8\)\)/.test(modal),
  'a panel rangsorolása is a 16-os lépéskeretet használja');
check(/const isVariant = inner\.recoveryVariant === true/.test(edge)
  && /const cap = isVariant \? 16 : 8/.test(edge),
  'az Edge Function `pruneDeviceDoctorEvents` 16 variánst tart meg csatornánként');
check(/normal: \[\], variants: \[\]/.test(edge)
  && /const target = isVariant \? bucket\.variants : bucket\.normal/.test(edge),
  'a bootstrap külön 8-as / 16-os keretben adja vissza az eseményeket');
check(/2\.5\.405/.test(edge),
  'a deployed forrás is jelöli a #50 javítást (a v19 újratelepítése user-oldali)');
check(/inner\.recoveryVariant !== true && outer\.recoveryVariant === true/.test(edge),
  'a bootstrap a BEÁGYAZOTT és a felső `recoveryVariant` jelzőt is elfogadja');
check(/merged\.maxSteps = outer\.maxSteps/.test(edge),
  'a bootstrap a felső szintű `step` / `maxSteps` értékeket is egységesíti');

/* Valódi futásidő: 16 felhős repair_attempt → localStorage → friss import. */
const mem = new Map();
globalThis.localStorage = {
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
const doctorOut = path.join(outDir, 'tv-doctor-405.mjs');
await esbuild.build({
  stdin: {
    contents: `export {
      mergeCloudDoctorLogs, getTvDoctorChannelSnapshot, MAX_DOCTOR_LOG_STEPS,
      clearTvDoctorMemory, setTvDoctorHungarianChannelScope,
    } from './web/src/services/tvDoctor.ts';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: doctorOut,
  nodePaths: [path.join(ROOT, 'web/node_modules')], logLevel: 'silent',
});
const d = await import(pathToFileURL(doctorOut).href + '?v=' + Date.now());
d.clearTvDoctorMemory();
d.setTvDoctorHungarianChannelScope(true);
check(d.MAX_DOCTOR_LOG_STEPS === 16, 'a futásidejű modul 16-os lépéskeretet exportál');

const cloudEvents = Array.from({ length: 16 }, (_, i) => ({
  eventUid: `405-variant-${i + 1}`,
  category: 'assistance',
  level: 'repair',
  at: epoch + i * 1000,
  channelKey: 'hu:m2-uhd',
  channelId: 'm2-uhd',
  channelName: '[HU] M2 UHD',
  message: `Próba ${i + 1} / 16: TS + fast • recovery_buffer_profile`,
  eventType: 'repair_attempt',
  details: {
    step: i + 1,
    maxSteps: 16,
    strategyId: 'recovery_buffer_profile',
    recoveryVariant: true,
  },
}));
d.mergeCloudDoctorLogs(cloudEvents);
const channel = { id: 'm2-uhd', name: '[HU] M2 UHD', countryCode: 'HU' };
const snap = d.getTvDoctorChannelSnapshot(channel);
const assistance = snap.logsByCategory.assistance;
check(assistance.length > 0, `a 16 variáns megjelenik a panel pillanatképében (${assistance.length} / 8 doboz)`);
check(assistance.length <= 8, 'a 8 TANULÁSI DOBOZ változatlan: legfeljebb 8 sor látszik');
check(assistance.every((entry) => entry.operationMaxSteps === 16),
  'a megjelenő variánsok `maxSteps=16`-ot mutatnak, nem 8-at');
check(assistance.every((entry) => entry.operationStep >= 1 && entry.operationStep <= 16),
  'a lépésszám 1..16 között marad (nincs 8-ra vágás)');
/* A 8 doboz szándékosan csak 8 sort mutat; egyetlen 16. próbával külön
   bizonyítjuk, hogy a lépésszám NEM vágódik 8-ra. */
d.clearTvDoctorMemory();
d.mergeCloudDoctorLogs([{
  eventUid: '405-variant-16-only',
  category: 'assistance', level: 'repair', at: epoch + 20_000,
  channelKey: 'hu:m2-uhd', channelId: 'm2-uhd', channelName: '[HU] M2 UHD',
  message: 'Próba 16 / 16: HLS + adaptive-3 • recovery_buffer_profile',
  eventType: 'repair_attempt',
  details: { step: 16, maxSteps: 16, strategyId: 'recovery_buffer_profile', recoveryVariant: true },
}]);
const single = d.getTvDoctorChannelSnapshot(channel).logsByCategory.assistance;
check(single.length === 1 && single[0].operationStep === 16 && single[0].operationMaxSteps === 16,
  'a 16. variáns lépésszáma 16 / 16 marad (nem ragad 8 / 8-nál)');
/* Visszaállítjuk a 16 soros állapotot a localStorage-tesztzhez. */
d.clearTvDoctorMemory();
d.mergeCloudDoctorLogs(cloudEvents);

const stored = globalThis.localStorage.getItem('iptv_rt_tv_doctor_recent_v1') || '';
check(/"operationMaxSteps":16/.test(stored),
  'a localStorage-ba is 16-os lépéskeret íródik');
const d2 = await import(pathToFileURL(doctorOut).href + '?v=' + Date.now() + '-restore');
const snap2 = d2.getTvDoctorChannelSnapshot(channel);
check(snap2.logsByCategory.assistance.length > 0
  && snap2.logsByCategory.assistance.every((entry) => entry.operationMaxSteps === 16),
  'IPK-újraindítás után a `restoreRecentDoctorLogs()` is megőrzi a 16-ot');

console.log(`\n=== EREDMÉNY: ${passed} sikeres / ${failed} hibás ===`);
if (failed) {
  console.error('\nBukó feltételek (ezeket kell javítani):');
  for (const label of failures) console.error(`  - ${label}`);
  process.exit(1);
}
console.log('OK: gyors 2.5.406 indulás (nincs 2. takarókép) + #50 TV-helyi kártyaóra + 16 variáns Supabase-keret.');
