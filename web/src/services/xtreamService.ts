import { normalizeLogoUrl } from './logoUrl';
import { Channel } from '../types/iptv';
import { httpGetJson, httpGetText } from './net';

export interface XtreamUserInfo {
  username: string;
  password?: string;
  message?: string;
  auth: number;
  status: string;
  exp_date: string;
  is_trial: string;
  active_cons: string;
  created_at: string;
  max_connections: string;
}

export interface XtreamServerInfo {
  url: string;
  port: string;
  https_port: string;
  server_protocol: string;
  rtmp_port: string;
  timezone: string;
  timestamp_now: number;
  time_now: string;
}

export interface XtreamAuthResponse {
  user_info?: XtreamUserInfo;
  server_info?: XtreamServerInfo;
}

export interface XtreamCategory {
  category_id: string;
  category_name: string;
  parent_id?: number | string;
}

/** M3U-atribútum olvasása: kezeli a dupla/szimpla idézőjelet és az idézőjel nélküli értéket is. */
function readM3UAttribute(line: string, attribute: string): string {
  const match = line.match(new RegExp("\\b" + attribute + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s,]+))", "i"));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

export interface XtreamLiveStream {
  num?: number;
  name?: string;
  stream_id?: number | string;
  stream_icon?: string;
  category_id?: string | number;
  epg_channel_id?: string | null;
  tv_archive?: number;
}

export interface XtreamVodStream {
  num?: number;
  name?: string;
  stream_id?: number | string;
  stream_icon?: string;
  category_id?: string | number;
  container_extension?: string;
  rating?: string | number;
  rating_5based?: number;
  added?: string;
  plot?: string;
  duration?: string;
}

export interface XtreamSeriesItem {
  num?: number;
  name?: string;
  series_id?: number | string;
  cover?: string;
  category_id?: string | number;
  plot?: string;
  cast?: string;
  director?: string;
  genre?: string;
  releaseDate?: string;
  rating?: string | number;
  rating_5based?: number;
  last_modified?: string;
}

export interface XtreamEpisode {
  id?: string | number;
  episode_num?: number | string;
  title?: string;
  container_extension?: string;
  season?: number | string;
  info?: { plot?: string; duration?: string; movie_image?: string; releaseDate?: string };
}

export interface XtreamSeriesInfo {
  seasons?: Array<{ season_number?: number | string; name?: string; cover?: string; episode_count?: number | string }>;
  info?: { name?: string; cover?: string; plot?: string; cast?: string; director?: string; genre?: string; releaseDate?: string; rating?: string };
  episodes?: Record<string, XtreamEpisode[]>;
}

/** Az Xtream szerver válasza lista helyett néha üzenetet ad vissza. */
type ApiList<T> = T[] | { error?: string } | null;

function asArray<T>(value: ApiList<T>): T[] {
  if (Array.isArray(value)) return value;
  return [];
}

