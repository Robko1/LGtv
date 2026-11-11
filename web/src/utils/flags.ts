/** Zászló és ország megállapítása a kategória vagy csatorna nevéből. */

export interface FlagInfo {
  flag: string;
  country: string;
  countryCode: string;
}

const RULES: Array<{ test: RegExp; info: FlagInfo }> = [
  { test: /(magyar|hungary|hungarian|\bhu\b)/i, info: { flag: '🇭🇺', country: 'Magyarország', countryCode: 'HU' } },
  { test: /(német|nemet|german|germany|deutschland|\bde\b)/i, info: { flag: '🇩🇪', country: 'Németország', countryCode: 'DE' } },
  { test: /(angol|english|united kingdom|\buk\b|\bgb\b)/i, info: { flag: '🇬🇧', country: 'Egyesült Királyság', countryCode: 'GB' } },
  { test: /(\busa\b|america|american|united states)/i, info: { flag: '🇺🇸', country: 'USA', countryCode: 'US' } },
  { test: /(francia|french|france)/i, info: { flag: '🇫🇷', country: 'Franciaország', countryCode: 'FR' } },
  { test: /(spanyol|spanish|spain)/i, info: { flag: '🇪🇸', country: 'Spanyolország', countryCode: 'ES' } },
  { test: /(olasz|italian|italy|italia)/i, info: { flag: '🇮🇹', country: 'Olaszország', countryCode: 'IT' } },
  { test: /(osztrák|osztr|austria|österreich)/i, info: { flag: '🇦🇹', country: 'Ausztria', countryCode: 'AT' } },
  { test: /(román|roman|romania)/i, info: { flag: '🇷🇴', country: 'Románia', countryCode: 'RO' } },
  { test: /(szlovák|slovak|slovakia)/i, info: { flag: '🇸🇰', country: 'Szlovákia', countryCode: 'SK' } },
  { test: /(lengyel|polish|poland|polska)/i, info: { flag: '🇵🇱', country: 'Lengyelország', countryCode: 'PL' } },
  { test: /(török|torok|turkish|turkey|türkiye)/i, info: { flag: '🇹🇷', country: 'Törökország', countryCode: 'TR' } },
  { test: /(orosz|russian|russia)/i, info: { flag: '🇷🇺', country: 'Oroszország', countryCode: 'RU' } },
  { test: /(arab|arabic)/i, info: { flag: '🇸🇦', country: 'Arab', countryCode: 'AR' } },
  { test: /(albán|albanian|albania)/i, info: { flag: '🇦🇱', country: 'Albánia', countryCode: 'AL' } },
  { test: /(szerb|serbian|serbia)/i, info: { flag: '🇷🇸', country: 'Szerbia', countryCode: 'RS' } },
  { test: /(horvát|horvat|croatian|croatia)/i, info: { flag: '🇭🇷', country: 'Horvátország', countryCode: 'HR' } },
  { test: /(szlovén|slovenian|slovenia)/i, info: { flag: '🇸🇮', country: 'Szlovénia', countryCode: 'SI' } },
  { test: /(görög|greek|greece)/i, info: { flag: '🇬🇷', country: 'Görögország', countryCode: 'GR' } },
  { test: /(holland|dutch|netherlands)/i, info: { flag: '🇳🇱', country: 'Hollandia', countryCode: 'NL' } },
  { test: /(portug|brazil|brazil)/i, info: { flag: '🇵🇹', country: 'Portugália', countryCode: 'PT' } },
  { test: /(svéd|swedish|sweden)/i, info: { flag: '🇸🇪', country: 'Svédország', countryCode: 'SE' } },
  { test: /(norvég|norwegian|norway)/i, info: { flag: '🇳🇴', country: 'Norvégia', countryCode: 'NO' } },
  { test: /(dán|danish|denmark)/i, info: { flag: '🇩🇰', country: 'Dánia', countryCode: 'DK' } },
  { test: /(finn|finland)/i, info: { flag: '🇫🇮', country: 'Finnország', countryCode: 'FI' } },
  { test: /(cseh|czech|česko)/i, info: { flag: '🇨🇿', country: 'Csehország', countryCode: 'CZ' } },
  { test: /(ukrán|ukran|ukrain)/i, info: { flag: '🇺🇦', country: 'Ukrajna', countryCode: 'UA' } },
  { test: /(izrael|israel|hebrew)/i, info: { flag: '🇮🇱', country: 'Izrael', countryCode: 'IL' } },
  { test: /(indiai|india|hindi)/i, info: { flag: '🇮🇳', country: 'India', countryCode: 'IN' } },
  { test: /(kínai|kinai|china|chinese)/i, info: { flag: '🇨🇳', country: 'Kína', countryCode: 'CN' } },
  { test: /(japán|japan|japanese)/i, info: { flag: '🇯🇵', country: 'Japán', countryCode: 'JP' } },
  { test: /(koreai|korea|korean)/i, info: { flag: '🇰🇷', country: 'Korea', countryCode: 'KR' } },
];

