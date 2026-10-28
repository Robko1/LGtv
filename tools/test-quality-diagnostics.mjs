#!/usr/bin/env node
/**
 * A képminőség-diagnosztika olvasóinak próbája – lásd tools/quality-diagnostics.spec.ts.
 *
 * A próba a TÉNYLEGES forráskódot futtatja (esbuild csomagolja a két
 * szolgáltatást), szintetikus MPEG-TS PMT-en, HLS lejátszási listán,
 * Matroska fejlécen és TV sourceInfo válaszokon. Azt ellenőrzi, hogy a
 * naplóba kerülő felbontás/kodek/bitráta/HDR adatok helyesek, és hogy a
 * felirat-felderítés emellett változatlanul működik.
 *
 * Futtatás: node tools/test-quality-diagnostics.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, '..');
const esbuild = resolve(projectDir, 'web/node_modules/.bin/esbuild');
const outDir = resolve(projectDir, 'build/tests');
const outFile = resolve(outDir, 'quality-diagnostics.spec.mjs');

if (!existsSync(esbuild)) {
  console.error('Hiányzik az esbuild (web/node_modules). Futtasd: cd web && npm install');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const bundle = spawnSync(
  esbuild,
  [
    resolve(here, 'quality-diagnostics.spec.ts'),
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
