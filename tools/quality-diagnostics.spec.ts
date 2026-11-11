/**
 * KÉPMINŐSÉG-DIAGNOSZTIKA PRÓBÁJA.
 *
 * A kézi hibakeresési naplóba kerülő KÉPMINŐSÉG sorok akkor hasznosak, ha a
 * bennük lévő adatok VALÓBAN a streamből származnak. Ez a próba a tényleges
 * forráskód olvasóit futtatja szintetikus, de szabványos adatokon:
 *
 *   • MPEG-TS PMT: kép/hang streamtípusok (H.264, HEVC, AAC, AC-3/E-AC-3 a
 *     privát 0x06 típus leíróival) ÉS a felirat-leírók együtt – a feliratlista
 *     nem törhet el a kodek-olvasás bevezetésétől;
 *   • HLS lejátszási lista: a szolgáltató által kínált minőségi szintek
 *     (BANDWIDTH, RESOLUTION, CODECS, FRAME-RATE, VIDEO-RANGE) és a media
 *     lista szegmensszáma;
 *   • Matroska fejléc: a képsáv deklarált felbontása, kodekje és HDR-színadata,
 *     valamint a hangsávok kodekjei;
 *   • a TV `sourceInfo` válaszának többféle alakja (bit/s és kbit/s bitráta);
 *   • a felbontási osztály besorolása (SD … UHD 4K), mert ezt látja a napló.
 *
 * Futtatás: node tools/test-quality-diagnostics.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseTsProgram,
  parseTsSubtitleTracks,
  parseHlsPlaylistInfo,
  tsVideoCodecLabel,
  tsAudioCodecLabels,
} from '../web/src/services/liveSubtitleService';
import {
  parseMatroskaTracks,
  matroskaCodecLabel,
  matroskaHdrLabel,
  extractSourceInfoQuality,
} from '../web/src/services/embeddedSubtitleService';
import { resolutionClassOf } from '../web/src/services/appLog';

/* ─────────────────────────── MPEG-TS összeállítás ─────────────────────────── */

/** Egy 188 bájtos TS csomag a megadott PID-hez, payload_unit_start jelzővel. */
function tsPacket(pid: number, payload: number[], payloadUnitStart = true): number[] {
  const head = [
    0x47,
    (payloadUnitStart ? 0x40 : 0x00) | ((pid >> 8) & 0x1f),
    pid & 0xff,
    0x10, // csak payload
  ];
  const body = payload.slice(0, 184);
  while (body.length < 184) body.push(0xff);
  return [...head, ...body];
}

/** PAT, amely az első program PMT-jét a megadott PID-re teszi. */
function patPacket(pmtPid: number): number[] {
  const section = [
    0x00, 0xb0, 0x0d, // table_id + section_length(13)
    0x00, 0x01, // transport_stream_id
    0xc1, 0x00, 0x00, // verzió + section + last
    0x00, 0x01, // program_number
    0xe0 | ((pmtPid >> 8) & 0x1f), pmtPid & 0xff,
    0x00, 0x00, 0x00, 0x00, // CRC (az olvasó nem ellenőrzi)
  ];
  return tsPacket(0, [0x00, ...section]);
}

interface TestStream {
  type: number;
  pid: number;
  descriptorTags?: number[];
}

