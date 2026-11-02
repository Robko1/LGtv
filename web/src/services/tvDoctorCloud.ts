import { WEB_VERSION } from '../appVersion';
import { appLog, isVerbosePlaybackLogging, registerLoggingLifecycleHooks } from './appLog';
import { tvDeviceInfo } from './tvDevice';
import {
  ChannelDoctorRecord,
  CloudChannelProfileInput,
  clearTvDoctorMemory,
  formatDoctorBytes,
  getTvDoctorMemoryStats,
  getTvDoctorOperationHealth,
  getTvDoctorSummary,
  isTvDoctorDiagLoggingEnabled,
  mergeCloudProfilesIntoLocal,
  notifyTvDoctorListeners,
  resetTvDoctorOperationCounters,
  setTvDoctorCloudHook,
  TV_DOCTOR_SYNC_STORAGE_KEY,
} from './tvDoctor';

const DEFAULT_API_URL = 'https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor';
const API_KEY = 'sb_publishable_JschCWGjgSE_b0NyINwxqA_7zAnS56C';
const SYNC_STATE_KEY = TV_DOCTOR_SYNC_STORAGE_KEY;
export const TV_DOCTOR_PAIRING_STORAGE_KEY = 'iptv_rt_tv_doctor_pairing_v1';

const IDB_NAME = 'iptv_tv_doctor_pairing_db_v1';
const IDB_STORE = 'pairing';
const IDB_PRIMARY_KEY = 'primary';

const REQUEST_TIMEOUT_MS = 12_000;
const STATUS_CHECK_TIMEOUT_MS = 7_500;
const SLOW_CLOUD_THRESHOLD_MS = 3_500;
const BOOTSTRAP_DELAY_MS = 3_800;
const FLUSH_DEBOUNCE_MS = 14_000;
const MAX_PENDING_PROFILES = 30;
const MAX_PENDING_EVENTS = 35;

export type TvDoctorConnectionState =
  | 'disabled'
  | 'unpaired'
  | 'unchecked'
  | 'checking'
  | 'connected'
  | 'offline'
  | 'error';

export type TvDoctorPairingUiState =
  | 'unpaired'
  | 'verifying'
  | 'paired'
  | 'error';

export interface PersistedPairingState {
  deviceId: string;
  deviceToken: string | null;
  pairedAt: string | null;
  tokenExpiresAt: string | null;
  codeRequestedAt: string | null;
  codeExpiresAt: string | null;
}

export interface TvDoctorPairingInfo {
  paired: boolean;
  deviceId: string;
  pairedAt: string | null;
  tokenExpiresAt: string | null;
  codeRequestedAt: string | null;
  codeExpiresAt: string | null;
  uiState: TvDoctorPairingUiState;
  statusMessage: string | null;
  requestingCode: boolean;
  verifyingCode: boolean;
}

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
  paired: boolean;
  deviceId: string;
  connected: boolean;
  connectionState: TvDoctorConnectionState;
  lastSyncAt: string | null;
  lastCheckedAt: string | null;
  latencyMs: number | null;
  pendingCount: number;
  cloudProfileCount: number;
  syncing: boolean;
  checking: boolean;
  lastErrorCode: string | null;
  lastErrorLocation: string | null;
  lastErrorSummary: string | null;
  lastErrorAt: string | null;
}

interface CloudRuntimeConnection {
  connected: boolean;
  connectionState: TvDoctorConnectionState;
  lastCheckedAt: string | null;
  latencyMs: number | null;
  lastErrorCode: string | null;
  lastErrorLocation: string | null;
  lastErrorSummary: string | null;
  lastErrorAt: string | null;
}

let cloudEnabled = true;
let syncingNow = false;
let checkingNow = false;
let requestingCodeNow = false;
let verifyingCodeNow = false;
let diagnosticsAttached = false;
let idbHydrationStarted = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
let cachedState: PersistedSyncState | null = null;
let cachedPairing: PersistedPairingState | null = null;

let pairingUiOverride: {
  state: TvDoctorPairingUiState | null;
  message: string | null;
} = {
  state: null,
  message: null,
};

const runtimeConn: CloudRuntimeConnection = {
  connected: false,
  connectionState: 'unchecked',
  lastCheckedAt: null,
  latencyMs: null,
  lastErrorCode: null,
  lastErrorLocation: null,
  lastErrorSummary: null,
  lastErrorAt: null,
};

const PAIRING_AUTH_ERROR_CODES = new Set([
  'pairing_required',
  'device_not_paired',
  'device_revoked',
  'token_expired',
  'invalid_device_token',
]);

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

function generateDeviceId(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
  } catch {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let p1 = '';
  let p2 = '';
  for (let i = 0; i < 4; i += 1) {
    p1 += alphabet[bytes[i] % alphabet.length];
    p2 += alphabet[bytes[i + 4] % alphabet.length];
  }
  return `LG-${p1}-${p2}`;
}

function sanitizeDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned.length >= 6 ? cleaned : null;
}

function sanitizeDeviceToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim();
  if (cleaned.length < 32 || cleaned.length > 160) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(cleaned)) return null;
  return cleaned;
}

function openPairingIndexedDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        resolve(null);
        return;
      }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE);
          }
        } catch {
          /* ignore */
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbWritePairing(record: PersistedPairingState): Promise<void> {
  const db = await openPairingIndexedDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(record, IDB_PRIMARY_KEY);
      tx.oncomplete = () => {
        try { db.close(); } catch { /* ignore */ }
        resolve();
      };
      tx.onerror = () => {
        try { db.close(); } catch { /* ignore */ }
        resolve();
      };
      tx.onabort = () => {
        try { db.close(); } catch { /* ignore */ }
        resolve();
      };
    } catch {
      try { db.close(); } catch { /* ignore */ }
      resolve();
    }
  });
}

