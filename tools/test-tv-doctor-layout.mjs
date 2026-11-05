#!/usr/bin/env node
// A csatornaelrendezés Supabase Edge Function útvonalainak round-trip tesztje.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = createRequire(path.join(root, 'web/package.json'))('esbuild');
const bundlePath = path.join(root, 'build/test/tv-doctor-layout-edge.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'supabase/functions/tv-doctor/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundlePath,
  logLevel: 'silent',
});
const { createTvDoctorHandler } = await import(pathToFileURL(bundlePath).href);

const deviceId = 'device-layout-test';
const deviceToken = 'tvd_a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const now = Date.now();
const savedRows = new Map();
const device = {
  device_id: deviceId,
  token_hash: createHash('sha256').update(deviceToken).digest('hex'),
  token_expires_at: new Date(now + 60 * 24 * 60 * 60 * 1000).toISOString(),
  last_rotated_at: new Date(now - 60_000).toISOString(),
  last_seen_at: new Date(now - 60_000).toISOString(),
  paired_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
  revoked: false,
};
const fetchFn = async (url, init = {}) => {
  const target = new URL(String(url));
  if (target.pathname.endsWith('/tv_doctor_paired_devices')) return Response.json([device]);
  if (target.pathname.endsWith('/tv_doctor_layout_snapshots') && init.method === 'POST') {
    const [row] = JSON.parse(String(init.body || '[]'));
    savedRows.set(`${row.device_id}:${row.provider_id}`, row);
    return Response.json([row]);
  }
  if (target.pathname.endsWith('/tv_doctor_layout_snapshots')) {
    const row = savedRows.get(`${deviceId}:${target.searchParams.get('provider_id')?.replace(/^eq\./, '')}`);
    return Response.json(row ? [row] : []);
  }
  if (target.pathname.endsWith('/rpc/prune_tv_doctor_layout_snapshots')) return new Response(null, { status: 204 });
  return Response.json({ message: `Unexpected mock request: ${target.pathname}` }, { status: 404 });
};
const handler = createTvDoctorHandler({
  url: 'https://supabase.example',
  key: 'test-service-role-key',
  fetchFn,
  nowFn: () => now,
});
const snapshot = {
  version: '2.5.341',
  createdAt: new Date(now).toISOString(),
  providerId: 'provider-1',
  providerName: 'Teszt szolgáltató',
  totalChannels: 2,
  channelOrder: ['ch-1', 'ch-2'],
  fingerprintOrder: [
    { id: 'ch-1', nameKey: 'm1|hu', displayOrder: 0 },
    { id: 'ch-2', nameKey: 'm2|hu', displayOrder: 1 },
  ],
  deletedChannels: [],
  folders: [],
};
const request = (body) => new Request('https://edge.example/functions/v1/tv-doctor', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-tv-device-id': deviceId,
    'x-tv-device-token': deviceToken,
  },
  body: JSON.stringify(body),
});

const upsertResponse = await handler(request({ action: 'layout_upsert', providerId: snapshot.providerId, layout: snapshot }));
const upsert = await upsertResponse.json();
assert.equal(upsertResponse.status, 200);
assert.equal(upsert.saved, true);
assert.equal(savedRows.size, 1);

const fetchResponse = await handler(request({ action: 'layout_fetch', providerId: snapshot.providerId }));
const fetched = await fetchResponse.json();
assert.equal(fetchResponse.status, 200);
assert.equal(fetched.found, true);
assert.deepEqual(fetched.layout.channelOrder, snapshot.channelOrder);
assert.equal(fetched.layout.providerId, snapshot.providerId);
assert.deepEqual(fetched.layout.fingerprintOrder.map(({ id, nameKey }) => ({ id, nameKey })), snapshot.fingerprintOrder.map(({ id, nameKey }) => ({ id, nameKey })));
assert.equal('streamUrl' in fetched.layout.fingerprintOrder[0], false);

// A kompakt kliens DTO a channelOrder tömböt kihagyhatja: a szerver a
// fingerprint ID-kből állítja vissza a gyors sorrendet.
const compactLayout = {
  ...snapshot,
  channelOrder: undefined,
  fingerprintOrder: [
    { id: 'compact-2', nameKey: 'második|hu', streamUrl: 'https://private.example/secret' },
    { id: 'compact-1', nameKey: 'első|hu' },
  ],
};
const compactResponse = await handler(request({ action: 'layout_upsert', providerId: snapshot.providerId, layout: compactLayout }));
assert.equal(compactResponse.status, 200);
const compactStored = savedRows.get(`${deviceId}:${snapshot.providerId}`).snapshot;
assert.deepEqual(compactStored.channelOrder, ['compact-2', 'compact-1']);
assert.equal('streamUrl' in compactStored.fingerprintOrder[0], false);

// A régi, URL-eket is tartalmazó snapshotok 1.9 MB fölött sem kapnak többé
// téves 413-at (a szerver továbbra is csak a visszaállításhoz szükséges adatot tárolja).
const largeLayout = {
  ...snapshot,
  totalChannels: 140,
  channelOrder: Array.from({ length: 140 }, (_, i) => `large-${i}`),
  fingerprintOrder: Array.from({ length: 140 }, (_, i) => ({
    id: `large-${i}`,
    nameKey: `channel-${i}|hu`,
    streamUrl: `https://provider.example/${'x'.repeat(14_000)}${i}`,
    displayOrder: i,
  })),
};
assert.ok(Buffer.byteLength(JSON.stringify(largeLayout)) > 1_900_000);
const largeResponse = await handler(request({ action: 'layout_upsert', providerId: snapshot.providerId, layout: largeLayout }));
assert.equal(largeResponse.status, 200);
const largeStored = savedRows.get(`${deviceId}:${snapshot.providerId}`).snapshot;
assert.equal(largeStored.fingerprintOrder.length, 140);
assert.equal('streamUrl' in largeStored.fingerprintOrder[0], false);

console.log('OK – Supabase layout round-trip, kompakt DTO és 1.9 MB fölötti mentés sikeres');
