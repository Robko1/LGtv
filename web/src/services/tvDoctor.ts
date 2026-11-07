import { BufferMode, Channel, AppSettings } from '../types/iptv';
import {
  LiveFormat,
  formatOfUrl,
  urlWithFormat,
  rememberFormatFor,
  rememberedFormatFor,
} from './liveFormatMemory';
import {
  BufferProfileTiming,
  MediaProgressSample,
  bufferProfileTiming,
  bufferedAheadSeconds,
  mediaProgressed,
} from './playbackRecovery';
import { appLog, isVerbosePlaybackLogging, isTvDoctorLogEnabled, startTvDoctorLogging, stopTvDoctorLogging, tvDoctorLog } from './appLog';

/**
 * TV Doktor – intelligens, önfejlesztő diagnosztikai és csatornaváltás-gyorsító rendszer.
 *
 * Feladatai:
 *  1. Villámgyors csatornaváltás: csatornánként pontosan megjegyzi a legutóbb ténylegesen működő
 *     és leggyorsabb lejátszási formátumot (TS / HLS) + pufferprofilt (instant / turbo / fast / ...),
 *     és újranyitáskor késlekedés nélkül azonnal azt alkalmazza.
 *  2. Több különböző beállítás gyors kipróbálása: indulási vagy lejátszási hiba esetén nem ismételgeti
 *     lassan ugyanazt a beállítást, hanem gyorsan végigpróbál több eltérő formátum- és pufferprofilt.
 *  3. Valóban nem működő csatornák leállítása: korlátozott számú gyors beállításpróba után leállítja
 *     az újrapróbálást, így soha nem pörög végtelen ciklusban egy halott csatornán.
 *  4. 1 MB (1024 KB) dedikált, aszinkron háttér-memória: bőséges hely a tanult csatornaprofiloknak
 *     anélkül, hogy a localStorage írás valaha is megakasztaná a csatornaváltást.
 *  5. Színkódolt eseménykategóriák: külön követi és jelzi a Tanulás, Segítség/Javítás, Aktiválódás
 *     és Csatornahiba eseményeket.
 */

export const TV_DOCTOR_STORAGE_KEY = 'iptv_rt_tv_doctor_v2';
export const TV_DOCTOR_SYNC_STORAGE_KEY = 'iptv_rt_tv_doctor_sync_v2';
export const TV_DOCTOR_DIAG_LOGGING_KEY = 'iptv_rt_tv_doctor_diag_log_v1';

/** Az aktuális lejátszás pillanatképe a kézi TV Doktor napló indításához. */
export interface TvDoctorActivePlaybackSnapshot {
  channelName: string;
  channelId: string;
  contentType: 'live' | 'vod';
  format: string;
  bufferProfile: string;
  playing: boolean;
  loading: boolean;
  recovering: boolean;
  capturedAt: number;
}
let activePlaybackSnapshot: TvDoctorActivePlaybackSnapshot | null = null;

export function setTvDoctorActivePlaybackSnapshot(
  snapshot: Omit<TvDoctorActivePlaybackSnapshot, 'capturedAt'>,
): void {
  activePlaybackSnapshot = { ...snapshot, capturedAt: Date.now() };
}

export function getTvDoctorActivePlaybackSnapshot(): TvDoctorActivePlaybackSnapshot | null {
  return activePlaybackSnapshot ? { ...activePlaybackSnapshot } : null;
}

/*
 * A kézi TV Doktor napló minden éppen tesztelt csatorna pufferelési állapotát
 * méri. Csak a TV Doktor napló indításakor indul; normál tévézés közben nincs
 * időzítő vagy extra lejátszási/hálózati művelet.
 */
let stopPlaybackTelemetry: (() => void) | null = null;

export function startTvDoctorPlaybackTelemetry(): void {
  stopPlaybackTelemetry?.();
  if (typeof document === 'undefined') {
    tvDoctorLog('TV DOKTOR MÉRÉS: a dokumentum nem érhető el; médiafigyelés nem indult.');
    return;
  }
  const video = document.querySelector('video') as HTMLVideoElement | null;
  if (!video) {
    tvDoctorLog('TV DOKTOR MÉRÉS: nem található aktív HTML videóelem; a csatornamérés nem indult el.');
    return;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let waitingSince = 0;
  let waitingChannel = '';
  let waitingChannelId = '';
  let waitingEpisodes = 0;
  let waitingEvents = 0;
  let stalledEvents = 0;
  let totalBufferingMs = 0;
  let maxBufferingMs = 0;
  let sampleCount = 0;
  let lastChannelIdentity = '';

  const active = (): TvDoctorActivePlaybackSnapshot | null => activePlaybackSnapshot
    ? { ...activePlaybackSnapshot }
    : null;

  const closeBuffering = (reason: string): void => {
    if (!waitingSince) return;
    const elapsed = Math.max(0, Date.now() - waitingSince);
    totalBufferingMs += elapsed;
    maxBufferingMs = Math.max(maxBufferingMs, elapsed);
    const snapshot = active();
    tvDoctorLog(
      `TV DOKTOR PUFFERELÉSI EPIZÓD VÉGE: csatorna=${waitingChannel || snapshot?.channelName || 'ismeretlen'}; ` +
      `csatorna_ID=${waitingChannelId || snapshot?.channelId || '-'}; időtartam=${elapsed}ms; kiváltó_esemény=${reason}.`
    );
    waitingSince = 0;
    waitingChannel = '';
    waitingChannelId = '';
  };

  const writeSample = (reason: string): void => {
    const snapshot = active();
    const now = Date.now();
    const channelName = snapshot?.channelName || 'ismeretlen csatorna';
    const channelId = snapshot?.channelId || '';
    const identity = `${snapshot?.contentType || 'live'}:${channelId || channelName}`;
    if (lastChannelIdentity && identity !== lastChannelIdentity) {
      tvDoctorLog(
        `TV DOKTOR MÉRÉS CSATORNAVÁLTÁS: előző=${lastChannelIdentity}; új=${channelName}; azonosító=${channelId || '-'}.`
      );
      closeBuffering('csatornaváltás');
    }
    lastChannelIdentity = identity;

    let ahead: number | null = null;
    try { ahead = bufferedAheadSeconds(video); } catch { ahead = null; }
    let ranges = 'nem mérhető';
    try {
      const items: string[] = [];
      for (let i = 0; i < video.buffered.length; i += 1) {
        items.push(`${video.buffered.start(i).toFixed(2)}-${video.buffered.end(i).toFixed(2)}s`);
      }
      ranges = items.length ? items.join(',') : 'üres';
    } catch { /* a webOS motor nem adta át a tartományokat */ }
    const mediaError = video.error;
    const errorMessage = String((mediaError as (MediaError & { message?: string }) | null)?.message || '-');
    const elapsed = waitingSince ? Math.max(0, now - waitingSince) : 0;
    sampleCount += 1;

    tvDoctorLog(
      `TV DOKTOR PUFFER MÉRÉS: minta=${sampleCount}; esemény=${reason}; csatorna=${channelName}; csatorna_ID=${channelId || '-'}; ` +
      `tartalom=${snapshot?.contentType || 'live'}; formátum=${snapshot?.format || formatOfUrl(video.currentSrc || video.src) || 'ismeretlen'}; ` +
      `pufferprofil=${snapshot?.bufferProfile || 'ismeretlen'}; lejátszik=${!video.paused && !video.ended}; betöltés=${video.readyState < 3}; ` +
      `helyreállítás=${snapshot?.recovering ?? false}; pufferelés_esemény_aktív=${waitingSince > 0}; pufferelés_ideje=${elapsed}ms; ` +
      `puffer_előre=${ahead === null ? 'nem mérhető' : ahead.toFixed(2) + 's'}; buffered_tartományok=[${ranges}]; ` +
      `currentTime=${Number(video.currentTime || 0).toFixed(2)}s; duration=${Number.isFinite(video.duration) ? video.duration.toFixed(2) + 's' : 'n/a'}; ` +
      `readyState=${video.readyState}; networkState=${video.networkState}; paused=${video.paused}; seeking=${video.seeking}; ended=${video.ended}; ` +
      `video=${video.videoWidth}x${video.videoHeight}; media_error=${mediaError?.code ?? '-'}; media_error_message=${errorMessage}.`
    );
  };

  const onMediaEvent = (event: Event): void => {
    const snapshot = active();
    if (event.type === 'waiting' || event.type === 'stalled') {
      if (event.type === 'waiting') waitingEvents += 1;
      else stalledEvents += 1;
      if (!waitingSince) {
        waitingSince = Date.now();
        waitingChannel = snapshot?.channelName || 'ismeretlen csatorna';
        waitingChannelId = snapshot?.channelId || '';
        waitingEpisodes += 1;
      }
    } else if (event.type === 'playing') {
      closeBuffering('playing');
    }
    writeSample(`MEDIA_${event.type.toUpperCase()}`);
  };

  const events = [
    'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
    'waiting', 'stalled', 'playing', 'progress', 'suspend', 'pause',
    'error', 'emptied', 'abort', 'seeking', 'seeked', 'ended',
  ];
  events.forEach((eventName) => video.addEventListener(eventName, onMediaEvent));

  writeSample('KÉZI_NAPLÓ_INDÍTÁSI_ÁLLAPOT');
  timer = setInterval(() => writeSample('FOLYAMATOS_2MP_MINTA'), 2000);
  stopPlaybackTelemetry = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    closeBuffering('kézi napló leállítása');
    writeSample('KÉZI_NAPLÓ_ZÁRÓ_ÁLLAPOT');
    tvDoctorLog(
      `TV DOKTOR PUFFER MÉRÉS ÖSSZESÍTÉS: waiting_események=${waitingEvents}; stalled_események=${stalledEvents}; ` +
      `pufferelési_epizódok=${waitingEpisodes}; összes_pufferelési_idő=${totalBufferingMs}ms; ` +
      `leghosszabb_epizód=${maxBufferingMs}ms; minták=${sampleCount}; utolsó_csatorna=${active()?.channelName || 'ismeretlen'}; ` +
      `azonosító=${active()?.channelId || '-'}.`
    );
    events.forEach((eventName) => video.removeEventListener(eventName, onMediaEvent));
    stopPlaybackTelemetry = null;
  };
}

export function stopTvDoctorPlaybackTelemetry(): void {
  stopPlaybackTelemetry?.();
}


export const TV_DOCTOR_HU_SCOPE_STORAGE_KEY = 'iptv_rt_tv_doctor_hu_scope_v1';
let activeHungarianChannelIds: Set<string> | null = null;
let activeHungarianChannelCount = 0;
try {
  if (typeof localStorage !== 'undefined') {
    const rawScope = localStorage.getItem(TV_DOCTOR_HU_SCOPE_STORAGE_KEY);
    const parsedScope = rawScope ? JSON.parse(rawScope) : null;
    if (Array.isArray(parsedScope?.channelIds)) {
      activeHungarianChannelIds = new Set(parsedScope.channelIds.filter((id: unknown) => typeof id === 'string' && id.length > 0));
      activeHungarianChannelCount = activeHungarianChannelIds.size;
    }
  }
} catch {
  activeHungarianChannelIds = null;
  activeHungarianChannelCount = 0;
}

// Első indulás az új TV Doktor memóriával: a régi tanulási tárat és várólistát fizikailag is töröljük.
// A párosítás és a külön kézi TV Doktor napló kulcsaihoz nem nyúlunk.
try {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('iptv_rt_tv_doctor_v1');
    localStorage.removeItem('iptv_rt_tv_doctor_sync_v1');
  }
} catch {
  /* a régi helyi memória takarítása nem akadályozhatja az alkalmazás indulását */
}

/** Korlátok a TV erőforrásainak és a localStorage kvótának a védelmére (1 MB dedikált keret). */
export const MAX_LEARNED_CHANNELS = 1600;
export const MAX_SAFE_DOCTOR_STORAGE_BYTES = 1024 * 1024; // 1 MB (1024 KB)
export const WEBOS_LOCAL_STORAGE_QUOTA_BYTES = 5 * 1024 * 1024;
export const DOCTOR_SLOW_OP_THRESHOLD_MS = 25;
export const MAX_DOCTOR_REPAIR_STEPS = 8;
export const MAX_DEAD_CHANNEL_QUICK_STEPS = 2;
export const MAX_INTERVENTIONS_PER_MINUTE = 8;
export const DOCTOR_VERIFY_STABLE_MS = 2200;
// VOD-nál hosszabb stabil lejátszást várunk, mert a rövid canplay/playing után még visszaeshet a stream.
export const DOCTOR_VOD_VERIFY_STABLE_MS = 8000;
export const DEAD_CHANNEL_COOLDOWN_MS = 3 * 60 * 1000;
/*
 * 2.5.277 (#17-es napló, ARENA 4): egy csatorna újraaktiválódási hűtése – egy
 * kimerült javítási létra után ennyi ideig óvatosabb indítási mód marad aktív,
 * de a javítási létra továbbra is mind a 8 lépést megkapja.
 */
export const DOCTOR_REACTIVATION_COOLDOWN_MS = 8 * 60 * 1000;
/** A halott-csatorna jelölés ismétlődő kimerülésnél skálázódik, max. ennyi ideig. */
export const MAX_DEAD_CHANNEL_COOLDOWN_MS = 30 * 60 * 1000;
const STORE_PERSIST_DEBOUNCE_MS = 220;

/** Szigorú biztonsági határok a pufferbeállításokhoz (soha nem nőhet korlátlanul). */
export const MIN_SAFE_BUFFER_SECONDS = 0.5;
export const MAX_SAFE_BUFFER_SECONDS = 10.0;
export const MIN_SAFE_STARTUP_WATCHDOG_MS = 550;
export const MAX_SAFE_STARTUP_WATCHDOG_MS = 4000;
export const MIN_SAFE_BUFFER_WATCHDOG_MS = 2200;
export const MAX_SAFE_BUFFER_WATCHDOG_MS = 9000;
export const MIN_SAFE_STALL_DETECTOR_MS = 2800;
export const MAX_SAFE_STALL_DETECTOR_MS = 9000;

export type DoctorBufferProfileId =
  | 'instant'
  | 'turbo'
  | 'fast'
  | 'balanced'
  | 'stable'
  | 'adaptive-1'
  | 'adaptive-2'
  | 'adaptive-3';

export const DOCTOR_BUFFER_ORDER: readonly DoctorBufferProfileId[] = [
  'instant',
  'turbo',
  'fast',
  'balanced',
  'stable',
  'adaptive-1',
  'adaptive-2',
  'adaptive-3',
];

export interface DoctorBufferConfig extends BufferProfileTiming {
  id: DoctorBufferProfileId;
  label: string;
  isPreset: boolean;
}

export const DOCTOR_BUFFER_CONFIGS: Record<DoctorBufferProfileId, DoctorBufferConfig> = {
  instant: {
    id: 'instant',
    label: 'Azonnali (0.6 mp)',
    isPreset: false,
    startupWatchdogMs: 650,
    bufferWatchdogMs: 2600,
    stallDetectorMs: 3000,
    retryMs: 55,
    minBufferAheadSeconds: 0.6,
  },
  turbo: {
    id: 'turbo',
    label: 'Turbó (0.9 mp)',
    isPreset: false,
    startupWatchdogMs: 850,
    bufferWatchdogMs: 3000,
    stallDetectorMs: 3300,
    retryMs: 75,
    minBufferAheadSeconds: 0.9,
  },
  fast: {
    id: 'fast',
    label: 'Gyors (1.5 mp)',
    isPreset: true,
    startupWatchdogMs: 1150,
    bufferWatchdogMs: 3500,
    stallDetectorMs: 3500,
    retryMs: 110,
    minBufferAheadSeconds: 1.5,
  },
  balanced: {
    id: 'balanced',
    label: 'Kiegyensúlyozott (3.0 mp)',
    isPreset: true,
    startupWatchdogMs: 1850,
    bufferWatchdogMs: 4500,
    stallDetectorMs: 5000,
    retryMs: 180,
    minBufferAheadSeconds: 3.0,
  },
  stable: {
    id: 'stable',
    label: 'Stabil (5.0 mp)',
    isPreset: true,
    startupWatchdogMs: 2600,
    bufferWatchdogMs: 5600,
    stallDetectorMs: 6000,
    retryMs: 320,
    minBufferAheadSeconds: 5.0,
  },
  'adaptive-1': {
    id: 'adaptive-1',
    label: 'Emelt puffer L1 (6.5 mp)',
    isPreset: false,
    startupWatchdogMs: 3100,
    bufferWatchdogMs: 6800,
    stallDetectorMs: 7000,
    retryMs: 450,
    minBufferAheadSeconds: 6.5,
  },
  'adaptive-2': {
    id: 'adaptive-2',
    label: 'Emelt puffer L2 (8.0 mp)',
    isPreset: false,
    startupWatchdogMs: 3500,
    bufferWatchdogMs: 7800,
    stallDetectorMs: 8000,
    retryMs: 600,
    minBufferAheadSeconds: 8.0,
  },
  'adaptive-3': {
    id: 'adaptive-3',
    label: 'Maximális védett puffer L3 (10.0 mp)',
    isPreset: false,
    startupWatchdogMs: 4000,
    bufferWatchdogMs: 9000,
    stallDetectorMs: 9000,
    retryMs: 800,
    minBufferAheadSeconds: 10.0,
  },
};

export type DoctorTriggerReason =
  | 'startup_timeout'
  | 'media_error'
  | 'play_rejected'
  | 'playback_stall'
  | 'buffer_stall'
  | 'unexpected_end'
  | 'unexpected_pause';

/**
 * 4 elkülönített, színkódolt TV Doktor eseménykategória a 0-gombos ablakhoz és a naplóhoz:
 *  - learning: Tanulás (csatornasebesség, működő formátum/puffer megtanulása)
 *  - assistance: Segítség / Javítás (formátumváltás, pufferemelés, sikeres javítás)
 *  - activation: Aktiválódás (TV Doktor közbelépés indulási hiba vagy fagyás miatt)
 *  - channel_error: Csatornahiba (stream hiba, vagy valóban nem működő csatorna végleges leállítása)
 */
export type DoctorEventCategory =
  | 'learning'
  | 'assistance'
  | 'activation'
  | 'channel_error';

export interface DoctorCategoryBucket {
  count: number;
  lastAt: number | null;
  lastChannelName: string | null;
}

export interface DoctorCategoryStats {
  learning: DoctorCategoryBucket;
  assistance: DoctorCategoryBucket;
  activation: DoctorCategoryBucket;
  channel_error: DoctorCategoryBucket;
}

export interface BufferProfileStats {
  ok: number;
  fail: number;
  stalls: number;
  avgStartupMs: number | null;
}

/**
 * 2.5.294 (#TV Doktor tanulás): EGY CSATORNA EGY TANULT „ÚTVONALA”.
 *
 * Útvonal = lejátszási formátum (TS/HLS) + pufferprofil (instant…adaptive-3)
 * együtt, a hozzá tartozó mért indulási idővel és megbízhatósággal.
 *
 * Az 1-es kézi alapbeállítás külön, vész-tartalék profil. Emellett a 2–8.
 * helyen legfeljebb 7 tanult útvonalat tartunk meg, pontszám szerint rendezve.
 * Minden siker/hiba után újramérjük és átrendezzük; az új jobb útvonal előre
 * kerül, a korábbiak hátrébb csúsznak, a 8. helyen túli legrosszabb kiesik.
 *
 * Csak annyit tárolunk, ami a gyors, pontos csatornaváltáshoz kell – nincs
 * itt stream URL, sem személyes adat.
 */
export interface DoctorRoute {
  /** `format:pufferProfil`, pl. `ts:turbo` – ez az útvonal azonosítója. */
  id: string;
  format: LiveFormat;
  bufferProfile: DoctorBufferProfileId;
  ok: number;
  fail: number;
  stalls: number;
  /** EWMA indulási idő (ms) – csak valódi, sikeres indulásból. */
  avgStartupMs: number | null;
  /** A legjobb mért indulási idő (ms). */
  bestStartupMs: number | null;
  lastOkAt: number | null;
  lastFailAt: number | null;
}

/** Az 1-es vész-tartalékon felül a 2–8. helyen tartott tanult útvonalak száma. */
export const MAX_CHANNEL_ROUTES = 7;

export interface ChannelDoctorRecord {
  channelKey: string;
  channelId?: string;
  channelName: string;
  countryCode?: string;
  bestFormat: LiveFormat;
  bestBufferProfile: DoctorBufferProfileId;
  bestBufferAheadSeconds: number;
  lastWorkingFormat?: LiveFormat;
  lastWorkingBufferProfile?: DoctorBufferProfileId;
  lastWorkingStartupMs?: number | null;
  tsAvgStartupMs: number | null;
  hlsAvgStartupMs: number | null;
  bestStartupMs: number | null;
  tsOk: number;
  tsFail: number;
  tsConsecutiveFail?: number;
  hlsOk: number;
  hlsFail: number;
  hlsConsecutiveFail?: number;
  consecutiveCleanStarts?: number;
  consecutiveFailures?: number;
  deadUntil?: number;
  /* 2.5.277: utolsó teljes létra-kimerülés ideje + hányszor halt le – az
     újraaktiválási hűtő (DOCTOR_REACTIVATION_COOLDOWN_MS) és a skálázódó
     halott-jelölés innen számol. */
  lastExhaustedAt?: number;
  haltCount?: number;
  stalls: number;
  repairsOk: number;
  bufferStats: Partial<Record<DoctorBufferProfileId, BufferProfileStats>>;
  /** A csatorna legfeljebb 7 tanult útvonala a külön tárolt 1-es alapbeállítás mellett. */
  routes?: DoctorRoute[];
  lastErrorCode?: string;
  lastErrorReason?: string;
  source?: 'local' | 'cloud' | 'merged';
  confidence?: number;
  updatedAt: number;
}

export interface DoctorStreamStateSnapshot {
  readyState: number;
  networkState: number;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number | null;
  bufferedAheadSeconds: number;
  decodedFrames: number | null;
  droppedFrames: number | null;
  videoWidth: number;
  videoHeight: number;
  waitingOrStalled: boolean;
}

export interface DoctorDiagnosticReport {
  timestamp: number;
  channelId: string;
  channelKey: string;
  channelName: string;
  countryCode?: string;
  trigger: DoctorTriggerReason;
  format: LiveFormat;
  bufferProfile: DoctorBufferProfileId;
  bufferAheadTargetSeconds: number;
  loadElapsedMs: number;
  errorCode: string | null;
  errorDetail: string | null;
  streamState: DoctorStreamStateSnapshot;
  extraMetrics: Record<string, string | number | boolean>;
}

export interface DoctorBaselineProfile {
  /** A felhasználó által rögzített, soha felül nem írható 1-es alapprofil. */
  slot: 1;
  channelKey: string;
  channelId?: string;
  channelName: string;
  format: LiveFormat;
  bufferProfile: DoctorBufferProfileId;
  bufferTiming: BufferProfileTiming;
  startupMs: number | null;
  recordedAt: number;
}

export interface ChannelLaunchPlan {
  enabled: boolean;
  hasBaselineProfile?: boolean;
  baselineProfile?: DoctorBaselineProfile | null;
  hasLearnedProfile: boolean;
  directFastStart: boolean;
  skipSameFormatRetry: boolean;
  isRecentlyDead: boolean;
  maxRepairSteps: number;
  channelKey: string;
  primaryFormat: LiveFormat;
  alternateFormat: LiveFormat | null;
  bufferProfileId: DoctorBufferProfileId;
  bufferTiming: BufferProfileTiming;
  expectedStartupMs: number | null;
  reason: string;
}

export interface DoctorRepairProposal {
  step: number;
  maxSteps: number;
  strategyId: string;
  description: string;
  nextFormat: LiveFormat;
  nextUrl: string;
  nextBufferProfile: DoctorBufferProfileId;
  nextBufferTiming: BufferProfileTiming;
  delayMs: number;
  useFallbackUrl: boolean;
  forceCleanReset: boolean;
  stopRetrying: boolean;
  exhausted: boolean;
}

