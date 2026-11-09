// Intentionally plain JavaScript-compatible TypeScript.
// No JSR/external imports so cold starts succeed immediately on every Supabase Edge runtime.

const DB_TIMEOUT_MS = 15_000;
const MAX_PROFILES_PER_SYNC = 100;
const MAX_BOOTSTRAP_LIMIT = 600;
const DEFAULT_BOOTSTRAP_LIMIT = 400;
const MAX_DEVICE_HASHES = 25;
const GLOBAL_LAYOUT_PROVIDER_ID = "__HU_LAYOUT_GLOBAL__";

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
  "instant",
  "turbo",
  "fast",
  "balanced",
  "stable",
  "adaptive-1",
  "adaptive-2",
  "adaptive-3",
]);
const BUFFER_PROFILE_DEFAULT_SECONDS = {
  "instant": 0.6,
  "turbo": 0.9,
  "fast": 1.5,
  "balanced": 3.0,
  "stable": 5.0,
  "adaptive-1": 6.5,
  "adaptive-2": 8.0,
  "adaptive-3": 10.0,
};
/* 2.5.294: csatornánként legfeljebb ennyi tanult útvonalat őrzünk. */
const MAX_CHANNEL_ROUTES = 8;
/* 2.5.294: a felhő csak a magyar csatornák tudását tárolja. */
const ALLOWED_COUNTRY_CODE = "HU";

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

/*
 * 2.5.394 – STABIL NÉVKULCS A MENTETT ELRENDEZÉSBŐL.
 *
 * A tv_channel_layout_snapshots csatorna-ID-je a MENTÉS pillanatának
 * provider-listájához tartozik (`live-qr_<A>-...`). Egy újrajelentkezés /
 * IPK-restart után a TV ugyanazokat a csatornákat MÁS prefixszel kapja
 * (`live-qr_<B>-...`). A #35–38 naplókban emiatt a Supabase `sync` és
 * `bootstrap` minden magyar profilt eldobott, a TV pedig 0/80-at mutatott.
 *
 * A név (`[hu] bbc earth uhd|lc-827`) viszont stabil: ugyanazt a
 * `hu:bbc-earth-uhd` kulcsot adja, mint a kliens
 * `normalizeChannelDoctorKey()` függvénye. EZT használjuk a körhöz.
 */
function layoutChannelKey(nameKey) {
  const raw = String(nameKey || "").split("|")[0].trim().toLowerCase();
  if (!raw) return "";
  let country = "";
  let name = raw;
  const bracket = raw.match(/^\s*\[([a-z]{2,4})\]\s*(.+)$/);
  if (bracket) { country = bracket[1]; name = bracket[2]; }
  else {
    const prefix = raw.match(/^\s*([a-z]{2,3})\s*[|:-]\s*(.+)$/);
    if (prefix) { country = prefix[1]; name = prefix[2]; }
  }
  const slug = name
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 88);
  if (!slug) return "";
  return (country ? country.slice(0, 4) + ":" : "") + slug;
}

function layoutChannelName(nameKey, fallback) {
  const raw = String(nameKey || "").split("|")[0].trim();
  const cleaned = raw.replace(/^\s*\[[a-z]{2,4}\]\s*/i, "").trim();
  return cleaned ? "[HU] " + cleaned.toUpperCase() : String(fallback || "");
}

