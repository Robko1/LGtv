#!/usr/bin/env node
/*
 * FUTÁSIDEJŰ NAPLÓ-TESZT (fagyás-diagnosztika).
 *
 * A beépített webOS buildet (build/webos/index.html) jsdom-ban futtatja, és a
 * `window.__IPTV_DIAG__` hídon keresztül ellenőrzi, hogy a napló valóban
 * rögzíti:
 *   • az indulást (verzió, FIGYELŐ ELINDULT, INDULÁS fázisok),
 *   • a kritikus sorokat (azonnali mentés a localStorage-ba),
 *   • az összeomlást (error), a kezeletlen ígérethibát (unhandledrejection),
 *   • az app kilépését/háttérbe kerülését (pagehide / visibilitychange),
 *   • az állapot-pillanatképet (nézet, DOM méret, videó).
 *
 * Miért külön szkript (nem `node --test`)? A jsdom-ban futó app időzítői és
 * animációs képkockái életben tartják a Node folyamatot, ezért a végén
 * egyértelműen kilépünk. Ha a build még nem készült el, a teszt „kiparancsolt”
 * (exit 0) állapotban lép tovább.
 *
 * Futtatás: node tools/test-applog-runtime.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('build/webos/index.html');
const HARD_TIMEOUT_MS = 120000;

const results = [];
let failed = false;

function check(ok, message) {
  const line = `${ok ? 'ok  ' : 'FAIL'} – ${message}`;
  results.push(line);
  console.log(line);
  if (!ok) failed = true;
}

function finish() {
  console.log(failed ? '\nHIBA: a napló-teszt nem futott át.' : '\nOK: a napló-teszt minden ellenőrzése átment.');
  process.exit(failed ? 1 : 0);
}

const killer = setTimeout(() => {
  check(false, `a teszt ${HARD_TIMEOUT_MS / 1000} mp alatt nem fejeződött be (jsdom/napló akadt)`);
  finish();
}, HARD_TIMEOUT_MS);
killer.unref?.();

if (!fs.existsSync(FILE)) {
  console.log('KIPARANCSOLT: nincs build/webos/index.html – előbb: VERSION=x.y.z bash tools/build-webos.sh');
  process.exit(0);
}

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch {
  console.log('KIPARANCSOLT: jsdom nincs telepítve – npm install a gyökérben');
  process.exit(0);
}

const html = fs.readFileSync(FILE, 'utf8');
const vc = new VirtualConsole();
vc.on('jsdomError', () => { /* a TV-specifikus API-k hiánya nem hiba itt */ });
vc.on('error', () => { /* a React konzolhibái külön tesztben vannak */ });

const dom = new JSDOM(html, {
  // FONTOS: http(s) eredet kell, különben a jsdom localStorage-ja tiltott
  // (opaque origin) – a napló mentését nem lehetne tesztelni.
  url: 'http://localhost/index.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.alert = () => {};
    window.confirm = () => true;
    window.prompt = () => null;
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; },
      });
    }
  },
});

const { window } = dom;

/* A diagnosztikai híd a bundle lefutása után jelenik meg. */
const deadline = Date.now() + 60000;
while (!window.__IPTV_DIAG__ && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const diag = window.__IPTV_DIAG__;
check(!!diag, 'a __IPTV_DIAG__ híd létrejön a bundle betöltésekor');
if (!diag) finish();

/* A felület is épüljön fel – enélkül a napló „üres” állapotot rögzítene. */
const mountDeadline = Date.now() + 30000;
const rootEl = window.document.getElementById('root');
while (rootEl && rootEl.childElementCount === 0 && Date.now() < mountDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 150));
}
check(Boolean(rootEl && rootEl.childElementCount > 0),
  'a React felület felépül a naplózás mellett is (nem fekete képernyő)');

/* A normál indulási napló most szándékosan üres: csak kézi indítás után
   rögzítünk. A SÁRGA ablak „Naplózás indítása” gombját a hídon modellezzük. */
const beforeStart = diag.text();
check(beforeStart === '', 'induláskor nincs automatikus diagnosztikai naplózás');
check(typeof diag.startLogging === 'function' && typeof diag.logStatus === 'function',
  'a kézi naplózás indítója és állapota elérhető a hídon');
diag.startLogging();

/* ── 1. Indulási napló ─────────────────────────────────────────────────── */
let text = diag.text();
check(/=== IPTV indul; verzió=\d+\.\d+\.\d+/.test(text), 'az indulási sor a valódi verziót tartalmazza');
check(/FIGYELŐ ELINDULT/.test(text), 'a fagyásfigyelő elindult');
check(/INDULÁS \[0 ms\] kézi naplózás elindítva/.test(text), 'a kézi indításnak van ezredmásodperces fázis-sora');
check(/Eszköz: /.test(text), 'a böngésző/készülék azonosítója is a naplóban van');

// A live/movie/subtitle útvonal és a query sem vihet ki Xtream-belépési adatot.
diag.log('REDAKCIÓ-TESZT https://panel.example/live/secret-user/secret-pass/100.ts?username=secret-user&password=secret-pass&token=secret-token');
const redacted = diag.text();
check(!redacted.includes('secret-user') && !redacted.includes('secret-pass') && !redacted.includes('secret-token'),
  'a kézi napló URL-ből is eltávolítja a credentialt és a tokent');

