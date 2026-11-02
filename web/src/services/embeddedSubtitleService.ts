import { appLog } from './appLog';

/**
 * FILM / SOROZAT – A FÁJLBA MUXOLT (BEÁGYAZOTT) FELIRATOK (CC).
 *
 * MIÉRT KELL EZ: a szolgáltatók filmjeinél a felirat szinte mindig MAGÁBAN A
 * FÁJLBAN van (MKV konténerben, sok nyelven), nem külön letölthető fájlként.
 * Az LG webOS HTML5 lejátszója ezeket a beágyazott sávokat NEM teszi közzé
 * (`video.textTracks` üres marad; az LG hivatalosan csak külső .vtt
 * feliratot támogat HTML5-ben), ezért a CC lista eddig üres volt.
 *
 * A működő út (más webOS lejátszók is így csinálják):
 *   1. A lista: a film elejéből kiolvassuk a Matroska (MKV/WebM) fejléc
 *      `Tracks` elemét – onnan pontosan tudjuk, milyen nyelvű feliratsávok
 *      vannak a fájlban, anélkül hogy a TV-nek közzé kellene tennie őket.
 *   2. A kiválasztás: a TV saját médiaszolgáltatásán (`luna://com.webos.media`)
 *      keresztül kapcsoljuk be a feliratot és választjuk ki a sávot
 *      (`setSubtitleEnable` + `selectTrack` type:'text'). A feliratot
 *      ilyenkor maga a TV rajzolja a képre.
 *
 * Ha ez a TV-n nem elérhető, tartalékként a médiaszolgáltatás eseményeiből
 * (`subscribe` → `sourceInfo`) próbáljuk kiolvasni a sávlistát.
 *
 * Fontos: a stream URL a belépési adatokat is tartalmazza, ezért a naplóba
 * SOHA nem írunk URL-t – csak darabszámot, nyelvet és eredményt.
 */

export interface EmbeddedSubtitle {
  /** A Luna `selectTrack` híváshoz tartozó sorszám (csak a szöveges sávok számlálódnak). */
  lunaIndex: number;
  lang: string;
  name: string;
  codec: string;
  forced: boolean;
  isDefault: boolean;
}

/** A Matroska fejlécben deklarált képsáv adatai (képminőség-naplóhoz). */
export interface MatroskaVideoInfo {
  /** Emberi kodeknév, pl. 'H.265/HEVC'. */
  codec: string;
  /** A nyers Matroska CodecID, pl. 'V_MPEGH/ISO/HEVC'. */
  codecId: string;
  width: number;
  height: number;
  /** 'PQ (HDR10)' / 'HLG' / 'BT.2020 szín' / '' (nincs színmetaadat a fejlécben). */
  hdr: string;
}

export interface MatroskaProbeResult {
  subtitles: EmbeddedSubtitle[];
  /** Képalapú (PGS/VobSub) sávok száma – ezeket az LG feliratkezelője nem rajzolja ki. */
  skippedBitmap: number;
  totalSubtitleTracks: number;
  /** A fejlécben deklarált képsáv (az első), ha kiolvasható. */
  video: MatroskaVideoInfo | null;
  /** A hangsávok kodekjeinek emberi nevei. */
  audioCodecs: string[];
  /** A teljes fájlméret bájtban, ha a válaszfejlécből kiderült (átlagbitrátához). */
  fileBytes?: number | null;
}

/* ───────────────────────── Matroska (EBML) fejléc olvasása ───────────────────────── */

const EBML_ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  CLUSTER: 0x1f43b675,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  LANGUAGE: 0x22b59c,
  LANGUAGE_IETF: 0x22b59d,
  NAME: 0x536e,
  FLAG_DEFAULT: 0x88,
  FLAG_FORCED: 0x55aa,
  /* Képsáv (Video) és színmetaadat – a képminőség-napló kodek/felbontás/HDR adatai. */
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  COLOUR: 0x55b0,
  COLOUR_TRANSFER: 0x55ba,
  COLOUR_PRIMARIES: 0x55bb,
} as const;

/** Matroska sávtípusok: 1 = kép, 2 = hang, 17 = felirat. */
const MATROSKA_TRACK_TYPE_VIDEO = 1;
const MATROSKA_TRACK_TYPE_AUDIO = 2;
const MATROSKA_TRACK_TYPE_SUBTITLE = 17;

