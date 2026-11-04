#!/usr/bin/env node
/*
 * Élő TV CC (felirat) teszt.
 *
 * Futtatás:  node --test tools/test-live-cc.mjs
 *
 * A teszt a TÉNYLEGES forráskódot futtatja (esbuild-del csomagolja a
 * liveSubtitleService-t, amely az élő adásra használt külön felirat-szolgáltatás):
 *   • MPEG-TS PAT/PMT elemző szintetikus csomagokkal (DVB felirat 0x59 és
 *     teletext 0x56 leírókkal, több csomagon áthaladó szekcióval,
 *     192 bájtos rekordmérettel, csonka adatokkal),
 *   • HLS fődokumentum felirat-variánsainak (EXT-X-MEDIA TYPE=SUBTITLES)
 *     kigyűjtése.
 * A Luna hívási mag ugyanaz, mint a film/sorozat feliratnál, amelyet a
 * test-vod-cc.mjs külön ellenőriz.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let svc = null;
let tmpDir = '';

/* ───────────────────────── TS csomag építő ───────────────────────── */

const PMT_PID = 0x1000;

function tsPacket(pid, payload, pusi, counter) {
  const pkt = Buffer.alloc(188, 0xff);
  pkt[0] = 0x47;
  pkt[1] = ((pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f)) & 0xff;
  pkt[2] = pid & 0xff;
  if (payload.length >= 184) {
    pkt[3] = 0x10 | (counter & 0x0f);
    payload.copy(pkt, 4, 0, 184);
  } else {
    pkt[3] = 0x30 | (counter & 0x0f);
    pkt[4] = 183 - payload.length;
    if (pkt[4] > 0) pkt[5] = 0x00;
    payload.copy(pkt, 188 - payload.length);
  }
  return pkt;
}

function sectionPackets(pid, section) {
  // payload_unit_start: pointer_field=0, majd a szekció; ha nem fér, folytatás.
  const first = Buffer.concat([Buffer.from([0x00]), section]);
  const packets = [];
  let offset = 0;
  let counter = 0;
  let pusi = true;
  while (offset < first.length) {
    const chunk = first.subarray(offset, offset + 184);
    packets.push(tsPacket(pid, Buffer.from(chunk), pusi, counter++));
    offset += chunk.length;
    pusi = false;
  }
  return packets;
}

function buildPat() {
  const body = Buffer.from([
    0x00, 0x01, 0xc1, 0x00, 0x00, // tsid, ver/current, sec 0, last 0
    0x00, 0x01, 0xe0 | ((PMT_PID >> 8) & 0x1f), PMT_PID & 0xff,
  ]);
  const sectionLength = body.length + 4;
  const head = Buffer.from([0x00, 0xb0 | ((sectionLength >> 8) & 0x0f), sectionLength & 0xff]);
  return Buffer.concat([head, body, Buffer.from([0, 0, 0, 0])]);
}

function descriptor(tag, bytes) {
  return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
}
function isoLang(code) {
  return descriptor(0x0a, Buffer.concat([Buffer.from(code, 'ascii'), Buffer.from([0x01])]));
}
function dvbSubs(entries) {
  const all = [];
  for (const code of entries) {
    all.push(Buffer.concat([Buffer.from(code, 'ascii'), Buffer.from([0x02, 0x01, 0x00, 0x01, 0x00])]));
  }
  return descriptor(0x59, Buffer.concat(all));
}
function teletext(entries) {
  const all = [];
  for (const code of entries) {
    all.push(Buffer.concat([Buffer.from(code, 'ascii'), Buffer.from([0x17, 0x88])]));
  }
  return descriptor(0x56, Buffer.concat(all));
}

function esEntry(type, pid, descs) {
  const info = Buffer.concat(descs);
  const head = Buffer.from([
    type,
    0xe0 | ((pid >> 8) & 0x1f), pid & 0xff,
    0xf0 | ((info.length >> 8) & 0x0f), info.length & 0xff,
  ]);
  return Buffer.concat([head, info]);
}

