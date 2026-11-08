#!/usr/bin/env node
/**
 * 2.5.397 – A 2026-11-08 18:41-es TV-fotó négy követelményének regressziós tesztje.
 *
 *  1. A SÁRGA/kézi hiba napló az IPK/app indulásakor AUTOMATIKUSAN kezd gyűjteni,
 *     és tételesen (ms-idővel) írja, mit ellenőriz az LG TV / webOS a takarókép
 *     fent tartása alatt.
 *  2. A TV Doktor útvonalpanel a VALÓDI tanult útvonalat mutatja: soha nem
 *     „NINCS ADAT + NINCS ADAT / Nincs mérési adat • ok / hiba”.
 *  3. A bal oldali „Központi profilok / 1-es alap / tanult útvonal” doboz NEM
 *     létezik (jobb oldalon már szerepel).
 *  4. ÖSSZESEN 8 DOBOZ (1 alap + 7 tanult), nem 9; a „Tanulás 3 db” mellett
 *     látszik, hány bejegyzésből hány összevont útvonal lett.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const require = createRequire(path.resolve('web/package.json'));
const esbuild = require('esbuild');
const ROOT = path.resolve('.');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let checks = 0;
let failures = 0;
function check(condition, label) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  ❌ ${label}`);
  } else {
    console.log(`  ✅ ${label}`);
  }
}

const config = read('web/src/services/diagnosticsConfig.ts');
const bootstrap = read('web/src/services/diagnosticsBootstrap.ts');
const main = read('web/src/main.tsx');
const appLogSrc = read('web/src/services/appLog.ts');
const modal = read('web/src/components/TvDoctorStatusModal.tsx');
const doctor = read('web/src/services/tvDoctor.ts');
const cloud = read('web/src/services/tvDoctorCloud.ts');

console.log('\n1. A kézi hiba napló AUTOMATIKUSAN indul az IPK/app indításakor');
check(/export const TEST_STARTUP_DIAGNOSTICS = true;/.test(config),
  'az automata indulási naplózás BE van kapcsolva (nem kell SÁRGA gomb az induláshoz)');
check(/startAutomaticTestLogging\(\)/.test(bootstrap) && /installCrashHandlers\(\)/.test(bootstrap),
  'a diagnosztikai bootstrap import-hibák ELŐTT elindítja a naplót és a crash-handlert');
check(/^import\s+["']\.\/services\/diagnosticsBootstrap["'];/m.test(main)
    && main.indexOf('services/diagnosticsBootstrap') < main.indexOf('from "react"'),
  'a bootstrap az App/modulok kiértékelése ELŐTT, első importként fut');
check(/TAKARÓKÉP/.test(main) && /chromeReady/.test(main) && /logosSettled/.test(main)
    && /videoSettled/.test(main) && /prepaintSettled/.test(main),
  'a takarókép alatt ellenőrzött LG/webOS lépések tételesen szerepelnek a forrásban');
check(/TAKARÓKÉP ELLENŐRZÉS/.test(main) && /notifyAppLoaded/.test(main),
  'a napló külön sorokban írja a webOS notifyAppLoaded / felfedés ellenőrzését');
check(/MIT ELLENŐRIZ A TV/.test(appLogSrc) || /MIT ELLENŐRIZ/.test(main),
  'a napló fejléce felsorolja, pontosan mit ellenőriz az LG TV / webOS az induláskor');
check(/AUTOMATIKUSAN/.test(appLogSrc) && /IPK/.test(appLogSrc),
  'az automatikusan indított munkamenet megkülönböztethető a kézitől (IPK, AUTOMATIKUSAN)');
check(/registerLoggingLifecycleHooks\(\{/.test(main) && /onStart: \(\) => startStartupDiagnostics\(\)/.test(main)
    && /if \(loggingEnabled\)/.test(appLogSrc) && /hooks\.onStart\?\.\(\)/.test(appLogSrc),
  'a main.tsx később regisztrált indulási diagnosztikája AZONNAL csatlakozik a már futó automata naplóhoz');

console.log('\n2. A tanult útvonal VALÓDI adat: nincs többé NINCS ADAT placeholder');
check(!/NINCS ADAT/.test(modal) && !/Nincs mérési adat/.test(modal),
  'a 0-ablak egyetlen útvonalsora sem írhat „NINCS ADAT / Nincs mérési adat”-ot');
check(/export function normalizeDoctorRoutesForDisplay/.test(doctor),
  'a kliens normalizálja a felhő régi/hiányos útvonal-sorait is (nem dobja el)');
check(/normalizeDoctorRoutesForDisplay\(/.test(cloud),
  'a Supabase RPC soraiból a normalizált, valódi útvonal jön vissza');
check(/normalizeDoctorRoutesForDisplay\(/.test(doctor) && /getTvDoctorChannelSnapshot/.test(doctor),
  'a pillanatkép (helyi + felhő) is a normalizált útvonalakat adja');

console.log('\n3. A bal oldali központi profil doboz ELTÁVOLÍTVA');
check(!/data-tv-doctor-central-profiles/.test(modal),
  'nincs külön bal oldali „Központi profilok / 1-es alap / tanult útvonal” doboz');
check(/Központi profilok:/.test(modal),
  'a központi profilok száma továbbra is a JOBB oldali Supabase-panelen látszik');

console.log('\n4. PONTOSAN 8 DOBOZ + „Tanulás 3 db” összhang');
check(/data-tv-doctor-route-boxes="8"/.test(modal),
  'az útvonalpanel explicit 8 dobozos (1 alap + 7 tanult), nem 9');
check(/Array\.from\(\{ length: MAX_CHANNEL_ROUTES - 1 \}/.test(modal)
    && !/Array\.from\(\{ length: MAX_CHANNEL_ROUTES \}/.test(modal),
  'a tanult sorok száma 7 (2–8), nem 8 (2–9)');
check(/tanult útvonalak \(2–8\)/.test(modal) && !/\(2–9\)/.test(modal),
  'a címke (2–8), azaz a 9. doboz megszűnt');
check(/Tanulás/.test(modal) && /bejegyzés/.test(modal) && /összevont/.test(modal),
  'a tanulási bejegyzések száma és az összevont tanult útvonalak száma együtt látszik');

/* ───────────────────────────────────────────────────────────────────────────
 * FUTÁSIDEI PRÓBA 1: az automata napló tényleg elindul és ír
 * ─────────────────────────────────────────────────────────────────────────── */
