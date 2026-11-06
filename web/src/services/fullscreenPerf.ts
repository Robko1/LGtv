import { appLog, isVerbosePlaybackLogging } from './appLog';

/*
 * ============================================================================
 * TELJES KÉPERNYŐ ⇄ FŐOLDAL – CÉLZOTT TELJESÍTMÉNYNAPLÓ
 * ============================================================================
 *
 * MIRE KELL: a váltás akadásának megkereséséhez pontosan látni kell, mikor
 * történik meg az egyes lépés, és mennyi idő telik el közöttük. A napló ezért
 * csak a szükséges eseményeket rögzíti:
 *
 *   BE: kérés feldolgozva   – a React commit megtörtént, a CSS-osztály fent van
 *   BE: második rAF          – becsült festés utáni renderelési lehetőség
 *   BE: fókusz rendben      – a fókusz a lejátszón maradt
 *   KI: geometria vissza    – a főoldali keret helyreállt (osztály le)
 *   KI: OSD/EPG újraindult  – a háttérmunka a lejátszó helyreállása UTÁN indult
 *   KI: második rAF          – becsült festés utáni renderelési lehetőség
 *
 * ZAJCSÖKKENTÉS (memória):
 *   • kikapcsolt naplózásnál NULLA munka (nincs sztring-összefűzés, nincs időmérés),
 *   • az azonos esemény 400 ms-on belüli ismétlődése nem íródik ki, csak
 *     számlálódik, és a következő valódi sorban „elnyomva: N” alakban jelenik meg,
 *   • a teljes képernyős témára kemény 80 soros keret van; efölött 30
 *     másodpercre elnémul a modul, és egyetlen záró sor jelzi, hogy a többi
 *     elmaradt – így a napló hosszú tesztelés közben sem hízik.
 */

/** Ugyanaz az esemény ezen az időablakon belül nem íródik ki újra. */
const THROTTLE_MS = 400;
/** A teljes képernyős napló memóriakerete (sor). */
const MAX_LINES = 80;
/** A keret betelte után ennyi ideig hallgat a modul (önmagától újraindul). */
const MUTE_MS = 30000;

let lastKey = '';
let lastAt = 0;
let suppressed = 0;
let lineCount = 0;
let mutedUntil = 0;

/** Egy új kézi naplózás (vagy új mérés) tiszta teljes képernyős naplóval indul. */
export function resetFullscreenPerf(): void {
  lastKey = '';
  lastAt = 0;
  suppressed = 0;
  lineCount = 0;
  mutedUntil = 0;
}

/** Nagy felbontású, monoton idő – a `performance.now()` hiányában `Date.now()`. */
export function fsNow(): number {
  try {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  } catch {
    return Date.now();
  }
}

/**
 * Egy teljes képernyős esemény naplózása.
 *
 * @param event  rövid eseménynév (pl. „BE: első képkocka”)
 * @param detail opcionális részlet (pl. „12.4 ms”)
 */
export function fsPerf(event: string, detail = ''): void {
  // Kikapcsolt naplózásnál semmit nem számolunk – a TV-n ez a normál állapot.
  if (!isVerbosePlaybackLogging()) return;
  const now = fsNow();
  // A keret betelte után a modul 30 másodpercre elhallgat, majd magától
  // újraindul – így egy új naplózás soha nem marad napló nélkül.
  if (now < mutedUntil) return;
  const key = `${event}|${detail}`;
  if (key === lastKey && now - lastAt < THROTTLE_MS) {
    suppressed += 1;
    return;
  }
  if (lineCount >= MAX_LINES) {
    lineCount = 0;
    mutedUntil = now + MUTE_MS;
    appLog(`TELJES KÉPERNYŐ: a naplókeret (${MAX_LINES} sor) betelt; a további váltás-naplók ${Math.round(MUTE_MS / 1000)} mp-re elmaradnak.`);
    return;
  }
  const merged = suppressed > 0 ? ` (elnyomva: ${suppressed})` : '';
  lastKey = key;
  lastAt = now;
  suppressed = 0;
  lineCount += 1;
  appLog(`TELJES KÉPERNYŐ ${event}${detail ? `: ${detail}` : ''}${merged}`);
}

/** Esemény naplózása egy korábban vett `fsNow()` méréshez képest eltelt idővel. */
export function fsPerfTimed(event: string, startedAt: number, detail = ''): void {
  if (!isVerbosePlaybackLogging()) return;
  const elapsed = Math.max(0, fsNow() - startedAt);
  fsPerf(event, `${detail ? `${detail}; ` : ''}${elapsed.toFixed(1)} ms`);
}

