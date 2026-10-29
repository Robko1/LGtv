// Intentionally plain JavaScript-compatible TypeScript.
// No JSR/external imports so cold starts succeed immediately on every Supabase Edge runtime.
const base = Deno.env.get("SUPABASE_URL") || "";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const profilesUrl = base + "/rest/v1/tv_doctor_channel_profiles";
const eventsUrl = base + "/rest/v1/tv_doctor_events";
const pruneRpcUrl = base + "/rest/v1/rpc/prune_tv_doctor_tables";

const DB_TIMEOUT_MS = 15_000;
const MAX_PROFILES_PER_SYNC = 60;
const MAX_EVENTS_PER_SYNC = 80;
const MAX_BOOTSTRAP_LIMIT = 600;
const DEFAULT_BOOTSTRAP_LIMIT = 400;
const MAX_DEVICE_HASHES = 25;

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
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function out(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function configured() {
  return Boolean(base && key);
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

async function sha256Short(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

async function rest(fullUrl, init = {}) {
  if (!configured()) throw new Error("Supabase service configuration is missing");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
  try {
    return await fetch(fullUrl, {
      ...init,
      signal: controller.signal,
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
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

async function handleBootstrap(body) {
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
  return out(200, {
    ok: true,
    profiles: Array.isArray(rows) ? rows.map(mapProfileRow) : [],
    serverTime: new Date().toISOString(),
  });
}

async function handleStatus() {
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
  return out(200, {
    ok: true,
    profileCount,
    serverTime: new Date().toISOString(),
  });
}

async function handleSync(body) {
  const rawProfiles = Array.isArray(body && body.profiles) ? body.profiles.slice(0, MAX_PROFILES_PER_SYNC) : [];
  const rawEvents = Array.isArray(body && body.events) ? body.events.slice(0, MAX_EVENTS_PER_SYNC) : [];
  const deviceSeed = cleanText((body && body.deviceHash) || (body && body.tvModel) || "webos-tv", 80);
  const deviceHash = await sha256Short(deviceSeed);
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

      const nowIso = new Date().toISOString();
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
      if (!channelKey || !channelName) continue;
      const rawUid = cleanText(ev.eventUid, 80) || `${deviceHash}-${channelKey}-${eventType}-${Date.now()}-${i}`;
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

  return out(200, {
    ok: true,
    syncedProfiles: mergedProfiles.length,
    syncedEvents,
    mergedProfiles,
    serverTime: new Date().toISOString(),
  });
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

  const action = body && body.action;
  if (action === "bootstrap") return await handleBootstrap(body);
  if (action === "sync") return await handleSync(body);
  if (action === "status") return await handleStatus();
  return out(400, { error: "unknown_action" });
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("tv-doctor failed", error instanceof Error ? error.stack || error.message : message);
    return out(503, { error: "service_unavailable", reason: message.slice(0, 160) });
  }
});
