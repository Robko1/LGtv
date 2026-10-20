import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Category, Channel } from '../types/iptv';
import { X, Search, Layers, ChevronRight } from 'lucide-react';
import { normalizeTvKey } from '../utils/tvKeys';

interface CategoriesModalProps {
  isOpen: boolean;
  onClose: () => void;
  categories: Category[];
  channels: Channel[];
  selectedCategoryId: string;
  onSelectCategory: (categoryId: string) => void;
  onSelectSubCategory: (countryCategoryId: string, subCategoryId: string) => void;
  totalChannelsCount: number;
  isOnlyFavorites: boolean;
  setIsOnlyFavorites: (onlyFav: boolean) => void;
  onSearchQueryChange: (query: string) => void;
  onSelectSearchChannel: (channelId: string) => void;
}

export const CategoriesModal: React.FC<CategoriesModalProps> = ({
  isOpen,
  onClose,
  categories,
  channels,
  selectedCategoryId,
  onSelectCategory,
  onSelectSubCategory,
  totalChannelsCount,
  isOnlyFavorites,
  setIsOnlyFavorites,
  onSearchQueryChange,
  onSelectSearchChannel,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedCountryId, setExpandedCountryId] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  // A főoldali (App) szűréshez késleltetve adjuk át a keresést: gépelés közben
  // ne induljon el minden leütésre a teljes csatornalista újraszűrése.
  const searchPropagateTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (searchPropagateTimer.current !== null) window.clearTimeout(searchPropagateTimer.current);
  }, []);
  const propagateSearch = (value: string) => {
    if (searchPropagateTimer.current !== null) window.clearTimeout(searchPropagateTimer.current);
    searchPropagateTimer.current = window.setTimeout(() => {
      searchPropagateTimer.current = null;
      onSearchQueryChange(value);
    }, 250);
  };

  // TV / stick: auto-focus + D-pad navigáció
  useEffect(() => {
    if (!isOpen) return;
    const focusModal = () => {
      try {
        const container = modalRef.current;
        if (!container) return;
        const focusable = container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length > 0) {
          const firstButton = Array.from(focusable).find(el => el.tagName === 'BUTTON') as HTMLElement | undefined;
          (firstButton || focusable[0])?.focus({ preventScroll: true } as any);
        }
      } catch {}
    };
    const t1 = window.setTimeout(focusModal, 100);
    const t2 = window.setTimeout(focusModal, 500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [isOpen]);

  const handleModalKeyDown = (e: React.KeyboardEvent) => {
    // LG webOS: régi kulcsnév ('Up') vagy csak keyCode (37-40, VISSZA=461) is jöhet.
    const key = normalizeTvKey(e);
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      try {
        const container = modalRef.current;
        if (!container) return;
        const focusable = Array.from(container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(el => !el.hasAttribute('disabled') && (el as HTMLElement).offsetParent !== null);
        if (focusable.length === 0) return;
        const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
        e.preventDefault(); e.stopPropagation();
        if (key === 'ArrowDown') {
          const next = focusable[(currentIndex + 1) % focusable.length];
          next?.focus(); next?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else {
          const prev = focusable[(currentIndex - 1 + focusable.length) % focusable.length];
          prev?.focus(); prev?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      } catch {}
    } else if (key === 'Escape' || key === 'Backspace') {
      e.preventDefault(); e.stopPropagation(); onClose();
    }
  };

  if (!isOpen) return null;

  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();

  /**
   * Keresés: korábban ez MINDEN kirajzoláskor lefutott a teljes csatornalistán,
   * ráadásul csatornánként egy `categories.find` és kategóriánként egy
   * `channels.some` is - 20 000 csatornánál ez gépelés közben több millió
   * művelet volt. Most memoizált, országnév-térképpel és találati halmazzal.
   */
  const { searchResults, filtered } = useMemo(() => {
    if (!normalizedSearch) {
      const sorted = [...categories].sort((a, b) =>
        a.id === 'country-HU' ? -1 : b.id === 'country-HU' ? 1 : a.name.localeCompare(b.name, 'hu', { sensitivity: 'base', numeric: true })
      );
      return { searchResults: [] as Channel[], filtered: sorted };
    }
    const countryNames = new Map<string, string>();
    for (const cat of categories) {
      if (cat.id.startsWith('country-')) countryNames.set(cat.id.slice('country-'.length), cat.name);
    }
    const matched: Channel[] = [];
    const matchedCountryCodes = new Set<string>();
    for (const channel of channels) {
      const code = (channel.countryCode || 'INT').toUpperCase();
      const countryName = countryNames.get(code) || channel.country || '';
      const haystack = [channel.name, channel.categoryName, channel.categoryId, channel.country, channel.countryCode, countryName];
      let hit = false;
      for (const value of haystack) {
        if (String(value || '').toLocaleLowerCase().includes(normalizedSearch)) { hit = true; break; }
      }
      if (!hit) continue;
      matchedCountryCodes.add(code);
      if (matched.length < 150) matched.push(channel);
    }
    const filteredCats = categories
      .filter((cat) => cat.name.toLocaleLowerCase().includes(normalizedSearch)
        || matchedCountryCodes.has(cat.id.slice('country-'.length)))
      .sort((a, b) =>
        a.id === 'country-HU' ? -1 : b.id === 'country-HU' ? 1 : a.name.localeCompare(b.name, 'hu', { sensitivity: 'base', numeric: true })
      );
    return { searchResults: matched, filtered: filteredCats };
  }, [categories, channels, normalizedSearch]);

  const homeCategory = categories.find((cat) => cat.id === 'country-HU') || categories[0];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-xs animate-fadeIn select-none lg:select-auto" role="dialog" aria-modal="true" aria-label="Kategóriák" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* Drawer Container – reszponzív: telefon max-md, tablet lg, laptop xl, TV 2xl */}
      <div ref={modalRef} tabIndex={-1} onKeyDown={handleModalKeyDown} className="w-full max-w-md md:max-w-lg lg:max-w-xl xl:max-w-2xl 2xl:max-w-3xl h-full bg-[#081226] border-l border-cyan-900/40 flex flex-col shadow-2xl animate-slideLeft focus:outline-none">
        {/* Header */}
        <div className="p-4 bg-[#0a1630] border-b border-cyan-950 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-cyan-400 stroke-[2.5]" />
            <h2 className="text-lg font-black text-white tracking-wider">
              KATEGÓRIÁK
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-slate-300 active:scale-90 transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Bar */}
        <div className="p-3 bg-[#081226] border-b border-cyan-950/50">
          <div className="relative">
            <Search className="w-4 h-4 text-cyan-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => { const value = e.target.value; setSearchTerm(value); propagateSearch(value); }}
              placeholder="Csatorna kereső... (név vagy kategória)"
              className="w-full bg-[#0e1e3e] border border-cyan-900/60 rounded-xl pl-9 pr-3 py-2 text-xs sm:text-sm text-white placeholder-slate-400 focus:outline-hidden focus:border-cyan-400 transition-colors"
            />
          </div>
        </div>

        {/* Filter Pills (Összes / Kedvencek) */}
        <div className="px-3 py-2 flex items-center gap-2 border-b border-cyan-950/40">
          <button
            onClick={() => {
              setIsOnlyFavorites(false);
              onSelectCategory(homeCategory?.id || 'all');
            }}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-black transition-all ${
              !isOnlyFavorites && selectedCategoryId === homeCategory?.id
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                : 'bg-[#0f2144] text-slate-200 border border-slate-700/60 hover:bg-[#152e5c]'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>{homeCategory?.name || 'Magyarország'} ({homeCategory?.channelCount ?? totalChannelsCount})</span>
          </button>


        </div>

        {/* Category Count Header Row */}
        <div className="px-4 py-2 bg-[#09152b] border-b border-cyan-950/30 text-xs text-slate-400">
          <span className="font-bold text-cyan-400">{normalizedSearch ? searchResults.length + ' csatornatalálat' : filtered.length + ' kategória'}</span>
          {normalizedSearch && searchResults.length > 150 && <span className="ml-2"> (az első 150)</span>}
        </div>

        {/* Category Cards List */}
        <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
          {normalizedSearch && searchResults.map((channel) => (
            <button
              key={channel.id}
              onClick={() => { onSelectSearchChannel(channel.id); onClose(); }}
              className="w-full flex items-center justify-between gap-3 p-3 rounded-xl bg-[#0a1630] hover:bg-[#11244a] border border-cyan-900/40 text-left"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-white">{channel.name}</span>
                <span className="block truncate text-xs text-slate-400">{channel.country || categories.find((cat) => cat.id === `country-${(channel.countryCode || 'INT').toUpperCase()}`)?.name || 'Nemzetközi'} • {channel.categoryName || channel.categoryId}</span>
              </span>
              <ChevronRight className="w-5 h-5 shrink-0 text-slate-500" />
            </button>
          ))}
          {normalizedSearch && searchResults.length === 0 && filtered.length === 0 && (
            <p className="p-4 text-center text-sm text-slate-400">Nincs találat erre: „{searchTerm}”</p>
          )}
          {filtered.map((cat) => {
            const isSelected = selectedCategoryId === cat.id && !isOnlyFavorites;
            return (
              <React.Fragment key={cat.id}>
              <div
                onClick={() => {
                  const countryCode = cat.id.startsWith('country-') ? cat.id.slice('country-'.length) : '';
                  const subCategories = countryCode
                    ? Array.from(new Map(channels
                        .filter((channel) => (channel.countryCode || 'INT').toUpperCase() === countryCode)
                        .map((channel) => [channel.categoryId, { id: channel.categoryId, name: channel.categoryName || channel.categoryId }])
                      ).values())
                    : [];
                  // Ha több alkategória van, kiválasztjuk az országot (pl. Magyarország 105)
                  // és lenyitjuk az alkategóriákat – így csak a kiválasztott ország/kategória
                  // csatornái jelennek meg, nem nyílik több kategória egyszerre.
                  if (subCategories.length > 1) {
                    const willExpand = expandedCountryId !== cat.id;
                    setIsOnlyFavorites(false);
                    onSelectCategory(cat.id);
                    setExpandedCountryId(willExpand ? cat.id : null);
                    if (!willExpand) onClose();
                    return;
                  }
                  setIsOnlyFavorites(false);
                  setExpandedCountryId(null);
                  onSelectCategory(cat.id);
                  onClose();
                }}
                className={`group flex items-center justify-between p-3 rounded-2xl cursor-pointer transition-all duration-150 ${
                  isSelected
                    ? 'bg-linear-to-r from-cyan-950 via-[#0e2752] to-[#0a1b38] border-2 border-cyan-400 shadow-lg ring-1 ring-cyan-400/30'
                    : 'bg-[#0a1630] hover:bg-[#11244a] border border-cyan-900/30'
                }`}
              >
                {/* Left: Flag / Icon + Category Details */}
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#0e1e3e] border border-cyan-800/40 flex items-center justify-center text-2xl shadow-inner shrink-0">
                    {cat.flag || '📺'}
                  </div>
                  <div>
                    <h3 className="text-white font-bold text-sm group-hover:text-cyan-300 transition-colors">
                      {cat.name}
                    </h3>
                    <p className="text-xs text-slate-400 font-medium">
                      {cat.channelCount} csatorna • {cat.subCategoryCount} kategória
                    </p>
                  </div>
                </div>

                <ChevronRight className={`w-5 h-5 shrink-0 transition-transform group-hover:translate-x-1 ${isSelected ? 'text-cyan-300' : 'text-slate-500'}`} />
              </div>
              {expandedCountryId === cat.id && (() => {
                const countryCode = cat.id.slice('country-'.length);
                const subCategories = Array.from(new Map(channels
                  .filter((channel) => (channel.countryCode || 'INT').toUpperCase() === countryCode)
                  .map((channel) => [channel.categoryId, { id: channel.categoryId, name: channel.categoryName || channel.categoryId }])
                ).values()).sort((a, b) => a.name.localeCompare(b.name));
                return (
                  <div className="ml-5 mt-1 mb-2 pl-3 border-l-2 border-cyan-700/60 space-y-1">
                    <button
                      onClick={() => {
                        setIsOnlyFavorites(false);
                        setExpandedCountryId(null);
                        onSelectCategory(cat.id);
                        onClose();
                      }}
                      className="w-full flex items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-2 text-left text-sm font-bold text-amber-200"
                    >
                      <span>Összes {cat.name}</span>
                      <span className="text-xs text-amber-300">{cat.channelCount}</span>
                    </button>
                    {subCategories.map((subCategory) => (
                      <button
                        key={subCategory.id}
                        onClick={() => {
                          setIsOnlyFavorites(false);
                          setExpandedCountryId(null);
                          onSelectSubCategory(cat.id, subCategory.id);
                          onClose();
                        }}
                        className="w-full flex items-center justify-between gap-2 rounded-xl border border-cyan-900/40 bg-[#0b1b36] hover:bg-[#12305b] px-3 py-2 text-left text-sm text-slate-200"
                      >
                        <span>{subCategory.name}</span>
                        <span className="text-xs text-slate-400">{channels.filter((channel) => (channel.countryCode || 'INT').toUpperCase() === countryCode && channel.categoryId === subCategory.id).length}</span>
                      </button>
                    ))}
                  </div>
                );
              })()}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
};
