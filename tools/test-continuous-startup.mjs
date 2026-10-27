#!/usr/bin/env node
/*
 * 2.5.135 – FOLYAMATOS INDULÁS (nincs zöld, nincs fekete felvillanás).
 *
 * A két valós TV-napló:
 *   #2  2026-10-27 00:14:19 – első indítás (104 sor, 2.5.134)
 *   #3  2026-10-27 00:14:56 – ugyanannak az IPK-nak az újraindítása
 *
 * Mindkettőben: first-paint 948/989 ms, FCP 948/990 ms, REVEAL +715/+1739 ms.
 * A felhasználó „fekete felvillanást” és „zöld háttér felvillanást” látott.
 *
 * Okok:
 *   1. A takarókép két CSS HÁTTÉRRÉTEG volt (1280×720 JPEG + 48×27 PNG).
 *      Amíg a felső JPEG dekódolása tartott, a Chrome EGYIK réteget sem
 *      festette ki → csak a lapos #6ccbd3 szín látszott (zöld villanás).
 *   2. A REVEAL egyetlen feladatban törölte a takaróképet, levette a
 *      booting osztályt és meghívta a notifyAppLoaded()-ot. A build és a
 *      webos.js `body { background:#000 }` szabálya + az üres, fekete
 *      lejátszó-doboz miatt a következő képkocka közel fekete volt.
 *
 * Ezek a tesztek azt ellenőrzik, hogy a javítás NEM csak elemzés maradt:
 *   • valódi <img decoding="sync">, EGYETLEN tartalék PNG-réteg;
 *   • sehol nincs #000 háttér a boot-láncban;
 *   • a takarókép 1920×1080 = a webOS splashBackground felbontása;
 *   • a REVEAL áttűnéssel, nem ugrással adja át a képernyőt;
 *   • az üres főoldal megtartja az indítóképet (fix váz, csak adat változik).
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
const PLAYER = read('web/src/components/VideoPlayer.tsx');
const VERSION = read('web/src/appVersion.ts');
const APPINFO = JSON.parse(read('webos/appinfo.json'));

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

/* ─────────────── 1. ZÖLD VILLANÁS: valódi kép, egy réteg ─────────────── */

test('a takarókép VALÓDI, szinkron dekódolású <img> – nem CSS háttérréteg', () => {
  assert.match(PAGE, /<div id="tv-curtain" class="iptv-curtain"[^>]*>\s*<img id="tv-curtain-img"[^>]*decoding="sync"/,
    'hiányzik a decoding="sync" képelem a takaróképről');
  assert.match(PAGE, /fetchpriority="high"/, 'a takarókép nem kiemelt prioritású');
  assert.match(PAGE, /\.iptv-curtain > img\s*\{[^}]*object-fit:\s*cover/,
    'a kép nem tölti ki a képernyőt (ugrálna a logó)');
  // A src-t a <head> egyetlen beégetett adat-URI-jából kapja – nincs második
  // 200 kB-os másolat a HTML-ben.
  assert.match(PAGE, /window\.__IPTV_BOOT_PICTURE__ = hasSplash \? splashData : '';/);
  assert.match(PAGE, /var source = window\.__IPTV_BOOT_PICTURE__;/);
  assert.equal(PAGE.split('__IPTV_SPLASH_DATA_URI__').length - 1, 1,
    'a teljes kép jelölője nem pontosan egyszer szerepel');
  assert.doesNotMatch(PAGE, /var splashImage =/,
    'a teljes kép újra CSS background-image lenne (a dekódolás nem blokkolná a festést)');
  assert.doesNotMatch(PAGE, /var splashLayer =/, 'a két CSS-réteg visszatért');
});

