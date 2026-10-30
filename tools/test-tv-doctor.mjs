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

// 1.7 VOD (Filmek és Sorozatok) TV Doktor támogatás: valós idejű lejátszássegítés MEMÓRIA- ÉS NAPLÓMENTÉS NÉLKÜL
const vodStore = new MemoryStorage();
const sampleMovie = {
  id: 'vod:901',
  title: 'Dűne: Második rész (2024)',
  streamUrl: 'http://panel.example:8080/movie/titkosUser/titkosPass/901.mkv',
  mediaKind: 'movie',
};
const sampleEpisode = {
  id: 'ep:4402',
  title: 'A Hatalom Gyűrűi - S02E03',
  streamUrl: 'http://panel.example:8080/series/titkosUser/titkosPass/4402.mp4',
  mediaKind: 'series',
};

const movieKey = core.normalizeVodDoctorKey(sampleMovie);
const episodeKey = core.normalizeVodDoctorKey(sampleEpisode);
check(
  movieKey === 'vod:movie:dune-masodik-resz-2024' &&
    episodeKey === 'vod:series:a-hatalom-gyurui-s02e03' &&
    !movieKey.includes('titkos') &&
    !episodeKey.includes('titkos'),
  'a VOD (film és sorozat) kulcsképzés ékezetmentes, elkülöníti a filmet és sorozatot, és nem tartalmaz hitelesítő adatot',
);

const movieInitialPlan = core.selectVodLaunchPlan(sampleMovie, core.INITIAL_SETTINGS, vodStore);
check(
  movieInitialPlan.enabled === true &&
    movieInitialPlan.hasLearnedProfile === false &&
    movieInitialPlan.startupWatchdogMs >= 8500,
  'új film indításakor a VOD TV Doktor terv biztonságos (≥ 8,5 mp) indulási őrrel és valós idejű alap pufferrel indul',
);

core.recordDoctorVodFailure({
  target: sampleMovie,
  bufferProfile: 'balanced',
  trigger: 'buffer_stall',
  errorCode: 'BUFFER_STALL',
  errorDetail: 'pufferelés elakadt',
  stallMs: 6200,
  storage: vodStore,
});
const vodRepair1 = core.planVodDoctorRepairStep({
  target: sampleMovie,
  trigger: 'buffer_stall',
  step: 1,
  currentBufferProfile: 'balanced',
  streamUrl: sampleMovie.streamUrl,
  resumePositionSeconds: 745,
  storage: vodStore,
});
const vodRepairExhausted = core.planVodDoctorRepairStep({
  target: sampleMovie,
  trigger: 'buffer_stall',
  step: 6,
  currentBufferProfile: 'adaptive-3',
  streamUrl: sampleMovie.streamUrl,
  resumePositionSeconds: 745,
  storage: vodStore,
});
check(
  vodRepair1.exhausted === false &&
    vodRepair1.nextUrl === sampleMovie.streamUrl &&
    vodRepair1.nextUrl.endsWith('.mkv') &&
    !vodRepair1.description.includes('745') &&
    vodRepair1.nextBufferTiming.minBufferAheadSeconds > core.DOCTOR_BUFFER_CONFIGS.balanced.minBufferAheadSeconds &&
    vodRepair1.nextBufferTiming.minBufferAheadSeconds <= 10.0 &&
    vodRepairExhausted.exhausted === true,
  'a VOD javító valós időben segíti a folyamatos lejátszást (.mkv/.mp4 megőrzése, pufferemelés ≤ 10 mp-ig), pozíciószöveg naplózása nélkül',
);

core.recordDoctorVodSuccess({
  target: sampleEpisode,
  bufferProfile: 'stable',
  startupMs: 620,
  wasRepair: true,
  storage: vodStore,
});
const vodLogsCheck = core.getTvDoctorSummary(vodStore).recentLogs;
check(
  vodStore.getItem(core.TV_DOCTOR_STORAGE_KEY) === null &&
    core.getVodDoctorRecord(sampleMovie, vodStore) === null &&
    core.getVodDoctorRecord(sampleEpisode, vodStore) === null &&
    core.isVodHandledByDoctor(sampleMovie, vodStore) === false &&
    core.isVodHandledByDoctor(sampleEpisode, vodStore) === false &&
    !vodLogsCheck.some((l) => l.channelName.includes('Dűne') || l.channelName.includes('Hatalom') || l.message.includes('745')),
  'a TV Doktor SOHA nem menti el memóriába vagy naplóba, hogy melyik film vagy sorozat akadt el, illetve hol akadt el',
);

// Korábbi (legacy) tárolt VOD bejegyzések automatikus kiszűrése beolvasáskor:
const legacyVodStore = new MemoryStorage();
legacyVodStore.setItem(
  core.TV_DOCTOR_STORAGE_KEY,
  JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    byKey: {
      'vod:movie:regi-film': {
        channelKey: 'vod:movie:regi-film',
        channelIdHint: 'vod:1',
        channelName: 'Régi Film',
        countryCode: 'VOD',
        bestFormat: 'ts',
        bestBufferProfile: 'stable',
        tsAvgStartupMs: 500,
        hlsAvgStartupMs: null,
        tsOk: 1,
        tsFail: 1,
        hlsOk: 0,
        hlsFail: 0,
        stalls: 1,
        repairsOk: 1,
        bufferScores: {},
        updatedAt: Date.now(),
        source: 'local',
      },
      'hu:m4-sport': {
        channelKey: 'hu:m4-sport',
        channelIdHint: 'ch-1',
        channelName: 'M4 Sport HD',
        countryCode: 'HU',
        bestFormat: 'ts',
        bestBufferProfile: 'balanced',
        tsAvgStartupMs: 420,
        hlsAvgStartupMs: null,
        tsOk: 3,
        tsFail: 0,
        hlsOk: 0,
        hlsFail: 0,
        stalls: 0,
        repairsOk: 0,
        bufferScores: {},
        updatedAt: Date.now(),
        source: 'local',
      },
    },
  }),
);
const cleanedSummary = core.getTvDoctorSummary(legacyVodStore);
check(
  cleanedSummary.learnedChannelCount === 1 &&
    core.getVodDoctorRecord({ title: 'Régi Film', mediaKind: 'movie' }, legacyVodStore) === null,
  'a korábbi tárolóból a vod: film/sorozat profilok automatikusan kiszűrődnek, miközben az élő TV profilok megmaradnak',
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
const dbPairingCodes = [];
const dbPairedDevices = new Map();
let codeIdSeq = 1;
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const urlStr = String(url);
  if (urlStr.startsWith('https://mock-db.supabase.co/rest/v1/tv_doctor_pairing_codes')) {
    const method = (init.method || 'GET').toUpperCase();
    const parsedUrl = new URL(urlStr);
    const sp = parsedUrl.searchParams;
    if (method === 'GET') {
      let rows = [...dbPairingCodes];
      const statusEq = sp.get('status');
      if (statusEq && statusEq.startsWith('eq.')) {
        const wanted = statusEq.slice(3);
        rows = rows.filter((r) => r.status === wanted);
      }
      const createdGt = sp.get('created_at');
      if (createdGt && createdGt.startsWith('gt.')) {
        const gtMs = Date.parse(createdGt.slice(3));
        rows = rows.filter((r) => Date.parse(r.created_at) > gtMs);
      }
      rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST') {
      const payload = JSON.parse(init.body || '{}');
      const items = Array.isArray(payload) ? payload : [payload];
      const inserted = items.map((item) => {
        const rec = { id: `code-${codeIdSeq++}`, ...item };
        dbPairingCodes.push(rec);
        return rec;
      });
      return new Response(JSON.stringify(inserted), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(init.body || '{}');
      const idEq = sp.get('id');
      const statusEq = sp.get('status');
      const reqDevEq = sp.get('requested_device_id');
      const updated = [];
      for (const row of dbPairingCodes) {
        if (idEq && idEq.startsWith('eq.') && row.id !== idEq.slice(3)) continue;
        if (statusEq && statusEq.startsWith('eq.') && row.status !== statusEq.slice(3)) continue;
        if (reqDevEq && reqDevEq.startsWith('eq.') && row.requested_device_id !== reqDevEq.slice(3)) continue;
        Object.assign(row, patch);
        updated.push({ ...row });
      }
      return new Response(JSON.stringify(updated), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  if (urlStr.startsWith('https://mock-db.supabase.co/rest/v1/tv_doctor_paired_devices')) {
    const method = (init.method || 'GET').toUpperCase();
    const parsedUrl = new URL(urlStr);
    const sp = parsedUrl.searchParams;
    if (method === 'GET') {
      let rows = Array.from(dbPairedDevices.values());
      const devEq = sp.get('device_id');
      if (devEq && devEq.startsWith('eq.')) {
        rows = rows.filter((r) => r.device_id === devEq.slice(3));
      }
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'POST') {
      const incoming = JSON.parse(init.body || '[]');
      const items = Array.isArray(incoming) ? incoming : [incoming];
      const saved = items.map((row) => {
        const merged = { ...(dbPairedDevices.get(row.device_id) || {}), ...row };
        dbPairedDevices.set(row.device_id, merged);
        return merged;
      });
      return new Response(JSON.stringify(saved), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(init.body || '{}');
      const devEq = sp.get('device_id');
      if (devEq && devEq.startsWith('eq.')) {
        const existing = dbPairedDevices.get(devEq.slice(3));
        if (existing) Object.assign(existing, patch);
      }
      return new Response(null, { status: 204 });
    }
  }
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

// Segédfüggvény egy teszt-TV párosításához (pair_request + Supabase oldali kódkiolvasás + pair_verify)
async function pairMockTv(deviceId, tvModel) {
  const reqHttp = await edgeHandler(
    new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pair_request', deviceId, tvModel }),
    }),
  );
  const reqJson = await reqHttp.json();
  // Biztonsági ellenőrzés: a nyilvános HTTP válaszban SOHA nem szerepelhet a 6 jegyű kód!
  const codeRow = dbPairingCodes.find((r) => r.requested_device_id === deviceId && r.status === 'pending');
  assert.equal(reqJson.ok, true);
  assert.equal(JSON.stringify(reqJson).includes(codeRow.pairing_code), false);

  const verHttp = await edgeHandler(
    new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pair_verify', deviceId, code: codeRow.pairing_code, tvModel }),
    }),
  );
  const verJson = await verHttp.json();
  assert.equal(verJson.ok, true);
  return { deviceId, deviceToken: verJson.deviceToken, codeUsed: codeRow.pairing_code };
}

// 2.0 Nem párosított TV elutasítása (status, bootstrap és sync végpontokon egyaránt!)
const unpairedAttemptHttp = await edgeHandler(
  new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'bootstrap', deviceId: 'LG-IDEGEN-TV99' }),
  }),
);
const unpairedAttemptJson = await unpairedAttemptHttp.json();
check(
  unpairedAttemptHttp.status === 401 && unpairedAttemptJson.ok === false && unpairedAttemptJson.paired === false,
  'nem párosított TV kérését a Supabase Edge Function azonnal elutasítja (HTTP 401)',
);

