#!/usr/bin/env node
/*
 * 2.5.419 – ÉLŐ ADÁS SZOLGÁLTATÓNKÉNTI EGÉSZSÉG-EMLÉKEZETE (tiszta logika).
 *
 * A tényleges forrást (web/src/services/liveStreamHealth.ts) futtatja, és a
 * #66-os TV-napló (2.5.418, valódi LG TV) mért idővonalait játssza vissza:
 *
 *   1. szolgáltató: a HLS minden hosszabb nézésnél ~50 mp után MEDIA_ERR 3-mal
 *      elhalt (HBO UHD, MOZIVERZUM, MOZIKLUB), a TS nem.
 *   2. szolgáltató: minden csatornán 10 mp adat, utána 8,6–16,7 mp megállás
 *      ~7–8 mp-es pozíciónál, majd gyakran egy második, 1,5–2,3 mp-es megállás.
 *
 * 2.5.420 – a #67-es napló (2.5.419) a 2. szolgáltató adagjainak pontos
 * érkezését is megadta (TV2 HD, 185 mp): ezeket a 4/b szakasz játssza vissza.
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
// A TS többször tartósan hibátlan volt; a néma megállás nem formátum-elhalás.
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

console.log('\n=== 3. Adatfolyam-megfigyelő: megállások a 2. szolgáltató mért idővonalain ===\n');
h.resetLiveStreamHealth();
/**
 * Idővonal visszajátszása: [mikortól (ms), meddig (ms)] megállások. A megfigyelő másodpercenként
 * kap mintát; `events: true` esetén a megállás elején `waiting`, a végén `playing` esemény is jön
 * (a TV-n ez a szokásos), `false` esetén a megállás „néma” (csak az idővonal áll).
 */
function replay(stalls, { totalMs = 60_000, events = true, pauses = [] } = {}) {
  const tracker = new h.LiveFlowTracker();
  tracker.begin(0, 0);
  let pos = 0;
  let stalledBefore = false;
  const out = [];
  for (let now = 50; now <= totalMs; now += 50) {
    const paused = pauses.some(([from, to]) => now > from && now <= to);
    const stalled = !paused && stalls.some(([from, to]) => now > from && now <= to);
    if (events && stalled && !stalledBefore) tracker.noteWaiting(now, pos);
    if (events && !stalled && stalledBefore) {
      const event = tracker.resumed(now, pos);
      if (event.kind !== 'none') out.push(event);
    }
    stalledBefore = stalled;
    if (!paused && !stalled) pos += 0.05;
    if (now % 1000 === 0) {
      const event = tracker.observe({ now, currentTime: pos, paused, aheadSeconds: 5 });
      if (event.kind !== 'none') out.push(event);
    }
  }
  return { events: out, tracker };
}
// #66/#67: megállás ~7 mp-cel a kép után, 8,6–16,7 mp hosszan; utána 0,3–2,6 mp-es további megállások.
for (const withEvents of [true, false]) {
  for (const [stallMs, second] of [[8600, 1500], [11_500, 2600], [16_700, 0], [14_000, 6800]]) {
    const { events, tracker } = replay(
      [[7000, 7000 + stallMs], ...(second ? [[7000 + stallMs + 9000, 7000 + stallMs + 9000 + second]] : [])],
      { events: withEvents },
    );
    const tolerance = withEvents ? 100 : 1100;
    const first = events[0];
    const later = events.find((event) => event.kind === 'stall' && !event.start);
    check(first && first.kind === 'stall' && first.start === true && Math.abs(first.stallMs - stallMs) <= tolerance
      && events.filter((event) => event.kind === 'stall' && event.start).length === 1
      && (second ? later && Math.abs(later.stallMs - second) <= tolerance && Math.abs(later.extraLagMs - second) <= tolerance : !later)
      && Math.abs(tracker.lagMs - stallMs - second) <= tolerance * 2,
      `${(stallMs / 1000).toFixed(1)} mp-es indulási megállás${second ? ` + ${(second / 1000).toFixed(1)} mp későbbi` : ''} `
      + `(${withEvents ? 'waiting/playing eseményekkel' : 'néma megállás'}): egy indulási adathiány, a hosszak stimmelnek`,
      JSON.stringify(events));
  }
}
check(JSON.stringify(replay([]).events) === JSON.stringify([{ kind: 'smooth' }]), 'megállás nélküli 30 mp → egy „sima indulás” megfigyelés');
{
  const { events } = replay([[8000, 10_500], [18_000, 20_000]]);
  check(events.filter((event) => event.kind === 'stall').every((event) => event.start === false && event.extraLagMs === 0)
    && events.some((event) => event.kind === 'smooth'),
    'a 4 mp-nél rövidebb újrapufferelés (2,5 és 2 mp) NEM indulási adathiány; utána „sima indulás”', JSON.stringify(events));
}
{
  const { events } = replay([[45_000, 60_000]], { totalMs: 90_000 });
  check(events[0].kind === 'smooth' && events.filter((event) => event.kind === 'stall').every((event) => !event.start),
    'az indulási ablak (20 mp) UTÁNI megállás nem indulási adathiány', JSON.stringify(events));
}
check(replay([[7000, 200_000]], { totalMs: 120_000 }).events.length === 0,
  'a magától meg NEM oldódó megállás nem megfigyelés (azt az élő őr csatlakoztatja újra)');
