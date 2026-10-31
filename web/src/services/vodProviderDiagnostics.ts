/**
 * XTREAM VOD-METAADAT TESZT a kézi hibakeresési naplóhoz.
 *
 * CÉL: a naplóból pontosan látszódjon, hogy a szolgáltató (Xtream Codes) MILYEN
 * adatokat küld a filmekhez és a sorozatokhoz – év, megjelenési dátum,
 * játékidő, hangsávok és hangnyelvek, feliratok és feliratnyelvek, poszterek /
 * borítók / háttérképek, valamint minden egyéb mező –, és ezek közül melyeket
 * tudja a program megjeleníteni a poszterkártyán és az adatlapon.
 *
 * MIKOR FUT:
 *   1. a kézi naplózás INDÍTÁSAKOR (a naplózás életciklusához csatlakozva),
 *   2. amikor a néző belép a MOZI vagy a SOROZATOK nézetbe,
 *   3. amikor egy film/sorozat poszterét megnyitja (a már letöltött válaszból,
 *      plusz kérés nélkül).
 *
 * FONTOS:
 *   • Minden sor `VOD-DIAG` előtaggal kerül a naplóba, és csak aktív naplózás
 *     alatt készül (a naplózás nélküli tévézést nem lassítja).
 *   • A részletes lekérések száma munkamenetenként korlátozott, és ugyanazt az
 *     elemet nem kérdezzük le újra néhány percen belül.
 *   • A naplóba SOHA nem kerül jelszó/felhasználónév: a naplózó réteg minden
 *     URL-t automatikusan kitakar (appLog.redactLogUrls), itt pedig csak a
 *     hosztot írjuk ki.
 */
import { Category, Movie, Series } from '../types/iptv';
import { appLog, manualLogSnapshot, measurementLogsEnabled, registerLoggingLifecycleHooks } from './appLog';
import { parseSeriesMetadata, parseVodMetadata } from './vodMetadata';
import { xtreamService } from './xtreamService';
import { visibleLanguages } from '../utils/vodDisplay';

const TAG = 'VOD-DIAG';

/** A program által ismert szolgáltatói adatok (a kérésekhez elegendő rész). */
export interface VodDiagnosticsProvider {
  id?: string;
  type?: string;
  serverUrl?: string;
  username?: string;
  password?: string;
}

/** A teszt bemenete: a főoldal pillanatnyi szolgáltatói és VOD-állapota. */
export interface VodDiagnosticsContext {
  provider: VodDiagnosticsProvider | null;
  movies: Movie[];
  series: Series[];
  vodCategories?: Category[];
  seriesCategories?: Category[];
  totals?: { vod?: number; series?: number };
}

export type VodDiagnosticsContextGetter = () => VodDiagnosticsContext;

/** A részletes lekérések hálózati rétege (tesztekben helyettesíthető). */
export interface VodProbeTransport {
  vodInfo(serverUrl: string, username: string, password: string, id: number | string): Promise<unknown>;
  seriesInfo(serverUrl: string, username: string, password: string, id: number | string): Promise<unknown>;
}

type VodKind = 'movie' | 'series';

/** Munkamenetenként ennyi részletes kérés indulhat (kímélő üzem). */
const MAX_DETAILED_PROBES = 10;
/** Nézetbelépéskor ennyi elemet kérdezünk le típusonként. */
const SECTION_DETAILED_PROBES = 3;
/** A naplózás indításakor ennyi elemet kérdezünk le típusonként. */
const START_DETAILED_PROBES = 2;
/** Ennyi lista-elemet írunk ki tételesen. */
const LIST_ITEMS_LOGGED = 4;
/** A lista-mezők jelenlétéhez ekkora mintát számolunk. */
const LIST_SAMPLE_SIZE = 200;
/** Ugyanaz a nézet ennyi időn belül nem fut újra. */
const SECTION_COOLDOWN_MS = 45_000;
/** Ugyanaz az elem ennyi időn belül nem kerül újra a naplóba. */
const ITEM_COOLDOWN_MS = 60_000;
/** Egy naplósor ennyi karakterig tartalmazhat nyers adatot. */
const RAW_PREVIEW_CHARS = 900;
const VALUE_PREVIEW_CHARS = 90;

const defaultTransport: VodProbeTransport = {
  vodInfo: (serverUrl, username, password, id) => xtreamService.vodInfo(serverUrl, username, password, id),
  seriesInfo: (serverUrl, username, password, id) => xtreamService.seriesInfo(serverUrl, username, password, id),
};

let contextGetter: VodDiagnosticsContextGetter | null = null;
let transport: VodProbeTransport = defaultTransport;
let probesUsed = 0;
const probedItems = new Map<string, number>();
const lastSectionAt = new Map<VodKind, number>();
let lastOverviewAt = 0;
let startTimer: number | null = null;
let startAttempts = 0;
/** Csak EGY életciklus-figyelő lehet bejegyezve (React StrictMode / újramountolás). */
let detachLifecycle: (() => void) | null = null;

/* ───────────────────────────── segédfüggvények ───────────────────────────── */

