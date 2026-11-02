import { appLog } from './appLog';
import { HU_EMBEDDED_LOGOS, HU_EMBEDDED_LOGO_COUNT } from '../generatedHuLogos';

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
 * countries/hungary mappa). 2.5.261 óta a képek be vannak építve a bundle-be
 * (lásd huLogo alább), ez a távoli cím már csak TARTALÉK (ha egy új logó még
 * nincs beépítve, innen töltődik le, amíg be nem kerül a generált fájlba).
 *
 * Kulcs = normalizeChannelName(csatornanév) a „hu” előtag NÉLKÜL (a keresés
 * a teljes és az előtag nélküli változatot is próbálja, lásd getHuChannelLogo).
 * A localStorage felülírás (iptv_rt_hu_logos_v1) build nélkül is működik.
 */
const TV_LOGOS_HU = 'https://raw.githubusercontent.com/tv-logo/tv-logos/master/countries/hungary/';

/*
 * 2.5.261 (#10-es napló): a TELJES magyar logótár (96 PNG) és a hiányzó márkák
 * nemzetközi változatai BEÉPÍTVE, data-URL-ként a bundle-ben (generatedHuLogos).
 * A #10-es napló CSATORNALOGÓ-HIBA sorai bizonyítják, hogy a TV sem a
 * raw.githubusercontent.com-ot, sem a picons szervereket nem éri el megbízhatóan,
 * ezért a távoli URL önmagában nem elég. A huLogo() először a beépített képet
 * adja vissza; ha az nincs, a régi távoli URL marad tartalékként.
 */
function huLogo(slug: string): string {
  return HU_EMBEDDED_LOGOS[slug] || `${TV_LOGOS_HU}${slug}.png`;
}