check(replay([], { totalMs: 60_000, pauses: [[5000, 50_000]] }).events.every((event) => event.kind !== 'stall'),
  'a néző szünete (45 mp) nem megállás');
check(replay([[7000, 7300], [12_000, 12_600]]).events.every((event) => event.kind !== 'stall'),
  'a 0,8 mp-nél rövidebb megakadás nem számít megállásnak');
{
  // Hamis `waiting`: a kép közben végig haladt (a webOS szegmenshatáron küld ilyet).
  const tracker = new h.LiveFlowTracker();
  tracker.begin(0, 0);
  tracker.observe({ now: 1000, currentTime: 1, paused: false });
  tracker.noteWaiting(1200, 1.2);
  const event = tracker.resumed(2400, 2.4);
  check(event.kind === 'none', 'hamis `waiting` (a kép közben haladt) után a `playing` nem megállás', JSON.stringify(event));
}
{
  // A szándékos tartás a késleltetésbe számít, de nem megállás; és 2 perc tiszta lejátszás után jön a „tartalék” jelzés.
  const tracker = new h.LiveFlowTracker();
  tracker.begin(0, 0);
  let pos = 0;
  const seen = [];
  for (let now = 1000; now <= 200_000; now += 1000) {
    const stalled = now > 7000 && now <= 18_000;
    const held = now > 18_000 && now <= 24_000;
    if (now === 8000) tracker.noteWaiting(7000, pos);
    if (now === 19_000) { seen.push(tracker.resumed(18_000, pos)); }
    if (now === 25_000) tracker.noteHold(6000, 24_000);
    if (!stalled && !held) pos += 1;
    const event = tracker.observe({ now, currentTime: pos, paused: held, aheadSeconds: now < 100_000 ? 12 : 9 });
    if (event.kind !== 'none') seen.push(event);
  }
  check(seen.length === 2 && seen[0].kind === 'stall' && seen[0].start && seen[0].stallMs === 11_000
    && seen[1].kind === 'spare' && seen[1].minAheadSeconds === 9 && tracker.lagMs === 17_000 && tracker.extraLagMs === 6000 && tracker.starved,
    'a 6 mp-es tartás a késleltetésbe számít (11 + 6 = 17 mp), nem megállás; 2 perc múlva „tartalék” jelzés a legkisebb pufferrel (9 mp)',
    JSON.stringify(seen));
}

