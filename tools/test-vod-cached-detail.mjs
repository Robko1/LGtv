#!/usr/bin/env node
/** Az adatlap és a lejátszás nem indíthat új szolgáltatói metaadat-kérést. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
const esbuild = createRequire(resolve('web/package.json'))('esbuild');
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MoviesView} from './web/src/components/MoviesView';
import {SeriesView} from './web/src/components/SeriesView';
const movie={id:'m1',streamId:1,title:'Teszt film',categoryId:'c1',categoryName:'Filmek',poster:'',rating:7,year:2024,durationMinutes:100,plot:'Teljes mentett tartalom',genres:['Dráma'],streamUrl:'http://x/movie.mp4',audioLanguages:['Magyar'],subtitleLanguages:['Angol'],providerData:{custom_list:'LISTA-MARAD'},detailProviderData:{info:{custom_detail:'DETAIL-MARAD',director:'Rendező'}}};
const series={id:'s1',seriesId:2,title:'Teszt sorozat',categoryId:'c2',categoryName:'Sorozatok',poster:'',rating:8,year:2023,seasonsCount:1,episodesCount:1,plot:'Sorozat tartalom',genres:[],seasons:[{seasonNumber:1,name:'1. évad',episodeCount:1,episodes:[{id:'e1',episodeNumber:1,seasonNumber:1,title:'Pilot',durationMinutes:42,streamUrl:'http://x/e1.mp4',plot:'',thumbnail:'',providerData:{custom_episode:'EPIZOD-MARAD'}}]}],providerData:{custom_series:'SERIES-MARAD'},detailProviderData:{info:{custom_series_detail:'SERIES-DETAIL'}}};
window.roots=[];
const r1=createRoot(document.getElementById('movies'));r1.render(<MoviesView movies={[movie]} isActive={true} onPlayMovie={()=>{}} onBackToLive={()=>{}} onToggleFavoriteMovie={()=>{}}/>);window.roots.push(r1);
const r2=createRoot(document.getElementById('series'));r2.render(<SeriesView series={[series]} isActive={true} onPlayEpisode={()=>{}} onBackToLive={()=>{}} onToggleFavoriteSeries={()=>{}}/>);window.roots.push(r2);
`;
const plugin = {
  name: 'count-provider',
  setup(build) {
    build.onResolve({ filter: /\/xtreamService$/ }, (args) => ({ path: args.path, namespace: 'count' }));
    build.onLoad({ filter: /.*/, namespace: 'count' }, () => ({
      loader: 'js',
      contents: `export const xtreamService={vodInfo:async()=>{window.__providerCalls.push('vodInfo');return {}},seriesInfo:async()=>{window.__providerCalls.push('seriesInfo');return {}},playerApiBase:()=>'http://x',buildSeriesStreamUrl:()=>'http://x/e1.mp4',cleanUrl:(v)=>v};`,
    }));
  },
};
const bundle = await esbuild.build({ stdin: { contents: source, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [resolve('web/node_modules')], plugins: [plugin], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const vc = new VirtualConsole(); vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) throw e; });
const dom = new JSDOM('<!doctype html><html><body><div id="movies"></div><div id="series"></div></body></html>', { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) { w.__providerCalls = []; w.fetch = () => { w.__providerCalls.push('fetch'); return new Promise(() => {}); }; } });
const w = dom.window, doc = w.document;
const script = doc.createElement('script'); script.textContent = bundle.outputFiles[0].text; doc.body.appendChild(script);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => { for (let i = 0; i < 150; i++) { if (fn()) return; await wait(20); } assert.fail(label); };
try {
  await until(() => doc.querySelector('#movies [data-poster-index]'), 'movie card');
  await until(() => doc.querySelector('#series [data-poster-index]'), 'series card');
  await wait(450);
  assert.deepEqual(w.__providerCalls, [], 'a nézet megnyitása nem kér szolgáltatói adatot');
  doc.querySelector('#movies [data-poster-index]').click();
  await until(() => doc.querySelector('[role="dialog"]'), 'movie sheet');
  assert.ok(doc.body.textContent.includes('DETAIL-MARAD'), 'a mentett részletes mező megjelenik');
  assert.ok(doc.body.textContent.includes('LISTA-MARAD'), 'a mentett listamező megjelenik');
  doc.querySelector('[aria-label="Adatlap bezárása"]').click();
  await wait(50);
  doc.querySelector('#series [data-poster-index]').click();
  await until(() => doc.body.textContent.includes('SERIES-DETAIL'), 'series sheet');
  assert.ok(doc.body.textContent.includes('SERIES-MARAD'), 'a sorozat listamezője megjelenik');
  assert.deepEqual(w.__providerCalls, [], 'az adatlap megnyitása nem indít vodInfo/seriesInfo/fetch kérést');
  const playerSource = readFileSync(resolve('web/src/components/VideoPlayer.tsx'), 'utf8');
  assert.ok(!/resolveVodSubtitles\s*\(/.test(playerSource), 'a lejátszó nem indít automatikus szolgáltatói feliratkeresést');
  assert.ok(!/xtreamService\.vodInfo|xtreamService\.seriesInfo/.test(readFileSync(resolve('web/src/components/MoviesView.tsx'), 'utf8')), 'a Mozi nézet nem kér adatot');
  assert.ok(!/xtreamService\.vodInfo|xtreamService\.seriesInfo/.test(readFileSync(resolve('web/src/components/SeriesView.tsx'), 'utf8')), 'a Sorozatok nézet nem kér adatot');
  console.log('OK – VOD adatlap: csak mentett adat, nulla új szolgáltatói kérés');
} finally {
  w.roots.forEach((root) => root.unmount());
  w.close();
}