export const HU_CHANNEL_LOGOS: Record<string, string> = {
  '9tv': huLogo('9tv-hu'),
  'amc': huLogo('amc-hu'),
  'arena4': huLogo('arena4-hu'),
  'atv extra': huLogo('atv-extra-hu'),
  'atv': huLogo('atv-hu'),
  'axn': huLogo('axn-hu'),
  'balkanika music television': huLogo('balkanika-music-television-hu'),
  'cinemax': huLogo('cinemax-hu'),
  'cinemax2': huLogo('cinemax2-hu'),
  'comedy central family': huLogo('comedy-central-family-hu'),
  'cool tv': huLogo('cool-tv-hu'),
  'd1': huLogo('d1-hu'),
  'da vinci': huLogo('da-vinci-hu'),
  'dikh tv': huLogo('dikh-tv-hu'),
  'duna': huLogo('duna-hu'),
  'duna world': huLogo('duna-world-hu'),
  'epic drama': huLogo('epic-drama-hu'),
  'estv': huLogo('estv-hu'),
  'fem3': huLogo('fem3-hu'),
  'film cafe': huLogo('film-cafe-hu'),
  'film plus': huLogo('film-plus-hu'),
  'film4': huLogo('film4-hu'),
  'filmbox extra': huLogo('filmbox-extra-hu'),
  'filmbox family': huLogo('filmbox-family-hu'),
  'filmbox': huLogo('filmbox-hu'),
  'filmbox premium': huLogo('filmbox-premium-hu'),
  'filmbox stars': huLogo('filmbox-stars-hu'),
  'fix': huLogo('fix-hu'),
  'galaxy4': huLogo('galaxy4-hu'),
  'game toon': huLogo('game-toon-hu'),
  'hbo': huLogo('hbo-hu'),
  'hbo2': huLogo('hbo2-hu'),
  'hbo3': huLogo('hbo3-hu'),
  'hir tv': huLogo('hir-tv-hu'),
  'izaura tv': huLogo('izaura-tv-hu'),
  'jocky tv': huLogo('jocky-tv-hu'),
  'life tv': huLogo('life-tv-hu'),
  'm1': huLogo('m1-hu'),
  'm2': huLogo('m2-hu'),
  'm2 petofi': huLogo('m2-petofi-hu'),
  'm4 sport': huLogo('m4-sport-hu'),
  'm4 sport plus': huLogo('m4-sport-plus-hu'),
  'm5': huLogo('m5-hu'),
  'magyar mozi tv': huLogo('magyar-mozi-tv-hu'),
  'match4': huLogo('match4-hu'),
  'max4': huLogo('max4-hu'),
  'mezzo': huLogo('mezzo-hu'),
  'minimax': huLogo('minimax-hu'),
  'movies 24': huLogo('movies-24-hu'),
  'mozi plus': huLogo('mozi-plus-hu'),
  'moziverzum': huLogo('moziverzum-hu'),
  'music plus': huLogo('music-plus-hu'),
  'muzsika tv': huLogo('muzsika-tv-hu'),
  'ozone tv': huLogo('ozone-tv-hu'),
  'paramount network': huLogo('paramount-network-hu'),
  'prime': huLogo('prime-hu'),
  'rakosmente tv': huLogo('rakosmente-tv-hu'),
  'rtl gold': huLogo('rtl-gold-hu'),
  'rtl harom': huLogo('rtl-harom-hu'),
  'rtl': huLogo('rtl-hu'),
  'rtl ketto': huLogo('rtl-ketto-hu'),
  'slager tv': huLogo('slager-tv-hu'),
  'sorozat plus': huLogo('sorozat-plus-hu'),
  'spektrum home': huLogo('spektrum-home-hu'),
  'spektrum': huLogo('spektrum-hu'),
  'spiler 1': huLogo('spiler-1-hu'),
  'spiler 2': huLogo('spiler-2-hu'),
  'spiler extra': huLogo('spiler-extra-hu'),
  'sport1': huLogo('sport1-hu'),
  'sport2': huLogo('sport2-hu'),
  'sport3': huLogo('sport3-hu'),
  'story4': huLogo('story4-hu'),
  'super one': huLogo('super-one-hu'),
  'the fishing and hunting channel': huLogo('the-fishing-and-hunting-channel-hu'),
  'travelxp': huLogo('travelxp-hu'),
  'tv paprika': huLogo('tv-paprika-hu'),
  'tv10': huLogo('tv10-hu'),
  'tv2 comedy': huLogo('tv2-comedy-hu'),
  'tv2': huLogo('tv2-hu'),
  'tv2 kids': huLogo('tv2-kids-hu'),
  'tv2 klub': huLogo('tv2-klub-hu'),
  'tv2 sef': huLogo('tv2-sef-hu'),
  'tv2 sport': huLogo('tv2-sport-hu'),
  'tv2 sport plus': huLogo('tv2-sport-plus-hu'),
  'tv2 super': huLogo('tv2-super-hu'),
  'tv4': huLogo('tv4-hu'),
  'ujbuda tv': huLogo('ujbuda-tv-hu'),
  'viasat explore': huLogo('viasat-explore-hu'),
  'viasat film': huLogo('viasat-film-hu'),
  'viasat history': huLogo('viasat-history-hu'),
  'viasat nature': huLogo('viasat-nature-hu'),
  'viasat2': huLogo('viasat2-hu'),
  'viasat3': huLogo('viasat3-hu'),
  'viasat6': huLogo('viasat6-hu'),
  'vixen': huLogo('vixen-hu'),
  'zenebutik': huLogo('zenebutik-hu'),
  'rtl klub': huLogo('rtl-hu'),
  'rtl ii': huLogo('rtl-ketto-hu'),
  'rtl2': huLogo('rtl-ketto-hu'),
  'rtl 3': huLogo('rtl-harom-hu'),
  /*
   * 2.5.255 (#8-as napló, 21:37: 107 HU csatorna): név-aliaszok azokhoz a
   * csatornákhoz, amelyek neve nem egyezik a logófájl nevével (pl. AXN
   * Black → axn-hu.png, Arena 4 → arena4-hu.png). Minden URL .png-re végződik.
   */
  'axn black': huLogo('axn-hu'),
  'axn white': huLogo('axn-hu'),
  'axn ce': huLogo('axn-hu'),
  'cool': huLogo('cool-tv-hu'),
  'arena 4': huLogo('arena4-hu'),
  'story 4': huLogo('story4-hu'),
  'fishing and hunting': huLogo('the-fishing-and-hunting-channel-hu'),
  'ozone network': huLogo('ozone-tv-hu'),
  'spieler tv': huLogo('spiler-1-hu'),
  'spieler2 tv': huLogo('spiler-2-hu'),
  'viasat nature history': huLogo('viasat-nature-hu'),
  /*
   * 2.5.261 (#10-es napló): a LOGÓ-HIÁNY / CSATORNALOGÓ-HIBA listában szereplő
   * csatornákhoz a magyar mappában nincs fájl – hozzájuk a beépített
   * nemzetközi (int / UK / regionális) változatot rendeljük (ext-… kulcsok).
   * A keresőkulcs a normalizált név; a minősítő utótagokat (uhd/hd/tv/channel)
   * a logoKeyCandidates levágja, ezért itt a rövid alak is elég.
   */
  'animal planet': huLogo('ext-animal-planet'),
  'auto motor sport': huLogo('ext-auto-motor-sport'),
  'bbc earth': huLogo('ext-bbc-earth'),
  'boomerang': huLogo('ext-boomerang'),
  'cartoon network': huLogo('ext-cartoon-network'),
  'cartoonito': huLogo('ext-cartoonito'),
  'discovery channel': huLogo('ext-discovery-channel'),
  'discovery investigation': huLogo('ext-discovery-investigation'),
  'disney channel': huLogo('ext-disney-channel'),
  'disney jr': huLogo('ext-disney-jr'),
  'duck tv': huLogo('ext-duck-tv'),
  'duck': huLogo('ext-duck-tv'),
  'e entertainment': huLogo('ext-e-entertainment'),
  'eurosport': huLogo('ext-eurosport'),
  'eurosport 2': huLogo('ext-eurosport-2'),
  'food network': huLogo('ext-food-network'),
  'history': huLogo('ext-history'),
  'jimjam': huLogo('ext-jimjam'),
  'love nature': huLogo('ext-love-nature'),
  'nat geo': huLogo('ext-nat-geo'),
  'nat geo wild': huLogo('ext-nat-geo-wild'),
  'nickelodeon': huLogo('ext-nickelodeon'),
  'nickelodeon europe': huLogo('ext-nickelodeon'),
  'nick jr': huLogo('ext-nick-jr'),
  'sony max': huLogo('ext-sony-max'),
  'sony movie': huLogo('ext-sony-movie'),
  'tlc': huLogo('ext-tlc'),
  'travel channel': huLogo('ext-travel-channel'),
  'travel': huLogo('ext-travel-channel'),
  'xtreme sport': huLogo('ext-xtreme-sport'),
  'film mania': huLogo('ext-film-mania'),
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
          // 2.5.261: data:image/ felülírás is engedett (a beépített logó kézzel cserélhető).
          if (typeof url === 'string' && /^(?:https?:\/\/|data:image\/)/i.test(url)) parsed[String(key)] = url;
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

/* ------------------------------------------------------------------
 * 2.5.257 (#8 visszajelzés): a HU logók KÉPEI is tartósan, helyben
 * (localStorage, data-URL-ként) élnek – nem csak az URL-leképezés. Így
 * újraindítás után a logók rögtön, hálózati kérés és „átrendeződés” nélkül
 * jelennek meg, ugyanúgy helyben, mint a csatornák induláskor.
 * ------------------------------------------------------------------ */
const HU_LOGO_IMG_KEY = 'iptv_rt_hu_logo_img_v1';
/* A localStorage kvótája korlátos: összesen legfeljebb ~3 MB képi adat. */
const HU_LOGO_IMG_MAX_CHARS = 3_000_000;

let imgCache: Record<string, string> | null = null;

function readImgCache(): Record<string, string> {
  if (imgCache) return imgCache;
  const parsed: Record<string, string> = {};
  try {
    const raw = localStorage.getItem(HU_LOGO_IMG_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, dataUrl] of Object.entries(value)) {
          if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) parsed[String(key)] = dataUrl;
        }
      }
    }
  } catch { /* sérült tároló esetén csak üres gyorsítótár */ }
  imgCache = parsed;
  return parsed;
}

