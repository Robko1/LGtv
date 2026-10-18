import { AppSettings, FavoriteFolder, ProviderAccount, WatchHistoryItem } from '../types/iptv';
import { clearContent } from './contentStore';
import { INITIAL_SETTINGS } from '../data/mockData';

/*
 * Kis méretű, felhasználói beállítások tárolása (localStorage).
 *
 * A nagy tartalom (csatornák, filmek, sorozatok) NEM itt van: azt a
 * contentStore kezeli, az APK-ban a natív fájltárban, adagolva.
 * Az itteni kulcsok ezért szándékosan kicsik maradnak.
 */
const SETTINGS_KEY = 'iptv_rt_settings_v1';
const SUBTITLE_DEFAULT_MIGRATION_KEY = 'iptv_rt_subtitle_default_migrated_v1';
const PROVIDERS_KEY = 'iptv_rt_providers_v1';
const FOLDERS_KEY = 'iptv_rt_folders_v1';
const HISTORY_KEY = 'iptv_rt_history_v1';
const UI_STATE_KEY = 'iptv_rt_ui_state_v1';
// Régi (már nem használt) kulcsok: a gyorsítótár törlésekor ezeket is eltakarítjuk.
const LEGACY_KEYS = ['iptv_rt_channels_v1', 'iptv_rt_movies_v1', 'iptv_rt_series_v1'];

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
      // Utolsó csatorna indításkor mindig bekapcsolva, de nem látható a menüben
      settings.autoPlayLastChannel = true;
      // Képarány mindig fill (nyújtás), de nem látható a menüben – állóban 16:9 keret, fekvőben teljes
      if (!['contain', 'cover', 'fill'].includes(settings.aspectRatio)) {
        settings.aspectRatio = 'fill';
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
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(PROVIDERS_KEY);
    localStorage.removeItem(FOLDERS_KEY);
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(UI_STATE_KEY);
    for (const key of LEGACY_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* nem kritikus */
      }
    }
  },
};
