import { appLog } from './appLog';
import { EmbeddedSubtitle, getWebosMediaId } from './embeddedSubtitleService';

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
 * A KIVÁLASZTÁS az élő adás saját, többlépcsős útja (a filmek kódját nem
 * használja és nem is befolyásolja). Azért kell külön út, mert élő
 * adásnál a PMT sorrendje nem mindig egyezik azzal, ahogyan a TV a saját
 * feliratsávjait számozza (képalapú DVB és teletext feliratoknál térhet
 * el), és a csővezeték sem áll mindig készen az első híváskor. Ezért a
 * bekapcsolás:
 *   • választáskor frissen lekérdezi a TV saját sávlistáját, és NYELV
 *     alapján keresi meg a kívánt sáv TV-beli sorszámát (a nyelvkódok
 *     alakját egységesítjük: hun / hu / Hungary / Magyar ugyanaz);
 *   • ha a sorszám bizonytalan, sorra próbálja a számozási változatokat
 *     (csak szöveges sávok számozása, illetve minden feliratsáv számozása),
 *     és a hívás dokumentált ('subtitle') alakját is, ha a megszokott
 *     ('text') alakot a TV elutasítja;
 *   • köröket ismétel friss mediaId-vel, amíg a TV vissza nem igazolja –
 *     mint a hangsávváltásnál: kiválasztod, és átvált.
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

/* ───────────────────────── Nyelvkódok egységesítése ───────────────────────── */

/**
 * A szolgáltatók össze-vissza adják a nyelvet (hun, hu, Hungary, Magyar,
 * hungarian…). Minden alakot egy közös (kétbetűs) alakra hozunk, hogy a TV
 * saját listájában nyelv alapján biztosan megtaláljuk a kívánt sávot –
 * ugyanaz a tanulság, mint korábban a hangsávoknál.
 */
const LIVE_LANG_CANONICAL: Record<string, string> = {
  hu: 'hu', hun: 'hu', magyar: 'hu', hungarian: 'hu', hungary: 'hu', ma: 'hu', may: 'hu', mag: 'hu',
  en: 'en', eng: 'en', english: 'en', angol: 'en',
  de: 'de', deu: 'de', ger: 'de', german: 'de', deutsch: 'de', nemet: 'de',
  fr: 'fr', fra: 'fr', fre: 'fr', french: 'fr', francia: 'fr',
  es: 'es', spa: 'es', spanish: 'es', spanyol: 'es',
  it: 'it', ita: 'it', italian: 'it', olasz: 'it',
  ro: 'ro', ron: 'ro', rum: 'ro', romanian: 'ro', roman: 'ro',
  sk: 'sk', slk: 'sk', slo: 'sk', slovak: 'sk', szlovak: 'sk',
  cs: 'cs', ces: 'cs', cze: 'cs', czech: 'cs', cseh: 'cs',
  hr: 'hr', hrv: 'hr', croatian: 'hr', horvat: 'hr',
  sr: 'sr', srp: 'sr', serbian: 'sr', szerb: 'sr',
  sl: 'sl', slv: 'sl', slovenian: 'sl', szloven: 'sl',
  uk: 'uk', ukr: 'uk', ukrainian: 'uk', ukran: 'uk',
  ru: 'ru', rus: 'ru', russian: 'ru', orosz: 'ru',
  pl: 'pl', pol: 'pl', polish: 'pl', lengyel: 'pl',
  bg: 'bg', bul: 'bg', bulgarian: 'bg', bolgar: 'bg',
  tr: 'tr', tur: 'tr', turkish: 'tr', torok: 'tr',
  el: 'el', ell: 'el', gre: 'el', greek: 'el', gorog: 'el',
  nl: 'nl', nld: 'nl', dut: 'nl', dutch: 'nl', holland: 'nl',
  pt: 'pt', por: 'pt', portuguese: 'pt', portugal: 'pt',
  sv: 'sv', swe: 'sv', da: 'da', dan: 'da', fi: 'fi', fin: 'fi',
  nb: 'no', no: 'no', nor: 'no', ar: 'ar', ara: 'ar', he: 'he', heb: 'he',
  ja: 'ja', jpn: 'ja', ko: 'ko', kor: 'ko', zh: 'zh', zho: 'zh', chi: 'zh',
};

