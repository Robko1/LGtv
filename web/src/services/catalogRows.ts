import { Category, Episode, ProviderPayload, Season, Series } from '../types/iptv';
import { ProviderRef, decodeChannelsForImport, decodeMoviesForImport, decodeSeriesForImport } from './contentStore';
import { parseEpisodeMetadata, parseSeriesMetadata, parseVodMetadata } from './vodMetadata';
import { xtreamService, XtreamEpisode, XtreamSeriesInfo } from './xtreamService';
import { flagFor } from '../utils/flags';
import { normalizeLogoUrl } from './logoUrl';

export type CatalogRow = Array<string | number>;

function payload(value: unknown): ProviderPayload | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ProviderPayload : undefined;
}

/** A lista-válasz minden mezőjét megőrizzük; a normalizált mezők csak gyors megjelenítést adnak. */
export function movieRowFromRaw(
  raw: Record<string, unknown>,
  category: { id: string; name: string },
): CatalogRow {
  const meta = parseVodMetadata(raw);
  return [
    String(raw.stream_id ?? ''),
    String(raw.name || 'Film').trim(),
    category.id,
    category.name,
    meta.poster || String(raw.stream_icon || ''),
    meta.rating || 0,
    meta.year || 0,
    String(raw.container_extension || 'mp4'),
    meta.plot || '',
    0,
    meta.durationMinutes || 0,
    JSON.stringify(meta.audioLanguages || []),
    JSON.stringify(meta.subtitleLanguages || []),
    JSON.stringify(meta.audioTracks || []),
    JSON.stringify(meta.subtitleTracks || []),
    meta.backdrop || '',
    JSON.stringify(meta.genres || []),
    meta.director || '',
    JSON.stringify(meta.cast || []),
    JSON.stringify(payload(raw) || {}),
    '',
  ];
}

export function seriesRowFromRaw(
  raw: Record<string, unknown>,
  category: { id: string; name: string },
): CatalogRow {
  const meta = parseSeriesMetadata(raw);
  const backdrops = Array.isArray(raw.backdrop_path) ? raw.backdrop_path : [];
  return [
    String(raw.series_id ?? ''),
    String(raw.name || 'Sorozat').trim(),
    category.id,
    category.name,
    meta.poster || String(raw.cover || ''),
    meta.rating || 0,
    meta.year || 0,
    meta.plot || '',
    0,
    0,
    0,
    meta.durationMinutes || 0,
    JSON.stringify(meta.audioLanguages || []),
    JSON.stringify(meta.subtitleLanguages || []),
    JSON.stringify(meta.audioTracks || []),
    JSON.stringify(meta.subtitleTracks || []),
    meta.backdrop || String(backdrops[0] || ''),
    JSON.stringify(meta.genres || []),
    meta.director || '',
    JSON.stringify(meta.cast || []),
    JSON.stringify(payload(raw) || {}),
    '',
    '[]',
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
    JSON.stringify(payload(raw) || {}),
    String(raw.stream_id ?? ''),
  ];
}

export const decodeMovieRows = decodeMoviesForImport;
export const decodeSeriesRows = decodeSeriesForImport;
export const decodeLiveRows = decodeChannelsForImport;

/** Evadok/reszek teljes megőrzése: a lejátszáshoz URL, az adatlaphoz minden nyers mező. */
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
        const metadata = parseEpisodeMetadata(episode);
        const info = episode.info || {};
        return {
          id: `ep-${series.id}-${episode.id ?? index}`,
          episodeNumber: Number(episode.episode_num ?? index + 1),
          seasonNumber: Number(episode.season ?? seasonKey),
          title: String(episode.title || `${index + 1}. rész`),
          durationMinutes: metadata.durationMinutes || 0,
          streamUrl: xtreamService.buildSeriesStreamUrl(
            provider.serverUrl || '', provider.username || '', provider.password || '',
            episode.id ?? '', episode.container_extension || 'mp4',
          ),
          plot: metadata.plot || String(info.plot || ''),
          thumbnail: metadata.poster || String(info.movie_image || series.poster || ''),
          audioTracks: metadata.audioTracks,
          subtitleTracks: metadata.subtitleTracks,
          audioLanguages: metadata.audioLanguages,
          subtitleLanguages: metadata.subtitleLanguages,
          providerData: payload(episode),
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
