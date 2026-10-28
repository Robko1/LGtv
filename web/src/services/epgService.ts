/**
 * EPG (műsorújság) betöltése az Xtream szolgáltatótól.
 *
 * Az Xtream API a `get_short_epg` végponton adja a csatorna következő műsorait.
 * A kérések drágák (minden csatorna külön kérés), ezért:
 *   - csak a látható/aktuális csatornára kérünk,
 *   - az eredményt 5 percig gyorsítótárazzuk,
 *   - a nagy betöltés idején (providerRefreshActive) NEM indítunk EPG kérést,
 *     hogy ne foglalja a szolgáltató kapcsolatait.
 */

import { ProviderRef } from './contentStore';
import { appLog } from './appLog';
import { xtreamService } from './xtreamService';

export interface EpgEntry {
  id: string;
  title: string;
  description: string;
  /** Unix idő másodpercben (0 = a szolgáltató nem adott időpontot). */
  start: number;
  end: number;
  /**
   * A szolgáltató „éppen most fut” jelzője (Xtream `now_playing`).
   * Egyes panelek egyáltalán nem adnak időbélyeget, csak ezt a jelzőt –
   * ilyenkor a műsorcím akkor is megjeleníthető, hogy nem találgatunk
   * időpontot.
   */
  nowPlaying?: number;
}

export interface EpgNowNext {
  now?: { title: string; time: string; startTimestamp: number; endTimestamp: number };
  next?: { title: string; time: string };
}

const CACHE_TTL_MS = 15 * 60 * 1000;
/**
 * A gyorsítótár felső korlátja.
 *
 * FONTOS (memória/fagyás): korábban a tároló korlátlanul nőtt. Húsz­ezer
 * csatornás listánál a háttérben letöltött műsorok több tíz megabájtot
 * foglaltak, és a TV böngészőfolyamata emiatt leállt. A legrégebben
 * használt bejegyzéseket dobjuk el.
 */
const CACHE_MAX_ENTRIES = 1200;
const cache = new Map<string, { at: number; entries: EpgEntry[] }>();
// Az App és a csatornalista ugyanazt a műsort is kérheti induláskor.
// Egy csatornához egyszerre csak egy hálózati EPG-kérés fusson.
const inFlight = new Map<string, Promise<EpgEntry[]>>();
/** Egyszeri naplózás arról, melyik EPG-végpont ad valódi adatot ezen a panelen. */
let simpleEpgWorksLogged = false;
let simpleEpgBrokenLogged = false;

