import { Category, Episode, Season, Series } from '../types/iptv';
import { ProviderRef } from './contentStore';
import { parseEpisodeRuntimeMinutes, parseSeriesMetadata, parseMovieCatalogMetadata } from './vodMetadata';
import { xtreamService, XtreamEpisode, XtreamSeriesInfo } from './xtreamService';
import { flagFor } from '../utils/flags';
import { normalizeLogoUrl } from './logoUrl';

export type CatalogRow = Array<string | number>;

/**
 * Gyors, kicsi ujjlenyomat egy nyers lista-elemről (FNV-1a hash).
 *
 * KORÁBBAN a teljes nyers szolgáltatói objektum (providerData) minden egyes
 * elemhez hozzá volt fűzve és a tárolóba is kiíródott. 102 824 filmnél és
 * 24 977 sorozatnál ez több tíz MB felesleges JSON-t jelentett a memóriában
 * ÉS az IndexedDB-ben: a TV emiatt fogyott ki a memóriából (a Mozi/Sorozat
 * nézet görgetés közben 0 darabra esett), a visszatöltés és a frissítés
 * pedig percekig tartott. A változás-összevetéshez NEM kell a teljes nyers
 * objektum – elég ez a néhány bájtos ujjlenyomat.
 */
export function rawItemSignature(raw: unknown): string {
  /*
   * 2.5.245 – GYORSÍTÁS: korábban itt a TELJES nyers objektumot
   * JSON.stringify-oltuk (150 000 filmnél ez elemenként több KB string +
   * teljes bejárás = az első import egyik leglassabb lépése). Most csak a
   * változás-összevetéshez releváns mezőket olvassuk ki közvetlenül, és
   * FNV-1a hash-sel ujjlenyomatot képezünk belőlük – a hosszú szöveges mezők
   * (plot, leírás, szereplők) helyett csak a hosszukat keverjük be (O(1)).
   * A tárolt formátum (string) változatlan; a képlet egyszeri megváltozása
   * miatt a következő frissítés egyszer minden elemet „megváltozottnak” lát,
   * de a különbség-számláló felső határa ezt korlátozza.
   */
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  let hash = 2166136261;
  for (let index = 0; index < SIGNATURE_SHORT_KEYS.length; index++) {
    const key = SIGNATURE_SHORT_KEYS[index];
    if (key in record) {
      const value = String(record[key]);
      for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      hash ^= 59; // mezőelválasztó
      hash = Math.imul(hash, 16777619);
    }
  }
  for (let index = 0; index < SIGNATURE_LONG_KEYS.length; index++) {
    const value = record[SIGNATURE_LONG_KEYS[index]];
    if (typeof value === 'string' && value) {
      const len = String(value.length);
      for (let i = 0; i < len.length; i++) {
        hash ^= len.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      hash ^= 59;
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(36);
}

/** Ujjlenyomathoz használt rövid mezők (értékük számít). */
const SIGNATURE_SHORT_KEYS = [
  'stream_id', 'series_id', 'name', 'category_id', 'category_name', 'category_ids',
  'stream_icon', 'stream_type', 'container_extension', 'poster', 'cover', 'cover_image',
  'backdrop_path', 'rating', 'rating_5based', 'year', 'release_date', 'releaseDate',
  'added', 'last_modified', 'tmdb_id', 'youtube_trailer', 'episode_run_time',
  'duration_secs', 'bitrate', 'group_title', 'custom_sid', 'epg_channel_id', 'num',
];

/** Hosszú szöveges mezők: csak a hosszuk számít az ujjlenyomatba (O(1)). */
const SIGNATURE_LONG_KEYS = ['plot', 'description', 'cast', 'director', 'crew', 'actors', 'genre', 'info', 'about', 'notes'];

/** A lista-válasz minden mezőjét megőrizzük; a normalizált mezők csak gyors megjelenítést adnak. */
export function movieRowFromRaw(
  raw: Record<string, unknown>,
  category: { id: string; name: string },
): CatalogRow {
  const meta = parseMovieCatalogMetadata(raw);
  return [
    String(raw.stream_id ?? ''),
    String(raw.name || 'Film').trim(),
    category.id,
    category.name,
    meta.poster || String(raw.stream_icon || ''),
    0, // értékelés nem szükséges a filmkatalógus importjához
    meta.year || 0,
    String(raw.container_extension || 'mp4'),
    '', // tartalom/leírás nem szükséges
    0,
    meta.durationMinutes || 0,
    '[]', // hangsávok csak külön, lejátszáskor kérhetők
    '[]', // feliratok csak külön, lejátszáskor kérhetők
    '[]',
    '[]',
    meta.backdrop || '', // háttérkép
    '[]', // műfaj nem szükséges
    '', // rendező nem szükséges
    '[]', // szereplők nem szükséges
    // providerData NEM kerül minden elemre: a részletes nyers adat a
    // megnyitáskor/előreolvasáskor letöltött detailProviderData-ban él.
    '',
    '',
    rawItemSignature(raw),
  ];
}

export function seriesRowFromRaw(raw: Record<string, unknown>, category: { id: string; name: string } = { id: 'sc-other', name: 'Egyéb' }): CatalogRow {
  const meta = parseSeriesMetadata(raw);
  const backdrops = Array.isArray(raw.backdrop_path) ? raw.backdrop_path : [];
  return [
    String(raw.series_id ?? ''),
    String(raw.name || 'Sorozat').trim(),
    category.id,
    category.name,
    meta.poster || String(raw.cover || ''),
    0,
    meta.year || 0,
    '',
    0,
    0,
    0,
    meta.durationMinutes || 0,
    '[]',
    '[]',
    '[]',
    '[]',
    meta.backdrop || String(backdrops[0] || ''),
    '[]',
    '',
    '[]',
    '',
    '',
    '[]',
    rawItemSignature(raw),
  ];
}

export function liveRowFromRaw(
  raw: Record<string, unknown>,
  category: { id: string; name: string },
  index: number,
  provider: ProviderRef,
): CatalogRow {
  const name = String(raw.name || 'Csatorna').trim();
  const info = flagFor(category.name || name);
  return [
    Number(raw.num ?? index + 1),
    name,
    normalizeLogoUrl(raw.stream_icon, xtreamService.playerApiBase(provider.serverUrl || '', '', '')),
    category.id,
    category.name,
    String(raw.stream_id ?? ''),
    info.flag,
    info.countryCode,
    String(raw.epg_channel_id || ''),
    // providerData helyett csak a kicsi ujjlenyomat (lásd rawItemSignature).
    '',
    String(raw.stream_id ?? ''),
    rawItemSignature(raw),
  ];
}

/** Évadok és epizódok: csak a lejátszáshoz és megjelenítéshez szükséges adatok. */
export function seasonsFromSeriesInfo(
  response: XtreamSeriesInfo,
  series: Series,
  provider: ProviderRef,
): Season[] {
  const episodesBySeason = response.episodes || {};
  return Object.keys(episodesBySeason)
    .sort((a, b) => Number(a) - Number(b))
    .map((seasonKey) => {
      const rows = Array.isArray(episodesBySeason[seasonKey]) ? episodesBySeason[seasonKey] : [];
      const episodes: Episode[] = rows.map((episode: XtreamEpisode, index: number) => {
        const containerExtension = String(episode.container_extension || 'mp4');
        const durationMinutes = parseEpisodeRuntimeMinutes(episode.info || episode);
        return {
          id: `ep-${series.id}-${episode.id ?? index}`,
          episodeId: episode.id ?? '',
          episodeNumber: Number(episode.episode_num ?? index + 1),
          seasonNumber: Number(episode.season ?? seasonKey),
          title: String(episode.title || `${index + 1}. rész`),
          durationMinutes,
          streamUrl: xtreamService.buildSeriesStreamUrl(
            provider.serverUrl || '', provider.username || '', provider.password || '',
            episode.id ?? '', containerExtension,
          ),
          containerExtension,
          plot: '',
          thumbnail: series.poster || '',
        };
      });
      return {
        seasonNumber: Number(seasonKey),
        name: `${seasonKey}. évad`,
        episodeCount: episodes.length,
        episodes,
      };
    })
    .filter((season) => season.episodes.length > 0);
}

export function categoryCounts<T extends { categoryId: string }>(
  items: T[],
  categories: Category[],
  type: Category['type'],
): Category[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.categoryId, (counts.get(item.categoryId) || 0) + 1);
  const known = new Map(categories.map((category) => [category.id, category]));
  const result: Category[] = [];
  for (const [id, count] of counts) {
    const old = known.get(id);
    result.push({
      id,
      name: old?.name || id,
      flag: type === 'live' ? flagFor(old?.name || '').flag : type === 'movie' ? '🎬' : '📺',
      channelCount: count,
      subCategoryCount: 0,
      type,
    });
  }
  return result;
}