/* ── 2. Állapot-pillanatkép ────────────────────────────────────────────── */
const state = diag.state();
console.log(`  (pillanatkép: ${state})`);
check(/nézet=/.test(state), 'a pillanatkép megmondja, melyik nézet látszik');
check(/DOM=\d+ csomópont/.test(state), 'a pillanatkép tartalmazza a DOM méretét');
check(/videó=/.test(state), 'a pillanatkép tartalmazza a lejátszó állapotát');

/* ── 3. Kritikus sor AZONNAL a tárolóba kerül ─────────────────────────── */
diag.critical('TESZT-KRITIKUS-SOR');
const stored = window.localStorage.getItem('iptv_rt_app-log') || '';
check(/TESZT-KRITIKUS-SOR/.test(stored), 'a kritikus sor azonnali mentéssel a localStorage-ba kerül');
check(/TESZT-KRITIKUS-SOR/.test(diag.text()), 'a kritikus sor bekerül a kiolvasható naplóba');

/* ── 4. Összeomlás (error) ─────────────────────────────────────────────── */
window.dispatchEvent(new window.ErrorEvent('error', {
  message: 'TESZT-ÖSSZEOMLÁS-ÜZENET',
  filename: 'teszt.js',
  lineno: 42,
}));
check(/ÖSSZEOMLÁS: TESZT-ÖSSZEOMLÁS-ÜZENET @ teszt\.js:42/.test(diag.text()),
  'a JS-hiba (error) üzenete és helye a naplóba kerül');
check(/ÖSSZEOMLÁS: TESZT-ÖSSZEOMLÁS-ÜZENET[\s\S]{0,240}?nézet=/.test(diag.text()),
  'az összeomlás sorhoz odakerül a felület pillanatnyi állapota');

/* ── 5. Kezeletlen ígérethiba ──────────────────────────────────────────── */
const rejection = new window.Event('unhandledrejection');
rejection.reason = new Error('TESZT-ÍGÉRETHIBA');
window.dispatchEvent(rejection);
check(/KEZELETLEN ÍGÉRETHIBA: Error: TESZT-ÍGÉRETHIBA/.test(diag.text()),
  'a kezeletlen ígérethiba is a naplóba kerül');

/* ── 6. Kilépés / háttérbe kerülés ─────────────────────────────────────── */
window.dispatchEvent(new window.Event('pagehide'));
check(/OLDAL ELHAGYÁSA \(pagehide\)/.test(diag.text()),
  'az app kilépése (pagehide) bizonyítéka a naplóban van');
check(diag.logStatus().enabled === false, 'az app elhagyásakor a kézi naplózás automatikusan leáll');

const beforeHidden = diag.text();
Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
window.document.dispatchEvent(new window.Event('visibilitychange'));
check(diag.text() === beforeHidden,
  'a kézi naplózás leállása után a háttérbe kerülés nem indít automatikus naplózást');

/* ── 7. A napló a törlés után is újraépül ─────────────────────────────── */
diag.startLogging();
diag.clear();
check(!/TESZT-KRITIKUS-SOR/.test(diag.text()), 'a törlés kiüríti a naplót');
diag.log('TESZT-TÖRLÉS-UTÁN');
check(/TESZT-TÖRLÉS-UTÁN/.test(diag.text()), 'törlés után is lehet új sort írni');

/* ── 8. Mérés-ablak nullázása (kézi napló híd) ─────────────────────────── */
check(typeof diag.measure === 'function' && typeof diag.resetMeasure === 'function',
  'a mérés-ablak elérhető a diagnosztikai hídon');
diag.log('TESZT-MÉRÉS-SOR-1');
diag.log('TESZT-MÉRÉS-SOR-2');
const dirty = diag.measure();
check(dirty.logLines >= 2, `a mért naplósorok száma nő (${dirty.logLines})`);
const reset = diag.resetMeasure('teszt-frissítés');
check(reset.logLines === 0 && reset.errors === 0 && reset.longTasks === 0,
  `a Frissítés nullázza a mért értékeket (sor=${reset.logLines}, hiba=${reset.errors}, feladat=${reset.longTasks})`);
check(/^\d{2}:\d{2}:\d{2}$/.test(reset.startedAtText),
  `a mérés kezdete látható időpont (${reset.startedAtText})`);
check(/=== ÚJ MÉRÉS KEZDETE: \S+ \(\d{2}:\d{2}:\d{2}\); minden korábbi mért érték nullázva/.test(diag.text()),
  'a naplóban látható az új mérés kezdő időpontja');
check(/MÉRÉS KEZDETE: \d{2}:\d{2}:\d{2}/.test(diag.text()),
  'a napló fejléce is mutatja a mérés kezdetét');
check(/MÉRÉS NULLÁZÁS ELŐTT \[\d{2}:\d{2}:\d{2} óta\]: naplósorok=\d+, hibák=\d+, hosszú feladatok=\d+/.test(diag.text()),
  'a napló a nullázás előtti mért értékeket is megőrzi (bizonyíték a nullázásra)');
diag.log('TESZT-MÉRÉS-UTÁN');
check(diag.measure().logLines === 1, 'a nullázás után a számlálás 0-ról indul újra');

try { window.close(); } catch { /* nem kritikus */ }
clearTimeout(killer);
finish();
