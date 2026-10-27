#!/usr/bin/env node
/*
 * 2.5.137 – A NAGY VILLANÁS MEGSZÜNTETÉSE (egy kép az elejétől a végéig).
 *
 * A 2026-10-27 01:41:00-es Supabase-napló (79 sor, 2.5.136, üres IPK):
 *   átvitt = 1 760 370 B, válasz = 2493 ms, first-paint = 2569 ms,
 *   LEGNAGYOBB TARTALOM = 4483 ms, majd 4674 ms (a saját poszter-képünk).
 *
 * A felhasználó: „amikor a LG TV elvégezte a dolgát, felvillan a fekete kép,
 * aztán a saját képünk kerül sorra és ott marad, amíg be nem tölt a főoldal”.
 *
 * A javítás: NINCS két kép. A webOS takaróképe és az app első festése ugyanaz
 * az előre rajzolt, sötét főoldali váz (fix fejléc, 16:9 lejátszó, fix OSD,
 * 16:9 csatorna-előnézetek). A HTML 1,76 MB-ról ~114 KB-ra csökkent: a JS/CSS
 * külön fájlba került, nincs beégetett JPEG/PNG, nincs külső betűtípus-kérés.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PAGE = read('web/index.html');
const BUILD = read('tools/build-webos.sh');
const WEBOS = read('webos/webos.js');
const THEME = read('web/src/themes/webos.css');
const APP = read('web/src/App.tsx');
const ADDMODAL = read('web/src/components/AddPlaylistModal.tsx');
const PLAYER = read('web/src/components/VideoPlayer.tsx');
const IMPORT = read('web/src/services/providerImport.ts');
const VERSION = read('web/src/appVersion.ts');
const APPINFO = JSON.parse(read('webos/appinfo.json'));
const MAKE_SPLASH = read('tools/make-splash-skeleton.py');

function bootPage() {
  const calls = [];
  const dom = new JSDOM(PAGE, {
    url: 'https://tv.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.webOSSystem = { notifyAppLoaded: () => calls.push(Date.now()) };
    },
  });
  return { window: dom.window, dom, calls };
}

/* ─────────────── 1. NINCS MÁSODIK KÉP / NINCS BASE64 ─────────────── */

test('a HTML-ben NINCS beégetett kép és NINCS két CSS háttérréteg', () => {
  assert.equal((PAGE.match(/data:image\/jpeg;base64,/g) || []).length, 0,
    'a teljes kép újra be van égetve a HTML-be (lassú válasz + késői festés)');
  assert.equal((PAGE.match(/data:image\/png;base64,/g) || []).length, 1,
    'csak a favicon lehet beégetve');
  assert.equal(PAGE.includes('__IPTV_SPLASH_DATA_URI__'), false);
  assert.equal(PAGE.includes('__IPTV_SPLASH_TINY_URI__'), false);
  assert.doesNotMatch(PAGE, /var splashLayer =/, 'a két CSS-réteg visszatért');
  assert.doesNotMatch(PAGE, /background-image:\s*url\('splash-bg\.jpg'\)/);
  assert.doesNotMatch(PAGE, /#6ccbd3|#5fe3b6|#4fd8e0/i,
    'a régi, lapos zöld/türkiz tartalék szín még mindig a HTML-ben van');
});

test('NINCS külső hálózati betűtípus-kérés az induláskor', () => {
  assert.doesNotMatch(PAGE, /fonts\.googleapis\.com|fonts\.gstatic\.com/,
    'a Google Fonts újra lelassítja a load eseményt (302 ms + DNS)');
  assert.match(PAGE, /font-family:\s*-apple-system/,
    'a rendszer betűtípusát kell használni (nincs FOUT)');
});

test('a logó külön, kis HELYI fájl, amit a <head> azonnal preloadol', () => {
  assert.match(PAGE, /<link rel="preload" as="image" href="boot-logo\.jpg" fetchpriority="high">/);
  assert.match(PAGE, /<img class="sk-art" src="boot-logo\.jpg"[^>]*decoding="sync"/);
  assert.match(PAGE, /preload\.src = 'boot-logo\.jpg';/);
  assert.match(PAGE, /preload\.decode\(\)/);
  assert.ok(fs.statSync(path.join(ROOT, 'tools/boot-logo.jpg')).size < 60_000,
    'a logó túl nagy – visszajön a lassú első festés');
});

