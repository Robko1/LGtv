/**
 * IndexedDB-alapú, TARTÓS tároló a NAGY listáknak (csatornák, filmek, sorozatok).
 *
 * MIÉRT KELL.
 *
 * A localStorage a webOS-on ~5,2 millió karakter. A három lista viszont
 * együtt több tíz millió:
 *
 *   élő      20 190 csatorna × ~190 karakter ≈  3,8 MB
 *   film    102 824 film    × ~180 karakter ≈ 18,5 MB
 *   sorozat  24 974 sorozat × ~170 karakter ≈  4,2 MB
 *
 * Ezért a teljes katalógus IndexedDB-be kerül, ahol a kvóta nagyságrendekkel
 * nagyobb. A 2.5.126-os TV-napló azt mutatta, hogy a mentés soha nem ért véget:
 * a webOS az import alatt (67 mp) lezárta az adatbázis-kapcsolatot, a régi
 * kód viszont egyetlen, halott `IDBDatabase` példányt használt tovább. Az
 * írások így vagy kivétellel elestek, vagy (ami rosszabb) egy olyan kérésre
 * vártak, ami soha nem jött vissza – a fejléc ezért NEM íródott ki, és a
 * következő indulás üres tárolót talált: jöhetett a teljes újratöltés.
 *
 * A referencia (lennylxx/webos-iptv-player, idb-database.ts) elveit alkalmazzuk:
 *   • a kapcsolatot a rendszer bármikor bezárhatja (`onclose` / `onversionchange`);
 *     ilyenkor a gyorsítótárat ÉRVÉNYTELENÍTJÜK, és a következő hívás újra nyit;
 *   • egy sikertelen/timeoutos megnyitás NEM végleges: a következő írás újra próbálja;
 *   • minden műveletnek van időkorlátja, így egy „néma” kérés nem lógathatja
 *     a mentést örökké;
 *   • a gyorsítótár-írások EGY TRANZAKCIÓBA kerülnek (idb-cache.ts elve):
 *     kevesebb tranzakció = gyorsabb mentés, és a fejléc ugyanabban az
 *     atomi lépésben íródik, mint az adagok.
 *
 * Ezen felül a tárolót TARTÓSSÁ tesszük: `navigator.storage.persist()` (illetve
 * régi webOS-on `webkitPersistentStorage.requestQuota`) meghívásával a böngésző
 * nem dobhatja el az adatbázist, amikor az alkalmazást bezárják. Ha a kért
 * kapacitás nem lenne elég, a contentStore a kvóta alapján takarít (ld. ott).
 */

const DB_NAME = 'iptv_rt_content';
const DB_VERSION = 1;
const STORE_NAME = 'chunks';

/** A megnyitás és az egyes kérések időkorlátai (ms). */
const OPEN_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 12000;
/** Ennyi adag mehet egy tranzakcióba (nagy listáknál is rövid tranzakciók). */
export const IDB_BATCH_SIZE = 12;

export interface ChunkEntry {
  key: string;
  value: string;
}

