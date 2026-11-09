#!/usr/bin/env node
// Élő TV watchdog-regresszió: a timer soha nem tölthet újra működő vagy induló csatornát.
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
function Harness({channel,vod}) {const [playing,setPlaying]=useState(true); return <VideoPlayer channel={channel}
  customStreamUrl={vod} settings={{...INITIAL_SETTINGS,bufferMode:'fast'}} isPlaying={playing} setIsPlaying={setPlaying}
  volume={0.5} onVolumeChange={()=>{}} onToggleMute={()=>{}} playbackActive={true}/>}
window.testPlayer={
 mount(channel,vod){if(root)root.unmount();root=createRoot(document.getElementById('root'));root.render(<Harness channel={channel} vod={vod}/>);},
 update(channel){root.render(<Harness channel={channel}/>);},
 unmount(){if(root)root.unmount();root=null;}
};`;
const bundle=await esbuild.build({stdin:{contents:harness,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,
 platform:'browser',format:'iife',jsx:'automatic',nodePaths:[resolve('web/node_modules')],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!/Not implemented/.test(e.message))throw e;});
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(window){
 window.__IPTV_DIRECT_LIVE_ZAP_TEST__=false;
 window.state={ready:0,buffered:false,bufferEnd:2,plays:[],loads:0};
 const p=window.HTMLMediaElement.prototype;
 Object.defineProperty(p,'paused',{configurable:true,get(){return this.__paused??true;}});
 Object.defineProperty(p,'currentSrc',{configurable:true,get(){return this.getAttribute('src')||'';}});
 Object.defineProperty(p,'readyState',{configurable:true,get(){return window.state.ready;}});
 Object.defineProperty(p,'networkState',{configurable:true,get(){return 2;}});
 Object.defineProperty(p,'error',{configurable:true,get(){return null;}});
 Object.defineProperty(p,'buffered',{configurable:true,get(){return window.state.buffered?{length:1,start:()=>0,end:()=>window.state.bufferEnd}:{length:0};}});
 p.play=function(){this.__paused=false;window.state.plays.push(this.getAttribute('src'));return Promise.resolve();};
 p.pause=function(){this.__paused=true;};p.load=function(){window.state.loads++;};p.canPlayType=()=> 'maybe';
 p.getVideoPlaybackQuality=()=>({totalVideoFrames:Date.now()});
 window.fetch=()=>new Promise(()=>{});
}});
const {window}=dom,doc=window.document;
const script=doc.createElement('script');script.textContent=bundle.outputFiles[0].text;doc.body.appendChild(script);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let serial=0;
async function mount(ext='m3u8',ready=0,vod) {
 window.testPlayer.unmount();await wait(30);window.localStorage.clear();
 window.state.ready=ready;window.state.buffered=false;window.state.bufferEnd=2;window.state.plays=[];window.state.loads=0;
 const id=`case-${++serial}`;const channel={id,name:id,streamUrl:`http://example.invalid/live/${id}.${ext}`};
 window.testPlayer.mount(channel,vod);
 for(let i=0;i<100&&!window.state.plays.length;i++)await wait(10);
 assert.ok(window.state.plays.length>=1,'initial live play');
 return doc.querySelector('video[data-iptv-player="true"]');
}
try {
 let video=await mount('m3u8',0);
 await wait(1300);
 assert.equal(window.state.plays.length,1,'élő HLS: nincs időzített újrapróbálkozás');
 assert.equal(window.state.loads,1,'élő HLS: nincs watchdog miatti újratöltés');
 video=await mount('ts',0);
 await wait(1300);
 assert.equal(window.state.plays.length,1,'élő TS: nincs időzített újrapróbálkozás');
 assert.equal(window.state.loads,1,'élő TS: nincs watchdog miatti újratöltés');
 video=await mount('m3u8',4);
 await wait(700);
 assert.equal(window.state.plays.length,1,'dekódolható médiaadatnál sem történik automatikus váltás');
 fire(video,'playing');
 const target={id:'fresh-target',name:'fresh-target',streamUrl:'http://example.invalid/live/fresh-target.ts'};
 window.testPlayer.update(target);
 await wait(300);
 assert.match(doc.querySelector('video[data-iptv-player="true"]').getAttribute('src'),/fresh-target\.ts$/,'a kézi csatornaváltás működik');
 video=await mount('m3u8',0,'http://example.invalid/movie/example.mkv');
 await wait(600);
 assert.match(window.state.plays[0],/example\.mkv$/,'a VOD továbbra is a saját címét használja');
 console.log('OK – élő TV: nincs startup/buffer/stall watchdog vagy időzített újratöltés; kézi váltás és VOD megmarad');
} finally {window.testPlayer.unmount();window.close();}

function fire(video,name){video.dispatchEvent(new window.Event(name,{bubbles:true}));}
