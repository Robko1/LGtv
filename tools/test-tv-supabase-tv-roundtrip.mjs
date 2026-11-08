#!/usr/bin/env node
/**
 * 2.5.394 – TELJES tv → Supabase → tv KÖR REGRESSZIÓS TESZT.
 *
 * A #35–38 naplók és a Supabase táblák alapján reprodukáljuk a 2.5.392
 * hibáját: az elmentett csatornaelrendezés ID-je (`live-qr_...-A`) elavult a
 * TV aktuális ID-jéhez (`live-qr_...-B`) képest, ezért
 *   • a Supabase `sync` ELDOB minden feltöltött magyar profilt,
 *   • a `bootstrap` vissza sem adja a korábban mentett profilokat,
 *   • a TV `setTvDoctorHungarianChannelScope` KITÖRLI a helyi tanult rekordot,
 *   • `Memória: 0` után SEMMI nem töltődik vissza (0/80), és az 1-es alap is
 *     eltűnik a Supabase-ből (`tv_doctor_baselines_clear`).
 *
 * A teszt a TÉNYLEGES Edge Function kezelőt és a TÉNYLEGES kliens modult
 * futtatja (esbuild + hamis REST/Storage), nem csak szöveget keres.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve('.');
const esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
const outDir = path.resolve('build/test');
fs.mkdirSync(outDir, { recursive: true });
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];
function check(condition, label) {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; failures.push(label); console.error(`  ✗ HIBA: ${label}`); }
}
async function checkAsync(fn, label) {
  try { check(await fn(), label); }
  catch (error) { failed += 1; failures.push(`${label} (${error.message})`); console.error(`  ✗ HIBA: ${label} – ${error.message}`); }
}

/* ========================================================================== *
 * 1. EDGE FUNCTION – elavult layout-ID mellett is teljes kör
 * ========================================================================== */
console.log('\n=== 1. Supabase Edge Function: mentett név alapján illeszt, nem elavult ID alapján ===\n');

const edgeOut = path.join(outDir, 'tv-doctor-edge-394.mjs');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'supabase/functions/tv-doctor/index.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: edgeOut, logLevel: 'silent',
});
const edge = await import(pathToFileURL(edgeOut).href);

const DEVICE_ID = 'LG-4ZYG-W5XP';
const DEVICE_TOKEN = 't'.repeat(48);
const tokenHash = createHash('sha256').update(DEVICE_TOKEN).digest('hex');
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const OLD = 'live-qr_1794124327752';
const NEW = 'live-qr_1794135505110';

const layoutSnapshot = {
  version: '2.5.391',
  createdAt: '2026-11-08T09:28:13.774Z',
  totalChannels: 4,
  hungarianChannelCount: 3,
  channelOrder: [`${OLD}-16889`, `${OLD}-16890`, `${OLD}-16891`, `${OLD}-99999`],
  hungarianChannelIds: [`${OLD}-16889`, `${OLD}-16890`, `${OLD}-16891`],
  fingerprintOrder: [
    { id: `${OLD}-16889`, nameKey: '[hu] bbc earth uhd|lc-827' },
    { id: `${OLD}-16890`, nameKey: '[hu] hbo uhd|lc-827' },
    { id: `${OLD}-16891`, nameKey: '[hu] moziverzum|lc-827' },
    { id: `${OLD}-99999`, nameKey: '[de] zdf|lc-100' },
  ],
  deletedChannels: [], folders: [],
};

const db = {
  profiles: [],
  events: [],
  baselines: [{
    device_id: DEVICE_ID,
    channel_key: 'hu:bbc-earth-uhd',
    channel_id_hint: `${OLD}-16889`,
    channel_name: '[HU] BBC Earth UHD',
    baseline: {
      slot: 1, channelKey: 'hu:bbc-earth-uhd', channelName: '[HU] BBC Earth UHD',
      format: 'ts', bufferProfile: 'balanced',
      bufferTiming: { minBufferAheadSeconds: 3, maxBufferAheadSeconds: 8 },
      startupMs: 1680, recordedAt: NOW,
    },
  }],
  deletes: [],
};

