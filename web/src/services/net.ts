/**
 * Hálózati segédfüggvények a szolgáltatói listák letöltéséhez.
 *
 * FONTOS: ez a réteg szándékosan „kímélő” üzemmódban dolgozik, mert a korábbi
 * (párhuzamos, sokszor újrapróbálkozó) változat túlterhelte az otthoni
 * routereket: ha a szolgáltató szervere egy hálózaton nem elérhető (pl. az
 * internetszolgáltató blokkolja), a sok elakadt kapcsolat és az ismételt
 * próbálkozások teleírták a router kapcsolatnyilvántartását (NAT/conntrack),
 * amitől az egész otthoni internet lefagyott, és a routert újra kellett
 * indítani.
 *
 * Ezért:
 *   1. Legfeljebb KÉT szolgáltatói kérés futhat párhuzamosan.
 *   2. A kérések között van egy kis szünet (minimális távolság).
 *   3. Rövid időtúllépések: egy elakadt kérés nem foglalja a kapcsolatot
 *      percig, hanem legkésőbb 12-45 másodperc után megszakad.
 *   4. MEGSZAKÍTÓ (circuit breaker): ha egymás után néhány kérés hálózati
 *      szinten elhasal, a program egy ideig NEM indít új kapcsolatot, hanem
 *      azonnal hibát jelez. Így soha nem keletkezhet több száz elakadt
 *      kapcsolat.
 */

export interface NetworkDiagnosticEvent {
  id: number;
  url: string;
  status: 'start' | 'success' | 'error';
  httpStatus?: number | null;
  durationMs?: number | null;
  bytes?: number | null;
  error?: string | null;
  startedAt: number;
  endedAt?: number | null;
}

const activeControllers = new Set<AbortController>();
let diagnosticSink: ((event: NetworkDiagnosticEvent) => void) | null = null;
let diagnosticId = 0;

export function setNetworkDiagnosticSink(
  sink: ((event: NetworkDiagnosticEvent) => void) | null
): void {
  diagnosticSink = sink;
}

export function cancelNetworkRequests(): void {
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
}

/* --------------------------------------------------- kímélő kéréssor */

/**
 * Egyszerre legfeljebb két szolgáltatói kérés futhat párhuzamosan.
 * A kategóriák betöltése így átfedheti egymást, de nem nyitunk nagy
 * kapcsolatrohamot. A referencia gyors listakezelését követve a kérések
 * közötti szünetet 80 ms-ról 25 ms-ra csökkentjük; a megszakító és a
 * korlátozott újrapróbálkozás változatlanul védi a hálózatot.
 */
const MAX_CONCURRENT = 2;
/** Két kérés között ennyi idő teljen el (a hirtelen kapcsolatözön ellen). */
const MIN_GAP_MS = 25;

let inFlight = 0;
let lastRequestAt = 0;
const queue: Array<() => void> = [];

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => queue.push(resolve));
  inFlight++;
}

function release(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = queue.shift();
  if (next) next();
}

/**
 * Hely kérése RÖVID várakozással (a szolgáltatói bejelentkezés-probe).
 *
 * Normál esetben ugyanazt a sort használja, mint minden más kérés, tehát
 * továbbra is legfeljebb 2 kapcsolat él egyszerre. Ha viszont a két helyet
 * elakadt (nem válaszoló) kérések foglalják, a várakozás után MÉGIS elindul:
 * ez a kérés dönti el, hogy a szerver egyáltalán él-e, és így 10 másodperc
 * alatt érthető hibaüzenet születik (a sor végén 30-40 mp lenne).
 *
 * @returns true, ha helyet foglalt (ilyenkor `release()` kell a végén),
 *          false, ha soron kívül indult.
 */
const BYPASS_WAIT_MS = 1500;
async function acquireWithin(ms: number): Promise<boolean> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return true;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer = 0;
    const grant = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      inFlight++;
      resolve(true);
    };
    queue.push(grant);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const index = queue.indexOf(grant);
      if (index >= 0) queue.splice(index, 1);
      resolve(false);
    }, ms) as unknown as number;
  });
}

/* ------------------------------------------------------- megszakító */

/** Ennyi egymás utáni hálózati hiba után leállunk egy időre. */
const BREAKER_FAILURE_LIMIT = 4;
/** Ennyi ideig nem indítunk új kapcsolatot, ha a szerver elérhetetlen. */
const BREAKER_COOLDOWN_MS = 60000;

