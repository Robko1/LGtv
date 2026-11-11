import { Channel, FavoriteFolder } from '../types/iptv';
import { storageService, DeletedChannelMark } from './storageService';
import { WEB_VERSION } from '../appVersion';
import { appLog } from './appLog';
import { isHungarianChannel } from '../utils/channelSelection';

/**
 * 2.5.326 — Csatorna elrendezés mentése: Magyarok sorrendje + törölt csatornák + kedvenc mappák
 * egyben, hogy újratöltés / üres IPK / újratelepítés után is egy gombbal visszaállítható legyen.
 *
 * A mentés FINGERPRINT alapú, nem nyers id: streamUrl + name|category kulcs alapján
 * illesztjük a pillanatképet a szolgáltató friss listájára, így akkor is pontos,
 * ha a szolgáltató új id-t ad ugyanannak a csatornának.
 *
 * Hely: Beállítások → Listák → legalsó doboz az „Összes lista törlése” alatt.
 * A teljes pillanatkép kizárólag a Supabase-ben tárolódik; a TV csak kis állapotjelző metaadatot őriz.
 */

const LAST_BACKUP_KEY = 'iptv_rt_layout_last_backup_v1';
let lastCloudFetchAt: string | null = null;

export interface LayoutSnapshot {
  version: string;
  createdAt: string; // ISO
  providerId: string;
  providerName: string;
  totalChannels: number;
  /** Egyszerű id-sorrend a gyors visszaállításhoz, ha az id-k még egyeznek. */
  channelOrder: string[];
  /** Csak a magyar főoldali csatornák ID-i; a kedvenc mappák külön maradnak. */
  hungarianChannelIds?: string[];
  hungarianChannelCount?: number;
  /** Robusztus fingerprint sorrend — streamUrl / nameKey alapján illesztünk. */
  fingerprintOrder: Array<{ id: string; streamUrl?: string; nameKey: string; displayOrder: number; countryCode?: string; categoryName?: string }>;
  deletedChannels: DeletedChannelMark[];
  folders: FavoriteFolder[];
}

export interface LastBackupInfo {
  at: string; // ISO
  providerId: string;
  providerName: string;
  source: 'cloud';
  totalChannels: number;
  deletedCount: number;
  folderCount: number;
}

function fingerprintFor(channel: Channel, displayOrder: number) {
  return {
    id: channel.id,
    streamUrl: channel.streamUrl || undefined,
    nameKey: `${channel.name.trim().toLowerCase()}|${channel.categoryId}`,
    countryCode: channel.countryCode || undefined,
    categoryName: channel.categoryName || undefined,
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
  // A felhőbe kizárólag a magyar főoldali csatornák és a felhasználó
  // kedvenc mappáiba tett csatornák kerülhetnek — utóbbiak bármely országból.
  const hungarianChannels = channelsInDisplayOrder.filter(isHungarianChannel);
  const favoriteIds = new Set(folders.flatMap((folder) => folder.channelIds || []));
  const scopedChannels = channelsInDisplayOrder.filter(
    (channel) => isHungarianChannel(channel) || favoriteIds.has(channel.id),
  );
  const deleted = storageService.getDeletedChannels(providerId);
  const includedIds = new Set(scopedChannels.map((channel) => channel.id));
  const fingerprintOrder = scopedChannels.map((ch, idx) => fingerprintFor(ch, idx));
  return {
    version: WEB_VERSION,
    createdAt: new Date().toISOString(),
    providerId,
    providerName,
    totalChannels: scopedChannels.length,
    channelOrder: scopedChannels.map((ch) => ch.id),
    hungarianChannelIds: hungarianChannels.map((ch) => ch.id),
    hungarianChannelCount: hungarianChannels.length,
    fingerprintOrder,
    deletedChannels: deleted,
    // Csak azok a mappatagok kerülnek a pillanatképbe, amelyek csatornája a főoldali/kedvenc készletben is szerepel.
    folders: folders.map((folder) => ({
      ...folder,
      channelIds: (folder.channelIds || []).filter((id) => includedIds.has(id)),
    })),
  };
}

/** Korábbi helyi JSON-pillanatképek egyszeri eltávolítása a TV tárhelyéről. */
function removeLegacyLocalLayoutSnapshots(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith('iptv_rt_layout_snapshot_v1_') || key === 'iptv_rt_layout_cloud_last_fetch_v1') {
        localStorage.removeItem(key);
      }
    }
  } catch {}
}
removeLegacyLocalLayoutSnapshots();

