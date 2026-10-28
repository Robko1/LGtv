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

/* ─────────────── 1. A HÁTTÉR: A DIZÁJN SAJÁT IKONJA, EGYSZER ─────────────── */

test('a HTML-ben a dizájn ikonja PONTOSAN EGYSZER van beágyazva', () => {
  /*
   * 2.5.162: a takarókép az indítási animáció, éspedig a felhasználó
   * megtervezett fájlja – faltól falig a saját IPTV-ikon. A kép a HTML-ben
   * van (nincs külön hálózati kérés), de csak EGYSZER: a háttér és a két
   * jelvény ugyanazt az adat-URI-t használja, nem három másolatot.
   */
  assert.equal((PAGE.match(/data:image\/jpeg;base64,/g) || []).length, 1,
    'a dizájn ikonja nem pontosan egyszer van beágyazva');
  assert.equal((PAGE.match(/data:image\/png;base64,/g) || []).length, 1,
    'csak a favicon lehet beégetett PNG');
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

test('2.5.166: a háttér színátmenet – nincs képkérés és nincs fotó-felskálázás', () => {
  /*
   * 2.5.162-ig a háttér egy 251 px-es, beágyazott ikon volt, faltól falig
   * felnagyítva. A TV ezt minden képkockán újra raszterezte (filter +
   * scale), és ez volt az indulás egyik legnagyobb tétele. 2.5.166 óta a
   * háttér UGYANAZ a színátmenet, amit a platform indítókép is rajzol;
   * az ikon csak a fejléc- és a sarokjelvényben maradt meg.
   * Továbbra is tilos: külön <img>, preload, külső fájl-hivatkozás.
   */
  assert.doesNotMatch(PAGE, /preload", as="image"/, 'a háttérkép preload visszatért');
  assert.doesNotMatch(PAGE, /<img id="boot-bg"/, 'a háttérkép <img> elem visszatért');
  assert.doesNotMatch(PAGE, /splash-bg/, 'a háttér JPEG-fájlra hivatkozás visszatért');
  assert.match(PAGE, /#boot-screen \.hmark,\s*#boot-screen \.mark \{\s*background-image: url\("data:image\/jpeg;base64,/,
    'a jelvények nem a beágyazott ikont használják');
  assert.doesNotMatch(PAGE, /#boot-screen \.bootbg[\s\S]{0,80}filter: brightness/,
    'a háttéren ismét képfilter fut (ez kérte a TV-től a folyamatos raszterezést)');
  assert.ok(!fs.existsSync(path.join(ROOT, 'web/public/splash-bg.jpg')),
    'a felesleges splash-bg.jpg még a repóban van');
  assert.ok(!fs.existsSync(path.join(ROOT, 'takarokep.jpg')),
    'a már nem használt takarokep.jpg még a repóban van');
});

/* ─────────────── 2. A BETÖLTŐKÉPERNYŐ FELÉPÍTÉSE ─────────────── */

test('2.5.166: a betöltőképernyő statikus szerkezete, a valós adatokkal', () => {
  const { window, dom } = bootPage();
  try {
    const doc = window.document;
    const screen = doc.getElementById('boot-screen');
    assert.ok(screen, 'hiányzik a betöltőképernyő');
    assert.ok(doc.getElementById('tv-curtain').contains(screen),
      'a betöltőképernyő nem a takaró rétegben van');

    /*
     * 2.5.166: CSAK a statikus rétegek maradtak – háttér, fátyol, vignetta,
     * rács, műszerfal, jelvény. A mozgó szemcse, pásztázás, fénylegyező,
     * vászon-részecske, virágzás és záró fátyol elment: ezek folyamatos
     * festést kértek a TV-től az indulás közben.
     */
    for (const selector of ['.bootbg', '.scrim', '.vig', '.grid', '#boot-ui', '#boot-mark']) {
      assert.ok(doc.querySelector(selector), `hiányzik a statikus réteg: ${selector}`);
    }
    for (const selector of ['.grain', '.scan', '.sweep', '#fx', '#boot-bloom-el', '#boot-veil']) {
      assert.equal(doc.querySelector(selector), null,
        `a mozgó/fény-réteg visszatért: ${selector}`);
    }
    assert.equal(doc.getElementById('boot-bg'), null,
      'a háttér nem külön <img> elem');

    // A fejléc: márka + szójel + chipek – óra és dátum NÉLKÜL (2.5.166).
    const meta = doc.querySelector('.headmeta');
    assert.ok(doc.querySelector('.headrow') && meta, 'hiányzik a fejléc jobb oldali blokkja');
    assert.ok(doc.querySelector('.brand .hmark'), 'a bal felső sarokban nincs logó');
    assert.ok(doc.querySelector('.wordmark b'), 'hiányzik a szójel');
    assert.equal(doc.getElementById('boot-clock'), null,
      'a fejléc-óra visszatért (a felhasználó kifejezetten kérte az eltávolítását)');
    assert.equal(doc.getElementById('boot-date'), null, 'a dátum visszatért a fejlécbe');
    assert.doesNotMatch(PAGE, /setInterval\(/, 'ismét futó időzítő van az indítóképernyőn');

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
  assert.match(PAGE, /first-contentful-paint/,
    'a levétel nem az első tartalmas képkockához van kötve (fotó → üres kocka)');
  /*
   * 2.5.162: a levétel a TÉNYLEGES első festéshez van kötve.
   *
   * A 18. napló mérése szerint a platform kép +327 ms-nál lement, de az első
   * festés csak 815 ms-nál (FCP 1081 ms) történt meg: a requestAnimationFrame
   * visszahívásai a festés ELŐTT is lefutnak, ezért a két rAF nem garancia.
   * A levétel után ~490 ms-ig az ablak sötét háttere látszott – ez volt a
   * „fekete–zöldes háttér váltakozás”. Mostantól a `paint` bejegyzés
   * (`first-paint` / `first-contentful-paint`) indítja a levételt, a háló
   * pedig 1500 ms.
   */
  assert.doesNotMatch(PAGE, /function armReleaseFromFrame\(\)/,
    'a platform kép levétele újra képkocka-visszahívásra vár (a festés előtt is lefuthat)');
  assert.match(PAGE, /name === 'first-paint' \|\| name === 'first-contentful-paint'/,
    'a levétel nem a tényleges első festéshez van kötve');
  assert.match(PAGE, /paintObserver\.observe\(\{ type: 'paint', buffered: true \}\)/,
    'a festés-figyelő nem indul el (a korai festés bejegyzése elveszne)');
  assert.match(PAGE, /window\.setTimeout\(releasePlatformSplash, 1500\)/,
    'nincs biztonsági háló a platform kép levételére');
  assert.doesNotMatch(PAGE, /setTimeout\(releasePlatformSplash, (350|900)\)/,
    'a régi, festés előtt elsülő időzítő visszatért – üres kocka a platform kép után');
  assert.match(PAGE, /window\.__IPTV_RELEASE_PLATFORM_SPLASH__/,
    'a REVEAL nem ugyanazt a (kétszer nem futó) kaput használja');

  const { window, dom, calls } = bootPage();
  try {
    await new Promise((resolve) => {
      if (window.document.readyState === 'complete') resolve(null);
      else window.addEventListener('load', () => resolve(null));
      setTimeout(() => resolve(null), 500);
    });
    /*
     * 2.5.162: a levétel a tényleges első festéshez van kötve; ha a motor nem
     * ad festés-jelzést (a jsdom nem ad), 1500 ms-os biztonsági háló fut.
     */
    await new Promise((resolve) => setTimeout(resolve, 1700));
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

test('2.5.166: a platform indítókép UGYANAZ a kompozíció, mint a betöltőképernyő háttere', () => {
  /*
   * A felhasználó észrevétele (2.5.162-ig): „indításkor nincs takarókép,
   * fekete–zöldes háttér váltakozik”. Akkor a platform kép egy 1920×1080-ra
   * felnagyított FOTÓ lett (600 kB), amit a TV minden képkockán újraraszterezett.
   *
   * 2.5.166: a fotó helyett MINDKÉT oldal UGYANAZT a színátmenetes
   * kompozíciót rajzolja (sötét teál alap + középső fényfolt + fátyol +
   * 84 pixeles rács + vignetta). A platform kép és a `.bootbg` ugyanazokból
   * a színmegállókból épül, ezért a váltás továbbra sem látszik – a fájl
   * viszont néhány tíz kB, és nincs fotó-felskálázás a TV-n.
   */
  assert.equal(MAKE_SPLASH.includes('takarokep'), false,
    'az indítókép ismét a törölt borítóképből készül');
  assert.match(MAKE_SPLASH, /def build_splash\(\)/);
  assert.match(MAKE_SPLASH, /WIDTH, HEIGHT = 1920, 1080/);
  assert.match(MAKE_SPLASH, /--out-dir/,
    'a build nem tudja a csomagba generálni a képet');
  assert.match(BUILD, /python3 "\$SCRIPT_DIR\/make-splash\.py" --out-dir "\$BUILD_DIR"/);
  assert.equal(APPINFO.splashBackground, 'splash-screen.png',
    'a webOS által használt indítókép neve megváltozott');

  // A két oldal UGYANAZOKKAL a színekkel dolgozik (a CSS és a generátor együtt).
  for (const color of ['#073B3E', '#04161C', '#08111F']) {
    assert.ok(PAGE.toUpperCase().includes(color), `a .bootbg színátmenetéből hiányzik: ${color}`);
  }
  assert.match(MAKE_SPLASH, /LINEAR_TOP = \(7, 59, 62\)/,
    'a platform kép felső színe eltér a .bootbg-tól');
  assert.match(MAKE_SPLASH, /GLOW_CORE = \(20, 150, 138\)/,
    'a platform kép fényfoltja eltér a .bootbg-tól');
  assert.match(MAKE_SPLASH, /GRID_STEP = 84/,
    'a platform kép rácsa eltér a .bootbg 84 pixeles rácsvonalaitól');
  // A háttér már NEM fotó: nincs beágyazott kép a .bootbg-n.
  const bootbg = PAGE.slice(PAGE.indexOf('#boot-screen .bootbg {'), PAGE.indexOf('#boot-screen .scrim{'));
  assert.doesNotMatch(bootbg, /background-image:\s*url\(/,
    'a háttér ismét beágyazott fotó (ez volt a lassú indulás fő oka)');

  /*
   * A két kép fényereje CSAK akkor egyezik, ha a CSS fényfoltjának
   * átlátszósága pontosan a generátor első színmegállója. (2.5.167: ez az
   * érték csúszott el, ezért a platform kép sötétebbnek látszott a saját
   * képernyőnél – a váltás a TV-n színugrásként látszott.)
   */
  const cssGlow = (PAGE.match(/rgba\(20,150,138,\.(\d+)\)/) || [])[1];
  const pyGlow = (MAKE_SPLASH.match(/glow_table = \[\(0\.0, 0\.(\d+)\)/) || [])[1];
  assert.ok(cssGlow, 'a .bootbg fényfoltjának színe megváltozott');
  assert.equal(cssGlow, pyGlow,
    `a CSS fényfolt (0.${cssGlow}) és a generátor (0.${pyGlow}) eltér – a két indítókép fényereje nem egyezik`);

  /*
   * A felhasználó által feltöltött splash-screen.png marad az indítókép.
   * A workflow veszteséges palettázással tömöríti, majd RGB PNG-ként menti
   * vissza, ezért a teszt a buildben optimalizált fájlt ellenőrzi. A 700 KiB-os
   * korlát a workflow-val egyezik; nem követel meg nem garantálható 160 kB-ot.
   */
  const splashPath = path.join(ROOT, 'webos/splash-screen.png');
  assert.ok(fs.existsSync(splashPath), 'hiányzik a webos/splash-screen.png');
  const splashSize = fs.statSync(splashPath).size;
  assert.ok(splashSize <= 700 * 1024,
    `a webos/splash-screen.png ${splashSize} byte – meghaladja a workflow 700 KiB-os korlátját`);
  assert.ok(splashSize > 10_000,
    `a webos/splash-screen.png ${splashSize} byte – a kép nem a betöltőképernyő kompozíciója`);
  const header = fs.readFileSync(splashPath).subarray(0, 26);
  assert.equal(header.toString('ascii', 12, 16), 'IHDR');
  assert.equal(header.readUInt32BE(16), 1920, 'az indítókép nem 1920 széles');
  assert.equal(header.readUInt32BE(20), 1080, 'az indítókép nem 1080 magas');
  assert.equal(header[25], 2, 'az indítókép nem 24 bites RGB (palettás lenne)');
});

test('a body/html háttere a REVEAL-nál NEM vált – nincs fekete kocka', () => {
  /*
   * 2.5.151: MINDEN alapszín sötét. A 35–39. napló használói észrevétele:
   * a takarókép után – és csatornaváltásnál a főoldalon – VILÁGOS TÜRKIZ
   * (teal) kocka villant be. Forrása a html/takarókép #7fb9bd alapszíne és a
   * webOS ablak háttere (appinfo bgColor #84bebc) volt.
   */
  assert.match(PAGE, /html\s*\{\s*background-color:\s*#080d1a;/);
  assert.match(PAGE, /\.iptv-curtain\s*\{[^}]*background-color:\s*#080d1a;/);
  assert.doesNotMatch(PAGE, /background-color:\s*#7fb9bd/i,
    'a világos türkiz alapszín visszatért (ez villan be a takarókép után)');
  assert.doesNotMatch(PAGE, /#84bebc/i, 'a világos bgColor visszatért');
  /*
   * 2.5.162: a webOS ablak háttere a BETÖLTŐKÉPERNYŐ alapszíne (#04141a),
   * nem a kész felület sötétkékje. A felhasználó jelezte, hogy az indulásnál
   * „fekete–zöldes háttér váltakozik”: a sötétkék ablak → türkiz platform kép
   * → türkiz betöltőképernyő volt a váltakozás. Ezzel a színnel a legelső
   * kockától ugyanaz a tónus látszik, a kész felületet pedig a body takarja.
   */
  assert.equal(String(APPINFO.bgColor).toLowerCase(), '#04141a',
    'a webOS ablak háttere nem a betöltőképernyő alapszíne – ez villan be legelőször');
  // 2.5.147: a kész felület felülete (body) MÁR az első festéstől sötétkék,
  // ezért a takarókép levételekor nincs színváltás – ez adta a fekete képet.
  assert.match(PAGE, /html\.iptv-booting body\s*\{\s*background-color:\s*#080d1a !important;/);
  assert.match(PAGE, /html\.iptv-revealed body\s*\{\s*background-color:\s*#080d1a !important;/);
  assert.doesNotMatch(PAGE, /document\.body\.style\.backgroundColor/,
    'a REVEAL nem írhatja át a body hátterét (ez volt a fekete villanás)');
  assert.match(PAGE, /document\.documentElement\.style\.backgroundColor = '#080d1a';/);
  assert.doesNotMatch(PAGE, /background-color:\s*#6ccbd3/i,
    'a régi világos türkiz háttér visszatért');
});

test('a lejátszó doboza FEKETE és NEM későn dekódolódó kép', () => {
  assert.doesNotMatch(PAGE, /\[data-player-poster\][^}]*background-image:\s*url\(data:image\/jpeg/,
    'a poszter újra későn dekódoló hátteret kapott (4674 ms-es LCP)');
  /*
   * 2.5.165 – a felhasználó kérése: a csatornaváltás közötti háttér (főoldal
   * és teljes képernyő) FEKETE, nem világoskék. Korábban itt türkiz
   * színátmenet volt, ezért villant be világoskék a váltás alatt.
   */
  assert.match(PAGE, /html\[data-iptv-boot="empty"\] \[data-player-poster\]\s*\{[^}]*background:\s*#000/);
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
  assert.equal((html.match(/data:image\/jpeg;base64,/g) || []).length, 1,
    'a betöltőképernyő ikonja nem pontosan egyszer van a csomagban');
  assert.match(html, /<script src="app\.js"/);
  assert.match(html, /href="app\.css"/);
  assert.doesNotMatch(html, /<script[^>]*type="module"/);
  assert.ok(fs.existsSync(path.join(ROOT, 'build/webos/app.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'build/webos/app.css')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'build/webos/splash-bg.jpg')),
    'felesleges háttér-JPEG került a csomagba (a háttér CSS színátmenet)');
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

/* ─────────────── 7/b. A TELJES LISTA A FELFEDÉS UTÁN ─────────────── */

test('a 20 190 csatornás lista a felfedés UTÁN töltődik be, nem alatta', () => {
  /*
   * 2.5.149: a 28–30. napló szerint a lista dekódolása 3 mp, az alkalmazás
   * 1,5 mp-re fagyott tőle – a takarókép alatt, ezért 7–10 mp lett az
   * indulás. Mostantól a felfedés a LÁTHATÓ felületre vár, a lista pedig a
   * kész felület fölött érkezik.
   */
  const app = read('web/src/App.tsx');
  assert.match(app, /addEventListener\('iptv-app-ready', startAfterReveal/,
    'a háttér-visszatöltés nem a felfedés után indul');
  assert.match(app, /const startAfterReveal = \(\) => \{ timers\.restoreTimer = window\.setTimeout\(startRestore, 1200\); \}/,
    'a visszatöltés a felfedés pillanatára esik (nincs üresjárat)');
  assert.match(app, /timers\.restoreTimer = window\.setTimeout\(startRestore, 15000\)/,
    'nincs biztonsági indítás, ha a felfedés elmarad');
  assert.doesNotMatch(app, /setTimeout\(startRestore, 4000\)/,
    'a 4 mp-es tartalék megint a felfedés ELŐTT indítja a dekódolást (ez késlelteti a váltást)');
  assert.match(app, /\.finally\(\(\) => \{\s*markLiveReady\(\);\s*scheduleGuide\(\);/,
    'a műsorújság nem a lista visszatöltése UTÁN indul');
  const main = read('web/src/main.tsx');
  assert.doesNotMatch(main, /const liveOk = liveReady\(\)/,
    'a felfedés ismét a teljes listára vár');
  assert.match(main, /if \(logosOk && videoOk\) \{/,
    'a felfedés feltétele nem a látható felület');
  /*
   * 2.5.160: MEGFORDULT A SORREND – ÉS EZ A HELYES.
   *
   * A felhasználói elvárás: az indítási animáció a 100%-ig folyamatosan
   * látszódjon, és csak a 100%-nál jelenjen meg a főoldal. Ezért a
   * `bootScreenComplete()` (ami a HTML-ben 240 ms alatt felfuttatja a sávot
   * 100%-ra) fut ELŐBB, a felfedés (`reveal`) pedig a HTML visszahívására
   * történik. A régi „a takarókép lezárása drága, ezért előbb fedjünk fel”
   * indoklás okafogyott: a befejezés csak százalékot és szöveget ír.
   */
  const revealFn = main.slice(main.indexOf('const revealNow = (reason: string) => {'));
  const body = revealFn.slice(0, 6000);
  const callbackAt = body.indexOf('__IPTV_BOOT_DONE_CB__ = afterBootAnimation');
  const completeAt = body.indexOf('bootScreenComplete();');
  assert.ok(callbackAt > 0 && completeAt > callbackAt,
    'a felfedés nincs a betöltőképernyő befejezésének visszahívására kötve');
  assert.match(body, /const afterBootAnimation = \(\) => \{[\s\S]{0,900}?reveal\(reason\);/,
    'a felfedés nem a befejezés (100%) után történik');
  const before = main.slice(main.indexOf('const revealNow = (reason: string) => {'), main.indexOf('const afterBootAnimation'));
  assert.doesNotMatch(before, /^\s*reveal\(reason\);/m,
    'a betöltőképernyő 100%-a előtt is van felfedés (nem látszana a 100%)');
  assert.match(body, /\.__IPTV_BOOT_DONE_CB__ = afterBootAnimation/,
    'a felfedés nincs a betöltőképernyő befejezésének visszahívásához kötve');
  assert.match(body, /window\.setTimeout\(afterBootAnimation, 400\)/,
    'nincs biztonsági háló, ha a visszahívás elmarad');
  assert.match(body, /if \(bootRevealDone\) return;/,
    'a felfedés kétszer futhat le (a visszahívás és a 400 ms-os háló is hívja)');
  // 2.5.151: a sáv a váltás előtt 97 és 99%-ot is jelez – nem áll meg 94%-on.
  const boot = read('web/src/services/bootScreen.ts');
  assert.match(boot, /frames: \{ percent: 97/, 'a 97%-os képkocka-szakasz hiányzik');
  assert.match(boot, /ready: \{ percent: 99/, 'a 99%-os váltás-szakasz hiányzik');
});

test('a visszatöltött lista nem írja vissza magát a tartós tárba', () => {
  /*
   * A 30. napló: az IDB-visszatöltés után 1,4 mp-cel a stream megakadt, majd
   * a puffervideó-watchdog újracsatlakoztatott. A mentést csak a felhasználói
   * változás (`dirtyRef`) indíthatja – ha a visszatöltés „piszkosnak” jelölné
   * a listát, a 20 190 csatorna (≈5 MB) azonnal visszaíródna a fő szálon.
   */
  const app = read('web/src/App.tsx');
  const restoreStart = app.indexOf('const runRestore = useCallback(');
  const restoreEnd = app.indexOf('const ensureVodLoaded', restoreStart);
  assert.ok(restoreStart > 0 && restoreEnd > restoreStart, 'a runRestore nem található');
  const body = app.slice(restoreStart, restoreEnd);
  assert.doesNotMatch(body, /dirtyRef\.current = true/,
    'a visszatöltés piszkosnak jelöli a listát – fölösleges 5 MB-os újraírás indul');
  const saveEffect = app.slice(app.indexOf('if (!dirtyRef.current || !activeProvider) return;'));
  assert.match(saveEffect.slice(0, 2000), /if \(changedChannels\) saveLiveContentSafely\(content\);/,
    'a mentés a csatornalista változásához van kötve');
});

/* ─────────────── 8. VERZIÓ ─────────────── */

test('a futtatott verzió és az IPK verziója megegyezik, a jegyzék naprakész', () => {
  /*
   * 2.5.149: a verziószám NEM lehet beégetve a tesztbe. A kiadás után a
   * „bump webOS IPK version” munkafolyamat továbblépteti a verziót, és a
   * beégetett szám miatt a teszt a main-en minden kiadás után elhasalt.
   * Helyette azt ellenőrizzük, ami valóban számít: a két hely egyezik,
   * és a jegyzék legfelső bejegyzése a futó verzió.
   */
  const running = VERSION.match(/export const WEB_VERSION = '([^']+)';/);
  assert.ok(running, 'nincs WEB_VERSION');
  assert.equal(APPINFO.version, running[1],
    'a webOS appinfo.json verziója nem egyezik a futtatott verzióval');
  assert.match(running[1], /^2\.5\.\d+$/, 'a verzió alakja megváltozott');
  const top = VERSION.slice(VERSION.indexOf('WEB_VERSION_HISTORY'));
  const firstEntry = top.match(/version: '([^']+)'/);
  assert.ok(firstEntry, 'üres a kiadási jegyzék');
  assert.equal(firstEntry[1], running[1],
    'a jegyzék legfelső bejegyzése nem a futó verzió');
  assert.match(VERSION, /VÁLTÁS EGYETLEN KÉPKOCKA/, 'a 2.5.147 fekete kép javítása hiányzik a jegyzékből');
  assert.match(VERSION, /NINCS HANG A FŐOLDAL ELŐTT/, 'a 2.5.147 hangzár-javítása hiányzik a jegyzékből');
  assert.match(VERSION, /VÉGIG FUT EGY MOZGÁS/, 'a 2.5.147 folyamatos animációja hiányzik a jegyzékből');
  assert.match(VERSION, /NEM VÁR TÖBBÉ A 20 190 CSATORNÁS LISTÁRA/, 'a 2.5.149 indulás-javítása hiányzik a jegyzékből');
  assert.match(VERSION, /FELFEDÉS NEM VÁR A BETÖLTŐKÉPERNYŐ LEZÁRÁSÁRA/, 'a 2.5.149 felfedés-javítása hiányzik a jegyzékből');
  assert.match(VERSION, /ÚJ BETÖLTŐKÉPERNYŐ A TAKAROKEP\.JPG-BŐL/);
  assert.match(VERSION, /CSAK VALÓS BETÖLÉSI ADATOK/);
  assert.match(VERSION, /AZ EPG VÉGRE MEGJELENIK A FŐOLDALON/, 'a 2.5.143 EPG-javítása hiányzik a jegyzékből');
});

/* A webOS híd és a téma nem festhet fekete hátteret az indulás alá. */
test('a webOS híd/téma nem fest fekete hátteret az indulás alá', () => {
  assert.doesNotMatch(WEBOS, /body\.webos-tv, body\.lg-webos \{ background:#000/i);
  assert.doesNotMatch(THEME, /body\.webos-theme\s*\{[^}]*background:\s*#000/i);
});