/* ══════════════════════════════════════════════════════════════════════════
   TELJES MÉRÉS AZ OK-GOMBTÓL (2.5.166)

   A felhasználó kérése: a főoldal ⇄ teljes képernyő váltást AZ OK gomb
   megnyomásától kell mérni, mindkét irányban, és naplózni kell, milyen
   műveletek történnek közben, hol keletkezik késleltetés.

   A #32–#37 naplókban csak ennyi állt: „BE: első képkocka 5,8 ms” és
   „fókusz ellenőrizve 567,5 ms” – ezek RÉSZMÉRÉSEK voltak egy már elindult
   állapotváltásról, a felhasználó által érzékelt időről semmit nem mondtak.

   Ezért itt egy MÉRÉSI MENET (tranzakció) fut:

     fsStart('BE', 'csatornalista OK')   ← az OK lenyomásának pillanata
     fsStep('esemény a lejátszónál')     ← minden köztes lépés, lépésközzel
     fsFinish('első képkocka')           ← a váltás VÉGE, teljes idővel

   Minden sor tartalmazza az OK óta eltelt teljes időt ÉS az előző lépés óta
   eltelt időt, továbbá a menet végén a leghosszabb lépésközt – ebből derül
   ki, melyik művelet lassítja a váltást.
   ══════════════════════════════════════════════════════════════════════════ */

type FsDirection = 'BE' | 'KI';

interface FsTrace {
  direction: FsDirection;
  origin: string;
  startedAt: number;
  lastAt: number;
  steps: number;
  slowestLabel: string;
  slowestGap: number;
}

let trace: FsTrace | null = null;

/** A mérés indítása – az OK (vagy VISSZA) lenyomásának pillanatában. */
export function fsStart(direction: FsDirection, origin: string): void {
  if (!isVerbosePlaybackLogging()) return;
  if (trace) fsAbort('új képernyőváltás kezdődött');
  const now = fsNow();
  trace = {
    direction,
    origin,
    startedAt: now,
    lastAt: now,
    steps: 0,
    slowestLabel: 'indítás',
    slowestGap: 0,
  };
  fsPerf(`${direction}: ▶ OK lenyomva`, `${origin}; innen mérünk`);
}

/**
 * Egy köztes lépés naplózása a meneten belül (az OK óta eltelt idővel).
 * Ha nincs menet (pl. a naplózás közben kapcsolták be), egyszerű esemény.
 */
export function fsStep(label: string, detail = ''): void {
  if (!isVerbosePlaybackLogging()) return;
  if (!trace) {
    fsPerf(label, detail);
    return;
  }
  const now = fsNow();
  const gap = Math.max(0, now - trace.lastAt);
  const total = Math.max(0, now - trace.startedAt);
  trace.lastAt = now;
  trace.steps += 1;
  if (gap > trace.slowestGap) {
    trace.slowestGap = gap;
    trace.slowestLabel = label;
  }
  fsPerf(
    `${trace.direction}: ${label}`,
    `${detail ? `${detail}; ` : ''}+${total.toFixed(1)} ms az OK óta (lépésköz ${gap.toFixed(1)} ms)`,
  );
}

/** A menet lezárása: teljes idő, lépésszám és a leghosszabb lépésköz. */
export function fsFinish(outcome: string): void {
  if (!isVerbosePlaybackLogging() || !trace) return;
  const now = fsNow();
  const total = Math.max(0, now - trace.startedAt);
  const gaps = Math.max(0, now - trace.lastAt);
  if (gaps > trace.slowestGap) {
    trace.slowestGap = gaps;
    trace.slowestLabel = 'utolsó lépés óta';
  }
  const { direction, origin, steps, slowestLabel, slowestGap } = trace;
  trace = null;
  fsPerf(
    `${direction}: ✅ KÉSZ – teljes idő`,
    `${outcome}; ${total.toFixed(1)} ms az OK óta, ${steps + 1} lépés, `
    + `leghosszabb késleltetés: ${slowestLabel} ${slowestGap.toFixed(1)} ms (${origin})`,
  );
}

/** Félbehagyott menet eldobása (pl. a felhasználó más nézetre lépett). */
export function fsAbort(reason: string): void {
  if (!trace) return;
  const { direction } = trace;
  trace = null;
  fsPerf(`${direction}: ⏹ megszakítva`, reason);
}
