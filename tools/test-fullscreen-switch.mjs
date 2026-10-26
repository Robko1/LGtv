#!/usr/bin/env node
/*
 * TELJES KÉPERNYŐ ⇄ FŐOLDAL – A VÁLTÁS GYORSÍTÁSA (2.5.119)
 *
 * A TV-n a váltás azért volt lassú, mert egyetlen kattintásra 3–6 szinkron,
 * teljes oldalas újrarendezés futott:
 *
 *   • a belépés `Object.assign`-nal ~18 inline stílust írt a lejátszóra,
 *     majd `offsetHeight`-olvasással AZONNAL meg is várta az elrendezést,
 *   • a kilépéskor a főoldali 16:9-es keret mérése ugyanezt tette vissza,
 *     még egy animációs képben és egy 250 ms-os időzítőben is,
 *   • négy `focus()` időzítő futott,
 *   • a csatornalista EPG-előtöltése minden visszatéréskor újraindult.
 *
 * Ez a próba a javított felépítést rögzíti: a geometria CSS-osztályból jön,
 * a mérés animációs képkockában történik, az EPG pedig csak a lejátszó
 * helyreállása UTÁN indul újra. Emellett a célzott naplózó modult VALÓDI
 * futásban ellenőrzi (esbuild + stub appLog), hogy a ritkítás tényleg működik.
 *
 * Futtatás: node --test tools/test-fullscreen-switch.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, '..');
const read = (rel) => readFileSync(resolve(projectDir, rel), 'utf8');

const APP = read('web/src/App.tsx');
const PLAYER = read('web/src/components/VideoPlayer.tsx');
const LIST = read('web/src/components/ChannelList.tsx');
const CSS = read('web/src/index.css');
const PERF = read('web/src/services/fullscreenPerf.ts');

/* ───────────────── 1. A geometria: CSS-osztály, nem JS stílus ───────────── */

