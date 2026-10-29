#!/usr/bin/env node
/**
 * TV DOKTOR – teljes körű egység-, futásidejű (VideoPlayer + MenuSettingsModal)
 * és hibrid Supabase felhőszinkron tesztcsomag.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve('.');
const esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
const outDir = path.resolve('build/test');
fs.mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ HIBA: ${label}`);
  }
}

class MemoryStorage {
  constructor(maxChars = Infinity) {
    this.map = new Map();
    this.maxChars = maxChars;
  }
  get length() {
    return this.map.size;
  }
  key(index) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    const str = String(v);
    let total = str.length;
    for (const [ek, ev] of this.map.entries()) {
      if (ek !== k) total += ev.length;
    }
    if (total > this.maxChars) {
      throw new Error('QuotaExceededError');
    }
    this.map.set(String(k), str);
  }
  removeItem(k) {
    this.map.delete(String(k));
  }
  clear() {
    this.map.clear();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. TISZTA LOGIKA, PUFFEROPTIMALIZÁLÁS, FAGYÁSFIGYELÉS ÉS FELHŐ MODUL TESZT
 * ═══════════════════════════════════════════════════════════════════════════ */
console.log('\n1. TV Doktor magmodul: csatornaváltás, puffertanulás, fagyásfigyelés és biztonság');