/** A Matroska CodecID emberi neve a naplóhoz. */
export function matroskaCodecLabel(codecId: string): string {
  const id = String(codecId || '').trim().toUpperCase();
  if (!id) return '';
  if (id.indexOf('V_MPEGH') === 0 || id.indexOf('HEVC') >= 0) return 'H.265/HEVC';
  if (id.indexOf('V_MPEG4/ISO/AVC') === 0) return 'H.264/AVC';
  if (id === 'V_AV1') return 'AV1';
  if (id === 'V_VP9') return 'VP9';
  if (id === 'V_VP8') return 'VP8';
  if (id === 'V_MPEG2') return 'MPEG-2 Video';
  if (id === 'V_MPEG1') return 'MPEG-1 Video';
  if (id.indexOf('V_QUICKTIME') === 0) return 'QuickTime Video';
  if (id === 'A_AAC') return 'AAC';
  if (id === 'A_AC3') return 'AC-3';
  if (id === 'A_EAC3') return 'E-AC-3';
  if (id === 'A_DTS') return 'DTS';
  if (id === 'A_TRUEHD') return 'TrueHD';
  if (id === 'A_FLAC') return 'FLAC';
  if (id === 'A_OPUS') return 'Opus';
  if (id === 'A_VORBIS') return 'Vorbis';
  if (id === 'A_MPEG/L3' || id === 'A_MPEG/L2' || id === 'A_MPEG/L1') return 'MPEG Audio';
  if (id.indexOf('A_PCM') === 0) return 'PCM';
  return id;
}

/** A Matroska Colour elem átviteli függvényéből a HDR fajta (16 = PQ, 18 = HLG). */
export function matroskaHdrLabel(transfer: number, primaries: number): string {
  if (transfer === 16) return 'PQ (HDR10)';
  if (transfer === 18) return 'HLG';
  if (primaries === 9) return 'BT.2020 szín (átvitel nincs jelölve)';
  return '';
}

interface Vint {
  value: number;
  len: number;
  unknown: boolean;
}

function readVint(bytes: Uint8Array, pos: number, keepMarker: boolean): Vint | null {
  if (pos < 0 || pos >= bytes.length) return null;
  const first = bytes[pos];
  if (first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && (first & mask) === 0) {
    len += 1;
    mask >>= 1;
  }
  if (len > 8 || pos + len > bytes.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let unknown = !keepMarker && value === mask - 1;
  for (let i = 1; i < len; i += 1) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) unknown = false;
  }
  return { value, len, unknown };
}

function readUint(bytes: Uint8Array, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i += 1) value = value * 256 + bytes[i];
  return value;
}

function readUtf8(bytes: Uint8Array, start: number, end: number): string {
  const slice = bytes.subarray(start, end);
  // A záró nulla bájtokat levágjuk (a Name elem néha nullával zárul).
  let last = slice.length;
  while (last > 0 && slice[last - 1] === 0) last -= 1;
  const clean = last === slice.length ? slice : slice.subarray(0, last);
  try {
    const Decoder = (globalThis as { TextDecoder?: typeof TextDecoder }).TextDecoder;
    if (Decoder) return new Decoder('utf-8', { fatal: false }).decode(clean).trim();
  } catch {
    /* régebbi motor: az alábbi tartalék olvasás fut */
  }
  let raw = '';
  for (let i = 0; i < clean.length; i += 1) raw += String.fromCharCode(clean[i]);
  try {
    return decodeURIComponent(escape(raw)).trim();
  } catch {
    return raw.trim();
  }
}

/**
 * Egy EBML szint elemein lépked végig. A callback false visszatérése megállítja.
 * Ismeretlen méretű elem (pl. Segment) a puffer végéig tart.
 */
function walkElements(
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: (id: number, dataStart: number, dataEnd: number) => boolean,
): void {
  let pos = start;
  while (pos < end) {
    const id = readVint(bytes, pos, true);
    if (!id) return;
    const size = readVint(bytes, pos + id.len, false);
    if (!size) return;
    const dataStart = pos + id.len + size.len;
    const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
    if (dataStart > end) return;
    if (visit(id.value, dataStart, dataEnd) === false) return;
    pos = dataEnd;
  }
}

/** Szöveges feliratkódek-e (az LG beágyazott feliratkezelője csak ezeket rajzolja ki). */
function isTextSubtitleCodec(codec: string): boolean {
  const normalized = String(codec || '').trim().toUpperCase();
  if (!normalized) return true; // hiányzó CodecID: ne veszítsük el a sávot
  return normalized.indexOf('S_TEXT/') === 0
    || normalized === 'S_TEXT'
    || normalized === 'S_SSA'
    || normalized === 'S_ASS'
    || normalized === 'S_USF';
}

