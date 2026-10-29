#!/usr/bin/env node
// A valódi VOD OSD TV-gombjai, idővonala és hangerője jsdom/React alatt.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
const esbuild = createRequire(resolve('web/package.json'))('esbuild');
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {VodOsd} from './web/src/components/VodOsd';
import {ChannelList} from './web/src/components/ChannelList';
import {storageService} from './web/src/services/storageService';
window.readSettings = () => storageService.getSettings();
window.calls = {mute:0, seeks:[], seekBy:[], volumes:[], play:0, selected:[]};
function Harness() {
 const volume = 0.5;
 return <VodOsd title="Film" currentTime={30} duration={100} isPlaying={true} volume={volume} seekStep={10}
 audioTracks={[]} subtitleTracks={[]} activeSubtitleId={null} menu={null} onMenuChange={()=>{}}
 onTogglePlay={()=>window.calls.play++} onSeekBy={n=>window.calls.seekBy.push(n)} onSeekTo={n=>window.calls.seeks.push(n)}
 onSelectAudio={()=>{}} onSelectSubtitle={()=>{}} onClose={()=>{}}
 onToggleMute={()=>window.calls.mute++}/>;
}
createRoot(document.getElementById('root')).render(<Harness />);
window.mountList = () => {
 const el = document.createElement('div'); document.body.appendChild(el);
 const root = createRoot(el);
 const channels = [{id:'one',name:'First',streamUrl:'https://example.invalid/one.ts'}, {id:'two',name:'Second',streamUrl:'https://example.invalid/two.ts'}];
 root.render(<ChannelList channels={channels} activeProvider={null} epgReady={false} epgRevision={0} selectedChannelId="one"
 onSelectChannel={c=>window.calls.selected.push(c.id)} onToggleFavorite={()=>{}} onDeleteChannel={()=>{}} categories={[]} folders={[]}
 selectedCategoryId="all" isOnlyFavorites={false} selectedFavoriteFolderId={null} onSelectFavoriteFolder={()=>{}}/>);
 window.unmountList = () => root.unmount();
};
`;
const bundle = await esbuild.build({stdin:{contents:harness,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[resolve('web/node_modules')],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const dom = new JSDOM('<div id="root"></div>',{runScripts:'dangerously',pretendToBeVisual:true,url:'http://localhost/'});
const {window} = dom;
window.localStorage.setItem('iptv_rt_settings_v1', JSON.stringify({swipeToZap:true, mirrorLayout:true, preferredAudioLang:'Angol'}));
window.eval(readFileSync(resolve('webos/webos.js'),'utf8'));
const script = window.document.createElement('script'); script.textContent = bundle.outputFiles[0].text; window.document.body.appendChild(script);
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
for (let i=0;i<80 && !window.document.querySelector('[data-vod-osd]');i++) await tick(25);
const doc = window.document;
const restored = window.readSettings();
assert.equal('swipeToZap' in restored, false, 'régi érintésbeállítás törlődik memóriából');
assert.equal(restored.mirrorLayout, true, 'a többi régi beállítás megmarad');
assert.equal(restored.preferredAudioLang, 'Angol');
const get = selector => { const el=doc.querySelector(selector); assert.ok(el,selector); return el; };
get('[data-vod-osd-volume]').click();
assert.equal(window.calls.mute,1,'a némítás azonnali, nincs duplakattintás-időzítő');
assert.equal(doc.querySelector('[data-vod-osd-volume-slider]'), null, 'nincs plusz/csúszka az OSD-ben');
assert.equal(doc.querySelector('[data-vod-volume-range]'), null);
const seek=get('[data-vod-osd-seek]'); seek.focus();
seek.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',keyCode:39,bubbles:true}));
assert.equal(window.calls.seekBy.at(-1),1,'TV nyíllal tekerés továbbra is működik');
seek.getBoundingClientRect=()=>({left:100,width:200});
seek.dispatchEvent(new window.MouseEvent('click',{bubbles:true,clientX:200}));
assert.equal(window.calls.seeks.at(-1),50,'Magic Remote mutatóval a sávon hely választható');
assert.equal(window.calls.play,0,'a hangerő és tekerés nem indítja/szünetelteti a filmet');
let fullscreen = 0;
window.addEventListener('iptv-enter-fullscreen',()=>fullscreen++);
window.mountList();
for (let i=0;i<80 && !doc.querySelector('[data-channel-id="one"] [role="option"]');i++) await tick(25);
get('[data-channel-id="one"] [role="option"]').click();
assert.equal(fullscreen,1,'Magic Remote a nézett csatornán egy OK-val teljes képernyőre vált');
get('[data-channel-id="two"] [role="option"]').click();
assert.deepEqual([...window.calls.selected],['two'],'a másik csatorna Magic Remote-tal kiválasztható');
get('[data-channel-id="one"] [role="option"]').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true}));
assert.equal(fullscreen,2,'a távirányító OK-ja is teljes képernyőt indít');
window.unmountList();
window.close();
const manifest = JSON.parse(readFileSync(resolve('webos/appinfo.json'),'utf8'));
assert.equal(manifest.supportTouchMode,'none');
assert.equal(manifest.splashBackground,'splash-screen.png');
const versionFile = readFileSync(resolve('web/src/appVersion.ts'),'utf8');
assert.match(versionFile, /WEB_VERSION\s*=\s*'[0-9]+\.[0-9]+\.[0-9]+'/);
assert.match(versionFile, /version:\s*'[^']+'/,'a GitHub IPK workflow verziócseréje működőképes');
console.log('OK – webOS + React: TV VOD némítás, plusz nélkül, idővonal és Magic Remote');
