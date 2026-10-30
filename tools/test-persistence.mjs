#!/usr/bin/env node
/*
 * ADATVESZTÉS ÚJRAINDÍTÁSKOR – valódi tároló-regressziós teszt.
 *
 * A TV-naplók szerint (2.5.114) a tár már a mentés közben megtelt:
 *
 *   TÁROLÓ HIBA: content-live-chunk-v1-… mentése végleg sikertelen (local);
 *                foglaltság=75 kulcs / 5115 kB
 *
 * A régi mentés az ELŐZŐ generáció adagjait írás közben törölte, ezért egy
 * kvótahiba után a fejléc már nem létező adagokra mutatott: az alkalmazás
 * üresen indult, és minden újraindítás után újra le kellett tölteni a listát.
 *
 * Ez a teszt a valódi contentStore-t futtatja (esbuild-del csomagolva), két
 * egymást követő "indítással", megosztott tárolón – és ellenőrzi, hogy:
 *   1. a localStorage-ba csak a kis, induló (magyar) készlet kerül;
 *   2. a TELJES lista az IndexedDB-ben van, és újraindítás után visszajön;
 *   3. kvótahiba esetén a KORÁBBI lista érintetlen marad (nincs adatvesztés);
 *   4. ha a localStorage-os adagok eltűntek, a teljes lista az IndexedDB-ből
 *      pótolható (pendingFull);
 *   5. a takarítás nem törli az érvényes listát, a törlés viszont mindent visz.
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

/* --------------------------------------------------------------- fakes */

/** localStorage kvótával (a webOS-on ~5,1 millió karakter). */
function createLocalStorage(quotaChars = 5200000) {
  const map = new Map();
  let quota = quotaChars;
  const entrySize = (key, value) => key.length + value.length;
  const usage = () => {
    let total = 0;
    for (const [key, value] of map) total += entrySize(key, value);
    return total;
  };
  return {
    get length() { return map.size; },
    key: (index) => Array.from(map.keys())[index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      const text = String(value);
      const previous = map.get(key);
      const projected = usage() - (previous === undefined ? 0 : entrySize(key, previous)) + entrySize(key, text);
      if (projected > quota) {
        const error = new Error('QuotaExceededError: ' + key);
        error.name = 'QuotaExceededError';
        throw error;
      }
      map.set(key, text);
    },
    removeItem: (key) => { map.delete(key); },
    clear: () => map.clear(),
    /* csak a tesztnek */
    usage,
    setQuota: (next) => { quota = next; },
    dump: () => Object.fromEntries(map),
    contentChars: () => {
      let total = 0;
      for (const [key, value] of map) if (key.startsWith('iptv_rt_content-')) total += value.length;
      return total;
    },
  };
}

/** IndexedDB kivonat: csak a contentStore által használt műveletek. */
function createIndexedDb() {
  const data = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const request = (result) => {
    const req = { result, onsuccess: null, onerror: null };
    later(() => req.onsuccess?.());
    return req;
  };
  const objectStore = {
    put: (value, key) => { data.set(String(key), String(value)); return request(String(key)); },
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
    dump: () => Object.fromEntries(data),
    keys: () => Array.from(data.keys()),
  };
}

/* ---------------------------------------------------------- adatok */

function channel(index, { hungarian }) {
  return {
    id: `live-p1-${index}`,
    num: index + 1,
    name: (hungarian ? 'M' : 'X') + String(index).padStart(5, '0') + ' HD csatorna',
    logo: `http://example.invalid/logo/${index}.png`,
    categoryId: hungarian ? 'cat-hu' : `cat-${index % 120}`,
    categoryName: hungarian ? '[HU] HUNGARIA' : `FOREIGN ${index % 120}`,
    streamUrl: String(1000 + index),
    flag: hungarian ? '🇭🇺' : '🌍',
    countryCode: hungarian ? 'HU' : `C${index % 90}`,
    epgChannelId: `epg-${index}`,
    isFavorite: false,
    orderIndex: index,
  };
}

