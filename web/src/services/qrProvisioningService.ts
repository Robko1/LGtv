/**
 * QR telefonos beállítás – Supabase-alapú, lejáró, egyszer használatos párosítás.
 * A szolgáltatói adatok kizárólag a különálló Robko1 IPTV / QR iptv projektbe kerülnek.
 */
export interface QrProviderPayload {
  type: 'xtream' | 'm3u';
  name?: string;
  host?: string;
  port?: string;
  username?: string;
  password?: string;
  url?: string;
  createdAt: string;
  code: string;
}
export interface ProvisionChannel { kind: 'supabase'; id: string; }
export interface ProvisionSession { tvId: string; code: string; token: string; expiresAt: number; }

const API_URL = 'https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/qr-provision-form';
const FORM_URL = 'https://robko1.github.io/LGtv/provision.html';
const API_KEY = 'sb_publishable_JschCWGjgSE_b0NyINwxqA_7zAnS56C';
const POLL_INTERVAL = 3000;
const CODE_TTL_MS = 5 * 60 * 1000;
let channelDiag: string[] = [];
export function getProvisionDiag(): string { return channelDiag.join(' • '); }

function uuidV4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function randomToken(): string {
  // Rövidebb, 96 bites véletlen token: a QR csak ezt az azonosítót hordozza.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
async function request(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: API_KEY },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
export async function createProvisionSession(): Promise<ProvisionSession> {
  channelDiag = [];
  const tvId = uuidV4();
  const token = randomToken();
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const result = await request({ action: 'create', sessionId: tvId, token, code });
  const expiresAt = result.expiresAt ? Date.parse(result.expiresAt) : Date.now() + CODE_TTL_MS;
  try {
    localStorage.setItem('qr_tvId', tvId);
    localStorage.setItem('qr_code', code);
    localStorage.setItem('qr_token', token);
    localStorage.setItem('qr_expires', String(expiresAt));
  } catch {}
  return { tvId, code, token, expiresAt };
}
export async function ensureProvisionChannel(): Promise<ProvisionChannel | null> {
  return { kind: 'supabase', id: 'qr-provision' };
}
export function getProvisionUrl(tvId: string, code: string, channel?: ProvisionChannel | null, token = ''): string {
  // A HTML űrlap statikus weboldalon fut; a Supabase csak a párosítási API-t kezeli.
  const t = token || (() => { try { return localStorage.getItem('qr_token') || ''; } catch { return ''; } })();
  return `${FORM_URL}?tv=${encodeURIComponent(tvId)}&code=${encodeURIComponent(code)}&token=${encodeURIComponent(t)}`;
}
export async function pollForProvider(tvId: string, channel?: ProvisionChannel | null, token?: string): Promise<QrProviderPayload | null> {
  try {
    const t = token || localStorage.getItem('qr_token') || '';
    const result = await request({ action: 'poll', sessionId: tvId, token: t });
    const data = result.payload as QrProviderPayload | null;
    if (!data || (data.type !== 'xtream' && data.type !== 'm3u')) return null;
    return data;
  } catch (e) {
    console.warn('[QR] Supabase poll hiba', e);
    return null;
  }
}
export async function clearProvision(tvId: string, channel?: ProvisionChannel | null, token?: string): Promise<void> {
  try {
    const t = token || localStorage.getItem('qr_token') || '';
    if (t) await request({ action: 'consume', sessionId: tvId, token: t });
  } catch (e) { console.warn('[QR] Supabase consume hiba', e); }
  try {
    localStorage.removeItem('qr_tvId');
    localStorage.removeItem('qr_code');
    localStorage.removeItem('qr_token');
    localStorage.removeItem('qr_expires');
  } catch {}
}
export async function pushProvider(tvId: string, payload: QrProviderPayload, channel?: ProvisionChannel | null, token?: string): Promise<boolean> {
  try {
    const t = token || new URL(window.location.href).searchParams.get('token') || '';
    const code = new URL(window.location.href).searchParams.get('code') || payload.code;
    await request({ action: 'submit', sessionId: tvId, token: t, code, payload });
    return true;
  } catch (e) {
    console.error('[QR] Supabase push hiba', e);
    return false;
  }
}
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