export function canonicalLiveLang(value: unknown): string {
  const text = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (!text) return '';
  const first = text.split(/[^a-z]+/).filter(Boolean)[0] || '';
  return LIVE_LANG_CANONICAL[first] || first;
}

/* ───────────────────────── Élő Luna hívások (saját, VOD-tól külön) ───────────────────────── */

export interface LiveSubtitleRequest {
  /** A kívánt nyelv bármilyen alakban (hun/hu/Hungary/Magyar…) – egységesítjük. */
  lang?: string;
  /** A sáv fajtája a listánkból ('DVB' | 'Teletext' | 'HLS' | ''), csak tájékoztató jellegű. */
  codec?: string;
  /** A sáv sorszáma a mi (PMT/sourceInfo) listánkban – tartalék, ha a TV listája nem elérhető. */
  indexHint: number;
  /** Hányadik azonos nyelvű sáv a mi listánkban (0-tól) – a TV listájához illesztéshez. */
  ordinalInLang?: number;
}

/** A TV saját feliratsáv-bejegyzése a sourceInfo-ból, nyers típussal együtt. */
export interface LiveTvSubtitleInfo {
  lang: string;
  name: string;
  type: string;
  /** Képalapú (bitmap) sáv-e a TV jelölése szerint (DVB felirat, PGS…). */
  isBitmap: boolean;
}

interface LiveLunaResponse {
  returnValue?: boolean;
  errorCode?: number | string;
  errorText?: string;
  [key: string]: unknown;
}

interface LiveBridge {
  onservicecallback: ((message: string) => void) | null;
  call: (uri: string, params: string) => void;
  cancel?: () => void;
}

// A hídpéldányokat a válaszig életben tartjuk (különben a motor eldobhatja).
const liveBridges: LiveBridge[] = [];

function liveWindow(): {
  setTimeout: (handler: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  webOS?: { service?: { request?: (uri: string, options: Record<string, unknown>) => void } };
  PalmServiceBridge?: new () => LiveBridge;
} {
  const root = (globalThis as unknown as { window?: unknown }).window || globalThis;
  return root as ReturnType<typeof liveWindow>;
}

function sleepLive(ms: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      liveWindow().setTimeout(resolve, ms);
    } catch {
      setTimeout(resolve, ms);
    }
  });
}

function liveLunaAvailable(): boolean {
  try {
    const win = liveWindow();
    return typeof win.webOS?.service?.request === 'function'
      || typeof win.PalmServiceBridge === 'function';
  } catch {
    return false;
  }
}

