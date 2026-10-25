// npm ci && npm ci --prefix web && node tools/test-channel-logos.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { build } = require('esbuild');
await mkdir(new URL('../build/', import.meta.url), { recursive: true });
await build({
  stdin: {
    contents: `export { default as React, act } from 'react';
      export { createRoot } from 'react-dom/client';
      export { ChannelLogo } from './src/components/ChannelLogo';
      export { normalizeLogoUrl } from './src/services/logoUrl';
      export { xtreamService } from './src/services/xtreamService';
      export { importM3UProvider, importXtreamProvider } from './src/services/providerImport';
      export { decodeChannelsForImport, saveContent, loadLive } from './src/services/contentStore';`,
    resolveDir: new URL('../web/', import.meta.url).pathname,
  },
  bundle: true, platform: 'node', format: 'esm',
  define: { 'process.env.NODE_ENV': '"development"' },
  outfile: new URL('../build/logo-test-bundle.mjs', import.meta.url).pathname,
});
const dom = new JSDOM('<div id="root"></div>', { url: 'https://app.example/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { React, act, createRoot, ChannelLogo, normalizeLogoUrl, xtreamService,
  importM3UProvider, importXtreamProvider, decodeChannelsForImport, saveContent, loadLive } = await import('../build/logo-test-bundle.mjs');
assert.equal(normalizeLogoUrl(' "//cdn.example/logo.png" ', 'http://provider.example:8080/'), 'http://cdn.example/logo.png');
assert.equal(normalizeLogoUrl('/icons/a.png', 'http://provider.example:8080/'), 'http://provider.example:8080/icons/a.png');
assert.equal(normalizeLogoUrl('javascript:alert(1)'), '');
assert.equal(normalizeLogoUrl(null), '');
// A javított hiba: az Xtream bejelentkezés séma nélküli szervert is elfogad
// (a playerApiBase() teszi elé a http:// előtagot), ezért a logóbázisnál is.
// Érvénytelen báziscím NE vesse el az érvényes ABSZOLÚT logócímet:
assert.equal(normalizeLogoUrl('https://cdn.example/a.png', '127.0.0.1:8080/'), 'https://cdn.example/a.png');
assert.equal(normalizeLogoUrl('https://cdn.example/a.png', 'provider.example'), 'https://cdn.example/a.png');
// Séma nélküli domain és IP:port bázis: HTTP az alapértelmezés (mint a bejelentkezésnél).
assert.equal(normalizeLogoUrl('/icons/a.png', 'provider.example'), 'http://provider.example/icons/a.png');
assert.equal(normalizeLogoUrl('icons/a.png', '127.0.0.1:8080'), 'http://127.0.0.1:8080/icons/a.png');
assert.equal(normalizeLogoUrl('//cdn.example/a.png', '127.0.0.1:8080'), 'http://cdn.example/a.png');
// player_api.php végződésű szervercímből a kiszolgáló gyökere legyen az alap.
assert.equal(
  normalizeLogoUrl('/icons/a.png', xtreamService.playerApiBase('provider.example:8080', '', '')),
  'http://provider.example:8080/icons/a.png'
);
assert.equal(
  normalizeLogoUrl('icons/b.png', 'http://provider.example:8080/player_api.php?username=u&password=p'),
  'http://provider.example:8080/icons/b.png'
);
// Az APK file:// dokumentumcíme nem lehet bázis; a tiltott sémák továbbra is elutasítva.
assert.equal(normalizeLogoUrl('icons/a.png', 'file:///android_asset/index.html'), '');
assert.equal(normalizeLogoUrl('//cdn.example/a.png', 'file:///android_asset/index.html'), 'https://cdn.example/a.png');
assert.equal(normalizeLogoUrl('file:///sdcard/a.png', 'http://provider.example:8080/'), '');
const playlist = (logo) => `#EXTM3U\n#EXTINF:-1 tvg-logo=${logo} group-title="TV",Test\nhttp://stream.example/live/1.ts`;
for (const ext of ['m3u', 'm3u8']) {
  for (const logo of ['"../icons/a.png"', "'../icons/a.png'", '../icons/a.png']) {
    const parsed = await xtreamService.parseM3U(playlist(logo), undefined, `https://provider.example/lists/live.${ext}`);
    assert.equal(parsed.channels[0].logo, 'https://provider.example/icons/a.png');
  }
}
const fileParsed = await xtreamService.parseM3U(playlist('"/icons/a.png"'));
assert.equal(fileParsed.channels[0].logo, 'http://stream.example/icons/a.png');
const xtream = decodeChannelsForImport([[1, 'Test', '/icons/a.png', 'tv', 'TV', 23]],
  { id: 'x', type: 'xtream', serverUrl: 'http://provider.example:8080', username: 'u', password: 'p' });
assert.equal(xtream[0].logo, 'http://provider.example:8080/icons/a.png');
// Visszaolvasás séma nélküli és player_api.php végű mentett szervercímmel is.
const xtreamSchemaLess = decodeChannelsForImport([[1, 'Test', '/icons/a.png', 'tv', 'TV', 23]],
  { id: 'x', type: 'xtream', serverUrl: '127.0.0.1:8080', username: 'u', password: 'p' });
assert.equal(xtreamSchemaLess[0].logo, 'http://127.0.0.1:8080/icons/a.png');
const xtreamApiBase = decodeChannelsForImport([[1, 'Test', '/icons/a.png', 'tv', 'TV', 23]],
  { id: 'x', type: 'xtream', serverUrl: 'http://provider.example:8080/player_api.php?username=u&password=p', username: 'u', password: 'p' });
assert.equal(xtreamApiBase[0].logo, 'http://provider.example:8080/icons/a.png');
// Teljes Xtream import, mentés és visszatöltés hamis szerverrel, SÉMA NÉLKÜLI
// szervercímmel (a bejelentkezéshez hasonlóan http:// előtag nélkül megadva).
const fakeXtream = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const send = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!url.pathname.endsWith('/player_api.php')) { res.writeHead(404).end('nope'); return; }
  const action = url.searchParams.get('action');
  if (action === null) {
    send({
      user_info: { username: 'teszt', auth: 1, status: 'Active', exp_date: '1893456000', max_connections: '2' },
      server_info: { url: '127.0.0.1', port: String(fakeXtream.address().port) },
    });
  } else if (action === 'get_live_categories') {
    send([{ category_id: '10', category_name: 'Magyarország' }]);
  } else if (action === 'get_live_streams') {
    send([
      { num: 1, name: 'Abszolút HD', stream_id: 101, stream_icon: 'https://cdn.example/abs.png', category_id: '10' },
      { num: 2, name: 'Relatív HD', stream_id: 102, stream_icon: '/icons/rel.png', category_id: '10' },
      { num: 3, name: 'Protokoll HD', stream_id: 103, stream_icon: '//cdn.example/proto.png', category_id: '10' },
    ]);
  } else {
    send([]);
  }
});
await new Promise((resolve) => fakeXtream.listen(0, '127.0.0.1', resolve));
const fakePort = fakeXtream.address().port;
const imported = await importXtreamProvider(
  { name: 'Teszt szolgáltató', serverUrl: `127.0.0.1:${fakePort}`, username: 'teszt', password: 'titok' }
);
const byName = (name) => imported.content.channels.find((channel) => channel.name === name);
// Abszolút logócím séma nélküli szervercímnél is megmarad (a hiba itt üresre cserélte).
assert.equal(byName('Abszolút HD')?.logo, 'https://cdn.example/abs.png', byName('Abszolút HD')?.logo);
// Relatív logócím a szerverhez oldódik fel, HTTP alapértelmezéssel.
assert.equal(byName('Relatív HD')?.logo, `http://127.0.0.1:${fakePort}/icons/rel.png`, byName('Relatív HD')?.logo);
// A // kezdetű logócím a szerver protokollját (http) veszi át.
assert.equal(byName('Protokoll HD')?.logo, 'http://cdn.example/proto.png', byName('Protokoll HD')?.logo);
// Mentés és visszatöltés: a mentett (séma nélküli) szervercímből is helyes logóbázis készül.
await saveContent(imported.content);
const reloaded = loadLive();
assert.equal(reloaded.provider.serverUrl, `127.0.0.1:${fakePort}`);
const reloadedByName = (name) => reloaded.channels.find((channel) => channel.name === name);
assert.equal(reloadedByName('Abszolút HD')?.logo, 'https://cdn.example/abs.png', reloadedByName('Abszolút HD')?.logo);
assert.equal(reloadedByName('Relatív HD')?.logo, `http://127.0.0.1:${fakePort}/icons/rel.png`, reloadedByName('Relatív HD')?.logo);
assert.equal(reloadedByName('Protokoll HD')?.logo, 'http://cdn.example/proto.png', reloadedByName('Protokoll HD')?.logo);
fakeXtream.close();
// Import, mentés, visszatöltés, frissítés és szolgáltatóváltás (M3U).
for (const [providerId, host, logo] of [['a', 'one.example', 'a'], ['a', 'one.example', 'updated'], ['b', 'two.example', 'b']]) {
  const content = await importM3UProvider({ name: 'Test', providerId,
    m3uUrl: `https://${host}/list.m3u8`, m3uText: playlist(`"/icons/${logo}.png"`) });
  await saveContent(content);
  assert.equal(loadLive().channels[0].logo, `https://${host}/icons/${logo}.png`);
}
const root = createRoot(document.getElementById('root'));
const render = async (url, retryKey) => act(async () => root.render(React.createElement(ChannelLogo, { url, name: 'Test', retryKey })));
const error = async () => act(async () => document.querySelector('img').dispatchEvent(new window.Event('error')));
await render('http://one.example/a.png');
await error();
assert.equal(document.querySelector('img').src, 'https://one.example/a.png');
await error();
assert.equal(document.querySelector('img').src, 'http://one.example/a.png', 'HTTP URL is restored if HTTPS fails');
await error();
// A beépített alkalmazásikon a tartalék (nem „nincs kép”): mindkét séma
// hibája után ennek kell megjelennie, és csak ezután jöhet a gyorsítótár.
assert.match(document.querySelector('img')?.getAttribute('aria-label') || '', /nem érhető el/,
  'Only show the fallback icon after both URL schemes fail');
