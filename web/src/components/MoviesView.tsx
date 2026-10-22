import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Category, Movie, AppSettings } from '../types/iptv';
import { PosterImage, PosterSettingsButton } from './PosterImage';
import { Search, Star, Play, Clock, Sparkles, Filter, ChevronDown, Mic2, Subtitles } from 'lucide-react';
import { normalizeTvKey } from '../utils/tvKeys';

interface MoviesViewProps {
  movies: Movie[];
  settings: AppSettings;
  categories?: Category[];
  totalCount?: number;
  onPlayMovie: (movie: Movie) => void;
  selectedCategoryId?: string;
  onSelectedCategoryChange?: (categoryId: string) => void;
  onBackToLive: () => void;
  onToggleFavoriteMovie: (movieId: string) => void;
}

const PAGE_SIZE = 120;
let movieReturnSnapshot: { searchTerm: string; scrollTop: number; visibleCount: number } | null = null;

const MoviesViewComponent: React.FC<MoviesViewProps> = ({
  movies,
  categories: providerCategories,
  totalCount,
  onPlayMovie,
  selectedCategoryId: savedSelectedCategory = 'all',
  onSelectedCategoryChange,
}) => {
  const [searchTerm, setSearchTerm] = useState(() => movieReturnSnapshot?.searchTerm ?? '');
  const [isSearchEditing, setIsSearchEditing] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>(savedSelectedCategory);
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [visibleCount, setVisibleCount] = useState(() => movieReturnSnapshot?.visibleCount ?? PAGE_SIZE);
  const movieGridRef = useRef<HTMLDivElement | null>(null);
  const [isCategoryMenuOpen, setIsCategoryMenuOpen] = useState(false);
  /*
   * A részletek-ablak fókusza: a távirányító OK gombjára megnyíló ablakban
   * a kijelölőnek AZONNAL a „Film Indítása” gombra kell kerülnie – enélkül
   * a fókusz a kártyán maradt, a webOS gombkezelő pedig a dialóguson belül
   * keresett szomszédot (nem talált), így a nyilak nem mozgattak semmit.
   */
  const detailDialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!selectedMovie) {
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true } as FocusOptions);
      return;
    }
    if (!previousFocusRef.current) previousFocusRef.current = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      const first = detailDialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)');
      first?.focus({ preventScroll: true } as FocusOptions);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [selectedMovie]);

  const categories = [
    { id: 'all', name: 'Összes film' },
    ...(providerCategories || [])
      .filter((cat) => cat.channelCount > 0)
      .map((cat) => ({ id: cat.id, name: `${cat.name} (${cat.channelCount})` })),
  ];

  // FONTOS (fagyás): a szűrés memoizálva van. Korábban minden kirajzoláskor
  // lefutott a teljes listán (akár 40 000 filmen), soronként több
  // kisbetűsítéssel – ez önmagában másodpercekre fagyasztotta a felületet.
  const filteredMovies = useMemo(() => movies.filter((m) => {
    const matchesCat = selectedCategory === 'all' || m.categoryId === selectedCategory;
    const term = searchTerm.toLowerCase();
    const matchesSearch =
      !term ||
      m.title.toLowerCase().includes(term) ||
      m.genres.some((g) => g.toLowerCase().includes(term)) ||
      (m.director && m.director.toLowerCase().includes(term));
    return matchesCat && matchesSearch;
  }), [movies, selectedCategory, searchTerm]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    if (movieGridRef.current) movieGridRef.current.scrollTop = 0;
  }, [selectedCategory, searchTerm]);

  useEffect(() => {
    const snapshot = movieReturnSnapshot;
    if (!snapshot) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (movieGridRef.current) movieGridRef.current.scrollTop = snapshot.scrollTop;
        setVisibleCount(snapshot.visibleCount);
      });
    });
    movieReturnSnapshot = null;
  }, []);

  const visibleMovies = filteredMovies.slice(0, visibleCount);

  // A referenciához igazított könyvtárnézet: kategóriánkénti vízszintes polcok,
  // a teljes kategória csak az „Összes megtekintése” elemre nyílik meg.
  // Egyetlen lineáris csoportosítás, nem kategóriánkénti teljes lista-szűrés.
  const categoryRows = useMemo(() => {
    const grouped = new Map<string, Movie[]>();
    for (const movie of movies) {
      const key = movie.categoryId || 'uncategorized';
      const list = grouped.get(key);
      if (list) list.push(movie); else grouped.set(key, [movie]);
    }
    const rows = (providerCategories || [])
      .map((category) => ({ category, items: grouped.get(category.id) || [] }))
      .filter((row) => row.items.length > 0);
    const known = new Set(rows.map((row) => row.category.id));
    for (const [id, items] of grouped) {
      if (known.has(id)) continue;
      rows.push({ category: { id, name: items[0]?.categoryName || 'Egyéb', channelCount: items.length } as Category, items });
    }
    return rows;
  }, [movies, providerCategories]);

  return (
    <div className="flex-1 flex flex-col bg-[#070e1e] overflow-hidden select-none lg:select-auto" onKeyDown={(e) => { if (normalizeTvKey(e) === 'Escape' && !isSearchEditing && isCategoryMenuOpen) { e.preventDefault(); e.stopPropagation(); setIsCategoryMenuOpen(false); } }}>
      {/* Top Bar with Back Button & Search – reszponzív tablet/laptop/TV */}
      <div className="p-3 md:p-4 lg:p-4 xl:p-5 bg-[#09152e] border-b border-cyan-950/60 flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setIsCategoryMenuOpen((open) => !open)}
            aria-expanded={isCategoryMenuOpen}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#0f2042] hover:bg-[#162d5a] text-amber-300 border border-amber-500/30 text-xs font-bold active:scale-95 transition-all"
          >
            <ChevronDown className="w-4 h-4" />
            <span>Kategóriák</span>
          </button>

          <div className="flex items-center gap-2">
            <PosterSettingsButton />
          <div className="flex items-center gap-1.5 text-xs font-black text-amber-400">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>MOZI VOD KÖNYVTÁR ({totalCount && totalCount > movies.length ? `${movies.length} / ${totalCount}` : movies.length})</span>
          </div>
          </div>
        </div>

        {/* Search input */}
        <div className="relative">
          <Search className="w-4 h-4 text-cyan-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            readOnly={!isSearchEditing}
            onKeyDown={(e) => { const key = normalizeTvKey(e); if (key === 'Enter' && !isSearchEditing) { e.preventDefault(); setIsSearchEditing(true); } else if (key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (isSearchEditing) { setIsSearchEditing(false); (e.currentTarget as HTMLInputElement).blur(); } else if (isCategoryMenuOpen) { setIsCategoryMenuOpen(false); } } }}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Film keresése cím, műfaj vagy színész alapján..."
            className="w-full bg-[#0d1d3d] border border-cyan-900/60 rounded-xl pl-9 pr-3 py-2 text-xs sm:text-sm text-white placeholder-slate-400 focus:outline-hidden focus:border-cyan-400 transition-colors"
          />
        </div>

        {isCategoryMenuOpen && (
          <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto rounded-xl border border-amber-500/30 bg-[#081329] p-2">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => {
                  setSelectedCategory(cat.id);
                  onSelectedCategoryChange?.(cat.id);
                  setIsCategoryMenuOpen(false);
                }}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-all ${
                  selectedCategory === cat.id
                    ? 'bg-amber-400 text-slate-950 font-black'
                    : 'bg-[#0e1d3a] text-slate-300 border border-slate-700/60 hover:bg-[#142850]'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Referencia-szerű könyvtár: kategóriapolcok, lusta poszterbetöltéssel. */}
      <div ref={movieGridRef} data-scroll-keep="" onScroll={(e) => { const el = e.currentTarget; if ((selectedCategory !== 'all' || searchTerm.trim()) && el.scrollHeight - el.scrollTop - el.clientHeight < 700 && visibleCount < filteredMovies.length) setVisibleCount((count) => Math.min(count + PAGE_SIZE, filteredMovies.length)); }} className="flex-1 overflow-y-auto p-3 md:p-4 lg:p-5 xl:p-6">
        {selectedCategory === 'all' && !searchTerm.trim() ? (
          categoryRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-slate-400">
              <Filter className="w-10 h-10 text-slate-600 mb-2" />
              {movies.length === 0 ? (
                <>
                  <p className="text-sm font-semibold">A filmek betöltése folyamatban van…</p>
                  <p className="text-xs mt-1 max-w-xs leading-relaxed">A mentett filmlista megjelenik, amint a betöltés befejeződik.</p>
                </>
              ) : <p className="text-sm font-semibold">Nincs megjeleníthető filmkategória.</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-6 md:gap-8">
              {categoryRows.map(({ category, items }) => (
                <section key={category.id} className="min-w-0">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <h2 className="text-sm md:text-base font-black text-white truncate">{category.name}</h2>
                    <button onClick={() => { setSelectedCategory(category.id); onSelectedCategoryChange?.(category.id); if (movieGridRef.current) movieGridRef.current.scrollTop = 0; }}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-[#0f2042] border border-cyan-900/60 text-cyan-300 text-xs font-bold hover:bg-[#162d5a]">
                      Összes megtekintése ({items.length}) →
                    </button>
                  </div>
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {items.slice(0, 12).map((mov) => (
                      <button key={mov.id} onClick={() => setSelectedMovie(mov)}
                        className="group shrink-0 w-28 sm:w-32 md:w-36 lg:w-40 text-left rounded-xl overflow-hidden bg-[#0b162f] border border-cyan-950/70 hover:border-cyan-400/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                        <div className="relative aspect-[2/3] bg-slate-900 overflow-hidden">
                          <PosterImage src={mov.poster} title={mov.title} kind="movie" alt={mov.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                        </div>
                        <div className="p-2"><div className="text-white text-xs font-bold truncate">{mov.title}</div><div className="text-[10px] text-slate-400 mt-1">{mov.year || ''}</div></div>
                      </button>
                    ))}
                    {items.length > 12 && (
                      <button onClick={() => { setSelectedCategory(category.id); onSelectedCategoryChange?.(category.id); if (movieGridRef.current) movieGridRef.current.scrollTop = 0; }}
                        className="shrink-0 w-28 sm:w-32 md:w-36 lg:w-40 rounded-xl border border-dashed border-cyan-700/60 bg-[#0d1d3d] text-cyan-300 font-black text-sm hover:bg-[#142850]">
                        <span className="block text-2xl mb-2">•••</span>Mind a {items.length} film
                      </button>
                    )}
                  </div>
                </section>
              ))}
            </div>
          )
        ) : filteredMovies.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-400">
            <Filter className="w-10 h-10 text-slate-600 mb-2" />
            {movies.length === 0 ? (
              <><p className="text-sm font-semibold">A filmek betöltése folyamatban van…</p><p className="text-xs mt-1 max-w-xs leading-relaxed">A mentett filmlista megjelenik, amint a betöltés befejeződik.</p></>
            ) : <p className="text-sm font-semibold">Nincs találat a keresési feltételekre.</p>}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-3 md:gap-4 lg:gap-4 xl:gap-5">
            {visibleMovies.map((mov) => (
              <div key={mov.id} role="button" tabIndex={0} onClick={() => setSelectedMovie(mov)}
                onKeyDown={(e) => { const key = normalizeTvKey(e); if (key === 'Enter' || key === ' ') { e.preventDefault(); setSelectedMovie(mov); } }}
                className="group relative bg-[#0b162f] rounded-2xl border border-cyan-950/70 overflow-hidden cursor-pointer hover:border-cyan-400/80 transition-all duration-200 shadow-lg flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                <div className="relative aspect-[2/3] w-full bg-slate-900 overflow-hidden">
                  <PosterImage src={mov.poster} title={mov.title} kind="movie" alt={mov.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/80 border border-amber-400/40 text-amber-300 font-black text-[11px] flex items-center gap-1"><Star className="w-3 h-3 fill-amber-400 text-amber-400" /><span>{mov.rating}</span></div>
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><div className="w-12 h-12 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center"><Play className="w-5 h-5 fill-current ml-0.5" /></div></div>
                </div>
                <div className="p-2.5 flex-1"><h3 className="text-white font-bold text-xs truncate">{mov.title}</h3><div className="flex items-center gap-1.5 mt-1 text-[11px] text-slate-400"><span>{mov.year}</span><span>•</span><span className="flex items-center gap-0.5"><Clock className="w-3 h-3" />{mov.durationMinutes} perc</span></div></div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Movie Details Modal */}
      {selectedMovie && (
        <div ref={detailDialogRef} role="dialog" aria-modal="true" aria-label="Film részletei" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setSelectedMovie(null); } }} className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-4 lg:p-6 bg-black/80 backdrop-blur-sm animate-fadeIn select-none lg:select-auto">
          <div className="bg-[#09152e] border border-cyan-800/60 rounded-3xl max-w-lg md:max-w-xl lg:max-w-2xl xl:max-w-3xl w-full max-h-[90dvh] lg:max-h-[80vh] overflow-y-auto shadow-2xl animate-scaleUp">
            {/* Modal Backdrop Banner */}
            <div className="relative h-48 w-full bg-slate-900 overflow-hidden">
              <img
                src={selectedMovie.backdrop || selectedMovie.poster}
                alt={selectedMovie.title}
                className="w-full h-full object-cover opacity-60"
              />
              <div className="absolute inset-0 bg-linear-to-t from-[#09152e] via-transparent to-black/60" />

              <button
                onClick={() => setSelectedMovie(null)}
                className="absolute top-3 right-3 p-2 rounded-full bg-black/60 text-white hover:bg-black/80 active:scale-90 transition-all"
              >
                ✕
              </button>

              <div className="absolute bottom-3 left-4 right-4 flex items-end gap-3">
                <img
                  src={selectedMovie.poster}
                  alt={selectedMovie.title}
                  className="w-16 h-24 object-cover rounded-xl border-2 border-cyan-400 shadow-xl shrink-0"
                />
                <div className="min-w-0">
                  <h2 className="text-white font-black text-base sm:text-lg leading-tight truncate">
                    {selectedMovie.title}
                  </h2>
                  <div className="flex items-center gap-2 mt-1 text-xs text-slate-300">
                    <span className="font-bold text-amber-400">★ {selectedMovie.rating}</span>
                    <span>•</span>
                    <span>{selectedMovie.year}</span>
                    <span>•</span>
                    <span>{selectedMovie.durationMinutes} perc</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Body */}
            <div className="p-4 space-y-4">
              {/* Play Button */}
              <button
                onClick={() => {
                  const mov = selectedMovie;
                  movieReturnSnapshot = {
                    searchTerm,
                    scrollTop: movieGridRef.current?.scrollTop ?? 0,
                    visibleCount,
                  };
                  setSelectedMovie(null);
                  onPlayMovie(mov);
                }}
                className="w-full py-3.5 rounded-2xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-black text-sm flex items-center justify-center gap-2 shadow-xl shadow-cyan-400/30 active:scale-95 transition-all"
              >
                <Play className="w-5 h-5 fill-current" />
                <span>Film Indítása Most</span>
              </button>

              {/* Plot Synopsis */}
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                  Tartalom
                </h4>
                <p className="text-xs sm:text-sm text-slate-200 leading-relaxed">
                  {selectedMovie.plot}
                </p>
              </div>

              {/* Audio & Subtitle Details */}
              <div className="grid grid-cols-2 gap-2">
                <div className="p-3 rounded-xl bg-[#0e1d3b] border border-cyan-900/40">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-rose-300 mb-1">
                    <Mic2 className="w-3.5 h-3.5 text-rose-400" />
                    <span>Hangsávok</span>
                  </div>
                  <p className="text-[11px] text-slate-300">
                    Magyar 5.1 Dolby • Angol Atmos
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[#0e1d3b] border border-cyan-900/40">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-cyan-300 mb-1">
                    <Subtitles className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Feliratok</span>
                  </div>
                  <p className="text-[11px] text-slate-300">
                    Magyar teljes felirat • Angol CC
                  </p>
                </div>
              </div>

              {/* Cast & Director */}
              {selectedMovie.cast && (
                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                    Főbb Szereplők
                  </h4>
                  <p className="text-xs text-slate-300">
                    {selectedMovie.cast.join(', ')}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* A nézet memoizálva: a főoldal egyéb állapotváltozásai (pl. teljes
   képernyős váltás) nem rajzolják újra a teljes filmkönyvtárat. */
export const MoviesView = React.memo(MoviesViewComponent);
