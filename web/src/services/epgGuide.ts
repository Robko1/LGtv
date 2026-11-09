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
import { EpgNowNext, getCachedShortEpg, loadSimpleEpg, nowNextFromEpg, streamIdFor } from './epgService';
import { getHuEpgIds, HU_EPG_IDS } from './huEpgIds';
import { openIdbStore } from './idbStore';
import { xtreamService } from './xtreamService';
import { formatBudapestTime, parseBroadcastTime } from '../utils/broadcastTime';

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
/*
 * 2.5.266 (#13-as napló): ha egy letöltés 0 csatornát hozott (a panel üres
 * XMLTV-t küld), nem rohanunk rá újra perceken belül – a #13-as naplóban a
 * kétszeres indulás után még egy teljes kör lefutott, és a sok kérés miatt a
 * panel 429-cel (Too Many Requests) válaszolt. A 30 perces időzítő így is
 * frissít később, csak a felesleges ismétléseket vágjuk le.
 */
let lastEmptyGuideAt = 0;
const EMPTY_GUIDE_COOLDOWN_MS = 5 * 60 * 1000;
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
const guideUpdateListeners: Array<() => void> = [];

function notifyGuideListeners(): void {
  for (let i = 0; i < guideUpdateListeners.length; i += 1) {
    try {
      guideUpdateListeners[i]?.();
    } catch {
      /* ignore listener errors */
    }
  }
}

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
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  // A teljes értelmezés (időzónával vagy anélkül) a közös segédfüggvényben van.
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return 0;
  /*
   * 2.5.297: ha az XMLTV-ben NINCS időzóna (a legtöbb magyar panel így adja:
   * „20261104020000”), az az adás MAGYAR ideje. Korábban ilyenkor UTC-nek
   * vettük, ezért a magyar műsorújság a nem magyar időzónában élő nézőnél
   * (pl. Írország, UTC+0) egy órával csúszott, és a „most” a lejárt műsort
   * mutatta. Az időzóna megadását továbbra is tiszteletben tartjuk.
   */
  return parseBroadcastTime(text);
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

/**
 * 2.5.270 (#3-as napló): az iptv-org stílusú azonosítók („Viasat2.hu@SD”)
 * „@…” utótagját levágjuk – a felület így a csupasz „viasat2.hu” alapján is
 * megtalálja a műsort.
 */
function channelIdBase(id: string): string {
  const at = id.indexOf('@');
  return at > 0 ? id.slice(0, at) : id;
}

/*
 * 2.5.279 (#20/#21-es napló): CSAK MAGYAR (HU) CSATORNÁK műsorújsága.
 * A teljes (minden országos) szolgáltatói XML feldolgozása és tárolása
 * feleslegesen lassította a TV-t (10–50 MB tároló, főszál-leállások
 * csatornaváltás közben) – a magyar fő menühöz csak a magyar adók kellenek.
 * Ezért a feldolgozásnál (consumeBlock) és a visszatöltésnél is csak a
 * magyar csatornákat vesszük figyelembe; a letöltés pedig korán megáll,
 * amint elég magyar csatorna érkezett.
 */
/** A beépített HU táblából (huEpgIds.ts) levezetett, kisbetűs HU azonosítók. */
const HU_GUIDE_ID_SET: Set<string> = (() => {
  const set = new Set<string>();
  for (const rawId of Object.values(HU_EPG_IDS)) {
    const low = String(rawId).toLowerCase();
    set.add(low);
    set.add(channelIdBase(low));
  }
  return set;
})();
/** A beépített HU táblából levezetett, normalizált magyar csatornanevek. */
const HU_GUIDE_NAME_SET: Set<string> = new Set(Object.keys(HU_EPG_IDS));
/** A már feldolgozott <channel> blokkok közül a MAGYAR csatornák azonosítói. */
const huChannelIdSet = new Set<string>();
let huProbeChannels: Array<{ name?: string; epgChannelId?: string | null; countryCode?: string }> = [];
const huTargetNameSet = new Set<string>();
const huTargetIdSet = new Set<string>();
/** Kiválasztott külföldi ország célcsatornái; a HU feldolgozási útvonal ettől független. */
let activeCountryEpgTarget: { code: string; ids: Set<string>; names: Set<string>; acceptedIds: Set<string>; cancelled: boolean } | null = null;
let countryGuideGeneration = 0;
let activeCountryDownloadController: AbortController | null = null;
/** Nem magyar blokkok száma az aktuális feldolgozásban (naplóhoz). */
let lastSkippedNonHu = 0;
/** Ennyi magyar csatorna után a letöltést korán megállítjuk (lásd download()). */
const HU_ENOUGH_CHANNELS = 110; // csak akkor tartalék, ha nincs megadva tényleges HU csatornalista
/** Egy XMLTV csatornaazonosító magyar (HU)-e? */
function isHuGuideChannelId(rawId: string): boolean {
  const base = channelIdBase(rawId).toLowerCase();
  if (!base) return false;
  // Ha ismerjük a TV tényleges 81 (vagy aktuális számú) HU csatornáját,
  // a cache-ből is kizárólag ezek XMLTV-azonosítóit engedjük vissza.
  if (huProbeChannels.length > 0) {
    if (huTargetIdSet.has(base)) return true;
    for (const [name, mappedId] of nameToId.entries()) {
      if (huTargetNameSet.has(name) && channelIdBase(mappedId).toLowerCase() === base) return true;
    }
    return false;
  }
  if (base.endsWith('.hu')) return true;
  if (HU_GUIDE_ID_SET.has(base)) return true;
  return huChannelIdSet.has(base);
}

