import { Channel, FavoriteFolder } from '../types/iptv';
import { storageService, DeletedChannelMark } from './storageService';
import { WEB_VERSION } from '../appVersion';
import { appLog } from './appLog';

/**
 * 2.5.326 — Csatorna elrendezés mentése: Magyarok sorrendje + törölt csatornák + kedvenc mappák
 * egyben, hogy újratöltés / üres IPK / újratelepítés után is egy gombbal visszaállítható legyen.
 *
 * A mentés FINGERPRINT alapú, nem nyers id: streamUrl + name|category kulcs alapján
 * illesztjük a pillanatképet a szolgáltató friss listájára, így akkor is pontos,
 * ha a szolgáltató új id-t ad ugyanannak a csatornának.
 *
 * Hely: Beállítások → Listák → legalsó doboz az „Összes lista törlése” alatt.
 * Mindkét tároló (helyi + Supabase felhő) UGYANAZT a JSON-t kapja — nincs eltérés.
 */

const SNAPSHOT_PREFIX = 'iptv_rt_layout_snapshot_v1_';
const LAST_BACKUP_KEY = 'iptv_rt_layout_last_backup_v1';
const CLOUD_LAST_FETCH_KEY = 'iptv_rt_layout_cloud_last_fetch_v1';

export interface LayoutSnapshot {
  version: string;
  createdAt: string; // ISO
  providerId: string;
  providerName: string;
  totalChannels: number;
  /** Egyszerű id-sorrend a gyors visszaállításhoz, ha az id-k még egyeznek. */
  channelOrder: string[];
  /** Robusztus fingerprint sorrend — streamUrl / nameKey alapján illesztünk. */
  fingerprintOrder: Array<{ id: string; streamUrl?: string; nameKey: string; displayOrder: number }>;
  deletedChannels: DeletedChannelMark[];
  folders: FavoriteFolder[];
}

export interface LastBackupInfo {
  at: string; // ISO
  providerId: string;
  providerName: string;
  source: 'local' | 'cloud' | 'file';
  totalChannels: number;
  deletedCount: number;
  folderCount: number;
}

function snapshotKey(providerId: string): string {
  return SNAPSHOT_PREFIX + encodeURIComponent(providerId);
}

function fingerprintFor(channel: Channel, displayOrder: number) {
  return {
    id: channel.id,
    streamUrl: channel.streamUrl || undefined,
    nameKey: `${channel.name.trim().toLowerCase()}|${channel.categoryId}`,
    displayOrder,
  };
}

/** Pillanatkép készítése a jelenlegi állapotból. */
export function createLayoutSnapshot(
  providerId: string,
  providerName: string,
  channelsInDisplayOrder: Channel[],
  folders: FavoriteFolder[],
): LayoutSnapshot {
  const deleted = storageService.getDeletedChannels(providerId);
  const fingerprintOrder = channelsInDisplayOrder.map((ch, idx) => fingerprintFor(ch, idx));
  return {
    version: WEB_VERSION,
    createdAt: new Date().toISOString(),
    providerId,
    providerName,
    totalChannels: channelsInDisplayOrder.length,
    channelOrder: channelsInDisplayOrder.map((ch) => ch.id),
    fingerprintOrder,
    deletedChannels: deleted,
    folders: JSON.parse(JSON.stringify(folders)) as FavoriteFolder[],
  };
}

/** Helyi mentés (localStorage). */
export function saveSnapshotLocal(snapshot: LayoutSnapshot): void {
  try {
    localStorage.setItem(snapshotKey(snapshot.providerId), JSON.stringify(snapshot));
    const info: LastBackupInfo = {
      at: snapshot.createdAt,
      providerId: snapshot.providerId,
      providerName: snapshot.providerName,
      source: 'local',
      totalChannels: snapshot.totalChannels,
      deletedCount: snapshot.deletedChannels.length,
      folderCount: snapshot.folders.length,
    };
    localStorage.setItem(LAST_BACKUP_KEY, JSON.stringify(info));
    appLog(`Elrendezés mentve helyben: ${snapshot.providerName} — ${snapshot.totalChannels} csatorna, ${snapshot.deletedChannels.length} törölt, ${snapshot.folders.length} mappa.`);
  } catch (e) {
    appLog(`Elrendezés helyi mentése sikertelen: ${String(e)}`);
  }
}

