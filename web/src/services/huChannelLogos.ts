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
  // MTVA / közszolgálati
  'm1': `${TV_LOGOS_HU}m1-hu.png`,
  'm1 hd': `${TV_LOGOS_HU}m1-hu.png`,
  'm1 uhd': `${TV_LOGOS_HU}m1-hu.png`,
  'm2': `${TV_LOGOS_HU}m2-hu.png`,
  'm2 hd': `${TV_LOGOS_HU}m2-hu.png`,
  'm2 uhd': `${TV_LOGOS_HU}m2-hu.png`,
  'm2 petofi': `${TV_LOGOS_HU}m2-petofi-hu.png`,
  'm4 sport': `${TV_LOGOS_HU}m4-sport-hu.png`,
  'm4 sport plus': `${TV_LOGOS_HU}m4-sport-plus-hu.png`,
  'm4 uhd': `${TV_LOGOS_HU}m4-sport-hu.png`,
  'm5': `${TV_LOGOS_HU}m5-hu.png`,
  'm5 hd': `${TV_LOGOS_HU}m5-hu.png`,
  'm5 uhd': `${TV_LOGOS_HU}m5-hu.png`,
  'duna': `${TV_LOGOS_HU}duna-hu.png`,
  'duna world': `${TV_LOGOS_HU}duna-world-hu.png`,
  // RTL-csoport
  'rtl': `${TV_LOGOS_HU}rtl-hu.png`,
  'rtl klub': `${TV_LOGOS_HU}rtl-hu.png`,
  'rtl klub hd': `${TV_LOGOS_HU}rtl-hu.png`,
  'rtl klub uhd': `${TV_LOGOS_HU}rtl-hu.png`,
  'rtl gold': `${TV_LOGOS_HU}rtl-gold-hu.png`,
  'rtl ii': `${TV_LOGOS_HU}rtl-ketto-hu.png`,
  'rtl ii hd': `${TV_LOGOS_HU}rtl-ketto-hu.png`,
  'rtl ii uhd': `${TV_LOGOS_HU}rtl-ketto-hu.png`,
  'rtl ketto': `${TV_LOGOS_HU}rtl-ketto-hu.png`,
  'rtl ketto hd': `${TV_LOGOS_HU}rtl-ketto-hu.png`,
  'rtl2': `${TV_LOGOS_HU}rtl-ketto-hu.png`,
  'rtl 3': `${TV_LOGOS_HU}rtl-harom-hu.png`,
  'rtl harom': `${TV_LOGOS_HU}rtl-harom-hu.png`,
  // TV2-csoport
  'tv2': `${TV_LOGOS_HU}tv2-hu.png`,
  'tv2 comedy': `${TV_LOGOS_HU}tv2-comedy-hu.png`,
  'tv2 kids': `${TV_LOGOS_HU}tv2-kids-hu.png`,
  'tv2 klub': `${TV_LOGOS_HU}tv2-klub-hu.png`,
  'tv2 sef': `${TV_LOGOS_HU}tv2-sef-hu.png`,
  'tv2 sport': `${TV_LOGOS_HU}tv2-sport-hu.png`,
  'tv2 sport plus': `${TV_LOGOS_HU}tv2-sport-plus-hu.png`,
  'tv2 super': `${TV_LOGOS_HU}tv2-super-hu.png`,
  // egyéb gyakori magyar csatornák
  'atv': `${TV_LOGOS_HU}atv-hu.png`,
  'atv extra': `${TV_LOGOS_HU}atv-extra-hu.png`,
  'hir tv': `${TV_LOGOS_HU}hir-tv-hu.png`,
  'amc': `${TV_LOGOS_HU}amc-hu.png`,
  'dikh tv': `${TV_LOGOS_HU}dikh-tv-hu.png`,
  'dikh tv hd': `${TV_LOGOS_HU}dikh-tv-hu.png`,
  'fix tv': `${TV_LOGOS_HU}fix-hu.png`,
  'cool tv': `${TV_LOGOS_HU}cool-tv-hu.png`,
  'hbo': `${TV_LOGOS_HU}hbo-hu.png`,
  'hbo2': `${TV_LOGOS_HU}hbo2-hu.png`,
  'hbo3': `${TV_LOGOS_HU}hbo3-hu.png`,
  'spektrum': `${TV_LOGOS_HU}spektrum-hu.png`,
  'spektrum home': `${TV_LOGOS_HU}spektrum-home-hu.png`,
  'film plus': `${TV_LOGOS_HU}film-plus-hu.png`,
  'mozi plus': `${TV_LOGOS_HU}mozi-plus-hu.png`,
  'story4': `${TV_LOGOS_HU}story4-hu.png`,
  'viasat3': `${TV_LOGOS_HU}viasat3-hu.png`,
  'd1 tv': `${TV_LOGOS_HU}d1-hu.png`,
  'minimax': `${TV_LOGOS_HU}minimax-hu.png`,
  'tv paprika': `${TV_LOGOS_HU}tv-paprika-hu.png`,
  'cool': `${TV_LOGOS_HU}cool-tv-hu.png`,
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

/** Saját magyar csatornalogó keresése név alapján (csak HU csatornákhoz használandó). */
export function getHuChannelLogo(name: string): string | undefined {
  const key = normalizeChannelName(name);
  if (!key) return undefined;
  const overrides = readOverrides();
  const direct = overrides[key] || HU_CHANNEL_LOGOS[key];
  if (direct) return direct;
  /*
   * 2.5.251: a „[HU] ” / „HU - ” előtag nélkül is keresünk, így a táblában
   * elég a természetes név („[HU] M1 UHD” → „hu m1 uhd” → „m1 uhd”).
   */
  const stripped = key.replace(/^hu\s+/, '');
  if (stripped && stripped !== key) return overrides[stripped] || HU_CHANNEL_LOGOS[stripped] || undefined;
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
  appLog(
    `LOGÓ-HIÁNY [${context}]: HU csatornák összesen=${huTotal}, szolgáltatói logóval=${huWithProviderLogo}, ` +
    `saját tárolóból=${huWithCustomLogo}, HIÁNYZÓ=${huTotal - huWithProviderLogo - huWithCustomLogo}.`
  );
  if (missing.length) {
    appLog(`LOGÓ-HIÁNY [${context}] hiányzó logójú magyar csatornák (ezeket kell letölteni): ${missing.join(' | ')}`);
  }
}
