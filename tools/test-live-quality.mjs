#!/usr/bin/env node
/**
 * KÉPMINŐSÉG-EMLÉKEZET (2.5.383) – a „legszebb képű formátum” választója.
 *
 * A felhasználói hiba: a Full HD / UHD csatornák alap rossz minőségben
 * jelentek meg. A napló (#30) bizonyította, hogy ugyanannak a csatornának a
 * MPEG-TS és a HLS formátuma MÁS felbontást ad (pl. TS 1024x576, HLS
 * 1920x1080, vagy fordítva), a lejátszó pedig eddig csak a sebességet és a
 * hibákat nézte – a felbontást soha.
 *
 * Ez a teszt a választó tiszta logikáját és a tárolást ellenőrzi:
 *   1. mérés rögzítése formátumonként (localStorage – IPK-újraindítást is túléli),
 *   2. a nagyobb felbontású formátum kiválasztása (mindkét irányban),
 *   3. Full HD alatti mért kép + ismeretlen másik formátum → egyszeri kipróbálás,
 *   4. a többször elhalt formátumot nem erőlteti vissza,
 *   5. érdéktelen (kis) különbségnél nem vált (nem lesz formátum-villogás),
 *   6. érvénytelen méret (0x0) nem kerül a tárolóba.
 *
 * Futtatás: node tools/test-live-quality.mjs
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import assert from 'node:assert/strict';

const esbuild = createRequire(resolve('web/package.json'))('esbuild');
const built = await esbuild.build({
  entryPoints: [resolve('web/src/services/liveQualityMemory.ts')],
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'QualityMemory',
  logLevel: 'silent',
});

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => { throw error; });
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
});
const { window } = dom;
const script = window.document.createElement('script');
script.textContent = built.outputFiles[0].text;
window.document.body.appendChild(script);

const api = window.QualityMemory;
assert.ok(api, 'a képmínőség-modul betölthető');

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ HIBA: ${label}`);
  }
}

/* ─────────── 1. Kulcs és tárolás ─────────── */

api.resetLiveQualityMemory();
check(api.liveQualityKey({ id: 'ch-42', name: 'HBO UHD' }) === 'id:ch-42', 'a csatorna-kulcs az azonosítót használja');
check(
  api.liveQualityKey({ name: 'Árvíztűrő Tükörfúrógép TV' }) === 'name:arvizturo-tukorfurogep-tv',
  'azonosító nélkül a névből képzett, ékezet nélküli kulcsot használja',
);
check(api.liveQualityKey(null) === '', 'hiányzó csatornánál üres kulcs (nincs tárolás)');

api.recordLiveQualityMeasurement({ key: 'id:ch-42', name: 'HBO UHD', format: 'ts', width: 1024, height: 576, now: 1000 });
api.recordLiveQualityMeasurement({ key: 'id:ch-42', name: 'HBO UHD', format: 'hls', width: 1920, height: 1080, now: 2000 });
const stored = api.getLiveQualityRecord('id:ch-42');
check(stored?.ts?.width === 1024 && stored?.ts?.height === 576, 'a TS felbontás elmentődik');
check(stored?.hls?.width === 1920 && stored?.hls?.height === 1080, 'a HLS felbontás elmentődik');
check(api.qualityLabelOf(stored?.hls) === '1920×1080 (Full HD)', 'a felbontás-címke Full HD-t ír');
check(api.qualityLabelOf(stored?.ts) === '1024×576 (SD+)', 'a felbontás-címke SD+-t ír a TS képnél');

api.recordLiveQualityMeasurement({ key: 'id:ch-42', format: 'ts', width: 0, height: 0, now: 3000 });
check(api.getLiveQualityRecord('id:ch-42')?.ts?.height === 576, 'a 0x0 méret nem írja felül a jó mérést');

/* ─────────── 2. Mindkét formátum mért: a szebb kép győz ─────────── */

const bothMeasured = api.getLiveQualityRecord('id:ch-42');
let choice = api.chooseLiveQualityFormat({ record: bothMeasured, plannedFormat: 'ts' });
check(choice.changed === true && choice.format === 'hls', 'TS → HLS váltás, mert a HLS mért képe 1920x1080');
check(choice.basis === 'measured', 'a váltás alapja a MÉRT felbontás');
check(/1920×1080/.test(choice.reason), 'az indok tartalmazza a mért felbontást');

choice = api.chooseLiveQualityFormat({ record: bothMeasured, plannedFormat: 'hls' });
check(choice.changed === false && choice.format === 'hls', 'HLS-ről nem vált vissza a gyengébb TS-re');

/* ─────────── 3. Fordított eset: a HLS a gyengébb ─────────── */

