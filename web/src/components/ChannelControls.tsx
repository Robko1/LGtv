import { ChannelLogo } from './ChannelLogo';
import React from 'react';
import { Channel } from '../types/iptv';
import { 
  Star, 
  SkipBack, 
  SkipForward, 
  Play, 
  Pause, 
  Volume2, 
  VolumeX,
  Calendar, 
  Mic2, 
  Subtitles, 
  PictureInPicture2,
  Cast,
  X,
} from 'lucide-react';

interface ChannelControlsProps {
  channel: Channel | null;
  /** Csak megjelenítési sorszám; a csatorna eredeti num értékét nem módosítja. */
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
  onOpenEpgModal: () => void;
  volume: number;
  onVolumeChange: (value: number) => void;
  onToggleMute: () => void;
  /**
   * Ha meg van adva, a fejlécben megjelenik egy ✕ gomb, amivel a teljes
   * képernyős OSD elrejthető. A főoldali panelen (ahol nincs megadva) a
   * megjelenés pontosan a régi marad.
   */
  onRequestHide?: () => void;
  /** A fejléc csillag- és X-gombjainak elrejtése az álló teljes képernyős OSD-ben. */
  hideHeaderActions?: boolean;
  /** Kiegészítő osztályok a teljes képernyős réteghez (a panel kinézete ugyanaz). */
  className?: string;
  /**
   * A hívó elfogadja a „csatorna részletei” kérést (a Beállítások megnyitása).
   * A panel kinézetét nem érinti; a főoldal adja át.
   */
  onOpenChannelDetails?: () => void;
}

