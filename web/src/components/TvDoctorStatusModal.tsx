import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  RefreshCw,
  RotateCcw,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { AppSettings, Channel } from '../types/iptv';
import { TvDoctorIcon } from './TvDoctorIcon';
import { dateTimeText } from '../services/appLog';
import {
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

function isZeroDigitKey(e: KeyboardEvent | React.KeyboardEvent): boolean {
  const key = e.key;
  const code = (e as KeyboardEvent).code || '';
  const kc = e.keyCode || e.which || 0;
  return key === '0' || code === 'Digit0' || code === 'Numpad0' || kc === 48 || kc === 96;
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
      const prev = previousFocusRef.current;
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

    if (key === 'PageDown' || key === 'PageUp') {
      e.preventDefault();
      e.stopPropagation();
      const pane = logScrollRef.current;
      const pageStep = pane && pane.clientHeight > 0 ? Math.max(180, Math.round(pane.clientHeight * 0.75)) : 320;
      scrollLogBy(key === 'PageDown' ? pageStep : -pageStep);
      return;
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
          const maxScroll = Math.max(0, logScrollRef.current.scrollHeight - logScrollRef.current.clientHeight);
          logScrollRef.current.scrollTop = maxScroll;
          setScrollOffsetPx(Math.round(maxScroll));
        }
        return;
      }
      if (key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        const rightControls = getRightControls();
        rightControls[0]?.focus({ preventScroll: true } as FocusOptions);
        return;
      }
      if (key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    const rightControls = getRightControls();
    const rightIdx = active ? rightControls.indexOf(active as HTMLButtonElement) : -1;
    if (rightIdx >= 0) {
      if (key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        logScrollRef.current?.focus({ preventScroll: true } as FocusOptions);
        return;
      }
      if (key === 'ArrowDown' || key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        const next = Math.min(rightControls.length - 1, rightIdx + 1);
        rightControls[next]?.focus({ preventScroll: true } as FocusOptions);
        return;
      }
      if (key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const prev = Math.max(0, rightIdx - 1);
        rightControls[prev]?.focus({ preventScroll: true } as FocusOptions);
        return;
      }
    } else if (
      key === 'ArrowDown' ||
      key === 'ArrowUp' ||
      key === 'ArrowLeft' ||
      key === 'ArrowRight'
    ) {
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
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/85 p-3 sm:p-5 select-none"
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
        {/* ================= BAL OLDAL: KIZÁRÓLAG A LEGUTÓBBI TV DOKTOR NAPLÓ (LEFELÉ GÖRGETHETŐ) ================= */}
        <section
          data-tv-doctor-left-pane=""
          className="flex flex-col min-h-0 h-full border-b-2 sm:border-b-0 sm:border-r-2 border-cyan-500/40 bg-[#050d1d] p-5 lg:p-6 gap-3.5"
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
                  Nincs rögzített élő TV hiba vagy javítási esemény (0 bejegyzés).
                </p>
              </div>
            ) : (
              orderedLogs.map((entry, idx) => (
                <div
                  key={`${entry.at}-${idx}`}
                  data-tv-doctor-log-item=""
                  className="rounded-xl border border-cyan-900/65 bg-[#08152c] px-4 py-3 space-y-1 shadow-sm"
                >
                  <div className="flex flex-wrap items-center gap-2.5 text-base lg:text-lg leading-snug">
                    <span className="font-mono font-bold text-slate-300">
                      {formatLogClock(entry.at)}
                    </span>
                    <strong
                      className={`font-black ${
                        entry.level === 'verified'
                          ? 'text-emerald-300'
                          : entry.level === 'warn'
                            ? 'text-amber-300'
                            : 'text-cyan-300'
                      }`}
                    >
                      [{entry.channelName}]
                    </strong>
                  </div>
                  <p className="text-base lg:text-lg font-semibold text-slate-100 leading-relaxed break-words">
                    {entry.message}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>

        {/* ================= JOBB OLDAL: ÁLLANDÓ ADATOK + JOBB FELSŐ SAROKBAN PIROS MEMÓRIA: 0 ================= */}
        <section
          data-tv-doctor-right-pane=""
          className="flex flex-col min-h-0 h-full overflow-y-auto bg-[#08152d] p-5 lg:p-6 gap-4"
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
                    ? `Élő adás: ${activeChannel.name}${activeChannelHandled ? ' • Tanult profil aktív' : ' • Automatikus védelem'}`
                    : 'Élő TV felügyelet aktív'}
                </p>
              </div>
            </div>

            {/* Jobb felső sarok: piros Memória: 0 törlés funkció */}
            <button
              ref={resetBtnRef}
              type="button"
              data-tv-doctor-reset=""
              aria-label="TV Doktor memória nullázása 0 állapotra"
              title="Tanult csatornák, napló és szinkron-várólista visszaállítása 0 állapotra"
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

          {/* 1. Működési állapot */}
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
              <span>Működési állapot</span>
            </div>
            <p className="text-base lg:text-lg text-slate-100 font-bold leading-snug">
              {!tvDoctorEnabled
                ? 'Kikapcsolva – az alap lejátszó üzemel.'
                : hasAnyIssue
                  ? 'Működik, de figyelmeztetés van (lásd alább).'
                  : 'Jól működik minden – nincs hiba vagy elakadás.'}
            </p>
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-2 pt-1 text-base lg:text-lg text-slate-200">
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

          {/* 4. Memória és TV memóriahasználat */}
          <div
            data-tv-doctor-memory=""
            className="rounded-2xl border border-cyan-800/60 bg-[#051024] p-4 space-y-2.5"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2.5 text-lg lg:text-xl font-black text-white">
                <Database className="h-6 w-6 shrink-0 text-cyan-300" />
                <span>Memória és TV memóriahasználat</span>
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