async function idbReadPairing(): Promise<PersistedPairingState | null> {
  const db = await openPairingIndexedDb();
  if (!db) return null;
  return await new Promise<PersistedPairingState | null>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_PRIMARY_KEY);
      req.onsuccess = () => {
        const val = req.result;
        try { db.close(); } catch { /* ignore */ }
        if (val && typeof val === 'object') {
          const deviceId = sanitizeDeviceId((val as any).deviceId);
          if (deviceId) {
            resolve({
              deviceId,
              deviceToken: sanitizeDeviceToken((val as any).deviceToken),
              pairedAt: typeof (val as any).pairedAt === 'string' ? (val as any).pairedAt : null,
              tokenExpiresAt: typeof (val as any).tokenExpiresAt === 'string' ? (val as any).tokenExpiresAt : null,
              codeRequestedAt: typeof (val as any).codeRequestedAt === 'string' ? (val as any).codeRequestedAt : null,
              codeExpiresAt: typeof (val as any).codeExpiresAt === 'string' ? (val as any).codeExpiresAt : null,
            });
            return;
          }
        }
        resolve(null);
      };
      req.onerror = () => {
        try { db.close(); } catch { /* ignore */ }
        resolve(null);
      };
    } catch {
      try { db.close(); } catch { /* ignore */ }
      resolve(null);
    }
  });
}

function readPairingState(): PersistedPairingState {
  if (cachedPairing) return cachedPairing;

  try {
    const raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem(TV_DOCTOR_PAIRING_STORAGE_KEY)
      : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      const validId = sanitizeDeviceId(parsed?.deviceId);
      if (validId) {
        cachedPairing = {
          deviceId: validId,
          deviceToken: sanitizeDeviceToken(parsed?.deviceToken),
          pairedAt: typeof parsed?.pairedAt === 'string' ? parsed.pairedAt : null,
          tokenExpiresAt: typeof parsed?.tokenExpiresAt === 'string' ? parsed.tokenExpiresAt : null,
          codeRequestedAt: typeof parsed?.codeRequestedAt === 'string' ? parsed.codeRequestedAt : null,
          codeExpiresAt: typeof parsed?.codeExpiresAt === 'string' ? parsed.codeExpiresAt : null,
        };
        if (!idbHydrationStarted) {
          idbHydrationStarted = true;
          void hydratePairingFromIndexedDb();
        }
        return cachedPairing;
      }
    }
  } catch {
    /* ignore */
  }

  cachedPairing = {
    deviceId: generateDeviceId(),
    deviceToken: null,
    pairedAt: null,
    tokenExpiresAt: null,
    codeRequestedAt: null,
    codeExpiresAt: null,
  };
  writePairingLocalOnly(cachedPairing);
  if (!idbHydrationStarted) {
    idbHydrationStarted = true;
    void hydratePairingFromIndexedDb();
  }
  return cachedPairing;
}

function writePairingLocalOnly(record: PersistedPairingState): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(TV_DOCTOR_PAIRING_STORAGE_KEY, JSON.stringify(record));
    }
  } catch {
    /* ignore */
  }
}

function savePairingState(record: PersistedPairingState): void {
  cachedPairing = record;
  writePairingLocalOnly(record);
  void idbWritePairing({ ...record });
  notifyTvDoctorListeners();
}

async function hydratePairingFromIndexedDb(): Promise<void> {
  const fromIdb = await idbReadPairing();
  const current = cachedPairing;
  if (!fromIdb) {
    if (current && current.deviceToken) {
      await idbWritePairing({ ...current });
    }
    return;
  }

  // Ha a localStorage elveszett (pl. TV újraindítás/gyorsítótár-ürítés), az IndexedDB visszaállítja a párosítást!
  if ((!current || !current.deviceToken) && fromIdb.deviceToken) {
    cachedPairing = { ...fromIdb };
    writePairingLocalOnly(cachedPairing);
    if (runtimeConn.connectionState === 'unpaired' || runtimeConn.connectionState === 'unchecked') {
      runtimeConn.connectionState = 'unchecked';
    }
    notifyTvDoctorListeners();
    if (cloudEnabled) {
      void bootstrapTvDoctorFromCloud().then(() => {
        const st = readSyncState();
        if (Object.keys(st.pendingProfiles).length > 0 || st.pendingEvents.length > 0) {
          void flushTvDoctorCloudQueue();
        }
      });
    }
    return;
  }

  if (current && current.deviceToken) {
    await idbWritePairing({ ...current });
  }
}

export function isTvDoctorPaired(): boolean {
  const pairing = readPairingState();
  return Boolean(pairing.deviceId && pairing.deviceToken);
}

/**
 * Alkalmazás-újraindítás / hidegindítás szimulálásához és visszaellenőrzéséhez:
 * törli a memóriabeli gyorsítótárat és újra betölti a tartós tárhelyről (localStorage + IndexedDB).
 */
export async function reloadTvDoctorPairingFromStorage(): Promise<TvDoctorPairingInfo> {
  cachedPairing = null;
  idbHydrationStarted = true;
  const local = readPairingState();
  if (!local.deviceToken) {
    const fromIdb = await idbReadPairing();
    if (fromIdb && fromIdb.deviceToken) {
      cachedPairing = { ...fromIdb };
      writePairingLocalOnly(cachedPairing);
    }
  }
  notifyTvDoctorListeners();
  return getTvDoctorPairingInfo();
}

export function getTvDoctorPairingInfo(): TvDoctorPairingInfo {
  const pairing = readPairingState();
  const paired = Boolean(pairing.deviceId && pairing.deviceToken);

  let uiState: TvDoctorPairingUiState = paired ? 'paired' : 'unpaired';
  if (verifyingCodeNow) {
    uiState = 'verifying';
  } else if (pairingUiOverride.state === 'error' && !paired) {
    uiState = 'error';
  } else if (pairingUiOverride.state) {
    uiState = pairingUiOverride.state;
  }

  return {
    paired,
    deviceId: pairing.deviceId,
    pairedAt: pairing.pairedAt,
    tokenExpiresAt: pairing.tokenExpiresAt,
    codeRequestedAt: pairing.codeRequestedAt,
    codeExpiresAt: pairing.codeExpiresAt,
    uiState,
    statusMessage: pairingUiOverride.message,
    requestingCode: requestingCodeNow,
    verifyingCode: verifyingCodeNow,
  };
}