const coreOut = path.join(outDir, 'tv-doctor-core.mjs');
await esbuild.build({
  stdin: {
    contents: `
      export * from './web/src/services/tvDoctor.ts';
      export * from './web/src/services/tvDoctorCloud.ts';
      export { INITIAL_SETTINGS } from './web/src/data/mockData.ts';
    `,
    resolveDir: ROOT,
    sourcefile: 'tv-doctor-core-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2020',
  outfile: coreOut,
  logLevel: 'silent',
});

const core = await import(pathToFileURL(coreOut).href);

// 1.1 Csatornakulcs képzés (ékezetmentes, hitelesítő adat nélkül)
check(
  core.normalizeChannelDoctorKey({ id: 'live-1', name: '[HU] M4 Sport HD' }) === 'hu:m4-sport-hd',
  'a kanonikus csatornakulcs ékezetmentes és országkódos ([HU] M4 Sport HD -> hu:m4-sport-hd)',
);
check(
  core.normalizeChannelDoctorKey({ id: 'live-2', name: 'Álom Mozi Űr TV', countryCode: 'HU' }) === 'hu:alom-mozi-ur-tv',
  'a magyar ékezetek (á, ű, stb.) ES5-biztosan normalizálódnak URL nélkül',
);

// 1.2 Villámgyors csatornaváltás és sebességalapú előválasztás
const store = new MemoryStorage();
const m4Channel = {
  id: 'ch-m4',
  name: '[HU] M4 Sport HD',
  streamUrl: 'http://panel.example:8080/live/titkosUser/titkosPass/101.ts',
};

const initialPlan = core.selectChannelLaunchPlan(m4Channel, m4Channel.streamUrl, core.INITIAL_SETTINGS, store);
check(
  initialPlan.enabled === true && initialPlan.hasLearnedProfile === false && initialPlan.primaryFormat === 'ts',
  'új csatornánál az alapértelmezett TS mód és globális pufferprofil indul lassítás nélkül',
);

// Mérjük: TS lassú (1950 ms), HLS villámgyors (340 ms)
core.recordDoctorChannelSuccess({
  channel: m4Channel,
  format: 'ts',
  bufferProfile: 'balanced',
  startupMs: 1950,
  storage: store,
});
core.recordDoctorChannelSuccess({
  channel: m4Channel,
  format: 'hls',
  bufferProfile: 'fast',
  startupMs: 340,
  storage: store,
});
core.recordDoctorChannelSuccess({
  channel: m4Channel,
  format: 'hls',
  bufferProfile: 'fast',
  startupMs: 310,
  storage: store,
});

const fastPlan = core.selectChannelLaunchPlan(m4Channel, m4Channel.streamUrl, core.INITIAL_SETTINGS, store);
check(
  fastPlan.hasLearnedProfile === true && fastPlan.primaryFormat === 'hls',
  'villámgyors csatornaváltás: a mérten sokkal gyorsabb HLS (320 ms vs 1950 ms) automatikusan előre kerül',
);
check(
  fastPlan.bufferProfileId === 'fast' && fastPlan.bufferTiming.minBufferAheadSeconds === 1.5,
  'a hibátlan és gyors profilnál a Gyors (1.5 mp) pufferprofil kerül kiválasztásra',
);

// 1.3 Automatikus pufferoptimalizálás és szigorú biztonsági határok (1.0 .. 10.0 mp)
const jitterChannel = {
  id: 'ch-uhd',
  name: '[HU] Sport UHD',
  streamUrl: 'http://panel.example:8080/live/u/p/999.ts',
};
let bufProfile = 'fast';
const visitedProfiles = [bufProfile];
for (let i = 0; i < 8; i++) {
  const rec = core.recordDoctorChannelFailure({
    channel: jitterChannel,
    format: 'ts',
    bufferProfile: bufProfile,
    trigger: 'buffer_stall',
    stallMs: 4000,
    storage: store,
  });
  bufProfile = rec.bestBufferProfile;
  visitedProfiles.push(bufProfile);
}
check(
  visitedProfiles.includes('balanced') &&
    visitedProfiles.includes('stable') &&
    visitedProfiles.includes('adaptive-1') &&
    visitedProfiles.includes('adaptive-2') &&
    visitedProfiles.includes('adaptive-3'),
  'ismétlődő megakadásnál végigpróbálja az előre meghatározott és fokozatos pufferlépcsőket',
);
const uhdRec = core.getChannelDoctorRecord(jitterChannel, store);
check(
  uhdRec.bestBufferProfile === 'adaptive-3' && uhdRec.bestBufferAheadSeconds === 10,
  'a pufferméret SOHA nem nő a 10.0 mp-es biztonsági felső határ fölé',
);

const clamped = core.clampBufferTiming({
  startupWatchdogMs: 99999,
  bufferWatchdogMs: 99999,
  stallDetectorMs: 99999,
  retryMs: 99999,
  minBufferAheadSeconds: 500,
});
check(
  clamped.minBufferAheadSeconds === 10 &&
    clamped.startupWatchdogMs === 4000 &&
    clamped.bufferWatchdogMs === 9000 &&
    clamped.stallDetectorMs === 9000,
  'clampBufferTiming keményen korlátozza a szélsőséges értékeket (TV túlterhelés elleni védelem)',
);

// 1.4 Sebességteszt jelöltlista
const speedCandidates = core.buildSafeSpeedTestCandidates({
  streamUrl: m4Channel.streamUrl,
  currentFormat: 'ts',
  currentBufferProfile: 'balanced',
  record: null,
});
check(
  speedCandidates.length > 0 &&
    speedCandidates.length <= 4 &&
    speedCandidates[0].format === 'hls' &&
    speedCandidates[0].url.endsWith('.m3u8'),
  'a sebességteszt biztonságos darabszámú jelöltet ad, élén a még nem mért alternatív formátummal',
);

// 1.5 Okos fagyásfigyelés (valódi fagyás vs. állókép / rádiócsatorna)
const radioDecision = core.evaluateSmartFreeze({
  prevSnapshot: { at: 1000, time: 0, frames: null, bufferedEnd: 6, readyState: 4 },
  currentSnapshot: { at: 5000, time: 0, frames: null, bufferedEnd: 10, readyState: 4 },
  streamState: {
    readyState: 4,
    networkState: 2,
    paused: false,
    ended: false,
    currentTime: 0,
    duration: null,
    bufferedAheadSeconds: 8,
    decodedFrames: null,
    droppedFrames: null,
    videoWidth: 0,
    videoHeight: 0,
    waitingOrStalled: false,
  },
  consecutiveStallTicks: 3,
  minBufferAheadSeconds: 3,
});
check(
  radioDecision.intervene === false,
  'okos fagyásfigyelő: aktív hang-/rádiócsatornán (0x0 videó, egészséges puffer) NEM avatkozik be tévesen',
);

const staticSlideFirstTick = core.evaluateSmartFreeze({
  prevSnapshot: { at: 1000, time: 0, frames: 120, bufferedEnd: 8, readyState: 4 },
  currentSnapshot: { at: 5000, time: 0, frames: 120, bufferedEnd: 12, readyState: 4 },
  streamState: {
    readyState: 4,
    networkState: 2,
    paused: false,
    ended: false,
    currentTime: 0,
    duration: null,
    bufferedAheadSeconds: 6,
    decodedFrames: 120,
    droppedFrames: 0,
    videoWidth: 1920,
    videoHeight: 1080,
    waitingOrStalled: false,
  },
  consecutiveStallTicks: 1,
  minBufferAheadSeconds: 3,
});
check(
  staticSlideFirstTick.intervene === false,
  'okos fagyásfigyelő: állóképes, de egészséges pufferű adás első jelzésénél nem indít hamis újratöltést',
);

const confirmedDecoderFreeze = core.evaluateSmartFreeze({
  prevSnapshot: { at: 1000, time: 0, frames: 120, bufferedEnd: 8, readyState: 4 },
  currentSnapshot: { at: 9000, time: 0, frames: 120, bufferedEnd: 16, readyState: 4 },
  streamState: {
    readyState: 4,
    networkState: 2,
    paused: false,
    ended: false,
    currentTime: 0,
    duration: null,
    bufferedAheadSeconds: 6,
    decodedFrames: 120,
    droppedFrames: 0,
    videoWidth: 3840,
    videoHeight: 2160,
    waitingOrStalled: false,
  },
  consecutiveStallTicks: 2,
  minBufferAheadSeconds: 3,
});
check(
  confirmedDecoderFreeze.intervene === true,
  'okos fagyásfigyelő: tartós dekóderfagyásnál (M2 UHD eset) megerősítés után határozottan közbelép',
);

// 1.6 Korlátozott javítási lépések + tartalék URL + bővíthető plugin rendszer
const fallbackChannel = {
  id: 'ch-fb',
  name: '[HU] Teszt TV',
  streamUrl: 'http://panel.example:8080/live/u/p/500.ts',
  fallbackUrl: 'http://backup.example:8080/live/u/p/500-backup.m3u8',
};
const step1 = core.planDoctorRepairStep({
  channel: fallbackChannel,
  trigger: 'startup_timeout',
  step: 1,
  currentFormat: 'ts',
  currentBufferProfile: 'balanced',
  streamUrl: fallbackChannel.streamUrl,
  tsUrl: fallbackChannel.streamUrl,
  hlsUrl: 'http://panel.example:8080/live/u/p/500.m3u8',
  storage: store,
});
const step2 = core.planDoctorRepairStep({
  channel: fallbackChannel,
  trigger: 'startup_timeout',
  step: 2,
  currentFormat: 'ts',
  currentBufferProfile: 'balanced',
  streamUrl: fallbackChannel.streamUrl,
  tsUrl: fallbackChannel.streamUrl,
  hlsUrl: 'http://panel.example:8080/live/u/p/500.m3u8',
  storage: store,
});
const step5 = core.planDoctorRepairStep({
  channel: fallbackChannel,
  trigger: 'startup_timeout',
  step: 5,
  currentFormat: 'hls',
  currentBufferProfile: 'stable',
  streamUrl: fallbackChannel.streamUrl,
  tsUrl: fallbackChannel.streamUrl,
  hlsUrl: 'http://panel.example:8080/live/u/p/500.m3u8',
  storage: store,
});
const stepExhausted = core.planDoctorRepairStep({
  channel: fallbackChannel,
  trigger: 'startup_timeout',
  step: 6,
  currentFormat: 'hls',
  currentBufferProfile: 'stable',
  streamUrl: fallbackChannel.streamUrl,
  tsUrl: fallbackChannel.streamUrl,
  hlsUrl: 'http://panel.example:8080/live/u/p/500.m3u8',
  storage: store,
});
check(
  step1.nextFormat === 'ts' && step2.nextFormat === 'hls' && step5.useFallbackUrl === true && stepExhausted.exhausted === true,
  'a javító korlátozott lépésben vált formátumot, puffert, tartalék URL-t, majd visszaáll az alap helyreállításra',
);

// Bővíthető plugin regisztráció (8. követelmény)
const unregisterDiag = core.registerDoctorDiagnosticPlugin({
  id: 'custom-net-probe',
  collect: () => ({ customRttMs: 42 }),
});
const diagReport = core.collectDoctorDiagnostics({
  channel: fallbackChannel,
  trigger: 'media_error',
  format: 'ts',
  bufferProfile: 'balanced',
  loadElapsedMs: 810,
  errorCode: 'MEDIA_ERR_4',
  errorDetail: 'Format error',
  streamState: {
    readyState: 0,
    networkState: 3,
    paused: true,
    ended: false,
    currentTime: 0,
    duration: null,
    bufferedAheadSeconds: 0,
    decodedFrames: 100,
    droppedFrames: 5,
    videoWidth: 1920,
    videoHeight: 1080,
    waitingOrStalled: false,
  },
});
unregisterDiag();
check(
  diagReport.extraMetrics.customRttMs === 42 && diagReport.extraMetrics.frameDropPercent === 5,
  'a bővíthető diagnosztikai plugin-rendszer (custom + beépített képminőség-mérő) hibátlanul fut',
);

// 1.7 Adatbiztonság és hitelesítő adatok szűrése (9. követelmény)
const redacted = core.redactDoctorText(
  'Hiba: http://iptv.pelda.hu:8080/live/titkosFelh/szuperTitkosJelszo/4421.ts?token=abc999&password=xyz',
);
check(
  !redacted.includes('titkosFelh') && !redacted.includes('szuperTitkosJelszo') && !redacted.includes('abc999') && !redacted.includes('xyz'),
  'a naplózó és felhőküldő minden felhasználónevet, jelszót és tokent eltávolít',
);

const quotaStore = new MemoryStorage(35_000);
quotaStore.setItem('iptv_rt_providers_v1', '[{"id":"p1","name":"Fontos Szolgáltató"}]');
quotaStore.setItem('iptv_rt_settings_v1', '{"bufferMode":"balanced"}');
for (let i = 0; i < 520; i++) {
  core.recordDoctorChannelSuccess({
    channel: { id: `ch-${i}`, name: `[HU] Csatorna ${i}` },
    format: i % 2 === 0 ? 'ts' : 'hls',
    bufferProfile: 'fast',
    startupMs: 400 + (i % 300),
    storage: quotaStore,
  });
}
check(
  quotaStore.getItem('iptv_rt_providers_v1') === '[{"id":"p1","name":"Fontos Szolgáltató"}]' &&
    quotaStore.getItem('iptv_rt_settings_v1') === '{"bufferMode":"balanced"}',
  'kvótakorlátnál a TV Doktor SOHA nem törli a csatornalistát/szolgáltatót vagy a beállításokat',
);
check(
  core.getTvDoctorSummary(quotaStore).learnedChannelCount <= core.MAX_LEARNED_CHANNELS,
  `a helyi tanuló memória darabszáma szigorúan korlátozott (≤ ${core.MAX_LEARNED_CHANNELS})`,
);

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. SUPABASE HIBRID FELHŐ ÉS OFFLINE MŰKÖDÉS + EDGE FUNCTION LOGIKA TESZT
 * ═══════════════════════════════════════════════════════════════════════════ */
console.log('\n2. Hibrid Supabase szinkron, több készülék tanulása és offline gyorsítótár');

// Betöltjük és valódi kérésekkel meghajtjuk a supabase/functions/tv-doctor/index.ts Edge Functiont!
let edgeHandler = null;
globalThis.Deno = {
  env: {
    get(name) {
      if (name === 'SUPABASE_URL') return 'https://mock-db.supabase.co';
      if (name === 'SUPABASE_SERVICE_ROLE_KEY') return 'service-secret-key';
      return '';
    },
  },
  serve(fn) {
    edgeHandler = fn;
  },
};

const edgeOut = path.join(outDir, 'tv-doctor-edge-fn.mjs');
await esbuild.build({
  entryPoints: [path.resolve('supabase/functions/tv-doctor/index.ts')],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
  outfile: edgeOut,
  logLevel: 'silent',
});
await import(pathToFileURL(edgeOut).href);
check(typeof edgeHandler === 'function', 'a Supabase tv-doctor Edge Function betöltődik és regisztrálja a Deno.serve kezelőt');

// Memóriabeli PostgREST adatbázis szimuláció az Edge Function mögé
const dbProfiles = new Map();
const dbEvents = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const urlStr = String(url);
  if (urlStr.startsWith('https://mock-db.supabase.co/rest/v1/tv_doctor_channel_profiles')) {
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET') {
      const rows = Array.from(dbProfiles.values());
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'content-range': `0-${rows.length}/${rows.length}` },
      });
    }
    if (method === 'POST') {
      const incoming = JSON.parse(init.body || '[]');
      const saved = incoming.map((row) => {
        const merged = { ...(dbProfiles.get(row.channel_key) || {}), ...row };
        dbProfiles.set(row.channel_key, merged);
        return merged;
      });
      return new Response(JSON.stringify(saved), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
  }
  if (urlStr.startsWith('https://mock-db.supabase.co/rest/v1/tv_doctor_events')) {
    const incoming = JSON.parse(init.body || '[]');
    for (const ev of incoming) {
      if (!dbEvents.some((e) => e.event_uid === ev.event_uid)) dbEvents.push(ev);
    }
    return new Response('', { status: 201 });
  }
  if (urlStr.startsWith('https://mock-db.supabase.co/rest/v1/rpc/prune_tv_doctor_tables')) {
    return new Response(null, { status: 204 });
  }
  // A kliens kéréseit átirányítjuk a valódi Edge Function kezelőhöz!
  if (urlStr.includes('/functions/v1/tv-doctor')) {
    if (globalThis.__SIMULATE_OFFLINE__) {
      throw new Error('Network offline');
    }
    return await edgeHandler(
      new Request(urlStr, {
        method: init.method || 'POST',
        headers: init.headers,
        body: init.body,
      }),
    );
  }
  return originalFetch ? originalFetch(url, init) : new Response('{}', { status: 200 });
};