function callLiveMedia(
  method: string,
  parameters: Record<string, unknown>,
  timeoutMs = 3000,
): Promise<LiveLunaResponse | null> {
  return new Promise((resolve) => {
    let settled = false;
    const win = liveWindow();
    const timer = win.setTimeout(() => finish(null), timeoutMs);
    const finish = (value: LiveLunaResponse | null) => {
      if (settled) return;
      settled = true;
      try { win.clearTimeout(timer); } catch { /* ignore */ }
      resolve(value);
    };
    try {
      if (win.webOS?.service?.request) {
        win.webOS.service.request('luna://com.webos.media', {
          method,
          parameters,
          onSuccess: (result: LiveLunaResponse) => finish(result || null),
          onFailure: (result: LiveLunaResponse) => finish(result || null),
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
            finish(JSON.parse(message) as LiveLunaResponse);
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

function lunaOk(response: LiveLunaResponse | null): boolean {
  return !!response && response.returnValue !== false;
}

function lunaErrorText(response: LiveLunaResponse | null): string {
  if (!response) return 'nincs válasz (időtúllépés)';
  if (response.errorText) return String(response.errorText).slice(0, 80);
  if (response.errorCode !== undefined) return `hibakód=${String(response.errorCode)}`;
  return 'returnValue=false';
}

async function waitLiveMediaId(
  video: HTMLVideoElement | null,
  timeoutMs: number,
): Promise<string | null> {
  const startedAt = Date.now();
  for (;;) {
    const mediaId = getWebosMediaId(video);
    if (mediaId) return mediaId;
    if (Date.now() - startedAt >= timeoutMs) return null;
    await sleepLive(250);
  }
}

/* ────────── A TV saját sávlistája (sourceInfo), képalapú sávokkal együtt ────────── */

const LIVE_BITMAP_TYPE = /bitmap|image|picture|dvb|pgs|vobsub|xsub/i;

/**
 * A `sourceInfo` válaszból kikeresi az ÖSSZES feliratsávot a nyers
 * típusukkal együtt. A VOD (film) úttal ellentétben itt a képalapú
 * (DVB) sávokat is megtartjuk, mert élő adásban épp azok a jellemzőek.
 * `null` = nincs sourceInfo a válaszban.
 */
export function extractLiveSourceInfoTracks(payload: unknown, depth = 0): LiveTvSubtitleInfo[] | null {
  if (depth > 6 || payload === null || payload === undefined || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractLiveSourceInfoTracks(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  const info = record.subtitleTrackInfo;
  if (Array.isArray(info)) {
    return info.map((entry) => {
      const item = (entry && typeof entry === 'object') ? entry as Record<string, unknown> : {};
      const type = String(item.type || item.codec || '');
      return {
        lang: String(item.language || item.lang || ''),
        name: String(item.name || item.title || ''),
        type,
        isBitmap: LIVE_BITMAP_TYPE.test(type),
      };
    });
  }
  const count = Number(record.numSubtitleTracks);
  if (Number.isInteger(count) && count >= 0 && count <= 64) {
    return Array.from({ length: count }, () => ({ lang: '', name: '', type: '', isBitmap: false }));
  }
  for (const value of Object.values(record)) {
    const found = extractLiveSourceInfoTracks(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** A TV nyers típusa alapján a listában mutatott fajta ('DVB', 'Teletext' vagy ''). */
function liveCodecLabel(type: string, isBitmap: boolean): string {
  if (/teletext/i.test(type)) return 'Teletext';
  if (isBitmap) return 'DVB';
  return '';
}

/**
 * Mely TV-beli sorszámokat próbáljuk sorban a kívánt sávhoz.
 * Nyelvtalálat esetén a TV listájából számoljuk: szöveges sávnál előbb a
 * csak-szöveges számozást, majd a teljes (képalapúakat is számoló) sorszámot;
 * képalapú sávnál a teljes sorszámot. Találat nélkül a saját (PMT) sorszám
 * a tartalék (a TV lista hosszához szorítva).
 */
export function buildLiveCandidateIndexes(
  desired: LiveSubtitleRequest,
  tvTracks: LiveTvSubtitleInfo[] | null,
): number[] {
  const candidates: number[] = [];
  const add = (index: number) => {
    if (Number.isInteger(index) && index >= 0 && !candidates.includes(index)) candidates.push(index);
  };
  const hint = Number.isInteger(desired.indexHint) && desired.indexHint >= 0 ? desired.indexHint : 0;
  if (tvTracks && tvTracks.length > 0) {
    const want = canonicalLiveLang(desired.lang || '');
    const matches: number[] = [];
    tvTracks.forEach((track, index) => {
      if (want && canonicalLiveLang(track.lang) === want) matches.push(index);
    });
    if (matches.length > 0) {
      const ordinal = Math.min(Math.max(desired.ordinalInLang || 0, 0), matches.length - 1);
      const pick = matches[ordinal];
      if (!tvTracks[pick].isBitmap) {
        let textOrdinal = 0;
        for (let i = 0; i < pick; i += 1) if (!tvTracks[i].isBitmap) textOrdinal += 1;
        add(textOrdinal);
      }
      add(pick);
      return candidates;
    }
    add(Math.min(hint, tvTracks.length - 1));
    return candidates;
  }
  add(hint);
  return candidates;
}

/**
 * A TV saját feliratsáv-listájának egyszeri lekérdezése (feliratkozással)
 * választás előtt. `null` = időn belül nem érkezett sourceInfo.
 */
function queryLiveTvTracks(mediaId: string, timeoutMs: number): Promise<LiveTvSubtitleInfo[] | null> {
  return new Promise((resolve) => {
    let done = false;
    let bridge: LiveBridge | null = null;
    const win = liveWindow();
    const timer = win.setTimeout(() => finish(null), timeoutMs);
    const finish = (value: LiveTvSubtitleInfo[] | null) => {
      if (done) return;
      done = true;
      try { win.clearTimeout(timer); } catch { /* ignore */ }
      try { bridge?.cancel?.(); } catch { /* régebbi motor */ }
      if (bridge) {
        const index = liveBridges.indexOf(bridge);
        if (index >= 0) liveBridges.splice(index, 1);
        bridge = null;
      }
      void callLiveMedia('unsubscribe', { mediaId }, 1200);
      resolve(value);
    };
    const handle = (payload: unknown) => {
      if (done) return;
      const tracks = extractLiveSourceInfoTracks(payload);
      if (tracks) finish(tracks);
    };
    try {
      if (win.webOS?.service?.request) {
        win.webOS.service.request('luna://com.webos.media', {
          method: 'subscribe',
          parameters: { mediaId, subscribe: true },
          onSuccess: handle,
          onFailure: () => { /* csendben várunk az időtúllépésig */ },
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
      } else {
        finish(null);
      }
    } catch {
      finish(null);
    }
  });
}

/**
 * A TV saját sávlistája (sourceInfo) a CC-lista feltöltéséhez – amint
 * megérkezik, a hívó megkapja. A visszatérő függvény leiratkozik.
 * Élőnél a képalapú (DVB) sávok is szerepelnek a listában.
 */
export function subscribeLiveSubtitleTracks(
  video: HTMLVideoElement | null,
  onTracks: (tracks: LiveSubtitleTrack[]) => void,
): () => void {
  let cancelled = false;
  let bridge: LiveBridge | null = null;
  let mediaIdSeen: string | null = null;
  let timeoutId: number | null = null;

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (timeoutId !== null) {
      try { liveWindow().clearTimeout(timeoutId); } catch { /* ignore */ }
      timeoutId = null;
    }
    if (mediaIdSeen) {
      void callLiveMedia('unsubscribe', { mediaId: mediaIdSeen }, 1200);
    }
    try { bridge?.cancel?.(); } catch { /* régebbi motor */ }
    if (bridge) {
      const index = liveBridges.indexOf(bridge);
      if (index >= 0) liveBridges.splice(index, 1);
      bridge = null;
    }
  };

  void (async () => {
    if (!liveLunaAvailable()) return;
    const mediaId = await waitLiveMediaId(video, 8000);
    if (cancelled || !mediaId) return;
    mediaIdSeen = mediaId;

    const handle = (payload: unknown) => {
      if (cancelled) return;
      const tvTracks = extractLiveSourceInfoTracks(payload);
      if (!tvTracks) return;
      const tracks: LiveSubtitleTrack[] = tvTracks.map((track, index) => {
        const codec = liveCodecLabel(track.type, track.isBitmap);
        return {
          lunaIndex: index,
          lang: track.lang,
          name: track.name || liveSubtitleName(track.lang, codec),
          codec,
          forced: false,
          isDefault: index === 0,
        };
      });
      appLog(`Élő feliratok (CC): a TV médiaszolgáltatása ${tracks.length} sávot jelzett (sourceInfo).`);
      onTracks(tracks);
      cancel();
    };

    try {
      const win = liveWindow();
      if (win.webOS?.service?.request) {
        win.webOS.service.request('luna://com.webos.media', {
          method: 'subscribe',
          parameters: { mediaId, subscribe: true },
          onSuccess: handle,
          onFailure: () => { /* a tartalék (PMT) út ettől független */ },
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
      /* a lista útja nem ronthatja el a lejátszást */
    }
    try {
      timeoutId = liveWindow().setTimeout(cancel, 15000);
    } catch {
      /* ignore */
    }
  })();

  return cancel;
}

/**
 * Élő feliratsáv bekapcsolása a TV médiaszolgáltatásával, többlépcsős,
 * ismétlő úton (lásd a fejléc megjegyzését). Igaz = a TV visszaigazolta a
 * sávválasztást. Újabb hívás vagy kikapcsolás a futó próbálkozást leállítja.
 */
let liveSelectToken = 0;

function liveFontSizeLevel(scalePercent: number): number {
  if (scalePercent <= 75) return 1;
  if (scalePercent <= 110) return 2;
  if (scalePercent <= 150) return 3;
  return 4;
}

export interface LiveSelectOptions {
  /** A körök előtti várakozások (ms). Első körben azonnal próbálkozunk. */
  retryDelaysMs?: number[];
  /** A bekapcsolás és a sávválasztás közötti rövid szünet (ms). */
  enableSettleMs?: number;
  /** A TV listájára várás körönként (ms). */
  queryTimeoutMs?: number;
}

export async function selectLiveSubtitle(
  video: HTMLVideoElement | null,
  desired: LiveSubtitleRequest | number,
  scalePercent = 100,
  options: LiveSelectOptions = {},
): Promise<boolean> {
  const request: LiveSubtitleRequest = typeof desired === 'number'
    ? { indexHint: desired }
    : desired;
  if (!liveLunaAvailable()) {
    appLog('Élő felirat (CC): a TV médiaszolgáltatása nem elérhető ezen a felületen.');
    return false;
  }
  const token = ++liveSelectToken;
  const delays = options.retryDelaysMs && options.retryDelaysMs.length > 0
    ? options.retryDelaysMs
    : [0, 900, 2200, 4500];
  const settleMs = options.enableSettleMs ?? 500;
  const queryTimeout = options.queryTimeoutMs ?? 2200;
  let lastMediaId = '';
  let lastError = '';

  for (let round = 0; round < delays.length; round += 1) {
    if (token !== liveSelectToken) return false; // újabb kérés váltotta
    if (delays[round] > 0) await sleepLive(delays[round]);
    if (token !== liveSelectToken) return false;

    const mediaId = await waitLiveMediaId(video, round === 0 ? 5000 : 2500);
    if (!mediaId) {
      lastError = 'nincs még mediaId (a lejátszás nem indult el)';
      continue;
    }
    lastMediaId = mediaId;

    // A TV aktuális listája alapján számoljuk a sorszámot; ha nincs válasz,
    // a saját (PMT/HLS) sorszámunk a tartalék.
    const tvTracks = await queryLiveTvTracks(mediaId, queryTimeout);
    if (token !== liveSelectToken) return false;
    const candidates = buildLiveCandidateIndexes(request, tvTracks);
    if (candidates.length === 0) {
      lastError = 'a TV nem jelez választható feliratsávot';
      continue;
    }

    // A bekapcsolás hibája önmagában nem végzetes: van olyan TV, ahol a
    // sávválasztás egymagában is bekapcsolja a feliratot.
    await callLiveMedia('setSubtitleEnable', { mediaId, enable: true }, 3000);
    await sleepLive(settleMs);
    if (token !== liveSelectToken) return false;

    for (const typeName of ['text', 'subtitle']) {
      for (const index of candidates) {
        if (token !== liveSelectToken) return false;
        const selected = await callLiveMedia('selectTrack', { mediaId, type: typeName, index }, 3000);
        if (lunaOk(selected)) {
          const fontSize = liveFontSizeLevel(
            Number.isFinite(scalePercent) && scalePercent > 0 ? scalePercent : 100,
          );
          void callLiveMedia('setSubtitleFontSize', { mediaId, fontSize }, 2000);
          appLog(
            `Élő felirat (CC) bekapcsolva: TV-sáv=${index} (hívás: ${typeName}` +
            (tvTracks ? `, a TV ${tvTracks.length} sávot jelez` : ', TV-lista nélkül') +
            `, kör=${round + 1}).`
          );
          return true;
        }
        lastError = lunaErrorText(selected);
      }
    }
  }

  appLog(`Élő felirat (CC): a TV nem kapcsolta be a kiválasztott sávot (${lastError || 'ismeretlen hiba'}).`);
  if (lastMediaId) {
    void callLiveMedia('setSubtitleEnable', { mediaId: lastMediaId, enable: false }, 2000);
  }
  return false;
}

/** A TV által kirajzolt élő felirat kikapcsolása (a futó próbálkozást is leállítja). */
export async function disableLiveSubtitle(video: HTMLVideoElement | null): Promise<void> {
  liveSelectToken += 1;
  if (!liveLunaAvailable()) return;
  const mediaId = await waitLiveMediaId(video, 1500);
  if (!mediaId) return;
  await callLiveMedia('setSubtitleEnable', { mediaId, enable: false }, 2000);
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