function loggingActive(): boolean {
  /*
   * 2.5.226: a VOD-DIAG kizárólag MÉRÉSI napló (teljes szolgáltatói válaszok,
   * ffprobe-mezők, automatikus próbakérések). Az 1-es TV-naplóban ezek a
   * dumpok adták a terjedelem nagy részét, az automatikus próbák pedig
   * felesleges hálózati kéréseket indítottak import közben. Alapból KI;
   * fejlesztéshez az 'iptv_rt_meres_naplo'='1' kulccsal kapcsolható vissza.
   */
  if (!measurementLogsEnabled()) return false;
  try {
    return manualLogSnapshot().enabled;
  } catch {
    return false;
  }
}

function line(message: string): void {
  appLog(`${TAG} ${message}`);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Kis- és nagybetűtől független mezőkeresés (a panelek eltérően írják a kulcsokat). */
function field(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) return undefined;
  const wanted = keys.map((key) => key.toLowerCase());
  for (const [key, value] of Object.entries(record)) {
    if (wanted.includes(key.toLowerCase()) && value !== undefined && value !== null) {
      if (typeof value === 'string' && !value.trim()) continue;
      return value;
    }
  }
  return undefined;
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function text(value: unknown, max = VALUE_PREVIEW_CHARS): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const oneLine = String(raw ?? '').replace(/\s+/g, ' ').trim();
  /*
   * Az URL-eket nagyobb kerettel, de a lekérdezés (esetleg tokent tartalmazó
   * rész) nélkül írjuk ki: így a naplózó réteg a benne lévő felhasználónevet /
   * jelszót teljes egészében ki tudja takarni, nem csonkoljuk szét az URL-t.
   */
  if (/^https?:\/\//i.test(oneLine)) {
    try {
      const url = new URL(oneLine);
      const short = `${url.origin}${url.pathname}`;
      return short.length > 240 ? `${short.slice(0, 240)}…` : short;
    } catch {
      return oneLine.length > 240 ? `${oneLine.slice(0, 240)}…` : oneLine;
    }
  }
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function quote(value: unknown, max = VALUE_PREVIEW_CHARS): string {
  const shown = text(value, max);
  return shown ? `"${shown}"` : '(üres)';
}

function jsonPreview(value: unknown, max = RAW_PREVIEW_CHARS): string {
  try {
    const oneLine = JSON.stringify(value ?? null);
    const textValue = String(oneLine ?? 'null');
    return textValue.length > max ? `${textValue.slice(0, max)}…` : textValue;
  } catch {
    return '[nem sorosítható szerkezet]';
  }
}

/** Csak a hoszt: a felhasználónév/jelszó soha nem kerülhet a naplóba. */
function hostOnly(serverUrl?: string): string {
  if (!serverUrl) return 'nincs';
  try {
    return new URL(serverUrl).host || 'ismeretlen';
  } catch {
    const fallback = String(serverUrl).replace(/^https?:\/\//i, '').split('/')[0];
    return fallback || 'ismeretlen';
  }
}

function providerIsXtream(provider: VodDiagnosticsProvider | null): boolean {
  return Boolean(provider && provider.type === 'xtream' && provider.serverUrl && provider.username && provider.password);
}

function providerLabel(provider: VodDiagnosticsProvider | null): string {
  if (!provider) return 'nincs beállított szolgáltató';
  const type = provider.type === 'm3u' ? 'M3U' : 'Xtream';
  return `${type}; host=${hostOnly(provider.serverUrl)}`;
}

function itemKey(kind: VodKind, id: number | string | undefined): string {
  return `${kind}:${String(id ?? '')}`;
}

function itemIdOf(kind: VodKind, item: Movie | Series): number | string | undefined {
  return kind === 'movie'
    ? (item as Movie).streamId
    : (item as Series).seriesId;
}

function itemTitle(item: Movie | Series): string {
  return String(item.title || '(cím nélkül)');
}

function countText(value: number): string {
  return Number(value).toLocaleString('hu-HU');
}

function categorySummary(categories: Category[] | undefined): string {
  const list = Array.isArray(categories) ? categories : [];
  if (!list.length) return 'nincs';
  const total = list.reduce((sum, category) => sum + (Number(category.channelCount) || 0), 0);
  return `${countText(list.length)} db (${countText(total)} elem)`;
}

/* ─────────────────────────── mező-jelenlét a listából ────────────────────── */

interface PresenceCheck {
  label: string;
  test: (item: Movie | Series) => boolean;
}

const COMMON_CHECKS: PresenceCheck[] = [
  { label: 'poszter', test: (item) => isPresent((item as Movie).poster) },
  { label: 'borítókép', test: (item) => isPresent(item.backdrop) },
  { label: 'évszám', test: (item) => Number(item.year) > 0 },
  { label: 'játékidő', test: (item) => Number((item as Movie).durationMinutes) > 0 },
  { label: 'hangnyelvek', test: (item) => visibleLanguages(item.audioLanguages).length > 0 },
  { label: 'feliratnyelvek', test: (item) => visibleLanguages(item.subtitleLanguages).length > 0 },
  { label: 'leírás', test: (item) => isPresent((item as Movie).plot) },
  { label: 'műfaj', test: (item) => Array.isArray(item.genres) && item.genres.length > 0 },
  { label: 'értékelés', test: (item) => Number((item as Movie).rating) > 0 },
  { label: 'szereplők', test: (item) => Array.isArray(item.cast) && item.cast.length > 0 },
  { label: 'rendező', test: (item) => isPresent(item.director) },
];

const SERIES_CHECKS: PresenceCheck[] = [
  { label: 'évadok', test: (item) => Number((item as Series).seasonsCount) > 0 },
  { label: 'epizódok', test: (item) => Number((item as Series).episodesCount) > 0 },
];

function presenceSummary(kind: VodKind, items: ReadonlyArray<Movie | Series>): string {
  const list = Array.isArray(items) ? items : [];
  const sample = list.slice(0, LIST_SAMPLE_SIZE);
  const checks = kind === 'series' ? [...COMMON_CHECKS, ...SERIES_CHECKS] : COMMON_CHECKS;
  if (!sample.length) return 'nincs elem a listában';
  const parts = checks.map((check) => {
    const count = sample.reduce((sum, item) => sum + (check.test(item) ? 1 : 0), 0);
    return `${check.label}=${count}`;
  });
  return `minta=${countText(sample.length)}/${countText(list.length)}; ${parts.join('; ')}`;
}

/** Egy lista-elem programban ismert mezői (ezekből épül a poszterkártya/adatlap). */
function describeListItem(kind: VodKind, item: Movie | Series, index: number): void {
  const duration = Number((item as Movie).durationMinutes) || 0;
  const audio = visibleLanguages(item.audioLanguages);
  const subtitles = visibleLanguages(item.subtitleLanguages);
  const parts = [
    `év=${Number(item.year) > 0 ? item.year : 'nincs'}`,
    `játékidő=${duration > 0 ? `${duration} perc` : 'nincs'}`,
    `hangnyelvek=${audio.length ? audio.join(', ') : 'nincs'}`,
    `feliratnyelvek=${subtitles.length ? subtitles.join(', ') : 'nincs'}`,
    `poszter=${isPresent((item as Movie).poster) ? 'van' : 'nincs'}`,
    `borító/háttér=${isPresent(item.backdrop) ? 'van' : 'nincs'}`,
    `leírás=${isPresent((item as Movie).plot) ? 'van' : 'nincs'}`,
    `műfaj=${Array.isArray(item.genres) && item.genres.length ? item.genres.slice(0, 3).join(', ') : 'nincs'}`,
    `értékelés=${Number((item as Movie).rating) > 0 ? (item as Movie).rating : 'nincs'}`,
    `szereplők=${Array.isArray(item.cast) && item.cast.length ? `${item.cast.length} név` : 'nincs'}`,
    `rendező=${isPresent(item.director) ? 'van' : 'nincs'}`,
  ];
  if (kind === 'series') {
    parts.push(`évadok=${Number((item as Series).seasonsCount) || 0}`, `epizódok=${Number((item as Series).episodesCount) || 0}`);
  }
  line(`[${kind === 'movie' ? 'film' : 'sorozat'}] #${index + 1} „${itemTitle(item)}” (id=${String(itemIdOf(kind, item) ?? '?')}): ${parts.join('; ')}`);
}

function logListSample(kind: VodKind, items: ReadonlyArray<Movie | Series>, limit = LIST_ITEMS_LOGGED): void {
  const list = Array.isArray(items) ? items : [];
  const label = kind === 'movie' ? 'film' : 'sorozat';
  if (!list.length) {
    line(`[${label}] LISTA-MINTA: a lista üres (még nem töltődött be).`);
    return;
  }
  line(`[${label}] LISTA-MINTA (első ${Math.min(limit, list.length)} elem a ${countText(list.length)}-ből): a lista-végpont ennyit ad a programnak`);
  list.slice(0, limit).forEach((item, index) => describeListItem(kind, item, index));
}

/* ─────────────────────────── részletes válasz feldolgozása ───────────────── */

const IMAGE_KEYS = [
  'movie_image', 'cover_big', 'cover', 'poster', 'stream_icon', 'image', 'thumbnail', 'logo',
  'backdrop_path', 'backdrop', 'backdrop_url', 'fanart', 'tmdb_image', 'cover_url',
];

/** A válaszból kigyűjtött képmezők (a naplózó réteg az URL-eket kitakarja). */
function imageFields(value: unknown, label: string, out: string[]): void {
  const record = recordOf(value);
  if (!record) return;
  for (const [key, raw] of Object.entries(record)) {
    if (!IMAGE_KEYS.includes(key.toLowerCase())) continue;
    const items = Array.isArray(raw) ? raw : [raw];
    const urls = items.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 2);
    if (!urls.length) continue;
    out.push(`${label}${key}=${urls.join(' | ')}`);
  }
}

function rawFieldText(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) return '';
  const found: string[] = [];
  const wanted = keys.map((key) => key.toLowerCase());
  for (const [key, value] of Object.entries(record)) {
    if (!wanted.includes(key.toLowerCase())) continue;
    if (!isPresent(value)) continue;
    found.push(`${key}=${quote(value)}`);
  }
  return found.join('; ');
}

