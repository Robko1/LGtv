import { appLog } from './appLog';
import {
  EmbeddedSubtitle,
  selectEmbeddedSubtitle,
  disableEmbeddedSubtitle,
  subscribeSourceInfoSubtitles,
} from './embeddedSubtitleService';

/**
 * ÉLŐ TV FELIRAT (CC) – a VOD (film/sorozat) felirattól KÜLÖN szolgáltatás.
 *
 * Az élő adások felirata (DVB/teletext felirat az MPEG-TS-ben, vagy HLS
 * felirat-sáv) ugyanúgy nem látszik a webOS HTML5 `textTracks` listájában,
 * mint a filmek beágyazott felirata – ezért eddig az élő CC lista is üres
 * volt, és az OSD CC ikonja nem váltott zöldre.
 *
 * A lista két, egymást kiegészítő úton derül ki:
 *   1. A TV médiaszolgáltatásának `sourceInfo` jelzése (ez a legpontosabb:
 *      maga a TV sorolja fel a sávokat, olyan sorrendben, ahogy választja).
 *   2. Tartalék: az élő stream elejéből kiolvassuk az MPEG-TS PMT táblát
 *      (DVB felirat- és teletext-leírók nyelvkódokkal), HLS címnél pedig a
 *      lejátszási lista SUBTITLES bejegyzéseit (szükség esetén az első
 *      TS szegmens PMT-jét).
 *
 * A kiválasztást a TV médiaszolgáltatása végzi (ugyanaz a Luna hívás, mint a
 * filmeknél, de az élő és a VOD állapot/kezelés teljesen külön marad).
 *
 * A naplóba URL (jelszóval) sosem kerül – csak darabszám, nyelv, forrás.
 */

export type LiveSubtitleTrack = EmbeddedSubtitle;

/** Nyelvkód (ISO 639-1/2) megjeleníthető magyar elnevezése az élő CC-listához. */
const LIVE_LANG_NAMES: Record<string, string> = {
  hu: 'Magyar', hun: 'Magyar', ma: 'Magyar', may: 'Magyar', mag: 'Magyar',
  en: 'Angol', eng: 'Angol', de: 'Német', deu: 'Német', ger: 'Német',
  fr: 'Francia', fra: 'Francia', fre: 'Francia', es: 'Spanyol', spa: 'Spanyol',
  it: 'Olasz', ita: 'Olasz', ro: 'Román', ron: 'Román', rum: 'Román',
  sk: 'Szlovák', slk: 'Szlovák', slo: 'Szlovák', cs: 'Cseh', ces: 'Cseh', cze: 'Cseh',
  hr: 'Horvát', hrv: 'Horvát', sr: 'Szerb', srp: 'Szerb', sl: 'Szlovén', slv: 'Szlovén',
  uk: 'Ukrán', ukr: 'Ukrán', ru: 'Orosz', rus: 'Orosz', pl: 'Lengyel', pol: 'Lengyel',
  bg: 'Bolgár', bul: 'Bolgár', tr: 'Török', tur: 'Török', el: 'Görög', ell: 'Görög',
  nl: 'Holland', nld: 'Holland', dut: 'Holland', pt: 'Portugál', por: 'Portugál',
};

function liveSubtitleName(lang: string, codec: string): string {
  const base = LIVE_LANG_NAMES[String(lang || '').toLowerCase()] || '';
  const kind = codec ? ` (${codec})` : '';
  return base ? `${base}${kind}` : '';
}

/** Élő feliratsáv bekapcsolása a TV médiaszolgáltatásával (Luna). */
export function selectLiveSubtitle(
  video: HTMLVideoElement | null,
  lunaIndex: number,
  scalePercent = 100,
): Promise<boolean> {
  return selectEmbeddedSubtitle(video, lunaIndex, scalePercent);
}

/** A TV által kirajzolt élő felirat kikapcsolása. */
export function disableLiveSubtitle(video: HTMLVideoElement | null): Promise<void> {
  return disableEmbeddedSubtitle(video);
}

/**
 * A TV saját sávlistája (sourceInfo) – amint megérkezik, a hívó megkapja.
 * A visszatérő függvény leiratkozik. Nincs külön hálózati kapcsolat.
 */
