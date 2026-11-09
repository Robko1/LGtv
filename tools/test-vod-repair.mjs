#!/usr/bin/env node
/*
 * 2.5.294: HIÁNYOS FILMMENTÉS („MOZI VOD KÖNYVTÁR 500 / 103048”) – PRÓBA.
 *
 * A TV-n ez a jelenség volt: a teljes letöltés után a készülék tárolójában a
 * film fejléc 103 048 filmet ígért, de mögötte csak az első 500 soros adag
 * maradt meg (korábbi, kvótahibás mentés). Ezért
 *   • újraindítás után a Mozi nézet csak 500 filmet mutatott,
 *   • a Frissítés „nincs változás”-t írt (a kategóriák nem változtak),
 *   • a teljes lista soha nem állt helyre.
 *
 * Ez a próba a VALÓDI providerImport + contentStore kódot futtatja (esbuild),
 * és ellenőrzi, hogy a Frissítés felismeri és helyreállítja a hiányos
 * filmmentést – az élő és a sorozat listához nem nyúlva.
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

function createLocalStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (index) => Array.from(map.keys())[index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    clear: () => map.clear(),
    dump: () => Object.fromEntries(map),
  };
}

function createIndexedDb() {
  const data = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const request = (result) => {
    const req = { result, onsuccess: null, onerror: null, error: null };
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
    onclose: null,
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

const localStorageFake = createLocalStorage();
const indexedDbFake = createIndexedDb();
class FakeObjectStore {}
// A valódi webOS-Chromium ismeri a getAllKeys()-t: a mentés ezzel ellenőrzi,
// hogy minden adag tényleg a tárolóban van.
FakeObjectStore.prototype.getAllKeys = function getAllKeys() {};
globalThis.IDBObjectStore = FakeObjectStore;
globalThis.localStorage = localStorageFake;
globalThis.indexedDB = indexedDbFake;
try {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        persisted: async () => true,
        persist: async () => true,
        estimate: async () => ({ quota: 256 * 1024 * 1024, usage: 40 * 1024 * 1024 }),
      },
    },
  });
} catch { /* nem engedi – a tároló így is működik */ }
globalThis.window = {
  localStorage: localStorageFake, indexedDB: indexedDbFake,
  setTimeout, clearTimeout, setInterval, clearInterval, navigator: globalThis.navigator,
  dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {},
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
};
globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} };

/* ------------------------------------------------------- a vizsgált modul */