// Két külön TV szinkronizálja tapasztalatát ugyanarra a csatornára az Edge Functionön keresztül:
const tv1SyncResp = await (
  await edgeHandler(
    new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sync',
        deviceHash: 'lg-oled-tv-1',
        tvModel: 'OLED55C3',
        webosVersion: '8.3.0',
        appVersion: '2.5.191',
        profiles: [
          {
            channelKey: 'hu:rtl-hd',
            channelName: '[HU] RTL HD',
            countryCode: 'HU',
            bestFormat: 'hls',
            bestBufferProfile: 'fast',
            bestBufferAheadSeconds: 1.5,
            tsAvgStartupMs: 2200,
            hlsAvgStartupMs: 380,
            tsSuccessDelta: 0,
            tsFailureDelta: 3,
            hlsSuccessDelta: 5,
            hlsFailureDelta: 0,
            bufferScores: { fast: { ok: 5, fail: 0, stalls: 0, avgStartupMs: 380 } },
          },
        ],
        events: [
          {
            eventType: 'repair_verified',
            channelKey: 'hu:rtl-hd',
            channelName: '[HU] RTL HD',
            playbackFormat: 'hls',
            bufferProfile: 'fast',
            startupMs: 380,
            errorReason: 'http://secret.host/live/userA/passB/77.ts Format error',
            recovered: true,
          },
        ],
      }),
    }),
  )
).json();

