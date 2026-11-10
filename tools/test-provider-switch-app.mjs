#!/usr/bin/env node
/*
 * SZOLGÁLTATÓVÁLTÁS A VALÓDI ALKALMAZÁSBAN (2.5.417).
 *
 * A teljes App komponens fut jsdom-ban, két előre elmentett szolgáltatóval.
 * A két szolgáltató SZÁNDÉKOSAN azonos stream- és csatornaszámokat használ. A próba
 * a valódi Menü → Listák fül „Aktiválás” gombjára kattint, és azt ellenőrzi,
 * amit a néző lát:
 *   • a váltás HÁLÓZATI KÉRÉS NÉLKÜL, a saját mentett listából történik;
 *   • a képernyőn csak az új szolgáltató csatornái vannak;
 *   • a lejátszó az új szolgáltató címét és SAJÁT utolsó csatornáját kapja –
 *     akkor is, ha az külföldi adó, és nincs a magyar induló készletben;
 *   • a visszaváltás ugyanígy azonnali, az utolsó csatorna megmarad;
 *   • a lejátszási profil (puffer mód) szolgáltatónként külön él;
 *   • az aktív szolgáltató törlése után a megmaradó szolgáltató jelenik meg,
 *     a törölt minden adata eltűnik.
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
const DEBUG = process.env.DEBUG_SWITCH === '1';

const common = {
  bundle: true, platform: 'browser', format: 'iife', target: 'es2020', jsx: 'automatic',
  nodePaths: [path.resolve('web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
  loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl' },
};
const seedOut = path.resolve('build/test/provider-switch-app-seed.js');
const appOut = path.resolve('build/test/provider-switch-app-bundle.js');
fs.mkdirSync(path.dirname(seedOut), { recursive: true });
await esbuild.build({
  ...common,
  outfile: seedOut,
  stdin: {
    resolveDir: ROOT, loader: 'ts', sourcefile: 'provider-switch-seed.ts',
    contents: `
      import { saveContent } from './web/src/services/contentStore.ts';
      import { setActiveProviderScope } from './web/src/services/providerScope.ts';
      import { storageService } from './web/src/services/storageService.ts';
      (window as any).__SEED__ = { saveContent, setActiveProviderScope, storageService };`,
  },
});
await esbuild.build({
  ...common,
  outfile: appOut,
  stdin: {
    resolveDir: ROOT, loader: 'tsx', sourcefile: 'provider-switch-app.tsx',
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import App from './web/src/App.tsx';
      import { getAppLogText, startManualLogging } from './web/src/services/appLog.ts';
      (window as any).__APP__ = {
        mount() {
          // A kézi napló a próbában a váltás menetének bizonyítéka.
          try { startManualLogging(); } catch { /* napló nélkül is fut */ }
          const root = createRoot(document.getElementById('root')!);
          root.render(<App />);
          return root;
        },
        log: () => getAppLogText(),
      };`,
  },
});

/* ---------------------------------------------------------- ál-IndexedDB */
function createIndexedDb() {
  const data = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const request = (result) => {
    const req = { result, onsuccess: null, onerror: null };
    later(() => req.onsuccess?.());
    return req;
  };
  const objectStore = {
    put: (value, key) => { data.set(String(key), value); return request(String(key)); },
    get: (key) => request(data.get(String(key))),
    delete: (key) => { data.delete(String(key)); return request(undefined); },
    getAllKeys: () => request(Array.from(data.keys())),
    openCursor: () => request(null),
    clear: () => { data.clear(); return request(undefined); },
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => objectStore,
    transaction: () => ({ objectStore: () => objectStore, onabort: null }),
    close: () => {},
    onversionchange: null,
  };
  return {
    open: () => {
      const req = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
    keys: () => Array.from(data.keys()),
  };
}

function makeContent(providerId, label, { hungarian, foreign, movies, series }) {
  const channels = [];
  for (let index = 0; index < hungarian + foreign; index++) {
    const hu = index < hungarian;
    channels.push({
      id: `live-${providerId}-${index + 1}`,
      num: index + 1,
      name: `${label.toUpperCase()} TV ${index}`,
      logo: '',
      categoryId: hu ? 'cat-hu' : 'cat-de',
      categoryName: hu ? '[HU] HUNGARIA' : '[DE] GERMANY',
      streamUrl: String(1000 + index),
      streamId: 1000 + index,
      flag: hu ? '🇭🇺' : '🇩🇪',
      countryCode: hu ? 'HU' : 'DE',
      epgChannelId: `epg-${index}`,
      isFavorite: false,
      orderIndex: index,
    });
  }
  return {
    provider: { id: providerId, type: 'xtream', serverUrl: `http://${label}.example:8080`, username: `${label}-user`, password: 'p' },
    savedAt: new Date().toISOString(),
    channels,
    movies: Array.from({ length: movies }, (_, index) => ({
      id: `movie-${index}`, title: `${label} film ${index}`, year: 2020, rating: 7, durationMinutes: 100, genres: [],
      poster: '', backdrop: '', description: '', categoryId: 'vod-1', categoryName: 'Filmek', streamUrl: `m${index}`,
      streamId: index + 1, containerExtension: 'mp4',
    })),
    series: Array.from({ length: series }, (_, index) => ({
      id: `series-${index}`, title: `${label} sorozat ${index}`, year: 2021, rating: 8, genres: [], poster: '', backdrop: '',
      description: '', categoryId: 'ser-1', categoryName: 'Sorozatok', seasons: [], seriesId: index + 1,
    })),
    liveCategories: [
      { id: 'cat-hu', name: '[HU] HUNGARIA', flag: '🇭🇺', channelCount: hungarian, subCategoryCount: 0, type: 'live' },
      { id: 'cat-de', name: '[DE] GERMANY', flag: '🇩🇪', channelCount: foreign, subCategoryCount: 0, type: 'live' },
    ],
    vodCategories: [{ id: 'vod-1', name: 'Filmek', flag: '', channelCount: movies, subCategoryCount: 0, type: 'movie' }],
    seriesCategories: [{ id: 'ser-1', name: 'Sorozatok', flag: '', channelCount: series, subCategoryCount: 0, type: 'series' }],
    totals: { live: channels.length, vod: movies, series },
  };
}

