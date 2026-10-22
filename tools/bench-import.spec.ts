/**
 * Szolgáltatói betöltés sebességmérő próbája (lásd tools/bench-import.mjs).
 *
 * Valósághű méretű hamis Xtream panelt indít, és méri:
 *   - mennyi idő alatt lesz a CSATORNALISTA használható (első előnézet),
 *   - mennyi idő alatt készül el a teljes lista (filmek + sorozatok).
 *
 * A hálózatot 12 ms késleltetéssel utánozza (otthoni Wi-Fi), a válaszok
 * mérete a valósághoz közelít.
 */

import http from 'node:http';

const LIVE_COUNT = Number(process.env.LIVE || 20000);
const VOD_COUNT = Number(process.env.VOD || 20000);
const SERIES_COUNT = Number(process.env.SERIES || 6000);
const VOD_CATEGORY_COUNT = 25;
const SERIES_CATEGORY_COUNT = 12;
const NETWORK_DELAY_MS = 12;

const LIVE_CATEGORIES = Array.from({ length: 40 }, (_, i) => ({
  category_id: String(100 + i),
  category_name: `Élő kategória ${i + 1}`,
}));
const VOD_CATEGORIES = Array.from({ length: VOD_CATEGORY_COUNT }, (_, i) => ({
  category_id: String(200 + i),
  category_name: `Film kategória ${i + 1}`,
}));
const SERIES_CATEGORIES = Array.from({ length: SERIES_CATEGORY_COUNT }, (_, i) => ({
  category_id: String(300 + i),
  category_name: `Sorozat kategória ${i + 1}`,
}));

const LIVE_STREAMS = Array.from({ length: LIVE_COUNT }, (_, i) => ({
  num: i + 1,
  name: `Csatorna ${i + 1} HD`,
  stream_id: 100000 + i,
  stream_icon: `http://logo.example/${i}.png`,
  category_id: LIVE_CATEGORIES[i % LIVE_CATEGORIES.length].category_id,
  epg_channel_id: `ch${i}`,
}));

const VOD_STREAMS = Array.from({ length: VOD_COUNT }, (_, i) => ({
  num: i + 1,
  name: `Film ${i + 1} (${2000 + (i % 25)})`,
  stream_id: 500000 + i,
  container_extension: i % 3 === 0 ? 'mkv' : 'mp4',
  category_id: VOD_CATEGORIES[i % VOD_CATEGORIES.length].category_id,
  stream_icon: `http://logo.example/m${i}.jpg`,
  rating: String(6 + (i % 40) / 10),
  added: '1690000000',
  plot: 'Egy izgalmas történet, amelynek során a főhősöknek szembe kell nézniük a múltjukkal és a jövőjükkel.',
}));

const SERIES = Array.from({ length: SERIES_COUNT }, (_, i) => ({
  num: i + 1,
  name: `Sorozat ${i + 1}`,
  series_id: 900000 + i,
  category_id: SERIES_CATEGORIES[i % SERIES_CATEGORY_COUNT].category_id,
  cover: `http://logo.example/s${i}.jpg`,
  plot: 'Több évados dráma.',
  genre: 'Dráma',
  rating: '8.1',
  releaseDate: '2024-01-01',
}));

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function startPanel() {
  const stats = { requests: 0, peakConcurrent: 0 };
  let inFlight = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const action = url.searchParams.get('action') || 'auth';
    const categoryId = url.searchParams.get('category_id');
    stats.requests++;
    inFlight++;
    stats.peakConcurrent = Math.max(stats.peakConcurrent, inFlight);
    const reply = (body) => {
      setTimeout(() => {
        inFlight--;
        json(res, body);
      }, NETWORK_DELAY_MS);
    };
    switch (action) {
      case 'auth':
      case '':
        reply({ user_info: { auth: 1, status: 'Active', exp_date: '1893456000', max_connections: '2' } });
        break;
      case 'get_live_categories':
        reply(LIVE_CATEGORIES);
        break;
      case 'get_live_streams':
        reply(categoryId ? LIVE_STREAMS.filter((s) => String(s.category_id) === categoryId) : LIVE_STREAMS);
        break;
      case 'get_vod_categories':
        reply(VOD_CATEGORIES);
        break;
      case 'get_vod_streams':
        reply(categoryId ? VOD_STREAMS.filter((s) => String(s.category_id) === categoryId) : VOD_STREAMS);
        break;
      case 'get_series_categories':
        reply(SERIES_CATEGORIES);
        break;
      case 'get_series':
        reply(categoryId ? SERIES.filter((s) => String(s.category_id) === categoryId) : SERIES);
        break;
      default:
        reply([]);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : 0,
        stats,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

/* --------------------------------------------------- tároló (memória) */

const files = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => files.get(key) ?? null,
    setItem: (key, value) => { files.set(key, String(value)); },
    removeItem: (key) => { files.delete(key); },
    key: (index) => Array.from(files.keys())[index] ?? null,
    get length() { return files.size; },
  },
};