function audioTrackText(tracks: Array<{ name?: string; lang?: string; codec?: string; channels?: string }>): string {
  if (!tracks.length) return 'nincs';
  return tracks.map((track) => {
    const details = [track.lang, track.codec, track.channels].filter(Boolean).join(', ');
    return details ? `${track.name || track.lang || '?'} (${details})` : (track.name || '?');
  }).join(' | ');
}

function usedRawKeys(): Set<string> {
  return new Set([
    'info', 'movie_data', 'episodes', 'seasons', 'name', 'o_name', 'title', 'original_name',
    'releasedate', 'release_date', 'releasedatestring', 'year', 'release_year', 'releaseyear',
    'duration', 'duration_secs', 'durationsecs', 'duration_seconds', 'episode_run_time', 'runtime', 'length',
    'audio', 'audios', 'audio_tracks', 'audio_languages', 'soundtrack',
    'subtitles', 'sub_titles', 'subs', 'subtitle', 'captions', 'subtitle_list',
    'movie_image', 'cover_big', 'cover', 'poster', 'stream_icon', 'image', 'thumbnail', 'logo',
    'backdrop_path', 'backdrop', 'backdrop_url', 'fanart',
    'plot', 'description', 'overview', 'cast', 'actors', 'actor', 'genre', 'genres', 'director', 'rating',
  ]);
}

