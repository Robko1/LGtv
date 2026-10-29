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
 * TV Doktor – intelligens, önfejlesztő diagnosztikai és lejátszás-optimalizáló rendszer.
 *
 * Feladatai:
 *  1. Villámgyors csatornaváltás: csatornánként méri az indulási időket és előre kiválasztja
 *     a leggyorsabb, igazoltan stabil lejátszási formátumot (TS / HLS) és pufferprofilt.
 *  2. Automatikus aktiválás: hiba, indulási időtúllépés, fagyás vagy megszakadás esetén lép közbe.
 *  3. Hibakeresés: összegyűjti a csatorna, mód, indulási idő, hibakód és stream állapot adatait.
 *  4. Sebességteszt: biztonságosan összehasonlítja a támogatott lejátszási módok indulási idejét.
 *  5. Automatikus javítás: korlátozott számú lépésben módot/puffert vált, újraindít és ellenőriz.
 *  6. Tartós tanuló memória: csatornánként menti a bevált megoldást, sebességet és hibákat.
 *  7. Okos fagyásfigyelés: megkülönbözteti a valódi dekóder-/streamfagyást a ritkán változó
 *     képkockájú vagy hangalapú, valójában egészséges csatornáktól.
 *  8. Bővíthető architektúra: diagnosztikai és javítási bővítmények (pluginek) regisztrálhatók.
 *  9. Naplózás és biztonság: hitelesítő adatok nélkül naplóz, korlátozza az ismétléseket,
 *     soha nem töröl csatornalistát vagy felhasználói beállítást, hiba esetén visszaáll az alapra.
 * 10. Automatikus pufferoptimalizálás: előre meghatározott profilokat (fast / balanced / stable)
 *     és szigorú biztonságos határok közötti fokozatos lépcsőket (adaptive-1..3, max 10 mp) tesztel.
 */

export const TV_DOCTOR_STORAGE_KEY = 'iptv_rt_tv_doctor_v1';
export const TV_DOCTOR_SYNC_STORAGE_KEY = 'iptv_rt_tv_doctor_sync_v1';
export const TV_DOCTOR_DIAG_LOGGING_KEY = 'iptv_rt_tv_doctor_diag_log_v1';

/** Korlátok a TV erőforrásainak és a localStorage kvótának a védelmére. */
export const MAX_LEARNED_CHANNELS = 450;
export const MAX_SAFE_DOCTOR_STORAGE_BYTES = 256 * 1024;
export const WEBOS_LOCAL_STORAGE_QUOTA_BYTES = 5 * 1024 * 1024;
export const DOCTOR_SLOW_OP_THRESHOLD_MS = 25;
export const MAX_DOCTOR_REPAIR_STEPS = 5;
export const MAX_INTERVENTIONS_PER_MINUTE = 6;
export const DOCTOR_VERIFY_STABLE_MS = 2400;

/** Szigorú biztonsági határok a pufferbeállításokhoz (soha nem nőhet korlátlanul). */
export const MIN_SAFE_BUFFER_SECONDS = 1.0;
export const MAX_SAFE_BUFFER_SECONDS = 10.0;
export const MIN_SAFE_STARTUP_WATCHDOG_MS = 1000;
export const MAX_SAFE_STARTUP_WATCHDOG_MS = 4000;
export const MIN_SAFE_BUFFER_WATCHDOG_MS = 2500;
export const MAX_SAFE_BUFFER_WATCHDOG_MS = 9000;
export const MIN_SAFE_STALL_DETECTOR_MS = 3000;
export const MAX_SAFE_STALL_DETECTOR_MS = 9000;

export type DoctorBufferProfileId =
  | 'fast'
  | 'balanced'
  | 'stable'
  | 'adaptive-1'
  | 'adaptive-2'
  | 'adaptive-3';