function buildPmt(entries) {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc1, 0x00, 0x00,
      0xe0 | ((0x101 >> 8) & 0x1f), 0x101 & 0xff, 0xf0, 0x00]),
    ...entries,
  ]);
  const sectionLength = body.length + 4;
  const head = Buffer.from([0x02, 0xb0 | ((sectionLength >> 8) & 0x0f), sectionLength & 0xff]);
  return Buffer.concat([head, body, Buffer.from([0, 0, 0, 0])]);
}

function fullStream(pmtEntries) {
  return Buffer.concat([
    ...sectionPackets(0x0000, buildPat()),
    ...sectionPackets(PMT_PID, buildPmt(pmtEntries)),
    ...sectionPackets(0x101, Buffer.alloc(200, 0xab)), // videó csomagok (kitöltés)
  ]);
}

function withRecordSize(buf, size) {
  if (size === 188) return buf;
  const out = [];
  const extra = size - 188;
  for (let i = 0; i + 188 <= buf.length; i += 188) {
    out.push(Buffer.alloc(extra, 0x00));
    out.push(buf.subarray(i, i + 188));
  }
  return Buffer.concat(out);
}

const entriesDvbTeletext = () => [
  esEntry(0x1b, 0x101, []), // H.264 videó
  esEntry(0x04, 0x102, [isoLang('hun')]), // AAC hang
  esEntry(0x06, 0x103, [dvbSubs(['hun'])]), // DVB felirat
  esEntry(0x06, 0x104, [teletext(['hun'])]), // teletext felirat
];

/* ───────────────────────── Betöltés ───────────────────────── */

const buf = (b) => new Uint8Array(b);

before(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'live-cc-'));
  const esbuildPath = path.join(ROOT, 'web', 'node_modules', 'esbuild', 'lib', 'main.js');
  const esbuild = (await import(esbuildPath)).default || (await import(esbuildPath));
  const stub = path.join(tmpDir, 'appLog-stub.mjs');
  // A hálózati réteg (net.ts) a szolgáltató-beolvasás figyelőjét is az appLogból
  // használja, ezért a stubnak a teljes, általa használt felületet ismernie kell.
  const stubSource = `
export function appLog() {}
export function appLogError() {}
export function appLogCritical() {}
export function logPhase() {}
export function logMemory() {}
export function logStartup() {}
export function logProviderEvent() {}
export function logProviderRequest() {}
export function logProviderPhaseStart() {}
export function logProviderPhaseEnd() {}
export function providerEndpointLabel() { return 'stub'; }
export function formatBytes() { return '0 B'; }
export function isVerbosePlaybackLogging() { return false; }
`;
  await fsp.writeFile(stub, stubSource);
  const outfile = path.join(tmpDir, 'live-cc-bundle.mjs');
  await esbuild.build({
    stdin: {
      contents:
        "export { parseTsSubtitleTracks, parseHlsSubtitleTracks, canonicalLiveLang, extractLiveSourceInfoTracks, buildLiveCandidateIndexes, selectLiveSubtitle, disableLiveSubtitle } from './web/src/services/liveSubtitleService.ts';\n",
      resolveDir: ROOT,
      sourcefile: 'live-cc-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    plugins: [{
      name: 'appLog-stub',
      setup(build) {
        build.onResolve({ filter: /appLog$/ }, () => ({ path: stub }));
      },
    }],
  });
  svc = await import(outfile);
});

after(async () => {
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
});

/* ───────────────────────── Tesztek ───────────────────────── */

test('TS PMT: DVB + teletext magyar feliratsávok listázása', () => {
  const tracks = svc.parseTsSubtitleTracks(buf(fullStream(entriesDvbTeletext())));
  assert.ok(Array.isArray(tracks), 'a PMT teljes, nem kér több adatot');
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].lang, 'hun');
  assert.equal(tracks[0].codec, 'DVB');
  assert.match(tracks[0].name, /Magyar/);
  assert.equal(tracks[0].lunaIndex, 0);
  assert.match(tracks[1].codec, /teletext/i);
  assert.equal(tracks[1].lunaIndex, 1);
});

