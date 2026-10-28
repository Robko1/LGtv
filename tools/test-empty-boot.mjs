#!/usr/bin/env node
/*
 * ÜRES IPK INDÍTÁSA – GYORS, SIMA ELSŐ KÉPKOCKA (2.5.129).
 *
 * A 2026-10-26 21:31:49-es Supabase-napló (67 sor, 2.5.128) ezt mutatta:
 *
 *   +1751 ms  fejléc, lejátszó, OSD, oldalsáv, mappasáv, csatornalista a DOM-ban
 *   +2110 ms  KÉPERNYŐ: takarókép=fent; videó kész=0, áll
 *   +9257 ms  INDULÁS: főoldal kész és kirajzolva
 *   +10563 ms REVEAL – … (időtúllépés)
 *   +10668 ms LEGNAGYOBB TARTALOM: 11564 ms
 *
 * Az IPK üres volt: 0 szolgáltató, 0 csatorna. A megjelenítő mégis három
 * csatornasorra és az első videókockára várt, és csak a 9 mp-es kemény
 * időtúllépésnél ugrott elő a felület – ezt látta a felhasználó
 * „lassú, ugráló indulásnak”.
 *
 * Ez a teszt a main.tsx VALÓDI megjelenítési logikáját futtatja jsdom-ban
 * (a forrás releváns részét kivágva, TypeScript-ként transzformálva), így
 * nem egy másolatot, hanem a kiszállított döntési kódot ellenőrzi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let esbuild;
try {
  esbuild = createRequire(path.resolve(ROOT, 'web/package.json'))('esbuild');
} catch {
  esbuild = null;
}

/* ─────────────────────────── 1. szerkezeti őrök ─────────────────────────── */

test('üres indulás: az App megjelöli az indulás állapotát a takaróképnek', () => {
  const app = read('web/src/App.tsx');
  assert.match(app, /markBootState\('empty'\)/, 'az üres állapot nincs jelezve');
  assert.match(app, /markBootState\('content'\)/, 'a mentett tartalom nincs jelezve');
  assert.match(app, /data-iptv-boot/, 'hiányzik a megjelenítő által olvasott attribútum');
  assert.match(app, /let decided: BootState = 'empty'/,
    'a tároló-próba elakadásakor nincs biztos döntés');
  assert.match(app, /providers\.length === 0[\s\S]{0,900}setLiveRecoveryNeeded\(false\)/,
    'üres IPK-nál továbbra is indulhatna hálózati letöltés');
  assert.match(app, /üres alkalmazás – nincs szolgáltató/,
    'a napló nem jelzi egyértelműen az üres indulást');
});

test('üres indulás: a csatornalista üres állapota felismerhető DOM-jel', () => {
  const list = read('web/src/components/ChannelList.tsx');
  assert.match(list, /data-boot-empty=""/, 'hiányzik az üres állapot DOM-jele');
  assert.match(list, /Nincs betöltött csatorna/, 'az üres állapot szövege eltűnt');
});