/* ─────────────── 2. FIX FŐOLDALI VÁZ: OSD + 16:9 + CSATORNAHELYEK ─────────────── */

test('az első festés egy ELŐRE RAJZOLT, FIX főoldali váz (nem üres kocka)', () => {
  const { window, dom } = bootPage();
  try {
    const doc = window.document;
    const skeleton = doc.getElementById('iptv-skeleton');
    assert.ok(skeleton, 'hiányzik az előre rajzolt főoldali váz');
    assert.ok(doc.getElementById('tv-curtain'), 'hiányzik a takaró réteg');
    for (const slot of ['header', 'player', 'osd', 'channels']) {
      assert.ok(skeleton.querySelector(`[data-iptv-slot="${slot}"]`),
        `hiányzik a fix ${slot} régió – az adatok nem tudnak a helyükre rajzolódni`);
    }
    assert.match(PAGE, /\.sk-player\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/,
      'a lejátszó doboza nem fix 16:9');
    assert.match(PAGE, /\.sk-thumb\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/,
      'a kis csatorna-előnézetek nem fix 16:9-esek');
    assert.equal(skeleton.querySelectorAll('.sk-row').length, 8,
      'a csatornalista fix helyeinek száma megváltozott');
    // A váz TISZTA HTML/CSS – nincs kép-dekódolás az első festéshez.
    assert.equal(skeleton.querySelectorAll('img').length, 1,
      'a vázban csak a kis logó lehet kép');
  } finally {
    dom.window.close();
  }
});

