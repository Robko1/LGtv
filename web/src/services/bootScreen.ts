/**
 * BETÖLTŐKÉPERNYŐ-HÍD.
 *
 * A `web/index.html`-ben lévő új betöltőképernyő (takarókép + valós rendszeridő)
 * KIZÁRÓLAG azt rajzolja ki, amit ez a modul jelent neki. Itt nincs szimulált
 * érték, nincs `Math.random`, nincs időzített „befejezés”: minden szám egy
 * ténylegesen lezajlott lépésből vagy a valódi hálózati forgalomból származik.
 *
 *   • százalék  – a TÉNYLEGESEN befejezett indulási szakaszok súlyozott értéke,
 *                 illetve a szolgáltatói betöltés VALÓDI folyamatjelzője;
 *   • csatorna  – az alkalmazás állapotában lévő csatornák tényleges száma;
 *   • sebesség  – a `net.ts` által mért bájt / eltelt idő (utolsó kérés);
 *   • hátralévő – a mért eltelt időből és a valós százalékból számolt becslés.
 *
 * Ha egy adat még nem érkezett meg, a képernyő „—” jelet mutat. A híd
 * használható böngésző nélkül (teszt/SSR) is: ilyenkor minden hívás csendben
 * visszatér.
 */

export interface BootScreenReport {
  /** 0–100, csak előre haladó érték. */
  percent?: number;
  /** A tényleges szakasz neve (a képernyő nagy sora). */
  phase?: string;
  /** Lépésszám a hét indulási fázisból. */
  step?: string;
  /** Részletek: hány csatorna, melyik kérés, mennyi ideig tartott. */
  detail?: string;
  /** Tényleges csatornaszám (null = még nincs adat → „—”). */
  channels?: number | null;
  /**
   * Az eddig TÉNYLEGESEN letöltött bájtok összege (null = még nincs mérés).
   * Csak sikeres válaszokból, a hálózati réteg méréséből származik – ezért
   * nem kitalált érték, hanem a valóban átvitt adat.
   */
  bytesTotal?: number | null;
  /** Mért átviteli sebesség bájt/másodpercben (null = nincs mérés). */
  bytesPerSecond?: number | null;
  /** Becsült hátralévő idő másodpercben (null = nincs értelmes becslés). */
  etaSeconds?: number | null;
  /** A futó verzió (a láblécben jelenik meg). */
  version?: string;
}

interface BootScreenBridge {
  update?: (report: BootScreenReport) => void;
  complete?: () => void;
  state?: () => Record<string, unknown>;
}

interface BootScreenWindow extends Window {
  __IPTV_BOOT__?: BootScreenBridge;
}

/**
 * A hét indulási fázis a VALÓS, befejezett lépésekhez rendelt százalékkal.
 * Ezek nem időzített értékek: mindegyik akkor lép be, amikor az adott lépés
 * ténylegesen megtörtént az alkalmazásban.
 */
export const BOOT_PHASES = {
  bundle: { percent: 8, phase: 'Alkalmazás betöltve', step: '1/7 · program' },
  react: { percent: 16, phase: 'Felület előkészítése', step: '2/7 · React' },
  storage: { percent: 26, phase: 'Tároló ellenőrzése…', step: '3/7 · tároló' },
  stored: { percent: 42, phase: 'Mentett lista visszatöltése…', step: '4/7 · mentett lista' },
  restored: { percent: 54, phase: 'Mentett lista betöltve', step: '4/7 · mentett lista' },
  empty: { percent: 80, phase: 'Kész – nincs beállított szolgáltató', step: '4/7 · üres telepítés' },
  provider: { percent: 40, phase: 'Szolgáltató betöltése…', step: '5/7 · szolgáltató' },
  live: { percent: 78, phase: 'Élő csatornák betöltve', step: '5/7 · élő csatornák' },
  shell: { percent: 88, phase: 'Főoldal kirajzolva', step: '6/7 · főoldal' },
  painted: { percent: 94, phase: 'Festés a takarókép alatt', step: '7/7 · festés' },
  done: { percent: 100, phase: 'Kész', step: '7/7 · kész' },
} as const;