export function loadSnapshotLocal(providerId: string): LayoutSnapshot | null {
  try {
    const raw = localStorage.getItem(snapshotKey(providerId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LayoutSnapshot;
    if (!parsed || !Array.isArray(parsed.channelOrder)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getLastBackupInfo(): LastBackupInfo | null {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastBackupInfo;
    if (!parsed || !parsed.at) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getCloudLastFetchInfo(): { at: string; snapshot: LayoutSnapshot } | null {
  try {
    const raw = localStorage.getItem(CLOUD_LAST_FETCH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.at || !parsed.snapshot) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------- Supabase felhő (TV Doktor párosítással) ----------
const DEFAULT_API_URL = 'https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor';
const API_KEY = 'sb_publishable_JschCWGjgSE_b0NyINwxqA_7zAnS56C';
const PAIRING_KEY = 'iptv_rt_tv_doctor_pairing_v1';
const IDB_NAME_LAYOUT = 'iptv_tv_doctor_pairing_db_v1';
const IDB_STORE_LAYOUT = 'pairing';
const IDB_PRIMARY_KEY_LAYOUT = 'primary';
const LAST_CLOUD_ERROR_KEY = 'iptv_rt_layout_cloud_last_error_v1';

function getPairing(): { deviceId: string; deviceToken: string | null } | null {
  try {
    const raw = localStorage.getItem(PAIRING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.deviceId || !p?.deviceToken) return null;
    return { deviceId: String(p.deviceId), deviceToken: String(p.deviceToken) };
  } catch {
    return null;
  }
}

function sanitizeDeviceIdLayout(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return c.length >= 6 ? c : null;
}
function sanitizeDeviceTokenLayout(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.trim();
  if (c.length < 32 || c.length > 160) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(c)) return null;
  return c;
}

async function idbReadPairingLayout(): Promise<{ deviceId: string; deviceToken: string } | null> {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB) return null;
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(IDB_NAME_LAYOUT, 1);
        req.onupgradeneeded = () => {
          try {
            const d = req.result;
            if (!d.objectStoreNames.contains(IDB_STORE_LAYOUT)) d.createObjectStore(IDB_STORE_LAYOUT);
          } catch {}
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      } catch (e) { reject(e as any); }
    });
    const val: any = await new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE_LAYOUT, 'readonly');
        const rq = tx.objectStore(IDB_STORE_LAYOUT).get(IDB_PRIMARY_KEY_LAYOUT);
        rq.onsuccess = () => { try { db.close(); } catch {} resolve(rq.result); };
        rq.onerror = () => { try { db.close(); } catch {} resolve(null); };
      } catch { try { db.close(); } catch {} resolve(null); }
    });
    if (val && typeof val === 'object') {
      const did = sanitizeDeviceIdLayout((val as any).deviceId);
      const tok = sanitizeDeviceTokenLayout((val as any).deviceToken);
      if (did && tok) return { deviceId: did, deviceToken: tok };
    }
  } catch {}
  return null;
}

async function getPairingWithFallback(): Promise<{ deviceId: string; deviceToken: string } | null> {
  const direct = getPairing();
  if (direct && direct.deviceToken) return direct as { deviceId: string; deviceToken: string };
  // localStorage üres de IDB-ben még megvan (TV újraindítás / tárhelyürítés után) — hidratáljuk
  const fromIdb = await idbReadPairingLayout();
  if (fromIdb) {
    try {
      localStorage.setItem(PAIRING_KEY, JSON.stringify({
        deviceId: fromIdb.deviceId,
        deviceToken: fromIdb.deviceToken,
        pairedAt: new Date().toISOString(),
        tokenExpiresAt: null,
      }));
    } catch {}
    return fromIdb;
  }
  return null;
}

function setLastCloudError(msg: string): void {
  try { localStorage.setItem(LAST_CLOUD_ERROR_KEY, JSON.stringify({ at: new Date().toISOString(), error: msg.slice(0, 300) })); } catch {}
}
export function getLastCloudError(): { at: string; error: string } | null {
  try {
    const raw = localStorage.getItem(LAST_CLOUD_ERROR_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.error) return null;
    return p;
  } catch { return null; }
}
export function clearLastCloudError(): void {
  try { localStorage.removeItem(LAST_CLOUD_ERROR_KEY); } catch {}
}