/** Egy kész blokk feldolgozása (`<programme …>…</programme>` vagy `<channel …>`). */
function consumeBlock(kind: string, attrs: string, body: string): void {
  if (activeCountryEpgTarget?.cancelled) return;
  if (kind === 'channel') {
    const info = attributeMap(attrs);
    const id = (info.id || '').trim();
    if (!id) return;
    const nameMatch = /<display-name[^>]*>([\s\S]*?)<\/display-name>/i.exec(body);
    const key = nameMatch ? normalizeName(decodeEntities(nameMatch[1])) : '';
    /* 2.5.270 (#3): „@SD”/„@HD” utótag levágása az azonosítóból (iptv-org stílus). */
    const baseId = channelIdBase(id).toLowerCase();
    if (activeCountryEpgTarget) {
      const target = activeCountryEpgTarget;
      if (!target.ids.has(baseId) && !(key && target.names.has(key))) {
        lastSkippedNonHu += 1;
        return;
      }
      target.acceptedIds.add(baseId);
      if (key && !nameToId.has(key)) nameToId.set(key, baseId);
      return;
    }
    /* A főoldali magyar készlet az egyetlen cél: idegen, de .hu végű
       XMLTV-adó sem kerülhet a 81 csatornás EPG-tárba. */
    const targetMatch = huProbeChannels.length > 0
      ? (huTargetIdSet.has(baseId) || Boolean(key && huTargetNameSet.has(key)))
      : (isHuGuideChannelId(id) || Boolean(key && HU_GUIDE_NAME_SET.has(key)));
    if (!targetMatch) {
      lastSkippedNonHu += 1;
      return;
    }
    huChannelIdSet.add(baseId);
    if (key && !nameToId.has(key)) nameToId.set(key, baseId);
    return;
  }

  const info = attributeMap(attrs);
  /* 2.5.270 (#3): „@…” utótag levágása – „Viasat2.hu@SD” → „viasat2.hu”. */
  const channel = channelIdBase((info.channel || '').trim()).toLowerCase();
  if (!channel) return;
  if (activeCountryEpgTarget) {
    if (!activeCountryEpgTarget.acceptedIds.has(channel)) {
      lastSkippedNonHu += 1;
      return;
    }
  } else if (!isHuGuideChannelId(channel)) {
    /* A magyar EPG eredeti szűrése változatlan marad. */
    lastSkippedNonHu += 1;
    return;
  }
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
        `EPG-ÁLLAPOT: érvénytelen időpont a műsorújságban – kezdés=„${String(info.start || '').slice(0, 32)}”, `
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

/*
 * 2.5.278 (#18-as napló): INKREMENTÁLIS FELDOLGOZÁS – a #18-as naplóban egy
 * 10 MB-os, majd egy 20 MB-os műsorújság feldolgozása közben LEÁLLÁS 3099/2758
 * ms volt: korábban MINDEN beérkező blokkra újra végigfutott a zárójel-keresés
 * a TELJES pufferen (akár 8 MB), ami 20 MB-nál önmagában több másodperc.
 * Most csak az új szöveget + egy blokknyi átfedést nézzük (scannedUpTo), és a
 * kész blokkokat HELYBEN dolgozzuk fel, egyetlen slice erejéig a végén.
 */
const MAX_BLOCK_CHARS = 512 * 1024;
/** Meddig kerestünk már zárójelet a pufferben (ne keressük újra). */
let scannedUpTo = 0;

/** A szövegdarab feldolgozása; csak a BEFEJEZETT blokkokat értelmezzük. */
function feed(text: string): void {
  if (!sliceStartedAt) sliceStartedAt = nowMs();
  buffer += text;
  // Memória-védelem: ha egyetlen blokk sem zárult le, ne nőjön korlátlanul.
  if (buffer.length > 4 * 1024 * 1024) {
    buffer = buffer.slice(-2 * MAX_BLOCK_CHARS);
    scannedUpTo = 0;
  }
  let lastComplete = -1;
  let lastLength = 0;
  const endRe = /<\/(programme|channel)>/gi;
  // 2.5.278: csak az új rész + egy blokknyi átfedés – NEM a teljes puffer.
  endRe.lastIndex = Math.max(0, scannedUpTo - MAX_BLOCK_CHARS);
  let endMatch = endRe.exec(buffer);
  while (endMatch) {
    lastComplete = endMatch.index;
    lastLength = endMatch[0].length;
    endMatch = endRe.exec(buffer);
  }
  scannedUpTo = buffer.length;
  if (lastComplete < 0) return;
  const limit = lastComplete + lastLength;

  const blockRe = /<(programme|channel)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match = blockRe.exec(buffer);
  let consumed = 0;
  while (match && match.index + match[0].length <= limit) {
    consumeBlock(match[1].toLowerCase(), match[2] || '', match[3] || '');
    consumed = match.index + match[0].length;
    blocksSinceYield += 1;
    const elapsed = nowMs() - sliceStartedAt;
    if (blocksSinceYield >= YIELD_EVERY_BLOCKS || elapsed >= YIELD_AFTER_MS) {
      blocksSinceYield = 0;
      // A feldolgozatlan maradék a pufferben marad (egyetlen slice).
      buffer = buffer.slice(consumed);
      scannedUpTo = 0;
      // Rövid szünet a hívónak: a nagy fájl így nem egyetlen hosszú
      // feladat, hanem sok apró lépés (a felület közben fest).
      yieldRequested = true;
      return;
    }
    match = blockRe.exec(buffer);
  }
  buffer = buffer.slice(consumed);
  scannedUpTo = 0;
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
   * Rendezés + duplikációszűrés + vágás: csak a mostani és a következő műsorok maradnak,
   * így több ezer csatornánál is néhány megabájt a memóriaigény (a TV-n ez a
   * különbség a folyamatos és a „megfagyó” felület között).
   */
  const nowSec = Math.floor(Date.now() / 1000) - KEEP_BEFORE_SEC;
  statKept = 0;
  index.forEach((list, channel) => {
    list.sort((a, b) => a.s - b.s);
    const deduped: GuideEntry[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      if (entry.e <= nowSec) continue;
      const prev = deduped.length > 0 ? deduped[deduped.length - 1] : null;
      if (prev && prev.s === entry.s && prev.e === entry.e && prev.t === entry.t) continue;
      deduped.push(entry);
      if (deduped.length >= KEEP_ENTRIES_PER_CHANNEL) break;
    }
    if (deduped.length) {
      index.set(channel, deduped);
      statKept += deduped.length;
    } else {
      index.delete(channel);
    }
  });
  buffer = '';
  scannedUpTo = 0; // 2.5.278
}

/*
 * 2.5.267 (#14-es kérés): NYILVÁNOS, mindig elérhető EPG (XMLTV) újságok.
 *
 * Ha a szolgáltató saját műsorújsága üres (a #13-as napló: a LOWEND panel
 * üres <tv></tv>-t küld, az M3U-ban sincs url-tvg), innen töltünk le egy
 * megbízható nyilvános forrást. Sorrend a kérés szerint: ELŐSZÖR az összes
 * ország egy fájlban (globális), aztán a MAGYAR (HU) külön fájlok (kicsik,
 * gyorsak – a listában pontosan annyi magyar adó van, ahány [HU] csatorna,
 * ezekhez a HU fájlok adják a műsort).
 *
 * A .gz végű fájlokat a letöltés közben DecompressionStream-mel bontjuk
 * (lásd download()); a github.io (iptv-org) és a legtöbb ilyen forrás
 * CORS-szempontból is engedi a böngészős lekérést (Access-Control-Allow-Origin: *).
 * Minden próba naplózva van (HTTP státusz + hogy hány csatorna lett belőle).
 * Tesztkörnyezetben (nincs window) a nyilvános források KI vannak kapcsolva,
 * hogy a tesztek hermetikusan a saját mock szerverüket használják.
 */
const PUBLIC_GUIDES_ENABLED = typeof window !== 'undefined';

const PUBLIC_GUIDE_URLS: Array<{
  url: string;
  label: string;
  /** 2.5.269 (#2): csak 'hu' – csak magyar csatornákra töltünk nyilvános EPG-t. */
  scope: 'global' | 'hu';
  limits: { maxBytes: number; maxMs: number };
}> = [
  // magyar csatornák külön (kicsi, gyors, kis tároló, teljes HU lefedettség)
  { url: 'https://epgshare01.online/epgshare01/epg_ripper_HU1.xml.gz', label: 'epgshare01 HU (magyar)', scope: 'hu', limits: { maxBytes: 32 * 1024 * 1024, maxMs: 3 * 60 * 1000 } },
  /*
   * 2.5.270 (#3-as napló): az iptv-org.github.io/epg/… útvonalak 2026-ban már
   * 404-et adnak (a #3-as naplóban mindkettő HTTP 404) – helyettük az iptv-org
   * magyar lista alapján készült, naponta kétszer frissülő magyar guide.xml
   * (GitHub Pages, sima XML, „@SD” azonosítók – levágjuk belőlük a „@…”-ot).
   */
  { url: 'https://aldork04.github.io/lgtv-epg/guide.xml', label: 'aldork04 lgtv-epg HU (iptv-org magyar lista)', scope: 'hu', limits: { maxBytes: 32 * 1024 * 1024, maxMs: 3 * 60 * 1000 } },
  { url: 'https://iptv-epg.org/files/epg-hu.xml.gz', label: 'iptv-epg.org HU', scope: 'hu', limits: { maxBytes: 32 * 1024 * 1024, maxMs: 3 * 60 * 1000 } },
];

/* ─────────────────────────────── letöltés ──────────────────────────────── */

function guideUrl(provider: { serverUrl?: string; username?: string; password?: string }): string {
  const base = xtreamService.baseUrl(provider.serverUrl || '');
  const user = encodeURIComponent(provider.username || '');
  const pass = encodeURIComponent(provider.password || '');
  return `${base}/xmltv.php?username=${user}&password=${pass}`;
}

/** A megszakítás oka (a naplóban ez a VALÓDI magyarázat). */
let abortReason = '';

async function download(
  provider: { serverUrl?: string; username?: string; password?: string },
  url: string = guideUrl(provider),
  label = 'xmltv.php',
  limits: { maxBytes?: number; maxMs?: number } = {},
): Promise<void> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (activeCountryEpgTarget && !activeCountryEpgTarget.cancelled) activeCountryDownloadController = controller;
  abortReason = '';
  // 2.5.267 (#14): a nyilvános forrásokhoz saját (kisebb) korlátok adhatók.
  const maxBytes = limits.maxBytes ?? MAX_BYTES;
  const maxMs = limits.maxMs ?? MAX_DOWNLOAD_MS;
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
      abortReason = `a letöltés elérte a ${Math.round(maxMs / 60000)} perces felső korlátot`;
      controller.abort();
    }, maxMs)
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
    /*
     * 2.5.259 (#9): a válasz státusza és fejlécei is a naplóba – így a
     * következő kézi naplóból pontosan látszik, hogy a panel mit válaszol
     * az xmltv.php címre (üres 200, átirányítás, 401 stb.).
     */
    appLog(
      `EPG-ÁLLAPOT: ${label} válasz – HTTP ${response.status}, content-type=${response.headers.get('content-type') || '?'}, `
      + `content-length=${response.headers.get('content-length') || '?'}, átirányítva=${response.redirected ? 'igen' : 'nem'}`
      + (response.redirected && response.url && response.url !== url ? `, végső cím=${response.url}` : '') + '.'
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    /*
     * 2.5.267 (#14): .gz végű nyilvános EPG fájlok (pl. epgshare01). A fetch
     * csak a Content-Encoding: gzip válaszokat bontja magától – a fájlban
     * tárolt .gz-t kézzel, DecompressionStream-mel kell kibontani olvasás közben.
     */
    const wantsGzip = /\.gz(?:[?#]|$)/i.test(url);
    if (wantsGzip && typeof DecompressionStream === 'undefined') {
      abortReason = 'a motor nem tud gzip fájlt bontani (nincs DecompressionStream)';
      appLog(`EPG-ÁLLAPOT: ${label} – .gz fájl, de ebben a motorban nincs DecompressionStream – kihagyva.`);
      return;
    }
    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
      if (wantsGzip) {
        // Régi motor + tömörített fájl: egyben olvasva nem értelmezhető.
        abortReason = 'a motor nem tud streamet és gzip-et sem kezelni';
        appLog(`EPG-ÁLLAPOT: ${label} – .gz fájl régi motoron, nincs stream olvasó – kihagyva.`);
        return;
      }
      // Régi motor: nincs stream, egyben olvassuk (ez már csak tartalék út).
      const text = await response.text();
      lastBytes = text.length;
      armIdle();
      // 2.5.261 (#10): kis/üres törzsnél kiírjuk az első karaktereket is – így a
      // naplóból látszik, hogy a panel mit válaszol pontosan (pl. üres 200).
      if (text.length < 8192) {
        appLog(`EPG-ÁLLAPOT: ${label} válasz törzse (${text.length} bájt): „${text.slice(0, 300).replace(/\s+/g, ' ')}”.`);
      }
      await feedWithBreath(text);
      finishParsing();
      return;
    }
    // 2.5.267 (#14): .gz fájl kibontása olvasás közben.
    const stream = wantsGzip ? body.pipeThrough(new DecompressionStream('gzip')) : body;
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let bytes = 0;
    let lastLoggedBytes = 0;
    let lastYield = Date.now();
    // 2.5.261 (#10): az első pár blokk szövege diagnózishoz (üres/kis válasznál log).
    let firstText = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      armIdle();
      bytes += value.byteLength;
      const chunkText = decoder.decode(value, { stream: true });
      if (firstText.length < 400) firstText += chunkText;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch { /* már lezárult */ }
        abortReason = `a műsorújság nagyobb, mint ${Math.round(maxBytes / 1048576)} MB`;
        appLog(`EPG-ÁLLAPOT: ${abortReason} – a további részt nem olvassuk, a MÁR beolvasott rész használható.`);
        break;
      }
      await feedWithBreath(chunkText);
      /*
       * 2.5.279 (#20/#21): ha már elég MAGYAR csatorna érkezett, a letöltést
       * itt megállítjuk – a többi ország műsorújsága csak letöltési időt és
       * tárolót foglalna, nekünk nem kell.
       */
      const expectedHuChannels = huProbeChannels.length || HU_ENOUGH_CHANNELS;
      if (!activeCountryEpgTarget && huChannelIdSet.size >= expectedHuChannels && lastSkippedNonHu >= 4 * huChannelIdSet.size) {
        try { await reader.cancel(); } catch { /* már lezárult */ }
        abortReason = `elég magyar csatorna (${huChannelIdSet.size} db) – a többi ország kihagyva`;
        appLog(`EPG-ÁLLAPOT: ${abortReason}; a letöltés ${(bytes / 1048576).toFixed(1)} MB-nál megáll, a már beolvasott rész használható.`);
        break;
      }
      // LÉLEGZÉS: 250 ms-onként visszaadjuk a főszálat, hogy a felület fusson.
      if (Date.now() - lastYield > 250) {
        lastYield = Date.now();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      // Haladásjelzés a naplóba (10 MB-onként) + a felület értesítése, hogy a már
      // beolvasott csatornák sárga műsorsora azonnal megjelenjen letöltés közben is!
      if (bytes - lastLoggedBytes >= 10 * 1024 * 1024) {
        lastLoggedBytes = bytes;
        notifyGuideListeners();
        appLog(
          `EPG-ÁLLAPOT: műsorújság olvasása – ${(bytes / 1048576).toFixed(0)} MB, `
          + `${index.size} csatorna, ${lastProgrammes} műsor a keresett időablakban.`
        );
      }
    }
    lastBytes = bytes;
    // 2.5.261 (#10): kis/üres törzsnél a naplóba az első karakterek is – így
    // pontosan látszik, mit válaszol a panel (pl. „0 bájt” vs. üres XML burok).
    if (bytes < 8192 && firstText) {
      appLog(`EPG-ÁLLAPOT: ${label} válasz törzse (${bytes} bájt): „${firstText.slice(0, 300).replace(/\s+/g, ' ')}”.`);
    }
  } finally {
    if (activeCountryDownloadController === controller) activeCountryDownloadController = null;
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

/*
 * 2.5.261 (#10-es napló): URL-TVG KERESÉSE AZ M3U LISTÁBAN (get.php).
 *
 * A #10-es napló: ezen a panelen az xmltv.php ÜRES 200-at ad (0 bájt), ezért a
 * teljes műsorújság soha nem töltődik be, és a get_simple_data_table is üres.
 * Sok Xtream panel viszont a get.php M3U listájának elején hirdeti meg az igazi
 * XMLTV címét (`#EXTM3U url-tvg="…"`). Itt letöltjük az M3U lista elejét
 * (az első ~64 KB bőven elég, a url-tvg mindig a fejlécben van – 2.5.275), és abból
 * olvassuk ki az XMLTV címet – onnan már a download() a szokásos módon tölti.
 */
/** url-tvg érték kinyerése egy M3U fejléc-szövegből (&amp; visszaalakítással). */
function matchUrlTvg(text: string): string | null {
  const match = text.match(/url-tvg\s*=\s*"([^"]+)"/i)
    || text.match(/url-tvg\s*=\s*'([^']+)'/i)
    || text.match(/url-tvg\s*=\s*([^\s"'>]+)/i);
  // M3U-ban a &amp; alak is előfordulhat a lekérdező paraméterekben.
  return match ? match[1].replace(/&amp;/g, '&') : null;
}

/*
 * 2.5.264 (#11-es napló): egy M3U változat elejének beolvasása és url-tvg
 * keresése benne – AKKOR IS, ha a HTTP státusz nem 200 (a #11 naplóban a
 * get.php HTTP 884 text/html választ adott; ettől a törzsben még lehet
 * url-tvg). Minden próba státusza és a törzs eleje a naplóba kerül.
 */
async function scanM3uForUrlTvg(m3uUrl: string, variantLabel: string): Promise<string | null> {
  try {
    appLog(`EPG-ÁLLAPOT: url-tvg keresése az M3U lista (${variantLabel}) elején indul – az xmltv.php üres választ adott.`);
    const response = await fetch(m3uUrl, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
    });
    appLog(
      `EPG-ÁLLAPOT: M3U lista (${variantLabel}) válasz – HTTP ${response.status}, `
      + `content-type=${response.headers.get('content-type') || '?'}, átirányítva=${response.redirected ? 'igen' : 'nem'}.`
    );
    let text = '';
    let bytes = 0;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
        const match = matchUrlTvg(text);
        if (match) {
          try { await reader.cancel(); } catch { /* már lezárult */ }
          return match;
        }
        /*
         * 2.5.275 (#11-es napló): a url-tvg mindig a #EXTM3U fejlécben van, az
         * első pár KB-ben – 64 KB után már felesleges tovább olvasni (és minden
         * blokk után újra regexelni a teljes eddigi szöveget a főszálon).
         */
        if (bytes >= 64 * 1024) {
          try { await reader.cancel(); } catch { /* már lezárult */ }
          break;
        }
      }
    } else {
      // Régi motor: nincs stream, egyben olvassuk.
      text = await response.text();
      bytes = text.length;
      const match = matchUrlTvg(text.slice(0, 64 * 1024));
      if (match) return match;
    }
    appLog(
      `EPG-ÁLLAPOT: az M3U lista (${variantLabel}) ${bytes >= 64 * 1024 ? `első ${(bytes / 1024).toFixed(0)} KB-jában` : `(${bytes} bájt, teljes)`} NINCS url-tvg – `
      + `első 200 karakter: „${text.slice(0, 200).replace(/\s+/g, ' ')}”.`
    );
    return null;
  } catch (error) {
    appLog(`EPG-ÁLLAPOT: url-tvg keresése az M3U listában (${variantLabel}) sikertelen – ${error instanceof Error ? error.message : String(error)}.`);
    return null;
  }
}