/** Aszinkron kulcs-érték tár (IndexedDB). */
export interface ChunkStore {
  /** A naplóban megjelenő név. */
  name: string;
  put(key: string, value: string): Promise<boolean>;
  /** Több bejegyzés EGY tranzakcióban. A fejlécet mindig UTOLSÓKÉNT kell adni. */
  putMany(entries: ChunkEntry[]): Promise<boolean>;
  get(key: string): Promise<string>;
  remove(key: string): Promise<void>;
  removeMany(keys: string[]): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export interface DurableStorageInfo {
  /** A böngésző engedélyezte a tartós (nem eviktálható) tárolót. */
  persisted: boolean;
  /** Becsült kvóta bájtban, ha a böngésző megadta. */
  quotaBytes: number | null;
  /** Becsült felhasználás bájtban, ha a böngésző megadta. */
  usageBytes: number | null;
  /** A tartósság-kérés módja (naplóhoz). */
  method: string;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let storePromise: Promise<ChunkStore | null> | null = null;
/** Megakadályozza, hogy egy régi kapcsolat `onclose` eseménye egy újat érvénytelenítsen. */
let openGeneration = 0;
let durablePromise: Promise<DurableStorageInfo> | null = null;
const resetListeners = new Set<() => void>();
/** Teszteknek: ilyenkor nincs szükség 8 mp-es időkorlátra sem. */
let timeoutScale = 1;

/** Értesítés, amikor a kapcsolat megszűnt: a tartalmi modul eldobhatja a gyorsítótárat. */
export function onIdbStoreReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => { resetListeners.delete(listener); };
}

function invalidate(generation?: number): void {
  if (generation !== undefined && generation !== openGeneration) return;
  dbPromise = null;
  storePromise = null;
  for (const listener of resetListeners) {
    try { listener(); } catch { /* egy hallgató hibája nem akadályozhat másokat */ }
  }
}

/** Csak a teszteknek: a megnyitás újrapróbálhatóvá tétele. */
export function resetIdbStoreForTests(scale = 1): void {
  timeoutScale = scale;
  openGeneration++;
  dbPromise = null;
  storePromise = null;
  durablePromise = null;
  resetListeners.clear();
}

function storageManager(): any {
  try {
    return typeof navigator !== 'undefined' ? (navigator as any).storage || null : null;
  } catch {
    return null;
  }
}

/**
 * TARTÓS TÁROLÓ – automatikus kapacitásigénylés.
 *
 * A webOS alapból „best effort” (eviktálható) tárolót ad: az alkalmazás
 * bezárása után a böngésző eldobhatja az IndexedDB-t. A `persist()` ezt
 * megakadályozza, és a kvótát is a kért méretre emeli. Régebbi webOS-okon a
 * `webkitPersistentStorage.requestQuota` az egyetlen elérhető út. Mindkettő
 * teljesen háttérben fut: az első képkockát nem váratja meg.
 */
export function ensureDurableStorage(): Promise<DurableStorageInfo> {
  if (durablePromise) return durablePromise;
  durablePromise = (async (): Promise<DurableStorageInfo> => {
    const info: DurableStorageInfo = {
      persisted: false, quotaBytes: null, usageBytes: null, method: 'nem elérhető',
    };
    const manager = storageManager();
    try {
      if (manager && typeof manager.persist === 'function') {
        info.method = 'StorageManager.persist';
        const already = typeof manager.persisted === 'function' ? await manager.persisted() : false;
        info.persisted = already === true || (await manager.persist()) === true;
      } else {
        const legacy = typeof navigator !== 'undefined'
          ? (navigator as any).webkitPersistentStorage : null;
        if (legacy && typeof legacy.requestQuota === 'function') {
          info.method = 'webkitPersistentStorage.requestQuota';
          // 256 MB bőven elég a ~30 MB-os katalógusnak és a jövőbeli növekedésnek.
          info.persisted = await new Promise<boolean>((resolve) => {
            let done = false;
            const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
            try {
              legacy.requestQuota(256 * 1024 * 1024, () => finish(true), () => finish(false));
            } catch { finish(false); }
            setTimeout(() => finish(false), 3000);
          });
        }
      }
    } catch { /* a tartósság-kérés hibája nem akadályozza a tárolást */ }
    try {
      const estimate = manager && typeof manager.estimate === 'function' ? await manager.estimate() : null;
      if (estimate) {
        info.quotaBytes = typeof estimate.quota === 'number' ? estimate.quota : null;
        info.usageBytes = typeof estimate.usage === 'number' ? estimate.usage : null;
      }
    } catch { /* a kvóta-olvasás nem kritikus */ }
    // Ha a böngésző nem ad kvótát, feltételezzük a referenciában használt
    // konzervatív keretet (idb-cache.ts: FALLBACK_BUDGET_BYTES).
    return info;
  })();
  return durablePromise;
}

/** A rendelkezésre álló keret (bájt). A contentStore ebből dönt a takarításról. */
export async function storageBudgetBytes(): Promise<{ quotaBytes: number | null; usageBytes: number | null }> {
  const info = await ensureDurableStorage();
  const fallbackQuota = info.quotaBytes === null ? 384 * 1024 * 1024 : info.quotaBytes;
  // A referenciához hasonlóan a kvóta felét használjuk a gyorsítótárra.
  return { quotaBytes: Math.min(Math.floor(fallbackQuota * 0.5), 1024 * 1024 * 1024), usageBytes: info.usageBytes };
}

/** Az IndexedDB megnyitása – ÚJRAPRÓBÁLHATÓAN. */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const generation = ++openGeneration;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    // A `finish` a megnyitás ELŐTT is meghívódhat (nincs indexedDB), ezért a
    // timer változóját már itt deklaráljuk – különben TDZ ReferenceError.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (db: IDBDatabase | null, failed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // A hibás megnyitás NEM végleges: a következő olvasás/írás újra próbálja.
      if (failed) invalidate(generation);
      resolve(db);
    };
    const factory = typeof indexedDB !== 'undefined' ? indexedDB : null;
    if (!factory) { finish(null, true); return; }
    timer = setTimeout(() => finish(null, true), OPEN_TIMEOUT_MS * timeoutScale);
    try {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        // A webOS háttérbe tevéskor saját maga zárja be a kapcsolatot. Ilyenkor
        // a következő műveletnek ÚJRA KELL nyitnia – különben minden írás
        // „The database connection is closing” hibával elvész (ld. referencia).
        database.onversionchange = () => {
          try { database.close(); } catch { /* már zárva */ }
          invalidate(generation);
        };
        database.onclose = () => invalidate(generation);
        finish(database, false);
      };
      request.onerror = () => finish(null, true);
      request.onblocked = () => finish(null, true);
    } catch {
      finish(null, true);
    }
  });
  return dbPromise;
}

