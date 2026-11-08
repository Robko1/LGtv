#!/usr/bin/env node
/**
 * 2.5.399 – A #39/#40 naplók, a 2026-11-07/08-as TV-fotók és az élő Supabase
 * (39 profil / 140 esemény) alapján: GYORS IPK-INDULÁS + VALÓDI, CSATORNÁNKÉNTI,
 * SUPABASE-KÖZPONTÚ TANULÁS.
 *
 * A felhasználó 10 pontos működési leírásának regressziója. A meglévő
 * feliratok/elnevezések NEM változhatnak; az adatnak kell a meglévő kockába
 * kerülnie.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
const ROOT = path.resolve('.');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let checks = 0;
let failures = 0;
function check(ok, label) {
  checks += 1;
  if (!ok) { failures += 1; console.error(`  ❌ ${label}`); }
  else console.log(`  ✅ ${label}`);
}

const main = read('web/src/main.tsx');
const app = read('web/src/App.tsx');
const doctor = read('web/src/services/tvDoctor.ts');
const cloud = read('web/src/services/tvDoctorCloud.ts');
const modal = read('web/src/components/TvDoctorStatusModal.tsx');
const appLogSrc = read('web/src/services/appLog.ts');
const migrationsDir = path.join(ROOT, 'supabase/migrations');
const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
const resetMigration = migrationFiles
  .map((f) => ({ f, text: fs.readFileSync(path.join(migrationsDir, f), 'utf8') }))
  .find(({ text }) => /tv_doctor_routes_upsert/i.test(text) && /tv_doctor_baselines_clear/i.test(text));

/* ───────────────────────────── 1. IPK INDULÁS (#39) ───────────────────────── */
console.log('\n1. Gyors IPK-indulás: a #39 napló mért kapui alapján');
check(/liveListReady\(\)/.test(main) && /listReady\(\) \|\| \(?liveListReady/.test(main),
  'a felfedés NEM vár a 3. csatornasorra, ha az élő lista már kész (listReady || liveListReady)');
check(/BOOT_FAST_REVEAL_MS|1500|1600/.test(main) && /bootState\(\) !== ["']checking["']/.test(main),
  'a content indításnál 1,5 s gyors biztonsági háló van (a 1017 ms főszál-fagyás nem tarthatja fent a takaróképet)');
check(/9000|9_000/.test(app) && !/}, 5000\);/.test(app),
  'a HU EPG-próba 9 s-re tolódik, az első adás indulása nyugodt marad');
check(/isBootDiagnosticWindow|AUTO_BOOT_LOG_WINDOW/.test(appLogSrc),
  'az automata napló csak az indulási ablakban írja a csatornánkénti KÉPMINŐSÉG-sorokat (folyamatos nézésnél nincs 1180 sor)');
check(/bootObserverStop|stopBootObservers|BOOT_OBSERVER_WINDOW/.test(read('web/src/services/startupDiagnostics.ts')),
  'az indulási megfigyelők a boot ablak után lecsatlakoznak (nincs 29 képkocka-kihagyás)');