export function subscribeLiveSubtitleTracks(
  video: HTMLVideoElement | null,
  onTracks: (tracks: LiveSubtitleTrack[]) => void,
): () => void {
  return subscribeSourceInfoSubtitles(video, onTracks);
}

/* ───────────────────────── MPEG-TS PMT olvasása ───────────────────────── */

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  let text = '';
  for (let i = 0; i < length && start + i < bytes.length; i += 1) {
    const code = bytes[start + i];
    if (code >= 0x20 && code <= 0x7e) text += String.fromCharCode(code);
  }
  return text.trim().toLowerCase();
}

/** TS csomagméret felismerése (188/192/204) a 0x47 szinkronbájt ismétlődéséből. */
function detectTsPacketSize(bytes: Uint8Array): number | null {
  for (const size of [188, 192, 204]) {
    const offset = size === 192 ? 4 : 0; // M2TS: 4 bájtos időbélyeg minden csomag előtt
    if (bytes.length >= offset + size * 2 + 1
      && bytes[offset] === 0x47 && bytes[offset + size] === 0x47 && bytes[offset + size * 2] === 0x47) {
      return size;
    }
  }
  return null;
}

interface SectionBuffer {
  data: number[];
  wanted: number;
}

/**
 * Az MPEG-TS részletből a PMT felirat-leíróinak (DVB 0x59, teletext 0x56)
 * kiolvasása. `null` = a PAT/PMT még nem érkezett meg ennyi adatból;
 * üres tömb = a PMT megvan, de nincs feliratsáv a műsorban.
 */
export function parseTsSubtitleTracks(bytes: Uint8Array): LiveSubtitleTrack[] | null {
  const packetSize = detectTsPacketSize(bytes);
  if (!packetSize) return null;
  const headerOffset = packetSize === 192 ? 4 : 0;

  let pmtPid: number | null = null;
  const sections = new Map<number, SectionBuffer>();
  const tracks: LiveSubtitleTrack[] = [];
  const seen = new Set<string>();
  let pmtParsed = false;

  const pushTrack = (pid: number, lang: string, codec: string) => {
    const key = `${pid}|${lang}|${codec}`;
    if (seen.has(key)) return;
    seen.add(key);
    tracks.push({
      lunaIndex: tracks.length,
      lang,
      name: liveSubtitleName(lang, codec),
      codec,
      forced: false,
      isDefault: tracks.length === 0,
    });
  };

  const parsePat = (section: Uint8Array) => {
    // table_id(1) + hossz(2) + ts_id(2) + verzió(1) + section(1) + last(1) = 8 bájt fejléc; CRC 4 bájt a végén.
    for (let pos = 8; pos + 4 <= section.length - 4; pos += 4) {
      const programNumber = (section[pos] << 8) | section[pos + 1];
      const pid = ((section[pos + 2] & 0x1f) << 8) | section[pos + 3];
      if (programNumber !== 0) {
        pmtPid = pid;
        return;
      }
    }
  };

  const parsePmt = (section: Uint8Array) => {
    if (section.length < 12) return;
    const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
    let pos = 12 + programInfoLength;
    const end = section.length - 4; // CRC
    while (pos + 5 <= end) {
      const elementaryPid = ((section[pos + 1] & 0x1f) << 8) | section[pos + 2];
      const esInfoLength = ((section[pos + 3] & 0x0f) << 8) | section[pos + 4];
      const descStart = pos + 5;
      const descEnd = Math.min(end, descStart + esInfoLength);
      let d = descStart;
      while (d + 2 <= descEnd) {
        const tag = section[d];
        const len = section[d + 1];
        const body = d + 2;
        if (body + len > descEnd) break;
        if (tag === 0x59) {
          // DVB subtitling descriptor: 8 bájtos bejegyzések (nyelv + típus + oldalak).
          for (let e = 0; e + 8 <= len; e += 8) {
            pushTrack(elementaryPid, readAscii(section, body + e, 3), 'DVB');
          }
        } else if (tag === 0x56) {
          // Teletext descriptor: 5 bájtos bejegyzések; típus 0x02 = feliratoldal, 0x05 = hallássérült felirat.
          for (let e = 0; e + 5 <= len; e += 5) {
            const teletextType = (section[body + e + 3] >> 3) & 0x1f;
            if (teletextType === 0x02 || teletextType === 0x05) {
              pushTrack(elementaryPid, readAscii(section, body + e, 3), 'TELETEXT');
            }
          }
        }
        d = body + len;
      }
      pos = descStart + esInfoLength;
    }
    pmtParsed = true;
  };

  const feedPacket = (pid: number, payload: Uint8Array, payloadUnitStart: boolean) => {
    if (pid !== 0 && pid !== pmtPid) return;
    let state = sections.get(pid);
    let offset = 0;
    if (payloadUnitStart) {
      const pointer = payload[0] || 0;
      // A pointer mögötti rész az előző (nekünk már nem kellő) szakasz vége.
      offset = 1 + pointer;
      state = { data: [], wanted: 0 };
      sections.set(pid, state);
    }
    if (!state) return;
    for (let i = offset; i < payload.length; i += 1) state.data.push(payload[i]);
    if (state.data.length >= 3 && state.wanted === 0) {
      state.wanted = 3 + (((state.data[1] & 0x0f) << 8) | state.data[2]);
    }
    if (state.wanted > 0 && state.data.length >= state.wanted) {
      const section = new Uint8Array(state.data.slice(0, state.wanted));
      sections.delete(pid);
      if (pid === 0 && section[0] === 0x00) parsePat(section);
      else if (pid === pmtPid && section[0] === 0x02) parsePmt(section);
    }
  };

  for (let base = 0; base + packetSize <= bytes.length && !pmtParsed; base += packetSize) {
    const start = base + headerOffset;
    if (bytes[start] !== 0x47) continue;
    const payloadUnitStart = (bytes[start + 1] & 0x40) !== 0;
    const pid = ((bytes[start + 1] & 0x1f) << 8) | bytes[start + 2];
    const adaptationControl = (bytes[start + 3] >> 4) & 0x03;
    if (adaptationControl === 0 || adaptationControl === 2) continue; // nincs payload
    let payloadStart = start + 4;
    if (adaptationControl === 3) payloadStart += 1 + (bytes[start + 4] || 0);
    const payloadEnd = base + packetSize;
    if (payloadStart >= payloadEnd) continue;
    feedPacket(pid, bytes.subarray(payloadStart, payloadEnd), payloadUnitStart);
  }

  return pmtParsed ? tracks : null;
}

