#!/usr/bin/env node
/*
 * 2.5.131 – KÉT JAVÍTÁS ELLENŐRZÉSE.
 *
 * 1. A 22:32:49-es Supabase-napló (70 sor, 2.5.130, üres IPK) „egy nagy
 *    felvillanást” mutatott: REVEAL +2770 ms, de a legnagyobb tartalom csak
 *    +3602 ms-nál festődött ki, +2879…+3479 között 600 ms-os főszál-leállással.
 *    A #root `visibility: hidden` volt, ezért a teljes 4K-s felületet csak a
 *    takarókép levétele UTÁN kellett kirajzolni. A kétlépcsős megjelenítés
 *    ezt a festést a takarókép ALATT, láthatatlanul végzi el.
 *
 * 2. A kézi hibakeresési napló „UTOLSÓ 5 ELKÜLDÖTT NAPLÓ” sorain a sorszám
 *    és az időbélyeg túl kicsi volt. Most mindkettő a saját doboza méretére
 *    nő, sortörés-biztosan, kilógás nélkül.
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
const MAIN = read('web/src/main.tsx');
const STORE = read('web/src/services/contentStore.ts');
const APP = read('web/src/App.tsx');
const MODAL = read('web/src/components/DiagnosticShareModal.tsx');

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

/* ───────────────── 1. kétlépcsős megjelenítés (felvillanás) ─────────────── */

test('a HTML biztosítja az előfestést a takarókép alatt', () => {
  assert.match(PAGE, /html\.iptv-prerender #root\s*\{\s*visibility:\s*visible;/,
    'hiányzik az előfestő CSS-szabály');
  assert.match(PAGE, /window\.__IPTV_PREPARE_REVEAL__\s*=\s*function/,
    'hiányzik az előfestő HTML-híd');
  const bootCss = PAGE.slice(PAGE.indexOf('html.iptv-booting #root'));
  const prerenderAt = bootCss.indexOf('html.iptv-prerender #root');
  const revealedAt = bootCss.indexOf('html.iptv-revealed #root');
  assert.ok(prerenderAt > 0 && revealedAt > prerenderAt,
    'az előfestő szabálynak a rejtett és a megjelenített szabály KÖZÖTT kell lennie');
  // A REVEAL maga is meghívja az előfestést: ha a main.tsx hibázik, akkor sem
  // maradhat rejtve a #root a takarókép levételekor.
  const reveal = PAGE.slice(PAGE.indexOf('window.__IPTV_REVEAL__ = function'));
  assert.match(reveal.slice(0, 900), /__IPTV_PREPARE_REVEAL__\(true\)/,
    'a REVEAL nem pótolja a kimaradt előfestést');
  // A réteg eltávolítása továbbra is külön, idempotens függvényben történik.
  assert.match(PAGE, /window\.__IPTV_FINISH_REVEAL__ = function/,
    'hiányzik a váltást lezáró függvény');
  assert.match(PAGE, /fading\.parentNode\.removeChild\(fading\)/,
    'a takarókép eltávolítása eltűnt');
  assert.match(reveal.slice(0, 6000), /__IPTV_FINISH_REVEAL__\(\)/,
    'a REVEAL nem zárja le a váltást');
  /*
   * 2.5.147: A VÁLTÁS EGYETLEN KÉPKOCKA. A 200 ms-os elhalványulás alatt a
   * videó még festetlen síkja villant be („egy hatalmas fekete kép”). Ezért a
   * takarókép a REVEAL pillanatában display:none-nal tűnik el, átmenet nélkül.
   */
  assert.match(reveal, /curtain\.style\.display = 'none'/,
    'a takarókép nem egyetlen képkockával tűnik el');
  assert.doesNotMatch(reveal, /opacity 200ms/,
    'visszatért a 200 ms-os elhalványulás (ez adta a fekete kockát)');
  assert.doesNotMatch(reveal, /document\.body\.style\.backgroundColor/,
    'a REVEAL nem váltogathatja a háttérszínt');
  // A hang zárja a REVEAL után, a kész felület első képkockájánál nyílik.
  assert.match(PAGE, /window\.__IPTV_AUDIO_GATE__ = true;/,
    'hiányzik az indulási hangzár');
  assert.match(reveal, /__IPTV_AUDIO_GATE__ = false/,
    'a REVEAL nem nyitja ki a hangzárat');
  assert.match(reveal, /iptv-audio-open/,
    'a lejátszó nem kap jelzést a hang kinyitásáról');
});

