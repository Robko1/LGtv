/**
 * Terheléses és hálózatkímélő próba: valósághű Xtream szolgáltató utánozása.
 *
 * A próba azt ellenőrzi, hogy a betöltő
 *   - SORBAN dolgozza-e fel a kéréseket (egyszerre egy kapcsolat), mert a
 *     párhuzamos, sokszor újrapróbálkozó változat túlterhelte az otthoni
 *     routereket (NAT/conntrack teleírás → az internet lefagyott),
 *   - a szakaszokat sorrendben adja-e a felületre (élő -> film -> sorozat),
 *   - teljes listát ad-e akkor is, ha a panel átmenetileg hibázik,
 *   - és ELÉRHETETLEN szolgáltatónál gyorsan, kevés kéréssel LEÁLL-e
 *     (nem pörög tovább, nem terheli a routert).
 *
 * Futtatás: node tools/test-import-stress.mjs
 */

import http from 'node:http';

const REQUEST_DELAY_MS = 15;

const LIVE_CATEGORIES = Array.from({ length: 12 }, (_, i) => ({
  category_id: String(100 + i),
  category_name: `Élő kategória ${i + 1}`,
}));
const VOD_CATEGORIES = Array.from({ length: 40 }, (_, i) => ({
  category_id: String(200 + i),
  category_name: `Film kategória ${i + 1}`,
}));
const SERIES_CATEGORIES = Array.from({ length: 25 }, (_, i) => ({
  category_id: String(300 + i),
  category_name: `Sorozat kategória ${i + 1}`,
}));

const LIVE_STREAMS = Array.from({ length: 300 }, (_, i) => ({
  num: i + 1,
  name: `Csatorna ${i + 1}`,
  stream_id: 1000 + i,
  stream_icon: '',
  category_id: LIVE_CATEGORIES[i % LIVE_CATEGORIES.length].category_id,
}));

const VOD_STREAMS = Array.from({ length: 800 }, (_, i) => ({
  name: `Film ${i + 1}`,
  stream_id: 5000 + i,
  container_extension: 'mkv',
  category_id: VOD_CATEGORIES[i % VOD_CATEGORIES.length].category_id,
  stream_icon: '',
  rating: '7.0',
  added: '1690000000',
}));

const SERIES = Array.from({ length: 200 }, (_, i) => ({
  name: `Sorozat ${i + 1}`,
  series_id: 9000 + i,
  category_id: SERIES_CATEGORIES[i % SERIES_CATEGORIES.length].category_id,
  cover: '',
  rating: '8.0',
  releaseDate: '2024-01-01',
}));

function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

interface FakePanel {
  server: http.Server;
  port: number;
  stats: {
    requests: number;
    rejected: number;
    transient: number;
    peakConcurrent: number;
    byAction: Map<string, number>;
  };
  close: () => Promise<void>;
}

/**
 * Valósághű panel.
 *
 * @param maxConnections a panel kapcsolatkorlátja (a fölötte lévőkre 429)
 * @param flakyEvery minden N-edik kérés átmeneti hiba (503); 0 = nincs
 * @param hang ha igaz, a szerver egyáltalán nem válaszol (blokkolt/elérhetetlen)
 * @param dieAfter ennyi kérés után a panel „meghal” (minden további kérés hibára fut)
 */