let consecutiveTransportFailures = 0;
let breakerOpenUntil = 0;

/**
 * A böngészőből ismert hálózati hibakód (ha rendelkezésre áll, pl.
 * net::ERR_EMPTY_RESPONSE). Ebből tudjuk megmondani, hogy a szerver nem
 * válaszol, nem található (DNS) vagy az internetszolgáltató blokkolja.
 */
let lastNetErrorCode = '';
export function setNetErrorHint(text: string): void {
  const match = text.match(/net::[A-Z_]+/);
  if (match) lastNetErrorCode = match[0];
}
export function lastNetErrorHint(): string {
  return lastNetErrorCode;
}

/** A hálózati hibakódból érthető magyarázat. */
export function explainNetError(code: string): string {
  if (!code) return '';
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(code)) {
    return 'A szolgáltató szerverének a címét nem sikerült feloldani (DNS-hiba) – ezen a hálózaton a neve nem érhető el.';
  }
  if (/ERR_EMPTY_RESPONSE|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/.test(code)) {
    return 'A szolgáltató szervere fogadja a kapcsolatot, de nem küld választ – ez a szolgáltatónál jelentkező hiba, nem feltétlenül a TV vagy a router hibája.';
  }
  if (/ERR_CONNECTION_REFUSED/.test(code)) {
    return 'A szolgáltató szervere elutasítja a kapcsolatot – valószínűleg átmenetileg nem üzemel.';
  }
  if (/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED/.test(code)) {
    return 'A kapcsolat megszakadt a szolgáltató szerverével – próbáld újra később.';
  }
  if (/ERR_CONNECTION_FAILED|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED/.test(code)) {
    return 'Ezen a hálózaton nem érhető el a szolgáltató szervere.';
  }
  return '';
}

export class ProviderUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnreachableError';
  }
}

export function breakerOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

export function breakerRemainingMs(): number {
  return Math.max(0, breakerOpenUntil - Date.now());
}

export function resetNetworkBreaker(): void {
  consecutiveTransportFailures = 0;
  breakerOpenUntil = 0;
}

/** Hálózati szintű hiba? (nem jött válasz: DNS, időtúllépés, megszakadt kapcsolat) */
export function isTransportFailure(message: string): boolean {
  // A magyar nyelvű, már lefordított üzeneteket is felismerjük: a
  // httpGetText a hálózati hibát magyar szöveggel dobja tovább, és a
  // hívók (pl. az import gyors leállítása) ebből ismerik fel a hálózati
  // szintű hibát.
  return /Failed to fetch|NetworkError|Load failed|timeout|timed out|aborted|AbortError|ERR_|net::|Nem sikerült elérni a szervert|Nem érhető el a szolgáltató/i.test(
    message
  );
}

function noteTransportFailure(): void {
  consecutiveTransportFailures++;
  if (consecutiveTransportFailures >= BREAKER_FAILURE_LIMIT && !breakerOpen()) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
  }
}

function noteResponse(): void {
  // Ha bármilyen HTTP válasz jött (akár hiba), a szerver él: nullázzuk a számlálót.
  consecutiveTransportFailures = 0;
  breakerOpenUntil = 0;
}

/* ------------------------------------------------------------- kérés */

// (A saját CORS proxy beállítás kérésre eltávolítva.)

function hasSensitiveProviderData(rawUrl: string, depth = 0): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) return true;
    const sensitiveKeys = /^(username|user|password|pass|token|api_key|apikey|key|auth|secret|access_token|signature)$/i;
    for (const key of url.searchParams.keys()) {
      if (sensitiveKeys.test(key)) return true;
    }
    if (depth < 1) {
      for (const value of url.searchParams.values()) {
        if (/^https?:\/\//i.test(value) && hasSensitiveProviderData(value, depth + 1)) return true;
      }
    }
    const parts = url.pathname.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      if (/^(live|movie|series)$/i.test(parts[i]) && parts[i + 1] && parts[i + 2]) return true;
    }
    return /(?:get|player_api)\.php$/i.test(url.pathname) && /(?:username|password)=/i.test(url.search);
  } catch {
    // Ismeretlen URL-formátumot biztonsági okból nem küldünk nyilvános proxyhoz.
    return true;
  }
}

