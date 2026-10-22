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
const DEFAULT_APP_VERSION = 'IPTV R.T webOS 2.3.1';

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