function jsonResponse(body, status = 200) {
  if (status === 204 || body === null) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
async function fakeFetch(url, init = {}) {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  if (u.includes('/tv_doctor_paired_devices')) {
    if (method === 'PATCH') return jsonResponse([], 204);
    return jsonResponse([{
      device_id: DEVICE_ID, token_hash: tokenHash, revoked: false,
      token_expires_at: new Date(NOW + 100 * 86400000).toISOString(),
      last_rotated_at: new Date(NOW - 1000).toISOString(),
      paired_at: new Date(NOW - 86400000).toISOString(),
      previous_token_hash: null, previous_token_grace_until: null,
      tv_model: 'LG', webos_version: '6', app_version: '2.5.394',
    }]);
  }
  if (u.includes('/tv_channel_layout_snapshots')) {
    db.layoutReads = (db.layoutReads || 0) + 1;
    return jsonResponse([{ snapshot: layoutSnapshot, updated_at: new Date(NOW).toISOString() }]);
  }
  if (u.includes('/rpc/prune_tv_doctor_tables')) return jsonResponse(null, 204);
  if (u.includes('/tv_doctor_channel_baselines')) return jsonResponse(db.baselines);
  if (u.includes('/tv_doctor_events')) {
    if (method === 'DELETE') { db.deletes.push('events'); return jsonResponse(null, 204); }
    if (method === 'POST') { db.events.push(...(Array.isArray(body) ? body : [body])); return jsonResponse(null, 201); }
    return jsonResponse(db.events);
  }
  if (u.includes('/tv_doctor_channel_profiles')) {
    if (method === 'DELETE') {
      db.deletes.push('profiles');
      if (u.includes('channel_id_hint')) db.deletes.push('profiles_by_id');
      db.profiles = [];
      return jsonResponse(null, 204);
    }
    if (method === 'POST' || method === 'PATCH') {
      const rows = Array.isArray(body) ? body : [body];
      for (const row of rows) {
        const idx = db.profiles.findIndex((p) => p.channel_key === row.channel_key);
        const merged = { ...(idx >= 0 ? db.profiles[idx] : {}), ...row, updated_at: new Date(NOW).toISOString() };
        if (idx >= 0) db.profiles[idx] = merged; else db.profiles.push(merged);
      }
      return jsonResponse(null, 201);
    }
    let rows = db.profiles.slice();
    if (u.includes('updated_at=gt.')) rows = rows.filter(() => true); // a `since` szűrést a hamis tár nem szimulálja
    return jsonResponse(rows);
  }
  return jsonResponse([], 200);
}

const handler = edge.createTvDoctorHandler({
  url: 'https://fake.supabase.co', key: 'fake-service-role-key',
  nowFn: () => NOW, fetchFn: fakeFetch,
});
const post = async (payload) => {
  const res = await handler(new Request('https://fake.supabase.co/functions/v1/tv-doctor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tv-device-id': DEVICE_ID, 'x-tv-device-token': DEVICE_TOKEN },
    body: JSON.stringify(payload),
  }));
  return { status: res.status, json: await res.json() };
};

