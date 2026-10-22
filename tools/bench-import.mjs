#!/usr/bin/env node
/**
 * Szolgáltatói betöltés sebességmérő próba (nem hivatalos teszt).
 *
 * Egy valósághű méretű hamis Xtream panelt indít, és méri, mennyi idő alatt
 * lesz a csatornalista használható, illetve mennyi idő alatt készül el a
 * teljes lista (filmek + sorozatok). A számok a fejlesztéshez kellenek:
 * minden teljesítmény-javítás után újra futtatható, hogy látszódjon a
 * különbség (a referencia alkalmazás ugyanezt a nagyságrendet célozza).
 *
 * Futtatás:
 *   node tools/bench-import.mjs                 # alap méret
 *   LIVE=30000 VOD=30000 SERIES=8000 node tools/bench-import.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, '..');
const esbuild = resolve(projectDir, 'web/node_modules/.bin/esbuild');
const outDir = resolve(projectDir, 'build/tests');
const outFile = resolve(outDir, 'bench-import.mjs');

if (!existsSync(esbuild)) {
  console.error('Hiányzik az esbuild (web/node_modules). Futtasd: cd web && npm install');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const bundle = spawnSync(
  esbuild,
  [
    resolve(here, 'bench-import.spec.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    '--log-level=warning',
    `--outfile=${outFile}`,
  ],
  { stdio: 'inherit' }
);

if (bundle.status !== 0) {
  console.error('A sebességmérő összeállítása nem sikerült.');
  process.exit(bundle.status || 1);
}

await import(pathToFileURL(outFile).href);