/** Minden mező egy sorban (a naplózó réteg a benne lévő URL-eket kitakarja). */
function recordPairs(record: Record<string, unknown> | null, limit = 12): string {
  if (!record) return '';
  const entries = Object.entries(record).filter(([, value]) => isPresent(value));
  if (!entries.length) return 'nincs adat';
  const shown = entries.slice(0, limit).map(([key, value]) => `${key}=${text(value, 60)}`);
  return shown.join('; ') + (entries.length > limit ? `; … (+${entries.length - limit} mező)` : '');
}

function unusedFieldsText(record: Record<string, unknown> | null, limit = 12): string {
  if (!record) return '';
  const used = usedRawKeys();
  const keys = Object.keys(record).filter((key) => !used.has(key.toLowerCase()) && isPresent(record[key]));
  if (!keys.length) return 'nincs további mező';
  const shown = keys.slice(0, limit).map((key) => `${key}=${text(record[key], 40)}`);
  return shown.join('; ') + (keys.length > limit ? `; … (+${keys.length - limit} mező)` : '');
}

/** Melyik adat jelenik meg a poszterkártyán és az adatlapon. */
function displayabilityText(options: {
  year: number;
  duration: number;
  audio: string[];
  subtitles: string[];
  plot: string;
  cast: string[];
  backdrop: string;
  unused: string;
}): string {
  const card: string[] = [];
  if (options.year > 0) card.push('évszám');
  if (options.duration > 0) card.push('játékidő');
  if (options.audio.length) card.push('hangnyelvek');
  if (options.subtitles.length) card.push('feliratnyelvek');
  const detail = [...card];
  if (options.plot) detail.push('leírás');
  if (options.cast.length) detail.push('szereplők');
  if (options.backdrop) detail.push('háttérkép');
  return `poszterkártyán: ${card.length ? card.join(', ') : 'csak a cím'}; `
    + `adatlapon: ${detail.length ? detail.join(', ') : 'csak a cím'}; `
    + `a szolgáltató további, még NEM megjelenített mezői: ${options.unused || 'nincs'}`;
}

function parseDurationFields(node: Record<string, unknown> | null): string {
  const parts: string[] = [];
  const pairs: Array<[string, string]> = [
    ['duration', 'duration'],
    ['duration_secs', 'duration_secs'],
    ['duration_seconds', 'duration_seconds'],
    ['episode_run_time', 'episode_run_time'],
    ['runtime', 'runtime'],
  ];
  for (const [key, label] of pairs) {
    const value = field(node, [key]);
    if (!isPresent(value)) continue;
    const minutes = durationMinutesOf(value, key);
    parts.push(`${label}=${quote(value, 40)}${minutes > 0 ? ` (${minutes} perc)` : ''}`);
  }
  return parts.join('; ');
}

/** Ugyanaz a szabály, mint a feldolgozóban (vodMetadata.ts) – csak a naplóhozh. */
function durationMinutesOf(value: unknown, key: string): number {
  const parsed = parseVodMetadata({ info: { [key]: value } });
  return parsed.durationMinutes;
}

function releaseText(node: Record<string, unknown> | null): string {
  const raw = rawFieldText(node, ['releasedate', 'release_date', 'releaseDate', 'year', 'release_year', 'added', 'last_modified']);
  const year = parseVodMetadata({ info: node || {} }).year || 0;
  return `${raw || 'nincs dátum a válaszban'}${year ? ` → év=${year}` : ' → év nincs'}`;
}

function yearOf(item: Movie | Series): number {
  return Number(item.year) || 0;
}

/**
 * EGY film/sorozat részletes válaszának teljes naplózása.
 *
 * A nézetek akkor hívják, amikor a poszter megnyitásakor már lekérték a
 * `get_vod_info` / `get_series_info` választ – így ehhez nem kell új kérés.
 */
