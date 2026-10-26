import { normalizeLogoUrl } from './logoUrl';
/**
 * A szolgáltatótól letöltött csatorna / film / sorozat lista tárolása.
 *
 * LG webOS-en a szolgáltatói adatok a böngésző helyi tárában, adagokban tárolódnak.
 * Ha a TV tárhelye nem írható, a memória-alapú tartalék tárat használjuk.
 *
 * MEMÓRIA (ez okozta korábban a telefon lefagyását):
 *   - a filmek és a sorozatok adagokban (400 elem) tárolódnak,
 *   - betöltéskor is adagonként dolgozzuk fel őket: a nyers adag a feldolgozás
 *     után azonnal felszabadul, és közben visszaadjuk a vezérlést a felületnek,
 *   - a mentés is adagonként készül, így nem kell egyetlen több megabájtos
 *     szöveget a memóriában tartani.
 */

import { Category, Channel, Movie, Series } from '../types/iptv';
import { flagFor } from '../utils/flags';
import { xtreamService } from './xtreamService';
import { appLog, appLogError, logMemory } from './appLog';
import {
  ChunkStore, ChunkEntry, IDB_BATCH_SIZE, ensureDurableStorage,
  onIdbStoreReset, openIdbStore, storageBudgetBytes,
} from './idbStore';

export interface ProviderRef {
  id: string;
  type: 'xtream' | 'm3u';
  serverUrl?: string;
  username?: string;
  password?: string;
}

export interface ImportedContent {
  provider: ProviderRef;
  savedAt: string;
  channels: Channel[];
  movies: Movie[];
  series: Series[];
  liveCategories: Category[];
  vodCategories: Category[];
  seriesCategories: Category[];
  totals: { live: number; vod: number; series: number };
  /**
   * VALÓDI hiányok: a szolgáltató néhány kategóriát nem adott ki, vagy egy
   * szakasz nem töltődött le. Ezeket a felület a betöltés végén megjeleníti,
   * mert adat hiányzik.
   */
  warnings?: string[];
  /**
   * MEGJEGYZÉSEK: olyan tények, amelyek nem hiba és nem is hiány (pl. a
   * tartalom a biztonsági korlátig jött le, vagy a bulk-végpont helyett
   * kategóriánként sikerült a letöltés). Nem teszik „részlegessé” a betöltést.
   */
  notes?: string[];
}

const LIVE_KEY = 'content-live';
const LIVE_META_KEY = 'content-live-meta';
const VOD_KEY = 'content-vod';
const SERIES_KEY = 'content-series';
const VOD_META_KEY = 'content-vod-meta';
const SERIES_META_KEY = 'content-series-meta';
/**
 * Egy adag elemszáma. A korábbi 400 elem 102 824 filmnél 257 külön tranzakciót
 * jelentett: a TV-n ez több tíz másodpercig tartott, és az alkalmazást gyakran
 * bezárták, mielőtt a fejléc (a mentés utolsó lépése) kiíródott volna. 1200
 * elemmel ~86 adag, kötegelve mindössze ~8 tranzakció – a mentés másodpercek
 * alatt, még az import közben is befejeződik.
 */
const CHUNK_SIZE = 1200;
const LIVE_CHUNK_PREFIX = 'content-live-chunk-';
const LIVE_GENERATION_PREFIX = 'content-live-chunk-v1-';
const VOD_CHUNK_PREFIX = 'content-vod-chunk-';
const SERIES_CHUNK_PREFIX = 'content-series-chunk-';
const VOD_GENERATION_PREFIX = 'content-vod-chunk-v2-';
const SERIES_GENERATION_PREFIX = 'content-series-chunk-v2-';

/*
 * A TELJES ÉLŐ LISTA HELYE: INDEXEDDB.
 *
 * A webOS localStorage-kvótája ~5 MB, és ezen osztozik minden: beállítások,
 * kedvencek, poszter-gyorsítótár, a kézi napló (akár 1 MB) ÉS a tartalom.
 * A 20 190 csatornás élő lista önmagában ~3,9 MB volt, vagyis a teljes
 * keret háromnegyedét ette. A 2.5.114-es TV-napló ezt mutatta:
 *
 *   TÁROLÓ HIBA: content-live-chunk-v1-… mentése végleg sikertelen (local);
 *                foglaltság=75 kulcs / 5115 kB
 *
 * Vagyis a lista mellé már semmi nem fért be. Ezért a localStorage-ban csak
 * az INDULÁSHOZ kellő (magyar) készlet marad – ez néhány tíz kB –, a teljes
 * lista pedig az IndexedDB-be kerül, ahol a kvóta nagyságrendekkel nagyobb.
 * Így a lista újraindítás után is megmarad, és nem szorítja ki a beállításokat.
 */
const LIVE_FULL_META_KEY = 'content-live-full-meta';
const LIVE_FULL_GENERATION_PREFIX = 'content-live-full-v1-';
/** Az induló készlet felső korlátja a localStorage-ban (kb. 2500 csatorna). */
const LIVE_BOOT_BUDGET = 500000;
/**
 * Hány adagot olvasunk be az IndexedDB-ből a hideg indításhoz (400 csatorna /
 * adag). Három adag ≈ 1200 csatorna – bőven elég az első képkockához, és a TV-n
 * is gyorsan beolvasható; a teljes lista utána, üresjáratban töltődik be.
 */
const LIVE_BOOT_IDB_CHUNKS = 1;
/** Ennél kisebb induló készletet már nem érdemes menteni (kb. 200 csatorna). */
const LIVE_BOOT_MIN_CHANNELS = 200;
/** Az utolsó próba karakter-kerete (kb. 250 csatorna). */
const LIVE_BOOT_MIN_BUDGET = 40000;

/**
 * Éppen írás alatt álló generációk. A takarítás ezekhez NEM nyúlhat: a
 * félkész adagok csak a mentés befejezése után válnak érvényessé (a metaadat
 * íródik ki utoljára), ilyenkor viszont még nem szerepelnek a `keep`
 * halmazban – enélkül a kvótahiba utáni takarítás törölné a friss adagokat.
 */
const activeGenerations = new Set<string>();

let seriesSaveQueue: Promise<void> = Promise.resolve();
let vodSaveQueue: Promise<void> = Promise.resolve();
/** Adagolt mentések sorszáma (a generációs előtag egyedisége miatt). */
let writeSequence = 0;

/**
 * A visszafejtett listák gyorsítótára a munkameneten belül. A kulcs a TÁROLÓ
 * generációja, ezért egy új mentés után azonnal friss adatot adunk vissza,
 * egyébként pedig nem dekódoljuk újra ugyanazt a 100 ezres listát.
 */
const decodedCache = new Map<string, unknown>();
function rememberDecoded<T>(providerId: string, kind: 'vod' | 'series', key: string, value: T): void {
  const prefix = `${kind}|${providerId}|`;
  for (const existing of decodedCache.keys()) {
    if (existing.startsWith(prefix)) decodedCache.delete(existing);
  }
  decodedCache.set(key, value);
}

function yieldToStorage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A film- és sorozatlista nagy tárolója (IndexedDB).
 *
 * A localStorage ~5,2 millió karaktere kevés a három listának (13,5 M), ezért
 * a két nagy lista IndexedDB-be kerül. Ha a TV-n nem elérhető, `null` jön, és
 * minden a korábbi localStorage-os úton működik tovább.
 */
let contentStorePromise: Promise<ChunkStore | null> | null = null;
let durableStorageLogged = false;
let resetSubscribed = false;
function contentChunkStore(): Promise<ChunkStore | null> {
  if (!resetSubscribed) {
    resetSubscribed = true;
    // Ha a webOS bezárta az adatbázis-kapcsolatot, a következő hívás egy
    // frissen megnyitott tárat kap (idb-database.ts elve). Enélkül a mentés
    // egy halott kapcsolatra várna, és a következő indulás üres lenne.
    onIdbStoreReset(() => { contentStorePromise = null; });
  }
  if (!contentStorePromise) {
    contentStorePromise = (async () => {
      // A tartósság-kérés NEM állhat az első képkocka útjába: háttérben indul,
      // de a fejléc írása előtt (storageBudgetBytes) már megvárjuk az eredményét.
      void ensureDurableStorage().then((info) => {
        if (durableStorageLogged) return;
        durableStorageLogged = true;
        appLog(
          `TARTÓS TÁROLÓ: ${info.persisted ? 'engedélyezve' : 'nem igényelhető'}; mód=${info.method}; `
          + `kvóta=${info.quotaBytes ? (info.quotaBytes / 1024 / 1024).toFixed(0) + ' MB' : 'ismeretlen'}; `
          + `használat=${info.usageBytes ? (info.usageBytes / 1024 / 1024).toFixed(1) + ' MB' : 'ismeretlen'}.`
        );
      }).catch(() => { /* a kvóta-kérés hibája nem akadályozza a tárolást */ });
      const store = await openIdbStore();
      appLog(store
        ? 'Tároló: a csatornák, filmek és sorozatok tartós IndexedDB-tárba kerülnek.'
        : 'Tároló: IndexedDB most nem elérhető – később újrapróbáljuk; a régi lista megmarad.');
      return store;
    })();
  }
  return contentStorePromise;
}
const LOCAL_PREFIX = 'iptv_rt_';
const LOCAL_BUDGET = 2000000; // böngészőben ennyi karakterig mentünk

type Row = Array<string | number>;

interface LivePart {
  v: 1;
  provider: ProviderRef;
  savedAt: string;
  totals: { live: number; vod: number; series: number };
  cats: Row[];
  rows: Row[];
}

interface LiveChunkMeta {
  v: 1;
  provider: ProviderRef;
  savedAt: string;
  totals: { live: number; vod: number; series: number };
  cats: Row[];
  chunks: number;
  chunkPrefix: string;
  /** Hány csatorna van a localStorage-os induló készletben. */
  boot?: number;
  /** Hány csatorna van a TELJES listában (IndexedDB). */
  full?: number;
}

interface VodPart {
  v: 1;
  totals: { vod: number };
  cats: Row[];
  rows: Row[];
}

interface SeriesPart {
  v: 1;
  totals: { series: number };
  cats: Row[];
  rows: Row[];
}

/** Egy adagolt (több kulcsból álló) lista fejléce. */
interface ChunkMeta {
  v: 1;
  totals: { vod?: number; series?: number };
  cats: Row[];
  chunks: number;
  chunkPrefix: string;
  /** Az élő lista teljes másolatánál: melyik szolgáltatóhoz tartozik. */
  provider?: ProviderRef;
  savedAt?: string;
  /** A mentés ideje (ms) – a gyorsítótár frissességéhez (stale-while-revalidate). */
  savedAtMs?: number;
  liveTotal?: number;
}

/* --------------------------------------------------------------- backendek */

interface Backend {
  name: 'local' | 'memory';
  get(key: string): string;
  put(key: string, value: string): boolean;
  remove(key: string): void;
  /** Az összes mentett kulcs (a tartalom-előtag nélkül). */
  keys(): string[];
}

const memory = new Map<string, string>();

const backend: Backend = (() => {
  try {
    window.localStorage.setItem('iptv_rt_probe', '1');
    window.localStorage.removeItem('iptv_rt_probe');
    return {
      name: 'local',
      get: (key) => window.localStorage.getItem(LOCAL_PREFIX + key) || '',
      put: (key, value) => {
        try {
          window.localStorage.setItem(LOCAL_PREFIX + key, value);
          return true;
        } catch {
          return false;
        }
      },
      remove: (key) => window.localStorage.removeItem(LOCAL_PREFIX + key),
      keys: () => {
        const keys: string[] = [];
        try {
          for (let index = 0; index < window.localStorage.length; index++) {
            const key = window.localStorage.key(index);
            if (key && key.startsWith(LOCAL_PREFIX)) keys.push(key.slice(LOCAL_PREFIX.length));
          }
        } catch {
          /* a felsorolás hibája nem akadályozhatja a mentést */
        }
        return keys;
      },
    };
  } catch {
    return {
      name: 'memory',
      get: (key) => memory.get(key) || '',
      put: (key, value) => {
        memory.set(key, value);
        return true;
      },
      remove: (key) => {
        memory.delete(key);
      },
      keys: () => Array.from(memory.keys()),
    };
  }
})();

/* ---------------------------------------------------------------- kódolás */

function isNumeric(value: string | number): boolean {
  return /^\d+$/.test(String(value));
}

function compactText(value: string | undefined, max: number): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function encodeOptionalJson(value: unknown): string {
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return ''; }
}

function decodeOptionalJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function streamUrlFor(provider: ProviderRef, value: string, ext: string, kind: 'live' | 'movie' | 'series'): string {
  if (!isNumeric(value)) return value; // M3U: kész URL
  const server = provider.serverUrl || '';
  const user = provider.username || '';
  const pass = provider.password || '';
  if (kind === 'live') return xtreamService.buildLiveStreamUrl(server, user, pass, value, 'ts');
  if (kind === 'movie') return xtreamService.buildMovieStreamUrl(server, user, pass, value, ext || 'mp4');
  return xtreamService.buildSeriesStreamUrl(server, user, pass, value, ext || 'mp4');
}

function encodeCategories(categories: Category[]): Row[] {
  return categories.map((cat) => [cat.id, cat.name, cat.channelCount]);
}

