// Intentionally plain JavaScript-compatible TypeScript.
// No JSR/external imports so cold starts succeed immediately on every Supabase Edge runtime.

const DB_TIMEOUT_MS = 15_000;
const MAX_PROFILES_PER_SYNC = 60;
const MAX_EVENTS_PER_SYNC = 80;
const MAX_BOOTSTRAP_LIMIT = 600;
const DEFAULT_BOOTSTRAP_LIMIT = 400;
const MAX_DEVICE_HASHES = 25;

const PAIRING_CODE_TTL_SECONDS = 600; // 10 perc
const PAIRING_MAX_ATTEMPTS = 5;
const PAIR_REQUEST_WINDOW_MS = 10 * 60 * 1000;
const MAX_PAIR_REQUESTS_PER_DEVICE = 5;
const MAX_PAIR_REQUESTS_GLOBAL = 15;

const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 nap gördülő érvényesség
const TOKEN_ROTATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 naponta háttérbeli csendes csere
const TOKEN_RENEW_THRESHOLD_MS = 60 * 24 * 60 * 60 * 1000; // 60 nap alatt automatikus megújítás
const PREVIOUS_TOKEN_GRACE_MS = 10 * 60 * 1000; // 10 perc türelmi ablak párhuzamos kérésekhez
const LAST_SEEN_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const VALID_FORMATS = new Set(["ts", "hls"]);
const VALID_BUFFER_PROFILES = new Set([
  "fast",
  "balanced",
  "stable",
  "adaptive-1",
  "adaptive-2",
  "adaptive-3",
]);
const BUFFER_PROFILE_DEFAULT_SECONDS = {
  "fast": 1.5,
  "balanced": 3.0,
  "stable": 5.0,
  "adaptive-1": 6.5,
  "adaptive-2": 8.0,
  "adaptive-3": 10.0,
};
const VALID_EVENT_TYPES = new Set([
  "measurement",
  "diagnostic",
  "speed_test",
  "buffer_test",
  "repair_attempt",
  "repair_verified",
  "repair_exhausted",
  "freeze_detected",
]);

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-tv-device-id, x-tv-device-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function out(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const secretLabels = ["username", "user", "password", "passwd", "token", "authorization", "api_key", "apikey", "secret"];
function cleanText(input, maxLen = 180) {
  if (input === null || input === undefined) return "";
  let result = String(input).trim();
  if (!result) return "";
  for (const label of secretLabels) {
    const field = new RegExp("((?:^|[?&\\s;,(\\[{])" + label + "\\s*[:=]\\s*)([^\\s&;,\\]})]+)", "ig");
    result = result.replace(field, "$1[REDACTED]");
  }
  result = result.replace(/(https?:\/\/[^\/\s]+\/(?:live|movie|series|subtitle)\/)[^\/\s]+\/[^\/\s]+/gi, "$1[REDACTED]/[REDACTED]");
  result = result.replace(/(https?:\/\/)[^\/\s@]+:[^\/\s@]+@/gi, "$1[REDACTED]@");
  result = result.replace(/https?:\/\/[^\s]+/gi, "[URL]");
  return result.slice(0, maxLen);
}

function cleanDeviceId(input) {
  if (input === null || input === undefined) return "";
  const cleaned = String(input).trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return cleaned.length >= 6 ? cleaned : "";
}

function cleanRawToken(input) {
  if (input === null || input === undefined) return "";
  const cleaned = String(input).trim();
  if (cleaned.length < 32 || cleaned.length > 160) return "";
  if (!/^[a-zA-Z0-9_-]+$/.test(cleaned)) return "";
  return cleaned;
}

function cleanPairingCode(input) {
  if (input === null || input === undefined) return "";
  const digits = String(input).trim();
  return /^[0-9]{6}$/.test(digits) ? digits : "";
}

function cleanKey(input) {
  const raw = cleanText(input, 120).toLowerCase().replace(/[^a-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "");
  return raw.slice(0, 120);
}

function clampInt(value, min, max, fallback = null) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function clampNum(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.round(Math.max(min, Math.min(max, num)) * 100) / 100;
}

async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Short(value) {
  const full = await sha256Hex(value);
  return full.slice(0, 24);
}

function timingSafeHexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function generateSixDigitCode() {
  const buf = new Uint32Array(2);
  for (let guard = 0; guard < 16; guard++) {
    crypto.getRandomValues(buf);
    const num = (buf[0] % 900000) + 100000;
    const str = String(num).padStart(6, "0");
    if (!/^([0-9])\1{5}$/.test(str)) return str;
  }
  return String(((crypto.getRandomValues(new Uint32Array(1))[0]) % 900000) + 100000).padStart(6, "0");
}

function generateDeviceToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "tvd_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function jsonOrEmpty(response) {
  const text = await response.text();
  if (!text) return [];
  try { return JSON.parse(text); } catch (_) { return []; }
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

function mergeEwma(prev, next) {
  const p = clampInt(prev, 20, 60000, null);
  const n = clampInt(next, 20, 60000, null);
  if (p === null) return n;
  if (n === null) return p;
  return Math.round(p * 0.65 + n * 0.35);
}

function sanitizeBufferScores(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result = {};
  for (const profile of VALID_BUFFER_PROFILES) {
    const item = raw[profile];
    if (!item || typeof item !== "object") continue;
    result[profile] = {
      ok: clampInt(item.ok, 0, 100000, 0),
      fail: clampInt(item.fail, 0, 100000, 0),
      stalls: clampInt(item.stalls, 0, 100000, 0),
      avgStartupMs: clampInt(item.avgStartupMs, 20, 60000, null),
    };
  }
  return result;
}

function mergeBufferScores(existingRaw, incomingRaw) {
  const existing = sanitizeBufferScores(existingRaw);
  const incoming = sanitizeBufferScores(incomingRaw);
  const merged = { ...existing };
  for (const profile of Object.keys(incoming)) {
    const prev = merged[profile];
    const inc = incoming[profile];
    if (!prev) {
      merged[profile] = inc;
    } else {
      merged[profile] = {
        ok: Math.max(prev.ok, inc.ok),
        fail: Math.max(prev.fail, inc.fail),
        stalls: Math.max(prev.stalls, inc.stalls),
        avgStartupMs: mergeEwma(prev.avgStartupMs, inc.avgStartupMs),
      };
    }
  }
  return merged;
}

function chooseBestFormat(tsOk, tsFail, tsMs, hlsOk, hlsFail, hlsMs, fallbackFormat) {
  const tsTotal = tsOk + tsFail;
  const hlsTotal = hlsOk + hlsFail;
  if (tsTotal === 0 && hlsTotal === 0) return VALID_FORMATS.has(fallbackFormat) ? fallbackFormat : "ts";

  const tsRate = tsTotal > 0 ? (tsOk + 0.5) / (tsTotal + 1) : 0.45;
  const hlsRate = hlsTotal > 0 ? (hlsOk + 0.5) / (hlsTotal + 1) : 0.45;
  const tsSpeedBonus = tsMs ? Math.max(0, (4000 - tsMs) / 20000) : 0;
  const hlsSpeedBonus = hlsMs ? Math.max(0, (4000 - hlsMs) / 20000) : 0;

  const tsScore = tsOk > 0 ? tsRate + tsSpeedBonus : tsRate * 0.5;
  const hlsScore = hlsOk > 0 ? hlsRate + hlsSpeedBonus : hlsRate * 0.5;

  if (Math.abs(tsScore - hlsScore) < 0.04 && VALID_FORMATS.has(fallbackFormat)) {
    return fallbackFormat;
  }
  return hlsScore > tsScore ? "hls" : "ts";
}

function chooseBestBufferProfile(bufferScores, fallbackProfile) {
  const fallback = VALID_BUFFER_PROFILES.has(fallbackProfile) ? fallbackProfile : "balanced";
  let bestProfile = fallback;
  let bestScore = -Infinity;

  for (const [profile, stats] of Object.entries(bufferScores || {})) {
    if (!VALID_BUFFER_PROFILES.has(profile) || !stats) continue;
    const total = (stats.ok || 0) + (stats.fail || 0);
    if (total <= 0) continue;
    const reliability = (stats.ok || 0) / total;
    const stallPenalty = Math.min(0.6, ((stats.stalls || 0) / Math.max(1, stats.ok || 1)) * 0.28);
    const speedBonus = stats.avgStartupMs ? Math.max(0, (4500 - stats.avgStartupMs) / 18000) : 0;
    const score = reliability - stallPenalty + speedBonus;
    if (score > bestScore) {
      bestScore = score;
      bestProfile = profile;
    }
  }
  return bestProfile;
}

function computeConfidence(sampleCount, deviceCount, totalOk, totalFail, stallCount) {
  const total = Math.max(1, totalOk + totalFail);
  const successRatio = totalOk / total;
  const sampleFactor = Math.min(1, Math.log10(sampleCount + 1) / 1.6);
  const deviceFactor = Math.min(0.2, Math.max(0, deviceCount - 1) * 0.05);
  const stallPenalty = Math.min(0.35, (stallCount / Math.max(1, sampleCount)) * 0.12);
  const raw = (successRatio * 0.65 + sampleFactor * 0.35 + deviceFactor - stallPenalty) * 100;
  return clampNum(raw, 1, 100, 25);
}

function mapProfileRow(row) {
  return {
    channelKey: row.channel_key,
    channelIdHint: row.channel_id_hint || null,
    channelName: row.channel_name,
    countryCode: row.country_code || null,
    bestFormat: row.best_format,
    bestBufferProfile: row.best_buffer_profile,
    bestBufferAheadSeconds: Number(row.best_buffer_ahead_seconds || 3.0),
    tsAvgStartupMs: row.ts_avg_startup_ms,
    hlsAvgStartupMs: row.hls_avg_startup_ms,
    bestStartupMs: row.best_startup_ms,
    tsSuccessCount: Number(row.ts_success_count || 0),
    tsFailureCount: Number(row.ts_failure_count || 0),
    hlsSuccessCount: Number(row.hls_success_count || 0),
    hlsFailureCount: Number(row.hls_failure_count || 0),
    stallCount: Number(row.stall_count || 0),
    repairSuccessCount: Number(row.repair_success_count || 0),
    sampleCount: Number(row.sample_count || 1),
    deviceCount: Number(row.device_count || 1),
    bufferScores: row.buffer_scores || {},
    confidenceScore: Number(row.confidence_score || 0),
    updatedAt: row.updated_at,
  };
}

function cleanDetails(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result = {};
  const entries = Object.entries(raw).slice(0, 16);
  for (const [k, v] of entries) {
    const safeKey = cleanText(k, 40).replace(/[^a-zA-Z0-9_.-]/g, "");
    if (!safeKey) continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      result[safeKey] = Math.round(v * 100) / 100;
    } else if (typeof v === "boolean") {
      result[safeKey] = v;
    } else if (typeof v === "string") {
      result[safeKey] = cleanText(v, 140);
    }
  }
  return result;
}

export function createTvDoctorHandler(customEnv = {}) {
  const envUrl = customEnv.url ?? ((typeof Deno !== "undefined" && Deno.env) ? Deno.env.get("SUPABASE_URL") : "") ?? "";
  const envKey = customEnv.key ?? ((typeof Deno !== "undefined" && Deno.env) ? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") : "") ?? "";
  const nowFn = customEnv.nowFn || (() => Date.now());

  const profilesUrl = envUrl + "/rest/v1/tv_doctor_channel_profiles";
  const eventsUrl = envUrl + "/rest/v1/tv_doctor_events";
  const pairingCodesUrl = envUrl + "/rest/v1/tv_doctor_pairing_codes";
  const pairedDevicesUrl = envUrl + "/rest/v1/tv_doctor_paired_devices";
  const pruneRpcUrl = envUrl + "/rest/v1/rpc/prune_tv_doctor_tables";

  function configured() {
    return Boolean(envUrl && envKey);
  }

  async function rest(fullUrl, init = {}) {
    if (!configured()) throw new Error("Supabase service configuration is missing");
    const fetchImpl = customEnv.fetchFn || globalThis.fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
    try {
      return await fetchImpl(fullUrl, {
        ...init,
        signal: controller.signal,
        headers: {
          apikey: envKey,
          Authorization: "Bearer " + envKey,
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function extractAuthInputs(req, body) {
    const headerDeviceId = req.headers.get("x-tv-device-id");
    const headerToken = req.headers.get("x-tv-device-token");
    const deviceId = cleanDeviceId(headerDeviceId || (body && body.deviceId));
    const deviceToken = cleanRawToken(headerToken || (body && body.deviceToken));
    return { deviceId, deviceToken };
  }

  function attachAuthMeta(payload, auth) {
    if (!auth || !auth.rotatedDeviceToken) return payload;
    return {
      ...payload,
      rotatedDeviceToken: auth.rotatedDeviceToken,
      tokenExpiresAt: auth.tokenExpiresAt,
    };
  }

  async function authenticatePairedDevice(req, body) {
    const { deviceId, deviceToken } = extractAuthInputs(req, body);
    if (!deviceId || !deviceToken) {
      return {
        ok: false,
        response: out(401, {
          ok: false,
          paired: false,
          error: "pairing_required",
          message: "A TV nincs párosítva a védett Supabase adattárral.",
        }),
      };
    }

    const resp = await rest(
      pairedDevicesUrl + "?device_id=eq." + encodeURIComponent(deviceId) + "&select=*&limit=1",
    );
    if (!resp.ok) {
      const reason = await responseReason(resp);
      return {
        ok: false,
        response: out(resp.status >= 500 ? 503 : 502, { ok: false, error: "auth_check_failed", reason }),
      };
    }

    const rows = await jsonOrEmpty(resp);
    const deviceRow = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    if (!deviceRow) {
      return {
        ok: false,
        response: out(401, {
          ok: false,
          paired: false,
          error: "device_not_paired",
          message: "Ez a TV még nincs párosítva.",
        }),
      };
    }

    if (deviceRow.revoked === true) {
      return {
        ok: false,
        response: out(401, {
          ok: false,
          paired: false,
          error: "device_revoked",
          message: "A készülék párosítása visszavonásra került. Kérj új párosítást.",
        }),
      };
    }

    const nowMs = nowFn();
    const expiresMs = Date.parse(deviceRow.token_expires_at || "");
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      return {
        ok: false,
        response: out(401, {
          ok: false,
          paired: false,
          error: "token_expired",
          message: "A készülék tokenje lejárt. Kérj új párosítást.",
        }),
      };
    }

    const incomingHash = await sha256Hex(deviceToken);
    const matchesCurrent = timingSafeHexEqual(incomingHash, String(deviceRow.token_hash || ""));
    const graceMs = Date.parse(deviceRow.previous_token_grace_until || "");
    const matchesGrace = !matchesCurrent
      && Boolean(deviceRow.previous_token_hash)
      && Number.isFinite(graceMs)
      && graceMs > nowMs
      && timingSafeHexEqual(incomingHash, String(deviceRow.previous_token_hash || ""));

    if (!matchesCurrent && !matchesGrace) {
      return {
        ok: false,
        response: out(401, {
          ok: false,
          paired: false,
          error: "invalid_device_token",
          message: "Érvénytelen eszköztoken. Hozzáférés megtagadva.",
        }),
      };
    }

    const nowIso = new Date(nowMs).toISOString();
    const lastRotatedMs = Date.parse(deviceRow.last_rotated_at || deviceRow.paired_at || "");
    const forceRotate = Boolean(body && body.rotateToken === true);
    const dueForRotation = matchesCurrent && (
      forceRotate
      || !Number.isFinite(lastRotatedMs)
      || (nowMs - lastRotatedMs >= TOKEN_ROTATE_AFTER_MS)
      || (expiresMs - nowMs <= TOKEN_RENEW_THRESHOLD_MS)
    );

    let rotatedDeviceToken = null;
    let tokenExpiresAt = deviceRow.token_expires_at;

    if (dueForRotation) {
      const nextToken = generateDeviceToken();
      const nextHash = await sha256Hex(nextToken);
      const nextExpiresIso = new Date(nowMs + TOKEN_TTL_MS).toISOString();
      const graceIso = new Date(nowMs + PREVIOUS_TOKEN_GRACE_MS).toISOString();
      const patchResp = await rest(
        pairedDevicesUrl + "?device_id=eq." + encodeURIComponent(deviceId),
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            token_hash: nextHash,
            previous_token_hash: deviceRow.token_hash,
            previous_token_grace_until: graceIso,
            token_expires_at: nextExpiresIso,
            last_rotated_at: nowIso,
            last_seen_at: nowIso,
            rotation_count: Number(deviceRow.rotation_count || 0) + 1,
          }),
        },
      );
      if (patchResp.ok) {
        rotatedDeviceToken = nextToken;
        tokenExpiresAt = nextExpiresIso;
      }
    } else {
      const lastSeenMs = Date.parse(deviceRow.last_seen_at || "");
      if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs >= LAST_SEEN_TOUCH_INTERVAL_MS) {
        try {
          await rest(
            pairedDevicesUrl + "?device_id=eq." + encodeURIComponent(deviceId),
            {
              method: "PATCH",
              headers: { Prefer: "return=minimal" },
              body: JSON.stringify({ last_seen_at: nowIso }),
            },
          );
        } catch (_) {
          // Best-effort touch.
        }
      }
    }

    return {
      ok: true,
      deviceId,
      pairedAt: deviceRow.paired_at,
      tokenExpiresAt,
      rotatedDeviceToken,
    };
  }

  async function handlePairRequest(body) {
    const deviceId = cleanDeviceId(body && body.deviceId);
    if (!deviceId) {
      return out(400, {
        ok: false,
        error: "invalid_device_id",
        message: "Érvénytelen eszközazonosító.",
      });
    }

    const nowMs = nowFn();
    const nowIso = new Date(nowMs).toISOString();
    const windowIso = new Date(nowMs - PAIR_REQUEST_WINDOW_MS).toISOString();

    // Kéréskorlát ellenőrzése (eszközönként és globálisan is)
    const recentResp = await rest(
      pairingCodesUrl
        + "?created_at=gt." + encodeURIComponent(windowIso)
        + "&select=id,requested_device_id"
        + "&limit=20",
    );
    if (recentResp.ok) {
      const recentRows = await jsonOrEmpty(recentResp);
      if (Array.isArray(recentRows)) {
        const deviceRecent = recentRows.filter((r) => r && r.requested_device_id === deviceId).length;
        if (deviceRecent >= MAX_PAIR_REQUESTS_PER_DEVICE || recentRows.length >= MAX_PAIR_REQUESTS_GLOBAL) {
          return out(429, {
            ok: false,
            error: "rate_limited",
            message: "Túl sok kódigénylés rövid időn belül. Kérlek várj néhány percet.",
          });
        }
      }
    }

    // Korábbi függőben lévő kódok érvénytelenítése ehhez az eszközhöz
    await rest(
      pairingCodesUrl
        + "?requested_device_id=eq." + encodeURIComponent(deviceId)
        + "&status=eq.pending",
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "superseded" }),
      },
    );

    const code = generateSixDigitCode();
    const codeSha = await sha256Hex(code);
    const expiresAt = new Date(nowMs + PAIRING_CODE_TTL_SECONDS * 1000).toISOString();

    const insertResp = await rest(pairingCodesUrl, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        pairing_code: code,
        code_sha256: codeSha,
        requested_device_id: deviceId,
        tv_model: cleanText(body && body.tvModel, 80) || null,
        webos_version: cleanText(body && body.webosVersion, 40) || null,
        app_version: cleanText(body && body.appVersion, 32) || null,
        status: "pending",
        attempt_count: 0,
        max_attempts: PAIRING_MAX_ATTEMPTS,
        expires_at: expiresAt,
        created_at: nowIso,
      }),
    });

    if (!insertResp.ok) {
      const reason = await responseReason(insertResp);
      return out(insertResp.status >= 500 ? 503 : 502, {
        ok: false,
        error: "pair_request_failed",
        reason,
      });
    }

    // Kód SOHA nem szerepel a nyilvános válaszban!
    return out(200, {
      ok: true,
      requested: true,
      deviceId,
      expiresAt,
      expiresInSeconds: PAIRING_CODE_TTL_SECONDS,
      maxAttempts: PAIRING_MAX_ATTEMPTS,
      serverTime: nowIso,
    });
  }

  async function handlePairVerify(body) {
    const deviceId = cleanDeviceId(body && body.deviceId);
    const code = cleanPairingCode(body && body.code);
    if (!deviceId) {
      return out(400, {
        ok: false,
        error: "invalid_device_id",
        message: "Érvénytelen eszközazonosító.",
      });
    }
    if (!code) {
      return out(400, {
        ok: false,
        error: "invalid_code_format",
        message: "A párosítási kód pontosan 6 számjegyből állhat.",
      });
    }

    const nowMs = nowFn();
    const nowIso = new Date(nowMs).toISOString();

    const pendingResp = await rest(
      pairingCodesUrl
        + "?status=eq.pending&order=created_at.desc&limit=10&select=*",
    );
    if (!pendingResp.ok) {
      const reason = await responseReason(pendingResp);
      return out(pendingResp.status >= 500 ? 503 : 502, {
        ok: false,
        error: "pair_verify_failed",
        reason,
      });
    }

    const pendingRows = await jsonOrEmpty(pendingResp);
    const candidates = (Array.isArray(pendingRows) ? pendingRows : []).filter((row) => {
      if (!row) return false;
      const target = String(row.requested_device_id || "*");
      return target === deviceId || target === "*" || target.toLowerCase() === "any";
    });

    if (candidates.length === 0) {
      return out(401, {
        ok: false,
        error: "no_active_code",
        message: "Nincs aktív párosítási kód. Nyomd meg az Új kód igénylése gombot.",
      });
    }

    // Legfrissebb aktív kód kiválasztása ehhez az eszközhöz (saját eszközkód előnyben a '*' általános kóddal szemben)
    const activeRow = candidates.find((r) => r.requested_device_id === deviceId) || candidates[0];
    const expMs = Date.parse(activeRow.expires_at || "");
    if (!Number.isFinite(expMs) || expMs <= nowMs) {
      await rest(pairingCodesUrl + "?id=eq." + encodeURIComponent(activeRow.id), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "expired" }),
      });
      return out(401, {
        ok: false,
        error: "code_expired",
        message: "A párosítási kód lejárt. Kérj új kódot.",
      });
    }

    const currentAttempts = Number(activeRow.attempt_count || 0);
    const maxAttempts = Math.max(1, Number(activeRow.max_attempts || PAIRING_MAX_ATTEMPTS));
    if (currentAttempts >= maxAttempts) {
      await rest(pairingCodesUrl + "?id=eq." + encodeURIComponent(activeRow.id), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "locked" }),
      });
      return out(429, {
        ok: false,
        error: "code_locked",
        remainingAttempts: 0,
        message: "Túl sok hibás próbálkozás. A kód zárolva lett, kérj új kódot.",
      });
    }

    const submittedHash = await sha256Hex(code);
    const isMatch = timingSafeHexEqual(submittedHash, String(activeRow.code_sha256 || ""));

    if (!isMatch) {
      const nextAttempts = currentAttempts + 1;
      const lockedNow = nextAttempts >= maxAttempts;
      await rest(pairingCodesUrl + "?id=eq." + encodeURIComponent(activeRow.id), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          attempt_count: nextAttempts,
          ...(lockedNow ? { status: "locked" } : {}),
        }),
      });
      const remainingAttempts = Math.max(0, maxAttempts - nextAttempts);
      return out(lockedNow ? 429 : 401, {
        ok: false,
        error: lockedNow ? "code_locked" : "invalid_code",
        remainingAttempts,
        message: lockedNow
          ? "Túl sok hibás próbálkozás. A kód zárolva lett, kérj új kódot."
          : `Hibás párosítási kód (${remainingAttempts} próbálkozás maradt).`,
      });
    }

    // Egyszer használatos kód atomikus felhasználása (status=eq.pending feltétellel)
    const consumeResp = await rest(
      pairingCodesUrl + "?id=eq." + encodeURIComponent(activeRow.id) + "&status=eq.pending",
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          status: "used",
          attempt_count: currentAttempts + 1,
          used_at: nowIso,
          used_by_device_id: deviceId,
        }),
      },
    );
    if (!consumeResp.ok) {
      const reason = await responseReason(consumeResp);
      return out(consumeResp.status >= 500 ? 503 : 502, {
        ok: false,
        error: "code_consume_failed",
        reason,
      });
    }
    const consumedRows = await jsonOrEmpty(consumeResp);
    if (!Array.isArray(consumedRows) || consumedRows.length === 0) {
      return out(401, {
        ok: false,
        error: "code_already_used",
        message: "Ezt a párosítási kódot már felhasználták. Kérj új kódot.",
      });
    }

    const deviceToken = generateDeviceToken();
    const tokenHash = await sha256Hex(deviceToken);
    const tokenExpiresAt = new Date(nowMs + TOKEN_TTL_MS).toISOString();
    const tvModel = cleanText(body && body.tvModel, 80) || cleanText(activeRow.tv_model, 80) || null;
    const webosVersion = cleanText(body && body.webosVersion, 40) || cleanText(activeRow.webos_version, 40) || null;
    const appVersion = cleanText(body && body.appVersion, 32) || cleanText(activeRow.app_version, 32) || null;

    const saveDeviceResp = await rest(pairedDevicesUrl + "?on_conflict=device_id", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify([{
        device_id: deviceId,
        token_hash: tokenHash,
        previous_token_hash: null,
        previous_token_grace_until: null,
        token_expires_at: tokenExpiresAt,
        paired_at: nowIso,
        last_seen_at: nowIso,
        last_rotated_at: nowIso,
        rotation_count: 0,
        revoked: false,
        revoked_at: null,
        revoked_reason: null,
        tv_model: tvModel,
        webos_version: webosVersion,
        app_version: appVersion,
      }]),
    });

    if (!saveDeviceResp.ok) {
      const reason = await responseReason(saveDeviceResp);
      return out(saveDeviceResp.status >= 500 ? 503 : 502, {
        ok: false,
        error: "device_save_failed",
        reason,
      });
    }

    return out(200, {
      ok: true,
      paired: true,
      deviceId,
      deviceToken,
      pairedAt: nowIso,
      tokenExpiresAt,
      serverTime: nowIso,
    });
  }

  async function handlePairStatus(auth) {
    return out(200, attachAuthMeta({
      ok: true,
      paired: true,
      deviceId: auth.deviceId,
      pairedAt: auth.pairedAt,
      tokenExpiresAt: auth.tokenExpiresAt,
      serverTime: new Date(nowFn()).toISOString(),
    }, auth));
  }

  async function handlePairUnpair(auth) {
    const nowIso = new Date(nowFn()).toISOString();
    const resp = await rest(
      pairedDevicesUrl + "?device_id=eq." + encodeURIComponent(auth.deviceId),
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          revoked: true,
          revoked_at: nowIso,
          revoked_reason: "user_unpaired",
          previous_token_hash: null,
          previous_token_grace_until: null,
        }),
      },
    );
    if (!resp.ok) {
      const reason = await responseReason(resp);
      return out(resp.status >= 500 ? 503 : 502, { ok: false, error: "unpair_failed", reason });
    }
    return out(200, {
      ok: true,
      paired: false,
      deviceId: auth.deviceId,
      serverTime: nowIso,
    });
  }

  async function handleBootstrap(body, auth) {
    const limit = clampInt(body && body.limit, 1, MAX_BOOTSTRAP_LIMIT, DEFAULT_BOOTSTRAP_LIMIT);
    let query = "?select=channel_key,channel_id_hint,channel_name,country_code,best_format,best_buffer_profile,best_buffer_ahead_seconds,ts_avg_startup_ms,hls_avg_startup_ms,best_startup_ms,ts_success_count,ts_failure_count,hls_success_count,hls_failure_count,stall_count,repair_success_count,sample_count,device_count,buffer_scores,confidence_score,updated_at&order=updated_at.desc,confidence_score.desc&limit=" + limit;
    if (body && typeof body.since === "string" && Number.isFinite(Date.parse(body.since))) {
      const iso = new Date(body.since).toISOString();
      query += "&updated_at=gt." + encodeURIComponent(iso);
    }
    const response = await rest(profilesUrl + query);
    if (!response.ok) {
      const reason = await responseReason(response);
      return out(response.status >= 500 ? 503 : 502, { error: "bootstrap_failed", reason });
    }
    const rows = await jsonOrEmpty(response);
    return out(200, attachAuthMeta({
      ok: true,
      paired: true,
      profiles: Array.isArray(rows) ? rows.map(mapProfileRow) : [],
      serverTime: new Date(nowFn()).toISOString(),
    }, auth));
  }

  async function handleStatus(auth) {
    const response = await rest(profilesUrl + "?select=channel_key&limit=1", {
      headers: { Prefer: "count=exact" },
    });
    if (!response.ok) {
      const reason = await responseReason(response);
      return out(response.status >= 500 ? 503 : 502, { error: "status_failed", reason });
    }
    const range = response.headers.get("content-range") || "";
    const totalMatch = range.match(/\/(\d+)$/);
    const profileCount = totalMatch ? Number(totalMatch[1]) : 0;
    return out(200, attachAuthMeta({
      ok: true,
      paired: true,
      deviceId: auth.deviceId,
      profileCount,
      serverTime: new Date(nowFn()).toISOString(),
    }, auth));
  }

  async function handleSync(body, auth) {
    const rawProfiles = Array.isArray(body && body.profiles) ? body.profiles.slice(0, MAX_PROFILES_PER_SYNC) : [];
    const rawEvents = Array.isArray(body && body.events) ? body.events.slice(0, MAX_EVENTS_PER_SYNC) : [];
    const deviceHash = await sha256Short(auth.deviceId);
    const tvModel = cleanText(body && body.tvModel, 80) || null;
    const webosVersion = cleanText(body && body.webosVersion, 40) || null;
    const appVersion = cleanText(body && body.appVersion, 32) || null;

    let mergedProfiles = [];
    if (rawProfiles.length > 0) {
      const validIncoming = [];
      const seenKeys = new Set();
      for (const item of rawProfiles) {
        if (!item || typeof item !== "object") continue;
        const channelKey = cleanKey(item.channelKey);
        const channelName = cleanText(item.channelName, 140);
        if (!channelKey || !channelName || seenKeys.has(channelKey)) continue;
        if (channelKey.startsWith("vod:") || item.countryCode === "VOD" || item.countryCode === "SER") continue;
        seenKeys.add(channelKey);
        validIncoming.push({ ...item, channelKey, channelName });
      }

      if (validIncoming.length > 0) {
        const keyFilter = validIncoming.map((p) => '"' + p.channelKey.replace(/"/g, "") + '"').join(",");
        const existingResp = await rest(
          profilesUrl + "?channel_key=in.(" + encodeURIComponent(keyFilter) + ")&select=*",
        );
        const existingRows = existingResp.ok ? await jsonOrEmpty(existingResp) : [];
        const existingMap = new Map();
        if (Array.isArray(existingRows)) {
          for (const r of existingRows) {
            if (r && r.channel_key) existingMap.set(r.channel_key, r);
          }
        }

        const nowIso = new Date(nowFn()).toISOString();
        const upsertRows = validIncoming.map((inc) => {
          const prev = existingMap.get(inc.channelKey);
          const tsDeltaOk = clampInt(inc.tsSuccessDelta, 0, 500, null);
          const tsDeltaFail = clampInt(inc.tsFailureDelta, 0, 500, null);
          const hlsDeltaOk = clampInt(inc.hlsSuccessDelta, 0, 500, null);
          const hlsDeltaFail = clampInt(inc.hlsFailureDelta, 0, 500, null);
          const stallDelta = clampInt(inc.stallDelta, 0, 500, null);
          const repairDelta = clampInt(inc.repairSuccessDelta, 0, 500, null);

          const tsOk = prev
            ? Number(prev.ts_success_count || 0) + (tsDeltaOk !== null ? tsDeltaOk : clampInt(inc.tsSuccessCount, 0, 500, 0))
            : clampInt(inc.tsSuccessCount ?? tsDeltaOk, 0, 10000, 0);
          const tsFail = prev
            ? Number(prev.ts_failure_count || 0) + (tsDeltaFail !== null ? tsDeltaFail : clampInt(inc.tsFailureCount, 0, 500, 0))
            : clampInt(inc.tsFailureCount ?? tsDeltaFail, 0, 10000, 0);
          const hlsOk = prev
            ? Number(prev.hls_success_count || 0) + (hlsDeltaOk !== null ? hlsDeltaOk : clampInt(inc.hlsSuccessCount, 0, 500, 0))
            : clampInt(inc.hlsSuccessCount ?? hlsDeltaOk, 0, 10000, 0);
          const hlsFail = prev
            ? Number(prev.hls_failure_count || 0) + (hlsDeltaFail !== null ? hlsDeltaFail : clampInt(inc.hlsFailureCount, 0, 500, 0))
            : clampInt(inc.hlsFailureCount ?? hlsDeltaFail, 0, 10000, 0);
          const stallCount = prev
            ? Number(prev.stall_count || 0) + (stallDelta !== null ? stallDelta : clampInt(inc.stallCount, 0, 500, 0))
            : clampInt(inc.stallCount ?? stallDelta, 0, 10000, 0);
          const repairSuccessCount = prev
            ? Number(prev.repair_success_count || 0) + (repairDelta !== null ? repairDelta : clampInt(inc.repairSuccessCount, 0, 500, 0))
            : clampInt(inc.repairSuccessCount ?? repairDelta, 0, 10000, 0);

          const tsAvg = mergeEwma(prev && prev.ts_avg_startup_ms, inc.tsAvgStartupMs);
          const hlsAvg = mergeEwma(prev && prev.hls_avg_startup_ms, inc.hlsAvgStartupMs);

          const candidateBestMs = [
            clampInt(prev && prev.best_startup_ms, 20, 60000, null),
            clampInt(inc.bestStartupMs, 20, 60000, null),
            tsAvg,
            hlsAvg,
          ].filter((v) => v !== null);
          const bestStartupMs = candidateBestMs.length > 0 ? Math.min(...candidateBestMs) : null;

          const prevHashes = prev && Array.isArray(prev.device_hashes) ? prev.device_hashes.slice(0, MAX_DEVICE_HASHES) : [];
          const hashSet = new Set(prevHashes.filter((h) => typeof h === "string"));
          hashSet.add(deviceHash);
          const deviceHashes = Array.from(hashSet).slice(-MAX_DEVICE_HASHES);
          const deviceCount = Math.max(prev ? Number(prev.device_count || 1) : 1, deviceHashes.length);

          const sampleDelta = Math.max(1, (tsDeltaOk || 0) + (tsDeltaFail || 0) + (hlsDeltaOk || 0) + (hlsDeltaFail || 0));
          const sampleCount = prev
            ? Number(prev.sample_count || 1) + sampleDelta
            : Math.max(1, tsOk + tsFail + hlsOk + hlsFail);

          const mergedBufScores = mergeBufferScores(prev && prev.buffer_scores, inc.bufferScores);
          const incomingFormat = VALID_FORMATS.has(inc.bestFormat) ? inc.bestFormat : "ts";
          const bestFormat = chooseBestFormat(tsOk, tsFail, tsAvg, hlsOk, hlsFail, hlsAvg, incomingFormat);
          const incomingBufProfile = VALID_BUFFER_PROFILES.has(inc.bestBufferProfile) ? inc.bestBufferProfile : "balanced";
          const bestBufferProfile = chooseBestBufferProfile(mergedBufScores, incomingBufProfile);
          const defaultAhead = BUFFER_PROFILE_DEFAULT_SECONDS[bestBufferProfile] || 3.0;
          const bestBufferAheadSeconds = clampNum(
            inc.bestBufferAheadSeconds ?? defaultAhead,
            1.0,
            10.0,
            defaultAhead,
          );
          const confidenceScore = computeConfidence(
            sampleCount,
            deviceCount,
            tsOk + hlsOk,
            tsFail + hlsFail,
            stallCount,
          );

          return {
            channel_key: inc.channelKey,
            channel_id_hint: cleanText(inc.channelIdHint, 120) || (prev && prev.channel_id_hint) || null,
            channel_name: inc.channelName,
            country_code: cleanText(inc.countryCode, 12).toUpperCase() || (prev && prev.country_code) || null,
            best_format: bestFormat,
            best_buffer_profile: bestBufferProfile,
            best_buffer_ahead_seconds: bestBufferAheadSeconds,
            ts_avg_startup_ms: tsAvg,
            hls_avg_startup_ms: hlsAvg,
            best_startup_ms: bestStartupMs,
            ts_success_count: tsOk,
            ts_failure_count: tsFail,
            hls_success_count: hlsOk,
            hls_failure_count: hlsFail,
            stall_count: stallCount,
            repair_success_count: repairSuccessCount,
            sample_count: sampleCount,
            device_hashes: deviceHashes,
            device_count: deviceCount,
            last_tv_model: tvModel || (prev && prev.last_tv_model) || null,
            last_error_code: cleanText(inc.lastErrorCode, 48) || (prev && prev.last_error_code) || null,
            last_error_reason: cleanText(inc.lastErrorReason, 140) || (prev && prev.last_error_reason) || null,
            buffer_scores: mergedBufScores,
            confidence_score: confidenceScore,
            updated_at: nowIso,
          };
        });

        const upsertResp = await rest(profilesUrl + "?on_conflict=channel_key", {
          method: "POST",
          headers: {
            Prefer: "resolution=merge-duplicates,return=representation",
          },
          body: JSON.stringify(upsertRows),
        });
        if (!upsertResp.ok) {
          const reason = await responseReason(upsertResp);
          console.error("tv-doctor profile upsert failed", reason);
          return out(upsertResp.status >= 500 ? 503 : 502, { error: "profile_sync_failed", reason });
        }
        const savedRows = await jsonOrEmpty(upsertResp);
        if (Array.isArray(savedRows)) {
          mergedProfiles = savedRows.map(mapProfileRow);
        }
      }
    }

    let syncedEvents = 0;
    if (rawEvents.length > 0) {
      const eventRows = [];
      for (let i = 0; i < rawEvents.length; i++) {
        const ev = rawEvents[i];
        if (!ev || typeof ev !== "object") continue;
        const eventType = VALID_EVENT_TYPES.has(ev.eventType) ? ev.eventType : "diagnostic";
        const channelKey = cleanKey(ev.channelKey);
        const channelName = cleanText(ev.channelName, 140);
        if (!channelKey || !channelName || channelKey.startsWith("vod:")) continue;
        const rawUid = cleanText(ev.eventUid, 80) || `${deviceHash}-${channelKey}-${eventType}-${nowFn()}-${i}`;
        const eventUid = await sha256Short(rawUid);
        eventRows.push({
          event_uid: eventUid,
          event_type: eventType,
          channel_key: channelKey,
          channel_id: cleanText(ev.channelId, 120) || null,
          channel_name: channelName,
          device_hash: deviceHash,
          tv_model: tvModel,
          webos_version: webosVersion,
          app_version: appVersion,
          playback_format: VALID_FORMATS.has(ev.playbackFormat) ? ev.playbackFormat : null,
          buffer_profile: VALID_BUFFER_PROFILES.has(ev.bufferProfile) ? ev.bufferProfile : null,
          buffer_ahead_seconds: ev.bufferAheadSeconds != null ? clampNum(ev.bufferAheadSeconds, 1.0, 10.0, 3.0) : null,
          startup_ms: clampInt(ev.startupMs, 0, 120000, null),
          stall_ms: clampInt(ev.stallMs, 0, 300000, null),
          error_code: cleanText(ev.errorCode, 48) || null,
          error_reason: cleanText(ev.errorReason, 160) || null,
          recovered: typeof ev.recovered === "boolean" ? ev.recovered : null,
          details: cleanDetails(ev.details),
        });
      }

      if (eventRows.length > 0) {
        const evResp = await rest(eventsUrl + "?on_conflict=event_uid", {
          method: "POST",
          headers: {
            Prefer: "resolution=ignore-duplicates,return=minimal",
          },
          body: JSON.stringify(eventRows),
        });
        if (!evResp.ok) {
          const reason = await responseReason(evResp);
          console.error("tv-doctor event insert failed", reason);
        } else {
          syncedEvents = eventRows.length;
        }
      }
    }

    // Bounded table maintenance (best-effort, non-fatal).
    if (mergedProfiles.length > 0 || syncedEvents > 0) {
      try {
        await rest(pruneRpcUrl, {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ max_profiles: 2500, max_events: 2000 }),
        });
      } catch (pruneErr) {
        console.error("tv-doctor prune skipped", String(pruneErr));
      }
    }

    return out(200, attachAuthMeta({
      ok: true,
      paired: true,
      syncedProfiles: mergedProfiles.length,
      syncedEvents,
      mergedProfiles,
      serverTime: new Date(nowFn()).toISOString(),
    }, auth));
  }

  return async function handle(req) {
    if (req.method === "OPTIONS") return new Response("ok", { headers });
    if (req.method !== "POST") return out(405, { error: "method_not_allowed" });
    if (!configured()) return out(503, { error: "service_unavailable", reason: "service_configuration_missing" });

    let body;
    try {
      body = await req.json();
    } catch (_) {
      return out(400, { error: "invalid_json" });
    }

    const action = body && body.action;
    if (action === "pair_request") return await handlePairRequest(body);
    if (action === "pair_verify") return await handlePairVerify(body);

    if (
      action === "pair_status"
      || action === "pair_unpair"
      || action === "bootstrap"
      || action === "sync"
      || action === "status"
    ) {
      const auth = await authenticatePairedDevice(req, body);
      if (!auth.ok) return auth.response;
      if (action === "pair_status") return await handlePairStatus(auth);
      if (action === "pair_unpair") return await handlePairUnpair(auth);
      if (action === "bootstrap") return await handleBootstrap(body, auth);
      if (action === "sync") return await handleSync(body, auth);
      if (action === "status") return await handleStatus(auth);
    }

    return out(400, { error: "unknown_action" });
  };
}

const defaultHandler = createTvDoctorHandler();

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve(async (req) => {
    try {
      return await defaultHandler(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("tv-doctor failed", error instanceof Error ? error.stack || error.message : message);
      return out(503, { error: "service_unavailable", reason: message.slice(0, 160) });
    }
  });
}
