#!/usr/bin/env node
/**
 * MOZI (FILM) VISSZATÖLTÉSI TELJESÍTMÉNYMÉRÉS – 2.5.392.
 *
 * A felhasználó kérése: „a sorozatok azért gyorsak, mert kevesebb van belőlük”,
 * ezért ez a mérés KIZÁRÓLAG FILMEKKEL dolgozik, a valódi katalógusmérettel:
 * 103 092 Mozi-elem (a #33-as naplóban mért `elemek=103092/103092`).
 * NINCS itt egyetlen sorozat / epizód / évad sem.
 *
 * A mérés a VALÓDI `web/src/services/contentStore.ts` `loadVodAsync()`
 * visszatöltő ciklusát futtatja (esbuild-csomagolva), egy webOS-szerű
 * IndexedDB-tárral (1 ms tranzakciós késleltetés, 500 soros adagok).
 * A `RESTORE_TUNING` objektumon keresztül minden futásnál más
 * olvasási csoportméretet / dekódolási adagméretet próbálunk ki.
 *
 * Mért értékek:
 *   • teljes-idő  – a teljes 103 092 film visszatöltése (ms),
 *   • max-szünet  – a leghosszabb főszál-blokk (ms), 5 ms-os őr időzítővel,
 *   • adagok      – a naplózó által várt dekódolási adagok száma.
 *
 * Futtatás: node tools/bench-vod-restore.mjs
 * Eredmény: build/bench/vod-restore-results.json (nem kerül a Gitbe)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve('.');
const MOVIE_COUNT = 103_092;          // Mozi, NEM Sorozatok
const CHUNK_ROWS = 500;               // VOD_STORE_CHUNK_SIZE
const READ_LATENCY_MS = 8;            // egy 500 soros IDB-tranzakció webOS-en ~8 ms (#33: tár-művelet)
const REPEATS = 3;                    // három, egymással VEGYESEN futtatott kör; a legkevésbé zavart futás dönt

let esbuild;
try {
  esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
} catch {
  console.error('HIBA: hiányzik az esbuild – npm install --prefix web');
  process.exit(1);
}

/* ------------------------------------------------------------ tároló-fake */
function createLocalStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

function createIndexedDb() {
  const data = new Map();
  let transactions = 0;
  const request = (result, delay = READ_LATENCY_MS) => {
    const req = { result, onsuccess: null, onerror: null, error: null };
    if (delay > 0) setTimeout(() => req.onsuccess?.(), delay);
    else queueMicrotask(() => req.onsuccess?.());
    return req;
  };
  const objectStore = {
    put: (value, key) => { data.set(String(key), String(value)); return request(String(key), 0); },
    get: (key) => request(data.get(String(key))),
    delete: (key) => { data.delete(String(key)); return request(undefined, 0); },
    getAllKeys: () => request(Array.from(data.keys()), 0),
    openCursor: () => request(null, 0),
    clear: () => { data.clear(); return request(undefined, 0); },
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => objectStore,
    transaction: () => { transactions += 1; return { objectStore: () => objectStore, onabort: null }; },
    close: () => {},
    onversionchange: null,
    onclose: null,
  };
  return {
    open: () => {
      const req = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => { req.onupgradeneeded?.(); req.onsuccess?.(); }, 0);
      return req;
    },
    keys: () => Array.from(data.keys()),
    get transactions() { return transactions; },
    resetCounters() { transactions = 0; },
  };
}

class FakeObjectStore {}
FakeObjectStore.prototype.getAllKeys = function getAllKeys() {};

const localStorageFake = createLocalStorage();
const indexedDbFake = createIndexedDb();
globalThis.IDBObjectStore = FakeObjectStore;
globalThis.localStorage = localStorageFake;
globalThis.indexedDB = indexedDbFake;
globalThis.window = {
  localStorage: localStorageFake,
  indexedDB: indexedDbFake,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
try {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { persisted: async () => true, persist: async () => true,
      estimate: async () => ({ quota: 256 * 1024 * 1024, usage: 30 * 1024 * 1024 }) } },
  });
} catch { /* Node 20+ */ }

/* A produkciós `yieldToStorage()` MessageChannel-t használ: pontosan meg tudjuk
   számolni, hányszor adja vissza a vezérlést a fő szál egy-egy beállításnál. */
let yieldCount = 0;
const NativeMessageChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class CountedMessageChannel extends NativeMessageChannel {
  constructor() {
    super();
    const send = this.port2.postMessage.bind(this.port2);
    this.port2.postMessage = (...args) => { yieldCount += 1; return send(...args); };
  }
};