async function discoverUrlTvg(
  provider: { serverUrl?: string; username?: string; password?: string },
  isM3u = false,
): Promise<string | null> {
  /*
   * 2.5.265 (#12-es napló): m3u provider esetén a serverUrl MAGA az M3U
   * lista – ebben keressük az url-tvg-t (nincs get.php).
   */
  if (isM3u) {
    return await scanM3uForUrlTvg(provider.serverUrl || '', 'm3u lista (provider.serverUrl)');
  }
  const m3uUrl = xtreamService.buildPlaylistUrl(provider.serverUrl || '', provider.username || '', provider.password || '');
  const found = await scanM3uForUrlTvg(m3uUrl, 'get.php type=m3u_plus&output=ts');
  if (found) return found;
  /*
   * 2.5.264 (#11): egyes panelek csak a sima `type=m3u` listában hirdetik
   * az url-tvg-t – ezt is kipróbáljuk.
   */
  const plainUrl = m3uUrl.replace(/type=m3u_plus&output=ts/i, 'type=m3u');
  if (plainUrl !== m3uUrl) return await scanM3uForUrlTvg(plainUrl, 'get.php type=m3u');
  return null;
}

/*
 * 2.5.264 (#11-es napló): jelölt XMLTV útvonalak próbája a panel ALAP címén.
 * A #11 naplóban az xmltv.php üres <tv> burok, a get.php pedig HTTP 884 – de a
 * panel alap címe alatt sok esetben egy másik útvonalon él a valódi műsorújság
 * (/epg.xml, /guide.xml, /xmltv.xml). Mindegyik próba HTTP státusza és a törzs
 * első karakterei a naplóba kerülnek, így a következő naplóból pontosan látszik,
 * melyik útvonal mit válaszol.
 */
