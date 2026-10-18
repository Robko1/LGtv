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

export function flagFor(value: string): FlagInfo {
  const text = (value || '').trim();
  for (const rule of RULES) {
    if (rule.test.test(text)) return rule.info;
  }
  return { flag: '📺', country: 'Nemzetközi', countryCode: 'INT' };
}