/** EBML/Matroska fájlelej-e (0x1A45DFA3). */
export function isEbmlFile(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

/**
 * A Matroska fejléc feliratsávjainak kiolvasása.
 * `null` = ebből a részletből még nem olvasható (nem EBML, vagy a Tracks
 * elem még nem ért ide / csonka a puffer).
 */
export function parseMatroskaTracks(bytes: Uint8Array): MatroskaProbeResult | null {
  if (!isEbmlFile(bytes)) return null;
  let result: MatroskaProbeResult | null = null;

  walkElements(bytes, 0, bytes.length, (topId, segmentStart, segmentEnd) => {
    if (topId !== EBML_ID.SEGMENT) return true;
    walkElements(bytes, segmentStart, segmentEnd, (childId, childStart, childEnd) => {
      if (childId === EBML_ID.CLUSTER) return false; // a fejléc véget ért
      if (childId !== EBML_ID.TRACKS) return true;

      const rawTracks: Array<{ type: number; codec: string; lang: string; langIetf: string; name: string; isDefault: boolean; forced: boolean; width: number; height: number; transfer: number; primaries: number }> = [];
      walkElements(bytes, childStart, childEnd, (entryId, entryStart, entryEnd) => {
        if (entryId !== EBML_ID.TRACK_ENTRY) return true;
        const track = { type: -1, codec: '', lang: '', langIetf: '', name: '', isDefault: true, forced: false, width: 0, height: 0, transfer: 0, primaries: 0 };
        walkElements(bytes, entryStart, entryEnd, (fieldId, fieldStart, fieldEnd) => {
          if (fieldId === EBML_ID.TRACK_TYPE) track.type = readUint(bytes, fieldStart, fieldEnd);
          else if (fieldId === EBML_ID.CODEC_ID) track.codec = readUtf8(bytes, fieldStart, fieldEnd);
          else if (fieldId === EBML_ID.LANGUAGE) track.lang = readUtf8(bytes, fieldStart, fieldEnd);
          else if (fieldId === EBML_ID.LANGUAGE_IETF) track.langIetf = readUtf8(bytes, fieldStart, fieldEnd);
          else if (fieldId === EBML_ID.NAME) track.name = readUtf8(bytes, fieldStart, fieldEnd);
          else if (fieldId === EBML_ID.FLAG_DEFAULT) track.isDefault = readUint(bytes, fieldStart, fieldEnd) === 1;
          else if (fieldId === EBML_ID.FLAG_FORCED) track.forced = readUint(bytes, fieldStart, fieldEnd) === 1;
          else if (fieldId === EBML_ID.VIDEO) {
            // A fejlécben deklarált képméret + színmetaadat (képminőség-napló).
            walkElements(bytes, fieldStart, fieldEnd, (videoId, videoStart, videoEnd) => {
              if (videoId === EBML_ID.PIXEL_WIDTH) track.width = readUint(bytes, videoStart, videoEnd);
              else if (videoId === EBML_ID.PIXEL_HEIGHT) track.height = readUint(bytes, videoStart, videoEnd);
              else if (videoId === EBML_ID.COLOUR) {
                walkElements(bytes, videoStart, videoEnd, (colourId, colourStart, colourEnd) => {
                  if (colourId === EBML_ID.COLOUR_TRANSFER) track.transfer = readUint(bytes, colourStart, colourEnd);
                  else if (colourId === EBML_ID.COLOUR_PRIMARIES) track.primaries = readUint(bytes, colourStart, colourEnd);
                  return true;
                });
              }
              return true;
            });
          }
          return true;
        });
        rawTracks.push(track);
        return true;
      });

      const subtitleTracks = rawTracks.filter((track) => track.type === MATROSKA_TRACK_TYPE_SUBTITLE);
      const subtitles: EmbeddedSubtitle[] = [];
      let skippedBitmap = 0;
      subtitleTracks.forEach((track) => {
        if (!isTextSubtitleCodec(track.codec)) {
          skippedBitmap += 1;
          return;
        }
        subtitles.push({
          lunaIndex: subtitles.length,
          lang: track.langIetf || track.lang || 'eng',
          name: track.name,
          codec: track.codec,
          forced: track.forced,
          isDefault: track.isDefault,
        });
      });
      const videoTrack = rawTracks.find((track) => track.type === MATROSKA_TRACK_TYPE_VIDEO) || null;
      const audioCodecs: string[] = [];
      rawTracks
        .filter((track) => track.type === MATROSKA_TRACK_TYPE_AUDIO)
        .forEach((track) => {
          const label = matroskaCodecLabel(track.codec);
          if (label && !audioCodecs.includes(label)) audioCodecs.push(label);
        });
      result = {
        subtitles,
        skippedBitmap,
        totalSubtitleTracks: subtitleTracks.length,
        video: videoTrack
          ? {
              codec: matroskaCodecLabel(videoTrack.codec),
              codecId: videoTrack.codec,
              width: videoTrack.width,
              height: videoTrack.height,
              hdr: matroskaHdrLabel(videoTrack.transfer, videoTrack.primaries),
            }
          : null,
        audioCodecs,
      };
      return false;
    });
    return false;
  });

  return result;
}

/* ───────────────────────── A fájl elejének letöltése (fejléc-próba) ───────────────────────── */

const PROBE_MAX_BYTES = 1572864; // 1,5 MB – a Tracks elem ennél jóval előbb érkezik
const PROBE_THRESHOLDS = [131072, 393216, 917504, PROBE_MAX_BYTES];
const probeCache = new Map<string, MatroskaProbeResult>();

function extensionOf(url: string): string {
  const clean = String(url || '').split(/[?#]/)[0];
  const last = clean.split('/').filter(Boolean).pop() || '';
  const match = last.match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1].toLowerCase() : '';
}

/** MKV/WebM fejléc-próba jöhet-e erre a címre (ismert nem-EBML végződésnél nem nyitunk kapcsolatot). */
function shouldProbeMatroska(url: string): boolean {
  const ext = extensionOf(url);
  if (!ext) return true; // ismeretlen: az EBML varázsbájt gyorsan eldönti
  return ext === 'mkv' || ext === 'webm' || ext === 'mka';
}

function fetchFileHead(url: string): Promise<MatroskaProbeResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    let thresholdIndex = 0;
    const xhr = new XMLHttpRequest();

    const finish = (value: MatroskaProbeResult | null) => {
      if (settled) return;
      settled = true;
      try { xhr.abort(); } catch { /* már lezárult */ }
      resolve(value);
    };

    const fileBytesFromHeaders = (): number | null => {
      try {
        const range = String(xhr.getResponseHeader('Content-Range') || '');
        const rangeMatch = range.match(/\/(\d+)\s*$/);
        if (rangeMatch) return Number(rangeMatch[1]) || null;
        const length = Number(xhr.getResponseHeader('Content-Length'));
        return Number.isFinite(length) && length > 0 ? length : null;
      } catch {
        return null;
      }
    };

    const tryParse = (text: string, finalAttempt: boolean): boolean => {
      const length = Math.min(text.length, PROBE_MAX_BYTES);
      if (length >= 4) {
        const head = new Uint8Array(4);
        for (let i = 0; i < 4; i += 1) head[i] = text.charCodeAt(i) & 0xff;
        if (!isEbmlFile(head)) return true; // nem MKV: kész, nincs mit olvasni
      }
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
      const parsed = parseMatroskaTracks(bytes);
      if (parsed) {
        parsed.fileBytes = fileBytesFromHeaders();
        finish(parsed);
        return true;
      }
      if (finalAttempt) finish(null);
      return false;
    };

    try {
      xhr.open('GET', url, true);
      // Régi webOS Chrome-on is működő bináris olvasás (részleges válasszal).
      xhr.overrideMimeType('text/plain; charset=x-user-defined');
      xhr.timeout = 20000;
      xhr.onprogress = () => {
        if (settled) return;
        const text = xhr.responseText || '';
        while (thresholdIndex < PROBE_THRESHOLDS.length && text.length >= PROBE_THRESHOLDS[thresholdIndex]) {
          thresholdIndex += 1;
          if (tryParse(text, thresholdIndex >= PROBE_THRESHOLDS.length)) return;
        }
      };
      xhr.onload = () => {
        if (settled) return;
        if (xhr.status !== 200 && xhr.status !== 206 && xhr.status !== 0) {
          appLog(`Beágyazott felirat (CC): a film fejléce nem olvasható (HTTP ${xhr.status}).`);
          finish(null);
          return;
        }
        tryParse(xhr.responseText || '', true);
        finish(null);
      };
      xhr.onerror = () => {
        appLog('Beágyazott felirat (CC): a film fejléce hálózati hiba miatt nem olvasható.');
        finish(null);
      };
      xhr.ontimeout = () => {
        appLog('Beágyazott felirat (CC): a film fejlécének olvasása időtúllépésbe futott.');
        finish(null);
      };
      xhr.send();
    } catch (error) {
      appLog('Beágyazott felirat (CC): fejlécpróba hiba: ' + String(error));
      resolve(null);
    }
  });
}