export function logVodItemResponse(
  kind: VodKind,
  item: Movie | Series | null | undefined,
  rawResponse: unknown,
  source = 'részletes lekérés',
): void {
  if (!loggingActive() || !item) return;
  const id = itemIdOf(kind, item);
  const key = itemKey(kind, id);
  const now = Date.now();
  const previous = probedItems.get(key);
  if (previous && now - previous < ITEM_COOLDOWN_MS) return;
  probedItems.set(key, now);

  const label = kind === 'movie' ? 'film' : 'sorozat';
  const name = itemTitle(item);
  const root = recordOf(rawResponse);
  const info = recordOf(root?.info) ?? root;
  const movieData = recordOf(root?.movie_data);
  const parsed = kind === 'movie' ? parseVodMetadata(rawResponse) : parseSeriesMetadata(rawResponse);
  const audio = visibleLanguages(parsed.audioLanguages);
  const subtitles = visibleLanguages(parsed.subtitleLanguages);

  const images: string[] = [];
  imageFields(info, 'info.', images);
  imageFields(movieData, 'movie_data.', images);

  line(`[${label}] „${name}” (id=${String(id ?? '?')}) RÉSZLETES VÁLASZ – forrás: ${source}`);
  line(`[${label}] id=${String(id ?? '?')} VÁLASZ-SZERKEZET: ${root ? Object.keys(root).join(', ') : 'üres válasz'}`
    + `; info mezők: ${describeKeys(info)}`
    + (movieData ? `; movie_data mezők: ${describeKeys(movieData)}` : ''));

  line(`[${label}] id=${String(id ?? '?')} ÉV/MEGJELENÉS: ${releaseText(info)}`);
  line(`[${label}] id=${String(id ?? '?')} JÁTÉKIDŐ: ${parseDurationFields(info) || 'nincs játékidő-mező a válaszban'}`
    + ` → megjeleníthető játékidő=${parsed.durationMinutes > 0 ? `${parsed.durationMinutes} perc` : 'nincs'}`);

  const rawAudio = rawFieldText(info, ['audio', 'audios', 'audio_tracks', 'audio_languages', 'soundtrack']);
  line(`[${label}] id=${String(id ?? '?')} HANG: ${rawAudio || 'nincs hangsáv-mező'}`
    + ` → ${parsed.audioTracks.length} sáv (${audioTrackText(parsed.audioTracks)}); megjeleníthető nyelvek: ${audio.length ? audio.join(', ') : 'nincs'}`);

  const rawSubtitles = rawFieldText(info, ['subtitles', 'sub_titles', 'subs', 'subtitle', 'captions', 'subtitle_list']);
  line(`[${label}] id=${String(id ?? '?')} FELIRAT: ${rawSubtitles || 'nincs felirat-mező'}`
    + ` → ${parsed.subtitleTracks.length} sáv; megjeleníthető nyelvek: ${subtitles.length ? subtitles.join(', ') : 'nincs'}`);

  line(`[${label}] id=${String(id ?? '?')} KÉPEK: ${images.length ? images.join('; ') : 'nincs képmező a válaszban'}`);

  if (movieData) {
    line(`[${label}] id=${String(id ?? '?')} FILM ADATOK (movie_data): ${recordPairs(movieData)}`);
  }

  const other = [
    rawFieldText(info, ['plot', 'description', 'overview']),
    rawFieldText(info, ['genre']),
    rawFieldText(info, ['cast', 'actors', 'actor']),
    rawFieldText(info, ['director']),
    rawFieldText(info, ['rating', 'rating_5based']),
    rawFieldText(info, ['mpaa_rating', 'age', 'country', 'youtube_trailer', 'bitrate', 'tmdb_id', 'kinopoisk_url']),
    rawFieldText(movieData, ['added', 'category_id', 'container_extension', 'stream_type']),
  ].filter(Boolean);
  line(`[${label}] id=${String(id ?? '?')} EGYÉB MEZŐK: ${other.length ? other.join('; ') : 'nincs további adat'}`);

  if (kind === 'series') {
    logSeriesEpisodes(root, id);
  }

  const fallbackYear = yearOf(item) || parsed.year || 0;
  line(`[${label}] id=${String(id ?? '?')} MEGJELENÍTHETŐ: ${displayabilityText({
    year: fallbackYear,
    duration: parsed.durationMinutes,
    audio,
    subtitles,
    plot: String(parsed.plot || ''),
    cast: Array.isArray(parsed.cast) ? parsed.cast : [],
    backdrop: String(parsed.backdrop || '') || images.find((entry) => /backdrop|fanart/i.test(entry)) || '',
    unused: unusedFieldsText(info),
  })}`);

  line(`[${label}] id=${String(id ?? '?')} NYERS VÁLASZ (info, max. ${RAW_PREVIEW_CHARS} karakter): ${jsonPreview(info)}`);
  if (movieData) {
    line(`[${label}] id=${String(id ?? '?')} NYERS FILM ADATOK (movie_data): ${jsonPreview(movieData, 400)}`);
  }
}

