/**
 * ÉLŐ HANGSÁV-EMLÉKEZET – CSATORNÁNKÉNT.
 *
 * A felhasználó kérése: a zöld gombos „Hangsáv / CC” ablakban kiválasztott
 * hangsáv legyen menthető az adott TV-csatornához, és utána
 *   • másik csatornára váltva, majd visszatérve,
 *   • valamint az IPK újraindítása után is
 * ugyanaz a hangsáv töltődjön be.
 *
 * Ez a modul kizárólag a CSATORNÁNKÉNTI hangsáv-választást tárolja: a
 * csatorna-azonosítóhoz egy kicsi, olvasható bejegyzést (nyelv, név,
 * sorszám). A nagy tartalom (csatornalista, filmek) továbbra is a
 * contentStore-ban van – ez a kulcs ezért szándékosan apró marad.
 *
 * A tároló korlátozott méretű (MAX_ENTRIES), a legrégebbi bejegyzések esnek
 * ki először, hogy hosszú használat után se nője túl a TV tárhelyét.
 */
import type { AudioTrack } from '../types/iptv';

/** Egy csatornához mentett hangsáv ismertetőjegyei. */
export interface SavedLiveAudioTrack {
  /** A sáv nyelve a lejátszó szerint (pl. `hu`, `eng`, `Magyar`). */
  lang: string;
  /** A sáv neve/címkéje a lejátszó szerint. */
  name: string;
  codec?: string;
  channels?: string;
  /** A lejátszó által adott sorszám – csak végső tartalék azonosító. */
  nativeIndex?: number;
  /** Hányadik sáv azonos nyelven belül (pl. két magyar hangsáv). */
  ordinalInLang?: number;
  /** A sáv helye a mentéskor látott listában (0-tól). */
  listIndex?: number;
  /** A mentéskor látott lista hossza – az index csak egyező hossznál biztos. */
  trackCount?: number;
  savedAt: number;
}

const MEMORY_KEY = 'iptv_rt_live_audio_memory_v1';
const MAX_ENTRIES = 2000;
const MAX_KEY_LENGTH = 120;

type Memory = Record<string, SavedLiveAudioTrack>;

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    // A webOS néhány változatán a localStorage elérése is dobhat (privát mód).
    return null;
  }
}

function normalizeChannelId(channelId: string | number | null | undefined): string {
  return String(channelId ?? '').trim().slice(0, MAX_KEY_LENGTH);
}

/** Nyelvkód-egységesítés: `hu-HU`, `HUN`, `Magyar` → `hu`. */
export function normalizeAudioLang(value: unknown): string {
  const text = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (!text) return '';
  const first = text.split(/[^a-z]+/).filter(Boolean)[0] || '';
  const aliases: Record<string, string> = {
    hu: 'hu', hun: 'hu', magyar: 'hu', hungarian: 'hu',
    en: 'en', eng: 'en', english: 'en', angol: 'en', original: 'en',
    de: 'de', deu: 'de', ger: 'de', german: 'de', deutsch: 'de', nemet: 'de',
    fr: 'fr', fra: 'fr', fre: 'fr', french: 'fr', francais: 'fr', francia: 'fr',
    it: 'it', ita: 'it', italian: 'it', italiano: 'it', olasz: 'it',
    es: 'es', spa: 'es', spanish: 'es', espanol: 'es', spanyol: 'es',
    sk: 'sk', slk: 'sk', slovak: 'sk', szlovak: 'sk',
    ro: 'ro', ron: 'ro', rum: 'ro', romanian: 'ro', roman: 'ro',
    cs: 'cs', ces: 'cs', cze: 'cs', czech: 'cs', cseh: 'cs',
  };
  return aliases[first] || first;
}

function normalizeName(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function readMemory(): Memory {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(MEMORY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const memory: Memory = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key || key.length > MAX_KEY_LENGTH) continue;
      const entry = value as Partial<SavedLiveAudioTrack> | null;
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.lang !== 'string' && typeof entry.name !== 'string') continue;
      memory[key] = {
        lang: String(entry.lang || ''),
        name: String(entry.name || ''),
        codec: entry.codec ? String(entry.codec) : undefined,
        channels: entry.channels ? String(entry.channels) : undefined,
        nativeIndex: Number.isFinite(Number(entry.nativeIndex)) ? Number(entry.nativeIndex) : undefined,
        ordinalInLang: Number.isFinite(Number(entry.ordinalInLang)) ? Number(entry.ordinalInLang) : undefined,
        listIndex: Number.isFinite(Number(entry.listIndex)) ? Number(entry.listIndex) : undefined,
        trackCount: Number.isFinite(Number(entry.trackCount)) ? Number(entry.trackCount) : undefined,
        savedAt: Number.isFinite(Number(entry.savedAt)) ? Number(entry.savedAt) : 0,
      };
    }
    return memory;
  } catch {
    return {};
  }
}

function writeMemory(memory: Memory): void {
  const store = storage();
  if (!store) return;
  try {
    const keys = Object.keys(memory);
    if (keys.length > MAX_ENTRIES) {
      // A legrégebbi bejegyzések kiesnek, hogy a tárhely ne nőjön korlátlanul.
      for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete memory[key];
    }
    store.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    /* a tárhely hibája nem akadályozhatja a lejátszást */
  }
}

/** A csatornához mentett hangsáv (vagy null, ha nincs mentés). */
export function rememberedAudioFor(channelId: string | number | null | undefined): SavedLiveAudioTrack | null {
  const key = normalizeChannelId(channelId);
  if (!key) return null;
  const memory = readMemory();
  return memory[key] || null;
}

