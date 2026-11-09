#!/usr/bin/env node
/**
 * 2.5.401 – A #43 (520 kB rendszernapló) és #44 (805 kB TV Doktor napló)
 * alapján: A TV DOKTOR A VALÓSÁGOT MUTASSA.
 *
 * A felhasználó végigjárta mind a 80 magyar csatornát, mégis:
 *   • a TV-fotón „Tanulás 3 db → 0 összevont útvonal; 8 doboz”, a 2–8
 *     dobozok üresek, „1 helyi / 2 felhő” mellett;
 *   • a Supabase-ben csak 67 tanult profil van (a 13 `HU - …` nevű adó
 *     stabil kulcsa eltért a `[HU] …` alaktól);
 *   • a #44 `ABLAK … 0/8; supabase=0; legjobb=még nincs`, miközben ugyanazon
 *     napló `INDÍTÁS` sorai már 1/8 tanult útvonalat használtak;
 *   • a #43 `KÉPKOCKA-KIHAGYÁS 1017 ms` + 2276 soros kézi napló mellett a
 *     napló minden eseménynél szinkron teljes JSON.stringify-t írt.
 *
 * Ez a teszt a TÉNYLEGES kliens modult futtatja (esbuild + hamis Storage),
 * nem csak szöveget keres. A feliratok/elnevezések NEM változhatnak.
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

/* ───────────────────────── HAMIS TV-TÁRHELY ───────────────────────── */
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