function decodeCategories(rows: Row[], type: 'live' | 'movie' | 'series'): Category[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => Array.isArray(row) && row.length >= 2)
    .map((row) => ({
      id: String(row[0]),
      name: String(row[1]),
      flag: type === 'live' ? flagFor(String(row[1])).flag : type === 'movie' ? '🎬' : '📺',
      channelCount: Number(row[2] ?? 0),
      subCategoryCount: 0,
      type,
    }));
}

function encodeChannels(channels: Channel[]): Row[] {
  return channels.map((ch) => [
    ch.num,
    ch.name,
    ch.logo || '',
    ch.categoryId,
    ch.categoryName,
    ch.streamUrl,
    ch.flag || '',
    ch.countryCode || '',
    // 9. elem: EPG azonosító (epg_channel_id) – a régi mentett adatokban nincs,
    // ezért a visszafejtés mindig kezeli a hiányzó elemet is.
    ch.epgChannelId || '',
  ]);
}

function decodeChannels(rows: Row[], provider: ProviderRef): Channel[] {
  if (!Array.isArray(rows)) return [];
  const out: Channel[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length < 6) continue;
    const name = String(row[1] || 'Csatorna');
    const info = flagFor(String(row[4] || name));
    const rawStreamId = String(row[5] ?? '');
    // A logóbázis ugyanazzal a képzéssel készül, mint a bejelentkezésnél:
    // a séma nélküli szervercímet a playerApiBase() egészíti ki http://-vel.
    // M3U-nál (nincs szervercím) a stream címe marad a viszonyítási alap.
    const logoBase = provider.serverUrl
      ? xtreamService.playerApiBase(provider.serverUrl, '', '')
      : rawStreamId;
    out.push({
      id: `live-${provider.id}-${row[0] ?? i}`,
      num: Number(row[0] ?? i + 1),
      name,
      logo: normalizeLogoUrl(row[2], logoBase),
      streamUrl: streamUrlFor(provider, rawStreamId, 'ts', 'live'),
      streamId: isNumeric(rawStreamId) ? Number(rawStreamId) : undefined,
      epgChannelId: String(row[8] || '') || null,
      categoryId: String(row[3] || 'cat-other'),
      categoryName: String(row[4] || 'Egyéb'),
      country: info.country,
      countryCode: String(row[7] || info.countryCode),
      flag: String(row[6] || info.flag),
      resolution: '1920×1080',
      format: 'ts',
      isFavorite: false,
      orderIndex: i,
      epgNow: { time: 'Élő', title: name },
    });
  }
  return out;
}

function encodeMovies(movies: Movie[]): Row[] {
  return movies.map((m) => {
    const row: Row = [
      m.streamId ?? m.streamUrl,
      m.title,
      m.categoryId,
      m.categoryName,
      m.poster || '',
      m.rating,
      m.year,
      m.containerExtension || 'mp4',
      compactText(m.plot, 200),
      m.isFavorite ? 1 : 0,
    ];
    // A régi tízsoros formátumot megtartjuk a nem részletezett elemeknél.
    // Az első 20 VOD metaadatai viszont ugyanebben a tartós sorban élnek tovább.
    const hasVodMetadata = Boolean(
      m.durationMinutes > 0 || m.audioLanguages?.length || m.subtitleLanguages?.length
        || m.audioTracks?.length || m.subtitleTracks?.length || m.backdrop || m.genres.length
        || m.director || m.cast?.length
    );
    if (hasVodMetadata) {
      row.push(
        m.durationMinutes || 0,
        encodeOptionalJson(m.audioLanguages || []),
        encodeOptionalJson(m.subtitleLanguages || []),
        encodeOptionalJson(m.audioTracks || []),
        encodeOptionalJson(m.subtitleTracks || []),
        m.backdrop || '',
        encodeOptionalJson(m.genres || []),
        m.director || '',
        encodeOptionalJson(m.cast || []),
      );
    }
    return row;
  });
}

/**
 * A film adagsorok visszafejtése. Az `offset` az adag első elemének sorszáma a
 * teljes listában, így az azonosítók adagolás után is ugyanazok maradnak.
 */
function decodeMovies(rows: Row[], provider: ProviderRef, offset = 0): Movie[] {
  if (!Array.isArray(rows)) return [];
  const out: Movie[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length < 4) continue;
    const title = String(row[1] || 'Film');
    out.push({
      id: `vod-${provider.id}-${row[0] ?? offset + i}`,
      streamId: isNumeric(String(row[0])) ? Number(row[0]) : undefined,
      title,
      categoryId: String(row[2] || 'vod-other'),
      categoryName: String(row[3] || 'Filmek'),
      poster: String(row[4] || ''),
      rating: Number(row[5] ?? 0),
      year: Number(row[6] ?? 0),
      durationMinutes: Number(row[10] ?? 0) || 0,
      plot: String(row[8] || ''),
      genres: decodeOptionalJson<string[]>(row[16], []),
      streamUrl: streamUrlFor(provider, String(row[0]), String(row[7] || 'mp4'), 'movie'),
      containerExtension: String(row[7] || 'mp4'),
      audioLanguages: decodeOptionalJson<string[] | undefined>(row[11], undefined),
      subtitleLanguages: decodeOptionalJson<string[] | undefined>(row[12], undefined),
      audioTracks: decodeOptionalJson<Movie['audioTracks']>(row[13], undefined),
      subtitleTracks: decodeOptionalJson<Movie['subtitleTracks']>(row[14], undefined),
      backdrop: String(row[15] || '') || undefined,
      director: String(row[17] || '') || undefined,
      cast: decodeOptionalJson<string[] | undefined>(row[18], undefined),
      isFavorite: Number(row[9] ?? 0) === 1,
    });
  }
  return out;
}

function encodeSeries(series: Series[]): Row[] {
  return series.map((s) => {
    const row: Row = [
      s.seriesId ?? s.id,
      s.title,
      s.categoryId,
      s.categoryName,
      s.poster || '',
      s.rating,
      s.year,
      compactText(s.plot, 200),
      s.seasonsCount || 0,
      s.episodesCount || 0,
      s.isFavorite ? 1 : 0,
    ];
    const hasSeriesMetadata = Boolean(
      s.durationMinutes && s.durationMinutes > 0 || s.audioLanguages?.length || s.subtitleLanguages?.length
        || s.audioTracks?.length || s.subtitleTracks?.length || s.backdrop || s.genres.length
        || s.director || s.cast?.length
    );
    if (hasSeriesMetadata) {
      row.push(
        s.durationMinutes || 0,
        encodeOptionalJson(s.audioLanguages || []),
        encodeOptionalJson(s.subtitleLanguages || []),
        encodeOptionalJson(s.audioTracks || []),
        encodeOptionalJson(s.subtitleTracks || []),
        s.backdrop || '',
        encodeOptionalJson(s.genres || []),
        s.director || '',
        encodeOptionalJson(s.cast || []),
      );
    }
    return row;
  });
}

function decodeSeries(rows: Row[], provider: ProviderRef, offset = 0): Series[] {
  if (!Array.isArray(rows)) return [];
  const out: Series[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length < 4) continue;
    out.push({
      id: `ser-${provider.id}-${row[0] ?? offset + i}`,
      seriesId: isNumeric(String(row[0])) ? Number(row[0]) : undefined,
      title: String(row[1] || 'Sorozat'),
      categoryId: String(row[2] || 'ser-other'),
      categoryName: String(row[3] || 'Sorozatok'),
      poster: String(row[4] || ''),
      rating: Number(row[5] ?? 0),
      year: Number((String(row[6] || '').match(/\d{4}/) || [0])[0]),
      seasonsCount: Number(row[8] ?? 0),
      episodesCount: Number(row[9] ?? 0),
      durationMinutes: Number(row[11] ?? 0) || 0,
      plot: String(row[7] || ''),
      genres: decodeOptionalJson<string[]>(row[17], []),
      seasons: [],
      audioLanguages: decodeOptionalJson<string[] | undefined>(row[12], undefined),
      subtitleLanguages: decodeOptionalJson<string[] | undefined>(row[13], undefined),
      audioTracks: decodeOptionalJson<Series['audioTracks']>(row[14], undefined),
      subtitleTracks: decodeOptionalJson<Series['subtitleTracks']>(row[15], undefined),
      backdrop: String(row[16] || '') || undefined,
      director: String(row[18] || '') || undefined,
      cast: decodeOptionalJson<string[] | undefined>(row[19], undefined),
      isFavorite: Number(row[10] ?? 0) === 1,
    });
  }
  return out;
}

/* A betöltő (providerImport) ugyanezekkel a függvényekkel alakítja át a
   letöltött sorokat a felület által használt objektumokká, így a memóriában
   lévő és a mentett adat mindig ugyanazt jelenti. */
export const decodeChannelsForImport = decodeChannels;
export const decodeMoviesForImport = decodeMovies;
export const decodeSeriesForImport = decodeSeries;

/* -------------------------------------------------------------- mentés */

/** Egy mentés eredménye: sikerült-e, és VALÓJÁBAN hány sor fért el. */
interface WriteOutcome {
  ok: boolean;
  /** A ténylegesen eltárolt sorok száma (csonkolás/szűkítés után). */
  rows: number;
  chars: number;
}

function write(key: string, payload: unknown, options?: { allowShrink?: boolean }): boolean {
  return writeMeasured(key, payload, options).ok;
}

/**
 * `allowShrink: false` – az adagot NE csonkítsuk, hogy a hívó előbb helyet
 * szabadíthasson. Az élő listánál ez kell: a csendes csonkítás miatt a
 * helyfelszabadítás soha nem futott le, és a lista némán megfeleződött.
 */
function writeMeasured(key: string, payload: unknown, options?: { allowShrink?: boolean }): WriteOutcome {
  const allowShrink = options?.allowShrink !== false;
  let text = JSON.stringify(payload);
  let storedRows = Array.isArray((payload as { rows?: Row[] })?.rows)
    ? (payload as { rows: Row[] }).rows.length
    : 0;
  if (allowShrink && text.length > LOCAL_BUDGET) {
    // Böngészőben (localStorage) nem fér el minden – csonkoljuk a listát.
    // A nagy JSON visszaolvasása fölösleges plusz memóriacsúcsot okozna.
    const source = payload as { rows?: Row[] };
    if (Array.isArray(source?.rows)) {
      const keep = Math.max(200, Math.floor(source.rows.length * (LOCAL_BUDGET / text.length)));
      text = JSON.stringify({ ...source, rows: source.rows.slice(0, keep) });
      storedRows = Math.min(storedRows, keep);
    }
  }
  const initialChars = text.length;
  const initialRows = Array.isArray((payload as { rows?: unknown[] })?.rows)
    ? (payload as { rows: unknown[] }).rows.length : 'n/a';
  let retries = 0;
  let sweptKeys = 0;
  let ok = backend.put(key, text);
  if (!ok) {
    // A webOS nem minden esetben ad vissza konkrét kvóta/hozzáférési hibát,
    // ezért a napló a méretet, próbálkozásokat és mentési eredményt rögzíti.
    appLog(`TÁROLÓ DIAG: első mentés sikertelen; kulcs=${key}; backend=${backend.name}; méret=${initialChars} karakter; sorok=${initialRows}; ok=kvóta/hozzáférés oka nem különíthető el.`);
    // TV-n a localStorage kvóta kisebb lehet. Egyre kisebb adaggal újrapróbáljuk.
    const source = payload as { rows?: Row[] };
    let rows = allowShrink && Array.isArray(source?.rows) ? source.rows : null;
    while (!ok && rows && rows.length > 100) {
      rows = rows.slice(0, Math.floor(rows.length / 2));
      text = JSON.stringify({ ...source, rows });
      storedRows = rows.length;
      retries += 1;
      ok = backend.put(key, text);
    }
    if (ok && rows) {
      appLog(`TÁROLÓ DIAG: szűkített mentés sikerült; kulcs=${key}; új méret=${text.length} karakter; megmaradt sorok=${rows.length}; csökkentések=${retries}.`);
    }
  }
  if (!ok) {
    // Utolsó próba: az elárvult adagok törlése után újra próbáljuk.
    try {
      sweptKeys = sweepStorage();
      if (sweptKeys > 0) ok = backend.put(key, text);
      appLog(`TÁROLÓ DIAG: takarítási próba; kulcs=${key}; törölt kulcsok=${sweptKeys}; újrapróbálás=${ok ? 'sikerült' : 'sikertelen'}.`);
    } catch (error) {
      appLog(`TÁROLÓ DIAG: takarítási hiba; kulcs=${key}; részlet=${String(error).slice(0, 120)}.`);
    }
  }
  if (!ok) {
    // Végső tartalék: memória, így csak az aktuális munkamenetben marad meg.
    memory.set(key, text);
    appLog(
      `TÁROLÓ HIBA: ${key} mentése végleg sikertelen (${backend.name}); méret=${text.length} karakter; ` +
      `csökkentések=${retries}; takarított kulcsok=${sweptKeys}; ` +
      `foglaltság=${describeStorageUsage()}; memória-tartalék aktív, újraindítás után elveszhet.`
    );
  }
  return { ok, rows: storedRows, chars: text.length };
}

/**
 * Mennyi helyet foglalnak a tartalom-adagok a tárolóban.
 *
 * A TV localStorage-kvótája kicsi, és a webOS nem mondja meg a hibánál, hogy
 * kvóta- vagy hozzáférési problémáról van szó. Ezért hibánál kiírjuk a valódi
 * foglaltságot: a naplóból így látszik, hogy a lista egyszerűen NEM FÉR EL,
 * nem pedig valami titokzatos írási hiba történt.
 */
