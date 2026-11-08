#!/usr/bin/env node
/**
 * 2.5.394 – FUTÁSIDEJŰ teszt a JELENLEG DEPLOYÁLT v18 `tv-doctor` Edge
 * Functionnel való kompatibilitásra. A v18 NEM adja vissza a mentett,
 * sorrendi `layoutChannels` listát és NEM adja vissza az 1-es alapokat,
 * ráadásul az elavult layout-ID-kre szűr. A TV-nek így is vissza kell
 * építenie a Supabase-ben elmentett magyar csatornákat.
 *
 * A teszt a VALÓDI `tvDoctorCloud.ts` + `tvDoctor.ts` modult futtatja.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
const ROOT = path.resolve('.');

function MemoryStorage() { this.store = new Map(); }
MemoryStorage.prototype.getItem = function (k) { return this.store.has(k) ? this.store.get(k) : null; };
MemoryStorage.prototype.setItem = function (k, v) { this.store.set(k, String(v)); };
MemoryStorage.prototype.removeItem = function (k) { this.store.delete(k); };
MemoryStorage.prototype.key = function (i) { return Array.from(this.store.keys())[i] || null; };
Object.defineProperty(MemoryStorage.prototype, 'length', { get() { return this.store.size; } });

const storage = new MemoryStorage();
globalThis.localStorage = storage;
globalThis.window = globalThis;
try { Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, userAgent: 'node-test' }, configurable: true }); } catch { /* Node 22: csak olvasható */ }
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);

const STALE = 'live-qr_1794124327752';
const CURRENT = 'live-qr_1794135505110';
const savedSnapshot = {
  version: '2.5.391', createdAt: '2026-11-08T09:28:13.774Z',
  providerId: '__HU_LAYOUT_GLOBAL__', providerName: 'Magyar csatornák',
  totalChannels: 3,
  channelOrder: [`${STALE}-16889`, `${STALE}-16890`, `${STALE}-16920`],
  hungarianChannelIds: [`${STALE}-16889`, `${STALE}-16890`, `${STALE}-16920`],
  hungarianChannelCount: 3,
  fingerprintOrder: [
    { id: `${STALE}-16889`, nameKey: '[HU] BBC Earth UHD|lc-827', countryCode: 'HU' },
    { id: `${STALE}-16890`, nameKey: '[HU] Mozi Plus UHD|lc-827', countryCode: 'HU' },
    { id: `${STALE}-16920`, nameKey: '[HU] HBO 3 UHD|lc-827', countryCode: 'HU' },
  ],
};

const calls = [];
const fakeFetch = async (url, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ url: String(url), body });
  const text = (data) => JSON.stringify(data);
  const reply = (data) => ({ ok: true, status: 200, text: async () => text(data), clone() { return this; } });
  if (String(url).includes('tv-channel-layout')) {
    return reply({ ok: true, found: true, layout: savedSnapshot, snapshot: savedSnapshot, updatedAt: savedSnapshot.createdAt });
  }
  if (body.action === 'bootstrap') {
    // v18: csak az elavult ID-k, NINCS layoutChannels, NINCS baselines.
    return reply({
      ok: true, channelIds: savedSnapshot.channelOrder, channelCount: 3,
      layoutUpdatedAt: savedSnapshot.createdAt, profiles: [], events: [],
      serverTime: '2026-11-08T11:00:00.000Z',
    });
  }
  return reply({ ok: true, profiles: [], events: [], routes: [], baselines: [] });
};
globalThis.fetch = fakeFetch;

storage.setItem('iptv_rt_tv_doctor_pairing_v1', JSON.stringify({
  deviceId: 'LG-4ZYG-W5XP', deviceToken: 'tvd_' + 'a'.repeat(60),
}));

