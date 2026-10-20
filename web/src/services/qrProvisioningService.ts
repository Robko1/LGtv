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

// TÁROLÓ (relay) A TELEFON ÉS A TV KÖZÖTT
//
// 1. próba: kvdb.io – a TV létrehoz egy tárolót, majd ÖNTESZTTEL (írás +
//    visszaolvasás) ellenőrzi, hogy tényleg működik. A 2.3.8-ban kiderült,
//    hogy a kvdb.io 403-at ("a tároló házirendje blokkolta a kérést") is
//    adhat, ezért csak IGAZOLTAN működő tárolót teszünk a QR kódba.
// 2. tartalék: jsonblob.com – névtelen JSON tároló, CORS-barát.
// A QR linkben &b=<kvdb tároló> VAGY &j=<jsonblob azonosító> utazik.
export interface ProvisionChannel {
  kind: 'ntfy' | 'kvdb' | 'jsonblob';
  id: string;
}

const LEGACY_BUCKET = 'IPTV_RT_QR_8bc03776'; // régi fix név – csak végső tartalék
const KVDB_BASE = 'https://kvdb.io';
const JSONBLOB_BASE = 'https://jsonblob.com/api/jsonBlob';
const NTFY_BASE = 'https://ntfy.sh'; // elsődleges: névtelen, CORS-barát pub/sub

// Részletes hibanapló a TV-s hibaképernyőhöz: pontosan melyik szolgáltatás
// miért nem ment át az önteszten (HTTP kód vagy hálózati hiba).
let channelDiag: string[] = [];
function diag(msg: string): void {
  channelDiag.push(msg);
  console.warn('[QR]', msg);
}
export function getProvisionDiag(): string {
  return channelDiag.join(' • ');
}

/** ntfy.sh önteszt: közzététel + visszaolvasás ugyanarra a témára. */
async function verifyNtfy(topic: string): Promise<boolean> {
  try {
    const token = 'selftest' + Date.now();
    const pub = await fetch(`${NTFY_BASE}/${encodeURIComponent(topic)}`, { method: 'POST', body: token });
    if (!pub.ok) { diag(`ntfy írás: HTTP ${pub.status}`); return false; }
    const res = await fetch(`${NTFY_BASE}/${encodeURIComponent(topic)}/json?poll=1&since=all`);
    if (!res.ok) { diag(`ntfy olvasás: HTTP ${res.status}`); return false; }
    if ((await res.text()).indexOf(token) >= 0) return true;
    diag('ntfy: a visszaolvasott adat hiányzik');
    return false;
  } catch (e) {
    diag('ntfy: hálózati hiba (' + ((e as Error)?.message || e) + ')');
    return false;
  }
}

function newNtfyTopic(): string {
  return 'iptvrt_' + Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
}
const CHANNEL_TTL_MS = 6 * 24 * 60 * 60 * 1000; // 6 nap után új tárolót kérünk

/** kvdb.io önteszt: írás + visszaolvasás. Csak működő tárolót hirdetünk. */
async function verifyKvdb(bucket: string): Promise<boolean> {
  try {
    const key = `${KVDB_BASE}/${encodeURIComponent(bucket)}/iptv_selftest`;
    // Szándékosan NINCS Content-Type fejléc: így "egyszerű" kérés, nem kell
    // CORS preflight – pont úgy viselkedik, mint a telefon küldése.
    const w = await fetch(key, { method: 'POST', body: 'ok' });
    if (!w.ok) { diag(`kvdb írás: HTTP ${w.status}`); return false; }
    const r = await fetch(key);
    if (!r.ok) { diag(`kvdb olvasás: HTTP ${r.status}`); return false; }
    return (await r.text()).trim().indexOf('ok') === 0;
  } catch (e) {
    diag('kvdb önteszt: hálózati hiba (' + ((e as Error)?.message || e) + ')');
    return false;
  }
}

async function createKvdb(): Promise<string> {
  try {
    const res = await fetch(KVDB_BASE + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'email=iptv.rt.webos@gmail.com',
    });
    const text = (await res.text()).trim();
    if (res.ok && /^[A-Za-z0-9_-]{8,64}$/.test(text)) return text;
    diag(`kvdb létrehozás: HTTP ${res.status} (${text.slice(0, 40)})`);
    return '';
  } catch (e) {
    diag('kvdb: hálózati hiba (' + ((e as Error)?.message || e) + ')');
    return '';
  }
}

