#!/usr/bin/env node
/**
 * A tároló-kvóta próba (tools/storage-quota.spec.ts).
 *
 * A próba TypeScript-ben íródott, ezért előbb egyetlen JavaScript fájlba
 * csomagoljuk az esbuild segítségével (a web/ projekt fejlesztői csomagjának
 * része), majd lefuttatjuk – ugyanaz a menet, mint a tools/test-import.mjs.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, '..');
const esbuild = resolve(projectDir, 'web/node_modules/.bin/esbuild');
const outDir = resolve(projectDir, 'build/tests');
const outFile = resolve(outDir, 'storage-quota.spec.mjs');

if (!existsSync(esbuild)) {
  console.error('Hiányzik az esbuild (web/node_modules). Futtasd: cd web && npm install');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const bundle = spawnSync(
  esbuild,
  [
    resolve(here, 'storage-quota.spec.ts'),
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
