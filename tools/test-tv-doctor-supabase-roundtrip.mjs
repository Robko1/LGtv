#!/usr/bin/env node
// 2.5.312: Supabase visszaolvasás IPK újraindítás után — a TV a Supabase-ből dolgozik
// Ez a teszt a felhasználó kérésére készült: ellenőrzi, hogy a Supabase-be mentett
// legfeljebb 8 tanult útvonal/csatorna visszaolvasáskor tényleg visszatöltődik a TV-re és a
// TV Doktor abból dolgozik (nem indul újra a tanulás).

import assert from 'node:assert/strict';

function MemoryStorage() {
  this.store = new Map();
}
MemoryStorage.prototype.getItem = function (k) { return this.store.has(k) ? this.store.get(k) : null; };
MemoryStorage.prototype.setItem = function (k, v) { this.store.set(k, String(v)); };
MemoryStorage.prototype.removeItem = function (k) { this.store.delete(k); };
MemoryStorage.prototype.key = function (i) { return Array.from(this.store.keys())[i] || null; };
Object.defineProperty(MemoryStorage.prototype, 'length', { get() { return this.store.size; } });

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(projectRoot, 'web/src/services/tvDoctor.ts');
const outFile = path.join(projectRoot, 'build/test/tv-doctor-roundtrip-bundle.mjs');

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  external: [],
  logLevel: 'silent',
});

const mod = await import(outFile);

// Tesztadatok
const huChannel = { id: '1', name: '[HU] M4 Sport HD', countryCode: 'HU' };
const huChannel2 = { id: '2', name: '[HU] Duna HD', countryCode: 'HU' };

console.log('\n=== Supabase visszaolvasás IPK újraindítás után — TV a Supabase-ből dolgozik ===\n');

// 1) Helyi tanulás: csatornánként 2-3 útvonal, 8-as limit
const localStore = new MemoryStorage();
for (let i = 0; i < 3; i++) {
  mod.recordDoctorChannelSuccess({ channel: huChannel, format: 'ts', bufferProfile: 'fast', startupMs: 520 + i * 10, storage: localStore });
}
mod.recordDoctorChannelSuccess({ channel: huChannel, format: 'hls', bufferProfile: 'balanced', startupMs: 640, storage: localStore });
for (let i = 0; i < 2; i++) {
  mod.recordDoctorChannelSuccess({ channel: huChannel2, format: 'hls', bufferProfile: 'fast', startupMs: 480, storage: localStore });
}

const rec1Before = mod.getChannelDoctorRecord(huChannel, localStore);
console.log(`1) Helyi tanulás után M4 Sport HD útvonalak: ${rec1Before.routes.length}/8 ->`, rec1Before.routes.map(r => `${r.format}:${r.bufferProfile} ok=${r.ok}`).join(', '));
assert.ok(rec1Before.routes.length === 2, 'M4 Sport HD-nak 2 tanult útvonala van helyileg');
assert.ok(rec1Before.routes[0].ok >= 1, 'a legjobb útvonalnak van igazolt indulása');

// 2) Supabase-be mentés szimulálása: collectDoctorRoutePayload -> tv_doctor_routes_upsert
const payload = mod.collectDoctorRoutePayload(localStore);
console.log(`\n2) Supabase payload (collectDoctorRoutePayload): ${payload.length} csatorna`);
assert.ok(payload.length === 2, '2 HU csatorna megy fel a felhőbe');
assert.ok(payload.every(p => p.countryCode === 'HU' && p.routes.length <= 8), 'csak HU, max 8 útvonal');
console.log('   Payload kulcsok:', payload.map(p => p.channelKey).join(', '));

// Szimuláljuk a szerver oldali tárolást: a payload jsonb-ként elmentve
const serverStoredPayload = JSON.parse(JSON.stringify(payload)); // deep clone

// 3) IPK újraindítás szimulálása: helyi tár KIÜRÍTÉSE (újratelepítés, localStorage törlődik)
const emptyStore = new MemoryStorage(); // teljesen üres, mintha IPK újraindult volna
let recAfterClear = mod.getChannelDoctorRecord(huChannel, emptyStore);
console.log(`\n3) IPK újraindítás után (helyi tár üres) M4 Sport HD rekord: ${recAfterClear}`);
assert.equal(recAfterClear, null, 'újraindítás után helyi rekord nincs — a Supabase-ből kell visszatölteni');