/** A csatorna hangsáv-beállításának elfelejtése. */
export function forgetAudioFor(channelId: string | number | null | undefined): void {
  const key = normalizeChannelId(channelId);
  if (!key) return;
  const memory = readMemory();
  if (!(key in memory)) return;
  delete memory[key];
  writeMemory(memory);
}

/**
 * A kiválasztott hangsáv mentése a csatornához.
 *
 * A nyelv és a név az elsődleges azonosító (ez marad meg akkor is, ha a TV a
 * sorszámozást vagy a sávok sorrendjét újraindítás után másképp adja meg).
 */
export function rememberAudioFor(
  channelId: string | number | null | undefined,
  track: AudioTrack,
  allTracks: AudioTrack[] = [],
): SavedLiveAudioTrack | null {
  const key = normalizeChannelId(channelId);
  if (!key || !track) return null;
  const lang = String(track.lang || '');
  const name = String(track.name || '');
  const exact = allTracks.find((item) => String(item.id) === String(track.id));
  const source = exact || track;
  const nativeIndexRaw = Number((source as AudioTrack & { nativeIndex?: number }).nativeIndex);
  const sameLang = normalizeAudioLang(lang)
    ? allTracks.filter((item) => normalizeAudioLang(item.lang) === normalizeAudioLang(lang))
    : [];
  const ordinalInLang = sameLang.length > 1
    ? sameLang.findIndex((item) => String(item.id) === String(track.id))
    : undefined;
  const listIndex = allTracks.findIndex((item) => String(item.id) === String(track.id));
  const entry: SavedLiveAudioTrack = {
    lang,
    name,
    codec: source.codec ? String(source.codec) : undefined,
    channels: source.channels ? String(source.channels) : undefined,
    nativeIndex: Number.isFinite(nativeIndexRaw) ? nativeIndexRaw : undefined,
    ordinalInLang: ordinalInLang !== undefined && ordinalInLang >= 0 ? ordinalInLang : undefined,
    listIndex: listIndex >= 0 ? listIndex : undefined,
    trackCount: allTracks.length > 0 ? allTracks.length : undefined,
    savedAt: Date.now(),
  };
  const memory = readMemory();
  delete memory[key];
  memory[key] = entry;
  writeMemory(memory);
  return entry;
}

/**
 * A mentett bejegyzéshez tartozó tényleges sáv megkeresése az ÉPPEN
 * elérhető listában.
 *
 * Sorrend:
 *   1. azonos nyelv (egyetlen találat → az),
 *   2. azonos nyelv + név, majd a nyelven belüli sorszám,
 *   3. egyértelmű név,
 *   4. a mentéskor látott LISTAHELY (ha a lista hossza ugyanaz) – ez fogja
 *      meg az olyan adásokat, ahol minden sáv neve azonos vagy üres
 *      (korábban ilyenkor mindig az ELSŐ sávot találta meg),
 *   5. a lejátszó saját sorszáma.
 */
export function matchSavedAudioTrack(
  tracks: AudioTrack[] | null | undefined,
  saved: SavedLiveAudioTrack | null | undefined,
): AudioTrack | null {
  if (!saved || !tracks || tracks.length === 0) return null;
  const wantLang = normalizeAudioLang(saved.lang);
  const wantName = normalizeName(saved.name);
  const sameLang = wantLang
    ? tracks.filter((track) => normalizeAudioLang(track.lang) === wantLang)
    : [];
  if (sameLang.length === 1) return sameLang[0];
  if (sameLang.length > 1) {
    const byName = sameLang.find((track) => normalizeName(track.name) === wantName);
    if (byName) return byName;
    const ordinal = Number(saved.ordinalInLang);
    if (Number.isInteger(ordinal) && ordinal >= 0 && ordinal < sameLang.length) return sameLang[ordinal];
    return sameLang[0];
  }
  if (wantName) {
    const named = tracks.filter((track) => normalizeName(track.name) === wantName);
    if (named.length === 1) return named[0];
    if (named.length > 1) {
      // Azonos nevű sávok: a mentéskor látott hely dönt, ne az első találat.
      const atSavedPlace = placeMatch(named, tracks, saved);
      return atSavedPlace || named[0];
    }
  }
  if (!wantName) {
    // Nincs név-információ (a TV üres címkéket ad): a listahely a biztos fogódzó.
    const byPlace = placeMatch(tracks, tracks, saved);
    if (byPlace) return byPlace;
  }
  const savedIndex = Number(saved.nativeIndex);
  if (Number.isFinite(savedIndex)) {
    const byNative = tracks.find((track) =>
      Number((track as AudioTrack & { nativeIndex?: number }).nativeIndex) === savedIndex);
    if (byNative) return byNative;
  }
  return null;
}

/** A mentéskor látott listahely (csak azonos hosszúságú listánál biztos). */
function placeMatch(
  candidates: AudioTrack[],
  tracks: AudioTrack[],
  saved: SavedLiveAudioTrack,
): AudioTrack | null {
  const place = Number(saved.listIndex);
  const count = Number(saved.trackCount);
  if (!Number.isInteger(place) || place < 0 || place >= tracks.length) return null;
  if (!Number.isInteger(count) || count !== tracks.length) return null;
  const target = tracks[place];
  return candidates.includes(target) ? target : null;
}

/** Rövid, felületen is használható címke (pl. „Német”). */
export function savedAudioLabel(saved: SavedLiveAudioTrack | null | undefined): string {
  if (!saved) return '';
  return String(saved.name || saved.lang || '').trim();
}

/** Teljes törlés (Beállítások → gyorsítótár törlése). */
export function clearAudioMemory(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(MEMORY_KEY);
  } catch {
    /* nem kritikus */
  }
}
