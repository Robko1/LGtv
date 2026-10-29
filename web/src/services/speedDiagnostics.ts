/** Célzott, eseményalapú mérések. Nincs hálózati próba vagy folyamatos mintavétel. */
import { appLog, isVerbosePlaybackLogging, registerLoggingLifecycleHooks } from './appLog';
import { fsAbort, resetFullscreenPerf } from './fullscreenPerf';

type Trace = {
  id: number; mode: 'élő' | 'VOD'; start: number; last: number; load: number;
  playing: boolean; frame: 'untried' | 'pending' | 'reported' | 'unavailable';
  waiting: number | null; mediaReady: boolean; expectedUrl: string;
  position: number | null; positionAt: number; targetId: string; uiFramesScheduled: boolean;
  loadAt: number; resourceReported: boolean;
};
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, meta: { mediaTime?: number; presentedFrames?: number }) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};
let frameRequest: { video: FrameVideo; id: number; timer: number | null } | null = null;
function cancelFrameRequest(): void {
  if (!frameRequest) return;
  if (frameRequest.timer !== null) window.clearTimeout(frameRequest.timer);
  try { frameRequest.video.cancelVideoFrameCallback?.(frameRequest.id); } catch { /* régi motor */ }
  frameRequest = null;
}
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
export function speedSelect(mode: 'élő' | 'VOD', title: string, useKey = true, targetId = ''): void {
  if (!isVerbosePlaybackLogging()) return;
  const t = now();
  if (trace && !trace.playing) line('előző indítás megszakítva', 'új kiválasztás');
  else if (trace?.frame === 'pending') line('előző képkocka-visszajelzés lezárva', 'a következő kiválasztásig nem érkezett meg');
  cancelFrameRequest();
  const key = useKey && lastKey && /^(OK|csatorna\+|csatorna−)$/.test(lastKey.name) && t - lastKey.at < 500 ? lastKey : null;
  lastKey = null;
  trace = { id: ++serial, mode, start: key ? key.at : t, last: key ? key.at : t, load: 0, playing: false, frame: 'untried', waiting: null, mediaReady: false, expectedUrl: '', position: null, positionAt: 0, targetId, uiFramesScheduled: false, loadAt: 0, resourceReported: false };
  line('kiválasztás kezelése', `cím=${title.slice(0, 80)}; bemenet=${key ? key.name : 'ismeretlen/kattintás'}; kezdet=${key ? 'keydown-kezelés' : 'kiválasztás'}`);
}

/** Egy forrásbetöltés/újrapróba kezdete; URL-t és belépési adatot sosem írunk. */
export function speedLoad(mode: 'élő' | 'VOD', detail: string, url = ''): void {
  if (!isVerbosePlaybackLogging()) return;
  if (!trace || trace.mode !== mode) speedSelect(mode, 'automatikus betöltés', false);
  if (!trace) return;
  if (trace.frame === 'pending') line('előző próbához képkocka-visszajelzés nem érkezett', 'új forráspróba indul');
  cancelFrameRequest();
  trace.load += 1;
  trace.loadAt = now();
  trace.resourceReported = false;
  trace.mediaReady = true;
  try { trace.expectedUrl = url ? new URL(url, window.location.href).href : ''; } catch { trace.expectedUrl = url; }
  trace.position = null;
  trace.positionAt = 0;
  trace.playing = false;
  trace.frame = 'untried';
  trace.waiting = null;
  line('forrásbetöltés', `próba=${trace.load}; ${detail}`);
}
export function speedStep(label: string, detail = ''): void { line(label, detail); }

/** Kizárólag a kiválasztott csatorna commitját mérjük, nem minden React-rendert. */
export function speedChannelCommit(label: string, targetId?: string): void {
  if (!isVerbosePlaybackLogging() || !trace || trace.mode !== 'élő' || !trace.targetId || trace.targetId !== targetId) return;
  const current = trace;
  line(label);
  if (label !== 'főoldal React commit' || current.uiFramesScheduled) return;
  current.uiFramesScheduled = true;
  window.requestAnimationFrame(() => {
    if (trace !== current || !isVerbosePlaybackLogging()) return;
    line('első renderelési lehetőség a csatorna commit után', 'nem a panel tényleges festése');
    window.requestAnimationFrame(() => {
      if (trace === current && isVerbosePlaybackLogging()) line('második renderelési lehetőség a csatorna commit után', 'nem a panel tényleges festése');
    });
  });
}

/** Az aszinkron play() csak a saját, még aktív forráspróbájához kerülhet. */
export function speedAttemptObserver(): ((label: string, detail?: string) => void) | null {
  if (!isVerbosePlaybackLogging() || !trace) return null;
  const current = trace, attempt = trace.load;
  return (label, detail = '') => {
    if (trace === current && trace.load === attempt && isVerbosePlaybackLogging()) line(label, `próba=${attempt}${detail ? '; ' + detail : ''}`);
  };
}

