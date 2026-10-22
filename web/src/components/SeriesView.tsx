import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Category, Series, Episode } from '../types/iptv';
import { PosterImage } from './PosterImage';
import { Star, Play, Clock, Sparkles, Filter, ChevronDown, Tv, CheckCircle2, Loader2 } from 'lucide-react';
import { normalizeTvKey } from '../utils/tvKeys';

interface SeriesViewProps {
  series: Series[];
  categories?: Category[];
  totalCount?: number;
  loadingSeriesId?: string;
  onOpenSeries?: (series: Series) => void;
  onPlayEpisode: (series: Series, episode: Episode) => void;
  selectedCategoryId?: string;
  onSelectedCategoryChange?: (categoryId: string) => void;
  onBackToLive: () => void;
  onToggleFavoriteSeries: (seriesId: string) => void;
}

/* Villámgyors nézetváltás: 5 NAGY poszter, kisebb első köteg, lépcsős
   kategóriapolcok (lásd MoviesView, ugyanaz az elv). */
const PAGE_SIZE = 50;
const RAIL_STEP = 5;
const RAIL_CARDS = 12;
let seriesReturnSnapshot: { scrollTop: number; visibleCount: number } | null = null;

const SeriesViewComponent: React.FC<SeriesViewProps> = ({
  series,
  categories: providerCategories,
  totalCount,
  loadingSeriesId,
  onOpenSeries,
  onPlayEpisode,
  selectedCategoryId: savedSelectedCategory = 'all',
  onSelectedCategoryChange,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>(savedSelectedCategory);
  const [visibleRails, setVisibleRails] = useState<number>(RAIL_STEP);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string>('');
  const [selectedSeasonNumber, setSelectedSeasonNumber] = useState<number>(1);
  const [visibleCount, setVisibleCount] = useState(() => seriesReturnSnapshot?.visibleCount ?? PAGE_SIZE);
  const seriesGridRef = useRef<HTMLDivElement | null>(null);
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
      const first = detailDialogRef.current?.querySelector<HTMLElement>('[data-dialog-primary]')
        || detailDialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)');
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

  /*
   * Kategóriaváltáskor a lista elejére ugrunk. FONTOS: NEM figyeljük a
   * `series` tömböt! A sorozatok több részletben érkeznek, és ha itt
   * figyelnénk rájuk, minden háttérfrissítés visszadobná a felhasználót a
   * lista tetejére (pontosan ez volt a „ugráló” görgetés a TV-n).
   */
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setVisibleRails(RAIL_STEP);
    if (seriesGridRef.current) seriesGridRef.current.scrollTop = 0;
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

  const visibleSeries = filteredSeries.slice(0, visibleCount);

  // Referencia-szerű kategóriapolcok: a kategóriák sorrendjét a szolgáltató adja,
  // a címek eredeti sorrendjét megőrizzük; minden kategóriához egyetlen csoportosítás.
  const categoryRows = useMemo(() => {
    const grouped = new Map<string, Series[]>();
    for (const item of series) {
      const key = item.categoryId || 'uncategorized';
      const list = grouped.get(key);
      if (list) list.push(item); else grouped.set(key, [item]);
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
  }, [series, providerCategories]);

  // A kiválasztott sorozat mindig a legfrissebb adatból (a részek utólag
  // töltődnek be a szolgáltatótól).
  const selectedSeries = series.find((item) => item.id === selectedSeriesId) || null;
  const isLoadingEpisodes = !!selectedSeries && loadingSeriesId === selectedSeries.id;

  const activeSeason = selectedSeries?.seasons.find(
    (sn) => sn.seasonNumber === selectedSeasonNumber
  ) || selectedSeries?.seasons[0];

  return (
    /* Keresőmező és „Poszterek” gomb NÉLKÜL (kérés szerint) – csak a
       Kategóriák választó és a darabszám marad a nézet tetején. */
    <div className="flex-1 flex flex-col bg-[#070e1e] overflow-hidden select-none lg:select-auto" onKeyDown={(e) => { if (normalizeTvKey(e) === 'Escape' && isCategoryMenuOpen) { e.preventDefault(); e.stopPropagation(); setIsCategoryMenuOpen(false); } }}>
      {/* Top Bar */}
      <div className="p-3 md:p-4 lg:p-4 xl:p-5 bg-[#09152e] border-b border-cyan-950/60 flex flex-col gap-2.5 md:gap-3">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setIsCategoryMenuOpen((open) => !open)}
            aria-expanded={isCategoryMenuOpen}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#0f2042] hover:bg-[#162d5a] text-cyan-300 border border-cyan-500/30 text-xs font-bold active:scale-95 transition-all"
          >
            <ChevronDown className="w-4 h-4" />
            <span>Kategóriák</span>
          </button>

          <div className="flex items-center gap-1.5 text-xs font-black text-cyan-400">
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
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-all ${
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

      {/* Referencia-szerű sorozatkönyvtár: vízszintes kategóriapolcok és teljes kategóriarács. */}
      <div ref={seriesGridRef} data-scroll-keep="" onScroll={(e) => {
        const el = e.currentTarget;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 900;
        if (!nearBottom) return;
        if (selectedCategory !== 'all' && visibleCount < filteredSeries.length) {
          setVisibleCount((count) => Math.min(count + PAGE_SIZE, filteredSeries.length));
        }
        setVisibleRails((count) => (count < categoryRows.length ? count + RAIL_STEP : count));
      }} className="flex-1 overflow-y-auto p-3 md:p-4 lg:p-5 xl:p-6">
        {selectedCategory === 'all' ? (
          categoryRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-slate-400">
              <Filter className="w-10 h-10 text-slate-600 mb-2" />
              {series.length === 0 ? (
                <><p className="text-sm font-semibold">A sorozatok betöltése folyamatban van…</p><p className="text-xs mt-1 max-w-xs leading-relaxed">A mentett sorozatlista megjelenik, amint a betöltés befejeződik.</p></>
              ) : <p className="text-sm font-semibold">Nincs megjeleníthető sorozatkategória.</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-6 md:gap-8">
              {categoryRows.slice(0, visibleRails).map(({ category, items }) => (
                <section key={category.id} className="min-w-0">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <h2 className="text-sm md:text-base font-black text-white truncate">{category.name}</h2>
                    <button onClick={() => { setSelectedCategory(category.id); onSelectedCategoryChange?.(category.id); if (seriesGridRef.current) seriesGridRef.current.scrollTop = 0; }}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-[#0f2042] border border-cyan-900/60 text-cyan-300 text-xs font-bold hover:bg-[#162d5a]">
                      Összes megtekintése ({items.length}) →
                    </button>
                  </div>
                  {/* 5 NAGY poszter egy sorban, vízszintes görgetéssel. */}
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {items.slice(0, RAIL_CARDS).map((ser) => (
                      <button key={ser.id} onClick={() => { setSelectedSeriesId(ser.id); setSelectedSeasonNumber(ser.seasons[0]?.seasonNumber || 1); onOpenSeries?.(ser); }}
                        className="group shrink-0 w-[calc((100%-3rem)/5)] min-w-[8rem] text-left rounded-2xl overflow-hidden bg-[#0b162f] border border-cyan-950/70 hover:border-cyan-400/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                        <div className="relative aspect-[2/3] bg-slate-900 overflow-hidden">
                          <PosterImage src={ser.poster} title={ser.title} kind="tv" alt={ser.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                        </div>
                        <div className="p-2"><div className="text-white text-sm font-bold truncate">{ser.title}</div><div className="text-xs text-slate-400 mt-1">{ser.year || ''}</div></div>
                      </button>
                    ))}
                    {items.length > RAIL_CARDS && (
                      <button onClick={() => { setSelectedCategory(category.id); onSelectedCategoryChange?.(category.id); if (seriesGridRef.current) seriesGridRef.current.scrollTop = 0; }}
                        className="shrink-0 w-[calc((100%-3rem)/5)] min-w-[8rem] rounded-2xl border border-dashed border-cyan-700/60 bg-[#0d1d3d] text-cyan-300 font-black text-sm hover:bg-[#142850]">
                        <span className="block text-2xl mb-2">•••</span>Mind a {items.length} sorozat
                      </button>
                    )}
                  </div>
                </section>
              ))}
            </div>
          )
        ) : filteredSeries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-400">
            <Filter className="w-10 h-10 text-slate-600 mb-2" />
            {series.length === 0 ? (
              <><p className="text-sm font-semibold">A sorozatok betöltése folyamatban van…</p><p className="text-xs mt-1 max-w-xs leading-relaxed">A mentett sorozatlista megjelenik, amint a betöltés befejeződik.</p></>
            ) : <p className="text-sm font-semibold">Ebben a kategóriában nincs sorozat.</p>}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-5 gap-3 md:gap-4 lg:gap-4 xl:gap-5">
            {visibleSeries.map((ser) => (
              <div key={ser.id} role="button" tabIndex={0}
                onClick={() => { setSelectedSeriesId(ser.id); setSelectedSeasonNumber(ser.seasons[0]?.seasonNumber || 1); onOpenSeries?.(ser); }}
                onKeyDown={(e) => { const key = normalizeTvKey(e); if (key === 'Enter' || key === ' ') { e.preventDefault(); setSelectedSeriesId(ser.id); setSelectedSeasonNumber(ser.seasons[0]?.seasonNumber || 1); onOpenSeries?.(ser); } }}
                className="group relative bg-[#0b162f] rounded-2xl border border-cyan-950/70 overflow-hidden cursor-pointer hover:border-cyan-400/80 transition-all duration-200 shadow-lg flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                <div className="relative aspect-[2/3] w-full bg-slate-900 overflow-hidden">
                  <PosterImage src={ser.poster} title={ser.title} kind="tv" alt={ser.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/80 border border-amber-400/40 text-amber-300 font-black text-[11px] flex items-center gap-1"><Star className="w-3 h-3 fill-amber-400 text-amber-400" /><span>{ser.rating}</span></div>
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><div className="w-12 h-12 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center"><Tv className="w-5 h-5" /></div></div>
                </div>
                <div className="p-2.5 flex-1"><h3 className="text-white font-bold text-xs truncate">{ser.title}</h3><div className="flex items-center gap-1.5 mt-1 text-[11px] text-slate-400"><span>{ser.year}</span><span>•</span><span>{ser.seasonsCount || ser.seasons.length} évad</span></div></div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Series Season & Episode Detail Modal */}
      {selectedSeries && (
        <div ref={detailDialogRef} role="dialog" aria-modal="true" aria-label="Sorozat részletei" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setSelectedSeriesId(''); } }} className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-4 lg:p-6 bg-black/85 backdrop-blur-sm animate-fadeIn select-none lg:select-auto">
          <div className="bg-[#09152e] border border-cyan-800/60 rounded-3xl max-w-2xl md:max-w-3xl lg:max-w-4xl xl:max-w-5xl w-full max-h-[92dvh] lg:max-h-[85vh] overflow-y-auto shadow-2xl animate-scaleUp flex flex-col">
            {/* Header */}
            <div className="relative h-44 w-full bg-slate-900 overflow-hidden shrink-0">
              <img
                src={selectedSeries.backdrop || selectedSeries.poster}
                alt={selectedSeries.title}
                className="w-full h-full object-cover opacity-60"
              />
              <div className="absolute inset-0 bg-linear-to-t from-[#09152e] via-transparent to-black/60" />

              <button
                onClick={() => setSelectedSeriesId('')}
                className="absolute top-3 right-3 p-2 rounded-full bg-black/60 text-white hover:bg-black/80 active:scale-90 transition-all z-10"
              >
                ✕
              </button>

              <div className="absolute bottom-3 left-4 right-4 flex items-end gap-3">
                <img
                  src={selectedSeries.poster}
                  alt={selectedSeries.title}
                  className="w-16 h-24 object-cover rounded-xl border-2 border-cyan-400 shadow-xl shrink-0"
                />
                <div className="min-w-0">
                  <h2 className="text-white font-black text-base sm:text-lg leading-tight truncate">
                    {selectedSeries.title}
                  </h2>
                  <div className="flex items-center gap-2 mt-1 text-xs text-slate-300">
                    <span className="font-bold text-amber-400">★ {selectedSeries.rating}</span>
                    <span>•</span>
                    <span>{selectedSeries.year}</span>
                    <span>•</span>
                    <span>{selectedSeries.seasonsCount} Évad</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Body */}
            <div className="p-4 space-y-4 flex-1">
              {/* Plot */}
              <p className="text-xs text-slate-300 leading-relaxed">
                {selectedSeries.plot}
              </p>

              {/* Részek betöltése a szolgáltatótól */}
              {selectedSeries.seasons.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-center border border-cyan-950 rounded-2xl bg-[#0b162f]">
                  {isLoadingEpisodes ? (
                    <>
                      <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
                      <p className="text-xs text-slate-300 font-semibold">Évadok és részek letöltése…</p>
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-slate-300 font-semibold">Ehhez a sorozathoz nincs betöltött rész.</p>
                      {onOpenSeries && (
                        <button
                          onClick={() => onOpenSeries(selectedSeries)}
                          className="px-3 py-1.5 rounded-xl bg-cyan-400 text-slate-950 text-xs font-black active:scale-95 transition-all"
                        >
                          Részek betöltése
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Seasons Selector Tab */}
              <div className="flex items-center justify-between border-b border-cyan-950 pb-2">
                <h4 className="text-xs font-black text-cyan-400 uppercase tracking-wider">
                  Évadok Választása:
                </h4>
                <div className="flex items-center gap-1.5 overflow-x-auto">
                  {selectedSeries.seasons.map((sn) => (
                    <button
                      key={sn.seasonNumber}
                      onClick={() => setSelectedSeasonNumber(sn.seasonNumber)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-black transition-all ${
                        activeSeason?.seasonNumber === sn.seasonNumber
                          ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                          : 'bg-[#0e1d3b] text-slate-300 border border-slate-700/60 hover:bg-[#142850]'
                      }`}
                    >
                      {sn.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Episodes List */}
              <div className="space-y-2">
                <h5 className="text-xs font-bold text-slate-400">
                  {activeSeason?.name} ({activeSeason?.episodes.length} epizód)
                </h5>

                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {activeSeason?.episodes.map((ep, epIndex) => (
                    <div
                      key={ep.id}
                      /*
                       * AZ EPIZÓDSOR FÓKUSZÁLHATÓ. Korábban csak onClick volt
                       * rajta: a távirányítóval (D-pad + OK) egyetlen epizódot
                       * sem lehetett elindítani, mert a sor nem volt a
                       * fókuszálható elemek között.
                       */
                      role="button"
                      tabIndex={0}
                      data-dialog-primary={epIndex === 0 ? '' : undefined}
                      onKeyDown={(e) => {
                        const key = normalizeTvKey(e);
                        if (key === 'Enter' || key === ' ') {
                          e.preventDefault();
                          (e.currentTarget as HTMLElement).click();
                        }
                      }}
                      onClick={() => {
                        const ser = selectedSeries;
                        seriesReturnSnapshot = {
                          scrollTop: seriesGridRef.current?.scrollTop ?? 0,
                    visibleCount,
                              };
                        setSelectedSeriesId('');
                        onPlayEpisode(ser, ep);
                      }}
                      className="group flex items-center justify-between p-2.5 rounded-2xl bg-[#0b162f] hover:bg-[#112347] border border-cyan-900/40 cursor-pointer transition-all active:scale-[0.99]"
                    >
                      {/* Left: Thumbnail & Episode info */}
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="relative w-20 h-14 rounded-xl bg-slate-800 overflow-hidden shrink-0 border border-slate-700">
                          <img
                            src={ep.thumbnail}
                            alt={ep.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                          />
                          <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <Play className="w-5 h-5 fill-cyan-400 text-cyan-400" />
                          </div>
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h6 className="text-white font-bold text-xs truncate group-hover:text-cyan-300">
                              {ep.title}
                            </h6>
                            {ep.watched && (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400 line-clamp-1 mt-0.5">
                            {ep.plot}
                          </p>
                          <div className="flex items-center gap-1.5 mt-1 text-[10px] text-slate-500 font-medium">
                            <Clock className="w-3 h-3 text-cyan-400" />
                            <span>{ep.durationMinutes} perc</span>
                            <span>•</span>
                            <span className="text-rose-300 font-bold">Magyar Szinkron</span>
                          </div>
                        </div>
                      </div>

                      {/* Right: Play pill */}
                      <button tabIndex={-1} aria-hidden="true" className="shrink-0 p-2 rounded-xl bg-cyan-400/20 text-cyan-300 border border-cyan-500/40 group-hover:bg-cyan-400 group-hover:text-slate-950 transition-all ml-2">
                        <Play className="w-4 h-4 fill-current ml-0.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* Memoizált nézet – a főoldal egyéb állapotváltozásai nem rajzolják újra. */
export const SeriesView = React.memo(SeriesViewComponent);