export const DOCTOR_BUFFER_ORDER: readonly DoctorBufferProfileId[] = [
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
  fast: {
    id: 'fast',
    label: 'Gyors (1.5 mp)',
    isPreset: true,
    startupWatchdogMs: 1200,
    bufferWatchdogMs: 3500,
    stallDetectorMs: 3500,
    retryMs: 250,
    minBufferAheadSeconds: 1.5,
  },
  balanced: {
    id: 'balanced',
    label: 'Kiegyensúlyozott (3.0 mp)',
    isPreset: true,
    startupWatchdogMs: 2000,
    bufferWatchdogMs: 4500,
    stallDetectorMs: 5000,
    retryMs: 400,
    minBufferAheadSeconds: 3.0,
  },
  stable: {
    id: 'stable',
    label: 'Stabil (5.0 mp)',
    isPreset: true,
    startupWatchdogMs: 2800,
    bufferWatchdogMs: 5600,
    stallDetectorMs: 6000,
    retryMs: 500,
    minBufferAheadSeconds: 5.0,
  },
  'adaptive-1': {
    id: 'adaptive-1',
    label: 'Emelt puffer L1 (6.5 mp)',
    isPreset: false,
    startupWatchdogMs: 3200,
    bufferWatchdogMs: 6800,
    stallDetectorMs: 7000,
    retryMs: 650,
    minBufferAheadSeconds: 6.5,
  },
  'adaptive-2': {
    id: 'adaptive-2',
    label: 'Emelt puffer L2 (8.0 mp)',
    isPreset: false,
    startupWatchdogMs: 3600,
    bufferWatchdogMs: 7800,
    stallDetectorMs: 8000,
    retryMs: 800,
    minBufferAheadSeconds: 8.0,
  },
  'adaptive-3': {
    id: 'adaptive-3',
    label: 'Maximális védett puffer L3 (10.0 mp)',
    isPreset: false,
    startupWatchdogMs: 4000,
    bufferWatchdogMs: 9000,
    stallDetectorMs: 9000,
    retryMs: 1000,
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
  tsAvgStartupMs: number | null;
  hlsAvgStartupMs: number | null;
  bestStartupMs: number | null;
  tsOk: number;
  tsFail: number;
  hlsOk: number;
  hlsFail: number;
  stalls: number;
  repairsOk: number;
  bufferStats: Partial<Record<DoctorBufferProfileId, BufferProfileStats>>;
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

export interface ChannelLaunchPlan {
  enabled: boolean;
  hasLearnedProfile: boolean;
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
  exhausted: boolean;
}

export interface DoctorLogEntry {
  at: number;
  level: 'info' | 'warn' | 'repair' | 'verified';
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
  lastStorageError: { location: string; message: string; at: number } | null;
}

const MAX_RECENT_LOGS = 60;
const recentDoctorLogs: DoctorLogEntry[] = [];
const diagnosticPlugins: DoctorDiagnosticPlugin[] = [];
const repairPlugins: DoctorRepairPlugin[] = [];
const interventionTimestampsByChannel = new Map<string, number[]>();
const statusListeners: Array<() => void> = [];

let memoryCache: DoctorStoreData | null = null;
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
  lastStorageError: null,
};

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
}

