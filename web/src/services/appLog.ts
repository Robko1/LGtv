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

// A kézi diagnosztikai napló és a Supabase-export felső határa 1 000 000 karakter.
// A napló NEM fut automatikusan: csak a SÁRGA gomb ablakában, a felhasználó
// „Naplózás indítása” gombjára kapcsol be.
const MAX_CHARS = 1_000_000;
const MAX_BUFFER_CHARS = MAX_CHARS - 512;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STORE_KEY = 'app-log';
const LOG_NUMBER_KEY = 'iptv_rt_diagnostic_next_number_v1';
const DEFAULT_APP_VERSION = 'IPTV R.T webOS';

let lines: string[] = [];
let chars = 0;
let restoreAttempted = false;
let saveTimer: number | null = null;
let loggingEnabled = false;
/** A nagy, szinkron localStorage-írás ne fusson másfél másodpercenként a TV-n. */
const PERSIST_DELAY_MS = 5000;
let activeLogNumber: number | null = null;
let activeLogStartedAt = 0;

/*
 * A régi mérési számlálók megmaradnak a diagnosztikai híd kompatibilitása miatt,
 * de most csak a kézzel indított naplózás alatt növekednek.
 */
let measurementStartedAt = Date.now();
const measurementCounters = { logLines: 0, errors: 0, longTasks: 0, critical: 0 };

/** A részletes lejátszási diagnosztika kizárólag kézi naplózás közben futhat. */
export function isVerbosePlaybackLogging(): boolean {
  return loggingEnabled;
}

export interface ManualLogSnapshot {
  enabled: boolean;
  number: number | null;
  startedAt: number;
  startedAtText: string;
  elapsedMs: number;
  lineCount: number;
  charCount: number;
}

/*
 * Intl.DateTimeFormat létrehozása drága (ICU adatok betöltése). Korábban
 * minden naplósorhoz új példány készült – egy csatornaváltás 8–12 sort ír,
 * ezért a formázót egyszer hozzuk létre és újrahasználjuk.
 */
let stampFormatter: Intl.DateTimeFormat | null = null;
function dublinFormatter(): Intl.DateTimeFormat {
  if (!stampFormatter) {
    stampFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Dublin',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
  }
  return stampFormatter;
}