export interface DoctorLogEntry {
  eventUid?: string;
  channelId?: string;
  at: number;
  level: 'info' | 'warn' | 'repair' | 'verified' | 'error';
  category: DoctorEventCategory;
  channelKey: string;
  channelName: string;
  message: string;
  operationType?: string;
  operationStep?: number;
  operationMaxSteps?: number;
  operationRecovered?: boolean;
  operationStrategy?: string;
}

export interface DoctorDiagnosticPlugin {
  id: string;
  collect: (context: {
    channel?: Channel | null;
    format: LiveFormat;
    streamState: DoctorStreamStateSnapshot;
  }) => Record<string, string | number | boolean>;
}

interface DoctorStoreData {
  v: 1;
  byKey: Record<string, ChannelDoctorRecord>;
  idIndex: Record<string, string>;
  categoryStats: DoctorCategoryStats;
}

export interface TvDoctorMemoryStats {
  learnedChannelCount: number;
  maxLearnedChannels: number;
  doctorStoreBytes: number;
  cloudQueueBytes: number;
  inMemoryLogBytes: number;
  doctorTotalBytes: number;
  maxSafeDoctorBytes: number;
  doctorBudgetPercent: number;
  tvStorageUsedBytes: number;
  tvStorageQuotaBytes: number;
  tvStoragePercent: number;
  jsHeapUsedMB: number | null;
  jsHeapLimitMB: number | null;
  memoryHealth: 'optimal' | 'moderate' | 'high';
  memoryHealthLabel: string;
  lastStorageError: { location: string; message: string; at: number } | null;
}

export interface TvDoctorOperationHealth {
  decisionsCount: number;
  maxDecisionMs: number;
  slowOpsCount: number;
  lastSlowOp: { op: string; elapsedMs: number; at: number; channelName?: string } | null;
  freezeChecksCount: number;
  confirmedFreezesCount: number;
  repairsAttemptedCount: number;
  repairsVerifiedCount: number;
  deadChannelsHaltedCount: number;
  lastStorageError: { location: string; message: string; at: number } | null;
}

/* TV Doktor: a TV-n megjelenő négy eseménykategória mindegyikéből legfeljebb 8 friss bejegyzés marad. */
const MAX_RECENT_LOGS = 8;
const recentDoctorLogs: DoctorLogEntry[] = [];
const RECENT_DOCTOR_LOGS_STORAGE_KEY = 'iptv_rt_tv_doctor_recent_v1';

function persistRecentDoctorLogs(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(RECENT_DOCTOR_LOGS_STORAGE_KEY, JSON.stringify(recentDoctorLogs));
  } catch {
    // A TV Doktor napló mentése nem akadályozhatja a lejátszást.
  }
}

function restoreRecentDoctorLogs(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(RECENT_DOCTOR_LOGS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      if (!['learning', 'assistance', 'activation', 'channel_error'].includes(item.category)) continue;
      if (!Number.isFinite(Number(item.at)) || !item.channelName || typeof item.message !== 'string') continue;
      recentDoctorLogs.push({
        eventUid: typeof item.eventUid === 'string' ? item.eventUid.slice(0, 160) : undefined,
        channelId: typeof item.channelId === 'string' ? item.channelId.slice(0, 120) : undefined,
        at: Number(item.at),
        level: ['info', 'warn', 'repair', 'verified', 'error'].includes(item.level) ? item.level : 'info',
        category: item.category,
        channelKey: typeof item.channelKey === 'string' ? item.channelKey.slice(0, 140) : 'local',
        channelName: String(item.channelName).slice(0, 140),
        message: item.message.slice(0, 220),
        operationType: typeof item.operationType === 'string' ? item.operationType.slice(0, 48) : undefined,
        operationStep: Number.isFinite(Number(item.operationStep)) ? Math.max(1, Math.min(8, Number(item.operationStep))) : undefined,
        operationMaxSteps: Number.isFinite(Number(item.operationMaxSteps)) ? Math.max(1, Math.min(8, Number(item.operationMaxSteps))) : undefined,
        operationRecovered: typeof item.operationRecovered === 'boolean' ? item.operationRecovered : undefined,
        operationStrategy: typeof item.operationStrategy === 'string' ? item.operationStrategy.slice(0, 64) : undefined,
      });
    }
    for (const category of ['learning', 'assistance', 'activation', 'channel_error'] as DoctorEventCategory[]) {
      const matching = recentDoctorLogs.filter((entry) => entry.category === category);
      const ranked = category === 'assistance'
        ? [...matching].sort((a, b) => doctorOperationScore(b) - doctorOperationScore(a))
        : [...matching].sort((a, b) => b.at - a.at);
      const keep = new Set(ranked.slice(0, MAX_RECENT_LOGS));
      for (let i = recentDoctorLogs.length - 1; i >= 0; i -= 1) {
        if (recentDoctorLogs[i].category === category && !keep.has(recentDoctorLogs[i])) recentDoctorLogs.splice(i, 1);
      }
    }
    recentDoctorLogs.sort((a, b) => a.at - b.at);
  } catch {
    recentDoctorLogs.length = 0;
  }
}
restoreRecentDoctorLogs();
let cloudLogHook: ((entry: DoctorLogEntry) => void) | null = null;
const diagnosticPlugins: DoctorDiagnosticPlugin[] = [];
const interventionTimestampsByChannel = new Map<string, number[]>();
const statusListeners: Array<() => void> = [];

let memoryCache: DoctorStoreData | null = null;
let memoryCacheSerializedChars = 0;
let pendingPersistTimer: ReturnType<typeof setTimeout> | null = null;
let lifecyclePersistAttached = false;

const opHealth: TvDoctorOperationHealth = {
  decisionsCount: 0,
  maxDecisionMs: 0,
  slowOpsCount: 0,
  lastSlowOp: null,
  freezeChecksCount: 0,
  confirmedFreezesCount: 0,
  repairsAttemptedCount: 0,
  repairsVerifiedCount: 0,
  deadChannelsHaltedCount: 0,
  lastStorageError: null,
};

function createEmptyCategoryStats(): DoctorCategoryStats {
  return {
    learning: { count: 0, lastAt: null, lastChannelName: null },
    assistance: { count: 0, lastAt: null, lastChannelName: null },
    activation: { count: 0, lastAt: null, lastChannelName: null },
    channel_error: { count: 0, lastAt: null, lastChannelName: null },
  };
}

function sanitizeCategoryBucket(raw: unknown): DoctorCategoryBucket {
  if (!raw || typeof raw !== 'object') {
    return { count: 0, lastAt: null, lastChannelName: null };
  }
  const obj = raw as Record<string, unknown>;
  const count = Math.max(0, Math.round(Number(obj.count) || 0));
  const lastAt = typeof obj.lastAt === 'number' && Number.isFinite(obj.lastAt) && obj.lastAt > 0
    ? obj.lastAt
    : null;
  const lastChannelName = typeof obj.lastChannelName === 'string' && obj.lastChannelName
    ? obj.lastChannelName.slice(0, 120)
    : null;
  return { count, lastAt, lastChannelName };
}

function sanitizeCategoryStats(raw: unknown): DoctorCategoryStats {
  if (!raw || typeof raw !== 'object') return createEmptyCategoryStats();
  const obj = raw as Record<string, unknown>;
  return {
    learning: sanitizeCategoryBucket(obj.learning),
    assistance: sanitizeCategoryBucket(obj.assistance),
    activation: sanitizeCategoryBucket(obj.activation),
    channel_error: sanitizeCategoryBucket(obj.channel_error),
  };
}

function nowPerfMs(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch {
    /* ignore */
  }
  return Date.now();
}

export function subscribeTvDoctorUpdates(listener: () => void): () => void {
  statusListeners.push(listener);
  return () => {
    const idx = statusListeners.indexOf(listener);
    if (idx >= 0) statusListeners.splice(idx, 1);
  };
}

export function setTvDoctorCloudLogHook(hook: ((entry: DoctorLogEntry) => void) | null): void {
  cloudLogHook = hook;
}

function doctorOperationScore(entry: DoctorLogEntry): number {
  const recovered = entry.operationRecovered === true || entry.level === 'verified';
  const failed = entry.operationRecovered === false || entry.level === 'error';
  const step = Math.max(1, Math.min(8, Number(entry.operationStep) || 8));
  // Sikeres javítás az elsődleges; azonos eredménynél a kevesebb lépés,
  // majd a frissebb mérés kap jobb helyezést.
  return (recovered ? 1000 : 0) - (failed ? 500 : 0) + (8 - step) * 10 + Math.min(9, entry.at / 1e13);
}

function markLatestRepairOutcome(channelKey: string, at: number, recovered: boolean): void {
  const candidate = [...recentDoctorLogs]
    .filter((entry) => entry.category === 'assistance'
      && entry.channelKey === channelKey
      && entry.at <= at
      && entry.operationType !== 'repair_verified')
    .sort((a, b) => b.at - a.at)[0];
  if (candidate) candidate.operationRecovered = recovered;
}

function trimDoctorCategoryLogs(category: DoctorEventCategory): void {
  const matching = recentDoctorLogs.filter((entry) => entry.category === category);
  const ranked = category === 'assistance'
    ? [...matching].sort((a, b) => doctorOperationScore(b) - doctorOperationScore(a))
    : [...matching].sort((a, b) => b.at - a.at);
  const keep = new Set(ranked.slice(0, MAX_RECENT_LOGS));
  for (let i = recentDoctorLogs.length - 1; i >= 0; i -= 1) {
    if (recentDoctorLogs[i].category === category && !keep.has(recentDoctorLogs[i])) recentDoctorLogs.splice(i, 1);
  }
}

export function mergeCloudDoctorLogs(entries: unknown[]): void {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const validCategories = new Set<DoctorEventCategory>(['learning', 'assistance', 'activation', 'channel_error']);
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const category = item.category as DoctorEventCategory;
    const at = Number(item.at);
    if (!validCategories.has(category) || !Number.isFinite(at) || at <= 0) continue;
    const eventUid = typeof item.eventUid === 'string' ? item.eventUid.slice(0, 160) : undefined;
    const channelKey = typeof item.channelKey === 'string' ? item.channelKey.slice(0, 140) : 'cloud-system';
    const channelName = typeof item.channelName === 'string' ? item.channelName.slice(0, 140) : 'Rendszer';
    const message = typeof item.message === 'string' ? item.message.slice(0, 220) : '';
    const level = item.level === 'warn' || item.level === 'repair' || item.level === 'verified' || item.level === 'error' ? item.level : 'info';
    const details = item.details && typeof item.details === 'object' ? item.details as Record<string, unknown> : {};
    const operationType = typeof item.eventType === 'string' ? item.eventType : undefined;
    const operationStep = Number.isFinite(Number(details.step)) ? Math.max(1, Math.min(8, Math.round(Number(details.step)))) : undefined;
    const operationMaxSteps = Number.isFinite(Number(details.maxSteps)) ? Math.max(1, Math.min(8, Math.round(Number(details.maxSteps)))) : undefined;
    const operationRecovered = typeof item.recovered === 'boolean' ? item.recovered : undefined;
    const operationStrategy = typeof details.strategyId === 'string' ? details.strategyId.slice(0, 64) : undefined;
    const duplicate = recentDoctorLogs.some((entry) => eventUid ? entry.eventUid === eventUid : entry.category === category && entry.at === at && entry.channelKey === channelKey && entry.message === message);
    if (!duplicate) recentDoctorLogs.push({ eventUid, at, level, category, channelKey, channelName, message, operationType, operationStep, operationMaxSteps, operationRecovered, operationStrategy });
  }
  // A sikeres lejátszás vagy a kimerült javítási létra visszajelzése
  // minősíti az előtte futó legutóbbi próbát ugyanazon a csatornán.
  for (const entry of recentDoctorLogs) {
    if (entry.operationType === 'repair_verified') markLatestRepairOutcome(entry.channelKey, entry.at, true);
    if (entry.operationType === 'repair_exhausted' || entry.operationType === 'freeze_detected') {
      markLatestRepairOutcome(entry.channelKey, entry.at, false);
    }
  }
  for (const category of ['learning', 'assistance', 'activation', 'channel_error'] as DoctorEventCategory[]) {
    trimDoctorCategoryLogs(category);
  }
  recentDoctorLogs.sort((a, b) => a.at - b.at);

  // A Supabase-ből visszaállított eseményeknek a négy összesítő kockát is
  // újra kell tölteniük. Korábban csak a memóriabeli naplólista frissült,
  // miközben a kockák a kizárólag helyi categoryStats számlálókat olvasták.
  const store = readStore();
  for (const category of ['learning', 'assistance', 'activation', 'channel_error'] as DoctorEventCategory[]) {
    const matching = recentDoctorLogs.filter((entry) => entry.category === category);
    const latest = matching.length ? matching[matching.length - 1] : null;
    const bucket = store.categoryStats[category];
    bucket.count = Math.max(bucket.count, matching.length);
    if (latest && (bucket.lastAt === null || latest.at >= bucket.lastAt)) {
      bucket.lastAt = latest.at;
      bucket.lastChannelName = latest.channelName;
    }
  }
  writeStore(store);
  persistRecentDoctorLogs();
  notifyTvDoctorListeners();
}

export function notifyTvDoctorListeners(): void {
  for (let i = 0; i < statusListeners.length; i += 1) {
    try {
      statusListeners[i]?.();
    } catch {
      /* ignore listener errors */
    }
  }
}

/*
 * 2.5.264: a TV Doktor naplózás KÜLÖN kapcsolható – nem a nagy napló része.
 * A valódi állapot a külön TV Doktor naplózó pufferé (appLog.ts:
 * startTvDoctorLogging/stopTvDoctorLogging), így ez a kapcsoló a nagy napló
 * nélkül is működik, és a TV DOKTOR sorok soha nem kerülnek a nagy naplóba.
 * A `storage` paraméter a teszteké maradt (elszigetelt tároló).
 */
export function isTvDoctorDiagLoggingEnabled(storage?: Storage | null): boolean {
  if (storage) {
    try {
      const raw = storage.getItem(TV_DOCTOR_DIAG_LOGGING_KEY);
      return raw !== '0' && raw !== 'false';
    } catch {
      return true;
    }
  }
  return isTvDoctorLogEnabled();
}

export function setTvDoctorDiagLoggingEnabled(enabled: boolean, storage?: Storage | null): void {
  if (storage) {
    try {
      storage.setItem(TV_DOCTOR_DIAG_LOGGING_KEY, enabled ? '1' : '0');
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    localStorage.setItem(TV_DOCTOR_DIAG_LOGGING_KEY, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
  // A tényleges naplózó kapcsoló a külön TV Doktor napló indítása/leállítása.
  if (enabled) startTvDoctorLogging();
  else stopTvDoctorLogging('kapcsoló kikapcsolva');
  tvDoctorLog(`TV DOKTOR NAPLÓZÁSI BEÁLLÍTÁS: ${enabled ? 'BEKAPCSOLVA (külön TV Doktor napló aktív)' : 'KIKAPCSOLVA'}`);
  notifyTvDoctorListeners();
}

export function recordDoctorOpTiming(op: string, elapsedMs: number, channelName?: string): void {
  const rounded = Math.max(0, Math.round(elapsedMs * 10) / 10);
  if (rounded > opHealth.maxDecisionMs) opHealth.maxDecisionMs = rounded;
  if (rounded >= DOCTOR_SLOW_OP_THRESHOLD_MS) {
    opHealth.slowOpsCount += 1;
    opHealth.lastSlowOp = {
      op,
      elapsedMs: rounded,
      at: Date.now(),
      channelName,
    };
    if (isTvDoctorDiagLoggingEnabled()) {
      appLog(
        `TV DOKTOR ELAKADÁS / LASSULÁS: művelet=${op}; idő=${rounded} ms${channelName ? `; csatorna=${channelName}` : ''}`,
      );
    }
  }
}

export function getTvDoctorOperationHealth(): TvDoctorOperationHealth {
  return {
    decisionsCount: opHealth.decisionsCount,
    maxDecisionMs: opHealth.maxDecisionMs,
    slowOpsCount: opHealth.slowOpsCount,
    lastSlowOp: opHealth.lastSlowOp ? { ...opHealth.lastSlowOp } : null,
    freezeChecksCount: opHealth.freezeChecksCount,
    confirmedFreezesCount: opHealth.confirmedFreezesCount,
    repairsAttemptedCount: opHealth.repairsAttemptedCount,
    repairsVerifiedCount: opHealth.repairsVerifiedCount,
    deadChannelsHaltedCount: opHealth.deadChannelsHaltedCount,
    lastStorageError: opHealth.lastStorageError ? { ...opHealth.lastStorageError } : null,
  };
}

export function resetTvDoctorOperationCounters(): void {
  opHealth.decisionsCount = 0;
  opHealth.maxDecisionMs = 0;
  opHealth.slowOpsCount = 0;
  opHealth.lastSlowOp = null;
  opHealth.freezeChecksCount = 0;
  opHealth.confirmedFreezesCount = 0;
  opHealth.repairsAttemptedCount = 0;
  opHealth.repairsVerifiedCount = 0;
  opHealth.deadChannelsHaltedCount = 0;
}

export function formatDoctorBytes(bytes: number): string {
  const safe = Math.max(0, Math.round(Number(bytes) || 0));
  if (safe === 0) return '0 B';
  if (safe < 1024) return `${safe} B`;
  const kb = safe / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return Math.abs(mb - Math.round(mb)) < 0.005 ? `${Math.round(mb)} MB` : `${mb.toFixed(2)} MB`;
}

type CloudEventHook = (payload: {
  eventType:
    | 'measurement'
    | 'diagnostic'
    | 'speed_test'
    | 'buffer_test'
    | 'repair_attempt'
    | 'repair_verified'
    | 'repair_exhausted'
    | 'freeze_detected'
    | 'channel_dead'

  record?: ChannelDoctorRecord | null;
  event: Record<string, unknown>;
}) => void;

let cloudHook: CloudEventHook | null = null;

export function setTvDoctorCloudHook(hook: CloudEventHook | null): void {
  cloudHook = hook;
}

/** ES5-biztos ékezetmentesítés és csatornakulcs-képzés (soha nem tartalmaz URL-t/jelszót). */
const DIACRITIC_MAP: Record<string, string> = {
  á: 'a', à: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a',
  é: 'e', è: 'e', ê: 'e', ë: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', ö: 'o', ő: 'o', õ: 'o',
  ú: 'u', ù: 'u', û: 'u', ü: 'u', ű: 'u',
  ç: 'c', ñ: 'n', š: 's', ž: 'z', ý: 'y', ř: 'r', č: 'c', ť: 't', ď: 'd', ň: 'n', ľ: 'l', ĺ: 'l',
};

function foldAscii(input: string): string {
  let out = '';
  const lower = String(input || '').toLowerCase();
  for (let i = 0; i < lower.length; i += 1) {
    const ch = lower[i];
    out += DIACRITIC_MAP[ch] !== undefined ? DIACRITIC_MAP[ch] : ch;
  }
  return out;
}

export interface VodDoctorTarget {
  id?: string;
  title?: string;
  streamUrl?: string;
  mediaKind?: 'movie' | 'series' | 'vod';
}

export interface VodLaunchPlan {
  enabled: boolean;
  hasLearnedProfile: boolean;
  vodKey: string;
  streamFormat: LiveFormat;
  bufferProfileId: DoctorBufferProfileId;
  bufferTiming: BufferProfileTiming;
  startupWatchdogMs: number;
  expectedStartupMs: number | null;
  reason: string;
}

export function normalizeChannelDoctorKey(
  channel?: (Pick<Channel, 'id' | 'name'> & { countryCode?: string }) | null,
): string {
  if (!channel) return 'unknown-channel';
  const rawName = String(channel.name || '').trim();
  let country = String(channel.countryCode || '').trim().toLowerCase().replace(/[^a-z]/g, '');

  let cleanedName = rawName;
  const bracketMatch = cleanedName.match(/^\s*\[([A-Za-z]{2,4})\]\s*(.+)$/);
  if (bracketMatch) {
    if (!country) country = bracketMatch[1].toLowerCase();
    cleanedName = bracketMatch[2];
  } else {
    const pipeMatch = cleanedName.match(/^\s*([A-Za-z]{2,3})\s*[|:-]\s*(.+)$/);
    if (pipeMatch) {
      if (!country) country = pipeMatch[1].toLowerCase();
      cleanedName = pipeMatch[2];
    }
  }

  const slug = foldAscii(cleanedName)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 88);

  if (slug) {
    return country ? `${country.slice(0, 4)}:${slug}` : slug;
  }
  const fallbackId = foldAscii(String(channel.id || 'channel'))
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 88);
  return fallbackId || 'unknown-channel';
}

/**
 * Kanonikus, hitelesítő adatoktól és szerver-URL-től teljesen mentes kulcs
 * filmekhez és sorozatepizódokhoz (VOD).
 */
export function normalizeVodDoctorKey(target?: VodDoctorTarget | null): string {
  if (!target) return 'vod:unknown';
  const rawUrl = String(target.streamUrl || '').split(/[?#]/)[0];
  let kind: 'movie' | 'series' | 'vod' = target.mediaKind || 'vod';
  if (kind === 'vod') {
    if (/\/series\//i.test(rawUrl)) kind = 'series';
    else if (/\/movie\//i.test(rawUrl)) kind = 'movie';
  }

  let fileStem = '';
  if (rawUrl) {
    const segments = rawUrl.split('/').filter(Boolean);
    const lastSegment = segments.length > 0 ? segments[segments.length - 1] : '';
    const withoutExt = lastSegment.replace(/\.[a-z0-9]{2,5}$/i, '');
    fileStem = foldAscii(withoutExt)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
  }

  const titleSlug = foldAscii(String(target.title || ''))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  const idSlug = foldAscii(String(target.id || ''))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

  if (titleSlug) {
    return `vod:${kind}:${titleSlug}`.slice(0, 112);
  }
  if (idSlug) {
    return `vod:${kind}:${idSlug}`.slice(0, 112);
  }
  if (fileStem) {
    return `vod:${kind}:${fileStem}`.slice(0, 112);
  }
  return `vod:${kind}:unknown`;
}

export function clampBufferTiming(timing: BufferProfileTiming): BufferProfileTiming {
  const clamp = (val: number, min: number, max: number, def: number): number => {
    const n = Number(val);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  };
  return {
    startupWatchdogMs: Math.round(clamp(timing.startupWatchdogMs, MIN_SAFE_STARTUP_WATCHDOG_MS, MAX_SAFE_STARTUP_WATCHDOG_MS, 1850)),
    bufferWatchdogMs: Math.round(clamp(timing.bufferWatchdogMs, MIN_SAFE_BUFFER_WATCHDOG_MS, MAX_SAFE_BUFFER_WATCHDOG_MS, 4500)),
    stallDetectorMs: Math.round(clamp(timing.stallDetectorMs, MIN_SAFE_STALL_DETECTOR_MS, MAX_SAFE_STALL_DETECTOR_MS, 5000)),
    retryMs: Math.round(clamp(timing.retryMs, 40, 1500, 180)),
    minBufferAheadSeconds: Math.round(clamp(timing.minBufferAheadSeconds, MIN_SAFE_BUFFER_SECONDS, MAX_SAFE_BUFFER_SECONDS, 3.0) * 100) / 100,
  };
}

export function getDoctorBufferConfig(profileId: DoctorBufferProfileId): DoctorBufferConfig {
  const cfg = DOCTOR_BUFFER_CONFIGS[profileId] || DOCTOR_BUFFER_CONFIGS.balanced;
  const clamped = clampBufferTiming(cfg);
  return {
    ...cfg,
    ...clamped,
  };
}

/**
 * Hibajavításkor (megakadás/indulási gond) mindig felfelé, biztonságos pufferprofilra lépünk:
 * az instant/turbo profilról egyből fast/balanced-ra ugrunk, hogy valóban érezhetően nőjön a tartalék.
 */
export function nextSafeBufferProfile(current: DoctorBufferProfileId): DoctorBufferProfileId {
  if (current === 'instant' || current === 'turbo') return 'fast';
  const idx = DOCTOR_BUFFER_ORDER.indexOf(current);
  if (idx < 0) return 'balanced';
  if (idx >= DOCTOR_BUFFER_ORDER.length - 1) return DOCTOR_BUFFER_ORDER[DOCTOR_BUFFER_ORDER.length - 1];
  return DOCTOR_BUFFER_ORDER[idx + 1];
}

function getStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Az 1-es alapprofil külön tárban él: a tanulás, a hibák és a felhőszinkron nem írhatja át. */
export const TV_DOCTOR_BASELINE_STORAGE_KEY = 'iptv_rt_tv_doctor_baseline_v1';
const MAX_DOCTOR_BASELINE_CHANNELS = 3000;

function readDoctorBaselineStore(storage?: Storage | null): Record<string, DoctorBaselineProfile> {
  const target = getStorage(storage);
  if (!target) return {};
  try {
    const raw = target.getItem(TV_DOCTOR_BASELINE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean: Record<string, DoctorBaselineProfile> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, any>)) {
      if (!key || !value || typeof value !== 'object') continue;
      if (value.slot !== 1 || !isValidFormat(value.format) || !isValidBufferProfile(value.bufferProfile)) continue;
      const timing = value.bufferTiming;
      if (!timing || typeof timing !== 'object') continue;
      clean[key] = {
        slot: 1,
        channelKey: key,
        channelId: typeof value.channelId === 'string' ? value.channelId.slice(0, 120) : undefined,
        channelName: String(value.channelName || key).slice(0, 140),
        format: value.format,
        bufferProfile: value.bufferProfile,
        bufferTiming: clampBufferTiming(timing as BufferProfileTiming),
        startupMs: Number.isFinite(Number(value.startupMs)) && Number(value.startupMs) > 0
          ? Math.round(Number(value.startupMs)) : null,
        recordedAt: Number.isFinite(Number(value.recordedAt)) && Number(value.recordedAt) > 0
          ? Math.round(Number(value.recordedAt)) : 0,
      };
    }
    return clean;
  } catch {
    return {};
  }
}

/** Az adott csatorna rögzített 1-es alapprofilja. */
export function getDoctorBaseline(
  channel?: Pick<Channel, 'id' | 'name' | 'countryCode'> | null,
  storage?: Storage | null,
): DoctorBaselineProfile | null {
  if (!channel) return null;
  const key = normalizeChannelDoctorKey(channel);
  const found = readDoctorBaselineStore(storage)[key];
  return found ? { ...found, bufferTiming: { ...found.bufferTiming } } : null;
}

/** Első sikeres, TV Doktor nélküli kézi lejátszás rögzítése. A már létező 1-es profil érinthetetlen. */
export function recordDoctorBaseline(params: {
  channel?: Pick<Channel, 'id' | 'name' | 'countryCode'> | null;
  format: LiveFormat;
  bufferProfile: DoctorBufferProfileId;
  bufferTiming: BufferProfileTiming;
  startupMs?: number | null;
  storage?: Storage | null;
}): DoctorBaselineProfile | null {
  const { channel, format, bufferProfile, bufferTiming, startupMs, storage } = params;
  if (!channel || !isValidFormat(format) || !isValidBufferProfile(bufferProfile)) return null;
  const target = getStorage(storage);
  if (!target) return null;
  const store = readDoctorBaselineStore(target);
  const key = normalizeChannelDoctorKey(channel);
  if (store[key]) return store[key];
  if (Object.keys(store).length >= MAX_DOCTOR_BASELINE_CHANNELS) return null;
  const baseline: DoctorBaselineProfile = {
    slot: 1,
    channelKey: key,
    channelId: channel.id ? String(channel.id).slice(0, 120) : undefined,
    channelName: String(channel.name || channel.id || key).slice(0, 140),
    format,
    bufferProfile,
    bufferTiming: clampBufferTiming(bufferTiming),
    startupMs: Number.isFinite(Number(startupMs)) && Number(startupMs) > 0
      ? Math.round(Number(startupMs)) : null,
    recordedAt: Date.now(),
  };
  store[key] = baseline;
  try {
    target.setItem(TV_DOCTOR_BASELINE_STORAGE_KEY, JSON.stringify(store));
    return baseline;
  } catch {
    return null;
  }
}

function createEmptyStore(): DoctorStoreData {
  return {
    v: 1,
    byKey: {},
    idIndex: {},
    categoryStats: createEmptyCategoryStats(),
  };
}

function isValidFormat(value: unknown): value is LiveFormat {
  return value === 'ts' || value === 'hls';
}

function isValidBufferProfile(value: unknown): value is DoctorBufferProfileId {
  return typeof value === 'string' && (DOCTOR_BUFFER_ORDER as readonly string[]).indexOf(value) >= 0;
}

/* ============================================================================
 * 2.5.294: TANULT ÚTVONALAK (csatornánként max. 8) – a TV Doktor memóriája
 * ============================================================================
 * A cél: NE csak visszaváltáskor javítson, hanem MINDEN adásból tanuljon, és
 * a csatorna saját, elmentett tapasztalatából indítson – a lehető leggyorsabb
 * módon. Ezért a formátum + pufferprofil párost együtt pontozzuk.
 */

export function doctorRouteId(format: LiveFormat, profile: DoctorBufferProfileId): string {
  return `${format}:${profile}`;
}

/** Egy útvonal pontszáma: megbízhatóság – megakadás-büntetés + sebesség + frissesség. */
export function doctorRouteScore(route: DoctorRoute, now = Date.now()): number {
  const ok = Math.max(0, route.ok || 0);
  const fail = Math.max(0, route.fail || 0);
  const total = ok + fail;
  // Sosem sikerült útvonal: csak akkor marad a listában, ha van hely.
  if (total <= 0 || ok <= 0) return -1 - Math.min(0.9, fail * 0.1);
  const reliability = ok / total;
  const stallPenalty = Math.min(0.8, ((route.stalls || 0) / Math.max(1, ok)) * 0.45);
  const speed = route.avgStartupMs !== null && route.avgStartupMs > 20
    ? Math.max(0, (4200 - route.avgStartupMs) / 9500)
    : 0;
  // A régen sikerült útvonal kicsit veszít az értékéből (max. 0,04 – nem döntő).
  const ageDays = route.lastOkAt ? Math.max(0, (now - route.lastOkAt) / 86_400_000) : 0;
  const freshness = Math.max(0, 0.04 - Math.min(0.04, ageDays * 0.002));
  return reliability - stallPenalty + speed + freshness;
}

/** Tárolt/felhőből érkező nyers útvonalak biztonságos átalakítása. */
export function sanitizeDoctorRoutes(raw: unknown): DoctorRoute[] {
  if (!Array.isArray(raw)) return [];
  const out: DoctorRoute[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_CHANNEL_ROUTES * 2)) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (!isValidFormat(obj.format)) continue;
    if (!isValidBufferProfile(obj.bufferProfile)) continue;
    const format = obj.format as LiveFormat;
    const bufferProfile = obj.bufferProfile as DoctorBufferProfileId;
    const id = doctorRouteId(format, bufferProfile);
    if (seen.has(id)) continue;
    seen.add(id);
    const num = (value: unknown, max: number): number => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) return 0;
      return Math.min(max, Math.round(parsed));
    };
    const avg = Number(obj.avgStartupMs);
    const best = Number(obj.bestStartupMs);
    out.push({
      id,
      format,
      bufferProfile,
      ok: num(obj.ok, 100000),
      fail: num(obj.fail, 100000),
      stalls: num(obj.stalls, 100000),
      avgStartupMs: Number.isFinite(avg) && avg > 20 ? Math.min(60000, Math.round(avg)) : null,
      bestStartupMs: Number.isFinite(best) && best > 20 ? Math.min(60000, Math.round(best)) : null,
      lastOkAt: typeof obj.lastOkAt === 'number' && obj.lastOkAt > 0 ? Math.round(obj.lastOkAt) : null,
      lastFailAt: typeof obj.lastFailAt === 'number' && obj.lastFailAt > 0 ? Math.round(obj.lastFailAt) : null,
    });
  }
  return rankDoctorRouteList(out);
}

