#!/usr/bin/env node
/**
 * ÉLŐ HANGSÁV MENTÉSE CSATORNÁNKÉNT (2.5.376).
 *
 * A felhasználó kérése: a zöld gombos „Hangsáv / CC” ablak tetején legyen
 * MENTÉS gomb; a mentett hangsáv csatornaváltás és IPK-újraindítás után is
 * ugyanaz legyen. Ez a teszt ellenőrzi:
 *   1. a csatornánkénti tárolást (localStorage – az IPK újraindítást is túléli),
 *   2. a mentett bejegyzés és az aktuális sávlista összepárosítását,
 *   3. a MENTÉS gomb távirányítós elérését és működését az élő ablakban,
 *   4. hogy a lejátszó és az App valóban bekötötte a visszaállítást/mentést.
 *
 * Futtatás: node tools/test-live-audio-memory.mjs
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import assert from 'node:assert/strict';

const esbuild = createRequire(resolve('web/package.json'))('esbuild');
const built = await esbuild.build({
  entryPoints: [resolve('tools/fixtures/live-audio-harness.tsx')],
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  nodePaths: [resolve('web/node_modules')], define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => { throw error; });
const dom = new JSDOM('<!doctype html><html><body class="webos-tv"><div id="root"></div></body></html>',
  { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
const { window } = dom;
const doc = window.document;
window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
window.HTMLElement.prototype.scrollIntoView = function () {};

const script = doc.createElement('script');
script.textContent = built.outputFiles[0].text;
doc.body.appendChild(script);

const tick = (ms) => new Promise((done) => setTimeout(done, ms));
const api = window.audioMemTest;
assert.ok(api, 'a teszt-híd elérhető');

/* ─────────── 1. Tárolás csatornánként (újraindítást is túléli) ─────────── */

api.clearAudioMemory();
assert.equal(api.rememberedAudioFor('ch-1'), null);

const saved = api.rememberAudioFor('ch-1', { id: 2, name: 'Audio 2', lang: 'de-DE' });
assert.ok(saved, 'a mentés létrejön');
assert.equal(api.rememberedAudioFor('ch-1').lang, 'de-DE');
assert.equal(api.rememberedAudioFor('ch-1').name, 'Audio 2');
assert.equal(api.rememberedAudioFor('ch-2'), null, 'másik csatornára nem szivárog át');
assert.ok(api.rememberedAudioFor('ch-1').savedAt > 0);

// A tároló a localStorage-ban van: az IPK újraindítás (új betöltés) után is ott.
const rawKeys = Object.keys(window.localStorage);
assert.ok(rawKeys.some((key) => key.includes('live_audio_memory')),
  'a mentés a tartós localStorage-ba kerül');

// Felülírás: ugyanarra a csatornára az új választás él.
api.rememberAudioFor('ch-1', { id: 3, name: 'Angol', lang: 'eng' });
assert.equal(api.rememberedAudioFor('ch-1').lang, 'eng');

// Elfelejtés
api.forgetAudioFor('ch-1');
assert.equal(api.rememberedAudioFor('ch-1'), null);

/* ─────────── 2. Nyelv-egységesítés és összepárosítás ─────────── */

assert.equal(api.normalizeAudioLang('hu-HU'), 'hu');
assert.equal(api.normalizeAudioLang('HUN'), 'hu');
assert.equal(api.normalizeAudioLang('Magyar'), 'hu');
assert.equal(api.normalizeAudioLang('de-DE'), 'de');
assert.equal(api.normalizeAudioLang('Német'), 'de');

