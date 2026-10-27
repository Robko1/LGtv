#!/usr/bin/env node
/*
 * 2.5.139 – AZ INDÍTÁS EGYETLEN, VALÓS BETÖLTŐKÉPERNYŐVEL.
 *
 * A felhasználó által megadott `Inditas.html` + `takarokep.jpg` alapján a régi
 * előre rajzolt főoldali váz (skeleton) HELYÉBE új betöltőképernyő lépett:
 *
 *   • a teljes háttér a takarokep.jpg (a webOS saját indítóképe is UGYANEZ),
 *   • a jobb felső sarokban a TV valós rendszerideje jár,
 *   • a százalék / csatornaszám / sebesség / hátralévő idő KIZÁRÓLAG a futó
 *     alkalmazásból származik – nincs szimulált érték és nincs időzített
 *     automatikus befejezés.
 *
 * Ez a teszt a HTML-t, a hídat és a build-láncot ellenőrzi, valamint azt,
 * hogy a kész felület megjelenésekor a réteg folyamatosan eltűnik.
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
const MAKE_SPLASH = read('tools/make-splash.py');

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

/* ─────────────── 1. NINCS BEÉGETETT KÉP, EGYETLEN HÁTTÉR ─────────────── */

test('a HTML-ben NINCS beégetett kép és NINCS két CSS háttérréteg', () => {
  assert.equal((PAGE.match(/data:image\/jpeg;base64,/g) || []).length, 0,
    'a teljes kép újra be van égetve a HTML-be (lassú válasz + késői festés)');
  assert.equal((PAGE.match(/data:image\/png;base64,/g) || []).length, 1,
    'csak a favicon lehet beégetve');
  assert.equal(PAGE.includes('__IPTV_SPLASH_DATA_URI__'), false);
  assert.equal(PAGE.includes('__IPTV_SPLASH_TINY_URI__'), false);
  assert.doesNotMatch(PAGE, /var splashLayer =/, 'a két CSS-réteg visszatért');
  assert.doesNotMatch(PAGE, /#6ccbd3|#5fe3b6|#4fd8e0/i,
    'a régi, lapos zöld/türkiz tartalék szín még mindig a HTML-ben van');
});

test('NINCS külső hálózati betűtípus-kérés az induláskor', () => {
  assert.doesNotMatch(PAGE, /fonts\.googleapis\.com|fonts\.gstatic\.com/,
    'a Google Fonts újra lelassítja a load eseményt (302 ms + DNS)');
  assert.match(PAGE, /font-family:\s*-apple-system/,
    'a rendszer betűtípusát kell használni (nincs FOUT)');
});

test('a takarókép külön, HELYI fájl, amit a <head> azonnal preloadol', () => {
  assert.match(PAGE, /<link rel="preload" as="image" href="splash-bg\.jpg" fetchpriority="high">/);
  assert.match(PAGE, /<img id="boot-bg" src="splash-bg\.jpg"[^>]*decoding="sync"/);
  assert.match(PAGE, /preload\.src = 'splash-bg\.jpg';/);
  assert.match(PAGE, /preload\.decode\(\)/);
  const source = path.join(ROOT, 'takarokep.jpg');
  assert.ok(fs.existsSync(source), 'hiányzik a takarokep.jpg (az indítókép forrása)');
});

/* ─────────────── 2. A BETÖLTŐKÉPERNYŐ FELÉPÍTÉSE ─────────────── */

