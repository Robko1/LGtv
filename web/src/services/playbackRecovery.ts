/**
 * LEJÁTSZÁS-FELÜGYELET – tiszta, DOM-függőség nélküli döntési logika.
 *
 * A VideoPlayer ezt használja, hogy az élő TV és a film/sorozat lejátszása
 * magától talpra álljon egy rövid megakadás után. A döntések (mennyi idő
 * után számít megakadásnak, mennyit várjunk, melyik címet próbáljuk újra)
 * külön modulban vannak, mert így valódi futásidejű teszttel ellenőrizhetők
 * (lásd tools/test-playback-recovery.mjs).
 *
 * FONTOS: webOS-en a `currentTime` élő MPEG-TS adásnál nem mindig halad,
 * miközben a dekódolt képkockák igen. Ezért a megakadást több jelből
 * (idővonal + képkockaszámláló + puffer vége) együtt döntjük el, és NEM
 * indítunk felesleges újracsatlakozást, ha a kép valójában megy.
 */

export interface MediaProgressSample {
  /** Mintavétel időpontja (Date.now()). */
  at: number;
  /** HTMLMediaElement.currentTime – élő adásnál gyakran 0 marad. */
  time: number;
  /** Dekódolt képkockák száma, ha a motor közzéteszi. */
  frames: number | null;
  /** A pufferelt tartomány vége másodpercben, ha elérhető. */
  bufferedEnd: number | null;
  readyState: number;
}

export type BufferMode = 'fast' | 'balanced' | 'stable';

/**
 * Élő HTML5 lejátszóhoz tartozó profilpolitika.
 *
 * A webOS HTMLVideoElement nem ad szabványos „target buffer” beállítást.
 * Ezért a profilok a csatornaváltás indulási őrét, a lejátszás közbeni
 * puffer-őr türelmét és a recovery visszalépését hangolják. A külön
 * `bufferWatchdogMs` szándékosan nagyobb a `startupWatchdogMs` értékénél:
 * egy már futó adás rövid HLS/TS szegmens-szünete nem indíthat felesleges
 * forráscserét, miközben a csatornaváltás továbbra is gyors marad.
 */
export interface BufferProfileTiming {
  /** Sikertelen első indítás után ennyi idő múlva jöhet a formátum-fallback. */
  startupWatchdogMs: number;
  /** `waiting`/`stalled` után ennyi ideig várunk, mielőtt újratöltünk. */
  bufferWatchdogMs: number;
  /** A képkocka/idővonal alapú őr profilfüggő küszöbe. */
  stallDetectorMs: number;
  /** Recovery és VOD-újrapróba kezdeti visszalépése. */
  retryMs: number;
  /** Ekkora lejátszás előtti tartalékot még nem tekintünk üres puffernek. */
  minBufferAheadSeconds: number;
}

export function bufferProfileTiming(mode: BufferMode = 'balanced'): BufferProfileTiming {
  if (mode === 'fast') {
    return {
      startupWatchdogMs: 1200,
      bufferWatchdogMs: 3500,
      stallDetectorMs: 3500,
      retryMs: 250,
      minBufferAheadSeconds: 1.5,
    };
  }
  if (mode === 'stable') {
    // A stabil profil indulási és recovery-értékei kompatibilisek a már
    // bevált 2.5.93 viselkedéssel; csak a mérést tesszük pontosabbá.
    return {
      startupWatchdogMs: 2999,
      bufferWatchdogMs: 2999,
      stallDetectorMs: 4000,
      retryMs: 80,
      minBufferAheadSeconds: 5,
    };
  }
  return {
    startupWatchdogMs: 2000,
    bufferWatchdogMs: 4500,
    stallDetectorMs: 5000,
    retryMs: 400,
    minBufferAheadSeconds: 3,
  };
}

type ProgressVideo = Pick<HTMLVideoElement, 'currentTime' | 'readyState' | 'buffered'> & {
  getVideoPlaybackQuality?: () => { totalVideoFrames?: number };
  webkitDecodedFrameCount?: number;
};