// 1.1: a TV a jelenlegi (ÚJ) ID-vel küldi a tanult profilt, de a név/kulcs az elmentett listában van.
const syncResult = await post({
  action: 'sync', doctorSchemaVersion: 2,
  profiles: [{
    channelKey: 'hu:bbc-earth-uhd', channelName: '[HU] BBC Earth UHD', countryCode: 'HU',
    channelIdHint: `${NEW}-16889`, tsSuccessCount: 3, tsSuccessDelta: 1,
    bestFormat: 'ts', bestBufferProfile: 'balanced',
    routes: [{ id: 'ts:balanced', format: 'ts', bufferProfile: 'balanced', ok: 3, fail: 0, stalls: 0 }],
  }],
  events: [],
});
await checkAsync(() => {
  assert.equal(syncResult.status, 200, `sync HTTP ${syncResult.status}: ${JSON.stringify(syncResult.json)}`);
  assert.equal(db.profiles.length, 1, 'a feltöltött magyar profilnak meg kell jelennie a Supabase-ben');
  return true;
}, 'tv → Supabase: az elavult layout-ID ellenére a mentett NÉV alapján feltöltött profil BEKERÜL');

// 1.2: a bootstrap visszaadja a profilt és a MENTETT 80-as listát + 1-es alapokat.
const bootResult = await post({ action: 'bootstrap', limit: 400 });
await checkAsync(() => {
  assert.equal(bootResult.status, 200, `bootstrap HTTP: ${JSON.stringify(bootResult.json)}`);
  assert.equal(bootResult.json.profiles.length, 1, 'a visszatöltött profil nem veszhet el a régi ID-szűrőn');
  return true;
}, 'Supabase → tv: a korábban feltöltött tanult profil VISSZAJÖN a bootstrapben');
check(bootResult.json.channelCount === 3, 'bootstrap: a mentett magyar csatornák száma (3) megérkezik');
check(Array.isArray(bootResult.json.layoutChannels) && bootResult.json.layoutChannels.length === 3,
  'bootstrap: a MENTETT, SORRENDI központi profilok (layoutChannels) is megérkeznek a TV-re');
check(bootResult.json.layoutChannels?.[0]?.channelKey === 'hu:bbc-earth-uhd'
  && bootResult.json.layoutChannels?.[1]?.channelKey === 'hu:hbo-uhd'
  && bootResult.json.layoutChannels?.[2]?.channelKey === 'hu:moziverzum',
  'bootstrap: a központi profilok a mentett sorrendben, stabil névkulccsal jönnek');
check(Array.isArray(bootResult.json.baselines) && bootResult.json.baselines.length === 1
  && bootResult.json.baselines[0].baseline.slot === 1,
  'bootstrap: az első sikeres megnyitás 1-es alapbeállítása is visszajön a Supabase-ből');
const edgeSrc = read('supabase/functions/tv-doctor/index.ts');
check(!/baselinesUrl\s*\?.*method:\s*"DELETE"/.test(edgeSrc), 'az Edge Function reset_memory önmagában nem törli az alapot; a TELJES nullázást a kliens külön RPC-vel végzi');
check(!/startsWith\("hu:"\)/.test(edgeSrc), 'a szerver CSAK a mentett magyar csatornát tanulja, tetszőleges hu: kulcsot nem');
check(/const keyMatches = allowedChannelKeys\.has\(channelKey\)/.test(edgeSrc),
  'a szinkron a mentett stabil névkulcs alapján enged, nem az elavult ID alapján');
check(/allowedChannelKeys\.has\(channelKey\)\) continue/.test(edgeSrc),
  'a naplóeseményeket sem veszíti el az elavult ID-szűrő');

// 1.3: az Edge Function reset_memory a tanult profilokat/eseményeket törli;
// a mentett elrendezés marad. A TELJES nullázás 1-es alapjait a kliens
// tv_doctor_baselines_clear RPC-je törli (2.5.399 / 10. pont).
const resetResult = await post({ action: 'reset_memory' });
check(resetResult.status === 200 && resetResult.json.ok === true, 'reset_memory sikeres');
check(db.deletes.includes('profiles') && db.deletes.includes('events'), 'reset_memory törli a tanult profilokat és eseményeket');
check(db.baselines.length === 1, 'reset_memory után az Edge Function az alapot még megőrzi (a teljes törlés a kliens RPC-je)');
check(resetResult.json.baselinesPreserved === true && resetResult.json.layoutPreserved === true,
  'reset_memory válasza egyértelműen jelzi az Edge Function által megőrzött adatokat');
