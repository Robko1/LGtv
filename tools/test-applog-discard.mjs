#!/usr/bin/env node
/*
 * SIKERES KÜLDÉS UTÁN TÖRLŐDŐ NAPLÓ – futásidejű teszt.
 *
 * A napló tartalma a küldés után eddig a memóriában (akár 1 MB) ÉS a
 * localStorage-ban (120 000 karakter) is ott maradt, holott a szerveren már
 * megvan – feleslegesen foglalta a TV memóriáját és a szűk tárhelyét.
 *
 * Ez a teszt a VALÓDI appLog modult futtatja (esbuild-del csomagolva), és
 * ellenőrzi, hogy:
 *   1. naplózás közben a sorok a memóriában és a localStorage-ban vannak;
 *   2. SIKERES küldés után a napló a RAM-ból és a localStorage-ból is törlődik;
 *   3. a következő naplózás tiszta adatokkal indul (új sorszám, üres lista),
 *      és ugyanazokat az eseményeket rögzíti;
 *   4. SIKERTELEN küldés esetén (a törlés NEM fut le) a napló megmarad az
 *      újrapróbálkozáshoz.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('.');
let esbuild;
try {
  esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
} catch {
  console.log('KIPARANCSOLT: esbuild hiányzik – npm install --prefix web');
  process.exit(0);
}

const outFile = path.resolve('build/test/applog-discard-bundle.mjs');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: {
    contents: `export {
      appLog, discardSentAppLog, getAppLogText, manualLogSnapshot,
      startManualLogging, stopManualLogging, startAutomaticTestLogging, resumeAutomaticTestLogging,
    } from './web/src/services/appLog.ts';`,
    resolveDir: ROOT,
    sourcefile: 'applog-discard-harness.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2020',
  nodePaths: [path.resolve('web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: outFile,
  logLevel: 'silent',
});

/* ------------------------------------------------------------ környezet */

const store = new Map();
const localStorageFake = {
  get length() { return store.size; },
  key: (index) => Array.from(store.keys())[index] ?? null,
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
  clear: () => store.clear(),
};

globalThis.localStorage = localStorageFake;
// A Node 22 `navigator`-a csak olvasható: defineProperty-vel írjuk felül.
try {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'teszt-környezet' }, configurable: true });
} catch { /* marad a Node beépített navigatora */ }
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = {
  localStorage: localStorageFake,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  addEventListener: () => {},
  removeEventListener: () => {},
};

const app = await import(pathToFileURL(outFile).href);
const LOG_KEY = 'iptv_rt_app-log';
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const checks = [];
let failed = false;
const check = (ok, message, detail = '') => {
  checks.push(`${ok ? 'ok  ' : 'HIBA'} – ${message}${ok || !detail ? '' : ` (${detail})`}`);
  if (!ok) failed = true;
};

try {
  check(app.startAutomaticTestLogging().enabled === false, 'az automatikus indítás ki van kapcsolva');
  check(app.resumeAutomaticTestLogging().enabled === false, 'automatikus folytatás sincs');
  /* ============ 1. NAPLÓZÁS: memória + localStorage ===================== */
  const started = app.startManualLogging();
  check(started.enabled === true, 'a naplózás elindul');
  check(Number.isFinite(started.number) && started.number > 0, 'a napló sorszámot kap', String(started.number));
  const firstNumber = started.number;

  app.appLog('TESZT SOR 1; fontos esemény');
  app.appLog('TESZT SOR 2; csatornaváltás');
  app.stopManualLogging('teszt leállítás');
  await settle();

  const textBefore = app.getAppLogText();
  check(textBefore.includes('TESZT SOR 1'), 'a napló sorai a memóriában vannak');
  const persisted = localStorageFake.getItem(LOG_KEY) || '';
  check(persisted.includes('TESZT SOR 1'), 'a napló a localStorage-ban is ott van', `${persisted.length} karakter`);

  /* ============ 2. SIKERES KÜLDÉS: minden naplóadat törlődik ============ */
  const afterSend = app.discardSentAppLog();
  await settle();
  check(app.getAppLogText() === '', 'sikeres küldés után a napló a RAM-ból is törlődik');
  check(!localStorageFake.getItem(LOG_KEY), 'sikeres küldés után a napló a localStorage-ból is törlődik');
  check(afterSend.lineCount === 0, 'a naplósorok száma 0', String(afterSend.lineCount));
  check(afterSend.charCount === 0, 'a napló mérete 0', String(afterSend.charCount));
  check(afterSend.number === null, 'a lezárt napló sorszáma nem marad aktívként', String(afterSend.number));
  check(afterSend.enabled === false, 'a naplózás leállítva marad');

  /* ============ 3. A KÖVETKEZŐ NAPLÓZÁS TISZTA ADATOKKAL INDUL ========== */
  const restarted = app.startManualLogging();
  check(restarted.enabled === true, 'a következő naplózás elindítható');
  check(restarted.number > firstNumber, 'a következő naplózás ÚJ sorszámot kap',
    `${firstNumber} → ${restarted.number}`);
  check(
    restarted.lineCount > 0 && restarted.lineCount <= 10,
    'az új napló tiszta (csak a saját fejléc-sorai vannak benne)',
    String(restarted.lineCount),
  );
  check(!app.getAppLogText().includes('TESZT SOR 2'), 'az új napló indulásakor nincs benne régi sor');
  app.appLog('ÚJ NAPLÓ SOR; ugyanaz az esemény');
  const textAfter = app.getAppLogText();
  check(textAfter.includes('ÚJ NAPLÓ SOR'), 'az új napló ugyanazokat az eseményeket rögzíti');
  check(!textAfter.includes('TESZT SOR 1'), 'a régi, elküldött sorok NEM jönnek vissza az új naplóba');
  app.stopManualLogging('teszt vége');
  await settle();

  /* ============ 4. SIKERTELEN KÜLDÉS: a napló megmarad ================== */
  const beforeFailure = app.getAppLogText();
  const beforeFailureStored = localStorageFake.getItem(LOG_KEY) || '';
  check(beforeFailure.includes('ÚJ NAPLÓ SOR'), 'sikertelen küldésnél a napló a memóriában marad');
  check(beforeFailureStored.includes('ÚJ NAPLÓ SOR'), 'sikertelen küldésnél a napló a localStorage-ban is megmarad',
    `${beforeFailureStored.length} karakter`);

  // A felület küldés után leállítja a naplózást, de a tartalmat csak siker
  // esetén törli – a törlés tehát itt szándékosan NEM fut le.
  check(app.manualLogSnapshot().charCount > 0, 'a napló újraküldhető (van tartalom)', String(app.manualLogSnapshot().charCount));
} catch (error) {
  failed = true;
  checks.push(`HIBA – a teszt lefutása közben hiba történt: ${error?.stack || error}`);
}

for (const line of checks) console.log(line);
const bad = checks.filter((line) => line.startsWith('HIBA')).length;
console.log(`\n${checks.length - bad}/${checks.length} ellenőrzés sikeres.`);
if (failed || bad > 0) {
  console.error('\nA napló-törlés tesztje NEM futott át. ❌');
  process.exit(1);
}
console.log('A napló-törlés tesztje minden ellenőrzésen átment. ✅');
process.exit(0);
