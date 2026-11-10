#!/usr/bin/env node
/*
 * 2.5.419 – ÉLŐ ADÁS SZOLGÁLTATÓNKÉNTI EGÉSZSÉG-EMLÉKEZETE (tiszta logika).
 *
 * A tényleges forrást (web/src/services/liveStreamHealth.ts) futtatja, és a
 * #66-os TV-napló (2.5.418, valódi LG TV) mért idővonalait játssza vissza:
 *
 *   1. szolgáltató: a HLS minden hosszabb nézésnél ~50 mp után MEDIA_ERR 3-mal
 *      elhalt (HBO UHD, MOZIVERZUM, MOZIKLUB), a TS 146–159 mp-ig hibátlan.
 *   2. szolgáltató: minden csatornán 10 mp adat, utána 8,6–16,7 mp megállás
 *      ~7–8 mp-es pozíciónál, majd gyakran egy második, 1,5–2,3 mp-es megállás.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(String(key), String(value)); },
  removeItem: (key) => { store.delete(String(key)); },
};

const esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
const outDir = path.resolve('build/test');
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'live-stream-health.mjs');
await esbuild.build({
  entryPoints: [path.resolve('web/src/services/liveStreamHealth.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
});
const h = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);

let passed = 0;
function check(condition, label, detail = '') {
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const P1 = h.streamHostKey('http://line.liondnscloud.ru/live/user/pass/1234.m3u8');
const P2 = h.streamHostKey('http://162.19.241.120:8080/live/user/pass/77.ts');

console.log('\n=== 1. A szolgáltató-kulcs ===\n');
check(P1 === 'line.liondnscloud.ru' && P2 === '162.19.241.120:8080', 'a kulcs a stream-cím hosztja (porttal), felhasználónév/jelszó nélkül', `${P1} | ${P2}`);
check(h.streamHostKey('http://user:pw@Host.Example:8080/x.ts') === 'host.example:8080' && h.streamHostKey('') === '' && h.streamHostKey('nem-url') === '',
  'kisbetűs, hitelesítő adat nélküli; érvénytelen címre üres');

console.log('\n=== 2. Formátum-egészség: az 1. szolgáltató elhaló HLS-e ===\n');
h.resetLiveStreamHealth();
check(!h.isFormatDistrusted(P1, 'hls') && !h.isFormatDistrusted(P1, 'ts'), 'ismeretlen szolgáltatón egyik formátum sem megbízhatatlan');
check(h.isEarlyFormatDeath(52_000) && h.isEarlyFormatDeath(69_000) && !h.isEarlyFormatDeath(200_000),
  'az ~52 mp utáni HLS-hiba korai elhalás; a 3 percnél hosszabb jó nézés utáni megszakadás nem az');
h.recordFormatDeath(P1, 'hls');
check(!h.isFormatDistrusted(P1, 'hls'), 'EGYETLEN elhalás még nem bélyegzi meg a formátumot (lehet hálózati zavar)');
check(h.shouldSwitchFormatAfterDeath({ host: P1, format: 'hls', healthyPlaybackMs: 52_000, hasAlternative: true }) === false,
  'az ELSŐ kiesés után ugyanarra a címre megyünk vissza (egy pillanatnyi zavar nem indít formátumugrást)');
h.recordFormatDeath(P1, 'hls');
check(h.shouldSwitchFormatAfterDeath({ host: P1, format: 'hls', healthyPlaybackMs: 52_000, hasAlternative: true }) === true,
  'a MÁSODIK korai elhalás után az újracsatlakozás a másik formátummal történik');
check(h.shouldSwitchFormatAfterDeath({ host: P1, format: 'hls', healthyPlaybackMs: 52_000, hasAlternative: false }) === false
  && h.shouldSwitchFormatAfterDeath({ host: P1, format: 'hls', healthyPlaybackMs: 600_000, hasAlternative: true }) === false,
  'nincs formátumváltás, ha nincs másik formátum, vagy az adás előtte sokáig hibátlan volt');
check(h.isFormatDistrusted(P1, 'hls') && !h.isFormatDistrusted(P1, 'ts'), 'KÉT elhalás után a HLS ezen a szolgáltatón megbízhatatlan, a TS nem');
check(!h.isFormatDistrusted(P2, 'hls'), 'a másik szolgáltatót ez nem érinti');
let choice = h.chooseHealthyStartFormat({ host: P1, format: 'hls', hasAlternative: true });
check(choice.changed && choice.format === 'ts' && /2 alkalommal elhalt/.test(choice.reason), 'a megbízhatatlan HLS helyett TS indul, indoklással', choice.reason);
choice = h.chooseHealthyStartFormat({ host: P1, format: 'ts', hasAlternative: true });
check(!choice.changed && choice.format === 'ts', 'a TS-t nem bántjuk');
choice = h.chooseHealthyStartFormat({ host: P1, format: 'hls', hasAlternative: true, userForced: true });
check(!choice.changed && choice.format === 'hls', 'a néző KÉZZEL beállított formátumát nem írjuk felül');
choice = h.chooseHealthyStartFormat({ host: P1, format: 'hls', hasAlternative: false });
check(!choice.changed, 'másik formátum nélkül nincs csere');
// A TS a naplóban 146, 146 és 159 mp-ig hibátlan volt, egyszer némán megállt (az nem formátum-elhalás).
h.recordFormatStable(P1, 'ts'); h.recordFormatStable(P1, 'ts'); h.recordFormatStable(P1, 'ts');
h.recordFormatDeath(P1, 'ts'); h.recordFormatDeath(P1, 'ts');
check(!h.isFormatDistrusted(P1, 'ts'), 'a többször bizonyított TS két kiesés után is megbízható marad (nem pattogunk a formátumok között)');
check(h.shouldSwitchFormatAfterDeath({ host: P1, format: 'ts', healthyPlaybackMs: 39_000, hasAlternative: true }) === false,
  'megbízhatatlan másik formátumra (HLS) akkor sem váltunk, ha a TS elhal');
// A HLS megjavul: tartós lejátszások után újra megbízható.
h.recordFormatStable(P1, 'hls');
check(!h.isFormatDistrusted(P1, 'hls'), 'egy tartósan hibátlan HLS-nézés után a HLS újra megbízható (a tanulás visszafordítható)');
h.resetLiveStreamHealth();
h.recordFormatDeath(P1, 'hls'); h.recordFormatDeath(P1, 'hls'); h.recordFormatDeath(P1, 'ts'); h.recordFormatDeath(P1, 'ts');
choice = h.chooseHealthyStartFormat({ host: P1, format: 'hls', hasAlternative: true });
check(!choice.changed && /mindkét formátum/.test(choice.reason), 'ha mindkét formátum megbízhatatlan, nincs értelmetlen csere', choice.reason);

console.log('\n=== 3. Indulási adathiány: a 2. szolgáltató mért megállásai ===\n');
h.resetLiveStreamHealth();
/** Idővonal visszajátszása: [mikortól (ms), meddig (ms)] megállások, 250 ms-os mintavétellel. */
function replay(stalls, totalMs = 60_000) {
  const observer = new h.StartFlowObserver();
  observer.begin(0, 0);
  let pos = 0;
  const events = [];
  for (let now = 250; now <= totalMs; now += 250) {
    const stalled = stalls.some(([from, to]) => now > from && now <= to);
    if (!stalled) pos += 0.25;
    const event = observer.observe({ now, currentTime: pos, paused: false });
    if (event.kind !== 'none') events.push(event);
  }
  return events;
}
// #66: megállás ~7 mp-cel a kép után, 8,6–16,7 mp hosszan; utána 1,5–2,3 mp-es második megállás.
for (const [stallMs, second] of [[8600, 1500], [11_700, 2300], [16_700, 0], [14_000, 6800]]) {
  const events = replay([[7000, 7000 + stallMs], ...(second ? [[7000 + stallMs + 9000, 7000 + stallMs + 9000 + second]] : [])]);
  check(events.length === 1 && events[0].kind === 'starved' && Math.abs(events[0].stallMs - stallMs) <= 300,
    `${(stallMs / 1000).toFixed(1)} mp-es indulási megállás: pontosan EGY „adathiány” megfigyelés, a mért hossz stimmel`, JSON.stringify(events));
}
check(JSON.stringify(replay([])) === JSON.stringify([{ kind: 'smooth' }]), 'megállás nélküli 30 mp → egy „sima indulás” megfigyelés');
check(JSON.stringify(replay([[8000, 10_500], [18_000, 20_000]])) === JSON.stringify([{ kind: 'smooth' }]),
  'a 4 mp-nél rövidebb újrapufferelés (2,5 és 2 mp) NEM adathiány');
