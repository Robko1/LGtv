/**
 * TV TÍPUS-ADATOK A NAPLÓHOZ.
 *
 * A felhasználó kérése: a naplóban a TV típusa legyen ÁLLANDÓ adat, hogy a
 * későbbi fejlesztéseknél minden beérkező naplóról látszódjon, milyen
 * készüléken készült.
 *
 * Honnan jön az adat (ebben a sorrendben):
 *   1. `window.webOS.deviceInfo` – a webOS Luna-híd (web/index.html →
 *      `webOSTV.js`); ez adja a legpontosabb modellnevet;
 *   2. `window.webOSSystem.deviceInfo` – a régebbi webOS rendszerhíd;
 *   3. `window.PalmSystem.deviceInfo` – webOS 3.x és alatta;
 *   4. a böngésző UA-ja – csak a webOS/Chromium verzióra ad tippet.
 *
 * A megtalált értéket a modul a localStorage-ba is elmenti (`iptv_rt_tv`),
 * így a TV típusa a következő indítások naplójában is megjelenik akkor is,
 * ha a híd éppen lassan válaszol. A naplóba SOHA nem kerül belépési adat.
 */

export interface TvDeviceInfo {
  /** A TV modellneve (pl. OLED55C8PLA), ha a platform átadja. */
  model: string;
  /** webOS verzió (pl. 4.10.1). */
  webOsVersion: string;
  /** SDK verzió. */
  sdkVersion: string;
  /** Alaplap típusa (a Luna-híd `boardType` mezője). */
  boardType: string;
  /** Az alkalmazás azonosítója (pl. hu.robko1.iptv). */
  appId: string;
  /** Melyik forrásból származik a modellnév. */
  source: string;
}

const STORAGE_KEY = 'iptv_rt_tv';
const UNKNOWN = 'nem derül ki';

interface DeviceInfoBag {
  modelName?: unknown;
  model?: unknown;
  version?: unknown;
  sdkVersion?: unknown;
  boardType?: unknown;
}

interface TvHostWindow extends Window {
  webOS?: { deviceInfo?: DeviceInfoBag; applicationID?: unknown };
  webOSSystem?: { deviceInfo?: DeviceInfoBag };
  PalmSystem?: { deviceInfo?: DeviceInfoBag };
}

function str(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function readCached(): Partial<TvDeviceInfo> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<TvDeviceInfo>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCached(info: TvDeviceInfo): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
  } catch {
    /* a tár lehet tele vagy tiltható – a napló attól még működik */
  }
}

/** A webOS/Chromium verzió az UA-ból (a modellnév ott nincs benne). */
function userAgentHint(): string {
  try {
    const ua = navigator.userAgent || '';
    const webos = /(?:Web0S|webOS)[/ ]?([\d.]+)/i.exec(ua);
    const chrome = /Chrome\/([\d.]+)/i.exec(ua);
    const parts: string[] = [];
    if (webos) parts.push(`webOS ${webos[1]}`);
    if (chrome) parts.push(`Chromium ${chrome[1]}`);
    return parts.join(', ');
  } catch {
    return '';
  }
}

/**
 * A TV azonosító adatai. A hiányzó mezők helyén „nem derül ki” áll – a napló
 * soha nem talál ki értéket.
 */
export function tvDeviceInfo(): TvDeviceInfo {
  const cached = readCached();
  const info: TvDeviceInfo = {
    model: str(cached.model),
    webOsVersion: str(cached.webOsVersion),
    sdkVersion: str(cached.sdkVersion),
    boardType: str(cached.boardType),
    appId: str(cached.appId),
    source: str(cached.source),
  };

  try {
    const host = window as TvHostWindow;
    const candidates: Array<[string, DeviceInfoBag | undefined, string]> = [
      ['webOS (Luna)', host.webOS?.deviceInfo, str(host.webOS?.applicationID)],
      ['webOSSystem', host.webOSSystem?.deviceInfo, ''],
      ['PalmSystem', host.PalmSystem?.deviceInfo, ''],
    ];
    for (const [source, bag, appId] of candidates) {
      if (!bag) continue;
      const model = str(bag.modelName) || str(bag.model);
      if (model && !info.model) {
        info.model = model;
        info.source = source;
      }
      if (!info.webOsVersion) info.webOsVersion = str(bag.version);
      if (!info.sdkVersion) info.sdkVersion = str(bag.sdkVersion);
      if (!info.boardType) info.boardType = str(bag.boardType);
      if (!info.appId && appId) info.appId = appId;
    }
  } catch {
    /* a híd hiányzik vagy tiltott – marad a gyorsítótár */
  }

  if (!info.model) info.source = userAgentHint() ? `UA (${userAgentHint()})` : 'ismeretlen forrás';
  writeCached(info);
  return info;
}

/** Egyetlen naplósor-töredék a TV típusáról (a napló fejlécébe és soraiba). */
export function tvDeviceText(): string {
  const info = tvDeviceInfo();
  return [
    `modell=${info.model || UNKNOWN}`,
    `webOS=${info.webOsVersion || UNKNOWN}`,
    info.sdkVersion ? `SDK=${info.sdkVersion}` : '',
    info.boardType ? `alaplap=${info.boardType}` : '',
    info.appId ? `appId=${info.appId}` : '',
    `forrás=${info.source || UNKNOWN}`,
  ].filter(Boolean).join('; ');
}
