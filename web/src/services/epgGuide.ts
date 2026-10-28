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
import { openIdbStore } from './idbStore';
import { xtreamService } from './xtreamService';

interface GuideEntry {
  /** Kezdés (unix másodperc). */
  s: number;
  /** Vége (unix másodperc). */
  e: number;
  /** Műsorcím. */
  t: string;
}

/**
 * Ennyi ideig használjuk ugyanazt a műsorújságot, utána újra letöltjük.
 *
 * 2.5.145: 30 perc helyett 3 óra. A fájl 62 MB – a TV-n ez a letöltés a
 * videó-adatfolyammal osztozik, ezért nem pazaroljuk félóránként. Cserébe
 * csatornánként 12 órára előre tartunk műsort (nem csak 24 órára 4 darabot),
 * így a gyorsítótár a 3 óra alatt sem ürül ki.
 */
const GUIDE_TTL_MS = 3 * 60 * 60 * 1000;
/**
 * A LETÖLTÉS KORLÁTAI (2.5.166).
 *
 * A #32–#37 naplók: a 62 MB-os műsorújság a TV-n ~250 kB/s-mal jön, vagyis
 * ~4 perc. A régi 90 mp-es TELJES időkorlát és a 64 MB-os plafon ezért
 * MINDEN ALKALOMMAL megszakította a letöltést (`AbortError:
 * BodyStreamBuffer was aborted`) – az EPG soha nem tudott betöltődni.
 *
 * Helyette:
 *   • IDLE_TIMEOUT_MS – csak akkor szakítjuk meg, ha NEM JÖN adat (a hálózat
 *     megakadt); a lassú, de folyamatos olvasást nem büntetjük,
 *   • MAX_DOWNLOAD_MS – biztonsági felső korlát, utána a MÁR beolvasott rész
 *     használható marad (részleges index),
 *   • MAX_BYTES – memória-védelem; efelett szintén a részleges index marad.
 */
const IDLE_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_MS = 8 * 60_000;
const MAX_BYTES = 192 * 1024 * 1024;
/** Ennyivel korábbi műsort még megtartunk (az éppen futó miatt). */
const KEEP_BEFORE_SEC = 2 * 3600;
/** Ennyivel későbbi műsort tartunk meg (a „következő” miatt). */
const KEEP_AFTER_SEC = 12 * 3600;
/**
 * Csatornánként ennyi műsort tartunk meg olvasás közben. A fájl sorrendje
 * nem garantált, ezért néhány tartalékkal többet olvasunk be, és a rendezés
 * után vágjuk vissza a felülethez szükséges mennyiségre.
 */
const MAX_ENTRIES_PER_CHANNEL = 16;
/** Rendezés után csatornánként ennyi műsor marad (most + következő ~12 óra). */
const KEEP_ENTRIES_PER_CHANNEL = 14;
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
/** Az időablakon kívül eső (lejárt vagy túl késői) műsorok száma – diagnózishoz. */
let lastSkipped = 0;
/**
 * RÉSZLETES SZÁMLÁLÓK (2.5.168).
 *
 * A #38 napló ezt írta: „203140 feldolgozott műsor, 202234 időablakon kívüli”,
 * majd a tartós tárba MINDÖSSZE 103 műsor került. A két szám közti különbség
 * okát a napló nem árulta el – pont ezért nem lehetett megmondani, miért nem
 * jelenik meg a sárga csík. Mostantól minden kiesési ok külön számolódik, és
 * a záró sorban ott van.
 */
let statInvalidDate = 0;
let statNoTitle = 0;
let statCap = 0;
let statKept = 0;

/* ─────────────────────────── XMLTV segédfüggvények ─────────────────────── */