function describeStorageUsage(): string {
  try {
    let keys = 0;
    let chars = 0;
    for (const key of backend.keys()) {
      if (!key.startsWith('content-')) continue;
      keys += 1;
      chars += (backend.get(key) || '').length;
    }
    return `${keys} kulcs / ${(chars / 1024).toFixed(0)} kB`;
  } catch {
    return 'nem mérhető';
  }
}

/**
 * A film- és sorozatadagok eldobása, hogy az élő csatornalista elférjen.
 *
 * Az élő lista a legfontosabb: ez látszik azonnal az indulásnál, és enélkül a
 * néző nem tud tévézni. A filmek és a sorozatok a szolgáltatótól bármikor
 * újratölthetők (IndexedDB-be mennek), ezért ha kell, ezek adják a helyet.
 */
function evictLowerPriorityChunks(): number {
  let removed = 0;
  try {
    for (const key of backend.keys()) {
      if (activeGenerations.has(key)) continue;
      if (
        key.startsWith(VOD_CHUNK_PREFIX) || key.startsWith(SERIES_CHUNK_PREFIX)
        || key === VOD_META_KEY || key === SERIES_META_KEY
      ) {
        backend.remove(key);
        removed += 1;
      }
    }
  } catch {
    /* a takarítás hibája nem akadályozhatja a mentést */
  }
  if (removed > 0) {
    appLog(`Tároló: ${removed} film/sorozat adag törölve, hogy az élő csatornalista elférjen.`);
  }
  return removed;
}

/** Magyar csatorna? A mentési sorrendhez és az induló készlethez. */
function isHungarianForSave(channel: Channel): boolean {
  return (channel.countryCode || '').toUpperCase() === 'HU'
    || channel.country === 'Magyarország'
    || /\b(magyarország|hungary|hungarian)\b/i.test(channel.categoryName || '');
}

/** Mentésnél a magyar csatornák kerülnek előre. */
function hungarianFirstForSave(channels: Channel[]): Channel[] {
  const hu: Channel[] = [];
  const rest: Channel[] = [];
  for (const channel of channels) {
    (isHungarianForSave(channel) ? hu : rest).push(channel);
  }
  return hu.length ? hu.concat(rest) : channels;
}

/**
 * Az INDULÓ készlet: a magyar csatornák, legfeljebb `LIVE_BOOT_BUDGET` karakter.
 *
 * Ez az a rész, amit a localStorage-ba írunk. A többi ország csatornái az
 * IndexedDB-ből (vagy szükség esetén a szolgáltatótól) érkeznek. Ha nincs
 * magyar csatorna, az első néhány csatorna marad, hogy az alkalmazás soha ne
 * induljon üresen.
 */
/** Egy csatorna mentett méretének becslése – a teljes JSON előkészítése nélkül. */
function channelSaveEstimate(channel: Channel): number {
  return (channel.name?.length || 0) + (channel.streamUrl?.length || 0)
    + (channel.logo?.length || 0) + (channel.categoryName?.length || 0) + 120;
}

/** A lista becsült mentett mérete karakterben. */
function liveCharsEstimate(channels: Channel[]): number {
  let chars = 0;
  for (const channel of channels) chars += channelSaveEstimate(channel);
  return chars;
}

function liveBootSubset(
  channels: Channel[],
  budget: number = LIVE_BOOT_BUDGET,
  hungarianOnly = true,
): Channel[] {
  let source = channels;
  if (hungarianOnly) {
    const hu: Channel[] = [];
    for (const channel of channels) if (isHungarianForSave(channel)) hu.push(channel);
    if (hu.length) source = hu;
  }
  const subset: Channel[] = [];
  let chars = 0;
  for (const channel of source) {
    // Becslés: a teljes JSON-előkészítés 20 000 csatornánál fölösleges munka.
    const estimate = channelSaveEstimate(channel);
    if (chars + estimate > budget) break;
    subset.push(channel);
    chars += estimate;
  }
  return subset;
}

/**
 * Az induló készlet mentése a localStorage-ba – ATOMIBUS generációváltással.
 *
 * FONTOS (ez okozta az adatvesztést): korábban a mentés az ELŐZŐ generáció
 * adagjait írás közben, egyenként törölte. Ha a kvóta közben betelt (a webOS-on
 * ez a normál eset volt, mert a teljes lista ~3,9 MB), a mentés félbeszakadt,
 * de a régi adagok egy része már nem létezett – a fejléc viszont továbbra is
 * rájuk mutatott. A következő indításnál ezért a lista üresnek látszott.
 *
 * Mostantól az új generáció kiíródik, a fejléc UTOLSÓKÉNT kerül a helyére, és
 * csak ezután töröljük a régit. Bármi megszakad, a korábbi lista érintetlen.
 */
function saveLiveBootCache(content: ImportedContent, boot: Channel[]): boolean {
  const chunkCount = Math.ceil(boot.length / CHUNK_SIZE);
  const generationPrefix = LIVE_GENERATION_PREFIX + Date.now() + '-' + (++writeSequence) + '-';
  const previousKeys = readChunkKeys(LIVE_META_KEY, LIVE_CHUNK_PREFIX);
  for (let index = 0; index < chunkCount; index++) activeGenerations.add(generationPrefix + index);

  const abort = (reason: string): false => {
    for (let index = 0; index < chunkCount; index++) {
      backend.remove(generationPrefix + index);
      activeGenerations.delete(generationPrefix + index);
    }
    appLog(`Élő csatornák induló készlete: ${reason}; a korábbi mentett lista érvényben marad.`);
    return false;
  };

  for (let index = 0; index < chunkCount; index++) {
    const rows = encodeChannels(boot.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
    const chunkKey = generationPrefix + index;
    let ok = write(chunkKey, { rows }, { allowShrink: false });
    if (!ok) {
      // Helyfelszabadítás: a film/sorozat adagok eldobhatók, az élő lista nem.
      const freed = evictLowerPriorityChunks();
      if (freed > 0) ok = write(chunkKey, { rows }, { allowShrink: false });
    }
    /*
     * CSONKÍTOTT ADAGOT SOHA nem írunk ki: a félig mentett adag a fejlécben
     * szereplő darabszámhoz képest kevesebb csatornát adna vissza, vagyis
     * észrevétlen adatvesztés lenne. Ha nem fér be, megszakítjuk a mentést
     * (a korábbi lista érintetlen), és a hívó kisebb készlettel próbálja újra.
     */
    if (!ok) return abort(`a(z) ${index + 1}/${chunkCount} adag nem fért be`);
  }

  const meta: LiveChunkMeta = {
    v: 1,
    provider: content.provider,
    savedAt: content.savedAt,
    totals: content.totals,
    cats: encodeCategories(content.liveCategories),
    chunks: chunkCount,
    chunkPrefix: generationPrefix,
    boot: boot.length,
    full: content.channels.length,
  };
  if (!write(LIVE_META_KEY, meta)) {
    // A fejléc az utolsó, ami kell: ha nem fér el, a film/sorozat adagok
    // felszabadításával még megpróbáljuk – fejléc nélkül a lista nem olvasható.
    evictLowerPriorityChunks();
  }
  if (!write(LIVE_META_KEY, meta)) return abort('a fejléc nem fért be');
  for (let index = 0; index < chunkCount; index++) activeGenerations.delete(generationPrefix + index);

  // CSAK MOST töröljük a korábbi generációt (és a régi egykulcsos tárat).
  backend.remove(LIVE_KEY);
  for (const key of previousKeys) backend.remove(key);
  appLog(`Élő csatornák induló készlete elmentve: ${boot.length} csatorna (teljes lista: ${content.channels.length}).`);
  return true;
}

/**
 * A teljes lista mentésének eredménye:
 *   • `saved`       – a teljes lista az IndexedDB-ben van;
 *   • `unavailable` – nincs IndexedDB (régi webOS, tiltott origin, teszt):
 *                     ilyenkor a hívó a régi úton, a localStorage-ba menti;
 *   • `failed`      – van IndexedDB, de az írás nem sikerült; NEM erőltetjük
 *                     a több megabájtos listát a kis localStorage-kvótába
 *                     (pontosan ez volt a 2.5.114-es kvótahiba útja).
 */
type LiveFullSaveResult = 'saved' | 'unavailable' | 'failed';

/** A teljes élő lista mentése IndexedDB-be, sorban (nem írhatják felül egymást). */
let liveFullSaveQueue: Promise<LiveFullSaveResult> = Promise.resolve('failed');

function saveLiveFullToIdb(content: ImportedContent, channels: Channel[]): Promise<LiveFullSaveResult> {
  const task: Promise<LiveFullSaveResult> = liveFullSaveQueue.then(async (): Promise<LiveFullSaveResult> => {
    if (channels.length === 0) return 'failed';
    const store = await contentChunkStore();
    if (!store) return 'unavailable';
    const ok = await saveChunkedToIdb(store, {
      metaKey: LIVE_FULL_META_KEY,
      legacyKey: `${LIVE_FULL_META_KEY}-legacy`,
      legacyPrefix: LIVE_FULL_GENERATION_PREFIX,
      generationPrefix: LIVE_FULL_GENERATION_PREFIX,
      total: channels.length,
      chunkRows: (index) => encodeChannels(channels.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)),
      totals: content.totals,
      cats: encodeCategories(content.liveCategories),
      label: 'Teljes élő csatornalista',
      provider: content.provider,
      savedAt: content.savedAt,
      liveTotal: content.totals.live || channels.length,
    });
    appLog(ok
      ? `Teljes élő csatornalista elmentve (IndexedDB): ${channels.length} csatorna.`
      : `Teljes élő csatornalista: az IndexedDB-mentés nem sikerült (${channels.length} csatorna); `
        + 'a kis induló készlet a localStorage-ban marad, a többi ország igény szerint töltődik.');
    return ok ? 'saved' : 'failed';
  }).catch((error) => {
    appLogError('Teljes élő csatornalista mentése', error);
    return 'failed';
  });
  liveFullSaveQueue = task.catch(() => 'failed' as LiveFullSaveResult);
  return task;
}

/**
 * Az induló készlet mentése, egyre kisebb készlettel.
 *
 * A tár a mentés pillanatában az ELŐZŐ generációt is tartalmazza (azt csak a
 * sikeres fejléc-írás után töröljük), ezért a szabad hely néha kevesebb, mint
 * a tervezett 500 000 karakter. Ilyenkor nem adunk fel mindent és nem írunk
 * csonka adagot: a készlet felére csökkentésével újrapróbáljuk, amíg befér.
 * A teljes lista eközben az IndexedDB-be megy, tehát a kisebb induló készlet
 * csak az első képkockát érinti, csatornát nem veszítünk el.
 *
 * @returns a ténylegesen elmentett induló készlet (üres, ha egyáltalán nem fért be)
 */
function saveLiveBootWithRetry(
  content: ImportedContent,
  channels: Channel[],
  startBudget: number = LIVE_BOOT_BUDGET,
  hungarianOnly = true,
): Channel[] {
  let budget = startBudget;
  // Legfeljebb 5 próba: 500k → 250k → 125k → 62k → 40k karakter. A ciklus
  // akkor is leáll, ha a készlet már nem csökkenthető tovább (nincs végtelen
  // újrapróbálkozás, ami a TV-t lefoglalná).
  for (let attempt = 0; attempt < 5; attempt++) {
    const boot = liveBootSubset(channels, budget, hungarianOnly);
    if (!boot.length) return boot;
    if (saveLiveBootCache(content, boot)) return boot;
    if (boot.length <= LIVE_BOOT_MIN_CHANNELS) return [];
    const next = Math.max(LIVE_BOOT_MIN_BUDGET, Math.floor(budget / 2));
    if (next >= budget) return [];
    appLog(`Élő csatornák: ${boot.length} csatorna nem fért be, újrapróbálás kisebb készlettel.`);
    budget = next;
  }
  return [];
}

/**
 * Az élő csatornák mentése – két helyre, szándékosan:
 *   • localStorage: csak az INDULÓ (magyar) készlet, ami az első képkockához kell;
 *   • IndexedDB:    a TELJES lista, mert a localStorage-ba nem fér be (ez okozta
 *                   a kvótahibát és vele az adatvesztést újraindításkor).
 * Ha az IndexedDB nem elérhető (régi webOS, tiltott origin, teszt-környezet),
 * a teljes lista a régi úton, a localStorage-ba megy – ott nem veszik el semmi.
 */
export async function saveLiveContentAsync(content: ImportedContent): Promise<void> {
  const channels = hungarianFirstForSave(content.channels);
  const boot = saveLiveBootWithRetry(content, channels);
  try {
    if (!boot.length) appLog('Élő csatornák: az induló készlet nem fért be a localStorage-ba.');
  } catch (error) {
    // A cache hibája nem akadályozhatja a teljes lista mentését.
    appLogError('Élő csatornák induló készletének mentése', error);
  }
  const savedFull = await saveLiveFullToIdb(content, channels);
  if (savedFull !== 'unavailable' || channels.length <= boot.length) return;
  appLog('Élő csatornák: IndexedDB nélkül a teljes lista a localStorage-ba megy (a kvóthoz igazítva).');
  try {
    // Ilyenkor nincs nagy kvótájú tár: a lehető LEGNAGYOBB készletet mentjük
    // a localStorage-ba (magyar csatornák elöl), és ha nem fér be, a
    // `saveLiveBootWithRetry` kisebb, de ÉP készlettel próbálkozik újra.
    saveLiveBootWithRetry(content, channels, liveCharsEstimate(channels) + 1, false);
  } catch (error) {
    appLogError('Élő csatornák mentése (localStorage)', error);
  }
}

