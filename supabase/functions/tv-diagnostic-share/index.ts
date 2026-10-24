import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const base = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const table = base + "/rest/v1/tv_diagnostic_shares";
const MAX_LOG_CHARS = 1_000_000;
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const out = (status: number, data: unknown) => new Response(JSON.stringify(data), {
  status,
  headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))))
  .map((b) => b.toString(16).padStart(2, "0")).join("");
const valid = (s: unknown): s is string => typeof s === "string" && (/^[a-f0-9]{64}$/.test(s) || /^[A-Za-z0-9_-]{43}$/.test(s));
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
  return input.replace(/((?:password|passwd|token|authorization|api[_-]?key|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  const u = new URL(req.url);
  if (req.method === "GET") {
    const token = u.searchParams.get("t") || u.searchParams.get("token");
    if (!valid(token)) return new Response("Hibás hivatkozás.", {
      status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
    const r = await db("?token_hash=eq." + await hash(token) + "&revoked_at=is.null&expires_at=gt." +
      encodeURIComponent(new Date().toISOString()) + "&select=log_text,expires_at&limit=1");
    if (!r.ok) return new Response("A napló nem érhető el.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
    const rows = await r.json();
    if (!rows.length) return new Response("A hivatkozás lejárt vagy visszavonták.", {
      status: 410, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
    return new Response(String(rows[0].log_text), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (req.method !== "POST") return out(405, { error: "method_not_allowed" });
  let b: any;
  try { b = await req.json(); } catch { return out(400, { error: "invalid_json" }); }

  if (b?.action === "create") {
    if (typeof b.logText !== "string" || !b.logText.trim()) return out(400, { error: "log_required" });
    const cleanedLog = cleanLog(b.logText);
    if (cleanedLog.length > MAX_LOG_CHARS) return out(413, { error: "log_too_large" });
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    const binary = Array.from(randomBytes, (byte) => String.fromCharCode(byte)).join("");
    const token = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const expires = new Date(Date.now() + 3600000).toISOString();
    await db("?expires_at=lt." + encodeURIComponent(new Date().toISOString()), { method: "DELETE" });
    const r = await db("", { method: "POST", body: JSON.stringify([{
      token_hash: await hash(token), log_text: cleanedLog, expires_at: expires,
    }]) });
    if (!r.ok) return out(500, { error: "create_failed" });
    return out(201, { ok: true, url: base + "/functions/v1/tv-diagnostic-share?t=" + token, token, expiresAt: expires });
  }

  if (b?.action === "update" && valid(b.token)) {
    if (typeof b.logText !== "string" || !b.logText.trim()) return out(400, { error: "log_required" });
    const cleanedLog = cleanLog(b.logText);
    if (cleanedLog.length > MAX_LOG_CHARS) return out(413, { error: "log_too_large" });
    const tokenHash = await hash(b.token);
    const expires = new Date(Date.now() + 3600000).toISOString();
    const r = await db("?token_hash=eq." + tokenHash + "&revoked_at=is.null&expires_at=gt." +
      encodeURIComponent(new Date().toISOString()), {
        method: "PATCH",
        body: JSON.stringify({ log_text: cleanedLog, expires_at: expires }),
      });
    if (!r.ok) return out(500, { error: "update_failed" });
    const rows = await r.json();
    if (!rows.length) return out(410, { error: "share_expired" });
    return out(200, { ok: true, expiresAt: expires });
  }

  if (b?.action === "revoke" && valid(b.token)) {
    const r = await db("?token_hash=eq." + await hash(b.token) + "&revoked_at=is.null", {
      method: "PATCH", body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    });
    if (!r.ok) return out(500, { error: "revoke_failed" });
    return out(200, { ok: true });
  }
  return out(400, { error: "unknown_action" });
});