import React, { useEffect, useRef } from 'react';
import { AudioTrack, SubtitleTrack } from '../types/iptv';
import {
  ArrowLeft, Check, FastForward, Mic2, Pause, Play,
  Rewind, Subtitles, Volume2, VolumeX, X,
} from 'lucide-react';
import { normalizeTvKey } from '../utils/tvKeys';
import { trackLabel } from '../utils/trackLabels';

/**
 * FILM / SOROZAT OSD – a referencia (sharktie/lg-iptv) VOD-lejátszó OSD-jének
 * felépítését követi, de PIROS helyett KÉK kiemeléssel:
 *
 *   • fent: vissza-nyíl + a film CÍME (ez az OSD része, tehát az OSD-vel
 *     együtt tűnik el – nem külön, állandó felirat a sarokban);
 *   • lent: idővonal (aktuális / teljes idő, húzható sáv) és egy sor kerek
 *     vezérlő: tekerés, LEJÁTSZÁS (nagy, kék), tekerés, hangsáv, felirat,
 *     hangerő, végül a PIROS ✕, ami visszalép oda, ahonnan a filmet indítottuk.
 *
 * A „sebesség” gomb helyén tehát a piros ✕ áll (kérés szerint). A hangsáv és a
 * felirat gomb ZÖLDRE vált, ha több választható sáv van – így a távirányítós
 * nézetből is látszik, hogy érdemes megnyitni őket.
 *
 * A sáv a távirányítóval is vezérelhető: a fókusz rákerül, majd BALRA/JOBBRA
 * a beállított tekerési lépéssel (5/10/15/30 mp) mozdítja a lejátszást – ez a
 * a Magic Remote mutatójával is kiválasztható egy pozíció.
 */

interface VodOsdProps {
  title: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  /** Tekerési lépés másodpercben (Beállítások → Mozi & Sorozat). */
  seekStep: number;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  activeSubtitleId: string | number | null;
  /** Nyitott sávválasztó: 'audio' | 'subtitle' | null (a szülő kezeli az OSD-t). */
  menu: 'audio' | 'subtitle' | null;
  onMenuChange: (menu: 'audio' | 'subtitle' | null) => void;
  onTogglePlay: () => void;
  onSeekBy: (direction: -1 | 1) => void;
  onSeekTo: (seconds: number) => void;
  onSelectAudio: (track: AudioTrack) => void;
  onSelectSubtitle: (track: SubtitleTrack | null) => void;
  onClose: () => void;
  onToggleMute: () => void;
  /** Bármilyen felhasználói művelet – ilyenkor az OSD eltűnési időzítője újraindul. */
  onActivity?: () => void;
  /** A hívó (VideoPlayer) ezen keresztül éri el az OSD gyökerét (fókusz, mérés). */
  rootRef?: React.RefObject<HTMLDivElement | null>;
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/*
 * Kerek OSD-gombok. A színt SZÁNDÉKOSAN nem `!important`-tal írjuk felül
 * (a Tailwind 4-ben az a régi, v3-as jelölés), hanem állapotonként adjuk meg –
 * így a ZÖLD (több sáv) és a PIROS (némítás) állapot is biztosan érvényesül.
 */
const ROUND_BUTTON_BASE =
  'shrink-0 rounded-full border flex items-center justify-center transition-all duration-150 ' +
  'focus:outline-none focus:ring-[3px] focus:scale-105 active:scale-95 cursor-pointer';
const ROUND_BUTTON_IDLE =
  'border-white/20 bg-white/10 text-white hover:bg-white/20 ' +
  'focus:bg-blue-600/40 focus:border-blue-400 focus:ring-blue-500/50';
const ROUND_BUTTON_GREEN =
  'border-emerald-400 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 ' +
  'focus:bg-emerald-500/35 focus:border-emerald-300 focus:ring-emerald-500/50';
const ROUND_BUTTON_RED =
  'border-red-500/60 bg-red-500/15 text-red-400 hover:bg-red-500/25 ' +
  'focus:bg-red-500/30 focus:border-red-400 focus:ring-red-500/50';

export const VodOsd: React.FC<VodOsdProps> = ({
  title,
  currentTime,
  duration,
  isPlaying,
  volume,
  seekStep,
  audioTracks,
  subtitleTracks,
  activeSubtitleId,
  menu,
  onMenuChange,
  onTogglePlay,
  onSeekBy,
  onSeekTo,
  onSelectAudio,
  onSelectSubtitle,
  onClose,
  onToggleMute,
  onActivity,
  rootRef,
}) => {
  const localRef = useRef<HTMLDivElement | null>(null);
  const osdRef = rootRef || localRef;
  /**
   * A HANGSÁV / FELIRAT választó doboza.
   *
   * A doboz a távirányítóval vezérelhető: nyíláskor az első (vagy a kiválasztott)
   * sor kapja a fókuszt, FEL/LE a sorok között lép, az OK azonnal vált és bezár.
   * A billentyűket egy CAPTURE fázisú figyelő veszi át, hogy a webOS saját
   * térbeli kijelölője ne léphessen ki a dobozból (korábban ezért „nem lehetett
   * kiválasztani és alkalmazni” a hangsávot a TV-n).
   */
  const menuRef = useRef<HTMLDivElement | null>(null);
  const seekRef = useRef<HTMLDivElement | null>(null);
  const hasAudioChoice = audioTracks.length > 1;
  const hasSubtitleChoice = subtitleTracks.length > 0;
  const hasDuration = Number.isFinite(duration) && duration > 0;
  const shownTime = currentTime;
  const progress = hasDuration ? Math.min(1, Math.max(0, shownTime / duration)) : 0;
  const isMuted = volume <= 0;

  // ── Távirányítós fókusz: balra/jobbra a soron belül, fel/le a sorok között ──
  const focusables = () => Array.from(
    osdRef.current?.querySelectorAll<HTMLElement>('[data-vod-focus]') || []
  ).filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null);