function readSyncState(): PersistedSyncState {
  if (cachedState) return cachedState;
  const pairing = readPairingState();
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SYNC_STATE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const cleanPendingProfiles: Record<string, PendingProfileSync> = {};
        if (parsed.pendingProfiles && typeof parsed.pendingProfiles === 'object') {
          for (const [pk, pv] of Object.entries(parsed.pendingProfiles as Record<string, PendingProfileSync>)) {
            if (!pk || pk.startsWith('vod:') || pv?.countryCode === 'VOD' || pv?.countryCode === 'SER') continue;
            cleanPendingProfiles[pk] = pv;
          }
        }
        const cleanPendingEvents = Array.isArray(parsed.pendingEvents)
          ? parsed.pendingEvents
              .filter((ev: any) => ev && !String(ev.channelKey || '').startsWith('vod:'))
              .slice(-MAX_PENDING_EVENTS)
          : [];
        cachedState = {
          deviceSeed: pairing.deviceId,
          lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
          cloudProfileCount: Math.max(0, Number(parsed.cloudProfileCount) || 0),
          pendingProfiles: cleanPendingProfiles,
          pendingEvents: cleanPendingEvents,
        };
        if (cachedState.lastSyncAt && pairing.deviceToken && runtimeConn.connectionState === 'unchecked') {
          runtimeConn.connected = true;
          runtimeConn.connectionState = 'connected';
          runtimeConn.lastCheckedAt = cachedState.lastSyncAt;
        }
        return cachedState;
      }
    }
  } catch {
    /* ignore */
  }
  cachedState = {
    deviceSeed: pairing.deviceId,
    lastSyncAt: null,
    cloudProfileCount: 0,
    pendingProfiles: {},
    pendingEvents: [],
  };
  return cachedState;
}

function saveSyncState(): void {
  if (!cachedState) return;
  const pendingCount = Object.keys(cachedState.pendingProfiles).length + cachedState.pendingEvents.length;
  if (!cachedState.lastSyncAt && cachedState.cloudProfileCount === 0 && pendingCount === 0) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(SYNC_STATE_KEY);
      }
    } catch {
      /* ignore */
    }
    notifyTvDoctorListeners();
    return;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(cachedState));
    }
  } catch (err) {
    recordCloudError(
      'error',
      'STORAGE_QUOTA',
      'TV helyi tárhely (localStorage)',
      `A szinkron várólista mentése ütközött a tárhelykorláttal (${safeCleanText(err, 60) || 'kvóta'}). Nyomd meg a Memória: 0 gombot.`,
    );
  }
  notifyTvDoctorListeners();
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

function applySilentTokenRotation(parsed: any): void {
  if (!parsed || typeof parsed !== 'object') return;
  const nextToken = sanitizeDeviceToken(parsed.rotatedDeviceToken);
  if (!nextToken) return;
  const current = readPairingState();
  savePairingState({
    ...current,
    deviceToken: nextToken,
    tokenExpiresAt: typeof parsed.tokenExpiresAt === 'string' ? parsed.tokenExpiresAt : current.tokenExpiresAt,
  });
}

function handleServerPairingRejection(errorCode: string, serverMessage?: string): void {
  const current = readPairingState();
  savePairingState({
    ...current,
    deviceToken: null,
    tokenExpiresAt: null,
  });
  const reasonMsg = serverMessage
    || (errorCode === 'device_revoked'
      ? 'A készülék párosítása visszavonásra került. Párosítsd újra a Supabase-párosítás menüben.'
      : errorCode === 'token_expired'
        ? 'A készülék tokenje lejárt. Párosítsd újra a Supabase-párosítás menüben.'
        : 'A készülék nincs párosítva a védett Supabase adattárral.');
  pairingUiOverride = {
    state: 'unpaired',
    message: reasonMsg,
  };
  runtimeConn.connected = false;
  runtimeConn.connectionState = 'unpaired';
  runtimeConn.lastCheckedAt = new Date().toISOString();
  runtimeConn.lastErrorCode = errorCode.toUpperCase();
  runtimeConn.lastErrorLocation = 'Supabase TV-párosítás';
  runtimeConn.lastErrorSummary = reasonMsg;
  runtimeConn.lastErrorAt = runtimeConn.lastCheckedAt;
  notifyTvDoctorListeners();
}

function recordCloudSuccess(latencyMs: number): void {
  const nowIso = new Date().toISOString();
  runtimeConn.connected = true;
  runtimeConn.connectionState = 'connected';
  runtimeConn.lastCheckedAt = nowIso;
  runtimeConn.latencyMs = Math.max(1, Math.round(latencyMs));
  runtimeConn.lastErrorCode = null;
  runtimeConn.lastErrorLocation = null;
  runtimeConn.lastErrorSummary = null;
  runtimeConn.lastErrorAt = null;
  if (latencyMs >= SLOW_CLOUD_THRESHOLD_MS && isTvDoctorDiagLoggingEnabled()) {
    appLog(
      `TV DOKTOR SUPABASE LASSULÁS: a tv-doctor szerver válasza ${Math.round(latencyMs)} ms volt (küszöb=${SLOW_CLOUD_THRESHOLD_MS} ms)`,
    );
  }
  notifyTvDoctorListeners();
}

function recordCloudError(
  state: 'offline' | 'error' | 'unpaired',
  code: string,
  location: string,
  summary: string,
): void {
  const nowIso = new Date().toISOString();
  runtimeConn.connected = false;
  runtimeConn.connectionState = state;
  runtimeConn.lastCheckedAt = nowIso;
  runtimeConn.lastErrorCode = code;
  runtimeConn.lastErrorLocation = location;
  runtimeConn.lastErrorSummary = summary;
  runtimeConn.lastErrorAt = nowIso;
  if (isTvDoctorDiagLoggingEnabled()) {
    appLog(`TV DOKTOR SUPABASE HIBA [hely=${location}; kód=${code}]: ${summary}`);
  }
  notifyTvDoctorListeners();
}

