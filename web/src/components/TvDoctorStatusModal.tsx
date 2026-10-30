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
  X,
} from 'lucide-react';
import { AppSettings, Channel } from '../types/iptv';
import { TvDoctorIcon } from './TvDoctorIcon';
import { dateTimeText } from '../services/appLog';
import {
  DoctorEventCategory,
  DoctorLogEntry,
  formatDoctorBytes,
  getTvDoctorMemoryStats,
  getTvDoctorOperationHealth,
  getTvDoctorSummary,
  isChannelHandledByDoctor,
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
}

/**
 * A teljes képernyős élő TV lejátszó (`[data-tv-player].fixed`) z-indexe 2147483000,
 * ezért a 0-gombos TV Doktor ablak rétegének mindig afelett kell lennie!
 */
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
    subtitle: 'Gyorsprofil, formátum és EPG-mentes csatorna',
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
    subtitle: 'Beállításváltás, pufferemelés és EPG segítés',
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
    subtitle: 'Közbelépés késés, akadás vagy EPG miatt',
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

export const TvDoctorStatusModal: React.FC<TvDoctorStatusModalProps> = ({
  isOpen,
  onClose,
  settings,
  activeChannel,
}) => {
  const [, setUiTick] = useState(0);
  const [resetFeedback, setResetFeedback] = useState(false);
  const [scrollOffsetPx, setScrollOffsetPx] = useState(0);

  const modalCardRef = useRef<HTMLDivElement | null>(null);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const rightScrollRef = useRef<HTMLDivElement | null>(null);
  const resetBtnRef = useRef<HTMLButtonElement | null>(null);
  const testBtnRef = useRef<HTMLButtonElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const resetFeedbackTimerRef = useRef<number | null>(null);

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
    if (!isOpen) {
      setResetFeedback(false);
      setScrollOffsetPx(0);
      if (resetFeedbackTimerRef.current !== null) {
        window.clearTimeout(resetFeedbackTimerRef.current);
        resetFeedbackTimerRef.current = null;
      }
      return undefined;
    }

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void checkTvDoctorConnection();

    const focusTimer = window.setTimeout(() => {
      if (logScrollRef.current) {
        logScrollRef.current.scrollTop = 0;
        logScrollRef.current.focus({ preventScroll: true } as FocusOptions);
      }
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      const fsPlayer = typeof document !== 'undefined'
        ? document.querySelector<HTMLElement>('[data-tv-player].fixed')
        : null;
      const prev = previousFocusRef.current;
      // Teljes képernyőn a bezárás után a teljes képernyős lejátszó visszakapja a fókuszt,
      // hogy a csatornaváltás, hangerő, OK és Vissza azonnal reagáljon.
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

  if (!isOpen) return null;

  const tvDoctorEnabled = settings.tvDoctorEnabled !== false;
  const doctorSummary = getTvDoctorSummary();
  const doctorMem = getTvDoctorMemoryStats();
  const doctorOp = getTvDoctorOperationHealth();
  const doctorCloud = getTvDoctorCloudStatus();
  const pairingInfo = getTvDoctorPairingInfo();
  const categoryStats = doctorSummary.categoryStats;
  const epgStats = doctorSummary.epgStats;

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

  const handleResetMemory = () => {
    resetTvDoctorAllToZero();
    setResetFeedback(true);
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = 0;
    }
    setScrollOffsetPx(0);
    if (resetFeedbackTimerRef.current !== null) {
      window.clearTimeout(resetFeedbackTimerRef.current);
    }
    resetFeedbackTimerRef.current = window.setTimeout(() => {
      resetFeedbackTimerRef.current = null;
      setResetFeedback(false);
    }, 2500);
  };

  const scrollLogBy = (delta: number) => {
    const pane = logScrollRef.current;
    if (!pane) return;
    const hasLayout = pane.scrollHeight > 0 || pane.clientHeight > 0;
    const maxScroll = hasLayout
      ? Math.max(0, pane.scrollHeight - pane.clientHeight)
      : Number.POSITIVE_INFINITY;
    const nextTop = Math.max(0, Math.min(maxScroll, pane.scrollTop + delta));
    pane.scrollTop = nextTop;
    setScrollOffsetPx(Math.round(nextTop));
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

  const getRightControls = (): HTMLButtonElement[] => {
    const list: HTMLButtonElement[] = [];
    if (resetBtnRef.current && !resetBtnRef.current.disabled) list.push(resetBtnRef.current);
    if (testBtnRef.current && !testBtnRef.current.disabled) list.push(testBtnRef.current);
    if (closeBtnRef.current && !closeBtnRef.current.disabled) list.push(closeBtnRef.current);
    return list;
  };

  const handleModalKeyDown = (e: KeyboardEvent | React.KeyboardEvent<HTMLDivElement>) => {
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
    const onLogPane = Boolean(
      active && logScrollRef.current && (active === logScrollRef.current || logScrollRef.current.contains(active)),
    );
    const onRightPane = Boolean(
      active && rightScrollRef.current && (active === rightScrollRef.current || rightScrollRef.current.contains(active)),
    );

    if (key === 'PageDown' || key === 'PageUp') {
      e.preventDefault();
      e.stopPropagation();
      if (onRightPane) {
        const pane = rightScrollRef.current;
        const pageStep = pane && pane.clientHeight > 0 ? Math.max(180, Math.round(pane.clientHeight * 0.75)) : 320;
        scrollRightBy(key === 'PageDown' ? pageStep : -pageStep);
        return;
      }
      const pane = logScrollRef.current;
      const pageStep = pane && pane.clientHeight > 0 ? Math.max(180, Math.round(pane.clientHeight * 0.28)) : 320;
      scrollLogBy(key === 'PageDown' ? pageStep : -pageStep);
      return;
    }

    if (onRightPane) {
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const pane = rightScrollRef.current;
        const step = pane && pane.clientHeight > 0 ? Math.max(96, Math.round(pane.clientHeight * 0.28)) : 120;
        scrollRightBy(key === 'ArrowDown' ? step : -step);
        return;
      }
      if (key === 'Home') {
        e.preventDefault();
        e.stopPropagation();
        if (rightScrollRef.current) {
          rightScrollRef.current.scrollTop = 0;
        }
        return;
      }
      if (key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        if (rightScrollRef.current) {
          const bottom = Math.max(0, rightScrollRef.current.scrollHeight - rightScrollRef.current.clientHeight);
          rightScrollRef.current.scrollTop = bottom;
        }
        return;
      }
      if (key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        logScrollRef.current?.focus({ preventScroll: true } as FocusOptions);
        return;
      }
    }

    if (onLogPane) {
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const pane = logScrollRef.current;
        const step = pane && pane.clientHeight > 0 ? Math.max(96, Math.round(pane.clientHeight * 0.28)) : 120;
        scrollLogBy(key === 'ArrowDown' ? step : -step);
        return;
      }
      if (key === 'Home') {
        e.preventDefault();
        e.stopPropagation();
        if (logScrollRef.current) {
          logScrollRef.current.scrollTop = 0;
          setScrollOffsetPx(0);
        }
        return;
      }
      if (key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        if (logScrollRef.current) {
          const bottom = Math.max(0, logScrollRef.current.scrollHeight - logScrollRef.current.clientHeight);
          logScrollRef.current.scrollTop = bottom;
          setScrollOffsetPx(Math.round(bottom));
        }
        return;
      }
      if (key === 'ArrowRight') {
        const rightControls = getRightControls();
        if (rightControls.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          rightControls[0].focus({ preventScroll: true } as FocusOptions);
        }
        return;
      }
      if (key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    const rightControls = getRightControls();
    const curRightIdx = active ? rightControls.indexOf(active as HTMLButtonElement) : -1;
    if (curRightIdx >= 0) {
      if (key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        logScrollRef.current?.focus({ preventScroll: true } as FocusOptions);
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
      if (key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'ArrowLeft' || key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      logScrollRef.current?.focus({ preventScroll: true } as FocusOptions);
    }
  };
  handleModalKeyDownRef.current = handleModalKeyDown;

  const modal = (
    <div
      data-tv-doctor-modal=""
      role="dialog"
      aria-modal="true"
      aria-label="TV Doktor állapot és napló"
      style={{ zIndex: TV_DOCTOR_MODAL_Z_INDEX }}
      className="fixed inset-0 flex items-center justify-center bg-black/88 p-3 sm:p-5 select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalCardRef}
        data-tv-navigation-owner="tv-doctor"
        tabIndex={-1}
        onKeyDown={handleModalKeyDown}
        className="w-full max-w-[1760px] h-[92vh] max-h-[980px] rounded-3xl border-2 border-cyan-400/70 bg-[#061022] shadow-2xl overflow-hidden grid grid-cols-1 sm:grid-cols-2 focus:outline-none"
      >
        {/* ================= BAL OLDAL: SZÍNKÓDOLT TV DOKTOR NAPLÓ (LEFELÉ GÖRGETHETŐ) ================= */}
        <section
          data-tv-doctor-left-pane=""
          className="flex flex-col min-h-0 h-full border-b-2 sm:border-b-0 sm:border-r-2 border-cyan-500/40 bg-[#050d1d] p-5 lg:p-6 gap-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
            <div>
              <h2 className="text-xl lg:text-2xl font-black uppercase tracking-wide text-cyan-300">
                Legutóbbi TV Doktor napló
              </h2>
              <p className="text-sm lg:text-base font-bold text-amber-300 mt-0.5">
                ▼ / ▲ nyilak: lefelé és felfelé olvasás • ► Jobbra: vezérlők és Memória: 0
              </p>
            </div>
            <span
              data-tv-doctor-log-count=""
              className="inline-flex items-center rounded-xl border border-cyan-400/55 bg-cyan-500/15 px-3.5 py-1.5 font-mono text-base lg:text-lg font-black text-white shrink-0"
            >
              {orderedLogs.length} sor
            </span>
          </div>

          <div
            ref={logScrollRef}
            data-tv-default=""
            data-tv-open-focus=""
            data-tv-scroll-pane=""
            data-tv-doctor-log-scroll=""
            data-scroll-top={scrollOffsetPx}
            tabIndex={0}
            role="region"
            aria-label="Legutóbbi TV Doktor napló"
            onScroll={(e) => setScrollOffsetPx(Math.round(e.currentTarget.scrollTop))}
            className="flex-1 min-h-0 overflow-y-auto rounded-2xl border-2 border-cyan-500/45 bg-[#030915] p-4 space-y-3 focus:outline-none focus:border-amber-400 focus:ring-4 focus:ring-amber-400/35"
          >
            {orderedLogs.length === 0 ? (
              <div className="flex h-full min-h-[220px] items-center justify-center text-center px-6">
                <p
                  data-tv-doctor-log-empty=""
                  className="text-lg lg:text-xl font-bold text-slate-300 leading-relaxed"
                >
                  Nincs rögzített élő TV vagy EPG esemény (0 bejegyzés).
                </p>
              </div>
            ) : (
              orderedLogs.map((entry, idx) => {
                const cat = resolveEntryCategory(entry);
                const vis = CATEGORY_BY_ID[cat];
                return (
                  <div
                    key={`${entry.at}-${idx}`}
                    data-tv-doctor-log-item=""
                    data-log-category={cat}
                    className={`rounded-2xl border-2 p-3.5 space-y-1.5 ${vis.logBorder}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          data-tv-doctor-log-badge={cat}
                          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-0.5 text-sm font-black uppercase tracking-wider shrink-0 ${vis.logBadge}`}
                        >
                          <span className={`h-2.5 w-2.5 rounded-full ${vis.dotClass}`} />
                          {vis.shortTag}
                        </span>
                        <span className="text-base lg:text-lg font-black text-white truncate">
                          {entry.channelName}
                        </span>
                      </div>
                      <span className="font-mono text-sm lg:text-base font-bold text-slate-300 shrink-0">
                        {formatLogClock(entry.at)}
                      </span>
                    </div>
                    <p className="text-base lg:text-lg font-semibold text-slate-100 leading-snug break-words">
                      {entry.message}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* ================= JOBB OLDAL: SZÍNKÓDOLT ESEMÉNYJELZŐK + ÁLLANDÓ ADATOK + MEMÓRIA: 0 ================= */}
        <section
          ref={rightScrollRef}
          data-tv-doctor-right-pane=""
          data-tv-doctor-right-scroll=""
          className="flex flex-col min-h-0 h-full overflow-y-auto bg-[#08152d] p-5 lg:p-6 gap-3.5"
          onScroll={() => {}}
        >
          {/* Felső fejléc: bal oldalon ikon + cím + élő csatorna, jobb felső sarokban a piros Memória: 0 gomb */}
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
                  <h2 className="text-2xl lg:text-3xl font-black text-white leading-tight">
                    TV Doktor állapot
                  </h2>
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
                    : 'Élő TV és EPG felügyelet aktív'}
                </p>
              </div>
            </div>

            {/* Jobb felső sarok: piros Memória: 0 törlés funkció */}
            <button
              ref={resetBtnRef}
              type="button"
              data-tv-doctor-reset=""
              aria-label="TV Doktor memória nullázása 0 állapotra"
              title="Tanult csatornák, EPG-tiltások, napló és szinkron-várólista visszaállítása 0 állapotra"
              onClick={handleResetMemory}
              className={`shrink-0 inline-flex items-center gap-2 rounded-2xl border-2 px-4 py-2.5 text-base lg:text-lg font-black shadow-lg focus:outline-none focus:ring-4 focus:ring-amber-400 ${
                resetFeedback
                  ? 'border-emerald-400 bg-emerald-600/35 text-emerald-100'
                  : 'border-rose-500 bg-rose-950/90 text-rose-100 hover:bg-rose-900'
              }`}
            >
              <RotateCcw className="h-5 w-5 shrink-0" />
              <span>{resetFeedback ? '0-ra állítva ✓' : 'Memória: 0'}</span>
            </button>
          </div>

          {/* 0. Színkódolt TV Doktor eseményjelzők: Tanulás (zöld) • Segítség/Javítás (kék) • Aktiválódás (sárga) • Csatornahiba (piros) */}
          <div
            data-tv-doctor-category-panel=""
            className="rounded-2xl border border-cyan-700/65 bg-[#051024] p-3.5 space-y-2.5 shrink-0"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-base lg:text-lg font-black uppercase tracking-wide text-cyan-200">
                Eseményjelzők (színkódolt napló-összesítő)
              </span>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5">
              {CATEGORY_VISUALS.map((vis) => {
                const stat = categoryStats[vis.id];
                const active = stat.count > 0;
                const IconComp = vis.Icon;
                return (
                  <div
                    key={vis.id}
                    data-tv-doctor-cat={vis.id}
                    data-cat-active={active ? 'true' : 'false'}
                    data-cat-count={stat.count}
                    className={`rounded-xl border-2 px-3.5 py-2.5 transition-none ${
                      active
                        ? `${vis.cardBorder} ${vis.cardBg}`
                        : 'border-slate-700/70 bg-slate-900/50 opacity-80'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`h-3 w-3 rounded-full shrink-0 ${
                            active ? vis.dotClass : 'bg-slate-500'
                          }`}
                        />
                        <IconComp className={`h-5 w-5 shrink-0 ${vis.titleColor}`} />
                        <span className={`text-base lg:text-lg font-black truncate ${vis.titleColor}`}>
                          {vis.title}
                        </span>
                      </div>
                      <span
                        data-tv-doctor-cat-count={vis.id}
                        className={`inline-flex items-center rounded-lg border px-2.5 py-0.5 font-mono text-sm lg:text-base font-black shrink-0 ${vis.countBadge}`}
                      >
                        {stat.count} db
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
              })}
            </div>
          </div>

          {/* 1. Működési állapot + EPG felügyelet */}
          <div
            data-tv-doctor-health=""
            className="rounded-2xl border border-cyan-800/60 bg-[#051024] p-4 space-y-2"
          >
            <div className="flex items-center gap-2.5 text-lg lg:text-xl font-black text-white">
              <CheckCircle2
                className={`h-6 w-6 shrink-0 ${
                  !tvDoctorEnabled
                    ? 'text-slate-400'
                    : hasAnyIssue
                      ? 'text-amber-300'
                      : 'text-emerald-400'
                }`}
              />
              <span>Működési állapot és EPG felügyelet</span>
            </div>
            <p className="text-base lg:text-lg text-slate-100 font-bold leading-snug">
              {!tvDoctorEnabled
                ? 'Kikapcsolva – az alap lejátszó üzemel.'
                : hasAnyIssue
                  ? 'Működik, de figyelmeztetés van (lásd alább).'
                  : 'Jól működik minden – gyors csatornaváltás és EPG-ellenőrzés aktív.'}
            </p>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-4 gap-y-1.5 pt-1 text-base lg:text-lg text-slate-200">
              <div>
                Tanult profilok:{' '}
                <strong className="text-white font-black">
                  {doctorMem.learnedChannelCount} / {doctorMem.maxLearnedChannels}
                </strong>
              </div>
              <div>
                Sikeres javítások:{' '}
                <strong className="text-white font-black">{doctorSummary.totalVerifiedRepairs} db</strong>
              </div>
              <div>
                Sebesség:{' '}
                <strong className="text-white font-black">
                  {doctorOp.lastSlowOp
                    ? `Lassulás (${doctorOp.lastSlowOp.elapsedMs} ms)`
                    : 'Villámgyors'}
                </strong>
              </div>
              <div data-tv-doctor-epg-summary="">
                EPG lekapcsolva (nincs műsor):{' '}
                <strong className="text-emerald-300 font-black">
                  {epgStats.disabledChannelCount} csatorna
                </strong>
                {epgStats.assistCount > 0 ? ` • segítés: ${epgStats.assistCount}x` : ''}
              </div>
            </div>
          </div>

          {/* 2. Supabase kapcsolat + Teszt */}
          <div
            data-tv-doctor-supabase=""
            className="rounded-2xl border border-cyan-800/60 bg-[#051024] p-4 space-y-2"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-lg lg:text-xl font-black text-white">
                {doctorCloud.connected ? (
                  <Wifi className="h-6 w-6 shrink-0 text-emerald-400" />
                ) : (
                  <WifiOff className="h-6 w-6 shrink-0 text-amber-300" />
                )}
                <span>Supabase kapcsolat</span>
              </div>
              <button
                ref={testBtnRef}
                type="button"
                data-tv-doctor-check-cloud=""
                disabled={doctorCloud.checking || doctorCloud.syncing}
                onClick={() => {
                  void checkTvDoctorConnection();
                }}
                className="inline-flex items-center gap-2 rounded-xl border-2 border-cyan-400/60 bg-cyan-500/20 px-4 py-1.5 text-base lg:text-lg font-black text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-50 focus:outline-none focus:ring-4 focus:ring-amber-400"
              >
                <RefreshCw
                  className={`h-5 w-5 ${doctorCloud.checking || doctorCloud.syncing ? 'animate-spin' : ''}`}
                />
                <span>Teszt</span>
              </button>
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
                Eszköz:{' '}
                <strong className="font-mono text-white font-black">{pairingInfo.deviceId}</strong>
              </div>
              <div>
                Központi profilok:{' '}
                <strong className="text-white font-black">{doctorCloud.cloudProfileCount} db</strong> • Várólista:{' '}
                <strong className="text-white font-black">{doctorCloud.pendingCount} elem</strong>
              </div>
              <div className="truncate" title={lastSyncText}>
                Utolsó szinkron: <strong className="text-white font-black">{lastSyncText}</strong>
              </div>
            </div>
          </div>

          {/* 3. Hibajelzés vagy Minden rendben sáv */}
          {hasCloudError || hasStorageError ? (
            <div
              data-tv-doctor-error-box=""
              role="alert"
              className="rounded-2xl border-2 border-rose-500/65 bg-rose-950/55 p-4 space-y-1.5"
            >
              <div className="flex items-center gap-2.5 text-lg lg:text-xl font-black text-rose-200">
                <AlertTriangle className="h-6 w-6 shrink-0 text-rose-400" />
                <span>Hiba részletei a javításhoz</span>
              </div>
              {hasCloudError && (
                <div className="text-base lg:text-lg text-slate-100 leading-snug space-y-1">
                  <div>
                    <span className="text-rose-300 font-bold">Hol a hiba:</span>{' '}
                    <strong>{doctorCloud.lastErrorLocation || 'Supabase kapcsolat'}</strong>
                    {doctorCloud.lastErrorCode ? ` (${doctorCloud.lastErrorCode})` : ''}
                  </div>
                  <div>
                    <span className="text-rose-300 font-bold">Mi a hiba:</span>{' '}
                    <span>{doctorCloud.lastErrorSummary}</span>
                  </div>
                </div>
              )}
              {hasStorageError && doctorMem.lastStorageError && (
                <div className="text-base lg:text-lg text-slate-100 leading-snug space-y-1">
                  <div>
                    <span className="text-rose-300 font-bold">Hol a hiba:</span>{' '}
                    <strong>{doctorMem.lastStorageError.location}</strong>
                  </div>
                  <div>
                    <span className="text-rose-300 font-bold">Mi a hiba:</span>{' '}
                    <span>{doctorMem.lastStorageError.message}</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div
              data-tv-doctor-ok-banner=""
              className="rounded-2xl border border-emerald-500/45 bg-emerald-950/40 px-4 py-3 text-base lg:text-lg font-bold text-emerald-200"
            >
              {doctorCloud.connected
                ? '✓ Minden rendben: a védett Supabase kapcsolat aktív, nincs hálózati vagy memóriahiba.'
                : '✓ Helyi TV Doktor hibátlanul üzemel, nincs tárolási vagy lejátszási hiba.'}
            </div>
          )}

          {/* 4. Memória és TV memóriahasználat (1 MB keret) */}
          <div
            data-tv-doctor-memory=""
            className="rounded-2xl border border-cyan-800/60 bg-[#051024] p-4 space-y-2.5"
          >
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
                className={`h-full rounded-full ${
                  doctorMem.memoryHealth === 'high'
                    ? 'bg-rose-400'
                    : doctorMem.memoryHealth === 'moderate'
                      ? 'bg-amber-400'
                      : 'bg-cyan-400'
                }`}
                style={{
                  width: `${Math.max(doctorMem.doctorTotalBytes > 0 ? 2 : 0, Math.min(100, doctorMem.doctorBudgetPercent))}%`,
                }}
              />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-4 gap-y-1.5 text-base lg:text-lg text-slate-200">
              <div>
                TV Doktor memória:{' '}
                <strong className="text-white font-black">
                  {formatDoctorBytes(doctorMem.doctorTotalBytes)} / {formatDoctorBytes(doctorMem.maxSafeDoctorBytes)}
                </strong>
              </div>
              <div>
                TV tárhely összesen:{' '}
                <strong className="text-white font-black">
                  {formatDoctorBytes(doctorMem.tvStorageUsedBytes)} / ~5.0 MB ({doctorMem.tvStoragePercent}%)
                </strong>
              </div>
              <div>
                Bontás:{' '}
                <span className="text-slate-300 font-semibold">
                  profilok {formatDoctorBytes(doctorMem.doctorStoreBytes)}, várólista{' '}
                  {formatDoctorBytes(doctorMem.cloudQueueBytes)}
                </span>
              </div>
              <div>
                TV munkamemória (RAM):{' '}
                <strong className="text-white font-black">
                  {doctorMem.jsHeapUsedMB !== null
                    ? `${doctorMem.jsHeapUsedMB} MB${doctorMem.jsHeapLimitMB ? ` / ${doctorMem.jsHeapLimitMB} MB` : ''}`
                    : 'webOS automatikus'}
                </strong>
              </div>
            </div>
            <p className="text-base font-semibold text-slate-300">{doctorMem.memoryHealthLabel}</p>
          </div>

          {/* Alsó bezáró sáv */}
          <div className="mt-auto pt-1 flex flex-wrap items-center justify-between gap-3 shrink-0">
            <span className="text-sm lg:text-base font-bold text-slate-300">
              0 gomb vagy VISSZA: bezárás • ◄ Balra: napló görgetése
            </span>
            <button
              ref={closeBtnRef}
              type="button"
              data-tv-doctor-close=""
              onClick={onClose}
              className="inline-flex items-center gap-2 rounded-2xl border-2 border-cyan-400/60 bg-cyan-500/20 px-4 py-2 text-base lg:text-lg font-black text-cyan-100 hover:bg-cyan-500/30 focus:outline-none focus:ring-4 focus:ring-amber-400"
            >
              <X className="h-5 w-5 shrink-0" />
              <span>Bezárás (0)</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
};
