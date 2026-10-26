#!/usr/bin/env node
/*
 * ADATVESZTÉS ÚJRAINDÍTÁSKOR – a valódi tároló viselkedése.
 *
 * A TV-napló (2.5.114) ezt mutatta:
 *
 *   TÁROLÓ HIBA: content-live-chunk-v1-… mentése végleg sikertelen (local);
 *                foglaltság=75 kulcs / 5115 kB
 *
 * A 20 190 csatornás lista (~3,9 MB) nem fér be a webOS ~5 MB-os
 * localStorage-ába. A régi mentés írás közben törölte az előző generáció
 * adagjait, ezért egy kvótahiba után a fejléc már nem létező adagokra
 * mutatott: az alkalmazás MINDEN újraindítás után üresen indult, és a
 * szolgáltatótól újra letöltötte a teljes katalógust (6,6 + 40,4 + 29,2 MB).
 *
 * Ez a teszt a VALÓDI contentStore-t futtatja (esbuild-del csomagolva),
 * két egymást követő „indítással” és megosztott tárolóval:
 *
 *   1. a localStorage-ba csak a kis, magyar induló készlet kerül;
 *   2. a TELJES lista az IndexedDB-be megy, és újraindítás után visszajön;
 *   3. kvótahiba esetén a KORÁBBI lista érintetlen (nincs adatvesztés);
 *   4. sérült/elveszett localStorage-adagoknál a teljes lista pótolható;
 *   5. ha a localStorage TELJESEN eltűnik (webOS kvóta/törlés), az indulás
 *      az IndexedDB-ből áll helyre – letöltés nélkül;
 *   6. a takarítás nem viszi el az érvényes listát; a törlés mindent visz.
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
  console.log('KIPARANCSOLT: az esbuild nem érhető el (web/node_modules).');
  process.exit(0);
}

/* --------------------------------------------------------------- fakes */