/** Tűz-és-felejtsd mentés (a felület nem vár a tárolóra). */
export function saveLiveContent(content: ImportedContent): void {
  void saveLiveContentAsync(content);
}

/* ------------------------------------------------- szinkron-állapot */

/**
 * Mikor volt az utolsó TELJES szinkron, és milyen volt akkor a szolgáltató
 * kategórialistája?
 *
 * A frissítés ebből tudja meg, hogy érdemes-e újra letölteni a több tíz MB-os
 * listákat: ha a kategóriák ujjlenyomata azonos, és az utolsó teljes
 * ellenőrzés friss, akkor nincs mit újratölteni.
 *
 * A kulcs szándékosan NEM `content-` előtagú: a `sweepStorage()` a content-
 * kulcsokat takarítja, és ez az állapot nem tartalom.
 */
const SYNC_KEY = 'sync-state';

export interface SyncState {
  providerId: string;
  /** A három kategórialista együttes ujjlenyomata. */
  fingerprint: string;
  /** A legutóbbi teljes szinkron ideje (Date.now()). */
  fullSyncAt: number;
}

export function loadSyncState(providerId: string): SyncState | null {
  try {
    const raw = backend.get(SYNC_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as SyncState;
    if (!state || typeof state.fingerprint !== 'string' || state.providerId !== providerId) return null;
    return state;
  } catch {
    return null;
  }
}

export function saveSyncState(state: SyncState): void {
  write(SYNC_KEY, state);
}

/* ------------------------------------------------ KATALÓGUS-ÁLLAPOT (TTL) */

/*
 * A referencia xtream-catalog.ts / idb-cache.ts „stale-while-revalidate” elve:
 * a gyorsítótárat AZONNAL, ellenőrzés nélkül kiszolgáljuk, és csak akkor
 * vizsgáljuk a frissességét, ha lejárt az élettartama. A frissességi bélyeg
 * NEM a teljes listát írja újra – csak ezt a pár száz bájtos állapotot.
 *
 * A bélyeget a localStorage-ban is tartjuk (ez a leggyorsabb, szinkron út),
 * de az IndexedDB-be is kiírjuk, hogy a localStorage törlése után se
 * induljon felesleges letöltés.
 */
const CONTENT_STATE_KEY = 'content-catalog-state';
const IDB_STATE_KEY = 'catalog-state-v2';
/** Ennyi idő után érdemes egyetlen olcsó kategória-ellenőrzést futtatni. */
export const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

export interface CatalogSectionState {
  savedAt: number;
  count: number;
}
export interface CatalogState {
  v: 2;
  providerId: string;
  provider: ProviderRef | null;
  savedAt: number;
  checkedAt: number;
  fingerprint: string;
  counts: { live: number; vod: number; series: number };
  sections: { live?: CatalogSectionState; vod?: CatalogSectionState; series?: CatalogSectionState };
}

let cachedCatalogState: CatalogState | null = null;

function emptyCatalogState(): CatalogState {
  return {
    v: 2, providerId: '', provider: null, savedAt: 0, checkedAt: 0, fingerprint: '',
    counts: { live: 0, vod: 0, series: 0 }, sections: {},
  };
}

/** Szinkron olvasat (induláskor, a takarókép alatt). */
export function readCatalogStateSync(): CatalogState | null {
  if (cachedCatalogState) return cachedCatalogState;
  try {
    const raw = backend.get(CONTENT_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CatalogState;
    if (!parsed || parsed.v !== 2 || !parsed.counts) return null;
    cachedCatalogState = parsed;
    return parsed;
  } catch {
    return null;
  }
}

/** Teljes olvasat: localStorage, majd (ha még nincs) a tartós tár. */
export async function readCatalogState(): Promise<CatalogState | null> {
  const local = readCatalogStateSync();
  if (local) return local;
  try {
    const store = await contentChunkStore();
    if (!store) return null;
    const raw = await store.get(IDB_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CatalogState;
    if (!parsed || parsed.v !== 2 || !parsed.counts) return null;
    cachedCatalogState = parsed;
    // A gyors szinkron útra is visszatesszük.
    write(CONTENT_STATE_KEY, parsed);
    return parsed;
  } catch {
    return null;
  }
}

let catalogStateQueue: Promise<void> = Promise.resolve();
function updateCatalogState(mutate: (state: CatalogState) => void): void {
  catalogStateQueue = catalogStateQueue.then(async () => {
    const state = readCatalogStateSync() || emptyCatalogState();
    mutate(state);
    state.savedAt = Math.max(state.savedAt, state.sections.live?.savedAt || 0,
      state.sections.vod?.savedAt || 0, state.sections.series?.savedAt || 0);
    cachedCatalogState = state;
    try { write(CONTENT_STATE_KEY, state); } catch { /* kis kulcs, nem kritikus */ }
    try {
      const store = await contentChunkStore();
      if (store) await store.put(IDB_STATE_KEY, JSON.stringify(state));
    } catch { /* a tartós másolat hiánya nem akadály */ }
  });
}

function noteSectionSaved(section: 'live' | 'vod' | 'series', count: number, provider: ProviderRef | null, at: number): void {
  updateCatalogState((state) => {
    if (provider) { state.providerId = provider.id; state.provider = provider; }
    state.counts[section] = count;
    state.sections[section] = { savedAt: at, count };
    state.checkedAt = Math.max(state.checkedAt, at);
  });
}

/** A szolgáltató kategóriáinak ujjlenyomata (olcsó változásvizsgálathoz). */
export function setCatalogFingerprint(fingerprint: string, provider?: ProviderRef | null): void {
  updateCatalogState((state) => {
    state.fingerprint = fingerprint;
    if (provider) { state.providerId = provider.id; state.provider = provider; }
  });
}

/** Csak a frissességi bélyeget írjuk újra – a nagy listához nem nyúlunk. */
export function markCatalogChecked(): void {
  updateCatalogState((state) => { state.checkedAt = Date.now(); });
}

export function catalogNeedsCheck(state: CatalogState | null): boolean {
  if (!state) return false;
  const stamp = state.checkedAt || state.savedAt;
  return stamp > 0 && Date.now() - stamp > CATALOG_TTL_MS;
}

/* ------------------------------------------- RÉSZLETES VOD-METAADATOK */

/*
 * Az import a végén 20 VOD-elemhez kér részletes metaadatot (hangsáv,
 * felirat, szereplők). A szakaszonkénti mentésnél ez a 20 tétel már nem fut
 * át újra a teljes 100 ezres listán: külön, néhány kB-os rekordban tároljuk,
 * és visszatöltéskor a megfelelő elemekre ráolvassuk.
 */
const EXTRAS_PREFIX = 'catalog-extras-v2-';
const EXTRAS_LIMIT = 30;
type Extras = { movies: Movie[]; series: Series[] };
const extrasCache = new Map<string, Extras>();

export async function saveCatalogExtras(providerId: string, movies: Movie[], series: Series[]): Promise<void> {
  try {
    const store = await contentChunkStore();
    if (!store) return;
    const extras: Extras = {
      movies: movies.slice(0, EXTRAS_LIMIT),
      series: series.slice(0, EXTRAS_LIMIT),
    };
    if (!extras.movies.length && !extras.series.length) return;
    await store.put(EXTRAS_PREFIX + providerId, JSON.stringify(extras));
    extrasCache.set(providerId, extras);
  } catch { /* a részletes metaadat nem kritikus */ }
}

export async function loadCatalogExtras(providerId: string): Promise<Extras> {
  const cached = extrasCache.get(providerId);
  if (cached) return cached;
  try {
    const store = await contentChunkStore();
    if (!store) return { movies: [], series: [] };
    const raw = await store.get(EXTRAS_PREFIX + providerId);
    if (!raw) return { movies: [], series: [] };
    const parsed = JSON.parse(raw) as Extras;
    const extras: Extras = {
      movies: Array.isArray(parsed.movies) ? parsed.movies : [],
      series: Array.isArray(parsed.series) ? parsed.series : [],
    };
    extrasCache.set(providerId, extras);
    return extras;
  } catch {
    return { movies: [], series: [] };
  }
}

const EXTRA_FIELDS = [
  'durationMinutes', 'plot', 'genres', 'rating', 'year', 'audioLanguages',
  'subtitleLanguages', 'audioTracks', 'subtitleTracks', 'backdrop', 'director', 'cast',
] as const;

function applyExtras<T extends { id: string }>(target: T[], extras: T[]): void {
  if (!extras.length) return;
  const byId = new Map(target.map((item) => [item.id, item]));
  for (const source of extras) {
    const item = byId.get(source.id) as Record<string, unknown> | undefined;
    if (!item) continue;
    for (const field of EXTRA_FIELDS) {
      const value = (source as Record<string, unknown>)[field];
      if (value !== undefined) item[field] = value;
    }
  }
}

export async function applyCatalogExtras(
  providerId: string, movies: Movie[], series: Series[]
): Promise<void> {
  if (!movies.length && !series.length) return;
  const extras = await loadCatalogExtras(providerId);
  applyExtras(movies, extras.movies);
  applyExtras(series, extras.series);
}

/* ----------------------------------------------- adagolt (chunked) mentés */

interface ChunkedSaveOptions {
  metaKey: string;
  legacyKey: string;
  legacyPrefix: string;
  generationPrefix: string;
  total: number;
  /** Egy adag sorainak elkészítése (a memória kímélése érdekében adagonként). */
  chunkRows: (index: number) => Row[];
  totals: { vod?: number; series?: number };
  cats: Row[];
  label: string;
  /** Csak az élő lista teljes másolatánál: a fejlécbe írt szolgáltató. */
  provider?: ProviderRef;
  savedAt?: string;
  liveTotal?: number;
}

/**
 * Nagy lista mentése adagokban.
 *
 * Előbb minden adag kiíródik, és csak a végén vált aktívvá az új lista
 * (meta). Egy megszakadt mentés így nem hagy hiányos listát: ilyenkor a
 * korábbi, teljes lista marad érvényben.
 */
async function saveChunked(options: ChunkedSaveOptions): Promise<void> {
  const chunkCount = Math.ceil(options.total / CHUNK_SIZE);
  const generationPrefix = options.generationPrefix + Date.now() + '-' + (++writeSequence) + '-';
  const previousKeys = readChunkKeys(options.metaKey, options.legacyPrefix);
  for (let index = 0; index < chunkCount; index++) activeGenerations.add(generationPrefix + index);

  let storedChunks = 0;
  let storedRows = 0;
  let stoppedAt = 0;
  try {
    for (let index = 0; index < chunkCount; index++) {
      const rows = options.chunkRows(index);
      const chunkKey = generationPrefix + index;
      let outcome = writeMeasured(chunkKey, { rows });
      if (!outcome.ok) {
        /*
         * A tároló megtelt – és a helyet éppen az ELŐZŐ generáció adagjai
         * foglalják. Ilyenkor fokozatosan szabadítjuk fel őket: ezek az adagok
         * amúgy is cserélődnek, a régi listát pedig éppen most írjuk újra.
         *
         * Enélkül egy megtelt tárolónál az új mentés már az ELSŐ adagnál
         * elhasalna, ezért a frissítés SOHA nem sikerülne – pontosan ezt
         * csinálta a 2.5.110-es build („újraindítom, újra és újra, akkor
         * sem sikerült”).
         */
        for (let extra = index; !outcome.ok && extra < previousKeys.length; extra += 1) {
          const staleKey = previousKeys[extra];
          if (!staleKey) continue;
          backend.remove(staleKey);
          outcome = writeMeasured(chunkKey, { rows });
        }
        if (!outcome.ok) {
          stoppedAt = index;
          break;
        }
      }
      storedChunks = index + 1;
      storedRows += outcome.rows;
      /*
       * AZ ELŐZŐ GENERÁCIÓ AZONOS SORSZÁMÚ ADAGJÁT CSAK MOST TÖRÖLJÜK.
       *
       * Korábban a régi adagok csak a TELJES, sikeres mentés után törlődtek,
       * ezért a mentés alatt a lista KÉT példányban volt bent a tárolóban.
       * A TV kicsi localStorage-kvótája ennek a felét sem bírta: a 2.5.110-es
       * napló szerint az élő lista a 16/51., a filmlista a 16/100. adagnál
       * elfogyott, a mentés teljesen elhasalt, és MINDEN indításkor újra le
       * kellett tölteni a 6,6 + 40,4 + 29,2 MB-ot – ezért volt rettenetes az
       * első indulás. Így a csúcshasználat ~1 teljes lista + 1 új adag.
       *
       * A törlés szándékosan az ÚJ adag sikeres írása UTÁN van: ha az írás
       * elhasal, a régi lista sértetlen marad.
       */
      const previousKey = previousKeys[index];
      if (previousKey) backend.remove(previousKey);
      /*
       * MINDEN adag után lélegzés. A korábbi „két adagonként” a 2.5.110-es
       * naplóban 4566 ms-os főszál-leállást eredményezett (HOSSZÚ FELADAT:
       * 3025 ms), azaz a mentés alatt a felület és a lejátszás megakadt.
       */
      await yieldToStorage();
    }

    if (chunkCount > 0 && storedChunks === 0) {
      throw new Error(
        `${options.label}: egyetlen adag sem menthető el – a tároló megtelt ` +
        `(${chunkCount} adag, ${options.total} elem).`
      );
    }

    /*
     * RÉSZLEGES MENTÉS IS ÉRVÉNYES MENTÉS.
     *
     * Ha a tároló elfogy, korábban az EGÉSZ mentés elhasalt, és a korábbi
     * (vagy üres) cache maradt – így a lista soha nem került a tárolóba, és
     * minden indítás 76 MB letöltéssel kezdődött. Most annyi adagot tartunk
     * meg, amennyi befért, és a fejléc is ennyit jegyez: a következő indulás
     * a mentett listával azonnal indul, és a napló megmondja, mi maradt ki.
     */
    /*
     * A FEJLÉCNEK MINDIG MARADJON HELY.
     *
     * A 3-as számú TV-napló (2.5.111) pontosan ezt mutatta: a tároló
     * `foglaltság=67 kulcs / 5060 kB`, azaz a ~5 MB-os kvóta teljesen
     * megtelt, és bár 16 adag sikeresen belement, maga a FEJLÉC már nem
     * fért el:
     *
     *   TÁROLÓ HIBA: content-vod-meta mentése végleg sikertelen; méret=5469
     *   Filmlista mentése sikertelen → a lista fejléce nem menthető el
     *
     * Fejléc nélkül viszont a 16 beírt adag HIÁBA van bent: a betöltő a
     * fejlécből tudná meg, hány adagot olvasson. Ilyenkor addig engedjük
     * vissza a legutolsó adagokat, amíg a fejléc belefér – így a mentés
     * kisebb, de TELJES és használható lesz.
     */
    const writeMeta = (chunks: number) => write(options.metaKey, {
      v: 1,
      totals: options.totals,
      cats: options.cats,
      chunks,
      chunkPrefix: generationPrefix,
    } satisfies ChunkMeta);
    let metaOk = writeMeta(storedChunks);
    while (!metaOk && storedChunks > 1) {
      storedChunks -= 1;
      backend.remove(generationPrefix + storedChunks);
      metaOk = writeMeta(storedChunks);
    }
    if (!metaOk) {
      throw new Error(`${options.label}: a lista fejléce nem menthető el – a tároló megtelt.`);
    }
  } catch (error) {
    for (let index = 0; index < chunkCount; index++) {
      backend.remove(generationPrefix + index);
      activeGenerations.delete(generationPrefix + index);
    }
    appLogError(`${options.label} mentése sikertelen`, error);
    throw error;
  }
  for (let index = 0; index < chunkCount; index++) activeGenerations.delete(generationPrefix + index);

  // A régi adagok és a régi, egykulcsos változat többé nem hivatkozott.
  backend.remove(options.legacyKey);
  for (const key of previousKeys) backend.remove(key);
  if (stoppedAt > 0 && storedChunks < chunkCount) {
    appLog(
      `TÁROLÓ FIGYELEM: ${options.label} – a tároló a ${stoppedAt + 1}/${chunkCount}. adagnál megtelt, ` +
      `ezért ${storedChunks} adag (${storedRows} elem) került mentésre a ${options.total} elemből. ` +
      `A lista így is használható és a következő indulásnál azonnal betöltődik; ` +
      `a kimaradt rész a szolgáltatótól érkezik, ha újra frissítesz. Foglaltság=${describeStorageUsage()}.`
    );
  } else {
    appLog(
      `${options.label} elmentve: ${storedRows} elem, ${storedChunks} adag, tároló=${backend.name}`
    );
  }
}

/** A korábbi adagok kulcsainak összegyűjtése (törléshez). */
function readChunkKeys(metaKey: string, legacyPrefix: string): string[] {
  const keys: string[] = [];
  try {
    const raw = backend.get(metaKey);
    if (!raw) return keys;
    const meta = JSON.parse(raw) as ChunkMeta;
    const prefix = typeof meta.chunkPrefix === 'string' && meta.chunkPrefix ? meta.chunkPrefix : legacyPrefix;
    const count = Number(meta.chunks) || 0;
    for (let index = 0; index < count; index++) keys.push(prefix + index);
  } catch {
    /* régi vagy sérült metaadat */
  }
  return keys;
}

/**
 * A tároló kitakarítása – INDULÁSKOR egyszer.
 *
 * Ha az alkalmazás mentés közben állt le (kikapcsolt TV, áramszünet), a félbe
 * maradt generáció adagjai bent ragadhatnak a localStorage-ban, és a TV kis
 * kvótájából több száz kilobájtot foglalnak örökre. Ezért induláskor
 * összegyűjtjük az ÉRVÉNYES adagkulcsokat (a három metaadat-fejléc alapján),
 * és minden más, tartalomhoz tartozó kulcsot törlünk. Csak a saját
 * `content-*` kulcsainkhoz nyúlunk, a beállításokhoz és a kedvencekhez nem.
 */
export function sweepStorage(): number {
  const keep = new Set<string>();
  const metas: Array<[string, string]> = [
    [LIVE_META_KEY, LIVE_CHUNK_PREFIX],
    [VOD_META_KEY, VOD_CHUNK_PREFIX],
    [SERIES_META_KEY, SERIES_CHUNK_PREFIX],
  ];
  for (const [metaKey, legacyPrefix] of metas) {
    for (const key of readChunkKeys(metaKey, legacyPrefix)) keep.add(key);
  }
  const prefixes = [
    LIVE_GENERATION_PREFIX, VOD_GENERATION_PREFIX, SERIES_GENERATION_PREFIX,
    LIVE_CHUNK_PREFIX, VOD_CHUNK_PREFIX, SERIES_CHUNK_PREFIX,
  ];
  let removed = 0;
  try {
    for (const key of backend.keys()) {
      if (activeGenerations.has(key) || keep.has(key)) continue;
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        backend.remove(key);
        removed++;
      }
    }
  } catch {
    /* a takarítás hibája nem akadályozhatja az indulást */
  }
  if (removed > 0) appLog(`Tároló takarítás: ${removed} elárvult adag törölve.`);
  return removed;
}

/**
 * Elárvult generációk törlése a tartós tárból – kvótahiba esetén.
 *
 * A referencia idb-cache.ts `ensureCapacity()` / `pruneBytes()` logikája: a
 * gyorsítótár nem nőhet a végtelenségig, mert minden frissítés új generációt
 * ír. A fejlécek által mutatott AKTÍV adagokat soha nem töröljük.
 */
async function pruneIdbGenerations(store: ChunkStore, keepPrefixes: string[]): Promise<number> {
  try {
    const keys = await store.keys();
    const stale = keys.filter((key) =>
      (key.startsWith(LIVE_FULL_GENERATION_PREFIX)
        || key.startsWith(VOD_GENERATION_PREFIX)
        || key.startsWith(SERIES_GENERATION_PREFIX))
      && !keepPrefixes.some((prefix) => key.startsWith(prefix)));
    if (!stale.length) return 0;
    await store.removeMany(stale);
    appLog(`Tároló: ${stale.length} régi adag felszabadítva a kvóta miatt.`);
    return stale.length;
  } catch {
    return 0;
  }
}

/**
 * Egy TELJES katalógus mentése a tartós tárba – KÖTEGELVE, ATOMIKUS FEJLÉCCEL.
 *
 * A korábbi változat minden adagot külön tranzakcióban írt (102 824 filmnél
 * 257 tranzakció), és a fejlécet csak a legvégén, több tíz másodperccel később.
 * Ha a néző közben bezárta az alkalmazást – márpedig a napló szerint így történt –,
 * a fejléc nem íródott ki: a következő indulás üres tárat talált, és újra
 * letöltött MINDENT. Ez volt a „minden indításkor újra letölti” hiba oka.
 *
 * Most:
 *   • 12 adag / tranzakció → 8 tranzakció a 86 adaghoz (másodpercek alatt kész);
 *   • a fejléc UTOLSÓ tranzakcióként íródik: félbeszakadáskor a régi, ÉP lista marad;
 *   • kvótahiba esetén a régi generációk felszabadításával egyszer újrapróbáljuk;
 *   • a mentés MINDEN lépése naplózva van, így a TV-n is látszik, hol tart.
 */
async function saveChunkedToIdb(store: ChunkStore, options: ChunkedSaveOptions): Promise<boolean> {
  const chunkCount = Math.ceil(options.total / CHUNK_SIZE);
  if (chunkCount === 0) {
    // Üres lista: a fejléc akkor is íródjon ki, hogy a régi, már nem érvényes
    // listát ne szolgáljuk ki. Nincs félkész adag, nincs félrevezető hibanapló.
    const emptyMeta: ChunkMeta = {
      v: 1, totals: options.totals, cats: options.cats, chunks: 0,
      chunkPrefix: '', savedAtMs: Date.now(),
    };
    return await store.putMany([{ key: options.metaKey, value: JSON.stringify(emptyMeta) }]);
  }
  const startedAt = Date.now();
  const generationPrefix = options.generationPrefix + Date.now() + '-' + (++writeSequence) + '-';
  const writtenKeys: string[] = [];
  let quotaRetried = false;
  const writeBatch = async (batch: ChunkEntry[]): Promise<boolean> => {
    const ok = await store.putMany(batch);
    if (ok) return true;
    if (quotaRetried) return false;
    quotaRetried = true;
    // Aktív generációk fejlécei: ezeket a takarítás nem érintheti.
    const keep: string[] = [generationPrefix];
    for (const metaKey of [LIVE_FULL_META_KEY, VOD_META_KEY, SERIES_META_KEY]) {
      const active = await readIdbChunks(store, metaKey);
      if (active) keep.push(active.meta.chunkPrefix);
    }
    await pruneIdbGenerations(store, keep);
    return await store.putMany(batch);
  };

  try {
    let batch: ChunkEntry[] = [];
    let approxBytes = 0;
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      if (!(await writeBatch(batch))) throw new Error('IndexedDB kötegelt írás sikertelen');
      writtenKeys.push(...batch.map((entry) => entry.key));
      batch = [];
      // A főszálat a kötegek között visszaadjuk: a lejátszás nem akad meg.
      await yieldToStorage();
    };
    for (let index = 0; index < chunkCount; index++) {
      const text = JSON.stringify({ rows: options.chunkRows(index) });
      approxBytes += text.length;
      batch.push({ key: generationPrefix + index, value: text });
      if (batch.length >= IDB_BATCH_SIZE) await flush();
    }
    await flush();

    const budget = await storageBudgetBytes();
    if (budget.quotaBytes && approxBytes > budget.quotaBytes * 0.9) {
      appLog(
        `TÁROLÓ FIGYELEM: ${options.label} ~${(approxBytes / 1024 / 1024).toFixed(1)} MB, `
        + `a becsült keret ${(budget.quotaBytes / 1024 / 1024).toFixed(0)} MB; a régi adagokat eltávolítjuk.`
      );
    }

    const meta: ChunkMeta = {
      v: 1,
      totals: options.totals,
      cats: options.cats,
      chunks: chunkCount,
      chunkPrefix: generationPrefix,
      savedAtMs: Date.now(),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.savedAt ? { savedAt: options.savedAt } : {}),
      ...(options.liveTotal !== undefined ? { liveTotal: options.liveTotal } : {}),
    };
    // FEJLÉC UTOLSÓKÉNT: ettől a pillanattól él az új lista. Ha bármelyik
    // fenti lépés meghiúsult, ide nem jutunk el, és a régi lista érvényes marad.
    // A fejlécet is tranzakció-zárással írjuk (nem csak a request sikerével):
    // így a bezárás pillanatában BIZTOSAN a lemezen van.
    if (!(await store.putMany([{ key: options.metaKey, value: JSON.stringify(meta) }]))) {
      throw new Error('IndexedDB fejléc sikertelen');
    }
    // A frissességi bélyeg azonnal frissül: ha a néző EZUTÁN zárja be az
    // alkalmazást, a következő indulás már tudja, hogy van kész listája.
    const section = options.metaKey === LIVE_FULL_META_KEY ? 'live'
      : options.metaKey === VOD_META_KEY ? 'vod'
        : options.metaKey === SERIES_META_KEY ? 'series' : null;
    if (section) noteSectionSaved(section, options.total, options.provider || null, meta.savedAtMs || Date.now());
    appLog(
      `${options.label} TARTÓSAN elmentve: ${options.total} elem, ${chunkCount} adag, `
      + `~${(approxBytes / 1024 / 1024).toFixed(1)} MB, ${Date.now() - startedAt} ms.`
    );
  } catch (error) {
    await store.removeMany(writtenKeys);
    appLogError(`${options.label} tartós mentése nem sikerült`, error);
    appLog(`Tároló: a korábbi, mentett ${options.label} változatlanul érvényben marad.`);
    return false;
  }

  // CSAK a sikeres fejléc után: a régi generációk már nem kellenek.
  try {
    const keys = await store.keys();
    const stale = keys.filter((key) =>
      key.startsWith(options.generationPrefix) && !key.startsWith(generationPrefix));
    if (stale.length) await store.removeMany(stale);
    await store.remove(options.legacyKey);
  } catch { /* a takarítás hibája nem veszélyezteti a friss mentést */ }
  return true;
}