function classifyHttpError(status: number, rawBody: string): {
  code: string;
  location: string;
  summary: string;
  pairingErrorCode?: string;
  serverMessage?: string;
} {
  let detail = '';
  let parsedErrorCode = '';
  let serverMessage = '';
  try {
    const parsed = rawBody ? JSON.parse(rawBody) : null;
    parsedErrorCode = typeof parsed?.error === 'string' ? parsed.error : '';
    serverMessage = typeof parsed?.message === 'string' ? parsed.message : '';
    detail = safeCleanText(parsed?.error || parsed?.message || parsed?.reason || '', 90) || '';
  } catch {
    detail = safeCleanText(rawBody, 80) || '';
  }

  if (status === 401 && PAIRING_AUTH_ERROR_CODES.has(parsedErrorCode)) {
    return {
      code: parsedErrorCode.toUpperCase(),
      location: 'Supabase TV-párosítás',
      summary: serverMessage || 'A TV nincs párosítva vagy a párosítás érvénytelenné vált.',
      pairingErrorCode: parsedErrorCode,
      serverMessage,
    };
  }

  if (status === 401 || status === 403) {
    return {
      code: `HTTP_${status}`,
      location: 'Supabase hitelesítés (API kulcs / jogosultság)',
      summary: `HTTP ${status}: A Supabase elutasította a kérést. Ellenőrizd a jogosultságot.`,
    };
  }
  if (status === 404) {
    return {
      code: 'HTTP_404',
      location: 'Supabase Edge Function (tv-doctor végpont)',
      summary: 'HTTP 404: A tv-doctor Edge Function nem található a Supabase szerveren.',
    };
  }
  if (status === 429) {
    return {
      code: 'HTTP_429',
      location: 'Supabase kéréskorlát (Rate Limit)',
      summary: serverMessage || 'HTTP 429: Túl sok kérés érkezett egyszerre; próbáld újra kicsit később.',
    };
  }
  if (status >= 500) {
    const isDbError = /tv_doctor|relation|schema|postgres|pgrst|rpc|table|database/i.test(detail);
    if (isDbError) {
      return {
        code: `HTTP_${status}`,
        location: 'Supabase adatbázis (tv_doctor táblák)',
        summary: `HTTP ${status}: Adatbázis hiba (${detail || 'tábla/migráció'}). Ellenőrizd a tv_doctor_channel_profiles táblát.`,
      };
    }
    return {
      code: `HTTP_${status}`,
      location: 'Supabase szerver (tv-doctor Edge Function)',
      summary: `HTTP ${status}: Szerveroldali hiba a tv-doctor függvényben${detail ? ` (${detail})` : ''}.`,
    };
  }
  return {
    code: `HTTP_${status}`,
    location: 'Supabase API kérés (tv-doctor)',
    summary: `HTTP ${status}: Váratlan válasz a szervertől${detail ? ` (${detail})` : ''}.`,
  };
}

async function postTvDoctor(
  body: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
  requirePairingAuth = true,
): Promise<any | null> {
  const pairing = readPairingState();
  if (requirePairingAuth && (!pairing.deviceId || !pairing.deviceToken)) {
    runtimeConn.connected = false;
    runtimeConn.connectionState = 'unpaired';
    notifyTvDoctorListeners();
    return null;
  }

  if (typeof fetch !== 'function') {
    recordCloudError(
      'error',
      'NO_FETCH',
      'TV böngészőmotor (fetch API)',
      'A TV környezetében nem érhető el a hálózati fetch modul; csak helyi gyorsítótár működik.',
    );
    return null;
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    recordCloudError(
      'offline',
      'OFFLINE',
      'TV internetkapcsolat (Wi-Fi / LAN)',
      'A TV jelenleg nincs internetre csatlakoztatva. Helyi gyorsítótárról hibátlanul fut tovább.',
    );
    return null;
  }

  const startedAt = Date.now();
  const AbortCtor = typeof AbortController !== 'undefined' ? AbortController : null;
  const controller = AbortCtor ? new AbortCtor() : null;
  let timedOut = false;
  const timeout = controller
    ? scheduleTimer(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;

  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: API_KEY,
    Authorization: `Bearer ${API_KEY}`,
    'x-tv-device-id': pairing.deviceId,
  };
  const payloadBody: Record<string, unknown> = {
    deviceId: pairing.deviceId,
    ...body,
  };
  if (requirePairingAuth && pairing.deviceToken) {
    reqHeaders['x-tv-device-token'] = pairing.deviceToken;
    payloadBody.deviceToken = pairing.deviceToken;
  }

  try {
    const response = await fetch(getApiUrl(), {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(payloadBody),
      ...(controller ? { signal: controller.signal } : {}),
    });

    const elapsedMs = Date.now() - startedAt;
    if (!response) {
      recordCloudError(
        'error',
        'EMPTY_RESPONSE',
        'Hálózat / Supabase átjáró',
        'Nem érkezett HTTP válasz a Supabase végponttól.',
      );
      return null;
    }

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const classified = classifyHttpError(response.status, text);
      if (requirePairingAuth && classified.pairingErrorCode) {
        handleServerPairingRejection(classified.pairingErrorCode, classified.serverMessage);
        return null;
      }
      recordCloudError('error', classified.code, classified.location, classified.summary);
      return null;
    }

    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      recordCloudError(
        'error',
        'INVALID_JSON',
        'Supabase válaszfeldolgozás (JSON)',
        'Érvénytelen (nem JSON) válasz érkezett a szervertől.',
      );
      return null;
    }

    if (!parsed || parsed.ok === false) {
      const errDetail = safeCleanText(parsed?.error || parsed?.message || 'ismeretlen szerverhiba', 90) || 'ismeretlen hiba';
      const isDb = /tv_doctor|relation|schema|postgres|pgrst|table|database/i.test(errDetail);
      recordCloudError(
        'error',
        'API_REJECTED',
        isDb ? 'Supabase adatbázis (tv_doctor táblák)' : 'Supabase tv-doctor Edge Function',
        `A szerver hibát jelzett: ${errDetail}.`,
      );
      return null;
    }

    applySilentTokenRotation(parsed);
    if (requirePairingAuth) {
      recordCloudSuccess(elapsedMs);
    }
    return parsed;
  } catch (cause: any) {
    const isOfflineNow = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (isOfflineNow) {
      recordCloudError(
        'offline',
        'OFFLINE',
        'TV internetkapcsolat (Wi-Fi / LAN)',
        'Megszakadt a TV internetkapcsolata. Ellenőrizd a Wi-Fi / LAN kábelt.',
      );
      return null;
    }
    if (timedOut || cause?.name === 'AbortError') {
      recordCloudError(
        'error',
        'TIMEOUT',
        'Hálózat / Supabase válaszidő (időtúllépés)',
        `A Supabase szerver ${Math.round(timeoutMs / 1000)} mp alatt nem válaszolt.`,
      );
      return null;
    }
    const errText = safeCleanText(cause?.message || cause, 70) || 'hálózati hiba';
    recordCloudError(
      'error',
      'NETWORK_ERROR',
      'Hálózat / DNS / TLS kapcsolat',
      `Nem sikerült elérni a Supabase végpontot (${errText}).`,
    );
    return null;
  } finally {
    cancelTimer(timeout);
  }
}