test('a főoldal a takarókép alatt már látható, de a takarókép fent marad', () => {
  if (PAGE.includes('TEMPORARY_NO_BOOT_ANIMATION')) {
    assert.match(PAGE, /TEMPORARY_NO_BOOT_ANIMATION/);
    assert.match(PAGE, /#boot-screen,\s*#tv-curtain,\s*\.iptv-curtain\s*\{[^}]*display:\s*none\s*!important/s,
      'a régi takaróképernyő nincs teljesen elrejtve');
    assert.match(PAGE, /html\.iptv-booting #root\s*\{[^}]*visibility:\s*visible\s*!important/s,
      'a főoldal nem válik láthatóvá induláskor');
    assert.match(PAGE, /root && root\.childElementCount > 0/,
      'a platform splash nem várja meg a főoldal DOM-ját');
    return;
  }
  const { window, dom, calls } = bootPage();
  try {
    const doc = window.document;
    const root = doc.getElementById('root');
    assert.equal(window.__IPTV_REVEALED__, false);
    assert.equal(window.getComputedStyle(root).visibility, 'hidden',
      'induláskor a #root még rejtve van');
    assert.ok(doc.getElementById('tv-curtain'), 'hiányzik a takarókép-réteg');
    assert.equal(calls.length, 0, 'előfestéskor NEM szabad leszedni a webOS indítóképét');

    window.__IPTV_PREPARE_REVEAL__();

    assert.equal(window.__IPTV_PREPARED__, true);
    assert.match(doc.documentElement.className, /iptv-prerender/);
    assert.match(doc.documentElement.className, /iptv-booting/,
      'az előfestés alatt a booting állapotnak meg kell maradnia');
    assert.equal(window.getComputedStyle(root).visibility, 'visible',
      'az előfestés után a #root már festhető');
    assert.ok(doc.getElementById('tv-curtain'),
      'az átlátszatlan takaróképnek az előfestés ALATT is fent kell maradnia');
    assert.equal(calls.length, 0, 'az előfestés nem hívhatja a notifyAppLoaded()-ot');
    assert.equal(window.__IPTV_REVEALED__, false);

    // Idempotens: a main.tsx és a REVEAL is hívhatja, egyszer fut le.
    const marks = window.__IPTV_STARTUP_MARKS__ || [];
    const firstCount = marks.filter((m) => /ELŐFESTÉS/.test(String(m.label))).length;
    window.__IPTV_PREPARE_REVEAL__();
    const secondCount = (window.__IPTV_STARTUP_MARKS__ || [])
      .filter((m) => /ELŐFESTÉS/.test(String(m.label))).length;
    assert.equal(secondCount, firstCount, 'az előfestés nem idempotens');
    assert.equal(firstCount, 1, 'az előfestés nem került be az indulási jelek közé');
    assert.doesNotMatch(String(marks.find((m) => /ELŐFESTÉS/.test(String(m.label)))?.label),
      /csak a REVEAL/, 'a korai előfestés helyett csak a REVEAL-kori pótlás futott');
  } finally {
    dom.window.close();
  }
});