/**
 * XMLTV idő → unix másodperc (az eltolást is figyelembe véve).
 *
 * KÉT FORMÁTUM (2.5.168): az XMLTV szabvány a tömör alakot írja elő
 * (`20261028181500 +0200`), de a panelek egy része elválasztós/ISO alakot ad
 * (`2026-10-28 18:15:00 +02:00`). A #38 naplóban 203 140 feldolgozott
 * műsorból 202 234 „időablakon kívüli” volt, és a tartós tárba mindössze 103
 * került – vagyis a dátumok nagy része valószínűleg nem is értelmeződött.
 * Ezért mostantól MINDKÉT alakot olvassuk, és a hibás időpontok száma (az
 * első három nyers értékével) a naplóba kerül.
 */
const XMLTV_COMPACT = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?/;
const XMLTV_DASHED = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*(?:([+-])(\d{2}):?(\d{2})|Z)?/;

function parseXmltvDate(value: string | null | undefined): number {
  if (!value) return 0;
  const text = String(value).trim();
  const match = XMLTV_DASHED.exec(text) || XMLTV_COMPACT.exec(text);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return 0;
  let offsetMinutes = 0;
  if (match[7]) {
    const sign = match[7] === '-' ? -1 : 1;
    offsetMinutes = sign * (Number(match[8]) * 60 + Number(match[9]));
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
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
  if (!start || !stop || stop <= start) {
    statInvalidDate += 1;
    // Az ELSŐ három hibás időpont nyers alakja is a naplóba kerül: ebből
    // derül ki, ha a panel más dátumformátumot használ (a napló nem tartalmaz
    // belépési adatot, csak a dátum-attribútumot).
    if (statInvalidDate <= 3) {
      appLog(
        `EPG: érvénytelen időpont a műsorújságban – kezdés=„${String(info.start || '').slice(0, 32)}”, `
        + `vég=„${String(info.stop || '').slice(0, 32)}” (ezt a műsort kihagyjuk).`
      );
    }
    return;
  }
  // Csak a mostani és a következő órák: ennyi kell a felületnek. A nagy
  // paneloknál a fájl ELSŐ fele gyakran napokkal korábbi műsor – ezért volt
  // a naplóban „20 MB, eddig 0 csatorna”: nem hiba, csak kihagyjuk.
  if (stop < windowStart || start > windowEnd) {
    lastSkipped += 1;
    return;
  }
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  const title = titleMatch ? decodeEntities(titleMatch[1]) : '';
  if (!title) {
    statNoTitle += 1;
    return;
  }

  let list = index.get(channel);
  if (!list) {
    if (index.size >= MAX_CHANNELS) {
      statCap += 1;
      return;
    }
    list = [];
    index.set(channel, list);
  }
  /*
   * MEGTELT CSATORNA: a LEGKORÁBBAN VÉGZŐDŐ bejegyzést dobjuk el, ha az új
   * később ér véget. Korábban itt `return` volt: ha a fájl egy csatornánál a
   * régi műsorokkal kezdett, a 16 hely betelt a lejártakkal, a mai műsorok
   * pedig elvesztek – ezért volt a naplóban „203140 feldolgozott műsor”, és
   * mégis alig száz megtartott.
   */
  if (list.length >= MAX_ENTRIES_PER_CHANNEL) {
    const nowSecNow = Math.floor(Date.now() / 1000);
    // 1) A már lejárt műsor helyére mindig befér az új (az a nézőnek haszontalan).
    let expired = -1;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].e <= nowSecNow && (expired < 0 || list[i].e < list[expired].e)) expired = i;
    }
    if (expired >= 0) {
      list.splice(expired, 1);
    } else {
      /*
       * 2) Csupa jövőbeli műsor: a LEGTÁVOLABBIT dobjuk el, ha az új közelebb
       * van a mostani időhöz. Ez a lényeg: a fájl sorrendje nem garantált, és
       * a #38–#42 naplókban pont ez veszett el – a korlát a holnapi (vagy
       * jövő heti) műsorokkal telt meg, a MAI pedig kimaradt.
       */
      let farthest = 0;
      for (let i = 1; i < list.length; i += 1) {
        if (list[i].s > list[farthest].s) farthest = i;
      }
      if (list[farthest].s <= start) {
        statCap += 1;
        return;
      }
      list.splice(farthest, 1);
    }
  }
  list.push({ s: start, e: stop, t: title });
}

