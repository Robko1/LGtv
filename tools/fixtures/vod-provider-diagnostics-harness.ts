/**
 * TESZT-HÁROM (jsdom): az Xtream VOD-metaadat teszt a kézi naplóban.
 *
 * A naplózás indítását és a Mozi/Sorozat nézet megnyitását szimulálja egy
 * hamis Xtream-válasszal, és a valódi naplóból ellenőrzi, hogy minden kért
 * adat (év, megjelenés, játékidő, hang, felirat, képek, egyéb mezők) és a
 * megjeleníthetőség is rögzítésre kerül-e – jelszó nélkül.
 */
import { getAppLogText, startManualLogging, stopManualLogging } from '../../web/src/services/appLog';
import {
  attachVodProviderDiagnostics,
  inspectVodSection,
  logVodOverview,
} from '../../web/src/services/vodProviderDiagnostics';
import type { Category, Movie, Series } from '../../web/src/types/iptv';

/*
 * 2.5.226: a VOD-DIAG tisztán MÉRÉSI napló lett (alapból KI, hogy a TV-s
 * hibajavító naplót ne töltse meg). A próba a fejlesztői kapcsolóval,
 * bekapcsolt mérési naplóval ellenőrzi a működését.
 */
try { localStorage.setItem('iptv_rt_meres_naplo', '1'); } catch { /* jsdom nélkül nem fut */ }

const SERVER = 'http://panel.example.tv:8080';
const USER = 'titkosuser';
const PASS = 'titkosjelszo';

const vodCategories: Category[] = [
  { id: 'vc-20', name: 'Filmek', channelCount: 2, subCategoryCount: 0, type: 'movie' },
];
const seriesCategories: Category[] = [
  { id: 'sc-30', name: 'Sorozatok', channelCount: 1, subCategoryCount: 0, type: 'series' },
];

const movies: Movie[] = [
  {
    id: 'vod-prov-1-501', streamId: 501, title: 'Dűne', categoryId: 'vc-20', categoryName: 'Filmek',
    poster: 'http://panel.example.tv/images/cover_big/501.jpg', backdrop: 'http://panel.example.tv/images/backdrop/501.jpg',
    rating: 7.8, year: 2021, durationMinutes: 120, plot: 'Paul Atreides története.', genres: ['Sci-Fi', 'Dráma'],
    director: 'Denis Villeneuve', cast: ['Timothée Chalamet'], streamUrl: 'http://panel.example.tv/movie/titkosuser/titkosjelszo/501.mkv',
    audioLanguages: ['Magyar', 'Angol'], subtitleLanguages: ['Magyar', 'Angol'],
  },
  {
    id: 'vod-prov-1-502', streamId: 502, title: 'Ismeretlen adatú film', categoryId: 'vc-20', categoryName: 'Filmek',
    poster: '', rating: 0, year: 0, durationMinutes: 0, plot: '', genres: [], streamUrl: 'http://panel.example.tv/movie/titkosuser/titkosjelszo/502.mp4',
    audioLanguages: ['Ismeretlen'], subtitleLanguages: ['Ismeretlen'],
  },
  {
    id: 'vod-prov-1-503', streamId: 503, title: 'Harmadik film', categoryId: 'vc-20', categoryName: 'Filmek',
    poster: 'http://panel.example.tv/images/cover_big/503.jpg', rating: 6, year: 2019, durationMinutes: 0, plot: '',
    genres: [], streamUrl: 'http://panel.example.tv/movie/titkosuser/titkosjelszo/503.mp4',
  },
];

const series: Series[] = [
  {
    id: 'ser-prov-1-901', seriesId: 901, title: 'A Sógun', categoryId: 'sc-30', categoryName: 'Sorozatok',
    poster: 'http://panel.example.tv/images/cover/901.jpg', backdrop: 'http://panel.example.tv/images/backdrop/901.jpg',
    rating: 9, year: 2024, seasonsCount: 2, episodesCount: 3, durationMinutes: 60,
    plot: 'Japán történelmi dráma.', genres: ['Dráma'], seasons: [], streamUrl: '',
    audioLanguages: ['Angol'], subtitleLanguages: ['Magyar'],
  },
];