function makeContent({ hungarian = 150, foreign = 19850 } = {}) {
  const channels = [];
  for (let index = 0; index < hungarian; index++) channels.push(channel(index, { hungarian: true }));
  for (let index = 0; index < foreign; index++) channels.push(channel(hungarian + index, { hungarian: false }));
  const categories = [
    { id: 'cat-hu', name: '[HU] HUNGARIA', flag: '🇭🇺', channelCount: hungarian, subCategoryCount: 0, type: 'live' },
    ...Array.from({ length: 120 }, (_, index) => ({
      id: `cat-${index}`, name: `FOREIGN ${index}`, flag: '🌍', channelCount: 1, subCategoryCount: 0, type: 'live',
    })),
  ];
  return {
    provider: { id: 'p1', type: 'xtream', serverUrl: 'http://example.invalid:8080', username: 'u', password: 'p' },
    savedAt: new Date().toISOString(),
    channels,
    movies: [],
    series: [],
    liveCategories: categories,
    vodCategories: [],
    seriesCategories: [],
    totals: { live: channels.length, vod: 0, series: 0 },
  };
}

/* --------------------------------------------------- a contentStore bundle */

const outFile = path.resolve('build/test/persistence-bundle.mjs');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: {
    contents: `export {
      saveLiveContentAsync, loadLive, loadLiveBoot, loadLiveFull, readSummary, sweepStorage,
      clearContent, needsLiveCacheCompaction, describeStoredContent,
      saveVodContentSafely, saveSeriesContentSafely, loadVodAsync, loadSeriesAsync,
    } from './web/src/services/contentStore.ts';`,
    resolveDir: ROOT,
    sourcefile: 'persistence-harness.ts',
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

/* ------------------------------------------------------- Node környezet */

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
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

const bundleUrl = pathToFileURL(outFile).href;
/** Új "alkalmazás-indítás": a modul teljes állapota újra létrejön. */
const boot = (sequence) => import(`${bundleUrl}?boot=${sequence}`);

const checks = [];
let failed = false;
function check(ok, message, detail = '') {
  checks.push(`${ok ? 'ok  ' : 'HIBA'} – ${message}${ok || !detail ? '' : ` (${detail})`}`);
  if (!ok) failed = true;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

try {
  /* ============ 1. MENTÉS: kis localStorage-készlet + teljes lista IDB-ben ==== */
  const app1 = await boot(1);
  const content = makeContent();
  await app1.saveLiveContentAsync(content);
  await settle();

  const localChars = localStorageFake.contentChars();
  const idbKeys = indexedDbFake.keys();
  const fullMeta = JSON.parse(indexedDbFake.dump()['content-live-full-meta'] || 'null');
  check(localChars > 0, 'az induló készlet elmentődött a localStorage-ba', `${localChars} karakter`);
  check(
    localChars < 400000,
    'a localStorage-ban csak a kis induló készlet van (nem a teljes 20 000-es lista)',
    `${Math.round(localChars / 1024)} kB`,
  );
  check(Boolean(fullMeta), 'a teljes lista fejléce az IndexedDB-ben van');
  // 1200 csatorna/adag: a 20 000-es lista ~17 adag (a régi 400-asnál 51 volt).
  check(fullMeta?.chunks >= 2, 'a teljes lista adagokban van az IndexedDB-ben', String(fullMeta?.chunks));
  check(
    idbKeys.filter((key) => key.startsWith('content-live-full-v1-')).length === fullMeta?.chunks,
    'minden adag kiíródott az IndexedDB-be',
  );
  check(!app1.needsLiveCacheCompaction(), 'az új formátum nem igényel átállást');

  /* ============ 2. ÚJRAINDÍTÁS: magyar készlet azonnal, teljes lista IDB-ből ==== */
  const app2 = await boot(2);
  const bootLive = app2.loadLive();
  check(bootLive.provider?.id === 'p1', 'újraindítás után megvan a szolgáltató');
  check(bootLive.channels.length === 150, 'a magyar csatornák AZONNAL megvannak (localStorage)', String(bootLive.channels.length));
  check(
    bootLive.channels.every((item) => item.countryCode === 'HU'),
    'az induló készlet csak magyar csatorna',
  );
  check(bootLive.totals.live === 20000, 'a fejléc a VALÓDI összesítést mutatja', JSON.stringify(bootLive.totals));
  check(bootLive.categories.length === 121, 'a kategóriák (országok) is megvannak', String(bootLive.categories.length));

  const full = await app2.loadLiveFull();
  check(full?.channels.length === 20000, 'a TELJES lista visszajön az IndexedDB-ből', String(full?.channels.length));
  check(
    full?.channels.filter((item) => item.countryCode === 'HU').length === 150,
    'a teljes listában megvan mind a magyar csatorna',
  );

  /* ============ 3. KVÓTAHIBA: a korábbi lista NEM sérülhet ==================== */
  const before = app2.loadLive();
  const previousChannels = before.channels.length;
  // A tár TELJESEN tele: egyetlen bájt sem fér be többé.
  localStorageFake.setQuota(localStorageFake.usage());
  await app2.saveLiveContentAsync(makeContent({ hungarian: 5000, foreign: 0 }));
  await settle();

  const afterFailure = app2.loadLive();
  check(
    afterFailure.channels.length === previousChannels,
    'kvótahiba után a KORÁBBI lista érintetlen (nincs adatvesztés)',
    `előtte ${previousChannels}, utána ${afterFailure.channels.length}`,
  );
  check(afterFailure.provider?.id === 'p1', 'kvótahiba után a fejléc is a régi listáé');
  check(afterFailure.totals.live === 20000, 'kvótahiba után az összesítés is a régi listáé');
  const fullAfterFailure = await app2.loadLiveFull();
  check(
    fullAfterFailure?.channels.length === 5000,
    'a teljes lista az IndexedDB-ben a legutóbbi SIKERES mentés (a localStorage hibája nem viszi el)',
    String(fullAfterFailure?.channels.length),
  );

  /* ====== 3b. KEVÉS A HELY: kisebb, de ÉP induló készlet ================== */
  /*
   * A régi hiba pontosan ez volt: a mentés adagonként TÖRÖLTE az előző
   * generációt, ezért egy későbbi adagnál jött kvótahibánál a fejléc már nem
   * létező adagokra mutatott. Most az új generáció csak a fejléc kiírása után
   * vált érvényessé, csonkolt adag pedig egyáltalán nem íródik ki: ha a
   * tervezett készlet nem fér be, a mentés KISEBB, de teljes készlettel
   * próbálkozik újra.
   */
  localStorageFake.setQuota(localStorageFake.usage() + 400000);
  await app2.saveLiveContentAsync(makeContent({ hungarian: 5000, foreign: 0 }));
  await settle();

  const fit = app2.loadLive();
  const fitMeta = JSON.parse(localStorageFake.dump()['iptv_rt_content-live-meta']);
  check(fit.channels.length > 200, 'kevés helynél kisebb, de használható induló készlet készül',
    String(fit.channels.length));
  check(fit.channels.length < 5000, 'a készlet valóban kisebb a teljes listánál', String(fit.channels.length));
  check(fitMeta.boot === fit.channels.length, 'a fejléc a TÉNYLEGESEN elmentett darabszámot mondja',
    `fejléc=${fitMeta.boot}, olvasott=${fit.channels.length}`);
  check(fit.channels.every((item) => item.countryCode === 'HU'), 'a kisebb készlet is csak magyar csatorna');
  check(fit.totals.live === 5000, 'az összesítés a teljes (5000-es) listáé');
  const fitOrphans = Object.keys(localStorageFake.dump())
    .filter((key) => key.startsWith('iptv_rt_content-live-chunk-v1-'))
    .filter((key) => !key.startsWith('iptv_rt_' + fitMeta.chunkPrefix));
  check(fitOrphans.length === 0, 'a korábbi generáció adagjai sem maradtak a tárban', fitOrphans.join(', '));

  /* ============ 4. ELVESZETT ADAGOK: a teljes lista pótolható ================= */
  // Visszaállítjuk a teljes (20 000-es) listát, majd szándékosan "elrontjuk" a
  // localStorage-os adagot: ilyenkor a teljes listának az IndexedDB-ből kell jönnie.
  localStorageFake.setQuota(5200000);
  await app2.saveLiveContentAsync(content);
  await settle();
  const ghost = await boot(3);
  const meta = JSON.parse(localStorageFake.dump()['iptv_rt_content-live-meta']);
  localStorageFake.removeItem(`iptv_rt_${meta.chunkPrefix}0`);
  const damaged = ghost.loadLive();
  check(damaged.pendingFull === true, 'sérült adagoknál jelzi, hogy a teljes lista tölthető vissza');
  check(damaged.channels.length === 0, 'sérült adagoknál nem ad félkész listát');
  const recovered = await ghost.loadLiveFull();
  check(recovered?.channels.length === 20000, 'a teljes lista sérült cache mellett is visszatölthető', String(recovered?.channels.length));

  /* ====== 5. A LOCALSTORAGE ELVESZETT: indulás az IndexedDB-ből ============= */
  /*
   * A TV-n a localStorage-t a webOS kis kvótája miatt a rendszer törölheti,
   * vagy a felhasználó törölheti az alkalmazás adatait. Ilyenkor a korábbi
   * program ÜRESNEK látta magát (a szinkron `loadLive()` semmit nem talált),
   * és AZONNAL letöltötte a teljes katalógust a szolgáltatótól. Most az
   * indulás az IndexedDB-ből áll helyre – hálózat nélkül.
   */
  const app4 = await boot(4);
  await app4.saveLiveContentAsync(content);
  await settle();
  localStorageFake.clear();
  const app5 = await boot(5);
  const lostLocal = app5.loadLive();
  check(lostLocal.channels.length === 0, 'a localStorage elvesztése után a szinkron betöltő üres (ez volt a hiba)');
  const fromIdb = await app5.loadLiveBoot();
  check(fromIdb.provider?.id === 'p1', 'a szolgáltató visszajön az IndexedDB-ből');
  check(fromIdb.channels.length >= 400, 'a kezdőképernyő csatornái visszajönnek az IndexedDB-ből (letöltés nélkül)',
    String(fromIdb.channels.length));
  check(fromIdb.categories.length === 121, 'a kategóriák (országok) is visszajönnek az IndexedDB-ből',
    String(fromIdb.categories.length));
  check(fromIdb.totals.live === 20000, 'a fejléc a VALÓDI darabszámot mondja az IndexedDB-ből',
    JSON.stringify(fromIdb.totals));
  check(fromIdb.pendingFull === true, 'jelzi, hogy a teljes lista háttérben betölthető');
  const restoredFull = await app5.loadLiveFull();
  check(restoredFull?.channels.length === 20000, 'a TELJES lista is megvan – újratöltés nélkül',
    String(restoredFull?.channels.length));
  const report = await app5.describeStoredContent();
  check(
    report.liveLocal === 0 && report.liveIdb === 20000,
    'a tároló-jelentés megmondja, hol van a katalógus',
    JSON.stringify(report),
  );


  /* ============ 5/b. VOD NYERS ADATOK VESZTESÉGMENTES MENTÉSE ============= */
  const longPlot = 'Teljes történet. '.repeat(80);
  const rawList = { stream_id: 77, name: 'Nyers film', stream_icon: 'http://img/p.jpg', tmdb: '123', custom_field: { a: [1, 2] }, category_id: '20' };
  const rawDetail = { info: { plot: longPlot, director: 'Rendező Név', actors: 'Színész Egy, Színész Kettő', country: 'Franciaország', age: '16', video: { codec: 'h264' }, audio: [{ language: 'hu' }], bitrate: 9000 }, movie_data: { stream_id: 77, container_extension: 'mkv' } };
  const vodContent = {
    provider: { id: 'p1', type: 'xtream', serverUrl: 'http://x', username: 'u', password: 'p' },
    savedAt: new Date().toISOString(),
    channels: [], movies: [{
      id: 'vod-p1-77', streamId: 77, title: 'Nyers film', categoryId: 'vc-20', categoryName: 'Filmek',
      poster: 'http://img/p.jpg', rating: 7.5, year: 2024, durationMinutes: 120, plot: longPlot,
      genres: ['Dráma'], director: 'Rendező Név', cast: ['Színész Egy'], streamUrl: 'http://x/movie/u/p/77.mkv',
      audioLanguages: ['Magyar'], subtitleLanguages: ['Angol'], providerData: rawList, detailProviderData: rawDetail,
    }], series: [{
      id: 'ser-p1-88', seriesId: 88, title: 'Nyers sorozat', categoryId: 'sc-30', categoryName: 'Sorozatok',
      poster: 'http://img/s.jpg', rating: 8, year: 2023, seasonsCount: 1, episodesCount: 1, plot: longPlot,
      genres: ['Krimi'], seasons: [{ seasonNumber: 1, name: '1. évad', episodeCount: 1, episodes: [{
        id: 'ep-1', episodeNumber: 1, seasonNumber: 1, title: 'Pilot', durationMinutes: 42, streamUrl: 'http://x/series/u/p/1.mkv',
        plot: 'Epizód tartalom', thumbnail: '', audioLanguages: ['Magyar'], providerData: { id: '1', info: { duration: '00:42:00' }, custom: 'megmarad' },
      }] }], providerData: { series_id: 88, plot: longPlot, cast: 'Szereplő' }, detailProviderData: { info: { plot: longPlot }, episodes: { '1': [{ id: '1' }] } },
    }],
    liveCategories: [], vodCategories: [{ id: 'vc-20', name: 'Filmek', channelCount: 1, subCategoryCount: 0, type: 'movie' }],
    seriesCategories: [{ id: 'sc-30', name: 'Sorozatok', channelCount: 1, subCategoryCount: 0, type: 'series' }],
    totals: { live: 0, vod: 1, series: 1 }, warnings: [],
  };
  await app5.saveVodContentSafely(vodContent);
  await app5.saveSeriesContentSafely(vodContent);
  await settle();
  const loadedVod = await app5.loadVodAsync(vodContent.provider);
  const loadedSeries = await app5.loadSeriesAsync(vodContent.provider);
  const savedMovie = loadedVod.movies[0];
  const savedSeries = loadedSeries.series[0];
  check(savedMovie.plot === longPlot, 'a teljes plot nem csonkolódik 200 karakterre', savedMovie.plot.length);
  check(JSON.stringify(savedMovie.providerData) === JSON.stringify(rawList), 'a nyers listamezők megmaradnak', savedMovie.providerData);
  check(JSON.stringify(savedMovie.detailProviderData) === JSON.stringify(rawDetail), 'a részletes válasz minden mezője megmarad', Object.keys(savedMovie.detailProviderData || {}));
  check(savedSeries.seasons.length === 1 && savedSeries.seasons[0].episodes[0].providerData.custom === 'megmarad', 'a sorozat évadai és epizódjai tartósan mentődnek', savedSeries.seasons);
  check(Boolean(savedSeries.detailProviderData?.episodes), 'a sorozat nyers részletei megmaradnak', savedSeries.detailProviderData);

  /* ============ 6. TAKARÍTÁS ÉS TÖRLÉS ======================================= */
  localStorageFake.setQuota(5200000);
  await app5.saveLiveContentAsync(content);
  await settle();
  localStorageFake.setItem('iptv_rt_content-live-chunk-v1-0-0-9', JSON.stringify({ rows: [['x']] }));
  const removed = ghost.sweepStorage();
  check(removed >= 1, 'a takarítás törölte az elárvult adagot', String(removed));
  check(
    !localStorageFake.dump()['iptv_rt_content-live-chunk-v1-0-0-9'],
    'az elárvult adag tényleg eltűnt',
  );

  // Régi (átállás előtti) fejléc: nincs `boot` mező – ilyenkor kell a kicsinyítés.
  const legacyMeta = JSON.parse(localStorageFake.dump()['iptv_rt_content-live-meta']);
  delete legacyMeta.boot;
  localStorageFake.setItem('iptv_rt_content-live-meta', JSON.stringify(legacyMeta));
  check(ghost.needsLiveCacheCompaction() === true, 'a régi formátumú fejlécet egyszer átállítja');

  ghost.clearContent();
  await settle();
  check(ghost.loadLive().channels.length === 0, 'törlés után üres a localStorage-os lista');
  check((await ghost.loadLiveFull()) === null, 'törlés után üres az IndexedDB is');
  check(ghost.readSummary() === null, 'törlés után nincs összegzés');
} catch (error) {
  failed = true;
  checks.push(`HIBA – a teszt lefutása közben hiba történt: ${error?.stack || error}`);
}

console.log('Adatmegmaradás újraindítás után (contentStore, valódi tároló-modell):\n');
for (const line of checks) console.log('  ' + line);
console.log(failed ? '\n1 vagy több próba nem sikerült. ❌' : '\nMinden próba sikeres. ✅');
process.exit(failed ? 1 : 0);