/** PMT csomag a megadott elemi streamekkel (a leírók a feliratokhoz kellenek). */
function pmtPacket(streams: TestStream[]): number[] {
  const body: number[] = [];
  for (const stream of streams) {
    const descriptors: number[] = [];
    for (const tag of stream.descriptorTags || []) {
      if (tag === 0x59) {
        // DVB subtitling descriptor: 8 bájtos bejegyzés (nyelv + típus + oldalak)
        descriptors.push(0x59, 8, 0x68, 0x75, 0x6e, 0x10, 0x00, 0x01, 0x00, 0x02);
      } else if (tag === 0x6a) {
        descriptors.push(0x6a, 1, 0x00); // AC-3
      } else if (tag === 0x7a) {
        descriptors.push(0x7a, 1, 0x00); // E-AC-3
      }
    }
    body.push(
      stream.type,
      0xe0 | ((stream.pid >> 8) & 0x1f), stream.pid & 0xff,
      0xf0 | ((descriptors.length >> 8) & 0x0f), descriptors.length & 0xff,
      ...descriptors,
    );
  }
  const sectionLength = 9 + body.length + 4;
  const section = [
    0x02, 0xb0 | ((sectionLength >> 8) & 0x0f), sectionLength & 0xff,
    0x00, 0x01, // program_number
    0xc1, 0x00, 0x00, // verzió + section + last
    0xe1, 0x00, // PCR PID
    0xf0, 0x00, // program_info_length
    ...body,
    0x00, 0x00, 0x00, 0x00, // CRC
  ];
  return tsPacket(0x1000, [0x00, ...section]);
}

const PMT_PID = 0x1000;

function buildTs(streams: TestStream[]): Uint8Array {
  // A valódi streamben mindig sok csomag jön egymás után; a csomagméret
  // felismeréséhez legalább három egymást követő 0x47 szinkronbájt kell.
  // A záró null-csomag (PID 0x1FFF) ezt adja, és a valóságban is ott van.
  const nullPacket = tsPacket(0x1fff, [0xff], false);
  return new Uint8Array([...patPacket(PMT_PID), ...pmtPacket(streams), ...nullPacket]);
}

/* ───────────────────────────── MPEG-TS próbák ───────────────────────────── */

test('PMT: a H.264 kép és az AAC hang kodekje kiolvasható, a feliratlista változatlan', () => {
  const bytes = buildTs([
    { type: 0x1b, pid: 0x0100 },          // H.264
    { type: 0x0f, pid: 0x0101 },          // AAC
    { type: 0x06, pid: 0x0102, descriptorTags: [0x59] }, // DVB felirat
  ]);
  const program = parseTsProgram(bytes);
  assert.ok(program, 'a PMT-nek kiolvashatónak kell lennie');
  assert.equal(tsVideoCodecLabel(program.streams), 'H.264/AVC');
  assert.deepEqual(tsAudioCodecLabels(program.streams), ['AAC']);
  assert.equal(program.subtitles.length, 1, 'a DVB feliratsáv nem tűnhet el');
  assert.equal(program.subtitles[0].codec, 'DVB');
  assert.equal(program.subtitles[0].lang, 'hun');
  // A régi, csak-feliratos belépési pont ugyanazt adja.
  assert.deepEqual(parseTsSubtitleTracks(bytes), program.subtitles);
});

test('PMT: a HEVC (4K) kép és az AC-3/E-AC-3 privát hangtípus felismerhető', () => {
  const hevc = parseTsProgram(buildTs([
    { type: 0x24, pid: 0x0200 },
    { type: 0x06, pid: 0x0201, descriptorTags: [0x6a] },
    { type: 0x06, pid: 0x0202, descriptorTags: [0x7a] },
  ]));
  assert.ok(hevc);
  assert.equal(tsVideoCodecLabel(hevc.streams), 'H.265/HEVC');
  // A hangsávok a PMT sorrendjében jelennek meg: 0x6A (AC-3), majd 0x7A (E-AC-3).
  assert.deepEqual(tsAudioCodecLabels(hevc.streams), ['AC-3', 'E-AC-3']);

  const avc = parseTsProgram(buildTs([{ type: 0x1b, pid: 0x0300 }, { type: 0x81, pid: 0x0301 }]));
  assert.ok(avc);
  assert.equal(tsVideoCodecLabel(avc.streams), 'H.264/AVC');
  assert.deepEqual(tsAudioCodecLabels(avc.streams), ['AC-3']);
});

test('PMT: ha a stream elején még nincs PMT, nem ad hamis adatot', () => {
  const noise = new Uint8Array(400);
  for (let i = 0; i < noise.length; i += 1) noise[i] = i % 251;
  assert.equal(parseTsProgram(noise), null);
});

/* ──────────────────────────── HLS lista próbák ──────────────────────────── */