/** localStorage kvótával (a webOS-on ~5 MB, karakterben számolva). */
function createLocalStorage(quotaChars = 5_200_000) {
  const map = new Map();
  let quota = quotaChars;
  const usage = () => {
    let total = 0;
    for (const [key, value] of map) total += key.length + value.length;
    return total;
  };
  return {
    get length() { return map.size; },
    key: (index) => Array.from(map.keys())[index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      const text = String(value);
      const previous = map.get(key);
      const projected = usage() - (previous === undefined ? 0 : key.length + previous.length) + key.length + text.length;
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
    _usage: usage,
    _setQuota: (next) => { quota = next; },
    _dump: () => Object.fromEntries(map),
    _liveChars: () => {
      let total = 0;
      for (const [key, value] of map) if (key.includes('content-live')) total += value.length;
      return total;
    },
  };
}

/** IndexedDB kivonat: csak a contentStore által használt műveletek. */
function createIndexedDb() {
  const data = new Map();
  const later = (run) => {
    const request = { result: undefined, onsuccess: null, onerror: null };
    setTimeout(() => { try { request.onsuccess?.(); } catch { /* a hívó kezeli */ } }, 0);
    request._run = run;
    // az eredményt már most beállítjuk: a contentStore az `onsuccess`-ban olvassa
    request.result = run();
    return request;
  };
  const objectStore = {
    put: (value, key) => later(() => { data.set(String(key), String(value)); return String(key); }),
    get: (key) => later(() => data.get(String(key))),
    delete: (key) => later(() => { data.delete(String(key)); return undefined; }),
    getAllKeys: () => later(() => Array.from(data.keys())),
    openCursor: () => later(() => null),
    clear: () => later(() => { data.clear(); return undefined; }),
  };
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => objectStore,
    transaction: () => ({ objectStore: () => objectStore, onabort: null }),
    close: () => {},
  };
  return {
    open: () => {
      const request = { result: database, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
    _dump: () => Object.fromEntries(data),
    _keys: () => Array.from(data.keys()),
  };
}

/* ------------------------------------------------------------ a bundle */

const outFile = path.resolve('build/test/live-cache-bundle.mjs');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: {
    contents: `export {
      saveLiveContentAsync, loadLive, loadLiveBoot, loadLiveFull, readSummary,
      sweepStorage, clearContent, needsLiveCacheCompaction, describeStoredContent,
    } from './web/src/services/contentStore.ts';`,
    resolveDir: ROOT,
    sourcefile: 'live-cache-harness.ts',
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

/* ---------------------------------------------------- node környezet */

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
/** Új „alkalmazás-indítás”: a modul állapota teljesen újra létrejön. */
const boot = (sequence) => import(`${bundleUrl}?boot=${sequence}`);
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

/* --------------------------------------------------------------- adatok */

function channel(index, hungarian) {
  return {
    id: `live-p1-${index}`,
    num: index + 1,
    name: `CH ${index + 1}`,
    logo: '',
    categoryId: hungarian ? 'hu' : `foreign-${index % 40}`,
    categoryName: hungarian ? '[HU] HUNGARIA' : `FOREIGN ${index % 40}`,
    streamUrl: `http://example.invalid/live/${index}.ts`,
    flag: hungarian ? '🇭🇺' : '🌍',
    countryCode: hungarian ? 'HU' : 'DE',
    country: hungarian ? 'Magyarország' : 'Németország',
  };
}

function makeContent(hungarian, foreign) {
  const channels = [];
  for (let index = 0; index < hungarian; index++) channels.push(channel(index, true));
  for (let index = 0; index < foreign; index++) channels.push(channel(hungarian + index, false));
  const liveCategories = [
    { id: 'cat-hu', name: '[HU] HUNGARIA', flag: '🇭🇺', channelCount: hungarian, subCategoryCount: 0, type: 'live' },
    ...Array.from({ length: 120 }, (_, index) => ({
      id: `cat-f-${index}`, name: `FOREIGN ${index}`, flag: '🌍', channelCount: 1, subCategoryCount: 0, type: 'live',
    })),
  ];
  return {
    provider: { id: 'p1', type: 'xtream', serverUrl: 'http://example.invalid:8080', username: 'u', password: 'p' },
    savedAt: new Date().toISOString(),
    channels,
    movies: [],
    series: [],
    liveCategories,
    vodCategories: [],
    seriesCategories: [],
    totals: { live: channels.length, vod: 0, series: 0 },
  };
}

/* -------------------------------------------------------------- futás */

const checks = [];
let failed = false;
const check = (ok, message, detail = '') => {
  checks.push(`${ok ? 'ok  ' : 'HIBA'} – ${message}${ok || !detail ? '' : ` (${detail})`}`);
  if (!ok) failed = true;
};

try {
  /* ============ 1. MENTÉS: kis localStorage, teljes lista az IDB-ben ====== */
  const first = await boot(1);
  const content = makeContent(150, 19_850);
  await first.saveLiveContentAsync(content);
  await settle();

  const liveChars = localStorageFake._liveChars();
  const idbFullMeta = JSON.parse(indexedDbFake._dump()['content-live-full-meta'] || 'null');
  check(liveChars > 0, 'az induló készlet elmentődött a localStorage-ba', `${liveChars} karakter`);
  check(liveChars < 120_000, 'a localStorage-ban csak a kis magyar készlet van (nem a 20 000-es lista)', `${liveChars} karakter`);
  check(Boolean(idbFullMeta), 'a teljes lista fejléce az IndexedDB-ben van');
  check((idbFullMeta?.chunks ?? 0) >= 40, 'a teljes lista adagokban van az IndexedDB-ben', String(idbFullMeta?.chunks));
  check(!first.needsLiveCacheCompaction(), 'az új formátum nem igényel átállást');

  /* ============ 2. ÚJRAINDÍTÁS: magyar készlet azonnal, teljes lista IDB-ből */
  const second = await boot(2);
  const bootLive = second.loadLive();
  check(bootLive.provider?.id === 'p1', 'újraindítás után megvan a szolgáltató');
  check(bootLive.channels.length === 150, 'a magyar csatornák AZONNAL megvannak (localStorage)', String(bootLive.channels.length));
  check(bootLive.channels.every((item) => item.countryCode === 'HU'), 'az induló készlet csak magyar csatorna');
  check(bootLive.totals.live === 20_000, 'a fejléc a VALÓDI összesítést mutatja', JSON.stringify(bootLive.totals));
  check(bootLive.categories.length === 121, 'a kategóriák (országok) is megvannak', String(bootLive.categories.length));

  const full = await second.loadLiveFull();
  check(full?.channels.length === 20_000, 'a TELJES lista visszajön az IndexedDB-ből', String(full?.channels.length));
  check(
    full?.channels.filter((item) => item.countryCode === 'HU').length === 150,
    'a teljes listában megvan mind a magyar csatorna',
  );

  /* ============ 3. KVÓTAHIBA: a korábbi lista NEM sérülhet ================ */
  const before = second.loadLive();
  const previousChannels = before.channels.length;
  localStorageFake._setQuota(localStorageFake._usage());
  let threw = false;
  try {
    await second.saveLiveContentAsync(makeContent(5_000, 0));
  } catch {
    threw = true;
  }
  await settle();

  const afterFailure = second.loadLive();
  check(
    afterFailure.channels.length === previousChannels,
    'kvótahiba után a KORÁBBI lista érintetlen (nincs adatvesztés)',
    `előtte ${previousChannels}, utána ${afterFailure.channels.length}`,
  );
  check(afterFailure.provider?.id === 'p1', 'kvótahiba után a fejléc is a régi listáé');
  check(afterFailure.totals.live === 20_000, 'kvótahiba után az összesítés is a régi listáé');
  check(!threw, 'a tár hibája nem dob kivételt a felület felé');
  const fullAfterFailure = await second.loadLiveFull();
  check(
    fullAfterFailure?.channels.length === 5_000,
    'a teljes lista az IndexedDB-ben a legutóbbi SIKERES mentés',
    String(fullAfterFailure?.channels.length),
  );

  /* ====== 3b. KEVÉS A HELY: kisebb, de ÉP induló készlet ================ */
  localStorageFake._setQuota(localStorageFake._usage() + 60_000);
  await second.saveLiveContentAsync(makeContent(5_000, 0));
  await settle();
  const fit = second.loadLive();
  const fitMeta = JSON.parse(localStorageFake._dump()['iptv_rt_content-live-meta'] || 'null');
  check(fit.channels.length > 0, 'kevés helynél kisebb, de használható induló készlet készül', String(fit.channels.length));
  if (fitMeta) {
    check(fitMeta.full === 5_000, 'a fejléc a teljes lista darabszámát őrzi', String(fitMeta.full));
    const orphans = Object.keys(localStorageFake._dump())
      .filter((key) => key.startsWith('iptv_rt_content-live-chunk-v1-'))
      .filter((key) => !key.startsWith('iptv_rt_' + fitMeta.chunkPrefix));
    check(orphans.length === 0, 'a korábbi generáció adagjai sem maradtak a tárban', orphans.join(', '));
  }

  /* ============ 4. ELVESZETT ADAG: a teljes lista pótolható ============== */
  localStorageFake._setQuota(5_200_000);
  await second.saveLiveContentAsync(content);
  await settle();
  const ghost = await boot(3);
  const meta = JSON.parse(localStorageFake._dump()['iptv_rt_content-live-meta']);
  localStorageFake.removeItem(`iptv_rt_${meta.chunkPrefix}0`);
  const damaged = ghost.loadLive();
  check(damaged.pendingFull === true, 'sérült adagoknál jelzi, hogy a teljes lista tölthető vissza');
  check(damaged.channels.length === 0, 'sérült adagoknál nem ad félkész listát');
  const recovered = await ghost.loadLiveFull();
  check(recovered?.channels.length === 20_000, 'a teljes lista sérült cache mellett is visszatölthető', String(recovered?.channels.length));

  /* ============ 5. A LOCALSTORAGE TELJESEN ELVESZETT ==================== */
  /*
   * A webOS kis kvótája miatt a tár tartalma eltűnhet (vagy a felhasználó
   * törli az alkalmazás adatait). A korábbi program ilyenkor ÜRESNEK látta
   * magát, és azonnal letöltötte a teljes katalógust.
   */
  await second.saveLiveContentAsync(content);
  await settle();
  localStorageFake.clear();
  const afterWipe = await boot(4);
  check(afterWipe.loadLive().channels.length === 0, 'a localStorage elvesztése után a szinkron betöltő üres (ez volt a hiba)');
  const idbBoot = await afterWipe.loadLiveBoot();
  check(idbBoot.provider?.id === 'p1', 'a szolgáltató visszajön az IndexedDB-ből');
  check(idbBoot.channels.length >= 400, 'a kezdőképernyő csatornái visszajönnek az IndexedDB-ből (letöltés nélkül)', String(idbBoot.channels.length));
  check(idbBoot.categories.length === 121, 'a kategóriák (országok) is visszajönnek az IndexedDB-ből', String(idbBoot.categories.length));
  check(idbBoot.totals.live === 20_000, 'a fejléc a VALÓDI darabszámot mondja az IndexedDB-ből', JSON.stringify(idbBoot.totals));
  check(idbBoot.pendingFull === true, 'jelzi, hogy a teljes lista háttérben betölthető');
  const restored = await afterWipe.loadLiveFull();
  check(restored?.channels.length === 20_000, 'a TELJES lista is megvan – újratöltés nélkül', String(restored?.channels.length));
  const report = await afterWipe.describeStoredContent();
  check(report.liveLocal === 0 && report.liveIdb === 20_000, 'a tároló-jelentés megmondja, hol van a katalógus', JSON.stringify(report));

  /* ============ 6. TAKARÍTÁS ÉS TÖRLÉS ================================== */
  await afterWipe.saveLiveContentAsync(content);
  await settle();
  localStorageFake.setItem('iptv_rt_content-live-chunk-v1-0-0-9', JSON.stringify({ rows: [['x']] }));
  const removed = afterWipe.sweepStorage();
  check(removed >= 1, 'a takarítás törölte az elárvult adagot', String(removed));
  check(!localStorageFake._dump()['iptv_rt_content-live-chunk-v1-0-0-9'], 'az elárvult adag tényleg eltűnt');
  check(afterWipe.loadLive().channels.length === 150, 'a takarítás nem érintette az érvényes listát',
    String(afterWipe.loadLive().channels.length));

  // Régi (átállás előtti) fejléc: nincs `boot` mező – ilyenkor kell a kicsinyítés.
  const legacyMeta = JSON.parse(localStorageFake._dump()['iptv_rt_content-live-meta']);
  delete legacyMeta.boot;
  localStorageFake.setItem('iptv_rt_content-live-meta', JSON.stringify(legacyMeta));
  check(afterWipe.needsLiveCacheCompaction() === true, 'a régi formátumú fejlécet egyszer átállítja');

  afterWipe.clearContent();
  await settle();
  check(afterWipe.loadLive().channels.length === 0, 'törlés után üres a localStorage-os lista');
  check((await afterWipe.loadLiveFull()) === null, 'törlés után üres az IndexedDB is');
  check(afterWipe.readSummary() === null, 'törlés után nincs összegzés');
} catch (error) {
  failed = true;
  checks.push(`HIBA – a teszt lefutása közben hiba történt: ${error?.stack || error}`);
}

for (const line of checks) console.log(line);
const bad = checks.filter((line) => line.startsWith('HIBA')).length;
console.log(`\n${checks.length - bad}/${checks.length} ellenőrzés sikeres.`);
if (failed || bad > 0) {
  console.error('\nA tároló-teszt NEM futott át. ❌');
  process.exit(1);
}
console.log('A tároló-teszt minden ellenőrzése átment. ✅');
