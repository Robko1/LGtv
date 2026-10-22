/**
 * Webes oldali napló a Beállítások → Hibakeresési napló laphoz.
 *
 * A napló a TV böngészőjének fontos lépéseit rögzíti (tartalom betöltése,
 * mentés, memória), és a localStorage-ba is kiírja, hogy alkalmazás-újraindítás
 * után is megmaradjon.
 *
 * A napló szigorúan korlátozott méretű: a legrégebbi sorok automatikusan
 * törlődnek, így hosszú használat után sem növeli a memóriát.
 */

const MAX_LINES = 400;
// Naplózási korlátok: legfeljebb 24 óra és 60 KB / 400 sor.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CHARS = 60000;
const STORE_KEY = 'app-log';
const DEFAULT_APP_VERSION = 'IPTV R.T webOS';

let lines: string[] = [];
let chars = 0;
let restoreAttempted = false;
let saveTimer: number | null = null;

function nowStamp(): string {
  return new Date().toISOString();
}

/** Csak a dátummal ellátott, elmúlt 24 órán belüli sorokat tartjuk meg. */
function trimExpired(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  const fresh: string[] = [];
  for (const line of lines) {
    const timestamp = Date.parse(line.slice(0, 24));
    // A régi, dátum nélküli formátum korát nem lehet megbízhatóan megállapítani,
    // ezért nem tartjuk meg az új, 24 órás naplóban.
    if (Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= Date.now() + 60_000) {
      fresh.push(line);
    }
  }
  lines = fresh;
  chars = lines.reduce((total, line) => total + line.length + 1, 0);
}

function trim(): void {
  while (lines.length > MAX_LINES || chars > MAX_CHARS) {
    const removed = lines.shift();
    if (removed === undefined) break;
    chars -= removed.length + 1;
  }
}

/** A korábbi munkamenet naplójának visszaolvasása (összeomlás utáni elemzéshez). */
function restore(): void {
  if (restoreAttempted) return;
  restoreAttempted = true;
  try {
    const raw = localStorage.getItem(`iptv_rt_${STORE_KEY}`) || '';
    if (!raw) return;
    const previous = String(raw).split('\n').filter(Boolean).slice(-MAX_LINES);
    for (const line of previous) {
      lines.push(line);
      chars += line.length + 1;
    }
    trimExpired();
    trim();
  } catch {
    /* a napló visszaolvasása nem kritikus */
  }
}

function persistSoon(): void {
  if (saveTimer !== null) return;
  try {
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      try {
        localStorage.setItem(`iptv_rt_${STORE_KEY}`, lines.join('\n'));
      } catch {
        /* a TV tárhelyhibája nem akadályozhatja a működést */
      }
    }, 1500);
  } catch {
    saveTimer = null;
  }
}

/**
 * AZONNALI mentés (a késleltetés megkerülésével).
 *
 * Fagyás / összeomlás előtt nincs idő az 1,5 másodperces késleltetésre: a
 * kritikus sorokat (LEÁLLÁS, IDŐVONAL, ÖSSZEOMLÁS) rögtön kiírjuk, hogy a
 * következő indításnál – és a QR-kódon megnyitható naplóban – ott legyen.
 * Nagy naplónál (30 KB felett) csak ritkán írunk, hogy a szinkron írás ne
 * lassítsa a TV-t.
 */
let lastPersistAt = 0;

function persistNow(force = false): void {
  try {
    if (!force && chars > 30000) return;
    // Legfeljebb 30 másodpercenként írunk ki azonnal – a webOS localStorage
    // írása szinkron, és a lejátszás alatt nem akarunk plusz akadozást.
    if (!force && Date.now() - lastPersistAt < 30000) return;
  } catch { /* nem elérhető */ }
  lastPersistAt = Date.now();
  if (saveTimer !== null) {
    try { window.clearTimeout(saveTimer); } catch { /* nem elérhető */ }
    saveTimer = null;
  }
  try {
    localStorage.setItem(`iptv_rt_${STORE_KEY}`, lines.join('\n'));
  } catch {
    /* a TV tárhelyhibája nem akadályozhatja a működést */
  }
}

/**
 * Teljesen új webes diagnosztikai munkamenet indítása.
 * A memóriabeli és tartós előzményeket is törli, és megakadályozza a régi
 * napló későbbi visszatöltését ebben a munkamenetben.
 */
export function clearAppLog(): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  lines = [];
  chars = 0;
  restoreAttempted = true;
  try {
    localStorage.removeItem(`iptv_rt_${STORE_KEY}`);
  } catch {
    /* a naplótár hibája nem akadályozhatja az alkalmazás működését */
  }
}

/** Egy sor hozzáadása a webes naplóhoz. */
export function appLog(message: string): void {
  restore();
  const safe = String(message ?? '').replace(/\s+/g, ' ').slice(0, 600);
  const line = `${nowStamp()} ${safe}`;
  lines.push(line);
  chars += line.length + 1;
  trimExpired();
  trim();
  persistSoon();
}