function movieInfo(id: number): unknown {
  return {
    info: {
      tmdb_id: '', name: 'Dűne', o_name: 'Dune',
      cover_big: `http://panel.example.tv/images/cover_big/${id}.jpg`,
      movie_image: `http://panel.example.tv/images/movie_image/${id}.jpg`,
      releasedate: '2021-09-15',
      episode_run_time: '155',
      youtube_trailer: 'https://www.youtube.com/watch?v=abc',
      director: 'Denis Villeneuve',
      actors: 'Timothée Chalamet, Rebecca Ferguson',
      cast: 'Timothée Chalamet, Rebecca Ferguson',
      description: 'Rövid leírás.',
      plot: 'Paul Atreides és a fűszer bolygója.',
      age: '',
      mpaa_rating: 'PG-13',
      rating_count_kinopoisk: 0,
      country: 'US',
      genre: 'Sci-Fi, Dráma',
      backdrop_path: [`http://panel.example.tv/images/backdrop/${id}.jpg`],
      duration_secs: 7200,
      duration: '02:00:00',
      bitrate: 0,
      rating: '7.8',
      audio: [
        { language: 'hu', codec: 'AAC', channels: '2.0' },
        { language: 'en', codec: 'EAC3' },
      ],
      subtitles: [
        { sub_id: 1, language: 'hu' },
        { sub_id: 2, language: 'en' },
      ],
    },
    movie_data: {
      stream_id: id, name: 'Dűne', added: '1690000000', category_id: '20',
      container_extension: 'mkv', custom_sid: '',
      // Ez a mező a valódi paneleknél a felhasználónevet/jelszót is tartalmazó
      // stream-URL: a naplóba csak kitakart formában kerülhet.
      direct_source: `http://panel.example.tv/movie/${USER}/${PASS}/${id}.mkv`,
    },
  };
}

function seriesResponse(): unknown {
  return {
    seasons: [
      { season_number: 1, name: '1. évad', episode_count: 2, cover: 'http://panel.example.tv/images/season1.jpg' },
      { season_number: 2, name: '2. évad', episode_count: 1 },
    ],
    info: {
      name: 'A Sógun', cover: 'http://panel.example.tv/images/cover/901.jpg',
      plot: 'Japán történelmi dráma.', cast: 'Hiroyuki Sanada', director: '',
      genre: 'Dráma', releaseDate: '2024-02-27', last_modified: '1709000000',
      rating: '9.0', backdrop_path: ['http://panel.example.tv/images/backdrop/901.jpg'],
      episode_run_time: '60', audio: { en: 'English' }, subtitles: [{ language: 'hu' }],
    },
    episodes: {
      '1': [
        {
          id: '9001', episode_num: 1, title: 'Rés 1', container_extension: 'mkv', season: 1,
          info: { duration: '01:00:00', movie_image: 'http://panel.example.tv/images/ep/9001.jpg', plot: 'Első rész.', releasedate: '2024-02-27' },
        },
        {
          id: '9002', episode_num: 2, title: 'Rés 2', container_extension: 'mkv', season: 1,
          info: { duration: '00:55:00', movie_image: 'http://panel.example.tv/images/ep/9002.jpg' },
        },
      ],
      '2': [
        {
          id: '9003', episode_num: 1, title: 'Rés 3', container_extension: 'mkv', season: 2,
          info: { duration: '00:58:00' },
        },
      ],
    },
  };
}

interface TestWindow extends Window {
  __VOD_DIAG_TEST__?: {
    run: () => Promise<{
      afterSection: string;
      afterStart: string;
      afterStopBaseline: string;
      afterStop: string;
      calls: string[];
    }>;
    detach: () => void;
  };
}

const testWindow = window as unknown as TestWindow;
const calls: string[] = [];

testWindow.__VOD_DIAG_TEST__ = {
  detach: () => {},
  async run() {
    const detach = attachVodProviderDiagnostics(() => ({
      provider: { id: 'prov-1', type: 'xtream', serverUrl: SERVER, username: USER, password: PASS },
      movies,
      series,
      vodCategories,
      seriesCategories,
      totals: { vod: 2, series: 1 },
    }), {
      transport: {
        async vodInfo(serverUrl, username, password, id) {
          calls.push(`vod|${serverUrl}|${username}|${password}|${String(id)}`);
          return movieInfo(Number(id));
        },
        async seriesInfo(serverUrl, username, password, id) {
          calls.push(`series|${serverUrl}|${username}|${password}|${String(id)}`);
          return seriesResponse();
        },
      },
    });
    testWindow.__VOD_DIAG_TEST__!.detach = detach;

    // A naplózás indítása: ekkor fut le a modul induló tesztje (késleltetve).
    startManualLogging();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Belépés a Mozi, majd a Sorozatok nézetbe.
    inspectVodSection('movies');
    inspectVodSection('series');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterSection = getAppLogText();

    // Az induló teszt (800 ms késleltetés) is fusson le.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    logVodOverview();
    const afterStart = getAppLogText();

    const callsBeforeStop = calls.length;
    stopManualLogging('teszt leállítás');
    const afterStopBaseline = getAppLogText();
    // Leállított naplóban nem készülhet több VOD-DIAG sor, és nem indulhat kérés.
    inspectVodSection('movies');
    inspectVodSection('series');
    logVodOverview(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterStop = getAppLogText();
    calls.push(`calls-before-stop|${callsBeforeStop}`);
    return { afterSection, afterStart, afterStopBaseline, afterStop, calls: calls.slice() };
  },
};