console.log('\n=== 4. Késleltetés-tartalék: mikor és mennyit tartunk ===\n');
h.resetLiveStreamHealth();
check(h.liveStallHoldMs({ host: P2, start: true, lagSoFarMs: 11_500 }) === 0 && !h.isBurstyHost(P2), 'tanulás nélkül nincs tartás');
h.recordStartStarvation(P2, 8600);
check(h.liveStallHoldMs({ host: P2, start: true, lagSoFarMs: 8600 }) === 0, 'EGY megfigyelés után még nincs tartás');
h.recordStartStarvation(P2, 11_500);
check(h.isBurstyHost(P2) && h.liveStallHoldMs({ host: P2, start: true, lagSoFarMs: 11_500 }) === 6000,
  'KÉT megfigyelés után az indulási megállás végén 6 mp tartalék jár (alapérték)');
check(h.liveStallHoldMs({ host: P2, start: false, lagSoFarMs: 19_000 }) === 2000, 'későbbi megállás után 2 mp ráhagyás');
check(h.liveStallHoldMs({ host: P2, start: true, lagSoFarMs: 22_000 }) === 3000
  && h.liveStallHoldMs({ host: P2, start: true, lagSoFarMs: 24_800 }) === 0
  && h.liveStallHoldMs({ host: P2, start: false, lagSoFarMs: 30_000 }) === 0,
  'a megállások és tartások összege legfeljebb 25 mp: 22 mp után már csak 3 mp, 25 mp fölött semmi');
check(h.liveStallHoldMs({ host: P1, start: true, lagSoFarMs: 9000 }) === 0 && h.liveStallHoldMs({ host: P1, start: false, lagSoFarMs: 1000 }) === 0,
  'a másik (jól működő) szolgáltatón soha nincs tartás');
h.recordLiveHoldExtra(P2, 9100);
check(h.liveHoldExtraMs(P2) === 9100 && h.liveStallHoldMs({ host: P2, start: true, lagSoFarMs: 11_500 }) === 9100,
  'ha a tartalék kevésnek bizonyult, a szolgáltató tartaléka megnő (6 → 9,1 mp)');
h.recordLiveHoldExtra(P2, 4000);
check(h.liveHoldExtraMs(P2) === 9100, 'kisebb mérés nem csökkenti a tanult tartalékot');
h.recordLiveHoldExtra(P2, 60_000);
check(h.liveHoldExtraMs(P2) === h.LIVE_HOLD_MAX_EXTRA_MS && h.LIVE_HOLD_MAX_EXTRA_MS === 12_000, 'a tartalék soha nem hosszabb 12 mp-nél');
for (let index = 0; index < 20; index++) h.reduceLiveHoldExtra(P2);
check(h.liveHoldExtraMs(P2) === h.LIVE_HOLD_MIN_EXTRA_MS && h.LIVE_HOLD_MIN_EXTRA_MS === 2000, 'a csökkentés 1 mp-enként történik, és 2 mp alá nem megy');
// Megjavult szolgáltató: a sima indulások kikapcsolják.
h.recordSmoothStart(P2);
check(!h.isBurstyHost(P2) && h.liveStallHoldMs({ host: P2, start: true, lagSoFarMs: 9000 }) === 0,
  'egy megállás nélküli indulás után (2 megfigyelés → 1, 1 sima) nincs több tartás', JSON.stringify(h.readHostHealth(P2)));
h.recordSmoothStart(P2);
check(h.readHostHealth(P2).starve === 0 && h.readHostHealth(P2).extraMs === 0, 'amikor a megfigyelések elfogynak, a tanult tartalék is törlődik');
h.resetLiveStreamHealth();
h.recordStartStarvation(P2, 9000); h.recordStartStarvation(P2, 9000);
h.markLiveHoldBroken(P2);
h.recordStartStarvation(P2, 9000);
check(!h.isBurstyHost(P2) && h.liveStallHoldMs({ host: P2, start: true, lagSoFarMs: 9000 }) === 0, 'ha a tartás ezen a TV-n nem működött, többé nem próbáljuk');

