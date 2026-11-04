#!/usr/bin/env node
/*
 * BETÖLTÉSI DIAGNOSZTIKA – valódi React-komponens regressziós teszt.
 *
 * A #16 TV-próba két hibáját zárja ki jsdom-ban:
 *   - a VISSZA/Escape a tényleges LoadingDiagnosticModalt bezárja;
 *   - kész (100%) snapshotnál nincs 250 ms-os elteltidő-intervallum, és a
 *     későbbi újranyitás sem indítja vissza.
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
import LoadingDiagnosticModal from './web/src/components/LoadingDiagnosticModal.tsx';

let root = null;
let closeCount = 0;
window.__DIAG_TEST__ = {
  mount(props) {
    closeCount = 0;
    if (root) root.unmount();
    root = createRoot(document.getElementById('root'));
    root.render(React.createElement(LoadingDiagnosticModal, {
      channels: [],
      events: [],
      error: null,
      onRetry: undefined,
      retryInSeconds: null,
      onClose: () => { closeCount += 1; props.onClose?.(); },
      ...props,
    }));
  },
  update(props) {
    root.render(React.createElement(LoadingDiagnosticModal, {
      channels: [],
      events: [],
      error: null,
      onRetry: undefined,
      retryInSeconds: null,
      onClose: () => { closeCount += 1; props.onClose?.(); },
      ...props,
    }));
  },
  closeCount() { return closeCount; },
  unmount() { root?.unmount(); root = null; },
};
`;

const outFile = path.resolve('build/test/loading-diagnostic-bundle.js');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: { contents: harness, resolveDir: ROOT, sourcefile: 'loading-diagnostic-harness.tsx', loader: 'tsx' },
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

const intervals = new Set();
const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://tv.local/',
  pretendToBeVisual: true,
  runScripts: 'dangerously',
  virtualConsole: vc,
  beforeParse(window) {
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      const id = nativeSetInterval(callback, delay, ...args);
      intervals.add(id);
      return id;
    };
    window.clearInterval = (id) => {
      intervals.delete(id);
      return nativeClearInterval(id);
    };
  },
});
const { window } = dom;
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
/*
 * A React mount/effect ütemezése a CI-n (több párhuzamos node --test folyamat
 * mellett) néha 30 ms-nál tovább tart. A korábbi fix `await tick()` ilyenkor
 * még az effect ELŐTT olvasta az intervals halmazt, és a teszt időnként
 * hibát jelzett egy valójában helyes komponensre. Rövid poll-oldalú várakozás:
 * a feltételnek legkésőbb 2 mp-en belül teljesülnie kell.
 */
const waitFor = async (predicate, timeout = 2000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick(20);
  }
  return predicate();
};
const checks = [];
let failed = false;
function check(ok, message) {
  checks.push(`${ok ? 'ok  ' : 'FAIL'} – ${message}`);
  if (!ok) failed = true;
}

try {
  const script = window.document.createElement('script');
  script.textContent = fs.readFileSync(outFile, 'utf8');
  window.document.body.appendChild(script);
  const test = window.__DIAG_TEST__;
  check(Boolean(test), 'a valódi LoadingDiagnosticModal bundle betöltődik');

  const startedAt = window.performance.now();
  test.mount({
    isOpen: true,
    startedAt,
    finishedAt: null,
    progress: { phase: 'Betöltés', percent: 40 },
  });
  check(await waitFor(() => intervals.size === 1),
    'folyamat közben pontosan egy elteltidő-interval fut');

  const dialog = window.document.querySelector('[role="dialog"]');
  dialog?.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Escape', keyCode: 461, which: 461, bubbles: true, cancelable: true,
  }));
  check(test.closeCount() === 1, 'a VISSZA/Escape a betöltési diagnosztikát bezárja');
  test.update({ isOpen: false, startedAt, finishedAt: null, progress: { phase: 'Betöltés', percent: 40 } });
  check(await waitFor(() => intervals.size === 0),
    'bezárás után az elteltidő-interval leáll');

  const finishedAt = window.performance.now();
  test.update({
    isOpen: true,
    startedAt,
    finishedAt,
    progress: { phase: 'Kész', percent: 100 },
  });
  await tick();
  check(await waitFor(() => intervals.size === 0),
    '100 százaléknál nem indul elteltidő-interval');
  const finishedText = window.document.querySelector('[role="dialog"]')?.textContent || '';
  test.update({ isOpen: false, startedAt, finishedAt, progress: { phase: 'Kész', percent: 100 } });
  await tick(10);
  test.update({ isOpen: true, startedAt, finishedAt, progress: { phase: 'Kész', percent: 100 } });
  await tick();
  const reopenedText = window.document.querySelector('[role="dialog"]')?.textContent || '';
  check(await waitFor(() => intervals.size === 0),
    'kész snapshot újranyitásakor sem indul új timer');
  check(
    reopenedText.match(/TELJES IDŐ:\s*([^•]+)/)?.[1] === finishedText.match(/TELJES IDŐ:\s*([^•]+)/)?.[1],
    'kész snapshot újranyitásakor az eltelt idő változatlan marad',
  );
} finally {
  for (const id of intervals) window.clearInterval(id);
  window.close();
}

for (const line of checks) console.log(line);
console.log(failed ? '\nHIBA: a betöltési diagnosztika regressziós tesztje nem futott át.' : '\nOK: a betöltési diagnosztika regressziós tesztje minden ellenőrzésen átment.');
process.exit(failed ? 1 : 0);