// 2.1 Próbálkozási korlát (max 5 hibás kód -> zárolás) és egyszer használatos kód ellenőrzése
await edgeHandler(
  new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pair_request', deviceId: 'LG-BRUTE-TEST' }),
  }),
);
const bruteRow = dbPairingCodes.find((r) => r.requested_device_id === 'LG-BRUTE-TEST' && r.status === 'pending');
const wrongCode = bruteRow.pairing_code === '123456' ? '654321' : '123456';
let lastBruteStatus = 0;
for (let attempt = 0; attempt < 5; attempt++) {
  const r = await edgeHandler(
    new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pair_verify', deviceId: 'LG-BRUTE-TEST', code: wrongCode }),
    }),
  );
  lastBruteStatus = r.status;
}
const afterLockRightCodeResp = await edgeHandler(
  new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pair_verify', deviceId: 'LG-BRUTE-TEST', code: bruteRow.pairing_code }),
  }),
);
check(
  lastBruteStatus === 429 && afterLockRightCodeResp.status !== 200 && bruteRow.status === 'locked',
  '5 hibás 6 jegyű kódpróbálkozás után a kód zárolódik, és többé a helyes kóddal sem használható fel',
);

// Párosítjuk a 2 jogosult teszt-TV-t és ellenőrizzük, hogy ugyanaz a kód másodszor NEM használható fel:
const tv1Auth = await pairMockTv('LG-OLED-TV01', 'OLED55C3');
const replayCodeResp = await edgeHandler(
  new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pair_verify', deviceId: 'LG-LOPOTT-TV02', code: tv1Auth.codeUsed }),
  }),
);
check(
  replayCodeResp.status === 401 && !dbPairedDevices.get('LG-OLED-TV01').token_hash.includes(tv1Auth.deviceToken),
  'a 6 jegyű párosítási kód szigorúan egyszer használatos, és a Supabase csak a token SHA-256 hash-ét tárolja',
);

// Másik, nem párosított TV hiába küldi el a párosított TV eszközazonosítóját érvényes token nélkül -> elutasítva!
const spoofedDeviceIdResp = await edgeHandler(
  new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tv-device-id': tv1Auth.deviceId,
      'x-tv-device-token': 'tvd_0000000000000000000000000000000000000000000000000000000000000000',
    },
    body: JSON.stringify({ action: 'status', deviceId: tv1Auth.deviceId }),
  }),
);
check(
  spoofedDeviceIdResp.status === 401,
  'pusztán az eszközazonosító bemondása hamis tokennel HTTP 401 elutasítást eredményez (másik TV kizárva)',
);

const tv2Auth = await pairMockTv('LG-NANO-TV02', '55NANO81');

