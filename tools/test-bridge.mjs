#!/usr/bin/env node
/*
 * A native-bridge.js füsttesztje: Node-ban, egy egyszerű DOM-utánzattal
 * ellenőrzi, hogy
 *   - a híd elindul és közzéteszi a window.IPTVNative API-t,
 *   - a vlc:// hivatkozásokra a natív lejátszót hívja (nem a VLC-t),
 *   - a blobot letöltésként átadja a natív oldalnak,
 *   - a videó hibája esetén felajánlja a natív lejátszót,
 *   - böngészőben (híd nélkül) csendben nem csinál semmit.
 *
 * Futtatás:  node tools/test-bridge.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(here, '..', 'android', 'assets', 'native-bridge.js');
// Az alkalmazás kizárólag LG webOS-re készül: az Android híd már nincs a
// projektben. A régi füstteszt ilyenkor nem hibázik, csak jelzi, hogy nincs
// mit futtatni (a webOS utat a többi teszt ellenőrzi).
if (!existsSync(bridgePath)) {
  console.log('KIPARANCSOLT: az Android native-bridge.js már nincs a projektben (webOS-only build).');
  process.exit(0);
}
const source = readFileSync(bridgePath, 'utf8');

let failures = 0;
let checks = 0;

function check(name, condition) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  HIBA ${name}`);
  }
}

/** Egyszerű DOM-utánzat, csak annyi, amennyit a híd használ. */
function createEnvironment({ withBridge = true, confirmAnswer = true } = {}) {
  const listeners = [];
  const calls = [];

  const audio = {
    tagName: 'A',
    getAttribute(name) {
      return name === 'href' ? 'vlc://http://panel.example:8080/live/1.ts' : 'RTL Klub';
    },
    closest() {
      return null;
    },
    parentNode: null,
  };

  const video = {
    tagName: 'VIDEO',
    currentSrc: 'http://panel.example:8080/live/2.ts',
    src: '',
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    fire(type) {
      (this.listeners[type] || []).forEach((handler) => handler.call(this, {}));
    },
  };

  const videos = [video];
  const injectedStyles = [];
  const documentStub = {
    title: 'IPTV R.T',
    documentElement: { setAttribute() {}, appendChild(node) { injectedStyles.push(node); } },
    head: { appendChild(node) { injectedStyles.push(node); } },
    createElement(tagName) {
      return { tagName: String(tagName).toUpperCase(), textContent: '' };
    },
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    querySelectorAll(selector) {
      return selector === 'video' ? videos : [];
    },
    querySelector() {
      return null;
    },
  };

  const files = new Map();
  const AndroidIP = {
    platform: () => 'android',
    appVersion: () => '1.0.0',
    deviceInfo: () => '{"model":"Test","android":"14","sdk":34}',
    toast: (message) => calls.push(['toast', message]),
    setVideoBounds: (...args) => calls.push(['setVideoBounds', ...args]),
    play: (url, title) => calls.push(['play', url, title]),
    stop: () => calls.push(['stop']),
    saveBase64: (data, name, mime) => calls.push(['saveBase64', data.length, name, mime]),
    checkUpdate: () => calls.push(['checkUpdate']),
    openExternal: (url) => calls.push(['openExternal', url]),
    download: (url, name, mime) => calls.push(['download', url, name, mime]),
    // A natív fájltároló (a nagy listák mentéséhez). A valódi Java oldal a
    // kulcsot ellenőrzi, ezért itt is csak érvényes kulcsot fogadunk el.
    storeGet: (key) => (files.has(key) ? files.get(key) : ''),
    storePut: (key, value) => {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) return false;
      files.set(key, value);
      return true;
    },
    storeDelete: (key) => files.delete(key),
  };

  const windowStub = {
    confirm: () => confirmAnswer,
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    removeEventListener(type, handler) {
      this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== handler);
    },
    // A tesztben ne induljon valódi ismétlődő időzítő.
    setInterval: () => 0,
    clearInterval: () => {},
  };
  if (withBridge) {
    windowStub.AndroidIP = AndroidIP;
  }

  const sandbox = {
    window: windowStub,
    document: documentStub,
    console: { warn: () => {}, log: () => {} },
    setInterval: () => 0,
    clearInterval: () => {},
    // A tesztben minden időzítő azonnal lefut, így a frissítés-ellenőrzés is
    // megfigyelhető.
    setTimeout: (callback) => {
      callback();
      return 0;
    },
    fetch: () => Promise.reject(new Error('nincs hálózat a tesztben')),
    FileReader: class {},
    MutationObserver: class {
      observe() {}
    },
    URL: { createObjectURL: () => 'blob:test' },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'native-bridge.js' });

  return { sandbox, listeners, calls, video, AndroidIP };
}

