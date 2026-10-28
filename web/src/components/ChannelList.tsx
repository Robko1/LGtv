import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Category, Channel, FavoriteFolder } from '../types/iptv';
import { ArrowUp, ArrowDown, Trash2, Star } from 'lucide-react';
import { ChannelLogo } from './ChannelLogo';
import { ProviderRef } from '../services/contentStore';
import { EpgNowNext, getCachedShortEpg, loadShortEpg, nowNextFromEpg, streamIdFor } from '../services/epgService';
import { channelNowNext } from '../services/epgGuide';
import { appLog, appLogError } from '../services/appLog';
import { fsStart } from '../services/fullscreenPerf';
import { normalizeTvKey, isTvArrowKey } from '../utils/tvKeys';

interface ChannelListProps {
  channels: Channel[];
  activeProvider: ProviderRef | null;
  epgReady: boolean;
  epgRevision: number;
  selectedChannelId: string;
  onSelectChannel: (channel: Channel) => void;
  onToggleFavorite: (channelId: string) => void;
  onDeleteChannel: (channelId: string) => void;
  onMoveChannel?: (channelId: string, direction: 'up' | 'down') => void;
  onReorderChannels?: (orderedChannelIds: string[]) => void;
  categories: Category[];
  folders: FavoriteFolder[];
  selectedCategoryId: string;
  isOnlyFavorites: boolean;
  selectedFavoriteFolderId: string | null;
  onSelectFavoriteFolder: (folderId: string | null) => void;
  onDisplayOrderChange?: (orderedChannelIds: string[]) => void;
  /** SÁRGA gomb: a kijelölt csatorna hozzáadása egy kedvenc mappához. */
  onAssignToFolder?: (channelId: string, folderId: string) => void;
  /** Rejtett nézetben az EPG-óra nem frissít, hogy ne legyen háttér-renderelés. */
  isActive?: boolean;
}

/**
 * Egy csatornasor magassága és a sorok közötti hézag.
 *
 * FONTOS (a telefon lefagyásának javítása): a lista ablakosítva (virtualizálva)
 * rajzolódik ki, ezért állandó sormagasság kell. Korábban a sor magassága
 * attól függött, van-e EPG-haladássáv – ezért a haladássáv helye minden sorban
 * előre ki van jelölve (ha nincs adat, üresen marad), így a sorok pontosan
 * egyformák, a kinézet pedig ugyanaz.
 */
const ROW_HEIGHT = 66;
const ROW_GAP = 4;
const ROW_PITCH = ROW_HEIGHT + ROW_GAP;
const LIST_PADDING = 6;
/** A látható területen felül/alul ennyi sort tartunk készen (gyors görgetéshez).
 * TV-n minden nyíllépés újrarajzolja ezeket a sorokat is - a kisebb érték
 * érezhetően gyorsítja a kijelölő ugrását. */
const OVERSCAN = 3;
/** TV-n/főoldalon pontosan ennyi csatornasor látszódjon egyszerre.
 * 9 sor: így a lista alja (és az alsó vonal) is látszik a képernyőn. */
const VISIBLE_ROWS = 9;