test('TS PMT: egy streamben több nyelvű DVB felirat', () => {
  const tracks = svc.parseTsSubtitleTracks(buf(fullStream([
    esEntry(0x1b, 0x101, []),
    esEntry(0x06, 0x103, [dvbSubs(['hun', 'eng'])]),
  ])));
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].lang, 'hun');
  assert.equal(tracks[1].lang, 'eng');
  assert.equal(tracks[1].lunaIndex, 1);
});

test('TS PMT: felirat nélküli adás üres listát ad (nem kér több adatot)', () => {
  const tracks = svc.parseTsSubtitleTracks(buf(fullStream([
    esEntry(0x1b, 0x101, []),
    esEntry(0x04, 0x102, [isoLang('hun')]),
  ])));
  assert.deepEqual(tracks, []);
});

test('TS PMT: csonka adat további letöltést kér (null)', () => {
  const all = fullStream(entriesDvbTeletext());
  const patOnly = buf(all.subarray(0, 188));
  assert.equal(svc.parseTsSubtitleTracks(patOnly), null);
  assert.equal(svc.parseTsSubtitleTracks(new Uint8Array(0)), null);
  assert.equal(svc.parseTsSubtitleTracks(buf(Buffer.from('not a ts stream at all'))), null);
});

test('TS PMT: több csomagon áthaladó szekció összeállítása', () => {
  const filler = descriptor(0x5f, Buffer.alloc(200, 0x11)); // hosszú magánleíró
  const tracks = svc.parseTsSubtitleTracks(buf(fullStream([
    esEntry(0x1b, 0x101, [filler]),
    esEntry(0x06, 0x103, [dvbSubs(['hun'])]),
  ])));
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].lang, 'hun');
});

test('TS PMT: 192 bájtos rekordméret felismerése', () => {
  const stream = withRecordSize(fullStream(entriesDvbTeletext()), 192);
  const tracks = svc.parseTsSubtitleTracks(buf(stream));
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].lang, 'hun');
});

test('HLS: EXT-X-MEDIA felirat-variánsok listázása', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Hungarian",LANGUAGE="hu",AUTOSELECT=YES,URI="subs/hu.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Hungarian",LANGUAGE="hu"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,SUBTITLES="subs",AUDIO="aud"',
    'live.m3u8',
    '',
  ].join('\n');
  const tracks = svc.parseHlsSubtitleTracks(master);
  assert.ok(Array.isArray(tracks));
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].lang, 'hu');
  assert.equal(tracks[0].name, 'Hungarian');
  assert.equal(tracks[1].lang, 'en');
  assert.equal(tracks[1].lunaIndex, 1);
});

test('HLS: nem lejátszási lista null, média-lista felirat nélkül üres', () => {
  assert.equal(svc.parseHlsSubtitleTracks('Garbage data that is not a playlist'), null);
  const media = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', 'seg1.ts', ''].join('\n');
  assert.deepEqual(svc.parseHlsSubtitleTracks(media), []);
});

/* ───────────────────────── Élő bekapcsolás (Luna) ───────────────────────── */

test('Élő CC: nyelvkódok egységesítése (hun / Hungary / Magyar ugyanaz)', () => {
  assert.equal(svc.canonicalLiveLang('hun'), 'hu');
  assert.equal(svc.canonicalLiveLang('hu-HU'), 'hu');
  assert.equal(svc.canonicalLiveLang('Hungary'), 'hu');
  assert.equal(svc.canonicalLiveLang('hungarian'), 'hu');
  assert.equal(svc.canonicalLiveLang('Magyar'), 'hu');
  assert.equal(svc.canonicalLiveLang('Magyar (DVB)'), 'hu');
  assert.equal(svc.canonicalLiveLang('eng'), 'en');
  assert.equal(svc.canonicalLiveLang('English'), 'en');
  assert.equal(svc.canonicalLiveLang('deu'), 'de');
  assert.equal(svc.canonicalLiveLang(''), '');
  assert.equal(svc.canonicalLiveLang(undefined), '');
});