console.log('\n=== 4/b. A #67-es napló adag-érkezései: beavatkozás nélkül és tartalékkal ===\n');
/**
 * A TV egyszerű modellje a naplóból mért számokkal: az adat 10 mp-es adagokban érkezik (`arrivals`,
 * mp az első képkockától), a pozíció 1,0 mp-ről indul, és a TV 2,7 mp-nyi pufferrel már megáll.
 * A döntéseket a VALÓDI megfigyelő és szabályok hozzák (ugyanaz a sorrend, mint a lejátszóban).
 */
function watch(arrivals, { host = P2, totalSec = 300 } = {}) {
  const tracker = new h.LiveFlowTracker();
  let pos = 1.0;
  tracker.begin(0, pos);
  let starving = false;
  let starveFrom = 0;
  let holdUntil = -1;
  let holdStarted = 0;
  const stalls = [];
  const holds = [];
  const handle = (event, now) => {
    if (event.kind === 'smooth') { h.recordSmoothStart(host); return; }
    if (event.kind === 'spare') {
      if (event.minAheadSeconds !== null && event.minAheadSeconds >= h.LIVE_SPARE_AHEAD_SECONDS && h.isBurstyHost(host)) h.reduceLiveHoldExtra(host);
      return;
    }
    if (event.kind !== 'stall') return;
    if (event.start) h.recordStartStarvation(host, event.stallMs);
    const hold = h.liveStallHoldMs({ host, start: event.start, lagSoFarMs: tracker.lagMs });
    if (!event.start && h.isBurstyHost(host) && tracker.starved) h.recordLiveHoldExtra(host, event.extraLagMs + hold);
    if (hold > 0) { holdUntil = now + hold; holdStarted = now; holds.push(hold); }
  };
  for (let now = 50; now <= totalSec * 1000; now += 50) {
    let dataEnd = 0;
    for (const at of arrivals) if (at * 1000 <= now) dataEnd += 10;
    const held = now <= holdUntil;
    if (!held && holdUntil >= 0) { tracker.noteHold(holdUntil - holdStarted, now); holdUntil = -1; }
    if (!held) {
      if (pos + 0.05 > dataEnd - 2.7) {
        if (!starving) { starving = true; starveFrom = now; tracker.noteWaiting(now, pos); }
      } else {
        if (starving) {
          starving = false;
          stalls.push(now - starveFrom);
          handle(tracker.resumed(now, pos), now);
        }
        if (now > holdUntil) pos += 0.05;
      }
    }
    if (now % 1000 === 0) handle(tracker.observe({ now, currentTime: pos, paused: now <= holdUntil, aheadSeconds: dataEnd - pos }), now);
  }
  return { stalls, holds, later: stalls.length > 1 ? stalls.slice(1).reduce((sum, ms) => sum + ms, 0) : 0 };
}
const fromLateness = (measured, cycle, count = 40) => {
  const arrivals = [0];
  for (let k = 1; k < count; k++) arrivals.push(10 * k + (k - 1 < measured.length ? measured[k - 1] : cycle[(k - 1 - measured.length) % cycle.length]));
  return arrivals;
};
// TV2 HD, #67: az adagok 19,4 / 31,4 / 42,4 / 48,7 / 59,5 / 71,0 / 82,6 / 93,0 / 103,8 / 109,9 / … mp-nél érkeztek.
const TV2 = fromLateness([7.8, 9.8, 10.8, 7.1, 7.9, 9.4, 11.0, 11.4, 12.2, 8.3, 9.4, 10.2, 11.4, 12.0, 8.3, 9.1, 9.2], [10.2, 11.4, 12.0, 8.3, 9.1, 9.4]);
const FILM_CAFE = fromLateness([6.9, 8.0, 9.1, 5.4, 6.2, 7.0], [8.0, 9.1, 5.4, 6.2, 7.0, 6.9]);
h.resetLiveStreamHealth();
let natural = watch(TV2, { totalSec: 185 });
check(Math.abs(natural.stalls[0] - 11_500) <= 300 && natural.stalls.length >= 4 && natural.holds.length === 0
  && natural.later >= 3500 && natural.later <= 6500,
  `beavatkozás nélkül (első megfigyelés) a modell a naplót adja: ${(natural.stalls[0] / 1000).toFixed(1)} mp-es indulási megállás, `
  + `utána ${natural.stalls.length - 1} megakadás, összesen ${(natural.later / 1000).toFixed(1)} mp (napló: 11,5 mp, majd 4 megakadás, 4,8 mp)`,
  JSON.stringify(natural));
