/**
 * Webes oldali napló a Beállítások → Hibakeresési napló laphoz.
 *
 * A napló a TV böngészőjének fontos lépéseit rögzíti (tartalom betöltése,
 * mentés, memória), és a localStorage-ba is kiírja, hogy alkalmazás-újraindítás
 * után is megmaradjon.
 *
 * A napló szigorúan korlátozott méretű: a legrégebbi sorok automatikusan
 * törlődnek, így hosszú használat után sem növeli a memóriát.
 *
 * TESZT IDŐSZAK: a `diagnosticsConfig.ts` kapcsolója bekapcsolva a naplózás az
 * IPK indításakor magától elindul, és a napló elküldéséig fut. A kapcsoló
 * kikapcsolásával a régi viselkedés (csak kézi indítás) áll vissza.
 */
import { TEST_STARTUP_DIAGNOSTICS } from './diagnosticsConfig';

// A kézi diagnosztikai napló és a Supabase-export felső határa 1 000 000 karakter.
// A naplózás a TESZTELÉSI IDŐSZAKBAN az IPK indításakor magától elindul
// (`diagnosticsConfig.ts` kapcsolója), és a kézi küldésig gyűlik. A kapcsoló
// kikapcsolása után a régi viselkedés él: csak a SÁRGA ablak
// „Naplózás indítása” gombjára kapcsol be.
const MAX_CHARS = 1_000_000;
const MAX_BUFFER_CHARS = MAX_CHARS - 512;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STORE_KEY = 'app-log';
/*
 * A TÁRBAN TARTOTT NAPLÓ MÉRETE.
 *
 * A teljes napló (legfeljebb 1 000 000 karakter) a memóriában marad, és a
 * kézi „Napló küldése” gombbal megy fel a szerverre – ott nincs rá kvóta.
 * A localStorage-ba viszont eddig UGYANEZ az 1 000 000 karakter került, ami
 * a webOS ~5 MB-os keretéből ~2 MB-ot foglalt, és a teljes élő csatornalistával
 * együtt pont a kvóta fölé vitte a tárhelyet (TÁROLÓ HIBA … foglaltság=5115 kB).
 * Ezt a kulcsot a takarítás (sweepStorage) nem látja, mert nem tartalom-adag,
 * ezért itt kell korlátozni: csak az utolsó 120 000 karakter marad meg, ami
 * bőven elég az újraindítás utáni elemzéshez.
 */
const PERSIST_MAX_CHARS = 120_000;
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
/**
 * Mikor állt le a kézi naplózás (0 = még fut).
 *
 * AZ ELTELT IDŐ A LEÁLLÍTÁSKOR MEGÁLL: korábban a számláló tovább ketyegett,
 * és a leállított naplónál is nőtt az „ELTELT IDŐ” – megtévesztő volt, mert
 * azt sugallta, hogy a naplózás még mindig fut. Aktív naplózásnál az óra
 * folyamatosan számol, leállítás után a leállítás pillanatában megáll.
 */
let activeLogStoppedAt = 0;

/* ══════════════════════════════════════════════════════════════════════════
 * AUTOMATIKUS NAPLÓZÁS (CSAK A TESZTELÉSI IDŐSZAKBAN)
 *
 * A naplózás a `TEST_STARTUP_DIAGNOSTICS` kapcsolóval az IPK indításakor
 * magától elindul. A napló a kézi küldésig gyűlik; a TV kilépésekor (pagehide)
 * – a korábbi viselkedés szerint – leáll, de ha az app előtérbe kerül és a
 * naplót NEM küldték el, ugyanabban a munkamenetben folytatódik, hogy semmi
 * ne vesszen el. Küldés után nem indul újra magától.
 * ══════════════════════════════════════════════════════════════════════════ */
let autoStartedSession = false;
let autoSuppressed = false;
let autoResumePending = false;
/** Mikor indult a tesztidőszak automatikus munkamenete (a részletes lejátszás-ablakhoz). */
let autoSessionStartedAt = 0;

/** A naplózás életciklusára csatlakozó külső modulok (indulási diagnosztika). */
export interface LoggingLifecycleHooks {
  onStart?: () => void;
  onStop?: () => void;
}

const lifecycleHooks: LoggingLifecycleHooks[] = [];

/**
 * Csatlakozás a naplózás életciklusához. Ha a naplózás már fut, az `onStart`
 * azonnal lefut, így az indulási diagnosztika nem marad le a napló kezdetéről.
 */