/** Elmentett (data-URL) kép egy HU logó-URL-hez – újraindítás után azonnal. */
export function getHuLogoCachedImage(url: string): string | undefined {
  if (!url) return undefined;
  return readImgCache()[url];
}

/** Egy letöltött logókép tartós mentése data-URL-ként (kvótabarátan). */
export async function saveHuLogoCachedImage(url: string, blob: Blob): Promise<void> {
  try {
    if (!url || !blob || !blob.size || blob.size > 400_000) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('FileReader hiba'));
      reader.readAsDataURL(blob);
    });
    if (!dataUrl.startsWith('data:image/')) return;
    const cache = readImgCache();
    if (cache[url] === dataUrl) return;
    cache[url] = dataUrl;
    try {
      const serialized = JSON.stringify(cache);
      if (serialized.length > HU_LOGO_IMG_MAX_CHARS) return; // tele a kvóta
      localStorage.setItem(HU_LOGO_IMG_KEY, serialized);
      imgCache = cache;
    } catch { /* tele a kvóta: a kép ekkor csak a CacheStorage-ban él */ }
  } catch { /* a mentési hiba nem akadályozhatja a megjelenítést */ }
}

/** Letölti és tartósan (data-URL-ként) elmenti egy HU logó képét. */
export async function cacheHuLogoDataUrl(url: string): Promise<void> {
  try {
    if (!/^https?:\/\//i.test(url)) return;
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok || response.type === 'opaque') return;
    await saveHuLogoCachedImage(url, await response.blob());
  } catch { /* a háttértároló mentése nem kritikus */ }
}

