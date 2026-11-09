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
 * utána ritkábban próbáljuk a másik formátumot (egy fallback után két
 * elsődleges próba következik), ritkuló időzítéssel. Ez fontos az olyan
 * csatornánál, amelynél a webOS mindkét formátumra átmeneti „Format error”-t
 * ad, majd később mégis az eredeti TS-sel indul: ne terheljük a TV-t és a
 * naplót felesleges HLS/TS váltogatással.
 * A kezdeti csatornaváltás külön, legfeljebb egyszeri TS/HLS fallbacket használ.
 */
export function liveRecoveryUrl(attempt: number, primaryUrl: string, alternativeUrl?: string | null): string {
  const other = alternativeUrl && alternativeUrl !== primaryUrl ? alternativeUrl : primaryUrl;
  if (attempt < 2) return primaryUrl;
  return attempt % 3 === 2 ? other : primaryUrl;
}

/** Rövid, fokozatos visszalépés – a TV-t nem terheljük végtelen gyors próbákkal. */
export function liveRecoveryDelayMs(attempt: number, baseMs = 50, maxMs = 6000): number {
  const step = Math.max(0, Math.min(attempt, 7));
  return Math.min(maxMs, Math.max(30, Math.round(baseMs * (2 ** step))));
}

/**
 * Film/sorozat: kicsit türelmesebbek vagyunk, mert a VOD-nak van puffere.
 *
 * 2.5.388 (#31 napló): A SZOLGÁLTATÓ EGYETLEN KAPCSOLATOT ENGEDÉLYEZ.
 * A 31. naplóban egy film megnyitása 3 másodperc alatt NÉGY újracsatlakozást
 * indított (180 / 360 / 720 / 1440 ms), miközben az előbb bezárt élő adás
 * kapcsolata még a szolgáltatónál volt – a szerver mindet elutasította
 * (`videó elem hiba`, readyState=0). Ezért:
 *   - ha a film MÁR játszott (pufferelés), az első újrapróbák óvatosan,
 *     de gyorsan jönnek (0,8 mp-től),
 *   - ha a film SOHA nem indult el (azonnali médiahiba), a próbák lassabban,
 *     legalább 2 / 4 / 6 másodperccel indulnak, hogy a szolgáltató bezárhassa
 *     az előző kapcsolatot.
 */
export function vodRecoveryDelayMs(attempt: number, baseMs = 200, maxMs = 8000, started = true): number {
  const step = Math.max(0, Math.min(attempt, 6));
  const grown = Math.round(baseMs * (2 ** step));
  const floor = started
    ? 800
    : (attempt <= 0 ? 2000 : attempt === 1 ? 4000 : 6000);
  return Math.min(maxMs, Math.max(150, grown, floor));
}

/** Ennyi automatikus újrapróbát engedünk egy SOHA el nem indult filmnek. */
export const VOD_MAX_NEVER_STARTED_ATTEMPTS = 4;

/**
 * 2.5.388 (#31 napló): ha a film egyáltalán nem indult el, a 4. próba után
 * NEM próbálkozunk tovább automatikusan. A 31. naplóban a Mandalorian 8
 * lépésben, 40 másodpercig nyitogatott új kapcsolatot, mindegyik `kész=0`
 * (readyState=0) médiahibával végződött; a szolgáltató egykapcsolatos
 * fiókjánál ez csak újabb elutasításokat szül. Helyette tiszta „nem
 * elérhető” állapot és kézi Újrapróbálás gomb jelenik meg.
 *
 * Ha a film MÁR játszott, a korlát NEM lép életbe: a meglévő folyamatos
 * visszaállítás (megszakadt adatfolyam után) változatlanul működik.
 */
export function isVodRecoveryExhausted(attemptsMade: number, everStarted: boolean): boolean {
  if (everStarted) return false;
  return attemptsMade >= VOD_MAX_NEVER_STARTED_ATTEMPTS;
}

/** Egy VOD HTTP-ellenőrzés eredménye (diagnosztika, nem lejátszás). */
export interface VodHttpCheck {
  status: number | null;
  contentType: string;
  contentLength: number | null;
  rangeSupported: boolean;
  elapsedMs: number;
  error: string;
  verdict: string;
}