/**
 * Mentés a lehető legjobb helyre: a TARTÓS IndexedDB-be.
 *
 * Ha a tartós tár épp nem írható, a több száz ezres listát NEM erőltetjük a
 * ~5 MB-os localStorage-ba (az pontosan a régi kvótahibát idézné elő, és
 * több ezer felesleges naplósort generálna). Ilyenkor a korábbi, ÉP cache
 * marad, és a következő írás újra megpróbálja.
 */
/*
 * Ha a tartós tár átmenetileg nem elérhető, a kis/közepes listák még
 * elférnek a localStorage-ban. A VALÓDI katalógus (102 824 film) viszont
 * NEM: annak erőltetése pontosan a régi, több ezer kvótahibás naplósort
 * és a 76 MB-os újratöltést okozta. 60 000 sor a határ: efelett inkább a
 * korábbi, ÉP listát őrizzük meg.
 */
const LOCAL_FALLBACK_MAX_ROWS = 60000;
async function saveChunkedAuto(options: ChunkedSaveOptions): Promise<void> {
  const store = await contentChunkStore();
  if (store) {
    if (await saveChunkedToIdb(store, options)) {
      for (const key of readChunkKeys(options.metaKey, options.legacyPrefix)) backend.remove(key);
      backend.remove(options.metaKey);
      return;
    }
    /*
     * A tartós tár LÉTEZIK, de az írás most hibázott (kvóta, zárt
     * kapcsolat). Ilyenkor NEM írjuk át a listát a 5 MB-os localStorage-ba:
     * az pontosan a régi, több ezer kvótahibás naplósort idézné elő, és
     * kiszorítaná a beállításokat. A KORÁBBI, ÉP lista marad érvényben, és
     * a következő mentés (frissebb kapcsolattal) újra megpróbálja.
     */
    appLog(
      `TÁROLÓ FIGYELEM: ${options.label} (${options.total} elem) most nem írható a tartós tárba; `
      + 'a korábbi, ép mentett lista marad. A nagy listát nem írjuk a kis localStorage-ba.'
    );
    return;
  }
  // Csak akkor használjuk a localStorage-t, ha EGYÁLTALÁN nincs IndexedDB.
  if (options.total > LOCAL_FALLBACK_MAX_ROWS) {
    appLog(
      `TÁROLÓ FIGYELEM: ${options.label} (${options.total} elem) nem fér a rendelkezésre álló tárba; `
      + 'a korábbi mentett lista marad, nincs félkész átírás.'
    );
    return;
  }
  await saveChunked(options);
}

