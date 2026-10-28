/**
 * TELJES KÖRŰ INDULÁSI DIAGNOSZTIKA (csak a tesztelési időszakra).
 *
 * A naplózás automatikus indítását a `diagnosticsConfig.ts` kapcsolója vezérli
 * (`TEST_STARTUP_DIAGNOSTICS`). Ha a naplózás fut, ez a modul a lehető
 * legrészletesebben rögzíti az indulást, hogy a lassulás, a felugrások és a
 * megjelenítési hibák OKA a naplóból kiolvasható legyen:
 *
 *   1. KÖRNYEZET        – eszköz, webOS híd, képernyő, memória, CPU;
 *   2. TÁROLÓ           – localStorage / IndexedDB elérhető-e, mennyi adat van benne;
 *   3. MÉDIA            – mit tud lejátszani a TV motorja (MPEG-TS, HLS, MP4, HEVC);
 *   4. HTML JELZÉSEK    – a bundle ELŐTTI lépések (webOS szkript, 1/7…7/7 fázisok,
 *                         takarókép levétele, erőforrás- és JS-hibák) időbélyeggel;
 *   5. BETÖLTÉS/FESTÉS  – navigációs időzítések, első festés, legnagyobb tartalom;
 *   6. ERŐFORRÁSOK      – mi töltődött le, mennyi ideig és mekkora adat;
 *   7. ELEM MEGJELENT   – minden fontos elem (ablak, lejátszó, fejléc, lista, OSD…);
 *   8. KÉPERNYŐ         – 500 ms-onként (csak változáskor) a látható állapot;
 *   9. ELRENDEZÉS-UGRÁS – a szemmel látható „ugrások” (layout shift) és forrásuk;
 *  10. KÉPKOCKA / FAGYÁS – kimaradt képkockák, hosszú feladatok, leállások.
 *
 * Minden sor `BOOT-DIAG [+N ms]` előtaggal kerül a naplóba (a HTML indulásától
 * számolt idő), így a napló egyetlen idővonalon olvasható.
 *
 * FONTOS: minden figyelő CSAK akkor él, amikor a naplózás aktív. Kikapcsolt
 * naplózásnál nulla plusz munka és nulla plusz memória (a normál tévézés
 * változatlan). A naplózás a tesztidőszakban csak a napló elküldésekor áll le.
 */
import { appLog, manualLogSnapshot, registerLoggingLifecycleHooks } from './appLog';

interface BootMark {
  /** Mikor történt (Date.now(), abszolút). */
  at?: number;
  label?: string;
}

interface DiagnosticWindow extends Window {
  __IPTV_BOOT_EPOCH__?: number;
  __IPTV_STARTUP_MARKS__?: BootMark[];
  __IPTV_VIDEO_READY__?: boolean;
}

/** A naplózás leállásakor lefuttatandó tisztítások (figyelők, időzítők). */
const cleanups: Array<() => void> = [];
let running = false;
let everStarted = false;
let bootEpoch = 0;
let elementEvents = 0;
let dialogEvents = 0;
let shiftEvents = 0;
let jankEvents = 0;
let maxShift = 0;
let maxFrameGap = 0;
let frameCount = 0;
let dialogsSeen = 0;
let summaryDone = false;
let lastScreenState = '';
let screenTimer: number | null = null;
let marksReported = 0;
let marksMissingLogged = false;
let resourcesReported = 0;

const diagWindow = (): DiagnosticWindow => window as unknown as DiagnosticWindow;

/** Az indulás óta eltelt idő a HTML első szkriptjétől (egy idővonal). */
function elapsed(): number {
  if (!bootEpoch) return 0;
  return Math.max(0, Date.now() - bootEpoch);
}

function line(message: string): void {
  appLog(`BOOT-DIAG [+${elapsed()} ms] ${message}`);
}

/**
 * Teljesítmény-mérés kiolvasása. Régi/egyszerű motoron (pl. a webOS egyes
 * verzióin vagy egy teszt-környezetben) a `getEntriesByType` hiányozhat –
 * ilyenkor NEM hibát írunk a naplóba, csak egyetlen tájékoztató sort.
 */
let performanceApiMissing = false;
function entriesByType(type: string): PerformanceEntry[] {
  try {
    if (typeof performance.getEntriesByType !== 'function') {
      if (!performanceApiMissing) {
        performanceApiMissing = true;
        line('MÉRÉSI API: ez a motor nem ad teljesítmény-méréseket (Performance.getEntriesByType hiányzik); a többi mérés ettől függetlenül fut');
      }
      return [];
    }
    return performance.getEntriesByType(type);
  } catch {
    return [];
  }
}

