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

test('3. a fejléc balra-jobbra navigáció a tényleges képernyősorrendet követi', () => {
  const dom = homeDom();
  const { window } = dom;
  try {
    const doc = window.document;
    const positions = {
      settings: 100,
      movies: 200,
      series: 300,
      countries: 400,
    };
    for (const [kind, left] of Object.entries(positions)) {
      const el = doc.querySelector('[data-tv-header-kind="' + kind + '"]');
      el.getBoundingClientRect = () => ({ left, width: 80, right: left + 80, top: 0, bottom: 40, height: 40 });
    }
    const exit = doc.createElement('button');
    exit.setAttribute('data-tv-header', '');
    exit.setAttribute('data-tv-header-kind', 'exit');
    exit.textContent = 'X';
    exit.getBoundingClientRect = () => ({ left: 500, width: 40, right: 540, top: 0, bottom: 40, height: 40 });
    doc.querySelector('header').appendChild(exit);

    const movies = doc.querySelector('[data-tv-header-kind="movies"]');
    movies.focus();
    press(window, 'ArrowRight', 39);
    assert.equal(doc.activeElement.getAttribute('data-tv-header-kind'), 'series',
      'jobbra a képernyőn következő gomb kapja a fókuszt, nem a DOM-sorrend szerinti');

    const series = doc.querySelector('[data-tv-header-kind="series"]');
    press(window, 'ArrowLeft', 37);
    assert.equal(doc.activeElement.getAttribute('data-tv-header-kind'), 'movies',
      'balra a képernyőn előző gomb kapja a fókuszt');
  } finally { dom.window.close(); }
});

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

/* ────────────────── Teljes képernyő: csatornaváltás ────────────────── */

/*
 * A TV / Mozi / Sorozat nézetek és a csatornalista az azonnali váltás miatt
 * a DOM-ban marad (csak `visibility: hidden` + `data-view-hidden`). A 2.5.13-as
 * kiadásban ezért tört el a teljes képernyős csatornaváltás: a CH+/CH- és a
 * nyilak a REJTETT listára mentek, a láthatatlan kijelölés mozgott, a csatorna
 * nem váltott. Ezek a próbák ezt zárják ki.
 */
function fullscreenDom({ listHidden = true, playerFixed = true } = {}) {
  const rows = Array.from({ length: 5 }, (_, i) => `
      <div data-channel-id="ch-${i}">
        <div role="option" tabindex="0">${i + 1}. Csatorna ${i + 1}</div>
      </div>`).join('');
  const listStyle = listHidden ? ' style="visibility:hidden" data-view-hidden=""' : '';
  const playerClass = playerFixed ? 'fixed' : '';
  const html = `<!doctype html><html><head></head><body class="webos-tv">
    <header><button data-tv-header="" data-tv-header-default="" tabindex="0">Menü</button></header>
    <div data-view-pane="live"><div${listStyle} data-list-host>
      <div role="listbox" aria-label="Csatornalista" data-selected-id="ch-0">${rows}</div>
    </div></div>
    <div data-tv-player="" class="${playerClass}" tabindex="0" id="player"></div>
    <div id="root"></div>
  </body></html>`;
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: 'https://tv.local/', runScripts: 'dangerously', virtualConsole });
  dom.window.eval(WEBOS_JS);
  if (!dom.window.document.getElementById('webos-tv-fix-css')) {
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  }
  return dom;
}

/**
 * A jsdom ablakát le kell zárni a próba végén: a webos.js saját időzítői
 * (óra, diagnosztika) különben életben tartják a Node folyamatot, és a
 * tesztfutás a végén "megáll".
 */
function withDom(options, run) {
  const dom = fullscreenDom(options);
  try {
    return run(dom);
  } finally {
    try { dom.window.close(); } catch { /* már zárva */ }
  }
}

function pressKey(dom, key, keyCode) {
  const { window } = dom;
  const event = new window.KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true });
  (window.document.activeElement || window.document.body).dispatchEvent(event);
}

test('5. teljes képernyőn a CH+ (PageUp) a LEJÁTSZÓHOZ megy, nem a rejtett listához', () => {
  withDom({}, (dom) => {
  const { window } = dom;
  const received = { player: [], rows: [] };
  window.document.getElementById('player').addEventListener('keydown', (e) => received.player.push(e.key));
  window.document.querySelectorAll('[role="option"]').forEach((row) => {
    row.addEventListener('keydown', (e) => received.rows.push(e.key));
  });
  window.document.body.focus();
  pressKey(dom, 'PageUp', 33);

  assert.deepEqual(received.rows, [], 'a rejtett csatornalista nem kaphat gombot');
  assert.deepEqual(received.player, ['ArrowUp'], 'a lejátszó FEL nyilat kap (csatornaváltás)');
  assert.equal(window.document.activeElement.id, 'player', 'a fókusz a teljes képernyős lejátszón van');
  });
});

