#!/usr/bin/env node
/**
 * TV DOKTOR – TANULÓ ÚTVONALAK (2.5.294)
 *
 * Azt ellenőrzi, hogy a TV Doktor
 *  1. csatornánként LEGFELJEBB 8 útvonalat (formátum + pufferprofil) tanul,
 *  2. minden adásból tanul (siker, hiba, megakadás) és átrendezi a listát,
 *  3. a legjobb útvonalat indítja, javításkor a bevált alternatívát próbálja,
 *  4. CSAK a magyar csatornákról tárol (és küld a felhőbe) adatot,
 *  5. a régi, minden országra kiterjedő mentést automatikusan kitisztítja,
 *  6. a filmekről/sorozatokról (VOD) SEMMIT nem tárol,
 *  7. a 0-gombos ablak naplózása nem szemeteli tele az élő eseménylistát.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('.');
const esbuild = createRequire(path.resolve('web/package.json'))('esbuild');

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ HIBA: ${label}`);
  }
}

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  get length() {
    return this.map.size;
  }
  key(index) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(String(key), String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

const storage = new MemoryStorage();
globalThis.localStorage = storage;
globalThis.window = {
  localStorage: storage,
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  location: { protocol: 'http:', hostname: 'localhost' },
};
globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} };

const outDir = path.resolve('build/test');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'tv-doctor-routes.mjs');
await esbuild.build({
  stdin: {
    contents: `export * from './web/src/services/tvDoctor.ts';
      export { INITIAL_SETTINGS } from './web/src/data/mockData.ts';`,
    resolveDir: ROOT,
    sourcefile: 'tv-doctor-routes-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2020',
  outfile: outFile,
  logLevel: 'silent',
});
const core = await import(pathToFileURL(outFile).href);

const huChannel = {
  id: 'ch-hu-1',
  name: '[HU] M4 Sport HD',
  countryCode: 'HU',
  streamUrl: 'http://panel.example:8080/live/u/p/101.ts',
};
const gbChannel = {
  id: 'ch-gb-1',
  name: '[UK] BBC One HD',
  countryCode: 'GB',
  streamUrl: 'http://panel.example:8080/live/u/p/202.ts',
};

/* ─────────────────────────────────────────────────────────────────────────
 * 1. Csatornánként max. 8 tanult útvonal
 * ───────────────────────────────────────────────────────────────────────── */
console.log('\n1. Tanuló útvonal-tábla (csatornánként max. 8)');
const store = new MemoryStorage();
const comboCount = 4; // 2 formátum × 4 puffer
const profiles = ['fast', 'balanced', 'stable', 'adaptive-1'];
for (let i = 0; i < comboCount; i += 1) {
  for (const format of ['ts', 'hls']) {
    for (let round = 0; round < 2; round += 1) {
      core.recordDoctorChannelSuccess({
        channel: huChannel,
        format,
        bufferProfile: profiles[i],
        startupMs: 600 + i * 500 + (format === 'hls' ? 200 : 0),
        storage: store,
      });
    }
  }
}
let record = core.getChannelDoctorRecord(huChannel, store);
check(Boolean(record && Array.isArray(record.routes)), 'a csatorna rekordja tartalmaz útvonal-táblát');
check(record.routes.length === core.MAX_CHANNEL_ROUTES, `a tábla a 8-as korlátot betartja (${record.routes.length} <= 8)`);
check(
  record.routes.every((route) => route.ok > 0),
  'a megmaradt útvonalak mindegyike igazoltan működött legalább egyszer',
);
check(
  core.doctorRouteScore(record.routes[0]) >= core.doctorRouteScore(record.routes[record.routes.length - 1]),
  'az útvonalak pontszám szerint csökkenő sorrendben vannak',
);

/* Új, jobb útvonal kiszorítja a legrosszabbat */
const beforeIds = record.routes.map((route) => route.id);
const worstBefore = record.routes[record.routes.length - 1].id;
for (let round = 0; round < 4; round += 1) {
  core.recordDoctorChannelSuccess({
    channel: huChannel,
    format: 'ts',
    bufferProfile: 'instant',
    startupMs: 210,
    storage: store,
  });
}
record = core.getChannelDoctorRecord(huChannel, store);
const afterIds = record.routes.map((route) => route.id);
check(record.routes.length === core.MAX_CHANNEL_ROUTES, 'a 8-as korlát a legjobb indulás után is megmarad');
check(afterIds.includes('ts:instant'), 'a villámgyors új útvonal (TS + instant) bekerült a táblába');
check(!afterIds.includes(worstBefore) && beforeIds.includes(worstBefore), 'a leggyengébb útvonal kiesett, a többi megmaradt');
check(record.routes[0].id === 'ts:instant', 'a legjobb mért útvonal került az élre');

