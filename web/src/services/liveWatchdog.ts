/*
 * ÉLŐ TV ŐR (2.5.418) – egyetlen, türelmes, haladás-alapú figyelő.
 *
 * MIÉRT ÍGY (valódi TV-naplók alapján):
 *
 *  1. A régi (2.5.410/411) őr 4,5 mp haladás nélkül újratöltött. A naplók
 *     szerint a frissen indított raw MPEG-TS adás az indulás után 7–10 mp-cel
 *     MAGÁTÓL megáll (`waiting`, readyState=2), és 4,7–17 mp múlva MAGÁTÓL
 *     továbbmegy ugyanonnan. A 4,5 mp-es őr pont ebbe a természetes
 *     újrapufferelésbe töltött bele → „minden új csatornánál újraindítja”.
 *
 *  2. A 2.5.413–417 minden élő őrt kikapcsolt. Ha a szolgáltató lezárja a
 *     kapcsolatot, a webOS `ended` (véges idővonal, paused=true) állapotot ad
 *     HIBA NÉLKÜL – erre semmi nem reagált → „lefagy és úgy is marad”.
 *
 * SZABÁLYOK:
 *
 *  - Kizárólag a `currentTime` TÉNYLEGES haladását nézzük. A `buffered`,
 *    a képkocka-számláló és a `stalled`/`waiting` esemény ezen a TV-n
 *    megbízhatatlan (a `stalled` percenként többször jön tökéletes adásnál is).
 *  - Amíg az idővonal halad, SOHA nincs beavatkozás.
 *  - Haladás nélküli állapotban a határ jóval a mért leghosszabb természetes
 *    újrapufferelés (≈17 mp) FÖLÖTT van.
 *  - Az `ended` egyértelmű végállapot: a lejátszó magától soha nem megy
 *    tovább, ezért rövid megerősítés után újracsatlakozunk.
 *  - Váratlan `pause`: előbb helyben folytatást kérünk (`play()`), és csak
 *    tartós szünet után csatlakozunk újra.
 *  - A döntés NEM függ a TV Doktor kapcsolótól, a pufferprofiltól és a
 *    szolgáltatótól: nincs bemenete egyikre sem.
 */

export interface LiveWatchdogConfig {
  /** Mintavétel üteme (ms). */
  tickMs: number;
  /** Ennél kisebb idővonal-elmozdulás nem számít haladásnak (s). */
  progressEpsilonSeconds: number;
  /** Ennyi összes haladás után tekintjük megbízhatónak a TV idővonalát (s). */
  trustProgressSeconds: number;
  /** Haladás nélküli idő, ami után újracsatlakozunk (ms). */
  stallReconnectMs: number;
  /** `ended` megerősítési ideje az újracsatlakozás előtt (ms). */
  endedConfirmMs: number;
  /** Váratlan pause: ennyi után kérünk helyben folytatást (ms). */
  pauseResumeMs: number;
  /** Két helyi folytatási kérés közti minimális idő (ms). */
  pauseResumeRepeatMs: number;
  /** Váratlan pause: ennyi után újracsatlakozunk (ms). */
  pauseReconnectMs: number;
  /** Az adás ennyi idő alatt sem indult el (se kép, se hiba) → újrapróba (ms). */
  startupReconnectMs: number;
  /** Ennyi folyamatos, egészséges lejátszás után „stabil” az adás (ms). */
  stableMs: number;
}

/**
 * A leghosszabb, a TV-naplókban mért, MAGÁTÓL megoldódó élő újrapufferelés
 * (16 809 ms, #62–#64 naplók). A haladás nélküli határ ennél mindig nagyobb.
 */
export const LONGEST_OBSERVED_NATURAL_REBUFFER_MS = 17000;

export const LIVE_WATCHDOG_DEFAULTS: Readonly<LiveWatchdogConfig> = Object.freeze({
  tickMs: 1000,
  progressEpsilonSeconds: 0.05,
  trustProgressSeconds: 1,
  stallReconnectMs: 25000,
  endedConfirmMs: 1000,
  pauseResumeMs: 1500,
  pauseResumeRepeatMs: 3000,
  pauseReconnectMs: 10000,
  startupReconnectMs: 30000,
  stableMs: 20000,
});

export interface LiveWatchdogSample {
  /** Falióra (ms). */
  now: number;
  currentTime: number;
  paused: boolean;
  ended: boolean;
  /** A videóelemen médiahiba van (azt az `error` esemény kezeli). */
  hasError: boolean;
  seeking?: boolean;
}

export interface LiveWatchdogContext {
  /**
   * A néző lejátszást kér, az élő nézet látszik, az alkalmazás előtérben
   * van, nincs hibaképernyő és nincs már ütemezett újracsatlakozás.
   */
  active: boolean;
  /** Ezen a betöltésen érkezett-e már `playing`. */
  playbackStarted: boolean;
}

