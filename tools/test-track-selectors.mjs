#!/usr/bin/env node
// A tényleges élő és VOD komponensek + webOS capture és a nyelvcímkék.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import assert from 'node:assert/strict';
const esbuild = createRequire(resolve('web/package.json'))('esbuild');
const built = await esbuild.build({ entryPoints:[resolve('tools/fixtures/track-selector-harness.tsx')], bundle:true, write:false,
  platform:'browser', format:'iife', jsx:'automatic', nodePaths:[resolve('web/node_modules')],
  define:{'process.env.NODE_ENV':'"production"'}, logLevel:'silent' });
const vc = new VirtualConsole();
vc.on('jsdomError', error => { throw error; });
const dom = new JSDOM('<!doctype html><html><body class="webos-tv"><div id="root"></div></body></html>',
  { url:'http://localhost/', runScripts:'dangerously', pretendToBeVisual:true, virtualConsole:vc });
const { window } = dom, doc = window.document;
window.HTMLElement.prototype.getClientRects = function() { return [{}]; };
window.HTMLElement.prototype.scrollIntoView = function() {};
window.eval(readFileSync(resolve('webos/webos.js'), 'utf8'));
const script = doc.createElement('script'); script.textContent = built.outputFiles[0].text; doc.body.appendChild(script);
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const show = async (view, selector) => { window.trackTest.show(view); for (let i=0;i<80 && !doc.querySelector(selector);i++) await tick(20); await tick(100); assert.ok(doc.querySelector(selector), view); };
const press = async key => { const code = { ArrowDown:40, ArrowUp:38, ArrowRight:39, ArrowLeft:37, Enter:13, Escape:461 }[key];
  (doc.activeElement || doc.body).dispatchEvent(new window.KeyboardEvent('keydown', { key, keyCode:code, bubbles:true, cancelable:true })); await tick(40); };
const { trackLabel, trackMeta, trackLanguage } = window.trackTest;
for (const [code, name] of [['fr','Francia'], ['fre','Francia'], ['de-DE','Német'], ['ger','Német'], ['en_US','Angol'], ['hun','Magyar'], ['English','Angol'], ['unknown','Ismeretlen']]) {
  assert.equal(trackLanguage(code), name); assert.equal(trackLabel(code, code), name);
}
assert.equal(trackLabel('Audio 2', 'de-DE'), 'Német');
assert.equal(trackLabel('Audio Track 1', 'fr'), 'Francia');
assert.equal(trackLabel('Original', '', 'Felirat'), 'Eredeti');
assert.equal(trackLabel('Rendezői kommentár', 'en'), 'Rendezői kommentár');
assert.equal(trackLabel('English SDH', 'eng'), 'Angol SDH');
assert.equal(trackLabel('fr (forced)', 'fr'), 'Francia (forced)');
assert.equal(trackLabel('Felirat 1', '', 'Felirat'), 'Felirat 1');
assert.equal(trackLanguage('zz'), 'zz', 'ismeretlen nyelv nem lesz találgatva');
assert.equal(trackMeta('fr', 'AAC', '2.0'), 'Francia / AAC / 2.0');
assert.equal(trackMeta('de', 'AC3', '5.1'), 'Német / AC3 / 5.1');

await show('vod-audio', '[data-track-panel="vod"]');
let rows = [...doc.querySelectorAll('[data-vod-menu-item]')];
assert.match(rows[0].textContent, /Francia/); assert.match(rows[1].textContent, /Német/);
assert.match(rows[0].querySelector('[data-track-meta]').textContent, /Francia/);
assert.equal(doc.activeElement, rows[0]); await press('ArrowDown'); assert.equal(doc.activeElement, rows[1]);
await press('Enter'); assert.deepEqual([...window.trackTest.calls.audio], ['ad']); assert.equal(doc.querySelector('[data-vod-menu]'), null);
await show('vod-subtitle', '[data-track-panel="vod"]');
rows = [...doc.querySelectorAll('[data-vod-menu-item]')];
assert.match(rows[0].textContent, /Francia/); assert.match(rows[1].textContent, /Német/);
assert.equal(rows[1].querySelector('[data-track-meta]').textContent, 'Német');
await press('ArrowDown'); await press('Enter'); assert.deepEqual([...window.trackTest.calls.subtitle], ['sd']);
await show('live', '[data-track-panel="live"]');
let columns = doc.querySelectorAll('[data-track-list]');
assert.match(columns[0].textContent, /Francia/); assert.match(columns[0].textContent, /Német/);
assert.match(columns[1].textContent, /Francia/); assert.match(columns[1].textContent, /Német/);
await press('ArrowRight'); await press('ArrowDown'); await press('Enter');
assert.deepEqual([...window.trackTest.calls.subtitle], ['sd']); assert.equal(window.trackTest.calls.closed, 1);
await show('live', '[data-track-panel="live"]');
await press('ArrowDown'); await press('Enter'); assert.deepEqual([...window.trackTest.calls.audio], ['ad']);
assert.equal(window.trackTest.calls.closed, 1);
await show('audio', '[data-track-panel="single"]'); await press('ArrowDown'); await press('Enter');
assert.deepEqual([...window.trackTest.calls.audio], ['ad']);
await show('subtitle', '[data-track-panel="single"]');
assert.match(doc.querySelector('[data-track-panel="single"]').textContent, /Francia/);
[...doc.querySelectorAll('[data-track-option]')].find(row => row.textContent.includes('Felirat kikapcsolva')).click();
await tick(50); assert.deepEqual([...window.trackTest.calls.subtitle], [null]); assert.equal(window.trackTest.calls.closed, 1);
window.trackTest.unmount(); window.close();
// Régi webOS: DisplayNames hiányában is működnek a beépített kódok.
const legacy = new JSDOM('<div id="root"></div>', { url:'http://localhost/', runScripts:'dangerously', pretendToBeVisual:true });
legacy.window.Intl.DisplayNames = undefined;
legacy.window.eval(built.outputFiles[0].text);
assert.equal(legacy.window.trackTest.trackLanguage('de'), 'Német');
assert.equal(legacy.window.trackTest.trackLanguage('zz'), 'zz');
legacy.window.trackTest.unmount(); legacy.window.close();
console.log('OK – élő és VOD sávválasztók: magyar címkék, TV navigáció és kiválasztás');
