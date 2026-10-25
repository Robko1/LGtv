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

type ProgressVideo = Pick<HTMLVideoElement, 'currentTime' | 'readyState' | 'buffered'> & {
  getVideoPlaybackQuality?: () => { totalVideoFrames?: number };
  webkitDecodedFrameCount?: number;
};

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
export function mediaProgressed(previous: MediaProgressSample, current: MediaProgressSample): boolean {
  // Visszaugrás / keresés: új szakasz, nem megakadás.
  if (current.time < previous.time - 0.75) return true;
  const timeAdvanced = current.time > previous.time + 0.15;
  if (previous.frames !== null && current.frames !== null) {
    return current.frames > previous.frames || timeAdvanced;
  }
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