/**
 * Új 6 jegyű, egyszer használatos párosítási kód igénylése a tévéről.
 * A nyers 6 jegyű kódot kizárólag a Supabase-hez hozzáféréssel rendelkező jogosult fél olvashatja ki.
 */
export async function requestTvDoctorPairingCode(): Promise<{
  ok: boolean;
  expiresAt?: string;
  expiresInSeconds?: number;
  maxAttempts?: number;
  message: string;
}> {
  if (requestingCodeNow) {
    return { ok: false, message: 'A kódigénylés már folyamatban van…' };
  }
  const pairing = readPairingState();
  const tv = tvDeviceInfo();
  requestingCodeNow = true;
  pairingUiOverride = {
    state: pairing.deviceToken ? 'paired' : 'unpaired',
    message: 'Új párosítási kód igénylése folyamatban…',
  };
  notifyTvDoctorListeners();

  try {
    if (typeof fetch !== 'function') {
      const msg = 'Hálózati kapcsolat nem érhető el ezen az eszközön.';
      pairingUiOverride = { state: 'error', message: msg };
      return { ok: false, message: msg };
    }
    const response = await fetch(getApiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: API_KEY,
        Authorization: `Bearer ${API_KEY}`,
        'x-tv-device-id': pairing.deviceId,
      },
      body: JSON.stringify({
        action: 'pair_request',
        deviceId: pairing.deviceId,
        tvModel: safeCleanText(tv?.model || 'LG webOS TV', 64),
        webosVersion: safeCleanText(tv?.webOsVersion || tv?.sdkVersion || '', 32),
        appVersion: WEB_VERSION,
      }),
    });

    const text = await response.text().catch(() => '');
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

    if (!response.ok || !parsed || parsed.ok !== true) {
      const errMsg = (typeof parsed?.message === 'string' && parsed.message)
        || (response.status === 429
          ? 'Túl sok kódigénylés rövid időn belül. Várj néhány percet.'
          : 'Nem sikerült új párosítási kódot igényelni. Ellenőrizd az internetkapcsolatot.');
      pairingUiOverride = { state: 'error', message: errMsg };
      return { ok: false, message: errMsg };
    }

    const nowIso = new Date().toISOString();
    const expiresAt = typeof parsed.expiresAt === 'string' ? parsed.expiresAt : undefined;
    savePairingState({
      ...pairing,
      codeRequestedAt: nowIso,
      codeExpiresAt: expiresAt || null,
    });
    const successMsg = 'Új 6 jegyű párosítási kód létrehozva a Supabase-ben (10 percig érvényes). Írd be a kódot!';
    pairingUiOverride = {
      state: pairing.deviceToken ? 'paired' : 'unpaired',
      message: successMsg,
    };
    return {
      ok: true,
      expiresAt,
      expiresInSeconds: typeof parsed.expiresInSeconds === 'number' ? parsed.expiresInSeconds : 600,
      maxAttempts: typeof parsed.maxAttempts === 'number' ? parsed.maxAttempts : 5,
      message: successMsg,
    };
  } catch {
    const msg = 'Nem sikerült elérni a Supabase szervert a kódigényléshez.';
    pairingUiOverride = { state: 'error', message: msg };
    return { ok: false, message: msg };
  } finally {
    requestingCodeNow = false;
    notifyTvDoctorListeners();
  }
}

/**
 * A beírt 6 jegyű számkód ellenőrzése és a hosszú távú, megújítható eszköztoken mentése.
 */
export async function verifyTvDoctorPairingCode(rawCode: string): Promise<{
  ok: boolean;
  paired: boolean;
  deviceId: string;
  pairedAt?: string;
  remainingAttempts?: number;
  message: string;
}> {
  const pairing = readPairingState();
  const digits = String(rawCode || '').trim();
  if (!/^[0-9]{6}$/.test(digits)) {
    const msg = 'Kérlek pontosan 6 számjegyet adj meg a párosításhoz!';
    pairingUiOverride = { state: 'error', message: msg };
    notifyTvDoctorListeners();
    return { ok: false, paired: Boolean(pairing.deviceToken), deviceId: pairing.deviceId, message: msg };
  }

  if (verifyingCodeNow) {
    return {
      ok: false,
      paired: Boolean(pairing.deviceToken),
      deviceId: pairing.deviceId,
      message: 'Ellenőrzés folyamatban…',
    };
  }

  const tv = tvDeviceInfo();
  verifyingCodeNow = true;
  pairingUiOverride = { state: 'verifying', message: 'Ellenőrzés folyamatban…' };
  notifyTvDoctorListeners();

  try {
    if (typeof fetch !== 'function') {
      const msg = 'Hálózati kapcsolat nem érhető el ezen az eszközön.';
      pairingUiOverride = { state: 'error', message: msg };
      return { ok: false, paired: false, deviceId: pairing.deviceId, message: msg };
    }

    const startedAt = Date.now();
    const response = await fetch(getApiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: API_KEY,
        Authorization: `Bearer ${API_KEY}`,
        'x-tv-device-id': pairing.deviceId,
      },
      body: JSON.stringify({
        action: 'pair_verify',
        deviceId: pairing.deviceId,
        code: digits,
        tvModel: safeCleanText(tv?.model || 'LG webOS TV', 64),
        webosVersion: safeCleanText(tv?.webOsVersion || tv?.sdkVersion || '', 32),
        appVersion: WEB_VERSION,
      }),
    });

    const elapsedMs = Date.now() - startedAt;
    const text = await response.text().catch(() => '');
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

    if (!response.ok || !parsed || parsed.ok !== true || !parsed.deviceToken) {
      const remaining = typeof parsed?.remainingAttempts === 'number' ? parsed.remainingAttempts : undefined;
      const errMsg = (typeof parsed?.message === 'string' && parsed.message)
        || 'Sikertelen párosítás: érvénytelen vagy lejárt kód.';
      pairingUiOverride = { state: 'error', message: errMsg };
      return {
        ok: false,
        paired: Boolean(pairing.deviceToken),
        deviceId: pairing.deviceId,
        remainingAttempts: remaining,
        message: errMsg,
      };
    }

    const validToken = sanitizeDeviceToken(parsed.deviceToken);
    if (!validToken) {
      const msg = 'A szerver érvénytelen formátumú tokent adott vissza.';
      pairingUiOverride = { state: 'error', message: msg };
      return { ok: false, paired: false, deviceId: pairing.deviceId, message: msg };
    }

    const pairedAt = typeof parsed.pairedAt === 'string' ? parsed.pairedAt : new Date().toISOString();
    const tokenExpiresAt = typeof parsed.tokenExpiresAt === 'string' ? parsed.tokenExpiresAt : null;
    const confirmedDeviceId = sanitizeDeviceId(parsed.deviceId) || pairing.deviceId;

    savePairingState({
      deviceId: confirmedDeviceId,
      deviceToken: validToken,
      pairedAt,
      tokenExpiresAt,
      codeRequestedAt: null,
      codeExpiresAt: null,
    });

    const state = readSyncState();
    state.deviceSeed = confirmedDeviceId;
    saveSyncState();

    pairingUiOverride = {
      state: 'paired',
      message: 'Sikeres párosítás! A TV biztonságosan csatlakozott a védett Supabase memóriához.',
    };
    recordCloudSuccess(elapsedMs);

    // Háttérben azonnal letöltjük a védett tudásbázist és felküldjük a várólistát, késleltetés nélkül!
    if (cloudEnabled) {
      void bootstrapTvDoctorFromCloud().then(() => {
        void flushTvDoctorCloudQueue();
      });
    }

    return {
      ok: true,
      paired: true,
      deviceId: confirmedDeviceId,
      pairedAt,
      message: 'Sikeres párosítás!',
    };
  } catch {
    const msg = 'Hálózati hiba történt a párosítás ellenőrzése közben.';
    pairingUiOverride = { state: 'error', message: msg };
    return { ok: false, paired: Boolean(pairing.deviceToken), deviceId: pairing.deviceId, message: msg };
  } finally {
    verifyingCodeNow = false;
    notifyTvDoctorListeners();
  }
}