async function postLayout(action: 'layout_upsert' | 'layout_fetch', body: Record<string, unknown>, timeoutMs = 15000): Promise<any | null> {
  const pairing = await getPairingWithFallback();
  if (!pairing) {
    const msg = 'Nincs párosítás (deviceToken hiányzik) — párosítsd újra a Rendszer → Supabase-párosításban.';
    setLastCloudError(msg);
    appLog(`Felhő elrendezés hiba (${action}): ${msg}`);
    return null;
  }
  if (typeof fetch !== 'function') {
    const msg = 'fetch nem elérhető ezen a TV böngészőn.';
    setLastCloudError(msg);
    return null;
  }
  if (typeof navigator !== 'undefined' && (navigator as any).onLine === false) {
    const msg = 'Offline — nincs internetkapcsolat.';
    setLastCloudError(msg);
    appLog(`Felhő elrendezés offline (${action})`);
    return null;
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs) : null;
  try {
    const started = Date.now();
    const res = await fetch(DEFAULT_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: API_KEY,
        Authorization: `Bearer ${API_KEY}`,
        'x-tv-device-id': pairing.deviceId,
        'x-tv-device-token': pairing.deviceToken,
      },
      body: JSON.stringify({ action, deviceId: pairing.deviceId, deviceToken: pairing.deviceToken, ...body }),
      signal: controller?.signal as any,
    });
    const text = await res.text().catch(() => '');
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 200) }; }
    const latency = Date.now() - started;
    if (!res.ok) {
      const rawDetail = (parsed && (parsed.error || parsed.message || parsed.reason || parsed.hint)) ? String(parsed.error || parsed.message || parsed.reason).slice(0, 160) : `HTTP ${res.status}`;
      const isUnknownAction = rawDetail.includes('unknown_action');
      const detail = isUnknownAction ? 'A szerver még nem támogatja a felhő mentést (unknown_action) — Supabase Edge Function újra-deploy szükséges (functions/tv-doctor). A helyi mentés OK.' : rawDetail;
      const loc = res.status === 401 ? 'Supabase párosítás (401)' : res.status === 404 ? 'Edge Function (404)' : res.status === 429 ? 'Rate limit (429)' : res.status >= 500 ? 'Supabase szerver (5xx)' : `Supabase (${res.status})`;
      const msg = isUnknownAction ? detail : `${loc}: ${detail}`;
      setLastCloudError(msg);
      appLog(`Felhő elrendezés hiba (${action} HTTP ${res.status} ${latency}ms): ${detail} — nyers: ${text.slice(0, 180)}`);
      // 401 esetén a token érvénytelen — ne próbálkozzunk csendben
      if (res.status === 401) appLog('Felhő 401: párosítás érvénytelen — új párosítás szükséges.');
      // parsed-t visszaadjuk hogy a hívó lássa az ok:false-t
      return parsed;
    }
    if (!parsed || parsed.ok === false) {
      const rawDetail = parsed ? String(parsed.error || parsed.message || 'ismeretlen hiba').slice(0, 180) : 'üres válasz';
      const isUnknownAction = rawDetail.includes('unknown_action');
      const detail = isUnknownAction ? 'A szerver még nem támogatja a felhő mentést (unknown_action) — Edge Function újra-deploy szükséges.' : rawDetail;
      const msg = isUnknownAction ? detail : `Szerver hiba: ${detail}`;
      setLastCloudError(msg);
      appLog(`Felhő elrendezés hiba (${action} ok:false ${latency}ms): ${detail}`);
      return parsed;
    }
    clearLastCloudError();
    if (latency > 3500) appLog(`Felhő elrendezés lassú (${action} ${latency}ms) — de sikeres.`);
    return parsed;
  } catch (e: any) {
    const isAbort = e?.name === 'AbortError' || String(e).includes('abort');
    const msg = isAbort ? `Időtúllépés ${timeoutMs}ms után — a Supabase hidegindítása lassú lehet, próbáld újra.` : `Hálózati hiba: ${String(e?.message || e).slice(0, 160)}`;
    setLastCloudError(msg);
    appLog(`Felhő elrendezés hiba (${action} throw): ${msg}`);
    return null;
  } finally {
    if (t) clearTimeout(t as any);
  }
}

