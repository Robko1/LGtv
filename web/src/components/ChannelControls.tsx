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
  const compactMainOsd = className?.includes('main-live-osd') ?? false;
  const upcoming = (channel.epgUpcoming || []).slice(0, 3);

  return (
    <div className={`relative box-border w-full ${compactMainOsd ? 'h-[260px] min-h-[260px] max-h-[260px] overflow-hidden px-4 pt-2 pb-9 gap-1' : 'max-h-[calc(100dvh-8px)] overflow-y-auto px-4 pt-3 pb-3 sm:px-6 sm:pt-4 gap-2.5'} bg-[#0e1d3b]/95 border-2 border-cyan-500/60 rounded-xl flex flex-col select-none shadow-sm ${className || ''}`}>
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

      {/* Csatornaszám bal felül; Audio és CC a panel két alsó sarkában. */}
      <div className={`absolute top-2 left-3 z-10 text-cyan-300 font-black ${compactMainOsd ? "text-2xl" : "text-2xl sm:text-3xl"} tracking-wider leading-none`}>
        {displayNumber ?? '—'}
      </div>

      {/* Nagyobb csatornalogó, név és aktuális műsor középre igazítva. */}
      <div className={`flex flex-col items-center text-center ${compactMainOsd ? "gap-0.5 px-10 min-h-0" : "gap-1.5 px-8"}`}>
        <div className={`${compactMainOsd ? "w-16 h-12" : "w-16 h-14 sm:w-20 sm:h-16"} rounded-lg bg-[#0e1e3e] border border-cyan-800/40 p-1.5 flex items-center justify-center overflow-hidden shadow-inner`}>
          <ChannelLogo url={channel.logo} name={channel.name} retryKey={channel} />
        </div>
        <h2 className={`max-w-full text-white font-black ${compactMainOsd ? "text-lg" : "text-lg sm:text-2xl"} tracking-tight leading-tight break-words line-clamp-1`}>
          {channel.name}
        </h2>
        <div className={`max-w-full text-amber-300 font-bold ${compactMainOsd ? "text-base" : "text-base sm:text-lg"} leading-snug break-words line-clamp-1`}>
          {channel.epgNow?.title || 'Élő adás'}
        </div>
      </div>
      {/* Keep programme start/end times and the continuously updating progress bar in place. */}
      <div className={`flex items-center gap-3 w-full ${compactMainOsd ? "shrink-0" : ""}`}>
        <span className={`shrink-0 text-slate-200 ${compactMainOsd ? "text-sm" : "text-xs sm:text-sm"} font-semibold tabular-nums`}>{formatTime(epgStart)}</span>
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
        <span className={`shrink-0 text-slate-200 ${compactMainOsd ? "text-sm" : "text-xs sm:text-sm"} font-semibold tabular-nums`}>{formatTime(epgEnd)}</span>
      </div>

      {/* Three upcoming programmes centered under the bar, with larger readable text and no decorative arrows. */}
      {upcoming.length > 0 && (
        <div className={`w-full flex flex-col items-center text-center ${compactMainOsd ? "gap-0.5 border-t border-cyan-900/70 pt-1 min-h-0 overflow-hidden" : "gap-1 border-t border-cyan-900/70 pt-2"}`}>
          {upcoming.map((program, index) => (
            <div key={`${program.time}-${program.title}-${index}`} className={`w-full ${compactMainOsd ? "text-base leading-tight truncate" : "text-base sm:text-lg leading-snug break-words"} font-semibold text-slate-100` }>
              {program.title}
            </div>
          ))}
        </div>
      )}

      {/* Audio és CC a rögzített méretű főoldali OSD alsó sarkaiban. */}
      {compactMainOsd && (
        <div className="absolute inset-x-3 bottom-2 flex items-center justify-between pointer-events-none">
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-[#121f3d] px-2 py-1 text-sm font-bold text-slate-200" aria-label={hasMultipleAudioTracks ? 'Több hangsáv elérhető' : 'Audio'}>
            <Mic2 className={`w-4 h-4 ${hasMultipleAudioTracks ? 'text-emerald-400' : 'text-rose-400'}`} />
            <span>Audio</span>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-[#121f3d] px-2 py-1 text-sm font-bold text-slate-200" aria-label={hasActiveSubtitle ? 'Felirat aktív' : 'CC'}>
            <Subtitles className={`w-4 h-4 ${hasActiveSubtitle ? 'text-emerald-400' : 'text-cyan-300'}`} />
            <span>CC</span>
          </div>
        </div>
      )}
      {(showPip || showCast) && (
        <div className={`flex items-center justify-center gap-2 ${compactMainOsd ? "pt-0 shrink-0" : "pt-1"}`}>
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