const HLS_MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=7200000,RESOLUTION=1920x1080,FRAME-RATE=50.000,CODECS="avc1.640028,mp4a.40.2"',
  '1080p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,FRAME-RATE=50.000,CODECS="hvc1.2.4.L150.B0,ec-3",VIDEO-RANGE=PQ',
  '2160p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  '720p/index.m3u8',
].join('\n');

test('HLS master: a kínált szintek (felbontás, bitráta, kodek, HDR) kiolvashatók', () => {
  const info = parseHlsPlaylistInfo(HLS_MASTER);
  assert.ok(info);
  assert.equal(info.variants.length, 3);
  const uhd = info.variants[1];
  assert.equal(uhd.resolution, '3840x2160');
  assert.equal(uhd.bandwidth, 16000000);
  assert.equal(uhd.codecs, 'hvc1.2.4.L150.B0,ec-3');
  assert.equal(uhd.videoRange, 'PQ');
  assert.equal(info.variants[0].averageBandwidth, 7200000);
  assert.equal(info.variants[0].frameRate, '50.000');
  assert.equal(info.segmentCount, 0, 'master listában nincsenek szegmensek');
});

const HLS_MEDIA = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXTINF:5.760,',
  'seg-1.ts',
  '#EXTINF:5.760,',
  'seg-2.ts',
  '#EXTINF:5.760,',
  'seg-3.ts',
].join('\n');

test('HLS media lista: szegmensszám és céltartam, nincs variánslista', () => {
  const info = parseHlsPlaylistInfo(HLS_MEDIA);
  assert.ok(info);
  assert.equal(info.variants.length, 0);
  assert.equal(info.segmentCount, 3);
  assert.equal(info.targetDuration, 6);
  assert.equal(parseHlsPlaylistInfo('nem lejátszási lista'), null);
});

/* ─────────────────────────── Matroska fejléc ─────────────────────────── */

function vintSize(value: number): Buffer {
  if (value < 0x7f) return Buffer.from([0x80 | value]);
  if (value < 0x3fff) return Buffer.from([0x40 | (value >> 8), value & 0xff]);
  return Buffer.from([0x20 | (value >> 16), (value >> 8) & 0xff, value & 0xff]);
}
function elem(idHex: string, payload: Buffer, unknownSize = false): Buffer {
  const id = Buffer.from(idHex, 'hex');
  const size = unknownSize ? Buffer.from([0xff]) : vintSize(payload.length);
  return Buffer.concat([id, size, payload]);
}
const uintElem = (idHex: string, n: number) => elem(idHex, Buffer.from([n]));
const strElem = (idHex: string, s: string) => elem(idHex, Buffer.from(s, 'utf8'));

function videoTrackEntry(): Buffer {
  const colour = elem('55B0', Buffer.concat([
    uintElem('55BA', 16), // átvitel: PQ (HDR10)
    uintElem('55BB', 9),  // elsődleges szín: BT.2020
  ]));
  const video = elem('E0', Buffer.concat([
    uintElem('B0', 0),
    Buffer.from([0xb0, 0x82, 0x0f, 0x00]), // PixelWidth = 3840 (0x0F00)
    Buffer.from([0xba, 0x82, 0x08, 0x70]), // PixelHeight = 2160 (0x0870)
    colour,
  ]));
  return elem('AE', Buffer.concat([
    uintElem('D7', 1),
    uintElem('83', 1), // típus: kép
    strElem('86', 'V_MPEGH/ISO/HEVC'),
    video,
  ]));
}

function buildMkv(): Uint8Array {
  const tracks = elem('1654AE6B', Buffer.concat([
    videoTrackEntry(),
    elem('AE', Buffer.concat([uintElem('D7', 1), uintElem('83', 2), strElem('86', 'A_EAC3')])),
    elem('AE', Buffer.concat([
      uintElem('D7', 1), uintElem('83', 17), strElem('86', 'S_TEXT/UTF8'), strElem('22B59C', 'hun'),
    ])),
  ]));
  const segment = elem('18538067', Buffer.concat([
    tracks,
    elem('1F43B675', Buffer.alloc(16)),
  ]), true);
  const header = elem('1A45DFA3', Buffer.concat([strElem('4282', 'matroska')]));
  return new Uint8Array(Buffer.concat([header, segment]));
}

