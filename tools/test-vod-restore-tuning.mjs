#!/usr/bin/env node
/**
 * 2.5.392 – DETERMINISZTIKUS REGRESSZIÓS TESZT.
 *
 * A `tools/bench-vod-restore.mjs` a VALÓDI `loadVodAsync()` ciklust méri
 * 103 092 Mozi-filmen (0 sorozat!). Ez a teszt azt ellenőrzi, hogy a méréssel
 * kiválasztott győztes beállítás TÉNYLEG be van állítva a produkciós kódban,
 * és hogy a gyors indulás / 0-ablak / plakát javításai nem tűntek el.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const tuning = JSON.parse(read('tools/vod-restore-tuning.json'));
const store = read('web/src/services/contentStore.ts');
const bench = read('tools/bench-vod-restore.mjs');
const modal = read('web/src/components/TvDoctorStatusModal.tsx');
const doctor = read('web/src/services/tvDoctor.ts');
const cloud = read('web/src/services/tvDoctorCloud.ts');
const main = read('web/src/main.tsx');
const app = read('web/src/App.tsx');
const moviesView = read('web/src/components/MoviesView.tsx');
const vodDisplay = read('web/src/utils/vodDisplay.ts');

let checks = 0;
const check = (condition, label) => {
  checks += 1;
  assert.ok(condition, label);
  console.log('  ✓ ' + label);
};

console.log('\n1. Mozi-visszatöltés: a benchmark győztese van beállítva');
check(
  new RegExp(`readGroupSize:\\s*${tuning.winner.readGroupSize}\\b`).test(store) &&
    new RegExp(`decodeBatchSize:\\s*${tuning.winner.decodeBatchSize}\\b`).test(store),
  `RESTORE_TUNING = ${tuning.winner.readGroupSize} / ${tuning.winner.decodeBatchSize} (a mért leggyorsabb)`,
);
check(/export const RESTORE_TUNING = \{/.test(store), 'a két paraméter egy mérhető objektumban él');
check(
  /expectedRestoreBatches[\s\S]{0,600}RESTORE_TUNING\.readGroupSize/.test(store) &&
    /expectedRestoreBatches[\s\S]{0,700}RESTORE_TUNING\.decodeBatchSize/.test(store),
  'a napló „adagok=X/Y” számlálója is a beállított értékekből számol',
);
check(/clearVodDecodedCache/.test(store) && /export function clearVodDecodedCache/.test(store),
  'minden beállítás ugyanarról a mentett listáról mérhető (cache-ürítő hook)');
check(/MOVIE_COUNT\s*=\s*103_092/.test(bench), 'a benchmark 103 092 filmmel dolgozik');
check(/series:\s*\[\]/.test(bench) && /0 SOROZAT/.test(bench),
  'a benchmark KIZÁRÓLAG Mozi/film adatokkal dolgozik, sorozat nincs benne');
check(/GROUP_SIZES\s*=\s*\[[^\]]*4[^\]]*12[^\]]*16/.test(bench) &&
    /BATCH_SIZES\s*=\s*\[[^\]]*2500/.test(bench),
  'a mérés tartalmazza a 4-es, a 12-es csoportot és a 2500-as dekód-adagot');
check(/12 olvasás \/ 2500 adag/.test(bench), 'a 12 olvasás / 2500 adag külön is riportolva van');
check(tuning.winnerMeasuredMs < tuning.baseline.measuredMs &&
    tuning.twelveReadBatches.measuredMs < tuning.baseline.measuredMs,
  'a feljegyzett mérés szerint a 12-es és a 16-os csoport is gyorsabb a 4-esnél');
check(tuning.winnerModelMs < 400 && tuning.maxSyncRowsAllowed === 2500,
  'a győztes nem növeli a maximális szinkron dekód-blokkot 2500 sor fölé');

console.log('\n2. IPK gyors indulás');
const videoWait = Number(main.match(/const VIDEO_WAIT_MS = (\d+);/)?.[1]);
const logoWait = Number(main.match(/const LOGO_WAIT_MS = (\d+);/)?.[1]);
/* 2.5.394: a #37/#35 naplók szerint a maradék 400/250 ms is tiszta
   veszteség volt – a felfedés azonnal megtörténik, amint a DOM kész. */
check(videoWait === 0, `videó-várakozás ${videoWait} ms (2.5.394: teljesen eltávolítva)`);
check(logoWait === 0, `logó-várakozás ${logoWait} ms (2.5.394: teljesen eltávolítva)`);
check(/waited >= LOGO_WAIT_MS/.test(main) && /waited >= VIDEO_WAIT_MS/.test(main),
  'nulla küszöbnél az ELSŐ ellenőrzés is enged, nem várunk még 40 ms-t sem');
