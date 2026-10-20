import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { AppSettings, AudioTrack, SubtitleTrack, Category, Channel, Episode, FavoriteFolder, Movie, ProviderAccount, Season, Series, WatchHistoryItem } from './types/iptv';
import { storageService } from './services/storageService';
import {
  clearContent,
  ImportedContent,
  loadLive,
  loadSeriesAsync,
  loadVodAsync,
  ProviderRef,
  saveContent,
  saveLiveContent,
  saveSeriesContent,
  saveVodContent,
} from './services/contentStore';
import { appLog, appLogError, logMemory, logStartup } from './services/appLog';
import { normalizeTvKey, isTvArrowKey } from './utils/tvKeys';
import { PartialContent, refreshProviderContent } from './services/providerImport';
import { clearEpgCache, getCachedShortEpg, loadShortEpg, nowNextFromEpg, streamIdFor } from './services/epgService';
import { xtreamService } from './services/xtreamService';

// Induláskor a korábban betöltött szolgáltatói lista töltődik be. Demó adat
// helyett üres listát mutatunk, és a felület felhívja a figyelmet a lista
// hozzáadására (Menü → Listák).
const bootLive = loadLive();
// A betöltött tár régi vagy sérült adatait már az állapot létrehozásakor normalizáljuk.
const bootChannels = Array.isArray(bootLive.channels) ? bootLive.channels : [];

function preserveChannelPreferences(incoming: Channel[], existing: Channel[]): Channel[] {
  // FONTOS (a telefon lefagyásának javítása): a keresőtáblákat EGYETLEN
  // végigmenetel építi fel. Korábban a stream-URL tábla `existing.indexOf(channel)`
  // hívással készült, ami négyzetszerű (O(n²)) futásidőt okozott: 20 000
  // csatornánál már másodpercekre, 60 000-nél percekre fagyasztotta a felületet
  // minden frissítés alkalmával.
  const byId = new Map<string, { channel: Channel; index: number }>();
  const byStream = new Map<string, { channel: Channel; index: number }>();
  const byNameCategory = new Map<string, { channel: Channel; index: number }>();
  for (let index = 0; index < existing.length; index++) {
    const channel = existing[index];
    byId.set(channel.id, { channel, index });
    if (channel.streamUrl) byStream.set(channel.streamUrl, { channel, index });
    byNameCategory.set(`${channel.name.trim().toLowerCase()}|${channel.categoryId}`, { channel, index });
  }
  const usedIds = new Set<string>();

  return incoming
    .map((channel, incomingIndex) => {
      const match =
        byId.get(channel.id) ||
        (channel.streamUrl ? byStream.get(channel.streamUrl) : undefined) ||
        byNameCategory.get(`${channel.name.trim().toLowerCase()}|${channel.categoryId}`);
      if (!match || usedIds.has(match.channel.id)) {
        return { channel, previousIndex: Number.MAX_SAFE_INTEGER, incomingIndex };
      }
      usedIds.add(match.channel.id);
      return {
        channel: {
          ...channel,
          // A stabil azonosító megtartása miatt a mappák tagsága sem vész el frissítéskor.
          id: match.channel.id,
          orderIndex: match.channel.orderIndex,
          isFavorite: match.channel.isFavorite,
        },
        previousIndex: match.index,
        incomingIndex,
      };
    })
    // A már meglévő csatornák megtartják a felhasználó sorrendjét; az új csatornák a végére kerülnek.
    .sort((a, b) => a.previousIndex - b.previousIndex || a.incomingIndex - b.incomingIndex)
    .map(({ channel }) => channel);
}

function buildCountryCategories(channels: Channel[]): Category[] {
  const grouped = new Map<string, { name: string; flag: string; channelCount: number; subCategories: Set<string> }>();
  for (const channel of channels) {
    const code = (channel.countryCode || 'INT').toUpperCase();
    const current = grouped.get(code) || {
      name: channel.country || 'Nemzetközi',
      flag: channel.flag || '📺',
      channelCount: 0,
      subCategories: new Set<string>(),
    };
    current.channelCount += 1;
    if (channel.categoryId) current.subCategories.add(channel.categoryId);
    if (code === 'HU') {
      current.name = 'Magyarország';
      current.flag = '🇭🇺';
    }
    grouped.set(code, current);
  }
  return Array.from(grouped.entries())
    .map(([code, item]) => ({
      id: `country-${code}`,
      name: item.name,
      flag: item.flag,
      channelCount: item.channelCount,
      subCategoryCount: item.subCategories.size,
      type: 'live' as const,
    }))
    .sort((a, b) => (a.id === 'country-HU' ? -1 : b.id === 'country-HU' ? 1 : a.name.localeCompare(b.name)));
}

function findHungaryCategoryId(categories: Category[]): string | undefined {
  return categories.find((category) =>
    category.id === 'country-HU' ||
    category.flag === '🇭🇺' ||
    /\b(magyarország|magyar|hungary|hungarian)\b/i.test(category.name)
  )?.id;
}

function hungaryFirst(list: Channel[]): Channel[] {
  return list
    .map((channel, index) => ({ channel, index }))
    .sort((a, b) => {
      const isHungary = (channel: Channel) =>
        channel.countryCode?.toUpperCase() === 'HU' ||
        channel.country === 'Magyarország' ||
        /\b(magyarország|hungary|hungarian)\b/i.test(channel.categoryName || '');

      const aHu = isHungary(a.channel);
      const bHu = isHungary(b.channel);
      if (aHu !== bHu) return aHu ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ channel }) => channel);
}
import { Header } from './components/Header';
import { VideoPlayer } from './components/VideoPlayer';
import { ChannelControls } from './components/ChannelControls';
import { ChannelList } from './components/ChannelList';
import { CategoriesModal } from './components/CategoriesModal';
import { MenuSettingsModal } from './components/MenuSettingsModal';
import { MoviesView } from './components/MoviesView';
import { SeriesView } from './components/SeriesView';
import { EpgGuideModal } from './components/EpgGuideModal';
import { AudioSubtitlesModal } from './components/AudioSubtitlesModal';
import { AddPlaylistModal } from './components/AddPlaylistModal';
import LoadingDiagnosticModal from './components/LoadingDiagnosticModal';
import {
  cancelNetworkRequests,
  checkInternetReachable,
  explainNetError,
  isTransportFailure,
  lastNetErrorHint,
  resetNetworkBreaker,
  setNetworkDiagnosticSink,
  NetworkDiagnosticEvent,
} from './services/net';
import { ChannelOrderModal } from './components/ChannelOrderModal';
import { ResumeHistoryModal } from './components/ResumeHistoryModal';
import { QrProvisionModal } from './components/QrProvisionModal';

