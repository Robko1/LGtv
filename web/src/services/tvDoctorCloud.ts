import { WEB_VERSION } from '../appVersion';
import { appLog } from './appLog';
import { tvDeviceInfo } from './tvDevice';
import {
  ChannelDoctorRecord,
  CloudChannelProfileInput,
  mergeCloudProfilesIntoLocal,
  setTvDoctorCloudHook,
} from './tvDoctor';

const DEFAULT_API_URL = 'https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor';
const API_KEY = 'sb_publishable_JschCWGjgSE_b0NyINwxqA_7zAnS56C';
const SYNC_STATE_KEY = 'iptv_rt_tv_doctor_sync_v1';

const REQUEST_TIMEOUT_MS = 12_000;
const BOOTSTRAP_DELAY_MS = 3_800;
const FLUSH_DEBOUNCE_MS = 14_000;
const MAX_PENDING_PROFILES = 30;
const MAX_PENDING_EVENTS = 35;

export interface PendingProfileSync {
  channelKey: string;
  channelIdHint?: string;
  channelName: string;
  countryCode?: string;
  bestFormat: 'ts' | 'hls';
  bestBufferProfile: string;
  bestBufferAheadSeconds: number;
  tsAvgStartupMs: number | null;
  hlsAvgStartupMs: number | null;
  bestStartupMs: number | null;
  tsSuccessDelta: number;
  tsFailureDelta: number;
  hlsSuccessDelta: number;
  hlsFailureDelta: number;
  stallDelta: number;
  repairSuccessDelta: number;
  bufferScores: Record<string, unknown>;
  lastErrorCode?: string;
  lastErrorReason?: string;
}

export interface PendingDoctorEvent {
  eventUid: string;
  eventType: string;
  channelKey: string;
  channelId?: string;
  channelName: string;
  playbackFormat?: string;
  bufferProfile?: string;
  bufferAheadSeconds?: number;
  startupMs?: number;
  stallMs?: number;
  errorCode?: string;
  errorReason?: string;
  recovered?: boolean;
  details?: Record<string, unknown>;
}

interface PersistedSyncState {
  deviceSeed: string;
  lastSyncAt: string | null;
  cloudProfileCount: number;
  pendingProfiles: Record<string, PendingProfileSync>;
  pendingEvents: PendingDoctorEvent[];
}

export interface TvDoctorCloudStatus {
  enabled: boolean;
  lastSyncAt: string | null;
  pendingCount: number;
  cloudProfileCount: number;
  syncing: boolean;
}

let cloudEnabled = true;
let syncingNow = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
let cachedState: PersistedSyncState | null = null;

function scheduleTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
    return window.setTimeout(fn, ms) as unknown as ReturnType<typeof setTimeout>;
  }
  return setTimeout(fn, ms);
}

function cancelTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer === null) return;
  if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
    window.clearTimeout(timer as unknown as number);
    return;
  }
  clearTimeout(timer);
}

function getApiUrl(): string {
  const g = globalThis as unknown as { __TV_DOCTOR_API_URL__?: string };
  return g.__TV_DOCTOR_API_URL__ || DEFAULT_API_URL;
}

