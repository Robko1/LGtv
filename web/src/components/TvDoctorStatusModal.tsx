import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  Database,
  RefreshCw,
  RotateCcw,
  Wifi,
  WifiOff,
  Wrench,
} from 'lucide-react';
import { AppSettings, Channel } from '../types/iptv';
import { TvDoctorIcon } from './TvDoctorIcon';
import { appLog, dateTimeText } from '../services/appLog';
import {
  DoctorEventCategory,
  DoctorLogEntry,
  MAX_CHANNEL_ROUTES,
  DOCTOR_BUFFER_CONFIGS,
  formatDoctorBytes,
  getChannelDoctorRecord,
  getTvDoctorChannelSnapshot,
  getTvDoctorMemoryStats,
  getTvDoctorOperationHealth,
  getTvDoctorSummary,
  isChannelHandledByDoctor,
  logTvDoctorPanel,
  sanitizeDoctorRoutes,
  DoctorRoute,
  subscribeTvDoctorUpdates,
} from '../services/tvDoctor';
import {
  checkTvDoctorConnection,
  fetchTvDoctorRoutesForChannelFromCloud,
  getTvDoctorCloudStatus,
  getTvDoctorPairingInfo,
  resetTvDoctorAllToZero,
} from '../services/tvDoctorCloud';
import { normalizeTvKey } from '../utils/tvKeys';

interface TvDoctorStatusModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  activeChannel?: Channel | null;
  isFullscreen?: boolean;
}

export const TV_DOCTOR_MODAL_Z_INDEX = 2147483600;

function isZeroDigitKey(e: KeyboardEvent | React.KeyboardEvent): boolean {
  const rawEvt = 'nativeEvent' in e ? e.nativeEvent : e;
  const norm = normalizeTvKey(rawEvt as KeyboardEvent);
  const key = e.key;
  const code = (e as KeyboardEvent).code || '';
  const kc = e.keyCode || e.which || 0;
  return (
    norm === '0' ||
    key === '0' ||
    key === 'U+0030' ||
    code === 'Digit0' ||
    code === 'Numpad0' ||
    kc === 48 ||
    kc === 96
  );
}

interface CategoryVisualMeta {
  id: DoctorEventCategory;
  title: string;
  shortTag: string;
  subtitle: string;
  cardBorder: string;
  cardBg: string;
  dotClass: string;
  titleColor: string;
  countBadge: string;
  logBorder: string;
  logBadge: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const CATEGORY_VISUALS: readonly CategoryVisualMeta[] = [
  {
    id: 'learning',
    title: 'Tanulás',
    shortTag: 'TANULÁS',
    subtitle: 'Gyorsprofil és formátum tanulása',
    cardBorder: 'border-emerald-400/75',
    cardBg: 'bg-emerald-950/45',
    dotClass: 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]',
    titleColor: 'text-emerald-200',
    countBadge: 'border-emerald-400/70 bg-emerald-500/25 text-emerald-100',
    logBorder: 'border-emerald-400/70 bg-emerald-950/30',
    logBadge: 'border-emerald-400/65 bg-emerald-500/25 text-emerald-200',
    Icon: BookOpenCheck,
  },
  {
    id: 'assistance',
    title: 'Segítség / Javítás',
    shortTag: 'SEGÍTSÉG',
    subtitle: 'Beállításváltás, pufferemelés és javítás',
    cardBorder: 'border-sky-400/80',
    cardBg: 'bg-sky-950/45',
    dotClass: 'bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.9)]',
    titleColor: 'text-sky-200',
    countBadge: 'border-sky-400/75 bg-sky-500/25 text-sky-100',
    logBorder: 'border-sky-400/75 bg-sky-950/35',
    logBadge: 'border-sky-400/65 bg-sky-500/25 text-sky-200',
    Icon: Wrench,
  },
  {
    id: 'activation',
    title: 'Aktiválódás',
    shortTag: 'AKTIVÁLÓDÁS',
    subtitle: 'Közbelépés késés vagy akadás miatt',
    cardBorder: 'border-amber-400/80',
    cardBg: 'bg-amber-950/40',
    dotClass: 'bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.9)]',
    titleColor: 'text-amber-200',
    countBadge: 'border-amber-400/75 bg-amber-500/25 text-amber-100',
    logBorder: 'border-amber-400/75 bg-amber-950/30',
    logBadge: 'border-amber-400/65 bg-amber-500/25 text-amber-200',
    Icon: Activity,
  },
  {
    id: 'channel_error',
    title: 'Hiba a csatornánál',
    shortTag: 'CSATORNAHIBA',
    subtitle: 'Stream hiba vagy nem működő adás leállítása',
    cardBorder: 'border-rose-500/85',
    cardBg: 'bg-rose-950/50',
    dotClass: 'bg-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.95)]',
    titleColor: 'text-rose-200',
    countBadge: 'border-rose-400/80 bg-rose-500/25 text-rose-100',
    logBorder: 'border-rose-500/80 bg-rose-950/40',
    logBadge: 'border-rose-400/70 bg-rose-500/25 text-rose-200',
    Icon: AlertOctagon,
  },
];

const CATEGORY_BY_ID: Record<DoctorEventCategory, CategoryVisualMeta> = {
  learning: CATEGORY_VISUALS[0],
  assistance: CATEGORY_VISUALS[1],
  activation: CATEGORY_VISUALS[2],
  channel_error: CATEGORY_VISUALS[3],
};

function safeDoctorFormat(format: unknown): string {
  const value = typeof format === 'string' ? format.trim().toLowerCase() : '';
  if (value === 'ts') return 'TS';
  if (value === 'hls') return 'HLS';
  return 'NINCS ADAT';
}

function safeDoctorBufferLabel(profile: unknown): string {
  const value = typeof profile === 'string' ? profile.trim() : '';
  if (!value) return 'NINCS ADAT';
  return DOCTOR_BUFFER_CONFIGS[value as keyof typeof DOCTOR_BUFFER_CONFIGS]?.label || value.toUpperCase();
}

