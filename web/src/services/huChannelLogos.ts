import { appLog } from './appLog';

/**
 * SAJÁT MAGYAR CSATORNALOGÓ-TÁR (2.5.245).
 *
 * A szolgáltató NEM minden magyar (HU) csatornához ad logót (stream_icon),
 * és a hiányzó képeket a kézi napló LOGÓ-HIÁNY soraiból tudjuk kilistázni.
 * A hiányzó magyar logókat innen töltjük le (pl. egy publikus logógyűjteményből),
 * és ide tesszük be őket – innen szolgáljuk ki őket, CSAK a magyar csatornákhoz:
 *
 *   - a beépített HU_CHANNEL_LOGOS táblába (kulcs: normalizált csatornanév),
 *   - vagy futás közben a helyi tárolóba (localStorage 'iptv_rt_hu_logos_v1'
 *     kulcs, JSON: { "normalizált név": "https://.../logo.png" }).
 *
 * A kereséshez a csatorna nevét normalizáljuk (kisbetű, ékezet és írásjel
 * nélkül), így „M1 HD”, „m1 hd” és „M1-HD” ugyanazt a bejegyzést találja.
 * A tároló csak HU csatornákhoz használható: a hívó helye (ChannelLogo)
 * csak akkor kérdez rá, ha a csatorna országkódja 'HU'.
 */

