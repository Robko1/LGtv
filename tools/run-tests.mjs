#!/usr/bin/env node
/**
 * PÁRHUZAMOS TESZTFUTTATÓ (2.5.222).
 *
 * Korábban a `npm test` az összes tesztfájlt SZIGORÚAN egymás után futtatta
 * (`node a.mjs && node b.mjs && …`), ezért a teljes futás ~2 percig tartott,
 * és ez volt az IPK-workflow leghosszabb lépése. A tesztek egymástól
 * függetlenek: mindegyik saját, egyedi nevű bundle-fájlba ír a build/test
 * alá, a beépített tesztszerverek pedig 0-s (efemer) portot használnak –
 * tehát biztonságosan futtathatók párhuzamosan.
 *
 * Ez a futtató korlátozott párhuzamossággal (alapból a CPU-magok száma,
 * legfeljebb 4) indítja ugyanazokat a parancsokat. Minden teszt kimenete
 * pufferelve, a teszt BEFEJEZÉSEKOR egyben íródik ki, így a napló nem
 * keveredik össze. Ha bármelyik teszt hibázik, a futás a végén hibával áll
 * le, és a hibás tesztek listája külön is megjelenik.
 *
 * Felülbírálás: TEST_CONCURRENCY=1 npm test  → régi, soros viselkedés.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';

const tasks = [
  // A node:test alapú fájlok egyetlen futásban (a runner magától párhuzamosít).
  {
    name: 'node --test (böngészős + egység)',
    args: [
      '--test',
      'tools/test-speed-diagnostics.mjs',
      'tools/test-fullscreen-switch.mjs',
      'tools/test-osd-layout-browser.mjs',
      'tools/test-channel-navigation-browser.mjs',
      'tools/test-track-selectors-browser.mjs',
      'tools/test-tv-navigation.mjs',
      'tools/test-vod-cc.mjs',
      'tools/test-live-cc.mjs',
    ],
  },
  { name: 'live-format', args: ['tools/test-live-format.mjs'] },
  { name: 'playback-recovery', args: ['tools/test-playback-recovery.mjs'] },
  { name: 'player-runtime', args: ['tools/test-player-runtime.mjs'] },
  { name: 'startup-watchdog-runtime', args: ['tools/test-startup-watchdog-runtime.mjs'] },
  { name: 'channel-switch-diagnostics-runtime', args: ['tools/test-channel-switch-diagnostics-runtime.mjs'] },
  { name: 'channel-navigation-runtime', args: ['tools/test-channel-navigation-runtime.mjs'] },
  { name: 'live-switch-performance', args: ['tools/test-live-switch-performance.mjs'] },
  { name: 'tv-only-runtime', args: ['tools/test-tv-only-runtime.mjs'] },
  { name: 'vod-controls-runtime', args: ['tools/test-vod-controls-runtime.mjs'] },
  { name: 'track-selectors', args: ['tools/test-track-selectors.mjs'] },
  { name: 'bridge', args: ['tools/test-bridge.mjs'] },
  { name: 'channel-logos', args: ['tools/test-channel-logos.mjs'] },
  { name: 'import', args: ['tools/test-import.mjs'] },
  { name: 'vod-metadata', args: ['tools/test-vod-metadata.mjs'] },
  { name: 'vod-cached-detail', args: ['tools/test-vod-cached-detail.mjs'] },
  { name: 'vod-provider-diagnostics', args: ['tools/test-vod-provider-diagnostics.mjs'] },
  { name: 'persistence', args: ['tools/test-persistence.mjs'] },
  { name: 'durable-restart', args: ['tools/test-durable-restart.mjs'] },
  { name: 'live-cache', args: ['tools/test-live-cache.mjs'] },
  { name: 'applog-discard', args: ['tools/test-applog-discard.mjs'] },
  { name: 'channel-selection', args: ['tools/test-channel-selection.mjs'] },
  { name: 'provider-delete', args: ['tools/test-provider-delete.mjs'] },
  { name: 'provider-load', args: ['tools/test-provider-load.mjs'] },
  { name: 'epg-guide', args: ['tools/test-epg-guide.mjs'] },
  { name: 'storage-quota', args: ['tools/test-storage-quota.mjs'] },
  { name: 'import-stress', args: ['tools/test-import-stress.mjs'] },
  { name: 'applog-runtime', args: ['tools/test-applog-runtime.mjs'] },
  { name: 'quality-diagnostics', args: ['tools/test-quality-diagnostics.mjs'] },
  { name: 'tv-device', args: ['tools/test-tv-device.mjs'] },
  { name: 'tv-doctor', args: ['tools/test-tv-doctor.mjs'] },
];

const requested = Number(process.env.TEST_CONCURRENCY || '');
const concurrency = Number.isFinite(requested) && requested >= 1
  ? Math.floor(requested)
  : Math.max(1, Math.min(4, os.cpus().length));

function runTask(task) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, task.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const header = `\n===== ${task.name} — ${code === 0 ? 'SIKERES' : `HIBA (kilépési kód: ${code})`} — ${seconds}s =====\n`;
      process.stdout.write(header + output);
      resolve({ name: task.name, code: code ?? 1 });
    });
    child.on('error', (error) => {
      process.stdout.write(`\n===== ${task.name} — INDÍTÁSI HIBA: ${error} =====\n`);
      resolve({ name: task.name, code: 1 });
    });
  });
}

const queue = tasks.slice();
const results = [];
const startedAt = Date.now();
async function worker() {
  while (queue.length > 0) {
    const task = queue.shift();
    if (!task) return;
    results.push(await runTask(task));
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));

const failed = results.filter((result) => result.code !== 0);
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
if (failed.length > 0) {
  console.error(`\nHIBA: ${failed.length}/${results.length} tesztcsoport sikertelen (${seconds}s):`);
  for (const result of failed) console.error(`  ✗ ${result.name}`);
  process.exit(1);
}
console.log(`\nOK: mind a(z) ${results.length} tesztcsoport sikeres, párhuzamosság=${concurrency}, idő=${seconds}s.`);
