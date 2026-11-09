#!/usr/bin/env node
/**
 * XTREAM VOD-METAADAT TESZT – valódi napló (jsdom) regressziós próba.
 *
 * Azt ellenőrzi, hogy a kézi hibakeresési naplóba a naplózás indításakor és a
 * Mozi/Sorozat nézet megnyitásakor bekerül-e minden kért szolgáltatói adat:
 * év, megjelenési dátum, játékidő, hangsávok és hangnyelvek, feliratok és
 * feliratnyelvek, poszter/borító/háttérkép, valamint az egyéb mezők – és hogy
 * a napló megmondja, ezek közül mi jeleníthető meg.
 *
 * A próba hamis Xtream-válasszal dolgozik (nincs hálózat), és azt is ellenőrzi,
 * hogy jelszó/felhasználónév soha nem kerül a naplóba, valamint hogy leállított
 * naplózásnál nem indul több szolgáltatói kérés.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve('.');
const HARD_TIMEOUT_MS = 90_000;

let failed = false;
function check(ok, message) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} – ${message}`);
  if (!ok) failed = true;
}

const killer = setTimeout(() => {
  check(false, `a teszt ${HARD_TIMEOUT_MS / 1000} mp alatt nem fejeződött be`);
  process.exit(1);
}, HARD_TIMEOUT_MS);
killer.unref?.();

let esbuild;
let JSDOM;
let VirtualConsole;
try {
  esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
} catch {
  console.log('KIPARANCSOLT: esbuild hiányzik – npm install --prefix web');
  process.exit(0);
}
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch {
  console.log('KIPARANCSOLT: jsdom nincs telepítve – npm install a gyökérben');
  process.exit(0);
}

const outFile = path.resolve('build/test/vod-provider-diagnostics.js');
fs.mkdirSync(path.dirname(outFile), { recursive: true });

const build = await esbuild.build({
  entryPoints: [path.resolve('tools/fixtures/vod-provider-diagnostics-harness.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  nodePaths: [path.resolve('web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
  logLevel: 'silent',
});

const virtualConsole = new VirtualConsole();
const jsdomErrors = [];
virtualConsole.on('jsdomError', (error) => jsdomErrors.push(error));

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
});

const script = dom.window.document.createElement('script');
script.textContent = build.outputFiles[0].text;
dom.window.document.body.appendChild(script);

const harness = dom.window.__VOD_DIAG_TEST__;
check(Boolean(harness), 'a naplózó teszt harness betöltődött');
if (!harness) {
  console.log('\nHIBA: a harness nem töltődött be.');
  process.exit(1);
}

const result = await harness.run();
const { afterSection, afterStart, afterStopBaseline, afterStop, calls } = result;

const countTag = (text) => (text.match(/VOD-DIAG/g) || []).length;

console.log('\n1. Naplózás indítása: szolgáltatói áttekintés');
check(afterStart.includes('VOD-DIAG === SZOLGÁLTATÓI VOD-METAADAT TESZT'), 'megjelenik a VOD-metaadat teszt fejléce');
check(/VOD-DIAG szolgáltató: Xtream; host=panel\.example\.tv:8080/.test(afterStart), 'a szolgáltató típusa és hosztja naplózva');
check(afterStart.includes('film a programban=3') && afterStart.includes('sorozat a programban=1'), 'a programban lévő film/sorozat darabszám naplózva');
check(/\[film lista\] MEZŐK a programban: minta=3\/3/.test(afterStart), 'a film-lista mezőinek jelenléte (év, játékidő, nyelvek, poszter…) naplózva');
check(/\[sorozat lista\] MEZŐK a programban: minta=1\/1/.test(afterStart), 'a sorozat-lista mezőinek jelenléte naplózva');
check(afterStart.includes('naplózás indítása: részletes szolgáltatói teszt indul'), 'a naplózás indításakor a részletes teszt elindul');

console.log('\n2. Mozi nézet: mit küld a szolgáltató a filmekhez');
check(afterSection.includes('[Mozi] NÉZET MEGNYITVA'), 'a Mozi belépés naplózva');
check(/\[film\] LISTA-MINTA \(első 3 elem a 3-b.l\)/.test(afterSection), 'a film-lista mintája naplózva');
check(afterSection.includes('„Dűne” (id=501)'), 'a minta tartalmazza a film azonosítóját és címét');
check(afterSection.includes('RÉSZLETES KÉRÉS → get_vod_info'), 'a részletes get_vod_info kérés naplózva');
check(afterSection.includes('VÁLASZ-SZERKEZET'), 'a válasz szerkezete (info / movie_data) naplózva');
check(
  afterSection.includes('KÉRÉS CÍME: http://panel.example.tv:8080/player_api.php?action=get_vod_info&id=501 (felhasználónév/jelszó nélkül)'),
  'a kérés címe (belépési adatok nélkül) naplózva',
);
check(/FILM ADATOK \(movie_data\): stream_id=501; name=Dűne; added=1690000000/.test(afterSection), 'a film stream-adatai (movie_data) naplózva');
check(/ÉV\/MEGJELENÉS: releasedate="2021-09-15"/.test(afterSection), 'a megjelenési dátum naplózva');
check(/ÉV\/MEGJELENÉS: .*→ év=2021/.test(afterSection), 'a megjelenési dátumból képzett év naplózva');
check(/JÁTÉKIDŐ: duration="02:00:00" \(120 perc\)/.test(afterSection), 'a HH:MM:SS játékidő és a belőle számolt 120 perc naplózva');
check(/duration_secs="7200" \(120 perc\)/.test(afterSection), 'a másodperces játékidő-mező is naplózva');
check(/HANG: .*→ 2 sáv \(Magyar \(hu, AAC, 2\.0\) \| Angol \(en, EAC3\)\)/.test(afterSection), 'a hangsávok (nyelv, kodek, csatorna) naplózva');
check(/megjeleníthető nyelvek: Magyar, Angol/.test(afterSection), 'a hangnyelvek naplózva');
check(/FELIRAT: .*→ 2 sáv; megjeleníthető nyelvek: Magyar, Angol/.test(afterSection), 'a feliratok és feliratnyelvek naplózva');
check(/KÉPEK: .*info\.movie_image=http:\/\/panel\.example\.tv\/images\/movie_image\/501\.jpg/.test(afterSection), 'a poszter (movie_image) naplózva');
check(/KÉPEK: .*info\.cover_big=/.test(afterSection) && /KÉPEK: .*info\.backdrop_path=/.test(afterSection), 'a borító és a háttérkép is naplózva');
check(/EGYÉB MEZŐK: .*mpaa_rating="PG-13"/.test(afterSection), 'az egyéb mezők (korhatár) naplózva');
check(/EGYÉB MEZŐK: .*country="US"/.test(afterSection) && /bitrate=0/.test(afterSection), 'az egyéb mezők (ország, bitráta) naplózva');
check(/MEGJELENÍTHETŐ: poszterkártyán: évszám, játékidő, hangnyelvek, feliratnyelvek/.test(afterSection), 'a poszterkártyán megjeleníthető adatok naplózva');
check(/adatlapon: .*leírás, szereplők, háttérkép/.test(afterSection), 'az adatlapon megjeleníthető adatok naplózva');
check(/még NEM megjelenített mezői: .*mpaa_rating/.test(afterSection), 'a még meg nem jelenített mezők is naplózva');
check(/NYERS VÁLASZ \(info, max\. 900 karakter\): .*"duration_secs":7200/.test(afterSection), 'a nyers szolgáltatói válasz (truncated) naplózva');
check(afterSection.includes('„Ismeretlen adatú film”'), 'a hiányos adatú film is megjelenik a mintában');

console.log('\n3. Sorozatok nézet: mit küld a szolgáltató a sorozatokhoz');
check(afterSection.includes('[Sorozatok] NÉZET MEGNYITVA'), 'a Sorozatok belépés naplózva');
check(afterSection.includes('RÉSZLETES KÉRÉS → get_series_info'), 'a részletes get_series_info kérés naplózva');
check(/ÉVADOK\/RÉSZEK: 2 évad, 3 rész/.test(afterSection), 'az évadok és részek száma naplózva');
check(/ELSŐ RÉSZ: „Rés 1” S1E1/.test(afterSection), 'az első rész adatai naplózva');
check(/ELSŐ RÉSZ: .*játékidő=60 perc/.test(afterSection), 'az első rész játékideje naplózva');
check(/ELSŐ RÉSZ: .*kép=epizód\.movie_image=/.test(afterSection), 'az első rész képe naplózva');
check(/RÉSZEK ADATLEFEDETTSÉGE: játékidő=3\/3; kép=2\/3; leírás=1\/3/.test(afterSection), 'a részek adatlefedettsége naplózva');
check(/\[sorozat\] .*MEGJELENÍTHETŐ: poszterkártyán: .*évszám, játékidő/.test(afterSection), 'a sorozat megjeleníthető adatai naplózva');

console.log('\n4. Adatvédelem és terhelés');
const allText = `${afterSection}\n${afterStart}\n${afterStop}`;
check(!allText.includes('titkosjelszo'), 'a jelszó NEM kerül a naplóba');
check(!allText.includes('titkosuser'), 'a felhasználónév NEM kerül a naplóba');
check(allText.includes('/movie/[redacted]/[redacted]/'), 'a szolgáltatói stream-URL kitakart (redacted) formában kerül a naplóba');
const vodCalls = calls.filter((call) => call.startsWith('vod|') || call.startsWith('series|'));
check(vodCalls.length > 0, `történt részletes szolgáltatói kérés (${vodCalls.length} db)`);
check(vodCalls.length <= 10, `a részletes kérések száma korlátozott (${vodCalls.length} ≤ 10)`);
check(
  vodCalls.every((call) => call.startsWith('vod|http://panel.example.tv:8080|') || call.startsWith('series|http://panel.example.tv:8080|')),
  'a kérések a beállított szolgáltatóhoz mentek',
);
const beforeStop = Number((calls.find((call) => call.startsWith('calls-before-stop|')) || '').split('|')[1] || 0);
check(beforeStop === vodCalls.length, `a leállítás előtti kérésszám egyezik (${beforeStop})`);

console.log('\n5. Leállított naplózás');
check(/VOD-DIAG naplózás leállt: a VOD-metaadat teszt \d+ részletes szolgáltatói kérést végzett/.test(afterStopBaseline), 'a naplózás leállásakor összegzés készül');
check(
  countTag(afterStop) === countTag(afterStopBaseline),
  `leállított naplózásnál nem készül több VOD-DIAG sor (${countTag(afterStopBaseline)} sor)`,
);
check(
  (afterStop.match(/VOD-DIAG szolgáltató:/g) || []).length === (afterStopBaseline.match(/VOD-DIAG szolgáltató:/g) || []).length,
  'leállított naplózásnál nem fut új szolgáltatói áttekintés',
);

if (!failed && jsdomErrors.length) {
  for (const error of jsdomErrors) console.log(`jsdom: ${String(error).slice(0, 200)}`);
}

clearTimeout(killer);
console.log(failed ? '\nHIBA: a VOD-metaadat naplóteszt nem futott át.' : '\nOK: a VOD-metaadat naplóteszt minden ellenőrzése átment. ✅');
dom.window.close();
process.exit(failed ? 1 : 0);