/* Hibák és akadások is tanulást jelentenek */
const beforeFail = record.routes.find((route) => route.id === 'hls:stable');
core.recordDoctorChannelFailure({
  channel: huChannel,
  format: 'hls',
  bufferProfile: 'stable',
  trigger: 'media_error',
  errorCode: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
  storage: store,
});
core.recordDoctorChannelFailure({
  channel: huChannel,
  format: 'hls',
  bufferProfile: 'stable',
  trigger: 'playback_stall',
  storage: store,
});
record = core.getChannelDoctorRecord(huChannel, store);
const afterFail = record.routes.find((route) => route.id === 'hls:stable');
check(
  Boolean(beforeFail && afterFail && afterFail.fail === beforeFail.fail + 1 && afterFail.stalls === beforeFail.stalls + 1),
  'a hiba és a megakadás is bekerül az útvonal tanulásába',
);
check(
  core.learnedRouteFor(record)?.id === 'ts:instant',
  'a legjobb útvonal kiválasztása a hibák után is a legjobbat adja',
);

/* ─────────────────────────────────────────────────────────────────────────
 * 2. A tanult útvonal tényleg gyorsítja az indítást és a javítást
 * ───────────────────────────────────────────────────────────────────────── */
console.log('\n2. Tanult útvonal használata indításkor és javításkor');
const planStore = new MemoryStorage();
for (let i = 0; i < 3; i += 1) {
  core.recordDoctorChannelSuccess({
    channel: huChannel,
    format: 'hls',
    bufferProfile: 'turbo',
    startupMs: 380,
    storage: planStore,
  });
}
const plan = core.selectChannelLaunchPlan(huChannel, huChannel.streamUrl, core.INITIAL_SETTINGS, planStore);
check(plan.primaryFormat === 'hls', 'indításkor a csatorna legjobban bevált formátuma (HLS) indul');
check(
  plan.bufferProfileId === 'turbo' || plan.bufferProfileId === 'instant',
  'indításkor a bevált pufferprofil (vagy annak gyorsabb, még ki nem próbált lépcsője) indul – lassabbra nem esik vissza',
);
check(plan.expectedStartupMs !== null && plan.expectedStartupMs <= 600, 'a várt indulási idő a saját mért értékből jön');

const repairStore = new MemoryStorage();
for (let i = 0; i < 3; i += 1) {
  core.recordDoctorChannelSuccess({
    channel: huChannel,
    format: 'ts',
    bufferProfile: 'stable',
    startupMs: 900,
    storage: repairStore,
  });
}
const repair = core.planDoctorRepairStep({
  channel: huChannel,
  trigger: 'startup_timeout',
  step: 2,
  currentFormat: 'hls',
  currentBufferProfile: 'fast',
  streamUrl: 'http://panel.example:8080/live/u/p/101.hls',
  tsUrl: 'http://panel.example:8080/live/u/p/101.ts',
  hlsUrl: 'http://panel.example:8080/live/u/p/101.hls',
  storage: repairStore,
});
check(
  repair.strategyId === 'learned_route_probe' && repair.nextFormat === 'ts' && repair.nextBufferProfile === 'stable',
  'javításkor előbb a csatornánál már bevált útvonalat próbálja (nem vakon váltogat)',
);

/* ─────────────────────────────────────────────────────────────────────────
 * 3. Csak a magyar csatornákról tárolunk
 * ───────────────────────────────────────────────────────────────────────── */