check(replay([[45_000, 60_000]], 90_000).every((event) => event.kind === 'smooth'),
  'az indulási ablak (20 mp) UTÁNI megállás nem indulási adathiány (azt az élő őr kezeli)');
check(replay([[7000, 200_000]], 120_000).length === 0, 'a magától meg NEM oldódó megállás nem megfigyelés (azt az élő őr csatlakoztatja újra)');
{
  const observer = new h.StartFlowObserver();
  observer.begin(0, 0);
  let events = 0;
  for (let now = 250; now <= 40_000; now += 250) if (observer.observe({ now, currentTime: 0, paused: true }).kind !== 'none') events += 1;
  check(events === 0, 'szünet alatt (a néző kérte) nincs sem adathiány-, sem sima-megfigyelés');
}

console.log('\n=== 4. Indulási puffer-terv ===\n');
h.resetLiveStreamHealth();
check(h.startCushionPlan(P2) === null, 'tanulás nélkül nincs tartás');
h.recordStartStarvation(P2, 8600);
check(h.startCushionPlan(P2) === null, 'EGY megfigyelés után még nincs tartás');
h.recordStartStarvation(P2, 16_700);
let plan = h.startCushionPlan(P2);
check(plan !== null && plan.holdMs === 18_700 && plan.targetAheadSeconds === 15,
  'KÉT megfigyelés után: tartás = a mért leghosszabb megállás + 2 mp (18,7 mp), cél 15 mp puffer', JSON.stringify(plan));
