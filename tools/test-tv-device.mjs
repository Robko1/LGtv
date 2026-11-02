/**
 * A TV TÍPUS-ADAT PRÓBÁJA (2.5.158).
 *
 * A napló fejlécében és a TV TÍPUS sorban a készülék modelljének, webOS
 * verziójának és appId-jének kell szerepelnie, mert a későbbi fejlesztéseknél
 * minden beérkező naplóról látszania kell, milyen TV-n készült.
 *
 * A próba a tényleges `web/src/services/tvDevice.ts` modult futtatja:
 *   • webOS Luna-híd (webOSTV.js) → modellnév, verzió, SDK, alaplap, appId;
 *   • híd nélküli TV → „nem derül ki” (a napló nem talál ki adatot);
 *   • a megtalált adat a localStorage-ba kerül, és a következő indításkor
 *     a híd nélkül is megjelenik (ÁLLANDÓ adat).
 *
 * Futtatás: node tools/test-tv-device.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, '..');
const esbuild = resolve(projectDir, 'web/node_modules/.bin/esbuild');
const outDir = resolve(projectDir, 'build/tests');
const outFile = resolve(outDir, 'tv-device.spec.mjs');

if (!existsSync(esbuild)) {
  console.error('Hiányzik az esbuild (web/node_modules). Futtasd: cd web && npm install');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const bundle = spawnSync(
  esbuild,
  [
    resolve(here, 'tv-device.spec.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    '--log-level=warning',
    `--outfile=${outFile}`,
  ],
  { stdio: 'inherit', cwd: projectDir }
);

if (bundle.status !== 0) {
  console.error('A próba összeállítása nem sikerült.');
  process.exit(bundle.status || 1);
}

await import(pathToFileURL(outFile).href);
