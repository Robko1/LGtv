import React from 'react';
import { AudioTrack, SubtitleTrack, AppSettings, SubtitleSize } from '../types/iptv';
import { Subtitles, Mic2, Check } from 'lucide-react';
import { normalizeTvKey } from '../utils/tvKeys';
import { trackLabel } from '../utils/trackLabels';

interface AudioSubtitlesModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdateSettings: (newSettings: Partial<AppSettings>) => void;
  mode?: 'audio' | 'subtitle' | 'live';
  audioTracks?: AudioTrack[];
  onSelectAudioTrack?: (track: AudioTrack) => void;
  subtitleTracks?: SubtitleTrack[];
  onSelectSubtitleTrack?: (track: SubtitleTrack | null) => void;
}

type LiveAudioCcSelectorProps = Pick<AudioSubtitlesModalProps,
  'isOpen' | 'onClose' | 'audioTracks' | 'onSelectAudioTrack' | 'subtitleTracks' | 'onSelectSubtitleTrack'
>;

/** A logikai TV-kijelölés kövesse a kisebb, görgethető listát is. */
function revealFocusedTrack(panel: HTMLElement | null): void {
  const row = panel?.querySelector<HTMLElement>('[data-track-focused="1"]');
  const list = row?.closest<HTMLElement>('[data-track-list]');
  if (!row || !list) return;
  const rowRect = row.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  if (rowRect.top < listRect.top) list.scrollTop += rowRect.top - listRect.top;
  else if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom;
}

