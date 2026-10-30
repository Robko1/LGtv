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
  mediaProgressed,
} from './playbackRecovery';
import { appLog, isVerbosePlaybackLogging } from './appLog';

/**
 * TV Doktor – intelligens, önfejlesztő diagnosztikai, csatornaváltás-gyorsító és EPG-felügyelő rendszer.
 *
 * Feladatai:
 *  1. Villámgyors csatornaváltás: csatornánként pontosan megjegyzi a legutóbb ténylegesen működő
 *     és leggyorsabb lejátszási formátumot (TS / HLS) + pufferprofilt (instant / turbo / fast / ...),
 *     és újranyitáskor késlekedés nélkül azonnal azt alkalmazza.
 *  2. Több különböző beállítás gyors kipróbálása: indulási vagy lejátszási hiba esetén nem ismételgeti
 *     lassan ugyanazt a beállítást, hanem gyorsan végigpróbál több eltérő formátum- és pufferprofilt.
 *  3. Valóban nem működő csatornák leállítása: korlátozott számú gyors beállításpróba után leállítja
 *     az újrapróbálást, így soha nem pörög végtelen ciklusban egy halott csatornán.
 *  4. 1 MB (1024 KB) dedikált, aszinkron háttér-memória: bőséges hely a tanult csatornaprofiloknak és
 *     EPG-állapotoknak anélkül, hogy a localStorage írás valaha is megakasztaná a csatornaváltást.
 *  5. EPG-ellenőrzés és csatornánkénti lekapcsolás: figyeli az EPG betöltését, elakadásnál segíti az
 *     újratöltést, ha pedig egy csatornához igazoltan nincs EPG, lekapcsolja az EPG-keresést nála.
 *  6. Színkódolt eseménykategóriák: külön követi és jelzi a Tanulás, Segítség/Javítás, Aktiválódás
 *     és Csatornahiba eseményeket.
 */

export const TV_DOCTOR_STORAGE_KEY = 'iptv_rt_tv_doctor_v1';
export const TV_DOCTOR_SYNC_STORAGE_KEY = 'iptv_rt_tv_doctor_sync_v1';
export const TV_DOCTOR_DIAG_LOGGING_KEY = 'iptv_rt_tv_doctor_diag_log_v1';

/** Korlátok a TV erőforrásainak és a localStorage kvótának a védelmére (1 MB dedikált keret). */
export const MAX_LEARNED_CHANNELS = 1600;
export const MAX_LEARNED_EPG_CHANNELS = 2400;
export const MAX_SAFE_DOCTOR_STORAGE_BYTES = 1024 * 1024; // 1 MB (1024 KB)
export const WEBOS_LOCAL_STORAGE_QUOTA_BYTES = 5 * 1024 * 1024;
export const DOCTOR_SLOW_OP_THRESHOLD_MS = 25;
export const MAX_DOCTOR_REPAIR_STEPS = 5;
export const MAX_DEAD_CHANNEL_QUICK_STEPS = 2;
export const MAX_INTERVENTIONS_PER_MINUTE = 8;
export const DOCTOR_VERIFY_STABLE_MS = 2200;
export const DEAD_CHANNEL_COOLDOWN_MS = 3 * 60 * 1000;
export const EPG_DISABLED_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_EPG_ASSIST_PER_WINDOW = 2;
export const EPG_ASSIST_WINDOW_MS = 10 * 60 * 1000;
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
 *  - learning: Tanulás (csatornasebesség, működő formátum/puffer, EPG-mentes csatorna megtanulása)
 *  - assistance: Segítség / Javítás (formátumváltás, pufferemelés, sikeres javítás, EPG újratöltés)
 *  - activation: Aktiválódás (TV Doktor közbelépés indulási hiba, fagyás vagy EPG-kimaradás miatt)
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
  stalls: number;
  repairsOk: number;
  bufferStats: Partial<Record<DoctorBufferProfileId, BufferProfileStats>>;
  lastErrorCode?: string;
  lastErrorReason?: string;
  source?: 'local' | 'cloud' | 'merged';
  confidence?: number;
  updatedAt: number;
}

export interface ChannelEpgDoctorRecord {
  channelKey: string;
  channelId?: string;
  channelName: string;
  state: 'ok' | 'empty' | 'disabled';
  emptyChecks: number;
  updatedAt: number;
}