/** A kérés címe belépési adatok nélkül (a naplóban így is olvasható). */
function endpointText(serverUrl: string | undefined, action: string, id: number | string | undefined): string {
  if (!serverUrl) return `action=${action}; id=${String(id ?? '?')}`;
  try {
    const url = new URL(serverUrl);
    const base = `${url.origin}${url.pathname && url.pathname !== '/' ? url.pathname : '/player_api.php'}`;
    return `${base}?action=${action}&id=${String(id ?? '?')} (felhasználónév/jelszó nélkül)`;
  } catch {
    return `action=${action}; id=${String(id ?? '?')}`;
  }
}

function describeKeys(record: Record<string, unknown> | null): string {
  if (!record) return 'nincs';
  const keys = Object.keys(record);
  if (!keys.length) return 'nincs';
  const shown = keys.slice(0, 30).join(', ');
  return `${keys.length} mező: ${shown}${keys.length > 30 ? ', …' : ''}`;
}

/** Sorozat: évadok, részek és az első rész adatainak naplózása. */
function logSeriesEpisodes(root: Record<string, unknown> | null, id: number | string | undefined): void {
  const episodes = recordOf(root?.episodes);
  const seasons = Array.isArray(root?.seasons) ? root?.seasons as unknown[] : [];
  if (!episodes && !seasons.length) {
    line(`[sorozat] id=${String(id ?? '?')} ÉVADOK/RÉSZEK: a válasz nem tartalmaz epizódlistát`);
    return;
  }
  const seasonKeys = episodes ? Object.keys(episodes) : [];
  const total = seasonKeys.reduce((sum, key) => {
    const list = episodes?.[key];
    return sum + (Array.isArray(list) ? list.length : 0);
  }, 0);
  line(`[sorozat] id=${String(id ?? '?')} ÉVADOK/RÉSZEK: ${countText(seasonKeys.length)} évad, ${countText(total)} rész`
    + (seasons.length ? `; seasons mező: ${seasons.length} évad` : '')
    + (seasonKeys.length ? `; évadok: ${seasonKeys.join(', ')}` : ''));

  // Mennyi adat van ténylegesen a részeknél (a szolgáltatók ezt nagyon eltérően adják).
  let withDuration = 0;
  let withImage = 0;
  let withPlot = 0;
  let withAudio = 0;
  let withSubtitles = 0;
  for (const key of seasonKeys) {
    const list = episodes?.[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const record = recordOf(entry);
      const entryInfo = recordOf(record?.info) ?? record;
      if (!entryInfo) continue;
      if (isPresent(field(entryInfo, ['duration', 'duration_secs', 'duration_seconds', 'episode_run_time']))) withDuration += 1;
      if (isPresent(field(entryInfo, ['movie_image', 'image', 'thumbnail', 'cover']))) withImage += 1;
      if (isPresent(field(entryInfo, ['plot', 'description', 'overview']))) withPlot += 1;
      if (isPresent(field(entryInfo, ['audio', 'audios', 'audio_tracks']))) withAudio += 1;
      if (isPresent(field(entryInfo, ['subtitles', 'sub_titles', 'subs']))) withSubtitles += 1;
    }
  }
  if (total > 0) {
    line(`[sorozat] id=${String(id ?? '?')} RÉSZEK ADATLEFEDETTSÉGE: játékidő=${withDuration}/${total}; kép=${withImage}/${total}; `
      + `leírás=${withPlot}/${total}; hang=${withAudio}/${total}; felirat=${withSubtitles}/${total}`);
  }

  const firstSeasonKey = seasonKeys[0];
  const firstList = firstSeasonKey && episodes ? episodes[firstSeasonKey] : undefined;
  const firstEpisode = Array.isArray(firstList) ? recordOf(firstList[0]) : null;
  if (!firstEpisode) return;
  const episodeInfo = recordOf(firstEpisode.info) ?? firstEpisode;
  const parsedEpisode = parseVodMetadata({ info: episodeInfo });
  const episodeAudio = visibleLanguages(parsedEpisode.audioLanguages);
  const episodeSubtitles = visibleLanguages(parsedEpisode.subtitleLanguages);
  const episodeImages: string[] = [];
  imageFields(episodeInfo, 'epizód.', episodeImages);
  line(`[sorozat] id=${String(id ?? '?')} ELSŐ RÉSZ: „${text(field(firstEpisode, ['title', 'name']) || 'cím nélkül', 60)}”`
    + ` S${String(field(firstEpisode, ['season']) ?? firstSeasonKey ?? '?')}E${String(field(firstEpisode, ['episode_num', 'episode', 'episode_number']) ?? '?')}`
    + ` (id=${String(field(firstEpisode, ['id', 'episode_id', 'stream_id']) ?? '?')})`
    + `; év=${parsedEpisode.year || 'nincs'}`
    + `; játékidő=${parsedEpisode.durationMinutes > 0 ? `${parsedEpisode.durationMinutes} perc` : 'nincs'}`
    + ` (${parseDurationFields(episodeInfo) || 'nincs duration mező'})`
    + `; hang=${episodeAudio.length ? episodeAudio.join(', ') : 'nincs'}`
    + `; felirat=${episodeSubtitles.length ? episodeSubtitles.join(', ') : 'nincs'}`
    + `; kép=${episodeImages.length ? episodeImages.join('; ') : 'nincs'}`);
  line(`[sorozat] id=${String(id ?? '?')} ELSŐ RÉSZ NYERS MEZŐK: ${describeKeys(episodeInfo)}`
    + `; egyéb: ${unusedFieldsText(episodeInfo, 8) || 'nincs'}`);
}