test('Élő CC: a TV sourceInfo listája a képalapú (DVB) sávokkal együtt', () => {
  const payload = {
    sourceInfo: {
      numSubtitleTracks: 3,
      subtitleTrackInfo: [
        { language: 'eng', type: 'image' },
        { language: 'hun', type: 'text' },
        { language: 'hun', type: 'DVB' },
      ],
    },
  };
  const tracks = svc.extractLiveSourceInfoTracks(payload);
  assert.equal(tracks.length, 3);
  assert.deepEqual(tracks.map((t) => t.isBitmap), [true, false, true]);
  assert.equal(tracks[1].lang, 'hun');
  const counted = svc.extractLiveSourceInfoTracks({ sourceInfo: { numSubtitleTracks: 2 } });
  assert.equal(counted.length, 2);
  assert.equal(svc.extractLiveSourceInfoTracks({ mas: 'adat' }), null);
});

test('Élő CC: TV-sorszám jelöltek a TV listája alapján, nyelv szerint', () => {
  const tv = [
    { lang: 'eng', name: '', type: 'image', isBitmap: true },
    { lang: 'hun', name: '', type: 'text', isBitmap: false },
    { lang: 'hun', name: '', type: 'DVB', isBitmap: true },
  ];
  // szöveges magyar (a PMT-ben az 1. helyen): előbb a csak-szöveges sorszám (0), majd a teljes (1)
  assert.deepEqual(svc.buildLiveCandidateIndexes({ lang: 'hu', indexHint: 1, ordinalInLang: 0 }, tv), [0, 1]);
  // második magyar a képalapú: csak a teljes sorszám
  assert.deepEqual(svc.buildLiveCandidateIndexes({ lang: 'Hungary', indexHint: 2, ordinalInLang: 1 }, tv), [2]);
  // nincs ilyen nyelv a TV listájában: a saját sorszám, a lista hosszához szorítva
  assert.deepEqual(svc.buildLiveCandidateIndexes({ lang: 'de', indexHint: 9, ordinalInLang: 0 }, tv), [2]);
  // TV-lista nélkül a PMT sorszám a jelölt
  assert.deepEqual(svc.buildLiveCandidateIndexes({ lang: 'hun', indexHint: 2 }, null), [2]);
});

function makeLiveWindow() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://tv.local/' });
  globalThis.window = dom.window;
  return dom.window;
}

function installFakeMedia(win, behavior) {
  const calls = [];
  win.webOS = {
    service: {
      request(uri, options) {
        calls.push([options.method, options.parameters]);
        const succeed = (payload = {}) => setTimeout(() => options.onSuccess?.({ returnValue: true, ...payload }), 0);
        const reject = (text = 'elutasítva') => setTimeout(() => options.onFailure?.({ returnValue: false, errorText: text }), 0);
        behavior({ method: options.method, parameters: options.parameters, succeed, reject });
      },
    },
  };
  return calls;
}

test('Élő CC bekapcsolás: a TV listája alapján, nyelv szerint választ (PMT sorszám helyett)', async () => {
  const win = makeLiveWindow();
  const calls = installFakeMedia(win, ({ method, parameters, succeed, reject }) => {
    if (method === 'subscribe') {
      succeed({
        sourceInfo: {
          subtitleTrackInfo: [
            { language: 'eng', type: 'image' },
            { language: 'hun', type: 'text' },
          ],
        },
      });
      return;
    }
    // A TV csak a csak-szöveges sorszámozást fogadja el: a magyar a 0.
    if (method === 'selectTrack') {
      if (parameters.type === 'text' && parameters.index === 0) succeed(); else reject('invalid index');
      return;
    }
    succeed();
  });
  const ok = await svc.selectLiveSubtitle(
    { mediaId: '_live1' },
    { lang: 'hun', codec: 'Teletext', indexHint: 1, ordinalInLang: 0 },
    100,
    { retryDelaysMs: [0], enableSettleMs: 1, queryTimeoutMs: 300 },
  );
  assert.equal(ok, true);
  const methods = calls.map(([method]) => method);
  assert.ok(methods.indexOf('setSubtitleEnable') < methods.indexOf('selectTrack'), 'előbb bekapcsol, utána választ');
  const selects = calls.filter(([method]) => method === 'selectTrack').map(([, p]) => [p.type, p.index]);
  assert.deepEqual(selects, [['text', 0]]);
});