function clampInt(value, min, max, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function clampNum(value, min, max, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
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
  const pRaw = clampInt(prev, 21, 60000, null);
  const nRaw = clampInt(next, 21, 60000, null);
  const p = typeof prev === "number" && prev <= 20 ? null : pRaw;
  const n = typeof next === "number" && next <= 20 ? null : nRaw;
  if (p === null) return n;
  if (n === null) return p;
  return Math.round(p * 0.55 + n * 0.45);
}

function sanitizeBufferScores(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result = {};
  for (const profile of VALID_BUFFER_PROFILES) {
    const item = raw[profile];
    if (!item || typeof item !== "object") continue;
    const ok = clampInt(item.ok, 0, 100000, 0);
    const avgRaw = ok > 0 && typeof item.avgStartupMs === "number" && item.avgStartupMs > 20
      ? clampInt(item.avgStartupMs, 21, 60000, null)
      : null;
    result[profile] = {
      ok,
      fail: clampInt(item.fail, 0, 100000, 0),
      stalls: clampInt(item.stalls, 0, 100000, 0),
      avgStartupMs: avgRaw,
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
      const ok = Math.max(prev.ok, inc.ok);
      merged[profile] = {
        ok,
        fail: Math.max(prev.fail, inc.fail),
        stalls: Math.max(prev.stalls, inc.stalls),
        avgStartupMs: ok > 0 ? mergeEwma(prev.avgStartupMs, inc.avgStartupMs) : null,
      };
    }
  }
  return merged;
}

/**
 * 2.5.294: a tanult útvonalak (formátum + pufferprofil) tisztítása.
 * Csak ellenőrzött formátum/puffer és korlátozott számok maradhatnak meg –
 * URL, jelszó vagy csatornanév soha nem kerül ide.
 */
function sanitizeRoutes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw.slice(0, MAX_CHANNEL_ROUTES * 2)) {
    if (!item || typeof item !== "object") continue;
    const format = String(item.format || "");
    const bufferProfile = String(item.bufferProfile || "");
    if (!VALID_FORMATS.has(format) || !VALID_BUFFER_PROFILES.has(bufferProfile)) continue;
    const id = format + ":" + bufferProfile;
    if (seen.has(id)) continue;
    seen.add(id);
    const num = (value, max) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) return 0;
      return Math.min(max, Math.round(parsed));
    };
    const avg = Number(item.avgStartupMs);
    const best = Number(item.bestStartupMs);
    const lastOkAt = Number(item.lastOkAt);
    const lastFailAt = Number(item.lastFailAt);
    out.push({
      format,
      bufferProfile,
      ok: num(item.ok, 100000),
      fail: num(item.fail, 100000),
      stalls: num(item.stalls, 100000),
      avgStartupMs: Number.isFinite(avg) && avg > 20 ? Math.min(60000, Math.round(avg)) : null,
      bestStartupMs: Number.isFinite(best) && best > 20 ? Math.min(60000, Math.round(best)) : null,
      lastOkAt: Number.isFinite(lastOkAt) && lastOkAt > 0 ? Math.round(lastOkAt) : null,
      lastFailAt: Number.isFinite(lastFailAt) && lastFailAt > 0 ? Math.round(lastFailAt) : null,
    });
  }
  return out;
}

/*
 * 2.5.386 – AZ ÚTVONAL-ÉRTÉKELÉS MOSTANTÓL AZ UTOLSÓ KIMENETELT IS SZÁMOLJA.
 *
 * Éles eset (TLC): a tanult profilban a HLS útvonal 1 siker / 1 hiba mellett az
 * élen maradt (0,756 pont), a TS pedig 2 siker / 3 hiba mellett hátraszorult
 * (0,694) – holott a legutóbbi próbák sorrendje ez volt: HLS HIBA (17:20:52),
 * majd TS SIKER (17:20:58). A Doktor emiatt újra HLS-sel indított, az megint
 * hibázott, és a javítási létra a működő csatornát is „nem elérhető” felé
 * vitte. Mostantól:
 *   • ha az utolsó kimenetel HIBA volt, az útvonal 0,25 pontot veszít,
 *   • ha az utolsó kimenetel siker, 0,03 pontot kap.
 */
function routeScore(route) {
  const ok = Math.max(0, route.ok || 0);
  const fail = Math.max(0, route.fail || 0);
  const total = ok + fail;
  if (total <= 0 || ok <= 0) return -1;
  const reliability = ok / total;
  const stallPenalty = Math.min(0.8, ((route.stalls || 0) / Math.max(1, ok)) * 0.45);
  const speed = route.avgStartupMs && route.avgStartupMs > 20 ? Math.max(0, (4200 - route.avgStartupMs) / 9500) : 0;
  const lastOkAt = Number(route.lastOkAt) || 0;
  const lastFailAt = Number(route.lastFailAt) || 0;
  const failedLast = lastFailAt > lastOkAt;
  const recencyPenalty = failedLast ? 0.25 : 0;
  const recencyBonus = !failedLast && lastOkAt > 0 ? 0.03 : 0;
  return reliability - stallPenalty + speed + recencyBonus - recencyPenalty;
}

/** A legjobb 8 útvonal megtartása (a „sosem sikerült” sorok esnek ki először). */
function rankRoutes(routes) {
  const sorted = [...routes].sort((a, b) => {
    const aPure = a.ok > 0 ? 0 : 1;
    const bPure = b.ok > 0 ? 0 : 1;
    if (aPure !== bPure) return aPure - bPure;
    return routeScore(b) - routeScore(a);
  });
  return sorted.slice(0, MAX_CHANNEL_ROUTES);
}

