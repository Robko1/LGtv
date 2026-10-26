#!/usr/bin/env node
/*
 * TARTÓS TÁROLÁS – VALÓDI ÚJRAINDÍTÁSI PRÓBA (2.5.127).
 *
 * A 2.5.126-os, 18:44-es Supabase-napló (#2) ezt mutatta:
 *
 *   TÁROLÓ-JELENTÉS: localStorage=9 kulcs / 1860 karakter;
 *                    induló készlet=0; IndexedDB: élő=0, film=0, sorozat=0.
 *   → automatikus teljes letöltés: 20 190 csatorna + 102 824 film +
 *     24 974 sorozat, 76 MB, 67,6 mp; majd 13 mp-es főszál-leállás,
 *     és a naplóban EGYETLEN „elmentve” sor sem.
 *
 * Ez a próba a VALÓDI contentStore-t futtatja (esbuild-csomagolva), több
 * egymást követő „alkalmazás-indítással”, megosztott tárolóval. A cél:
 *   1. a teljes katalógus (100 ezer+ film) MÁSODPERCEK alatt, TARTÓSAN mentődik;
 *   2. az IPK teljes bezárása után AZONNAL, letöltés nélkül visszajön;
 *   3. ha az import közben zárják be az appot, a MÁR KÉSZ szakaszok megmaradnak;
 *   4. ha a webOS bezárja az adatbázis-kapcsolatot, a mentés ÚJRANYIT és sikerül;
 *   5. ha az írás félbeszakad, a RÉGI, ÉP lista marad érvényben (fejléc utolsó);
 *   6. a 100 ezres listát NEM erőltetjük a 5 MB-os localStorage-ba;
 *   7. a tartós tár (persist) és a frissességi bélyeg (TTL) működik.
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

function createLocalStorage(quotaChars = 5200000) {
  const map = new Map();
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
      if (projected > quotaChars) {
        const error = new Error('QuotaExceededError: ' + key);
        error.name = 'QuotaExceededError';
        throw error;
      }
      map.set(key, text);
    },
    removeItem: (key) => { map.delete(key); },
    clear: () => map.clear(),
    usage,
    dump: () => Object.fromEntries(map),
    contentChars: () => {
      let total = 0;
      for (const [key, value] of map) if (key.startsWith('iptv_rt_content-')) total += value.length;
      return total;
    },
  };
}

/** IndexedDB kivonat: tranzakciók, kérések, kapcsolat-bezárás és hiba injektálása. */
function createIndexedDb() {
  const data = new Map();
  const later = (fn) => setTimeout(fn, 0);
  let putCount = 0;
  let failAfterPuts = Infinity;
  let openCount = 0;
  const request = (result, fail = false) => {
    const req = { result, onsuccess: null, onerror: null, error: fail ? Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' }) : null };
    later(() => (fail ? req.onerror?.() : req.onsuccess?.()));
    return req;
  };
  const objectStore = {
    put: (value, key) => {
      putCount += 1;
      if (putCount > failAfterPuts) return request(undefined, true);
      data.set(String(key), String(value));
      return request(String(key));
    },
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
      openCount += 1;
      const req = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
    /** A webOS háttérbe tevéskor maga zárja be a kapcsolatot. */
    closeConnection: () => { db.onclose?.(); },
    failPuts: (after = 0) => { putCount = 0; failAfterPuts = after; },
    resumePuts: () => { failAfterPuts = Infinity; },
    dump: () => Object.fromEntries(data),
    keys: () => Array.from(data.keys()),
    get puts() { return putCount; },
    get opens() { return openCount; },
  };
}

class FakeObjectStore {}
FakeObjectStore.prototype.getAllKeys = function getAllKeys() {};

const localStorageFake = createLocalStorage();
const indexedDbFake = createIndexedDb();
let persistCalls = 0;
try {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        persisted: async () => false,
        persist: async () => { persistCalls += 1; return true; },
        estimate: async () => ({ quota: 256 * 1024 * 1024, usage: 30 * 1024 * 1024 }),
      },
    },
  });
} catch { /* a futókörnyezet nem engedi – a tároló így is működik */ }
globalThis.IDBObjectStore = FakeObjectStore;
globalThis.localStorage = localStorageFake;
globalThis.indexedDB = indexedDbFake;
globalThis.window = {
  localStorage: localStorageFake, indexedDB: indexedDbFake,
  setTimeout, clearTimeout, setInterval, clearInterval, navigator: globalThis.navigator,
};

/* ------------------------------------------------------- a vizsgált modul */