/**
 * 2.5.388 (#31 napló): a film médiahibája után EGYETLEN apró, fejlécig tartó
 * HTTP-kérés megmondja, hol a hiba: a szolgáltató utasítja el a kapcsolatot
 * (403/429 – pl. egykapcsolatos fiók), nincs meg a fájl (404), vagy a fájl
 * rendben jön (200/206) és a TV nem tudja dekódolni. Ez a mérés csak a naplóba
 * kerül; a lejátszást nem módosítja, és címenként egyszer fut.
 *
 * A webOS alkalmazásban az XHR engedélyezett a szolgáltató felé, a `fetch`
 * CORS-olvasása viszont nem – ezért XHR-t használunk, `HEADERS_RECEIVED`-nél
 * azonnal megszakítjuk (nem húzzuk le a filmfájlt). Node-ban (tesztek) a
 * `fetch` a tartalék.
 */
function vodVerdict(status: number, error: string): string {
  if (error) return 'a kérés nem jutott el a szolgáltatóhoz (hálózat, időtúllépés vagy TV-oldali hiba)';
  if (status === 200 || status === 206) return 'a fájl elérhető – a TV nem tudta dekódolni (konténer vagy kodek)';
  if (status === 401 || status === 403) return 'a szolgáltató elutasította (jogosultság vagy egykapcsolatos fiók)';
  if (status === 429) return 'túl sok kérés/kapcsolat a szolgáltatónál';
  if (status === 404 || status === 410) return 'a fájl nem található a szolgáltatónál';
  if (status >= 500) return 'szolgáltatói (szerver) hiba';
  if (status === 0) return 'a kapcsolat létrejött, de a HTTP-állapot nem olvasható (helyi webOS alkalmazás)';
  return `váratlan HTTP-állapot (${status})`;
}

