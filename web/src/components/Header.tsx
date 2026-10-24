import React, { useState, useEffect } from 'react';
import { Film, Tv, Layers, Clock, Settings, X } from 'lucide-react';
import { formatClockTime, normalizeClockOffset } from '../utils/clock';
import { normalizeTvKey } from '../utils/tvKeys';

interface HeaderProps {
  /** A piros gombbal kapcsolható főoldali tükrözés állapota. */
  mirrorLayout?: boolean;
  activeView: 'live' | 'movies' | 'series';
  liveAccent?: 'yellow' | 'red' | 'blue' | 'pink';
  onViewChange: (view: 'live' | 'movies' | 'series') => void;
  onOpenCategories: () => void;
  onOpenSettings: (tab?: 'channels' | 'lists' | 'favorites' | 'system') => void;
  /** Óra eltolása órában (0 = a készülék órája). */
  clockOffsetHours?: number;
  /**
   * A csatornalistában KIVÁLASZTOTT ország zászlaja (emoji).
   *
   * A főoldalon az „Országok” gomb előtt mindig ez látszik – korábban ott
   * beégetett magyar zászló állt, függetlenül a kiválasztott országtól.
   */
  countryFlag?: string;
  /** A kiválasztott ország neve (tipp szöveghez). */
  countryName?: string;
}