// Két külön párosított TV szinkronizálja tapasztalatát ugyanarra a csatornára az Edge Functionön keresztül:
const tv1SyncResp = await (
  await edgeHandler(
    new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tv-device-id': tv1Auth.deviceId,
        'x-tv-device-token': tv1Auth.deviceToken,
      },
      body: JSON.stringify({
        action: 'sync',
        deviceId: tv1Auth.deviceId,
        deviceToken: tv1Auth.deviceToken,
        tvModel: 'OLED55C3',
        webosVersion: '8.3.0',
        appVersion: '2.5.196',
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
      headers: {
        'Content-Type': 'application/json',
        'x-tv-device-id': tv2Auth.deviceId,
        'x-tv-device-token': tv2Auth.deviceToken,
      },
      body: JSON.stringify({
        action: 'sync',
        deviceId: tv2Auth.deviceId,
        deviceToken: tv2Auth.deviceToken,
        tvModel: '55NANO81',
        webosVersion: '7.2.0',
        appVersion: '2.5.196',
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
  'a párosított TV-k hitelesített szinkronját a Supabase Edge Function elfogadja és összesíti',
);
check(
  dbEvents.length === 1 && !JSON.stringify(dbEvents[0]).includes('userA') && !JSON.stringify(dbEvents[0]).includes('passB'),
  'a Supabase szerveroldalon is kiszűr minden hitelesítő adatot a tárolás előtt',
);

// 2.2 Saját TV kliensoldali egyszeri párosítása, újraindítás-tűrés, csendes tokenmegújítás és késleltetésmentes működés!
globalThis.localStorage = new MemoryStorage();
core.clearTvDoctorMemory();
core.clearTvDoctorCloudQueue();
await core.reloadTvDoctorPairingFromStorage();
core.configureTvDoctorCloud(true);

// Párosítás ELŐTT: a helyi TV Doktor 0 ms késleltetéssel működik, de a védett felhőadatokat nem tölti le:
const localStartMs = performance.now();
const unpairedLocalPlan = core.selectChannelLaunchPlan(
  { id: 'ch-local-fast', name: '[HU] TV2 HD' },
  'http://panel.local:8080/live/u/p/111.ts',
  core.INITIAL_SETTINGS,
);
const localElapsedMs = performance.now() - localStartMs;
const unpairedBootstrapCount = await core.bootstrapTvDoctorFromCloud();
check(
  unpairedBootstrapCount === 0 &&
    core.getTvDoctorPairingInfo().paired === false &&
    localElapsedMs < 15 &&
    unpairedLocalPlan.primaryFormat === 'ts',
  'párosítás nélkül a helyi TV Doktor korlátozás és lassulás nélkül működik, a védett felhőadatokat viszont nem éri el',
);

// Kliensről Új kód igénylése -> kód kiolvasása Supabase-ből -> egyszeri 6 jegyű párosítás!
const clientReqRes = await core.requestTvDoctorPairingCode();
const clientDeviceId = core.getTvDoctorPairingInfo().deviceId;
const clientPendingRow = dbPairingCodes.find((r) => r.requested_device_id === clientDeviceId && r.status === 'pending');
check(
  clientReqRes.ok === true &&
    Boolean(clientPendingRow) &&
    /^[0-9]{6}$/.test(clientPendingRow.pairing_code) &&
    !JSON.stringify(clientReqRes).includes(clientPendingRow.pairing_code),
  'az Új kód igénylése biztonságosan létrehozza a 6 jegyű kódot a Supabase-ben anélkül, hogy a kliensnek visszaadná',
);

const clientVerifyRes = await core.verifyTvDoctorPairingCode(clientPendingRow.pairing_code);
check(
  clientVerifyRes.ok === true &&
    clientVerifyRes.paired === true &&
    core.getTvDoctorPairingInfo().paired === true &&
    core.getTvDoctorPairingInfo().uiState === 'paired',
  'egyszeri 6 jegyű kódbevitel után a TV sikeresen párosul és megkapja a saját tartós eszköztokenjét',
);

// Alkalmazás bezárása / TV kikapcsolása és hideg újraindítása után a párosítás megmarad kódkérés nélkül!
await new Promise((r) => setTimeout(r, 40));
core.clearTvDoctorMemory();
core.clearTvDoctorCloudQueue();
const afterRestartInfo = await core.reloadTvDoctorPairingFromStorage();
const downloadedCount = await core.bootstrapTvDoctorFromCloud();
check(
  afterRestartInfo.paired === true &&
    afterRestartInfo.deviceId === clientDeviceId &&
    downloadedCount >= 1,
  'alkalmazás-újraindítás után a TV ismételt kódkérés nélkül hitelesítve marad és letölti a védett profilokat',
);

// Háttérbeli csendes tokenmegújítás (rotateToken) kézi kódbevitel nélkül:
const rawBeforeRotate = JSON.parse(globalThis.localStorage.getItem(core.TV_DOCTOR_PAIRING_STORAGE_KEY)).deviceToken;
const statusAfterRotate = await core.checkTvDoctorConnection(5000, { rotateToken: true });
const rawAfterRotate = JSON.parse(globalThis.localStorage.getItem(core.TV_DOCTOR_PAIRING_STORAGE_KEY)).deviceToken;
check(
  statusAfterRotate.connected === true &&
    Boolean(rawAfterRotate) &&
    rawAfterRotate !== rawBeforeRotate &&
    dbPairedDevices.get(clientDeviceId).rotation_count >= 1,
  'az eszköztoken a háttérben automatikusan megújítható/lecserélhető kézi kódbevitel és fennakadás nélkül',
);

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

// VOD (film és sorozat) SOHA nem kerülhet be a Supabase várólistába vagy a központi adatbázisba:
core.recordDoctorVodFailure({
  target: {
    id: 'vod:7788',
    title: 'Gladiátor II (2024)',
    streamUrl: 'http://panel.local:8080/movie/titkosU/titkosP/7788.mkv',
    mediaKind: 'movie',
  },
  bufferProfile: 'balanced',
  trigger: 'playback_stall',
  stallMs: 4800,
});
core.recordDoctorVodSuccess({
  target: {
    id: 'vod:7788',
    title: 'Gladiátor II (2024)',
    streamUrl: 'http://panel.local:8080/movie/titkosU/titkosP/7788.mkv',
    mediaKind: 'movie',
  },
  bufferProfile: 'stable',
  startupMs: 540,
  wasRepair: true,
});
const pendingAfterVod = core.getTvDoctorCloudStatus().pendingCount;
const activePairToken = JSON.parse(globalThis.localStorage.getItem(core.TV_DOCTOR_PAIRING_STORAGE_KEY)).deviceToken;
const vodRejectResp = await edgeHandler(
  new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tv-device-id': clientDeviceId,
      'x-tv-device-token': activePairToken,
    },
    body: JSON.stringify({
      action: 'sync',
      deviceId: clientDeviceId,
      profiles: [
        {
          channelKey: 'vod:movie:gladiator-ii-2024',
          channelName: 'Gladiátor II (2024)',
          countryCode: 'VOD',
          bestFormat: 'ts',
          bestBufferProfile: 'stable',
          tsSuccessDelta: 1,
        },
      ],
      events: [
        {
          eventUid: 'vod-ev-1',
          eventType: 'freeze_detected',
          channelKey: 'vod:movie:gladiator-ii-2024',
          channelName: 'Gladiátor II (2024)',
          stallMs: 4800,
        },
      ],
    }),
  }),
);
const vodRejectJson = await vodRejectResp.json();
check(
  pendingAfterVod === 0 &&
    vodRejectResp.status === 200 &&
    vodRejectJson.syncedProfiles === 0 &&
    vodRejectJson.syncedEvents === 0 &&
    !dbProfiles.has('vod:movie:gladiator-ii-2024'),
  'sem a kliens várólista, sem a Supabase Edge Function nem ment el VOD (film/sorozat) címet vagy elakadási pozíciót',
);

// Párosítás visszavonása (unpair): a Supabase-ben revoked=true lesz, és a régi tokennel semmilyen hozzáférés nem engedélyezett!
const savedTokenBeforeUnpair = JSON.parse(globalThis.localStorage.getItem(core.TV_DOCTOR_PAIRING_STORAGE_KEY)).deviceToken;
await core.unpairTvDoctorDevice();
const replayRevokedResp = await edgeHandler(
  new Request('https://hlklmcujvqsatwvdygqp.supabase.co/functions/v1/tv-doctor', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tv-device-id': clientDeviceId,
      'x-tv-device-token': savedTokenBeforeUnpair,
    },
    body: JSON.stringify({ action: 'status', deviceId: clientDeviceId }),
  }),
);
const replayRevokedJson = await replayRevokedResp.json();
check(
  core.getTvDoctorPairingInfo().paired === false &&
    dbPairedDevices.get(clientDeviceId)?.revoked === true &&
    replayRevokedResp.status === 401 &&
    replayRevokedJson.error === 'device_revoked',
  'a párosítás visszavonása után a token azonnal érvénytelenné válik a Supabase szerveren is (HTTP 401 device_revoked)',
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
import { TvDoctorStatusModal } from './web/src/components/TvDoctorStatusModal.tsx';
import { DiagnosticShareModal } from './web/src/components/DiagnosticShareModal.tsx';
import { VideoPlayer } from './web/src/components/VideoPlayer.tsx';
import { ChannelList } from './web/src/components/ChannelList.tsx';
import { INITIAL_SETTINGS } from './web/src/data/mockData.ts';
import { saveLiveContentSafely } from './web/src/services/contentStore.ts';
import { storageService } from './web/src/services/storageService.ts';
import {
  recordDoctorChannelSuccess,
  recordDoctorChannelFailure,
  recordDoctorVodSuccess,
  recordDoctorVodFailure,
  evaluateSmartFreeze,
  recordDoctorOpTiming,
  clearTvDoctorMemory,
  getChannelDoctorRecord,
  isChannelHandledByDoctor,
  isVodHandledByDoctor,
  getTvDoctorMemoryStats,
  getTvDoctorSummary,
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

const SAMPLE_LIST_CHANNELS = [
  {
    id: 'ch-handled',
    name: '[HU] M4 Sport HD',
    categoryId: 'hu',
    countryCode: 'HU',
    streamUrl: 'http://stream.example:8080/live/u/p/101.ts',
    isFavorite: true,
    channelNumber: 1,
  },
  {
    id: 'ch-untouched',
    name: '[HU] Duna World HD',
    categoryId: 'hu',
    countryCode: 'HU',
    streamUrl: 'http://stream.example:8080/live/u/p/102.ts',
    isFavorite: false,
    channelNumber: 2,
  },
  {
    id: 'ch-third',
    name: '[HU] Spektrum HD',
    categoryId: 'hu',
    countryCode: 'HU',
    streamUrl: 'http://stream.example:8080/live/u/p/103.ts',
    isFavorite: false,
    channelNumber: 3,
  },
];

function TestApp({ initialMode }) {
  const [settings, setSettings] = useState({ ...INITIAL_SETTINGS });
  const [isPlaying, setIsPlaying] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [customStreamUrl, setCustomStreamUrl] = useState(undefined);
  const [customTitle, setCustomTitle] = useState(undefined);
  const [subtitleSource, setSubtitleSource] = useState(undefined);
  const [selectedListId, setSelectedListId] = useState('ch-handled');
  const [favoriteClickedFor, setFavoriteClickedFor] = useState(null);
  const [channel, setChannel] = useState({
    id: 'ch-atv',
    name: '[HU] ATV HD',
    streamUrl: 'http://stream.example:8080/live/u/p/701.ts',
  });
  window.__DOCTOR_UI__ = {
    getSettings: () => settings,
    setSettings: (patch) => setSettings((s) => ({ ...s, ...patch })),
    setChannel,
    setIsFullscreen: (fsOn) => {
      if (fsOn) {
        window.dispatchEvent(new window.CustomEvent('iptv-enter-fullscreen'));
      }
    },
    setVodPlayback: ({ url, title, subSource }) => {
      setCustomStreamUrl(url);
      setCustomTitle(title);
      setSubtitleSource(subSource);
    },
    getSelectedListId: () => selectedListId,
    getFavoriteClickedFor: () => favoriteClickedFor,
    recordDoctorChannelSuccess,
    recordDoctorChannelFailure,
    recordDoctorVodSuccess,
    recordDoctorVodFailure,
    evaluateSmartFreeze,
    recordDoctorOpTiming,
    clearTvDoctorMemory,
    getChannelDoctorRecord,
    isChannelHandledByDoctor,
    isVodHandledByDoctor,
    getTvDoctorMemoryStats,
    getTvDoctorSummary,
    configureTvDoctorCloud,
    checkTvDoctorConnection,
    getTvDoctorCloudStatus,
    resetTvDoctorAllToZero,
    getAppLogText,
    manualLogSnapshot,
  };
  if (initialMode === 'doctorModal') {
    return React.createElement(TvDoctorStatusModal, {
      isOpen: true,
      onClose: () => { window.__DOCTOR_MODAL_CLOSED__ = true; },
      settings,
      activeChannel: channel,
    });
  }
  if (initialMode === 'channelList') {
    return React.createElement(
      'div',
      { 'data-live-sidebar': '', style: { width: '420px', height: '640px' } },
      React.createElement(ChannelList, {
        channels: SAMPLE_LIST_CHANNELS,
        categories: [{ id: 'hu', name: 'Magyarország', code: 'HU' }],
        selectedChannel: SAMPLE_LIST_CHANNELS.find((c) => c.id === selectedListId) || SAMPLE_LIST_CHANNELS[0],
        onSelectChannel: (ch) => setSelectedListId(ch.id),
        onToggleFavorite: (id) => setFavoriteClickedFor(id),
        searchQuery: '',
        selectedCategory: 'all',
        onSelectCategory: () => {},
        folders: [{ id: 'f1', name: 'Kedvencek', channelIds: ['ch-handled'] }],
        selectedFolderId: null,
        onAssignToFolder: (chId) => setFavoriteClickedFor(chId),
        tvDoctorEnabled: settings.tvDoctorEnabled !== false,
        isActive: true,
      }),
    );
  }
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
    customStreamUrl,
    customTitle,
    subtitleSource,
    settings,
    isPlaying,
    setIsPlaying,
    isFullscreen,
    onToggleFullscreen: () => setIsFullscreen((f) => !f),
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

window.__MOUNT_FULL_APP__ = async () => {
  storageService.saveHistory([
    {
      id: 'hist-vod-1',
      title: 'Dűne (2021)',
      mediaType: 'movie',
      streamUrl: 'http://stream.example:8080/movie/u/p/7701.mkv',
      positionSeconds: 180,
      durationSeconds: 7200,
      updatedAt: new Date().toISOString(),
    },
  ]);
  saveLiveContentSafely({
    provider: { id: 'prov-1', name: 'Éles Szolgáltató', type: 'xtream' },
    channels: SAMPLE_LIST_CHANNELS,
    liveCategories: [{ id: 'country-HU', name: 'Magyarország', flag: '🇭🇺', channelCount: 3, type: 'live' }],
    vodCategories: [],
    seriesCategories: [],
    movies: [],
    series: [],
    totals: { live: 3, vod: 1, series: 1 },
  });
  const mod = await import('./web/src/App.tsx');
  if (root) root.unmount();
  root = createRoot(document.getElementById('root'));
  root.render(React.createElement(mod.App));
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
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.action === 'pair_request') {
          return new Response(
            JSON.stringify({
              ok: true,
              requested: true,
              deviceId: body.deviceId,
              expiresAt: '2026-10-29T20:10:00.000Z',
              expiresInSeconds: 600,
              maxAttempts: 5,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (body.action === 'pair_verify') {
          if (body.code === '408015') {
            return new Response(
              JSON.stringify({
                ok: true,
                paired: true,
                deviceId: body.deviceId,
                deviceToken: 'tvd_a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
                pairedAt: '2026-10-29T19:29:00.000Z',
                tokenExpiresAt: '2027-04-27T19:29:00.000Z',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              ok: false,
              error: 'invalid_code',
              remainingAttempts: 4,
              message: 'Hibás párosítási kód (4 próbálkozás maradt).',
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
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
          JSON.stringify({ ok: true, paired: true, profileCount: 18, serverTime: '2026-10-29T19:30:00.000Z' }),
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
  const allBoxes = Array.from(doc.querySelectorAll('[data-tv-box]'));
  const doctorBox = doc.querySelector('[data-tv-doctor-box]');
  const doctorFooter = doc.querySelector('[data-tv-doctor-footer]');
  const doctorExpandBtn = doc.querySelector('[data-tv-doctor-expand]');
  const doctorResetBtn = doc.querySelector('[data-tv-doctor-reset]');
  const doctorToggle = doc.querySelector('[data-tv-doctor-toggle]');
  const doctorMenuIcon = doc.querySelector('[data-tv-doctor-menu-icon] [data-tv-doctor-svg]');
  const shortDesc = doc.querySelector('[data-tv-doctor-short-desc]');
  const pairingBox = doc.querySelector('[data-tv-doctor-pairing-box]');
  const pairingMenuBtn = doc.querySelector('[data-tv-doctor-pairing-menu]');

  check(
    allBoxes[0] === doctorBox &&
      doctorBox.hasAttribute('data-tv-default') &&
      !doc.querySelector('[data-buffer-mode]') &&
      !(doc.body.textContent || '').includes('Pufferelés'),
    'a Rendszer fülön a TV Doktor a legelső elem, a Lejátszó sárga felirat és a Pufferelés doboz vizuálisan el van távolítva',
  );
  check(
    Boolean(doctorMenuIcon) &&
      doctorMenuIcon.getAttribute('data-doctor-handled') === 'true' &&
      Boolean(shortDesc) &&
      shortDesc.className.includes('line-clamp-2'),
    'a TV Doktor dobozban a zöld 3D TV Doktor ikon szerepel, és a Minden rendben alatti szöveg rövid, maximum 2 soros',
  );
  check(
    doctorFooter === null &&
      doctorExpandBtn === null &&
      doctorResetBtn === null &&
      !doc.querySelector('[data-tv-doctor-details]') &&
      Boolean(doctorToggle),
    'a Beállítások → Rendszer → TV Doktor dobozban NEM látszik sem a sárga Állapot/Napló gomb, sem a piros Memória: 0 gomb — csak a Ki/Be kapcsoló és a feliratok',
  );
  check(doctorToggle.getAttribute('aria-checked') === 'true', 'alapértelmezetten a TV Doktor aktív');

  // Távirányítós OK a TV Doktor dobozon közvetlenül a Ki/Be kapcsolót váltja:
  doctorBox.focus();
  doctorBox.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await wait(45);
  check(
    window.__DOCTOR_UI__.getSettings().tvDoctorEnabled === false &&
      doc.querySelector('[data-tv-doctor-toggle]').getAttribute('aria-checked') === 'false',
    'a Rendszer → TV Doktor dobozon az OK (Enter) gomb közvetlenül átkapcsolja a TV Doktor kapcsolót',
  );
  doctorBox.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await wait(45);
  check(
    window.__DOCTOR_UI__.getSettings().tvDoctorEnabled === true &&
      doc.querySelector('[data-tv-doctor-toggle]').getAttribute('aria-checked') === 'true',
    'a Rendszer → TV Doktor dobozon az ismételt OK (Enter) visszakapcsolja a TV Doktort',
  );

  // Különálló Supabase-párosítás menüpont távirányítós megnyitása és 0-kat tartalmazó 6 jegyű párosítás végigvitele:
  check(
    Boolean(pairingBox) && Boolean(pairingMenuBtn) && (pairingBox.textContent || '').includes('Supabase-párosítás'),
    'a TV Doktor menü alatt megjelenik a különálló Supabase-párosítás menüpont',
  );
  pairingBox.focus();
  pairingBox.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await wait(80);

  const pairingModal = doc.querySelector('[data-supabase-pairing-modal]');
  check(
    Boolean(pairingModal) &&
      pairingModal.querySelector('[data-tv-doctor-pair-status]')?.getAttribute('data-pair-state') === 'unpaired' &&
      (pairingModal.textContent || '').includes('Nincs párosítva') &&
      (pairingModal.textContent || '').includes('Eszköz azonosítója:'),
    'a Supabase-párosítás ablak távirányítóval megnyílik, mutatja a Nincs párosítva állapotot és az Eszköz azonosítóját',
  );

  // Új kód igénylése + hibás kód állapotjelzés + 0-kat tartalmazó érvényes 6 jegyű kód (408015) távirányítós számgombokkal:
  pairingModal.querySelector('[data-tv-doctor-pair-request]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await wait(60);

  for (const d of ['1', '0', '1', '0', '1', '2']) {
    pairingModal.dispatchEvent(new window.KeyboardEvent('keydown', { key: d, bubbles: true, cancelable: true }));
  }
  await wait(30);
  pairingModal.querySelector('[data-tv-doctor-pair-verify]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await wait(70);
  check(
    pairingModal.querySelector('[data-tv-doctor-pair-status]')?.getAttribute('data-pair-state') === 'error' &&
      (pairingModal.textContent || '').includes('Állapot: Hiba'),
    'hibás 6 jegyű kódnál a párosítási képernyő egyértelmű Hiba állapotot jelez',
  );

  // Ürítés + a 0-kat tartalmazó helyes 6 jegyű kód (408015) beírása távirányítóval -> Sikeres párosítás!
  pairingModal.querySelector('[data-tv-doctor-digit-clear]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await wait(25);
  for (const d of ['4', '0', '8', '0', '1', '5']) {
    pairingModal.dispatchEvent(new window.KeyboardEvent('keydown', { key: d, code: `Digit${d}`, keyCode: 48 + Number(d), bubbles: true, cancelable: true }));
  }
  await wait(30);
  pairingModal.querySelector('[data-tv-doctor-pair-verify]').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await wait(90);
  check(
    pairingModal.querySelector('[data-tv-doctor-pair-status]')?.getAttribute('data-pair-state') === 'paired' &&
      (pairingModal.textContent || '').includes('Sikeres párosítás') &&
      (pairingModal.textContent || '').includes('LG-') &&
      !doc.querySelector('[data-tv-doctor-modal]'),
    '0 számjegyeket tartalmazó helyes 6 jegyű kód (408015) után Sikeres párosítás állapot jelenik meg, a TV Doktor napló nem nyílik meg',
  );

  // Vissza (Escape) bezárja a párosítási ablakot, a Beállítások menü nyitva marad, a jelvény Párosítva állapotra vált:
  pairingModal.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await wait(60);
  check(
    !doc.querySelector('[data-supabase-pairing-modal]') &&
      (doc.querySelector('[data-tv-doctor-pairing-badge]')?.textContent || '').includes('Párosítva'),
    'Vissza gombbal csak a párosítási ablak záródik be, a menüsoron pedig látszik a Párosítva állapot',
  );

  // 3.1b 0-ás gombos 2 oszlopos TvDoctorStatusModal: bal oldalon lefelé görgethető napló,
  // jobb oldalon állandó adatok + jobb felső sarokban a piros Memória: 0 gomb + Supabase hibalokalizáció:
  mockCloudMode = 'ok';
  for (let i = 1; i <= 15; i += 1) {
    window.__DOCTOR_UI__.recordDoctorChannelSuccess({
      channel: { id: `ch-log-${i}`, name: `[HU] Teszt Adó ${i}`, countryCode: 'HU' },
      format: i % 2 === 0 ? 'hls' : 'ts',
      bufferProfile: 'balanced',
      startupMs: 300 + i * 10,
      wasRepair: i % 3 === 0,
    });
  }
  window.__DOCTOR_MODAL_CLOSED__ = false;
  window.__MOUNT_MODE__('doctorModal');
  await wait(90);

  const doctorModal = doc.querySelector('[data-tv-doctor-modal]');
  const leftPane = doc.querySelector('[data-tv-doctor-left-pane]');
  const rightPane = doc.querySelector('[data-tv-doctor-right-pane]');
  const logScroll = doc.querySelector('[data-tv-doctor-log-scroll]');
  const modalResetBtn = rightPane?.querySelector('[data-tv-doctor-reset]');

  check(
    Boolean(doctorModal) &&
      Boolean(leftPane) &&
      Boolean(rightPane) &&
      Boolean(logScroll) &&
      leftPane.contains(logScroll) &&
      !leftPane.querySelector('[data-tv-doctor-health]') &&
      !leftPane.querySelector('[data-tv-doctor-memory]') &&
      !leftPane.querySelector('[data-tv-doctor-reset]') &&
      Boolean(rightPane.querySelector('[data-tv-doctor-health]')) &&
      Boolean(rightPane.querySelector('[data-tv-doctor-supabase]')) &&
      Boolean(rightPane.querySelector('[data-tv-doctor-memory]')) &&
      Boolean(modalResetBtn) &&
      rightPane.textContent.includes('Létrejött ✓') &&
      rightPane.textContent.includes('18 db'),
    'a 0-ás gomb ablaka 2 oszlopos: bal oldalon kizárólag a Legutóbbi TV Doktor napló, jobb oldalon az állandó adatok és a jobb felső sarokban a piros Memória: 0 gomb',
  );

  // Lefelé menve végigolvasható napló távirányítóval (ArrowDown / ArrowUp):
  Object.defineProperty(logScroll, 'clientHeight', { value: 400, configurable: true });
  Object.defineProperty(logScroll, 'scrollHeight', { value: 1800, configurable: true });
  check(doc.activeElement === logScroll, 'megnyitáskor az alapértelmezett fókusz a bal oldali görgethető naplón áll');
  logScroll.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await wait(20);
  const scrollAfterDown1 = logScroll.scrollTop;
  logScroll.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await wait(20);
  const scrollAfterDown2 = logScroll.scrollTop;
  logScroll.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  await wait(20);
  const scrollAfterUp = logScroll.scrollTop;
  check(
    scrollAfterDown1 > 0 &&
      scrollAfterDown2 > scrollAfterDown1 &&
      scrollAfterUp < scrollAfterDown2 &&
      doc.activeElement === logScroll,
    'a bal oldali Legutóbbi TV Doktor napló távirányítóval (Le/Fel nyilakkal) valóban görgetve végigolvasható',
  );

  // Jobbra nyíllal átnavigálás a jobb felső sarokban lévő piros Memória: 0 gombra (elérhető távirányítóval!):
  logScroll.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  await wait(25);
  check(
    doc.activeElement === modalResetBtn,
    'a bal oldali naplóról Jobbra nyíllal közvetlenül elérhető a jobb felső sarokban lévő piros Memória: 0 gomb',
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
    'Supabase API-kulcs hibánál a jobb oldalon pontosan kiírja HOL a hiba (hitelesítés) és MI a teendő',
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

  // Memória: 0 gomb a jobb felső sarokban: nullázza a tanult profilokat, a naplót és a várólistát,
  // miközben NEM törli a listákat ÉS NEM szünteti meg a Supabase-párosítást!
  const memBeforeReset = window.__DOCTOR_UI__.getTvDoctorMemoryStats();
  modalResetBtn.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await wait(60);
  const memAfterReset = window.__DOCTOR_UI__.getTvDoctorMemoryStats();
  const cloudAfterReset = window.__DOCTOR_UI__.getTvDoctorCloudStatus();
  check(
    memBeforeReset.doctorTotalBytes > 0 &&
      memAfterReset.learnedChannelCount === 0 &&
      memAfterReset.doctorTotalBytes === 0 &&
      window.__DOCTOR_UI__.getTvDoctorSummary().recentLogs.length === 0 &&
      (doc.querySelector('[data-tv-doctor-log-count]')?.textContent || '').includes('0 sor') &&
      cloudAfterReset.pendingCount === 0 &&
      cloudAfterReset.paired === true &&
      window.localStorage.getItem('iptv_rt_providers_v1')?.includes('Éles Szolgáltató'),
    'a jobb sarokban lévő piros Memória: 0 gomb 0 B / 0 csatorna / 0 naplósor állapotra állítja a TV Doktort, miközben a párosítást és a csatornalistát érintetlenül hagyja',
  );

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

  /* ═════════════════════════════════════════════════════════════════════════
   * 4. FŐOLDALI CSATORNALISTA IKON, TELJES KÉPERNYŐS ÓRA ELŐTTI 3D DOKTOR IKON,
   *    VOD (FILM ÉS SOROZAT) VALÓDI MŰKÖDÉS ÉS AUTOMATIKUS ÁLLAPOTABLAK TESZT
   * ═════════════════════════════════════════════════════════════════════════ */
  console.log('\n4. Főoldali csatornalista 3D zöld állapotikon, teljes képernyős óra előtti ikon és aktív állapotablak (Élő TV + Film + Sorozat)');

  window.__DOCTOR_UI__.clearTvDoctorMemory();
  window.localStorage.clear();
  // Csak a ch-handled ([HU] M4 Sport HD) csatornát vizsgálta/kezelte eddig a TV Doktor:
  window.__DOCTOR_UI__.recordDoctorChannelSuccess({
    channel: { id: 'ch-handled', name: '[HU] M4 Sport HD', countryCode: 'HU' },
    format: 'ts',
    bufferProfile: 'balanced',
    startupMs: 410,
  });

  window.__MOUNT_MODE__('channelList');
  await wait(90);

  const stackHandled = doc.querySelector('[data-channel-right-stack="ch-handled"]');
  const stackUntouched = doc.querySelector('[data-channel-right-stack="ch-untouched"]');
  const stackThird = doc.querySelector('[data-channel-right-stack="ch-third"]');
  const starHandled = doc.querySelector('[data-favorite-star="ch-handled"]');
  const slotHandled = doc.querySelector('[data-tv-doctor-slot="ch-handled"]');
  const slotUntouched = doc.querySelector('[data-tv-doctor-slot="ch-untouched"]');
  const slotThird = doc.querySelector('[data-tv-doctor-slot="ch-third"]');
  const rowIconHandled = doc.querySelector('[data-tv-doctor-row-icon="ch-handled"]');
  const rowIconUntouched = doc.querySelector('[data-tv-doctor-row-icon="ch-untouched"]');
  const rowIconThird = doc.querySelector('[data-tv-doctor-row-icon="ch-third"]');

  check(
    Boolean(stackHandled && stackUntouched && stackThird) &&
      Boolean(slotHandled && slotUntouched && slotThird) &&
      stackHandled.firstElementChild === starHandled &&
      stackHandled.lastElementChild === slotHandled,
    'minden csatornasorban a kedvenc csillag feljebb került, és közvetlenül alatta egységesen ugyanazon a helyen ül a TV Doktor sáv',
  );

  const rowDoctorSvg = rowIconHandled?.querySelector('svg[data-tv-doctor-svg]');
  check(
    Boolean(rowIconHandled) &&
      rowIconHandled.getAttribute('data-doctor-color') === 'green' &&
      rowDoctorSvg?.getAttribute('data-doctor-handled') === 'true' &&
      !rowIconUntouched &&
      !rowIconThird,
    'a 3D zöld TV Doktor ikon KIZÁRÓLAG a TV Doktor által ténylegesen kezelt/megjegyzett csatornánál jelenik meg',
  );

  check(
    !slotHandled.hasAttribute('tabindex') &&
      !rowIconHandled.hasAttribute('tabindex') &&
      slotHandled.querySelectorAll('button, a, [tabindex]').length === 0 &&
      slotHandled.className.includes('pointer-events-none') &&
      (slotHandled.textContent || '').trim() === '' &&
      !doc.querySelector('[data-tv-doctor-status-window]'),
    'a főoldali csatornalista ikon tisztán passzív állapotjelző: nem fókuszálható, nem kattintható, nincs szöveg és nincs állapotablak a főoldalon',
  );

  // Ha a TV Doktor menet közben megvizsgál egy másik csatornát (ch-untouched), azonnal megjelenik a zöld ikon:
  window.__DOCTOR_UI__.recordDoctorChannelSuccess({
    channel: { id: 'ch-untouched', name: '[HU] Duna World HD', countryCode: 'HU' },
    format: 'hls',
    bufferProfile: 'fast',
    startupMs: 360,
  });
  await wait(60);
  check(
    Boolean(doc.querySelector('[data-tv-doctor-row-icon="ch-untouched"]')) &&
      !doc.querySelector('[data-tv-doctor-row-icon="ch-third"]'),
    'amikor a TV Doktor megvizsgál vagy megjegyez egy csatornát, a zöld 3D ikon valódi állapot alapján megjelenik',
  );

  // Memória 0-ra állításkor minden főoldali zöld ikon eltűnik (nem marad hamis/szimulált jelzés):
  window.__DOCTOR_UI__.clearTvDoctorMemory();
  await wait(60);
  check(
    doc.querySelectorAll('[data-tv-doctor-row-icon]').length === 0,
    'a TV Doktor memória 0-ra törlésekor a főoldali zöld állapotikonok is azonnal eltűnnek',
  );

  // 4.2 Teljes képernyős lejátszás – Élő TV, Film és Sorozat + óra előtti ikon + állapotablak
  window.__MOUNT_MODE__('player');
  await wait(70);
  window.__DOCTOR_UI__.setSettings({ tvDoctorEnabled: true, alwaysShowBlueClock: true });
  await wait(50);

  // Főoldali (nem teljes képernyős) lejátszónál sem a felső HUD, sem az állapotablak nem jelenhet meg:
  check(
    !doc.querySelector('[data-fullscreen-top-right]') &&
      !doc.querySelector('[data-tv-doctor-status-window]'),
    'főoldali (nem teljes képernyős) nézetben sem a teljes képernyős doktor HUD, sem az állapotablak nem jelenik meg',
  );

  // Belépés teljes képernyőre egy MÉG NEM KEZELT élő csatornával:
  window.__DOCTOR_UI__.setIsFullscreen(true);
  window.__DOCTOR_UI__.setChannel({
    id: 'ch-fresh-live',
    name: '[HU] Hir TV HD',
    streamUrl: 'http://stream.example:8080/live/u/p/777.ts',
  });
  await wait(80);

  const topRightRow = doc.querySelector('[data-fullscreen-top-right-row]');
  const fsDocIcon = doc.querySelector('[data-fullscreen-doctor-icon]');
  const fsBlueClock = doc.querySelector('[data-fullscreen-top-right-row] [data-blue-clock]');
  const fsStatusOnLiveLoad = doc.querySelector('[data-tv-doctor-status-window]');
  check(
    Boolean(topRightRow && fsDocIcon && fsBlueClock) &&
      topRightRow.children[0] === fsDocIcon &&
      topRightRow.children[1] === fsBlueClock &&
      fsDocIcon.className.includes('h-14') &&
      fsDocIcon.className.includes('w-14') &&
      fsBlueClock.className.includes('h-14'),
    'teljes képernyőn a jobb felső sarokban közvetlenül az óra ELŐTT jelenik meg a 3D TV Doktor ikon, az órával pontosan azonos (h-14) méretben',
  );
  check(
    fsDocIcon.getAttribute('data-doctor-handled') === 'false' &&
      Boolean(fsStatusOnLiveLoad) &&
      (fsStatusOnLiveLoad.textContent || '').includes('Csatorna betöltése'),
    'új élő csatornára váltáskor az óra előtti ikon jelzi, hogy még nem kezelt, alatta pedig megjelenik a félig átlátszó állapotablak',
  );

  // A lejátszás elindul (playing esemény) -> az ikon zöldre vált (handled=true), az állapotablak pedig automatikusan eltűnik, miközben az ikon látható marad!
  const videoEl = doc.querySelector('video');
  videoEl.dispatchEvent(new window.Event('playing'));
  await wait(780);
  check(
    doc.querySelector('[data-fullscreen-doctor-icon]')?.getAttribute('data-doctor-handled') === 'true' &&
      !doc.querySelector('[data-tv-doctor-status-window]') &&
      Boolean(doc.querySelector('[data-fullscreen-doctor-icon]')),
    'sikeres csatornaindulás után az óra előtti ikon zöld (kezelt) állapotra vált, az állapotablak automatikusan eltűnik, az ikon pedig látható marad',
  );

  // Élő pufferelési probléma -> állapotablak megjelenik a doktor ikon alatt, majd helyreálláskor eltűnik:
  videoEl.dispatchEvent(new window.Event('waiting'));
  await wait(60);
  const liveBufWindow = doc.querySelector('[data-tv-doctor-status-window]');
  check(
    Boolean(liveBufWindow) &&
      liveBufWindow.getAttribute('data-doctor-phase') === 'buffering' &&
      (liveBufWindow.textContent || '').includes('Pufferelési probléma'),
    'élő adás pufferelési problémájánál az óra előtti doktor ikon alatt megjelenik a rövid magyar állapotablak',
  );
  videoEl.dispatchEvent(new window.Event('playing'));
  await wait(780);
  check(
    !doc.querySelector('[data-tv-doctor-status-window]'),
    'a pufferelés megszűnése után az állapotablak ismét automatikusan eltűnik',
  );

  // FILM (VOD) indítása teljes képernyőn – valós idejű lejátszássegítés, MEMÓRIA- ÉS NAPLÓMENTÉS NÉLKÜL:
  playedUrls.length = 0;
  window.__DOCTOR_UI__.clearTvDoctorMemory();
  window.__DOCTOR_UI__.setVodPlayback({
    url: 'http://stream.example:8080/movie/u/p/9001.mkv',
    title: 'Csillagok között (2014)',
    subSource: { vodId: '9001' },
  });
  await wait(80);
  const movieIconBefore = doc.querySelector('[data-fullscreen-doctor-icon]');
  const movieStatusLoad = doc.querySelector('[data-tv-doctor-status-window]');
  check(
    movieIconBefore?.getAttribute('data-doctor-handled') === 'false' &&
      Boolean(movieStatusLoad) &&
      (movieStatusLoad.textContent || '').includes('Film betöltése'),
    'film indításakor a teljes képernyős doktor ikon jelzi az alap állapotot, alatta pedig „Film betöltése” látszik',
  );

  // Film közbeni hiba -> a TV Doktor valós időben közbelép és újrapróbálja (.mkv marad!), de NEM menti memóriába/naplóba!
  const vodVideo = doc.querySelector('video');
  vodVideo.dispatchEvent(new window.Event('error'));
  await wait(60);
  const movieErrWindow = doc.querySelector('[data-tv-doctor-status-window]');
  check(
    Boolean(movieErrWindow) &&
      ((movieErrWindow.textContent || '').includes('VOD visszaállítás') ||
        (movieErrWindow.textContent || '').includes('Adatfolyam-hiba')) &&
      doc.querySelector('[data-fullscreen-doctor-icon]')?.getAttribute('data-doctor-handled') === 'true',
    'film közbeni hibánál a TV Doktor azonnal valós időben közbelép és megjeleníti a VOD helyreállítási állapotablakot',
  );

  // Megvárjuk az újrapróbálkozást és szimuláljuk a sikeres, stabil lejátszást:
  await wait(450);
  vodVideo.dispatchEvent(new window.Event('playing'));
  await wait(90);
  const movieVerifyWindow = doc.querySelector('[data-tv-doctor-status-window]');
  check(
    Boolean(movieVerifyWindow) &&
      (movieVerifyWindow.textContent || '').includes('VOD javítás ellenőrzése') &&
      playedUrls.every((u) => u.endsWith('/9001.mkv')),
    'a VOD helyreállítás megtartja az eredeti .mkv címet, és ellenőrzi a javított filmlejátszás stabilitását',
  );
  await wait(2900);
  const logsAfterMovie = window.__DOCTOR_UI__.getTvDoctorSummary().recentLogs;
  const memAfterMovie = window.__DOCTOR_UI__.getTvDoctorMemoryStats();
  check(
    !doc.querySelector('[data-tv-doctor-status-window]') &&
      memAfterMovie.learnedChannelCount === 0 &&
      window.localStorage.getItem('iptv_tv_doctor_v1') === null &&
      !logsAfterMovie.some((l) => l.channelName.includes('Csillagok') || l.message.includes('Csillagok')),
    'a film helyreállítása után sem a helyi memóriába, sem a TV Doktor naplóba nem kerül be, hogy melyik film vagy hol akadt el',
  );

  // SOROZAT (VOD) indítása teljes képernyőn:
  window.__DOCTOR_UI__.setVodPlayback({
    url: 'http://stream.example:8080/series/u/p/5501.mp4',
    title: 'Sárkányok háza - S02E01',
    subSource: { seriesId: '550', episodeId: '5501' },
  });
  await wait(80);
  const seriesIconBefore = doc.querySelector('[data-fullscreen-doctor-icon]');
  const seriesStatusLoad = doc.querySelector('[data-tv-doctor-status-window]');
  check(
    seriesIconBefore?.getAttribute('data-doctor-handled') === 'false' &&
      Boolean(seriesStatusLoad) &&
      (seriesStatusLoad.textContent || '').includes('Sorozat betöltése'),
    'sorozat indításakor a teljes képernyős doktor ikon jelzi az új epizódot, alatta pedig „Sorozat betöltése” jelenik meg',
  );
  doc.querySelector('video').dispatchEvent(new window.Event('playing'));
  await wait(780);
  const logsAfterSeries = window.__DOCTOR_UI__.getTvDoctorSummary().recentLogs;
  check(
    !doc.querySelector('[data-tv-doctor-status-window]') &&
      window.__DOCTOR_UI__.getTvDoctorMemoryStats().learnedChannelCount === 0 &&
      !logsAfterSeries.some((l) => l.channelName.includes('Sárkányok') || l.message.includes('Sárkányok')),
    'sorozatepizód lejátszása után az állapotablak eltűnik, és a sorozat sem kerül be a TV Doktor memóriájába vagy naplójába',
  );

  // Korábban megakadt film újbóli megnyitásakor is tiszta lappal indul (mivel nem tároltunk VOD memóriát):
  window.__DOCTOR_UI__.setVodPlayback({
    url: 'http://stream.example:8080/movie/u/p/9001.mkv',
    title: 'Csillagok között (2014)',
    subSource: { vodId: '9001' },
  });
  await wait(80);
  check(
    doc.querySelector('[data-fullscreen-doctor-icon]')?.getAttribute('data-doctor-handled') === 'false',
    'a film újbóli megnyitásakor nincs eltárolt VOD-emlék (data-doctor-handled=false)',
  );

  // ═════════════════════════════════════════════════════════════════════════
  // 5. TELJES APP INTEGRÁCIÓ: 0-ÁS SZÁMJEGY GOMB KIZÁRÓLAGOS MŰKÖDÉSE
  //    (CSAK főoldal + teljes képernyős élő TV; SOHA Mozi/Sorozat/VOD/Menü/Kódbevitel közben)
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n5. Távirányító 0-ás gomb kizárólagos védelme (főoldal + teljes képernyős élő TV vs. Mozi, Sorozat, menük és 0-s kódbevitel)');
  mockCloudMode = 'ok';
  await window.__MOUNT_FULL_APP__();
  await wait(150);

  const pressZeroOnWindow = (targetEl) => {
    const evt = new window.KeyboardEvent('keydown', {
      key: '0',
      code: 'Digit0',
      keyCode: 48,
      which: 48,
      bubbles: true,
      cancelable: true,
    });
    (targetEl || doc.body).dispatchEvent(evt);
  };

  // 5.1 Főoldalon (élő TV aktív): 0 megnyitja a TV Doktor állapot- és naplóablakot, újabb 0 bezárja:
  check(!doc.querySelector('[data-tv-doctor-modal]'), 'induláskor a 0-ás TV Doktor ablak zárva van');
  pressZeroOnWindow(doc.body);
  await wait(90);
  check(
    Boolean(doc.querySelector('[data-tv-doctor-modal]')),
    'a főoldalon (élő TV lejátszása közben) a 0-ás gomb megnyitja a 2 oszlopos TV Doktor állapot- és naplóablakot',
  );
  pressZeroOnWindow(doc.activeElement || doc.body);
  await wait(70);
  check(
    !doc.querySelector('[data-tv-doctor-modal]'),
    'nyitott TV Doktor ablaknál a 0-ás gomb ismételt megnyomása tisztán bezárja az ablakot',
  );

  // 5.2 Teljes képernyős élő TV közben: 0 megnyitja, Escape bezárja, és teljes képernyőn maradunk:
  window.dispatchEvent(new window.CustomEvent('iptv-enter-fullscreen'));
  await wait(90);
  check(
    Boolean(doc.querySelector('[data-fullscreen-doctor-icon]')),
    'az élő TV átváltott teljes képernyőre',
  );
  pressZeroOnWindow(doc.body);
  await wait(90);
  check(
    Boolean(doc.querySelector('[data-tv-doctor-modal]')),
    'teljes képernyős élő TV lejátszás közben is előhívható a 0-ás gombbal a TV Doktor ablak',
  );
  (doc.activeElement || doc.body).dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  await wait(70);
  check(
    !doc.querySelector('[data-tv-doctor-modal]') &&
      Boolean(doc.querySelector('[data-fullscreen-doctor-icon]')),
    'Escape/Vissza csak a TV Doktor ablakot zárja be, az élő adás teljes képernyőn marad',
  );

  // Kilépés a teljes képernyőből vissza a főoldalra:
  const fsPlayerEl = doc.querySelector('[data-tv-player]');
  fsPlayerEl?.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  await wait(80);

  // 5.3 Mozi nézetben és Sorozatok nézetben a 0-ás gomb SOHA nem nyithatja meg a naplót:
  const headerButtons = Array.from(doc.querySelectorAll('header button'));
  const moviesTabBtn = headerButtons.find((b) => (b.textContent || '').includes('Mozi') || (b.textContent || '').includes('Filmek'));
  const seriesTabBtn = headerButtons.find((b) => (b.textContent || '').includes('Sorozat'));
  const liveTabBtn = headerButtons.find((b) => (b.textContent || '').includes('Élő') || (b.textContent || '').includes('TV'));

  moviesTabBtn?.click();
  await wait(80);
  pressZeroOnWindow(doc.body);
  await wait(60);
  check(
    !doc.querySelector('[data-tv-doctor-modal]'),
    'Mozi (filmek) nézetben a 0-ás gomb NEM hozza elő a TV Doktor ablakot',
  );

  seriesTabBtn?.click();
  await wait(80);
  pressZeroOnWindow(doc.body);
  await wait(60);
  check(
    !doc.querySelector('[data-tv-doctor-modal]'),
    'Sorozatok nézetben a 0-ás gomb NEM hozza elő a TV Doktor ablakot',
  );

  // Vissza az Élő TV főoldalra:
  Array.from(doc.querySelectorAll('header button'))
    .find((b) => b.getAttribute('aria-label') === 'TV' || (b.textContent || '').includes('TV'))
    ?.click();
  await wait(80);

  // 5.4 Nyitott Beállítások menüben és 0-t tartalmazó Supabase-párosítási kód megadásakor SOHA nem nyílhat meg a TV Doktor napló:
  doc.querySelector('header button[aria-label="Menü"]')?.click();
  await wait(80);
  pressZeroOnWindow(doc.body);
  await wait(60);
  check(
    Boolean(doc.querySelector('[aria-label="Menü és beállítások"]')) &&
      !doc.querySelector('[data-tv-doctor-modal]'),
    'nyitott Beállítások menüben a 0-ás gomb NEM nyitja meg a TV Doktor naplót',
  );

  // Átváltunk a Rendszer fülre, megnyitjuk a Supabase-párosítást, és 0-t ütünk le:
  doc.querySelector('[data-tv-tabid="system"]')?.click();
  await wait(60);
  doc.querySelector('[data-tv-doctor-pairing-menu]')?.click();
  await wait(80);
  const fullAppPairingModal = doc.querySelector('[data-supabase-pairing-modal]');
  pressZeroOnWindow(fullAppPairingModal || doc.body);
  await wait(60);
  check(
    Boolean(doc.querySelector('[data-supabase-pairing-modal]')) &&
      !doc.querySelector('[data-tv-doctor-modal]'),
    'nyitott Supabase-párosító ablakban (0-t tartalmazó kód bevitelekor) a 0-ás gomb SOHA nem hívja elő a TV Doktor naplót',
  );

  // Bezárjuk a párosítót, megnyitjuk az Új lista (AddPlaylistModal) ablakot, és <input> mezőbe írunk 0-t:
  doc.querySelector('[data-tv-doctor-pair-close]')?.click();
  await wait(50);
  doc.querySelector('[data-tv-tabid="lists"]')?.click();
  await wait(60);
  doc.querySelector('[data-tv-list-action="new"]')?.click();
  await wait(80);
  const playlistInput = doc.querySelector('input');
  playlistInput?.focus();
  pressZeroOnWindow(playlistInput || doc.body);
  await wait(60);
  check(
    Boolean(playlistInput) && !doc.querySelector('[data-tv-doctor-modal]'),
    'szövegmezőben (<input>, pl. URL/kód megadásakor) történő 0 bevitelkor SOHA nem nyílik meg a TV Doktor napló',
  );

  // Bezárjuk a modálokat, és még nyitott modál NÉLKÜL is ellenőrizzük a közvetlen <input> védelmet a főoldalon:
  doc.querySelectorAll('[role="dialog"]').forEach((d) => {
    d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await wait(80);
  const standaloneInput = doc.createElement('input');
  doc.body.appendChild(standaloneInput);
  standaloneInput.focus();
  pressZeroOnWindow(standaloneInput);
  await wait(50);
  const openedWhileInputFocused = Boolean(doc.querySelector('[data-tv-doctor-modal]'));
  standaloneInput.remove();
  check(
    !openedWhileInputFocused,
    'bármilyen fókuszált szövegmező (<input>) esetén a főoldalon is blokkolva van a 0-ás TV Doktor gyorsgomb',
  );

  // 5.5 Film / sorozat (VOD) teljes képernyős lejátszása közben a 0-ás gomb SOHA nem nyithatja meg a TV Doktor naplót:
  doc.querySelector('header button[aria-label="Menü"]')?.click();
  await wait(80);
  doc.querySelector('[data-tv-tabid="favorites"]')?.click();
  await wait(60);
  doc.querySelector('[data-resume-continue]')?.click();
  await wait(90);
  pressZeroOnWindow(doc.body);
  await wait(60);
  check(
    Boolean(doc.querySelector('[data-tv-player][data-vod-active]')) &&
      !doc.querySelector('[data-tv-doctor-modal]'),
    'film / sorozat (VOD) teljes képernyős lejátszása közben a 0-ás gomb SOHA nem hívja elő a TV Doktor ablakot',
  );
} finally {
  dom.window.close();
}

console.log(`\nTV Doktor tesztek összesen: ${passed} sikeres, ${failed} hibás.`);
if (failed > 0) process.exit(1);
console.log('OK: a TV Doktor minden egység-, UI-, lejátszó- és hibrid felhőtesztje sikeres! ✅');