export function registerLoggingLifecycleHooks(hooks: LoggingLifecycleHooks): void {
  lifecycleHooks.push(hooks);
  if (loggingEnabled) {
    try { hooks.onStart?.(); } catch { /* a figyelő hibája nem állíthatja meg a naplót */ }
  }
}

function runLifecycleHooks(phase: 'start' | 'stop'): void {
  for (const hook of lifecycleHooks) {
    try {
      if (phase === 'start') hook.onStart?.();
      else hook.onStop?.();
    } catch {
      /* egy figyelő hibája nem akadályozhatja a naplózást */
    }
  }
}

/*
 * A régi mérési számlálók megmaradnak a diagnosztikai híd kompatibilitása miatt,
 * de most csak a kézzel indított naplózás alatt növekednek.
 */
let measurementStartedAt = Date.now();
const measurementCounters = { logLines: 0, errors: 0, longTasks: 0, critical: 0 };

/**
 * A részletes lejátszási diagnosztika (doboz-geometria, kodek-próba,
 * localStorage-bejárás, másodpercenkénti idővonal) csak akkor fut, ha a
 * naplózás aktív.
 *
 * KÉZI NAPLÓZÁSNÁL: végig, változatlanul (ez a korábbi viselkedés).
 *
 * A TESZTIDŐSZAK AUTOMATIKUS NAPLÓJÁNÁL csak az INDULÁSI ABLAKBAN (az első
 * 60 másodpercben), mert ezek a mérések csatornaváltásonként több tíz ms-nyi
 * munkát végeznek, és a nézés közbeni folyamatos naplózás lassítaná az élő
 * adást. Így a legelső csatornabetöltés és az indulás teljes részletességgel
 * a naplóban van, a későbbi tévézés viszont ugyanolyan gyors marad, mint a
 * naplózás nélkül.
 */