const providerAccount = (id, label, isActive, counts) => ({
  id, name: `${label.toUpperCase()} szolgáltató`, type: 'xtream',
  serverUrl: `http://${label}.example:8080`, username: `${label}-user`, password: 'p',
  isActive, status: 'active', channelsCount: counts.hungarian + counts.foreign, moviesCount: counts.movies,
  seriesCount: counts.series, lastUpdated: '2026. 11. 10.', expireDate: '2027-01-01', maxConnections: 1,
});

/* ----------------------------------------------------------------- jsdom */
const network = [];
const indexedDbFake = createIndexedDb();
const vc = new VirtualConsole();
const pageErrors = [];
vc.on('jsdomError', (error) => { if (!/Not implemented/.test(String(error?.message))) pageErrors.push(String(error?.stack || error?.message || error)); });
if (DEBUG) vc.on('error', (...args) => console.log('[page error]', ...args));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
  runScripts: 'dangerously',
  virtualConsole: vc,
  beforeParse(window) {
    window.indexedDB = indexedDbFake;
    class FakeObjectStore {}
    FakeObjectStore.prototype.getAllKeys = function getAllKeys() {};
    window.IDBObjectStore = FakeObjectStore;
    window.Element.prototype.getClientRects = function getClientRects() {
      return this.hasAttribute('hidden') ? [] : [{ width: 10, height: 10 }];
    };
    window.Element.prototype.scrollIntoView = function scrollIntoView() {};
    window.Element.prototype.scrollTo = function scrollTo() {};
    window.scrollTo = () => {};
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
    const media = window.HTMLMediaElement.prototype;
    media.play = function play() { return Promise.resolve(); };
    media.pause = function pause() {};
    media.load = function load() {};
    media.canPlayType = () => 'maybe';
    // MINDEN hálózati kérés naplózva: a váltás egyetlen szolgáltatói kérést sem indíthat.
    window.fetch = (input) => {
      network.push(String(typeof input === 'string' ? input : input?.url || input));
      return new Promise(() => {});
    };
    const RealXhr = window.XMLHttpRequest;
    window.XMLHttpRequest = class extends RealXhr {
      open(method, url, ...rest) { network.push(String(url)); this.__blocked = true; try { super.open(method, 'http://localhost/__blocked__', ...rest); } catch { /* jsdom */ } }
      send() { /* soha nem megy ki valódi kérés */ }
    };
  },
});
const { window } = dom;
const doc = window.document;
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 6000, stepMs = 40) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try { if (predicate()) return true; } catch { /* még nem kész */ }
    await tick(stepMs);
  }
  return false;
};
const click = (element) => element?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const buttons = () => Array.from(doc.querySelectorAll('button'));
const buttonByText = (text) => buttons().find((button) => (button.textContent || '').trim().includes(text));
const pageText = () => doc.getElementById('root')?.textContent || '';
const playerSrc = () => doc.querySelector('video[data-iptv-player="true"]')?.getAttribute('src') || '';
/*
 * KATALÓGUS-LETÖLTÉS = a csatorna-/film-/sorozatlista vagy a teljes műsorújság
 * lekérése. A nézett csatorna rövid műsora (get_short_epg) a tévézés része,
 * az nem letöltés – de az is csak az ÉPPEN LÁTHATÓ szolgáltatóhoz mehet.
 */
