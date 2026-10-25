const API_URL = 'https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-diagnostic-share';
const API_KEY = 'sb_publishable_JschCWGjgSE_b0NyINwxqA_7zAnS56C';
const LOCAL_HISTORY_KEY = 'iptv_rt_diagnostic_history_v1';

/** A kézi napló Supabase-re küldött, QR nélküli rekordja. */
export interface DiagnosticLogRecord {
  logNumber: number;
  startedAt: string;
  createdAt: string;
  charCount?: number;
  lineCount?: number;
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

function normaliseRecord(value: any): DiagnosticLogRecord | null {
  const logNumber = Number(value?.logNumber ?? value?.log_number);
  if (!Number.isFinite(logNumber) || logNumber <= 0) return null;
  const startedAt = String(value?.startedAt ?? value?.started_at ?? value?.createdAt ?? value?.created_at ?? '');
  const createdAt = String(value?.createdAt ?? value?.created_at ?? startedAt);
  return {
    logNumber: Math.floor(logNumber),
    startedAt,
    createdAt,
    charCount: Number.isFinite(Number(value?.charCount ?? value?.char_count)) ? Number(value.charCount ?? value.char_count) : undefined,
    lineCount: Number.isFinite(Number(value?.lineCount ?? value?.line_count)) ? Number(value.lineCount ?? value.line_count) : undefined,
  };
}

function readLocalHistory(): DiagnosticLogRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normaliseRecord).filter((item): item is DiagnosticLogRecord => Boolean(item)).slice(0, 5);
  } catch {
    return [];
  }
}

export function getLocalDiagnosticHistory(): DiagnosticLogRecord[] {
  return readLocalHistory();
}

export function rememberDiagnosticLog(record: DiagnosticLogRecord): void {
  const next = [record, ...readLocalHistory().filter((item) => item.logNumber !== record.logNumber)].slice(0, 5);
  try { localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(next)); } catch { /* a TV tárhelyhibája nem akadályozhatja a küldést */ }
}

/** A kézi napló teljes tartalmának elküldése – nem készül token, URL vagy QR-kód. */
export async function sendDiagnosticLog(
  logNumber: number,
  startedAt: number,
  logText: string,
  charCount?: number,
  lineCount?: number,
): Promise<DiagnosticLogRecord> {
  const result = await request({
    action: 'send',
    logNumber,
    startedAt: new Date(startedAt).toISOString(),
    logText,
    charCount,
    lineCount,
  });
  const record = normaliseRecord(result?.record || result);
  if (!result?.ok || !record) throw new Error('A Supabase nem igazolta vissza a napló mentését.');
  rememberDiagnosticLog(record);
  return record;
}

/** Az utolsó öt napló azonosítója és ideje; tartalmat nem töltünk vissza a TV-re. */
export async function listDiagnosticLogHistory(): Promise<DiagnosticLogRecord[]> {
  const result = await request({ action: 'history' });
  const rows: unknown[] = Array.isArray(result?.records) ? result.records : [];
  const records = rows.map((row) => normaliseRecord(row)).filter((item): item is DiagnosticLogRecord => Boolean(item)).slice(0, 5);
  for (const record of records) rememberDiagnosticLog(record);
  return records;
}