/** Egy művelet időkorlátja – a „néma” kérés nem lógathatja a mentést örökké. */
function withDeadline<T>(promise: Promise<T>, onTimeout: () => void, ms = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      onTimeout();
      reject(new Error('IndexedDB kérés időtúllépése'));
    }, ms * timeoutScale);
    promise.then(
      (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } },
      (error) => { if (!done) { done = true; clearTimeout(timer); reject(error); } },
    );
  });
}

function createStore(): ChunkStore {
  /** Egy tranzakció, egy kérés. */
  const run = <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const generation = openGeneration;
    return withDeadline(
      (async () => {
        const db = await openDb();
        if (!db) throw new Error('IndexedDB nem elérhető');
        return await new Promise<T>((resolve, reject) => {
          let transaction: IDBTransaction;
          try { transaction = db.transaction(STORE_NAME, mode); }
          catch (error) { reject(error); return; }
          const request = action(transaction.objectStore(STORE_NAME));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          transaction.onabort = () => reject(transaction.error);
        });
      })(),
      () => invalidate(generation),
    );
  };

  /**
   * TÖBB KULCS EGY TRANZAKCIÓBAN.
   *
   * A valódi IndexedDB a tranzakció `oncomplete` eseményénél jelzi, hogy az
   * adat TÉNYLEGESEN a lemezre került. A régi webOS-ok (és a tesztkörnyezet
   * egyszerűsített IDB-je) ezt nem mindig adják ki: ilyenkor az utolsó kérés
   * sikerére támaszkodunk. A fejlécet a hívó mindig UTOLSÓKÉNT adja át, így
   * egy félbeszakadt mentésnél a régi, érvényes fejléc marad a tárolóban.
   */
  const runMany = (
    entries: ChunkEntry[],
    mode: 'put' | 'delete',
  ): Promise<boolean> => withDeadline(
    (async () => {
      const db = await openDb();
      if (!db) return false;
      return await new Promise<boolean>((resolve) => {
        let transaction: IDBTransaction;
        let objectStore: IDBObjectStore;
        try {
          transaction = db.transaction(STORE_NAME, 'readwrite');
          objectStore = transaction.objectStore(STORE_NAME);
        } catch {
          resolve(false);
          return;
        }
        let settled = false;
        let remaining = entries.length;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          if (!ok) invalidate();
          resolve(ok);
        };
        const supportsCompletion = 'oncomplete' in transaction;
        if (supportsCompletion) transaction.oncomplete = () => finish(true);
        transaction.onerror = () => finish(false);
        transaction.onabort = () => finish(false);
        for (const entry of entries) {
          const request = mode === 'put'
            ? objectStore.put(entry.value, entry.key)
            : objectStore.delete(entry.key);
          request.onsuccess = () => {
            remaining -= 1;
            if (!supportsCompletion && remaining <= 0) finish(true);
          };
          request.onerror = () => finish(false);
        }
        if (entries.length === 0) finish(true);
      });
    })(),
    () => invalidate(),
    REQUEST_TIMEOUT_MS * 2,
  );

  const swallow = <T>(promise: Promise<T>, fallback: T): Promise<T> =>
    promise.catch(() => fallback);

  return {
    name: 'idb',
    async put(key, value) {
      return await swallow(run('readwrite', (store) => store.put(value, key)).then(() => true), false);
    },
    async putMany(entries) {
      if (!entries.length) return true;
      return await runMany(entries, 'put');
    },
    async get(key) {
      return await swallow(
        run<string | undefined>('readonly', (store) => store.get(key))
          .then((value) => (typeof value === 'string' ? value : '')),
        '',
      );
    },
    async remove(key) {
      await swallow(run('readwrite', (store) => store.delete(key)), undefined);
    },
    async removeMany(keys) {
      if (!keys.length) return;
      await runMany(keys.map((key) => ({ key, value: '' })), 'delete');
    },
    async keys() {
      // A régebbi webOS Chromiumja még nem ismeri a getAllKeys()-t: kurzorral
      // soroljuk fel ilyenkor, hogy a régi generációk ne maradjanak bent.
      if (typeof IDBObjectStore !== 'undefined' && 'getAllKeys' in IDBObjectStore.prototype) {
        try {
          const keys = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
          return keys.map((key) => String(key));
        } catch { /* jön a kurzoros út */ }
      }
      return await withDeadline((async () => {
        const db = await openDb();
        if (!db) return [];
        return await new Promise<string[]>((resolve) => {
          const found: string[] = [];
          try {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const request = transaction.objectStore(STORE_NAME).openCursor();
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) { resolve(found); return; }
              found.push(String(cursor.key));
              cursor.continue();
            };
            request.onerror = () => resolve(found);
            transaction.onabort = () => resolve(found);
          } catch { resolve(found); }
        });
      })(), () => invalidate());
    },
    async clear() {
      await swallow(run('readwrite', (store) => store.clear()), undefined);
    },
  };
}

/** Az IndexedDB megnyitása – egyszer, de újranyithatóan. */
export function openIdbStore(): Promise<ChunkStore | null> {
  if (!storePromise) {
    const attempt = openDb().then((db) => (db ? createStore() : null));
    storePromise = attempt;
    // Egy sikertelen megnyitás NEM végleges: a következő olvasás/írás újra
    // próbálkozik (a webOS gyakran csak második próbára adja meg a kapcsolatot).
    attempt.then((store) => { if (!store && storePromise === attempt) storePromise = null; });
    attempt.catch(() => { if (storePromise === attempt) storePromise = null; });
  }
  return storePromise;
}

/** A naplózáshoz: elérhető-e az IndexedDB (aszinkron, ezért külön). */
export async function describeIdbStore(): Promise<string> {
  const [store, info] = await Promise.all([openIdbStore(), ensureDurableStorage()]);
  const quota = info.quotaBytes ? ` ${(info.quotaBytes / 1024 / 1024).toFixed(0)} MB kvóta` : '';
  return store
    ? `IndexedDB elérhető; tartós=${info.persisted ? 'igen' : 'nem'}; mód=${info.method}${quota}`
    : 'IndexedDB nem elérhető – kis listák localStorage tartalékkal';
}