function proxyUrl(target: string, proxy: string): string {
  if (!proxy) return '';
  if (proxy.includes('{url}')) return proxy.replace('{url}', encodeURIComponent(target));
  return proxy.replace(/\/+$/, '') + '/raw?url=' + encodeURIComponent(target);
}

/** A diagnosztika ne tároljon bejelentkezési adatokat vagy API-kulcsokat. */
function redactDiagnosticUrl(url: string, depth = 0): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = '[redacted]';
    if (parsed.password) parsed.password = '[redacted]';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^(username|user|password|pass|token|api_key|apikey|key|auth|secret|access_token|signature)$/i.test(key)) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    const pathParts = parsed.pathname.split('/');
    for (let i = 0; i < pathParts.length; i += 1) {
      if (/^(live|movie|series)$/i.test(pathParts[i]) && pathParts[i + 1] && pathParts[i + 2]) {
        pathParts[i + 1] = '[redacted]';
        pathParts[i + 2] = '[redacted]';
      }
    }
    parsed.pathname = pathParts.join('/');
    if (depth < 1) {
      const nested = parsed.searchParams.get('url');
      if (nested && /^https?:\/\//i.test(nested)) {
        parsed.searchParams.set('url', redactDiagnosticUrl(nested, depth + 1));
      }
    }
    return parsed.toString();
  } catch {
    return url.replace(/([?&](?:username|user|password|pass|token|api_key|apikey|key|auth|secret|access_token|signature)=)[^&]*/gi, '$1[redacted]').replace(/\/(live|movie|series)\/[^/]+\/[^/]+/gi, '/$1/[redacted]/[redacted]');
  }
}

function describe(error: unknown, url: string): string {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const message = error instanceof Error ? error.message : String(error);
  if (isTransportFailure(message)) {
    return `Nem sikerült elérni a szervert (${host}). Ellenőrizd az internetet és a szerver címét.`;
  }
  return `Hiba a letöltés közben (${host}): ${message}`;
}

/** Egyetlen kérés, rövid időtúllépéssel. */
async function fetchOnce(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const startedAt = performance.now();
  const id = ++diagnosticId;
  activeControllers.add(controller);
  diagnosticSink?.({ id, url: redactDiagnosticUrl(url), status: 'start', startedAt });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    if (!response.ok) {
      // HTTP hibaválasz: a szerver él, csak elutasított.
      noteResponse();
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    if (text.trim() === '') {
      throw new Error('üres válasz');
    }
    noteResponse();
    diagnosticSink?.({
      id, url: redactDiagnosticUrl(url), status: 'success', httpStatus: response.status,
      durationMs: performance.now() - startedAt, bytes: new TextEncoder().encode(text).byteLength,
      startedAt, endedAt: performance.now(),
    });
    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Csak a valódi hálózati hibák számítanak bele a megszakítóba.
    if (!/^HTTP \d+$/.test(message) && message !== 'üres válasz') noteTransportFailure();
    diagnosticSink?.({
      id, url: redactDiagnosticUrl(url), status: 'error',
      httpStatus: error instanceof Error && /^HTTP (\d+)$/.test(error.message)
        ? Number(error.message.slice(5)) : null,
      durationMs: performance.now() - startedAt,
      error: message,
      startedAt, endedAt: performance.now(),
    });
    throw error;
  } finally {
    clearTimeout(timer);
    activeControllers.delete(controller);
  }
}

export interface HttpOptions {
  timeoutMs?: number;
  /**
   * Rövid várakozás után soron kívül is indulhat (a bejelentkezés-probe).
   *
   * Kizárólag a szolgáltatói BEJELENTKEZÉS használja: ez a kérés dönti el,
   * hogy a szerver egyáltalán válaszol-e (a referencia is így tesz a
   * bejelentkezésnél). Ha a sor végén várna, egy nem válaszoló szolgáltatónál
   * a teljes időtúllépés a sorban állással együtt 30-40 másodperc lenne,
   * mielőtt a néző bármilyen hibaüzenetet lát.
   *
   * Normál (működő) szolgáltatónál a kérés a szokásos sort használja, így
   * NEM nyílik harmadik kapcsolat. Csak akkor lép előre, ha a két helyet
   * elakadt kérések foglalják (BYPASS_WAIT_MS után) – ilyenkor viszont 10
   * másodperc alatt kiderül a hiba, és a csatornakérések megszakadnak.
   */
  bypassQueue?: boolean;
}