  const focusPlay = () => {
    osdRef.current?.querySelector<HTMLElement>('[data-vod-osd-play]')
      ?.focus({ preventScroll: true } as FocusOptions);
  };

  const moveFocus = (direction: 'left' | 'right' | 'up' | 'down') => {
    const list = focusables();
    if (list.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const currentIndex = active ? list.indexOf(active) : -1;
    if (currentIndex < 0) {
      focusPlay();
      return;
    }
    const current = list[currentIndex];
    const currentRect = current.getBoundingClientRect();
    const currentCenter = {
      x: currentRect.left + currentRect.width / 2,
      y: currentRect.top + currentRect.height / 2,
    };
    const candidates = list
      .filter((element) => element !== current)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element,
          dx: rect.left + rect.width / 2 - currentCenter.x,
          dy: rect.top + rect.height / 2 - currentCenter.y,
        };
      })
      .filter(({ dx, dy }) => {
        if (direction === 'left') return dx < -2 && Math.abs(dy) <= Math.max(28, currentRect.height / 2);
        if (direction === 'right') return dx > 2 && Math.abs(dy) <= Math.max(28, currentRect.height / 2);
        if (direction === 'up') return dy < -2;
        return dy > 2;
      })
      .sort((a, b) => {
        if (direction === 'left' || direction === 'right') {
          return Math.abs(a.dx) - Math.abs(b.dx) || Math.abs(a.dy) - Math.abs(b.dy);
        }
        return Math.abs(a.dy) - Math.abs(b.dy) || Math.abs(a.dx) - Math.abs(b.dx);
      });
    candidates[0]?.element.focus({ preventScroll: true } as FocusOptions);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const key = normalizeTvKey(event);
    // Nyitott sávválasztó mellett a nyilak a listában mozognak, nem az OSD-ben.
    if (menu) return;
    const active = document.activeElement as HTMLElement | null;
    const onSeek = Boolean(active && seekRef.current === active);

    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      onActivity?.();
      if (onSeek) {
        // A távirányítóval „húzott” idő: a beállított lépés (5/10/15/30 mp).
        onSeekBy(key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      moveFocus(key === 'ArrowLeft' ? 'left' : 'right');
      return;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      onActivity?.();
      moveFocus(key === 'ArrowUp' ? 'up' : 'down');
      return;
    }
    if (key === 'Enter' || key === ' ') {
      // A gombok saját (natív) aktiválása maradjon meg; csak a szülő
      // kezelőjétől vesszük el az eseményt.
      event.stopPropagation();
      onActivity?.();
      if (onSeek) {
        event.preventDefault();
        onTogglePlay();
      }
      return;
    }
    if (key === 'Escape' || key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      if (menu) onMenuChange(null);
      else onClose();
    }
  };

  // A Magic Remote egyetlen mutató-kijelöléssel pozícióra ugorhat.
  const seekFromPointer = (clientX: number) => {
    const track = seekRef.current;
    if (!track || !hasDuration) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    onSeekTo(ratio * duration);
  };

  /**
   * A választó doboz billentyűkezelése (CAPTURE).
   *
   * Csak akkor fut, ha a doboz nyitva van. A színes gombokat (403–406)
   * a webOS kezeli, a VISSZA gomb a dobozt zárja (nem a lejátszót).
   */
  useEffect(() => {
    if (!menu) return;
    const items = () => Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[data-vod-menu-item]') || []
    ).filter((element) => element.getClientRects().length > 0);

    // Nyitáskor a KIVÁLASZTOTT sor (vagy az első) kapja a fókuszt.
    window.requestAnimationFrame(() => {
      const list = items();
      const selected = list.find((element) => element.hasAttribute('data-vod-menu-selected'));
      (selected || list[0])?.focus({ preventScroll: false } as FocusOptions);
    });

    const step = (direction: 1 | -1) => {
      const list = items();
      if (list.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const index = active ? list.indexOf(active) : -1;
      const next = index < 0 ? 0 : (index + direction + list.length) % list.length;
      list[next]?.focus({ preventScroll: false } as FocusOptions);
    };

    const handler = (event: KeyboardEvent) => {
      const raw = Number((event as KeyboardEvent).keyCode || 0);
      // A színes gombok és a webOS saját gombjai maradjanak a webos.js-nek.
      if (raw === 403 || raw === 404 || raw === 405 || raw === 406) return;
      const key = normalizeTvKey(event);
      if (key === 'ArrowDown' || key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        onActivity?.();
        step(1);
        return;
      }
      if (key === 'ArrowUp' || key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        onActivity?.();
        step(-1);
        return;
      }
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        onActivity?.();
        const active = document.activeElement as HTMLElement | null;
        if (active && menuRef.current?.contains(active)) active.click();
        return;
      }
      if (key === 'Escape' || key === 'Backspace' || raw === 461) {
        event.preventDefault();
        event.stopPropagation();
        onMenuChange(null);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [menu, onMenuChange, onActivity]);

  const menuTitle = menu === 'audio' ? 'Hangsáv' : 'Felirat';

  return (
    <div
      ref={osdRef}
      data-vod-osd=""
      data-vod-osd-accent="blue"
      role="group"
      aria-label="Film vezérlők"
      onKeyDown={handleKeyDown}
      className="absolute inset-0 z-40 pointer-events-none text-white [&_button:focus]:outline-none [&_button:focus]:ring-[3px] [&_button:focus]:ring-blue-400/70"
    >
      {/* Sötétítő átmenetek – a referencia OSD-jének hangulata */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none bg-[linear-gradient(180deg,rgba(0,0,0,0.78)_0%,rgba(0,0,0,0)_22%),linear-gradient(0deg,rgba(0,0,0,0.88)_0%,rgba(0,0,0,0)_34%)]"
      />

      {/* ── FELSŐ SÁV: vissza + a film CÍME (az OSD része) ───────────────── */}
      <div className="relative pointer-events-auto flex items-center gap-[1.125rem] px-[1.5rem] pt-[1.25rem] md:px-[2.25rem] md:pt-[1.75rem]">
        <button
          type="button"
          data-vod-focus=""
          data-vod-osd-back=""
          onClick={() => { onActivity?.(); onClose(); }}
          className={`${ROUND_BUTTON_BASE} ${ROUND_BUTTON_IDLE} w-[2.875rem] h-[2.875rem]`}
          title="Vissza a filmválasztáshoz"
          aria-label="Vissza a filmválasztáshoz"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <span
          data-vod-osd-title=""
          className="min-w-0 truncate text-[1.15rem] md:text-[1.375rem] font-bold drop-shadow-[0_1px_8px_rgba(0,0,0,0.85)]"
          title={title}
        >
          {title || 'Film / Sorozat'}
        </span>
      </div>

      {/* ── ALSÓ SÁV: idővonal + vezérlők ─────────────────────────────────── */}
      <div className="absolute inset-x-0 bottom-0 pointer-events-auto px-[1.5rem] pb-[1.25rem] md:px-[2.25rem] md:pb-[2rem] flex flex-col gap-[0.75rem] md:gap-[0.875rem]">

        {/* Idővonal: aktuális idő – sáv – teljes idő */}
        <div className="flex items-center gap-[0.75rem] md:gap-[0.875rem]">
          <span className="min-w-[3rem] shrink-0 text-left md:text-right text-[0.9375rem] font-bold text-white/80 tabular-nums drop-shadow-[0_1px_4px_rgba(0,0,0,0.8)]">
            {formatTime(shownTime)}
          </span>

          <div
            ref={seekRef}
            data-vod-focus=""
            data-vod-osd-seek=""
            role="slider"
            tabIndex={0}
            aria-label={`Film idővonala – balra/jobbra ${seekStep} másodpercet teker`}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration) || 0}
            aria-valuenow={Math.round(shownTime)}
            aria-valuetext={`${formatTime(shownTime)} / ${formatTime(duration)}`}
            onClick={(event) => {
              event.stopPropagation();
              onActivity?.();
              seekFromPointer(event.clientX);
            }}
            onKeyDown={(event) => {
              // A nyilakat a szülő kezeli (sebességváltás a sávon), itt csak
              // a fókusz megtartásáról gondoskodunk.
              if (normalizeTvKey(event) === 'Enter') event.preventDefault();
            }}
            className="group relative flex-1 h-[0.75rem] flex items-center cursor-pointer focus:outline-none"
          >
            <div className="relative w-full rounded-full bg-white/25 transition-all h-[0.3125rem]">
              <div
                className="absolute left-0 top-0 bottom-0 rounded-full bg-blue-500"
                style={{ width: `${progress * 100}%` }}
              />
              <div
                className="absolute top-1/2 w-4 h-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_6px_rgba(0,0,0,0.6)] transition-transform scale-0 group-hover:scale-100 group-focus:scale-100"
                style={{ left: `${progress * 100}%` }}
              />
            </div>
            {/* fókuszjelzés a sávon */}
            <div className="pointer-events-none absolute inset-x-0 -inset-y-1 rounded-full ring-0 ring-blue-400/0 group-focus:ring-2 group-focus:ring-blue-400/70" />
          </div>

          <span className="min-w-[3rem] shrink-0 text-right text-[0.9375rem] font-bold text-white/80 tabular-nums drop-shadow-[0_1px_4px_rgba(0,0,0,0.8)]">
            {formatTime(duration)}
          </span>
        </div>

        {/* Vezérlők: tekerés, LEJÁTSZÁS, tekerés, hangsáv, felirat, hangerő, ✕ */}
        <div className="flex items-center justify-center gap-[0.7rem] md:gap-[1.25rem]">
          <button
            type="button"
            data-vod-focus=""
            data-vod-osd-rewind=""
            onClick={() => { onActivity?.(); onSeekBy(-1); }}
            className={`${ROUND_BUTTON_BASE} ${ROUND_BUTTON_IDLE} w-[2.85rem] h-[2.85rem] md:w-[3.25rem] md:h-[3.25rem]`}
            title={`Vissza ${seekStep} mp`}
            aria-label={`Vissza ${seekStep} másodpercet`}
          >
            <Rewind className="w-[22px] h-[22px]" />
          </button>

          <button
            type="button"
            data-vod-focus=""
            data-vod-osd-play=""
            onClick={() => { onActivity?.(); onTogglePlay(); }}
            className={`shrink-0 rounded-full flex items-center justify-center border-2 border-blue-400 bg-blue-600/80 text-white shadow-lg shadow-blue-900/40 transition-all hover:bg-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-500/60 active:scale-95 cursor-pointer w-[3.6rem] h-[3.6rem] md:w-[4rem] md:h-[4rem]`}
            title={isPlaying ? 'Szünet' : 'Lejátszás'}
            aria-label={isPlaying ? 'Szünet' : 'Lejátszás'}
          >
            {isPlaying
              ? <Pause className="w-6 h-6 md:w-7 md:h-7 fill-current" />
              : <Play className="w-6 h-6 md:w-7 md:h-7 fill-current ml-0.5" />}
          </button>

          <button
            type="button"
            data-vod-focus=""
            data-vod-osd-forward=""
            onClick={() => { onActivity?.(); onSeekBy(1); }}
            className={`${ROUND_BUTTON_BASE} ${ROUND_BUTTON_IDLE} w-[2.85rem] h-[2.85rem] md:w-[3.25rem] md:h-[3.25rem]`}
            title={`Előre ${seekStep} mp`}
            aria-label={`Előre ${seekStep} másodpercet`}
          >
            <FastForward className="w-[22px] h-[22px]" />
          </button>

          {/* HANGSÁV – zöld, ha több hangsáv közül lehet választani */}
          <button
            type="button"
            data-vod-focus=""
            data-vod-osd-audio=""
            data-vod-osd-audio-choice={hasAudioChoice ? '1' : undefined}
            onClick={() => {
              onActivity?.();
              /*
               * A doboz MINDIG kinyílik (a felhasználó kérése): a listában
               * akkor is látszik, hány hangsáv van, ha a TV csak egyet jelez.
               */
              onMenuChange(menu === 'audio' ? null : 'audio');
            }}
            className={`${ROUND_BUTTON_BASE} ${hasAudioChoice ? ROUND_BUTTON_GREEN : ROUND_BUTTON_IDLE} relative w-[2.85rem] h-[2.85rem] md:w-[3.25rem] md:h-[3.25rem] ${hasAudioChoice ? '' : 'opacity-80'}`}
            title={hasAudioChoice ? `${audioTracks.length} hangsáv – választás` : 'Nincs másik hangsáv'}
            aria-label="Hangsáv választása"
          >
            <Mic2 className="w-[22px] h-[22px]" />
            {hasAudioChoice && (
              <span className="absolute -top-1 -right-1 min-w-[1.05rem] h-[1.05rem] px-1 rounded-full bg-emerald-400 text-slate-950 text-[10px] font-black flex items-center justify-center">
                {audioTracks.length}
              </span>
            )}
          </button>

          {/* FELIRAT (CC) – zöld, ha van választható felirat */}
          <button
            type="button"
            data-vod-focus=""
            data-vod-osd-subs=""
            data-vod-osd-subs-choice={hasSubtitleChoice ? '1' : undefined}
            onClick={() => {
              onActivity?.();
              // A felirat-doboz is mindig kinyílik (OSD CC gomb).
              onMenuChange(menu === 'subtitle' ? null : 'subtitle');
            }}
            className={`${ROUND_BUTTON_BASE} ${hasSubtitleChoice ? ROUND_BUTTON_GREEN : ROUND_BUTTON_IDLE} relative w-[2.85rem] h-[2.85rem] md:w-[3.25rem] md:h-[3.25rem] ${hasSubtitleChoice ? '' : 'opacity-80'}`}
            title={hasSubtitleChoice ? `${subtitleTracks.length} felirat – választás` : 'Nincs felirat ehhez a filmhez'}
            aria-label="Felirat választása"
          >
            <Subtitles className="w-[22px] h-[22px]" />
            {activeSubtitleId !== null && activeSubtitleId !== undefined && (
              <span className="absolute -top-1 -right-1 w-[0.7rem] h-[0.7rem] rounded-full bg-emerald-400 shadow" aria-hidden="true" />
            )}
          </button>

          {/* Némítás megmarad; a külön hangerő-csúszka nem része az OSD-nek. */}
          <button
            type="button"
            data-vod-focus=""
            data-vod-osd-volume=""
            onClick={() => { onActivity?.(); onToggleMute(); }}
            className={`${ROUND_BUTTON_BASE} ${isMuted ? ROUND_BUTTON_RED : ROUND_BUTTON_IDLE} w-[2.85rem] h-[2.85rem] md:w-[3.25rem] md:h-[3.25rem]`}
            title={isMuted ? 'Némítás ki' : 'Némítás'}
            aria-label={isMuted ? 'Hang bekapcsolása' : 'Hang némítása'}
          >
            {isMuted ? <VolumeX className="w-[22px] h-[22px]" /> : <Volume2 className="w-[22px] h-[22px]" />}
          </button>

          {/* PIROS ✕ – a referencia „sebesség” gombjának helyén: visszalép oda,
              ahonnan a filmet kiválasztottuk. */}
          <button
            type="button"
            data-vod-focus=""
            data-vod-osd-close=""
            onClick={() => { onActivity?.(); onClose(); }}
            className="shrink-0 rounded-full w-[2.85rem] h-[2.85rem] md:w-[3.25rem] md:h-[3.25rem] flex items-center justify-center border-2 border-red-500 bg-red-600/30 text-red-400 transition-all hover:bg-red-600/50 hover:text-red-300 focus:outline-none focus:ring-4 focus:ring-red-500/60 focus:scale-105 active:scale-95 cursor-pointer"
            title="Vissza a filmválasztáshoz"
            aria-label="Vissza a filmválasztáshoz"
          >
            <X className="w-6 h-6 md:w-7 md:h-7" />
          </button>
        </div>

        {!hasDuration && (
          <p className="text-center text-[11px] text-white/60">
            A film időtartama még nem ismert – a tekerés az első képkockák után válik elérhetővé.
          </p>
        )}
      </div>

      {/* ── HANGSÁV / FELIRAT választó ─────────────────────────────────────── */}
      {menu && (
        <div
          ref={menuRef}
          data-vod-menu=""
          role="dialog"
          aria-modal="true"
          aria-label={menu === 'audio' ? 'Hangsáv választó' : 'Felirat választó'}
          onKeyDown={(event) => {
            if (normalizeTvKey(event) === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onMenuChange(null);
            }
          }}
          onClick={() => onMenuChange(null)}
          className="fixed inset-0 z-[10000] flex items-center justify-center p-3 md:p-5 bg-black/80 backdrop-blur-sm pointer-events-auto"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            data-track-panel="vod"
            className="w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden rounded-2xl border-2 border-blue-500/60 bg-[#081329] shadow-2xl"
          >
            <div className="relative flex items-center justify-center gap-3 border-b border-blue-900/60 bg-[#0a1835] px-12 py-3 text-center">
              <h2 className="text-base sm:text-lg font-black tracking-wide text-white">{menuTitle}</h2>
              {menu === 'subtitle' && (
                <button
                  type="button"
                  onClick={() => onMenuChange(null)}
                  aria-label="Bezárás"
                  className="absolute right-3 top-3 p-1.5 rounded-full border-2 border-blue-500/60 bg-[#0e1d3b] text-blue-300 transition-all hover:bg-[#16274b] active:scale-90"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            <div data-track-list="" className="flex-1 min-h-0 space-y-2 overflow-y-auto p-4">
              {menu === 'subtitle' && (
                <>
                  {subtitleTracks.length === 0 && (
                    <p className="rounded-xl border border-slate-700 bg-[#0a152d] p-3 text-xs leading-relaxed text-slate-400">
                      Ehhez a filmhez a lejátszó nem jelez feliratsávot, és a szolgáltató sem tett közzé
                      letölthető feliratot.
                    </p>
                  )}

                  {subtitleTracks.map((track) => {
                    const selected = activeSubtitleId != null && String(track.id) === String(activeSubtitleId);
                    return (
                      <button
                        key={String(track.id)}
                        type="button"
                        data-vod-menu-item=""
                        data-track-option=""
                        data-vod-menu-selected={selected ? '1' : undefined}
                        onClick={() => { onActivity?.(); onSelectSubtitle(track); onMenuChange(null); }}
                        className={`w-full rounded-2xl border p-3 text-center transition-all focus:outline-none focus:ring-[3px] focus:ring-blue-400 focus:bg-[#102042] ${
                          selected
                            ? 'border-blue-400 bg-[#0f244a] text-white ring-1 ring-blue-400/40'
                            : 'border-slate-800 bg-[#0a152d] text-slate-300 hover:bg-[#102042]'
                        }`}
                      >
                        <span data-track-content="">
                          <span data-track-title="">{trackLabel(track.name, track.lang, 'Felirat')}</span>
                        </span>
                        {selected && (
                          <span data-track-check="" className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-400 text-slate-950">
                            <Check className="w-4 h-4 stroke-[3]" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    data-vod-menu-item=""
                    data-track-option=""
                    data-vod-menu-selected={activeSubtitleId == null ? '1' : undefined}
                    aria-pressed={activeSubtitleId == null}
                    onClick={() => { onActivity?.(); onSelectSubtitle(null); onMenuChange(null); }}
                    className={`w-full rounded-2xl border p-3 text-center transition-all focus:outline-none focus:ring-[3px] focus:ring-blue-400 focus:bg-[#102042] ${
                      activeSubtitleId == null
                        ? 'border-blue-400 bg-[#0f244a] text-white ring-1 ring-blue-400/40'
                        : 'border-slate-800 bg-[#0a152d] text-slate-300 hover:bg-[#102042]'
                    }`}
                  >
                    <span data-track-content=""><span data-track-title="">Felirat kikapcsolva</span></span>
                    {activeSubtitleId == null && <span data-track-check="" className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-400 text-slate-950"><Check className="w-4 h-4 stroke-[3]" /></span>}
                  </button>
                </>
              )}

              {menu === 'audio' && (
                <>
                  {audioTracks.length === 0 ? (
                    <p className="rounded-xl border border-slate-700 bg-[#0a152d] p-3 text-xs text-slate-400">
                      A lejátszó nem jelzett választható hangsávot ehhez a filmhez vagy sorozathoz.
                    </p>
                  ) : audioTracks.map((track) => {
                    const hasNativeSelection = audioTracks.some((item) => item.selected === true);
                    const selected = track.selected === true
                      || (!hasNativeSelection && String(track.id) === String(audioTracks[0]?.id));
                    return (
                      <button
                        key={String(track.id)}
                        type="button"
                        data-vod-menu-item=""
                        data-track-option=""
                        data-vod-menu-selected={selected ? '1' : undefined}
                        onClick={() => { onActivity?.(); onSelectAudio(track); onMenuChange(null); }}
                        className={`w-full rounded-2xl border p-3 text-center transition-all focus:outline-none focus:ring-[3px] focus:ring-blue-400 focus:bg-[#102042] ${
                          selected
                            ? 'border-blue-400 bg-[#0f244a] text-white ring-1 ring-blue-400/40'
                            : 'border-slate-800 bg-[#0a152d] text-slate-300 hover:bg-[#102042]'
                        }`}
                      >
                        <span data-track-content="">
                          <span data-track-title="">{trackLabel(track.name, track.lang)}</span>
                        </span>
                        {selected && (
                          <span data-track-check="" className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-400 text-slate-950">
                            <Check className="w-4 h-4 stroke-[3]" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </>
              )}
            </div>

          </div>
        </div>
      )}
    </div>
  );
};
