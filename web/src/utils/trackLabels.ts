/** Megjelenítési nevek; a lejátszó nyelvkódjait és sávazonosítóit nem módosítjuk. */
const LANGUAGE_NAMES: Record<string, string> = {
  hu: 'Magyar', hun: 'Magyar', magyar: 'Magyar', hungarian: 'Magyar',
  en: 'Angol', eng: 'Angol', english: 'Angol', angol: 'Angol',
  fr: 'Francia', fra: 'Francia', fre: 'Francia', french: 'Francia', francais: 'Francia', francia: 'Francia',
  de: 'Német', deu: 'Német', ger: 'Német', german: 'Német', deutsch: 'Német', nemet: 'Német',
  es: 'Spanyol', spa: 'Spanyol', spanish: 'Spanyol', espanol: 'Spanyol', spanyol: 'Spanyol',
  it: 'Olasz', ita: 'Olasz', italian: 'Olasz', olasz: 'Olasz',
  pl: 'Lengyel', pol: 'Lengyel', polish: 'Lengyel', lengyel: 'Lengyel',
  pt: 'Portugál', por: 'Portugál', portuguese: 'Portugál', portugal: 'Portugál',
  ro: 'Román', ron: 'Román', rum: 'Román', romanian: 'Román', roman: 'Román',
  ru: 'Orosz', rus: 'Orosz', russian: 'Orosz', orosz: 'Orosz',
  uk: 'Ukrán', ukr: 'Ukrán', ukrainian: 'Ukrán', ukran: 'Ukrán',
  nl: 'Holland', nld: 'Holland', dut: 'Holland', dutch: 'Holland', holland: 'Holland',
  cs: 'Cseh', ces: 'Cseh', cze: 'Cseh', czech: 'Cseh', cseh: 'Cseh',
  sk: 'Szlovák', slk: 'Szlovák', slo: 'Szlovák', slovak: 'Szlovák', szlovak: 'Szlovák',
  hr: 'Horvát', hrv: 'Horvát', croatian: 'Horvát', horvat: 'Horvát',
  sr: 'Szerb', srp: 'Szerb', serbian: 'Szerb', szerb: 'Szerb',
  sv: 'Svéd', swe: 'Svéd', swedish: 'Svéd', sved: 'Svéd',
  da: 'Dán', dan: 'Dán', danish: 'Dán',
  no: 'Norvég', nor: 'Norvég', norwegian: 'Norvég', norveg: 'Norvég',
  fi: 'Finn', fin: 'Finn', finnish: 'Finn', finn: 'Finn',
  tr: 'Török', tur: 'Török', turkish: 'Török', torok: 'Török',
  ar: 'Arab', ara: 'Arab', arabic: 'Arab', arab: 'Arab',
  ja: 'Japán', jpn: 'Japán', japanese: 'Japán', japan: 'Japán',
  ko: 'Koreai', kor: 'Koreai', korean: 'Koreai', koreai: 'Koreai',
  zh: 'Kínai', zho: 'Kínai', chi: 'Kínai', chinese: 'Kínai', kinai: 'Kínai',
  bg: 'Bolgár', bul: 'Bolgár', bulgarian: 'Bolgár', bolgar: 'Bolgár',
  sl: 'Szlovén', slv: 'Szlovén', slovenian: 'Szlovén', szloven: 'Szlovén',
  bs: 'Bosnyák', bos: 'Bosnyák', bosnian: 'Bosnyák', bosnyak: 'Bosnyák',
  el: 'Görög', ell: 'Görög', gre: 'Görög', greek: 'Görög', gorog: 'Görög',
  he: 'Héber', heb: 'Héber', hebrew: 'Héber', heber: 'Héber',
  hi: 'Hindi', hin: 'Hindi', hindi: 'Hindi',
  th: 'Thai', tha: 'Thai', thai: 'Thai',
  vi: 'Vietnámi', vie: 'Vietnámi', vietnamese: 'Vietnámi', vietnami: 'Vietnámi',
  id: 'Indonéz', ind: 'Indonéz', indonesian: 'Indonéz', indonez: 'Indonéz',
  is: 'Izlandi', isl: 'Izlandi', ice: 'Izlandi', icelandic: 'Izlandi', izlandi: 'Izlandi',
  et: 'Észt', est: 'Észt', estonian: 'Észt', eszt: 'Észt',
  lv: 'Lett', lav: 'Lett', latvian: 'Lett', lett: 'Lett',
  lt: 'Litván', lit: 'Litván', lithuanian: 'Litván', litvan: 'Litván',
  original: 'Eredeti', und: 'Ismeretlen', unknown: 'Ismeretlen',
};