/**
 * A játszott film fájljába muxolt, kiválasztható feliratsávok felderítése.
 * Csak a fájl elejét olvassa (sikers esetén gyorsítótárazva); hiba esetén
 * üres listát ad – a többi feliratforrás ilyenkor is működik tovább.
 */
export async function probeEmbeddedSubtitles(streamUrl: string): Promise<EmbeddedSubtitle[]> {
  const url = String(streamUrl || '');
  if (!url || !shouldProbeMatroska(url)) return [];
  const cached = probeCache.get(url);
  const result = cached || (await fetchFileHead(url));
  if (!result) return [];
  if (!cached) probeCache.set(url, result);
  if (result.subtitles.length > 0) {
    appLog(
      `Beágyazott feliratok (CC): ${result.subtitles.length} sáv a fájlban ` +
      `(${result.subtitles.map((track) => track.lang || '?').join(', ')})` +
      (result.skippedBitmap > 0 ? `; kihagyott képalapú sáv: ${result.skippedBitmap}.` : '.')
    );
  } else if (result.totalSubtitleTracks > 0) {
    appLog(`Beágyazott felirat (CC): ${result.totalSubtitleTracks} sáv van a fájlban, de egy sem szöveges (csak képalapú), ezért nem választható.`);
  } else {
    appLog('Beágyazott felirat (CC): a fájl fejlécében nincs feliratsáv.');
  }
  return result.subtitles;
}