check(!db.deletes.includes('profiles_by_id'), 'reset_memory nem próbál ID-szűrős törlést a profilokon');

/* ========================================================================== *
 * 2. KLIENS – név alapú HU szűrő, központi profilok, 1-es alap
 * ========================================================================== */
console.log('\n=== 2. TV kliens: a mentett 80 csatorna megjelenik, a tanulás nem törlődik ===\n');

const clientOut = path.join(outDir, 'tv-doctor-client-394.mjs');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'web/src/services/tvDoctor.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: clientOut, logLevel: 'silent',
});
const doctor = await import(pathToFileURL(clientOut).href + `?v=${Date.now()}`);

/* ÉLŐ SUPABASE-ADAT (2026-11-08, LG-4ZYG-W5XP): az első 5 mentett magyar
   nameKey kisbetűs `[hu] ...|lc-827` alakú, a TV viszont nagybetűs nevet kap.
   A két normalizálónak PONTOSAN ugyanazt a stabil kulcsot kell adnia. */
const liveSavedNameKeys = [
  '[hu] bbc earth uhd|lc-827', '[hu] mozi plus uhd|lc-827', '[hu] hbo uhd|lc-827',
  '[hu] hbo 2 uhd|lc-827', '[hu] hbo 3 uhd|lc-827',
];
const liveTvNames = [
  '[HU] BBC Earth UHD', '[HU] MOZI PLUS UHD', '[HU] HBO UHD', '[HU] HBO 2 UHD', '[HU] HBO 3 UHD',
];
const clientBundleForKeys = doctor;
const liveKeyMismatches = liveSavedNameKeys.filter((nameKey, i) => {
  const saved = clientBundleForKeys.normalizeSavedLayoutChannelKey(nameKey);
  const current = clientBundleForKeys.normalizeChannelDoctorKey({
    id: `${NEW}-${16889 + i}`, name: liveTvNames[i], countryCode: 'HU',
  });
  return !saved || saved !== current;
});
check(liveKeyMismatches.length === 0,
  'élő Supabase-nameKey és az aktuális TV-csatornanév UGYANAZT a stabil hu: kulcsot adja (5/5)');
check(Array.isArray(bootResult.json.channelKeys)
  && bootResult.json.channelKeys.includes('hu:bbc-earth-uhd')
  && bootResult.json.channelKeys.includes('hu:hbo-uhd'),
  'a szerver által visszaadott channelKeys is ezeket a stabil kulcsokat tartalmazza');

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
}
const storage = new MemoryStorage();

const layoutChannels = [
  { id: `${OLD}-16889`, nameKey: '[hu] bbc earth uhd|lc-827', channelKey: 'hu:bbc-earth-uhd', name: '[HU] BBC Earth UHD', position: 1 },
  { id: `${OLD}-16890`, nameKey: '[hu] hbo uhd|lc-827', channelKey: 'hu:hbo-uhd', name: '[HU] HBO UHD', position: 2 },
  { id: `${OLD}-16891`, nameKey: '[hu] moziverzum|lc-827', channelKey: 'hu:moziverzum', name: '[HU] MOZIVERZUM', position: 3 },
];
const savedIds = layoutChannels.map((c) => c.id);
const currentBbc = { id: `${NEW}-16889`, name: '[HU] BBC Earth UHD', countryCode: 'HU' };
const currentHbo = { id: `${NEW}-16890`, name: '[HU] HBO UHD', countryCode: 'HU' };

