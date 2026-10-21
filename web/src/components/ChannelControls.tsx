import { ChannelLogo } from './ChannelLogo';
import React from 'react';
import { Channel } from '../types/iptv';
import { Star, Mic2, Subtitles, PictureInPicture2, Cast, X } from 'lucide-react';

interface ChannelControlsProps {
  channel: Channel | null;
  displayNumber?: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onPrevChannel: () => void;
  onNextChannel: () => void;
  onToggleFavorite: (channelId: string) => void;
  onOpenAudioModal: () => void;
  hasMultipleAudioTracks: boolean;
  hasActiveSubtitle?: boolean;
  onOpenSubtitlesModal: () => void;
  onCastToTv: () => void;
  onTogglePip: () => void;
  showPip?: boolean;
  showCast?: boolean;
  onOpenEpgModal: () => void;
  volume: number;
  onVolumeChange: (value: number) => void;
  onToggleMute: () => void;
  onRequestHide?: () => void;
  hideHeaderActions?: boolean;
  className?: string;
  onOpenChannelDetails?: () => void;
}

export const ChannelControls: React.FC<ChannelControlsProps> = ({
  channel,
  displayNumber,
  onToggleFavorite,
  onOpenAudioModal,
  hasMultipleAudioTracks,
  hasActiveSubtitle = false,
  onOpenSubtitlesModal,
  onCastToTv,
  onTogglePip,
  showPip = false,
  showCast = false,
  onRequestHide,
  hideHeaderActions = false,
  className,
}) => {
  const [epgClock, setEpgClock] = React.useState(() => Date.now());
  // Keep the existing continuous EPG progress refresh interval.
  React.useEffect(() => {
    const timer = window.setInterval(() => setEpgClock(Date.now()), 10000);
    return () => window.clearInterval(timer);
  }, []);

  const epgStart = channel?.epgNow?.startTimestamp;
  const epgEnd = channel?.epgNow?.endTimestamp;
  const hasEpgProgress = typeof epgStart === 'number' && typeof epgEnd === 'number' && epgEnd > epgStart;
  const epgProgress = hasEpgProgress
    ? Math.min(100, Math.max(0, ((epgClock / 1000 - epgStart!) / (epgEnd! - epgStart!)) * 100))
    : 0;
  const formatTime = (timestamp?: number) => typeof timestamp === 'number' && timestamp > 0
    ? new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--:--';

  if (!channel) return null;
  const upcoming = (channel.epgUpcoming || []).slice(0, 3);

  return (
    <div className={`relative box-border w-full max-h-[calc(100dvh-8px)] overflow-y-auto bg-[#0e1d3b]/95 border-2 border-cyan-500/60 rounded-xl px-4 pt-3 pb-3 sm:px-6 sm:pt-4 flex flex-col gap-2.5 select-none shadow-sm ${className || ''}`}>
      {!hideHeaderActions && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
          <button
            onClick={() => onToggleFavorite(channel.id)}
            className={`shrink-0 p-2 rounded-xl border active:scale-90 ${channel.isFavorite ? 'bg-amber-400/20 text-amber-300 border-amber-400/50' : 'bg-[#0f1d3a] text-slate-400 border-slate-700/60'}`}
            title="Kedvencekhez adás"
            aria-label="Kedvencekhez adás"
          >
            <Star className={`w-5 h-5 ${channel.isFavorite ? 'fill-amber-400 text-amber-400' : ''}`} />
          </button>
          {onRequestHide && (
            <button onClick={onRequestHide} className="shrink-0 p-2 rounded-xl border border-slate-700/60 bg-[#0f1d3a] text-slate-300" title="Vezérlők elrejtése" aria-label="Vezérlők elrejtése">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      )}

      {/* Audio and CC are informational labels only; channel number shares this row. */}
      <div className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-2 min-h-9">
        <div className="justify-self-start inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-[#121f3d] px-2.5 py-1.5 text-xs sm:text-sm font-bold text-slate-200 pointer-events-none" aria-label={hasMultipleAudioTracks ? 'Több hangsáv elérhető' : 'Audio'}>
          <Mic2 className={`w-4 h-4 ${hasMultipleAudioTracks ? 'text-emerald-400' : 'text-rose-400'}`} />
          <span>Audio</span>
        </div>
        <div className="text-cyan-300 font-black text-2xl sm:text-3xl tracking-wider leading-none text-center">
          {displayNumber ?? '—'}
        </div>
        <div className="justify-self-end inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-[#121f3d] px-2.5 py-1.5 text-xs sm:text-sm font-bold text-slate-200 pointer-events-none" aria-label={hasActiveSubtitle ? 'Felirat aktív' : 'CC'}>
          <Subtitles className={`w-4 h-4 ${hasActiveSubtitle ? 'text-emerald-400' : 'text-cyan-300'}`} />
          <span>CC</span>
        </div>
      </div>

      {/* Keep the existing centered channel logo, name and current programme layout. */}
      <div className="flex flex-col items-center text-center gap-1.5 px-8">
        <div className="w-16 h-14 sm:w-20 sm:h-16 rounded-lg bg-[#0e1e3e] border border-cyan-800/40 p-1.5 flex items-center justify-center overflow-hidden shadow-inner">
          <ChannelLogo url={channel.logo} name={channel.name} retryKey={channel} />
        </div>
        <h2 className="max-w-full text-white font-black text-lg sm:text-2xl tracking-tight leading-tight break-words">
          {channel.name}
        </h2>
        <div className="max-w-full text-amber-300 font-bold text-base sm:text-lg leading-snug break-words">
          {channel.epgNow?.title || 'Élő adás'}
        </div>
      </div>

      {/* Keep programme start/end times and the continuously updating progress bar in place. */}
      <div className="flex items-center gap-3 w-full">
        <span className="shrink-0 text-slate-200 text-xs sm:text-sm font-semibold tabular-nums">{formatTime(epgStart)}</span>
        <div
          className="flex-1 bg-slate-800/90 rounded-full h-2 overflow-hidden flex shadow-inner"
          role="progressbar"
          aria-label={channel.epgNow?.title ? `${channel.epgNow.title} műsorhaladása` : 'EPG műsorhaladása'}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={hasEpgProgress ? Math.round(epgProgress) : 0}
        >
          <div className="bg-linear-to-r from-amber-400 to-yellow-300 h-full rounded-full transition-all duration-500 shadow-sm shadow-amber-400" style={{ width: `${hasEpgProgress ? epgProgress : 0}%` }} />
        </div>
        <span className="shrink-0 text-slate-200 text-xs sm:text-sm font-semibold tabular-nums">{formatTime(epgEnd)}</span>
      </div>

      {/* Three upcoming programmes centered under the bar, with larger readable text and no decorative arrows. */}
      {upcoming.length > 0 && (
        <div className="w-full flex flex-col items-center text-center gap-1 border-t border-cyan-900/70 pt-2">
          {upcoming.map((program, index) => (
            <div key={`${program.time}-${program.title}-${index}`} className="w-full text-base sm:text-lg leading-snug font-semibold text-slate-100 break-words">
              {program.title}
            </div>
          ))}
        </div>
      )}

      {(showPip || showCast) && (
        <div className="flex items-center justify-center gap-2 pt-1">
          {showPip && (
            <button onClick={onTogglePip} className="flex items-center gap-1 py-1.5 px-2 rounded-lg bg-[#121f3d] text-slate-200 border border-slate-700/60 text-xs font-bold" title="Kép a képben">
              <PictureInPicture2 className="w-4 h-4 text-slate-300" /><span>PiP</span>
            </button>
          )}
          {showCast && (
            <button onClick={onCastToTv} className="flex items-center gap-1 py-1.5 px-2 rounded-lg bg-[#121f3d] text-slate-200 border border-slate-700/60 text-xs font-bold" title="Aktuális adás küldése TV-re" aria-label="Aktuális adás küldése TV-re">
              <Cast className="w-4 h-4 text-cyan-300" /><span>TV</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