function trimCache(): void {
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

function decodeBase64(value: string | undefined): string {
  if (!value) return '';
  try {
    const binary = atob(value);
    return new TextDecoder('utf-8').decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return value;
  }
}

function toTimestamp(value: string | number | undefined, fallback: string | undefined): number {
  const ts = Number(value);
  if (Number.isFinite(ts) && ts > 0) return ts;
  const parsed = fallback ? Date.parse(fallback) : NaN;
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : 0;
}

export function epgCacheKey(provider: ProviderRef, streamId: number | string): string {
  // A cache különüljön el szolgáltatónként és felhasználónként is: azonos szerveren
  // több IPTV-fiók eltérő EPG-t adhat. Frissítés/import előtt az App üríti a cache-t.
  return `${provider.id}|${provider.serverUrl || ''}|${provider.username || ''}|${streamId}`;
}

/** Az EPG azonosító a csatornából: Xtream stream id vagy a stream URL-ből. */
export function streamIdFor(channel: { streamId?: number; streamUrl?: string }): string | null {
  if (channel.streamId) return String(channel.streamId);
  if (!channel.streamUrl) return null;
  const match = channel.streamUrl.match(/\/live\/[^/]+\/[^/]+\/(\d+)(?:\.(?:ts|m3u8))?(?:\?|$)/i);
  return match ? match[1] : null;
}

export function clearEpgCache(): void {
  cache.clear();
  // Szolgáltatóváltásnál a végpont-diagnózis is újraíródhat a naplóba.
  simpleEpgWorksLogged = false;
  simpleEpgBrokenLogged = false;
}

/** A már letöltött EPG-adatot lejárattól függetlenül is kiolvassuk,
 * hogy a csatornasáv műsorcíme az idő múlásával automatikusan továbbléphessen. */
export function getCachedShortEpg(
  provider: ProviderRef | null,
  streamId: number | string,
  limit = 6
): EpgEntry[] {
  if (!provider) return [];
  return cache.get(epgCacheKey(provider, streamId) + `|${limit}`)?.entries ?? [];
}

/** Rövid EPG (néhány következő műsor) egy csatornához, gyorsítótárazva. */
export async function loadShortEpg(
  provider: ProviderRef | null,
  streamId: number | string,
  limit = 6
): Promise<EpgEntry[]> {
  if (!provider || provider.type !== 'xtream' || !provider.serverUrl || !provider.username || !provider.password) {
    return [];
  }
  const key = epgCacheKey(provider, streamId) + `|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async (): Promise<EpgEntry[]> => {
    let items = await xtreamService.shortEpg(
      provider.serverUrl!,
      provider.username!,
      provider.password!,
      streamId,
      limit
    );
    /*
     * ÜRES `get_short_epg` – MÁSODIK VÉGPONT (2.5.168).
     *
     * A #38–#42 naplók bizonyítják, hogy ezen a panelen a `get_short_epg`
     * MINDEN csatornára 19 bájt: `{"epg_listings":[]}`. Emiatt a sárga csík
     * soha nem tudott megjelenni. A `get_simple_data_table` ugyanazt az
     * `epg_listings` szerkezetet adja, de csatornánként és teljes napra –
     * ha ezt a panel kiszolgálja, másodpercek alatt van műsor.
     *
     * A napló EGYSZER írja le, melyik végpont adja az adatot (nem kérésenként).
     */
    if (!items.length) {
      try {
        items = await xtreamService.simpleEpg(
          provider.serverUrl!,
          provider.username!,
          provider.password!,
          streamId
        );
        if (items.length && !simpleEpgWorksLogged) {
          simpleEpgWorksLogged = true;
          appLog(
            `EPG: a rövid EPG végpont üres, a get_simple_data_table végpont adja a műsort `
            + `(első csatorna: ${items.length} műsor) – ezt használjuk a látható csatornákra.`
          );
        }
      } catch (error) {
        if (!simpleEpgBrokenLogged) {
          simpleEpgBrokenLogged = true;
          appLog(
            `EPG: a get_simple_data_table végpont sem ad adatot – `
            + `${error instanceof Error ? error.message : String(error)}; marad a teljes műsorújság (XMLTV).`
          );
        }
      }
    }

    const entries: EpgEntry[] = items.map((item, index) => ({
      id: String(item.id ?? index),
      title: decodeBase64(item.title) || 'Névtelen műsor',
      description: decodeBase64(item.description) || '',
      start: toTimestamp(item.start_timestamp, item.start),
      end: toTimestamp(item.stop_timestamp, item.end),
      nowPlaying: Number(item.now_playing) === 1 ? 1 : 0,
    }));

    cache.set(key, { at: Date.now(), entries });
    trimCache();
    return entries;
  })();

  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(key) === request) inFlight.delete(key);
  }
}

/**
 * 24 ÓRÁS, NYELVFÜGGETLEN IDŐ („12:35”).
 *
 * A korábbi `toLocaleTimeString([], …)` a készülék nyelvét használta, a
 * webOS-on ez gyakran en-US: az EPG-ben „12:35 PM – 01:15 PM” jelent meg egy
 * magyar felületen. A kézi formázás minden készüléken ugyanazt adja, és nem
 * függ a telepített nyelvi csomagoktól (régi webOS-on az Intl hiányos).
 */
export function formatTime24(seconds: number): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '--:--';
  const date = new Date(value * 1000);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  return `${hours < 10 ? '0' : ''}${hours}:${minutes < 10 ? '0' : ''}${minutes}`;
}

function fmtRange(start: number, end: number): string {
  return `${formatTime24(start)} - ${formatTime24(end)}`;
}

/** A most futó és a következő műsor kiválasztása az EPG listából. */
export function nowNextFromEpg(entries: EpgEntry[], at: number = Date.now()): EpgNowNext {
  if (!entries.length) return {};
  const nowSec = Math.floor(at / 1000);
  let now = entries.find((entry) => entry.start <= nowSec && entry.end > nowSec) || null;
  if (!now) {
    // Ha nincs pontos találat, a legközelebbi jövőbeli műsort vesszük "most"-nak.
    now = entries.find((entry) => entry.start > nowSec) || null;
  }
  if (!now) {
    /*
     * IDŐBÉLYEG NÉLKÜLI PANEL.
     *
     * Néhány Xtream panel a `get_short_epg` válaszban csak címeket és a
     * „now_playing” jelzőt adja, időpontot nem. Korábban ilyenkor MINDEN
     * adat elveszett (az EPG üresen maradt), pedig a műsorcím valódi adat.
     * Ilyenkor a most futó műsort mutatjuk, időpont nélkül („--:--”).
     */
    const flagged = entries.find((entry) => entry.nowPlaying === 1) || entries[0];
    if (!flagged || !flagged.title) return {};
    return {
      now: {
        title: flagged.title,
        time: `${formatTime24(flagged.start)} - ${formatTime24(flagged.end)}`,
        startTimestamp: 0,
        endTimestamp: 0,
      },
    };
  }
  const next = entries.find((entry) => entry.start >= (now as EpgEntry).end) || null;
  return {
    now: now
      ? {
          title: now.title,
          time: fmtRange(now.start, now.end),
          startTimestamp: now.start,
          endTimestamp: now.end,
        }
      : undefined,
    next: next ? { title: next.title, time: fmtRange(next.start, next.end) } : undefined,
  };
}
