/**
 * IndexedDB-alapú tároló a NAGY listáknak (filmek, sorozatok).
 *
 * MIÉRT KELL.
 *
 * Az 1-es TV-napló (2.5.114) pontosan megmutatta a falat:
 *
 *   TÁROLÓ HIBA: content-vod-chunk-v2-…-5-72 mentése végleg sikertelen (local);
 *                foglaltság=75 kulcs / 5115 kB
 *   Sorozatlista: egyetlen adag sem menthető el – a tároló megtelt
 *                 (38 adag, 15000 elem).
 *
 * A localStorage a webOS-on ~5,2 millió karakter. A három lista viszont
 * együtt ~13,5 millió:
 *
 *   élő      20 190 csatorna × ~190 karakter ≈  3,8 M
 *   film     40 000 film    × ~177 karakter ≈  7,1 M
 *   sorozat  15 000 sorozat × ~172 karakter ≈  2,6 M
 *
 * Ezért a filmek és a sorozatok SOHA nem fértek be, és a mentésük hibája
 * miatt az egész betöltés „BETÖLTÉSI HIBA”-ként jelent meg.
 *
 * A megoldás: az élő lista marad a localStorage-ban (azt az indulásnál
 * SZINKRON kell olvasni, lásd `loadLive()`), a két nagy lista pedig
 * IndexedDB-be kerül, ahol a kvóta nagyságrendekkel nagyobb.
 *
 * Ha a TV-n az IndexedDB nem elérhető (régi webOS, tiltott file:// origin),
 * a függvény `null`-t ad vissza, és a hívó a korábbi localStorage-os útra
 * vált vissza – vagyis semmi nem romlik el, csak marad a régi viselkedés.
 */

const DB_NAME = 'iptv_rt_content';
const DB_VERSION = 1;
const STORE_NAME = 'chunks';

/** Aszinkron kulcs-érték tár (IndexedDB vagy memória). */
export interface ChunkStore {
  /** A naplóban megjelenő név. */
  name: string;
  put(key: string, value: string): Promise<boolean>;
  get(key: string): Promise<string>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

let openPromise: Promise<ChunkStore | null> | null = null;

function createStore(db: IDBDatabase): ChunkStore {
  const run = <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> => new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(STORE_NAME, mode);
    } catch (error) {
      reject(error);
      return;
    }
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error);
  });

  return {
    name: 'idb',
    async put(key, value) {
      try {
        await run('readwrite', (store) => store.put(value, key));
        return true;
      } catch {
        return false;
      }
    },
    async get(key) {
      try {
        const value = await run<string | undefined>('readonly', (store) => store.get(key));
        return typeof value === 'string' ? value : '';
      } catch {
        return '';
      }
    },
    async remove(key) {
      try {
        await run('readwrite', (store) => store.delete(key));
      } catch {
        /* a törlés hibája nem akadályozhatja a mentést */
      }
    },
    async keys() {
      // A régebbi webOS Chromiumja még nem ismeri a getAllKeys()-t: kurzorral
      // soroljuk fel ilyenkor, hogy a régi generációk ne maradjanak bent.
      if (typeof IDBObjectStore !== 'undefined' && 'getAllKeys' in IDBObjectStore.prototype) {
        try {
          const keys = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
          return keys.map((key) => String(key));
        } catch {
          /* jön a kurzoros út */
        }
      }
      return new Promise<string[]>((resolve) => {
        const found: string[] = [];
        try {
          const transaction = db.transaction(STORE_NAME, 'readonly');
          const request = transaction.objectStore(STORE_NAME).openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve(found);
              return;
            }
            found.push(String(cursor.key));
            cursor.continue();
          };
          request.onerror = () => resolve(found);
          transaction.onabort = () => resolve(found);
        } catch {
          resolve(found);
        }
      });
    },
    async clear() {
      try {
        await run('readwrite', (store) => store.clear());
      } catch {
        /* nem végzetes */
      }
    },
  };
}

/**
 * Az IndexedDB megnyitása – egyszer, az első használatkor.
 * `null`, ha a TV-n nem elérhető (akkor a hívó a localStorage-ra vált).
 */
export function openIdbStore(): Promise<ChunkStore | null> {
  if (openPromise) return openPromise;
  openPromise = new Promise<ChunkStore | null>((resolve) => {
    let settled = false;
    const finish = (store: ChunkStore | null) => {
      if (settled) return;
      settled = true;
      resolve(store);
    };
    try {
      const factory = typeof indexedDB !== 'undefined' ? indexedDB : null;
      if (!factory) {
        finish(null);
        return;
      }
      const request = factory.open(DB_NAME, DB_VERSION);
      // A TV-n előfordul, hogy a megnyitás nem ad sem sikert, sem hibát.
      const timer = setTimeout(() => finish(null), 4000);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        const database = request.result;
        database.onversionchange = () => database.close();
        finish(createStore(database));
      };
      request.onerror = () => {
        clearTimeout(timer);
        finish(null);
      };
      request.onblocked = () => {
        clearTimeout(timer);
        finish(null);
      };
    } catch {
      finish(null);
    }
  });
  return openPromise;
}

/** Csak a teszteknek: a megnyitás újrapróbálhatóvá tétele. */
export function resetIdbStoreForTests(): void {
  openPromise = null;
}

/** A naplózáshoz: elérhető-e az IndexedDB (aszinkron, ezért külön). */
export async function describeIdbStore(): Promise<string> {
  const store = await openIdbStore();
  return store ? 'IndexedDB elérhető' : 'IndexedDB nem elérhető – localStorage tartalék';
}