api.recordLiveQualityMeasurement({ key: 'id:ch-99', format: 'ts', width: 1920, height: 1080, now: 4000 });
api.recordLiveQualityMeasurement({ key: 'id:ch-99', format: 'hls', width: 720, height: 405, now: 5000 });
choice = api.chooseLiveQualityFormat({ record: api.getLiveQualityRecord('id:ch-99'), plannedFormat: 'hls' });
check(choice.changed === true && choice.format === 'ts', 'HLS → TS váltás, mert a TS mért képe 1920x1080');

/* ─────────── 4. Csak a mostani formátum mért, Full HD alatt ─────────── */

api.recordLiveQualityMeasurement({ key: 'id:ch-7', format: 'ts', width: 1024, height: 576, now: 6000 });
choice = api.chooseLiveQualityFormat({ record: api.getLiveQualityRecord('id:ch-7'), plannedFormat: 'ts' });
check(choice.changed === true && choice.format === 'hls', 'Full HD alatti mért TS képnél a HLS-t kipróbálja');
check(choice.basis === 'unmeasured-probe', 'a kipróbálás alapja a hiányzó mérés');

/* 2.5.390: a TV Doktor TANULT formátumát nem írja felül egy méretlen próba. */
const learnedChoice = api.chooseLiveQualityFormat({ record: api.getLiveQualityRecord('id:ch-7'), plannedFormat: 'ts', learnedFormat: 'ts' });
check(learnedChoice.changed === false && learnedChoice.format === 'ts', 'igazoltan tanult TS formátumot nem cserél méretlen HLS-próbára (#34 CINEMAX)');
check(/TV Doktor/.test(learnedChoice.reason), 'a napló indoka megnevezi a TV Doktor tanult formátumát');
const measuredStillWins = api.chooseLiveQualityFormat({ record: bothMeasured, plannedFormat: 'ts', learnedFormat: 'ts' });
check(measuredStillWins.changed === true && measuredStillWins.format === 'hls', 'két MÉRT felbontásnál a szebb kép így is nyer (2.5.383 változatlan)');

// Ugyanez Full HD panelen mért Full HD képnél: nincs ok váltani.
api.recordLiveQualityMeasurement({ key: 'id:ch-8', format: 'ts', width: 1920, height: 1080, now: 7000 });
choice = api.chooseLiveQualityFormat({ record: api.getLiveQualityRecord('id:ch-8'), plannedFormat: 'ts' });
check(choice.changed === false, 'mért Full HD TS képnél nem vált (nincs fölösleges újraindítás)');

/* ─────────── 5. Elhalt formátumot nem erőlteti vissza ─────────── */

api.recordLiveQualityFailure({ key: 'id:ch-7', format: 'hls', now: 8000 });
check(api.getLiveQualityRecord('id:ch-7')?.hlsFail === 1, 'a HLS hiba rögzítve');
choice = api.chooseLiveQualityFormat({ record: api.getLiveQualityRecord('id:ch-7'), plannedFormat: 'ts' });
check(choice.changed === false, 'egyszer elhalt HLS-t nem próbál újra azonnal');

// Kétszer mért, de a másik formátum többször elhalt: marad a mostani.
api.recordLiveQualityMeasurement({ key: 'id:ch-55', format: 'ts', width: 1024, height: 576, now: 9000 });
api.recordLiveQualityMeasurement({ key: 'id:ch-55', format: 'hls', width: 1920, height: 1080, now: 9100 });
for (let i = 0; i < 4; i += 1) api.recordLiveQualityFailure({ key: 'id:ch-55', format: 'hls', now: 9200 + i });
choice = api.chooseLiveQualityFormat({ record: api.getLiveQualityRecord('id:ch-55'), plannedFormat: 'ts' });
check(choice.changed === false, 'a négyszer elhalt (szebb) HLS-t nem kényszeríti vissza');

/* ─────────── 6. Sikeres mérés nullázza a hibaszámlálót ─────────── */

api.recordLiveQualityMeasurement({ key: 'id:ch-7', format: 'hls', width: 1920, height: 1080, now: 10000 });
check(api.getLiveQualityRecord('id:ch-7')?.hlsFail === 0, 'a sikeres mérés nullázza a korábbi hibaszámlálót');
choice = api.chooseLiveQualityFormat({ record: api.getLiveQualityRecord('id:ch-7'), plannedFormat: 'ts' });
check(choice.changed === true && choice.format === 'hls', 'a működő és szebb HLS-t választja');

/* ─────────── 7. Kis különbségnél nincs villogás ─────────── */

