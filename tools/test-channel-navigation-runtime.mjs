#!/usr/bin/env node
// Valódi ChannelList + webos.js capture-fázis, gyors egymás utáni TV-gombok.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const esbuild = createRequire(resolve('web/package.json'))('esbuild');
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelList } from './web/src/components/ChannelList';
const channels = Array.from({length: 80}, (_, i) => ({id: 'ch-' + i, name: 'Channel ' + i, streamUrl: 'http://example.invalid/' + i, isFavorite: false}));
window.selected = [];
const root = createRoot(document.getElementById('root'));
root.render(<ChannelList channels={channels} activeProvider={null} epgReady={false} epgRevision={0} selectedChannelId="ch-0"
 onSelectChannel={c => window.selected.push(c.id)} onToggleFavorite={()=>{}} onDeleteChannel={()=>{}} categories={[]}
 folders={[]} selectedCategoryId="all" isOnlyFavorites={false} selectedFavoriteFolderId={null} onSelectFavoriteFolder={()=>{}}/>);
window.unmountList = () => root.unmount();
`;
const bundle = await esbuild.build({ stdin: { contents: harness, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true,
  write: false, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [resolve('web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const vc = new VirtualConsole();
vc.on('jsdomError', error => { throw error; });
const dom = new JSDOM('<!doctype html><html><body class="webos-tv"><header><button data-tv-header data-tv-header-default>Menü</button></header><div data-tv-folders><button data-tv-folder>Folder</button></div><div id="root"></div></body></html>',
  { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
const { document: doc } = window;
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.getAttribute('role') === 'listbox' ? 630 : 40; } });
window.HTMLElement.prototype.getBoundingClientRect = function() { return {top: 0, bottom: 630, left: 0, right: 480, width: 480, height: 630, x: 0, y: 0, toJSON(){}}; };
window.HTMLElement.prototype.scrollIntoView = function() {};
window.eval(readFileSync(resolve('webos/webos.js'), 'utf8'));
const script = doc.createElement('script'); script.textContent = bundle.outputFiles[0].text; doc.body.appendChild(script);
const tick = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 80 && !doc.querySelector('[data-channel-id="ch-0"] [role="option"]'); i++) await tick(25);
await tick(80);
const getRow = n => doc.querySelector(`[data-channel-id="ch-${n}"] [role="option"]`);
const focused = () => doc.activeElement?.closest('[data-channel-id]')?.getAttribute('data-channel-id');
const press = (key, repeat = false) => {
  const code = key === 'ArrowUp' ? 38 : key === 'ArrowDown' ? 40 : key === 'Enter' ? 13 : 0;
  const event = new window.KeyboardEvent('keydown', { key, keyCode: code, bubbles: true, cancelable: true, repeat });
  (doc.activeElement || doc.body).dispatchEvent(event);
  return event;
};
const list = doc.querySelector('[role="listbox"]');
assert.ok(list && getRow(0));
getRow(0).focus();
let missingBeforeStep = 0;
// Nincs várakozás (még rAF/React-mikrotaszk sem) a gombok között.
for (let n = 1; n <= 40; n++) {
  if (!getRow(n)) missingBeforeStep++;
  assert.equal(press('ArrowDown', n > 1).defaultPrevented, true);
  assert.equal(focused(), `ch-${n}`, `LE ${n}: minden gomb azonnal egy sort lép`);
}
assert.ok(missingBeforeStep > 0, 'a teszt érinti a még nem renderelt virtualizált sort is');
assert.ok(list.scrollTop > 0, 'a lapozás lefelé követi a fókuszt');
for (let n = 39; n >= 5; n--) {
  assert.equal(press('ArrowUp', true).defaultPrevented, true);
  assert.equal(focused(), `ch-${n}`, `FEL ${n}: minden gomb azonnal egy sort lép`);
}
assert.equal(window.selected.length, 0, 'a léptetés nem indít csatornát');
await tick(100);
assert.equal(focused(), 'ch-5', 'régi rAF nem ránthatja vissza a fókuszt');
press('Enter');
assert.deepEqual([...window.selected], ['ch-5'], 'OK a pontosan fókuszált csatornát indítja');
for (const [key, n] of [['ArrowDown', 6], ['ArrowUp', 5], ['ArrowDown', 6], ['ArrowUp', 5]]) {
  press(key); assert.equal(focused(), `ch-${n}`, 'gyors irányváltás sem ugrik túl');
}
const star = getRow(5).querySelector('[data-favorite-star]');
assert.ok(star); star.focus(); press('ArrowDown');
assert.equal(focused(), 'ch-6', 'a csillagról LE továbbra is a következő sor');
for (let n = 7; n < 80; n++) { press('ArrowDown', true); assert.equal(focused(), `ch-${n}`, `LE ${n}`); }
press('ArrowDown');
assert.ok(doc.activeElement.hasAttribute('data-tv-folder'), 'utolsó sorról LE: mappasáv');
await tick(100);
assert.ok(doc.activeElement.hasAttribute('data-tv-folder'), 'a lista vége után nem tér vissza régi fókusz');
// A listához az utolsó sorra visszatérve a FEL pontosan a sorokon át halad.
getRow(79).focus();
for (let n = 78; n >= 0; n--) { press('ArrowUp', true); assert.equal(focused(), `ch-${n}`, `FEL ${n}`); }
press('ArrowUp');
assert.ok(doc.activeElement.hasAttribute('data-tv-folder'), 'első sorról FEL: mappasáv');
await tick(100);
assert.ok(doc.activeElement.hasAttribute('data-tv-folder'), 'régi fókuszpróba nem rabolja el a mappasávot');
window.unmountList();
window.close();
console.log('OK – webOS + React: gyors, pontos fel/le léptetés és virtualizált lapozás');