export interface TvDoctorEpgStats {
  disabledChannelCount: number;
  okChannelCount: number;
  assistCount: number;
  lastAssistAt: number | null;
  lastRecoveredAt: number | null;
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

export interface ChannelLaunchPlan {
  enabled: boolean;
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
  at: number;
  level: 'info' | 'warn' | 'repair' | 'verified' | 'error';
  category: DoctorEventCategory;
  channelKey: string;
  channelName: string;
  message: string;
}

export interface DoctorDiagnosticPlugin {
  id: string;
  collect: (context: {
    channel?: Channel | null;
    format: LiveFormat;
    streamState: DoctorStreamStateSnapshot;
  }) => Record<string, string | number | boolean>;
}

export interface DoctorRepairPlugin {
  id: string;
  priority: number;
  propose: (context: {
    channel?: Channel | null;
    trigger: DoctorTriggerReason;
    step: number;
    currentFormat: LiveFormat;
    currentBufferProfile: DoctorBufferProfileId;
    tsUrl: string;
    hlsUrl: string;
    hasAlternateFormat: boolean;
    record: ChannelDoctorRecord | null;
  }) => Partial<DoctorRepairProposal> | null;
}

interface DoctorStoreData {
  v: 1;
  byKey: Record<string, ChannelDoctorRecord>;
  idIndex: Record<string, string>;
  epgByKey: Record<string, ChannelEpgDoctorRecord>;
  epgIdIndex: Record<string, string>;
  categoryStats: DoctorCategoryStats;
  epgAssistCount: number;
  epgLastAssistAt: number | null;
  epgLastRecoveredAt: number | null;
}

export interface TvDoctorMemoryStats {
  learnedChannelCount: number;
  maxLearnedChannels: number;
  disabledEpgChannelCount: number;
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
  epgDisabledCount: number;
  epgAssistsCount: number;
  lastStorageError: { location: string; message: string; at: number } | null;
}

const MAX_RECENT_LOGS = 80;
const recentDoctorLogs: DoctorLogEntry[] = [];
const diagnosticPlugins: DoctorDiagnosticPlugin[] = [];
const repairPlugins: DoctorRepairPlugin[] = [];
const interventionTimestampsByChannel = new Map<string, number[]>();
const epgAssistTimestamps: number[] = [];
const statusListeners: Array<() => void> = [];

let memoryCache: DoctorStoreData | null = null;
let memoryCacheSerializedChars = 0;
let pendingPersistTimer: ReturnType<typeof setTimeout> | null = null;
let lifecyclePersistAttached = false;
let diagLoggingCache: boolean | null = null;

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
  epgDisabledCount: 0,
  epgAssistsCount: 0,
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

export function notifyTvDoctorListeners(): void {
  for (let i = 0; i < statusListeners.length; i += 1) {
    try {
      statusListeners[i]?.();
    } catch {
      /* ignore listener errors */
    }
  }
}

export function isTvDoctorDiagLoggingEnabled(storage?: Storage | null): boolean {
  if (!storage && diagLoggingCache !== null) return diagLoggingCache;
  try {
    const target = storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null);
    const raw = target?.getItem(TV_DOCTOR_DIAG_LOGGING_KEY);
    const enabled = raw !== '0' && raw !== 'false';
    if (!storage) diagLoggingCache = enabled;
    return enabled;
  } catch {
    return true;
  }
}