const tv2SyncResp = await (
  await edgeHandler(
    new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sync',
        deviceHash: 'lg-nanocell-tv-2',
        tvModel: '55NANO81',
        webosVersion: '7.2.0',
        appVersion: '2.5.191',
        profiles: [
          {
            channelKey: 'hu:rtl-hd',
            channelName: '[HU] RTL HD',
            countryCode: 'HU',
            bestFormat: 'hls',
            bestBufferProfile: 'fast',
            hlsAvgStartupMs: 410,
            hlsSuccessDelta: 4,
            bufferScores: { fast: { ok: 4, fail: 0, stalls: 0, avgStartupMs: 410 } },
          },
        ],
      }),
    }),
  )
).json();

check(
  tv1SyncResp.ok === true &&
    tv2SyncResp.ok === true &&
    dbProfiles.get('hu:rtl-hd').device_count === 2 &&
    dbProfiles.get('hu:rtl-hd').best_format === 'hls',
  'a Supabase Edge Function összesíti több készülék (2 külön LG TV) mérési tapasztalatait',
);
check(
  dbEvents.length === 1 && !JSON.stringify(dbEvents[0]).includes('userA') && !JSON.stringify(dbEvents[0]).includes('passB'),
  'a Supabase szerveroldalon is kiszűr minden hitelesítő adatot a tárolás előtt',
);

