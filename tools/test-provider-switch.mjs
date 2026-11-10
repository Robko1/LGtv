#!/usr/bin/env node
/*
 * KÉT SZOLGÁLTATÓ – VÁLTÁS, ELKÜLÖNÍTÉS, TÖRLÉS (2.5.417).
 *
 * Valódi futásidejű próba a tényleges modulokkal (esbuild-del csomagolva),
 * közös ál-localStorage-on és ál-IndexedDB-n. A két szolgáltató SZÁNDÉKOSAN
 * azonos csatornaazonosítókat használ (a valóságban a `stream_id` gyakran
 * ütközik két szolgáltató között), hogy minden keveredés azonnal látszódjon.
 *
 * Amit ellenőriz:
 *   1. a háttérben mentő szolgáltató nem veszi át a megjelenített névteret;
 *   2. mindkét szolgáltató katalógusa a SAJÁT azonosítójával, hálózat nélkül
 *      olvasható – a váltáshoz nem kell újra letölteni semmit;
 *   3. az „utoljára nézett csatorna” és a lejátszási profil szolgáltatónként
 *      külön él, a váltás nem törli;
 *   4. a váltás után az előző szolgáltató visszatöltése semmit nem ad át;
 *   5. egy NEM aktív szolgáltató törlése minden adatát eltávolítja, a másikét
 *      érintetlenül hagyja;
 *   6. a legelső („régi”, előtag nélküli) szolgáltató törlése nem viszi el a
 *      másik szolgáltató adatait, a készülékszintű beállításokat és a közös
 *      magyar műsorújságot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('.');
let esbuild;
try {
  esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
} catch {
  console.log('KIPARANCSOLT: esbuild hiányzik – npm install --prefix web');
  process.exit(0);
}

/* ------------------------------------------------------------------ fakes */
function createLocalStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (index) => Array.from(map.keys())[index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(String(key), String(value)); },
    removeItem: (key) => { map.delete(String(key)); },
    clear: () => map.clear(),
    keys: () => Array.from(map.keys()),
  };
}

function createIndexedDb() {
  const data = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const request = (result) => {
    const req = { result, onsuccess: null, onerror: null };
    later(() => req.onsuccess?.());
    return req;
  };
  const objectStore = {
    put: (value, key) => { data.set(String(key), value); return request(String(key)); },
    get: (key) => request(data.get(String(key))),
    delete: (key) => { data.delete(String(key)); return request(undefined); },
    getAllKeys: () => request(Array.from(data.keys())),
    openCursor: () => request(null),
    clear: () => { data.clear(); return request(undefined); },
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => objectStore,
    transaction: () => ({ objectStore: () => objectStore, onabort: null }),
    close: () => {},
    onversionchange: null,
  };
  return {
    open: () => {
      const req = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
    keys: () => Array.from(data.keys()),
    seed: (key, value) => data.set(String(key), value),
    drop: (key) => data.delete(String(key)),
    raw: (key) => data.get(String(key)),
  };
}

/* ----------------------------------------------------------------- adatok */
function makeContent(providerId, label, { hungarian = 40, foreign = 260, movies = 30, series = 12 } = {}) {
  const channels = [];
  for (let index = 0; index < hungarian + foreign; index++) {
    const hu = index < hungarian;
    channels.push({
      // AZONOS azonosítók a két szolgáltatónál – csak a név különbözik.
      id: `live-${index}`,
      num: index + 1,
      name: `${hu ? '[HU] ' : ''}${label} csatorna ${index}`,
      logo: `http://${label}.example/logo/${index}.png`,
      categoryId: hu ? 'cat-hu' : `cat-${index % 20}`,
      categoryName: hu ? '[HU] HUNGARIA' : `FOREIGN ${index % 20}`,
      streamUrl: String(1000 + index),
      flag: hu ? '🇭🇺' : '🌍',
      countryCode: hu ? 'HU' : `C${index % 20}`,
      epgChannelId: `epg-${index}`,
      isFavorite: false,
      orderIndex: index,
    });
  }
  const liveCategories = [
    { id: 'cat-hu', name: '[HU] HUNGARIA', flag: '🇭🇺', channelCount: hungarian, subCategoryCount: 0, type: 'live' },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `cat-${index}`, name: `FOREIGN ${index}`, flag: '🌍', channelCount: 1, subCategoryCount: 0, type: 'live',
    })),
  ];
  const movieList = Array.from({ length: movies }, (_, index) => ({
    id: `movie-${index}`, title: `${label} film ${index}`, year: 2020, rating: 7, durationMinutes: 100,
    genres: [], poster: '', backdrop: '', description: '', categoryId: 'vod-1', streamUrl: `m${index}`,
    streamId: index, containerExtension: 'mp4',
  }));
  const seriesList = Array.from({ length: series }, (_, index) => ({
    id: `series-${index}`, title: `${label} sorozat ${index}`, year: 2021, rating: 8, genres: [],
    poster: '', backdrop: '', description: '', categoryId: 'ser-1', seasons: [], seriesId: index,
  }));
  return {
    provider: { id: providerId, type: 'xtream', serverUrl: `http://${label}.example:8080`, username: 'u', password: 'p' },
    savedAt: new Date().toISOString(),
    channels,
    movies: movieList,
    series: seriesList,
    liveCategories,
    vodCategories: [{ id: 'vod-1', name: 'Filmek', flag: '', channelCount: movies, subCategoryCount: 0, type: 'vod' }],
    seriesCategories: [{ id: 'ser-1', name: 'Sorozatok', flag: '', channelCount: series, subCategoryCount: 0, type: 'series' }],
    totals: { live: channels.length, vod: movies, series },
  };
}

