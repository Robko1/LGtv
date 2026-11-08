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
const movie={id:'m1',streamId:1,title:'Teszt film',categoryId:'hu',categoryName:'VOD - HUNGARIA [HU]',poster:'',rating:7,year:2024,durationMinutes:100,plot:'Teljes mentett tartalom',genres:['Dráma'],streamUrl:'http://x/movie.mp4',audioLanguages:['Magyar'],subtitleLanguages:['Angol'],providerData:{custom_list:'LISTA-MARAD'},detailProviderData:{info:{custom_detail:'DETAIL-MARAD',director:'Rendező'}}};
const foreignMovie={id:'m2',streamId:2,title:'Külföldi film',categoryId:'nl',categoryName:'VOD - ACTIE [NL]',poster:'',rating:7,year:2026,durationMinutes:90,plot:'',genres:[],streamUrl:'http://x/foreign.mp4',audioLanguages:[],subtitleLanguages:[]};
/* 2.5.392: a lista nem adott játékidőt, de a MÁR elmentett get_vod_info igen. */
const rawRuntimeMovie={id:'m3',streamId:3,title:'Mentett nyers játékidő',categoryId:'hu',categoryName:'VOD - HUNGARIA [HU]',poster:'',rating:0,year:2025,durationMinutes:0,plot:'',genres:[],streamUrl:'http://x/raw.mp4',audioLanguages:[],subtitleLanguages:[],detailProviderData:{info:{duration:'7200',movie_image:''}}};
const series={id:'s1',seriesId:2,title:'Teszt sorozat',categoryId:'c2',categoryName:'Sorozatok',poster:'',rating:8,year:2023,seasonsCount:1,episodesCount:1,plot:'Sorozat tartalom',genres:[],seasons:[{seasonNumber:1,name:'1. évad',episodeCount:1,episodes:[{id:'e1',episodeNumber:1,seasonNumber:1,title:'Pilot',durationMinutes:42,streamUrl:'http://x/e1.mp4',plot:'',thumbnail:'',providerData:{custom_episode:'EPIZOD-MARAD'}}]}],providerData:{custom_series:'SERIES-MARAD'},detailProviderData:{info:{custom_series_detail:'SERIES-DETAIL'}}};
window.roots=[];
const r1=createRoot(document.getElementById('movies'));r1.render(<MoviesView movies={[foreignMovie,movie]} categories={[{id:'nl',name:'VOD - ACTIE [NL]',channelCount:1},{id:'hu',name:'VOD - HUNGARIA [HU]',channelCount:1}]} isActive={true} onPlayMovie={()=>{}} onBackToLive={()=>{}} onToggleFavoriteMovie={()=>{}}/>);window.roots.push(r1);
const r2=createRoot(document.getElementById('series'));r2.render(<SeriesView series={[series]} isActive={true} onPlayEpisode={()=>{}} onBackToLive={()=>{}} onToggleFavoriteSeries={()=>{}}/>);window.roots.push(r2);
const r3=createRoot(document.getElementById('movies-raw'));r3.render(<MoviesView movies={[rawRuntimeMovie]} categories={[{id:'hu',name:'VOD - HUNGARIA [HU]',channelCount:1}]} isActive={true} onPlayMovie={()=>{}} onBackToLive={()=>{}} onToggleFavoriteMovie={()=>{}}/>);window.roots.push(r3);
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
const dom = new JSDOM('<!doctype html><html><body><div id="movies"></div><div id="series"></div><div id="movies-raw"></div></body></html>', { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) { w.__providerCalls = []; w.fetch = () => { w.__providerCalls.push('fetch'); return new Promise(() => {}); }; } });
const w = dom.window, doc = w.document;
const script = doc.createElement('script'); script.textContent = bundle.outputFiles[0].text; doc.body.appendChild(script);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => { for (let i = 0; i < 150; i++) { if (fn()) return; await wait(20); } assert.fail(label); };
try {
  await until(() => doc.querySelector('#movies [data-poster-index]'), 'movie card');
  await until(() => doc.querySelector('#series [data-poster-index]'), 'series card');
  await wait(450);
  assert.deepEqual(w.__providerCalls, [], 'a nézet megnyitása nem kér szolgáltatói adatot');
  // 2.5.245: a listakártya csak posztert + címet + év/játékidő sort mutat (nincs csillag/értékelés).
  const movieCards = [...doc.querySelectorAll('#movies [data-poster-index]')];
  const movieCard = movieCards[0];
  assert.ok(movieCard && movieCard.textContent.includes('Teszt film') && movieCard.textContent.includes('2024'), 'a kártyán cím és év látszik');
  assert.ok(movieCard.textContent.includes('Teszt film') && movieCards[1]?.textContent.includes('Külföldi film'), 'az Összes film első poszterei között a HU kategória kerül a külföldi elé, a későbbi év ellenére');
  assert.ok(movieCard && !movieCard.querySelector('.fill-amber-400'), 'a kártyán nincs csillag/értékelés jelvény');
  // 2.5.392: a már elmentett játékidő a PLAKÁT jobb felső sarkában, kis dobozban.
  await until(() => doc.querySelectorAll('#movies [data-movie-runtime]').length === 2, 'movie runtime badges');
  const badges = [...doc.querySelectorAll('#movies [data-movie-runtime]')];
  assert.ok(badges.every((badge) => /right-2/.test(badge.className) && /top-2/.test(badge.className)),
    'a játékidő-doboz a plakát jobb felső sarkában van');
  assert.ok(badges.some((badge) => badge.textContent.includes('100 perc')) &&
    badges.some((badge) => badge.textContent.includes('90 perc')),
    'a két film mentett játékideje (100 / 90 perc) a plakáton is látszik');
  assert.ok(badges.every((badge) => badge.parentElement &&
      /aspect-/.test(String(badge.parentElement.className)) &&
      badge.parentElement.querySelector('img') !== null),
    'a játékidő-doboz közvetlenül a poszter konténeren belül van');
  await until(() => doc.querySelector('#movies-raw [data-movie-runtime]'), 'raw runtime badge');
  assert.ok(doc.querySelector('#movies-raw [data-movie-runtime]').textContent.includes('120 perc'),
    'ha a lista nem adott játékidőt, a MENTETT get_vod_info nyers adatból jelenik meg (120 perc), új kérés nélkül');
  assert.deepEqual(w.__providerCalls, [], 'a plakát játékideje nem indít szolgáltatói kérést');
  doc.querySelector('#movies [data-poster-index]').click();
  await until(() => doc.querySelector('[role="dialog"]'), 'movie sheet');
  // 2.5.245: az adatlap a DIALOG szövege szerint csak mentett alapadatokat mutat
  // (cím, év, játékidő, LEJÁTSZÁS) – a nyers szolgáltatói mezők NEM jelennek meg.
  const movieDialog = doc.querySelector('[role="dialog"]');
  const movieText = movieDialog.textContent;
  assert.ok(movieText.includes('Teszt film') && movieText.includes('2024') && movieText.includes('100 perc'), 'film adatlap: cím, év, játékidő megjelenik');
  assert.ok(/lejátszás/i.test(movieText) && movieDialog.querySelector('[data-dialog-primary]'), 'film adatlap: nagy kék LEJÁTSZÁS gomb (első fókusz)');
  assert.ok(!movieText.includes('DETAIL-MARAD') && !movieText.includes('LISTA-MARAD'), 'az adatlap NEM jelenít meg nyers szolgáltatói mezőket');
  doc.querySelector('[aria-label="Adatlap bezárása"]').click();
  await wait(50);
  doc.querySelector('#series [data-poster-index]').click();
  await until(() => doc.querySelector('[role="dialog"]'), 'series sheet');
  const seriesDialog = doc.querySelector('[role="dialog"]');
  const seriesText = seriesDialog.textContent;
  assert.ok(seriesText.includes('Teszt sorozat') && seriesText.includes('1. évad') && seriesText.includes('Pilot') && seriesText.includes('S01E01'), 'sorozat adatlap: cím, évad, epizód, SxxEyy megjelenik');
  assert.ok(/lejátszás/i.test(seriesText), 'epizód dobozban LEJÁTSZÁS gomb');
  assert.ok(!seriesText.includes('SERIES-DETAIL') && !seriesText.includes('SERIES-MARAD'), 'a sorozat adatlap sem jelenít meg nyers mezőket');
  assert.deepEqual(w.__providerCalls, [], 'az adatlap megnyitása nem indít vodInfo/seriesInfo/fetch kérést');
  const playerSource = readFileSync(resolve('web/src/components/VideoPlayer.tsx'), 'utf8');
  assert.ok(!/resolveVodSubtitles\s*\(/.test(playerSource), 'a lejátszó nem indít automatikus szolgáltatói feliratkeresést');
  assert.ok(!/xtreamService\.vodInfo|xtreamService\.seriesInfo/.test(readFileSync(resolve('web/src/components/MoviesView.tsx'), 'utf8')), 'a Mozi nézet nem kér adatot');
  assert.ok(!/xtreamService\.vodInfo|xtreamService\.seriesInfo/.test(readFileSync(resolve('web/src/components/SeriesView.tsx'), 'utf8')), 'a Sorozatok nézet nem kér adatot');
  // 2.5.245: böngészés közben sincs előreolvasás, és az App sem köti be prefetch-et.
  assert.ok(!/onPrefetchMetadata/.test(readFileSync(resolve('web/src/components/MoviesView.tsx'), 'utf8'))
    && !/onPrefetchMetadata/.test(readFileSync(resolve('web/src/components/SeriesView.tsx'), 'utf8')), 'a nézetek nem kérnek előreolvasást böngészés közben');
  assert.ok(!/onPrefetchMetadata=\{/.test(readFileSync(resolve('web/src/App.tsx'), 'utf8')), 'az App nem köt be böngészésközbeni előreolvasást');
  // 2.5.245: képek tartós tárolása ugyanabban az IndexedDB-ben (content-img- kulcsok).
  const contentStoreSource = readFileSync(resolve('web/src/services/contentStore.ts'), 'utf8');
  assert.ok(/content-img-/.test(contentStoreSource) && /export async function prefetchContentImages/.test(contentStoreSource), 'a poszter/háttérkép letöltés azonos IDB-t használ (content-img-)');
  const idbSource = readFileSync(resolve('web/src/services/idbStore.ts'), 'utf8');
  assert.ok(/value: string \| Blob/.test(idbSource) && /getRaw/.test(idbSource), 'az idbStore Blob tárolást is támogat (ugyanaz a chunks store)');
  console.log('OK – VOD adatlap: csak mentett adat, nulla új szolgáltatói kérés');
} finally {
  w.roots.forEach((root) => root.unmount());
  w.close();
}
