import { SubtitleTrack } from '../types/iptv';
import { httpGetJson, httpGetText } from './net';
import { appLog } from './appLog';

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
 *   2. felépítjük a lehetséges URL-eket, és a valóban letölthetőt tartjuk meg,
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
const MAX_SUBTITLES = 8;

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
  const base = String(serverUrl || '')
    .trim()
    .replace(/\/player_api\.php.*$/i, '')
    .replace(/\/+$/, '');
  return /^https?:\/\//i.test(base) ? base : `http://${base}`;
}

/** A válaszban található feliratlisták összegyűjtése (több lehetséges alak). */
function collectSubtitleEntries(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectSubtitleEntries(item, out, depth + 1));
    return;
  }
  if (typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const keyName = key.toLowerCase();
    if (keyName === 'subtitles' || keyName === 'sub_titles' || keyName === 'subs' || keyName === 'subtitle') {
      const parsed = typeof value === 'string' ? safeJson(value) : value;
      if (Array.isArray(parsed)) {
        parsed.forEach((entry) => {
          if (entry && typeof entry === 'object') out.push(entry as Record<string, unknown>);
        });
      } else if (parsed && typeof parsed === 'object') {
        const entries = (parsed as Record<string, unknown>).subtitles;
        if (Array.isArray(entries)) {
          entries.forEach((entry) => {
            if (entry && typeof entry === 'object') out.push(entry as Record<string, unknown>);
          });
        }
      }
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
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/** A megadott URL tartalma felirat-e (SRT / WebVTT). */
function looksLikeSubtitle(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 4000);
  return /^\uFEFF?WEBVTT/i.test(head.trimStart()) || /-->/.test(head);
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
 * Minden jelöltnél több URL-mintát is kipróbálunk, és csak azt tartjuk meg,
 * amelyik valóban feliratot ad vissza. Ha a szolgáltató nem tárol feliratot,
 * üres listával tér vissza – a muxolt feliratok ettől függetlenül működnek.
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
        let matchedEpisode = false;
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
              matchedEpisode = true;
              collectSubtitleEntries(record, entries);
            }
          });
        });
        // Egyes panelek a feliratokat a sorozat info objektumában adják meg,
        // nem az epizódrekordban. Csak ezt az objektumot vizsgáljuk, nem a teljes
        // episodes tömböt, nehogy egy másik epizód feliratát kínáljuk fel.
        if (!matchedEpisode || entries.length === 0) {
          const seriesInfo = (info?.info || {}) as Record<string, unknown>;
          collectSubtitleEntries(seriesInfo, entries);
        }
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

  const urlPrefixes = [
    `${base}/subtitle/${encodeURIComponent(source.username)}/${encodeURIComponent(source.password)}`,
    `${base}/subtitle/${encodeURIComponent(source.username)}/${encodeURIComponent(source.password)}/${encodeURIComponent(String(source.vodId ?? ''))}`,
  ];

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  entries.slice(0, MAX_SUBTITLES).forEach((entry, index) => {
    const subId = pickString(entry, ['sub_id', 'subId', 'id', 'subtitle_id']);
    const name = pickString(entry, ['title', 'name', 'sub_name', 'language', 'lang']) || `Felirat ${index + 1}`;
    const lang = pickString(entry, ['language', 'lang', 'code', 'language_code']);
    const direct = pickString(entry, ['url', 'src', 'file', 'path', 'sub_url']);
    const key = `${subId}|${direct}|${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!subId && !direct) return;
    const urls: string[] = [];
    if (direct) {
      urls.push(/^https?:\/\//i.test(direct) ? direct : `${base}${direct.startsWith('/') ? '' : '/'}${direct}`);
    }
    if (subId) {
      urlPrefixes.forEach((prefix) => {
        urls.push(`${prefix}/${encodeURIComponent(subId)}.srt`);
        urls.push(`${prefix}/${encodeURIComponent(subId)}.vtt`);
      });
    }
    candidates.push({ id: subId || name, name, lang, urls });
  });

  // Párhuzamos ellenőrzés – csak a valóban letölthető feliratok maradnak.
  const resolved = await Promise.all(candidates.map(async (candidate) => {
    for (const url of candidate.urls) {
      try {
        const text = await httpGetText(url, { timeoutMs: PROBE_TIMEOUT_MS, bypassQueue: true });
        if (looksLikeSubtitle(text)) {
          /*
           * A szolgáltatói felirat azonosítója `cc:` előtagot kap: a muxolt és
           * a natív sávok azonosítói is számok, így azonos értéknél a felirat
           * kiszorította volna a szolgáltatói tételt a listából.
           */
          appLog(`CC fájlteszt SIKERES: ${candidate.name.slice(0, 55)} [${candidate.lang || 'nyelv ?'}]; azonosító=${String(candidate.id).slice(0, 35)}; formátum=${/\\.vtt(?:$|[?#])/i.test(url) ? 'VTT' : /\\.srt(?:$|[?#])/i.test(url) ? 'SRT' : 'egyéb'}.`);
          return { id: `cc:${candidate.id}`, name: candidate.name, lang: candidate.lang, url };
        }
      } catch {
        // 404/403: a következő mintát próbáljuk – ez normális, nem hiba.
      }
    }
    appLog(`CC fájlteszt SIKERTELEN: ${candidate.name.slice(0, 55)} [${candidate.lang || 'nyelv ?'}]; azonosító=${String(candidate.id).slice(0, 35)}; próbált URL-ek=${candidate.urls.length}.`);
    return null;
  }));

  const tracks = resolved.filter(Boolean) as SubtitleTrack[];
  if (tracks.length > 0) {
    appLog(`Szolgáltatói feliratok: ${tracks.length} elérhető (${tracks.map((track) => track.lang || track.name).join(', ')}).`);
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

/** SRT / WebVTT szöveg beolvasása időzített sorokká. */
export function parseSubtitleText(raw: string): SubtitleCue[] {
  if (!raw) return [];
  const text = raw.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
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

/** A kiválasztott felirat letöltése és beolvasása. */
export async function loadSubtitleCues(url: string): Promise<SubtitleCue[]> {
  if (!url) return [];
  try {
    const text = await httpGetText(url, { timeoutMs: 15000 });
    const cues = parseSubtitleText(text);
    appLog(`Felirat betöltve: ${cues.length} sor (${safeSubtitleUrl(url)}).`);
    return cues;
  } catch (error) {
    appLog('Felirat letöltése sikertelen: ' + String(error));
    return [];
  }
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