check(/if \(!animatedBridge\) \{\s*afterBootAnimation\(\);/.test(main),
  'HTML-híd hiányában a felfedés AZONNAL megtörténik (nincs 400 ms kényszer-várakozás)');
check(!/migrateVodStorageIfNeeded/.test(app),
  'a boot utáni rejtett 103 ezres Mozi-visszatöltés/átírás eltávolítva');
check(/describeStoredContent\(\{ quick: true \}\)/.test(store),
  'a teljes localStorage-bejárás nem fut az indulás kritikus útján');

console.log('\n3. TV Doktor 0-ablak: 8 doboz, nincs alsó instrukciós sor, egy igazságforrás');
check(/export const MAX_CHANNEL_ROUTES = 8;/.test(doctor),
  'a kliens 8 tanult útvonalat tárol (a Supabase Edge Functionnel egyezően)');
check(!/OK \/ Enter: minden mentett részlet/.test(modal) &&
    !/minden mentett részlet/.test(modal) &&
    !/• lapozható/.test(modal),
  'mind a négy kategóriadobozból TELJESEN eltávolítva az alsó OK/Enter sor');
/* 2.5.397: a felhasználó explicit visszavonta a 9 dobozos elrendezést
   („nem 9 doboz kell csak 8 !!!!”). 1 alap + 7 tanult sor = PONTOSAN 8 doboz;
   a MAX_CHANNEL_ROUTES=8 tárolási korlát változatlan marad. */
check(/data-tv-doctor-route-boxes="8"/.test(modal) &&
    /Array\.from\(\{ length: MAX_CHANNEL_ROUTES - 1 \}/.test(modal) &&
    !/Array\.from\(\{ length: MAX_CHANNEL_ROUTES \}/.test(modal) &&
    /\{activeRoutes\.length\} \/ \{MAX_CHANNEL_ROUTES\}/.test(modal),
  'a Tanult útvonalak PONTOSAN 8 dobozt (1 alap + 7 tanult) és „/ 8” számlálót rajzol');
check(/getTvDoctorChannelSnapshot\(activeChannel, cloudRoutes\)/.test(modal),
  'a 4 doboz és az útvonallista UGYANABBÓL a pillanatképből készül (helyi + Supabase)');
check(/export function getTvDoctorChannelSnapshot/.test(doctor) &&
    /merge|Map<string, DoctorRoute>/.test(doctor),
  'a pillanatkép a helyi tanulást és a felhőt összevonja');
check(/setCloudRoutes\(\[\]\)/.test(modal) && /setResetVersion\(\(n\) => n \+ 1\)/.test(modal),
  'Memória: 0 után a képernyő azonnal 0-t mutat és újraolvassa a Supabase-t');
check(/data-tv-doctor-baseline-slot="1"/.test(modal) && /1\. ALAP/.test(modal),
  '2.5.394: az 1-es HELYEN mindig a zárolt ALAP látszik, a tanult útvonalak csak 2-estől jönnek');
check(/getTvDoctorCentralProfileState/.test(modal) && /Központi profilok/.test(modal) &&
    !/data-tv-doctor-central-profiles/.test(modal),
  '2.5.397: a központi profilok CSAK a jobb oldali Supabase-panelen vannak; a bal oldali összesítő doboz megszűnt');
check(/TV DOKTOR SUPABASE KÖR/.test(cloud) && /restoreTvDoctorCloudState\(\)/.test(cloud),
  '2.5.394: Memória: 0 után azonnal fut a teljes tv -> Supabase -> tv visszatöltés');
check(/TV DOKTOR NULLÁZÁS ELLENŐRZÉS/.test(modal),
  'a nullázás után ellenőrző naplósor készül a dobozok és útvonalak számaival');
check(/TV DOKTOR 0-ABLAK ELLENŐRZÉS/.test(cloud) && /ÖSSZESÍTETT_kategóriák/.test(cloud),
  'a kézi napló külön jelöli a globális számlálót és a 0-ablak tényleges doboz-értékeit');
check(!/automatikusan visszatöltődik a 8 tanult útvonal\/csatorna/.test(cloud),
  'a napló nem ír többé fix, nem mért „8 tanult útvonal” állítást a Supabase-ről');

console.log('\n4. Mozi-plakát: mentett játékidő a jobb sarokban');
check(/data-movie-runtime=""/.test(moviesView), 'a plakáton játékidő-jelvény van tesztelhető attribútummal');
check(/absolute right-2 top-2/.test(moviesView), 'a jelvény a plakát JOBB FELSŐ sarkában van');
check(/movieRuntimeLabel\(mov\)/.test(moviesView), 'a jelvény a mentett játékidőből dolgozik');
check(/export function movieRuntimeLabel/.test(vodDisplay) &&
    /parseMovieCatalogMetadata/.test(vodDisplay) && /detailProviderData/.test(vodDisplay),
  'hiányzó lista-mező esetén is a MÁR elmentett get_vod_info nyers adatból olvas, nem kér újat');
check((moviesView.match(/movieRuntimeLabel\(mov\)/g) || []).length >= 3,
  'a kártya alsó sora és a plakátjelvény ugyanazt a mentett értéket mutatja');

console.log(`\n2.5.392 + 2.5.394 regressziós teszt: ${checks} sikeres, 0 hibás. ✅\n`);