test('5. teljes képernyőn a CH- (PageDown) is a lejátszóhoz kerül (LE nyíl)', () => {
  withDom({}, (dom) => {
  const { window } = dom;
  const received = { player: [], rows: [] };
  window.document.getElementById('player').addEventListener('keydown', (e) => received.player.push(e.key));
  window.document.querySelectorAll('[role="option"]').forEach((row) => {
    row.addEventListener('keydown', (e) => received.rows.push(e.key));
  });
  pressKey(dom, 'PageDown', 34);
  assert.deepEqual(received.rows, []);
  assert.deepEqual(received.player, ['ArrowDown']);
  });
});

test('5. teljes képernyőn a nyíl is a lejátszóhoz kerül (nem a rejtett listához)', () => {
  withDom({}, (dom) => {
  const { window } = dom;
  const received = { player: [], rows: [] };
  window.document.getElementById('player').addEventListener('keydown', (e) => received.player.push(e.key));
  window.document.querySelectorAll('[role="option"]').forEach((row) => {
    row.addEventListener('keydown', (e) => received.rows.push(e.key));
  });
  pressKey(dom, 'ArrowDown', 40);
  assert.deepEqual(received.rows, []);
  assert.deepEqual(received.player, ['ArrowDown']);
  });
});

test('5. a LÁTHATÓ csatornalista továbbra is a saját kezelőjét kapja (nem tört el a főoldal)', () => {
  withDom({ listHidden: false, playerFixed: false }, (dom) => {
  const { window } = dom;
  const received = { player: [], rows: [] };
  window.document.getElementById('player').addEventListener('keydown', (e) => received.player.push(e.key));
  window.document.querySelectorAll('[role="option"]').forEach((row) => {
    row.addEventListener('keydown', (e) => received.rows.push(e.key));
  });
  window.document.body.focus();
  pressKey(dom, 'ArrowDown', 40);
  assert.deepEqual(received.rows, ['ArrowDown'], 'a látható listán a nyíl a sort mozgatja');
  assert.deepEqual(received.player, [], 'a lejátszó nem kap gombot a főoldalon');
  });
});

test('5. rejtett lista mellett a fókusz nem kerülhet a rejtett sorokra', () => {
  withDom({}, (dom) => {
  const { window } = dom;
  window.document.body.focus();
  pressKey(dom, 'ArrowDown', 40);
  const active = window.document.activeElement;
  assert.ok(active && !active.closest('[data-view-hidden]'), 'a fókusz nem rejtett elemen marad');
  assert.equal(active.id, 'player');
  });
});

/* ─────────────── 6. Mozi / Sorozat nézet navigációja ─────────────── */

/*
 * A Mozi/Sorozat nézet a DOM-ban marad (a nem aktív nézetek display:none-t
 * kapnak). A fejléc „zóna” szabályai korábban MINDEN nézetben lefutottak és
 * `return`-öltek: a Mozi/Sorozat nézetben a LE nyíl nem csinált semmit, a
 * nézetben egyáltalán nem lehetett mozogni. Ezek a próbák azt rögzítik,
 * hogy a nyilak ott is a nézet vezérlőire visznek, és a rejtett
 * csatornalistára soha nem lépnek.
 */
