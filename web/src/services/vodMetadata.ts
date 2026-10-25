import { AudioTrack, SubtitleTrack } from '../types/iptv';
import { collectSubtitleEntries } from './subtitleService';

/** A szolgáltatói válasz hiányos vagy eltérő alakja esetén ezt mutatjuk. */
export const UNKNOWN_LANGUAGE = 'Ismeretlen';

export interface ParsedVodMetadata {
  durationMinutes: number;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  audioLanguages: string[];
  subtitleLanguages: string[];
  poster?: string;
  backdrop?: string;
  plot?: string;
  genres?: string[];
  director?: string;
  cast?: string[];
  rating?: number;
  year?: number;
}

const LANGUAGE_LABELS: Record<string, string> = {
  hu: 'Magyar', hun: 'Magyar', hungarian: 'Magyar', magyar: 'Magyar',
  en: 'Angol', eng: 'Angol', english: 'Angol', angol: 'Angol',
  de: 'Német', deu: 'Német', ger: 'Német', german: 'Német', deutsch: 'Német', német: 'Német',
  fr: 'Francia', fra: 'Francia', fre: 'Francia', french: 'Francia', francais: 'Francia', francia: 'Francia',
  it: 'Olasz', ita: 'Olasz', italian: 'Olasz', olasz: 'Olasz',
  es: 'Spanyol', spa: 'Spanyol', spanish: 'Spanyol', espanol: 'Spanyol', spanyol: 'Spanyol',
  pt: 'Portugál', por: 'Portugál', portuguese: 'Portugál', portugál: 'Portugál',
  pl: 'Lengyel', pol: 'Lengyel', polish: 'Lengyel', lengyel: 'Lengyel',
  ru: 'Orosz', rus: 'Orosz', russian: 'Orosz', orosz: 'Orosz',
  ja: 'Japán', jpn: 'Japán', japanese: 'Japán', japán: 'Japán',
  ko: 'Koreai', kor: 'Koreai', korean: 'Koreai', koreai: 'Koreai',
  tr: 'Török', tur: 'Török', turkish: 'Török', török: 'Török',
  nl: 'Holland', dut: 'Holland', nld: 'Holland', dutch: 'Holland', holland: 'Holland',
  cs: 'Cseh', ces: 'Cseh', cze: 'Cseh', czech: 'Cseh', cseh: 'Cseh',
  sk: 'Szlovák', slk: 'Szlovák', slo: 'Szlovák', slovak: 'Szlovák', szlovák: 'Szlovák',
  ro: 'Román', ron: 'Román', rum: 'Román', romanian: 'Román', román: 'Román',
  uk: 'Ukrán', ukr: 'Ukrán', ukrainian: 'Ukrán', ukrán: 'Ukrán',
  zh: 'Kínai', zho: 'Kínai', chi: 'Kínai', chinese: 'Kínai', kínai: 'Kínai',
};

const UNKNOWN_WORDS = /^(?:und|unknown|unk|n\/a|na|null|none|not?\s+available|ismeretlen|nincs)$/i;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value == null ? '' : String(value).trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function firstValue(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) return undefined;
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(record)) {
    if (wanted.has(key.toLowerCase()) && value !== undefined && value !== null && clean(value) !== '') return value;
  }
  return undefined;
}

function flattenText(value: unknown): string[] {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) return parsed.flatMap((item) => flattenText(item));
  if (parsed && typeof parsed === 'object') {
    return Object.values(parsed as Record<string, unknown>).flatMap((item) => flattenText(item));
  }
  const text = clean(parsed);
  return text ? text.split(/[|,;]+/).map((part) => part.trim()).filter(Boolean) : [];
}

/** Nyelvkódot vagy nyelvnevet egységes, a TV-n olvasható névre alakít. */
export function displayLanguage(value: unknown): string {
  const raw = clean(value);
  if (!raw || UNKNOWN_WORDS.test(raw)) return UNKNOWN_LANGUAGE;
  const normalized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (LANGUAGE_LABELS[raw.toLowerCase()]) return LANGUAGE_LABELS[raw.toLowerCase()];
  if (LANGUAGE_LABELS[normalized]) return LANGUAGE_LABELS[normalized];
  // „English (Original)” és hasonló szolgáltatói címkékből ismerjük fel a nyelvet.
  for (const [key, label] of Object.entries(LANGUAGE_LABELS)) {
    const keyNormalized = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (key.length > 2 && (normalized.includes(keyNormalized) || raw.toLowerCase().includes(key))) return label;
  }
  return raw.slice(0, 40) || UNKNOWN_LANGUAGE;
}

