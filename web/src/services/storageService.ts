import { AppSettings, FavoriteFolder, ProviderAccount, WatchHistoryItem } from '../types/iptv';
import { clearFormatMemory } from './liveFormatMemory';
import { clearContent } from './contentStore';
import { INITIAL_SETTINGS } from '../data/mockData';

/*
 * Kis méretű, felhasználói beállítások tárolása (localStorage).
 *
 * A nagy tartalom (csatornák, filmek, sorozatok) NEM itt van: azt a
 * contentStore kezeli, a TV helyi tárában, adagolva.
 * Az itteni kulcsok ezért szándékosan kicsik maradnak.
 */
const SETTINGS_KEY = 'iptv_rt_settings_v1';
const SUBTITLE_DEFAULT_MIGRATION_KEY = 'iptv_rt_subtitle_default_migrated_v1';
const PROVIDERS_KEY = 'iptv_rt_providers_v1';
const FOLDERS_KEY = 'iptv_rt_folders_v1';
const HISTORY_KEY = 'iptv_rt_history_v1';
const UI_STATE_KEY = 'iptv_rt_ui_state_v1';
const CHANNEL_ORDER_PREFIX = 'iptv_rt_channel_order_v1_';

function channelOrderKey(providerId: string): string {
  return CHANNEL_ORDER_PREFIX + encodeURIComponent(providerId);
}

// Régi (már nem használt) kulcsok: a gyorsítótár törlésekor ezeket is eltakarítjuk.
const LEGACY_KEYS = ['iptv_rt_channels_v1', 'iptv_rt_movies_v1', 'iptv_rt_series_v1'];

/**
 * Az utolsóként nézett csatorna azonosítója.
 *
 * SZÁNDÉKOSAN külön kulcs: a csatornaváltás így NEM írja újra a teljes
 * beállítás-objektumot (sem a React állapotot) - a TV lassú tárolóján ez
 * éppen a váltás pillanatában blokkolt. Az írás 800 ms-mal később, egyszer
 * történik; a felület azonnal vált.
 */
const LAST_CHANNEL_KEY = 'iptv_rt_last_channel_v1';
let lastChannelTimer: number | null = null;
let pendingLastChannelId: string | null = null;

function flushLastChannel(): void {
  lastChannelTimer = null;
  const id = pendingLastChannelId;
  pendingLastChannelId = null;
  if (!id) return;
  try {
    localStorage.setItem(LAST_CHANNEL_KEY, id);
  } catch {
    /* tároló nélkül is működik */
  }
}

