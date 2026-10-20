import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Download, Gauge, Network, X } from 'lucide-react';
import type { ImportProgress } from '../services/providerImport';
import type { NetworkDiagnosticEvent } from '../services/net';
import type { Channel } from '../types/iptv';
import { cancelNetworkRequests } from '../services/net';
import packageJson from '../../package.json';

interface LoadingDiagnosticModalProps {
  isOpen: boolean;
  progress: ImportProgress | null;
  events: NetworkDiagnosticEvent[];
  channels?: Channel[];
  logoSource?: 'xtream' | 'm3u' | 'unknown';
  error: string | null;
  startedAt: number;
  onClose: () => void;
  /** Újrapróbálkozás gomb (ha van mit újrapróbálni). */
  onRetry?: () => void;
  /** Hány másodperc múlva próbálja újra magától (automatikus újrapróbálkozás). */
  retryInSeconds?: number | null;
}

/** A vágólapra írás naplója: a diagnosztikában látszik, mi történt. */
const clipboardLog: string[] = [];
export function reportClipboardLog(what: string): void {
  clipboardLog.push(`${new Date().toLocaleTimeString()} ${what}`);
  if (clipboardLog.length > 20) clipboardLog.shift();
}
const formatMs = (value: number) => value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const formatBytes = (value: number) => value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(2)} MB`;
const shortUrl = (url: string) => {
  try { return new URL(url).host + new URL(url).pathname; } catch { return url.slice(0, 80); }
};

export const LoadingDiagnosticModal: React.FC<LoadingDiagnosticModalProps> = ({
  isOpen, progress, events, channels = [], logoSource = 'unknown', error, startedAt, onClose, onRetry, retryInSeconds,
}) => {
  const [now, setNow] = useState(() => performance.now());
  const [longTasks, setLongTasks] = useState<number[]>([]);
  const [copyWindowOpen, setCopyWindowOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [diagnosticLogOpen, setDiagnosticLogOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    // A befejezett vagy hibás diagnosztika 10 másodperc múlva automatikusan eltűnik.
    if (error || progress?.percent === 100) {
      const closeTimer = window.setTimeout(onClose, 10_000);
      return () => window.clearTimeout(closeTimer);
    }
    const timerId = window.setInterval(() => setNow(performance.now()), 250);
    let observer: PerformanceObserver | null = null;
    try {
      if ('PerformanceObserver' in window) {
        observer = new PerformanceObserver((list) => {
          const durations = list.getEntries().map((entry) => entry.duration).filter((duration) => duration >= 50);
          if (durations.length) setLongTasks((prev) => [...prev, ...durations].slice(-100));
        });
        observer.observe({ entryTypes: ['longtask'] });
      }
    } catch {
      observer = null;
    }
    return () => {
      window.clearInterval(timerId);
      observer?.disconnect();
    };
  }, [isOpen, error, progress?.percent, onClose]);

  const elapsed = Math.max(0, now - startedAt);
  const completed = !error && progress?.percent === 100;
  const finalPercent = completed ? 100 : Math.min(99, Math.max(0, progress?.percent || 0));
  const latestByUrl = new Map<string, NetworkDiagnosticEvent>();
  for (const event of events) latestByUrl.set(event.url, event);
  const activeRequestEvents = Array.from(latestByUrl.values()).filter((event) => event.status === 'start');
  const activeRequests = activeRequestEvents.length;
  const longRequest = activeRequestEvents.some((event) => now - event.startedAt > 3000);
  const successful = events.filter((event) => event.status === 'success');
  const failed = events.filter((event) => event.status === 'error');
  const totalBytes = successful.reduce((sum, event) => sum + (event.bytes || 0), 0);
  const averageSpeed = elapsed > 0 ? totalBytes / (elapsed / 1000) : 0;
  const longestRequest = Math.max(0, ...successful.map((event) => event.durationMs || 0));
  const gaps = useMemo(() => {
    const starts = events.filter((e) => e.status === 'start').map((e) => e.startedAt).sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 1; i < starts.length; i++) maxGap = Math.max(maxGap, starts[i] - starts[i - 1]);
    return maxGap;
  }, [events]);

  // Passzív logódiagnosztika: kizárólag a már betöltött csatornaadatokat vizsgálja.
  // Nem indít képkérést, fetch-et vagy külön API-lekérést.
  const logoDiagnostics = useMemo(() => {
    const withLogo = channels.filter((channel) => typeof channel.logo === 'string' && channel.logo.trim().length > 0);
    const missingLogo = channels.length - withLogo.length;
    const sourceLabel = logoSource === 'xtream' ? 'Xtream stream_icon' : logoSource === 'm3u' ? 'M3U tvg-logo' : 'a csatorna mentett logo mezője';
    return {
      totalChannels: channels.length,
      withLogo: withLogo.length,
      missingLogo,
      source: sourceLabel,
      samples: withLogo.slice(0, 5).map((channel) => ({ name: channel.name, logoUrl: channel.logo, source: sourceLabel })),
    };
  }, [channels, logoSource]);

  const report = useMemo(() => {
    const finalEvents = events.map((event) => ({
      id: event.id,
      url: event.url,
      status: event.status,
      httpStatus: event.httpStatus ?? null,
      durationMs: event.durationMs ?? null,
      bytes: event.bytes ?? null,
      error: event.error ?? null,
      startedAt: event.startedAt,
      endedAt: event.endedAt ?? null
    }));
    return {
      generatedAt: new Date().toISOString(),
      state: error ? 'error' : completed ? 'completed' : 'running',
      finalPercent,
      totalElapsedMs: Math.round(elapsed),
      requestCount: events.filter((e) => e.status === 'start').length,
      successfulRequests: successful.length,
      failedRequests: failed.length,
      totalBytes,
      averageBytesPerSecond: Math.round(averageSpeed),
      longestRequestMs: Math.round(longestRequest),
      maxRequestStartGapMs: Math.round(gaps),
      activeRequests,
      longTaskCount: longTasks.length,
      maxLongTaskMs: longTasks.length ? Math.round(Math.max(...longTasks)) : 0,
      progress: progress ?? null,
      error: error ?? null,
      logoDiagnostics,
      events: finalEvents
    };
  }, [events, error, completed, finalPercent, elapsed, successful.length, failed.length, totalBytes, averageSpeed, longestRequest, gaps, activeRequests, longTasks, progress, logoDiagnostics]);

  const reportText = JSON.stringify(report, null, 2);

  const handleAbortAndClose = () => {
    cancelNetworkRequests();
    onClose();
  };

  const openCopyWindow = () => {
    setCopied(false);
    setCopyWindowOpen(true);
  };

  /**
   * A diagnosztika másolása a vágólapra.
   *
   * FONTOS: kizárólag valódi felhasználói koppintásra futhat (isTrusted),
   * és csak akkor, ha a gombos eseményt a felhasználó indította. Így semmilyen
   * automatikus folyamat nem írhat a telefon vágólapjára.
   */
  const copyReport = async (event: React.MouseEvent<HTMLButtonElement>) => {
    // A vágólapra kizárólag a megjelölt, kézi MÁSOLÁS gomb írhat.
    if (!event.isTrusted || event.currentTarget.dataset.manualCopyButton !== 'true') {
      reportClipboardLog('blokkolt automatikus másolás');
      return;
    }
    try {
      await navigator.clipboard.writeText(reportText);
      reportClipboardLog('kézi másolás (MÁSOLÁS gomb)');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-3 bg-[#020208]/95 backdrop-blur-md select-none"
        onCopy={(event) => event.preventDefault()}
        onCut={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
        style={{ userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
      >
        <div role="dialog" aria-modal="true" className="relative w-full max-w-xl max-h-[calc(100dvh-24px)] overflow-hidden rounded-3xl border border-cyan-400/40 bg-[#060816]/95 shadow-[0_0_60px_rgba(0,240,255,0.18)] text-white">
          <div className="absolute inset-0 pointer-events-none opacity-30 bg-[radial-gradient(circle_at_center,transparent_15%,#020208_90%)]" />
          <div className="relative p-3 sm:p-5 overflow-y-auto max-h-[calc(100dvh-24px)]">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-[10px] tracking-[0.25em] text-cyan-300 font-bold">QUANTUM IPTV CORE • v{packageJson.version}</div>
                <h2 className="text-lg font-black tracking-wider">BETÖLTÉSI DIAGNOSZTIKA</h2>
              </div>
              <button onClick={handleAbortAndClose} className="p-2 rounded-xl border border-cyan-800/60 bg-white/5 hover:bg-white/10">
                  <X className="w-5 h-5" />
                <span className="sr-only">Diagnosztika és frissítés leállítása</span>
                </button>
            </div>

            <div className="grid grid-cols-[110px_1fr] gap-4 items-center">
              <div className="relative w-[110px] h-[110px] mx-auto">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
                  <circle cx="60" cy="60" r="48" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="10" />
                  <circle cx="60" cy="60" r="48" fill="none" stroke="url(#diagGrad)" strokeWidth="10" strokeLinecap="round"
                    strokeDasharray="301.59" strokeDashoffset={301.59 - 301.59 * (finalPercent / 100)} />
                  <defs><linearGradient id="diagGrad"><stop stopColor="#00f0ff"/><stop offset=".55" stopColor="#a855f7"/><stop offset="1" stopColor="#ec4899"/></linearGradient></defs>
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-[9px] text-cyan-300">BETÖLTÉS</span>
                  <span className="text-2xl font-black font-mono">{Math.floor(finalPercent)}%</span>
                </div>
              </div>
              <div className="space-y-2 min-w-0">
                <div className="text-sm font-bold text-cyan-200 truncate">{progress?.phase || (error ? 'HIBA' : 'Indítás…')}</div>
                <div className="text-xs text-slate-400 min-h-8">{progress?.detail || 'A rendszer méri a betöltés minden lépését.'}</div>
                <div className="h-2 rounded-full bg-slate-950 border border-cyan-900/60 overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-cyan-400 via-purple-500 to-pink-500 transition-all duration-200" style={{width: `${finalPercent}%`}} />
                </div>
                <div className="text-[10px] font-mono text-slate-500">ELTELT: {formatMs(elapsed)} • KÉRÉSEK: {events.filter(e => e.status === 'start').length}</div>
              </div>
            </div>

            {error ? (
              <div className="mt-4 rounded-2xl border border-rose-500/60 bg-rose-950/40 p-3 flex gap-2 text-rose-200 text-xs">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <b>BETÖLTÉSI HIBA</b>
                  <div className="mt-1 break-words">{error}</div>
                  {(onRetry || (retryInSeconds !== null && retryInSeconds !== undefined)) && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {onRetry && (
                        <button
                          onClick={onRetry}
                          className="px-3 py-2 rounded-xl bg-rose-400 hover:bg-rose-300 text-slate-950 font-black text-[11px] tracking-wide"
                        >
                          ÚJRAPRÓBÁLKOZÁS MOST
                        </button>
                      )}
                      {retryInSeconds !== null && retryInSeconds !== undefined && (
                        <span className="text-[11px] font-mono text-rose-200/90">
                          Automatikus újrapróbálkozás: {retryInSeconds} s
                        </span>
                      )}
                    </div>
                  )}
                  <div className="mt-2 text-[10px] text-rose-200/70 leading-relaxed">
                    A korábban letöltött csatornalista továbbra is használható – a frissítés csak
                    akkor cseréli le, ha teljesen lefut.
                  </div>
                </div>
              </div>
            ) : completed ? (
              <div className="mt-4 rounded-2xl border border-emerald-500/50 bg-emerald-950/30 p-3 flex gap-2 text-emerald-200 text-xs">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <div><b>BETÖLTÉS KÉSZ</b><div className="mt-1 text-emerald-300/80">A diagnosztika 10 másodperc múlva automatikusan bezárul.</div></div>
              </div>
            ) : null}

            {longRequest && !completed && !error && (
              <div className="mt-4 rounded-2xl border border-amber-500/60 bg-amber-950/30 p-3 flex gap-2 text-amber-200 text-xs">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <div><b>HOSSZÚ KÉRÉS / LEHETSÉGES AKADÁS</b><div className="mt-1">Egy hálózati kérés több mint 3 másodperce fut. A naplóban látható, melyik.</div></div>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
              <Metric icon={<Clock3 />} label="TELJES IDŐ" value={formatMs(elapsed)} />
              <Metric icon={<Network />} label="SIKERES" value={String(successful.length)} />
              <Metric icon={<Download />} label="ADAT" value={formatBytes(totalBytes)} />
              <Metric icon={<Gauge />} label="LEGHOSSZABB" value={formatMs(longestRequest)} />
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2 text-[10px] font-mono">
              <div className="rounded-xl bg-white/[.03] border border-cyan-950 p-2">ÁTLAGOS ÁTVITEL: <b className="text-cyan-300">{formatBytes(averageSpeed)}/s</b></div>
              <div className="rounded-xl bg-white/[.03] border border-cyan-950 p-2">HOSSZÚ UI FELADATOK: <b className={longTasks.length ? 'text-amber-400' : 'text-emerald-400'}>{longTasks.length}{longTasks.length ? ` • max ${formatMs(Math.max(...longTasks))}` : ''}</b></div>
            </div>

            {/* A csatornalogó-adatok csak a diagnosztikai másolatban szerepelnek; a doboz szándékosan nem látható. */}

            <div className="mt-4 rounded-2xl border border-cyan-900/60 bg-[#050a18]/90 overflow-hidden">
              <button
                type="button"
                onClick={() => setDiagnosticLogOpen((open) => !open)}
                className="w-full px-3 py-2 flex items-center justify-between border-b border-cyan-950 text-[10px] tracking-widest text-cyan-300 font-bold text-left"
                aria-expanded={diagnosticLogOpen}
              >
                <span>ÉLŐ DIAGNOSZTIKAI NAPLÓ</span>
                <span className="text-cyan-400">{diagnosticLogOpen ? '▲' : '▼'}</span>
              </button>
              {diagnosticLogOpen && (
                <div className="max-h-48 overflow-y-auto divide-y divide-cyan-950/60">
                  {events.length === 0 && <div className="p-3 text-xs text-slate-500">Még nincs hálózati kérés.</div>}
                  {events.slice(-30).map((event) => (
                    <div key={`${event.id}-${event.status}`} className="px-3 py-2 text-[10px] font-mono flex gap-2 items-start">
                      <span className={event.status === 'success' ? 'text-emerald-400' : event.status === 'error' ? 'text-rose-400' : 'text-cyan-400'}>{event.status === 'success' ? '✓' : event.status === 'error' ? '✕' : '→'}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-slate-300">{shortUrl(event.url)}</div>
                        <div className="text-slate-500">{event.status === 'start' ? 'INDULT' : event.error || `${event.httpStatus || ''} • ${formatMs(event.durationMs || 0)} • ${event.bytes ? formatBytes(event.bytes) : ''}`}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-mono">
              <div className="rounded-xl bg-white/[.03] border border-cyan-950 p-2">MAX KÉRÉSI SZÜNET: <b className="text-cyan-300">{formatMs(gaps)}</b></div>
              <div className="rounded-xl bg-white/[.03] border border-cyan-950 p-2">HIBÁS KÉRÉSEK: <b className={failed.length ? 'text-rose-400' : 'text-emerald-400'}>{failed.length}</b></div>
              <div className="rounded-xl bg-white/[.03] border border-cyan-950 p-2">AKTÍV KÉRÉSEK: <b className="text-purple-300">{activeRequests}</b></div>
              <div className="rounded-xl bg-white/[.03] border border-cyan-950 p-2">ÁLLAPOT: <b className={error ? 'text-rose-400' : completed ? 'text-emerald-400' : 'text-cyan-300'}>{error ? 'HIBA' : completed ? 'KÉSZ' : 'FOLYAMATBAN'}</b></div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button onClick={openCopyWindow} className="py-3 rounded-2xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-black text-sm tracking-wider">
                DIAGNOSZTIKA MÁSOLÁSA
              </button>
              <button onClick={onClose} className="py-3 rounded-2xl border border-cyan-800 bg-white/5 hover:bg-white/10 text-white font-black text-sm tracking-wider">
                DIAGNOSZTIKA BEZÁRÁSA
              </button>
            </div>
          </div>
        </div>
      </div>

      {copyWindowOpen && (
        <div role="dialog" aria-modal="true" aria-label="Diagnosztika másolás" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setCopyWindowOpen(false); } }} className="fixed inset-0 z-[120] flex items-center justify-center p-3 bg-[#020208]/80 backdrop-blur-sm" onCopy={(event) => event.preventDefault()} onCut={(event) => event.preventDefault()} onContextMenu={(event) => event.preventDefault()} style={{ userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}>
          <div className="w-full max-w-xl max-h-[calc(100dvh-24px)] rounded-3xl border border-cyan-400/50 bg-[#060816] shadow-[0_0_60px_rgba(0,240,255,0.22)] text-white overflow-hidden">
            <div className="p-4 border-b border-cyan-950 flex items-center justify-between">
              <div>
                <div className="text-[10px] tracking-[0.25em] text-cyan-300 font-bold">DIAGNOSZTIKA EREDMÉNYE</div>
                <h3 className="text-lg font-black">MÁSOLÁS</h3>
              </div>
              <button onClick={() => setCopyWindowOpen(false)} className="p-2 rounded-xl border border-cyan-800/60 bg-white/5 hover:bg-white/10">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4">
              {/*
                Szándékosan nem textarea: a TV távirányítójával a hosszú szövegmező
                nehezen kezelhető. Ez egy nem kijelölhető előnézet,
                a vágólapra kizárólag a MÁSOLÁS gomb ír.
              */}
              <pre
                aria-label="Diagnosztika előnézet (nem kijelölhető)"
                className="w-full h-[min(55dvh,420px)] overflow-auto whitespace-pre-wrap break-all rounded-2xl border border-cyan-900 bg-black/40 p-3 text-[10px] font-mono text-slate-300 select-none pointer-events-none"
                style={{ WebkitUserSelect: 'none', WebkitTouchCallout: 'none', userSelect: 'none' }}
              >
                {reportText}
              </pre>
              <p className="mt-2 text-[10px] text-slate-500 leading-relaxed">
                A vágólapra kizárólag a lenti <b className="text-slate-300">MÁSOLÁS</b> gomb ír,
                és csak akkor, ha te nyomod meg. Az előnézet ezért szándékosan nem jelölhető ki.
              </p>
              <button data-manual-copy-button="true" onClick={copyReport} className="w-full mt-3 py-3 rounded-2xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-black text-sm tracking-wider">
                {copied ? 'BEMÁSOLVA A VÁGÓLAPRA ✓' : 'MÁSOLÁS'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const Metric: React.FC<{icon: React.ReactNode; label: string; value: string}> = ({ icon, label, value }) => (
  <div className="rounded-xl border border-cyan-950 bg-white/[.025] p-2">
    <div className="flex items-center gap-1 text-[9px] text-slate-500">{React.cloneElement(icon as React.ReactElement<{ className?: string }>, { className: 'w-3 h-3' })}{label}</div>
    <div className="mt-1 text-xs font-black font-mono text-cyan-200">{value}</div>
  </div>
);

export default LoadingDiagnosticModal;
