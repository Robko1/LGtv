import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Download, Gauge, Network } from 'lucide-react';
import type { ImportProgress } from '../services/providerImport';
import type { NetworkDiagnosticEvent } from '../services/net';
import type { Channel } from '../types/iptv';
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
  onRetry?: () => void;
  retryInSeconds?: number | null;
}

/** Megőrizzük az exportot, mert más diagnosztikai modulok is használhatják. */
const clipboardLog: string[] = [];
export function reportClipboardLog(what: string): void {
  clipboardLog.push(`${new Date().toLocaleTimeString()} ${what}`);
  if (clipboardLog.length > 20) clipboardLog.shift();
}

const formatMs = (value: number) => value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const formatBytes = (value: number) => value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(2)} MB`;

export const LoadingDiagnosticModal: React.FC<LoadingDiagnosticModalProps> = ({
  isOpen, progress, events, error, startedAt, onClose, onRetry, retryInSeconds,
}) => {
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (!isOpen) return;
    const timerId = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timerId);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || (!error && progress?.percent !== 100)) return;
    const closeTimer = window.setTimeout(onClose, 10_000);
    return () => window.clearTimeout(closeTimer);
  }, [isOpen, error, progress?.percent, onClose]);

  if (!isOpen) return null;

  const elapsed = Math.max(0, now - startedAt);
  const completed = !error && progress?.percent === 100;
  const finalPercent = completed ? 100 : Math.min(99, Math.max(0, progress?.percent || 0));
  const successful = events.filter((event) => event.status === 'success');
  const totalBytes = successful.reduce((sum, event) => sum + (event.bytes || 0), 0);
  const longestRequest = Math.max(0, ...successful.map((event) => event.durationMs || 0));
  const requestCount = events.filter((event) => event.status === 'start').length;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-2 sm:p-3 bg-[#020208]/95 backdrop-blur-md select-none"
      onCopy={(event) => event.preventDefault()}
      onCut={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
      style={{ userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="loading-diagnostic-title"
        className="relative w-[96vw] max-w-[1500px] h-[min(94dvh,900px)] overflow-hidden rounded-3xl border border-cyan-400/40 bg-[#060816]/95 shadow-[0_0_60px_rgba(0,240,255,0.18)] text-white flex flex-col"
      >
        <div className="absolute inset-0 pointer-events-none opacity-30 bg-[radial-gradient(circle_at_center,transparent_15%,#020208_90%)]" />
        <div className="relative flex flex-col h-full p-4 sm:p-7 lg:p-9">
          <header className="shrink-0 mb-5 sm:mb-8 border-b border-cyan-950/80 pb-4">
            <div className="text-[10px] sm:text-xs tracking-[0.25em] text-cyan-300 font-bold">QUANTUM IPTV CORE • v{packageJson.version}</div>
            <h2 id="loading-diagnostic-title" className="text-xl sm:text-2xl lg:text-3xl font-black tracking-wider">BETÖLTÉSI DIAGNOSZTIKA</h2>
          </header>

          <div className="relative grid grid-cols-[minmax(110px,0.7fr)_minmax(0,2fr)] sm:grid-cols-[minmax(150px,0.65fr)_minmax(0,2fr)] lg:grid-cols-[minmax(190px,0.55fr)_minmax(0,2fr)] gap-4 sm:gap-8 lg:gap-12 items-center flex-1 min-h-0">
            <div className="relative w-full max-w-[230px] aspect-square mx-auto">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120" aria-hidden="true">
                <circle cx="60" cy="60" r="48" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="9" />
                <circle cx="60" cy="60" r="48" fill="none" stroke="url(#diagGrad)" strokeWidth="9" strokeLinecap="round"
                  strokeDasharray="301.59" strokeDashoffset={301.59 - 301.59 * (finalPercent / 100)} />
                <defs><linearGradient id="diagGrad"><stop stopColor="#00f0ff"/><stop offset=".55" stopColor="#a855f7"/><stop offset="1" stopColor="#ec4899"/></linearGradient></defs>
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[10px] sm:text-xs text-cyan-300 tracking-widest">BETÖLTÉS</span>
                <span className="text-3xl sm:text-4xl lg:text-5xl font-black font-mono">{Math.floor(finalPercent)}%</span>
              </div>
            </div>

            <div className="space-y-4 sm:space-y-6 min-w-0">
              <div>
                <div className="text-base sm:text-xl lg:text-2xl font-bold text-cyan-200 break-words">{progress?.phase || (error ? 'HIBA' : 'Indítás…')}</div>
                <div className="mt-2 text-sm sm:text-base text-slate-400">{progress?.detail || 'A rendszer méri a betöltés minden lépését.'}</div>
              </div>
              <div className="h-3 sm:h-4 rounded-full bg-slate-950 border border-cyan-900/60 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-cyan-400 via-purple-500 to-pink-500 transition-all duration-200" style={{ width: `${finalPercent}%` }} />
              </div>
              <div className="text-xs sm:text-sm font-mono text-slate-500">ELTELT IDŐ: {formatMs(elapsed)} <span className="mx-2 text-cyan-800">•</span> HÁLÓZATI KÉRÉSEK: {requestCount}</div>
            </div>
          </div>

          {error ? (
            <div className="relative shrink-0 mt-4 sm:mt-6 rounded-2xl border border-rose-500/60 bg-rose-950/40 p-3 sm:p-4 flex gap-3 text-rose-200 text-xs sm:text-sm">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <b>BETÖLTÉSI HIBA</b>
                <div className="mt-1 break-words">{error}</div>
                {(onRetry || retryInSeconds !== null && retryInSeconds !== undefined) && (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {onRetry && <button onClick={onRetry} className="px-4 py-2 rounded-xl bg-rose-400 hover:bg-rose-300 text-slate-950 font-black text-xs tracking-wide">ÚJRAPRÓBÁLKOZÁS MOST</button>}
                    {retryInSeconds !== null && retryInSeconds !== undefined && <span className="font-mono">Automatikus újrapróbálkozás: {retryInSeconds} s</span>}
                  </div>
                )}
                <div className="mt-2 text-[10px] sm:text-xs text-rose-200/70 leading-relaxed">A korábban letöltött csatornalista továbbra is használható – a frissítés csak akkor cseréli le, ha teljesen lefut.</div>
              </div>
            </div>
          ) : completed ? (
            <div className="relative shrink-0 mt-4 sm:mt-6 rounded-2xl border border-emerald-500/50 bg-emerald-950/30 p-3 sm:p-4 flex gap-3 text-emerald-200 text-xs sm:text-sm">
              <CheckCircle2 className="w-5 h-5 shrink-0" />
              <div><b>BETÖLTÉS KÉSZ</b><div className="mt-1 text-emerald-300/80">A diagnosztika 10 másodperc múlva automatikusan bezárul.</div></div>
            </div>
          ) : null}

          <div className="relative shrink-0 grid grid-cols-4 gap-2 sm:gap-4 mt-5 sm:mt-8">
            <Metric icon={<Clock3 />} label="TELJES IDŐ" value={formatMs(elapsed)} />
            <Metric icon={<Network />} label="SIKERES" value={String(successful.length)} />
            <Metric icon={<Download />} label="ADAT" value={formatBytes(totalBytes)} />
            <Metric icon={<Gauge />} label="LEGHOSSZABB" value={formatMs(longestRequest)} />
          </div>
        </div>
      </div>
    </div>
  );
};

const Metric: React.FC<{icon: React.ReactNode; label: string; value: string}> = ({ icon, label, value }) => (
  <div className="min-w-0 rounded-xl sm:rounded-2xl border border-cyan-950 bg-white/[.025] p-2 sm:p-4 lg:p-5">
    <div className="flex items-center gap-1 sm:gap-2 text-[8px] sm:text-xs lg:text-sm text-slate-500 truncate">
      {React.cloneElement(icon as React.ReactElement<{ className?: string }>, { className: 'w-3 h-3 sm:w-4 sm:h-4 shrink-0' })}
      <span className="truncate">{label}</span>
    </div>
    <div className="mt-1 sm:mt-2 text-xs sm:text-base lg:text-xl font-black font-mono text-cyan-200 break-words">{value}</div>
  </div>
);

export default LoadingDiagnosticModal;