export interface MatroskaQualityInfo {
  video: MatroskaVideoInfo | null;
  audioCodecs: string[];
  fileBytes: number | null;
}

/**
 * A film fejlécének KÉPadatai a képminőség-naplóhoz (kodek, deklarált
 * felbontás, HDR-színmetaadat, fájlméret). Ugyanazt a gyorsítótárazott
 * fejléc-próbát használja, mint a felirat-felderítés, ezért általában
 * nem nyit második kapcsolatot; saját naplósort nem ír.
 */
export async function probeMatroskaVideoInfo(streamUrl: string): Promise<MatroskaQualityInfo | null> {
  const url = String(streamUrl || '');
  if (!url || !shouldProbeMatroska(url)) return null;
  const cached = probeCache.get(url);
  const result = cached || (await fetchFileHead(url));
  if (!result) return null;
  if (!cached) probeCache.set(url, result);
  return {
    video: result.video,
    audioCodecs: result.audioCodecs,
    fileBytes: result.fileBytes ?? null,
  };
}

/* ───────────────────────── webOS médiaszolgáltatás (Luna) ───────────────────────── */

interface LunaResponse {
  returnValue?: boolean;
  errorCode?: number | string;
  errorText?: string;
  [key: string]: unknown;
}

interface PalmBridgeLike {
  onservicecallback: ((message: string) => void) | null;
  call: (uri: string, params: string) => void;
  cancel?: () => void;
}

// A PalmServiceBridge példányokat életben kell tartani a válaszig, különben
// a motor eldobhatja a kérést (szemétgyűjtés).
const liveBridges: PalmBridgeLike[] = [];

let lunaSubtitleUnsupported = false;
/** A TV médiaszolgáltatása elutasította a beágyazott felirat bekapcsolását. */
export function isLunaSubtitleUnsupported(): boolean {
  return lunaSubtitleUnsupported;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

type VideoWithMediaId = HTMLVideoElement & { mediaId?: string };

/** A lejátszás Luna-azonosítója (webOS-en a <video> elem saját tulajdonsága). */
export function getWebosMediaId(video: HTMLVideoElement | null): string | null {
  try {
    const raw = String((video as VideoWithMediaId | null)?.mediaId || '').trim();
    return raw && raw !== '<invalid mediaId>' ? raw : null;
  } catch {
    return null;
  }
}

async function waitForMediaId(video: HTMLVideoElement | null, timeoutMs: number): Promise<string | null> {
  const startedAt = Date.now();
  for (;;) {
    const mediaId = getWebosMediaId(video);
    if (mediaId) return mediaId;
    if (Date.now() - startedAt >= timeoutMs) return null;
    await sleepMs(250);
  }
}

function callWebosMedia(method: string, parameters: Record<string, unknown>, timeoutMs = 4000): Promise<LunaResponse | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    const finish = (value: LunaResponse | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    try {
      const win = window as unknown as {
        webOS?: { service?: { request?: (uri: string, options: Record<string, unknown>) => void } };
        PalmServiceBridge?: new () => PalmBridgeLike;
      };
      if (win.webOS?.service?.request) {
        win.webOS.service.request('luna://com.webos.media', {
          method,
          parameters,
          onSuccess: (result: LunaResponse) => finish(result || null),
          onFailure: (result: LunaResponse) => finish(result || null),
        });
        return;
      }
      if (typeof win.PalmServiceBridge === 'function') {
        const bridge = new win.PalmServiceBridge();
        liveBridges.push(bridge);
        bridge.onservicecallback = (message: string) => {
          const index = liveBridges.indexOf(bridge);
          if (index >= 0) liveBridges.splice(index, 1);
          try {
            finish(JSON.parse(message) as LunaResponse);
          } catch {
            finish(null);
          }
        };
        bridge.call(`luna://com.webos.media/${method}`, JSON.stringify(parameters));
        return;
      }
      finish(null);
    } catch {
      finish(null);
    }
  });
}

