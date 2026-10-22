#!/usr/bin/env node
/*
 * A TV-s navigáció és a takarékép TESZTJE – valódi DOM-mal.
 *
 * A `webos/webos.js` a capture-fázisban futó, ES5 billentyűkezelő, ami a
 * távirányító navigációt végzi. Korábban a tesztek ezt kihagyták, ezért
 * maradt észrevétlen, hogy a mappasávból lefelé a TELJES LISTADOBOT
 * jelöli ki (az első csatorna kimarad). Itt jsdom-ban, a valódi
 * webos.js-t futtatva ellenőrizzük a viselkedést.
 *
 * Futtatás:  node --test tools/test-tv-navigation.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBOS_JS = fs.readFileSync(path.join(ROOT, 'webos/webos.js'), 'utf8');

/* A főoldal váza: fejléc (Beállítások), kedvencek mappasáv, 9 csatornasor. */
function homeDom({ folders = true, channels = 9 } = {}) {
  const folderButtons = folders
    ? '<button data-tv-folder="" tabindex="0">📁 Kedvencek</button>'
    : '';
  const rows = Array.from({ length: channels }, (_, i) => `
      <div data-channel-id="ch-${i}">
        <div role="option" tabindex="0">${i + 1}. Csatorna ${i + 1}</div>
      </div>`).join('');
  const html = `<!doctype html><html><head></head><body class="webos-tv">
    <header>
      <button data-tv-header="" data-tv-header-kind="series" tabindex="0">Sorozat</button>
      <button data-tv-header="" data-tv-header-kind="movies" tabindex="0">Mozi</button>
      <button data-tv-header="" data-tv-header-kind="countries" tabindex="0">Országok</button>
      <button data-tv-header="" data-tv-header-default="" data-tv-header-kind="settings" tabindex="0">Menü</button>
    </header>
    <div data-tv-folders="">${folderButtons}</div>
    <div role="listbox" aria-label="Csatornalista">${rows}</div>
    <div id="root"></div>
  </body></html>`;

  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: 'https://tv.local/', runScripts: 'dangerously', virtualConsole });
  // A webos.js a fejlesztői diagnosztikát is felépíti; a jsdom-ban nincs paint.
  dom.window.eval(WEBOS_JS);
  // A jsdom a DOMContentLoaded-et már az eval ELŐTT kiváltotta, ezért az
  // onReady (a TV-s CSS injektálása) nem futott le – itt pótoljuk.
  if (!dom.window.document.getElementById('webos-tv-fix-css')) {
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  }
  return dom;
}

function press(window, key, keyCode) {
  const event = new window.KeyboardEvent('keydown', {
    key, keyCode, bubbles: true, cancelable: true,
  });
  (window.document.activeElement || window.document.body).dispatchEvent(event);
  return event;
}

test('3. Beállítások → lefelé: a Kedvencek mappa kapja a kijelölést', () => {
  const dom = homeDom();
  const { window } = dom;
  try {
    const settings = window.document.querySelector('[data-tv-header-kind="settings"]');
    settings.focus();
    press(window, 'ArrowDown', 40);
    const active = window.document.activeElement;
    assert.equal(active.hasAttribute('data-tv-folder'), true, `a mappa kapja a fókuszt, nem: ${active.tagName}`);
  } finally { dom.window.close(); }
});

test('3. Kedvencek mappából lefelé az ELSŐ CSATORNASOR kapja a kijelölést', () => {
  const dom = homeDom();
  const { window } = dom;
  try {
    const folder = window.document.querySelector('[data-tv-folder]');
    folder.focus();
    press(window, 'ArrowDown', 40);
    const active = window.document.activeElement;
    assert.equal(active.getAttribute('role'), 'option', 'csatornasorra kell lépni');
    assert.equal(active.textContent.trim(), '1. Csatorna 1', 'az ELSŐ csatornának kell kijelölve lennie');
  } finally { dom.window.close(); }
});

test('3. a teljes csatornalista doboza SOHA nem kap fókuszt (mappa nélkül sem)', () => {
  const dom = homeDom({ folders: false });
  const { window } = dom;
  try {
    const settings = window.document.querySelector('[data-tv-header-kind="settings"]');
    settings.focus();
    press(window, 'ArrowDown', 40);
    const active = window.document.activeElement;
    assert.notEqual(active.getAttribute('role'), 'listbox', 'a doboz nem jelölhető ki');
    assert.equal(active.getAttribute('role'), 'option', 'az első csatornasor a kijelölés');
    assert.equal(window.document.querySelector('[role="listbox"]').hasAttribute('tabindex'), false,
      'a doboz nem kaphat tabindexet');
  } finally { dom.window.close(); }
});

test('3. fókusz nélküli első gombnyomás sem a dobozt jelöli ki', () => {
  const dom = homeDom();
  const { window } = dom;
  try {
    // A webOS néha a body-n hagyja a fókuszt.
    window.document.body.focus();
    press(window, 'ArrowDown', 40);
    const active = window.document.activeElement;
    assert.equal(active.getAttribute('role'), 'option');
    assert.equal(window.document.querySelector('[role="listbox"]').hasAttribute('tabindex'), false);
  } finally { dom.window.close(); }
});

test('3. a csatornasorok kijelölője SÁRGA (a kék nem maradhat)', () => {
  const dom = homeDom();
  try {
    const css = dom.window.document.getElementById('webos-tv-fix-css').textContent;
    const optionRule = css.slice(css.indexOf('[role="option"]:focus'));
    assert.match(optionRule.slice(0, 260), /outline:3px solid #fbbf24/, 'a sor kijelölője sárga');
    assert.doesNotMatch(optionRule.slice(0, 260), /#06b6d4/, 'a kék kijelölő nem maradhat a sorokon');
  } finally { dom.window.close(); }
});

test('3. a fejléc és a mappák kijelölője is sárga marad', () => {
  const dom = homeDom();
  try {
    const css = dom.window.document.getElementById('webos-tv-fix-css').textContent;
    assert.match(css, /\[data-tv-folder\]:focus \{ outline:3px solid #fbbf24/);
    assert.match(css, /header \[data-tv-header\]:focus[^{]*\{[^}]*#fbbf24/);
  } finally { dom.window.close(); }
});