// 2.1: a TV a friss (ÚJ) ID-kkel tanul, a szűrő még a RÉGI mentett ID-ket kapja.
doctor.setTvDoctorHungarianChannelScope(savedIds, NOW, layoutChannels, storage);
doctor.recordDoctorChannelSuccess({ channel: currentBbc, format: 'ts', bufferProfile: 'fast', startupMs: 520, storage });
doctor.recordDoctorChannelSuccess({ channel: currentHbo, format: 'hls', bufferProfile: 'balanced', startupMs: 640, storage });
const bbcRec = doctor.getChannelDoctorRecord(currentBbc, storage);
check(Boolean(bbcRec && bbcRec.routes.length > 0), 'a jelenlegi ID-vel tanult útvonal a helyi memóriában van');
check(doctor.isHungarianDoctorChannel(currentBbc), 'az elavult ID-k ellenére az aktuális magyar csatorna a megengedett körben van (név alapján)');
check(doctor.isPersistableDoctorRecord({ channelId: currentBbc.id, countryCode: 'HU', channelKey: 'hu:bbc-earth-uhd', channelName: currentBbc.name }),
  'a jelenlegi ID-jű rekordot a szűrő NEM dobja el (0/80 helyett 2/80)');
check(doctor.getTvDoctorMemoryStats(storage).learnedChannelCount >= 2, 'tanult_csatornák NEM 0: a két friss ID-jű magyar csatorna beleszámít');

// 2.2: a szűrő beállítása NEM törölheti ki a friss ID-vel tanult rekordot.
doctor.setTvDoctorHungarianChannelScope(savedIds, NOW + 1, layoutChannels, storage);
check(Boolean(doctor.getChannelDoctorRecord(currentBbc, storage)?.routes?.length),
  'a bootstrap által ismételt szűrő-beállítás NEM törli a már tanult útvonalat');

// 2.3: a Supabase-ben mentett központi profilok + 1-es alap visszakerülnek a TV-re.
const centralParams = {
  layoutChannels,
  baselines: Array.isArray(bootResult.json.baselines) ? bootResult.json.baselines : [],
  profiles: bootResult.json.profiles,
  routes: [{ channel_key: 'hu:bbc-earth-uhd', country_code: 'HU', routes: [{ id: 'ts:fast', format: 'ts', bufferProfile: 'fast', ok: 3, fail: 0, stalls: 0 }] }],
};
const restoreResult = typeof doctor.restoreTvDoctorCentralProfiles === 'function'
  ? doctor.restoreTvDoctorCentralProfiles(centralParams, storage) : { restored: -1 };
check(restoreResult.restored === 3, 'a 3 mentett központi profil a TV helyi memóriájába kerül (80/80 az éles 80-ra)');
check(doctor.getTvDoctorMemoryStats(storage).learnedChannelCount >= 3, 'tanult_csatornák >= 3 (ami a Supabase-en van, az a TV-n is látszik)');
const baseline = doctor.getDoctorBaseline(currentBbc, storage);
check(Boolean(baseline) && baseline.slot === 1 && baseline.format === 'ts' && baseline.bufferProfile === 'balanced',
  'az 1-es alap (TS + balanced) a Supabase-ből visszaállt, és zárolt marad');
check(Boolean(doctor.getChannelDoctorRecord(currentBbc, storage)?.routes?.some((r) => r.id === 'ts:fast')),
  'a Supabase-ben tanult 2-es útvonal is megjelenik a TV-n');
const centralState = typeof doctor.getTvDoctorCentralProfileState === 'function'
  ? doctor.getTvDoctorCentralProfileState(storage) : { channels: [] };
check(centralState.channels.length === 3 && centralState.channels[0].channelKey === 'hu:bbc-earth-uhd',
  'a központi profilok MENTETT SORRENDBEN jelennek meg a TV Doktor 0-ablakában');

// 2.4: teljes kör – nullázás után a Supabase-ből minden visszaépül.
doctor.clearTvDoctorMemory(storage);
check(doctor.getTvDoctorMemoryStats(storage).learnedChannelCount === 0, 'Memória: 0 valóban kinullázza a tanult adatot');
/* 2.5.399 / 10. pont: a felhasználó VISSZAVONTA a „halhatatlan 1-es alap”
   döntést – teljes nullázáskor az alap is törlődik, minden elölről indul. */