// 3. TV (friss telepítés) letölti a központi tudásbázist, majd offline módban is működik!
globalThis.localStorage = new MemoryStorage();
core.clearTvDoctorMemory();
core.clearTvDoctorCloudQueue();
core.configureTvDoctorCloud(true);

const downloadedCount = await core.bootstrapTvDoctorFromCloud();
check(downloadedCount >= 1, 'egy új TV induláskor letölti a központi csatornaprofilokat a Supabase-ről');

// Szimulálunk teljes internetkimaradást a felhő irányába:
globalThis.__SIMULATE_OFFLINE__ = true;
const offlinePlan = core.selectChannelLaunchPlan(
  { id: 'brand-new-local-id', name: '[HU] RTL HD' },
  'http://panel.local:8080/live/u/p/555.ts',
  core.INITIAL_SETTINGS,
);
check(
  offlinePlan.hasLearnedProfile === true && offlinePlan.primaryFormat === 'hls' && offlinePlan.bufferProfileId === 'fast',
  'internetkimaradáskor (offline) is azonnal a felhőből gyorsítótárazott optimális HLS + Gyors profil indul',
);

// Offline hiba rögzítése -> bekerül a helyi várólistába, majd online visszatéréskor felmegy:
core.recordDoctorChannelFailure({
  channel: { id: 'ch-duna', name: '[HU] Duna HD' },
  format: 'ts',
  bufferProfile: 'balanced',
  trigger: 'media_error',
  errorCode: 'MEDIA_ERR_4',
  errorDetail: 'Format error',
});
const offlineFlushOk = await core.flushTvDoctorCloudQueue();
check(
  offlineFlushOk === false && core.getTvDoctorCloudStatus().pendingCount > 0,
  'offline állapotban a mérések nem vesznek el, a korlátozott helyi várólistában maradnak',
);

globalThis.__SIMULATE_OFFLINE__ = false;
const onlineFlushOk = await core.flushTvDoctorCloudQueue();
check(
  onlineFlushOk === true && core.getTvDoctorCloudStatus().pendingCount === 0 && dbProfiles.has('hu:duna-hd'),
  'a kapcsolat helyreállásakor a várólista automatikusan szinkronizálódik a Supabase tudásbázisba',
);
core.configureTvDoctorCloud(false);
globalThis.fetch = originalFetch;

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. MENÜ LENYÍLÓ PANEL, SUPABASE HIBAHELY, MEMÓRIA 0-RA ÁLLÍTÁS,
 *    KÉZI HIBANAPLÓZÁS BŐVÍTÉS ÉS VIDEOPLAYER INTEGRÁCIÓS TESZT
 * ═══════════════════════════════════════════════════════════════════════════ */
console.log('\n3. Valódi React MenuSettingsModal (lenyíló állapot, Memória: 0, Supabase hibalokalizáció), DiagnosticShareModal és VideoPlayer');

const uiHarness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MenuSettingsModal } from './web/src/components/MenuSettingsModal.tsx';
import { DiagnosticShareModal } from './web/src/components/DiagnosticShareModal.tsx';
import { VideoPlayer } from './web/src/components/VideoPlayer.tsx';
import { INITIAL_SETTINGS } from './web/src/data/mockData.ts';
import {
  recordDoctorChannelSuccess,
  recordDoctorChannelFailure,
  evaluateSmartFreeze,
  recordDoctorOpTiming,
  clearTvDoctorMemory,
  getChannelDoctorRecord,
  getTvDoctorMemoryStats,
} from './web/src/services/tvDoctor.ts';
import {
  attachTvDoctorDiagnostics,
  configureTvDoctorCloud,
  checkTvDoctorConnection,
  getTvDoctorCloudStatus,
  resetTvDoctorAllToZero,
} from './web/src/services/tvDoctorCloud.ts';
import { getAppLogText, manualLogSnapshot } from './web/src/services/appLog.ts';

attachTvDoctorDiagnostics();