const AUTO_VERBOSE_WINDOW_MS = 60000;
export function isVerbosePlaybackLogging(): boolean {
  if (!loggingEnabled) return false;
  if (!autoStartedSession) return true;
  return Date.now() - autoSessionStartedAt <= AUTO_VERBOSE_WINDOW_MS;
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

/**
 * A tárba írandó napló szövege: legfeljebb `PERSIST_MAX_CHARS` karakter, a
 * napló VÉGÉRŐL. Sorhatáron vágunk, hogy egy sor se sérüljön meg.
 */
function persistPayload(): string {
  const text = lines.join('\n');
  if (text.length <= PERSIST_MAX_CHARS) return text;
  const cut = text.length - PERSIST_MAX_CHARS;
  const boundary = text.indexOf('\n', cut);
  return text.slice(boundary >= 0 ? boundary + 1 : cut);
}

function persistSoon(): void {
  if (saveTimer !== null) return;
  try {
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      try {
        localStorage.setItem(`iptv_rt_${STORE_KEY}`, persistPayload());
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
    localStorage.setItem(`iptv_rt_${STORE_KEY}`, persistPayload());
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
    // Leállított naplónál a stopperóra a leállítás pillanatában áll meg.
    elapsedMs: activeLogStartedAt
      ? Math.max(0, (activeLogStoppedAt || now) - activeLogStartedAt)
      : 0,
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
  activeLogStoppedAt = 0;
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
  // Az indulási diagnosztika (BOOT-DIAG) itt kapcsolódik be, hogy a legelső
  // rögzített soroktól kezdve teljes legyen a kép.
  runLifecycleHooks('start');
  return manualLogSnapshot();
}

/** Kézi naplózás leállítása; az elküldéshez a kész napló memóriában marad. */
export function stopManualLogging(reason = 'kézi leállítás'): ManualLogSnapshot {
  // Az indulási diagnosztika összegzése még a naplózás leállása ELŐTT íródik ki,
  // különben a záró sorok elvesznének. A figyelők ilyenkor mindig leállnak.
  runLifecycleHooks('stop');
  if (loggingEnabled) {
    appLog(`=== NAPLÓZÁS LEÁLLÍTVA; napló=#${activeLogNumber ?? 'ismeretlen'}; ok=${reason} ===`);
  }
  /*
   * A tesztidőszak automatikus naplója:
   *   • a TV kilépése/háttérbe kerülése NEM dobja el a naplót – előtérbe
   *     kerüléskor ugyanaz a munkamenet folytatódik;
   *   • a küldés vagy a kézi leállítás végleges: nem indul újra magától.
   */
  if (autoStartedSession) {
    if (/elhagyása|pagehide|beforeunload|háttér/i.test(reason)) autoResumePending = true;
    else autoSuppressed = true;
  }
  loggingEnabled = false;
  // A stopperóra MEGÁLL: a leállított naplónál az eltelt idő nem nő tovább.
  if (!activeLogStoppedAt) activeLogStoppedAt = Date.now();
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

/* ══════════════════════════════════════════════════════════════════════════
 * AUTOMATIKUS NAPLÓZÁS – CSAK A TESZTELÉSI IDŐSZAKBAN
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * A tesztidőszak automatikus naplózásának indítása (az IPK indulásakor fut).
 *
 * A `TEST_STARTUP_DIAGNOSTICS` kapcsoló kikapcsolása után ez a függvény nem
 * csinál semmit: a naplózás a régi módon, csak a SÁRGA ablak gombjára indul.
 * Sikeres kézi elküldés után sem indul újra magától (`autoSuppressed`).
 */
export function startAutomaticTestLogging(): ManualLogSnapshot {
  if (!TEST_STARTUP_DIAGNOSTICS) return manualLogSnapshot();
  if (loggingEnabled || autoSuppressed) return manualLogSnapshot();
  autoStartedSession = true;
  autoResumePending = false;
  autoSessionStartedAt = Date.now();
  const snapshot = startManualLogging();
  if (snapshot.enabled) {
    appLog('TESZT IDŐSZAK: a naplózás az IPK indításakor AUTOMATIKUSAN elindult; a napló a kézi elküldésig gyűlik.');
  }
  return snapshot;
}

/**
 * A TV-ből való kilépés/háttérbe kerülés utáni FOLYTATÁS.
 *
 * A napló csak akkor folytatódik, ha a tesztidőszak automatikus naplója volt az
 * aktív munkamenet, nem küldték el, és a felhasználó sem állította le kézzel.
 * A korábban rögzített sorok MEGMARADNAK (nincs törlés), csak a rögzítés
 * kapcsol be újra – így a napló az indulástól a küldésig egyetlen folyam.
 */
export function resumeAutomaticTestLogging(): ManualLogSnapshot {
  if (!TEST_STARTUP_DIAGNOSTICS || loggingEnabled) return manualLogSnapshot();
  if (!autoStartedSession || autoSuppressed || !autoResumePending) return manualLogSnapshot();
  autoResumePending = false;
  if (activeLogNumber === null || activeLogStartedAt <= 0) return startManualLogging();
  loggingEnabled = true;
  activeLogStoppedAt = 0;
  startRuntimeWatchdog();
  appLog(`=== NAPLÓZÁS FOLYTATVA; napló=#${activeLogNumber}; az app visszatért az előtérbe ===`);
  runLifecycleHooks('start');
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

/**
 * A SIKERESEN ELKÜLDÖTT NAPLÓ ELDOBÁSA.
 *
 * A napló tartalma a küldés után is a memóriában (akár 1 MB) ÉS a
 * localStorage-ban (120 000 karakter) maradt, holott a Supabase-en már megvan.
 * Ez feleslegesen foglalta a TV memóriáját és a szűk tárhelyét.
 *
 * Ezért sikeres küldés után a napló sorai a RAM-ból és a localStorage-ból is
 * törlődnek, a munkamenet (naplószám, kezdő időpont, stopperóra) lezárul, és a
 * következő naplózás tiszta adatokkal indul – ugyanazokkal az eseményekkel.
 *
 * SIKERTELEN küldésnél ez a függvény NEM fut le: olyankor a napló a memóriában
 * marad, hogy a „Küldés” gombbal újra elküldhető legyen.
 *
 * A naplózási funkciók és a naplózott események köre változatlan: csak a már
 * elküldött tartalom tűnik el.
 */
export function discardSentAppLog(): ManualLogSnapshot {
  clearAppLog();
  activeLogNumber = null;
  activeLogStartedAt = 0;
  activeLogStoppedAt = 0;
  /*
   * A napló elküldve: a tesztidőszak automatikus naplózása EBBEN a
   * munkamenetben nem indul újra magától (sem háttérbe kerüléskor, sem
   * előtérbe való visszatéréskor). A következő IPK-indítás új munkamenetet
   * kezd, ugyanúgy, mint eddig.
   */
  autoSuppressed = true;
  autoStartedSession = false;
  autoResumePending = false;
  autoSessionStartedAt = 0;
  return manualLogSnapshot();
}

/**
 * Naplószintű biztonsági öv: a későbbi hibakeresési sorok se tehessenek ki
 * véletlenül Xtream-belépési adatot. A stream- és felirat-útvonalakban a
 * felhasználónév/jelszó a `live|movie|series|subtitle` után áll; a query
 * kulcsait is maszkoljuk. A host és a formátum megmarad a diagnózishoz.
 */
function redactLogUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
    const trailing = raw.match(/[),.;!?]+$/)?.[0] || '';
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    try {
      const parsed = new URL(candidate);
      if (parsed.username) parsed.username = '[redacted]';
      if (parsed.password) parsed.password = '[redacted]';
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (/^(username|user|password|pass|token|api_key|apikey|key|auth|secret|access_token|signature)$/i.test(key)) {
          parsed.searchParams.set(key, '[redacted]');
        }
      }
      const parts = parsed.pathname.split('/');
      for (let index = 0; index < parts.length; index += 1) {
        if (/^(live|movie|series|subtitle)$/i.test(parts[index]) && parts[index + 1] && parts[index + 2]) {
          parts[index + 1] = '[redacted]';
          parts[index + 2] = '[redacted]';
        }
      }
      parsed.pathname = parts.join('/');
      return parsed.toString() + trailing;
    } catch {
      return candidate
        .replace(/([?&](?:username|user|password|pass|token|api_key|apikey|key|auth|secret|access_token|signature)=)[^&]*/gi, '$1[redacted]')
        .replace(/\/(live|movie|series|subtitle)\/[^/]+\/[^/]+/gi, '/$1/[redacted]/[redacted]') + trailing;
    }
  });
}

