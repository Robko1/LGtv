#!/usr/bin/env node
/*
 * AZ ELSŐ INDULÓ CSATORNA – valódi kód, valódi futás.
 *
 * A TV-n (2.5.117, 2-es fotó) a betöltés után egy külföldi adó indult el, és
 * a csatornaváltás tartaléka is a nyers lista első elemére esett. A
 * kiválasztó modult itt közvetlenül futtatjuk (esbuild-del csomagolva).
 *
 * Futtatás:  node tools/test-channel-selection.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, '..');
const esbuild = resolve(projectDir, 'web/node_modules/.bin/esbuild');
const outDir = resolve(projectDir, 'build/tests');
const entry = resolve(outDir, 'channelSelection.entry.ts');
const outFile = resolve(outDir, 'channelSelection.mjs');

if (!existsSync(esbuild)) {
  console.log('KIPARANCSOLT: esbuild hiányzik – npm install --prefix web');
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });
spawnSync('cp', [resolve(projectDir, 'web/src/utils/channelSelection.ts'), entry]);
const build = spawnSync(esbuild, [
  entry,
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node20',
  '--log-level=warning',
  `--outfile=${outFile}`,
], { stdio: 'inherit' });
if (build.status !== 0) {
  console.error('A próba összeállítása nem sikerült.');
  process.exit(build.status || 1);
}

const { firstPlayableHungarianChannel, isPlayableChannel } = await import(pathToFileURL(outFile).href);

let failures = 0;
const check = (name, condition, extra = '') => {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` – ${extra}` : ''}`);
  }
};

const channel = (id, name, { countryCode, categoryName, streamUrl } = {}) => ({
  id,
  name,
  countryCode,
  categoryName,
  streamUrl: streamUrl ?? `http://provider.example/live/${id}.ts`,
});

/* ── A TV-n látott eset: a nyers lista első eleme külföldi adó ── */
const providerOrder = [
  channel('ar-1', 'AR: DAZN PPV 1 - NO EVENT STREAMING', { countryCode: 'AR' }),
  channel('ar-2', 'AR: DAZN PPV 2', { countryCode: 'AR' }),
  channel('hu-sep', '##### HUNGARIA #####', { countryCode: 'HU', categoryName: 'Magyarország' }),
  channel('hu-1', '[HU] M PLUS', { countryCode: 'HU', categoryName: 'Magyarország' }),
  channel('hu-2', '[HU] M1 UHD', { countryCode: 'HU', categoryName: 'Magyarország' }),
];

check('a magyar adó indul, nem a lista első (külföldi) csatornája',
  firstPlayableHungarianChannel(providerOrder)?.id === 'hu-1',
  firstPlayableHungarianChannel(providerOrder)?.id);

check('az ország-elválasztó „##### HUNGARIA #####” sor nem kapja meg a lejátszást',
  firstPlayableHungarianChannel(providerOrder)?.name === '[HU] M PLUS');

check('a „##### HUNGARIA #####” nem számít lejátszhatónak',
  isPlayableChannel(channel('x', '##### HUNGARIA #####', { countryCode: 'HU' })) === false);

check('az üres stream-című sor nem lejátszható',
  isPlayableChannel(channel('x', '[HU] M1', { countryCode: 'HU', streamUrl: '' })) === false);

/* ── Nincs magyar csatorna a listában ── */
const onlyForeign = providerOrder.slice(0, 2);
check('ha nincs magyar adó, az első lejátszható a tartalék',
  firstPlayableHungarianChannel(onlyForeign)?.id === 'ar-1');

/* ── Minden magyar sor elválasztó ── */
const onlySeparators = [
  channel('sep1', '===== MAGYAR =====', { countryCode: 'HU' }),
  channel('hu-real', '[HU] RTL', { countryCode: 'HU' }),
];
check('elválasztó sor után a valódi magyar adó jön',
  firstPlayableHungarianChannel(onlySeparators)?.id === 'hu-real');

/* ── A kategórianévből felismert magyar adó ── */
const byCategory = [
  channel('de-1', 'Das Erste', { countryCode: 'DE' }),
  channel('hu-cat', 'M2 UHD', { countryCode: 'INT', categoryName: 'Magyarország' }),
];
check('a kategórianévből is felismeri a magyar adót',
  firstPlayableHungarianChannel(byCategory)?.id === 'hu-cat');

/* ── Üres lista / hibás bemenet ── */
check('üres listánál nincs kiválasztás', firstPlayableHungarianChannel([]) === undefined);
check('hiányzó listánál nincs kiválasztás', firstPlayableHungarianChannel(undefined) === undefined);

/* ── Teljesítmény: 20 000 csatorna ── */
const big = Array.from({ length: 20000 }, (_, i) =>
  channel(`ar-${i}`, `AR ${i}`, { countryCode: 'AR' })
);
big.push(channel('hu-last', '[HU] M1', { countryCode: 'HU' }));
const started = performance.now();
const chosen = firstPlayableHungarianChannel(big);
const elapsed = performance.now() - started;
check('20 000 csatornán is megtalálja a magyart', chosen?.id === 'hu-last');
check('20 000 csatornán is gyors (< 50 ms)', elapsed < 50, `${elapsed.toFixed(1)} ms`);

console.log(failures === 0 ? '\nMinden csatornaválasztási próba sikeres. ✅' : `\n${failures} próba nem sikerült. ❌`);
process.exit(failures === 0 ? 0 : 1);
