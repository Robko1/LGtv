// Intentionally plain JavaScript-compatible TypeScript.
// No JSR type import or advanced module-time code: this function must be able
// to start on every Supabase Edge runtime before it handles a request.
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

function out(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function hash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function configured() {
  return Boolean(base && key);
}

async function db(path, init = {}) {
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

async function jsonOrEmpty(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch (_) { return {}; }
}

async function responseReason(response) {
  try {
    const raw = await response.clone().text();
    if (!raw) return "HTTP " + response.status;
    const parsed = JSON.parse(raw);
    const detail = parsed && (parsed.message || parsed.error || parsed.code || parsed.hint);
    return detail ? "HTTP " + response.status + ": " + String(detail).slice(0, 180) : "HTTP " + response.status;
  } catch (_) {
    return "HTTP " + response.status;
  }
}

function safeExceptionReason(error) {
  const errorName = error && typeof error === "object" && "name" in error ? String(error.name || "") : "";
  if (errorName === "AbortError") return "database_timeout";
  const message = error instanceof Error ? error.message : "";
  if (message.toLowerCase().indexOf("configuration is missing") >= 0) return "service_configuration_missing";
  return message ? message.slice(0, 180) : "internal_service_error";
}

// Redact common credential fields as a second safety layer. The browser
// redacts URLs before sending, but the Edge Function must also protect itself
// if an older client or a manual request contains a raw login URL.
const secretLabels = ["username", "user", "password", "passwd", "token", "authorization", "api_key", "apikey", "secret"];
function cleanLog(input) {
  return String(input).split("\n").map((line) => {
    let result = line;
    for (const label of secretLabels) {
      const field = new RegExp("((?:^|[?&\\s;,(\\[{])" + label + "\\s*[:=]\\s*)([^\\s&;,\\]})]+)", "ig");
      result = result.replace(field, "$1[REDACTED]");
    }
    // Xtream media/subtitle paths carry user and password as two path segments.
    result = result.replace(/(https?:\/\/[^\/\s]+\/(?:live|movie|series|subtitle)\/)[^\/\s]+\/[^\/\s]+/gi, "$1[REDACTED]/[REDACTED]");
    result = result.replace(/(https?:\/\/)[^\/\s@]+:[^\/\s@]+@/gi, "$1[REDACTED]@");
    return result;
  }).join("\n");
}

function validLogNumber(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validStartedAt(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function internalToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return hash(raw + Date.now());
}

function recordFromRow(row, fallbackLog, fallbackStartedAt) {
  return {
    logNumber: Number(row && row.log_number),
    startedAt: (row && row.started_at) || fallbackStartedAt,
    createdAt: (row && row.created_at) || new Date().toISOString(),
    charCount: typeof (row && row.log_text) === "string" ? row.log_text.length : fallbackLog.length,
    lineCount: typeof (row && row.log_text) === "string" ? row.log_text.split("\n").length : fallbackLog.split("\n").length,
  };
}

async function findExisting(logNumber, startedAt) {
  const path = "?log_number=eq." + encodeURIComponent(String(logNumber)) +
    "&started_at=eq." + encodeURIComponent(startedAt) +
    "&select=log_number,started_at,created_at,log_text&order=created_at.desc&limit=1";
  const response = await db(path);
  if (!response.ok) {
    const reason = await responseReason(response);
    console.error("diagnostic existing-record lookup failed", reason);
    throw new Error("database lookup failed: " + reason);
  }
  const rows = await jsonOrEmpty(response);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function pruneToFive() {
  try {
    const result = await db("?select=id,log_number,created_at&order=log_number.desc.nullslast,created_at.desc&limit=1000");
    if (!result.ok) {
      console.error("diagnostic pruning lookup failed", result.status);
      return;
    }
    const rows = await jsonOrEmpty(result);
    if (!Array.isArray(rows) || rows.length <= MAX_LOG_ROWS) return;
    for (const row of rows.slice(MAX_LOG_ROWS)) {
      if (!row || !row.id) continue;
      try {
        await db("?id=eq." + encodeURIComponent(String(row.id)), { method: "DELETE" });
      } catch (error) {
        console.error("diagnostic pruning delete failed", String(error));
      }
    }
  } catch (error) {
    console.error("diagnostic pruning unavailable", String(error));
  }
}

async function handle(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return out(405, { error: "method_not_allowed" });
  if (!configured()) return out(503, { error: "service_unavailable", reason: "service_configuration_missing" });

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return out(400, { error: "invalid_json" });
  }

  if (body && body.action === "history") {
    // A korábbi QR-korszakból maradt sorokat is takarítsuk le akkor, ha a TV
    // csak a történetet kérdezi le, nem éppen új naplót küld.
    await pruneToFive();
    const result = await db("?log_number=not.is.null&select=log_number,started_at,created_at&order=log_number.desc,created_at.desc&limit=" + MAX_LOG_ROWS);
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

  // `create` remains a compatibility alias; the current TV uses `send`.
  if (!body || (body.action !== "send" && body.action !== "create")) return out(400, { error: "unknown_action" });
  if (!validLogNumber(body.logNumber)) return out(400, { error: "log_number_required" });
  if (!validStartedAt(body.startedAt)) return out(400, { error: "started_at_required" });
  if (typeof body.logText !== "string" || !body.logText.trim()) return out(400, { error: "log_required" });

  const cleanedLog = cleanLog(body.logText);
  if (cleanedLog.length > MAX_LOG_CHARS) return out(413, { error: "log_too_large" });

  const startedAt = new Date(body.startedAt).toISOString();
  const existing = await findExisting(body.logNumber, startedAt);
  if (existing) return out(200, { ok: true, record: recordFromRow(existing, cleanedLog, startedAt), duplicate: true });

  const result = await db("", {
    method: "POST",
    body: JSON.stringify([{
      token_hash: await hash(await internalToken()),
      log_number: body.logNumber,
      started_at: startedAt,
      log_text: cleanedLog,
      expires_at: new Date(Date.now() + RETENTION_MS).toISOString(),
    }]),
  });
  if (!result.ok) {
    if (result.status === 409) {
      const duplicate = await findExisting(body.logNumber, startedAt);
      if (duplicate) return out(200, { ok: true, record: recordFromRow(duplicate, cleanedLog, startedAt), duplicate: true });
    }
    const reason = await responseReason(result);
    console.error("diagnostic insert failed", reason);
    return out(result.status >= 500 ? 503 : 502, { error: "send_failed", reason });
  }

  const rows = await jsonOrEmpty(result);
  let saved = Array.isArray(rows) ? rows[0] : null;
  if (!saved) saved = await findExisting(body.logNumber, startedAt);
  await pruneToFive();
  return out(201, { ok: true, record: recordFromRow(saved, cleanedLog, startedAt) });
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (error) {
    const reason = safeExceptionReason(error);
    console.error("tv-diagnostic-share failed", error instanceof Error ? error.stack || error.message : String(error));
    return out(503, { error: "service_unavailable", reason });
  }
});