const outFile = path.resolve('build/test/vod-repair-bundle.mjs');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: {
    contents: `export {
      saveVodContent, loadVodAsync, storedSectionFill, readCatalogState,
      markCatalogSectionsComplete, catalogIncompleteSections,
    } from './web/src/services/contentStore.ts';
    export { refreshProviderContent } from './web/src/services/providerImport.ts';
    export { xtreamService } from './web/src/services/xtreamService.ts';`,
    resolveDir: ROOT, sourcefile: 'vod-repair-harness.ts', loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', target: 'es2020',
  nodePaths: [path.resolve('web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: outFile, logLevel: 'silent',
});
const bundleUrl = pathToFileURL(outFile).href;
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
let failed = false;
function check(ok, message, detail = '') {
  checks.push(`${ok ? 'ok  ' : 'HIBA'} – ${message}${ok || !detail ? '' : ` (${detail})`}`);
  if (!ok) failed = true;
}

/* ------------------------------------------------------------- adatok */

const provider = { id: 'p1', type: 'xtream', serverUrl: 'http://example.invalid:8080', username: 'u', password: 'p' };
const N_MOVIES = 3000;
const rawMovies = Array.from({ length: N_MOVIES }, (_, index) => ({
  num: index + 1,
  name: `Film ${index}`,
  stream_type: 'movie',
  stream_id: index + 1,
  stream_icon: `http://example.invalid/p/${index}.jpg`,
  category_id: 1,
  container_extension: 'mkv',
  year: 2021,
}));
const vodCategories = [{ category_id: 1, category_name: 'Filmek', parent_id: 0 }];

const movies = rawMovies.map((raw) => ({
  id: `vod-p1-${raw.stream_id}`, streamId: raw.stream_id, title: raw.name,
  categoryId: 'vc-1', categoryName: 'Filmek', poster: raw.stream_icon,
  rating: 0, year: 2021, durationMinutes: 0, plot: '', genres: [],
  streamUrl: String(raw.stream_id), containerExtension: 'mkv', isFavorite: false,
}));

/*
 * A kód MessageChannel-lélegzést használ (a webOS időzítő-fojtása miatt).
 * Node-ban az unref-elt portok üzenete elveszne, ha semmi más nem tartja
 * életben az eseményhurkot – ezért a próba alatt egy apró időzítő fut.
 */
const keepAlive = setInterval(() => {}, 50);

try {
  const app = await import(`${bundleUrl}?boot=1`);
  const { xtreamService } = app;
  let vodCalls = 0;
  xtreamService.liveCategories = async () => [{ category_id: 10, category_name: 'HU', parent_id: 0 }];
  xtreamService.vodCategories = async () => vodCategories;
  xtreamService.seriesCategories = async () => [{ category_id: 20, category_name: 'Sorozatok', parent_id: 0 }];
  xtreamService.vodStreams = async () => { vodCalls += 1; return rawMovies; };

  /* 1. A HIBA ÁLLAPOTA: a fejléc 3000 filmet ígér, de csak az első 500 van. */
  await app.saveVodContent({
    provider, savedAt: new Date().toISOString(), channels: [], series: [],
    liveCategories: [], vodCategories: [{ id: 'vc-1', name: 'Filmek', channelCount: 500, subCategoryCount: 0, type: 'movie' }],
    seriesCategories: [],
    movies: movies.slice(0, 500).map((movie, index) => (index === 3 ? { ...movie, isFavorite: true } : movie)),
    totals: { live: 0, vod: N_MOVIES, series: 0 },
  });
  await settle();
  const brokenFill = await app.storedSectionFill('vod', 'p1');
  check(brokenFill?.short === true && brokenFill.present === 1,
    'a „fejléc 3000 film / csak 500 sor” állapot HIÁNYOSKÉNT felismerhető', JSON.stringify(brokenFill));
  const brokenLoad = await app.loadVodAsync(provider);
  check(brokenLoad.movies.length === 500,
    'ebben az állapotban a visszatöltés valóban csak 500 filmet ad', String(brokenLoad.movies.length));

  /* 2. FRISSÍTÉS: a kategóriák NEM változtak, mégis helyre kell állnia. */
  const partials = [];
  const result = await app.refreshProviderContent(
    provider,
    () => {},
    (partial) => { partials.push(partial); },
    { incremental: true },
  );
  check(result?.unchanged === true && result?.repairedVod === true,
    'a Frissítés felismeri a hiányos filmmentést és helyreállítja',
    JSON.stringify({ unchanged: result?.unchanged, repairedVod: result?.repairedVod }));
  check(vodCalls === 1, 'a javítás pontosan EGYSZER kérte le a film indexlistát', String(vodCalls));
  const painted = partials.filter((partial) => Array.isArray(partial.movies) && partial.movies.length > 500);
  check(painted.length > 0 && painted[painted.length - 1].movies.length === N_MOVIES,
    'a helyreállt teljes lista a felületre is megérkezik',
    JSON.stringify(partials.map((partial) => (partial.movies ? partial.movies.length : 0))));
  const healed = await app.loadVodAsync(provider);
  check(healed.movies.length === N_MOVIES,
    'újraindítás (újraolvasás) után a TELJES filmlista jön vissza', String(healed.movies.length));
  const healedFill = await app.storedSectionFill('vod', 'p1');
  check(healedFill?.short === false,
    'a helyreállított mentés nem hiányos', JSON.stringify(healedFill));
  check(healed.movies[3]?.isFavorite === true,
    'a kedvenc jelölés megmaradt a helyreállítás után');
  const state = await app.readCatalogState();
  check(app.catalogIncompleteSections(state).length === 0,
    'a „hiányos szakasz” jelölés lekerült', JSON.stringify(app.catalogIncompleteSections(state)));

  /* 3. EGÉSZSÉGES TÁROLÓ: nincs felesleges újratöltés. */
  const result2 = await app.refreshProviderContent(provider, () => {}, () => {}, { incremental: true });
  check(result2?.unchanged === true && result2?.repairedVod !== true,
    'ép tárolónál a Frissítés továbbra is „nincs változás”', JSON.stringify(result2?.repairedVod));
  check(vodCalls === 1,
    'ép tárolónál NEM indul felesleges film-újratöltés', String(vodCalls));
} catch (error) {
  check(false, 'a próba lefutott hiba nélkül', error?.stack || String(error));
} finally {
  clearInterval(keepAlive);
}

console.log('');
for (const line of checks) console.log(`  ${line}`);
const okCount = checks.filter((line) => line.startsWith('ok')).length;
console.log(`\n${okCount}/${checks.length} ellenőrzés sikeres.\n`);
if (failed) {
  console.log('A hiányos filmmentés javításának próbája NEM futott át. ❌\n');
  process.exit(1);
}
console.log('A hiányos filmmentés javítása működik. ✅\n');