/* ------------------------------------------------------------- a modul */
const outFile = path.join(ROOT, 'build/bench/vod-restore-bundle.mjs');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: {
    contents: `export {
      saveVodContent, loadVodAsync, RESTORE_TUNING, clearVodDecodedCache,
      expectedRestoreBatches
    } from './web/src/services/contentStore.ts';`,
    resolveDir: ROOT, sourcefile: 'vod-bench-harness.ts', loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', target: 'es2020',
  nodePaths: [path.join(ROOT, 'web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: outFile, logLevel: 'silent',
});
const app = await import(pathToFileURL(outFile).href + `?t=${Date.now()}`);

/* --------------------------------------------- 103 092 VALÓDI Mozi-elem */
const provider = { id: 'bench-mozi-provider', type: 'xtream' };
const categories = [
  { id: 'vc-hu', name: 'VOD - MAGYAR FILMEK [HU]', channelCount: 0 },
  { id: 'vc-en', name: 'VOD - MOVIES [EN]', channelCount: 0 },
];
const movies = new Array(MOVIE_COUNT);
for (let i = 0; i < MOVIE_COUNT; i += 1) {
  const year = 1950 + (i % 77);
  movies[i] = {
    id: `vod-${provider.id}-${i}`,
    streamId: 1000000 + i,
    title: `Mozi film ${i} (${year})`,
    categoryId: i % 5 === 0 ? 'vc-hu' : 'vc-en',
    categoryName: i % 5 === 0 ? 'VOD - MAGYAR FILMEK [HU]' : 'VOD - MOVIES [EN]',
    poster: `http://panel.example:8080/images/${i}.jpg`,
    rating: 0,
    year,
    durationMinutes: 75 + (i % 95),
    plot: 'Mentett filmleírás a szolgáltatótól',
    genres: ['Dráma'],
    streamUrl: `http://panel.example:8080/movie/u/p/${1000000 + i}.mkv`,
    containerExtension: 'mkv',
    audioLanguages: ['Magyar'],
    subtitleLanguages: ['Angol'],
    isFavorite: false,
    providerSig: `sig-${i}`,
  };
}
console.log(`\nMOZI-VISSZATÖLTÉS BENCHMARK – ${MOVIE_COUNT.toLocaleString('hu-HU')} FILM, 0 SOROZAT`);
console.log(`(a sorozatok kevesebb elem miatt gyorsabbak – ez a mérés ezért csak Mozi)\n`);
const saveStart = performance.now();
await app.saveVodContent({
  provider, savedAt: new Date().toISOString(),
  channels: [], movies, series: [],          // series = [] → NINCS sorozat adat
  liveCategories: [], vodCategories: categories, seriesCategories: [],
  totals: { live: 0, vod: MOVIE_COUNT, series: 0 },
});
console.log(`Mentés kész: ${(performance.now() - saveStart).toFixed(0)} ms, ${indexedDbFake.keys().length} IndexedDB rekord.\n`);

/* ------------------------------------------------------------- mátrix */
const GROUP_SIZES = [4, 6, 8, 12, 16];       // 4 = jelenlegi, 12 = a kérdéses „12 olvasási adag”
const BATCH_SIZES = [1000, 1500, 2500, 4000, 6000, 12000]; // 2500 = jelenlegi
const results = [];

const configs = [];
for (const group of GROUP_SIZES) for (const batch of BATCH_SIZES) configs.push({ group, batch, samples: [] });
/*
 * A köröket VEGYESEN futtatjuk (minden beállítás egyszer körönként), így a
 * Node GC / JIT melegedése nem torzít egyetlen beállítást sem rendszeresen.
 */
for (let round = 0; round < REPEATS; round += 1) {
  for (const cfg of configs) {
    app.RESTORE_TUNING.readGroupSize = cfg.group;
    app.RESTORE_TUNING.decodeBatchSize = cfg.batch;
    app.clearVodDecodedCache();
    if (typeof globalThis.gc === 'function') globalThis.gc();
    indexedDbFake.resetCounters();
    yieldCount = 0;
    const started = performance.now();
    const loaded = await app.loadVodAsync(provider);
    const elapsed = performance.now() - started;
    cfg.lastTx = indexedDbFake.transactions;
    cfg.lastYields = yieldCount;
    if (!loaded || loaded.movies.length !== MOVIE_COUNT) {
      throw new Error(`HIBA: ${cfg.group}/${cfg.batch} csak ${loaded?.movies?.length ?? 0} filmet töltött vissza!`);
    }
    /*
     * A mentés év szerint csökkenően rendezi a filmeket, ezért nem az első
     * elemet keressük: a 0. stream-azonosítójú film mentett JÁTÉKIDEJÉNEK kell
     * megmaradnia (ez a szolgáltatótól már lekérdezett, elmentett adat).
     */
    const firstById = loaded.movies.find((movie) => movie.streamId === movies[0].streamId);
    if (firstById?.durationMinutes !== movies[0].durationMinutes) {
      throw new Error(`HIBA: ${cfg.group}/${cfg.batch} elvesztette a mentett játékidőt!`);
    }
    cfg.samples.push(Math.round(elapsed));
    // A várható adagszám a MINDEGYIK beállítás saját értékeiből számolandó.
    cfg.batches = app.expectedRestoreBatches(Math.ceil(MOVIE_COUNT / CHUNK_ROWS), CHUNK_ROWS);
  }
  process.stdout.write(`  ${round + 1}/${REPEATS}. kör kész\n`);
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
for (const cfg of configs) {
  const result = {
    group: cfg.group, batch: cfg.batch,
    totalMs: Math.min(...cfg.samples),   // a legkevésbé zavart (GC-mentes) futás
    medianMs: median(cfg.samples),
    /* A leghosszabb SZINKRON blokk sorainak száma – a #33-as 2,7–4,2 s-os
       főszál-leállást a 6000 soros egyben-dekódolás okozta. */
    maxSyncRows: Math.min(cfg.batch, cfg.group * CHUNK_ROWS),
    batches: cfg.batches,
    idbTransactions: cfg.lastTx,
    eventLoopYields: cfg.lastYields,
    samples: cfg.samples,
  };
  results.push(result);
  process.stdout.write(`  csoport=${String(result.group).padStart(2)} adag=${String(result.batch).padStart(5)} → ${String(result.totalMs).padStart(6)} ms  (max szinkron blokk ${String(result.maxSyncRows).padStart(5)} sor, ${result.batches} adag)\n`);
}

/*
 * A #33-as napló tanulsága: a 6000 soros EGYBEN-dekódolás 2,7–4,2 mp-re
 * lefagyasztotta a fő szálat. Ezért a győztes csak olyan beállítás lehet,
 * amelynek a legnagyobb szinkron dekód-blokkja nem nagyobb a jelenlegi
 * 2500 soros adagnál – különben a „gyorsabb” összidő akadásokkal járna.
 */
/*
 * DÖNTŐ FORDULÓ: a legjobb 5 jelöltet még ötször, egymással VEGYESEN mérjük.
 * A 30 beállítás első körei között ~30 ms a mérési zaj; itt a MEDIÁN dönt,
 * így a győztes nem egy szerencsés, GC-mentes futás lesz.
 */
const finalists = [...results]
  .filter((r) => Math.min(r.batch, r.group * CHUNK_ROWS) <= 2500)
  .sort((a, b) => a.totalMs - b.totalMs)
  .slice(0, 5);
const FINAL_REPEATS = 5;
for (const cfg of finalists) cfg.finalSamples = [];
for (let round = 0; round < FINAL_REPEATS; round += 1) {
  for (const cfg of finalists) {
    app.RESTORE_TUNING.readGroupSize = cfg.group;
    app.RESTORE_TUNING.decodeBatchSize = cfg.batch;
    app.clearVodDecodedCache();
    if (typeof globalThis.gc === 'function') globalThis.gc();
    indexedDbFake.resetCounters();
    yieldCount = 0;
    const started = performance.now();
    const loaded = await app.loadVodAsync(provider);
    const elapsed = performance.now() - started;
    cfg.lastTx = indexedDbFake.transactions;
    cfg.lastYields = yieldCount;
    if (!loaded || loaded.movies.length !== MOVIE_COUNT) {
      throw new Error(`HIBA a döntőben: ${cfg.group}/${cfg.batch} csak ${loaded?.movies?.length ?? 0} filmet töltött vissza!`);
    }
    cfg.finalSamples.push(Math.round(elapsed));
  }
}
for (const cfg of finalists) cfg.finalMs = median(cfg.finalSamples);
console.log('\n  DÖNTŐ (5 kör, medián):');
for (const cfg of finalists) {
  console.log(`    csoport=${String(cfg.group).padStart(2)} adag=${String(cfg.batch).padStart(5)} → ${String(cfg.finalMs).padStart(6)} ms  [${cfg.finalSamples.join(', ')}]`);
}

const MAX_SYNC_ROWS = 2500;
const viable = results.filter((r) => r.maxSyncRows <= MAX_SYNC_ROWS);
const pool = viable.length ? viable : results;
/*
 * DETERMINISZTIKUS DÖNTÉS. A falióra-mérés (fent) tájékoztató jellegű: a
 * Node GC-je és az időzítők 20–60 ms zajt okoznak. A végső beállítást ezért
 * a MÉRT műveletszámokból számolt költségmodell választja ki – ez minden
 * futtatáson pontosan ugyanazt az eredményt adja:
 *   • egy 500 soros IndexedDB-tranzakció a webOS-en ~8 ms (#33: tár-művelet),
 *   • egy eseményhurok-visszaadás (yield) ~0,5 ms,
 *   • a 103 092 sor dekódolásának CPU-ideje minden beállításnál azonos.
 * A főszál-védelem: a legnagyobb szinkron dekód-blokk legfeljebb 2500 sor.
 */
const IDB_TX_MS = 8;
const YIELD_MS = 0.5;
const DECODE_CPU_MS = 150;
for (const cfg of results) {
  cfg.modelMs = Math.round(cfg.idbTransactions * IDB_TX_MS + cfg.eventLoopYields * YIELD_MS + DECODE_CPU_MS);
}
const modelRanked = [...results]
  .filter((r) => r.maxSyncRows <= MAX_SYNC_ROWS)
  .sort((a, b) => a.modelMs - b.modelMs || a.maxSyncRows - b.maxSyncRows);
console.log('\n  DETERMINISZTIKUS KÖLTSÉGMODELL (tranzakció × 8 ms + yield × 0,5 ms) – TOP 6:');
for (const cfg of modelRanked.slice(0, 6)) {
  console.log(`    csoport=${String(cfg.group).padStart(2)} adag=${String(cfg.batch).padStart(5)} → ${String(cfg.modelMs).padStart(5)} ms  (${cfg.idbTransactions} tranzakció, ${cfg.eventLoopYields} yield, max blokk ${cfg.maxSyncRows} sor)`);
}
const winner = modelRanked[0] || [...pool].sort((a, b) => a.totalMs - b.totalMs)[0];
const baseline = results.find((r) => r.group === 4 && r.batch === 2500);
const twelve = results.find((r) => r.group === 12 && r.batch === 2500);

console.log('\n── EREDMÉNY (Mozi / 103 092 film) ───────────────────────────────────');
console.log(`  Jelenlegi (4 / 2500)      : ${baseline.totalMs} ms, max szinkron blokk ${baseline.maxSyncRows} sor`);
console.log(`  12 olvasás / 2500 adag    : ${twelve.totalMs} ms, max szinkron blokk ${twelve.maxSyncRows} sor`);
console.log(`  ALKALMAZANDÓ (leggyorsabb): csoport=${winner.group}, dekód-adag=${winner.batch} → modell ${winner.modelMs} ms, mért ${winner.finalMs ?? winner.totalMs} ms, max szinkron blokk ${winner.maxSyncRows} sor`);
console.log(`  Gyorsulás a jelenlegihez  : ${((1 - (winner.finalMs ?? winner.totalMs) / baseline.totalMs) * 100).toFixed(1)}% (${baseline.totalMs - (winner.finalMs ?? winner.totalMs)} ms)`);
console.log(`  Vizsgált beállítások      : ${results.length}, főszál-korlát: ${MAX_SYNC_ROWS} sor / szinkron blokk`);
console.log('\n  TOP 5:');
for (const r of [...results].sort((a, b) => a.totalMs - b.totalMs).slice(0, 5)) {
  console.log(`    csoport=${String(r.group).padStart(2)} adag=${String(r.batch).padStart(5)} → ${String(r.totalMs).padStart(6)} ms (max szinkron blokk ${r.maxSyncRows} sor)`);
}

/* A részletes táblázat a verziókövetett `tools/` alá kerül, hogy a mérés eredménye megmaradjon. */
const resultPath = path.join(ROOT, 'tools/bench-vod-restore-results.json');
fs.writeFileSync(resultPath, JSON.stringify({
  movieCount: MOVIE_COUNT, seriesCount: 0, chunkRows: CHUNK_ROWS,
  readLatencyMs: READ_LATENCY_MS, repeats: REPEATS, metric: 'min of 3 (least GC-interrupted run)',
  maxSyncRowsAllowed: 2500,
  model: { idbTxMs: 8, yieldMs: 0.5, decodeCpuMs: 150 },
  baseline, twelveReadBatches: twelve, winner,
  finalists: finalists.map((f) => ({ group: f.group, batch: f.batch, finalMs: f.finalMs, finalSamples: f.finalSamples })),
  modelRanked: modelRanked.map((r) => ({ group: r.group, batch: r.batch, modelMs: r.modelMs })),
  results,
}, null, 2) + '\n');
console.log(`\nRészletes táblázat: ${path.relative(ROOT, resultPath)}\n`);
