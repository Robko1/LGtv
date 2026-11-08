import { UNKNOWN_LANGUAGE, parseMovieCatalogMetadata } from '../services/vodMetadata';
import type { Movie } from '../types/iptv';

/**
 * A szolgáltató által visszaadott, megjeleníthető nyelvnevek.
 *
 * Az „Ismeretlen” nem valódi hangsáv-/feliratnyelv, ezért a poszterkártyán és
 * a részletek-ablakban nem jelenítjük meg. Üres vagy formailag hibás értékből
 * sem készül semmilyen kitalált címke.
 */
export function visibleLanguages(values?: readonly string[] | null): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const label = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    if (!label || label === UNKNOWN_LANGUAGE) continue;
    const key = label.toLocaleLowerCase('hu');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * Játékidő szövege a felülethez, mindig percben (pl. 120 → „120 perc”).
 *
 * Hiányzó (0) adatnál üres szöveget ad, így a nézet nem jelenít meg kitalált
 * értéket.
 */
export function formatRuntime(minutes?: number | null): string {
  const value = Math.round(Number(minutes) || 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  return `${value} perc`;
}

/**
 * 2.5.392 – A MOZI-PLAKÁT JÁTÉKIDEJE a MÁR ELMENTETT szolgáltatói adatból.
 *
 * A `durationMinutes` a lista (`get_vod_streams`) feldolgozásakor kerül a
 * tartós sorba, és a `decodeMovies()` vissza is fejti. Előfordul viszont, hogy
 * a lista nem adja meg a játékidőt, de a később megnyitott és SZINTÉN
 * elmentett `get_vod_info` válasz (`detailProviderData`) igen. Ebben az
 * esetben sem kérünk új adatot: a mentett nyers válaszból olvassuk ki.
 */
export function movieRuntimeLabel(
  movie: Pick<Movie, 'durationMinutes' | 'providerData' | 'detailProviderData'>,
): string {
  const direct = formatRuntime(movie?.durationMinutes);
  if (direct) return direct;
  for (const raw of [movie?.detailProviderData, movie?.providerData]) {
    if (!raw || typeof raw !== 'object') continue;
    try {
      const label = formatRuntime(parseMovieCatalogMetadata(raw).durationMinutes);
      if (label) return label;
    } catch { /* a nyers szolgáltatói adat sosem akadályozhatja a kártyát */ }
  }
  return '';
}

/**
 * Nyelvlista tömör szövege a poszterkártyára (legfeljebb `max` nyelv, utána
 * „+N” jelzéssel). Üres listánál üres szöveg.
 */
export function joinLanguages(values?: readonly string[] | null, max = 3): string {
  const list = visibleLanguages(values);
  if (!list.length) return '';
  if (list.length <= max) return list.join(' • ');
  return `${list.slice(0, max).join(' • ')} +${list.length - max}`;
}

/**
 * A poszterkártya hangnyelv-sora (2.5.236, a felhasználó kérése):
 *
 *  - ha a film/sorozat nyelvei között VAN MAGYAR, az mindig ELÖL jelenik meg
 *    (korábban a hosszú listák „Angol • Ukrán • … +N” alakban elrejtették);
 *  - a magyar után az angol következik, majd a többi nyelv eredeti sorrendben;
 *  - ha egyetlen ismert hangnyelv sincs mentve, „Angol” a felirat – a
 *    legvalószínűbb alapértelmezés; lejátszás közben úgyis kiderül a valódi
 *    hangsávlista.
 */
export function cardAudioLabel(values?: readonly string[] | null, max = 3): string {
  const list = visibleLanguages(values);
  if (!list.length) return 'Angol';
  const rank = (label: string): number => {
    if (/magyar|hungar|^hun?$/i.test(label)) return 0;
    if (/angol|english|^eng?$/i.test(label)) return 1;
    return 2;
  };
  const ordered = list
    .map((label, index) => ({ label, index, rank: rank(label) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.label);
  if (ordered.length <= max) return ordered.join(' • ');
  return `${ordered.slice(0, max).join(' • ')} +${ordered.length - max}`;
}

/**
 * 2.5.298 – KIADÁSI ÉV SZERINTI SORREND (a legfrissebb év elöl).
 *
 * A felhasználó kérése: a Mozi és a Sorozatok nézet a kiadási év szerint
 * csökkenő sorrendben jelenjen meg (2026 → 2025 → 2024 …), a legfrissebb
 * évvel a rács tetején. A filmeknél/sorozatoknál az év a mentett `year`
 * mezőből jön; ha az hiányzik, a cím végén álló „(2024)” alakból olvassuk ki.
 * Az év nélküli elemek a lista VÉGÉRE kerülnek, egymás között az eredeti
 * sorrendjükben (stabil, kiszámítható sorrend).
 */
export function releaseYearOf(item?: { year?: number; title?: string } | null): number {
  if (!item) return 0;
  const explicit = Math.round(Number(item.year) || 0);
  if (Number.isFinite(explicit) && explicit > 1800) return explicit;
  const match = String(item.title || '').match(/\((1[89]\d{2}|20\d{2})\)\s*$/);
  return match ? Number(match[1]) : 0;
}

export function sortByReleaseYearDesc<T extends { year?: number; title?: string }>(items: readonly T[]): T[] {
  if (!Array.isArray(items) || items.length < 2) return items as T[];
  const decorated = items.map((item, index) => ({ item, index, year: releaseYearOf(item) }));
  decorated.sort((a, b) => {
    // 1) legfrissebb év elöl; 2) év nélküli a végére; 3) azonos évnél
    //    az eredeti sorrend (a régi webOS motorok nem mindig stabilak).
    if (a.year !== b.year) {
      if (a.year === 0) return 1;
      if (b.year === 0) return -1;
      return b.year - a.year;
    }
    return a.index - b.index;
  });
  return decorated.map((entry) => entry.item);
}
