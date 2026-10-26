import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
  sweepStorage,
} from './services/contentStore';
import { appLog, appLogError, logMemory, logPhase } from './services/appLog';
import { normalizeTvKey, isTvArrowKey } from './utils/tvKeys';
import { loadAllLiveChannels, loadLiveChannelsForCategories, PartialContent, refreshProviderContent } from './services/providerImport';
import { flagFor } from './utils/flags';
import { clearEpgCache, getCachedShortEpg, loadShortEpg, nowNextFromEpg, streamIdFor } from './services/epgService';
import { xtreamService } from './services/xtreamService';
import { parseEpisodeMetadata, parseSeriesMetadata, UNKNOWN_LANGUAGE } from './services/vodMetadata';

// Induláskor a korábban betöltött szolgáltatói lista töltődik be. Demó adat
// helyett üres listát mutatunk, és a felület felhívja a figyelmet a lista
// hozzáadására (Menü → Listák).
const bootLive = loadLive();
logPhase('mentett élő lista beolvasva (App modul)');
// A betöltött tár régi vagy sérült adatait már az állapot létrehozásakor normalizáljuk.
const bootChannels = Array.isArray(bootLive.channels) ? bootLive.channels : [];

function restoreSavedChannelOrder(channels: Channel[], providerId?: string): Channel[] {
  if (!providerId || channels.length < 2) return channels;
  const savedOrder = storageService.getChannelOrder(providerId);
  if (!savedOrder.length) return channels;
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const restored: Channel[] = [];
  const used = new Set<string>();
  for (const id of savedOrder) {
    const channel = byId.get(id);
    if (channel && !used.has(id)) {
      restored.push(channel);
      used.add(id);
    }
  }
  for (const channel of channels) {
    if (!used.has(channel.id)) restored.push(channel);
  }
  return restored;
}

function preserveChannelPreferences(incoming: Channel[], existing: Channel[], preserveOrder = true): Channel[] {
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
          orderIndex: preserveOrder ? match.channel.orderIndex : incomingIndex,
          isFavorite: match.channel.isFavorite,
        },
        previousIndex: match.index,
        incomingIndex,
      };
    })
    // A már meglévő csatornák megtartják a felhasználó sorrendjét; az új csatornák a végére kerülnek.
    .sort((a, b) => preserveOrder
      ? a.previousIndex - b.previousIndex || a.incomingIndex - b.incomingIndex
      : a.incomingIndex - b.incomingIndex)
    .map(({ channel }) => channel);
}