export type BootPhaseName = keyof typeof BOOT_PHASES;

const now = (): number => {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch {
    /* nincs performance */
  }
  return Date.now();
};

let startedAt = 0;
let percent = 0;
let phase = '';
let step = '';
let detail = '';
let channels: number | null = null;
/** A sikeres kérésekben tényleg átvitt bájtok összege. */
let bytesTotal: number | null = null;
let bytesPerSecond: number | null = null;
let etaSeconds: number | null = null;
let version = '';
let finished = false;

function bridge(): BootScreenBridge | null {
  try {
    if (typeof window === 'undefined') return null;
    return (window as unknown as BootScreenWindow).__IPTV_BOOT__ || null;
  } catch {
    return null;
  }
}

/** A képernyőnek átadott, eddig összegyűlt valós állapot. */
function snapshot(): BootScreenReport {
  return { percent, phase, step, detail, channels, bytesTotal, bytesPerSecond, etaSeconds, version };
}

function push(): void {
  const target = bridge();
  if (!target || typeof target.update !== 'function') return;
  try {
    target.update(snapshot());
  } catch {
    /* a HTML-réteg hibája nem akadályozhatja az indulást */
  }
}

/**
 * A hátralévő idő a MÉRT eltelt időből és a valós százalékból. Ha nincs még
 * elég mérés (vagy a százalék nem halad), nem mutatunk becslést.
 */
function refreshEta(): void {
  if (finished || percent >= 100) {
    etaSeconds = 0;
    return;
  }
  if (!startedAt || percent < 5) {
    etaSeconds = null;
    return;
  }
  const elapsedMs = now() - startedAt;
  if (elapsedMs < 800) {
    etaSeconds = null;
    return;
  }
  const remainingMs = (elapsedMs * (100 - percent)) / percent;
  const next = Math.max(0, Math.min(99 * 60, remainingMs / 1000));
  // Enyhe simítás: egy-egy lassabb kérés ne ugorja meg a kijelzést.
  etaSeconds = etaSeconds === null ? next : etaSeconds * 0.6 + next * 0.4;
}

/** Az indulás kezdete (a bundle betöltése). Egyszer fut le. */
export function bootScreenStart(appVersion: string): void {
  if (startedAt) return;
  startedAt = now();
  version = appVersion;
  percent = Math.max(percent, BOOT_PHASES.bundle.percent);
  phase = BOOT_PHASES.bundle.phase;
  step = BOOT_PHASES.bundle.step;
  detail = 'A betöltési adatok a TV-n futó alkalmazásból származnak.';
  refreshEta();
  push();
}

/**
 * Egy VALÓBAN befejezett indulási szakasz jelzése. A százalék soha nem megy
 * visszafelé, és nem is ugorhat előre egy nem teljesült lépéshez.
 */
export function bootScreenPhase(name: BootPhaseName, extraDetail?: string): void {
  if (finished) return;
  if (!startedAt) startedAt = now();
  const target = BOOT_PHASES[name];
  /*
   * A százalék monoton: egy korábbi szakasz késői jelzése nem írhatja felül
   * a már elért, magasabb állapot szövegét (pl. a mentett lista visszatöltése
   * után érkező „tároló megnyitva” üzenet).
   */
  if (target.percent >= percent) {
    percent = target.percent;
    phase = target.phase;
    step = target.step;
  }
  if (typeof extraDetail === 'string') detail = extraDetail;
  refreshEta();
  push();
}

/** A képernyőn látható részletes sor (pl. „1 834 csatorna • 4,2 s”). */
export function bootScreenDetail(text: string): void {
  if (finished || typeof text !== 'string' || !text) return;
  detail = text;
  push();
}