function safe(label: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    line(`${label} – a mérés nem volt elvégezhető: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ─────────────────────────────── 1. környezet ───────────────────────────── */

function describeEnvironment(): void {
  safe('KÖRNYEZET', () => {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const screenSize = `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`;
    const heap = (performance as Performance & {
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    const heapText = heap
      ? `${(heap.usedJSHeapSize / 1048576).toFixed(1)} MB / ${(heap.jsHeapSizeLimit / 1048576).toFixed(0)} MB`
      : 'nem elérhető';
    line(
      `KÖRNYEZET: UA=${nav.userAgent}; nyelv=${nav.language || '?'}; `
      + `képernyő=${screenSize} (DPR ${window.devicePixelRatio || 1}); `
      + `CPU szál=${nav.hardwareConcurrency ?? '?'}; eszköz memória=${nav.deviceMemory ?? '?'} GB; `
      + `JS halom=${heapText}; látható=${document.visibilityState}`
    );
  });
}

/** A webOS platform-híd: mit lát az app a TV rendszeréből. */
function describePlatformBridge(): void {
  safe('webOS HÍD', () => {
    const host = window as unknown as {
      webOSSystem?: { deviceInfo?: Record<string, unknown> } & Record<string, unknown>;
      webOS?: Record<string, unknown>;
      PalmSystem?: Record<string, unknown>;
      PalmServiceBridge?: unknown;
      IS_WEBOS_TV?: boolean;
    };
    const system = host.webOSSystem;
    const deviceInfo = system && system.deviceInfo && typeof system.deviceInfo === 'object'
      ? system.deviceInfo as Record<string, unknown>
      : null;
    const model = deviceInfo ? String(deviceInfo.modelName || deviceInfo.model || '') : '';
    const version = deviceInfo ? String(deviceInfo.version || '') : '';
    const sdk = deviceInfo ? String(deviceInfo.sdkVersion || '') : '';
    let appId = '';
    try {
      appId = String((host.webOS?.applicationID as string) || '');
    } catch {
      appId = '';
    }
    line(
      `webOS HÍD: webOSSystem=${system ? 'van' : 'NINCS'}; webOS=${host.webOS ? 'van' : 'NINCS'}; `
      + `PalmSystem=${host.PalmSystem ? 'van' : 'nincs'}; PalmServiceBridge=${host.PalmServiceBridge ? 'van' : 'nincs'}; `
      + `modell=${model || 'ismeretlen'}; webOS verzió=${version || 'ismeretlen'}${sdk ? ` (SDK ${sdk})` : ''}; `
      + `appId=${appId || 'ismeretlen'}; IS_WEBOS_TV=${host.IS_WEBOS_TV ? 'igen' : 'nem'}`
    );
  });
}

/* ─────────────────────────────── 2. tároló ─────────────────────────────── */

function describeStorage(): void {
  safe('TÁROLÓ', () => {
    let localOk = false;
    let keys = 0;
    let chars = 0;
    try {
      window.localStorage.setItem('iptv_rt_boot_probe', '1');
      window.localStorage.removeItem('iptv_rt_boot_probe');
      localOk = true;
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key) continue;
        keys += 1;
        chars += key.length + (window.localStorage.getItem(key) || '').length;
      }
    } catch {
      localOk = false;
    }
    const idb = typeof window.indexedDB !== 'undefined' ? 'elérhető' : 'NINCS';
    line(
      `TÁROLÓ: localStorage=${localOk ? 'OK' : 'NEM ELÉRHETŐ'}`
      + `${localOk ? ` (${keys} kulcs / ${chars} karakter)` : ''}; IndexedDB=${idb}`
    );
  });
}

/* ─────────────────────────────── 3. média ──────────────────────────────── */

function describeMedia(): void {
  safe('MÉDIA', () => {
    const probe = document.createElement('video');
    const can = (type: string) => probe.canPlayType(type) || 'nem';
    line(
      `MÉDIA: MPEG-TS=${can('video/mp2t')}; HLS=${can('application/vnd.apple.mpegurl')}; `
      + `MP4=${can('video/mp4')}; HEVC=${can('video/mp4; codecs="hvc1.1.6.L93.B0"')}; `
      + `H.264=${can('video/mp4; codecs="avc1.42E01E"')}`
    );
  });
}

/*
 * A LASSÚ PRÓBÁK NEM FUTNAK A REACT FESTÉSE ELŐTT (2.5.128).
 *
 * A localStorage írása/törlése/teljes bejárása és a <video> létrehozása a
 * webOS-on szinkron, blokkoló művelet. A 21:31:49-es naplóban a diagnosztika
 * +1430 ms-nál indult, és a felület +1751 ms-nál épült fel – közvetlenül
 * egymás után, 167/350/200/183 ms-os képkocka-kihagyásokkal. Ezeket a
 * kizárólag NAPLÓZÁSHOZ kellő méréseket most a következő feladatra tesszük:
 * a napló tartalma változatlan, de a fő szál felszabadul az első festésre.
 */
let slowProbesDone = false;
let slowProbesTimer: number | null = null;

function clearSlowProbesTimer(): void {
  if (slowProbesTimer === null) return;
  try { window.clearTimeout(slowProbesTimer); } catch { /* már lejárt */ }
  slowProbesTimer = null;
}

function runSlowStartupProbes(): void {
  if (slowProbesDone) return;
  slowProbesDone = true;
  clearSlowProbesTimer();
  describeStorage();
  describeMedia();
}

function scheduleSlowStartupProbes(): void {
  clearSlowProbesTimer();
  slowProbesTimer = window.setTimeout(runSlowStartupProbes, 0);
  cleanups.push(clearSlowProbesTimer);
}

/* ────────────────────────── 4. HTML előtti jelzések ─────────────────────── */

function readMarks(): BootMark[] {
  const marks = diagWindow().__IPTV_STARTUP_MARKS__;
  if (!Array.isArray(marks)) return [];
  return marks.slice(0, 300).filter((mark) => mark && typeof mark === 'object');
}

/** A HTML/webOS szkript ELŐTTI lépései – ezek a napló legkorábbi pontjai. */
function dumpNewMarks(): void {
  const marks = readMarks();
  if (marks.length === 0) {
    if (!marksMissingLogged) {
      marksMissingLogged = true;
      line('HTML JELZÉSEK: nincs korai jelzés (a webOS/HTML szkript nem futott le ebben a környezetben)');
    }
    return;
  }
  for (let index = marksReported; index < marks.length; index += 1) {
    const mark = marks[index];
    const at = Number(mark.at) || 0;
    line(`HTML JELZÉS: +${Math.max(0, at - bootEpoch)} ms – ${String(mark.label || 'ismeretlen lépés').slice(0, 200)}`);
  }
  marksReported = marks.length;
}

/* ──────────────────────── 5. betöltés és első festés ───────────────────── */

function dumpNavigationTiming(phase: string): void {
  safe('BETÖLTÉS', () => {
    const entries = entriesByType('navigation') as PerformanceNavigationTiming[];
    const nav = entries && entries[0];
    if (!nav) {
      line(`${phase}: a böngésző nem ad navigációs mérést`);
      return;
    }
    const round = (value: number) => Math.max(0, Math.round(value || 0));
    line(
      `${phase}: DNS=${round(nav.domainLookupEnd - nav.domainLookupStart)} ms; `
      + `TCP=${round(nav.connectEnd - nav.connectStart)} ms; TTFB=${round(nav.responseStart - nav.requestStart)} ms; `
      + `válasz=${round(nav.responseEnd - nav.responseStart)} ms; `
      + `DOM kész=${round(nav.domContentLoadedEventEnd)} ms; load=${round(nav.loadEventEnd)} ms; `
      + `átvitt=${round(nav.transferSize)} B (a lap betöltésétől)`
    );
  });
}

function dumpPaintTiming(): void {
  safe('ELSŐ FESTÉS', () => {
    const paints = entriesByType('paint');
    if (!paints || paints.length === 0) {
      line('ELSŐ FESTÉS: még nincs festési mérés');
      return;
    }
    for (const paint of paints) {
      line(`ELSŐ FESTÉS: ${paint.name} = ${Math.round(paint.startTime)} ms (a lap betöltésétől)`);
    }
  });
}

/* ─────────────────────────── 6. erőforrások ────────────────────────────── */

/**
 * Mi töltődött le, mennyi ideig és mekkora adat.
 *
 * A Resource Timing az XHR/kép/script/stílus kéréseket is tartalmazza, ezért
 * ebből látszik, hogy az indulás melyik kérésen akadt el (pl. a szolgáltató
 * válasza, logó, betűtípus). Az URL-ekből a napló-réteg eltávolítja a
 * belépési adatokat.
 */
function dumpResourceTiming(phase: string): void {
  safe('ERŐFORRÁSOK', () => {
    const entries = entriesByType('resource') as PerformanceResourceTiming[];
    if (!entries || entries.length === 0) {
      line(`${phase}: még nincs betöltött erőforrás-mérés`);
      return;
    }
    let bytes = 0;
    const byType = new Map<string, number>();
    const slow: Array<{ name: string; ms: number; size: number; type: string }> = [];
    for (const entry of entries) {
      const size = Number(entry.transferSize || entry.encodedBodySize || 0);
      bytes += size;
      const type = String(entry.initiatorType || 'egyéb');
      byType.set(type, (byType.get(type) || 0) + 1);
      slow.push({ name: String(entry.name || ''), ms: Number(entry.duration) || 0, size, type });
    }
    slow.sort((a, b) => b.ms - a.ms);
    const typeText = Array.from(byType.entries())
      .map(([type, count]) => `${type}=${count}`)
      .join(', ');
    line(
      `${phase}: ${entries.length} erőforrás, összesen ${(bytes / 1024).toFixed(1)} kB (${typeText})`
    );
    const alreadyReported = new Set<string>();
    for (const item of slow) {
      if (item.ms < 300) break;
      if (resourcesReported >= 8) break;
      if (alreadyReported.has(item.name)) continue;
      alreadyReported.add(item.name);
      resourcesReported += 1;
      line(
        `LASSÚ ERŐFORRÁS: ${Math.round(item.ms)} ms; ${(item.size / 1024).toFixed(1)} kB; `
        + `${item.type}; ${item.name.slice(0, 180)}`
      );
    }
  });
}

/* ─────────────── 7. megjelenő / eltűnő elemek (felugrások) ──────────────── */

const WATCHED_ELEMENTS: Array<{ selector: string; label: string }> = [
  { selector: '[role="dialog"]', label: 'ABLAK' },
  { selector: 'video[data-iptv-player="true"]', label: 'LEJÁTSZÓ' },
  { selector: 'header', label: 'FEJLÉC' },
  { selector: '[role="listbox"]', label: 'CSATORNALISTA' },
  { selector: '[data-live-osd]', label: 'OSD' },
  { selector: '[data-live-sidebar]', label: 'OLDALSÁV' },
  { selector: '[data-tv-folders]', label: 'MAPPASÁV' },
  { selector: '#tv-curtain', label: 'TAKARÓKÉP' },
  { selector: '#webos-rc-diag', label: 'DIAGNOSZTIKAI DOBOZ' },
  { selector: '[data-loading-diagnostic]', label: 'BETÖLTÉS-ABLAK' },
];

function describeElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : '';
  const role = element.getAttribute('role');
  const label = element.getAttribute('aria-label');
  const classes = (element.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
  return `<${tag}${id}${role ? ` role="${role}"` : ''}${label ? ` aria-label="${label.slice(0, 60)}"` : ''}`
    + `${classes ? ` class=${classes}` : ''}; gyerek=${element.childElementCount}>`;
}

function matchesAny(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function attachVideoEvents(video: HTMLVideoElement): void {
  const events: Array<[string, string]> = [
    ['loadedmetadata', 'metaadat kész'],
    ['canplay', 'lejátszásra kész'],
    ['playing', 'elindult'],
    ['waiting', 'pufferelés (megakadás)'],
    ['stalled', 'a stream megakadt'],
    ['error', 'HIBA'],
  ];
  for (const [name, label] of events) {
    try {
      video.addEventListener(name, () => {
        if (!running) return;
        const rect = video.getBoundingClientRect();
        line(
          `LEJÁTSZÓ ESEMÉNY: ${label} (${name}); méret=${Math.round(rect.width)}x${Math.round(rect.height)}; `
          + `kész=${video.readyState}; t=${Number(video.currentTime || 0).toFixed(1)} s; `
          + `forrás=${(video.currentSrc || 'nincs').slice(0, 90)}`
        );
      });
    } catch {
      /* a lejátszó eseménye nem kötelező */
    }
  }
}

function watchElements(): void {
  if (typeof MutationObserver !== 'function') {
    line('ELEM-FIGYELŐ: a böngésző nem támogatja (nincs elem-megjelenés naplózás)');
    return;
  }
  const seen = new WeakSet<Element>();
  const allSelectors = WATCHED_ELEMENTS.map((item) => item.selector).join(',');

  /**
   * Egyetlen elem vizsgálata (és naplózása, ha figyelt elem).
   *
   * A FELUGRÓ ABLAK mindig bekerül a naplóba (legfeljebb 40 esemény), mert a
   * „felugrások” okának keresése a cél; a többi elem naplózása 120 eseménynél
   * lezárul, hogy hosszú listák kirajzolásakor se legyen felesleges munka.
   */
  const record = (element: Element, direction: 'MEGJELENT' | 'ELTŰNT'): void => {
    if (direction === 'MEGJELENT' && seen.has(element)) return;
    for (const item of WATCHED_ELEMENTS) {
      if (!matchesAny(element, item.selector)) continue;
      if (direction === 'MEGJELENT') seen.add(element);
      if (item.selector === '[role="dialog"]') {
        if (direction === 'MEGJELENT') dialogsSeen += 1;
        if (dialogEvents < 40) {
          dialogEvents += 1;
          line(`ELEM ${direction}: ${item.label} ${describeElement(element)}`);
        }
        continue;
      }
      if (elementEvents < 120) {
        elementEvents += 1;
        line(`ELEM ${direction}: ${item.label} ${describeElement(element)}`);
      }
      if (item.selector === 'video[data-iptv-player="true"]' && direction === 'MEGJELENT') {
        attachVideoEvents(element as HTMLVideoElement);
      }
    }
  };

  /**
   * Egy hozzáadott/elvett részfa vizsgálata.
   *
   * A React a felületet lépésenként építi, ezért a fejléc, a lista vagy egy
   * felugró ablak egy nagyobb, hozzáadott részfa BELSEJÉBEN is megjelenhet.
   * Ezért a részfa belsejére is keresünk – a naplózás 120 eseménynél lezárul,
   * így a hosszú lista kirajzolása közben a figyelő munkája korlátozott.
   */
  const consider = (element: Element, direction: 'MEGJELENT' | 'ELTŰNT'): void => {
    record(element, direction);
    if (direction !== 'MEGJELENT') {
      // Eltűnésnél elég a részfa gyökere + a benne lévő ablakok/lejátszó.
      if (!matchesAny(element, '[role="dialog"], video[data-iptv-player="true"]')) return;
    }
    // Az indulás alatt (20 mp-ig) a teljes figyelt elem-készletre keresünk a
    // hozzáadott részfán belül; utána már csak az ablakokra és a lejátszóra,
    // hogy a lista görgetése/kirajzolása ne kapjon plusz munkát.
    const fullScan = elapsed() < 20000;
    let nested: Element[] = [];
    try {
      nested = Array.from(
        element.querySelectorAll(fullScan ? allSelectors : '[role="dialog"], video[data-iptv-player="true"]')
      ).slice(0, 40);
    } catch {
      nested = [];
    }
    for (const child of nested) record(child, direction);
  };

  /*
   * KÖTEGELT MUTÁCIÓK. A React a teljes főoldalat egy feladatban építi fel;
   * korábban a figyelő minden egyes hozzáadott csomópontra AZONNAL végigjárta
   * a részfát, és getBoundingClientRect()-tel kényszerített elrendezést. Ez
   * volt a +1761…+2284 ms közötti 167/350/200/183 ms-os képkocka-kihagyások
   * egyik oka. Most a mutációkat összegyűjtjük, és a festés UTÁN, adagonként
   * dolgozzuk fel – a napló tartalma ugyanaz, a fő szál viszont szabad.
   */
  type PendingMutation = { element: Element; direction: 'MEGJELENT' | 'ELTŰNT' };
  const pending: PendingMutation[] = [];
  const MAX_PENDING = 160;
  let flushTimer: number | null = null;

  const flushPending = (): void => {
    flushTimer = null;
    if (!running) { pending.length = 0; return; }
    let handled = 0;
    while (pending.length > 0 && handled < 40) {
      const item = pending.shift();
      if (!item) break;
      consider(item.element, item.direction);
      handled += 1;
    }
    if (pending.length > 0 && flushTimer === null) {
      flushTimer = window.setTimeout(flushPending, 0);
    }
  };
  const scheduleFlush = (): void => {
    if (flushTimer === null) flushTimer = window.setTimeout(flushPending, 0);
  };

  const observer = new MutationObserver((records) => {
    if (!running) return;
    for (const recordItem of records) {
      const added = recordItem.addedNodes;
      for (let index = 0; index < added.length; index += 1) {
        const node = added[index];
        if (!node || node.nodeType !== 1) continue;
        if (pending.length < MAX_PENDING) {
          pending.push({ element: node as Element, direction: 'MEGJELENT' });
        }
      }
      const removed = recordItem.removedNodes;
      for (let index = 0; index < removed.length; index += 1) {
        const node = removed[index];
        if (!node || node.nodeType !== 1) continue;
        if (pending.length < MAX_PENDING) {
          pending.push({ element: node as Element, direction: 'ELTŰNT' });
        }
      }
    }
    if (pending.length > 0) scheduleFlush();
  });
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
  cleanups.push(() => {
    try {
      observer.disconnect();
    } catch {
      /* már lecsatlakozott */
    }
    if (flushTimer !== null) {
      try { window.clearTimeout(flushTimer); } catch { /* már lejárt */ }
      flushTimer = null;
    }
    pending.length = 0;
  });

  // A naplózás indításakor már a képernyőn lévő elemek is bekerülnek.
  for (const item of WATCHED_ELEMENTS) {
    try {
      const existing = Array.from(document.querySelectorAll(item.selector)).slice(0, 6);
      for (const element of existing) record(element, 'MEGJELENT');
    } catch {
      /* nem elérhető */
    }
  }
}

/* ─────────────────────── 8. a képernyő pillanatképe ────────────────────── */

function screenState(): string {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
    .map((dialog) => dialog.getAttribute('aria-label') || dialog.id || 'névtelen');
  const video = document.querySelector('video[data-iptv-player="true"]') as HTMLVideoElement | null;
  let videoText = 'nincs';
  if (video) {
    const rect = video.getBoundingClientRect();
    /*
     * 2.5.165 – NINCS KITALÁLT ADAT A NAPLÓBAN.
     *
     * Korábban a sor akkor is „(első képkocka megvan)”-t írt, amikor a
     * mérés szerint a videó 0x0 méretű és `kész=0` volt (semmi nem
     * dekódolódott). A jelzés (`__IPTV_VIDEO_READY__`) csak akkor kerül a
     * naplóba, ha a videó TÉNYLEG dekódolt képkockát mutat
     * (`readyState >= 2`). Ellenkező esetben a sor kimondja, hogy a jelzés
     * és a mérés ELLENTMOND.
     */
    const readyFlag = Boolean(diagWindow().__IPTV_VIDEO_READY__);
    const decoded = video.readyState >= 2;
    const frameNote = readyFlag && decoded
      ? ' (első képkocka megvan)'
      : readyFlag && !decoded
        ? ' (a kész-jelzés ellenére nincs dekódolt képkocka)'
        : '';
    videoText = `${Math.round(rect.width)}x${Math.round(rect.height)} kész=${video.readyState}`
      + ` ${video.paused ? 'áll' : 'játszik'}${frameNote}`;
  }
  const osd = document.querySelector('[data-live-osd]') as HTMLElement | null;
  let osdText = 'nincs';
  if (osd) {
    let display = '';
    try {
      display = window.getComputedStyle(osd).display;
    } catch {
      display = '';
    }
    osdText = display === 'none' ? 'rejtve' : 'látszik';
  }
  const active = document.activeElement as HTMLElement | null;
  const focusText = active && active.tagName
    ? `${active.tagName.toLowerCase()}${active.getAttribute('aria-label') ? ` "${active.getAttribute('aria-label')}"` : ''}`
    : 'nincs';
  const root = document.getElementById('root');
  const curtain = document.getElementById('tv-curtain');
  const htmlClass = (document.documentElement.className || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join('.');
  return [
    `ablak=${dialogs.length}${dialogs.length ? ` [${dialogs.join(' | ')}]` : ''}`,
    `videó=${videoText}`,
    `OSD=${osdText}`,
    `fókusz=${focusText}`,
    `#root gyerek=${root ? root.childElementCount : '?'}`,
    `takarókép=${curtain ? 'fent' : 'le'}`,
    `html=${htmlClass || 'nincs'}`,
  ].join('; ');
}