const outFile = path.resolve('build/test/durable-bundle.mjs');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: {
    contents: `export {
      saveLiveContentAsync, saveVodContent, saveSeriesContent, saveContent,
      loadLive, loadLiveBoot, loadLiveFull, loadVodAsync, loadSeriesAsync,
      inspectStoredCatalogs, restoreStoredContent, cancelStoredContentRestore,
      readCatalogState, catalogNeedsCheck, markCatalogChecked, setCatalogFingerprint,
      describeStoredContent, saveCatalogExtras, clearContent,
    } from './web/src/services/contentStore.ts';
    export { ensureDurableStorage, describeIdbStore, storageBudgetBytes } from './web/src/services/idbStore.ts';`,
    resolveDir: ROOT, sourcefile: 'durable-harness.ts', loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', target: 'es2020',
  nodePaths: [path.resolve('web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: outFile, logLevel: 'silent',
});
const bundleUrl = pathToFileURL(outFile).href;
/** Új indítás: a modul összes belső állapota (kapcsolat, cache) újraépül. */
const boot = (sequence) => import(`${bundleUrl}?boot=${sequence}`);
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
let failed = false;
function check(ok, message, detail = '') {
  checks.push(`${ok ? 'ok  ' : 'HIBA'} – ${message}${ok || !detail ? '' : ` (${detail})`}`);
  if (!ok) failed = true;
}

/* ------------------------------------------------------------- adatok */

const provider = { id: 'p1', type: 'xtream', serverUrl: 'http://example.invalid:8080', username: 'u', password: 'p' };
const N_LIVE = 20190;
const N_MOVIES = 102824;
const N_SERIES = 24974;

const channels = Array.from({ length: N_LIVE }, (_, index) => ({
  id: `live-p1-${index}`, num: index + 1, name: `CH ${index} HD`, logo: `http://example.invalid/l/${index}.png`,
  categoryId: 'hu', categoryName: '[HU] HUNGARIA', streamUrl: String(1000 + index), streamId: 1000 + index,
  flag: '🇭🇺', countryCode: 'HU', country: 'Magyarország', epgChannelId: `epg-${index}`,
  isFavorite: false, orderIndex: index,
}));
const movies = Array.from({ length: N_MOVIES }, (_, index) => ({
  id: `vod-p1-${index + 1}`, streamId: index + 1, title: `Film ${index}`,
  categoryId: 'vc-1', categoryName: 'Filmek', poster: `http://example.invalid/p/${index}.jpg`,
  rating: 7, year: 2021, durationMinutes: 0, plot: '', genres: [],
  streamUrl: String(index + 1), containerExtension: 'mkv', isFavorite: false,
}));
const series = Array.from({ length: N_SERIES }, (_, index) => ({
  id: `ser-p1-${index + 1}`, seriesId: index + 1, title: `Sorozat ${index}`,
  categoryId: 'sc-1', categoryName: 'Sorozatok', poster: '', rating: 6, year: 2020,
  plot: '', genres: [], seasons: [], seasonsCount: 1, episodesCount: 12, isFavorite: false,
}));
const categories = [
  { id: 'hu', name: '[HU] HUNGARIA', flag: '🇭🇺', channelCount: N_LIVE, subCategoryCount: 0, type: 'live' },
  { id: 'vc-1', name: 'Filmek', flag: '🎬', channelCount: N_MOVIES, subCategoryCount: 0, type: 'movie' },
  { id: 'sc-1', name: 'Sorozatok', flag: '📺', channelCount: N_SERIES, subCategoryCount: 0, type: 'series' },
];
const content = {
  provider, savedAt: new Date().toISOString(), channels, movies, series,
  liveCategories: [categories[0]], vodCategories: [categories[1]], seriesCategories: [categories[2]],
  totals: { live: N_LIVE, vod: N_MOVIES, series: N_SERIES },
};

try {
  /* 1. TARTÓS TÁR KÉRÉSE ───────────────────────────────────────────────── */
  const app1 = await boot(1);
  const durable = await app1.ensureDurableStorage();
  check(persistCalls > 0 && durable.persisted === true,
    'a böngészőtől automatikusan TARTÓS tárolót kérünk (persist)', JSON.stringify(durable));
  check(durable.quotaBytes >= 256 * 1024 * 1024 - 1,
    'a kért/nagyobb kapacitás elérhető (kvóta)', String(durable.quotaBytes));
  const budget = await app1.storageBudgetBytes();
  check(budget.quotaBytes >= 100 * 1024 * 1024,
    'a gyorsítótár-keret jóval nagyobb a 25 MB-os katalógusnál', String(budget.quotaBytes));

  /* 2. IMPORT KÖZBENI BEZÁRÁS – csak az élő szakasz készült el ─────────── */
  const liveOnly = { ...content, movies: [], series: [], vodCategories: [], seriesCategories: [] };
  const liveStart = Date.now();
  await app1.saveLiveContentAsync(liveOnly);
  const liveMs = Date.now() - liveStart;
  check(liveMs < 8000, 'a teljes élő lista gyorsan (8 mp alatt) a tartós tárba kerül', `${liveMs} ms`);
  check(localStorageFake.contentChars() < 500000,
    'a localStorage-ban CSAK a kis induló készlet van', `${localStorageFake.contentChars()} karakter`);

  // ÚJ INDÍTÁS (a TV-t teljesen bezárták). A filmek még nincsenek kész.
  const app2 = await boot(2);
  await settle();
  const plan2 = await app2.inspectStoredCatalogs();
  check(Boolean(plan2 && plan2.hasLive), 'újraindítás után van mentett élő lista');
  check(plan2?.hasVod === false, 'a még el nem készült filmlistát nem hazudjuk késznek');
  const restored2 = { live: 0, vod: 0, series: 0 };
  await app2.restoreStoredContent(plan2, {
    onLive: (full) => { restored2.live = full.channels.length; },
    onVod: (vod) => { restored2.vod = vod.movies.length; },
    onSeries: (ser) => { restored2.series = ser.series.length; },
  });
  check(restored2.live === N_LIVE, 'a már kész élő lista AZONNAL, letöltés nélkül visszajön', String(restored2.live));
  check(app2.loadLive().channels.length > 0,
    'az induló készlet a localStorage-ból is azonnal olvasható');

  /* 3. TELJES KATALÓGUS MENTÉSE – a régi kódnál ez nem fért el / nem ért véget */
  const app3 = await boot(3);
  const fullStart = Date.now();
  await app3.saveContent(content);
  const fullMs = Date.now() - fullStart;
  check(fullMs < 15000,
    'a 100 ezres katalógus mentése 15 mp alatt kész (kötegelt tranzakciók)', `${fullMs} ms`);
  const idbDump = indexedDbFake.dump();
  check(Boolean(idbDump['content-live-full-meta'] && idbDump['content-vod-meta'] && idbDump['content-series-meta']),
    'mindhárom lista fejléce a tartós tárban van');
  check(localStorageFake.contentChars() < 500000,
    'a 100 ezres katalógust NEM írtuk a kis localStorage-ba', `${localStorageFake.contentChars()} karakter`);

  /* 4. TELJES ÚJRAINDÍTÁS – minden adat azonnal visszajön ──────────────── */
  const app4 = await boot(4);
  await settle();
  const plan4 = await app4.inspectStoredCatalogs();
  check(Boolean(plan4 && plan4.hasLive && plan4.hasVod && plan4.hasSeries),
    'a tároló-felmérés mindhárom kész listát látja');
  check(plan4?.counts.live === N_LIVE && plan4?.counts.vod === N_MOVIES && plan4?.counts.series === N_SERIES,
    'a felmért darabszámok pontosak', JSON.stringify(plan4?.counts));
  const restored4 = { live: 0, vod: 0, series: 0 };
  const restoreStart = Date.now();
  await app4.restoreStoredContent(plan4, {
    onLive: (full) => { restored4.live = full.channels.length; },
    onVod: (vod) => { restored4.vod = vod.movies.length; },
    onSeries: (ser) => { restored4.series = ser.series.length; },
  });
  const restoreMs = Date.now() - restoreStart;
  check(restored4.live === N_LIVE, 'újraindítás után a TELJES csatornalista visszajön', String(restored4.live));
  check(restored4.vod === N_MOVIES, 'újraindítás után a TELJES filmlista visszajön', String(restored4.vod));
  check(restored4.series === N_SERIES, 'újraindítás után a TELJES sorozatlista visszajön', String(restored4.series));
  check(restoreMs < 15000, 'a visszatöltés gyors (nincs 76 MB-os újratöltés)', `${restoreMs} ms`);
  // A megosztott visszatöltés NEM olvas kétszer ugyanabból a generációból.
  const putsBefore = indexedDbFake.puts;
  await app4.restoreStoredContent(plan4, {});
  check(indexedDbFake.puts === putsBefore,
    'a második visszatöltési kérés nem ír újra semmit (nincs felesleges munka)');

  /* 5. A WEBOS BEZÁRJA A KAPCSOLATOT – a következő mentés ÚJRANYIT ─────── */
  const app5 = await boot(5);
  await settle();
  const opensBefore = indexedDbFake.opens;
  indexedDbFake.closeConnection();
  const reopenStart = Date.now();
  await app5.saveVodContent({ ...content, movies: movies.slice(0, 20000), totals: { ...content.totals, vod: 20000 } });
  check(indexedDbFake.opens > opensBefore,
    'lezárt adatbázis-kapcsolat után a mentés ÚJRA NYITJA a tárt',
    `nyitások: ${opensBefore} → ${indexedDbFake.opens}`);
  const afterReopen = await app5.loadVodAsync(provider);
  check(afterReopen.movies.length === 20000,
    'a lezárás utáni mentés valóban visszaolvasható', `${afterReopen.movies.length} film, ${Date.now() - reopenStart} ms`);

  /* 6. FÉLBESZAKADT ÍRÁS – a RÉGI, ÉP lista marad (fejléc utolsó) ──────── */
  const app6 = await boot(6);
  await settle();
  const oldMeta = JSON.parse(indexedDbFake.dump()['content-vod-meta']);
  check(Boolean(oldMeta?.chunkPrefix), 'van érvényes régi fejléc a támadáshoz');
  indexedDbFake.failPuts(2); // a 3. írástól minden kérés hibázik
  await app6.saveVodContent({ ...content, movies: movies.slice(0, 30000), totals: { ...content.totals, vod: 30000 } });
  indexedDbFake.resumePuts();
  const metaAfterFailure = JSON.parse(indexedDbFake.dump()['content-vod-meta']);
  check(metaAfterFailure.chunkPrefix === oldMeta.chunkPrefix,
    'egy félbeszakadt mentés NEM ír át fejlécet (a régi lista érvényes marad)');
  const afterFailure = await app6.loadVodAsync(provider);
  check(afterFailure.movies.length === 20000,
    'a sikertelen mentés után a KORÁBBI, ÉP lista töltődik vissza', String(afterFailure.movies.length));
  check(localStorageFake.contentChars() < 500000,
    'sikertelen tartós mentés után sincs 100 ezres localStorage-zsúfolás',
    `${localStorageFake.contentChars()} karakter`);

  /* 7. FRISSesséGI BÉLYEG (stale-while-revalidate) ─────────────────────── */
  const app7 = await boot(7);
  const state = await app7.readCatalogState();
  check(Boolean(state && state.counts.vod > 0),
    'a katalógus-állapot (darabszám, mentési idő) megvan', JSON.stringify(state?.counts));
  check(state && app7.catalogNeedsCheck(state) === false,
    'friss gyorsítótárnál NEM indul felesleges ellenőrzés/letöltés');
  const stale = { ...state, checkedAt: Date.now() - 13 * 60 * 60 * 1000 };
  check(app7.catalogNeedsCheck(stale) === true,
    'a 12 órás TTL lejárta után egyetlen olcsó ellenőrzés engedélyezett');
  app7.markCatalogChecked();
  app7.setCatalogFingerprint('abc123', provider);
  await settle();
  const state2 = await app7.readCatalogState();
  check(state2?.fingerprint === 'abc123',
    'a kategória-ujjlenyomat a frissességi állapotban él', String(state2?.fingerprint));

  /* 8. RÉSZLETES VOD-METAADATOK ÚJRAINDÍTÁS UTÁN ──────────────────────── */
  const enriched = [{ ...movies[0], audioLanguages: ['hu'], subtitleLanguages: ['hu'], director: 'Teszt Rendező' }];
  await app7.saveCatalogExtras(provider.id, enriched, []);
  const app8 = await boot(8);
  const withExtras = await app8.loadVodAsync(provider);
  check(withExtras.movies[0]?.director === 'Teszt Rendező',
    'a 20 részletes VOD-metaadat külön rekordból visszaáll újraindítás után',
    String(withExtras.movies[0]?.director));

  /* 9. TÁROLÓ-JELENTÉS ─────────────────────────────────────────────────── */
  const report = await app8.describeStoredContent();
  check(report.vodIdb === 20000 && report.seriesIdb > 0 && report.liveIdb === N_LIVE,
    'a tároló-jelentés a valós darabszámokat mutatja', JSON.stringify(report));
} catch (error) {
  check(false, 'a próba kivétellel szakadt meg', String(error?.stack || error).slice(0, 400));
}

console.log('\nTARTÓS TÁROLÁS / ÚJRAINDÍTÁS – eredmények:');
for (const line of checks) console.log('  ' + line);
console.log(`\n${checks.filter((line) => line.startsWith('ok')).length}/${checks.length} ellenőrzés sikeres.`);
if (failed) {
  console.log('\nA tartós tárolás próbája NEM futott át. ❌\n');
  process.exit(1);
}
console.log('\nMinden tartós tárolási próba sikeres. ✅\n');