test('Élő CC bekapcsolás: ha a text hívást a TV elutasítja, a dokumentált subtitle alakkal próbálkozik', async () => {
  const win = makeLiveWindow();
  const calls = installFakeMedia(win, ({ method, parameters, succeed, reject }) => {
    if (method === 'subscribe') {
      succeed({ sourceInfo: { subtitleTrackInfo: [{ language: 'hun', type: 'DVB' }] } });
      return;
    }
    if (method === 'selectTrack') {
      if (parameters.type === 'subtitle' && parameters.index === 0) succeed(); else reject('unknown type');
      return;
    }
    succeed();
  });
  const ok = await svc.selectLiveSubtitle(
    { mediaId: '_live2' },
    { lang: 'Hungary', codec: 'DVB', indexHint: 0, ordinalInLang: 0 },
    100,
    { retryDelaysMs: [0], enableSettleMs: 1, queryTimeoutMs: 300 },
  );
  assert.equal(ok, true);
  const types = calls.filter(([method]) => method === 'selectTrack').map(([, p]) => p.type);
  assert.deepEqual(types, ['text', 'subtitle']);
});

test('Élő CC bekapcsolás: minden próbálkozás elutasítva → hibát jelez és lekapcsol', async () => {
  const win = makeLiveWindow();
  const calls = installFakeMedia(win, ({ method, succeed, reject }) => {
    if (method === 'subscribe') return; // nem jön sourceInfo: a PMT sorszám a tartalék
    if (method === 'selectTrack') { reject('no track'); return; }
    succeed();
  });
  const ok = await svc.selectLiveSubtitle(
    { mediaId: '_live3' },
    { lang: 'hun', codec: 'DVB', indexHint: 1, ordinalInLang: 0 },
    100,
    { retryDelaysMs: [0, 1], enableSettleMs: 1, queryTimeoutMs: 30 },
  );
  assert.equal(ok, false);
  const selects = calls.filter(([method]) => method === 'selectTrack');
  assert.equal(selects.length, 4); // 2 kör × 2 hívásalak
  const lastEnable = [...calls].reverse().find(([method]) => method === 'setSubtitleEnable');
  assert.equal(lastEnable[1].enable, false);

  await svc.disableLiveSubtitle({ mediaId: '_live3' });
  const enables = calls.filter(([method]) => method === 'setSubtitleEnable').map(([, p]) => p.enable);
  assert.equal(enables[enables.length - 1], false);
});

test('Élő CC bekapcsolás: Luna híd nélkül gyorsan hibát ad (nem akad el)', async () => {
  makeLiveWindow();
  const started = Date.now();
  assert.equal(await svc.selectLiveSubtitle(null, { lang: 'hun', indexHint: 0 }), false);
  assert.ok(Date.now() - started < 3000);
});

test('A forrásfájlok a helyükön vannak (éles kódút ellenőrzés)', () => {
  const live = fs.readFileSync(path.join(ROOT, 'web', 'src', 'services', 'liveSubtitleService.ts'), 'utf8');
  assert.match(live, /export function parseTsSubtitleTracks/);
  assert.match(live, /export async function probeLiveSubtitles/);
  const player = fs.readFileSync(path.join(ROOT, 'web', 'src', 'components', 'VideoPlayer.tsx'), 'utf8');
  assert.match(player, /luna-tv:/);
  assert.match(player, /selectLiveSubtitle\(videoElement, request/);
  assert.match(player, /desiredLiveSubRef/);
  assert.match(live, /export function buildLiveCandidateIndexes/);
  assert.match(player, /subscribeLiveSubtitleTracks\(video/);
});