/** Hiba részletes naplózása (üzenet és verem). */
export function appLogError(context: string, error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error && error.stack ? ` | ${error.stack.split('\n').slice(1, 3).join(' ')}` : '';
  appLog(`${context} HIBA → ${message}${stack}`);
}

/**
 * Memória-pillanatkép. A böngészőmotor JS-halomadatai alapján
 * látszik, ha a tartalom betöltése túl sok memóriát használ (ez okozta a
 * TV böngészőjének lefagyását).
 */
export function memorySnapshot(): string {
  const parts: string[] = [];
  try {
    const memory = (performance as unknown as {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    }).memory;
    if (memory) {
      const mb = (value: number) => (value / (1024 * 1024)).toFixed(1);
      parts.push(
        `JS halom használt=${mb(memory.usedJSHeapSize)} MB, lefoglalt=${mb(memory.totalJSHeapSize)} MB,` +
        ` korlát=${mb(memory.jsHeapSizeLimit)} MB`
      );
    }
  } catch {
    /* nem elérhető */
  }
  try {
    const device = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    if (device) parts.push(`eszköz memória≈${device} GB`);
  } catch {
    /* nem elérhető */
  }
  return parts.length ? parts.join(', ') : 'a böngészőmotor nem ad memóriaadatot';
}

/** Rövid, ember által olvasható memória-sor a naplóhoz. */
export function logMemory(label: string): void {
  appLog(`MEMÓRIA [${label}] ${memorySnapshot()}`);
}

/** A napló teljes szövege (a hibakeresési lapon megjelenítve és másolva). */
export function getAppLogText(): string {
  restore();
  trimExpired();
  trim();
  const header = `--- WEBOS NAPLÓ (${lines.length} sor; max. 24 óra; max. 60 KB) ---`;
  return [header, ...lines].join('\n');
}

/** Indulási sorok: verzió, eszköz, memória. */
export function logStartup(version: string = DEFAULT_APP_VERSION): void {
  appLog(`=== IPTV indul; verzió=${version}; felület=${location.href.split('/').pop() || ''} ===`);
  appLog(`Eszköz: ${navigator.userAgent}`);
  logMemory('indulás');
}

/* ══════════════════════════════════════════════════════════════════════════
 * FAGYÁS- ÉS ÖSSZEOMLÁS-DIAGNOSZTIKA (2.5.28)
 *
 * A felhasználó jelzése: az IPK telepítése utáni ELSŐ indításnál kb. 3 perc
 * után megfagy / kilép az app, a második indítás után viszont hibátlanul fut.
 * Ehhez kellenek a naplóban:
 *   • IDŐVONAL sorok 15 másodpercenként (memória + DOM + lejátszó állapot),
 *   • LEÁLLÁS sor, ha a fő szál 2,5 másodpercnél tovább nem futott,
 *   • ÖSSZEOMLÁS / ÍGÉRETHIBA sor a tényleges hibaüzenettel és veremmel,
 *   • INDULÁS sorok ezredmásodperces időbélyeggel (melyik fázis mennyi ideig tartott),
 *   • OLDAL ELHAGYÁSA sor, ha a webOS kilépteti az appot (pagehide/visibility).
 *
 * A sorok a SÁRGA (teletext) gombon megnyitható QR-naplóba kerülnek, tehát a
 * TV-n semmit nem kell gépelni – a QR-kódot beolvasva másolható a teljes napló.
 * ══════════════════════════════════════════════════════════════════════════ */

const BOOT_AT = (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? performance.now()
  : 0;

/**
 * Kritikus sor: azonnal (késleltetés nélkül) a tárolóba is kiíródik, hogy
 * fagyás / kilövés előtt is megmaradjon. Csak valódi eseménynél hívjuk
 * (JS-hiba, összeomlás, leállás, hosszú feladat, kilépés), ezért a szinkron
 * írás belefér.
 */
export function appLogCritical(message: string): void {
  appLog(message);
  persistNow(true);
}

/** Indulási fázis ezredmásodperccel (a bundle betöltésétől számítva). */
export function logPhase(label: string): void {
  let elapsed = 0;
  try {
    elapsed = Math.round(performance.now() - BOOT_AT);
  } catch { elapsed = 0; }
  appLog(`INDULÁS [${elapsed} ms] ${label}`);
}

/**
 * A pillanatnyi felület állapota egy sorban: melyik nézet látszik, hány DOM
 * csomópont van, és mit csinál a videó. Fagyás után ebből derül ki, hol állt meg.
 */
export function uiStateSnapshot(): string {
  const parts: string[] = [];
  try {
    const pane = document.querySelector('[data-view-pane]:not([data-view-hidden])');
    parts.push(`nézet=${pane ? pane.getAttribute('data-view-pane') || '?' : '?'}`);
  } catch { /* nem elérhető */ }
  try {
    parts.push(`DOM=${document.getElementsByTagName('*').length} csomópont`);
  } catch { /* nem elérhető */ }
  try {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (video) {
      const source = String(video.currentSrc || video.src || '').split('?')[0].slice(-48);
      parts.push(
        `videó=${video.paused ? 'áll' : 'megy'}` +
        `, pozíció=${Math.round(Number(video.currentTime) || 0)} s` +
        `, kész=${video.readyState}` +
        (source ? `, forrás=…${source}` : '')
      );
    } else {
      parts.push('videó=nincs');
    }
  } catch { /* nem elérhető */ }
  try {
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) parts.push(`nyitott ablak=${dialog.getAttribute('aria-label') || 'igen'}`);
  } catch { /* nem elérhető */ }
  return parts.join(', ');
}