const ChannelListView: React.FC<ChannelListProps> = ({
  channels,
  activeProvider,
  epgReady,
  epgRevision,
  selectedChannelId,
  onSelectChannel,
  onToggleFavorite,
  onDeleteChannel,
  onMoveChannel,
  folders,
  selectedCategoryId,
  isOnlyFavorites,
  selectedFavoriteFolderId,
  onSelectFavoriteFolder,
  onDisplayOrderChange,
  onAssignToFolder,
  isActive = true,
}) => {
  // Sorszám szerinti rendezés és a Vissza gomb csak megnyitott kedvenc mappában működik.
  const [sortMode, setSortMode] = useState<'saved' | 'number' | 'back'>(() => {
    if (!selectedFavoriteFolderId) return 'saved';
    try {
      const saved = window.sessionStorage.getItem(`iptv-channel-list-sort:${selectedFavoriteFolderId}`);
      return saved === 'number' || saved === 'back' ? saved : 'saved';
    } catch {
      return 'saved';
    }
  });
  const [movingChannelId, setMovingChannelId] = useState<string | null>(null);
  // KÉK gomb: távirányítós mozgatás mód. A sárga kurzor a piros fel nyílon
  // indul, jobbra/balra nyíllal lép a le nyílra, majd a kukára; OK végrehajt.
  const [moveCursor, setMoveCursor] = useState<'up' | 'down' | 'trash'>('up');
  // SÁRGA gomb: kedvenc mappa választó felugró a kijelölt csatornához.
  const [favoritePickChannelId, setFavoritePickChannelId] = useState<string | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const suppressNextClick = useRef(false);
  const [epgClock, setEpgClock] = useState(() => Date.now());
  const [localEpg, setLocalEpg] = useState<Record<string, EpgNowNext>>({});
  /*
   * EPG-ÚJRAPRÓBÁLKOZÁS.
   *
   * Korábban egyetlen sikertelen kérés (megszakított kapcsolat, időtúllépés,
   * éppen nyitott megszakító) UTÁN az adott csatorna EPG-je örökre üres
   * maradt: a hiba csendben elnyelődött, és csak a lista újrarajzolása
   * indított volna új kérést. Most csatornánként számoljuk a kísérleteket, és
   * a 30 másodperces kör legfeljebb háromszor próbálja újra – utána a
   * hibának a naplóban látszania kell, nem a felületen.
   */
  const epgAttemptsRef = useRef<Map<string, { count: number; at: number }>>(new Map());
  /**
   * A szolgáltató rövid EPG végpontja üres választ ad (19 bájt = `{"epg_listings":[]}`).
   * Ilyenkor nem küldünk további kéréseket: a műsort a teljes műsorújság adja.
   */
  const shortEpgEmptyRef = useRef(0);
  const shortEpgUnavailableRef = useRef(false);
  const shortEpgProviderRef = useRef('');
  const [epgRetryTick, setEpgRetryTick] = useState(0);

  /*
   * TELJES KÉPERNYŐ ALATT AZ EPG-MUNKA SZÜNETEL, ÉS CSAK A LEJÁTSZÓ
   * HELYREÁLLÁSA UTÁN INDUL ÚJRA.
   *
   * A VideoPlayer a belépéskor `iptv-fullscreen-entered`, a főoldali
   * geometria helyreállása után (a kifestett képkockában) pedig
   * `iptv-player-restored` eseményt küld. Így a visszatérés első
   * képkockáján nem indul EPG-letöltés/háttérszámítás – az csak ezután kap
   * munkát. A teljes képernyő alatt pedig semmi nem fogyaszt CPU-t a
   * nézésből.
   */
  const [epgPaused, setEpgPaused] = useState(false);
  useEffect(() => {
    const onEnter = () => setEpgPaused(true);
    const onRestore = () => setEpgPaused(false);
    window.addEventListener('iptv-fullscreen-entered', onEnter);
    window.addEventListener('iptv-player-restored', onRestore);
    return () => {
      window.removeEventListener('iptv-fullscreen-entered', onEnter);
      window.removeEventListener('iptv-player-restored', onRestore);
    };
  }, []);
  const epgActive = isActive && !epgPaused;

  // A lista sárga EPG-sávja az OSD-vel azonos ütemben frissül.
  // Az időbélyegek alapján számoljuk újra a kitöltést, nem a csatornaváltáshoz kötjük.
  useEffect(() => {
    if (!epgActive) return;
    setEpgClock(Date.now());
    const timer = window.setInterval(() => setEpgClock(Date.now()), 10000);
    return () => window.clearInterval(timer);
  }, [epgActive]);

  useEffect(() => {
    if (!selectedFavoriteFolderId) {
      setSortMode('saved');
      setMovingChannelId(null);
    }
  }, [selectedFavoriteFolderId]);

  // Csak a már kiválasztott ország/mappa csatornáit rendezzük. A rendezett
  // tömböt memoizáljuk, hogy az EPG-frissítések ne rendezzék újra minden
  // újrarajzoláskor a teljes listát.
  const sortedChannels = useMemo(
    () => selectedFavoriteFolderId && sortMode === 'number'
      ? [...channels].sort((a, b) => (Number(a.num) || 0) - (Number(b.num) || 0)
          || (Number(a.orderIndex) || 0) - (Number(b.orderIndex) || 0)
          || a.name.localeCompare(b.name)
          || a.id.localeCompare(b.id))
      : channels,
    [channels, sortMode, selectedFavoriteFolderId],
  );

  const visibleChannels = sortedChannels;

  // A referenciához hasonlóan a távirányítós léptetés index alapján működik:
  // ne keressük végig a teljes (akár több tízezres) listát minden nyílgombnál.
  const channelIndexById = useMemo(() => {
    const index = new Map<string, number>();
    visibleChannels.forEach((channel, i) => index.set(channel.id, i));
    return index;
  }, [visibleChannels]);

  // A fő OSD ugyanazt a megjelenítési sorszámot használja, mint a lista –
  // a kedvenc mappák sorszám szerinti rendezésénél is.
  useEffect(() => {
    onDisplayOrderChange?.(visibleChannels.map((channel) => channel.id));
  }, [visibleChannels, onDisplayOrderChange]);

  /* ------------------------------------------------------- ablakosítás */

  const channelScrollRef = useRef<HTMLDivElement | null>(null);
  const [windowRange, setWindowRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const rangeRef = useRef(windowRange);

  // PONTOSAN 9 sor férjen el: a sormagasságot a lista tényleges
  // magasságából számoljuk, így az írás is megnő, és minden sor alja
  // (keret + műsorhaladás-csík) teljesen látszik.
  const [rowPitch, setRowPitch] = useState<number>(ROW_PITCH);
  const rowHeight = Math.max(40, rowPitch - ROW_GAP);
  // BÖNGÉSZŐ-KIJELÖLÉS: a fel/le nyíl CSAK a sárga kijelölést mozgatja,
  // csatornát NEM vált. Váltás kizárólag OK/Enter gombbal történik.
  const [highlightedId, setHighlightedId] = useState<string>(selectedChannelId);
  useEffect(() => {
    // Ha a lejátszott csatorna máshonnan változik (CH+/-, OSD), a kijelölés követi.
    setHighlightedId(selectedChannelId);
  }, [selectedChannelId]);

  // Kategória- vagy kedvencmappa-váltáskor a korábbi nézetből származó
  // highlightedId rövid ideig még érvénytelen lehet. Ilyenkor nem szabad a
  // régi indexet a lista végének tekinteni, mert a következő LE a mappasávra
  // ugrana. A kijelölést mindig az új lista egy valódi sorára rögzítjük.
  useEffect(() => {
    if (!visibleChannels.length || channelIndexById.has(highlightedId)) return;
    const fallbackId = channelIndexById.has(selectedChannelId)
      ? selectedChannelId
      : visibleChannels[0].id;
    setHighlightedId(fallbackId);
  }, [visibleChannels, channelIndexById, highlightedId, selectedChannelId]);

  const measureRows = React.useCallback(() => {
    const element = channelScrollRef.current;
    if (!element) return;
    // A sormagasság a KÉPERNYŐN ténylegesen látszó helyhez igazodik: ha a
    // doboz a régi webOS hibás flex-számítása miatt a képernyőn túlra nyúlna,
    // akkor is pontosan 9 sor férjen el a látható részben (az alsó sor alja
    // korábban emiatt lógott le).
    let available = element.clientHeight;
    try {
      const rect = element.getBoundingClientRect();
      const viewportH = window.innerHeight || document.documentElement.clientHeight || rect.height;
      const visible = viewportH - rect.top - 8;
      if (visible > 0 && visible < available) available = visible;
    } catch { /* mérés nélkül a clientHeight marad */ }
    const usable = available - LIST_PADDING * 2;
    if (usable >= VISIBLE_ROWS * 44) {
      const pitch = usable / VISIBLE_ROWS;
      setRowPitch((previous) => (Math.abs(previous - pitch) > 0.5 ? pitch : previous));
    }
  }, []);

  const computeWindow = React.useCallback(() => {
    const element = channelScrollRef.current;
    const total = visibleChannels.length;
    if (!element) {
      // A lista még nem kapott méretet (pl. teljes képernyőről visszatérve):
      // az első képernyőre való sorokat rajzoljuk ki.
      const end = Math.min(total, 20);
      if (rangeRef.current.start !== 0 || rangeRef.current.end !== end) {
        rangeRef.current = { start: 0, end };
        setWindowRange({ start: 0, end });
      }
      return;
    }
    const first = Math.floor(Math.max(0, element.scrollTop - LIST_PADDING) / rowPitch);
    const visibleRows = Math.ceil(element.clientHeight / rowPitch) + 1;
    const start = Math.max(0, first - OVERSCAN);
    const end = Math.min(total, first + visibleRows + OVERSCAN);
    if (rangeRef.current.start !== start || rangeRef.current.end !== end) {
      rangeRef.current = { start, end };
      setWindowRange({ start, end });
    }
  }, [visibleChannels.length, rowPitch]);

  // Görgetés közben csak akkor rajzolunk újra, ha ténylegesen új sorok
  // kerülnek a látható sávba – így a görgetés nem indít folyamatos munkát.
  useEffect(() => {
    const element = channelScrollRef.current;
    if (!element) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measureRows();
        computeWindow();
      });
    };
    measureRows();
    // Régi webOS-en nincs ResizeObserver: az elrendezés beállta után még
    // kétszer újramérünk, hogy a 9 sor biztosan a látható részhez igazodjon.
    const lateMeasure1 = window.setTimeout(() => { measureRows(); computeWindow(); }, 500);
    const lateMeasure2 = window.setTimeout(() => { measureRows(); computeWindow(); }, 2000);
    element.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null;
    observer?.observe(element);
    window.addEventListener('resize', onScroll);
    return () => {
      element.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(lateMeasure1);
      window.clearTimeout(lateMeasure2);
    };
  }, [computeWindow, measureRows]);

  // A kategória-/mappaváltás vagy a lista hosszának változása után azonnal
  // újraszámoljuk az ablakot (a görgetési pozíció visszaállítása után is).
  useEffect(() => {
    computeWindow();
  }, [computeWindow, visibleChannels]);

  const windowStart = Math.min(windowRange.start, Math.max(0, visibleChannels.length - 1));
  const windowEnd = Math.min(visibleChannels.length, Math.max(windowRange.end, windowStart + 1));

  const renderedChannels = useMemo(
    () => visibleChannels.slice(windowStart, windowEnd).map((channel, offset) => ({ channel, index: windowStart + offset })),
    [visibleChannels, windowStart, windowEnd],
  );

  const totalHeight = visibleChannels.length * rowPitch + LIST_PADDING * 2;

  /* ------------------------------------------------------------ EPG */

  const epgQueue = useMemo(() => {
    const out: Channel[] = [];
    const seen = new Set<string>();
    const push = (channel?: Channel) => {
      if (!channel || seen.has(channel.id) || !streamIdFor(channel)) return;
      seen.add(channel.id);
      out.push(channel);
    };
    // A nézett csatorna mindig kap műsort, akkor is, ha éppen kigörgették.
    push(visibleChannels.find((channel) => channel.id === selectedChannelId));
    // Csak a látható sáv (ablak) csatornáira kérünk műsort. Korábban a teljes
    // kiválasztott lista (akár 20 000 csatorna) bekerült a sorba, ami a
    // szolgáltatót és a telefont is használhatatlanná tette.
    for (const entry of renderedChannels) push(entry.channel);
    return out;
  }, [visibleChannels, renderedChannels, selectedChannelId]);

  // A referencia ChannelRow megoldását követve a látható sorok maguk is
  // gondoskodnak az EPG-ről. Így a lista nem függ attól, hogy az App előtöltése
  // éppen lefutott-e, és a műsor koppintás nélkül is megjelenik.
  useEffect(() => {
    /*
     * A teljes képernyő csak SZÜNETELTETI az EPG-munkát: a már kiszámolt
     * műsoradatot NEM dobjuk el, különben a visszatéréskor egy pillanatra
     * üres EPG-sorok látszanának (ez volt a látható „újrarajzolás”).
     * A tárolt adatot csak akkor töröljük, ha a lista tényleg más nézetbe
     * kerül (nem élő TV) vagy nincs szolgáltató.
     */
    if (!isActive || !activeProvider || activeProvider.type !== 'xtream') {
      setLocalEpg({});
      return;
    }
    // Új szolgáltatónál újra kiderül, hogy van-e rövid EPG.
    if (shortEpgProviderRef.current !== activeProvider.id) {
      shortEpgProviderRef.current = activeProvider.id;
      shortEpgEmptyRef.current = 0;
      shortEpgUnavailableRef.current = false;
    }
    if (!epgActive || !epgReady) return;
    let cancelled = false;
    let cursor = 0;
    // A nézett és a képernyőn látható csatornák EPG-je azonnal induljon,
    // párhuzamosan a videó betöltésével. Csak a látható ablakot kérjük le,
    // így a korai EPG nem terheli túl a TV-t és nem járja be a teljes listát.
    let queue: typeof epgQueue = [];

    const updateFromCache = () => {
      setLocalEpg((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const channel of epgQueue) {
          // Előbb a teljes műsorújság (XMLTV), utána a rövid EPG gyorsítótár.
          const epg = channelNowNext(activeProvider, channel) || (() => {
            const streamId = streamIdFor(channel);
            if (!streamId) return null;
            const entries = getCachedShortEpg(activeProvider, streamId, 6);
            return entries.length ? nowNextFromEpg(entries, Date.now()) : null;
          })();
          if (!epg || (!epg.now && !epg.next)) continue;
          const old = previous[channel.id];
          if (epg.now?.title !== old?.now?.title ||
              epg.now?.time !== old?.now?.time ||
              epg.now?.startTimestamp !== old?.now?.startTimestamp ||
              epg.now?.endTimestamp !== old?.now?.endTimestamp ||
              epg.next?.title !== old?.next?.title ||
              epg.next?.time !== old?.next?.time) {
            next[channel.id] = epg;
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    };

    // A háttérben betöltött műsorokat NEM soronként írjuk ki az állapotba:
    // 400 ms-onként egyetlen frissítés viszi ki az összegyűlt adagokat.
    const pending = new Map<string, ReturnType<typeof nowNextFromEpg>>();
    let flushTimer: number | null = null;
    const flush = () => {
      flushTimer = null;
      if (cancelled || pending.size === 0) return;
      const batch = new Map(pending);
      pending.clear();
      setLocalEpg((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const [channelId, epg] of batch) {
          const old = previous[channelId];
          if (old?.now?.title === epg.now?.title && old?.now?.time === epg.now?.time
              && old?.next?.title === epg.next?.title && old?.next?.time === epg.next?.time) {
            continue;
          }
          next[channelId] = epg;
          changed = true;
        }
        return changed ? next : previous;
      });
    };
    const queueEpg = (channelId: string, epg: ReturnType<typeof nowNextFromEpg>) => {
      pending.set(channelId, epg);
      if (flushTimer === null) flushTimer = window.setTimeout(flush, 400);
    };
    const worker = async () => {
      while (!cancelled) {
        const channel = queue[cursor++];
        if (!channel) return;
        const streamId = streamIdFor(channel);
        if (!streamId) continue;
        // Ha a teljes műsorújságból már megvan a műsor, nincs hálózati kérés.
        const fromGuide = channelNowNext(activeProvider, channel);
        if (fromGuide && (fromGuide.now || fromGuide.next)) {
          queueEpg(channel.id, fromGuide);
          continue;
        }
        /*
         * ÜRES PANEL – NE KÉRDEZZÜK TOVÁBB.
         *
         * A 19-es TV-napló (16:27:15) szerint ezen a szolgáltatón a
         * `get_short_epg` MINDEN kérésre 19 bájtos, üres választ ad
         * ({"epg_listings":[]}) – 18 kérés ment ki induláskor, mind hiába.
         * Ha három egymás utáni csatornára is üres a válasz, a munkás
         * leáll: a maradékot a teljes műsorújság (XMLTV) adja.
         */
        if (shortEpgUnavailableRef.current) continue;
        try {
          const entries = await loadShortEpg(activeProvider, streamId, 6);
          const attempts = epgAttemptsRef.current.get(channel.id);
          if (attempts) epgAttemptsRef.current.delete(channel.id);
          if (!cancelled && entries.length) {
            shortEpgEmptyRef.current = 0;
            queueEpg(channel.id, nowNextFromEpg(entries, Date.now()));
          } else if (!cancelled) {
            shortEpgEmptyRef.current += 1;
            if (shortEpgEmptyRef.current >= 3 && !shortEpgUnavailableRef.current) {
              shortEpgUnavailableRef.current = true;
              appLog('EPG: a szolgáltató rövid EPG végpontja üres választ ad – a további kérések elmaradnak, a műsort a teljes műsorújságból töltjük.');
            }
          }
        } catch (error) {
          /*
           * Egy csatorna EPG-hibája ne akadályozza a többi sor betöltését –
           * de NEM is tűnhet el nyomtalanul: a naplóban látszania kell, mert
           * eddig pont ezért nem lehetett megmondani, miért nem töltődik be
           * az EPG a TV-n.
           */
          const previous = epgAttemptsRef.current.get(channel.id);
          const count = (previous?.count || 0) + 1;
          epgAttemptsRef.current.set(channel.id, { count, at: Date.now() });
          if (count === 1) {
            appLogError(`EPG (${channel.name}, stream ${streamId})`, error);
          }
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
      }
    };
    // Rövid, 80 ms-os összevonás: az EPG a videóval párhuzamosan indul,
    // de a gyors fókuszmozgatáskor érkező apró változásokat összevonjuk.
    const startTimer = window.setTimeout(() => {
      if (cancelled) return;
      queue = epgQueue.filter((channel) => {
        const fromGuide = channelNowNext(activeProvider, channel);
        if (fromGuide && (fromGuide.now || fromGuide.next)) return false;
        const streamId = streamIdFor(channel);
        return !!streamId && getCachedShortEpg(activeProvider, streamId, 6).length === 0;
      });
      updateFromCache();
      void Promise.all([worker(), worker(), worker(), worker()]);
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      if (flushTimer !== null) window.clearTimeout(flushTimer);
    };
  }, [isActive, epgActive, epgReady, epgRevision, epgRetryTick, activeProvider?.id, activeProvider?.serverUrl, activeProvider?.username, activeProvider?.password, epgQueue]);

  // A gyorsítótárból 30 másodpercenként újraszámoljuk az éppen futó műsort,
  // ezért a cím és a sárga haladási sáv magától frissül.
  useEffect(() => {
    if (!epgActive || !activeProvider || activeProvider.type !== 'xtream') return;
    setLocalEpg((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const channel of epgQueue) {
        const epg = channelNowNext(activeProvider, channel, epgClock) || (() => {
          const streamId = streamIdFor(channel);
          if (!streamId) return null;
          const entries = getCachedShortEpg(activeProvider, streamId, 6);
          return entries.length ? nowNextFromEpg(entries, epgClock) : null;
        })();
        if (!epg || (!epg.now && !epg.next)) continue;
        const old = previous[channel.id];
        if (epg.now?.title !== old?.now?.title ||
            epg.now?.time !== old?.now?.time ||
            epg.now?.startTimestamp !== old?.now?.startTimestamp ||
            epg.now?.endTimestamp !== old?.now?.endTimestamp ||
            epg.next?.title !== old?.next?.title ||
            epg.next?.time !== old?.next?.time) {
          next[channel.id] = epg;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
    /*
     * ÚJRAPRÓBÁLKOZÁS: ha egy látható csatornának még most sincs EPG-je, és a
     * korábbi kísérlet legalább 60 másodperce volt (legfeljebb háromszor),
     * indítsunk új kérést. Így egy átmeneti hiba nem hagyja örökre üresen a
     * sort, de egy EPG-t nem adó szolgáltatót sem terhelünk folyamatosan.
     */
    const nowMs = Date.now();
    let retry = false;
    for (const channel of epgQueue) {
      const streamId = streamIdFor(channel);
      if (!streamId) continue;
      if (getCachedShortEpg(activeProvider, streamId, 6).length > 0) continue;
      const attempt = epgAttemptsRef.current.get(channel.id);
      if (!attempt || attempt.count >= 3) continue;
      if (nowMs - attempt.at < 60000) continue;
      retry = true;
      break;
    }
    if (retry) setEpgRetryTick((tick) => tick + 1);
  }, [epgActive, epgClock, epgRevision, activeProvider?.id, activeProvider?.serverUrl, activeProvider?.username, activeProvider?.password, epgQueue]);

  // A teljes képernyőre lépéskor a lista lekerül a képernyőről, ezért
  // a görgetési helyzetet külön, nézetenként mentjük és visszaállítjuk.
  // A kulcs külön kezeli az országlistákat, az összes kedvencet és minden kedvenc mappát.
  const scrollPositionKey = `iptv-channel-list-scroll:${selectedFavoriteFolderId || (isOnlyFavorites ? 'favorites' : selectedCategoryId)}`;

  useEffect(() => {
    if (!selectedFavoriteFolderId) return;
    try {
      window.sessionStorage.setItem(`iptv-channel-list-sort:${selectedFavoriteFolderId}`, sortMode);
    } catch {
      // A tároló hiánya nem akadályozza a csatornalista használatát.
    }
  }, [selectedFavoriteFolderId, sortMode]);

  useEffect(() => {
    const element = channelScrollRef.current;
    if (!element) return;
    let restored = false;
    try {
      const saved = window.sessionStorage.getItem(scrollPositionKey);
      if (saved !== null) {
        element.scrollTop = Math.max(0, Number(saved) || 0);
        restored = true;
      }
    } catch {
      // A tároló hiánya nem akadályozza a csatornalista használatát.
    }
    // Teljes képernyőről vissza: ha nincs mentett pozíció vagy a kiválasztott
    // csatorna nincs a látható sávban, görgessünk a kiválasztott csatornához.
    if (!restored || element.scrollTop === 0) {
      const selectedIndex = visibleChannels.findIndex((ch) => ch.id === selectedChannelId);
      if (selectedIndex >= 0) {
        const targetTop = Math.max(0, selectedIndex * rowPitch - element.clientHeight / 3);
        element.scrollTop = targetTop;
        try { window.sessionStorage.setItem(scrollPositionKey, String(targetTop)); } catch {}
      }
    } else {
      // Ha van mentett pozíció, ellenőrizzük, hogy a kiválasztott csatorna
      // látható-e; ha nem, görgessünk hozzá (ne ugorjon tetejére).
      const selectedIndex = visibleChannels.findIndex((ch) => ch.id === selectedChannelId);
      if (selectedIndex >= 0) {
        const selectedTop = selectedIndex * rowPitch;
        const viewportTop = element.scrollTop;
        const viewportBottom = viewportTop + element.clientHeight;
        if (selectedTop < viewportTop || selectedTop > viewportBottom - rowPitch) {
          const targetTop = Math.max(0, selectedTop - element.clientHeight / 3);
          element.scrollTop = targetTop;
          try { window.sessionStorage.setItem(scrollPositionKey, String(targetTop)); } catch {}
        }
      }
    }
    computeWindow();
  }, [scrollPositionKey, computeWindow, visibleChannels, selectedChannelId, rowPitch]);

  // A görgetési helyzet mentése. FONTOS: nem minden egyes görgetési eseménynél
  // írunk a tárolóba (az minden képkockában egy záró szinkron írás volt),
  // hanem képkockánként legfeljebb egyszer.
  const scrollSaveFrame = useRef(0);
  const pendingScrollTop = useRef(0);
  const saveChannelScrollPosition = (element: HTMLDivElement) => {
    pendingScrollTop.current = element.scrollTop;
    if (scrollSaveFrame.current) return;
    // A tárolóírás lassú művelet a TV-n - görgetés közben NEM írunk, csak
    // 400 ms nyugalom után egyszer (a sessionStorage-írás minden
    // nyíllépésnél fékezte a kijelölő mozgását).
    scrollSaveFrame.current = window.setTimeout(() => {
      scrollSaveFrame.current = 0;
      try {
        window.sessionStorage.setItem(scrollPositionKey, String(pendingScrollTop.current));
      } catch {
        // A tároló hiánya nem akadályozza a csatornalista használatát.
      }
    }, 400);
  };
  useEffect(() => () => {
    // Teljes képernyőre lépéskor a lista lekerül, mentsük azonnal a pending pozíciót.
    if (scrollSaveFrame.current) {
      window.clearTimeout(scrollSaveFrame.current);
      scrollSaveFrame.current = 0;
      try {
        window.sessionStorage.setItem(scrollPositionKey, String(pendingScrollTop.current));
      } catch {}
    }
  }, [scrollPositionKey]);

  const clearLongPressTimer = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Billentyűzet / TV remote támogatás: nyilakkal navigálás, Enter kiválasztás
  /** TV: fókusz a felső menüsor első gombjára (Kategóriák/Mozi/Sorozat/Beállítások). */
  const focusHeaderMenu = () => {
    // FEL gombra először mindig a Beállítások (fogaskerék) gombra ugrunk –
    // onnan dönti el a néző, hogy jobbra vagy balra indul tovább.
    const btn = document.querySelector<HTMLElement>('header [data-tv-header-default]:not([disabled])')
      || document.querySelector<HTMLElement>('header button:not([disabled])');
    if (btn) {
      btn.focus({ preventScroll: true } as any);
      try { btn.scrollIntoView({ block: 'nearest' }); } catch {}
      return true;
    }
    return false;
  };

  /**
   * TV: a mappasáv (Kedvencek / Összes / mappák) az egyetlen "felső" szomszéd
   * a csatornalista fölött. A kijelölő a lista végéről/tetejéről ide lép, innen
   * felfelé pedig a fejléc (Beállítások) következik.
   *
   * A SÁV SOHA nem kap fókuszt: csak a mappák gombjai. Ha a sáv maga lenne
   * fókuszolható, a távirányító kijelölné a teljes dobozt – pont az a
   * hiba, ami miatt a "csatornalista kijelölése" funkciót el kellett
   * törölni. Ha nincs egyetlen mappa sem, a fejléc menüje következik.
   */
  const focusFolderBar = () => {
    const bar = document.querySelector<HTMLElement>('[data-tv-folders]');
    const target = bar?.querySelector<HTMLElement>('[data-tv-folder]');
    if (target) {
      target.focus({ preventScroll: true } as any);
      try { target.scrollIntoView({ block: 'nearest', behavior: 'auto' as any }); } catch {}
      return true;
    }
    return focusHeaderMenu();
  };

  /**
   * A fókusz mindig egy CSATORNASORRA kerül, soha a lista dobozára.
   *
   * A lista konténere (role="listbox") nem fókuszolható: nincs tabindexe,
   * és semmi nem hívja meg a .focus() metódusát. Így a távirányító
   * bármilyen úton érkezik is a listához, mindig egy konkrét csatorna lesz
   * kijelölve – a teljes doboz soha.
   */
  const focusChannelRow = (channelId: string): boolean => {
    if (!channelId) return false;
    const list = channelScrollRef.current;
    // Több nézet marad a DOM-ban azonnali váltáshoz. A fókuszt kizárólag a
    // látható, saját listán belül keressük, különben egy háttérben maradt
    // lista ugyanazt a távirányító-gombot kaphatná meg.
    if (!list || list.closest('[data-view-hidden]') || list.style.visibility === 'hidden') return false;
    const row = list.querySelector<HTMLElement>(`[data-channel-id="${channelId}"] [role="option"]`)
      || list.querySelector<HTMLElement>(`[data-channel-id="${channelId}"]`);
    if (!row) return false;
    row.focus({ preventScroll: true } as any);
    return true;
  };

  /** A lista elejére (vagy a kijelölt csatornára) ugrás – mindig sorra. */
  const focusFirstChannelRow = (): boolean => {
    const preferred = highlightedId || selectedChannelId;
    if (preferred && focusChannelRow(preferred)) return true;
    const first = visibleChannels[0];
    if (!first) return false;
    setHighlightedId(first.id);
    return focusChannelRow(first.id);
  };

  // TV távirányító színes gombjai (webos.js-ből): KÉK = mozgatás mód a
  // kijelölt csatornán, SÁRGA = hozzáadás kedvenc mappához felugró.
  useEffect(() => {
    const onTvAction = (e: Event) => {
      const action = (e as CustomEvent)?.detail?.action;
      if (action !== 'move' && action !== 'favorite') return;
      // Nyitott felugró ablak alatt a színes gomb ne piszkálja a listát.
      if (document.querySelector('[role="dialog"]')) return;
      const targetId = highlightedId || selectedChannelId;
      if (!targetId) return;
      if (action === 'move') {
        setFavoritePickChannelId(null);
        setMovingChannelId((previous) => (previous ? null : targetId));
        setMoveCursor('up');
        // A mozgatás módban is a SORRA kerül a fókusz (a gombesemények
        //buborékolnak a listához, így a nyilak így is működnek) – a doboz
        //soha nem jelölhető ki.
        if (!focusChannelRow(targetId)) focusFirstChannelRow();
      } else {
        setMovingChannelId(null);
        setFavoritePickChannelId(targetId);
      }
    };
    window.addEventListener('iptv-tv-action', onTvAction);
    return () => window.removeEventListener('iptv-tv-action', onTvAction);
  }, [highlightedId, selectedChannelId]);

  // A kedvenc mappa felugró első gombja azonnal fókuszt kap (távirányító).
  useEffect(() => {
    if (!favoritePickChannelId) return;
    const timer = window.setTimeout(() => {
      const btn = document.querySelector<HTMLElement>('[data-favorite-pick] button');
      btn?.focus({ preventScroll: true } as any);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [favoritePickChannelId]);

  /** Mozgatás után a sor maradjon látható (a kijelölés a csatornával megy). */
  const keepMovingRowVisible = (channelId: string) => {
    window.requestAnimationFrame(() => {
      const el = document.querySelector(`[data-channel-id="${channelId}"]`) as HTMLElement | null;
      if (!el) return;
      const legacy = el as HTMLElement & { scrollIntoViewIfNeeded?: (center?: boolean) => void };
      if (typeof legacy.scrollIntoViewIfNeeded === 'function') legacy.scrollIntoViewIfNeeded(false);
      else if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    });
  };

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    /*
     * REJTETT LISTA: ne nyelje el a gombokat.
     *
     * A csatornalista teljes képernyőn és film lejátszásakor is a DOM-ban
     * marad (csak rejtve), hogy a visszatérés azonnali legyen. Ha a fókusz
     * véletlenül egy rejtett soron marad, a nyilak itt mozgatnák a láthatatlan
     * kijelölést – a csatorna pedig nem váltana. Ezért rejtett állapotban a
     * lista egyetlen gombot sem dolgoz fel (a teljes képernyős lejátszó veszi át).
     */
    const host = e.currentTarget as HTMLElement | null;
    if (!isActive || (host && (host.closest('[data-view-hidden]') || host.style.visibility === 'hidden'))) return;
    // LG webOS: régi kulcsnév ('Up'/'Down') vagy csak keyCode is érkezhet.
    const key = normalizeTvKey(e);
    // KÉK teletextgomb: megnyitott kedvenc mappában a kijelölt csatornát
    // közvetlenül mozgatási módba teszi. A fő csatornalista működése változatlan.
    if (key === 'ColorF3Blue' && selectedFavoriteFolderId) {
      const targetId = highlightedId || selectedChannelId;
      if (targetId && visibleChannels.some((channel) => channel.id === targetId)) {
        e.preventDefault();
        e.stopPropagation();
        setMovingChannelId(targetId);
        setMoveCursor('up');
        focusChannelRow(targetId);
      }
      return;
    }
    // MOZGATÁS MÓD (KÉK gomb): a sárga kurzor a piros nyilak/kuka között jár,
    // az OK végrehajtja a kijelölt műveletet, a Vissza kilép a módból.
    if (movingChannelId) {
      const movingIndex = visibleChannels.findIndex((c) => c.id === movingChannelId);
      e.preventDefault();
      e.stopPropagation();
      if (key === 'ArrowRight') {
        setMoveCursor((c) => (c === 'up' ? 'down' : 'trash'));
      } else if (key === 'ArrowLeft') {
        setMoveCursor((c) => (c === 'trash' ? 'down' : 'up'));
      } else if (key === 'ArrowUp') {
        if (movingIndex > 0) {
          onMoveChannel?.(movingChannelId, 'up');
          keepMovingRowVisible(movingChannelId);
        }
      } else if (key === 'ArrowDown') {
        if (movingIndex >= 0 && movingIndex < visibleChannels.length - 1) {
          onMoveChannel?.(movingChannelId, 'down');
          keepMovingRowVisible(movingChannelId);
        }
      } else if (key === 'Enter' || key === ' ') {
        if (moveCursor === 'up') {
          if (movingIndex > 0) {
            onMoveChannel?.(movingChannelId, 'up');
            keepMovingRowVisible(movingChannelId);
          }
        } else if (moveCursor === 'down') {
          if (movingIndex >= 0 && movingIndex < visibleChannels.length - 1) {
            onMoveChannel?.(movingChannelId, 'down');
            keepMovingRowVisible(movingChannelId);
          }
        } else {
          onDeleteChannel(movingChannelId);
          setMovingChannelId(null);
        }
      } else if (key === 'Escape' || key === 'Backspace') {
        setMovingChannelId(null);
      }
      return;
    }
    if (key === 'ArrowLeft') {
      // A referenciához hasonlóan balra visszalépünk a kategória/mappa választóhoz.
      // A lejátszó és a csatornalista külső kerete nem kap külön kijelölést.
      e.preventDefault();
      e.stopPropagation();
      focusFolderBar();
      return;
    }
    if (visibleChannels.length === 0) {
      // ÜRES lista (még töltődik vagy nincs lejátszási lista): ne legyen
      // zsákutca a TV-n – bármely nyíllal a felső menüsorra ugrunk, hogy a
      // távirányítóval el lehessen érni a Beállításokat/Mozit/Sorozatot.
      if (isTvArrowKey(key)) {
        e.preventDefault();
        e.stopPropagation();
        if (!focusFolderBar()) focusHeaderMenu();
      }
      return;
    }
    // A fel/le nyíl CSAK a sárga kijelölést mozgatja (felsorolás),
    // csatornát nem vált - váltani az OK/Enter gombbal lehet.
    // Map-keresés O(1): nem fut végig a teljes csatornalistán minden gombnyomáskor.
    // Először a ténylegesen fókuszált sort vesszük alapul. Ez megakadályozza,
    // hogy egy rAF/virtualizáció közben még régi highlightedId a lista végét
    // jelentse, és a LE tévesen a kedvencek mappasávjára vigyen.
    const activeElement = document.activeElement as HTMLElement | null;
    const focusedChannelId = activeElement?.closest?.('[data-channel-id]')?.getAttribute('data-channel-id') || '';
    const focusedIndex = focusedChannelId ? channelIndexById.get(focusedChannelId) : undefined;
    const highlightedIndex = channelIndexById.get(highlightedId);
    const selectedIndex = channelIndexById.get(selectedChannelId);
    const currentIndex = focusedIndex ?? highlightedIndex ?? selectedIndex ?? -1;
    const currentId = currentIndex >= 0 ? visibleChannels[currentIndex]?.id : undefined;
    const hasRealCurrentRow = Boolean(currentId && (
      currentId === focusedChannelId || currentId === highlightedId || currentId === selectedChannelId
    ));
    const moveHighlight = (target: number) => {
      const next = visibleChannels[target];
      if (!next) return;
      setHighlightedId(next.id);
      const list = channelScrollRef.current;
      if (list) {
        const rowTop = LIST_PADDING + target * rowPitch;
        const rowBottom = rowTop + rowHeight;
        if (rowTop < list.scrollTop) list.scrollTop = Math.max(0, rowTop - LIST_PADDING);
        else if (rowBottom > list.scrollTop + list.clientHeight) list.scrollTop = rowBottom - list.clientHeight + LIST_PADDING;
        // Az ablakot azonnal szinkronizáljuk, így a cél-sor már a következő
        // rajzoláskor a DOM-ban van; nem várunk a scroll eseményre.
        computeWindow();
      }
      const focusRenderedTarget = (attempt: number) => {
        // A virtualizált ablak React-rerenderje egy rAF-tal később is
        // érkezhet. Ilyenkor újrapróbáljuk ugyanazt a valódi sort, ahelyett
        // hogy a fókusz a háttérbe esne és a következő LE határátmenetnek
        // látná a listát.
        if (focusChannelRow(next.id) || attempt >= 2) return;
        requestAnimationFrame(() => focusRenderedTarget(attempt + 1));
      };
      requestAnimationFrame(() => {
        // A fókusz a SORRA kerül, nem a lista dobozára: a doboz soha nem
        // lehet kijelölve (lásd a fókuszmodell leírását fent).
        focusRenderedTarget(0);
      });
    };
    if (key === 'ArrowUp' && hasRealCurrentRow && currentIndex === 0) {
      // A lista tetejéről felfelé: a mappasávra lépünk (onnan tovább a fejléc).
      e.preventDefault();
      e.stopPropagation();
      if (!focusFolderBar()) focusHeaderMenu();
    } else if (key === 'ArrowDown' && hasRealCurrentRow && currentIndex === visibleChannels.length - 1) {
      // A lista ALJÁN lefelé: át a kedvencek mappasávjára. Ez a határátmenet
      // csak érvényes, valódi sorindexnél engedélyezett; stale/virtualizált
      // állapotnál előbb a következő valódi csatornasorra rögzítünk.
      e.preventDefault();
      e.stopPropagation();
      focusFolderBar();
    } else if (key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      moveHighlight(Math.min(visibleChannels.length - 1, (currentIndex < 0 ? 0 : currentIndex + 1)));
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      moveHighlight(Math.max(0, (currentIndex < 0 ? 0 : currentIndex - 1)));
    } else if (key === 'Enter' || key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      const current = visibleChannels[currentIndex >= 0 ? currentIndex : 0];
      if (current) {
        // TV: az ELSŐ OK a főoldali (kis) lejátszóban indítja a csatornát.
        // A teljes képernyő csak a MÁSODIK OK-ra vált - így a néző a főoldalon
        // tud maradni, és csak ha akar, lép be a teljes képernyős nézetbe.
        if (current.id === selectedChannelId) {
          // A mérés az OK lenyomásától indul (2.5.166).
          fsStart('BE', `csatornalista OK – ${current.name}`);
          window.dispatchEvent(new CustomEvent('iptv-enter-fullscreen'));
        } else {
          setHighlightedId(current.id);
          onSelectChannel(current);
        }
      }
    }
  };

  /**
   * Teljes képernyőről visszatérve a kiválasztott csatorna sora kapja a sárga
   * kijelölést ÉS a fókuszt (a kék kiválasztás már ott van). Így a néző nem
   * a lista tetején, és nem a lejátszó dobozon folytatja.
   */
  useEffect(() => {
    const restore = () => {
      const id = selectedChannelId;
      if (!id) return;
      setHighlightedId(id);
      const row = document.querySelector<HTMLElement>(`[data-channel-id="${id}"] [role="option"]`)
        || document.querySelector<HTMLElement>(`[data-channel-id="${id}"]`);
      if (!row) return;
      // Csak akkor görgetünk, ha a sor nincs a látható területen, elkerülve a felesleges elrendezés-újraszámolást.
      const list = channelScrollRef.current;
      if (list) {
        const rect = row.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        if (rect.top < listRect.top || rect.bottom > listRect.bottom) {
          try {
            const legacy = row as HTMLElement & { scrollIntoViewIfNeeded?: (center?: boolean) => void };
            if (typeof legacy.scrollIntoViewIfNeeded === 'function') legacy.scrollIntoViewIfNeeded(false);
            else row.scrollIntoView({ block: 'nearest', behavior: 'auto' as any });
          } catch { /* régi motor */ }
        }
      }
      row.focus({ preventScroll: true } as any);
    };
    const onRestore = () => {
      window.requestAnimationFrame(restore);
    };
    window.addEventListener('iptv-focus-selected-channel', onRestore);
    return () => window.removeEventListener('iptv-focus-selected-channel', onRestore);
  }, [selectedChannelId]);

  // TV / stick / egér: automatikus fókusz a listára, hogy a D-pad működjön
  useEffect(() => {
    const focusList = () => {
      try {
        const el = channelScrollRef.current;
        if (!el) return;
        // FÓKUSZRABLÁS TILTVA: csak akkor fókuszálunk, ha jelenleg SEMMINEK
        // nincs fókusza. Korábban a menüben/gombon álló nézőtől is
        // visszarántotta a fókuszt a listára ("magától visszaugrik" hiba).
        const active = document.activeElement as HTMLElement | null;
        if (active && active !== document.body && active !== document.documentElement) return;
        // A fókusz a SORRA kerül, nem a lista dobozára.
        if (!focusFirstChannelRow()) {
          // Nincs (még) csatorna: a mappasáv következik, az is egy gomb.
          if (!focusFolderBar()) focusHeaderMenu();
        }
        // Ha van kiválasztott csatorna, görgess oda
        if (selectedChannelId) {
          const sel = document.querySelector(`[data-channel-id="${selectedChannelId}"]`) as HTMLElement;
          sel?.scrollIntoView({ block: 'nearest' });
        }
      } catch {}
    };
    // Többszöri próbálkozás, mert a lista később töltődik
    const t1 = window.setTimeout(focusList, 300);
    const t2 = window.setTimeout(focusList, 1000);
    const t3 = window.setTimeout(focusList, 2500);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [visibleChannels.length, selectedChannelId]);

  return (
    <div data-live-sidebar="" className="flex-1 min-h-0 h-full flex flex-col bg-[#070e1e] overflow-hidden md:bg-[#070e1e] lg:bg-[#070e1e] xl:bg-[#070e1e] 2xl:bg-[#070e1e]">
      {/* Az „Összes” után közvetlenül a létrehozott kedvenc mappák jelennek meg; nincs csatornakategória vagy külön mappanyitó. */}
      <div
        data-tv-folders=""
        /* A mappasáv DOBOZA sem fókuszolható (mint a csatornalista doboza):
           a kijelölő mindig egy konkrét mappára vagy csatornasorra kerül.
           A billentyűkezelő megmarad arra az esetre, ha a fókusz a sávon
           belüli gombon áll (az esemény felbuborékol ide). */
        onKeyDown={(e) => {
          // TV: a mappasávon balra/jobbra a mappák között lépkedünk, felfelé a
          // fejléc (Beállítások), lefelé a csatornalista következik.
          const key = normalizeTvKey(e);
          if (!isTvArrowKey(key)) return;
          const buttons = Array.from(
            (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[data-tv-folder]')
          ).filter((el) => el.getClientRects().length > 0);
          const index = buttons.indexOf(document.activeElement as HTMLElement);
          if (key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            const next = buttons[Math.min(buttons.length - 1, (index < 0 ? -1 : index) + 1)];
            next?.focus({ preventScroll: true } as any);
          } else if (key === 'ArrowLeft') {
            e.preventDefault();
            e.stopPropagation();
            const prev = buttons[Math.max(0, (index < 0 ? buttons.length : index) - 1)];
            prev?.focus({ preventScroll: true } as any);
          } else if (key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            focusHeaderMenu();
          } else if (key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            // A kedvenc mappák alól mindig az első csatornaszámra lépünk.
            const first = visibleChannels[0];
            if (first) {
              setHighlightedId(first.id);
              const list = channelScrollRef.current;
              if (list) list.scrollTop = 0;
              // A csatornasor saját fókuszát kapja meg, ne a teljes lista
            // külső listboxa maradjon kijelölve. A sorszám-doboz nem fókuszelem.
            requestAnimationFrame(() => {
              focusChannelRow(first.id);
            });
            } else {
              // Nincs csatorna: a fejléc menüje a következő lépés. A lista
              // doboza semmiképp sem kaphat fókuszt.
              focusHeaderMenu();
            }
          }
        }}
        className="px-3 py-2.5 bg-[#070f22] border-b border-cyan-950/60 overflow-x-auto shrink-0 focus:outline-none">
        <div className="flex items-center gap-2 min-w-max">
          {selectedFavoriteFolderId && (
            <button
              type="button"
              data-tv-folder=""
              onClick={() => {
                setMovingChannelId(null);
                setSortMode('saved');
                onSelectFavoriteFolder(null);
              }}
              title="Vissza a kedvenc mappákhoz"
              aria-label="Vissza a kedvenc mappákhoz"
              className="px-4 py-2.5 rounded-2xl text-sm font-black whitespace-nowrap border-2 border-emerald-300 bg-emerald-400 text-slate-950 transition-colors"
            >↩ Vissza</button>
          )}
          {folders.map((folder, folderIndex) => {
            const folderBorder = folderIndex % 2 === 0 ? 'border-cyan-400' : 'border-amber-400';
            const isSelected = selectedFavoriteFolderId === folder.id;
            return (
              <button
                key={folder.id}
                type="button"
                data-tv-folder=""
                onClick={() => onSelectFavoriteFolder(folder.id)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-bold whitespace-nowrap border-2 transition-colors ${folderBorder} ${isSelected ? 'bg-amber-400 text-slate-950' : 'bg-[#0d1c3a] text-slate-300'}`}
              >
                <span className="text-xl leading-none" aria-hidden="true">{folder.icon || '📁'}</span>
                <span>{folder.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Channel Rows – csak a látható sáv rajzolódik ki (ablakos lista). Reszponzív + egér + billentyűzet */}
      {/* A lista doboza NEM fókuszolható: nincs tabindexe, és semmi nem
          fókuszolja. A távirányító így mindig egy konkrét csatornasorra
          lép – a "teljes csatornalista kijelölése" funkció nem létezik. */}
      <div
        ref={channelScrollRef}
        data-scroll-keep=""
        /* A KIVÁLASZTOTT csatorna azonosítója a listadobozon: a webOS kezelő
           (webos.js) ebből tudja, melyik sorra tegye a fókuszt, amikor a
           teljes képernyőről visszatérve még senkinek nincs fókusza. Enélkül
           az ELSŐ sorra lépett, és a következő OK már másik csatornára váltott. */
        data-selected-id={selectedChannelId || undefined}
        onKeyDown={handleListKeyDown}
        onScroll={(event) => saveChannelScrollPosition(event.currentTarget)}
        className="flex-1 min-h-0 overflow-y-auto focus:outline-none md:scrollbar-thin lg:scrollbar-thin xl:scrollbar-thin"
        role="listbox"
        aria-label="Csatornalista – távirányítóval vagy Magic Remote mutatóval választható"
      >
        {visibleChannels.length === 0 ? (
          /* data-boot-empty: jelzi az üres nézetet a webos.js fókusz-próbájának
             és az indulási diagnosztikának. A megjelenítés a <html> elem
             data-iptv-boot="empty" jelzője alapján dönt (lásd main.tsx). */
          <div
            data-boot-empty=""
            className="flex h-full min-h-[220px] flex-col items-center justify-center p-8 text-center text-slate-400"
          >
            {!selectedFavoriteFolderId && !isOnlyFavorites && (
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-400/25 bg-cyan-400/10 text-cyan-300">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="2" y="7" width="20" height="13" rx="2" />
                  <path d="m8 3 4 4 4-4" />
                </svg>
              </div>
            )}
            <p className="text-base font-semibold text-slate-200">
              {selectedFavoriteFolderId ? 'Ez a kedvenc mappa még üres' : isOnlyFavorites ? 'Válassz kedvenc mappát a fenti listából' : 'Nincs betöltött csatorna'}
            </p>
            {!selectedFavoriteFolderId && !isOnlyFavorites && (
              <p className="text-xs mt-2 text-slate-500 max-w-xs leading-relaxed">
                Nyisd meg a <span className="text-cyan-300 font-bold">Menü → Listák</span> fület, és add hozzá a
                szolgáltatód adatait (Xtream Codes vagy M3U). Utána megjelennek a saját csatornáid, filmjeid és
                sorozataid.
              </p>
            )}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: totalHeight }}>
            {renderedChannels.map(({ channel: ch, index }) => {
              const isSelected = ch.id === selectedChannelId;
              const isHighlighted = ch.id === highlightedId;
              // Nagyobb írás, ha a sorok magasabbak (kevesebb sor = nagyobb sormagasság).
              const bigRows = rowHeight >= 76;
              const currentEpg = localEpg[ch.id]?.now || ch.epgNow;
              const nextEpg = localEpg[ch.id]?.next || ch.epgNext;
              // A műsorhaladás egyetlen értékként (a hiányos időbélyegek kezelése itt történik).
              const epgStart = Number(currentEpg?.startTimestamp || 0);
              const epgEnd = Number(currentEpg?.endTimestamp || 0);
              const epgPercent = epgStart > 0 && epgEnd > epgStart
                ? Math.min(100, Math.max(0, ((epgClock / 1000 - epgStart) / (epgEnd - epgStart)) * 100))
                : null;
              return (
                <div
                  key={ch.id}
                  data-channel-id={ch.id}
                  className={`absolute left-0 right-0 ${index > 0 ? 'border-t border-cyan-950/30' : ''}`}
                  style={{
                    top: LIST_PADDING + index * rowPitch,
                    height: rowHeight,
                    paddingLeft: LIST_PADDING,
                    paddingRight: LIST_PADDING,
                  }}
                >
                  <div
                    role="option"
                    tabIndex={0}
                    aria-selected={isSelected}
                    aria-label={`${index + 1} ${ch.name} – ${currentEpg?.title || 'Élő adás'}`}
                    onPointerDown={(event) => {
                      // Csak a csatornasoron tartott 1 másodperces nyomás jelöli ki
                      // rendezésre; a soron lévő gombokra indított nyomás nem.
                      if (event.pointerType === 'touch' || (event.target as HTMLElement).closest('button') || sortMode !== 'saved') return;
                      clearLongPressTimer();
                      suppressNextClick.current = false;
                      longPressTimer.current = window.setTimeout(() => {
                        setMovingChannelId(ch.id);
                        suppressNextClick.current = true;
                      }, 1000);
                    }}
                    onPointerUp={clearLongPressTimer}
                    onPointerCancel={clearLongPressTimer}
                    onClick={() => {
                      if (suppressNextClick.current) {
                        suppressNextClick.current = false;
                        return;
                      }
                      if (movingChannelId) {
                        if (movingChannelId === ch.id) setMovingChannelId(null);
                        return;
                      }
                      setHighlightedId(ch.id);
                      if (ch.id === selectedChannelId) {
                        fsStart('BE', 'csatornalista Magic Remote');
                        window.dispatchEvent(new CustomEvent('iptv-enter-fullscreen'));
                      } else {
                        onSelectChannel(ch);
                      }
                    }}
                    onKeyDown={(e) => {
                      const key = normalizeTvKey(e);
                      // Mozgatáskor a sor nem nyelheti el az OK-t vagy a nyilakat:
                      // ezeket a lista kezelője dolgozza fel a piros nyíl/kuka kurzorhoz.
                      if (movingChannelId) return;
                      if (key === 'Enter' || key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        if (movingChannelId) return; // mozgatás módban az OK a nyilakhoz tartozik
                        setHighlightedId(ch.id);
                        // Első OK: indítás a főoldali lejátszóban. A teljes
                        // képernyő csak a már futó csatornán, második OK-ra jön.
                        if (ch.id === selectedChannelId) {
                          // A mérés az OK lenyomásától indul (2.5.166).
                          fsStart('BE', `csatornalista OK – ${ch.name}`);
                          window.dispatchEvent(new CustomEvent('iptv-enter-fullscreen'));
                        } else {
                          onSelectChannel(ch);
                        }
                      } else if (key === 'ArrowRight') {
                        // JOBBRA: a sor jobb szélén lévő KEDVENC-CSILLAGRA
                        // lépünk (külön kijelölhető elem).
                        const star = (e.currentTarget as HTMLElement)
                          .querySelector<HTMLElement>('[data-favorite-star]');
                        if (star) {
                          e.preventDefault();
                          e.stopPropagation();
                          setHighlightedId(ch.id);
                          star.focus({ preventScroll: true } as FocusOptions);
                        }
                      }
                    }}
                    className={`group h-full flex items-center justify-between px-2 rounded-2xl cursor-pointer transition-all duration-150 select-none focus:outline-none ${
                      movingChannelId === ch.id
                        ? 'bg-emerald-700/90 border-2 border-emerald-300 shadow-lg shadow-emerald-950/60 ring-2 ring-emerald-400/60 scale-[1.01]'
                        : isHighlighted && !isSelected
                          ? 'bg-[#13254b] shadow-lg shadow-amber-950/40'
                          : isSelected
                            ? 'bg-linear-to-r from-cyan-950/90 via-[#0e2752] to-[#0a1b38] border-2 border-cyan-400/90 shadow-lg shadow-cyan-950/60'
                            : 'bg-[#0a152d]/80 hover:bg-[#112347] md:hover:bg-[#132a52] lg:hover:bg-[#132a52] xl:hover:bg-[#152e5c] border border-slate-800/40 hover:border-cyan-700/50'
                    }`}
                  >
                    {/* Left side: Num badge + Logo + Info */}
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      {/* Number pill */}
                      <div
                        className={`shrink-0 px-2.5 py-1 rounded-xl font-black ${bigRows ? 'text-base' : 'text-xs sm:text-sm'} tracking-wider min-w-[56px] text-center ${
                          isSelected
                            ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30 font-black'
                            : 'bg-[#0d1f42] text-cyan-300 border border-cyan-700/40'
                        }`}
                      >
                        {index + 1}
                      </div>

                      {/* Channel Logo: sikeres betöltés után a logót nem tüntetjük el átmeneti hibára. */}
                      <div className={`relative shrink-0 ${bigRows ? 'w-14 h-11' : 'w-10 h-8'} rounded-lg border border-slate-700/60 p-0.5 flex items-center justify-center overflow-hidden bg-transparent`}>
                        {/* A retryKey NEM a csatorna objektum: az EPG-frissítéskor
                          új objektum jön, ami feleslegesen újraindította a logó
                          betöltését minden sorban. Az egyedi azonosító stabil. */}
                      <ChannelLogo url={ch.logo} name={ch.name} retryKey={ch.id} />
                      </div>

                      {/* Channel name, current EPG and real-time progress */}
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className={`text-slate-100 font-bold ${bigRows ? 'text-lg leading-tight' : 'text-xs sm:text-sm'} truncate group-hover:text-cyan-200`}>
                          {ch.name}
                        </span>
                        <span className={`text-amber-400 font-medium ${bigRows ? 'text-sm' : 'text-[11px]'} truncate flex items-center gap-1`}>
                          {currentEpg?.time && (
                            <span className="text-amber-300 font-mono font-bold shrink-0">
                              {currentEpg.time}
                            </span>
                          )}
                          <span className="truncate">{currentEpg?.title || 'EPG betöltése…'}</span>
                        </span>
                        <span className={`text-slate-400 font-medium ${bigRows ? 'text-xs' : 'text-[10px]'} truncate`}>
                          {nextEpg?.time ? `${nextEpg.time} · ` : ''}Következő: {nextEpg?.title || 'betöltés…'}
                        </span>
                        {/* A haladássáv helye minden sorban foglalt, hogy a sorok egyformák legyenek. */}
                        <div className={`mt-0.5 ${bigRows ? 'h-1.5' : 'h-1'} w-full max-w-64`}>
                          {epgPercent !== null && (
                            <div
                              className="h-full w-full rounded-full bg-slate-700/80 overflow-hidden"
                              role="progressbar"
                              aria-label={`${ch.name} műsorhaladása`}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={epgPercent}
                            >
                              <div
                                className="h-full rounded-full bg-amber-400 transition-all duration-500"
                                style={{ width: `${epgPercent}%` }}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Jobb oldali műveletek. A rendező nyilak csak a zöldre kijelölt csatornán jelennek meg. */}
                    <div className="flex items-center gap-1 shrink-0 ml-1">
                      {/*
                        KEDVENC-CSILLAG (mint az OSD-ben): sárga = valamelyik
                        kedvenc mappában benne van, szürke = nincs hozzáadva.
                        Kattintásra ugyanazt teszi, mint az OSD csillaga.
                        A távirányítós kijelölést nem zavarja (tabIndex -1).
                      */}
                      {movingChannelId !== ch.id && (
                        <button
                          type="button"
                          tabIndex={0}
                          data-favorite-star={ch.id}
                          /*
                            A csillag KÜLÖN kijelölhető (a felhasználó kérése):
                            a sor jobb szélén a távirányítóval is rá lehet lépni
                            (jobbra a sorból), és az OK-ra ELŐBB a kedvenc
                            mappaválasztó ugrik fel – csak utána kerül a
                            csatorna a mappába.
                          */
                          onClick={(e) => {
                            e.stopPropagation();
                            setMovingChannelId(null);
                            setFavoritePickChannelId(ch.id);
                          }}
                          onKeyDown={(e) => {
                            const key = normalizeTvKey(e);
                            if (key === 'Enter' || key === ' ') {
                              e.preventDefault();
                              e.stopPropagation();
                              setMovingChannelId(null);
                              setFavoritePickChannelId(ch.id);
                            } else if (key === 'ArrowLeft') {
                              // Balra vissza a csatornasorra.
                              e.preventDefault();
                              e.stopPropagation();
                              focusChannelRow(ch.id);
                            }
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-xl border transition-all active:scale-90 ${
                            ch.isFavorite
                              ? 'bg-amber-400/20 text-amber-300 border-amber-400/50'
                              : 'bg-[#0f1d3a] text-slate-500 border-slate-700/60 hover:text-amber-400'
                          }`}
                          title={ch.isFavorite ? 'Eltávolítás a kedvencekből' : 'Hozzáadás a kedvencekhez'}
                          aria-label={ch.isFavorite ? `${ch.name} eltávolítása a kedvencekből` : `${ch.name} hozzáadása a kedvencekhez`}
                          aria-pressed={ch.isFavorite}
                        >
                          <Star className={`w-4 h-4 ${ch.isFavorite ? 'fill-amber-400 text-amber-400' : ''}`} />
                        </button>
                      )}
                      {movingChannelId === ch.id && onMoveChannel ? (
                        <>
                          <button
                            disabled={index === 0}
                            onClick={(e) => { e.stopPropagation(); onMoveChannel(ch.id, 'up'); }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className={`p-1.5 rounded-xl text-white bg-red-800/90 border border-red-400/70 hover:bg-red-700 disabled:opacity-20 active:scale-90 ${moveCursor === 'up' ? 'ring-4 ring-amber-400 scale-110' : ''}`}
                            title="Mozgatás felfelé"
                            aria-label="Csatorna mozgatása felfelé"
                          >
                            <ArrowUp className="w-4 h-4" />
                          </button>
                          <button
                            disabled={index === visibleChannels.length - 1}
                            onClick={(e) => { e.stopPropagation(); onMoveChannel(ch.id, 'down'); }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className={`p-1.5 rounded-xl text-white bg-red-800/90 border border-red-400/70 hover:bg-red-700 disabled:opacity-20 active:scale-90 ${moveCursor === 'down' ? 'ring-4 ring-amber-400 scale-110' : ''}`}
                            title="Mozgatás lefelé"
                            aria-label="Csatorna mozgatása lefelé"
                          >
                            <ArrowDown className="w-4 h-4" />
                          </button>
                        </>
                      ) : null}
                      {movingChannelId === ch.id ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteChannel(ch.id);
                            setMovingChannelId(null);
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className={`p-1.5 rounded-xl text-white bg-red-950 border border-red-500/80 hover:bg-red-800 active:scale-90 ${moveCursor === 'trash' ? 'ring-4 ring-amber-400 scale-110' : ''}`}
                          title={selectedFavoriteFolderId ? 'Eltávolítás ebből a kedvenc mappából' : 'Csatorna törlése az ország/lista csatornái közül'}
                          aria-label={selectedFavoriteFolderId ? `Eltávolítás a kedvenc mappából: ${ch.name}` : `Csatorna törlése: ${ch.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* SÁRGA gomb: kedvenc mappa választó felugró a kijelölt csatornához. */}
      {favoritePickChannelId && (() => {
        const channel = channels.find((c) => c.id === favoritePickChannelId)
          || visibleChannels.find((c) => c.id === favoritePickChannelId);
        const close = () => {
          setFavoritePickChannelId(null);
          // Vissza a csatornasorra, nem a lista dobozára.
          if (!focusChannelRow(channel?.id || '')) focusFirstChannelRow();
        };
        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Hozzáadás kedvenc mappához"
            data-favorite-pick=""
            className="fixed inset-0 z-[140] flex items-center justify-center p-6 bg-black/75"
            onClick={(e) => { if (e.target === e.currentTarget) close(); }}
            onKeyDown={(e) => {
              const key = normalizeTvKey(e);
              if (key === 'Escape' || key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          >
            <div className="w-full max-w-md rounded-2xl bg-[#081329] border-2 border-amber-400/70 shadow-2xl p-4 space-y-2">
              <h3 className="text-base font-black text-amber-300">
                ⭐ Kedvencekhez adás
              </h3>
              <p className="text-sm text-slate-300 truncate">
                {channel ? channel.name : 'Csatorna'} – válassz kedvenc mappát:
              </p>
              <div className="max-h-[50vh] overflow-y-auto space-y-1.5 pt-1">
                {folders.length === 0 ? (
                  <p className="text-sm text-slate-400 leading-relaxed">
                    Még nincs kedvenc mappa. Hozz létre egyet a Menü → Kedvencek fülön,
                    utána a csatornasor jobb szélén lévő ⭐ gombbal ide tudod tenni a csatornákat.
                  </p>
                ) : folders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => {
                      if (channel) onAssignToFolder?.(channel.id, folder.id);
                      close();
                    }}
                    className="w-full text-left px-3 py-2.5 rounded-xl bg-[#0d1c3a] border border-cyan-700/50 text-slate-100 text-sm font-bold hover:bg-[#142b56] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                  >
                    {folder.icon || '📁'} {folder.name}
                  </button>
                ))}
              </div>
              {channel?.isFavorite && (
                <button
                  type="button"
                  onClick={() => {
                    onToggleFavorite(channel.id);
                    close();
                  }}
                  className="w-full px-3 py-2 rounded-xl bg-rose-950/50 border border-rose-700/60 text-rose-300 text-sm font-bold hover:bg-rose-900/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                >
                  Eltávolítás a kedvencekből
                </button>
              )}
              <button
                type="button"
                onClick={close}
                className="w-full px-3 py-2 rounded-xl bg-slate-700/70 text-slate-200 text-sm font-bold hover:bg-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              >
                Mégse
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

/**
 * Memoizált export.
 *
 * A csatornalista a legdrágább komponens (sorok, logók, EPG). Korábban minden
 * App-szintű állapotváltozás (hangerő, OSD ki/be, lejátszás, előzmény
 * frissítés) újrarajzolta. A propok most stabilak (useCallback/useMemo az
 * App-ban), ezért elég akkor újrarajzolni, ha tényleg változott a lista.
 */
export const ChannelList = React.memo(ChannelListView);