function randomSeed(): string {
  return `tv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readSyncState(): PersistedSyncState {
  if (cachedState) return cachedState;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SYNC_STATE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        cachedState = {
          deviceSeed: typeof parsed.deviceSeed === 'string' && parsed.deviceSeed ? parsed.deviceSeed : randomSeed(),
          lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
          cloudProfileCount: Math.max(0, Number(parsed.cloudProfileCount) || 0),
          pendingProfiles: parsed.pendingProfiles && typeof parsed.pendingProfiles === 'object' ? parsed.pendingProfiles : {},
          pendingEvents: Array.isArray(parsed.pendingEvents) ? parsed.pendingEvents.slice(-MAX_PENDING_EVENTS) : [],
        };
        return cachedState;
      }
    }
  } catch {
    /* ignore */
  }
  cachedState = {
    deviceSeed: randomSeed(),
    lastSyncAt: null,
    cloudProfileCount: 0,
    pendingProfiles: {},
    pendingEvents: [],
  };
  return cachedState;
}

function saveSyncState(): void {
  if (!cachedState) return;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(cachedState));
    }
  } catch {
    /* Offline memóriában tovább működik, soha nem dob hibát. */
  }
}

const SECRET_LABELS = ['username', 'user', 'password', 'passwd', 'token', 'authorization', 'api_key', 'apikey', 'secret'];

export function redactDoctorText(input: unknown, maxLen = 140): string | undefined {
  if (input === null || input === undefined) return undefined;
  let result = String(input);
  for (const label of SECRET_LABELS) {
    const field = new RegExp(`((?:^|[?&\\s;,(\\[{])${label}\\s*[:=]\\s*)([^\\s&;,\\]})]+)`, 'ig');
    result = result.replace(field, '$1[REDACTED]');
  }
  result = result.replace(/(https?:\/\/[^/\s]+\/(?:live|movie|series|subtitle)\/)[^/\s]+\/[^/\s]+/gi, '$1[REDACTED]/[REDACTED]');
  result = result.replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, '$1[REDACTED]@');
  result = result.replace(/https?:\/\/[^\s]+/gi, '[URL]').trim();
  return result ? result.slice(0, maxLen) : undefined;
}

function safeCleanText(input: unknown, maxLen = 140): string | undefined {
  return redactDoctorText(input, maxLen);
}

async function postTvDoctor(body: Record<string, unknown>): Promise<any | null> {
  if (typeof fetch !== 'function') return null;
  const AbortCtor = typeof AbortController !== 'undefined' ? AbortController : null;
  const controller = AbortCtor ? new AbortCtor() : null;
  const timeout = controller ? scheduleTimer(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    const response = await fetch(getApiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: API_KEY,
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response || !response.ok) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  } finally {
    cancelTimer(timeout);
  }
}

/**
 * Letölti a központi Supabase tudásbázisból a csatornákhoz tartozó bevált profilokat,
 * így a TV-nek nem kell minden tesztet elölről kezdenie, és több készülék tapasztalatát is hasznosítja.
 */
export async function bootstrapTvDoctorFromCloud(): Promise<number> {
  if (!cloudEnabled || syncingNow) return 0;
  const state = readSyncState();
  syncingNow = true;
  try {
    const res = await postTvDoctor({
      action: 'bootstrap',
      since: state.lastSyncAt || undefined,
      limit: 400,
    });
    if (!res || !res.ok || !Array.isArray(res.profiles)) return 0;

    const merged = mergeCloudProfilesIntoLocal(res.profiles as CloudChannelProfileInput[]);
    if (typeof res.serverTime === 'string') {
      state.lastSyncAt = res.serverTime;
    } else {
      state.lastSyncAt = new Date().toISOString();
    }
    state.cloudProfileCount = Math.max(state.cloudProfileCount, res.profiles.length);
    saveSyncState();

    if (merged > 0) {
      appLog(`TV DOKTOR FELHŐ: ${merged} csatornaprofil letöltve és összefésülve`);
    }
    return merged;
  } catch {
    return 0;
  } finally {
    syncingNow = false;
  }
}

/**
 * Elküldi a helyileg összegyűjtött méréseket, hibákat és sikeres javításokat a Supabase-nek.
 * Ha nincs internetkapcsolat, az adatok a korlátozott helyi várólistában maradnak későbbi küldésre.
 */
export async function flushTvDoctorCloudQueue(): Promise<boolean> {
  cancelTimer(flushTimer);
  flushTimer = null;
  if (!cloudEnabled || syncingNow) return false;

  const state = readSyncState();
  const profileKeys = Object.keys(state.pendingProfiles);
  const eventsToSend = state.pendingEvents.slice(0, MAX_PENDING_EVENTS);
  if (profileKeys.length === 0 && eventsToSend.length === 0) return true;

  const profilesToSend = profileKeys.slice(0, MAX_PENDING_PROFILES).map((k) => state.pendingProfiles[k]);
  const tv = tvDeviceInfo();

  syncingNow = true;
  try {
    const res = await postTvDoctor({
      action: 'sync',
      deviceHash: state.deviceSeed,
      tvModel: safeCleanText(tv?.modelName || 'LG webOS TV', 64),
      webosVersion: safeCleanText(tv?.sdkVersion || tv?.firmware || '', 32),
      appVersion: WEB_VERSION,
      profiles: profilesToSend,
      events: eventsToSend,
    });

    if (!res || !res.ok) {
      return false;
    }

    // Sikeres szinkron után töröljük az elküldött tételeket a várólistáról:
    for (const sent of profilesToSend) {
      delete state.pendingProfiles[sent.channelKey];
    }
    const sentUids = new Set(eventsToSend.map((e) => e.eventUid));
    state.pendingEvents = state.pendingEvents.filter((e) => !sentUids.has(e.eventUid));

    if (Array.isArray(res.mergedProfiles) && res.mergedProfiles.length > 0) {
      mergeCloudProfilesIntoLocal(res.mergedProfiles as CloudChannelProfileInput[]);
      state.cloudProfileCount = Math.max(state.cloudProfileCount, res.mergedProfiles.length);
    }
    state.lastSyncAt = typeof res.serverTime === 'string' ? res.serverTime : new Date().toISOString();
    saveSyncState();
    return true;
  } catch {
    return false;
  } finally {
    syncingNow = false;
  }
}

function scheduleDeferredFlush(): void {
  if (!cloudEnabled || flushTimer !== null) return;
  flushTimer = scheduleTimer(() => {
    flushTimer = null;
    void flushTvDoctorCloudQueue();
  }, FLUSH_DEBOUNCE_MS);
}

function enqueueFromHook(payload: {
  eventType: string;
  record?: ChannelDoctorRecord | null;
  event: Record<string, unknown>;
}): void {
  if (!cloudEnabled) return;
  const state = readSyncState();
  const { eventType, record, event } = payload;

  if (record && record.channelKey) {
    const prev = state.pendingProfiles[record.channelKey];
    const tsOkDelta = Number(event.tsSuccessDelta) || 0;
    const tsFailDelta = Number(event.tsFailureDelta) || 0;
    const hlsOkDelta = Number(event.hlsSuccessDelta) || 0;
    const hlsFailDelta = Number(event.hlsFailureDelta) || 0;
    const stallDelta = Number(event.stallDelta) || 0;
    const repairDelta = Number(event.repairSuccessDelta) || 0;

    state.pendingProfiles[record.channelKey] = {
      channelKey: record.channelKey,
      channelIdHint: safeCleanText(record.channelId, 100),
      channelName: safeCleanText(record.channelName, 140) || record.channelKey,
      countryCode: safeCleanText(record.countryCode, 12),
      bestFormat: record.bestFormat,
      bestBufferProfile: record.bestBufferProfile,
      bestBufferAheadSeconds: record.bestBufferAheadSeconds,
      tsAvgStartupMs: record.tsAvgStartupMs,
      hlsAvgStartupMs: record.hlsAvgStartupMs,
      bestStartupMs: record.bestStartupMs,
      tsSuccessDelta: (prev?.tsSuccessDelta || 0) + tsOkDelta,
      tsFailureDelta: (prev?.tsFailureDelta || 0) + tsFailDelta,
      hlsSuccessDelta: (prev?.hlsSuccessDelta || 0) + hlsOkDelta,
      hlsFailureDelta: (prev?.hlsFailureDelta || 0) + hlsFailDelta,
      stallDelta: (prev?.stallDelta || 0) + stallDelta,
      repairSuccessDelta: (prev?.repairSuccessDelta || 0) + repairDelta,
      bufferScores: (record.bufferStats || {}) as Record<string, unknown>,
      lastErrorCode: safeCleanText(record.lastErrorCode, 48),
      lastErrorReason: safeCleanText(record.lastErrorReason, 120),
    };

    const keys = Object.keys(state.pendingProfiles);
    if (keys.length > MAX_PENDING_PROFILES) {
      delete state.pendingProfiles[keys[0]];
    }
  }

  // Rutin mérésekből nem árasztjuk el az eseménytáblát, csak hibákat, teszteket és javításokat küldünk eseményként;
  // a sebességmérések a csatornaprofilokba összevontan kerülnek fel!
  if (eventType !== 'measurement') {
    const channelKey = safeCleanText(event.channelKey, 120);
    const channelName = safeCleanText(event.channelName, 140);
    if (channelKey && channelName) {
      state.pendingEvents.push({
        eventUid: `${state.deviceSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        eventType,
        channelKey,
        channelId: safeCleanText(event.channelId, 100),
        channelName,
        playbackFormat: safeCleanText(event.playbackFormat, 12),
        bufferProfile: safeCleanText(event.bufferProfile, 24),
        bufferAheadSeconds: typeof event.bufferAheadSeconds === 'number' ? event.bufferAheadSeconds : undefined,
        startupMs: typeof event.startupMs === 'number' ? Math.round(event.startupMs) : undefined,
        stallMs: typeof event.stallMs === 'number' ? Math.round(event.stallMs) : undefined,
        errorCode: safeCleanText(event.errorCode, 48),
        errorReason: safeCleanText(event.errorReason, 140),
        recovered: typeof event.recovered === 'boolean' ? event.recovered : undefined,
        details: event.details && typeof event.details === 'object' ? (event.details as Record<string, unknown>) : undefined,
      });
      if (state.pendingEvents.length > MAX_PENDING_EVENTS) {
        state.pendingEvents.splice(0, state.pendingEvents.length - MAX_PENDING_EVENTS);
      }
    }
  }

  saveSyncState();
  scheduleDeferredFlush();
}

