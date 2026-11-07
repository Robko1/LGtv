import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
const esbuild = createRequire(resolve('web/package.json'))('esbuild');
const built = await esbuild.build({
  entryPoints: [resolve('web/src/services/appLog.ts')],
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'AppLog',
  nodePaths: [resolve('web/node_modules')], define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => console.log('JSDOM ERROR', e.message));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
const s = dom.window.document.createElement('script');
s.textContent = built.outputFiles[0].text;
dom.window.document.body.appendChild(s);
const api = dom.window.AppLog;
console.log('keys', Object.keys(api).slice(0, 12));
console.log('ts', api.dublinTimestamp(Date.UTC(2026, 10, 7, 17, 25, 22)));
try { const snap = api.resetMeasurements('teszt ok'); console.log('reset ok', snap); } catch (e) { console.log('RESET THREW', e.message); }