/* ─────────────────────────────── részletes lekérés ───────────────────────── */

function probeEndpoint(ctx: VodDiagnosticsContext): boolean {
  const provider = ctx.provider;
  if (!providerIsXtream(provider)) return false;
  return Boolean(provider?.serverUrl && provider.username && provider.password);
}

async function probeItem(kind: VodKind, item: Movie | Series): Promise<void> {
  if (!loggingActive()) return;
  if (probesUsed >= MAX_DETAILED_PROBES) return;
  const ctx = contextGetter?.();
  const provider = ctx?.provider;
  const id = itemIdOf(kind, item);
  if (!ctx || !provider || id === undefined || id === null || !probeEndpoint(ctx)) return;
  const key = itemKey(kind, id);
  const previous = probedItems.get(key);
  if (previous && Date.now() - previous < ITEM_COOLDOWN_MS) return;

  probesUsed += 1;
  const label = kind === 'movie' ? 'film' : 'sorozat';
  const endpoint = kind === 'movie' ? 'get_vod_info' : 'get_series_info';
  const startedAt = Date.now();
  line(`[${label}] „${itemTitle(item)}” (id=${String(id)}) RÉSZLETES KÉRÉS → ${endpoint}; a szolgáltató válasza a naplóban`);
  line(`[${label}] id=${String(id)} KÉRÉS CÍME: ${endpointText(provider.serverUrl, endpoint, id)}`);
  try {
    const response = kind === 'movie'
      ? await transport.vodInfo(provider.serverUrl!, provider.username!, provider.password!, id)
      : await transport.seriesInfo(provider.serverUrl!, provider.username!, provider.password!, id);
    const elapsed = Date.now() - startedAt;
    const root = recordOf(response);
    const empty = !root || Object.keys(root).length === 0;
    line(`[${label}] id=${String(id)} VÁLASZ: ${empty ? 'ÜRES válasz (a szolgáltató nem adott adatot)' : 'megérkezett'}`
      + `; ${elapsed} ms; forrás: ${endpoint}`);
    if (empty) {
      probedItems.set(key, Date.now());
      return;
    }
    logVodItemResponse(kind, item, response, `${endpoint} (automatikus teszt)`);
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    line(`[${label}] id=${String(id)} VÁLASZ HIBA (${elapsed} ms): ${text(message, 200)}`);
    probedItems.set(key, Date.now());
  }
}

async function probeKind(kind: VodKind, ctx: VodDiagnosticsContext, limit: number): Promise<void> {
  const list = (kind === 'movie' ? ctx.movies : ctx.series) as Array<Movie | Series>;
  if (!list.length) return;
  const targets = list.slice(0, Math.max(0, limit));
  for (const item of targets) {
    if (!loggingActive() || probesUsed >= MAX_DETAILED_PROBES) return;
    // Sorban, egyesével: a napló sorai így olvashatók maradnak, és a kímélő
    // hálózati réteget sem terheljük párhuzamos kérésekkel.
    // eslint-disable-next-line no-await-in-loop
    await probeItem(kind, item);
  }
}

/* ─────────────────────────────── belépési pontok ─────────────────────────── */

/**
 * Teljes szolgáltatói áttekintés (szinkron, kérés nélkül): darabszámok,
 * kategóriák, és hogy a listavégpont mely mezőket adja a programnak.
 */
export function logVodOverview(force = false): void {
  if (!loggingActive()) return;
  const now = Date.now();
  if (!force && now - lastOverviewAt < 5000) return;
  lastOverviewAt = now;
  const ctx = contextGetter?.();
  if (!ctx) return;

  line('=== SZOLGÁLTATÓI VOD-METAADAT TESZT (filmek és sorozatok) ===');
  line(`szolgáltató: ${providerLabel(ctx.provider)}`
    + `; film a programban=${countText(ctx.movies.length)}`
    + `; sorozat a programban=${countText(ctx.series.length)}`
    + `; szolgáltatói összes: film=${countText(ctx.totals?.vod ?? 0)}, sorozat=${countText(ctx.totals?.series ?? 0)}`
    + `; film-kategória=${categorySummary(ctx.vodCategories)}`
    + `; sorozat-kategória=${categorySummary(ctx.seriesCategories)}`);
  if (!ctx.movies.length && !ctx.series.length) {
    line('a film/sorozat lista még üres ebben a pillanatban – a nézet megnyitásakor a teszt újra lefut');
    return;
  }
  if (!providerIsXtream(ctx.provider)) {
    line(`a részletes szolgáltatói teszt csak Xtream szolgáltatónál fut; a mostani típus: ${ctx.provider?.type || 'nincs'}`);
  }
  line(`[film lista] MEZŐK a programban: ${presenceSummary('movie', ctx.movies)}`);
  line(`[sorozat lista] MEZŐK a programban: ${presenceSummary('series', ctx.series)}`);
  line('MAGYARÁZAT: a lista-végpont (get_vod_streams / get_series) csak a fenti mezőket adja; '
    + 'a játékidő, a hang- és feliratnyelvek részletei a get_vod_info / get_series_info válaszból jönnek.');
}