/**
 * Sorrendezés + 8-as korlát. A „sosem sikerült” útvonalak mindig a lista aljára
 * kerülnek, így hely szűkében először azok esnek ki.
 */
export function rankDoctorRouteList(routes: DoctorRoute[], now = Date.now()): DoctorRoute[] {
  const sorted = [...routes].sort((a, b) => {
    const aPure = a.ok > 0 ? 0 : 1;
    const bPure = b.ok > 0 ? 0 : 1;
    if (aPure !== bPure) return aPure - bPure;
    return doctorRouteScore(b, now) - doctorRouteScore(a, now);
  });
  return sorted.slice(0, MAX_CHANNEL_ROUTES);
}

/**
 * 2.5.294: a 0-gombos TV Doktor ablak MŰKÖDÉSÉNEK naplózása.
 *
 * A kézi diagnosztikai napló (SÁRGA gomb / napló-küldés) eddig semmit nem
 * rögzített arról, MI történt az ablakban – így hibakeresésnél nem lehetett
 * tudni, megnyílt-e, mit mutatott, nulláztak-e memóriát, volt-e kapcsolatteszt.
 * Mostantól minden ilyen művelet bekerül a naplóba (de CSAK akkor, ha a
 * TV Doktor naplózás be van kapcsolva, és a 48 soros élő listát nem szemeteljük
 * vele – az a valódi lejátszási eseményeké).
 */
export function logTvDoctorPanel(
  message: string,
  detail?: Record<string, string | number | boolean | null | undefined>,
): void {
  try {
    if (!isTvDoctorDiagLoggingEnabled()) return;
    const extra = detail
      ? Object.entries(detail)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => `${key}=${value}`)
        .join('; ')
      : '';
    const line = `TV DOKTOR ABLAK: ${message}${extra ? ` [${extra}]` : ''}`;
    appLog(line);
    tvDoctorLog(line);
  } catch {
    /* a naplózás hibája soha nem akadályozhatja az ablak működését */
  }
}

/** A csatorna legjobb (leggyorsabb, működő) tanult útvonala. */
export function learnedRouteFor(record?: ChannelDoctorRecord | null): DoctorRoute | null {
  if (!record || !Array.isArray(record.routes) || record.routes.length === 0) return null;
  const ranked = rankDoctorRouteList(sanitizeDoctorRoutes(record.routes));
  const best = ranked.find((route) => route.ok > 0);
  return best || null;
}

/** A csatorna további tanult útvonalai (a legjobb után), a javítási létrához. */
export function learnedRouteCandidates(
  record?: ChannelDoctorRecord | null,
  excludeId?: string | null,
): DoctorRoute[] {
  if (!record || !Array.isArray(record.routes)) return [];
  return rankDoctorRouteList(sanitizeDoctorRoutes(record.routes))
    .filter((route) => route.ok > 0 && route.id !== excludeId);
}

/** Egy adás eredményének beírása a csatorna útvonal-táblájába (max. 8 sor). */
export function recordDoctorRouteOutcome(params: {
  record: ChannelDoctorRecord;
  /** Az 1-es vész-tartalék útvonalát nem duplikáljuk a 2–8. tanult helyen. */
  excludeRouteId?: string | null;
  format: LiveFormat;
  bufferProfile: DoctorBufferProfileId;
  outcome: 'ok' | 'fail' | 'stall';
  startupMs?: number | null;
  now?: number;
}): { route: DoctorRoute; dropped: DoctorRoute | null; isNew: boolean } | null {
  const { record, format, bufferProfile, outcome, excludeRouteId } = params;
  if (!record || !isValidFormat(format) || !isValidBufferProfile(bufferProfile)) return null;
  const now = params.now ?? Date.now();
  const id = doctorRouteId(format, bufferProfile);
  const list = (Array.isArray(record.routes) ? sanitizeDoctorRoutes(record.routes) : [])
    .filter((item) => item.id !== excludeRouteId);
  let route = list.find((item) => item.id === id) || null;
  const isNew = !route;
  if (!route) {
    route = {
      id,
      format,
      bufferProfile,
      ok: 0,
      fail: 0,
      stalls: 0,
      avgStartupMs: null,
      bestStartupMs: null,
      lastOkAt: null,
      lastFailAt: null,
    };
    list.push(route);
  }

  if (outcome === 'ok') {
    const safeMs = Math.max(25, Math.min(60000, Math.round(Number(params.startupMs) || 0)));
    route.ok = Math.min(100000, route.ok + 1);
    route.avgStartupMs = ewma(route.avgStartupMs, safeMs);
    route.bestStartupMs = route.bestStartupMs === null || route.bestStartupMs <= 20
      ? safeMs
      : Math.min(route.bestStartupMs, safeMs);
    route.lastOkAt = now;
  } else if (outcome === 'stall') {
    route.stalls = Math.min(100000, route.stalls + 1);
    route.lastFailAt = now;
  } else {
    route.fail = Math.min(100000, route.fail + 1);
    route.lastFailAt = now;
  }

  const ranked = rankDoctorRouteList(list, now);
  const dropped = list.find((item) => !ranked.some((kept) => kept.id === item.id)) || null;
  record.routes = ranked;
  return { route: ranked.find((item) => item.id === id) || route, dropped, isNew };
}

/**
 * 2.5.294: a felhőbe küldhető, tömör útvonal-lista (max. 8 sor, csak a
 * szükséges mezők – nincs benne stream URL, csatornanév vagy személyes adat).
 */
export function compactDoctorRoutes(routes?: DoctorRoute[] | null): Array<{
  format: string;
  bufferProfile: string;
  ok: number;
  fail: number;
  stalls: number;
  avgStartupMs: number | null;
  bestStartupMs: number | null;
  lastOkAt: number | null;
  lastFailAt: number | null;
}> {
  if (!Array.isArray(routes) || routes.length === 0) return [];
  return rankDoctorRouteList(sanitizeDoctorRoutes(routes)).map((route) => ({
    format: route.format,
    bufferProfile: route.bufferProfile,
    ok: route.ok,
    fail: route.fail,
    stalls: route.stalls,
    avgStartupMs: route.avgStartupMs,
    bestStartupMs: route.bestStartupMs,
    lastOkAt: route.lastOkAt,
    lastFailAt: route.lastFailAt,
  }));
}

/**
 * 2.5.294: a Supabase memóriába feltölthető, tömör útvonal-csomag.
 *
 * Csak a magyar, élő csatornák tanult útvonalai kerülnek bele (a Mozi/Sorozat
 * és a külföldi csatornák soha), csatornánként legfeljebb 8 sor, és összesen
 * legfeljebb 400 csatorna – így egy csomag a ~100 kB-os sávban marad.
 */
export function collectDoctorRoutePayload(storage?: Storage | null): Array<{
  channelKey: string;
  countryCode: string;
  routes: ReturnType<typeof compactDoctorRoutes>;
}> {
  const store = readStore(storage);
  const out: Array<{ channelKey: string; countryCode: string; routes: ReturnType<typeof compactDoctorRoutes> }> = [];
  for (const record of Object.values(store.byKey)) {
    if (out.length >= 400) break;
    if (!record || !record.channelKey || record.channelKey.startsWith('vod:')) continue;
    if (!isHungarianDoctorChannel(record)) continue;
    const routes = compactDoctorRoutes(record.routes);
    if (routes.length === 0) continue;
    out.push({ channelKey: record.channelKey, countryCode: 'HU', routes });
  }
  return out;
}

function sanitizePositiveStartupMs(raw: unknown, okCount: number): number | null {
  if (okCount <= 0) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  // A korábbi szerver-oldali clampInt(null, 20, ...) hiba 20 ms-os helyőrzőt írt be.
  // Valódi hálózati stream indulás TV-n nem 20 ms, ha mellette másik valós mérés van.
  return Math.max(20, Math.min(60000, Math.round(raw)));
}

/**
 * 2.5.294: CSAK A MAGYAR CSATORNÁKRÓL TANULUNK TARTÓSAN.
 *
 * A főoldali (magyar) csatornáknál a TV Doktor minden adásból tanul, és a
 * tanult útvonalakat a készülék + a Supabase memóriája tárolja. A nem magyar
 * csatornákat továbbra is SEGÍTI (gyors indulás, formátumváltás, javítás),
 * de róluk SEMMILYEN adat nem kerül tartós tárolásba vagy a felhőbe.
 */
export function isHungarianDoctorChannel(
  channel?: { id?: string; channelId?: string; channelIdHint?: string; countryCode?: string; categoryName?: string; name?: string } | null,
): boolean {
  if (!channel) return false;
  // A felhőből visszatöltött rekordok szándékosan ID nélkül érkeznek.
  // A kifejezett HU országkódot ezért az ID-lista előtt kell elfogadni,
  // különben a következő mentési kör tévesen kihagyja őket.
  const code = String(channel.countryCode || '').trim().toUpperCase();
  if (code === 'HU') return true;
  // Ha van országkód és az nem HU (pl. GB, DE, INT), akkor nem magyar csatorna.
  if (code) return false;
  if (activeHungarianChannelIds) {
    const id = String(channel.id || channel.channelId || channel.channelIdHint || '').trim();
    return Boolean(id && activeHungarianChannelIds.has(id));
  }
  // Országkód nélküli (ritka) csatornánál a kategória/nevünk dönt.
  const hay = `${channel.categoryName || ''} ${channel.name || ''}`;
  return /magyar|hungary|\bhu\b/i.test(hay);
}

/** Tartósan tárolható-e ez a tanult rekord? (Csak magyar csatorna.) 2.5.310: kulcs-előtag és név alapján is felismerjük a HU csatornát, hogy IPK-újraindításkor se vesszen el a 8 tanult útvonal. */
export function isPersistableDoctorRecord(record?: { countryCode?: string; channelKey?: string; channelName?: string; channelId?: string; channelIdHint?: string } | null): boolean {
  if (!record) return false;
  const id = String(record.channelId || record.channelIdHint || '').trim();
  // Ha van csatornaazonosító, a TV aktuális magyar csatornalistájával ellenőrizzük.
  // A felhőből érkező útvonalrekordok viszont szándékosan csak channel_key + country_code
  // mezőt tartalmaznak; ezeket ID hiányában is vissza kell engedni, különben a
  // beállított magyar csatorna-szűrő minden felhőrekordot eldob.
  if (id && activeHungarianChannelIds) return activeHungarianChannelIds.has(id);
  const code = String((record as any).countryCode || '').trim().toUpperCase();
  if (code === 'HU') return true;
  const key = String((record as any).channelKey || '').trim().toLowerCase();
  if (key.startsWith('hu:')) return true;
  if (code) return false;
  const name = String((record as any).channelName || '');
  return /magyar|hungary/i.test(name);
}

/* ============================================================================
 * 2.5.294: CSAK A SZÜKSÉGESET TÁROLJUK – automatikus újraírás/tisztítás
 * ============================================================================
 * A tárolt (és felhőbe küldött) kép csak a magyar csatornák rekordjait
 * tartalmazza, csatornánként legfeljebb 8 útvonallal és a legszükségesebb
 * számlálókkal. A régi, „minden országról tanult” mentéseket az első olvasás
 * automatikusan lecseréli a szűkített változatra – így hosszú távon sem
 * keletkezik felesleges adat.
 */
function persistedSnapshot(store: DoctorStoreData): DoctorStoreData {
  const byKey: Record<string, ChannelDoctorRecord> = {};
  const idIndex: Record<string, string> = {};
  for (const [key, record] of Object.entries(store.byKey)) {
    if (!record || !isPersistableDoctorRecord(record)) continue;
    const routes = Array.isArray(record.routes) ? rankDoctorRouteList(sanitizeDoctorRoutes(record.routes)) : [];
    byKey[key] = routes.length > 0 ? { ...record, routes } : { ...record, routes: undefined };
    if (record.channelId) idIndex[record.channelId] = key;
  }
  return {
    ...store,
    byKey,
    idIndex,
  };}

function readStore(storage?: Storage | null): DoctorStoreData {
  if (!storage && memoryCache) return memoryCache;
  const target = getStorage(storage);
  if (!target) {
    if (!memoryCache) memoryCache = createEmptyStore();
    return memoryCache;
  }
  try {
    const raw = target.getItem(TV_DOCTOR_STORAGE_KEY);
    if (!raw) {
      const empty = createEmptyStore();
      if (!storage) {
        memoryCache = empty;
        memoryCacheSerializedChars = 0;
      }
      return empty;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.byKey !== 'object') {
      const empty = createEmptyStore();
      if (!storage) {
        memoryCache = empty;
        memoryCacheSerializedChars = 0;
      }
      return empty;
    }
    const cleanByKey: Record<string, ChannelDoctorRecord> = {};
    const cleanIdIndex: Record<string, string> = {};
    let hadLegacyVod = false;
    let hadForeign = false;
    for (const [k, v] of Object.entries(parsed.byKey as Record<string, any>)) {
      if (!k || !v || typeof v !== 'object') continue;
      const candidateKey = String(v.channelKey || k);
      if (
        k.startsWith('vod:') ||
        candidateKey.startsWith('vod:') ||
        v.countryCode === 'VOD' ||
        v.countryCode === 'SER'
      ) {
        hadLegacyVod = true;
        continue;
      }
      if (!isValidFormat(v.bestFormat)) continue;
      /*
       * 2.5.294: a korábbi verziók minden országról tanultak. Mostantól csak a
       * magyar csatornák tudása marad meg tartósan – a régi, idegen rekordokat
       * az első olvasáskor eldobjuk, és a szűkített kép visszaíródik.
       * 2.5.310: HU felismerés kulcs-előtaggal és névvel is (IPK újraindítás után se vesszen el a 8 tanult útvonal).
       */
      if (!isPersistableDoctorRecord(v as any)) {
        hadForeign = true;
        continue;
      }
      const bp: DoctorBufferProfileId = isValidBufferProfile(v.bestBufferProfile)
        ? v.bestBufferProfile
        : 'balanced';
      const tsOk = Math.max(0, Number(v.tsOk) || 0);
      const tsFail = Math.max(0, Number(v.tsFail) || 0);
      const hlsOk = Math.max(0, Number(v.hlsOk) || 0);
      const hlsFail = Math.max(0, Number(v.hlsFail) || 0);
      const tsAvgStartupMs = sanitizePositiveStartupMs(v.tsAvgStartupMs, tsOk);
      const hlsAvgStartupMs = sanitizePositiveStartupMs(v.hlsAvgStartupMs, hlsOk);
      const rawBestMs = typeof v.bestStartupMs === 'number' && v.bestStartupMs > 20
        ? Math.round(v.bestStartupMs)
        : null;
      const bestCandidates = [rawBestMs, tsAvgStartupMs, hlsAvgStartupMs].filter(
        (n): n is number => typeof n === 'number' && n > 0,
      );
      const bestStartupMs = bestCandidates.length > 0 ? Math.min(...bestCandidates) : null;

      const rec: ChannelDoctorRecord = {
        channelKey: candidateKey.slice(0, 120),
        channelId: typeof v.channelId === 'string' ? v.channelId.slice(0, 120) : undefined,
        channelName: String(v.channelName || k).slice(0, 140),
        countryCode: typeof v.countryCode === 'string' ? v.countryCode.slice(0, 12) : undefined,
        bestFormat: v.bestFormat,
        bestBufferProfile: bp,
        bestBufferAheadSeconds: Math.max(
          MIN_SAFE_BUFFER_SECONDS,
          Math.min(MAX_SAFE_BUFFER_SECONDS, Number(v.bestBufferAheadSeconds) || DOCTOR_BUFFER_CONFIGS[bp].minBufferAheadSeconds),
        ),
        lastWorkingFormat: isValidFormat(v.lastWorkingFormat) ? v.lastWorkingFormat : undefined,
        lastWorkingBufferProfile: isValidBufferProfile(v.lastWorkingBufferProfile) ? v.lastWorkingBufferProfile : undefined,
        lastWorkingStartupMs: typeof v.lastWorkingStartupMs === 'number' && v.lastWorkingStartupMs > 0
          ? Math.round(v.lastWorkingStartupMs)
          : null,
        tsAvgStartupMs,
        hlsAvgStartupMs,
        bestStartupMs,
        tsOk,
        tsFail,
        tsConsecutiveFail: Math.max(0, Number(v.tsConsecutiveFail) || 0),
        hlsOk,
        hlsFail,
        hlsConsecutiveFail: Math.max(0, Number(v.hlsConsecutiveFail) || 0),
        consecutiveCleanStarts: Math.max(0, Number(v.consecutiveCleanStarts) || 0),
        consecutiveFailures: Math.max(0, Number(v.consecutiveFailures) || 0),
        deadUntil: typeof v.deadUntil === 'number' && v.deadUntil > 0 ? v.deadUntil : undefined,
        lastExhaustedAt: typeof v.lastExhaustedAt === 'number' && v.lastExhaustedAt > 0 ? v.lastExhaustedAt : undefined,
        haltCount: Math.max(0, Number(v.haltCount) || 0),
        stalls: Math.max(0, Number(v.stalls) || 0),
        repairsOk: Math.max(0, Number(v.repairsOk) || 0),
        bufferStats: v.bufferStats && typeof v.bufferStats === 'object' ? v.bufferStats : {},
        routes: sanitizeDoctorRoutes(v.routes),
        lastErrorCode: typeof v.lastErrorCode === 'string' ? v.lastErrorCode.slice(0, 48) : undefined,
        lastErrorReason: typeof v.lastErrorReason === 'string' ? v.lastErrorReason.slice(0, 120) : undefined,
        source: v.source === 'cloud' || v.source === 'merged' ? v.source : 'local',
        confidence: typeof v.confidence === 'number' ? v.confidence : undefined,
        updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
      };
      cleanByKey[rec.channelKey] = rec;
      if (rec.channelId) cleanIdIndex[rec.channelId] = rec.channelKey;
    }
    if (parsed.idIndex && typeof parsed.idIndex === 'object') {
      for (const [cid, ckey] of Object.entries(parsed.idIndex as Record<string, unknown>)) {
        if (typeof ckey === 'string' && cleanByKey[ckey]) {
          cleanIdIndex[cid] = ckey;
        }
      }
    }

    const loaded: DoctorStoreData = {
      v: 1,
      byKey: cleanByKey,
      idIndex: cleanIdIndex,
      categoryStats: sanitizeCategoryStats(parsed.categoryStats),
    };
    if (hadLegacyVod || hadForeign) {
      try {
        const cleanedJson = JSON.stringify(loaded);
        target.setItem(TV_DOCTOR_STORAGE_KEY, cleanedJson);
        if (!storage) memoryCacheSerializedChars = cleanedJson.length;
      } catch {
        /* ignore */
      }
    } else if (!storage) {
      memoryCacheSerializedChars = raw.length;
    }
    if (!storage) memoryCache = loaded;
    return loaded;
  } catch {
    const empty = createEmptyStore();
    if (!storage) {
      memoryCache = empty;
      memoryCacheSerializedChars = 0;
    }
    return empty;
  }
}