/* ----------------------------------------------------------------- bundle */
const outFile = path.resolve('build/test/provider-switch-bundle.mjs');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: {
    contents: `export {
      saveContent, loadLive, loadLiveFull, loadVodAsync, loadSeriesAsync, inspectStoredCatalogs,
      restoreStoredContent, readCatalogStateSync, clearContentAsync, clearCatalogStateCacheForTests,
    } from './web/src/services/contentStore.ts';
    export { setActiveProviderScope, activeProviderScopeId, providerScopePrefix, legacyProviderScopeOwner } from './web/src/services/providerScope.ts';
    export { storageService } from './web/src/services/storageService.ts';
    export { purgeProviderData } from './web/src/services/providerCleanup.ts';
    export { removeVodFromMemory, getRemovedVodIds } from './web/src/services/vodRemovals.ts';`,
    resolveDir: ROOT,
    sourcefile: 'provider-switch-harness.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2020',
  nodePaths: [path.resolve('web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: outFile,
  logLevel: 'silent',
});

const localStorageFake = createLocalStorage();
const indexedDbFake = createIndexedDb();
class FakeObjectStore {}
FakeObjectStore.prototype.getAllKeys = function getAllKeys() {};
globalThis.IDBObjectStore = FakeObjectStore;
globalThis.localStorage = localStorageFake;
globalThis.indexedDB = indexedDbFake;
globalThis.window = {
  localStorage: localStorageFake,
  indexedDB: indexedDbFake,
  setTimeout, clearTimeout, setInterval, clearInterval,
  addEventListener: () => {}, removeEventListener: () => {},
};

let passed = 0;
let failed = 0;
function check(ok, message, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${message}`); }
  else { failed += 1; console.log(`  ✗ ${message}${detail ? ` (${detail})` : ''}`); }
}
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const allKeys = () => [...localStorageFake.keys(), ...indexedDbFake.keys()];

const app = await import(pathToFileURL(outFile).href);
const A = 'prov-A';
const B = 'prov-B';
const refA = { id: A, type: 'xtream', serverUrl: 'http://alfa.example:8080', username: 'u', password: 'p' };
const refB = { id: B, type: 'xtream', serverUrl: 'http://beta.example:8080', username: 'u', password: 'p' };

try {
  console.log('\n1. A háttérben mentő szolgáltató nem veszi át a megjelenített névteret');
  app.setActiveProviderScope(A);
  await app.saveContent(makeContent(A, 'alfa'));
  await settle();
  // A „B” szolgáltató importja a háttérben ment, miközben „A” van a képernyőn.
  await app.saveContent(makeContent(B, 'beta', { hungarian: 25, foreign: 100, movies: 9, series: 4 }));
  await settle();
  check(app.activeProviderScopeId() === A, 'a megjelenített névtér „A” maradt a „B” mentése után', app.activeProviderScopeId());
  check(app.legacyProviderScopeOwner() === A, 'a régi (előtag nélküli) kulcsok tulajdonosa az első szolgáltató');
  const shownAfterBackgroundSave = app.loadLive();
  check(shownAfterBackgroundSave.provider?.id === A && /alfa/.test(shownAfterBackgroundSave.channels[0]?.name || ''),
    'a képernyőn lévő szolgáltató listája változatlanul „A”', shownAfterBackgroundSave.channels[0]?.name);

  console.log('\n2. Mindkét katalógus a SAJÁT azonosítójával, letöltés nélkül olvasható');
  const bootA = app.loadLive(A);
  const bootB = app.loadLive(B);
  check(bootA.channels.length > 0 && bootA.channels.every((channel) => /alfa/.test(channel.name)), '„A” induló készlete csak „A” csatornáit tartalmazza');
  check(bootB.channels.length > 0 && bootB.channels.every((channel) => /beta/.test(channel.name)), '„B” induló készlete csak „B” csatornáit tartalmazza');
  const planB = await app.inspectStoredCatalogs(B);
  check(Boolean(planB) && planB.provider.id === B && planB.counts.live === 125 && planB.counts.vod === 9 && planB.counts.series === 4,
    '„B” tároló-terve „A” megjelenítése közben is a saját darabszámait adja',
    JSON.stringify(planB?.counts));
  check(app.activeProviderScopeId() === A, 'a felmérés nem állította át a megjelenített névteret');
  const fullB = await app.loadLiveFull(refB);
  const fullA = await app.loadLiveFull(refA);
  check(fullB?.channels.length === 125 && fullB.channels.every((channel) => /beta/.test(channel.name)), '„B” teljes élő listája 125 saját csatorna', String(fullB?.channels.length));
  check(fullA?.channels.length === 300 && fullA.channels.every((channel) => /alfa/.test(channel.name)), '„A” teljes élő listája 300 saját csatorna', String(fullA?.channels.length));
  const vodB = await app.loadVodAsync(refB);
  const vodA = await app.loadVodAsync(refA);
  check(vodB.movies.length === 9 && vodB.movies.every((movie) => /beta/.test(movie.title)), '„B” filmlistája a sajátja – „A” megjelenítése közben is', String(vodB.movies.length));
  check(vodA.movies.length === 30 && vodA.movies.every((movie) => /alfa/.test(movie.title)), '„A” filmlistája a sajátja', String(vodA.movies.length));
  const seriesB = await app.loadSeriesAsync(refB);
  check(seriesB.series.length === 4 && seriesB.series.every((item) => /beta/.test(item.title)), '„B” sorozatlistája a sajátja', String(seriesB.series.length));

  console.log('\n3. Utoljára nézett csatorna és lejátszási profil szolgáltatónként');
  app.storageService.rememberLastChannel('live-7', A);
  app.storageService.rememberLastChannel('live-3', B);
  app.storageService.flushLastChannel();
  check(app.storageService.getLastChannelId(A) === 'live-7', '„A” megjegyzett csatornája megmaradt', app.storageService.getLastChannelId(A));
  check(app.storageService.getLastChannelId(B) === 'live-3', '„B” megjegyzett csatornája külön tárolódik', app.storageService.getLastChannelId(B));
  check(app.storageService.getLastChannelId() === 'live-7', 'azonosító nélkül a megjelenített szolgáltatóé jön vissza');
  const baseSettings = app.storageService.getSettings();
  app.storageService.saveProviderSettings(A, { ...baseSettings, bufferMode: 'stable', tvDoctorEnabled: true });
  app.storageService.saveProviderSettings(B, { ...baseSettings, bufferMode: 'fast', tvDoctorEnabled: false });
  const appliedA = app.storageService.applyProviderSettings(baseSettings, A);
  const appliedB = app.storageService.applyProviderSettings(baseSettings, B);
  check(appliedA.bufferMode === 'stable' && appliedA.tvDoctorEnabled === true, '„A” profilja: stabil puffer, TV Doktor be');
  check(appliedB.bufferMode === 'fast' && appliedB.tvDoctorEnabled === false, '„B” profilja: gyors puffer, TV Doktor ki');
  check(appliedB.subtitleSize === baseSettings.subtitleSize && appliedB.mirrorLayout === baseSettings.mirrorLayout,
    'a készülékszintű beállítások (megjelenés) közösek maradnak');
  const untouched = app.storageService.applyProviderSettings({ ...baseSettings, bufferMode: 'balanced' }, 'prov-uj');
  check(untouched.bufferMode === 'balanced', 'profil nélküli (új) szolgáltató a jelenlegi értékekkel indul');

  console.log('\n4. Váltás „B”-re: saját lista azonnal, az előző visszatöltése semmit nem ad át');
  const planA = await app.inspectStoredCatalogs(A);
  app.setActiveProviderScope(B);
  const shownB = app.loadLive();
  check(shownB.provider?.id === B && shownB.channels.every((channel) => /beta/.test(channel.name)), 'váltás után a megjelenített lista „B” sajátja');
  check(app.storageService.getLastChannelId() === 'live-3', 'váltás után „B” saját utolsó csatornája érvényes');
  const delivered = [];
  await app.restoreStoredContent(planA, {
    onLive: (full) => delivered.push(`live:${full.channels.length}`),
    onVod: (vod) => { delivered.push(`vod:${vod.movies.length}`); return true; },
    onSeries: (ser) => { delivered.push(`series:${ser.series.length}`); return true; },
    onVodPartial: () => delivered.push('vodPartial'),
    onSeriesPartial: () => delivered.push('seriesPartial'),
  }, { scope: 'all' });
  check(delivered.length === 0, 'az előző szolgáltató („A”) visszatöltése a váltás után semmit nem ad át a felületnek', delivered.join(','));
  const deliveredB = [];
  await app.restoreStoredContent(planB, {
    onLive: (full) => deliveredB.push(...full.channels.map((channel) => channel.name)),
  }, { scope: 'live' });
  check(deliveredB.length === 125 && deliveredB.every((name) => /beta/.test(name)), 'a megjelenített „B” visszatöltése a saját 125 csatornáját adja', String(deliveredB.length));
  app.setActiveProviderScope(A);
  check(app.loadLive().provider?.id === A && app.storageService.getLastChannelId() === 'live-7',
    'visszaváltás „A”-ra: saját lista és saját utolsó csatorna, letöltés nélkül');

  console.log('\n4/b. #66-os napló: régi verzió által elvesztett teljes lista és idegen darabszámok felismerése');
  {
    const healthyB = await app.inspectStoredCatalogs(B);
    check(healthyB.liveFullStored === true, 'ép tárnál a teljes élő lista megléte jelezve van („B”)');
    check((await app.inspectStoredCatalogs(A)).liveFullStored === true, 'ép tárnál a teljes élő lista megléte jelezve van („A”)');
    // A 2.5.417 előtti állapot utánzása: „B” teljes élő listája eltűnt az
    // IndexedDB-ből (csak a kis induló készlet maradt), film- és sorozatlistája
    // nincs, az állapot-fejlécében viszont „A” darabszámai állnak.
    const prefix = app.providerScopePrefix(B);
    const snapshot = new Map();
    for (const key of indexedDbFake.keys()) {
      if (!key.startsWith(prefix)) continue;
      if (/content-live-full|content-vod|content-series|catalog-state/.test(key)) {
        snapshot.set(key, true);
      }
    }
    const idbBackup = new Map();
    for (const key of snapshot.keys()) { idbBackup.set(key, indexedDbFake.raw(key)); indexedDbFake.drop(key); }
    const stateKey = 'iptv_rt_' + prefix + 'content-catalog-state';
    const stateBackup = localStorageFake.getItem(stateKey);
    const lsBackup = new Map();
    for (const key of localStorageFake.keys()) {
      if (key.startsWith('iptv_rt_' + prefix) && /content-vod|content-series/.test(key)) { lsBackup.set(key, localStorageFake.getItem(key)); localStorageFake.removeItem(key); }
    }
    localStorageFake.setItem(stateKey, JSON.stringify({
      v: 2, providerId: A, provider: refA, savedAt: 1, checkedAt: 1, fingerprint: '',
      counts: { live: 300, vod: 103153, series: 25078 }, sections: {},
    }));
    app.clearCatalogStateCacheForTests();
    const damaged = await app.inspectStoredCatalogs(B);
    check(Boolean(damaged) && damaged.liveFullStored === false && damaged.bootChannels.length > 0,
      'a hiányzó teljes élő lista felismerve: csak az induló készlet van meg → a felület automatikus pótlást indíthat',
      JSON.stringify({ full: damaged?.liveFullStored, boot: damaged?.bootChannels.length }));
    check(damaged.counts.vod === 0 && damaged.counts.series === 0,
      'a másik szolgáltató film-/sorozat-darabszámai (103 153 / 25 078) NEM jelennek meg „B”-nél', JSON.stringify(damaged.counts));
    check(damaged.provider.id === B && damaged.bootChannels.every((channel) => /beta/.test(channel.name)), 'az induló készlet továbbra is „B” sajátja');
    // Visszaállítás: a teszt további része az ép tárral folytatódik.
    for (const [key, value] of idbBackup) indexedDbFake.seed(key, value);
    for (const [key, value] of lsBackup) localStorageFake.setItem(key, value);
    if (stateBackup === null) localStorageFake.removeItem(stateKey); else localStorageFake.setItem(stateKey, stateBackup);
    app.clearCatalogStateCacheForTests();
    const restored = await app.inspectStoredCatalogs(B);
    check(restored.liveFullStored === true && restored.counts.live === 125 && restored.counts.vod === 9 && restored.counts.series === 4,
      'ép tárral a saját darabszámok változatlanok (125 / 9 / 4)', JSON.stringify(restored.counts));
  }

  console.log('\n5. NEM aktív szolgáltató („B”) törlése: minden adata eltűnik, „A” érintetlen');
  app.storageService.saveFolders([{ id: 'f1', name: 'B kedvencek', channelIds: ['live-1'] }], B);
  app.storageService.saveFolders([{ id: 'f1', name: 'A kedvencek', channelIds: ['live-2'] }], A);
  app.storageService.saveChannelOrder(B, ['live-2', 'live-1']);
  app.storageService.saveChannelOrder(A, ['live-5', 'live-4']);
  app.removeVodFromMemory(B, 'movie', 'movie-1');
  app.removeVodFromMemory(A, 'movie', 'movie-2');
  localStorageFake.setItem(app.providerScopePrefix(B) + 'iptv_rt_tv_doctor_v2', '{"b":1}');
  localStorageFake.setItem('iptv_rt_tv_doctor_v2', '{"a":1}');
  indexedDbFake.seed(`epg-guide-v1-${B}-meta`, '{"b":1}');
  indexedDbFake.seed(`epg-guide-v1-${A}-meta`, '{"a":1}');
  indexedDbFake.seed('epg-hu-guide-v2-public-hu-meta', '{"hu":1}');
  const prefixB = app.providerScopePrefix(B);
  check(prefixB !== '' && allKeys().some((key) => key.includes(prefixB)), 'törlés előtt „B” kulcsai a tárban vannak');
  await app.purgeProviderData(B);
  await settle();
  const leftoversB = allKeys().filter((key) => key.includes(prefixB) || key.includes(`-${B}-`) || key.endsWith(`_${B}`));
  check(leftoversB.length === 0, '„B” egyetlen kulcsa sem maradt a localStorage-ban és az IndexedDB-ben', leftoversB.slice(0, 5).join(' | '));
  check(app.loadLive(B).channels.length === 0 && (await app.inspectStoredCatalogs(B)) === null, '„B” katalógusa már nem tölthető vissza');
  check(app.storageService.getLastChannelId(B) === '' && app.storageService.getProviderSettings(B) === null, '„B” utolsó csatornája és profilja törölve');
  check(app.storageService.getFolders(B).length === 0 && app.storageService.getChannelOrder(B).length === 0, '„B” kedvencei és csatornasorrendje törölve');
  check(app.getRemovedVodIds(B, 'movie').size === 0, '„B” törölt filmjeinek jegyzéke törölve');
  const fullAAfter = await app.loadLiveFull(refA);
  const vodAAfter = await app.loadVodAsync(refA);
  check(fullAAfter?.channels.length === 300 && vodAAfter.movies.length === 30, '„A” teljes élő- és filmlistája érintetlen', `${fullAAfter?.channels.length}/${vodAAfter.movies.length}`);
  check(app.storageService.getLastChannelId(A) === 'live-7' && app.storageService.getProviderSettings(A)?.bufferMode === 'stable',
    '„A” utolsó csatornája és profilja érintetlen');
  check(app.storageService.getFolders(A)[0]?.name === 'A kedvencek' && app.storageService.getChannelOrder(A).join(',') === 'live-5,live-4',
    '„A” kedvencei és csatornasorrendje érintetlen');
  check(app.getRemovedVodIds(A, 'movie').has('movie-2'), '„A” törölt filmjeinek jegyzéke érintetlen');
  check(localStorageFake.getItem('iptv_rt_tv_doctor_v2') === '{"a":1}', '„A” TV Doktor memóriája érintetlen');
  check(indexedDbFake.keys().includes(`epg-guide-v1-${A}-meta`) && indexedDbFake.keys().includes('epg-hu-guide-v2-public-hu-meta'),
    '„A” műsorújsága és a közös magyar műsorújság megmaradt');

  console.log('\n6. A legelső („régi”) szolgáltató törlése nem viszi el a másik adatait');
  await app.saveContent(makeContent(B, 'beta', { hungarian: 25, foreign: 100, movies: 9, series: 4 }));
  await settle();
  app.storageService.rememberLastChannel('live-9', B);
  app.storageService.flushLastChannel();
  app.storageService.saveSettings({ ...app.storageService.getSettings(), activeProviderId: B });
  localStorageFake.setItem('iptv_rt_tv_doctor_pairing_v1', '{"paired":true}');
  // A hívó előbb átvált a megmaradó szolgáltatóra, csak utána töröl.
  app.setActiveProviderScope(B);
  await app.purgeProviderData(A);
  await settle();
  check(app.loadLive(A).channels.length === 0 && (await app.inspectStoredCatalogs(A)) === null, '„A” katalógusa törölve');
  check(app.storageService.getLastChannelId(A) === '' && app.storageService.getProviderSettings(A) === null
    && app.storageService.getFolders(A).length === 0 && localStorageFake.getItem('iptv_rt_tv_doctor_v2') === null,
    '„A” utolsó csatornája, profilja, kedvencei és TV Doktor memóriája törölve');
  check(!indexedDbFake.keys().includes(`epg-guide-v1-${A}-meta`), '„A” mentett műsorújsága törölve');
  const fullBAfter = await app.loadLiveFull(refB);
  const vodBAfter = await app.loadVodAsync(refB);
  check(fullBAfter?.channels.length === 125 && vodBAfter.movies.length === 9 && app.storageService.getLastChannelId(B) === 'live-9',
    '„B” katalógusa és utolsó csatornája érintetlen', `${fullBAfter?.channels.length}/${vodBAfter.movies.length}`);
  check(app.storageService.getSettings().activeProviderId === B && localStorageFake.getItem('iptv_rt_tv_doctor_pairing_v1') === '{"paired":true}',
    'a készülékszintű beállítások és a TV Doktor párosítás megmaradt');
  check(indexedDbFake.keys().includes('epg-hu-guide-v2-public-hu-meta'), 'a közös magyar műsorújság megmaradt');
} catch (error) {
  failed += 1;
  console.error('\nA próba futás közben megszakadt:', error);
}

console.log(`\n=== EREDMÉNY: ${passed} sikeres, ${failed} hibás ===`);
if (failed) process.exit(1);
console.log('OK: két szolgáltató – váltás letöltés nélkül, elkülönített adatok, célzott törlés.');
process.exit(0);