export async function saveSnapshotToCloud(snapshot: LayoutSnapshot): Promise<boolean> {
  const pairing = await getPairingWithFallback();
  if (!pairing) {
    appLog('Felhő mentés kihagyva: nincs párosítás.');
    return false;
  }
  const res = await postLayout('layout_upsert', { layout: snapshot, providerId: snapshot.providerId }, 15000);
  if (res && (res.ok === true || res.saved === true)) {
    try {
      // A szinkron badge a snapshot idejét hasonlítja — tároljuk a createdAt-ot, ne a fetch idejét
      localStorage.setItem(CLOUD_LAST_FETCH_KEY, JSON.stringify({ at: snapshot.createdAt, snapshot }));
    } catch {}
    clearLastCloudError();
    appLog(`Elrendezés mentve a felhőbe (Supabase): ${snapshot.providerName}`);
    return true;
  }
  // Ha a szerver nem ismeri a layout akciót, 200-as ok nélkül tér vissza — ekkor helyi marad
  // A hiba részlete már a postLayout-ban naplózva + localStorage-ban
  return false;
}

export async function fetchSnapshotFromCloud(providerId: string): Promise<LayoutSnapshot | null> {
  const pairing = await getPairingWithFallback();
  if (!pairing) return null;
  const res = await postLayout('layout_fetch', { providerId }, 10000);
  if (!res) return null;
  // Sikertelen válasz (ok:false) esetén nincs snapshot
  if (res.ok === false || res.found === false) {
    if (res.found === false) clearLastCloudError();
    return null;
  }
  // Válasz formátumok: { ok:true, layout:{...}} vagy { ok:true, snapshot:{...}} vagy tömb
  const snap = (res.layout || res.snapshot || res.data || null) as LayoutSnapshot | null;
  if (snap && Array.isArray((snap as any).channelOrder)) {
    try {
      localStorage.setItem(CLOUD_LAST_FETCH_KEY, JSON.stringify({ at: (snap as LayoutSnapshot).createdAt || new Date().toISOString(), snapshot: snap }));
    } catch {}
    clearLastCloudError();
    return snap as LayoutSnapshot;
  }
  // Ha a felhő még nem támogatja, próbáljuk a tv-doctor REST fallback-et
  return null;
}