test('Matroska: a képsáv felbontása, kodekje és HDR-színadata kiolvasható', () => {
  const parsed = parseMatroskaTracks(buildMkv());
  assert.ok(parsed);
  assert.ok(parsed.video, 'a képsáv adatainak meg kell jelenniük');
  assert.equal(parsed.video.codec, 'H.265/HEVC');
  assert.equal(parsed.video.codecId, 'V_MPEGH/ISO/HEVC');
  assert.equal(parsed.video.width, 3840);
  assert.equal(parsed.video.height, 2160);
  assert.equal(parsed.video.hdr, 'PQ (HDR10)');
  assert.deepEqual(parsed.audioCodecs, ['E-AC-3']);
  // A feliratlista ettől változatlanul működik.
  assert.equal(parsed.subtitles.length, 1);
  assert.equal(parsed.subtitles[0].lang, 'hun');
});

test('Matroska: a kodek- és HDR-nevek emberi alakja helyes', () => {
  assert.equal(matroskaCodecLabel('V_MPEG4/ISO/AVC'), 'H.264/AVC');
  assert.equal(matroskaCodecLabel('V_MPEGH/ISO/HEVC'), 'H.265/HEVC');
  assert.equal(matroskaCodecLabel('V_AV1'), 'AV1');
  assert.equal(matroskaCodecLabel('A_AAC'), 'AAC');
  assert.equal(matroskaHdrLabel(16, 9), 'PQ (HDR10)');
  assert.equal(matroskaHdrLabel(18, 9), 'HLG');
  assert.equal(matroskaHdrLabel(0, 9), 'BT.2020 szín (átvitel nincs jelölve)');
  assert.equal(matroskaHdrLabel(1, 1), '');
});

/* ──────────────────────── TV sourceInfo képadatok ──────────────────────── */

test('sourceInfo: a képsáv adatai több válaszalakból is kiolvashatók', () => {
  const flat = extractSourceInfoQuality({
    returnValue: true,
    videoTrackInfo: [{ codec: 'H.264', width: 1920, height: 1080, frameRate: 50, bitRate: 8000000 }],
  });
  assert.ok(flat);
  assert.equal(flat.videoCodec, 'H.264');
  assert.equal(flat.width, 1920);
  assert.equal(flat.height, 1080);
  assert.equal(flat.frameRate, 50);
  assert.equal(flat.bitrateKbps, 8000, 'a bit/s értéket kbit/s-ra kell váltani');

  const nested = extractSourceInfoQuality({
    sourceInfo: { videoTracks: [{ videoCodec: 'HEVC', horizontalSize: 3840, verticalSize: 2160, bitrate: 24000, hdr: 'HLG' }] },
  });
  assert.ok(nested);
  assert.equal(nested.width, 3840);
  assert.equal(nested.height, 2160);
  assert.equal(nested.bitrateKbps, 24000, 'a már kbit/s-ban adott érték marad');
  assert.equal(nested.hdr, 'HLG');

  assert.equal(extractSourceInfoQuality({ returnValue: true, subtitleTrackInfo: [] }), null);
  assert.equal(extractSourceInfoQuality(null), null);
});

/* ───────────────────────── Felbontási besorolás ───────────────────────── */

test('a napló felbontási osztálya a mért képméretből számol', () => {
  assert.equal(resolutionClassOf(3840, 2160), 'UHD 4K');
  assert.equal(resolutionClassOf(2560, 1440), 'QHD');
  assert.equal(resolutionClassOf(1920, 1080), 'Full HD');
  assert.equal(resolutionClassOf(1280, 720), 'HD');
  assert.equal(resolutionClassOf(1024, 576), 'SD+');
  assert.equal(resolutionClassOf(720, 405), 'SD');
  assert.equal(resolutionClassOf(0, 0), 'ismeretlen');
});