/** Monoton óra a szünetek időzítéséhez (a TV-n a `Date.now` is elég pontos). */
function nowMs(): number {
  try {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  } catch {
    return Date.now();
  }
}

/** Hány blokk feldolgozása után adjuk vissza a főszálat. */
const YIELD_EVERY_BLOCKS = 40;
/**
 * Ennyi ms folyamatos munka után MINDENKÉPP visszaadjuk a főszálat (2.5.165).
 *
 * A 21. napló: a 62 MB-os műsorújság feldolgozása 41 mp volt, és ezalatt a
 * csatornaváltás 100 ms-os újrapróbája 16 mp-et késett (a TV „lefagyott”
 * váltás közben). A blokk-számláló önmagában nem elég: a hosszú sorok miatt
 * 40 blokk is lehet 100+ ms. A 12 ms-os felső korlát képkockánként
 * visszaadja a szálat, így a lejátszó és az időzítők futni tudnak.
 */
const YIELD_AFTER_MS = 12;
/** A legutóbbi szünet óta feldolgozott idő. */
let sliceStartedAt = 0;
/** A legutóbbi szünet óta feldolgozott blokkok száma. */
let blocksSinceYield = 0;

/** A szövegdarab feldolgozása; csak a BEFEJEZETT blokkokat értelmezzük. */
function feed(text: string): void {
  if (!sliceStartedAt) sliceStartedAt = nowMs();
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
  let consumed = 0;
  while (match) {
    consumeBlock(match[1].toLowerCase(), match[2] || '', match[3] || '');
    consumed = match.index + match[0].length;
    blocksSinceYield += 1;
    const elapsed = nowMs() - sliceStartedAt;
    if (blocksSinceYield >= YIELD_EVERY_BLOCKS || elapsed >= YIELD_AFTER_MS) {
      blocksSinceYield = 0;
      // A feldolgozatlan maradékot VISSZATESSZÜK a pufferbe. Korábban ez a
      // rész elveszett: a `complete` blokk már ki volt vágva a pufferből,
      // így a szünet után a maradék műsorok egyszerűen eltűntek.
      buffer = complete.slice(consumed) + buffer;
      // Rövid szünet a hívónak: a 62 MB-os fájl így nem egyetlen hosszú
      // feladat, hanem sok apró lépés (a felület közben fest).
      yieldRequested = true;
      return;
    }
    match = blockRe.exec(complete);
  }
  // A szelet végére ÉRTÜNK (nem kellett szünetet kérni): a következő
  // hívás új mérési ablakot kap, különben azonnal szünetelne.
  sliceStartedAt = 0;
  blocksSinceYield = 0;
}

/**
 * A `feed()` jelezte, hogy itt az ideje visszaadni a vezérlést.
 *
 * A maradék szöveget NEM dobjuk el: a feldolgozatlan rész a `buffer`-ben
 * marad, és a következő híváskor onnan folytatjuk.
 */
let yieldRequested = false;

/** Feldolgozás visszaadott szünetekkel: amíg van mit, addig darabolunk. */
async function feedWithBreath(text: string): Promise<void> {
  feed(text);
  while (yieldRequested) {
    yieldRequested = false;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // A megmaradt, befogadott szöveget tovább dolgozzuk fel.
    sliceStartedAt = nowMs();
    if (buffer.length) feed('');
  }
}