test('a REVEAL egyetlen váltás: takarókép le, #root látható, indítókép le', () => {
  const { window, dom, calls } = bootPage();
  try {
    const doc = window.document;
    window.__IPTV_PREPARE_REVEAL__();
    window.__IPTV_REVEAL__('teszt');

    assert.equal(window.__IPTV_REVEALED__, true);
    const fading = doc.getElementById('tv-curtain');
    assert.ok(fading, 'a takaróképnek az áttűnés alatt is fent kell maradnia');
    assert.match(fading.className, /iptv-fading/);
    assert.equal(fading.style.opacity, '0');
    window.__IPTV_FINISH_REVEAL__();
    assert.equal(doc.getElementById('tv-curtain'), null);
    assert.equal(window.getComputedStyle(doc.getElementById('root')).visibility, 'visible');
    assert.doesNotMatch(doc.documentElement.className, /iptv-booting/);
    assert.match(doc.documentElement.className, /iptv-revealed/);
    assert.match(doc.documentElement.className, /iptv-prerender/,
      'a prerender osztály elvesztése visszarejtené a #root-ot');
    assert.equal(calls.length, 1, 'a notifyAppLoaded pontosan egyszer fut');

    // A 12 mp-es háló és a későbbi hívások nem változtatnak újra.
    window.__IPTV_REVEAL__('még egyszer');
    assert.equal(calls.length, 1);
  } finally {
    dom.window.close();
  }
});

test('ha az előfestés kimarad, a REVEAL akkor is láthatóvá teszi a felületet', () => {
  const { window, dom, calls } = bootPage();
  try {
    const doc = window.document;
    assert.equal(window.__IPTV_PREPARED__, false);
    window.__IPTV_REVEAL__('biztonsági háló');
    assert.equal(window.__IPTV_PREPARED__, true, 'a REVEAL nem pótolta az előfestést');
    assert.match(doc.documentElement.className, /iptv-prerender/);
    assert.equal(window.getComputedStyle(doc.getElementById('root')).visibility, 'visible');
    assert.match(doc.getElementById('tv-curtain').className, /iptv-fading/);
    window.__IPTV_FINISH_REVEAL__();
    assert.equal(doc.getElementById('tv-curtain'), null);
    assert.equal(calls.length, 1);
  } finally {
    dom.window.close();
  }
});

test('a main.tsx a DOM-kész pillanatában előfest, nem csak a REVEAL-kor', () => {
  assert.match(MAIN, /const preparePaint = \(\) =>/,
    'hiányzik az előfestést hívó segédfüggvény');
  const check = MAIN.slice(MAIN.indexOf('const checkRendered = '));
  assert.match(check.slice(0, 1600), /if \(chromeOk && !prepared\)[\s\S]{0,260}preparePaint\(\)/,
    'az előfestés nem a fejléc/mappasáv megjelenésekor indul');
  const revealFn = MAIN.slice(MAIN.indexOf('const revealWhenPainted = '));
  const revealBody = revealFn.slice(0, 1700);
  assert.match(revealBody, /preparePaint\(\);/,
    'az előfestés hiányzik a megjelenítési függvényből');
  assert.ok(revealBody.indexOf('preparePaint();') < revealBody.indexOf('if (prepaintSettled())'),
    'az előfestésnek a lefutott képkockák ellenőrzése ELŐTT kell lennie');
  assert.match(revealBody, /if \(prepaintSettled\(\)\)[\s\S]{0,90}revealNow\(reason\);/,
    'a már kifestett felületet nem jelenítjük meg azonnal (felesleges két rAF)');
  assert.match(revealBody, /afterPaint/,
    'a tartalék két képkockás megjelenítési út eltűnt');
});

test('az előfestés két képkockáját a HTML-híd méri, nem a REVEAL', () => {
  const prep = PAGE.slice(PAGE.indexOf('window.__IPTV_PREPARE_REVEAL__'));
  const body = prep.slice(0, prep.indexOf('window.__IPTV_REVEAL__'));
  assert.match(body, /__IPTV_PREPAINT_SETTLED__ = false/,
    'hiányzik az előfestés-kész jelző alaphelyzete');
  assert.match(body, /requestAnimationFrame[\s\S]{0,300}requestAnimationFrame/,
    'az előfestés nem két animációs képet vár');
  assert.match(body, /__IPTV_PREPAINT_SETTLED__ = true/,
    'a két képkocka után nem áll be a kész jelző');
});

/* ─────────────── 1/b. ZÖLD HÁTTÉR VILLANÁS (23:25:43) ──────────────────── */

