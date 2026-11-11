/**
 * 2.5.298 – „TÖRLÉS A MEMÓRIÁBÓL” a Mozi/Sorozat poszterek piros kuka ikonjával.
 *
 * A felhasználó kérése: a poszter jobb felső sarkában lévő piros kukával a
 * film (vagy sorozat) kerüljön ki a TV saját memóriájából, és a következő
 * visszatöltésnél se jöjjön vissza.
 *
 * MIÉRT NEM ÍRJUK ÚJRA AZONNAL A 100 EZRES LISTÁT:
 * a teljes filmkatalógus újraírása a TV-n 30+ másodpercig tartana, ezért a
 * törlés egy kisméretű, tartós „eltávolított azonosítók” jegyzéket vezet
 * (localStorage, szolgáltatónként és fajtánként). Ez a jegyzék a
 * visszatöltéskor és a mentéskor is érvényesül, így a törölt elem nem
 * kerül vissza a memóriába, és a lista a következő automatikus mentésnél
 * már nélküle íródik ki.
 */

export type VodRemovalKind = 'movie' | 'series';

const STORAGE_KEY = 'lg-vod-removals-v1';
/** Egy fajtánként megtartott azonosító felső korlátja (memória/tárhely védelem). */
const MAX_IDS_PER_KIND = 20000;

interface RemovalsByProvider {
  movie?: string[];
  series?: string[];
}

interface RemovalsState {
  v: 1;
  byProvider: Record<string, RemovalsByProvider>;
}

let cache: RemovalsState | null = null;
/** providerId|kind → azonosítók halmaza (gyors szűréshez). */
const indexCache = new Map<string, Set<string>>();

function emptyState(): RemovalsState {
  return { v: 1, byProvider: {} };
}

function backend(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readState(): RemovalsState {
  if (cache) return cache;
  try {
    const raw = backend()?.getItem(STORAGE_KEY);
    if (!raw) {
      cache = emptyState();
      return cache;
    }
    const parsed = JSON.parse(raw) as RemovalsState;
    if (!parsed || typeof parsed !== 'object' || !parsed.byProvider || typeof parsed.byProvider !== 'object') {
      cache = emptyState();
      return cache;
    }
    const clean: RemovalsState = { v: 1, byProvider: {} };
    for (const [providerId, entry] of Object.entries(parsed.byProvider)) {
      if (!providerId || !entry || typeof entry !== 'object') continue;
      const movie = Array.isArray(entry.movie) ? entry.movie.filter((id) => typeof id === 'string' && id) : [];
      const series = Array.isArray(entry.series) ? entry.series.filter((id) => typeof id === 'string' && id) : [];
      if (movie.length || series.length) clean.byProvider[providerId] = { movie, series };
    }
    cache = clean;
    return cache;
  } catch {
    cache = emptyState();
    return cache;
  }
}

function writeState(state: RemovalsState): void {
  cache = state;
  try {
    backend()?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* A tárhely-kvóta hibája nem akadályozhatja a törlést: a memóriabeli
       jegyzék ebben a munkamenetben akkor is érvényes marad. */
  }
}

function indexKey(providerId: string, kind: VodRemovalKind): string {
  return `${providerId || ''}|${kind}`;
}

/** Az adott szolgáltatóhoz és fajtához tartozó eltávolított azonosítók. */
export function getRemovedVodIds(providerId: string | undefined | null, kind: VodRemovalKind): Set<string> {
  const id = String(providerId || '');
  const key = indexKey(id, kind);
  const cached = indexCache.get(key);
  if (cached) return cached;
  const state = readState();
  const list = state.byProvider[id]?.[kind] || [];
  const set = new Set(list);
  indexCache.set(key, set);
  return set;
}

/** Hány elemet távolított el a felhasználó ebből a fajtából. */
export function countRemovedVod(providerId: string | undefined | null, kind: VodRemovalKind): number {
  return getRemovedVodIds(providerId, kind).size;
}

/**
 * Egy (vagy több) elem eltávolítása a TV memóriájából.
 * Visszatérés: hány ÚJ azonosító került a jegyzékbe.
 */
export function removeVodFromMemory(
  providerId: string | undefined | null,
  kind: VodRemovalKind,
  ids: string | readonly string[],
): number {
  const id = String(providerId || '');
  const list = typeof ids === 'string' ? [ids] : [...ids];
  const state = readState();
  const entry: RemovalsByProvider = state.byProvider[id] || {};
  const current = Array.isArray(entry[kind]) ? entry[kind]! : [];
  const seen = new Set(current);
  let added = 0;
  for (const value of list) {
    const clean = typeof value === 'string' ? value.trim() : '';
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    current.push(clean);
    added += 1;
  }
  if (!added) return 0;
  // A legrégebbi azonosítók esnek ki, hogy a jegyzék ne hízhasson meg.
  while (current.length > MAX_IDS_PER_KIND) current.shift();
  entry[kind] = current;
  state.byProvider[id] = entry;
  writeState(state);
  indexCache.set(indexKey(id, kind), new Set(current));
  return added;
}

/** Egy lista szűrése az eltávolított elemek nélkül (új tömb, ha kell). */
export function filterRemovedVod<T extends { id: string }>(
  providerId: string | undefined | null,
  kind: VodRemovalKind,
  items: readonly T[],
): T[] {
  if (!Array.isArray(items) || items.length === 0) return items as T[];
  const removed = getRemovedVodIds(providerId, kind);
  if (removed.size === 0) return items as T[];
  const out = items.filter((item) => !removed.has(item.id));
  return out.length === items.length ? (items as T[]) : out;
}

/** A jegyzék teljes törlése (pl. szolgáltató törlésekor vagy gyorsítótár-ürítéskor). */
export function clearRemovedVod(providerId?: string | null): void {
  if (!providerId) {
    cache = emptyState();
    indexCache.clear();
    writeState(cache);
    return;
  }
  const id = String(providerId);
  const state = readState();
  if (state.byProvider[id]) {
    delete state.byProvider[id];
    writeState(state);
  }
  indexCache.delete(indexKey(id, 'movie'));
  indexCache.delete(indexKey(id, 'series'));
}
