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

test('2.5.162: a dizájn ikonja LEGFELJEBB egyszer van beégetve – a HTML kicsi marad', () => {
  /*
   * A 2.5.139-es mérés szerint a beégetett 265 KB-os JPEG + 46 KB-os PNG volt
   * a 2493 ms-es válaszidő egyik oka. A felhasználó által megtervezett
   * betöltőképernyő egyetlen képe a saját IPTV-ikon (64 kB, 251×252 px), és az
   * a HTML-ben is CSAK EGYSZER szerepel: a háttér és a két jelvény ugyanazt az
   * adat-URI-t használja. A `str.replace` régi duplázási hibája így eleve nem
   * fordulhat elő.
   */
  const page = read('web/index.html');
  assert.ok(!page.includes('__IPTV_SPLASH_DATA_URI__'));
  assert.ok(!page.includes('__IPTV_SPLASH_TINY_URI__'));
  assert.equal((page.match(/data:image\/jpeg;base64,/g) || []).length, 1,
    'a dizájn ikonja nem pontosan egyszer van beágyazva');
  assert.match(read('tools/build-webos.sh'), /def externalize_scripts/);
  const built = path.join(ROOT, 'build/webos/index.html');
  if (!fs.existsSync(built)) return;
  const html = fs.readFileSync(built, 'utf8');
  assert.ok(html.length < 200_000, `a csomagolt HTML ${html.length} byte – túl lassú`);
  assert.equal((html.match(/data:image\/jpeg;base64,/g) || []).length, 1,
    'a csomagban sem lehet egynél több beégetett kép');
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
  assert.doesNotMatch(html, /splash-bg|boot-bg/,
    'a csomagba háttérkép került – a háttér CSS színátmenet kell legyen');
});