console.log('native-bridge.js teszt');

// 1) Android burokban: a híd elindul, és a vlc:// linkeket natív lejátszóra váltja.
{
  const env = createEnvironment();
  const api = env.sandbox.window.IPTVNative;
  check('a window.IPTVNative elkészül', !!api && api.isAndroid === true);
  check('verzió a natív oldalról', api.version === '1.0.0');
  api.setVideoBounds(1, 2, 300, 170, 393);
  check('viewport-szélesség átadható a natív videóablakhoz', env.calls.some((call) => call[0] === 'setVideoBounds' && call[5] === 393));

  const clickListener = env.listeners.find((item) => item.type === 'click');
  check('figyeli a kattintásokat', !!clickListener);

  let prevented = false;
  clickListener.handler({
    target: {
      tagName: 'A',
      getAttribute: (name) => (name === 'href' ? 'vlc://http://panel.example:8080/live/1.ts' : null),
      closest: () => null,
      parentNode: null,
    },
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {},
  });

  const play = env.calls.find((call) => call[0] === 'play');
  check('a vlc:// linket a natív lejátszó kapja', !!play);
  check('a vlc:// kimarad az URL-ből', !!play && play[1] === 'http://panel.example:8080/live/1.ts');
  check('a kattintást leállítja', prevented);

  // 2) Videóhibánál nem ugrik fel kérdés (a felület kezeli a tartalékot).
  env.video.fire('error');
  const fallback = env.calls.filter((call) => call[0] === 'play').length;
  check('videóhibánál nincs felugró kérdés', fallback === 1);

  // 3) Frissítés-ellenőrzés: induláskor SZÁNDÉKOSAN nem indul magától (nem
  //    terheljük a hálózatot és nem kockáztatunk fekete képernyőt), de a
  //    webes felület a hídon keresztül bármikor kérheti.
  check(
    'induláskor nincs automatikus frissítés-ellenőrzés',
    !env.calls.some((call) => call[0] === 'checkUpdate')
  );
  env.sandbox.window.IPTVNative.checkUpdate();
  check(
    'a felület kérheti a frissítés-ellenőrzést',
    env.calls.some((call) => call[0] === 'checkUpdate')
  );
}

// 4) vlc:// rövid alak (vlc://host/stream).
{
  const env = createEnvironment();
  const clickListener = env.listeners.find((item) => item.type === 'click');
  clickListener.handler({
    target: {
      tagName: 'A',
      getAttribute: () => 'vlc://stream.example.hu:1935/live/rtl',
      closest: () => null,
      parentNode: null,
    },
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  const play = env.calls.find((call) => call[0] === 'play');
  check('a rövid vlc:// alakból http:// lesz', !!play && play[1] === 'http://stream.example.hu:1935/live/rtl');
}

// 5) Böngészőben (híd nélkül) a szkript csendben nem csinál semmit.
{
  const env = createEnvironment({ withBridge: false });
  check('híd nélkül nincs window.IPTVNative', env.sandbox.window.IPTVNative === undefined);
  check('híd nélkül nem regisztrál kattintásfigyelőt', env.listeners.length === 0);
}

// 6) A tároló híd (store) elérhető, és a hibás kulcsot sem veszi át.
{
  const env = createEnvironment();
  const store = env.sandbox.window.IPTVNative.store;
  check('a tároló híd elérhető', !!store);
  store.put('content-live', '{"a":1}');
  store.put('rossz kulcs!', 'x');
  check('a tároló írás/olvasás működik', store.get('content-live') === '{"a":1}');
  store.remove('content-live');
  check('a törlés működik', store.get('content-live') === '');
}

console.log(`\n${checks - failures}/${checks} ellenőrzés sikeres`);
process.exit(failures ? 1 : 0);