test('üres indulás: a megjelenítő nem vár videóra, és nem pörög végtelenül', () => {
  const main = read('web/src/main.tsx');
  assert.match(main, /if \(emptyBoot\(\)\) return true;/,
    'üres állapotban a videó első képkockájára várna');
  assert.match(main, /if \(emptyBoot\(\)\) \{[\s\S]{0,220}revealWhenPainted\("üres alkalmazás/,
    'nincs azonnali, külön üres megjelenítési út');
  /*
   * 2.5.153: a képkocka-őr NEM halaszt. A 41–44. napló bizonyítja, hogy a
   * hiányzó képkocka a videó-indítás miatt van (a JS közben fut), ezért a
   * váltás halasztása csak 1–3 mp-et tett a felfedésre. A képkockára
   * legfeljebb 350 ms-ot várunk.
   */
  assert.match(main, /const REVEAL_PAINT_TIMEOUT_MS = 350;/,
    'a képkocka-várakozás nincs időhöz kötve – a felfedés percekig csúszhat');
  assert.doesNotMatch(main, /MAX_FRAME_GAP_RETRIES/,
    'a régi, halasztó képkocka-őr visszatért');
  assert.match(main, /const revealWhenPainted = /,
    'több párhuzamos megjelenítési lánc indulhat');
  assert.match(main, /elapsed > 3500 && chromeReady\(\) && bootState\(\) === "checking"/,
    'hiányzik a 3,5 mp-es gyors biztonsági háló');
  // A régi 9 mp-es kemény korlát maradjon meg végső hálónak (más tesztek is keresik).
  assert.match(main, /revealNow\("időtúllépés"\)/, 'a végső biztonsági háló eltűnt');
});

test('üres indulás: a diagnosztika nem dolgozik az első festés alatt', () => {
  const diag = read('web/src/services/startupDiagnostics.ts');
  assert.match(diag, /scheduleSlowStartupProbes\(\)/,
    'a localStorage-próba és a videó-próba ismét a React elé kerülne');
  assert.match(diag, /age < 15000 \? 500 : 1000/,
    'a képernyő-mintavétel visszaállt 250 ms-ra');
  assert.match(diag, /MAX_PENDING/, 'a mutációk kötegelése hiányzik');
  assert.match(diag, /runSlowStartupProbes\(\);[\s\S]{0,80}running = false/,
    'gyors napló-lezáráskor elveszhetnek a halasztott sorok');
});

test('üres indulás: a webOS híd nem épít rejtett diagnosztikai dobozt', () => {
  const webos = read('webos/webos.js');
  const fn = webos.slice(webos.indexOf('function diagUiCheck()'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 5);
  assert.doesNotMatch(body, /diagEnsure\(\)/,
    'a felület-őr ismét létrehozza a 6 elemű rejtett dobozt induláskor');
  assert.match(body, /diag\.uiLoaded = true/, 'a felület-őr nem észleli a kész UI-t');
  assert.ok(webos.includes("if (document.querySelector('[data-boot-empty]')) return;"),
    'az üres IPK-n a fókusz-próba továbbra is négyszer járja be a DOM-ot');
});

test('üres indulás: a futó verzió és az IPK verziója megegyezik', () => {
  const version = read('web/src/appVersion.ts');
  const match = version.match(/export const WEB_VERSION = '([^']+)';/);
  assert.ok(match, 'hiányzik a WEB_VERSION konstans');
  const appinfo = JSON.parse(read('webos/appinfo.json'));
  assert.equal(appinfo.version, match[1],
    'a webOS appinfo.json verziója eltér a futó alkalmazásétól');
});

/* ─────────────────── 2. a VALÓDI megjelenítési logika ──────────────────── */

/**
 * A main.tsx megjelenítési blokkja (a React mount UTÁNI rész) TS-ként
 * transzformálva, egy ellenőrizhető jsdom-környezetbe töltve.
 *
 * A blokk csak a DOM-ot, a window-t, a Date/performance órát és három
 * naplózó segédfüggvényt használ – ezeket mind mi adjuk át, így a kód
 * változtatás nélkül, a maga valójában fut le.
 */
async function bootRevealHarness({
  bootState, video = true, emptyMarker = true, rows = 0, dialog = false, stream = null,
  liveReady = true,
} = {}) {
  if (!esbuild) return null;
  const source = read('web/src/main.tsx');
  const from = source.indexOf('  const startedAt = Date.now();');
  const to = source.lastIndexOf('\n} catch (e) {');
  assert.ok(from > 0 && to > from, 'a megjelenítési blokk nem vágható ki a main.tsx-ből');
  const slice = source.slice(from, to);
  // A blokkban nincs JSX – a React mount és az ErrorBoundary a vágás előtt van.
  assert.doesNotMatch(slice, /<div|<button|<StrictMode/, 'a kivágott blokkba JSX került');

  const { code } = await esbuild.transform(slice, {
    loader: 'ts',
    target: 'es2019',
  });

  const html = read('web/index.html');
  const dom = new JSDOM(html, {
    url: 'https://tv.local/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  const doc = window.document;

  // A 12 mp-es HTML biztonsági háló nem sülhet el a teszt alatt.
  const revealReasons = [];
  const realReveal = window.__IPTV_REVEAL__;
  window.__IPTV_REVEAL__ = (reason) => {
    revealReasons.push(String(reason));
    try { realReveal(reason); } catch { /* a HTML rétege hibázott */ }
  };

  if (bootState) doc.documentElement.setAttribute('data-iptv-boot', bootState);
  if (stream) doc.documentElement.setAttribute('data-iptv-stream', stream);
  /*
   * 2.5.145: a felfedés megvárja a teljes élő lista visszatöltését (az App a
   * `__IPTV_LIVE_READY__` jelzővel tudatja). A próbák alapból kész
   * állapotot szimulálnak; külön próba nézi a várakozást.
   */
  if (liveReady) window.__IPTV_LIVE_READY__ = true;

  const root = doc.getElementById('root');
  root.innerHTML = '<header></header><div data-tv-folders=""></div>';
  const list = doc.createElement('div');
  list.setAttribute('role', 'listbox');
  for (let index = 0; index < rows; index += 1) {
    const row = doc.createElement('div');
    row.setAttribute('role', 'option');
    list.appendChild(row);
  }
  if (emptyMarker) {
    const empty = doc.createElement('div');
    empty.setAttribute('data-boot-empty', '');
    list.appendChild(empty);
  }
  root.appendChild(list);
  if (video) {
    const player = doc.createElement('video');
    player.setAttribute('data-iptv-player', 'true');
    // NINCS __IPTV_VIDEO_READY__: üres IPK-n soha nem jön első képkocka.
    root.appendChild(player);
  }
  if (dialog) {
    const box = doc.createElement('div');
    box.setAttribute('role', 'dialog');
    root.appendChild(box);
  }

  let clock = 1_700_000_000_000;
  const fakeDate = { now: () => clock };
  // Cserélhető nagy felbontású óra: így a képkocka-őr kipróbálható valódi
  // várakozás nélkül, a window.performance megváltoztatása nélkül.
  let perfNow = () => window.performance.now();
  const fakePerformance = { now: () => perfNow() };
  const phases = [];
  const stages = [];
  const failures = [];
  /*
   * A main.tsx a betöltőképernyő-hídon jelenti a VALÓS lépéseket. A kivágott
   * blokk nem importálhat, ezért a híd függvényeit is átadjuk neki – így a
   * teszt a kiszállított döntési kódot futtatja, a hívást pedig rögzíti.
   */
  const boot = [];
  const bootBridge = {
    start: (version) => boot.push(['start', version]),
    phase: (name, detail) => boot.push(['phase', name, detail]),
    detail: (text) => boot.push(['detail', text]),
    /*
     * 2.5.160: a betöltőképernyő 100%-a LÁTSZIK, és csak utána jön a felfedés:
     * a HTML-oldali complete() a visszahívásra értesít. A híd itt ugyanazt a
     * sorrendet utánozza (rövid, 60 ms-os késleltetéssel – a valódi animáció
     * 240 ms, a tesztek 200 ms-os lépéseihez igazítva).
     */
    complete: () => {
      boot.push(['complete']);
      setTimeout(() => {
        try {
          if (typeof window.__IPTV_BOOT_DONE_CB__ === 'function') window.__IPTV_BOOT_DONE_CB__();
        } catch { /* a teszt-híd hibája nem akadály */ }
      }, 60);
    },
  };
  const context = {
    document: doc,
    window,
    Date: fakeDate,
    performance: fakePerformance,
    MutationObserver: window.MutationObserver,
    console,
    logPhase: (message) => phases.push(String(message)),
    stage: (n, label) => stages.push(`${n}:${label}`),
    fail: (message) => failures.push(String(message)),
    bootScreenStart: bootBridge.start,
    bootScreenPhase: bootBridge.phase,
    bootScreenDetail: bootBridge.detail,
    bootScreenComplete: bootBridge.complete,
  };

  const factory = new Function(
    ...Object.keys(context),
    `${code}\n; return { checkRendered, get revealed() { return revealed; }, get pending() { return revealPending; }, get paintFallbacks() { return paintFallbacks; } };`
  );
  const runtime = factory(...Object.values(context));

  return {
    dom,
    window,
    doc,
    runtime,
    revealReasons,
    phases,
    stages,
    failures,
    boot,
    advance: (ms) => { clock += ms; },
    setPerfNow: (fn) => { perfNow = fn; },
    tick: (ms = 90) => new Promise((resolve) => setTimeout(resolve, ms)),
    close: () => dom.window.close(),
  };
}

test('üres IPK: a kész felület azonnal megjelenik, videó és csatornasorok nélkül is', async (t) => {
  const h = await bootRevealHarness({ bootState: 'empty', rows: 0, video: true, emptyMarker: true });
  if (!h) { t.skip('esbuild hiányzik'); return; }
  try {
    // Nincs __IPTV_VIDEO_READY__, nincs egyetlen [role=option] sem.
    assert.equal(h.window.__IPTV_VIDEO_READY__, undefined);
    assert.equal(h.doc.querySelectorAll('[role="option"]').length, 0);

    h.runtime.checkRendered();
    await h.tick(200);

    assert.equal(h.revealReasons.length, 1, 'a takarókép nem tűnt el egyetlen váltással');
    assert.match(h.revealReasons[0], /üres alkalmazás/, 'nem az üres, gyors út futott');
    assert.equal(h.window.__IPTV_APP_READY__, true, 'a webOS felület-őr nem kapott kész jelet');
    assert.equal(h.failures.length, 0, 'indulási hiba keletkezett');
    assert.doesNotMatch(h.doc.documentElement.className, /iptv-booting/);
    assert.match(h.doc.documentElement.className, /iptv-revealed/);

    // A 9 mp-es időtúllépés NEM sült el: még 8 mp elteltével sem történik új reveal.
    h.advance(8000);
    h.runtime.checkRendered();
    await h.tick(50);
    assert.equal(h.revealReasons.length, 1, 'többször is megjelent a felület (ugrálás)');
  } finally {
    h.close();
  }
});

/*
 * 2.5.131 – A „NAGY FELVILLANÁS” JAVÍTÁSA.
 * A 22:32:49-es napló: REVEAL +2770 ms, de a legnagyobb tartalom csak
 * +3602 ms-nál festődött ki (közte 600 ms főszál-leállás). A #root
 * `visibility: hidden` volt, ezért a teljes felület csak a takarókép
 * levétele UTÁN lett kifestve. Most az előfestés a takarókép ALATT fut.
 */
test('a főoldal MÉG a takarókép alatt kifestésre kerül (nincs felvillanás)', async (t) => {
  const h = await bootRevealHarness({ bootState: 'empty', rows: 0, video: true, emptyMarker: true });
  if (!h) { t.skip('esbuild hiányzik'); return; }
  try {
    let prepareCalls = 0;
    const realPrepare = h.window.__IPTV_PREPARE_REVEAL__;
    assert.equal(typeof realPrepare, 'function', 'hiányzik a HTML előfestő híd');
    h.window.__IPTV_PREPARE_REVEAL__ = (...args) => {
      prepareCalls += 1;
      return realPrepare(...args);
    };

    // A DOM kész, de a tároló-próba még nem döntött: a megjelenítő ilyenkor
    // azonnal előfest, és a takaróképet FENT tartja.
    h.runtime.checkRendered();
    assert.ok(prepareCalls >= 1, 'a főoldal nem lett előfestve a takarókép alatt');
    assert.equal(h.window.__IPTV_PREPARED__, true, 'a HTML nem jegyezte meg az előfestést');
    assert.match(h.doc.documentElement.className, /iptv-prerender/);
    assert.equal(h.window.getComputedStyle(h.doc.getElementById('root')).visibility, 'visible',
      'a #root az előfestés után is rejtve maradt');
    assert.ok(h.doc.getElementById('tv-curtain'),
      'az előfestés alatt a takaróképnek fent kell maradnia');

    await h.tick(200);
    assert.equal(h.revealReasons.length, 1, 'a takarókép nem tűnt el');
    // 2.5.135: a takarókép 200 ms alatt halványul el; a transitionend
    // (vagy a 240 ms-os biztonsági időzítő) után kerül ki a DOM-ból.
    h.window.__IPTV_FINISH_REVEAL__?.();
    assert.equal(h.doc.getElementById('tv-curtain'), null);
    assert.match(h.doc.documentElement.className, /iptv-prerender/,
      'a megjelenés után a #root véletlenül újra rejtve lenne');
    assert.match(h.doc.documentElement.className, /iptv-revealed/);
    assert.equal(h.failures.length, 0);
  } finally {
    h.close();
  }
});

test('üres IPK: a megjelenés a 3,5 mp-es gyors hálónál sem később, ha a tár-próba elakad', async (t) => {
  const h = await bootRevealHarness({ bootState: 'checking', rows: 0, video: true, emptyMarker: false });
  if (!h) { t.skip('esbuild hiányzik'); return; }
  try {
    h.runtime.checkRendered();          // t=0: még "checking", nem jelenik meg
    await h.tick(90);
    assert.equal(h.revealReasons.length, 0, 'a felület a tároló-próba előtt megjelent');

    h.advance(3600);
    h.runtime.checkRendered();
    await h.tick(200);
    assert.equal(h.revealReasons.length, 1, 'a 3,5 mp-es gyors háló nem lépett életbe');
    assert.match(h.revealReasons[0], /gyors indulás/, 'nem a gyors indulási ok került a naplóba');
    assert.equal(h.failures.length, 0);
  } finally {
    h.close();
  }
});

test('mentett tartalomnál marad a régi, kész-listára váró viselkedés', async (t) => {
  const h = await bootRevealHarness({ bootState: 'content', rows: 0, video: true, emptyMarker: false });
  if (!h) { t.skip('esbuild hiányzik'); return; }
  try {
    h.runtime.checkRendered();
    await h.tick(200);
    assert.equal(h.revealReasons.length, 0,
      'mentett tartalom jelzése mellett félkész (üres) listát mutatnánk');
    assert.equal(h.failures.length, 0);
  } finally {
    h.close();
  }
});

test('a képkocka-kihagyás NEM halasztja el a megjelenítést (2.5.153)', async (t) => {
  const h = await bootRevealHarness({ bootState: 'empty', rows: 0, video: true, emptyMarker: true });
  if (!h) { t.skip('esbuild hiányzik'); return; }
  try {
    /*
     * A 41–44. napló: a videó elindulásakor a TV 1,2–3,9 mp-ig nem ad
     * képkockát, miközben a JavaScript fut. A régi őr ezt „foglalt szálnak”
     * látta, és elhalasztotta a takarókép levételét (6,5 mp-es felfedés).
     * Mostantól a nagy képkocka-kihagyás csak naplózás: a váltás megtörténik.
     */
    let value = 0;
    h.setPerfNow(() => { value += 500; return value; });
    h.runtime.checkRendered();
    await h.tick(500);

    assert.equal(h.revealReasons.length, 1,
      'a képkocka-kihagyás miatt a felület nem jelent meg időben');
    assert.ok(h.phases.some((line) => /képkocka-kihagyás/.test(line)),
      'a kihagyás ténye nem került a naplóba');
    assert.equal(h.failures.length, 0);
  } finally {
    h.close();
  }
});

/*
 * 2.5.139 – A BETÖLTŐKÉPERNYŐ VALÓS ADATOKKAL.
 *
 * A régi képernyő előre rajzolt főoldali váz volt (skeleton). Az új a
 * takarokep.jpg teljes hátterét mutatja, a jobb felső sarokban a TV valós
 * rendszeridejével, a százalékot/csatornaszámot/sebességet/hátralévő időt
 * pedig KIZÁRÓLAG az alkalmazás jelentheti. Ezek a tesztek azt zárják ki,
 * hogy a képernyő magától „szimuláljon” egy betöltést.
 */
test('a betöltőképernyő a valós lépéseket kapja, és a kész felületnél zárul', async (t) => {
  const h = await bootRevealHarness({ bootState: 'empty', rows: 0, video: true, emptyMarker: true });
  if (!h) { t.skip('esbuild hiányzik'); return; }
  try {
    h.runtime.checkRendered();
    await h.tick(200);

    const names = h.boot.map((entry) => entry[0]);
    assert.ok(names.includes('phase'), 'a main.tsx nem jelentett egyetlen valós szakaszt sem');
    assert.ok(names.includes('complete'), 'a 100% nem a kész felületnél állt be');
    // A 100% a REVEAL előtt, ugyanabban a pillanatban történik.
    const completeAt = h.boot.findIndex((entry) => entry[0] === 'complete');
    assert.equal(h.boot.slice(completeAt + 1).filter((entry) => entry[0] === 'complete').length, 0,
      'a befejezés többször futott le');
    assert.equal(h.revealReasons.length, 1);
    assert.ok(!h.boot.some((entry) => entry[0] === 'start'),
      'a kivágott megjelenítési blokk nem indíthat új betöltési munkamenetet');
  } finally {
    h.close();
  }
});

test('nincs lejátszandó stream: nem várunk az első videókockára', async (t) => {
  /*
   * Van csatornalista és van <video> elem, de az App azt jelzi, hogy nincs
   * aktív stream (data-iptv-stream="none"): ilyenkor az első képkocka soha
   * nem jönne el, ezért a kész felületnek AZONNAL meg kell jelennie.
   */
  const h = await bootRevealHarness({
    bootState: 'content', rows: 4, video: true, emptyMarker: false, stream: 'none',
  });
  if (!h) { t.skip('esbuild hiányzik'); return; }
  try {
    assert.equal(h.window.__IPTV_VIDEO_READY__, undefined);
    h.runtime.checkRendered();
    await h.tick(200);
    assert.equal(h.revealReasons.length, 1, 'a takarókép hiába várt a nem létező videókockára');
    assert.match(h.revealReasons[0], /kész főoldal/);
    assert.equal(h.failures.length, 0);
  } finally {
    h.close();
  }
});

test('a felfedés NEM vár a teljes (20 190 csatornás) listára', async (t) => {
  /*
   * 2.5.149 – AZ INDULÁS LEGNAGYOBB LASSÍTÓJA.
   *
   * A 28–30. napló: a teljes élő lista dekódolása 3 mp, az alkalmazás
   * 1,5 mp-re fagyott tőle – mindkettő a takarókép ALATT, ezért a felfedés
   * csak 7–10 mp-nél történt meg. A látható felület (fejléc, csatornalista az
   * induló készlettel, lejátszó) viszont enélkül is kész: a takarókép
   * lemehet, a teljes lista pedig a kész felület fölött érkezik.
   */
  const h = await bootRevealHarness({
    bootState: 'content', rows: 4, video: true, emptyMarker: false, stream: 'none', liveReady: false,
  });
  if (!h) { t.skip('esbuild hiányzik'); return; }
  try {
    h.runtime.checkRendered();
    await h.tick(200);
    assert.equal(h.revealReasons.length, 1,
      'a takarókép hiába vár a teljes listára (ettől lett 7–10 mp az indulás)');
    assert.match(h.revealReasons[0], /kész főoldal/);
    assert.equal(h.window.__IPTV_LIVE_READY__, undefined,
      'a próba szerint a lista még nem készült el – a felfedés mégis megtörtént');
  } finally {
    h.close();
  }
});

test('a főoldal jelzése (iptv-app-ready) a felfedés UTÁN megy ki', async (t) => {
  /*
   * Az App ebből a jelzésből indítja a teljes lista visszatöltését, ezért a
   * jelnek a felfedés UTÁN kell kiménnie – különben a 3 mp-es dekódolás
   * ismét a takarókép alá esne.
   */
  const h = await bootRevealHarness({
    bootState: 'content', rows: 4, video: true, emptyMarker: false, stream: 'none', liveReady: true,
  });
  if (!h) { t.skip('esbuild hiányzik'); return; }
  try {
    const order = [];
    h.window.addEventListener('iptv-app-ready', () => order.push('app-ready'));
    const original = h.window.__IPTV_REVEAL__;
    h.window.__IPTV_REVEAL__ = (reason) => { order.push('reveal'); original(reason); };
    h.runtime.checkRendered();
    await h.tick(200);
    assert.deepEqual(order, ['reveal', 'app-ready'],
      'a háttérmunka jelzése a felfedés ELŐTT ment ki (a lista a takarókép alá esne)');
  } finally {
    h.close();
  }
});

test('elakadt felületnél is lekerül a takarókép a korláton belül', async (t) => {
  const h = await bootRevealHarness({
    bootState: 'content', rows: 4, video: true, emptyMarker: false, stream: 'none', liveReady: false,
  });
  if (!h) { t.skip('esbuild hiányzik'); return; }
  try {
    // A fejléc hiányzik: a normál felfedés nem indulhat el, a 9 mp-es
    // biztonsági háló viszont akkor is leveszi a takaróképet.
    const header = h.window.document.querySelector('#root header');
    header.parentNode.removeChild(header);
    h.runtime.checkRendered();
    await h.tick(100);
    assert.equal(h.revealReasons.length, 0, 'hiányzó fejlécnél sem szabad felfedni');
    h.advance(9600);
    h.runtime.checkRendered();
    await h.tick(200);
    assert.equal(h.revealReasons.length, 1, 'a felfedés örökre várt volna');
  } finally {
    h.close();
  }
});

test('az App a valós stream-állapotot jelzi a megjelenítőnek', () => {
  const app = read('web/src/App.tsx');
  assert.match(app, /document\.documentElement\.setAttribute\('data-iptv-stream'/,
    'hiányzik a lejátszandó stream valós jelzője');
  assert.match(app, /const hasStream = !!\(customStreamUrl \|\| activeChannel\)/,
    'a stream-jelző nem a tényleges csatornából/stream-címből származik');
  const main = read('web/src/main.tsx');
  assert.match(main, /if \(streamState\(\) === "none"\) return true;/,
    'a videó-kész állapot nem veszi figyelembe, hogy nincs mit lejátszani');
});