export function getLastBackupInfo(providerId?: string | null): LastBackupInfo | null {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastBackupInfo;
    if (!parsed || !parsed.at || parsed.source !== 'cloud') {
      localStorage.removeItem(LAST_BACKUP_KEY);
      return null;
    }
    if (providerId && parsed.providerId !== providerId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getCloudLastFetchInfo(): { at: string } | null {
  return lastCloudFetchAt ? { at: lastCloudFetchAt } : null;
}

// ---------- Supabase felhő (külön csatornaelrendezés-szolgáltatás; a meglévő TV-párosítás hitelesítésével) ----------
const DEFAULT_API_URL = 'https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-channel-layout';
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
      const detail = isUnknownAction ? 'A szerver még nem támogatja a Supabase-mentést (unknown_action) — Supabase Edge Function újra-deploy szükséges (functions/tv-doctor). Helyi másolat nem készül.' : rawDetail;
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
      const detail = isUnknownAction ? 'A szerver még nem támogatja a felhő mentést (unknown_action) — a tv-channel-layout Edge Function ellenőrzése szükséges.' : rawDetail;
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

function compactSnapshotForCloud(snapshot: LayoutSnapshot): Record<string, unknown> {
  const channelIds = new Set(snapshot.channelOrder);
  // A Doktor saját magyar főoldali hatóköre a kézi mentés része,
  // de a visszaállítási sorrend továbbra is kizárólag channelOrder/fingerprintOrder.
  const hungarianChannelIds = Array.from(new Set(snapshot.hungarianChannelIds || []))
    .filter((id) => channelIds.has(id));
  return {
    version: snapshot.version,
    createdAt: snapshot.createdAt,
    providerId: snapshot.providerId,
    providerName: snapshot.providerName,
    totalChannels: snapshot.totalChannels,
    channelOrder: snapshot.channelOrder,
    hungarianChannelIds,
    hungarianChannelCount: hungarianChannelIds.length,
    // A stream URL-ek érzékeny szolgáltatói adatot tartalmazhatnak és jellemzően ezek
    // növelik meg több megabájtosra a snapshotot. A név|kategória kulcs megmarad
    // tartalék illesztéshez, az ID pedig az elsődleges pontos visszaállításhoz.
    fingerprintOrder: snapshot.fingerprintOrder.map(({ id, nameKey }) => ({ id, nameKey })),
    deletedChannels: snapshot.deletedChannels.map(({ id, nameKey }) => ({ id, ...(nameKey ? { nameKey } : {}) })),
    folders: snapshot.folders,
  };
}

export async function saveSnapshotToCloud(snapshot: LayoutSnapshot): Promise<boolean> {
  const pairing = await getPairingWithFallback();
  if (!pairing) {
    appLog('Felhő mentés kihagyva: nincs párosítás.');
    return false;
  }
  const res = await postLayout('layout_upsert', { layout: compactSnapshotForCloud(snapshot), providerId: snapshot.providerId }, 15000);
  if (res && (res.ok === true || res.saved === true)) {
    lastCloudFetchAt = snapshot.createdAt;
    try {
      const info: LastBackupInfo = {
        at: snapshot.createdAt,
        providerId: snapshot.providerId,
        providerName: snapshot.providerName,
        source: 'cloud',
        totalChannels: snapshot.totalChannels,
        deletedCount: snapshot.deletedChannels.length,
        folderCount: snapshot.folders.length,
      };
      localStorage.setItem(LAST_BACKUP_KEY, JSON.stringify(info));
    } catch {}
    clearLastCloudError();
    appLog(`Elrendezés mentve a felhőbe (Supabase): ${snapshot.providerName}`);
    return true;
  }
  // Ha a szerver nem igazolja a mentést, nem készül helyi tartalékpéldány.
  // A hiba részlete a postLayout-ban naplózva van.
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
    lastCloudFetchAt = (snap as LayoutSnapshot).createdAt || new Date().toISOString();
    clearLastCloudError();
    return snap as LayoutSnapshot;
  }
  // Ha a felhő még nem támogatja, próbáljuk a tv-doctor REST fallback-et
  return null;
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
  const byNameOnly = new Map<string, Channel[]>();
  for (const ch of currentChannels) {
    if (ch.streamUrl) byStream.set(ch.streamUrl, ch);
    byNameKey.set(`${ch.name.trim().toLowerCase()}|${ch.categoryId}`, ch);
    const name = ch.name.trim().toLowerCase();
    const sameName = byNameOnly.get(name) || [];
    sameName.push(ch);
    byNameOnly.set(name, sameName);
  }
  // Másik szolgáltatónál az ID és kategória-ID is eltérhet.
  // Név alapján csak akkor illesztünk, ha a név egyértelmű a jelenlegi listában.
  const uniqueNameMatch = (nameKey?: string): Channel | undefined => {
    const name = String(nameKey || '').split('|')[0].trim().toLowerCase();
    const matches = byNameOnly.get(name) || [];
    return matches.length === 1 ? matches[0] : undefined;
  };

  const ordered: Channel[] = [];
  const used = new Set<string>();
  const favoriteIds = new Set(snapshot.folders.flatMap((folder) => folder.channelIds || []));
  // A Supabase-pillanatkép explicit HU-ID-listája akkor is hiteles, ha a
  // szolgáltató azóta megváltoztatta a csatorna országmezőit/kategóriáját.
  const savedHungarianIds = new Set(snapshot.hungarianChannelIds || []);

  // Snapshot sorrendje szerint illesztünk. A kedvenc státuszt a régi snapshot-ID
  // alapján vizsgáljuk, mert szolgáltatóváltáskor az új csatorna-ID eltérhet.
  for (const fp of snapshot.fingerprintOrder) {
    const match = byId.get(fp.id) || (fp.streamUrl ? byStream.get(fp.streamUrl) : undefined) || byNameKey.get(fp.nameKey) || uniqueNameMatch(fp.nameKey);
    const isSavedFavorite = favoriteIds.has(fp.id);
    if (match && (isHungarianChannel(match) || isSavedFavorite || savedHungarianIds.has(fp.id)) && !used.has(match.id)) {
      ordered.push(match);
      used.add(match.id);
    }
  }
  // Régi ID-alapú fallback: itt is csak magyar vagy korábban kedvenc csatorna jöhet vissza.
  for (const id of snapshot.channelOrder) {
    const ch = byId.get(id);
    if (ch && (isHungarianChannel(ch) || favoriteIds.has(id) || savedHungarianIds.has(id)) && !used.has(ch.id)) {
      ordered.push(ch);
      used.add(ch.id);
    }
  }
  // Csak új magyar főoldali csatornák és a kedvenc mappák tagjai kerülhetnek a végére.
  // A szolgáltató többi országa/kategóriája nem része ennek a személyes elrendezésmentésnek.
  for (const ch of currentChannels) {
    if (!used.has(ch.id) && (ch.countryCode?.toUpperCase() === 'HU' || ch.country === 'Magyarország' || /\b(magyarország|hungary|hungarian)\b/i.test(ch.categoryName || '') || favoriteIds.has(ch.id))) {
      // Törölt jegyzékben lévő ne jöjjön vissza
      // A törlési jelölő kizárólag az eredeti, egyedi csatorna-ID-ra érvényes.
      // Azonos nevű/streamű, de más ID-jú csatorna (pl. a másik TV4) maradjon meg.
      const isDeleted = snapshot.deletedChannels.some((mark) => mark.id === ch.id);
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
      let found: Channel | undefined;
      if (fp) {
        found = byId.get(fp.id) || (fp.streamUrl ? byStream.get(fp.streamUrl) : undefined) || byNameKey.get(fp.nameKey) || uniqueNameMatch(fp.nameKey);
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

/** Teljes visszaállítás: channelOrder + deleted + mappák alkalmazása; a pillanatkép kizárólag Supabase-ből érkezik. */
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
    storageService.saveFolders(remappedFolders, providerId);
    // Csak a kis állapotjelző metaadat kerül helyben tárolásra; a teljes pillanatkép nem.
    const info: LastBackupInfo = {
      at: snapshot.createdAt,
      providerId,
      providerName: snapshot.providerName,
      source: 'cloud',
      totalChannels: snapshot.totalChannels,
      deletedCount: snapshot.deletedChannels.length,
      folderCount: snapshot.folders.length,
    };
    localStorage.setItem(LAST_BACKUP_KEY, JSON.stringify(info));
    appLog(`Elrendezés visszaállítva: ${snapshot.providerName} — ${orderedChannels.length} csatorna, ${remappedFolders.length} mappa.`);
  } catch (e) {
    appLog(`Elrendezés visszaállítása hiba: ${String(e)}`);
  }
}
