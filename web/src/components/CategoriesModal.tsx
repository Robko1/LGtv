import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Category, Channel, FavoriteFolder } from '../types/iptv';
import { Search, Layers, ChevronRight, Star } from 'lucide-react';
import { normalizeTvKey } from '../utils/tvKeys';

interface CategoriesModalProps {
  isOpen: boolean;
  onClose: () => void;
  categories: Category[];
  channels: Channel[];
  folders: FavoriteFolder[];
  onAssignChannelsToFolder: (channelIds: string[], folderId: string) => void;
  /* 2.5.276 (#14): csoportos kivétel – a kategória összes csatornájának kivétele minden kedvenc mappából. */
  onRemoveChannelsFromFolders: (channelIds: string[]) => void;
  selectedCategoryId: string;
  onSelectCategory: (categoryId: string) => void;
  onSelectSubCategory: (countryCategoryId: string, subCategoryId: string) => void;
  totalChannelsCount: number;
  isOnlyFavorites: boolean;
  setIsOnlyFavorites: (onlyFav: boolean) => void;
  onSearchQueryChange: (query: string) => void;
  onSelectSearchChannel: (channelId: string) => void;
  /** 2.5.318: Országok/élő lista visszatöltésének folyamata (csak Ország menüre, helyi tárból) 0-100% */
  liveRestoreProgress?: number;
  liveTotalCount?: number;
  liveLoadedCount?: number;
}

