import React from 'react';
import { AudioTrack, SubtitleTrack, AppSettings, SubtitleSize } from '../types/iptv';
import { Subtitles, Mic2, Check, Save, CircleCheck } from 'lucide-react';
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
  /**
   * ÉLŐ TV: a kijelölt hangsáv mentése az AKTUÁLIS csatornához.
   *
   * Csak akkor kap értéket, ha a hívó ismeri a most futó csatornát (élő TV).
   * Ha meg van adva, az ablak fejlécében megjelenik a MENTÉS gomb; enélkül
   * (film/sorozat választó) az ablak változatlan marad.
   */
  onSaveAudioTrack?: (track: AudioTrack) => boolean | void;
  /**
   * Az adáson LEGUTÓBB kiválasztott hangsáv azonosítója.
   *
   * A TV nem minden esetben jelöli meg a listában, melyik sáv fut, ezért az
   * App megjegyzi a felhasználó választását: az ablak ezzel a sávval nyílik
   * (a mentés célpontja is ez lesz), nem az első sorral.
   */
  activeAudioTrackId?: string;
}

type LiveAudioCcSelectorProps = Pick<AudioSubtitlesModalProps,
  'isOpen' | 'onClose' | 'audioTracks' | 'onSelectAudioTrack' | 'subtitleTracks' | 'onSelectSubtitleTrack'
  | 'onSaveAudioTrack' | 'activeAudioTrackId'