test('2.5.158: nincs kép-előmelegítő szkript – a háttér CSS', () => {
  /*
   * A korábbi `__IPTV_BOOT_PICTURE__` előmelegítő szkript a <head>-ben
   * szinkron módon dekódolt egy 1920x1080-as JPEG-et. Ez az 1 GB memóriás
   * TV-n mérhetően késleltette az első festést, ezért megszűnt.
   */
  const src = read('web/index.html');
  assert.equal(src.includes('__IPTV_BOOT_PICTURE__'), false,
    'a kép-előmelegítő szkript visszatért');
  assert.equal(src.includes('__IPTV_BOOT_PRELOAD__'), false,
    'a kép-előmelegítő szkript visszatért');
  assert.equal(src.includes('new Image()'), false,
    'a <head>-ben ismét kép-előmelegítés fut');
  assert.match(src, /<script src="webOSTV\.js"><\/script>/,
    'a webOS Luna-híd (TV típus a naplóhoz) nem töltődik be');
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

test('az app bgColor sötét – nem villan be világos kék a lap festése előtt', () => {
  if (read('web/index.html').includes('TEMPORARY_NO_BOOT_ANIMATION')) {
    const page = read('web/index.html');
    const info = JSON.parse(read('webos/appinfo.json'));
    assert.equal(info.splashBackground, 'splash-screen.png');
    assert.match(page, /TEMPORARY_NO_BOOT_ANIMATION/);
    assert.match(page, /root && root\.childElementCount > 0/,
      'a platformkép levétele előtt meg kell várni a főoldal DOM-ját');
    assert.match(page, /window\.setTimeout\(waitForMainPage, 100\)/);
    assert.doesNotMatch(page, /window\.setTimeout\(releasePlatformSplash, 1500\)/);
    return;
  }
  /*
   * A webOS a bgColor-t festi az alkalmazás első kirajzolt képkockája ELŐTT,
   * és minden olyan pillanatban, amikor a lap éppen nem festett.
   *
   * 2.5.113: #000000 volt → „nagy gyors feketeség villanás”.
   * 2.5.139: a takarokep.jpg mért átlagszíne, #84bebc (világos türkiz).
   * 2.5.151: a 35. naplóban az első festés 1853 ms volt, és addig ez a
   * világos türkiz látszott – a felhasználó „villogó kék” észrevétele.
   * Mostantól a bgColor a kész felület sötétje: ha a lap egy pillanatra nem
   * fest, a néző sötétet lát, nem világos kék villanást.
   *
   * 2.5.162: a bgColor a BETÖLTŐKÉPERNYŐ alapszíne (#04141a). A felhasználó
   * jelezte, hogy az indulásnál „fekete–zöldes háttér váltakozik”: a sötétkék
   * ablak → türkiz platform kép → türkiz betöltőképernyő sorrend adta a
   * váltakozást. Ugyanazzal a tónussal a legelső kockától folyamatos a kép.
   */
  const info = JSON.parse(read('webos/appinfo.json'));
  assert.equal(
    String(info.bgColor).toLowerCase(),
    '#04141a',
    'a bgColor nem a betöltőképernyő alapszíne – világos kocka villanhat a lap első festése előtt'
  );
  assert.equal(info.splashBackground, 'splash-screen.png');
  assert.ok(info.splashBackground, 'hiányzik a splashBackground');
  // A platform indítóképét a saját betöltőképernyő TÉNYLEGES festése után vesszük le.
  /*
   * 2.5.163: a levétel a `paint` bejegyzéshez van kötve (first-paint /
   * first-contentful-paint), 1500 ms-os biztonsági hálóval.
   *
   * A 18. napló mérése szerint a két képkockára kötött levétel +327 ms-nál
   * futott le, de az első festés csak 815 ms-nál (FCP 1081 ms) történt meg:
   * addig az ablak sötét háttere látszott a platform kép után – ez volt a
   * „fekete–zöldes háttér váltakozás”. A képkocka-visszahívás ugyanis a
   * festés ELŐTT is lefuthat, a paint-bejegyzés viszont a megtörtént festésről
   * szól. Mivel a platform kép és a saját háttér ugyanaz a kép, a csere
   * észrevehetetlen, és nincs üres kocka.
   */
  const page = read('web/index.html');
  assert.match(page, /first-contentful-paint/, 'a platform kép levétele nem a festéshez van kötve');
  assert.doesNotMatch(page, /function armReleaseFromFrame\(\)/,
    'a levétel újra képkocka-visszahívásra vár (a festés előtt is lefuthat)');
  assert.match(page, /paintObserver\.observe\(\{ type: 'paint', buffered: true \}\)/,
    'a festés-figyelő nem indul el (a korai festés bejegyzése elveszne)');
  assert.match(page, /window\.setTimeout\(releasePlatformSplash, 1500\);/, 'nincs 1500 ms-os biztonsági háló');
  assert.doesNotMatch(page, /setTimeout\(releasePlatformSplash, (350|900)\)/,
    'a festés előtt elsülő régi időzítő visszatért');
});

test('nincs világos türkiz szín a lapban vagy a webOS háttérben', () => {
  /*
   * 2.5.151 – a 35–39. napló használói észrevétele: a takarókép után és
   * csatornaváltásnál VILÁGOS KÉK (türkiz) kocka villant be. Ezek a régi
   * alapszínek (#7fb9bd) és a webOS ablak háttere (#84bebc) voltak.
   * A teszt a TELJES forrásfát nézi, hogy egy későbbi kör véletlenül se
   * hozza vissza őket.
   */
  const files = [
    'web/index.html',
    'web/src/index.css',
    'web/src/themes/webos.css',
    'webos/appinfo.json',
  ];
  for (const file of files) {
    let text = '';
    try { text = read(file); } catch { continue; }
    for (const colour of ['#7fb9bd', '#84bebc', '#6ccbd3']) {
      assert.ok(
        text.toLowerCase().indexOf(colour) === -1,
        `${file}: világos türkiz alapszín (${colour}) – ez villan be a takarókép után`
      );
    }
  }
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
  /*
   * 2.5.151: a html és a takarókép alapszíne is a kész felület sötétje.
   * Korábban világos türkiz volt (#7fb9bd) – ez villant be a takarókép után
   * és csatornaváltásnál a főoldalon.
   */
  assert.match(html, /html\s*\{\s*background-color:\s*#080d1a;/);
  assert.match(html, /\.iptv-curtain\s*\{[^}]*background-color:\s*#080d1a;/);
  assert.doesNotMatch(html, /background-color:\s*#7fb9bd/i,
    'a világos türkiz alapszín visszatért');
  /* 2.5.147: a kész felület felülete (body) már az első festéstől sötétkék,
     a html alapszíne pedig végig a takarókép átlagszíne – a REVEAL-nál
     EGYETLEN háttérszín sem vált, ezért nincs fekete kocka. */
  assert.match(html, /html\.iptv-booting body\s*\{\s*background-color:\s*#080d1a !important;/);
  assert.match(html, /html\.iptv-revealed body\s*\{\s*background-color:\s*#080d1a !important;/);
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
  /*
   * 2.5.153 – MEGFORDULT A SZABÁLY.
   *
   * A 41–44. napló mérése: a videó elindulásakor a TV 1,2–3,9 mp-ig nem ad
   * képkockát, miközben a JavaScript tovább fut (a naplóban közben jönnek a
   * média- és EPG-események). A régi őr ezt „foglalt fő szálnak” látta, és
   * elhalasztotta a takarókép levételét – a 41. naplóban 3,6 mp helyett
   * 6,5 mp-nél történt meg a felfedés.
   *
   * Ezért mostantól a képkockára legfeljebb 350 ms-ot várunk, utána a váltás
   * megtörténik; a kihagyás ténye csak a naplóba kerül.
   */
  const main = read('web/src/main.tsx');
  const afterPaintAt = main.indexOf('const afterPaint = ');
  const body = main.slice(afterPaintAt, main.indexOf('\n  };', afterPaintAt) + 5);
  assert.match(main, /const REVEAL_PAINT_TIMEOUT_MS = 350;/, 'nincs időkorlát a képkocka-várakozásra');
  assert.match(body, /window\.setTimeout\(\(\) => finish\('időzítő'/, 'az időzítős ág hiányzik');
  assert.doesNotMatch(body, /setTimeout\(checkRendered/, 'a halasztó újrapróbálás visszatért');
  assert.match(body, /finish\('képkocka'/, 'a képkockás befejezés hiányzik');
  assert.match(body, /finish\('időzítő'/, 'az időzítős befejezés hiányzik');
});