export const CategoriesModal: React.FC<CategoriesModalProps> = ({
  isOpen,
  onClose,
  categories,
  channels,
  folders,
  onAssignChannelsToFolder,
  onRemoveChannelsFromFolders,
  selectedCategoryId,
  onSelectCategory,
  onSelectSubCategory,
  totalChannelsCount,
  isOnlyFavorites,
  setIsOnlyFavorites,
  onSearchQueryChange,
  onSelectSearchChannel,
  liveRestoreProgress = 0,
  liveTotalCount = 0,
  liveLoadedCount = 0,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedCountryId, setExpandedCountryId] = useState<string | null>(null);
  const [searchEditing, setSearchEditing] = useState(false);
  const [favoriteTarget, setFavoriteTarget] = useState<{ title: string; channelIds: string[] } | null>(null);
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
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

  // A fókusz a kategórialistán marad; a kereső csak OK-ra vált gépelésre.
  useEffect(() => {
    if (!isOpen) {
      setSearchEditing(false);
      return;
    }
    const t = window.setTimeout(() => {
      const container = modalRef.current;
      if (!container) return;
      /*
       * 2.5.280 (#22/#23): ha a lista közben újraépült (pl. egy ország csatornái
       * épp betöltődtek) és a fókusz kikerült a panelből, visszaállítjuk az első
       * sorra – különben a nyilak „nem mennek sehova”, és a fókusz látszólag
       * össze-vissza ugrál. Ha a fókusz bent van a panelen, nem nyúlunk hozzá.
       */
      if (document.activeElement && container.contains(document.activeElement)) return;
      const firstCategory = container.querySelector<HTMLElement>('[data-category-row="true"]');
      (firstCategory || searchTriggerRef.current)?.focus({ preventScroll: true } as any);
    }, 120);
    return () => window.clearTimeout(t);
    // A channels.length azért kell, hogy új csatornák érkezésekor (ország
    // betöltése) is ellenőrizzük, nem veszett-e el a fókusz.
  }, [isOpen, channels.length]);

  useEffect(() => {
    if (!searchEditing) return;
    const t = window.setTimeout(() => searchInputRef.current?.focus({ preventScroll: true } as any), 0);
    return () => window.clearTimeout(t);
  }, [searchEditing]);

  const handleModalKeyDown = (e: React.KeyboardEvent) => {
    const key = normalizeTvKey(e);
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (searchEditing && document.activeElement === searchInputRef.current) return;
      const container = modalRef.current;
      if (!container) return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [data-category-row="true"]:not([aria-disabled="true"])'
      )).filter(el => el.offsetParent !== null);
      if (!focusable.length) return;
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      e.stopPropagation();
      const nextIndex = key === 'ArrowDown'
        ? (currentIndex < 0 ? 0 : (currentIndex + 1) % focusable.length)
        : (currentIndex < 0 ? focusable.length - 1 : (currentIndex - 1 + focusable.length) % focusable.length);
      const next = focusable[nextIndex];
      next?.focus();
      next?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else if (key === 'Escape' || key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      if (searchEditing) {
        setSearchEditing(false);
        window.setTimeout(() => searchTriggerRef.current?.focus({ preventScroll: true } as any), 0);
      } else if (expandedCountryId) {
        setExpandedCountryId(null);
      } else {
        onClose();
      }
    } else if ((key === 'Enter' || key === ' ') && document.activeElement === searchTriggerRef.current) {
      e.preventDefault();
      e.stopPropagation();
      setSearchEditing(true);
    }
  };

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

  // Az országokhoz tartozó alkategóriákat és darabszámokat egyszer, memoizálva
  // készítjük el. Korábban minden ország megnyitásakor újra végigszűrtük a
  // teljes csatornalistát, majd minden alkategóriánál ismételtünk egy szűrést.
  // Nagy IPTV-listán ez a modal megakasztását és hosszú hibaáradatot okozhatott.
  const countrySubCategories = useMemo(() => {
    const byCountry = new Map<string, Map<string, { id: string; name: string; count: number }>>();
    for (const channel of channels) {
      const countryCode = (channel.countryCode || 'INT').toUpperCase();
      const categoryId = channel.categoryId || 'other';
      let country = byCountry.get(countryCode);
      if (!country) {
        country = new Map();
        byCountry.set(countryCode, country);
      }
      const existing = country.get(categoryId);
      if (existing) {
        existing.count++;
      } else {
        country.set(categoryId, {
          id: categoryId,
          name: channel.categoryName || categoryId,
          count: 1,
        });
      }
    }
    return byCountry;
  }, [channels]);

  const homeCategory = categories.find((cat) => cat.id === 'country-HU') || categories[0];

  const openFavoritePicker = (title: string, channelIds: string[]) => {
    if (channelIds.length) setFavoriteTarget({ title, channelIds });
  };
  /*
   * 2.5.276 (#14-es kérés): a kategória csillaga valódi KAPCSOLÓ.
   * - Ha a csoport (még részben) szerepel valamelyik kedvenc mappában, egy
   *   nyomás KIVESZI az összes ide tartozó csatornát MINDEN kedvenc mappából.
   * - Egyébként megnyílik a mappaválasztó, és csak ennek a kategóriának a
   *   csatornái kerülnek be (soha nem más kategória elemei).
   */
  const groupIdsForCountry = (catId: string): string[] => {
    if (!catId.startsWith('country-')) return [];
    const code = catId.slice('country-'.length);
    return channels
      .filter((channel) => (channel.countryCode || 'INT').toUpperCase() === code)
      .map((channel) => channel.id);
  };
  const isAnyInFavorites = (channelIds: string[]): boolean =>
    channelIds.length > 0 && channelIds.some((id) => folders.some((folder) => folder.channelIds.includes(id)));
  const toggleGroupFavorite = (title: string, channelIds: string[]) => {
    if (!channelIds.length) return;
    if (isAnyInFavorites(channelIds)) onRemoveChannelsFromFolders(channelIds);
    else openFavoritePicker(title, channelIds);
  };

  // A feltételes visszatérés csak az összes hook után lehet: különben a modal
  // nyitásakor/zárásakor változik a hookok száma, ami React futásidejű hibát okoz.
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-xs animate-fadeIn select-none lg:select-auto" role="dialog" aria-modal="true" aria-label="Kategóriák" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* Kategóriapanel a TV ablakméretéhez igazítva. */}
      <div ref={modalRef} tabIndex={-1} onKeyDown={handleModalKeyDown} className="w-full max-w-md md:max-w-lg lg:max-w-xl xl:max-w-3xl 2xl:max-w-4xl h-full bg-[#081226] border-l border-cyan-900/40 flex flex-col shadow-2xl animate-slideLeft focus:outline-none">
        {/* Header */}
        <div className="p-4 bg-[#0a1630] border-b border-cyan-950 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-cyan-400 stroke-[2.5]" />
            <h2 className="text-lg font-black text-white tracking-wider">
              KATEGÓRIÁK
            </h2>
          </div>

        </div>

        {/* 2.5.318: ORSZÁGOK BETÖLTŐ % — csak Ország menüre töltődik a teljes élő lista, itt látszik a kör (kattintás után) */}
        {liveRestoreProgress > 0 && liveRestoreProgress < 100 ? (
          <div className="px-3 py-2 bg-[#0f2042]/70 border-b border-cyan-800/40 flex items-center gap-3">
            {/* 3D kör — ORSZÁGOK (cián), 0-100% a helyi tárból — illeszkedik a legfölülre ahol van hely */}
            <div className="relative w-14 h-14 md:w-16 md:h-16 shrink-0 -ml-0.5">
              <svg width="64" height="64" viewBox="0 0 56 56" className="w-14 h-14 md:w-16 md:h-16 -rotate-90 drop-shadow-[0_4px_10px_rgba(6,182,212,0.5)]">
                <defs>
                  <linearGradient id="gradCountries" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#67e8f9" />
                    <stop offset="50%" stopColor="#06b6d4" />
                    <stop offset="100%" stopColor="#0891b2" />
                  </linearGradient>
                  <radialGradient id="innerCountries" cx="50%" cy="40%" r="55%">
                    <stop offset="0%" stopColor="#083344" />
                    <stop offset="65%" stopColor="#0a2540" />
                    <stop offset="100%" stopColor="#070e1e" />
                  </radialGradient>
                </defs>
                <circle cx="28" cy="28" r="22" fill="none" stroke="#0f172a" strokeWidth="6" />
                <circle cx="28" cy="28" r="22" fill="none" stroke="url(#gradCountries)" strokeWidth="6" strokeLinecap="round" strokeDasharray={138.23} strokeDashoffset={138.23 * (1 - Math.min(100, Math.max(0, liveRestoreProgress)) / 100)} style={{ transition: 'stroke-dashoffset 0.45s ease' }} />
                <circle cx="28" cy="28" r="15" fill="url(#innerCountries)" stroke="#0e7490" strokeWidth="1.2" />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-[11px] md:text-[12px] font-black text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">{Math.round(liveRestoreProgress)}%</span>
            </div>
            <div className="flex flex-col leading-tight min-w-0">
              <span className="text-[10px] md:text-xs font-bold tracking-[0.14em] text-cyan-300/90">ORSZÁGOK</span>
              <span className="text-sm md:text-base font-black text-white truncate">
                {liveRestoreProgress >= 100 ? `${liveLoadedCount.toLocaleString('hu-HU')} betöltve` : `Betöltés… ${Math.round(liveRestoreProgress)}%`}
              </span>
              <span className="text-xs font-bold text-cyan-200 truncate">
                {liveTotalCount > 0 ? `${liveLoadedCount.toLocaleString('hu-HU')} / ${liveTotalCount.toLocaleString('hu-HU')} csatorna${liveLoadedCount < liveTotalCount ? ' • még tölt' : ''}` : `${liveLoadedCount.toLocaleString('hu-HU')} csatorna`}
              </span>
            </div>
          </div>
        ) : null}

        {/* Search Bar */}
        <div className="p-3 bg-[#081226] border-b border-cyan-950/50">
          <div className={`relative rounded-xl border-2 transition-colors ${searchEditing ? 'border-yellow-400 ring-2 ring-yellow-400/20' : 'border-cyan-900/60 focus-within:border-yellow-400'}`}>
            <Search className="w-4 h-4 text-cyan-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            {searchEditing ? (
              <input
                ref={searchInputRef}
                type="text"
                value={searchTerm}
                onChange={(e) => { const value = e.target.value; setSearchTerm(value); propagateSearch(value); }}
                onBlur={() => {}}
                placeholder="Csatorna kereső... (név vagy kategória)"
                className="w-full bg-[#0e1e3e] rounded-[10px] pl-9 pr-3 py-2 text-xs sm:text-sm text-white placeholder-slate-400 focus:outline-none"
              />
            ) : (
              <button
                ref={searchTriggerRef}
                type="button"
                onClick={() => setSearchEditing(true)}
                className="w-full text-left bg-[#0e1e3e] rounded-[10px] pl-9 pr-3 py-2 text-xs sm:text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-yellow-400"
                aria-label="Kereső megnyitása"
              >
                {searchTerm || 'Csatorna kereső... (OK a gépeléshez)'}
              </button>
            )}
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
            // 2.5.276 (#14): a csillag a TELJES ország-kategóriára vonatkozik, és
            // kapcsolóként működik (hozzáad ↔ összes kivétele).
            const groupIds = groupIdsForCountry(cat.id);
            const groupFav = isAnyInFavorites(groupIds);
            return (
              <React.Fragment key={cat.id}>
              <div className="flex items-stretch gap-2">
              <button type="button" aria-label={(groupFav ? "Kivétel a kedvencekből: " : "Kedvencekhez adás: ") + cat.name} onClick={(e) => { e.stopPropagation(); toggleGroupFavorite(cat.name, groupIds); }} className={"w-12 shrink-0 rounded-xl border-2 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300 " + (groupFav ? "border-yellow-300 bg-yellow-400/20 text-yellow-300" : "border-slate-600 bg-[#0a1630] text-slate-400 hover:text-yellow-300")}><Star className="w-6 h-6" fill={groupFav ? "currentColor" : "none"} /></button>
              <div
                data-category-row="true"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.currentTarget as HTMLDivElement).click(); } }}
                onClick={() => {
                  // Ha több alkategória van, kiválasztjuk az országot (pl. Magyarország 105)
                  // és lenyitjuk az alkategóriákat – így csak a kiválasztott ország/kategória
                  // csatornái jelennek meg, nem nyílik több kategória egyszerre.
                  if (cat.subCategoryCount > 0) {
                    const willExpand = expandedCountryId !== cat.id;
                    // Az ország csak kategóriaválasztóként nyílik le; a főoldali
                    // csatornalista csak az „Összes ország” vagy egy alkategória
                    // külön kiválasztásakor változik meg.
                    setIsOnlyFavorites(false);
                    setExpandedCountryId(willExpand ? cat.id : null);
                    if (!willExpand) onClose();
                    return;
                  }
                  setIsOnlyFavorites(false);
                  setExpandedCountryId(null);
                  onSelectCategory(cat.id);
                  onClose();
                }}
                className={`group flex items-center justify-between p-3 rounded-2xl cursor-pointer transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 ${
                  isSelected
                    ? 'bg-linear-to-r from-cyan-950 via-[#0e2752] to-[#0a1b38] border-2 border-cyan-400 shadow-lg ring-1 ring-cyan-400/30'
                    : 'bg-[#0a1630] hover:bg-[#11244a] border border-cyan-900/30'
                }`}
              >
                {/*
                  NAGY országnév: a név akkora, mint a doboz (text-lg → 2xl),
                  de `truncate` + `min-w-0` miatt SOHA nem lóg ki belőle.
                  A csatorna- és kategóriaszám a név MELLETT van (nem alatta),
                  a zászló pedig jóval nagyobb, jól látható TV-ről is.
                */}
                <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
                  <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-[#0e1e3e] border border-cyan-800/40 flex items-center justify-center text-3xl sm:text-4xl shadow-inner shrink-0">
                    {cat.flag || '📺'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                      <h3 className="min-w-0 max-w-full truncate text-white font-black leading-tight text-lg sm:text-xl lg:text-2xl group-hover:text-cyan-300 transition-colors">
                        {cat.name}
                      </h3>
                      <span className="shrink-0 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-xs sm:text-sm font-black text-cyan-200">
                        {cat.channelCount} csatorna
                      </span>
                      <span className="shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs sm:text-sm font-black text-amber-200">
                        {cat.subCategoryCount} kategória
                      </span>
                    </div>
                  </div>
                </div>

                <ChevronRight className={`w-7 h-7 shrink-0 transition-transform group-hover:translate-x-1 ${isSelected ? 'text-cyan-300' : 'text-slate-500'}`} />
              </div>
              </div>
              {expandedCountryId === cat.id && (() => {
                const countryCode = cat.id.slice('country-'.length);
                const subCategories = Array.from(countrySubCategories.get(countryCode)?.values() || [])
                  .sort((a, b) => a.name.localeCompare(b.name, 'hu', { sensitivity: 'base', numeric: true }));
                return (
                  <div className="ml-5 mt-1 mb-2 pl-3 border-l-2 border-cyan-700/60 space-y-1">
                    <button
                      onClick={() => {
                        setIsOnlyFavorites(false);
                        setExpandedCountryId(null);
                        onSelectCategory(cat.id);
                        onClose();
                      }}
                      className="w-full flex items-center justify-between gap-2 rounded-xl border-2 border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20 px-4 py-3 text-left text-base sm:text-lg font-black text-amber-200"
                    >
                      <span className="min-w-0 truncate">Összes {cat.name}</span>
                      <span className="shrink-0 text-sm sm:text-base text-amber-300">{cat.channelCount}</span>
                    </button>
                    {subCategories.map((subCategory) => {
                      const subChannelIds = channels.filter((channel) => (channel.countryCode || "INT").toUpperCase() === countryCode && (channel.categoryId || "other") === subCategory.id).map((channel) => channel.id);
                      // 2.5.276 (#14): az alkategória csillaga is kapcsoló (hozzáad ↔ összes kivétele).
                      const subIsFavorite = isAnyInFavorites(subChannelIds);
                      return (
                      <div key={subCategory.id} className="flex items-stretch gap-2">
                      <button type="button" aria-label={(subIsFavorite ? "Kivétel a kedvencekből: " : "Kedvencekhez adás: ") + subCategory.name} onClick={() => toggleGroupFavorite(subCategory.name, subChannelIds)} className={"w-12 shrink-0 rounded-xl border-2 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300 " + (subIsFavorite ? "border-yellow-300 bg-yellow-400/20 text-yellow-300" : "border-slate-600 bg-[#0a1630] text-slate-400 hover:text-yellow-300")}><Star className="w-6 h-6" fill={subIsFavorite ? "currentColor" : "none"} /></button>
                      <button
                        key={subCategory.id}
                        onClick={() => {
                          setIsOnlyFavorites(false);
                          setExpandedCountryId(null);
                          onSelectSubCategory(cat.id, subCategory.id);
                          onClose();
                        }}
                        className="w-full flex items-center justify-between gap-2 rounded-xl border border-cyan-900/50 bg-[#0b1b36] hover:bg-[#12305b] px-4 py-3 text-left text-base sm:text-lg font-bold text-slate-100"
                      >
                        <span className="min-w-0 truncate">{subCategory.name}</span>
                        <span className="shrink-0 text-sm sm:text-base text-slate-300">{subCategory.count}</span>
                      </button>
                      </div>
                      );
                    })}
                  </div>
                );
              })()}
              </React.Fragment>
            );
          })}
        </div>
      </div>
      {favoriteTarget && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="Kedvencmappa kiválasztása">
          <div className="w-full max-w-md rounded-2xl border border-yellow-400/50 bg-[#081329] p-5 text-white shadow-2xl">
            {/* 2.5.277 (#17-es kérés): a fejlécben pontosan látszik, HÁNY csatorna kerül be – így egy alkategória (pl. Kids 24/7) kiválasztásánál nem lehet „minden bejelölődni” észrevétlenül. */}
            <h3 className="mb-1 text-lg font-black text-yellow-300">„{favoriteTarget.title}” hozzáadása kedvencekhez</h3>
            <p className="mb-3 text-sm font-bold text-slate-300">Pontosan {favoriteTarget.channelIds.length} csatorna kerül a mappába (csak ez a csoport).</p>
            {folders.length ? folders.map((folder) => (
              <button key={folder.id} onClick={() => { onAssignChannelsToFolder(favoriteTarget.channelIds, folder.id); setFavoriteTarget(null); }} className="mb-2 w-full rounded-xl border border-slate-600 bg-[#102247] p-3 text-left font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300">{folder.name}</button>
            )) : <p className="py-3 text-sm text-slate-300">Még nincs létrehozott kedvencmappa.</p>}
            <button onClick={() => setFavoriteTarget(null)} className="mt-2 w-full rounded-xl border border-slate-600 p-3 font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300">Mégse</button>
          </div>
        </div>
      )}
    </div>
  );
};