export const xtreamService = {
  // Normalize provider server URL (remove trailing slash)
  cleanUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
  },

  playerApiBase(serverUrl: string, username: string, password: string): string {
    const cleanServer = this.cleanUrl(serverUrl);
    const base = cleanServer.replace(/\/player_api\.php.*$/i, '').replace(/\/+$/, '');
    const host = /^https?:\/\//i.test(base) ? base : `http://${base}`;
    return `${host}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  },

  /** Xtream Codes bejelentkezés. Hibánál kivételt dob (nincs hamis siker). */
  async authenticate(serverUrl: string, username: string, password: string): Promise<XtreamAuthResponse> {
    const authUrl = this.playerApiBase(serverUrl, username, password);
    const data = await httpGetJson<XtreamAuthResponse & { user_info?: XtreamUserInfo }>(authUrl, {
      timeoutMs: 10000,
      // A bejelentkezés nem várhat a kéréssorban: ez dönti el, hogy a
      // szerver egyáltalán válaszol-e (lásd net.ts HttpOptions.bypassQueue).
      bypassQueue: true,
    });

    const info = data?.user_info;
    if (!info) {
      throw new Error(
        'A szerver nem Xtream API választ adott. Ellenőrizd a szerver címét (pl. http://szerver:8080).'
      );
    }
    if (String(info.auth) !== '1') {
      const reason = info.status || data?.user_info?.message || 'ismeretlen hiba';
      throw new Error(`A belépés nem sikerült: ${reason}. Ellenőrizd a felhasználónevet és a jelszót.`);
    }
    return data;
  },

  async liveCategories(serverUrl: string, username: string, password: string): Promise<XtreamCategory[]> {
    const url = `${this.playerApiBase(serverUrl, username, password)}&action=get_live_categories`;
    return asArray(await httpGetJson<ApiList<XtreamCategory>>(url));
  },

  async liveStreams(serverUrl: string, username: string, password: string): Promise<XtreamLiveStream[]> {
    const url = `${this.playerApiBase(serverUrl, username, password)}&action=get_live_streams`;
    // Élő lista nagy (20k csatorna ~7MB), adjunk neki több időt
    return asArray(await httpGetJson<ApiList<XtreamLiveStream>>(url, { timeoutMs: 45000 }));
  },

  async vodCategories(serverUrl: string, username: string, password: string): Promise<XtreamCategory[]> {
    const url = `${this.playerApiBase(serverUrl, username, password)}&action=get_vod_categories`;
    return asArray(await httpGetJson<ApiList<XtreamCategory>>(url));
  },

  async vodStreams(serverUrl: string, username: string, password: string, categoryId?: string | number): Promise<XtreamVodStream[]> {
    const category = categoryId !== undefined && categoryId !== null ? `&category_id=${encodeURIComponent(String(categoryId))}` : '';
    const url = `${this.playerApiBase(serverUrl, username, password)}&action=get_vod_streams${category}`;
    // Bulk (kategória nélkül) nagyobb JSON (40k film), több idő kell; kategóriánként marad 30s
    const timeoutMs = category ? 30000 : 60000;
    return asArray(await httpGetJson<ApiList<XtreamVodStream>>(url, { timeoutMs }));
  },

  async seriesCategories(serverUrl: string, username: string, password: string): Promise<XtreamCategory[]> {
    const url = `${this.playerApiBase(serverUrl, username, password)}&action=get_series_categories`;
    return asArray(await httpGetJson<ApiList<XtreamCategory>>(url));
  },

  async seriesList(serverUrl: string, username: string, password: string, categoryId?: string | number): Promise<XtreamSeriesItem[]> {
    const category = categoryId !== undefined && categoryId !== null ? `&category_id=${encodeURIComponent(String(categoryId))}` : '';
    const url = `${this.playerApiBase(serverUrl, username, password)}&action=get_series${category}`;
    const timeoutMs = category ? 30000 : 60000;
    return asArray(await httpGetJson<ApiList<XtreamSeriesItem>>(url, { timeoutMs }));
  },


  /** Rövid EPG egy élő csatornához. Az Xtream szerver a következő műsorokat adja vissza. */
  async shortEpg(
    serverUrl: string,
    username: string,
    password: string,
    streamId: number | string,
    limit = 10
  ): Promise<Array<{
    id?: string | number;
    title?: string;
    description?: string;
    start?: string;
    end?: string;
    start_timestamp?: number | string;
    stop_timestamp?: number | string;
    now_playing?: number;
  }>> {
    const url = `${this.playerApiBase(serverUrl, username, password)}&action=get_short_epg&stream_id=${encodeURIComponent(String(streamId))}&limit=${limit}`;
    const data = await httpGetJson<{ epg_listings?: Array<{
      id?: string | number;
      title?: string;
      description?: string;
      start?: string;
      end?: string;
      start_timestamp?: number | string;
      stop_timestamp?: number | string;
      now_playing?: number;
    }> }>(url, { timeoutMs: 10000 });
    return Array.isArray(data?.epg_listings) ? data.epg_listings : [];
  },

  async seriesInfo(
    serverUrl: string,
    username: string,
    password: string,
    seriesId: number | string
  ): Promise<XtreamSeriesInfo> {
    const url = `${this.playerApiBase(serverUrl, username, password)}&action=get_series_info&series_id=${encodeURIComponent(
      String(seriesId)
    )}`;
    return (await httpGetJson<XtreamSeriesInfo>(url, { timeoutMs: 20000 })) || {};
  },

  // Parse M3U playlist text content into Channels
  async parseM3U(
    m3uContent: string,
    onProgress: (percent: number) => void = () => {},
    sourceUrl?: string
  ): Promise<{ channels: Channel[]; categories: string[] }> {
    const lines = m3uContent.split(/\r?\n/);
    const totalLines = Math.max(lines.length, 1);
    const channels: Channel[] = [];
    const categoriesSet = new Set<string>();

    let currentChannel: Partial<Channel> = {};
    let channelNum = 10000;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if ((i & 2047) === 0) {
        onProgress(Math.min(98, Math.max(0, Math.round((i / totalLines) * 100))));
        // Nagy M3U/M3U8 listáknál ne foglaljuk le folyamatosan a TV böngésző
        // főszálát; így nem tűnik lefagyottnak a betöltés.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        // Extract tvg-id, tvg-name, tvg-logo, group-title, and channel name
        const tvgName = readM3UAttribute(line, 'tvg-name');
        const tvgLogo = readM3UAttribute(line, 'tvg-logo');
        const groupTitle = readM3UAttribute(line, 'group-title');
        const nameParts = line.split(',');
        const displayName = nameParts.length > 1 ? nameParts[nameParts.length - 1].trim() : (tvgName || 'Ismeretlen csatorna');
        const category = groupTitle || 'Egyéb csatornák';
        
        categoriesSet.add(category);
        channelNum++;

        // Detect country code / flag
        let flag = '📺';
        let country = 'Nemzetközi';
        let countryCode = 'INT';
        if (displayName.includes('[HU]') || displayName.startsWith('HU') || category.toLowerCase().includes('magyar') || category.toLowerCase().includes('hungary')) {
          flag = '🇭🇺';
          country = 'Magyarország';
          countryCode = 'HU';
        } else if (displayName.includes('[DE]') || category.toLowerCase().includes('germany') || category.toLowerCase().includes('német')) {
          flag = '🇩🇪';
          country = 'Németország';
          countryCode = 'DE';
        } else if (displayName.includes('[UK]') || displayName.includes('[GB]') || category.toLowerCase().includes('uk')) {
          flag = '🇬🇧';
          country = 'Egyesült Királyság';
          countryCode = 'GB';
        } else if (displayName.includes('[US]') || category.toLowerCase().includes('usa')) {
          flag = '🇺🇸';
          country = 'USA';
          countryCode = 'US';
        } else if (displayName.includes('[FR]') || category.toLowerCase().includes('france')) {
          flag = '🇫🇷';
          country = 'Franciaország';
          countryCode = 'FR';
        } else if (displayName.includes('[ES]') || category.toLowerCase().includes('spain')) {
          flag = '🇪🇸';
          country = 'Spanyolország';
          countryCode = 'ES';
        }

        currentChannel = {
          id: `chan-${channelNum}`,
          num: channelNum,
          name: displayName,
          logo: tvgLogo,
          categoryId: `cat-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          categoryName: category,
          country: country,
          countryCode: countryCode,
          flag: flag,
          resolution: '1920×1080',
          format: 'ts',
          isFavorite: false,
          orderIndex: channels.length,
          epgNow: { time: 'Élő', title: displayName },
        };
      } else if (line.startsWith('#EXTGRP:')) {
        const group = line.slice('#EXTGRP:'.length).trim();
        if (group) {
          categoriesSet.add(group);
          currentChannel.categoryName = group;
          currentChannel.categoryId = `cat-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        }
      } else if (!line.startsWith('#') && /^(https?|rtsp|rtmp|udp|mms):\/\//i.test(line)) {
        if (currentChannel.name) {
          // A stream URL után álló "|User-Agent=..." fejlécet levágjuk.
          currentChannel.streamUrl = line.split('|')[0].trim();
          currentChannel.logo = normalizeLogoUrl(currentChannel.logo, sourceUrl || currentChannel.streamUrl);
          channels.push(currentChannel as Channel);
          currentChannel = {};
        }
      }
    }

    return {
      channels,
      categories: Array.from(categoriesSet)
    };
  },

  // Generate Xtream Live Stream URL
  buildLiveStreamUrl(serverUrl: string, user: string, pass: string, streamId: number | string, format: 'ts' | 'm3u8' = 'ts'): string {
    const cleanServer = this.cleanUrl(serverUrl);
    if (format === 'm3u8') {
      return `${cleanServer}/live/${user}/${pass}/${streamId}.m3u8`;
    }
    return `${cleanServer}/live/${user}/${pass}/${streamId}.ts`;
  },

  // Generate Xtream Movie VOD Stream URL
  buildMovieStreamUrl(serverUrl: string, user: string, pass: string, streamId: number | string, ext: string = 'mp4'): string {
    const cleanServer = this.cleanUrl(serverUrl);
    return `${cleanServer}/movie/${user}/${pass}/${streamId}.${ext}`;
  },

  // Generate Xtream Series Episode Stream URL
  buildSeriesStreamUrl(serverUrl: string, user: string, pass: string, streamId: number | string, ext: string = 'mp4'): string {
    const cleanServer = this.cleanUrl(serverUrl);
    return `${cleanServer}/series/${user}/${pass}/${streamId}.${ext}`;
  },

  /**
   * A szolgáltató M3U listájának címe (Xtream `get.php`).
   *
   * Ez a második csatornabetöltési mód: ugyanaz a szolgáltató, ugyanaz a
   * belépés, csak nem a player_api.php JSON-t kérjük le, hanem a teljes
   * lejátszási listát.
   */
  buildPlaylistUrl(serverUrl: string, username: string, password: string): string {
    const cleanServer = this.cleanUrl(serverUrl).replace(/\/player_api\.php.*$/i, '').replace(/\/+$/, '');
    const host = /^https?:\/\//i.test(cleanServer) ? cleanServer : `http://${cleanServer}`;
    return `${host}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=m3u_plus&output=ts`;
  },

  /** Egyszerű M3U letöltés (URL-ről). */
  async loadM3U(url: string): Promise<string> {
    return httpGetText(url, { timeoutMs: 30000 });
  }
};