/** Adagok olvasása IndexedDB-ből (ha van ott érvényes lista). */
async function readIdbChunks(
  store: ChunkStore,
  metaKey: string
): Promise<{ meta: ChunkMeta; readChunk: (index: number) => Promise<Row[]> } | null> {
  const raw = await store.get(metaKey);
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw) as ChunkMeta;
    if (!meta || typeof meta.chunks !== 'number' || typeof meta.chunkPrefix !== 'string') return null;
    return {
      meta,
      readChunk: async (index) => {
        const chunk = await store.get(meta.chunkPrefix + index);
        if (!chunk) return [];
        try {
          const parsed = JSON.parse(chunk) as { rows?: Row[] };
          return Array.isArray(parsed.rows) ? parsed.rows : [];
        } catch {
          return [];
        }
      },
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------ biztonságos mentés */

/*
 * A TÁROLÁS HIBÁJA NEM BETÖLTÉSI HIBA.
 *
 * Az 1-es TV-napló (2.5.114) ezt mutatta a képernyőn:
 *
 *   BETÖLTÉSI HIBA
 *   Sorozatlista: egyetlen adag sem menthető el – a tároló megtelt
 *                 (38 adag, 15000 elem).
 *
 * Pedig a letöltés SIKERES volt: 107 csatorna, 40 000 film, 15 000 sorozat
 * megérkezett, és a felület használható. Csak a cache nem fért be. Egy
 * gyorsítótár hibája nem teheti tönkre a betöltést: itt minden mentés külön
 * védett, a hiba a naplóba kerül, a felület pedig sikeres betöltést lát.
 */
export function saveLiveContentSafely(content: ImportedContent): void {
  try {
    saveLiveContent(content);
  } catch (error) {
    appLogError('Élő csatornák mentése (nem végzetes)', error);
  }
}

export async function saveVodContentSafely(content: ImportedContent): Promise<void> {
  try {
    await saveVodContent(content);
  } catch (error) {
    appLogError('Filmlista mentése (nem végzetes)', error);
  }
}

export async function saveSeriesContentSafely(content: ImportedContent): Promise<void> {
  try {
    await saveSeriesContent(content);
  } catch (error) {
    appLogError('Sorozatlista mentése (nem végzetes)', error);
  }
}

/** A sorozatmentések sorban futnak, nem írhatják felül egymás félkész adagjait. */
export function saveSeriesContent(content: ImportedContent): Promise<void> {
  const task = seriesSaveQueue.then(() => saveChunkedAuto({
    metaKey: SERIES_META_KEY,
    legacyKey: SERIES_KEY,
    legacyPrefix: SERIES_CHUNK_PREFIX,
    generationPrefix: SERIES_GENERATION_PREFIX,
    total: content.series.length,
    chunkRows: (index) => encodeSeries(content.series.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)),
    totals: { series: content.totals.series },
    cats: encodeCategories(content.seriesCategories),
    label: 'Sorozatlista',
    provider: content.provider,
  })).catch((error) => {
    appLogError('Sorozatlista mentése', error);
    throw error;
  });
  seriesSaveQueue = task.catch(() => undefined);
  return task;
}

/** Csak a filmek mentése (adagolva, hogy ne legyen nagy memóriacsúcs). */
export function saveVodContent(content: ImportedContent): Promise<void> {
  const task = vodSaveQueue.then(() => saveChunkedAuto({
    metaKey: VOD_META_KEY,
    legacyKey: VOD_KEY,
    legacyPrefix: VOD_CHUNK_PREFIX,
    generationPrefix: VOD_GENERATION_PREFIX,
    total: content.movies.length,
    chunkRows: (index) => encodeMovies(content.movies.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)),
    totals: { vod: content.totals.vod },
    cats: encodeCategories(content.vodCategories),
    label: 'Filmlista',
    provider: content.provider,
  })).catch((error) => {
    appLogError('Filmlista mentése', error);
    throw error;
  });
  vodSaveQueue = task.catch(() => undefined);
  return task;
}

export async function saveContent(content: ImportedContent): Promise<void> {
  // Előbb engedjük kirajzolódni a felületet, csak utána induljon a mentés.
  await yieldToStorage();
  logMemory('mentés előtt');
  // A mentések között szünetet tartunk, hogy a menü és a lejátszás ne álljon meg.
  await saveLiveContentAsync(content);
  await yieldToStorage();
  await saveVodContent(content);
  await yieldToStorage();
  await saveSeriesContent(content);
  await saveCatalogExtras(content.provider.id, content.movies, content.series);
  logMemory('mentés után');
}

/* ------------------------------------------------ adagolt (chunked) betöltés */

interface ChunkedReadResult {
  /** Igaz, ha adagolt (meta) tárolóból olvastunk. */
  chunked: boolean;
  chunks: number;
  /** A hiányzó adagok sorszámai. */
  missing: number[];
  /** Adagonkénti feldolgozás: a nyers adag a visszatérés után felszabadul. */
  readChunk: (index: number) => Row[];
}

function openChunked(metaKey: string, legacyPrefix: string): ChunkedReadResult | null {
  const raw = backend.get(metaKey);
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw) as ChunkMeta;
    const prefix = typeof meta.chunkPrefix === 'string' && meta.chunkPrefix ? meta.chunkPrefix : legacyPrefix;
    return {
      chunked: true,
      chunks: Number(meta.chunks) || 0,
      missing: [],
      readChunk: (index) => {
        const chunkRaw = backend.get(prefix + index);
        if (!chunkRaw) return [];
        try {
          const parsed = JSON.parse(chunkRaw) as { rows?: Row[] };
          return Array.isArray(parsed.rows) ? parsed.rows : [];
        } catch (error) {
          appLogError(`Adag feldolgozása (${index + 1})`, error);
          return [];
        }
      },
    };
  } catch (error) {
    appLogError('Lista fejlécének feldolgozása', error);
    return null;
  }
}

/** A metaadat kategóriái (a hívó a saját típusára alakítja). */
function readChunkedCategories(metaKey: string, type: 'movie' | 'series'): Category[] {
  try {
    const raw = backend.get(metaKey);
    if (!raw) return [];
    const meta = JSON.parse(raw) as ChunkMeta;
    return decodeCategories(meta.cats, type);
  } catch {
    return [];
  }
}

/* ------------------------------------------------- M3U/M3U8 nyers lista */

const RAW_PREFIX = 'm3u-raw-';

/**
 * A beillesztett/feltöltött M3U lista szövegének eltárolása. Így a későbbi
 * „Frissítés” ugyanezt a listát dolgozza fel újra, link nélkül is.
 */
export function saveRawPlaylist(providerId: string, text: string): boolean {
  return backend.put(RAW_PREFIX + providerId, text);
}

export function loadRawPlaylist(providerId: string): string {
  return backend.get(RAW_PREFIX + providerId) || '';
}

export interface StoredSummary {
  provider: ProviderRef;
  savedAt: string;
  totals: { live: number; vod: number; series: number };
}

export function readSummary(): StoredSummary | null {
  const metaRaw = backend.get(LIVE_META_KEY);
  const raw = metaRaw || backend.get(LIVE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LiveChunkMeta | LivePart;
    if (!parsed || !parsed.provider) return null;
    const legacyRows = 'rows' in parsed ? parsed.rows : [];
    return {
      provider: parsed.provider,
      savedAt: parsed.savedAt || '',
      totals: parsed.totals || { live: legacyRows?.length || 0, vod: 0, series: 0 },
    };
  } catch {
    return null;
  }
}

export interface LoadedLive {
  channels: Channel[];
  categories: Category[];
  savedAt: string;
  provider: ProviderRef | null;
  totals: { live: number; vod: number; series: number };
  /**
   * Igaz, ha a fejléc szerint VAN mentett lista, de a localStorage-ból nem
   * sikerült kiolvasni (sérült/kvótahiba miatt eltűnt adagok). Ilyenkor a
   * teljes lista az IndexedDB-ből tölthető vissza – a hívó ezt azonnal
   * megpróbálja, hogy az alkalmazás ne induljon üresen.
   */
  pendingFull?: boolean;
}

export function loadLive(): LoadedLive {
  const empty: LoadedLive = {
    channels: [],
    categories: [],
    savedAt: '',
    provider: null,
    totals: { live: 0, vod: 0, series: 0 },
  };
  const metaRaw = backend.get(LIVE_META_KEY);
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw) as LiveChunkMeta;
      if (meta.provider && Number.isFinite(meta.chunks) && meta.chunks >= 0) {
        const channels: Channel[] = [];
        let missing = 0;
        for (let index = 0; index < meta.chunks; index++) {
          const rawChunk = backend.get(meta.chunkPrefix + index);
          if (!rawChunk) { missing++; continue; }
          try {
            const parsedChunk = JSON.parse(rawChunk) as { rows?: Row[] };
            if (Array.isArray(parsedChunk.rows)) channels.push(...decodeChannels(parsedChunk.rows, meta.provider));
            else missing++;
          } catch {
            missing++;
          }
        }
        if (missing) {
          appLog('Élő csatornalista: ' + missing + '/' + meta.chunks + ' adag hiányzik a cache-ből.');
        }
        if (channels.length === 0 && meta.chunks > 0) {
          // A fejléc megvan, de egyetlen adag sem olvasható: a korábbi mentés
          // félbeszakadt. A teljes lista az IndexedDB-ben lehet – jelezzük.
          appLog(
            `TÁROLÓ HIBA: az élő csatornalista fejléce megvan (${meta.chunks} adag), `
            + 'de egyetlen adag sem olvasható a localStorage-ból; a teljes lista az IndexedDB-ből töltődik vissza.'
          );
          return {
            channels: [],
            categories: decodeCategories(meta.cats, 'live'),
            savedAt: meta.savedAt || '',
            provider: meta.provider,
            totals: meta.totals || { live: 0, vod: 0, series: 0 },
            pendingFull: true,
          };
        }
        if (channels.length || meta.chunks === 0) {
          return {
            channels,
            categories: decodeCategories(meta.cats, 'live'),
            savedAt: meta.savedAt || '',
            provider: meta.provider,
            totals: meta.totals || { live: channels.length, vod: 0, series: 0 },
          };
        }
      }
    } catch (error) {
      appLogError('Élő lista adagolt fejlécének feldolgozása', error);
    }
  }

  // Kompatibilitás a korábbi, egyetlen kulcsba mentett cache-sel.
  const raw = backend.get(LIVE_KEY);
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as LivePart;
    return {
      channels: decodeChannels(parsed.rows, parsed.provider),
      categories: decodeCategories(parsed.cats, 'live'),
      savedAt: parsed.savedAt || '',
      provider: parsed.provider || null,
      totals: parsed.totals || { live: parsed.rows?.length || 0, vod: 0, series: 0 },
    };
  } catch (error) {
    appLogError('Élő lista betöltése', error);
    return empty;
  }
}

/* --------------------------------------- teljes élő lista (IndexedDB) */

export interface LoadedLiveFull {
  channels: Channel[];
  categories: Category[];
  provider: ProviderRef | null;
  savedAt: string;
  totals: { live: number; vod: number; series: number };
}