/** Csatornanév normalizálása kereséshez: kisbetű, ékezet és nem-betű/szám nélkül. */
export function normalizeChannelName(name: string): string {
  try {
    return String(name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  } catch {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
}

/*
 * A magyar logók publikus gyűjteménye (tv-logo/tv-logos GitHub-tár,
 * countries/hungary mappa) – közvetlenül raw GitHub URL-ként tölthetők le,
 * így a TV-n nincs szükség külön letöltő lépésre.
 *
 * Kulcs = normalizeChannelName(csatornanév) a „hu” előtag NÉLKÜL (a keresés
 * a teljes és az előtag nélküli változatot is próbálja, lásd getHuChannelLogo).
 * A localStorage felülírás (iptv_rt_hu_logos_v1) build nélkül is működik.
 */
const TV_LOGOS_HU = 'https://raw.githubusercontent.com/tv-logo/tv-logos/master/countries/hungary/';

export const HU_CHANNEL_LOGOS: Record<string, string> = {
  '9tv': `${TV_LOGOS_HU}9tv-hu`,
  'amc': `${TV_LOGOS_HU}amc-hu`,
  'arena4': `${TV_LOGOS_HU}arena4-hu`,
  'atv extra': `${TV_LOGOS_HU}atv-extra-hu`,
  'atv': `${TV_LOGOS_HU}atv-hu`,
  'axn': `${TV_LOGOS_HU}axn-hu`,
  'balkanika music television': `${TV_LOGOS_HU}balkanika-music-television-hu`,
  'cinemax': `${TV_LOGOS_HU}cinemax-hu`,
  'cinemax2': `${TV_LOGOS_HU}cinemax2-hu`,
  'comedy central family': `${TV_LOGOS_HU}comedy-central-family-hu`,
  'cool tv': `${TV_LOGOS_HU}cool-tv-hu`,
  'd1': `${TV_LOGOS_HU}d1-hu`,
  'da vinci': `${TV_LOGOS_HU}da-vinci-hu`,
  'dikh tv': `${TV_LOGOS_HU}dikh-tv-hu`,
  'duna': `${TV_LOGOS_HU}duna-hu`,
  'duna world': `${TV_LOGOS_HU}duna-world-hu`,
  'epic drama': `${TV_LOGOS_HU}epic-drama-hu`,
  'estv': `${TV_LOGOS_HU}estv-hu`,
  'fem3': `${TV_LOGOS_HU}fem3-hu`,
  'film cafe': `${TV_LOGOS_HU}film-cafe-hu`,
  'film plus': `${TV_LOGOS_HU}film-plus-hu`,
  'film4': `${TV_LOGOS_HU}film4-hu`,
  'filmbox extra': `${TV_LOGOS_HU}filmbox-extra-hu`,
  'filmbox family': `${TV_LOGOS_HU}filmbox-family-hu`,
  'filmbox': `${TV_LOGOS_HU}filmbox-hu`,
  'filmbox premium': `${TV_LOGOS_HU}filmbox-premium-hu`,
  'filmbox stars': `${TV_LOGOS_HU}filmbox-stars-hu`,
  'fix': `${TV_LOGOS_HU}fix-hu`,
  'galaxy4': `${TV_LOGOS_HU}galaxy4-hu`,
  'game toon': `${TV_LOGOS_HU}game-toon-hu`,
  'hbo': `${TV_LOGOS_HU}hbo-hu`,
  'hbo2': `${TV_LOGOS_HU}hbo2-hu`,
  'hbo3': `${TV_LOGOS_HU}hbo3-hu`,
  'hir tv': `${TV_LOGOS_HU}hir-tv-hu`,
  'izaura tv': `${TV_LOGOS_HU}izaura-tv-hu`,
  'jocky tv': `${TV_LOGOS_HU}jocky-tv-hu`,
  'life tv': `${TV_LOGOS_HU}life-tv-hu`,
  'm1': `${TV_LOGOS_HU}m1-hu`,
  'm2': `${TV_LOGOS_HU}m2-hu`,
  'm2 petofi': `${TV_LOGOS_HU}m2-petofi-hu`,
  'm4 sport': `${TV_LOGOS_HU}m4-sport-hu`,
  'm4 sport plus': `${TV_LOGOS_HU}m4-sport-plus-hu`,
  'm5': `${TV_LOGOS_HU}m5-hu`,
  'magyar mozi tv': `${TV_LOGOS_HU}magyar-mozi-tv-hu`,
  'match4': `${TV_LOGOS_HU}match4-hu`,
  'max4': `${TV_LOGOS_HU}max4-hu`,
  'mezzo': `${TV_LOGOS_HU}mezzo-hu`,
  'minimax': `${TV_LOGOS_HU}minimax-hu`,
  'movies 24': `${TV_LOGOS_HU}movies-24-hu`,
  'mozi plus': `${TV_LOGOS_HU}mozi-plus-hu`,
  'moziverzum': `${TV_LOGOS_HU}moziverzum-hu`,
  'music plus': `${TV_LOGOS_HU}music-plus-hu`,
  'muzsika tv': `${TV_LOGOS_HU}muzsika-tv-hu`,
  'ozone tv': `${TV_LOGOS_HU}ozone-tv-hu`,
  'paramount network': `${TV_LOGOS_HU}paramount-network-hu`,
  'prime': `${TV_LOGOS_HU}prime-hu`,
  'rakosmente tv': `${TV_LOGOS_HU}rakosmente-tv-hu`,
  'rtl gold': `${TV_LOGOS_HU}rtl-gold-hu`,
  'rtl harom': `${TV_LOGOS_HU}rtl-harom-hu`,
  'rtl': `${TV_LOGOS_HU}rtl-hu`,
  'rtl ketto': `${TV_LOGOS_HU}rtl-ketto-hu`,
  'slager tv': `${TV_LOGOS_HU}slager-tv-hu`,
  'sorozat plus': `${TV_LOGOS_HU}sorozat-plus-hu`,
  'spektrum home': `${TV_LOGOS_HU}spektrum-home-hu`,
  'spektrum': `${TV_LOGOS_HU}spektrum-hu`,
  'spiler 1': `${TV_LOGOS_HU}spiler-1-hu`,
  'spiler 2': `${TV_LOGOS_HU}spiler-2-hu`,
  'spiler extra': `${TV_LOGOS_HU}spiler-extra-hu`,
  'sport1': `${TV_LOGOS_HU}sport1-hu`,
  'sport2': `${TV_LOGOS_HU}sport2-hu`,
  'sport3': `${TV_LOGOS_HU}sport3-hu`,
  'story4': `${TV_LOGOS_HU}story4-hu`,
  'super one': `${TV_LOGOS_HU}super-one-hu`,
  'the fishing and hunting channel': `${TV_LOGOS_HU}the-fishing-and-hunting-channel-hu`,
  'travelxp': `${TV_LOGOS_HU}travelxp-hu`,
  'tv paprika': `${TV_LOGOS_HU}tv-paprika-hu`,
  'tv10': `${TV_LOGOS_HU}tv10-hu`,
  'tv2 comedy': `${TV_LOGOS_HU}tv2-comedy-hu`,
  'tv2': `${TV_LOGOS_HU}tv2-hu`,
  'tv2 kids': `${TV_LOGOS_HU}tv2-kids-hu`,
  'tv2 klub': `${TV_LOGOS_HU}tv2-klub-hu`,
  'tv2 sef': `${TV_LOGOS_HU}tv2-sef-hu`,
  'tv2 sport': `${TV_LOGOS_HU}tv2-sport-hu`,
  'tv2 sport plus': `${TV_LOGOS_HU}tv2-sport-plus-hu`,
  'tv2 super': `${TV_LOGOS_HU}tv2-super-hu`,
  'tv4': `${TV_LOGOS_HU}tv4-hu`,
  'ujbuda tv': `${TV_LOGOS_HU}ujbuda-tv-hu`,
  'viasat explore': `${TV_LOGOS_HU}viasat-explore-hu`,
  'viasat film': `${TV_LOGOS_HU}viasat-film-hu`,
  'viasat history': `${TV_LOGOS_HU}viasat-history-hu`,
  'viasat nature': `${TV_LOGOS_HU}viasat-nature-hu`,
  'viasat2': `${TV_LOGOS_HU}viasat2-hu`,
  'viasat3': `${TV_LOGOS_HU}viasat3-hu`,
  'viasat6': `${TV_LOGOS_HU}viasat6-hu`,
  'vixen': `${TV_LOGOS_HU}vixen-hu`,
  'zenebutik': `${TV_LOGOS_HU}zenebutik-hu`,
  'rtl klub': `${TV_LOGOS_HU}rtl-hu.png`,
  'rtl ii': `${TV_LOGOS_HU}rtl-ketto-hu.png`,
  'rtl2': `${TV_LOGOS_HU}rtl-ketto-hu.png`,
  'rtl 3': `${TV_LOGOS_HU}rtl-harom-hu.png`,
};

const LOCAL_OVERRIDES_KEY = 'iptv_rt_hu_logos_v1';

let overridesCache: Record<string, string> | null = null;

function readOverrides(): Record<string, string> {
  if (overridesCache) return overridesCache;
  let parsed: Record<string, string> = {};
  try {
    const raw = localStorage.getItem(LOCAL_OVERRIDES_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, url] of Object.entries(value)) {
          if (typeof url === 'string' && /^https?:\/\//i.test(url)) parsed[String(key)] = url;
        }
      }
    }
  } catch { /* sérült tároló esetén csak a beépített táblát használjuk */ }
  overridesCache = parsed;
  return parsed;
}

