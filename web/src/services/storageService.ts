import { AppSettings, FavoriteFolder, ProviderAccount, WatchHistoryItem } from '../types/iptv';
import { clearFormatMemory } from './liveFormatMemory';
import { clearAudioMemory } from './liveAudioMemory';
import { clearTvDoctorMemory } from './tvDoctor';
import { clearTvDoctorCloudQueue } from './tvDoctorCloud';
import { clearAllContentAsync } from './contentStore';
import { INITIAL_SETTINGS } from '../data/mockData';
import { providerScopePrefix } from './providerScope';

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
/*
 * TÖRÖLT CSATORNÁK NYILVÁNTARTÁSA (2.5.228).
 *
 * A felhasználó panasza: a kézzel kitörölt csatornák a Frissítés gomb után
 * visszakerültek a listába. A törlés eddig csak a memóriabeli listából vette
 * ki a csatornát – a szolgáltató friss listája pedig újra tartalmazta.
 * Mostantól a törlés tartós jegyzékbe kerül (providerenként), és a friss
 * lista minden betöltési/frissítési ponton átmegy ezen a szűrőn.
 */
const DELETED_CHANNELS_PREFIX = 'iptv_rt_deleted_channels_v1_';
/** Biztonsági felső korlát, hogy a jegyzék sose nőhessen a localStorage kárára. */
const DELETED_CHANNELS_LIMIT = 5000;

/** Egy törölt csatorna ismertetőjegyei – a frissítés utáni biztos felismeréshez. */
export interface DeletedChannelMark {
  id: string;
  streamUrl?: string;
  /** `név (kisbetűs)|kategória` kulcs – ha az azonosító a frissítésben megváltozna. */
  nameKey?: string;
}

function channelOrderKey(providerId: string): string {
  return CHANNEL_ORDER_PREFIX + encodeURIComponent(providerId);
}