export const TvDoctorStatusModal: React.FC<TvDoctorStatusModalProps> = ({
  isOpen,
  onClose,
  settings,
  activeChannel,
  isFullscreen = false,
}) => {
  const [, setUiTick] = useState(0);
  const [resetFeedback, setResetFeedback] = useState(false);
  const [expanded, setExpanded] = useState<Record<DoctorEventCategory, boolean>>({
    learning: false,
    assistance: false,
    activation: false,
    channel_error: false,
  });
  const [largeCat, setLargeCat] = useState<DoctorEventCategory | null>(null);
  const [cloudRoutes, setCloudRoutes] = useState<DoctorRoute[] | null>(null);
  /** 2.5.392: a Memória: 0 után a felhő-útvonalak újraolvasását kényszeríti. */
  const [resetVersion, setResetVersion] = useState(0);
  const largeScrollRef = useRef<HTMLDivElement | null>(null);

  const modalCardRef = useRef<HTMLDivElement | null>(null);
  const rightScrollRef = useRef<HTMLDivElement | null>(null);
  const resetBtnRef = useRef<HTMLButtonElement | null>(null);
  const testBtnRef = useRef<HTMLButtonElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const resetFeedbackTimerRef = useRef<number | null>(null);
  const categoryHeaderRefs = useRef<Record<DoctorEventCategory, HTMLDivElement | null>>({
    learning: null,
    assistance: null,
    activation: null,
    channel_error: null,
  });
  const categoryScrollRefs = useRef<Record<DoctorEventCategory, HTMLDivElement | null>>({
    learning: null,
    assistance: null,
    activation: null,
    channel_error: null,
  });
  const leftPaneRef = useRef<HTMLDivElement | null>(null);
  const compatLogScrollRef = useRef<HTMLDivElement | null>(null);

  const handleModalKeyDownRef = useRef<(e: KeyboardEvent | React.KeyboardEvent<HTMLDivElement>) => void>(() => {});

  useEffect(() => {
    if (!isOpen) return undefined;
    const onWinKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      handleModalKeyDownRef.current(e);
    };
    window.addEventListener('keydown', onWinKey, false);
    return () => window.removeEventListener('keydown', onWinKey, false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    return subscribeTvDoctorUpdates(() => {
      setUiTick((n) => n + 1);
    });
  }, [isOpen]);

  useEffect(() => {
    let cancelled = false;
    setCloudRoutes(null);
    if (!isOpen || !activeChannel || settings.tvDoctorEnabled === false) {
      setCloudRoutes([]);
      return undefined;
    }
    void fetchTvDoctorRoutesForChannelFromCloud(activeChannel, getChannelDoctorRecord(activeChannel)?.channelKey)
      .then((routes) => {
        if (!cancelled) setCloudRoutes(sanitizeDoctorRoutes(routes).filter((route) => route.ok > 0));
      })
      .catch(() => {
        if (!cancelled) setCloudRoutes([]);
      });
    return () => { cancelled = true; };
  }, [isOpen, activeChannel?.id, activeChannel?.name, activeChannel?.countryCode, settings.tvDoctorEnabled, resetVersion]);

  /* 2.5.392: a nyitási napló is az ÖSSZEVONT (helyi + Supabase)
     pillanatképből készül. A felhő útvonalai aszinkron érkeznek, ezért
     megvárjuk őket, és nyitásonként PONTOSAN EGYSZER írunk. */
  const openLogDoneRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      openLogDoneRef.current = false;
      return undefined;
    }
    return () => {
      logTvDoctorPanel('bezárva', {
        csatorna: activeChannel?.name || 'nincs',
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen || cloudRoutes === null || openLogDoneRef.current) return;
    openLogDoneRef.current = true;
    const snap = getTvDoctorChannelSnapshot(activeChannel, cloudRoutes);
    logTvDoctorPanel('megnyitva (0 gomb)', {
      csatorna: activeChannel?.name || 'nincs',
      ország: activeChannel?.countryCode || 'nincs',
      tanulás: snap.logsByCategory.learning.length,
      segítség: snap.logsByCategory.assistance.length,
      aktiválódás: snap.logsByCategory.activation.length,
      csatornahiba: snap.logsByCategory.channel_error.length,
      tanultÚtvonalak: `${snap.routes.length}/${MAX_CHANNEL_ROUTES}`,
      helyi: snap.localRouteCount,
      supabase: snap.cloudRouteCount,
      legjobb: snap.routes[0] ? `${safeDoctorFormat(snap.routes[0].format)}+${snap.routes[0].bufferProfile}` : 'még nincs',
      mód: settings.tvDoctorEnabled === false ? 'kikapcsolva' : 'aktív',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, cloudRoutes]);

  useEffect(() => {
    if (!isOpen) {
      setResetFeedback(false);
      setLargeCat(null);
      setExpanded({
        learning: false,
        assistance: false,
        activation: false,
        channel_error: false,
      });
      if (resetFeedbackTimerRef.current !== null) {
        window.clearTimeout(resetFeedbackTimerRef.current);
        resetFeedbackTimerRef.current = null;
      }
      return undefined;
    }

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void checkTvDoctorConnection();

    const focusTimer = window.setTimeout(() => {
      // Megnyitáskor közvetlenül a bal felső Tanulás doboz kapja a fókuszt.
      const firstCategory = categoryHeaderRefs.current.learning;
      if (firstCategory) {
        try { firstCategory.focus({ preventScroll: true } as FocusOptions); }
        catch { firstCategory.focus(); }
      }
    }, 30);

    return () => {
      window.clearTimeout(focusTimer);
      const fsPlayer = typeof document !== 'undefined'
        ? document.querySelector<HTMLElement>('[data-tv-player].fixed')
        : null;
      const prev = previousFocusRef.current;
      if (fsPlayer) {
        try {
          fsPlayer.focus({ preventScroll: true } as FocusOptions);
          return;
        } catch {
          /* ignore */
        }
      }
      if (prev && document.contains(prev)) {
        try {
          prev.focus({ preventScroll: true } as FocusOptions);
        } catch {
          /* ignore */
        }
      }
    };
  }, [isOpen]);


  useEffect(() => {
    if (largeCat && largeScrollRef.current) {
      const timer = window.setTimeout(() => {
        try { largeScrollRef.current?.focus({ preventScroll: true } as FocusOptions); } catch { largeScrollRef.current?.focus(); }
      }, 30);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [largeCat]);

  if (!isOpen) return null;

  const tvDoctorEnabled = settings.tvDoctorEnabled !== false;
  const doctorSummary = getTvDoctorSummary();
  const doctorMem = getTvDoctorMemoryStats();
  const doctorOp = getTvDoctorOperationHealth();
  const doctorCloud = getTvDoctorCloudStatus();
  const pairingInfo = getTvDoctorPairingInfo();

  const hasCloudError = Boolean(doctorCloud.lastErrorSummary) && doctorCloud.connectionState !== 'unpaired';
  const hasStorageError = Boolean(doctorMem.lastStorageError);
  const hasAnyIssue = tvDoctorEnabled && (hasCloudError || hasStorageError || doctorMem.memoryHealth === 'high');

  let overallBadgeText = 'Kikapcsolva';
  let overallBadgeClass = 'bg-slate-800 text-slate-300 border-slate-600/60';
  if (tvDoctorEnabled) {
    if (hasStorageError || doctorCloud.connectionState === 'error') {
      overallBadgeText = 'Hiba észlelve';
      overallBadgeClass = 'bg-rose-500/20 text-rose-200 border-rose-400/60';
    } else if (doctorCloud.connectionState === 'offline') {
      overallBadgeText = 'Offline gyorsítótár';
      overallBadgeClass = 'bg-amber-500/20 text-amber-200 border-amber-400/60';
    } else {
      overallBadgeText = 'Minden rendben';
      overallBadgeClass = 'bg-emerald-500/20 text-emerald-200 border-emerald-400/55';
    }
  }

  const formatLogClock = (ts: number): string => {
    const full = dateTimeText(ts);
    const idx = full.indexOf(' ');
    return idx >= 0 ? full.slice(idx + 1) : full;
  };

  const lastSyncText = doctorCloud.lastSyncAt
    ? (() => {
        const parsed = Date.parse(doctorCloud.lastSyncAt);
        return Number.isFinite(parsed) ? dateTimeText(parsed) : doctorCloud.lastSyncAt;
      })()
    : 'Még nem történt szinkron';

  const activeChannelHandled = Boolean(activeChannel && tvDoctorEnabled && isChannelHandledByDoctor(activeChannel));
  /*
   * 2.5.392: a 4 bal doboz ÉS az alsó útvonallista UGYANABBÓL a
   * pillanatképből készül (helyi tanulás + Supabase). Korábban a lista csak a
   * felhőt nézte, ezért a „Memória: 0” után a doboz 4 tanulást, a lista 0/7
   * útvonalat mutatott – és a kézi napló is harmadik, globális számot írt.
   */
  const channelSnapshot = getTvDoctorChannelSnapshot(activeChannel, cloudRoutes);
  const activeRoutes = channelSnapshot.routes;
  const logsByCategory = channelSnapshot.logsByCategory;
  /* A kompatibilis `data-tv-doctor-log-count` a csatorna ÖSSZES naplósorát mutatja. */
  const orderedLogs = (['learning', 'assistance', 'activation', 'channel_error'] as DoctorEventCategory[])
    .flatMap((cat) => logsByCategory[cat])
    .sort((a, b) => b.at - a.at);
  const displayLogsByCategory: Record<DoctorEventCategory, DoctorLogEntry[]> = {
    learning: logsByCategory.learning.slice(0, 8),
    assistance: [...logsByCategory.assistance].sort((a, b) => {
      const score = (entry: DoctorLogEntry) => (entry.operationRecovered === true || entry.level === 'verified' ? 1000 : 0)
        - (entry.operationRecovered === false || entry.level === 'error' ? 500 : 0)
        + (8 - Math.max(1, Math.min(8, entry.operationStep || 8))) * 10
        + Math.min(9, entry.at / 1e13);
      return score(b) - score(a);
    }).slice(0, 8),
    activation: logsByCategory.activation.slice(0, 8),
    channel_error: logsByCategory.channel_error.slice(0, 8),
  };

  const handleResetMemory = async () => {
    setResetFeedback(false);
    const cloudReset = await resetTvDoctorAllToZero();
    /*
     * 2.5.392: a gomb után a KÉPERNYŐN is azonnal 0 legyen. Korábban a
     * `cloudRoutes` state az előző (még élő) felhő-pillanatképet tartotta,
     * ezért a dobozok 0-t, az útvonallista pedig továbbra is régi sorokat
     * mutatott – a TV és a Supabase látszólag nem egyezett.
     */
    setCloudRoutes([]);
    setResetVersion((n) => n + 1);
    setUiTick((n) => n + 1);
    const after = getTvDoctorChannelSnapshot(activeChannel, []);
    appLog(
      `TV DOKTOR NULLÁZÁS ELLENŐRZÉS: dobozok=(tanulás=${after.logsByCategory.learning.length}, `
      + `segítség=${after.logsByCategory.assistance.length}, aktiválódás=${after.logsByCategory.activation.length}, `
      + `csatornahiba=${after.logsByCategory.channel_error.length}); tanult_útvonalak=${after.routes.length}/${MAX_CHANNEL_ROUTES}; `
      + `helyi=${after.localRouteCount}; supabase_törlés=${cloudReset ? 'KÉSZ' : 'VÁRÓLISTÁN'}; `
      + `supabase_újraolvasás=indítva.`,
    );
    // Ne írjunk új TV Doktor naplósort a nullázás után: a felhasználó 0 naplósort kért.
    setResetFeedback(cloudReset);
    if (resetFeedbackTimerRef.current !== null) window.clearTimeout(resetFeedbackTimerRef.current);
    resetFeedbackTimerRef.current = window.setTimeout(() => {
      resetFeedbackTimerRef.current = null;
      setResetFeedback(false);
    }, 3500);
  };

  const scrollRightBy = (delta: number) => {
    const pane = rightScrollRef.current;
    if (!pane) return;
    const hasLayout = pane.scrollHeight > 0 || pane.clientHeight > 0;
    const maxScroll = hasLayout
      ? Math.max(0, pane.scrollHeight - pane.clientHeight)
      : Number.POSITIVE_INFINITY;
    const nextTop = Math.max(0, Math.min(maxScroll, pane.scrollTop + delta));
    pane.scrollTop = nextTop;
  };

  const scrollCategoryBy = (cat: DoctorEventCategory, delta: number) => {
    const pane = categoryScrollRefs.current[cat];
    if (!pane) return;
    const maxScroll = Math.max(0, pane.scrollHeight - pane.clientHeight);
    pane.scrollTop = Math.max(0, Math.min(maxScroll, pane.scrollTop + delta));
  };

  const getRightControls = (): HTMLButtonElement[] => {
    const list: HTMLButtonElement[] = [];
    if (resetBtnRef.current && !resetBtnRef.current.disabled) list.push(resetBtnRef.current);
    if (testBtnRef.current && !testBtnRef.current.disabled) list.push(testBtnRef.current);
    if (closeBtnRef.current && !closeBtnRef.current.disabled) list.push(closeBtnRef.current);
    return list;
  };

  
  const focusCategory = (cat: DoctorEventCategory) => {
    const el = categoryHeaderRefs.current[cat];
    if (el) el.focus();
  };

  const toggleCategory = (cat: DoctorEventCategory) => {
    // A kategóriadoboz OK/Enter vagy kattintás hatására mindig a külön naplóablakot nyitja meg.
    // A négy doboz nem nyílik ki helyben; a bezárás külön művelet (Esc/Bezárás).
    setExpanded({
      learning: false,
      assistance: false,
      activation: false,
      channel_error: false,
    });
    setLargeCat(cat);
  };

  const handleModalKeyDown = (e: KeyboardEvent | React.KeyboardEvent<HTMLDivElement>) => {
    // Large overlay: Esc closes, arrows/Page scroll inside, focus stays in overlay
    if (largeCat) {
      const rawEvt2 = 'nativeEvent' in e ? e.nativeEvent : e;
      const k2 = normalizeTvKey(rawEvt2 as KeyboardEvent);
      if (k2 === 'Escape' || k2 === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        const prevCat = largeCat;
        setLargeCat(null);
        setExpanded((prev) => ({ ...prev, [prevCat]: false }));
        const hdr = categoryHeaderRefs.current[prevCat];
        window.setTimeout(() => {
          try { hdr?.focus({ preventScroll: true } as FocusOptions); } catch { hdr?.focus(); }
        }, 10);
        return;
      }
      if (k2 === 'PageDown' || k2 === 'PageUp' || k2 === 'ArrowDown' || k2 === 'ArrowUp' || k2 === 'Home' || k2 === 'End') {
        const pane = largeScrollRef.current;
        if (pane) {
          e.preventDefault();
          e.stopPropagation();
          if (k2 === 'Home') { pane.scrollTop = 0; return; }
          if (k2 === 'End') { pane.scrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight); return; }
          const step = k2 === 'PageDown' || k2 === 'PageUp'
            ? (pane.clientHeight > 0 ? Math.max(140, Math.round(pane.clientHeight * 0.85)) : 260)
            : 96;
          const delta = (k2 === 'PageDown' || k2 === 'ArrowDown') ? step : -step;
          const maxScroll = Math.max(0, pane.scrollHeight - pane.clientHeight);
          pane.scrollTop = Math.max(0, Math.min(maxScroll, pane.scrollTop + delta));
          return;
        }
      }
      // Any other key when overlay open should not propagate to underlying
      if (k2 === 'Enter' || k2 === ' ' || k2 === 'NumpadEnter') {
        e.preventDefault(); e.stopPropagation();
        return;
      }
    }
    if (isZeroDigitKey(e)) {
      if (!(e as KeyboardEvent).repeat) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
      return;
    }

    const rawEvt = 'nativeEvent' in e ? e.nativeEvent : e;
    const key = normalizeTvKey(rawEvt);
    if (key === 'Escape' || key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }

    const active = document.activeElement as HTMLElement | null;
    const activeCat = (Object.keys(categoryHeaderRefs.current) as DoctorEventCategory[]).find(
      (cat) => categoryHeaderRefs.current[cat] === active
    );
    const isOnLeftHeader = Boolean(activeCat);
    const isInsideCategoryScroll = (Object.keys(categoryScrollRefs.current) as DoctorEventCategory[]).some(
      (cat) => {
        const pane = categoryScrollRefs.current[cat];
        return pane && active && (active === pane || pane.contains(active));
      }
    );
    const scrollCatForKeys = (Object.keys(categoryScrollRefs.current) as DoctorEventCategory[]).find(
      (cat) => {
        const pane = categoryScrollRefs.current[cat];
        return pane && expanded[cat] && pane.contains(active);
      }
    ) || (activeCat && expanded[activeCat] ? activeCat : null);

    const onRightPane = Boolean(
      active && rightScrollRef.current && (active === rightScrollRef.current || rightScrollRef.current.contains(active)),
    );
    const onCompatScroll = Boolean(active && compatLogScrollRef.current && active === compatLogScrollRef.current);

    // Compat wrapper – 2.5.322: bal oldal fixált, nem lapozható – Arrow/Page/Home/End nem görget
    if (onCompatScroll) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'PageDown' || key === 'PageUp' || key === 'Home' || key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (key === 'ArrowRight') {
        e.preventDefault(); e.stopPropagation();
        const rightControls = getRightControls();
        if (rightControls.length > 0) rightControls[0].focus();
        return;
      }
      if (key === 'ArrowLeft') {
        e.preventDefault(); e.stopPropagation();
        // stay on compat, or move to first header if needed
        return;
      }
    }

    // PageUp/PageDown handling
    if (key === 'PageDown' || key === 'PageUp') {
      e.preventDefault();
      e.stopPropagation();
      if (scrollCatForKeys) {
        const pane = categoryScrollRefs.current[scrollCatForKeys];
        const pageStep = pane && pane.clientHeight > 0 ? Math.max(140, Math.round(pane.clientHeight * 0.85)) : 260;
        scrollCategoryBy(scrollCatForKeys, key === 'PageDown' ? pageStep : -pageStep);
        return;
      }
      if (isOnLeftHeader && activeCat && expanded[activeCat]) {
        const pane = categoryScrollRefs.current[activeCat];
        const pageStep = pane && pane.clientHeight > 0 ? Math.max(140, Math.round(pane.clientHeight * 0.85)) : 260;
        scrollCategoryBy(activeCat, key === 'PageDown' ? pageStep : -pageStep);
        return;
      }
      if (onRightPane) {
        // 2.5.322: jobb oldal fixált, nem lapozható
        return;
      }
      // default: right pane – 2.5.322: nem lapozható
      return;
    }

    if (active === resetBtnRef.current && key === 'ArrowDown' && testBtnRef.current && !testBtnRef.current.disabled) {
      e.preventDefault();
      e.stopPropagation();
      testBtnRef.current.focus({ preventScroll: true } as FocusOptions);
      return;
    }

    if (onRightPane) {
      // 2.5.322: jobb oldal fixált – nem görget. Ha jobb gombon vagyunk, engedjük a jobb gombok közötti fókuszmozgást (lentebb).
      const rightControls = getRightControls();
      const isRightControl = active ? rightControls.includes(active as HTMLButtonElement) : false;
      if (!isRightControl && (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        const first = categoryHeaderRefs.current.learning;
        first?.focus();
        return;
      }
    }

    // Inside category scroll pane: arrows scroll
    if (isInsideCategoryScroll && scrollCatForKeys) {
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        scrollCategoryBy(scrollCatForKeys, key === 'ArrowDown' ? 96 : -96);
        return;
      }
      if (key === 'Home') {
        e.preventDefault();
        e.stopPropagation();
        const pane = categoryScrollRefs.current[scrollCatForKeys];
        if (pane) pane.scrollTop = 0;
        return;
      }
      if (key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        const pane = categoryScrollRefs.current[scrollCatForKeys];
        if (pane) pane.scrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight);
        return;
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        // stay inside? allow left to go to header
        if (key === 'ArrowLeft') {
          const hdr = categoryHeaderRefs.current[scrollCatForKeys];
          hdr?.focus();
        }
        return;
      }
    }

    // On left header: handle navigation between categories
    if (isOnLeftHeader && activeCat) {
      if (key === 'Enter' || key === ' ' || key === 'NumpadEnter') {
        e.preventDefault();
        e.stopPropagation();
        toggleCategory(activeCat);
        return;
      }
      if (key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        // 2x2 rács: learning (0,0) assistenza (0,1) / aktiválódás (1,0) hiba (1,1)
        const mapDown: Record<DoctorEventCategory, DoctorEventCategory> = {
          learning: 'activation',
          assistance: 'channel_error',
          activation: 'activation',
          channel_error: 'channel_error',
        };
        const nextCat = mapDown[activeCat];
        if (nextCat && nextCat !== activeCat) focusCategory(nextCat);
        return;
      }
      if (key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const mapUp: Record<DoctorEventCategory, DoctorEventCategory> = {
          learning: 'learning',
          assistance: 'assistance',
          activation: 'learning',
          channel_error: 'assistance',
        };
        const prevCat = mapUp[activeCat];
        if (prevCat && prevCat !== activeCat) focusCategory(prevCat);
        return;
      }
      if (key === 'ArrowRight') {
        if (activeCat === 'learning') {
          e.preventDefault(); e.stopPropagation(); focusCategory('assistance'); return;
        }
        if (activeCat === 'activation') {
          e.preventDefault(); e.stopPropagation(); focusCategory('channel_error'); return;
        }
        if (activeCat === 'assistance' || activeCat === 'channel_error') {
          const rightControls = getRightControls();
          if (rightControls.length > 0) {
            e.preventDefault(); e.stopPropagation(); rightControls[0].focus();
          }
          return;
        }
        return;
      }
      if (key === 'ArrowLeft') {
        if (activeCat === 'assistance') {
          e.preventDefault(); e.stopPropagation(); focusCategory('learning'); return;
        }
        if (activeCat === 'channel_error') {
          e.preventDefault(); e.stopPropagation(); focusCategory('activation'); return;
        }
        e.preventDefault(); e.stopPropagation();
        return;
      }
      if (key === 'Home') {
        e.preventDefault();
        e.stopPropagation();
        focusCategory('learning');
        return;
      }
      if (key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        focusCategory('channel_error');
        return;
      }
    }

    const rightControls = getRightControls();
    const curRightIdx = active ? rightControls.indexOf(active as HTMLButtonElement) : -1;
    if (curRightIdx >= 0) {
      if (key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        const target = categoryHeaderRefs.current.learning;
        target?.focus();
        return;
      }
      if (key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const next = rightControls[Math.min(rightControls.length - 1, curRightIdx + 1)];
        next?.focus({ preventScroll: true } as FocusOptions);
        return;
      }
      if (key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const prev = rightControls[Math.max(0, curRightIdx - 1)];
        prev?.focus({ preventScroll: true } as FocusOptions);
        return;
      }
    }

    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'ArrowLeft' || key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      const first = categoryHeaderRefs.current.learning;
      first?.focus();
    }
  };
  handleModalKeyDownRef.current = handleModalKeyDown;

  const renderCategoryBox = (cat: DoctorEventCategory, fullWidth: boolean) => {
    const vis = CATEGORY_BY_ID[cat];
    const logs = displayLogsByCategory[cat];
    const active = logs.length > 0;
    /*
     * A kategória-doboz statisztikája a megjelenített naplóbejegyzésekből
     * számol (2.5.381): a korábbi globális „stat” hivatkozás már nem létezett,
     * ezért a TV Doktor állapotablak (0-ás gomb) rendereléskor elszállt.
     */
    const stat = (() => {
      let latest: DoctorLogEntry | null = null;
      for (const entry of logs) {
        if (!latest || entry.at > latest.at) latest = entry;
      }
      return {
        count: logs.length,
        lastAt: latest ? latest.at : null,
        lastChannelName: latest ? (latest.channelName || '') : '',
      };
    })();
    const IconComp = vis.Icon;
    const isExpanded = largeCat === cat; // overlay open state
    const totalForBadge = logs.length;
    const showingText = cat === 'learning' ? `${logs.length} db` : `${logs.length} / 8 db`;
    return (
      <div
        key={cat}
        ref={(el) => { categoryHeaderRefs.current[cat] = el; }}
        tabIndex={0}
        role="button"
        aria-expanded={isExpanded}
        aria-label={`${vis.title} ${isExpanded ? 'bezárás' : 'megnyitás'} – ${totalForBadge} db, Enterrel nyitható – nagy ablakban olvasható`}
        data-tv-doctor-cat={cat}
        data-cat-active={active ? 'true' : 'false'}
        data-cat-count={stat.count}
        onClick={() => toggleCategory(cat)}
        className={`relative rounded-xl border-2 px-3.5 py-2.5 transition-none focus:outline-none focus:ring-4 focus:ring-amber-400 cursor-pointer select-none ${
          active ? `${vis.cardBorder} ${vis.cardBg}` : 'border-slate-700/70 bg-slate-900/50 opacity-90'
        } ${fullWidth ? '' : ''}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`h-3 w-3 rounded-full shrink-0 ${active ? vis.dotClass : 'bg-slate-500'}`} />
            <IconComp className={`h-5 w-5 shrink-0 ${vis.titleColor}`} />
            <span className={`text-base lg:text-lg font-black truncate ${vis.titleColor}`}>
              {vis.title}
            </span>
            <span className="text-sm font-bold text-slate-300 ml-1">
              {isExpanded ? '▲' : '▼'}
            </span>
          </div>
          <span
            data-tv-doctor-cat-count={cat}
            className={`inline-flex items-center rounded-lg border px-2.5 py-0.5 font-mono text-sm lg:text-base font-black shrink-0 ${vis.countBadge}`}
          >
            {showingText}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-sm font-bold text-slate-200">
          <span className="truncate">
            {stat.lastAt !== null
              ? `Mikor: ${formatLogClock(stat.lastAt)}${stat.lastChannelName ? ` • ${stat.lastChannelName}` : ''}`
              : vis.subtitle}
          </span>
        </div>
      </div>
    );
  };

  const modal = (
    <div
      data-tv-doctor-modal=""
      role="dialog"
      aria-modal="true"
      aria-label="TV Doktor állapot és napló"
      style={{ zIndex: TV_DOCTOR_MODAL_Z_INDEX }}
      className={`fixed inset-0 flex items-center justify-center p-3 sm:p-5 select-none ${isFullscreen ? 'bg-transparent' : 'bg-black/88'}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalCardRef}
        data-tv-navigation-owner="tv-doctor"
        tabIndex={-1}
        onKeyDown={handleModalKeyDown}
        className="w-full max-w-[1760px] h-[92vh] max-h-[980px] rounded-3xl border-2 border-cyan-400/70 bg-[#061022] shadow-2xl overflow-hidden flex flex-col focus:outline-none"
      >
        {/* Felső 2 oszlop: bal oldali 4 doboz + jobb oldali infók */}
        <div className="flex-1 min-h-0 grid grid-cols-1 sm:grid-cols-2 overflow-hidden">
          {/* ================= BAL OLDAL: 4 NYITHATÓ DOBOZ (TANULÁS, SEGÍTSÉG, AKTIVÁLÓDÁS, HIBA) ================= */}
          <section
            ref={leftPaneRef}
            data-tv-doctor-left-pane=""
            tabIndex={-1}
            className="flex flex-col min-h-0 h-full overflow-hidden border-b-2 sm:border-b-0 sm:border-r-2 border-cyan-500/40 bg-[#050d1d] p-4 lg:p-5 gap-3 outline-none focus:outline-none"
            style={{ outline: 'none' }}
          >
            <div className="shrink-0 flex items-center justify-between gap-3">
              <h2 className="text-lg lg:text-xl font-black uppercase tracking-wide text-cyan-300">
                TV Doktor napló (kategóriák)
              </h2>
              {/* teszt kompatibilitás: log-count megmarad DOM-ban, de vizuálisan rejtett a felhasználó kérésére */}
              <span
                data-tv-doctor-log-count=""
                className="sr-only"
              >
                {orderedLogs.length} sor
              </span>
            </div>

            {/* Kompatibilis wrapper a tesztekhez (data-tv-doctor-log-scroll) – 2.5.321: FIXÁLT, NEM LAPOZHATÓ – a bal oldal rögzítve, nem mozog lefelé */}
            <div
              ref={compatLogScrollRef}
              data-tv-scroll-pane=""
              data-tv-doctor-log-scroll=""
              tabIndex={-1}
              role="region"
              aria-label="TV Doktor napló – rögzített"
              className="flex-1 min-h-0 overflow-hidden rounded-xl focus:outline-none p-1 -m-1 flex flex-col gap-2 outline-none"
              style={{ scrollBehavior: 'auto', outline: 'none' }}
            >
              {/* 1. vízszintes sor: Tanulás | Segítség/Javítás */}
              <div className="grid grid-cols-2 gap-3 items-start">
                {renderCategoryBox('learning', false)}
                {renderCategoryBox('assistance', false)}
              </div>

              {/* 2. vízszintes sor: Aktiválódás | Hiba csatornánál */}
              <div className="grid grid-cols-2 gap-3 items-start">
                {renderCategoryBox('activation', false)}
                {renderCategoryBox('channel_error', false)}
              </div>

              {/* Tanult útvonalak (max. 8) – 2.5.321: FIXÁLT, NEM LAPOZHATÓ – zöld doboz végig leér, 8 doboz egy képernyőn, nincs görgetés */}
              <div
                data-tv-doctor-routes=""
                className="flex-1 min-h-0 flex flex-col rounded-2xl border-2 border-emerald-600/60 bg-[#04121c] p-2.5 gap-2 mt-1 overflow-hidden"
              >
                <div className="flex items-center justify-between gap-2 shrink-0">
                  <span className="flex items-center gap-2 text-base lg:text-lg font-black text-emerald-200">
                    <Activity className="h-5 w-5 shrink-0 text-emerald-300" />
                    <span>Tanult útvonalak (max. 8){activeChannel ? ` — ${activeChannel.name}` : ''}</span>
                  </span>
                  <span
                    data-tv-doctor-routes-count=""
                    className="inline-flex items-center rounded-lg border border-emerald-400/60 bg-emerald-500/20 px-2.5 py-1 font-mono text-sm lg:text-base font-black text-emerald-100"
                  >
                    {activeRoutes.length} / {MAX_CHANNEL_ROUTES}
                  </span>
                </div>
                <p className="text-xs lg:text-sm font-bold text-emerald-300/90 text-center -mt-1 shrink-0">Helyi tanulás + Supabase, egy pillanatképből — {channelSnapshot.localRouteCount} helyi / {channelSnapshot.cloudRouteCount} felhő</p>
                <div data-tv-doctor-routes-list="" className="flex-1 min-h-0 flex flex-col gap-1.5 overflow-hidden">
                  {Array.from({ length: MAX_CHANNEL_ROUTES }, (_, idx) => {
                    const route = activeRoutes[idx] || null;
                    if (!route) {
                      return (
                        <div
                          key={`empty-${idx}`}
                          data-tv-doctor-route-empty={`${idx + 1}`}
                          className="flex-1 min-h-[42px] lg:min-h-[46px] flex flex-row items-center justify-between rounded-xl border border-slate-700/50 bg-slate-900/35 px-3 py-2 gap-2 overflow-hidden"
                        >
                          <span className="font-mono text-sm md:text-base lg:text-[15px] font-black tracking-wide text-slate-600 shrink-0">
                            {idx + 1}.
                          </span>
                          <span className="text-xs md:text-sm lg:text-sm font-bold text-slate-600 text-right truncate">
                            {cloudRoutes === null && idx === 0 ? 'Supabase-adatok betöltése…' : '—'}
                          </span>
                        </div>
                      );
                    }
                    const isBest = idx === 0;
                    return (
                      <div
                        key={route.id}
                        data-tv-doctor-route={route.id}
                        className={`flex-1 min-h-[42px] lg:min-h-[46px] flex flex-row items-center justify-between rounded-xl border-2 px-3 py-2 gap-2 overflow-hidden ${
                          isBest
                            ? 'border-emerald-400/80 bg-emerald-500/20 shadow-[0_0_12px_rgba(16,185,129,0.35)]'
                            : 'border-slate-600/60 bg-slate-800/70'
                        }`}
                      >
                        <span className={`font-mono text-sm md:text-base lg:text-[15px] font-black tracking-wide leading-tight shrink-0 ${isBest ? 'text-emerald-100' : 'text-slate-100'}`}>
                          {isBest ? '★ ' : `${idx + 1}. `}{safeDoctorFormat(route.format)} + {safeDoctorBufferLabel(route.bufferProfile)}
                        </span>
                        <span className={`font-mono text-xs md:text-sm lg:text-sm font-bold leading-tight text-right truncate ${isBest ? 'text-emerald-200/90' : 'text-slate-300'}`}>
                          {typeof route.avgStartupMs === 'number' && Number.isFinite(route.avgStartupMs) && route.avgStartupMs > 0 ? `${Math.round(route.avgStartupMs)}ms` : 'Nincs mérési adat'} • {route.ok} ok / {route.fail} hiba{route.stalls ? ` • ${route.stalls} akadás` : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          {/* ================= JOBB OLDAL: BEÁLLÍTÁSOK + ÁLLAPOTOK — 2.5.322: FIXÁLT, NEM LAPOZHATÓ – Supabase Teszt-en nem mozog */}
          <section
            ref={rightScrollRef}
            data-tv-doctor-right-pane=""
            data-tv-doctor-right-scroll=""
            className="flex flex-col min-h-0 h-full overflow-hidden bg-[#08152d] p-5 lg:p-6 gap-3.5"
          >
            {/* Felső fejléc: ikon + cím + élő csatorna, jobb sarokban Memória:0 */}
            <div className="flex items-start justify-between gap-4 shrink-0">
              <div className="flex min-w-0 items-start gap-3.5">
                <span data-tv-doctor-modal-icon="" className="shrink-0">
                  <TvDoctorIcon
                    handled={tvDoctorEnabled && (activeChannelHandled || doctorMem.learnedChannelCount > 0)}
                    disabled={!tvDoctorEnabled}
                    className="h-14 w-14 mt-0.5"
                  />
                </span>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h2 className="text-2xl lg:text-3xl font-black text-white leading-tight">TV Doktor állapot</h2>
                    <span
                      data-tv-doctor-modal-badge=""
                      className={`inline-flex items-center rounded-xl border px-3 py-1 text-sm lg:text-base font-black uppercase tracking-wide ${overallBadgeClass}`}
                    >
                      {overallBadgeText}
                    </span>
                  </div>
                  <p className="text-base lg:text-lg font-bold text-cyan-200 truncate">
                    {activeChannel
                      ? `Élő adás: ${activeChannel.name}${activeChannelHandled ? ' • Tanult gyorsprofil aktív' : ' • Automatikus védelem'}`
                      : 'Élő TV felügyelet aktív'}
                  </p>
                </div>
              </div>

              <div className="shrink-0 flex flex-col items-end gap-2">
                <button
                  ref={resetBtnRef}
                  type="button"
                  data-tv-doctor-reset=""
                  aria-label="TV Doktor memória nullázása 0 állapotra"
                  title="Tanult csatornák, napló és szinkron-várólista visszaállítása 0 állapotra"
                  onClick={handleResetMemory}
                  className={`inline-flex items-center gap-2 rounded-2xl border-2 px-4 py-2.5 text-base lg:text-lg font-black shadow-lg focus:outline-none focus:ring-4 focus:ring-amber-400 ${
                    resetFeedback
                      ? 'border-emerald-400 bg-emerald-600/35 text-emerald-100'
                      : 'border-rose-500 bg-rose-950/90 text-rose-100 hover:bg-rose-900'
                  }`}
                >
                  <RotateCcw className="h-5 w-5 shrink-0" />
                  <span>{resetFeedback ? '0-ra állítva ✓' : 'Memória: 0'}</span>
                </button>
                <button
                  ref={testBtnRef}
                  type="button"
                  data-tv-doctor-check-cloud=""
                  disabled={doctorCloud.checking || doctorCloud.syncing}
                  onClick={() => {
                    logTvDoctorPanel('Supabase kapcsolatteszt indítva', { csatorna: activeChannel?.name || 'nincs' });
                    void checkTvDoctorConnection()
                      .then((status) => {
                        logTvDoctorPanel('Supabase kapcsolatteszt eredménye', {
                          állapot: status.connectionState,
                          késleltetés: status.latencyMs ?? 'nincs adat',
                          párosítva: status.paired ? 'igen' : 'nem',
                        });
                      })
                      .catch(() => {
                        logTvDoctorPanel('Supabase kapcsolatteszt hiba miatt leállt');
                      });
                  }}
                  className="inline-flex items-center gap-2 rounded-xl border-2 border-cyan-400/60 bg-cyan-500/20 px-4 py-1.5 text-base lg:text-lg font-black text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-50 focus:outline-none focus:ring-4 focus:ring-amber-400"
                >
                  <RefreshCw className={`h-5 w-5 ${doctorCloud.checking || doctorCloud.syncing ? 'animate-spin' : ''}`} />
                  <span>Supabase: Teszt</span>
                </button>
              </div>
            </div>

            {/* 2. Supabase kapcsolat */}
            <div data-tv-doctor-supabase="" className="rounded-2xl border border-cyan-800/60 bg-[#051024] p-4 space-y-2">
              <div className="flex items-center gap-2.5 text-lg lg:text-xl font-black text-white">
                {doctorCloud.connected ? <Wifi className="h-6 w-6 shrink-0 text-emerald-400" /> : <WifiOff className="h-6 w-6 shrink-0 text-amber-300" />}
                <span>Supabase kapcsolat</span>
              </div>
              <p
                className={`text-base lg:text-lg font-black leading-snug ${
                  doctorCloud.connected
                    ? 'text-emerald-300'
                    : !pairingInfo.paired
                      ? 'text-amber-300'
                      : doctorCloud.checking || doctorCloud.syncing
                        ? 'text-cyan-300'
                        : doctorCloud.connectionState === 'error'
                          ? 'text-rose-300'
                          : 'text-amber-300'
                }`}
              >
                {!pairingInfo.paired
                  ? 'Nincs párosítva (csak helyi memória aktív)'
                  : doctorCloud.checking || doctorCloud.syncing
                    ? 'Kapcsolat ellenőrzése folyamatban…'
                    : doctorCloud.connected
                      ? `Létrejött ✓${doctorCloud.latencyMs !== null ? ` (${doctorCloud.latencyMs} ms)` : ''}`
                      : doctorCloud.connectionState === 'offline'
                        ? 'Nem jött létre – a TV offline'
                        : doctorCloud.connectionState === 'error'
                          ? 'Nem jött létre – kapcsolati hiba'
                          : 'Párosítva – ellenőrzésre kész'}
              </p>
              <div className="space-y-1 text-base lg:text-lg text-slate-200">
                <div>
                  Eszköz: <strong className="font-mono text-white font-black">{pairingInfo.deviceId}</strong>
                </div>
                <div>
                  Központi profilok: <strong className="text-white font-black">{doctorCloud.cloudProfileCount} db</strong> • Várólista:{' '}
                  <strong className="text-white font-black">{doctorCloud.pendingCount} elem</strong>
                </div>
                <div className="truncate" title={lastSyncText}>
                  Utolsó szinkron: <strong className="text-white font-black">{lastSyncText}</strong>
                </div>
              </div>
            </div>

            {/* Működési állapot (EPG nélkül) */}
            <div data-tv-doctor-health="" className="rounded-2xl border border-cyan-800/60 bg-[#051024] p-4 space-y-2">
              <div className="flex items-center gap-2.5 text-lg lg:text-xl font-black text-white">
                <CheckCircle2 className={`h-6 w-6 shrink-0 ${!tvDoctorEnabled ? 'text-slate-400' : hasAnyIssue ? 'text-amber-300' : 'text-emerald-400'}`} />
                <span>Működési állapot</span>
              </div>
              {/* 2.5.320: „Jól működik minden – gyors csatornaváltás aktív.” törölve — jobb oldal összébb, nem kell lapozni */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-4 gap-y-1.5 pt-1 text-base lg:text-lg text-slate-200">
                <div>
                  Tanult magyar csatornák: <strong className="text-white font-black">{doctorMem.learnedChannelCount} / {doctorMem.maxLearnedChannels}</strong>
                </div>
                <div>
                  Sikeres javítások: <strong className="text-white font-black">{doctorSummary.totalVerifiedRepairs} db</strong>
                </div>
                <div>
                  Sebesség:{' '}
                  <strong className="text-white font-black">
                    {doctorOp.lastSlowOp ? `Lassulás (${doctorOp.lastSlowOp.elapsedMs} ms)` : 'Villámgyors'}
                  </strong>
                </div>
                <div>
                  Memória állapot: <strong className="text-white font-black">{doctorMem.memoryHealth === 'optimal' ? 'Optimális' : doctorMem.memoryHealth === 'moderate' ? 'Mérsékelt' : 'Magas'}</strong>
                </div>
              </div>
              {/* 2.5.320: „Minden szám valós … (2.5.311)” zöld sor törölve — jobb oldal összébb */}
            </div>

            {/* Hibajelzés vagy Minden rendben */}
            {hasCloudError || hasStorageError ? (
              <div data-tv-doctor-error-box="" role="alert" className="rounded-2xl border-2 border-rose-500/65 bg-rose-950/55 p-4 space-y-1.5">
                <div className="flex items-center gap-2.5 text-lg lg:text-xl font-black text-rose-200">
                  <AlertTriangle className="h-6 w-6 shrink-0 text-rose-400" />
                  <span>Hiba részletei a javításhoz</span>
                </div>
                {hasCloudError && (
                  <div className="text-base lg:text-lg text-slate-100 leading-snug space-y-1">
                    <div>
                      <span className="text-rose-300 font-bold">Hol a hiba:</span> <strong>{doctorCloud.lastErrorLocation || 'Supabase kapcsolat'}</strong>
                      {doctorCloud.lastErrorCode ? ` (${doctorCloud.lastErrorCode})` : ''}
                    </div>
                    <div>
                      <span className="text-rose-300 font-bold">Mi a hiba:</span> <span>{doctorCloud.lastErrorSummary}</span>
                    </div>
                  </div>
                )}
                {hasStorageError && doctorMem.lastStorageError && (
                  <div className="text-base lg:text-lg text-slate-100 leading-snug space-y-1">
                    <div>
                      <span className="text-rose-300 font-bold">Hol a hiba:</span> <strong>{doctorMem.lastStorageError.location}</strong>
                    </div>
                    <div>
                      <span className="text-rose-300 font-bold">Mi a hiba:</span> <span>{doctorMem.lastStorageError.message}</span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div data-tv-doctor-ok-banner="" className="rounded-2xl border border-emerald-500/45 bg-emerald-950/40 px-4 py-3 text-base lg:text-lg font-bold text-emerald-200">
                {doctorCloud.connected
                  ? '✓ Minden rendben: a védett Supabase kapcsolat aktív, nincs hálózati vagy memóriahiba.'
                  : '✓ Helyi TV Doktor hibátlanul üzemel, nincs tárolási vagy lejátszási hiba.'}
              </div>
            )}

            {/* Memória és TV memóriahasználat (1 MB keret) */}
            <div data-tv-doctor-memory="" className="rounded-2xl border border-cyan-800/60 bg-[#051024] p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2.5 text-lg lg:text-xl font-black text-white">
                  <Database className="h-6 w-6 shrink-0 text-cyan-300" />
                  <span>Memória és TV memóriahasználat (1 MB keret)</span>
                </span>
                <span
                  className={`text-base lg:text-lg font-black ${
                    doctorMem.memoryHealth === 'high'
                      ? 'text-rose-300'
                      : doctorMem.memoryHealth === 'moderate'
                        ? 'text-amber-300'
                        : 'text-emerald-300'
                  }`}
                >
                  {doctorMem.doctorBudgetPercent}% keret
                </span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full rounded-full ${doctorMem.memoryHealth === 'high' ? 'bg-rose-400' : doctorMem.memoryHealth === 'moderate' ? 'bg-amber-400' : 'bg-cyan-400'}`}
                  style={{ width: `${Math.max(doctorMem.doctorTotalBytes > 0 ? 2 : 0, Math.min(100, doctorMem.doctorBudgetPercent))}%` }}
                />
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-4 gap-y-1.5 text-base lg:text-lg text-slate-200">
                <div>
                  TV Doktor memória: <strong className="text-white font-black">{formatDoctorBytes(doctorMem.doctorTotalBytes)} / {formatDoctorBytes(doctorMem.maxSafeDoctorBytes)}</strong>
                </div>
                <div>
                  TV tárhely összesen: <strong className="text-white font-black">{formatDoctorBytes(doctorMem.tvStorageUsedBytes)} / ~5.0 MB ({doctorMem.tvStoragePercent}%)</strong>
                </div>
                <div>
                  Bontás: <span className="text-slate-300 font-semibold">profilok {formatDoctorBytes(doctorMem.doctorStoreBytes)}, várólista {formatDoctorBytes(doctorMem.cloudQueueBytes)}</span>
                </div>
                <div>
                  TV munkamemória (RAM):{' '}
                  <strong className="text-white font-black">
                    {doctorMem.jsHeapUsedMB !== null ? `${doctorMem.jsHeapUsedMB} MB${doctorMem.jsHeapLimitMB ? ` / ${doctorMem.jsHeapLimitMB} MB` : ''}` : 'webOS automatikus'}
                  </strong>
                </div>
              </div>
              {/* 2.5.320: „Optimális (1 MB keret) …” sor törölve — jobb oldal összébb, nem kell lapozni */}
            </div>
          </section>
        </div>

        {/* Nagy ablak a 4 dobozhoz – ha rákattintasz, itt jelenik meg a legfeljebb 8 legjobb művelet, lapozható */}
        {largeCat && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4"
            onClick={() => {
              const cat = largeCat;
              setLargeCat(null);
              setExpanded((prev) => ({ ...prev, [cat]: false }));
            }}
          >
            <div
              className="w-[96vw] max-w-[1250px] h-[88vh] max-h-[900px] rounded-xl border-2 border-cyan-400/60 bg-[#061022] shadow-2xl flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="shrink-0 flex items-center justify-between gap-3 border-b border-slate-700/60 bg-[#08152d] px-4 py-3">
                <div className="flex items-center gap-2 min-w-0">
                  {(() => {
                    const vis = CATEGORY_BY_ID[largeCat];
                    const IconComp = vis.Icon;
                    return (
                      <>
                        <IconComp className={`h-6 w-6 shrink-0 ${vis.titleColor}`} />
                        <span className={`text-lg font-black truncate ${vis.titleColor}`}>{vis.title}</span>
                        <span className={`ml-1 rounded-lg border px-2 py-0.5 font-mono text-xs font-black ${vis.countBadge}`}>
                          {displayLogsByCategory[largeCat].length} / 8 db
                        </span>
                      </>
                    );
                  })()}
                </div>
              </div>
              <div
                ref={largeScrollRef}
                tabIndex={0}
                role="region"
                aria-label={`${CATEGORY_BY_ID[largeCat].title} nagy naplólista`}
                data-tv-doctor-cat-logs={largeCat}
                data-tv-doctor-cat-logs-large={largeCat}
                className="flex-1 min-h-0 overflow-y-auto p-4 focus:outline-none"
              >
                {displayLogsByCategory[largeCat].length === 0 ? (
                  <div className="py-10 text-center text-slate-300 font-bold text-lg">
                    Nincs rögzített {CATEGORY_BY_ID[largeCat].title.toLowerCase()} esemény.
                  </div>
                ) : (
                  <div className="grid min-h-full grid-flow-col grid-rows-[repeat(4,minmax(150px,1fr))] grid-cols-2 gap-3">
                    {displayLogsByCategory[largeCat].map((entry, idx) => {
                      const vis = CATEGORY_BY_ID[largeCat];
                      return (
                        <div
                          key={`${entry.at}-${idx}`}
                          data-tv-doctor-log-item=""
                          data-log-category={largeCat}
                          className={`min-h-0 rounded-lg border p-3 space-y-1.5 overflow-y-auto ${vis.logBorder}`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="min-w-0 text-base lg:text-lg font-black text-white break-words">{entry.channelName}</span>
                            <span className="font-mono text-sm font-bold text-slate-200 shrink-0">{formatLogClock(entry.at)}</span>
                          </div>
                          <p className="text-base lg:text-lg font-semibold text-slate-100 leading-snug break-words whitespace-normal">{entry.message}</p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Alsó sáv – a felhasználó kérésére üresen hagyva, a Tanult útvonalak már bal oldalon, 4+4 elrendezésben */}
        <div data-tv-doctor-routes-bottom="" className="hidden" aria-hidden="true" />
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
};