export const Header: React.FC<HeaderProps> = ({
  mirrorLayout = false,
  activeView,
  liveAccent = 'yellow',
  onViewChange,
  onOpenCategories,
  onOpenSettings,
  clockOffsetHours = 0,
  countryFlag,
  countryName,
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

  // A fejléc saját D-pad kezelése minden nézetben felülírja a globális
  // geometriai fókuszléptetést. A tényleges képernyőpozíciót használjuk, ezért
  // a tükrözött és a normál elrendezés azonosan működik; az X is a sor része.
  // Az óra nem kap fókuszt, mert nem tartozik a data-tv-header-kind elemek közé.
  const handleHeaderDpad = (event: React.KeyboardEvent<HTMLElement>) => {
    const key = normalizeTvKey(event);
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-tv-header-kind]');
    if (!target || !target.closest('header')) return;

    if (key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;

    const items = Array.from(
      target.closest('header')!.querySelectorAll<HTMLElement>('[data-tv-header-kind]')
    )
      .filter((item) => item.getClientRects().length > 0 && !item.hasAttribute('disabled'))
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (aRect.left + aRect.width / 2) - (bRect.left + bRect.width / 2);
      });

    const index = items.indexOf(target);
    const next = items[index + (key === 'ArrowRight' ? 1 : -1)];
    event.preventDefault();
    event.stopPropagation();
    if (next) next.focus({ preventScroll: true });
  };

  return (
    <header
      data-live-accent={liveAccent}
      onKeyDown={handleHeaderDpad}
      className="sticky top-0 z-40 bg-[#070d1d]/95 backdrop-blur-md border-b border-cyan-950/40 pl-0 pr-2 py-2 md:py-2.5 lg:py-3 flex items-center justify-between gap-2 md:gap-3 lg:gap-4 shadow-md">
      {/*
        A NÉGY DOBOZ SORRENDJE (a sárga óra mellett):
          Menü -> Sorozat -> Mozi -> Országok

        Csak a HELYÜK változott – a méretük nem. A TV gomb (amikor nem az
        élő nézetben vagyunk) a sor elején marad, hogy a visszalépés mindig
        ugyanott legyen. A Beállítások (Menü) dobozról LEFELÉ lehet indulni:
        onnan a kedvencek mappasávja, onnan a csatornalista.
      */}
      <div className="flex flex-1 items-center gap-2 md:gap-3 lg:gap-4 flex-nowrap min-w-0 mr-1">
        {/* Az óra önálló, keret és háttér nélküli elem, a fejléc bal széléhez igazítva. */}
        <div aria-hidden="true" className="flex flex-none items-center justify-start h-10 md:h-11 lg:h-12 pl-1 pr-1.5 text-amber-300 font-mono font-semibold tracking-wider order-first">
          <Clock className="hidden w-4 h-4 md:w-5 md:h-5 text-amber-400 animate-pulse shrink-0" />
          <span data-header-clock="" className="whitespace-nowrap text-2xl sm:text-3xl md:text-3xl lg:text-4xl leading-none">{currentTime || '02:15'}</span>
        </div>

        {activeView !== 'live' && (
          <button
            onClick={() => onViewChange('live')}
            data-tv-header=""
            data-tv-header-kind="live"
            data-tv-header-default=""
            /*
             * A TV gomb a Mozi/Sorozat nézetben SEM kap világoskék kiemelést
             * (a felhasználó kérése): ugyanolyan semleges doboz, mint a többi.
             */
            className="flex flex-1 basis-0 min-w-0 max-w-[15rem] items-center justify-center gap-1 px-1 h-9 md:h-10 lg:h-11 rounded-lg text-[22px] font-bold transition-all border active:scale-95 bg-[#0f1b35] text-slate-200 border-slate-700/60 hover:bg-[#152345] md:hover:bg-[#1a2d5a] hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 cursor-pointer"
            aria-label="TV"
            title="TV"
          >
            <Tv className="w-8 h-8 md:w-10 md:h-10 text-cyan-400" />
            <span>TV</span>
          </button>
        )}

        {/*
          1. MENÜ (Beállítások) – KIZÁRÓLAG az élő nézetben.
          Mozi/Sorozat nézetben a doboz NEM látszik (a felhasználó kérése);
          onnan a TV gombbal lehet visszalépni. A Beállítások a PIROS/SÁRGA/
          KÉK gombokkal és a főoldali menüből továbbra is elérhető.
        */}
        {activeView === 'live' && (
          <button
            data-tv-header-default=""
            data-tv-header=""
            data-tv-header-kind="settings"
            onClick={() => onOpenSettings()}
            className={`flex flex-1 basis-0 min-w-0 max-w-[15rem] items-center justify-center gap-1 px-1 h-9 md:h-10 lg:h-11 rounded-lg text-[22px] font-bold transition-all border bg-[#0f1b35] text-slate-200 border-slate-700/60 hover:bg-[#152345] hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 cursor-pointer ${mirrorLayout ? 'order-first' : 'order-last'}`}
            title="Menü"
            aria-label="Menü"
          >
            <Settings className="w-8 h-8 shrink-0 text-amber-400" />
            <span>Menü</span>
          </button>
        )}

        {/* 2. SOROZAT */}
        <button
          onClick={() => onViewChange('series')}
          data-tv-header=""
          data-tv-header-kind="series"
          className={`flex flex-1 basis-0 min-w-0 max-w-[15rem] items-center justify-center gap-1 px-1 h-9 md:h-10 lg:h-11 rounded-lg text-[22px] font-bold transition-all border active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 cursor-pointer ${
            activeView === 'series'
              ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/60 shadow-lg shadow-cyan-950/40'
              : 'bg-[#0f1b35] text-slate-200 border-slate-700/60 hover:bg-[#152345] md:hover:bg-[#1a2d5a] hover:text-cyan-300'
          }`}
        >
          <Layers className="w-8 h-8 md:w-10 md:h-10 text-cyan-400" />
          <span>Sorozatok</span>
        </button>

        {/* 3. MOZI */}
        <button
          onClick={() => onViewChange('movies')}
          data-tv-header=""
          data-tv-header-kind="movies"
          className={`flex flex-1 basis-0 min-w-0 max-w-[15rem] items-center justify-center gap-1 px-1 h-9 md:h-10 lg:h-11 rounded-lg text-[22px] font-bold transition-all border active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 cursor-pointer ${
            activeView === 'movies'
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/60 shadow-lg shadow-amber-950/40'
              : 'bg-[#0f1b35] text-slate-200 border-slate-700/60 hover:bg-[#152345] md:hover:bg-[#1a2d5a] hover:text-amber-300'
          }`}
        >
          <Film className="w-8 h-8 md:w-10 md:h-10 text-amber-400" />
          <span>Mozi</span>
        </button>

        {/* 4. ORSZÁGOK – a KIVÁLASZTOTT ország zászlajával */}
        {activeView === 'live' && (
          <button
            onClick={onOpenCategories}
            data-tv-header=""
            data-tv-header-kind="countries"
            data-country-flag={countryFlag || ''}
            className={`flex flex-1 basis-0 min-w-0 max-w-[15rem] items-center justify-center gap-1 px-1 h-9 md:h-10 lg:h-11 rounded-lg text-[22px] font-bold transition-all border active:scale-95 bg-[#0f1b35] text-slate-200 border-slate-700/60 hover:bg-[#152345] md:hover:bg-[#1a2d5a] hover:text-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 cursor-pointer ${mirrorLayout ? 'order-last' : 'order-first'}`}
            title={countryName ? `Országok – most: ${countryName}` : 'Országok – kategóriák és csatornalisták'}
          >
            {countryFlag ? (
              <span className="text-3xl leading-none shrink-0" aria-hidden="true">{countryFlag}</span>
            ) : (
              <svg viewBox="0 0 24 16" className="w-12 h-8 rounded-[3px] shrink-0" aria-hidden="true">
                <rect width="24" height="16" fill="#ffffff" />
                <rect width="24" height="5.33" fill="#ce2939" />
                <rect y="10.67" width="24" height="5.33" fill="#477050" />
              </svg>
            )}
            <span>Országok</span>
          </button>
        )}
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