check(!doctor.getDoctorBaseline(currentBbc, storage),
  'Memória: 0 az 1-es alapot HELYBEN is törli (minden csatorna elölről tanul)');
const restored = doctor.restoreDoctorBaselinesFromCloud([], storage);
check(restored === 0 && !doctor.getDoctorBaseline(currentBbc, storage),
  'teljes nullázás után a Supabase alapjai sem töltődnek vissza automatikusan');
if (typeof doctor.restoreTvDoctorCentralProfiles === 'function') {
  doctor.restoreTvDoctorCentralProfiles({ layoutChannels, baselines: [], profiles: [], routes: [] }, storage);
}
check(doctor.getTvDoctorMemoryStats(storage).learnedChannelCount === 3,
  'tv → Supabase → tv: nullázás után a 3 mentett központi profil automatikusan visszatöltődik');
check(!doctor.getDoctorBaseline(currentBbc, storage),
  'tv → Supabase → tv: nullázás után a csatorna tiszta lappal, ÚJ első sikeres megnyitással indul');

/* ========================================================================== *
 * 3. FORRÁS – 2.5.399 / 10. pont: a Memória: 0 TELJES nullázás. Az 1-es
 *    alap HELYBEN és a Supabase-ben is törlődik; és a #40 `0 csatorna mentve`
 *    hibáját a valódi INSERT ... ON CONFLICT UPSERT javítja.
 * ========================================================================== */