console.log('\n3. Csak magyar csatorna tanulása kerül a tárolóba');
const huStore = new MemoryStorage();
core.recordDoctorChannelSuccess({ channel: huChannel, format: 'ts', bufferProfile: 'fast', startupMs: 700, storage: huStore });
core.recordDoctorChannelSuccess({ channel: gbChannel, format: 'hls', bufferProfile: 'fast', startupMs: 700, storage: huStore });
core.flushTvDoctorStore(huStore);
const savedRaw = huStore.getItem(core.TV_DOCTOR_STORAGE_KEY) || '';
const saved = JSON.parse(savedRaw || '{}');
const savedKeys = Object.keys(saved.byKey || {});
check(savedKeys.length === 1, `a tárolóban csak egy (magyar) csatorna van (${savedKeys.length})`);
check(
  Object.values(saved.byKey || {}).every((rec) => String(rec.countryCode).toUpperCase() === 'HU'),
  'a tárolt rekordok mind magyar csatornák',
);
check(!savedRaw.includes('BBC'), 'a nem magyar csatorna neve sem került a tárolóba');
check(
  core.isHungarianDoctorChannel(huChannel) && !core.isHungarianDoctorChannel(gbChannel),
  'a magyar/nem magyar eldöntése országkód alapján működik',
);
check(
  core.isHungarianDoctorChannel({ name: 'Magyar ATV', categoryName: 'Magyarország' }) === true
  && core.isHungarianDoctorChannel({ name: 'BBC One' }) === false,
  'országkód nélkül a kategória/nevünk dönt a magyarságról',
);

/* A nem magyar csatorna a munkamenetben továbbra is kap segítséget */
const gbPlan = core.selectChannelLaunchPlan(gbChannel, gbChannel.streamUrl, core.INITIAL_SETTINGS, huStore);
check(gbPlan.enabled === true, 'a nem magyar csatornát is segíti a TV Doktor (gyors indulás, formátumváltás)');

/* Régi, idegen országú mentés automatikus kitisztítása */
const legacyStore = new MemoryStorage();
legacyStore.setItem(core.TV_DOCTOR_STORAGE_KEY, JSON.stringify({
  v: 1,
  byKey: {
    'hu:m4-sport-hd': {
      channelKey: 'hu:m4-sport-hd', channelName: '[HU] M4 Sport HD', countryCode: 'HU',
      bestFormat: 'ts', bestBufferProfile: 'fast', bestBufferAheadSeconds: 1.5,
      tsAvgStartupMs: 700, hlsAvgStartupMs: null, bestStartupMs: 700, tsOk: 3, tsFail: 0,
      hlsOk: 0, hlsFail: 0, stalls: 0, repairsOk: 0, bufferStats: {}, updatedAt: Date.now(),
    },
    'gb:bbc-one-hd': {
      channelKey: 'gb:bbc-one-hd', channelName: '[UK] BBC One HD', countryCode: 'GB',
      bestFormat: 'hls', bestBufferProfile: 'fast', bestBufferAheadSeconds: 1.5,
      tsAvgStartupMs: null, hlsAvgStartupMs: 800, bestStartupMs: 800, tsOk: 0, tsFail: 0,
      hlsOk: 4, hlsFail: 0, stalls: 0, repairsOk: 0, bufferStats: {}, updatedAt: Date.now(),
    },
  },
  idIndex: {}, epgByKey: {}, epgIdIndex: {},
  categoryStats: {}, epgAssistCount: 0, epgLastAssistAt: null, epgLastRecoveredAt: null,
}));
const legacyRecord = core.getChannelDoctorRecord({ id: 'x', name: '[UK] BBC One HD', countryCode: 'GB' }, legacyStore);
check(legacyRecord === null, 'a régi, nem magyar rekord nem töltődik be többé');
const cleanedRaw = legacyStore.getItem(core.TV_DOCTOR_STORAGE_KEY) || '';
check(!cleanedRaw.includes('BBC'), 'a régi mentés automatikusan (újraíráskor) kitisztult');

/* ─────────────────────────────────────────────────────────────────────────
 * 4. VOD: semmit nem tárolunk
 * ───────────────────────────────────────────────────────────────────────── */
