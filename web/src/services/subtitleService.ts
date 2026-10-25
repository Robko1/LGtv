import { SubtitleTrack } from '../types/iptv';
import { httpGetJson, httpGetText } from './net';
import { appLog } from './appLog';
import { xtreamService } from './xtreamService';

/**
 * FILM / SOROZAT FELIRAT (CC) – szolgáltatói feliratok.
 *
 * A webOS beépített lejátszója csak a streambe MUXOLT feliratokat teszi közzé
 * (`video.textTracks`), a szolgáltatók viszont a filmekhez külön feliratfájlokat
 * tárolnak. Ezeket az Xtream `get_vod_info` / `get_series_info` válasza sorolja
 * fel (`subtitles` tömb, pl. `{ sub_id, language, title }`), a fájl pedig az
 * `…/subtitle/<user>/<pass>/<sub_id>.srt|.vtt` címen érhető el.
 *
 * Itt:
 *   1. megkeressük a válaszban a feliratlistát (több panel többféle alakot használ),
 *   2. felépítjük a lehetséges URL-eket; amelyik előre letölthető, azt jelöljük
 *      nyerőnek, de a lista a próba nélkül is megjelenik (választáskor újra
 *      próbáljuk), hogy a felsorolt felirat soha ne tűnjön el csendben,
 *   3. a kiválasztott fájlt letöltjük és beolvassuk (SRT / WebVTT / egyszerű ASS).
 *
 * A feliratot a lejátszó MAGA rajzolja ki (lásd VideoPlayer SubtitleOverlay),
 * mert a régi webOS Chromium nem mindig jeleníti meg a `<track>` elemeket.
 */

export interface VodSubtitleSource {
  /** Xtream szerver címe (a player_api.php nélkül is jó). */
  serverUrl: string;
  username: string;
  password: string;
  /** Film azonosító (get_vod_info → vod_id). */
  vodId?: string | number;
  /** Sorozat azonosító (get_series_info → series_id). */
  seriesId?: string | number;
  /** Epizód azonosító a sorozat válaszában. */
  episodeId?: string | number;
}

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

const PROBE_TIMEOUT_MS = 8000;
const MAX_SUBTITLES = 16;

/**
 * A naplóba NEM kerülhet a belépési adat: a felirat URL-je a felhasználónevet
 * és a jelszót is tartalmazza (`…/subtitle/<user>/<pass>/<id>.srt`). A naplót
 * a QR-kóddal bárki megnyithatja, ezért csak a fájlnév és a sorszám látszik.
 */
function safeSubtitleUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const file = parsed.pathname.split('/').filter(Boolean).pop() || '';
    return `${parsed.host}/…/${file}`;
  } catch {
    return 'felirat';
  }
}

function cleanBase(serverUrl: string): string {
  return xtreamService.baseUrl(serverUrl);
}

