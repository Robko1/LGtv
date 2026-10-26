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
  assert.match(reveal.slice(0, 900), /removeChild\(splash\)/,
    'a takarókép eltávolítása eltűnt');
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
  assert.match(revealFn.slice(0, 700), /preparePaint\(\);[\s\S]{0,220}afterPaint/,
    'az előfestésnek a két animációs kép ELŐTT kell lennie');
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