function pruneStore(store: DoctorStoreData): void {
  const keys = Object.keys(store.byKey);
  if (keys.length > MAX_LEARNED_CHANNELS) {
    const sorted = keys.sort((a, b) => (store.byKey[b]?.updatedAt || 0) - (store.byKey[a]?.updatedAt || 0));
    const keepSet = new Set(sorted.slice(0, MAX_LEARNED_CHANNELS));
    for (const k of keys) {
      if (!keepSet.has(k)) delete store.byKey[k];
    }
    for (const [cid, ckey] of Object.entries(store.idIndex)) {
      if (!keepSet.has(ckey)) delete store.idIndex[cid];
    }
  }

}

function persistStoreNow(store: DoctorStoreData, target: Storage): void {
  const startedAt = nowPerfMs();
  try {
    /*
     * 2.5.294: CSAK a magyar csatornák tudása kerül a tárolóba, csatornánként
     * legfeljebb 8 útvonallal. Ez egyben automatikus újraírás is: a korábbi
     * (minden országra kiterjedő) mentés az első íráskor lecserélődik.
     */
    let serialized = JSON.stringify(persistedSnapshot(store));
    // Biztonsági 1 MB keretvédelem: ha megközelítenénk a 1 MB-os keretet,
    // a legrégebbi elemeket fokozatosan ritkítjuk.
    const maxChars = Math.floor((MAX_SAFE_DOCTOR_STORAGE_BYTES * 0.92) / 2);
    if (serialized.length > maxChars) {
      const keys = Object.keys(store.byKey).sort(
        (a, b) => (store.byKey[b]?.updatedAt || 0) - (store.byKey[a]?.updatedAt || 0),
      );
      const keepCount = Math.max(100, Math.floor(keys.length * 0.7));
      const keep = new Set(keys.slice(0, keepCount));
      for (const k of keys) {
        if (!keep.has(k)) delete store.byKey[k];
      }
      for (const [cid, ckey] of Object.entries(store.idIndex)) {
        if (!keep.has(ckey)) delete store.idIndex[cid];
      }
      serialized = JSON.stringify(persistedSnapshot(store));
    }
    target.setItem(TV_DOCTOR_STORAGE_KEY, serialized);
    if (store === memoryCache) {
      memoryCacheSerializedChars = serialized.length;
    }
    opHealth.lastStorageError = null;
  } catch (err) {
    // Ha a tárhely megtelt, lefaragjuk a legrégebbi elemek felét, de SOHA nem nyúlunk
    // sem a csatornalistához, sem a felhasználói beállításokhoz!
    opHealth.lastStorageError = {
      location: 'TV helyi tárhely (localStorage)',
      message: 'A TV tárhelykvótája betelt – a TV Doktor automatikusan ritkította a legrégebbi tanult profilokat.',
      at: Date.now(),
    };
    if (isTvDoctorDiagLoggingEnabled()) {
      appLog(
        `TV DOKTOR TÁRHELY HIBA [hely=localStorage]: kvótakorlát elérve (${String(err).slice(0, 80)}); automatikus ritkítás fut`,
      );
    }
    try {
      const keys = Object.keys(store.byKey).sort(
        (a, b) => (store.byKey[b]?.updatedAt || 0) - (store.byKey[a]?.updatedAt || 0),
      );
      const keep = new Set(keys.slice(0, Math.max(20, Math.floor(keys.length / 2))));
      for (const k of keys) {
        if (!keep.has(k)) delete store.byKey[k];
      }
      const fallbackJson = JSON.stringify(persistedSnapshot(store));
      target.setItem(TV_DOCTOR_STORAGE_KEY, fallbackJson);
      if (store === memoryCache) {
        memoryCacheSerializedChars = fallbackJson.length;
      }
    } catch {
      /* memóriában tovább működik */
    }
  } finally {
    const elapsed = nowPerfMs() - startedAt;
    // Csak a szokatlanul lassú (>65ms) háttérírást minősítjük lassulásnak,
    // mivel az írás már a csatornaváltáson kívüli üresjáratban fut.
    if (elapsed >= 65) {
      recordDoctorOpTiming('persistStoreIdle', elapsed);
    }
  }
}

export function setTvDoctorHungarianChannelScope(channelIds: string[], checkedAt?: string): void {
  const cleanIds = Array.from(new Set((Array.isArray(channelIds) ? channelIds : [])
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim().slice(0, 120))));
  activeHungarianChannelIds = new Set(cleanIds);
  activeHungarianChannelCount = cleanIds.length;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(TV_DOCTOR_HU_SCOPE_STORAGE_KEY, JSON.stringify({
        channelIds: cleanIds,
        checkedAt: checkedAt || new Date().toISOString(),
      }));
    }
  } catch {
    /* A helyi lista frissítése hálózati siker esetén memóriában akkor is érvényes. */
  }
  const store = readStore();
  for (const [key, record] of Object.entries(store.byKey)) {
    /*
     * A Supabase útvonal-visszatöltés szándékosan channelKey + countryCode
     * alapján is létrehozhat rekordot channelId nélkül. Ezeket korábban a
     * HU-csatornalista frissítése tévesen törölte, ezért a visszatöltött
     * tanult útvonalak eltűntek a TV-ről és a következő mentésből.
     *
     * Ha van konkrét provider ID, azt továbbra is szigorúan ellenőrizzük.
     * ID nélküli rekordot csak akkor tartunk meg, ha a rekord saját adatai
     * alapján bizonyíthatóan magyar csatornához tartozik.
     */
    const hasChannelId = Boolean(record.channelId);
    const keepRecord = hasChannelId
      ? activeHungarianChannelIds.has(String(record.channelId))
      : isPersistableDoctorRecord(record);
    if (!keepRecord) delete store.byKey[key];
  }
  for (const [id, key] of Object.entries(store.idIndex)) {
    if (!activeHungarianChannelIds.has(id) || !store.byKey[key]) delete store.idIndex[id];
  }
  const target = getStorage();
  if (target) persistStoreNow(store, target);
  else memoryCache = store;
  notifyTvDoctorListeners();
}

function attachLifecycleFlushOnce(): void {
  if (lifecyclePersistAttached || typeof window === 'undefined') return;
  lifecyclePersistAttached = true;
  const flushOnHide = () => {
    flushTvDoctorStore();
  };
  try {
    window.addEventListener('pagehide', flushOnHide);
    window.addEventListener('beforeunload', flushOnHide);
  } catch {
    /* ignore */
  }
}

export function flushTvDoctorStore(storage?: Storage | null): void {
  if (pendingPersistTimer !== null) {
    clearTimeout(pendingPersistTimer);
    pendingPersistTimer = null;
  }
  const store = storage ? readStore(storage) : memoryCache;
  if (!store) return;
  const target = getStorage(storage);
  if (!target) return;
  persistStoreNow(store, target);
}

/**
 * Gyors tárolás: a memóriabeli tudásbázis AZONNAL (<0.05 ms) frissül a villámgyors
 * csatornaváltáshoz, a localStorage sorosítás pedig összevontan (üresjáratban) fut,
 * hogy a csatornaváltás közben SOHA ne fogja meg a TV főszálát.
 * (Ha tesztből explicit `storage` érkezik, azonnal szinkron írja ki.)
 */
function writeStore(store: DoctorStoreData, storage?: Storage | null): void {
  pruneStore(store);
  if (storage !== undefined) {
    const target = getStorage(storage);
    if (target) {
      persistStoreNow(store, target);
    }
    notifyTvDoctorListeners();
    return;
  }

  memoryCache = store;
  attachLifecycleFlushOnce();
  if (pendingPersistTimer === null) {
    pendingPersistTimer = setTimeout(() => {
      pendingPersistTimer = null;
      if (!memoryCache) return;
      const target = getStorage();
      if (target) {
        persistStoreNow(memoryCache, target);
      }
    }, STORE_PERSIST_DEBOUNCE_MS);
  }
  notifyTvDoctorListeners();
}