function mergeRoutes(existingRaw, incomingRaw) {
  const byId = new Map();
  for (const route of sanitizeRoutes(existingRaw)) byId.set(route.format + ":" + route.bufferProfile, route);
  for (const route of sanitizeRoutes(incomingRaw)) {
    const id = route.format + ":" + route.bufferProfile;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, route);
      continue;
    }
    byId.set(id, {
      ...prev,
      ok: Math.max(prev.ok, route.ok),
      fail: Math.max(prev.fail, route.fail),
      stalls: Math.max(prev.stalls, route.stalls),
      avgStartupMs: prev.avgStartupMs === null
        ? route.avgStartupMs
        : (route.avgStartupMs === null ? prev.avgStartupMs : Math.min(prev.avgStartupMs, route.avgStartupMs)),
      bestStartupMs: prev.bestStartupMs === null
        ? route.bestStartupMs
        : (route.bestStartupMs === null ? prev.bestStartupMs : Math.min(prev.bestStartupMs, route.bestStartupMs)),
      lastOkAt: Math.max(prev.lastOkAt || 0, route.lastOkAt || 0) || null,
      lastFailAt: Math.max(prev.lastFailAt || 0, route.lastFailAt || 0) || null,
    });
  }
  return rankRoutes([...byId.values()]);
}

function chooseBestFormat(tsOk, tsFail, tsMs, hlsOk, hlsFail, hlsMs, fallbackFormat) {
  const tsTotal = tsOk + tsFail;
  const hlsTotal = hlsOk + hlsFail;
  if (tsTotal === 0 && hlsTotal === 0) return VALID_FORMATS.has(fallbackFormat) ? fallbackFormat : "ts";
  if (tsOk === 0 && hlsOk > 0) return "hls";
  if (hlsOk === 0 && tsOk > 0) return "ts";
  if (tsOk === 0 && hlsOk === 0) {
    if (tsFail !== hlsFail) return tsFail < hlsFail ? "ts" : "hls";
    return VALID_FORMATS.has(fallbackFormat) ? fallbackFormat : "ts";
  }

  const tsRate = (tsOk + 0.5) / (tsTotal + 1);
  const hlsRate = (hlsOk + 0.5) / (hlsTotal + 1);
  const tsSpeedBonus = tsMs && tsMs > 20 ? Math.max(0, (4200 - tsMs) / 9500) : 0;
  const hlsSpeedBonus = hlsMs && hlsMs > 20 ? Math.max(0, (4200 - hlsMs) / 9500) : 0;

  const tsScore = tsRate + tsSpeedBonus;
  const hlsScore = hlsRate + hlsSpeedBonus;

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
    routes: sanitizeRoutes(row.routes),
    confidenceScore: Number(row.confidence_score || 0),
    updatedAt: row.updated_at,
  };
}