function sampleScreen(): void {
  if (!running) return;
  const state = screenState();
  if (state === lastScreenState) return;
  lastScreenState = state;
  line(`KÉPERNYŐ: ${state}`);
}

function startSampling(): void {
  sampleScreen();
  const tick = () => {
    if (!running) return;
    sampleScreen();
    dumpNewMarks();
    const age = elapsed();
    if (age > 45000) return;
    // Az első 15 mp-ben 500 ms-onként (korábban 250 ms): minden minta
    // elrendezést kényszerít (getBoundingClientRect), ezért a sűrű polling
    // mérhető képkocka-kihagyást okozott az indulás alatt.
    const delay = age < 15000 ? 500 : 1000;
    screenTimer = window.setTimeout(tick, delay);
  };
  screenTimer = window.setTimeout(tick, 500);
  cleanups.push(() => {
    if (screenTimer !== null) {
      try {
        window.clearTimeout(screenTimer);
      } catch {
        /* már lejárt */
      }
      screenTimer = null;
    }
  });
}

/* ─────────────────── 9. elrendezés-ugrások és képkockák ────────────────── */

function observePerformance(): void {
  const Observer = (window as unknown as { PerformanceObserver?: unknown }).PerformanceObserver as
    | (new (callback: (list: { getEntries: () => unknown[] }) => void) => {
        observe: (options: unknown) => void;
        disconnect: () => void;
      })
    | undefined;
  if (typeof Observer !== 'function') {
    line('TELJESÍTMÉNY-FIGYELŐ: a böngésző nem támogatja (nincs elrendezés-ugrás mérés)');
    return;
  }
  const subscribe = (type: string, handler: (entries: Array<Record<string, unknown>>) => void) => {
    try {
      const observer = new Observer((list) => {
        if (!running) return;
        handler(list.getEntries() as Array<Record<string, unknown>>);
      });
      try {
        observer.observe({ type, buffered: true });
      } catch {
        observer.observe({ entryTypes: [type] });
      }
      cleanups.push(() => {
        try {
          observer.disconnect();
        } catch {
          /* már lecsatlakozott */
        }
      });
    } catch {
      /* ez a mérési típus nem támogatott ezen a motoron */
    }
  };

  subscribe('largest-contentful-paint', (entries) => {
    for (const entry of entries) {
      const size = Number(entry.size) || 0;
      line(`LEGNAGYOBB TARTALOM: ${Math.round(Number(entry.startTime) || 0)} ms; `
        + `méret=${Math.round(size)} px²; `
        + `elem=${entry.element ? describeElement(entry.element as Element) : 'ismeretlen'}`);
    }
  });

  subscribe('layout-shift', (entries) => {
    for (const entry of entries) {
      if (entry.hadRecentInput === true) continue;
      const value = Number(entry.value) || 0;
      if (value < 0.005) continue;
      if (shiftEvents >= 60) continue;
      shiftEvents += 1;
      maxShift = Math.max(maxShift, value);
      const sources = Array.isArray(entry.sources) ? (entry.sources as Array<Record<string, unknown>>) : [];
      const sourceText = sources.length
        ? sources.slice(0, 3)
          .map((source) => (source.node ? describeElement(source.node as Element) : 'ismeretlen elem'))
          .join(', ')
        : 'nincs megadott forrás';
      line(`ELRENDEZÉS-UGRÁS (a kép elmozdult): ${value.toFixed(3)}; forrás: ${sourceText}`);
    }
  });
}