function finishParsing(): void {
  /*
   * Rendezés + vágás: csak a mostani és a következő műsorok maradnak, így
   * több ezer csatornánál is néhány megabájt a memóriaigény (a TV-n ez a
   * különbség a folyamatos és a „megfagyó” felület között).
   */
  const nowSec = Math.floor(Date.now() / 1000) - KEEP_BEFORE_SEC;
  statKept = 0;
  index.forEach((list, channel) => {
    list.sort((a, b) => a.s - b.s);
    const kept = list.filter((entry) => entry.e > nowSec).slice(0, KEEP_ENTRIES_PER_CHANNEL);
    if (kept.length) {
      index.set(channel, kept);
      statKept += kept.length;
    } else {
      index.delete(channel);
    }
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

/** A megszakítás oka (a naplóban ez a VALÓDI magyarázat). */
let abortReason = '';

async function download(provider: { serverUrl?: string; username?: string; password?: string }): Promise<void> {
  const url = guideUrl(provider);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  abortReason = '';
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /*
   * ŐRKUTYA: a teljes időkorlát helyett az ADATHIÁNYT figyeljük. A #36 napló
   * bizonyítja, hogy a teljes fájl 81 mp alatt letölthető – a 90 mp-es fix
   * korlát ennek a határán volt, a 62 MB-os fájlnál pedig mindig lejárt.
   */
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortReason = `időtúllépés – ${Math.round(IDLE_TIMEOUT_MS / 1000)} mp-ig nem érkezett adat`;
      controller?.abort();
    }, IDLE_TIMEOUT_MS);
  };
  const deadline = controller
    ? setTimeout(() => {
      abortReason = `a letöltés elérte a ${Math.round(MAX_DOWNLOAD_MS / 60000)} perces felső korlátot`;
      controller.abort();
    }, MAX_DOWNLOAD_MS)
    : null;
  armIdle();
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
      armIdle();
      await feedWithBreath(text);
      finishParsing();
      return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let bytes = 0;
    let lastLoggedBytes = 0;
    let lastYield = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      armIdle();
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        try { await reader.cancel(); } catch { /* már lezárult */ }
        abortReason = `a műsorújság nagyobb, mint ${Math.round(MAX_BYTES / 1048576)} MB`;
        appLog(`EPG: ${abortReason} – a további részt nem olvassuk, a MÁR beolvasott rész használható.`);
        break;
      }
      await feedWithBreath(decoder.decode(value, { stream: true }));
      // LÉLEGZÉS: 250 ms-onként visszaadjuk a főszálat, hogy a felület fusson.
      if (Date.now() - lastYield > 250) {
        lastYield = Date.now();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      // Haladásjelzés a naplóba (10 MB-onként): a TV-n ebből látszik, hogy a
      // letöltés él és halad – és hogy a kihagyott (ablakon kívüli) műsorok
      // miatt miért kevés a csatorna a fájl első felében.
      if (bytes - lastLoggedBytes >= 10 * 1024 * 1024) {
        lastLoggedBytes = bytes;
        appLog(
          `EPG: műsorújság olvasása – ${(bytes / 1048576).toFixed(0)} MB, `
          + `${index.size} csatorna, ${lastProgrammes} műsor a keresett időablakban.`
        );
      }
    }
    lastBytes = bytes;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (deadline) clearTimeout(deadline);
    /*
     * MEGSZAKÍTÁSNÁL IS MENTJÜK, AMI ÖSSZEJÖTT. Korábban az `AbortError`
     * után az index üresen maradt (a finishParsing le sem futott), ezért a
     * néző semmit nem látott. A részleges index a következő letöltésig is
     * használható, és a sárga csík azon csatornákra megjelenik, amelyekre
     * már van adat.
     */
    if (index.size > 0) finishParsing();
  }
}

/* ──────────────────── TARTÓS GYORSÍTÓTÁR (IndexedDB) ──────────────────── */

/**
 * A kész műsorújság mentése és visszatöltése.
 *
 * MIÉRT KELL (2.5.166, #32–#37 naplók): a 62 MB-os XMLTV letöltése a TV-n
 * ~4 perc, és a régi kód minden indulásnál elölről kezdte. Így ha a néző
 * közben kilépett vagy a letöltés megszakadt, az EPG SOHA nem jelent meg.
 *
 * A mentett alak tömör: csatornánként legfeljebb 14 műsor [kezdés, vég, cím].
 * 233 csatornánál ez néhány tíz kB, a teljes (40 ezer csatornás) indexnél is
 * néhány MB – belefér a tartós tárba, és gyorsan visszatölthető.
 */
