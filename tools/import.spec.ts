/**
 * A szolgáltatói lista betöltésének próbája egy helyi, hamis Xtream
 * szerverrel. Nem a valódi szolgáltatót hívja, csak azt ellenőrzi, hogy a
 * program a csatornákat, filmeket és sorozatokat tényleg letölti,
 * feldolgozza, elmenti és vissza is tölti.
 *
 * Futtatás: node tools/test-import.mjs
 */

import http from 'node:http';

/* ------------------------------------------------ hamis Xtream szerver */

const LIVE_STREAMS = [
  { num: 1, name: 'M1 HD', stream_id: 101, stream_icon: 'http://logo/1.png', category_id: '10' },
  { num: 2, name: 'RTL Klub', stream_id: 102, stream_icon: '', category_id: '10' },
  { num: 3, name: 'Sport1', stream_id: 103, stream_icon: '', category_id: '11' },
  { num: 4, name: 'Movie Channel', stream_id: 104, stream_icon: '', category_id: '99' },
];

const VOD_STREAMS = [
  { name: 'Dűne', stream_id: 501, container_extension: 'mkv', category_id: '20', stream_icon: 'http://logo/dune.jpg', rating: '7.9', added: '1690000000' },
  { name: 'Avatar', stream_id: 502, container_extension: 'mp4', category_id: '20', stream_icon: '', rating: '8.1', added: '1690000000' },
];

const SERIES = [
  { name: 'A Sógun', series_id: 901, category_id: '30', cover: 'http://logo/shogun.jpg', rating: '9.1', releaseDate: '2024-02-27' },
];

function json(res: http.ServerResponse, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function startFakeServer(): Promise<{ server: http.Server; port: number }> {
  let listeningPort = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!url.pathname.endsWith('/player_api.php')) {
      res.writeHead(404).end('nope');
      return;
    }
    const action = url.searchParams.get('action');
    switch (action) {
      case null:
        json(res, {
          user_info: { username: 'teszt', auth: 1, status: 'Active', exp_date: '1893456000', max_connections: '2' },
          server_info: { url: '127.0.0.1', port: String(listeningPort) },
        });
        break;
      case 'get_live_categories':
        json(res, [
          { category_id: '10', category_name: 'Magyarország' },
          { category_id: '11', category_name: 'Sport' },
        ]);
        break;
      case 'get_live_streams':
        json(res, LIVE_STREAMS);
        break;
      case 'get_vod_categories':
        json(res, [{ category_id: '20', category_name: 'Filmek' }]);
        break;
      case 'get_vod_streams':
        json(res, VOD_STREAMS);
        break;
      case 'get_series_categories':
        json(res, [{ category_id: '30', category_name: 'Sorozatok' }]);
        break;
      case 'get_series':
        json(res, SERIES);
        break;
      case 'get_series_info':
        json(res, {
          info: { name: 'A Sógun', plot: 'Japán történelmi dráma.', genre: 'Dráma, Történelmi' },
          episodes: {
            '1': [
              { id: '9001', episode_num: 1, title: 'Rés 1', container_extension: 'mkv', info: { duration: '01:00:00' } },
              { id: '9002', episode_num: 2, title: 'Rés 2', container_extension: 'mkv', info: { duration: '00:55:00' } },
            ],
          },
        });
        break;
      default:
        json(res, []);
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      listeningPort = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port: listeningPort });
    });
  });
}

function m3uServer(): Promise<{ server: http.Server; port: number }> {
  const body = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-logo="http://logo/a.png" group-title="Magyar",M1 HD',
    'http://127.0.0.1:1/live/a.ts',
    '#EXTINF:-1 group-title="Filmek",Dűne (2021)',
    'http://127.0.0.1:1/movie/dune.mkv',
  ].join('\n');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

/* ------------------------------------------------------- környezet */