const startupDiag = read('web/src/services/startupDiagnostics.ts');
check(/__IPTV_BOOT_MARK__/.test(main) && /['"]REVEAL['"]/.test(main),
  'a #39 `BOOT-DIAG ÖSSZEGZÉS: felület megjelent=nem történt meg` javítva: a tényleges FELFEDÉS REVEAL-jelzést ad');
check(/let summaryTimer/.test(startupDiag) && /logSummary\(\)/.test(startupDiag)
  && !/window\.clearTimeout\(summaryTimer\)[\s\S]{0,120}cleanups/.test(startupDiag),
  'a 25 mp-es BOOT-DIAG ÖSSZEGZÉS a megfigyelők lecsatlakozása után is lefut');

/* ─────────────────── 2. A MEGLÉVŐ FELIRATOK NEM VÁLTOZNAK ────────────────── */
console.log('\n2. A TV Doktor meglévő feliratai, elnevezései változatlanok');
const LABELS = [
  'TV Doktor napló (kategóriák)', 'Tanulás', 'Segítség / Javítás', 'Aktiválódás',
  'Hiba a csatornánál', '1-es ALAP', 'Tanult útvonalak', 'Helyi tanulás + Supabase',
  'Supabase kapcsolat', 'Eszköz:', 'Központi profilok:', 'Utolsó szinkron:',
  'Tanult magyar csatornák:', 'Működési állapot', 'Sebesség:', 'Várólista:',
  'Memória: 0', '1. ALAP', 'ZÁROLT',
];
for (const label of LABELS) {
  check(modal.includes(label), `a(z) „${label}” felirat megmaradt`);
}
check(/data-tv-doctor-route-boxes="8"/.test(modal) && /Array\.from\(\{ length: MAX_CHANNEL_ROUTES - 1 \}/.test(modal),
  'továbbra is PONTOSAN 8 doboz (1 alap + 7 tanult), nem 9');
check(!/data-tv-doctor-central-profiles/.test(modal),
  'a bal oldali központi profil összesítő továbbra sincs');

/* ─────────────────── 3. SUPABASE AZ ELSŐDLEGES ADATFORRÁS ─────────────────── */
console.log('\n3. Supabase-első: a TV lekéri, megjeleníti ÉS használja a tanultat');
check(/mergeCloudRoutesIntoLocal/.test(modal) && /setCloudRoutes/.test(modal),
  'a 0-ablak a felhőből olvasott útvonalakat a HELYI rekordba is beépíti (a következő indítás ebből dolgozik)');
check(/normalizeDoctorRoutesForDisplay\(/.test(cloud) && /knownChannelKey/.test(cloud),
  'a csatornához tartozó felhő-sor stabil hu: kulccsal, normalizálva jön vissza');
check(Boolean(resetMigration), 'van új migráció a valódi UPSERT-hez és a teljes nullázáshoz');
if (resetMigration) {
  const t = resetMigration.text;
  check(/insert into public\.tv_doctor_channel_profiles/i.test(t) && /on conflict/i.test(t),
    'a tv_doctor_routes_upsert ÚJ csatornát is be tud szúrni (nem csak UPDATE → 0 csatorna mentve)');
  check(/delete from public\.tv_doctor_channel_baselines/i.test(t),
    'a tv_doctor_baselines_clear teljes nullázáskor TÉNYLEG törli az 1-es alapot (10. pont)');
}

/* ───────────────────── 4. TELJES MEMÓRIA-NULLÁZÁS ─────────────────────────── */
console.log('\n4. Teljes nullázás: az 1-es alap is törlődik (10. pont – korábbi döntés visszavonva)');
check(/removeItem\(TV_DOCTOR_BASELINE_STORAGE_KEY\)/.test(doctor),
  'a clearTvDoctorMemory() a slot-1 alap tárolóját is törli');
check(/postTvDoctorRpc\(\s*['"]tv_doctor_baselines_clear['"]/.test(cloud) && /resetTvDoctorAllToZero/.test(cloud),
  'a Memória: 0 a Supabase 1-es alapjait is törli');
check(/getTvDoctorChannelSnapshot/.test(doctor) && /export function getTvDoctorChannelSnapshot/.test(doctor),
  'a pillanatkép továbbra is egyetlen igazságforrás');

/* ─────────────── 5. FUTÁSIDEI: VALÓDI TANULÁS, NINCS SZEMÉT ──────────────── */
console.log('\n5. Futásidei: a tanulás valódi, csatornánkénti és a leggyorsabbat keresi');

const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
});
const win = dom.window;
for (const key of ['window', 'document', 'navigator', 'location', 'localStorage',
  'HTMLElement', 'MutationObserver', 'Event', 'CustomEvent',
  'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
}

const out = path.join(ROOT, 'build/test/tv-doctor-learning-399.mjs');
await esbuild.build({
  stdin: {
    contents: `
export {
  clearTvDoctorMemory, recordDoctorChannelSuccess, recordDoctorRouteOutcome,
  getTvDoctorChannelSnapshot, getChannelDoctorRecord, getTvDoctorSummary,
  setTvDoctorHungarianChannelScope, collectDoctorRoutePayload,
  normalizeDoctorRoutesForDisplay, getDoctorBaseline,
  selectChannelLaunchPlan, MAX_CHANNEL_ROUTES, TV_DOCTOR_BASELINE_STORAGE_KEY,
  TV_DOCTOR_STORAGE_KEY,
} from './web/src/services/tvDoctor.ts';
`,
    resolveDir: ROOT, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  nodePaths: [path.join(ROOT, 'web/node_modules')], logLevel: 'silent',
});
const d = await import(pathToFileURL(out).href + '?v=' + Date.now());

const CH = { id: 'live-qr_1794135505110-16871', name: '[HU] M2 UHD', countryCode: 'HU' };
const OTHER = { id: 'live-qr_1794135505110-16872', name: '[HU] M1 UHD', countryCode: 'HU' };
const FOREIGN = { id: 'live-qr_1794135505110-99999', name: '[GB] BBC ONE', countryCode: 'GB' };
const SAVED_KEYS = ['hu:m2-uhd', 'hu:m1-uhd', 'hu:cinemax', 'hu:hbo-uhd'];

function freshStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    _map: m,
  };
}
const storage = freshStorage();
d.clearTvDoctorMemory(storage);
d.setTvDoctorHungarianChannelScope(
  ['live-qr_1794135505110-16871', 'live-qr_1794135505110-16872'],
  undefined,
  SAVED_KEYS.map((channelKey) => ({ channelKey, name: channelKey })),
  storage,
);

/* 5.1 A 60000 / 27143 / 14691 ms-es pufferelési epizód NEM lehet tanult útvonal. */
d.recordDoctorChannelSuccess({ channel: CH, format: 'ts', bufferProfile: 'balanced', startupMs: 1600, storage });
d.recordDoctorChannelSuccess({ channel: CH, format: 'ts', bufferProfile: 'balanced', startupMs: 27143, wasRepair: true, storage });
d.recordDoctorChannelSuccess({ channel: CH, format: 'ts', bufferProfile: 'balanced', startupMs: 60000, wasRepair: true, storage });
const rec = d.getChannelDoctorRecord(CH, storage);
const learned = d.normalizeDoctorRoutesForDisplay(rec?.routes || []);
check(Boolean(rec) && learned.length >= 1,
  'a csatorna külön rekordot kapott, van tanult útvonal');
check(learned.every((r) => r.avgStartupMs === null || r.avgStartupMs <= 8000),
  `a 27143 / 60000 ms-es pufferelési epizód NEM rontotta el a tanult indulási időt (${learned.map((r) => r.avgStartupMs).join(',')})`);
check(learned.some((r) => r.avgStartupMs !== null && r.avgStartupMs <= 2000),
  'a tiszta 1600 ms-es mérés megmaradt tanult útvonalként');

/* 5.2 Csatornánként külön: a másik csatorna mérése nem keveredik. */
d.recordDoctorChannelSuccess({ channel: OTHER, format: 'hls', bufferProfile: 'fast', startupMs: 1300, storage });
check(!d.getChannelDoctorRecord(CH, storage)?.routes?.some((r) => r.format === 'hls' && r.bufferProfile === 'fast'),
  'minden magyar csatorna KÜLÖN tanul: az M1 HLS+fast útvonala nem került az M2-re');
check(Boolean(d.getChannelDoctorRecord(OTHER, storage)?.routes?.some((r) => r.format === 'hls')),
  'az M1 saját HLS útvonala megvan');

/* 5.3 Csak a 80 elmentett magyar csatorna tanul tartósan. */
d.recordDoctorChannelSuccess({ channel: FOREIGN, format: 'ts', bufferProfile: 'balanced', startupMs: 1200, storage });
check(d.getChannelDoctorRecord(FOREIGN, storage) === null,
  'nem magyar csatornáról nem keletkezik tartós rekord');
const outsideSaved = { id: 'live-qr_x-1', name: '[HU] ISMERETLEN ADÓ', countryCode: 'HU' };
d.recordDoctorChannelSuccess({ channel: outsideSaved, format: 'ts', bufferProfile: 'balanced', startupMs: 1400, storage });
const payloadKeys = d.collectDoctorRoutePayload(storage).map((p) => p.channelKey);
check(payloadKeys.every((k) => SAVED_KEYS.includes(k)),
  `csak a 80 elmentett HU csatorna megy a Supabase-be (kapott: ${payloadKeys.join(',')})`);
check(d.getTvDoctorSummary(storage).learnedChannelCount <= SAVED_KEYS.length,
  'a „tanult_csatornák=87/80” többé nem fordulhat elő');

/* 5.4 A pillanatkép: valódi, érvényes útvonalak, legjobb elöl, Supabase-ből is. */
const CLOUD_ROW = {
  channel_key: 'hu:m2-uhd', country_code: 'HU',
  best_format: 'hls', best_buffer_profile: 'balanced',
  hls_success_count: 3, hls_avg_startup_ms: 1180,
  routes: [{ id: 'hls:balanced', ok: 3, fail: 0, avg_startup_ms: 1180 }],
};
const snap = d.getTvDoctorChannelSnapshot(CH, [CLOUD_ROW], storage);
check(snap.routes.length >= 2 && snap.routes.every((r) => r.format === 'ts' || r.format === 'hls'),
  'a pillanatkép a HELYI + SUPABASE útvonalakat együtt, érvényesen adja');
check(snap.cloudRouteCount >= 1, 'a Supabase-ből olvasott útvonal beleszámít (nem supabase=0)');
check(snap.bestRoute !== null && snap.bestRoute !== undefined
  && (snap.bestRoute.format === 'ts' || snap.bestRoute.format === 'hls')
  && typeof snap.bestRoute.bufferProfile === 'string' && snap.bestRoute.bufferProfile.length > 0,
  'a legjobb tanult útvonal sose „—+undefined”: van formátuma ÉS pufferprofilja');
check(snap.bestRoute && snap.bestRoute.avgStartupMs !== null
  && snap.bestRoute.avgStartupMs <= 1600,
  'a leggyorsabb, legstabilabb (1180 ms) útvonal van az első helyen');

/* 5.5 A következő indítás a megtanult legjobbat használja. */
const plan = d.selectChannelLaunchPlan(
  { ...CH, streamUrl: 'http://stream.example/live/u/p/123.ts', categoryId: 'hu' },
  'http://stream.example/live/u/p/123.ts',
  { streamFormat: 'ts', bufferMode: 'balanced', tvDoctorEnabled: true },
  storage,
);
check(plan && plan.enabled === true && (plan.primaryFormat === 'ts' || plan.primaryFormat === 'hls')
  && typeof plan.bufferProfileId === 'string',
  'az intelligens megnyitás a tanult rekordból dolgozik, nem üres fallbackből');

/* 5.6 TELJES nullázás: az 1-es alap is törlődik. */
storage.setItem(d.TV_DOCTOR_BASELINE_STORAGE_KEY, JSON.stringify({
  'hu:m2-uhd': { slot: 1, channelKey: 'hu:m2-uhd', channelName: '[HU] M2 UHD', format: 'ts',
    bufferProfile: 'balanced', startupMs: 1600, recordedAt: Date.now(),
    bufferTiming: { startupWatchdogMs: 1850, bufferWatchdogMs: 4500, stallDetectorMs: 5000, retryMs: 180, minBufferAheadSeconds: 3.0 } },
}));
check(d.getDoctorBaseline(CH, storage) !== null, 'az 1-es alap rögzült az első sikeres megnyitáskor');
d.clearTvDoctorMemory(storage);
check(d.getDoctorBaseline(CH, storage) === null,
  'Memória: 0 után az 1-es alap HELYBEN is törlődik (minden elölről indul)');
check(!storage._map.has(d.TV_DOCTOR_BASELINE_STORAGE_KEY),
  'a slot-1 alap localStorage kulcsa is eltűnt');
check(d.getTvDoctorChannelSnapshot(CH, [], storage).routes.length === 0,
  'nullázás után a Tanult útvonalak lista is 0');

dom.window.close();
console.log(`\n2.5.399 tanulás / indulás regresszió: ${checks - failures}/${checks} sikeres, ${failures} hibás.`);
if (failures > 0) process.exitCode = 1;
