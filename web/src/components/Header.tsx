import React, { useState, useEffect } from 'react';
import { Film, Tv, Layers, Clock, Settings, X } from 'lucide-react';

interface HeaderProps {
  activeView: 'live' | 'movies' | 'series';
  onViewChange: (view: 'live' | 'movies' | 'series') => void;
  onOpenCategories: () => void;
  onOpenSettings: (tab?: 'channels' | 'lists' | 'favorites' | 'system') => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeView,
  onViewChange,
  onOpenCategories,
  onOpenSettings,
}) => {
  const [currentTime, setCurrentTime] = useState<string>('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      setCurrentTime(`${hours}:${minutes}`);
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleExitApp = () => {
    window.close();
  };

  return (
    <header className="sticky top-0 z-40 bg-[#070d1d]/95 backdrop-blur-md border-b border-cyan-950/40 pl-0 pr-2 py-2 md:py-2.5 lg:py-3 flex items-center justify-between gap-2 md:gap-3 lg:gap-4 shadow-md">
      {/* Mozi/Sorozat nézetben a sorrend: hamburger, Élő TV, Mozi, Sorozat, óra. Reszponzív tablet/laptop/TV */}
      <div className="flex flex-1 items-center gap-1.5 md:gap-2 lg:gap-3 flex-nowrap min-w-0 mr-1">
        {/* Óra – kis doboz a bal sarokban */}
        <div className="flex shrink-0 h-10 md:h-11 lg:h-12 items-center justify-center gap-1 px-2 rounded-xl bg-[#0a162e] border border-amber-400/30 text-amber-300 font-mono text-xs md:text-sm font-semibold tracking-wider shadow-inner">
          <Clock className="w-3.5 h-3.5 md:w-4 md:h-4 text-amber-400 animate-pulse" />
          <span>{currentTime || '02:15'}</span>
        </div>

        {activeView === 'live' && (
          <button
            onClick={onOpenCategories}
            className="flex flex-1 min-w-0 items-center justify-center gap-1.5 px-1.5 h-10 md:h-11 lg:h-12 rounded-xl text-[11px] sm:text-sm md:text-sm lg:text-base font-bold transition-all border active:scale-95 bg-[#0f1b35] text-slate-200 border-slate-700/60 hover:bg-[#152345] md:hover:bg-[#1a2d5a] hover:text-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 cursor-pointer"
            title="Országok – kategóriák és csatornalisták"
          >
            <svg viewBox="0 0 24 16" className="w-6 h-4 rounded-[3px] shrink-0" aria-hidden="true">
              <rect width="24" height="16" fill="#ffffff" />
              <rect width="24" height="5.33" fill="#ce2939" />
              <rect y="10.67" width="24" height="5.33" fill="#477050" />
            </svg>
            <span>Országok</span>
          </button>
        )}

        {activeView !== 'live' && (
          <button
            onClick={() => onViewChange('live')}
            className="flex flex-1 min-w-0 items-center justify-center gap-1.5 px-1.5 h-10 md:h-11 lg:h-12 rounded-xl text-[11px] sm:text-sm md:text-sm lg:text-base font-bold transition-all border active:scale-95 bg-cyan-600 hover:bg-cyan-500 md:hover:bg-cyan-500 text-white border-cyan-400/60 shadow-lg shadow-cyan-900/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 cursor-pointer"
            aria-label="TV"
            title="TV"
          >
            <Tv className="w-5 h-5 md:w-6 md:h-6 text-white" />
            <span>TV</span>
          </button>
        )}

        <button
          onClick={() => onViewChange('movies')}
          className={`flex flex-1 min-w-0 items-center justify-center gap-1.5 px-1.5 h-10 md:h-11 lg:h-12 rounded-xl text-[11px] sm:text-sm md:text-sm lg:text-base font-bold transition-all border active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 cursor-pointer ${
            activeView === 'movies'
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/60 shadow-lg shadow-amber-950/40'
              : 'bg-[#0f1b35] text-slate-200 border-slate-700/60 hover:bg-[#152345] md:hover:bg-[#1a2d5a] hover:text-amber-300'
          }`}
        >
          <Film className="w-5 h-5 md:w-6 md:h-6 text-amber-400" />
          <span>Mozi</span>
        </button>

        <button
          onClick={() => onViewChange('series')}
          className={`flex flex-1 min-w-0 items-center justify-center gap-1.5 px-1.5 h-10 md:h-11 lg:h-12 rounded-xl text-[11px] sm:text-sm md:text-sm lg:text-base font-bold transition-all border active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 cursor-pointer ${
            activeView === 'series'
              ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/60 shadow-lg shadow-cyan-950/40'
              : 'bg-[#0f1b35] text-slate-200 border-slate-700/60 hover:bg-[#152345] md:hover:bg-[#1a2d5a] hover:text-cyan-300'
          }`}
        >
          <Layers className="w-5 h-5 md:w-6 md:h-6 text-cyan-400" />
          <span>Sorozat</span>
        </button>

      </div>

      {/* A beállítások és a kilépés gomb – reszponzív egér + TV */}
      <div className="flex shrink-0 items-center gap-2 md:gap-3 ml-0">
        <button
          data-tv-header-default=""
          onClick={() => onOpenSettings()}
          className="flex shrink-0 items-center justify-center w-10 h-10 md:w-11 md:h-11 lg:w-12 lg:h-12 rounded-xl bg-amber-400 hover:bg-amber-300 md:hover:bg-amber-300 text-slate-950 shadow-lg shadow-amber-500/20 active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 cursor-pointer"
          title="Menü & Beállítások"
          aria-label="Beállítások"
        >
          <Settings className="w-5 h-5 md:w-6 md:h-6 stroke-[2.2] animate-[spin_10s_linear_infinite]" />
        </button>
        <button
          onClick={handleExitApp}
          className="flex shrink-0 items-center justify-center w-8 h-8 md:w-9 md:h-9 lg:w-10 lg:h-10 text-red-500 hover:text-red-400 active:scale-90 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 cursor-pointer bg-transparent"
          title="Kilépés az alkalmazásból"
          aria-label="Kilépés az alkalmazásból"
        >
          <X className="w-6 h-6 md:w-7 md:h-7 lg:w-8 lg:h-8 stroke-[3]" />
        </button>
      </div>
    </header>
  );
};
