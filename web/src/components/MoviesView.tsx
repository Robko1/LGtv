import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Category, Movie } from '../types/iptv';
import type { ProviderRef } from '../services/contentStore';
import { PosterImage, preloadPosterImage } from './PosterImage';
import { VodDetailSheet } from './VodDetailSheet';
import { Filter, ChevronDown, Clock } from 'lucide-react';
import { normalizeTvKey } from '../utils/tvKeys';
import { formatRuntime, sortByReleaseYearDesc } from '../utils/vodDisplay';
import { flagFor } from '../utils/flags';
import { yearFromTitle } from '../services/catalogRows';

interface MoviesViewProps {
  movies: Movie[];
  categories?: Category[];
  totalCount?: number;
  /** A TV saját tartós tárában elmentett filmek száma – a Sorozatok fejlécével azonos kijelzéshez. */
  savedCount?: number;
  /** 0-100% – helyi tárból történő visszatöltés folyamata (csak Mozi nézethez, kék kör) */
  restoreProgress?: number;
  restoreLoadedCount?: number;
  restoreTotalCount?: number;
  onPlayMovie: (movie: Movie) => void;
  selectedCategoryId?: string;
  onSelectedCategoryChange?: (categoryId: string) => void;
  onBackToLive: () => void;
  onToggleFavoriteMovie: (movieId: string) => void;
  /** 2.5.298: a poszter piros kukájával törölt film eltávolítása a memóriából. */
  onDeleteMovie?: (movieId: string) => void;
  isActive: boolean;
  activeProvider?: ProviderRef | null;
  /* 2.5.249: az adatlap megnyitásakor dúsított film visszaadása a listához. */
  onVodItemEnriched?: (item: Movie) => void;
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
  savedCount = 0,
  restoreProgress = 0,
  restoreLoadedCount = 0,
  restoreTotalCount = 0,
  onPlayMovie,
  selectedCategoryId: savedSelectedCategory = 'all',
  onSelectedCategoryChange,
  isActive,
  onToggleFavoriteMovie,
  onDeleteMovie,
  activeProvider,
  onVodItemEnriched,
}) => {
  void totalCount;
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

  // HU kategóriák elöl, a többi alatt; a filmrács ugyanazt a besorolást használja.
  const sortedProviderCats = (providerCategories || [])
    .filter((cat) => cat.channelCount > 0)
    .sort((a, b) => {
      const aHu = flagFor(a.name).countryCode === 'HU';
      const bHu = flagFor(b.name).countryCode === 'HU';
      if (aHu && !bHu) return -1;
      if (!aHu && bHu) return 1;
      return a.name.localeCompare(b.name, 'hu');
    });
  const categoryNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const category of providerCategories || []) names.set(category.id, category.name);
    return names;
  }, [providerCategories]);
  const categories = [
    { id: 'all', name: 'Összes film' },
    ...sortedProviderCats.map((cat) => ({ id: cat.id, name: `${cat.name} (${cat.channelCount})` })),
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
  /*
   * 2.5.298 – KIADÁSI ÉV SZERINT, A LEGFRISSEBB ELÖL.
   *
   * A rendezés a szűrés ELŐTT, egyszer fut (a teljes listán), és az
   * eredmény a `movies` tömb azonosságához kötött – így a rácsozás,
   * a lapozás és a kategóriaváltás ugyanezt a sorrendet látja.
   */
  // 2.5.318: Mozi — pontosan mint a Sorozatoknál: év szerint csökkenő, stabil sorrend.
  // A korábbi másodlagos streamId rendezés eltérítette a poszterek sorrendjét a Sorozatokétól,
  // ezért most egy az egyben a sorozat-logikát használjuk (sortByReleaseYearDesc), hogy a
  // visszatöltéskor a poszterek ugyanúgy, ugyanabban az ütemben jelenjenek meg.
  const yearSortedMovies = useMemo(() => sortByReleaseYearDesc(movies), [movies]);
  // A teljes katalógus első oldalán a magyar poszterek jelenjenek meg először,
  // ne csak a kategórialistában legyen elöl a HU. A két csoporton belül megmarad
  // a meglévő legújabb-éves rendezés és az eredeti stabil sorrend.
  const hungaryFirstMovies = useMemo(() => {
    const hungarian: Movie[] = [];
    const other: Movie[] = [];
    for (const movie of yearSortedMovies) {
      const categoryName = categoryNameById.get(movie.categoryId) || movie.categoryName || '';
      (flagFor(categoryName).countryCode === 'HU' ? hungarian : other).push(movie);
    }
    return hungarian.length ? hungarian.concat(other) : yearSortedMovies;
  }, [yearSortedMovies, categoryNameById]);
  const filteredMovies = useMemo(
    () => (selectedCategory === 'all'
      ? hungaryFirstMovies
      : yearSortedMovies.filter((m) => m.categoryId === selectedCategory)),
    [hungaryFirstMovies, yearSortedMovies, selectedCategory],
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

  /*
   * KILÉPÉSKOR VISSZA AZ ELEJÉRE – CSAK 25 KÁRTYA MARAD (2.5.228).
   *
   * A felhasználó kérése: a Mozi nézetből kilépve a rács kezdjen elölről,
   * és csak az első 25 poszter maradjon a DOM-ban, hogy a TV memóriáját
   * semmi ne terhelje. Kivétel a film elindítása: olyankor a visszatéréshez
   * megjegyzett pozíció (movieReturnSnapshot) megmarad, és a lejátszó
   * bezárása után a néző ugyanott folytatja a böngészést.
   */
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (wasActiveRef.current && !isActive && !movieReturnSnapshot) {
      setVisibleCount(PAGE_SIZE);
      if (movieGridRef.current) movieGridRef.current.scrollTop = 0;
      preloadedThroughRef.current = 0;
      setIsCategoryMenuOpen(false);
      setSelectedMovieId(null);
    }
    if (!wasActiveRef.current && isActive) {
      // Visszatérés lejátszásból: a pozíció él (a nézet a DOM-ban maradt),
      // a megjegyzett pillanatkép pedig elfogy, hogy a KÖVETKEZŐ kilépés
      // már tényleg az elejére állítson vissza.
      movieReturnSnapshot = null;
    }
    wasActiveRef.current = isActive;
  }, [isActive]);

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
      {/* Top Bar: Kategóriák + darabszám — 2.5.318: kör teteje = doboz teteje, kör alja = doboz alja. Az outer py-1 (4px) + box h-80/96 = kör, nincs extra 24px mint a korábbi p-3 + min-h. */}
      <div className="px-3 py-1 md:px-4 md:py-1 bg-[#09152e] border-b border-cyan-950/60 flex flex-col gap-1.5">
        <div className="flex items-center justify-center gap-2 md:gap-3">
          <button
            data-category-trigger="movies"
            onKeyDown={(e) => { const key = normalizeTvKey(e); if (key === 'ArrowDown') { e.preventDefault(); if (!isCategoryMenuOpen) movieGridRef.current?.querySelector<HTMLElement>('[data-poster-index="0"]')?.focus(); } else if (key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); document.querySelector<HTMLElement>('[data-tv-header-kind="movies"]')?.focus(); } }}
            onClick={() => setIsCategoryMenuOpen((open) => !open)}
            aria-expanded={isCategoryMenuOpen}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#0f2042] hover:bg-[#162d5a] text-amber-300 border border-amber-500/30 text-base font-bold active:scale-95 transition-all shrink-0"
          >
            <ChevronDown className="w-4 h-4" />
            <span>Kategóriák</span>
          </button>

          <div className="flex items-center gap-2 md:gap-3 rounded-xl border border-cyan-800/50 bg-[#0f2042]/60 px-2 md:px-3 h-[80px] md:h-[96px] shrink-0" data-vod-count="movies">
            {/* 3D KÖR – FILMEK (kék) – 0-100% a helyi tárból, csak Mozihoz – 2.5.311: NAGYOBB, TV-n jól látható, doboz a kör tetejétől az aljáig */}
            <div className="relative w-20 h-20 md:w-24 md:h-24 shrink-0 -ml-1">
              <svg width="96" height="96" viewBox="0 0 56 56" className="w-20 h-20 md:w-24 md:h-24 -rotate-90 drop-shadow-[0_5px_14px_rgba(37,99,235,0.55)]">
                <defs>
                  <linearGradient id="gradMovies" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#60a5fa" />
                    <stop offset="50%" stopColor="#3b82f6" />
                    <stop offset="100%" stopColor="#1d4ed8" />
                  </linearGradient>
                  <radialGradient id="innerMovies" cx="50%" cy="40%" r="55%">
                    <stop offset="0%" stopColor="#1e3a5f" />
                    <stop offset="65%" stopColor="#0f1a2e" />
                    <stop offset="100%" stopColor="#070e1e" />
                  </radialGradient>
                  <filter id="shadowMovies" x="-50%" y="-50%" width="200%" height="200%">
                    <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#1e40af" floodOpacity="0.55" />
                  </filter>
                </defs>
                {/* háttér pálya – 3D perem */}
                <circle cx="28" cy="28" r="22" fill="none" stroke="#0f172a" strokeWidth="6" />
                <circle cx="28" cy="28" r="22" fill="none" stroke="#1e293b" strokeWidth="6" opacity="0.9" />
                {/* haladás – kék, 3D fény */}
                <circle
                  cx="28"
                  cy="28"
                  r="22"
                  fill="none"
                  stroke="url(#gradMovies)"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={138.23}
                  strokeDashoffset={138.23 * (1 - Math.min(100, Math.max(0, restoreProgress)) / 100)}
                  filter="url(#shadowMovies)"
                  style={{ transition: 'stroke-dashoffset 0.45s ease' }}
                />
                {/* belső 3D mag */}
                <circle cx="28" cy="28" r="15" fill="url(#innerMovies)" stroke="#1e3a5f" strokeWidth="1.2" />
                <ellipse cx="28" cy="19.5" rx="9" ry="3.2" fill="white" opacity="0.09" />
                <ellipse cx="28" cy="21" rx="6" ry="1.8" fill="white" opacity="0.06" />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-[16px] md:text-[18px] font-black tracking-wide text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
                {Math.min(100, Math.max(0, Math.round(restoreProgress)))}%
              </span>
            </div>
            <div className="flex flex-col items-start justify-center leading-tight min-w-[140px] md:min-w-[168px] py-0.5">
              <span className="text-xs md:text-sm font-bold tracking-[0.14em] text-sky-300/90">FILMEK</span>
              <span className="text-sm md:text-base lg:text-lg font-black text-white">
                {restoreProgress > 0 && restoreProgress < 100
                  ? `${restoreLoadedCount.toLocaleString('hu-HU')} / ${(restoreTotalCount || savedCount).toLocaleString('hu-HU')} betöltve`
                  : restoreProgress >= 100
                    ? `${(restoreLoadedCount || movies.length).toLocaleString('hu-HU')} betöltve`
                    : movies.length > 0 ? `${movies.length.toLocaleString('hu-HU')} betöltve` : 'Betöltésre kész'}
              </span>
              <span className="text-xs md:text-sm font-bold text-sky-200">
                {(restoreTotalCount || savedCount) > 0 ? `${(restoreTotalCount || savedCount).toLocaleString('hu-HU')} a tárolóban` : '0 film a tárolóban'}
              </span>
            </div>
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
                onKeyDown={(e) => {
                  // 2.5.298: a poszter kukájának billentyűit a kuka maga kezeli.
                  if ((e.target as HTMLElement)?.closest?.('[data-vod-delete]')) return;
                  const key = normalizeTvKey(e); if (key === 'Enter' || key === ' ') { e.preventDefault(); setSelectedMovieId(mov.id); return; } if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
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
                  {/* 2.5.245: a listán KIZÁRÓLAG a poszter látszik (csillag/értékelés nélkül). */}
                  <PosterImage src={mov.poster} title={mov.title} kind="movie" localOnly alt={mov.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  {/*
                    * 2.5.298 – PIROS KUKA A POSZTER JOBB FELSŐ SARKÁBAN.
                    *
                    * A felhasználó kérése: minden mozis poszteren legyen egy
                    * piros kuka ikon, amivel a film a TV memóriájából törölhető.
                    * A kattintás NEM nyitja meg az adatlapot (stopPropagation),
                    * a fókuszált kukán az OK gomb (Enter) is töröl.
                    */}
</div>
                <div className="p-3">
                  <h3 className="text-white font-black text-lg sm:text-xl truncate">{mov.title}</h3>
                  {/* 2.5.227: a filmkártya PONTOSAN a sorozatkártya elrendezését követi.
                      Év balra, játékidő jobbra – egyetlen vízszintes sorban. */}
                  <div className="mt-1 flex min-h-6 items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-base sm:text-lg font-bold text-amber-300">
                      {/* 2.5.255 (#7): év akkor is látszik, ha csak a címből olvasható ki. */}
                      {mov.year > 0 ? mov.year : yearFromTitle(mov.title) || ''}
                    </span>
                    {formatRuntime(mov.durationMinutes) && (
                      <span className="flex min-w-0 items-center justify-end gap-1 truncate text-sm sm:text-base font-bold text-cyan-200">
                        <Clock className="h-4 w-4 shrink-0" />
                        <span className="truncate">{formatRuntime(mov.durationMinutes)}</span>
                      </span>
                    )}
                  </div>
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
          dialogRef={detailDialogRef}
          isFavorite={Boolean(selectedMovie.isFavorite)}
          onClose={() => setSelectedMovieId(null)}
          onToggleFavorite={() => onToggleFavoriteMovie(selectedMovie.id)}
          onDelete={onDeleteMovie ? () => { const id = selectedMovie.id; setSelectedMovieId(null); onDeleteMovie(id); } : undefined}
          provider={activeProvider ?? null}
          onItemEnriched={(enriched) => onVodItemEnriched?.(enriched as Movie)}
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
