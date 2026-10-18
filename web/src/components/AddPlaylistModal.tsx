import React, { useEffect, useRef, useState } from 'react';
import { useTvModalNavigation } from '../hooks/useTvModalNavigation';
import { ProviderAccount } from '../types/iptv';
import { ImportedContent } from '../services/contentStore';
import type { PartialContent } from '../services/providerImport';
import { importM3UProvider, importXtreamProvider, ImportProgress } from '../services/providerImport';
import { setNetworkDiagnosticSink, NetworkDiagnosticEvent } from '../services/net';
import LoadingDiagnosticModal from './LoadingDiagnosticModal';
import { X, Server, Link, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

interface AddPlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddProvider: (newProvider: ProviderAccount, content?: ImportedContent) => void;
  editProvider?: ProviderAccount | null;
  onDiagnosticUpdate?: (snapshot: { providerId?: string; providerName: string; progress: ImportProgress | null; events: NetworkDiagnosticEvent[]; error: string | null; startedAt: number; finished: boolean }) => void;
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
  // Az M3U/M3U8 lista háromféleképp adható meg: link, fájl vagy beillesztett szöveg.
  const [m3uMode, setM3uMode] = useState<'url' | 'file' | 'text'>('url');
  const [m3uText, setM3uText] = useState('');
  const [m3uFileName, setM3uFileName] = useState('');
  const { modalRef, handleKeyDown, handleBackdropClick } = useTvModalNavigation(isOpen, onClose, [tab]);

  useEffect(() => {
    if (!isOpen) return;
    setTab(editProvider?.type === 'm3u' ? 'm3u' : 'xtream');
    setName(editProvider?.name || '');
    setServerUrl(editProvider?.serverUrl || '');
    setUsername(editProvider?.username || '');
    setPassword(editProvider?.password || '');
    setM3uUrl(editProvider?.m3uUrl || '');
    setM3uMode('url');
    setM3uText('');
    setM3uFileName('');
    setStatusMessage(null);
    setProgress(null);
    setDiagnosticOpen(false);
    setDiagnosticEvents([]);
    setDiagnosticError(null);
    setLiveLoadedPromptOpen(false);
  }, [isOpen, editProvider]);

  // Status state
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [diagnosticEvents, setDiagnosticEvents] = useState<NetworkDiagnosticEvent[]>([]);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [diagnosticStartedAt, setDiagnosticStartedAt] = useState(() => performance.now());
  const diagnosticStartedAtRef = useRef(performance.now());
  const diagnosticEventsRef = useRef<NetworkDiagnosticEvent[]>([]);
  const [liveLoadedPromptOpen, setLiveLoadedPromptOpen] = useState(false);
  const diagnosticFinishedRef = useRef(false);

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
    const startedAt = performance.now();
    setDiagnosticStartedAt(startedAt);
    diagnosticStartedAtRef.current = startedAt;
    diagnosticFinishedRef.current = false;
    setNetworkDiagnosticSink((event) => setDiagnosticEvents((prev) => {
      const next = [...prev, event].slice(-250);
      diagnosticEventsRef.current = next;
      onDiagnosticUpdate?.({ providerName: providerName, progress, events: next, error: null, startedAt: diagnosticStartedAtRef.current, finished: false });
      return next;
    }));

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
      const finalProgress = { phase: 'Kész', detail: `${content.channels.length.toLocaleString('hu-HU')} csatorna • ${content.movies.length.toLocaleString('hu-HU')} film • ${content.series.length.toLocaleString('hu-HU')} sorozat`, percent: 100 };
      setProgress(finalProgress);
      setLiveLoadedPromptOpen(false);
      onDiagnosticUpdate?.({ providerId: provider.id, providerName: provider.name, progress: finalProgress, events: diagnosticEventsRef.current, error: null, startedAt: diagnosticStartedAtRef.current, finished: true });
      setNetworkDiagnosticSink(null);
    } catch (error) {
      setIsLoading(false);
      diagnosticFinishedRef.current = true;
      setNetworkDiagnosticSink(null);
      const message = error instanceof Error ? error.message : 'Szerver csatlakozási hiba.';
      setDiagnosticError(message);
      setLiveLoadedPromptOpen(false);
      onDiagnosticUpdate?.({ providerName: providerName, progress, events: diagnosticEventsRef.current, error: message, startedAt: diagnosticStartedAtRef.current, finished: true });
      setStatusMessage({ type: 'error', text: message });
    }
  };

  /** M3U/M3U8 fájl beolvasása (akár több MB-os lista is). */
  const handleM3UFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setM3uText(String(reader.result || ''));
      setM3uFileName(file.name);
      setStatusMessage(null);
    };
    reader.onerror = () => setStatusMessage({ type: 'error', text: 'A fájl beolvasása nem sikerült.' });
    reader.readAsText(file);
  };

  const handleConnectM3U = async (e: React.FormEvent) => {
    e.preventDefault();
    if (m3uMode === 'url' && !m3uUrl) {
      setStatusMessage({ type: 'error', text: 'Kérlek adj meg egy érvényes M3U URL-t!' });
      return;
    }
    if (m3uMode !== 'url' && !m3uText.trim()) {
      setStatusMessage({
        type: 'error',
        text: m3uMode === 'file'
          ? 'Válassz ki egy .m3u / .m3u8 fájlt!'
          : 'Illeszd be a lista teljes tartalmát (#EXTM3U …)!',
      });
      return;
    }

    const providerName = name.trim() || (
      m3uMode === 'file' && m3uFileName
        ? m3uFileName.replace(/\.(m3u8?|txt)$/i, '')
        : m3uMode === 'url'
          ? (() => { try { return new URL(m3uUrl).hostname; } catch { return 'M3U Playlist'; } })()
          : 'M3U Playlist'
    );

    setIsLoading(true);
    setStatusMessage(null);
    setProgress({ phase: 'M3U lista letöltése…', percent: 5 });
    setDiagnosticOpen(true);
    setDiagnosticError(null);
    setDiagnosticEvents([]);
    diagnosticEventsRef.current = [];
    const startedAt = performance.now();
    setDiagnosticStartedAt(startedAt);
    diagnosticStartedAtRef.current = startedAt;
    diagnosticFinishedRef.current = false;
    setNetworkDiagnosticSink((event) => setDiagnosticEvents((prev) => {
      const next = [...prev, event].slice(-250);
      diagnosticEventsRef.current = next;
      onDiagnosticUpdate?.({ providerName: providerName, progress, events: next, error: null, startedAt: diagnosticStartedAtRef.current, finished: false });
      return next;
    }));

    try {
      const content = await importM3UProvider(
        m3uMode === 'url'
          ? { name: providerName, m3uUrl }
          : { name: providerName, m3uText },
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
        m3uUrl: m3uMode === 'url' ? m3uUrl.trim() : '',
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
      const finalProgress = { phase: 'Kész', detail: `${content.channels.length.toLocaleString('hu-HU')} csatorna • ${content.movies.length.toLocaleString('hu-HU')} film • ${content.series.length.toLocaleString('hu-HU')} sorozat`, percent: 100 };
      setProgress(finalProgress);
      onDiagnosticUpdate?.({ providerId: provider.id, providerName: provider.name, progress: finalProgress, events: diagnosticEventsRef.current, error: null, startedAt: diagnosticStartedAtRef.current, finished: true });
      setNetworkDiagnosticSink(null);
    } catch (error) {
      setIsLoading(false);
      setNetworkDiagnosticSink(null);
      const message = error instanceof Error ? error.message : 'Nem sikerült letölteni vagy feldolgozni az M3U fájlt.';
      setDiagnosticError(message);
      onDiagnosticUpdate?.({ providerName: providerName, progress, events: diagnosticEventsRef.current, error: message, startedAt: diagnosticStartedAtRef.current, finished: true });
      setStatusMessage({ type: 'error', text: message });
    }
  };


  const closeDiagnostic = () => {
    diagnosticFinishedRef.current = true;
    setNetworkDiagnosticSink(null);
    setDiagnosticOpen(false);
    setProgress(null);
    setDiagnosticError(null);
    onClose();
  };

  // A listaűrlap legyen a beállítások (z-50) fölött, de a diagnosztika (z-100) alatt.
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm animate-fadeIn select-none">
      <div ref={modalRef} tabIndex={-1} onKeyDown={handleKeyDown} className="bg-[#081329] border border-cyan-800/60 rounded-3xl max-w-lg w-full max-h-[90dvh] min-h-0 flex flex-col shadow-2xl animate-scaleUp overflow-hidden focus:outline-none">
        
        {/* Header */}
        <div className="p-4 bg-[#0a1835] border-b border-cyan-950 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="w-5 h-5 text-cyan-400 stroke-[2.5]" />
            <h2 className="text-base sm:text-lg font-black text-white tracking-wide">
              {editProvider ? 'SZOLGÁLTATÓ SZERKESZTÉSE' : 'ÚJ LISTA / SZOLGÁLTATÓ HOZZÁADÁSA'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-slate-300 active:scale-90 transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="p-3 bg-[#070e1e] border-b border-cyan-950/60 flex items-center gap-2">
          <button
            onClick={() => setTab('xtream')}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-1.5 ${
              tab === 'xtream'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                : 'bg-[#0e1d3b] text-slate-300 hover:bg-[#13274e]'
            }`}
          >
            <Server className="w-3.5 h-3.5" />
            <span>Xtream Codes API</span>
          </button>

          <button
            onClick={() => setTab('m3u')}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-1.5 ${
              tab === 'm3u'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                : 'bg-[#0e1d3b] text-slate-300 hover:bg-[#13274e]'
            }`}
          >
            <Link className="w-3.5 h-3.5" />
            <span>M3U URL</span>
          </button>
        </div>

        {/* Body Form */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {statusMessage && (
            <div
              className={`p-3 rounded-2xl flex items-center gap-2 text-xs font-bold ${
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
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>{progress?.detail || progress?.phase || 'Kapcsolódás…'}</span>
                <span className="font-bold text-cyan-300">{progress?.percent ?? 0}%</span>
              </div>
            </div>
          )}

          {tab === 'xtream' ? (
            <form onSubmit={handleTestAndConnectXtream} className="space-y-3.5">
              <div>
                <label className="text-xs font-bold text-slate-300 block mb-1">
                  Szerver URL / Host (Porttal) *
                </label>
                <input
                  type="text"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="http://iptv-server.com:8080"
                  required
                  className="w-full bg-[#0d1d3d] border border-cyan-900/60 rounded-xl px-3 py-2 text-xs text-white focus:outline-hidden focus:border-cyan-400 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-bold text-slate-300 block mb-1">
                    Felhasználónév *
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Username"
                    required
                    className="w-full bg-[#0d1d3d] border border-cyan-900/60 rounded-xl px-3 py-2 text-xs text-white focus:outline-hidden focus:border-cyan-400 font-mono"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-300 block mb-1">
                    Jelszó *
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password"
                    required
                    className="w-full bg-[#0d1d3d] border border-cyan-900/60 rounded-xl px-3 py-2 text-xs text-white focus:outline-hidden focus:border-cyan-400 font-mono"
                  />
                </div>
              </div>

              <p className="text-[11px] leading-relaxed text-slate-400 bg-[#0b1832] border border-cyan-950/70 rounded-xl p-3">
                A szolgáltatótól kapott <span className="text-cyan-300 font-bold">szerver címet</span> (pl.{' '}
                <span className="font-mono text-cyan-200">http://szerver:8080</span>),{' '}
                <span className="text-cyan-300 font-bold">felhasználónevet</span> és{' '}
                <span className="text-cyan-300 font-bold">jelszót</span> írd be. A program ilyenkor letölti a
                csatornákat, filmeket és sorozatokat – ez néhány percig is eltarthat.
              </p>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3 rounded-2xl bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 text-slate-950 font-black text-sm flex items-center justify-center gap-2 shadow-xl shadow-cyan-400/30 active:scale-95 transition-all mt-2"
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
                {/* Forrás: link / fájl / beillesztett lista */}
                <div className="grid grid-cols-3 gap-1.5">
                  {([
                    ['url', 'Link'],
                    ['file', 'Fájl'],
                    ['text', 'Teljes kód'],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setM3uMode(mode)}
                      className={`py-2 rounded-xl text-[11px] font-black transition-all ${
                        m3uMode === mode
                          ? 'bg-cyan-400 text-slate-950'
                          : 'bg-[#0d1d3d] text-slate-300 border border-cyan-900/60'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {m3uMode === 'url' && (
                  <div>
                    <label className="text-xs font-bold text-slate-300 block mb-1">
                      M3U / M3U8 Playlist URL *
                    </label>
                    <input
                      type="url"
                      value={m3uUrl}
                      onChange={(e) => setM3uUrl(e.target.value)}
                      placeholder="https://example.com/playlist.m3u8"
                      className="w-full bg-[#0d1d3d] border border-cyan-900/60 rounded-xl px-3 py-2 text-xs text-white focus:outline-hidden focus:border-cyan-400 font-mono"
                    />
                  </div>
                )}

                {m3uMode === 'file' && (
                  <div>
                    <label className="text-xs font-bold text-slate-300 block mb-1">
                      M3U / M3U8 fájl kiválasztása *
                    </label>
                    <input
                      type="file"
                      accept=".m3u,.m3u8,.txt,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain"
                      onChange={handleM3UFile}
                      className="w-full bg-[#0d1d3d] border border-cyan-900/60 rounded-xl px-3 py-2 text-xs text-white file:mr-2 file:py-1 file:px-2 file:rounded-lg file:border-0 file:bg-cyan-400 file:text-slate-950 file:font-bold"
                    />
                    {m3uText && (
                      <p className="mt-1 text-[11px] text-emerald-300">
                        {m3uFileName || 'kiválasztott fájl'} • {m3uText.split(/\r?\n/).length.toLocaleString('hu-HU')} sor beolvasva
                      </p>
                    )}
                  </div>
                )}

                {m3uMode === 'text' && (
                  <div>
                    <label className="text-xs font-bold text-slate-300 block mb-1">
                      A lista teljes tartalma (másolás-beillesztés) *
                    </label>
                    <textarea
                      value={m3uText}
                      onChange={(e) => setM3uText(e.target.value)}
                      rows={6}
                      placeholder={'#EXTM3U\n#EXTINF:-1 tvg-name="Csatorna" group-title="Magyar",Csatorna\nhttp://szerver:8080/live/user/pass/12345.ts'}
                      className="w-full bg-[#0d1d3d] border border-cyan-900/60 rounded-xl px-3 py-2 text-[11px] font-mono text-white focus:outline-hidden focus:border-cyan-400"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-3 rounded-2xl bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 text-slate-950 font-black text-sm flex items-center justify-center gap-2 shadow-xl shadow-cyan-400/30 active:scale-95 transition-all"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Feldolgozás...</span>
                    </>
                  ) : (
                    <>
                      <Link className="w-4 h-4" />
                      <span>{m3uMode === 'url' ? 'M3U Letöltése és Betöltése' : 'Lista Feldolgozása'}</span>
                    </>
                  )}
                </button>
              </form>

            </div>
          )}
        </div>
      </div>
      {liveLoadedPromptOpen && (
        <div className="fixed inset-0 z-[115] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-cyan-400/50 bg-[#081329] p-5 text-white shadow-2xl">
            <div className="text-lg font-black text-cyan-200">Az élő TV-csatornák betöltve</div>
            <p className="mt-2 text-sm text-slate-300">A filmek és sorozatok betöltése még folyamatban van. Szeretnéd tovább nézni a folyamatot, vagy folytassuk a háttérben?</p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button onClick={() => setLiveLoadedPromptOpen(false)} className="py-3 rounded-xl border border-slate-600 bg-white/5 hover:bg-white/10 text-white font-bold">Nem, tovább nézem</button>
              <button onClick={() => { setLiveLoadedPromptOpen(false); setDiagnosticOpen(false); (onBackgroundContinue || onClose)(); }} className="py-3 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-black">Bezár, háttérben</button>
            </div>
          </div>
        </div>
      )}
      <LoadingDiagnosticModal
        isOpen={diagnosticOpen}
        progress={progress}
        events={diagnosticEvents}
        error={diagnosticError}
        startedAt={diagnosticStartedAt}
        onClose={closeDiagnostic}
      />
    </div>
  );
};
