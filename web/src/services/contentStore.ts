import { normalizeLogoUrl } from './logoUrl';
/**
 * A szolgáltatótól letöltött csatorna / film / sorozat lista tárolása.
 *
 * Az APK-ban az adatok az eszköz fájlrendszerére kerülnek (natív híd), mert a
 * localStorage 5 MB-os korlátja kevés a több tízezer elemhez. Böngészőben a
 * localStorage-ot használjuk, ott viszont méretkorlátot tartunk.
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
   * A betöltés közben keletkezett figyelmeztetések (pl. a szolgáltató néhány
   * kategóriát nem adott ki). A felület a betöltés végén megjeleníti őket,
   * hogy a hiány ne maradjon észrevétlen.
   */
  warnings?: string[];
}

const LIVE_KEY = 'content-live';
const VOD_KEY = 'content-vod';
const SERIES_KEY = 'content-series';
const VOD_META_KEY = 'content-vod-meta';
const SERIES_META_KEY = 'content-series-meta';
const CHUNK_SIZE = 400;
const VOD_CHUNK_PREFIX = 'content-vod-chunk-';
const SERIES_CHUNK_PREFIX = 'content-series-chunk-';
const VOD_GENERATION_PREFIX = 'content-vod-chunk-v2-';
const SERIES_GENERATION_PREFIX = 'content-series-chunk-v2-';

let seriesSaveQueue: Promise<void> = Promise.resolve();
let vodSaveQueue: Promise<void> = Promise.resolve();
/** Adagolt mentések sorszáma (a generációs előtag egyedisége miatt). */
let writeSequence = 0;

function yieldToStorage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
}

/* --------------------------------------------------------------- backendek */

interface Backend {
  name: 'native' | 'local' | 'memory';
  get(key: string): string;
  put(key: string, value: string): boolean;
  remove(key: string): void;
}

interface NativeStore {
  get(key: string): string;
  put(key: string, value: string): boolean;
  remove(key: string): boolean;
}

function nativeStore(): NativeStore | null {
  const api = (window as { IPTVNative?: { store?: NativeStore | null } }).IPTVNative;
  return api && api.store ? api.store : null;
}

const memory = new Map<string, string>();

const backend: Backend = (() => {
  const native = nativeStore();
  if (native) {
    return {
      name: 'native',
      get: (key) => {
        try {
          return native.get(key) || '';
        } catch {
          return '';
        }
      },
      put: (key, value) => {
        try {
          return native.put(key, value);
        } catch {
          return false;
        }
      },
      remove: (key) => {
        try {
          native.remove(key);
        } catch {
          /* nem kritikus */
        }
      },
    };
  }
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
  return movies.map((m) => [
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
  ]);
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
      durationMinutes: 0,
      plot: String(row[8] || ''),
      genres: [],
      streamUrl: streamUrlFor(provider, String(row[0]), String(row[7] || 'mp4'), 'movie'),
      containerExtension: String(row[7] || 'mp4'),
      isFavorite: Number(row[9] ?? 0) === 1,
    });
  }
  return out;
}