export function App() {
  // Persistent state
  const [settings, setSettings] = useState<AppSettings>(() => storageService.getSettings());
  const [providers, setProviders] = useState<ProviderAccount[]>(() => storageService.getProviders());
  const [channels, setChannels] = useState<Channel[]>(() => hungaryFirst(bootChannels));
  const [categories, setCategories] = useState<Category[]>(() => bootLive.categories);
  const [vodCategories, setVodCategories] = useState<Category[]>([]);
  const [seriesCategories, setSeriesCategories] = useState<Category[]>([]);
  const [folders, setFolders] = useState<FavoriteFolder[]>(() => storageService.getFolders());
  const [movies, setMovies] = useState<Movie[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [activeProvider, setActiveProvider] = useState<ProviderRef | null>(() => bootLive.provider);
  const [totalCounts, setTotalCounts] = useState(() => bootLive.totals);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [diagnosticEvents, setDiagnosticEvents] = useState<NetworkDiagnosticEvent[]>([]);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [diagnosticProgress, setDiagnosticProgress] = useState<any>(null);
  const [diagnosticStartedAt, setDiagnosticStartedAt] = useState(() => performance.now());
  const [lastImportDiagnostic, setLastImportDiagnostic] = useState<{ providerId?: string; providerName: string; progress: any; events: NetworkDiagnosticEvent[]; error: string | null; startedAt: number; finished: boolean } | null>(null);
  const [lastImportDiagnosticOpen, setLastImportDiagnosticOpen] = useState(false);
  const [refreshLivePromptOpen, setRefreshLivePromptOpen] = useState(false);
  const diagnosticEventsRef = useRef<NetworkDiagnosticEvent[]>([]);
  const refreshLivePromptShownRef = useRef(false);
  const diagnosticFinishedRef = useRef(false);
  const providerRefreshActiveRef = useRef(false);
  /**
   * Automatikus újrapróbálkozás: ha a szolgáltató szervere nem válaszol
   * (tranziens hiba a szolgáltatónál), a program percenként egyszer magától
   * újrapróbálja – így akkor is helyreáll, ha a felhasználó nem figyel.
   * A próbálkozások száma korlátozott, a hálózatot nem terheli.
   */
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const retryAttemptsRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const retryTickRef = useRef<number | null>(null);
  const lastRefreshProviderIdRef = useRef<string | null>(null);
  // EPG-előtöltés csak sikeres szolgáltatói frissítés után indulhat.
  // A mentett csatornalista induláskor is készen áll az EPG-előtöltésre;
  // így nem csak a kiválasztott csatorna kap műsoradatot, amikor az app újraindul.
  const [providerContentReady, setProviderContentReady] = useState(() => !!bootLive.provider);
  // Változik minden új importnál/frissítésnél, akkor is, ha a szolgáltató és a csatornaazonosítók nem változnak.
  const [epgRevision, setEpgRevision] = useState(0);
  const [loadingSeriesId, setLoadingSeriesId] = useState<string>('');
  const dirtyRef = useRef(false);
  // A legutóbb elmentett listák azonosítója: így csak a megváltozott rész íródik ki.
  const lastSavedRef = useRef<{ channels: unknown; movies: unknown; series: unknown }>({
    channels: bootChannels, movies: [], series: [],
  });
  const [history, setHistory] = useState<WatchHistoryItem[]>(() => storageService.getHistory());

  // Navigation & Active View state – сохраняjuk a GitHub web-frissítés előtti nézetet.
  const savedUiState = useRef(storageService.getUiState());
  const [activeView, setActiveView] = useState<'live' | 'movies' | 'series'>(savedUiState.current.activeView || 'live');
  // VOD bezárásakor ugyanahhoz a könyvtárnézethez és kategóriához térünk vissza.
  const vodReturnViewRef = useRef<'movies' | 'series'>('movies');
  const movieCategoryRef = useRef('all');
  const seriesCategoryRef = useRef('all');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(() => {
    const saved = savedUiState.current.selectedCategoryId;
    return saved?.startsWith('country-')
      ? saved
      : findHungaryCategoryId(buildCountryCategories(bootChannels)) || 'all';
  });
  const [selectedSubCategoryId, setSelectedSubCategoryId] = useState<string | null>(null);
  const [isOnlyFavorites, setIsOnlyFavorites] = useState<boolean>(savedUiState.current.isOnlyFavorites || false);
  const [searchQuery] = useState<string>(savedUiState.current.searchQuery || '');
  const [categorySearchQuery, setCategorySearchQuery] = useState('');
  const [selectedFavoriteFolderId, setSelectedFavoriteFolderId] = useState<string | null>(null);
  const [displayedChannelOrder, setDisplayedChannelOrder] = useState<string[]>([]);
  const handleDisplayOrderChange = useCallback((orderedChannelIds: string[]) => {
    setDisplayedChannelOrder((previous) =>
      previous.length === orderedChannelIds.length && previous.every((id, index) => id === orderedChannelIds[index])
        ? previous
        : orderedChannelIds,
    );
  }, []);
  const previousCategoryBeforeFolderRef = useRef<string | null>(null);

  useEffect(() => {
    storageService.saveUiState({ activeView, selectedCategoryId, isOnlyFavorites, searchQuery });
  }, [activeView, selectedCategoryId, isOnlyFavorites, searchQuery]);

  // Active Channel / Media State
  const [activeChannelId, setActiveChannelId] = useState<string>(() => {
    const saved = settings.lastPlayedChannelId;
    const initialCountryCode = selectedCategoryId.startsWith('country-')
      ? selectedCategoryId.slice('country-'.length)
      : 'HU';
    const belongsToInitialCountry = (channel: Channel) =>
      (channel.countryCode || 'INT').toUpperCase() === initialCountryCode;
    // Az utolsó csatornát akkor is folytatjuk, ha nem a kezdő ország
    // listájában van (pl. kedvencekből nézett külföldi adó).
    return settings.autoPlayLastChannel && saved && channels.some((channel) => channel.id === saved)
      ? saved
      : (channels.find(belongsToInitialCountry)?.id || channels[0]?.id || 'hu-sony-max');
  });

  // A menü országokat mutat, nem szolgáltatói alkategóriákat. Egy ország
  // összes csatornája egyetlen választható elem alá kerül.
  const countryCategories = useMemo(() => buildCountryCategories(channels), [channels]);

  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [isOsdVisible, setIsOsdVisible] = useState<boolean>(true);
  // Teljes képernyőn a főoldali OSD (ChannelControls) ugyanabban a kinézetben
  // úszik a HTML5 videókép fölött.
  const [isVideoFullscreen, setIsVideoFullscreen] = useState<boolean>(false);
  // Fekvő teljes képernyős élő TV-nél a főoldali OSD-t is el kell rejteni.
  const [isLandscapeFullscreen, setIsLandscapeFullscreen] = useState<boolean>(false);
  useEffect(() => {
    const updateOrientation = () => {
      const viewport = window.visualViewport;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      setIsLandscapeFullscreen(isVideoFullscreen && width > height);
    };
    updateOrientation();
    window.addEventListener('resize', updateOrientation);
    window.addEventListener('orientationchange', updateOrientation);
    window.visualViewport?.addEventListener('resize', updateOrientation);
    return () => {
      window.removeEventListener('resize', updateOrientation);
      window.removeEventListener('orientationchange', updateOrientation);
      window.visualViewport?.removeEventListener('resize', updateOrientation);
    };
  }, [isVideoFullscreen]);
  const mainPlayerToggleRef = useRef<(() => void) | null>(null);
  const mainPlayerCastRef = useRef<(() => void) | null>(null);
  const mainPlayerPipRef = useRef<(() => void) | null>(null);
  const mainPlayerOsdToggleRef = useRef<(() => void) | null>(null);
  const mainPlayerAudioSelectRef = useRef<((track: AudioTrack) => void) | null>(null);
  const [liveAudioTracks, setLiveAudioTracks] = useState<AudioTrack[]>([]);
  const registerMainPlayerAudioSelector = useCallback((selector: ((track: AudioTrack) => void) | null) => {
    mainPlayerAudioSelectRef.current = selector;
  }, []);
  const mainPlayerSubtitleSelectRef = useRef<((track: SubtitleTrack | null) => void) | null>(null);
  const [liveSubtitleTracks, setLiveSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const registerMainPlayerSubtitleSelector = useCallback((selector: ((track: SubtitleTrack | null) => void) | null) => {
    mainPlayerSubtitleSelectRef.current = selector;
  }, []);
  const [volume, setVolume] = useState<number>(() => {
    try { const saved = localStorage.getItem('iptv-main-osd-volume'); if (saved === null) return 0.7; const parsed = Number(saved); return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.7; }
    catch { return 0.7; }
  });
  const lastAudibleVolumeRef = useRef<number>((() => {
    try { const saved = localStorage.getItem('iptv-main-osd-last-audible-volume'); const parsed = saved === null ? 0.7 : Number(saved); return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.7; }
    catch { return 0.7; }
  })());
  const handleVolumeChange = useCallback((value: number) => {
    const next = Math.max(0, Math.min(1, Number(value) || 0));
    if (next > 0) {
      lastAudibleVolumeRef.current = next;
      try { localStorage.setItem('iptv-main-osd-last-audible-volume', String(next)); } catch { /* storage may be unavailable */ }
    }
    setVolume(next);
    try { localStorage.setItem('iptv-main-osd-volume', String(next)); } catch { /* storage may be unavailable */ }
  }, []);
  const handleToggleMute = useCallback(() => {
    if (volume > 0) { lastAudibleVolumeRef.current = volume; handleVolumeChange(0); }
    else { handleVolumeChange(lastAudibleVolumeRef.current > 0 ? lastAudibleVolumeRef.current : 0.7); }
  }, [volume, handleVolumeChange]);
  const [customStreamUrl, setCustomStreamUrl] = useState<string | undefined>(undefined);
  const [customStreamTitle, setCustomStreamTitle] = useState<string | undefined>(undefined);
  const [nextEpisodeToPlay, setNextEpisodeToPlay] = useState<{ series: Series; episode: Episode } | null>(null);

  // Modals state
  const [isCategoriesOpen, setIsCategoriesOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'lists' | 'favorites' | 'system'>('favorites');

  const [isEpgOpen, setIsEpgOpen] = useState(false);
  const [isAudioModalOpen, setIsAudioModalOpen] = useState(false);
  const [isSubtitlesModalOpen, setIsSubtitlesModalOpen] = useState(false);
  const [isAddProviderOpen, setIsAddProviderOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderAccount | null>(null);
  const [isQrProvisionOpen, setIsQrProvisionOpen] = useState(false);
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
  const [favoriteChannelId, setFavoriteChannelId] = useState<string | null>(null);
  const [isResumeModalOpen, setIsResumeModalOpen] = useState(false);

  // Active channel reference
  const activeChannel = useMemo(() => {
    return channels.find((c) => c.id === activeChannelId) || channels[0] || null;
  }, [channels, activeChannelId]);

  // A csatornalista a kiválasztott kategóriát, a kedvenceket vagy a kiválasztott mappát mutatja.
  const filteredChannels = useMemo(() => {
    const globalQuery = categorySearchQuery.trim().toLocaleLowerCase();
    if (globalQuery) {
      return channels.filter((channel) => {
        const countryName = countryCategories.find((category) => category.id === `country-${(channel.countryCode || 'INT').toUpperCase()}`)?.name || channel.country || '';
        return [channel.name, channel.categoryName, channel.categoryId, channel.country, channel.countryCode, countryName]
          .some((value) => String(value || '').toLocaleLowerCase().includes(globalQuery));
      });
    }
    if (selectedFavoriteFolderId) {
      const folder = folders.find((item) => item.id === selectedFavoriteFolderId);
      const byId = new Map(channels.map((channel) => [channel.id, channel]));
      return (folder?.channelIds || []).map((id) => byId.get(id)).filter((channel): channel is Channel => Boolean(channel));
    }
    const effectiveCategoryId = selectedCategoryId === 'all'
      ? findHungaryCategoryId(countryCategories) || countryCategories[0]?.id || 'all'
      : selectedCategoryId;
    return channels.filter((ch) => {
      // A Kedvencek nézet mappaválasztó: itt nem soroljuk fel az összes csatornát.
      // Csatornákat csak egy konkrét mappa megnyitásakor mutatunk.
      if (isOnlyFavorites) return false;
      if (effectiveCategoryId.startsWith('country-')) {
        const sameCountry = (ch.countryCode || 'INT').toUpperCase() === effectiveCategoryId.slice('country-'.length);
        return sameCountry && (!selectedSubCategoryId || ch.categoryId === selectedSubCategoryId);
      }
      if (effectiveCategoryId === 'all') return false;
      return ch.categoryId === effectiveCategoryId;
    });
  }, [channels, selectedCategoryId, selectedSubCategoryId, isOnlyFavorites, folders, selectedFavoriteFolderId, countryCategories, categorySearchQuery]);

  // A képernyőn megjelenő sorszám a jelenlegi szűrt lista pozíciója; az eredeti ch.num érintetlen.
  const activeChannelDisplayNumber = useMemo(() => {
    const orderMatchesCurrentList = displayedChannelOrder.length === filteredChannels.length
      && displayedChannelOrder.every((id) => filteredChannels.some((channel) => channel.id === id));
    const order = orderMatchesCurrentList ? displayedChannelOrder : filteredChannels.map((channel) => channel.id);
    const index = order.indexOf(activeChannelId);
    return index >= 0 ? index + 1 : undefined;
  }, [filteredChannels, activeChannelId, displayedChannelOrder]);

  // A ChannelList kezeli a látható csatornák EPG-jét a referencia mintájára.
  // Itt csak a gyorsítótárból frissítjük a csatornaállapotot; nincs második előtöltő sor.

  // A referencia nem egyetlen pillanatfelvételt mutat: a műsor címét az aktuális
  // időből számolja újra. Ezzel a csatornalista EPG-je magától továbblép akkor is,
  // ha a néző nem kattint rá a csatornára.
  useEffect(() => {
    if (!activeProvider || activeProvider.type !== 'xtream') return;
    const refreshDisplayedPrograms = () => {
      const nowMs = Date.now();
      setChannels((prev) => {
        let changed = false;
        const nextChannels = prev.map((channel) => {
          const streamId = streamIdFor(channel);
          if (!streamId) return channel;
          const entries = getCachedShortEpg(activeProvider, streamId, 6);
          if (!entries.length) return channel;
          const { now, next } = nowNextFromEpg(entries, nowMs);
          const nextNow = now || channel.epgNow;
          const nextNext = next || channel.epgNext;
          if (
            nextNow?.title !== channel.epgNow?.title ||
            nextNow?.time !== channel.epgNow?.time ||
            nextNow?.startTimestamp !== channel.epgNow?.startTimestamp ||
            nextNow?.endTimestamp !== channel.epgNow?.endTimestamp ||
            nextNext?.title !== channel.epgNext?.title ||
            nextNext?.time !== channel.epgNext?.time
          ) {
            changed = true;
            return { ...channel, epgNow: nextNow, epgNext: nextNext };
          }
          return channel;
        });
        return changed ? nextChannels : prev;
      });
    };
    refreshDisplayedPrograms();
    const timer = window.setInterval(refreshDisplayedPrograms, 30000);
    return () => window.clearInterval(timer);
  }, [activeProvider?.id, activeProvider?.type]);

  /**
   * Az ÉPPEN NÉZETT csatorna műsora (most / következő) a szolgáltatótól.
   *
   * Csak egyetlen kérés megy ki csatornaváltáskor (és az eredmény 5 percig
   * gyorsítótárazódik), ezért ez nem lassítja a zappingot. A nagy betöltés
   * idején (providerRefreshActiveRef) szándékosan nem indul kérés.
   */
  useEffect(() => {
    const channel = activeChannel;
    const provider = activeProvider;
    if (!channel || !provider || provider.type !== 'xtream') return;
    if (providerRefreshActiveRef.current) return;
    const streamId = streamIdFor(channel);
    if (!streamId) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      loadShortEpg(provider, streamId, 6)
        .then((entries) => {
          if (cancelled || !entries.length) return;
          const { now, next } = nowNextFromEpg(entries);
          if (!now && !next) return;
          setChannels((prev) =>
            prev.map((ch) =>
              ch.id === channel.id ? { ...ch, epgNow: now || ch.epgNow, epgNext: next || ch.epgNext } : ch
            )
          );
        })
        .catch(() => {
          /* Az EPG hibája nem akadályozhatja a nézést. */
        });
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeChannel?.id, activeProvider?.id]);

  // A filmek és sorozatok betöltése a mentett tárból – a kezdőképernyő
  // megjelenése után.
  //
  // FONTOS (a telefon lefagyásának javítása): a lista adagonként töltődik be,
  // adagok között a felület visszakapja a vezérlést. Korábban a teljes,
  // több tízezer elemű lista egyetlen, hosszú műveletben készült el, ezért a
  // felület ilyenkor látszólag megfagyott.
  useEffect(() => {
    if (!bootLive.provider) return;
    const provider = bootLive.provider;
    let cancelled = false;
    logStartup();
    appLog(`Mentett tartalom betöltése indul (tároló: ${bootLive.provider.id}).`);
    logMemory('tartalom betöltése előtt');
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const vod = await loadVodAsync(provider);
          if (cancelled) return;
          setMovies(vod.movies);
          setVodCategories(vod.categories);
          appLog(`Filmek a felületen: ${vod.movies.length}.`);
        } catch (error) {
          appLogError('Filmek betöltése', error);
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        try {
          const ser = await loadSeriesAsync(provider);
          if (cancelled) return;
          setSeries(ser.series);
          setSeriesCategories(ser.categories);
          appLog(`Sorozatok a felületen: ${ser.series.length}.`);
        } catch (error) {
          appLogError('Sorozatok betöltése', error);
        }
        logMemory('tartalom betöltése után');
      })();
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Kedvencek / sorrend módosítása után mentsük a tartalmat (késleltetve).
  //
  // FONTOS (a telefon lefagyásának javítása): csak az a rész íródik újra,
  // amelyik tényleg megváltozott. Korábban egyetlen kedvenc bejelölése is a
  // teljes film- és sorozatlistát (több tízezer sor) újramentette.
  useEffect(() => {
    if (!dirtyRef.current || !activeProvider) return;
    const provider = activeProvider;
    const timer = setTimeout(() => {
      dirtyRef.current = false;
      const previous = lastSavedRef.current;
      const content = {
        provider,
        savedAt: new Date().toISOString(),
        channels,
        movies,
        series,
        liveCategories: categories,
        vodCategories,
        seriesCategories,
        totals: totalCounts,
      };
      const changedChannels = previous.channels !== channels;
      const changedMovies = previous.movies !== movies;
      const changedSeries = previous.series !== series;
      lastSavedRef.current = { channels, movies, series };
      appLog(`Változások mentése (csatorna=${changedChannels}, film=${changedMovies}, sorozat=${changedSeries}; `
        + `${channels.length} csatorna, ${movies.length} film, ${series.length} sorozat).`);
      void (async () => {
        try {
          if (changedChannels) saveLiveContent(content);
          if (changedMovies) await saveVodContent(content);
          if (changedSeries) await saveSeriesContent(content);
        } catch (error) {
          console.error('A tartalom mentése nem sikerült:', error);
          appLogError('Tartalom mentése', error);
        }
      })();
    }, 600);
    return () => clearTimeout(timer);
  }, [channels, movies, series, activeProvider, categories, vodCategories, seriesCategories, totalCounts]);

  // Update Settings helper
  // A beállításokat mindig a legfrissebb React-state alapján módosítjuk.
  // Nem használunk lezárt (stale) `settings` példányt, mert így egy gyors
  // másik művelet (pl. csatornaváltás/provider-váltás) nem tudja visszaírni
  // egy korábbi állapotra a felhasználó frissen kiválasztott beállításait.
  const handleUpdateSettings = useCallback((newSettings: Partial<AppSettings>) => {
    setSettings((current) => {
      const updated = { ...current, ...newSettings };
      storageService.saveSettings(updated);
      return updated;
    });
  }, []);

  // Switch Active Channel
  const handleSelectChannel = useCallback((channel: Channel) => {
    setNextEpisodeToPlay(null);
    setCustomStreamUrl(undefined);
    setCustomStreamTitle(undefined);
    setActiveChannelId(channel.id);
    setIsPlaying(true);
    handleUpdateSettings({ lastPlayedChannelId: channel.id });
    if (activeView !== 'live') {
      setActiveView('live');
    }
  }, [activeView, handleUpdateSettings]);

  // Next / Prev channel switching: always follow the numeric channel number,
  // not the current category/search/render order. Stop at the ends instead of
  // wrapping from the last channel to the first (which could be unrelated).
  const handleNextChannel = useCallback(() => {
    if (settings.closeListOnZap) setIsCategoriesOpen(false);
    const list = filteredChannels;
    if (list.length === 0) return;
    const currentIndex = list.findIndex((c) => c.id === activeChannelId);
    if (currentIndex < 0) {
      handleSelectChannel(list[0]);
      return;
    }
    if (currentIndex >= list.length - 1) return;
    handleSelectChannel(list[currentIndex + 1]);
  }, [filteredChannels, activeChannelId, handleSelectChannel, settings.closeListOnZap]);

  const handlePrevChannel = useCallback(() => {
    if (settings.closeListOnZap) setIsCategoriesOpen(false);
    const list = filteredChannels;
    if (list.length === 0) return;
    const currentIndex = list.findIndex((c) => c.id === activeChannelId);
    if (currentIndex < 0) {
      handleSelectChannel(list[0]);
      return;
    }
    if (currentIndex <= 0) return;
    handleSelectChannel(list[currentIndex - 1]);
  }, [filteredChannels, activeChannelId, handleSelectChannel, settings.closeListOnZap]);

  // A csillag valódi kapcsoló: ha már kedvenc, egy újabb nyomás kiveszi minden kedvenc mappából.
  const handleToggleFavorite = (channelId: string) => {
    const isAlreadyFavorite = folders.some((folder) => folder.channelIds.includes(channelId));
    if (isAlreadyFavorite) {
      handleSaveFolders(folders.map((folder) => ({
        ...folder,
        channelIds: folder.channelIds.filter((id) => id !== channelId),
      })));
      return;
    }
    setFavoriteChannelId(channelId);
    setIsOrderModalOpen(true);
  };

  const handleRemoveChannelFromFolder = (folderId: string, channelId: string) => {
    handleSaveFolders(folders.map((folder) => folder.id === folderId
      ? { ...folder, channelIds: folder.channelIds.filter((id) => id !== channelId) }
      : folder));
  };

  const handleMoveFavoriteChannel = (folderId: string, channelId: string, direction: 'up' | 'down') => {
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) return;
    const ids = folder.channelIds.slice();
    const pos = ids.indexOf(channelId);
    const target = pos + (direction === 'up' ? -1 : 1);
    if (pos < 0 || target < 0 || target >= ids.length) return;
    [ids[pos], ids[target]] = [ids[target], ids[pos]];
    handleSaveFolders(folders.map((item) => item.id === folderId ? { ...item, channelIds: ids } : item));
  };

  const handleAssignChannelToFolder = (channelId: string, folderId: string) => {
    const updatedFolders = folders.map((folder) =>
      folder.id === folderId
        ? { ...folder, channelIds: folder.channelIds.includes(channelId) ? folder.channelIds : [...folder.channelIds, channelId] }
        : folder
    );
    handleSaveFolders(updatedFolders);
    setChannels((previous) => previous.map((channel) =>
      channel.id === channelId ? { ...channel, isFavorite: true } : channel
    ));
    dirtyRef.current = true;
  };

  // A kukával a kedvenc mappából csak a mappatagságot vesszük ki;
  // az ország/alaplistából törölve a csatorna minden kedvenc mappából is eltűnik.
  const handleDeleteChannel = (channelId: string) => {
    if (selectedFavoriteFolderId) {
      const updatedFolders = folders.map((folder) => folder.id === selectedFavoriteFolderId
        ? { ...folder, channelIds: folder.channelIds.filter((id) => id !== channelId) }
        : folder);
      handleSaveFolders(updatedFolders);
      return;
    }

    const remainingChannels = channels.filter((channel) => channel.id !== channelId);
    setChannels(remainingChannels);
    const updatedFolders = folders.map((folder) => ({
      ...folder,
      channelIds: folder.channelIds.filter((id) => id !== channelId),
    }));
    handleSaveFolders(updatedFolders);
    if (activeChannelId === channelId) {
      const nextChannel = filteredChannels.find((channel) => channel.id !== channelId)
        || remainingChannels.find((channel) => selectedCategoryId === 'all' || channel.categoryId === selectedCategoryId)
        || remainingChannels[0];
      if (nextChannel) setActiveChannelId(nextChannel.id);
    }
    dirtyRef.current = true;
  };

  // Toggle Favorite for Movie
  const handleToggleFavoriteMovie = (movieId: string) => {
    const updated = movies.map((m) =>
      m.id === movieId ? { ...m, isFavorite: !m.isFavorite } : m
    );
    setMovies(updated);
    dirtyRef.current = true;
  };

  // Toggle Favorite for Series
  const handleToggleFavoriteSeries = (seriesId: string) => {
    const updated = series.map((s) =>
      s.id === seriesId ? { ...s, isFavorite: !s.isFavorite } : s
    );
    setSeries(updated);
    dirtyRef.current = true;
  };

  // Kézi csatorna-sorrend: az aktuálisan látható listában egy hellyel fel/le mozgat.
  const handleMoveChannel = (channelId: string, direction: 'up' | 'down') => {
    if (selectedFavoriteFolderId) {
      handleMoveFavoriteChannel(selectedFavoriteFolderId, channelId, direction);
      return;
    }
    const ids = filteredChannels.map((c) => c.id);
    const pos = ids.indexOf(channelId);
    const target = pos + (direction === 'up' ? -1 : 1);
    if (pos < 0 || target < 0 || target >= ids.length) return;

    const order = ids.slice();
    [order[pos], order[target]] = [order[target], order[pos]];

    // A látható csatornák helyeit cseréljük az alaplistában, a többi kategória sorrendje nem sérül.
    const visibleIdSet = new Set(ids);
    const slots: number[] = [];
    channels.forEach((channel, index) => {
      if (visibleIdSet.has(channel.id)) slots.push(index);
    });
    const byId = new Map(channels.map((c) => [c.id, c]));
    const updated = channels.slice();

    order.forEach((id, i) => {
      const channel = byId.get(id);
      if (channel && slots[i] !== undefined) updated[slots[i]] = channel;
    });

    setChannels(updated);
    dirtyRef.current = true;
  };

  // Hosszan nyomva húzott csatornák sorrendje az aktuális kategóriában/kedvencekben.
  // A látható elemek helyeit cseréljük az alaplistában, így a többi kategória sorrendje nem sérül.
  const handleReorderChannels = (orderedChannelIds: string[]) => {
    const currentIds = filteredChannels.map((channel) => channel.id);
    const currentIdSet = new Set(currentIds);
    const slots: number[] = [];
    channels.forEach((channel, index) => {
      if (currentIdSet.has(channel.id)) slots.push(index);
    });
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const updated = channels.slice();
    orderedChannelIds.forEach((id, index) => {
      const channel = byId.get(id);
      if (channel && slots[index] !== undefined) updated[slots[index]] = channel;
    });
    setChannels(updated);
    dirtyRef.current = true;
  };

  // A mappák a csatornakedvencek egyetlen forrásai: a csillag állapota a mappatagságot követi.
  const handleSaveFolders = (updatedFolders: FavoriteFolder[]) => {
    setFolders(updatedFolders);
    storageService.saveFolders(updatedFolders);
    const favoriteChannelIds = new Set(updatedFolders.flatMap((folder) => folder.channelIds));
    setChannels((previous) => {
      let changed = false;
      const next = previous.map((channel) => {
        const isFavorite = favoriteChannelIds.has(channel.id);
        if (channel.isFavorite === isFavorite) return channel;
        changed = true;
        return { ...channel, isFavorite };
      });
      if (changed) dirtyRef.current = true;
      return changed ? next : previous;
    });
  };

  const handleDeleteFolder = (folderId: string) => {
    handleSaveFolders(folders.filter((folder) => folder.id !== folderId));
    if (selectedFavoriteFolderId === folderId) setSelectedFavoriteFolderId(null);
  };

  // Add New Provider (a letöltött csatorna/film/sorozat listával együtt)
  const handleAddProvider = (newProvider: ProviderAccount, content?: ImportedContent) => {
    const replacingId = editingProvider?.id;

    if (replacingId) {
      const finalProviders = providers.map((p) =>
        p.id === replacingId
          ? { ...newProvider, id: replacingId, isActive: true }
          : { ...p, isActive: false }
      );
      setProviders(finalProviders);
      storageService.saveProviders(finalProviders);
      setEditingProvider(null);
    } else {
      const finalProviders = [
        { ...newProvider, isActive: true },
        ...providers.map((p) => ({ ...p, isActive: false })),
      ];
      setProviders(finalProviders);
      storageService.saveProviders(finalProviders);
    }

    if (!content) return;

    // Az import által létrehozott ideiglenes provider ID-t mindig
    // összehangoljuk a ténylegesen mentett szolgáltató ID-jával.
    const providerId = replacingId || newProvider.id;
    const normalizedContent: ImportedContent = {
      ...content,
      provider: {
        ...content.provider,
        id: providerId,
      },
    };

    clearEpgCache();
    setEpgRevision((revision) => revision + 1);
    setProviderContentReady(true);
    setActiveProvider(normalizedContent.provider);
    setChannels(hungaryFirst(normalizedContent.channels));
    setCategories(normalizedContent.liveCategories);
    setMovies(normalizedContent.movies);
    setVodCategories(normalizedContent.vodCategories);
    setSeries(normalizedContent.series);
    setSeriesCategories(normalizedContent.seriesCategories);
    setTotalCounts(normalizedContent.totals);
    appLog(`Új lista mentése: ${normalizedContent.channels.length} csatorna,`
      + ` ${normalizedContent.movies.length} film, ${normalizedContent.series.length} sorozat.`);
    void saveContent(normalizedContent).catch((error) => {
      console.error('A tartalom mentése nem sikerült:', error);
      appLogError('Új lista mentése', error);
    });

    dirtyRef.current = false;
    const importedCountries = buildCountryCategories(normalizedContent.channels);
    const defaultCountryId = findHungaryCategoryId(importedCountries) || importedCountries[0]?.id || 'all';
    const defaultCountryCode = defaultCountryId.startsWith('country-') ? defaultCountryId.slice('country-'.length) : '';
    const firstDefaultChannel = normalizedContent.channels.find((channel) => (channel.countryCode || 'INT').toUpperCase() === defaultCountryCode)
      || normalizedContent.channels[0];
    setSelectedCategoryId(defaultCountryId);
    setSelectedSubCategoryId(null);
    setIsOnlyFavorites(false);
    if (firstDefaultChannel) {
      setActiveChannelId(firstDefaultChannel.id);
      handleUpdateSettings({
        lastPlayedChannelId: firstDefaultChannel.id,
        activeProviderId: providerId,
      });
    } else {
      handleUpdateSettings({ activeProviderId: providerId });
    }
  };

  // QR telefonos beállítás – provider fogadása telefonról (TV-n nem kell pötyögni)
  const handleQrProviderReceived = async (payload: any) => {
    try {
      console.log('[QR] Provider received in App', payload);
      if (payload.type === 'xtream') {
        let host = String(payload.host || '').trim();
        let port = String(payload.port || '').trim();
        try {
          if (host.includes('://')) {
            const u = new URL(host);
            host = u.hostname;
            if (u.port) port = u.port;
          } else if (host.includes(':')) {
            const parts = host.split(':');
            const last = parts[parts.length-1];
            if (/^\d+$/.test(last)) {
              port = last;
              host = parts.slice(0,-1).join(':');
            }
          }
        } catch {}
        const newProvider = {
          id: 'qr_' + Date.now(),
          name: payload.name || 'Telefonról',
          type: 'xtream' as const,
          url: host,
          port: port || '8080',
          serverUrl: `${host.includes('://') ? host : `http://${host}`}${port ? `:${port}` : ''}`,
          username: payload.username,
          password: payload.password,
          isActive: true,
          status: 'loading' as const,
          channelsCount: 0,
          moviesCount: 0,
          seriesCount: 0,
          lastUpdated: new Date().toLocaleString('hu-HU'),
          expireDate: 'N/A',
          maxConnections: 'N/A'
        };
        handleAddProvider(newProvider);
        // A provider mentése után automatikusan induljon a teljes listaimport.
        window.setTimeout(() => { void handleRefreshProvider(newProvider, false); }, 250);
      } else if (payload.type === 'm3u') {
        const newProvider = {
          id: 'qr_' + Date.now(),
          name: payload.name || 'Telefonról M3U',
          type: 'm3u' as const,
          url: payload.url,
          m3uUrl: payload.url,
          serverUrl: payload.url,
          isActive: true,
          status: 'loading' as const,
          channelsCount: 0,
          moviesCount: 0,
          seriesCount: 0,
          lastUpdated: new Date().toLocaleString('hu-HU'),
          expireDate: 'N/A',
          maxConnections: 'N/A'
        };
        handleAddProvider(newProvider);
        // M3U esetén is automatikusan induljon a beolvasás a mentés után.
        window.setTimeout(() => { void handleRefreshProvider(newProvider, false); }, 250);
      }
    } catch (e) {
      console.error('[QR] handle error', e);
    }
  };

  // Delete Provider
  const handleDeleteProvider = (id: string) => {
    if (!confirm('Biztosan törölni szeretnéd ezt a szolgáltatói listát?')) return;

    const updated = providers.filter((p) => p.id !== id);
    setProviders(updated);
    storageService.saveProviders(updated);

    if (activeProvider?.id === id) {
      // A felhasználói kedvencek és sorrendek csak a szolgáltató törlésekor törlődnek.
      clearContent();
      setActiveProvider(null);
      setChannels([]);
      setCategories([]);
      setMovies([]);
      setVodCategories([]);
      setSeries([]);
      setSeriesCategories([]);
      setTotalCounts({ live: 0, vod: 0, series: 0 });
      setFolders([]);
      storageService.saveFolders([]);
      setSelectedFavoriteFolderId(null);
      setSelectedCategoryId('all');
      setIsOnlyFavorites(false);
      handleUpdateSettings({ activeProviderId: undefined, lastPlayedChannelId: undefined });
    }
  };

  // Refresh Provider: újratölti a csatornákat, filmeket és sorozatokat, közben ugyanaz a diagnosztika jelenik meg., filmeket és sorozatokokat, közben ugyanaz a diagnosztika jelenik meg.
  //
  // A betöltés SZAKASZONKÉNT kerül a felületre (élő -> filmek -> sorozatok):
  // az élő csatornalista néhány másodperc után használható, nem kell megvárni
  // a több tízezer film letöltését. Minden szakasz azonnal mentésre is kerül,
  // így a következő indítás a mentett listából azonnal dolgozik.
  const handleRefreshProvider = async (providerOrId: string | ProviderAccount, manual = true) => {
    // QR-es hozzáadás után a React providers állapota ebben a renderben még régi lehet.
    // Az átadott ProviderAccount ezért közvetlenül használható, nem veszhet el az első import.
    const provider = typeof providerOrId === 'string'
      ? providers.find((p) => p.id === providerOrId)
      : providerOrId;
    if (!provider) return;
    const id = provider.id;
    const providersForRefresh = providers.some((p) => p.id === id)
      ? providers
      : [provider, ...providers.map((p) => ({ ...p, isActive: false }))];

    // Ha korábbi EPG-előtöltés még fut, azt azonnal leállítjuk, hogy
    // semmilyen háttérkérés ne foglalja a kapcsolatot a fő Xtream betöltés elől.
    cancelNetworkRequests();
    resetNetworkBreaker();
    cancelAutoRetry();
    if (manual) retryAttemptsRef.current = 0;
    lastRefreshProviderIdRef.current = id;
    providerRefreshActiveRef.current = true;
    clearEpgCache();
    setEpgRevision((revision) => revision + 1);
    setProviderContentReady(false);
    setDiagnosticOpen(true);
    setDiagnosticEvents([]);
    diagnosticEventsRef.current = [];
    setDiagnosticError(null);
    const refreshStartedAt = performance.now();
    const initialProgress = { phase: 'Frissítés indul…', percent: 2 };
    setDiagnosticProgress(initialProgress);
    setDiagnosticStartedAt(refreshStartedAt);
    setRefreshLivePromptOpen(false);
    refreshLivePromptShownRef.current = false;
    diagnosticFinishedRef.current = false;
    setLastImportDiagnostic({ providerId: id, providerName: provider.name, progress: initialProgress, events: [], error: null, startedAt: refreshStartedAt, finished: false });
    setNetworkDiagnosticSink((event) => {
      const next = [...diagnosticEventsRef.current, event].slice(-250);
      diagnosticEventsRef.current = next;
      setDiagnosticEvents(next);
      setLastImportDiagnostic((current) => ({ providerId: id, providerName: provider.name, progress: current?.providerId === id ? current.progress : initialProgress, events: next, error: null, startedAt: refreshStartedAt, finished: false }));
    });

    // A betöltés közben folyamatosan épülő tartalom (a szakaszonkénti mentéshez).
    const draft: ImportedContent = {
      provider: {
        id: provider.id,
        type: provider.type,
        serverUrl: provider.serverUrl,
        username: provider.username,
        password: provider.password,
      },
      savedAt: new Date().toISOString(),
      channels: [],
      movies: [],
      series: [],
      liveCategories: [],
      vodCategories: [],
      seriesCategories: [],
      totals: { live: 0, vod: 0, series: 0 },
      warnings: [],
    };

    /** Egy-egy szakasz azonnal a felületre és a tárolóba kerül. */
    const applyPartial = async (partial: PartialContent): Promise<void> => {
      if (partial.totals) draft.totals = { ...draft.totals, ...partial.totals };
      if (partial.channels) {
        draft.channels = preserveChannelPreferences(partial.channels, channels);
        setActiveProvider(draft.provider);
        // A frissítés részletekben érkezik. Ha a jelenleg nézett csatorna
        // még nem érkezett meg a részleges listában, ideiglenesen megtartjuk,
        // hogy a háttérfrissítés ne váltson át az első csatornára.
        const currentlyWatched = channels.find((channel) => channel.id === activeChannelId);
        const visibleChannels = currentlyWatched && !draft.channels.some((channel) => channel.id === currentlyWatched.id)
          ? [...draft.channels, currentlyWatched]
          : draft.channels;
        setChannels(hungaryFirst(visibleChannels));
        if (partial.channels.length > 0 && !refreshLivePromptShownRef.current) {
          refreshLivePromptShownRef.current = true;
          setRefreshLivePromptOpen(true);
        }
      }
      if (partial.liveCategories) {
        draft.liveCategories = partial.liveCategories;
        setCategories(partial.liveCategories);
      }
      if (partial.movies) {
        draft.movies = partial.movies;
        setMovies(partial.movies);
      }
      if (partial.vodCategories) {
        draft.vodCategories = partial.vodCategories;
        setVodCategories(partial.vodCategories);
      }
      if (partial.series) {
        draft.series = partial.series;
        setSeries(partial.series);
      }
      if (partial.seriesCategories) {
        draft.seriesCategories = partial.seriesCategories;
        setSeriesCategories(partial.seriesCategories);
      }
      setTotalCounts({ ...draft.totals });

      // A mentés előtt visszaadjuk a vezérlést a felületnek; a sorozat
      // adagjai pedig befejeződnek, mielőtt az import a következő fázisra lép.
      if (partial.channels || partial.movies || partial.series) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
      if (partial.channels) saveLiveContent(draft);
      if (partial.movies) await saveVodContent(draft);
      if (partial.series) await saveSeriesContent(draft);

      const updatedProviders = providersForRefresh.map((p) =>
        p.id === id
          ? {
              ...p,
              channelsCount: draft.channels.length || p.channelsCount,
              moviesCount: draft.movies.length || p.moviesCount,
              seriesCount: draft.series.length || p.seriesCount,
              lastUpdated: new Date().toISOString().slice(0, 10).replace(/-/g, '. ') + '.',
              isActive: true,
            }
          : { ...p, isActive: false }
      );
      setProviders(updatedProviders);
      storageService.saveProviders(updatedProviders);
    };

    try {
      const result = await refreshProviderContent(
        provider,
        (progress) => {
          if (!diagnosticFinishedRef.current && progress.percent < 100) {
            setDiagnosticProgress(progress);
            setLastImportDiagnostic(() => ({ providerId: id, providerName: provider.name, progress, events: diagnosticEventsRef.current, error: null, startedAt: refreshStartedAt, finished: false }));
          }
        },
        applyPartial
      );
      const content: ImportedContent =
        'content' in result ? result.content : (result as ImportedContent);

      // Frissítéskor csak a szolgáltatói tartalom változik; a felhasználó kedvencei,
      // kézi sorrendje és a kedvencmappákhoz tartozó csatornaazonosítók megmaradnak.
      const refreshedChannels = preserveChannelPreferences(content.channels, channels);
      // A frissítés befejezése sem indíthat másik csatornát: a már nézett
      // csatornát megtartjuk akkor is, ha a szolgáltató friss listájából hiányzik.
      const currentlyWatched = channels.find((channel) => channel.id === activeChannelId);
      const channelsForDisplay = currentlyWatched && !refreshedChannels.some((channel) => channel.id === currentlyWatched.id)
        ? [...refreshedChannels, currentlyWatched]
        : refreshedChannels;
      const refreshedContent: ImportedContent = { ...content, channels: refreshedChannels };
      setActiveProvider(refreshedContent.provider);
      setChannels(hungaryFirst(channelsForDisplay));
      setCategories(refreshedContent.liveCategories);
      setMovies(refreshedContent.movies);
      setVodCategories(refreshedContent.vodCategories);
      setSeries(refreshedContent.series);
      setSeriesCategories(refreshedContent.seriesCategories);
      setTotalCounts(refreshedContent.totals);
      // A live/film/sorozat részeket az applyPartial már külön elmentette.
      // Ne írjuk ki még egyszer a teljes több tízezres listát a fő szálon.
      dirtyRef.current = false;

      diagnosticFinishedRef.current = true;
      retryAttemptsRef.current = 0;
      cancelAutoRetry();
      setProviderContentReady(true);
      // A hiányos betöltés (pl. a szolgáltató néhány kategóriát nem adott ki)
      // nem maradhat észrevétlen: a figyelmeztetés a betöltés végén látszik.
      const warningText = Array.isArray(content.warnings) && content.warnings.length
        ? ' • FIGYELEM: ' + content.warnings.join(' ')
        : '';
      const finalProgress = {
        phase: content.warnings && content.warnings.length ? 'Részben kész' : 'Kész',
        detail: `${content.channels.length.toLocaleString('hu-HU')} csatorna • ${content.movies.length.toLocaleString('hu-HU')} film • ${content.series.length.toLocaleString('hu-HU')} sorozat${warningText}`,
        percent: 100,
      };
      setDiagnosticProgress(finalProgress);
      setLastImportDiagnostic({ providerId: id, providerName: provider.name, progress: finalProgress, events: diagnosticEventsRef.current, error: null, startedAt: refreshStartedAt, finished: true });
      setNetworkDiagnosticSink(null);
      providerRefreshActiveRef.current = false;
    } catch (error) {
      diagnosticFinishedRef.current = true;
      setProviderContentReady(false);
      setNetworkDiagnosticSink(null);
      const message = error instanceof Error ? error.message : 'A frissítés nem sikerült.';
      setDiagnosticError(message);
      setDiagnosticProgress((prev: any) => ({ ...(prev || {}), phase: 'Hiba', percent: Math.min(99, Math.max(0, prev?.percent || 0)) }));
      setLastImportDiagnostic((current) => ({
        providerId: id,
        providerName: provider.name,
        progress: { ...(current?.providerId === id ? current.progress : {}), phase: 'Hiba', percent: Math.min(99, Math.max(0, current?.providerId === id ? current.progress?.percent || 0 : 0)) },
        events: diagnosticEventsRef.current,
        error: message,
        startedAt: refreshStartedAt,
        finished: true,
      }));
      providerRefreshActiveRef.current = false;

      // Hálózati szintű hiba (nem jött válasz a szervertől): egyetlen gyors
      // kéréssel megállapítjuk, hogy az internet maga működik-e. Ebből derül
      // ki, hogy valószínűleg az internetszolgáltató blokkolja a szolgáltató
      // szerverét (Wi-Fi-n nem megy, mobilneten igen).
      if (isTransportFailure(message)) {
        // A böngésző pontos hibakódja (ha megkaptuk) sokat elmond az okról.
        const explanation = explainNetError(lastNetErrorHint());
        if (explanation) setDiagnosticError(`${message} ${explanation}`);
        void checkInternetReachable().then((internetOk) => {
          const autoNote =
            retryAttemptsRef.current < 3
              ? ' A program egy percen belül magától újrapróbálja.'
              : ' Több automatikus próbálkozás nem lesz; nyomd meg a Frissítést, amikor a szolgáltató szervere újra elérhető.';
          setDiagnosticError(
            internetOk
              ? `${message} ${explanation} Az internetkapcsolat maga rendben van, tehát a hiba a szolgáltatónál ` +
                `vagy az internetszolgáltatónál van (Wi-Fi-n blokkolás is előfordulhat). ` +
                `A korábban letöltött lista továbbra is használható.${autoNote}`
              : `${message} ${explanation} Úgy tűnik, ezen a hálózaton az internet sem működik. ` +
                `Ellenőrizd a Wi-Fi-t vagy a mobilnetet.${autoNote}`
          );
          // Szolgáltatói hiba esetén automatikus újrapróbálkozás (percenként).
          if (lastRefreshProviderIdRef.current) scheduleAutoRetry(lastRefreshProviderIdRef.current);
        });
      }
    }
  };

  /** Az automatikus újrapróbálkozás leállítása. */
  const cancelAutoRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (retryTickRef.current !== null) {
      window.clearInterval(retryTickRef.current);
      retryTickRef.current = null;
    }
    setRetryCountdown(null);
  }, []);

  /**
   * Ha a szolgáltató szervere átmenetileg nem válaszol, percenként egyszer
   * magától újrapróbáljuk (legfeljebb háromszor). Ez pontosan egy kérés
   * percenként – a hálózatot és a routert nem terheli.
   */
  const scheduleAutoRetry = useCallback(
    (providerId: string) => {
      const MAX_AUTO_RETRY = 3;
      const DELAY_SECONDS = 60;
      if (retryAttemptsRef.current >= MAX_AUTO_RETRY) return;
      retryAttemptsRef.current++;
      cancelAutoRetry();
      setRetryCountdown(DELAY_SECONDS);
      retryTickRef.current = window.setInterval(() => {
        setRetryCountdown((prev) => (prev === null ? null : Math.max(0, prev - 1)));
      }, 1000);
      retryTimerRef.current = window.setTimeout(() => {
        cancelAutoRetry();
        void handleRefreshProvider(providerId, false);
      }, DELAY_SECONDS * 1000);
    },
    [cancelAutoRetry, handleRefreshProvider]
  );

  const closeRefreshDiagnostic = () => {
    diagnosticFinishedRef.current = true;
    setNetworkDiagnosticSink(null);
    setDiagnosticOpen(false);
    setDiagnosticEvents([]);
    setDiagnosticError(null);
    setDiagnosticProgress(null);
  };

  // Sorozat részeinek (évadok) betöltése a szolgáltatótól
  const handleLoadSeriesInfo = useCallback(
    async (target: Series) => {
      const provider = activeProvider;
      if (!provider || provider.type !== 'xtream' || !target.seriesId) return;
      if (!provider.serverUrl || !provider.username || !provider.password) return;

      setLoadingSeriesId(target.id);
      try {
        const info = await xtreamService.seriesInfo(
          provider.serverUrl,
          provider.username,
          provider.password,
          target.seriesId
        );
        const episodesBySeason = info.episodes || {};
        const seasons: Season[] = Object.keys(episodesBySeason)
          .sort((a, b) => Number(a) - Number(b))
          .map((seasonKey) => {
            const episodes = episodesBySeason[seasonKey] || [];
            return {
              seasonNumber: Number(seasonKey),
              name: `${seasonKey}. évad`,
              episodeCount: episodes.length,
              episodes: episodes.map((episode, index) => ({
                id: `ep-${target.id}-${episode.id ?? index}`,
                episodeNumber: Number(episode.episode_num ?? index + 1),
                seasonNumber: Number(seasonKey),
                title: episode.title || `${index + 1}. rész`,
                durationMinutes: (() => {
                  const duration = episode.info?.duration || '';
                  const hours = /(\d+)\s*h/i.exec(duration);
                  const minutes = /(\d+)\s*m/i.exec(duration);
                  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
                  return total || 45;
                })(),
                streamUrl: xtreamService.buildSeriesStreamUrl(
                  provider.serverUrl || '',
                  provider.username || '',
                  provider.password || '',
                  episode.id ?? '',
                  episode.container_extension || 'mp4'
                ),
                plot: episode.info?.plot || '',
                thumbnail: episode.info?.movie_image || target.poster,
              })),
            };
          })
          .filter((season) => season.episodes.length > 0);

        const episodeTotal = seasons.reduce((sum, season) => sum + season.episodes.length, 0);
        setSeries((prev) =>
          prev.map((item) =>
            item.id === target.id
              ? {
                  ...item,
                  seasons,
                  seasonsCount: seasons.length || item.seasonsCount,
                  episodesCount: episodeTotal || item.episodesCount,
                  plot: item.plot || info.info?.plot || '',
                  genres: item.genres.length
                    ? item.genres
                    : (info.info?.genre || '')
                        .split(',')
                        .map((genre) => genre.trim())
                        .filter(Boolean),
                }
              : item
          )
        );
      } catch (error) {
        alert(
          error instanceof Error
            ? `A részek betöltése nem sikerült: ${error.message}`
            : 'A részek betöltése nem sikerült.'
        );
      } finally {
        setLoadingSeriesId('');
      }
    },
    [activeProvider]
  );

  // Play Movie in Main Video Player
  const handlePlayMovie = (movie: Movie) => {
    vodReturnViewRef.current = 'movies';
    setNextEpisodeToPlay(null);
    setCustomStreamUrl(movie.streamUrl);
    setCustomStreamTitle(movie.title);
    setActiveView('live');
    setIsPlaying(true);

    // Add to history
    const historyItem: WatchHistoryItem = {
      id: `hist-${Date.now()}`,
      mediaType: 'movie',
      title: movie.title,
      subtitle: `${movie.durationMinutes} perc • Folytatás`,
      poster: movie.poster,
      progressPercent: 0,
      positionSeconds: 0,
      durationSeconds: movie.durationMinutes * 60,
      lastWatchedAt: new Date().toISOString().slice(0, 10).replace(/-/g, '. ') + '.',
      streamUrl: movie.streamUrl,
    };
    const updatedHistory = [historyItem, ...history.filter((h) => h.title !== movie.title)];
    setHistory(updatedHistory);
    storageService.saveHistory(updatedHistory);
  };

  // Play Series Episode in Main Video Player
  const handlePlayEpisode = (ser: Series, episode: Episode) => {
    vodReturnViewRef.current = 'series';
    const season = ser.seasons.find((s) => s.seasonNumber === episode.seasonNumber);
    const nextEpisode = season?.episodes.find((ep) => ep.episodeNumber === episode.episodeNumber + 1) || null;
    setNextEpisodeToPlay(nextEpisode ? { series: ser, episode: nextEpisode } : null);
    setCustomStreamUrl(episode.streamUrl);
    setCustomStreamTitle(`${ser.title} - ${episode.title}`);
    setActiveView('live');
    setIsPlaying(true);

    // Add to history
    const historyItem: WatchHistoryItem = {
      id: `hist-${Date.now()}`,
      mediaType: 'series',
      title: `${ser.title} - ${episode.title}`,
      subtitle: `${episode.durationMinutes} perc`,
      poster: ser.poster,
      progressPercent: 0,
      positionSeconds: 0,
      durationSeconds: episode.durationMinutes * 60,
      lastWatchedAt: new Date().toISOString().slice(0, 10).replace(/-/g, '. ') + '.',
      streamUrl: episode.streamUrl,
      seriesId: ser.id,
      episodeId: episode.id,
    };
    const updatedHistory = [historyItem, ...history.filter((h) => h.title !== historyItem.title)];
    setHistory(updatedHistory);
    storageService.saveHistory(updatedHistory);
  };

  const handleRemoveWatchHistoryItem = (id: string) => {
    const updatedHistory = history.filter((item) => item.id !== id);
    setHistory(updatedHistory);
    storageService.saveHistory(updatedHistory);
  };

  /**
   * A most játszott film/sorozat hangsáv- és feliratlistája.
   *
   * FONTOS (a telefon lefagyása sorozat-import után): ez korábban közvetlenül a
   * megjelenítésben futott, ezért minden egyes újrarajzoláskor – a lejátszás
   * közben másodpercenként – végigfésülte a 40 000 filmet és a 15 000 sorozat
   * összes epizódját (a `series.flatMap(...)` több tízezer elemet épített).
   * Most csak akkor fut le, ha maga a stream vagy a lista változik.
   */
  const currentVodTracks = useMemo(() => {
    if (!customStreamUrl) return { audioTracks: undefined, subtitleTracks: undefined };
    const movie = movies.find((item) => item.streamUrl === customStreamUrl);
    if (movie) {
      return { audioTracks: movie.audioTracks, subtitleTracks: movie.subtitleTracks };
    }
    for (const item of series) {
      for (const season of item.seasons) {
        for (const episode of season.episodes) {
          if (episode.streamUrl === customStreamUrl) {
            return { audioTracks: episode.audioTracks, subtitleTracks: episode.subtitleTracks };
          }
        }
      }
    }
    return { audioTracks: undefined, subtitleTracks: undefined };
  }, [customStreamUrl, movies, series]);

  /** Az előzmény mentésének legutóbbi időpontja (lásd handlePlaybackProgress). */
  const lastHistorySaveAtRef = useRef(0);

  const handlePlaybackProgress = useCallback((positionSeconds: number, durationSeconds: number) => {
    if (!customStreamUrl || !Number.isFinite(positionSeconds) || positionSeconds < 0) return;
    setHistory((previous) => {
      const index = previous.findIndex((item) => item.streamUrl === customStreamUrl && item.mediaType !== 'live');
      if (index < 0) return previous;
      const current = previous[index];
      const duration = durationSeconds > 0 ? durationSeconds : current.durationSeconds;
      const position = Math.max(0, positionSeconds);
      if (duration > 0 && position >= duration - 5) {
        const updated = previous.filter((item) => item.id !== current.id);
        storageService.saveHistory(updated);
        return updated;
      }
      const progressPercent = duration > 0 ? Math.min(99, Math.max(0, (position / duration) * 100)) : current.progressPercent;
      if (Math.abs(position - current.positionSeconds) < 1 && Math.abs(progressPercent - current.progressPercent) < 0.5) return previous;
      const updated = previous.map((item, itemIndex) => itemIndex === index
        ? { ...item, positionSeconds: position, durationSeconds: duration, progressPercent, lastWatchedAt: new Date().toISOString() }
        : item);
      // A lejátszási helyzet másodpercenként frissül, de a tárolóba legfeljebb
      // 5 másodpercenként írunk: a teljes előzménylista sorosítása és mentése
      // másodpercenként felesleges munkát adott a telefonnak (ez is hozzájárult
      // a nagy listák utáni akadozáshoz).
      const now = Date.now();
      if (now - lastHistorySaveAtRef.current >= 5000) {
        lastHistorySaveAtRef.current = now;
        storageService.saveHistory(updated);
      }
      return updated;
    });
  }, [customStreamUrl]);

  // Resume History item
  const handlePlayHistoryItem = (item: WatchHistoryItem) => {
    vodReturnViewRef.current = item.mediaType === 'series' ? 'series' : 'movies';
    setNextEpisodeToPlay(null);
    setCustomStreamUrl(item.streamUrl);
    setCustomStreamTitle(item.title);
    setActiveView('live');
    setIsPlaying(true);
  };

  // Clear History
  const handleClearHistory = () => {
    setHistory([]);
    storageService.saveHistory([]);
  };

  // Global Keyboard Shortcuts – TV remote, laptop, tablet billentyűzet + egér
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // LG webOS: a távirányító régi kulcsnevet ('Up') vagy csak keyCode-ot
      // (37–40, OK=13, VISSZA=461) küldhet – egységesítjük, különben a TV-n
      // egyetlen gomb sem működne.
      const key = normalizeTvKey(e);

      // Szövegmezőben ne vegyük át a távirányító gombjait.
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      // LG távirányító SZÍNES gombjai – közvetlen menük, bármilyen fókusznál:
      // ZÖLD = Beállítások, SÁRGA = Műsorújság (EPG), KÉK = Kategóriák.
      // (A PIROS a képernyős diagnosztikát kapcsolja, azt a webos.js kezeli.)
      if (key === 'ColorF1Green') {
        e.preventDefault();
        setIsSettingsOpen((prev) => !prev);
        return;
      }
      if (key === 'ColorF2Yellow') {
        e.preventDefault();
        setIsEpgOpen((prev) => !prev);
        return;
      }
      if (key === 'ColorF3Blue') {
        e.preventDefault();
        setIsCategoriesOpen((prev) => !prev);
        return;
      }

      // LG webOS-en nincs minden modellen automatikus D-pad fókuszléptetés:
      // gomb/hivatkozás fókuszánál a nyilakkal a legközelebbi vezérlőre lépünk.
      if (target && (target.tagName === 'BUTTON' || target.tagName === 'A' || target.getAttribute('role') === 'button')) {
        if (isTvArrowKey(key)) {
          const scope = target.closest('[role="dialog"]') || target.closest('header') || target.parentElement;
          if (scope) {
            const candidates = Array.from(scope.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], [role="button"]:not([aria-disabled="true"]), [tabindex="0"]'
            )).filter((el) => el !== target && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
            const from = target.getBoundingClientRect();
            const fx = from.left + from.width / 2;
            const fy = from.top + from.height / 2;
            let best: HTMLElement | null = null;
            let bestScore = Number.POSITIVE_INFINITY;
            for (const candidate of candidates) {
              const r = candidate.getBoundingClientRect();
              const dx = r.left + r.width / 2 - fx;
              const dy = r.top + r.height / 2 - fy;
              const forward = key === 'ArrowRight' ? dx > 2
                : key === 'ArrowLeft' ? dx < -2
                : key === 'ArrowDown' ? dy > 2 : dy < -2;
              if (!forward) continue;
              const primary = key === 'ArrowLeft' || key === 'ArrowRight' ? Math.abs(dx) : Math.abs(dy);
              const secondary = key === 'ArrowLeft' || key === 'ArrowRight' ? Math.abs(dy) : Math.abs(dx);
              const score = primary + secondary * 1.8;
              if (score < bestScore) { best = candidate; bestScore = score; }
            }
            if (best) {
              e.preventDefault();
              e.stopPropagation();
              best.focus({ preventScroll: true });
            } else if (key === 'ArrowDown' && target.closest('header')) {
              // A felső menüsor aljáról lefelé: vissza a csatornalistára.
              const list = document.querySelector<HTMLElement>('[role="listbox"]');
              if (list) {
                e.preventDefault();
                e.stopPropagation();
                list.focus({ preventScroll: true });
              }
            }
          }
        }
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const isInChannelList = !!active?.closest?.('[role="listbox"]') || active?.getAttribute?.('role') === 'option' || !!active?.closest?.('[data-channel-id]');

      switch (key) {
        case 'ArrowUp':
          if (isInChannelList) break; // ChannelList kezeli – ne váltson csatornát
          e.preventDefault();
          if (isCategoriesOpen || isSettingsOpen || isEpgOpen || isAudioModalOpen || isSubtitlesModalOpen) break;
          handlePrevChannel();
          break;
        case 'ArrowDown':
          if (isInChannelList) break;
          e.preventDefault();
          if (isCategoriesOpen || isSettingsOpen || isEpgOpen || isAudioModalOpen || isSubtitlesModalOpen) break;
          handleNextChannel();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (customStreamUrl) {
            // VOD: vissza tekerés laptop/TV-n
            const video = document.querySelector<HTMLVideoElement>('video[data-iptv-player="true"]');
            if (video) video.currentTime = Math.max(0, video.currentTime - settings.seekStep);
          } else {
            // Élő: hangerő le
            handleVolumeChange(Math.max(0, volume - 0.05));
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (customStreamUrl) {
            const video = document.querySelector<HTMLVideoElement>('video[data-iptv-player="true"]');
            if (video) {
              const target = video.currentTime + settings.seekStep;
              video.currentTime = Number.isFinite(video.duration) ? Math.min(video.duration, target) : target;
            }
          } else {
            handleVolumeChange(Math.min(1, volume + 0.05));
          }
          break;
        case 'PageUp':
          // LG távirányító CH+ gomb (keyCode 33)
          e.preventDefault();
          if (isCategoriesOpen || isSettingsOpen || isEpgOpen || isAudioModalOpen || isSubtitlesModalOpen) break;
          handlePrevChannel();
          break;
        case 'PageDown':
          // LG távirányító CH- gomb (keyCode 34)
          e.preventDefault();
          if (isCategoriesOpen || isSettingsOpen || isEpgOpen || isAudioModalOpen || isSubtitlesModalOpen) break;
          handleNextChannel();
          break;
        case 'MediaPlay':
        case 'MediaPause':
          // LG távirányító lejátszás/szünet gombok (415/19)
          e.preventDefault();
          setIsPlaying((prev) => !prev);
          break;
        case 'MediaRewind': {
          const rewindVideo = document.querySelector<HTMLVideoElement>('video[data-iptv-player="true"]');
          if (rewindVideo && customStreamUrl) {
            e.preventDefault();
            rewindVideo.currentTime = Math.max(0, rewindVideo.currentTime - settings.seekStep);
          }
          break;
        }
        case 'MediaFastForward': {
          const ffVideo = document.querySelector<HTMLVideoElement>('video[data-iptv-player="true"]');
          if (ffVideo && customStreamUrl) {
            e.preventDefault();
            const ffTarget = ffVideo.currentTime + settings.seekStep;
            ffVideo.currentTime = Number.isFinite(ffVideo.duration) ? Math.min(ffVideo.duration, ffTarget) : ffTarget;
          }
          break;
        }
        case ' ':
          e.preventDefault();
          if (isCategoriesOpen || isSettingsOpen) break;
          setIsPlaying((prev) => !prev);
          break;
        case 'Enter':
        case 'NumpadEnter':
          // TV remote Enter / DPAD_CENTER – ha csatornalistában van, a lista kezeli
          if (isInChannelList) break;
          if (isCategoriesOpen || isSettingsOpen || isEpgOpen || isAudioModalOpen || isSubtitlesModalOpen) break;
          if (!isVideoFullscreen) {
            // Főoldalon Enter = lejátszás/szünet (ha nincs lista fókusz)
            // TV-n ne csináljon semmit ha listában vagyunk, mert az onClick választ
          }
          break;
        case 'Escape':
        case 'Backspace':
          // TV Back / Esc – modalt zár, fullscreenből kilép
          // Egymásra nyíló ablakoknál (pl. Beállítások fölött Új mappa/QR)
          // a LEGFELSŐ ablak saját kezelője zár – az App nem nyúl bele,
          // különben egyetlen VISSZA mindkét ablakot bezárná.
          if (document.querySelectorAll('[role="dialog"]').length > 1) break;
          if (isAudioModalOpen) { setIsAudioModalOpen(false); break; }
          if (isSubtitlesModalOpen) { setIsSubtitlesModalOpen(false); break; }
          if (isEpgOpen) { setIsEpgOpen(false); break; }
          if (isCategoriesOpen) { setIsCategoriesOpen(false); break; }
          if (isSettingsOpen) { setIsSettingsOpen(false); break; }
          if (isVideoFullscreen) { setIsVideoFullscreen(false); break; }
          if (customStreamUrl) {
            setCustomStreamUrl(undefined);
            setCustomStreamTitle(undefined);
            setActiveView(vodReturnViewRef.current);
          }
          break;
        case 'f':
        case 'F':
          if (!customStreamUrl) setIsVideoFullscreen((prev) => !prev);
          break;
        case 'm':
        case 'M':
          handleToggleMute();
          break;
        case 'c':
        case 'C':
          setIsCategoriesOpen((prev) => !prev);
          break;
        case 's':
        case 'S':
          setIsSettingsOpen((prev) => !prev);
          break;
        case 'q':
        case 'Q':
          setIsQrProvisionOpen((prev) => !prev);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNextChannel, handlePrevChannel, handleVolumeChange, handleToggleMute, isCategoriesOpen, isSettingsOpen, isEpgOpen, isAudioModalOpen, isSubtitlesModalOpen, isVideoFullscreen, customStreamUrl, volume, settings.seekStep]);

  // TV távirányító: ZÖLD/SÁRGA/KÉK gyorsgombok a webos.js-ből egyedi
  // eseményként érkeznek (minden fókuszhelyzetben megbízható).
  useEffect(() => {
    const onTvAction = (e: Event) => {
      const action = (e as CustomEvent)?.detail?.action;
      if (action === 'settings') setIsSettingsOpen((prev) => !prev);
      else if (action === 'epg') setIsEpgOpen((prev) => !prev);
      else if (action === 'categories') setIsCategoriesOpen((prev) => !prev);
    };
    window.addEventListener('iptv-tv-action', onTvAction);
    return () => window.removeEventListener('iptv-tv-action', onTvAction);
  }, []);

  // TV stick: induláskor és modal bezárásakor fókusz a csatornalistára, hogy D-pad azonnal működjön
  useEffect(() => {
    const focusChannelList = () => {
      try {
        const list = document.querySelector('[role="listbox"]') as HTMLElement | null;
        if (!list) return;
        const active = document.activeElement as HTMLElement | null;
        // FÓKUSZRABLÁS TILTVA: csak akkor fókuszálunk a listára, ha jelenleg
        // SEMMINEK nincs fókusza. Korábban a menüben navigáló nézőtől is
        // visszarántotta a fókuszt a csatornalistára ("magától leugrik" hiba).
        if (active && active !== document.body && active !== document.documentElement) return;
        if (!list.contains(active)) {
          list.focus({ preventScroll: true } as any);
        }
      } catch {}
    };
    const t1 = window.setTimeout(focusChannelList, 600);
    const t2 = window.setTimeout(focusChannelList, 1800);
    const t3 = window.setTimeout(focusChannelList, 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [channels.length]);

  // TV: amikor bezárul egy modal, fókusz vissza a listára
  useEffect(() => {
    if (!isCategoriesOpen && !isSettingsOpen && !isEpgOpen && !isAudioModalOpen && !isSubtitlesModalOpen) {
      const focusBack = () => {
        try {
          const list = document.querySelector('[role="listbox"]') as HTMLElement | null;
          if (list) {
            list.focus({ preventScroll: true } as any);
            // Ha van kiválasztott csatorna, görgess oda
            const active = document.activeElement as HTMLElement | null;
            if (active?.closest?.('[role="dialog"]')) {
              list.focus();
            }
          }
        } catch {}
      };
      const t = window.setTimeout(focusBack, 150);
      return () => clearTimeout(t);
    }
  }, [isCategoriesOpen, isSettingsOpen, isEpgOpen, isAudioModalOpen, isSubtitlesModalOpen]);

  return (
    <div className="flex flex-col h-[100dvh] min-h-[100dvh] w-full min-w-0 max-w-none bg-[#080d1a] text-slate-100 overflow-hidden font-sans select-none shadow-2xl border-x border-cyan-950/40">
      
      {/* Top Header Bar (Exact match to screenshot 1/2/3/4/5/6) */}
      {!isVideoFullscreen && <Header
        activeView={activeView}
        onViewChange={(view) => {
          setActiveView(view);
          if (view === 'live') {
            // Visszatéréskor mindig az utoljára nézett élő csatorna töltődjön be újra.
            setCustomStreamUrl(undefined);
            setCustomStreamTitle(undefined);
            setIsPlaying(true);
          } else {
            // Filmek/sorozatok böngészése közben az élő adás ne fusson a háttérben.
            setIsPlaying(false);
            setCustomStreamUrl(undefined);
            setCustomStreamTitle(undefined);
          }
        }}
        onOpenCategories={() => setIsCategoriesOpen(true)}
        onOpenSettings={(tab) => {
          // A Beállítások gomb alapból közvetlenül a Kedvencek fülre nyit.
          // Csak a kifejezetten kért fül (pl. Rendszer) nyíljon meg külön.
          setSettingsTab(!tab ? 'favorites' : tab === 'channels' ? 'system' : tab);
          setIsSettingsOpen(true);
        }}
      />}

      {/* Main View Switcher */}

      {activeView === 'movies' ? (
        <MoviesView
          movies={movies}
          categories={vodCategories}
          totalCount={totalCounts.vod}
          settings={settings}
          onPlayMovie={handlePlayMovie}
          selectedCategoryId={movieCategoryRef.current}
          onSelectedCategoryChange={(categoryId) => { movieCategoryRef.current = categoryId; }}
          onBackToLive={() => {
            setCustomStreamUrl(undefined);
            setCustomStreamTitle(undefined);
            setActiveView('live');
            setIsPlaying(true);
          }}
          onToggleFavoriteMovie={handleToggleFavoriteMovie}
        />
      ) : activeView === 'series' ? (
        <SeriesView
          series={series}
          categories={seriesCategories}
          totalCount={totalCounts.series}
          loadingSeriesId={loadingSeriesId}
          onOpenSeries={handleLoadSeriesInfo}
          settings={settings}
          onPlayEpisode={handlePlayEpisode}
          selectedCategoryId={seriesCategoryRef.current}
          onSelectedCategoryChange={(categoryId) => { seriesCategoryRef.current = categoryId; }}
          onBackToLive={() => {
            setCustomStreamUrl(undefined);
            setCustomStreamTitle(undefined);
            setActiveView('live');
            setIsPlaying(true);
          }}
          onToggleFavoriteSeries={handleToggleFavoriteSeries}
        />
      ) : (
        /* Live TV View – reszponzív: mobilon egymás alatt, tablet/laptop/TV-n egymás mellett */
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden min-h-0">
          {/* Video + Controls – mobilon felül, desktopon bal oldalt rugalmas */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-0 md:min-w-0">
          {/* Video Player */}
          <VideoPlayer
            channel={activeChannel}
            customStreamUrl={customStreamUrl}
            customTitle={customStreamTitle}
            onCloseVod={() => {
              // Az OSD piros X-e bezárja a VOD-lejátszót; az App saját
              // teljes képernyős állapotát is azonnal vissza kell állítani,
              // különben a felső TV/Film/Sorozat menü rejtve marad.
              // Bezáráskor a legfrissebb lejátszási helyzetet mentjük (a
              // lejátszás közben csak 5 másodpercenként írunk a tárolóba).
              storageService.saveHistory(history);
              setIsVideoFullscreen(false);
              setCustomStreamUrl(undefined);
              setCustomStreamTitle(undefined);
              setActiveView(vodReturnViewRef.current);
              setIsPlaying(false);
              setNextEpisodeToPlay(null);
            }}
            initialPositionSeconds={history.find((item) => item.streamUrl === customStreamUrl && item.mediaType !== 'live')?.positionSeconds || 0}
            onProgress={handlePlaybackProgress}
            audioTracks={currentVodTracks.audioTracks}
            subtitleTracks={currentVodTracks.subtitleTracks}
            settings={settings}
            onNextChannel={handleNextChannel}
            onPrevChannel={handlePrevChannel}
            onOpenSettings={() => {
              setSettingsTab('system');
              setIsSettingsOpen(true);
            }}
            onEnded={() => {
              if (settings.autoNextEpisode && nextEpisodeToPlay) {
                handlePlayEpisode(nextEpisodeToPlay.series, nextEpisodeToPlay.episode);
              }
            }}
            onOverlayVisibilityChange={setIsOsdVisible}
            isPlaying={isPlaying}
            setIsPlaying={setIsPlaying}
            volume={volume}
            onVolumeChange={handleVolumeChange}
            onToggleMute={handleToggleMute}
            onRegisterTogglePlay={(togglePlay) => {
              mainPlayerToggleRef.current = togglePlay;
            }}
            onRegisterCast={(castToTv) => {
              mainPlayerCastRef.current = castToTv;
            }}
            onRegisterPip={(togglePip) => {
              mainPlayerPipRef.current = togglePip;
            }}
            onFullscreenChange={setIsVideoFullscreen}
            onRegisterOsdToggle={(toggle) => {
              mainPlayerOsdToggleRef.current = toggle;
            }}
            onAudioTracksChange={setLiveAudioTracks}
            onRegisterAudioTrackSelector={registerMainPlayerAudioSelector}
            onSubtitleTracksChange={setLiveSubtitleTracks}
            onRegisterSubtitleTrackSelector={registerMainPlayerSubtitleSelector}
          />

          {/*
            Teljes képernyős OSD élő TV-nél: pontosan a főoldali panel
          */}
          {!customStreamUrl && isVideoFullscreen && !isLandscapeFullscreen && isOsdVisible && activeChannel && (
            <div className="fixed inset-x-2 bottom-2 z-[10000] pointer-events-none">
              <div className="pointer-events-auto">
                <ChannelControls
                  channel={activeChannel}
                  displayNumber={activeChannelDisplayNumber}
                  isPlaying={isPlaying}
                  onTogglePlay={() => mainPlayerToggleRef.current?.()}
                  volume={volume}
                  onVolumeChange={handleVolumeChange}
                  onToggleMute={handleToggleMute}
                  onPrevChannel={handlePrevChannel}
                  onNextChannel={handleNextChannel}
                  onToggleFavorite={handleToggleFavorite}
                  onOpenAudioModal={() => setIsAudioModalOpen(true)}
                  hasMultipleAudioTracks={liveAudioTracks.length > 1}
                  hasActiveSubtitle={liveSubtitleTracks.some((track) => track.selected === true)}
                  onOpenSubtitlesModal={() => setIsSubtitlesModalOpen(true)}
                  onCastToTv={() => mainPlayerCastRef.current?.()}
                  onTogglePip={() => mainPlayerPipRef.current?.()}
            showPip={Boolean((document as any).pictureInPictureEnabled && typeof (document.querySelector('video[data-iptv-player="true"]') as any)?.requestPictureInPicture === 'function')}
                  onOpenEpgModal={() => setIsEpgOpen(true)}
                  onOpenChannelDetails={() => {
                    setSettingsTab('system');
                    setIsSettingsOpen(true);
                  }}
                  onRequestHide={() => mainPlayerOsdToggleRef.current?.()}
                  hideHeaderActions
                />
              </div>
            </div>
          )}

          {/* TV-only channel controls: film/sorozat közben a VOD OSD az egyetlen lejátszóvezérlő. */}
          {!customStreamUrl && !isVideoFullscreen && isOsdVisible && <ChannelControls
            channel={activeChannel}
            displayNumber={activeChannelDisplayNumber}
            isPlaying={isPlaying}
            onTogglePlay={() => mainPlayerToggleRef.current?.()}
            volume={volume}
            onVolumeChange={handleVolumeChange}
            onToggleMute={handleToggleMute}
            onPrevChannel={handlePrevChannel}
            onNextChannel={handleNextChannel}
            onToggleFavorite={handleToggleFavorite}
            onOpenAudioModal={() => setIsAudioModalOpen(true)}
            hasMultipleAudioTracks={liveAudioTracks.length > 1}
            hasActiveSubtitle={liveSubtitleTracks.some((track) => track.selected === true)}
            onOpenSubtitlesModal={() => setIsSubtitlesModalOpen(true)}
            onCastToTv={() => mainPlayerCastRef.current?.()}
            onTogglePip={() => mainPlayerPipRef.current?.()}
                  showPip={Boolean((document as any).pictureInPictureEnabled && typeof (document.querySelector('video[data-iptv-player="true"]') as any)?.requestPictureInPicture === 'function')}
            onOpenEpgModal={() => setIsEpgOpen(true)}
            onOpenChannelDetails={() => {
              setSettingsTab('system');
              setIsSettingsOpen(true);
            }}
          />}
          </div>
          {/* Virtualized Fast Channel List – reszponzív oldalsáv */}
          {!isVideoFullscreen && !customStreamUrl && (
            <div className="flex-1 md:flex-none md:w-[380px] lg:w-[420px] xl:w-[480px] 2xl:w-[560px] flex flex-col overflow-hidden min-h-0 border-t md:border-t-0 md:border-l border-cyan-950/40 bg-[#070e1e]">
              <ChannelList
                channels={filteredChannels}
                activeProvider={activeProvider}
                epgReady={providerContentReady}
                epgRevision={epgRevision}
                selectedChannelId={activeChannelId}
                onSelectChannel={handleSelectChannel}
                onToggleFavorite={handleToggleFavorite}
                onDeleteChannel={handleDeleteChannel}
                onMoveChannel={handleMoveChannel}
                onReorderChannels={handleReorderChannels}
                categories={categories}
                folders={folders}
                selectedCategoryId={selectedCategoryId}
                isOnlyFavorites={isOnlyFavorites}
                selectedFavoriteFolderId={selectedFavoriteFolderId}
                onDisplayOrderChange={handleDisplayOrderChange}
                onSelectFavoriteFolder={(folderId) => {
                  if (folderId) {
                    if (!selectedFavoriteFolderId) previousCategoryBeforeFolderRef.current = selectedCategoryId;
                    setSelectedFavoriteFolderId(folderId);
                    setSelectedCategoryId('all');
                    setIsOnlyFavorites(false);
                  } else {
                    setSelectedFavoriteFolderId(null);
                    const previousCategory = previousCategoryBeforeFolderRef.current;
                    if (previousCategory) setSelectedCategoryId(previousCategory);
                    setIsOnlyFavorites(previousCategory === 'favorites');
                    previousCategoryBeforeFolderRef.current = null;
                  }
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* ================= MODALS & DRAWERS ================= */}

      <LoadingDiagnosticModal
        isOpen={lastImportDiagnosticOpen && Boolean(lastImportDiagnostic)}
        progress={lastImportDiagnostic?.progress ?? null}
        events={lastImportDiagnostic?.events ?? []}
        channels={channels}
        logoSource={providers.find((provider) => provider.id === lastImportDiagnostic?.providerId)?.type ?? 'unknown'}
        error={lastImportDiagnostic?.error ?? null}
        startedAt={lastImportDiagnostic?.startedAt ?? performance.now()}
        onClose={() => setLastImportDiagnosticOpen(false)}
      />

      <LoadingDiagnosticModal
        isOpen={diagnosticOpen}
        progress={diagnosticProgress}
        events={diagnosticEvents}
        channels={channels}
        logoSource={providers.find((provider) => provider.id === lastRefreshProviderIdRef.current)?.type ?? 'unknown'}
        error={diagnosticError}
        startedAt={diagnosticStartedAt}
        onClose={closeRefreshDiagnostic}
        onRetry={
          diagnosticError && lastRefreshProviderIdRef.current
            ? () => void handleRefreshProvider(lastRefreshProviderIdRef.current as string)
            : undefined
        }
        retryInSeconds={retryCountdown}
      />

      {refreshLivePromptOpen && (
        <div role="dialog" aria-modal="true" aria-label="Az élő TV-csatornák frissítve" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRefreshLivePromptOpen(false); } }} className="fixed inset-0 z-[115] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-cyan-400/50 bg-[#081329] p-5 text-white shadow-2xl">
            <div className="text-lg font-black text-cyan-200">Az élő TV-csatornák frissítve</div>
            <p className="mt-2 text-sm text-slate-300">A filmek és sorozatok frissítése még folyamatban van. Szeretnéd tovább nézni a diagnosztikát, vagy folytassuk a háttérben?</p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button onClick={() => setRefreshLivePromptOpen(false)} className="py-3 rounded-xl border border-slate-600 bg-white/5 hover:bg-white/10 text-white font-bold">Nem, tovább nézem</button>
              <button onClick={() => { setRefreshLivePromptOpen(false); setDiagnosticOpen(false); setLastImportDiagnosticOpen(false); setIsSettingsOpen(false); }} className="py-3 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-black">Bezár, háttérben</button>
            </div>
          </div>
        </div>
      )}

      {/* 1. Kategóriák Drawer */}
      <CategoriesModal
        isOpen={isCategoriesOpen}
        onClose={() => setIsCategoriesOpen(false)}
        categories={countryCategories}
        channels={channels}
        selectedCategoryId={selectedCategoryId}
        onSelectCategory={(catId) => {
          setSelectedFavoriteFolderId(null);
          setSelectedCategoryId(catId);
          setSelectedSubCategoryId(null);
          setIsOnlyFavorites(catId === 'favorites');
        }}
        onSelectSubCategory={(countryCategoryId, subCategoryId) => {
          setSelectedFavoriteFolderId(null);
          setSelectedCategoryId(countryCategoryId);
          setSelectedSubCategoryId(subCategoryId);
          setIsOnlyFavorites(false);
        }}
        totalChannelsCount={channels.length}
        isOnlyFavorites={isOnlyFavorites}
        setIsOnlyFavorites={setIsOnlyFavorites}
        onSearchQueryChange={setCategorySearchQuery}
        onSelectSearchChannel={(channelId) => setActiveChannelId(channelId)}
      />

      {/* 2. Menü & Beállítások Modal (4 Tabs) */}
      <MenuSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        activeTab={settingsTab}
        setActiveTab={setSettingsTab}
        channels={channels}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        providers={providers}
        onOpenAddProvider={() => { setEditingProvider(null); setIsAddProviderOpen(true); }}
        onEditProvider={(provider) => { setEditingProvider(provider); setIsAddProviderOpen(true); }}
        onDeleteProvider={handleDeleteProvider}
        onRefreshProvider={handleRefreshProvider}
        onOpenImportDiagnostic={(provider) => {
          // A napló bármikor megnyitható legyen, akkor is, ha az első import
          // pillanatfelvétele még nem kapta meg a szolgáltató azonosítóját.
          setLastImportDiagnostic((current) => {
            if (current && (current.providerId === provider.id || current.providerName === provider.name)) {
              return { ...current, providerId: provider.id, providerName: provider.name };
            }
            return {
              providerId: provider.id,
              providerName: provider.name,
              progress: {
                phase: 'Betöltési diagnosztika',
                detail: `${provider.channelsCount.toLocaleString('hu-HU')} csatorna • ${provider.moviesCount.toLocaleString('hu-HU')} film • ${provider.seriesCount.toLocaleString('hu-HU')} sorozat`,
                percent: 100,
              },
              events: [],
              error: null,
              startedAt: performance.now(),
              finished: true,
            };
          });
          setLastImportDiagnosticOpen(true);
        }}
        folders={folders}
        onOpenAddFolder={() => setIsOrderModalOpen(true)}
        onDeleteFolder={handleDeleteFolder}
        onToggleFavorite={handleToggleFavorite}
        onMoveFavoriteChannel={handleMoveFavoriteChannel}
        onRemoveChannelFromFolder={handleRemoveChannelFromFolder}
        onOpenEpgModal={() => setIsEpgOpen(true)}
        onOpenQrProvision={() => setIsQrProvisionOpen(true)}
        watchHistory={history}
        onContinueWatching={handlePlayHistoryItem}
        onRemoveWatchHistoryItem={handleRemoveWatchHistoryItem}
      />

      {/* 3.5 QR Telefonos beállítás – TV-n nem kell pötyögni */}
      <QrProvisionModal
        isOpen={isQrProvisionOpen}
        onClose={() => setIsQrProvisionOpen(false)}
        onProviderReceived={handleQrProviderReceived}
      />

      {/* 4. EPG Guide Modal */}
      <EpgGuideModal
        isOpen={isEpgOpen}
        onClose={() => setIsEpgOpen(false)}
        activeChannel={activeChannel}
        channels={channels}
        activeProvider={activeProvider}
        onSelectChannel={handleSelectChannel}
      />

      {/* 5. Audio & Subtitles Modal */}
      <AudioSubtitlesModal
        isOpen={isAudioModalOpen || isSubtitlesModalOpen}
        mode={isSubtitlesModalOpen ? 'subtitle' : 'audio'}
        onClose={() => {
          setIsAudioModalOpen(false);
          setIsSubtitlesModalOpen(false);
        }}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        audioTracks={liveAudioTracks}
        onSelectAudioTrack={(track) => {
          const selector = mainPlayerAudioSelectRef.current;
          if (selector) {
            selector(track);
          } else {
            appLog('A TV böngészőjében a hangsávváltás nem érhető el natív hangsávlista nélkül.');
          }
        }}
        subtitleTracks={liveSubtitleTracks}
        onSelectSubtitleTrack={(track) => mainPlayerSubtitleSelectRef.current?.(track)}
      />

      {/* 6. Add Provider / Xtream Codes Modal */}
      <AddPlaylistModal
        isOpen={isAddProviderOpen}
        onClose={() => setIsAddProviderOpen(false)}
        onBackgroundContinue={() => {
          setIsAddProviderOpen(false);
          setIsSettingsOpen(false);
        }}
        onAddProvider={handleAddProvider}
        editProvider={editingProvider}
        onDiagnosticUpdate={(snapshot) => setLastImportDiagnostic(snapshot)}
        onLiveChannelsLoaded={(partial) => {
          if (partial.channels) {
            const incomingCountries = buildCountryCategories(partial.channels);
            const selectedStillExists = incomingCountries.some((country) => country.id === selectedCategoryId);
            const effectiveCategoryId =
              selectedCategoryId === 'all' || !selectedCategoryId.startsWith('country-') || !selectedStillExists
                ? findHungaryCategoryId(incomingCountries) || selectedCategoryId
                : selectedCategoryId;
            if (effectiveCategoryId !== selectedCategoryId) setSelectedCategoryId(effectiveCategoryId);
            const orderedChannels = hungaryFirst(partial.channels);
            setChannels(orderedChannels);
            const selectedCountryCode = effectiveCategoryId.startsWith('country-')
              ? effectiveCategoryId.slice('country-'.length)
              : 'HU';
            const firstSelectedChannel = orderedChannels.find((channel) =>
              (channel.countryCode || 'INT').toUpperCase() === selectedCountryCode
            );
            if (firstSelectedChannel) setActiveChannelId(firstSelectedChannel.id);
          }
          if (partial.liveCategories) setCategories(partial.liveCategories);
          if (partial.totals) setTotalCounts((previous) => ({ live: partial.totals?.live ?? previous.live, vod: partial.totals?.vod ?? previous.vod, series: partial.totals?.series ?? previous.series }));
        }}
      />

      {/* 7. Channel Order & Folders Modal */}
      <ChannelOrderModal
        isOpen={isOrderModalOpen}
        onClose={() => { setIsOrderModalOpen(false); setFavoriteChannelId(null); }}
        folders={folders}
        onSaveFolders={handleSaveFolders}
        channelToFavoriteId={favoriteChannelId}
        onAssignChannelToFolder={handleAssignChannelToFolder}
      />

      {/* 8. Resume History Modal */}
      <ResumeHistoryModal
        isOpen={isResumeModalOpen}
        onClose={() => setIsResumeModalOpen(false)}
        history={history}
        onPlayItem={handlePlayHistoryItem}
        onClearHistory={handleClearHistory}
      />
    </div>
  );
}

export default App;