function languageValue(record: Record<string, unknown> | null): string {
  const value = firstValue(record, [
    'language', 'lang', 'language_code', 'lang_code', 'iso', 'iso639', 'iso639_1', 'iso_639_1',
    'locale', 'audio_language', 'audio_lang', 'subtitle_language', 'subtitle_lang',
  ]);
  if (value !== undefined) return clean(value);
  const name = firstValue(record, ['title', 'name', 'label', 'language_name']);
  const label = displayLanguage(name);
  // Codec-nevek és hangsávtechnikai címkék nem nyelv-adatok.
  return label === UNKNOWN_LANGUAGE ? '' : clean(name);
}

function trackName(record: Record<string, unknown> | null, rawLanguage: string, index: number, kind: 'audio' | 'subtitle'): string {
  const explicit = clean(firstValue(record, ['title', 'name', 'label', 'track_name', 'language_name']));
  if (explicit && displayLanguage(explicit) === UNKNOWN_LANGUAGE) return displayLanguage(rawLanguage) !== UNKNOWN_LANGUAGE ? displayLanguage(rawLanguage) : explicit;
  return explicit || (displayLanguage(rawLanguage) !== UNKNOWN_LANGUAGE ? displayLanguage(rawLanguage) : `${kind === 'audio' ? 'Hangsáv' : 'Felirat'} ${index + 1}`);
}

function addAudioValue(value: unknown, out: Record<string, unknown>[]): void {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    parsed.forEach((item) => {
      if (typeof item === 'string' || typeof item === 'number') out.push({ language: String(item) });
      else if (asRecord(item)) out.push(asRecord(item)!);
    });
    return;
  }
  if (typeof parsed === 'string' || typeof parsed === 'number') {
    flattenText(parsed).forEach((part) => out.push({ language: part }));
    return;
  }
  const record = asRecord(parsed);
  if (!record) return;
  if (firstValue(record, ['language', 'lang', 'language_code', 'lang_code', 'iso', 'locale', 'name', 'title']) !== undefined) {
    out.push(record);
    return;
  }
  for (const [key, item] of Object.entries(record)) {
    const itemRecord = asRecord(parseJson(item));
    if (itemRecord) out.push({ ...itemRecord, language: languageValue(itemRecord) || key });
    else if (typeof item === 'string' || typeof item === 'number') out.push({ language: key, name: String(item) });
  }
}

function collectAudioEntries(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || node === null || node === undefined) return;
  const record = asRecord(node);
  if (!record) {
    if (Array.isArray(node)) node.forEach((item) => collectAudioEntries(item, out, depth + 1));
    return;
  }
  for (const [key, value] of Object.entries(record)) {
    const lower = key.toLowerCase().replace(/[- ]/g, '_');
    if (/^(?:audio|audios|soundtrack)(?:_|$)/i.test(lower) || /^(?:audio_tracks?|audio_languages?)$/i.test(lower)) {
      addAudioValue(value, out);
    } else if (value && typeof value === 'object') {
      collectAudioEntries(value, out, depth + 1);
    }
  }
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseAudioTracks(node: unknown): { tracks: AudioTrack[]; languages: string[] } {
  const entries: Record<string, unknown>[] = [];
  collectAudioEntries(node, entries);
  const tracks: AudioTrack[] = [];
  const languages: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const rawLanguage = languageValue(entry);
    const label = displayLanguage(rawLanguage || firstValue(entry, ['language_name', 'name', 'title']));
    if (label === UNKNOWN_LANGUAGE && !rawLanguage && !firstValue(entry, ['language_name', 'name', 'title'])) return;
    const key = `${label.toLowerCase()}|${clean(firstValue(entry, ['codec']))}`;
    if (seen.has(key)) return;
    seen.add(key);
    const track: AudioTrack = {
      id: `api-audio-${index}`,
      name: trackName(entry, rawLanguage, index, 'audio'),
      lang: rawLanguage || label,
    };
    const codec = clean(firstValue(entry, ['codec', 'codec_name', 'format']));
    const channels = clean(firstValue(entry, ['channels', 'channel_layout']));
    if (codec) track.codec = codec;
    if (channels) track.channels = channels;
    tracks.push(track);
    languages.push(label);
  });
  return { tracks, languages: unique(languages) };
}