const catalogDownloads = () => network.filter((url) => /alfa\.example|beta\.example/.test(url)
  && (/xmltv\.php|get\.php/.test(url) || (/player_api\.php/.test(url) && !/action=get_short_epg/.test(url))));
const requestsTo = (host) => network.filter((url) => url.includes(host));

let passed = 0;
let failed = 0;
const check = (ok, message, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${message}`); }
  else { failed += 1; console.log(`  ✗ ${message}${detail ? ` (${detail})` : ''}`); }
};

const A = 'prov-A';
const B = 'prov-B';
const countsA = { hungarian: 12, foreign: 30, movies: 6, series: 3 };
const countsB = { hungarian: 7, foreign: 20, movies: 4, series: 2 };

try {
  /* ---- előkészítés: két szolgáltató a tárban, „A” az aktív ---- */
  const seedScript = doc.createElement('script');
  seedScript.textContent = fs.readFileSync(seedOut, 'utf8');
  doc.body.appendChild(seedScript);
  const seed = window.__SEED__;
  seed.setActiveProviderScope(A);
  await seed.saveContent(makeContent(A, 'alfa', countsA));
  await seed.saveContent(makeContent(B, 'beta', countsB));
  await tick(150);
  seed.storageService.saveProviders([providerAccount(A, 'alfa', true, countsA), providerAccount(B, 'beta', false, countsB)]);
  seed.storageService.saveSettings({ ...seed.storageService.getSettings(), activeProviderId: A, bufferMode: 'balanced', autoPlayLastChannel: true });
  // A tárolt csatorna azonosítója: live-<szolgáltató>-<sorszám>.
  seed.storageService.rememberLastChannel(`live-${A}-6`, A); // ALFA TV 5, stream 1005
  // „B” utolsó csatornája KÜLFÖLDI: nincs a magyar induló készletben, a tartós tárból kell előkerülnie.
  seed.storageService.rememberLastChannel(`live-${B}-16`, B); // BETA TV 15 (DE), stream 1015
  seed.storageService.flushLastChannel();
  seed.storageService.saveProviderSettings(B, { bufferMode: 'stable' });

  /* ---- a valódi alkalmazás ---- */
  const appScript = doc.createElement('script');
  appScript.textContent = fs.readFileSync(appOut, 'utf8');
  doc.body.appendChild(appScript);
  window.__APP__.mount();

  console.log('\n1. Indulás az aktív („A”) szolgáltatóval');
  const bootedA = await waitFor(() => /ALFA TV 5\b/.test(pageText()) && /alfa\.example/.test(playerSrc()));
  check(bootedA, 'az „A” szolgáltató csatornái és adása jelent meg', playerSrc());
  check(!/BETA TV/.test(pageText()), 'a „B” szolgáltató egyetlen csatornája sincs a képernyőn');
  check(/alfa-user\/p\/1005\b/.test(playerSrc()), 'a lejátszó „A” utoljára nézett csatornáját (ALFA TV 5) indítja', playerSrc());
  await tick(500);
  check(catalogDownloads().length === 0, 'a mentett listából induló program nem tölt le újra semmit', catalogDownloads().slice(0, 3).join(' | '));
  network.length = 0;

  console.log('\n2. Váltás „B”-re a Menü → Listák → Aktiválás gombbal');
  const openMenu = async () => {
    click(doc.querySelector('[data-settings-open], button[title="Menü"], button[aria-label="Menü"]') || buttonByText('Menü'));
    await waitFor(() => Boolean(buttonByText('Listák')), 2000);
    click(buttonByText('Listák'));
    await tick(120);
  };
  await openMenu();
  const activateB = buttons().find((button) => button.getAttribute('title') === 'Szolgáltató aktiválása');
  check(Boolean(activateB), 'a nem aktív szolgáltatón megjelenik az „Aktiválás” gomb');
  click(activateB);
  const switchedB = await waitFor(() => /BETA TV 15\b/.test(pageText()) && /beta-user\/p\/1015\b/.test(playerSrc()));
  check(switchedB, 'a „B” szolgáltató csatornái és adása jelent meg', playerSrc());
  check(!/ALFA TV \d/.test(pageText()), 'az „A” szolgáltató egyetlen csatornája sem maradt a képernyőn');
  check(/beta-user\/p\/1015\b/.test(playerSrc()), 'a lejátszó „B” SAJÁT utolsó – külföldi – csatornáját (BETA TV 15) indítja', playerSrc());
  check(catalogDownloads().length === 0, 'a váltás egyetlen lista-letöltést sem indított', catalogDownloads().slice(0, 3).join(' | '));
  // A váltás UTÁN a régi szolgáltató felé már semmilyen kérés nem indulhat.
  network.length = 0;
  await tick(700);
  check(requestsTo('alfa.example').length === 0, 'váltás után a régi („A”) szolgáltató felé nem megy több kérés', requestsTo('alfa.example').slice(0, 2).join(' | '));
  check(catalogDownloads().length === 0, 'a háttérmunka sem tölt le listát az új szolgáltatótól', catalogDownloads().slice(0, 3).join(' | '));
  const settingsAfterB = JSON.parse(window.localStorage.getItem('iptv_rt_settings_v1') || '{}');
  check(settingsAfterB.activeProviderId === B, 'a mentett aktív szolgáltató „B”', settingsAfterB.activeProviderId);
  check(settingsAfterB.bufferMode === 'stable', '„B” saját puffer módja (stabil) lépett életbe', settingsAfterB.bufferMode);
  const providersAfterB = JSON.parse(window.localStorage.getItem('iptv_rt_providers_v1') || '[]');
  check(providersAfterB.find((p) => p.id === B)?.isActive === true && providersAfterB.find((p) => p.id === A)?.isActive === false,
    'a szolgáltatólistában csak „B” aktív');
  check(/AKTÍV SZOLGÁLTATÓ VÁLTÁSA: \d+ csatorna a saját tárból, letöltés nélkül/.test(window.__APP__.log()),
    'a napló szerint a lista a saját tárból, letöltés nélkül érkezett');

  console.log('\n3. Visszaváltás „A”-ra');
  network.length = 0;
  if (!buttons().some((button) => button.getAttribute('title') === 'Szolgáltató aktiválása')) await openMenu();
  const activateA = buttons().find((button) => button.getAttribute('title') === 'Szolgáltató aktiválása');
  check(Boolean(activateA), 'az „A” szolgáltatón most megjelenik az „Aktiválás” gomb');
  click(activateA);
  const switchedA = await waitFor(() => /ALFA TV 5\b/.test(pageText()) && /alfa\.example/.test(playerSrc()));
  check(switchedA, 'az „A” szolgáltató csatornái és adása jelent meg újra', playerSrc());
  check(!/BETA TV \d/.test(pageText()), 'a „B” szolgáltató egyetlen csatornája sem maradt a képernyőn');
  check(/alfa-user\/p\/1005\b/.test(playerSrc()), '„A” utolsó csatornája (ALFA TV 5) megmaradt a váltások alatt', playerSrc());
  check(catalogDownloads().length === 0, 'a visszaváltás sem indított lista-letöltést', catalogDownloads().slice(0, 3).join(' | '));
  network.length = 0;
  await tick(700);
  check(requestsTo('beta.example').length === 0, 'visszaváltás után a „B” szolgáltató felé nem megy több kérés', requestsTo('beta.example').slice(0, 2).join(' | '));
  const settingsAfterA = JSON.parse(window.localStorage.getItem('iptv_rt_settings_v1') || '{}');
  check(settingsAfterA.activeProviderId === A && settingsAfterA.bufferMode === 'balanced',
    '„A” saját puffer módja (kiegyensúlyozott) állt vissza', `${settingsAfterA.activeProviderId}/${settingsAfterA.bufferMode}`);

  console.log('\n4. Az aktív („A”) szolgáltató törlése');
  if (!buttons().some((button) => button.getAttribute('title') === 'Törlés')) await openMenu();
  // Az aktív szolgáltató kártyájának kukája (az „Aktiválás” gomb a másikon van).
  const cards = buttons().filter((button) => button.getAttribute('title') === 'Törlés');
  const activeCardTrash = cards.find((button) => !button.parentElement?.querySelector('button[title="Szolgáltató aktiválása"]')) || cards[0];
  click(activeCardTrash);
  await waitFor(() => Boolean(buttonByText('Igen, törlés')), 2000);
  click(buttonByText('Igen, törlés'));
  const successorShown = await waitFor(() => /BETA TV 15\b/.test(pageText()) && /beta-user\/p\/1015\b/.test(playerSrc()));
  check(successorShown, 'a megmaradó „B” szolgáltató lép a helyére a saját utolsó csatornájával (nem üres képernyő)', playerSrc());
  check(!/ALFA TV \d/.test(pageText()), 'a törölt szolgáltató csatornái eltűntek a képernyőről');
  await tick(400);
  const providersAfterDelete = JSON.parse(window.localStorage.getItem('iptv_rt_providers_v1') || '[]');
  check(providersAfterDelete.length === 1 && providersAfterDelete[0].id === B && providersAfterDelete[0].isActive === true,
    'a szolgáltatólistában csak az aktív „B” maradt');
  const leftovers = [
    ...Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index)),
    ...indexedDbFake.keys(),
  ].filter((key) => /^iptv_rt_content-|^content-|^catalog-|^iptv_rt_catalog-|^iptv_rt_last_channel_v1$|^iptv_rt_provider_settings_v1$/.test(key));
  check(leftovers.length === 0, 'a törölt („A”, előtag nélküli) szolgáltató katalógusa és beállításai eltűntek', leftovers.slice(0, 4).join(' | '));
  check(indexedDbFake.keys().some((key) => key.startsWith('provider:') && key.includes('content-live')),
    'a megmaradó „B” katalógusa a tárban maradt');
  check(JSON.parse(window.localStorage.getItem('iptv_rt_settings_v1') || '{}').activeProviderId === B, 'a mentett aktív szolgáltató „B”');
  check(pageErrors.length === 0, 'a teljes folyamat alatt nem volt futásidejű hiba', pageErrors[0]?.slice(0, 300));
} catch (error) {
  failed += 1;
  console.error('\nA próba futás közben megszakadt:', error);
}

if (DEBUG || failed) {
  try { console.log('\n--- alkalmazásnapló (vége) ---\n' + String(window.__APP__?.log?.() || '').split('\n').slice(-60).join('\n')); } catch { /* nincs napló */ }
  if (pageErrors.length) console.log('\n--- oldalhibák ---\n' + pageErrors.slice(0, 5).join('\n---\n'));
}
console.log(`\n=== EREDMÉNY: ${passed} sikeres, ${failed} hibás ===`);
try { window.close(); } catch { /* már bezárult */ }
if (failed) process.exit(1);
console.log('OK: a valódi alkalmazásban a szolgáltatóváltás helyi, azonnali és elkülönített.');
process.exit(0);