export function clearTvDoctorMemory(storage?: Storage | null): void {
  if (pendingPersistTimer !== null) {
    clearTimeout(pendingPersistTimer);
    pendingPersistTimer = null;
  }
  memoryCache = createEmptyStore();
  memoryCacheSerializedChars = 0;
  interventionTimestampsByChannel.clear();
  recentDoctorLogs.length = 0;
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(RECENT_DOCTOR_LOGS_STORAGE_KEY); } catch { /* ignore */ }
  opHealth.lastStorageError = null;
  resetTvDoctorOperationCounters();
  const target = getStorage(storage);
  try {
    target?.removeItem(TV_DOCTOR_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  if (isTvDoctorDiagLoggingEnabled()) {
    appLog('TV DOKTOR MEMÓRIA: a helyi tanuló memória és kategória-számlálók 0 állapotra törölve.');
  }
  notifyTvDoctorListeners();
}

export function getTvDoctorCategoryStats(storage?: Storage | null): DoctorCategoryStats {
  const store = readStore(storage);
  return {
    learning: { ...store.categoryStats.learning },
    assistance: { ...store.categoryStats.assistance },
    activation: { ...store.categoryStats.activation },
    channel_error: { ...store.categoryStats.channel_error },
  };
}

/**
 * EPG-leválasztás: a TV Doktor már nem figyeli a műsorújságot.
 * A hívóhely megmarad kompatibilitásból, de nem végez EPG-műveletet.
 */
export async function watchTvDoctorEpg(_params?: unknown): Promise<void> {
  return;
}

export function getTvDoctorMemoryStats(storage?: Storage | null): TvDoctorMemoryStats {
  const store = readStore(storage);
  const learnedChannelCount = Object.values(store.byKey).filter((record) => isPersistableDoctorRecord(record)).length;
  const target = getStorage(storage);

  let doctorStoreBytes = 0;
  let cloudQueueBytes = 0;
  let tvStorageUsedBytes = 0;
  const hasAnyDoctorData =
    learnedChannelCount > 0 ||
    store.categoryStats.learning.count > 0 ||
    store.categoryStats.assistance.count > 0 ||
    store.categoryStats.activation.count > 0 ||
    store.categoryStats.channel_error.count > 0;

  if (target) {
    try {
      const rawDoctor = target.getItem(TV_DOCTOR_STORAGE_KEY);
      if (pendingPersistTimer !== null && !storage && hasAnyDoctorData) {
        const liveSerialized = JSON.stringify(store);
        memoryCacheSerializedChars = liveSerialized.length;
        doctorStoreBytes = (TV_DOCTOR_STORAGE_KEY.length + liveSerialized.length) * 2;
      } else if (rawDoctor) {
        doctorStoreBytes = (TV_DOCTOR_STORAGE_KEY.length + rawDoctor.length) * 2;
      } else if (hasAnyDoctorData) {
        const serializedChars = memoryCacheSerializedChars || JSON.stringify(store).length;
        doctorStoreBytes = (TV_DOCTOR_STORAGE_KEY.length + serializedChars) * 2;
      }
      const rawSync = target.getItem(TV_DOCTOR_SYNC_STORAGE_KEY);
      if (rawSync) {
        cloudQueueBytes = (TV_DOCTOR_SYNC_STORAGE_KEY.length + rawSync.length) * 2;
      }
      const len = Number((target as Storage).length) || 0;
      for (let i = 0; i < len; i += 1) {
        const key = typeof target.key === 'function' ? target.key(i) : null;
        if (!key) continue;
        const val = target.getItem(key) || '';
        tvStorageUsedBytes += (key.length + val.length) * 2;
      }
    } catch {
      /* Egyedi/mock Storage esetén sem dobhat hibát. */
    }
  } else if (hasAnyDoctorData) {
    doctorStoreBytes = JSON.stringify(store).length * 2;
  }

  let inMemoryLogBytes = 0;
  for (let i = 0; i < recentDoctorLogs.length; i += 1) {
    const entry = recentDoctorLogs[i];
    inMemoryLogBytes += ((entry.channelName?.length || 0) + (entry.message?.length || 0) + 28) * 2;
  }

  const doctorTotalBytes = doctorStoreBytes + cloudQueueBytes + inMemoryLogBytes;
  if (tvStorageUsedBytes < doctorStoreBytes + cloudQueueBytes) {
    tvStorageUsedBytes = doctorStoreBytes + cloudQueueBytes;
  }

  const doctorBudgetPercent = Math.min(
    100,
    Math.round((doctorTotalBytes / MAX_SAFE_DOCTOR_STORAGE_BYTES) * 1000) / 10,
  );
  const tvStoragePercent = Math.min(
    100,
    Math.round((tvStorageUsedBytes / WEBOS_LOCAL_STORAGE_QUOTA_BYTES) * 1000) / 10,
  );

  let jsHeapUsedMB: number | null = null;
  let jsHeapLimitMB: number | null = null;
  try {
    const perfMem = typeof performance !== 'undefined' ? (performance as any).memory : null;
    if (perfMem && typeof perfMem.usedJSHeapSize === 'number' && perfMem.usedJSHeapSize > 0) {
      jsHeapUsedMB = Math.round((perfMem.usedJSHeapSize / (1024 * 1024)) * 10) / 10;
    }
    if (perfMem && typeof perfMem.jsHeapSizeLimit === 'number' && perfMem.jsHeapSizeLimit > 0) {
      jsHeapLimitMB = Math.round(perfMem.jsHeapSizeLimit / (1024 * 1024));
    }
  } catch {
    /* Nem minden webOS motor publikálja a performance.memory mezőt. */
  }

  let memoryHealth: TvDoctorMemoryStats['memoryHealth'] = 'optimal';
  let memoryHealthLabel = 'Optimális (1 MB keret) – bőséges szabad hely, nem lassítja a TV-t';
  if (opHealth.lastStorageError || doctorBudgetPercent >= 88 || tvStoragePercent >= 88) {
    memoryHealth = 'high';
    memoryHealthLabel = 'Magas telítettség – javasolt a Memória: 0 gomb megnyomása';
  } else if (doctorBudgetPercent >= 60 || tvStoragePercent >= 70) {
    memoryHealth = 'moderate';
    memoryHealthLabel = 'Mérsékelt foglaltság – normál, biztonságos működés';
  }

  return {
    learnedChannelCount,
    maxLearnedChannels: activeHungarianChannelIds ? activeHungarianChannelCount : MAX_LEARNED_CHANNELS,
    doctorStoreBytes,
    cloudQueueBytes,
    inMemoryLogBytes,
    doctorTotalBytes,
    maxSafeDoctorBytes: MAX_SAFE_DOCTOR_STORAGE_BYTES,
    doctorBudgetPercent,
    tvStorageUsedBytes,
    tvStorageQuotaBytes: WEBOS_LOCAL_STORAGE_QUOTA_BYTES,
    tvStoragePercent,
    jsHeapUsedMB,
    jsHeapLimitMB,
    memoryHealth,
    memoryHealthLabel,
    lastStorageError: opHealth.lastStorageError ? { ...opHealth.lastStorageError } : null,
  };
}

export function getTvDoctorSummary(storage?: Storage | null): {
  learnedChannelCount: number;
  totalVerifiedRepairs: number;
  recentLogs: DoctorLogEntry[];
  categoryStats: DoctorCategoryStats;
} {
  const store = readStore(storage);
  const records = Object.values(store.byKey).filter((record) => isPersistableDoctorRecord(record));
  let totalVerifiedRepairs = 0;
  for (const rec of records) {
    totalVerifiedRepairs += rec.repairsOk || 0;
  }
  return {
    learnedChannelCount: records.length,
    totalVerifiedRepairs,
    recentLogs: recentDoctorLogs.slice(), // 2.5.302: keep all per-category (learning ALL; others 15) – summary returns full buffer
    categoryStats: getTvDoctorCategoryStats(storage),
  };
}

export function isDoctorRecordHandled(rec?: ChannelDoctorRecord | null): boolean {
  if (!rec) return false;
  if (rec.source === 'cloud' || rec.source === 'merged') return true;
  const totalActivity =
    (rec.tsOk || 0) +
    (rec.tsFail || 0) +
    (rec.hlsOk || 0) +
    (rec.hlsFail || 0) +
    (rec.stalls || 0) +
    (rec.repairsOk || 0);
  return totalActivity > 0;
}

export function getChannelDoctorRecord(
  channel?: Pick<Channel, 'id' | 'name' | 'countryCode'> | null,
  storage?: Storage | null,
): ChannelDoctorRecord | null {
  if (!channel) return null;
  const store = readStore(storage);
  if (channel.id && store.idIndex[channel.id]) {
    const byId = store.byKey[store.idIndex[channel.id]];
    // A régi, ID-hez kötött helyi rekord lehet üres, miközben a Supabase-ből
    // visszaállított hu: kulcsú rekord már tartalmaz valós útvonalakat.
    // Az üres ID-rekord ne takarja el a felhőből érkező tanult útvonalakat.
    if (byId && Array.isArray(byId.routes) && byId.routes.length > 0) return byId;
  }
  const key = normalizeChannelDoctorKey(channel);
  if (store.byKey[key]) return store.byKey[key];
  if (channel.id && store.idIndex[channel.id]) {
    const byId = store.byKey[store.idIndex[channel.id]];
    if (byId) return byId;
  }
  // 2.5.310: IPK újraindításkor a csatorna országkódja hiányozhat, de a tanult kulcs hu: előtaggal mentődött – próbáljuk mindkét variánst
  if (key.includes(':')) {
    const withoutPrefix = key.split(':').slice(1).join(':');
    if (withoutPrefix && store.byKey[withoutPrefix]) return store.byKey[withoutPrefix];
  }
  if (!key.startsWith('hu:')) {
    const withHu = `hu:${key}`;
    if (store.byKey[withHu]) return store.byKey[withHu];
  }
  return null;
}

export function isChannelHandledByDoctor(
  channel?: Pick<Channel, 'id' | 'name' | 'countryCode'> | null,
  storage?: Storage | null,
): boolean {
  const rec = getChannelDoctorRecord(channel, storage);
  return isDoctorRecordHandled(rec);
}

export function getVodDoctorRecord(
  _target?: VodDoctorTarget | null,
  _storage?: Storage | null,
): ChannelDoctorRecord | null {
  return null;
}

export function isVodHandledByDoctor(
  _target?: VodDoctorTarget | null,
  _storage?: Storage | null,
): boolean {
  return false;
}

function defaultCategoryForLevel(level: DoctorLogEntry['level']): DoctorEventCategory {
  if (level === 'error') return 'channel_error';
  if (level === 'warn') return 'activation';
  if (level === 'repair' || level === 'verified') return 'assistance';
  return 'learning';
}

function recordCategoryTick(
  store: DoctorStoreData,
  category: DoctorEventCategory,
  channelName: string,
  at: number,
  keepChannelName = true,
): void {
  const bucket = store.categoryStats[category];
  bucket.count += 1;
  bucket.lastAt = at;
  /*
   * 2.5.294: a nem magyar csatorna NEVE sem kerülhet a tartós tárolóba – a
   * kategória-számláló csak a darabszámot és az időt őrzi meg ilyenkor.
   */
  if (keepChannelName) {
    bucket.lastChannelName = channelName.slice(0, 120);
  } else if (bucket.lastChannelName) {
    bucket.lastChannelName = null;
  }
}

function logDoctor(
  level: DoctorLogEntry['level'],
  channel: (Pick<Channel, 'id' | 'name'> & { countryCode?: string }) | null | undefined,
  message: string,
  explicitCategory?: DoctorEventCategory,
  storage?: Storage | null,
): void {
  const at = Date.now();
  const category = explicitCategory || defaultCategoryForLevel(level);
  const channelKey = normalizeChannelDoctorKey(channel);
  const channelName = String(channel?.name || channel?.id || 'Rendszer');

  const store = readStore(storage);
  // A TV-s összesítőben a Segítség/Javítás kategória kizárólag igazolt sikeres javításokat mutat.
  // A próbálkozások részletei csak a külön, kézzel indított TV Doktor naplóba kerülnek.
  if (category === 'assistance' && level === 'verified') {
    markLatestRepairOutcome(channelKey, at, true);
  }
  const includeInSummary = category !== 'assistance' || level === 'verified';
  if (includeInSummary) {
    recordCategoryTick(store, category, channelName, at, isHungarianDoctorChannel({
      id: channel?.id,
      countryCode: channel?.countryCode,
      name: channelName,
    }));

    const cloudEligible = Boolean(cloudLogHook && channel?.id && isPersistableDoctorRecord({
      channelId: String(channel.id),
      channelKey,
      channelName,
      countryCode: channel.countryCode,
    }));
    const eventUid = cloudEligible ? `lg-${at.toString(36)}-${Math.random().toString(36).slice(2, 12)}` : undefined;
    recentDoctorLogs.push({
      eventUid,
      channelId: channel?.id ? String(channel.id) : undefined,
      at,
      level,
      category,
      channelKey,
      channelName,
      message,
    });
    if (cloudEligible && cloudLogHook) {
      try {
        cloudLogHook({ eventUid, at, level, category, channelKey, channelId: String(channel!.id), channelName, message });
      } catch {
        /* a felhőnapló soha nem szakíthatja meg a lejátszást */
      }
    }

    // Kategóriánként 8 bejegyzés marad; a javításoknál a legjobb eredményű próbák.
    trimDoctorCategoryLogs(category);
    // safety: never let global buffer grow unbounded (> 800)
    if (recentDoctorLogs.length > 800) {
      recentDoctorLogs.splice(0, recentDoctorLogs.length - 800);
    }
    persistRecentDoctorLogs();
  }
  if (isTvDoctorDiagLoggingEnabled()) {
    const tag =
      category === 'learning'
        ? 'TANULÁS'
        : category === 'assistance'
          ? 'SEGÍTSÉG/JAVÍTÁS'
          : category === 'activation'
            ? 'AKTIVÁLÓDÁS'
              : 'CSATORNAHIBA';
    appLog(`TV DOKTOR [${tag}] [${channelName}] ${message}`);
  }
  writeStore(store, storage);
}

/**
 * Sebesség- és megbízhatósági pontszám alapján kiválasztja a legjobb formátumot,
 * kiemelt védelemmel a legutóbb ténylegesen működő formátum számára (pl. M2 UHD TS eset:
 * SOHA nem vált vissza egy sorozatosan hibázó HLS-re közvetlenül egy sikeres TS lejátszás után!).
 */
export function pickFastestReliableFormat(
  record: ChannelDoctorRecord,
  fallbackFormat: LiveFormat,
): LiveFormat {
  const tsOk = Math.max(0, record.tsOk || 0);
  const tsFail = Math.max(0, record.tsFail || 0);
  const hlsOk = Math.max(0, record.hlsOk || 0);
  const hlsFail = Math.max(0, record.hlsFail || 0);
  const tsTotal = tsOk + tsFail;
  const hlsTotal = hlsOk + hlsFail;

  if (tsTotal === 0 && hlsTotal === 0) {
    return record.lastWorkingFormat || record.bestFormat || fallbackFormat;
  }

  // 1. Ha csak az egyik formátum tudott valaha elindulni, KIZÁRÓLAG azt választjuk!
  if (tsOk === 0 && hlsOk > 0) return 'hls';
  if (hlsOk === 0 && tsOk > 0) return 'ts';
  if (tsOk === 0 && hlsOk === 0) {
    if (tsFail !== hlsFail) return tsFail < hlsFail ? 'ts' : 'hls';
    return fallbackFormat;
  }

  const tsConsecFail = Math.max(0, record.tsConsecutiveFail || 0);
  const hlsConsecFail = Math.max(0, record.hlsConsecutiveFail || 0);

  // 2. Ha van legutóbb igazoltan elindult formátum, és a MÁSIK formátum a legutóbbi próbáján
  //    elbukott (consecutiveFail > 0), akkor SOHA nem írjuk felül a működő formátumot a hibással!
  if (record.lastWorkingFormat === 'ts' && tsConsecFail === 0 && hlsConsecFail > 0) {
    return 'ts';
  }
  if (record.lastWorkingFormat === 'hls' && hlsConsecFail === 0 && tsConsecFail > 0) {
    return 'hls';
  }

  // Csak valódi, sikeres mérésből származó indulási átlag vehet részt a sebességpontozásban.
  const validTsMs = tsOk > 0 && record.tsAvgStartupMs !== null && record.tsAvgStartupMs > 20
    ? record.tsAvgStartupMs
    : null;
  const validHlsMs = hlsOk > 0 && record.hlsAvgStartupMs !== null && record.hlsAvgStartupMs > 20
    ? record.hlsAvgStartupMs
    : null;

  const tsReliability = (tsOk + 0.5) / (tsTotal + 1);
  const hlsReliability = (hlsOk + 0.5) / (hlsTotal + 1);

  // Egymást követő friss hibák erős büntetése
  const tsRecentPenalty = Math.min(0.45, tsConsecFail * 0.18);
  const hlsRecentPenalty = Math.min(0.45, hlsConsecFail * 0.18);

  // Indulási sebesség bónusz (erősebb súly a valóban gyors csatornaváltásért)
  const tsSpeedBonus = validTsMs !== null ? Math.max(0, (4200 - validTsMs) / 9500) : 0;
  const hlsSpeedBonus = validHlsMs !== null ? Math.max(0, (4200 - validHlsMs) / 9500) : 0;

  // Kis stabilitási előny a legutóbb ténylegesen működő formátumnak, ha közel azonosak
  const tsLastBonus = record.lastWorkingFormat === 'ts' && tsConsecFail === 0 ? 0.05 : 0;
  const hlsLastBonus = record.lastWorkingFormat === 'hls' && hlsConsecFail === 0 ? 0.05 : 0;

  const tsScore = tsReliability - tsRecentPenalty + tsSpeedBonus + tsLastBonus;
  const hlsScore = hlsReliability - hlsRecentPenalty + hlsSpeedBonus + hlsLastBonus;

  if (Math.abs(tsScore - hlsScore) < 0.03) {
    if (validTsMs !== null && validHlsMs !== null) {
      return validHlsMs + 80 < validTsMs ? 'hls' : 'ts';
    }
    return record.lastWorkingFormat || record.bestFormat || fallbackFormat;
  }

  return hlsScore > tsScore ? 'hls' : 'ts';
}

/** Pufferprofil pontozás: indulási idő + megakadásmentesség + stabilitás alapján. */
export function evaluateBestBufferProfile(
  bufferStats: Partial<Record<DoctorBufferProfileId, BufferProfileStats>>,
  fallback: DoctorBufferProfileId,
): DoctorBufferProfileId {
  let bestId: DoctorBufferProfileId = fallback;
  let bestScore = -Infinity;

  for (const profileId of DOCTOR_BUFFER_ORDER) {
    const st = bufferStats[profileId];
    if (!st) continue;
    const total = st.ok + st.fail;
    if (total <= 0 || st.ok <= 0) continue;

    const reliability = st.ok / total;
    const stallRatio = st.stalls / Math.max(1, st.ok);
    const stallPenalty = Math.min(0.8, stallRatio * 0.45);
    const speedBonus = st.avgStartupMs !== null && st.avgStartupMs > 20
      ? Math.max(0, (4500 - st.avgStartupMs) / 14000)
      : 0;
    const idx = DOCTOR_BUFFER_ORDER.indexOf(profileId);
    const agilityBonus = st.stalls === 0 && st.fail === 0
      ? Math.max(0, (DOCTOR_BUFFER_ORDER.length - 1 - idx) * 0.018)
      : 0;

    const score = reliability - stallPenalty + speedBonus + agilityBonus;
    if (score > bestScore) {
      bestScore = score;
      bestId = profileId;
    }
  }

  return bestId;
}

/**
 * 1. Villámgyors csatornaváltás: előre kiválasztja az adott csatornához
 * leggyorsabban induló, igazoltan stabil formátumot, a kalibrált gyors
 * indulási őrt és a közvetlen gyorsindítási módot.
 */
export function selectChannelLaunchPlan(
  channel: Channel | null | undefined,
  streamUrl: string,
  settings: Pick<AppSettings, 'streamFormat' | 'bufferMode' | 'tvDoctorEnabled'>,
  storage?: Storage | null,
): ChannelLaunchPlan {
  const startedAt = nowPerfMs();
  const configuredFormat: LiveFormat = settings.streamFormat === 'hls' ? 'hls' : 'ts';
  const sourceFormat = formatOfUrl(streamUrl);
  const tsCandidate = urlWithFormat(streamUrl, 'ts');
  const hlsCandidate = urlWithFormat(streamUrl, 'hls');
  const supportsDualFormat = Boolean(tsCandidate && hlsCandidate && tsCandidate !== hlsCandidate);
  const baseBufferMode: BufferMode = settings.bufferMode || 'balanced';
  const defaultTiming = bufferProfileTiming(baseBufferMode);
  const channelKey = normalizeChannelDoctorKey(channel);
  const baselineProfile = getDoctorBaseline(channel, storage);
  const legacyFormat = !storage ? rememberedFormatFor(channel?.id) : null;

  const fallbackPrimary: LiveFormat = legacyFormat || (sourceFormat === 'hls' ? 'hls' : configuredFormat);
  const enabled = settings.tvDoctorEnabled !== false;

  if (!enabled || !channel) {
    return {
      enabled: false,
      hasLearnedProfile: false,
      directFastStart: false,
      skipSameFormatRetry: false,
      isRecentlyDead: false,
      maxRepairSteps: MAX_DOCTOR_REPAIR_STEPS,
      channelKey,
      primaryFormat: fallbackPrimary,
      alternateFormat: supportsDualFormat ? (fallbackPrimary === 'hls' ? 'ts' : 'hls') : null,
      bufferProfileId: baseBufferMode,
      bufferTiming: defaultTiming,
      expectedStartupMs: null,
      reason: 'alapértelmezett lejátszási mód',
    };
  }

  opHealth.decisionsCount += 1;

  try {
    const record = getChannelDoctorRecord(channel, storage);
    if (!record && baselineProfile) {
      const baselineTiming = clampBufferTiming(baselineProfile.bufferTiming);
      const plan: ChannelLaunchPlan = {
        enabled: true,
        hasLearnedProfile: false,
        hasBaselineProfile: true,
        baselineProfile,
        directFastStart: false,
        skipSameFormatRetry: true,
        isRecentlyDead: false,
        maxRepairSteps: MAX_DOCTOR_REPAIR_STEPS,
        channelKey,
        primaryFormat: baselineProfile.format,
        alternateFormat: supportsDualFormat ? (baselineProfile.format === 'hls' ? 'ts' : 'hls') : null,
        bufferProfileId: baselineProfile.bufferProfile,
        bufferTiming: baselineTiming,
        expectedStartupMs: baselineProfile.startupMs,
        reason: '1-es rögzített alapbeállítás',
      };
      recordDoctorOpTiming('selectChannelLaunchPlan', nowPerfMs() - startedAt, channel.name);
      return plan;
    }
    if (!record) {
      // Még nem ismert csatornánál is gyorsabb indulási őrt adunk, hogy egy
      // nem válaszoló első formátum ne tartsa vissza másodpercekig a másodikat!
      const fastDiscoveryTiming = clampBufferTiming({
        ...defaultTiming,
        startupWatchdogMs: Math.min(defaultTiming.startupWatchdogMs, 1200),
        retryMs: Math.min(defaultTiming.retryMs, 90),
      });
      const plan: ChannelLaunchPlan = {
        enabled: true,
        hasLearnedProfile: false,
        directFastStart: false,
        skipSameFormatRetry: true,
        isRecentlyDead: false,
        maxRepairSteps: MAX_DOCTOR_REPAIR_STEPS,
        channelKey,
        primaryFormat: fallbackPrimary,
        alternateFormat: supportsDualFormat ? (fallbackPrimary === 'hls' ? 'ts' : 'hls') : null,
        bufferProfileId: baseBufferMode,
        bufferTiming: fastDiscoveryTiming,
        expectedStartupMs: null,
        reason: legacyFormat ? `korábbi formátummemória (${legacyFormat})` : 'első gyors felmérés ezen a csatornán',
      };
      const elapsed = nowPerfMs() - startedAt;
      recordDoctorOpTiming('selectChannelLaunchPlan', elapsed, channel.name);
      if (isVerbosePlaybackLogging() && isTvDoctorDiagLoggingEnabled()) {
        appLog(
          `TV DOKTOR DÖNTÉS [${channel.name || channelKey}]: mód=${plan.primaryFormat.toUpperCase()}; puffer=${plan.bufferProfileId}; ok=${plan.reason}; számítás=${Math.round(elapsed * 10) / 10}ms`,
        );
      }
      return plan;
    }

    const now = Date.now();
    const isRecentlyDead = Boolean(record.deadUntil && record.deadUntil > now);
    const totalLifetimeOk = (record.tsOk || 0) + (record.hlsOk || 0);
    /*
     * 2.5.277 (#17-es napló, NAT GEO WILD UHD): kézi újraválasztásnál a halott
     * jelölés AZONNAL törlődik, ha a csatorna korábban már működött – a
     * csatorna „önmagától is” újraindulhat, a doktor ezt nem blokkolhatja.
     * A flapping ellen NEM ez, hanem az újraaktiválási hűtő védekezik lásd lejjebb.
     */
    if (isRecentlyDead && totalLifetimeOk > 0) {
      record.deadUntil = undefined;
      record.updatedAt = now;
      /* 2.5.277: explicit storage-nál a readStore új objektumot ad – a módosítást
         ugyanabba a store-ba kell írni, amelyikből olvastunk, majd menteni. */
      try {
        const store2 = readStore(storage);
        const rec2 = store2.byKey[channelKey];
        if (rec2) {
          rec2.deadUntil = undefined;
          rec2.updatedAt = now;
        }
        writeStore(store2, storage);
      } catch { /* a jelölés törlése mentés nélkül is biztonságos */ }
    }
    /*
     * 2.5.277 (#17-es napló, ARENA 4): újraaktiválási hűtő – egy kimerült létra
     * után DOCTOR_REACTIVATION_COOLDOWN_MS-ig óvatosabb indítási mód marad aktív,
     * akár törölve lett is a halott jelölés. A javítási létra közben is 8 lépéses marad.
     */
    const inReactivationCooldown = Boolean(
      record.lastExhaustedAt && now - record.lastExhaustedAt < DOCTOR_REACTIVATION_COOLDOWN_MS,
    );
    const inCooldown = isRecentlyDead || inReactivationCooldown;
    const maxRepairSteps = inCooldown
      ? MAX_DEAD_CHANNEL_QUICK_STEPS
      : MAX_DOCTOR_REPAIR_STEPS;

    const learnedFormat = supportsDualFormat
      ? pickFastestReliableFormat(record, fallbackPrimary)
      : fallbackPrimary;
    // Egyetlen korábbi siker (különösen régi/hibás mérés) még nem írhatja felül
    // az aktuális forrás/beállítás formátumát. Legalább két valós indulás kell.
    const learnedFormatSuccesses = learnedFormat === 'hls'
      ? Math.max(0, record.hlsOk || 0)
      : Math.max(0, record.tsOk || 0);
    const tsSuccesses = Math.max(0, record.tsOk || 0);
    const hlsSuccesses = Math.max(0, record.hlsOk || 0);
    const stableFormat: LiveFormat = tsSuccesses >= hlsSuccesses ? 'ts' : 'hls';
    const stableFormatSuccesses = stableFormat === 'hls' ? hlsSuccesses : tsSuccesses;
    const alternateFormat: LiveFormat = stableFormat === 'hls' ? 'ts' : 'hls';
    const alternateSuccesses = alternateFormat === 'hls' ? hlsSuccesses : tsSuccesses;
    const alternateFailures = alternateFormat === 'hls'
      ? Math.max(0, record.hlsFail || 0)
      : Math.max(0, record.tsFail || 0);

    /*
     * A tanult útvonal az elsődleges. Alternatív formátumot csak addig mérünk,
     * amíg nincs megbízható, csatornaspecifikus útvonal. Ha már van ilyen,
     * nem szakítjuk meg az indulást időszakos TS/HLS-próbával.
     */
    const baselineRouteId = baselineProfile
      ? doctorRouteId(baselineProfile.format, baselineProfile.bufferProfile)
      : null;
    const bestLearnedRoute = baselineProfile
      ? (learnedRouteCandidates(record, baselineRouteId)[0] || null)
      : learnedRouteFor(record);
    // A baseline-tól eltérő útvonal csak legalább két hibátlan, gyorsabb mérés után veheti át az első helyet.
    const learnedRouteBetterThanBaseline = Boolean(
      baselineProfile && bestLearnedRoute
      && bestLearnedRoute.id !== baselineRouteId
      && bestLearnedRoute.ok >= 2
      && bestLearnedRoute.fail === 0
      && bestLearnedRoute.stalls === 0
      && (baselineProfile.startupMs === null
        || (bestLearnedRoute.avgStartupMs !== null && bestLearnedRoute.avgStartupMs < baselineProfile.startupMs)),
    );
    const useBaselineAsPrimary = Boolean(baselineProfile && !learnedRouteBetterThanBaseline);
    const routeReliable = Boolean(
      bestLearnedRoute
      && bestLearnedRoute.ok >= 1
      && (bestLearnedRoute.format === fallbackPrimary || supportsDualFormat),
    );
    const shouldProbeAlternateFormat = supportsDualFormat
      && !baselineProfile
      && !inCooldown
      // Ha már van legalább egy sikeres, használható csatornasaját útvonal,
      // azt választjuk; nem szakítjuk meg az indulást alternatív formátumpróbával.
      && !routeReliable
      && alternateSuccesses === 0
      && alternateFailures === 0
      && stableFormatSuccesses >= 1;
    const chosenFormatBase: LiveFormat = shouldProbeAlternateFormat
      ? alternateFormat
      // 2.5.310: már 1 igazolt siker is elég, hogy a tanult formátumot ne írja felül a fallback (IPK újraindítás után azonnal éljen a tudás)
      : (supportsDualFormat && learnedFormatSuccesses >= 1 ? learnedFormat : fallbackPrimary);

    // Ha a tanulási létra egy gyorsabb pufferprofilt jelölt ki, de azt
    // még nem próbáltuk, a következő indításkor ténylegesen azt kell kipróbálni.
    // Korábban az értékelő csak a régi profilokból választott, ezért a
    // balanced -> fast -> turbo -> instant gyorsítás a gyakorlatban megakadt.
    const storedBestBufferProfile = record.bestBufferProfile
      || record.lastWorkingBufferProfile
      || baseBufferMode;
    const storedProfileStats = record.bufferStats[storedBestBufferProfile];
    const chosenBufferProfileBase = storedProfileStats && storedProfileStats.ok > 0
      ? evaluateBestBufferProfile(record.bufferStats, storedBestBufferProfile)
      : storedBestBufferProfile;
    // A kötelező egyszeri alternatív formátumpróbát a csillagos tanult útvonal
    // sem írhatja felül. A próba után ismét a legjobb tanult útvonal az első.
    const chosenFormat: LiveFormat = useBaselineAsPrimary && baselineProfile
      ? baselineProfile.format
      : shouldProbeAlternateFormat
        ? chosenFormatBase
        : (routeReliable && bestLearnedRoute ? bestLearnedRoute.format : chosenFormatBase);
    // Próba közben a stabil alap-pufferrel mérünk; egyébként a tanult útvonal
    // saját pufferprofilját tartjuk meg. Az 1-es profil pontos időzítése változatlan.
    const chosenBufferProfile: DoctorBufferProfileId = useBaselineAsPrimary && baselineProfile
      ? baselineProfile.bufferProfile
      : shouldProbeAlternateFormat
        ? chosenBufferProfileBase
        : (routeReliable && bestLearnedRoute ? bestLearnedRoute.bufferProfile : chosenBufferProfileBase);

    // Szinkronban tartjuk a VideoPlayer helyi formátum-emlékével is (csak ha a TV Doktor be van kapcsolva!).
    if (channel.id && !storage && totalLifetimeOk > 0) {
      rememberFormatFor(channel.id, chosenFormat);
    }

    const hasCustomBufferExperience =
      Object.keys(record.bufferStats || {}).length > 0 ||
      record.source === 'cloud' ||
      record.stalls > 0 ||
      record.repairsOk > 0 ||
      totalLifetimeOk > 0;

    const doctorCfg = getDoctorBufferConfig(chosenBufferProfile);
    const rawExpectedMs = useBaselineAsPrimary && baselineProfile
      ? baselineProfile.startupMs
      : !shouldProbeAlternateFormat && routeReliable && bestLearnedRoute && bestLearnedRoute.avgStartupMs !== null
        ? bestLearnedRoute.avgStartupMs
        : (chosenFormat === 'hls' ? record.hlsAvgStartupMs : record.tsAvgStartupMs);
    const expectedStartupMs = rawExpectedMs !== null && rawExpectedMs > 20 ? rawExpectedMs : null;

    const chosenOkCount = chosenFormat === 'hls' ? record.hlsOk : record.tsOk;
    const chosenConsecFail = chosenFormat === 'hls' ? (record.hlsConsecutiveFail || 0) : (record.tsConsecutiveFail || 0);
    // Hűtőben nincs közvetlen gyorsindítás; a hibajavítás ettől függetlenül 8 lépéses marad.
    const directFastStart = !useBaselineAsPrimary && !isRecentlyDead && !inReactivationCooldown && chosenOkCount >= 1 && chosenConsecFail === 0;

    // Kalibrált indulási őr: ha a csatorna pl. 450 ms alatt szokott indulni,
    // nem várunk 2000 ms-ot hiba esetén, hanem ~900 ms után már lépünk is!
    const calibratedWatchdogMs = expectedStartupMs !== null && directFastStart
      ? Math.max(
          MIN_SAFE_STARTUP_WATCHDOG_MS,
          Math.min(doctorCfg.startupWatchdogMs, Math.round(expectedStartupMs * 1.55 + 220)),
        )
      : doctorCfg.startupWatchdogMs;

    const chosenTiming: BufferProfileTiming = useBaselineAsPrimary && baselineProfile
      ? clampBufferTiming(baselineProfile.bufferTiming)
      : hasCustomBufferExperience
      ? clampBufferTiming({
          ...doctorCfg,
          startupWatchdogMs: calibratedWatchdogMs,
          retryMs: directFastStart ? Math.min(doctorCfg.retryMs, 75) : doctorCfg.retryMs,
          minBufferAheadSeconds: record.bestBufferProfile === chosenBufferProfile
            ? record.bestBufferAheadSeconds
            : doctorCfg.minBufferAheadSeconds,
        })
      : defaultTiming;

    const plan: ChannelLaunchPlan = {
      enabled: true,
      hasLearnedProfile: true,
      hasBaselineProfile: Boolean(baselineProfile),
      baselineProfile,
      directFastStart,
      skipSameFormatRetry: true,
      isRecentlyDead: inCooldown,
      maxRepairSteps,
      channelKey,
      primaryFormat: chosenFormat,
      alternateFormat: supportsDualFormat ? (chosenFormat === 'hls' ? 'ts' : 'hls') : null,
      bufferProfileId: hasCustomBufferExperience ? chosenBufferProfile : baseBufferMode,
      bufferTiming: chosenTiming,
      expectedStartupMs,
      reason: useBaselineAsPrimary
        ? '1-es rögzített alapbeállítás – tanult profil nem bizonyult bizonyítottan jobbnak'
        : shouldProbeAlternateFormat
          ? `időszakos formátum-sebességpróba (${chosenFormat.toUpperCase()})`
          : inCooldown
          ? (inReactivationCooldown
            ? `újraaktiválási hűtőben (${Math.max(1, Math.round((DOCTOR_REACTIVATION_COOLDOWN_MS - (now - (record.lastExhaustedAt || now))) / 60000))} perc hátra) – teljes (${maxRepairSteps} lépéses) javítási létra`
            : `korábban nem működő csatorna – teljes (${maxRepairSteps} lépéses) javítási létra`)
          : `tanult gyorsprofil (${chosenFormat.toUpperCase()}, puffer=${chosenBufferProfile}${expectedStartupMs ? `, ~${expectedStartupMs}ms` : ''}${routeReliable ? `, ${Math.min(MAX_CHANNEL_ROUTES, (record.routes || []).length)} tanult útvonalból a legjobb` : ''})`,
    };
    const elapsed = nowPerfMs() - startedAt;
    recordDoctorOpTiming('selectChannelLaunchPlan', elapsed, channel.name);
    if (isVerbosePlaybackLogging() && isTvDoctorDiagLoggingEnabled()) {
      appLog(
        `TV DOKTOR DÖNTÉS [${channel.name || channelKey}]: mód=${plan.primaryFormat.toUpperCase()}; puffer=${plan.bufferProfileId} (${plan.bufferTiming.minBufferAheadSeconds}mp); őr=${plan.bufferTiming.startupWatchdogMs}ms; gyorsindítás=${directFastStart ? 'IGEN' : 'nem'}; ok=${plan.reason}; számítás=${Math.round(elapsed * 10) / 10}ms`,
      );
    }
    return plan;
  } catch (err) {
    if (isTvDoctorDiagLoggingEnabled()) {
      appLog(
        `TV DOKTOR HIBA [hely=selectChannelLaunchPlan; csatorna=${channel.name || channelKey}]: biztonsági visszaállás (${String(err).slice(0, 80)})`,
      );
    }
    return {
      enabled: false,
      hasLearnedProfile: false,
      directFastStart: false,
      skipSameFormatRetry: false,
      isRecentlyDead: false,
      maxRepairSteps: MAX_DOCTOR_REPAIR_STEPS,
      channelKey,
      primaryFormat: fallbackPrimary,
      alternateFormat: supportsDualFormat ? (fallbackPrimary === 'hls' ? 'ts' : 'hls') : null,
      bufferProfileId: baseBufferMode,
      bufferTiming: defaultTiming,
      expectedStartupMs: null,
      reason: 'biztonsági visszaállás',
    };
  }
}

function ewma(prev: number | null, sample: number): number {
  const clamped = Math.max(25, Math.min(60000, Math.round(sample)));
  if (prev === null || !Number.isFinite(prev) || prev <= 20) return clamped;
  // A friss mérés erősebb súlyt kap (0.45), hogy a csatorna aktuális sebességét gyorsan megtanulja.
  return Math.round(prev * 0.55 + clamped * 0.45);
}

function getOrCreateRecord(
  store: DoctorStoreData,
  channel: Pick<Channel, 'id' | 'name' | 'countryCode'>,
  defaultFormat: LiveFormat,
  defaultBuffer: DoctorBufferProfileId,
): ChannelDoctorRecord {
  const channelKey = normalizeChannelDoctorKey(channel);
  let rec = (channel.id && store.idIndex[channel.id] ? store.byKey[store.idIndex[channel.id]] : null)
    || store.byKey[channelKey];

  if (!rec) {
    rec = {
      channelKey,
      channelId: channel.id,
      channelName: String(channel.name || channel.id || channelKey).slice(0, 140),
      countryCode: channel.countryCode,
      bestFormat: defaultFormat,
      bestBufferProfile: defaultBuffer,
      bestBufferAheadSeconds: getDoctorBufferConfig(defaultBuffer).minBufferAheadSeconds,
      tsAvgStartupMs: null,
      hlsAvgStartupMs: null,
      bestStartupMs: null,
      tsOk: 0,
      tsFail: 0,
      tsConsecutiveFail: 0,
      hlsOk: 0,
      hlsFail: 0,
      hlsConsecutiveFail: 0,
      consecutiveCleanStarts: 0,
      consecutiveFailures: 0,
      stalls: 0,
      repairsOk: 0,
      bufferStats: {},
      source: 'local',
      updatedAt: Date.now(),
    };
    store.byKey[channelKey] = rec;
  }

  if (channel.id) {
    rec.channelId = channel.id;
    store.idIndex[channel.id] = rec.channelKey;
  }
  if (channel.name) rec.channelName = String(channel.name).slice(0, 140);
  if (channel.countryCode) rec.countryCode = channel.countryCode;
  /*
   * 2.5.294: országkód nélküli, de magyarnak látszó csatornát is magyarként
   * jelölünk – csak a magyar csatornák tudása őrződik meg tartósan.
   */
  if (!String(rec.countryCode || '').toUpperCase() && isHungarianDoctorChannel(channel)) {
    rec.countryCode = 'HU';
  }
  return rec;
}

/**
 * Sikeres csatornaindulás rögzítése: pontosan elmenti az éppen sikeresen elindult
 * formátumot és pufferprofilt (`lastWorkingFormat` + `bestFormat`), és akadásmentes
 * csatornáknál fokozatosan gyorsabb profilra (`balanced -> fast -> turbo -> instant`) léptet.
 */
export function recordDoctorChannelSuccess(params: {
  channel?: Pick<Channel, 'id' | 'name' | 'countryCode'> | null;
  format: LiveFormat;
  bufferProfile: DoctorBufferProfileId;
  startupMs: number;
  wasRepair?: boolean;
  storage?: Storage | null;
}): ChannelDoctorRecord | null {
  const { channel, format, bufferProfile, startupMs, wasRepair = false, storage } = params;
  if (!channel) return null;
  // 2.5.298: csak magyar csatornáról tanulunk tartósan – a kedvencekben lévő
  // külföldi adók (pl. GB/DE) kizárva. A segítés (gyors indítás) megmarad,
  // de memóriát és felhő-forgalmat nem generálunk róluk.
  if (!isHungarianDoctorChannel({ id: (channel as any).id, countryCode: (channel as any).countryCode, name: (channel as any).name })) {
    return null;
  }

  try {
    const store = readStore(storage);
    const rec = getOrCreateRecord(store, channel, format, bufferProfile);
    const wasFirstSample = (rec.tsOk + rec.tsFail + rec.hlsOk + rec.hlsFail) === 0;
    const prevBestFormat = rec.bestFormat;
    const prevBestBuffer = rec.bestBufferProfile;
    const safeMs = Math.max(25, Math.min(60000, Math.round(startupMs)));

    if (format === 'hls') {
      rec.hlsOk += 1;
      rec.hlsConsecutiveFail = 0;
      rec.hlsAvgStartupMs = ewma(rec.hlsAvgStartupMs, safeMs);
    } else {
      rec.tsOk += 1;
      rec.tsConsecutiveFail = 0;
      rec.tsAvgStartupMs = ewma(rec.tsAvgStartupMs, safeMs);
    }

    // Pontosan megjegyezzük, hogyan indult el sikeresen legutóbb a csatorna!
    rec.lastWorkingFormat = format;
    rec.lastWorkingBufferProfile = bufferProfile;
    rec.lastWorkingStartupMs = safeMs;
    rec.consecutiveFailures = 0;
    rec.deadUntil = undefined;
    // Valódi siker minden korábbi kimerülési/hűtési állapotot érvénytelenít.
    // A lastExhaustedAt különben a siker után is 8 percig rövid javítási
    // létrán tartaná a csatornát, és a Doktor figyelmen kívül hagyná a friss mérést.
    rec.lastExhaustedAt = undefined;
    rec.haltCount = 0;
    // A korábbi „nem működik” jelzés többé nem érvényes, ha a stream ténylegesen elindult.
    if (rec.lastErrorCode === 'CHANNEL_UNREACHABLE') {
      rec.lastErrorCode = undefined;
      rec.lastErrorReason = undefined;
    }
    rec.consecutiveCleanStarts = wasRepair ? 1 : (rec.consecutiveCleanStarts || 0) + 1;

    rec.bestStartupMs = rec.bestStartupMs === null || rec.bestStartupMs <= 20
      ? safeMs
      : Math.min(rec.bestStartupMs, safeMs);
    if (wasRepair) {
      rec.repairsOk += 1;
      opHealth.repairsVerifiedCount += 1;
    }

    const prevBuf = rec.bufferStats[bufferProfile] || { ok: 0, fail: 0, stalls: 0, avgStartupMs: null };
    const nextBuf: BufferProfileStats = {
      ok: prevBuf.ok + 1,
      fail: prevBuf.fail,
      stalls: prevBuf.stalls,
      avgStartupMs: ewma(prevBuf.avgStartupMs, safeMs),
    };
    rec.bufferStats[bufferProfile] = nextBuf;

    // Automatikus gyorsítási létra akadásmentes csatornákon:
    //  - balanced -> fast (ha gyors és nincs stall)
    //  - fast -> turbo (3 hibátlan indulás után)
    //  - turbo -> instant (3 hibátlan turbó indulás után)
    if (!wasRepair && rec.stalls === 0 && nextBuf.stalls === 0 && nextBuf.fail === 0) {
      if (bufferProfile === 'balanced' && safeMs <= 1450 && nextBuf.ok >= 2 && !rec.bufferStats.fast) {
        rec.bestBufferProfile = 'fast';
      } else if (bufferProfile === 'fast' && safeMs <= 1450 && nextBuf.ok >= 3 && !rec.bufferStats.turbo) {
        rec.bestBufferProfile = 'turbo';
      } else if (bufferProfile === 'turbo' && safeMs <= 1050 && nextBuf.ok >= 3 && !rec.bufferStats.instant) {
        rec.bestBufferProfile = 'instant';
      } else {
        rec.bestBufferProfile = evaluateBestBufferProfile(rec.bufferStats, bufferProfile);
      }
    } else {
      rec.bestBufferProfile = evaluateBestBufferProfile(rec.bufferStats, bufferProfile);
    }
    rec.bestBufferAheadSeconds = getDoctorBufferConfig(rec.bestBufferProfile).minBufferAheadSeconds;

    /*
     * 2.5.294: MINDEN ADÁSBÓL TANULUNK – a sikeres indulás bekerül a csatorna
     * saját útvonal-táblájába (formátum + pufferprofil együtt mérve).
     * A 2–8. tanult helyekre kerül; az 1-es alapútvonal külön vész-tartalék.
     */
    const baseline = getDoctorBaseline(channel, storage);
    const routeResult = recordDoctorRouteOutcome({
      record: rec,
      excludeRouteId: baseline ? doctorRouteId(baseline.format, baseline.bufferProfile) : null,
      format,
      bufferProfile,
      outcome: 'ok',
      startupMs: safeMs,
    });
    if (routeResult?.isNew && routeResult.route.ok === 1) {
      logDoctor(
        'info',
        channel,
        `Új tanult útvonal: ${format.toUpperCase()} + ${bufferProfile} (${safeMs} ms) – `
        + `${Math.min(MAX_CHANNEL_ROUTES, (rec.routes || []).length)}/${MAX_CHANNEL_ROUTES} útvonal a csatorna memóriájában`
        + (routeResult.dropped ? `; kiesett a leggyengébb: ${routeResult.dropped.id}` : '') + '.',
        'learning',
        storage,
      );
    }

    rec.bestFormat = pickFastestReliableFormat(rec, format);
    rec.source = rec.source === 'cloud' ? 'merged' : 'local';
    rec.updatedAt = Date.now();

    if (channel.id && !storage) {
      rememberFormatFor(channel.id, rec.bestFormat);
    }

    // A rekordot SZERENCSEM el kell menteni a storage-ba minden sikeres
    // mérést követően (első minta, javítás és profilváltozás is egyaránt),
    // különben a következő selectChannelLaunchPlan hívás "ismertетlen"
    // csatornát lát és nem alkalmazza a tanult gyorsprofilot.
    writeStore(store, storage);

    if (wasRepair) {
      logDoctor(
        'verified',
        channel,
        `JAVÍTÁS ELLENŐRIZVE ÉS MENTVE: mód=${rec.bestFormat.toUpperCase()} • puffer=${rec.bestBufferProfile} (${rec.bestBufferAheadSeconds}mp) • indulás=${safeMs}ms`,
        'assistance',
        storage,
      );
    } else if (wasFirstSample) {
      logDoctor(
        'info',
        channel,
        `Csatorna megtanulva: mód=${rec.bestFormat.toUpperCase()} • puffer=${rec.bestBufferProfile} (${rec.bestBufferAheadSeconds}mp) • indulás=${safeMs}ms`,
        'learning',
        storage,
      );
    } else if (prevBestFormat !== rec.bestFormat || prevBestBuffer !== rec.bestBufferProfile) {
      logDoctor(
        'info',
        channel,
        `Gyorsprofil finomhangolva: mód=${rec.bestFormat.toUpperCase()} • puffer=${rec.bestBufferProfile} (${rec.bestBufferAheadSeconds}mp) • indulás=${safeMs}ms`,
        'learning',
        storage,
      );
    } else {
      if (isVerbosePlaybackLogging() && isTvDoctorDiagLoggingEnabled()) {
        appLog(
          `TV DOKTOR MÉRÉS [${rec.channelName}]: sikeres indulás=${safeMs}ms; mód=${format.toUpperCase()}; tanult=${rec.bestFormat.toUpperCase()}/${rec.bestBufferProfile} (${rec.bestBufferAheadSeconds}mp)`,
        );
      }
    }

    if (cloudHook) {
      cloudHook({
        eventType: wasRepair ? 'repair_verified' : 'measurement',
        record: rec,
        event: {
          channelKey: rec.channelKey,
          channelId: rec.channelId,
          channelName: rec.channelName,
          playbackFormat: format,
          bufferProfile: rec.bestBufferProfile,
          bufferAheadSeconds: rec.bestBufferAheadSeconds,
          startupMs: safeMs,
          recovered: wasRepair ? true : undefined,
          tsSuccessDelta: format === 'ts' ? 1 : 0,
          hlsSuccessDelta: format === 'hls' ? 1 : 0,
          repairSuccessDelta: wasRepair ? 1 : 0,
        },
      });
    }

    return rec;
  } catch {
    return null;
  }
}

/** Hiba vagy megakadás rögzítése a csatorna tanuló memóriájába. */
export function recordDoctorChannelFailure(params: {
  channel?: Pick<Channel, 'id' | 'name' | 'countryCode'> | null;
  format: LiveFormat;
  bufferProfile: DoctorBufferProfileId;
  trigger: DoctorTriggerReason;
  errorCode?: string | null;
  errorDetail?: string | null;
  stallMs?: number;
  storage?: Storage | null;
}): ChannelDoctorRecord | null {
  const { channel, format, bufferProfile, trigger, errorCode, errorDetail, stallMs, storage } = params;
  if (!channel) return null;
  // 2.5.298: csak magyar csatorna hibáját tanuljuk – külföldi csatorna nem
  // kerül a tartós memóriába (a felhőbe sem).
  if (!isHungarianDoctorChannel({ id: (channel as any).id, countryCode: (channel as any).countryCode, name: (channel as any).name })) {
    return null;
  }

  try {
    const store = readStore(storage);
    const rec = getOrCreateRecord(store, channel, format, bufferProfile);
    const isStall = trigger === 'playback_stall' || trigger === 'buffer_stall';

    rec.consecutiveCleanStarts = 0;
    rec.consecutiveFailures = (rec.consecutiveFailures || 0) + 1;

    if (isStall) {
      rec.stalls += 1;
    } else if (format === 'hls') {
      rec.hlsFail += 1;
      rec.hlsConsecutiveFail = (rec.hlsConsecutiveFail || 0) + 1;
    } else {
      rec.tsFail += 1;
      rec.tsConsecutiveFail = (rec.tsConsecutiveFail || 0) + 1;
    }

    const prevBuf = rec.bufferStats[bufferProfile] || { ok: 0, fail: 0, stalls: 0, avgStartupMs: null };
    rec.bufferStats[bufferProfile] = {
      ok: prevBuf.ok,
      fail: isStall ? prevBuf.fail : prevBuf.fail + 1,
      stalls: isStall ? prevBuf.stalls + 1 : prevBuf.stalls,
      avgStartupMs: prevBuf.avgStartupMs,
    };

    /*
     * 2.5.294: a hiba/megakadás is tanulás – az adott útvonal pontszáma romlik,
     * így a következő indításnál már a csatorna legjobb mért útvonala élvez
     * elsőbbséget, nem kell újra ugyanazt a rosszat kipróbálni.
     */
    const baseline = getDoctorBaseline(channel, storage);
    recordDoctorRouteOutcome({
      record: rec,
      excludeRouteId: baseline ? doctorRouteId(baseline.format, baseline.bufferProfile) : null,
      format,
      bufferProfile,
      outcome: isStall ? 'stall' : 'fail',
    });

    if (isStall) {
      const stepped = nextSafeBufferProfile(bufferProfile);
      rec.bestBufferProfile = stepped;
      rec.bestBufferAheadSeconds = getDoctorBufferConfig(stepped).minBufferAheadSeconds;
    } else {
      const altFmt: LiveFormat = format === 'hls' ? 'ts' : 'hls';
      if (rec.lastWorkingFormat === format) {
        // Ha a korábban működő formátum zsinórban legalább 2x elbukott, engedjük át a másiknak
        const consec = format === 'hls' ? (rec.hlsConsecutiveFail || 0) : (rec.tsConsecutiveFail || 0);
        if (consec >= 2) rec.lastWorkingFormat = undefined;
      }
      rec.bestFormat = pickFastestReliableFormat(rec, altFmt);
      rec.bestBufferProfile = evaluateBestBufferProfile(rec.bufferStats, rec.bestBufferProfile);
      rec.bestBufferAheadSeconds = getDoctorBufferConfig(rec.bestBufferProfile).minBufferAheadSeconds;
    }

    if (errorCode) rec.lastErrorCode = String(errorCode).slice(0, 48);
    rec.lastErrorReason = String(errorDetail || trigger).slice(0, 120);
    rec.source = rec.source === 'cloud' ? 'merged' : 'local';
    rec.updatedAt = Date.now();
    writeStore(store, storage);

    if (cloudHook) {
      cloudHook({
        eventType: isStall ? 'freeze_detected' : 'diagnostic',
        record: rec,
        event: {
          channelKey: rec.channelKey,
          channelId: rec.channelId,
          channelName: rec.channelName,
          playbackFormat: format,
          bufferProfile,
          bufferAheadSeconds: getDoctorBufferConfig(bufferProfile).minBufferAheadSeconds,
          stallMs: stallMs || undefined,
          errorCode: errorCode || trigger,
          errorReason: errorDetail || trigger,
          recovered: false,
          tsFailureDelta: !isStall && format === 'ts' ? 1 : 0,
          hlsFailureDelta: !isStall && format === 'hls' ? 1 : 0,
          stallDelta: isStall ? 1 : 0,
        },
      });
    }

    return rec;
  } catch {
    return null;
  }
}

/**
 * 3. Hibakeresés: részletes diagnosztikai pillanatkép gyűjtése a csatornáról és a streamről.
 */
export function collectDoctorDiagnostics(params: {
  channel?: Channel | null;
  trigger: DoctorTriggerReason;
  format: LiveFormat;
  bufferProfile: DoctorBufferProfileId;
  loadElapsedMs: number;
  errorCode?: string | null;
  errorDetail?: string | null;
  streamState: DoctorStreamStateSnapshot;
  storage?: Storage | null;
}): DoctorDiagnosticReport {
  const { channel, trigger, format, bufferProfile, loadElapsedMs, errorCode, errorDetail, streamState, storage } = params;
  const channelKey = normalizeChannelDoctorKey(channel);
  const extraMetrics: Record<string, string | number | boolean> = {};

  for (const plugin of diagnosticPlugins) {
    try {
      const collected = plugin.collect({ channel, format, streamState });
      Object.assign(extraMetrics, collected);
    } catch {
      /* Egyetlen plugin hibája sem állíthatja meg a TV Doktort. */
    }
  }

  const cfg = getDoctorBufferConfig(bufferProfile);
  const report: DoctorDiagnosticReport = {
    timestamp: Date.now(),
    channelId: String(channel?.id || 'unknown'),
    channelKey,
    channelName: String(channel?.name || channel?.id || 'Ismeretlen'),
    countryCode: channel?.countryCode,
    trigger,
    format,
    bufferProfile,
    bufferAheadTargetSeconds: cfg.minBufferAheadSeconds,
    loadElapsedMs: Math.max(0, Math.round(loadElapsedMs)),
    errorCode: errorCode ? String(errorCode).slice(0, 48) : null,
    errorDetail: errorDetail ? String(errorDetail).slice(0, 140) : null,
    streamState,
    extraMetrics,
  };

  if (!channelKey.startsWith('vod:') && channel?.countryCode !== 'VOD' && channel?.countryCode !== 'SER') {
    const isHardError = trigger === 'media_error' || trigger === 'play_rejected';
    logDoctor(
      isHardError ? 'error' : 'warn',
      channel,
      isHardError
        ? `CSATORNAHIBA (${report.errorCode || trigger}): mód=${format.toUpperCase()} • puffer=${bufferProfile} • eltelt=${report.loadElapsedMs}ms`
        : `AKTIVÁLÁS ok=${trigger} • mód=${format.toUpperCase()} • puffer=${bufferProfile} • betöltés=${report.loadElapsedMs}ms • hiba=${report.errorCode || 'nincs'} • tartalék=${streamState.bufferedAheadSeconds.toFixed(1)}mp`,
      isHardError ? 'channel_error' : 'activation',
      storage,
    );
  }

  return report;
}

/**
 * 7. Okos fagyásfigyelés
 */
export interface FreezeCheckInput {
  prevSnapshot: MediaProgressSample | null;
  currentSnapshot: MediaProgressSample;
  streamState: DoctorStreamStateSnapshot;
  consecutiveStallTicks: number;
  minBufferAheadSeconds: number;
}

export interface FreezeCheckDecision {
  intervene: boolean;
  reason: string;
}

export function evaluateSmartFreeze(input: FreezeCheckInput): FreezeCheckDecision {
  const { prevSnapshot, currentSnapshot, streamState, consecutiveStallTicks, minBufferAheadSeconds } = input;
  opHealth.freezeChecksCount += 1;

  if (prevSnapshot && mediaProgressed(prevSnapshot, currentSnapshot)) {
    return { intervene: false, reason: 'idővonal vagy képkockaszám halad' };
  }

  if (
    streamState.videoWidth === 0 &&
    streamState.videoHeight === 0 &&
    streamState.readyState >= 3 &&
    !streamState.paused &&
    !streamState.ended &&
    !streamState.waitingOrStalled &&
    streamState.networkState !== 3
  ) {
    if (isVerbosePlaybackLogging() && isTvDoctorDiagLoggingEnabled()) {
      appLog('TV DOKTOR FAGYÁSVIZSGÁLAT: aktív hangcsatorna (0x0 videó, egészséges puffer) – nincs hamis beavatkozás');
    }
    return { intervene: false, reason: 'aktív hangalapú adatfolyam (0x0 videó), nincs hamis beavatkozás' };
  }

  const healthyBuffer = streamState.bufferedAheadSeconds >= Math.max(1.5, minBufferAheadSeconds * 0.75);
  const hardTransportFailure = streamState.waitingOrStalled
    || streamState.networkState === 3
    || streamState.bufferedAheadSeconds < 0.3;

  // A már leállított/leálló médiaelem nem bizonyít élő lejátszási fagyást.
  if (streamState.paused || streamState.ended) {
    return { intervene: false, reason: 'a lejátszó szünetel vagy már befejeződött' };
  }

  // Ha nincs egyértelmű hálózati/pufferhiba, a webOS readyState-ingadozása
  // vagy a nem frissülő képkockaszámláló önmagában nem indíthat forráscserét.
  // Egészséges puffer mellett 3, kisebb tartaléknál 2 külön stall-ellenőrzés
  // szükséges. A valódi transport-hiba továbbra is azonnali beavatkozást kap.
  if (!hardTransportFailure) {
    const requiredConfirmations = healthyBuffer ? 3 : 2;
    if (consecutiveStallTicks < requiredConfirmations) {
      const reason = healthyBuffer
        ? `egészséges puffer mellett megerősítésre vár (${consecutiveStallTicks}/${requiredConfirmations})`
        : `nincs igazolt hálózati hiba, további ellenőrzés szükséges (${consecutiveStallTicks}/${requiredConfirmations})`;
      if (isVerbosePlaybackLogging() && isTvDoctorDiagLoggingEnabled()) {
        appLog(
          `TV DOKTOR FAGYÁSVIZSGÁLAT: ${reason}; tartalék=${streamState.bufferedAheadSeconds.toFixed(1)}mp; readyState=${streamState.readyState}; networkState=${streamState.networkState}`,
        );
      }
      return { intervene: false, reason };
    }
  }

  opHealth.confirmedFreezesCount += 1;
  const detail = streamState.waitingOrStalled || streamState.networkState === 3 || streamState.bufferedAheadSeconds < 0.3
    ? 'adatfolyam-megakadás (hálózati hiba vagy kiürült puffer)'
    : 'dekóder-/képkocka-fagyás több egymást követő ellenőrzéssel megerősítve';
  if (isTvDoctorDiagLoggingEnabled()) {
    appLog(
      `TV DOKTOR ELAKADÁS ÉSZLELVE: ${detail}; tartalék=${streamState.bufferedAheadSeconds.toFixed(1)}mp; ciklus=${consecutiveStallTicks}; rs=${streamState.readyState}; ns=${streamState.networkState}`,
    );
  }
  return { intervene: true, reason: detail };
}

/**
 * 4. Sebességteszt jelöltlista: több különböző formátum + pufferprofil gyors kipróbálásához.
 */
export function buildSafeSpeedTestCandidates(params: {
  streamUrl: string;
  currentFormat: LiveFormat;
  currentBufferProfile: DoctorBufferProfileId;
  record?: ChannelDoctorRecord | null;
}): Array<{ format: LiveFormat; url: string; bufferProfile: DoctorBufferProfileId }> {
  const { streamUrl, currentFormat, currentBufferProfile, record } = params;
  const tsUrl = urlWithFormat(streamUrl, 'ts') || streamUrl;
  const hlsUrl = urlWithFormat(streamUrl, 'hls') || streamUrl;
  const dual = tsUrl !== hlsUrl;
  const altFormat: LiveFormat = currentFormat === 'hls' ? 'ts' : 'hls';

  const candidates: Array<{ format: LiveFormat; url: string; bufferProfile: DoctorBufferProfileId }> = [];

  if (dual) {
    const altUntested = altFormat === 'hls' ? record?.hlsAvgStartupMs == null : record?.tsAvgStartupMs == null;
    candidates.push({
      format: altFormat,
      url: altFormat === 'hls' ? hlsUrl : tsUrl,
      bufferProfile: altUntested ? 'fast' : (record?.bestBufferProfile || currentBufferProfile),
    });
  }

  for (const preset of ['turbo', 'fast', 'balanced', 'stable'] as const) {
    if (preset !== currentBufferProfile) {
      candidates.push({
        format: currentFormat,
        url: currentFormat === 'hls' ? hlsUrl : tsUrl,
        bufferProfile: preset,
      });
    }
  }

  return candidates.slice(0, 4);
}

/** Ellenőrzi, hogy nem léptük-e túl a csatornánkénti percenkénti beavatkozási korlátot. */
export function canDoctorIntervene(channelKey: string, now = Date.now()): boolean {
  const windowStart = now - 60_000;
  const list = (interventionTimestampsByChannel.get(channelKey) || []).filter((t) => t >= windowStart);
  interventionTimestampsByChannel.set(channelKey, list);
  return list.length < MAX_INTERVENTIONS_PER_MINUTE;
}

function markIntervention(channelKey: string, now = Date.now()): void {
  const windowStart = now - 60_000;
  const list = (interventionTimestampsByChannel.get(channelKey) || []).filter((t) => t >= windowStart);
  list.push(now);
  interventionTimestampsByChannel.set(channelKey, list);
}

/**
 * 5. & 10. Automatikus javítás több különböző gyors beállítással,
 * ÉS valóban nem működő csatornák végleges leállítása (végtelen ciklus nélkül!).
 */
export function planDoctorRepairStep(params: {
  channel?: Channel | null;
  trigger: DoctorTriggerReason;
  step: number;
  maxStepsOverride?: number;
  currentFormat: LiveFormat;
  currentBufferProfile: DoctorBufferProfileId;
  streamUrl: string;
  tsUrl: string;
  hlsUrl: string;
  /*
   * 2.5.277 (#17-es napló, ARENA 4): egy javítási létrán belül már sikertelenül
   * kipróbált formátumok. A létra ezeket NEM próbálja újra – így nincs
   * HLS↔TS oda-vissza ugrálás egyetlen javítási körön belül.
   */
  triedFormats?: LiveFormat[];
  /** Az érinthetetlen, felhasználó által rögzített 1-es alapprofil. */
  baselineProfile?: DoctorBaselineProfile | null;
  currentBufferTiming?: BufferProfileTiming | null;
  /* 2.5.294: a létrán belül már kipróbált tanult útvonalak (`format:puffer`). */
  triedRoutes?: string[];
  storage?: Storage | null;
}): DoctorRepairProposal {
  const {
    channel,
    trigger,
    step,
    maxStepsOverride,
    currentFormat,
    currentBufferProfile,
    streamUrl,
    tsUrl,
    hlsUrl,
    triedFormats,
    baselineProfile,
    currentBufferTiming,
    triedRoutes,
    storage,
  } = params;

  const channelKey = normalizeChannelDoctorKey(channel);
  const altFormat: LiveFormat = currentFormat === 'hls' ? 'ts' : 'hls';
  /* 2.5.277: az alternatív formátum csak akkor „él”, ha ezt a létrát még nem próbálta sikertelenül. */
  const altAlreadyTried = Boolean(triedFormats && triedFormats.includes(altFormat));
  const hasAlternateFormat = Boolean(tsUrl && hlsUrl && tsUrl !== hlsUrl && !altAlreadyTried);
  // Az elsődleges (csatorna-saját) formátum: a 2. lépésben bekapcsolt alternatív
  // formátumra való visszaesés után a 3. lépésben vissza kell térni rá, ne maradjon
  // az alternatívon (currentFormat), mert az már egyszer meghibásodott.
  const primaryFormat: LiveFormat = formatOfUrl(streamUrl) || currentFormat;
  const urlFor = (fmt: LiveFormat) => (fmt === 'hls' ? hlsUrl : tsUrl) || streamUrl;
  const store = readStore(storage);
  const record = getChannelDoctorRecord(channel, storage);
  /*
   * 2.5.298: ha a csatorna korábban MÁR működött (van sikeres indítása),
   * nem adjuk fel 8 lépés után: a tanult útvonalat és a progresszív puffert
   * tovább próbáljuk. A javítási létra ilyenkor 8 lépésig bővül, és a
   * tanult útvonal elsőbbséget kap – így egy korábban megnyitható adás
   * nem kerül azonnal „nem működik” állapotba egy átmeneti hiba miatt.
   */
  const hasPriorSuccess = Boolean(
    record && (
      (record.tsOk || 0) + (record.hlsOk || 0) > 0 ||
      (record.consecutiveCleanStarts || 0) > 0 ||
      Boolean(record.lastWorkingFormat)
    ),
  );
  let effectiveMaxSteps = Math.max(
    1,
    Math.min(MAX_DOCTOR_REPAIR_STEPS, maxStepsOverride || MAX_DOCTOR_REPAIR_STEPS),
  );

  /*
   * 2.5.294: A JAVÍTÁS IS A CSATORNA SAJÁT TANULÁSÁBÓL DOLGOZIK.
   *
   * Eddig a létra vakon váltogatta a formátumot és a puffert. Mostantól ha a
   * csatornánál van korábban bevált, de az aktuálistól eltérő útvonal (más
   * pufferprofil vagy a másik formátum), akkor azt próbálja ki előbb – pont
   * azt, ami ennél a csatornánál már működött.
   */
  const currentRouteId = doctorRouteId(currentFormat, currentBufferProfile);
  const triedRouteIds = new Set((triedRoutes || []).filter(Boolean));
  const learnedAlternate = learnedRouteCandidates(record, currentRouteId).find((route) =>
    !triedRouteIds.has(route.id)
    && (route.format === currentFormat || !(triedFormats || []).includes(route.format))
    && Boolean(urlFor(route.format)),
  ) || null;

  // A percenkénti beavatkozási korlát NEM bizonyítja, hogy a csatorna halott.
  // Ha csak a biztonsági limit fogyott el, állítsuk meg ezt a javítási kört,
  // de ne írjunk CHANNEL_UNREACHABLE állapotot és ne indítsunk halott-cooldownt.
  if (step <= effectiveMaxSteps && !canDoctorIntervene(channelKey)) {
    const safeCfg = getDoctorBufferConfig(record?.bestBufferProfile || currentBufferProfile);
    return {
      step,
      maxSteps: effectiveMaxSteps,
      strategyId: 'intervention_rate_limited',
      description: 'a TV Doktor biztonsági beavatkozási korlátja elérte a határt',
      nextFormat: currentFormat,
      nextUrl: urlFor(currentFormat),
      nextBufferProfile: safeCfg.id,
      nextBufferTiming: safeCfg,
      delayMs: 0,
      useFallbackUrl: false,
      forceCleanReset: false,
      stopRetrying: true,
      exhausted: false,
    };
  }

  // Csak akkor minősítjük átmenetileg elérhetetlennek, ha a teljes javítási
  // létra minden lépése valóban lefutott és sikertelen maradt.
  if (step > effectiveMaxSteps) {
    const safeCfg = getDoctorBufferConfig(record?.bestBufferProfile || currentBufferProfile);

    // Ha egy külön hívó rövidített ellenőrzést kér, annak sikertelensége önmagában
    // nem bizonyítja, hogy a csatorna halott. Ne növeljük a halottszámlálót,
    // és ne írjunk újabb CHANNEL_UNREACHABLE hibát; a teljes létra később ismét rendelkezésre áll.
    if (effectiveMaxSteps < MAX_DOCTOR_REPAIR_STEPS) {
      logDoctor(
        'warn',
        channel,
        'AZ ÚJRAAKTIVÁLÁSI GYORS ELLENŐRZÉS SIKERTELEN – a csatorna nincs végleg hibásnak minősítve; a teljes vizsgálat később újrapróbálható.',
        'activation',
        storage,
      );
      if (cloudHook && record) {
        cloudHook({
          eventType: 'repair_exhausted',
          record,
          event: {
            channelKey,
            channelId: channel?.id,
            channelName: channel?.name || channelKey,
            playbackFormat: currentFormat,
            bufferProfile: currentBufferProfile,
            errorCode: 'REACTIVATION_CHECK_FAILED',
            errorReason: trigger,
            recovered: false,
          },
        });
      }
      return {
        step,
        maxSteps: effectiveMaxSteps,
        strategyId: 'reactivation_check_failed',
        description: 'a rövidített ellenőrzés sikertelen; később teljes javítási létra következik',
        nextFormat: currentFormat,
        nextUrl: urlFor(currentFormat),
        nextBufferProfile: safeCfg.id,
        nextBufferTiming: safeCfg,
        delayMs: 0,
        useFallbackUrl: false,
        forceCleanReset: false,
        stopRetrying: true,
        exhausted: false,
      };
    }

    // 2.5.315 FIX: MŰKÖDŐ CSATORNÁT SOHA NE JELÖLJÜNK HALOTTNAK — tanult útvonallal újraindítjuk, nem „nem elérhető”
    const _recForCheck = channel ? getOrCreateRecord(store, channel, currentFormat, currentBufferProfile) : null;
    const _hasPriorSuccessForHalt = Boolean(
      (_recForCheck && ((_recForCheck.tsOk || 0) + (_recForCheck.hlsOk || 0) > 0 || (_recForCheck.consecutiveCleanStarts || 0) > 0 || Boolean(_recForCheck.lastWorkingFormat)))
      || (record && ((record.tsOk || 0) + (record.hlsOk || 0) > 0 || (record.consecutiveCleanStarts || 0) > 0 || Boolean(record.lastWorkingFormat)))
    );
    if (_hasPriorSuccessForHalt && learnedAlternate) {
      // Van tanult útvonal: ne halottnak jelöljük, hanem azzal próbáljuk újra — a csatorna működött, nem szabad „nem elérhető”-nek mutatni
      logDoctor(
        'warn',
        channel,
        `MŰKÖDŐ CSATORNA ÁTMENETI HIBÁJA (${effectiveMaxSteps}/${effectiveMaxSteps} sikertelen) – tanult útvonal újrapróbálása (${learnedAlternate.format.toUpperCase()} + ${learnedAlternate.bufferProfile}), nem jelöljük halottnak.`,
        'activation',
        storage,
      );
      if (cloudHook && record) {
        cloudHook({
          eventType: 'repair_exhausted',
          record,
          event: {
            channelKey,
            channelId: channel?.id,
            channelName: channel?.name || channelKey,
            playbackFormat: learnedAlternate.format,
            bufferProfile: learnedAlternate.bufferProfile,
            errorCode: 'RETRY_LEARNED_ROUTE',
            errorReason: trigger,
            recovered: false,
          },
        });
      }
      const safeCfgRetry = getDoctorBufferConfig(learnedAlternate.bufferProfile);
      return {
        step: 1,
        maxSteps: effectiveMaxSteps,
        strategyId: 'learned_route_retry_after_exhaustion',
        description: `működő csatorna újrapróbálása tanult útvonallal (${learnedAlternate.format.toUpperCase()} + ${learnedAlternate.bufferProfile})`,
        nextFormat: learnedAlternate.format,
        nextUrl: urlFor(learnedAlternate.format),
        nextBufferProfile: learnedAlternate.bufferProfile,
        nextBufferTiming: safeCfgRetry,
        delayMs: 90,
        useFallbackUrl: false,
        forceCleanReset: true,
        stopRetrying: false,
        exhausted: false,
      };
    }

    opHealth.deadChannelsHaltedCount += 1;

    if (channel) {
      const rec = _recForCheck || getOrCreateRecord(store, channel, currentFormat, currentBufferProfile);
      const nowMs = Date.now();
      /*
       * 2.5.277 (#17-es napló): a halott jelölés ismétlődő kimerülésnél
       * skálázódik (3 perc → 6 → 12 → … max 30 perc), és külön jegyezzük az
       * utolsó kimerülés idejét – az újraaktiválási hűtő (lásd
       * selectChannelLaunchPlan) ebből számol, így kézi újraválasztásnál sem
       * indul újra teljes létra pár másodpercenként (ARENA 4 flapping ellen).
       * 2.5.298: korábban már működő csatornánál RÖVID hűtést adunk (60 mp),
       * és nem növeljük agresszíven a haltCount-ot – egy átmeneti hiba ne
       * zárja ki 30 percre a TV Doktort, a következő próbánál a tanult
       * útvonal újra esélyt kap.
       * 2.5.315: de ha van tanult útvonal, már fentebb visszatértünk újrapróbálással, ide csak akkor jutunk, ha nincs tanult alternatíva — akkor is rövid hűtés.
       */
      const recHasPriorSuccess = _hasPriorSuccessForHalt;
      const haltCount = recHasPriorSuccess ? Math.min(1, (rec.haltCount || 0) + 1) : (rec.haltCount || 0) + 1;
      rec.haltCount = haltCount;
      rec.lastExhaustedAt = nowMs;
      rec.deadUntil = nowMs + (recHasPriorSuccess
        ? Math.min(60 * 1000, DEAD_CHANNEL_COOLDOWN_MS)
        : Math.min(
          MAX_DEAD_CHANNEL_COOLDOWN_MS,
          DEAD_CHANNEL_COOLDOWN_MS * Math.pow(2, haltCount - 1),
        ));
      rec.lastErrorCode = 'CHANNEL_UNREACHABLE';
      rec.lastErrorReason = `${effectiveMaxSteps} különböző beállítás sikertelen (${trigger})`;
      rec.updatedAt = nowMs;
      /* 2.5.277: azonnal mentjük – a logDoctor saját readStore-ja külön objektumot
         adna vissza explicit storage-nál, és felülírná ezt a módosítást. */
      try { writeStore(store, storage); } catch { /* mentési hiba nem akadályozhat */ }
    }

    logDoctor(
      'error',
      channel,
      `CSATORNA NEM MŰKÖDIK (${Math.min(step - 1, effectiveMaxSteps)}/${effectiveMaxSteps} beállítás sikertelen) – az újrapróbálás leállítva, nincs végtelen ciklus.`,
      'channel_error',
      storage,
    );

    if (cloudHook && record) {
      cloudHook({
        eventType: 'repair_exhausted',
        record,
        event: {
          channelKey,
          channelId: channel?.id,
          channelName: channel?.name || channelKey,
          playbackFormat: currentFormat,
          bufferProfile: currentBufferProfile,
          errorCode: 'CHANNEL_UNREACHABLE',
          errorReason: trigger,
          recovered: false,
        },
      });
    }

    return {
      step,
      maxSteps: effectiveMaxSteps,
      strategyId: 'channel_unreachable_stop',
      description: 'a csatorna jelenleg nem működik – újrapróbálás leállítva',
      nextFormat: currentFormat,
      nextUrl: urlFor(currentFormat),
      nextBufferProfile: safeCfg.id,
      nextBufferTiming: safeCfg,
      delayMs: 0,
      useFallbackUrl: false,
      forceCleanReset: false,
      stopRetrying: true,
      exhausted: true,
    };
  }

  markIntervention(channelKey);
  opHealth.repairsAttemptedCount += 1;

  const isStallTrigger = trigger === 'playback_stall' || trigger === 'buffer_stall';
  let strategyId = 'same_format_fast_reset';
  let description = 'gyors dekóder-frissítés az aktuális módban';
  let nextFormat: LiveFormat = currentFormat;
  let nextBufferProfile: DoctorBufferProfileId = currentBufferProfile;
  let nextUrl = urlFor(currentFormat);
  let useFallbackUrl = false;
  let forceCleanReset = true;
  let delayMs = 60;

  if (isStallTrigger) {
    // TV Doktor: először ugyanazt az URL-t és puffert töltjük újra tiszta dekóder-reset-tel.
    // Csak ennek sikertelensége után változtatunk tanult pufferprofilra vagy formátumra.
    if (step === 1) {
      nextBufferProfile = currentBufferProfile;
      nextFormat = currentFormat;
      nextUrl = urlFor(currentFormat);
      strategyId = 'same_format_fast_reset';
      description = `1. próba: ugyanazon adatfolyam tiszta újraindítása (${currentFormat.toUpperCase()}, ${currentBufferProfile})`;
      delayMs = 60;
    } else if (step === 2) {
      nextBufferProfile = nextSafeBufferProfile(currentBufferProfile);
      nextFormat = currentFormat;
      nextUrl = urlFor(currentFormat);
      strategyId = 'buffer_step_up';
      description = `2. próba: puffer növelése (${currentBufferProfile} -> ${nextBufferProfile})`;
      delayMs = 80;
    } else if (step === 3 && learnedAlternate) {
      nextFormat = learnedAlternate.format;
      nextUrl = urlFor(nextFormat);
      nextBufferProfile = learnedAlternate.bufferProfile;
      strategyId = 'learned_route_switch';
      description = `tanult útvonal váltás (${nextFormat.toUpperCase()} + ${nextBufferProfile})`;
      delayMs = 90;
    } else if (step === 3 && hasAlternateFormat) {
      nextFormat = altFormat;
      nextUrl = urlFor(altFormat);
      nextBufferProfile = nextSafeBufferProfile(currentBufferProfile);
      strategyId = 'switch_format_with_buffer';
      description = `formátumváltás (${altFormat.toUpperCase()}) + emelt puffer (${nextBufferProfile})`;
      delayMs = 100;
    } else if (step === 4) {
      nextBufferProfile = nextSafeBufferProfile(nextSafeBufferProfile(currentBufferProfile));
      nextFormat = currentFormat;
      nextUrl = urlFor(nextFormat);
      strategyId = 'progressive_buffer_tuning';
      description = `fokozatos pufferfinomhangolás (${nextFormat.toUpperCase()}, ${getDoctorBufferConfig(nextBufferProfile).minBufferAheadSeconds}mp)`;
      delayMs = 150;
    } else if (step === 5) {
      nextBufferProfile = nextSafeBufferProfile(nextSafeBufferProfile(nextSafeBufferProfile(currentBufferProfile)));
      nextFormat = hasAlternateFormat ? altFormat : currentFormat;
      nextUrl = urlFor(nextFormat);
      strategyId = 'alt_progressive_buffer';
      description = `stabilizált mód (${nextFormat.toUpperCase()}, ${getDoctorBufferConfig(nextBufferProfile).minBufferAheadSeconds}mp)`;
      delayMs = 200;
    } else if (step === 6) {
      nextFormat = primaryFormat;
      nextUrl = urlFor(nextFormat);
      nextBufferProfile = 'adaptive-1';
      strategyId = 'stall_adaptive_buffer_1';
      description = '6. próba: elsődleges formátum + 6,5 mp puffer';
      delayMs = 240;
    } else if (step === 7) {
      nextFormat = hasAlternateFormat ? altFormat : primaryFormat;
      nextUrl = urlFor(nextFormat);
      nextBufferProfile = 'adaptive-2';
      strategyId = 'stall_adaptive_buffer_2';
      description = '7. próba: alternatív formátum + 8 mp puffer';
      delayMs = 280;
    } else {
      nextFormat = primaryFormat;
      nextUrl = urlFor(nextFormat);
      nextBufferProfile = 'adaptive-3';
      strategyId = 'stall_adaptive_buffer_3';
      description = '8. próba: elsődleges formátum + 10 mp puffer';
      if (channel?.fallbackUrl && channel.fallbackUrl !== nextUrl) {
        nextUrl = channel.fallbackUrl;
        useFallbackUrl = true;
        strategyId = 'channel_fallback_stream';
        description = '8. próba: tartalék adatfolyam + maximális védett puffer';
      }
      delayMs = 320;
    }
  } else {
    // Indulási hiba esetén 8 külön lépés: tiszta újraindítás, formátumváltás, pufferemelés, tartalék URL.
    if (step === 1) {
      nextFormat = currentFormat;
      nextUrl = urlFor(currentFormat);
      nextBufferProfile = currentBufferProfile === 'instant' || currentBufferProfile === 'turbo' ? 'fast' : currentBufferProfile;
      strategyId = 'quick_primary_retry';
      description = `1. próba: gyors tiszta újraindítás (${nextFormat.toUpperCase()}, ${nextBufferProfile})`;
      delayMs = 60;
    } else if (step === 2 && learnedAlternate) {
      nextFormat = learnedAlternate.format;
      nextUrl = urlFor(nextFormat);
      nextBufferProfile = learnedAlternate.bufferProfile;
      strategyId = 'learned_route_probe';
      description = `2. próba: korábban bevált útvonal (${nextFormat.toUpperCase()} + ${nextBufferProfile})`;
      delayMs = 70;
    } else if (step === 2 && hasAlternateFormat) {
      nextFormat = altFormat;
      nextUrl = urlFor(altFormat);
      nextBufferProfile = 'fast';
      strategyId = 'format_switch_probe';
      description = `2. próba: formátumváltás (${currentFormat.toUpperCase()} -> ${altFormat.toUpperCase()}, gyors profil)`;
      delayMs = 70;
    } else if (step === 3) {
      nextFormat = primaryFormat;
      nextUrl = urlFor(nextFormat);
      nextBufferProfile = nextSafeBufferProfile(currentBufferProfile === 'fast' ? 'balanced' : currentBufferProfile);
      strategyId = 'startup_buffer_step_up';
      description = `3. próba: emelt indulási puffer (${nextFormat.toUpperCase()}, ${nextBufferProfile})`;
      delayMs = 130;
    } else if (step === 4) {
      nextFormat = hasAlternateFormat ? altFormat : primaryFormat;
      nextUrl = urlFor(nextFormat);
      nextBufferProfile = 'stable';
      strategyId = 'alternate_format_raised_buffer';
      description = '4. próba: alternatív formátum + stabil puffer (5 mp)';
      delayMs = 180;
    } else if (step === 5) {
      nextFormat = primaryFormat;
      nextUrl = urlFor(nextFormat);
      nextBufferProfile = 'adaptive-1';
      strategyId = 'startup_adaptive_buffer_1';
      description = '5. próba: elsődleges formátum + 6,5 mp puffer';
      delayMs = 220;
    } else if (step === 6) {
      nextFormat = hasAlternateFormat ? altFormat : primaryFormat;
      nextUrl = urlFor(nextFormat);
      nextBufferProfile = 'adaptive-2';
      strategyId = 'startup_adaptive_buffer_2';
      description = '6. próba: alternatív formátum + 8 mp puffer';
      delayMs = 260;
    } else if (step === 7) {
      nextFormat = primaryFormat;
      nextUrl = urlFor(nextFormat);
      nextBufferProfile = 'adaptive-3';
      strategyId = 'startup_adaptive_buffer_3';
      description = '7. próba: elsődleges formátum + 10 mp puffer';
      delayMs = 300;
    } else {
      nextBufferProfile = 'adaptive-3';
      if (channel?.fallbackUrl && channel.fallbackUrl !== nextUrl) {
        nextUrl = channel.fallbackUrl;
        useFallbackUrl = true;
        strategyId = 'fallback_url_repair';
        description = '8. próba: tartalék csatorna-URL maximális pufferrel';
      } else {
        nextFormat = hasAlternateFormat ? altFormat : primaryFormat;
        nextUrl = urlFor(nextFormat);
        strategyId = 'final_bounded_repair';
        description = '8. próba: utolsó tiszta újraindítás maximális pufferrel';
      }
      delayMs = 340;
    }
  }

  // Korábban működő csatornánál az 5. lépésben még egyszer előnyben részesítjük a bevált útvonalat.
  // A többi lépés külön puffer- és formátumpróbát végez; az újraaktiválási hűtő sem csökkenti a 8 lépéses próbálkozást.
  if (hasPriorSuccess && effectiveMaxSteps === MAX_DOCTOR_REPAIR_STEPS && learnedAlternate && step === 5) {
    nextFormat = learnedAlternate.format;
    nextUrl = urlFor(learnedAlternate.format);
    nextBufferProfile = learnedAlternate.bufferProfile;
    strategyId = 'learned_route_retry';
    description = `tanult útvonal újrapróbálása (${nextFormat.toUpperCase()} + ${nextBufferProfile})`;
    delayMs = 90;
    useFallbackUrl = false;
  }

  const baselineTiming = baselineProfile ? clampBufferTiming(baselineProfile.bufferTiming) : null;
  const sameAsBaselineTiming = Boolean(baselineTiming && currentBufferTiming
    && baselineTiming.startupWatchdogMs === currentBufferTiming.startupWatchdogMs
    && baselineTiming.bufferWatchdogMs === currentBufferTiming.bufferWatchdogMs
    && baselineTiming.stallDetectorMs === currentBufferTiming.stallDetectorMs
    && baselineTiming.retryMs === currentBufferTiming.retryMs
    && baselineTiming.minBufferAheadSeconds === currentBufferTiming.minBufferAheadSeconds);
  const baselineDiffers = Boolean(baselineProfile && (
    baselineProfile.format !== currentFormat
    || baselineProfile.bufferProfile !== currentBufferProfile
    || !sameAsBaselineTiming
  ));
  // A hiba utáni második próbálkozás mindig az érinthetetlen 1-es alapbeállítás, ha az eltér az aktuális tanult profiltól.
  if (step === 2 && baselineProfile && baselineDiffers) {
    nextFormat = baselineProfile.format;
    nextUrl = urlFor(baselineProfile.format);
    nextBufferProfile = baselineProfile.bufferProfile;
    strategyId = 'baseline_profile_1_fallback';
    description = `1-es alapbeállítás visszaállítása (${nextFormat.toUpperCase()} + ${nextBufferProfile})`;
    delayMs = 70;
    useFallbackUrl = false;
    forceCleanReset = true;
  }

  const baseCfg = getDoctorBufferConfig(nextBufferProfile);
  // A gyors beállításpróbáknál feszes indulási őrt tartunk, hogy a 8 lépés se húzódjon el feleslegesen!
  const nextTiming = strategyId === 'baseline_profile_1_fallback' && baselineTiming
    ? baselineTiming
    : !isStallTrigger && step <= 2
    ? clampBufferTiming({
        ...baseCfg,
        startupWatchdogMs: Math.min(baseCfg.startupWatchdogMs, 1150),
      })
    : baseCfg;

  logDoctor(
    'repair',
    channel,
    `JAVÍTÁS [${step}/${effectiveMaxSteps}] ${description}`,
    'assistance',
    storage,
  );

  if (cloudHook) {
    cloudHook({
      eventType: strategyId.indexOf('buffer') >= 0 ? 'buffer_test' : strategyId.indexOf('probe') >= 0 ? 'speed_test' : 'repair_attempt',
      record,
      event: {
        channelKey,
        channelId: channel?.id,
        channelName: channel?.name || channelKey,
        playbackFormat: nextFormat,
        bufferProfile: nextBufferProfile,
        bufferAheadSeconds: nextTiming.minBufferAheadSeconds,
        errorReason: trigger,
        details: { step, strategyId },
      },
    });
  }

  return {
    step,
    maxSteps: effectiveMaxSteps,
    strategyId,
    description,
    nextFormat,
    nextUrl,
    nextBufferProfile,
    nextBufferTiming: nextTiming,
    delayMs,
    useFallbackUrl,
    forceCleanReset,
    stopRetrying: false,
    exhausted: false,
  };
}

/**
 * Központi (Supabase) profilok összefésülése a helyi tanuló memóriával.
 */
export interface CloudChannelProfileInput {
  channelKey: string;
  channelIdHint?: string | null;
  channelName: string;
  countryCode?: string | null;
  bestFormat: LiveFormat;
  bestBufferProfile: DoctorBufferProfileId;
  bestBufferAheadSeconds?: number;
  tsAvgStartupMs?: number | null;
  hlsAvgStartupMs?: number | null;
  bestStartupMs?: number | null;
  tsSuccessCount?: number;
  tsFailureCount?: number;
  hlsSuccessCount?: number;
  hlsFailureCount?: number;
  stallCount?: number;
  repairSuccessCount?: number;
  bufferScores?: Partial<Record<DoctorBufferProfileId, BufferProfileStats>>;
  /* 2.5.294: a felhőből visszakapott tanult útvonalak (max. 8). */
  routes?: unknown;
  confidenceScore?: number;
}

export function mergeCloudProfilesIntoLocal(
  profiles: CloudChannelProfileInput[],
  storage?: Storage | null,
): number {
  if (!Array.isArray(profiles) || profiles.length === 0) return 0;
  const store = readStore(storage);
  let mergedCount = 0;

  for (const incoming of profiles) {
    if (!incoming || !incoming.channelKey || !isValidFormat(incoming.bestFormat)) continue;
    const key = incoming.channelKey.slice(0, 120);
    if (key.startsWith('vod:') || (incoming as any).countryCode === 'VOD' || (incoming as any).countryCode === 'SER') {
      continue;
    }
    /*
     * 2.5.294: a felhő csak a magyar csatornák tudását tartalmazza; idegen
     * országú profilt nem veszünk át (a régi, feltöltött sorok így sem hatnak).
     * 2.5.310: kulcs-előtaggal is felismerjük a HU-t, hogy IPK újraindításkor se vesszen el.
     */
    if (!isPersistableDoctorRecord({ countryCode: incoming.countryCode || undefined, channelKey: key, channelName: String(incoming.channelName || ''), channelIdHint: incoming.channelIdHint || undefined } as any)) continue;
    const incomingRoutes = sanitizeDoctorRoutes((incoming as { routes?: unknown }).routes);
    const bp: DoctorBufferProfileId = isValidBufferProfile(incoming.bestBufferProfile)
      ? incoming.bestBufferProfile
      : 'balanced';
    const existing = store.byKey[key];

    const incTsOk = Math.max(0, Number(incoming.tsSuccessCount) || 0);
    const incTsFail = Math.max(0, Number(incoming.tsFailureCount) || 0);
    const incHlsOk = Math.max(0, Number(incoming.hlsSuccessCount) || 0);
    const incHlsFail = Math.max(0, Number(incoming.hlsFailureCount) || 0);
    // Kiszűrjük a felhőből érkező esetleges 20 ms-os helyőrzőket vagy 0-sikerű átlagokat!
    const incTsAvg = sanitizePositiveStartupMs(incoming.tsAvgStartupMs, incTsOk);
    const incHlsAvg = sanitizePositiveStartupMs(incoming.hlsAvgStartupMs, incHlsOk);
    const rawIncBest = typeof incoming.bestStartupMs === 'number' && incoming.bestStartupMs > 20
      ? Math.round(incoming.bestStartupMs)
      : null;
    const bestCands = [rawIncBest, incTsAvg, incHlsAvg].filter((n): n is number => typeof n === 'number' && n > 0);
    const incBestMs = bestCands.length > 0 ? Math.min(...bestCands) : null;

    if (!existing) {
      const created: ChannelDoctorRecord = {
        channelKey: key,
        channelId: incoming.channelIdHint || undefined,
        channelName: String(incoming.channelName || key).slice(0, 140),
        countryCode: incoming.countryCode || undefined,
        bestFormat: incoming.bestFormat,
        bestBufferProfile: bp,
        bestBufferAheadSeconds: Math.max(
          MIN_SAFE_BUFFER_SECONDS,
          Math.min(
            MAX_SAFE_BUFFER_SECONDS,
            Number(incoming.bestBufferAheadSeconds) || DOCTOR_BUFFER_CONFIGS[bp].minBufferAheadSeconds,
          ),
        ),
        tsAvgStartupMs: incTsAvg,
        hlsAvgStartupMs: incHlsAvg,
        bestStartupMs: incBestMs,
        tsOk: incTsOk,
        tsFail: incTsFail,
        hlsOk: incHlsOk,
        hlsFail: incHlsFail,
        stalls: Math.max(0, Number(incoming.stallCount) || 0),
        repairsOk: Math.max(0, Number(incoming.repairSuccessCount) || 0),
        bufferStats: incoming.bufferScores && typeof incoming.bufferScores === 'object' ? incoming.bufferScores : {},
        routes: incomingRoutes,
        source: 'cloud',
        confidence: incoming.confidenceScore,
        updatedAt: Date.now(),
      };
      created.bestFormat = pickFastestReliableFormat(created, incoming.bestFormat);
      store.byKey[key] = created;
      if (created.channelId && !store.idIndex[created.channelId]) {
        store.idIndex[created.channelId] = key;
      }
      mergedCount += 1;
    } else {
      const localSamples = existing.tsOk + existing.hlsOk;
      // SOHA nem írjuk felül egy helyileg már sikeresen lejátszott (`lastWorkingFormat`) csatorna
      // formátumát a felhőből érkező adatokkal!
      if (!existing.lastWorkingFormat && localSamples < 2 && (incoming.confidenceScore || 0) >= 55) {
        existing.bestFormat = incoming.bestFormat;
        existing.bestBufferProfile = bp;
        existing.bestBufferAheadSeconds = Math.max(
          MIN_SAFE_BUFFER_SECONDS,
          Math.min(
            MAX_SAFE_BUFFER_SECONDS,
            Number(incoming.bestBufferAheadSeconds) || DOCTOR_BUFFER_CONFIGS[bp].minBufferAheadSeconds,
          ),
        );
      }
      if (existing.tsAvgStartupMs === null && incTsAvg !== null) {
        existing.tsAvgStartupMs = incTsAvg;
      }
      if (existing.hlsAvgStartupMs === null && incHlsAvg !== null) {
        existing.hlsAvgStartupMs = incHlsAvg;
      }
      /*
       * 2.5.294: a felhőből érkező útvonalakat összefésüljük a helyiekkel –
       * a legjobb 8 marad meg. A helyi, friss mérés nem veszik el: a
       * számlálókat a nagyobb érték, az indulási időket a jobb érték nyeri.
       */
      if (incomingRoutes.length > 0) {
        const byId = new Map<string, DoctorRoute>();
        for (const route of sanitizeDoctorRoutes(existing.routes)) byId.set(route.id, route);
        for (const route of incomingRoutes) {
          const local = byId.get(route.id);
          if (!local) {
            byId.set(route.id, route);
            continue;
          }
          byId.set(route.id, {
            ...local,
            ok: Math.max(local.ok, route.ok),
            fail: Math.max(local.fail, route.fail),
            stalls: Math.max(local.stalls, route.stalls),
            avgStartupMs: local.avgStartupMs === null
              ? route.avgStartupMs
              : (route.avgStartupMs === null ? local.avgStartupMs : Math.min(local.avgStartupMs, route.avgStartupMs)),
            bestStartupMs: local.bestStartupMs === null
              ? route.bestStartupMs
              : (route.bestStartupMs === null ? local.bestStartupMs : Math.min(local.bestStartupMs, route.bestStartupMs)),
            lastOkAt: Math.max(local.lastOkAt || 0, route.lastOkAt || 0) || null,
            lastFailAt: Math.max(local.lastFailAt || 0, route.lastFailAt || 0) || null,
          });
        }
        existing.routes = rankDoctorRouteList([...byId.values()]);
      }
      existing.confidence = incoming.confidenceScore ?? existing.confidence;
      existing.source = 'merged';
      mergedCount += 1;
    }
  }

  if (mergedCount > 0) {
    writeStore(store, storage);
    // A TV Doktor ablak feliratkozott nézete is frissüljön a felhőből érkező adatok után.
    notifyTvDoctorListeners();
  }
  return mergedCount;
}

/**
 * 2.5.294: a Supabase felhő-memóriából visszaolvasott tanult útvonalak
 * összefésülése. Csak magyar, már ismert csatornákhoz írunk (a nem magyar és a
 * Mozi/Sorozat bejegyzések kimaradnak), csatornánként legfeljebb 8 útvonal
 * marad. A helyi mérés soha nem veszik el: a számlálók maximuma, az indulási
 * idők minimuma érvényesül.
 */
export function mergeCloudRoutesIntoLocal(
  rows: Array<{ channel_key?: string; country_code?: string; routes?: unknown }>,
  storage?: Storage | null,
): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const store = readStore(storage);
  let mergedCount = 0;

  for (const row of rows.slice(0, 600)) {
    if (!row || typeof row !== 'object') continue;
    const key = String(row.channel_key || '').slice(0, 120);
    if (!key || key.startsWith('vod:')) continue;
    // 2.5.310: HU felismerés kulcs-előtaggal is, és IPK-újraindításkor a Supabase-ből akkor is visszaállítjuk a 8 tanult útvonalat, ha a helyi tárhely üres volt
    if (!isPersistableDoctorRecord({ countryCode: String(row.country_code || ''), channelKey: key, channelName: key } as any)) continue;
    const incoming = sanitizeDoctorRoutes(row.routes);
    if (incoming.length === 0) continue;
    let existing = store.byKey[key];
    if (!existing) {
      const bestRoute = rankDoctorRouteList(incoming)[0];
      const bp: DoctorBufferProfileId = bestRoute ? bestRoute.bufferProfile : 'balanced';
      const cfg = DOCTOR_BUFFER_CONFIGS[bp] || DOCTOR_BUFFER_CONFIGS.balanced;
      // Összesített számlálók a bejövő útvonalakból – hogy a launch-plan azonnal használhassa
      let tsOk = 0; let tsFail = 0; let hlsOk = 0; let hlsFail = 0; let stalls = 0;
      for (const r of incoming) {
        if (r.format === 'ts') { tsOk += r.ok; tsFail += r.fail; } else { hlsOk += r.ok; hlsFail += r.fail; }
        stalls += r.stalls;
      }
      const newRec: ChannelDoctorRecord = {
        channelKey: key,
        channelName: key,
        countryCode: 'HU',
        bestFormat: bestRoute ? bestRoute.format : 'ts',
        bestBufferProfile: bp,
        bestBufferAheadSeconds: cfg.minBufferAheadSeconds,
        tsAvgStartupMs: bestRoute && bestRoute.format === 'ts' && bestRoute.avgStartupMs ? bestRoute.avgStartupMs : null,
        hlsAvgStartupMs: bestRoute && bestRoute.format === 'hls' && bestRoute.avgStartupMs ? bestRoute.avgStartupMs : null,
        bestStartupMs: bestRoute ? bestRoute.bestStartupMs : null,
        tsOk, tsFail, hlsOk, hlsFail, stalls, repairsOk: 0,
        bufferStats: {},
        routes: incoming,
        source: 'cloud',
        updatedAt: Date.now(),
      };
      store.byKey[key] = newRec;
      mergedCount += 1;
      continue;
    }

    const byId = new Map<string, DoctorRoute>();
    for (const route of sanitizeDoctorRoutes(existing.routes)) byId.set(route.id, route);
    for (const route of incoming) {
      const local = byId.get(route.id);
      if (!local) {
        byId.set(route.id, route);
        continue;
      }
      byId.set(route.id, {
        ...local,
        ok: Math.max(local.ok, route.ok),
        fail: Math.max(local.fail, route.fail),
        stalls: Math.max(local.stalls, route.stalls),
        avgStartupMs: local.avgStartupMs === null
          ? route.avgStartupMs
          : (route.avgStartupMs === null ? local.avgStartupMs : Math.min(local.avgStartupMs, route.avgStartupMs)),
        bestStartupMs: local.bestStartupMs === null
          ? route.bestStartupMs
          : (route.bestStartupMs === null ? local.bestStartupMs : Math.min(local.bestStartupMs, route.bestStartupMs)),
        lastOkAt: Math.max(local.lastOkAt || 0, route.lastOkAt || 0) || null,
        lastFailAt: Math.max(local.lastFailAt || 0, route.lastFailAt || 0) || null,
      });
    }
    existing.routes = rankDoctorRouteList([...byId.values()]);
    mergedCount += 1;
  }

  if (mergedCount > 0) {
    writeStore(store, storage);
    // A TV Doktor ablak feliratkozott nézete is frissüljön, ha a felhőből később érkeznek meg az útvonalak.
    notifyTvDoctorListeners();
  }
  return mergedCount;
}