/** Beállít egy helyi felülírást (pl. tesztből vagy beállításból). */
export function setHuChannelLogoOverride(name: string, url: string): void {
  const overrides = { ...readOverrides() };
  overrides[normalizeChannelName(name)] = url;
  overridesCache = overrides;
  try {
    localStorage.setItem(LOCAL_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch { /* a TV kvótája esetén a memóriában marad */ }
}

/** Van-e saját (beépített vagy helyi) logó ehhez a magyar csatornához? */
export function hasHuChannelLogo(name: string): boolean {
  return Boolean(getHuChannelLogo(name));
}

/*
 * 2.5.253: a keresési kulcsjelöltek – először a teljes normalizált név,
 * majd a „hu” előtag, majd a végéről levágott minősítő utótagok nélkül
 * („[HU] M1 UHD” → „hu m1 uhd” → „m1 uhd” → „m1”), így a táblában elég
 * a rövid természetes név is.
 */
function logoKeyCandidates(key: string): string[] {
  const out: string[] = [];
  const push = (value: string): void => { if (value && !out.includes(value)) out.push(value); };
  push(key);
  let current = key.replace(/^hu\s+/, '');
  push(current);
  const suffixes = ['uhd', 'fhd', 'hd', 'sd', 'tv', 'channel'];
  let changed = true;
  while (changed && current) {
    changed = false;
    for (const suffix of suffixes) {
      const re = new RegExp(`\\s+${suffix}$`);
      if (re.test(current)) {
        current = current.replace(re, '');
        push(current);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Saját magyar csatornalogó keresése név alapján (csak HU csatornákhoz használandó). */
export function getHuChannelLogo(name: string): string | undefined {
  const key = normalizeChannelName(name);
  if (!key) return undefined;
  const overrides = readOverrides();
  for (const candidate of logoKeyCandidates(key)) {
    const found = overrides[candidate] || HU_CHANNEL_LOGOS[candidate];
    if (found) return found;
  }
  return undefined;
}

/**
 * LOGÓ-HIÁNY JELENTÉS a kézi naplóba (2.5.245).
 *
 * A kézi naplózás bekapcsolása után ez pontosan felsorolja, melyik HU
 * csatornához NINCS megjeleníthető logó – sem a szolgáltatótól (channel.logo
 * üres), sem a saját tárolónkból. Ezeket kell majd letölteni és a
 * HU_CHANNEL_LOGOS táblába (vagy a helyi tárolóba) tenni.
 */
export function logMissingHuLogos(channels: Array<{ name: string; categoryName?: string; countryCode?: string; logo?: string }>, context: string, maxList = 80): void {
  // appLog csak aktív kézi naplózásnál ír – különben nulla plusz munka.
  let huTotal = 0;
  let huWithProviderLogo = 0;
  let huWithCustomLogo = 0;
  const missing: string[] = [];
  for (const channel of channels) {
    if ((channel.countryCode || '').toUpperCase() !== 'HU') continue;
    huTotal += 1;
    const providerLogo = (channel.logo || '').trim();
    if (providerLogo) {
      huWithProviderLogo += 1;
      continue;
    }
    if (getHuChannelLogo(channel.name)) {
      huWithCustomLogo += 1;
      continue;
    }
    if (missing.length < maxList) {
      missing.push(`${channel.name}${channel.categoryName ? ` (${channel.categoryName})` : ''}`);
    }
  }
  if (!huTotal) return;
  /*
   * 2.5.253 (#6): a kézi naplóba kiírjuk AZ ÖSSZES magyar csatorna nevét és
   * normalizált kulcsát is – ez alapján tölthető fel a saját logótár
   * (HU_CHANNEL_LOGOS / iptv_rt_hu_logos_v1), így induláskor a magyar logók
   * már helyben vannak, internetes kérés nélkül.
   */
  const allNames: string[] = [];
  for (const channel of channels) {
    if ((channel.countryCode || '').toUpperCase() !== 'HU') continue;
    if (allNames.length < 150) allNames.push(`${channel.name} => ${normalizeChannelName(channel.name)}`);
  }
  if (allNames.length) {
    appLog(`HU CSATORNANEVEK [${context}] (${allNames.length} db, saját logótárhoz): ${allNames.join(' | ')}`);
  }
  appLog(
    `LOGÓ-HIÁNY [${context}]: HU csatornák összesen=${huTotal}, szolgáltatói logóval=${huWithProviderLogo}, ` +
    `saját tárolóból=${huWithCustomLogo}, HIÁNYZÓ=${huTotal - huWithProviderLogo - huWithCustomLogo}.`
  );
  if (missing.length) {
    appLog(`LOGÓ-HIÁNY [${context}] hiányzó logójú magyar csatornák (ezeket kell letölteni): ${missing.join(' | ')}`);
  }
}