/** Élő TV: egyetlen, kétoszlopos távirányítós hangsáv- és CC-választó. */
const LiveAudioCcSelector: React.FC<LiveAudioCcSelectorProps> = ({
  isOpen, onClose, audioTracks = [], onSelectAudioTrack, subtitleTracks = [], onSelectSubtitleTrack,
}) => {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [column, setColumn] = React.useState<'audio' | 'subtitle'>('audio');
  const [audioId, setAudioId] = React.useState<string>('');
  const [subtitleId, setSubtitleId] = React.useState<string>('');
  const [pendingAudioId, setPendingAudioId] = React.useState<string | null>(null);
  const [pendingSubtitleId, setPendingSubtitleId] = React.useState<string | null>(null);
  const subtitleItems = React.useMemo<Array<SubtitleTrack | null>>(() => [...subtitleTracks, null], [subtitleTracks]);

  React.useEffect(() => {
    if (!isOpen) return;
    setAudioId(String(audioTracks.find((track) => track.selected)?.id ?? audioTracks[0]?.id ?? ''));
    setSubtitleId(String(subtitleTracks.find((track) => track.selected)?.id ?? (subtitleTracks.length ? subtitleTracks[0].id : 'off')));
    setColumn('audio');
  }, [isOpen, audioTracks, subtitleTracks]);

  React.useEffect(() => {
    if (isOpen && pendingAudioId !== null && audioTracks.some((track) => String(track.id) === pendingAudioId && track.selected)) {
      setPendingAudioId(null); onClose();
    }
  }, [isOpen, pendingAudioId, audioTracks, onClose]);
  React.useEffect(() => {
    if (isOpen && pendingSubtitleId !== null && subtitleTracks.some((track) => String(track.id) === pendingSubtitleId && track.selected)) {
      setPendingSubtitleId(null); onClose();
    }
  }, [isOpen, pendingSubtitleId, subtitleTracks, onClose]);

  React.useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = normalizeTvKey(event);
      if (['Escape', 'Backspace', 'GoBack', 'BrowserBack'].includes(key)) {
        event.preventDefault(); event.stopPropagation(); onClose(); return;
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        event.preventDefault(); event.stopPropagation(); setColumn(key === 'ArrowLeft' ? 'audio' : 'subtitle'); return;
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        const listLength = column === 'audio' ? audioTracks.length : subtitleItems.length;
        if (!listLength) return;
        event.preventDefault(); event.stopPropagation();
        if (column === 'audio') {
          const index = audioTracks.findIndex((track) => String(track.id) === audioId);
          const next = key === 'ArrowDown' ? Math.min(audioTracks.length - 1, Math.max(0, index) + 1) : Math.max(0, (index < 0 ? 0 : index) - 1);
          setAudioId(String(audioTracks[next].id));
        } else {
          const index = subtitleItems.findIndex((track) => String(track?.id ?? 'off') === subtitleId);
          const next = key === 'ArrowDown' ? Math.min(subtitleItems.length - 1, Math.max(0, index) + 1) : Math.max(0, (index < 0 ? 0 : index) - 1);
          setSubtitleId(String(subtitleItems[next]?.id ?? 'off'));
        }
        return;
      }
      if (key === 'Enter' || key === ' ') {
        event.preventDefault(); event.stopPropagation();
        if (column === 'audio') {
          const track = audioTracks.find((item) => String(item.id) === audioId);
          if (!track) return;
          setPendingAudioId(String(track.id)); onSelectAudioTrack?.(track);
          if (track.selected) { setPendingAudioId(null); onClose(); }
        } else {
          const track = subtitleItems.find((item) => String(item?.id ?? 'off') === subtitleId) ?? null;
          if (!track) { onSelectSubtitleTrack?.(null); setPendingSubtitleId(null); onClose(); return; }
          setPendingSubtitleId(String(track.id)); onSelectSubtitleTrack?.(track);
          if (track.selected) { setPendingSubtitleId(null); onClose(); }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, column, audioTracks, subtitleItems, audioId, subtitleId, onClose, onSelectAudioTrack, onSelectSubtitleTrack]);

  React.useLayoutEffect(() => {
    if (isOpen) revealFocusedTrack(panelRef.current);
  }, [isOpen, column, audioId, subtitleId, audioTracks, subtitleTracks]);

  if (!isOpen) return null;
  const panel = 'min-w-0 min-h-0 rounded-xl border border-slate-700/70 bg-[#09152c] p-3 flex flex-col gap-2';
  const rowClass = (focused: boolean, selected: boolean) => `p-3 w-full rounded-xl flex items-center justify-center text-center border transition-all ${focused ? 'bg-[#0f244a] border-yellow-400 text-white shadow-md ring-2 ring-yellow-400/80' : selected ? 'bg-[#0f244a] border-cyan-400 text-white shadow-md ring-1 ring-cyan-400/40' : 'bg-[#0a152d] border-slate-800 text-slate-300'}`;
  return (
    <div className="fixed inset-0 z-[2147483010] flex items-center justify-center p-3 md:p-4 bg-black/80 backdrop-blur-sm animate-fadeIn select-none pointer-events-auto">
      <div ref={panelRef} data-track-panel="live" role="dialog" aria-modal="true" aria-label="Élő TV hangsáv és CC választás" className="bg-[#081329] border-2 border-cyan-500/60 rounded-xl w-full max-w-5xl max-h-[85vh] flex flex-col shadow-2xl animate-scaleUp overflow-hidden">
        <div className="p-4 bg-[#0a1835] border-b border-cyan-950 flex items-center justify-center text-center">
          <div className="flex items-center gap-2"><Mic2 className="w-5 h-5 text-rose-400 stroke-[2.5]" /><Subtitles className="w-5 h-5 text-cyan-300 stroke-[2.5]" /><h2 className="text-base sm:text-lg font-black text-white tracking-wide">HANGSÁV / CC</h2></div>
        </div>
        <div data-track-columns="" className="grid grid-cols-2 gap-3 p-3 md:p-4 overflow-hidden min-h-0">
          <section data-track-column="" className={panel}><h3 className="text-sm font-black text-rose-400 uppercase tracking-wider flex items-center justify-center gap-1.5 text-center"><Mic2 className="w-4 h-4" />HANGSÁV</h3>
            <div data-track-list="" className="overflow-y-auto min-h-0 space-y-1.5">
              {audioTracks.length === 0 && <p className="rounded-xl border border-slate-700 bg-[#0a152d] p-3 text-xs text-slate-400">Nincs jelzett választható hangsáv.</p>}
              {audioTracks.map((track) => { const id = String(track.id); const selected = track.selected === true; return <button key={id} data-track-option="" data-track-focused={column === 'audio' && audioId === id ? '1' : undefined} onClick={() => { setColumn('audio'); setAudioId(id); setPendingAudioId(id); onSelectAudioTrack?.(track); if (selected) { setPendingAudioId(null); onClose(); } }} className={rowClass(column === 'audio' && audioId === id, selected)} aria-pressed={selected}>
                <span data-track-content=""><span data-track-title="">{trackLabel(track.name, track.lang)}</span></span>
                {selected && <span data-track-check="" className="w-6 h-6 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center"><Check className="w-4 h-4 stroke-[3]" /></span>}
              </button>; })}
            </div>
          </section>
          <section data-track-column="" className={panel}><h3 className="text-sm font-black text-cyan-300 uppercase tracking-wider flex items-center justify-center gap-1.5 text-center"><Subtitles className="w-4 h-4" />CC / FELIRAT</h3>
            <div data-track-list="" className="overflow-y-auto min-h-0 space-y-1.5">
              {subtitleTracks.length === 0 && <p className="rounded-xl border border-slate-700 bg-[#0a152d] p-3 text-xs text-slate-400">Nincs jelzett választható felirat.</p>}
              {subtitleItems.map((track) => { const id = String(track?.id ?? 'off'); const selected = track ? track.selected === true : !subtitleTracks.some((item) => item.selected === true); return <button key={id} data-track-option="" data-track-focused={column === 'subtitle' && subtitleId === id ? '1' : undefined} onClick={() => {
                setColumn('subtitle'); setSubtitleId(id);
                if (!track) { onSelectSubtitleTrack?.(null); setPendingSubtitleId(null); onClose(); return; }
                setPendingSubtitleId(id); onSelectSubtitleTrack?.(track); if (selected) { setPendingSubtitleId(null); onClose(); }
              }} className={rowClass(column === 'subtitle' && subtitleId === id, selected)} aria-pressed={selected}>
                <span data-track-content=""><span data-track-title="">{track ? trackLabel(track.name, track.lang, 'Felirat') : 'Felirat kikapcsolva'}</span></span>
                {selected && <span data-track-check="" className="w-6 h-6 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center"><Check className="w-4 h-4 stroke-[3]" /></span>}
              </button>; })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

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
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [pendingAudioTrackId, setPendingAudioTrackId] = React.useState<string | null>(null);
  const [pendingSubtitleTrackId, setPendingSubtitleTrackId] = React.useState<string | null>(null);
  const [focusedAudioTrackId, setFocusedAudioTrackId] = React.useState<string | null>(null);

  // Megnyitáskor a sárga fókusz mindig az aktív hangsávra kerül; ha nincs
  // aktív jelölés, az első elérhető sávra ugrik.
  React.useEffect(() => {
    if (!isOpen || mode !== 'audio') return;
    const activeTrack = audioTracks.find((track) => track.selected === true);
    setFocusedAudioTrackId(String(activeTrack?.id ?? audioTracks[0]?.id ?? ''));
  }, [isOpen, mode, audioTracks]);

  // TV távirányító: fel/le navigáció, OK választás, Vissza bezárás.
  // Capture fázisban kezeljük, hogy az App globális gombkezelője ne nyelje el.
  React.useEffect(() => {
    if (!isOpen || mode !== 'audio') return;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = normalizeTvKey(event);
      if (key === 'Escape' || key === 'Backspace' || key === 'GoBack' || key === 'BrowserBack') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        if (audioTracks.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = audioTracks.findIndex((track) => String(track.id) === focusedAudioTrackId);
        const nextIndex = key === 'ArrowDown'
          ? Math.min(audioTracks.length - 1, Math.max(0, currentIndex) + 1)
          : Math.max(0, (currentIndex < 0 ? 0 : currentIndex) - 1);
        setFocusedAudioTrackId(String(audioTracks[nextIndex].id));
        return;
      }
      if (key === 'Enter' || key === ' ') {
        if (!focusedAudioTrackId) return;
        const focusedTrack = audioTracks.find((track) => String(track.id) === focusedAudioTrackId);
        if (!focusedTrack) return;
        event.preventDefault();
        event.stopPropagation();
        setPendingAudioTrackId(String(focusedTrack.id));
        onSelectAudioTrack?.(focusedTrack);
        if (focusedTrack.selected === true) {
          setPendingAudioTrackId(null);
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, mode, audioTracks, focusedAudioTrackId, onClose, onSelectAudioTrack]);

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

  React.useLayoutEffect(() => {
    if (isOpen && mode === 'audio') revealFocusedTrack(panelRef.current);
  }, [isOpen, mode, focusedAudioTrackId, audioTracks]);

  if (!isOpen) return null;
  if (mode === 'live') return <LiveAudioCcSelector isOpen={isOpen} onClose={onClose} audioTracks={audioTracks} onSelectAudioTrack={onSelectAudioTrack} subtitleTracks={subtitleTracks} onSelectSubtitleTrack={onSelectSubtitleTrack} />;

  // Csak a lejátszó által ténylegesen felismert sávokat mutatjuk.
  // A korábbi „Magyar/Angol/Automatikus” tartaléklista csak a preferenciát
  // mentette, a stream hangsávját nem tudta megváltoztatni.
  const orderedAudioOptions = audioTracks.map((track) => ({
    id: String(track.id),
    name: trackLabel(track.name, track.lang),
    track,
  }));
  const availableTracks = subtitleTracks;
  const subtitleOptions: Array<{ id: string; name: string; track?: SubtitleTrack }> = [
    ...availableTracks.map((track) => ({
      id: String(track.id),
      name: trackLabel(track.name, track.lang, 'Felirat'),
      track,
    })),
    { id: 'Kikapcsolva', name: 'Felirat kikapcsolva' },
  ];
  const subtitleSizes: SubtitleSize[] = ['75%', '100%', '125%', '150%', '200%'];

  return (
    /*
     * A TELJES KÉPERNYŐS LEJÁTSZÓ z-indexe 2147483000 (a webOS TV CSS-e is
     * odateszi), ezért a korábbi z-[10000] ablak a kép MÖGÖTT nyílt meg –
     * teljes képernyőn a ZÖLD gombra „nem történt semmi”. Az ablak most a
     * legfelső rétegre kerül (az OSD 2147483001 felett).
     */
    <div className="fixed inset-0 z-[2147483010] flex items-center justify-center p-3 md:p-4 lg:p-6 bg-black/80 backdrop-blur-sm animate-fadeIn select-none lg:select-auto pointer-events-auto">
      <div ref={panelRef} data-track-panel="single" role="dialog" aria-modal="true" className="bg-[#081329] border-2 border-cyan-500/60 rounded-xl max-w-md md:max-w-lg lg:max-w-xl xl:max-w-2xl w-full max-h-[85vh] lg:max-h-[80vh] flex flex-col shadow-2xl animate-scaleUp overflow-hidden">
        <div className="p-4 bg-[#0a1835] border-b border-cyan-950 flex items-center justify-center text-center">
          <div className="flex items-center gap-2">
            {mode === 'subtitle'
              ? <Subtitles className="w-5 h-5 text-cyan-300 stroke-[2.5]" />
              : <Mic2 className="w-5 h-5 text-rose-400 stroke-[2.5]" />}
            <h2 className="text-base sm:text-lg font-black text-white tracking-wide">{mode === 'subtitle' ? 'FELIRAT' : 'HANGSÁV'}</h2>
          </div>
        </div>

        <div data-track-list="" className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {mode === 'audio' ? (
            <div className="space-y-2">
              <h3 className="text-sm font-black text-rose-400 uppercase tracking-wider flex items-center justify-center gap-1.5 text-center">
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
                      data-track-option=""
                      data-track-focused={focusedAudioTrackId === opt.id ? '1' : undefined}
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
                        focusedAudioTrackId === opt.id
                          ? 'bg-[#0f244a] border-yellow-400 text-white shadow-md ring-2 ring-yellow-400/80'
                          : isSelected
                            ? 'bg-[#0f244a] border-cyan-400 text-white shadow-md ring-1 ring-cyan-400/40'
                            : 'bg-[#0a152d] border-slate-800 text-slate-300 hover:bg-[#102042]'
                      }`}
                    >
                      <span data-track-content="">
                        <span data-track-title="">{opt.name}</span>
                      </span>
                      {isSelected && <span data-track-check="" className="w-6 h-6 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center"><Check className="w-4 h-4 stroke-[3]" /></span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
          <>
          <div className="space-y-2">
            <h3 className="text-sm font-black text-cyan-300 uppercase tracking-wider flex items-center justify-center gap-1.5 text-center">
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
                    data-track-option=""
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
                    <span data-track-content=""><span data-track-title="">{opt.name}</span></span>
                    {isSelected && <span data-track-check="" className="w-6 h-6 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center"><Check className="w-4 h-4 stroke-[3]" /></span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="pt-3 border-t border-cyan-950 space-y-2">
            <h3 className="text-sm font-black text-cyan-300 uppercase tracking-wider text-center">Felirat mérete</h3>
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