const INTERNATIONAL: FlagInfo = { flag: '📺', country: 'Nemzetközi', countryCode: 'INT' };

/*
 * ORSZÁGKÓD A NÉV ELEJÉN/VÉGÉN (2.5.244).
 *
 * A panelek gyakran így nevezik el a kategóriákat: „DE | HU”, „[HU] HUNGARIA”,
 * „AT-HU”, „Sport HU”. A kétbetűs ISO kódokat csak NAGYBETŰsen, elválasztó
 * után/ előtt fogadjuk el (így a „4K UHD” vagy „NO1” nem kód), és a
 * kategórianévben ELŐBB szereplő kód nyer („DE | HU” → DE, nem HU).
 */
const CODE_BY_ID: Record<string, FlagInfo> = {};
for (const rule of RULES) CODE_BY_ID[rule.info.countryCode] = rule.info;
const LEADING_CODE = /^\[?\s*([A-Z]{2})\s*\]?[\s\-|:/.–]/;
const TRAILING_CODE = /[\s\-|:/.–]\[?\s*([A-Z]{2})\s*\]?$/;

/*
 * EREDMÉNY-GYORSÍTÓTÁR (2.5.147).
 *
 * A 20 190 élő csatorna visszatöltésekor a `flagFor()` csatornánként végigfutott
 * a 32 szabályon (több százezer reguláris kifejezés a TV-n). A bemenet viszont
 * gyakorlatilag a KATEGÓRIA neve, amiből néhány száz van: elég egyszer
 * kiértékelni, utána táblából jön az eredmény. A tábla mérete korlátos, hogy
 * importtal érkező, tetszőleges nevek se növeljék a memóriát.
 */
const CACHE_LIMIT = 2000;
const cache = new Map<string, FlagInfo>();

export function flagFor(value: string): FlagInfo {
  const text = (value || '').trim();
  const cached = cache.get(text);
  if (cached) return cached;
  /*
   * A LEGKORÁBBI TALÁLAT NYER (2.5.244).
   *
   * Korábban az első szabály nyert, így egy vegyes nevű kategória (pl.
   * „DE | HU”, „USA | HU”) a magyar szabály miatt HU-ba került, és a benne
   * lévő külföldi csatornák a főoldalon a Magyarország csoportban jelentek
   * meg. Most minden szabályt kiértékelünk, és az az ország nyer, amelyiknek
   * a jelölése ELŐBB szerepel a névben („[HU] HUNGARIA” → HU, „DE | HU” → DE).
   * Egyenlő pozíciónál a szabálylista sorrendje dönt (ties → korábbi szabály).
   */
  let info = INTERNATIONAL;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const rule of RULES) {
    const match = rule.test.exec(text);
    if (match && match.index < bestIndex) {
      bestIndex = match.index;
      info = rule.info;
    }
  }
  /* A név eleji/végi nagybetűs országkód is versenyez a találatok közt. */
  const leadCode = LEADING_CODE.exec(text);
  if (leadCode) {
    const codeInfo = CODE_BY_ID[leadCode[1]];
    if (codeInfo && 0 < bestIndex) {
      bestIndex = 0;
      info = codeInfo;
    }
  }
  const trailCode = TRAILING_CODE.exec(text);
  if (trailCode) {
    const codeInfo = CODE_BY_ID[trailCode[1]];
    if (codeInfo && trailCode.index < bestIndex) {
      bestIndex = trailCode.index;
      info = codeInfo;
    }
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(text, info);
  return info;
}