/**
 * Belépés a Mozi vagy a Sorozatok nézetbe: a látható lista mintájának és a
 * szolgáltató részletes válaszának naplózása.
 */
export function inspectVodSection(view: 'movies' | 'series'): void {
  if (!loggingActive() || !contextGetter) return;
  const kind: VodKind = view === 'movies' ? 'movie' : 'series';
  const now = Date.now();
  const last = lastSectionAt.get(kind) || 0;
  if (now - last < SECTION_COOLDOWN_MS) return;
  lastSectionAt.set(kind, now);

  const ctx = contextGetter();
  const label = kind === 'movie' ? 'Mozi' : 'Sorozatok';
  const list = (kind === 'movie' ? ctx.movies : ctx.series) as Array<Movie | Series>;
  line(`[${label}] NÉZET MEGNYITVA: ${countText(list.length)} elem a listában; `
    + `részletes szolgáltatói teszt ${probeEndpoint(ctx) ? `legfeljebb ${SECTION_DETAILED_PROBES} elemen` : 'kihagyva (nincs Xtream szolgáltató)'}`);
  probeSection(kind, label, ctx, SECTION_DETAILED_PROBES);
}

function probeSection(kind: VodKind, label: string, ctx: VodDiagnosticsContext, limit: number, attempt = 0): void {
  if (!loggingActive()) return;
  const list = (kind === 'movie' ? ctx.movies : ctx.series) as Array<Movie | Series>;
  if (!list.length) {
    // A lista a nézet megnyitásakor még tölthet: korlátozott számú újrapróbálás.
    if (attempt >= 4) {
      line(`[${label}] a film/sorozat lista nem töltődött be a teszt idejére (${attempt} próba után feladva)`);
      return;
    }
    try {
      window.setTimeout(() => {
        const next = contextGetter?.();
        if (!next) return;
        probeSection(kind, label, next, limit, attempt + 1);
      }, 1500);
    } catch { /* régi motor */ }
    return;
  }
  logListSample(kind, list);
  if (!probeEndpoint(ctx)) {
    line(`[${label}] RÉSZLETES TESZT KIHAGYVA: ${ctx.provider ? 'a szolgáltató nem Xtream, vagy hiányzik a belépési adat' : 'nincs beállított szolgáltató'}`);
    return;
  }
  void probeKind(kind, ctx, limit);
}

/* ─────────────────────────── naplózás életciklusa ────────────────────────── */

function runStartProbe(): void {
  startTimer = null;
  if (!loggingActive()) return;
  const ctx = contextGetter?.();
  if (!ctx) return;
  if (!ctx.provider) {
    if (startAttempts < 3) {
      startAttempts += 1;
      scheduleStartProbe(2000);
    } else {
      line('naplózás indítása: nincs betöltött szolgáltató – a Mozi/Sorozat nézet megnyitásakor fut a teszt');
    }
    return;
  }
  logVodOverview(true);
  line(`naplózás indítása: részletes szolgáltatói teszt indul (${START_DETAILED_PROBES} film + ${START_DETAILED_PROBES} sorozat)`);
  // Sorban egymás után: így a naplóban a filmek és a sorozatok sorai nem
  // keverednek össze, és egyszerre legfeljebb egy diagnosztikai kérés fut.
  void (async () => {
    await probeKind('movie', ctx, START_DETAILED_PROBES);
    await probeKind('series', ctx, START_DETAILED_PROBES);
  })();
}

function scheduleStartProbe(delay: number): void {
  if (startTimer !== null) return;
  try {
    startTimer = window.setTimeout(runStartProbe, delay);
  } catch {
    startTimer = null;
  }
}

/**
 * Csatlakozás a naplózás életciklusához. A `getContext` a főoldal állapotát
 * adja vissza minden híváskor (nem tárolunk elavult listát).
 */
export function attachVodProviderDiagnostics(
  getContext: VodDiagnosticsContextGetter,
  options?: { transport?: VodProbeTransport },
): () => void {
  contextGetter = getContext;
  transport = options?.transport || defaultTransport;
  if (!detachLifecycle) {
    const unsubscribe = registerLoggingLifecycleHooks({
      onStart: () => {
        probesUsed = 0;
        probedItems.clear();
        lastSectionAt.clear();
        startAttempts = 0;
        scheduleStartProbe(800);
      },
      onStop: () => {
        if (startTimer !== null) {
          try { window.clearTimeout(startTimer); } catch { /* régi motor */ }
          startTimer = null;
        }
        if (probesUsed > 0 || lastOverviewAt > 0) {
          line(`naplózás leállt: a VOD-metaadat teszt ${probesUsed} részletes szolgáltatói kérést végzett ebben a munkamenetben`);
        }
      },
    });
    detachLifecycle = unsubscribe;
  }
  return () => {
    if (detachLifecycle) {
      detachLifecycle();
      detachLifecycle = null;
    }
    contextGetter = null;
  };
}
