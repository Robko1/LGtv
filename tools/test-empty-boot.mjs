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
  assert.match(main, /MAX_FRAME_GAP_RETRIES = 2/,
    'a képkocka-őr ismét végtelenül halogathatja a megjelenést');
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

test('üres indulás: a verzió mindkét helyen 2.5.129', () => {
  assert.match(read('web/src/appVersion.ts'), /export const WEB_VERSION = '2\.5\.129';/);
  assert.match(read('webos/appinfo.json'), /"version": "2\.5\.129"/);
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
async function bootRevealHarness({ bootState, video = true, emptyMarker = true, rows = 0, dialog = false } = {}) {
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
  };

  const factory = new Function(
    ...Object.keys(context),
    `${code}\n; return { checkRendered, get revealed() { return revealed; }, get pending() { return revealPending; }, get retries() { return frameGapRetries; } };`
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

test('a képkocka-őr legfeljebb kétszer halaszt, utána mindenképp megjelenik', async (t) => {
  const h = await bootRevealHarness({ bootState: 'empty', rows: 0, video: true, emptyMarker: true });
  if (!h) { t.skip('esbuild hiányzik'); return; }
  try {
    // 400 ms-nál nagyobb képkocka-kihagyás szimulálása: a két rAF között
    // ugrik a nagy felbontású óra. A 9 mp-es kemény korlátot nem használjuk:
    // a MAX_FRAME_GAP_RETRIES önmagában is beengedi a megjelenést.
    let value = 0;
    h.setPerfNow(() => { value += 500; return value; });
    h.runtime.checkRendered();
    await h.tick(500);

    assert.equal(h.revealReasons.length, 1,
      'a képkocka-őr miatt a felület nem jelent meg időben');
    assert.ok(h.runtime.retries <= 2, 'a képkocka-őr kettőnél többször halasztott');
    assert.equal(h.failures.length, 0);
  } finally {
    h.close();
  }
});