console.log('\n4. Film és sorozat: segítség, de semmilyen adat');
const vodStore = new MemoryStorage();
const vodResult = core.recordDoctorVodSuccess({
  target: { kind: 'movie', id: 'm1', title: 'Film', streamUrl: 'http://panel.example/movie/u/p/55.mkv' },
  bufferProfile: 'balanced',
  startupMs: 800,
  storage: vodStore,
});
core.recordDoctorVodFailure({
  target: { kind: 'movie', id: 'm1', title: 'Film', streamUrl: 'http://panel.example/movie/u/p/55.mkv' },
  bufferProfile: 'balanced',
  trigger: 'playback_stall',
  storage: vodStore,
});
core.flushTvDoctorStore(vodStore);
check(vodResult === null, 'a film sikeres indulása nem hoz létre tanult rekordot');
const vodSavedRaw = vodStore.getItem(core.TV_DOCTOR_STORAGE_KEY) || '{}';
const vodSaved = JSON.parse(vodSavedRaw);
check(
  Object.keys(vodSaved.byKey || {}).length === 0 && !vodSavedRaw.includes('Film') && !vodSavedRaw.includes('55'),
  'film/sorozat után semmilyen adat (cím, azonosító, mérés) nem kerül a tárolóba',
);
check(core.getVodDoctorRecord({ kind: 'movie', id: 'm1', title: 'Film' }, vodStore) === null, 'nincs VOD-emlék visszaolvasva');
const vodPlan = core.selectVodLaunchPlan(
  { kind: 'movie', id: 'm1', title: 'Film', streamUrl: 'http://panel.example/movie/u/p/55.mkv' },
  core.INITIAL_SETTINGS,
  vodStore,
);
check(vodPlan.enabled === true, 'a film lejátszását a TV Doktor továbbra is segíti (folyékony lejátszás)');

/* ─────────────────────────────────────────────────────────────────────────
 * 5. Felhő (Supabase): tömör, 8-as korlátos csomag + magyar szűrés
 * ───────────────────────────────────────────────────────────────────────── */
console.log('\n5. Felhő-memória: tömör útvonal-csomag és magyar szűrés');
const cloudStore = new MemoryStorage();
for (let i = 0; i < 4; i += 1) {
  core.recordDoctorChannelSuccess({ channel: huChannel, format: 'ts', bufferProfile: 'fast', startupMs: 640, storage: cloudStore });
}
const huRecord = core.getChannelDoctorRecord(huChannel, cloudStore);
const compact = core.compactDoctorRoutes(huRecord.routes);
check(Array.isArray(compact) && compact.length <= core.MAX_CHANNEL_ROUTES, 'a felhőbe küldött útvonal-lista legfeljebb 8 soros');
check(
  compact.every((route) => typeof route.format === 'string' && typeof route.bufferProfile === 'string' && typeof route.ok === 'number'),
  'a felhő-csomag csak a szükséges mezőket tartalmazza (formátum, puffer, számlálók)',
);
check(
  !JSON.stringify(compact).includes('http') && !JSON.stringify(compact).includes('u/p'),
  'a felhő-csomagban nincs stream URL és nincs jelszó',
);

const mergeStore = new MemoryStorage();
const merged = core.mergeCloudProfilesIntoLocal([
  {
    channelKey: 'hu:m4-sport-hd', channelName: '[HU] M4 Sport HD', countryCode: 'HU',
    bestFormat: 'ts', bestBufferProfile: 'fast', bestBufferAheadSeconds: 1.5,
    tsSuccessCount: 5, tsFailureCount: 0, hlsSuccessCount: 0, hlsFailureCount: 0,
    stallCount: 0, repairSuccessCount: 0, bufferScores: {},
    routes: [{ format: 'ts', bufferProfile: 'turbo', ok: 6, fail: 0, stalls: 0, avgStartupMs: 520, bestStartupMs: 480, lastOkAt: Date.now() }],
    confidenceScore: 70,
  },
  {
    channelKey: 'gb:bbc-one-hd', channelName: '[UK] BBC One HD', countryCode: 'GB',
    bestFormat: 'hls', bestBufferProfile: 'fast', bestBufferAheadSeconds: 1.5,
    tsSuccessCount: 0, hlsSuccessCount: 9, confidenceScore: 80,
  },
], mergeStore);
const mergedHu = core.getChannelDoctorRecord(huChannel, mergeStore);
const mergedGb = core.getChannelDoctorRecord(gbChannel, mergeStore);
check(merged >= 1 && Boolean(mergedHu), 'a magyar csatorna felhő-profilja bekerül a helyi memóriába');
check(Boolean(mergedHu?.routes?.find((route) => route.id === 'ts:turbo')), 'a felhőből érkező tanult útvonal is átvételre kerül');
check(mergedGb === null, 'a nem magyar (GB) felhő-profilt eldobjuk – nem kerül a helyi memóriába');

