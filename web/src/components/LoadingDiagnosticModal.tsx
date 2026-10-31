import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Download, Gauge, Network } from 'lucide-react';
import type { ImportProgress } from '../services/providerImport';
import type { NetworkDiagnosticEvent } from '../services/net';
import type { Channel } from '../types/iptv';
import { normalizeTvKey } from '../utils/tvKeys';

interface LoadingDiagnosticModalProps {
  isOpen: boolean;
  progress: ImportProgress | null;
  events: NetworkDiagnosticEvent[];
  channels?: Channel[];
  logoSource?: 'xtream' | 'm3u' | 'unknown';
  error: string | null;
  startedAt: number;
  /** Monotonically measured completion time; a finished snapshot must stay frozen when reopened. */
  finishedAt?: number | null;
  onClose: () => void;
  onRetry?: () => void;
  retryInSeconds?: number | null;
  /**
   * VÁLTOZÁS-MEGERŐSÍTÉS (2.5.237): ha a gyors ellenőrzés változást talált
   * a szolgáltatónál, ez a szöveg jelenik meg kérdésként, és a letöltés
   * csak az „Igen” válasz után indul el.
   */
  changePrompt?: string | null;
  onChangeDecision?: (proceed: boolean) => void;
}

const formatMs = (value: number) => value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
/** Futó stopperóra perc:másodperc alakban – nagy terhelésnél sem mutat "beragadt" századokat. */
const formatElapsedClock = (value: number) => {
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
};
const formatBytes = (value: number) => value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(2)} MB`;

export const LoadingDiagnosticModal: React.FC<LoadingDiagnosticModalProps> = ({
  isOpen, progress, events, error, startedAt, finishedAt, onClose, onRetry, retryInSeconds,
  changePrompt, onChangeDecision,
}) => {
  const [now, setNow] = useState(() => performance.now());
  const completed = !error && (progress?.percent ?? 0) >= 100;
  const terminal = Boolean(error || completed);
  const promptActive = Boolean(changePrompt && onChangeDecision && !terminal);
  // A kérdés két gombja közül a kijelölt (0 = Igen, 1 = Most nem).
  const [promptChoice, setPromptChoice] = useState(0);
  useEffect(() => { setPromptChoice(0); }, [changePrompt]);

  useEffect(() => {
    if (!isOpen) return;
    // A kész snapshot lehet, hogy csak később nyílik meg újra. Ilyenkor a
    // lezárási időt használjuk, nem a megnyitás pillanatát, és nincs több
    // intervallum, amely a háttérben tovább számolna.
    setNow(terminal && finishedAt !== null && finishedAt !== undefined ? finishedAt : performance.now());
    if (terminal) return;
    /*
     * 2.5.233: másodpercenként elég frissíteni. A kijelzett érték mindig a
     * valós órakülönbség (performance.now() - startedAt), ezért ha a TV nagy
     * terhelés alatt kihagy néhány frissítést, a következő tick azonnal a
     * HELYES, teljes eltelt időre ugrik – az óra nem "veszít" időt. A korábbi
     * 250 ms-os újrarajzolás viszont feleslegesen terhelte a TV-t a betöltés
     * legnehezebb szakaszában.
     */
    const timerId = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(timerId);
  }, [isOpen, terminal, finishedAt]);

  useEffect(() => {
    if (!isOpen || !terminal) return;
    const closeTimer = window.setTimeout(onClose, 10_000);
    return () => window.clearTimeout(closeTimer);
  }, [isOpen, terminal, onClose]);

  /*
   * A VISSZA GOMB MINDIG BEZÁRJA AZ ABLAKOT (2.5.224).
   *
   * A felhasználó jelezte: a betöltési diagnosztikát a távirányító VISSZA
   * gombja nem zárta be. Az ok: az ablak a Beállításokból indított frissítésnél
   * nyílik ki, de a fókusz a Beállítások gombján marad – így sem az ablak
   * React-kezelője (nincs rajta fókusz), sem az App globális kezelője (a
   * settings-tulajdonú elemeknél korán visszatér) nem kapta meg a gombot.
   * Ez az ablak-szintű, elfogó (capture) kezelő minden más előtt fut, ezért
   * a VISSZA akkor is bezár, ha a fókusz bárhol máshol ragadt.
   * A háttérben futó frissítést a bezárás nem szakítja meg.
   */
  useEffect(() => {
    if (!isOpen) return;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      // Aktív változás-kérdésnél a VISSZA nem bezárás, hanem „Most nem” válasz –
      // azt a kérdés saját kezelője intézi (lent), itt nem nyúlunk hozzá.
      if (promptActive) return;
      const key = normalizeTvKey(event);
      if (key !== 'Escape' && key !== 'Backspace') return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onWindowKeyDown, true);
    return () => window.removeEventListener('keydown', onWindowKeyDown, true);
  }, [isOpen, onClose, promptActive]);

  /*
   * A VÁLTOZÁS-KÉRDÉS TÁVIRÁNYÍTÓS KEZELÉSE – ablakszintű, elfogó (capture)
   * kezelővel, mert a fókusz ilyenkor jellemzően a Beállítások Frissítés
   * gombján ragadt (lásd a fenti VISSZA-kezelő magyarázatát). Balra/jobbra:
   * választás, OK: megerősítés, VISSZA: „Most nem”. Minden irány- és OK
   * gombot elnyelünk, hogy a háttérben lévő felület ne mozduljon.
   */
  useEffect(() => {
    if (!isOpen || !promptActive || !onChangeDecision) return;
    const onPromptKeyDown = (event: KeyboardEvent) => {
      const key = normalizeTvKey(event);
      const swallow = () => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      };
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        swallow();
        setPromptChoice((choice) => (choice === 0 ? 1 : 0));
        return;
      }
      if (key === 'Enter' || key === ' ') {
        swallow();
        onChangeDecision(promptChoice === 0);
        return;
      }
      if (key === 'Escape' || key === 'Backspace') {
        swallow();
        onChangeDecision(false);
        return;
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') swallow();
    };
    window.addEventListener('keydown', onPromptKeyDown, true);
    return () => window.removeEventListener('keydown', onPromptKeyDown, true);
  }, [isOpen, promptActive, onChangeDecision, promptChoice]);

  const handleModalKeyDown = (event: React.KeyboardEvent) => {
    const key = normalizeTvKey(event);
    if (key === 'Escape' || key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  if (!isOpen) return null;

  const elapsed = Math.max(0, now - startedAt);
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
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="loading-diagnostic-title"
        tabIndex={-1}
        onKeyDown={handleModalKeyDown}
        className="relative w-[96vw] max-w-[1500px] h-[min(94dvh,900px)] overflow-hidden rounded-3xl border border-cyan-400/40 bg-[#060816]/95 shadow-[0_0_60px_rgba(0,240,255,0.18)] text-white flex flex-col focus:outline-none"
      >
        <div className="absolute inset-0 pointer-events-none opacity-30 bg-[radial-gradient(circle_at_center,transparent_15%,#020208_90%)]" />
        <div className="relative flex flex-col h-full p-4 sm:p-7 lg:p-9">
          <header className="shrink-0 mb-5 sm:mb-8 border-b border-cyan-950/80 pb-4">
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
                <div className="text-xl sm:text-2xl lg:text-3xl font-bold text-cyan-200 break-words">{progress?.phase || (error ? 'HIBA' : 'Indítás…')}</div>
                <div className="mt-2 text-lg sm:text-xl lg:text-2xl text-slate-300 break-words">{progress?.detail || 'A rendszer méri a betöltés minden lépését.'}</div>
              </div>
              <div className="h-3 sm:h-4 rounded-full bg-slate-950 border border-cyan-900/60 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-cyan-400 via-purple-500 to-pink-500 transition-all duration-200" style={{ width: `${finalPercent}%` }} />
              </div>
              <div className="text-base sm:text-xl lg:text-2xl font-mono text-slate-300">ELTELT IDŐ: {formatElapsedClock(elapsed)} <span className="mx-2 text-cyan-700">•</span> HÁLÓZATI KÉRÉSEK: {requestCount}</div>
            </div>
          </div>

          {promptActive && (
            /* VÁLTOZÁS A SZOLGÁLTATÓNÁL – a letöltés csak az Igen után indul. */
            <div className="relative shrink-0 mt-4 sm:mt-6 rounded-2xl border border-amber-400/70 bg-amber-950/40 p-3 sm:p-4 text-amber-100 text-xl sm:text-2xl lg:text-3xl">
              <b>VÁLTOZÁS A SZOLGÁLTATÓNÁL</b>
              <div className="mt-1 break-words">{changePrompt}</div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => onChangeDecision?.(true)}
                  className={`px-5 py-2 rounded-xl font-black text-xl sm:text-2xl lg:text-3xl tracking-wide transition-all ${
                    promptChoice === 0
                      ? 'bg-amber-300 text-slate-950 ring-4 ring-amber-200 scale-105'
                      : 'bg-amber-900/60 text-amber-200 border border-amber-500/50'
                  }`}
                >
                  IGEN, LETÖLTÉS
                </button>
                <button
                  onClick={() => onChangeDecision?.(false)}
                  className={`px-5 py-2 rounded-xl font-black text-xl sm:text-2xl lg:text-3xl tracking-wide transition-all ${
                    promptChoice === 1
                      ? 'bg-amber-300 text-slate-950 ring-4 ring-amber-200 scale-105'
                      : 'bg-amber-900/60 text-amber-200 border border-amber-500/50'
                  }`}
                >
                  MOST NEM
                </button>
              </div>
              <div className="mt-2 text-lg sm:text-xl lg:text-2xl text-amber-200/80 leading-snug">
                Balra/jobbra: választás • OK: megerősítés • VISSZA: most nem
              </div>
            </div>
          )}

          {error ? (
            <div className="relative shrink-0 mt-4 sm:mt-6 max-h-[38vh] overflow-y-auto rounded-2xl border border-rose-500/60 bg-rose-950/40 p-3 sm:p-4 flex gap-3 text-rose-200 text-xl sm:text-2xl lg:text-3xl">
              <AlertTriangle className="w-6 h-6 lg:w-8 lg:h-8 shrink-0" />
              <div className="min-w-0 flex-1">
                <b>BETÖLTÉSI HIBA</b>
                <div className="mt-1 break-words">{error}</div>
                {(onRetry || retryInSeconds !== null && retryInSeconds !== undefined) && (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {onRetry && <button onClick={onRetry} className="px-4 py-2 rounded-xl bg-rose-400 hover:bg-rose-300 text-slate-950 font-black text-xl sm:text-2xl lg:text-3xl tracking-wide">ÚJRAPRÓBÁLKOZÁS MOST</button>}
                    {retryInSeconds !== null && retryInSeconds !== undefined && <span className="font-mono">Automatikus újrapróbálkozás: {retryInSeconds} s</span>}
                  </div>
                )}
                <div className="mt-2 text-lg sm:text-xl lg:text-2xl text-rose-200/80 leading-snug">A korábban letöltött csatornalista továbbra is használható – a frissítés csak akkor cseréli le, ha teljesen lefut.</div>
              </div>
            </div>
          ) : completed ? (
            <div className="relative shrink-0 mt-4 sm:mt-6 rounded-2xl border border-emerald-500/50 bg-emerald-950/30 p-3 sm:p-4 flex gap-3 text-emerald-200 text-xl sm:text-2xl lg:text-3xl">
              <CheckCircle2 className="w-6 h-6 lg:w-8 lg:h-8 shrink-0" />
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
    {/* A felirat és a szám is akkora, mint a felső fehér cím. */}
    <div className="flex items-center gap-1 sm:gap-2 text-xl sm:text-2xl lg:text-3xl text-slate-400">
      {React.cloneElement(icon as React.ReactElement<{ className?: string }>, { className: 'w-4 h-4 sm:w-6 sm:h-6 shrink-0' })}
      <span className="break-words">{label}</span>
    </div>
    <div className="mt-1 sm:mt-2 text-xl sm:text-2xl lg:text-3xl font-black font-mono text-cyan-200 break-words">{value}</div>
  </div>
);

export default LoadingDiagnosticModal;