test('a webOS takaróképe UGYANAZ a sötét főoldali váz (nincs második kép)', () => {
  assert.match(MAKE_SPLASH, /def build\(\) -> Image\.Image:/);
  assert.match(MAKE_SPLASH, /16:9 lejátszó doboz/);
  assert.match(MAKE_SPLASH, /OSD sáv/);
  assert.match(MAKE_SPLASH, /csatornalista/);
  assert.match(MAKE_SPLASH, /quantize\(colors=96/,
    'a takarókép nem kicsi – a TV lassan olvasná be');
  assert.match(BUILD, /cp "\$WEBOS_DIR\/splash-screen\.png"/);
  assert.match(BUILD, /shutil\.copy\(logo_src, build_dir \/ "boot-logo\.jpg"\)/);
  assert.equal(APPINFO.splashBackground, 'splash-screen.png',
    'a LG TV ellenőrzéséhez használt takaróképnek meg kell maradnia');
});

test('a HTML és a body háttere VÉGIG sötét – nincs fekete és nincs zöld kocka', () => {
  assert.doesNotMatch(PAGE.replace(/\/\*[\s\S]*?\*\//g, ''), /background(-color)?:\s*#000\b/i);
  assert.doesNotMatch(WEBOS, /body\.webos-tv, body\.lg-webos \{ background:#000/i);
  assert.doesNotMatch(THEME, /body\.webos-theme\s*\{[^}]*background:\s*#000/i);
  assert.match(PAGE, /html\s*\{\s*background-color:\s*#080d1a;/);
  assert.match(PAGE, /html\.iptv-booting body\s*\{\s*background-color:\s*#080d1a !important;/);
  assert.match(PAGE, /html\.iptv-revealed body\s*\{\s*background-color:\s*#080d1a !important;/);
  assert.match(PAGE, /document\.body\.style\.backgroundColor = '#080d1a';/);
  assert.match(PAGE, /document\.documentElement\.style\.backgroundColor = '#080d1a';/);
  // A bgColor sötét, nem fehér és nem a régi világos türkiz.
  const rgb = String(APPINFO.bgColor).replace('#', '');
  const values = [0, 2, 4].map((i) => Number.parseInt(rgb.slice(i, i + 2), 16));
  assert.ok(values.every((v) => v < 120), 'a bgColor újra világos – villanást okozna');
  assert.equal(APPINFO.bgColor.toLowerCase(), '#213c51');
});

test('az üres lejátszó doboza nem fekete és NEM későn dekódolódó kép', () => {
  assert.doesNotMatch(PAGE, /\[data-player-poster\][^}]*background-image:\s*url\(data:image\/jpeg/,
    'a poszter újra későn dekódolódó hátteret kapott (4674 ms-es LCP)');
  assert.match(PAGE, /html\[data-iptv-boot="empty"\] \[data-player-poster\]\s*\{[^}]*linear-gradient/);
  assert.match(PAGE, /html\[data-iptv-boot="empty"\] \[data-player-poster\]::after/);
  assert.match(PLAYER, /\{channel && \(/,
    'a „Kapcsolódás…” felirat újra eltakarja az üres dobozt');
});

/* ─────────────── 3. A HTML KICSI: KÜLSŐ app.js / app.css ─────────────── */

test('a build kiemeli a hatalmas JS-t és CSS-t, az index.html kicsi marad', () => {
  assert.match(BUILD, /def externalize_styles/);
  assert.match(BUILD, /def externalize_scripts/);
  assert.match(BUILD, /<link rel="stylesheet" href="app\.css">/);
  assert.match(BUILD, /<script src="app\.js"/);
  assert.match(BUILD, /data-iptv-es5-app="IPTV-ES5-APP"/);
  assert.match(BUILD, /<link rel=\"preload\" as=\"script\" href=\"app\.js\">/,
    'az app.js előolvasása hiányzik – a parser a dokumentum végén várakozna');
  const built = path.join(ROOT, 'build/webos/index.html');
  if (!fs.existsSync(built)) return;
  const html = fs.readFileSync(built, 'utf8');
  assert.ok(html.length < 200_000,
    `a csomagolt index.html ${html.length} byte – újra 2,5 mp a válaszidő`);
  assert.equal((html.match(/data:image\/jpeg;base64,/g) || []).length, 0);
  assert.match(html, /<script src="app\.js"/);
  assert.match(html, /href="app\.css"/);
  assert.doesNotMatch(html, /<script[^>]*type="module"/);
  assert.ok(fs.existsSync(path.join(ROOT, 'build/webos/app.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'build/webos/app.css')));
  assert.ok(fs.existsSync(path.join(ROOT, 'build/webos/boot-logo.jpg')));
  assert.match(html, /id="iptv-skeleton"/,
    'a váz nem maradt benne a csomagolt HTML-ben');
});

test('a füstteszt visszaágyazza a külső fájlokat (jsdom nem tölt erőforrást)', () => {
  const smoke = read('tools/smoke-test.mjs');
  assert.match(smoke, /app\.js/);
  assert.match(smoke, /app\.css/);
  assert.match(smoke, /=> `<script>/,
    'a String.replace $& mintákat kezelni kell függvénnyel (minifikált JS)');
});

/* ─────────────── 4. FOLYAMATOS ÁTTŰNÉS (viselkedés) ─────────────── */

test('a REVEAL nem ugrik: a váz a kész felület fölött halványul el', () => {
  const { window, dom, calls } = bootPage();
  try {
    const doc = window.document;
    window.__IPTV_PREPARE_REVEAL__();
    window.__IPTV_REVEAL__('üres alkalmazás – kész felület');
    assert.equal(calls.length, 1, 'a notifyAppLoaded pontosan egyszer fut');
    assert.match(doc.documentElement.className, /iptv-revealed/);
    assert.doesNotMatch(doc.documentElement.className, /iptv-booting/);
    assert.equal(window.getComputedStyle(doc.getElementById('root')).visibility, 'visible');
    const curtain = doc.getElementById('tv-curtain');
    assert.ok(curtain, 'a váz nem ugorhat le azonnal – ez volt a nagy villanás');
    assert.match(curtain.className, /iptv-fading/);
    assert.equal(curtain.style.opacity, '0');
    window.__IPTV_FINISH_REVEAL__();
    assert.equal(doc.getElementById('tv-curtain'), null);
    assert.equal(window.__IPTV_REVEAL_DONE__, true);
    assert.equal(calls.length, 1);
  } finally {
    dom.window.close();
  }
});

test('a biztonsági időzítő transitionend nélkül is eltávolítja a vázat', async () => {
  const { window, dom } = bootPage();
  try {
    window.__IPTV_REVEAL__('teszt');
    assert.ok(window.document.getElementById('tv-curtain'));
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.equal(window.document.getElementById('tv-curtain'), null);
    assert.equal(window.__IPTV_REVEAL_DONE__, true);
  } finally {
    dom.window.close();
  }
});

/* ─────────────── 5. XTREAM IMPORT ABLAKAI ─────────────── */

test('az új szolgáltató importja NEM csendes: diagnosztika + kérdéses ablak', () => {
  assert.equal((APP.match(/handleRefreshProvider\(newProvider, true\)/g) || []).length, 2,
    'a QR/új szolgáltató importja újra manual=false – nem jelenik meg a diagnosztika');
  assert.match(APP, /setDiagnosticOpen\(manual && !silent\)/);
  assert.match(APP, /if \(manual && !silent && liveComplete/);
  assert.match(APP, /createPortal/);
  assert.match(ADDMODAL, /createPortal/);
  assert.match(ADDMODAL, /style=\{\{ zIndex: 2147482000 \}\}/,
    'a kérdéses ablaknak minden más réteg fölött kell lennie');
  assert.match(ADDMODAL, /style=\{\{ position: 'fixed', inset: 0, zIndex: 2147481000 \}\}/,
    'a betöltési diagnosztikát portálra kell tenni');
});

test('a kérdés: „Folyamat megtekintése” vagy „Csatornák megtekintése”', () => {
  for (const source of [APP, ADDMODAL]) {
    assert.match(source, /Folyamat megtekintése/);
    assert.match(source, /Csatornák megtekintése/);
  }
  // A gyors (bulk) import végén is fel kell tenni a kérdést, nem csak a
  // részleges callbacknél – különben soha nem jelenik meg az ablak.
  assert.match(ADDMODAL, /if \(!promptShownRef\.current\)[\s\S]{0,320}setLiveLoadedPromptOpen\(true\)/);
  assert.doesNotMatch(ADDMODAL, /setLiveLoadedPromptOpen\(false\);\s*onDiagnosticUpdate\?\.\(\{ providerId: provider\.id/,
    'a kérdéses ablak a végén újra eltűnik');
});

/* ─────────────── 6. KEVESEBB AKADOZÁS AZ IMPORT ALATT ─────────────── */

test('a VOD/sorozat részlisták nem rajzolják újra a teljes App-ot minden adagnál', () => {
  assert.match(APP, /const VOD_PAINT_MS = 1200;/);
  assert.match(APP, /if \(partial\.durable \|\| nowVod - lastVodPaintRef\.current >= VOD_PAINT_MS\)/);
  assert.match(APP, /if \(partial\.durable \|\| nowSeries - lastSeriesPaintRef\.current >= VOD_PAINT_MS\)/);
  assert.match(IMPORT, /const UI_YIELD_EVERY = 1200;/);
  assert.match(IMPORT, /decodedMovies\.length - lastVodPartialAt >= 5000/);
  assert.match(IMPORT, /decodedSeries\.length - lastSeriesPartialAt >= 5000/);
  assert.equal((IMPORT.match(/await yieldToUi\(\);/g) || []).length >= 2, true,
    'a részleges frissítés után nem adjuk vissza a vezérlést a festésnek');
});

/* ─────────────── 7. VERZIÓ ─────────────── */

test('a verzió mindkét helyen 2.5.137, és a változások a kiadási jegyzékben vannak', () => {
  assert.match(VERSION, /export const WEB_VERSION = '2\.5\.137';/);
  assert.equal(APPINFO.version, '2.5.137');
  assert.match(VERSION, /EGY KÉP AZ ELEJÉTŐL A VÉGÉIG/);
  assert.match(VERSION, /FIX FŐOLDALI VÁZ/);
});
