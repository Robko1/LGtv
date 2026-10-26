#!/usr/bin/env node
/*
 * SZOLGÁLTATÓ TÖRLÉSE – valódi React-komponens, valódi kattintás.
 *
 * A TV-n a Beállítások → Listák fülön a piros kuka nem tett semmit, mert a
 * törlés `window.confirm`-ot hívott, amit a webOS böngészője nem jelenít meg
 * (azonnal `false`-t ad). A próba a valódi MenuSettingsModal-t nyitja meg,
 * rákattint a kukára, majd a megerősítésre – és ellenőrzi, hogy a szolgáltató
 * azonosítója tényleg megérkezik a törléskezelőhöz.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve('.');
let esbuild;
try {
  esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
} catch {
  console.log('KIPARANCSOLT: esbuild hiányzik – npm install --prefix web');
  process.exit(0);
}

const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MenuSettingsModal } from './web/src/components/MenuSettingsModal.tsx';

let root = null;
window.__DELETE_TEST__ = {
  deleted: [],
  pressed: [],
  mount() {
    if (root) root.unmount();
    const provider = {
      id: 'prov-1', name: 'Otthoni szolgáltató', type: 'xtream',
      url: 'tv.example', port: '8080', serverUrl: 'http://tv.example:8080',
      username: 'user', password: 'pass', isActive: true, status: 'active',
      channelsCount: 3, moviesCount: 2, seriesCount: 1,
      lastUpdated: '2026-10-26 13:00', expireDate: '2027-01-01', maxConnections: 1,
    };
    const settings = {
      autoPlayLastChannel: true, showEpg: true, seekStep: 10, subtitleSize: '100%',
      streamFormat: 'ts', bufferMode: 'balanced', mirrorLayout: false,
    };
    root = createRoot(document.getElementById('root'));
    root.render(React.createElement(MenuSettingsModal, {
      isOpen: true,
      onClose: () => {},
      activeTab: 'lists',
      setActiveTab: () => {},
      channels: [],
      settings,
      onUpdateSettings: () => {},
      providers: [provider],
      onOpenAddProvider: () => {},
      onEditProvider: () => {},
      onDeleteProvider: (id) => { window.__DELETE_TEST__.deleted.push(id); },
      onRefreshProvider: () => {},
      onOpenImportDiagnostic: () => {},
      folders: [],
      onOpenAddFolder: () => {},
      onDeleteFolder: () => {},
      onToggleFavorite: () => {},
      onRemoveChannelFromFolder: () => {},
      onOpenEpgModal: () => {},
      onOpenQrProvision: () => {},
      watchHistory: [],
      onContinueWatching: () => {},
      onRemoveWatchHistoryItem: () => {},
    }));
  },
};
`;

const outFile = path.resolve('build/test/provider-delete-bundle.js');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: { contents: harness, resolveDir: ROOT, sourcefile: 'provider-delete-harness.tsx', loader: 'tsx' },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  nodePaths: [path.resolve('web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: outFile,
  logLevel: 'silent',
});

const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://tv.local/',
  pretendToBeVisual: true,
  runScripts: 'dangerously',
  virtualConsole: vc,
  beforeParse(window) {
    // A jsdom nem ad méretet; a valódi TV-n minden gomb látható.
    window.Element.prototype.getClientRects = function getClientRects() {
      return this.hasAttribute('hidden') ? [] : [{ width: 10, height: 10 }];
    };
    // A törlés megerősítése SOHA nem hívhat natív ablakot: ha mégis, a TV-n
    // azonnal false-szal térne vissza, és a próba is elbukik.
    window.confirm = () => { throw new Error('window.confirm a TV-n nem használható'); };
  },
});
const { window } = dom;
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
let failed = false;
const check = (ok, message) => {
  checks.push(`${ok ? 'ok  ' : 'FAIL'} – ${message}`);
  if (!ok) failed = true;
};

try {
  const script = window.document.createElement('script');
  script.textContent = fs.readFileSync(outFile, 'utf8');
  window.document.body.appendChild(script);
  const test = window.__DELETE_TEST__;
  check(Boolean(test), 'a valódi MenuSettingsModal bundle betöltődik');
  test.mount();
  await tick(120);

  const doc = window.document;
  const trash = doc.querySelector('button[title="Törlés"]');
  check(Boolean(trash), 'a szolgáltató dobozán látszik a piros kuka');

  trash?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick();
  check(test.deleted.length === 0, 'a kuka megnyomása még NEM töröl (előbb megerősítést kér)');
  const confirmButton = Array.from(doc.querySelectorAll('button'))
    .find((button) => (button.textContent || '').includes('Igen, törlés'));
  check(Boolean(confirmButton), 'megjelenik az „Igen, törlés” gomb');
  check(doc.activeElement === confirmButton, 'a megerősítő gomb kapja a fókuszt (távirányítóval elérhető)');

  const cancelButton = Array.from(doc.querySelectorAll('button'))
    .find((button) => (button.textContent || '').trim() === 'Mégse');
  cancelButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick();
  check(test.deleted.length === 0, 'a Mégse nem töröl');
  check(!Array.from(doc.querySelectorAll('button'))
    .some((button) => (button.textContent || '').includes('Igen, törlés')), 'a Mégse bezárja a megerősítést');

  doc.querySelector('button[title="Törlés"]')
    ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick();
  Array.from(doc.querySelectorAll('button'))
    .find((button) => (button.textContent || '').includes('Igen, törlés'))
    ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick();
  check(test.deleted.length === 1 && test.deleted[0] === 'prov-1',
    'az „Igen, törlés” a szolgáltató azonosítójával hívja a törlést');
} finally {
  window.close();
}

for (const line of checks) console.log(line);
console.log(failed ? '\nHIBA: a szolgáltató törlése nem működik.' : '\nOK: a szolgáltató törlése távirányítóval is működik.');
process.exit(failed ? 1 : 0);
