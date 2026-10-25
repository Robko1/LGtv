const API_URL = 'https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-diagnostic-share';
const API_KEY = 'sb_publishable_JschCWGjgSE_b0NyINwxqA_7zAnS56C';
const LOCAL_HISTORY_KEY = 'iptv_rt_diagnostic_history_v1';
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_TRANSIENT_RETRIES = 2;

/** A kézi napló Supabase-re küldött, QR nélküli rekordja. */
export interface DiagnosticLogRecord {
  logNumber: number;
  startedAt: string;
  createdAt: string;
  charCount?: number;
  lineCount?: number;
}

interface DiagnosticRequestError extends Error {
  status?: number;
  transient?: boolean;
}

function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errorText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}

/**
 * A TV-ről küldött kérés néha az Edge Function indulásakor 503-at kap.
 * Két rövid, fokozatos újrapróba kell, de a küldéshez ugyanazt a napló-
 * sorszám/kezdési idő párt használjuk, így a szerver idempotensen kezeli, ha
 * az első kérés valójában már elment, csak a válasz veszett el.
 */
async function request(body: Record<string, unknown>): Promise<any> {
  let lastError: DiagnosticRequestError | null = null;

  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
    if (attempt > 0) await wait(attempt === 1 ? 900 : 2_100);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller
      ? window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : null;

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: API_KEY,
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const raw = await response.text().catch(() => '');
      let result: any = {};
      try { result = raw ? JSON.parse(raw) : {}; } catch { result = {}; }

      if (response.ok) return result;

      const status = response.status;
      const reason = String(result?.reason || result?.message || result?.error || `HTTP ${status}`);
      const error = new Error(`HTTP ${status}: ${reason}`) as DiagnosticRequestError;
      error.status = status;
      error.transient = isTransientStatus(status);
      lastError = error;
      if (!error.transient || attempt >= MAX_TRANSIENT_RETRIES) throw error;
    } catch (cause) {
      const caught = cause as DiagnosticRequestError;
      const isAbort = caught?.name === 'AbortError';
      const isNetworkFailure = !caught?.status;
      const error = (caught instanceof Error ? caught : new Error(errorText(cause))) as DiagnosticRequestError;
      error.transient = isAbort || isNetworkFailure || Boolean(caught?.transient);
      lastError = error;
      if (!error.transient || attempt >= MAX_TRANSIENT_RETRIES) throw error;
    } finally {
      if (timeout !== null) window.clearTimeout(timeout);
    }
  }

  throw lastError || new Error('A hibakeresési szolgáltatás nem válaszolt.');
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
    // A szerver ezt a párt használja idempotencia-kulcsként is: ha a TV a
    // 503 után újraküldi ugyanazt a rekordot, nem jön létre dupla napló.
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