await render('https://two.example/b.png');
assert.equal(document.querySelector('img').src, 'https://two.example/b.png');
await error();
await render('https://two.example/b.png', {});
assert.ok(document.querySelector('img'), 'Refresh retries failed logo');
await error();
await act(async () => window.dispatchEvent(new window.Event('online')));
assert.ok(document.querySelector('img'), 'Reconnect retries failed logo');
// Későn érkező cache-találat a közvetlen URL hibája UTÁN is látható legyen.
let resolveCache;
window.caches = { open: () => new Promise((resolve) => { resolveCache = resolve; }) };
const revoked = [];
URL.createObjectURL = () => 'blob:cached-logo';
URL.revokeObjectURL = (url) => revoked.push(url);
await render('https://cached.example/a.png');
await error();
assert.match(document.querySelector('img')?.getAttribute('aria-label') || '', /nem érhető el/);
await act(async () => resolveCache({ match: async () => new Response(new Blob(['image'], { type: 'image/png' })) }));
assert.equal(document.querySelector('img').src, 'blob:cached-logo');
await act(async () => root.unmount());
assert.ok(revoked.includes('blob:cached-logo'));
console.log('PASS: logócímek, séma nélküli szervercím (domain és IP:port), player_api.php bázis, M3U/M3U8, teljes Xtream import + mentés/visszatöltés, frissítés, szolgáltatóváltás, hibakezelés, cache.');
dom.window.close();
fakeXtream.closeAllConnections();
// A bundlizott React/jsdom ütemező nyitott handle-jei nem részei a tesztnek.
process.exit(0);