export async function checkVodHttpStatus(url: string, timeoutMs = 8000): Promise<VodHttpCheck> {
  const startedAt = Date.now();
  const result = (status: number | null, contentType: string, contentLength: number | null,
    rangeSupported: boolean, error: string): VodHttpCheck => ({
    status,
    contentType,
    contentLength,
    rangeSupported,
    elapsedMs: Date.now() - startedAt,
    error,
    verdict: vodVerdict(status ?? 0, error),
  });
  if (!url) return result(null, '', null, false, 'nincs URL');

  if (typeof XMLHttpRequest === 'function') {
    return new Promise((resolve) => {
      let settled = false;
      const xhr = new XMLHttpRequest();
      const finish = (value: VodHttpCheck) => {
        if (settled) return;
        settled = true;
        try { xhr.abort(); } catch { /* már lezárult */ }
        resolve(value);
      };
      try {
        xhr.open('GET', url, true);
        try { xhr.setRequestHeader('Range', 'bytes=0-1'); } catch { /* régi motor */ }
        xhr.timeout = Math.max(1000, timeoutMs);
        xhr.onreadystatechange = () => {
          if (settled || xhr.readyState < 2) return;
          let type = '';
          let lengthHeader = '';
          let rangeHeader = '';
          try {
            type = String(xhr.getResponseHeader('content-type') || '').slice(0, 60);
            lengthHeader = String(xhr.getResponseHeader('content-length') || '');
            rangeHeader = String(xhr.getResponseHeader('content-range') || '')
              + String(xhr.getResponseHeader('accept-ranges') || '');
          } catch { /* a fejléc nem olvasható */ }
          const length = Number.parseInt(lengthHeader, 10);
          finish(result(
            Number(xhr.status) || 0,
            type,
            Number.isFinite(length) ? length : null,
            /bytes/i.test(rangeHeader),
            '',
          ));
        };
        xhr.onerror = () => finish(result(null, '', null, false, 'hálózati hiba'));
        xhr.ontimeout = () => finish(result(null, '', null, false, 'időtúllépés'));
        xhr.onabort = () => finish(result(null, '', null, false, 'megszakítva'));
        xhr.send();
      } catch (error) {
        finish(result(null, '', null, false, error instanceof Error ? `${error.name}: ${error.message}` : String(error)));
      }
    });
  }

  // Node / teszt környezet: nincs XHR, a fetch a tartalék.
  if (typeof fetch !== 'function') return result(null, '', null, false, 'nincs HTTP-kliens');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1000, timeoutMs)) : null;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-1' },
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
    });
    const lengthHeader = response.headers?.get?.('content-length') || '';
    const parsedLength = Number.parseInt(lengthHeader, 10);
    const rangeHeader = (response.headers?.get?.('content-range') || '') + (response.headers?.get?.('accept-ranges') || '');
    const status = Number(response.status) || 0;
    try { await response.body?.cancel?.(); } catch { /* a törzs nem kell */ }
    return result(status, String(response.headers?.get?.('content-type') || '').slice(0, 60),
      Number.isFinite(parsedLength) ? parsedLength : null, /bytes/i.test(rangeHeader), '');
  } catch (error) {
    return result(null, '', null, false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 2.5.388: a diagnosztikai fejléc-próbák (MKV/HLS/PMT) is a SZOLGÁLTATÓ felé
 * nyitnak kapcsolatot. Egykapcsolatos fióknál ezért csak akkor indulhatnak,
 * ha a lejátszás már bizonyítottan stabil – különben a próba maga taszítja el
 * a filmet vagy az élő adást.
 */
export interface DiagnosticProbeGateOptions {
  /** Mennyi stabil lejátszás kell a próba előtt (alapértelmezés: 15 mp). */
  minStableMs?: number;
  /** Mennyi időnek kell eltelnie az utolsó médiahiba óta. */
  minSinceErrorMs?: number;
  /** Mennyi időnek kell eltelnie az utolsó `waiting`/`stalled` óta. */
  minSinceWaitingMs?: number;
}

export function shouldAllowDiagnosticProbe(params: {
  playbackStarted: boolean;
  readyState: number;
  msSinceLastWaiting: number | null;
  msSinceMediaError: number | null;
  msSincePlaybackStart: number;
}, options: DiagnosticProbeGateOptions = {}): boolean {
  const minStableMs = options.minStableMs ?? 15000;
  const minSinceErrorMs = options.minSinceErrorMs ?? 20000;
  const minSinceWaitingMs = options.minSinceWaitingMs ?? 8000;
  if (!params.playbackStarted) return false;
  if (params.readyState < 3) return false;
  if (params.msSincePlaybackStart < minStableMs) return false;
  if (params.msSinceLastWaiting !== null && params.msSinceLastWaiting < minSinceWaitingMs) return false;
  if (params.msSinceMediaError !== null && params.msSinceMediaError < minSinceErrorMs) return false;
  return true;
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

/* --------------------------------------------------------------------------
 * 2.5.406 – #51 / #52: a webOS raw-TS „vége” NEM adatfolyam-hiba.
 *
 * A két TV Doktor naplóban ([HU] EPIC DRAMA UHD 55 s, HU - DISCOVERY
 * INVESTIGATION 30 s bizonyított lejátszás után) a médiaelem hirtelen
 * `duration = currentTime`, `paused = true`, `ended = true` állapotot adott,
 * miközben `media_error = -`, `readyState = 4`, `networkState = 1` és
 * `buffered = [0.00-Infinity]` volt. A régi `isUnexpectedLiveEnd()` ilyenkor
 * PUSZTÁN az `ended` flag miatt azonnal recoveryt kért; a `requestRecovery`
 * pedig ~100 ms múlva `EMPTIED → LOADSTART → … → PLAYING` újratöltést végzett,
 * 0 mp-ről indítva az új TS-kapcsolatot (≈10 mp visszatekerés + „Adás
 * frissítése (1. próba)…” felirat). A Doktor döntései és javítási lépései
 * a naplóban 0-k maradtak, tehát NEM a javítási létra, hanem a médiaesemény-
 * kezelők közvetlen újratöltése volt a hiba.
 *
 * A döntéshez most TÉNYLEGES bizonyíték kell: nincs médiahia, nincs
 * NETWORK_NO_SOURCE, van jövőbeli képkocka és puffer, friss idővonal-
 * haladás, valamint bizonyítottan hosszú lejátszás. Ha ezek közül bármelyik
 * hiányzik, a hiba VALÓDI és az eddigi recovery változatlanul lefut.
 * ------------------------------------------------------------------------ */
export interface LiveEndEvidence {
  /** Igazolt médiahia (`video.error`). */
  mediaError: boolean;
  /** HTMLMediaElement.networkState (3 = NETWORK_NO_SOURCE = valódi forráshiba). */
  networkState: number;
  /** HTMLMediaElement.readyState (< 3 = nincs jövőbeli képkocka). */
  readyState: number;
  /** Előre pufferelt másodperc; null = nem mérhető. */
  bufferedAheadSeconds: number | null;
  /** webOS raw-TS: a puffer vége `Infinity` (a demuxer szerint nincs vége). */
  unboundedBuffer: boolean;
  /** Utolsó igazolt idővonal-haladás óta eltelt ms; null = soha nem haladt. */
  progressAgoMs: number | null;
  /** Bizonyított lejátszás ebben a nézési szakaszban (ms). */
  healthyPlaybackMs: number;
}

export interface LiveEndEvidenceOptions {
  /** Friss haladás elfogadási ablaka (ms). */
  progressWindowMs?: number;
  /** Bizonyított lejátszás küszöbe (ms). */
  healthyThresholdMs?: number;
  /** Ekkora puffer-előre még nem számít elfogyott forrásnak (mp). */
  minBufferAheadSeconds?: number;
}

/** Ennyi időt kap a webOS, hogy az `ended` után HELYBEN folytassa az adást. */
export const LIVE_END_CONFIRM_MS = 1500;

export function isWebOsLiveEndArtifact(
  evidence: LiveEndEvidence,
  options: LiveEndEvidenceOptions = {},
): boolean {
  const progressWindowMs = options.progressWindowMs ?? 2500;
  const healthyThresholdMs = options.healthyThresholdMs ?? 15000;
  const minBufferAheadSeconds = options.minBufferAheadSeconds ?? 2;
  // 1. Igazolt médiahia / eltűnt forrás: VALÓDI hiba, azonnali recovery jogos.
  if (evidence.mediaError) return false;
  if (evidence.networkState === 3) return false;
  // 2. A dekódernek még van jövőbeli képkockája, és a puffer nem fogyott el.
  if (!Number.isFinite(evidence.readyState) || evidence.readyState < 3) return false;
  const ahead = evidence.bufferedAheadSeconds;
  const hasBuffer = evidence.unboundedBuffer
    || (ahead !== null && Number.isFinite(ahead) && ahead >= minBufferAheadSeconds);
  if (!hasBuffer) return false;
  // 3. A kép az elmúlt pillanatban TÉNYLEG haladt (nem 4 mp óta áll).
  const progressAgoMs = evidence.progressAgoMs;
  const freshProgress = progressAgoMs !== null
    && Number.isFinite(progressAgoMs)
    && progressAgoMs >= 0
    && progressAgoMs <= Math.max(250, progressWindowMs);
  if (!freshProgress) return false;
  // 4. Csak olyan csatornát védünk, amely már bizonyítottan játszott.
  if (!Number.isFinite(evidence.healthyPlaybackMs)
      || evidence.healthyPlaybackMs < healthyThresholdMs) return false;
  return true;
}

/**
 * Újracsatlakozás után a friss élő ablak VÉGE, ha a TV egyáltalán adja a
 * seekelhető tartományt. A webOS raw-TS gyakran `Infinity` véget ad: az NEM
 * seekelhető, ezért ilyenkor `null` (a forrást nem ugratjuk vissza/nullára).
 * Csak VÉGES tartományokat fogadunk el, és csak ha a lejátszási pont benne van.
 */
export function liveEdgeTarget(
  ranges: Array<{ start: number; end: number }>,
  currentTime: number,
  marginSeconds = 0.75,
): number | null {
  let best: number | null = null;
  for (const range of ranges) {
    const start = Number(range.start);
    const end = Number(range.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= 0) continue;
    if (currentTime < start - 0.25) continue;
    const target = Math.max(start, end - Math.max(0, marginSeconds));
    if (best === null || target > best) best = target;
  }
  return best;
}


/**
 * Élő csatornaindításnál ne nyissunk új kapcsolatot a lassan válaszoló
 * szolgáltató miatt túl korán. A #59 naplóban az első metaadat 3,3–3,7 mp
 * után érkezett; a 1,2–3 mp-es profilőrök ezt megelőzően újratöltötték a
 * streamet. A 4,5 mp-es minimum ezt az önmagunk által okozott késést szünteti
 * meg; legfeljebb 5 mp-ig engedjük az indulási őrt.
 */
export function effectiveStartupWatchdogMs(configuredMs: number): number {
  const configured = Number(configuredMs);
  return Math.max(4500, Math.min(Number.isFinite(configured) ? configured : 4500, 5000));
}
