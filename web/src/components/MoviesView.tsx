import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Category, Movie } from '../types/iptv';
import type { ProviderRef } from '../services/contentStore';
import { PosterImage, preloadPosterImage } from './PosterImage';
import { VodDetailSheet } from './VodDetailSheet';
import { Star, Play, Sparkles, Filter, ChevronDown, Mic2, Clock } from 'lucide-react';
import { normalizeTvKey } from '../utils/tvKeys';
import { formatRuntime, joinLanguages } from '../utils/vodDisplay';

interface MoviesViewProps {
  movies: Movie[];
  categories?: Category[];
  totalCount?: number;
  onPlayMovie: (movie: Movie) => void;
  selectedCategoryId?: string;
  onSelectedCategoryChange?: (categoryId: string) => void;
  onBackToLive: () => void;
  onToggleFavoriteMovie: (movieId: string) => void;
  isActive: boolean;
  activeProvider?: ProviderRef | null;
  /** Böngészés közbeni, adatlap-megnyitástól független előreolvasás. */
  onPrefetchMetadata?: (items: Movie[]) => void;
}

/* Függőleges, ötoszlopos rács; a poszterek 25-ös adagokban jelennek meg. */
const PAGE_SIZE = 25;
/*
 * A KÖVETKEZŐ ADAG KÜSZÖBE – az adag 15. posztere.
 *
 * Egyszerre legfeljebb 25 poszter kerül a DOM-ba (és töltődik be a
 * hálózatról). Amikor a néző görgetés közben eléri az utolsó adag 15.
 * poszterét, a következő 25 már a háttérben megérkezik – mire a 25.-hez
 * ér, kész van. Így a rács mindig csak annyit tart, amennyi látszik,
 * és nincs előre betöltve semmi, amire még nincs szükség.
 */
const NEXT_BATCH_AT = 15;
let movieReturnSnapshot: { scrollTop: number; visibleCount: number } | null = null;

