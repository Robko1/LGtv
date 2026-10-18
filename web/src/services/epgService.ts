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
import { xtreamService } from './xtreamService';

export interface EpgEntry {
  id: string;
  title: string;
  description: string;
  /** Unix idő másodpercben. */
  start: number;
  end: number;
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
 * foglaltak, és a WebView-renderelő folyamat emiatt leállt. A legrégebben
 * használt bejegyzéseket dobjuk el.
 */
const CACHE_MAX_ENTRIES = 1200;
const cache = new Map<string, { at: number; entries: EpgEntry[] }>();

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

  const items = await xtreamService.shortEpg(
    provider.serverUrl,
    provider.username,
    provider.password,
    streamId,
    limit
  );

  const entries: EpgEntry[] = items.map((item, index) => ({
    id: String(item.id ?? index),
    title: decodeBase64(item.title) || 'Névtelen műsor',
    description: decodeBase64(item.description) || '',
    start: toTimestamp(item.start_timestamp, item.start),
    end: toTimestamp(item.stop_timestamp, item.end),
  }));

  cache.set(key, { at: Date.now(), entries });
  trimCache();
  return entries;
}

function fmtRange(start: number, end: number): string {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  const s = start ? new Date(start * 1000).toLocaleTimeString([], opts) : '--:--';
  const e = end ? new Date(end * 1000).toLocaleTimeString([], opts) : '--:--';
  return `${s} - ${e}`;
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
  if (!now) return {};
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