const tracks = [
  { id: 10, name: 'hu', lang: 'hu' },
  { id: 11, name: 'Audio 2', lang: 'de-DE' },
  { id: 12, name: 'Magyar 2', lang: 'hun' },
];
assert.equal(api.matchSavedAudioTrack(tracks, { lang: 'de', name: 'Audio 2' }).id, 11);
// Nyelv egyezik, de a név a biztosabb: két magyar sáv közül a mentett nevet választja.
assert.equal(api.matchSavedAudioTrack(tracks, { lang: 'hu', name: 'Magyar 2' }).id, 12);
// Nincs ilyen nyelv → név szerinti tartalék.
assert.equal(api.matchSavedAudioTrack(tracks, { lang: 'xx', name: 'Audio 2' }).id, 11);
// Semmi nem illik → null (a lejátszó ilyenkor nem erőltet váltást).
assert.equal(api.matchSavedAudioTrack(tracks, { lang: 'xx', name: 'Nincs ilyen' }), null);
assert.equal(api.matchSavedAudioTrack([], { lang: 'hu', name: 'hu' }), null);
assert.equal(api.savedAudioLabel({ lang: 'de', name: 'Audio 2' }), 'Audio 2');

/* ─────────── 3. A MENTÉS gomb az élő ablak tetején ─────────── */

const press = async (key) => {
  const code = { ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Enter: 13, Escape: 461 }[key];
  (doc.activeElement || doc.body).dispatchEvent(
    new window.KeyboardEvent('keydown', { key, keyCode: code, bubbles: true, cancelable: true }),
  );
  await tick(60);
};

api.show();
for (let i = 0; i < 80 && !doc.querySelector('[data-track-panel="live"]'); i++) await tick(20);
await tick(80);
assert.ok(doc.querySelector('[data-track-panel="live"]'), 'élő ablak megnyílt');

const saveButton = doc.querySelector('[data-save-audio]');
assert.ok(saveButton, 'MENTÉS gomb megjelenik a fejlécben');
const header = saveButton.closest('div[class*="border-b"]');
assert.ok(header && header.querySelector('h2'), 'a gomb a fejlécben, a cím mellett van');
assert.match(saveButton.textContent, /MENTÉS/);

// A hangsáv-lista legtetejéről FEL nyíllal a MENTÉS gombra lépünk.
await press('ArrowUp');
assert.equal(doc.activeElement, saveButton, 'FEL nyíllal a MENTÉS gombra lehet lépni');
assert.equal(saveButton.getAttribute('data-focused'), '1');

// LE nyíllal vissza a listára.
await press('ArrowDown');
assert.notEqual(doc.activeElement, saveButton, 'LE nyíllal visszatér a hangsáv-listára');

// A MENTÉS gomb megnyomása (távirányító OK) menti a kijelölt sávot, és az ablak nyitva marad.
await press('ArrowUp');
await press('Enter');
await tick(60);
assert.deepEqual([...api.calls.saved], ['1'], 'a kijelölt hangsáv mentődik');
assert.equal(api.calls.closed, 0, 'mentés után az ablak nem zárul be');
assert.match(doc.querySelector('[data-save-audio]').textContent, /MENTVE/);
assert.equal(doc.querySelector('[data-save-audio]').getAttribute('data-save-state'), 'saved');

// Egérrel/kattintással is működik.
api.show();
for (let i = 0; i < 80 && !doc.querySelector('[data-save-audio]'); i++) await tick(20);
await tick(60);
doc.querySelector('[data-save-audio]').click();
await tick(60);
assert.deepEqual([...api.calls.saved], ['1'], 'kattintásra is ment');

api.unmount();
window.close();

/* ─────────── 4. A lejátszó és az App bekötése ─────────── */

const player = readFileSync(resolve('web/src/components/VideoPlayer.tsx'), 'utf8');
assert.match(player, /matchSavedAudioTrack\(tvAudioTracks, saved\)/,
  'a lejátszó megkeresi a csatornához mentett hangsávot');
assert.match(player, /rememberedAudioFor\(channelKey\)/,
  'a lejátszó csatornaváltáskor beolvassa a mentést');

const app = readFileSync(resolve('web/src/App.tsx'), 'utf8');
assert.match(app, /onSaveAudioTrack=\{handleSaveLiveAudioTrack\}/,
  'az élő hangsáv-ablak megkapja a mentés kezelőt');
assert.match(app, /rememberAudioFor\(channel\.id, track, liveAudioTracks\)/,
  'a mentés a csatorna azonosítójával történik');

console.log('OK – élő hangsáv mentése csatornánként: MENTÉS gomb, tárolás és visszaállítás');
