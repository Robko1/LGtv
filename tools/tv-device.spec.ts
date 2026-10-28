/**
 * A TV TÍPUS-ADAT PRÓBÁJA – lásd tools/test-tv-device.mjs.
 *
 * A valódi `web/src/services/tvDevice.ts` modult futtatja egy szimulált
 * webOS ablakon: a naplónak a platform által átadott modellnevet és
 * verziószámot kell tartalmaznia, hiányzó híd esetén pedig nem találhat ki
 * adatot. A második futás a localStorage-ból dolgozik (állandó adat).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function memoryStorage(): FakeStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => { map.set(key, value); },
  };
}

/** Friss modul-példány egy adott ablak-állapottal (a modul gyorsítótára miatt). */
async function loadWith(host: Record<string, unknown>, storage: FakeStorage) {
  const fakeWindow: Record<string, unknown> = {
    localStorage: storage,
    navigator: {
      userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/120.0.6099.270 Safari/537.36 WebAppManager',
    },
    ...host,
  };
  // A modul csak `window`-t használ (navigator is azon belül), ezért a Node
  // globális navigator-át nem kell felülírni.
  (globalThis as unknown as { window: unknown }).window = fakeWindow;
  const url = new URL('../../web/src/services/tvDevice.ts', import.meta.url);
  const mod = await import(/* @vite-ignore */ url.href + `?v=${Math.random()}`);
  return mod as typeof import('../web/src/services/tvDevice');
}

test('a webOS Luna-híd adatai bekerülnek a napló szövegébe', async () => {
  const storage = memoryStorage();
  const { tvDeviceInfo, tvDeviceText } = await loadWith({
    webOS: {
      applicationID: 'hu.rt.iptv.webos',
      deviceInfo: { modelName: 'OLED55C8PLA', version: '4.10.1', sdkVersion: '4.1.0', boardType: 'k2l' },
    },
  }, storage);

  const info = tvDeviceInfo();
  assert.equal(info.model, 'OLED55C8PLA');
  assert.equal(info.webOsVersion, '4.10.1');
  assert.equal(info.sdkVersion, '4.1.0');
  assert.equal(info.boardType, 'k2l');
  assert.equal(info.appId, 'hu.rt.iptv.webos');
  assert.match(info.source, /Luna/);

  const text = tvDeviceText();
  assert.match(text, /modell=OLED55C8PLA/);
  assert.match(text, /webOS=4\.10\.1/);
  assert.match(text, /appId=hu\.rt\.iptv\.webos/);
  assert.equal(text.includes('nem derül ki'), false, 'átadott adat mellett nem lehet „nem derül ki”');
});

test('a megtalált TV típus a következő indításkor is megjelenik (állandó adat)', async () => {
  const storage = memoryStorage();
  const first = await loadWith({
    webOSSystem: { deviceInfo: { modelName: '49SK8500PLA', version: '4.4.0' } },
  }, storage);
  first.tvDeviceInfo();

  // Újraindítás: a híd lassú/nincs, de a gyorsítótárból jön az adat.
  const second = await loadWith({}, storage);
  const info = second.tvDeviceInfo();
  assert.equal(info.model, '49SK8500PLA');
  assert.equal(info.webOsVersion, '4.4.0');
});

test('híd nélkül a napló nem talál ki adatot', async () => {
  const { tvDeviceInfo, tvDeviceText } = await loadWith({}, memoryStorage());
  const info = tvDeviceInfo();
  assert.equal(info.model, '');
  const text = tvDeviceText();
  assert.match(text, /modell=nem derül ki/);
  assert.match(text, /webOS=nem derül ki/);
});