/* ─────────────────────────────────────────────────────────────────────────
 * 5b. Supabase RPC-memória: feltöltött csomag és visszaolvasott útvonalak
 * ───────────────────────────────────────────────────────────────────────── */
console.log('\n5b. Supabase RPC-memória: csomag-építés és visszatöltés');
const rpcStore = new MemoryStorage();
core.recordDoctorChannelSuccess({ channel: huChannel, format: 'ts', bufferProfile: 'instant', startupMs: 580, storage: rpcStore });
core.recordDoctorChannelSuccess({ channel: { id: '9821', name: '[HU] Film+ HD', url: 'http://example.test/live/u/p/9821.ts', streamType: 'ts' }, format: 'ts', bufferProfile: 'turbo', startupMs: 640, storage: rpcStore });
const payload = core.collectDoctorRoutePayload(rpcStore);
check(payload.length >= 1, 'a felhő-csomag a helyi tanult memóriából épül (nem a küldési sorból)');
check(payload.every((item) => item.countryCode === 'HU'), 'a csomagban csak HU jelölésű csatorna szerepel');
check(payload.every((item) => !item.channelKey.startsWith('vod:')), 'a csomagban nincs Mozi/Sorozat bejegyzés');
check(payload.every((item) => item.routes.length >= 1 && item.routes.length <= core.MAX_CHANNEL_ROUTES), 'csatornánként legfeljebb 8 útvonal megy fel');
const payloadJson = JSON.stringify(payload);
check(!payloadJson.includes('http') && !payloadJson.includes('/u/p/'), 'a felhő-csomagban nincs stream URL és nincs jelszó');

// Visszatöltés: a felhő jobb mérése nyer, a rosszabb nem írja felül a helyit.
const beforeRoute = core.getChannelDoctorRecord(huChannel, rpcStore).routes.find((route) => route.id === 'ts:instant');
const backMerged = core.mergeCloudRoutesIntoLocal([
  { channel_key: 'hu:film-plus-hd', country_code: 'HU', routes: [{ format: 'ts', bufferProfile: 'turbo', ok: 25, fail: 1, stalls: 0, avgStartupMs: 700, bestStartupMs: 690 }] },
  { channel_key: 'gb:bbc-two-hd', country_code: 'GB', routes: [{ format: 'hls', bufferProfile: 'fast', ok: 9 }] },
  { channel_key: 'vod:film-1', country_code: 'HU', routes: [{ format: 'ts', bufferProfile: 'fast', ok: 9 }] },
], rpcStore);
check(typeof backMerged === 'number', 'a visszatöltés hiba nélkül lefut');
check(core.getChannelDoctorRecord({ id: '9999', name: '[UK] BBC Two HD' }, rpcStore) === null, 'a GB sorból nem keletkezik helyi memória');
check(core.getChannelDoctorRecord({ id: '9821', name: '[HU] Film+ HD' }, rpcStore)?.routes?.length > 0, 'a HU sor a már ismert csatornához fűződik hozzá');
check(beforeRoute && beforeRoute.ok >= 1, 'a helyi mérés megmarad a visszatöltés után is');

/* ─────────────────────────────────────────────────────────────────────────
 * 6. A 0-gombos ablak naplózása nem szemeteli tele az élő listát
 * ───────────────────────────────────────────────────────────────────────── */
console.log('\n6. Ablak-naplózás: diszkrét, nem szemetel');
const logsBefore = core.getTvDoctorSummary(store).recentLogs.length;
core.logTvDoctorPanel('megnyitva (0 gomb)', { csatorna: '[HU] M4 Sport HD', tanultÚtvonalak: 3 });
const logsAfter = core.getTvDoctorSummary(store).recentLogs.length;
check(logsAfter === logsBefore, 'az ablak naplózása nem ír a 48 soros élő eseménylistába');
check(typeof core.logTvDoctorPanel('teszt') === 'undefined', 'a naplózó hívás hiba nélkül lefut');

/* ───────────────────────────────────────────────────────────────────────── */
console.log('');
if (failed > 0) {
  console.error(`TV Doktor útvonal-tesztek: ${passed} sikeres, ${failed} hibás. ❌\n`);
  process.exit(1);
}
console.log(`TV Doktor útvonal-tesztek: ${passed} sikeres, 0 hibás. ✅`);
console.log('A TV Doktor csatornánként 8 útvonalat tanul, csak magyar csatornáról tárol, a filmekről semmit.\n');