/** Az alkalmazás állapotában lévő csatornák TÉNYLEGES száma. */
export function bootScreenChannels(count: number | null): void {
  if (finished) return;
  if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
    channels = Math.round(count);
  } else {
    channels = null;
  }
  /*
   * A csatornaszám önmagában NEM léptet szakaszt: a mentett listából
   * visszatöltött csatornák még nem jelentik azt, hogy a szolgáltató élő
   * listája is betöltődött. Azt az App külön, a tényleges eseménynél jelenti
   * (`bootScreenPhase('live')`).
   */
  refreshEta();
  push();
}

/**
 * A szolgáltatói betöltés VALÓDI folyamatjelzője (0–100). A 0–40% közötti
 * szakasz az élő csatornák elkészültéig tart, ezért a betöltőképernyőn a
 * 40–78% közötti sávba esik. A 40% feletti rész (filmek/sorozatok) már a
 * használható főoldal UTÁN fut, ezért nem tolja tovább a képernyőt.
 */
export function bootScreenProviderProgress(progress: { percent?: number; phase?: string; detail?: string }): void {
  if (finished || !progress) return;
  const raw = Number(progress.percent);
  if (!Number.isFinite(raw)) return;
  const clamped = Math.max(0, Math.min(100, raw));
  const mapped = 40 + (Math.min(clamped, 40) / 40) * (BOOT_PHASES.live.percent - 40);
  if (mapped > percent) {
    percent = mapped;
    phase = typeof progress.phase === 'string' && progress.phase ? progress.phase : BOOT_PHASES.provider.phase;
    step = BOOT_PHASES.provider.step;
    if (typeof progress.detail === 'string' && progress.detail) detail = progress.detail;
    refreshEta();
    push();
  } else if (typeof progress.phase === 'string' && progress.phase && progress.phase !== phase) {
    // A szöveg akkor is kövesse a valóságot, ha a százalék már előrébb járt.
    phase = progress.phase;
    if (typeof progress.detail === 'string' && progress.detail) detail = progress.detail;
    push();
  }
}

/**
 * Valódi hálózati átvitel (a `net.ts` NetworkDiagnosticEvent eseménye).
 * A sebesség csak sikeres, mért válaszból származik; hibánál nem írunk felül
 * semmit, hogy ne mutassunk kitalált értéket.
 */
export function bootScreenTransfer(event: {
  status?: string;
  bytes?: number | null;
  durationMs?: number | null;
}): void {
  if (finished || !event || event.status !== 'success') return;
  const bytes = Number(event.bytes);
  const durationMs = Number(event.durationMs);
  if (!Number.isFinite(bytes) || !Number.isFinite(durationMs) || bytes <= 0 || durationMs <= 0) return;
  const measured = (bytes / durationMs) * 1000;
  bytesPerSecond = bytesPerSecond === null ? measured : bytesPerSecond * 0.55 + measured * 0.45;
  /* Az összesített, VALÓBAN átvitt adat (a „Letöltve” statisztika). */
  bytesTotal = (bytesTotal === null ? 0 : bytesTotal) + bytes;
  refreshEta();
  push();
}

/** A kész főoldal: innentől a betöltőképernyő eltűnhet. */
export function bootScreenComplete(): void {
  if (finished) return;
  finished = true;
  percent = 100;
  phase = BOOT_PHASES.done.phase;
  step = BOOT_PHASES.done.step;
  etaSeconds = 0;
  push();
  const target = bridge();
  if (target && typeof target.complete === 'function') {
    try {
      target.complete();
    } catch {
      /* a HTML-réteg hibája nem akadályozhatja a megjelenítést */
    }
  }
}

/** Csak a tesztek/diagnosztika számára: a híd jelenlegi, valós állapota. */
export function bootScreenSnapshot(): BootScreenReport {
  return snapshot();
}

/** Teszt-környezethez: a modul állapotának alaphelyzetbe állítása. */
export function resetBootScreenForTests(): void {
  startedAt = 0;
  percent = 0;
  phase = '';
  step = '';
  detail = '';
  channels = null;
  bytesTotal = null;
  bytesPerSecond = null;
  etaSeconds = null;
  version = '';
  finished = false;
}