/**
 * A TELJES élő csatornalista visszaolvasása az IndexedDB-ből.
 *
 * A localStorage-ban csak az induló (magyar) készlet van, ezért a többi ország
 * csatornái innen – helyben, hálózat nélkül – kerülnek vissza a felületre.
 * Adagonként dolgozunk, adagok között visszaadjuk a vezérlést a fő szálnak,
 * hogy a lejátszás ne akadjon meg.
 */
export async function loadLiveFull(
  provider?: ProviderRef | null,
  onProgress?: (loaded: number) => void,
): Promise<LoadedLiveFull | null> {
  const store = await contentChunkStore();
  if (!store) return null;
  const chunked = await readIdbChunks(store, LIVE_FULL_META_KEY);
  if (!chunked) return null;
  const storedProvider = chunked.meta.provider || provider || null;
  if (!storedProvider) return null;
  const channels: Channel[] = [];
  for (let index = 0; index < chunked.meta.chunks; index++) {
    const rows = await chunked.readChunk(index);
    for (const channel of decodeChannels(rows, storedProvider)) channels.push(channel);
    onProgress?.(channels.length);
    if (index % 4 === 3) await yieldToStorage();
  }
  if (channels.length === 0) return null;
  const totals = {
    live: chunked.meta.liveTotal || channels.length,
    vod: chunked.meta.totals?.vod || 0,
    series: chunked.meta.totals?.series || 0,
  };
  appLog(
    `Teljes élő csatornalista betöltve (IndexedDB): ${channels.length} csatorna, `
    + `${chunked.meta.chunks} adag.`
  );
  return {
    channels,
    categories: decodeCategories(chunked.meta.cats, 'live'),
    provider: storedProvider,
    savedAt: chunked.meta.savedAt || '',
    totals,
  };
}

/**
 * INDULÓ KÉSZLET – ELSŐSORBAN AZ INDEXEDDB-BŐL.
 *
 * A hideg indítás eddig KIZÁRÓLAG a localStorage-ból olvasott. A webOS-os
 * TV-naplók szerint viszont ez a tár nem megbízható hosszú távon (kis kvóta,
 * amit a beállítások, a kézi napló és a gyorsítótárak is használnak), ezért a
 * korábbi lista eltűnhet. Ilyenkor a program üresnek látta magát, és a
 * szolgáltatótól AZONNAL újratöltötte a teljes katalógust – pontosan az a
 * viselkedés, ami elfogadhatatlan.
 *
 * A teljes (és a magyarokkal kezdődő) élő lista viszont az IndexedDB-ben van,
 * ami nagyobb kvótával, önállóan tárol. Ezért induláskor:
 *   1. a localStorage-ból olvasunk (a leggyorsabb, szinkron út);
 *   2. ha onnan nincs használható lista, az IndexedDB fejlécéből és első
 *      adagjaiból állítjuk össze az induló készletet (a mentett sorrend
 *      magyar-első, ezért az első adagok a magyar csatornákat tartalmazzák);
 *   3. csak ha ott sincs semmi, akkor kell a szolgáltatótól letölteni.
 *
 * Az olvasás aszinkron, de néhány adag (≈1000 csatorna) beolvasása a TV-n is
 * gyors; a hívó a takarókép alatt várja meg, így a főoldal már kész listával
 * jelenik meg, hálózat nélkül.
 */
export async function loadLiveBoot(): Promise<LoadedLive> {
  const local = loadLive();
  if (local.provider && local.channels.length > 0) return local;

  let store: ChunkStore | null = null;
  try {
    store = await contentChunkStore();
  } catch {
    store = null;
  }
  if (!store) return local;

  let chunked: Awaited<ReturnType<typeof readIdbChunks>> = null;
  try {
    chunked = await readIdbChunks(store, LIVE_FULL_META_KEY);
  } catch {
    chunked = null;
  }
  if (!chunked || !chunked.meta.provider) return local;

  const provider = chunked.meta.provider;
  const channels: Channel[] = [];
  const limit = Math.max(1, Math.min(chunked.meta.chunks, LIVE_BOOT_IDB_CHUNKS));
  for (let index = 0; index < limit; index++) {
    const rows = await chunked.readChunk(index);
    for (const channel of decodeChannels(rows, provider)) channels.push(channel);
    await yieldToStorage();
  }
  if (channels.length === 0) return local;

  const liveTotal = chunked.meta.liveTotal || local.totals.live || channels.length;
  appLog(
    `Induló készlet az IndexedDB-ből: ${channels.length} csatorna `
    + `(a teljes lista ${liveTotal} csatorna, ${chunked.meta.chunks} adag) – nincs letöltés.`
  );
  return {
    channels,
    categories: decodeCategories(chunked.meta.cats, 'live'),
    savedAt: chunked.meta.savedAt || local.savedAt,
    provider,
    totals: {
      live: liveTotal,
      vod: chunked.meta.totals?.vod || local.totals.vod || 0,
      series: chunked.meta.totals?.series || local.totals.series || 0,
    },
    pendingFull: channels.length < liveTotal,
  };
}

/**
 * TÁROLÓ-JELENTÉS az induláshoz (naplóba, csak kézi naplózás alatt).
 *
 * Megmutatja, hol van a katalógus: hány kulcs és hány karakter van a
 * localStorage-ban, illetve hány csatorna/film/sorozat van az IndexedDB-ben.
 * Ebből egyetlen sorral megállapítható, hogy egy újraindítás után miért nem
 * volt használható a mentett lista.
 */
export interface StorageReport {
  localKeys: number;
  localChars: number;
  liveLocal: number;
  liveIdb: number;
  vodIdb: number;
  seriesIdb: number;
  bootChars: number;
}

/**
 * AZ UTOLSÓ TÁROLÓ-JELENTÉS – NINCS KÉTSZERES IDB-BEJÁRÁS (2.5.131).
 *
 * A 22:32:49-es naplóban az üres indulás +1889…+2705 ms között kétszer is
 * végigjárta az IndexedDB metaadatokat: `inspectStoredCatalogs()` belülről
 * hívta a `describeStoredContent()`-ot, majd az App boot-effektje – mivel a
 * plan üres volt – MÉG EGYSZER meghívta. Ez 3 felesleges IDB-olvasás és egy
 * újabb localStorage-bejárás volt közvetlenül az első festés előtt.
 *
 * A felmérés minden híváskor FRISS jelentést készít, és eltárolja; az App
 * ezt az értéket használja fel, amikor nincs plan. Így nincs sem második
 * bejárás, sem elavult gyorsítótár: import/frissítés után a következő
 * felmérés felülírja. A többi hívó (tesztek, kézi frissítés) továbbra is a
 * saját, friss `describeStoredContent()`-ját kapja.
 */
let lastStorageReport: StorageReport | null = null;
export function lastStoredContentReport(): StorageReport | null {
  return lastStorageReport;
}

export async function describeStoredContent(): Promise<StorageReport> {
  const report: StorageReport = {
    localKeys: 0, localChars: 0, liveLocal: 0, liveIdb: 0, vodIdb: 0, seriesIdb: 0, bootChars: 0,
  };
  try {
    for (const key of backend.keys()) {
      report.localKeys += 1;
      report.localChars += key.length + (backend.get(key) || '').length;
    }
  } catch {
    /* a felsorolás hibája nem akadályozhatja az indulást */
  }
  try {
    const live = loadLive();
    report.liveLocal = live.channels.length;
  } catch {
    /* sérült fejléc */
  }
  try {
    const store = await contentChunkStore();
    if (store) {
      const live = await readIdbChunks(store, LIVE_FULL_META_KEY);
      if (live) report.liveIdb = live.meta.liveTotal || live.meta.chunks * CHUNK_SIZE;
      const vod = await readIdbChunks(store, VOD_META_KEY);
      if (vod) report.vodIdb = vod.meta.totals?.vod || vod.meta.chunks * CHUNK_SIZE;
      const series = await readIdbChunks(store, SERIES_META_KEY);
      if (series) report.seriesIdb = series.meta.totals?.series || series.meta.chunks * CHUNK_SIZE;
    }
  } catch {
    /* az IndexedDB hibája nem akadályozhatja az indulást */
  }
  try {
    const raw = backend.get(LIVE_META_KEY);
    report.bootChars = raw ? raw.length : 0;
  } catch {
    /* nincs fejléc */
  }
  return report;
}

/**
 * Igaz, ha a localStorage-ban még a RÉGI, teljes lista van (átállás előtti
 * mentés), vagyis a kicsinyítés még nem futott le. Ilyenkor indulás után
 * egyszer újramentjük: magyar készlet a localStorage-ba, teljes lista az
 * IndexedDB-be – és ezzel a ~3,9 MB felszabadul a kvótából.
 */
export function needsLiveCacheCompaction(): boolean {
  const raw = backend.get(LIVE_META_KEY);
  if (!raw) return false;
  try {
    const meta = JSON.parse(raw) as LiveChunkMeta;
    return typeof meta.boot !== 'number';
  } catch {
    return false;
  }
}

/* -------------------------------------------------- régi (egy kulcsos) tár */
/*
 * A korábbi verziók a film- és sorozatlistát EGYETLEN kulcsban mentették.
 * Ezek a visszatöltők ezt a formátumot olvassák, hogy egy frissítés után se
 * vesszen el a felhasználó listája. (Korábban a hívások megmaradtak, a
 * függvények viszont nem – ezért a betöltés ReferenceError-ral elszállt.)
 */

function loadLegacyVod(provider: ProviderRef): { movies: Movie[]; categories: Category[] } {
  const raw = backend.get(VOD_KEY);
  if (!raw) return { movies: [], categories: [] };
  try {
    const parsed = JSON.parse(raw) as VodPart;
    return {
      movies: decodeMovies(Array.isArray(parsed.rows) ? parsed.rows : [], provider),
      categories: decodeCategories(parsed.cats, 'movie'),
    };
  } catch (error) {
    appLogError('A régi filmlista betöltése', error);
    return { movies: [], categories: [] };
  }
}

function loadLegacySeries(provider: ProviderRef): { series: Series[]; categories: Category[] } {
  const raw = backend.get(SERIES_KEY);
  if (!raw) return { series: [], categories: [] };
  try {
    const parsed = JSON.parse(raw) as SeriesPart;
    return {
      series: decodeSeries(Array.isArray(parsed.rows) ? parsed.rows : [], provider),
      categories: decodeCategories(parsed.cats, 'series'),
    };
  } catch (error) {
    appLogError('A régi sorozatlista betöltése', error);
    return { series: [], categories: [] };
  }
}

/** Filmlista betöltése szinkron (kis listákhoz, tesztekhez). */
export function loadVod(provider: ProviderRef): { movies: Movie[]; categories: Category[] } {
  const meta = openChunked(VOD_META_KEY, VOD_CHUNK_PREFIX);
  if (!meta) return loadLegacyVod(provider);
  const movies: Movie[] = [];
  let offset = 0;
  for (let index = 0; index < meta.chunks; index++) {
    const rows = meta.readChunk(index);
    for (const movie of decodeMovies(rows, provider, offset)) movies.push(movie);
    offset += rows.length;
  }
  const categories = readChunkedCategories(VOD_META_KEY, 'movie');
  if (movies.length === 0) {
    const legacy = loadLegacyVod(provider);
    if (legacy.movies.length > 0) return legacy;
  }
  return { movies, categories };
}

export async function loadVodAsync(
  provider: ProviderRef,
  onProgress?: (loaded: number, total: number) => void
): Promise<{ movies: Movie[]; categories: Category[] }> {
  /*
   * EGYSZERI VISSZAFEJTÉS. A korábbi kód ugyanazt a 100 ezres listát az
   * indulásnál akár háromszor is végigdekódolta (tároló-próba, 1,2 mp-es
   * idle, majd a Mozi nézet megnyitása). A gyorsítótár-kulcs a tároló
   * generációja: egy új mentés után automatikusan újraolvassuk.
   */
  const idb = await contentChunkStore();
  let cacheKey = `vod|${provider.id}|legacy`;
  if (idb) {
    const chunked = await readIdbChunks(idb, VOD_META_KEY);
    if (chunked) {
      cacheKey = `vod|${provider.id}|${chunked.meta.chunkPrefix}`;
      const cached = decodedCache.get(cacheKey) as { movies: Movie[]; categories: Category[] } | undefined;
      if (cached) {
        onProgress?.(cached.movies.length, cached.movies.length);
        return cached;
      }
      const movies: Movie[] = [];
      let offset = 0;
      for (let index = 0; index < chunked.meta.chunks; index++) {
        const rows = await chunked.readChunk(index);
        for (const movie of decodeMovies(rows, provider, offset)) movies.push(movie);
        offset += rows.length;
        onProgress?.(offset, chunked.meta.chunks * CHUNK_SIZE);
        if (index % 4 === 3) await yieldToStorage();
      }
      if (movies.length > 0) {
        const categories = decodeCategories(chunked.meta.cats, 'movie');
        await applyCatalogExtras(provider.id, movies, []);
        appLog(`Filmlista visszatöltve a tartós tárból: ${movies.length} film, ${chunked.meta.chunks} adag`);
        const result = { movies, categories };
        rememberDecoded(provider.id, 'vod', cacheKey, result);
        return result;
      }
    }
  }
  const meta = openChunked(VOD_META_KEY, VOD_CHUNK_PREFIX);
  if (!meta) {
    const legacy = loadLegacyVod(provider);
    await applyCatalogExtras(provider.id, legacy.movies, []);
    appLog(`Filmlista betöltve (régi tároló): ${legacy.movies.length} film`);
    return legacy;
  }
  cacheKey = `vod|${provider.id}|local-${meta.chunks}`;
  const cached = decodedCache.get(cacheKey) as { movies: Movie[]; categories: Category[] } | undefined;
  if (cached) return cached;
  const movies: Movie[] = [];
  let offset = 0;
  let missing = 0;
  for (let index = 0; index < meta.chunks; index++) {
    const rows = meta.readChunk(index);
    if (rows.length === 0) missing++;
    for (const movie of decodeMovies(rows, provider, offset)) movies.push(movie);
    offset += rows.length;
    onProgress?.(offset, meta.chunks * CHUNK_SIZE);
    // Négy adag után lélegzés: a felület közben kirajzolódik és válaszol.
    if (index % 4 === 3) await yieldToStorage();
  }
  const categories = readChunkedCategories(VOD_META_KEY, 'movie');
  appLog(`Filmlista betöltve: ${movies.length} film, ${meta.chunks} adag`
    + (missing ? `, ${missing} hiányzó adag` : ''));
  if (movies.length === 0) {
    const legacy = loadLegacyVod(provider);
    if (legacy.movies.length > 0) {
      await applyCatalogExtras(provider.id, legacy.movies, []);
      appLog(`A régi filmlistából sikerült visszatölteni: ${legacy.movies.length} film`);
      return legacy;
    }
  }
  await applyCatalogExtras(provider.id, movies, []);
  const result = { movies, categories };
  rememberDecoded(provider.id, 'vod', cacheKey, result);
  return result;
}

