/**
 * A logócím mindig a szolgáltatóhoz tartozik, nem az alkalmazás címéhez.
 *
 * Az Xtream bejelentkezés séma nélküli szervercímet is elfogad (pl.
 * `provider.example` vagy `127.0.0.1:8080`), mert a `playerApiBase()` teszi
 * elé a `http://` előtagot. A logófeldolgozás ugyanígy viselkedik:
 *
 *  - az ABSZOLÚT logócímeket először önállóan (`new URL(raw)`) ellenőrizzük,
 *    mert egy érvénytelen báziscím (`new URL(abszolút, '127.0.0.1:8080/')`)
 *    kivételt dob, és így az érvényes logócím is elveszne;
 *  - a relatív és `//` kezdetű címeket a szolgáltató/lista hálózati címéhez
 *    oldjuk fel, séma nélküli báziscímnél HTTP alapértelmezéssel;
 *  - a TV-csomag `file://` dokumentumcímét soha nem használjuk bázisként, és a
 *    tiltott URL-sémák (file:, javascript: stb.) így is elutasítva maradnak.
 */

/**
 * Csak HTTP(S) hálózati cím lehet logóbázis.
 *
 * A player_api.php végű (Xtream bejelentkezési) címből a kiszolgáló gyökere
 * marad a relatív feloldáshoz – ugyanúgy, ahogy a `playerApiBase()` is
 * levágja. Séma nélküli szervercímnél (pl. `127.0.0.1:8080`) – a
 * bejelentkezéshez hasonlóan – a HTTP az alapértelmezés. Bármely más séma
 * (file://, udp://, javascript: stb.) nem használható bázisként.
 */
/*
 * A BÁZIS EGYSZER SZÁMOLÓDIK (2.5.147).
 *
 * A 20 190 élő csatorna visszatöltésekor a `logoBase()` MINDEN csatornánál
 * újra lefutott: reguláris kifejezés + `new URL()`. A TV-n ez önmagában
 * ~1 másodperc volt a betöltőképernyő alatt (a 24. napló 2,7 mp-es
 * képkocka-kihagyása). A bázis viszont indulás közben állandó, ezért elég
 * egyszer kiszámolni.
 */
let cachedLogoBaseInput: string | null = null;
let cachedLogoBaseValue = '';

function logoBase(baseUrl?: string): string {
  const trimmed = (baseUrl || '').trim();
  if (cachedLogoBaseInput === trimmed) return cachedLogoBaseValue;
  cachedLogoBaseInput = trimmed;
  cachedLogoBaseValue = computeLogoBase(trimmed);
  return cachedLogoBaseValue;
}

function computeLogoBase(trimmed: string): string {
  if (!trimmed) return '';
  // A player_api.php végződésű szervercímből csak a kiszolgáló maradjon.
  const withoutApi = trimmed.replace(/\/player_api\.php.*$/i, '').replace(/\/+$/, '');
  if (!withoutApi) return '';
  // Nem http(s) hálózati séma (pl. file://, udp://, rtsp://) nem lehet bázis.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(withoutApi) && !/^https?:\/\//i.test(withoutApi)) return '';
  // Séma nélküli cím: a bejelentkezéshez hasonlóan HTTP előtag.
  const prefixed = /^https?:\/\//i.test(withoutApi) ? withoutApi : `http://${withoutApi}`;
  try {
    const url = new URL(prefixed);
    return url.hostname && /^(https?:)$/.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

/** Csak ezek a sémák jeleníthetők meg <img>-ben. */
const ALLOWED_PROTOCOL = /^(https?:|data:|blob:)$/;

/** Kész, már kódolt, csak ASCII karaktereket tartalmazó http(s) cím. */
const FAST_ABSOLUTE = /^https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

export function normalizeLogoUrl(value: unknown, baseUrl?: string): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  if (!raw) return '';

  /*
   * GYORS ÚT (2.5.147): a kész, már kódolt http(s) címeket nem kell
   * újraértelmezni. A 20 190 csatorna logóinak túlnyomó része ilyen, és az
   * eddigi `new URL()` hívás csatornánként kétszer futott le (a bázissal
   * együtt) – a TV-n ez volt a lassú indulás egyik fő tétele. Csak ASCII
   * címekre engedjük, hogy a `new URL()` százalék-kódolása ne változzon.
   */
  if (FAST_ABSOLUTE.test(raw)) return raw;

  // 1) Az abszolút cím önállóan is érvényes: a bázistól függetlenül megőrizzük,
  //    hogy egy érvénytelen báziscím ne vesse el vele együtt.
  try {
    const direct = new URL(raw);
    return ALLOWED_PROTOCOL.test(direct.protocol) ? direct.href : '';
  } catch {
    /* nem abszolút cím – a bázishoz kell feloldani */
  }

  // 2) Relatív és `//` kezdetű cím: a szolgáltató/lista hálózati címe az alap.
  //    Bázis nélkül a `//` kezdetű cím https-t kap; egyéb relatív cím elbukik.
  const base = logoBase(baseUrl) || (raw.startsWith('//') ? 'https://logo.invalid/' : '');
  if (!base) return '';
  try {
    const url = new URL(raw, base);
    return ALLOWED_PROTOCOL.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}