/**
 * A beállított időtúllépés felső korlátja: ennél tovább egy kérés sem futhat.
 * Rövid érték, hogy egy nem válaszoló szerver ne foglalja sokáig a kapcsolatot.
 */
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_MS = 15000;
/** Ha ennél gyorsabban hasal el egy kérés, kapcsolati hiba volt (nem időtúllépés). */
const FAST_FAILURE_MS = 5000;

/**
 * Szöveg letöltése. A kérések sorban, egymás után futnak, kis szünettel.
 * LG webOS böngészőben a CORS miatt proxyra is eshetünk vissza.
 */
export async function httpGetText(url: string, options: HttpOptions = {}): Promise<string> {
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  if (breakerOpen()) {
    const seconds = Math.ceil(breakerRemainingMs() / 1000);
    throw new ProviderUnreachableError(
      `A szolgáltató szervere nem válaszol ezen a hálózaton. A program ${seconds} másodpercig ` +
        `nem indít új kapcsolatot, hogy ne terhelje a routert. Ellenőrizd a internetkapcsolatot, ` +
        `majd nyomd meg újra a Frissítést.`
    );
  }

  const attempts: string[] = [url];
  // Az IPTV-belépési adatokat nem küldjük nyilvános proxyknak.
  // (A saját CORS proxy beállítás kérésre eltávolítva.)
  if (!hasSensitiveProviderData(url)) {
    attempts.push(proxyUrl(url, 'https://api.allorigins.win'));
    attempts.push(proxyUrl(url, 'https://corsproxy.io'));
  }

  let lastError: unknown = null;
  for (let index = 0; index < attempts.length; index++) {
    const target = attempts[index];
    const attemptStarted = Date.now();
    // A bejelentkezés-probe rövid várakozás után soron kívül is indulhat;
    // minden más kérés a szokásos (legfeljebb 2 kapcsolatos) sorba áll.
    const bypass = Boolean(options.bypassQueue);
    const holdingSlot = bypass ? await acquireWithin(BYPASS_WAIT_MS) : (await acquire(), true);
    try {
      const gap = MIN_GAP_MS - (Date.now() - lastRequestAt);
      if (gap > 0) await sleep(gap);
      lastRequestAt = Date.now();
      return await fetchOnce(target, timeoutMs);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (isTransportFailure(message)) {
        // A szerver egyáltalán nem válaszol: nem próbáljuk meg még egyszer
        // ugyanazt (ez volt a router-túlterhelés egyik fő oka).
        //
        // Egyetlen kivétel: ha a hiba GYORS volt (kapcsolati hiba, nem
        // időtúllépés) és a cím http:// volt, egyszer megpróbáljuk ugyanazt a
        // szervert a titkosított (https) porton – néhány panel csak azon
        // válaszol. Ez egyetlen plusz kapcsolat, nem terheli a routert.
        if (index === 0 && /^http:\/\//i.test(target) && Date.now() - attemptStarted < FAST_FAILURE_MS) {
          const httpsTarget = target.replace(/^http:\/\//i, 'https://').replace(/:80\//, '/');
          if (!attempts.includes(httpsTarget)) {
            attempts.push(httpsTarget);
            continue;
          }
        }
        break;
      }
    } finally {
      if (holdingSlot) release();
    }
  }
  // A hálózati szintű hibát megkülönböztethető típusként dobjuk tovább: a
  // hívó így tudja, hogy a szerver NEM válaszolt (gyors leállítás, megszakítás),
  // szemben azzal, amikor a szerver válaszolt, csak hibásan.
  const lastMessage = lastError instanceof Error ? lastError.message : String(lastError);
  if (isTransportFailure(lastMessage)) {
    throw new ProviderUnreachableError(describe(lastError, url));
  }
  throw new Error(describe(lastError, url));
}

export async function httpGetJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const text = await httpGetText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('A szerver nem JSON választ adott (talán hibás a szerver cím vagy a port).');
  }
}

/**
 * Internet-ellenőrzés: a szolgáltató hibája után egyetlen kéréssel
 * megállapítjuk, hogy az internet maga működik-e. Ebből tudjuk megmondani a
 * felhasználónak, hogy valószínűleg az internetszolgáltató blokkolja a
 * szervert (Wi-Fi-n nem megy, mobilneten igen).
 */
export async function checkInternetReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch('https://api.github.com/zen', {
        signal: controller.signal,
        cache: 'no-store',
      });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