async function verifyJsonblob(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${JSONBLOB_BASE}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waiting: true }),
    });
    if (!res.ok) diag(`jsonblob írás: HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    diag('jsonblob: hálózati hiba (' + ((e as Error)?.message || e) + ')');
    return false;
  }
}

async function createJsonblob(): Promise<string> {
  try {
    const res = await fetch(JSONBLOB_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ waiting: true }),
    });
    if (!res.ok) { diag(`jsonblob létrehozás: HTTP ${res.status}`); return ''; }
    const loc = res.headers.get('Location') || res.headers.get('location') || '';
    const m = loc.match(/jsonBlob\/([A-Za-z0-9-]+)/);
    if (!m) diag('jsonblob: nincs Location fejléc');
    return m ? m[1] : '';
  } catch (e) {
    diag('jsonblob: hálózati hiba (' + ((e as Error)?.message || e) + ')');
    return '';
  }
}

function saveChannel(ch: ProvisionChannel): void {
  try {
    localStorage.setItem('qr_chan_kind', ch.kind);
    localStorage.setItem('qr_chan_id', ch.id);
    localStorage.setItem('qr_chan_ts', Date.now().toString());
  } catch {}
}

/** IGAZOLTAN működő tárolócsatorna. null = egyik szolgáltatás sem elérhető. */
export async function ensureProvisionChannel(): Promise<ProvisionChannel | null> {
  channelDiag = [];
  // Korábbi, még friss csatorna újrahasznosítása (öntesztet így is futtatunk)
  try {
    const kind = localStorage.getItem('qr_chan_kind') || '';
    const id = localStorage.getItem('qr_chan_id') || '';
    const ts = parseInt(localStorage.getItem('qr_chan_ts') || '0', 10);
    if (id && ts && Date.now() - ts < CHANNEL_TTL_MS) {
      if (kind === 'ntfy' && (await verifyNtfy(id))) return { kind: 'ntfy', id };
      if (kind === 'kvdb' && (await verifyKvdb(id))) return { kind: 'kvdb', id };
      if (kind === 'jsonblob' && (await verifyJsonblob(id))) return { kind: 'jsonblob', id };
    }
  } catch {}
  const topic = newNtfyTopic();
  if (await verifyNtfy(topic)) {
    const chN: ProvisionChannel = { kind: 'ntfy', id: topic };
    saveChannel(chN);
    return chN;
  }
  const bucket = await createKvdb();
  if (bucket && (await verifyKvdb(bucket))) {
    const ch: ProvisionChannel = { kind: 'kvdb', id: bucket };
    saveChannel(ch);
    return ch;
  }
  const blob = await createJsonblob();
  if (blob && (await verifyJsonblob(blob))) {
    const ch: ProvisionChannel = { kind: 'jsonblob', id: blob };
    saveChannel(ch);
    return ch;
  }
  console.warn('[QR] egyik tároló szolgáltatás sem elérhető');
  return null;
}

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

export function getProvisionUrl(tvId: string, code: string, channel?: ProvisionChannel | null): string {
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
  let extra = '';
  if (channel && channel.kind === 'ntfy') extra = `&n=${encodeURIComponent(channel.id)}`;
  else if (channel && channel.kind === 'kvdb') extra = `&b=${encodeURIComponent(channel.id)}`;
  else if (channel && channel.kind === 'jsonblob') extra = `&j=${encodeURIComponent(channel.id)}`;
  return `${base}/provision.html?tv=${encodeURIComponent(tvId)}&code=${encodeURIComponent(code)}${extra}`;
}

export async function pollForProvider(tvId: string, channel?: ProvisionChannel | null): Promise<QrProviderPayload | null> {
  if (channel && channel.kind === 'ntfy') {
    try {
      const res = await fetch(`${NTFY_BASE}/${encodeURIComponent(channel.id)}/json?poll=1&since=all`);
      if (!res.ok) return null;
      const lines = (await res.text()).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg && msg.event === 'message' && typeof msg.message === 'string') {
            const data = JSON.parse(msg.message) as QrProviderPayload;
            if (data && (data.type === 'xtream' || data.type === 'm3u')) return data;
          }
        } catch { /* nem ez az üzenet */ }
      }
      return null;
    } catch (e) {
      console.warn('[QR] ntfy poll hiba', e);
      return null;
    }
  }
  try {
    const url = channel && channel.kind === 'jsonblob'
      ? `${JSONBLOB_BASE}/${encodeURIComponent(channel.id)}`
      : `${KVDB_BASE}/${channel ? channel.id : LEGACY_BUCKET}/${encodeURIComponent(tvId)}`;
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

export async function clearProvision(tvId: string, channel?: ProvisionChannel | null): Promise<void> {
  try {
    if (channel && channel.kind === 'ntfy') {
      // ntfy: az üzenetek ~12 óra után maguktól törlődnek, nincs teendő.
    } else if (channel && channel.kind === 'jsonblob') {
      // A blob marad (újrahasznosítjuk), csak az adatokat ürítjük ki.
      await fetch(`${JSONBLOB_BASE}/${encodeURIComponent(channel.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waiting: true }),
      }).catch(() => {});
    } else {
      const url = `${KVDB_BASE}/${channel ? channel.id : LEGACY_BUCKET}/${encodeURIComponent(tvId)}`;
      await fetch(url, { method: 'DELETE' }).catch(() => {});
    }
  } catch {}
  try {
    localStorage.removeItem('qr_tvId');
    localStorage.removeItem('qr_code');
    localStorage.removeItem('qr_expires');
  } catch {}
}

// Telefon oldali – provision.html használja
export async function pushProvider(tvId: string, payload: QrProviderPayload, channel?: ProvisionChannel | null): Promise<boolean> {
  try {
    if (channel && channel.kind === 'jsonblob') {
      const res = await fetch(`${JSONBLOB_BASE}/${encodeURIComponent(channel.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return res.ok;
    }
    const url = `${KVDB_BASE}/${channel ? channel.id : LEGACY_BUCKET}/${encodeURIComponent(tvId)}`;
    // Nincs Content-Type fejléc: egyszerű kérés, nem kell CORS preflight.
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(payload) });
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