function deletedChannelsKey(providerId: string): string {
  return DELETED_CHANNELS_PREFIX + encodeURIComponent(providerId);
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
/*
 * SZOLGÁLTATÓNKÉNT KÜLÖN UTOLSÓ CSATORNA (2.5.417).
 *
 * Korábban egyetlen, közös kulcs volt, amit a szolgáltató-váltás ki is
 * törölt: visszaváltáskor a néző mindig az első magyar adón találta magát,
 * ráadásul két szolgáltató azonos stream-azonosítója miatt a program a MÁSIK
 * fiók „utolsó” csatornáját is elindíthatta. A kulcs mostantól a szolgáltató
 * névterében van (az első szolgáltatónál a régi kulcs marad érvényben), a
 * függő írás pedig megjegyzi, melyik szolgáltatóhoz tartozik.
 */
let pendingLastChannelKey: string | null = null;

function lastChannelKey(providerId?: string | null): string {
  return providerScopePrefix(providerId) + LAST_CHANNEL_KEY;
}

function flushLastChannel(): void {
  if (lastChannelTimer !== null) {
    window.clearTimeout(lastChannelTimer);
    lastChannelTimer = null;
  }
  const id = pendingLastChannelId;
  const key = pendingLastChannelKey;
  pendingLastChannelId = null;
  pendingLastChannelKey = null;
  if (!id || !key) return;
  try {
    localStorage.setItem(key, id);
  } catch {
    /* tároló nélkül is működik */
  }
}

/*
 * SZOLGÁLTATÓNKÉNTI LEJÁTSZÁSI / TV DOKTOR BEÁLLÍTÁSOK (2.5.417).
 *
 * A puffer-profil, a lejátszómotor, az élő formátum, a betöltési mód és a
 * TV Doktor kapcsoló szolgáltatófüggő: ami az egyik szolgáltatónál stabil,
 * a másiknál akadozhat. Ezeket szolgáltatónként külön jegyezzük meg; a többi
 * (óra, OSD, felirat, elrendezés) a készülékre vonatkozik, közös marad.
 */
const PROVIDER_SETTINGS_KEY = 'iptv_rt_provider_settings_v1';
export const PROVIDER_SCOPED_SETTING_KEYS = [
  'bufferMode', 'playerEngine', 'streamFormat', 'channelLoadMode', 'tvDoctorEnabled',
] as const;
export type ProviderScopedSettings = Partial<Pick<AppSettings, typeof PROVIDER_SCOPED_SETTING_KEYS[number]>>;

function pickProviderSettings(source: Partial<AppSettings> | null | undefined): ProviderScopedSettings {
  const out: Record<string, unknown> = {};
  if (!source) return out as ProviderScopedSettings;
  for (const key of PROVIDER_SCOPED_SETTING_KEYS) {
    const value = (source as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as ProviderScopedSettings;
}

export const storageService = {
  getSettings(): AppSettings {
    try {
      const data = localStorage.getItem(SETTINGS_KEY);
      const settings = data ? { ...INITIAL_SETTINGS, ...JSON.parse(data) } : { ...INITIAL_SETTINGS };
      // Régi, érintőképernyős csatornaváltás beállítása már nem használatos.
      delete settings.swipeToZap;
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
      // TV Doktor: alapértelmezetten bekapcsolva.
      if (typeof settings.tvDoctorEnabled !== 'boolean') {
        settings.tvDoctorEnabled = true;
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

  /**
   * Egy szolgáltató saját lejátszási / TV Doktor beállításai.
   * `null`, ha ehhez a szolgáltatóhoz még nem mentettünk semmit.
   */
  getProviderSettings(providerId: string | null | undefined): ProviderScopedSettings | null {
    const id = String(providerId || '').trim();
    if (!id) return null;
    try {
      const raw = localStorage.getItem(providerScopePrefix(id) + PROVIDER_SETTINGS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return pickProviderSettings(parsed as Partial<AppSettings>);
    } catch {
      return null;
    }
  },

  /** A szolgáltatófüggő beállítások mentése az adott szolgáltatóhoz. */
  saveProviderSettings(providerId: string | null | undefined, settings: Partial<AppSettings>): void {
    const id = String(providerId || '').trim();
    if (!id) return;
    try {
      localStorage.setItem(
        providerScopePrefix(id) + PROVIDER_SETTINGS_KEY,
        JSON.stringify(pickProviderSettings(settings)),
      );
    } catch {
      /* tároló nélkül is működik */
    }
  },

  /** Szolgáltató törlésekor a saját beállításai is törlődnek. */
  clearProviderSettings(providerId: string | null | undefined): void {
    const id = String(providerId || '').trim();
    if (!id) return;
    try {
      localStorage.removeItem(providerScopePrefix(id) + PROVIDER_SETTINGS_KEY);
    } catch {
      /* nem kritikus */
    }
  },

  /**
   * A közös beállításokra ráolvassa a szolgáltató saját értékeit.
   * Ha a szolgáltatónak még nincs saját mentése, a jelenlegi értékek maradnak.
   */
  applyProviderSettings(settings: AppSettings, providerId: string | null | undefined): AppSettings {
    const own = storageService.getProviderSettings(providerId);
    return own ? { ...settings, ...own } : settings;
  },

  /** Az utolsóként nézett csatorna (újraindításhoz) – szolgáltatónként külön. */
  getLastChannelId(providerId?: string | null): string {
    const key = lastChannelKey(providerId);
    // A még ki nem írt (függő) váltás is számít, ha ugyanehhez a szolgáltatóhoz tartozik.
    if (pendingLastChannelId && pendingLastChannelKey === key) return pendingLastChannelId;
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  },

  /**
   * Az utolsó csatorna mentése késleltetve, hogy a váltás azonnali legyen.
   * A csatornaváltás útjából kikerült minden szinkron tárolóírás.
   */
  rememberLastChannel(channelId: string, providerId?: string | null): void {
    const key = lastChannelKey(providerId);
    // Másik szolgáltató függő írása nem veszhet el és nem íródhat rossz helyre.
    if (pendingLastChannelKey && pendingLastChannelKey !== key) flushLastChannel();
    pendingLastChannelId = channelId;
    pendingLastChannelKey = key;
    if (lastChannelTimer !== null) return;
    lastChannelTimer = window.setTimeout(flushLastChannel, 800);
  },

  /** A függő „utolsó csatorna” írás azonnali kiírása (szolgáltató-váltás, kilépés előtt). */
  flushLastChannel(): void {
    flushLastChannel();
  },

  /**
   * Az utolsó csatorna törlése.
   *
   * A szolgáltató törlésekor a megjegyzett csatorna-azonosító is törlődik:
   * különben egy később hozzáadott (vagy újratöltött) szolgáltatónál ugyanaz
   * az azonosító véletlenül létezhet, és a program a régi – akár külföldi –
   * csatornát indítaná el az első magyar adó helyett.
   */
  clearLastChannel(providerId?: string | null): void {
    const key = lastChannelKey(providerId);
    if (pendingLastChannelKey === key) {
      pendingLastChannelId = null;
      pendingLastChannelKey = null;
      if (lastChannelTimer !== null) {
        window.clearTimeout(lastChannelTimer);
        lastChannelTimer = null;
      }
    }
    try {
      localStorage.removeItem(key);
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

  /** A kézzel törölt csatornák tartós jegyzéke (providerenként). */
  getDeletedChannels(providerId: string): DeletedChannelMark[] {
    try {
      const value = localStorage.getItem(deletedChannelsKey(providerId));
      const parsed = value ? JSON.parse(value) : [];
      return Array.isArray(parsed)
        ? parsed.filter((mark): mark is DeletedChannelMark => Boolean(mark) && typeof mark.id === 'string')
        : [];
    } catch {
      return [];
    }
  },

  /** Egy törölt csatorna feljegyzése – a Frissítés többé nem hozhatja vissza. */
  rememberDeletedChannel(providerId: string, mark: DeletedChannelMark): void {
    try {
      const current = storageService.getDeletedChannels(providerId);
      if (current.some((item) => item.id === mark.id)) return;
      const next = [...current, mark].slice(-DELETED_CHANNELS_LIMIT);
      localStorage.setItem(deletedChannelsKey(providerId), JSON.stringify(next));
    } catch (e) {
      console.error('Failed to save deleted channels:', e);
    }
  },

  /** A törölt csatornák jegyzékének ürítése (pl. a lista újbóli hozzáadásakor). */
  clearDeletedChannels(providerId: string): void {
    try {
      localStorage.removeItem(deletedChannelsKey(providerId));
    } catch {
      /* nem kritikus */
    }
  },

  getFolders(providerId?: string | null): FavoriteFolder[] {
    try {
      const key = providerScopePrefix(providerId) + FOLDERS_KEY;
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  saveFolders(folders: FavoriteFolder[], providerId?: string | null): void {
    try {
      const key = providerScopePrefix(providerId) + FOLDERS_KEY;
      localStorage.setItem(key, JSON.stringify(folders));
    } catch (e) {
      console.error('Failed to save folders:', e);
    }
  },

  getUiState(providerId?: string | null): { activeView?: 'live' | 'movies' | 'series'; selectedCategoryId?: string; isOnlyFavorites?: boolean; searchQuery?: string } {
    try {
      const key = providerScopePrefix(providerId) + UI_STATE_KEY;
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  },

  saveUiState(state: { activeView: 'live' | 'movies' | 'series'; selectedCategoryId: string; isOnlyFavorites: boolean; searchQuery: string }, providerId?: string | null): void {
    try {
      const key = providerScopePrefix(providerId) + UI_STATE_KEY;
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* nem kritikus */
    }
  },

  getHistory(providerId?: string | null): WatchHistoryItem[] {
    try {
      const key = providerScopePrefix(providerId) + HISTORY_KEY;
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  saveHistory(history: WatchHistoryItem[], providerId?: string | null): void {
    try {
      const key = providerScopePrefix(providerId) + HISTORY_KEY;
      localStorage.setItem(key, JSON.stringify(history));
    } catch (e) {
      console.error('Failed to save history:', e);
    }
  },

  /**
   * Gyorsítótár és minden mentett beállítás törlése (Menü → hibakeresés).
   * A visszaadott Promise az IndexedDB-ben lévő nagy listák törlésének
   * TÉNYLEGES végét jelzi – újratöltés előtt meg kell várni (2.5.239).
   */
  async clearCacheAsync(): Promise<void> {
    // TELJES visszaállítás: MINDEN szolgáltató mentett katalógusa törlődik.
    const contentCleared = clearAllContentAsync();
    pendingLastChannelId = null;
    pendingLastChannelKey = null;
    // A csatornánkénti formátum-emlékezet is a gyorsítótár része: törlés után
    // minden csatorna a beállított alapformátummal indul.
    clearFormatMemory();
    // A csatornánként mentett hangsávok is a gyorsítótár részei.
    clearAudioMemory();
    clearTvDoctorMemory();
    clearTvDoctorCloudQueue();
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(PROVIDERS_KEY);
    localStorage.removeItem(FOLDERS_KEY);
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(UI_STATE_KEY);
    try {
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (
          key?.startsWith(CHANNEL_ORDER_PREFIX)
          || key?.startsWith(DELETED_CHANNELS_PREFIX)
          || key === FOLDERS_KEY
          || key?.endsWith(`:${FOLDERS_KEY}`)
          || key === HISTORY_KEY
          || key?.endsWith(`:${HISTORY_KEY}`)
          || key === UI_STATE_KEY
          || key?.endsWith(`:${UI_STATE_KEY}`)
          || key === LAST_CHANNEL_KEY
          || key?.endsWith(`:${LAST_CHANNEL_KEY}`)
          || key === PROVIDER_SETTINGS_KEY
          || key?.endsWith(`:${PROVIDER_SETTINGS_KEY}`)
        ) localStorage.removeItem(key);
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
    // A nagy listák IndexedDB-törlésének tényleges vége.
    await contentCleared;
  },

  /** Régi hívók: azonnali (nem megvárt) törlés – új kódban a clearCacheAsync kell. */
  clearCache(): void {
    void this.clearCacheAsync();
  },
};
