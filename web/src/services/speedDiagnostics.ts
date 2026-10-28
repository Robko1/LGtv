/** Célzott, eseményalapú mérések. Nincs hálózati próba vagy folyamatos mintavétel. */
import { appLog, isVerbosePlaybackLogging, registerLoggingLifecycleHooks } from './appLog';
import { fsAbort, resetFullscreenPerf } from './fullscreenPerf';

type Trace = { id: number; mode: 'élő' | 'VOD'; start: number; last: number; load: number; frame: boolean; waiting: number | null; mediaReady: boolean; expectedUrl: string; position: number | null; positionAt: number };
let trace: Trace | null = null;
let serial = 0;
let lastKey: { at: number; name: string } | null = null;
let session = 0;
let keySerial = 0;
const now = () => typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
const ms = (n: number) => Math.max(0, n).toFixed(1);

function line(label: string, extra = ''): void {
  if (!isVerbosePlaybackLogging() || !trace) return;
  const t = now();
  appLog(`SEBESSÉG #${trace.id}; mód=${trace.mode}; ${label}; teljes=${ms(t - trace.start)} ms; lépésköz=${ms(t - trace.last)} ms${extra ? '; ' + extra : ''}`);
  trace.last = t;
}

/** A kiválasztás kezelésének kezdetén, még a React állapotmódosítás előtt. */
export function speedSelect(mode: 'élő' | 'VOD', title: string, useKey = true): void {
  if (!isVerbosePlaybackLogging()) return;
  const t = now();
  if (trace && !trace.frame) line('előző indítás megszakítva', 'új kiválasztás');
  const key = useKey && lastKey && t - lastKey.at < 500 ? lastKey : null;
  lastKey = null;
  trace = { id: ++serial, mode, start: key ? key.at : t, last: key ? key.at : t, load: 0, frame: false, waiting: null, mediaReady: false, expectedUrl: '', position: null, positionAt: 0 };
  line('kiválasztás kezelése', `cím=${title.slice(0, 80)}; bemenet=${key ? key.name : 'ismeretlen/kattintás'}; kezdet=${key ? 'keydown-kezelés' : 'kiválasztás'}`);
}

/** Egy forrásbetöltés/újrapróba kezdete; URL-t és belépési adatot sosem írunk. */
export function speedLoad(mode: 'élő' | 'VOD', detail: string, url = ''): void {
  if (!isVerbosePlaybackLogging()) return;
  if (!trace || trace.mode !== mode) speedSelect(mode, 'automatikus betöltés', false);
  if (!trace) return;
  trace.load += 1;
  trace.mediaReady = true;
  try { trace.expectedUrl = url ? new URL(url, window.location.href).href : ''; } catch { trace.expectedUrl = url; }
  trace.position = null;
  trace.frame = false;
  trace.waiting = null;
  line('forrásbetöltés', `próba=${trace.load}; ${detail}`);
}
export function speedStep(label: string, detail = ''): void { line(label, detail); }

