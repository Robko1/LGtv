#!/usr/bin/env node
/*
 * A CSOMAGOLT index.html kiadás előtti ellenőrzése.
 *
 * Futtatás:  node --test tools/test-package-html.mjs     (vagy: npm test)
 *
 * Miért van ez a teszt?
 *
 * A GitHub Actions „10. IPK ellenőrzése” lépése azt vizsgálja, hogy a csomagba
 * került index.html valóban production build-e, azaz nem maradt-e benne a
 * fejlesztői belépő (`<script type="module" src="/src/main.tsx">`). A Chrome 61
 * alatti webOS TV-motorokon egy module script miatt az app el sem indulna.
 *
 * Ez az ellenőrzés sokáig sima szövegrészlet-keresés volt:
 *
 *     if '/src/main.tsx' in html:  -> HIBA
 *
 * A `webos/webos.js` viszont BEÉGETVE kerül a csomagolt index.html-be, ezért
 * egyetlen forráskomment, amely csak megemlítette a fájlnevet, megbuktatta a
 * teljes kiadást (ez állította le a 2.5.108-as IPK-buildet). A komment
 * javítása önmagában nem elég: ugyanígy elhasalhatna bármi, ami később bekerül
 * a webos.js-be vagy a beégetett HTML-be. Ezért:
 *
 *   1. a CI-ellenőrzés a VALÓDI script-hivatkozást keresi (regex), és
 *   2. ez a teszt már az `npm test` alatt (tehát a build ELŐTT) elhasal, ha a
 *      beégetett forrásokban fejlesztői modul-hivatkozás jelenik meg, és
 *   3. kipróbálja magát az ellenőrzést is: egy igazi dev-belépőre bukik, egy
 *      puszta említésre nem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Ugyanaz a minta, amit a CI Python-kódja használ (a workflow-beli `["\']`
 * és az itteni `["']` ugyanarra a dupla idézőjelre illeszkedik). Ha a
 * workflow-ban változik, ezt is át kell írni – a lenti teszt éppen ezért
 * ellenőrzi a workflow szövegét is.
 */
