/**
 * A VOD-metaadatok (játékidő, hangsáv- és feliratnyelvek) feldolgozásának és
 * megjelenítési szövegeinek regressziós próbája.
 *
 * Külön ellenőrizzük a szolgáltatók eltérő játékidő-formátumait, mert korábban
 * a `HH:MM` alakot a program csak percekként olvasta: egy kétórás film
 * („2:00”) 2 percként jelent meg 120 perc helyett.
 */
import { parseEpisodeMetadata, parseSeriesMetadata, parseVodMetadata } from '../web/src/services/vodMetadata';
import { formatRuntime, joinLanguages, visibleLanguages } from '../web/src/utils/vodDisplay';

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

console.log('\n3. Megjelenítési szövegek (vodDisplay.ts)');
check('120 perc szövege', formatRuntime(120) === '120 perc', formatRuntime(120));
check('45 perc szövege', formatRuntime(45) === '45 perc', formatRuntime(45));
check('hiányzó játékidőnél üres szöveg', formatRuntime(0) === '' && formatRuntime(undefined) === '', formatRuntime(0));
check('az Ismeretlen nem jelenik meg nyelvként', JSON.stringify(visibleLanguages(['Magyar', 'Ismeretlen', ' '])) === JSON.stringify(['Magyar']), visibleLanguages(['Magyar', 'Ismeretlen', ' ']));
check('üres nyelvlista üres szöveget ad', joinLanguages(['Ismeretlen']) === '' && joinLanguages(undefined) === '', joinLanguages(['Ismeretlen']));
check('a nyelvek tömör felsorolása', joinLanguages(['Magyar', 'Angol']) === 'Magyar • Angol', joinLanguages(['Magyar', 'Angol']));
check('sok nyelvnél +N jelzés', joinLanguages(['Magyar', 'Angol', 'Német', 'Francia'], 2) === 'Magyar • Angol +2', joinLanguages(['Magyar', 'Angol', 'Német', 'Francia'], 2));

console.log(`\nVOD-metaadat tesztek összesen: ${passed} sikeres, ${failed} hibás.`);
if (failed > 0) {
  console.error('HIBA: a VOD-metaadatok feldolgozása nem a várt módon működik.');
  process.exit(1);
}
console.log('OK: a VOD-metaadatok (játékidő, nyelvlisták, megjelenítés) rendben vannak. ✅');
