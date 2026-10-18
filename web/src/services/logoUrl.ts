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
 *  - az APK `file://` dokumentumcímét soha nem használjuk bázisként, és a
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
function logoBase(baseUrl?: string): string {
  const trimmed = (baseUrl || '').trim();
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

export function normalizeLogoUrl(value: unknown, baseUrl?: string): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  if (!raw) return '';

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
