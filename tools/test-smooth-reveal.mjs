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
  // 2.5.135: a takaróképet az áttűnés VÉGÉN távolítjuk el (külön,
  // idempotens függvény), nem a REVEAL első sorában – így a kép
  // folyamatosan ér át a kész felületbe.
  assert.match(PAGE, /window\.__IPTV_FINISH_REVEAL__ = function/,
    'hiányzik az áttűnést lezáró függvény');
  assert.match(PAGE, /fading\.parentNode\.removeChild\(fading\)/,
    'a takarókép eltávolítása eltűnt');
  assert.match(reveal.slice(0, 3600), /__IPTV_FINISH_REVEAL__\(\)/,
    'a REVEAL nem indítja el az áttűnés lezárását');
});

test('a főoldal a takarókép alatt már látható, de a takarókép fent marad', () => {
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

test('nincs több zöld tartalék színátmenet a takaróképen', () => {
  assert.doesNotMatch(PAGE, /#5fe3b6|#4fd8e0/,
    'a zöld színátmenet még mindig a takarókép tartaléka – ez villant be 444 ms-nél');
  // A mért átlagszín marad: a webOS bgColor-jával egyezik.
  assert.equal((PAGE.match(/background-color:\s*#6ccbd3/gi) || []).length >= 2, true,
    'a takarókép/boot átlagszíne eltűnt');
  assert.doesNotMatch(PAGE, /background-image:\s*linear-gradient\(135deg/,
    'maradt színátmenetes tartalék hátkép');
});

test('a takarókép első festése EGYETLEN, azonnal dekódolható képet kap', () => {
  assert.equal(PAGE.split('__IPTV_SPLASH_TINY_URI__').length - 1, 1,
    'a kicsinyített kép jelölője nem pontosan egyszer szerepel');
  assert.match(PAGE, /var tinyImage = hasTiny \? 'url\(' \+ tinyData \+ '\)' : 'none';/,
    'hiányzik a kicsinyített kép egyetlen CSS-rétege');
  /* 2.5.135: NINCS több két CSS-réteg. Amíg a felső JPEG nem volt kész,
     a Chrome egyik réteget sem festette ki, csak a lapos zöld hátteret. */
  assert.doesNotMatch(PAGE, /var splashLayer =/,
    'a teljes kép újra a CSS-háttér rétegei között van (zöld villanás)');
  assert.match(PAGE, /"#tv-curtain\{background-image:" \+ tinyImage/,
    'a tartalék kép nem a takaróképre kerül');
  assert.match(PAGE, /"html\.iptv-booting body\{background-image:" \+ tinyImage/,
    'a tartalék kép nem a body-ra kerül');
  assert.match(PAGE, /<img id="tv-curtain-img"[^>]*decoding="sync"/,
    'hiányzik a szinkron dekódolású, valódi <img> takarókép');
  assert.match(PAGE, /var posterImage = hasSplash \? 'url\(' \+ splashData \+ '\)' : 'none';/,
    'az üres főoldal nem kapja meg az indítóképet a lejátszó-dobozába');
  assert.match(PAGE, /html\[data-iptv-boot=\\"empty\\"\] \[data-player-poster\]/,
    'a lejátszó poszterére nem terjed ki az üres állapot szabálya');
});

test('a teljes indítókép dekódolása már a HTML fejlécében elindul', () => {
  const head = PAGE.slice(0, PAGE.indexOf('</head>'));
  assert.match(head, /var preload = new Image\(\);/,
    'hiányzik a korai kép-dekódolás');
  assert.match(head, /preload\.decode\(\)/,
    'a dekódolás nem indul el az első festés előtt');
  assert.match(head, /preload\.src = splashData;/,
    'a rejtett Image nem a beégetett képet tölti');
});

test('a build feloldja a kicsinyített kép jelölőjét (PNG, nem JPEG)', () => {
  const build = read('tools/build-webos.sh');
  assert.match(build, /html\.replace\("__IPTV_SPLASH_TINY_URI__", tiny_uri, 1\)/,
    'a build nem cseréli ki a kicsinyített kép jelölőjét');
  assert.match(build, /tiny_uri = "data:image\/png;base64,"/,
    'a kicsinyített kép nem PNG (a csomagban pontosan egy JPEG lehet)');
  assert.match(build, /resize\(\(192, 108\)/,
    'a tartalék kép nem 192x108 pixeles');
  assert.match(build, /quality=80, optimize=True, progressive=False/,
    'a beégetett kép nem 1920x1080-as, baseline JPEG');
  const built = path.join(ROOT, 'build/webos/index.html');
  if (!fs.existsSync(built)) return;
  const html = fs.readFileSync(built, 'utf8');
  assert.ok(!html.includes('__IPTV_SPLASH_TINY_URI__'),
    'a kicsinyített kép jelölője feloldatlan maradt a csomagban');
  assert.ok(html.includes('data:image/png;base64,'),
    'a kicsinyített kép nincs beégetve a csomagolt HTML-be');
  // Progresszív JPEG részlegesen dekódolt, kockás köztes képet is festhet.
  assert.match(build, /progressive=False/,
    'a beégetett indítókép újra progresszív JPEG – részleges dekódolás villanhat');
});

/* ─────────────────── 2. gyorsítás: nincs dupla tár-próba ─────────────────── */

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
