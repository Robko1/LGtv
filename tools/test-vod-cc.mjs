#!/usr/bin/env node
/*
 * Mozi/Sorozat CC (felirat) teszt.
 *
 * Futtatás:  node --test tools/test-vod-cc.mjs
 *
 * A teszt a TÉNYLEGES forráskódot futtatja (esbuild-del csomagolja a két
 * felirat-szolgáltatást), nem másolatot:
 *   • Matroska (MKV) fejléc elemző szintetikus EBML-lel és – ha van ffmpeg –
 *     valódi, generált MKV fájllal (többnyelvű beágyazott felirattal);
 *   • szolgáltatói (Xtream) feliratlista feloldása helyi HTTP szerverről,
 *     beleértve azt az esetet is, amikor az előzetes próbaletöltés hiba
 *     (a sávnak ilyenkor is szerepelnie kell a CC listában);
 *   • a webOS Luna hívások sorrendje (setSubtitleEnable → selectTrack)
 *     ál-híddal (PalmServiceBridge és webOS.service.request út is);
 *   • sourceInfo tartalék lista és ASS felirat beolvasás.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let svc = null;
let tmpDir = '';
let server = null;
let serverBase = '';

/* ───────────────────────── Segédek ───────────────────────── */

function vintSize(value) {
  // EBML változó méretű egész (méretmező), 1-4 bájt a teszthez elég.
  if (value < 0x7f) return Buffer.from([0x80 | value]);
  if (value < 0x3fff) return Buffer.from([0x40 | (value >> 8), value & 0xff]);
  if (value < 0x1fffff) return Buffer.from([0x20 | (value >> 16), (value >> 8) & 0xff, value & 0xff]);
  return Buffer.from([0x10 | (value >> 24), (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}
function elem(idHex, payload, unknownSize = false) {
  const id = Buffer.from(idHex, 'hex');
  const size = unknownSize ? Buffer.from([0xff]) : vintSize(payload.length);
  return Buffer.concat([id, size, payload]);
}
const uintElem = (idHex, n) => elem(idHex, Buffer.from([n]));
const strElem = (idHex, s) => elem(idHex, Buffer.from(s, 'utf8'));

function trackEntry({ type, codec, lang, langIetf, name, isDefault = 1, forced = 0 }) {
  const parts = [uintElem('D7', 1), uintElem('83', type), strElem('86', codec)];
  if (lang) parts.push(strElem('22B59C', lang));
  if (langIetf) parts.push(strElem('22B59D', langIetf));
  if (name) parts.push(strElem('536E', name));
  parts.push(uintElem('88', isDefault));
  if (forced) parts.push(uintElem('55AA', 1));
  return elem('AE', Buffer.concat(parts));
}

function buildSyntheticMkv() {
  const ebmlHeader = elem('1A45DFA3', Buffer.concat([strElem('4282', 'matroska'), uintElem('42F7', 1)]));
  const tracks = elem('1654AE6B', Buffer.concat([
    trackEntry({ type: 1, codec: 'V_MPEG4/ISO/AVC' }),
    trackEntry({ type: 2, codec: 'A_AC3', lang: 'hun' }),
    trackEntry({ type: 17, codec: 'S_TEXT/UTF8', lang: 'hun', name: 'Magyar' }),
    trackEntry({ type: 17, codec: 'S_HDMV/PGS', lang: 'eng', name: 'English PGS' }),
    trackEntry({ type: 17, codec: 'S_TEXT/ASS', lang: 'eng', name: 'English SDH' }),
    trackEntry({ type: 17, codec: 'S_TEXT/UTF8', lang: 'ger', langIetf: 'de' }),
  ]));
  const segment = elem('18538067', Buffer.concat([
    elem('114D9B74', Buffer.from([0x01, 0x02, 0x03])),
    tracks,
    elem('1F43B675', Buffer.alloc(16)),
  ]), true);
  return Buffer.concat([ebmlHeader, segment]);
}

const SRT_OK = '1\n00:00:01,000 --> 00:00:04,000\nSzia, felirat!\n\n2\n00:00:05,000 --> 00:00:08,000\nMasodik sor\n';

/* ───────────────────────── Előkészítés ───────────────────────── */

before(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vod-cc-'));
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
  const outfile = path.join(tmpDir, 'cc-bundle.mjs');
  await esbuild.build({
    stdin: {
      contents:
        "export { parseMatroskaTracks, isEbmlFile, extractSourceInfoSubtitles, getWebosMediaId, selectEmbeddedSubtitle, disableEmbeddedSubtitle, isLunaSubtitleUnsupported } from './web/src/services/embeddedSubtitleService.ts';\n" +
        "export { collectSubtitleEntries, resolveVodSubtitles, parseSubtitleText, loadSubtitleCues } from './web/src/services/subtitleService.ts';\n",
      resolveDir: ROOT,
      sourcefile: 'cc-entry.ts',
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

  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body, type = 'text/plain') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };
    if (url.pathname === '/player_api.php' && url.searchParams.get('action') === 'get_vod_info') {
      send(200, JSON.stringify({
        info: {
          subtitles: [
            { sub_id: 11, language: 'hu', title: 'Magyar' },
            { sub_id: 12, language: 'en', title: 'English' },
            { language: 'German' },
          ],
        },
        movie_data: { stream_id: 99 },
      }), 'application/json');
      return;
    }
    if (url.pathname === '/subtitle/user/pass/11.srt') { send(200, SRT_OK); return; }
    if (url.pathname === '/subtitle/user/pass/99/12.srt') { send(200, SRT_OK.replace('Szia', 'Hello')); return; }
    send(404, 'nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverBase = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  delete globalThis.window;
});

/* ───────────────────────── MKV fejléc ───────────────────────── */

test('CC: szintetikus MKV fejlécből a szöveges feliratsávok kilistázódnak jó sorrendben', () => {
  const bytes = new Uint8Array(buildSyntheticMkv());
  assert.equal(svc.isEbmlFile(bytes), true);
  const result = svc.parseMatroskaTracks(bytes);
  assert.ok(result, 'a Tracks elemnek olvashatónak kell lennie');
  assert.equal(result.totalSubtitleTracks, 4);
  assert.equal(result.skippedBitmap, 1, 'a PGS képalapú sáv nem választható');
  assert.deepEqual(
    result.subtitles.map((t) => [t.lunaIndex, t.lang, t.name]),
    [[0, 'hun', 'Magyar'], [1, 'eng', 'English SDH'], [2, 'de', '']],
    'Luna index csak a szöveges sávokat számlálja, IETF nyelv győz'
  );
});

test('CC: nem-MKV és Tracks nélküli puffer nem ad hamis listát', () => {
  assert.equal(svc.parseMatroskaTracks(new Uint8Array(Buffer.from('<?xml version="1.0"?>'))), null);
  const noTracks = Buffer.concat([
    elem('1A45DFA3', Buffer.from([0x42, 0x82])),
    elem('18538067', elem('1F43B675', Buffer.alloc(8)), true),
  ]);
  assert.equal(svc.parseMatroskaTracks(new Uint8Array(noTracks)), null);
});

test('CC: valódi ffmpeg MKV többnyelvű beágyazott feliratai kilistázódnak', async (t) => {
  const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
  const probe = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('nincs ffmpeg ebben a környezetben (FFMPEG_BIN-nal megadható)');
    return;
  }
  const dir = await fsp.mkdtemp(path.join(tmpDir, 'mkv-'));
  const langs = [['hun', 'Magyar'], ['eng', 'English'], ['ger', 'Deutsch']];
  for (const [code] of langs) {
    await fsp.writeFile(path.join(dir, `${code}.srt`), `1\n00:00:00,500 --> 00:00:02,000\nFelirat ${code}\n`);
  }
  const out = path.join(dir, 'film.mkv');
  const args = ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=duration=3'];
  langs.forEach(([code]) => args.push('-i', path.join(dir, `${code}.srt`)));
  args.push('-map', '0:v', '-map', '1:a');
  langs.forEach((_, i) => args.push('-map', `${i + 2}:s`));
  langs.forEach(([code, name], i) => args.push([`-metadata:s:s:${i}`][0], `language=${code}`, `-metadata:s:s:${i}`, `title=${name}`));
  args.push('-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'srt', out);
  const run = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  assert.equal(run.status, 0, `ffmpeg hiba: ${String(run.stderr || '').slice(-400)}`);
  const file = await fsp.readFile(out);
  const head = new Uint8Array(file.subarray(0, Math.min(file.length, 1572864)));
  const result = svc.parseMatroskaTracks(head);
  assert.ok(result, 'az ffmpeg fejlécnek olvashatónak kell lennie');
  assert.deepEqual(result.subtitles.map((x) => x.lang), ['hun', 'eng', 'ger']);
  assert.deepEqual(result.subtitles.map((x) => x.lunaIndex), [0, 1, 2]);
});

/* ───────────────────────── Szolgáltatói (Xtream) út ───────────────────────── */

test('CC: szolgáltatói lista minden alakja bejegyzéseket ad', () => {
  const collect = (value) => { const out = []; svc.collectSubtitleEntries(value, out); return out; };
  assert.equal(collect({ info: { subtitles: [{ sub_id: 1 }, { sub_id: 2 }] } }).length, 2);
  assert.equal(collect({ subtitles: { hu: { sub_id: 3 }, en: 'http://x/en.srt' } }).length, 2);
  assert.equal(collect({ subtitles: ['http://x/a.srt', 'hu'] }).length, 2);
  assert.equal(collect({ info: { subtitles: '[{"sub_id":9}]' } }).length, 1);
});

test('CC: szolgáltatói feloldás kilistázza a próbával nem letöltődő sávot is', async () => {
  const tracks = await svc.resolveVodSubtitles({
    serverUrl: serverBase,
    username: 'user',
    password: 'pass',
    vodId: 99,
  });
  assert.equal(tracks.length, 3, `mindhárom felsorolt sáv megjelenik: ${JSON.stringify(tracks)}`);
  assert.ok(tracks[0].url.endsWith('/11.srt'), 'a magyar sáv nyerő címe a közvetlen minta');
  assert.ok(tracks[1].url.endsWith('/99/12.srt'), `az angol sáv a beágyazott (filmazonosítós) mintával jön: ${tracks[1].url}`);
  assert.equal(tracks[2].lang, 'German', 'az azonosító nélküli nyelvi bejegyzés is listázódik');
  assert.equal(new Set(tracks.map((t) => String(t.id))).size, 3, 'egyedi azonosítók');
  const cues = await svc.loadSubtitleCues(tracks[1].urls);
  assert.ok(cues.length >= 2 && cues[0].text.includes('Hello'), 'kiválasztáskor a felirat betölthető');
  assert.deepEqual(await svc.loadSubtitleCues(tracks[2].urls), [], 'nem létező fájl üres listát ad, nem hibát');
});

test('CC: ASS felirat beolvasható', () => {
  const ass = '[Script Info]\nTitle: teszt\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    + 'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Elso \\N sor\n'
    + 'Dialogue: 0,0:00:05.50,0:00:08.00,Default,,0,0,0,,{\\i1}Masodik{\\i0}\n';
  const cues = svc.parseSubtitleText(ass);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Elso \n sor');
  assert.equal(cues[1].start, 5.5);
});

/* ───────────────────────── Luna (TV médiaszolgáltatás) ───────────────────────── */

function makeWebOsWindow() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://tv.local/' });
  globalThis.window = dom.window;
  return dom.window;
}

test('CC: Luna beágyazott felirat kapcsolás PalmServiceBridge-dzsel', async () => {
  const win = makeWebOsWindow();
  const calls = [];
  win.PalmServiceBridge = class {
    call(uri, params) {
      calls.push([uri, JSON.parse(params)]);
      const cb = this.onservicecallback;
      setTimeout(() => cb && cb(JSON.stringify({ returnValue: true })), 0);
    }
  };
  const video = { mediaId: '_testMedia1' };
  const ok = await svc.selectEmbeddedSubtitle(video, 1, 150);
  assert.equal(ok, true);
  assert.deepEqual(calls.map(([uri]) => uri.split('/').pop()), ['setSubtitleEnable', 'selectTrack', 'setSubtitleFontSize']);
  assert.deepEqual(calls[0][1], { mediaId: '_testMedia1', enable: true });
  assert.deepEqual(calls[1][1], { mediaId: '_testMedia1', type: 'text', index: 1 });
  assert.deepEqual(calls[2][1], { mediaId: '_testMedia1', fontSize: 3 });

  calls.length = 0;
  await svc.disableEmbeddedSubtitle(video);
  assert.deepEqual(calls.map(([uri, p]) => [uri.split('/').pop(), p.enable]), [['setSubtitleEnable', false]]);
});

test('CC: Luna kapcsolás webOS.service.request úton előnyben', async () => {
  const win = makeWebOsWindow();
  const calls = [];
  win.webOS = {
    service: {
      request(uri, options) {
        calls.push([uri, options.method, options.parameters]);
        setTimeout(() => options.onSuccess({ returnValue: true }), 0);
      },
    },
  };
  const ok = await svc.selectEmbeddedSubtitle({ mediaId: '_m2' }, 0, 100);
  assert.equal(ok, true);
  assert.equal(calls[0][0], 'luna://com.webos.media');
  assert.deepEqual(calls.slice(0, 2).map((c) => c[1]), ['setSubtitleEnable', 'selectTrack']);
});

test('CC: Luna elutasításnál a választás hibát jelez (nem mutat hamis bekapcsolást)', async () => {
  const win = makeWebOsWindow();
  win.PalmServiceBridge = class {
    call() {
      const cb = this.onservicecallback;
      setTimeout(() => cb && cb(JSON.stringify({ returnValue: false, errorText: 'not supported' })), 0);
    }
  };
  assert.equal(await svc.selectEmbeddedSubtitle({ mediaId: '_m3' }, 0), false);
  assert.equal(svc.isLunaSubtitleUnsupported(), true);
  assert.equal(svc.getWebosMediaId({ mediaId: '<invalid mediaId>' }), null);
  assert.equal(svc.getWebosMediaId({ mediaId: ' abc ' }), 'abc');
});

test('CC: sourceInfo tartalék lista kinyerése', () => {
  const payload = {
    returnValue: true,
    trackInfo: [{
      numSubtitleTracks: 3,
      subtitleTrackInfo: [
        { language: 'hu', type: 'text' },
        { language: 'en', type: 'text' },
        { language: 'de', type: 'bitmap' },
      ],
    }],
  };
  const tracks = svc.extractSourceInfoSubtitles(payload);
  assert.deepEqual(tracks.map((t) => [t.lunaIndex, t.lang]), [[0, 'hu'], [1, 'en']]);
  assert.equal(svc.extractSourceInfoSubtitles({ returnValue: true }), null);
  assert.equal(svc.extractSourceInfoSubtitles({ numSubtitleTracks: 2 }).length, 2);
});