test('egyetlen tartalék képréteg van, és az is a VALÓDI kép kicsinyített mása', () => {
  assert.match(PAGE, /var tinyImage = hasTiny \? 'url\(' \+ tinyData \+ '\)' : 'none';/);
  assert.match(PAGE, /"#tv-curtain\{background-image:" \+ tinyImage/);
  assert.match(PAGE, /"html\.iptv-booting body\{background-image:" \+ tinyImage/);
  assert.equal((PAGE.match(/background-image:" \+ tinyImage/g) || []).length, 2,
    'a tartalék képet pontosan a takaróképre és a body-ra kell tenni');
  // A build 192×108-as PNG-t készít ugyanabból a képből (nem 48×27, nem szín).
  assert.match(BUILD, /resize\(\(192, 108\), Image\.Resampling\.BOX\)/);
  assert.match(BUILD, /tiny_uri = "data:image\/png;base64,"/);
  assert.doesNotMatch(BUILD, /linear-gradient\(135deg/);
});

test('a takarókép a webOS indítóképével AZONOS felbontásban készül', () => {
  assert.match(BUILD, /splash-screen\.png"\)\.convert\("RGB"\)/);
  assert.match(BUILD, /src\.save\(\s*build_dir \/ "splash-bg\.jpg", "JPEG", quality=80, optimize=True, progressive=False/,
    'a beégetett kép nem 1920×1080-as baseline JPEG');
  assert.doesNotMatch(BUILD, /resize\(\(1280, 720\)/,
    'a takarókép újra kisebb, mint a webOS indítóképe – a logó belobbanna');
  assert.match(PAGE, /PIXELRE UGYANAZT a képet mutatják/);
});

/* ─────────────── 2. FEKETE VILLANÁS: sehol nincs #000 ─────────────── */

test('a boot-láncban sehol nincs fekete body/vászon háttér', () => {
  // A magyarázó kommentek (amelyek a régi hibát írják le) nem számítanak:
  // csak a VALÓDI CSS-deklarációkat vizsgáljuk.
  const cssOnly = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(cssOnly, /background(-color)?:\s*#000\b/i,
    'a HTML-ben maradt fekete háttér');
  assert.doesNotMatch(WEBOS, /body\.webos-tv, body\.lg-webos \{ background:#000/i,
    'a webos.js újra feketére állítja a body-t');
  assert.doesNotMatch(BUILD, /body\.webos-tv, body\.lg-webos \{\{\s*background: #000/i,
    'a buildbe égetett CSS újra feketére állítja a body-t');
  assert.doesNotMatch(THEME, /body\.webos-theme\s*\{[^}]*background:\s*#000/i,
    'a webos téma még mindig feketére állítja a body-t');
  assert.match(THEME, /--tv-bg:\s*#080d1a;/);
  assert.match(WEBOS, /body\.webos-tv, body\.lg-webos \{ background:#080d1a/);
  assert.match(BUILD, /body\.webos-tv, body\.lg-webos \{\{\s*\/\* 2\.5\.135[\s\S]{0,180}background: #080d1a/);
});

test('a body hátterét inline stílus is biztosítja (gyenge CSS-motorokon is)', () => {
  // A webos.css, a webos.js és a build is állítgatja a body-t; egy régebbi
  // webOS Chrome-on ez !important nélkül felülírhatná a boot-színt.
  assert.match(PAGE, /document\.body\.style\.backgroundColor = '#6ccbd3';/);
  assert.match(PAGE, /document\.body\.style\.backgroundColor = '#080d1a';/);
});

test('a html vászna és a body háttere a takarókép színéről az app sötétkékjére vált', () => {
  assert.match(PAGE, /html\s*\{\s*\/\*[^{]*\*\/\s*background-color:\s*#6ccbd3;/,
    'a vászon induláskor nem a takarókép színe');
  assert.match(PAGE, /html\.iptv-booting body\s*\{[\s\S]{0,320}background-color:\s*#6ccbd3 !important;/);
  assert.match(PAGE, /html\.iptv-revealed body\s*\{[\s\S]{0,320}background-color:\s*#080d1a !important;/);
  // Az !important kell: a webos.js később injektált `body.webos-tv` szabálya
  // és a buildbe égetett CSS egyaránt próbálkozott a body háttérrel.
  assert.match(PAGE, /html\.iptv-revealed\s*\{\s*background-color:\s*#080d1a;/);
});

test('az üres IPK lejátszó-doboza nem fekete: megőrzi az indítóképet', () => {
  assert.match(PAGE, /var posterImage = hasSplash \? 'url\(' \+ splashData \+ '\)' : 'none';/);
  assert.match(PAGE, /html\[data-iptv-boot=\\"empty\\"\] \[data-player-poster\]/);
  assert.match(PAGE, /"background-position:center center;background-size:cover;"/);
  // A poszter belseje (logó-doboz + „Kapcsolódás…”) csak akkor látszik, ha
  // van csatorna – különben eltakarná a képet.
  const poster = PLAYER.slice(PLAYER.indexOf('data-player-poster'), PLAYER.indexOf('data-player-poster') + 1500);
  assert.match(poster, /\{channel && \(\s*<>/,
    'a poszter belseje nincs az üres állapothoz kötve');
  assert.match(PLAYER, /2\.5\.135 – FOLYAMATOS INDULÁS/);
});

/* ─────────────── 3. FOLYAMATOS ÁTTŰNÉS (viselkedés) ─────────────── */

test('a REVEAL nem ugrik: a takarókép a kész felület fölött halványul el', () => {
  const { window, dom, calls } = bootPage();
  try {
    const doc = window.document;
    assert.equal(window.__IPTV_REVEAL_DONE__, false);
    window.__IPTV_PREPARE_REVEAL__();
    window.__IPTV_REVEAL__('üres alkalmazás – kész felület');

    assert.equal(calls.length, 1, 'a notifyAppLoaded pontosan egyszer fut');
    assert.equal(window.__IPTV_REVEALED__, true);
    assert.match(doc.documentElement.className, /iptv-revealed/);
    assert.match(doc.documentElement.className, /iptv-handoff/);
    assert.doesNotMatch(doc.documentElement.className, /iptv-booting/);
    assert.equal(window.getComputedStyle(doc.getElementById('root')).visibility, 'visible');
    assert.equal(doc.body.style.backgroundColor, 'rgb(8, 13, 26)',
      'a body a REVEAL-kor nem az app sötétkék hátterét kapta');

    const curtain = doc.getElementById('tv-curtain');
    assert.ok(curtain, 'a takarókép nem ugorhat le azonnal – ez volt a villanás');
    assert.match(curtain.className, /iptv-fading/);
    assert.equal(curtain.style.opacity, '0');
    assert.equal(window.__IPTV_REVEAL_DONE__, false);

    // Az áttűnés vége: a réteg végleg eltűnik, de a felület látható marad.
    window.__IPTV_FINISH_REVEAL__();
    assert.equal(doc.getElementById('tv-curtain'), null);
    assert.equal(window.__IPTV_REVEAL_DONE__, true);
    assert.doesNotMatch(doc.documentElement.className, /iptv-handoff/);
    assert.match(doc.documentElement.className, /iptv-revealed/);
    assert.match(doc.documentElement.className, /iptv-prerender/);
    assert.equal(window.getComputedStyle(doc.getElementById('root')).visibility, 'visible');
    assert.equal(calls.length, 1, 'az áttűnés vége nem hívhatja újra a notifyAppLoaded()-ot');

    // Idempotens: a transitionend és az időzítő is hívhatja.
    window.__IPTV_FINISH_REVEAL__();
    assert.equal(calls.length, 1);
  } finally {
    dom.window.close();
  }
});

test('az áttűnés a TAKARÓKÉPET halványítja, nem a felületet (nincs beúszás)', () => {
  assert.match(PAGE, /#tv-curtain\.iptv-fading\s*\{[^}]*opacity:\s*0;[^}]*transition:\s*opacity 200ms linear !important;/,
    'hiányzik az !important kompozitor-átmenet (a webos.js minden transitiont nulláz)');
  assert.match(PAGE, /setProperty\('transition', 'opacity 200ms linear', 'important'\)/,
    'hiányzik az inline !important átmenet – a webos.css 0s-re kényszerítheti');
  assert.match(PAGE, /setProperty\('transition-duration', '200ms', 'important'\)/,
    'a hosszú alak hiányzik – a webos.css 0s-re kényszerítheti az időtartamot');
  assert.doesNotMatch(PAGE, /html\.iptv-revealed #root\s*\{[^}]*opacity/,
    'a FELÜLET újra áttetsző lenne – alatta látszana a zöld háttér');
  assert.doesNotMatch(PAGE, /@keyframes iptvReveal/);
  // A REVEAL biztonsági időzítője és a 12 mp-es háló is megmarad.
  assert.match(PAGE, /\}, 240\);/);
  assert.match(PAGE, /window\.__IPTV_REVEAL__\('biztonsági háló'\);\s*\},\s*12000\)/);
});

test('a biztonsági időzítő akkor is eltávolítja a takaróképet, ha nincs transitionend', async () => {
  const { window, dom } = bootPage();
  try {
    window.__IPTV_REVEAL__('teszt');
    assert.ok(window.document.getElementById('tv-curtain'), 'az áttűnésnek el kell indulnia');
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.equal(window.document.getElementById('tv-curtain'), null,
      'a 240 ms-os biztonsági időzítő nem távolította el a takaróképet');
    assert.equal(window.__IPTV_REVEAL_DONE__, true);
  } finally {
    dom.window.close();
  }
});

test('a webOS indítóképét a SAJÁT, azonos képű takarókép alatt engedjük el', () => {
  const reveal = PAGE.slice(PAGE.indexOf('window.__IPTV_REVEAL__ = function'));
  const notifyAt = reveal.indexOf('notifyAppLoaded()');
  const fadeAt = reveal.indexOf("'iptv-curtain iptv-fading'");
  const finishAt = reveal.indexOf('__IPTV_FINISH_REVEAL__()');
  assert.ok(notifyAt > 0 && fadeAt > notifyAt,
    'a notifyAppLoaded() az áttűnés ELŐTT kell fusson (különben üres kocka)');
  assert.ok(finishAt > fadeAt, 'az áttűnés lezárása az áttűnés után kell jöjjön');
});

/* ─────────────── 4. verzió / integráció ─────────────── */

test('a verzió mindkét helyen 2.5.135, és a változások szerepelnek a kiadási jegyzékben', () => {
  assert.match(VERSION, /export const WEB_VERSION = '2\.5\.135';/);
  assert.equal(APPINFO.version, '2.5.135');
  assert.match(VERSION, /FOLYAMATOS INDULÁS/);
  assert.match(VERSION, /ÁTTŰNIK/);
});