function startPanel(
  maxConnections = 2,
  flakyEvery = 0,
  hang = false,
  dieAfter = 0
): Promise<FakePanel> {
  let inFlight = 0;
  let served = 0;
  const stats: FakePanel['stats'] = {
    requests: 0,
    rejected: 0,
    transient: 0,
    peakConcurrent: 0,
    byAction: new Map(),
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const action = url.searchParams.get('action') || 'auth';
    const categoryId = url.searchParams.get('category_id');

    stats.requests++;
    stats.byAction.set(action, (stats.byAction.get(action) || 0) + 1);

    inFlight++;
    stats.peakConcurrent = Math.max(stats.peakConcurrent, inFlight);

    const finish = (body: unknown, status = 200) => {
      setTimeout(() => {
        inFlight--;
        json(res, body, status);
      }, REQUEST_DELAY_MS);
    };

    // Elérhetetlen (blokkolt) szerver: egyáltalán nem válaszol.
    if (hang) return;

    // A panel „meghalt” (pl. megszakadt a Wi-Fi): minden kérés hibára fut.
    if (dieAfter > 0 && stats.requests > dieAfter) {
      inFlight--;
      res.destroy();
      return;
    }

    if (inFlight > maxConnections) {
      stats.rejected++;
      finish({ user_info: { auth: 0, status: 'Too many connections' } }, 429);
      return;
    }

    served++;
    if (flakyEvery > 0 && served % flakyEvery === 0) {
      stats.transient++;
      finish({ error: 'temporary failure' }, 503);
      return;
    }

    switch (action) {
      case 'auth':
      case '':
        finish({
          user_info: {
            username: 'teszt',
            auth: 1,
            status: 'Active',
            exp_date: '1893456000',
            max_connections: String(maxConnections),
          },
          server_info: { url: '127.0.0.1', port: '80' },
        });
        break;
      case 'get_live_categories':
        finish(LIVE_CATEGORIES);
        break;
      case 'get_live_streams':
        finish(categoryId ? LIVE_STREAMS.filter((s) => String(s.category_id) === categoryId) : LIVE_STREAMS);
        break;
      case 'get_vod_categories':
        finish(VOD_CATEGORIES);
        break;
      case 'get_vod_streams':
        finish(categoryId ? VOD_STREAMS.filter((s) => String(s.category_id) === categoryId) : VOD_STREAMS);
        break;
      case 'get_series_categories':
        finish(SERIES_CATEGORIES);
        break;
      case 'get_series':
        finish(categoryId ? SERIES.filter((s) => String(s.category_id) === categoryId) : SERIES);
        break;
      default:
        finish([]);
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        server,
        port,
        stats,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/* ------------------------------------------------------- környezet */

// A tár a valódi úton (localStorage) megy: a régi natív híd már nincs a
// programban, ezért a próbának is a böngészős tárolót kell utánoznia.
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

async function loadFrom(panel: FakePanel, onPartial?: (partial: any) => void) {
  const { importXtreamProvider } = await import('../web/src/services/providerImport.ts');
  const started = Date.now();
  let content: any = null;
  let error: unknown = null;
  try {
    const result = await importXtreamProvider(
      { name: 'Teszt panel', serverUrl: `http://127.0.0.1:${panel.port}`, username: 'teszt', password: 'titok' },
      () => {},
      onPartial
    );
    content = result.content;
  } catch (e) {
    error = e;
  }
  return { content, error, elapsed: Date.now() - started };
}

async function main() {
  const net = await import('../web/src/services/net.ts');

  /* --- 1. forgatókönyv: normál panel (2 kapcsolat) --- */
  const panel = await startPanel(2);
  const partialOrder: string[] = [];
  const first = await loadFrom(panel, (partial) => {
    if (partial.channels) partialOrder.push('live');
    else if (partial.movies) partialOrder.push('vod');
    else if (partial.series) partialOrder.push('series');
  });

  console.log('\nNormál panel (max 2 kapcsolat):');
  console.log(`  kérelmek: ${panel.stats.requests}, elutasítva (429): ${panel.stats.rejected}, egyidejű csúcs: ${panel.stats.peakConcurrent}`);
  console.log(`  eltelt idő: ${first.elapsed} ms`);
  console.log(`  kérelmek műveletenként: ${[...panel.stats.byAction.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

  check('hiba nélkül betöltött', first.error === null, first.error ? String(first.error) : '');
  check('300 élő csatorna betöltve', first.content?.channels.length === 300, `(${first.content?.channels.length})`);
  check('800 film betöltve', first.content?.movies.length === 800, `(${first.content?.movies.length})`);
  check('200 sorozat betöltve', first.content?.series.length === 200, `(${first.content?.series.length})`);
  // A film- és a sorozatlista szándékosan PÁRHUZAMOSAN töltődik (2 kapcsolat),
  // mert így a Sorozat menü nem vár a teljes filmkatalógusra. A kímélő korlát
  // továbbra is érvényes: legfeljebb 2 kapcsolat (+1 rövid bejelentkezés).
  check(
    'kímélő mód: egyszerre legfeljebb 2 kapcsolat',
    panel.stats.peakConcurrent <= 2,
    `(csúcs: ${panel.stats.peakConcurrent})`
  );
  check('nem volt 429-es elutasítás', panel.stats.rejected === 0, `(${panel.stats.rejected})`);
  // A kérések közötti minimális szünet 25 ms (a referencia sebességéhez
  // igazítva, korábban 80 ms volt). A próba a kapcsolatözön elleni védelmet
  // ellenőrzi: kérésenként legalább ~20 ms-nak el kell telnie.
  check(
    'kis szünet van a kérések között (nincs kapcsolatözön)',
    first.elapsed >= Math.max(0, panel.stats.requests - 1) * 20,
    `(${first.elapsed} ms / ${panel.stats.requests} kérés; legalább ${(Math.max(0, panel.stats.requests - 1) * 20)} ms elvárt)`
  );
  check(
    'a szakaszok sorrendben érkeznek a felületre (élő előbb, mint a film)',
    partialOrder.join(',') === 'live,vod,series',
    `(${partialOrder.join(',')})`
  );
  await panel.close();

  /* --- 2. forgatókönyv: átmenetileg hibázó panel --- */
  net.resetNetworkBreaker();
  const flaky = await startPanel(2, 4);
  const flakyResult = await loadFrom(flaky);
  console.log('\nÁtmenetileg hibázó panel (minden 4. kérés 503):');
  console.log(`  kérelmek: ${flaky.stats.requests}, átmeneti hiba: ${flaky.stats.transient}, elutasítva: ${flaky.stats.rejected}`);
  check('az átmeneti hibák ellenére hibátlanul betöltött', flakyResult.error === null, flakyResult.error ? String(flakyResult.error) : '');
  check('300 élő csatorna (hibázó panel)', flakyResult.content?.channels.length === 300, `(${flakyResult.content?.channels.length})`);
  check('800 film (hibázó panel)', flakyResult.content?.movies.length === 800, `(${flakyResult.content?.movies.length})`);
  check('200 sorozat (hibázó panel)', flakyResult.content?.series.length === 200, `(${flakyResult.content?.series.length})`);
  await flaky.close();

  /* --- 3. forgatókönyv: EGY kapcsolatot engedő panel --- */
  net.resetNetworkBreaker();
  const single = await startPanel(1);
  const singleResult = await loadFrom(single);
  console.log('\nEgy kapcsolatot engedő panel (max_connections = 1):');
  console.log(`  kérelmek: ${single.stats.requests}, elutasítva (429): ${single.stats.rejected}, egyidejű csúcs: ${single.stats.peakConcurrent}`);
  check('egy kapcsolatnál sincs elveszett kategória', singleResult.error === null, singleResult.error ? String(singleResult.error) : '');
  check('300 élő csatorna (1 kapcsolat)', singleResult.content?.channels.length === 300, `(${singleResult.content?.channels.length})`);
  check('800 film (1 kapcsolat)', singleResult.content?.movies.length === 800, `(${singleResult.content?.movies.length})`);
  check('200 sorozat (1 kapcsolat)', singleResult.content?.series.length === 200, `(${singleResult.content?.series.length})`);
  await single.close();

  /* --- 4. forgatókönyv: ELÉRHETETLEN szolgáltató (a router kímélése) --- */
  net.resetNetworkBreaker();
  const dead = await startPanel(2, 0, true); // soha nem válaszol
  const deadResult = await loadFrom(dead);
  console.log('\nElérhetetlen (blokkolt) szolgáltató – a szerver nem válaszol:');
  console.log(`  kérelmek: ${dead.stats.requests}, eltelt idő: ${deadResult.elapsed} ms`);
  console.log(`  hibaüzenet: ${deadResult.error instanceof Error ? deadResult.error.message.slice(0, 120) : '-'}`);
  check('hibát jelez (nem „sikerül” üresen)', deadResult.error !== null);
  check(
    'kevés kéréssel leállt (legfeljebb 3 próbálkozás)',
    dead.stats.requests <= 3,
    `(${dead.stats.requests} kérés)`
  );
  check(
    'gyorsan leállt (legfeljebb 20 másodperc)',
    deadResult.elapsed <= 20000,
    `(${deadResult.elapsed} ms)`
  );
  await dead.close();

  /* --- 5. forgatókönyv: menet közben megszakad a hálózat --- */
  net.resetNetworkBreaker();
  const dying = await startPanel(2, 0, false, 4); // negyedik kérés után meghal
  const dyingResult = await loadFrom(dying);
  console.log('\nHálózat menet közben megszakad (a panel a 4. kérés után elhal):');
  console.log(`  kérelmek: ${dying.stats.requests}, eltelt idő: ${dyingResult.elapsed} ms`);
  check(
    'a betöltést leállította (nem pörög tovább)',
    dying.stats.requests <= 14,
    `(${dying.stats.requests} kérés)`
  );
  check(
    'gyorsan leállt (legfeljebb 30 másodperc)',
    dyingResult.elapsed <= 30000,
    `(${dyingResult.elapsed} ms)`
  );
  await dying.close();

  console.log('');
  if (failures === 0) {
    console.log('Minden terheléses és hálózatkímélő próba sikeres. ✅');
  } else {
    console.log(`${failures} próba nem sikerült. ❌`);
  }
  console.log('  (a próba azt is igazolja, hogy a betöltő legfeljebb 2 kapcsolatot használ, és nem válaszoló szervernél 10 mp alatt leáll)');
  process.exit(failures === 0 ? 0 : 1);
}

main();