/** Egy sor hozzáadása a kézzel indított diagnosztikai naplóhoz. */
export function appLog(message: string): void {
  // A normál tévézés közben nincs diagnosztikai naplózás, nincs localStorage-
  // írás és nincs extra szövegfeldolgozás. Ez a csatornaváltást is gyorsítja.
  if (!loggingEnabled) return;
  const safe = redactLogUrls(String(message ?? '')).replace(/\s+/g, ' ');
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

/* ══════════════════════════════════════════════════════════════════════════
 * SZOLGÁLTATÓ-BEOLVASÁS FIGYELŐ (csatorna/film/sorozat tesztekhez)
 *
 * CÉLJA: a „a szolgáltatótól letöltöm a csatornákat, de a filmek és a
 * sorozatok hibával elakadnak / túl lassan töltődnek” típusú hibák a TV-n
 * nem láthatók – csak a végén egy üres Mozi nézet. Ezért a szolgáltatói
 * betöltés MINDEN lépése külön sorban kerül a kézi naplóba:
 *
 *   SZOLGÁLTATÓ [élő csatornalista] OK 3210 ms, HTTP 200, 7,4 MB, 20145 elem
 *   SZOLGÁLTATÓ [filmek egyben] HIBA 30000 ms után: időtúllépés (30000 ms)
 *   SZOLGÁLTATÓ [filmek egyben] 1/2. újrapróbálkozás 900 ms múlva
 *   SZOLGÁLTATÓ FÁZIS [filmek] kész: 18342 film, 41,2 s
 *
 * Ezek a sorok a többi naplósorral együtt mennek ki a Supabase-re, így a
 * hibát a tényleges mérésekből lehet javítani, nem találgatásból.
 *
 * A sorok CSAK kézzel indított naplózás alatt készülnek (appLog kapuja),
 * így normál tévézésnél semmi plusz munkát nem végeznek.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Egy szolgáltatói kérés rövid, emberi címke szerinti neve.
 * A hálózati réteg csak az URL-t ismeri, ezért az `action=` paraméterből
 * képezzük a nevet – így a naplóból egyértelmű, melyik végpont akadt el.
 */
const PROVIDER_ACTION_LABELS: Record<string, string> = {
  get_live_streams: 'élő csatornalista',
  get_live_categories: 'élő kategóriák',
  get_vod_streams: 'filmek',
  get_vod_categories: 'film kategóriák',
  get_series: 'sorozatok',
  get_series_categories: 'sorozat kategóriák',
  get_vod_info: 'film részletek',
  get_series_info: 'sorozat részletek',
  get_short_epg: 'rövid EPG',
};

/** A kért URL-ből kinyerjük, melyik szolgáltatói végpontról van szó. */
export function providerEndpointLabel(url: string): string {
  try {
    const action = new URL(url).searchParams.get('action');
    if (action && PROVIDER_ACTION_LABELS[action]) return PROVIDER_ACTION_LABELS[action];
    if (/\/get\.php\b/i.test(url)) return 'M3U csatornalista';
    if (/player_api\.php/i.test(url)) return 'bejelentkezés';
    return 'szolgáltatói kérés';
  } catch {
    return 'szolgáltatói kérés';
  }
}

/** Általános, egysoros szolgáltatói naplóbejegyzés. */
export function logProviderEvent(message: string): void {
  appLog(`SZOLGÁLTATÓ ${message}`);
}

/** Bájt emberi mértékegysége (a napló olvashatóbb, mint a nyers szám). */
export function formatBytes(value: number | null | undefined): string {
  const bytes = Number(value) || 0;
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ProviderRequestLog {
  /** A végpont neve (lásd providerEndpointLabel). */
  endpoint: string;
  /** Sikeres volt-e a kérés. */
  ok: boolean;
  /** A kérés teljes időtartama ezredmásodpercben. */
  ms: number;
  /** Az érvényben lévő időtúllépés (ms) – ebből látszik, kifutott-e az időből. */
  timeoutMs?: number;
  httpStatus?: number | null;
  bytes?: number | null;
  /** A válasz elemeinek száma (csatorna/film/sorozat), ha ismert. */
  items?: number | null;
  /** A hiba rövid, belépési adatot nem tartalmazó oka. */
  error?: string;
  /** Hányadik próbálkozás volt (1 = első). */
  attempt?: number;
}

/** Egy szolgáltatói kérés eredménye egyetlen, összehasonlítható sorban. */
export function logProviderRequest(entry: ProviderRequestLog): void {
  const parts: string[] = [`[${entry.endpoint}]`, entry.ok ? 'OK' : 'HIBA'];
  parts.push(`${Math.round(entry.ms)} ms`);
  if (entry.timeoutMs) parts.push(`korlát=${Math.round(entry.timeoutMs)} ms`);
  if (entry.httpStatus !== undefined && entry.httpStatus !== null) parts.push(`HTTP ${entry.httpStatus}`);
  if (entry.bytes !== undefined && entry.bytes !== null) parts.push(formatBytes(entry.bytes));
  if (entry.items !== undefined && entry.items !== null) parts.push(`${entry.items} elem`);
  if (entry.attempt && entry.attempt > 1) parts.push(`${entry.attempt}. próbálkozás`);
  if (!entry.ok && entry.error) parts.push(`ok=${entry.error}`);
  logProviderEvent(parts.join(', '));
}

/** Egy betöltési szakasz (élő / filmek / sorozatok) kezdete. */
export function logProviderPhaseStart(phase: string, detail = ''): void {
  logProviderEvent(`FÁZIS [${phase}] indul${detail ? ` – ${detail}` : ''}`);
}

/** Egy betöltési szakasz vége: darabszám és eltelt idő. */
export function logProviderPhaseEnd(phase: string, detail: string, ms: number): void {
  logProviderEvent(`FÁZIS [${phase}] kész – ${detail}; ${(ms / 1000).toFixed(1)} s`);
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
      // A teljes streamcím itt sem kerülhet a naplóba: az Xtream URL útvonala
      // felhasználónevet és jelszót tartalmaz. A formátum/host elég a
      // fagyásdiagnózishoz, a belépési útvonalat nem őrizzük meg.
      const source = String(video.currentSrc || video.src || '');
      const sourceFormat = /\.m3u8(?:[?#]|$)/i.test(source)
        ? 'HLS'
        : /\.ts(?:[?#]|$)/i.test(source)
          ? 'MPEG-TS'
          : source
            ? 'egyéb'
            : '';
      parts.push(
        `videó=${video.paused ? 'áll' : 'megy'}` +
        `, pozíció=${Math.round(Number(video.currentTime) || 0)} s` +
        `, kész=${video.readyState}` +
        (sourceFormat ? `, forrás-formátum=${sourceFormat}` : '')
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
        // Tesztidőszak: ha a naplót nem küldték el, a rögzítés ugyanabban a
        // munkamenetben folytatódik (a kilépésnél lezárt napló nem vész el).
        resumeAutomaticTestLogging();
      }
    });
  } catch { /* nem elérhető */ }
}