/* -------------------------------------------------------------- futás */

const fmt = (ms) => `${(ms / 1000).toFixed(2)} s`;

async function main() {
  const { importXtreamProvider } = await import('../web/src/services/providerImport.ts');
  const panel = await startPanel();
  const startedAt = Date.now();
  let liveReadyAt = 0;
  let liveChannels = 0;
  let saveMs = 0;
  let saveBytes = 0;

  const result = await importXtreamProvider(
    { name: 'Mérőpanel', serverUrl: `http://127.0.0.1:${panel.port}`, username: 'teszt', password: 'titok' },
    () => {},
    async (partial) => {
      if (partial.channels && !liveReadyAt) {
        liveReadyAt = Date.now();
        liveChannels = partial.channels.length;
      }
      // A felület a részleges szakaszokat AZONNAL menti is (ezt méri a
      // "mentés" sor): a TV-n ez is a főszálon futó munka.
      const store = await import('../web/src/services/contentStore.ts');
      const t0 = Date.now();
      if (partial.channels && !partial.preview) store.saveLiveContent({ ...partial, provider: result0Provider(), savedAt: '', movies: [], series: [], vodCategories: [], seriesCategories: [], totals: {} });
      if (partial.movies) await store.saveVodContent({ ...partial, provider: result0Provider(), savedAt: '', channels: [], series: [], liveCategories: [], seriesCategories: [], totals: {} });
      saveMs += Date.now() - t0;
      void saveBytes;
    }
  );

  const totalMs = Date.now() - startedAt;
  console.log('\nSzolgáltatói betöltés (hamis panel, 12 ms hálózat):');
  console.log(`  csatorna: ${result.content.channels.length}, film: ${result.content.movies.length}, sorozat: ${result.content.series.length}`);
  console.log(`  csatornalista használható: ${fmt(liveReadyAt - startedAt)} (${liveChannels} csatorna előnézet)`);
  console.log(`  teljes lista kész:          ${fmt(totalMs)}`);
  console.log(`  mentés (főszál):           ${fmt(saveMs)}`);
  console.log(`  kérések: ${panel.stats.requests}, egyidejű csúcs: ${panel.stats.peakConcurrent}`);
  await panel.close();
  if (result.content.channels.length !== LIVE_COUNT) throw new Error('hiányos csatornalista');
  if (result.content.movies.length !== VOD_COUNT) throw new Error('hiányos filmlista');
  if (result.content.series.length !== SERIES_COUNT) throw new Error('hiányos sorozatlista');
  console.log('  ✓ minden lista teljes (nincs elveszett adat)');
}

function result0Provider() {
  return { id: 'bench', type: 'xtream', serverUrl: '', username: '', password: '' };
}

main().catch((error) => {
  console.error('A mérés nem sikerült:', error);
  process.exit(1);
});
