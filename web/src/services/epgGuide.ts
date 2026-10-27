/**
 * TELJES MŰSORÚJSÁG (XMLTV) – a szolgáltatótól, EGYETLEN kéréssel.
 *
 * MIÉRT KELL (2.5.143, 19-es TV-napló, 16:27:15):
 *
 * A naplóban 18 „rövid EPG” kérés szerepel, MINDEGY sikeres (HTTP 200), de
 * mindegyik **19 bájtos** válasszal:
 *
 *   SZOLGÁLTATÓ [rövid EPG], OK, 1542 ms, korlát=10000 ms, HTTP 200, 19 B
 *   SZOLGÁLTATÓ [rövid EPG], OK,  734 ms, korlát=10000 ms, HTTP 200, 19 B
 *   … (18 sor)
 *
 * A 19 bájt pontosan a `{"epg_listings":[]}` hossza: ez a panel a
 * `get_short_epg` végponton EGYETLEN műsort sem ad, akármelyik csatornára
 * kérdezzük. Vagyis az EPG addig SOHA nem tudott megjelenni, amíg kizárólag
 * ezt a végpontot használtuk – nem a felület volt hibás.
 *
 * A megoldás az, amit minden Xtream-kliens csinál: a szolgáltató teljes
 * műsorújságját (`/xmltv.php?username=…&password=…`) EGYSZER letöltjük, és
 * abból a csatorna `epg_channel_id`-ja alapján adjuk a most/következő műsort.
 *
 * FŐSZABÁLYOK (a TV-n ezek nélkül ez a fájl megfojtaná az appot):
 *   • SOHA nem az indulás alatt fut, csak a kész felület fölött, üresjáratban;
 *   • FOLYAMATOSAN olvassuk (stream), nem egyben: a nagy XML így nem foglal
 *     több tíz megabájtot és nem fagyasztja le a fő szálat;
 *   • csak a MOST és a KÖVETKEZŐ műsort tartjuk meg csatornánként (max. 4),
 *     így 20 ezer csatornánál is néhány megabájt marad a memóriában;
 *   • 30 percenként frissül, közben a gyorsítótárból dolgozunk;
 *   • hiba esetén a naplóba kerül a VALÓDI ok, és a rövid EPG marad tartaléknak.
 */

import { appLog, appLogError } from './appLog';
import type { ProviderRef } from './contentStore';
import { breakerOpen, breakerRemainingMs } from './net';
import { EpgNowNext, getCachedShortEpg, nowNextFromEpg, streamIdFor } from './epgService';
import { xtreamService } from './xtreamService';

interface GuideEntry {
  /** Kezdés (unix másodperc). */
  s: number;
  /** Vége (unix másodperc). */
  e: number;
  /** Műsorcím. */
  t: string;
}

/** Ennyi ideig használjuk ugyanazt a műsorújságot, utána újra letöltjük. */
const GUIDE_TTL_MS = 30 * 60 * 1000;
/** Egy kérés felső korlátja (nagy panelnél is belefér). */
const REQUEST_TIMEOUT_MS = 90_000;
/** Ennél nagyobb fájlt nem olvasunk tovább (memória-védelem). */
const MAX_BYTES = 64 * 1024 * 1024;
/** Ennyivel korábbi műsort még megtartunk (az éppen futó miatt). */
const KEEP_BEFORE_SEC = 2 * 3600;
/** Ennyivel későbbi műsort tartunk meg (a „következő” miatt). */
const KEEP_AFTER_SEC = 24 * 3600;
/**
 * Csatornánként ennyi műsort tartunk meg olvasás közben. A fájl sorrendje
 * nem garantált, ezért néhány tartalékkal többet olvasunk be, és a rendezés
 * után vágjuk vissza a felülethez szükséges mennyiségre.
 */
const MAX_ENTRIES_PER_CHANNEL = 6;
/** Rendezés után csatornánként ennyi műsor marad (most + következő + 2). */
const KEEP_ENTRIES_PER_CHANNEL = 4;
/** Ennél több csatornát nem indexelünk (memória-védelem). */
const MAX_CHANNELS = 40_000;

const index = new Map<string, GuideEntry[]>();
let nameToId = new Map<string, string>();
let loadedAt = 0;
let loadedProviderId = '';
let loading: Promise<void> | null = null;
let lastError = '';
let lastBytes = 0;
let lastProgrammes = 0;

