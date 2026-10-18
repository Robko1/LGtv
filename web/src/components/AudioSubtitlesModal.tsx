import React from 'react';
import { AudioTrack, SubtitleTrack, AppSettings, SubtitleSize } from '../types/iptv';
import { X, Subtitles, Mic2, Check } from 'lucide-react';

interface AudioSubtitlesModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdateSettings: (newSettings: Partial<AppSettings>) => void;
  mode?: 'audio' | 'subtitle';
  audioTracks?: AudioTrack[];
  onSelectAudioTrack?: (track: AudioTrack) => void;
  subtitleTracks?: SubtitleTrack[];
  onSelectSubtitleTrack?: (track: SubtitleTrack | null) => void;
}

export const AudioSubtitlesModal: React.FC<AudioSubtitlesModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  mode = 'audio',
  audioTracks = [],
  onSelectAudioTrack,
  subtitleTracks = [],
  onSelectSubtitleTrack,
}) => {
  const [pendingAudioTrackId, setPendingAudioTrackId] = React.useState<string | null>(null);
  const [pendingSubtitleTrackId, setPendingSubtitleTrackId] = React.useState<string | null>(null);

  // Hooks must run in the same order whether the modal is open or closed.
  React.useEffect(() => {
    if (!isOpen || mode !== 'audio' || pendingAudioTrackId === null) return;
    const selected = audioTracks.some(
      (track) => String(track.id) === pendingAudioTrackId && track.selected === true
    );
    if (selected) {
      setPendingAudioTrackId(null);
      onClose();
    }
  }, [isOpen, mode, pendingAudioTrackId, audioTracks, onClose]);

  React.useEffect(() => {
    if (!isOpen || mode !== 'subtitle' || pendingSubtitleTrackId === null) return;
    const selected = subtitleTracks.some(
      (track) => String(track.id) === pendingSubtitleTrackId && track.selected === true
    );
    if (selected) {
      setPendingSubtitleTrackId(null);
      onClose();
    }
  }, [isOpen, mode, pendingSubtitleTrackId, subtitleTracks, onClose]);

  if (!isOpen) return null;

  // Csak a lejátszó által ténylegesen felismert sávokat mutatjuk.
  // A korábbi „Magyar/Angol/Automatikus” tartaléklista csak a preferenciát
  // mentette, a stream hangsávját nem tudta megváltoztatni.
  const orderedAudioOptions = audioTracks.map((track) => ({
    id: String(track.id),
    name: track.name || track.lang || 'Hangsáv',
    format: [track.lang, track.codec, track.channels].filter(Boolean).join(' / ') || 'Lejátszó hangsáv',
    track,
  }));
  const availableTracks = subtitleTracks;
  const subtitleOptions: Array<{ id: string; name: string; track?: SubtitleTrack }> = [
    ...availableTracks.map((track) => ({
      id: String(track.id),
      name: track.name || track.lang || 'Felirat',
      track,
    })),
    { id: 'Kikapcsolva', name: 'Felirat kikapcsolva' },
  ];
  const subtitleSizes: SubtitleSize[] = ['75%', '100%', '125%', '150%', '200%'];

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-3 md:p-4 lg:p-6 bg-black/80 backdrop-blur-sm animate-fadeIn select-none lg:select-auto pointer-events-auto">
      <div role="dialog" aria-modal="true" className="bg-[#081329] border-2 border-cyan-500/60 rounded-xl max-w-md md:max-w-lg lg:max-w-xl xl:max-w-2xl w-full max-h-[85vh] lg:max-h-[80vh] flex flex-col shadow-2xl animate-scaleUp overflow-hidden">
        <div className="p-4 bg-[#0a1835] border-b border-cyan-950 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {mode === 'subtitle'
              ? <Subtitles className="w-5 h-5 text-cyan-300 stroke-[2.5]" />
              : <Mic2 className="w-5 h-5 text-rose-400 stroke-[2.5]" />}
            <h2 className="text-base sm:text-lg font-black text-white tracking-wide">{mode === 'subtitle' ? 'FELIRAT' : 'HANGSÁV'}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Bezárás"
            className="p-1.5 rounded-full border-2 border-cyan-500/60 bg-[#0e1d3b] hover:bg-[#16274b] text-cyan-300 active:scale-90 transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {mode === 'audio' ? (
            <div className="space-y-2">
              <h3 className="text-xs font-black text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
                <Mic2 className="w-3.5 h-3.5 text-rose-400" />
                <span>Hangsáv Választása</span>
              </h3>
              <div className="space-y-1.5">
                {orderedAudioOptions.length === 0 ? (
                  <p className="rounded-xl border border-slate-700 bg-[#0a152d] p-3 text-xs text-slate-400">
                    A lejátszó nem jelzett választható hangsávot ehhez az adáshoz.
                  </p>
                ) : orderedAudioOptions.map((opt) => {
                  const hasNativeSelection = orderedAudioOptions.some((option) => option.track.selected === true);
                  const isSelected = opt.track.selected === true
                    || (!hasNativeSelection && opt.id === orderedAudioOptions[0]?.id);
                  return (
                    <button
                      key={opt.id}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setPendingAudioTrackId(opt.id);
                        onSelectAudioTrack?.(opt.track);
                        // Ha ez a sáv már aktív, azonnal bezárható.
                        if (opt.track.selected === true) {
                          setPendingAudioTrackId(null);
                          onClose();
                        }
                      }}
                      className={`p-3 w-full rounded-2xl flex items-center justify-between cursor-pointer border transition-all ${
                        isSelected
                          ? 'bg-[#0f244a] border-cyan-400 text-white shadow-md ring-1 ring-cyan-400/40'
                          : 'bg-[#0a152d] border-slate-800 text-slate-300 hover:bg-[#102042]'
                      }`}
                    >
                      <div>
                        <span className="block text-xs sm:text-sm font-bold">{opt.name}</span>
                        <span className="block text-[11px] text-slate-400 font-mono mt-0.5">{opt.format}</span>
                      </div>
                      {isSelected && <span className="w-6 h-6 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center shrink-0"><Check className="w-4 h-4 stroke-[3]" /></span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
          <>
          <div className="space-y-2">
            <h3 className="text-xs font-black text-cyan-300 uppercase tracking-wider flex items-center gap-1.5">
              <Subtitles className="w-3.5 h-3.5 text-cyan-300" />
              <span>FELIRAT VÁLASZTÁS</span>
            </h3>
            <div className="space-y-1.5">
              {availableTracks.length === 0 ? (
                <p className="rounded-xl border border-slate-700 bg-[#0a152d] p-3 text-xs text-slate-400">
                  A lejátszó nem jelzett választható feliratsávot ehhez az adáshoz.
                </p>
              ) : null}
              {subtitleOptions.map((opt) => {
                const preferred = (settings.preferredSubtitle || 'Magyar').toLowerCase();
                const hasNativeSelection = availableTracks.some((track) => track.selected === true);
                const isSelected = opt.track
                  ? (hasNativeSelection
                      ? opt.track.selected === true
                      : preferred === opt.id.toLowerCase() || preferred === opt.track.lang.toLowerCase() || preferred === opt.track.name.toLowerCase() || (opt.id === 'Magyar' && /^(hu|hun|hungarian|magyar)$/i.test(preferred)))
                  : !hasNativeSelection && preferred === 'kikapcsolva';
                return (
                  <button
                    key={opt.id}
                    onClick={() => {
                      if (opt.id === 'Kikapcsolva') {
                        if (availableTracks.length > 0) onSelectSubtitleTrack?.(null);
                        setPendingSubtitleTrackId(null);
                        onUpdateSettings({ preferredSubtitle: 'Kikapcsolva' });
                        onClose();
                        return;
                      }
                      if (opt.track) {
                        setPendingSubtitleTrackId(String(opt.track.id));
                        onSelectSubtitleTrack?.(opt.track);
                        onUpdateSettings({ preferredSubtitle: opt.track.lang || opt.track.name || opt.id });
                        if (opt.track.selected === true) {
                          setPendingSubtitleTrackId(null);
                          onClose();
                        }
                      }
                    }}
                    className={`p-3 w-full rounded-2xl flex items-center justify-between cursor-pointer border transition-all ${
                      isSelected
                        ? 'bg-[#0f244a] border-cyan-400 text-white shadow-md ring-1 ring-cyan-400/40'
                        : 'bg-[#0a152d] border-slate-800 text-slate-300 hover:bg-[#102042]'
                    }`}
                  >
                    <span className="text-xs sm:text-sm font-bold">{opt.name}</span>
                    {isSelected && <span className="w-6 h-6 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center shrink-0"><Check className="w-4 h-4 stroke-[3]" /></span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="pt-3 border-t border-cyan-950 space-y-2">
            <h3 className="text-xs font-black text-cyan-300 uppercase tracking-wider">Felirat mérete</h3>
            <div className="grid grid-cols-5 gap-1">
              {subtitleSizes.map((size) => (
                <button
                  key={size}
                  onClick={() => onUpdateSettings({ subtitleSize: size })}
                  className={`py-2 rounded-lg text-xs font-bold transition-all border ${
                    settings.subtitleSize === size
                      ? 'bg-cyan-400 text-slate-950 font-black shadow-md border-cyan-400'
                      : 'bg-[#0e1d3b] text-slate-300 border-slate-700/60 hover:bg-[#102042]'
                  }`}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  );
};