async function discoverXmltvCandidates(
  provider: { serverUrl?: string; username?: string; password?: string },
  isM3u = false,
): Promise<string | null> {
  let base = '';
  let listDir = '';
  if (isM3u) {
    /*
     * 2.5.265 (#12): m3u esetén a jelölt XMLTV útvonalakat a lista
     * KÖNYVTÁRÁBAN (pl. …/live/user/pass/epg.xml) és a szerver gyökerében
     * próbáljuk, hitelesítő paraméterek nélkül.
     */
    const serverUrl = provider.serverUrl || '';
    try {
      base = new URL(serverUrl).origin;
    } catch {
      base = serverUrl;
    }
    listDir = serverUrl.slice(0, serverUrl.lastIndexOf('/') + 1);
  } else {
    base = xtreamService.baseUrl(provider.serverUrl || '');
  }
  const user = encodeURIComponent(provider.username || '');
  const pass = encodeURIComponent(provider.password || '');
  const cred = isM3u ? '' : `?username=${user}&password=${pass}`;
  const probes: Array<{ url: string; label: string }> = [];
  if (isM3u && listDir && listDir !== base) {
    for (const name of ['epg.xml', 'guide.xml', 'xmltv.xml']) {
      probes.push({ url: `${listDir}${name}`, label: `lista könyvtára: ${listDir}${name}` });
    }
  }
  for (const path of ['/epg.xml', '/guide.xml', '/xmltv.xml']) {
    probes.push({ url: `${base}${path}${cred}`, label: `${base}${path}${isM3u ? '' : ' (hitelesítéssel)'}` });
  }
  for (const probe of probes) {
    const url = probe.url;
    const path = probe.label;
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 10_000) : null;
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      let text = '';
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          bytes += value.byteLength;
          text += decoder.decode(value, { stream: true });
          if (bytes >= 64 * 1024) {
            try { await reader.cancel(); } catch { /* már lezárult */ }
            break;
          }
        }
      } else {
        text = await response.text();
      }
      const looksXmltv = /<tv[\s>]/i.test(text) && /<channel[\s>]/i.test(text);
      appLog(
        `EPG-ÁLLAPOT: jelölt XMLTV próba ${path} – HTTP ${response.status}, `
        + `content-type=${response.headers.get('content-type') || '?'}, beolvasva=${text.length} bájt; `
        + `első 120 karakter: „${text.slice(0, 120).replace(/\s+/g, ' ')}”`
        + `${looksXmltv ? ' – XMLTV-nek látszik.' : '.'}`
      );
      if (response.ok && looksXmltv) return url;
    } catch (error) {
      appLog(`EPG-ÁLLAPOT: jelölt XMLTV próba ${path} – kérés hiba: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
  return null;
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
/*
 * 2.5.338 (HU külön EPG): a magyar (countryCode=HU) csatornák műsorújsága
 * KÜLÖN, SAJÁT tárolóból jön – nem a szolgáltató xmltv.php / get_short_epg /
 * get_simple_data_table végpontjából. A HU EPG-t kizárólag a beépített
 * nyilvános HU forrásokból töltjük (epgshare01 HU1, aldork04 lgtv-epg,
 * iptv-epg.org HU), és CSAK HU csatornákra. A szolgáltató EPG-jével nem
 * keverjük, és IPK-újraindításkor nem töltjük újra, csak a beállított
 * frissítési idő (12 óra / 12 órás ablak) szerint.
 */
const HU_GUIDE_IDB_PREFIX = 'epg-hu-guide-v2-';
// A nyilvános magyar EPG nem szolgáltatófüggő: ugyanaz a tartós tár minden providerhez.
const HU_GUIDE_STORAGE_ID = 'public-hu';
const HU_GUIDE_TTL_MS = 12 * 60 * 60 * 1000;
const HU_GUIDE_IDB_MAX_CHARS = GUIDE_IDB_MAX_CHARS;
/*
 * 2.5.275 (#11-es napló): „a panel EPG végpontjai üresek" jelző. Ha egy teljes
 * próba után az xmltv.php üres volt és a get.php M3U-ban sincs url-tvg (és a
 * jelölt /epg.xml, /guide.xml, /xmltv.xml útvonalak is üresek/404-esek), ezt
 * elmentjük – így a KÉSŐBBI frissítések (30 percenként) már NEM töltenek le
 * újra több MB-os M3U-t és nem próbálják újra a jelölt útvonalakat, hanem
 * egyenesen a nyilvános HU újságokhoz mennek. 24 óra után újra próbáljuk
 * (hátha a panel közben beállította az EPG-t).
 */
const PANEL_EMPTY_TTL_MS = 24 * 60 * 60 * 1000;

function panelEmptyKey(providerId: string): string {
  return `${GUIDE_IDB_PREFIX}${providerId}-panel-empty`;
}

async function readPanelEmptyAt(providerId: string): Promise<number> {
  try {
    const store = await openIdbStore();
    if (!store) return 0;
    const raw = await store.get(panelEmptyKey(providerId));
    const value = raw ? Number(JSON.parse(String(raw))) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function writePanelEmpty(providerId: string): Promise<void> {
  try {
    const store = await openIdbStore();
    if (!store) return;
    await store.put(panelEmptyKey(providerId), JSON.stringify(Date.now()));
  } catch {
    /* a jelző írásának hibája nem akadály */
  }
}
/** Ha `clearGuide()` volt, a következő letöltés ne a régi mentésből induljon. */
let skipRestore = false;
/* 2.5.269 (#2): true, ha az induláskor visszatöltött újság RÉSZLEGES volt –
   ilyenkor a per-csatornás tartalék is futhat (lásd ensureChannelsEpg). */
let restoredPartial = false;

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
  /**
   * 2.5.297: milyen időzóna-értelmezéssel készült a mentés. A régi (készülék
   * helyi idejét használó) mentések időbélyegei eltolódtak, ezért azokat nem
   * használjuk fel: egyszer újratöltjük a műsorújságot magyar időben.
   */
  timeMode?: string;
  /** A HU gyorsítótár csak az adott TV tényleges HU csatornakészletéhez érvényes. */
  targetFingerprint?: string;
}

/** A jelenlegi műsoridő-értelmezés azonosítója (magyar idő). */
const GUIDE_TIME_MODE = 'hu-budapest-1';

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

function guideNamesKey(providerId: string): string {
  return `${GUIDE_IDB_PREFIX}${providerId}-names`;
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

function serializeNameMap(): string {
  const pairs: Array<[string, string]> = [];
  let chars = 0;
  nameToId.forEach((targetId, normName) => {
    if (!normName || !targetId || !index.has(targetId)) return;
    chars += normName.length + targetId.length + 8;
    if (chars > 1536 * 1024) return;
    pairs.push([normName, targetId]);
  });
  return JSON.stringify(pairs);
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
    // A név -> XMLTV csatornaazonosító térképet is elmentjük, különben a tartós
    // tárból való visszatöltés után az epg_channel_id nélküli csatornákhoz
    // nem találna műsort a felület!
    await store.put(guideNamesKey(providerId), serializeNameMap());
    index.forEach((list) => { programmes += list.length; });
    const meta: PersistedGuideMeta = {
      providerId,
      savedAt: Date.now(),
      channels: index.size,
      programmes,
      bytes: lastBytes,
      chunks,
      complete,
      timeMode: GUIDE_TIME_MODE,
    };
    // A fejléc MINDIG utolsóként íródik: félkész mentést soha nem olvasunk be.
    await store.put(guideMetaKey(providerId), JSON.stringify(meta));
    appLog(
      `EPG-ÁLLAPOT: a műsorújság elmentve a tartós tárba (${meta.channels} csatorna, `
      + `${meta.programmes} műsor, ${nameToId.size} név-azonosító, ${chunks} adag${complete ? '' : ', RÉSZLEGES'}); a következő `
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
    if (!meta || meta.providerId !== HU_GUIDE_STORAGE_ID || !meta.chunks) return null;
    if (meta.timeMode !== GUIDE_TIME_MODE) {
      appLog(
        'EPG-ÁLLAPOT: a mentett műsorújság régi időzóna-kezeléssel készült (a műsoridők csúsztak), '
        + 'ezért egyszer újratöltjük magyar időben.',
      );
      return null;
    }
    if (huProbeChannels.length > 0 && meta.targetFingerprint !== currentHuTargetFingerprint()) {
      appLog('EPG-ÁLLAPOT (HU külön): a mentett EPG másik magyar csatornakészlethez készült – újraépítjük csak a főoldali HU csatornákból.');
      return null;
    }
    // A név→XMLTV-azonosító térképet a csatornasorok előtt olvassuk be,
    // hogy a cache-visszatöltés is pontosan a kiválasztott HU adókra szűrhessen.
    try {
      const rawNames = await store.get(huGuideNamesKey(providerId));
      if (rawNames) {
        const parsedNames = JSON.parse(rawNames) as Array<[string, string]>;
        if (Array.isArray(parsedNames)) {
          for (const pair of parsedNames) {
            if (Array.isArray(pair) && pair[0] && pair[1]) nameToId.set(String(pair[0]), String(pair[1]));
          }
        }
      }
    } catch { /* régi névtérkép nélkül a cél-azonosítókat használjuk */ }
    let restored = 0;
    for (let chunk = 0; chunk < meta.chunks; chunk++) {
      const raw = await store.get(guideChunkKey(providerId, chunk));
      if (!raw) return null;
      for (const line of raw.split('\n')) {
        if (!line) continue;
        const [channel, entries] = JSON.parse(line) as [string, Array<[number, number, string]>];
        if (!channel || !Array.isArray(entries) || !entries.length) continue;
        /* 2.5.279: a régi, minden országot tartalmazó mentésből is csak a magyar csatornák maradnak. */
        if (!isHuGuideChannelId(channel)) continue;
        huChannelIdSet.add(channelIdBase(channel).toLowerCase());
        index.set(channel, entries.map(([start, end, title]) => ({ s: start, e: end, t: title })));
        restored += 1;
      }
    }
    if (!restored) return null;

    let restoredNamesCount = 0;
    try {
      const rawNames = await store.get(guideNamesKey(providerId));
      if (rawNames) {
        const parsedNames = JSON.parse(rawNames) as Array<[string, string]>;
        if (Array.isArray(parsedNames)) {
          for (let i = 0; i < parsedNames.length; i += 1) {
            const pair = parsedNames[i];
            if (Array.isArray(pair) && pair[0] && pair[1]) {
              /* 2.5.279: csak magyar cél-azonosítójú névpárok maradnak. */
              if (!isHuGuideChannelId(String(pair[1]))) continue;
              nameToId.set(String(pair[0]), String(pair[1]));
              restoredNamesCount += 1;
            }
          }
        }
      }
    } catch {
      /* Régi mentés névtérkép nélkül: háttérbeli frissítéssel pótoljuk. */
    }

    // A visszatöltött index is átesik a tisztításon (lejárt műsorok kidobása).
    finishParsing();
    if (index.size === 0 || statKept === 0) {
      return null;
    }
    // Ha a régi mentésből hiányzott a névtérkép (restoredNamesCount === 0),
    // azonnal megjelenítjük az ID-alapú műsorokat, de a háttérben frissítjük is!
    const hasNameMap = restoredNamesCount > 0;
    return {
      savedAt: meta.savedAt,
      channels: index.size,
      programmes: statKept,
      bytes: meta.bytes,
      complete: meta.complete === true && hasNameMap,
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

/*
 * 2.5.338 (HU külön EPG): SAJÁT, KÜLÖN TÁROLÓ a magyar csoportnak.
 * A HU EPG-t KIZÁRÓLAG a nyilvános HU forrásokból töltjük
 * (epgshare01 HU1, aldork04 lgtv-epg, iptv-epg.org HU), és CSAK
 * countryCode=HU csatornákra. A szolgáltató xmltv.php / get_short_epg /
 * get_simple_data_table NEM keveredik. A HU EPG frissítése CSAK a
 * beállított idő szerint történik (HU_GUIDE_TTL_MS = 12h + 12h ablak),
 * IPK-újraindításkor nem töltjük újra, ha érvényes.
 */
function huGuideChunkKey(_providerId: string, index: number): string {
  return `${HU_GUIDE_IDB_PREFIX}${HU_GUIDE_STORAGE_ID}-${index}`;
}
function huGuideMetaKey(_providerId: string): string {
  return `${HU_GUIDE_IDB_PREFIX}${HU_GUIDE_STORAGE_ID}-meta`;
}
function huGuideNamesKey(_providerId: string): string {
  return `${HU_GUIDE_IDB_PREFIX}${HU_GUIDE_STORAGE_ID}-names`;
}
async function persistHuGuide(providerId: string, complete: boolean): Promise<void> {
  try {
    const store = await openIdbStore();
    if (!store) return;
    const rows = serializeGuide();
    if (!rows.length) return;
    // 2.5.338: a HU EPG-nél az „elég magyar csatorna” miatti korai leállás
    // NEM részleges, hanem sikeres – teljes értékű mentés (különben minden
    // újraindításkor „részleges→lejárt→újra letölt” ciklus lenne).
    const isHuEnoughAbort = /elég magyar csatorna/i.test(abortReason);
    const effectiveComplete = complete || isHuEnoughAbort;
    const chunkSize = 200;
    let chunks = 0;
    let programmes = 0;
    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const part = rows.slice(offset, offset + chunkSize);
      const ok = await store.put(huGuideChunkKey(providerId, chunks), part.join('\n'));
      if (!ok) return;
      chunks += 1;
    }
    await store.put(huGuideNamesKey(providerId), serializeNameMap());
    index.forEach((list) => { programmes += list.length; });
    const meta: PersistedGuideMeta = {
      providerId: HU_GUIDE_STORAGE_ID,
      savedAt: Date.now(),
      channels: index.size,
      programmes,
      bytes: lastBytes,
      chunks,
      complete: effectiveComplete,
      timeMode: GUIDE_TIME_MODE,
      targetFingerprint: currentHuTargetFingerprint(),
    };
    await store.put(huGuideMetaKey(providerId), JSON.stringify(meta));
    appLog(
      `EPG-ÁLLAPOT (HU külön): a magyar műsorújság elmentve a saját tárba (${meta.channels} csatorna, cél: ${huProbeChannels.length || '?'}, `
      + `${meta.programmes} műsor, ${nameToId.size} név-azonosító, ${chunks} adag${effectiveComplete ? '' : ', RÉSZLEGES'}); a következő `
      + `${effectiveComplete ? 'indulás ebből indul (12h ablakon belül nem tölt újra)' : 'indulás ezt ismét frissíti'}.`
    );
  } catch {
    // A mentés hibája nem akadály.
  }
}
async function restoreHuGuide(
  providerId: string,
): Promise<{ savedAt: number; channels: number; programmes: number; bytes: number; complete: boolean } | null> {
  try {
    const store = await openIdbStore();
    if (!store) return null;
    const rawMeta = await store.get(huGuideMetaKey(providerId));
    if (!rawMeta) return null;
    const meta = JSON.parse(rawMeta) as PersistedGuideMeta;
    if (!meta || meta.providerId !== HU_GUIDE_STORAGE_ID || !meta.chunks) return null;
    if (meta.timeMode !== GUIDE_TIME_MODE) {
      appLog(
        'EPG-ÁLLAPOT (HU külön): a mentett HU műsorújság régi időzóna-kezeléssel készült – egyszer újratöltjük magyar időben.',
      );
      return null;
    }
    let restored = 0;
    for (let chunk = 0; chunk < meta.chunks; chunk++) {
      const raw = await store.get(huGuideChunkKey(providerId, chunk));
      if (!raw) return null;
      for (const line of raw.split('\n')) {
        if (!line) continue;
        const [channel, entries] = JSON.parse(line) as [string, Array<[number, number, string]>];
        if (!channel || !Array.isArray(entries) || !entries.length) continue;
        if (!isHuGuideChannelId(channel)) continue;
        huChannelIdSet.add(channelIdBase(channel).toLowerCase());
        index.set(channel, entries.map(([start, end, title]) => ({ s: start, e: end, t: title })));
        restored += 1;
      }
    }
    if (!restored) return null;
    let restoredNamesCount = 0;
    try {
      const rawNames = await store.get(huGuideNamesKey(providerId));
      if (rawNames) {
        const parsedNames = JSON.parse(rawNames) as Array<[string, string]>;
        if (Array.isArray(parsedNames)) {
          for (let i = 0; i < parsedNames.length; i += 1) {
            const pair = parsedNames[i];
            if (Array.isArray(pair) && pair[0] && pair[1]) {
              if (!isHuGuideChannelId(String(pair[1]))) continue;
              nameToId.set(String(pair[0]), String(pair[1]));
              restoredNamesCount += 1;
            }
          }
        }
      }
    } catch {
      /* Régi mentés névtérkép nélkül */
    }
    finishParsing();
    if (index.size === 0 || statKept === 0) return null;
    const hasNameMap = restoredNamesCount > 0;
    return {
      savedAt: meta.savedAt,
      channels: index.size,
      programmes: statKept,
      bytes: meta.bytes,
      complete: meta.complete === true && hasNameMap,
    };
  } catch {
    return null;
  }
}
async function clearHuGuide(_providerId: string): Promise<void> {
  try {
    const store = await openIdbStore();
    if (!store) return;
    const keys = await store.keys();
    const prefix = `${HU_GUIDE_IDB_PREFIX}${HU_GUIDE_STORAGE_ID}`;
    for (const key of keys) {
      if (key.startsWith(prefix) || key.startsWith('epg-hu-guide-v1-public-hu')) await store.remove(key);
    }
  } catch {
    // ignore
  }
}
function isHuGuideFresh(savedAt: number, complete: boolean, thick: boolean, huLow: boolean): boolean {
  if (!thick || huLow) return false;
  // 2.5.338: a HU EPG-nél az „elég magyar csatorna” miatti leállás teljesnek számít,
  // ezért a !complete itt nem kizáró, csak a thick+huLow számít. A 12 órás TTL
  // és a 12 órás ablak (KEEP_AFTER) együtt adja a „beállított frissítési idő”-t.
  const expectedHuChannels = huProbeChannels.length || HU_ENOUGH_CHANNELS;
  const huCompleteEnough = complete || huChannelIdSet.size >= Math.max(1, Math.floor(expectedHuChannels * 0.9));
  if (!huCompleteEnough) return false;
  const age = Date.now() - savedAt;
  const windowStillValid = Date.now() < savedAt + (KEEP_AFTER_SEC - 3600) * 1000;
  return age < HU_GUIDE_TTL_MS || windowStillValid;
}

/* ─────────────────────────────── nyilvános API ─────────────────────────── */

/**
 * A teljes műsorújság biztosítása (egyszer fut, 30 percig érvényes).
 *
 * SOHA nem hívjuk az indulás alatt: az App a megjelenés UTÁN, üresjáratban
 * indítja. Hibánál csendben visszatér (a naplóban ott a valódi ok), és a
 * rövid EPG marad tartaléknak.
 */
/*
 * 2.5.278 (#18-as napló): NYILVÁNOS MAGYAR (HU) EPG ELŐRE.
 *
 * A #18-as naplóban a nagy (10-20 MB-os) szolgáltatói XMLTV csak ~1-3 perc
 * alatt ért ide, és a magyar adók műsora még később (a nyilvános HU újság
 * 08:02:55-kor lett kész). Most ha a visszatöltött újság kevés magyar adót fed
 * le, ELŐBB a kis, gyors nyilvános HU fájlokat töltjük le (másodpercek alatt),
 * és csak utána indul a nagy szolgáltatói letöltés a háttérben – így a magyar
 * sárga műsorsor azonnal megjelenik.
 */
async function loadPublicHuGuides(
  provider: { id: string; type?: string; serverUrl?: string; username?: string; password?: string },
): Promise<void> {
  if (!PUBLIC_GUIDES_ENABLED) return;
  appLog('EPG-ÁLLAPOT: kevés magyar adót fed le a jelenlegi újság – nyilvános MAGYAR (HU) EPG újságok előre indulnak (kicsik, gyorsak).');
  for (const candidate of PUBLIC_GUIDE_URLS) {
    if (candidate.scope !== 'hu') continue;
    const before = index.size;
    appLog(`EPG-ÁLLAPOT: nyilvános EPG próba – ${candidate.label}: ${candidate.url}`);
    buffer = '';
    scannedUpTo = 0; // 2.5.278
    lastProgrammes = 0;
    lastSkipped = 0;
    lastSkippedNonHu = 0; // 2.5.279
    lastBytes = 0;
    abortReason = '';
    try {
      await download(provider, candidate.url, candidate.label, candidate.limits);
    } catch { /* a download már naplózta a valódi okot */ }
    const hu = huProbeCoverage();
    appLog(
      `EPG-ÁLLAPOT: nyilvános EPG (${candidate.label}) – ${before} → ${index.size} csatorna (+${index.size - before}), `
      + `${statKept} megtartott műsor, ${(lastBytes / 1024).toFixed(0)} KB`
      + `${abortReason ? ` (részleges: ${abortReason})` : ''}`
      + `; magyar adók műsorral eddig: ${hu.hit}/${hu.total}.`
    );
    if (index.size > 0) {
      loadedAt = Date.now();
      // 2.5.338 (HU külön): a HU EPG-t a saját HU tárba mentjük, nem a közös/provider tárba.
      // Az „elég magyar csatorna” miatti leállás itt nem részleges, hanem teljes HU fedés.
      const isHuEnough = /elég magyar csatorna/i.test(abortReason);
      void persistHuGuide(provider.id, !abortReason || isHuEnough);

    }
    // Ha már elég magyar adó kapott műsort, nem kell végigpróbálni a többit.
    if (hu.total > 0 && hu.hit >= Math.max(1, Math.floor(hu.total * 0.9))) break;
  }
  notifyGuideListeners();
}

export async function ensureGuide(provider: {
  id: string;
  type?: string;
  serverUrl?: string;
  username?: string;
  password?: string;
} | null): Promise<void> {
  /*
   * 2.5.265 (#12-es napló): MINDEN korai kilépés naplózva van – a #12-es
   * naplóban egyetlen EPG-ÁLLAPOT sor sem volt, így nem lehetett látni, hol
   * állt le a műsorújság. Az m3u providerhez is tartozik műsorújság: ott a
   * lista (serverUrl) fejlécéből (url-tvg) vagy a lista melletti jelölt
   * XMLTV útvonalakról töltjük (lásd discoverUrlTvg/discoverXmltvCandidates).
   */
  // A magyar EPG teljesen független a szolgáltatótól: fix azonosítóval és
  // kizárólag a nyilvános HU forrásokból működik, provider URL/jelszó nélkül.
  const guideProvider = PUBLIC_GUIDES_ENABLED
    ? { id: HU_GUIDE_STORAGE_ID, type: 'public-hu' }
    : provider;
  if (!guideProvider) {
    appLog('EPG-ÁLLAPOT (HU külön): nincs használható magyar EPG-forrás.');
    return;
  }
  provider = guideProvider;
  if (!PUBLIC_GUIDES_ENABLED && !provider.serverUrl) {
    appLog('EPG-ÁLLAPOT: tesztmódban nincs provider vagy serverUrl, a műsorújság nem indul.');
    return;
  }
  const providerType = provider.type || '';
  const isM3u = providerType === 'm3u';
  if (!PUBLIC_GUIDES_ENABLED && providerType !== 'xtream' && !isM3u) {
    appLog(`EPG-ÁLLAPOT: ensureGuide – nem támogatott provider típus (${providerType || 'üres'}), a műsorújság nem indul.`);
    return;
  }
  if (!PUBLIC_GUIDES_ENABLED && !isM3u && (!provider.username || !provider.password)) {
    appLog('EPG-ÁLLAPOT: ensureGuide – xtream providerhez nincs felhasználónév vagy jelszó, a műsorújság nem indul.');
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
  // 2.5.265 (#12): a „már friss” és „már töltődik” állapot is naplózva.
  if (fresh) {
    appLog(`EPG-ÁLLAPOT: a műsorújság már friss a memóriában (${index.size} csatorna) – nem töltjük újra.`);
    return;
  }
  if (loading) {
    appLog('EPG-ÁLLAPOT: másik EPG-feldolgozás befejezésére várunk, majd a HU saját tárát ellenőrizzük.');
    await loading;
    return ensureGuide(provider);
  }
  if (breakerOpen()) {
    appLog(`EPG-ÁLLAPOT: a megszakító nyitva van (${Math.ceil(breakerRemainingMs() / 1000)} mp) – a műsorújság később töltődik be.`);
    return;
  }
  /*
   * 2.5.266 (#13-as napló): üres végeredmény utáni hűtés – lásd a deklarációnál.
   */
  if (lastEmptyGuideAt && loadedProviderId === provider.id && index.size === 0
      && Date.now() - lastEmptyGuideAt < EMPTY_GUIDE_COOLDOWN_MS) {
    appLog(
      `EPG-ÁLLAPOT: az utolsó műsorújság üres volt (${Math.round((Date.now() - lastEmptyGuideAt) / 1000)} mp-e) `
      + `– a ${Math.round(EMPTY_GUIDE_COOLDOWN_MS / 60000)} perces hűtés még tart, most nem töltünk újra.`
    );
    return;
  }
  /*
   * 2.5.266 (#13-as napló): a `loading` zárat SZINKRONAN, még az első await
   * (tartós tár visszatöltése) ELŐTT állítjuk be. A #13-as naplóban két
   * scheduleGuide hívás 17 ms különbséggel kétszer indította el ugyanazt a
   * letöltést (a második index.clear()-je kidobta az első részleges eredményét,
   * a duplázott kérések miatt a panel 429-cel válaszolt).
   */
  let releaseLoading!: () => void;
  loading = new Promise<void>((resolve) => { releaseLoading = resolve; });
  const finishLoading = (): void => {
    loading = null;
    releaseLoading();
  };

  const startedAt = Date.now();
  index.clear();
  nameToId.clear();
  huChannelIdSet.clear(); // 2.5.279
  buffer = '';
  scannedUpTo = 0; // 2.5.278
  lastProgrammes = 0;
  lastSkipped = 0;
  lastSkippedNonHu = 0; // 2.5.279
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
  // 2.5.266 (#13): a visszatöltés hibája ne akassza ki a zárat örökre.
  // 2.5.338 (HU külön): ELŐSZÖR a HU külön tárolót próbáljuk – ez a
  // „saját tároló” (nem szolgáltató). Ha a HU EPG érvényes (12h TTL +
  // 12h ablak), IPK-újraindításkor NEM töltjük újra, csak a beállított
  // idő szerint. A szolgáltató EPG-vel nem keverjük.
  let huRestored: { savedAt: number; channels: number; programmes: number; bytes: number; complete: boolean } | null = null;
  if (!skipRestore) {
    // HU külön tároló (countryCode=HU, nyilvános HU források)
    try { huRestored = await restoreHuGuide(provider.id); } catch { huRestored = null; }
    if (huRestored) {
      loadedAt = huRestored.savedAt;
      loadedProviderId = provider.id;
      lastProgrammes = huRestored.programmes;
      lastBytes = huRestored.bytes;
      statKept = statKept || huRestored.programmes;
      restoredPartial = !huRestored.complete;
      appLog(
        `EPG-ÁLLAPOT (HU külön): a magyar műsorújság a saját tárból betöltve – ${huRestored.channels} csatorna (cél: ${huProbeChannels.length || '?'}), `
        + `${huRestored.programmes} műsor (mentve: ${new Date(huRestored.savedAt).toLocaleTimeString('hu-HU')}` +
        `${huRestored.complete ? '' : ', RÉSZLEGES'}).`
      );
      const thick = huRestored.channels > 0
        && huRestored.programmes >= huRestored.channels * USABLE_PROGRAMMES_PER_CHANNEL;
      const huLow = huCoverageLow();
      if (huLow) {
        const hu = huProbeCoverage();
        appLog(`EPG-ÁLLAPOT (HU külön): a visszatöltött HU újság csak ${hu.hit}/${hu.total} magyar adót fed le – nem tekintjük frissnek, frissítjük (kizárólag HU forrásokból).`);
      }
      if (isHuGuideFresh(huRestored.savedAt, huRestored.complete, thick, huLow)) {
        appLog(
          `EPG-ÁLLAPOT (HU külön): a mentett HU műsorújság még érvényes (${huRestored.channels} csatorna, ablaka ${(KEEP_AFTER_SEC / 3600).toFixed(0)} órás, TTL ${(HU_GUIDE_TTL_MS / 3600000).toFixed(0)}h) `
          + `– IPK-újraindításkor nem töltjük újra, a meglévő HU műsorok maradnak (csak a beállított idő szerint frissül).`
        );
        // HU friss, nincs teendő – a szolgáltató EPG-től függetlenül kész.
        // A szolgáltató EPG-t nem keverjük: HU-ra csak a saját HU források.
        finishLoading();
        return;
      }
      appLog(
        'EPG-ÁLLAPOT (HU külön): a mentett HU műsorújság '
        + `${!huRestored.complete && huChannelIdSet.size < HU_ENOUGH_CHANNELS ? 'részleges' : (!thick ? 'túl kevés műsort tartalmaz' : (huLow ? 'kevés magyar adót fed le' : 'lejárt'))} `
        + '– a háttérben frissítjük kizárólag HU forrásokból, a már látható HU műsorok addig is megmaradnak.'
      );
      // HU nem friss – folytatjuk HU frissítéssel, de az indexet már
      // feltöltöttük a régi HU adatokkal (finishParsing után), így a
      // felület azonnal mutatja a régi műsort, amíg az új töltődik.
      // A szolgáltatói (nem HU) EPG-t most nem vizsgáljuk külön – HU-ra
      // csak HU források, provider EPG nem keveredik.
    }
  }
  skipRestore = false;

  // 2.5.338 (HU külön): ha van HU csatorna a szondában (countryCode=HU)
  // és a nyilvános HU források elérhetők (böngésző, nem teszt), akkor
  // CSAK a HU külön EPG-t kezeljük – kizárólag a nyilvános HU
  // forrásokból (epgshare01 HU1 / aldork04 / iptv-epg.org HU), a
  // szolgáltató xmltv.php / get_short_epg / get_simple_data_table
  // NEM keveredik. IPK-újraindításkor nem töltjük újra, csak a
  // beállított HU frissítési idő (12h TTL + 12h ablak) szerint.
  // Tesztkörnyezetben (PUBLIC_GUIDES_ENABLED=false) a HU szűrés
  // megmarad, de a letöltés a szolgáltatótól jön (hogy a tesztek
  // hermetikus mock szerverüket használják).
  const isHuMode = PUBLIC_GUIDES_ENABLED;
  if (isHuMode) {
    appLog(
      'EPG-ÁLLAPOT (HU külön): a magyar EPG frissítése indul – kizárólag HU forrásokból '
      + '(epgshare01 HU1 / aldork04 lgtv-epg / iptv-epg.org HU), szolgáltató EPG nélkül.'
    );
    // A visszatöltött HU index már az előző blokkban a memóriában van.
    // Ha kevés magyar adót fed le, ELŐBB a kis nyilvános HU újságokat
    // töltjük – másodpercek alatt megvan a magyar sárga csík.
    if (huCoverageLow() || index.size === 0) {
      await loadPublicHuGuides(provider);
    }
    const huChannels = index.size;
    const huProgrammeCount = statKept;
    if (huChannels > 0) {
      // HU EPG mentése a saját HU tárba (nem a provider közös tárba)
      const isHuEnough = /elég magyar csatorna/i.test(abortReason);
      void persistHuGuide(provider.id, !abortReason || isHuEnough);
      loadedAt = Date.now();
      loadedProviderId = provider.id;
      appLog(`EPG-ÁLLAPOT (HU külön): HU EPG frissítés kész – ${huChannels} csatorna (cél: ${huProbeChannels.length || '?'}), ${huProgrammeCount} műsor (csak a főoldali HU csatornákból).`);
    } else {
      appLog('EPG-ÁLLAPOT (HU külön): a HU források nem adtak műsort – a HU EPG üres maradt (nem próbálunk szolgáltatói EPG-t HU-ra).');
      if (index.size === 0) lastEmptyGuideAt = Date.now();
    }
    finishLoading();
    return;
  }

  appLog(
    'EPG-ÁLLAPOT: a teljes műsorújság (XMLTV) letöltése indul – provider típus='
    + `${providerType}, forrás=${isM3u ? 'm3u lista (serverUrl)' : 'xmltv.php'} (${provider.serverUrl}).`
  );

  /*
   * 2.5.265 (#12): m3u provider esetén NINCS xmltv.php végpont – ott előbb
   * forrást keresünk (url-tvg a listában, majd jelölt XMLTV útvonalak), és
   * csak onnan töltünk (lásd a channels===0 ágat lejjebb).
   */
  /*
   * 2.5.269 (#2-es napló): a visszatöltött (esetleg RÉSZLEGES) újság az indexben
   * marad a letöltés alatt is – ezért a „üres-e a szolgáltató újságja?” kérdést
   * NEM az index.size alapján döntjük el (az a #2-es naplóban 1658-at mutatott
   * a visszatöltésből, pedig a letöltés üres volt, így a tartalék lánc soha nem
   * futott le), hanem hogy a LETÖLTÉS mennyi ÚJ műsort adott hozzá.
   */
  /*
   * 2.5.278 (#18-as napló): ha kevés magyar adót fed le az aktuális (visszatöltött)
   * újság, ELŐBB a kis nyilvános HU újságokat töltjük le – a magyar EPG így
   * másodpercek alatt megjelenik, nem csak a nagy szolgáltatói fájl után.
   * MEGJEGYZÉS 2.5.338: ez az ág csak nem-HU módra vonatkozik; HU módban
   * már fentebb lefutott a HU külön frissítés, itt nem kell újra.
   */
  if (huCoverageLow()) {
    await loadPublicHuGuides(provider);
  }
  const statKeptBase = statKept;
  /* 2.5.279: a szolgáltató teljes (minden országos) xmltv-je csak korlátozottan töltődik – csak magyar kell, a többit a korai megállás/ez a plafon vágja. */
  const primaryDownload = isM3u ? Promise.resolve() : download(provider, undefined, 'xmltv.php', { maxBytes: 32 * 1024 * 1024 });
  await primaryDownload
    .then(async () => {
      loadedAt = Date.now();
      loadedProviderId = provider.id;
      let channels = index.size;
      const ujMűsor = statKept - statKeptBase;
      const partial = abortReason ? ` (részleges: ${abortReason})` : '';
      appLog(
        `EPG-ÁLLAPOT: műsorújság betöltve ${((Date.now() - startedAt) / 1000).toFixed(1)} mp alatt – `
        + `${channels} csatorna, ${statKept} megtartott műsor (ebből ÚJONNAN ${ujMűsor}) `
        + `(a ${lastProgrammes} feldolgozott blokkból ${lastSkipped} időablakon kívüli, `
        + `${statInvalidDate} érvénytelen időpont, ${statNoTitle} cím nélküli, `
        + `${statCap} korlát miatt kihagyott, ${lastSkippedNonHu} nem magyar csatorna/műsor kihagyva (HU-mód)), ${(lastBytes / 1024).toFixed(0)} KB${partial}.`
      );
      appLog(`IMPORT-API-DIAG [EPG XMLTV] letöltés kész: ${channels} csatorna, ${statKept} megtartott műsor, ${lastProgrammes} feldolgozott blokk, ${(lastBytes / 1024).toFixed(0)} KB; mezők: channel-id/display-name, programme start/stop/title/desc (a ténylegesen beolvasott XML-elemek alapján).`);
      if (channels > 0) void persistGuide(provider.id, !abortReason);
      /* 2.5.273 (#5-ös napló): akkor is megy a nyilvános HU lánc, ha a letöltés adott
         is új műsort, de a magyar adók így is kevésbé lennének lefedve. */
      if (channels === 0 || ujMűsor === 0 || huCoverageLow()) {
        const hu = huProbeCoverage();
        appLog(`EPG-ÁLLAPOT: a szolgáltató műsorújságja nem adott ÚJ műsort (index=${channels}, újonnan=${ujMűsor}, magyar még ${hu.hit}/${hu.total}) – url-tvg / jelölt útvonalak / nyilvános HU újság próbája következik.`);
        /*
         * 2.5.261 (#10-es napló): az xmltv.php üres 200-at adott – megpróbáljuk
         * az M3U lista (get.php) fejlécében hirdetett url-tvg címet. Ha ott van
         * XMLTV, innen töltjük le ugyanazzal a folyamatos olvasóval.
         */
        /*
         * 2.5.264 (#11-es napló): ha az xmltv.php üres és az M3U-ból sincs
         * url-tvg, még a panel alap címe alatti jelölt XMLTV útvonalakat is
         * kipróbáljuk (/epg.xml, /guide.xml, /xmltv.xml) – mindegyik próba
         * naplózva van (státusz + törzs eleje).
         */
        // 2.5.265 (#12): m3u esetén a discover* függvények a listát / annak könyvtárát nézik.
        /*
         * 2.5.275 (#11-es napló): ha korábban már egy teljes próba üresnek találta
         * a panel összes EPG végpontját (üres xmltv.php, nincs url-tvg a get.php
         * elején, a jelölt útvonalak 404-esek), a 24 órás jelző ideje alatt
         * KIHAGYJUK az M3U letöltést és a jelölt útvonalak újbóli próbáját – ez
         * minden frissítésnél több MB és több másodperc megtakarítás a főszálon.
         */
        const panelEmptyAt = await readPanelEmptyAt(provider.id);
        const panelKnownEmpty = panelEmptyAt > 0 && Date.now() - panelEmptyAt < PANEL_EMPTY_TTL_MS;
        let guideSourceUrl: string | null = null;
        let guideSourceLabel = 'url-tvg XMLTV';
        if (panelKnownEmpty) {
          appLog(
            `EPG-ÁLLAPOT: a panel EPG végpontjai ${Math.round((Date.now() - panelEmptyAt) / 60000)} perce üresnek bizonyultak `
            + `– a get.php url-tvg keresés és a jelölt útvonalak újbóli próbája KIHAGYVA, egyenesen a nyilvános HU újságok következnek.`
          );
        } else {
          const tvgUrl = await discoverUrlTvg(provider, isM3u);
          guideSourceUrl = tvgUrl && (!isM3u ? tvgUrl !== guideUrl(provider) : true) ? tvgUrl : null;
          if (!guideSourceUrl) {
            appLog(`EPG-ÁLLAPOT: ${isM3u ? 'az m3u listában' : 'az M3U listában'} sincs url-tvg – jelölt XMLTV útvonalak próbája következik.`);
            const candidateUrl = await discoverXmltvCandidates(provider, isM3u);
            if (candidateUrl) {
              guideSourceUrl = candidateUrl;
              guideSourceLabel = 'jelölt XMLTV';
            }
          }
          // 2.5.275: csak VALÓDI próba után jegyezzük fel (különben a 24 órás
          // lejárati idő soha nem érne véget, és soha nem próbálnánk újra).
          if (!guideSourceUrl) void writePanelEmpty(provider.id);
        }
        if (guideSourceUrl) {
          appLog(`EPG-ÁLLAPOT: műsorújság forrása megtalálva: ${guideSourceUrl} – a letöltés innen indul.`);
          buffer = '';
          scannedUpTo = 0; // 2.5.278
          lastProgrammes = 0;
          lastSkipped = 0;
          lastBytes = 0;
          abortReason = '';
          await download(provider, guideSourceUrl, guideSourceLabel, { maxBytes: 32 * 1024 * 1024 });
          channels = index.size;
          loadedAt = Date.now();
          appLog(
            `EPG-ÁLLAPOT: ${guideSourceLabel} műsorújság betöltve – ${channels} csatorna, ${statKept} megtartott műsor, `
            + `${(lastBytes / 1024).toFixed(0)} KB${abortReason ? ` (részleges: ${abortReason})` : ''}.`
          );
          if (channels > 0) void persistGuide(provider.id, !abortReason);
        }
        /*
         * 2.5.267 (#14-es kérés): NYILVÁNOS EPG ÚJSÁG – ha a szolgáltató saját
         * műsorújsága és minden jelölt panel-útvonal üres volt (a #13-as napló:
         * LOWEND panel üres <tv></tv>), innen töltünk egy mindig elérhető
         * nyilvános XMLTV forrást. Tesztkörnyezetben kikapcsolva.
         * 2.5.269 (#2-es kérés): CSAK kis magyar (HU) fájlok – semmilyen
         * globális (minden országos) fájl nem töltődik le, így a tároló és
         * a letöltési idő is kicsi marad.
         */
        if (!guideSourceUrl && PUBLIC_GUIDES_ENABLED) {
          appLog('EPG-ÁLLAPOT: a panel minden útvonala üres – nyilvános MAGYAR (HU) EPG újságok próbája indul.');
          await loadPublicHuGuides(provider);
          if (index.size > 0) {
            appLog(`EPG-ÁLLAPOT: műsorújság betöltve NYILVÁNOS forrásokból – összesen ${index.size} csatorna, ${statKept} megtartott műsor.`);
          } else {
            appLog('EPG-ÁLLAPOT: egyetlen nyilvános EPG forrás sem adott műsort – marad a per-csatornás get_simple_data_table tartalék.');
          }
        } else if (!guideSourceUrl) {
          appLog('EPG-ÁLLAPOT: sem url-tvg, sem jelölt XMLTV útvonal nem adott műsorújságot – marad a per-csatornás get_simple_data_table tartalék.');
        }
      }
      // 2.5.266 (#13): üres végeredmény – jegyezzük fel a hűtési időhöz.
      if (index.size === 0) lastEmptyGuideAt = Date.now();
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
          `EPG-ÁLLAPOT: a műsorújság letöltése megszakadt – ${abortReason || 'a böngésző szakította meg'}; `
          + `a már beolvasott rész: ${index.size} csatorna, ${lastBytes ? (lastBytes / 1048576).toFixed(1) + ' MB' : 'nincs adat'}.`
        );
      }
      appLogError(`EPG műsorújság${aborted ? ' (megszakítva)' : ''}`, error);
      // Ami összejött, az maradjon használható a következő indulásig is –
      // de RÉSZLEGES jelöléssel, hogy a következő indulás frissítsen.
      if (index.size > 0) void persistGuide(provider.id, false);
    })
    // 2.5.266 (#13): a zárat a lánc végén (siker és hiba után is) elengedjük.
    .finally(finishLoading);
}


/**
 * Nem magyar ország EPG-je: kizárólag a kiválasztott ország ideiglenes
 * memóriájába kerül. IndexedDB/localStorage mentés nincs; kilépéskor töröljük.
 */
async function clearLegacyCountryGuideStorage(): Promise<void> {
  try {
    const store = await openIdbStore();
    if (!store) return;
    const keys = await store.keys();
    for (const key of keys) {
      if (key.startsWith('epg-country-v1-')) await store.remove(key);
    }
  } catch { /* a régi ország-cache takarítása nem blokkolja az EPG-t */ }
}

export function clearCountryGuideMemory(): void {
  countryGuideGeneration += 1;
  if (activeCountryEpgTarget) {
    activeCountryEpgTarget.cancelled = true;
    abortReason = 'a néző kilépett az országnézetből';
    try { activeCountryDownloadController?.abort(); } catch { /* régi webOS motor */ }
  }
  index.clear();
  nameToId.clear();
  buffer = '';
  scannedUpTo = 0;
  loadedAt = 0;
  loadedProviderId = '';
  lastProgrammes = 0;
  lastSkipped = 0;
  lastBytes = 0;
  statKept = 0;
  huChannelIdSet.clear();
  void clearLegacyCountryGuideStorage();
  notifyGuideListeners();
}

export async function ensureCountryGuide(
  provider: { id: string; type?: string; serverUrl?: string; username?: string; password?: string } | null,
  channels: Array<{ id?: string; name?: string; epgChannelId?: string | null; countryCode?: string }>,
  countryCode: string,
): Promise<void> {
  const generation = countryGuideGeneration;
  const code = String(countryCode || '').trim().toUpperCase();
  if (!provider || !provider.serverUrl || !code || code === 'HU') return;
  const selected = (Array.isArray(channels) ? channels : [])
    .filter((channel) => (channel.countryCode || '').toUpperCase() === code);
  if (!selected.length) return;

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const channel of selected) {
    const rawId = String(channel.epgChannelId || '').trim().toLowerCase();
    if (rawId) {
      ids.add(rawId);
      ids.add(channelIdBase(rawId));
    }
    const name = normalizeName(channel.name || '');
    if (name) names.add(name);
  }
  if (!ids.size && !names.size) {
    appLog(`EPG-ÁLLAPOT (${code}): nincs EPG-azonosító vagy csatornanév a kiválasztott ország csatornáihoz.`);
    return;
  }

  if (loading) {
    await loading;
    if (generation !== countryGuideGeneration) return;
  }
  if (generation !== countryGuideGeneration) return;
  // Régebbi verziók esetleges országonkénti mentéseit eltávolítjuk, de új mentést nem készítünk.
  await clearLegacyCountryGuideStorage();
  if (generation !== countryGuideGeneration) return;
  if (breakerOpen()) {
    appLog(`EPG-ÁLLAPOT (${code}): a hálózati megszakító nyitva van; az ország EPG-je később tölthető.`);
    return;
  }

  // A futó index kizárólag ezt az egy országot tartalmazza.
  index.clear();
  nameToId.clear();
  huChannelIdSet.clear();
  buffer = '';
  scannedUpTo = 0;
  lastProgrammes = 0;
  lastSkipped = 0;
  lastSkippedNonHu = 0;
  lastBytes = 0;
  lastError = '';
  statInvalidDate = 0;
  statNoTitle = 0;
  statCap = 0;
  statKept = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  windowStart = nowSec - KEEP_BEFORE_SEC;
  windowEnd = nowSec + KEEP_AFTER_SEC;

  let releaseLoading!: () => void;
  loading = new Promise<void>((resolve) => { releaseLoading = resolve; });
  const target = { code, ids, names, acceptedIds: new Set<string>(), cancelled: false };
  activeCountryEpgTarget = target;
  appLog(`EPG-ÁLLAPOT (${code}): ideiglenes EPG-letöltés indul – csak a kiválasztott ország ${selected.length} csatornája kerül a memóriába; tartós mentés nincs.`);

  try {
    const isM3u = provider.type === 'm3u';
    const sources: Array<{ url: string; label: string }> = [];
    if (isM3u) {
      const tvgUrl = await discoverUrlTvg(provider, true);
      if (generation !== countryGuideGeneration || target.cancelled) return;
      if (tvgUrl) sources.push({ url: tvgUrl, label: 'M3U url-tvg' });
    } else {
      sources.push({ url: guideUrl(provider), label: 'xmltv.php' });
    }
    if (!sources.length) {
      const candidateUrl = await discoverXmltvCandidates(provider, isM3u);
      if (generation !== countryGuideGeneration || target.cancelled) return;
      if (candidateUrl) sources.push({ url: candidateUrl, label: 'jelölt XMLTV' });
    }

    let sourceSucceeded = false;
    for (let cursor = 0; cursor < sources.length; cursor += 1) {
      if (generation !== countryGuideGeneration || target.cancelled) return;
      const source = sources[cursor];
      buffer = '';
      scannedUpTo = 0;
      abortReason = '';
      try {
        await download(provider, source.url, `XMLTV (${code}) – ${source.label}`, { maxBytes: MAX_BYTES, maxMs: MAX_DOWNLOAD_MS });
      } catch (error) {
        if (!target.cancelled) appLog(`EPG-ÁLLAPOT (${code}): ${source.label} nem adott használható EPG-t – ${error instanceof Error ? error.message : String(error)}.`);
      }
      if (generation !== countryGuideGeneration || target.cancelled) return;
      finishParsing();
      const hasProgrammes = Array.from(target.acceptedIds).some((key) => (index.get(key) || []).length > 0);
      if (hasProgrammes) {
        sourceSucceeded = true;
        break;
      }
      if (cursor === 0) {
        const fallbackUrl = await discoverXmltvCandidates(provider, isM3u);
        if (generation !== countryGuideGeneration || target.cancelled) return;
        if (fallbackUrl && !sources.some((item) => item.url === fallbackUrl)) {
          sources.push({ url: fallbackUrl, label: 'jelölt XMLTV' });
        }
      }
    }

    if (!sourceSucceeded && !target.cancelled) {
      appLog(`EPG-ÁLLAPOT (${code}): egyik szolgáltatói XMLTV-forrásból sem érkezett műsor a kiválasztott ország csatornáihoz.`);
    }
    if (target.cancelled || generation !== countryGuideGeneration) return;
    const countryChannels = Array.from(target.acceptedIds).filter((key) => (index.get(key) || []).length > 0).length;
    const programmeCount = Array.from(target.acceptedIds).reduce((count, key) => count + (index.get(key) || []).length, 0);
    loadedAt = Date.now();
    loadedProviderId = provider.id;
    appLog(`EPG-ÁLLAPOT (${code}): ideiglenes feldolgozás kész – ${countryChannels} csatorna, ${programmeCount} műsor. Csak a memóriában marad; kilépéskor törlődik.`);
    notifyGuideListeners();
  } catch (error) {
    if (!target.cancelled) {
      lastError = error instanceof Error ? error.message : String(error);
      appLogError(`EPG ország (${code})`, error);
    }
  } finally {
    if (activeCountryEpgTarget === target) activeCountryEpgTarget = null;
    loading = null;
    releaseLoading();
  }
}

/**
 * A csatorna XMLTV-kulcsa: `epg_channel_id`, majd név-egyeztetés.
 *
 * 2.5.267 (#14): a NYILVÁNOS EPG újságok (epgshare01, iptv-org…) más
 * azonosítókat használnak, mint a panel (pl. „TV2.hu” vs. a panel saját
 * epg_channel_id-je), ezért az ID csak akkor jó, ha tényleg szerepel az
 * indexben – különben név alapján keresünk tovább. A „[HU] TV2” névből
 * normalizeName után „hutv2” lesz, ezért a vezető „hu” (országjelző)
 * levágott változatát is próbáljuk („tv2”), így a nyilvános újság
 * display-name-jei („TV2”) is betalálnak.
 */
function guideKeyFor(channel: { epgChannelId?: string | null; name?: string }): string | null {
  const id = (channel.epgChannelId || '').trim();
  const nameKey = normalizeName(channel.name || '');
  const candidates: string[] = [];
  if (id) {
    const low = id.toLowerCase();
    candidates.push(low);
    // 2.5.268 (#1-es napló): a nyilvános újságok „.hu” végű azonosítókat
    // használnak („TV2.hu”), a panel viszont gyakran csak sima nevet vagy
    // számot ad – ezért a pont nélküli ID-hez a „.hu” végűt, a „.hu”-s ID-hez
    // a csupasz változatot is próbáljuk.
    if (!low.includes('.')) candidates.push(`${low}.hu`);
    if (low.endsWith('.hu')) candidates.push(low.slice(0, -3));
  }
  if (nameKey) {
    candidates.push(nameKey);
    if (nameKey.startsWith('hu') && nameKey.length > 2) candidates.push(nameKey.slice(2));
    // 2.5.268 (#1-es napló): a „Spiler” márkát a panel „SPIELER”-rel írja –
    // a helyesírási változatot is próbáljuk (mindkét oldal normalizálva).
    const spilerVariant = nameKey.replace(/spieler/g, 'spiler');
    if (spilerVariant !== nameKey) candidates.push(spilerVariant);
  }
  /*
   * 2.5.270 (#3-as napló): az iptv-org alapú magyar újságok az azonosítók végén
   * „@SD”/„@HD”/„@Hungary” utótagot használnak („Viasat2.hu@SD”) – a panel
   * epg_channel_id-jéből is levágjuk ezt az utótagot.
   */
  if (id) {
    const lowId = id.toLowerCase();
    if (lowId.includes('@')) {
      const base = lowId.slice(0, lowId.indexOf('@'));
      if (base) candidates.push(base);
    }
  }
  /*
   * 2.5.269–2.5.270 (#2/#3-as napló): a beépített HU EPG azonosítótáblák
   * (huEpgIds.ts: epgshare01 HU1 + iptv-org magyar idők, ugyanaz a logika, mint a
   * csatornalogóknál): a magyar csatorna neve alapján közvetlenül a nyilvános
   * újság (.hu végű) azonosítójára képezünk – akkor is működik, ha az újság
   * display-name-je másképp írja a csatornát.
   */
  if (channel.name) {
    for (const huEpgId of getHuEpgIds(channel.name)) candidates.push(huEpgId.toLowerCase());
  }
  // először közvetlenül az indexben, aztán a display-name → id leképezésen
  for (const candidate of candidates) {
    if (index.has(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    const viaName = nameToId.get(candidate);
    if (viaName && index.has(viaName)) return viaName;
  }
  return null;
}

/** 24 órás, nyelvfüggetlen idő (a rövid EPG-vel azonos formátum). */
function time24(seconds: number): string {
  // 2.5.297: magyar idő (a néző bárhol él, a magyar műsorújság ugyanazt mutatja).
  return formatBudapestTime(seconds);
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
 * 2.5.267 (#14): lefedettség – a lista hány csatornájához van műsor a
 * betöltött újságban (külön a magyar [HU] csatornák), hogy a naplóból
 * pontosan látszódjon, hány magyar adóra van újság.
 */
/*
 * 2.5.269 (#2-es napló): a magyar csatornák „szondája" – a nyilvános EPG
 * forrásoknál minden forrás után naplózzuk, hány magyar adónak lett műsora.
 */
function currentHuTargetFingerprint(): string {
  return huProbeChannels
    .map((ch) => `${String(ch.epgChannelId || '').trim().toLowerCase()}|${normalizeName(ch.name || '')}`)
    .sort()
    .join(';')
    .slice(0, 8192);
}

export function setGuideHuProbe(
  channels: Array<{ name?: string; epgChannelId?: string | null; countryCode?: string }>,
): void {
  huProbeChannels = (Array.isArray(channels) ? channels : [])
    .filter((ch) => (ch.countryCode || '').toUpperCase() === 'HU');
  huTargetNameSet.clear();
  huTargetIdSet.clear();
  for (const channel of huProbeChannels) {
    const name = normalizeName(channel.name || '');
    if (name) {
      huTargetNameSet.add(name);
      if (name.startsWith('hu') && name.length > 2) huTargetNameSet.add(name.slice(2));
      const spilerVariant = name.replace(/spieler/g, 'spiler');
      if (spilerVariant !== name) huTargetNameSet.add(spilerVariant);
    }
    const rawId = String(channel.epgChannelId || '').trim().toLowerCase();
    if (rawId) {
      const base = channelIdBase(rawId);
      huTargetIdSet.add(base);
      huTargetIdSet.add(base.endsWith('.hu') ? base.slice(0, -3) : `${base}.hu`);
    }
  }
}

function huProbeCoverage(): { hit: number; total: number } {
  let hit = 0;
  for (const ch of huProbeChannels) if (guideKeyFor(ch)) hit += 1;
  return { hit, total: huProbeChannels.length };
}

/*
 * 2.5.273 (#5-ös napló): „kevés magyar adót fed le” – a visszatöltött újság
 * lehet teljes és friss, mégis hiányozhatnak belőle a magyar adók (a #5-ös
 * naplóban a memóriában 1039 csatorna volt, és csak 89/107 magyar adónak jutott
 * műsor, mert a frissnek minősített mentés nem a HU-forrásokból jött). Ilyenkor
 * a mentés NEM számít frissnek: frissítünk, és a nyilvános HU újságok is
 * lefutnak. Tesztben (nincs szonda) a régi viselkedés marad.
 */
function huCoverageLow(): boolean {
  if (huProbeChannels.length === 0) return false;
  const { hit, total } = huProbeCoverage();
  return hit < Math.max(1, Math.floor(total * 0.9));
}

export function guideChannelCoverage(
  channels: Array<{ name?: string; epgChannelId?: string | null; countryCode?: string }>,
  huMissingMax = 30,
): { total: number; withGuide: number; huTotal: number; huWithGuide: number; huMissing: string[] } {
  let withGuide = 0;
  let huTotal = 0;
  let huWithGuide = 0;
  const huMissing: string[] = [];
  for (const channel of Array.isArray(channels) ? channels : []) {
    const isHu = (channel.countryCode || '').toUpperCase() === 'HU';
    const hit = Boolean(guideKeyFor(channel));
    if (hit) withGuide += 1;
    if (isHu) {
      huTotal += 1;
      if (hit) huWithGuide += 1;
      /* 2.5.269 (#2): a még műsor nélküli magyar adók nevei – hogy a
         huEpgIds táblát ki lehessen egészíteni (max huMissingMax név).
         2.5.270: a „##### … #####” csoportfejlécek kihagyva (nem valódi adó). */
      else if (huMissing.length < huMissingMax && channel.name && !channel.name.trim().startsWith('#####')) huMissing.push(channel.name);
    }
  }
  return { total: Array.isArray(channels) ? channels.length : 0, withGuide, huTotal, huWithGuide, huMissing };
}

/**
 * Szolgáltatóváltáskor / frissítéskor a régi műsorújság eldobása.
 *
 * A tartós mentést is töröljük (különben a régi szolgáltató műsora jelenne meg
 * az újnál), és a következő letöltés nem a mentésből indul.
 */
export function clearGuide(): void {
  const wasCountryActive = Boolean(activeCountryEpgTarget);
  if (wasCountryActive) clearCountryGuideMemory();
  else {
    index.clear();
    nameToId.clear();
    buffer = '';
    scannedUpTo = 0;
    loadedAt = 0;
    loadedProviderId = '';
    lastEmptyGuideAt = 0;
    lastProgrammes = 0;
    lastSkipped = 0;
    lastBytes = 0;
    skipRestore = false;
    huChannelIdSet.clear();
    void clearPersistedGuide(); // kizárólag a régi közös tár; a HU saját tár érintetlen.
    void clearLegacyCountryGuideStorage();
  }
}


/*
 * 2.5.259 (#9): PER-CSATORNÁS EPG HÁTTÉR (get_simple_data_table).
 *
 * A #8 napló szerint ezen a panelen a teljes XMLTV letöltés ÜRES (0 bájt,
 * 0 csatorna), ezért a műsorújság egyáltalán nem jelent meg. Ha a nagy
 * XMLTV üres, itt az első N csatornára (a lista eleje = magyar csatornák)
 * külön-külön kérjük le a műsort, 2 munkással, 80 ms késleltetéssel – az
 * eredmény ugyanabba az indexbe és tartós tárba kerül, mint az XMLTV-é,
 * így a sárga csík és az EPG ablak is működik.
 */
export async function ensureChannelsEpg(
  provider: ProviderRef,
  channels: Array<{ name?: string; epgChannelId?: string | null; streamId?: number; streamUrl?: string; countryCode?: string }>,
  max = 250,
): Promise<number> {
  if (!provider || provider.type !== 'xtream' || !provider.serverUrl || !provider.username || !provider.password) {
    // 2.5.265 (#12): naplózva, hogy a következő kézi naplóból látszódjon, miért nem indul.
    appLog(`EPG-ÁLLAPOT: per-csatornás EPG (get_simple_data_table) kihagyva – provider típus=${provider?.type || 'nincs'} (csak xtream providerhez létezik ez a végpont).`);
    return 0;
  }
  if (loading) return 0; // épp töltődik a teljes műsorújság
  // 2.5.338 (HU külön): a magyar külön EPG-re (countryCode=HU) a szolgáltató
  // get_simple_data_table NEM keveredik – HU-ra kizárólag a nyilvános HU
  // források (epgshare01 HU1 / aldork04 / iptv-epg.org HU) adnak műsort.
  // Ezért HU módban (van HU szonda és a nyilvános HU források élnek) a
  // per-csatornás szolgáltatói tartalékot kihagyjuk. Tesztben
  // (PUBLIC_GUIDES_ENABLED=false) a régi viselkedés marad, hogy a
  // tesztek a mock per-csatornás választ használhassák.
  if (PUBLIC_GUIDES_ENABLED) {
    appLog('EPG-ÁLLAPOT (HU külön): get_simple_data_table tiltva – a magyar EPG kizárólag a saját nyilvános HU forrásaiból érkezik.');
    return 0;
  }
  /*
   * 2.5.269 (#2-es napló): teljes újság már van – csak akkor kérünk per-csatornás
   * EPG-t, ha az csak RÉSZLEGES visszatöltésből áll (üres xmltv.php után).
   */
  if (index.size > 0 && !restoredPartial) return 0;
  /*
   * 2.5.269 (#2-es kérés): CSAK a magyar ([HU]) csatornák kapnak EPG-t – semmi
   * másra nem kérünk a paneltől műsort.
   */
  const targets = (Array.isArray(channels) ? channels : [])
    .filter((ch) => (ch.countryCode || '').toUpperCase() === 'HU' && streamIdFor(ch))
    .slice(0, max);
  if (!targets.length) return 0;
  appLog(`EPG-ÁLLAPOT: a teljes XMLTV üres – per-csatornás get_simple_data_table háttér indul (${targets.length} csatornára).`);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const channel = targets[cursor++];
      const streamId = streamIdFor(channel);
      if (!streamId) continue;
      try {
        const entries = await loadSimpleEpg(provider, streamId);
        const key = guideKeyFor(channel) || normalizeName(channel.name || '');
        if (key && entries.length) {
          const nowSec = Math.floor(Date.now() / 1000);
          const list = entries
            .filter((entry) => entry.title && entry.end > nowSec - KEEP_BEFORE_SEC && entry.start <= nowSec + KEEP_AFTER_SEC)
            .map((entry) => ({ s: entry.start, e: entry.end, t: entry.title }))
            .sort((a, b) => a.s - b.s)
            .slice(0, KEEP_ENTRIES_PER_CHANNEL);
          if (list.length) index.set(key, list);
        }
      } catch { /* egy csatorna hibája nem állítja le a többit */ }
      if (cursor % 50 === 0) {
        appLog(`EPG-ÁLLAPOT: get_simple_data_table háttér: ${cursor}/${targets.length} csatorna kész, eddig ${index.size} kapott műsort.`);
        if (index.size > 0) {
          await persistGuide(provider.id, false);
          notifyGuideListeners();
        }
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
    }
  };
  await Promise.all([worker(), worker()]);
  if (index.size > 0) {
    await persistGuide(provider.id, true);
    notifyGuideListeners();
  }
  appLog(`EPG-ÁLLAPOT: get_simple_data_table háttér KÉSZ: ${index.size} csatorna kapott műsort (${targets.length} kérés).`);
  return index.size;
}