function encodeSeries(series: Series[]): Row[] {
  return series.map((s) => [
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
  ]);
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
      plot: String(row[7] || ''),
      genres: [],
      seasons: [],
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

function write(key: string, payload: unknown): boolean {
  let text = JSON.stringify(payload);
  if (text.length > LOCAL_BUDGET && backend.name !== 'native') {
    // Böngészőben (localStorage) nem fér el minden – csonkoljuk a listát.
    // A nagy JSON visszaolvasása fölösleges plusz memóriacsúcsot okozna.
    const source = payload as { rows?: Row[] };
    if (Array.isArray(source?.rows)) {
      const keep = Math.max(200, Math.floor(source.rows.length * (LOCAL_BUDGET / text.length)));
      text = JSON.stringify({ ...source, rows: source.rows.slice(0, keep) });
    }
  }
  const ok = backend.put(key, text);
  if (!ok && backend.name === 'native') {
    // Ha a natív tároló nem megy, próbáljuk a memóriát, hogy legalább a
    // munkamenetben megmaradjon a lista.
    memory.set(key, text);
  }
  return ok;
}

/** Csak az élő csatornák mentése (a betöltés első szakasza után azonnal). */
export function saveLiveContent(content: ImportedContent): void {
  write(LIVE_KEY, {
    v: 1,
    provider: content.provider,
    savedAt: content.savedAt,
    totals: content.totals,
    cats: encodeCategories(content.liveCategories),
    rows: encodeChannels(content.channels),
  } satisfies LivePart);
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

  try {
    for (let index = 0; index < chunkCount; index++) {
      const rows = options.chunkRows(index);
      if (!write(generationPrefix + index, { rows })) {
        throw new Error(`${options.label}: a lista egy része nem menthető el (${index + 1}/${chunkCount}).`);
      }
      // Két adag után lélegzés: a felület ne akadjon meg a mentés közben.
      if (index % 2 === 1) await yieldToStorage();
    }
    if (!write(options.metaKey, {
      v: 1,
      totals: options.totals,
      cats: options.cats,
      chunks: chunkCount,
      chunkPrefix: generationPrefix,
    } satisfies ChunkMeta)) {
      throw new Error(`${options.label}: a lista fejléce nem menthető el.`);
    }
  } catch (error) {
    for (let index = 0; index < chunkCount; index++) backend.remove(generationPrefix + index);
    appLogError(`${options.label} mentése sikertelen`, error);
    throw error;
  }

  // Siker: a régi adagok és a régi, egykulcsos változat törölhető.
  backend.remove(options.legacyKey);
  for (const key of previousKeys) backend.remove(key);
  appLog(`${options.label} elmentve: ${options.total} elem, ${chunkCount} adag, tároló=${backend.name}`);
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

/** A sorozatmentések sorban futnak, nem írhatják felül egymás félkész adagjait. */
export function saveSeriesContent(content: ImportedContent): Promise<void> {
  const task = seriesSaveQueue.then(() => saveChunked({
    metaKey: SERIES_META_KEY,
    legacyKey: SERIES_KEY,
    legacyPrefix: SERIES_CHUNK_PREFIX,
    generationPrefix: SERIES_GENERATION_PREFIX,
    total: content.series.length,
    chunkRows: (index) => encodeSeries(content.series.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)),
    totals: { series: content.totals.series },
    cats: encodeCategories(content.seriesCategories),
    label: 'Sorozatlista',
  })).catch((error) => {
    appLogError('Sorozatlista mentése', error);
    throw error;
  });
  seriesSaveQueue = task.catch(() => undefined);
  return task;
}

/** Csak a filmek mentése (adagolva, hogy ne legyen nagy memóriacsúcs). */
export function saveVodContent(content: ImportedContent): Promise<void> {
  const task = vodSaveQueue.then(() => saveChunked({
    metaKey: VOD_META_KEY,
    legacyKey: VOD_KEY,
    legacyPrefix: VOD_CHUNK_PREFIX,
    generationPrefix: VOD_GENERATION_PREFIX,
    total: content.movies.length,
    chunkRows: (index) => encodeMovies(content.movies.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)),
    totals: { vod: content.totals.vod },
    cats: encodeCategories(content.vodCategories),
    label: 'Filmlista',
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
  saveLiveContent(content);
  await yieldToStorage();
  await saveVodContent(content);
  await yieldToStorage();
  await saveSeriesContent(content);
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
  const raw = backend.get(LIVE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LivePart;
    if (!parsed || !parsed.provider) return null;
    return {
      provider: parsed.provider,
      savedAt: parsed.savedAt || '',
      totals: parsed.totals || { live: parsed.rows?.length || 0, vod: 0, series: 0 },
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
}

export function loadLive(): LoadedLive {
  const empty: LoadedLive = {
    channels: [],
    categories: [],
    savedAt: '',
    provider: null,
    totals: { live: 0, vod: 0, series: 0 },
  };
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

/** Régi, egykulcsos film lista (visszafelé kompatibilitás). */
function loadLegacyVod(provider: ProviderRef): { movies: Movie[]; categories: Category[] } {
  const raw = backend.get(VOD_KEY);
  if (!raw) return { movies: [], categories: [] };
  try {
    const parsed = JSON.parse(raw) as VodPart;
    return {
      movies: decodeMovies(parsed.rows, provider),
      categories: decodeCategories(parsed.cats, 'movie'),
    };
  } catch (error) {
    appLogError('Régi filmlista betöltése', error);
    return { movies: [], categories: [] };
  }
}

function loadLegacySeries(provider: ProviderRef): { series: Series[]; categories: Category[] } {
  const raw = backend.get(SERIES_KEY);
  if (!raw) return { series: [], categories: [] };
  try {
    const parsed = JSON.parse(raw) as SeriesPart;
    return {
      series: decodeSeries(parsed.rows, provider),
      categories: decodeCategories(parsed.cats, 'series'),
    };
  } catch (error) {
    appLogError('Régi sorozatlista betöltése', error);
    return { series: [], categories: [] };
  }
}

/** Filmek betöltése (szinkron, kis listához és tesztekhez). */
export function loadVod(provider: ProviderRef): { movies: Movie[]; categories: Category[] } {
  const meta = openChunked(VOD_META_KEY, VOD_CHUNK_PREFIX);
  if (!meta) return loadLegacyVod(provider);
  const movies: Movie[] = [];
  let offset = 0;
  const missing: number[] = [];
  for (let index = 0; index < meta.chunks; index++) {
    const rows = meta.readChunk(index);
    if (rows.length === 0) missing.push(index);
    movies.push(...decodeMovies(rows, provider, offset));
    offset += rows.length;
  }
  if (missing.length) {
    appLog(`Filmlista: ${missing.length}/${meta.chunks} adag hiányzott (${missing.slice(0, 6).join(', ')}).`);
  }
  const categories = readChunkedCategories(VOD_META_KEY, 'movie');
  if (movies.length === 0) return loadLegacyVod(provider);
  return { movies, categories };
}

/**
 * Filmek betöltése adagonként, a felületnek visszaadott vezérléssel.
 *
 * Ez a hivatalos útvonal induláskor: több tízezer filmnél a egyetlen nagy
 * feldolgozás korábban másodpercekre megfagyasztotta a WebView-t.
 */
export async function loadVodAsync(
  provider: ProviderRef,
  onProgress?: (loaded: number, total: number) => void
): Promise<{ movies: Movie[]; categories: Category[] }> {
  const meta = openChunked(VOD_META_KEY, VOD_CHUNK_PREFIX);
  if (!meta) {
    const legacy = loadLegacyVod(provider);
    appLog(`Filmlista betöltve (régi tároló): ${legacy.movies.length} film`);
    return legacy;
  }
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
      appLog(`A régi filmlistából sikerült visszatölteni: ${legacy.movies.length} film`);
      return legacy;
    }
  }
  return { movies, categories };
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
  const meta = openChunked(SERIES_META_KEY, SERIES_CHUNK_PREFIX);
  if (!meta) {
    const legacy = loadLegacySeries(provider);
    appLog(`Sorozatlista betöltve (régi tároló): ${legacy.series.length} sorozat`);
    return legacy;
  }
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
      appLog(`A régi sorozatlistából sikerült visszatölteni: ${legacy.series.length} sorozat`);
      return legacy;
    }
  }
  return { series, categories };
}

export function clearContent(): void {
  backend.remove(LIVE_KEY);
  backend.remove(VOD_KEY);
  backend.remove(SERIES_KEY);
  for (const key of readChunkKeys(VOD_META_KEY, VOD_CHUNK_PREFIX)) backend.remove(key);
  for (const key of readChunkKeys(SERIES_META_KEY, SERIES_CHUNK_PREFIX)) backend.remove(key);
  backend.remove(VOD_META_KEY);
  backend.remove(SERIES_META_KEY);
}
