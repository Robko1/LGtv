import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Category, Series, Episode } from '../types/iptv';
import type { ProviderRef } from '../services/contentStore';
import { PosterImage, preloadPosterImage } from './PosterImage';
import { VodDetailSheet } from './VodDetailSheet';
import { Star, Sparkles, Filter, ChevronDown, Tv, Mic2, Clock } from 'lucide-react';
import { normalizeTvKey } from '../utils/tvKeys';
import { cardAudioLabel, formatRuntime, joinLanguages } from '../utils/vodDisplay';

interface SeriesViewProps {
  series: Series[];
  categories?: Category[];
  totalCount?: number;
  onPrefetchMetadata?: (items: Series[]) => void;
  onPlayEpisode: (series: Series, episode: Episode) => void;
  selectedCategoryId?: string;
  onSelectedCategoryChange?: (categoryId: string) => void;
  onBackToLive: () => void;
  onToggleFavoriteSeries: (seriesId: string) => void;
  isActive: boolean;
  activeProvider?: ProviderRef | null;
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
let seriesReturnSnapshot: { scrollTop: number; visibleCount: number } | null = null;

const SeriesViewComponent: React.FC<SeriesViewProps> = ({
  series,
  categories: providerCategories,
  totalCount,
  onPlayEpisode,
  onToggleFavoriteSeries,
  onPrefetchMetadata,
  selectedCategoryId: savedSelectedCategory = 'all',
  onSelectedCategoryChange,
  isActive,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>(savedSelectedCategory);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string>('');
  // A legfrissebb sorozatlista referenciában: a részletek-lekérő effekt
  // függőségei nem változhatnak meg a lista háttérfrissítéseitől.
  const seriesListRef = useRef<Series[]>(series);
  seriesListRef.current = series;
  const [visibleCount, setVisibleCount] = useState(() => seriesReturnSnapshot?.visibleCount ?? PAGE_SIZE);
  const seriesGridRef = useRef<HTMLDivElement | null>(null);
  // A kijelölt poszter teljes egészében látható maradjon a görgethető rácsban.
  const scrollPosterFullyIntoView = (card: HTMLElement | null) => {
    const grid = seriesGridRef.current;
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
  // A részletek-ablak fókusza – lásd MoviesView (a távirányítónak azonnal
  // egy gombon kell lennie, különben a dialógusban nem lehet mozogni).
  const detailDialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!selectedSeriesId) {
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true } as FocusOptions);
      return;
    }
    if (!previousFocusRef.current) previousFocusRef.current = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      const dialog = detailDialogRef.current;
      if (!dialog) return;

      const episodeList = dialog.querySelector<HTMLElement>('[data-episode-list]');

      dialog.querySelector<HTMLElement>('[data-dialog-scroll]')
        ?.scrollTo({ top: 0, behavior: 'auto' });

      episodeList?.scrollTo({ top: 0, behavior: 'auto' });

      const first = dialog.querySelector<HTMLElement>('[data-dialog-primary]')
        || dialog.querySelector<HTMLElement>('button:not(:disabled)');