const DEV_MAIN_ENTRY = /<script[^>]*\ssrc=["'][^"']*\/src\/main\.tsx/;
const DEV_SRC_ENTRY = /<script[^>]*\ssrc=["']\/src\//;

const hasDevEntry = (html) => DEV_MAIN_ENTRY.test(html) || DEV_SRC_ENTRY.test(html);

test('a beégetett webos.js nem tartalmaz fejlesztői modul-hivatkozást', () => {
  const webos = read('webos/webos.js');
  assert.ok(
    !/<script[^>]*\ssrc=["'][^"']*\/src\//.test(webos),
    'a webos.js beégetve kerül a csomagolt index.html-be; fejlesztői /src/ hivatkozás nem lehet benne'
  );
  /*
   * Ennél szigorúbban: a fájlban SEMMILYEN `/src/...` útvonal-említés nem
   * szerepelhet, mert a korábbi, szövegrészlet-alapú CI-ellenőrzés éppen ezen
   * akadt fenn. A megjegyzések a fájlnevet írják le útvonal nélkül.
   */
  const offending = webos
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes('/src/'));
  assert.deepEqual(
    offending.map(({ index, line }) => `${index + 1}: ${line.trim()}`),
    [],
    'a webos.js /src/ útvonalat említ – ez a csomagolt HTML-be kerülve megbuktatja a kiadást'
  );
});

test('a csomagolt HTML-ben nincs fejlesztői belépő (ha a build elkészült)', () => {
  const built = path.join(ROOT, 'build/webos/index.html');
  if (!fs.existsSync(built)) return; // a build a CI-ben a teszt után fut
  const html = fs.readFileSync(built, 'utf8');
  assert.ok(html.includes('id="root"'), 'hiányzik az id="root" a csomagolt HTML-ből');
  assert.ok(!hasDevEntry(html), 'a csomagolt index.html fejlesztői /src/ belépőt tartalmaz');
});

test('az ellenőrzés felismeri a valódi fejlesztői belépőt', () => {
  const devBuild =
    '<!doctype html><html><body><div id="root"></div>' +
    '<script type="module" src="/src/main.tsx"></script></body></html>';
  assert.ok(hasDevEntry(devBuild), 'a dev-belépőt fel kellett volna ismerni');

  const devBuildRelative =
    '<div id="root"></div><script type="module" src=\'/src/entry.js\'></script>';
  assert.ok(hasDevEntry(devBuildRelative), 'a /src/ alatti dev belépőt is fel kellett volna ismerni');
});

test('az ellenőrzés NEM bukik el egy puszta említésen', () => {
  const production = [
    '<!doctype html><html><body><div id="root"></div>',
    '<script>/* a főoldal saját döntése (a React belépő, main.tsx) 9 mp */</script>',
    '<script>// régen itt állt: /src/main.tsx</script>',
    '<script>var IPTV_ES5_APP=1;var url="https://pelda.hu/main.tsx";</script>',
    '<script src="webOSTV.js"></script>',
    '</body></html>',
  ].join('');
  assert.ok(!hasDevEntry(production), 'a komment/szöveg nem számít dev-belépőnek');
});

test('a CI IPK-ellenőrzése a valódi script-hivatkozást keresi, nem szövegrészletet', () => {
  const workflow = read('.github/workflows/webos-build.yml');
  // A workflow Python-kódban, raw stringben keresi a valódi script-címkét.
  assert.ok(
    workflow.includes("re.search(r'<script") && workflow.includes('/src/main\\.tsx'),
    'a workflow nem a pontosított (regex) dev-belépő ellenőrzést használja'
  );
  assert.ok(
    !workflow.includes("'/src/main.tsx' in html"),
    'a workflow még mindig szövegrészlet-kereséssel vizsgálja a dev-belépőt – ' +
      'egy forráskomment is megbuktatná a kiadást'
  );
  // A dev-belépőre bukó ág nem tűnhet el: nélküle module script kerülhetne a TV-re.
  assert.ok(
    workflow.includes('nem production build'),
    'a workflowból hiányzik a dev-belépőt elutasító hibaág'
  );
});

test('2.5.139: NINCS beégetett indulókép – a HTML kicsi marad', () => {
  /*
   * A beégetett 265 KB-os JPEG + 46 KB-os PNG volt a 2493 ms-es válaszidő
   * egyik oka. Most a takarókép külön, HELYI `splash-bg.jpg`, a betöltőképernyő
   * pedig tiszta HTML/CSS. A `str.replace` régi duplázási hibája így eleve
   * nem fordulhat elő.
   */
  const page = read('web/index.html');
  assert.ok(!page.includes('__IPTV_SPLASH_DATA_URI__'));
  assert.ok(!page.includes('__IPTV_SPLASH_TINY_URI__'));
  assert.equal((page.match(/data:image\/jpeg;base64,/g) || []).length, 0);
  assert.match(read('tools/build-webos.sh'), /def externalize_scripts/);
  const built = path.join(ROOT, 'build/webos/index.html');
  if (!fs.existsSync(built)) return;
  const html = fs.readFileSync(built, 'utf8');
  assert.ok(html.length < 200_000, `a csomagolt HTML ${html.length} byte – túl lassú`);
  assert.equal((html.match(/data:image\/jpeg;base64,/g) || []).length, 0);
});

test('a csomagolt HTML a külső app.js/app.css fájlokra hivatkozik', () => {
  const built = path.join(ROOT, 'build/webos/index.html');
  if (!fs.existsSync(built)) return;
  const html = fs.readFileSync(built, 'utf8');
  assert.match(html, /<script src="app\.js"/, 'hiányzik a külső ES5 app');
  assert.match(html, /href="app\.css"/, 'hiányzik a külső CSS');
  assert.match(html, /IPTV-ES5-APP/, 'a CI által keresett ES5 jelölő eltűnt');
  assert.match(html, /IPTV-ES5-POLYFILLS/, 'a polyfill jelölő eltűnt');
  assert.doesNotMatch(html, /<script[^>]*type="module"/);
  assert.match(html, /id="boot-screen"/, 'a betöltőképernyő hiányzik a csomagból');
  assert.match(html, /<img id="boot-bg" src="splash-bg\.jpg"/,
    'a takarokép háttere hiányzik a csomagból');
});

test('a takarókép hátterét a <head> injektálja, nem a <body>', () => {
  /*
   * 2.5.112 HIBA: az injektáló szkript a <body>-ban volt. Lassú TV-n a
   * böngésző már az injektálás ELŐTT kirajzolhatta a #tv-curtain réteget,
   * így egy pillanatra csak a statikus CSS tartalék ZÖLD színátmenete
   * látszott – ez volt a felhasználó „zöld háttér is bevillant” észrevétele.
   * A <head>-ben a stílus garantáltan az első festés előtt bekerül.
   */
  const src = read('web/index.html');
  const headEnd = src.indexOf('</head>');
  const bodyStart = src.indexOf('<body');
  assert.ok(headEnd > 0 && bodyStart > headEnd, 'a web/index.html <head>/<body> sorrendje váratlan');
  const injector = src.indexOf("__IPTV_BOOT_PICTURE__");
  assert.ok(injector > 0, 'nem található a korai kép-előmelegítő szkript');
  assert.ok(injector < headEnd, 'az előmelegítés nem a <head>-ben van');
  assert.match(src.slice(0, headEnd), /__IPTV_BOOT_PICTURE__ = 'splash-bg\.jpg'/,
    'a korai előmelegítés nem a takarókép fájljára mutat');
  assert.ok(!src.slice(bodyStart).includes("var preload = new Image()"),
    'a <body>-ban is van kép-előmelegítő (duplikált)');
});

test('a 9 mp-es indulási korlát a teljes revealNow() utat használja', () => {
  /*
   * 2.5.112 HIBA: az időtúllépési ág a nyers reveal()-t hívta, így
   * __IPTV_APP_READY__ sosem állt be, és a webos.js UI-őre 15 mp-nél
   * diagUiFail()-t futtatott – a vörös hibaképernyő a majdnem kész főoldal
   * elé ugrott („visszaugrott a takaróképre”).
   */
  const main = read('web/src/main.tsx');
  assert.ok(
    main.includes('revealNow("időtúllépés")'),
    'a 9 mp-es ág nem a revealNow()-t hívja'
  );
  assert.ok(
    !/^\s*reveal\("időtúllépés"\);/m.test(main),
    'a 9 mp-es ág még mindig a nyers reveal()-t is hívja'
  );
});

test('az app bgColor a takarókép színével egyezik – nincs fekete villanás', () => {
  /*
   * 2.5.113 HIBA: az appinfo.json bgColor-je #000000 (tiszta fekete) volt,
   * miközben magának a splash-screen.png-nek a mért átlagszíne #6ccbd3
   * (világos türkiz). A webOS a bgColor-t festi az alkalmazás első kirajzolt
   * képkockája ELŐTT – ez volt a felhasználó „nagy gyors feketeség villanás”
   * észrevétele az IPK indításakor.
   *
   * 2.5.139: az indítókép a takarokep.jpg, aminek a mért átlagszíne #84bebc.
   * A bgColor ezt követi, tehát a platform és a saját képernyő között nincs
   * színugrás.
   */
  const info = JSON.parse(read('webos/appinfo.json'));
  assert.equal(
    String(info.bgColor).toLowerCase(),
    '#84bebc',
    'a bgColor nem a takarokep.jpg átlagszíne – színugrás villanhat induláskor'
  );
  assert.equal(info.splashBackground, 'splash-screen.png');
  assert.ok(info.splashBackground, 'hiányzik a splashBackground');
});

test('a takarókép réteg alapszíne a főoldali váz sötétkékje (nincs keret)', () => {
  /*
   * Amíg a beégetett kép dekódolása tart, a background-color látszik.
   * Korábban #0d1b2a (sötétkék) volt: az első festésnél sötét keret villant,
   * és csak utána jött a világos takarókép.
   */
  const html = read('web/index.html');
  assert.ok(
    !/background-color:\s*#0d1b2a/i.test(html),
    'a takarókép/boot háttér még mindig sötétkék (#0d1b2a)'
  );
  /* 2.5.139: amíg a takarókép dekódolása tart, a háttér a takarokep.jpg
     MÉRT átlagszíne (#84bebc), nem egy idegen sötétkék. A kész felület
     megjelenésekor vált #080d1a-ra – a két állapot a saját határa.
     A webOS saját indítóképe UGYANEZ a fotó, ezért a platform képéről a
     saját képernyőnkre váltás nem hoz új látványt. */
  assert.match(html, /html\s*\{\s*background-color:\s*#7fb9bd;/);
  assert.match(html, /\.iptv-curtain\s*\{[^}]*background-color:\s*#7fb9bd;/);
  assert.match(html, /html\.iptv-booting body\s*\{\s*background-color:\s*#7fb9bd !important;/);
  assert.match(html, /html\.iptv-revealed body\s*\{\s*background-color:\s*#080d1a !important;/);
  assert.match(html, /<img id="boot-bg" src="splash-bg\.jpg"/,
    'a teljes képernyős takarókép hiányzik');
  assert.doesNotMatch(html, /background-color:\s*#6ccbd3/i,
    'a régi világos türkiz háttér visszatért');
  assert.doesNotMatch(html, /#iptv-skeleton|\.sk-player/,
    'a régi előre rajzolt főoldali váz visszatért');
});

test('a takarókép nem esik le egy lefagyott képkocka közepére', () => {
  /*
   * A 4-es napló 3–6 mp-es főszál-leállásokat mutat (LEÁLLÁS 5859 ms). Ha a
   * megjelenés egy ilyen pillanatra esik, az első képkocka rángat. Ezért a
   * megjelenés előtt mérjük a két animációs kép közti időt, és foglalt szál
   * esetén a takarókép fent marad.
   */
  const main = read('web/src/main.tsx');
  // Az afterPaint törzsét egészében vizsgáljuk: az őrfeltételnek a fn() hívás
  // ELŐTT kell állnia, különben a megjelenés akkor is azonnal megtörténne.
  const body = main.slice(main.indexOf('const afterPaint = '));
  const guardAt = body.search(/if \(frameGap > FRAME_GAP_LIMIT_MS/);
  const revealAt = body.indexOf('fn();');
  assert.ok(guardAt > 0, 'hiányzik a képváltás-mérés az afterPaint-ben');
  assert.ok(revealAt > 0, 'az afterPaint nem hívja az fn()-t');
  assert.ok(guardAt < revealAt, 'a képváltás-őr a megjelenés UTÁN áll – nem véd');
  const guardBody = body.slice(guardAt, revealAt);
  assert.match(guardBody, /window\.setTimeout\(checkRendered/, 'lefagyott szálnál nincs újrapróbálás');
  assert.match(guardBody, /return;/, 'a lefagyott ág nem szakítja meg a megjelenést');
});