/**
 * Kifejezett felhasználói kérésre visszavonja a jelenlegi párosítást.
 */
export async function unpairTvDoctorDevice(): Promise<boolean> {
  const pairing = readPairingState();
  if (pairing.deviceToken) {
    try {
      await postTvDoctor({ action: 'pair_unpair' }, STATUS_CHECK_TIMEOUT_MS, true);
    } catch {
      /* helyileg is töröljük */
    }
  }
  savePairingState({
    deviceId: pairing.deviceId,
    deviceToken: null,
    pairedAt: null,
    tokenExpiresAt: null,
    codeRequestedAt: null,
    codeExpiresAt: null,
  });
  runtimeConn.connected = false;
  runtimeConn.connectionState = 'unpaired';
  runtimeConn.lastErrorCode = null;
  runtimeConn.lastErrorLocation = null;
  runtimeConn.lastErrorSummary = null;
  runtimeConn.lastErrorAt = null;
  pairingUiOverride = {
    state: 'unpaired',
    message: 'A párosítás megszüntetve. Új 6 jegyű kóddal bármikor újra párosíthatod a TV-t.',
  };
  notifyTvDoctorListeners();
  return true;
}

/**
 * Élő Supabase kapcsolat- és token-ellenőrzés a menühöz és diagnosztikához.
 */
export async function checkTvDoctorConnection(
  timeoutMs = STATUS_CHECK_TIMEOUT_MS,
  options?: { rotateToken?: boolean },
): Promise<TvDoctorCloudStatus> {
  if (checkingNow) return getTvDoctorCloudStatus();
  if (!isTvDoctorPaired()) {
    runtimeConn.connected = false;
    runtimeConn.connectionState = 'unpaired';
    notifyTvDoctorListeners();
    return getTvDoctorCloudStatus();
  }

  const state = readSyncState();
  checkingNow = true;
  if (runtimeConn.connectionState === 'unchecked' || runtimeConn.connectionState === 'unpaired') {
    runtimeConn.connectionState = 'checking';
  }
  notifyTvDoctorListeners();

  try {
    const res = await postTvDoctor(
      {
        action: 'status',
        ...(options?.rotateToken ? { rotateToken: true } : {}),
      },
      timeoutMs,
      true,
    );
    if (res && res.ok) {
      if (typeof res.profileCount === 'number' && Number.isFinite(res.profileCount)) {
        state.cloudProfileCount = Math.max(0, Math.round(res.profileCount));
      }
      if (typeof res.serverTime === 'string' && !state.lastSyncAt) {
        state.lastSyncAt = res.serverTime;
      }
      saveSyncState();
      if (isVerbosePlaybackLogging() && isTvDoctorDiagLoggingEnabled()) {
        appLog(
          `TV DOKTOR SUPABASE KAPCSOLAT OK: válaszidő=${runtimeConn.latencyMs ?? 0}ms; központi_profilok=${state.cloudProfileCount}`,
        );
      }
      const pendingCount = Object.keys(state.pendingProfiles).length + state.pendingEvents.length;
      if (cloudEnabled && pendingCount > 0 && !syncingNow) {
        void flushTvDoctorCloudQueue();
      }
    }
  } finally {
    checkingNow = false;
    notifyTvDoctorListeners();
  }

  return getTvDoctorCloudStatus();
}

/**
 * Letölti a védett Supabase tudásbázisból a csatornákhoz tartozó bevált profilokat
 * (kizárólag párosított TV esetén; párosítás nélkül 0 ms alatt azonnal visszatér).
 */
