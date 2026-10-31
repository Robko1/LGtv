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

let vodInfoRequests = 0;

function json(res: http.ServerResponse, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * Mely `category_id`-kra érkezett élő-lista kérés. Ebből látszik, hogy az
 * import induláskor valóban csak a magyar kategóriákat kérte-e le.
 */
const liveCategoryRequests: string[] = [];

/** Mely végpontokat kérte le a program (a növekményes frissítés próbájához). */
const requestedActions: string[] = [];

function startFakeServer(options: {
  failVodCategories?: boolean;
  /** Ha igaz, a get_live_streams tiszteletben tartja a category_id-t. */
  categoryAwareLive?: boolean;
  /** Felülírja az élő kategóriák nevét (pl. magyar nélküli panel próbájához). */
  liveCategoryNames?: Array<{ category_id: string; category_name: string }>;
  failSeriesCategories?: boolean;
  failVodBulk?: boolean;
  failSeriesBulk?: boolean;
  failAuth?: boolean;
  /** A TELJES élő lista válaszának késleltetése (a lassú panel utánozása). */
  liveDelayMs?: number;
  /** Ennyi filmet adjon a bulk végpont (a nagy katalógus próbájához). */
  vodCount?: number;
} = {}): Promise<{
  server: http.Server;
  port: number;
  /** A kategórianevek menet közbeni átírása (változásvizsgálat próbájához). */
  setLiveCategoryNames: (names: Array<{ category_id: string; category_name: string }>) => void;
}> {
  let listeningPort = 0;
  /** A frissítés-próba menet közben átírhatja (a szolgáltató változását utánozza). */
  let dynamicLiveCategoryNames: Array<{ category_id: string; category_name: string }> | null = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!url.pathname.endsWith('/player_api.php')) {
      res.writeHead(404).end('nope');
      return;
    }
    const action = url.searchParams.get('action');
    requestedActions.push(String(action));
    switch (action) {
      case null:
        if (options.failAuth) {
          json(res, { user_info: { username: 'teszt', auth: 0, status: 'Disabled' } });
          break;
        }
        json(res, {
          user_info: { username: 'teszt', auth: 1, status: 'Active', exp_date: '1893456000', max_connections: '2' },
          server_info: { url: '127.0.0.1', port: String(listeningPort) },
        });
        break;
      case 'get_live_categories':
        /*
         * ORSZÁG-SZERVEZÉSŰ PANEL: legalább 5 különböző országnak kell lennie,
         * különben a betöltő jogosan ítéli úgy, hogy a kategórianevek nem
         * országok, és a teljes listát tölti le (lásd MIN_COUNTRIES_FOR_FILTER).
         */
        json(res, dynamicLiveCategoryNames ?? options.liveCategoryNames ?? [
          { category_id: '10', category_name: 'Magyarország' },
          { category_id: '11', category_name: 'Németország' },
          { category_id: '12', category_name: 'Angol' },
          { category_id: '13', category_name: 'Francia' },
          { category_id: '14', category_name: 'Olasz' },
          { category_id: '15', category_name: 'Spanyol' },
        ]);
        break;
      case 'get_live_streams': {
        const wantedLive = url.searchParams.get('category_id');
        if (wantedLive !== null) liveCategoryRequests.push(wantedLive);
        const livePayload = options.categoryAwareLive && wantedLive !== null
          ? LIVE_STREAMS.filter((stream) => String(stream.category_id) === wantedLive)
          : LIVE_STREAMS;
        if (options.liveDelayMs && wantedLive === null) {
          setTimeout(() => json(res, livePayload), options.liveDelayMs);
          break;
        }
        json(res, livePayload);
        break;
      }
      case 'get_vod_categories':
        if (options.failVodCategories) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('vod categories disabled');
          break;
        }
        json(res, [{ category_id: '20', category_name: 'Filmek' }]);
        break;
      case 'get_vod_streams':
        if (options.failVodBulk && !url.searchParams.has('category_id')) {
          json(res, { error: 'bulk VOD végpont tiltva' });
          break;
        }
        json(res, options.vodCount
          ? Array.from({ length: options.vodCount }, (_, i) => ({
              name: `Nagy film ${i + 1}`,
              stream_id: 700000 + i,
              container_extension: 'mkv',
              category_id: '20',
              stream_icon: '',
              rating: '7.0',
              added: '1690000000',
            }))
          : VOD_STREAMS);
        break;
      case 'get_vod_info':
        vodInfoRequests++;
        json(res, {
          info: {
            movie_image: `http://logo/detail-${url.searchParams.get('vod_id')}.jpg`,
            backdrop_path: `http://logo/backdrop-${url.searchParams.get('vod_id')}.jpg`,
            duration_secs: 7200,
            plot: 'Részletes szolgáltatói leírás.',
            genre: 'Sci-Fi, Dráma',
            audio: [{ language: 'hu', codec: 'AAC' }, { language: 'en', codec: 'EAC3' }],
            subtitles: [{ sub_id: 11, language: 'hu', title: 'Magyar' }, { sub_id: 12, language: 'en', title: 'English' }],
          },
          movie_data: { stream_id: Number(url.searchParams.get('vod_id')) },
        });
        break;
      case 'get_series_categories':
        if (options.failSeriesCategories) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('series categories disabled');
          break;
        }
        json(res, [{ category_id: '30', category_name: 'Sorozatok' }]);
        break;
      case 'get_series':
        if (options.failSeriesBulk && !url.searchParams.has('category_id')) {
          json(res, { error: 'bulk sorozat végpont tiltva' });
          break;
        }
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
      resolve({
        server,
        port: listeningPort,
        setLiveCategoryNames: (names) => {
          dynamicLiveCategoryNames = names;
        },
      });
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
  const {
    importXtreamProvider,
    importM3UProvider,
    refreshProviderContent,
    catalogFingerprint,
    diffCatalogs,
    describeCatalogSummary,
    FULL_CHECK_WINDOW_MS,
  } = await import('../web/src/services/providerImport.ts');
  const store = await import('../web/src/services/contentStore.ts');
  const { xtreamService } = await import('../web/src/services/xtreamService.ts');
  const { cancelNetworkRequests, isNetworkRequestCancelled, resetNetworkBreaker, httpGetText } = await import('../web/src/services/net.ts');

  /* --- 1. Xtream betöltés --- */
  const fake = await startFakeServer();
  const base = `http://127.0.0.1:${fake.port}`;
  const progress: number[] = [];

  /*
   * A részleges tartalom MALOMKŐ-KÖVE a felület csatornaválasztásának: amíg az
   * élő lista hiányos (első 1500 csatorna), a program nem dönthet a nézett
   * csatornáról, különben a betöltés végén másik adóra váltana – vagy egy
   * külföldi csatornát indítana el. Ezért az élő szakasz végét külön jelöljük.
   */
  const partials: Array<Record<string, unknown>> = [];
  const result = await importXtreamProvider(
    { name: 'Teszt szolgáltató', serverUrl: `${base}/player_api.php?username=régi&password=régi`, username: 'teszt', password: 'titok' },
    (update) => progress.push(update.percent),
    (partial) => { partials.push(partial as unknown as Record<string, unknown>); }
  );

  const content = result.content;
  console.log('\nXtream betöltés:');
  check('4 élő csatorna letöltve', content.channels.length === 4, `(${content.channels.length})`);
  check('2 film letöltve', content.movies.length === 2, `(${content.movies.length})`);
  check('1 sorozat letöltve', content.series.length === 1, `(${content.series.length})`);
  // 6 ország-kategória + az „Egyéb” gyűjtő (a 99-es kategóriájú csatornának
  // nincs párja a kategórialistában).
  check('élő kategóriák megvannak', content.liveCategories.length === 7, `(${content.liveCategories.length})`);
  check('film kategória megvan', content.vodCategories.length === 1);
  check('sorozat kategória megvan', content.seriesCategories.length === 1);
  check('a lejárati dátumot átvette', result.user.expireDate.startsWith('2030'), result.user.expireDate);
  check('max. kapcsolatok átvéve', result.user.maxConnections === 2);
  check('haladásjelzés 100%-ig fut', progress[progress.length - 1] === 100);
  const livePartials = partials.filter((partial) => Array.isArray(partial.channels));
  const completeLive = livePartials.filter((partial) => partial.liveComplete === true);
  check(
    'az élő lista elkészültét pontosan egy részleges tartalom jelzi',
    completeLive.length === 1,
    `(${completeLive.length})`
  );
  check(
    'a jelölt részleges tartalom a TELJES élő listát tartalmazza',
    Array.isArray(completeLive[0]?.channels) && (completeLive[0]!.channels as unknown[]).length === 4,
    `(${(completeLive[0]?.channels as unknown[] | undefined)?.length})`
  );
  check(
    'a hiányos előnézet NEM jelölődik késznek',
    livePartials.filter((partial) => partial.liveComplete !== true)
      .every((partial) => (partial.channels as unknown[]).length < 4),
    `(${livePartials.filter((partial) => partial.liveComplete !== true).length} előnézet)`
  );
  check('a mentett provider-cím csak a root, credential nélkül', content.provider.serverUrl === base && !content.provider.serverUrl?.includes('player_api.php'));

  const m1 = content.channels.find((channel) => channel.name === 'M1 HD');
  check('a csatorna stream URL-je helyes', m1?.streamUrl === `${base}/live/teszt/titok/101.ts`, m1?.streamUrl || 'nincs');
  check('a magyar csatorna zászlót kapott', m1?.flag === '🇭🇺', m1?.flag || '');
  check('a csatorna a saját kategóriájában van', m1?.categoryName === 'Magyarország', m1?.categoryName || '');
  check('a csatornaszám megmaradt', m1?.num === 1);
  check(
    'a teljes player_api.php bemenetből is helyes élő URL készül',
    xtreamService.buildLiveStreamUrl(`${base}/player_api.php?username=régi&password=régi`, 'teszt', 'titok', 101, 'm3u8')
      === `${base}/live/teszt/titok/101.m3u8`
  );
  check(
    'a speciális credential karakterek URL-szegmensben kódolódnak',
    xtreamService.buildLiveStreamUrl(base, 'u/s', 'p a', 101) === `${base}/live/u%2Fs/p%20a/101.ts`
  );

  const dune = content.movies.find((movie) => movie.title === 'Dűne');
  check('a film stream URL-je a kiterjesztéssel', dune?.streamUrl === `${base}/movie/teszt/titok/501.mkv`, dune?.streamUrl || '');
  check('a film kategórianeve megvan', dune?.categoryName === 'Filmek', dune?.categoryName || '');
  check('a részletes VOD-kérés csak a betöltött első filmekre fut', vodInfoRequests === 2, `(${vodInfoRequests})`);
  check('a film részletes játékideje megérkezett', dune?.durationMinutes === 120, String(dune?.durationMinutes));
  check('a film valódi posztere megérkezett', dune?.poster === 'http://logo/detail-501.jpg', dune?.poster || '');
  check('a hangsávnyelvek normalizálódtak', JSON.stringify(dune?.audioLanguages) === JSON.stringify(['Magyar', 'Angol']), JSON.stringify(dune?.audioLanguages));
  check('a feliratnyelvek normalizálódtak', JSON.stringify(dune?.subtitleLanguages) === JSON.stringify(['Magyar', 'Angol']), JSON.stringify(dune?.subtitleLanguages));

  /* --- 1b. VOD-végpont regressziók: a kategória-/bulk-hiba nem törli a live-ot --- */
  const categoryFallbackFake = await startFakeServer({ failVodCategories: true, failSeriesCategories: true });
  const categoryFallback = await importXtreamProvider(
    { name: 'Kategória fallback', serverUrl: `http://127.0.0.1:${categoryFallbackFake.port}`, username: 'teszt', password: 'titok' }
  );
  check('kategóriahiba mellett az élő csatornák megmaradnak', categoryFallback.content.channels.length === 4, `(${categoryFallback.content.channels.length})`);
  check('kategóriahiba mellett a bulk filmek betöltődnek', categoryFallback.content.movies.length === 2, `(${categoryFallback.content.movies.length})`);
  check('kategóriahiba mellett a bulk sorozatok betöltődnek', categoryFallback.content.series.length === 1, `(${categoryFallback.content.series.length})`);
  check('a kategóriahiba bekerül az import figyelmeztetésébe', categoryFallback.content.warnings.some((warning) => /kategórialistája/i.test(warning)));
  categoryFallbackFake.server.close();

  const bulkFallbackFake = await startFakeServer({ failVodBulk: true, failSeriesBulk: true });
  const bulkFallback = await importXtreamProvider(
    { name: 'Bulk fallback', serverUrl: `http://127.0.0.1:${bulkFallbackFake.port}`, username: 'teszt', password: 'titok' }
  );
  check('bulk-hiba mellett a kategória-fallback filmeket ad', bulkFallback.content.movies.length === 2, `(${bulkFallback.content.movies.length})`);
  check('bulk-hiba mellett a kategória-fallback sorozatot ad', bulkFallback.content.series.length === 1, `(${bulkFallback.content.series.length})`);
  /*
   * A bulk-hiba utáni kategóriánkénti letöltés TARTALÉK-ÚT: ha sikerül, a
   * tartalom teljes – ezért megjegyzés, nem figyelmeztetés. A felület ilyenkor
   * nem mutat „részleges” állapotot egy sikeres betöltésre.
   */
  check(
    'a bulk-hiba megjegyzésként (nem figyelmeztetésként) jelenik meg',
    (bulkFallback.content.notes ?? []).some((note) => /kategóriánként/i.test(note))
      && !(bulkFallback.content.warnings ?? []).some((warning) => /bulk-letöltése/i.test(warning)),
    JSON.stringify({ notes: bulkFallback.content.notes, warnings: bulkFallback.content.warnings })
  );
  bulkFallbackFake.server.close();

  const authFailureFake = await startFakeServer({ failAuth: true });
  const authFailure = await importXtreamProvider(
    { name: 'Auth probe fallback', serverUrl: `http://127.0.0.1:${authFailureFake.port}`, username: 'teszt', password: 'titok' }
  );
  check('opcionális auth-probe hiba nem törli az élő listát', authFailure.content.channels.length === 4, `(${authFailure.content.channels.length})`);
  authFailureFake.server.close();

  const shogun = content.series[0];
  check('a sorozat azonosítója megvan', shogun?.seriesId === 901, String(shogun?.seriesId));
  check('a sorozat részletes játékideje megérkezett', shogun?.durationMinutes === 60, String(shogun?.durationMinutes));
  check('hiányzó sorozat-hangsávnál Ismeretlen látszik', JSON.stringify(shogun?.audioLanguages) === JSON.stringify(['Ismeretlen']), JSON.stringify(shogun?.audioLanguages));
  check('hiányzó sorozat-feliratnál Ismeretlen látszik', JSON.stringify(shogun?.subtitleLanguages) === JSON.stringify(['Ismeretlen']), JSON.stringify(shogun?.subtitleLanguages));

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
  check('a játékidő tartósan megmaradt', vod.movies.find((movie) => movie.title === 'Dűne')?.durationMinutes === 120);
  check('a hangsávnyelv tartósan megmaradt', JSON.stringify(vod.movies.find((movie) => movie.title === 'Dűne')?.audioLanguages) === JSON.stringify(['Magyar', 'Angol']));
  check('a feliratnyelv tartósan megmaradt', JSON.stringify(vod.movies.find((movie) => movie.title === 'Dűne')?.subtitleLanguages) === JSON.stringify(['Magyar', 'Angol']));
  check('a sorozat metaadata tartósan megmaradt', ser.series[0]?.durationMinutes === 60 && JSON.stringify(ser.series[0]?.audioLanguages) === JSON.stringify(['Ismeretlen']));
  check(
    'a visszatöltött stream URL is helyes',
    live.channels.find((channel) => channel.name === 'M1 HD')?.streamUrl === `${base}/live/teszt/titok/101.ts`
  );
  check('a kategóriák is visszatöltődtek', live.categories.length === 7, `(${live.categories.length})`);

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
  /* --- Az 1-es napló esete: a teljes lista 9 mp-nél tovább készül --- */
  {
    /*
     * A TV-n (2.5.115) ez volt:
     *   [élő kategóriák], OK, 375 ms, korlát=9000 ms
     *   [élő csatornalista], HIBA, 9026 ms, korlát=9000 ms, ok=időtúllépés
     *
     * A teljes lista 20 190 csatornánál ~12 mp, tehát a 9 mp-es korlát miatt
     * SOHA nem jöhetett le. Itt egy 10 mp-ig készülő (de élő) panelt
     * utánozunk: a betöltésnek végig kell futnia, csatornavesztés nélkül.
     */
    const slowFake = await startFakeServer({ liveDelayMs: 10_000 });
    const slowBase = `http://127.0.0.1:${slowFake.port}`;
    const slowStarted = Date.now();
    let slowCount = 0;
    let slowError = '';
    try {
      const slowResult = await importXtreamProvider(
        { name: 'Lassú lista', serverUrl: slowBase, username: 'teszt', password: 'titok' },
        () => {}
      );
      slowCount = slowResult.content.channels.length;
    } catch (error) {
      slowError = String((error as Error)?.message ?? error).slice(0, 140);
    }
    const slowElapsed = Date.now() - slowStarted;
    console.log('\nA teljes élő lista 9 mp-nél tovább készül (1-es napló esete):');
    check(
      'nem fut ki az időkorlát: mind a 4 csatorna megérkezik',
      slowCount === 4,
      slowError || `${slowCount} csatorna, ${slowElapsed} ms`
    );
    await new Promise<void>((resolve) => slowFake.server.close(() => resolve()));
  }

  /* --- Minden élő csatorna lejön, egyetlen kéréssel --- */
  {
    liveCategoryRequests.length = 0;
    const huFake = await startFakeServer({ categoryAwareLive: true });
    const huBase = `http://127.0.0.1:${huFake.port}`;
    const huResult = await importXtreamProvider(
      { name: 'Magyar próba', serverUrl: huBase, username: 'teszt', password: 'titok' },
      () => {}
    );
    console.log('\nMinden élő csatorna lejön, egyetlen kéréssel:');
    const huNames = huResult.content.channels.map((channel) => channel.name).sort();
    /*
     * Az 1-es TV-napló (2.5.114) szerint a szolgáltató 340 élő kategóriájából
     * csak EGY magyar ([HU] HUNGARIA) – a kategóriánkénti szűrés ezért 107
     * csatornát adott a 20 190 helyett. Most a teljes lista jön le, egyetlen
     * kérésben: a felhasználó kérése szerint minden csatorna és kategória kell.
     */
    check(
      'NEM kér kategóriánként (ez vágta le a listát 107 csatornára)',
      liveCategoryRequests.length === 0,
      `(kért kategóriák: ${liveCategoryRequests.join(', ') || 'egy sem'})`
    );
    check(
      'mind a 4 csatorna megérkezik (a magyar és a külföldi is)',
      huNames.length === 4 && huNames.includes('M1 HD') && huNames.includes('RTL Klub')
        && huNames.includes('Sport1') && huNames.includes('Movie Channel'),
      `(${huNames.join(', ') || 'üres'})`
    );
    const huCatNames = huResult.content.liveCategories.map((cat) => cat.name).sort();
    check(
      'a szolgáltató TELJES kategórialistája megmarad (a többi ország neve is elérhető)',
      huCatNames.includes('Angol') && huCatNames.includes('Magyarország') && huCatNames.includes('Németország'),
      `(${huCatNames.join(', ') || 'üres'})`
    );
    await new Promise<void>((resolve) => huFake.server.close(() => resolve()));
  }

  /* --- Ha nincs magyar nevű kategória, nem marad üres a főoldal --- */
  {
    liveCategoryRequests.length = 0;
    const noHuFake = await startFakeServer({
      liveCategoryNames: [
        { category_id: '11', category_name: 'Sport' },
        { category_id: '12', category_name: 'News' },
      ],
    });
    const noHuBase = `http://127.0.0.1:${noHuFake.port}`;
    const noHuResult = await importXtreamProvider(
      { name: 'Nemzetközi próba', serverUrl: noHuBase, username: 'teszt', password: 'titok' },
      () => {}
    );
    console.log('\nHa nincs magyar kategória, nem marad üres a főoldal:');
    check(
      'a teljes lista letöltődik kategóriaszűrés nélkül',
      liveCategoryRequests.length === 0 && noHuResult.content.channels.length === 4,
      `(kategóriakérés: ${liveCategoryRequests.length}, csatorna: ${noHuResult.content.channels.length})`
    );
    await new Promise<void>((resolve) => noHuFake.server.close(() => resolve()));
  }

  /* --- Az 5-ös napló esete: van magyar kategória, de a nevek nem országok --- */
  {
    liveCategoryRequests.length = 0;
    const mixedFake = await startFakeServer({
      categoryAwareLive: true,
      liveCategoryNames: [
        { category_id: '10', category_name: 'Magyarország' },
        { category_id: '11', category_name: 'Sport' },
        { category_id: '12', category_name: 'News' },
        { category_id: '13', category_name: 'Kids' },
        { category_id: '14', category_name: 'Movies' },
      ],
    });
    const mixedBase = `http://127.0.0.1:${mixedFake.port}`;
    const mixedResult = await importXtreamProvider(
      { name: 'Nem ország szerinti panel', serverUrl: mixedBase, username: 'teszt', password: 'titok' },
      () => {}
    );
    console.log('\nHa a kategórianevek nem országok, egyetlen csatorna sem vész el:');
    check(
      'a teljes lista töltődik le, nem csak az 1 magyar kategória',
      liveCategoryRequests.length === 0 && mixedResult.content.channels.length === 4,
      `(kategóriakérés: ${liveCategoryRequests.length}, csatorna: ${mixedResult.content.channels.length})`
    );
    await new Promise<void>((resolve) => mixedFake.server.close(() => resolve()));
  }

  /* --- Egy ország csatornái igény szerint (a 2. pont) --- */
  {
    liveCategoryRequests.length = 0;
    const odFake = await startFakeServer({ categoryAwareLive: true });
    const odBase = `http://127.0.0.1:${odFake.port}`;
    const { loadLiveChannelsForCategories } = await import('../web/src/services/providerImport.ts');
    const loaded = await loadLiveChannelsForCategories(
      { id: 'p-od', name: 'Igény próba', serverUrl: odBase, username: 'teszt', password: 'titok' } as never,
      [{ category_id: '11', category_name: 'Németország' }],
      ['11']
    );
    console.log('\nEgy ország csatornái csak megnyitáskor:');
    check(
      'pontosan a kért kategóriát kéri le',
      liveCategoryRequests.length === 1 && liveCategoryRequests[0] === '11',
      `(kért kategóriák: ${liveCategoryRequests.join(', ') || 'egy sem'})`
    );
    check(
      'csak az adott ország csatornája jön vissza',
      loaded.length === 1 && loaded[0].name === 'Sport1',
      `(${loaded.map((channel) => channel.name).join(', ') || 'üres'})`
    );
    const { loadAllLiveChannels } = await import('../web/src/services/providerImport.ts');
    const all = await loadAllLiveChannels(
      { id: 'p-all', name: 'Teljes lista', serverUrl: odBase, username: 'teszt', password: 'titok' } as never
    );
    check(
      'a teljes-lista ág egyetlen kéréssel minden csatornát visszaad',
      all.length === 4,
      `(${all.length} csatorna, utolsó kérés: category_id=${liveCategoryRequests[liveCategoryRequests.length - 1] ?? 'nincs'})`
    );
    check(
      'a teljes-lista ág NEM küld category_id-t',
      !liveCategoryRequests.includes('') && liveCategoryRequests.every((id) => id.length > 0)
    );
    check(
      'üres kategórialistával nem dob hibát',
      (await loadLiveChannelsForCategories(
        { id: 'p-od2', name: 'Üres', serverUrl: odBase, username: 'teszt', password: 'titok' } as never,
        [],
        []
      )).length === 0
    );
    await new Promise<void>((resolve) => odFake.server.close(() => resolve()));
  }

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

  /* ---------------------------------------------------------------- */
  /* Növekményes frissítés és a teljes katalógus                       */
  /* ---------------------------------------------------------------- */

  console.log('\nA teljes katalógus feldolgozása (nem vágja le a biztonsági korlát):');
  {
    /*
     * A 2.5.116-os napló szerint a szolgáltató 102 815 filmet ad. A régi
     * 40 000-es korlát ezt levághatta, és a felület „Részben kész”-t mutatott.
     * Most 41 000 filmmel próbáljuk: a régi korlát mellett 40 000 jött volna.
     */
    const bigFake = await startFakeServer({ vodCount: 41_000 });
    const big = await importXtreamProvider(
      { name: 'Nagy katalógus', serverUrl: `http://127.0.0.1:${bigFake.port}`, username: 'teszt', password: 'titok' },
      () => {}
    );
    check(
      '41 000 film mind megérkezik (a régi 40 000-es korlát nem vágja le)',
      big.content.movies.length === 41_000,
      `(${big.content.movies.length})`
    );
    const summary = describeCatalogSummary(big.content);
    check(
      'az összefoglaló kategóriaszámot is ír, és nem jelez hibát',
      /csatorna \(\d+ kategória\)/.test(summary.counts)
        && /film \(\d+ kategória\)/.test(summary.counts)
        && /sorozat \(\d+ kategória\)/.test(summary.counts)
        && summary.phase === 'Kész'
        && summary.extra === '',
      `${summary.phase} | ${summary.counts} | ${summary.extra}`
    );
    await new Promise<void>((resolve) => bigFake.server.close(() => resolve()));
  }

  console.log('\nVáltozásvizsgálat – ujjlenyomat és különbségek:');
  {
    const a = catalogFingerprint([{ id: 'lc-1', name: 'Magyarország' }, { id: 'lc-2', name: 'Sport' }]);
    const b = catalogFingerprint([{ id: 'lc-2', name: 'Sport' }, { id: 'lc-1', name: 'Magyarország' }]);
    const c = catalogFingerprint([{ id: 'lc-1', name: 'Magyarország' }, { id: 'lc-2', name: 'Sportok' }]);
    const more = catalogFingerprint([{ id: 'lc-1', name: 'Magyarország' }, { id: 'lc-2', name: 'Sport' }, { id: 'lc-3', name: 'Film' }]);
    check('a sorrend nem számít', a === b, `${a} / ${b}`);
    check('az átnevezés megváltoztatja az ujjlenyomatot', a !== c, `${a} / ${c}`);
    check('az új kategória megváltoztatja az ujjlenyomatot', a !== more, `${a} / ${more}`);

    const before = [
      { id: 'x', name: 'Régi' },
      { id: 'y', name: 'Marad' },
      { id: 'z', name: 'Törlődik' },
    ];
    const after = [
      { id: 'x', name: 'Új név' },
      { id: 'y', name: 'Marad' },
      { id: 'w', name: 'Új' },
    ];
    const diff = diffCatalogs(before, after, (item) => item.id, (item) => item.name);
    check(
      'a különbség: 1 új, 1 módosult, 1 törölt',
      diff.added === 1 && diff.changed === 1 && diff.removed === 1,
      JSON.stringify(diff)
    );
    const same = diffCatalogs(after, after, (item) => item.id, (item) => item.name);
    check(
      'azonos listáknál nincs változás',
      same.added === 0 && same.changed === 0 && same.removed === 0,
      JSON.stringify(same)
    );
  }

  console.log('\nNövekményes frissítés – mindig valódi összevetés, változatlan szakasz nem íródik újra:');
  {
    const freshFake = await startFakeServer();
    const freshProvider = {
      id: 'fresh-provider',
      name: 'Növekményes',
      type: 'xtream' as const,
      serverUrl: `http://127.0.0.1:${freshFake.port}`,
      username: 'teszt',
      password: 'titok',
    };
    // 1) Teljes import: ez menti a szinkron-állapotot.
    const firstResult = await refreshProviderContent(freshProvider as never, () => {}, () => {});
    check('az első frissítés teljes tartalmat ad', 'content' in firstResult, JSON.stringify(Object.keys(firstResult)));
    if ('content' in firstResult) {
      await store.saveLiveContentAsync(firstResult.content);
      await store.saveVodContentSafely(firstResult.content);
      await store.saveSeriesContentSafely(firstResult.content);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const savedState = store.loadSyncState(freshProvider.id);
    check('a teljes import elmenti a kategóriák ujjlenyomatát', Boolean(savedState?.fingerprint), String(savedState?.fingerprint));

    // 2) Azonnali újabb frissítés (2.5.227): a kézi Frissítés MINDIG teljes,
    // elemenkénti összevetést futtat – az indexlisták letöltődnek az
    // összehasonlításhoz, de változatlan tartalomnál részletkérés
    // (get_vod_info / get_series_info) NEM indul, és az eredmény
    // „nincs változás”.
    requestedActions.length = 0;
    const secondResult = await refreshProviderContent(freshProvider as never, () => {}, () => {}, { incremental: true });
    const contentRequests = requestedActions.filter((action) =>
      action === 'get_live_streams' || action === 'get_vod_streams' || action === 'get_series');
    check(
      'a második frissítés „nincs változás”-t ad',
      'unchanged' in secondResult && secondResult.unchanged === true,
      JSON.stringify(Object.keys(secondResult))
    );
    const detailRequests = requestedActions.filter((action) => action === 'get_vod_info' || action === 'get_series_info');
    check(
      'a kézi frissítés letölti az indexeket az összevetéshez, de részleteket nem kér változatlan tartalomnál',
      requestedActions.filter((action) => action === 'get_live_streams').length === 1
        && contentRequests.length === 3
        && detailRequests.length === 0
        && requestedActions.filter((action) => action === 'get_live_categories').length === 1,
      `(kérések: ${requestedActions.join(', ') || 'egy sem'})`
    );

    // 3) A kategória megváltozik → az indexek összevetése után frissített kategóriák.
    freshFake.setLiveCategoryNames([
      { category_id: '10', category_name: 'Magyarország' },
      { category_id: '11', category_name: 'Németország' },
      { category_id: '12', category_name: 'Angol' },
      { category_id: '13', category_name: 'Francia' },
      { category_id: '14', category_name: 'Olasz' },
      { category_id: '15', category_name: 'Spanyol' },
      { category_id: '16', category_name: 'Új ország' },
    ]);
    requestedActions.length = 0;
    const changedResult = await refreshProviderContent(freshProvider as never, () => {}, () => {}, { incremental: true });
    check(
      'kategóriaváltozásnál az indexek alapján frissül a katalógus',
      'content' in changedResult
        && requestedActions.includes('get_live_streams')
        && requestedActions.includes('get_vod_streams'),
      `(kérések: ${requestedActions.join(', ')})`
    );

    /*
     * 4) RÉGI SZINKRON-IDŐBÉLYEG, VÁLTOZATLAN KATEGÓRIÁK (2.5.227).
     *
     * Nincs többé időablak: a kézi Frissítés ILYENKOR IS teljes, elemenkénti
     * összevetést futtat – az indexlisták egyszer letöltődnek a
     * összehasonlításhoz, de változatlan tartalomnál részletkérés nem indul,
     * és az összevetés időbélyege elmentődik.
     */
    const stateAfterChange = store.loadSyncState(freshProvider.id);
    store.saveSyncState({
      providerId: freshProvider.id,
      fingerprint: String(stateAfterChange?.fingerprint ?? ''),
      fullSyncAt: Date.now() - FULL_CHECK_WINDOW_MS - 60_000,
    });
    requestedActions.length = 0;
    const staleResult = await refreshProviderContent(freshProvider as never, () => {}, () => {}, { incremental: true });
    const staleState = store.loadSyncState(freshProvider.id);
    check(
      'régi időbélyegnél is lefut a teljes összevetés (indexek egyszer, részletek nem)',
      'unchanged' in staleResult
        && staleResult.unchanged === true
        && requestedActions.filter((action) => action === 'get_live_streams').length === 1
        && !requestedActions.includes('get_vod_info')
        && !requestedActions.includes('get_series_info')
        && Boolean(staleState && Date.now() - staleState.fullSyncAt < 60_000),
      `(kérések: ${requestedActions.join(', ')})`
    );

    await new Promise<void>((resolve) => freshFake.server.close(() => resolve()));
  }

  console.log(failures === 0 ? '\nMinden próba sikeres. ✅' : `\n${failures} próba nem sikerült. ❌`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error('A próba összeomlott:', error);
  process.exit(1);
});