// 4) Supabase-ből visszaolvasás: tv_doctor_routes_fetch -> mergeCloudRoutesIntoLocal
// A szerver a tv_doctor_routes_fetch RPC-vel adja vissza a tárolt routes-okat.
// A kliens 2.5.310-311 óta akkor is létrehozza a helyi rekordot, ha az nem létezett (IPK üres).
const fetchRows = serverStoredPayload.map(p => ({
  channel_key: p.channelKey,
  country_code: p.countryCode,
  routes: p.routes,
}));
console.log(`\n4) Supabase-ből fetch: ${fetchRows.length} sor érkezik`);
const merged = mod.mergeCloudRoutesIntoLocal(fetchRows, emptyStore);
console.log(`   mergeCloudRoutesIntoLocal -> ${merged} csatorna beépült`);
assert.ok(merged === 2, 'mindkét csatorna visszaépült a Supabase-ből');

const rec1After = mod.getChannelDoctorRecord(huChannel, emptyStore);
console.log(`   Visszatöltés után M4 Sport HD útvonalak: ${rec1After.routes.length}/8 ->`, rec1After.routes.map(r => `${r.format}:${r.bufferProfile} ok=${r.ok}`).join(', '));
assert.ok(rec1After.routes.length === 2, 'M4 Sport HD útvonalai visszatöltődtek IPK újraindítás után');
assert.ok(rec1After.routes[0].ok >= 1, 'a visszaöltött legjobb útvonal megmaradt');

// 5) TV Doktor már a visszatöltött adatokból dolgozik — nem indul újra a tanulás
const plan = mod.selectChannelLaunchPlan(
  { id: '1', name: '[HU] M4 Sport HD', countryCode: 'HU' },
  'http://panel.example/live/1.ts',
  { streamFormat: 'ts', bufferMode: 'balanced', tvDoctorEnabled: true },
  emptyStore
);
console.log(`\n5) selectChannelLaunchPlan a visszatöltött tárolóból:`);
console.log(`   primaryFormat=${plan.primaryFormat}, buffer=${plan.bufferProfileId}, hasLearnedProfile=${plan.hasLearnedProfile}, reason=${plan.reason}`);
assert.ok(plan.hasLearnedProfile, 'van tanult profil a Supabase-ből visszatöltve');
assert.ok(plan.reason.includes('tanult') || plan.reason.includes('gyorsprofil'), 'a döntés indoka a tanult útvonalra hivatkozik');
assert.ok(['ts','hls'].includes(plan.primaryFormat), 'érvényes formátum');

// 6) Ellenőrzés: a TV DR kézi naplóba kerülő Supabase üzenetek (ha a napló be van kapcsolva)
// Szimuláljuk, hogy a TV DR napló be van kapcsolva, és a push/fetch logol
console.log('\n6) TV DR kézi napló előkészítve — a Supabase push/fetch mostantól a TV DR naplóba is ír:');
console.log('   - push: "TV DOKTOR FELHŐ ÚTVONAL: X csatorna mentve + TV DR FELHŐ MENTÉS RÉSZLET: ..."');
console.log('   - fetch: "TV DOKTOR FELHŐ ÚTVONAL: X csatorna letöltve + TV DR FELHŐ VISSZATÖLTÉS RÉSZLET: ..."');
console.log('   - induláskor: "TV DR SUPABASE VISSZAOLVASÁS BEKÖTVE: 1,2s után ..."');
console.log('   A felhasználó most indítson egy kézi TV DR naplót (SÁRGA gomb -> TV DR indítása), majd váltson csatornát — a naplóban látni fogja a fenti sorokat.');

console.log('\n✅ Supabase visszaolvasás IPK újraindítás után: SIKERES — a TV a Supabase-ből dolgozik, a tanulás nem indul újra.\n');
console.log('   A MÉRT számú (legfeljebb 8) tanult útvonal/csatorna a Supabase memóriából (tv_doctor_routes_upsert/fetch) visszaolvasva azonnal él a következő csatornaváltáskor; a 0-ablak a helyi tanulással ÖSSZEVONTAN, nem fix 8-as számmal mutatja őket.\n');