/** 8. Fejleszthető rendszer: új diagnosztikai és javító modulok regisztrálása. */
export function registerDoctorDiagnosticPlugin(plugin: DoctorDiagnosticPlugin): () => void {
  const idx = diagnosticPlugins.findIndex((p) => p.id === plugin.id);
  if (idx >= 0) diagnosticPlugins.splice(idx, 1);
  diagnosticPlugins.push(plugin);
  return () => {
    const pos = diagnosticPlugins.findIndex((p) => p.id === plugin.id);
    if (pos >= 0) diagnosticPlugins.splice(pos, 1);
  };
}

registerDoctorDiagnosticPlugin({
  id: 'video-quality-health',
  collect: ({ streamState }) => {
    const decoded = streamState.decodedFrames ?? 0;
    const dropped = streamState.droppedFrames ?? 0;
    const dropPct = decoded > 0 ? Math.round((dropped / decoded) * 1000) / 10 : 0;
    return {
      resolution: `${streamState.videoWidth}x${streamState.videoHeight}`,
      frameDropPercent: dropPct,
    };
  },
});

/* ============================================================================
 * VOD (FILMEK ÉS SOROZATOK) TV DOKTOR TÁMOGATÁS (MEMÓRIAMENTÉS NÉLKÜL)
 * ============================================================================ */