/** TV Doktor hibrid felhőszinkron engedélyezése vagy leállítása (beállítás-kapcsolóhoz kötve). */
export function configureTvDoctorCloud(enabled: boolean): void {
  cloudEnabled = enabled;
  if (!enabled) {
    setTvDoctorCloudHook(null);
    cancelTimer(flushTimer);
    cancelTimer(bootstrapTimer);
    flushTimer = null;
    bootstrapTimer = null;
    return;
  }

  setTvDoctorCloudHook(enqueueFromHook);
  if (bootstrapTimer === null) {
    bootstrapTimer = scheduleTimer(() => {
      bootstrapTimer = null;
      void bootstrapTvDoctorFromCloud().then(() => {
        const st = readSyncState();
        if (Object.keys(st.pendingProfiles).length > 0 || st.pendingEvents.length > 0) {
          void flushTvDoctorCloudQueue();
        }
      });
    }, BOOTSTRAP_DELAY_MS);
  }
}

export function getTvDoctorCloudStatus(): TvDoctorCloudStatus {
  const state = readSyncState();
  const pendingCount = Object.keys(state.pendingProfiles).length + state.pendingEvents.length;
  return {
    enabled: cloudEnabled,
    lastSyncAt: state.lastSyncAt,
    pendingCount,
    cloudProfileCount: state.cloudProfileCount,
    syncing: syncingNow,
  };
}

export function clearTvDoctorCloudQueue(): void {
  cachedState = null;
  cancelTimer(flushTimer);
  cancelTimer(bootstrapTimer);
  flushTimer = null;
  bootstrapTimer = null;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(SYNC_STATE_KEY);
    }
  } catch {
    /* ignore */
  }
}
