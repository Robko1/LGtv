import { ChannelLogo } from './ChannelLogo';
import React from 'react';
import { Channel } from '../types/iptv';
import {
  Star,
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
  showPip?: boolean;
  showCast?: boolean;
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
  // A műsorhaladás-sáv 10 mp-enként lép tovább (nem másodpercenként: a
  // másodperces újrarajzolás a TV-n érezhetően lassította az OSD-t).
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

      {/*
        Alsó gombsor: csak az Audio / CC / PiP marad.
        Az OSD-ből kivettük az EPG-újságot, a hangerőt, az előző/következő
        csatornát ÉS a középső Lejátszás/Szünet gombot is (a csatornaváltás
        és a lejátszás a listán / a távirányító médiagombjaival történik).
      */}
      <div className="flex items-stretch gap-1.5 pt-0.5">

        {/* Audio Button */}
        <button
          onClick={onOpenAudioModal}
          className={`flex-1 flex items-center justify-center gap-1 py-2 px-1 rounded-xl text-xs font-bold active:scale-95 transition-all shadow-sm border ${hasMultipleAudioTracks ? 'bg-emerald-950/60 hover:bg-emerald-900/70 text-emerald-300 border-emerald-500/50' : 'bg-[#121f3d] hover:bg-[#17274c] text-rose-300 border-rose-500/30'}`}
          title={hasMultipleAudioTracks ? 'Több hangsáv elérhető' : 'Nincs több hangsáv ennél a csatornánál'}
          aria-label={hasMultipleAudioTracks ? 'Hangsávváltás elérhető' : 'Több hangsáv nem található'}
        >
          <Mic2 className={`w-3.5 h-3.5 ${hasMultipleAudioTracks ? 'text-emerald-400' : 'text-rose-400'}`} />
          <span>Audio</span>
        </button>

        {/* CC Subtitles Button */}
        <button
          onClick={onOpenSubtitlesModal}
          className={`flex-1 flex items-center justify-center gap-1 py-2 px-1 rounded-xl text-xs font-bold active:scale-95 transition-all shadow-sm border ${hasActiveSubtitle ? 'bg-emerald-950/60 hover:bg-emerald-900/70 text-emerald-300 border-emerald-500/50' : 'bg-[#121f3d] hover:bg-[#17274c] text-slate-200 border-slate-700/60'}`}
          title={hasActiveSubtitle ? 'Felirat aktív' : 'Felirat választása'}
          aria-label={hasActiveSubtitle ? 'Felirat aktív' : 'Felirat választása'}
        >
          <Subtitles className={`w-3.5 h-3.5 ${hasActiveSubtitle ? 'text-emerald-400' : 'text-cyan-300'}`} />
          <span>CC</span>
        </button>

        {/* PiP Button */}
        {showPip && (
          <button
            onClick={onTogglePip}
            className="flex-1 flex items-center justify-center gap-1 py-2 px-1 rounded-xl bg-[#121f3d] hover:bg-[#17274c] text-slate-200 border border-slate-700/60 text-xs font-bold active:scale-95 transition-all shadow-sm"
            title="Kép a képben"
          >
            <PictureInPicture2 className="w-3.5 h-3.5 text-slate-300" />
            <span>PiP</span>
          </button>
        )}

        {/* Google Cast / TV-re küldés */}
        {showCast && (
          <button
            onClick={onCastToTv}
            className="flex-1 flex items-center justify-center gap-1 py-2 px-1 rounded-xl bg-[#121f3d] hover:bg-[#17274c] text-slate-200 border border-slate-700/60 text-xs font-bold active:scale-95 transition-all shadow-sm"
            title="Aktuális adás küldése TV-re"
            aria-label="Aktuális adás küldése TV-re"
          >
            <Cast className="w-3.5 h-3.5 text-cyan-300" />
            <span>TV</span>
          </button>
        )}
      </div>

    </div>
  );
};