function buildCountryCategories(channels: Channel[], providerCategories: Category[] = []): Category[] {
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
  /*
   * MINDEN ORSZÁG NEVE MÁR INDULÁSKOR ELÉRHETŐ (a néző 3. kérése).
   *
   * Induláskor csak a magyar csatornák töltődnek le, így a csatornákból egyedül
   * Magyarország adódna – a többi ország el is tűnne a listából. Ezért az
   * országokat a szolgáltató ÉLŐ KATEGÓRIÁIBÓL is képezzük: azok a kicsi
   * kategóriaválasszal már induláskor megvannak, és a nevükből ugyanaz a
   * szabály állapítja meg az országot, mint a csatornáknál. A csatornaszám 0,
   * amíg a néző meg nem nyitja azt az országot – akkor töltődnek le.
   */
  const safeProviderCategories = Array.isArray(providerCategories) ? providerCategories : [];
  for (const category of safeProviderCategories) {
    const info = flagFor(String(category.name || ''));
    const code = (info.countryCode || 'INT').toUpperCase();
    const current = grouped.get(code) || {
      name: info.country || 'Nemzetközi',
      flag: info.flag || '📺',
      channelCount: 0,
      subCategories: new Set<string>(),
    };
    if (category.id) current.subCategories.add(category.id);
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

/**
 * A magyar csatornák előre, a többi mögötte – a lista eredeti sorrendjének
 * megtartásával.
 *
 * TELJESÍTMÉNY: korábban `map` + `sort` volt, a comparatoron belül pedig
 * csatornánként (minden összehasonlításnál!) egy reguláris kifejezés futott.
 * 20–60 ezer csatornánál ez több százezer regex-illesztést és egy
 * O(n log n) rendezést jelentett – a TV-n másodpercekig tartott, és minden
 * betöltési szakasz (előnézet, végleges lista, frissítés) után lefutott.
 * A magyar besorolást most EGYSZER számoljuk ki, a szétválasztás pedig
 * stabil, lineáris (O(n)) művelet.
 */
function hungaryFirst(list: Channel[]): Channel[] {
  if (list.length === 0) return list;
  const hungarian: Channel[] = [];
  const rest: Channel[] = [];
  for (let index = 0; index < list.length; index++) {
    const channel = list[index];
    const isHungary =
      channel.countryCode?.toUpperCase() === 'HU' ||
      channel.country === 'Magyarország' ||
      /\b(magyarország|hungary|hungarian)\b/i.test(channel.categoryName || '');
    if (isHungary) hungarian.push(channel);
    else rest.push(channel);
  }
  if (rest.length === 0) return hungarian;
  if (hungarian.length === 0) return rest;
  return hungarian.concat(rest);
}

/**
 * Két kategórialista ugyanaz-e (azonosító + név szerint)?
 *
 * A szolgáltatói frissítés minden szakaszban ÚJ tömböt ad vissza akkor is,
 * ha a kategóriák nem változtak. Ha ezt változatlanul beírjuk az állapotba,
 * a kategóriamodál és a fejléc (országok) feleslegesen újrarajzolódik –
 * a távirányítóval görgetett lista pedig visszaugrik az elejére. Ezért csak
 * akkor frissítünk, ha a lista tartalma tényleg más.
 */
function sameCategories(current: Category[], next: Category[]): boolean {
  if (current === next) return true;
  if (current.length !== next.length) return false;
  for (let index = 0; index < current.length; index++) {
    if (current[index].id !== next[index].id || current[index].name !== next[index].name) return false;
  }
  return true;
}

/**
 * Egy listát csak akkor írunk a felületre, ha NEM üresítjük ki vele a már
 * megjelenített, jó listát.
 *
 * A szolgáltató előfordul, hogy átmenetileg üres választ ad (karbantartás,
 * kapcsolathiba). A referencia alkalmazás is így tesz: `if (!fresh.length)
 * return` – a jó, mentett lista marad a képernyőn, nem lesz „nincs adat”
 * villanás, és nem írjuk felül a mentett listát sem üres tartalommal.
 */
function keepIfFilled<T>(current: T[], next: T[] | undefined): T[] | null {
  if (!next) return null;
  if (next.length === 0 && current.length > 0) return null;
  return next;
}
import { Header } from './components/Header';
import { VideoPlayer } from './components/VideoPlayer';
import { ChannelControls, FullscreenLiveOsd } from './components/ChannelControls';
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
  isNetworkRequestCancelled,
  isTransportFailure,
  lastNetErrorHint,
  resetNetworkBreaker,
  setNetworkDiagnosticSink,
  NetworkDiagnosticEvent,
} from './services/net';
import { ChannelOrderModal } from './components/ChannelOrderModal';
import { ResumeHistoryModal } from './components/ResumeHistoryModal';
import { QrProvisionModal } from './components/QrProvisionModal';
import { DiagnosticShareModal } from './components/DiagnosticShareModal';

export function App() {
  // Persistent state
  const [settings, setSettings] = useState<AppSettings>(() => storageService.getSettings());
  const [providers, setProviders] = useState<ProviderAccount[]>(() => storageService.getProviders());
  const [channels, setChannels] = useState<Channel[]>(() => restoreSavedChannelOrder(hungaryFirst(bootChannels), bootLive.provider?.id));
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
  const [diagnosticFinishedAt, setDiagnosticFinishedAt] = useState<number | null>(null);
  const [lastImportDiagnostic, setLastImportDiagnostic] = useState<{ providerId?: string; providerName: string; progress: any; events: NetworkDiagnosticEvent[]; error: string | null; startedAt: number; finished: boolean; finishedAt?: number | null } | null>(null);
  const [lastImportDiagnosticOpen, setLastImportDiagnosticOpen] = useState(false);
  const [refreshLivePromptOpen, setRefreshLivePromptOpen] = useState(false);
  const diagnosticEventsRef = useRef<NetworkDiagnosticEvent[]>([]);
  const refreshLivePromptShownRef = useRef(false);
  const diagnosticFinishedRef = useRef(false);
  /**
   * A diagnosztika felületre írásának ritkítása (lásd handleRefreshProvider).
   * A napló a memóriában azonnal gyűlik; a React csak 250 ms-onként rajzol.
   */
  const DIAGNOSTIC_FLUSH_MS = 250;
  const diagFlushTimerRef = useRef<number | null>(null);
  const lastProgressPaintRef = useRef(0);
  const pushDiagnosticEvents = useCallback(() => {
    diagFlushTimerRef.current = null;
    // A lezárt import vagy a bezárt diagnosztika után egy késői hálózati
    // callback sem indíthat új React-renderelést.
    if (diagnosticFinishedRef.current) return;
    setDiagnosticEvents(diagnosticEventsRef.current);
    setLastImportDiagnostic((current) => (current && !current.finished)
      ? { ...current, events: diagnosticEventsRef.current }
      : current);
  }, []);
  const scheduleDiagnosticFlush = useCallback(() => {
    if (diagnosticFinishedRef.current || diagFlushTimerRef.current !== null) return;
    diagFlushTimerRef.current = window.setTimeout(pushDiagnosticEvents, DIAGNOSTIC_FLUSH_MS);
  }, [pushDiagnosticEvents]);
  const cancelDiagnosticFlush = useCallback(() => {
    if (diagFlushTimerRef.current !== null) {
      window.clearTimeout(diagFlushTimerRef.current);
      diagFlushTimerRef.current = null;
    }
  }, []);
  const flushDiagnosticNow = useCallback(() => {
    cancelDiagnosticFlush();
    setDiagnosticEvents(diagnosticEventsRef.current);
  }, [cancelDiagnosticFlush]);
  const providerRefreshActiveRef = useRef(false);
  // Az előző import maradék, már CPU-n futó callbackjei sem írhatják felül
  // egy új frissítés diagnosztikáját/tartalmát.
  const refreshGenerationRef = useRef(0);
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
  /**
   * Már MEGNYITOTT nézetek.
   *
   * A Mozi és a Sorozat nézet a legelső megnyitás után a DOM-ban marad (csak
   * elrejtjük), így a fejléc TV/Mozi/Sorozat gombjai közti váltás azonnali:
   * nincs teljes újraépítés, nincs újra-betöltés, nincs villanás. A keresés,
   * a kategória és a görgetési pozíció is megmarad, amikor visszatérünk.
   * Első megnyitáskor épül fel egyszer (ez az egyetlen költség).
   */
  const [visitedViews, setVisitedViews] = useState<Record<string, boolean>>(() => ({
    live: true,
    [savedUiState.current.activeView || 'live']: true,
  }));
  // VOD bezárásakor ugyanahhoz a könyvtárnézethez és kategóriához térünk vissza.
  const vodReturnViewRef = useRef<'movies' | 'series'>('movies');
  // Külön visszatérési útvonal a Beállítások > Kedvencek > Folytatás listájából indított VOD-hoz.
  // A normál Mozi/Sorozat böngészés visszatérését ez nem módosíthatja.
  const returnToFavoritesSettingsRef = useRef(false);
  const lastResumeHistoryIdRef = useRef<string | null>(null);
  /**
   * A LEGUTÓBB INDÍTOTT FILM/EPIZÓD – ide tér vissza a fókusz a lejátszó
   * bezárásakor (a felhasználó kérése: „a kiválasztás helyére ugorjon”).
   */
  const lastVodSelectionRef = useRef<{ view: 'movies' | 'series'; cardId: string; episodeId?: string } | null>(null);
  const movieCategoryRef = useRef('all');
  const seriesCategoryRef = useRef('all');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(() =>
    // Induláskor mindig Magyarország legyen a főoldali csatornalista,
    // ne a korábban elmentett vagy az első országcsoport.
    findHungaryCategoryId(buildCountryCategories(bootChannels)) || 'all'
  );
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
  /** Kedvenc mappa kiválasztása – stabil függvény, hogy a lista ne rajzolódjon feleslegesen. */
  const handleSelectFavoriteFolder = useCallback((folderId: string | null) => {
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
  }, [selectedFavoriteFolderId, selectedCategoryId]);

  useEffect(() => {
    storageService.saveUiState({ activeView, selectedCategoryId, isOnlyFavorites, searchQuery });
  }, [activeView, selectedCategoryId, isOnlyFavorites, searchQuery]);

  /**
   * A NÉZETT csatorna műsora (most/elkövetkező) külön, kis állapotban.
   *
   * FONTOS (a csatornaváltás lassúsága): korábban az EPG-frissítés a TELJES
   * csatornatömböt (20-60 ezer elem) újraépítette egy `map`-pel. Ettől minden
   * nagy memo (országkategóriák, szűrt lista, sorszám, ID-térkép) újraszámolódott,
   * a csatornalista pedig teljesen újrarajzolódott – éppen a váltás pillanatában.
   * Most csak ez az egy bejegyzés változik, a `channels` tömb azonos marad.
   */
  const [activeEpg, setActiveEpg] = useState<{ id: string; now?: Channel['epgNow']; next?: Channel['epgNext']; upcoming?: Channel['epgUpcoming'] } | null>(null);

  // Active Channel / Media State
  const [activeChannelId, setActiveChannelId] = useState<string>(() => {
    const saved = storageService.getLastChannelId() || settings.lastPlayedChannelId;
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

  /*
   * ÉLŐ ÉRTÉKEK A HÁTTÉRBEN FUTÓ SZOLGÁLTATÓ-FRISSÍTÉSHEZ.
   *
   * A `handleRefreshProvider` akár több percig is fut, és ezalatt a néző
   * csatornát vált. A függvény viszont a RÉGI renderből lezárt (stale)
   * `activeChannelId` / `activeProvider` / `channels` értékeket látta, ezért a
   * betöltés végén rosszul döntött:
   *
   *   • a lezárt `activeProvider` még a frissítés ELŐTTI volt, így a
   *     „másik szolgáltató” ág futott le, és a kijelölés az új lista ELSŐ
   *     csatornájára ugrott;
   *   • a lezárt `activeChannelId` már nem létezett a friss listában (a néző
   *     közben váltott), ezért a program „elveszett” csatornának hitte, és
   *     átváltott a lista első – gyakran NEM magyar – csatornájára.
   *
   * Ez volt a „TV-nézés közben magától másik csatornára ugrik az OSD” hiba.
   * A döntések most a commit utáni, tényleges állapotot olvassák.
   */
  const activeChannelIdRef = useRef(activeChannelId);
  const activeProviderRef = useRef(activeProvider);
  const channelsRef = useRef(channels);
  const categoriesRef = useRef(categories);
  const vodCategoriesRef = useRef(vodCategories);
  const seriesCategoriesRef = useRef(seriesCategories);
  const moviesRef = useRef(movies);
  const seriesRef = useRef(series);
  const selectedCategoryIdRef = useRef(selectedCategoryId);
  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
    activeProviderRef.current = activeProvider;
    channelsRef.current = channels;
    categoriesRef.current = categories;
    vodCategoriesRef.current = vodCategories;
    seriesCategoriesRef.current = seriesCategories;
    moviesRef.current = movies;
    seriesRef.current = series;
    selectedCategoryIdRef.current = selectedCategoryId;
  }, [activeChannelId, activeProvider, channels, categories, vodCategories, seriesCategories, movies, series, selectedCategoryId]);

  /**
   * Kijelölés-csere CSAK akkor, ha a nézett csatorna valóban eltűnt.
   *
   * A tartalék mindig MAGYAR csatorna (a `hungaryFirst` sorrend első eleme),
   * így egy betöltés sem viheti át a kijelölést egy véletlen külföldi adóra,
   * és az alapértelmezett „Magyarország” lista sem cserélődik le.
   */
  const keepOrMoveActiveChannel = useCallback((candidateList: Channel[], remember: boolean): void => {
    const watchedId = activeChannelIdRef.current;
    if (watchedId && candidateList.some((channel) => channel.id === watchedId)) return;
    const fallback = candidateList[0];
    if (!fallback || fallback.id === watchedId) return;
    activeChannelIdRef.current = fallback.id;
    setActiveChannelId(fallback.id);
    if (remember) storageService.rememberLastChannel(fallback.id);
    appLog(`A nézett csatorna (${watchedId || 'nincs'}) nincs az új listában; átállás: ${fallback.name}.`);
  }, []);

  // A menü országokat mutat, nem szolgáltatói alkategóriákat. Egy ország
  // összes csatornája egyetlen választható elem alá kerül.
  const countryCategories = useMemo(
    () => buildCountryCategories(channels, categories),
    [channels, categories]
  );

  /**
   * A csatornalistában KIVÁLASZTOTT ország (a fejléc zászlajához).
   *
   * Ugyanaz a feloldás, mint a lista szűrésénél: az „Összes” helyett a
   * Magyarország kategória (vagy az első ország) érvényes.
   */
  const activeCountryCategory = useMemo(() => {
    const effectiveId = selectedCategoryId === 'all'
      ? (findHungaryCategoryId(countryCategories) || countryCategories[0]?.id || '')
      : selectedCategoryId;
    return countryCategories.find((category) => category.id === effectiveId) || null;
  }, [countryCategories, selectedCategoryId]);

  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [isOsdVisible, setIsOsdVisible] = useState<boolean>(true);
  const [isVideoFullscreen, setIsVideoFullscreen] = useState<boolean>(false);
  const [liveAccent, setLiveAccent] = useState<'yellow' | 'red' | 'blue' | 'pink' | 'green' | 'white'>(() => {
    try {
      const saved = localStorage.getItem('iptv-live-accent');
      return saved === 'red' || saved === 'blue' || saved === 'pink' || saved === 'green' || saved === 'white' ? saved : 'yellow';
    } catch { return 'yellow'; }
  });
  const [isFullscreenLiveOsdVisible, setIsFullscreenLiveOsdVisible] = useState<boolean>(false);

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

  /*
   * A TELJES KÉPERNYŐS ÉLŐ TV OSD.
   *
   * Az OSD a teljes képernyős nézetben MINDIG megjelenik: a csatorna neve,
   * a MOST/KÖVETKEZő műsor és a haladáspont a képen van, ugyanott, ahol a
   * főoldali OSD. Korábban a 0 másodperces "OSD-eltűnés" beállítással az
   * OSD egyáltalán nem jelent meg teljes képernyőn – a néző csak egy
   * fekete képet látott, csatornainformáció nélkül.
   *
   * Az "eltűnés" ideje mostantól a MEGJELENÉS UTÁNI várakozás: 0 = soha
   * ne tűnjön el, 5 = öt másodperc múlva tűnik (de új gombnyomásra
   * azonnal visszatér). Ez a set-top box-ok szokása.
   */
  const fullscreenOsdTimerRef = useRef<number | null>(null);
  const showFullscreenLiveOsd = useCallback(() => {
    setIsFullscreenLiveOsdVisible(true);
    if (fullscreenOsdTimerRef.current !== null) {
      window.clearTimeout(fullscreenOsdTimerRef.current);
      fullscreenOsdTimerRef.current = null;
    }
    if (settings.osdHideDelay > 0) {
      fullscreenOsdTimerRef.current = window.setTimeout(() => {
        setIsFullscreenLiveOsdVisible(false);
        fullscreenOsdTimerRef.current = null;
      }, settings.osdHideDelay * 1000);
    }
  }, [settings.osdHideDelay]);

  useEffect(() => {
    if (!isVideoFullscreen || customStreamUrl) {
      setIsFullscreenLiveOsdVisible(false);
      if (fullscreenOsdTimerRef.current !== null) {
        window.clearTimeout(fullscreenOsdTimerRef.current);
        fullscreenOsdTimerRef.current = null;
      }
      return;
    }
    showFullscreenLiveOsd();
    return () => {
      if (fullscreenOsdTimerRef.current !== null) {
        window.clearTimeout(fullscreenOsdTimerRef.current);
        fullscreenOsdTimerRef.current = null;
      }
    };
  }, [isVideoFullscreen, activeChannelId, customStreamUrl, showFullscreenLiveOsd]);
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
  const [isDiagnosticShareOpen, setIsDiagnosticShareOpen] = useState(false);
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
  const [favoriteChannelId, setFavoriteChannelId] = useState<string | null>(null);
  const [isResumeModalOpen, setIsResumeModalOpen] = useState(false);

  // Gyors csatorna-kereső: a teljes listán végigmenő `find` helyett egyszer
  // épített térkép. A lista akár 20-60 ezer elemű is lehet, és a keresés
  // korábban minden kirajzoláskor végigfutott a teljes tömbön.
  const channelsById = useMemo(() => {
    const map = new Map<string, Channel>();
    for (const channel of channels) map.set(channel.id, channel);
    return map;
  }, [channels]);

  // Active channel reference
  const activeChannel = useMemo(() => {
    const base = channelsById.get(activeChannelId) || channels[0] || null;
    if (!base || !activeEpg || activeEpg.id !== base.id) return base;
    // Csak akkor készítünk új objektumot, ha tényleg változott a műsor.
    if (base.epgNow === activeEpg.now && base.epgNext === activeEpg.next && JSON.stringify(base.epgUpcoming || []) === JSON.stringify(activeEpg.upcoming || [])) return base;
    return { ...base, epgNow: activeEpg.now, epgNext: activeEpg.next, epgUpcoming: activeEpg.upcoming };
  }, [channelsById, channels, activeChannelId, activeEpg]);

  // A csatornalista a kiválasztott kategóriát, a kedvenceket vagy a kiválasztott mappát mutatja.
  const filteredChannels = useMemo(() => {
    const globalQuery = categorySearchQuery.trim().toLocaleLowerCase();
    if (globalQuery) {
      // Országnevek előre kigyűjtve: korábban minden csatornánál egy
      // `find` futott az országlistán (20 000 csatornánál ez másodpercekig tartott).
      const countryNames = new Map<string, string>();
      for (const category of countryCategories) {
        if (category.id.startsWith('country-')) {
          countryNames.set(category.id.slice('country-'.length), category.name);
        }
      }
      return channels.filter((channel) => {
        const code = (channel.countryCode || 'INT').toUpperCase();
        const countryName = countryNames.get(code) || channel.country || '';
        return [channel.name, channel.categoryName, channel.categoryId, channel.country, channel.countryCode, countryName]
          .some((value) => String(value || '').toLocaleLowerCase().includes(globalQuery));
      });
    }
    if (selectedFavoriteFolderId) {
      const folder = folders.find((item) => item.id === selectedFavoriteFolderId);
      return (folder?.channelIds || [])
        .map((id) => channelsById.get(id))
        .filter((channel): channel is Channel => Boolean(channel));
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
  }, [channels, channelsById, selectedCategoryId, selectedSubCategoryId, isOnlyFavorites, folders, selectedFavoriteFolderId, countryCategories, categorySearchQuery]);

  /*
   * EGY ORSZÁG CSATORNÁI CSAK MEGNYITÁSKOR (a néző 2. pontja).
   *
   * Induláskor csak a magyar csatornák töltődnek le, de az országlistában már
   * akkor is ott van minden ország neve. Amikor a néző megnyit egy országot,
   * amelynek még nincs letöltött csatornája, itt töltjük le a szolgáltató azon
   * élő kategóriáit, és fésüljük be a listába. A mentés automatikusan követi
   * (a channels változására futó mentés), így a következő indulásnál már bent
   * lesznek.
   *
   * Az `attempted` halmaz azért kell, hogy egy sikertelen vagy üres letöltés
   * ne indítson végtelen újrapróbálási kört: az effect a `channels` miatt
   * amúgy újra lefutna.
   */
  const attemptedCountryRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeProvider) return undefined;
    if (!selectedCategoryId.startsWith('country-')) return undefined;
    const countryCode = selectedCategoryId.slice('country-'.length);
    if (attemptedCountryRef.current.has(countryCode)) return undefined;
    const hasChannels = channels.some(
      (channel) => (channel.countryCode || 'INT').toUpperCase() === countryCode
    );
    if (hasChannels) return undefined;

    const stripPrefix = (id: string) => String(id).replace(/^lc-/, '');
    const wanted = (categories || []).filter(
      (category) => flagFor(String(category.name || '')).countryCode === countryCode
    );
    const categoryIds = wanted.map((category) => stripPrefix(category.id)).filter((id) => id !== '');
    if (categoryIds.length === 0) return undefined;

    attemptedCountryRef.current.add(countryCode);
    const xtreamCategories = wanted.map((category) => ({
      category_id: stripPrefix(category.id),
      category_name: category.name,
    }));
    /*
     * TÚL SOK KATEGÓRIA = NEM ORSZÁG SZERINT VAN ELOSZTVA.
     *
     * Az 5-ös TV-napló (2.5.113) szerint ennél a szolgáltatónál a 340 élő
     * kategóriából csak 1 volt magyar nevű, a többi 339 mind a „Nemzetközi”
     * gyűjtőbe esett. Ha ezt kategóriánként kérnénk le, 339 kérés indulna –
     * a néző csak egy végtelennek tűnő töltést látna. Ilyenkor inkább EGY
     * nagy kéréssel jön le a teljes lista, pontosan úgy, ahogy induláskor
     * tenné: gyorsabb is, és a panelt sem terheljük szét.
     */
    const MAX_CATEGORIES_PER_LOAD = 40;
    const tooManyCategories = categoryIds.length > MAX_CATEGORIES_PER_LOAD;
    let cancelled = false;
    appLog(tooManyCategories
      ? `${countryCode} ország csatornái: ${categoryIds.length} kategória lenne, ezért a teljes lista töltődik egy kéréssel.`
      : `${countryCode} ország csatornáinak betöltése indul (${categoryIds.length} kategória).`);
    void (async () => {
      try {
        const loaded = tooManyCategories
          ? await loadAllLiveChannels(activeProvider)
          : await loadLiveChannelsForCategories(activeProvider, xtreamCategories, categoryIds);
        if (cancelled) return;
        if (loaded.length === 0) {
          appLog(`${countryCode} ország: a szolgáltató nem adott csatornát.`);
          return;
        }
        setChannels((previous) => {
          const existing = new Set(previous.map((channel) => channel.id));
          const fresh = loaded.filter((channel) => !existing.has(channel.id));
          return fresh.length === 0 ? previous : [...previous, ...fresh];
        });
      } catch (error) {
        // Egy sikertelen letöltés után engedjük újra próbálni (pl. másik
        // ország megnyitása, majd visszatérés), de ne pörögjön magától.
        attemptedCountryRef.current.delete(countryCode);
        appLogError(`${countryCode} ország csatornái`, error);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedCategoryId, channels, categories, activeProvider]);


  // A képernyőn megjelenő sorszám a jelenlegi szűrt lista pozíciója; az eredeti ch.num érintetlen.
  const activeChannelDisplayNumber = useMemo(() => {
    // FONTOS (a felület lassulásának fő oka): itt korábban
    // `displayedChannelOrder.every(id => filteredChannels.some(...))` volt,
    // ami négyzetszerű (O(n²)) futásidőt jelentett - 20 000 csatornás
    // országlistánál ez több százmillió összehasonlítás, azaz másodperces
    // fagyás minden lista- vagy kijelölésváltozásnál. Halmazos ellenőrzés: O(n).
    let orderMatchesCurrentList = displayedChannelOrder.length === filteredChannels.length;
    if (orderMatchesCurrentList) {
      const visibleIds = new Set<string>();
      for (const channel of filteredChannels) visibleIds.add(channel.id);
      for (const id of displayedChannelOrder) {
        if (!visibleIds.has(id)) { orderMatchesCurrentList = false; break; }
      }
    }
    const order = orderMatchesCurrentList ? displayedChannelOrder : filteredChannels.map((channel) => channel.id);
    const index = order.indexOf(activeChannelId);
    return index >= 0 ? index + 1 : undefined;
  }, [filteredChannels, activeChannelId, displayedChannelOrder]);

  // A ChannelList kezeli a látható csatornák EPG-jét a referencia mintájára.
  // Itt csak a gyorsítótárból frissítjük a csatornaállapotot; nincs második előtöltő sor.

  // A nézett csatorna műsora (most / következő) 30 másodpercenként frissül a
  // gyorsítótárból - CSAK a nézett csatornára.
  //
  // FONTOS (a felület általános lassulásának fő oka): korábban ez a időzítő a
  // TELJES csatornalistán (20-60 ezer elem) végigment és új tömböt készített
  // 30 másodpercenként. Emiatt az összes memo (országkategóriák, szűrt lista,
  // kijelölési sorszám) újraszámolódott, a csatornalista pedig teljesen
  // újrarajzolódott - TV-n ez érezhető, másodperces akadás volt félpercenként.
  // A listában látható sorok műsorát a ChannelList saját gyorsítótárból
  // frissíti (localEpg), ehhez nem kell a nagy tömb módosítása.
  useEffect(() => {
    // Film/sorozat nézetben az élő csatorna megmarad a visszatéréshez, de
    // nincs látható EPG, ezért a 30 mp-es frissítésnek ott nincs dolga.
    if (activeView !== 'live' || customStreamUrl || !activeProvider || activeProvider.type !== 'xtream') return;
    const refreshActiveProgram = () => {
      const channel = channelsById.get(activeChannelId);
      if (!channel) return;
      const streamId = streamIdFor(channel);
      if (!streamId) return;
      const entries = getCachedShortEpg(activeProvider, streamId, 6);
      if (!entries.length) return;
      const { now, next } = nowNextFromEpg(entries, Date.now());
      const nextNow = now || channel.epgNow;
      const nextNext = next || channel.epgNext;
      const upcoming = entries.filter((entry) => entry.start >= (nextNow?.endTimestamp || 0)).slice(0, 3).map((entry) => ({ title: entry.title, time: new Date(entry.start * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }));
      if (
        nextNow?.title === channel.epgNow?.title &&
        nextNow?.time === channel.epgNow?.time &&
        nextNow?.startTimestamp === channel.epgNow?.startTimestamp &&
        nextNow?.endTimestamp === channel.epgNow?.endTimestamp &&
        nextNext?.title === channel.epgNext?.title &&
        nextNext?.time === channel.epgNext?.time &&
        JSON.stringify(upcoming) === JSON.stringify(channel.epgUpcoming || [])
      ) {
        return;
      }
      setActiveEpg({ id: channel.id, now: nextNow, next: nextNext, upcoming });
    };
    refreshActiveProgram();
    const timer = window.setInterval(refreshActiveProgram, 30000);
    return () => window.clearInterval(timer);
  }, [activeView, customStreamUrl, activeProvider?.id, activeProvider?.type, activeChannelId, channelsById]);

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
    if (activeView !== 'live' || customStreamUrl || !channel || !provider || provider.type !== 'xtream') return;
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
          const current = now || channel.epgNow;
          const upcoming = entries.filter((entry) => entry.start >= (current?.endTimestamp || 0)).slice(0, 3).map((entry) => ({ title: entry.title, time: new Date(entry.start * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }));
          setActiveEpg({ id: channel.id, now: current, next: next || channel.epgNext, upcoming });
        })
        .catch(() => {
          /* Az EPG hibája nem akadályozhatja a nézést. */
        });
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeView, customStreamUrl, activeChannel?.id, activeProvider?.id]);

  /*
   * A filmek és sorozatok betöltése a mentett tárból.
   *
   * FONTOS (indulás és a Mozi/Sorozat megnyitásának gyorsasága):
   *  - a betöltés NEM a legelső képkocka előtt indul, hanem a főoldal
   *    megjelenése után, üresjáratban (1,2 mp),
   *  - és NEM is kell kivárni: amint a néző a Mozi vagy a Sorozat menüre
   *    lép, az `ensureVodLoaded()` azonnal elindítja (lásd handleViewChange).
   *  - adagonként töltődik, adagok között a felület visszakapja a vezérlést,
   *    így a TV nem fagy le a több tízezer elemű lista olvasásakor.
   * Csak EGYSZER fut le (az első kérésre), utána a memóriában lévő listát
   * használjuk – nincs ismételt betöltés nézetváltáskor.
   */
  const vodLoadStartedRef = useRef(false);
  const ensureVodLoaded = useCallback(() => {
    if (vodLoadStartedRef.current) return;
    const provider = bootLive.provider;
    if (!provider) return;
    vodLoadStartedRef.current = true;
    // A mentett tartalom mindig egyetlen, meghatározott sorrendben töltődik:
    // élő csatornák (a modul indulásakor), filmek, majd sorozatok. A film- és
    // sorozat-cache soha nem indul egyszerre, mert az régi webOS TV-n üres
    // vagy félkész 0/elemszámú nézethez és memória-csúcshoz vezethet.
    appLog(`Mentett tartalom betöltése indul (tároló: ${provider.id}).`);
    logMemory('tartalom betöltése előtt');

    const loadStoredContent = async (): Promise<void> => {
      try {
        logPhase('filmlista cache betöltése indul');
        const vod = await loadVodAsync(provider);
        setMovies(vod.movies);
        setVodCategories(vod.categories);
        appLog(`Filmek a felületen: ${vod.movies.length}.`);
        logPhase(`filmek betöltve a felületre (${vod.movies.length} db)`);
      } catch (error) {
        // A film-cache hibája nem akadályozhatja a sorozat-cache következő,
        // külön szakaszát és az élő TV-t.
        appLogError('Filmek betöltése', error);
      }

      // A két nagy dekódolás között adjuk vissza a főszálat a webOS-nak.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 32));

      try {
        logPhase('sorozatlista cache betöltése indul');
        const ser = await loadSeriesAsync(provider);
        setSeries(ser.series);
        setSeriesCategories(ser.categories);
        appLog(`Sorozatok a felületen: ${ser.series.length}.`);
        logPhase(`sorozatok betöltve a felületre (${ser.series.length} db)`);
      } catch (error) {
        appLogError('Sorozatok betöltése', error);
      }
    };

    void loadStoredContent().finally(() => logMemory('tartalom betöltése után'));
  }, []);

  useEffect(() => {
    if (!bootLive.provider) return;
    const ric = (window as any).requestIdleCallback;
    let timer = 0;
    // A késleltetés szándékos: a lejátszás elindulása és az első képkocka
    // előzi meg a nagy JSON-ok beolvasását. Ha a néző közben a Mozi/Sorozat
    // menüre lép, az ensureVodLoaded() azonnal elindítja.
    timer = window.setTimeout(() => {
      const start = () => {
        // A félbe maradt, elárvult tároló-adagok törlése (egyszer, induláskor):
        // helyet ad a következő mentésnek és nem lassítja a betöltést.
        try {
          sweepStorage();
        } catch {
          /* a takarítás sosem akadályozhatja az indulást */
        }
        ensureVodLoaded();
      };
      if (typeof ric === 'function') ric(start, { timeout: 2000 });
      else start();
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [ensureVodLoaded]);

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

  /**
   * Tükrözött elrendezés be/ki (PIROS / Record gomb).
   *
   * A funkcionális frissítés miatt nem számít, milyen `settings` példányt
   * látott a gombkezelő a regisztráláskor – mindig a legfrissebb állapotból
   * váltunk, és azonnal mentjük is.
   */
  const handleToggleMirrorLayout = useCallback(() => {
    setSettings((current) => {
      const updated = { ...current, mirrorLayout: !current.mirrorLayout };
      storageService.saveSettings(updated);
      return updated;
    });
  }, []);

  /**
   * Nézetváltás (TV / Mozi / Sorozat) – AZONNALI.
   *
   * A nézetek a legelső megnyitás után a DOM-ban maradnak (lásd visitedViews),
   * ezért a váltás csak láthatóságot kapcsol: nincs újraépítés, nincs
   * újra-betöltés, nincs villanás. A film/sorozat lista betöltése az első
   * megnyitáskor indul (ha még nem futott), nem a váltásra vár.
   */
  const paneScrollStore = useRef<Record<string, number[]>>({});

  /**
   * Görgetési pozíció mentése/visszaállítása nézetváltáskor.
   *
   * A rejtett nézet `display: none`, ilyenkor a böngésző a görgetési
   * pozíciót nem feltétlenül őrzi meg (a régi webOS Chromium nem teszi).
   * Ezért a váltás előtt elmentjük a `[data-scroll-keep]` elemek helyzetét,
   * visszatéréskor pedig visszaállítjuk – a felhasználó ott folytatja, ahol
   * abbahagyta.
   */
  const capturePaneScroll = useCallback((view: string) => {
    try {
      const pane = document.querySelector(`[data-view-pane="${view}"]`);
      if (!pane) return;
      const values = Array.prototype.map.call(
        pane.querySelectorAll('[data-scroll-keep]'),
        (el: HTMLElement) => el.scrollTop || 0,
      ) as number[];
      paneScrollStore.current[view] = values;
    } catch { /* régi motor */ }
  }, []);

  const restorePaneScroll = useCallback((view: string) => {
    const values = paneScrollStore.current[view];
    if (!values || values.length === 0) return;
    try {
      const pane = document.querySelector(`[data-view-pane="${view}"]`);
      if (!pane) return;
      const elements = pane.querySelectorAll<HTMLElement>('[data-scroll-keep]');
      elements.forEach((el, index) => {
        const value = values[index];
        if (typeof value === 'number' && value > 0) el.scrollTop = value;
      });
    } catch { /* régi motor */ }
  }, []);

  /**
   * Nézetváltáskor a távirányító kijelölője a NYITOTT NÉZETBE kerül.
   *
   * Enélkül a fókusz a fejléc gombján maradt, a webOS gombkezelő pedig a
   * fejléc-szabályok szerint mozgatott: a Mozi/Sorozat nézetben a LE nyíl
   * hatástalan volt, a nézetben egyáltalán nem lehetett mozogni.
   */
  useEffect(() => {
    if (activeView === 'live') {
      // Élő nézetben a csatornalista kijelölt sorára visszük a fókuszt.
      const timer = window.setTimeout(() => {
        const target = document.querySelector<HTMLElement>('[data-channel-id] [role="option"]')
          || document.querySelector<HTMLElement>('[role="listbox"] [role="option"]');
        target?.focus({ preventScroll: true } as FocusOptions);
      }, 60);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      const pane = document.querySelector<HTMLElement>(`[data-view-pane="${activeView}"]`);
      if (!pane) return;
      const first = pane.querySelector<HTMLElement>(
        'button:not(:disabled), [href], input, [tabindex]:not([tabindex="-1"])'
      );
      first?.focus({ preventScroll: true } as FocusOptions);
      restorePaneScroll(activeView);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [activeView, restorePaneScroll]);

  const handleViewChange = useCallback((view: 'live' | 'movies' | 'series') => {
    // A görgetést a váltás ELŐTT mentjük (a display:none után már 0 lenne).
    capturePaneScroll(activeView);
    setVisitedViews((previous) => (previous[view] ? previous : { ...previous, [view]: true }));
    setActiveView(view);
    setCustomStreamUrl(undefined);
    setCustomStreamTitle(undefined);
    // Élő nézetben újra a legutóbbi csatorna megy; böngészés közben nem fut a háttérben.
    setIsPlaying(view === 'live');
    if (view !== 'live') {
      // A film/sorozat lista betöltése már a menü megnyomásakor elindul.
      window.setTimeout(ensureVodLoaded, 0);
    }
  }, [ensureVodLoaded, activeView, capturePaneScroll]);

  // A nézetek propjai STABILAK (a React.memo így tudja kihagyni az
  // újrarajzolást, amikor csak a lejátszó teljes képernyős állapota változik).
  const handleBackToLive = useCallback(() => handleViewChange('live'), [handleViewChange]);
  const handleMoviesCategoryChange = useCallback((categoryId: string) => {
    movieCategoryRef.current = categoryId;
  }, []);
  const handleSeriesCategoryChange = useCallback((categoryId: string) => {
    seriesCategoryRef.current = categoryId;
  }, []);

  const handleOpenCategories = useCallback(() => setIsCategoriesOpen(true), []);
  const handleOpenSettings = useCallback((tab?: 'channels' | 'lists' | 'favorites' | 'system') => {
    // A Beállítások gomb alapból közvetlenül a Kedvencek fülre nyit.
    // Csak a kifejezetten kért fül (pl. Rendszer) nyíljon meg külön.
    setSettingsTab(!tab ? 'favorites' : tab === 'channels' ? 'system' : tab);
    setIsSettingsOpen(true);
  }, []);

  /**
   * A rejtett nézetek stílusa: a láthatóságot kapcsoljuk (nem unmountolunk),
   * így a görgetési pozíció, a keresés és a kategória is megmarad. A rejtett
   * nézet nem kap egeret és a távirányítós kijelölő sem lép rá
   * (data-view-hidden, lásd webos.js).
   */
  const paneStyle = useCallback((isActive: boolean): React.CSSProperties => ({
    // A rejtett nézetet TELJESEN kivesszük a kirajzolásból (display:none).
    // A `visibility: hidden` a TV kompozítorán maradék (beégett) képkockákat
    // hagyott: a Mozi/Sorozat nézet hátterében ott maradtak az előző
    // csatornalista logói. A display:none a React-állapotot NEM dobja el
    // (a komponens mountolva marad), ezért a váltás továbbra is azonnali –
    // a görgetési pozíciót pedig a paneScrollStore állítja vissza.
    display: isActive ? undefined : 'none',
  }), []);

  // Switch Active Channel
  /**
   * Csatornaváltás.
   *
   * FONTOS (a váltás lassúsága): itt NEM írjuk szinkron a localStorage-ba az
   * "utolsó csatorna" azonosítót. Az írás a TV lassú tárolóján blokkolta a fő
   * szálat pont a lejátszás indítása előtt; most a váltás után, összevontan
   * (800 ms) történik. A beállítás-objektum csak memóriában frissül, ami
   * azonnal rendelkezésre áll az újraindításhoz is.
   */
  const handleSelectChannel = useCallback((channel: Channel) => {
    setNextEpisodeToPlay(null);
    setCustomStreamUrl(undefined);
    setCustomStreamTitle(undefined);
    setActiveChannelId(channel.id);
    setIsPlaying(true);
    // Csak ezt az egy azonosítót mentjük, késleltetve - a beállítás-objektum
    // állapotát NEM írjuk, így a váltás egyetlen újrarajzolással megvan.
    storageService.rememberLastChannel(channel.id);
    if (activeView !== 'live') {
      setActiveView('live');
    }
  }, [activeView]);

  // Next / Prev channel switching: always follow the numeric channel number,
  // not the current category/search/render order. Stop at the ends instead of
  // wrapping from the last channel to the first (which could be unrelated).
  const handleNextChannel = useCallback(() => {
    if (settings.closeListOnZap) setIsCategoriesOpen(false);
    const list = filteredChannels;
    if (list.length === 0) return;
    const currentIndex = list.findIndex((c) => c.id === activeChannelId);
    /*
     * Ha a jelenleg nézett csatorna nincs a szűrt listában (másik ország /
     * mappa / keresés), KORÁBBAN a lista ELSŐ csatornájára váltott – ez volt a
     * „magától másik csatornára ugrik” hiba egyik útja. Ilyenkor nem váltunk.
     */
    if (currentIndex < 0) return;
    if (currentIndex >= list.length - 1) return;
    handleSelectChannel(list[currentIndex + 1]);
  }, [filteredChannels, activeChannelId, handleSelectChannel, settings.closeListOnZap]);

  const handlePrevChannel = useCallback(() => {
    if (settings.closeListOnZap) setIsCategoriesOpen(false);
    const list = filteredChannels;
    if (list.length === 0) return;
    const currentIndex = list.findIndex((c) => c.id === activeChannelId);
    // Ugyanaz, mint a CH+-nál: ismeretlen csatorna esetén nem ugrunk az elsőre.
    if (currentIndex < 0) return;
    if (currentIndex <= 0) return;
    handleSelectChannel(list[currentIndex - 1]);
  }, [filteredChannels, activeChannelId, handleSelectChannel, settings.closeListOnZap]);

  /**
   * A mappák a csatornakedvencek egyetlen forrásai: a csillag állapota a
   * mappatagságot követi.
   *
   * `useCallback`: a memoizált csatornalista csak akkor rajzolódjon újra, ha
   * tényleg történt változás (ne minden hangerő-/OSD-mozdulatnál).
   */
  const handleSaveFolders = useCallback((updatedFolders: FavoriteFolder[]) => {
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
  }, []);

  // A csillag valódi kapcsoló: ha már kedvenc, egy újabb nyomás kiveszi minden kedvenc mappából.
  const handleToggleFavorite = useCallback((channelId: string) => {
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
  }, [folders, handleSaveFolders]);

  const handleRemoveChannelFromFolder = useCallback((folderId: string, channelId: string) => {
    handleSaveFolders(folders.map((folder) => folder.id === folderId
      ? { ...folder, channelIds: folder.channelIds.filter((id) => id !== channelId) }
      : folder));
  }, [folders, handleSaveFolders]);

  const handleMoveFavoriteChannel = useCallback((folderId: string, channelId: string, direction: 'up' | 'down') => {
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) return;
    const ids = folder.channelIds.slice();
    const pos = ids.indexOf(channelId);
    const target = pos + (direction === 'up' ? -1 : 1);
    if (pos < 0 || target < 0 || target >= ids.length) return;
    [ids[pos], ids[target]] = [ids[target], ids[pos]];
    handleSaveFolders(folders.map((item) => item.id === folderId ? { ...item, channelIds: ids } : item));
  }, [folders, handleSaveFolders]);

  const handleAssignChannelToFolder = useCallback((channelId: string, folderId: string) => {
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
  }, [folders, handleSaveFolders]);

  const handleAssignChannelsToFolder = useCallback((channelIds: string[], folderId: string) => {
    const uniqueIds = Array.from(new Set(channelIds));
    const updatedFolders = folders.map((folder) => folder.id === folderId
      ? { ...folder, channelIds: Array.from(new Set([...folder.channelIds, ...uniqueIds])) }
      : folder);
    handleSaveFolders(updatedFolders);
    const added = new Set(uniqueIds);
    setChannels((previous) => previous.map((channel) =>
      added.has(channel.id) && !channel.isFavorite ? { ...channel, isFavorite: true } : channel
    ));
    dirtyRef.current = true;
  }, [folders, handleSaveFolders]);

  // A kukával a kedvenc mappából csak a mappatagságot vesszük ki;
  // az ország/alaplistából törölve a csatorna minden kedvenc mappából is eltűnik.
  const handleDeleteChannel = useCallback((channelId: string) => {
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
  }, [selectedFavoriteFolderId, folders, channels, handleSaveFolders, activeChannelId, filteredChannels, selectedCategoryId]);

  // Toggle Favorite for Movie
  const handleToggleFavoriteMovie = useCallback((movieId: string) => {
    setMovies((previous) => previous.map((m) =>
      m.id === movieId ? { ...m, isFavorite: !m.isFavorite } : m
    ));
    dirtyRef.current = true;
  }, []);

  // Toggle Favorite for Series
  const handleToggleFavoriteSeries = useCallback((seriesId: string) => {
    setSeries((previous) => previous.map((s) =>
      s.id === seriesId ? { ...s, isFavorite: !s.isFavorite } : s
    ));
    dirtyRef.current = true;
  }, []);

  // Kézi csatorna-sorrend: az aktuálisan látható listában egy hellyel fel/le mozgat.
  const handleMoveChannel = useCallback((channelId: string, direction: 'up' | 'down') => {
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
    if (activeProvider) storageService.saveChannelOrder(activeProvider.id, updated.map((channel) => channel.id));
    dirtyRef.current = true;
  }, [selectedFavoriteFolderId, handleMoveFavoriteChannel, filteredChannels, channels, activeProvider]);

  // Hosszan nyomva húzott csatornák sorrendje az aktuális kategóriában/kedvencekben.
  // A látható elemek helyeit cseréljük az alaplistában, így a többi kategória sorrendje nem sérül.
  const handleReorderChannels = useCallback((orderedChannelIds: string[]) => {
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
    if (activeProvider) storageService.saveChannelOrder(activeProvider.id, updated.map((channel) => channel.id));
    dirtyRef.current = true;
  }, [filteredChannels, channels, activeProvider]);

  const handleDeleteFolder = useCallback((folderId: string) => {
    handleSaveFolders(folders.filter((folder) => folder.id !== folderId));
    if (selectedFavoriteFolderId === folderId) setSelectedFavoriteFolderId(null);
  }, [folders, handleSaveFolders, selectedFavoriteFolderId]);

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
    storageService.clearChannelOrder(providerId);
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
    // Az alapértelmezett ország MINDIG Magyarország - betöltés/frissítés nem
    // válthat másik országra.
    const defaultCountryId = findHungaryCategoryId(importedCountries) || importedCountries[0]?.id || 'all';
    const defaultCountryCode = defaultCountryId.startsWith('country-') ? defaultCountryId.slice('country-'.length) : '';
    const keepCategory = selectedCategoryId.startsWith('country-')
      && importedCountries.some((category) => category.id === selectedCategoryId);
    if (!keepCategory) setSelectedCategoryId(defaultCountryId);
    setSelectedSubCategoryId(null);
    setIsOnlyFavorites(false);
    // A korábban nézett csatornát NEM írjuk felül: ha az új listában is
    // megvan, azon maradunk; csak ha eltűnt, választunk magyar csatornát.
    const savedLastId = storageService.getLastChannelId() || settings.lastPlayedChannelId;
    const savedStillExists = Boolean(savedLastId && normalizedContent.channels.some((channel) => channel.id === savedLastId));
    const firstDefaultChannel = normalizedContent.channels.find((channel) => (channel.countryCode || 'INT').toUpperCase() === defaultCountryCode)
      || normalizedContent.channels[0];
    if (savedStillExists) {
      setActiveChannelId(savedLastId!);
      handleUpdateSettings({ activeProviderId: providerId });
    } else if (firstDefaultChannel) {
      setActiveChannelId(firstDefaultChannel.id);
      storageService.rememberLastChannel(firstDefaultChannel.id);
      handleUpdateSettings({ activeProviderId: providerId });
    } else {
      handleUpdateSettings({ activeProviderId: providerId });
    }
  };

  // QR telefonos beállítás – provider fogadása telefonról (TV-n nem kell pötyögni)
  const handleQrProviderReceived = async (payload: any) => {
    try {
      // A QR-adatban lehetnek belépési adatok; azokat sem konzolra, sem
      // SupportBase-naplóba nem írjuk ki.
      if (payload.type === 'xtream') {
        let host = String(payload.host || '').trim();
        let port = String(payload.port || '').trim();
        let protocol = 'http:';
        try {
          if (host.includes('://')) {
            const u = new URL(host);
            protocol = u.protocol || 'http:';
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
          serverUrl: `${protocol}//${host}${port ? `:${port}` : ''}`,
          username: payload.username,
          password: payload.password,
          isActive: true,
          status: 'loading' as const,
          channelsCount: 0,
          moviesCount: 0,
          seriesCount: 0,
          lastUpdated: new Date().toLocaleString('hu-HU'),
          expireDate: 'N/A',
          maxConnections: 0
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
          maxConnections: 0
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
  // a több tízezer film letöltését. A részleges szakaszok csak előnézetként
  // jelennek meg; a teljes, metaadattal kiegészített snapshot egyszer kerül
  // tartósan mentésre az import végén.
  const handleRefreshProvider = async (providerOrId: string | ProviderAccount, manual = true) => {
    // QR-es hozzáadás után a React providers állapota ebben a renderben még régi lehet.
    // Az átadott ProviderAccount ezért közvetlenül használható, nem veszhet el az első import.
    const provider = typeof providerOrId === 'string'
      ? providers.find((p) => p.id === providerOrId)
      : providerOrId;
    if (!provider) return;
    const id = provider.id;
    const refreshGeneration = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = refreshGeneration;
    const providersForRefresh = providers.some((p) => p.id === id)
      ? providers
      : [provider, ...providers.map((p) => ({ ...p, isActive: false }))];
    const refreshStartedAt = performance.now();

    // Ha korábbi EPG-előtöltés még fut, azt azonnal leállítjuk, hogy
    // semmilyen háttérkérés ne foglalja a kapcsolatot a fő Xtream betöltés elől.
    cancelNetworkRequests();
    resetNetworkBreaker();
    cancelAutoRetry();
    if (manual) {
      retryAttemptsRef.current = 0;
      // A kézi provider-frissítés szándékosan új sorrenddel indul.
      storageService.clearChannelOrder(id);
    }
    lastRefreshProviderIdRef.current = id;
    providerRefreshActiveRef.current = true;
    clearEpgCache();
    setEpgRevision((revision) => revision + 1);
    setProviderContentReady(false);
    setDiagnosticOpen(true);
    setDiagnosticEvents([]);
    diagnosticEventsRef.current = [];
    setDiagnosticError(null);
    const initialProgress = { phase: 'Frissítés indul…', percent: 2 };
    setDiagnosticProgress(initialProgress);
    setDiagnosticStartedAt(refreshStartedAt);
    setDiagnosticFinishedAt(null);
    setRefreshLivePromptOpen(false);
    refreshLivePromptShownRef.current = false;
    diagnosticFinishedRef.current = false;
    setLastImportDiagnostic({ providerId: id, providerName: provider.name, progress: initialProgress, events: [], error: null, startedAt: refreshStartedAt, finished: false, finishedAt: null });
    /*
     * A diagnosztika FRISSÍTÉSE RITKÍTVA.
     *
     * Korábban minden egyes hálózati esemény (kérés indult / sikerült /
     * hibázott) és minden haladásjelzés két állapotfrissítést hozott, azaz a
     * teljes App újrarajzolását – egy 20-40 ezer elemű lista mellett ez a
     * betöltés alatt másodpercenként több tucatszor futott le, és éppen a
     * csatornalista feldolgozásátől vette el az időt. Most a napló a
     * memóriában gyűlik (azonnal, adatvesztés nélkül), a felületre pedig
     * legfeljebb 4-szer másodpercenként kerül ki.
     */
    lastProgressPaintRef.current = 0;
    setNetworkDiagnosticSink((event) => {
      if (diagnosticFinishedRef.current || refreshGenerationRef.current !== refreshGeneration) return;
      diagnosticEventsRef.current = [...diagnosticEventsRef.current, event].slice(-250);
      scheduleDiagnosticFlush();
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

    /** Egy-egy szakasz azonnal a felületre kerül; tartós mentés csak a végén van. */
    const applyPartial = async (partial: PartialContent): Promise<void> => {
      if (refreshGenerationRef.current !== refreshGeneration) return;
      if (partial.totals) draft.totals = { ...draft.totals, ...partial.totals };
      // Üres szakasz soha nem törölheti a már megjelenített (mentett) listát.
      const currentChannels = channelsRef.current;
      if (partial.channels && (partial.channels.length > 0 || currentChannels.length === 0)) {
        draft.channels = preserveChannelPreferences(partial.channels, currentChannels, !manual);
        setActiveProvider(draft.provider);
        /*
         * A frissítés részletekben érkezik. A nézett csatornát a betöltés
         * EGÉSZ IDEJE ALATT megtartjuk, amíg az új listában valóban meg nem
         * tűnik – a döntés a PILLANATNYI állapotból indul (nem abból, amit a
         * frissítés indításakor láttunk), így a háttérben futó betöltés nem
         * vált csatornát a néző alatt.
         *
         * A kijelölt ország (alapértelmezés: Magyarország) itt SOHA nem
         * változik: a betöltés nem veheti át a néző által beállított lista
         * helyét.
         */
        const isSameProvider = activeProviderRef.current?.id === id;
        const watchedId = activeChannelIdRef.current;
        const currentlyWatched = isSameProvider
          ? currentChannels.find((channel) => channel.id === watchedId)
          : undefined;
        const watchedStillInList = !!currentlyWatched
          && draft.channels.some((channel) => channel.id === currentlyWatched.id);
        const visibleChannels = currentlyWatched && !watchedStillInList
          ? [...draft.channels, currentlyWatched]
          : draft.channels;
        const orderedVisibleChannels = hungaryFirst(visibleChannels);
        setChannels(orderedVisibleChannels);
        channelsRef.current = orderedVisibleChannels;
        activeProviderRef.current = draft.provider;
        // Csatornaváltás CSAK a valóban elveszett csatorna után, és mindig
        // magyar csatornára (a hungaryFirst sorrend első eleme).
        keepOrMoveActiveChannel(orderedVisibleChannels, false);
        if (partial.channels.length > 0 && !refreshLivePromptShownRef.current) {
          refreshLivePromptShownRef.current = true;
          setRefreshLivePromptOpen(true);
        }
      }
      if (partial.liveCategories) {
        draft.liveCategories = partial.liveCategories;
        // Csak tartalmi változásnál rajzoljuk újra a kategóriákat.
        setCategories((current) => (sameCategories(current, partial.liveCategories!) ? current : partial.liveCategories!));
      }
      if (partial.movies) {
        const nextMovies = keepIfFilled(moviesRef.current, partial.movies);
        if (nextMovies) {
          draft.movies = nextMovies;
          setMovies(nextMovies);
          moviesRef.current = nextMovies;
        }
      }
      if (partial.vodCategories) {
        draft.vodCategories = partial.vodCategories;
        setVodCategories((current) => (sameCategories(current, partial.vodCategories!) ? current : partial.vodCategories!));
      }
      if (partial.series) {
        const nextSeries = keepIfFilled(seriesRef.current, partial.series);
        if (nextSeries) {
          draft.series = nextSeries;
          setSeries(nextSeries);
          seriesRef.current = nextSeries;
        }
      }
      if (partial.seriesCategories) {
        draft.seriesCategories = partial.seriesCategories;
        setSeriesCategories((current) => (sameCategories(current, partial.seriesCategories!) ? current : partial.seriesCategories!));
      }
      setTotalCounts({ ...draft.totals });

      // A mentés előtt visszaadjuk a vezérlést a felületnek; a sorozat
      // adagjai pedig befejeződnek, mielőtt az import a következő fázisra lép.
      if (refreshGenerationRef.current !== refreshGeneration) return;
      if (partial.channels || partial.movies || partial.series) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        if (refreshGenerationRef.current !== refreshGeneration) return;
      }
      // ELŐNÉZET (a teljes lista még töltődik): csak megjelenítés, hogy a
      // néző azonnal választhasson csatornát. Félkész listát NEM mentünk a
      // tárolóba – így nem maradhat hiányos adat a TV-n.
      if (!partial.preview) {
        if (partial.channels) saveLiveContent(draft);
        if (partial.movies) await saveVodContent(draft);
        if (partial.series) await saveSeriesContent(draft);
      }

      setProviders((current) => {
        const base = current.some((p) => p.id === id) ? current : providersForRefresh;
        const updatedProviders = base.map((p) =>
          p.id === id
            ? {
                ...p,
                // A draft ténylegesen feldolgozott tömbje az egyetlen számlálóforrás.
                channelsCount: partial.channels ? draft.channels.length : p.channelsCount,
                moviesCount: partial.movies ? draft.movies.length : p.moviesCount,
                seriesCount: partial.series ? draft.series.length : p.seriesCount,
                lastUpdated: new Date().toISOString().slice(0, 10).replace(/-/g, '. ') + '.',
                isActive: true,
              }
            : { ...p, isActive: false }
        );
        storageService.saveProviders(updatedProviders);
        return updatedProviders;
      });
    };

    try {
      const result = await refreshProviderContent(
        provider,
        (progress) => {
          if (refreshGenerationRef.current !== refreshGeneration || diagnosticFinishedRef.current || progress.percent >= 100) return;
          const now = performance.now();
          // 250 ms-os ritkítás: a folyamatjelző ennyi alatt is folyamatosnak
          // látszik, a főszál viszont a feldolgozással foglalkozhat.
          if (progress.percent < 99 && now - lastProgressPaintRef.current < DIAGNOSTIC_FLUSH_MS) return;
          lastProgressPaintRef.current = now;
          setDiagnosticProgress(progress);
          setLastImportDiagnostic(() => ({ providerId: id, providerName: provider.name, progress, events: diagnosticEventsRef.current, error: null, startedAt: refreshStartedAt, finished: false }));
        },
        applyPartial
      );
      if (refreshGenerationRef.current !== refreshGeneration) return;
      const content: ImportedContent =
        'content' in result ? result.content : (result as ImportedContent);

      // Xtream API-fiókadatok: a lejárat és a kapcsolatkorlát az auth válaszból jön.
      // QR-rel hozzáadott szolgáltatónál is felülírjuk az induló N/A értékeket.
      if ('user' in result && result.user) {
        // A hitelesítési válasz nem írhatja vissza a részleges importból már
        // megérkezett darabszámokat a frissítés kezdeti (gyakran nullás) értékeire.
        setProviders((current) => {
          const base = current.some((p) => p.id === id) ? current : providersForRefresh;
          const updatedProviders = base.map((p) =>
            p.id === id
              ? {
                  ...p,
                  expireDate: result.user.expireDate,
                  maxConnections: result.user.maxConnections,
                }
              : p
          );
          storageService.saveProviders(updatedProviders);
          return updatedProviders;
        });
      }

      /*
       * A betöltés vége. Minden döntés a PILLANATNYI állapotból indul
       * (channelsRef / activeChannelIdRef / activeProviderRef), nem abból a
       * lezárt példányból, amit a frissítés indításakor láttunk. Enélkül a
       * több percig futó betöltés a végén „elveszettnek” hitte a néző által
       * közben kiválasztott csatornát, és a lista első – gyakran külföldi –
       * adójára ugrott (ez volt a magától váltó OSD).
       */
      const previousChannels = channelsRef.current;
      const previousMovies = moviesRef.current;
      const previousSeries = seriesRef.current;
      // Ugyanazon provider frissítésénél megtartjuk az éppen nézett csatornát;
      // új provider importjakor régi csatorna nem kerülhet az új lista mellé
      // és nem blokkolhatja a csatornaváltást.
      const isSameProvider = activeProviderRef.current?.id === id;
      // Kézi provider-frissítéskor a csatornák sorrendje a szolgáltató sorrendjére áll vissza.
      // A kedvencjelöléseket és a mappákhoz tartozó stabil csatornaazonosítókat megtartjuk.
      const refreshedChannels = preserveChannelPreferences(content.channels, previousChannels, !manual);
      const watchedId = activeChannelIdRef.current;
      const currentlyWatched = isSameProvider
        ? previousChannels.find((channel) => channel.id === watchedId)
        : undefined;
      const channelsForDisplay = currentlyWatched && !refreshedChannels.some((channel) => channel.id === currentlyWatched.id)
        ? [...refreshedChannels, currentlyWatched]
        : refreshedChannels;
      const refreshedContent: ImportedContent = { ...content, channels: refreshedChannels };
      setActiveProvider(draft.provider);
      activeProviderRef.current = draft.provider;
      const liveToShow = keepIfFilled(previousChannels, hungaryFirst(channelsForDisplay));
      const moviesToShow = keepIfFilled(previousMovies, refreshedContent.movies);
      const seriesToShow = keepIfFilled(previousSeries, refreshedContent.series);
      // Üres hibaválasz ugyanazon provider frissítésekor nem törölheti a
      // korábban működő cache-t. Új provider esetén viszont nem mentjük a
      // régi provider listáját az új azonosító alá.
      const keepPreviousContent = isSameProvider;
      const persistedChannels = liveToShow || (keepPreviousContent ? previousChannels : refreshedContent.channels);
      const persistedMovies = moviesToShow || (keepPreviousContent ? previousMovies : refreshedContent.movies);
      const persistedSeries = seriesToShow || (keepPreviousContent ? previousSeries : refreshedContent.series);
      const contentForStorage: ImportedContent = {
        ...refreshedContent,
        channels: persistedChannels,
        movies: persistedMovies,
        series: persistedSeries,
        liveCategories: refreshedContent.liveCategories.length || !keepPreviousContent
          ? refreshedContent.liveCategories
          : categoriesRef.current,
        vodCategories: refreshedContent.vodCategories.length || !keepPreviousContent
          ? refreshedContent.vodCategories
          : vodCategoriesRef.current,
        seriesCategories: refreshedContent.seriesCategories.length || !keepPreviousContent
          ? refreshedContent.seriesCategories
          : seriesCategoriesRef.current,
        totals: {
          live: persistedChannels.length,
          vod: persistedMovies.length,
          series: persistedSeries.length,
        },
      };
      if (liveToShow) setChannels(liveToShow);
      channelsRef.current = liveToShow || previousChannels;
      /*
       * A lejátszó és a D-pad navigáció CSAK akkor áll át másik csatornára, ha
       * a nézett azonosító valóban nincs az új listában – és akkor is a MAGYAR
       * sorrend első csatornájára. Korábban ez a nyers, rendezetlen
       * `refreshedContent.channels[0]` volt, vagyis a szolgáltató lista első
       * (többnyire külföldi) adója: ezért „vette át” a betöltés a beállított
       * Magyar ország / magyar csatornák helyét.
       */
      keepOrMoveActiveChannel(hungaryFirst(refreshedContent.channels), true);
      setCategories((current) => (sameCategories(current, contentForStorage.liveCategories) ? current : contentForStorage.liveCategories));
      if (moviesToShow) setMovies(moviesToShow);
      setVodCategories((current) => (sameCategories(current, contentForStorage.vodCategories) ? current : contentForStorage.vodCategories));
      if (seriesToShow) setSeries(seriesToShow);
      setSeriesCategories((current) => (sameCategories(current, contentForStorage.seriesCategories) ? current : contentForStorage.seriesCategories));
      setTotalCounts(contentForStorage.totals);
      // A preview-szakaszok szándékosan nem írnak tartós listát. A végső,
      // enrichmentelt snapshotot pontosan egyszer mentjük, így a részleges
      // betöltések nem okoznak dupla/nem-metaadatos mentést.
      saveLiveContent(contentForStorage);
      await saveVodContent(contentForStorage);
      await saveSeriesContent(contentForStorage);
      dirtyRef.current = false;

      const finishedAt = performance.now();
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
      setDiagnosticFinishedAt(finishedAt);
      setLastImportDiagnostic({ providerId: id, providerName: provider.name, progress: finalProgress, events: diagnosticEventsRef.current, error: null, startedAt: refreshStartedAt, finished: true, finishedAt });
      flushDiagnosticNow();
      setNetworkDiagnosticSink(null);
      providerRefreshActiveRef.current = false;
    } catch (error) {
      // Egy új frissítés vagy a felhasználó megszakítása a régi importot is
      // leállíthatja. Ez nem felhasználói hiba, és a régi async hívás nem
      // írhatja felül az új diagnosztika állapotát.
      if (refreshGenerationRef.current !== refreshGeneration || isNetworkRequestCancelled(error)) return;
      const finishedAt = performance.now();
      diagnosticFinishedRef.current = true;
      setProviderContentReady(false);
      flushDiagnosticNow();
      setNetworkDiagnosticSink(null);
      setDiagnosticFinishedAt(finishedAt);
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
        finishedAt,
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

  const closeRefreshDiagnostic = useCallback(() => {
    // A VISSZA csak a diagnosztikai ablakot zárja be; a háttérben már futó
    // tartalomfrissítést nem szakítjuk félbe, viszont annak minden diagnosztikai
    // sinkje, flush-időzítője és további React-frissítése azonnal leáll.
    diagnosticFinishedRef.current = true;
    cancelDiagnosticFlush();
    setNetworkDiagnosticSink(null);
    setDiagnosticOpen(false);
    setDiagnosticEvents([]);
    setDiagnosticError(null);
    setDiagnosticProgress(null);
    setDiagnosticFinishedAt(null);
  }, [cancelDiagnosticFlush]);

  const closeLastImportDiagnostic = useCallback(() => {
    setLastImportDiagnosticOpen(false);
  }, []);

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
        const seriesMetadata = parseSeriesMetadata(info);
        const seasons: Season[] = Object.keys(episodesBySeason)
          .sort((a, b) => Number(a) - Number(b))
          .map((seasonKey) => {
            const episodes = episodesBySeason[seasonKey] || [];
            return {
              seasonNumber: Number(seasonKey),
              name: `${seasonKey}. évad`,
              episodeCount: episodes.length,
              episodes: episodes.map((episode, index) => {
                const metadata = parseEpisodeMetadata(episode);
                return {
                  id: `ep-${target.id}-${episode.id ?? index}`,
                  episodeNumber: Number(episode.episode_num ?? index + 1),
                  seasonNumber: Number(seasonKey),
                  title: episode.title || `${index + 1}. rész`,
                  // Nincs több kitalált 45 perces érték: a hiányzó játékidő 0.
                  durationMinutes: metadata.durationMinutes || 0,
                  streamUrl: xtreamService.buildSeriesStreamUrl(
                    provider.serverUrl || '',
                    provider.username || '',
                    provider.password || '',
                    episode.id ?? '',
                    episode.container_extension || 'mp4'
                  ),
                  plot: episode.info?.plot || '',
                  thumbnail: episode.info?.movie_image || target.poster,
                  audioTracks: metadata.audioTracks,
                  subtitleTracks: metadata.subtitleTracks,
                  audioLanguages: metadata.audioLanguages?.length ? metadata.audioLanguages : [UNKNOWN_LANGUAGE],
                  subtitleLanguages: metadata.subtitleLanguages?.length ? metadata.subtitleLanguages : [UNKNOWN_LANGUAGE],
                };
              }),
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
                  durationMinutes: seriesMetadata.durationMinutes || item.durationMinutes || 0,
                  audioTracks: seriesMetadata.audioTracks,
                  subtitleTracks: seriesMetadata.subtitleTracks,
                  audioLanguages: seriesMetadata.audioLanguages?.length ? seriesMetadata.audioLanguages : [UNKNOWN_LANGUAGE],
                  subtitleLanguages: seriesMetadata.subtitleLanguages?.length ? seriesMetadata.subtitleLanguages : [UNKNOWN_LANGUAGE],
                  backdrop: seriesMetadata.backdrop || item.backdrop,
                  cast: seriesMetadata.cast?.length ? seriesMetadata.cast : item.cast,
                  director: seriesMetadata.director || item.director,
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
  const handlePlayMovie = useCallback((movie: Movie) => {
    returnToFavoritesSettingsRef.current = false;
    lastResumeHistoryIdRef.current = null;
    vodReturnViewRef.current = 'movies';
    lastVodSelectionRef.current = { view: 'movies', cardId: String(movie.id) };
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
    setHistory((previous) => {
      const updatedHistory = [historyItem, ...previous.filter((h) => h.title !== movie.title)];
      storageService.saveHistory(updatedHistory);
      return updatedHistory;
    });
  }, []);

  // Play Series Episode in Main Video Player
  const handlePlayEpisode = useCallback((ser: Series, episode: Episode) => {
    returnToFavoritesSettingsRef.current = false;
    lastResumeHistoryIdRef.current = null;
    vodReturnViewRef.current = 'series';
    lastVodSelectionRef.current = { view: 'series', cardId: String(ser.id), episodeId: String(episode.id) };
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
    setHistory((previous) => {
      const updatedHistory = [historyItem, ...previous.filter((h) => h.title !== historyItem.title)];
      storageService.saveHistory(updatedHistory);
      return updatedHistory;
    });
  }, []);

  const handleRemoveWatchHistoryItem = (id: string) => {
    const updatedHistory = history.filter((item) => item.id !== id);
    setHistory(updatedHistory);
    storageService.saveHistory(updatedHistory);
  };

  /**
   * Az indítási pozíció (folytatás) EGYSZER számolódik ki, amikor a lejátszott
   * stream megváltozik. Korábban minden kirajzoláskor lefutott egy `history.find`,
   * és a lejátszó 500 ms-os idővonal-időzítője másodpercenként újraindult,
   * mert a prop értéke folyamatosan változott.
   */
  const historyRef = useRef(history);
  historyRef.current = history;
  const initialPlaybackPosition = useMemo(() => {
    if (!customStreamUrl) return 0;
    const item = historyRef.current.find(
      (entry) => entry.streamUrl === customStreamUrl && entry.mediaType !== 'live'
    );
    return item?.positionSeconds || 0;
  }, [customStreamUrl]);

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
    if (!customStreamUrl) return { audioTracks: undefined, subtitleTracks: undefined, subtitleSource: null };
    /*
     * A szolgáltatói FELIRAT (CC) kereséshez kellenek a film/epizód azonosítói.
     * Xtream esetén ezek a stream URL-ből is kiolvashatók:
     *   …/movie/<user>/<pass>/<vodId>.<ext>
     *   …/series/<user>/<pass>/<episodeId>.<ext>
     */
    const provider = activeProvider;
    /*
     * Tartalék: ha a lista M3U-címmel került be (nem Xtream belépéssel), a
     * szolgáltató adatai nincsenek külön eltárolva – pedig a film címe
     * (…/movie/<felhasználó>/<jelszó>/<id>.mkv) tartalmazza őket. Enélkül
     * M3U-s hozzáadásnál a szolgáltatói CC-keresés el sem indult.
     */
    const derivedProviderBase = (() => {
      const match = String(customStreamUrl).match(/^(https?:\/\/[^/]+)\/(?:movie|series)\/([^/]+)\/([^/]+)\//i);
      if (!match) return null;
      const decode = (value: string) => {
        try { return decodeURIComponent(value); } catch { return value; }
      };
      return { serverUrl: match[1], username: decode(match[2]), password: decode(match[3]) };
    })();
    const providerBase = provider && provider.type === 'xtream' && provider.serverUrl && provider.username && provider.password
      ? { serverUrl: provider.serverUrl, username: provider.username, password: provider.password }
      : derivedProviderBase;
    const idFromUrl = (url: string) => {
      const clean = String(url || '').split(/[?#]/)[0];
      const last = clean.split('/').filter(Boolean).pop() || '';
      return last.replace(/\.[a-z0-9]+$/i, '');
    };

    const movie = movies.find((item) => item.streamUrl === customStreamUrl);
    if (movie) {
      return {
        audioTracks: movie.audioTracks,
        subtitleTracks: movie.subtitleTracks,
        subtitleSource: providerBase ? { ...providerBase, vodId: movie.streamId ?? idFromUrl(movie.streamUrl) } : null,
      };
    }
    for (const item of series) {
      for (const season of item.seasons) {
        for (const episode of season.episodes) {
          if (episode.streamUrl === customStreamUrl) {
            return {
              audioTracks: episode.audioTracks,
              subtitleTracks: episode.subtitleTracks,
              subtitleSource: providerBase
                ? {
                    ...providerBase,
                    // Néhány importált sorozatnál a külön seriesId mező hiányozhat,
                    // miközben az id mező az Xtream series_id értékét tartalmazza.
                    seriesId: item.seriesId ?? item.id,
                    // Az epizód stream URL-je az elsődleges forrás; az epizód id a tartalék.
                    episodeId: idFromUrl(episode.streamUrl) || episode.id,
                  }
                : null,
            };
          }
        }
      }
    }
    // Előzményből vagy részleges import közben is működjön a CC-keresés,
    // ha a film már lejátszható, de a teljes filmkártya-listában még nincs benne.
    if (providerBase && /\/movie\//i.test(String(customStreamUrl).split(/[?#]/)[0])) {
      return {
        audioTracks: undefined,
        subtitleTracks: undefined,
        subtitleSource: { ...providerBase, vodId: idFromUrl(customStreamUrl) },
      };
    }
    return { audioTracks: undefined, subtitleTracks: undefined, subtitleSource: null };
  }, [customStreamUrl, movies, series, activeProvider]);

  /** Az előzmény mentésének legutóbbi időpontja (lásd handlePlaybackProgress). */
  const lastHistorySaveAtRef = useRef(0);
  /** A legutóbbi lejátszási helyzet (a felületre legfeljebb 2 másodpercenként megy ki). */
  const pendingProgressRef = useRef<{ position: number; duration: number } | null>(null);
  const lastHistoryUiAtRef = useRef(0);
  const progressFlushTimerRef = useRef<number | null>(null);

  /**
   * A lejátszási helyzet beírása az előzményekbe.
   *
   * FONTOS (az egész felület lassulása): a lejátszó másodpercenként jelent, és
   * korábban minden jelzés `setHistory`-t hívott. Az App újrarajzolódott, vele
   * a fejléc, a csatornalista és a teljes lejátszó OSD - filmnézés közben
   * másodpercenként. Most a felület legfeljebb 2 másodpercenként kap frissítést,
   * a tárolóba pedig továbbra is legfeljebb 5 másodpercenként írunk.
   */
  const applyProgressToHistory = useCallback((positionSeconds: number, durationSeconds: number) => {
    if (!customStreamUrl) return;
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

  const handlePlaybackProgress = useCallback((positionSeconds: number, durationSeconds: number) => {
    if (!customStreamUrl || !Number.isFinite(positionSeconds) || positionSeconds < 0) return;
    pendingProgressRef.current = { position: positionSeconds, duration: durationSeconds };
    const now = Date.now();
    const elapsed = now - lastHistoryUiAtRef.current;
    if (elapsed >= 2000) {
      lastHistoryUiAtRef.current = now;
      applyProgressToHistory(positionSeconds, durationSeconds);
      return;
    }
    if (progressFlushTimerRef.current === null) {
      progressFlushTimerRef.current = window.setTimeout(() => {
        progressFlushTimerRef.current = null;
        const pending = pendingProgressRef.current;
        if (!pending) return;
        lastHistoryUiAtRef.current = Date.now();
        applyProgressToHistory(pending.position, pending.duration);
      }, Math.max(250, 2000 - elapsed));
    }
  }, [customStreamUrl, applyProgressToHistory]);

  useEffect(() => () => {
    if (progressFlushTimerRef.current !== null) {
      window.clearTimeout(progressFlushTimerRef.current);
      progressFlushTimerRef.current = null;
    }
  }, []);

  // Resume History item
  const handlePlayHistoryItem = (item: WatchHistoryItem) => {
    // Ez a függvény a Beállítások > Kedvencek > Folytatás listájából indul.
    // Kilépéskor kizárólag ehhez a felülethez térünk vissza, nem a Mozi/Sorozat nézethez.
    returnToFavoritesSettingsRef.current = true;
    lastResumeHistoryIdRef.current = item.id;
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
  // A hat színgyorsgomb kizárólag az Élő TV nézetben működik; nem módosít csatorna- vagy lejátszóállapotot.
  useEffect(() => {
    const onAccentKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (activeView !== 'live' || customStreamUrl || isCategoriesOpen || isSettingsOpen || isEpgOpen || isAudioModalOpen || isSubtitlesModalOpen) return;
      const key = event.key;
      const code = event.keyCode || event.which;
      const next = key === '1' || key === 'Digit1' || code === 49 ? 'red'
        : key === '2' || key === 'Digit2' || code === 50 ? 'blue'
        : key === '3' || key === 'Digit3' || code === 51 ? 'pink'
        : key === '4' || key === 'Digit4' || code === 52 ? 'yellow'
        : key === '5' || key === 'Digit5' || code === 53 ? 'green'
        : key === '6' || key === 'Digit6' || code === 54 ? 'white' : null;
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      setLiveAccent(next);
      try { localStorage.setItem('iptv-live-accent', next); } catch { /* a színváltás tároló nélkül is működik */ }
      if (isVideoFullscreen) showFullscreenLiveOsd();
    };
    window.addEventListener('keydown', onAccentKey, true);
    return () => window.removeEventListener('keydown', onAccentKey, true);
  }, [activeView, customStreamUrl, isCategoriesOpen, isSettingsOpen, isEpgOpen, isAudioModalOpen, isSubtitlesModalOpen, isVideoFullscreen, showFullscreenLiveOsd]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // LG webOS: a távirányító régi kulcsnevet ('Up') vagy csak keyCode-ot
      // (37–40, OK=13, VISSZA=461) küldhet – egységesítjük, különben a TV-n
      // egyetlen gomb sem működne.
      const key = normalizeTvKey(e);

      // Szövegmezőben ne vegyük át a távirányító gombjait.
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      // A beállítások saját navigációja kezeli a nyilakat; a globális
      // kezelő itt sem fókuszt, sem csatornát, sem hangerőt nem módosíthat.
      if (target?.closest?.('[data-tv-navigation-owner="settings"]')) return;

      // Teljes képernyőben bármely gomb visszahozza az OSD-t (és újraindítja
      // az eltűnési időzítőt) – a set-top box-ok szokása. A hívás akkor sem
      // rajzol újra semmit, ha az OSD már látszik: a React azonos értéknél
      // nem renderel.
      if (isVideoFullscreen && !customStreamUrl) {
        showFullscreenLiveOsd();
      }

      // Védelmi tartalék a LoadingDiagnosticModal saját kezelője mögött: a
      // webOS VISSZA néha közvetlenül a documentre érkezik. Ilyenkor a
      // diagnosztikát zárjuk, nem a háttérben lévő lejátszót vagy nézetet.
      if ((key === 'Escape' || key === 'Backspace') && diagnosticOpen) {
        e.preventDefault();
        e.stopPropagation();
        closeRefreshDiagnostic();
        return;
      }
      if ((key === 'Escape' || key === 'Backspace') && lastImportDiagnosticOpen) {
        e.preventDefault();
        e.stopPropagation();
        closeLastImportDiagnostic();
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
            )).filter((el) => el !== target && el.getClientRects().length > 0);
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
              // A felső menüsor aljáról lefelé: a kedvenc mappák sávjára
              // (Kedvencek / Összes / mappák). Innen egy lefelé lépés a
              // csatornalista ELSŐ SORÁRA visz – a lista dobozára soha.
              const folder = document.querySelector<HTMLElement>('[data-tv-folders] [data-tv-folder]');
              if (folder) {
                e.preventDefault();
                e.stopPropagation();
                folder.focus({ preventScroll: true } as any);
              }
            }
            }
          }
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const channelListHost = active?.closest?.('[role="listbox"]') as HTMLElement | null;
      const isInHiddenChannelList = Boolean(channelListHost?.closest?.('[data-view-hidden]') || channelListHost?.style.visibility === 'hidden');
      // A láthatatlan, DOM-ban tartott élő lista nem kaphatja meg a Mozi/Sorozat
      // vagy teljes képernyős gombot. A webOS-réteg normál esetben már a
      // lejátszóra továbbította; ez a böngészős védelmi ág csak elnyeli a
      // későn ott maradt fókusz eseményét.
      if (isInHiddenChannelList && (isTvArrowKey(key) || key === 'Enter')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const isInChannelList = Boolean(channelListHost && !isInHiddenChannelList)
        || active?.getAttribute?.('role') === 'option' && !isInHiddenChannelList
        || Boolean(active?.closest?.('[data-channel-id]') && !isInHiddenChannelList);

      switch (key) {
        case 'ArrowUp':
          if (isInChannelList) break; // ChannelList kezeli – ne váltson csatornát
          // Mozi/Sorozat nézetben a nyilak a NÉZETBEN mozgatnak (webos.js):
          // itt nem szabad csatornát váltani, különben a háttérben másik
          // adás indulna böngészés közben.
          if (activeView !== 'live') break;
          e.preventDefault();
          if (isCategoriesOpen || isSettingsOpen || isEpgOpen || isAudioModalOpen || isSubtitlesModalOpen) break;
          handlePrevChannel();
          break;
        case 'ArrowDown':
          if (isInChannelList) break;
          if (activeView !== 'live') break;
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
          if (activeView !== 'live') break;
          e.preventDefault();
          if (isCategoriesOpen || isSettingsOpen || isEpgOpen || isAudioModalOpen || isSubtitlesModalOpen) break;
          handlePrevChannel();
          break;
        case 'PageDown':
          // LG távirányító CH- gomb (keyCode 34)
          if (activeView !== 'live') break;
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
            break;
          }
          // Mozi/Sorozat nézetben a VISSZA gomb az élő nézetbe tér vissza.
          // Korábban ehhez a fejléc TV gombjáig kellett visszanavigálni, a
          // nézetből viszont nem lehetett kijutni.
          if (activeView !== 'live') {
            e.preventDefault();
            handleViewChange('live');
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
  }, [handleNextChannel, handlePrevChannel, handleVolumeChange, handleToggleMute, isCategoriesOpen, isSettingsOpen, isEpgOpen, isAudioModalOpen, isSubtitlesModalOpen, isVideoFullscreen, customStreamUrl, volume, settings.seekStep, showFullscreenLiveOsd, activeView, handleViewChange, diagnosticOpen, lastImportDiagnosticOpen, closeRefreshDiagnostic, closeLastImportDiagnostic]);

  // TV távirányító: ZÖLD/SÁRGA/KÉK gyorsgombok a webos.js-ből egyedi
  // eseményként érkeznek (minden fókuszhelyzetben megbízható).
  useEffect(() => {
    const onTvAction = (e: Event) => {
      const action = (e as CustomEvent)?.detail?.action;
      // ZÖLD gomb: kizárólag élő TV-n nyílik meg az egyesített Audio + CC választó.
      if (action === 'audio' && activeView === 'live' && !customStreamUrl) {
        setIsSubtitlesModalOpen(false);
        setIsAudioModalOpen((prev) => !prev);
      }
      // A 'move' (KÉK) és 'favorite' (SÁRGA) eseményeket a csatornalista kezeli.
      else if (action === 'settings') setIsSettingsOpen((prev) => !prev);
      else if (action === 'epg') setIsEpgOpen((prev) => !prev);
      else if (action === 'categories') setIsCategoriesOpen((prev) => !prev);
      // PIROS (Record) gomb: TÜKRÖZÖTT elrendezés be/ki.
      // A felhasználó kérésére a piros gomb mostantól a főoldali
      // elrendezést fordítja meg (csatornalista balra, OSD jobbra).
      else if (action === 'mirror') handleToggleMirrorLayout();
      else if (action === 'diagnostic-share') setIsDiagnosticShareOpen(true);
      /*
       * FILM / SOROZAT alatt a ZÖLD és a KÉK gomb a lejátszó KÉK OSD-dobozát
       * nyitja (hangsáv / felirat). A webos.js csak akkor küldi ezeket, ha a
       * lejátszó data-vod-active jelölése ott van – élő TV-n tehát a régi
       * funkciók (hangválasztó ablak / csatornamozgatás) maradnak.
       */
      else if (action === 'vod-audio') {
        window.dispatchEvent(new CustomEvent('iptv-vod-menu', { detail: { menu: 'audio' } }));
      }
      else if (action === 'vod-subtitles') {
        window.dispatchEvent(new CustomEvent('iptv-vod-menu', { detail: { menu: 'subtitle' } }));
      }
    };
    window.addEventListener('iptv-tv-action', onTvAction);
    return () => window.removeEventListener('iptv-tv-action', onTvAction);
  }, [handleToggleMirrorLayout, activeView, customStreamUrl]);

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
        // Mozi/Sorozat nézetben a csatornalista rejtve van (display:none) –
        // ide soha nem vihetjük a kijelölőt, mert a távirányító megragadna.
        if (document.querySelector('[data-view-pane]:not([data-view-hidden])')?.getAttribute('data-view-pane') !== 'live') return;
        if (list.contains(active)) return;
        /*
         * A fókusz a KIVÁLASZTOTT csatorna sorára kerül – nem az első sorra.
         *
         * HIVA: korábban ez a keresés `[data-channel-id] [role="option"]` volt,
         * ami a lista ELSŐ sorát adta vissza (a kiválasztottit nem). Teljes
         * képernyőről visszatérve a néző így az első sorra lépett, és a
         * következő OK már egy másik csatornára váltott – „magától átugrott”.
         * A kijelölést a sor `aria-selected="true"` jelzése hordozza.
         */
        const selected = document.querySelector<HTMLElement>('[role="listbox"] [role="option"][aria-selected="true"]');
        const first = document.querySelector<HTMLElement>('[role="listbox"] [role="option"]');
        const target = selected || first;
        if (target) {
          target.focus({ preventScroll: true } as any);
        } else {
          const folder = document.querySelector<HTMLElement>('[data-tv-folders] [data-tv-folder]');
          if (folder) folder.focus({ preventScroll: true } as any);
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
          // Teljes képernyőn a kijelölő a LEJÁTSZÓN marad (a csatornaváltás
          // miatt) – a rejtett csatornalistára nem visszük vissza.
          if (isVideoFullscreen) return;
          if (document.querySelector('[data-view-pane]:not([data-view-hidden])')?.getAttribute('data-view-pane') !== 'live') return;
          // A fókusz a KIVÁLASZTOTT csatornasorra kerül (aria-selected), nem a
          // lista első sorára – különben a kilépés utáni OK másik csatornát
          // indítana. A lista doboza soha nem fókuszolható.
          const activeRow = document.activeElement as HTMLElement | null;
          if (activeRow && activeRow.getAttribute && activeRow.getAttribute('role') === 'option'
              && activeRow.getAttribute('aria-selected') === 'true') return;
          const selected = document.querySelector<HTMLElement>('[role="listbox"] [role="option"][aria-selected="true"]');
          const first = document.querySelector<HTMLElement>('[role="listbox"] [role="option"]');
          const target = selected || first;
          if (target) {
            target.focus({ preventScroll: true } as any);
          } else {
            const folder = document.querySelector<HTMLElement>('[data-tv-folders] [data-tv-folder]');
            if (folder) folder.focus({ preventScroll: true } as any);
          }
        } catch {}
      };
      const t = window.setTimeout(focusBack, 150);
      return () => clearTimeout(t);
    }
  }, [isCategoriesOpen, isSettingsOpen, isEpgOpen, isAudioModalOpen, isSubtitlesModalOpen, isVideoFullscreen]);

  // Kép a képben támogatás: korábban ezt minden kirajzoláskor egy DOM-kereséssel
  // (!) ellenőriztük, kétszer. Elég a környezet egyszeri vizsgálata.
  const pipSupported = Boolean((document as any).pictureInPictureEnabled);

  return (
    <div data-app-root="" className="flex flex-col h-[100dvh] min-h-[100dvh] w-full min-w-0 max-w-none bg-[#080d1a] text-slate-100 overflow-hidden font-sans select-none shadow-2xl border-x border-cyan-950/40">
      
      {/*
        A FEJLÉC MINDIG A DOM-BAN VAN.
        Korábban teljes képernyőn kikerült (unmount), és a kilépéskor a
        React újraépítette – ez volt az egyik oka a teljes képernyőből való
        visszatérés lassúságának. Teljes képernyőn a webOS CSS (webos.js)
        és a lejátszó átfedése rejti el; a mount/unmount nem kell hozzá.
      */}
      <Header
        mirrorLayout={settings.mirrorLayout}
        liveAccent={liveAccent}
        clockOffsetHours={settings.clockOffsetHours}
        activeView={activeView}
        onViewChange={handleViewChange}
        onOpenCategories={handleOpenCategories}
        onOpenSettings={handleOpenSettings}
        countryFlag={activeCountryCategory?.flag}
        countryName={activeCountryCategory?.name}
      />

      {/*
        NÉZET-TÁROLÓ. A három nézet egymás fölött, abszolút pozícióban él;
        a váltás csak a láthatóságot kapcsolja. Így a TV ↔ Mozi ↔ Sorozat
        váltás azonnali, és a Mozi/Sorozat nézet görgetési pozíciója,
        keresése is megmarad.
      */}
      <div className="relative flex-1 flex flex-col min-h-0">

      {/* ===== ÉLŐ TV NÉZET ===== */}
      <div
        data-view-pane="live"
        data-live-accent={liveAccent}
        data-view-hidden={activeView === 'live' ? undefined : ''}
        className="absolute inset-0 flex flex-col min-h-0"
        style={paneStyle(activeView === 'live')}
      >

        {/* Live TV View – reszponzív: mobilon egymás alatt, tablet/laptop/TV-n egymás mellett */}
        {/*
          TÜKRÖZÖTT ELRENDEZÉS (PIROS / Record gomb).
          Ilyenkor a sor iránya megfordul: a csatornalista (a kedvenc
          mappákkal) a BAL oldalra, a lejátszó és az OSD a JOBB oldalra
          kerül. A felső menüsor és a működés változatlan – csak a helyek
          cserélődnek.
        */}
        <div
          data-live-main-row=""
          data-mirror={settings.mirrorLayout ? '1' : undefined}
          className={`flex-1 flex flex-col ${settings.mirrorLayout ? 'md:flex-row-reverse' : 'md:flex-row'} overflow-hidden min-h-0`}
        >
          {/* Video + Controls – mobilon felül, desktopon bal oldalt rugalmas */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-0 md:min-w-0">
          {/* Video Player */}
          <VideoPlayer
            liveAccent={liveAccent}
            channel={activeChannel}
            customStreamUrl={customStreamUrl}
            customTitle={customStreamTitle}
            /* Élő adás csak a főoldalon (élő nézetben) indul – Mozi/Sorozat
               nézetben a háttérben sem kép, sem hang nem megy. */
            playbackActive={activeView === 'live'}
            onCloseVod={() => {
              // Az OSD piros X-e bezárja a VOD-lejátszót; az App saját
              // teljes képernyős állapotát is azonnal vissza kell állítani,
              // különben a felső TV/Film/Sorozat menü rejtve marad.
              // Bezáráskor a legfrissebb lejátszási helyzetet mentjük (a
              // lejátszás közben csak 5 másodpercenként írunk a tárolóba).
              const returnToFavoritesSettings = returnToFavoritesSettingsRef.current;
              if (returnToFavoritesSettings && customStreamUrl && pendingProgressRef.current) {
                // A Kedvencek/Folytatás felületre visszatéréskor az utolsó lejátszási
                // helyzetet is azonnal mentsük, ne az 5 másodperces mentésre várjunk.
                const pending = pendingProgressRef.current;
                const currentHistory = historyRef.current;
                const index = currentHistory.findIndex((item) => item.streamUrl === customStreamUrl && item.mediaType !== 'live');
                if (index >= 0) {
                  const current = currentHistory[index];
                  const duration = pending.duration > 0 ? pending.duration : current.durationSeconds;
                  const position = Math.max(0, pending.position);
                  const updatedHistory = duration > 0 && position >= duration - 5
                    ? currentHistory.filter((item) => item.id !== current.id)
                    : currentHistory.map((item, itemIndex) => itemIndex === index
                      ? { ...item, positionSeconds: position, durationSeconds: duration,
                          progressPercent: duration > 0 ? Math.min(99, Math.max(0, position / duration * 100)) : item.progressPercent,
                          lastWatchedAt: new Date().toISOString() }
                      : item);
                  historyRef.current = updatedHistory;
                  setHistory(updatedHistory);
                  storageService.saveHistory(updatedHistory);
                } else {
                  storageService.saveHistory(currentHistory);
                }
                pendingProgressRef.current = null;
              } else {
                storageService.saveHistory(historyRef.current);
              }
              setIsVideoFullscreen(false);
              setCustomStreamUrl(undefined);
              setCustomStreamTitle(undefined);
              const returnView = vodReturnViewRef.current;
              setActiveView(returnView);
              const resumeHistoryId = lastResumeHistoryIdRef.current;
              // A normál Mozi/Sorozat visszatérés maradjon a korábbi útvonalon.
              if (returnToFavoritesSettings) setActiveView('live');
              setIsPlaying(false);
              setNextEpisodeToPlay(null);
              if (returnToFavoritesSettings) {
                // Csak a Beállítások > Kedvencek > Folytatás felületéről indított
                // film/sorozat térjen vissza ide. Más VOD-visszatérési útvonal változatlan.
                setSettingsTab('favorites');
                setIsSettingsOpen(true);
                window.setTimeout(() => {
                  const target = resumeHistoryId
                    ? document.querySelector<HTMLElement>(`[data-resume-item="${resumeHistoryId}"] [data-resume-continue]`)
                    : null;
                  const fallback = target || document.querySelector<HTMLElement>('[data-resume-section]');
                  try { fallback?.focus({ preventScroll: false }); } catch { fallback?.focus(); }
                }, 180);
                returnToFavoritesSettingsRef.current = false;
                return;
              }
              /*
               * Normál Mozi/Sorozat böngészésnél maradjon a korábbi visszatérési logika.
               */
              const selection = lastVodSelectionRef.current;
              window.setTimeout(() => {
                const scope = document.querySelector<HTMLElement>(`[data-view-pane="${returnView}"]`) || document;
                const target =
                  (selection?.episodeId ? scope.querySelector<HTMLElement>(`[data-vod-episode="${selection.episodeId}"]`) : null)
                  || scope.querySelector<HTMLElement>('[data-dialog-primary]')
                  || (selection ? scope.querySelector<HTMLElement>(`[data-vod-card="${selection.cardId}"]`) : null);
                try { target?.focus({ preventScroll: false }); } catch { target?.focus(); }
              }, 60);
            }}
            initialPositionSeconds={initialPlaybackPosition}
            onProgress={handlePlaybackProgress}
            audioTracks={currentVodTracks.audioTracks}
            subtitleTracks={currentVodTracks.subtitleTracks}
            subtitleSource={currentVodTracks.subtitleSource}
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

          {isVideoFullscreen && !customStreamUrl && isFullscreenLiveOsdVisible && (
            <FullscreenLiveOsd
              channel={activeChannel}
              displayNumber={activeChannelDisplayNumber}
              liveAccent={liveAccent}
              hasMultipleAudioTracks={liveAudioTracks.length > 1}
              hasAvailableSubtitle={liveSubtitleTracks.length > 0}
            />
          )}

          {/* TV-only channel controls: film/sorozat közben a VOD OSD az egyetlen lejátszóvezérlő.
              Az OSD MOUNTOLVA MARAD teljes képernyő alatt is (csak rejtve):
              korábban minden váltáskor lebontódott és újraépült, ezért a
              visszatéréskor először az OSD „épült fel” a szem előtt. */}
          {!customStreamUrl && <div data-live-osd="" style={{ display: isVideoFullscreen || !isOsdVisible ? 'none' : undefined }}><ChannelControls
            className="main-live-osd"
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
            hasAvailableSubtitle={liveSubtitleTracks.length > 0}
            onOpenSubtitlesModal={() => setIsSubtitlesModalOpen(true)}
            onCastToTv={() => mainPlayerCastRef.current?.()}
            onTogglePip={() => mainPlayerPipRef.current?.()}
                  showPip={pipSupported}
            onOpenEpgModal={() => setIsEpgOpen(true)}
            onOpenChannelDetails={() => {
              setSettingsTab('system');
              setIsSettingsOpen(true);
            }}
            isActive={activeView === 'live' && !customStreamUrl && !isVideoFullscreen && isOsdVisible}
          /></div>}
          </div>
          {/* Virtualized Fast Channel List – reszponzív oldalsáv.
              FONTOS: a lista NEM kerül ki a DOM-ból teljes képernyőn vagy
              film lejátszásakor (csak elrejtjük): így a visszatérés nem jár
              újraépítéssel és a sárga kijelölés/görgetés is megmarad. */}
          <div
              data-live-sidebar=""
              className="flex-1 md:flex-none md:w-[380px] lg:w-[420px] xl:w-[480px] 2xl:w-[560px] flex flex-col overflow-hidden min-h-0 bg-[#070e1e]"
              /*
               * TELJES KÉPERNYŐ: az oldalsáv NEM tűnik el (nincs visibility
               * kapcsolás). A lejátszó doboza `fixed`, teljes kijelzős és
               * FEDETT – alatta nem látszik semmi. Korábban a visibility
               * eldobta a csatornalista kirajzolt rétegét, ezért a
               * visszatéréskor az egész lista újraépült (ez volt a lassú
               * visszalépés). A data-view-hidden csak a fókuszból zárja ki.
               */
              data-view-hidden={isVideoFullscreen || customStreamUrl ? '' : undefined}
              aria-hidden={isVideoFullscreen || customStreamUrl ? true : undefined}
            >
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
                onAssignToFolder={handleAssignChannelToFolder}
                onSelectFavoriteFolder={handleSelectFavoriteFolder}
                isActive={activeView === 'live' && !customStreamUrl && !isVideoFullscreen}
              />
            </div>
        </div>
      </div>
      {/* ===== ÉLŐ TV NÉZET VÉGE ===== */}

      {/* ===== MOZI NÉZET (az első megnyitás után a DOM-ban marad) ===== */}
      {visitedViews.movies && (
        <div
          data-view-pane="movies"
          data-view-hidden={activeView === 'movies' ? undefined : ''}
          className="absolute inset-0 flex flex-col min-h-0"
          style={paneStyle(activeView === 'movies')}
        >
          <MoviesView
            movies={movies}
            categories={vodCategories}
            totalCount={totalCounts.vod}
            onPlayMovie={handlePlayMovie}
            selectedCategoryId={movieCategoryRef.current}
            onSelectedCategoryChange={handleMoviesCategoryChange}
            onBackToLive={handleBackToLive}
            onToggleFavoriteMovie={handleToggleFavoriteMovie}
            isActive={activeView === 'movies'}
          />
        </div>
      )}

      {/* ===== SOROZAT NÉZET (az első megnyitás után a DOM-ban marad) ===== */}
      {visitedViews.series && (
        <div
          data-view-pane="series"
          data-view-hidden={activeView === 'series' ? undefined : ''}
          className="absolute inset-0 flex flex-col min-h-0"
          style={paneStyle(activeView === 'series')}
        >
          <SeriesView
            series={series}
            categories={seriesCategories}
            totalCount={totalCounts.series}
            loadingSeriesId={loadingSeriesId}
            onOpenSeries={handleLoadSeriesInfo}
            onPlayEpisode={handlePlayEpisode}
            selectedCategoryId={seriesCategoryRef.current}
            onSelectedCategoryChange={handleSeriesCategoryChange}
            onBackToLive={handleBackToLive}
            onToggleFavoriteSeries={handleToggleFavoriteSeries}
            isActive={activeView === 'series'}
          />
        </div>
      )}

      </div>
      {/* ===== NÉZET-TÁROLÓ VÉGE ===== */}

      {/* ================= MODALS & DRAWERS ================= */}

      <LoadingDiagnosticModal
        isOpen={lastImportDiagnosticOpen && Boolean(lastImportDiagnostic)}
        progress={lastImportDiagnostic?.progress ?? null}
        events={lastImportDiagnostic?.events ?? []}
        channels={channels}
        logoSource={providers.find((provider) => provider.id === lastImportDiagnostic?.providerId)?.type ?? 'unknown'}
        error={lastImportDiagnostic?.error ?? null}
        startedAt={lastImportDiagnostic?.startedAt ?? performance.now()}
        finishedAt={lastImportDiagnostic?.finishedAt ?? null}
        onClose={closeLastImportDiagnostic}
      />

      <LoadingDiagnosticModal
        isOpen={diagnosticOpen}
        progress={diagnosticProgress}
        events={diagnosticEvents}
        channels={channels}
        logoSource={providers.find((provider) => provider.id === lastRefreshProviderIdRef.current)?.type ?? 'unknown'}
        error={diagnosticError}
        startedAt={diagnosticStartedAt}
        finishedAt={diagnosticFinishedAt}
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
              <button onClick={() => { setRefreshLivePromptOpen(false); closeRefreshDiagnostic(); closeLastImportDiagnostic(); setIsSettingsOpen(false); }} className="py-3 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-black">Bezár, háttérben</button>
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
        folders={folders}
        onAssignChannelsToFolder={handleAssignChannelsToFolder}
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
              finishedAt: performance.now(),
            };
          });
          setLastImportDiagnosticOpen(true);
        }}
        folders={folders}
        onOpenAddFolder={() => setIsOrderModalOpen(true)}
        onDeleteFolder={handleDeleteFolder}
        onToggleFavorite={handleToggleFavorite}
        onRemoveChannelFromFolder={handleRemoveChannelFromFolder}
        onOpenEpgModal={() => setIsEpgOpen(true)}
        onOpenQrProvision={() => setIsQrProvisionOpen(true)}
        onOpenDiagnosticShare={() => setIsDiagnosticShareOpen(true)}
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

      <DiagnosticShareModal
        isOpen={isDiagnosticShareOpen}
        onClose={() => setIsDiagnosticShareOpen(false)}
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
        mode="live"
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
            const hungaryCategoryId = findHungaryCategoryId(incomingCountries) || 'all';
            /*
             * A főoldal induláskor és minden betöltés után MINDIG a magyar
             * csatornacsoportot mutatja – a betöltés soha nem veheti át a
             * beállított „Magyarország / magyar csatornák” helyét, és nem
             * válthat másik országra.
             */
            if (selectedCategoryIdRef.current !== hungaryCategoryId) {
              selectedCategoryIdRef.current = hungaryCategoryId;
              setSelectedCategoryId(hungaryCategoryId);
            }
            const orderedChannels = hungaryFirst(partial.channels);
            setChannels(orderedChannels);
            channelsRef.current = orderedChannels;
            /*
             * A korábban nézett csatornát ne írjuk felül az import első
             * csatornájával.
             *
             * FONTOS: a csatornák TÖBB RÉSZLETBEN érkeznek, és az első adag
             * csak az első 1500 csatornát tartalmazza. Korábban már ennél az
             * előnézetnél eldőlt a kijelölés, ezért ha a mentett csatorna az
             * 1500. után volt, a program „elveszettnek” hitte, és átugrott a
             * lista első csatornájára – a néző ezt úgy látta, hogy betöltés
             * közben magától másik csatornára vált. Ezért a kijelölésről csak
             * a TELJES (nem előnézet) lista után döntünk; addig a nézett
             * csatorna változatlan marad.
             */
            if (partial.preview) {
              if (partial.totals) setTotalCounts((previous) => ({ live: partial.totals?.live ?? previous.live, vod: partial.totals?.vod ?? previous.vod, series: partial.totals?.series ?? previous.series }));
              return;
            }
            const savedLastChannelId = storageService.getLastChannelId() || settings.lastPlayedChannelId;
            const savedLastChannelExists = Boolean(savedLastChannelId && orderedChannels.some((channel) => channel.id === savedLastChannelId));
            const firstHungarianChannel = orderedChannels.find((channel) =>
              (channel.countryCode || 'INT').toUpperCase() === 'HU'
            ) || orderedChannels[0];
            if (savedLastChannelExists) {
              if (activeChannelIdRef.current !== savedLastChannelId) {
                activeChannelIdRef.current = savedLastChannelId!;
                setActiveChannelId(savedLastChannelId!);
              }
            } else if (firstHungarianChannel && activeChannelIdRef.current !== firstHungarianChannel.id) {
              activeChannelIdRef.current = firstHungarianChannel.id;
              setActiveChannelId(firstHungarianChannel.id);
              handleUpdateSettings({ lastPlayedChannelId: firstHungarianChannel.id });
            }
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