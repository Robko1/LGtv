#!/usr/bin/env node
/*
 * Füstteszt: az APK-ba kerülő, átalakított index.html valóban felépül-e?
 *
 * A HTML-t jsdom-ban futtatjuk. A jsdom nem valós böngésző, ezért a
 * böngészőben natívan létező window.matchMedia API-t külön biztosítjuk.
 * Így a teszt nem bukik el pusztán egy hiányzó DOM-böngésző API miatt,
 * miközben a React tényleges inicializálási hibáit továbbra is jelzi.
 *
 * Használat:
 *   node tools/smoke-test.mjs build/diagnose-apk-index.html
 *
 * Kilépési kód: 0 = a felület felépült, 1 = hiba (fekete képernyő lenne az APK-ban).
 */

import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.argv[2] || 'build/diagnose-apk-index.html');

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch {
  console.error('HIÁNYZIK a jsdom csomag. Telepítés:  npm install --no-save jsdom');
  process.exit(2);
}

if (!fs.existsSync(file)) {
  console.error(`HIBA: nincs ilyen fájl: ${file}`);
  process.exit(2);
}

const html = fs.readFileSync(file, 'utf8');
const captured = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => captured.push('JSDOM hiba: ' + (e && e.message)));
vc.on('error', (...args) => captured.push('console.error: ' + args.map(String).join(' ')));

const dom = new JSDOM(html, {
  url: 'file:///android_asset/index.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.addEventListener('error', (e) => {
      captured.push('JS hiba: ' + ((e.error && e.error.stack) || e.message));
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e && e.reason;
      captured.push('Promise hiba: ' + ((reason && reason.stack) || String(reason)));
    });
    window.alert = () => {};
    window.confirm = () => true;
    window.prompt = () => null;

    // jsdom nem implementálja matchMedia, de a valódi Android WebView
    // és böngészők igen. Adjuk hozzá a MediaQueryList API tesztstabil stubját.
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = (query) => {
        const listeners = new Set();
        const mediaQueryList = {
          matches: false,
          media: String(query),
          onchange: null,
          addListener(listener) {
            if (typeof listener === 'function') listeners.add(listener);
          },
          removeListener(listener) {
            listeners.delete(listener);
          },
          addEventListener(type, listener) {
            if (type === 'change' && typeof listener === 'function') listeners.add(listener);
          },
          removeEventListener(type, listener) {
            if (type === 'change') listeners.delete(listener);
          },
          dispatchEvent(event) {
            for (const listener of listeners) listener.call(mediaQueryList, event);
            if (typeof mediaQueryList.onchange === 'function') mediaQueryList.onchange.call(mediaQueryList, event);
            return true;
          },
        };
        return mediaQueryList;
      };
    }
  },
});

const deadline = Date.now() + 15000;

/*
 * Csak a felületen LÁTHATÓ szöveget adja vissza: a beágyazott <script> és
 * <style> tartalmát eltávolítja. Erre azért van szükség, mert az APK HTML-je
 * egyetlen fájl, benne a teljes JavaScript-tel – a nyers body.textContent
 * ezért a kódot is tartalmazná (hamis hibát jelezne).
 */
function visibleText(doc) {
  try {
    const clone = doc.body.cloneNode(true);
    clone.querySelectorAll('script, style, noscript').forEach((node) => node.remove());
    return clone.textContent || '';
  } catch {
    return '';
  }
}

function finish() {
  const doc = dom.window.document;
  const root = doc.getElementById('root');
  const splash = doc.getElementById('boot-splash');
  const errorBox = doc.getElementById('boot-error');
  const rendered = !!root && root.childElementCount > 0 && root.innerHTML.length > 500;
  const text = visibleText(doc);
  const errorPageHit = ['Hiba a felület betöltése közben', 'Cannot access', 'before initialization']
    .filter((marker) => text.includes(marker));
  // A React hibahatár componentDidCatch-e mindig ezt írja a konzolra.
  const boundaryErrors = captured.filter((line) => line.includes('IPTV-RT hiba'));
  const fatalErrors = captured.filter((line) =>
    /before initialization|is not a function|Cannot read|index out of|Maximum update depth/.test(line));

  console.log(`Fájl: ${path.relative(process.cwd(), file)}`);
  console.log(`#root gyerekei: ${root ? root.childElementCount : 'nincs #root'} (${root ? root.innerHTML.length : 0} karakter)`);
  console.log(`Kezdőképernyő még látható: ${splash ? 'igen' : 'nem (a felület átvette)'}`);
  if (errorBox && errorBox.textContent) console.log('Kezdőképernyő hibaszövege: ' + errorBox.textContent);

  if (errorPageHit.length || boundaryErrors.length) {
    console.log('\nHIBA: a React hibahatár képernyője jelent meg – a felület összeomlott.');
    const index = text.indexOf('Hiba a felület betöltése közben');
    if (index >= 0) console.log('Hibaszöveg a felületen: ' + text.slice(index, index + 220).replace(/\\s+/g, ' '));
    for (const line of boundaryErrors.slice(0, 3)) console.log('  - ' + line.split('\n')[0]);
    process.exit(1);
  }

  if (fatalErrors.length) {
    console.log('\nHIBA: futásidejű hiba a felület felépítése közben.');
    for (const line of fatalErrors.slice(0, 5)) console.log('  - ' + line.split('\n')[0]);
    process.exit(1);
  }

  if (rendered && !splash) {
    console.log('\nOK: a webes felület felépült, az APK nem lesz fekete képernyős.');
    process.exit(0);
  }

  console.log('\nHIBA: a webes felület nem épült fel – ez az APK-ban üres/fekete képernyő lenne.');
  if (captured.length) {
    console.log('\nElkapott hibák:');
    for (const line of captured.slice(0, 10)) console.log('  - ' + line.split('\n')[0]);
  }
  process.exit(1);
}

const timer = setInterval(() => {
  const root = dom.window.document.getElementById('root');
  const splash = dom.window.document.getElementById('boot-splash');
  const rendered = !!root && root.childElementCount > 0 && root.innerHTML.length > 500;
  const crashed = visibleText(dom.window.document).includes('Hiba a felület betöltése közben')
    || captured.some((line) => line.includes('IPTV-RT hiba'));
  if (crashed) {
    clearInterval(timer);
    finish();
  } else if (rendered && !splash) {
    clearInterval(timer);
    finish();
  } else if (Date.now() > deadline) {
    clearInterval(timer);
    finish();
  }
}, 250);