/* ───────────────────────── HLS lejátszási lista olvasása ───────────────────────── */

function parseHlsAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    attrs[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

/**
 * A HLS master playlist SUBTITLES bejegyzései. `null` = nem HLS szöveg;
 * üres tömb = HLS, de nincs felirat-sáv felsorolva.
 */
export function parseHlsSubtitleTracks(text: string): LiveSubtitleTrack[] | null {
  const source = String(text || '');
  if (!source.trimStart().startsWith('#EXTM3U')) return null;
  const tracks: LiveSubtitleTrack[] = [];
  source.split(/\r?\n/).forEach((line) => {
    if (!line.startsWith('#EXT-X-MEDIA:')) return;
    const attrs = parseHlsAttributes(line);
    if ((attrs.TYPE || '').toUpperCase() !== 'SUBTITLES') return;
    tracks.push({
      lunaIndex: tracks.length,
      lang: String(attrs.LANGUAGE || '').toLowerCase(),
      name: String(attrs.NAME || ''),
      codec: 'HLS',
      forced: (attrs.FORCED || '').toUpperCase() === 'YES',
      isDefault: (attrs.DEFAULT || '').toUpperCase() === 'YES',
    });
  });
  return tracks;
}

/** Az első TS szegmens címe egy media playlistből (a PMT tartalék-próbához). */
function firstTsSegmentUrl(playlistText: string, playlistUrl: string): string {
  const lines = String(playlistText || '').split(/\r?\n/).map((line) => line.trim());
  const segment = lines.find((line) => line && !line.startsWith('#') && /\.ts([?#]|$)/i.test(line));
  if (!segment) return '';
  try {
    return new URL(segment, playlistUrl).toString();
  } catch {
    return '';
  }
}

/* ───────────────────────── Az élő stream elejének letöltése ───────────────────────── */

const PROBE_MAX_BYTES = 524288;
const PROBE_THRESHOLDS = [65536, 196608, PROBE_MAX_BYTES];
const probeCache = new Map<string, LiveSubtitleTrack[]>();

type ProbeOutcome =
  | { kind: 'tracks'; tracks: LiveSubtitleTrack[]; source: 'PMT' | 'HLS' }
  | { kind: 'segment'; url: string }
  | { kind: 'none' };

function fetchLiveHead(url: string): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let thresholdIndex = 0;
    const xhr = new XMLHttpRequest();

    const finish = (value: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      try { xhr.abort(); } catch { /* már lezárult */ }
      resolve(value);
    };

    const tryParse = (text: string, finalAttempt: boolean): boolean => {
      if (!text) return false;
      if (text.trimStart().startsWith('#EXTM3U') || (text.length < 16 && text.startsWith('#'))) {
        // HLS: a SUBTITLES sorok a lista elején vannak; pár száz bájt elég.
        if (text.length < 256 && !finalAttempt) return false;
        const hls = parseHlsSubtitleTracks(text);
        if (hls && hls.length > 0) {
          finish({ kind: 'tracks', tracks: hls, source: 'HLS' });
          return true;
        }
        const segmentUrl = firstTsSegmentUrl(text, url);
        if (segmentUrl) {
          finish({ kind: 'segment', url: segmentUrl });
          return true;
        }
        if (finalAttempt) finish({ kind: 'tracks', tracks: [], source: 'HLS' });
        return finalAttempt;
      }
      const length = Math.min(text.length, PROBE_MAX_BYTES);
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
      const parsed = parseTsSubtitleTracks(bytes);
      if (parsed) {
        finish({ kind: 'tracks', tracks: parsed, source: 'PMT' });
        return true;
      }
      if (finalAttempt) finish({ kind: 'none' });
      return false;
    };

    try {
      xhr.open('GET', url, true);
      xhr.overrideMimeType('text/plain; charset=x-user-defined');
      xhr.timeout = 12000;
      xhr.onprogress = () => {
        if (settled) return;
        const text = xhr.responseText || '';
        // HLS lista már az első darabból is eldőlhet.
        if (text.trimStart().startsWith('#EXTM3U') && tryParse(text, false)) return;
        while (thresholdIndex < PROBE_THRESHOLDS.length && text.length >= PROBE_THRESHOLDS[thresholdIndex]) {
          thresholdIndex += 1;
          if (tryParse(text, thresholdIndex >= PROBE_THRESHOLDS.length)) return;
        }
      };
      xhr.onload = () => {
        if (settled) return;
        if (xhr.status !== 200 && xhr.status !== 206 && xhr.status !== 0) {
          finish({ kind: 'none' });
          return;
        }
        tryParse(xhr.responseText || '', true);
        finish({ kind: 'none' });
      };
      xhr.onerror = () => finish({ kind: 'none' });
      xhr.ontimeout = () => finish({ kind: 'none' });
      xhr.send();
    } catch {
      resolve({ kind: 'none' });
    }
  });
}

/**
 * Az élő csatorna feliratsávjainak felderítése a stream fejlécéből
 * (MPEG-TS PMT / HLS lista). Csak a stream elejét olvassa, a PMT
 * megérkezésekor azonnal bont; csatornánként gyorsítótárazott.
 * Hiba esetén üres lista – a TV saját (sourceInfo) útja ettől független.
 */
export async function probeLiveSubtitles(streamUrl: string): Promise<LiveSubtitleTrack[]> {
  const url = String(streamUrl || '');
  if (!url) return [];
  const cached = probeCache.get(url);
  if (cached) return cached;

  let outcome = await fetchLiveHead(url);
  if (outcome.kind === 'segment') {
    // HLS media playlist: az első TS szegmens PMT-je sorolja fel a feliratokat.
    outcome = await fetchLiveHead(outcome.url);
  }
  if (outcome.kind !== 'tracks') {
    appLog('Élő felirat (CC): a stream fejlécéből (PMT/HLS) nem olvasható feliratlista.');
    return [];
  }
  if (probeCache.size > 100) probeCache.clear();
  probeCache.set(url, outcome.tracks);
  if (outcome.tracks.length > 0) {
    appLog(
      `Élő feliratok (CC): ${outcome.tracks.length} sáv a streamben ` +
      `(${outcome.tracks.map((track) => track.lang || '?').join(', ')}) [${outcome.source}].`
    );
  } else {
    appLog(`Élő felirat (CC): a stream fejlécében nincs feliratsáv [${outcome.source}].`);
  }
  return outcome.tracks;
}
