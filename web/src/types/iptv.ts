export type BufferMode = 'fast' | 'balanced' | 'stable';
/**
 * Lejátszó motor.
 *  - 'html5'  : a beépített HTML5/HLS lejátszó (formátumváltás, zap-őr, teljes OSD)
 *  - 'native' : a TV hardveres dekóderére építő „natív” mód (közvetlen MPEG-TS,
 *               nincs automatikus formátumváltás, minimális felület a kép fölött)
 */
export type PlayerEngine = 'html5' | 'native';
export type AspectRatioMode = 'contain' | 'cover' | 'fill'; // 'Illesztés' | 'Kitöltés' | 'Nyújtás'
export type SubtitleSize = '75%' | '100%' | '125%' | '150%' | '200%';

export interface AudioTrack {
  id: number | string;
  name: string;
  lang: string;
  codec?: string;
  channels?: string;
  /** A lejátszó által visszaigazoltan aktív hangsáv. */
  selected?: boolean;
}

export interface SubtitleTrack {
  id: number | string;
  name: string;
  lang: string;
  /** A natív lejátszó által visszaigazoltan aktív feliratsáv. */
  selected?: boolean;
  url?: string;
}

export interface Channel {
  id: string;
  num: number;
  name: string;
  logo: string;
  streamUrl: string;
  /** Xtream stream azonosító (a stream URL-ből is kiolvasható, de így biztosan megvan). */
  streamId?: number;
  /** A szolgáltató EPG azonosítója (epg_channel_id) az EPG nézethez. */
  epgChannelId?: string | null;
  fallbackUrl?: string;
  categoryId: string;
  categoryName: string;
  country: string;
  countryCode: string;
  flag: string;
  resolution: string;
  format: 'ts' | 'm3u8' | 'mp4';
  epgNow?: {
    time: string;
    title: string;
    startTimestamp?: number;
    endTimestamp?: number;
  };
  epgNext?: {
    time: string;
    title: string;
  };
  isFavorite: boolean;
  orderIndex: number;
  audioTracks?: AudioTrack[];
  subtitleTracks?: SubtitleTrack[];
}

export interface Category {
  id: string;
  name: string;
  flag?: string;
  icon?: string;
  channelCount: number;
  subCategoryCount: number;
  type: 'live' | 'movie' | 'series';
}

export interface Movie {
  id: string;
  streamId?: number;
  title: string;
  categoryId: string;
  categoryName: string;
  poster: string;
  backdrop?: string;
  rating: number;
  year: number;
  durationMinutes: number;
  plot: string;
  genres: string[];
  director?: string;
  cast?: string[];
  streamUrl: string;
  containerExtension?: string;
  audioTracks?: AudioTrack[];
  subtitleTracks?: SubtitleTrack[];
  isFavorite?: boolean;
  resumePositionSeconds?: number;
}

export interface Episode {
  id: string;
  episodeNumber: number;
  seasonNumber: number;
  title: string;
  durationMinutes: number;
  streamUrl: string;
  plot: string;
  thumbnail: string;
  audioTracks?: AudioTrack[];
  subtitleTracks?: SubtitleTrack[];
  watched?: boolean;
  resumePositionSeconds?: number;
}

export interface Season {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  episodes: Episode[];
}

export interface Series {
  id: string;
  seriesId?: number;
  title: string;
  categoryId: string;
  categoryName: string;
  poster: string;
  backdrop?: string;
  rating: number;
  year: number;
  seasonsCount: number;
  episodesCount: number;
  plot: string;
  genres: string[];
  director?: string;
  cast?: string[];
  seasons: Season[];
  isFavorite?: boolean;
}

export interface ProviderAccount {
  id: string;
  name: string;
  type: 'xtream' | 'm3u';
  serverUrl?: string;
  username?: string;
  password?: string;
  m3uUrl?: string;
  isActive: boolean;
  status: 'active' | 'expired' | 'error' | 'loading';
  channelsCount: number;
  moviesCount: number;
  seriesCount: number;
  lastUpdated: string;
  expireDate: string;
  maxConnections: number;
}

export interface FavoriteFolder {
  id: string;
  name: string;
  icon?: string;
  channelIds: string[];
}

export interface AppSettings {
  bufferMode: BufferMode;
  /** Lejátszómotor a Rendszer menüből; a választás mentésre kerül. */
  playerEngine: PlayerEngine;
  zappingDelay: number; // 0, 200, 350, 600 ms
  /**
   * Óra eltolása órában (-12 … +12).
   *
   * A webOS TV böngészőmotorja néha a TV beállított időzónája helyett UTC-t ad
   * vissza (Írországban ez pontosan 1 óra eltérés nyáron). Ezzel a beállítással
   * a felület órája a valós helyi időt mutatja; 0 = a készülék órája.
   */
  clockOffsetHours: number;
  autoPlayLastChannel: boolean;
  closeListOnZap: boolean;
  swipeToZap: boolean;
  alwaysShowBlueClock: boolean;
  osdHideDelay: number; // 2, 3, 4, 5 másodperc
  aspectRatio: AspectRatioMode;
  seekStep: number; // 5, 10, 15, 30
  autoNextEpisode: boolean;
  preferredAudioLang: string; // 'Magyar', 'Angol', 'Német', etc.
  preferredSubtitle: string; // 'Kikapcsolva', 'Magyar', 'Angol'
  subtitleSize: SubtitleSize;
  activeProviderId: string;
  lastPlayedChannelId?: string;
  corsProxy: string;
}

export interface WatchHistoryItem {
  id: string;
  mediaType: 'live' | 'movie' | 'series';
  title: string;
  subtitle?: string;
  poster?: string;
  channelNum?: number;
  progressPercent: number;
  positionSeconds: number;
  durationSeconds: number;
  lastWatchedAt: string;
  streamUrl: string;
  seriesId?: string;
  episodeId?: string;
}