function watchFrames(): void {
  const raf = (window as unknown as { requestAnimationFrame?: (callback: (time: number) => void) => number })
    .requestAnimationFrame;
  if (typeof raf !== 'function') return;
  let last = 0;
  let stopped = false;
  cleanups.push(() => {
    stopped = true;
  });
  const tick = (now: number) => {
    if (stopped || !running) return;
    if (last > 0) {
      const gap = now - last;
      frameCount += 1;
      if (gap > 50) {
        maxFrameGap = Math.max(maxFrameGap, gap);
        if (jankEvents < 60) {
          jankEvents += 1;
          line(`KÉPKOCKA-KIHAGYÁS: ${Math.round(gap)} ms (a fő szál foglalt volt)`);
        }
      }
    }
    last = now;
    if (elapsed() < 8000) {
      raf(tick);
      return;
    }
    line(`KÉPKOCKA-ÖSSZEGZÉS: ${frameCount} képkocka az első 8 s-ban; leghosszabb kihagyás ${Math.round(maxFrameGap)} ms`);
  };
  raf(tick);
}

/* ─────────────────────────── 10. összegzés ─────────────────────────────── */

function logSummary(): void {
  if (summaryDone || !running) return;
  summaryDone = true;
  dumpNewMarks();
  const marks = readMarks();
  const reveal = marks.find((mark) => /REVEAL/i.test(String(mark.label || '')));
  const revealText = reveal ? `+${Math.max(0, (Number(reveal.at) || 0) - bootEpoch)} ms` : 'nem történt meg';
  let lines = 0;
  try {
    lines = manualLogSnapshot().lineCount;
  } catch {
    lines = 0;
  }
  dumpNavigationTiming('BETÖLTÉS (összegzés)');
  dumpResourceTiming('ERŐFORRÁSOK (összegzés)');
  line(
    `ÖSSZEGZÉS: a felület megjelent=${revealText}; felugró ablak=${dialogsSeen}; `
    + `elrendezés-ugrás=${shiftEvents} (legnagyobb ${maxShift.toFixed(3)}); `
    + `képkocka-kihagyás=${jankEvents} (legnagyobb ${Math.round(maxFrameGap)} ms); naplósor=${lines}`
  );
}

