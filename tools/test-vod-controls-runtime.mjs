#!/usr/bin/env node
// Real VideoPlayer + webOS key capture; mock media lists/Luna and provider APIs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
const esbuild = createRequire(resolve('web/package.json'))('esbuild');
const source = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {VideoPlayer} from './web/src/components/VideoPlayer';
import {INITIAL_SETTINGS} from './web/src/data/mockData';
const PROVIDER_TRACKS=[{id:'cc:1',name:'Provider teszt',lang:'xx',url:'https://example.invalid/sub.srt'}];
function Harness() {
 const [playing,setPlaying]=useState(true);
 return <VideoPlayer customStreamUrl="https://example.invalid/movie.mp4" isFullscreen={true}
  settings={INITIAL_SETTINGS} isPlaying={playing} setIsPlaying={setPlaying} volume={0.5}
  onVolumeChange={()=>{}} onToggleMute={()=>window.state.mutes++} playbackActive={true}
  subtitleSource={{vodId:'99'}} subtitleTracks={PROVIDER_TRACKS}/>;
}
const root=createRoot(document.getElementById('root')); root.render(<Harness/>);
// The same event bridge as App: the webOS action is translated to the player's menu event.
window.addEventListener('iptv-tv-action', e => {window.state.actions.push(e.detail.action); if(e.detail.action==='vod-audio') window.dispatchEvent(new CustomEvent('iptv-vod-menu',{detail:{menu:'combined'}}));});
window.unmountPlayer=()=>root.unmount();
`;
const plugin = {
 name:'test-subtitle-services', setup(build) {
  build.onResolve({filter:/\/(embeddedSubtitleService|subtitleService)$/},args => ({path:args.path,namespace:'test-cc'}));
  build.onLoad({filter:/.*/,namespace:'test-cc'}, args => ({loader:'js', contents:args.path.endsWith('embeddedSubtitleService') ? `
   export function getWebosMediaId(){return null}
   export async function probeEmbeddedSubtitles(){return [{lunaIndex:0,name:'Luna teszt',lang:'xx'}]}
   export function subscribeSourceInfoSubtitles(){return ()=>{}}
   export async function probeMatroskaVideoInfo(){return null}
   export async function probeSourceInfoQuality(){return null}
   export function selectEmbeddedSubtitle(){window.state.lunaSelect++; return new Promise(resolve=>window.state.finishLuna=resolve)}
   export async function disableEmbeddedSubtitle(){window.state.lunaDisable++}
  ` : `
   export async function resolveVodSubtitles(){return [{id:'cc:1',name:'Provider teszt',lang:'xx',url:'https://example.invalid/sub.srt'}]}
   export function loadSubtitleCues(){return new Promise(resolve=>window.state.finishProvider=resolve)}
   export function cueAt(cues){return cues[0]||null}
  `}));
 }
};
const bundle = await esbuild.build({stdin:{contents:source,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[resolve('web/node_modules')],plugins:[plugin],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const vc=new VirtualConsole(); vc.on('jsdomError',e=>{if(!/Not implemented/.test(e.message)) throw e;});
const dom=new JSDOM('<!doctype html><html><body><div data-view-pane="movies"></div><div id="root"></div></body></html>',{url:'http://localhost/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
 w.state={actions:[],mutes:0,lunaSelect:0,lunaDisable:0};
 w.audioTracks=[{language:'hu',label:'Magyar',enabled:true},{language:'en',label:'English',enabled:false}];
 w.tracks=[{kind:'subtitles',label:'HTML teszt',language:'xx',mode:'disabled',activeCues:[]}];
 const p=w.HTMLMediaElement.prototype;
 Object.defineProperty(p,'textTracks',{configurable:true,get(){return w.tracks}});
 Object.defineProperty(p,'audioTracks',{configurable:true,get(){return w.audioTracks}});
 Object.defineProperty(p,'paused',{configurable:true,get(){return false}});
 p.play=()=>Promise.resolve(); p.pause=()=>{}; p.load=()=>{}; p.canPlayType=()=> 'maybe';
 w.HTMLElement.prototype.getClientRects=function(){return [{}]};
 w.fetch=()=>new Promise(()=>{});
}});
const w=dom.window, doc=w.document;
w.eval(readFileSync(resolve('webos/webos.js'),'utf8'));
const script=doc.createElement('script');script.textContent=bundle.outputFiles[0].text;doc.body.appendChild(script);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async (fn,label)=>{for(let i=0;i<200;i++){if(fn())return;await wait(20)}assert.fail(label)};
const press=async (code,key)=>{(doc.activeElement||doc.body).dispatchEvent(new w.KeyboardEvent('keydown',{key,keyCode:code,bubbles:true,cancelable:true}));await wait(50)};
const row=(scope,text)=>[...doc.querySelectorAll(`${scope} [data-track-option]`)].find(el=>el.textContent.trim()===text);
const clickRow=async (scope,text)=>{await until(()=>row(scope,text),`missing row ${text}`);row(scope,text).click();await wait(70)};
try {
 await until(()=>doc.querySelector('[data-tv-player][data-vod-active]'),'VOD player');
 // Blue does not dispatch anything during playback, even if an OSD menu is visible.
 await press(406,'ColorF3Blue');assert.deepEqual([...w.state.actions],[]);
 await press(404,'ColorF1Green');await until(()=>doc.querySelector('[data-track-panel="live"]'),'green opens combined selector');
 assert.equal(doc.querySelectorAll('[data-track-column]').length,2);
 assert.ok(row('[data-track-panel="live"]','Felirat kikapcsolva'));
 await press(406,'ColorF3Blue');assert.ok(doc.querySelector('[data-track-panel="live"]'),'blue does not close or switch menu');
 await press(40,'ArrowDown');await press(13,'Enter');assert.equal(w.audioTracks[1].enabled,true,'green selector switches audio via remote');
 await press(404,'ColorF1Green');await press(461,'Escape');assert.equal(doc.querySelector('[data-track-panel="live"]'),null,'back only closes selector');
 // OSD menus are separately accessible and the audio header has no extra icon/help.
 doc.querySelector('[data-vod-osd-audio]').click(); await until(()=>doc.querySelector('[data-track-panel="vod"]'),'audio menu');
 let panel=doc.querySelector('[data-track-panel="vod"]');
 assert.equal(panel.querySelector('h2').textContent,'Hangsáv');
 assert.equal(panel.querySelector('h2').parentElement.querySelectorAll('svg').length,0,'header contains only the title');
 assert.doesNotMatch(panel.textContent,/Alap nyelv|automatikusan|ZÖLD|KÉK|Mozi.*Sorozat/);
 await press(461,'Escape');doc.querySelector('[data-vod-osd-subs]').click();await until(()=>row('[data-track-panel="vod"]','HTML teszt'),'HTML list');
 await clickRow('[data-track-panel="vod"]','HTML teszt');assert.equal(w.tracks[0].mode,'hidden','HTML subtitle enabled');
 doc.querySelector('[data-vod-osd-subs]').click();await clickRow('[data-track-panel="vod"]','Felirat kikapcsolva');
 assert.equal(w.tracks[0].mode,'disabled','HTML subtitle disabled');
 // Choosing off remains selected and cannot be undone by late auto-selection.
 await wait(1600);assert.equal(w.tracks[0].mode,'disabled');
 await press(404,'ColorF1Green');await until(()=>doc.querySelector('[data-track-panel="live"]'),'reopen green');
 assert.equal(row('[data-track-panel="live"]','Felirat kikapcsolva').getAttribute('aria-pressed'),'true');
 // A mentett provider-sáv kiválasztása után a késői fájlválasz nem kapcsolhatja vissza a feliratot.
 await clickRow('[data-track-panel="live"]','Provider teszt');await until(()=>w.state.finishProvider,'provider request');
 await press(404,'ColorF1Green');await clickRow('[data-track-panel="live"]','Felirat kikapcsolva');
 w.state.finishProvider([{start:0,end:999,text:'LATE CAPTION'}]);await wait(100);
 assert.ok(!doc.body.textContent.includes('LATE CAPTION'),'late provider response is ignored');
 // A late Luna enable after OFF is followed by a second disable.
 await press(404,'ColorF1Green');await clickRow('[data-track-panel="live"]','Luna teszt');
 assert.equal(w.state.lunaSelect,1);await press(404,'ColorF1Green');await clickRow('[data-track-panel="live"]','Felirat kikapcsolva');
 const disabledBefore=w.state.lunaDisable;assert.ok(disabledBefore>=1);
 w.state.finishLuna(true);await wait(80);assert.ok(w.state.lunaDisable>disabledBefore,'late Luna enable is disabled again');
 assert.equal(doc.querySelector('[data-vod-osd-volume-slider]'),null);doc.querySelector('[data-vod-osd-volume]').click();assert.equal(w.state.mutes,1);
 // Off is always offered, even if no selectable subtitle is currently known.
 w.tracks.length=0;doc.querySelector('video').dispatchEvent(new w.Event('loadedmetadata'));await wait(100);
 doc.querySelector('[data-vod-osd-subs]').click();await clickRow('[data-track-panel="vod"]','Felirat kikapcsolva');
 // In movie/series browsers blue does not dispatch the live move action; live remains unchanged.
 w.unmountPlayer();await wait(40);w.state.actions.length=0;
 for (const view of ['movies','series','live']) {doc.querySelector('[data-view-pane]').setAttribute('data-view-pane',view);await press(406,'ColorF3Blue');}
 assert.deepEqual([...w.state.actions],['move']);
 console.log('OK – VideoPlayer + webOS: zöld/kék, külön OSD, HTML/provider/Luna CC off és mute');
} finally {w.unmountPlayer();w.close()}
