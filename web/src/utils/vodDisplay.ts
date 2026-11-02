import { UNKNOWN_LANGUAGE } from '../services/vodMetadata';

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
