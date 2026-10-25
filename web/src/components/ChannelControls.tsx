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
  hasAvailableSubtitle?: boolean;
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
  /** Rejtett OSD-nél az EPG-óra nem okoz háttér-renderelést. */
  isActive?: boolean;
}

/**
 * Fekvő teljes képernyős élő TV OSD – a Sharktie elrendezéséhez igazítva.
 *
 * A BAL ALSÓ SAROKBAN a főoldali OSD-vel AZONOS méretű hangsáv- és
 * feliratjelző látszik (Audio mikrofon ikon + CC): így teljes képernyőn is
 * látszik, hogy van-e több hangsáv / aktív felirat, pontosan úgy, mint a
 * főoldalon. A jelzők az eltűnő OSD részei (a beállított idő után a képpel
 * együtt tűnnek el).
 */
export const FullscreenLiveOsd: React.FC<{
  channel: Channel | null;
  displayNumber?: number;
  liveAccent?: 'yellow' | 'red' | 'blue' | 'pink' | 'green' | 'white';
  hasMultipleAudioTracks?: boolean;
  hasAvailableSubtitle?: boolean;
}> = ({ channel, displayNumber, liveAccent = 'yellow', hasMultipleAudioTracks = false, hasAvailableSubtitle = false }) => {
  const accentTextClass: Record<NonNullable<typeof liveAccent>, string> = {
    yellow: 'text-amber-400',
    red: 'text-red-400',
    blue: 'text-blue-400',
    pink: 'text-pink-400',
    green: 'text-green-400',
    white: 'text-white',
  };
  const [clock, setClock] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 10000);
    return () => window.clearInterval(timer);
  }, []);
  if (!channel) return null;

  const start = channel.epgNow?.startTimestamp;
  const end = channel.epgNow?.endTimestamp;
  const hasProgress = typeof start === 'number' && typeof end === 'number' && end > start;
  const progress = hasProgress ? Math.min(100, Math.max(0, ((clock / 1000 - start!) / (end! - start!)) * 100)) : 0;
  const time = (value?: number) => typeof value === 'number' && value > 0
    ? new Date(value * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    /*
     * A TELJES KÉPERNYŐS OSD RÉTEGZÉSE.
     *
     * A teljes képernyős lejátszó doboza `fixed` és a webOS TV CSS-e
     * 2147483000-re teszi a z-indexét – a korábbi `z-[10000]` OSD tehát
     * MINDIG a kép MÖGÖTT volt, ezért nem lehetett látni (csak a
     * főoldalra visszatérve villant fel, ahol a lejátszó már nem fixed).
     * Az OSD a kép FÖLÖTT van, de nem fogja el a távirányítót
     * (pointer-events-none), és a fókusz sem kerülhet rá.
     */
    <div
      data-fullscreen-osd=""
      className="fixed inset-0 flex flex-col justify-between pointer-events-none text-white"
      style={{ zIndex: 2147483001 }}
      aria-live="polite"
    >
      <div className="flex items-start justify-between bg-gradient-to-b from-black/85 via-black/40 to-transparent px-8 pt-6 pb-12">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex h-14 w-14 shrink-0 items-center justify-center text-4xl font-black leading-none tabular-nums ${accentTextClass[liveAccent]}`}>{displayNumber ?? channel.num}</span>
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-black/30">
            <ChannelLogo url={channel.logo} name={channel.name} retryKey={channel} />
          </div>
          <span className="max-w-[55vw] truncate text-xl font-semibold drop-shadow-lg">{channel.name}</span>
        </div>
      </div>

      <div className="flex flex-col items-center bg-gradient-to-t from-black/90 via-black/55 to-transparent px-8 pt-14 pb-7 text-center">
        {/*
          MOST / KÖVETKEZŐ – FIX, EGYMÁSHOZ IGAZÍTOTT RÁCS.

          Korábban a két sor két külön flex-sor volt, ezért a hosszabb műsorcím
          eltolta a jobb szélt, és a dobozok „ugráltak”. Most egyetlen 3 oszlopos
          rácsban vannak (jelvény | műsorcím | idő), így a MOST és a KÖVETKEZŐ
          jobb széle pixelre egy vonalban van, és a sorok nem mozdulnak el.
          A MOST / KÖVETKEZŐ csak fehér szöveg, háttér és doboz nélkül;
          a műsorcím sárga és nagyobb, hogy TV-ről is jól olvasható legyen.
        */}
        <div className="flex w-full max-w-5xl flex-col items-center gap-3">
        <div
          data-fullscreen-osd-epg=""
          className="grid w-full grid-cols-[7rem_minmax(0,1fr)_7.5rem] items-center gap-x-4 gap-y-2"
        >
          <span className="min-w-0 text-center text-base font-black tracking-wide text-white">MOST</span>
          <span className="min-w-0 truncate text-left text-2xl font-bold leading-8 text-amber-300 drop-shadow-lg">
            {channel.epgNow?.title || 'Műsoradat nem érhető el'}
          </span>
          <span className="justify-self-end whitespace-nowrap text-right text-base font-semibold tabular-nums text-white/80">
            {time(start)}{start && end ? ' – ' : ''}{time(end)}
          </span>

          <span className="min-w-0 text-center text-base font-black tracking-wide text-white">KÖVETKEZŐ</span>
          <span className="min-w-0 truncate text-left text-2xl font-bold leading-8 text-amber-300/90 drop-shadow-lg">
            {channel.epgNext?.title || 'Nincs következő műsoradat'}
          </span>
          <span className="justify-self-end whitespace-nowrap text-right text-base font-semibold tabular-nums text-white/70">
            {channel.epgNext?.time || ''}
          </span>
        </div>
          <div className="mt-1 flex w-full items-center gap-3 text-base font-semibold tabular-nums text-white drop-shadow-md">
            <span className="shrink-0 whitespace-nowrap text-left">{time(start)}</span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/25">
              <div className="h-full rounded-full bg-amber-400 transition-[width] duration-500" style={{ width: `${hasProgress ? progress : 0}%` }} />
            </div>
            <span className="shrink-0 whitespace-nowrap text-right">{time(end)}</span>
          </div>
        </div>
      </div>

      {/*
        HANGSÁV / FELIRAT JELZŐK – a teljes képernyő alsó sarkaiban
        (Audio a bal, CC a jobb oldalon), ugyanolyan méretben, mint a
        főoldali OSD-ben (a compact OSD `text-sm`, `w-4 h-4` ikonok,
        `px-2 py-1`, lekerekített keret).
      */}
      <div
        data-fullscreen-osd-badges=""
        className="pointer-events-none absolute inset-x-8 bottom-6 flex items-center justify-between"
      >
        <div
          className={`inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-[#121f3d] px-2 py-1 text-sm font-bold text-slate-200 ${
            hasMultipleAudioTracks ? 'ring-1 ring-emerald-400/60' : ''
          }`}
          aria-label={hasMultipleAudioTracks ? 'Több hangsáv elérhető' : 'Audio'}
        >
          <Mic2 className={`w-4 h-4 ${hasMultipleAudioTracks ? 'text-emerald-400' : 'text-rose-400'}`} />
          <span>Audio</span>
        </div>
        <div
          className={`inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-[#121f3d] px-2 py-1 text-sm font-bold text-slate-200 ${
            hasAvailableSubtitle ? 'ring-1 ring-emerald-400/60' : ''
          }`}
          aria-label={hasAvailableSubtitle ? 'Felirat elérhető' : 'Felirat'}
        >
          <Subtitles className={`w-4 h-4 ${hasAvailableSubtitle ? 'text-emerald-400' : 'text-cyan-300'}`} />
          <span>CC</span>
        </div>
      </div>
    </div>
  );
};

export const ChannelControls: React.FC<ChannelControlsProps> = ({
  channel,
  displayNumber,
  onToggleFavorite,
  hasMultipleAudioTracks,
  hasAvailableSubtitle = false,
  onCastToTv,
  onTogglePip,
  showPip = false,
  showCast = false,
  onRequestHide,
  hideHeaderActions = false,
  className,
  isActive = true,
}) => {
  const [epgClock, setEpgClock] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!isActive) return;
    setEpgClock(Date.now());
    const timer = window.setInterval(() => setEpgClock(Date.now()), 10000);
    return () => window.clearInterval(timer);
  }, [isActive]);

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
    <div className={`relative box-border w-full ${compactMainOsd ? 'h-[260px] min-h-[260px] max-h-[260px] overflow-hidden px-4 pt-2 pb-2 gap-1' : 'max-h-[calc(100dvh-8px)] overflow-y-auto px-4 pt-3 pb-3 sm:px-6 sm:pt-4 gap-2.5'} bg-[#0e1d3b]/95 border-2 border-cyan-500/60 rounded-xl flex flex-col select-none shadow-sm ${className || ''}`}>
      {!hideHeaderActions && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
          <button onClick={() => onToggleFavorite(channel.id)} className={`shrink-0 p-2 rounded-xl border active:scale-90 ${channel.isFavorite ? 'bg-amber-400/20 text-amber-300 border-amber-400/50' : 'bg-[#0f1d3a] text-slate-400 border-slate-700/60'}`} title="Kedvencekhez adás" aria-label="Kedvencekhez adás">
            <Star className={`w-5 h-5 ${channel.isFavorite ? 'fill-amber-400 text-amber-400' : ''}`} />
          </button>
          {onRequestHide && <button onClick={onRequestHide} className="shrink-0 p-2 rounded-xl border border-slate-700/60 bg-[#0f1d3a] text-slate-300" title="Vezérlők elrejtése" aria-label="Vezérlők elrejtése"><X className="w-5 h-5" /></button>}
        </div>
      )}

      {/* Fix magasságú fejléc: a csatornalogó és a szöveg soha nem méretezi át az OSD-t. */}
      <div className={`relative flex w-full items-center shrink-0 ${compactMainOsd ? 'h-20 min-h-20 max-h-20 gap-2 px-1 pt-0' : 'gap-3 px-2'}`}>
        {compactMainOsd && <div className="shrink-0 w-10 h-full flex items-center justify-center text-cyan-300 text-3xl font-black tracking-tight leading-none">{displayNumber ?? '—'}</div>}
        <div className={`relative shrink-0 rounded-xl bg-[#0e1e3e] border border-cyan-700/70 p-1.5 flex items-center justify-center overflow-hidden shadow-inner ${compactMainOsd ? 'w-24 h-20' : 'w-20 h-16 sm:w-24 sm:h-20'}`}>
          <ChannelLogo url={channel.logo} name={channel.name} retryKey={channel} />
          {!compactMainOsd && <span className="absolute -top-0.5 -left-0.5 rounded-br-md bg-[#0e1d3b] px-1.5 py-0.5 text-sm sm:text-base text-cyan-300 font-black tracking-wide leading-none">{displayNumber ?? '—'}</span>}
        </div>
        <div className={`min-w-0 flex-1 h-full flex flex-col justify-center text-center ${compactMainOsd ? 'px-1 gap-1' : 'text-left gap-1'}`}>
          <h2 className={`w-full text-white font-black tracking-tight leading-7 truncate ${compactMainOsd ? 'h-7 text-2xl sm:text-3xl' : 'text-lg sm:text-2xl'}`} title={channel.name}>{channel.name}</h2>
          <div className={`w-full text-amber-300 font-extrabold leading-6 ${compactMainOsd ? 'h-12 text-xl sm:text-2xl line-clamp-2 overflow-hidden' : 'text-base sm:text-lg line-clamp-2'}`} title={channel.epgNow?.title || 'Élő adás'}>{channel.epgNow?.title || 'Élő adás'}</div>
        </div>
      </div>

      <div className={`flex items-center gap-3 w-full shrink-0 ${compactMainOsd ? 'h-8 min-h-8 mt-1' : ''}`}>
        <span className={`shrink-0 text-slate-200 ${compactMainOsd ? 'text-xl' : 'text-xs sm:text-sm'} font-bold tabular-nums`}>{formatTime(epgStart)}</span>
        <div className={`flex-1 bg-slate-800/90 rounded-full ${compactMainOsd ? 'h-3' : 'h-2'} overflow-hidden flex shadow-inner`} role="progressbar" aria-label={channel.epgNow?.title ? `${channel.epgNow.title} műsorhaladása` : 'EPG műsorhaladása'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={hasEpgProgress ? Math.round(epgProgress) : 0}>
          <div className="bg-linear-to-r from-amber-400 to-yellow-300 h-full rounded-full transition-all duration-500 shadow-sm shadow-amber-400" style={{ width: `${hasEpgProgress ? epgProgress : 0}%` }} />
        </div>
        <span className={`shrink-0 text-slate-200 ${compactMainOsd ? 'text-xl' : 'text-xs sm:text-sm'} font-bold tabular-nums`}>{formatTime(epgEnd)}</span>
      </div>

      {/* Mindhárom műsor állandó magasságú sorban van; hiányzó EPG-adatnál is megmarad a helyük. */}
      <div className={`w-full flex flex-col items-stretch text-center border-t border-cyan-900/70 ${compactMainOsd ? 'pt-1 gap-0.5 flex-1 min-h-0 overflow-hidden' : 'pt-2 gap-1'}`}>
        {(compactMainOsd ? [0, 1, 2] : [0, 1, 2].filter((index) => index < upcoming.length)).map((index) => {
          const program = upcoming[index];
          return (
            <div key={index} className={`w-full min-w-0 ${compactMainOsd ? 'h-6 min-h-6 max-h-6 text-lg sm:text-xl leading-6 truncate' : 'text-base sm:text-lg leading-snug break-words'} font-bold text-slate-100`} title={program?.title || ''}>
              {program?.title || ' '}
            </div>
          );
        })}
      </div>

      {compactMainOsd && (
        <div className="shrink-0 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 pointer-events-none">
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-[#121f3d] px-2 py-1 text-sm font-bold text-slate-200" aria-label={hasMultipleAudioTracks ? 'Több hangsáv elérhető' : 'Audio'}>
            <Mic2 className={`w-4 h-4 ${hasMultipleAudioTracks ? 'text-emerald-400' : 'text-rose-400'}`} /><span>Audio</span>
          </div>
          <div className="min-w-0 text-center text-xs font-bold text-slate-400 truncate"> </div>
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-[#121f3d] px-2 py-1 text-sm font-bold text-slate-200" aria-label={hasAvailableSubtitle ? 'Felirat aktív' : 'CC'}>
            <Subtitles className={`w-4 h-4 ${hasAvailableSubtitle ? 'text-emerald-400' : 'text-cyan-300'}`} /><span>CC</span>
          </div>
        </div>
      )}
      {(showPip || showCast) && (
        <div className={`flex items-center justify-center gap-2 ${compactMainOsd ? 'pt-0 shrink-0' : 'pt-1'}`}>
          {showPip && <button onClick={onTogglePip} className="flex items-center gap-1 py-1.5 px-2 rounded-lg bg-[#121f3d] text-slate-200 border border-slate-700/60 text-xs font-bold" title="Kép a képben"><PictureInPicture2 className="w-4 h-4 text-slate-300" /><span>PiP</span></button>}
          {showCast && <button onClick={onCastToTv} className="flex items-center gap-1 py-1.5 px-2 rounded-lg bg-[#121f3d] text-slate-200 border border-slate-700/60 text-xs font-bold" title="Aktuális adás küldése TV-re" aria-label="Aktuális adás küldése TV-re"><Cast className="w-4 h-4 text-cyan-300" /><span>TV</span></button>}
        </div>
      )}
    </div>
  );
};
