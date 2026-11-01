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
 * IDE kerülnek a letöltött magyar logók (kulcs = normalizeChannelName(név),
 * érték = abszolút logócím). Példa:
 *
 *   'm1 hd': 'https://example.hu/logos/m1-hd.png',
 *
 * A felhasználó ide másolhatja be a letöltött képek URL-jeit; a localStorage
 * felülírás (iptv_rt_hu_logos_v1) ugyanerre a kulcsra működik, build nélkül is.
 */
export const HU_CHANNEL_LOGOS: Record<string, string> = {
  // ide jönnek a letöltött magyar csatornalogók
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
  return overrides[key] || HU_CHANNEL_LOGOS[key] || undefined;
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