export type LiveWatchdogReason = 'ended' | 'paused' | 'stalled' | 'startup';

export interface LiveWatchdogDecision {
  action: 'none' | 'resume' | 'reconnect';
  reason?: LiveWatchdogReason;
  /** Mióta áll fenn a kiváltó állapot (ms). */
  elapsedMs?: number;
  /** Ebben a mintában érte el az adás a „stabil” állapotot (egyszer betöltésenként). */
  becameStable?: boolean;
}

const NONE: LiveWatchdogDecision = Object.freeze({ action: 'none' });

/**
 * Eszközszintű tudás: ezen a TV-n az élő adás idővonala TÉNYLEG halad-e.
 * Néhány régi webOS-en a raw TS `currentTime` értéke mindig 0 marad; ott a
 * haladás hiánya semmit sem bizonyít, ezért a haladás-őr nem dönt (az
 * `ended` / `pause` / `error` útvonal ott is működik).
 */
let deviceTimelineTrusted = false;

export function isLiveTimelineTrusted(): boolean {
  return deviceTimelineTrusted;
}

/** Csak tesztekhez: az eszközszintű tudás visszaállítása. */
export function resetLiveTimelineTrustForTests(value = false): void {
  deviceTimelineTrusted = value;
}

export class LiveWatchdog {
  readonly config: LiveWatchdogConfig;
  private loadStartedAt = 0;
  private lastTime = 0;
  private lastProgressAt = 0;
  private lastObservedAt = 0;
  private progressedSeconds = 0;
  private healthyMs = 0;
  private stableReported = false;
  private endedSince: number | null = null;
  private pausedSince: number | null = null;
  private lastResumeAt = 0;
  private wasStarted = false;

  constructor(config: Partial<LiveWatchdogConfig> = {}) {
    this.config = { ...LIVE_WATCHDOG_DEFAULTS, ...config };
    if (this.config.stallReconnectMs <= LONGEST_OBSERVED_NATURAL_REBUFFER_MS) {
      // Biztonsági alsó korlát: a természetes újrapufferelésbe soha nem töltünk bele.
      this.config.stallReconnectMs = LONGEST_OBSERVED_NATURAL_REBUFFER_MS + 3000;
    }
  }

  /** Új betöltés (csatornaváltás vagy újracsatlakozás) – minden mérés nulláról indul. */
  reset(now: number): void {
    this.loadStartedAt = now;
    this.lastTime = 0;
    this.lastProgressAt = now;
    this.lastObservedAt = now;
    this.progressedSeconds = 0;
    this.healthyMs = 0;
    this.stableReported = false;
    this.endedSince = null;
    this.pausedSince = null;
    this.lastResumeAt = 0;
    this.wasStarted = false;
  }

  /** Egészséges lejátszási idő ezen a betöltésen (ms). */
  get healthyPlaybackMs(): number {
    return this.healthyMs;
  }

  /** Mióta nem haladt az idővonal (ms). */
  stalledForMs(now: number): number {
    return Math.max(0, now - this.lastProgressAt);
  }

  /** A mérés „megtartása”: amíg nem figyelünk, nem gyűlik megakadási idő. */
  private hold(now: number, currentTime: number): void {
    this.lastProgressAt = now;
    this.lastObservedAt = now;
    this.lastTime = currentTime;
    this.endedSince = null;
    this.pausedSince = null;
    if (!this.wasStarted) this.loadStartedAt = now;
  }

