import { WEB_VERSION } from '../appVersion';
import { appLog, isVerbosePlaybackLogging, registerLoggingLifecycleHooks, tvDoctorLog } from './appLog';
import { tvDeviceInfo } from './tvDevice';
import { fetchSnapshotFromCloud } from './channelLayoutBackup';
import {
  ChannelDoctorRecord,
  CloudChannelProfileInput,
  clearTvDoctorMemory,
  formatDoctorBytes,
  getTvDoctorMemoryStats,
  getTvDoctorOperationHealth,
  getTvDoctorSummary,
  isTvDoctorDiagLoggingEnabled,
  collectDoctorRoutePayload,
  compactDoctorRoutes,
  isPersistableDoctorRecord,
  mergeCloudProfilesIntoLocal,
  mergeCloudRoutesIntoLocal,
  notifyTvDoctorListeners,
  resetTvDoctorOperationCounters,
  setTvDoctorCloudHook,
  setTvDoctorCloudLogHook,
  mergeCloudDoctorLogs,
  DoctorLogEntry,
  DoctorRoute,
  DoctorBaselineProfile,
  getAllDoctorBaselines,
  restoreDoctorBaselinesFromCloud,
  setTvDoctorBaselineCloudHook,
  normalizeChannelDoctorKey,
  normalizeDoctorRoutesForDisplay,
  setTvDoctorHungarianChannelScope,
  restoreTvDoctorCentralProfiles,
  getTvDoctorCentralProfileState,
  normalizeSavedLayoutChannelKey,
  SavedLayoutChannel,
  TV_DOCTOR_SYNC_STORAGE_KEY,
  getTvDoctorActivePlaybackSnapshot,
  getTvDoctorChannelSnapshot,
  MAX_CHANNEL_ROUTES,
  startTvDoctorPlaybackTelemetry,
  stopTvDoctorPlaybackTelemetry,
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
const BOOTSTRAP_DELAY_MS = 1_200;
/*
 * 2.5.278 (#19-es napló): a #19-es naplóban 15-60 másodpercenként ment ki
 * „FELHŐ SZINKRON OK” sor 5,4 mp-es Supabase-válaszidővel – a gyakori kis
 * csomagok felesleges hálózati forgalmat és várakozást okoztak nézés közben.
 * Most ritkábban, nagyobb kötegekben szinkronizálunk: 60 mp debouncing + legalább
 * 3 perc két küldés között.
 */
const FLUSH_DEBOUNCE_MS = 60_000;
const MIN_FLUSH_GAP_MS = 3 * 60 * 1000;
/** Mikor fejeződött be az utolsó tényleges küldés. */
let lastFlushDoneAt = 0;
const MAX_PENDING_PROFILES = 100;

/*
 * 2.5.394 – KOMPATIBILITÁS A JELENLEG DEPLOYÁLT v18 EDGE FUNCTIONNEL.
 * A futó `tv-doctor` v18 még a mentett, elavult csatorna-ID-kre szűr, a TV
 * viszont új `live-qr_<timestamp>` ID-ket kap. A bootstrapből (v19) vagy a
 * `tv-channel-layout` mentett pillanatképéből (v18) ezért megjegyezzük,
 * melyik STABIL névkulcshoz melyik MENTETT ID tartozik, és a feltöltésnél
 * ezt az ID-t küldjük `channelIdHint`-ként. Így a TV már a régi szerverrel
 * is képes a teljes tv -> Supabase -> tv körre, új prefix esetén is.
 */
const SAVED_SCOPE_IDS_KEY = 'iptv_rt_tv_doctor_saved_scope_ids_v1';
let savedChannelIdByKey = new Map<string, string>();
try {
  const stored = JSON.parse(localStorage.getItem(SAVED_SCOPE_IDS_KEY) || '[]');
  if (Array.isArray(stored)) {
    for (const row of stored) {
      if (row && typeof row[0] === 'string' && typeof row[1] === 'string') savedChannelIdByKey.set(row[0], row[1]);
    }
  }
} catch { /* sérült gyorsítótár: a bootstrap újra feltölti */ }

function rememberSavedChannelIds(channels: SavedLayoutChannel[]): void {
  let changed = false;
  for (const channel of channels) {
    const key = String(channel.channelKey || '').toLowerCase();
    const id = typeof channel.id === 'string' ? channel.id : '';
    if (key && id && savedChannelIdByKey.get(key) !== id) { savedChannelIdByKey.set(key, id); changed = true; }
  }
  if (!changed) return;
  try { localStorage.setItem(SAVED_SCOPE_IDS_KEY, JSON.stringify([...savedChannelIdByKey].slice(-200))); } catch {}
}

/** A `tv-channel-layout` mentett pillanatképéből sorrendi, stabil kulcsú lista. */
function layoutChannelsFromSavedSnapshot(snapshot: unknown): SavedLayoutChannel[] {
  const snap = snapshot as {
    hungarianChannelIds?: unknown;
    fingerprintOrder?: Array<{ id?: unknown; nameKey?: unknown; countryCode?: unknown; categoryName?: unknown }>;
  } | null;
  if (!snap || !Array.isArray(snap.fingerprintOrder)) return [];
  const huIds = new Set(Array.isArray(snap.hungarianChannelIds)
    ? snap.hungarianChannelIds.filter((v): v is string => typeof v === 'string') : []);
  const out: SavedLayoutChannel[] = [];
  for (const item of snap.fingerprintOrder) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    const rawName = String(item.nameKey || '').split('|')[0].trim();
    const isHu = huIds.size
      ? huIds.has(id)
      : (String(item.countryCode || '').toUpperCase() === 'HU' || /^\s*\[hu\]\s*/i.test(rawName));
    if (!id || !isHu) continue;
    const channelKey = normalizeSavedLayoutChannelKey(String(item.nameKey || ''));
    if (!channelKey) continue;
    const name = rawName.replace(/^\s*\[[a-z]{2,4}\]\s*/i, '').trim() || channelKey;
    out.push({ id, nameKey: String(item.nameKey || ''), channelKey, name: `[HU] ${name.toUpperCase()}`, position: out.length + 1 });
  }
  return out;
}

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
  /**
   * 2.5.294: a csatorna legfeljebb 8 legjobb tanult útvonala (formátum + puffer).
   * Csak magyar csatornáról, csak a legszükségesebb mezőkkel kerül a felhőbe.
   */
  routes?: Array<{
    format: string;
    bufferProfile: string;
    ok: number;
    fail: number;
    stalls: number;
    avgStartupMs: number | null;
    bestStartupMs: number | null;
    lastOkAt: number | null;
    lastFailAt: number | null;
  }>;
  lastErrorCode?: string;
  lastErrorReason?: string;
}

