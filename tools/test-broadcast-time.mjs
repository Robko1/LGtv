#!/usr/bin/env node
/**
 * 2.5.297 – MŰSORIDŐ ÉS IDŐZÓNA PRÓBA.
 *
 * A magyar csatornák műsorideje a magyar óra szerint értendő. A panelek és az
 * XMLTV gyakran időzóna nélkül adja az időpontokat; ezeket MAGYAR időnek kell
 * venni, és a felületen is magyar időben kell kiírni – akkor is, ha a néző
 * Írországban (UTC+0) vagy máshol él.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve('.');
const esbuild = createRequire(path.resolve('web/package.json'))('esbuild');
const outDir = path.resolve('build/test');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'broadcast-time.mjs');

await esbuild.build({
  entryPoints: [path.resolve('web/src/utils/broadcastTime.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: outFile,
  logLevel: 'silent',
});

const mod = await import(pathToFileURL(outFile).href);

let passed = 0;
let failed = 0;
function check(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ HIBA: ${label}${detail ? ` – ${detail}` : ''}`);
}

const { parseBroadcastTime, formatBudapestTime, budapestOffsetMinutes } = mod;
const utc = (y, mo, d, h, mi, s = 0) => Math.floor(Date.UTC(y, mo - 1, d, h, mi, s) / 1000);

console.log('\n1. Időzóna nélküli időpont = MAGYAR idő (nem a készülék helyi ideje)');
// Téli idő (CET, UTC+1): 2026-11-04 02:00 magyar idő = 01:00 UTC.
check(
  parseBroadcastTime('2026-11-04 02:00:00') === utc(2026, 11, 4, 1, 0),
  'a „2026-11-04 02:00:00” (időzóna nélkül) télen 01:00 UTC-nek felel meg',
  String(parseBroadcastTime('2026-11-04 02:00:00')),
);
// Nyári idő (CEST, UTC+2): 2026-07-15 02:00 magyar idő = 00:00 UTC.
check(
  parseBroadcastTime('2026-07-15 02:00:00') === utc(2026, 7, 15, 0, 0),
  'a „2026-07-15 02:00:00” nyáron 00:00 UTC-nek felel meg (nyári időszámítás)',
  String(parseBroadcastTime('2026-07-15 02:00:00')),
);
// XMLTV tömör alak, időzóna nélkül.
check(
  parseBroadcastTime('20261104023000') === utc(2026, 11, 4, 1, 30),
  'az XMLTV tömör alak (20261104023000) is magyar időként értelmeződik',
  String(parseBroadcastTime('20261104023000')),
);

console.log('\n2. Megadott időzóna továbbra is elsőbbséget élvez');
check(
  parseBroadcastTime('2026-11-04 02:00:00 +0100') === utc(2026, 11, 4, 1, 0),
  'az explicit +0100 eltolást tiszteletben tartjuk',
);
check(
  parseBroadcastTime('2026-11-04T02:00:00Z') === utc(2026, 11, 4, 2, 0),
  'a Z (UTC) jelölést tiszteletben tartjuk',
);
check(
  parseBroadcastTime('2026-11-04 02:00:00 +02:00') === utc(2026, 11, 4, 0, 0),
  'a kettőspontos +02:00 alakot is olvassuk',
);
check(parseBroadcastTime('') === 0 && parseBroadcastTime('nincs idő') === 0, 'érvénytelen szövegnél 0-t ad');

console.log('\n3. Megjelenítés magyar időben (a néző bárhol él)');
// 2026-11-04 01:00 UTC = 02:00 magyar idő (tél).
check(
  formatBudapestTime(utc(2026, 11, 4, 1, 0)) === '02:00',
  'a 01:00 UTC télen 02:00-ként jelenik meg',
  formatBudapestTime(utc(2026, 11, 4, 1, 0)),
);
// 2026-07-15 00:00 UTC = 02:00 magyar idő (nyár).
check(
  formatBudapestTime(utc(2026, 7, 15, 0, 0)) === '02:00',
  'a 00:00 UTC nyáron 02:00-ként jelenik meg',
  formatBudapestTime(utc(2026, 7, 15, 0, 0)),
);
check(formatBudapestTime(0) === '--:--', 'ismeretlen időre „--:--” jelenik meg');

console.log('\n4. Óraátállítás (EU-szabály, Intl nélkül)');
// 2026: nyári időszámítás március 29-én 01:00 UTC-től október 25-én 01:00 UTC-ig.
check(budapestOffsetMinutes(utc(2026, 3, 29, 0, 59) * 1000) === 60, 'óraátállítás előtt egy perccel még téli idő (+1)');
check(budapestOffsetMinutes(utc(2026, 3, 29, 1, 0) * 1000) === 120, 'óraátállításkor nyári időre váltunk (+2)');
check(budapestOffsetMinutes(utc(2026, 10, 25, 0, 59) * 1000) === 120, 'őszi óraátállítás előtt még nyári idő (+2)');
check(budapestOffsetMinutes(utc(2026, 10, 25, 1, 0) * 1000) === 60, 'őszi óraátállításkor visszaállunk téli időre (+1)');

console.log('');
if (failed > 0) {
  console.error(`Műsoridő-tesztek: ${passed} sikeres, ${failed} hibás. ❌\n`);
  process.exit(1);
}
console.log(`Műsoridő-tesztek: ${passed} sikeres, 0 hibás. ✅`);
console.log('A magyar műsorújság minden országban magyar időt mutat.\n');