export function createTvDoctorHandler(customEnv = {}) {
  const envUrl = customEnv.url ?? ((typeof Deno !== "undefined" && Deno.env) ? Deno.env.get("SUPABASE_URL") : "") ?? "";
  const envKey = customEnv.key ?? ((typeof Deno !== "undefined" && Deno.env) ? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") : "") ?? "";
  const nowFn = customEnv.nowFn || (() => Date.now());

  const profilesUrl = envUrl + "/rest/v1/tv_doctor_channel_profiles";
  const eventsUrl = envUrl + "/rest/v1/tv_doctor_events";
  const layoutSnapshotsUrl = envUrl + "/rest/v1/tv_channel_layout_snapshots";
  const baselinesUrl = envUrl + "/rest/v1/tv_doctor_channel_baselines";
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

  async function loadHungarianChannelScope(deviceId) {
    const url = layoutSnapshotsUrl
      + "?device_id=eq." + encodeURIComponent(deviceId)
      + "&provider_id=eq." + encodeURIComponent(GLOBAL_LAYOUT_PROVIDER_ID)
      + "&select=snapshot,updated_at&limit=1";
    const response = await rest(url);
    if (!response.ok) throw new Error("hungarian_channel_scope_read_failed");
    const rows = await jsonOrEmpty(response);
    const row = Array.isArray(rows) ? rows[0] : null;
    const snapshot = row && row.snapshot;
    if (!snapshot || !Array.isArray(snapshot.channelOrder) || !Array.isArray(snapshot.fingerprintOrder)) {
      throw new Error("hungarian_channel_scope_not_saved");
    }
    const fingerprintById = new Map();
    for (const item of snapshot.fingerprintOrder) {
      if (item && typeof item.id === "string") fingerprintById.set(item.id, item);
    }
    const ids = [];
    const keys = new Set();
    const layoutChannels = [];
    const seen = new Set();
    const exactHungarianIds = Array.isArray(snapshot.hungarianChannelIds)
      ? new Set(snapshot.hungarianChannelIds.map((id) => cleanText(id, 120)).filter(Boolean))
      : null;
    for (const rawId of snapshot.channelOrder) {
      const id = cleanText(rawId, 120);
      if (!id || seen.has(id)) continue;
      const item = fingerprintById.get(id);
      if (!item) continue;
      let isHungarian = exactHungarianIds
        ? exactHungarianIds.has(id)
        : false;
      if (!exactHungarianIds) {
        const code = cleanText(item.countryCode, 12).toUpperCase();
        const category = cleanText(item.categoryName, 100).toLowerCase();
        const nameKey = cleanText(item.nameKey, 220).toLowerCase();
        isHungarian = code
          ? code === "HU"
          : (/magyarország|hungary|hungarian/.test(category)
            || /^\s*\[hu\]\s*/.test(nameKey)
            || /^\s*hu\s*[-|:]\s*/.test(nameKey)
            || /\|lc-827$/.test(nameKey));
      }
      if (!isHungarian) continue;
      seen.add(id);
      ids.push(id);
      /* 2.5.394: a MENTETT SORREND + stabil névkulcs megy vissza a TV-re,
         így `Memória: 0` / IPK-restart után a TV pontosan azt mutatja,
         ami a Supabase-en van (a régi ID-k már nem egyeznek). */
      const key = layoutChannelKey(item.nameKey);
      if (key) keys.add(key);
      layoutChannels.push({
        id,
        nameKey: cleanText(item.nameKey, 220),
        channelKey: key,
        name: layoutChannelName(item.nameKey, id),
        position: layoutChannels.length + 1,
      });
    }
    return { ids, keys, layoutChannels, updatedAt: row.updated_at || null };
  }


  // A TV Doktor négy eseménykategóriájában eszközönként legfeljebb 8 rekord marad.
  // Kizárólag a tv_doctor_events táblát érinti; profilok, párosítás és csatornaelrendezés nem.
  async function pruneDeviceDoctorEvents(deviceHash) {
    const types = "measurement,diagnostic,speed_test,buffer_test,repair_attempt,repair_verified,repair_exhausted,freeze_detected,channel_dead";
    const response = await rest(eventsUrl
      + "?select=event_uid,details,channel_key,channel_id"
      + "&device_hash=eq." + encodeURIComponent(deviceHash)
      + "&event_type=in.(" + types + ")"
      + "&order=created_at.desc&limit=5000");
    if (!response.ok) throw new Error("doctor_event_limit_read_failed");
    const rows = await jsonOrEmpty(response);
    const counts = new Map();
    const removeIds = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const outer = row && row.details;
      const inner = outer && outer.details && typeof outer.details === "object" ? outer.details : {};
      const category = outer && outer.category;
      if (!["learning", "assistance", "activation", "channel_error"].includes(category)) continue;
      const channelKey = String(row.channel_key || row.channel_id || "");
      if (!channelKey) continue;
      /* 2.5.405 / #50: a 16 különböző formátum/puffer újracsatlakozási
         variáns KÜLÖN keretet kap; a 8-as korlát a 8 tanulási dobozé, nem a
         `tv_doctor_events` javítási lépéseié. A #50-ben már volt 3/16 sor. */
      const isVariant = inner.recoveryVariant === true || (outer && outer.recoveryVariant === true);
      const key = channelKey + "|" + category + (isVariant ? "|variant" : "");
      const cap = isVariant ? 16 : 8;
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (count > cap && row.event_uid) removeIds.push(String(row.event_uid));
    }
    for (let offset = 0; offset < removeIds.length; offset += 100) {
      const batch = removeIds.slice(offset, offset + 100);
      const deleteResponse = await rest(eventsUrl
        + "?event_uid=in.(" + encodeURIComponent(batch.join(",")) + ")"
        + "&device_hash=eq." + encodeURIComponent(deviceHash), {
          method: "DELETE",
          headers: { Prefer: "return=minimal" },
        });
      if (!deleteResponse.ok) throw new Error("doctor_event_limit_delete_failed");
    }
    return { deleted: removeIds.length };
  }

  async function handleBootstrap(body, auth) {
    const limit = clampInt(body && body.limit, 1, MAX_BOOTSTRAP_LIMIT, DEFAULT_BOOTSTRAP_LIMIT);
    let query = "?select=channel_key,channel_id_hint,channel_name,country_code,best_format,best_buffer_profile,best_buffer_ahead_seconds,ts_avg_startup_ms,hls_avg_startup_ms,best_startup_ms,ts_success_count,ts_failure_count,hls_success_count,hls_failure_count,stall_count,repair_success_count,sample_count,device_count,buffer_scores,routes,confidence_score,updated_at&order=updated_at.desc,confidence_score.desc&limit=" + limit;
    if (body && typeof body.since === "string" && Number.isFinite(Date.parse(body.since))) {
      const iso = new Date(body.since).toISOString();
      query += "&updated_at=gt." + encodeURIComponent(iso);
    }
    const scope = await loadHungarianChannelScope(auth.deviceId);
    const allowed = new Set(scope.ids);
    const allowedKeys = scope.keys;
    const response = await rest(profilesUrl + query);
    if (!response.ok) {
      const reason = await responseReason(response);
      return out(response.status >= 500 ? 503 : 502, { error: "bootstrap_failed", reason });
    }
    const rows = await jsonOrEmpty(response);
    const scopedRows = (Array.isArray(rows) ? rows : []).filter((row) => {
      if (!row) return false;
      const hint = String(row.channel_id_hint || "");
      const key = String(row.channel_key || "").toLowerCase();
      return (hint && allowed.has(hint)) || allowedKeys.has(key);
    });
    /* 2.5.394: az 1-es, megváltoztathatatlan alapbeállításokat a bootstrap
       is visszaadja. Ezeket a `reset_memory` NEM törli, tehát nullázás
       után azonnal visszaállnak a TV-n (tv -> Supabase -> tv kör). */
    let baselines = [];
    try {
      const baselineResponse = await rest(baselinesUrl
        + "?device_id=eq." + encodeURIComponent(auth.deviceId)
        + "&select=channel_key,channel_id_hint,channel_name,baseline,created_at&limit=600");
      if (baselineResponse.ok) {
        const baselineRows = await jsonOrEmpty(baselineResponse);
        baselines = (Array.isArray(baselineRows) ? baselineRows : [])
          .filter((b) => b && b.channel_key && b.baseline && b.baseline.slot === 1)
          .map((b) => ({
            channel_key: b.channel_key,
            channel_id_hint: b.channel_id_hint || null,
            channel_name: b.channel_name || b.channel_key,
            baseline: b.baseline,
            created_at: b.created_at || null,
          }));
      }
    } catch { /* az alapok hiánya nem akadályozhatja a bootstrapt */ }
    const deviceHash = await sha256Short(auth.deviceId);
    await pruneDeviceDoctorEvents(deviceHash);
    const eventResponse = await rest(eventsUrl
      + "?select=event_uid,event_type,channel_key,channel_id,channel_name,details,recovered,created_at"
      + "&device_hash=eq." + encodeURIComponent(deviceHash)
      + "&event_type=in.(measurement,diagnostic,speed_test,buffer_test,repair_attempt,repair_verified,repair_exhausted,freeze_detected,channel_dead)"
      + "&order=created_at.desc&limit=256");
    if (!eventResponse.ok) {
      const reason = await responseReason(eventResponse);
      return out(eventResponse.status >= 500 ? 503 : 502, { error: "bootstrap_events_failed", reason });
    }
    const eventRows = await jsonOrEmpty(eventResponse);
    const allowedEvents = (Array.isArray(eventRows) ? eventRows : []).filter((row) => {
      if (!row) return false;
      const id = String(row.channel_id || "");
      const key = String(row.channel_key || "").toLowerCase();
      return (id && allowed.has(id)) || allowedKeys.has(key);
    });
    const events = allowedEvents.map((row) => ({
      eventUid: row.event_uid,
      category: row.details && row.details.category,
      level: row.details && row.details.level,
      message: row.details && row.details.message,
      channelKey: row.channel_key,
      channelName: row.channel_name,
      at: Date.parse(row.created_at),
      eventType: row.event_type,
      recovered: row.recovered,
      /* 2.5.405 / #50: a kliens a BEÁGYAZOTT `details.details`-be írja a
         variáns-jelzőt, de régebbi / külső írók a felső `details`-be is
         tehették. Mindkét alakot egységesítjük, hogy a bootstrap 16-os
         kerete akkor is éljen, ha csak a külső szinten van jelző. */
      details: (() => {
        const outer: Record<string, any> = row.details && typeof row.details === "object" ? row.details : {};
        const inner: Record<string, any> = outer.details && typeof outer.details === "object" ? outer.details : {};
        const merged: Record<string, any> = { ...inner };
        if (inner.recoveryVariant !== true && outer.recoveryVariant === true) merged.recoveryVariant = true;
        if (inner.maxSteps === undefined && outer.maxSteps !== undefined) merged.maxSteps = outer.maxSteps;
        if (inner.step === undefined && outer.step !== undefined) merged.step = outer.step;
        return merged;
      })(),
    })).filter((event) => ["learning", "assistance", "activation", "channel_error"].includes(event.category));
    /* 2.5.405 / #50: a 16 variánsos `repair_attempt` sorok nem fértek el a
       kategóriánkénti 8-as bootstrap-keretben, ezért IPK-újraindítás után csak
       az első 8 próba jött vissza. A hagyományos eseményeké marad 8, a
       `recoveryVariant` soroké külön 16. */
    const newestByCategory = {};
    for (const event of events) {
      if (!newestByCategory[event.category]) {
        newestByCategory[event.category] = { normal: [], variants: [] };
      }
      const bucket = newestByCategory[event.category];
      const isVariant = event.details && event.details.recoveryVariant === true;
      const target = isVariant ? bucket.variants : bucket.normal;
      const cap = isVariant ? 16 : 8;
      if (target.length < cap) target.push(event);
    }
    const recentEvents = Object.values(newestByCategory)
      .flatMap((bucket) => [...bucket.normal, ...bucket.variants]);
    return out(200, attachAuthMeta({
      ok: true,
      paired: true,
      events: recentEvents,
      profiles: scopedRows.map(mapProfileRow),
      channelIds: scope.ids,
      channelKeys: Array.from(scope.keys),
      channelCount: scope.layoutChannels.length,
      layoutChannels: scope.layoutChannels,
      baselines,
      layoutUpdatedAt: scope.updatedAt,
      serverTime: new Date(nowFn()).toISOString(),
    }, auth));
  }

  async function handleResetMemory(auth) {
    // Kizárólag a TV Doktor tanult adatait töröljük. A párosítási táblák,
    // a párosítási kódok és a kézzel mentett csatornaelrendezés érintetlen marad.
    const eventsDelete = await rest(eventsUrl + "?event_uid=not.is.null", {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
    if (!eventsDelete.ok) {
      const reason = await responseReason(eventsDelete);
      return out(eventsDelete.status >= 500 ? 503 : 502, { ok: false, error: "reset_events_failed", reason });
    }
    const profilesDelete = await rest(profilesUrl + "?channel_key=not.is.null", {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
    if (!profilesDelete.ok) {
      const reason = await responseReason(profilesDelete);
      return out(profilesDelete.status >= 500 ? 503 : 502, { ok: false, error: "reset_profiles_failed", reason });
    }
    return out(200, attachAuthMeta({
      ok: true,
      paired: true,
      reset: true,
      deleted: ["tv_doctor_events", "tv_doctor_channel_profiles"],
      /* 2.5.394: a kézzel elmentett csatornaelrendezés ÉS az 1-es alapok
         NEM törlődnek – ezek a nullázás utáni visszaállás forrásai. */
      layoutPreserved: true,
      baselinesPreserved: true,
      preserved: ["tv_channel_layout_snapshots", "tv_doctor_channel_baselines"],
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
    // A régi IPK-k tanulási adatai nem keveredhetnek az új, tiszta memóriába.
    if (Number(body && body.doctorSchemaVersion) !== 2) {
      return out(409, { error: "doctor_schema_version_required", requiredVersion: 2 });
    }
    const scope = await loadHungarianChannelScope(auth.deviceId);
    const allowedChannelIds = new Set(scope.ids);
    const allowedChannelKeys = scope.keys;
    const rawProfiles = Array.isArray(body && body.profiles) ? body.profiles.slice(0, MAX_PROFILES_PER_SYNC) : [];
    const rawEvents = Array.isArray(body && body.events) ? body.events.slice(0, 32) : [];
    const deviceHash = await sha256Short(auth.deviceId);
    const tvModel = cleanText(body && body.tvModel, 80) || null;
    const webosVersion = cleanText(body && body.webosVersion, 40) || null;
    const appVersion = cleanText(body && body.appVersion, 32) || null;

    let mergedProfiles = [];
    /* 2.5.294: a most szinkronizált magyar csatornák kulcsai (esemény-szűréshez). */
    if (rawProfiles.length > 0) {
      const validIncoming = [];
      const seenKeys = new Set();
      for (const item of rawProfiles) {
        if (!item || typeof item !== "object") continue;
        const channelKey = cleanKey(item.channelKey);
        const channelName = cleanText(item.channelName, 140);
        if (!channelKey || !channelName || seenKeys.has(channelKey)) continue;
        if (channelKey.startsWith("vod:") || item.countryCode === "VOD" || item.countryCode === "SER") continue;
        const channelIdHint = cleanText(item.channelIdHint, 120);
        /*
         * 2.5.394: a TV aktuális csatorna-ID-je a mentett elrendezés óta
         * megváltozhatott (új `live-qr_<timestamp>` prefix). Ilyenkor a
         * STABIL NÉVKULCS dönt – különben a TV hiába tanul és küld fel
         * adatot, a Supabase profiltáblája örökre 0 marad (#35–38).
         */
        const idMatches = Boolean(channelIdHint && allowedChannelIds.has(channelIdHint));
        /* Csak a MENTETT magyar csatorna tanulhat: a névkulcsnak szerepelnie
           kell a kézzel elmentett elrendezésben. Egy tetszőleges `hu:` prefix
           önmagában NEM jogosít tanulásra. */
        const keyMatches = allowedChannelKeys.has(channelKey);
        if (!idMatches && !keyMatches) continue;
        if (!channelIdHint && !keyMatches) continue;
        // A mentett magyar lista névkulcsa a döntő; az ID csak kiegészítő.
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

          const tsAvg = tsOk > 0
            ? mergeEwma(prev && Number(prev.ts_success_count || 0) > 0 ? prev.ts_avg_startup_ms : null, inc.tsAvgStartupMs)
            : null;
          const hlsAvg = hlsOk > 0
            ? mergeEwma(prev && Number(prev.hls_success_count || 0) > 0 ? prev.hls_avg_startup_ms : null, inc.hlsAvgStartupMs)
            : null;

          const prevValidBest = prev && typeof prev.best_startup_ms === "number" && prev.best_startup_ms > 20 && (tsOk + hlsOk) > 0
            ? clampInt(prev.best_startup_ms, 21, 60000, null)
            : null;
          const incValidBest = typeof inc.bestStartupMs === "number" && inc.bestStartupMs > 20 && (tsOk + hlsOk) > 0
            ? clampInt(inc.bestStartupMs, 21, 60000, null)
            : null;
          const candidateBestMs = [
            prevValidBest,
            incValidBest,
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
          /* 2.5.294: a tanult útvonalak egyesítése (max. 8, a legjobbak maradnak). */
          const mergedRoutes = mergeRoutes(prev && prev.routes, inc.routes);
          const incomingFormat = VALID_FORMATS.has(inc.bestFormat) ? inc.bestFormat : "ts";
          /*
           * 2.5.386: a `best_format` MINDIG a legjobbra rangsorolt tanult
           * útvonallal egyezzen – különben a profil HLS-t hirdetett, miközben a
           * tanult útvonalak élén (és a gyakorlatban) a TS működött (TLC-eset).
           */
          const topRoute = mergedRoutes.find((route) => Number(route.ok) > 0);
          const bestFormat = topRoute && VALID_FORMATS.has(topRoute.format)
            ? topRoute.format
            : chooseBestFormat(tsOk, tsFail, tsAvg, hlsOk, hlsFail, hlsAvg, incomingFormat);
          const incomingBufProfile = VALID_BUFFER_PROFILES.has(inc.bestBufferProfile) ? inc.bestBufferProfile : "balanced";
          const bestBufferProfile = chooseBestBufferProfile(mergedBufScores, incomingBufProfile);
          const defaultAhead = BUFFER_PROFILE_DEFAULT_SECONDS[bestBufferProfile] || 3.0;
          const bestBufferAheadSeconds = clampNum(
            inc.bestBufferAheadSeconds ?? defaultAhead,
            0.5,
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
            routes: mergedRoutes,
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
      const seenEventIds = new Set();
      const categoryToType = { learning: "measurement", assistance: "repair_verified", activation: "diagnostic", channel_error: "channel_dead" };
      for (const item of rawEvents) {
        if (!item || typeof item !== "object") continue;
        const eventUid = cleanText(item.eventUid, 160);
        const category = cleanText(item.category, 32);
        const channelId = cleanText(item.channelId, 120);
        const channelKey = cleanKey(item.channelKey);
        const channelName = cleanText(item.channelName, 140);
        if (!eventUid || seenEventIds.has(eventUid) || !categoryToType[category]
          || !channelKey || !channelName) continue;
        /* 2.5.394: az eseményt is a STABIL, mentett névkulcs azonosítja;
           az elavult layout-ID miatt nem veszhet el a napló. */
        if (!(channelId && allowedChannelIds.has(channelId)) && !allowedChannelKeys.has(channelKey)) continue;
        seenEventIds.add(eventUid);
        const at = Number(item.at);
        const createdAt = Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : new Date(nowFn()).toISOString();
        const level = ["info", "warn", "repair", "verified", "error"].includes(item.level) ? item.level : "info";
        const requestedEventType = cleanText(item.eventType, 32);
        const detailedEventTypes = ["speed_test", "buffer_test", "repair_attempt", "repair_exhausted", "freeze_detected"];
        const persistedEventType = detailedEventTypes.includes(requestedEventType)
          ? requestedEventType
          : categoryToType[category];
        eventRows.push({
          event_uid: eventUid,
          event_type: persistedEventType,
          channel_key: channelKey,
          channel_id: channelId,
          channel_name: channelName,
          device_hash: deviceHash,
          tv_model: tvModel,
          webos_version: webosVersion,
          app_version: appVersion,
          playback_format: VALID_FORMATS.has(item.playbackFormat) ? item.playbackFormat : null,
          buffer_profile: VALID_BUFFER_PROFILES.has(item.bufferProfile) ? item.bufferProfile : null,
          buffer_ahead_seconds: clampNum(item.bufferAheadSeconds, 0.5, 10, null),
          startup_ms: clampInt(item.startupMs, 0, 60000, null),
          stall_ms: clampInt(item.stallMs, 0, 60000, null),
          error_code: cleanText(item.errorCode, 48) || null,
          error_reason: cleanText(item.errorReason, 160) || null,
          recovered: typeof item.recovered === "boolean" ? item.recovered : null,
          details: { category, level, message: cleanText(item.message, 220), details: item.details && typeof item.details === 'object' ? item.details : {} },
          created_at: createdAt,
        });
      }
      if (eventRows.length > 0) {
        const eventUpsert = await rest(eventsUrl + "?on_conflict=event_uid", {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify(eventRows),
        });
        if (!eventUpsert.ok) {
          const reason = await responseReason(eventUpsert);
          return out(eventUpsert.status >= 500 ? 503 : 502, { error: "event_sync_failed", reason });
        }
        syncedEvents = eventRows.length;
      }
    }

    // Minden szinkron után az eszköz mind a négy TV Doktor kategóriáját 8 rekordra korlátozzuk.
    try {
      await pruneDeviceDoctorEvents(deviceHash);
    } catch (pruneError) {
      console.error("tv-doctor event retention failed", String(pruneError));
      return out(503, { error: "event_retention_failed" });
    }

    // A felhő az összesített csatornaprofilokat, a csatornánkénti útvonalakat és a négy napló legfrissebb bejegyzéseit tárolja.

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
      || action === "reset_memory"
      || action === "sync"
      || action === "status"
    ) {
      const auth = await authenticatePairedDevice(req, body);
      if (!auth.ok) return auth.response;
      if (action === "pair_status") return await handlePairStatus(auth);
      if (action === "pair_unpair") return await handlePairUnpair(auth);
      if (action === "bootstrap") return await handleBootstrap(body, auth);
      if (action === "reset_memory") return await handleResetMemory(auth);
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