/**
 * A lejátszási ponthoz tartozó tényleges előre-pufferelt idő.
 * Az abszolút `buffered.end()` nem elég: a live idővonal közben ugyanúgy
 * közeledik a puffer végéhez. Több tartomány esetén csak az aktuális
 * tartományt használjuk, lyuk esetén pedig nulla tartalékot adunk.
 */
export function bufferedAheadSeconds(video: Pick<HTMLVideoElement, 'currentTime' | 'buffered'> | null): number | null {
  try {
    const currentTime = Number(video?.currentTime);
    const ranges = video?.buffered;
    if (!Number.isFinite(currentTime) || !ranges || ranges.length <= 0) return null;
    let nearestEnd = -Infinity;
    for (let index = 0; index < ranges.length; index += 1) {
      const start = Number(ranges.start(index));
      const end = Number(ranges.end(index));
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (currentTime >= start - 0.25 && currentTime <= end + 0.25) {
        return Math.max(0, end - currentTime);
      }
      if (currentTime > end) nearestEnd = Math.max(nearestEnd, end);
      if (currentTime < start) return Math.max(0, end - currentTime);
    }
    return Number.isFinite(nearestEnd) ? 0 : null;
  } catch {
    return null;
  }
}

/** Kis terhelésű pillanatkép a médiaelem haladásáról. Soha nem dob hibát. */
export function readMediaProgress(video: ProgressVideo | null, now: number): MediaProgressSample {
  const sample: MediaProgressSample = {
    at: now,
    time: 0,
    frames: null,
    bufferedEnd: null,
    readyState: 0,
  };
  if (!video) return sample;
  try {
    const time = Number(video.currentTime);
    if (Number.isFinite(time)) sample.time = time;
    const ready = Number(video.readyState);
    if (Number.isFinite(ready)) sample.readyState = ready;
  } catch { /* régi motor */ }
  try {
    const quality = typeof video.getVideoPlaybackQuality === 'function'
      ? video.getVideoPlaybackQuality()
      : null;
    const frames = Number(quality?.totalVideoFrames ?? video.webkitDecodedFrameCount);
    if (Number.isFinite(frames) && frames >= 0) sample.frames = frames;
  } catch { /* nincs képkocka-számláló */ }
  try {
    const buffered = video.buffered;
    if (buffered && buffered.length > 0) {
      const end = Number(buffered.end(buffered.length - 1));
      if (Number.isFinite(end)) sample.bufferedEnd = end;
    }
  } catch { /* a TV nem mindig ad pufferadatot */ }
  return sample;
}

/**
 * Haladt-e a lejátszás a két minta között?
 * Ha a képkockaszámláló elérhető, az a döntő jel: a puffer növekedése
 * önmagában még nem jelenti azt, hogy a dekóder dolgozik.
 */
export function mediaProgressed(
  previous: MediaProgressSample,
  current: MediaProgressSample,
  allowBufferGrowth = false,
): boolean {
  // Visszaugrás / keresés: új szakasz, nem megakadás.
  if (current.time < previous.time - 0.75) return true;
  const timeAdvanced = current.time > previous.time + 0.15;
  if (previous.frames !== null && current.frames !== null) {
    return current.frames > previous.frames || timeAdvanced;
  }
  // Futó lejátszásnál a webOS képes úgy növelni a puffer végét, hogy a
  // dekóder/idővonal közben megáll (a #13 M2 UHD naplójában pontosan ez
  // látszott). A puffer növekedése ezért alapértelmezés szerint SOHA nem
  // tarthatja életben a stall-figyelőt.
  if (previous.time > 0 || current.time > 0 || !allowBufferGrowth) return timeAdvanced;
  // Csak egy külön, indulási mintavételnél engedjük meg, hogy a puffer
  // feltöltése haladási jel legyen. A VideoPlayer futó watchdogjai az
  // alapértelmezett false értékkel hívják a függvényt.
  const bufferAdvanced = previous.bufferedEnd !== null && current.bufferedEnd !== null
    && current.bufferedEnd > previous.bufferedEnd + 0.05;
  return timeAdvanced || bufferAdvanced;
}