const MoviesViewComponent: React.FC<MoviesViewProps> = ({
  movies,
  categories: providerCategories,
  totalCount,
  onPlayMovie,
  selectedCategoryId: savedSelectedCategory = 'all',
  onSelectedCategoryChange,
  isActive,
  onPrefetchMetadata,
  onToggleFavoriteMovie,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>(savedSelectedCategory);
  // A rács csak a megjelenített adag kártyáit tartalmazza.
  const [selectedMovieId, setSelectedMovieId] = useState<string | null>(null);
  const selectedMovie = useMemo(() => movies.find((movie) => movie.id === selectedMovieId) || null, [movies, selectedMovieId]);
  const [visibleCount, setVisibleCount] = useState(() => movieReturnSnapshot?.visibleCount ?? PAGE_SIZE);
  const movieGridRef = useRef<HTMLDivElement | null>(null);
  // A kijelölt poszter teljes egészében látható maradjon a görgethető rácsban.
  const scrollPosterFullyIntoView = (card: HTMLElement | null) => {
    const grid = movieGridRef.current;
    if (!card || !grid) return;
    const gridRect = grid.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const topEdge = gridRect.top + 16;
    const bottomEdge = gridRect.bottom - 16;
    if (cardRect.top < topEdge) grid.scrollTop -= topEdge - cardRect.top;
    else if (cardRect.bottom > bottomEdge) grid.scrollTop += cardRect.bottom - bottomEdge;
  };
  const preloadedThroughRef = useRef(0);
  const visibleCountRef = useRef(visibleCount);
  visibleCountRef.current = visibleCount;
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
      const first = detailDialogRef.current?.querySelector<HTMLElement>('[data-dialog-primary]')
        || detailDialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)');
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
  /*
   * A keresőmező megszűnt (kérés szerint), ezért az „Összes film” nézetben
   * NINCS végigszűrés: a teljes tömböt adjuk vissza. Korábban minden
   * kirajzoláskor végigfutott az összes film (akár 20 000) a szűrőn, még
   * akkor is, amikor semmilyen szűrés nem volt beállítva.
   */
  const filteredMovies = useMemo(
    () => (selectedCategory === 'all'
      ? movies
      : movies.filter((m) => m.categoryId === selectedCategory)),
    [movies, selectedCategory],
  );

  /*
   * Kategóriaváltáskor a lista elejére ugrunk. FONTOS: NEM figyeljük a
   * `movies` tömböt! A filmek/sorozatok több részletben érkeznek, és ha itt
   * figyelnénk rájuk, minden háttérfrissítés visszadobná a felhasználót a
   * lista tetejére (pontosan ez volt a „ugráló” görgetés a TV-n).
   */
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    if (movieGridRef.current) movieGridRef.current.scrollTop = 0;
    preloadedThroughRef.current = 0;
  }, [selectedCategory]);

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

  // Az adatlap csak mentett adatot használ. A látható környezet előreolvasása
  // böngészés közben fut, nem a poszter megnyitásakor vagy lejátszáskor.
  useEffect(() => {
    if (!isActive || selectedMovie || !onPrefetchMetadata) return;
    const pending = filteredMovies.slice(0, visibleCount + PAGE_SIZE).filter((item) => !item.detailProviderData);
    if (!pending.length) return;
    const timer = window.setTimeout(() => onPrefetchMetadata(pending), 350);
    return () => window.clearTimeout(timer);
  }, [isActive, selectedMovie, filteredMovies, visibleCount, onPrefetchMetadata]);

  const visibleMovies = useMemo(() => filteredMovies.slice(0, visibleCount), [filteredMovies, visibleCount]);

  // Látható poszterek gyors, korlátozottan párhuzamos előtöltése helyi képcímmel.
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const posters = visibleMovies.filter((movie) => movie.poster).slice(0, PAGE_SIZE);
    let cursor = 0;
    const worker = async () => {
      while (!cancelled && cursor < posters.length) {
        const movie = posters[cursor++];
        await preloadPosterImage(movie.poster, movie.title, 'movie', true);
      }
    };
    const frame = window.requestAnimationFrame(() => { void worker(); void worker(); void worker(); });
    return () => { cancelled = true; window.cancelAnimationFrame(frame); };
  }, [isActive, visibleMovies]);


  return (
    /*
     * A KERESŐMEZŐ és a „Poszterek” (TMDB-kulcs) gomb ELTŰNT (kérés
     * szerint) – a Mozi/Sorozat nézet tetején csak a Kategóriák választó és
     * a darabszám marad. Így a fejléc alacsonyabb, a posztereknek több hely
     * jut, és a nézetváltáskor kevesebb elem épül fel.
     */
    <div className="flex-1 flex flex-col bg-[#070e1e] overflow-hidden select-none lg:select-auto" onKeyDown={(e) => { if (normalizeTvKey(e) === 'Escape' && isCategoryMenuOpen) { e.preventDefault(); e.stopPropagation(); setIsCategoryMenuOpen(false); } }}>
      {/* Top Bar: Kategóriák + darabszám */}
      <div className="p-3 md:p-4 lg:p-4 xl:p-5 bg-[#09152e] border-b border-cyan-950/60 flex flex-col gap-2.5">
        <div className="relative flex items-center justify-end gap-2 min-h-[40px]">
          <button
            data-category-trigger="movies"
            onKeyDown={(e) => { const key = normalizeTvKey(e); if (key === 'ArrowDown') { e.preventDefault(); if (!isCategoryMenuOpen) movieGridRef.current?.querySelector<HTMLElement>('[data-poster-index="0"]')?.focus(); } else if (key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); document.querySelector<HTMLElement>('[data-tv-header-kind="movies"]')?.focus(); } }}
            onClick={() => setIsCategoryMenuOpen((open) => !open)}
            aria-expanded={isCategoryMenuOpen}
            className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 rounded-xl bg-[#0f2042] hover:bg-[#162d5a] text-amber-300 border border-amber-500/30 text-base font-bold active:scale-95 transition-all"
          >
            <ChevronDown className="w-4 h-4" />
            <span>Kategóriák</span>
          </button>

          <div className="flex items-center gap-2 text-base font-black text-amber-400">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>MOZI VOD KÖNYVTÁR ({totalCount && totalCount > movies.length ? `${movies.length} / ${totalCount}` : movies.length})</span>
          </div>
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
                /* A kategórianevek nagyobb betűvel, a doboz KÖZEPÉRE igazítva (a doboz mérete változatlan). */
                className={`flex h-12 w-full items-center justify-center overflow-hidden rounded-lg px-4 text-center text-xl sm:text-2xl font-bold leading-none transition-all ${
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

      {/* Függőleges poszterrács, adagonként bővülő listával. */}
      <div ref={movieGridRef} data-tv-navigation-owner="posters" data-scroll-keep="" onScroll={(e) => {
        const el = e.currentTarget;
        // Az utolsó adag 15. posztere (abszolút sorszám). Ha ez már látható,
        // jöhet a következő 25 – jóval azelőtt, hogy a lista vége érne.
        const trigger = Math.max(0, visibleCount - PAGE_SIZE) + (NEXT_BATCH_AT - 1);
        const triggerCard = el.querySelector<HTMLElement>(`[data-poster-index="${trigger}"]`);
        const reachedTrigger = !!triggerCard
          && triggerCard.getBoundingClientRect().top < el.getBoundingClientRect().bottom;
        if (reachedTrigger && visibleCount < filteredMovies.length) {
          setVisibleCount((count) => Math.min(count + PAGE_SIZE, filteredMovies.length));
        }
      }} onFocusCapture={(e) => {
        const target = e.target as HTMLElement;
        const card = target.closest<HTMLElement>('[data-poster-index]');
        const index = Number(card?.dataset.posterIndex);
        const focusTrigger = Math.max(0, visibleCount - PAGE_SIZE) + (NEXT_BATCH_AT - 1);
        if (Number.isFinite(index) && index >= focusTrigger && visibleCount < filteredMovies.length) {
          setVisibleCount((count) => Math.min(count + PAGE_SIZE, filteredMovies.length));
        }
      }} className="flex-1 overflow-y-auto px-3 pt-6 pb-6 md:px-4 md:pt-6 md:pb-6 lg:px-5 lg:pt-6 lg:pb-6 xl:px-6 xl:pt-6 xl:pb-6">
        {filteredMovies.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-400">
            <Filter className="w-10 h-10 text-slate-600 mb-2" />
            {movies.length === 0 ? (
              <><p className="text-sm font-semibold">A filmek betöltése folyamatban van…</p><p className="text-xs mt-1 max-w-xs leading-relaxed">A mentett filmlista megjelenik, amint a betöltés befejeződik.</p></>
            ) : <p className="text-sm font-semibold">Ebben a kategóriában nincs film.</p>}
          </div>
        ) : (
          <div className="grid grid-cols-5 gap-3 md:gap-4 lg:gap-4 xl:gap-5">
            {visibleMovies.map((mov, index) => (
              <div key={mov.id} role="button" tabIndex={0}
                data-poster-index={index}
                data-vod-card={String(mov.id)}
                onClick={() => setSelectedMovieId(mov.id)}
                onKeyDown={(e) => { const key = normalizeTvKey(e); if (key === 'Enter' || key === ' ') { e.preventDefault(); setSelectedMovieId(mov.id); return; } if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
                  e.preventDefault();
                  e.stopPropagation();
                  const index = Number((e.currentTarget as HTMLElement).dataset.posterIndex);
                  const cards = Array.from(movieGridRef.current?.querySelectorAll<HTMLElement>('[data-poster-index]') || []);
                  const columns = 5;
                  let target = index;
                  if (key === 'ArrowUp') target = index >= columns ? index - columns : -1;
                  if (key === 'ArrowDown') target = index + columns < cards.length ? index + columns : -1;
                  if (key === 'ArrowLeft') target = index > 0 ? index - 1 : -1;
                  if (key === 'ArrowRight') target = index + 1 < cards.length ? index + 1 : -1;
                  if (target >= 0 && target !== index) {
                    cards[target]?.focus({ preventScroll: true } as FocusOptions);
                    scrollPosterFullyIntoView(cards[target] || null);
                  } else if (key === 'ArrowDown' && index + columns >= cards.length && cards.length < filteredMovies.length) {
                    // A következő sor még nincs kirajzolva: bővítjük a listát, majd arra a poszterre fókuszálunk.
                    setVisibleCount((count) => Math.min(count + PAGE_SIZE, filteredMovies.length));
                    window.requestAnimationFrame(() => {
                      window.requestAnimationFrame(() => {
                        const nextPoster = movieGridRef.current?.querySelector<HTMLElement>(`[data-poster-index="${index + columns}"]`);
                        nextPoster?.focus({ preventScroll: true } as FocusOptions);
                        scrollPosterFullyIntoView(nextPoster || null);
                      });
                    });
                  } else if (key === 'ArrowUp' && index < columns) {
                    movieGridRef.current?.closest('[data-view-pane="movies"]')?.querySelector<HTMLElement>('[data-category-trigger]')?.focus({ preventScroll: true } as FocusOptions);
                  }
                } }}
                className="group relative h-fit self-start bg-[#0b162f] rounded-2xl border border-cyan-950/70 overflow-hidden cursor-pointer hover:border-cyan-400/80 transition-all duration-200 shadow-lg flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                <div className="relative aspect-[2/3] w-full bg-slate-900 overflow-hidden">
                  <PosterImage src={mov.poster} title={mov.title} kind="movie" localOnly alt={mov.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/80 border border-amber-400/40 text-amber-300 font-black text-[11px] flex items-center gap-1"><Star className="w-3 h-3 fill-amber-400 text-amber-400" /><span>{mov.rating}</span></div>
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><div className="w-12 h-12 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center"><Play className="w-5 h-5 fill-current ml-0.5" /></div></div>
                </div>
                <div className="p-3">
                  <h3 className="text-white font-black text-lg sm:text-xl truncate">{mov.title}</h3>
                  {/* 2.5.227: a filmkártya PONTOSAN a sorozatkártya elrendezését követi.
                      Év balra, játékidő jobbra – egyetlen vízszintes sorban. */}
                  <div className="mt-1 flex min-h-6 items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-base sm:text-lg font-bold text-amber-300">
                      {mov.year > 0 ? mov.year : ''}
                    </span>
                    {formatRuntime(mov.durationMinutes) && (
                      <span className="flex min-w-0 items-center justify-end gap-1 truncate text-sm sm:text-base font-bold text-cyan-200">
                        <Clock className="h-4 w-4 shrink-0" />
                        <span className="truncate">{formatRuntime(mov.durationMinutes)}</span>
                      </span>
                    )}
                  </div>
                  {/* Audió balra, jól olvasható feliratnyelvek jobbra – ugyanabban a sorban. */}
                  {(joinLanguages(mov.audioLanguages) || joinLanguages(mov.subtitleLanguages)) && (
                    <div className="mt-1 flex min-h-6 items-center justify-between gap-2 text-xs sm:text-sm font-semibold">
                      <span className="flex min-w-0 flex-1 items-center gap-1 text-rose-200">
                        <Mic2 className="h-4 w-4 shrink-0 text-rose-300" />
                        <span className="truncate">{joinLanguages(mov.audioLanguages) || '—'}</span>
                      </span>
                      <span className="min-w-0 flex-1 truncate text-right text-slate-100">
                        {joinLanguages(mov.subtitleLanguages) || '—'}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedMovie && (
        <VodDetailSheet
          kind="movie"
          item={selectedMovie}
          isFavorite={Boolean(selectedMovie.isFavorite)}
          onClose={() => setSelectedMovieId(null)}
          onToggleFavorite={() => onToggleFavoriteMovie(selectedMovie.id)}
          onPlayMovie={(mov) => {
            movieReturnSnapshot = { scrollTop: movieGridRef.current?.scrollTop ?? 0, visibleCount };
            setSelectedMovieId(null);
            onPlayMovie(mov);
          }}
        />
      )}
    </div>
  );
};

/* A nézet memoizálva: a főoldal egyéb állapotváltozásai (pl. teljes
   képernyős váltás) nem rajzolják újra a teljes filmkönyvtárat. */
export const MoviesView = React.memo(MoviesViewComponent);