console.log('\n5. Futásidei: automata napló + valódi útvonal + 8 doboz (JSDOM)');

const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc,
});
const win = dom.window;
for (const key of ['window', 'document', 'navigator', 'location', 'localStorage',
  'HTMLElement', 'MutationObserver', 'Event', 'CustomEvent',
  'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'requestIdleCallback', { value: undefined, configurable: true, writable: true });
Object.defineProperty(win, 'IPTV_RT_WEB_VERSION', { value: '2.5.397', configurable: true });
Object.defineProperty(globalThis, 'IPTV_RT_WEB_VERSION', { value: '2.5.397', configurable: true });

/* Egy régi/hiányos Supabase-sor: a TV-fotón ez adott NINCS ADAT-ot. A valódi
   élő 2026-11-08 18:29:28-as hu:cinemax sorból származik, csak a route objektum
   formátum/buffer mezői hiányoznak – ahogyan a TV build látta. */
const LEGACY_ROW = {
  channel_key: 'hu:cinemax', country_code: 'HU',
  best_format: 'ts', best_buffer_profile: 'balanced',
  ts_success_count: 2, hls_success_count: 0, ts_avg_startup_ms: 1432,
  routes: [{ id: 'ts:balanced', ok: 2, fail: 0, avg_startup_ms: 1432, best_startup_ms: 1250 }],
  updated_at: '2026-11-08 18:29:28.028+00',
};

/* EGYETLEN bundle: a bootstrap mellékhatása és az appLog állapota így
   ugyanabban a modul-példányban él (külön bundle-ök külön állapotot adnának). */
const bootstrapEntry = `
import './web/src/services/diagnosticsBootstrap.ts';
import { startAutomaticTestLogging, manualLogSnapshot, getAppLogText, appLog } from './web/src/services/appLog.ts';
import { normalizeDoctorRoutesForDisplay, getTvDoctorChannelSnapshot, restoreTvDoctorCentralProfiles, mergeCloudDoctorLogs, MAX_CHANNEL_ROUTES } from './web/src/services/tvDoctor.ts';
export {
  startAutomaticTestLogging, manualLogSnapshot, getAppLogText, appLog,
  normalizeDoctorRoutesForDisplay, getTvDoctorChannelSnapshot,
  restoreTvDoctorCentralProfiles, mergeCloudDoctorLogs, MAX_CHANNEL_ROUTES,
};
`;
const coreOut = path.join(ROOT, 'build/test/boot-log-core.mjs');
await esbuild.build({
  stdin: { contents: bootstrapEntry, resolveDir: ROOT, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: coreOut,
  nodePaths: [path.join(ROOT, 'web/node_modules')], logLevel: 'silent',
});
const core = await import(pathToFileURL(coreOut).href + '?v=' + Date.now());

/* Az automata napló akkor indul, amikor a bootstrap modul kiértékelődik. */
check(core.manualLogSnapshot().enabled === true,
  'a naplózás a modulok betöltésekor MAGÁTÓL bekapcsol (nem kell SÁRGA gomb)');
const logText = core.getAppLogText();
check(/AUTOMATIKUSAN/.test(logText) && /IPK/.test(logText),
  'az automata munkamenet első sora megnevezi az IPK-indulást');
check(/MIT ELLENŐRIZ/.test(logText),
  'az automata napló tételesen felsorolja az LG TV / webOS ellenőrzési lépéseit');
core.appLog('TAKARÓKÉP ELLENŐRZÉS [+123 ms] chromeReady=igen; listReady=nem');
check(/TAKARÓKÉP ELLENŐRZÉS \[\+123 ms\]/.test(core.getAppLogText()),
  'a takarókép alatti ellenőrzési lépés ms-idővel bekerül a naplóba');

/* A hiányos felhő-sorból VALÓDI útvonal lesz. */
const normalized = core.normalizeDoctorRoutesForDisplay(LEGACY_ROW);
check(normalized.length === 1 && normalized[0].format === 'ts'
    && normalized[0].bufferProfile === 'balanced'
    && normalized[0].ok === 2 && normalized[0].avgStartupMs === 1432,
  'a hiányos (NINCS ADAT-ot adó) felhő-sorból TS + balanced / 1432 ms / 2 ok lesz');

const channel = { id: 'live-qr_1794135505110-16820', name: '[HU] CINEMAX', countryCode: 'HU' };
core.restoreTvDoctorCentralProfiles({
  layoutChannels: [{ channelKey: 'hu:cinemax', name: '[HU] CINEMAX' }],
  baselines: [], profiles: [], routes: [],
}, win.localStorage);
core.mergeCloudDoctorLogs([1, 2, 3].map((i) => ({
  category: 'learning', at: Date.now() - (3 - i) * 1000,
  channelKey: 'hu:cinemax', channelName: '[HU] CINEMAX',
  message: `Tanulási bejegyzés #${i}`,
})));
const snapshot = core.getTvDoctorChannelSnapshot(channel, [LEGACY_ROW], win.localStorage);
check(snapshot.routes.length === 1 && snapshot.routes[0].format === 'ts'
    && snapshot.routes[0].ok === 2,
  'a pillanatkép (helyi + Supabase) is a valódi tanult útvonalat adja');
check(snapshot.logsByCategory.learning.length === 3,
  'a „Tanulás 3 db” három bejegyzése megvan a pillanatképben');

/* ───────────────────────────────────────────────────────────────────────────
 * FUTÁSIDEI PRÓBA 2: a valódi React panel 8 dobozt rajzol, valódi adattal
 * ─────────────────────────────────────────────────────────────────────────── */
const uiEntry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TvDoctorStatusModal } from './web/src/components/TvDoctorStatusModal.tsx';
import { INITIAL_SETTINGS } from './web/src/data/mockData.ts';
import { restoreTvDoctorCentralProfiles, mergeCloudDoctorLogs } from './web/src/services/tvDoctor.ts';
const root = createRoot(document.getElementById('root'));
window.__seed = () => {
  restoreTvDoctorCentralProfiles({
    layoutChannels: [{ channelKey: 'hu:cinemax', name: '[HU] CINEMAX' }],
    baselines: [], profiles: [], routes: [],
  });
  mergeCloudDoctorLogs([1, 2, 3].map((i) => ({
    category: 'learning', at: Date.now() - (3 - i) * 1000,
    channelKey: 'hu:cinemax', channelName: '[HU] CINEMAX',
    message: 'Tanulási bejegyzés #' + i,
  })));
};
window.__render = (channel) => root.render(React.createElement(TvDoctorStatusModal, {
  isOpen: true, onClose: () => {}, settings: INITIAL_SETTINGS,
  activeChannel: channel, isFullscreen: false,
}));
`;
const uiOut = path.join(ROOT, 'build/test/boot-log-panel.js');
await esbuild.build({
  stdin: { contents: uiEntry, resolveDir: ROOT, loader: 'tsx' },
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  outfile: uiOut, nodePaths: [path.join(ROOT, 'web/node_modules')], logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"' },
});

const uiDom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) {
    w.fetch = async (url) => {
      const u = String(url);
      const data = u.includes('/rpc/tv_doctor_routes_fetch') ? [LEGACY_ROW]
        : u.includes('/functions/v1/tv-doctor') ? { ok: true, profiles: [], events: [] } : [];
      return {
        ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data),
        clone() { return this; },
      };
    };
    Object.defineProperty(w, 'IPTV_RT_WEB_VERSION', { value: '2.5.397', configurable: true });
  },
});
const uw = uiDom.window;
uw.localStorage.setItem('iptv_rt_tv_doctor_pairing_v1', JSON.stringify({
  deviceId: 'LG-4ZYG-W5XP', deviceToken: 'tvd_' + 'a'.repeat(60),
}));
const script = uw.document.createElement('script');
script.textContent = fs.readFileSync(uiOut, 'utf8');
uw.document.body.appendChild(script);
uw.__seed();
uw.__render(channel);
await new Promise((resolve) => setTimeout(resolve, 900));

const boxes = uw.document.querySelectorAll('[data-tv-doctor-route-box]');
check(boxes.length === 8,
  `a valódi React panel PONTOSAN 8 dobozt rajzol (kapott: ${boxes.length})`);
check(uw.document.querySelector('[data-tv-doctor-central-profiles]') === null,
  'a kirenderelt panelen NINCS bal oldali központi profil doboz');
const realRow = uw.document.querySelector('[data-tv-doctor-route]');
const realText = realRow ? realRow.textContent.trim() : '';
check(Boolean(realRow) && /TS/.test(realText) && !/NINCS ADAT/.test(realText),
  `a valódi tanult útvonal látszik (kapott: ${JSON.stringify(realText)})`);
check(/1432ms/.test(realText) && /2 ok/.test(realText),
  'a valódi útvonal mért indulási ideje és siker-számlálója is látszik');
const subtitle = uw.document.querySelector('[data-tv-doctor-learning-count]')?.textContent.trim() || '';
check(/Tanulás/.test(subtitle) && /3 bejegyzés/.test(subtitle) && /1 összevont útvonal/.test(subtitle),
  `a panel megmagyarázza: 3 tanulási bejegyzés → 1 összevont útvonal (kapott: ${JSON.stringify(subtitle)})`);

uiDom.window.close();
dom.window.close();

console.log(`\n2.5.397 boot-napló / TV Doktor panel: ${checks - failures}/${checks} sikeres, ${failures} hibás.`);
if (failures > 0) process.exitCode = 1;