export function formatDoctorBytes(bytes: number): string {
  const safe = Math.max(0, Math.round(Number(bytes) || 0));
  if (safe === 0) return '0 B';
  if (safe < 1024) return `${safe} B`;
  const kb = safe / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
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
    | 'freeze_detected';
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

export function normalizeChannelDoctorKey(
  channel?: Pick<Channel, 'id' | 'name' | 'countryCode'> | null,
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

export function clampBufferTiming(timing: BufferProfileTiming): BufferProfileTiming {
  const clamp = (val: number, min: number, max: number, def: number): number => {
    const n = Number(val);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  };
  return {
    startupWatchdogMs: Math.round(clamp(timing.startupWatchdogMs, MIN_SAFE_STARTUP_WATCHDOG_MS, MAX_SAFE_STARTUP_WATCHDOG_MS, 2000)),
    bufferWatchdogMs: Math.round(clamp(timing.bufferWatchdogMs, MIN_SAFE_BUFFER_WATCHDOG_MS, MAX_SAFE_BUFFER_WATCHDOG_MS, 4500)),
    stallDetectorMs: Math.round(clamp(timing.stallDetectorMs, MIN_SAFE_STALL_DETECTOR_MS, MAX_SAFE_STALL_DETECTOR_MS, 5000)),
    retryMs: Math.round(clamp(timing.retryMs, 80, 1500, 400)),
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

export function nextSafeBufferProfile(current: DoctorBufferProfileId): DoctorBufferProfileId {
  const idx = DOCTOR_BUFFER_ORDER.indexOf(current);
  if (idx < 0) return 'balanced';
  if (idx >= DOCTOR_BUFFER_ORDER.length - 1) return DOCTOR_BUFFER_ORDER[DOCTOR_BUFFER_ORDER.length - 1];
  return DOCTOR_BUFFER_ORDER[idx + 1];
}

export function prevFasterBufferProfile(current: DoctorBufferProfileId): DoctorBufferProfileId {
  const idx = DOCTOR_BUFFER_ORDER.indexOf(current);
  if (idx <= 0) return 'fast';
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
  return { v: 1, byKey: {}, idIndex: {} };
}

function isValidFormat(value: unknown): value is LiveFormat {
  return value === 'ts' || value === 'hls';
}

function isValidBufferProfile(value: unknown): value is DoctorBufferProfileId {
  return typeof value === 'string' && (DOCTOR_BUFFER_ORDER as readonly string[]).indexOf(value) >= 0;
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
      if (!storage) memoryCache = empty;
      return empty;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.byKey !== 'object') {
      const empty = createEmptyStore();
      if (!storage) memoryCache = empty;
      return empty;
    }
    const cleanByKey: Record<string, ChannelDoctorRecord> = {};
    const cleanIdIndex: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.byKey as Record<string, any>)) {
      if (!k || !v || typeof v !== 'object') continue;
      if (!isValidFormat(v.bestFormat)) continue;
      const bp: DoctorBufferProfileId = isValidBufferProfile(v.bestBufferProfile)
        ? v.bestBufferProfile
        : 'balanced';
      const rec: ChannelDoctorRecord = {
        channelKey: String(v.channelKey || k).slice(0, 120),
        channelId: typeof v.channelId === 'string' ? v.channelId.slice(0, 120) : undefined,
        channelName: String(v.channelName || k).slice(0, 140),
        countryCode: typeof v.countryCode === 'string' ? v.countryCode.slice(0, 12) : undefined,
        bestFormat: v.bestFormat,
        bestBufferProfile: bp,
        bestBufferAheadSeconds: Math.max(
          MIN_SAFE_BUFFER_SECONDS,
          Math.min(MAX_SAFE_BUFFER_SECONDS, Number(v.bestBufferAheadSeconds) || DOCTOR_BUFFER_CONFIGS[bp].minBufferAheadSeconds),
        ),
        tsAvgStartupMs: typeof v.tsAvgStartupMs === 'number' && v.tsAvgStartupMs > 0 ? Math.round(v.tsAvgStartupMs) : null,
        hlsAvgStartupMs: typeof v.hlsAvgStartupMs === 'number' && v.hlsAvgStartupMs > 0 ? Math.round(v.hlsAvgStartupMs) : null,
        bestStartupMs: typeof v.bestStartupMs === 'number' && v.bestStartupMs > 0 ? Math.round(v.bestStartupMs) : null,
        tsOk: Math.max(0, Number(v.tsOk) || 0),
        tsFail: Math.max(0, Number(v.tsFail) || 0),
        hlsOk: Math.max(0, Number(v.hlsOk) || 0),
        hlsFail: Math.max(0, Number(v.hlsFail) || 0),
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
    const loaded: DoctorStoreData = { v: 1, byKey: cleanByKey, idIndex: cleanIdIndex };
    if (!storage) memoryCache = loaded;
    return loaded;
  } catch {
    const empty = createEmptyStore();
    if (!storage) memoryCache = empty;
    return empty;
  }
}

function pruneStore(store: DoctorStoreData): void {
  const keys = Object.keys(store.byKey);
  if (keys.length <= MAX_LEARNED_CHANNELS) return;
  const sorted = keys.sort((a, b) => (store.byKey[b]?.updatedAt || 0) - (store.byKey[a]?.updatedAt || 0));
  const keepSet = new Set(sorted.slice(0, MAX_LEARNED_CHANNELS));
  for (const k of keys) {
    if (!keepSet.has(k)) delete store.byKey[k];
  }
  for (const [cid, ckey] of Object.entries(store.idIndex)) {
    if (!keepSet.has(ckey)) delete store.idIndex[cid];
  }
}

function writeStore(store: DoctorStoreData, storage?: Storage | null): void {
  const startedAt = nowPerfMs();
  pruneStore(store);
  if (!storage) memoryCache = store;
  const target = getStorage(storage);
  if (!target) return;
  try {
    target.setItem(TV_DOCTOR_STORAGE_KEY, JSON.stringify(store));
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
      const keep = new Set(keys.slice(0, Math.floor(MAX_LEARNED_CHANNELS / 2)));
      for (const k of keys) {
        if (!keep.has(k)) delete store.byKey[k];
      }
      target.setItem(TV_DOCTOR_STORAGE_KEY, JSON.stringify(store));
    } catch {
      /* memóriában tovább működik */
    }
  } finally {
    recordDoctorOpTiming('writeStore', nowPerfMs() - startedAt);
    notifyTvDoctorListeners();
  }
}

export function clearTvDoctorMemory(storage?: Storage | null): void {
  memoryCache = createEmptyStore();
  interventionTimestampsByChannel.clear();
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
    appLog('TV DOKTOR MEMÓRIA: a helyi tanuló memória és eseménylista 0 állapotra törölve.');
  }
  notifyTvDoctorListeners();
}

