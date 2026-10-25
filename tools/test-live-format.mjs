#!/usr/bin/env node
/*
 * CSATORNÁNKÉNTI FORMÁTUM-EMLÉKEZET – valódi futásidejű teszt.
 *
 * A napló tanúsága szerint ugyanaz a csatorna („[HU] ATV”) minden váltásnál
 * ugyanazzal a „Format error” hibával esett ki, mert a lejátszó csak egy
 * GLOBÁLIS formátumemlékezetet használt. Ez a teszt a valódi modult futtatja
 * (esbuild-del ESM-re fordítva), és ellenőrzi a viselkedését.
 *
 * Futtatás: node tools/test-live-format.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const results = [];
let failed = false;

function check(ok, message) {
  const line = `${ok ? 'ok  ' : 'FAIL'} – ${message}`;
  results.push(line);
  console.log(line);
  if (!ok) failed = true;
}

function finish(code) {
  console.log(failed ? '\nHIBA: a formátum-emlékezet tesztje nem futott át.' : '\nOK: a formátum-emlékezet minden ellenőrzése átment.');
  process.exit(failed ? 1 : (code || 0));
}

/* ── 1. A modul lefordítása (a valódi forrásból, nem másolatból) ────────── */
const source = path.resolve('web/src/services/liveFormatMemory.ts');
if (!fs.existsSync(source)) {
  check(false, `hiányzik a modul: ${source}`);
  finish();
}

let esbuild;
try {
  const requireFromWeb = createRequire(path.resolve('web/package.json'));
  esbuild = requireFromWeb('esbuild');
} catch {
  console.log('KIPARANCSOLT: az esbuild nem érhető el (cd web && npm install)');
  process.exit(0);
}

const outDir = path.resolve('build/test');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'liveFormatMemory.mjs');

try {
  await esbuild.build({
    entryPoints: [source],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    outfile: outFile,
    logLevel: 'silent',
  });
} catch (error) {
  check(false, 'a modul fordítása sikertelen: ' + String(error).slice(0, 200));
  finish();
}

/* ── 2. Hamis localStorage a Node-ban ───────────────────────────────────── */
class FakeStorage {
  constructor() { this.map = new Map(); this.failWrites = false; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.map.set(key, String(value));
  }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  key(index) { return Array.from(this.map.keys())[index] ?? null; }
  get length() { return this.map.size; }
}

const fakeStorage = new FakeStorage();
globalThis.window = { localStorage: fakeStorage };

const mod = await import(pathToFileURL(outFile).href);
const {
  formatOfUrl, otherFormat, urlWithFormat, alternativeUrl,
  rememberedFormatFor, rememberFormatFor, forgetFormatFor,
  rememberedGlobalFormat, rememberGlobalFormat, clearFormatMemory,
} = mod;

/* ── 2b. Lejátszási út és automatikus visszaesés – valódi forrás ellenőrzése ── */
const playerSource = fs.readFileSync(path.resolve('web/src/components/VideoPlayer.tsx'), 'utf8');
const settingsSource = fs.readFileSync(path.resolve('web/src/components/MenuSettingsModal.tsx'), 'utf8');

check(playerSource.includes("const primaryUrl = isVod ? streamUrl : (channelMemory === 'hls' ? hlsUrl : tsUrl);"),
  'élő adásnál a korábban sikeres csatornaformátum az első próba, emlék nélkül MPEG-TS');
check(playerSource.includes('const channelMemory = isVod ? null : rememberedFormatFor(channel?.id);'),
  'a formátum-emlékezet csatornánként működik, VOD-ra nem hat');
check(playerSource.includes('const sequence = liveRetrySequenceRef.current;')
  && playerSource.includes('if (nextIndex < sequence.urls.length)')
  && playerSource.includes('urls: alternative ? [primaryUrl, alternative.url] : [primaryUrl]')
  && playerSource.includes('liveRecoveryOnlyRef.current = true'),
  'hiba esetén legfeljebb egy TS/HLS fallback fut, utána kontrollált recovery folytatja');
check(playerSource.includes('const retryDelayMs = Math.min(100 * (2 ** Math.max(0, nextIndex - 1)), 400);'),
  'az egyetlen élő formátum-fallback rövid késleltetést használ');
check(playerSource.includes('attemptStartedAt') && playerSource.includes('CSATORNAVÁLTÁS PRÓBA START')
  && playerSource.includes('teljes-eltelt=') && playerSource.includes('próba-eltelt='),
  'a napló külön méri a teljes csatornaváltást és az egyes próbálkozásokat');
check(playerSource.includes('appLogCritical(`CSATORNAVÁLTÁS HIBA;')
  && playerSource.includes('CSATORNAVÁLTÁS SZINKRON HIBA')
  && playerSource.includes('LEJÁTSZÁSINDÍTÁSI ÍGÉRET HIBA'),
  'a streamhibák részletes, azonnali hibasort kapnak');
check(playerSource.includes('alternativeUrl(primaryUrl)'),
  'a másik TS/HLS URL a formátum-átíró modulból készül');
check(!settingsSource.includes('LG TV lejátszó')
  && !settingsSource.includes('Élő adás formátuma'),
  'a két üres, ismétlődő LG-lejátszó/formátum doboz nincs a Rendszer menüben');