h.recordStartStarvation(P2, 55_000);
plan = h.startCushionPlan(P2);
check(plan.holdMs === h.START_CUSHION_MAX_MS && plan.holdMs === 20_000, 'a tartás soha nem hosszabb 20 mp-nél', JSON.stringify(plan));
check(h.startCushionPlan(P1) === null, 'a másik szolgáltatón nincs tartás');
check(h.startCushionDecision({ elapsedMs: 3000, plan, aheadSeconds: 10 }) === 'hold'
  && h.startCushionDecision({ elapsedMs: 3000, plan, aheadSeconds: 20 }) === 'release-buffer'
  && h.startCushionDecision({ elapsedMs: 20_000, plan, aheadSeconds: 10 }) === 'release-time'
  && h.startCushionDecision({ elapsedMs: 20_000, plan, aheadSeconds: null }) === 'release-time'
  && h.startCushionDecision({ elapsedMs: 500, plan, aheadSeconds: null }) === 'hold',
  'döntés: 10 mp pufferrel tart, 20 mp pufferrel azonnal indít, a tanult idő letelte után mindenképp indít');
// Megjavult szolgáltató: a sima indulások kikapcsolják.
h.recordSmoothStart(P2); h.recordSmoothStart(P2);
check(h.startCushionPlan(P2) === null, 'két sima indulás után a tartás megszűnik (3 megfigyelés → 1, 2 sima)', JSON.stringify(h.readHostHealth(P2)));
h.resetLiveStreamHealth();
h.recordStartStarvation(P2, 9000); h.recordStartStarvation(P2, 9000);
h.markStartCushionBroken(P2);
h.recordStartStarvation(P2, 9000);
check(h.startCushionPlan(P2) === null, 'ha a tartás ezen a TV-n nem működött, többé nem próbáljuk');

console.log('\n=== 5. Tartósság és hibatűrés ===\n');
h.resetLiveStreamHealth();
h.recordFormatDeath(P1, 'hls'); h.recordFormatDeath(P1, 'hls');
h.forgetLiveStreamHealthCache();
check(h.isFormatDistrusted(P1, 'hls'), 'a tanulás túléli az alkalmazás újraindítását (localStorage)');
store.set('iptv_rt_live_stream_health_v1', '{sérült');
h.forgetLiveStreamHealthCache();
check(!h.isFormatDistrusted(P1, 'hls') && h.startCushionPlan(P2) === null, 'sérült tár: üres emlékezet, nincs kivétel');
h.resetLiveStreamHealth();
for (let index = 0; index < 60; index++) h.recordFormatDeath(`host-${index}.example`, 'hls', 1000 + index);
h.forgetLiveStreamHealthCache();
check(Object.keys(JSON.parse(store.get('iptv_rt_live_stream_health_v1'))).length === 40 && h.readHostHealth('host-59.example').hlsDeaths === 1
  && h.readHostHealth('host-0.example').hlsDeaths === 0, 'legfeljebb 40 szolgáltató-hoszt marad meg, a legrégebbiek esnek ki');
for (let index = 0; index < 50; index++) h.recordFormatDeath(P1, 'hls');
check(h.readHostHealth(P1).hlsDeaths === 12, 'a számlálók korlátosak (12): a tanulás mindig visszafordítható marad');

console.log(`\n=== EREDMÉNY: ${passed}/${passed} ellenőrzés ===`);
console.log('OK: a formátum-egészség és az indulási puffer döntései a #66-os napló mért idővonalain helyesek.');