const out = path.join(outDir, 'tv-doctor-core-401.mjs');
await esbuild.build({
  stdin: {
    contents: `export {
      getTvDoctorChannelSnapshot, getTvDoctorSummary, recordDoctorChannelSuccess,
      clearTvDoctorMemory, setTvDoctorHungarianChannelScope,
      normalizeSavedLayoutChannelKey, normalizeChannelDoctorKey,
      isInSavedHungarianScope, isHungarianDoctorChannel,
      isPersistableDoctorRecord, flushRecentDoctorLogs,
      MAX_CHANNEL_ROUTES,
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
const modal = read('web/src/components/TvDoctorStatusModal.tsx');

/* ───────── 1. A 13 HIÁNYZÓ CSATORNA: `HU - …` ≠ `[HU] …` ───────── */
console.log('\n=== 1. A 80 mentett magyar csatorna KULCSA (67 → 80) ===\n');

check(d.normalizeSavedLayoutChannelKey('hu - travel channel|lc-827') === 'hu:travel-channel',
  'a `hu - travel channel` névből `hu:travel-channel` lesz (nem `hu-travel-channel`)');
check(d.normalizeSavedLayoutChannelKey('[hu] m2 uhd|lc-827') === 'hu:m2-uhd',
  'a `[hu] m2 uhd` névből változatlanul `hu:m2-uhd` lesz');
check(d.normalizeChannelDoctorKey({ id: 'x', name: 'HU - PAX TV' }) === 'hu:pax-tv',
  'a lejátszott `HU - PAX TV` is `hu:pax-tv` kulcsot kap');
check(/prefix = raw\.match\(\/\^\\s\*\(\[a-z\]\{2,3\}\)\\s\*\[\|:-\]\\s\*\(\.\+\)\$\/\)/.test(doctor),
  'a prefix-szabály ugyanaz, mint az Edge Function `layoutChannelKey()`-jában');

const MISSING_13 = [
  'hu - cartoonito', 'hu - discovery investigation', 'hu - filmbox stars hd',
  'hu - life tv', 'hu - love nature', 'hu - pannon', 'hu - pax tv',
  'hu - rtl 3', 'hu - rtl ketto hd', 'hu - story 4 hd', 'hu - travel channel',
  'hu - tv2 comedy', 'hu - tv2 sef',
];
const layout = MISSING_13.map((nameKey, i) => ({
  id: `live-qr_401-${i}`,
  nameKey: `${nameKey}|lc-827`,
  channelKey: d.normalizeSavedLayoutChannelKey(`${nameKey}|lc-827`),
  name: nameKey.toUpperCase(),
  position: i + 1,
}));
/* A #44 és az élő DB szerint a `[HU] M2 UHD` a 80 mentett adó között van. */
layout.push({
  id: 'live-qr_401-m2', nameKey: '[hu] m2 uhd|lc-827',
  channelKey: 'hu:m2-uhd', name: '[HU] M2 UHD', position: 14,
});
for (let i = layout.length; i < 80; i += 1) {
  const key = `hu:channel-${i}`;
  layout.push({ id: `live-qr_401-${i}`, nameKey: `[hu] channel ${i}|lc-827`, channelKey: key, name: `[HU] CHANNEL ${i}`, position: i + 1 });
}
d.setTvDoctorHungarianChannelScope(layout.map((c) => c.id), undefined, layout, storage);
check(layout.length === 80, 'a mentett elrendezés pontosan 80 magyar csatornát tartalmaz');
check(d.isInSavedHungarianScope('hu:travel-channel'), 'a `hu:travel-channel` a hatókörben van');
check(d.isInSavedHungarianScope('hu-travel-channel'),
  'a régi v18 `hu-travel-channel` alak is UGYANAZNAK a csatornának számít');
check(d.isInSavedHungarianScope('hu:pax-tv') && d.isInSavedHungarianScope('hu-pax-tv'),
  'a `HU - PAX TV` mindkét írásalakja felismerhető');
check(!d.isInSavedHungarianScope('hu:not-in-layout'),
  'a mentett 80-on KÍVÜLI csatorna továbbra sem kerül a hatókörbe');
check(d.isPersistableDoctorRecord({ channelKey: 'hu:travel-channel', channelName: '[HU] TRAVEL CHANNEL', countryCode: 'HU' }),
  'a 13 hiányzó csatorna rekordja tartósan tárolható (bekerül a felhő-payloadba)');

/* ───────── 2. 80 CSATORNA TANULÁSI ELŐZMÉNYE NEM TŰNHET EL ───────── */
console.log('\n=== 2. Csatornánkénti tanulási napló (a globális 8-as korlát helyett) ===\n');

d.clearTvDoctorMemory(storage);
for (let i = 0; i < 80; i += 1) {
  const c = layout[i];
  d.recordDoctorChannelSuccess({
    channel: { id: c.id, name: c.name, countryCode: 'HU' },
    format: i % 2 === 0 ? 'ts' : 'hls',
    bufferProfile: 'balanced',
    startupMs: 1200 + i * 5,
    storage,
  });
}
const recent = d.getTvDoctorSummary(storage).recentLogs;
const learningEntries = recent.filter((e) => e.category === 'learning');
const distinctLearningChannels = new Set(learningEntries.map((e) => e.channelKey));
check(distinctLearningChannels.size === 80,
  `mind a 80 csatorna tanulási bejegyzése megmarad (tényleges: ${distinctLearningChannels.size})`);
check(learningEntries.length >= 80, `legalább 80 tanulási sor van (tényleges: ${learningEntries.length})`);
check(/MAX_RECENT_LOGS_PER_CHANNEL/.test(doctor) && /MAX_RECENT_LOGS_TOTAL/.test(doctor),
  'a korlát CSATORNÁNKÉNTI + van külön biztonsági teljes puffer-korlát');
check(/for \(const list of groups\.values\(\)\)/.test(doctor),
  'a vágás csatornánként csoportosít, nem az egész kategóriát vágja 8-ra');
check(/pendingRecentLogsTimer/.test(doctor) && /setTimeout\(\(\) => \{[\s\S]{0,400}JSON\.stringify\(recentDoctorLogs\)/.test(doctor),
  'a napló tárolása debounce-olt (nincs 2276 soros szinkron írás minden eseménynél)');
check(/flushRecentDoctorLogs\(\);/.test(doctor) && /flushOnHide/.test(doctor),
  'a kézi napló kilépésnél / oldal elrejtésekor akkor is kiíródik, ha a debounce függőben van');
check(typeof d.flushRecentDoctorLogs === 'function', 'a flush kifele is elérhető a teszt/életciklus számára');
d.flushRecentDoctorLogs();
check(storage.getItem('iptv_rt_tv_doctor_recent_v1') !== null,
  'a kézi SÁRGA naplóhoz tartozó események a helyi tárhelyre is kerülnek');

/* ───────── 3. A FOTÓ: „Tanulás 3 db → 0 összevont útvonal” ───────── */
console.log('\n=== 3. A 0-ablak VALÓDI tanult útvonalakat mutat ===\n');

const m2 = layout.find((c) => c.channelKey === 'hu:m2-uhd')
  || { id: 'live-qr_m2', name: '[HU] M2 UHD', channelKey: 'hu:m2-uhd', countryCode: 'HU' };
/* Három külön megnyitás ugyanazon a csatornán, ahogy a #44 M2 UHD sorai. */
d.clearTvDoctorMemory(storage);
for (const [format, ms] of [['ts', 1429], ['hls', 1556], ['ts', 1310]]) {
  d.recordDoctorChannelSuccess({
    channel: { id: m2.id, name: m2.name, countryCode: 'HU' },
    format, bufferProfile: 'balanced', startupMs: ms, storage,
  });
}
/* A #44 `ABLAK`-sorai: `helyi=1; supabase=0`, ill. a fotó: `1 helyi / 2 felhő`. */
const cloudRows = [
  { id: 'hls:balanced', format: 'hls', bufferProfile: 'balanced', ok: 2, fail: 0, stalls: 0, avgStartupMs: 1180 },
  { id: 'ts:fast', format: 'ts', bufferProfile: 'fast', ok: 1, fail: 0, stalls: 0, avgStartupMs: 1300 },
];
const snap = d.getTvDoctorChannelSnapshot(
  { id: m2.id, name: m2.name, countryCode: 'HU' }, cloudRows, storage,
);
check(snap.logsByCategory.learning.length >= 3,
  `a bal felső „Tanulás 3 db” legalább 3 valódi tanulási bejegyzés (tényleges: ${snap.logsByCategory.learning.length})`);
check(snap.routes.length >= 3,
  `a „3 bejegyzés → 0 összevont útvonal” javítva: ${snap.routes.length} valódi sor`);
check(snap.routes.length >= Math.min(snap.logsByCategory.learning.length, d.MAX_CHANNEL_ROUTES - 1),
  'minden tanulási bejegyzéshez tartozik megjeleníthető 2–8 doboz (a 7-es korlátig)');
check(snap.bestRoute !== null, 'a legjobb tanult útvonal nem „még nincs”');
check(snap.localRouteCount >= 1, 'a HELYI tanult útvonalak száma nem 0');
check(snap.cloudRouteCount === 2, 'a FELHŐBŐL OLVASOTT 2 útvonal nem szűrődik ki');
check(snap.routes.some((r) => r.format === 'hls' && r.bufferProfile === 'balanced'),
  'a felhő HLS+balanced sora is látszik a panelben');
check(snap.routes.every((r) => Number.isFinite(r.avgStartupMs) || r.avgStartupMs === null),
  'a dobozok mérhető indulási időt (vagy nullt) tartalmaznak, nem `NaN`/`undefined`');
check(snap.routes.length <= d.MAX_CHANNEL_ROUTES - 1,
  'a tanult sorok a 7 szabad (2–8) dobozba férnek, PONTOSAN 8 doboz marad');

/* A tanulási napló: HOGYAN nyitotta meg, MIT tanult, mennyi idő alatt, mi volt az ok/hiba/forrás. */
const msg = snap.logsByCategory.learning.map((e) => e.message).join(' | ');
check(/megnyitás=/.test(msg), 'a tanulási napló leírja a MEGNYITÁS módját (formátum + puffer)');
check(/eredmény=\d+ ok\/\d+ hiba\/\d+ akadás/.test(msg),
  'a tanulási napló tartalmazza a siker/hiba/akadás arányt');
check(/forrás=(Supabase\+helyi|helyi)/.test(msg), 'a tanulási napló tartalmazza a tudás FORRÁSÁT');
check(/\(1[0-9]{3} ms\)/.test(msg), 'a tanulási napló tartalmazza a MÉRT indulási időt');
check(/TV DOKTOR INDÍTÁS/.test(doctor) && /forrás=/.test(doctor),
  'az INDÍTÁS napló továbbra is leírja a felhasznált tanult útvonalat és forrását');

/* Nincs többé kétszeres normalizálás / `ok > 0` szűrő a pillanatképben. */
const snapshotBody = doctor.slice(doctor.indexOf('export function getTvDoctorChannelSnapshot('), doctor.indexOf('export function isDoctorRecordHandled('));
check(!/rankDoctorRouteList\(normalizeDoctorRoutesForDisplay\(\[\.\.\.merged\.values\(\)\]\)\)/.test(snapshotBody),
  'a már kész DoctorRoute-okat NEM normalizáljuk újra (a #44 `0/8` egyik oka)');
check(!/(localRoutes|fromCloud)\s*=\s*[\s\S]{0,240}\.filter\(\(route\) => route\.ok > 0\)/.test(snapshotBody),
  'a 0 sikerű, de VALÓDI próbákat sem dobjuk el a pillanatképből');
check(/learnedRouteFromDoctorLog/.test(snapshotBody),
  'a tanulási naplósorokból képződnek a 2–8 dobozok valódi adatai');

/* ───────── 4. Supabase: a 13 `HU - …` nem szűrődik ki olvasáskor ───────── */
console.log('\n=== 4. Felhőből OLVASOTT rekord nem szűrődhet ki ===\n');
check(/const canon = \(key: string\)/.test(cloud) && /k\.startsWith\('hu-'\)/.test(cloud),
  'a `fetchTvDoctorRoutesForChannelFromCloud` kanonizálja a v18 `hu-…` kulcsot');
check(/keys\.has\(canon\(String\(row\.channel_key\)\)\)/.test(cloud),
  'a felhő sora `hu-travel-channel` alakban is megtalálható `hu:travel-channel`-hez');
check(/savedScopeCanonicalKeys/.test(doctor) && /canonicalDoctorKey/.test(doctor),
  'a kliens 80-as hatóköre is kanonikusan illeszt (13/80 nem vész el)');
check(/isCloudDoctorRecordAllowed/.test(doctor),
  'a felhőből OLVASOTT rekord elfogadása megmaradt');

/* ───────── 5. VÁLTOZATLAN FELIRATOK / 8 DOBOZ ───────── */
console.log('\n=== 5. A feliratok, a 8 doboz és a teljes kézi napló változatlan ===\n');
for (const label of [
  'TV Doktor napló (kategóriák)', 'Hiba a csatornánál', '1-es ALAP + tanult útvonalak (2–8)',
  'Helyi tanulás + Supabase', 'Tanulás:', 'Memória: 0',
]) {
  check(modal.includes(label), `a(z) „${label}” felirat megmaradt`);
}
check(/Array\.from\(\{ length: MAX_CHANNEL_ROUTES - 1 \}/.test(modal),
  'továbbra is PONTOSAN 8 doboz (1 zárolt alap + 7 tanult), nem 9');
check(/Még nincs tanult útvonal/.test(modal),
  'az üres doboz helyőrzője megmaradt (csak valódi adat mellett nem jelenik meg)');
check(/discardSentAppLog|clearAppLog/.test(read('web/src/services/appLog.ts')),
  'a kézi SÁRGA diagnosztikai napló teljes küldése változatlan');
check(/TV_DOCTOR_BASELINE_STORAGE_KEY/.test(doctor) && /clearTvDoctorBaselinesInCloud/.test(cloud),
  'a „Memória: 0” továbbra is törli az 1-es alapot HELYBEN is, felhőben is');

console.log(`\n${'='.repeat(76)}`);
console.log(`  TV DOKTOR #43/#44 REGRESSZIÓ: ${passed}/${passed + failed} ellenőrzés, ${failed} hiba`);
console.log('='.repeat(76));
if (failed) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
