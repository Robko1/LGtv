/**
 * QR telefonos beállítás – TV oldali szolgáltatás
 * 
 * Folyamat:
 * 1. TV generál egy 6 jegyű kódot + UUID-t (tvId)
 * 2. TV mutat QR kódot: https://<domain>/provision.html?tv=<tvId>&code=<6jegy>
 * 3. Telefonon beolvassa QR-t, beírja szolgáltató adatait (Xtream vagy M3U)
 * 4. Telefon POST-ol kvdb.io-ra: https://kvdb.io/<BUCKET>/<tvId> = provider JSON
 * 5. TV poll-olja GET-tel 3mp-ként, ha megjön, importálja
 * 
 * Backend: kvdb.io – ingyenes, CORS, nincs auth, auto bucket
 * Fallback: npoint.io vagy localStorage (ha nincs net)
 */

export interface QrProviderPayload {
  type: 'xtream' | 'm3u';
  name?: string;
  // Xtream
  host?: string;
  port?: string;
  username?: string;
  password?: string;
  // M3U
  url?: string;
  // meta
  createdAt: string;
  code: string; // 6 jegyű kód amit TV mutat
}

const BUCKET = 'IPTV_RT_QR_8bc03776'; // fix bucket név – kvdb.io auto létrehozza első POST-nál
const KVDB_BASE = 'https://kvdb.io';
const POLL_INTERVAL = 3000;
const CODE_TTL_MS = 5 * 60 * 1000; // 5 percig él a kód

function generateTvId(): string {
  // UUID v4 rövidített
  return 'tv_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
}

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6 jegyű
}

export function createProvisionSession(): { tvId: string; code: string; expiresAt: number } {
  const tvId = generateTvId();
  const code = generateCode();
  const expiresAt = Date.now() + CODE_TTL_MS;
  try {
    localStorage.setItem('qr_tvId', tvId);
    localStorage.setItem('qr_code', code);
    localStorage.setItem('qr_expires', expiresAt.toString());
  } catch {}
  return { tvId, code, expiresAt };
}

export function getProvisionUrl(tvId: string, code: string): string {
  // A provision oldal a web buildben lesz: /provision.html
  // GitHub Pages vagy lokális: ha file:// akkor is működik ha van net
  // Használjuk a jelenlegi origin-t, de ha file:// akkor fallback github.io
  let base = '';
  try {
    const origin = window.location.origin;
    if (origin && origin !== 'null' && !origin.startsWith('file://')) {
      base = origin;
    } else {
      // Fallback – a te GitHub Pages URL-ed, vagy iptv-rt.web.app
      base = 'https://robko1.github.io/LGtv';
    }
  } catch {
    base = 'https://robko1.github.io/LGtv';
  }
  // provision.html a web/public-ban lesz
  return `${base}/provision.html?tv=${encodeURIComponent(tvId)}&code=${encodeURIComponent(code)}`;
}

export async function pollForProvider(tvId: string): Promise<QrProviderPayload | null> {
  try {
    const url = `${KVDB_BASE}/${BUCKET}/${encodeURIComponent(tvId)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      const data = JSON.parse(text) as QrProviderPayload;
      if (data && (data.type === 'xtream' || data.type === 'm3u')) {
        return data;
      }
    } catch {
      // Nem JSON – lehet üres
      return null;
    }
    return null;
  } catch (e) {
    console.warn('[QR] poll error', e);
    return null;
  }
}

export async function clearProvision(tvId: string): Promise<void> {
  try {
    // Törlés – POST üres vagy DELETE? kvdb.io DELETE támogatott
    const url = `${KVDB_BASE}/${BUCKET}/${encodeURIComponent(tvId)}`;
    await fetch(url, { method: 'DELETE' }).catch(() => {});
  } catch {}
  try {
    localStorage.removeItem('qr_tvId');
    localStorage.removeItem('qr_code');
    localStorage.removeItem('qr_expires');
  } catch {}
}

// Telefon oldali – provision.html használja
export async function pushProvider(tvId: string, payload: QrProviderPayload): Promise<boolean> {
  try {
    const url = `${KVDB_BASE}/${BUCKET}/${encodeURIComponent(tvId)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (e) {
    console.error('[QR] push error', e);
    return false;
  }
}

// Segéd – provider validálás
export function validateXtream(host: string, username: string, password: string): string | null {
  if (!host.trim()) return 'Host kötelező';
  if (!username.trim()) return 'Felhasználónév kötelező';
  if (!password.trim()) return 'Jelszó kötelező';
  return null;
}

export function validateM3u(url: string): string | null {
  if (!url.trim()) return 'M3U URL kötelező';
  if (!url.startsWith('http://') && !url.startsWith('https://')) return 'http:// vagy https:// kell';
  return null;
}
