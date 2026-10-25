import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const base = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const table = base + "/rest/v1/tv_diagnostic_shares";
const MAX_LOG_CHARS = 1_000_000;
const MAX_LOG_ROWS = 5;
// A rekordot nem egyórás QR-linkhez kötjük: a legutóbbi öt napló maradjon
// további ellenőrzésre, a legrégebbit a pruneToFive törli.
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const out = (status: number, data: unknown) => new Response(JSON.stringify(data), {
  status,
  headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

const hash = async (s: string) => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
).map((b) => b.toString(16).padStart(2, "0")).join("");

async function db(path: string, init: RequestInit = {}) {
  return fetch(table + path, {
    ...init,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
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

/** Mindig a legfrissebb öt rekord maradjon; az azonosító és a teljes tartalom együtt törlődik. */
async function pruneToFive() {
  const result = await db(
    "?select=id,log_number,created_at&order=log_number.desc.nullslast,created_at.desc&limit=100",
  );
  if (!result.ok) return;
  const rows = await result.json();
  if (!Array.isArray(rows) || rows.length <= MAX_LOG_ROWS) return;
  for (const row of rows.slice(MAX_LOG_ROWS)) {
    if (row?.id) await db("?id=eq." + encodeURIComponent(String(row.id)), { method: "DELETE" });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return out(405, { error: "method_not_allowed" });

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
    if (!result.ok) return out(503, { error: "history_unavailable" });
    const rows = await result.json();
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
  if (!result.ok) return out(500, { error: "send_failed" });
  const rows = await result.json();
  await pruneToFive();
  const saved = Array.isArray(rows) ? rows[0] : null;
  return out(201, {
    ok: true,
    record: {
      logNumber: Number(saved?.log_number ?? body.logNumber),
      startedAt: saved?.started_at || startedAt,
      createdAt: saved?.created_at || new Date().toISOString(),
      charCount: cleanedLog.length,
      lineCount: cleanedLog.split("\n").length,
    },
  });
});