const events = ['timeupdate', 'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'error', 'ended', 'seeking', 'seeked', 'play', 'pause', 'abort', 'emptied'];
function mediaEvent(event: Event): void {
  const video = event.target as HTMLVideoElement;
  if (!trace || !trace.mediaReady || !video || video.tagName !== 'VIDEO' || video.getAttribute('data-iptv-player') !== 'true') return;
  // A régi forrás késői eseménye ne számítson az új próbához. Azonos
  // elem/azonos URL újratöltésénél a motor nem ad biztos generáció-azonosítót.
  if (trace.expectedUrl && video.currentSrc && trace.expectedUrl !== video.currentSrc) return;
  const t = now();
  if (event.type === 'timeupdate') {
    if (t - trace.positionAt < 1000) return;
    const position = Number(video.currentTime || 0);
    if (trace.position !== null && position < trace.position - 2 && !video.seeking) {
      line('váratlan pozíció-visszaugrás', `előző=${trace.position.toFixed(2)} s; új=${position.toFixed(2)} s; ok=nem ismert`);
    }
    trace.position = position; trace.positionAt = t;
    return;
  }
  if (event.type === 'seeked') { trace.position = Number(video.currentTime || 0); trace.positionAt = t; }
  let ahead = 'n/a';
  try {
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) {
        ahead = (video.buffered.end(i) - video.currentTime).toFixed(2) + ' s'; break;
      }
    }
  } catch { /* a motor nem ad pufferadatot */ }
  let extra = `próba=${trace.load}; pozíció=${Number(video.currentTime || 0).toFixed(2)} s; puffer-előre=${ahead}; readyState=${video.readyState}; networkState=${video.networkState}; paused=${video.paused}; seeking=${video.seeking}; hiba=${video.error ? video.error.code : 'nincs'}`;
  if ((event.type === 'waiting' || event.type === 'stalled') && trace.waiting === null) trace.waiting = t;
  if (event.type === 'playing' && trace.waiting !== null) { extra += `; várakozás=${ms(t - trace.waiting)} ms`; trace.waiting = null; }
  line(`média ${event.type}`, extra);
  if (event.type === 'playing' && !trace.frame) {
    trace.frame = true;
    const current = trace;
    const attempt = trace.load;
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
    if (typeof v.requestVideoFrameCallback === 'function') {
      try { v.requestVideoFrameCallback(() => {
        if (trace === current && trace.load === attempt && isVerbosePlaybackLogging()) line('első képkocka a kompozitornak átadva', `próba=${attempt}; a panel megjelenítése nem igazolható`);
      }); } catch { line('első képkocka nem mérhető'); }
    } else line('első képkocka nem mérhető', 'requestVideoFrameCallback nem támogatott; playing nem bizonyít képet');
  }
}
const keyNames: Record<number, string> = { 13: 'OK', 37: 'bal', 38: 'fel', 39: 'jobb', 40: 'le', 33: 'csatorna+', 34: 'csatorna−', 461: 'vissza', 8: 'vissza', 415: 'lejátszás', 19: 'szünet', 412: 'visszatekerés', 417: 'előretekerés' };
function keyDown(event: KeyboardEvent): void {
  const name = keyNames[event.keyCode || event.which];
  if (!name) return;
  const at = now();
  lastKey = { at, name };
  const id = ++keySerial;
  const delay = event.timeStamp > 0 && at >= event.timeStamp && at - event.timeStamp < 60000 ? `${ms(at - event.timeStamp)} ms` : 'nem mérhető';
  appLog(`TÁVIRÁNYÍTÓ #${id}; gomb=${name}; ismétlés=${event.repeat ? 'igen' : 'nem'}; eseménysor-késés=${delay}; fizikai lenyomás nem mérhető`);
  const currentSession = session;
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (currentSession !== session || !isVerbosePlaybackLogging()) return;
    appLog(`TÁVIRÁNYÍTÓ #${id}; második renderelési lehetőség=${ms(now() - at)} ms; fókusz=${document.activeElement?.tagName || 'nincs'}; a művelet tényleges végrehajtása külön mérésben szerepel`);
  }));
}
export function attachSpeedDiagnostics(): void {
  registerLoggingLifecycleHooks({
    onStart: () => {
      session += 1; trace = null; lastKey = null; resetFullscreenPerf();
      document.addEventListener('keydown', keyDown, true);
      events.forEach((name) => document.addEventListener(name, mediaEvent, true));
      const video = document.querySelector<HTMLVideoElement>('video[data-iptv-player="true"]');
      if (video && (video.currentSrc || video.getAttribute('src'))) {
        const t = now();
        trace = { id: ++serial, mode: video.getAttribute('data-iptv-mode') === 'VOD' ? 'VOD' : 'élő', start: t, last: t, load: 0, frame: true, waiting: null, mediaReady: true, expectedUrl: '', position: null, positionAt: 0 };
        line('már futó lejátszás megfigyelése', 'a tényleges indítás a naplózás előtt történt');
      }
    },
    onStop: () => {
      if (trace && !trace.frame) line('mérés lezárva', 'első playing nem érkezett');
      fsAbort('a naplózás leállt');
      events.forEach((name) => document.removeEventListener(name, mediaEvent, true));
      document.removeEventListener('keydown', keyDown, true);
      session += 1; trace = null; lastKey = null;
    },
  });
}