function knownLanguage(value: string): string | undefined {
  const key = value.trim().toLowerCase().replace(/_/g, '-').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return LANGUAGE_NAMES[key] || (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})+$/i.test(key) ? LANGUAGE_NAMES[key.split('-')[0]] : undefined);
}

// Újabb TV-ken a többi ISO-kódot a platform magyar nyelvnév-készlete oldja
// fel; régi webOS-en a fenti táblázat működik, ismeretlen kódot nem találgatunk.
type LanguageNames = { of: (code: string) => string | undefined };
type LanguageNamesConstructor = {
  new (locales: string[], options: { type: 'language' }): LanguageNames;
  supportedLocalesOf: (locales: string[]) => string[];
};
let displayNames: LanguageNames | null | undefined;
function platformLanguage(code: string): string | undefined {
  if (!/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(code)) return undefined;
  if (displayNames === undefined) {
    displayNames = null;
    try {
      const ctor = (Intl as unknown as { DisplayNames?: LanguageNamesConstructor }).DisplayNames;
      if (ctor && ctor.supportedLocalesOf(['hu']).length) displayNames = new ctor(['hu'], { type: 'language' });
    } catch { /* régi webOS */ }
  }
  try {
    const name = displayNames?.of(code.replace(/_/g, '-'));
    if (name && name.toLowerCase() !== code.toLowerCase().replace(/_/g, '-')) {
      return name.charAt(0).toLocaleUpperCase('hu') + name.slice(1);
    }
  } catch { /* érvénytelen kód */ }
  return undefined;
}

/** Ismeretlen kódot változatlanul hagyunk, nem találunk ki nyelvet. */
export function trackLanguage(lang?: string): string {
  const raw = String(lang || '').trim();
  return raw ? knownLanguage(raw) || platformLanguage(raw) || raw : '';
}

/** Beszédes szolgáltatói sávnevet megtartunk, az önálló nyelvkódot lefordítjuk. */
export function trackLabel(name?: string, lang?: string, fallback = 'Hangsáv'): string {
  const rawName = String(name || '').trim();
  const rawLang = String(lang || '').trim();
  const generic = /^(?:hangsáv|sáv|felirat|track|(?:audio|subtitle)(?:\s+track)?)\s*#?\s*\d*$/i.test(rawName);
  const translatedName = knownLanguage(rawName);
  if (translatedName) return translatedName;
  // „English SDH” vagy „fr (forced)” – a részletek megmaradnak.
  const prefix = rawName.match(/^([a-zA-ZÀ-ž]{2,}(?:[-_][a-zA-Z0-9]{2,8})*)(?=[\s(\[])/);
  const translatedPrefix = prefix && knownLanguage(prefix[1]);
  if (prefix && translatedPrefix) return translatedPrefix + rawName.slice(prefix[1].length);
  if (rawName && !generic && !/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(rawName)) return rawName;
  return trackLanguage(rawLang) || rawName || fallback;
}

export function trackMeta(lang?: string, codec?: string, channels?: number | string): string {
  return [trackLanguage(lang), codec, channels].filter(Boolean).join(' / ');
}