export const storageService = {
  getSettings(): AppSettings {
    try {
      const data = localStorage.getItem(SETTINGS_KEY);
      const settings = data ? { ...INITIAL_SETTINGS, ...JSON.parse(data) } : { ...INITIAL_SETTINGS };
      // A korábbi verzió alapértelmezése a kikapcsolt felirat volt.
      // Egyszer átállítjuk Magyarra; a később kézzel kiválasztott beállítást megtartjuk.
      if (!localStorage.getItem(SUBTITLE_DEFAULT_MIGRATION_KEY)) {
        if (settings.preferredSubtitle === 'Kikapcsolva') {
          settings.preferredSubtitle = 'Magyar';
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        }
        localStorage.setItem(SUBTITLE_DEFAULT_MIGRATION_KEY, '1');
      }
      // A csatornaváltás ne várjon külön késleltetésre.
      settings.zappingDelay = 0;
      // Utolsó csatorna indításkor mindig bekapcsolva, de nem látható a menüben
      settings.autoPlayLastChannel = true;
      // Képarány mindig fill (nyújtás), de nem látható a menüben – állóban 16:9 keret, fekvőben teljes
      if (!['contain', 'cover', 'fill'].includes(settings.aspectRatio)) {
        settings.aspectRatio = 'fill';
      }
      /*
       * OSD-eltűnés: a megengedett értékek 6 / 8 / 10 / 12 másodperc
       * (0 = soha). A korábbi mentésekben 2–5 szerepelhetett – a legközelebbi
       * engedélyezett értékre kerekítjük, hogy a teljes képernyős OSD is
       * ugyanazt használja, mint a főoldali.
       */
      const OSD_CHOICES = [6, 8, 10, 12];
      const osdDelay = Number(settings.osdHideDelay);
      if (!Number.isFinite(osdDelay) || osdDelay < 0) {
        settings.osdHideDelay = 8;
      } else if (osdDelay > 0 && !OSD_CHOICES.includes(osdDelay)) {
        settings.osdHideDelay = OSD_CHOICES.reduce((best, choice) =>
          Math.abs(choice - osdDelay) < Math.abs(best - osdDelay) ? choice : best, OSD_CHOICES[0]);
      }
      if (typeof settings.mirrorLayout !== 'boolean') settings.mirrorLayout = false;
      // Film/sorozat alap hangsáv-nyelve: régi mentésben hiányozhat – alapból magyar.
      if (!settings.preferredAudioLang) settings.preferredAudioLang = 'Magyar';
      if (!settings.preferredSubtitle) settings.preferredSubtitle = 'Magyar';
      // Csatornabetöltés módja: régi mentésekben még nincs - alapértelmezés API.
      if (settings.channelLoadMode !== 'api' && settings.channelLoadMode !== 'm3u') {
        settings.channelLoadMode = 'api';
      }
      // Lejátszómotor: régi mentésekben még nincs - alapértelmezés HTML5.
      if (settings.playerEngine !== 'html5' && settings.playerEngine !== 'native') {
        settings.playerEngine = 'html5';
      }
      return settings;
    } catch {
      return INITIAL_SETTINGS;
    }
  },

  saveSettings(settings: AppSettings): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  },

  /** Az utolsóként nézett csatorna (újraindításhoz). */
  getLastChannelId(): string {
    try {
      return localStorage.getItem(LAST_CHANNEL_KEY) || '';
    } catch {
      return '';
    }
  },

  /**
   * Az utolsó csatorna mentése késleltetve, hogy a váltás azonnali legyen.
   * A csatornaváltás útjából kikerült minden szinkron tárolóírás.
   */
  rememberLastChannel(channelId: string): void {
    pendingLastChannelId = channelId;
    if (lastChannelTimer !== null) return;
    lastChannelTimer = window.setTimeout(flushLastChannel, 800);
  },

  /**
   * Az utolsó csatorna törlése.
   *
   * A szolgáltató törlésekor a megjegyzett csatorna-azonosító is törlődik:
   * különben egy később hozzáadott (vagy újratöltött) szolgáltatónál ugyanaz
   * az azonosító véletlenül létezhet, és a program a régi – akár külföldi –
   * csatornát indítaná el az első magyar adó helyett.
   */
  clearLastChannel(): void {
    pendingLastChannelId = null;
    if (lastChannelTimer !== null) {
      window.clearTimeout(lastChannelTimer);
      lastChannelTimer = null;
    }
    try {
      localStorage.removeItem(LAST_CHANNEL_KEY);
    } catch {
      /* tároló nélkül is működik */
    }
  },

  getProviders(): ProviderAccount[] {
    try {
      const data = localStorage.getItem(PROVIDERS_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  saveProviders(providers: ProviderAccount[]): void {
    try {
      localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers));
    } catch (e) {
      console.error('Failed to save providers:', e);
    }
  },

  /** Kézi csatornasorrend mentése providerenként; az app frissítése nem törli a localStorage-t. */
  getChannelOrder(providerId: string): string[] {
    try {
      const value = localStorage.getItem(channelOrderKey(providerId));
      const parsed = value ? JSON.parse(value) : [];
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  },

  saveChannelOrder(providerId: string, channelIds: string[]): void {
    try {
      localStorage.setItem(channelOrderKey(providerId), JSON.stringify(channelIds));
    } catch (e) {
      console.error('Failed to save channel order:', e);
    }
  },

  clearChannelOrder(providerId: string): void {
    try {
      localStorage.removeItem(channelOrderKey(providerId));
    } catch {
      /* nem kritikus */
    }
  },

  getFolders(): FavoriteFolder[] {
    try {
      const data = localStorage.getItem(FOLDERS_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  saveFolders(folders: FavoriteFolder[]): void {
    try {
      localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
    } catch (e) {
      console.error('Failed to save folders:', e);
    }
  },

  getUiState(): { activeView?: 'live' | 'movies' | 'series'; selectedCategoryId?: string; isOnlyFavorites?: boolean; searchQuery?: string } {
    try {
      const data = localStorage.getItem(UI_STATE_KEY);
      return data ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  },

  saveUiState(state: { activeView: 'live' | 'movies' | 'series'; selectedCategoryId: string; isOnlyFavorites: boolean; searchQuery: string }): void {
    try {
      localStorage.setItem(UI_STATE_KEY, JSON.stringify(state));
    } catch {
      /* nem kritikus */
    }
  },

  getHistory(): WatchHistoryItem[] {
    try {
      const data = localStorage.getItem(HISTORY_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  saveHistory(history: WatchHistoryItem[]): void {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
      console.error('Failed to save history:', e);
    }
  },

  /** Gyorsítótár és minden mentett beállítás törlése (Menü → hibakeresés). */
  clearCache(): void {
    clearContent();
    // A csatornánkénti formátum-emlékezet is a gyorsítótár része: törlés után
    // minden csatorna a beállított alapformátummal indul.
    clearFormatMemory();
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(PROVIDERS_KEY);
    localStorage.removeItem(FOLDERS_KEY);
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(UI_STATE_KEY);
    try {
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key?.startsWith(CHANNEL_ORDER_PREFIX)) localStorage.removeItem(key);
      }
    } catch {
      /* nem kritikus */
    }
    for (const key of LEGACY_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* nem kritikus */
      }
    }
  },
};