/** A felugró ablakban megjelenő dátum/idő az ír helyi időzónában. */
export function dateTimeText(at: number = Date.now()): string {
  const parts = dublinFormatter().formatToParts(new Date(at));
  const value = (type: string) => parts.find((part) => part.type === type)?.value || '00';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

/** A napló minden abszolút időpontját az ír időzónában írjuk ki, explicit UTC-eltolással. */
function dublinTimestamp(at: number = Date.now()): string {
  // A TV órája egy órával késik; ezt kizárólag a napló időbélyegén korrigáljuk.
  // A Date.now() értékét és az alkalmazás óráját nem módosítjuk.
  const logAt = at + 60 * 60 * 1000;
  const date = new Date(logAt);
  const parts = dublinFormatter().formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || '00';
  const year = part('year');
  const month = part('month');
  const day = part('day');
  const hour = part('hour');
  const minute = part('minute');
  const second = part('second');
  const millis = String(date.getUTCMilliseconds()).padStart(3, '0');
  const localAsUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const offsetMinutes = Math.round((localAsUtc - Math.floor(logAt / 1000) * 1000) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = sign + String(Math.floor(absoluteOffset / 60)).padStart(2, '0') + ':' + String(absoluteOffset % 60).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}${offset}`;
}

function nowStamp(): string {
  return dublinTimestamp();
}

/** Csak a dátummal ellátott, elmúlt 24 órán belüli sorokat tartjuk meg. */
function trimExpired(): void {
  // Az időbélyegek egy órával korrigáltak; a korhatárt is ehhez igazítjuk.
  const now = Date.now() + 60 * 60 * 1000;
  const cutoff = now - MAX_AGE_MS;
  const fresh: string[] = [];
  for (const line of lines) {
    const timestamp = Date.parse(line.slice(0, line.indexOf(' ')));
    // A régi, dátum nélküli formátum korát nem lehet megbízhatóan megállapítani,
    // ezért nem tartjuk meg az új, 24 órás naplóban.
    if (Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now + 60_000) {
      fresh.push(line);
    }
  }
  lines = fresh;
  chars = lines.reduce((total, line) => total + line.length + 1, 0);
}

function trim(): void {
  // Nincs sorszámkorlát: a méretkorlát túllépésekor a napló újraindul.
  if (chars > MAX_BUFFER_CHARS) {
    lines = [];
    chars = 0;
  }
}

/** A korábbi munkamenet naplójának visszaolvasása (összeomlás utáni elemzéshez). */
function restore(): void {
  if (restoreAttempted) return;
  restoreAttempted = true;
  try {
    const raw = localStorage.getItem(`iptv_rt_${STORE_KEY}`) || '';
    if (!raw) return;
    const previous = String(raw).split('\n').filter(Boolean);
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
    }, PERSIST_DELAY_MS);
  } catch {
    saveTimer = null;
  }
}

/**
 * AZONNALI mentés (a késleltetés megkerülésével).
 *
 * Fagyás / összeomlás előtt nincs idő az összevont mentés késleltetésére: a
 * kritikus sorokat (LEÁLLÁS, IDŐVONAL, ÖSSZEOMLÁS) rögtön kiírjuk, hogy a
 * következő indításnál – és a kézzel elküldhető naplóban – ott legyen.
 * Nagy naplónál (30 KB felett) csak ritkán írunk, hogy a szinkron írás ne
 * lassítsa a TV-t.
 */
let lastPersistAt = 0;
let forceFlushTimer: number | null = null;
/** Két szinkron, nagyméretű naplóírás közötti minimális idő (ms). */
const MIN_FORCE_INTERVAL_MS = 2000;

function writeLogToStorage(): void {
  if (saveTimer !== null) {
    try { window.clearTimeout(saveTimer); } catch { /* nem elérhető */ }
    saveTimer = null;
  }
  if (forceFlushTimer !== null) {
    try { window.clearTimeout(forceFlushTimer); } catch { /* nem elérhető */ }
    forceFlushTimer = null;
  }
  lastPersistAt = Date.now();
  try {
    localStorage.setItem(`iptv_rt_${STORE_KEY}`, lines.join('\n'));
  } catch {
    /* a TV tárhelyhibája nem akadályozhatja a működést */
  }
}

function persistNow(force = false): void {
  if (!force) {
    if (chars > 30000) return;
    // Legfeljebb 30 másodpercenként írunk ki azonnal – a webOS localStorage
    // írása szinkron, és a lejátszás alatt nem akarunk plusz akadozást.
    if (Date.now() - lastPersistAt < 30000) return;
    writeLogToStorage();
    return;
  }
  /*
   * KRITIKUS SOR: azonnal megy a tárba. Ha azonban a napló már nagy
   * (30 KB felett), két szinkron, akár 1 MB-os írás 2 mp-en belül a TV-n
   * láthatóan megakasztotta a lejátszást. Ilyenkor a további kritikus
   * sorokat egyetlen, legfeljebb 2 mp múlva esedékes írásba fogjuk össze;
   * a napló minden sora így is megvan a memóriában.
   */
  if (chars <= 30000 || Date.now() - lastPersistAt >= MIN_FORCE_INTERVAL_MS) {
    writeLogToStorage();
    return;
  }
  if (forceFlushTimer === null) {
    const remaining = Math.max(50, MIN_FORCE_INTERVAL_MS - (Date.now() - lastPersistAt));
    try {
      forceFlushTimer = window.setTimeout(() => {
        forceFlushTimer = null;
        writeLogToStorage();
      }, remaining);
    } catch {
      forceFlushTimer = null;
      writeLogToStorage();
    }
  }
}

function allocateLogNumber(): number {
  let next = 1;
  try {
    const stored = Number(localStorage.getItem(LOG_NUMBER_KEY) || 1);
    if (Number.isFinite(stored) && stored > 0) next = Math.floor(stored);
    localStorage.setItem(LOG_NUMBER_KEY, String(next + 1));
  } catch {
    // Ha a TV tárhelye nem írható, az aktuális munkamenet akkor is kap számot.
    next = Math.max(1, Math.floor(Date.now() / 1000));
  }
  return next;
}

/** A kézi naplózás pillanatnyi állapota a SÁRGA ablak számára. */
export function manualLogSnapshot(): ManualLogSnapshot {
  const now = Date.now();
  return {
    enabled: loggingEnabled,
    number: activeLogNumber,
    startedAt: activeLogStartedAt,
    startedAtText: activeLogStartedAt ? dateTimeText(activeLogStartedAt) : '',
    elapsedMs: activeLogStartedAt ? Math.max(0, now - activeLogStartedAt) : 0,
    lineCount: lines.length,
    charCount: chars,
  };
}

/**
 * Kézi naplózás indítása. Minden indítás új sorszámot és tiszta, legfeljebb
 * 1 MB-os naplót kap; a számláló az IPK újraindítása után is folytatódik.
 */
export function startManualLogging(): ManualLogSnapshot {
  if (loggingEnabled && activeLogNumber !== null) return manualLogSnapshot();
  clearAppLog();
  const startedAt = Date.now();
  activeLogNumber = allocateLogNumber();
  activeLogStartedAt = startedAt;
  measurementStartedAt = startedAt;
  measurementCounters.logLines = 0;
  measurementCounters.errors = 0;
  measurementCounters.longTasks = 0;
  measurementCounters.critical = 0;
  loggingEnabled = true;
  // A főszál-/longtask-figyelő csak a kézzel indított diagnosztika idején
  // futhat: normál tévézésnél nincs szükség állandó timerre vagy observerre.
  startRuntimeWatchdog();
  let version = DEFAULT_APP_VERSION;
  try { version = String((window as unknown as { IPTV_RT_WEB_VERSION?: string }).IPTV_RT_WEB_VERSION || DEFAULT_APP_VERSION); } catch { /* régi/teszt környezet */ }
  appLog(`=== NAPLÓZÁS INDULT; napló=#${activeLogNumber}; kezdete=${dateTimeText(startedAt)}; verzió=${version} ===`);
  appLog(`=== IPTV indul; verzió=${version}; kézi naplózás ===`);
  appLog(`INDULÁS [0 ms] kézi naplózás elindítva; napló=#${activeLogNumber}`);
  appLog(`Eszköz: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'ismeretlen környezet'}`);
  appLog('FIGYELŐ ELINDULT; kézi naplózás aktív; a lejátszás- és fagyásfigyelés mostantól rögzít.');
  return manualLogSnapshot();
}

/** Kézi naplózás leállítása; az elküldéshez a kész napló memóriában marad. */
export function stopManualLogging(reason = 'kézi leállítás'): ManualLogSnapshot {
  if (loggingEnabled) {
    appLog(`=== NAPLÓZÁS LEÁLLÍTVA; napló=#${activeLogNumber ?? 'ismeretlen'}; ok=${reason} ===`);
  }
  loggingEnabled = false;
  stopRuntimeWatchdog();
  persistNow(true);
  // A nagy napló utolsó szinkron mentése eddig egy legfeljebb 2 másodperc
  // múlva lefutó forceFlushTimer-t hagyhatott maga után. Leállítás után nem
  // maradhat ilyen háttérmunka; ha szükséges, most egyetlen végső írással
  // zárjuk le a memóriában már kész naplót.
  if (forceFlushTimer !== null) {
    try { window.clearTimeout(forceFlushTimer); } catch { /* régi webOS */ }
    forceFlushTimer = null;
    writeLogToStorage();
  }
  return manualLogSnapshot();
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
  if (forceFlushTimer !== null) {
    try { window.clearTimeout(forceFlushTimer); } catch { /* nem elérhető */ }
    forceFlushTimer = null;
  }
  lastPersistAt = 0;
  lines = [];
  chars = 0;
  restoreAttempted = true;
  try {
    localStorage.removeItem(`iptv_rt_${STORE_KEY}`);
  } catch {
    /* a naplótár hibája nem akadályozhatja az alkalmazás működését */
  }
}

/** Egy sor hozzáadása a kézzel indított diagnosztikai naplóhoz. */
export function appLog(message: string): void {
  // A normál tévézés közben nincs diagnosztikai naplózás, nincs localStorage-
  // írás és nincs extra szövegfeldolgozás. Ez a csatornaváltást is gyorsítja.
  if (!loggingEnabled) return;
  const safe = String(message ?? '').replace(/\s+/g, ' ');
  restore();
  measurementCounters.logLines += 1;
  const restartNotice = `${nowStamp()} NAPLÓKERET ELÉRVE: 1 MB; a naplózás újrakezdődött.`;
  let line = `${nowStamp()} ${safe}`;
  // Egyetlen rendkívül hosszú esemény sem lépheti túl a teljes keretet.
  if (line.length + 1 > MAX_BUFFER_CHARS - restartNotice.length - 1) {
    line = line.slice(0, MAX_BUFFER_CHARS - restartNotice.length - 2);
  }
  if (chars + line.length + 1 > MAX_BUFFER_CHARS) {
    lines = [restartNotice];
    chars = restartNotice.length + 1;
  }
  lines.push(line);
  chars += line.length + 1;
  // A kézi munkamenet mindig tiszta naplóval indul. A korhatár-ellenőrzés
  // visszaállításkor és export előtt elég; soronkénti Date.parse O(n²)
  // munkát nem végezhetünk a TV főszálán.
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

/* ══════════════════════════════════════════════════════════════════════════
 * MÉRÉS-ABLAK (2.5.32)
 *
 * A régi mérési híd kompatibilitásból ÚJ MÉRÉST tud indítani:
 *   • a mért értékek (naplósorok, hibák, hosszú feladatok) 0-ra állnak,
 *   • a mérés kezdete látható időpont lesz (a felugró ablakban és a naplóban is),
 *   • a naplóba egy jól látható, elválasztott sor kerül a kezdő időponttal,
 *   • az idővonal (15 mp) és a hosszú feladat mérése is innentől számol.
 * Így a fejlesztői hídon ellenőrizhető, hogy a nullázás megtörtént.
 * ══════════════════════════════════════════════════════════════════════════ */

export interface MeasurementSnapshot {
  /** A mérés kezdete (Date.now(), ezredmásodperc). */
  startedAt: number;
  /** A mérés kezdete ember által olvashatóan (HH:MM:SS). */
  startedAtText: string;
  /** A kezdet óta eltelt idő ezredmásodpercben. */
  elapsedMs: number;
  /** A kezdet óta írt naplósorok száma. */
  logLines: number;
  /** A kezdet óta rögzített hibák (JS-hiba / kezeletlen ígérethiba). */
  errors: number;
  /** A kezdet óta rögzített hosszú feladatok (fagyásgyanú). */
  longTasks: number;
  /** A kezdet óta rögzített kritikus (azonnal mentett) sorok. */
  critical: number;
}

/** Óra:perc:másodperc alak (a TV helyi ideje szerint). */
export function clockText(at: number = Date.now()): string {
  const date = new Date(at);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || '00';
  return `${value('hour')}:${value('minute')}:${value('second')}`;
}

/** A pillanatnyi mérés-ablak (a nullázás óta mért értékek). */
export function measurementSnapshot(): MeasurementSnapshot {
  const now = Date.now();
  return {
    startedAt: measurementStartedAt,
    startedAtText: clockText(measurementStartedAt),
    elapsedMs: Math.max(0, now - measurementStartedAt),
    logLines: measurementCounters.logLines,
    errors: measurementCounters.errors,
    longTasks: measurementCounters.longTasks,
    critical: measurementCounters.critical,
  };
}

/**
 * ÚJ MÉRÉS indítása: minden mért érték 0-ra áll, a kezdő időpont pedig
 * láthatóan bekerül a naplóba (és a felugró ablakban is megjelenik).
 */
export function resetMeasurements(reason: string = 'kézi frissítés'): MeasurementSnapshot {
  // A resetMeasurements egy valódi új mérési ablak: a korábbi sorok a memóriából és
  // a tartós naplótárból is törlődnek. A 24 órás automatikus megőrzési szabály
  // ettől függetlenül változatlan marad a normál naplózás során.
  // A nullázás ELŐTTI értékeket azért mentsük el, hogy az új naplóban is
  // látszódjon a bizonyíték: volt mit nullázni (ezt a fejlesztői mérési híd használja).
  const previous = measurementSnapshot();
  const startedAt = Date.now();
  if (!loggingEnabled) startManualLogging();
  else clearAppLog();
  measurementStartedAt = startedAt;
  measurementCounters.logLines = 0;
  measurementCounters.errors = 0;
  measurementCounters.longTasks = 0;
  measurementCounters.critical = 0;

  // Az idővonal és a hosszú feladatok ritkítási ablaka is ettől az időponttól indul.
  try {
    lastLongTaskAt = 0;
    lastTickAt = startedAt;
  } catch {
    /* a figyelő még nem indult el */
  }

  appLog(`=== ÚJ MÉRÉS KEZDETE: ${dublinTimestamp(startedAt)} (${clockText(startedAt + 60 * 60 * 1000)}); minden korábbi mért érték nullázva; ok: ${reason} ===`);
  appLog(`MÉRÉS NULLÁZÁS ELŐTT [${previous.startedAtText} óta]: naplósorok=${previous.logLines}, hibák=${previous.errors}, hosszú feladatok=${previous.longTasks}`);
  appLog(`MÉRÉS ÁLLAPOTA [${clockText(startedAt + 60 * 60 * 1000)}]: számlálók nullázva; ${memorySnapshot()}; ${uiStateSnapshot()}`);
  // A két kezdősor a kézi naplóban megmarad, de nem növeli a mérés számlálóját.
  measurementCounters.logLines = 0;
  measurementCounters.errors = 0;
  measurementCounters.longTasks = 0;
  measurementCounters.critical = 0;
  return measurementSnapshot();
}

/** A kézi napló teljes szövege, az azonosító fejlécével együtt. */
export function getAppLogText(): string {
  // Régi/automatikus napló nem küldhető: csak kézzel indított munkamenet
  // tartalma mehet ki a Supabase-re.
  if (activeLogNumber === null || activeLogStartedAt <= 0) return '';
  restore();
  trimExpired();
  trim();
  const measure = measurementSnapshot();
  const header = `--- WEBOS NAPLÓ #${activeLogNumber} (${lines.length} sor; teljes napló; max. 1 MB) | NAPLÓ KEZDETE: ${dateTimeText(activeLogStartedAt)} | MÉRÉS KEZDETE: ${clockText(measure.startedAt)} ---`;
  return [header, ...lines].join('\n');
}

/** Indulási sorok: verzió, eszköz, memória. */
export function logStartup(version: string = DEFAULT_APP_VERSION): void {
  appLog(`=== IPTV indul; verzió=${version}; felület=${location.href.split('/').pop() || ''} ===`);
  appLog(`Eszköz: ${navigator.userAgent}`);
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
 * A sorok a SÁRGA (teletext) gombon megnyitható kézi diagnosztikai naplóba kerülnek, tehát a
 * TV-n semmit nem kell gépelni – a Küldés gombbal a teljes napló közvetlenül elküldhető.
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
  if (!loggingEnabled) return;
  appLog(message);
  measurementCounters.critical += 1;
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
let watchdogTimer: number | null = null;
let longTaskObserver: { disconnect?: () => void } | null = null;
let lastTickAt = 0;
let lastLongTaskAt = 0;
/** Ennél hosszabb kimaradás = a fő szál állt (TV-n ez már látható fagyás). */
const STALL_MS = 2500;

/**
 * Futásidejű fagyásfigyelő. Csak kézi diagnosztika alatt él: normál
 * tévézésnél nem tartunk fenn másodpercenkénti timer-t és PerformanceObservert.
 */
export function startRuntimeWatchdog(): void {
  if (watchdogStarted || !loggingEnabled) return;
  watchdogStarted = true;
  lastTickAt = Date.now();

  const tick = () => {
    const now = Date.now();
    const gap = now - lastTickAt;
    lastTickAt = now;
    if (gap >= STALL_MS) {
      appLogCritical(`LEÁLLÁS: a fő szál ${gap} ms-ig nem futott (várt: 1000 ms). ${uiStateSnapshot()}`);
    }
  };
  try {
    watchdogTimer = window.setInterval(tick, 1000);
  } catch {
    watchdogTimer = null;
  }

  try {
    const Observer = (window as unknown as {
      PerformanceObserver?: new (callback: (list: { getEntries: () => Array<{ duration: number; name: string }> }) => void) => {
        observe: (options: { entryTypes: string[] }) => void;
        disconnect?: () => void;
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
          measurementCounters.longTasks += 1;
          appLogCritical(`HOSSZÚ FELADAT: ${Math.round(entry.duration)} ms (${entry.name || 'ismeretlen'}). ${uiStateSnapshot()}`);
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
      longTaskObserver = observer;
    }
  } catch {
    longTaskObserver = null;
  }

  appLogCritical('FIGYELŐ ELINDULT; csatornaváltási tesztmérés; főszál-fagyás és JS-hibák figyelése.');
}

/** A kézi napló leállításakor a fagyásfigyelő erőforrásait is felszabadítjuk. */
export function stopRuntimeWatchdog(): void {
  if (watchdogTimer !== null) {
    try { window.clearInterval(watchdogTimer); } catch { /* régi motor */ }
    watchdogTimer = null;
  }
  try { longTaskObserver?.disconnect?.(); } catch { /* régi motor */ }
  longTaskObserver = null;
  watchdogStarted = false;
}

/**
 * Összeomlás- és kilépésfigyelő.
 *
 * A `pagehide` / `visibilitychange` sorok bizonyítják, hogy a webOS kiléptette
 * az appot (nem a felület fagyott le örökre), a hibakezelők pedig a tényleges
 * JS-hibát írják a naplóba – a kézzel elküldhető naplóból ez alapján lehet
 * pontosan javítani.
 */
export function installCrashHandlers(): void {
  try {
    window.addEventListener('error', (event) => {
      measurementCounters.errors += 1;
      const message = String((event as ErrorEvent)?.message || 'ismeretlen hiba');
      const where = `${(event as ErrorEvent)?.filename || ''}:${(event as ErrorEvent)?.lineno || 0}`;
      appLogCritical(`ÖSSZEOMLÁS: ${message} @ ${where}; ${uiStateSnapshot()}`);
    });
  } catch { /* nem elérhető */ }

  try {
    window.addEventListener('unhandledrejection', (event) => {
      measurementCounters.errors += 1;
      const reason = (event as PromiseRejectionEvent)?.reason;
      const text = reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : String(reason).slice(0, 300);
      appLogCritical(`KEZELETLEN ÍGÉRETHIBA: ${text}; ${uiStateSnapshot()}`);
    });
  } catch { /* nem elérhető */ }

  try {
    const stopOnExit = () => {
      // A webOS kilépésekor a kézi naplózás mindig lezárul. Nem maradhat
      // bekapcsolva egy újraindítás után, és nem készülhet automatikus export.
      if (loggingEnabled) {
        appLogCritical(`OLDAL ELHAGYÁSA (pagehide) – az app leáll vagy kilépett. ${uiStateSnapshot()}`);
        stopManualLogging('IPK/app elhagyása');
      }
    };
    window.addEventListener('pagehide', stopOnExit);
    window.addEventListener('beforeunload', stopOnExit);
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
