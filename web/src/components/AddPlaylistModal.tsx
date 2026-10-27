import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTvModalNavigation } from '../hooks/useTvModalNavigation';
import { ProviderAccount } from '../types/iptv';
import { ImportedContent } from '../services/contentStore';
import type { PartialContent } from '../services/providerImport';
import { importM3UProvider, importXtreamProvider, ImportProgress } from '../services/providerImport';
import { setNetworkDiagnosticSink, NetworkDiagnosticEvent } from '../services/net';
import LoadingDiagnosticModal from './LoadingDiagnosticModal';
import { Server, Link, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

interface AddPlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddProvider: (newProvider: ProviderAccount, content?: ImportedContent) => void;
  editProvider?: ProviderAccount | null;
  onDiagnosticUpdate?: (snapshot: { providerId?: string; providerName: string; progress: ImportProgress | null; events: NetworkDiagnosticEvent[]; error: string | null; startedAt: number; finished: boolean; finishedAt?: number | null }) => void;
  onLiveChannelsLoaded?: (partial: PartialContent) => void;
  onBackgroundContinue?: () => void;
}

export const AddPlaylistModal: React.FC<AddPlaylistModalProps> = ({
  isOpen,
  onClose,
  onAddProvider,
  editProvider,
  onDiagnosticUpdate,
  onLiveChannelsLoaded,
  onBackgroundContinue,
}) => {
  const [tab, setTab] = useState<'xtream' | 'm3u'>(() => editProvider?.type === 'm3u' ? 'm3u' : 'xtream');

  // Xtream fields
  const [name, setName] = useState(editProvider?.name || '');
  const [serverUrl, setServerUrl] = useState(editProvider?.serverUrl || '');
  const [username, setUsername] = useState(editProvider?.username || '');
  const [password, setPassword] = useState(editProvider?.password || '');

  // M3U fields
  const [m3uUrl, setM3uUrl] = useState(editProvider?.m3uUrl || '');
  const { modalRef, handleKeyDown } = useTvModalNavigation(isOpen, onClose, [tab]);

  useEffect(() => {
    if (!isOpen) return;
    setTab(editProvider?.type === 'm3u' ? 'm3u' : 'xtream');
    setName(editProvider?.name || '');
    setServerUrl(editProvider?.serverUrl || '');
    setUsername(editProvider?.username || '');
    setPassword(editProvider?.password || '');
    setM3uUrl(editProvider?.m3uUrl || '');
    setStatusMessage(null);
    setProgress(null);
    setDiagnosticOpen(false);
    setDiagnosticEvents([]);
    setDiagnosticError(null);
    setDiagnosticFinishedAt(null);
    setLiveLoadedPromptOpen(false);
    promptShownRef.current = false;
  }, [isOpen, editProvider]);

  // Status state
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [diagnosticEvents, setDiagnosticEvents] = useState<NetworkDiagnosticEvent[]>([]);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [diagnosticStartedAt, setDiagnosticStartedAt] = useState(() => performance.now());
  const [diagnosticFinishedAt, setDiagnosticFinishedAt] = useState<number | null>(null);
  const diagnosticStartedAtRef = useRef(performance.now());
  const diagnosticEventsRef = useRef<NetworkDiagnosticEvent[]>([]);
  const [liveLoadedPromptOpen, setLiveLoadedPromptOpen] = useState(false);
  /**
   * Az ablak megnyílásakor AZONNAL a jobb oldali (alapértelmezett) gombra
   * kerül a fókusz, hogy a bal/jobb nyíl és az OK késlekedés nélkül működjön.
   */
  const livePromptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!liveLoadedPromptOpen) return;
    const focusDefault = () => {
      const container = livePromptRef.current;
      if (!container) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && container.contains(active)) return;
      const target = container.querySelector<HTMLElement>('[data-tv-default]')
        || container.querySelector<HTMLElement>('button:not(:disabled)');
      target?.focus({ preventScroll: true } as any);
    };
    focusDefault();
    const first = window.setTimeout(focusDefault, 60);
    const second = window.setTimeout(focusDefault, 220);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
    };
  }, [liveLoadedPromptOpen]);
  const diagnosticFinishedRef = useRef(false);
  /** A „folyamat vagy csatornák” kérdést importonként egyszer tesszük fel. */
  const promptShownRef = useRef(false);

  if (!isOpen) return null;

  const handleTestAndConnectXtream = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serverUrl || !username || !password) {
      setStatusMessage({ type: 'error', text: 'Kérlek töltsd ki minden mezőt!' });
      return;
    }

    const providerName = name.trim() || username.trim();
    setIsLoading(true);
    setStatusMessage(null);
    setProgress({ phase: 'Kapcsolódás…', percent: 2 });
    setDiagnosticOpen(true);
    setDiagnosticError(null);
    setDiagnosticEvents([]);
    diagnosticEventsRef.current = [];
    setDiagnosticFinishedAt(null);
    const startedAt = performance.now();
    setDiagnosticStartedAt(startedAt);
    diagnosticStartedAtRef.current = startedAt;
    diagnosticFinishedRef.current = false;
    promptShownRef.current = false;
    setNetworkDiagnosticSink((event) => {
      if (diagnosticFinishedRef.current) return;
      setDiagnosticEvents((prev) => {
        const next = [...prev, event].slice(-250);
        diagnosticEventsRef.current = next;
        onDiagnosticUpdate?.({ providerName: providerName, progress, events: next, error: null, startedAt: diagnosticStartedAtRef.current, finished: false });
        return next;
      });
    });

    try {
      const result = await importXtreamProvider(
        { name: providerName, serverUrl, username, password },
        (update) => {
          if (!diagnosticFinishedRef.current && update.percent < 100) {
            setProgress(update);
            onDiagnosticUpdate?.({ providerName: providerName, progress: update, events: diagnosticEventsRef.current, error: null, startedAt: diagnosticStartedAtRef.current, finished: false });
          }
        },
        (partial) => {
          if (partial.channels?.length) {
            onLiveChannelsLoaded?.(partial);
            promptShownRef.current = true;
            setDiagnosticOpen(true);
            setLiveLoadedPromptOpen(true);
          }
        }
      );
      const content = result.content;

      const provider: ProviderAccount = {
        id: content.provider.id,
        name: providerName,
        type: 'xtream',
        serverUrl: content.provider.serverUrl,
        username: content.provider.username,
        password: content.provider.password,
        isActive: true,
        status: 'active',
        channelsCount: content.channels.length,
        moviesCount: content.movies.length,
        seriesCount: content.series.length,
        lastUpdated: new Date().toISOString().slice(0, 10).replace(/-/g, '. ') + '.',
        expireDate: result.user.expireDate,
        maxConnections: result.user.maxConnections,
      };

      onAddProvider(provider, content);
      setIsLoading(false);
      diagnosticFinishedRef.current = true;
      const finishedAt = performance.now();
      const finalProgress = { phase: 'Kész', detail: `${content.channels.length.toLocaleString('hu-HU')} csatorna • ${content.movies.length.toLocaleString('hu-HU')} film • ${content.series.length.toLocaleString('hu-HU')} sorozat`, percent: 100 };
      setProgress(finalProgress);
      setDiagnosticFinishedAt(finishedAt);
      /* 2.5.137: a kérdéses ablak NEM tűnhet el automatikusan. Ha a részleges
         callback nem jött volna (gyors bulk import), a végén akkor is megkérdezzük:
         folyamat vagy csatornák. A diagnosztika is NYITVA marad a döntésig. */
      if (!promptShownRef.current) {
        promptShownRef.current = true;
        setDiagnosticOpen(true);
        setLiveLoadedPromptOpen(true);
      }
      onDiagnosticUpdate?.({ providerId: provider.id, providerName: provider.name, progress: finalProgress, events: diagnosticEventsRef.current, error: null, startedAt: diagnosticStartedAtRef.current, finished: true, finishedAt });
      setNetworkDiagnosticSink(null);
    } catch (error) {
      setIsLoading(false);
      diagnosticFinishedRef.current = true;
      const finishedAt = performance.now();
      setNetworkDiagnosticSink(null);
      setDiagnosticFinishedAt(finishedAt);
      const message = error instanceof Error ? error.message : 'Szerver csatlakozási hiba.';
      setDiagnosticError(message);
      setLiveLoadedPromptOpen(false);
      onDiagnosticUpdate?.({ providerName: providerName, progress, events: diagnosticEventsRef.current, error: message, startedAt: diagnosticStartedAtRef.current, finished: true, finishedAt });
      setStatusMessage({ type: 'error', text: message });
    }
  };

  const handleConnectM3U = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!m3uUrl.trim()) {
      setStatusMessage({ type: 'error', text: 'Kérlek adj meg egy érvényes M3U URL-t!' });
      return;
    }
    const providerName = name.trim() || (() => { try { return new URL(m3uUrl).hostname; } catch { return 'M3U Playlist'; } })();

    setIsLoading(true);
    setStatusMessage(null);
    setProgress({ phase: 'M3U lista letöltése…', percent: 5 });
    setDiagnosticOpen(true);
    setDiagnosticError(null);
    setDiagnosticEvents([]);
    diagnosticEventsRef.current = [];
    setDiagnosticFinishedAt(null);
    const startedAt = performance.now();
    setDiagnosticStartedAt(startedAt);
    diagnosticStartedAtRef.current = startedAt;
    diagnosticFinishedRef.current = false;
    promptShownRef.current = false;
    setNetworkDiagnosticSink((event) => {
      if (diagnosticFinishedRef.current) return;
      setDiagnosticEvents((prev) => {
        const next = [...prev, event].slice(-250);
        diagnosticEventsRef.current = next;
        onDiagnosticUpdate?.({ providerName: providerName, progress, events: next, error: null, startedAt: diagnosticStartedAtRef.current, finished: false });
        return next;
      });
    });

    try {
      const content = await importM3UProvider(
        { name: providerName, m3uUrl },
        (update) => {
          if (!diagnosticFinishedRef.current && update.percent < 100) {
            setProgress(update);
            onDiagnosticUpdate?.({ providerName: providerName, progress: update, events: diagnosticEvents, error: null, startedAt: diagnosticStartedAtRef.current, finished: false });
          }
        }
      );

      const provider: ProviderAccount = {
        id: content.provider.id,
        name: providerName,
        type: 'm3u',
        m3uUrl: m3uUrl.trim(),
        isActive: true,
        status: 'active',
        channelsCount: content.channels.length,
        moviesCount: content.movies.length,
        seriesCount: content.series.length,
        lastUpdated: new Date().toISOString().slice(0, 10).replace(/-/g, '. ') + '.',
        expireDate: 'Korlátlan',
        maxConnections: 1,
      };

      onAddProvider(provider, content);
      setIsLoading(false);
      diagnosticFinishedRef.current = true;
      const finishedAt = performance.now();
      const finalProgress = { phase: 'Kész', detail: `${content.channels.length.toLocaleString('hu-HU')} csatorna • ${content.movies.length.toLocaleString('hu-HU')} film • ${content.series.length.toLocaleString('hu-HU')} sorozat`, percent: 100 };
      setProgress(finalProgress);
      setDiagnosticFinishedAt(finishedAt);
      onDiagnosticUpdate?.({ providerId: provider.id, providerName: provider.name, progress: finalProgress, events: diagnosticEventsRef.current, error: null, startedAt: diagnosticStartedAtRef.current, finished: true, finishedAt });
      setNetworkDiagnosticSink(null);
    } catch (error) {
      setIsLoading(false);
      diagnosticFinishedRef.current = true;
      const finishedAt = performance.now();
      setNetworkDiagnosticSink(null);
      setDiagnosticFinishedAt(finishedAt);
      const message = error instanceof Error ? error.message : 'Nem sikerült letölteni vagy feldolgozni az M3U fájlt.';
      setDiagnosticError(message);
      onDiagnosticUpdate?.({ providerName: providerName, progress, events: diagnosticEventsRef.current, error: message, startedAt: diagnosticStartedAtRef.current, finished: true, finishedAt });
      setStatusMessage({ type: 'error', text: message });
    }
  };


  const closeDiagnostic = (afterClose: () => void = onClose) => {
    diagnosticFinishedRef.current = true;
    setNetworkDiagnosticSink(null);
    setDiagnosticOpen(false);
    setProgress(null);
    setDiagnosticError(null);
    setDiagnosticFinishedAt(null);
    afterClose();
  };

  // A listaűrlap legyen a beállítások (z-50) fölött, de a diagnosztika (z-100) alatt.
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm animate-fadeIn select-none">
      <div ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} onKeyDown={handleKeyDown} className="bg-[#081329] border border-cyan-800/60 rounded-3xl max-w-5xl w-full max-h-[94dvh] min-h-0 flex flex-col shadow-2xl animate-scaleUp overflow-hidden focus:outline-none">
        
        {/* Header */}
        <div className="p-6 bg-[#0a1835] border-b border-cyan-950 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="w-7 h-7 text-cyan-400 stroke-[2.5]" />
            <h2 className="text-2xl sm:text-3xl font-black text-white tracking-wide">
              {editProvider ? 'SZOLGÁLTATÓ SZERKESZTÉSE' : 'ÚJ LISTA / SZOLGÁLTATÓ HOZZÁADÁSA'}
            </h2>
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="p-4 bg-[#070e1e] border-b border-cyan-950/60 flex items-center gap-3">
          <button
            onClick={() => setTab('xtream')}
            className={`flex-1 py-3 px-4 rounded-xl text-base font-black transition-all flex items-center justify-center gap-2 ${
              tab === 'xtream'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                : 'bg-[#0e1d3b] text-slate-300 hover:bg-[#13274e]'
            }`}
          >
            <Server className="w-5 h-5" />
            <span>Xtream Codes API</span>
          </button>

          <button
            onClick={() => setTab('m3u')}
            className={`flex-1 py-2 px-3 rounded-xl text-sm font-black transition-all flex items-center justify-center gap-1.5 ${
              tab === 'm3u'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                : 'bg-[#0e1d3b] text-slate-300 hover:bg-[#13274e]'
            }`}
          >
            <Link className="w-5 h-5" />
            <span>M3U URL</span>
          </button>
        </div>

        {/* Body Form */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {statusMessage && (
            <div
              className={`p-3 rounded-2xl flex items-center gap-2 text-sm font-bold ${
                statusMessage.type === 'success'
                  ? 'bg-emerald-950/50 border border-emerald-500/50 text-emerald-300'
                  : 'bg-rose-950/50 border border-rose-500/50 text-rose-300'
              }`}
            >
              {statusMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0" />
              )}
              <span>{statusMessage.text}</span>
            </div>
          )}

          {isLoading && (
            <div className="space-y-1.5">
              <div className="h-2 w-full rounded-full bg-[#0d1d3d] border border-cyan-900/50 overflow-hidden">
                <div
                  className="h-full bg-cyan-400 transition-all duration-300"
                  style={{ width: `${progress?.percent ?? 5}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-sm text-slate-400">
                <span>{progress?.detail || progress?.phase || 'Kapcsolódás…'}</span>
                <span className="font-bold text-cyan-300">{progress?.percent ?? 0}%</span>
              </div>
            </div>
          )}

          {tab === 'xtream' ? (
            <form onSubmit={handleTestAndConnectXtream} className="space-y-3.5">
              <div>
                <label className="text-sm font-bold text-slate-300 block mb-1">
                  Szerver URL / Host (Porttal) *
                </label>
                <input
                  type="text"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="http://iptv-server.com:8080"
                  required
                  className="w-full bg-[#0d1d3d] border border-cyan-900/60 rounded-xl px-3 py-2 text-sm text-white focus:outline-hidden focus:border-cyan-400 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-sm font-bold text-slate-300 block mb-1">
                    Felhasználónév *
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Username"
                    required
                    className="w-full bg-[#0d1d3d] border border-cyan-900/60 rounded-xl px-3 py-2 text-sm text-white focus:outline-hidden focus:border-cyan-400 font-mono"
                  />
                </div>

                <div>
                  <label className="text-sm font-bold text-slate-300 block mb-1">
                    Jelszó *
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password"
                    required
                    className="w-full bg-[#0d1d3d] border border-cyan-900/60 rounded-xl px-3 py-2 text-sm text-white focus:outline-hidden focus:border-cyan-400 font-mono"
                  />
                </div>
              </div>

              <p className="text-sm leading-relaxed text-slate-400 bg-[#0b1832] border border-cyan-950/70 rounded-xl p-3">
                A szolgáltatótól kapott <span className="text-cyan-300 font-bold">szerver címet</span> (pl.{' '}
                <span className="font-mono text-cyan-200">http://szerver:8080</span>),{' '}
                <span className="text-cyan-300 font-bold">felhasználónevet</span> és{' '}
                <span className="text-cyan-300 font-bold">jelszót</span> írd be. A program ilyenkor letölti a
                csatornákat, filmeket és sorozatokat – ez néhány percig is eltarthat.
              </p>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-4 rounded-2xl bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 text-slate-950 font-black text-lg flex items-center justify-center gap-3 shadow-xl shadow-cyan-400/30 active:scale-95 transition-all mt-3"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{progress?.phase || 'Kapcsolódás a szerverhez...'}</span>
                  </>
                ) : (
                  <>
                    <Server className="w-4 h-4" />
                    <span>Csatlakozás és csatornák letöltése</span>
                  </>
                )}
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              <form onSubmit={handleConnectM3U} className="space-y-3.5">
                <div>
                  <label className="text-sm font-bold text-slate-300 block mb-1">
                    M3U / M3U8 Playlist URL *
                  </label>
                  <input
                    type="url"
                    value={m3uUrl}
                    onChange={(e) => setM3uUrl(e.target.value)}
                    placeholder="https://example.com/playlist.m3u8"
                    className="w-full bg-[#0d1d3d] border border-cyan-900/60 rounded-xl px-3 py-3 text-base text-white focus:outline-hidden focus:border-cyan-400 font-mono"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-4 rounded-2xl bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 text-slate-950 font-black text-lg flex items-center justify-center gap-3 shadow-xl shadow-cyan-400/30 active:scale-95 transition-all"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Feldolgozás...</span>
                    </>
                  ) : (
                    <>
                      <Link className="w-4 h-4" />
                      <span>M3U Letöltése és Betöltése</span>
                    </>
                  )}
                </button>
              </form>

            </div>
          )}
        </div>
      </div>
      {liveLoadedPromptOpen && createPortal(
        <div ref={livePromptRef} role="dialog" aria-modal="true" aria-label="Az élő TV-csatornák betöltve" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setLiveLoadedPromptOpen(false); } }} className="fixed inset-0 flex items-center justify-center p-4 bg-black/75" style={{ zIndex: 2147482000 }}>
          <div className="w-full max-w-lg rounded-2xl border border-cyan-400/50 bg-[#081329] p-6 text-white shadow-2xl">
            <div className="text-xl font-black text-cyan-200">Az élő TV-csatornák betöltve</div>
            <p className="mt-3 text-base text-slate-300">A filmek és sorozatok betöltése még folyamatban van. Mit szeretnél?</p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              {/* A FOLYAMATOT nézi: a diagnosztikai ablak NYITVA marad. */}
              <button onClick={() => { setLiveLoadedPromptOpen(false); setDiagnosticOpen(true); }} className="py-3 rounded-xl border border-cyan-500/60 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-100 font-bold">Folyamat megtekintése</button>
              {/* A CSATORNÁKAT nézi: minden ablak bezárul, a főoldal látszik. */}
              <button data-tv-default="" onClick={() => { setLiveLoadedPromptOpen(false); closeDiagnostic(onBackgroundContinue || onClose); }} className="py-3 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-black">Csatornák megtekintése</button>
            </div>
          </div>
        </div>, document.body)}
      {diagnosticOpen && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 2147481000 }}>
          <LoadingDiagnosticModal
            isOpen
            progress={progress}
            events={diagnosticEvents}
            error={diagnosticError}
            startedAt={diagnosticStartedAt}
            finishedAt={diagnosticFinishedAt}
            onClose={closeDiagnostic}
          />
        </div>, document.body)}
    </div>
  );
};