function fontSizeLevelFor(scalePercent: number): number {
  if (scalePercent <= 75) return 1;
  if (scalePercent <= 110) return 2;
  if (scalePercent <= 150) return 3;
  return 4;
}

/**
 * Beágyazott feliratsáv bekapcsolása és kiválasztása a TV médiaszolgáltatásával.
 * A sávváltás előtt rövid szünet kell: a csővezeték a bekapcsolás után
 * azonnal küldött választást időnként eldobja.
 */
export async function selectEmbeddedSubtitle(
  video: HTMLVideoElement | null,
  lunaIndex: number,
  scalePercent = 100,
): Promise<boolean> {
  const mediaId = await waitForMediaId(video, 6000);
  if (!mediaId) {
    appLog('Beágyazott felirat (CC): nincs Luna mediaId – ezen a TV-n a beágyazott felirat nem kapcsolható (nem webOS lejátszás, vagy még nem indult el a film).');
    return false;
  }
  const enabled = await callWebosMedia('setSubtitleEnable', { mediaId, enable: true });
  if (!enabled || enabled.returnValue === false) {
    lunaSubtitleUnsupported = true;
    appLog(
      'Beágyazott felirat (CC): a TV médiaszolgáltatása nem kapcsolta be a feliratot' +
      (enabled?.errorText ? ` (${String(enabled.errorText).slice(0, 80)}).` : '.')
    );
    return false;
  }
  await sleepMs(500);
  const selected = await callWebosMedia('selectTrack', { mediaId, type: 'text', index: lunaIndex });
  if (!selected || selected.returnValue === false) {
    appLog(
      `Beágyazott felirat (CC): a(z) ${lunaIndex}. sáv kiválasztása sikertelen` +
      (selected?.errorText ? ` (${String(selected.errorText).slice(0, 80)}).` : '.')
    );
    await callWebosMedia('setSubtitleEnable', { mediaId, enable: false });
    return false;
  }
  const fontSize = fontSizeLevelFor(Number.isFinite(scalePercent) && scalePercent > 0 ? scalePercent : 100);
  void callWebosMedia('setSubtitleFontSize', { mediaId, fontSize });
  appLog(`Beágyazott felirat (CC) bekapcsolva: sáv=${lunaIndex}.`);
  return true;
}

/** A TV által kirajzolt beágyazott felirat kikapcsolása. */
export async function disableEmbeddedSubtitle(video: HTMLVideoElement | null): Promise<void> {
  const mediaId = await waitForMediaId(video, 1500);
  if (!mediaId) return;
  await callWebosMedia('setSubtitleEnable', { mediaId, enable: false });
}

/* ────────── Tartalék: sávlista a médiaszolgáltatás sourceInfo eseményéből ────────── */

/**
 * A `sourceInfo` válaszból kikeresi a feliratsávokat.
 * `null` = a válaszban nincs sourceInfo; üres tömb = van, de nincs sáv.
 */