/** Akkor jelez, ha a lejátszás `stallAfterMs` ideje alatt egyetlen jelet sem haladt. */
export class StallDetector {
  private previous: MediaProgressSample | null = null;
  private lastProgressAt = 0;

  constructor(private readonly stallAfterMs: number) {}

  reset(): void {
    this.previous = null;
    this.lastProgressAt = 0;
  }

  observe(sample: MediaProgressSample, now: number = sample.at): boolean {
    if (!this.previous) {
      this.previous = sample;
      this.lastProgressAt = now;
      return false;
    }
    // Ha a TV háttérbe tette az appot, a kimaradt idő nem számít megakadásnak.
    if (now - this.previous.at > 5000) {
      this.previous = sample;
      this.lastProgressAt = now;
      return false;
    }
    const previous = this.previous;
    this.previous = sample;
    if (mediaProgressed(previous, sample)) {
      this.lastProgressAt = now;
      return false;
    }
    return now - this.lastProgressAt >= this.stallAfterMs;
  }
}

/**
 * Élő recovery: az első két újracsatlakozás ugyanazt a címet használja;
 * csak ezután próbáljuk a másik formátumot, ritkuló időzítéssel.
 * A kezdeti csatornaváltás külön, legfeljebb egyszeri TS/HLS fallbacket használ.
 */
export function liveRecoveryUrl(attempt: number, primaryUrl: string, alternativeUrl?: string | null): string {
  const other = alternativeUrl && alternativeUrl !== primaryUrl ? alternativeUrl : primaryUrl;
  if (attempt < 2) return primaryUrl;
  return attempt % 2 === 0 ? other : primaryUrl;
}

/** Rövid, fokozatos visszalépés – a TV-t nem terheljük végtelen gyors próbákkal. */
export function liveRecoveryDelayMs(attempt: number, baseMs = 50, maxMs = 6000): number {
  const step = Math.max(0, Math.min(attempt, 7));
  return Math.min(maxMs, Math.max(30, Math.round(baseMs * (2 ** step))));
}

/** Film/sorozat: kicsit türelmesebbek vagyunk, mert a VOD-nak van puffere. */
export function vodRecoveryDelayMs(attempt: number, baseMs = 200, maxMs = 8000): number {
  const step = Math.max(0, Math.min(attempt, 6));
  return Math.min(maxMs, Math.max(150, Math.round(baseMs * (2 ** step))));
}

/**
 * A HTML5 `ended` esemény akkor is jöhet, ha a szolgáltató egyszerűen
 * elvágta a kapcsolatot. Ilyenkor NEM ugrunk a következő részre, hanem
 * visszaállunk a legutóbbi pozícióra.
 */
export function isPrematureVodEnd(positionSeconds: number, durationSeconds: number): boolean {
  const position = Number(positionSeconds);
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return false;
  if (!Number.isFinite(position) || position < 0) return false;
  return position < duration - 3;
}

/**
 * Élő adásnál az `ended` nem valódi műsorvége: egy raw TS kapcsolat vagy a
 * webOS demuxer is véges idővonalat hagyhat maga után. Csak akkor indítunk
 * recoveryt, ha a néző továbbra is lejátszást kér és már volt sikeres indulás;
 * a felhasználói pause, illetve a még el sem indult próba nem számít hibának.
 */
export interface LiveEndState {
  ended: boolean;
  paused: boolean;
  desiredPlaying: boolean;
  playbackStarted: boolean;
  currentTime: number;
  duration: number;
}

export function isUnexpectedLiveEnd(state: LiveEndState): boolean {
  if (!state.desiredPlaying || !state.playbackStarted) return false;
  if (state.ended) return true;
  const duration = Number(state.duration);
  const currentTime = Number(state.currentTime);
  return state.paused
    && Number.isFinite(duration)
    && duration > 2
    && Number.isFinite(currentTime)
    && currentTime >= duration - 0.75;
}
