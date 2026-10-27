/**
 * A BETÖLTŐKÉPERNYŐ-HÍD PRÓBÁJA (web/src/services/bootScreen.ts).
 *
 * A felhasználói követelmény: a százalék, a csatornaszám, a sebesség és a
 * hátralévő idő KIZÁRÓLAG a futó alkalmazás tényleges adataiból származhat –
 * nincs demó-szimuláció, nincs véletlen érték és nincs időzített befejezés.
 *
 * Ez a próba azt ellenőrzi, hogy a híd:
 *   • csak a jelentett eseményekre lép előre (a százalék monoton),
 *   • a szolgáltatói betöltés VALÓDI 0–40%-át a képernyő 40–78%-ára képezi,
 *   • a sebességet csak sikeres, mért átvitelből számolja,
 *   • a hátralévő időt a mért eltelt időből becsüli (és nem tesz úgy, mintha
 *     tudná, ha még nincs mérés),
 *   • a 100%-ot kizárólag a kész felület jelzésére állítja be.
 *
 * Futtatás: node tools/test-boot-screen.mjs
 */

import assert from 'node:assert/strict';
import {
  BOOT_PHASES,
  bootScreenChannels,
  bootScreenComplete,
  bootScreenDetail,
  bootScreenPhase,
  bootScreenProviderProgress,
  bootScreenSnapshot,
  bootScreenStart,
  bootScreenTransfer,
  resetBootScreenForTests,
} from '../web/src/services/bootScreen';

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(error as Error).message}`);
  }
}

const reports: any[] = [];
let completions = 0;

function installBridge() {
  (globalThis as any).window = {
    __IPTV_BOOT__: {
      update: (report: any) => reports.push(report),
      complete: () => { completions += 1; },
      state: () => ({}),
    },
  };
}

function reset() {
  resetBootScreenForTests();
  reports.length = 0;
  completions = 0;
}

console.log('Betöltőképernyő: valós adatok, nincs szimuláció');

installBridge();

check('a százalék csak a befejezett szakaszokkal lép előre', () => {
  reset();
  bootScreenStart('9.9.9');
  assert.equal(bootScreenSnapshot().percent, BOOT_PHASES.bundle.percent);
  bootScreenPhase('storage');
  assert.equal(bootScreenSnapshot().percent, BOOT_PHASES.storage.percent);
  bootScreenPhase('react'); // késői, alacsonyabb szakasz
  assert.equal(bootScreenSnapshot().percent, BOOT_PHASES.storage.percent,
    'egy korábbi szakasz késői jelzése visszavitte a százalékot');
  assert.equal(bootScreenSnapshot().phase, BOOT_PHASES.storage.phase,
    'a késői jelzés felülírta a magasabb szakasz szövegét');
});

check('a szolgáltatói 0–40% a képernyő 40–78%-ává alakul (valós folyamatjelző)', () => {
  reset();
  bootScreenStart('9.9.9');
  bootScreenProviderProgress({ percent: 0, phase: 'Bejelentkezés…' });
  assert.equal(Math.round(bootScreenSnapshot().percent), 40);
  bootScreenProviderProgress({ percent: 20, phase: 'Élő lista letöltése…' });
  assert.equal(Math.round(bootScreenSnapshot().percent), 59);
  bootScreenProviderProgress({ percent: 40, phase: 'Élő csatornák feldolgozása…' });
  assert.equal(Math.round(bootScreenSnapshot().percent), 78);
  bootScreenProviderProgress({ percent: 90, phase: 'Filmek betöltése…' });
  assert.equal(Math.round(bootScreenSnapshot().percent), 78,
    'a már használható felület után a filmek letöltése nem tolhatja tovább');
  // A szöveg követheti a valós későbbi szakaszt (a felület ekkor már kész),
  // de CSAK olyat mutathat, amit az alkalmazás ténylegesen jelentett.
  assert.equal(bootScreenSnapshot().phase, 'Filmek betöltése…');
});

check('a csatornaszám a tényleges érték, és önmagában nem lép szakaszt', () => {
  reset();
  bootScreenStart('9.9.9');
  bootScreenChannels(0);
  assert.equal(bootScreenSnapshot().channels, 0);
  assert.equal(bootScreenSnapshot().percent, BOOT_PHASES.bundle.percent);
  bootScreenChannels(1834);
  assert.equal(bootScreenSnapshot().channels, 1834);
  assert.equal(bootScreenSnapshot().percent, BOOT_PHASES.bundle.percent,
    'a csatornaszám önmagában nem jelenthet „élő lista kész” szakaszt');
  bootScreenChannels(null);
  assert.equal(bootScreenSnapshot().channels, null, 'ismeretlen adatnál „—” kell');
});

check('a sebesség csak sikeres, mért átvitelből származik', () => {
  reset();
  bootScreenStart('9.9.9');
  bootScreenTransfer({ status: 'error', bytes: 999999, durationMs: 1 });
  assert.equal(bootScreenSnapshot().bytesPerSecond, null, 'hibás kérésből számolt sebesség');
  bootScreenTransfer({ status: 'success', bytes: 0, durationMs: 10 });
  assert.equal(bootScreenSnapshot().bytesPerSecond, null, '0 bájtból számolt sebesség');
  bootScreenTransfer({ status: 'success', bytes: 1_250_000, durationMs: 1000 });
  assert.equal(bootScreenSnapshot().bytesPerSecond, 1_250_000);
  bootScreenTransfer({ status: 'success', bytes: 750_000, durationMs: 1000 });
  const smoothed = bootScreenSnapshot().bytesPerSecond as number;
  assert.ok(smoothed > 750_000 && smoothed < 1_250_000, 'a mért sebesség simítása hibás');
});

check('a hátralévő idő a mért eltelt időből becsült érték', () => {
  reset();
  let clock = 1000;
  const realNow = performance.now.bind(performance);
  (performance as any).now = () => clock;
  try {
    bootScreenStart('9.9.9');
    assert.equal(bootScreenSnapshot().etaSeconds, null,
      'mérés nélkül még nem mutathatunk hátralévő időt');
    clock += 4000;
    bootScreenPhase('storage'); // 26%
    const eta = bootScreenSnapshot().etaSeconds as number;
    assert.ok(eta > 0, '4 mp és 26% után nincs becslés');
    // 4 mp alatt 26% készült el → a hátralévő 74% ~11,4 mp.
    assert.ok(eta > 8 && eta < 16, `a becslés (${eta.toFixed(1)} s) nem a mért haladásból jön`);
  } finally {
    (performance as any).now = realNow;
  }
});

check('a 100% kizárólag a kész felület jelzésére áll be', () => {
  reset();
  bootScreenStart('9.9.9');
  bootScreenPhase('shell');
  assert.ok((bootScreenSnapshot().percent as number) < 100);
  bootScreenComplete();
  assert.equal(bootScreenSnapshot().percent, 100);
  assert.equal(completions, 1, 'a „kész” jelzés nem pontosan egyszer futott');
  bootScreenComplete();
  bootScreenPhase('live');
  assert.equal(completions, 1, 'a befejezés többször futott');
  assert.equal(bootScreenSnapshot().percent, 100);
  assert.equal(bootScreenSnapshot().etaSeconds, 0);
});

check('minden jelentés átmegy a HTML-hídnak, és a verzió is látszik', () => {
  reset();
  bootScreenStart('2.5.139');
  bootScreenPhase('stored', '12 345 csatorna a tartós tárban.');
  bootScreenDetail('részlet');
  const last = reports[reports.length - 1];
  assert.equal(last.version, '2.5.139');
  assert.equal(last.detail, 'részlet');
  assert.ok(reports.length >= 3, 'nem minden szakasz jutott el a képernyőre');
});

check('a híd nélküli környezetben (teszt/SSR) minden hívás csendben visszatér', () => {
  reset();
  delete (globalThis as any).window;
  assert.doesNotThrow(() => {
    bootScreenStart('9.9.9');
    bootScreenPhase('react');
    bootScreenComplete();
  });
  installBridge();
});

if (failures > 0) {
  console.log(`\n${failures} próba nem sikerült. ❌`);
  process.exit(1);
}
console.log('\nMinden betöltőképernyő-próba sikeres. ✅');