export function extractSourceInfoSubtitles(payload: unknown, depth = 0): EmbeddedSubtitle[] | null {
  if (depth > 6 || payload === null || payload === undefined || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractSourceInfoSubtitles(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  const info = record.subtitleTrackInfo;
  if (Array.isArray(info)) {
    const tracks: EmbeddedSubtitle[] = [];
    info.forEach((entry) => {
      const item = (entry && typeof entry === 'object') ? entry as Record<string, unknown> : {};
      const type = String(item.type || '').toLowerCase();
      if (type && type !== 'text') return; // képalapú sáv nem számlálódik a text indexekbe
      tracks.push({
        lunaIndex: tracks.length,
        lang: String(item.language || item.lang || ''),
        name: String(item.name || item.title || ''),
        codec: '',
        forced: false,
        isDefault: tracks.length === 0,
      });
    });
    return tracks;
  }
  const count = Number(record.numSubtitleTracks);
  if (Number.isInteger(count) && count >= 0 && count <= 64) {
    return Array.from({ length: count }, (_, index) => ({
      lunaIndex: index,
      lang: '',
      name: '',
      codec: '',
      forced: false,
      isDefault: index === 0,
    }));
  }
  for (const value of Object.values(record)) {
    const found = extractSourceInfoSubtitles(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Feliratkozás a médiaszolgáltatás eseményeire, amíg a sourceInfo meg nem
 * érkezik (legfeljebb ~12 mp). A visszatérő függvény leiratkozik.
 * Csak tartalék: ha a TV nem ad sourceInfo-t a webappnak, csendben leáll.
 */
export function subscribeSourceInfoSubtitles(
  video: HTMLVideoElement | null,
  onTracks: (tracks: EmbeddedSubtitle[]) => void,
): () => void {
  let cancelled = false;
  let bridge: PalmBridgeLike | null = null;
  let mediaIdSeen: string | null = null;

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (mediaIdSeen) {
      void callWebosMedia('unsubscribe', { mediaId: mediaIdSeen }, 1500);
    }
    try { bridge?.cancel?.(); } catch { /* régebbi motor */ }
    if (bridge) {
      const index = liveBridges.indexOf(bridge);
      if (index >= 0) liveBridges.splice(index, 1);
      bridge = null;
    }
  };

  void (async () => {
    const mediaId = await waitForMediaId(video, 6000);
    if (cancelled || !mediaId) return;
    mediaIdSeen = mediaId;

    const handle = (payload: unknown) => {
      if (cancelled) return;
      const tracks = extractSourceInfoSubtitles(payload);
      if (!tracks) return;
      appLog(`Beágyazott feliratok (CC): a TV médiaszolgáltatása ${tracks.length} sávot jelzett (sourceInfo).`);
      onTracks(tracks);
      cancel();
    };

    try {
      const win = window as unknown as {
        webOS?: { service?: { request?: (uri: string, options: Record<string, unknown>) => { cancel?: () => void } | void } };
        PalmServiceBridge?: new () => PalmBridgeLike;
      };
      if (win.webOS?.service?.request) {
        win.webOS.service.request('luna://com.webos.media', {
          method: 'subscribe',
          parameters: { mediaId, subscribe: true },
          onSuccess: handle,
          onFailure: () => { /* a tartalék út csendben leáll */ },
        });
      } else if (typeof win.PalmServiceBridge === 'function') {
        bridge = new win.PalmServiceBridge();
        liveBridges.push(bridge);
        bridge.onservicecallback = (message: string) => {
          try {
            handle(JSON.parse(message));
          } catch {
            /* olvashatatlan esemény: figyelmen kívül hagyjuk */
          }
        };
        bridge.call('luna://com.webos.media/subscribe', JSON.stringify({ mediaId, subscribe: true }));
      }
    } catch {
      /* a tartalék út nem ronthatja el a lejátszást */
    }
    window.setTimeout(cancel, 12000);
  })();

  return cancel;
}

/* ─────────────── Képminőség-diagnosztika: a TV sourceInfo képadatai ─────────────── */

export interface SourceInfoQuality {
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  /** Képkockasebesség, ha a TV jelzi (pl. 25, 50, 59.94). */
  frameRate: number | null;
  /** Bitráta kbit/s-ban, ha a TV jelzi. */
  bitrateKbps: number | null;
  /** Pl. 'PQ', 'HLG', 'Dolby Vision' – üres, ha a TV nem jelzi. */
  hdr: string;
}

const SOURCEINFO_CODEC_HINT = /h\.?264|avc|h\.?265|hevc|vp9|vp8|av1|mpeg|aac|ac-?3|dts|opus|vorbis|flac|pcm/i;

function sourceInfoNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function sourceInfoText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = String(record[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

/**
 * A médiaszolgáltatás `sourceInfo` válaszából a képadatokat keresi ki.
 *
 * A webOS a feliratsávok mellett sok modellen a képsáv adatait is elküldi
 * (videoTrackInfo: codec, width, height, frameRate, bitRate), de a mezők
 * neve és jelenléte verziófüggő – ezért védekezően, több névalakot
 * próbálva olvasunk. `null` = a válaszban nincs használható képadat.
 */
export function extractSourceInfoQuality(payload: unknown, depth = 0): SourceInfoQuality | null {
  if (depth > 6 || payload === null || payload === undefined || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractSourceInfoQuality(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = payload as Record<string, unknown>;

  const fromTrack = (entry: Record<string, unknown>): SourceInfoQuality | null => {
    const width = sourceInfoNumber(entry, ['width', 'videoWidth', 'horizontalSize']);
    const height = sourceInfoNumber(entry, ['height', 'videoHeight', 'verticalSize']);
    const codecText = sourceInfoText(entry, ['codec', 'videoCodec', 'type']);
    if (!width && !height && !SOURCEINFO_CODEC_HINT.test(codecText)) return null;
    const rawBitrate = sourceInfoNumber(entry, ['bitRate', 'bitrate', 'bit_rate', 'bandwidth']);
    // A TV bit/s-ban szokta adni; a gyanúsan kicsi értéket kbit/s-nak vesszük.
    const bitrateKbps = rawBitrate === null ? null : rawBitrate > 50000 ? Math.round(rawBitrate / 1000) : Math.round(rawBitrate);
    const hdr = sourceInfoText(entry, ['hdr', 'hdrType', 'dynamicRange', 'videoRange', 'dolbyVision']);
    return {
      videoCodec: codecText,
      audioCodec: '',
      width: width || 0,
      height: height || 0,
      frameRate: sourceInfoNumber(entry, ['frameRate', 'framerate', 'frame_rate', 'fps']),
      bitrateKbps,
      hdr,
    };
  };

  for (const key of ['videoTrackInfo', 'videoTracks']) {
    const list = record[key];
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (entry && typeof entry === 'object') {
          const quality = fromTrack(entry as Record<string, unknown>);
          if (quality) return quality;
        }
      }
    }
  }
  const self = fromTrack(record);
  if (self) return self;

  for (const value of Object.values(record)) {
    const found = extractSourceInfoQuality(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Egyszeri sourceInfo-lekérdezés a képminőség-naplóhoz. Csak kézi
 * naplózás alatt hívjuk, streamenként egyszer; ha a TV időn belül nem
 * küld képadatot, `null` – a lejátszást nem érinti.
 */
export function probeSourceInfoQuality(
  video: HTMLVideoElement | null,
  timeoutMs = 8000,
): Promise<SourceInfoQuality | null> {
  return new Promise((resolve) => {
    let settled = false;
    let bridge: PalmBridgeLike | null = null;
    let mediaIdSeen: string | null = null;

    const finish = (value: SourceInfoQuality | null) => {
      if (settled) return;
      settled = true;
      if (mediaIdSeen) void callWebosMedia('unsubscribe', { mediaId: mediaIdSeen }, 1500);
      try { bridge?.cancel?.(); } catch { /* régebbi motor */ }
      if (bridge) {
        const index = liveBridges.indexOf(bridge);
        if (index >= 0) liveBridges.splice(index, 1);
        bridge = null;
      }
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);

    void (async () => {
      const mediaId = await waitForMediaId(video, 5000);
      if (settled || !mediaId) {
        window.clearTimeout(timer);
        finish(null);
        return;
      }
      mediaIdSeen = mediaId;
      const handle = (payload: unknown) => {
        if (settled) return;
        const quality = extractSourceInfoQuality(payload);
        if (quality) {
          window.clearTimeout(timer);
          finish(quality);
        }
      };
      try {
        const win = window as unknown as {
          webOS?: { service?: { request?: (uri: string, options: Record<string, unknown>) => { cancel?: () => void } | void } };
          PalmServiceBridge?: new () => PalmBridgeLike;
        };
        if (win.webOS?.service?.request) {
          win.webOS.service.request('luna://com.webos.media', {
            method: 'subscribe',
            parameters: { mediaId, subscribe: true },
            onSuccess: handle,
            onFailure: () => { /* a TV nem ad adatot: a próba csendben leáll */ },
          });
        } else if (typeof win.PalmServiceBridge === 'function') {
          bridge = new win.PalmServiceBridge();
          liveBridges.push(bridge);
          bridge.onservicecallback = (message: string) => {
            try { handle(JSON.parse(message)); } catch { /* olvashatatlan esemény */ }
          };
          bridge.call('luna://com.webos.media/subscribe', JSON.stringify({ mediaId, subscribe: true }));
        }
      } catch {
        /* a diagnosztikai próba nem ronthatja el a lejátszást */
      }
    })();
  });
}