/** Sorozatok betöltése (szinkron, kis listához és tesztekhez). */
export function loadSeries(provider: ProviderRef): { series: Series[]; categories: Category[] } {
  const meta = openChunked(SERIES_META_KEY, SERIES_CHUNK_PREFIX);
  if (!meta) return loadLegacySeries(provider);
  const series: Series[] = [];
  let offset = 0;
  let missing = 0;
  for (let index = 0; index < meta.chunks; index++) {
    const rows = meta.readChunk(index);
    if (rows.length === 0) missing++;
    series.push(...decodeSeries(rows, provider, offset));
    offset += rows.length;
  }
  if (missing) {
    appLog(`Sorozatlista: ${missing}/${meta.chunks} adag hiányzott.`);
  }
  const categories = readChunkedCategories(SERIES_META_KEY, 'series');
  if (series.length === 0) return loadLegacySeries(provider);
  return { series, categories };
}

/** Sorozatok betöltése adagonként, a felületnek visszaadott vezérléssel. */
export async function loadSeriesAsync(
  provider: ProviderRef,
  onProgress?: (loaded: number, total: number) => void
): Promise<{ series: Series[]; categories: Category[] }> {
  // Ugyanaz, mint a filmeknél: a teljes sorozatlista a tartós tárban van.
  const idb = await contentChunkStore();
  let cacheKey = `series|${provider.id}|legacy`;
  if (idb) {
    const chunked = await readIdbChunks(idb, SERIES_META_KEY);
    if (chunked) {
      cacheKey = `series|${provider.id}|${chunked.meta.chunkPrefix}`;
      const cached = decodedCache.get(cacheKey) as { series: Series[]; categories: Category[] } | undefined;
      if (cached) {
        onProgress?.(cached.series.length, cached.series.length);
        return cached;
      }
      const series: Series[] = [];
      let offset = 0;
      for (let index = 0; index < chunked.meta.chunks; index++) {
        const rows = await chunked.readChunk(index);
        for (const item of decodeSeries(rows, provider, offset)) series.push(item);
        offset += rows.length;
        onProgress?.(offset, chunked.meta.chunks * CHUNK_SIZE);
        if (index % 4 === 3) await yieldToStorage();
      }
      if (series.length > 0) {
        const categories = decodeCategories(chunked.meta.cats, 'series');
        await applyCatalogExtras(provider.id, [], series);
        appLog(`Sorozatlista visszatöltve a tartós tárból: ${series.length} sorozat, ${chunked.meta.chunks} adag`);
        const result = { series, categories };
        rememberDecoded(provider.id, 'series', cacheKey, result);
        return result;
      }
    }
  }
  const meta = openChunked(SERIES_META_KEY, SERIES_CHUNK_PREFIX);
  if (!meta) {
    const legacy = loadLegacySeries(provider);
    await applyCatalogExtras(provider.id, [], legacy.series);
    appLog(`Sorozatlista betöltve (régi tároló): ${legacy.series.length} sorozat`);
    return legacy;
  }
  cacheKey = `series|${provider.id}|local-${meta.chunks}`;
  const cached = decodedCache.get(cacheKey) as { series: Series[]; categories: Category[] } | undefined;
  if (cached) return cached;
  const series: Series[] = [];
  let offset = 0;
  let missing = 0;
  for (let index = 0; index < meta.chunks; index++) {
    const rows = meta.readChunk(index);
    if (rows.length === 0) missing++;
    for (const item of decodeSeries(rows, provider, offset)) series.push(item);
    offset += rows.length;
    onProgress?.(offset, meta.chunks * CHUNK_SIZE);
    if (index % 4 === 3) await yieldToStorage();
  }
  const categories = readChunkedCategories(SERIES_META_KEY, 'series');
  appLog(`Sorozatlista betöltve: ${series.length} sorozat, ${meta.chunks} adag`
    + (missing ? `, ${missing} hiányzó adag` : ''));
  if (series.length === 0) {
    const legacy = loadLegacySeries(provider);
    if (legacy.series.length > 0) {
      await applyCatalogExtras(provider.id, [], legacy.series);
      appLog(`A régi sorozatlistából sikerült visszatölteni: ${legacy.series.length} sorozat`);
      return legacy;
    }
  }
  await applyCatalogExtras(provider.id, [], series);
  const result = { series, categories };
  rememberDecoded(provider.id, 'series', cacheKey, result);
  return result;
}

export function clearContent(): void {
  const liveKeys = readChunkKeys(LIVE_META_KEY, LIVE_CHUNK_PREFIX);
  const vodKeys = readChunkKeys(VOD_META_KEY, VOD_CHUNK_PREFIX);
  const seriesKeys = readChunkKeys(SERIES_META_KEY, SERIES_CHUNK_PREFIX);
  backend.remove(LIVE_KEY);
  backend.remove(LIVE_META_KEY);
  for (const key of liveKeys) backend.remove(key);
  backend.remove(VOD_KEY);
  backend.remove(SERIES_KEY);
  for (const key of vodKeys) backend.remove(key);
  for (const key of seriesKeys) backend.remove(key);
  backend.remove(VOD_META_KEY);
  backend.remove(SERIES_META_KEY);
  backend.remove(SYNC_KEY);
  backend.remove(CONTENT_STATE_KEY);
  backend.remove(LIVE_FULL_META_KEY);
  cachedCatalogState = null;
  extrasCache.clear();
  decodedCache.clear();
  // A film- és sorozatlista az IndexedDB-ben van: azt is törölni kell.
  void contentChunkStore().then((store) => store?.clear());
}

/* ------------------------------------------- EGYETLEN INDÍTÁSI VISSZATÖLTÉS */

/**
 * A hideg indítás EGYETLEN, megosztott folyamata.
 *
 * A korábbi kód három külön effektben, három külön időzítővel (800 ms,
 * 900 ms, 1200 ms + requestIdleCallback) olvasta ugyanazokat a listákat,
 * sőt a filmeket és sorozatokat gyakran KÉTSZER dekódolta. Ez nemcsak
 * másodperceket vett el az indulástól, hanem feleslegesen terhelte a TV
 * főszálát. Most egyetlen terv (`inspectStoredCatalogs`) és egyetlen,
 * megosztott visszatöltés (`restoreStoredContent`) van: aki előbb kéri
 * (a főoldal vagy a Mozi menü), az indítja el; a többi hívás ugyanarra a
 * futó folyamatra csatlakozik.
 */
export interface StoredCatalogPlan {
  provider: ProviderRef;
  savedAt: number;
  counts: { live: number; vod: number; series: number };
  hasLive: boolean;
  hasVod: boolean;
  hasSeries: boolean;
  /** A helyi (gyors) induló készlet – már az első képkockánál látszik. */
  bootChannels: Channel[];
  bootCategories: Category[];
  bootTotals: { live: number; vod: number; series: number };
  state: CatalogState | null;
  report: StorageReport;
}

export interface RestoreHandlers {
  onLive?: (full: LoadedLiveFull) => void;
  onVod?: (result: { movies: Movie[]; categories: Category[] }) => void;
  onSeries?: (result: { series: Series[]; categories: Category[] }) => void;
  onStage?: (stage: string) => void;
}

async function hasStoredList(store: ChunkStore | null, metaKey: string, localMetaKey: string, legacyKey: string): Promise<boolean> {
  if (backend.get(localMetaKey) || backend.get(legacyKey)) return true;
  if (!store) return false;
  try { return Boolean(await readIdbChunks(store, metaKey)); } catch { return false; }
}

/** Egyetlen, gyors tároló-felmérés: mi van meg, és mennyi. */
export async function inspectStoredCatalogs(): Promise<StoredCatalogPlan | null> {
  const state = await readCatalogState();
  const report = await describeStoredContent();
  lastStorageReport = report;
  let boot: LoadedLive = loadLive();
  if (!boot.provider || boot.channels.length === 0) {
    try { boot = await loadLiveBoot(); } catch { /* a helyi próba eredménye marad */ }
  }
  const provider = boot.provider || state?.provider || null;
  if (!provider) return null;
  const store = await contentChunkStore();
  const [hasLive, hasVod, hasSeries] = await Promise.all([
    hasStoredList(store, LIVE_FULL_META_KEY, LIVE_META_KEY, LIVE_KEY),
    hasStoredList(store, VOD_META_KEY, VOD_META_KEY, VOD_KEY),
    hasStoredList(store, SERIES_META_KEY, SERIES_META_KEY, SERIES_KEY),
  ]);
  const counts = {
    live: Math.max(state?.counts.live || 0, boot.totals.live || 0, report.liveIdb),
    vod: Math.max(state?.counts.vod || 0, boot.totals.vod || 0, report.vodIdb),
    series: Math.max(state?.counts.series || 0, boot.totals.series || 0, report.seriesIdb),
  };
  return {
    provider,
    savedAt: state?.savedAt || 0,
    counts,
    hasLive,
    hasVod,
    hasSeries,
    bootChannels: boot.channels,
    bootCategories: boot.categories,
    bootTotals: boot.totals,
    state,
    report,
  };
}

let activeRestore: Promise<void> | null = null;
let restoreCancelled = false;

/** A felület bezárásakor / új import indításakor a háttér-visszatöltés leáll. */
export function cancelStoredContentRestore(): void {
  restoreCancelled = true;
  activeRestore = null;
}

/**
 * A TELJES katalógus visszatöltése a tartós tárból – HÁLÓZAT NÉLKÜL.
 *
 * Sorrend: élő → filmek → sorozatok, minden szakasz után visszaadva a
 * főszálat. A visszafejtett listákat a `decodedCache` megőrzi, így a Mozi
 * vagy Sorozat menü későbbi megnyitása nem olvas újra 100 ezres JSON-t.
 */
export function restoreStoredContent(plan: StoredCatalogPlan, handlers: RestoreHandlers = {}): Promise<void> {
  if (activeRestore) return activeRestore;
  restoreCancelled = false;
  const startedAt = Date.now();
  const run = async (): Promise<void> => {
    const provider = plan.provider;
    let loaded = '';
    if (plan.hasLive && !restoreCancelled) {
      // Két különböző szolgáltató listája NEM keveredhet: ha a tartós tár
      // fejléce másik fiókhoz tartozik, azt a listát nem fogadjuk el.
      const store = await contentChunkStore();
      const liveMeta = store ? await readIdbChunks(store, LIVE_FULL_META_KEY) : null;
      const sameProvider = !liveMeta?.meta.provider
        || liveMeta.meta.provider.id === plan.provider.id;
      if (sameProvider) {
        handlers.onStage?.('teljes élő csatornalista a tartós tárból');
        const full = await loadLiveFull(provider);
        if (full && full.channels.length && !restoreCancelled) {
          handlers.onLive?.(full);
          loaded += ` élő=${full.channels.length}`;
        }
      } else {
        appLog('Tároló: a mentett élő lista másik szolgáltatóhoz tartozik – nem keverjük.');
      }
      await yieldToStorage();
    }
    if (plan.hasVod && !restoreCancelled) {
      handlers.onStage?.('filmlista a tartós tárból');
      const vod = await loadVodAsync(provider);
      if (vod.movies.length && !restoreCancelled) {
        handlers.onVod?.(vod);
        loaded += ` film=${vod.movies.length}`;
      }
      await yieldToStorage();
    }
    if (plan.hasSeries && !restoreCancelled) {
      handlers.onStage?.('sorozatlista a tartós tárból');
      const ser = await loadSeriesAsync(provider);
      if (ser.series.length && !restoreCancelled) {
        handlers.onSeries?.(ser);
        loaded += ` sorozat=${ser.series.length}`;
      }
    }
    if (!restoreCancelled) {
      appLog(`TARTÓS VISSZATÖLTÉS készen (${Date.now() - startedAt} ms, letöltés nélkül):${loaded || ' üres'}.`);
    }
  };
  let task: Promise<void>;
  task = run()
    .catch((error) => appLogError('Tartós katalógus visszatöltése', error))
    .finally(() => { if (activeRestore === task) activeRestore = null; });
  activeRestore = task;
  return task;
}
