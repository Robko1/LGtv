#!/usr/bin/env node
// Real ChannelList + VideoPlayer + webOS capture; the small harness models
// App's state selection/commit without booting an actual provider or TV.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
const esbuild = createRequire(resolve('web/package.json'))('esbuild');
const harness = `
import React, {useState, useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {ChannelList} from './web/src/components/ChannelList';
import {VideoPlayer} from './web/src/components/VideoPlayer';
import {INITIAL_SETTINGS} from './web/src/data/mockData';
import {startManualLogging,stopManualLogging,getAppLogText} from './web/src/services/appLog';
import {attachSpeedDiagnostics,speedSelect,speedChannelCommit} from './web/src/services/speedDiagnostics';
attachSpeedDiagnostics();
const channels = [{id:'one',name:'Első',streamUrl:'http://stream.invalid/live/user/secret/one.ts'},
  {id:'two',name:'Második',streamUrl:'http://stream.invalid/live/user/secret/two.ts'}];
function Harness() {
  const [channel,setChannel] = useState(channels[0]);
  const [playing,setPlaying] = useState(true);
  useLayoutEffect(()=>speedChannelCommit('főoldal React commit',channel.id),[channel.id]);
  return <><ChannelList channels={channels} activeProvider={null} epgReady={false} epgRevision={0} selectedChannelId={channel.id}
    onSelectChannel={c=>{speedSelect('élő',c.name,true,c.id);setChannel(c);setPlaying(true);}}
    onToggleFavorite={()=>{}} onDeleteChannel={()=>{}} categories={[]} folders={[]} selectedCategoryId="all"
    isOnlyFavorites={false} selectedFavoriteFolderId={null} onSelectFavoriteFolder={()=>{}}/>
    <VideoPlayer channel={channel} settings={INITIAL_SETTINGS} isPlaying={playing} setIsPlaying={setPlaying} volume={0.5}
      onVolumeChange={()=>{}} onToggleMute={()=>{}} playbackActive={true} /></>;
}
const root=createRoot(document.getElementById('root'));
root.render(<Harness/>);
window.diagTest = {start:startManualLogging,stop:stopManualLogging,log:getAppLogText,unmount:()=>root.unmount()};
`;
const bundle = await esbuild.build({stdin:{contents:harness,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,
  platform:'browser',format:'iife',jsx:'automatic',nodePaths:[resolve('web/node_modules')],
  define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const vc = new VirtualConsole(); vc.on('jsdomError', e => { if (!/navigation|Not implemented/.test(e.message)) throw e; });
const dom = new JSDOM('<!doctype html><html><body class="webos-tv"><div id="root"></div></body></html>',
  {url:'http://localhost/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(window) {
    window.__IPTV_DIRECT_LIVE_ZAP_TEST__ = false; // a régi diagnosztikai/fallback útvonal tesztje
    const proto = window.HTMLMediaElement.prototype;
    Object.defineProperty(proto,'paused',{configurable:true,get(){return this.__paused ?? true;}});
    Object.defineProperty(proto,'currentSrc',{configurable:true,get(){return this.getAttribute('src') || '';}});
    Object.defineProperty(proto,'readyState',{configurable:true,get(){return 4;}});
    Object.defineProperty(proto,'networkState',{configurable:true,get(){return 2;}});
    Object.defineProperty(proto,'error',{configurable:true,get(){return null;}});
    Object.defineProperty(proto,'buffered',{configurable:true,get(){return {length:0};}});
    window.__playCount=0; proto.play=function(){window.__playCount++;this.__paused=false; return Promise.resolve();};
    proto.pause=function(){this.__paused=true;}; proto.load=function(){};
    proto.canPlayType=()=> 'maybe'; proto.getVideoPlaybackQuality=()=>({totalVideoFrames:Date.now()});
    window.fetch=()=>new Promise(()=>{});
    window.HTMLElement.prototype.scrollIntoView=function(){};
    Object.defineProperty(window.HTMLElement.prototype,'clientHeight',{configurable:true,get(){return this.getAttribute('role')==='listbox'?630:40;}});
    window.HTMLElement.prototype.getBoundingClientRect=function(){return {top:0,bottom:630,left:0,right:480,width:480,height:630,x:0,y:0,toJSON(){}};};
  }});
const {window}=dom, doc=window.document;
window.eval(readFileSync(resolve('webos/webos.js'),'utf8'));
const script=doc.createElement('script'); script.textContent=bundle.outputFiles[0].text; doc.body.appendChild(script);
const wait = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn,label) { for(let i=0;i<100;i++){if(fn()) return;await wait(20);} assert.fail(label); }
await until(()=>doc.querySelector('video[data-iptv-player="true"]') && doc.querySelector('[data-channel-id="two"] [role="option"]'),'mount');
await wait(150);
const video=doc.querySelector('video[data-iptv-player="true"]');
const fire=type=>video.dispatchEvent(new window.Event(type,{bubbles:true}));
fire('playing'); window.diagTest.start();
const row=doc.querySelector('[data-channel-id="two"] [role="option"]'); row.focus();
row.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true,cancelable:true}));
await until(()=>video.getAttribute('src')?.includes('two.ts'),'new src'); await wait(50);
let log=window.diagTest.log();
assert.match(log,/kiválasztás kezelése.*bemenet=OK/);
assert.match(log,/lejátszó React commit/); assert.match(log,/főoldal React commit/);
assert.match(log,/forrásbetöltés.*próba=1/); assert.match(log,/src beállítva.*load\(\)=nem/);
assert.match(log,/play\(\) ígéret teljesült/);
fire('loadstart'); fire('loadedmetadata'); fire('loadeddata'); fire('playing'); await wait(50);
log=window.diagTest.log();
assert.match(log,/média loadedmetadata/); assert.match(log,/média playing/);
assert.match(log,/képkocka-visszajelzés nem támogatott/);
assert.match(log,/hálózati részidők nem érhetők el/);
assert.match(log,/összes-betöltés=1/);
assert.doesNotMatch(log,/stream\.invalid|\/user\/secret\//);
// A format error az eredeti logika szerint egyszer ugyanazt, aztán a másik
// formátumot próbálja. Mindhárom betöltés szerepeljen az összesítésben.
const firstRow=doc.querySelector('[data-channel-id="one"] [role="option"]'); firstRow.focus();
firstRow.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true,cancelable:true}));
await until(()=>video.getAttribute('src')?.includes('one.ts'),'retry test new src'); await wait(30);
const plays=window.__playCount; fire('error');
await until(()=>window.__playCount>plays,'same format retry');
assert.ok(video.getAttribute('src').includes('one.ts'));
fire('error'); await until(()=>video.getAttribute('src')?.includes('one.m3u8'),'HLS fallback');
fire('loadeddata'); fire('playing'); await wait(40);
log=window.diagTest.log();
assert.match(log,/ELSŐ FORMÁTUM GYORS ÚJRAPRÓBÁJA/);
assert.match(log,/FORMÁTUM-VISSZAESÉS/);
assert.match(log,/CSATORNAVÁLTÁS ÖSSZESÍTÉS.*összes-betöltés=3/);
window.diagTest.stop('test'); window.diagTest.unmount(); window.close();
console.log('OK – valódi webOS + csatornalista + lejátszó: OK-tól korrelált kézi mérés');
