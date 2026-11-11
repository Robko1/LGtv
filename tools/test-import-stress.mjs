#!/usr/bin/env node
/**
 * A terheléses szolgáltatói próba futtatója.
 *
 * A próba TypeScript-ben íródott (tools/import-stress.spec.ts), ezért az
 * esbuild csomagolja egyetlen JavaScript fájlba, majd úgy fut le – ugyanúgy,
 * ahogy a tools/test-import.mjs teszi.
 *
 * Futtatás: node tools/test-import-stress.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, '..');
const esbuild = resolve(projectDir, 'web/node_modules/.bin/esbuild');
const outDir = resolve(projectDir, 'build/tests');
const outFile = resolve(outDir, 'import-stress.spec.mjs');

if (!existsSync(esbuild)) {
  console.error('Hiányzik az esbuild (web/node_modules). Futtasd: cd web && npm install');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const bundle = spawnSync(
  esbuild,
  [
    resolve(here, 'import-stress.spec.ts'),
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
  console.error('A terheléses próba összeállítása nem sikerült.');
  process.exit(bundle.status || 1);
}

await import(pathToFileURL(outFile).href);