api.recordLiveQualityMeasurement({ key: 'id:ch-77', format: 'ts', width: 1280, height: 720, now: 11000 });
api.recordLiveQualityMeasurement({ key: 'id:ch-77', format: 'hls', width: 1280, height: 720, now: 11100 });
choice = api.chooseLiveQualityFormat({ record: api.getLiveQualityRecord('id:ch-77'), plannedFormat: 'ts' });
check(choice.changed === false, 'azonos felbontásnál nem vált formátumot');

api.recordLiveQualityMeasurement({ key: 'id:ch-78', format: 'ts', width: 1024, height: 576, now: 12000 });
api.recordLiveQualityMeasurement({ key: 'id:ch-78', format: 'hls', width: 1024, height: 576, now: 12100 });
choice = api.chooseLiveQualityFormat({ record: api.getLiveQualityRecord('id:ch-78'), plannedFormat: 'ts' });
check(choice.changed === false, 'érdéktelen (azonos) méretnél nem vált');

/* ─────────── 8. Ismeretlen csatorna ─────────── */

choice = api.chooseLiveQualityFormat({ record: null, plannedFormat: 'hls' });
check(choice.changed === false && choice.format === 'hls', 'mérés nélkül a tervezett formátum marad');

/* ─────────── 9. Tároló-korlát és újraindítás ─────────── */

api.resetLiveQualityMemory();
for (let i = 0; i < 460; i += 1) {
  api.recordLiveQualityMeasurement({ key: `id:bulk-${i}`, format: 'ts', width: 1024, height: 576, now: 20000 + i });
}
const raw = JSON.parse(window.localStorage.getItem('iptv_rt_live_quality_v1'));
const recordCount = Object.keys(raw.records).length;
check(recordCount === 400, `a tároló legfeljebb 400 csatornát tart meg (most: ${recordCount})`);
check(Boolean(raw.records['id:bulk-459']), 'a legfrissebb mérés megmarad a korlátozás után is');
check(!raw.records['id:bulk-0'], 'a legrégebbi mérés kiesik a korlátozásnál');

/* ─────────── 10. A lejátszó be van kötve ─────────── */

const fs = await import('node:fs');
const playerSource = fs.readFileSync(resolve('web/src/components/VideoPlayer.tsx'), 'utf8');
check(
  playerSource.includes('chooseLiveQualityFormat({'),
  'a lejátszó a mért felbontás alapján választ formátumot',
);
check(
  playerSource.includes('recordLiveQualityMeasurement({'),
  'a lejátszó rögzíti a dekódolt kép méretét',
);
check(
  playerSource.includes('KÉPMINŐSÉG-VÁLASZTÁS;'),
  'a formátumválasztás döntése a naplóba kerül (nem rejtett viselkedés)',
);
check(
  playerSource.includes('probeStreamHdr(') && playerSource.includes('hdrLabel={streamHdrLabel}'),
  'a HDR-jelzés a TV színmetaadatából a film OSD-jére kerül',
);

const osdSource = fs.readFileSync(resolve('web/src/components/VodOsd.tsx'), 'utf8');
check(
  osdSource.includes('data-vod-osd-hdr'),
  'a film OSD megjeleníti a HDR-jelzést a cím mellett',
);

const serviceSource = fs.readFileSync(resolve('web/src/services/embeddedSubtitleService.ts'), 'utf8');
check(
  serviceSource.includes('normalizeHdrText'),
  'a „HDR=none” típusú semleges érték nem számít HDR-nek',
);

/* ─────────── 11. A mérés indítása nem dob hibát (2.5.383 javítás) ─────────── */

const appLogBuilt = await esbuild.build({
  entryPoints: [resolve('web/src/services/appLog.ts')],
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'AppLog',
  nodePaths: [resolve('web/node_modules')], define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});
const logDom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
});
const logScript = logDom.window.document.createElement('script');
logScript.textContent = appLogBuilt.outputFiles[0].text;
logDom.window.document.body.appendChild(logScript);
const appLogApi = logDom.window.AppLog;
check(
  typeof appLogApi?.dublinTimestamp === 'function',
  'a napló „dublinTimestamp” időbélyeg-függvénye létezik (korábban hiányzott → ReferenceError)',
);
check(
  appLogApi.dublinTimestamp(Date.UTC(2026, 10, 7, 17, 25, 22)) === '2026-11-07 17:25:22',
  'a Dublin-időbélyeg a várt alakot adja (Europe/Dublin)',
);
let measurementResetOk = false;
let measurementSnapshot = null;
try {
  measurementSnapshot = appLogApi.resetMeasurements('teszt: képmínőség kiadás');
  measurementResetOk = true;
} catch {
  measurementResetOk = false;
}
check(measurementResetOk, 'az „ÚJ MÉRÉS” indítása nem dob hibát (a kézi naplózás működik)');
check(measurementSnapshot?.logLines === 0, 'az új mérés számlálói nullázódnak');
logDom.window.close();