function parseSubtitleTracks(node: unknown): { tracks: SubtitleTrack[]; languages: string[] } {
  const entries: Record<string, unknown>[] = [];
  collectSubtitleEntries(node, entries);
  const tracks: SubtitleTrack[] = [];
  const languages: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const rawLanguage = languageValue(entry);
    const label = displayLanguage(rawLanguage || firstValue(entry, ['language_name', 'name', 'title']));
    const id = clean(firstValue(entry, ['sub_id', 'subId', 'subtitle_id', 'id'])) || `api-subtitle-${index}`;
    const direct = clean(firstValue(entry, ['url', 'src', 'file', 'path', 'sub_url', 'subtitle_url', 'download_url', 'file_url', 'download', 'link', 'href']));
    const key = `${id}|${label}|${direct}`;
    if (seen.has(key)) return;
    seen.add(key);
    const track: SubtitleTrack = {
      id,
      name: trackName(entry, rawLanguage, index, 'subtitle'),
      lang: rawLanguage || label,
    };
    if (direct) {
      track.url = direct;
      track.urls = [direct];
    }
    tracks.push(track);
    languages.push(label);
  });
  return { tracks, languages: unique(languages) };
}

function durationMinutesFromValue(value: unknown, key = 'duration'): number {
  const text = clean(value);
  if (!text) return 0;
  const colon = text.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (colon) {
    const first = Number(colon[1]);
    const second = Number(colon[2]);
    const third = colon[3] === undefined ? 0 : Number(colon[3]);
    return colon[3] === undefined ? Math.max(0, first) : Math.max(0, Math.round(first * 60 + second + third / 60));
  }
  const hours = text.match(/(\d+(?:\.\d+)?)\s*h(?:ours?)?/i);
  const minutes = text.match(/(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?/i);
  if (hours || minutes) return Math.max(0, Math.round((hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0)));
  const numeric = Number(text.replace(',', '.').replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  const lower = key.toLowerCase();
  if (lower.includes('sec') || lower.endsWith('_ms')) return Math.max(0, Math.round(numeric / (lower.endsWith('_ms') ? 60000 : 60)));
  // A raw Xtream duration is usually seconds when it is larger than five hours.
  return Math.max(0, Math.round(numeric > 300 ? numeric / 60 : numeric));
}

function findDuration(node: unknown, depth = 0): number {
  if (depth > 4 || node === null || node === undefined) return 0;
  const record = asRecord(node);
  if (record) {
    for (const [key, value] of Object.entries(record)) {
      const lower = key.toLowerCase();
      if (/duration_secs?|duration_seconds?|runtime_seconds?/.test(lower)) {
        const parsed = durationMinutesFromValue(value, key);
        if (parsed > 0) return parsed;
      }
    }
    for (const key of ['duration_minutes', 'episode_run_time', 'duration', 'runtime', 'length']) {
      const value = firstValue(record, [key]);
      const parsed = durationMinutesFromValue(value, key);
      if (parsed > 0) return parsed;
    }
    for (const value of Object.values(record)) {
      const parsed = findDuration(value, depth + 1);
      if (parsed > 0) return parsed;
    }
  } else if (Array.isArray(node)) {
    for (const value of node) {
      const parsed = findDuration(value, depth + 1);
      if (parsed > 0) return parsed;
    }
  }
  return 0;
}

function firstText(node: unknown, keys: string[]): string {
  const record = asRecord(node);
  const value = firstValue(record, keys);
  return clean(value);
}

function parseYear(node: unknown): number {
  const text = firstText(node, ['releasedate', 'releaseDate', 'release_date', 'year', 'release_year']);
  return Number((text.match(/\d{4}/) || [0])[0]) || 0;
}

function parseGenres(node: unknown): string[] {
  return unique(flattenText(firstValue(asRecord(node), ['genre', 'genres'])));
}

function parseCast(node: unknown): string[] {
  return unique(flattenText(firstValue(asRecord(node), ['cast', 'actors', 'actor'])));
}

function parseCommon(node: unknown): Partial<ParsedVodMetadata> {
  const record = asRecord(node);
  const audio = parseAudioTracks(node);
  const subtitles = parseSubtitleTracks(node);
  return {
    durationMinutes: findDuration(node),
    audioTracks: audio.tracks,
    subtitleTracks: subtitles.tracks,
    audioLanguages: audio.languages.length ? audio.languages : [UNKNOWN_LANGUAGE],
    subtitleLanguages: subtitles.languages.length ? subtitles.languages : [UNKNOWN_LANGUAGE],
    poster: firstText(record, ['movie_image', 'cover_big', 'cover', 'poster', 'stream_icon', 'image']),
    backdrop: firstText(record, ['backdrop_path', 'backdrop', 'backdrop_url', 'fanart']),
    plot: firstText(record, ['plot', 'description', 'overview']),
    genres: parseGenres(node),
    director: firstText(record, ['director']),
    cast: parseCast(node),
    rating: Number(firstValue(record, ['rating', 'rating_5based']) || 0) || 0,
    year: parseYear(node),
  };
}

/** A get_vod_info válaszának normalizált, UI- és tárolóbarát metaadata. */
export function parseVodMetadata(response: unknown): ParsedVodMetadata {
  const root = asRecord(response);
  const info = root?.info ?? response;
  const common = parseCommon(info);
  // Néhány panel a plakátot csak a movie_data objektumban küldi.
  const movieData = root?.movie_data;
  if (!common.poster) common.poster = firstText(movieData, ['movie_image', 'cover_big', 'cover', 'poster', 'stream_icon']);
  if (!common.durationMinutes) common.durationMinutes = findDuration(movieData);
  if (!common.audioTracks?.length) {
    const extraAudio = parseAudioTracks(movieData);
    common.audioTracks = extraAudio.tracks;
    common.audioLanguages = extraAudio.languages.length ? extraAudio.languages : [UNKNOWN_LANGUAGE];
  }
  if (!common.subtitleTracks?.length) {
    const extraSubtitles = parseSubtitleTracks(movieData);
    common.subtitleTracks = extraSubtitles.tracks;
    common.subtitleLanguages = extraSubtitles.languages.length ? extraSubtitles.languages : [UNKNOWN_LANGUAGE];
  }
  return {
    durationMinutes: common.durationMinutes || 0,
    audioTracks: common.audioTracks || [],
    subtitleTracks: common.subtitleTracks || [],
    audioLanguages: common.audioLanguages || [UNKNOWN_LANGUAGE],
    subtitleLanguages: common.subtitleLanguages || [UNKNOWN_LANGUAGE],
    poster: common.poster || undefined,
    backdrop: common.backdrop || undefined,
    plot: common.plot || undefined,
    genres: common.genres || [],
    director: common.director || undefined,
    cast: common.cast || [],
    rating: common.rating || undefined,
    year: common.year || undefined,
  };
}

/** Sorozat-plakát metaadata: az info és az első epizód adatai együtt számítanak. */
export function parseSeriesMetadata(response: unknown): ParsedVodMetadata {
  const root = asRecord(response);
  const info = root?.info ?? response;
  const episodes = asRecord(root?.episodes);
  const firstSeason = episodes ? Object.values(episodes).find((value) => Array.isArray(value) && value.length > 0) as unknown[] | undefined : undefined;
  const firstEpisode = firstSeason?.[0];
  const fromInfo = parseCommon(info);
  const fromEpisode = parseCommon(firstEpisode);
  const audio = fromInfo.audioTracks?.length ? fromInfo : fromEpisode;
  const subtitles = fromInfo.subtitleTracks?.length ? fromInfo : fromEpisode;
  return {
    durationMinutes: fromInfo.durationMinutes || fromEpisode.durationMinutes || 0,
    audioTracks: audio.audioTracks || [],
    subtitleTracks: subtitles.subtitleTracks || [],
    audioLanguages: audio.audioLanguages?.length ? audio.audioLanguages : [UNKNOWN_LANGUAGE],
    subtitleLanguages: subtitles.subtitleLanguages?.length ? subtitles.subtitleLanguages : [UNKNOWN_LANGUAGE],
    poster: fromInfo.poster || undefined,
    backdrop: fromInfo.backdrop || undefined,
    plot: fromInfo.plot || undefined,
    genres: fromInfo.genres || [],
    director: fromInfo.director || undefined,
    cast: fromInfo.cast || [],
    rating: fromInfo.rating || undefined,
    year: fromInfo.year || undefined,
  };
}

/** Epizód-részletekhez ugyanaz a hiányzóadat-fallback tartozik, mint a plakáthoz. */
export function parseEpisodeMetadata(episode: unknown): ParsedVodMetadata {
  return parseVodMetadata({ info: asRecord(episode)?.info || episode });
}