/**
 * 2.5.257: induláskor a feloldható HU logó-URL-eket EGYBEN véglegesítjük a
 * helyi tárolóban (iptv_rt_hu_logos_v1) – így a leképezés újraindítás után
 * azonnal, hálózat és keresés nélkül a localStorage-ból jön, mint a
 * csatornák. Visszaadja, hány új leképezést írtunk.
 */
export function persistHuLogoOverrides(channels: Array<{ name: string; countryCode?: string }>): number {
  if (!Array.isArray(channels) || !channels.length) return 0;
  const overrides = { ...readOverrides() };
  let count = 0;
  for (const channel of channels) {
    if (!channel || (channel.countryCode || '').toUpperCase() !== 'HU') continue;
    const logo = getHuChannelLogo(channel.name);
    const key = normalizeChannelName(channel.name);
    /*
     * 2.5.261 (#10): csak a TÁVOLI (http/https) leképezéseket írjuk tartósan a
     * tárolóba – a beépített (data-URL) logók a bundle-ben úgyis ott vannak,
     * így a localStorage nem telik meg feleslegesen.
     */
    if (logo && /^https?:\/\//i.test(logo) && key && overrides[key] !== logo) {
      overrides[key] = logo;
      count += 1;
    }
  }
  if (count) {
    overridesCache = overrides;
    try {
      localStorage.setItem(LOCAL_OVERRIDES_KEY, JSON.stringify(overrides));
    } catch { /* kvóta esetén a memóriában marad */ }
  }
  return count;
}

/** Van-e saját (beépített vagy helyi) logó ehhez a magyar csatornához? */
export function hasHuChannelLogo(name: string): boolean {
  return Boolean(getHuChannelLogo(name));
}

/**
 * 2.5.261 (#10): induláskor a logótár mérete a naplóba – a következő kézi
 * naplóból pontosan látszik, HÁNY logó van a tárolóban (beépített data-URL-ek
 * + localStorage felülírások + képi gyorsítótár) és hány kulcs a táblában.
 * A „HU-LOGÓ-TÁR” előtag nincs a mérési szűrőben, így MÉRÉS KI-nál is megmarad.
 */
export function logHuLogoStore(context: string): void {
  let overrideCount = 0;
  let imgCacheCount = 0;
  try { overrideCount = Object.keys(readOverrides()).length; } catch { /* néha nincs még tároló */ }
  try { imgCacheCount = Object.keys(readImgCache()).length; } catch { /* néha nincs még tároló */ }
  appLog(
    `HU-LOGÓ-TÁR [${context}]: beépített=${HU_EMBEDDED_LOGO_COUNT}, tábla-kulcs=${Object.keys(HU_CHANNEL_LOGOS).length}, `
    + `felülírás=${overrideCount}, képi gyorsítótár=${imgCacheCount}.`
  );
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