/* ─────────── 12. 2.5.390: óra, TV DR pörgés, Mozi-visszatöltés ─────────── */

/* A kézi napló EGY ÓRÁVAL KEVESEBBET mutat: Europe/Dublin, nem a TV +01:00-ja. */
check(
  appLogApi.dateTimeText(Date.UTC(2026, 10, 8, 7, 30, 57)) === '2026-11-08 07:30:57',
  'a kézi napló dátuma 07:30:57 (Dublin) – nem 08:30:57 (#33 fejléc-eltérés)',
);
check(
  appLogApi.clockText(Date.UTC(2026, 10, 8, 7, 30, 57)) === '07:30:57',
  'a mérés kezdete és a napló kezdete UGYANABBAN az időzónában jelenik meg',
);

/* A TV DR napló: nincs dupla sor, nincs üres sor, van rutinminta-ritkítás. */
appLogApi.clearTvDoctorLog();
appLogApi.startTvDoctorLogging();
const beforeLines = appLogApi.manualTvDoctorLogSnapshot().lineCount;
appLogApi.tvDoctorLog('TV DOKTOR 2.5.390 DUPPLA TESZT');
appLogApi.tvDoctorLog('TV DOKTOR 2.5.390 DUPPLA TESZT');
const afterDuplicate = appLogApi.manualTvDoctorLogSnapshot().lineCount;
check(afterDuplicate - beforeLines === 1, 'az azonos TV DOKTOR sor 500 ms-on belül NEM íródik kétszer (#34 dupla sorok)');
appLogApi.tvDoctorLog('TV DOKTOR 2.5.390 TÖBBSOROS\nMÁSODIK SOR');
const afterMultiline = appLogApi.manualTvDoctorLogSnapshot().lineCount;
check(afterMultiline - afterDuplicate === 1, 'a többsoros üzenet EGY sor marad (a /\\s+/ regex hiba javítva)');
check(!/TV DOKTOR 2\.5\.390 TÖBBSOROS\n/.test(appLogApi.getTvDoctorLogText()), 'a TV DR naplóban nem marad üres sor a sortörésből');
appLogApi.stopTvDoctorLogging('teszt');

const doctorTelemetrySource = fs.readFileSync(resolve('web/src/services/tvDoctor.ts'), 'utf8');
check(
  doctorTelemetrySource.includes('ROUTINE_SAMPLE_INTERVAL_MS = 30_000'),
  'a TV DR rutin puffermintája 30 mp-re van ritkítva (#34: 1809 sor helyett ~26)',
);
check(
  doctorTelemetrySource.includes("reason === 'MEDIA_PROGRESS'"),
  'a webOS ~350 ms-onként tüzelő progress esemény többé nem ír minden mintát',
);
check(
  doctorTelemetrySource.includes('ritkítva_kihagyott'),
  'a kihagyott minták száma a záró összesítőben látszik (nem vész el információ)',
);

const storeSource = fs.readFileSync(resolve('web/src/services/contentStore.ts'), 'utf8');
check(
  /readGroupSize:\s*16/.test(storeSource) && /decodeBatchSize:\s*2500/.test(storeSource),
  '2.5.392: a Mozi hideg visszatöltése a benchmark győztesével (16 blokk / 2500 soros adag) olvas',
);
check(
  /két blokkonként|% 2 === 0/.test(storeSource) && /RESTORE_TUNING/.test(storeSource),
  'a nagy olvasási csoport közben is visszaadjuk a fő szálat (nincs 1,8 s szinkron blokk)',
);
check(
  storeSource.includes('await yieldToStorage()') && storeSource.includes('expectedRestoreBatches'),
  'a JSON-dekódolás közben visszaadja a fő szálat, és az „adagok=X/Y” számláló pontos',
);

const playerSource390 = fs.readFileSync(resolve('web/src/components/VideoPlayer.tsx'), 'utf8');
check(playerSource390.includes('learnedFormat: doctorPlan?.hasLearnedProfile'), 'a lejátszó átadja a tanult formátumot a képmínőség-választónak');
check(playerSource390.includes('recordLiveQualityFailure({ key: failedKey'), 'a médiahiba a képmínőség-emlékezetbe is bekerül (nincs örökös HLS-próba)');
check(playerSource390.includes('state.mode = isVodRef.current'), 'a képminőség-összesítés módja/címe a stream indulásakor rögzül (#33 élő .mkv hiba)');

console.log(`\nKépmínőség-tesztek: ${passed} sikeres, ${failed} hibás.`);
if (failed > 0) process.exit(1);
console.log('OK: a képmínőség-választó, a HDR-jelzés és a mérés indításának tesztjei sikeresek ✅');
process.exit(0);