export const ChannelControls: React.FC<ChannelControlsProps> = ({
  channel,
  displayNumber,
  isPlaying,
  onTogglePlay,
  onPrevChannel,
  onNextChannel,
  onToggleFavorite,
  onOpenAudioModal,
  hasMultipleAudioTracks,
  hasActiveSubtitle = false,
  onOpenSubtitlesModal,
  onCastToTv,
  onTogglePip,
  onOpenEpgModal,
  volume,
  onVolumeChange,
  onToggleMute,
  onRequestHide,
  hideHeaderActions = false,
  className,
}) => {
  const [epgClock, setEpgClock] = React.useState(() => Date.now());
  const [showVolumeSlider, setShowVolumeSlider] = React.useState(false);
  const volumeControlRef = React.useRef<HTMLDivElement | null>(null);
  const volumeClickTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCoarsePointer = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : true;
  React.useEffect(() => () => { if (volumeClickTimer.current) clearTimeout(volumeClickTimer.current); }, []);
  React.useEffect(() => {
    if (!showVolumeSlider) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (volumeControlRef.current && !volumeControlRef.current.contains(event.target as Node)) {
        setShowVolumeSlider(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('mousedown', closeOnOutsideClick as any);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('mousedown', closeOnOutsideClick as any);
    };
  }, [showVolumeSlider]);
  const handleVolumeButtonClick = () => {
    // Telefonon: 1 kattintás némít, dupla gyors kattintás csúszka
    // Laptop/desktop egérrel: hover is nyitja, de kattintás is működik
    if (showVolumeSlider) {
      if (volumeClickTimer.current) {
        clearTimeout(volumeClickTimer.current);
        volumeClickTimer.current = null;
      }
      setShowVolumeSlider(false);
      return;
    }
    if (volumeClickTimer.current) {
      clearTimeout(volumeClickTimer.current);
      volumeClickTimer.current = null;
      setShowVolumeSlider(true);
      return;
    }
    volumeClickTimer.current = setTimeout(() => {
      volumeClickTimer.current = null;
      onToggleMute();
    }, 260);
  };
  const handleVolumeMouseEnter = () => {
    if (!isCoarsePointer) setShowVolumeSlider(true);
  };
  const handleVolumeMouseLeave = () => {
    if (!isCoarsePointer) {
      // Kis késleltetés, hogy a csúszkára is át lehessen menni egérrel
      setTimeout(() => {
        if (volumeControlRef.current && !volumeControlRef.current.matches(':hover')) {
          setShowVolumeSlider(false);
        }
      }, 300);
    }
  };
  React.useEffect(() => {
    const timer = window.setInterval(() => setEpgClock(Date.now()), 10000);
    return () => window.clearInterval(timer);
  }, []);

  const epgStart = channel?.epgNow?.startTimestamp;
  const epgEnd = channel?.epgNow?.endTimestamp;
  const epgProgress = typeof epgStart === 'number' && typeof epgEnd === 'number' && epgEnd > epgStart
    ? Math.min(100, Math.max(0, ((epgClock / 1000 - epgStart) / (epgEnd - epgStart)) * 100))
    : 0;
  const hasEpgProgress = typeof epgStart === 'number' && typeof epgEnd === 'number' && epgEnd > epgStart;

  if (!channel) return null;

  return (
    <div className={`bg-[#0e1d3b]/90 border-2 border-cyan-500/60 rounded-xl p-3 flex flex-col gap-2.5 select-none shadow-sm ${className || ''}`}>
      {/* Channel Header Banner (Exact match to screenshot 5/6) */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 overflow-hidden">
          {/* Csatornaszám: kék szám, háttérdoboz nélkül */}
          <div className="shrink-0 px-3 py-1 rounded-xl bg-transparent text-cyan-300 font-black text-lg tracking-wider flex items-center justify-center min-w-[68px]">
            {displayNumber ?? '—'}
          </div>

          {/* Logo */}
          <div className="shrink-0 w-11 h-9 rounded-lg bg-[#0e1e3e] border border-cyan-800/40 p-1 flex items-center justify-center overflow-hidden shadow-inner">
            <ChannelLogo url={channel.logo} name={channel.name} retryKey={channel} />
          </div>

          {/* Title & EPG Info */}
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-white font-black text-sm sm:text-base truncate tracking-tight">
                {channel.name}
              </h2>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-amber-400 font-bold flex items-center gap-1 truncate">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block" />
                {channel.epgNow?.title ? channel.epgNow.title : 'Élő adás'}
              </span>
            </div>
          </div>
        </div>

        {!hideHeaderActions && (
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Favorite Star Button */}
          <button
            onClick={() => onToggleFavorite(channel.id)}
            className={`shrink-0 p-2 rounded-xl border transition-all active:scale-90 ${
              channel.isFavorite
                ? 'bg-amber-400/20 text-amber-300 border-amber-400/50 shadow-md shadow-amber-500/20'
                : 'bg-[#0f1d3a] text-slate-400 border-slate-700/60 hover:text-amber-400'
            }`}
            title="Kedvencekhez adás"
          >
            <Star className={`w-5 h-5 ${channel.isFavorite ? 'fill-amber-400 text-amber-400' : ''}`} />
          </button>

          {/* Teljes képernyős OSD elrejtése (csak ott, ahol ezt kértük) */}
          {onRequestHide && (
            <button
              onClick={onRequestHide}
              className="shrink-0 p-2 rounded-xl border border-slate-700/60 bg-[#0f1d3a] text-slate-300 hover:text-white transition-all active:scale-90"
              title="Vezérlők elrejtése"
              aria-label="Vezérlők elrejtése"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        )}
      </div>

      {/* Valós EPG-műsorhaladás, a csatorna EPG-kezdete és -vége alapján */}
      <div
        className="w-full bg-slate-800/80 rounded-full h-1.5 overflow-hidden flex shadow-inner"
        role="progressbar"
        aria-label={channel.epgNow?.title ? `${channel.epgNow.title} műsorhaladása` : 'EPG műsorhaladása'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={hasEpgProgress ? Math.round(epgProgress) : 0}
      >
        <div
          className="bg-linear-to-r from-amber-400 to-yellow-300 h-full rounded-full transition-all duration-500 shadow-sm shadow-amber-400"
          style={{ width: `${hasEpgProgress ? epgProgress : 0}%` }}
        />
      </div>

      {/* Primary Playback Controls Row (Screenshot 5/6) */}
      <div className="flex items-center gap-1.5 pt-0.5">
        <div className="flex flex-1 items-center justify-center gap-1.5 sm:gap-2 min-w-0">
          {/* Prev Channel */}
          <button
            onClick={onPrevChannel}
            className="w-10 h-10 rounded-xl bg-[#0f1d3a] hover:bg-[#16274b] text-slate-200 border border-slate-700/60 flex items-center justify-center active:scale-90 transition-all shadow-md"
            title="Előző csatorna"
          >
            <SkipBack className="w-4 h-4 fill-current" />
          </button>

          {/* Play / Pause Primary Button */}
          <button
            onClick={onTogglePlay}
            className="w-10 h-10 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 flex items-center justify-center active:scale-95 transition-all shadow-lg shadow-cyan-400/25"
            title={isPlaying ? "Szünet" : "Lejátszás"}
            aria-label={isPlaying ? "Szünet" : "Lejátszás"}
          >
            {isPlaying ? (
              <Pause className="w-4 h-4 fill-current stroke-[2.5]" />
            ) : (
              <Play className="w-4 h-4 fill-current stroke-[2.5]" />
            )}
          </button>

          {/* Next Channel */}
          <button
            onClick={onNextChannel}
            className="w-10 h-10 rounded-xl bg-[#0f1d3a] hover:bg-[#16274b] text-slate-200 border border-slate-700/60 flex items-center justify-center active:scale-90 transition-all shadow-md"
            title="Következő csatorna"
          >
            <SkipForward className="w-4 h-4 fill-current" />
          </button>

        </div>

        <div className="flex items-center gap-1.5">
          {/* Audio toggle button – egér hover laptop/desktop */}
          <div className="relative" ref={volumeControlRef} onMouseEnter={handleVolumeMouseEnter} onMouseLeave={handleVolumeMouseLeave}>
          <button
          onClick={handleVolumeButtonClick}
          className={`w-10 h-10 rounded-xl border flex items-center justify-center active:scale-90 transition-all shadow-md ${volume <= 0 ? 'bg-red-600/20 text-red-400 border-red-500/60' : 'bg-[#0f1d3a] hover:bg-[#16274b] text-slate-200 border-slate-700/60'}`}
          title="Egy kattintás: némítás; két gyors kattintás: hangerő"
          aria-label={volume <= 0 ? 'Hang bekapcsolása' : 'Hang némítása'}
          >
          {volume <= 0 ? <VolumeX className="w-5 h-5 text-red-400" /> : <Volume2 className="w-5 h-5 text-cyan-300" />}
          </button>
          {showVolumeSlider && (
          <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-[120] min-w-[68px] rounded-xl border border-cyan-700/60 bg-[#081226] px-4 py-3 shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <input type="range" min="0" max="1" step="0.01" value={volume}
          onChange={(event) => onVolumeChange(Number(event.target.value))}
          aria-label="Hangerő" className="h-28 w-6 accent-cyan-400 cursor-pointer"
          style={{ writingMode: 'vertical-lr', direction: 'rtl' }} />
          <div className="mt-1 text-center text-[10px] text-slate-300">{Math.round(volume * 100)}%</div>
          </div>
          )}
          </div>
          {/* EPG Calendar button */}
          <button
            onClick={onOpenEpgModal}
            className="w-10 h-10 rounded-xl bg-[#0f1d3a] hover:bg-[#16274b] text-amber-300 border border-amber-500/30 flex items-center justify-center active:scale-90 transition-all shadow-md"
            title="EPG Műsorújság"
          >
            <Calendar className="w-4 h-4 text-amber-400" />
          </button>

        </div>
      </div>

      {/* Feature Action Buttons Row: Audio, CC, PiP, Cast – Kép gomb eltávolítva minden OSD-ből */}
      <div className="grid grid-cols-4 gap-1.5 pt-0.5">

        {/* Audio Button */}
        <button
          onClick={onOpenAudioModal}
          className={`flex items-center justify-center gap-1 py-2 px-1 rounded-xl text-xs font-bold active:scale-95 transition-all shadow-sm border ${hasMultipleAudioTracks ? 'bg-emerald-950/60 hover:bg-emerald-900/70 text-emerald-300 border-emerald-500/50' : 'bg-[#121f3d] hover:bg-[#17274c] text-rose-300 border-rose-500/30'}`}
          title={hasMultipleAudioTracks ? 'Több hangsáv elérhető' : 'Nincs több hangsáv ennél a csatornánál'}
          aria-label={hasMultipleAudioTracks ? 'Hangsávváltás elérhető' : 'Több hangsáv nem található'}
        >
          <Mic2 className={`w-3.5 h-3.5 ${hasMultipleAudioTracks ? 'text-emerald-400' : 'text-rose-400'}`} />
          <span>Audio</span>
        </button>

        {/* CC Subtitles Button */}
        <button
          onClick={onOpenSubtitlesModal}
          className={`flex items-center justify-center gap-1 py-2 px-1 rounded-xl text-xs font-bold active:scale-95 transition-all shadow-sm border ${hasActiveSubtitle ? 'bg-emerald-950/60 hover:bg-emerald-900/70 text-emerald-300 border-emerald-500/50' : 'bg-[#121f3d] hover:bg-[#17274c] text-slate-200 border-slate-700/60'}`}
          title={hasActiveSubtitle ? 'Felirat aktív' : 'Felirat választása'}
          aria-label={hasActiveSubtitle ? 'Felirat aktív' : 'Felirat választása'}
        >
          <Subtitles className={`w-3.5 h-3.5 ${hasActiveSubtitle ? 'text-emerald-400' : 'text-cyan-300'}`} />
          <span>CC</span>
        </button>

        {/* PiP Button */}
        <button
          onClick={onTogglePip}
          className="w-full flex items-center justify-center gap-1 py-2 px-1 rounded-xl bg-[#121f3d] hover:bg-[#17274c] text-slate-200 border border-slate-700/60 text-xs font-bold active:scale-95 transition-all shadow-sm"
          title="Kép a képben"
        >
          <PictureInPicture2 className="w-3.5 h-3.5 text-slate-300" />
          <span>PiP</span>
        </button>

        {/* Google Cast / TV-re küldés */}
        <button
          onClick={onCastToTv}
          className="w-full flex items-center justify-center gap-1 py-2 px-1 rounded-xl bg-[#121f3d] hover:bg-[#17274c] text-slate-200 border border-slate-700/60 text-xs font-bold active:scale-95 transition-all shadow-sm"
          title="Aktuális adás küldése TV-re"
          aria-label="Aktuális adás küldése TV-re"
        >
          <Cast className="w-3.5 h-3.5 text-cyan-300" />
          <span>TV</span>
        </button>
      </div>

    </div>
  );
};