export function getTvDoctorMemoryStats(storage?: Storage | null): TvDoctorMemoryStats {
  const store = readStore(storage);
  const learnedChannelCount = Object.keys(store.byKey).length;
  const target = getStorage(storage);

  let doctorStoreBytes = 0;
  let cloudQueueBytes = 0;
  let tvStorageUsedBytes = 0;

  if (target) {
    try {
      const rawDoctor = target.getItem(TV_DOCTOR_STORAGE_KEY);
      if (rawDoctor) {
        doctorStoreBytes = (TV_DOCTOR_STORAGE_KEY.length + rawDoctor.length) * 2;
      } else if (learnedChannelCount > 0) {
        doctorStoreBytes = JSON.stringify(store).length * 2;
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
  } else if (learnedChannelCount > 0) {
    doctorStoreBytes = JSON.stringify(store).length * 2;
  }

  let inMemoryLogBytes = 0;
  for (let i = 0; i < recentDoctorLogs.length; i += 1) {
    const entry = recentDoctorLogs[i];
    inMemoryLogBytes += ((entry.channelName?.length || 0) + (entry.message?.length || 0) + 24) * 2;
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
  let memoryHealthLabel = 'Optimális – nem terheli és nem lassítja a TV-t';
  if (opHealth.lastStorageError || doctorBudgetPercent >= 85 || tvStoragePercent >= 85) {
    memoryHealth = 'high';
    memoryHealthLabel = 'Magas telítettség – javasolt a Memória: 0 gomb megnyomása';
  } else if (doctorBudgetPercent >= 55 || tvStoragePercent >= 65) {
    memoryHealth = 'moderate';
    memoryHealthLabel = 'Mérsékelt foglaltság – normál, biztonságos működés';
  }

  return {
    learnedChannelCount,
    maxLearnedChannels: MAX_LEARNED_CHANNELS,
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
    recentLogs: recentDoctorLogs.slice(-20),
  };
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

function logDoctor(
  level: DoctorLogEntry['level'],
  channel: Pick<Channel, 'id' | 'name' | 'countryCode'> | null | undefined,
  message: string,
): void {
  const channelKey = normalizeChannelDoctorKey(channel);
  const channelName = String(channel?.name || channel?.id || 'Ismeretlen');
  recentDoctorLogs.push({
    at: Date.now(),
    level,
    channelKey,
    channelName,
    message,
  });
  if (recentDoctorLogs.length > MAX_RECENT_LOGS) {
    recentDoctorLogs.splice(0, recentDoctorLogs.length - MAX_RECENT_LOGS);
  }
  if (isTvDoctorDiagLoggingEnabled()) {
    appLog(`TV DOKTOR [${channelName}] ${message}`);
  }
  notifyTvDoctorListeners();
}

/** Sebesség- és megbízhatósági pontszám alapján kiválasztja a legjobb formátumot. */
export function pickFastestReliableFormat(
  record: ChannelDoctorRecord,
  fallbackFormat: LiveFormat,
): LiveFormat {
  const tsTotal = record.tsOk + record.tsFail;
  const hlsTotal = record.hlsOk + record.hlsFail;
  if (tsTotal === 0 && hlsTotal === 0) return record.bestFormat || fallbackFormat;

  // Ha az egyik formátum sorozatosan elbukott, a másik pedig már bizonyított:
  if (record.tsOk === 0 && record.tsFail > 0 && record.hlsOk > 0) return 'hls';
  if (record.hlsOk === 0 && record.hlsFail > 0 && record.tsOk > 0) return 'ts';

  const tsReliability = tsTotal > 0 ? (record.tsOk + 0.5) / (tsTotal + 1) : 0.45;
  const hlsReliability = hlsTotal > 0 ? (record.hlsOk + 0.5) / (hlsTotal + 1) : 0.45;

  // Indulási sebesség bónusz: minél gyorsabban indul (ms), annál magasabb pontszám.
  const tsSpeedBonus = record.tsAvgStartupMs !== null
    ? Math.max(0, (4200 - record.tsAvgStartupMs) / 14000)
    : 0;
  const hlsSpeedBonus = record.hlsAvgStartupMs !== null
    ? Math.max(0, (4200 - record.hlsAvgStartupMs) / 14000)
    : 0;

  const tsScore = record.tsOk > 0 ? tsReliability + tsSpeedBonus : tsReliability * 0.45;
  const hlsScore = record.hlsOk > 0 ? hlsReliability + hlsSpeedBonus : hlsReliability * 0.45;

  if (Math.abs(tsScore - hlsScore) < 0.03) {
    // Közel azonos megbízhatóságnál a mérten gyorsabb indulású mód nyer!
    if (record.tsAvgStartupMs !== null && record.hlsAvgStartupMs !== null && record.tsOk > 0 && record.hlsOk > 0) {
      return record.hlsAvgStartupMs + 80 < record.tsAvgStartupMs ? 'hls' : 'ts';
    }
    return record.bestFormat || fallbackFormat;
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
    // Ha egy profil gyakran megakad (stallRatio >= 0.45), erősen büntetjük.
    const stallPenalty = Math.min(0.75, stallRatio * 0.42);
    const speedBonus = st.avgStartupMs !== null
      ? Math.max(0, (4500 - st.avgStartupMs) / 16000)
      : 0;
    // Enyhe preferencia a kisebb késleltetésű profilok felé, ha hibátlanok:
    const idx = DOCTOR_BUFFER_ORDER.indexOf(profileId);
    const agilityBonus = st.stalls === 0 && st.fail === 0 ? Math.max(0, (5 - idx) * 0.015) : 0;

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
 * leggyorsabban induló, igazoltan stabil formátumot és pufferprofilt.
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
      const plan: ChannelLaunchPlan = {
        enabled: true,
        hasLearnedProfile: false,
        channelKey,
        primaryFormat: fallbackPrimary,
        alternateFormat: supportsDualFormat ? (fallbackPrimary === 'hls' ? 'ts' : 'hls') : null,
        bufferProfileId: baseBufferMode,
        bufferTiming: defaultTiming,
        expectedStartupMs: null,
        reason: legacyFormat ? `korábbi formátummemória (${legacyFormat})` : 'első mérés ezen a csatornán',
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

    const chosenFormat: LiveFormat = supportsDualFormat
      ? pickFastestReliableFormat(record, fallbackPrimary)
      : fallbackPrimary;

    const chosenBufferProfile = evaluateBestBufferProfile(record.bufferStats, record.bestBufferProfile || baseBufferMode);
    const hasCustomBufferExperience =
      Object.keys(record.bufferStats || {}).length > 0 || record.source === 'cloud' || record.stalls > 0 || record.repairsOk > 0;

    const doctorCfg = getDoctorBufferConfig(chosenBufferProfile);
    const chosenTiming: BufferProfileTiming = hasCustomBufferExperience
      ? clampBufferTiming({
          ...doctorCfg,
          minBufferAheadSeconds: record.bestBufferProfile === chosenBufferProfile
            ? record.bestBufferAheadSeconds
            : doctorCfg.minBufferAheadSeconds,
        })
      : defaultTiming;

    const expectedStartupMs = chosenFormat === 'hls' ? record.hlsAvgStartupMs : record.tsAvgStartupMs;

    const plan: ChannelLaunchPlan = {
      enabled: true,
      hasLearnedProfile: true,
      channelKey,
      primaryFormat: chosenFormat,
      alternateFormat: supportsDualFormat ? (chosenFormat === 'hls' ? 'ts' : 'hls') : null,
      bufferProfileId: hasCustomBufferExperience ? chosenBufferProfile : baseBufferMode,
      bufferTiming: chosenTiming,
      expectedStartupMs,
      reason: `tanult profil (${chosenFormat.toUpperCase()}, puffer=${chosenBufferProfile}${expectedStartupMs ? `, ~${expectedStartupMs}ms` : ''})`,
    };
    const elapsed = nowPerfMs() - startedAt;
    recordDoctorOpTiming('selectChannelLaunchPlan', elapsed, channel.name);
    if (isVerbosePlaybackLogging() && isTvDoctorDiagLoggingEnabled()) {
      appLog(
        `TV DOKTOR DÖNTÉS [${channel.name || channelKey}]: mód=${plan.primaryFormat.toUpperCase()}; puffer=${plan.bufferProfileId} (${plan.bufferTiming.minBufferAheadSeconds}mp); ok=${plan.reason}; számítás=${Math.round(elapsed * 10) / 10}ms`,
      );
    }
    return plan;
  } catch (err) {
    if (isTvDoctorDiagLoggingEnabled()) {
      appLog(
        `TV DOKTOR HIBA [hely=selectChannelLaunchPlan; csatorna=${channel.name || channelKey}]: biztonsági visszaállás (${String(err).slice(0, 80)})`,
      );
    }
    // Biztonsági visszaállás az eredeti mechanizmusra bármilyen belső hiba esetén.
    return {
      enabled: false,
      hasLearnedProfile: false,
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
  const clamped = Math.max(20, Math.min(60000, Math.round(sample)));
  if (prev === null || !Number.isFinite(prev)) return clamped;
  return Math.round(prev * 0.65 + clamped * 0.35);
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
      hlsOk: 0,
      hlsFail: 0,
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
 * Sikeres csatornaindulás rögzítése: méri a sebességet, frissíti a formátum- és
 * pufferstatisztikákat, és ha egy csatorna tartósan villámgyors és akadásmentes,
 * finoman gyorsabb pufferprofilra lépteti.
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
    const safeMs = Math.max(20, Math.min(60000, Math.round(startupMs)));

    if (format === 'hls') {
      rec.hlsOk += 1;
      rec.hlsAvgStartupMs = ewma(rec.hlsAvgStartupMs, safeMs);
    } else {
      rec.tsOk += 1;
      rec.tsAvgStartupMs = ewma(rec.tsAvgStartupMs, safeMs);
    }

    rec.bestStartupMs = rec.bestStartupMs === null ? safeMs : Math.min(rec.bestStartupMs, safeMs);
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

    // Ha a csatorna hibátlanul és villámgyorsan (<850ms) indul legalább 3 alkalommal
    // egy nagyobb profilon (pl. balanced), kipróbálásra felkínálja / előlépteti a fast profilt is.
    if (!wasRepair && safeMs <= 850 && nextBuf.ok >= 3 && nextBuf.stalls === 0 && bufferProfile === 'balanced' && !rec.bufferStats.fast) {
      rec.bestBufferProfile = 'fast';
      rec.bestBufferAheadSeconds = DOCTOR_BUFFER_CONFIGS.fast.minBufferAheadSeconds;
    } else {
      rec.bestBufferProfile = evaluateBestBufferProfile(rec.bufferStats, bufferProfile);
      rec.bestBufferAheadSeconds = getDoctorBufferConfig(rec.bestBufferProfile).minBufferAheadSeconds;
    }

    rec.bestFormat = pickFastestReliableFormat(rec, format);
    rec.source = rec.source === 'cloud' ? 'merged' : 'local';
    rec.updatedAt = Date.now();

    if (channel.id && !storage) {
      rememberFormatFor(channel.id, rec.bestFormat);
    }
    writeStore(store, storage);

    if (wasRepair) {
      logDoctor(
        'verified',
        channel,
        `JAVÍTÁS ELLENŐRIZVE ÉS MENTVE: mód=${format.toUpperCase()} puffer=${rec.bestBufferProfile} (${rec.bestBufferAheadSeconds}mp) indulás=${safeMs}ms`,
      );
    } else if (isVerbosePlaybackLogging() && isTvDoctorDiagLoggingEnabled()) {
      appLog(
        `TV DOKTOR MÉRÉS [${rec.channelName}]: sikeres indulás=${safeMs}ms; mód=${format.toUpperCase()}; ajánlott=${rec.bestFormat.toUpperCase()}/${rec.bestBufferProfile} (${rec.bestBufferAheadSeconds}mp)`,
      );
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

    if (isStall) {
      rec.stalls += 1;
    } else if (format === 'hls') {
      rec.hlsFail += 1;
    } else {
      rec.tsFail += 1;
    }

    const prevBuf = rec.bufferStats[bufferProfile] || { ok: 0, fail: 0, stalls: 0, avgStartupMs: null };
    rec.bufferStats[bufferProfile] = {
      ok: prevBuf.ok,
      fail: isStall ? prevBuf.fail : prevBuf.fail + 1,
      stalls: isStall ? prevBuf.stalls + 1 : prevBuf.stalls,
      avgStartupMs: prevBuf.avgStartupMs,
    };

    // Ha az aktuális pufferprofil ismételten megakad, automatikusan egy fokozattal
    // feljebb léptetjük a csatorna ajánlott pufferét a biztonsági plafonig (max 10 mp).
    if (isStall) {
      const stepped = nextSafeBufferProfile(bufferProfile);
      rec.bestBufferProfile = stepped;
      rec.bestBufferAheadSeconds = getDoctorBufferConfig(stepped).minBufferAheadSeconds;
    } else {
      rec.bestFormat = pickFastestReliableFormat(rec, format === 'hls' ? 'ts' : 'hls');
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
}): DoctorDiagnosticReport {
  const { channel, trigger, format, bufferProfile, loadElapsedMs, errorCode, errorDetail, streamState } = params;
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

  logDoctor(
    'warn',
    channel,
    `AKTIVÁLÁS ok=${trigger} mód=${format.toUpperCase()} puffer=${bufferProfile} betöltés=${report.loadElapsedMs}ms hiba=${report.errorCode || 'nincs'} rs=${streamState.readyState} ns=${streamState.networkState} tartalék=${streamState.bufferedAheadSeconds.toFixed(1)}mp`,
  );

  return report;
}

/**
 * 7. Okos fagyásfigyelés:
 * Eldönti, hogy a StallDetector jelzése valódi kép-/adatfolyam-fagyás-e, vagy a csatorna
 * valójában rendesen működik (pl. hangcsatorna/rádió képkocka nélkül, vagy élő stream,
 * ahol a kép átmenetileg állóképet mutat, miközben nincs sem hálózati, sem pufferelési hiba).
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

  // 1. Ha az idővonal (currentTime) vagy a dekódolt képkockaszám nőtt, a műsor rendben megy.
  if (prevSnapshot && mediaProgressed(prevSnapshot, currentSnapshot)) {
    return { intervene: false, reason: 'idővonal vagy képkockaszám halad' };
  }

  // 2. Hang-/rádiócsatorna védelem: ha még soha nem volt videófelbontás (0x0),
  // a lejátszó nem állt meg, van elegendő adat (readyState >= 3), és nincs waiting/stalled:
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

  // 3. Ritkán változó képkockájú / állóképes csatorna védelem:
  // Ha a dekóder HAVE_ENOUGH_DATA (4) állapotban van, bőséges a puffer, nincs waiting/stalled
  // esemény, és ez még csak az első fagyás-jelzés (consecutiveStallTicks <= 1),
  // adunk még egy megerősítő ciklust, hogy állókép/tesztábra miatt ne indítsuk újra feleslegesen!
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

  // 4. Ha a puffer kiürült, waiting/stalled állapot áll fenn, vagy a megerősítő ciklus után is
  // teljesen mozdulatlan mind az idővonal, mind a dekódolt képkocka (pl. M2 UHD dekóder-fagyás):
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
 * 4. Sebességteszt jelöltlista:
 * Biztonságosan meghatározza, mely támogatott módokat érdemes kipróbálni és összehasonlítani
 * anélkül, hogy túlterhelné a TV-t.
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
    // Ha a másik formátumot még nem mértük, vagy gyorsabbnak tűnik:
    const altUntested = altFormat === 'hls' ? record?.hlsAvgStartupMs == null : record?.tsAvgStartupMs == null;
    candidates.push({
      format: altFormat,
      url: altFormat === 'hls' ? hlsUrl : tsUrl,
      bufferProfile: altUntested ? currentBufferProfile : (record?.bestBufferProfile || currentBufferProfile),
    });
  }

  // Előre meghatározott pufferprofilok kipróbálási sorrendje:
  for (const preset of ['fast', 'balanced', 'stable'] as const) {
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
 * 5. & 10. Automatikus javítás és fokozatos pufferoptimalizálás (korlátozott lépésszámmal).
 */
export function planDoctorRepairStep(params: {
  channel?: Channel | null;
  trigger: DoctorTriggerReason;
  step: number;
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
  const urlFor = (fmt: LiveFormat) => (fmt === 'hls' ? hlsUrl : tsUrl) || streamUrl;
  const record = getChannelDoctorRecord(channel, storage);

  // Ha elértük a javítási korlátot vagy a biztonsági megszakítót, visszaállunk az alap helyreállításra:
  if (step > MAX_DOCTOR_REPAIR_STEPS || !canDoctorIntervene(channelKey)) {
    const safeCfg = getDoctorBufferConfig(record?.bestBufferProfile || currentBufferProfile);
    logDoctor(
      'warn',
      channel,
      `JAVÍTÁSI KORLÁT ELÉRVE (${step}/${MAX_DOCTOR_REPAIR_STEPS}) – visszaállás a kímélő alap helyreállításra`,
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
          errorReason: trigger,
          recovered: false,
        },
      });
    }
    return {
      step,
      maxSteps: MAX_DOCTOR_REPAIR_STEPS,
      strategyId: 'fallback_legacy_recovery',
      description: 'korlát elérve – alap helyreállítás',
      nextFormat: currentFormat,
      nextUrl: urlFor(currentFormat),
      nextBufferProfile: safeCfg.id,
      nextBufferTiming: safeCfg,
      delayMs: 1500,
      useFallbackUrl: false,
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
          maxSteps: MAX_DOCTOR_REPAIR_STEPS,
          strategyId: custom.strategyId || plugin.id,
          description: custom.description || `bővítmény javítás (${plugin.id})`,
          nextFormat: custom.nextFormat,
          nextUrl: custom.nextUrl,
          nextBufferProfile: cfg.id,
          nextBufferTiming: custom.nextBufferTiming ? clampBufferTiming(custom.nextBufferTiming) : cfg,
          delayMs: custom.delayMs ?? 250,
          useFallbackUrl: Boolean(custom.useFallbackUrl),
          exhausted: false,
        };
      }
    } catch {
      /* ignore plugin error */
    }
  }

  const isStallTrigger = trigger === 'playback_stall' || trigger === 'buffer_stall';
  let strategyId = 'same_format_retry';
  let description = 'gyors újrapróbálás az aktuális módban';
  let nextFormat: LiveFormat = currentFormat;
  let nextBufferProfile: DoctorBufferProfileId = currentBufferProfile;
  let nextUrl = urlFor(currentFormat);
  let useFallbackUrl = false;
  let delayMs = 120;

  if (isStallTrigger) {
    // Megakadás/fagyás esetén:
    // 1. lépés: előre meghatározott / következő biztonságos pufferprofilra emelés ugyanazon a formátumon
    // 2. lépés: még egy pufferlépcső emelése (egészen max 10 mp-ig)
    // 3. lépés: formátumváltás + emelt puffer (sebesség- és stabilitásteszt)
    // 4-5. lépés: tartalék URL (ha van) vagy maximális védett puffer (adaptive-3)
    if (step === 1) {
      nextBufferProfile = nextSafeBufferProfile(currentBufferProfile);
      strategyId = 'buffer_step_up';
      description = `puffer növelése (${currentBufferProfile} -> ${nextBufferProfile})`;
      delayMs = 200;
    } else if (step === 2 && hasAlternateFormat) {
      nextFormat = altFormat;
      nextUrl = urlFor(altFormat);
      nextBufferProfile = nextSafeBufferProfile(currentBufferProfile);
      strategyId = 'switch_format_with_buffer';
      description = `formátumváltás (${altFormat.toUpperCase()}) + emelt puffer (${nextBufferProfile})`;
      delayMs = 250;
    } else if (step <= 4) {
      const raised = nextSafeBufferProfile(nextSafeBufferProfile(currentBufferProfile));
      nextBufferProfile = raised;
      nextFormat = hasAlternateFormat && step === 4 ? altFormat : currentFormat;
      nextUrl = urlFor(nextFormat);
      strategyId = 'progressive_buffer_tuning';
      description = `fokozatos pufferfinomhangolás (${nextBufferProfile}, ${getDoctorBufferConfig(nextBufferProfile).minBufferAheadSeconds}mp)`;
      delayMs = 400;
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
        description = 'maximális biztonságos pufferhatár (10 mp)';
      }
      delayMs = 600;
    }
  } else {
    // Indulási hiba / időtúllépés / váratlan leállás esetén:
    // 1. lépés: azonnali gyors újrapróba ugyanazzal a formátummal
    // 2. lépés: formátumváltás (TS <-> HLS sebesség- és kompatibilitási próba)
    // 3. lépés: pufferprofil emelése a stabilabb indulásért
    // 4. lépés: másik formátum + emelt puffer
    // 5. lépés: tartalék URL (ha van) vagy védett pufferhatár
    if (step === 1) {
      nextFormat = currentFormat;
      nextUrl = urlFor(currentFormat);
      nextBufferProfile = currentBufferProfile;
      strategyId = 'quick_primary_retry';
      description = `első formátum gyors újrapróbája (${currentFormat.toUpperCase()})`;
      delayMs = 80;
    } else if (step === 2 && hasAlternateFormat) {
      nextFormat = altFormat;
      nextUrl = urlFor(altFormat);
      nextBufferProfile = currentBufferProfile;
      strategyId = 'format_switch_probe';
      description = `formátumváltás és sebességmérés (${currentFormat.toUpperCase()} -> ${altFormat.toUpperCase()})`;
      delayMs = 100;
    } else if (step === 3) {
      nextFormat = hasAlternateFormat ? currentFormat : currentFormat;
      nextUrl = urlFor(nextFormat);
      nextBufferProfile = nextSafeBufferProfile(currentBufferProfile);
      strategyId = 'startup_buffer_step_up';
      description = `indulási puffer emelése (${nextBufferProfile})`;
      delayMs = 300;
    } else if (step === 4 && hasAlternateFormat) {
      nextFormat = altFormat;
      nextUrl = urlFor(altFormat);
      nextBufferProfile = nextSafeBufferProfile(nextSafeBufferProfile(currentBufferProfile));
      strategyId = 'alternate_format_raised_buffer';
      description = `alternatív formátum (${altFormat.toUpperCase()}) + stabilizált puffer (${nextBufferProfile})`;
      delayMs = 450;
    } else {
      nextBufferProfile = nextSafeBufferProfile(nextSafeBufferProfile(currentBufferProfile));
      if (channel?.fallbackUrl && channel.fallbackUrl !== nextUrl) {
        nextUrl = channel.fallbackUrl;
        useFallbackUrl = true;
        strategyId = 'fallback_url_repair';
        description = 'tartalék csatorna-URL aktiválása';
      } else {
        nextFormat = hasAlternateFormat ? altFormat : currentFormat;
        nextUrl = urlFor(nextFormat);
        strategyId = 'final_bounded_repair';
        description = `védett újraindítás (${nextFormat.toUpperCase()}, puffer=${nextBufferProfile})`;
      }
      delayMs = 650;
    }
  }

  const nextCfg = getDoctorBufferConfig(nextBufferProfile);

  logDoctor(
    'repair',
    channel,
    `JAVÍTÁS [${step}/${MAX_DOCTOR_REPAIR_STEPS}] stratégia=${strategyId} -> ${description}`,
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
        bufferAheadSeconds: nextCfg.minBufferAheadSeconds,
        errorReason: trigger,
        details: { step, strategyId },
      },
    });
  }

  return {
    step,
    maxSteps: MAX_DOCTOR_REPAIR_STEPS,
    strategyId,
    description,
    nextFormat,
    nextUrl,
    nextBufferProfile,
    nextBufferTiming: nextCfg,
    delayMs,
    useFallbackUrl,
    exhausted: false,
  };
}

