#!/usr/bin/env node
/**
 * LG webOS TV – a buildelt index.html alkalmazás-scriptjének ES5-re fordítása.
 *
 * MIÉRT KELL EZ (a "TV-n semmi nem reagál" hiba valódi oka):
 *
 * 1. A Vite single-file build a teljes alkalmazást <script type="module">
 *    címkével ágyazza be. A Chrome 61-nél régebbi böngészőmotorok a module
 *    scripteket EGYÁLTALÁN NEM futtatják le – a régebbi LG TV-ken
 *    (webOS 3.x = Chrome 38, webOS 4.0 = Chrome 53) így a teljes React app
 *    el sem indult: csak az "IPTV R.T" indítókép látszott, és sem a
 *    távirányító, sem semmi más nem működött.
 *    A bundle IIFE formátumú és nem tartalmaz import.meta-t (ezt a script
 *    ellenőrzi is), ezért a type="module" eltávolítása biztonságos.
 *
 * 2. A bundle es2015 kimenetű (nyílfüggvények, class-ok) – ezt a Chrome 38
 *    (webOS 3.x) nem érti. Babel + @babel/preset-env chrome 38 célra ES5-re
 *    fordítja, elé pedig core-js + regenerator + fetch polyfill kerül.
 *
 * Használat:  node tools/transpile-es5.mjs build/web/index.html
 * (a Babel és a polyfill csomagok a web/node_modules-ból töltődnek)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
const htmlPath = path.resolve(process.argv[2] || path.join(projectDir, 'build/web/index.html'));

if (!existsSync(htmlPath)) {
  console.error(`HIBA: nem található: ${htmlPath}`);
  process.exit(1);
}

// A Babel és a polyfillek a web/ csomagból jönnek
const requireFromWeb = createRequire(path.join(projectDir, 'web', 'package.json'));
let babel, presetEnv, coreJsPath, regeneratorPath, fetchPath;
try {
  babel = requireFromWeb('@babel/core');
  presetEnv = requireFromWeb('@babel/preset-env');
  coreJsPath = requireFromWeb.resolve('core-js-bundle/minified.js');
  regeneratorPath = requireFromWeb.resolve('regenerator-runtime/runtime.js');
  fetchPath = requireFromWeb.resolve('whatwg-fetch/dist/fetch.umd.js');
} catch (e) {
  console.error('HIBA: hiányzó build függőség (futtasd: cd web && npm install):', e.message);
  process.exit(1);
}

let html = readFileSync(htmlPath, 'utf8');

if (html.includes('IPTV-ES5-APP')) {
  console.log('Már ES5-re fordítva, nincs teendő.');
  process.exit(0);
}

// A fő alkalmazás-script megkeresése: <script type="module" ...> ... </script>
const openTagRe = /<script type="module"[^>]*>/;
const openMatch = html.match(openTagRe);
if (!openMatch) {
  console.error('HIBA: nem találom a <script type="module"> alkalmazás-scriptet a buildelt HTML-ben.');
  process.exit(1);
}
const start = openMatch.index;
const codeStart = start + openMatch[0].length;
const end = html.indexOf('</script>', codeStart);
if (end < 0) {
  console.error('HIBA: nem találom a module script végét.');
  process.exit(1);
}
const code = html.slice(codeStart, end);

// Biztonsági ellenőrzések: a type="module" csak akkor hagyható el, ha a kód
// nem igazi ES modul (nincs import/export/import.meta a tetején).
if (/(^|[^.\w])import\.meta/.test(code)) {
  console.error('HIBA: a bundle import.meta-t tartalmaz – a module típus nem távolítható el. Ellenőrizd a vite configot (iife + singlefile).');
  process.exit(1);
}
if (/^\s*(import|export)[\s{"']/m.test(code.slice(0, 2000))) {
  console.error('HIBA: a bundle ES modul import/export utasítással kezdődik – nem IIFE. Ellenőrizd a vite configot.');
  process.exit(1);
}

console.log(`Alkalmazás-script: ${(code.length / 1024).toFixed(0)} KB – Babel ES5 fordítás (cél: Chrome 38 / webOS 3.x)...`);
const before = (code.match(/=>/g) || []).length;

const result = babel.transformSync(code, {
  configFile: false,
  babelrc: false,
  sourceType: 'script',
  compact: true,
  minified: true,
  comments: false,
  presets: [[presetEnv, {
    targets: { chrome: '38' },
    modules: false,
    loose: true,
    bugfixes: false,
  }]],
});

if (!result || !result.code) {
  console.error('HIBA: a Babel nem adott vissza kódot.');
  process.exit(1);
}
const es5 = result.code;
const after = (es5.match(/=>/g) || []).length;
console.log(`Nyílfüggvények: ${before} -> ${after} (a maradék szöveg-literál), méret: ${(es5.length / 1024).toFixed(0)} KB`);

// FONTOS: inline <script>-be ágyazott JS-ben a szövegliterálokban előforduló
// "</script" sorozat idő előtt lezárná a script címkét a HTML-ben (a Vite ezt
// escape-elte, de a Babel a stringeket visszaalakítja). Stringen belül a
// "<\/script" ugyanazt a szöveget jelenti, a HTML-t viszont nem töri el.
const escapeInlineScript = (js) => js
  .replace(/<\/script/gi, '<\\/script')
  // U+2028/U+2029: a régi JS-motorok stringen belül nem fogadják el nyersen
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

// A regenerator futtatókörnyezetre a Babel 'regeneratorRuntime' néven hivatkozik
const regeneratorSrc = escapeInlineScript(readFileSync(regeneratorPath, 'utf8'));
const coreJsSrc = escapeInlineScript(readFileSync(coreJsPath, 'utf8'));
const fetchSrc = escapeInlineScript(readFileSync(fetchPath, 'utf8'));
const es5Safe = escapeInlineScript(es5);

const polyfillBlock =
  '<script>/*IPTV-ES5-POLYFILLS: core-js + regenerator + fetch – régi LG webOS motorokhoz*/\n' +
  coreJsSrc + '\n;\n' + regeneratorSrc + '\n;\n' + fetchSrc + '\n</script>\n';

const appBlock =
  '<script>/*IPTV-ES5-APP chrome38 – sima script, nem module: a Chrome 61 előtti TV-motorok a module scriptet nem futtatnák le*/\n' +
  es5Safe + '\n</script>';

// FONTOS: a type="module" script halasztva futott (a DOM felépülése után),
// a sima script viszont ott fut, ahol áll. A head-ben azonnal lefutna, amikor
// a document.body még nem létezik (classList hiba) – ezért a </body> elé tesszük.
html = html.slice(0, start) + html.slice(end + '</script>'.length);
const bodyClose = html.lastIndexOf('</body>');
if (bodyClose >= 0) {
  html = html.slice(0, bodyClose) + polyfillBlock + appBlock + '\n' + html.slice(bodyClose);
} else {
  html = html + polyfillBlock + appBlock;
}

// Végső őrzés: nem maradhat module script a TV-s HTML-ben
if (/<script[^>]*type="module"/.test(html)) {
  console.error('HIBA: még mindig maradt type="module" script a HTML-ben.');
  process.exit(1);
}

writeFileSync(htmlPath, html, 'utf8');
console.log(`Kész: ${htmlPath} (${(html.length / 1024).toFixed(0)} KB) – ES5 + polyfill, module script nélkül.`);
