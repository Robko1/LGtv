import React, { useState, useEffect } from 'react';
import { Film, Tv, Layers, Clock, Settings, X } from 'lucide-react';
import { formatClockTime, normalizeClockOffset } from '../utils/clock';

interface HeaderProps {
  activeView: 'live' | 'movies' | 'series';
  onViewChange: (view: 'live' | 'movies' | 'series') => void;
  onOpenCategories: () => void;
  onOpenSettings: (tab?: 'channels' | 'lists' | 'favorites' | 'system') => void;
  /** Óra eltolása órában (0 = a készülék órája). */
  clockOffsetHours?: number;
}

export const Header: React.FC<HeaderProps> = ({
  activeView,
  onViewChange,
  onOpenCategories,
  onOpenSettings,
  clockOffsetHours = 0,
}) => {
  const [currentTime, setCurrentTime] = useState<string>('');

  // Az óra a beállított eltolással számol (a webOS néha UTC-t ad vissza a
  // helyi idő helyett). Csak a kijelzett percérték változásakor rajzolunk.
  const offset = normalizeClockOffset(clockOffsetHours);
  useEffect(() => {
    const updateTime = () => {
      const next = formatClockTime(offset);
      setCurrentTime((previous) => (previous === next ? previous : next));
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [offset]);

  const handleExitApp = () => {
    window.close();
  };

  return (
    <header
      className="sticky top-0 z-40 bg-[#070d1d]/95 backdrop-blur-md border-b border-cyan-950/40 pl-0 pr-2 py-2 md:py-2.5 lg:py-3 flex items-center justify-between gap-2 md:gap-3 lg:gap-4 shadow-md">
      {/*
        TV-n a kijelölő SZIGORÚAN balról jobbra halad:
          Sorozat -> Mozi -> Országok -> [Beállítások] -> [X]  (körbe)
        A Beállításokról LEFELÉ lehet indulni - onnan a kedvencek
        mappasávjába, onnan a csatornalistára. A Sorozat a sor eleje, ezért
        onnan csak jobbra lehet lépni.
      */}
      <div className="flex flex-1 items-center gap-1 md:gap-1.5 lg:gap-2 flex-nowrap min-w-0 mr-1">
        {/* Az óra önálló, keret és háttér nélküli elem, a fejléc bal széléhez igazítva. */}
        <div className="flex flex-none items-center justify-start h-10 md:h-11 lg:h-12 pl-1 pr-1.5 text-amber-300 font-mono font-semibold tracking-wider">
          <Clock className="hidden w-4 h-4 md:w-5 md:h-5 text-amber-400 animate-pulse shrink-0" />
          <span className="whitespace-nowrap text-2xl sm:text-3xl md:text-3xl lg:text-4xl leading-none">{currentTime || '02:15'}</span>
        </div>

        {activeView !== 'live' && (
          <button
            onClick={() => onViewChange('live')}
            data-tv-header=""
            data-tv-header-kind="live"
            className="flex flex-1 min-w-0 items-center justify-center gap-1 px-1 h-9 md:h-10 lg:h-11 rounded-lg text-[22px] font-bold transition-all border active:scale-95 bg-cyan-600 hover:bg-cyan-500 md:hover:bg-cyan-500 text-white border-cyan-400/60 shadow-lg shadow-cyan-900/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 cursor-pointer"
            aria-label="TV"
            title="TV"
          >
            <Tv className="w-10 h-10 md:w-12 md:h-12 text-white" />
            <span>TV</span>
          </button>
        )}

        <button
          onClick={() => onViewChange('series')}
          data-tv-header=""
          data-tv-header-kind="series"
          className={`flex flex-1 min-w-0 items-center justify-center gap-1 px-1 h-9 md:h-10 lg:h-11 rounded-lg text-[22px] font-bold transition-all border active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 cursor-pointer ${
            activeView === 'series'
              ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/60 shadow-lg shadow-cyan-950/40'
              : 'bg-[#0f1b35] text-slate-200 border-slate-700/60 hover:bg-[#152345] md:hover:bg-[#1a2d5a] hover:text-cyan-300'
          }`}
        >
          <Layers className="w-8 h-8 md:w-10 md:h-10 text-cyan-400" />
          <span>Sorozat</span>
        </button>

        <button
          onClick={() => onViewChange('movies')}
          data-tv-header=""
          data-tv-header-kind="movies"
          className={`flex flex-1 min-w-0 items-center justify-center gap-1 px-1 h-9 md:h-10 lg:h-11 rounded-lg text-[22px] font-bold transition-all border active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 cursor-pointer ${
            activeView === 'movies'
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/60 shadow-lg shadow-amber-950/40'
              : 'bg-[#0f1b35] text-slate-200 border-slate-700/60 hover:bg-[#152345] md:hover:bg-[#1a2d5a] hover:text-amber-300'
          }`}
        >
          <Film className="w-8 h-8 md:w-10 md:h-10 text-amber-400" />
          <span>Mozi</span>
        </button>

        {activeView === 'live' && (
          <button
            onClick={onOpenCategories}
            data-tv-header=""
            data-tv-header-kind="countries"
            className="flex flex-1 min-w-0 items-center justify-center gap-1 px-1 h-9 md:h-10 lg:h-11 rounded-lg text-[22px] font-bold transition-all border active:scale-95 bg-[#0f1b35] text-slate-200 border-slate-700/60 hover:bg-[#152345] md:hover:bg-[#1a2d5a] hover:text-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 cursor-pointer"
            title="Országok – kategóriák és csatornalisták"
          >
            <svg viewBox="0 0 24 16" className="w-12 h-8 rounded-[3px] shrink-0" aria-hidden="true">
              <rect width="24" height="16" fill="#ffffff" />
              <rect width="24" height="5.33" fill="#ce2939" />
              <rect y="10.67" width="24" height="5.33" fill="#477050" />
            </svg>
            <span>Országok</span>
          </button>
        )}

        <button
          data-tv-header-default=""
          data-tv-header=""
          data-tv-header-kind="settings"
          onClick={() => onOpenSettings()}
          className="flex flex-1 min-w-0 items-center justify-center gap-1 px-1 h-9 md:h-10 lg:h-11 rounded-lg text-[22px] font-bold transition-all border bg-[#0f1b35] text-slate-200 border-slate-700/60 hover:bg-[#152345] hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 cursor-pointer"
          title="Menü"
          aria-label="Menü"
        >
          <Settings className="w-8 h-8 shrink-0" />
          <span>Menü</span>
        </button>
      </div>

      {/* Kilépés az alkalmazásból */}
      <div className="flex shrink-0 items-center gap-1.5 md:gap-2 ml-0">
        <button
          onClick={handleExitApp}
          data-tv-header=""
          data-tv-header-kind="exit"
          className="flex shrink-0 items-center justify-center w-8 h-8 md:w-9 md:h-9 lg:w-10 lg:h-10 text-red-500 hover:text-red-400 active:scale-90 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 cursor-pointer bg-transparent rounded-lg"
          title="Kilépés az alkalmazásból"
          aria-label="Kilépés az alkalmazásból"
        >
          <X className="w-6 h-6 md:w-7 md:h-7 lg:w-8 lg:h-8 stroke-[3]" />
        </button>
      </div>
    </header>
  );
};