/* ─────────────────────────── XMLTV segédfüggvények ─────────────────────── */

/** `20261027181500 +0200` → unix másodperc (az eltolást is figyelembe véve). */
function parseXmltvDate(value: string | null | undefined): number {
  if (!value) return 0;
  const match = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(value);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second, offset] = match;
  const utc = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), second ? Number(second) : 0,
  );
  let offsetMinutes = 0;
  if (offset) {
    const sign = offset[0] === '-' ? -1 : 1;
    offsetMinutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
  }
  const seconds = Math.floor((utc - offsetMinutes * 60_000) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** XML entitások visszafejtése (a címekben gyakran van `&amp;`). */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Név-egyeztetéshez: kisbetűs, ékezet nélküli, csak betűk/számok. */
function normalizeName(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(uhd|fhd|hd|sd|4k|hevc|h265|h264)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function attributeMap(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let match = re.exec(raw);
  while (match) {
    out[match[1].toLowerCase()] = match[2];
    match = re.exec(raw);
  }
  return out;
}

/* ───────────────────────────── feldolgozás ─────────────────────────────── */

let buffer = '';
let windowStart = 0;
let windowEnd = 0;

/** Egy kész blokk feldolgozása (`<programme …>…</programme>` vagy `<channel …>`). */
function consumeBlock(kind: string, attrs: string, body: string): void {
  if (kind === 'channel') {
    const info = attributeMap(attrs);
    const id = (info.id || '').trim();
    if (!id) return;
    const nameMatch = /<display-name[^>]*>([\s\S]*?)<\/display-name>/i.exec(body);
    if (!nameMatch) return;
    const key = normalizeName(decodeEntities(nameMatch[1]));
    if (key && !nameToId.has(key)) nameToId.set(key, id.toLowerCase());
    return;
  }

  const info = attributeMap(attrs);
  const channel = (info.channel || '').trim().toLowerCase();
  if (!channel) return;
  lastProgrammes += 1;
  const start = parseXmltvDate(info.start);
  const stop = parseXmltvDate(info.stop);
  if (!start || !stop || stop <= start) return;
  // Csak a mostani és a következő órák: ennyi kell a felületnek.
  if (stop < windowStart || start > windowEnd) return;
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  const title = titleMatch ? decodeEntities(titleMatch[1]) : '';
  if (!title) return;

  let list = index.get(channel);
  if (!list) {
    if (index.size >= MAX_CHANNELS) return;
    list = [];
    index.set(channel, list);
  }
  if (list.length >= MAX_ENTRIES_PER_CHANNEL) return;
  list.push({ s: start, e: stop, t: title });
}

/** A szövegdarab feldolgozása; csak a BEFEJEZETT blokkokat értelmezzük. */
function feed(text: string): void {
  buffer += text;
  // Memória-védelem: ha egyetlen blokk sem zárult le, ne nőjön korlátlanul.
  if (buffer.length > 8 * 1024 * 1024) buffer = buffer.slice(-1024 * 1024);
  let lastComplete = -1;
  let lastLength = 0;
  const endRe = /<\/(programme|channel)>/gi;
  let endMatch = endRe.exec(buffer);
  while (endMatch) {
    lastComplete = endMatch.index;
    lastLength = endMatch[0].length;
    endMatch = endRe.exec(buffer);
  }
  if (lastComplete < 0) return;
  const complete = buffer.slice(0, lastComplete + lastLength);
  buffer = buffer.slice(lastComplete + lastLength);

  const blockRe = /<(programme|channel)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match = blockRe.exec(complete);
  while (match) {
    consumeBlock(match[1].toLowerCase(), match[2] || '', match[3] || '');
    match = blockRe.exec(complete);
  }
}

function finishParsing(): void {
  /*
   * Rendezés + vágás: csak a mostani és a következő műsorok maradnak, így
   * több ezer csatornánál is néhány megabájt a memóriaigény (a TV-n ez a
   * különbség a folyamatos és a „megfagyó” felület között).
   */
  const nowSec = Math.floor(Date.now() / 1000) - KEEP_BEFORE_SEC;
  index.forEach((list, channel) => {
    list.sort((a, b) => a.s - b.s);
    const kept = list.filter((entry) => entry.e > nowSec).slice(0, KEEP_ENTRIES_PER_CHANNEL);
    if (kept.length) index.set(channel, kept);
    else index.delete(channel);
  });
  buffer = '';
}

/* ─────────────────────────────── letöltés ──────────────────────────────── */

function guideUrl(provider: { serverUrl?: string; username?: string; password?: string }): string {
  const base = xtreamService.baseUrl(provider.serverUrl || '');
  const user = encodeURIComponent(provider.username || '');
  const pass = encodeURIComponent(provider.password || '');
  return `${base}/xmltv.php?username=${user}&password=${pass}`;
}

async function download(provider: { serverUrl?: string; username?: string; password?: string }): Promise<void> {
  const url = guideUrl(provider);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller ? controller.signal : undefined,
      // A webOS böngészője magától kezeli a gzipet; sütit nem küldünk.
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
      // Régi motor: nincs stream, egyben olvassuk (ez már csak tartalék út).
      const text = await response.text();
      lastBytes = text.length;
      feed(text);
      finishParsing();
      return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let bytes = 0;
    let lastYield = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        try { await reader.cancel(); } catch { /* már lezárult */ }
        appLog(`EPG: a műsorújság ${Math.round(MAX_BYTES / 1048576)} MB-nál nagyobb – a további részt nem olvassuk.`);
        break;
      }
      feed(decoder.decode(value, { stream: true }));
      // LÉLEGZÉS: 250 ms-onként visszaadjuk a főszálat, hogy a felület fusson.
      if (Date.now() - lastYield > 250) {
        lastYield = Date.now();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    lastBytes = bytes;
    finishParsing();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ─────────────────────────────── nyilvános API ─────────────────────────── */

/**
 * A teljes műsorújság biztosítása (egyszer fut, 30 percig érvényes).
 *
 * SOHA nem hívjuk az indulás alatt: az App a megjelenés UTÁN, üresjáratban
 * indítja. Hibánál csendben visszatér (a naplóban ott a valódi ok), és a
 * rövid EPG marad tartaléknak.
 */
export function ensureGuide(provider: {
  id: string;
  type?: string;
  serverUrl?: string;
  username?: string;
  password?: string;
} | null): Promise<void> {
  if (!provider || provider.type !== 'xtream' || !provider.serverUrl || !provider.username || !provider.password) {
    return Promise.resolve();
  }
  const fresh = loadedProviderId === provider.id && index.size > 0 && Date.now() - loadedAt < GUIDE_TTL_MS;
  if (fresh) return Promise.resolve();
  if (loading) return loading;
  if (breakerOpen()) {
    appLog(`EPG: a megszakító nyitva van (${Math.ceil(breakerRemainingMs() / 1000)} mp) – a műsorújság később töltődik be.`);
    return Promise.resolve();
  }

  const startedAt = Date.now();
  index.clear();
  nameToId.clear();
  buffer = '';
  lastProgrammes = 0;
  lastBytes = 0;
  lastError = '';
  const nowSec = Math.floor(Date.now() / 1000);
  windowStart = nowSec - KEEP_BEFORE_SEC;
  windowEnd = nowSec + KEEP_AFTER_SEC;
  appLog('EPG: a teljes műsorújság (XMLTV) letöltése indul – a rövid EPG végpont ezen a panelen üres választ ad.');

  loading = download(provider)
    .then(() => {
      loadedAt = Date.now();
      loadedProviderId = provider.id;
      const channels = index.size;
      appLog(
        `EPG: műsorújság betöltve ${((Date.now() - startedAt) / 1000).toFixed(1)} mp alatt – `
        + `${channels} csatorna, ${lastProgrammes} feldolgozott műsor, `
        + `${(lastBytes / 1024).toFixed(0)} KB.`
      );
      if (channels === 0) {
        appLog('EPG: a szolgáltató műsorújságja üres – a felület a rövid EPG-t használja tartalékként.');
      }
    })
    .catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      const aborted = /abort/i.test(lastError);
      appLogError(`EPG műsorújság${aborted ? ' (időtúllépés)' : ''}`, error);
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** A csatorna XMLTV-azonosítója: `epg_channel_id`, majd név-egyeztetés. */
function guideKeyFor(channel: { epgChannelId?: string | null; name?: string }): string | null {
  const id = (channel.epgChannelId || '').trim();
  if (id) return id.toLowerCase();
  const key = normalizeName(channel.name || '');
  if (!key) return null;
  const viaName = nameToId.get(key);
  if (viaName) return viaName;
  if (index.has(key)) return key;
  return null;
}

/** 24 órás, nyelvfüggetlen idő (a rövid EPG-vel azonos formátum). */
function time24(seconds: number): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '--:--';
  const date = new Date(value * 1000);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  return `${hours < 10 ? '0' : ''}${hours}:${minutes < 10 ? '0' : ''}${minutes}`;
}

/** Most / következő a letöltött műsorújságból (ha van rá adat). */
export function guideNowNext(
  channel: { epgChannelId?: string | null; name?: string },
  at: number = Date.now(),
): EpgNowNext | null {
  if (index.size === 0) return null;
  const key = guideKeyFor(channel);
  if (!key) return null;
  const list = index.get(key);
  if (!list || list.length === 0) return null;
  const nowSec = Math.floor(at / 1000);
  const current = list.find((entry) => entry.s <= nowSec && entry.e > nowSec) || null;
  const upcoming = list.find((entry) => entry.s > nowSec) || null;
  const now = current || upcoming;
  if (!now) return null;
  const next = list.find((entry) => entry.s >= now.e) || null;
  return {
    now: {
      title: now.t,
      time: `${time24(now.s)} - ${time24(now.e)}`,
      startTimestamp: now.s,
      endTimestamp: now.e,
    },
    next: next ? { title: next.t, time: `${time24(next.s)} - ${time24(next.e)}` } : undefined,
  };
}

/**
 * EGYSÉGES LEKÉRDEZÉS: először a teljes műsorújság, utána a rövid EPG
 * gyorsítótára. `null` = erre a csatornára még nincs adat (le kell tölteni).
 */
export function channelNowNext(
  provider: ProviderRef | null,
  channel: { id?: string; name?: string; epgChannelId?: string | null; streamId?: number; streamUrl?: string },
  at: number = Date.now(),
): EpgNowNext | null {
  // Előre kiszámolt, beépített EPG (ha a lista már tartalmazza).
  const fromGuide = guideNowNext(channel, at);
  if (fromGuide) return fromGuide;
  if (!provider) return null;
  const streamId = streamIdFor(channel);
  if (!streamId) return null;
  const cached = getCachedShortEpg(provider, streamId, 6);
  if (!cached.length) return null;
  const epg = nowNextFromEpg(cached, at);
  return epg.now || epg.next ? epg : null;
}

/**
 * A következő néhány műsor (a teljes képernyős OSD „Következő” sora).
 * Csak a már betöltött műsorújságból dolgozik – nincs hálózat.
 */
export function guideUpcoming(
  channel: { epgChannelId?: string | null; name?: string },
  at: number = Date.now(),
  limit = 3,
): Array<{ title: string; time: string }> {
  const key = guideKeyFor(channel);
  if (!key) return [];
  const list = index.get(key);
  if (!list || list.length === 0) return [];
  const nowSec = Math.floor(at / 1000);
  const out: Array<{ title: string; time: string }> = [];
  for (const entry of list) {
    // Csak a JÖVŐBELI műsorok: az éppen futó a „most” sorban látszik.
    if (entry.s <= nowSec) continue;
    out.push({ title: entry.t, time: `${time24(entry.s)} - ${time24(entry.e)}` });
    if (out.length >= limit) break;
  }
  return out;
}

/** Van-e egyáltalán betöltött műsorújság (a naplózáshoz és a tesztekhez). */
export function guideStatus(): { channels: number; loadedAt: number; providerId: string; error: string; bytes: number } {
  return { channels: index.size, loadedAt, providerId: loadedProviderId, error: lastError, bytes: lastBytes };
}

/** Szolgáltatóváltáskor / frissítéskor a régi műsorújság eldobása. */
export function clearGuide(): void {
  index.clear();
  nameToId.clear();
  buffer = '';
  loadedAt = 0;
  loadedProviderId = '';
  lastProgrammes = 0;
  lastBytes = 0;
}