let watchdogStarted = false;
let lastTickAt = 0;
let lastTimelineAt = 0;
let lastLongTaskAt = 0;
/** Ennél hosszabb kimaradás = a fő szál állt (TV-n ez már látható fagyás). */
const STALL_MS = 2500;
/** Idővonal-sorok közötti idő (memória + állapot). */
const TIMELINE_MS = 15000;

/**
 * Futásidejű fagyásfigyelő. 1 másodpercenként „szívverést” mér: ha a fő szál
 * kimarad, a különbség megmutatja, mennyi ideig nem futott semmi. A hosszú
 * feladatok (longtask) külön, pontos méréssel kerülnek a naplóba, ha a motor
 * támogatja (webOS 5+ / Chrome 58+).
 */
export function startRuntimeWatchdog(): void {
  if (watchdogStarted) return;
  watchdogStarted = true;
  lastTickAt = Date.now();
  lastTimelineAt = lastTickAt;

  const tick = () => {
    const now = Date.now();
    const gap = now - lastTickAt;
    lastTickAt = now;
    if (gap >= STALL_MS) {
      appLogCritical(`LEÁLLÁS: a fő szál ${gap} ms-ig nem futott (várt: 1000 ms). ${uiStateSnapshot()}`);
    }
    if (now - lastTimelineAt >= TIMELINE_MS) {
      lastTimelineAt = now;
      // Sorként minden 15 mp-ben rögzítjük, de a tárolóba csak ~30 mp-enként
      // írjuk ki (a webOS szinkron localStorage-írása ne akassza meg a képet).
      appLog(`IDŐVONAL: ${memorySnapshot()}; ${uiStateSnapshot()}`);
      persistNow();
    }
  };
  try {
    window.setInterval(tick, 1000);
  } catch {
    /* ha nincs időzítő, a többi naplózás akkor is működik */
  }

  try {
    const Observer = (window as unknown as {
      PerformanceObserver?: new (callback: (list: { getEntries: () => Array<{ duration: number; name: string }> }) => void) => {
        observe: (options: { entryTypes: string[] }) => void;
      };
    }).PerformanceObserver;
    if (Observer) {
      const observer = new Observer((list) => {
        const entries = list.getEntries();
        for (const entry of entries) {
          if (entry.duration < 1200) continue;
          const now = Date.now();
          if (now - lastLongTaskAt < 4000) continue;
          lastLongTaskAt = now;
          appLogCritical(`HOSSZÚ FELADAT: ${Math.round(entry.duration)} ms (${entry.name || 'ismeretlen'}). ${uiStateSnapshot()}`);
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    }
  } catch {
    /* a motor nem támogatja a longtask mérést */
  }

  appLogCritical(`FIGYELŐ ELINDULT; ${memorySnapshot()}; ${uiStateSnapshot()}`);
}

/**
 * Összeomlás- és kilépésfigyelő.
 *
 * A `pagehide` / `visibilitychange` sorok bizonyítják, hogy a webOS kiléptette
 * az appot (nem a felület fagyott le örökre), a hibakezelők pedig a tényleges
 * JS-hibát írják a naplóba – a QR-kóddal átadható naplóból ez alapján lehet
 * pontosan javítani.
 */
export function installCrashHandlers(): void {
  try {
    window.addEventListener('error', (event) => {
      const message = String((event as ErrorEvent)?.message || 'ismeretlen hiba');
      const where = `${(event as ErrorEvent)?.filename || ''}:${(event as ErrorEvent)?.lineno || 0}`;
      appLogCritical(`ÖSSZEOMLÁS: ${message} @ ${where}; ${uiStateSnapshot()}`);
    });
  } catch { /* nem elérhető */ }

  try {
    window.addEventListener('unhandledrejection', (event) => {
      const reason = (event as PromiseRejectionEvent)?.reason;
      const text = reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : String(reason).slice(0, 300);
      appLogCritical(`KEZELETLEN ÍGÉRETHIBA: ${text}; ${uiStateSnapshot()}`);
    });
  } catch { /* nem elérhető */ }

  try {
    window.addEventListener('pagehide', () => {
      appLogCritical(`OLDAL ELHAGYÁSA (pagehide) – az app leáll vagy kilépett. ${uiStateSnapshot()}`);
    });
  } catch { /* nem elérhető */ }

  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        appLogCritical(`HÁTTÉRBE KERÜLT (visibilitychange); ${uiStateSnapshot()}`);
      } else {
        appLog('ELŐTÉRBE KERÜLT (visibilitychange).');
      }
    });
  } catch { /* nem elérhető */ }
}