let managed = watch(TV2, { totalSec: 390 });
check(managed.stalls.length === 1 && managed.holds.length === 1 && managed.holds[0] === 6000,
  'a második megfigyeléstől: az indulási megállás végén 6 mp tartás, utána 6,5 percig EGYETLEN megakadás sincs', JSON.stringify(managed));
managed = watch(FILM_CAFE, { totalSec: 390 });
check(managed.stalls.length === 1 && managed.holds.length === 1, 'a Film Cafe adag-időzítésével is: egy megállás, egy tartás, nincs későbbi megakadás', JSON.stringify(managed));
check(watch(fromLateness([], [-9]), { totalSec: 120 }).holds.length === 0 && watch(fromLateness([], [-9]), { totalSec: 120 }).stalls.length === 0,
  'folyamatosan (előre) küldő adásnál szakaszosan küldőként ismert szolgáltatón sincs semmilyen várakozás');

// Robusztusság: 300–300 véletlen adag-időzítés, egyenként 5 perc nézés, kétféle modellel:
//   „fűrészfog” – amit a napló mutat: a késés adagonként 0,6–1,5 mp-et nő, majd 4–6 adagonként
//                 visszaesik a kiinduló érték közelébe (korlátos ingadozás);
//   „bolyongás” – a naplónál ROSSZABB eset: a késés hosszú távon is elvándorolhat.
{
  const makeTraces = (kind) => {
    let seed = 20261110;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const traces = [];
    for (let index = 0; index < 300; index++) {
      const lateness = [];
      let late = 6 + random() * 8;
      const base = late;
      let untilReset = 4 + Math.floor(random() * 4);
      for (let k = 0; k < 34; k++) {
        lateness.push(late);
        untilReset -= 1;
        if (kind === 'saw') {
          if (untilReset <= 0) { late = base + (random() * 2 - 0.5); untilReset = 4 + Math.floor(random() * 3); } else late += 0.6 + random() * 0.9;
        } else {
          if (untilReset <= 0) { late -= 3 + random() * 2.5; untilReset = 4 + Math.floor(random() * 4); } else late += 0.4 + random() * 1.2;
          late = Math.max(4, late);
        }
      }
      traces.push(fromLateness(lateness, [late], 36));
    }
    return traces;
  };
  const tally = (list) => ({
    sessions: list.filter((run) => run.stalls.length > 1).length,
    count: list.reduce((sum, run) => sum + Math.max(0, run.stalls.length - 1), 0),
    ms: list.reduce((sum, run) => sum + run.later, 0),
  });
  for (const kind of ['saw', 'walk']) {
    const traces = makeTraces(kind);
    // Beavatkozás nélkül: minden csatorna külön, „első megfigyelés” állapotból.
    const plain = tally(traces.map((trace, index) => { h.resetLiveStreamHealth(); return watch(trace, { host: `plain-${index}.example`, totalSec: 300 }); }));
    // Tartalékkal: ugyanazon a szolgáltatón egymás után (a tanulás is működik).
    h.resetLiveStreamHealth();
    h.recordStartStarvation(P2, 11_000); h.recordStartStarvation(P2, 11_000);
    const runs = traces.map((trace) => watch(trace, { host: P2, totalSec: 300 }));
    const withHold = tally(runs);
    const worstHold = Math.max(...runs.map((run) => run.holds.reduce((sum, ms) => sum + ms, 0)));
    const averageHold = runs.reduce((sum, run) => sum + run.holds.reduce((inner, ms) => inner + ms, 0), 0) / runs.length;
    const name = kind === 'saw' ? 'fűrészfog (a napló mintája)' : 'bolyongás (a naplónál rosszabb)';
    console.log(`    ${name} – beavatkozás nélkül: ${plain.sessions}/300 nézésben volt későbbi megakadás (${plain.count} db, ${(plain.ms / 1000).toFixed(0)} mp)`);
    console.log(`    ${name} – tartalékkal:        ${withHold.sessions}/300 nézésben (${withHold.count} db, ${(withHold.ms / 1000).toFixed(0)} mp); `
      + `átlagos tartás=${(averageHold / 1000).toFixed(1)} mp; leghosszabb=${(worstHold / 1000).toFixed(1)} mp; tanult tartalék=${h.liveHoldExtraMs(P2)} ms`);
    check(plain.sessions >= 280, `${name}: beavatkozás nélkül szinte minden nézésben van műsor közbeni megakadás (ez a felhasználó panasza)`, JSON.stringify(plain));
    if (kind === 'saw') {
      check(withHold.sessions <= 9 && withHold.ms <= plain.ms * 0.01,
        `${name}: tartalékkal a nézések legalább 97%-ában EGYETLEN későbbi megakadás sincs`, JSON.stringify({ plain, withHold }));
    } else {
      check(withHold.count <= plain.count * 0.1 && withHold.ms <= plain.ms * 0.1 && withHold.sessions <= 150,
        `${name}: a műsor közbeni megakadások száma és ideje így is a tizedére (vagy az alá) esik`, JSON.stringify({ plain, withHold }));
    }
    check(worstHold <= 16_000 && h.liveHoldExtraMs(P2) <= 12_000,
      `${name}: a tartás korlátos (egy nézésben összesen legfeljebb 16 mp, a tanult tartalék legfeljebb 12 mp)`, `leghosszabb=${worstHold}`);
  }
}