check(!settingsSource.includes('Natív (TV dekóder)'),
  'a nem létező külön natív dekóder-mód nincs többé választhatóként feltüntetve');

/* ── 3. URL-felismerés és átírás ────────────────────────────────────────── */
const TS = 'http://panel.example/live/user/pass/1234.ts';
const HLS = 'http://panel.example/live/user/pass/1234.m3u8';

check(formatOfUrl(TS) === 'ts', 'a .ts cím MPEG-TS formátumként ismert');
check(formatOfUrl(HLS) === 'hls', 'a .m3u8 cím HLS formátumként ismert');
check(formatOfUrl(TS + '?token=abc') === 'ts', 'a lekérdezés (?token=) nem zavarja a felismerést');
check(formatOfUrl('http://panel.example/live/user/pass/1234') === null, 'kiterjesztés nélküli cím: nincs formátum');
check(otherFormat('ts') === 'hls' && otherFormat('hls') === 'ts', 'a másik formátum helyesen vált');
check(urlWithFormat(TS, 'hls') === HLS, 'TS → HLS átírás');
check(urlWithFormat(HLS, 'ts') === TS, 'HLS → TS átírás');

const alt = alternativeUrl(TS);
check(Boolean(alt) && alt.url === HLS && alt.format === 'hls', 'a tartalék cím a másik formátum');
check(alternativeUrl('http://panel.example/live/user/pass/1234') === null,
  'kiterjesztés nélküli címnél NINCS hamis tartalék (nem próbál ugyanarra)');

/* ── 4. Csatornánkénti emlékezet ────────────────────────────────────────── */
check(rememberedFormatFor('ch-atv') === null, 'új csatornánál még nincs emlék');
rememberFormatFor('ch-atv', 'hls');
check(rememberedFormatFor('ch-atv') === 'hls', 'az ATV emléke HLS (a működő formátum)');
check(rememberedFormatFor('ch-rtl') === null, 'a MÁSIK csatorna emléke ettől független');
rememberFormatFor('ch-rtl', 'ts');
check(rememberedFormatFor('ch-atv') === 'hls' && rememberedFormatFor('ch-rtl') === 'ts',
  'két csatorna két különböző formátumot jegyez meg egyszerre');

forgetFormatFor('ch-atv');
check(rememberedFormatFor('ch-atv') === null, 'hiba után a csatorna emléke törölhető');
check(rememberedFormatFor('ch-rtl') === 'ts', 'a törlés a többi csatornát nem érinti');

/* ── 5. Globális (régi) emlékezet továbbra is működik ───────────────────── */
rememberGlobalFormat('hls');
check(rememberedGlobalFormat() === 'hls', 'a globális emlékezet (régi kulcs) is működik');
check(fakeStorage.getItem('iptv_rt_live-format') === 'hls', 'a régi kulcs neve változatlan (visszafelé kompatibilis)');

/* ── 6. Szám-azonosító és hosszú név ────────────────────────────────────── */
rememberFormatFor(42, 'ts');
check(rememberedFormatFor(42) === 'ts' && rememberedFormatFor('42') === 'ts',
  'a szám és a szöveg azonosító ugyanaz a csatorna');

/* ── 7. Sérült tároló: nem dob hibát, üres emlékkel indul ───────────────── */
fakeStorage.setItem('iptv_rt_live-format-memory-v1', '{ez nem json');
check(rememberedFormatFor('ch-rtl') === null, 'sérült JSON esetén üres emlékezet (nincs összeomlás)');
rememberFormatFor('ch-uj', 'hls');
check(rememberedFormatFor('ch-uj') === 'hls', 'sérült tároló után ismét menthető');

/* ── 8. Írási hiba (tele tárhely) nem akasztja meg a lejátszást ─────────── */
fakeStorage.failWrites = true;
let threw = false;
try {
  rememberFormatFor('ch-tele', 'ts');
  rememberGlobalFormat('ts');
} catch { threw = true; }
check(!threw, 'a tele tárhely (QuotaExceeded) nem dob kivételt a lejátszó felé');
fakeStorage.failWrites = false;

/* ── 9. Korlát: a bejegyzések száma nem nő korlátlanul ──────────────────── */
for (let i = 0; i < 3200; i++) rememberFormatFor(`csatorna-${i}`, i % 2 ? 'ts' : 'hls');
const stored = JSON.parse(fakeStorage.getItem('iptv_rt_live-format-memory-v1') || '{}');
const count = Object.keys(stored).length;
check(count <= 3000, `a tárolt bejegyzések száma korlátozott (${count} ≤ 3000)`);
check(rememberedFormatFor('csatorna-3199') === 'ts', 'a legfrissebb bejegyzés megmarad');
check(rememberedFormatFor('csatorna-0') === null, 'a legrégebbi bejegyzés kiesett (nem nő a tárhely)');

/* ── 10. Teljes törlés ──────────────────────────────────────────────────── */
clearFormatMemory();
check(rememberedFormatFor('csatorna-3199') === null, 'a törlés kiüríti a csatorna-emlékezetet');
check(rememberedGlobalFormat() === null, 'a törlés a globális emlékezetet is kiüríti');

try { fs.rmSync(outFile, { force: true }); } catch { /* nem kritikus */ }
finish();