> & { preferOffWhenUnselected?: boolean };

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
export const LiveAudioCcSelector: React.FC<LiveAudioCcSelectorProps> = ({
  isOpen, onClose, audioTracks = [], onSelectAudioTrack, subtitleTracks = [], onSelectSubtitleTrack, preferOffWhenUnselected = false,
  onSaveAudioTrack, activeAudioTrackId,
}) => {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [column, setColumn] = React.useState<'audio' | 'subtitle'>('audio');
  const [audioId, setAudioId] = React.useState<string>('');
  const [subtitleId, setSubtitleId] = React.useState<string>('');
  const [pendingAudioId, setPendingAudioId] = React.useState<string | null>(null);
  const [pendingSubtitleId, setPendingSubtitleId] = React.useState<string | null>(null);
  /*
   * MENTÉS gomb: csak élő TV-n, csak akkor jelenik meg, ha a hívó tudja,
   * melyik csatornához kell menteni. A távirányítóval a hangsáv-lista
   * legtetejéről FEL nyíllal érhető el, ENTER pedig menti a kiválasztott sávot.
   *
   * FONTOS (2.5.377): a MENTÉS NEM a kurzor sorát menti, hanem azt a sávot,
   * amelyen a néző megállt. A fejlécig felnyilazva ugyanis a kurzor
   * óhatatlanul átfut a felső sorokon – korábban ezért mentődött mindig az
   * 1. (alap) hangsáv, akármelyik sávot választotta a néző.
   */
  const [focusZone, setFocusZone] = React.useState<'list' | 'save'>('list');
  const [saveState, setSaveState] = React.useState<'idle' | 'saved' | 'error'>('idle');
  /** A MENTÉS célpontja: az a hangsáv, amelyen a néző megállt („elidőzött”). */
  const [saveTargetId, setSaveTargetId] = React.useState<string>('');
  /**
   * A felfelé navigálás kezdete (2.5.377).
   *
   * A néző levisz a kurzort a kívánt sávra, majd FEL nyíllal felmegy a
   * fejléc MENTÉS gombjára. Eközben a kurzor átfut a felső sorokon – a
   * mentés célpontja viszont az marad, ahonnan a felfelé lépkedés indult.
   */
  const upRunRef = React.useRef<{ startId: string; lastAt: number } | null>(null);
  const canSaveAudio = typeof onSaveAudioTrack === 'function';
  const subtitleItems = React.useMemo<Array<SubtitleTrack | null>>(() => [...subtitleTracks, null], [subtitleTracks]);

  /**
   * A megnyitáskor kijelölendő hangsáv: az App által megjegyzett utolsó
   * választás, különben a TV által aktívnak jelölt sáv, különben az első.
   * (A TV nem minden adásnál jelöli meg, melyik sáv fut.)
   */
  const preferredAudioId = React.useCallback((): string => {
    if (activeAudioTrackId && audioTracks.some((track) => String(track.id) === String(activeAudioTrackId))) {
      return String(activeAudioTrackId);
    }
    return String(audioTracks.find((track) => track.selected)?.id ?? audioTracks[0]?.id ?? '');
  }, [activeAudioTrackId, audioTracks]);

  /** A kiválasztott (mentendő) sáv: a megállt sor, különben az aktív sáv. */
  const resolveSaveTarget = React.useCallback((): AudioTrack | null => {
    return audioTracks.find((item) => String(item.id) === saveTargetId)
      || audioTracks.find((item) => item.selected)
      || audioTracks[0]
      || null;
  }, [audioTracks, saveTargetId]);

  const saveTargetTrack = React.useMemo(() => resolveSaveTarget(), [resolveSaveTarget]);

  const saveCurrentAudio = React.useCallback(() => {
    if (!canSaveAudio) return;
    const track = resolveSaveTarget();
    if (!track) { setSaveState('error'); return; }
    let result: boolean | void = undefined;
    try {
      result = onSaveAudioTrack?.(track);
    } catch {
      result = false;
    }
    setSaveState(result === false ? 'error' : 'saved');
  }, [canSaveAudio, resolveSaveTarget, onSaveAudioTrack]);

  React.useEffect(() => {
    if (!isOpen) {
      setPendingAudioId(null);
      setPendingSubtitleId(null);
      return;
    }
    const initialAudioId = preferredAudioId();
    setAudioId(initialAudioId);
    setSaveTargetId(initialAudioId);
    setSubtitleId(String(subtitleTracks.find((track) => track.selected)?.id ?? (!preferOffWhenUnselected && subtitleTracks.length ? subtitleTracks[0].id : 'off')));
    setColumn('audio');
    setFocusZone('list');
    setSaveState('idle');
    upRunRef.current = null;
  // A listák gyakran új tömbként érkeznek újrarendereléskor. Ne állítsuk
  // ilyenkor vissza a távirányító kijelölését az első sávra.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen) return;
    if (audioId && audioTracks.some((track) => String(track.id) === audioId)) return;
    if (audioTracks.length) setAudioId(preferredAudioId());
  }, [isOpen, audioId, audioTracks, preferredAudioId]);

  /*
   * A MENTÉS célpontja akkor vált, amikor a néző MEGÁLL egy hangsávon
   * (kb. 0,7 mp). A fejlécig felnyilazás közben a kurzor átfut a felső
   * sorokon, a célpont viszont azon a sávon marad, amelyet kiválasztott –
   * ezért menti a MENTÉS a 3. hangsávot is, nem az 1. (alap) sávot.
   */
  React.useEffect(() => {
    if (!isOpen || focusZone !== 'list' || column !== 'audio' || !audioId) return;
    const timer = window.setTimeout(() => setSaveTargetId(audioId), 700);
    return () => window.clearTimeout(timer);
  }, [isOpen, focusZone, column, audioId]);

  // Új célpont (másik hangsáv) után a gomb ismét MENTÉS-t mutat, nem MENTVE-t.
  React.useEffect(() => {
    setSaveState('idle');
  }, [saveTargetId]);

  // Ha a sávlista közben megváltozik, a célpont ne mutasson nem létező sávra.
  React.useEffect(() => {
    if (!isOpen) return;
    if (saveTargetId && audioTracks.some((track) => String(track.id) === saveTargetId)) return;
    setSaveTargetId(preferredAudioId());
  }, [isOpen, saveTargetId, audioTracks, preferredAudioId]);

  React.useEffect(() => {
    if (!isOpen) return;
    if (subtitleItems.some((track) => String(track?.id ?? 'off') === subtitleId)) return;
    setSubtitleId(String(subtitleTracks.find((track) => track.selected)?.id ?? (!preferOffWhenUnselected && subtitleTracks.length ? subtitleTracks[0].id : 'off')));
  }, [isOpen, subtitleId, subtitleItems, subtitleTracks, preferOffWhenUnselected]);

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
      if (focusZone === 'save') {
        // A MENTÉS gomb fókuszáról LE/OLDALRA visszatérünk a hangsáv-listára.
        if (key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
          event.preventDefault(); event.stopPropagation(); upRunRef.current = null; setFocusZone('list'); return;
        }
        if (key === 'Enter' || key === ' ') {
          event.preventDefault(); event.stopPropagation(); saveCurrentAudio(); return;
        }
        return;
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        event.preventDefault(); event.stopPropagation(); setColumn(key === 'ArrowLeft' ? 'audio' : 'subtitle'); return;
      }
      if (key === 'ArrowUp' && canSaveAudio && column === 'audio') {
        // A hangsáv-lista legtetejéről FEL nyíllal a fejléc MENTÉS gombjára lépünk.
        const currentIndex = audioTracks.findIndex((track) => String(track.id) === audioId);
        if (currentIndex <= 0) {
          event.preventDefault(); event.stopPropagation();
          // A felfelé lépkedés kiinduló sávja a mentés célpontja (pl. a 3. sáv).
          const run = upRunRef.current;
          if (run && Date.now() - run.lastAt <= 1500 && audioTracks.some((track) => String(track.id) === run.startId)) {
            setSaveTargetId(run.startId);
          }
          setFocusZone('save');
          return;
        }
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        const listLength = column === 'audio' ? audioTracks.length : subtitleItems.length;
        if (!listLength) return;
        event.preventDefault(); event.stopPropagation();
        if (column === 'audio') {
          const index = audioTracks.findIndex((track) => String(track.id) === audioId);
          const next = key === 'ArrowDown' ? Math.min(audioTracks.length - 1, Math.max(0, index) + 1) : Math.max(0, (index < 0 ? 0 : index) - 1);
          if (key === 'ArrowUp') {
            // Felfelé lépkedés: az első lépés sávja a „honnan indultunk”.
            const run = upRunRef.current;
            if (!run || Date.now() - run.lastAt > 1500) {
              upRunRef.current = { startId: String(audioTracks[Math.max(0, index)]?.id ?? audioId), lastAt: Date.now() };
            } else {
              run.lastAt = Date.now();
            }
          } else {
            upRunRef.current = null;
          }
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
          setSaveTargetId(String(track.id));
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
  }, [isOpen, column, audioTracks, subtitleItems, audioId, subtitleId, onClose, onSelectAudioTrack, onSelectSubtitleTrack,
    focusZone, canSaveAudio, saveCurrentAudio]);

  React.useLayoutEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    if (focusZone === 'save') {
      // A MENTÉS gomb kapja a fókuszt – a távirányító OK gombja így ment.
      panel?.querySelector<HTMLButtonElement>('[data-save-audio]')?.focus({ preventScroll: true });
      return;
    }
    revealFocusedTrack(panel);
    const focused = panel?.querySelector<HTMLButtonElement>('[data-track-focused="1"]');
    focused?.focus({ preventScroll: true });
  }, [isOpen, column, audioId, subtitleId, audioTracks, subtitleTracks, focusZone]);

  if (!isOpen) return null;
  const panel = 'min-w-0 min-h-0 rounded-xl border border-slate-700/70 bg-[#09152c] p-3 flex flex-col gap-2';
  const rowClass = (focused: boolean, selected: boolean) => `p-3 w-full rounded-xl flex items-center gap-3 text-center border transition-all ${focused ? 'bg-[#0f244a] border-yellow-400 text-white shadow-md ring-2 ring-yellow-400/80' : selected ? 'bg-[#0f244a] border-cyan-400 text-white shadow-md ring-1 ring-cyan-400/40' : 'bg-[#0a152d] border-slate-800 text-slate-300'}`;
  return (
    <div className="fixed inset-0 z-[2147483010] flex items-center justify-center p-3 md:p-4 bg-black/80 backdrop-blur-sm animate-fadeIn select-none pointer-events-auto">
      <div ref={panelRef} data-track-panel="live" role="dialog" aria-modal="true" aria-label="Hangsáv és CC választás" className="bg-[#081329] border-2 border-cyan-500/60 rounded-xl w-full max-w-5xl max-h-[85vh] flex flex-col shadow-2xl animate-scaleUp overflow-hidden">
        <div className="relative p-4 bg-[#0a1835] border-b border-cyan-950 flex items-center justify-center text-center">
          <div className="flex items-center gap-2"><Mic2 className="w-5 h-5 text-rose-400 stroke-[2.5]" /><Subtitles className="w-5 h-5 text-cyan-300 stroke-[2.5]" /><h2 className="text-base sm:text-lg font-black text-white tracking-wide">HANGSÁV / CC</h2></div>
          {/* MENTÉS: a kijelölt hangsáv eltárolása ehhez a csatornához (csak élő TV-n). */}
          {canSaveAudio && (
            <button
              type="button"
              data-save-audio=""
              data-save-state={saveState}
              data-focused={focusZone === 'save' ? '1' : undefined}
              aria-label="A kijelölt hangsáv mentése ehhez a csatornához"
              onClick={() => { setFocusZone('save'); saveCurrentAudio(); }}
              onMouseEnter={() => setFocusZone('save')}
              className={`absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs sm:text-sm font-black tracking-wide transition-all ${focusZone === 'save' ? 'bg-[#0f244a] border-yellow-400 text-white shadow-md ring-2 ring-yellow-400/80' : saveState === 'saved' ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200' : saveState === 'error' ? 'bg-rose-500/20 border-rose-400 text-rose-200' : 'bg-[#0e1d3b] border-cyan-500/70 text-cyan-100'}`}
            >
              {saveState === 'saved'
                ? <CircleCheck className="w-4 h-4 stroke-[2.5]" />
                : <Save className="w-4 h-4 stroke-[2.5]" />}
              <span>{saveState === 'saved' ? 'MENTVE' : saveState === 'error' ? 'NINCS SÁV' : 'MENTÉS'}</span>
              {saveTargetTrack && (
                <span data-save-target-label="" className="max-w-[10rem] truncate text-[10px] font-bold text-cyan-300/80">
                  {trackLabel(saveTargetTrack.name, saveTargetTrack.lang)}
                </span>
              )}
            </button>
          )}
        </div>
        <div data-track-columns="" className="grid grid-cols-2 gap-3 p-3 md:p-4 overflow-hidden min-h-0">
          <section data-track-column="" className={panel}><h3 className="text-sm font-black text-rose-400 uppercase tracking-wider flex items-center justify-center gap-1.5 text-center"><Mic2 className="w-4 h-4" />HANGSÁV</h3>
            <div data-track-list="" className="overflow-y-auto min-h-0 space-y-1.5">
              {audioTracks.length === 0 && <p className="rounded-xl border border-slate-700 bg-[#0a152d] p-3 text-xs text-slate-400">Nincs jelzett választható hangsáv.</p>}
              {audioTracks.map((track) => { const id = String(track.id); const selected = track.selected === true; return <button key={id} data-track-option="" data-track-focused={column === 'audio' && audioId === id ? '1' : undefined} onClick={() => { setFocusZone('list'); setColumn('audio'); setAudioId(id); setSaveTargetId(id); setPendingAudioId(id); onSelectAudioTrack?.(track); if (selected) { setPendingAudioId(null); onClose(); } }} data-save-target={saveTargetId === id ? '1' : undefined} className={`${rowClass(column === 'audio' && audioId === id, selected)}${saveTargetId === id && focusZone === 'save' ? ' ring-2 ring-emerald-400/80' : ''}`} aria-pressed={selected}>
                <span data-track-content="" className="min-w-0 flex-1 text-center break-words"><span data-track-title="">{trackLabel(track.name, track.lang)}</span></span>
                {selected && <span data-track-check="" className="w-6 h-6 shrink-0 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center"><Check className="w-4 h-4 stroke-[3]" /></span>}
              </button>; })}
            </div>
          </section>
          <section data-track-column="" className={panel}><h3 className="text-sm font-black text-cyan-300 uppercase tracking-wider flex items-center justify-center gap-1.5 text-center"><Subtitles className="w-4 h-4" />CC / FELIRAT</h3>
            <div data-track-list="" className="overflow-y-auto min-h-0 space-y-1.5">
              {subtitleTracks.length === 0 && <p className="rounded-xl border border-slate-700 bg-[#0a152d] p-3 text-xs text-slate-400">Nincs jelzett választható felirat.</p>}
              {subtitleItems.map((track) => { const id = String(track?.id ?? 'off'); const selected = track ? track.selected === true : !subtitleTracks.some((item) => item.selected === true); return <button key={id} data-track-option="" data-track-focused={column === 'subtitle' && subtitleId === id ? '1' : undefined} onClick={() => {
                setFocusZone('list'); setColumn('subtitle'); setSubtitleId(id);
                if (!track) { onSelectSubtitleTrack?.(null); setPendingSubtitleId(null); onClose(); return; }
                setPendingSubtitleId(id); onSelectSubtitleTrack?.(track); if (selected) { setPendingSubtitleId(null); onClose(); }
              }} className={rowClass(column === 'subtitle' && subtitleId === id, selected)} aria-pressed={selected}>
                <span data-track-content="" className="min-w-0 flex-1 text-center break-words"><span data-track-title="">{track ? trackLabel(track.name, track.lang, 'Felirat') : 'Felirat kikapcsolva'}</span></span>
                {selected && <span data-track-check="" className="w-6 h-6 shrink-0 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center"><Check className="w-4 h-4 stroke-[3]" /></span>}
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
  onSaveAudioTrack,
  activeAudioTrackId,
}) => {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [pendingAudioTrackId, setPendingAudioTrackId] = React.useState<string | null>(null);
  const [pendingSubtitleTrackId, setPendingSubtitleTrackId] = React.useState<string | null>(null);
  const [focusedAudioTrackId, setFocusedAudioTrackId] = React.useState<string | null>(null);
  const [focusedSubtitleTrackId, setFocusedSubtitleTrackId] = React.useState<string>('Kikapcsolva');

  // Megnyitáskor a sárga fókusz mindig az aktív hangsávra kerül; ha nincs
  // aktív jelölés, az első elérhető sávra ugrik.
  React.useEffect(() => {
    if (!isOpen || mode !== 'audio') return;
    const activeTrack = audioTracks.find((track) => track.selected === true);
    setFocusedAudioTrackId(String(activeTrack?.id ?? audioTracks[0]?.id ?? ''));
  }, [isOpen, mode, audioTracks]);

  // A CC-lista ugyanúgy kapjon kezdeti fókuszt, mint a hangsávlista.
  React.useEffect(() => {
    if (!isOpen || mode !== 'subtitle') return;
    const activeTrack = subtitleTracks.find((track) => track.selected === true);
    const preferred = (settings.preferredSubtitle || '').toLowerCase();
    const preferredTrack = subtitleTracks.find((track) =>
      preferred && [String(track.id), track.lang, track.name].some((value) => String(value || '').toLowerCase() === preferred)
    );
    setFocusedSubtitleTrackId(String(activeTrack?.id ?? preferredTrack?.id ?? subtitleTracks[0]?.id ?? 'Kikapcsolva'));
  }, [isOpen, mode, subtitleTracks, settings.preferredSubtitle]);

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

  // CC: a fókusz és az OK-választás távirányítóval is működjön, ne csak kattintással.
  React.useEffect(() => {
    if (!isOpen || mode !== 'subtitle') return;
    const ids = [...subtitleTracks.map((track) => String(track.id)), 'Kikapcsolva'];
    const onKeyDown = (event: KeyboardEvent) => {
      const key = normalizeTvKey(event);
      if (key === 'Escape' || key === 'Backspace' || key === 'GoBack' || key === 'BrowserBack') {
        event.preventDefault(); event.stopPropagation(); onClose(); return;
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        event.preventDefault(); event.stopPropagation();
        const current = Math.max(0, ids.indexOf(focusedSubtitleTrackId));
        const next = key === 'ArrowDown' ? Math.min(ids.length - 1, current + 1) : Math.max(0, current - 1);
        setFocusedSubtitleTrackId(ids[next]);
        return;
      }
      if (key === 'Enter' || key === ' ') {
        event.preventDefault(); event.stopPropagation();
        if (focusedSubtitleTrackId === 'Kikapcsolva') {
          if (subtitleTracks.length > 0) onSelectSubtitleTrack?.(null);
          setPendingSubtitleTrackId(null);
          onUpdateSettings({ preferredSubtitle: 'Kikapcsolva' });
          onClose();
          return;
        }
        const track = subtitleTracks.find((item) => String(item.id) === focusedSubtitleTrackId);
        if (!track) return;
        setPendingSubtitleTrackId(String(track.id));
        onSelectSubtitleTrack?.(track);
        onUpdateSettings({ preferredSubtitle: track.lang || track.name || String(track.id) });
        if (track.selected === true) { setPendingSubtitleTrackId(null); onClose(); }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, mode, subtitleTracks, focusedSubtitleTrackId, onClose, onSelectSubtitleTrack, onUpdateSettings]);

  React.useLayoutEffect(() => {
    if (!isOpen || mode !== 'subtitle') return;
    const panel = panelRef.current;
    revealFocusedTrack(panel);
    panel?.querySelector<HTMLButtonElement>('[data-track-focused="1"]')?.focus({ preventScroll: true });
  }, [isOpen, mode, focusedSubtitleTrackId, subtitleTracks]);

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
    if (!isOpen || mode !== 'audio') return;
    const panel = panelRef.current;
    revealFocusedTrack(panel);
    const focused = panel?.querySelector<HTMLButtonElement>('[data-track-focused="1"]');
    focused?.focus({ preventScroll: true });
  }, [isOpen, mode, focusedAudioTrackId, audioTracks]);

  if (!isOpen) return null;
  if (mode === 'live') return <LiveAudioCcSelector isOpen={isOpen} onClose={onClose} audioTracks={audioTracks} onSelectAudioTrack={onSelectAudioTrack} subtitleTracks={subtitleTracks} onSelectSubtitleTrack={onSelectSubtitleTrack} onSaveAudioTrack={onSaveAudioTrack} activeAudioTrackId={activeAudioTrackId} />;

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
                      className={`p-3 w-full rounded-2xl flex items-center gap-3 cursor-pointer border transition-all ${
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
                      {isSelected && <span data-track-check="" className="w-6 h-6 shrink-0 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center"><Check className="w-4 h-4 stroke-[3]" /></span>}
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
                    data-track-focused={focusedSubtitleTrackId === opt.id ? '1' : undefined}
                    aria-pressed={isSelected}
                    onFocus={() => setFocusedSubtitleTrackId(opt.id)}
                    onClick={() => {
                      setFocusedSubtitleTrackId(opt.id);
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
                    className={`p-3 w-full rounded-2xl flex items-center gap-3 cursor-pointer border transition-all ${
                      focusedSubtitleTrackId === opt.id
                        ? 'bg-[#0f244a] border-yellow-400 text-white shadow-md ring-2 ring-yellow-400/80'
                        : isSelected
                          ? 'bg-[#0f244a] border-cyan-400 text-white shadow-md ring-1 ring-cyan-400/40'
                          : 'bg-[#0a152d] border-slate-800 text-slate-300 hover:bg-[#102042]'
                    }`}
                  >
                    <span data-track-content="" className="min-w-0 flex-1 text-left break-words"><span data-track-title="">{opt.name}</span></span>
                    {isSelected && <span data-track-check="" className="w-6 h-6 shrink-0 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center"><Check className="w-4 h-4 stroke-[3]" /></span>}
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
