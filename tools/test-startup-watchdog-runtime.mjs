#!/usr/bin/env node
// A tényleges React VideoPlayer indítási őre: az 1200ms-os határidőket
// rövidítjük, hogy a különböző timeout/hiba-versenyek determinisztikusak legyenek.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
const esbuild=createRequire(resolve('web/package.json'))('esbuild');
const harness=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {VideoPlayer} from './web/src/components/VideoPlayer';
import {INITIAL_SETTINGS} from './web/src/data/mockData';
let root;
function Harness({channel, vod}) {const [playing,setPlaying]=useState(true); return <VideoPlayer channel={channel}
  customStreamUrl={vod} settings={{...INITIAL_SETTINGS,bufferMode:'fast'}} isPlaying={playing} setIsPlaying={setPlaying}
  volume={0.5} onVolumeChange={()=>{}} onToggleMute={()=>{}} playbackActive={true}/>}
window.testPlayer={
 mount(channel,vod){ if(root)root.unmount(); root=createRoot(document.getElementById('root')); root.render(<Harness channel={channel} vod={vod}/>); },
 update(channel){ root.render(<Harness channel={channel}/>); },
 unmount(){ if(root)root.unmount(); root=null; }
};`;
const bundle=await esbuild.build({stdin:{contents:harness,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,
 platform:'browser',format:'iife',jsx:'automatic',nodePaths:[resolve('web/node_modules')],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const vc=new VirtualConsole(); vc.on('jsdomError',e=>{if(!/Not implemented/.test(e.message))throw e;});
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(window){
 window.__IPTV_ANDROID_STYLE_LIVE_ZAP_TEST__ = false; // a watchdog/fallback regressziós tesztjeihez
 const set=window.setTimeout.bind(window); window.setTimeout=(fn,ms,...args)=>set(fn,ms===1200?150:ms,...args);
 window.state={ready:0,buffered:false,plays:[],loads:0}; const p=window.HTMLMediaElement.prototype;
 Object.defineProperty(p,'paused',{configurable:true,get(){return this.__paused??true;}});
 Object.defineProperty(p,'currentSrc',{configurable:true,get(){return this.getAttribute('src')||'';}});
 Object.defineProperty(p,'readyState',{configurable:true,get(){return window.state.ready;}});
 Object.defineProperty(p,'networkState',{configurable:true,get(){return 2;}});
 Object.defineProperty(p,'error',{configurable:true,get(){return null;}});
 Object.defineProperty(p,'buffered',{configurable:true,get(){return window.state.buffered?{length:1,start:()=>0,end:()=>2}:{length:0};}});
 p.play=function(){this.__paused=false;window.state.plays.push(this.getAttribute('src'));return Promise.resolve();};
 p.pause=function(){this.__paused=true;};p.load=function(){window.state.loads++;};p.canPlayType=()=> 'maybe';
 p.getVideoPlaybackQuality=()=>({totalVideoFrames:Date.now()});window.fetch=()=>new Promise(()=>{});
}});
const {window}=dom,doc=window.document;
const script=doc.createElement('script');script.textContent=bundle.outputFiles[0].text;doc.body.appendChild(script);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async (predicate,label)=>{for(let i=0;i<150;i++){if(predicate())return;await wait(10);}assert.fail(label);};
let serial=0;
async function mount(ext='m3u8',ready=0,vod) {
 window.testPlayer.unmount();await wait(30);window.localStorage.clear();window.state.ready=ready;window.state.buffered=false;window.state.plays=[];window.state.loads=0;
 const id=`case-${++serial}`;const channel={id,name:id,streamUrl:`http://example.invalid/live/${id}.${ext}`};
 window.testPlayer.mount(channel,vod);await until(()=>window.state.plays.length>=1,'initial play');return doc.querySelector('video[data-iptv-player="true"]');
}
const fire=(video,name)=>video.dispatchEvent(new window.Event(name,{bubbles:true}));
try {
 // A visszaállított működés: az időtúllépett HLS-t először egyszer újrapróbálja,
 // majd csak a következő timeout/hiba után indítja a tartalékot.
 let video=await mount();await until(()=>window.state.plays.length>=2,'HLS timeout retry');
 assert.match(window.state.plays[0],/\.m3u8$/);assert.match(window.state.plays[1],/\.m3u8$/);
 fire(video,'error');await until(()=>window.state.plays.length>=3,'TS fallback');
 assert.match(window.state.plays[2],/\.ts$/);
 // Failure of the TS fallback still leaves the primary HLS available to recovery.
 fire(video,'error');await until(()=>window.state.plays.length>=4,'primary HLS recovery');
 assert.match(window.state.plays[3],/\.m3u8$/);fire(video,'playing');
 // A buffered HLS is not interrupted by the initial watchdog: playing during
 // the existing grace period cancels the pending transition.
 video=await mount('m3u8',4);await wait(200);assert.equal(window.state.plays.length,1);
 fire(video,'playing');await wait(280);assert.equal(window.state.plays.length,1,'playing alatt nincs fallback');
 // Even after grace expires the original same-format retry is preserved.
 video=await mount('m3u8',4);await until(()=>window.state.plays.length>=2,'HLS grace timeout retry');
 assert.match(window.state.plays[1],/\.m3u8$/);assert.equal(window.state.plays.length,2);fire(video,'playing');
 // Actual HLS media errors still receive the original same-format retry.
 video=await mount();fire(video,'error');await until(()=>window.state.plays.length>=2,'HLS error retry');
 assert.match(window.state.plays[1],/\.m3u8$/);fire(video,'playing');
 // TS timeouts keep the original retry, protecting previously observed cases.
 video=await mount('ts');await until(()=>window.state.plays.length>=2,'TS timeout retry');
 assert.match(window.state.plays[1],/\.ts$/);fire(video,'playing');
 // No fabricated fallback for URLs without a recognized stream extension.
 video=await mount('plain');await until(()=>window.state.plays.length>=2,'single URL recovery');
 assert.equal(window.state.plays[0],window.state.plays[1]);fire(video,'playing');
 // A timer from a superseded HLS must not change the newly selected channel.
 video=await mount();
 const target={id:'fresh-target',name:'fresh-target',streamUrl:'http://example.invalid/live/fresh-target.ts'};
 window.testPlayer.update(target);await until(()=>video.getAttribute('src')?.includes('fresh-target.ts'),'rapid zap');
 fire(video,'playing');await wait(400);
 assert.equal(window.state.plays.length,2,'korábbi csatorna őre nem indíthat extra betöltést');
 assert.match(video.getAttribute('src'),/fresh-target\.ts$/);
 // VOD remains on its original address and does not use the live startup guard.
 video=await mount('m3u8',0,'http://example.invalid/movie/example.mkv');await wait(600);
 assert.equal(window.state.plays.length,1);assert.match(window.state.plays[0],/example\.mkv$/);
 console.log('OK – valós VideoPlayer: visszaállított HLS újrapróba, türelmi idő, hibák, TS, recovery és VOD');
} finally {window.testPlayer.unmount();window.close();}