export async function bootstrapTvDoctorFromCloud(): Promise<number> {
  if (!cloudEnabled || syncingNow || !isTvDoctorPaired()) return 0;
  const state = readSyncState();
  syncingNow = true;
  notifyTvDoctorListeners();
  try {
    const res = await postTvDoctor({
      action: 'bootstrap',
      since: state.lastSyncAt || undefined,
      limit: 400,
    }, REQUEST_TIMEOUT_MS, true);
    if (!res || !res.ok || !Array.isArray(res.profiles)) return 0;

    const merged = mergeCloudProfilesIntoLocal(res.profiles as CloudChannelProfileInput[]);
    if (typeof res.serverTime === 'string') {
      state.lastSyncAt = res.serverTime;
    } else {
      state.lastSyncAt = new Date().toISOString();
    }
    state.cloudProfileCount = Math.max(state.cloudProfileCount, res.profiles.length);
    saveSyncState();

    if (merged > 0 && isTvDoctorDiagLoggingEnabled()) {
      appLog(`TV DOKTOR FELHŐ: ${merged} csatornaprofil letöltve és összefésülve`);
    }
    return merged;
  } catch {
    return 0;
  } finally {
    syncingNow = false;
    notifyTvDoctorListeners();
  }
}

/**
 * Elküldi a helyileg összegyűjtött méréseket, hibákat és sikeres javításokat a Supabase-nek
 * (kizárólag párosított TV esetén).
 */
export async function flushTvDoctorCloudQueue(): Promise<boolean> {
  cancelTimer(flushTimer);
  flushTimer = null;
  if (!cloudEnabled || syncingNow) return false;
  if (!isTvDoctorPaired()) return false;

  const state = readSyncState();
  const profileKeys = Object.keys(state.pendingProfiles);
  const eventsToSend = state.pendingEvents.slice(0, MAX_PENDING_EVENTS);
  if (profileKeys.length === 0 && eventsToSend.length === 0) return true;

  const profilesToSend = profileKeys.slice(0, MAX_PENDING_PROFILES).map((k) => state.pendingProfiles[k]);
  const tv = tvDeviceInfo();
  const pairing = readPairingState();

  syncingNow = true;
  notifyTvDoctorListeners();
  try {
    const res = await postTvDoctor({
      action: 'sync',
      deviceHash: pairing.deviceId,
      tvModel: safeCleanText(tv?.model || 'LG webOS TV', 64),
      webosVersion: safeCleanText(tv?.webOsVersion || tv?.sdkVersion || '', 32),
      appVersion: WEB_VERSION,
      profiles: profilesToSend,
      events: eventsToSend,
    }, REQUEST_TIMEOUT_MS, true);

    if (!res || !res.ok) {
      return false;
    }

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
    if (isVerbosePlaybackLogging() && isTvDoctorDiagLoggingEnabled()) {
      appLog(
        `TV DOKTOR FELHŐ SZINKRON OK: elküldve profil=${profilesToSend.length}, esemény=${eventsToSend.length}`,
      );
    }
    return true;
  } catch {
    return false;
  } finally {
    syncingNow = false;
    notifyTvDoctorListeners();
  }
}

function scheduleDeferredFlush(): void {
  if (!cloudEnabled || !isTvDoctorPaired() || flushTimer !== null) return;
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
  const rawKeyCheck = String(payload.record?.channelKey || payload.event?.channelKey || '');
  if (rawKeyCheck.startsWith('vod:') || payload.record?.countryCode === 'VOD' || payload.record?.countryCode === 'SER') {
    return;
  }
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
  readPairingState();
  if (!enabled) {
    setTvDoctorCloudHook(null);
    cancelTimer(flushTimer);
    cancelTimer(bootstrapTimer);
    flushTimer = null;
    bootstrapTimer = null;
    notifyTvDoctorListeners();
    return;
  }

  if (runtimeConn.connectionState === 'disabled') {
    runtimeConn.connectionState = isTvDoctorPaired()
      ? (runtimeConn.connected ? 'connected' : 'unchecked')
      : 'unpaired';
  }
  setTvDoctorCloudHook(enqueueFromHook);
  if (bootstrapTimer === null && isTvDoctorPaired()) {
    bootstrapTimer = scheduleTimer(() => {
      bootstrapTimer = null;
      if (!isTvDoctorPaired()) return;
      void bootstrapTvDoctorFromCloud().then(() => {
        const st = readSyncState();
        if (Object.keys(st.pendingProfiles).length > 0 || st.pendingEvents.length > 0) {
          void flushTvDoctorCloudQueue();
        }
      });
    }, BOOTSTRAP_DELAY_MS);
  }
  notifyTvDoctorListeners();
}

export function getTvDoctorCloudStatus(): TvDoctorCloudStatus {
  const pairing = readPairingState();
  const paired = Boolean(pairing.deviceId && pairing.deviceToken);
  const state = readSyncState();
  const pendingCount = Object.keys(state.pendingProfiles).length + state.pendingEvents.length;
  let effectiveState: TvDoctorConnectionState = runtimeConn.connectionState;
  if (!paired) {
    effectiveState = cloudEnabled ? 'unpaired' : 'disabled';
  } else if (checkingNow || syncingNow) {
    effectiveState = 'checking';
  } else if (!cloudEnabled && runtimeConn.connectionState === 'unchecked') {
    effectiveState = 'disabled';
  } else if (paired && effectiveState === 'unpaired') {
    effectiveState = runtimeConn.connected ? 'connected' : 'unchecked';
  }

  return {
    enabled: cloudEnabled,
    paired,
    deviceId: pairing.deviceId,
    connected: paired && runtimeConn.connected,
    connectionState: effectiveState,
    lastSyncAt: state.lastSyncAt,
    lastCheckedAt: runtimeConn.lastCheckedAt,
    latencyMs: runtimeConn.latencyMs,
    pendingCount,
    cloudProfileCount: state.cloudProfileCount,
    syncing: syncingNow,
    checking: checkingNow,
    lastErrorCode: runtimeConn.lastErrorCode,
    lastErrorLocation: runtimeConn.lastErrorLocation,
    lastErrorSummary: runtimeConn.lastErrorSummary,
    lastErrorAt: runtimeConn.lastErrorAt,
  };
}

export function clearTvDoctorCloudQueue(): void {
  cachedState = null;
  cancelTimer(flushTimer);
  cancelTimer(bootstrapTimer);
  flushTimer = null;
  bootstrapTimer = null;
  runtimeConn.lastErrorCode = null;
  runtimeConn.lastErrorLocation = null;
  runtimeConn.lastErrorSummary = null;
  runtimeConn.lastErrorAt = null;
  if (!runtimeConn.connected) {
    runtimeConn.connectionState = !cloudEnabled
      ? 'disabled'
      : isTvDoctorPaired()
        ? 'unchecked'
        : 'unpaired';
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(SYNC_STATE_KEY);
    }
  } catch {
    /* ignore */
  }
  notifyTvDoctorListeners();
}