console.log('\n=== 5. Tartósság és hibatűrés ===\n');
h.resetLiveStreamHealth();
h.recordFormatDeath(P1, 'hls'); h.recordFormatDeath(P1, 'hls');
h.forgetLiveStreamHealthCache();
check(h.isFormatDistrusted(P1, 'hls'), 'a tanulás túléli az alkalmazás újraindítását (localStorage)');
store.set('iptv_rt_live_stream_health_v1', '{sérült');
h.forgetLiveStreamHealthCache();
check(!h.isFormatDistrusted(P1, 'hls') && !h.isBurstyHost(P2) && h.liveHoldExtraMs(P2) === 6000, 'sérült tár: üres emlékezet, nincs kivétel');
h.resetLiveStreamHealth();
for (let index = 0; index < 60; index++) h.recordFormatDeath(`host-${index}.example`, 'hls', 1000 + index);
h.forgetLiveStreamHealthCache();
check(Object.keys(JSON.parse(store.get('iptv_rt_live_stream_health_v1'))).length === 40 && h.readHostHealth('host-59.example').hlsDeaths === 1
  && h.readHostHealth('host-0.example').hlsDeaths === 0, 'legfeljebb 40 szolgáltató-hoszt marad meg, a legrégebbiek esnek ki');
for (let index = 0; index < 50; index++) h.recordFormatDeath(P1, 'hls');
check(h.readHostHealth(P1).hlsDeaths === 12, 'a számlálók korlátosak (12): a tanulás mindig visszafordítható marad');

console.log(`\n=== EREDMÉNY: ${passed}/${passed} ellenőrzés ===`);
console.log('OK: a formátum-egészség és a késleltetés-tartalék döntései a #66-os és #67-es napló mért idővonalain helyesek.');