      first?.focus({ preventScroll: true } as FocusOptions);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [selectedSeriesId]);

  const categories = [
    { id: 'all', name: 'Összes sorozat' },
    ...(providerCategories || [])
      .filter((cat) => cat.channelCount > 0)
      .map((cat) => ({ id: cat.id, name: `${cat.name} (${cat.channelCount})` })),
  ];

  // FONTOS (fagyás): a szűrés memoizálva van; korábban minden kirajzoláskor
  // lefutott a teljes listán (akár 15 000 sorozaton).
  // Keresőmező nélkül nincs végigszűrés az „Összes sorozat” nézetben.
  const filteredSeries = useMemo(
    () => (selectedCategory === 'all'
      ? series
      : series.filter((s) => s.categoryId === selectedCategory)),
    [series, selectedCategory],
  );

  useEffect(() => {
    if (!isActive || selectedSeriesId || !onPrefetchMetadata) return;
    const pending = filteredSeries.slice(0, visibleCount + PAGE_SIZE).filter((item) => !item.detailProviderData);
    if (!pending.length) return;
    const timer = window.setTimeout(() => onPrefetchMetadata(pending), 350);
    return () => window.clearTimeout(timer);
  }, [isActive, selectedSeriesId, filteredSeries, visibleCount, onPrefetchMetadata]);

  /*
   * Kategóriaváltáskor a lista elejére ugrunk. FONTOS: NEM figyeljük a
   * `series` tömböt! A sorozatok több részletben érkeznek, és ha itt
   * figyelnénk rájuk, minden háttérfrissítés visszadobná a felhasználót a
   * lista tetejére (pontosan ez volt a „ugráló” görgetés a TV-n).
   */
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    if (seriesGridRef.current) seriesGridRef.current.scrollTop = 0;
    preloadedThroughRef.current = 0;
  }, [selectedCategory]);

  useEffect(() => {
    const snapshot = seriesReturnSnapshot;
    if (!snapshot) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (seriesGridRef.current) seriesGridRef.current.scrollTop = snapshot.scrollTop;
        setVisibleCount(snapshot.visibleCount);
      });
    });
    seriesReturnSnapshot = null;
  }, []);

  /*
   * KILÉPÉSKOR VISSZA AZ ELEJÉRE – CSAK 25 KÁRTYA MARAD (2.5.228).
   *
   * A felhasználó kérése: a Sorozatok nézetből kilépve a rács kezdjen
   * elölről, és csak az első 25 poszter maradjon a DOM-ban, hogy a TV
   * memóriáját semmi ne terhelje. Kivétel az epizód elindítása: olyankor a
   * visszatéréshez megjegyzett pozíció (seriesReturnSnapshot) megmarad, és a
   * lejátszó bezárása után a néző ugyanott folytatja a böngészést.
   */
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (wasActiveRef.current && !isActive && !seriesReturnSnapshot) {
      setVisibleCount(PAGE_SIZE);
      if (seriesGridRef.current) seriesGridRef.current.scrollTop = 0;
      preloadedThroughRef.current = 0;
      setIsCategoryMenuOpen(false);
      setSelectedSeriesId('');
    }
    if (!wasActiveRef.current && isActive) {
      // Visszatérés lejátszásból: a pozíció él (a nézet a DOM-ban maradt),
      // a megjegyzett pillanatkép pedig elfogy, hogy a KÖVETKEZŐ kilépés
      // már tényleg az elejére állítson vissza.
      seriesReturnSnapshot = null;
    }
    wasActiveRef.current = isActive;
  }, [isActive]);

  const visibleSeries = useMemo(() => filteredSeries.slice(0, visibleCount), [filteredSeries, visibleCount]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const posters = visibleSeries.filter((item) => item.poster).slice(0, PAGE_SIZE);
    let cursor = 0;
    const worker = async () => {
      while (!cancelled && cursor < posters.length) {
        const item = posters[cursor++];
        await preloadPosterImage(item.poster, item.title, 'tv', true);
      }
    };
    const frame = window.requestAnimationFrame(() => { void worker(); void worker(); void worker(); });
    return () => { cancelled = true; window.cancelAnimationFrame(frame); };
  }, [isActive, visibleSeries]);


  // A kiválasztott sorozat mindig a legfrissebb adatból (a részek utólag
  // töltődnek be a szolgáltatótól).
  const selectedSeries = series.find((item) => item.id === selectedSeriesId) || null;

  return (
    /* Keresőmező és „Poszterek” gomb NÉLKÜL (kérés szerint) – csak a
       Kategóriák választó és a darabszám marad a nézet tetején. */
    <div className="flex-1 flex flex-col bg-[#070e1e] overflow-hidden select-none lg:select-auto" onKeyDown={(e) => { if (normalizeTvKey(e) === 'Escape' && isCategoryMenuOpen) { e.preventDefault(); e.stopPropagation(); setIsCategoryMenuOpen(false); } }}>
      {/* Top Bar */}
      <div className="p-3 md:p-4 lg:p-4 xl:p-5 bg-[#09152e] border-b border-cyan-950/60 flex flex-col gap-2.5 md:gap-3">
        <div className="relative flex items-center justify-end gap-2 min-h-[40px]">
          <button
            data-category-trigger="series"
            onKeyDown={(e) => { const key = normalizeTvKey(e); if (key === 'ArrowDown') { e.preventDefault(); if (!isCategoryMenuOpen) seriesGridRef.current?.querySelector<HTMLElement>('[data-poster-index="0"]')?.focus(); } else if (key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); document.querySelector<HTMLElement>('[data-tv-header-kind="series"]')?.focus(); } }}
            onClick={() => setIsCategoryMenuOpen((open) => !open)}
            aria-expanded={isCategoryMenuOpen}
            className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 rounded-xl bg-[#0f2042] hover:bg-[#162d5a] text-cyan-300 border border-cyan-500/30 text-base font-bold active:scale-95 transition-all"
          >
            <ChevronDown className="w-4 h-4" />
            <span>Kategóriák</span>
          </button>

          <div className="flex items-center gap-2 text-base font-black text-cyan-400">
            <Sparkles className="w-4 h-4 text-cyan-400" />
            <span>SOROZATOK KÖNYVTÁR ({totalCount && totalCount > series.length ? `${series.length} / ${totalCount}` : series.length})</span>
          </div>
        </div>

        {isCategoryMenuOpen && (
          <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto rounded-xl border border-cyan-500/30 bg-[#081329] p-2">
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
                    ? 'bg-cyan-400 text-slate-950 font-black'
                    : 'bg-[#0e1d3a] text-slate-300 border border-slate-700/60 hover:bg-[#142850]'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Függőleges sorozatposzter-rács, adagonként bővülő listával. */}
      <div ref={seriesGridRef} data-tv-navigation-owner="posters" data-scroll-keep="" onScroll={(e) => {
        const el = e.currentTarget;
        // Az utolsó adag 15. posztere (abszolút sorszám). Ha ez már látható,
        // jöhet a következő 25 – jóval azelőtt, hogy a lista vége érne.
        const trigger = Math.max(0, visibleCount - PAGE_SIZE) + (NEXT_BATCH_AT - 1);
        const triggerCard = el.querySelector<HTMLElement>(`[data-poster-index="${trigger}"]`);
        const reachedTrigger = !!triggerCard
          && triggerCard.getBoundingClientRect().top < el.getBoundingClientRect().bottom;
        if (reachedTrigger && visibleCount < filteredSeries.length) {
          setVisibleCount((count) => Math.min(count + PAGE_SIZE, filteredSeries.length));
        }
      }} onFocusCapture={(e) => {
        const target = e.target as HTMLElement;
        const card = target.closest<HTMLElement>('[data-poster-index]');
        const index = Number(card?.dataset.posterIndex);
        const focusTrigger = Math.max(0, visibleCount - PAGE_SIZE) + (NEXT_BATCH_AT - 1);
        if (Number.isFinite(index) && index >= focusTrigger && visibleCount < filteredSeries.length) {
          setVisibleCount((count) => Math.min(count + PAGE_SIZE, filteredSeries.length));
        }
      }} className="flex-1 overflow-y-auto px-3 pt-6 pb-6 md:px-4 md:pt-6 md:pb-6 lg:px-5 lg:pt-6 lg:pb-6 xl:px-6 xl:pt-6 xl:pb-6">
        {filteredSeries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-400">
            <Filter className="w-10 h-10 text-slate-600 mb-2" />
            {series.length === 0 ? (
              <><p className="text-sm font-semibold">A sorozatok betöltése folyamatban van…</p><p className="text-xs mt-1 max-w-xs leading-relaxed">A mentett sorozatlista megjelenik, amint a betöltés befejeződik.</p></>
            ) : <p className="text-sm font-semibold">Ebben a kategóriában nincs sorozat.</p>}
          </div>
        ) : (
          <div className="grid grid-cols-5 gap-3 md:gap-4 lg:gap-4 xl:gap-5">
            {visibleSeries.map((ser, index) => (
              <div key={ser.id} role="button" tabIndex={0}
                data-poster-index={index}
                data-vod-card={String(ser.id)}
                onClick={() => { setSelectedSeriesId(ser.id); }}
                onKeyDown={(e) => { const key = normalizeTvKey(e); if (key === 'Enter' || key === ' ') { e.preventDefault(); setSelectedSeriesId(ser.id); return; } if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
                  e.preventDefault();
                  e.stopPropagation();
                  const index = Number((e.currentTarget as HTMLElement).dataset.posterIndex);
                  const cards = Array.from(seriesGridRef.current?.querySelectorAll<HTMLElement>('[data-poster-index]') || []);
                  const columns = 5;
                  let target = index;
                  if (key === 'ArrowUp') target = index >= columns ? index - columns : -1;
                  if (key === 'ArrowDown') target = index + columns < cards.length ? index + columns : -1;
                  if (key === 'ArrowLeft') target = index > 0 ? index - 1 : -1;
                  if (key === 'ArrowRight') target = index + 1 < cards.length ? index + 1 : -1;
                  if (target >= 0 && target !== index) {
                    cards[target]?.focus({ preventScroll: true } as FocusOptions);
                    scrollPosterFullyIntoView(cards[target] || null);
                  } else if (key === 'ArrowDown' && index + columns >= cards.length && cards.length < filteredSeries.length) {
                    // A következő sor még nincs kirajzolva: bővítjük a listát, majd arra a poszterre fókuszálunk.
                    setVisibleCount((count) => Math.min(count + PAGE_SIZE, filteredSeries.length));
                    window.requestAnimationFrame(() => {
                      window.requestAnimationFrame(() => {
                        const nextPoster = seriesGridRef.current?.querySelector<HTMLElement>(`[data-poster-index="${index + columns}"]`);
                        nextPoster?.focus({ preventScroll: true } as FocusOptions);
                        scrollPosterFullyIntoView(nextPoster || null);
                      });
                    });
                  } else if (key === 'ArrowUp' && index < columns) {
                    seriesGridRef.current?.closest('[data-view-pane="series"]')?.querySelector<HTMLElement>('[data-category-trigger]')?.focus({ preventScroll: true } as FocusOptions);
                  }
                } }}
                className="group relative h-fit self-start bg-[#0b162f] rounded-2xl border border-cyan-950/70 overflow-hidden cursor-pointer hover:border-cyan-400/80 transition-all duration-200 shadow-lg flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                <div className="relative aspect-[2/3] w-full bg-slate-900 overflow-hidden">
                  <PosterImage src={ser.poster} title={ser.title} kind="tv" localOnly alt={ser.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/80 border border-amber-400/40 text-amber-300 font-black text-[11px] flex items-center gap-1"><Star className="w-3 h-3 fill-amber-400 text-amber-400" /><span>{ser.rating}</span></div>
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><div className="w-12 h-12 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center"><Tv className="w-5 h-5" /></div></div>
                </div>
                <div className="p-3">
                  <h3 className="text-white font-black text-lg sm:text-xl truncate">{ser.title}</h3>
                  {/* Év balra, játékidő jobbra – egyetlen vízszintes sorban. */}
                  <div className="mt-1 flex min-h-6 items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-base sm:text-lg font-bold text-amber-300">
                      {ser.year > 0 ? ser.year : ''}
                    </span>
                    {formatRuntime(ser.durationMinutes) && (
                      <span className="flex min-w-0 items-center justify-end gap-1 truncate text-sm sm:text-base font-bold text-cyan-200">
                        <Clock className="h-4 w-4 shrink-0" />
                        <span className="truncate">{formatRuntime(ser.durationMinutes)}</span>
                      </span>
                    )}
                  </div>
                  {/* Audió balra, jól olvasható feliratnyelvek jobbra – ugyanabban a sorban. */}
                  {/* 2.5.236: a magyar hang mindig elöl; ismert nyelv híján „Angol” a
                      legvalószínűbb alapértelmezés (a sor ezért mindig látszik) –
                      pontosan úgy, ahogy a Mozi kártyán. */}
                  <div className="mt-1 flex min-h-6 items-center justify-between gap-2 text-xs sm:text-sm font-semibold">
                    <span className="flex min-w-0 flex-1 items-center gap-1 text-rose-200">
                      <Mic2 className="h-4 w-4 shrink-0 text-rose-300" />
                      <span className="truncate">{cardAudioLabel(ser.audioLanguages)}</span>
                    </span>
                    <span className="min-w-0 flex-1 truncate text-right text-slate-100">
                      {joinLanguages(ser.subtitleLanguages) || '—'}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Series Season & Episode Detail Modal */}
      {selectedSeries && (
        <VodDetailSheet
          kind="series"
          item={selectedSeries}
          isFavorite={Boolean(selectedSeries.isFavorite)}
          onClose={() => setSelectedSeriesId('')}
          onToggleFavorite={() => onToggleFavoriteSeries(selectedSeries.id)}
          onPlayEpisode={(ser, ep) => {
            seriesReturnSnapshot = { scrollTop: seriesGridRef.current?.scrollTop ?? 0, visibleCount };
            setSelectedSeriesId('');
            onPlayEpisode(ser, ep);
          }}
        />
      )}
    </div>
  );
};

/* Memoizált nézet – a főoldal egyéb állapotváltozásai nem rajzolják újra. */
export const SeriesView = React.memo(SeriesViewComponent);