/**
 * Kézi „Memória: 0” visszaállítás:
 * Törli a TV Doktor helyi csatorna-memóriáját, naplóit és a felhő-várólistát is 0 állapotra,
 * miközben a csatornalistához, kedvencekhez, beállításokhoz ÉS a Supabase-párosításhoz SOHA nem nyúl!
 */
export function resetTvDoctorAllToZero(storage?: Storage | null): void {
  clearTvDoctorMemory(storage);
  clearTvDoctorCloudQueue();
  if (cloudEnabled) {
    setTvDoctorCloudHook(enqueueFromHook);
  }
  if (isTvDoctorDiagLoggingEnabled()) {
    appLog('TV DOKTOR NULLÁZÁS: a tanuló memória és a szinkron-várólista kézzel 0 állapotra lett állítva.');
  }
  notifyTvDoctorListeners();
}

/**
 * Csatlakoztatja a TV Doktor működés- és elakadás-naplózását a meglévő Kézi hibakeresési naplóhoz
 * (SÁRGA gombos ablak).
 */
export function attachTvDoctorDiagnostics(): void {
  if (diagnosticsAttached) return;
  diagnosticsAttached = true;

  registerLoggingLifecycleHooks({
    onStart: () => {
      if (!isTvDoctorDiagLoggingEnabled()) {
        appLog('TV DOKTOR NAPLÓ: a TV Doktor részletes naplózása jelenleg ki van kapcsolva a kézi napló ablakban.');
        return;
      }

      const summary = getTvDoctorSummary();
      const mem = getTvDoctorMemoryStats();
      const op = getTvDoctorOperationHealth();
      const cloud = getTvDoctorCloudStatus();

      appLog(
        `=== TV DOKTOR ÁLLAPOTKÉP: motor=${cloud.enabled ? 'AKTÍV' : 'KIKAPCSOLVA'}; párosítva=${cloud.paired ? 'IGEN' : 'NEM'}; tanult_csatornák=${mem.learnedChannelCount}/${mem.maxLearnedChannels}; lekapcsolt_epg=${mem.disabledEpgChannelCount}; igazolt_javítások=${summary.totalVerifiedRepairs}; kategóriák=(tanulás=${summary.categoryStats.learning.count}, segítség=${summary.categoryStats.assistance.count}, aktiválódás=${summary.categoryStats.activation.count}, csatornahiba=${summary.categoryStats.channel_error.count}) ===`,
      );
      appLog(
        `TV DOKTOR MEMÓRIA: doktor=${formatDoctorBytes(mem.doctorTotalBytes)}/${formatDoctorBytes(mem.maxSafeDoctorBytes)} (${mem.doctorBudgetPercent}%); tv_tárhely=${formatDoctorBytes(mem.tvStorageUsedBytes)}/~5.0 MB (${mem.tvStoragePercent}%)${mem.jsHeapUsedMB !== null ? `; js_ram=${mem.jsHeapUsedMB} MB` : ''}; állapot=${mem.memoryHealthLabel}`,
      );
      appLog(
        `TV DOKTOR SUPABASE: párosítva=${cloud.paired ? 'IGEN' : 'NEM'}; kapcsolat=${cloud.connected ? 'LÉTREJÖTT' : 'NINCS'}; állapot=${cloud.connectionState}; válaszidő=${cloud.latencyMs !== null ? `${cloud.latencyMs}ms` : 'nincs mérve'}; központi_profilok=${cloud.cloudProfileCount}; várólista=${cloud.pendingCount}; utolsó_szinkron=${cloud.lastSyncAt || 'még nem volt'}`,
      );
      if (cloud.lastErrorSummary) {
        appLog(
          `TV DOKTOR SUPABASE HIBA RÉSZLETEK: hol=${cloud.lastErrorLocation || 'ismeretlen'}; kód=${cloud.lastErrorCode || '-'}; hiba=${cloud.lastErrorSummary}`,
        );
      }
      if (mem.lastStorageError) {
        appLog(
          `TV DOKTOR TÁRHELY HIBA RÉSZLETEK: hol=${mem.lastStorageError.location}; hiba=${mem.lastStorageError.message}`,
        );
      }
      if (op.lastSlowOp) {
        appLog(
          `TV DOKTOR KORÁBBI LASSULÁS: művelet=${op.lastSlowOp.op}; idő=${op.lastSlowOp.elapsedMs}ms${op.lastSlowOp.channelName ? `; csatorna=${op.lastSlowOp.channelName}` : ''}`,
        );
      }
      const tailLogs = summary.recentLogs.slice(-5);
      for (let i = 0; i < tailLogs.length; i += 1) {
        const entry = tailLogs[i];
        appLog(`TV DOKTOR ELŐZMÉNY [${entry.channelName}] (${entry.level}): ${entry.message}`);
      }
      resetTvDoctorOperationCounters();
    },
    onStop: () => {
      if (!isTvDoctorDiagLoggingEnabled()) return;
      const mem = getTvDoctorMemoryStats();
      const op = getTvDoctorOperationHealth();
      const cloud = getTvDoctorCloudStatus();
      appLog(
        `=== TV DOKTOR NAPLÓ ÖSSZESÍTÉS: döntések=${op.decisionsCount}; max_döntési_idő=${op.maxDecisionMs}ms; elakadások_lassulások=${op.slowOpsCount}; fagyásvizsgálatok=${op.freezeChecksCount} (igazolt_fagyás=${op.confirmedFreezesCount}); javítási_lépések=${op.repairsAttemptedCount} (igazolt=${op.repairsVerifiedCount}); leállított_halott_csatorna=${op.deadChannelsHaltedCount}; epg_segítés=${op.epgAssistsCount}; epg_lekapcsolva=${op.epgDisabledCount}; memória=${formatDoctorBytes(mem.doctorTotalBytes)}/${formatDoctorBytes(mem.maxSafeDoctorBytes)}; supabase=${cloud.connected ? 'OK' : cloud.connectionState}${cloud.lastErrorSummary ? ` [${cloud.lastErrorLocation}: ${cloud.lastErrorSummary}]` : ''} ===`,
      );
    },
  });
}