function libraryDom({ view = 'movies', liveMounted = true } = {}) {
  const rows = Array.from({ length: 6 }, (_, i) => `
      <div data-channel-id="ch-${i}">
        <div role="option" tabindex="0">${i + 1}. Csatorna ${i + 1}</div>
      </div>`).join('');
  const livePane = liveMounted
    ? `<div data-view-pane="live" ${view === 'live' ? '' : 'data-view-hidden="" style="display:none"'}>
         <div role="listbox" aria-label="Csatornalista">${rows}</div>
       </div>`
    : '';
  const library = (name, title) => `
    <div data-view-pane="${name}" ${view === name ? '' : 'data-view-hidden="" style="display:none"'}>
      <button tabindex="0">Kategóriák</button>
      <div role="button" tabindex="0">${title} 1</div>
      <div role="button" tabindex="0">${title} 2</div>
    </div>`;
  const html = `<!doctype html><html><head></head><body class="webos-tv">
    <header>
      <button data-tv-header="" data-tv-header-kind="live" tabindex="0">TV</button>
      <button data-tv-header="" data-tv-header-kind="series" tabindex="0">Sorozat</button>
      <button data-tv-header="" data-tv-header-kind="movies" tabindex="0">Mozi</button>
      <button data-tv-header="" data-tv-header-default="" data-tv-header-kind="settings" tabindex="0">Menü</button>
    </header>
    <div data-view-pane="__none__" style="display:none"></div>
    ${livePane}
    ${library('movies', 'Film')}
    ${library('series', 'Sorozat')}
    <div id="root"></div>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://tv.local/', runScripts: 'dangerously', virtualConsole: new VirtualConsole() });
  dom.window.eval(WEBOS_JS);
  if (!dom.window.document.getElementById('webos-tv-fix-css')) {
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  }
  return dom;
}

test('6. Mozi nézetben a LE nyíl a fejlécből a NÉZET vezérlőire lép', () => {
  const dom = libraryDom({ view: 'movies' });
  try {
    const doc = dom.window.document;
    const movieButton = doc.querySelector('header [data-tv-header-kind="movies"]');
    movieButton.focus();
    const event = press(dom.window, 'ArrowDown', 40);
    assert.equal(event.defaultPrevented, true, 'a gombot a kezelő viszi');
    const active = doc.activeElement;
    assert.ok(active, 'van kijelölés');
    assert.equal(active.closest('[data-view-pane]')?.getAttribute('data-view-pane'), 'movies',
      'a fókusz a Mozi nézetben maradt');
    assert.equal(active.textContent.trim(), 'Kategóriák', 'a nézet első vezérlője');
  } finally {
    dom.window.close();
  }
});

test('6. Mozi nézetben body-fókusszal az első gombnyomás is működik', () => {
  const dom = libraryDom({ view: 'movies' });
  try {
    const doc = dom.window.document;
    doc.body.focus();
    press(dom.window, 'ArrowDown', 40);
    const active = doc.activeElement;
    assert.ok(active && active !== doc.body, 'a fókusz nem marad a body-n');
    assert.equal(active.closest('[data-view-pane]')?.getAttribute('data-view-pane'), 'movies');
  } finally {
    dom.window.close();
  }
});

test('6. a rejtett csatornalista SOHA nem kap fókuszt Mozi nézetben', () => {
  const dom = libraryDom({ view: 'movies' });
  try {
    const doc = dom.window.document;
    for (const [key, code] of [['ArrowDown', 40], ['ArrowUp', 38], ['ArrowLeft', 37], ['ArrowRight', 39]]) {
      press(dom.window, key, code);
      const active = doc.activeElement;
      assert.ok(!active?.closest?.('[data-view-pane="live"]'),
        `a rejtett csatornalistára nem lépett (${key})`);
      assert.ok(!active?.closest?.('[role="listbox"]'),
        `a rejtett listára nem lépett (${key})`);
    }
  } finally {
    dom.window.close();
  }
});

test('6. élő nézetben a fejléc LE nyila továbbra sem ugrik a listára (nincs regresszió)', () => {
  const dom = libraryDom({ view: 'live' });
  try {
    const doc = dom.window.document;
    const movieButton = doc.querySelector('header [data-tv-header-kind="movies"]');
    movieButton.focus();
    press(dom.window, 'ArrowDown', 40);
    assert.equal(doc.activeElement, movieButton,
      'élő nézetben a Mozi gombról lefelé nem lép (a korábbi viselkedés marad)');
  } finally {
    dom.window.close();
  }
});

test('6. a Sorozat nézet ugyanígy navigálható', () => {
  const dom = libraryDom({ view: 'series' });
  try {
    const doc = dom.window.document;
    doc.querySelector('header [data-tv-header-kind="movies"]').focus();
    press(dom.window, 'ArrowDown', 40);
    assert.equal(doc.activeElement?.closest('[data-view-pane]')?.getAttribute('data-view-pane'), 'series');
  } finally {
    dom.window.close();
  }
});

/* ───── 7. Rejtett ablak és rejtett nézet nem fogja el a távirányítót ───── */

test('7. a rejtett nézet ablaka (display:none) nem kapja meg a nyilakat', () => {
  const rows = '<div data-channel-id="ch-0"><div role="option" tabindex="0">1. Csatorna</div></div>';
  const html = `<!doctype html><html><head></head><body class="webos-tv">
    <header><button data-tv-header="" data-tv-header-kind="movies" tabindex="0">Mozi</button></header>
    <div data-view-pane="live" data-view-hidden="" style="display:none">
      <div role="listbox">${rows}</div>
      <div role="dialog" aria-label="Rejtett kérdés" data-iptv-dlgseq="99">
        <button tabindex="0">Törlés</button>
        <button tabindex="0">Mégse</button>
      </div>
    </div>
    <div data-view-pane="movies">
      <button tabindex="0">Kategóriák</button>
      <div role="button" tabindex="0">Film 1</div>
    </div>
    <div id="root"></div>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://tv.local/', runScripts: 'dangerously', virtualConsole: new VirtualConsole() });
  try {
    dom.window.eval(WEBOS_JS);
    if (!dom.window.document.getElementById('webos-tv-fix-css')) {
      dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    }
    const doc = dom.window.document;
    doc.querySelector('header button').focus();
    press(dom.window, 'ArrowDown', 40);
    const active = doc.activeElement;
    assert.equal(active?.closest('[data-view-pane]')?.getAttribute('data-view-pane'), 'movies',
      'a rejtett ablak nem foghatja el a navigációt');
    assert.notEqual(active?.textContent?.trim(), 'Törlés');
  } finally {
    dom.window.close();
  }
});
