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
 *   BE: első képkocka       – az első kifestett képkocka (a váltás valódi vége)
 *   BE: fókusz rendben      – a fókusz a lejátszón maradt
 *   KI: geometria vissza    – a főoldali keret helyreállt (osztály le)
 *   KI: OSD/EPG újraindult  – a háttérmunka a lejátszó helyreállása UTÁN indult
 *   KI: első képkocka       – a főoldal első kifestett képkockája
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

