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
      // 2.5.226: a mérési naplót a próba bekapcsolt állapotban ellenőrzi.
      export const measurementLogsEnabled = () => true;
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
  video.src = 'https://host/movie/user/password/1.mp4';
  fire('loadedmetadata'); clock += 20; fire('playing');
  assert.match(state.lines.join('\n'), /média playing.*teljes=50\.0 ms/);
  clock += 15; frame(clock, { mediaTime: 0.25 });
  assert.match(state.lines.join('\n'), /megfigyelt képkocka a kompozitornak átadva.*teljes=65\.0 ms.*nem bizonyítja/);
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


test('hiányzó és későn érkező képkocka, izolált próbák és React commitok', () => {
  const dom = new JSDOM('<video data-iptv-player="true" data-iptv-mode="élő"></video>', { url:'https://test.example/' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const state = globalThis.__speedTest = { enabled:true, hooks:null, lines:[] };
  const video = document.querySelector('video');
  const frames = [], timers = new Map(), cancelled = [];
  let timerId = 0, frameId = 0;
  window.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  window.setTimeout = fn => { timers.set(++timerId, fn); return timerId; };
  window.clearTimeout = id => timers.delete(id);
  const callbacks = new Map();
  video.requestVideoFrameCallback = fn => { callbacks.set(++frameId, fn); return frameId; };
  video.cancelVideoFrameCallback = id => cancelled.push(id);
  diag.attachSpeedDiagnostics(); state.hooks.onStart();
  diag.speedSelect('élő', 'Első', false, 'one');
  diag.speedChannelCommit('lejátszó React commit', 'other');
  assert.doesNotMatch(state.lines.join('\n'), /lejátszó React commit/);
  diag.speedChannelCommit('lejátszó React commit', 'one');
  diag.speedChannelCommit('főoldal React commit', 'one');
  assert.match(state.lines.join('\n'), /lejátszó React commit/);
  frames.shift()(0); frames.shift()(0);
  assert.match(state.lines.join('\n'), /második renderelési lehetőség.*nem a panel tényleges festése/);
  diag.speedLoad('élő', 'ts', 'https://host/live/u/p/1.ts'); video.src = 'https://host/live/u/p/1.ts';
  const oldObserver = diag.speedAttemptObserver();
  video.dispatchEvent(new window.Event('loadeddata'));
  video.dispatchEvent(new window.Event('playing'));
  assert.equal(callbacks.size, 1, 'egyetlen képkockafigyelés próbánként');
  assert.equal(timers.size, 1);
  const timeout = [...timers.values()][0]; timeout();
  assert.match(state.lines.join('\n'), /képkocka-visszajelzés nem érkezett.*nem mérhető/);
  callbacks.get(1)(0, { mediaTime: 1 });
  assert.match(state.lines.join('\n'), /megfigyelt képkocka.*nem bizonyítja/);
  diag.speedLoad('élő', 'ismétlés', 'https://host/live/u/p/1.ts');
  const count = state.lines.length; oldObserver('régi promise');
  assert.equal(state.lines.length, count, 'régi próbából nem keletkezhet új sor');
  video.dispatchEvent(new window.Event('playing'));
  diag.speedSelect('élő', 'Második', false, 'two');
  assert.ok(cancelled.includes(2));
  const before = state.lines.length; callbacks.get(2)(0, {});
  assert.equal(state.lines.length, before, 'másik csatorna régi képkockája nem fogadható el');
  diag.speedLoad('élő', 'új', 'https://host/live/u/p/2.ts');
  video.dispatchEvent(new window.Event('playing')); // még a régi src van beállítva
  assert.equal(state.lines.length, before + 1, 'a régi elem eseménye nem az új streamé');
  video.src = 'https://host/live/u/p/2.ts';
  delete video.requestVideoFrameCallback;
  video.dispatchEvent(new window.Event('playing'));
  assert.match(state.lines.join('\n'), /képkocka-visszajelzés nem támogatott/);
  assert.doesNotMatch(state.lines.join('\n'), /https:\/\/host|\/u\/p\//);
  state.hooks.onStop(); dom.window.close();
});

test('erőforrás-időzítés csak a cél-URL megfelelő próbájához, adatkiírás nélkül', () => {
  const dom = new JSDOM('<video data-iptv-player="true" data-iptv-mode="élő"></video>', {url:'https://test.example/'});
  globalThis.window=dom.window; globalThis.document=dom.window.document;
  const oldPerformance=globalThis.performance;
  let clock=100; const requested=[];
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{
    now:()=>clock,
    getEntriesByName:(url,type)=>{ requested.push([url,type]); return [
      {startTime:90,responseStart:100,responseEnd:130},
      {startTime:111,responseStart:161,responseEnd:211},
    ]; },
  }});
  const state=globalThis.__speedTest={enabled:true,hooks:null,lines:[]};
  diag.attachSpeedDiagnostics(); state.hooks.onStart();
  diag.speedSelect('élő','csatorna',false); clock=110;
  const url='https://stream.example/live/user/private/channel.ts';
  diag.speedLoad('élő','ts',url); const video=document.querySelector('video'); video.src=url;
  clock=220; video.dispatchEvent(new window.Event('playing')); video.dispatchEvent(new window.Event('playing'));
  assert.deepEqual(requested,[[url,'resource']], 'próbánként egy pontos URL-keresés, hálózati lekérés nélkül');
  assert.match(state.lines.join('\n'),/első válaszig=50\.0 ms; válaszátvitel=50\.0 ms.*nem bizonyít/);
  assert.doesNotMatch(state.lines.join('\n'),/private|stream\.example/);
  state.hooks.onStop(); Object.defineProperty(globalThis,'performance',{configurable:true,value:oldPerformance}); dom.window.close();
});