function looksLikeSubtitleUrl(value: string): boolean {
  const text = String(value || '').trim();
  return /^https?:\/\//i.test(text)
    || (text.startsWith('/') && (/\.(srt|vtt|ass|ssa)([?#]|$)/i.test(text) || /subtitle/i.test(text)));
}

/** Egy `subtitles` érték minden ismert alakjának bejegyzésekké alakítása. */
function addSubtitleValue(value: unknown, out: Record<string, unknown>[]): void {
  const parsed = typeof value === 'string' ? (safeJson(value) ?? value) : value;
  if (typeof parsed === 'string') {
    if (looksLikeSubtitleUrl(parsed)) out.push({ url: parsed });
    return;
  }
  if (Array.isArray(parsed)) {
    parsed.forEach((entry) => {
      if (entry && typeof entry === 'object') {
        out.push(entry as Record<string, unknown>);
      } else if (typeof entry === 'string') {
        // Van panel, amelyik csak címeket vagy csak nyelvkódokat sorol fel.
        if (looksLikeSubtitleUrl(entry)) out.push({ url: entry });
        else if (entry.trim() && entry.trim().length <= 24) out.push({ language: entry.trim() });
      } else if (typeof entry === 'number') {
        out.push({ sub_id: String(entry) });
      }
    });
    return;
  }
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.subtitles)) {
      addSubtitleValue(record.subtitles, out);
      return;
    }
    // Nyelv → felirat térképes alak: { "hu": {...}, "en": "http://..." }
    for (const [key, entry] of Object.entries(record)) {
      if (Array.isArray(entry)) {
        addSubtitleValue(entry, out);
      } else if (entry && typeof entry === 'object') {
        const item = entry as Record<string, unknown>;
        out.push('language' in item || 'lang' in item ? item : { ...item, language: key });
      } else if (typeof entry === 'string' && looksLikeSubtitleUrl(entry)) {
        out.push({ url: entry, language: key });
      }
    }
  }
}

/** A válaszban található feliratlisták összegyűjtése (több lehetséges alak). */
export function collectSubtitleEntries(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectSubtitleEntries(item, out, depth + 1));
    return;
  }
  if (typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const keyName = key.toLowerCase();
    if (keyName === 'subtitles' || keyName === 'sub_titles' || keyName === 'subs' || keyName === 'subtitle'
      || keyName === 'captions' || keyName === 'subtitle_list' || keyName === 'subtitles_list') {
      addSubtitleValue(value, out);
      continue;
    }
    collectSubtitleEntries(value, out, depth + 1);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickString(entry: Record<string, unknown>, keys: string[]): string {
  // A panelek a mezőneveket hol kis-, hol nagybetűvel adják – mindkettő jó.
  const byLowerKey = new Map<string, unknown>();
  for (const [key, value] of Object.entries(entry)) {
    if (!byLowerKey.has(key.toLowerCase())) byLowerKey.set(key.toLowerCase(), value);
  }
  for (const key of keys) {
    const value = byLowerKey.get(key.toLowerCase());
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/** A megadott URL tartalma felirat-e (SRT / WebVTT / egyszerű ASS). */
function looksLikeSubtitle(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 4000);
  if (/^\uFEFF?WEBVTT/i.test(head.trimStart()) || /-->/.test(head)) return true;
  return /\[Script Info\]/i.test(head) && /Dialogue:/i.test(text.slice(0, 12000));
}

interface Candidate {
  id: string;
  name: string;
  lang: string;
  urls: string[];
}

/**
 * A szolgáltatói feliratfájlok feloldása.
 *
 * Minden jelöltnél több URL-mintát is kipróbálunk, és a valóban feliratot
 * adó címet tesszük előre; a felsorolt sáv azonban a sikeres próba nélkül
 * is bekerül a listába (választáskor újrapróbáljuk a címeket) – így a CC
 * választó nem marad üresen egyetlen eltévesztett URL-minta miatt.
 * Ha a szolgáltató nem tárol feliratot, üres listával tér vissza – a muxolt
 * és a fájlba beágyazott feliratok ettől függetlenül működnek.
 */
export async function resolveVodSubtitles(source: VodSubtitleSource | null | undefined): Promise<SubtitleTrack[]> {
  if (!source?.serverUrl || !source.username || !source.password) return [];
  if (!source.vodId && !source.seriesId) return [];

  const base = cleanBase(source.serverUrl);
  const apiBase = `${base}/player_api.php?username=${encodeURIComponent(source.username)}&password=${encodeURIComponent(source.password)}`;
  const entries: Record<string, unknown>[] = [];

  try {
    if (source.vodId) {
      const info = await httpGetJson<Record<string, unknown>>(`${apiBase}&action=get_vod_info&vod_id=${encodeURIComponent(String(source.vodId))}`, { timeoutMs: 12000 });
      collectSubtitleEntries(info, entries);
    } else if (source.seriesId) {
      const info = await httpGetJson<Record<string, unknown>>(`${apiBase}&action=get_series_info&series_id=${encodeURIComponent(String(source.seriesId))}`, { timeoutMs: 20000 });
      // Epizód esetén csak a MOST játszott epizód feliratai kellenek.
      if (source.episodeId !== undefined && source.episodeId !== null) {
        const episodes = (info?.episodes || {}) as Record<string, unknown[]>;
        const wantedEpisodeId = String(source.episodeId).replace(/\.[a-z0-9]+$/i, '');
        Object.values(episodes).forEach((list) => {
          if (!Array.isArray(list)) return;
          list.forEach((episode) => {
            const record = episode as Record<string, unknown>;
            // A különböző Xtream panelek eltérő néven adhatják vissza az epizód streamazonosítóját.
            const episodeIds = [record?.id, record?.episode_id, record?.episodeId, record?.stream_id, record?.streamId];
            if (episodeIds.some((value) =>
              value !== undefined && value !== null &&
              String(value).replace(/\.[a-z0-9]+$/i, '') === wantedEpisodeId
            )) {
              collectSubtitleEntries(record, entries);
            }
          });
        });
        // Csak a lejátszott epizód saját feliratait kínáljuk fel.
        // A sorozat általános info objektumából nem veszünk át más epizódhoz
        // tartozó vagy nem egyértelműen azonosítható feliratot.
      } else {
        collectSubtitleEntries(info, entries);
      }
    }
  } catch (error) {
    appLog('Feliratlista lekérése sikertelen: ' + String(error));
    return [];
  }

  if (entries.length === 0) {
    // Nem hiba: a szolgáltató egyszerűen nem tárol feliratot ehhez a filmhez.
    // A naplóból így később látszik, hogy a CC miért maradt üres.
    appLog(`Feliratkeresés (CC): a szolgáltató nem sorolt fel feliratot (${source.vodId ? `vod=${source.vodId}` : `sorozat=${source.seriesId}`}).`);
    return [];
  }
  appLog(`Feliratkeresés (CC): ${entries.length} bejegyzés a szolgáltató válaszában; azonosító=${source.vodId ? `vod=${source.vodId}` : `sorozat=${source.seriesId}`}.`);
  entries.slice(0, MAX_SUBTITLES).forEach((entry, index) => {
    const id = pickString(entry, ['sub_id', 'subId', 'id', 'subtitle_id']) || 'nincs ID';
    const name = pickString(entry, ['title', 'name', 'sub_name', 'language', 'lang']) || `Felirat ${index + 1}`;
    const lang = pickString(entry, ['language', 'lang', 'code', 'language_code']) || 'ismeretlen';
    appLog(`CC szolgáltatói lista #${index + 1}: név=${name.slice(0, 55)}; nyelv=${lang.slice(0, 16)}; ID=${id.slice(0, 35)}.`);
  });

  const subtitleResourceId = source.vodId ?? source.episodeId;
  const resourceId = subtitleResourceId !== undefined && subtitleResourceId !== null && String(subtitleResourceId)
    ? String(subtitleResourceId)
    : '';
  const credentialPath = `${encodeURIComponent(source.username)}/${encodeURIComponent(source.password)}`;
  const subtitleBases = [
    `${base}/subtitle/${credentialPath}`,
    ...(resourceId ? [`${base}/subtitle/${credentialPath}/${encodeURIComponent(resourceId)}`] : []),
    `${base}/subtitles/${credentialPath}`,
  ];

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  entries.slice(0, MAX_SUBTITLES).forEach((entry, index) => {
    const subId = pickString(entry, ['sub_id', 'subId', 'id', 'subtitle_id', 'subid', 'file_id']);
    const name = pickString(entry, ['title', 'name', 'sub_name', 'label', 'display_name', 'language_name', 'language', 'lang']) || `Felirat ${index + 1}`;
    const lang = pickString(entry, ['language', 'lang', 'code', 'language_code', 'lang_code', 'iso', 'locale']);
    const direct = pickString(entry, ['url', 'src', 'file', 'path', 'sub_url', 'subtitle_url', 'download_url', 'file_url', 'download', 'link', 'href']);
    const key = `${subId}|${direct}|${name}|${lang}`;
    if (seen.has(key)) return;
    seen.add(key);
    // Azonosító és közvetlen cím nélkül is listázzuk, ha a nyelv ismert: a
    // fájl ilyenkor a film/epizód azonosítójából próbálható ki választáskor.
    if (!subId && !direct && !(lang && resourceId)) return;
    const urls: string[] = [];
    if (direct) {
      urls.push(/^https?:\/\//i.test(direct) ? direct : `${base}${direct.startsWith('/') ? '' : '/'}${direct}`);
    }
    if (subId) {
      subtitleBases.forEach((prefix) => {
        urls.push(`${prefix}/${encodeURIComponent(subId)}.srt`);
        urls.push(`${prefix}/${encodeURIComponent(subId)}.vtt`);
      });
      urls.push(`${subtitleBases[0]}/${encodeURIComponent(subId)}`);
    } else if (lang && resourceId) {
      const langPart = encodeURIComponent(lang.split(/[-_ ]/)[0].toLowerCase());
      const resourcePart = encodeURIComponent(resourceId);
      urls.push(`${subtitleBases[0]}/${resourcePart}_${langPart}.srt`);
      urls.push(`${subtitleBases[0]}/${resourcePart}.${langPart}.srt`);
      urls.push(`${subtitleBases[0]}/${resourcePart}.srt`);
      urls.push(`${subtitleBases[0]}/${resourcePart}_${langPart}.vtt`);
      urls.push(`${subtitleBases[0]}/${resourcePart}.vtt`);
    }
    const uniqueUrls = Array.from(new Set(urls)).slice(0, 8);
    if (uniqueUrls.length === 0) return;
    // A sorszám az egyező szolgáltatói azonosítók ütközését is kizárja.
    candidates.push({ id: `${subId || direct || lang || 'felirat'}#${index}`, name, lang, urls: uniqueUrls });
  });

  /*
   * Előzetes ellenőrzés kis csoportokban. FONTOS VÁLTOZÁS: amelyik jelölt
   * fájlja most nem töltődött le (más URL-minta, átmeneti hiba), AZ IS
   * bekerül a CC listába – a címeket választáskor próbáljuk végig újra.
   * Eddig az ilyen sáv csendben eltűnt, ezért maradt üres a feliratválasztó
   * akkor is, amikor a szolgáltató felsorolta a feliratokat.
   */
  const workingUrlByIndex = new Map<number, string>();
  const probeCandidate = async (candidate: Candidate): Promise<string | null> => {
    for (const url of candidate.urls) {
      try {
        const text = await httpGetText(url, { timeoutMs: PROBE_TIMEOUT_MS, bypassQueue: true });
        if (looksLikeSubtitle(text)) {
          appLog(`CC fájlteszt SIKERES: ${candidate.name.slice(0, 55)} [${candidate.lang || 'nyelv ?'}]; azonosító=${String(candidate.id).slice(0, 35)}; formátum=${/\.vtt(?:$|[?#])/i.test(url) ? 'VTT' : /\.srt(?:$|[?#])/i.test(url) ? 'SRT' : 'egyéb'}.`);
          return url;
        }
      } catch {
        // 404/403: a következő mintát próbáljuk – ez normális, nem hiba.
      }
    }
    appLog(`CC fájlteszt SIKERTELEN: ${candidate.name.slice(0, 55)} [${candidate.lang || 'nyelv ?'}]; azonosító=${String(candidate.id).slice(0, 35)}; próbált URL-ek=${candidate.urls.length}.`);
    return null;
  };
  for (let start = 0; start < candidates.length; start += 4) {
    const batch = candidates.slice(start, start + 4);
    const found = await Promise.all(batch.map((candidate) => probeCandidate(candidate)));
    found.forEach((url, offset) => {
      if (url) workingUrlByIndex.set(start + offset, url);
    });
  }

  /*
   * A szolgáltatói felirat azonosítója `cc:` előtagot kap: a muxolt és a
   * natív sávok azonosítói is számok, így azonos értéknél a felirat
   * kiszorította volna a szolgáltatói tételt a listából.
   */
  const tracks: SubtitleTrack[] = candidates.map((candidate, index) => {
    const working = workingUrlByIndex.get(index);
    const orderedUrls = working
      ? [working, ...candidate.urls.filter((url) => url !== working)]
      : candidate.urls;
    return {
      id: `cc:${candidate.id}`,
      name: candidate.name,
      lang: candidate.lang,
      url: orderedUrls[0],
      urls: orderedUrls,
    };
  });
  if (workingUrlByIndex.size > 0) {
    appLog(`Szolgáltatói feliratok: ${tracks.length} elérhető (${tracks.map((track) => track.lang || track.name).join(', ')}).`);
  } else if (tracks.length > 0) {
    appLog(`Szolgáltatói felirat nem tölthető le az előzetes próbával (${candidates.length} jelölt, egyik fájl sem felirat); a CC lista a szolgáltató felsorolása alapján mégis megjelenik (${tracks.length} sáv), a letöltést választáskor újra próbáljuk.`);
  } else {
    appLog(`Szolgáltatói felirat nem tölthető le (${candidates.length} jelölt, egyik fájl sem felirat).`);
  }
  return tracks;
}

function parseTimestamp(value: string): number {
  const time = value.trim().replace(',', '.');
  const parts = time.split(':');
  if (parts.length === 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  return Number(time) || 0;
}

/** Egyszerű ASS/SSA szöveg beolvasása (Dialogue sorok, formázójelek nélkül). */
function parseAssText(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let fields: string[] = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  let inEvents = false;
  text.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (/^\[events\]/i.test(trimmed)) {
      inEvents = true;
      return;
    }
    if (/^\[/.test(trimmed)) {
      inEvents = false;
      return;
    }
    if (!inEvents) return;
    if (/^format:/i.test(trimmed)) {
      fields = trimmed.slice(trimmed.indexOf(':') + 1).split(',').map((field) => field.trim().toLowerCase());
      return;
    }
    if (!/^dialogue:/i.test(trimmed)) return;
    let rest = trimmed.slice(trimmed.indexOf(':') + 1).trimStart();
    const values: string[] = [];
    for (let i = 0; i < fields.length - 1; i += 1) {
      const comma = rest.indexOf(',');
      if (comma < 0) return;
      values.push(rest.slice(0, comma).trim());
      rest = rest.slice(comma + 1);
    }
    values.push(rest);
    const startIndex = fields.indexOf('start');
    const endIndex = fields.indexOf('end');
    const textIndex = fields.indexOf('text');
    if (startIndex < 0 || endIndex < 0 || textIndex < 0) return;
    const start = parseTimestamp(values[startIndex] || '0');
    const end = parseTimestamp(values[endIndex] || '0');
    const body = (values[textIndex] || '')
      .replace(/\\N/g, '\n')
      .replace(/\\h/g, ' ')
      .replace(/\{\\[^}]+\}/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!body || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    cues.push({ start, end, text: body });
  });
  return cues.sort((a, b) => a.start - b.start);
}

/** SRT / WebVTT / egyszerű ASS szöveg beolvasása időzített sorokká. */
export function parseSubtitleText(raw: string): SubtitleCue[] {
  if (!raw) return [];
  const text = raw.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  if (/\[Script Info\]/i.test(text) && /Dialogue:/i.test(text)) return parseAssText(text);
  const cues: SubtitleCue[] = [];
  const blocks = text.split(/\n{2,}/);
  blocks.forEach((block) => {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) return;
    const timeLineIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeLineIndex < 0) return;
    const [startRaw, endRaw] = lines[timeLineIndex].split('-->');
    const start = parseTimestamp((startRaw || '').split(/\s+/)[0] || '0');
    const end = parseTimestamp(((endRaw || '').trim().split(/\s+/)[0]) || '0');
    const body = lines.slice(timeLineIndex + 1).join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]+\}/g, '')
      .trim();
    if (!body || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    cues.push({ start, end, text: body });
  });
  return cues.sort((a, b) => a.start - b.start);
}

/** A kiválasztott felirat letöltése és beolvasása (több cím esetén sorban próbálja őket). */
export async function loadSubtitleCues(target: string | string[]): Promise<SubtitleCue[]> {
  const urls = (Array.isArray(target) ? target : [target]).filter(Boolean);
  if (urls.length === 0) return [];
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const text = await httpGetText(url, { timeoutMs: 15000, bypassQueue: true });
      const cues = parseSubtitleText(text);
      if (cues.length > 0) {
        appLog(`Felirat betöltve: ${cues.length} sor (${safeSubtitleUrl(url)}).`);
        return cues;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) appLog('Felirat letöltése sikertelen: ' + String(lastError));
  return [];
}

/** Az aktuális időponthoz tartozó feliratszöveg (bináris kereséssel). */
export function cueAt(cues: SubtitleCue[], time: number): string {
  if (!cues.length) return '';
  let low = 0;
  let high = cues.length - 1;
  let found = '';
  while (low <= high) {
    const middle = (low + high) >> 1;
    const cue = cues[middle];
    if (time < cue.start) {
      high = middle - 1;
    } else if (time > cue.end) {
      low = middle + 1;
    } else {
      found = cue.text;
      break;
    }
  }
  return found;
}