function TestApp({ initialMode }) {
  const [settings, setSettings] = useState({ ...INITIAL_SETTINGS });
  const [isPlaying, setIsPlaying] = useState(true);
  const [channel, setChannel] = useState({
    id: 'ch-atv',
    name: '[HU] ATV HD',
    streamUrl: 'http://stream.example:8080/live/u/p/701.ts',
  });
  window.__DOCTOR_UI__ = {
    getSettings: () => settings,
    setSettings: (patch) => setSettings((s) => ({ ...s, ...patch })),
    setChannel,
    recordDoctorChannelSuccess,
    recordDoctorChannelFailure,
    evaluateSmartFreeze,
    recordDoctorOpTiming,
    clearTvDoctorMemory,
    getChannelDoctorRecord,
    getTvDoctorMemoryStats,
    configureTvDoctorCloud,
    checkTvDoctorConnection,
    getTvDoctorCloudStatus,
    resetTvDoctorAllToZero,
    getAppLogText,
    manualLogSnapshot,
  };
  if (initialMode === 'menu') {
    return React.createElement(MenuSettingsModal, {
      isOpen: true,
      onClose: () => {},
      activeTab: 'system',
      setActiveTab: () => {},
      channels: [],
      settings,
      onUpdateSettings: (patch) => setSettings((s) => ({ ...s, ...patch })),
      providers: [],
      onOpenAddProvider: () => {},
      onEditProvider: () => {},
      onDeleteProvider: () => {},
      onRefreshProvider: () => {},
      onOpenImportDiagnostic: () => {},
      folders: [],
      onOpenAddFolder: () => {},
      onDeleteFolder: () => {},
      onToggleFavorite: () => {},
      onRemoveChannelFromFolder: () => {},
      onOpenEpgModal: () => {},
      onOpenQrProvision: () => {},
      watchHistory: [],
      onContinueWatching: () => {},
      onRemoveWatchHistoryItem: () => {},
    });
  }
  if (initialMode === 'diag') {
    return React.createElement(DiagnosticShareModal, {
      isOpen: true,
      onClose: () => {},
    });
  }
  return React.createElement(VideoPlayer, {
    channel,
    settings,
    isPlaying,
    setIsPlaying,
    volume: 0.5,
    onVolumeChange: () => {},
    onToggleMute: () => {},
    playbackActive: true,
  });
}

