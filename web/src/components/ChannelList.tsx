import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Category, Channel, FavoriteFolder } from '../types/iptv';
import { ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import { ChannelLogo } from './ChannelLogo';
import { ProviderRef } from '../services/contentStore';
import { EpgNowNext, getCachedShortEpg, loadShortEpg, nowNextFromEpg, streamIdFor } from '../services/epgService';
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
/** TV-n/főoldalon pontosan ennyi csatornasor látszódjon egyszerre. */
const VISIBLE_ROWS = 10;

export const ChannelList: React.FC<ChannelListProps> = ({
  channels,
  activeProvider,
  epgReady,
  epgRevision,
  selectedChannelId,
  onSelectChannel,
  // onToggleFavorite: a csillag gomb kikerült a sorokból (2.3.16), a prop a kompatibilitás miatt maradt.
  onDeleteChannel,
  onMoveChannel,
  folders,
  selectedCategoryId,
  isOnlyFavorites,
  selectedFavoriteFolderId,
  onSelectFavoriteFolder,
  onDisplayOrderChange,
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
  const longPressTimer = useRef<number | null>(null);
  const suppressNextClick = useRef(false);
  const lastReorderTapAt = useRef(0);
  const [epgClock, setEpgClock] = useState(() => Date.now());
  const [localEpg, setLocalEpg] = useState<Record<string, EpgNowNext>>({});

  // A műsorhaladás frissüljön akkor is, ha a csatornalista egyébként nem változik.
  useEffect(() => {
    const timer = window.setInterval(() => setEpgClock(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

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

  // A fő OSD ugyanazt a megjelenítési sorszámot használja, mint a lista –
  // a kedvenc mappák sorszám szerinti rendezésénél is.
  useEffect(() => {
    onDisplayOrderChange?.(visibleChannels.map((channel) => channel.id));
  }, [visibleChannels, onDisplayOrderChange]);

  /* ------------------------------------------------------- ablakosítás */

  const channelScrollRef = useRef<HTMLDivElement | null>(null);
  const [windowRange, setWindowRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const rangeRef = useRef(windowRange);

  // PONTOSAN 10 sor férjen el: a sormagasságot a lista tényleges
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
  const measureRows = React.useCallback(() => {
    const element = channelScrollRef.current;
    if (!element) return;
    const usable = element.clientHeight - LIST_PADDING * 2;
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
    element.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null;
    observer?.observe(element);
    window.addEventListener('resize', onScroll);
    return () => {
      element.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
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
    if (!epgReady || !activeProvider || activeProvider.type !== 'xtream') {
      setLocalEpg({});
      return;
    }
    let cancelled = false;
    let cursor = 0;
    // Csak azokat kérjük le, amelyekhez nincs gyorsítótárazott adat.
    const queue = epgQueue.filter((channel) => {
      const streamId = streamIdFor(channel);
      return !!streamId && getCachedShortEpg(activeProvider, streamId, 6).length === 0;
    });

    const updateFromCache = () => {
      setLocalEpg((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const channel of epgQueue) {
          const streamId = streamIdFor(channel);
          if (!streamId) continue;
          const entries = getCachedShortEpg(activeProvider, streamId, 6);
          if (!entries.length) continue;
          const epg = nowNextFromEpg(entries, Date.now());
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

    updateFromCache();
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
        try {
          const entries = await loadShortEpg(activeProvider, streamId, 6);
          if (!cancelled && entries.length) {
            queueEpg(channel.id, nowNextFromEpg(entries, Date.now()));
          }
        } catch {
          // Egy csatorna EPG-hibája ne akadályozza a többi sor betöltését.
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => {
      cancelled = true;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
    };
  }, [epgReady, epgRevision, activeProvider?.id, activeProvider?.serverUrl, activeProvider?.username, activeProvider?.password, epgQueue]);

  // A gyorsítótárból 30 másodpercenként újraszámoljuk az éppen futó műsort,
  // ezért a cím és a sárga haladási sáv magától frissül.
  useEffect(() => {
    if (!activeProvider || activeProvider.type !== 'xtream') return;
    setLocalEpg((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const channel of epgQueue) {
        const streamId = streamIdFor(channel);
        if (!streamId) continue;
        const entries = getCachedShortEpg(activeProvider, streamId, 6);
        if (!entries.length) continue;
        const epg = nowNextFromEpg(entries, epgClock);
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
  }, [epgClock, epgRevision, activeProvider?.id, activeProvider?.serverUrl, activeProvider?.username, activeProvider?.password, epgQueue]);

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
    scrollSaveFrame.current = window.requestAnimationFrame(() => {
      scrollSaveFrame.current = 0;
      try {
        window.sessionStorage.setItem(scrollPositionKey, String(pendingScrollTop.current));
      } catch {
        // A tároló hiánya nem akadályozza a csatornalista használatát.
      }
    });
  };
  useEffect(() => () => {
    // Teljes képernyőre lépéskor a lista lekerül, mentsük azonnal a pending pozíciót.
    if (scrollSaveFrame.current) {
      window.cancelAnimationFrame(scrollSaveFrame.current);
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

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    // LG webOS: régi kulcsnév ('Up'/'Down') vagy csak keyCode is érkezhet.
    const key = normalizeTvKey(e);
    if (key === 'ArrowLeft') {
      // BALRA: a jelölő azonnal a TV lejátszóra ugrik.
      const player = document.querySelector<HTMLElement>('[data-tv-player]');
      if (player) {
        e.preventDefault();
        e.stopPropagation();
        player.focus({ preventScroll: true } as any);
        return;
      }
    }
    if (visibleChannels.length === 0) {
      // ÜRES lista (még töltődik vagy nincs lejátszási lista): ne legyen
      // zsákutca a TV-n – bármely nyíllal a felső menüsorra ugrunk, hogy a
      // távirányítóval el lehessen érni a Beállításokat/Mozit/Sorozatot.
      if (isTvArrowKey(key)) {
        e.preventDefault();
        e.stopPropagation();
        focusHeaderMenu();
      }
      return;
    }
    // A fel/le nyíl CSAK a sárga kijelölést mozgatja (felsorolás),
    // csatornát nem vált - váltani az OK/Enter gombbal lehet.
    const highlightIndex = visibleChannels.findIndex((c) => c.id === highlightedId);
    const currentIndex = highlightIndex >= 0
      ? highlightIndex
      : visibleChannels.findIndex((c) => c.id === selectedChannelId);
    const moveHighlight = (target: number) => {
      const next = visibleChannels[target];
      if (!next) return;
      setHighlightedId(next.id);
      // A fókusz a listán marad, hogy ne ragadjon sárga keret egy régi soron.
      (e.currentTarget as HTMLElement | null)?.focus?.({ preventScroll: true } as any);
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-channel-id="${next.id}"]`) as HTMLElement | null;
        if (!el) return;
        // Régi webOS Chrome: a scrollIntoView(options) hibás - ott a
        // scrollIntoViewIfNeeded a megbízható.
        const legacy = el as HTMLElement & { scrollIntoViewIfNeeded?: (center?: boolean) => void };
        if (typeof legacy.scrollIntoViewIfNeeded === 'function') legacy.scrollIntoViewIfNeeded(false);
        else if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    };
    if (key === 'ArrowUp' && currentIndex <= 0) {
      // A lista tetejéről felfelé: fókusz a felső menüsorra.
      e.preventDefault();
      e.stopPropagation();
      focusHeaderMenu();
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
      if (current) onSelectChannel(current);
    }
  };

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
        el.focus({ preventScroll: true } as any);
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

  // TV: ha egér mozog, mutassuk a kurzort, ha D-pad, fókusz gyűrű
  useEffect(() => {
    const onMouseMove = () => {
      try { document.body.classList.add('has-mouse'); } catch {}
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // FONTOS: régi webOS-en az e.key üres is lehet – a normalizáló keyCode-ból
      // is felismeri a gombot, és nem dob hibát üres kulcsnévnél.
      const key = normalizeTvKey(e);
      if (isTvArrowKey(key) || key === 'Enter') {
        try { document.body.classList.remove('has-mouse'); } catch {}
      }
    };
    window.addEventListener('mousemove', onMouseMove, { once: false });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div className="flex-1 flex flex-col bg-[#070e1e] overflow-hidden md:bg-[#070e1e] lg:bg-[#070e1e] xl:bg-[#070e1e] 2xl:bg-[#070e1e]">
      {/* Az „Összes” után közvetlenül a létrehozott kedvenc mappák jelennek meg; nincs csatornakategória vagy külön mappanyitó. */}
      <div className="px-2 py-2 bg-[#070f22] border-b border-cyan-950/60 overflow-x-auto shrink-0">
        <div className="flex items-center gap-2 min-w-max">
          {selectedFavoriteFolderId && (
            <button
              type="button"
              onClick={() => {
                setMovingChannelId(null);
                if (sortMode === 'saved') {
                  setSortMode('number');
                } else if (sortMode === 'number') {
                  setSortMode('back');
                } else {
                  onSelectFavoriteFolder(null);
                  setSortMode('saved');
                }
              }}
              title={sortMode === 'saved'
                ? 'Kattints: kedvenc csatornák rendezése sorszám szerint'
                : sortMode === 'number'
                  ? 'Kattints: vissza a kedvenc csatornák mentett sorrendjéhez'
                  : 'Kattints: vissza a mentett sorrendhez'}
              aria-label={sortMode === 'saved'
                ? 'Kedvencek mentett sorrendje. Kattints a sorszám szerinti rendezéshez.'
                : sortMode === 'number'
                  ? 'Kedvencek sorszám szerinti sorrendje. Kattints a vissza művelethez.'
                  : 'Vissza a kedvencek mentett sorrendjéhez.'}
              className={`px-3 py-2 rounded-xl text-xs font-black whitespace-nowrap border transition-colors ${sortMode === 'saved' ? 'bg-cyan-400 text-slate-950 border-cyan-300' : sortMode === 'number' ? 'bg-amber-400 text-slate-950 border-amber-300' : 'bg-emerald-400 text-slate-950 border-emerald-300'}`}
            >{sortMode === 'saved' ? '📺 ↕ Mentett' : sortMode === 'number' ? '📺 # Szám' : '↩ Vissza'}</button>
          )}
          {folders.map((folder, folderIndex) => {
            const folderBorder = folderIndex % 2 === 0 ? 'border-cyan-400' : 'border-amber-400';
            const isSelected = selectedFavoriteFolderId === folder.id;
            return (
              <button
                key={folder.id}
                type="button"
                onClick={() => onSelectFavoriteFolder(folder.id)}
                className={`px-3 py-2 rounded-xl text-xs font-bold whitespace-nowrap border-2 transition-colors ${folderBorder} ${isSelected ? 'bg-amber-400 text-slate-950' : 'bg-[#0d1c3a] text-slate-300'}`}
              >{folder.icon || '📁'} {folder.name}</button>
            );
          })}
        </div>
      </div>

      {/* Channel Rows – csak a látható sáv rajzolódik ki (ablakos lista). Reszponzív + egér + billentyűzet */}
      <div
        ref={channelScrollRef}
        tabIndex={0}
        onKeyDown={handleListKeyDown}
        onScroll={(event) => saveChannelScrollPosition(event.currentTarget)}
        className="flex-1 overflow-y-auto focus:outline-none md:scrollbar-thin lg:scrollbar-thin xl:scrollbar-thin"
        role="listbox"
        aria-label="Csatornalista – nyilakkal navigálható, Enterrel választható, egérrel kattintható"
      >
        {visibleChannels.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 text-center text-slate-400">
            <p className="text-sm font-semibold">
              {selectedFavoriteFolderId ? 'Ez a kedvenc mappa még üres' : isOnlyFavorites ? 'Válassz kedvenc mappát a fenti listából' : 'Nincs betöltött csatorna'}
            </p>
            {!selectedFavoriteFolderId && !isOnlyFavorites && (
              <p className="text-xs mt-1 text-slate-500 max-w-xs leading-relaxed">
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
              // Nagyobb írás, ha a sorok a 10-es elosztás miatt magasabbak.
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
                      if ((event.target as HTMLElement).closest('button') || sortMode !== 'saved') return;
                      clearLongPressTimer();
                      suppressNextClick.current = false;
                      longPressTimer.current = window.setTimeout(() => {
                        setMovingChannelId(ch.id);
                        suppressNextClick.current = true;
                        lastReorderTapAt.current = 0;
                      }, 1000);
                    }}
                    onPointerUp={clearLongPressTimer}
                    onPointerCancel={clearLongPressTimer}
                    onMouseEnter={() => {
                      // Laptop/desktop hover előnézet – nem választ, csak fókusz vizuál
                    }}
                    onClick={() => {
                      if (suppressNextClick.current) {
                        suppressNextClick.current = false;
                        return;
                      }
                      if (movingChannelId) {
                        if (movingChannelId !== ch.id) return;
                        const now = Date.now();
                        if (now - lastReorderTapAt.current <= 350) {
                          setMovingChannelId(null);
                          lastReorderTapAt.current = 0;
                        } else {
                          lastReorderTapAt.current = now;
                        }
                        return;
                      }
                      setHighlightedId(ch.id);
                      onSelectChannel(ch);
                    }}
                    onKeyDown={(e) => {
                      const key = normalizeTvKey(e);
                      if (key === 'Enter' || key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        setHighlightedId(ch.id);
                        onSelectChannel(ch);
                      }
                    }}
                    className={`group h-full flex items-center justify-between px-2 rounded-2xl cursor-pointer transition-all duration-150 select-none touch-pan-y focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-1 focus-visible:ring-offset-[#070e1e] ${
                      movingChannelId === ch.id
                        ? 'bg-emerald-700/90 border-2 border-emerald-300 shadow-lg shadow-emerald-950/60 ring-2 ring-emerald-400/60 scale-[1.01]'
                        : isHighlighted && !isSelected
                          ? 'bg-[#13254b] border-2 border-amber-400/90 ring-2 ring-amber-400/40 shadow-lg shadow-amber-950/40'
                          : isSelected
                            ? `bg-linear-to-r from-cyan-950/90 via-[#0e2752] to-[#0a1b38] border-2 ${isHighlighted ? 'border-amber-400/90 ring-2 ring-amber-400/40' : 'border-cyan-400/80 ring-1 ring-cyan-400/30'} shadow-lg shadow-cyan-950/60 scale-[1.01]`
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
                        <ChannelLogo url={ch.logo} name={ch.name} retryKey={ch} />
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
                      {movingChannelId === ch.id && onMoveChannel ? (
                        <>
                          <button
                            disabled={index === 0}
                            onClick={(e) => { e.stopPropagation(); onMoveChannel(ch.id, 'up'); }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="p-1.5 rounded-xl text-white bg-red-800/90 border border-red-400/70 hover:bg-red-700 disabled:opacity-20 active:scale-90"
                            title="Mozgatás felfelé"
                            aria-label="Csatorna mozgatása felfelé"
                          >
                            <ArrowUp className="w-4 h-4" />
                          </button>
                          <button
                            disabled={index === visibleChannels.length - 1}
                            onClick={(e) => { e.stopPropagation(); onMoveChannel(ch.id, 'down'); }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="p-1.5 rounded-xl text-white bg-red-800/90 border border-red-400/70 hover:bg-red-700 disabled:opacity-20 active:scale-90"
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
                          className="p-1.5 rounded-xl text-white bg-red-950 border border-red-500/80 hover:bg-red-800 active:scale-90"
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
    </div>
  );
};