console.log('\n=== 3. Forrás: Memória: 0 = TELJES nullázás + valódi UPSERT ===\n');
const cloud = read('web/src/services/tvDoctorCloud.ts');
check(cloud.includes("'tv_doctor_baselines_clear'"), 'a kliens meghívja a tv_doctor_baselines_clear RPC-t (10. pont)');
check(/postTvDoctorRpc\(\s*'tv_doctor_baselines_clear'/.test(cloud), 'a tv_doctor_baselines_clear RPC a nullázási úton van');
const doctorSrcForBaseline = read('web/src/services/tvDoctor.ts');
const clearBody = doctorSrcForBaseline.slice(
  doctorSrcForBaseline.indexOf('export function clearTvDoctorMemory'),
  doctorSrcForBaseline.indexOf('export function getTvDoctorCategoryStats'),
);
check(/removeItem\(TV_DOCTOR_BASELINE_STORAGE_KEY\)/.test(clearBody),
  'a helyi Memória: 0 törli az 1-es alap tárolóját');
const migrationDir = path.join(ROOT, 'supabase/migrations');
const resetFiles = fs.readdirSync(migrationDir).filter((f) => /full_reset_true_upsert/.test(f));
const resetSql = resetFiles.length ? read(`supabase/migrations/${resetFiles[0]}`) : '';
check(resetFiles.length === 1
  && /delete from public\.tv_doctor_channel_baselines/.test(resetSql)
  && /on conflict \(channel_key\) do update/.test(resetSql),
  'az új migráció törli az 1-es alapot ÉS valódi UPSERT-et ad (0 csatorna mentve hiba javítva)');
const deployScript = fs.existsSync(path.join(ROOT, 'tools/deploy-tv-doctor.sh'))
  ? read('tools/deploy-tv-doctor.sh') : '';
check(/supabase functions deploy/.test(deployScript) && /FUNCTION_SLUG="tv-doctor"/.test(deployScript)
  && /--project-ref/.test(deployScript)
  && /SUPABASE_ACCESS_TOKEN/.test(deployScript)
  && !/sbp_[A-Za-z0-9]{10,}/.test(deployScript)
  && !/\b(delete from|truncate table|drop table)\b/i.test(deployScript),
  'a v19 Edge Function egy paranccsal deployolható, token nincs a repóban, adatot nem töröl');
const resetFn = cloud.slice(cloud.indexOf('export async function resetTvDoctorAllToZero'), cloud.indexOf('/**\n * Csatlakoztatja a TV Doktor'));
check(/restoreTvDoctorCloudState\(\)/.test(resetFn), 'Memória: 0 UTÁN azonnal fut a teljes Supabase-visszatöltés (tv → Supabase → tv)');
check(/restoreTvDoctorCentralProfiles/.test(cloud), 'a bootstrap a mentett központi profilokat is visszaépíti a TV-n');
check(/fetchSnapshotFromCloud/.test(cloud) && /layoutChannelsFromSavedSnapshot/.test(cloud),
  'a jelenleg deployált v18 mellett is a Supabase-ben mentett elrendezésből épül vissza a 80 csatorna');
check(/syncProfiles/.test(cloud) && /savedChannelIdByKey/.test(cloud),
  'a v18 elavult ID-szűrőjéhez a TV a mentett ID-t mutatja be a stabil névkulcs alapján');
check(/layoutChannels/.test(cloud), 'a bootstrap fogadja a mentett, sorrendi csatornalistát');
check(/központi_profilok=/.test(cloud), 'az állapotsor kiírja a központi profilok számát (nem csak 0-t)');
check(/TV DOKTOR SUPABASE KÖR/.test(cloud), 'a TV Doktor napló tételesen kiírja a tv → Supabase → tv kör eredményét');
check(!cloud.includes('Supabase-ből (0 profil)'), 'a napló nem állít többé keményen kódolt „0 profil” visszatöltést');
const modal = read('web/src/components/TvDoctorStatusModal.tsx');
check(/getTvDoctorCentralProfileState|központiProfil|centralProfile/i.test(modal),
  'a TV Doktor 0-ablak megjeleníti a Supabase-ben mentett központi profilokat');

/* ========================================================================== *
 * 4. MOZI: játékidő, fókusz, indulás
 * ========================================================================== */
console.log('\n=== 4. Mozi: plakát játékidő, visszatérés ugyanarra a poszterre, indulás ===\n');
const app = read('web/src/App.tsx');
const moviesView = read('web/src/components/MoviesView.tsx');
check(/enrichMovieDurationsInBackground\(/.test(app), 'a Mozi nézet látható posztereinek hiányzó játékidejét a háttér bekéri és elmenti');
check(/handleVodItemEnriched\('movies'/.test(app), 'a háttérben dúsított film visszakerül a plakátra');
check(/data-movie-runtime/.test(moviesView), 'a játékidő a plakát jobb felső sarkában, kis dobozban jelenik meg');
check(/movieReturnSnapshot\s*=\s*\{[^}]*focus/.test(moviesView), 'a film indításakor a KIVÁLASZTOTT POSZTER azonosítóját is megjegyezzük');
check(/data-vod-card/.test(moviesView) && /focusPosterFromReturn|restorePosterFocus/.test(moviesView),
  'visszatéréskor a fókusz ugyanarra a poszterre kerül, NEM a kategóriákra');
check(/VOD_RETURN_FOCUS|vodReturnFocus|skipDefaultViewFocus/.test(app),
  'a nézetváltás általános fókusz-hatása nem rántja vissza a kategória gombra VOD-visszatéréskor');
const main = read('web/src/main.tsx');
check(/const VIDEO_WAIT_MS = 0/.test(main) && /const LOGO_WAIT_MS = 0/.test(main),
  'induláskor nincs több mesterséges 400/250 ms várakozás a logóra / első videókockára');
check(/__IPTV_APP_READY__/.test(main), 'a főoldal kész jelzése továbbra is kimegy (a katalógus-visszatöltés erre indul)');

console.log(`\n=== EREDMÉNY: ${passed} sikeres / ${failed} hibás ===`);
if (failed) {
  console.error('\nBukó feltételek (ezeket kell javítani):');
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exitCode = 1;
}
