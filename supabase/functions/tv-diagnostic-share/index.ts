import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const base = Deno.env.get("SUPABASE_URL") || "";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const table = base + "/rest/v1/tv_diagnostic_shares";
const MAX_LOG_CHARS = 1_000_000;
const MAX_LOG_ROWS = 5;
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const DB_TIMEOUT_MS = 20_000;
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type DbResponse = Response;

const out = (status: number, data: unknown) => new Response(JSON.stringify(data), {
  status,
  headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

const hash = async (s: string) => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
).map((b) => b.toString(16).padStart(2, "0")).join("");

function configured(): boolean {
  return Boolean(base && key);
}

/** A REST-kérés időkorláttal fut; egy beragadt adatbázis-kérés nem okoz gateway 503-at. */
async function db(path: string, init: RequestInit = {}): Promise<DbResponse> {
  if (!configured()) throw new Error("Supabase service configuration is missing");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
  try {
    return await fetch(table + path, {
      ...init,
      signal: controller.signal,
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function jsonOrEmpty(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

/** A PostgREST hiba rövid, biztonságos része a TV olvasható hibaüzenetéhez. */
async function responseReason(response: Response): Promise<string> {
  try {
    const raw = await response.clone().text();
    if (!raw) return `HTTP ${response.status}`;
    const parsed = JSON.parse(raw);
    const detail = parsed?.message || parsed?.error || parsed?.code || parsed?.hint;
    return detail ? `HTTP ${response.status}: ${String(detail).slice(0, 180)}` : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function safeExceptionReason(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "database_timeout";
  if (error instanceof Error && error.name === "AbortError") return "database_timeout";
  if (error instanceof Error && /configuration is missing/i.test(error.message)) return "service_configuration_missing";
  if (error instanceof Error && error.message) return error.message.replace(/https?:\/\/[^\s]+/g, "[endpoint]").slice(0, 180);
  return "internal_service_error";
}

function cleanLog(input: string) {
  return input.replace(
    /((?:password|passwd|token|authorization|api[_-]?key|secret)\s*[:=]\s*)[^\s,;]+/gi,
    "$1[REDACTED]",
  );
}

function validLogNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validStartedAt(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function internalToken(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return hash(raw + Date.now());
}

function recordFromRow(row: any, fallbackLog: string, fallbackStartedAt: string) {
  return {
    logNumber: Number(row?.log_number),
    startedAt: row?.started_at || fallbackStartedAt,
    createdAt: row?.created_at || new Date().toISOString(),
    charCount: typeof row?.log_text === "string" ? row.log_text.length : fallbackLog.length,
    lineCount: typeof row?.log_text === "string" ? row.log_text.split("\n").length : fallbackLog.split("\n").length,
  };
}

/**
 * A 503 után újraküldött azonos napló ne duplázódjon. A sorszám + kezdési
 * idő együtt egy kézi munkamenetet azonosít; a tartalmat nem adjuk vissza a TV-re.
 */
async function findExisting(logNumber: number, startedAt: string): Promise<any | null> {
  const path = `?log_number=eq.${encodeURIComponent(String(logNumber))}` +
    `&started_at=eq.${encodeURIComponent(startedAt)}` +
    "&select=log_number,started_at,created_at,log_text&order=created_at.desc&limit=1";
  const response = await db(path);
  if (!response.ok) {
    const reason = await responseReason(response);
    console.error("diagnostic existing-record lookup failed", reason);
    throw new Error(`database lookup failed: ${reason}`);
  }
  const rows = await jsonOrEmpty(response);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** Mindig a legfrissebb öt rekord maradjon; a teljes rekord együtt törlődik. */
async function pruneToFive(): Promise<void> {
  try {
    const result = await db(
      "?select=id,log_number,created_at&order=log_number.desc.nullslast,created_at.desc&limit=100",
    );
    if (!result.ok) {
      console.error("diagnostic pruning lookup failed", result.status);
      return;
    }
    const rows = await jsonOrEmpty(result);
    if (!Array.isArray(rows) || rows.length <= MAX_LOG_ROWS) return;
    for (const row of rows.slice(MAX_LOG_ROWS)) {
      if (!row?.id) continue;
      try {
        await db("?id=eq." + encodeURIComponent(String(row.id)), { method: "DELETE" });
      } catch (error) {
        // A küldött napló már biztonságban van; a takarítási hiba nem teheti
        // 503-má az egész küldést, különben a TV újra és újra elküldené.
        console.error("diagnostic pruning delete failed", String(error));
      }
    }
  } catch (error) {
    // A pruning csak karbantartás. A sikeres INSERT válaszát mindig kiadjuk.
    console.error("diagnostic pruning unavailable", String(error));
  }
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return out(405, { error: "method_not_allowed" });
  if (!configured()) return out(503, { error: "service_unavailable" });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return out(400, { error: "invalid_json" });
  }

  if (body?.action === "history") {
    const result = await db(
      "?log_number=not.is.null&select=log_number,started_at,created_at&order=log_number.desc,created_at.desc&limit=" + MAX_LOG_ROWS,
    );
    if (!result.ok) {
      const reason = await responseReason(result);
      console.error("diagnostic history failed", reason);
      return out(result.status >= 500 ? 503 : 502, { error: "history_unavailable", reason });
    }
    const rows = await jsonOrEmpty(result);
    return out(200, {
      ok: true,
      records: Array.isArray(rows) ? rows.map((row) => ({
        logNumber: Number(row.log_number),
        startedAt: row.started_at,
        createdAt: row.created_at,
      })) : [],
    });
  }

  // `create` marad kompatibilitási alias, de az új TV-kód kizárólag `send`-et
  // használ. Egyik ág sem ad vissza URL-t, tokent vagy QR-adatot.
  if (body?.action !== "send" && body?.action !== "create") {
    return out(400, { error: "unknown_action" });
  }
  if (!validLogNumber(body.logNumber)) return out(400, { error: "log_number_required" });
  if (!validStartedAt(body.startedAt)) return out(400, { error: "started_at_required" });
  if (typeof body.logText !== "string" || !body.logText.trim()) return out(400, { error: "log_required" });

  const cleanedLog = cleanLog(body.logText);
  if (cleanedLog.length > MAX_LOG_CHARS) return out(413, { error: "log_too_large" });

  const startedAt = new Date(body.startedAt).toISOString();
  const existing = await findExisting(body.logNumber, startedAt);
  if (existing) {
    return out(200, { ok: true, record: recordFromRow(existing, cleanedLog, startedAt), duplicate: true });
  }

  const expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
  const result = await db("", {
    method: "POST",
    body: JSON.stringify([{
      // A régi tábla token_hash mezője NOT NULL; ez belső, nem kerül a TV-re
      // és nem készül belőle hivatkozás/QR-kód.
      token_hash: await hash(await internalToken()),
      log_number: body.logNumber,
      started_at: startedAt,
      log_text: cleanedLog,
      expires_at: expiresAt,
    }]),
  });
  if (!result.ok) {
    // A részleges index miatt a párhuzamos retry 409-et kaphat, miközben az
    // első kérés már elment. Ilyenkor ugyanazt a sikeres rekordot adjuk vissza.
    if (result.status === 409) {
      const duplicate = await findExisting(body.logNumber, startedAt);
      if (duplicate) return out(200, { ok: true, record: recordFromRow(duplicate, cleanedLog, startedAt), duplicate: true });
    }
    const reason = await responseReason(result);
    console.error("diagnostic insert failed", reason);
    return out(result.status >= 500 ? 503 : 502, { error: "send_failed", reason });
  }

  // Normál esetben a PostgREST return=representation válaszából dolgozunk.
  // Ha egy proxy üres 201 választ ad, még egyszer kiolvassuk ugyanazt a
  // sorszám/kezdési idő párt; így nem keletkezik hamis 503 a már mentett naplóra.
  let rows: any = await jsonOrEmpty(result);
  let saved = Array.isArray(rows) ? rows[0] : null;
  if (!saved) saved = await findExisting(body.logNumber, startedAt);
  await pruneToFive();

  return out(201, {
    ok: true,
    record: recordFromRow(saved, cleanedLog, startedAt),
  });
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (error) {
    // A korábbi függvényben egy adatbázis-/JSON-/pruning kivétel a runtime-ot
    // leállította, ezért a TV csak „HTTP 503”-at látott. Most mindig értelmes,
    // újrapróbálható JSON-válasz megy vissza.
    const reason = safeExceptionReason(error);
    console.error("tv-diagnostic-share failed", error instanceof Error ? error.stack || error.message : String(error));
    return out(503, { error: "service_unavailable", reason });
  }
});
