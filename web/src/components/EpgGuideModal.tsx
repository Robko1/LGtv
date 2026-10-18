import React, { useEffect, useMemo, useState } from 'react';
import { useTvModalNavigation } from '../hooks/useTvModalNavigation';
import { Channel } from '../types/iptv';
import { ProviderRef } from '../services/contentStore';
import { EpgEntry, clearEpgCache, loadShortEpg, streamIdFor } from '../services/epgService';
import { X, Calendar, Clock, Play, Search, RefreshCw } from 'lucide-react';

interface EpgGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeChannel: Channel | null;
  channels: Channel[];
  onSelectChannel: (channel: Channel) => void;
  activeProvider: ProviderRef | null;
}

interface ProgramRow {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  durationMinutes: number;
  progressPercent: number;
  now: boolean;
}

const PAGE_SIZE = 60;

function formatRange(start: number, end: number): { start: string; end: string } {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  return {
    start: start ? new Date(start * 1000).toLocaleTimeString([], opts) : '--:--',
    end: end ? new Date(end * 1000).toLocaleTimeString([], opts) : '--:--',
  };
}

export const EpgGuideModal: React.FC<EpgGuideModalProps> = ({
  isOpen,
  onClose,
  activeChannel,
  channels,
  onSelectChannel,
  activeProvider,
}) => {
  const [selectedChannelId, setSelectedChannelId] = useState<string>(activeChannel?.id || channels[0]?.id || '');
  const { modalRef, handleKeyDown, handleBackdropClick } = useTvModalNavigation(isOpen, onClose);
  const [entries, setEntries] = useState<EpgEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (activeChannel?.id) setSelectedChannelId(activeChannel.id);
  }, [activeChannel?.id]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, isOpen]);

  const filteredChannels = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return channels;
    return channels.filter(
      (ch) => ch.name.toLowerCase().includes(term) || String(ch.num).includes(term)
    );
  }, [channels, query]);

  const selectedChannel = useMemo(
    () => channels.find((c) => c.id === selectedChannelId) || activeChannel || null,
    [channels, selectedChannelId, activeChannel]
  );

  /**
   * A kiválasztott csatorna műsorának betöltése.
   *
   * Az azonosító a csatorna streamId mezőjéből jön (a stream URL-ből is
   * kiolvasható, ha régi a mentett lista). Az eredmény 5 percig gyorsítótárazva
   * van, ezért a csatornaváltogatás az EPG nézetben nem generál új kérést.
   */
  useEffect(() => {
    if (!isOpen) return;
    const channel = selectedChannel;
    const provider = activeProvider;
    if (!channel) {
      setEntries([]);
      return;
    }
    if (!provider || provider.type !== 'xtream') {
      setEntries([]);
      setError(
        provider?.type === 'm3u'
          ? 'M3U listánál a szolgáltató nem ad Xtream EPG-t. Az EPG az Xtream (Codes) kapcsolatnál érhető el.'
          : ''
      );
      return;
    }
    const streamId = streamIdFor(channel);
    if (!streamId) {
      setEntries([]);
      setError('Ehhez a csatornához nem található Xtream stream azonosító, ezért nincs EPG.');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError('');
    loadShortEpg(provider, streamId, 12)
      .then((rows) => {
        if (cancelled) return;
        setEntries(rows);
        if (!rows.length) setError('A szerver nem adott műsort ehhez a csatornához.');
      })
      .catch((e) => {
        if (cancelled) return;
        setEntries([]);
        setError(e instanceof Error ? e.message : 'Az EPG betöltése nem sikerült.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, selectedChannel?.id, activeProvider?.id, reloadKey]);

  const programs: ProgramRow[] = useMemo(() => {
    const nowMs = Date.now();
    return entries.map((entry) => {
      const startMs = entry.start * 1000;
      const endMs = entry.end * 1000;
      const isNow = entry.start * 1000 <= nowMs && (entry.end === 0 || endMs > nowMs);
      const duration = entry.end > entry.start ? Math.round((entry.end - entry.start) / 60) : 0;
      const progress =
        isNow && endMs > startMs
          ? Math.max(0, Math.min(100, Math.round(((nowMs - startMs) / (endMs - startMs)) * 100)))
          : 0;
      const { start, end } = formatRange(entry.start, entry.end);
      return {
        id: entry.id,
        title: entry.title,
        description: entry.description || 'Nincs műsorleírás.',
        start,
        end,
        durationMinutes: duration,
        progressPercent: progress,
        now: isNow,
      };
    });
  }, [entries]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-3 md:p-4 lg:p-6 bg-black/80 backdrop-blur-sm animate-fadeIn select-none lg:select-auto" role="dialog" aria-modal="true" aria-label="EPG műsorújság" onClick={handleBackdropClick}>
      <div ref={modalRef} tabIndex={-1} onKeyDown={handleKeyDown} className="bg-[#081329] border border-cyan-800/60 rounded-3xl max-w-xl md:max-w-2xl lg:max-w-3xl xl:max-w-4xl w-full max-h-[85vh] lg:max-h-[80vh] flex flex-col shadow-2xl animate-scaleUp overflow-hidden focus:outline-none">

        {/* Header */}
        <div className="p-4 bg-[#0a1835] border-b border-cyan-950 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-amber-400 stroke-[2.5]" />
            <h2 className="text-base sm:text-lg font-black text-amber-400 tracking-wide">
              EPG MŰSORÚJSÁG
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                clearEpgCache();
                setReloadKey((v) => v + 1);
              }}
              title="Műsor újratöltése"
              className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-cyan-300 active:scale-90 transition-all"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-slate-300 active:scale-90 transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Csatorna kereső + választó */}
        <div className="p-2.5 bg-[#070e1e] border-b border-cyan-950/60 space-y-2">
          <div className="relative">
            <Search className="w-4 h-4 text-cyan-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Csatorna keresése (név vagy szám)…"
              className="w-full bg-[#0d1c3a] border border-cyan-900/50 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-hidden focus:border-cyan-400"
            />
          </div>
          <div className="max-h-28 overflow-y-auto flex flex-wrap gap-1.5">
            {filteredChannels.slice(0, visibleCount).map((ch) => (
              <button
                key={ch.id}
                onClick={() => setSelectedChannelId(ch.id)}
                className={`shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                  selectedChannelId === ch.id
                    ? 'bg-cyan-400 text-slate-950 font-black shadow-md shadow-cyan-400/30'
                    : 'bg-[#0d1c3a] text-slate-300 border border-slate-700/60 hover:bg-[#142954]'
                }`}
              >
                <span className="font-mono">{ch.num}</span>
                <span className="truncate max-w-[110px]">{ch.name.replace('[HU] ', '')}</span>
              </button>
            ))}
            {filteredChannels.length > visibleCount && (
              <button
                onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
                className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-bold bg-[#142954] text-cyan-200 border border-cyan-800/60"
              >
                Több csatorna ({filteredChannels.length - visibleCount})
              </button>
            )}
            {filteredChannels.length === 0 && (
              <span className="text-xs text-slate-400 px-1 py-1">Nincs találat.</span>
            )}
          </div>
        </div>

        {/* Csatorna sáv */}
        {selectedChannel && (
          <div className="p-3 bg-[#0c1a36] border-b border-cyan-950/50 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="px-2.5 py-1 rounded-xl bg-cyan-400 text-slate-950 font-black text-sm">
                {selectedChannel.num}
              </div>
              <div className="min-w-0">
                <h3 className="text-white font-bold text-sm truncate">{selectedChannel.name}</h3>
                <p className="text-xs text-amber-400 font-semibold truncate">
                  {selectedChannel.epgNow?.title && selectedChannel.epgNow.title !== selectedChannel.name
                    ? `${selectedChannel.epgNow.time || ''} ${selectedChannel.epgNow.title}`
                    : selectedChannel.country}
                </p>
              </div>
            </div>

            <button
              onClick={() => {
                onSelectChannel(selectedChannel);
                onClose();
              }}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-black shadow-md active:scale-95 transition-all"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Indítás</span>
            </button>
          </div>
        )}

        {/* Műsorlista */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="p-6 text-center text-cyan-300 text-sm">EPG betöltése a szolgáltató szerveréről…</div>
          ) : error ? (
            <div className="p-6 text-center text-amber-300 text-sm">{error}</div>
          ) : programs.length === 0 ? (
            <div className="p-6 text-center text-slate-400 text-sm">A szerver nem adott EPG műsort ehhez a csatornához.</div>
          ) : programs.map((prog) => (
            <div
              key={prog.id}
              className={`p-3.5 rounded-2xl border transition-all ${
                prog.now
                  ? 'bg-[#0e2247] border-cyan-400/80 shadow-lg shadow-cyan-950/60 ring-1 ring-cyan-400/40'
                  : 'bg-[#0a1630] border-slate-800'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-md bg-amber-400/20 text-amber-300 font-mono font-bold text-xs border border-amber-400/30">
                    {prog.start} - {prog.end}
                  </span>
                  {prog.now && (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-400 text-[10px] font-black tracking-wide border border-emerald-500/30">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping inline-block" />
                      ÉLŐBEN MEGY
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-slate-400 flex items-center gap-1">
                  <Clock className="w-3 h-3 text-cyan-400" />
                  {prog.durationMinutes} perc
                </span>
              </div>

              <h4 className="mt-2 text-white font-bold text-sm">{prog.title}</h4>
              <p className="mt-1 text-xs text-slate-300 leading-relaxed line-clamp-3">{prog.description}</p>

              {prog.now && (
                <div className="mt-3 space-y-1">
                  <div className="w-full bg-slate-900 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-cyan-400 h-full rounded-full transition-all duration-300"
                      style={{ width: `${prog.progressPercent}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-cyan-300 font-mono font-semibold block text-right">
                    {prog.progressPercent}% lement
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default EpgGuideModal;