const entry = `
export { bootstrapTvDoctorFromCloud, getTvDoctorCloudStatus } from './web/src/services/tvDoctorCloud';
export {
  getTvDoctorCentralProfileState, getTvDoctorMemoryStats,
  setTvDoctorHungarianChannelScope, recordDoctorChannelSuccess,
  getChannelDoctorRecord,
} from './web/src/services/tvDoctor';
`;
const outFile = path.join(ROOT, 'build/test/tv-doctor-cloud-v18-bundle.mjs');
await esbuild.build({
  stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: outFile, logLevel: 'silent',
});
const mod = await import(outFile + '?v18=' + Date.now());

console.log('\n=== v18 kompatibilitás: a TV a régi Edge Functionnel is visszaépíti a mentett 80-at ===\n');

await mod.bootstrapTvDoctorFromCloud();

const layoutCall = calls.find((c) => c.url.includes('tv-channel-layout'));
assert.ok(layoutCall, 'a TV a mentett elrendezést a tv-channel-layout funkcióból olvassa, ha a bootstrap nem adja');
assert.equal(layoutCall.body.action, 'layout_fetch', 'layout_fetch hívás történt');
console.log('  ✓ v18 bootstrapnél a TV külön beolvassa a Supabase-ben mentett csatornaelrendezést');

const central = mod.getTvDoctorCentralProfileState();
assert.equal(central.count, 3, 'a mentett 3 (élesben 80) magyar csatorna központi profilként visszakerül a TV-re');
assert.deepEqual(central.channels.map((c) => c.channelKey), [
  'hu:bbc-earth-uhd', 'hu:mozi-plus-uhd', 'hu:hbo-3-uhd',
], 'a központi profilok a MENTETT SORRENDBEN, stabil névkulccsal jönnek létre');
assert.equal(central.channels[0].position, 1, 'az első mentett csatorna marad az 1-es helyen');
console.log('  ✓ a TV ugyanazt a sorrendet és névkulcsokat mutatja, mint a Supabase');

const scopeMap = JSON.parse(storage.getItem('iptv_rt_tv_doctor_saved_scope_ids_v1') || '[]');
assert.equal(scopeMap.length, 3, 'a stabil névkulcs -> MENTETT ID térkép tartósan elmentésre kerül');
assert.equal(scopeMap[0][1], `${STALE}-16889`, 'a régi szerver által elfogadott ID van megjegyezve');
console.log('  ✓ a feltöltésnél a TV a mentett ID-t mutatja be, így a v18 szűrője nem dobja el a profilt');

// A friss, MÁS prefixű ID-vel tanult magyar csatorna ettől még megmarad.
const fresh = { id: `${CURRENT}-16889`, name: '[HU] BBC Earth UHD', countryCode: 'HU' };
mod.recordDoctorChannelSuccess({ channel: fresh, format: 'ts', bufferProfile: 'balanced', startupMs: 880 });
const rec = mod.getChannelDoctorRecord(fresh);
assert.ok(rec && rec.routes.length >= 1, 'az új ID-jű magyar csatorna tanulása NEM tűnik el a régi layout-ID miatt');
console.log('  ✓ az új `live-qr_…` ID-jű tanulás megmarad (nem 0/80)');

const stats = mod.getTvDoctorMemoryStats();
assert.ok(stats.learnedChannelCount >= 3, 'a tanult csatornák száma a központi profilokkal együtt >= 3');
console.log('  ✓ tanult_csatornák nem 0: a központi profilok és a friss tanulás együtt látszanak');

// Forrás: a sync a megjegyzett ID-t küldi, és az 1-es alapokat nem törli.
const cloud = fs.readFileSync('web/src/services/tvDoctorCloud.ts', 'utf8');
assert.match(cloud, /syncProfiles\s*=/, 'a szinkron a mentett ID-re lecserélt profilokat küldi');
assert.match(cloud, /savedChannelIdByKey\.get/, 'a stabil névkulcs alapján keresi meg a mentett ID-t');
assert.ok(!/postTvDoctorRpc\(\s*'tv_doctor_baselines_clear'/.test(cloud), 'az 1-es alapokat a nullázás nem törli');
console.log('  ✓ a sync a mentett ID-t küldi; az 1-es alap halhatatlan marad');

console.log('\n=== v18 kompatibilitás: MINDEN RENDBEN ===\n');