export interface PendingDoctorEvent {
  eventUid: string;
  eventType: string;
  category: 'learning' | 'assistance' | 'activation' | 'channel_error';
  level: 'info' | 'warn' | 'repair' | 'verified' | 'error';
  message: string;
  at: number;
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
  pendingCloudReset: boolean;
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
let connectivityListenersAttached = false;
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
      void restoreTvDoctorCloudState();
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
        const cleanPendingEvents: PendingDoctorEvent[] = Array.isArray(parsed.pendingEvents)
          ? parsed.pendingEvents.filter((event: any) => event && typeof event.eventUid === 'string'
            && ['learning', 'assistance', 'activation', 'channel_error'].includes(event.category)
            && typeof event.message === 'string' && Number.isFinite(Number(event.at))).slice(-32)
          : [];
        cachedState = {
          deviceSeed: pairing.deviceId,
          lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
          cloudProfileCount: Math.max(0, Number(parsed.cloudProfileCount) || 0),
          pendingProfiles: cleanPendingProfiles,
          pendingEvents: cleanPendingEvents,
          pendingCloudReset: parsed.pendingCloudReset === true,
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
    pendingCloudReset: false,
  };
  return cachedState;
}

function saveSyncState(): void {
  if (!cachedState) return;
  const pendingCount = Object.keys(cachedState.pendingProfiles).length + cachedState.pendingEvents.length;
  if (!cachedState.lastSyncAt && cachedState.cloudProfileCount === 0 && pendingCount === 0 && !cachedState.pendingCloudReset) {
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

/**
 * 2.5.294: A TANULT ÚTVONALAK felhő-memóriája.
 *
 * A csatornánkénti legjobb 8 útvonalat (formátum + pufferprofil) a Supabase
 * token-ellenőrzött RPC-függvényein keresztül mentjük és olvassuk vissza:
 *   • public.tv_doctor_routes_upsert – csak a párosított eszköz tokenjével,
 *   • public.tv_doctor_routes_fetch  – ugyanazzal a tokennel.
 * Így a tanulás nem vész el újratelepítéskor vagy TV-csere esetén, és a
 * szerver oldalon is csak magyar csatornák, csatornánként max. 8 útvonal marad.
 */
function restBaseUrl(): string {
  const api = getApiUrl();
  const match = api.match(/^(https?:\/\/[^/]+)/);
  return match ? `${match[1]}/rest/v1` : '';
}

async function postTvDoctorRpc(
  fn: 'tv_doctor_routes_upsert' | 'tv_doctor_routes_fetch' | 'tv_doctor_baselines_upsert' | 'tv_doctor_baselines_fetch',
  params: Record<string, unknown>,
  timeoutMs = STATUS_CHECK_TIMEOUT_MS,
): Promise<any | null> {
  const base = restBaseUrl();
  if (!base || typeof fetch !== 'function') return null;
  const pairing = readPairingState();
  if (!pairing.deviceId || !pairing.deviceToken) return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;

  const AbortCtor = typeof AbortController !== 'undefined' ? AbortController : null;
  const controller = AbortCtor ? new AbortCtor() : null;
  const timeout = controller
    ? scheduleTimer(() => {
        try { controller.abort(); } catch { /* ignore */ }
      }, timeoutMs)
    : null;
  try {
    const response = await fetch(`${base}/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: API_KEY,
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
      signal: controller ? controller.signal : undefined,
    });
    if (!response.ok) {
      if (isVerbosePlaybackLogging() && isTvDoctorDiagLoggingEnabled()) {
        appLog(`TV DOKTOR FELHŐ ÚTVONAL: ${fn} HTTP ${response.status} – a helyi tanulás változatlanul működik tovább.`);
      }
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    if (timeout !== null) cancelTimer(timeout);
  }
}

/** A Supabase-ben tárolt tanult útvonalak közvetlen lekérése az aktuális csatornához. */
export async function fetchTvDoctorRoutesForChannelFromCloud(
  channel: { id?: string; name: string; countryCode?: string } | null | undefined,
  knownChannelKey?: string | null,
): Promise<DoctorRoute[]> {
  if (!cloudEnabled || !channel || !isTvDoctorPaired()) return [];
  const pairing = readPairingState();
  const rows = await postTvDoctorRpc('tv_doctor_routes_fetch', {
    p_device_id: pairing.deviceId,
    p_device_token: pairing.deviceToken,
    p_limit: 400,
  });
  if (!Array.isArray(rows)) return [];
  const baseKey = normalizeChannelDoctorKey({ ...channel, countryCode: '' });
  const keys = new Set([
    normalizeChannelDoctorKey({ ...channel, countryCode: 'HU' }),
    normalizeChannelDoctorKey(channel),
    baseKey,
    `hu:${baseKey}`,
    ...(knownChannelKey ? [knownChannelKey] : []),
  ]);
  const match = rows.find((row: any) => row && typeof row.channel_key === 'string' && keys.has(row.channel_key));
  if (!match) return [];
  /* 2.5.397: a TELJES RPC-sort adjuk át, nem csak a beágyazott `routes`
     tömböt. Ha egy régi sorból hiányzik a `format` / `bufferProfile`, a
     normalizáló a profil `best_format` / `best_buffer_profile` /
     `*_success_count` mezőiből visszaállítja a VALÓDI tanult útvonalat –
     így a 0-ablak nem mutathat többé NINCS ADAT helyőrzőt. */
  return normalizeDoctorRoutesForDisplay(match).filter((route) => route.ok > 0);
}

/** A készüléken tanult útvonalak feltöltése a Supabase memóriába (csak magyar csatornák). */
export async function pushTvDoctorRoutesToCloud(): Promise<number> {
  if (!cloudEnabled || !isTvDoctorPaired()) return 0;
  /*
   * A csomag a HELYI tanult memóriából épül (nem a küldésre váró sorból):
   * a szinkron után a várakozó profilok törlődnek, a tanult útvonalak viszont
   * megmaradnak – így a feltöltés mindig a teljes, friss tudást küldi.
   */
  const payload = collectDoctorRoutePayload();
  if (payload.length === 0) return 0;

  const pairing = readPairingState();
  // A Supabase RPC jelenlegi biztonságos szerveroldali korlátja 30 csatorna/kérés.
  // A teljes helyi lista ezért egymás után, 30-as kötegekben megy fel; egyetlen
  // nagy kérésnél a szerver csendben csak az első 30 rekordot dolgozná fel.
  let count = 0;
  for (let offset = 0; offset < payload.length; offset += 30) {
    const batch = payload.slice(offset, offset + 30);
    const result = await postTvDoctorRpc('tv_doctor_routes_upsert', {
      p_device_id: pairing.deviceId,
      p_device_token: pairing.deviceToken,
      p_payload: batch,
    });
    if (typeof result === 'number') count += result;
    else break;
  }
  if (count > 0 && isTvDoctorDiagLoggingEnabled()) {
    const msg = `TV DOKTOR FELHŐ ÚTVONAL: ${count} csatorna tanult útvonala mentve a Supabase memóriába.`;
    appLog(msg);
    tvDoctorLog(msg);
    // részletes lista a TV DR naplóba (csatornakulcsok)
    try {
      const keys = payload.slice(0, 8).map((p) => p.channelKey).join(', ');
      tvDoctorLog(`TV DR FELHŐ MENTÉS RÉSZLET: ${keys}${payload.length > 8 ? ` +${payload.length - 8} további` : ''}`);
    } catch { /* ignore */ }
  } else if (isTvDoctorDiagLoggingEnabled() && payload.length > 0) {
    const msg = `TV DOKTOR FELHŐ ÚTVONAL: 0 csatorna mentve (payload=${payload.length}) – a Supabase RPC nem erősítette meg, de a helyi tanulás megmaradt.`;
    appLog(msg);
    tvDoctorLog(msg);
  }
  return count;
}

/** A felhőben tárolt tanult útvonalak letöltése és összefésülése a helyi memóriával. */
export async function fetchTvDoctorRoutesFromCloud(): Promise<number> {
  if (!cloudEnabled || !isTvDoctorPaired()) return 0;
  const pairing = readPairingState();
  const rows = await postTvDoctorRpc('tv_doctor_routes_fetch', {
    p_device_id: pairing.deviceId,
    p_device_token: pairing.deviceToken,
    p_limit: 400,
  });
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const merged = mergeCloudRoutesIntoLocal(rows as Array<{ channel_key?: string; country_code?: string; routes?: unknown }>);
  if (merged > 0 && isTvDoctorDiagLoggingEnabled()) {
    const msg = `TV DOKTOR FELHŐ ÚTVONAL: ${merged} csatorna tanult útvonala letöltve a Supabase memóriából.`;
    appLog(msg);
    tvDoctorLog(msg);
    try {
      const keys = (rows as any[]).slice(0, 8).map((r) => (r as any).channel_key).join(', ');
      tvDoctorLog(`TV DR FELHŐ VISSZATÖLTÉS RÉSZLET: ${keys}${(rows as any[]).length > 8 ? ` +${(rows as any[]).length - 8} további` : ''}`);
      // azonnali ellenőrzés: a legjobb útvonal már a következő indításkor él
      tvDoctorLog(`TV DR FELHŐ VISSZATÖLTÉS ELLENŐRZÉS: ${merged} csatorna útvonala beépült a helyi memóriába — a következő csatornaváltás a tárolt adatokból dolgozik (nem minta).`);
    } catch { /* ignore */ }
  } else if (isTvDoctorDiagLoggingEnabled()) {
    const msg = `TV DOKTOR FELHŐ VISSZATÖLTÉS: 0 csatorna érkezett (válasz=${Array.isArray(rows) ? rows.length : 'null'}) — a helyi memória változatlan.`;
    appLog(msg);
    tvDoctorLog(msg);
  }
  return merged;
}


/**
 * Az 1-es, kézzel rögzített alapbeállítások külön felhőmentése.
 * Feltöltéskor a szerver csak INSERT-et enged (ON CONFLICT DO NOTHING),
 * ezért a később tanult 2-es útvonal soha nem írhatja felül az 1-est.
 */
async function syncTvDoctorBaselinesWithCloud(): Promise<void> {
  if (!cloudEnabled || !isTvDoctorPaired()) return;
  const pairing = readPairingState();
  const local = getAllDoctorBaselines();
  for (let offset = 0; offset < local.length; offset += 100) {
    const payload = local.slice(offset, offset + 100).map((baseline: DoctorBaselineProfile) => ({
      channelKey: baseline.channelKey,
      channelId: baseline.channelId,
      channelName: baseline.channelName,
      baseline,
    }));
    if (payload.length) {
      await postTvDoctorRpc('tv_doctor_baselines_upsert', {
        p_device_id: pairing.deviceId,
        p_device_token: pairing.deviceToken,
        p_payload: payload,
      });
    }
  }
  const rows = await postTvDoctorRpc('tv_doctor_baselines_fetch', {
    p_device_id: pairing.deviceId,
    p_device_token: pairing.deviceToken,
  });
  if (Array.isArray(rows)) {
    const restored = restoreDoctorBaselinesFromCloud(
      rows.map((row: any) => ({ channelKey: String(row.channel_key || ''), baseline: row.baseline })),
    );
    if (isTvDoctorDiagLoggingEnabled()) {
      tvDoctorLog(`TV DOKTOR 1-ES ALAP SZINKRON: helyi=${local.length}; felhő=${rows.length}; hiányzó helyi alap visszaállítva=${restored}; az 1-es alap zárolt, a tanult útvonal csak a 2-es helyre kerül.`);
    }
  }
}

/** A tanult útvonalak teljes visszatöltése akkor is, ha a profil-szinkron csak az újabb módosításokat kéri. */
async function restoreTvDoctorCloudState(): Promise<void> {
  if (!cloudEnabled || !isTvDoctorPaired()) return;
  // Előbb a profilok csatornaazonosítóit és neveit állítjuk helyre.
  await bootstrapTvDoctorFromCloud();
  // Ezután a külön RPC a teljes útvonal-memóriát kéri le; a bootstrap since
  // szűrése önmagában kihagyhatja a korábban mentett, változatlan csatornákat.
  await fetchTvDoctorRoutesFromCloud();
  await syncTvDoctorBaselinesWithCloud();
  const state = readSyncState();
  if (Object.keys(state.pendingProfiles).length > 0 || state.pendingEvents.length > 0) {
    await flushTvDoctorCloudQueue();
  }
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
      const pendingCount = Object.keys(state.pendingProfiles).length + state.pendingEvents.length + (state.pendingCloudReset ? 1 : 0);
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
  if (state.pendingCloudReset) {
    const resetSynced = await flushTvDoctorCloudQueue();
    if (!resetSynced) return 0;
  }
  if (syncingNow) return 0;
  syncingNow = true;
  notifyTvDoctorListeners();
  try {
    const res = await postTvDoctor({
      action: 'bootstrap',
      since: state.lastSyncAt || undefined,
      limit: 400,
    }, REQUEST_TIMEOUT_MS, true);
    if (!res || !res.ok || !Array.isArray(res.profiles)) return 0;

    /*
     * 2.5.394 – A TELJES KÖR: a hatókör NEM csak az elavult ID-listából,
     * hanem a Supabase-ben ELMENTETT, SORRENDI csatornák stabil névkulcsaiból
     * áll. Ezeket a bootstrap most vissza is adja (`layoutChannels`), a TV
     * pedig pontosan ugyanazt jeleníti meg, ami fent van.
     */
    let cloudLayout = Array.isArray(res.layoutChannels) ? res.layoutChannels as SavedLayoutChannel[] : [];
    let channelIds = Array.isArray(res.channelIds)
      ? res.channelIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    let scopeTimestamp = typeof res.layoutUpdatedAt === 'string'
      ? res.layoutUpdatedAt
      : (typeof res.serverTime === 'string' ? res.serverTime : new Date().toISOString());
    /* v18 nem adja vissza a mentett, sorrendi listát: ilyenkor a TV ugyanazt
       a `tv-channel-layout` pillanatképet olvassa, amit a Supabase tárol. */
    if (!cloudLayout.length) {
      try {
        const saved = await fetchSnapshotFromCloud('__HU_LAYOUT_GLOBAL__');
        if (saved) {
          cloudLayout = layoutChannelsFromSavedSnapshot(saved);
          if (!channelIds.length) channelIds = cloudLayout.map((c) => c.id || '').filter(Boolean);
          if (typeof (saved as { createdAt?: unknown }).createdAt === 'string') {
            scopeTimestamp = (saved as { createdAt: string }).createdAt;
          }
        }
      } catch { /* a layout-funkció kimaradása nem akadályozza a bootstrapt */ }
    }
    const layoutChannels = cloudLayout.length ? cloudLayout : getTvDoctorCentralProfileState().channels;
    if (layoutChannels.length) rememberSavedChannelIds(layoutChannels);
    if (channelIds.length || layoutChannels.length) {
      setTvDoctorHungarianChannelScope(channelIds, scopeTimestamp, layoutChannels);
      const allowed = new Set(channelIds);
      const allowedKeys = new Set((Array.isArray(res.channelKeys) ? res.channelKeys : layoutChannels.map((c) => c.channelKey))
        .filter((k: unknown): k is string => typeof k === 'string' && k.length > 0)
        .map((k: string) => k.toLowerCase()));
      for (const [key, pending] of Object.entries(state.pendingProfiles)) {
        const pendingKey = String(key || (pending as any)?.channelKey || '').toLowerCase();
        const hint = String((pending as any)?.channelIdHint || '');
        // A friss (még el nem küldött) tanulást az elavult ID miatt NEM dobjuk el.
        if (!((hint && allowed.has(hint)) || allowedKeys.has(pendingKey))) delete state.pendingProfiles[key];
      }
      state.pendingEvents = state.pendingEvents.filter((event) => {
        const id = String(event.channelId || '');
        const key = String(event.channelKey || '').toLowerCase();
        return (id && allowed.has(id)) || allowedKeys.has(key);
      });
    }

    /* A mentett központi profilok, a zárolt 1-es alap és a felhőben tanult
       2-es+ útvonalak MIND visszakerülnek a TV helyi memóriájába. */
    const roundTrip = restoreTvDoctorCentralProfiles({
      layoutChannels,
      baselines: Array.isArray(res.baselines) ? res.baselines : [],
      profiles: res.profiles as Array<Record<string, unknown>>,
    });
    if (isTvDoctorDiagLoggingEnabled()) {
      tvDoctorLog(
        `TV DOKTOR SUPABASE KÖR: tv -> Supabase -> tv; mentett_központi_profilok=${layoutChannels.length}; `
        + `visszaállítva=${roundTrip.restored}; 1-es_alap=${roundTrip.baselineCount}; `
        + `felhő_profilok=${res.profiles.length}; tanult_útvonalak=${roundTrip.routeCount}; `
        + `a TV ugyanazt mutatja, mint a Supabase.`,
      );
    }

    if (Array.isArray(res.events)) mergeCloudDoctorLogs(res.events);
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
  if (state.pendingCloudReset) {
    syncingNow = true;
    notifyTvDoctorListeners();
    try {
      const resetResponse = await postTvDoctor({ action: 'reset_memory' }, REQUEST_TIMEOUT_MS, true);
      if (!resetResponse || !resetResponse.ok || resetResponse.reset !== true) return false;
      /*
       * 2.5.394: az 1-es, megváltoztathatatlan alapbeállításokat NEM töröljük.
       * A korábbi `tv_doctor_baselines_clear` hívás tette tönkre a teljes
       * tv -> Supabase -> tv kört: nullázáskor a TV ÉS a Supabase is elvesztette
       * az alapot, ezért utána semmi nem tudott visszatölteni (0/80).
       */
      state.pendingCloudReset = false;
      state.pendingProfiles = {};
      state.pendingEvents = [];
      state.cloudProfileCount = 0;
      state.lastSyncAt = null;
      saveSyncState();
      if (isTvDoctorDiagLoggingEnabled()) {
        tvDoctorLog('TV DOKTOR NULLÁZÁS: a Supabase 1-es alapjai és a mentett csatornaelrendezés MEGMARADTAK; a visszatöltés azonnal indul.');
      }
      return true;
    } finally {
      syncingNow = false;
      notifyTvDoctorListeners();
    }
  }

  const profileKeys = Object.keys(state.pendingProfiles);
  if (profileKeys.length === 0 && state.pendingEvents.length === 0) return true;

  const profilesToSend = profileKeys.slice(0, MAX_PENDING_PROFILES).map((k) => state.pendingProfiles[k]);
  const eventsToSend = state.pendingEvents.slice(0, 32);
  const tv = tvDeviceInfo();
  const pairing = readPairingState();

  syncingNow = true;
  notifyTvDoctorListeners();
  try {
    const syncProfiles = profilesToSend.map((profile) => {
      const savedId = savedChannelIdByKey.get(String(profile.channelKey || '').toLowerCase());
      return savedId ? { ...profile, channelIdHint: savedId } : profile;
    });
    const syncEvents = eventsToSend.map((event) => {
      const savedId = savedChannelIdByKey.get(String(event.channelKey || '').toLowerCase());
      return savedId ? { ...event, channelId: savedId } : event;
    });
    const res = await postTvDoctor({
      action: 'sync',
      deviceHash: pairing.deviceId,
      tvModel: safeCleanText(tv?.model || 'LG webOS TV', 64),
      webosVersion: safeCleanText(tv?.webOsVersion || tv?.sdkVersion || '', 32),
      appVersion: WEB_VERSION,
      doctorSchemaVersion: 2,
      profiles: syncProfiles,
      events: syncEvents,
    }, REQUEST_TIMEOUT_MS, true);

    if (!res || !res.ok) {
      return false;
    }

    for (const sent of profilesToSend) {
      delete state.pendingProfiles[sent.channelKey];
    }
    const sentEventIds = new Set(eventsToSend.map((event) => event.eventUid));
    state.pendingEvents = state.pendingEvents.filter((event) => !sentEventIds.has(event.eventUid));

    if (Array.isArray(res.events)) mergeCloudDoctorLogs(res.events);
    if (Array.isArray(res.mergedProfiles) && res.mergedProfiles.length > 0) {
      mergeCloudProfilesIntoLocal(res.mergedProfiles as CloudChannelProfileInput[]);
      state.cloudProfileCount = Math.max(state.cloudProfileCount, res.mergedProfiles.length);
    }
    state.lastSyncAt = typeof res.serverTime === 'string' ? res.serverTime : new Date().toISOString();
    saveSyncState();
    /*
     * A tanult útvonalak külön RPC-n is felkerülnek a Supabase memóriájába.
     * A profil-/naplószinkron önmagában nem hívja meg a tv_doctor_routes_upsert
     * végpontot, ezért minden sikeres normál szinkron után elküldjük a teljes,
     * magyar csatornákra szűrt, csatornánként legfeljebb 8 útvonalas listát.
     * A feltöltés saját hibakezelésű; nem akadályozhatja a lejátszást vagy a
     * már sikeres profil-/naplószinkront.
     */
    await pushTvDoctorRoutesToCloud();
    if (isVerbosePlaybackLogging() && isTvDoctorDiagLoggingEnabled()) {
      appLog(
        `TV DOKTOR FELHŐ SZINKRON OK: csatornaprofil=${profilesToSend.length}; naplóbejegyzés=${eventsToSend.length}`,
      );
    }
    return true;
  } catch {
    return false;
  } finally {
    syncingNow = false;
    lastFlushDoneAt = Date.now(); // 2.5.278: minimum időköz két küldés között
    notifyTvDoctorListeners();
  }
}

function scheduleDeferredFlush(): void {
  if (!cloudEnabled || !isTvDoctorPaired() || flushTimer !== null) return;
  // 2.5.278: két küldés között minimum MIN_FLUSH_GAP_MS telik el (ha már volt küldés).
  const sinceLast = Date.now() - lastFlushDoneAt;
  const delay = lastFlushDoneAt > 0 && sinceLast < MIN_FLUSH_GAP_MS
    ? MIN_FLUSH_GAP_MS - sinceLast + 5_000
    : FLUSH_DEBOUNCE_MS;
  flushTimer = scheduleTimer(() => {
    flushTimer = null;
    void flushTvDoctorCloudQueue();
  }, delay);
}

function enqueueDoctorLog(entry: DoctorLogEntry): void {
  if (!cloudEnabled || !entry || !entry.channelId) return;
  const state = readSyncState();
  const pending: PendingDoctorEvent = {
    eventUid: entry.eventUid || `lg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
    eventType: entry.category,
    category: entry.category,
    level: entry.level,
    message: safeCleanText(entry.message, 220) || entry.category,
    at: entry.at,
    channelKey: entry.channelKey,
    channelId: entry.channelId,
    channelName: safeCleanText(entry.channelName, 140) || entry.channelName,
  };
  state.pendingEvents.push(pending);
  const categoryItems = state.pendingEvents.filter((item) => item.category === entry.category);
  const keep = new Set(categoryItems.slice(-8).map((item) => item.eventUid));
  state.pendingEvents = state.pendingEvents.filter((item) => item.category !== entry.category || keep.has(item.eventUid));
  saveSyncState();
  scheduleDeferredFlush();
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
  /*
   * 2.5.294: a felhő (Supabase) memóriája CSAK a magyar csatornák tanulását
   * őrzi. A nem magyar csatornákat a TV Doktor továbbra is segíti a
   * készüléken, de róluk egyetlen adat sem megy fel a felhőbe – így hosszú
   * távon sem halmozódik felesleges adat.
   */
  if (payload.record && !isPersistableDoctorRecord(payload.record)) return;
  const state = readSyncState();
  const { record, event } = payload;

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
      routes: compactDoctorRoutes(record.routes),
      lastErrorCode: safeCleanText(record.lastErrorCode, 48),
      lastErrorReason: safeCleanText(record.lastErrorReason, 120),
    };

    const keys = Object.keys(state.pendingProfiles);
    if (keys.length > MAX_PENDING_PROFILES) {
      delete state.pendingProfiles[keys[0]];
    }
  }

  // A nyolclépcsős javítás minden próbáját külön eseményként is elmentjük.
  // Korábban csak a végső profil és az igazolt javítás került fel, ezért a TV
  // újraindítás után nem tudta megmutatni, melyik próbálkozás mit eredményezett.
  const eventType = String(payload.eventType || '');
  const isRepairAttempt = ['repair_attempt', 'buffer_test', 'speed_test', 'repair_exhausted', 'freeze_detected'].includes(eventType);
  const eventChannelId = safeCleanText(event.channelId || record?.channelId, 100);
  if (isRepairAttempt && eventChannelId && record && isPersistableDoctorRecord(record)) {
    const details = event.details && typeof event.details === 'object' ? event.details as Record<string, unknown> : {};
    const step = Math.max(0, Math.round(Number(details.step) || 0));
    const maxSteps = Math.max(1, Math.min(8, Math.round(Number(details.maxSteps) || 8)));
    const strategy = safeCleanText(details.strategyId || eventType, 64);
    const format = safeCleanText(event.playbackFormat, 8).toUpperCase();
    const buffer = safeCleanText(event.bufferProfile, 24);
    const ahead = Number(event.bufferAheadSeconds);
    const trigger = safeCleanText(event.errorReason, 48);
    const isExhausted = eventType === 'repair_exhausted' || eventType === 'freeze_detected';
    const message = isExhausted
      ? `Javítási sorozat lezárult (${step || maxSteps}/${maxSteps}) • eredmény=${strategy}${trigger ? ` • ok=${trigger}` : ''}`
      : `Próba ${step || '?'} / ${maxSteps}: ${format || '?'} + ${buffer || '?'}${Number.isFinite(ahead) && ahead > 0 ? ` (${ahead}s)` : ''} • ${strategy}${trigger ? ` • kiváltó ok=${trigger}` : ''}`;
    const attempt: PendingDoctorEvent = {
      eventUid: `try-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      eventType,
      category: isExhausted ? 'activation' : 'assistance',
      level: isExhausted ? 'warn' : 'repair',
      message: safeCleanText(message, 220),
      at: Date.now(),
      channelKey: safeCleanText(record.channelKey || event.channelKey, 120),
      channelId: eventChannelId,
      channelName: safeCleanText(event.channelName || record.channelName, 140) || record.channelName,
      playbackFormat: safeCleanText(event.playbackFormat, 8),
      bufferProfile: safeCleanText(event.bufferProfile, 24),
      bufferAheadSeconds: Number.isFinite(ahead) ? ahead : undefined,
      errorCode: safeCleanText(event.errorCode, 48) || undefined,
      errorReason: trigger || undefined,
      recovered: typeof event.recovered === 'boolean' ? event.recovered : undefined,
      details: { step, maxSteps, strategyId: strategy, trigger },
    };
    state.pendingEvents.push(attempt);
    // A próbálkozás azonnal látszódjon a TV négy kategóriakockájában is,
    // ne csak a következő Supabase-szinkron / IPK-indítás után.
    mergeCloudDoctorLogs([{ ...attempt, eventType, recovered: attempt.recovered, details: attempt.details }]);
    const categoryItems = state.pendingEvents.filter((item) => item.category === attempt.category);
    const keep = new Set(categoryItems.slice(-8).map((item) => item.eventUid));
    state.pendingEvents = state.pendingEvents.filter((item) => item.category !== attempt.category || keep.has(item.eventUid));
  }

  state.pendingEvents = state.pendingEvents.slice(-32);
  saveSyncState();
  scheduleDeferredFlush();
}

/** TV Doktor hibrid felhőszinkron engedélyezése vagy leállítása (beállítás-kapcsolóhoz kötve). */
export function configureTvDoctorCloud(enabled: boolean): void {
  cloudEnabled = enabled;
  readPairingState();
  if (!enabled) {
    setTvDoctorCloudHook(null);
    setTvDoctorCloudLogHook(null);
    setTvDoctorBaselineCloudHook(null);
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
  setTvDoctorCloudLogHook(enqueueDoctorLog);
  setTvDoctorBaselineCloudHook(() => { void syncTvDoctorBaselinesWithCloud(); });
  if (!connectivityListenersAttached && typeof window !== 'undefined') {
    connectivityListenersAttached = true;
    window.addEventListener('online', () => {
      void restoreTvDoctorCloudState();
    });
  }
  if (bootstrapTimer === null && isTvDoctorPaired()) {
    bootstrapTimer = scheduleTimer(() => {
      bootstrapTimer = null;
      if (!isTvDoctorPaired()) return;
      /*
       * Először a dedikált útvonal-RPC tölti vissza a teljes tanult memóriát,
       * utána következik a módosult profilok és események szinkronja.
       */
      void restoreTvDoctorCloudState();
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
export async function resetTvDoctorAllToZero(storage?: Storage | null): Promise<boolean> {
  clearTvDoctorMemory(storage);
  clearTvDoctorCloudQueue();
  if (cloudEnabled) setTvDoctorCloudHook(enqueueFromHook);
  const state = readSyncState();
  state.pendingProfiles = {};
  state.pendingEvents = [];
  /* 2.5.392: a nullázási szándékot MÉG a hálózati hívás előtt rögzítjük,
     hogy egy éppen futó felhő-bootstrap ne tölthesse vissza a profilokat. */
  state.pendingCloudReset = true;
  state.cloudProfileCount = 0;
  state.lastSyncAt = null;
  saveSyncState();
  const synced = await flushTvDoctorCloudQueue();
  /*
   * 2.5.392 – ZÉRÓ ABLAK VÉDELME: ha a nullázás pillanatában már futott egy
   * bootstrap (syncingNow), az RPC-törlés várólistán marad. Egy ilyen, korábban
   * elindult szinkron viszont a törlés UTÁN még visszamerge-elhette a felhő
   * profiljait a HELYI memóriába – ezért a hálózati hívás után MÉG EGYSZER
   * nullázzuk a helyi memóriát, és a sikertelen törlést újra várólistára
   * tesszük. Így a 0-ablak semmilyen időzítés mellett nem mutat régi utat.
   */
  clearTvDoctorMemory(storage);
  const after = readSyncState();
  if (!synced) {
    after.pendingCloudReset = true;
    after.pendingProfiles = {};
    after.pendingEvents = [];
    after.cloudProfileCount = 0;
    after.lastSyncAt = null;
  } else {
    after.pendingCloudReset = false;
    after.pendingProfiles = {};
    after.pendingEvents = [];
    after.cloudProfileCount = 0;
  }
  saveSyncState();
  /*
   * 2.5.394 – A HIÁNYZÓ FÉL KÖR. A 2.5.392 itt ÁLLT MEG: a nullázás után
   * semmi nem hívta meg a visszatöltést, így a TV `0/80`-on ragadt, pedig a
   * Supabase-ben ott volt a mentett 80 magyar csatorna és az 1-es alap.
   */
  if (synced && cloudEnabled && isTvDoctorPaired()) {
    /* Nem várjuk meg a hálózatot: a piros gomb azonnal visszatér, de a
       visszatöltés UGYANABBAN a tickben elindul, és a saját listenerje
       frissíti a 0-ablakot, amint a 80 mentett csatorna megérkezett. */
    void restoreTvDoctorCloudState().catch(() => {});
  }
  if (isTvDoctorDiagLoggingEnabled()) {
    appLog(synced
      ? 'TV DOKTOR NULLÁZÁS: a tanult memória 0; a Supabase-ben mentett csatornaelrendezés és az 1-es alapok megmaradtak, és azonnal visszatöltődtek a TV-re (tv -> Supabase -> tv).'
      : 'TV DOKTOR NULLÁZÁS: a helyi memória 0; a Supabase-törlés várólistán maradt, internetkapcsolatkor automatikusan újrapróbálja.');
  }
  notifyTvDoctorListeners();
  return synced;
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
      const activePlayback = getTvDoctorActivePlaybackSnapshot();
      if (activePlayback) {
        const activeLine = `=== TV DOKTOR AKTÍV LEJÁTSZÁS A NAPLÓ INDÍTÁSAKOR: tartalom=${activePlayback.contentType}; név=${activePlayback.channelName}; azonosító=${activePlayback.channelId || '-'}; formátum=${activePlayback.format}; pufferprofil=${activePlayback.bufferProfile}; lejátszik=${activePlayback.playing}; tölt=${activePlayback.loading}; helyreállít=${activePlayback.recovering}; pillanatkép_kora=${Math.max(0, Date.now() - activePlayback.capturedAt)}ms ===`;
        appLog(activeLine);
        tvDoctorLog(activeLine);
      } else {
        tvDoctorLog('TV DOKTOR AKTÍV LEJÁTSZÁS: a napló indításakor nem állt rendelkezésre lejátszási pillanatkép.');
      }
      // A kézi mérés innen minden aktuálisan tesztelt TV-csatornát követ,
      // nem egy előre megadott vagy név szerint rögzített csatornát.
      startTvDoctorPlaybackTelemetry();

      /*
       * 2.5.392: a négy szám EDDIG a GLOBÁLIS, kumulált kategória-számláló
       * volt, miközben a 0-ablak bal dobozai az AKTÍV CSATORNA friss
       * naplóbejegyzéseit mutatják. A napló ezért „tanulás=4”-et írt, a képernyő
       * meg 0-t vagy 4-et, és a felhő útvonalszáma is harmadik érték volt.
       * Most a két forrás KÜLÖN, pontosan megnevezve szerepel.
       */
      const activeChannelForBoxes = activePlayback
        ? { id: activePlayback.channelId || '', name: activePlayback.channelName || '' }
        : null;
      /* Itt SZINKRON vagyunk, a felhő útvonalai még nincsenek lekérve: a
         0-ablak ezt a HELYI pillanatképet egészíti ki a Supabase sorokkal. */
      const boxSnapshot = getTvDoctorChannelSnapshot(activeChannelForBoxes, null);
      const statusLine = `=== TV DOKTOR ÁLLAPOTKÉP: motor=${cloud.enabled ? 'AKTÍV' : 'KIKAPCSOLVA'}; párosítva=${cloud.paired ? 'IGEN' : 'NEM'}; tanult_csatornák=${mem.learnedChannelCount}/${mem.maxLearnedChannels}; igazolt_javítások=${summary.totalVerifiedRepairs}; ÖSSZESÍTETT_kategóriák=(tanulás=${summary.categoryStats.learning.count}, segítség=${summary.categoryStats.assistance.count}, aktiválódás=${summary.categoryStats.activation.count}, csatornahiba=${summary.categoryStats.channel_error.count}) ===`;
      appLog(statusLine);
      tvDoctorLog(statusLine);
      const boxLine = `=== TV DOKTOR 0-ABLAK ELLENŐRZÉS: csatorna=${activePlayback ? (activePlayback.channelName || 'ismeretlen') : 'nincs aktív csatorna'}; bal_dobozok=(tanulás=${boxSnapshot.logsByCategory.learning.length}, segítség=${boxSnapshot.logsByCategory.assistance.length}, aktiválódás=${boxSnapshot.logsByCategory.activation.length}, csatornahiba=${boxSnapshot.logsByCategory.channel_error.length}); tanult_útvonalak=${boxSnapshot.routes.length}/${MAX_CHANNEL_ROUTES} (HELYI=${boxSnapshot.localRouteCount}); a 0-ablak ezt a helyi pillanatképet egészíti ki a Supabase-ből olvasott, még hiányzó útvonalakkal; a négy doboz és az alsó lista ugyanabból a pillanatképből készül ===`;
      appLog(boxLine);
      tvDoctorLog(boxLine);
      const memLine = `TV DOKTOR MEMÓRIA: doktor=${formatDoctorBytes(mem.doctorTotalBytes)}/${formatDoctorBytes(mem.maxSafeDoctorBytes)} (${mem.doctorBudgetPercent}%); tv_tárhely=${formatDoctorBytes(mem.tvStorageUsedBytes)}/~5.0 MB (${mem.tvStoragePercent}%)${mem.jsHeapUsedMB !== null ? `; js_ram=${mem.jsHeapUsedMB} MB` : ''}; állapot=${mem.memoryHealthLabel}`;
      appLog(memLine);
      tvDoctorLog(memLine);
      const centralForLine = getTvDoctorCentralProfileState();
      const cloudLine = `TV DOKTOR SUPABASE: párosítva=${cloud.paired ? 'IGEN' : 'NEM'}; kapcsolat=${cloud.connected ? 'LÉTREJÖTT' : 'NINCS'}; állapot=${cloud.connectionState}; válaszidő=${cloud.latencyMs !== null ? `${cloud.latencyMs}ms` : 'nincs mérve'}; központi_profilok=${centralForLine.count}; tanult_profilok=${cloud.cloudProfileCount}; 1-es_alapok=${centralForLine.baselines}; várólista=${cloud.pendingCount}; utolsó_szinkron=${cloud.lastSyncAt || 'még nem volt'}`;
      appLog(cloudLine);
      tvDoctorLog(cloudLine);
      // 2.5.312: külön kiemelés a TV DR naplóba, hogy a Supabase-ről való visszaolvasás bizonyíthatóan működik
      /* 2.5.392: nem írunk fix „8 tanult útvonal/csatorna” állítást – csak a mért számot. */
      const central = getTvDoctorCentralProfileState();
      tvDoctorLog(`TV DR SUPABASE VISSZAOLVASÁS BEKÖTVE: a TV indulásakor a Supabase-ből (${cloud.cloudProfileCount} tanult profil) töltődik vissza a memória; mentett_központi_profilok=${central.count}; 1-es_alapok=${central.baselines}; tanult_útvonalak=${central.learnedRoutes}; aktív csatorna=${boxSnapshot.routes.length}/${MAX_CHANNEL_ROUTES} (helyi=${boxSnapshot.localRouteCount}) — a következő csatornaváltás a ténylegesen visszatöltött adatokból dolgozik.`);
      if (cloud.lastErrorSummary) {
        const line = `TV DOKTOR SUPABASE HIBA RÉSZLETEK: hol=${cloud.lastErrorLocation || 'ismeretlen'}; kód=${cloud.lastErrorCode || '-'}; hiba=${cloud.lastErrorSummary}`;
        appLog(line);
        tvDoctorLog(line);
      }
      if (mem.lastStorageError) {
        const line = `TV DOKTOR TÁRHELY HIBA RÉSZLETEK: hol=${mem.lastStorageError.location}; hiba=${mem.lastStorageError.message}`;
        appLog(line);
        tvDoctorLog(line);
      }
      if (op.lastSlowOp) {
        const line = `TV DOKTOR KORÁBBI LASSULÁS: művelet=${op.lastSlowOp.op}; idő=${op.lastSlowOp.elapsedMs}ms${op.lastSlowOp.channelName ? `; csatorna=${op.lastSlowOp.channelName}` : ''}`;
        appLog(line);
        tvDoctorLog(line);
      }
      const tailLogs = summary.recentLogs.slice(-5);
      for (let i = 0; i < tailLogs.length; i += 1) {
        const entry = tailLogs[i];
        const line = `TV DOKTOR ELŐZMÉNY [${entry.channelName}] (${entry.level}): ${entry.message}`;
        appLog(line);
        tvDoctorLog(line);
      }
      resetTvDoctorOperationCounters();
    },
    onStop: () => {
      if (!isTvDoctorDiagLoggingEnabled()) return;
      stopTvDoctorPlaybackTelemetry();
      const mem = getTvDoctorMemoryStats();
      const op = getTvDoctorOperationHealth();
      const cloud = getTvDoctorCloudStatus();
      const line = `=== TV DOKTOR NAPLÓ ÖSSZESÍTÉS: döntések=${op.decisionsCount}; max_döntési_idő=${op.maxDecisionMs}ms; elakadások_lassulások=${op.slowOpsCount}; fagyásvizsgálatok=${op.freezeChecksCount} (igazolt_fagyás=${op.confirmedFreezesCount}); javítási_lépések=${op.repairsAttemptedCount} (igazolt=${op.repairsVerifiedCount}); leállított_halott_csatorna=${op.deadChannelsHaltedCount}; memória=${formatDoctorBytes(mem.doctorTotalBytes)}/${formatDoctorBytes(mem.maxSafeDoctorBytes)}; supabase=${cloud.connected ? 'OK' : cloud.connectionState}${cloud.lastErrorSummary ? ` [${cloud.lastErrorLocation}: ${cloud.lastErrorSummary}]` : ''} ===`;
      appLog(line);
      tvDoctorLog(line);
    },
  });
}
