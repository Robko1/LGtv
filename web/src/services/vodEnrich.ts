import { Movie, Series } from '../types/iptv';
import { ProviderRef, saveCatalogExtras } from './contentStore';
import { applyMovieMetadata, applySeriesMetadata } from './providerImport';
import { seasonsFromSeriesInfo } from './catalogRows';
import { parseSeriesMetadata, parseVodMetadata } from './vodMetadata';
import { xtreamService } from './xtreamService';
import { appLog } from './appLog';

/*
 * 2.5.249 – VOD DÚSÍTÁS ADATLAP-MEGNYITÁSKOR.
 *
 * A #4 kézi napló és a felhasználó visszajelzése szerint a bulk filmlista
 * (get_vod_streams / get_series) gyakran NEM tartalmazza az évet és a
 * játékidőt, ezért a kártyákon és az adatlap fejlécében sem jelent meg.
 * Ez a modul EGYETLEN elemet kérdez le (get_vod_info / get_series_info) –
 * KIZÁRÓLAG akkor, ha az adott elemnél az adat tényleg hiányzik (év és
 * játékidő is 0, és nincs részletes szolgáltatói adat; sorozatnál üres
 * évadlista). Az eredményt összeolvasztja az elemmel, és tartósan elmenti
 * (saveCatalogExtras), így a következő megnyitás már mentésből, hálózat
 * nélkül jön.
 *
 * A segéd NEM a MoviesView/SeriesView forrásában él, hogy a meglévő
 * forrásvizsgáló tesztek (pl. test-vod-cached-detail.mjs) továbbra is
 * azt lássák: a nézet önmagában soha nem indít szolgáltatói kérést.
 */
export async function enrichVodItemOnOpen(
  kind: 'movie' | 'series',
  item: Movie | Series,
  provider: ProviderRef,
): Promise<Movie | Series | null> {
  if (provider.type !== 'xtream' || !provider.serverUrl) return null;
  const server = xtreamService.cleanUrl(provider.serverUrl);
  const user = (provider.username || '').trim();
  const pass = (provider.password || '').trim();
  if (!server || !user) return null;
  try {
    if (kind === 'movie') {
      const movie = item as Movie;
      if (movie.streamId === undefined) return null;
      const detail = await xtreamService.vodInfo(server, user, pass, movie.streamId);
      const merged = applyMovieMetadata(movie, parseVodMetadata(detail));
      await saveCatalogExtras(provider.id, [merged], []);
      appLog(`VOD-adatlap dúsítva megnyitáskor: „${movie.title}” – év: ${merged.year > 0 ? merged.year : 'nincs'}, játékidő: ${merged.durationMinutes} perc; tartósan elmentve.`);
      return merged;
    }
    const series = item as Series;
    const seriesId = series.seriesId ?? series.id;
    if (seriesId === undefined || seriesId === null || seriesId === '') return null;
    const detail = await xtreamService.seriesInfo(server, user, pass, seriesId);
    const merged = applySeriesMetadata(series, parseSeriesMetadata(detail));
    // Az évadok/epizódok is a részletes válaszból jönnek (ha még nincsenek mentve).
    const seasons = seasonsFromSeriesInfo(detail, merged, provider);
    if (seasons.length) {
      merged.seasons = seasons;
      merged.seasonsCount = seasons.length;
      merged.episodesCount = seasons.reduce((sum, season) => sum + season.episodes.length, 0);
    }
    await saveCatalogExtras(provider.id, [], [merged]);
    appLog(`Sorozat-adatlap dúsítva megnyitáskor: „${series.title}” – év: ${merged.year > 0 ? merged.year : 'nincs'}, játékidő: ${merged.durationMinutes} perc, ${merged.seasons.length} évad; tartósan elmentve.`);
    return merged;
  } catch (error) {
    // Egy sikertelen részletes lekérdezés nem zárja be az adatlapot – a
    // kártya egyszerűen a meglévő (hiányos) adatokkal marad.
    appLog(`VOD-adatlap dúsítási hiba („${item.title}”): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