test('2.5.166: a betöltőképernyő háttere színátmenet, az ikon EGYSZER beágyazva', () => {
  /*
   * 2.5.166: a felhasználó kérése szerint az indítóképernyőn nincs háttér-
   * animáció, fény- és mozgáseffekt – a súly a középen lévő százalékon és a
   * töltősávon van. A faltól falig fotó (és a 30 mp-es úszása) elment: a
   * háttér színátmenet, az IPTV-ikon pedig a két jelvényben maradt meg,
   * EGYSZER beágyazva (nincs külön kérés, nincs dekódolási késés).
   */
  assert.doesNotMatch(PAGE, /<img id="boot-bg"/,
    'a háttérkép külön <img> elemként tért vissza');
  assert.doesNotMatch(PAGE, /splash-bg/, 'a régi háttér-JPEG fájlra hivatkozás visszatért');
  assert.doesNotMatch(PAGE, /preload", as="image"/, 'a háttérképet előre kérjük (késői festés)');
  assert.equal((PAGE.match(/data:image\/jpeg;base64,/g) || []).length, 1,
    'a dizájn ikonja nem pontosan egyszer van beágyazva');
  assert.match(PAGE, /#boot-screen \.hmark,\s*#boot-screen \.mark \{\s*background-image: url\("data:image\/jpeg;base64,/,
    'a jelvények nem a dizájn ikonját használják');
  assert.doesNotMatch(PAGE, /animation: drift/,
    'a háttér ismét úszik (folyamatos festés az indulás alatt)');
  assert.doesNotMatch(PAGE, /iptv-skeleton|\.sk-player|\.sk-thumb|boot-logo/,
    'a régi előre rajzolt főoldali váz visszatért');
  assert.doesNotMatch(PAGE, /splashLayer/, 'a két CSS háttérréteg visszatért');
  assert.doesNotMatch(PAGE, /fonts\.googleapis\.com/, 'a külső betűtípus-kérés visszatért');
});

test('2.5.166: a fejlécben a saját logó van, óra és dátum nélkül', () => {
  /*
   * A felhasználó kifejezett kérése (2.5.166): a jobb felső sarokban lévő óra
   * és minden felesleges háttéranimáció eltávolítandó. A fejlécben a márkajel,
   * a szójel és a két chip maradt – a hangsúly a középen lévő százalékon van.
   */
  const header = PAGE.slice(PAGE.indexOf('<header>'));
  const inside = header.slice(0, header.indexOf('</header>'));
  assert.match(inside, /<div class="hmark"><\/div>/, 'a bal felső sarokban nincs logó');
  assert.match(inside, /<div class="wordmark">[\s\S]*?<b>TV<\/b>/, 'hiányzik a szójel');
  assert.doesNotMatch(inside, /id="boot-clock"/, 'a fejléc-óra visszatért');
  assert.doesNotMatch(inside, /id="boot-date"/, 'a dátum visszatért');
  assert.doesNotMatch(PAGE, /tickClock|startClock|__IPTV_BOOT_CLOCK_STOP__/,
    'az óra kódja visszatért (másodpercenkénti időzítő az indulás alatt)');
});

test('2.5.166: nincs mozgás az indítóképernyőn – csak a valós százalék', () => {
  /*
   * A felhasználó mérése (#32–#37 napló): az indítóképernyő folyamatos
   * animációi (úszó háttér, forgó tárcsa, pásztázás, fénylegyező, vászon-
   * részecskék, 1 mp-es óra) vették el a képkockákat az indulástól. 2.5.166:
   * a képernyő ÁLL, a hangsúly a középen lévő százalékon és az alatta lévő
   * töltősávon van, valós adatokból.
   */
  assert.doesNotMatch(PAGE, /<canvas id="fx"><\/canvas>/, 'a vászon-réteg visszatért');
  // A betöltőképernyő saját festő-hurokja: a hídon belül nem lehet képkocka-rajzolás.
  const bridgeStartAt = PAGE.indexOf('window.__IPTV_BOOT__ = {');
  const bridgeCode = PAGE.slice(bridgeStartAt, PAGE.indexOf('state: function ()', bridgeStartAt));
  assert.doesNotMatch(bridgeCode, /requestAnimationFrame/,
    'képkockánkénti rajzolás van az indítás alatt');
  assert.doesNotMatch(PAGE, /@keyframes (drift|spin|shine|bloom|pulse|swap)\{/,
    'folyamatos CSS-animáció van az indítóképernyőn');
  assert.doesNotMatch(PAGE, /animation:\s*(spin|drift|shine|bloom|pulse)\b/,
    'folyamatos CSS-animáció van az indítóképernyőn');
  assert.doesNotMatch(PAGE, /#boot-screen \.veil/, 'a záró fátyol visszatért');
  // A középre igazított elrendezés: százalék + töltősáv egymás alatt.
  assert.match(PAGE, /#boot-screen \.dialrow\{display:flex;flex-direction:column;align-items:center;justify-content:center;/,
    'a százalék nincs középre igazítva');
  assert.match(PAGE, /#boot-screen main\{[\s\S]{0,200}?align-items:center;justify-content:center;/,
    'a tartalom nincs a képernyő közepén');
  /*
   * A százalékot továbbra is KIZÁRÓLAG a valós adat írhatja: a híd
   * `update()` függvényében nincs véletlen és nincs szimulált érték.
   */
  const bridgeStart = PAGE.indexOf('window.__IPTV_BOOT__ = {');
  const bridge = PAGE.slice(bridgeStart, PAGE.indexOf('state: function ()', bridgeStart));
  assert.doesNotMatch(bridge, /Math\.random/, 'a betöltőképernyő kitalált értéket állít elő');
  /*
   * A `complete()` egyetlen időzítője a 100% két képkockányi láthatósága: a
   * felfedés visszahívása (240 ms) és a végső háló (900 ms). Egyik sem ír
   * százalékot vagy szöveget – azt kizárólag a valós `update()` teheti.
   */
  for (const call of (bridge.match(/setTimeout\([^;]*?\)/g) || [])) {
    assert.doesNotMatch(call, /percent|render\(|state\./, `időzítő írja az állapotot: ${call.slice(0, 60)}`);
  }
  assert.doesNotMatch(PAGE, /CHANNELS = 12480|PROGRAMS = 96420|simulating|function restart\(\)/,
    'a demó szimulált számlálói és újraindítása visszatértek');
});

test('a betöltési adatok KIZÁRÓLAG az alkalmazásból származnak (nincs szimuláció)', () => {
  const start = PAGE.indexOf('BETÖLTŐKÉPERNYŐ-HÍD');
  assert.ok(start > 0, 'nem található a betöltőképernyő-híd');
  const scriptStart = PAGE.lastIndexOf('<script>', start);
  const script = PAGE.slice(scriptStart, PAGE.indexOf('state: function ()', PAGE.indexOf('window.__IPTV_BOOT__ = {')));
  // A megjegyzések kiszűrése: a tiltó listát a MAGATARTÁSRA, nem kommentre nézzük.
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '');
  // A demó (a megtervezett fájl) szimulált értékei és időzített újraindítása TILOS.
  assert.doesNotMatch(code, /Math\.random/, 'a híd kitalált értéket állít elő');
  assert.doesNotMatch(PAGE, /CHANNELS = 12480|PROGRAMS = 96420|simulating|function restart\(\)/,
    'a demó szimulált számlálói visszatértek');
  /*
   * Időzítő csak a platform indítóképének levételére futhat – a betöltési
   * állapotot (percent/phase) időzítő NEM írhatja, mert az szimulált
   * befejezés lenne. 2.5.166 óta ismétlődő időzítő (óra) sincs.
   */
  const timers = code.match(/setTimeout\([^;]*?\)/g) || [];
  for (const call of timers) {
    assert.doesNotMatch(call, /percent|complete\(|state\./,
      `időzítő írja a betöltési állapotot: ${call.slice(0, 60)}`);
  }
  assert.equal((code.match(/setInterval\(/g) || []).length, 0,
    'a hídon belül ismétlődő időzítő fut (animáció)');
  // Minden mutató a valós adatot várja, alapból „—” látszik.
  assert.match(script, /update: function \(report\)/);
  assert.match(script, /typeof report\.percent === 'number'/);
  assert.match(script, /setText\('boot-channels', state\.channels === null \? DASH : groupThousands\(state\.channels\)\)/);
  assert.match(script, /setText\('boot-speed', formatSpeed\(state\.bytesPerSecond\)\)/);
  assert.match(script, /setText\('boot-eta', formatEta\(state\.etaSeconds\)\)/);
  for (const id of ['boot-channels', 'boot-speed', 'boot-eta']) {
    assert.match(PAGE, new RegExp(`id="${id}">&mdash;</b>`), `${id} nem „—” értékkel indul`);
  }
});

test('a build külön app.js/app.css fájlba emeli a nagy JS-t és CSS-t', () => {
  const build = read('tools/build-webos.sh');
  assert.match(build, /def externalize_styles/);
  assert.match(build, /def externalize_scripts/);
  assert.match(build, /<script src="app\.js"/);
  assert.match(build, /href="app\.css"/);
  assert.match(build, /cp "\$WEBOS_DIR\/splash-screen\.png" "\$BUILD_DIR\/splash-screen\.png"/,
    'a feltöltött indítókép nem kerül bemásolásra az IPK-ba');
  assert.doesNotMatch(build, /make-splash\.py" --out-dir "\$BUILD_DIR"/,
    'a régi zöld színátmenet-generátor felülírná a feltöltött képet');
  const built = path.join(ROOT, 'build/webos/index.html');
  if (!fs.existsSync(built)) return;
  const html = fs.readFileSync(built, 'utf8');
  assert.ok(html.length < 200_000, `a csomagolt index.html ${html.length} byte`);
  assert.ok(!html.includes('__IPTV_SPLASH_TINY_URI__'));
  assert.ok(html.includes('data:image/png;base64,'), 'a favicon eltűnt');
});

test('2.5.160: a betöltőképernyő CSS-e nem kerül külső fájlba, a webos.js nem a fejben fut', () => {
  /*
   * Két konkrét indulási hiba elleni őr:
   *
   * 1. A build a 40 kB-nál nagyobb <style> blokkot app.css-be teszi. A
   *    betöltőképernyő CSS-e mostantól pontosan ezért SOHA nem kerülhet oda:
   *    külső stíluslapra a böngésző a fájl betöltéséig nem fest, tehát a
   *    platform képének levétele után üres kocka jönne – pont az a hiba,
   *    amit a felhasználó látott.
   * 2. A webos.js (81 kB ES5) eddig a <head>-ben futott, ezért a
   *    betöltőképernyő csak a kiértékelése UTÁN festődhetett ki. Most a
   *    <body> végén van, a DOMContentLoaded előtt.
   */
  const build = read('tools/build-webos.sh');
  assert.match(build, /if len\(inner\) < 40000 or '#boot-screen' in inner:/,
    'a betöltőképernyő CSS-e kikerülhet külső app.css fájlba (üres kocka az induláskor)');
  assert.match(build, /script_injection/,
    'a webOS szkript injektálása nem külön (a <body> végére tehető) blokk');
  assert.match(build, /html\.replace\("<\/body>", script_injection/,
    'a webOS szkript nem a <body> végére kerül (a <head>-ben késlelteti az első festést)');
  assert.doesNotMatch(build, /html\.replace\("<\/head>", injection/,
    'a webOS szkript visszakerült a <head>-be');
  const built = path.join(ROOT, 'build/webos/index.html');
  if (!fs.existsSync(built)) return;
  const html = fs.readFileSync(built, 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes('#boot-screen'), 'a betöltőképernyő CSS-e nincs beégetve a <head>-be');
  assert.ok(!head.includes('__webosTvFocusFix'),
    'a webos.js a <head>-ben fut – az első festés rá vár');
});

test('üres induláskor a tároló-jelentés csak egyszer fut le', () => {
  assert.match(STORE, /export function lastStoredContentReport\(\): StorageReport \| null \{/,
    'hiányzik a megosztott tároló-jelentés');
  assert.match(STORE, /lastStorageReport = report;/,
    'a tároló-felmérés nem menti el a jelentését');
  assert.match(APP, /const report = plan\?\.report \|\| lastStoredContentReport\(\) \|\| await describeStoredContent\(\);/,
    'az App boot-effektje újra végigjárja az IndexedDB-t');
  assert.match(STORE, /const report = await describeStoredContent\(\);/,
    'a felmérés már nem készít FRISS jelentést (elavulhat import után)');
  // A többi hívó továbbra is FRISS jelentést kapjon.
  assert.match(STORE, /export async function describeStoredContent\(\): Promise<StorageReport> \{/,
    'az eredeti, friss jelentés eltűnt');
});

/* ─────────── 3. UTOLSÓ 5 ELKÜLDÖTT NAPLÓ – nagy, nem kilógó feliratok ────── */

test('a napló sorszáma és időbélyege a saját doboza méretére nő', () => {
  const section = MODAL.slice(MODAL.indexOf('UTOLSÓ 5 ELKÜLDÖTT NAPLÓ'));
  const numberAt = section.indexOf('data-diagnostic-history-number');
  const dateAt = section.indexOf('data-diagnostic-history-date');
  assert.ok(numberAt > 0 && dateAt > 0, 'hiányoznak a tesztelhető felirat-elemek');

  const numberTag = section.slice(numberAt, section.indexOf('>', numberAt));
  const dateTag = section.slice(dateAt, section.indexOf('>', dateAt));

  // A korábbi text-sm (14 px) helyett 24/28 px, illetve 18/20 px.
  assert.match(numberTag, /text-3xl[\s\S]*sm:text-\[34px\]/, 'a napló sorszáma nem nőtt meg');
  assert.doesNotMatch(numberTag, /text-sm/, 'a sorszám maradt a régi, kis méreten');
  assert.match(dateTag, /text-xl[\s\S]*sm:text-2xl/, 'az időbélyeg nem nőtt meg');
  assert.doesNotMatch(dateTag, /text-sm/, 'az időbélyeg maradt a régi, kis méreten');

  // leading-none: a betű pontosan a saját sorában ül, nem lóg ki a dobozból.
  assert.match(numberTag, /leading-none/, 'a sorszám sormagassága nem illeszkedik a dobozhoz');
  assert.match(dateTag, /leading-none/, 'az időbélyeg sormagassága nem illeszkedik a dobozhoz');

  const rowTag = section.slice(section.indexOf('data-diagnostic-history-row'),
    section.indexOf('>', section.indexOf('data-diagnostic-history-row')));
  assert.match(rowTag, /min-h-\[72px\]/, 'hiányzik a saját, magasabb doboz');
  assert.match(rowTag, /flex-wrap/, 'a doboz nem tud sort törni');
  assert.match(rowTag, /overflow-hidden/, 'a doboz nem vágja a túlcsorduló szöveget');

  // A hosszú „ÉÉÉÉ-HH-NN ÓÓ:PP:MM” biztosan nem lóg ki.
  const dateBody = section.slice(dateAt, dateAt + 900);
  assert.match(dateBody, /min-w-0/, 'hiányzik a min-w-0 (a flex elem túlnőne)');
  assert.match(dateBody, /break-words/, 'az időbélyeg nem tördelhető');
  assert.match(dateBody, /shrink-0/, 'az óra ikon összezsugorodna');
  assert.match(dateTag, /max-w-full/, 'a dátum doboza túlnőhet a soron');
});

test('az utolsó 5 napló sora megmarad (kulcs, sorszám, dátum, kijelölés)', () => {
  assert.match(MODAL, /history\.slice\(0, 5\)\.map\(/, 'az 5 elemkorlát eltűnt');
  assert.match(MODAL, /Napló #\{record\.logNumber\}/, 'a sorszám felirata eltűnt');
  assert.match(MODAL, /formatRecordDate\(record\.createdAt\)/, 'az időbélyeg eltűnt');
  assert.match(MODAL, /sentRecord\?\.logNumber === record\.logNumber/,
    'a frissen elküldött napló kijelölése eltűnt');
  assert.match(MODAL, /UTOLSÓ 5 ELKÜLDÖTT NAPLÓ/, 'a szakasz címe eltűnt');
});