test('a teljes háttér a takarókép, felül a valós órával és a négy valós adattal', () => {
  const { window, dom } = bootPage();
  try {
    const doc = window.document;
    const screen = doc.getElementById('boot-screen');
    assert.ok(screen, 'hiányzik a betöltőképernyő');
    assert.ok(doc.getElementById('tv-curtain').contains(screen),
      'a betöltőképernyő nem a takaró rétegben van');

    const bg = doc.getElementById('boot-bg');
    assert.ok(bg, 'hiányzik a teljes képernyős háttérkép');
    assert.equal(bg.getAttribute('src'), 'splash-bg.jpg');
    assert.match(PAGE, /#boot-bg\s*\{[^}]*width:\s*100%[^}]*height:\s*100%[^}]*object-fit:\s*cover/s,
      'a háttérkép nem tölti ki a teljes képernyőt');

    /*
     * 2.5.145: A JOBB FELSŐ SAROKBAN A SAJÁT LOGÓNK VAN, ÓRA NINCS.
     * A felhasználó kérésére az óra/dátum kikerült: semmi nem ketyeg a
     * betöltés alatt, nincs másodpercenkénti újrarajzolás.
     */
    const head = doc.querySelector('.boot-head');
    const meta = doc.querySelector('.boot-headmeta');
    assert.ok(head && meta, 'hiányzik a fejléc jobb oldali blokkja');
    assert.equal(doc.getElementById('boot-clock'), null, 'az óra visszakerült a fejlécbe');
    assert.equal(doc.getElementById('boot-date'), null, 'a dátum visszakerült a fejlécbe');
    assert.ok(!/setInterval\(tickClock/.test(PAGE), 'a másodpercenként futó óra visszakerült');
    assert.ok(meta.querySelector('.headmark-right svg'),
      'a jobb felső sarokban nincs logó');

    // A négy kért, valós adat.
    for (const id of ['boot-pct', 'boot-channels', 'boot-speed', 'boot-eta']) {
      assert.ok(doc.getElementById(id), `hiányzik a valós adat mezője: ${id}`);
    }
    // Alapból nincs kitalált érték: „—”, illetve 0%.
    assert.equal(doc.getElementById('boot-pct').textContent, '0');
    for (const id of ['boot-channels', 'boot-speed', 'boot-eta']) {
      assert.equal(doc.getElementById(id).textContent, '\u2014', `${id} nem „—” értékkel indul`);
    }
  } finally {
    dom.window.close();
  }
});

test('a híd csak a jelentett valós adatokat rajzolja ki', () => {
  const { window, dom } = bootPage();
  try {
    const doc = window.document;
    window.__IPTV_BOOT__.update({
      percent: 42.7,
      phase: 'Élő csatornák feldolgozása…',
      step: '5/7 · szolgáltató',
      detail: '1834/1834 csatorna',
      channels: 1834,
      bytesPerSecond: 1_250_000,
      etaSeconds: 65,
      version: '9.9.9',
    });
    assert.equal(doc.getElementById('boot-pct').textContent, '42');
    assert.equal(doc.getElementById('boot-status').textContent, 'Élő csatornák feldolgozása…');
    assert.equal(doc.getElementById('boot-step').textContent, '5/7 · szolgáltató');
    assert.equal(doc.getElementById('boot-detail').textContent, '1834/1834 csatorna');
    assert.equal(doc.getElementById('boot-channels').textContent, '1 834');
    assert.equal(doc.getElementById('boot-speed').textContent, '10.0 Mbps');
    assert.equal(doc.getElementById('boot-eta').textContent, '01:05');
    assert.match(doc.getElementById('boot-build').textContent, /9\.9\.9/);
    // A kör és a sáv a valós százalékot követi.
    assert.ok(Number(doc.getElementById('boot-fill').style.width.replace('%', '')) > 42);
    assert.ok(Number(doc.getElementById('boot-ring').getAttribute('stroke-dashoffset')) > 0);

    // Nincs adat → „—”, nem 0 és nem kitalált érték.
    window.__IPTV_BOOT__.update({ channels: null, bytesPerSecond: null, etaSeconds: null });
    assert.equal(doc.getElementById('boot-channels').textContent, '\u2014');
    assert.equal(doc.getElementById('boot-speed').textContent, '\u2014');
    assert.equal(doc.getElementById('boot-eta').textContent, '\u2014');

    // A százalék 0–100 közé szorul.
    window.__IPTV_BOOT__.update({ percent: 140 });
    assert.equal(doc.getElementById('boot-pct').textContent, '100');
    window.__IPTV_BOOT__.update({ percent: -5 });
    assert.equal(doc.getElementById('boot-pct').textContent, '0');

    assert.equal(window.__IPTV_BOOT__.state().version, '9.9.9');
  } finally {
    dom.window.close();
  }
});

test('a platform indítókép akkor kerül le, amikor a SAJÁT képernyő már festve van', async () => {
  /*
   * A webOS a splashBackground képet addig takarja, amíg az app meg nem hívja
   * a notifyAppLoaded()-et. Ha ez csak a főoldal megjelenésekor történne meg,
   * a néző a teljes betöltés alatt CSAK a fotót látná – a valós óra és a
   * betöltési adatok soha nem lennének láthatók. Ezért a saját, UGYANAZT a
   * képet mutató betöltőképernyőnk kifestése után azonnal levesszük.
   */
  const releaseAt = PAGE.indexOf('function releasePlatformSplash');
  const revealAt = PAGE.indexOf('window.__IPTV_REVEAL__ = function');
  assert.ok(releaseAt > 0, 'hiányzik a platform indítókép korai levétele');
  assert.ok(releaseAt < revealAt, 'a levétel csak a REVEAL-nél történne meg');
  assert.match(PAGE, /afterTwoFrames\(releasePlatformSplash\)/,
    'a levétel nem várja meg a kép kifestését');
  assert.match(PAGE, /window\.__IPTV_RELEASE_PLATFORM_SPLASH__/,
    'a REVEAL nem ugyanazt a (kétszer nem futó) kaput használja');

  const { window, dom, calls } = bootPage();
  try {
    await new Promise((resolve) => {
      if (window.document.readyState === 'complete') resolve(null);
      else window.addEventListener('load', () => resolve(null));
      setTimeout(() => resolve(null), 500);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(calls.length, 1,
      'a platform indítókép nem került le a saját képernyő kifestésekor');
    // A REVEAL nem hívhatja meg még egyszer.
    window.__IPTV_REVEAL__('teszt');
    assert.equal(calls.length, 1, 'a notifyAppLoaded többször futott');
  } finally {
    dom.window.close();
  }
});

/* ─────────────── 3. A KÉT INDÍTÓKÉP UGYANAZ A KÉP ─────────────── */

test('a webOS indítóképe és a HTML háttere UGYANABBÓL a takarokep.jpg-ből készül', () => {
  assert.match(MAKE_SPLASH, /SOURCE = ROOT \/ "takarokep\.jpg"/,
    'az indítókép forrása nem a takarokep.jpg');
  assert.match(MAKE_SPLASH, /def build_background\(\)/);
  assert.match(MAKE_SPLASH, /WIDTH, HEIGHT = 1920, 1080/);
  assert.match(MAKE_SPLASH, /progressive=False/,
    'a splash-bg.jpg nem baseline JPEG – kockás köztes képet festhet');
  assert.match(MAKE_SPLASH, /--out-dir/,
    'a build nem tudja a csomagba generálni a képet');
  assert.match(BUILD, /python3 "\$SCRIPT_DIR\/make-splash\.py" --out-dir "\$BUILD_DIR"/);
  assert.equal(APPINFO.splashBackground, 'splash-screen.png',
    'a webOS által használt takarókép neve megváltozott');
  // A platform indítókép a repóban is a takarokep.jpg-ből készült változat.
  const splashPath = path.join(ROOT, 'webos/splash-screen.png');
  assert.ok(fs.existsSync(splashPath) && fs.statSync(splashPath).size > 100_000,
    'a webos/splash-screen.png nem a takaroképből készült');
});

test('a body/html háttere a REVEAL-nál NEM vált – nincs fekete kocka', () => {
  assert.match(PAGE, /html\s*\{\s*background-color:\s*#7fb9bd;/);
  assert.match(PAGE, /\.iptv-curtain\s*\{[^}]*background-color:\s*#7fb9bd;/);
  // 2.5.147: a kész felület felülete (body) MÁR az első festéstől sötétkék,
  // ezért a takarókép levételekor nincs színváltás – ez adta a fekete képet.
  assert.match(PAGE, /html\.iptv-booting body\s*\{\s*background-color:\s*#080d1a !important;/);
  assert.match(PAGE, /html\.iptv-revealed body\s*\{\s*background-color:\s*#080d1a !important;/);
  assert.doesNotMatch(PAGE, /document\.body\.style\.backgroundColor/,
    'a REVEAL nem írhatja át a body hátterét (ez volt a fekete villanás)');
  assert.match(PAGE, /document\.documentElement\.style\.backgroundColor = '#7fb9bd';/);
  // A platform bgColor a takarokép mért átlagszíne – nem fekete, nem fehér.
  assert.equal(String(APPINFO.bgColor).toLowerCase(), '#84bebc');
  assert.doesNotMatch(PAGE, /background-color:\s*#6ccbd3/i,
    'a régi világos türkiz háttér visszatért');
});

test('az üres lejátszó doboza nem fekete és NEM későn dekódolódó kép', () => {
  assert.doesNotMatch(PAGE, /\[data-player-poster\][^}]*background-image:\s*url\(data:image\/jpeg/,
    'a poszter újra későn dekódoló hátteret kapott (4674 ms-es LCP)');
  assert.match(PAGE, /html\[data-iptv-boot="empty"\] \[data-player-poster\]\s*\{[^}]*linear-gradient/);
  assert.match(PAGE, /html\[data-iptv-boot="empty"\] \[data-player-poster\]::after/);
  assert.match(PLAYER, /\{channel && \(/,
    'a „Kapcsolódás…” felirat újra eltakarja az üres dobozt');
});

/* ─────────────── 4. A HTML KICSI: KÜLSŐ app.js / app.css ─────────────── */

test('a build kiemeli a hatalmas JS-t és CSS-t, az index.html kicsi marad', () => {
  assert.match(BUILD, /def externalize_styles/);
  assert.match(BUILD, /def externalize_scripts/);
  assert.match(BUILD, /<link rel="stylesheet" href="app\.css">/);
  assert.match(BUILD, /<script src="app\.js"/);
  assert.match(BUILD, /data-iptv-es5-app="IPTV-ES5-APP"/);
  assert.match(BUILD, /<link rel=\\"preload\\" as=\\"script\\" href=\\"app\.js\\">/,
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
  assert.ok(fs.existsSync(path.join(ROOT, 'build/webos/splash-bg.jpg')),
    'a betöltőképernyő háttere hiányzik a csomagból');
  assert.ok(fs.existsSync(path.join(ROOT, 'build/webos/splash-screen.png')),
    'a webOS indítóképe hiányzik a csomagból');
  assert.match(html, /id="boot-screen"|id="boot-bg"/,
    'a betöltőképernyő nem maradt benne a csomagolt HTML-ben');
});

test('a füstteszt visszaágyazza a külső fájlokat (jsdom nem tölt erőforrást)', () => {
  const smoke = read('tools/smoke-test.mjs');
  assert.match(smoke, /app\.js/);
  assert.match(smoke, /app\.css/);
  assert.match(smoke, /=> `<script>/,
    'a String.replace $& mintákat kezelni kell függvénnyel (minifikált JS)');
});

/* ─────────────── 5. FOLYAMATOS ÁTTŰNÉS (viselkedés) ─────────────── */

test('a REVEAL nem ugrik: a betöltőképernyő a kész felület fölött halványul el', () => {
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
    assert.ok(curtain, 'a réteg nem ugorhat le azonnal – ez volt a nagy villanás');
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

test('a biztonsági időzítő transitionend nélkül is eltávolítja a réteget', async () => {
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

/* ─────────────── 6. XTREAM IMPORT ABLAKAI ─────────────── */

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
  assert.match(ADDMODAL, /if \(!promptShownRef\.current\)[\s\S]{0,320}setLiveLoadedPromptOpen\(true\)/);
  assert.doesNotMatch(ADDMODAL, /setLiveLoadedPromptOpen\(false\);\s*onDiagnosticUpdate\?\.\(\{ providerId: provider\.id/,
    'a kérdéses ablak a végén újra eltűnik');
});

/* ─────────────── 7. KEVESEBB AKADOZÁS AZ IMPORT ALATT ─────────────── */

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

/* ─────────────── 8. VERZIÓ ─────────────── */

test('a verzió mindkét helyen 2.5.147, és a változások a kiadási jegyzékben vannak', () => {
  assert.match(VERSION, /export const WEB_VERSION = '2\.5\.147';/);
  assert.equal(APPINFO.version, '2.5.147');
  assert.match(VERSION, /VÁLTÁS EGYETLEN KÉPKOCKA/, 'a 2.5.147 fekete kép javítása hiányzik a jegyzékből');
  assert.match(VERSION, /NINCS HANG A FŐOLDAL ELŐTT/, 'a 2.5.147 hangzár-javítása hiányzik a jegyzékből');
  assert.match(VERSION, /VÉGIG FUT EGY MOZGÁS/, 'a 2.5.147 folyamatos animációja hiányzik a jegyzékből');
  assert.match(VERSION, /ÚJ BETÖLTŐKÉPERNYŐ A TAKAROKEP\.JPG-BŐL/);
  assert.match(VERSION, /CSAK VALÓS BETÖLÉSI ADATOK/);
  assert.match(VERSION, /AZ EPG VÉGRE MEGJELENIK A FŐOLDALON/, 'a 2.5.143 EPG-javítása hiányzik a jegyzékből');
  assert.match(VERSION, /AZ INDÍTÁS MEGINT A 2\.5\.140 MENETE SZERINT FUT/, 'a 2.5.145 indulás-javítása hiányzik a jegyzékből');
});

/* A webOS híd és a téma nem festhet fekete hátteret az indulás alá. */
test('a webOS híd/téma nem fest fekete hátteret az indulás alá', () => {
  assert.doesNotMatch(WEBOS, /body\.webos-tv, body\.lg-webos \{ background:#000/i);
  assert.doesNotMatch(THEME, /body\.webos-theme\s*\{[^}]*background:\s*#000/i);
});
