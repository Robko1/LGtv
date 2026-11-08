#!/usr/bin/env node
/**
 * 2.5.394 – FUTÁSIDEJŰ teszt a Mozi plakát játékidejére és a lejátszásból
 * visszatérő fókuszra (valódi React + JSDOM, nem forráskeresés).
 *
 * #35: a plakátokon nem látszott a játékidő, és a filmből visszatérve a
 * kijelölő a Kategóriák gombra ugrott, nem az eredeti poszterre.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const esbuild = createRequire(resolve('web/package.json'))('esbuild');
const ROOT = resolve('.');

const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MoviesView} from './web/src/components/MoviesView';
import {enrichMovieDurationsInBackground} from './web/src/services/vodEnrich';
import {movieRuntimeLabel} from './web/src/utils/vodDisplay';

const base = (id, streamId, title, durationMinutes, extra) => ({
  id, streamId, title, categoryId:'hu', categoryName:'VOD - HUNGARIA [HU]',
  poster:'', rating:0, year:2026, durationMinutes, plot:'', genres:[],
  streamUrl:'http://x/'+streamId+'.mkv', audioLanguages:[], subtitleLanguages:[],
  ...(extra||{}),
});
window.__movies = [
  base('m1', 1, 'HU - Supergirl (2026)', 0),
  base('m2', 2, 'Mentett játékidő', 112),
  base('m3', 3, 'Nyers mentett adat', 0, {detailProviderData:{info:{duration:'5400'}}}),
];
window.__played = [];
const root = createRoot(document.getElementById('app'));
window.__render = (over) => {
  const props = Object.assign({
    movies: window.__movies,
    categories: [{id:'hu',name:'VOD - HUNGARIA [HU]',channelCount:3}],
    isActive: true,
    activeProvider: null,
    onPlayMovie: (m) => { window.__played.push(m.id); },
    onBackToLive: () => {},
    onToggleFavoriteMovie: () => {},
    onDeleteMovie: () => {},
  }, over || {});
  root.render(<MoviesView {...props} />);
};
window.__runtimeLabel = movieRuntimeLabel;
window.__enrich = enrichMovieDurationsInBackground;
window.__render();
`;

const stubPlugin = {
  name: 'stub-provider-and-store',
  setup(build) {
    // Csak a provider-hálózatot cseréljük ki; a contentStore valódi marad,
    // így a providerImport összes importja sértetlen (mint a #392 tesztben).
    build.onResolve({ filter: /\.\/xtreamService$/ }, () => ({ path: 'xtreamService', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      loader: 'js', contents: `
        export const xtreamService = {
          cleanUrl: (v) => v,
          vodInfo: async (_s,_u,_p,id) => { window.__providerCalls.push(id); return {info:{duration:'5700',movie_image:''}}; },
          seriesInfo: async () => ({}),
          playerApiBase: () => 'http://x',
          buildSeriesStreamUrl: () => 'http://x/e.mp4',
        };`,
    }));
  },
};

const bundle = await esbuild.build({
  stdin: { contents: source, resolveDir: ROOT, loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  nodePaths: [resolve('web/node_modules')], plugins: [stubPlugin],
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
});

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) throw e; });
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) {
    w.__providerCalls = [];
    w.__savedExtras = [];
    w.fetch = () => new Promise(() => {});
    w.CSS = w.CSS || {};
    w.CSS.escape = w.CSS.escape || ((v) => String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  },
});
const w = dom.window;
const doc = w.document;
const script = doc.createElement('script');
script.textContent = bundle.outputFiles[0].text;
doc.body.appendChild(script);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => {
  for (let i = 0; i < 150; i++) { if (fn()) return; await wait(20); }
  assert.fail(label);
};

console.log('\n=== Mozi: játékidő a plakáton + visszatérés ugyanarra a poszterre ===\n');

await until(() => doc.querySelectorAll('[data-poster-index]').length === 3, 'három poszter megjelenik');

// 1) A bulk listában hiányzó játékidő -> nincs badge; a mentett / nyers adat -> van badge.
const badgesAtStart = [...doc.querySelectorAll('[data-movie-runtime]')];
assert.equal(badgesAtStart.length, 2, 'csak a két olyan filmnél van játékidő-doboz, amelyiknek van mentett adata');
assert.ok(badgesAtStart.some((b) => b.textContent.includes('112 perc')), 'a közvetlen durationMinutes (112 perc) látszik');
assert.ok(badgesAtStart.some((b) => b.textContent.includes('90 perc')), 'az elmentett get_vod_info nyers adat (90 perc) látszik');
assert.ok(badgesAtStart.every((b) => /right-2/.test(b.className) && /top-2/.test(b.className)), 'a kis doboz a plakát jobb felső sarkában van');
assert.equal(w.__runtimeLabel({ durationMinutes: 0, providerData: undefined, detailProviderData: undefined }), '', 'hiányzó adatnál nincs hamis játékidő');
console.log('  ✓ a plakát játékidő-doboza a mentett adatból dolgozik, hiányzó adatnál üres');

// 2) A háttér-dúsítás TÉNYLEGESEN lekérdezi és visszaadja a hiányzó játékidőt.
await w.__enrich(
  { id: 'qr_1', type: 'xtream', serverUrl: 'http://provider.test', username: 'u', password: 'p' },
  w.__movies.slice(0, 1),
  (enriched) => { w.__enriched = enriched; },
).catch(() => { /* a JSDOM-ban az IDB-mentés nem elérhető, a dúsítás így is lefut */ });
assert.deepEqual(w.__providerCalls, [1], 'csak a hiányzó játékidejű filmhez indul get_vod_info');
assert.ok(w.__enriched && w.__enriched.durationMinutes === 95, 'a get_vod_info 5700 mp -> 95 perc');
const vodEnrichSrc = (await import('node:fs')).readFileSync('web/src/services/vodEnrich.ts', 'utf8');
assert.match(vodEnrichSrc, /saveCatalogExtras\(/, 'a dúsított játékidő tartósan is elmentésre kerül (saveCatalogExtras)');
console.log('  ✓ enrichMovieDurationsInBackground: 1 hiányzó film -> 95 perc, tartósan mentve');

// 3) A dúsított film visszakerül a plakátra (App handleVodItemEnriched útja).
w.__movies = [w.__enriched, ...w.__movies.slice(1)];
w.__render({ movies: w.__movies });
await until(() => doc.querySelectorAll('[data-movie-runtime]').length === 3, 'a dúsított film badge-e is megjelenik');
assert.ok([...doc.querySelectorAll('[data-movie-runtime]')].some((b) => b.textContent.includes('95 perc')),
  'a háttérben dúsított 95 perc a poszteren is látszik');
console.log('  ✓ a háttérben dúsított játékidő azonnal megjelenik a poszteren');

// 4) FÓKUSZ: film indítása -> visszatérés -> UGYANAZ a poszter, nem a kategóriák.
const cards = [...doc.querySelectorAll('[data-poster-index]')];
const chosen = cards[1];
chosen.focus();
assert.equal(doc.activeElement, chosen, 'a kiválasztott poszteren van a fókusz indítás előtt');
chosen.click();
await until(() => doc.querySelector('[role="dialog"] [data-dialog-primary]'), 'az adatlap Lejátszás gombja');
doc.querySelector('[role="dialog"] [data-dialog-primary]').click();
await until(() => w.__played.length === 1, 'a film elindult');
assert.equal(w.__played[0], 'm2', 'a megfelelő film indult el');

// A lejátszó alatt a Mozi panel inaktív, majd visszatérünk rá.
w.__render({ isActive: false });
await wait(60);
w.__render({ isActive: true });
await until(() => {
  const active = doc.activeElement;
  return active && active.getAttribute && active.getAttribute('data-vod-card') === 'm2';
}, 'visszatérés után az eredeti poszter kapja vissza a fókuszt');
const focused = doc.activeElement;
assert.equal(focused.getAttribute('data-vod-card'), 'm2', 'az EREDETI poszter (m2) a fókuszban maradt');
assert.notEqual(focused.getAttribute('data-category-trigger'), '', 'a fókusz NEM a Kategóriák gombon van');
assert.ok(focused.hasAttribute('data-poster-index'), 'a fókusz egy poszterkártyán van, nem a felső sávon');
console.log('  ✓ lejátszásból visszatérve a kijelölő ugyanazon a poszteren marad, nem ugrik a kategóriákra');

console.log('\n=== Mozi futásidejű teszt: MINDEN RENDBEN ===\n');
dom.window.close();