// ---------- Fájl export / import ----------
export function exportSnapshotToFile(snapshot: LayoutSnapshot): void {
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = snapshot.providerName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || snapshot.providerId.slice(0, 12);
  a.href = url;
  a.download = `elrendezes-${safeName}-${snapshot.createdAt.slice(0, 10)}-${snapshot.version}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { document.body.removeChild(a); } catch {}
    try { URL.revokeObjectURL(url); } catch {}
  }, 500);
  appLog(`Elrendezés exportálva fájlba: ${a.download}`);
}

export async function importSnapshotFromFile(file: File): Promise<LayoutSnapshot | null> {
  const text = await file.text().catch(() => '');
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as LayoutSnapshot;
    if (!parsed || !Array.isArray(parsed.channelOrder) || !Array.isArray(parsed.fingerprintOrder)) return null;
    // minimális validáció
    if (!parsed.providerId || !parsed.createdAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------- Visszaállítás illesztése ----------
/**
 * A pillanatkép sorrendjét a jelenlegi csatornalistára illesztjük fingerprint alapján.
 * Új csatornák a végére kerülnek, töröltek nem jönnek vissza, mappák tagsága frissül.
 */
export function applySnapshotToChannels(
  snapshot: LayoutSnapshot,
  currentChannels: Channel[],
): { orderedChannels: Channel[]; remappedFolders: FavoriteFolder[]; deletedMarks: DeletedChannelMark[] } {
  const byId = new Map(currentChannels.map((c) => [c.id, c]));
  const byStream = new Map<string, Channel>();
  const byNameKey = new Map<string, Channel>();
  for (const ch of currentChannels) {
    if (ch.streamUrl) byStream.set(ch.streamUrl, ch);
    byNameKey.set(`${ch.name.trim().toLowerCase()}|${ch.categoryId}`, ch);
  }

  const ordered: Channel[] = [];
  const used = new Set<string>();

  // Snapshot sorrendje szerint illesztjük a jelenlegi csatornákat
  for (const fp of snapshot.fingerprintOrder) {
    const match = byId.get(fp.id) || (fp.streamUrl ? byStream.get(fp.streamUrl) : undefined) || byNameKey.get(fp.nameKey);
    if (match && !used.has(match.id)) {
      ordered.push(match);
      used.add(match.id);
    }
  }
  // Snapshot channelOrder fallback (id lista) — ha fingerprint nem talált
  for (const id of snapshot.channelOrder) {
    const ch = byId.get(id);
    if (ch && !used.has(ch.id)) {
      ordered.push(ch);
      used.add(ch.id);
    }
  }
  // Maradék (újonnan érkezett) csatornák a végére, eredeti sorrendben
  for (const ch of currentChannels) {
    if (!used.has(ch.id)) {
      // Törölt jegyzékben lévő ne jöjjön vissza
      const isDeleted = snapshot.deletedChannels.some(
        (m) => m.id === ch.id || (m.streamUrl && m.streamUrl === ch.streamUrl) || m.nameKey === `${ch.name.trim().toLowerCase()}|${ch.categoryId}`,
      );
      if (isDeleted) continue;
      ordered.push(ch);
      used.add(ch.id);
    }
  }

  // Mappák remappelése fingerprint alapján
  const remappedFolders: FavoriteFolder[] = snapshot.folders.map((folder) => {
    const remappedIds: string[] = [];
    for (const oldId of folder.channelIds) {
      // keressük az oldId-hoz tartozó fingerprintet a snapshotban
      const fp = snapshot.fingerprintOrder.find((f) => f.id === oldId);
      const keys = fp ? [fp.id, fp.streamUrl, fp.nameKey] : [oldId];
      let found: Channel | undefined;
      if (fp) {
        found = byId.get(fp.id) || (fp.streamUrl ? byStream.get(fp.streamUrl) : undefined) || byNameKey.get(fp.nameKey);
      } else {
        found = byId.get(oldId);
      }
      if (found) remappedIds.push(found.id);
    }
    // duplikátumok nélkül, sorrend megtartva
    const uniq = Array.from(new Set(remappedIds));
    return { ...folder, channelIds: uniq };
  });

  return { orderedChannels: ordered, remappedFolders, deletedMarks: snapshot.deletedChannels };
}

/** Teljes visszaállítás: channelOrder + deleted + mappák mentése, helyi+felhő szinkron. */
export function persistRestoredLayout(
  snapshot: LayoutSnapshot,
  orderedChannels: Channel[],
  remappedFolders: FavoriteFolder[],
  providerId: string,
): void {
  try {
    // Sorrend
    const orderIds = orderedChannels.map((c) => c.id);
    storageService.saveChannelOrder(providerId, orderIds);
    // Törölt jegyzék — felülírjuk a pillanatkép szerint (hogy a visszaállítás pontos legyen)
    try {
      localStorage.setItem(`iptv_rt_deleted_channels_v1_${encodeURIComponent(providerId)}`, JSON.stringify(snapshot.deletedChannels));
    } catch {}
    // Mappák
    storageService.saveFolders(remappedFolders);
    // Utolsó visszaállítás infó
    const info: LastBackupInfo = {
      at: new Date().toISOString(),
      providerId,
      providerName: snapshot.providerName,
      source: 'local',
      totalChannels: snapshot.totalChannels,
      deletedCount: snapshot.deletedChannels.length,
      folderCount: snapshot.folders.length,
    };
    localStorage.setItem(LAST_BACKUP_KEY, JSON.stringify(info));
    // Helyi snapshot frissítése is (hogy legközelebb ez legyen a legfrissebb)
    saveSnapshotLocal({ ...snapshot, createdAt: new Date().toISOString() });
    // Felhőbe is (ha párosítva)
    void saveSnapshotToCloud(snapshot).catch(() => {});
    appLog(`Elrendezés visszaállítva: ${snapshot.providerName} — ${orderedChannels.length} csatorna, ${remappedFolders.length} mappa.`);
  } catch (e) {
    appLog(`Elrendezés visszaállítása hiba: ${String(e)}`);
  }
}