let root = null;
window.__MOUNT_MODE__ = (mode) => {
  if (root) root.unmount();
  root = createRoot(document.getElementById('root'));
  root.render(React.createElement(TestApp, { initialMode: mode }));
};
`;

const uiBundleFile = path.join(outDir, 'tv-doctor-ui-bundle.js');
await esbuild.build({
  stdin: { contents: uiHarness, resolveDir: ROOT, sourcefile: 'tv-doctor-ui-harness.tsx', loader: 'tsx' },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  nodePaths: [path.resolve('web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: uiBundleFile,
  logLevel: 'silent',
});

const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const playedUrls = [];
let mockCloudMode = 'ok';
const sentDiagnosticPayloads = [];

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://tv.local/',
  pretendToBeVisual: true,
  runScripts: 'dangerously',
  virtualConsole: vc,
  beforeParse(window) {
    window.fetch = async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('/functions/v1/tv-doctor')) {
        if (mockCloudMode === 'http_401') {
          return new Response(JSON.stringify({ message: 'Invalid API key' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (mockCloudMode === 'db_500') {
          return new Response(JSON.stringify({ ok: false, error: 'DB select failed: relation tv_doctor_channel_profiles' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ ok: true, profileCount: 18, serverTime: '2026-10-29T19:30:00.000Z' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (urlStr.includes('/functions/v1/tv-diagnostic-share')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.action === 'send') {
          sentDiagnosticPayloads.push(body);
          return new Response(
            JSON.stringify({
              ok: true,
              logNumber: body.logNumber,
              startedAt: body.startedAt,
              createdAt: '2026-10-29T19:31:00.000Z',
              charCount: body.charCount,
              lineCount: body.lineCount,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ ok: true, records: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    };
    window.Element.prototype.getClientRects = function getClientRects() {
      return this.hasAttribute('hidden') ? [] : [{ width: 120, height: 40 }];
    };
    window.Element.prototype.scrollIntoView = function scrollIntoView() {};
    window.HTMLMediaElement.prototype.load = function load() {};
    window.HTMLMediaElement.prototype.pause = function pause() {
      Object.defineProperty(this, 'paused', { value: true, configurable: true });
    };
    window.HTMLMediaElement.prototype.play = function play() {
      playedUrls.push(this.getAttribute('src') || this.src);
      Object.defineProperty(this, 'paused', { value: false, configurable: true });
      return Promise.resolve();
    };
  },
});

const wait = (ms = 55) => new Promise((r) => setTimeout(r, ms));
try {
  const { window } = dom;
  const script = window.document.createElement('script');
  script.textContent = fs.readFileSync(uiBundleFile, 'utf8');
  window.document.body.appendChild(script);

  // 3.1 Menü -> Rendszer -> TV Doktor kártya, felső gombcsoport (Memória: 0 a kapcsoló mellett) és lenyíló ablak
  window.__MOUNT_MODE__('menu');
  await wait(80);

  window.localStorage.setItem('iptv_rt_providers_v1', '[{"id":"prov-1","name":"Éles Szolgáltató"}]');
  window.__DOCTOR_UI__.configureTvDoctorCloud(true);
  window.__DOCTOR_UI__.recordDoctorChannelSuccess({
    channel: { id: 'ch-m4', name: '[HU] M4 Sport HD' },
    format: 'hls',
    bufferProfile: 'fast',
    startupMs: 310,
  });
  window.__DOCTOR_UI__.recordDoctorChannelFailure({
    channel: { id: 'ch-rtl', name: '[HU] RTL HD' },
    format: 'ts',
    bufferProfile: 'balanced',
    trigger: 'playback_stall',
    errorCode: 'STALL',
    errorDetail: 'Puffer kiürült',
  });
  await wait(50);

  const doc = window.document;
  const doctorBox = doc.querySelector('[data-tv-doctor-box]');
  const doctorControls = doc.querySelector('[data-tv-doctor-controls]');
  const doctorResetBtn = doc.querySelector('[data-tv-doctor-reset]');
  const doctorToggle = doc.querySelector('[data-tv-doctor-toggle]');

  check(
    Boolean(doctorBox) && doctorBox.hasAttribute('data-tv-box'),
    'a Rendszer menüben megjelenik a dedikált dobozos TV Doktor kártya',
  );
  check(
    Boolean(doctorControls) &&
      doctorControls.contains(doctorResetBtn) &&
      doctorControls.contains(doctorToggle) &&
      !doc.querySelector('[data-tv-doctor-details]'),
    'a Memória: 0 gomb közvetlenül a Ki/Be kapcsoló mellett ül, és alapból csukva van a lenyíló naplórész',
  );
  check(doctorToggle.getAttribute('aria-checked') === 'true', 'alapértelmezetten a TV Doktor aktív');

  // Külső dobozra nyomva (OK / Enter vagy kattintás) lenyílik a részletes információs ablak + ellenőrzi a Supabase kapcsolatot:
  mockCloudMode = 'ok';
  doctorBox.focus();
  doctorBox.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await wait(90);
  const detailsOpen = doc.querySelector('[data-tv-doctor-details]');
  check(
    Boolean(detailsOpen) &&
      Boolean(doc.querySelector('[data-tv-doctor-health]')) &&
      Boolean(doc.querySelector('[data-tv-doctor-supabase]')) &&
      Boolean(doc.querySelector('[data-tv-doctor-memory]')) &&
      Boolean(doc.querySelector('[data-tv-doctor-log-list]')) &&
      detailsOpen.textContent.includes('Létrejött ✓') &&
      detailsOpen.textContent.includes('18 db'),
    'a külső dobozra nyomva lenyílik az ablak: mutatja a működést, az élő Supabase kapcsolatot, a TV memóriát és az elkülönített naplót',
  );

  // Supabase hiba esetén pontosan kiírja HOL a hiba és MI a hiba röviden:
  mockCloudMode = 'http_401';
  doc.querySelector('[data-tv-doctor-check-cloud]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await wait(80);
  const errBox401 = doc.querySelector('[data-tv-doctor-error-box]');
  check(
    Boolean(errBox401) &&
      errBox401.textContent.includes('Hol a hiba:') &&
      errBox401.textContent.includes('Supabase hitelesítés (API kulcs') &&
      errBox401.textContent.includes('HTTP 401'),
    'Supabase API-kulcs hibánál pontosan kiírja HOL a hiba (hitelesítés) és MI a teendő',
  );

  mockCloudMode = 'db_500';
  doc.querySelector('[data-tv-doctor-check-cloud]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await wait(80);
  const errBox500 = doc.querySelector('[data-tv-doctor-error-box]');
  check(
    Boolean(errBox500) &&
      errBox500.textContent.includes('Supabase adatbázis (tv_doctor táblák)') &&
      errBox500.textContent.includes('HTTP 500'),
    'Supabase adatbázishibánál pontosan megjelöli a tv_doctor adatbázis réteget mint hibahelyet',
  );

  // Memória 0-ra állítása gomb a kapcsoló mellett: nullázza a tanult profilokat, a várólistát és a TV Doktor memóriát,
  // miközben NEM csukja be a lenyíló ablakot és NEM törli a szolgáltatót/beállításokat!
  const memBeforeReset = window.__DOCTOR_UI__.getTvDoctorMemoryStats();
  doc.querySelector('[data-tv-doctor-reset]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await wait(60);
  const memAfterReset = window.__DOCTOR_UI__.getTvDoctorMemoryStats();
  const cloudAfterReset = window.__DOCTOR_UI__.getTvDoctorCloudStatus();
  check(
    memBeforeReset.doctorTotalBytes > 0 &&
      memAfterReset.learnedChannelCount === 0 &&
      memAfterReset.doctorTotalBytes === 0 &&
      cloudAfterReset.pendingCount === 0 &&
      Boolean(doc.querySelector('[data-tv-doctor-details]')) &&
      window.localStorage.getItem('iptv_rt_providers_v1')?.includes('Éles Szolgáltató'),
    'a Memória: 0 gomb egyetlen nyomásra 0 B / 0 csatorna alapállapotra állítja a TV Doktort anélkül, hogy bezárná a panelt vagy törölné a listákat',
  );

  // Külső dobozra újra rányomva visszacsukódik az információs ablak:
  doc.querySelector('[data-tv-doctor-box]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await wait(50);
  check(!doc.querySelector('[data-tv-doctor-details]'), 'a külső dobozra újra nyomva az információs ablak tisztán visszacsukódik');

  // A Ki/Be kapcsoló önállóan kapcsol, nem nyitja ki véletlenül a lenyíló részt:
  doc.querySelector('[data-tv-doctor-toggle]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await wait(50);
  check(
    window.__DOCTOR_UI__.getSettings().tvDoctorEnabled === false &&
      doc.querySelector('[data-tv-doctor-toggle]').getAttribute('aria-checked') === 'false' &&
      !doc.querySelector('[data-tv-doctor-details]'),
    'a Ki/Be kapcsoló önállóan kikapcsolja a TV Doktort, és nem nyitja le véletlenül a naplórészt',
  );
  // Visszakapcsoljuk a további tesztekhez:
  doc.querySelector('[data-tv-doctor-toggle]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await wait(40);

  // 3.2 Kézi hibakeresési napló (DiagnosticShareModal): TV Doktor naplózás + elakadás rögzítése + változatlan Supabase küldés
  mockCloudMode = 'db_500';
  await window.__DOCTOR_UI__.checkTvDoctorConnection();
  window.__MOUNT_MODE__('diag');
  await wait(90);

  const diagDocToggle = doc.querySelector('[data-diagnostic-tv-doctor-toggle]');
  const diagStartBtn = doc.querySelector('[data-diagnostic-toggle]');
  const diagSendBtn = doc.querySelector('[data-diagnostic-send]');
  check(
    Boolean(diagDocToggle) && diagDocToggle.getAttribute('aria-checked') === 'true',
    'a Kézi hibakeresési napló ablakban megjelenik az aktív TV Doktor működés- és elakadás-naplózás kapcsoló',
  );

  // Elindítjuk a kézi naplózást, szimulálunk TV Doktor működést és egy elakadást/lassulást, majd elküldjük Supabase-re:
  diagStartBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await wait(50);

  window.__DOCTOR_UI__.recordDoctorOpTiming('selectChannelLaunchPlan', 48, '[HU] M2 UHD');
  window.__DOCTOR_UI__.evaluateSmartFreeze({
    prevSnapshot: { currentTime: 10, decodedFrames: 250, bufferedEnd: 10.1 },
    currentSnapshot: { currentTime: 10, decodedFrames: 250, bufferedEnd: 10.1 },
    streamState: {
      readyState: 2,
      networkState: 2,
      paused: false,
      ended: false,
      currentTime: 10,
      duration: null,
      bufferedAheadSeconds: 0.1,
      decodedFrames: 250,
      droppedFrames: 5,
      videoWidth: 3840,
      videoHeight: 2160,
      waitingOrStalled: true,
    },
    consecutiveStallTicks: 2,
    minBufferAheadSeconds: 3.0,
  });
  await wait(40);

  diagSendBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await wait(120);

  const sentPayload = sentDiagnosticPayloads[0];
  check(
    Boolean(sentPayload) &&
      typeof sentPayload.logText === 'string' &&
      sentPayload.logText.includes('TV DOKTOR ÁLLAPOTKÉP') &&
      sentPayload.logText.includes('TV DOKTOR MEMÓRIA:') &&
      sentPayload.logText.includes('TV DOKTOR SUPABASE HIBA RÉSZLETEK:') &&
      sentPayload.logText.includes('TV DOKTOR ELAKADÁS / LASSULÁS: művelet=selectChannelLaunchPlan') &&
      sentPayload.logText.includes('TV DOKTOR ELAKADÁS ÉSZLELVE:') &&
      sentPayload.logText.includes('TV DOKTOR NAPLÓ ÖSSZESÍTÉS:') &&
      window.__DOCTOR_UI__.manualLogSnapshot().charCount === 0,
    'a kézi hibanapló rögzíti a TV Doktor állapotát, memóriáját, Supabase hibáját és elakadásait, majd a meglévő küldővel hibátlanul elküldi és felszabadítja a RAM-ot',
  );

  // 3.3 VideoPlayer integráció: tanult HLS profil előválasztása vs. kikapcsolt TV Doktor
  window.__DOCTOR_UI__.clearTvDoctorMemory();
  window.localStorage.clear();
  window.__DOCTOR_UI__.recordDoctorChannelSuccess({
    channel: { id: 'other-provider-id', name: '[HU] ATV HD' },
    format: 'hls',
    bufferProfile: 'fast',
    startupMs: 290,
  });

  playedUrls.length = 0;
  window.__MOUNT_MODE__('player');
  await wait(80);
  check(
    playedUrls.length >= 1 && playedUrls[0].endsWith('/701.m3u8'),
    'bekapcsolt TV Doktornál a VideoPlayer már az első próbánál a tanult gyorsabb HLS (.m3u8) módot indítja',
  );

  // Ha kikapcsoljuk a TV Doktort és új csatornára váltunk, amelynek csak felhő/TV Doktor profilja van,
  // a lejátszó visszaáll az eredeti TS alapértelmezésre:
  window.__DOCTOR_UI__.recordDoctorChannelSuccess({
    channel: { id: 'cloud-only-id', name: '[HU] TV2 HD' },
    format: 'hls',
    bufferProfile: 'stable',
    startupMs: 310,
  });
  window.__DOCTOR_UI__.setSettings({ tvDoctorEnabled: false });
  await wait(40);
  playedUrls.length = 0;
  window.__DOCTOR_UI__.setChannel({
    id: 'local-tv2-unremembered',
    name: '[HU] TV2 HD',
    streamUrl: 'http://stream.example:8080/live/u/p/702.ts',
  });
  await wait(80);
  check(
    playedUrls.length >= 1 && playedUrls[0].endsWith('/702.ts'),
    'kikapcsolt TV Doktornál a VideoPlayer azonnal visszaáll az eredeti TS lejátszási mechanizmusra',
  );
} finally {
  dom.window.close();
}

console.log(`\nTV Doktor tesztek összesen: ${passed} sikeres, ${failed} hibás.`);
if (failed > 0) process.exit(1);
console.log('OK: a TV Doktor minden egység-, UI-, lejátszó- és hibrid felhőtesztje sikeres! ✅');
