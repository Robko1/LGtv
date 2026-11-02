/**
 * A VOD-metaadatok (játékidő, hangsáv- és feliratnyelvek) feldolgozásának és
 * megjelenítési szövegeinek regressziós próbája.
 *
 * Külön ellenőrizzük a szolgáltatók eltérő játékidő-formátumait, mert korábban
 * a `HH:MM` alakot a program csak percekként olvasta: egy kétórás film
 * („2:00”) 2 percként jelent meg 120 perc helyett.
 */
import { parseEpisodeMetadata, parseSeriesMetadata, parseVodMetadata } from '../web/src/services/vodMetadata';
import { cardAudioLabel, formatRuntime, joinLanguages, visibleLanguages } from '../web/src/utils/vodDisplay';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, actual?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${label}${actual === undefined ? '' : ` – kapott érték: ${JSON.stringify(actual)}`}`);
}

console.log('1. Játékidő-formátumok (vodMetadata.ts)');
const durations: Array<[string, Record<string, unknown>, number]> = [
  ['HH:MM:SS – 2 óra', { duration: '02:00:00' }, 120],
  ['HH:MM – 2 óra nem 2 perc', { duration: '2:00' }, 120],
  ['HH:MM – 1 óra 45 perc', { duration: '1:45' }, 105],
  ['HH:MM – 0 óra 45 perc', { duration: '0:45' }, 45],
  ['MM:SS – 42 perc 10 másodperc', { duration: '42:10' }, 42],
  ['MM:SS – 135 perc', { duration: '135:00' }, 135],
  ['másodperces mező', { duration_secs: 7200 }, 120],
  ['másodperces szöveges mező', { duration_secs: '5520' }, 92],
  ['percben megadott érték', { runtime: 125 }, 125],
  ['szöveges óra/perc alak', { duration: '2h 5min' }, 125],
  ['hiányzó adat nem lesz kitalált érték', {}, 0],
  // 2.5.236: a kettőspontos érték idő-szöveg a duration_secs kulcsban is –
  // a "02:14" 2 óra 14 perc (134), nem 2 perc.
  ['duration_secs kettőspontos alak – 2 óra 14 perc', { duration_secs: '02:14' }, 134],
  // 2.5.236: percet író panel a duration_secs mezőben – 114 perc, nem 2 perc.
  ['perc a duration_secs mezőben (panelhiba)', { duration_secs: '114' }, 114],
  // 2.5.236: a hibás kulcs apró értéke nem nyomja el a valódi játékidőt.
  ['apró episode_run_time mellett a runtime nyer', { episode_run_time: '2', runtime: '114' }, 114],
  // Végső tartalék: ha csak apró érték van, az marad (rövidfilm lehet).
  ['egyetlen apró érték megmarad', { runtime: '9' }, 9],
];
for (const [label, info, expected] of durations) {
  const parsed = parseVodMetadata({ info });
  check(`${label} → ${expected} perc`, parsed.durationMinutes === expected, parsed.durationMinutes);
}

const movieDataOnly = parseVodMetadata({ info: {}, movie_data: { duration: '2:05' } });
check('a movie_data játékideje is feldolgozódik (2:05 → 125 perc)', movieDataOnly.durationMinutes === 125, movieDataOnly.durationMinutes);

const series = parseSeriesMetadata({
  info: { duration: '00:45:00' },
  episodes: { '1': [{ id: '1', info: { duration: '00:42:00' } }] },
});
check('sorozat játékideje az info alapján', series.durationMinutes === 45, series.durationMinutes);

const episode = parseEpisodeMetadata({ info: { duration: '00:42:00' } });
check('epizód játékideje (00:42:00 → 42 perc)', episode.durationMinutes === 42, episode.durationMinutes);
const shortEpisode = parseEpisodeMetadata({ info: { duration: '21:30' } });
check('epizód perces alakja nem lesz 21 óra', shortEpisode.durationMinutes === 22, shortEpisode.durationMinutes);

console.log('\n2. Hangsáv- és feliratnyelvek');
const withTracks = parseVodMetadata({
  info: {
    duration: '02:00:00',
    audio: [{ language: 'hu', codec: 'AAC' }, { language: 'en', codec: 'EAC3' }],
    subtitles: [{ sub_id: 1, language: 'hu' }, { sub_id: 2, language: 'en' }],
  },
});
check('a hangsávnyelvek magyar nevet kapnak', JSON.stringify(withTracks.audioLanguages) === JSON.stringify(['Magyar', 'Angol']), withTracks.audioLanguages);
check('a feliratnyelvek magyar nevet kapnak', JSON.stringify(withTracks.subtitleLanguages) === JSON.stringify(['Magyar', 'Angol']), withTracks.subtitleLanguages);

const withoutTracks = parseVodMetadata({ info: { duration: '02:00:00' } });
check('hiányzó hangsávnál nincs kitalált nyelv', JSON.stringify(withoutTracks.audioLanguages) === JSON.stringify(['Ismeretlen']), withoutTracks.audioLanguages);
check('hiányzó feliratnál nincs kitalált nyelv', JSON.stringify(withoutTracks.subtitleLanguages) === JSON.stringify(['Ismeretlen']), withoutTracks.subtitleLanguages);
check('hiányzó hangsávnál nincs megjeleníthető sáv', withoutTracks.audioTracks.length === 0);


console.log('\n2/b. ffprobe/mediainfo hangsávok – a technikai kulcsok nem nyelvek');
const ffprobe = parseVodMetadata({
  info: {
    audio: {
      index: 1,
      codec_name: 'eac3',
      codec_type: 'audio',
      sample_rate: '48000',
      channels: 6,
      channel_layout: '5.1',
      tags: { language: 'fra', title: 'French' },
      disposition: { default: 1 },
    },
    streams: [
      { index: 0, codec_name: 'h264', codec_type: 'video' },
      { index: 2, codec_name: 'aac', codec_type: 'audio', channels: 2, tags: { language: 'eng' } },
      { index: 3, codec_name: 'aac', codec_type: 'audio', channels: 2 },
    ],
  },
});
check('a tags.language francia lesz, nem codec_name/index', ffprobe.audioLanguages.includes('Francia') && ffprobe.audioLanguages.includes('Angol') && !ffprobe.audioLanguages.includes('eac3') && !ffprobe.audioLanguages.includes('index'), ffprobe.audioLanguages);
check('a technikai mezők nem válnak hangsávvá', ffprobe.audioTracks.length === 3, ffprobe.audioTracks);
const frenchTrack = ffprobe.audioTracks.find((track) => track.lang === 'fra');
check('a kodek és csatornaszám megmarad', frenchTrack?.codec === 'eac3' && frenchTrack?.channels === '6', frenchTrack);
console.log('\n3. Megjelenítési szövegek (vodDisplay.ts)');
check('120 perc szövege', formatRuntime(120) === '120 perc', formatRuntime(120));
check('45 perc szövege', formatRuntime(45) === '45 perc', formatRuntime(45));
check('hiányzó játékidőnél üres szöveg', formatRuntime(0) === '' && formatRuntime(undefined) === '', formatRuntime(0));
check('az Ismeretlen nem jelenik meg nyelvként', JSON.stringify(visibleLanguages(['Magyar', 'Ismeretlen', ' '])) === JSON.stringify(['Magyar']), visibleLanguages(['Magyar', 'Ismeretlen', ' ']));
check('üres nyelvlista üres szöveget ad', joinLanguages(['Ismeretlen']) === '' && joinLanguages(undefined) === '', joinLanguages(['Ismeretlen']));
check('a nyelvek tömör felsorolása', joinLanguages(['Magyar', 'Angol']) === 'Magyar • Angol', joinLanguages(['Magyar', 'Angol']));
check('sok nyelvnél +N jelzés', joinLanguages(['Magyar', 'Angol', 'Német', 'Francia'], 2) === 'Magyar • Angol +2', joinLanguages(['Magyar', 'Angol', 'Német', 'Francia'], 2));
// 2.5.236: a kártya hangnyelv-sora – a magyar mindig elöl, ismeretlen nyelvnél „Angol”.
check('kártya: a magyar hang mindig elöl', cardAudioLabel(['Angol', 'Ukrán', 'Spanyol', 'Magyar']) === 'Magyar • Angol • Ukrán +1', cardAudioLabel(['Angol', 'Ukrán', 'Spanyol', 'Magyar']));
check('kártya: magyar nélkül az angol az első', cardAudioLabel(['Spanyol', 'Angol']) === 'Angol • Spanyol', cardAudioLabel(['Spanyol', 'Angol']));
check('kártya: ismert nyelv híján Angol az alapértelmezés', cardAudioLabel([]) === 'Angol' && cardAudioLabel(['Ismeretlen']) === 'Angol' && cardAudioLabel(undefined) === 'Angol', cardAudioLabel([]));

console.log('\n4. Lapos gyors út paritása (a tömeges importlista feldolgozása)');
/*
 * A get_vod_streams/get_series tömeges listáinak lapos rekordjait egy gyors
 * út dolgozza fel (parseFlatMetadata). A próba bizonyítja, hogy BITRE AZONOS
 * eredményt ad a teljes úttal: a {info: rekord} csomagolás garantáltan a
 * teljes utat járja be, és a teljes út a lapos rekordon pontosan ugyanazt
 * számolja (info ?? response → ugyanaz a parseCommon, movie_data nincs).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as Record<string, unknown>).sort();
    const keysB = Object.keys(b as Record<string, unknown>).sort();
    return deepEqual(keysA, keysB) && keysA.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}
const flatSamples: Array<Record<string, unknown>> = [
  { num: 1, name: 'NF - The Irishman (2019)', stream_type: 'movie', stream_id: 1388103, stream_icon: 'http://x/poster.jpg', rating: '7.1', rating_5based: 3.6, added: '1726000000', category_id: '12', container_extension: 'mkv', custom_sid: '', direct_source: '' },
  { stream_id: 2, name: 'Üres', stream_icon: '', rating: '', rating_5based: 0, category_id: null },
  { stream_id: 3, name: 'Éves', year: '2021', release_date: '2020-05-01', rating: 'N/A', rating_5based: '4.2' },
  { stream_id: 4, name: 'Időtartamos', duration: '2:00', genre: 'Action, Drama | Thriller', cast: 'A, B; C', director: 'Rendező X', plot: 'Hosszú leírás.' },
  { stream_id: 5, name: 'Perc', duration_secs: '7265', runtime: 95 },
  { series_id: 6, name: 'Sorozat (2021)', cover: 'http://x/c.jpg', backdrop_path: ['http://x/b1.jpg', 'http://x/b2.jpg'], releaseDate: '2021-09-17', episode_run_time: '45', genre: 'Drama', rating_5based: 4.1, youtube_trailer: 'abc', last_modified: '1726000001' },
  { stream_id: 7, name: 'JSON-os genre', genre: '["Action","Comedy"]', cast: '["X","Y"]' },
  { stream_id: 8, name: 'Movie_image elsőbbség', movie_image: 'http://x/mi.jpg', stream_icon: 'http://x/si.jpg', poster: '' },
  { stream_id: 9, name: 'Nagy runtime', length: '42:10' },
  { stream_id: 10, name: 'Üres mezők', plot: '  ', description: 'Valódi leírás', overview: 'másik' },
  { stream_id: 15, name: 'Rating sorrend', rating_5based: '4.9', rating: '8.8' },
  { stream_id: 16, name: 'Runtime elsőbbség', runtime: '120', duration_minutes: '95' },
];
for (const sample of flatSamples) {
  const fast = parseVodMetadata(sample);
  const slow = parseVodMetadata({ info: sample });
  check(`lapos rekord azonos eredményt ad (${sample.name})`, deepEqual(fast, slow), fast);
  const fastSeries = parseSeriesMetadata(sample);
  const slowSeries = parseSeriesMetadata({ info: sample });
  check(`lapos sorozatrekord azonos eredményt ad (${sample.name})`, deepEqual(fastSeries, slowSeries), fastSeries);
}
// Gazdag rekordoknál a gyors útnak FÉLRE kell állnia: a mély feldolgozás
// (hangsávok, feliratok, beágyazott info) változatlanul működik.
const subtitleSample = parseVodMetadata({ stream_id: 12, name: 'Feliratos', subtitles: '[{"language":"eng","url":"http://x/s.srt"}]' });
check('felirat mezőnél a teljes út fut (talál feliratot)', subtitleSample.subtitleTracks.length > 0, subtitleSample.subtitleTracks);
const streamsSample = parseVodMetadata({ stream_id: 14, name: 'Streames', streams: [{ codec_type: 'audio', index: 0, tags: { language: 'hun' } }] });
check('streams mezőnél a teljes út fut (talál hangsávot)', streamsSample.audioTracks.length > 0, streamsSample.audioTracks);
const nestedInfoSample = parseVodMetadata({ stream_id: 13, name: 'Info-s', info: { plot: 'belső' } });
check('beágyazott info mezőnél a teljes út fut', nestedInfoSample.plot === 'belső', nestedInfoSample.plot);

console.log(`\nVOD-metaadat tesztek összesen: ${passed} sikeres, ${failed} hibás.`);
if (failed > 0) {
  console.error('HIBA: a VOD-metaadatok feldolgozása nem a várt módon működik.');
  process.exit(1);
}
console.log('OK: a VOD-metaadatok (játékidő, nyelvlisták, megjelenítés) rendben vannak. ✅');
