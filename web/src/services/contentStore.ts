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
const LIVE_META_KEY = 'content-live-meta';
const VOD_KEY = 'content-vod';
const SERIES_KEY = 'content-series';
const VOD_META_KEY = 'content-vod-meta';
const SERIES_META_KEY = 'content-series-meta';
const CHUNK_SIZE = 400;
const LIVE_CHUNK_PREFIX = 'content-live-chunk-';
const LIVE_GENERATION_PREFIX = 'content-live-chunk-v1-';
const VOD_CHUNK_PREFIX = 'content-vod-chunk-';
const SERIES_CHUNK_PREFIX = 'content-series-chunk-';
const VOD_GENERATION_PREFIX = 'content-vod-chunk-v2-';
const SERIES_GENERATION_PREFIX = 'content-series-chunk-v2-';

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

interface LiveChunkMeta {
  v: 1;
  provider: ProviderRef;
  savedAt: string;
  totals: { live: number; vod: number; series: number };
  cats: Row[];
  chunks: number;
  chunkPrefix: string;
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

function write(key: string, payload: unknown): boolean {
  return writeMeasured(key, payload).ok;
}

function writeMeasured(key: string, payload: unknown): WriteOutcome {
  let text = JSON.stringify(payload);
  let storedRows = Array.isArray((payload as { rows?: Row[] })?.rows)
    ? (payload as { rows: Row[] }).rows.length
    : 0;
  if (text.length > LOCAL_BUDGET) {
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
    let rows = Array.isArray(source?.rows) ? source.rows : null;
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

/** Csak az élő csatornák mentése (a betöltés első szakasza után azonnal). */
/** Mentésnél a magyar csatornák kerülnek előre.
 *  A darabolt mentés elkerüli, hogy egyetlen túl nagy localStorage-érték
 *  miatt a lista vége levágódjon; a magyar sorrend továbbra is megmarad. */
function hungarianFirstForSave(channels: Channel[]): Channel[] {
  const hu: Channel[] = [];
  const rest: Channel[] = [];
  for (const channel of channels) {
    const isHu = (channel.countryCode || '').toUpperCase() === 'HU'
      || channel.country === 'Magyarország'
      || /\b(magyarország|hungary|hungarian)\b/i.test(channel.categoryName || '');
    (isHu ? hu : rest).push(channel);
  }
  return hu.length ? hu.concat(rest) : channels;
}

export function saveLiveContent(content: ImportedContent): void {
  // A teljes csatornalista egyetlen localStorage-kulcsban könnyen túllépi a
  // böngésző kvótáját. Adagokban mentünk, és csak a teljes siker után váltunk
  // az új generációra; megszakadt mentéskor a korábbi cache érvényes marad.
  const channels = hungarianFirstForSave(content.channels);
  const chunkCount = Math.ceil(channels.length / CHUNK_SIZE);
  const generationPrefix = LIVE_GENERATION_PREFIX + Date.now() + '-' + (++writeSequence) + '-';
  const previousKeys = readChunkKeys(LIVE_META_KEY, LIVE_CHUNK_PREFIX);
  for (let index = 0; index < chunkCount; index++) activeGenerations.add(generationPrefix + index);

  for (let index = 0; index < chunkCount; index++) {
    const rows = encodeChannels(channels.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
    if (!write(generationPrefix + index, { rows })) {
      for (let cleanup = 0; cleanup < chunkCount; cleanup++) {
        backend.remove(generationPrefix + cleanup);
        activeGenerations.delete(generationPrefix + cleanup);
      }
      appLog('Élő csatornák adagolt mentése nem sikerült (' + (index + 1) + '/' + chunkCount + '); a korábbi cache marad érvényben.');
      return;
    }
  }

  const meta: LiveChunkMeta = {
    v: 1,
    provider: content.provider,
    savedAt: content.savedAt,
    totals: content.totals,
    cats: encodeCategories(content.liveCategories),
    chunks: chunkCount,
    chunkPrefix: generationPrefix,
  };
  if (!write(LIVE_META_KEY, meta)) {
    for (let index = 0; index < chunkCount; index++) {
      backend.remove(generationPrefix + index);
      activeGenerations.delete(generationPrefix + index);
    }
    appLog('Élő csatornák cache-fejlécének mentése nem sikerült; a korábbi cache marad érvényben.');
    return;
  }
  for (let index = 0; index < chunkCount; index++) activeGenerations.delete(generationPrefix + index);

  backend.remove(LIVE_KEY);
  for (const key of previousKeys) backend.remove(key);
  appLog('Élő csatornák elmentve: ' + channels.length + ' elem, ' + chunkCount + ' adag, tároló=' + backend.name);
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
        if (missing) appLog('Élő csatornalista: ' + missing + '/' + meta.chunks + ' adag hiányzik a cache-ből.');
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
}
