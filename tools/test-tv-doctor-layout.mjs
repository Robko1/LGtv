#!/usr/bin/env node
// A magyar csatornaelrendezés különálló tv-channel-layout Edge Function round-trip tesztje.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = createRequire(path.join(root, 'web/package.json'))('esbuild');
const bundlePath = path.join(root, 'build/test/tv-channel-layout-edge.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'supabase/functions/tv-channel-layout/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  outfile: bundlePath,
  logLevel: 'silent',
});

const deviceId = 'device-layout-test';
const deviceToken = 'tvd_a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const now = Date.now();
const device = {
  device_id: deviceId,
  token_hash: createHash('sha256').update(deviceToken).digest('hex'),
  token_expires_at: new Date(now + 60 * 24 * 60 * 60 * 1000).toISOString(),
  previous_token_hash: null,
  previous_token_grace_until: null,
  revoked: false,
};
const savedRows = new Map();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  if (target.pathname.endsWith('/tv_doctor_paired_devices')) {
    return Response.json([device]);
  }
  if (target.pathname.endsWith('/tv_channel_layout_snapshots')) {
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'POST') {
      const incoming = JSON.parse(String(init.body || '[]'));
      for (const row of Array.isArray(incoming) ? incoming : [incoming]) {
        savedRows.set(`${row.device_id}:${row.provider_id}`, row);
      }
      return new Response(null, { status: 204 });
    }
    const row = savedRows.get(`${deviceId}:__HU_LAYOUT_GLOBAL__`);
    return Response.json(row ? [row] : []);
  }
  return originalFetch ? originalFetch(url, init) : new Response('{}', { status: 404 });
};

let handler;
globalThis.Deno = {
  env: { get(name) {
    if (name === 'SUPABASE_URL') return 'https://supabase.example';
    if (name === 'SUPABASE_SERVICE_ROLE_KEY') return 'test-service-role-key';
    return '';
  } },
  serve(fn) { handler = fn; },
};
await import(pathToFileURL(bundlePath).href);
assert.equal(typeof handler, 'function', 'a különálló layout Edge Function regisztrálja a kezelőt');

const request = (body, authorized = true) => new Request('https://edge.example/functions/v1/tv-channel-layout', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(authorized ? {
      'x-tv-device-id': deviceId,
      'x-tv-device-token': deviceToken,
    } : {}),
  },
  body: JSON.stringify(body),
});

const snapshot = {
  version: '2.5.341',
  createdAt: new Date(now).toISOString(),
  providerId: 'provider-1',
  providerName: 'Teszt szolgáltató',
  totalChannels: 2,
  channelOrder: ['ch-1', 'ch-2', 'ch-1'],
  hungarianChannelIds: ['ch-1', 'ch-2', 'foreign-id'],
  fingerprintOrder: [
    { id: 'ch-1', nameKey: 'm1|hu', countryCode: 'HU' },
    { id: 'ch-2', nameKey: 'm2|hu', countryCode: 'HU' },
  ],
  deletedChannels: [],
  folders: [{ id: 'fav-1', name: 'Kedvencek', channelIds: ['ch-1', 'foreign-id', 'ch-2'] }],
};

const unpaired = await handler(request({ action: 'layout_fetch' }, false));
assert.equal(unpaired.status, 401, 'a párosítatlan készülék nem olvashat elrendezést');

const upsertResponse = await handler(request({ action: 'layout_upsert', layout: snapshot }));
const upsert = await upsertResponse.json();
assert.equal(upsertResponse.status, 200);
assert.equal(upsert.saved, true);
assert.equal(savedRows.size, 1);

const fetchResponse = await handler(request({ action: 'layout_fetch' }));
const fetched = await fetchResponse.json();
assert.equal(fetchResponse.status, 200);
assert.equal(fetched.found, true);
assert.deepEqual(fetched.layout.channelOrder, ['ch-1', 'ch-2']);
assert.equal(fetched.layout.providerId, '__HU_LAYOUT_GLOBAL__');
assert.deepEqual(fetched.layout.hungarianChannelIds, ['ch-1', 'ch-2']);
assert.deepEqual(fetched.layout.folders[0].channelIds, ['ch-1', 'ch-2']);
assert.deepEqual(
  fetched.layout.fingerprintOrder.map(({ id, nameKey }) => ({ id, nameKey })),
  snapshot.fingerprintOrder.map(({ id, nameKey }) => ({ id, nameKey })),
);

// A 4,5 MB-os szerverkorláton belüli nagyobb mentés elfogadható.
const largeIds = Array.from({ length: 140 }, (_, i) => `large-${i}`);
const largeLayout = {
  ...snapshot,
  channelOrder: largeIds,
  hungarianChannelIds: largeIds,
  fingerprintOrder: largeIds.map((id, i) => ({ id, nameKey: `channel-${i}|hu`, countryCode: 'HU' })),
  padding: 'x'.repeat(1_900_000),
};
assert.ok(Buffer.byteLength(JSON.stringify(largeLayout)) > 1_900_000);
const largeResponse = await handler(request({ action: 'layout_upsert', layout: largeLayout }));
assert.equal(largeResponse.status, 200);
const largeStored = savedRows.get(`${deviceId}:__HU_LAYOUT_GLOBAL__`).snapshot;
assert.equal(largeStored.fingerprintOrder.length, 140);
assert.equal(largeStored.hungarianChannelIds.length, 140);

// A készülékhez mentett csatornaszám felső korlátja szerveroldalon érvényesül.
const tooManyIds = Array.from({ length: 1001 }, (_, i) => `too-many-${i}`);
const tooLargeCount = await handler(request({
  action: 'layout_upsert',
  layout: { channelOrder: tooManyIds, fingerprintOrder: tooManyIds.map((id) => ({ id })) },
}));
assert.equal(tooLargeCount.status, 413);

console.log('OK – külön tv-channel-layout Edge Function: hitelesítés, mentés/visszaolvasás, magyar ID-szűrés, nagy mentés és csatornalimit sikeres');