export function setTvDoctorDiagLoggingEnabled(enabled: boolean, storage?: Storage | null): void {
  if (!storage) diagLoggingCache = enabled;
  try {
    const target = storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null);
    target?.setItem(TV_DOCTOR_DIAG_LOGGING_KEY, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (isVerbosePlaybackLogging()) {
    appLog(`TV DOKTOR NAPLÓZÁSI BEÁLLÍTÁS: ${enabled ? 'BEKAPCSOLVA (működés és elakadás rögzítése aktív)' : 'KIKAPCSOLVA'}`);
  }
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
    epgDisabledCount: opHealth.epgDisabledCount,
    epgAssistsCount: opHealth.epgAssistsCount,
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
  opHealth.epgDisabledCount = 0;
  opHealth.epgAssistsCount = 0;
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
    | 'epg_assist'
    | 'epg_disabled';
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

export function prevFasterBufferProfile(current: DoctorBufferProfileId): DoctorBufferProfileId {
  const idx = DOCTOR_BUFFER_ORDER.indexOf(current);
  if (idx <= 0) return 'instant';
  return DOCTOR_BUFFER_ORDER[idx - 1];
}

function getStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function createEmptyStore(): DoctorStoreData {
  return {
    v: 1,
    byKey: {},
    idIndex: {},
    epgByKey: {},
    epgIdIndex: {},
    categoryStats: createEmptyCategoryStats(),
    epgAssistCount: 0,
    epgLastAssistAt: null,
    epgLastRecoveredAt: null,
  };
}

function isValidFormat(value: unknown): value is LiveFormat {
  return value === 'ts' || value === 'hls';
}

function isValidBufferProfile(value: unknown): value is DoctorBufferProfileId {
  return typeof value === 'string' && (DOCTOR_BUFFER_ORDER as readonly string[]).indexOf(value) >= 0;
}

function sanitizePositiveStartupMs(raw: unknown, okCount: number): number | null {
  if (okCount <= 0) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  // A korábbi szerver-oldali clampInt(null, 20, ...) hiba 20 ms-os helyőrzőt írt be.
  // Valódi hálózati stream indulás TV-n nem 20 ms, ha mellette másik valós mérés van.
  return Math.max(20, Math.min(60000, Math.round(raw)));
}

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
        stalls: Math.max(0, Number(v.stalls) || 0),
        repairsOk: Math.max(0, Number(v.repairsOk) || 0),
        bufferStats: v.bufferStats && typeof v.bufferStats === 'object' ? v.bufferStats : {},
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

    const cleanEpgByKey: Record<string, ChannelEpgDoctorRecord> = {};
    const cleanEpgIdIndex: Record<string, string> = {};
    if (parsed.epgByKey && typeof parsed.epgByKey === 'object') {
      for (const [ek, ev] of Object.entries(parsed.epgByKey as Record<string, any>)) {
        if (!ek || !ev || typeof ev !== 'object' || ek.startsWith('vod:')) continue;
        const state = ev.state === 'disabled' || ev.state === 'ok' ? ev.state : 'empty';
        const epgRec: ChannelEpgDoctorRecord = {
          channelKey: String(ev.channelKey || ek).slice(0, 120),
          channelId: typeof ev.channelId === 'string' ? ev.channelId.slice(0, 120) : undefined,
          channelName: String(ev.channelName || ek).slice(0, 140),
          state,
          emptyChecks: Math.max(0, Number(ev.emptyChecks) || 0),
          updatedAt: typeof ev.updatedAt === 'number' ? ev.updatedAt : 0,
        };
        cleanEpgByKey[epgRec.channelKey] = epgRec;
        if (epgRec.channelId) cleanEpgIdIndex[epgRec.channelId] = epgRec.channelKey;
      }
    }
    if (parsed.epgIdIndex && typeof parsed.epgIdIndex === 'object') {
      for (const [cid, ckey] of Object.entries(parsed.epgIdIndex as Record<string, unknown>)) {
        if (typeof ckey === 'string' && cleanEpgByKey[ckey]) {
          cleanEpgIdIndex[cid] = ckey;
        }
      }
    }

    const loaded: DoctorStoreData = {
      v: 1,
      byKey: cleanByKey,
      idIndex: cleanIdIndex,
      epgByKey: cleanEpgByKey,
      epgIdIndex: cleanEpgIdIndex,
      categoryStats: sanitizeCategoryStats(parsed.categoryStats),
      epgAssistCount: Math.max(0, Number(parsed.epgAssistCount) || 0),
      epgLastAssistAt: typeof parsed.epgLastAssistAt === 'number' ? parsed.epgLastAssistAt : null,
      epgLastRecoveredAt: typeof parsed.epgLastRecoveredAt === 'number' ? parsed.epgLastRecoveredAt : null,
    };
    if (hadLegacyVod) {
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

  const epgKeys = Object.keys(store.epgByKey);
  if (epgKeys.length > MAX_LEARNED_EPG_CHANNELS) {
    const sortedEpg = epgKeys.sort(
      (a, b) => (store.epgByKey[b]?.updatedAt || 0) - (store.epgByKey[a]?.updatedAt || 0),
    );
    const keepEpg = new Set(sortedEpg.slice(0, MAX_LEARNED_EPG_CHANNELS));
    for (const ek of epgKeys) {
      if (!keepEpg.has(ek)) delete store.epgByKey[ek];
    }
    for (const [cid, ckey] of Object.entries(store.epgIdIndex)) {
      if (!keepEpg.has(ckey)) delete store.epgIdIndex[cid];
    }
  }
}

function persistStoreNow(store: DoctorStoreData, target: Storage): void {
  const startedAt = nowPerfMs();
  try {
    let serialized = JSON.stringify(store);
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
      serialized = JSON.stringify(store);
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
      const fallbackJson = JSON.stringify(store);
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
  epgAssistTimestamps.length = 0;
  recentDoctorLogs.length = 0;
  opHealth.lastStorageError = null;
  resetTvDoctorOperationCounters();
  const target = getStorage(storage);
  try {
    target?.removeItem(TV_DOCTOR_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  if (isTvDoctorDiagLoggingEnabled()) {
    appLog('TV DOKTOR MEMÓRIA: a helyi tanuló memória, kategória-számlálók és EPG-tiltások 0 állapotra törölve.');
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

export function getTvDoctorEpgStats(storage?: Storage | null): TvDoctorEpgStats {
  const store = readStore(storage);
  let disabledChannelCount = 0;
  let okChannelCount = 0;
  const now = Date.now();
  for (const item of Object.values(store.epgByKey)) {
    if (item.state === 'disabled' && now - item.updatedAt < EPG_DISABLED_TTL_MS) {
      disabledChannelCount += 1;
    } else if (item.state === 'ok') {
      okChannelCount += 1;
    }
  }
  return {
    disabledChannelCount,
    okChannelCount,
    assistCount: store.epgAssistCount || 0,
    lastAssistAt: store.epgLastAssistAt,
    lastRecoveredAt: store.epgLastRecoveredAt,
  };
}

export function getTvDoctorMemoryStats(storage?: Storage | null): TvDoctorMemoryStats {
  const store = readStore(storage);
  const learnedChannelCount = Object.keys(store.byKey).length;
  const epgStats = getTvDoctorEpgStats(storage);
  const target = getStorage(storage);

  let doctorStoreBytes = 0;
  let cloudQueueBytes = 0;
  let tvStorageUsedBytes = 0;
  const hasAnyDoctorData =
    learnedChannelCount > 0 ||
    Object.keys(store.epgByKey).length > 0 ||
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
    maxLearnedChannels: MAX_LEARNED_CHANNELS,
    disabledEpgChannelCount: epgStats.disabledChannelCount,
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
  epgStats: TvDoctorEpgStats;
} {
  const store = readStore(storage);
  const records = Object.values(store.byKey);
  let totalVerifiedRepairs = 0;
  for (const rec of records) {
    totalVerifiedRepairs += rec.repairsOk || 0;
  }
  return {
    learnedChannelCount: records.length,
    totalVerifiedRepairs,
    recentLogs: recentDoctorLogs.slice(-MAX_RECENT_LOGS),
    categoryStats: getTvDoctorCategoryStats(storage),
    epgStats: getTvDoctorEpgStats(storage),
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
    if (byId) return byId;
  }
  const key = normalizeChannelDoctorKey(channel);
  return store.byKey[key] || null;
}

export function isChannelHandledByDoctor(
  channel?: Pick<Channel, 'id' | 'name' | 'countryCode'> | null,
  storage?: Storage | null,
): boolean {
  const rec = getChannelDoctorRecord(channel, storage);
  return isDoctorRecordHandled(rec);
}

/**
 * Igaz, ha a csatorna a legutóbbi többlépcsős vizsgálat alapján valóban
 * nem működik (halott stream), és még a védőablakon belül van.
 */
export function isChannelMarkedDead(
  channel?: Pick<Channel, 'id' | 'name' | 'countryCode'> | null,
  now = Date.now(),
  storage?: Storage | null,
): boolean {
  const rec = getChannelDoctorRecord(channel, storage);
  if (!rec || !rec.deadUntil) return false;
  return rec.deadUntil > now;
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
): void {
  const bucket = store.categoryStats[category];
  bucket.count += 1;
  bucket.lastAt = at;
  bucket.lastChannelName = channelName.slice(0, 120);
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
  recordCategoryTick(store, category, channelName, at);

  recentDoctorLogs.push({
    at,
    level,
    category,
    channelKey,
    channelName,
    message,
  });
  if (recentDoctorLogs.length > MAX_RECENT_LOGS) {
    recentDoctorLogs.splice(0, recentDoctorLogs.length - MAX_RECENT_LOGS);
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
    const maxRepairSteps = isRecentlyDead && totalLifetimeOk === 0
      ? MAX_DEAD_CHANNEL_QUICK_STEPS
      : MAX_DOCTOR_REPAIR_STEPS;

    const chosenFormat: LiveFormat = supportsDualFormat
      ? pickFastestReliableFormat(record, fallbackPrimary)
      : fallbackPrimary;

    // Szinkronban tartjuk a VideoPlayer helyi formátum-emlékével is (csak ha a TV Doktor be van kapcsolva!).
    if (channel.id && !storage && totalLifetimeOk > 0) {
      rememberFormatFor(channel.id, chosenFormat);
    }

    const chosenBufferProfile = evaluateBestBufferProfile(
      record.bufferStats,
      record.bestBufferProfile || record.lastWorkingBufferProfile || baseBufferMode,
    );
    const hasCustomBufferExperience =
      Object.keys(record.bufferStats || {}).length > 0 ||
      record.source === 'cloud' ||
      record.stalls > 0 ||
      record.repairsOk > 0 ||
      totalLifetimeOk > 0;

    const doctorCfg = getDoctorBufferConfig(chosenBufferProfile);
    const rawExpectedMs = chosenFormat === 'hls' ? record.hlsAvgStartupMs : record.tsAvgStartupMs;
    const expectedStartupMs = rawExpectedMs !== null && rawExpectedMs > 20 ? rawExpectedMs : null;

    const chosenOkCount = chosenFormat === 'hls' ? record.hlsOk : record.tsOk;
    const chosenConsecFail = chosenFormat === 'hls' ? (record.hlsConsecutiveFail || 0) : (record.tsConsecutiveFail || 0);
    const directFastStart = !isRecentlyDead && chosenOkCount >= 1 && chosenConsecFail === 0;

    // Kalibrált indulási őr: ha a csatorna pl. 450 ms alatt szokott indulni,
    // nem várunk 2000 ms-ot hiba esetén, hanem ~900 ms után már lépünk is!
    const calibratedWatchdogMs = expectedStartupMs !== null && directFastStart
      ? Math.max(
          MIN_SAFE_STARTUP_WATCHDOG_MS,
          Math.min(doctorCfg.startupWatchdogMs, Math.round(expectedStartupMs * 1.55 + 220)),
        )
      : doctorCfg.startupWatchdogMs;

    const chosenTiming: BufferProfileTiming = hasCustomBufferExperience
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
      directFastStart,
      skipSameFormatRetry: true,
      isRecentlyDead,
      maxRepairSteps,
      channelKey,
      primaryFormat: chosenFormat,
      alternateFormat: supportsDualFormat ? (chosenFormat === 'hls' ? 'ts' : 'hls') : null,
      bufferProfileId: hasCustomBufferExperience ? chosenBufferProfile : baseBufferMode,
      bufferTiming: chosenTiming,
      expectedStartupMs,
      reason: isRecentlyDead
        ? `korábban nem működő csatorna – rövidített (${maxRepairSteps} lépéses) gyors ellenőrzés`
        : `tanult gyorsprofil (${chosenFormat.toUpperCase()}, puffer=${chosenBufferProfile}${expectedStartupMs ? `, ~${expectedStartupMs}ms` : ''})`,
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
  if (
    consecutiveStallTicks <= 1 &&
    streamState.readyState === 4 &&
    !streamState.waitingOrStalled &&
    streamState.networkState !== 3 &&
    healthyBuffer
  ) {
    if (isVerbosePlaybackLogging() && isTvDoctorDiagLoggingEnabled()) {
      appLog(
        `TV DOKTOR FAGYÁSVIZSGÁLAT: állókép-védelem (tartalék=${streamState.bufferedAheadSeconds.toFixed(1)}mp, readyState=4) – megerősítésre vár`,
      );
    }
    return {
      intervene: false,
      reason: 'állókép-védelem: egészséges puffer és readyState=4, megerősítésre vár',
    };
  }

  opHealth.confirmedFreezesCount += 1;
  const detail = streamState.waitingOrStalled || streamState.bufferedAheadSeconds < 0.3
    ? 'adatfolyam-megakadás (kiürült puffer)'
    : 'dekóder-/képkocka-fagyás megerősítve';
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
    storage,
  } = params;

  const channelKey = normalizeChannelDoctorKey(channel);
  const hasAlternateFormat = Boolean(tsUrl && hlsUrl && tsUrl !== hlsUrl);
  const altFormat: LiveFormat = currentFormat === 'hls' ? 'ts' : 'hls';
  // Az elsődleges (csatorna-saját) formátum: a 2. lépésben bekapcsolt alternatív
  // formátumra való visszaesés után a 3. lépésben vissza kell térni rá, ne maradjon
  // az alternatívon (currentFormat), mert az már egyszer meghibásodott.
  const primaryFormat: LiveFormat = formatOfUrl(streamUrl) || currentFormat;
  const urlFor = (fmt: LiveFormat) => (fmt === 'hls' ? hlsUrl : tsUrl) || streamUrl;
  const store = readStore(storage);
  const record = getChannelDoctorRecord(channel, storage);
  const effectiveMaxSteps = Math.max(
    1,
    Math.min(MAX_DOCTOR_REPAIR_STEPS, maxStepsOverride || MAX_DOCTOR_REPAIR_STEPS),
  );

  // Ha minden különböző beállítást kipróbáltunk és a csatorna nem működik,
  // VÉGLEGESEN LEÁLLÍTJUK az újrapróbálást (nincs végtelen újracsatlakozási ciklus!).
  if (step > effectiveMaxSteps || !canDoctorIntervene(channelKey)) {
    const safeCfg = getDoctorBufferConfig(record?.bestBufferProfile || currentBufferProfile);
    opHealth.deadChannelsHaltedCount += 1;

    if (channel) {
      const rec = getOrCreateRecord(store, channel, currentFormat, currentBufferProfile);
      rec.deadUntil = Date.now() + DEAD_CHANNEL_COOLDOWN_MS;
      rec.lastErrorCode = 'CHANNEL_UNREACHABLE';
      rec.lastErrorReason = `${effectiveMaxSteps} különböző beállítás sikertelen (${trigger})`;
      rec.updatedAt = Date.now();
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

  // Regisztrált bővítmények (pluginek) megkérdezése prioritási sorrendben:
  const sortedPlugins = [...repairPlugins].sort((a, b) => b.priority - a.priority);
  for (const plugin of sortedPlugins) {
    try {
      const custom = plugin.propose({
        channel,
        trigger,
        step,
        currentFormat,
        currentBufferProfile,
        tsUrl,
        hlsUrl,
        hasAlternateFormat,
        record,
      });
      if (custom && custom.nextFormat && custom.nextUrl && custom.nextBufferProfile) {
        const cfg = getDoctorBufferConfig(custom.nextBufferProfile);
        return {
          step,
          maxSteps: effectiveMaxSteps,
          strategyId: custom.strategyId || plugin.id,
          description: custom.description || `bővítmény javítás (${plugin.id})`,
          nextFormat: custom.nextFormat,
          nextUrl: custom.nextUrl,
          nextBufferProfile: cfg.id,
          nextBufferTiming: custom.nextBufferTiming ? clampBufferTiming(custom.nextBufferTiming) : cfg,
          delayMs: custom.delayMs ?? 120,
          useFallbackUrl: Boolean(custom.useFallbackUrl),
          forceCleanReset: Boolean(custom.forceCleanReset ?? true),
          stopRetrying: false,
          exhausted: false,
        };
      }
    } catch {
      /* ignore plugin error */
    }
  }

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
    // Megakadás/fagyás esetén 5 különböző beállítás gyors egymásutánban:
    if (step === 1) {
      nextBufferProfile = nextSafeBufferProfile(currentBufferProfile);
      strategyId = 'buffer_step_up';
      description = `puffer növelése (${currentBufferProfile} -> ${nextBufferProfile})`;
      delayMs = 80;
    } else if (step === 2 && hasAlternateFormat) {
      nextFormat = altFormat;
      nextUrl = urlFor(altFormat);
      nextBufferProfile = nextSafeBufferProfile(currentBufferProfile);
      strategyId = 'switch_format_with_buffer';
      description = `formátumváltás (${altFormat.toUpperCase()}) + emelt puffer (${nextBufferProfile})`;
      delayMs = 100;
    } else if (step === 3) {
      nextBufferProfile = nextSafeBufferProfile(nextSafeBufferProfile(currentBufferProfile));
      nextFormat = currentFormat;
      nextUrl = urlFor(nextFormat);
      strategyId = 'progressive_buffer_tuning';
      description = `fokozatos pufferfinomhangolás (${nextFormat.toUpperCase()}, ${getDoctorBufferConfig(nextBufferProfile).minBufferAheadSeconds}mp)`;
      delayMs = 150;
    } else if (step === 4) {
      nextBufferProfile = nextSafeBufferProfile(nextSafeBufferProfile(nextSafeBufferProfile(currentBufferProfile)));
      nextFormat = hasAlternateFormat ? altFormat : currentFormat;
      nextUrl = urlFor(nextFormat);
      strategyId = 'alt_progressive_buffer';
      description = `stabilizált mód (${nextFormat.toUpperCase()}, ${getDoctorBufferConfig(nextBufferProfile).minBufferAheadSeconds}mp)`;
      delayMs = 200;
    } else {
      nextBufferProfile = 'adaptive-3';
      if (channel?.fallbackUrl && channel.fallbackUrl !== nextUrl) {
        nextUrl = channel.fallbackUrl;
        useFallbackUrl = true;
        strategyId = 'channel_fallback_stream';
        description = 'tartalék adatfolyam + maximális védett puffer (10 mp)';
      } else {
        nextFormat = hasAlternateFormat ? altFormat : currentFormat;
        nextUrl = urlFor(nextFormat);
        strategyId = 'max_safe_buffer_ceiling';
        description = `maximális biztonságos pufferhatár (${nextFormat.toUpperCase()}, 10 mp)`;
      }
      delayMs = 260;
    }
  } else {
    // Indulási hiba / időtúllépés / váratlan leállás esetén 5 ELTÉRŐ gyors beállítás:
    //  1. beállítás: az elsődleges formátum tiszta, turbó/gyors dekóder-resetje (60 ms)
    //  2. beállítás: azonnali formátumváltás (TS <-> HLS) gyors profillal (70 ms)
    //  3. beállítás: elsődleges formátum + emelt indulási puffer (130 ms)
    //  4. beállítás: alternatív formátum + stabil puffer (180 ms)
    //  5. beállítás: tartalék csatorna-URL (ha van) vagy védett emelt puffer (240 ms)
    if (step === 1) {
      nextFormat = currentFormat;
      nextUrl = urlFor(currentFormat);
      nextBufferProfile = currentBufferProfile === 'instant' || currentBufferProfile === 'turbo'
        ? 'fast'
        : currentBufferProfile;
      strategyId = 'quick_primary_retry';
      description = `1. beállítás: gyors tiszta újraindítás (${nextFormat.toUpperCase()}, ${nextBufferProfile})`;
      delayMs = 60;
    } else if (step === 2 && hasAlternateFormat) {
      nextFormat = altFormat;
      nextUrl = urlFor(altFormat);
      nextBufferProfile = 'fast';
      strategyId = 'format_switch_probe';
      description = `2. beállítás: azonnali formátumváltás (${currentFormat.toUpperCase()} -> ${altFormat.toUpperCase()}, gyors profil)`;
      delayMs = 70;
    } else if (step === 3) {
      // 3. beállítás: ELSŐDLEGES formátum + emelt indulási puffer. Ha a 2. lépés
      // átvaltott az alternatív formátumra (pl. HLS -> TS) és az sem indul,
      // vissza kell térni az elsődleges címre, nem megismételni az alternatívat.
      nextFormat = primaryFormat;
      nextUrl = urlFor(nextFormat);
      nextBufferProfile = nextSafeBufferProfile(currentBufferProfile === 'fast' ? 'balanced' : currentBufferProfile);
      strategyId = 'startup_buffer_step_up';
      description = `3. beállítás: emelt indulási puffer (${nextFormat.toUpperCase()}, ${nextBufferProfile})`;
      delayMs = 130;
    } else if (step === 4 && hasAlternateFormat) {
      nextFormat = altFormat;
      nextUrl = urlFor(altFormat);
      nextBufferProfile = 'stable';
      strategyId = 'alternate_format_raised_buffer';
      description = `4. beállítás: alternatív formátum (${altFormat.toUpperCase()}) + stabil puffer (5.0 mp)`;
      delayMs = 180;
    } else {
      nextBufferProfile = 'adaptive-1';
      if (channel?.fallbackUrl && channel.fallbackUrl !== nextUrl) {
        nextUrl = channel.fallbackUrl;
        useFallbackUrl = true;
        strategyId = 'fallback_url_repair';
        description = '5. beállítás: tartalék csatorna-URL aktiválása';
      } else {
        nextFormat = hasAlternateFormat ? altFormat : currentFormat;
        nextUrl = urlFor(nextFormat);
        strategyId = 'final_bounded_repair';
        description = `5. beállítás: védett utolsó próba (${nextFormat.toUpperCase()}, puffer=${nextBufferProfile})`;
      }
      delayMs = 240;
    }
  }

  const baseCfg = getDoctorBufferConfig(nextBufferProfile);
  // A gyors beállításpróbáknál feszes indulási őrt tartunk, hogy 5 különböző beállítás se tartson sokáig!
  const nextTiming = !isStallTrigger && step <= 2
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

/* ============================================================================
 * EPG ELLENŐRZÉS, AKTÍV BETÖLTÉS-SEGÍTÉS ÉS CSATORNÁNKÉNTI LEKAPCSOLÁS
 * ============================================================================
 *  - Ha egy csatornához igazoltan nincs EPG (üres rövid/egyszerű EPG + betöltött
 *    műsorújságban sem szerepel, vagy ismételten 0 műsort ad a panel), a TV Doktor
 *    lekapcsolja annál a csatornánál az EPG-keresést (`shouldSkipChannelEpg === true`).
 *  - Ha maga az EPG nem töltődik be, a TV Doktor korlátozott számban (max 2x / 10 perc)
 *    aktívan segíti az EPG és az XMLTV műsorújság újratöltését.
 */

export function shouldSkipChannelEpg(
  channel?: Pick<Channel, 'id' | 'name' | 'countryCode'> | null,
  storage?: Storage | null,
): boolean {
  if (!channel) return false;
  const store = readStore(storage);
  const key = (channel.id && store.epgIdIndex[channel.id]) || normalizeChannelDoctorKey(channel);
  const rec = store.epgByKey[key];
  if (!rec || rec.state !== 'disabled') return false;
  if (Date.now() - rec.updatedAt >= EPG_DISABLED_TTL_MS) {
    return false;
  }
  return true;
}

export function recordDoctorEpgChannelResult(params: {
  channel?: Pick<Channel, 'id' | 'name' | 'countryCode'> | null;
  hasEntries: boolean;
  guideLoaded?: boolean;
  providerHasAnyEpg?: boolean;
  storage?: Storage | null;
}): ChannelEpgDoctorRecord | null {
  const { channel, hasEntries, guideLoaded = false, providerHasAnyEpg = false, storage } = params;
  if (!channel) return null;
  const key = normalizeChannelDoctorKey(channel);
  if (!key || key === 'unknown-channel' || key.startsWith('vod:')) return null;

  const store = readStore(storage);
  const existing = (channel.id && store.epgIdIndex[channel.id]
    ? store.epgByKey[store.epgIdIndex[channel.id]]
    : null) || store.epgByKey[key];
  const now = Date.now();

  if (hasEntries) {
    if (existing && existing.state === 'ok' && now - existing.updatedAt < 10 * 60 * 1000) {
      return existing;
    }
    const updated: ChannelEpgDoctorRecord = {
      channelKey: key,
      channelId: channel.id,
      channelName: String(channel.name || channel.id || key).slice(0, 140),
      state: 'ok',
      emptyChecks: 0,
      updatedAt: now,
    };
    store.epgByKey[key] = updated;
    if (channel.id) store.epgIdIndex[channel.id] = key;
    writeStore(store, storage);
    return updated;
  }

  const nextEmpty = (existing?.emptyChecks || 0) + 1;
  // Lekapcsoljuk az EPG-keresést ennél a csatornánál, ha:
  //  - a teljes műsorújság (XMLTV) már betöltődött ÉS a rövid+egyszerű EPG is üres erre a csatornára, VAGY
  //  - a szolgáltató más csatornákon ad EPG-t, de ennél a csatornánál már 2x üres volt, VAGY
  //  - 3 külön ellenőrzés után sincs semmilyen EPG adat a csatornához.
  const shouldDisable =
    (guideLoaded && nextEmpty >= 1) ||
    (providerHasAnyEpg && nextEmpty >= 2) ||
    nextEmpty >= 3;

  const wasAlreadyDisabled = existing?.state === 'disabled' && now - existing.updatedAt < EPG_DISABLED_TTL_MS;
  const updated: ChannelEpgDoctorRecord = {
    channelKey: key,
    channelId: channel.id,
    channelName: String(channel.name || channel.id || key).slice(0, 140),
    state: shouldDisable ? 'disabled' : 'empty',
    emptyChecks: nextEmpty,
    updatedAt: now,
  };
  store.epgByKey[key] = updated;
  if (channel.id) store.epgIdIndex[channel.id] = key;

  if (shouldDisable && !wasAlreadyDisabled) {
    opHealth.epgDisabledCount += 1;
    logDoctor(
      'info',
      channel,
      'EPG lekapcsolva: a csatornához nincs műsorújság – többé nem keresünk hozzá EPG-t.',
      'learning',
      storage,
    );
  } else {
    writeStore(store, storage);
  }

  return updated;
}

export function requestDoctorEpgAssistance(params: {
  providerName?: string;
  reason: string;
  now?: number;
  storage?: Storage | null;
}): { allowed: boolean; attempt: number } {
  const { providerName, reason, now = Date.now(), storage } = params;
  const windowStart = now - EPG_ASSIST_WINDOW_MS;
  while (epgAssistTimestamps.length > 0 && epgAssistTimestamps[0] < windowStart) {
    epgAssistTimestamps.shift();
  }
  if (epgAssistTimestamps.length >= MAX_EPG_ASSIST_PER_WINDOW) {
    return { allowed: false, attempt: epgAssistTimestamps.length };
  }

  epgAssistTimestamps.push(now);
  const attempt = epgAssistTimestamps.length;
  opHealth.epgAssistsCount += 1;

  const store = readStore(storage);
  store.epgAssistCount = (store.epgAssistCount || 0) + 1;
  store.epgLastAssistAt = now;

  const targetChannel = {
    id: 'epg-system',
    name: providerName ? `EPG • ${providerName}` : 'EPG Műsorújság',
    countryCode: undefined,
  };

  logDoctor(
    'warn',
    targetChannel,
    `EPG-ellenőrzés aktiválódott: ${reason}`,
    'activation',
    storage,
  );
  logDoctor(
    'repair',
    targetChannel,
    `EPG betöltés segítése [${attempt}/${MAX_EPG_ASSIST_PER_WINDOW}]: műsorújság és tartalék EPG újratöltése indítva`,
    'assistance',
    storage,
  );

  return { allowed: true, attempt };
}

export function recordDoctorEpgRecovered(params: {
  providerName?: string;
  channelCount: number;
  source: 'xmltv' | 'short_epg';
  storage?: Storage | null;
}): void {
  const { providerName, channelCount, source, storage } = params;
  if (channelCount <= 0) return;
  const store = readStore(storage);
  const now = Date.now();
  // Csak akkor naplózunk külön EPG-helyreállítást, ha előtte volt EPG-segítés vagy még nem volt rögzítve.
  const hadAssist = store.epgLastAssistAt !== null && (store.epgLastRecoveredAt === null || store.epgLastRecoveredAt < store.epgLastAssistAt);
  store.epgLastRecoveredAt = now;
  if (hadAssist) {
    logDoctor(
      'verified',
      { id: 'epg-system', name: providerName ? `EPG • ${providerName}` : 'EPG Műsorújság', countryCode: undefined },
      `EPG sikeresen helyreállítva (${source === 'xmltv' ? 'teljes műsorújság' : 'tartalék csatorna-EPG'}): ${channelCount} csatorna műsora elérhető.`,
      'assistance',
      storage,
    );
  } else {
    writeStore(store, storage);
  }
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
      existing.confidence = incoming.confidenceScore ?? existing.confidence;
      existing.source = 'merged';
      mergedCount += 1;
    }
  }

  if (mergedCount > 0) {
    writeStore(store, storage);
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

export function registerDoctorRepairPlugin(plugin: DoctorRepairPlugin): () => void {
  const idx = repairPlugins.findIndex((p) => p.id === plugin.id);
  if (idx >= 0) repairPlugins.splice(idx, 1);
  repairPlugins.push(plugin);
  return () => {
    const pos = repairPlugins.findIndex((p) => p.id === plugin.id);
    if (pos >= 0) repairPlugins.splice(pos, 1);
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
