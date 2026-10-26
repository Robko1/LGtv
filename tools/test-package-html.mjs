#!/usr/bin/env node
/*
 * A CSOMAGOLT index.html kiadás előtti ellenőrzése.
 *
 * Futtatás:  node --test tools/test-package-html.mjs     (vagy: npm test)
 *
 * Miért van ez a teszt?
 *
 * A GitHub Actions „10. IPK ellenőrzése” lépése azt vizsgálja, hogy a csomagba
 * került index.html valóban production build-e, azaz nem maradt-e benne a
 * fejlesztői belépő (`<script type="module" src="/src/main.tsx">`). A Chrome 61
 * alatti webOS TV-motorokon egy module script miatt az app el sem indulna.
 *
 * Ez az ellenőrzés sokáig sima szövegrészlet-keresés volt:
 *
 *     if '/src/main.tsx' in html:  -> HIBA
 *
 * A `webos/webos.js` viszont BEÉGETVE kerül a csomagolt index.html-be, ezért
 * egyetlen forráskomment, amely csak megemlítette a fájlnevet, megbuktatta a
 * teljes kiadást (ez állította le a 2.5.108-as IPK-buildet). A komment
 * javítása önmagában nem elég: ugyanígy elhasalhatna bármi, ami később bekerül
 * a webos.js-be vagy a beégetett HTML-be. Ezért:
 *
 *   1. a CI-ellenőrzés a VALÓDI script-hivatkozást keresi (regex), és
 *   2. ez a teszt már az `npm test` alatt (tehát a build ELŐTT) elhasal, ha a
 *      beégetett forrásokban fejlesztői modul-hivatkozás jelenik meg, és
 *   3. kipróbálja magát az ellenőrzést is: egy igazi dev-belépőre bukik, egy
 *      puszta említésre nem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Ugyanaz a minta, amit a CI Python-kódja használ (a workflow-beli `["\']`
 * és az itteni `["']` ugyanarra a dupla idézőjelre illeszkedik). Ha a
 * workflow-ban változik, ezt is át kell írni – a lenti teszt éppen ezért
 * ellenőrzi a workflow szövegét is.
 */
const DEV_MAIN_ENTRY = /<script[^>]*\ssrc=["'][^"']*\/src\/main\.tsx/;
const DEV_SRC_ENTRY = /<script[^>]*\ssrc=["']\/src\//;

const hasDevEntry = (html) => DEV_MAIN_ENTRY.test(html) || DEV_SRC_ENTRY.test(html);

test('a beégetett webos.js nem tartalmaz fejlesztői modul-hivatkozást', () => {
  const webos = read('webos/webos.js');
  assert.ok(
    !/<script[^>]*\ssrc=["'][^"']*\/src\//.test(webos),
    'a webos.js beégetve kerül a csomagolt index.html-be; fejlesztői /src/ hivatkozás nem lehet benne'
  );
  /*
   * Ennél szigorúbban: a fájlban SEMMILYEN `/src/...` útvonal-említés nem
   * szerepelhet, mert a korábbi, szövegrészlet-alapú CI-ellenőrzés éppen ezen
   * akadt fenn. A megjegyzések a fájlnevet írják le útvonal nélkül.
   */
  const offending = webos
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes('/src/'));
  assert.deepEqual(
    offending.map(({ index, line }) => `${index + 1}: ${line.trim()}`),
    [],
    'a webos.js /src/ útvonalat említ – ez a csomagolt HTML-be kerülve megbuktatja a kiadást'
  );
});

test('a csomagolt HTML-ben nincs fejlesztői belépő (ha a build elkészült)', () => {
  const built = path.join(ROOT, 'build/webos/index.html');
  if (!fs.existsSync(built)) return; // a build a CI-ben a teszt után fut
  const html = fs.readFileSync(built, 'utf8');
  assert.ok(html.includes('id="root"'), 'hiányzik az id="root" a csomagolt HTML-ből');
  assert.ok(!hasDevEntry(html), 'a csomagolt index.html fejlesztői /src/ belépőt tartalmaz');
});

test('az ellenőrzés felismeri a valódi fejlesztői belépőt', () => {
  const devBuild =
    '<!doctype html><html><body><div id="root"></div>' +
    '<script type="module" src="/src/main.tsx"></script></body></html>';
  assert.ok(hasDevEntry(devBuild), 'a dev-belépőt fel kellett volna ismerni');

  const devBuildRelative =
    '<div id="root"></div><script type="module" src=\'/src/entry.js\'></script>';
  assert.ok(hasDevEntry(devBuildRelative), 'a /src/ alatti dev belépőt is fel kellett volna ismerni');
});

test('az ellenőrzés NEM bukik el egy puszta említésen', () => {
  const production = [
    '<!doctype html><html><body><div id="root"></div>',
    '<script>/* a főoldal saját döntése (a React belépő, main.tsx) 9 mp */</script>',
    '<script>// régen itt állt: /src/main.tsx</script>',
    '<script>var IPTV_ES5_APP=1;var url="https://pelda.hu/main.tsx";</script>',
    '<script src="webOSTV.js"></script>',
    '</body></html>',
  ].join('');
  assert.ok(!hasDevEntry(production), 'a komment/szöveg nem számít dev-belépőnek');
});

test('a CI IPK-ellenőrzése a valódi script-hivatkozást keresi, nem szövegrészletet', () => {
  const workflow = read('.github/workflows/webos-build.yml');
  // A workflow Python-kódban, raw stringben keresi a valódi script-címkét.
  assert.ok(
    workflow.includes("re.search(r'<script") && workflow.includes('/src/main\\.tsx'),
    'a workflow nem a pontosított (regex) dev-belépő ellenőrzést használja'
  );
  assert.ok(
    !workflow.includes("'/src/main.tsx' in html"),
    'a workflow még mindig szövegrészlet-kereséssel vizsgálja a dev-belépőt – ' +
      'egy forráskomment is megbuktatná a kiadást'
  );
  // A dev-belépőre bukó ág nem tűnhet el: nélküle module script kerülhetne a TV-re.
  assert.ok(
    workflow.includes('nem production build'),
    'a workflowból hiányzik a dev-belépőt elutasító hibaág'
  );
});

test('a csomagolt HTML-be égetett takarókép jelölője feloldódik', () => {
  /*
   * A build a __IPTV_SPLASH_DATA_URI__ jelölőt base64 képpel helyettesíti.
   * Ha a jelölő a forrásból eltűnne, a build `SystemExit`-tel állna le; ha a
   * csomagolt HTML-ben maradna, érvénytelen url() kerülne a takaróképbe.
   */
  assert.ok(read('web/index.html').includes('__IPTV_SPLASH_DATA_URI__'));
  const built = path.join(ROOT, 'build/webos/index.html');
  if (!fs.existsSync(built)) return;
  const html = fs.readFileSync(built, 'utf8');
  assert.ok(!html.includes('__IPTV_SPLASH_DATA_URI__'), 'a jelölő feloldatlanul maradt a csomagban');
  assert.ok(html.includes('data:image/jpeg;base64,'), 'a takarókép nincs beégetve a csomagolt HTML-be');
});
