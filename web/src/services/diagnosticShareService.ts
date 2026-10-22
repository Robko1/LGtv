const API_URL = 'https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-diagnostic-share';
const API_KEY = 'sb_publishable_JschCWGjgSE_b0NyINwxqA_7zAnS56C';

export interface DiagnosticShare {
  url: string;
  token: string;
  expiresAt: string;
}

async function request(body: Record<string, unknown>): Promise<any> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: API_KEY },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(result.error || `HTTP ${response.status}`));
  return result;
}

export async function createDiagnosticShare(logText: string): Promise<DiagnosticShare> {
  const result = await request({ action: 'create', logText });
  if (typeof result.url !== 'string' || typeof result.token !== 'string') {
    throw new Error('A Supabase nem adott vissza QR-hivatkozást.');
  }
  return { url: result.url, token: result.token, expiresAt: String(result.expiresAt || '') };
}

export async function refreshDiagnosticShare(token: string, logText: string): Promise<string> {
  const result = await request({ action: 'update', token, logText });
  if (!result.ok || typeof result.expiresAt !== 'string') throw new Error('A napló frissítése nem sikerült.');
  return result.expiresAt;
}

export async function revokeDiagnosticShare(token: string): Promise<void> {
  try { await request({ action: 'revoke', token }); } catch { /* a régi link lejár magától */ }
}
