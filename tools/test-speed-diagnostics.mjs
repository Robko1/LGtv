import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const esbuild = createRequire(new URL('../web/package.json', import.meta.url))('esbuild');
const result = await esbuild.build({
  entryPoints: ['web/src/services/speedDiagnostics.ts'], bundle: true, write: false, format: 'esm',
  plugins: [{ name: 'log-stub', setup(build) {
    build.onResolve({ filter: /^\.\/appLog$/ }, () => ({ path: 'appLog', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
      export const appLog = (s) => globalThis.__speedTest.lines.push(s);
      export const isVerbosePlaybackLogging = () => globalThis.__speedTest.enabled;
      export const registerLoggingLifecycleHooks = (h) => { globalThis.__speedTest.hooks = h; };
    ` }));
  }}],
});
const diag = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

test('kézi életciklus, korrelált médiaidővonal és késői callback védelme', () => {
  const dom = new JSDOM('<!doctype html><video data-iptv-player="true" data-iptv-mode="VOD"></video>', { url: 'https://test.example/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const callbacks = []; window.requestAnimationFrame = (fn) => (callbacks.push(fn), callbacks.length);
  let clock = 100; const oldPerformance = globalThis.performance;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clock } });
  const state = globalThis.__speedTest = { enabled: false, hooks: null, lines: [] };
  const video = document.querySelector('video');
  let frame; video.requestVideoFrameCallback = (fn) => { frame = fn; return 1; };
  const fire = (name) => video.dispatchEvent(new window.Event(name));
  diag.attachSpeedDiagnostics();
  diag.speedSelect('VOD', 'nem naplózható');
  assert.equal(state.lines.length, 0);
  state.enabled = true; state.hooks.onStart();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { keyCode: 13, bubbles: true }));
  clock += 10; diag.speedSelect('VOD', 'Film');
  assert.match(state.lines.join('\n'), /kiválasztás kezelése.*teljes=10\.0 ms.*bemenet=OK/);
  fire('playing'); // a régi forrás eseménye a load előtt nem számít
  assert.doesNotMatch(state.lines.join('\n'), /média playing/);
  clock += 20; diag.speedLoad('VOD', 'mp4', 'https://host/movie/user/password/1.mp4');
  fire('loadedmetadata'); clock += 20; fire('playing');
  assert.match(state.lines.join('\n'), /média playing.*teljes=50\.0 ms/);
  clock += 15; frame();
  assert.match(state.lines.join('\n'), /első képkocka a kompozitornak átadva.*teljes=65\.0 ms/);
  fire('waiting'); clock += 300; fire('playing');
  assert.match(state.lines.join('\n'), /várakozás=300\.0 ms/);
  assert.doesNotMatch(state.lines.join('\n'), /password|https:\/\//);
  diag.speedSelect('élő', 'Másik');
  diag.speedSelect('VOD', 'Új film');
  assert.match(state.lines.join('\n'), /előző indítás megszakítva/);
  diag.speedLoad('VOD', 'új'); fire('playing'); const stale = frame;
  state.hooks.onStop(); state.enabled = false;
  const count = state.lines.length;
  stale(); callbacks.forEach((fn) => fn()); fire('waiting');
  assert.equal(state.lines.length, count, 'leállítás után nincs késői sor');
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: oldPerformance });
  dom.window.close();
});

test('már futó lejátszás a kézi indítástól figyelhető', () => {
  const dom = new JSDOM('<video data-iptv-player="true" data-iptv-mode="VOD" src="https://example.com/a.mp4"></video>', { url: 'https://test.example/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const state = globalThis.__speedTest = { enabled: true, hooks: null, lines: [] };
  diag.attachSpeedDiagnostics(); state.hooks.onStart();
  document.querySelector('video').dispatchEvent(new window.Event('waiting'));
  assert.match(state.lines.join('\n'), /már futó lejátszás megfigyelése/);
  assert.match(state.lines.join('\n'), /média waiting/);
  state.hooks.onStop(); dom.window.close();
});