function requestFrame(video: FrameVideo, sourceEvent: string): void {
  if (!trace || trace.frame !== 'untried') return;
  const current = trace, attempt = current.load;
  if (typeof video.requestVideoFrameCallback !== 'function') {
    current.frame = 'unavailable';
    line('képkocka-visszajelzés nem támogatott', 'playing/loadeddata nem bizonyít képet; a panel megjelenítése nem mérhető');
    return;
  }
  current.frame = 'pending';
  try {
    const id = video.requestVideoFrameCallback((_time, meta) => {
      if (trace !== current || trace.load !== attempt || !isVerbosePlaybackLogging()) return;
      if (current.expectedUrl && video.currentSrc && current.expectedUrl !== video.currentSrc) return;
      if (frameRequest?.timer !== null && frameRequest) window.clearTimeout(frameRequest.timer);
      frameRequest = null;
      current.frame = 'reported';
      const time = Number.isFinite(meta?.mediaTime) ? `; médiaidő=${Number(meta.mediaTime).toFixed(2)} s` : '';
      line('megfigyelt képkocka a kompozitornak átadva', `próba=${attempt}; kérés=${sourceEvent}${time}; nem bizonyítja a panel megjelenését vagy a legelső képkockát`);
    });
    const timer = window.setTimeout(() => {
      if (trace === current && trace.load === attempt && current.frame === 'pending' && isVerbosePlaybackLogging()) {
        line('képkocka-visszajelzés nem érkezett', `próba=${attempt}; kérés=${sourceEvent}; a kép tényleges megjelenése nem mérhető`);
      }
      if (frameRequest?.id === id) frameRequest.timer = null;
    }, 3000);
    frameRequest = { video, id, timer };
  } catch {
    current.frame = 'unavailable';
    line('képkocka-visszajelzés nem mérhető', 'a TV visszautasította a kérést; a panel megjelenítése nem igazolható');
  }
}

/** A natív médiamotor nem köteles Resource Timing adatot szolgáltatni.
 * Csak a már kért pontos URL bejegyzését nézzük, nincs új hálózati kérés. */
function reportResourceTiming(): void {
  if (!trace || !trace.load || trace.resourceReported) return;
  trace.resourceReported = true;
  try {
    const entries = trace.expectedUrl && typeof performance.getEntriesByName === 'function'
      ? performance.getEntriesByName(trace.expectedUrl, 'resource') as PerformanceResourceTiming[] : [];
    const entry = entries.filter(item => item.startTime >= trace!.loadAt).pop();
    if (!entry) {
      line('hálózati részidők nem érhetők el', 'a natív streamkérés nem szerepel a böngésző Resource Timing adatai között');
    } else if (!(entry.responseStart > 0)) {
      line('hálózati részidők korlátozottak', 'a válaszidők nem láthatók; kereszt-origin vagy a TV korlátozhatja');
    } else {
      const response = ms(entry.responseStart - entry.startTime);
      const transfer = entry.responseEnd >= entry.responseStart ? `${ms(entry.responseEnd - entry.responseStart)} ms` : 'nem mérhető';
      line('böngészős erőforrás-időzítés', `első válaszig=${response} ms; válaszátvitel=${transfer}; URL-egyezés, nem bizonyít teljes HLS/szegmens-időt vagy próbához tartozást`);
    }
  } catch {
    line('hálózati részidők nem érhetők el', 'Resource Timing nem támogatott');
  }
}

const events = ['timeupdate', 'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'error', 'ended', 'seeking', 'seeked', 'play', 'pause', 'abort', 'emptied'];
function mediaEvent(event: Event): void {
  const video = event.target as HTMLVideoElement;
  if (!trace || !trace.mediaReady || !video || video.tagName !== 'VIDEO' || video.getAttribute('data-iptv-player') !== 'true') return;
  // A régi forrás késői eseménye ne számítson az új próbához. Azonos
  // elem/azonos URL újratöltésénél a motor nem ad biztos generáció-azonosítót.
  if (trace.expectedUrl && video.currentSrc && trace.expectedUrl !== video.currentSrc) return;
  if (trace.expectedUrl && video.getAttribute('src') && trace.expectedUrl !== video.src) return;
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
  if (event.type === 'playing' || event.type === 'error') reportResourceTiming();
  if (event.type === 'playing') trace.playing = true;
  if (event.type === 'loadeddata' || event.type === 'playing') requestFrame(video, event.type);
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
        trace = { id: ++serial, mode: video.getAttribute('data-iptv-mode') === 'VOD' ? 'VOD' : 'élő', start: t, last: t, load: 0, playing: true, frame: 'reported', waiting: null, mediaReady: true, expectedUrl: '', position: null, positionAt: 0, targetId: '', uiFramesScheduled: false, loadAt: 0, resourceReported: false };
        line('már futó lejátszás megfigyelése', 'a tényleges indítás a naplózás előtt történt');
      }
    },
    onStop: () => {
      if (trace && !trace.playing) line('mérés lezárva', 'első playing nem érkezett');
      else if (trace?.frame === 'pending') line('mérés lezárva', 'képkocka-visszajelzés nem érkezett');
      cancelFrameRequest();
      fsAbort('a naplózás leállt');
      events.forEach((name) => document.removeEventListener(name, mediaEvent, true));
      document.removeEventListener('keydown', keyDown, true);
      session += 1; trace = null; lastKey = null;
    },
  });
}