/**
 * Központi (Supabase) profilok összefésülése a helyi tanuló memóriával.
 * Internetkimaradáskor a helyi gyorsítótár önállóan is működik; ha a felhőből
 * érkezik több készülék által igazolt tapasztalat, azzal feltölti az ismeretlen
 * csatornákat, a helyileg már igazolt csatornáknál pedig finoman súlyoz.
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
    const bp: DoctorBufferProfileId = isValidBufferProfile(incoming.bestBufferProfile)
      ? incoming.bestBufferProfile
      : 'balanced';
    const existing = store.byKey[key];

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
        tsAvgStartupMs: typeof incoming.tsAvgStartupMs === 'number' ? Math.round(incoming.tsAvgStartupMs) : null,
        hlsAvgStartupMs: typeof incoming.hlsAvgStartupMs === 'number' ? Math.round(incoming.hlsAvgStartupMs) : null,
        bestStartupMs: typeof incoming.bestStartupMs === 'number' ? Math.round(incoming.bestStartupMs) : null,
        tsOk: Math.max(0, Number(incoming.tsSuccessCount) || 0),
        tsFail: Math.max(0, Number(incoming.tsFailureCount) || 0),
        hlsOk: Math.max(0, Number(incoming.hlsSuccessCount) || 0),
        hlsFail: Math.max(0, Number(incoming.hlsFailureCount) || 0),
        stalls: Math.max(0, Number(incoming.stallCount) || 0),
        repairsOk: Math.max(0, Number(incoming.repairSuccessCount) || 0),
        bufferStats: incoming.bufferScores && typeof incoming.bufferScores === 'object' ? incoming.bufferScores : {},
        source: 'cloud',
        confidence: incoming.confidenceScore,
        updatedAt: Date.now(),
      };
      store.byKey[key] = created;
      if (created.channelId && !store.idIndex[created.channelId]) {
        store.idIndex[created.channelId] = key;
      }
      mergedCount += 1;
    } else {
      // Ha helyileg még kevés a mérés (< 3 sikeres indulás), a magas megbízhatóságú felhő-adat segít:
      const localSamples = existing.tsOk + existing.hlsOk;
      if (localSamples < 3 && (incoming.confidenceScore || 0) >= 55) {
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
      if (existing.tsAvgStartupMs === null && typeof incoming.tsAvgStartupMs === 'number') {
        existing.tsAvgStartupMs = Math.round(incoming.tsAvgStartupMs);
      }
      if (existing.hlsAvgStartupMs === null && typeof incoming.hlsAvgStartupMs === 'number') {
        existing.hlsAvgStartupMs = Math.round(incoming.hlsAvgStartupMs);
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

// Alapértelmezett beépített diagnosztikai bővítmény: képfelbontás és ejtett képkocka arány.
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