const GUIDE_IDB_PREFIX = 'epg-guide-v1-';
/** Ennél nagyobb mentést nem írunk ki (a tár ne teljen meg feleslegesen). */
const GUIDE_IDB_MAX_CHARS = 6 * 1024 * 1024;
/** Ha `clearGuide()` volt, a következő letöltés ne a régi mentésből induljon. */
let skipRestore = false;

interface PersistedGuideMeta {
  providerId: string;
  savedAt: number;
  channels: number;
  programmes: number;
  bytes: number;
  chunks: number;
  /**
   * Végigfutott-e a letöltés (nem szakadt meg). A #38–#42 naplók tanulsága:
   * egy RÉSZLEGES mentés is „frissnek” számított, és 3 órán át megakadályozta
   * a valódi letöltést – így a néző minden indulásnál ugyanazt a néhány
   * tucat műsort látta (vagy semmit).
   */
  complete?: boolean;
}

/**
 * Ennyi műsor kell csatornánként ahhoz, hogy a mentett példány használhatónak
 * számítson. Enélkül (pl. 96 csatorna / 103 műsor) a mentés csak a felület
 * azonnali feltöltésére jó, a frissítés VISZONT elindul.
 */
const USABLE_PROGRAMMES_PER_CHANNEL = 2;

function guideChunkKey(providerId: string, index: number): string {
  return `${GUIDE_IDB_PREFIX}${providerId}-${index}`;
}

function guideMetaKey(providerId: string): string {
  return `${GUIDE_IDB_PREFIX}${providerId}-meta`;
}

/** A memóriabeli index tömör, JSON-ba írható alakja. */
function serializeGuide(): string[] {
  const rows: string[] = [];
  let chars = 0;
  index.forEach((list, channel) => {
    if (!list.length) return;
    const row = JSON.stringify([channel, list.map((entry) => [entry.s, entry.e, entry.t])]);
    chars += row.length;
    if (chars > GUIDE_IDB_MAX_CHARS) return;
    rows.push(row);
  });
  return rows;
}

async function persistGuide(providerId: string, complete: boolean): Promise<void> {
  try {
    const store = await openIdbStore();
    if (!store) return;
    const rows = serializeGuide();
    if (!rows.length) return;
    const chunkSize = 200;
    let chunks = 0;
    let programmes = 0;
    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const part = rows.slice(offset, offset + chunkSize);
      const ok = await store.put(guideChunkKey(providerId, chunks), part.join('\n'));
      if (!ok) return;
      chunks += 1;
    }
    index.forEach((list) => { programmes += list.length; });
    const meta: PersistedGuideMeta = {
      providerId,
      savedAt: Date.now(),
      channels: index.size,
      programmes,
      bytes: lastBytes,
      chunks,
      complete,
    };
    // A fejléc MINDIG utolsóként íródik: félkész mentést soha nem olvasunk be.
    await store.put(guideMetaKey(providerId), JSON.stringify(meta));
    appLog(
      `EPG: a műsorújság elmentve a tartós tárba (${meta.channels} csatorna, `
      + `${meta.programmes} műsor, ${chunks} adag${complete ? '' : ', RÉSZLEGES'}); a következő `
      + `${complete ? 'indulás ebből indul' : 'indulás ezt ismét frissíti'}.`
    );
  } catch {
    // A mentés hibája nem akadály: a következő indulás egyszerűen letölti.
  }
}

async function restorePersistedGuide(
  providerId: string,
): Promise<{ savedAt: number; channels: number; programmes: number; bytes: number; complete: boolean } | null> {
  try {
    const store = await openIdbStore();
    if (!store) return null;
    const rawMeta = await store.get(guideMetaKey(providerId));
    if (!rawMeta) return null;
    const meta = JSON.parse(rawMeta) as PersistedGuideMeta;
    if (!meta || meta.providerId !== providerId || !meta.chunks) return null;
    let restored = 0;
    for (let chunk = 0; chunk < meta.chunks; chunk++) {
      const raw = await store.get(guideChunkKey(providerId, chunk));
      if (!raw) return null;
      for (const line of raw.split('\n')) {
        if (!line) continue;
        const [channel, entries] = JSON.parse(line) as [string, Array<[number, number, string]>];
        if (!channel || !Array.isArray(entries) || !entries.length) continue;
        index.set(channel, entries.map(([start, end, title]) => ({ s: start, e: end, t: title })));
        restored += 1;
      }
    }
    if (!restored) return null;
    // A visszatöltött index is átesik a tisztításon (lejárt műsorok kidobása).
    finishParsing();
    return {
      savedAt: meta.savedAt,
      channels: index.size,
      programmes: meta.programmes,
      bytes: meta.bytes,
      complete: meta.complete === true,
    };
  } catch {
    return null;
  }
}