const EPHEMERAL_VOD_BUCKET_KEY = '__vod_ephemeral_assist__';

function vodFormatTag(streamUrl?: string): LiveFormat {
  return /\.m3u8(?=([?#]|$))/i.test(String(streamUrl || '')) ? 'hls' : 'ts';
}

export function selectVodLaunchPlan(
  target: VodDoctorTarget | null | undefined,
  settings: Pick<AppSettings, 'bufferMode' | 'tvDoctorEnabled'>,
  _storage?: Storage | null,
): VodLaunchPlan {
  const startedAt = nowPerfMs();
  const baseBufferMode: BufferMode = settings.bufferMode || 'balanced';
  const defaultTiming = bufferProfileTiming(baseBufferMode);
  const vodKey = normalizeVodDoctorKey(target);
  const fmt = vodFormatTag(target?.streamUrl);
  const enabled = settings.tvDoctorEnabled !== false;

  if (!enabled || !target || (!target.streamUrl && !target.title)) {
    return {
      enabled: false,
      hasLearnedProfile: false,
      vodKey,
      streamFormat: fmt,
      bufferProfileId: baseBufferMode,
      bufferTiming: defaultTiming,
      startupWatchdogMs: 8500,
      expectedStartupMs: null,
      reason: 'alapértelmezett VOD lejátszási mód',
    };
  }

  opHealth.decisionsCount += 1;
  const elapsed = nowPerfMs() - startedAt;
  recordDoctorOpTiming('selectVodLaunchPlan', elapsed);

  return {
    enabled: true,
    hasLearnedProfile: false,
    vodKey,
    streamFormat: fmt,
    bufferProfileId: baseBufferMode,
    bufferTiming: defaultTiming,
    startupWatchdogMs: 8500,
    expectedStartupMs: null,
    reason: 'folyamatos VOD lejátszás-segítés (memóriamentés nélkül)',
  };
}

export function recordDoctorVodSuccess(params: {
  target?: VodDoctorTarget | null;
  bufferProfile: DoctorBufferProfileId;
  startupMs: number;
  wasRepair?: boolean;
  storage?: Storage | null;
}): ChannelDoctorRecord | null {
  if (params?.wasRepair) {
    opHealth.repairsVerifiedCount += 1;
  }
  return null;
}

export function recordDoctorVodFailure(_params: {
  target?: VodDoctorTarget | null;
  bufferProfile: DoctorBufferProfileId;
  trigger: DoctorTriggerReason;
  errorCode?: string | null;
  errorDetail?: string | null;
  stallMs?: number;
  storage?: Storage | null;
}): ChannelDoctorRecord | null {
  return null;
}

export function planVodDoctorRepairStep(params: {
  target?: VodDoctorTarget | null;
  trigger: DoctorTriggerReason;
  step: number;
  currentBufferProfile: DoctorBufferProfileId;
  streamUrl: string;
  resumePositionSeconds?: number;
  storage?: Storage | null;
}): DoctorRepairProposal {
  const {
    trigger,
    step,
    currentBufferProfile,
    streamUrl,
  } = params;

  const fmt = vodFormatTag(streamUrl);

  if (step > MAX_DOCTOR_REPAIR_STEPS || !canDoctorIntervene(EPHEMERAL_VOD_BUCKET_KEY)) {
    const safeCfg = getDoctorBufferConfig(currentBufferProfile);
    return {
      step,
      maxSteps: MAX_DOCTOR_REPAIR_STEPS,
      strategyId: 'vod_fallback_recovery',
      description: 'kímélő VOD újracsatlakozás',
      nextFormat: fmt,
      nextUrl: streamUrl,
      nextBufferProfile: safeCfg.id,
      nextBufferTiming: safeCfg,
      delayMs: 1600,
      useFallbackUrl: false,
      forceCleanReset: true,
      stopRetrying: true,
      exhausted: true,
    };
  }

  markIntervention(EPHEMERAL_VOD_BUCKET_KEY);
  opHealth.repairsAttemptedCount += 1;

  const isStall = trigger === 'playback_stall' || trigger === 'buffer_stall';
  let nextBufferProfile: DoctorBufferProfileId = currentBufferProfile;
  let strategyId = 'vod_resume_retry';
  let delayMs = 220;

  if (step === 1) {
    nextBufferProfile = isStall ? nextSafeBufferProfile(currentBufferProfile) : currentBufferProfile;
    strategyId = isStall ? 'vod_buffer_step_up' : 'vod_quick_reconnect';
    delayMs = 200;
  } else if (step <= 3) {
    nextBufferProfile = nextSafeBufferProfile(currentBufferProfile);
    strategyId = 'vod_progressive_buffer';
    delayMs = 380;
  } else {
    nextBufferProfile = step === 4 ? nextSafeBufferProfile(nextSafeBufferProfile(currentBufferProfile)) : 'adaptive-3';
    strategyId = 'vod_protected_ceiling';
    delayMs = 600;
  }

  const nextCfg = getDoctorBufferConfig(nextBufferProfile);
  const description = `puffer=${nextCfg.minBufferAheadSeconds} mp`;

  return {
    step,
    maxSteps: MAX_DOCTOR_REPAIR_STEPS,
    strategyId,
    description,
    nextFormat: fmt,
    nextUrl: streamUrl,
    nextBufferProfile,
    nextBufferTiming: nextCfg,
    delayMs,
    useFallbackUrl: false,
    forceCleanReset: true,
    stopRetrying: false,
    exhausted: false,
  };
}