/* ────────────────────────── indítás és leállítás ───────────────────────── */

/**
 * A naplózás életciklusához csatlakozás. A figyelők akkor indulnak, amikor a
 * naplózás elindul (a tesztidőszakban ez az IPK indítása), és akkor állnak le,
 * amikor a naplózás leáll (a napló elküldése után).
 */
export function attachStartupDiagnostics(): void {
  registerLoggingLifecycleHooks({
    onStart: () => startStartupDiagnostics(),
    onStop: () => stopStartupDiagnostics(),
  });
}

export function startStartupDiagnostics(): void {
  if (running) return;
  running = true;
  const marks = readMarks();
  const firstMarkAt = marks.length ? Number(marks[0].at) || 0 : 0;
  const htmlEpoch = Number(diagWindow().__IPTV_BOOT_EPOCH__) || 0;
  bootEpoch = htmlEpoch || firstMarkAt || Date.now();
  if (firstMarkAt > 0 && firstMarkAt < bootEpoch) bootEpoch = firstMarkAt;
  summaryDone = false;

  if (!everStarted) {
    everStarted = true;
    line('=== TESZT IDŐSZAK: AUTOMATIKUS TELJES KÖRŰ INDULÁSI DIAGNOSZTIKA ===');
    line('A napló az IPK indításától fut, és a tesztidőszakban csak a napló elküldésekor áll le.');
    describeEnvironment();
    describePlatformBridge();
    // A TÁROLÓ és MÉDIA sorok a következő feladatban íródnak (lásd fent).
    scheduleSlowStartupProbes();
  } else {
    line('INDULÁSI DIAGNOSZTIKA FOLYTATVA (a naplózás újra aktív).');
  }
  dumpNewMarks();
  dumpNavigationTiming('BETÖLTÉS');
  dumpPaintTiming();
  watchElements();
  observePerformance();
  watchFrames();
  startSampling();

  // 10 mpnél külön kimutatás arról, mi töltődött le és mennyi ideig.
  const resourceTimer = window.setTimeout(() => {
    if (!running) return;
    dumpNewMarks();
    dumpResourceTiming('ERŐFORRÁSOK (10 mp)');
  }, 10000);
  // 25 mpnél lezáró összegzés (a naplózás továbbra is fut).
  const summaryTimer = window.setTimeout(() => {
    if (!running) return;
    logSummary();
  }, 25000);
  cleanups.push(() => {
    try {
      window.clearTimeout(resourceTimer);
    } catch {
      /* már lejárt */
    }
    try {
      window.clearTimeout(summaryTimer);
    } catch {
      /* már lejárt */
    }
  });
}

export function stopStartupDiagnostics(): void {
  if (!running) return;
  // Ha a naplót nagyon gyorsan leállítják, a halasztott sorok se vesszenek el.
  runSlowStartupProbes();
  running = false;
  logSummary();
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    try {
      cleanup?.();
    } catch {
      /* a tisztítás hibája nem akadályozhatja a leállást */
    }
  }
  if (screenTimer !== null) {
    try {
      window.clearTimeout(screenTimer);
    } catch {
      /* már lejárt */
    }
    screenTimer = null;
  }
  appLog(
    `BOOT-DIAG [+${elapsed()} ms] DIAGNOSZTIKA SZÜNETEL: `
    + `${elementEvents} elem-esemény, ${shiftEvents} elrendezés-ugrás, ${jankEvents} képkocka-kihagyás.`
  );
}