  observe(sample: LiveWatchdogSample, context: LiveWatchdogContext): LiveWatchdogDecision {
    const { config } = this;
    const now = sample.now;
    const currentTime = Number.isFinite(sample.currentTime) ? Math.max(0, sample.currentTime) : 0;
    if (this.lastObservedAt === 0) this.reset(now);

    if (!context.active || sample.hasError) {
      this.hold(now, currentTime);
      return NONE;
    }

    /* ── INDULÁS: még nem érkezett `playing`. ── */
    if (!context.playbackStarted) {
      this.wasStarted = false;
      this.lastProgressAt = now;
      this.lastObservedAt = now;
      this.lastTime = currentTime;
      this.endedSince = null;
      this.pausedSince = null;
      const waited = now - this.loadStartedAt;
      if (waited >= config.startupReconnectMs) {
        this.loadStartedAt = now;
        return { action: 'reconnect', reason: 'startup', elapsedMs: waited };
      }
      return NONE;
    }
    if (!this.wasStarted) {
      // A `playing` pillanata: innen mérjük a haladást.
      this.wasStarted = true;
      this.lastProgressAt = now;
      this.lastObservedAt = now;
      this.lastTime = currentTime;
    }

    /* ── HALADÁS MÉRÉSE (kizárólag currentTime). ── */
    let becameStable = false;
    const delta = currentTime - this.lastTime;
    if (delta > config.progressEpsilonSeconds || delta < -2) {
      if (delta > 0) {
        this.progressedSeconds += Math.min(delta, 5);
        const wall = now - this.lastObservedAt;
        // Csak a folyamatos lejátszás számít egészségesnek (nem a megakadás utáni ugrás).
        if (wall > 0 && wall <= config.tickMs * 3) this.healthyMs += wall;
        if (!deviceTimelineTrusted && this.progressedSeconds >= config.trustProgressSeconds) {
          deviceTimelineTrusted = true;
        }
        if (!this.stableReported && this.healthyMs >= config.stableMs) {
          this.stableReported = true;
          becameStable = true;
        }
      }
      this.lastTime = currentTime;
      this.lastProgressAt = now;
    }
    this.lastObservedAt = now;

    /* ── ENDED: végállapot, magától soha nem megy tovább. ── */
    if (sample.ended) {
      this.pausedSince = null;
      if (this.endedSince === null) this.endedSince = now;
      const elapsed = now - this.endedSince;
      if (elapsed >= config.endedConfirmMs) {
        // Újraélesítés: ha a kérés elveszne, ugyanennyi idő múlva ismétlünk.
        this.endedSince = now;
        this.lastProgressAt = now;
        return { action: 'reconnect', reason: 'ended', elapsedMs: elapsed, becameStable };
      }
      return becameStable ? { action: 'none', becameStable } : NONE;
    }
    this.endedSince = null;

    /* ── VÁRATLAN PAUSE: előbb helyi folytatás, tartósan újracsatlakozás. ── */
    if (sample.paused) {
      if (this.pausedSince === null) this.pausedSince = now;
      const elapsed = now - this.pausedSince;
      // A szünet alatt nem gyűlik „megakadási” idő: a két útvonal nem keveredik.
      this.lastProgressAt = now;
      if (elapsed >= config.pauseReconnectMs) {
        this.pausedSince = now;
        return { action: 'reconnect', reason: 'paused', elapsedMs: elapsed, becameStable };
      }
      if (elapsed >= config.pauseResumeMs && now - this.lastResumeAt >= config.pauseResumeRepeatMs) {
        this.lastResumeAt = now;
        return { action: 'resume', reason: 'paused', elapsedMs: elapsed, becameStable };
      }
      return becameStable ? { action: 'none', becameStable } : NONE;
    }
    this.pausedSince = null;

    if (sample.seeking) {
      this.lastProgressAt = now;
      return becameStable ? { action: 'none', becameStable } : NONE;
    }

    /* ── TARTÓS, HALADÁS NÉLKÜLI ÁLLAPOT. ── */
    const stalled = now - this.lastProgressAt;
    if (deviceTimelineTrusted && stalled >= config.stallReconnectMs) {
      this.lastProgressAt = now;
      return { action: 'reconnect', reason: 'stalled', elapsedMs: stalled, becameStable };
    }
    return becameStable ? { action: 'none', becameStable } : NONE;
  }
}

/** A recovery-réteg felé küldött ok-szöveg (a naplóban is ez látszik). */
export function liveWatchdogReasonText(reason: LiveWatchdogReason, elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 100) / 10);
  switch (reason) {
    case 'ended':
      // Az „élő adás vége” előtag a recovery saját, külön számlálóját használja.
      return 'élő adás vége (a szolgáltató lezárta a kapcsolatot)';
    case 'paused':
      return `váratlan szünet ${seconds} mp óta`;
    case 'startup':
      return `az adás ${seconds} mp alatt sem indult el`;
    default:
      return `az idővonal ${seconds} mp óta nem halad`;
  }
}

/**
 * EGYKAPCSOLATOS SZOLGÁLTATÓ VÉDELME.
 *
 * A raw (nem HLS) élő stream végtelen HTTP-válasz: bármilyen második kérés
 * ugyanarra a címre VALÓDI második kapcsolat a szolgáltatónál. Az Xtream
 * típusú szerverek ilyenkor a RÉGI kapcsolatot (a videóelemét) fojtják vagy
 * zárják le – a kép megáll, majd vagy folytatódik, vagy végleg lefagy.
 * Ezért futó élő adás mellett raw streamre SOHA nem nyitunk fejléc-próbát.
 */
export function isContinuousLiveStreamUrl(url: string): boolean {
  const clean = String(url || '').split(/[?#]/)[0];
  if (!clean) return false;
  return !/\.m3u8$/i.test(clean);
}