async function clearPersistedGuide(): Promise<void> {
  try {
    const store = await openIdbStore();
    if (!store) return;
    const keys = await store.keys();
    for (const key of keys) {
      if (key.startsWith(GUIDE_IDB_PREFIX)) await store.remove(key);
    }
  } catch {
    // A törlés hibája nem akadály: a következő mentés felülírja.
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
export async function ensureGuide(provider: {
  id: string;
  type?: string;
  serverUrl?: string;
  username?: string;
  password?: string;
} | null): Promise<void> {
  if (!provider || provider.type !== 'xtream' || !provider.serverUrl || !provider.username || !provider.password) {
    return;
  }
  /*
   * „FRISS” CSAK A HASZNÁLHATÓ MŰSORÚJSÁG.
   *
   * A puszta `index.size > 0` feltétel miatt egy 96 csatornás, 103 műsoros
   * maradék 3 órán át frissnek számított (#38–#42 naplók): a valódi letöltés
   * el sem indult, a sárga csík pedig üres maradt.
   */
  const usable = statKept >= index.size * USABLE_PROGRAMMES_PER_CHANNEL;
  const fresh = loadedProviderId === provider.id && index.size > 0 && usable
    && Date.now() - loadedAt < GUIDE_TTL_MS;
  if (fresh) return;
  if (loading) return loading;
  if (breakerOpen()) {
    appLog(`EPG: a megszakító nyitva van (${Math.ceil(breakerRemainingMs() / 1000)} mp) – a műsorújság később töltődik be.`);
    return;
  }

  const startedAt = Date.now();
  index.clear();
  nameToId.clear();
  buffer = '';
  lastProgrammes = 0;
  lastSkipped = 0;
  lastBytes = 0;
  lastError = '';
  statInvalidDate = 0;
  statNoTitle = 0;
  statCap = 0;
  statKept = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  windowStart = nowSec - KEEP_BEFORE_SEC;
  windowEnd = nowSec + KEEP_AFTER_SEC;

  /*
   * TARTÓS GYORSÍTÓTÁR (2.5.166) – EZ A LEGFONTOSABB JAVÍTÁS AZ EPG-RE.
   *
   * A #32–#37 naplók: a 62 MB-os műsorújság letöltése ~4 perc, és a TV-n ez
   * minden indulásnál újra kezdődött – ha közben bármi megszakította, a néző
   * SOHA nem látott műsort. Most a kész (vagy részben kész) index a tartós
   * tárba kerül, és a következő induláskor AZONNAL onnan töltődik be: a
   * sárga csík már a főoldal megjelenésekor ott van, a frissítés pedig a
   * háttérben, észrevétlenül fut.
   */
  const restored = skipRestore ? false : await restorePersistedGuide(provider.id);
  skipRestore = false;
  if (restored) {
    loadedAt = restored.savedAt;
    loadedProviderId = provider.id;
    lastProgrammes = restored.programmes;
    lastBytes = restored.bytes;
    statKept = statKept || restored.programmes;
    appLog(
      `EPG: a műsorújság a tartós tárból betöltve – ${restored.channels} csatorna, `
      + `${restored.programmes} műsor (mentve: ${new Date(restored.savedAt).toLocaleTimeString('hu-HU')}` +
      `${restored.complete ? '' : ', RÉSZLEGES'}).`
    );
    /*
     * CSAK a TELJES és ELÉG SŰRŰ mentés számít frissnek. A részleges mentés
     * azonnal megjelenik a felületen (ezért jó, hogy van), de a frissítés
     * elindul – különben a hiányos műsorújság órákig „érvényes” maradna.
     */
    const thick = restored.channels > 0
      && restored.programmes >= restored.channels * USABLE_PROGRAMMES_PER_CHANNEL;
    if (restored.complete && thick && Date.now() - restored.savedAt < GUIDE_TTL_MS) return;
    appLog(
      'EPG: a mentett műsorújság '
      + `${!restored.complete ? 'részleges' : (!thick ? 'túl kevés műsort tartalmaz' : 'lejárt')} `
      + '– a háttérben frissítjük, a már látható műsorok addig is megmaradnak.'
    );
  }

  appLog('EPG: a teljes műsorújság (XMLTV) letöltése indul – a rövid EPG végpont ezen a panelen üres választ ad.');

  loading = download(provider)
    .then(() => {
      loadedAt = Date.now();
      loadedProviderId = provider.id;
      const channels = index.size;
      const partial = abortReason ? ` (részleges: ${abortReason})` : '';
      appLog(
        `EPG: műsorújság betöltve ${((Date.now() - startedAt) / 1000).toFixed(1)} mp alatt – `
        + `${channels} csatorna, ${statKept} megtartott műsor `
        + `(a ${lastProgrammes} feldolgozott blokkból ${lastSkipped} időablakon kívüli, `
        + `${statInvalidDate} érvénytelen időpont, ${statNoTitle} cím nélküli, `
        + `${statCap} korlát miatt kihagyott), ${(lastBytes / 1024).toFixed(0)} KB${partial}.`
      );
      if (channels > 0) void persistGuide(provider.id, !abortReason);
      if (channels === 0) {
        appLog('EPG: a szolgáltató műsorújságja üres – a felület a rövid EPG-t használja tartalékként.');
      }
    })
    .catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      const aborted = /abort/i.test(lastError);
      /*
       * A MEGSZAKÍTÁS OKA IS A NAPLÓBA KERÜL. A #32 és #37 naplóban csak
       * ennyi állt: „AbortError: BodyStreamBuffer was aborted” – ebből nem
       * derült ki, hogy a 90 mp-es korlát vagy a 64 MB-os plafon szakított-e.
       */
      if (aborted) {
        appLog(
          `EPG: a műsorújság letöltése megszakadt – ${abortReason || 'a böngésző szakította meg'}; `
          + `a már beolvasott rész: ${index.size} csatorna, ${lastBytes ? (lastBytes / 1048576).toFixed(1) + ' MB' : 'nincs adat'}.`
        );
      }
      appLogError(`EPG műsorújság${aborted ? ' (megszakítva)' : ''}`, error);
      // Ami összejött, az maradjon használható a következő indulásig is –
      // de RÉSZLEGES jelöléssel, hogy a következő indulás frissítsen.
      if (index.size > 0) void persistGuide(provider.id, false);
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
export function guideStatus(): {
  channels: number;
  loadedAt: number;
  providerId: string;
  error: string;
  bytes: number;
  programmes: number;
  skipped: number;
} {
  return {
    channels: index.size,
    loadedAt,
    providerId: loadedProviderId,
    error: lastError,
    bytes: lastBytes,
    programmes: statKept || lastProgrammes,
    skipped: lastSkipped,
  };
}

/**
 * Szolgáltatóváltáskor / frissítéskor a régi műsorújság eldobása.
 *
 * A tartós mentést is töröljük (különben a régi szolgáltató műsora jelenne meg
 * az újnál), és a következő letöltés nem a mentésből indul.
 */
export function clearGuide(): void {
  index.clear();
  nameToId.clear();
  buffer = '';
  loadedAt = 0;
  loadedProviderId = '';
  lastProgrammes = 0;
  lastSkipped = 0;
  lastBytes = 0;
  skipRestore = true;
  void clearPersistedGuide();
}