test('1. a teljes képernyő geometriája CSS-osztályból jön, nem inline stílusból', () => {
  assert.match(PLAYER, /iptv-fs/, 'a lejátszó megkapja az iptv-fs osztályt');
  assert.match(CSS, /\[data-tv-player\]\.iptv-fs \{/, 'van .iptv-fs szabály');
  const block = CSS.slice(CSS.indexOf('[data-tv-player].iptv-fs {'));
  for (const rule of [
    /position: fixed !important;/,
    /width: 100vw !important;/,
    /height: 100vh !important;/,
    /z-index: 2147483000 !important;/,
    /aspect-ratio: auto !important;/,
  ]) {
    assert.match(block, rule, `a teljes képernyős szabály hiányos: ${rule}`);
  }
  // A főoldali mérés inline stílusait csak `!important` tudja felülírni.
  assert.match(CSS, /\[data-tv-player\]\.iptv-fs video \{[\s\S]{0,400}?object-fit: cover !important;/);
  // A React NEM ír inline stílust a váltáskor: állandó stílusobjektum.
  assert.match(PLAYER, /style=\{PLAYER_HOME_STYLE\}/);
  assert.match(PLAYER, /const PLAYER_HOME_STYLE: React\.CSSProperties = \{/);
  // A régi, belépéskori inline geometria-írás nem térhet vissza.
  assert.doesNotMatch(PLAYER, /Object\.assign\(container\.style, \{[\s\S]{0,120}?position: 'fixed'/,
    'a belépés nem írhat inline geometriát');
});

/* ─────────── 2. Nincs kényszerített újrarendezés a váltás útvonalán ────────── */

test('2. a váltás nem kényszerít szinkron újrarendezést (nincs offsetHeight-olvasás)', () => {
  // A kódban (nem a megjegyzésekben) nem maradhat kényszerített mérés.
  const code = PLAYER
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /offsetHeight/, 'a váltás nem olvashat offsetHeight-ot');
  // Nincs késleltetett (250 ms-os) újrarendezés sem: a főoldali keret
  // mérő effektjében nem maradhat időzítő-alapú újraíró.
  const layoutBlock = code.slice(code.indexOf('const appliedLayoutKeyRef'));
  const layoutEffect = layoutBlock.slice(0, layoutBlock.indexOf('}, [isFullscreen, isVod, streamUrl]);'));
  assert.doesNotMatch(layoutEffect, /settleTimers/);
  assert.doesNotMatch(layoutEffect, /setTimeout\(syncMainPageLayout/);
  assert.doesNotMatch(layoutEffect, /setTimeout\(/, 'a visszatérés nem ütemez késleltetett újraírást');
  // A mérés animációs képkockában történik, és változatlan méretnél kilép.
  assert.match(code, /frame = window\.requestAnimationFrame\(applyMeasuredLayout\)/);
  assert.match(code, /if \(key === appliedLayoutKeyRef\.current\) return;/);
  // A mérő effekt továbbra is figyel a teljes képernyőre (nem írhat a fs dobozra).
  assert.match(code, /if \(isVod \|\| isFullscreen\) return;/);
  assert.match(code, /document\.body\.classList\.contains\('iptv-tv-fullscreen'\)/);
});

/* ───────── 3. A fókusz: kevesebb, de továbbra is biztos ellenőrzés ────────── */

test('3. a fókusz-ellenőrzés két időpontra csökkent (nem négy focus() a váltáskor)', () => {
  assert.doesNotMatch(PLAYER, /\[0, 80, 260, 600\]/);
  assert.match(PLAYER, /const timers = \[0, 200\]\.map\(\(delay\) => window\.setTimeout\(assertFocus, delay\)\);/);
  assert.match(PLAYER, /container\.focus\(\{ preventScroll: true \} as any\)/, 'a fókusz nem görget');
});

/* ──────────── 4. Visszatérés: az EPG/OSD csak utána indul újra ────────────── */

test('4. a lejátszó a helyreállás UTÁN jelez (két képkocka, eseménnyel)', () => {
  const restore = PLAYER.slice(PLAYER.indexOf("customEvent('iptv-player-restored')") - 900);
  assert.match(PLAYER, /window\.dispatchEvent\(new CustomEvent\('iptv-player-restored'\)\)/);
  assert.ok(restore.length > 0);
  // A jelzés a kifestett képkocka után: két egymásba ágyazott animációs kép.
  assert.match(PLAYER, /requestAnimationFrame\(\(\) => \{\s*window\.requestAnimationFrame\(\(\) => \{[\s\S]{0,400}?iptv-player-restored/,
    'a visszatérés jelzése csak a kifestés után mehet');
  // Belépéskor a lista leállítja a munkáját.
  assert.match(PLAYER, /window\.dispatchEvent\(new CustomEvent\('iptv-fullscreen-entered'\)\)/);
});

test('4. a csatornalista a teljes képernyő alatt szüneteltet, és a jelzésre indul újra', () => {
  assert.match(LIST, /const \[epgPaused, setEpgPaused\] = useState\(false\);/);
  assert.match(LIST, /window\.addEventListener\('iptv-fullscreen-entered', onEnter\)/);
  assert.match(LIST, /window\.addEventListener\('iptv-player-restored', onRestore\)/);
  assert.match(LIST, /const epgActive = isActive && !epgPaused;/);
  // Az EPG-munka mindkét effektje az epgActive kaput használja.
  const epg = LIST.slice(LIST.indexOf('const epgActive'), LIST.indexOf('const handleListKeyDown'));
  assert.ok((epg.match(/if \(!epgActive/g) || []).length >= 2, 'mindkét EPG-effekt szünetel');
  // A szüneteltetés NEM dobja el a már kiszámolt műsort (nincs üres EPG a visszatéréskor).
  assert.match(LIST, /if \(!isActive \|\| !activeProvider \|\| activeProvider\.type !== 'xtream'\) \{\s*setLocalEpg\(\{\}\);/);
  assert.match(LIST, /if \(!epgActive \|\| !epgReady\) return;/,
    'teljes képernyőn az EPG-adat megmarad, csak a munka áll meg');
});

/* ──────────────── 5. A főoldal többi része nem rajzolódik újra ─────────────── */

test('5. a teljes képernyő váltása nem ír a főoldal DOM-jára', () => {
  // A lejátszó és az OSD mountolva marad; a lista csak jelölést kap.
  assert.match(APP, /data-live-sidebar=""/);
  assert.match(APP, /data-view-hidden=\{isVideoFullscreen \|\| customStreamUrl \? '' : undefined\}/);
  // A lejátszó osztálya egyetlen attribútum-írás (nincs stílus-újraszámolás).
  assert.match(PLAYER, /className=\{`relative w-full \$\{isFullscreen \? 'iptv-fs/);
  // A webos.js TV-s szabályai továbbra is működjenek (fixed osztály marad).
  const webos = read('webos/webos.js');
  assert.match(webos, /\[data-tv-player\]\.fixed/);
});

test('5. a csatornalista nem renderelődik újra a teljes képernyő miatt', () => {
  // Az `isActive` NEM követi a teljes képernyőt (különben a memoizált lista
  // minden váltáskor újrarenderelődne, és eldobná a kiszámolt EPG-t).
  assert.doesNotMatch(APP, /isActive=\{activeView === 'live' && !customStreamUrl && !isVideoFullscreen\}/,
    'a lista isActive jelzője nem függhet a teljes képernyőtől');
  assert.match(APP, /isActive=\{activeView === 'live' && !customStreamUrl\}\s*\n\s*\/>/,
    'a lista csak a nézetre és a filmre szűr');
  // A teljes képernyős szüneteltetést a lista maga végzi (nincs prop-változás).
  assert.match(LIST, /window\.addEventListener\('iptv-fullscreen-entered', onEnter\)/);
  // A fejléc memoizált: a váltás nem rendereli újra a háttér menüsorát.
  const header = read('web/src/components/Header.tsx');
  assert.match(header, /export const Header = React\.memo\(HeaderComponent\);/);
});

/* ───────────── 6. A célzott naplózás: ritkítás és memóriakeret ───────────── */

test('6. a teljes képernyős naplózó modul ritkít és keretet tart', () => {
  assert.match(PERF, /const THROTTLE_MS = 400;/);
  assert.match(PERF, /const MAX_LINES = 80;/);
  assert.match(PERF, /if \(!isVerbosePlaybackLogging\(\)\) return;/, 'kikapcsolt naplózásnál nincs munka');
  assert.match(PERF, /suppressed \+= 1;/, 'az ismétlődés csak számlálódik');
  assert.match(PERF, /elnyomva: \$\{suppressed\}/, 'a következő sorban megjelenik az elnyomottak száma');
  assert.match(PERF, /lineCount >= MAX_LINES/, 'van kemény sorkeret');
  assert.match(PERF, /mutedUntil = now \+ MUTE_MS;/, 'a keret után a modul magától újraindul');
});

test('6. a naplózó modul VALÓDI futásban is ritkít (esbuild + stub appLog)', async () => {
  const esbuild = resolve(projectDir, 'web/node_modules/.bin/esbuild');
  if (!existsSync(esbuild)) {
    console.log('  (kihagyva: esbuild hiányzik – npm install --prefix web)');
    return;
  }
  const outDir = resolve(projectDir, 'build/tests');
  mkdirSync(outDir, { recursive: true });
  // A modul `./appLog` importját egy stub szolgálja ki (a stub a build mappába kerül).
  writeFileSync(resolve(outDir, 'fs-perf-appLog-stub.ts'), `
export const lines: string[] = [];
let enabled = false;
export function appLog(message: string): void { if (enabled) lines.push(String(message)); }
export function isVerbosePlaybackLogging(): boolean { return enabled; }
export function setEnabled(value: boolean): void { enabled = value; }
export function reset(): void { lines.length = 0; }
`);
  writeFileSync(resolve(outDir, 'fullscreenPerf.entry.ts'),
    readFileSync(resolve(projectDir, 'web/src/services/fullscreenPerf.ts'), 'utf8')
      .replace(/from '\.\/appLog'/g, "from './fs-perf-appLog-stub'")
    + `\nexport { setEnabled, reset, lines } from './fs-perf-appLog-stub';\n`);
  const outFile = resolve(outDir, 'fullscreenPerf.mjs');
  const build = spawnSync(esbuild, [
    resolve(outDir, 'fullscreenPerf.entry.ts'),
    '--bundle', '--platform=node', '--format=esm', '--target=node20', '--log-level=warning',
    `--outfile=${outFile}`,
  ], { stdio: 'inherit' });
  assert.equal(build.status, 0, 'a naplózó modul összeállítása sikerült');

  const mod = await import(pathToFileURL(outFile).href);

  // Kikapcsolt naplózás: egyetlen sor sem keletkezhet.
  mod.reset();
  mod.fsPerf('BE: teszt', 'kikapcsolt');
  assert.equal(mod.lines.length, 0, 'kikapcsolt naplózásnál nincs bejegyzés');

  // Bekapcsolt naplózás: 400 ms-on belüli ismétlődés csak számlálódik.
  mod.setEnabled(true);
  mod.reset();
  mod.resetFullscreenPerf();
  mod.fsPerf('BE: teszt', 'ismétlődő');
  mod.fsPerf('BE: teszt', 'ismétlődő');
  mod.fsPerf('BE: teszt', 'ismétlődő');
  assert.equal(mod.lines.length, 1, 'a három azonos eseményből egy sor lesz');
  mod.fsPerf('KI: teszt', 'más esemény');
  assert.equal(mod.lines.length, 2);
  assert.match(mod.lines[1], /elnyomva: 2/, 'a következő sor jelzi az elnyomott ismétléseket');
  assert.match(mod.lines[0], /^TELJES KÉPERNYŐ BE: teszt: ismétlődő/);

  // Memóriakeret: 80 sor után a modul elnémul, és egyetlen záró sort ír.
  mod.reset();
  mod.resetFullscreenPerf();
  for (let index = 0; index < 120; index += 1) {
    mod.fsPerf('BE: keret', `esemény-${index}`);
  }
  assert.ok(mod.lines.length <= 81, `a napló nem hízik korlátlanul (sorok: ${mod.lines.length})`);
  assert.match(mod.lines[mod.lines.length - 1], /naplókeret \(80 sor\) betelt/);
  // A keret betelte után a modul hallgat (nem nő tovább a napló).
  for (let index = 0; index < 20; index += 1) {
    mod.fsPerf('BE: keret', `késői-${index}`);
  }
  assert.equal(mod.lines.length, 81, 'a keret után nincs több bejegyzés');

  // Időmérés: a fsPerfTimed valódi ezredmásodperc-értéket ír.
  mod.reset();
  mod.resetFullscreenPerf();
  const started = mod.fsNow();
  mod.fsPerfTimed('BE: képkocka', started, 'teszt');
  assert.match(mod.lines[0], /BE: képkocka: teszt; \d+\.\d ms/);
  mod.setEnabled(false);
});
