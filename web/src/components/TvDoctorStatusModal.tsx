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
import { dateTimeText } from '../services/appLog';
import {
  DoctorEventCategory,
  DoctorLogEntry,
  MAX_CHANNEL_ROUTES,
  formatDoctorBytes,
  getChannelDoctorRecord,
  getTvDoctorMemoryStats,
  getTvDoctorOperationHealth,
  getTvDoctorSummary,
  isChannelHandledByDoctor,
  logTvDoctorPanel,
  rankDoctorRouteList,
  subscribeTvDoctorUpdates,
} from '../services/tvDoctor';
import {
  checkTvDoctorConnection,
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

function resolveEntryCategory(entry: DoctorLogEntry): DoctorEventCategory {
  if (entry.category && CATEGORY_BY_ID[entry.category]) return entry.category;
  if (entry.level === 'error') return 'channel_error';
  if (entry.level === 'warn') return 'activation';
  if (entry.level === 'repair' || entry.level === 'verified') return 'assistance';
  return 'learning';
}

function safeDoctorFormat(format: unknown): string {
  const value = typeof format === 'string' ? format.trim() : '';
  return value ? value.toUpperCase() : 'ISMERETLEN';
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
    if (!isOpen) return undefined;
    const record = activeChannel ? getChannelDoctorRecord(activeChannel) : null;
    const routes = record ? rankDoctorRouteList(record.routes || []) : [];
    logTvDoctorPanel('megnyitva (0 gomb)', {
      csatorna: activeChannel?.name || 'nincs',
      ország: activeChannel?.countryCode || 'nincs',
      tanultÚtvonalak: routes.length,
      legjobb: routes[0] ? `${safeDoctorFormat(routes[0].format)}+${routes[0].bufferProfile}` : 'még nincs',
      mód: settings.tvDoctorEnabled === false ? 'kikapcsolva' : 'aktív',
    });
    return () => {
      logTvDoctorPanel('bezárva', {
        csatorna: activeChannel?.name || 'nincs',
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setResetFeedback(false);
      setLargeCat(null);
      if (resetFeedbackTimerRef.current !== null) {
        window.clearTimeout(resetFeedbackTimerRef.current);
        resetFeedbackTimerRef.current = null;
      }
      return undefined;
    }

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void checkTvDoctorConnection();

    const focusTimer = window.setTimeout(() => {
      if (largeCat && largeScrollRef.current) {
        try { largeScrollRef.current.focus({ preventScroll: true } as FocusOptions); } catch { largeScrollRef.current.focus(); }
        return;
      }
      // 2.5.310: fókusz mindig a bal felső Tanulás dobozon legyen, ne a teljes bal panełen (fehér kijelölés javítása)
      const first = categoryHeaderRefs.current.learning;
      if (first) {
        try { first.focus({ preventScroll: true } as FocusOptions); } catch { first.focus(); }
        return;
      }
      // fallback: compat wrapper csak ha a Tanulás doboz még nem elérhető (pl. animáció közben)
      const compat = compatLogScrollRef.current;
      if (compat) {
        try { compat.focus({ preventScroll: true } as FocusOptions); } catch { compat.focus(); }
        return;
      }
      if (leftPaneRef.current) {
        try { leftPaneRef.current.focus({ preventScroll: true } as FocusOptions); } catch { leftPaneRef.current.focus(); }
      }
    }, 0);

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
  const categoryStats = doctorSummary.categoryStats;

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

  const orderedLogs = [...doctorSummary.recentLogs].reverse();
  const activeChannelHandled = Boolean(activeChannel && tvDoctorEnabled && isChannelHandledByDoctor(activeChannel));
  const activeRecord = tvDoctorEnabled && activeChannel ? getChannelDoctorRecord(activeChannel) : null;
  const activeRoutes = activeRecord ? rankDoctorRouteList(activeRecord.routes || []) : [];

  // Filtered per category: Tanulás shows ALL, others last 15
  const logsByCategory: Record<DoctorEventCategory, DoctorLogEntry[]> = {
    learning: [],
    assistance: [],
    activation: [],
    channel_error: [],
  };
  for (const entry of orderedLogs) {
    const cat = resolveEntryCategory(entry);
    if (cat in logsByCategory) logsByCategory[cat].push(entry);
  }
  const displayLogsByCategory: Record<DoctorEventCategory, DoctorLogEntry[]> = {
    learning: logsByCategory.learning, // ALL (up to 48, but only learning)
    assistance: logsByCategory.assistance.slice(0, 15),
    activation: logsByCategory.activation.slice(0, 15),
    channel_error: logsByCategory.channel_error.slice(0, 15),
  };

  const handleResetMemory = () => {
    const beforeStats = getTvDoctorMemoryStats();
    const beforeSummary = getTvDoctorSummary();
    resetTvDoctorAllToZero();
    logTvDoctorPanel('memória 0 állapotra állítva', {
      tanultCsatornákElőtte: beforeSummary.learnedChannelCount,
      memóriaElőtte: formatDoctorBytes(beforeStats.doctorTotalBytes),
    });
    setResetFeedback(true);
    if (resetFeedbackTimerRef.current !== null) {
      window.clearTimeout(resetFeedbackTimerRef.current);
    }
    resetFeedbackTimerRef.current = window.setTimeout(() => {
      resetFeedbackTimerRef.current = null;
      setResetFeedback(false);
    }, 2500);
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
    // For user: open large overlay window instead of inline expansion
    // Keep expanded for test compat but primary is largeCat
    setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));
    setLargeCat((prev) => (prev === cat ? null : cat));
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

    // Compat wrapper (single logScroll) – for legacy test: ArrowDown/Up scrolls, PageUp/PageDown, ArrowRight to reset
    if (onCompatScroll) {
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const pane = compatLogScrollRef.current;
        if (pane) {
          const step = 120;
          const hasLayout = pane.scrollHeight > 0 || pane.clientHeight > 0;
          const maxScroll = hasLayout ? Math.max(0, pane.scrollHeight - pane.clientHeight) : Number.POSITIVE_INFINITY;
          pane.scrollTop = Math.max(0, Math.min(maxScroll, pane.scrollTop + (key === 'ArrowDown' ? step : -step)));
        }
        return;
      }
      if (key === 'PageDown' || key === 'PageUp') {
        e.preventDefault();
        e.stopPropagation();
        const pane = compatLogScrollRef.current;
        if (pane) {
          const pageStep = pane.clientHeight > 0 ? Math.max(140, Math.round(pane.clientHeight * 0.85)) : 260;
          const maxScroll = Math.max(0, pane.scrollHeight - pane.clientHeight);
          pane.scrollTop = Math.max(0, Math.min(maxScroll, pane.scrollTop + (key === 'PageDown' ? pageStep : -pageStep)));
        }
        return;
      }
      if (key === 'Home') {
        e.preventDefault(); e.stopPropagation();
        if (compatLogScrollRef.current) compatLogScrollRef.current.scrollTop = 0;
        return;
      }
      if (key === 'End') {
        e.preventDefault(); e.stopPropagation();
        const pane = compatLogScrollRef.current;
        if (pane) pane.scrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight);
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
        const pane = rightScrollRef.current;
        const pageStep = pane && pane.clientHeight > 0 ? Math.max(180, Math.round(pane.clientHeight * 0.75)) : 320;
        scrollRightBy(key === 'PageDown' ? pageStep : -pageStep);
        return;
      }
      // default: right pane
      const pane = rightScrollRef.current;
      if (pane) {
        const pageStep = pane.clientHeight > 0 ? Math.max(180, Math.round(pane.clientHeight * 0.75)) : 320;
        scrollRightBy(key === 'PageDown' ? pageStep : -pageStep);
      }
      return;
    }

    if (active === resetBtnRef.current && key === 'ArrowDown' && testBtnRef.current && !testBtnRef.current.disabled) {
      e.preventDefault();
      e.stopPropagation();
      testBtnRef.current.focus({ preventScroll: true } as FocusOptions);
      return;
    }

    if (onRightPane) {
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const step = 120;
        scrollRightBy(key === 'ArrowDown' ? step : -step);
        return;
      }
      if (key === 'Home') {
        e.preventDefault();
        e.stopPropagation();
        if (rightScrollRef.current) rightScrollRef.current.scrollTop = 0;
        return;
      }
      if (key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        if (rightScrollRef.current) {
          rightScrollRef.current.scrollTop = Math.max(0, rightScrollRef.current.scrollHeight - rightScrollRef.current.clientHeight);
        }
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
    const stat = categoryStats[cat];
    const active = stat.count > 0;
    const IconComp = vis.Icon;
    const isExpanded = largeCat === cat; // overlay open state
    const logs = displayLogsByCategory[cat];
    const totalForBadge = stat.count; // persisted count
    const showingText = cat === 'learning' ? `${logs.length} db` : `${logs.length} / 15 db`;
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
        onKeyDown={(e) => {
          const k = normalizeTvKey(e.nativeEvent as KeyboardEvent);
          if (k === 'Enter' || k === ' ' || k === 'NumpadEnter') {
            e.preventDefault();
            e.stopPropagation();
            toggleCategory(cat);
          }
        }}
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
        <div className="text-xs font-bold text-slate-400 mt-1">
          OK / Enter: nagy ablak • {cat === 'learning' ? 'minden bejegyzés' : '15 legfrissebb'} • lapozható
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
            className="flex flex-col min-h-0 h-full overflow-hidden border-b-2 sm:border-b-0 sm:border-r-2 border-cyan-500/40 bg-[#050d1d] p-4 lg:p-5 gap-3"
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

            {/* Kompatibilis görgethető wrapper a tesztekhez (data-tv-doctor-log-scroll) – tartalmazza a 4 kategória-dobozt */}
            <div
              ref={compatLogScrollRef}
              data-tv-default=""
              data-tv-open-focus=""
              data-tv-scroll-pane=""
              data-tv-doctor-log-scroll=""
              tabIndex={0}
              role="region"
              aria-label="Legutóbbi TV Doktor napló – görgethető (kompatibilis)"
              className="flex-1 min-h-0 overflow-y-auto rounded-xl focus:outline-none p-1 -m-1 flex flex-col gap-3"
              style={{ scrollBehavior: 'auto' }}
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

              {/* Tanult útvonalak (max. 8) – közvetlenül a 4 doboz alatt, csak bal oldalon, 4+4 elrendezés */}
              <div
                data-tv-doctor-routes=""
                className="shrink-0 rounded-2xl border border-emerald-700/50 bg-[#04121c] p-3 space-y-2 mt-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-base font-black text-emerald-200">
                    <Activity className="h-5 w-5 shrink-0 text-emerald-300" />
                    <span>Tanult útvonalak (max. 8)</span>
                  </span>
                  <span
                    data-tv-doctor-routes-count=""
                    className="inline-flex items-center rounded-lg border border-emerald-400/60 bg-emerald-500/20 px-2 py-0.5 font-mono text-xs font-black text-emerald-100"
                  >
                    {activeRoutes.length} / {MAX_CHANNEL_ROUTES}
                  </span>
                </div>
                {activeRoutes.length === 0 ? (
                  <p className="text-sm font-bold text-slate-300">
                    {activeChannel ? `${activeChannel.name}: még nincs tanult útvonal.` : 'Nincs kiválasztott élő csatorna.'}
                  </p>
                ) : (
                  <div data-tv-doctor-routes-list="" className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      {activeRoutes.slice(0, 4).map((route, idx) => (
                        <div
                          key={route.id}
                          data-tv-doctor-route={route.id}
                          className={`flex items-center justify-between gap-1 rounded-lg border px-2.5 py-1.5 font-mono text-xs font-bold ${
                            idx === 0 ? 'border-emerald-400/70 bg-emerald-500/15 text-emerald-100' : 'border-slate-700/60 bg-slate-900/50 text-slate-200'
                          }`}
                        >
                          <span className="truncate">{idx === 0 ? '★ ' : `${idx + 1}. `}{safeDoctorFormat(route.format)} + {route.bufferProfile}</span>
                          <span className="shrink-0 text-[10px] text-slate-400">{route.avgStartupMs !== null ? `${route.avgStartupMs}ms` : '—'} • {route.ok}/{route.fail}{route.stalls ? `/${route.stalls}` : ''}</span>
                        </div>
                      ))}
                    </div>
                    <div className="space-y-1.5">
                      {activeRoutes.slice(4, 8).map((route, idx) => {
                        const realIdx = idx + 4;
                        return (
                          <div
                            key={route.id}
                            data-tv-doctor-route={route.id}
                            className="flex items-center justify-between gap-1 rounded-lg border border-slate-700/60 bg-slate-900/50 px-2.5 py-1.5 font-mono text-xs font-bold text-slate-200"
                          >
                            <span className="truncate">{realIdx + 1}. {safeDoctorFormat(route.format)} + {route.bufferProfile}</span>
                            <span className="shrink-0 text-[10px] text-slate-400">{route.avgStartupMs !== null ? `${route.avgStartupMs}ms` : '—'} • {route.ok}/{route.fail}{route.stalls ? `/${route.stalls}` : ''}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="text-xs font-semibold text-slate-500 mt-1 shrink-0">
                Tanulás: minden bejegyzés (tartós) • többi: 15 legfrissebb (kijelző)
              </div>
            </div>
          </section>

          {/* ================= JOBB OLDAL: BEÁLLÍTÁSOK + ÁLLAPOTOK (TANULT ÚTVONALAK HÍJÁN FELCSÚSZVA) ================= */}
          <section
            ref={rightScrollRef}
            data-tv-doctor-right-pane=""
            data-tv-doctor-right-scroll=""
            className="flex flex-col min-h-0 h-full overflow-y-auto bg-[#08152d] p-5 lg:p-6 gap-3.5"
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
              <p className="text-base lg:text-lg text-slate-100 font-bold leading-snug">
                {!tvDoctorEnabled
                  ? 'Kikapcsolva – az alap lejátszó üzemel.'
                  : hasAnyIssue
                    ? 'Működik, de figyelmeztetés van (lásd alább).'
                    : 'Jól működik minden – gyors csatornaváltás aktív.'}
              </p>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-4 gap-y-1.5 pt-1 text-base lg:text-lg text-slate-200">
                <div>
                  Tanult profilok: <strong className="text-white font-black">{doctorMem.learnedChannelCount} / {doctorMem.maxLearnedChannels}</strong>
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
              <p className="text-base font-semibold text-slate-300">{doctorMem.memoryHealthLabel}</p>
            </div>
          </section>
        </div>

        {/* Nagy ablak a 4 dobozhoz – ha rákattintasz, itt jelenik meg mind a 15 bejegyzés, lapozható */}
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
              className="w-full max-w-[760px] max-h-[82vh] rounded-2xl border-2 border-cyan-400/60 bg-[#061022] shadow-2xl flex flex-col overflow-hidden"
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
                          {displayLogsByCategory[largeCat].length} {largeCat === 'learning' ? 'db' : '/ 15 db'}
                        </span>
                      </>
                    );
                  })()}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const cat = largeCat;
                    setLargeCat(null);
                    setExpanded((prev) => ({ ...prev, [cat]: false }));
                    const hdr = categoryHeaderRefs.current[cat];
                    window.setTimeout(() => {
                      try { hdr?.focus({ preventScroll: true } as FocusOptions); } catch { hdr?.focus(); }
                    }, 10);
                  }}
                  className="shrink-0 rounded-xl border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm font-black text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400"
                >
                  ✕ Bezárás
                </button>
              </div>
              <div
                ref={largeScrollRef}
                tabIndex={0}
                role="region"
                aria-label={`${CATEGORY_BY_ID[largeCat].title} nagy naplólista`}
                data-tv-doctor-cat-logs={largeCat}
                data-tv-doctor-cat-logs-large={largeCat}
                className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 focus:outline-none"
              >
                {displayLogsByCategory[largeCat].length === 0 ? (
                  <div className="py-10 text-center text-slate-400 font-bold text-sm">
                    Nincs rögzített {CATEGORY_BY_ID[largeCat].title.toLowerCase()} esemény.
                  </div>
                ) : (
                  displayLogsByCategory[largeCat].map((entry, idx) => {
                    const vis = CATEGORY_BY_ID[largeCat];
                    return (
                      <div
                        key={`${entry.at}-${idx}`}
                        data-tv-doctor-log-item=""
                        data-log-category={largeCat}
                        className={`rounded-xl border p-3 space-y-1 ${vis.logBorder}`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-black text-white truncate">{entry.channelName}</span>
                          <span className="font-mono text-xs font-bold text-slate-300 shrink-0">{formatLogClock(entry.at)}</span>
                        </div>
                        <p className="text-sm font-semibold text-slate-100 leading-snug break-words">{entry.message}</p>
                      </div>
                    );
                  })
                )}
                <div className="text-xs text-slate-500 text-center pt-2">
                  {largeCat === 'learning' ? 'Összes tanulási bejegyzés' : 'Legfrissebb 15 bejegyzés'} • ↓/↑ vagy PgUp/PgDn a lapozáshoz • Esc a bezáráshoz
                </div>
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
