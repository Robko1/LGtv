#!/usr/bin/env node
// Real utilities, bundled from TypeScript; controlled frames exercise races.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const esbuild = createRequire(resolve('web/package.json'))('esbuild');
const out = resolve('build/test/live-switch-performance.mjs');
mkdirSync(resolve('build/test'), { recursive: true });
await esbuild.build({ stdin: {
  contents: `export { createFullscreenSync } from './web/src/utils/fullscreenSync';
    export { displayChannelPositions } from './web/src/utils/displayChannelOrder';`,
  resolveDir: resolve('.'), loader: 'ts',
}, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
const { createFullscreenSync, displayChannelPositions } = await import(pathToFileURL(out).href);

let frames = [];
let changes = [];
const sync = createFullscreenSync((value) => changes.push(value), (fn) => { frames.push(fn); return frames.length; });
function frame() { const batch = frames; frames = []; batch.forEach((fn) => fn(0)); }
sync.set(true); frame(); sync.set(false); frame();
assert.deepEqual(changes, [false], 'BE → KI: the old second frame cannot revert the exit');
changes = [];
sync.set(true); sync.set(false); sync.set(true); frame(); frame();
assert.deepEqual(changes, [false, true], 'BE → KI → BE: only the latest entry wins');
changes = [];
sync.set(true); frame(); sync.invalidate(); frame();
assert.deepEqual(changes, [], 'unmount invalidates pending entry');
changes = [];
sync.set(true); frame(); assert.deepEqual(changes, []); frame();
assert.deepEqual(changes, [true], 'ordinary entry still waits for two frames');

const list = [{id:'a'}, {id:'b'}, {id:'c'}];
let positions = displayChannelPositions(list, ['c','a','b']);
assert.deepEqual([...positions.entries()], [['c',1], ['a',2], ['b',3]]);
positions = displayChannelPositions(list, ['c','missing','a']);
assert.deepEqual([...positions.entries()], [['a',1], ['b',2], ['c',3]], 'stale order falls back');
positions = displayChannelPositions([{id:'a'}, {id:'a'}, {id:'b'}], ['b','a','a']);
assert.equal(positions.get('a'), 2, 'same first occurrence as indexOf');
assert.equal(positions.get('missing'), undefined);
const big = Array.from({length: 60000}, (_, i) => ({id: String(i)}));
positions = displayChannelPositions(big, []);
for (let i = 0; i < 1000; i++) assert.equal(positions.get(String(i * 59)), i * 59 + 1);
console.log('OK – fullscreen frame races and indexed live channel ordering');