// A böngésző localStorage szimulálása (memóriában).
// A webOS alkalmazás a helyi tárba ment; a régi natív (Android) híd már
// nincs a programban, ezért a próbának is a localStorage-ot kell utánoznia.
const storageFiles = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => storageFiles.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageFiles.set(key, String(value));
    },
    removeItem: (key: string) => {
      storageFiles.delete(key);
    },
    key: (index: number) => Array.from(storageFiles.keys())[index] ?? null,
    get length() {
      return storageFiles.size;
    },
  },
};

let failures = 0;
function check(name: string, condition: boolean, extra = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

async function main() {
  const { importXtreamProvider, importM3UProvider } = await import('../web/src/services/providerImport.ts');
  const store = await import('../web/src/services/contentStore.ts');
  const { xtreamService } = await import('../web/src/services/xtreamService.ts');
  const { cancelNetworkRequests, isNetworkRequestCancelled, resetNetworkBreaker, httpGetText } = await import('../web/src/services/net.ts');

  /* --- 1. Xtream betöltés --- */
  const fake = await startFakeServer();
  const base = `http://127.0.0.1:${fake.port}`;
  const progress: number[] = [];

  const result = await importXtreamProvider(
    { name: 'Teszt szolgáltató', serverUrl: base, username: 'teszt', password: 'titok' },
    (update) => progress.push(update.percent)
  );

  const content = result.content;
  console.log('\nXtream betöltés:');
  check('4 élő csatorna letöltve', content.channels.length === 4, `(${content.channels.length})`);
  check('2 film letöltve', content.movies.length === 2, `(${content.movies.length})`);
  check('1 sorozat letöltve', content.series.length === 1, `(${content.series.length})`);
  check('élő kategóriák megvannak', content.liveCategories.length === 3, `(${content.liveCategories.length})`);
  check('film kategória megvan', content.vodCategories.length === 1);
  check('sorozat kategória megvan', content.seriesCategories.length === 1);
  check('a lejárati dátumot átvette', result.user.expireDate.startsWith('2030'), result.user.expireDate);
  check('max. kapcsolatok átvéve', result.user.maxConnections === 2);
  check('haladásjelzés 100%-ig fut', progress[progress.length - 1] === 100);

  const m1 = content.channels.find((channel) => channel.name === 'M1 HD');
  check('a csatorna stream URL-je helyes', m1?.streamUrl === `${base}/live/teszt/titok/101.ts`, m1?.streamUrl || 'nincs');
  check('a magyar csatorna zászlót kapott', m1?.flag === '🇭🇺', m1?.flag || '');
  check('a csatorna a saját kategóriájában van', m1?.categoryName === 'Magyarország', m1?.categoryName || '');
  check('a csatornaszám megmaradt', m1?.num === 1);

  const dune = content.movies.find((movie) => movie.title === 'Dűne');
  check('a film stream URL-je a kiterjesztéssel', dune?.streamUrl === `${base}/movie/teszt/titok/501.mkv`, dune?.streamUrl || '');
  check('a film kategórianeve megvan', dune?.categoryName === 'Filmek', dune?.categoryName || '');

  const shogun = content.series[0];
  check('a sorozat azonosítója megvan', shogun?.seriesId === 901, String(shogun?.seriesId));

  /* --- 2. mentés és visszatöltés --- */
  console.log('\nMentés és visszatöltés:');
  await store.saveContent(content);
  const summary = store.readSummary();
  check('a mentett összegzés a szolgáltatót tartalmazza', summary?.provider.serverUrl === base);
  check('a mentett csatornaszám helyes', summary?.totals.live === 4, JSON.stringify(summary?.totals));

  const live = store.loadLive();
  const vod = store.loadVod(content.provider);
  const ser = store.loadSeries(content.provider);
  check('4 csatorna visszatöltve', live.channels.length === 4, `(${live.channels.length})`);
  check('2 film visszatöltve', vod.movies.length === 2, `(${vod.movies.length})`);
  check('1 sorozat visszatöltve', ser.series.length === 1, `(${ser.series.length})`);
  check(
    'a visszatöltött stream URL is helyes',
    live.channels.find((channel) => channel.name === 'M1 HD')?.streamUrl === `${base}/live/teszt/titok/101.ts`
  );
  check('a kategóriák is visszatöltődtek', live.categories.length === 3, `(${live.categories.length})`);

  /*
   * Tároló-takarítás: félbe maradt (elárvult) adag nem maradhat bent, a
   * mentett, érvényes adagok viszont nem tűnhetnek el. Így a TV kis
   * kvótájából nem foglal helyet szemét, és nem veszik el a lista.
   */
  const orphanKey = 'iptv_rt_content-live-chunk-v1-0-0-0'; // soha nem íródott ki metaadat
  storageFiles.set(orphanKey, JSON.stringify({ rows: [['x']] }));
  const beforeSweep = store.loadLive().channels.length;
  const removed = store.sweepStorage();
  check('a takarítás törölte az elárvult adagot', !storageFiles.has(orphanKey), `(törölt: ${removed})`);
  check('a takarítás nem érintette az érvényes listát', beforeSweep === 4 && store.loadLive().channels.length === 4);

  store.clearContent();
  check('törlés után üres a tár', store.readSummary() === null && store.loadLive().channels.length === 0);

  /* --- 3. hibás belépés --- */
  console.log('\nHibakezelés:');
  let failed = false;
  try {
    await xtreamService.authenticate(base, 'teszt', 'titok');
    // A hamis szerver mindig sikeres választ ad, ezért itt a hibás cím a próba.
    await xtreamService.authenticate('http://127.0.0.1:1', 'teszt', 'titok');
  } catch {
    failed = true;
  }
  check('elérhetetlen szervernél hibát jelez (nincs hamis siker)', failed);

  /* --- 4. sorozat részei --- */
  const info = await xtreamService.seriesInfo(base, 'teszt', 'titok', 901);
  const episodes = Object.values(info.episodes || {}).flat();
  check('a sorozat részei letölthetők', episodes.length === 2, `(${episodes.length})`);

  /* --- 5. M3U --- */
  const m3u = await m3uServer();
  const m3uContent = await importM3UProvider({ name: 'M3U teszt', m3uUrl: `http://127.0.0.1:${m3u.port}/lista.m3u` });
  console.log('\nM3U betöltés:');
  check('1 élő csatorna az M3U-ból', m3uContent.channels.length === 1, `(${m3uContent.channels.length})`);
  check('1 film az M3U "Filmek" csoportból', m3uContent.movies.length === 1, `(${m3uContent.movies.length})`);
  check(
    'az M3U csatorna URL-je megmaradt',
    m3uContent.channels[0]?.streamUrl === 'http://127.0.0.1:1/live/a.ts',
    m3uContent.channels[0]?.streamUrl || ''
  );

  /* --- 6. hálózati munkamenet leállítása --- */
  // A #16 TV-napló után a VISSZA/új frissítés nem hagyhatott sorban álló
  // kérést, amely később, már egy új import alatt indult volna el.
  const hang = http.createServer((_req, _res) => {
    // Szándékosan nem küldünk fejlécet/választ: a fetch így aktív marad.
  });
  await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve));
  const hangAddress = hang.address();
  const hangPort = typeof hangAddress === 'object' && hangAddress ? hangAddress.port : 0;
  const pending = [1, 2, 3].map(() => httpGetText(`http://127.0.0.1:${hangPort}/hang`, { timeoutMs: 30000 }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  cancelNetworkRequests();
  const outcomes = await Promise.allSettled(pending);
  check(
    'a leállítás a futó és sorban álló kéréseket is megszakítja',
    outcomes.every((outcome) => outcome.status === 'rejected' && isNetworkRequestCancelled(outcome.reason)),
    outcomes.map((outcome) => outcome.status).join(',')
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  resetNetworkBreaker();
  hang.close();

  fake.server.close();
  m3u.server.close();

  console.log(failures === 0 ? '\nMinden próba sikeres. ✅' : `\n${failures} próba nem sikerült. ❌`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error('A próba összeomlott:', error);
  process.exit(1);
});
