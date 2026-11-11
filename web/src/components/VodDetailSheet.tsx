import React, { useEffect, useState } from 'react';
import { Clock, Play, Trash2, X } from 'lucide-react';
import { Episode, Movie, Series } from '../types/iptv';
import type { ProviderRef } from '../services/contentStore';
import { enrichVodItemOnOpen } from '../services/vodEnrich';
import { useTvModalNavigation } from '../hooks/useTvModalNavigation';
import { formatRuntime } from '../utils/vodDisplay';
import { normalizeTvKey } from '../utils/tvKeys';
import { yearFromTitle } from '../services/catalogRows';
import { PosterImage } from './PosterImage';

type VodItem = Movie | Series;

interface Props {
  kind: 'movie' | 'series';
  item: VodItem;
  isFavorite: boolean;
  onClose: () => void;
  onToggleFavorite: () => void;
  /**
   * 2.5.298: törlés a TV memóriájából. A poszter jobb felső sarkában lévő
   * piros kuka mellett itt is elérhető, mert az adatlap távirányítóval
   * biztosan bejárható (a kuka a rácson nem mindig érhető el nyilakkal).
   */
  onDelete?: () => void;
  onPlayMovie?: (movie: Movie) => void;
  onPlayEpisode?: (series: Series, episode: Episode) => void;
  /*
   * 2.5.249: ha az elemnél hiányzik az év/játékidő (vagy sorozatnál az
   * évadlista), megnyitáskor EGYETLEN részletes kérés megy ki, és az eredmény
   * itt helyben és a listában is megjelenik (év + játékidő a fejlécben).
   */
  provider?: ProviderRef | null;
  onItemEnriched?: (item: VodItem) => void;
  /*
   * 2.5.255 (#7): a hívó (Mozi/Sorozat nézet) ide adja a saját ref-jét, hogy
   * megnyitáskor a fókusz rögtön a kék LEJÁTSZÁS (data-dialog-primary) gombra
   * kerüljön, ne a bezáró X-en maradjon.
   */
  dialogRef?: React.Ref<HTMLDivElement>;
}

/**
 * 2.5.245 – VOD adatlap új elrendezése (felhasználói kérés):
 *
 *  - A háttérkép kitölti a TELJES adatlap-felületet, nagyban.
 *  - Bal oldalon kisebb poszter.
 *  - Jobb oldalon CSAK: cím, kiadási év, játékidő, és filmnél egy nagy,
 *    vízszintes, kék LEJÁTSZÁS gomb. Más adat (értékelés, leírás, szereplők,
 *    kedvenc, nyers szolgáltatói mezők) NEM jelenik meg.
 *  - Sorozatnál ugyanez a fejléc, alatta az évadok és az epizódok külön
 *    dobozokban, görgethetően és távirányítóval választhatóan; mindig a
 *    kiválasztott évad epizódjai látszanak. Az epizód dobozában: epizód címe,
 *    évad- és epizódszám, jobb oldalt nagy kék LEJÁTSZÁS gomb.
 *
 *  Az adatlap alapból KIZÁRÓLAG a már elmentett (IndexedDB) adatokból épül
 *  fel – megnyitása nem indít szolgáltatói kérést.
 *  2.5.249 KIVÉTEL: ha az elemnél az év ÉS a játékidő is hiányzik (vagy
 *  sorozatnál üres az évadlista), egyetlen get_vod_info/get_series_info kérés
 *  pótolja őket (lásd enrichVodItemOnOpen); teljes adatoknál továbbra sincs
 *  kérés, és az eredmény tartósan elmentődik.
 */
export const VodDetailSheet: React.FC<Props> = ({ kind, item: itemProp, onClose, onPlayMovie, onPlayEpisode, provider, onItemEnriched, dialogRef, onDelete }) => {
  const { modalRef: panelRef, handleKeyDown, handleBackdropClick } = useTvModalNavigation(true, onClose, [itemProp.id]);
  /* 2.5.255: a belső és a külső (hívó) ref egyszerre töltődik. */
  const setPanelRef = (el: HTMLDivElement | null) => {
    (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (!dialogRef) return;
    if (typeof dialogRef === "function") dialogRef(el);
    else (dialogRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  };
  /*
   * 2.5.249: megnyitáskori dúsítás – a „item” változó a dúsított elemet is
   * láthatja, így a fejlécben (év, játékidő) és a háttérképen azonnal megjelenik.
   */
  const [enrichedItem, setEnrichedItem] = useState<VodItem | null>(null);
  const item = (enrichedItem || itemProp) as VodItem;
  const [seasonNumber, setSeasonNumber] = useState<number>(() => (itemProp as Series).seasons?.[0]?.seasonNumber || 1);
  useEffect(() => {
    setEnrichedItem(null);
    if (!provider || provider.type !== 'xtream') return;
    // Csak valódi hiánynál kérdezünk le – teljes adatoknál nincs kérés.
    const missingMeta = itemProp.year === 0 && (itemProp.durationMinutes ?? 0) === 0 && !itemProp.detailProviderData;
    const missingSeasons = kind === 'series' && (itemProp as Series).seasons.length === 0;
    if (!missingMeta && !missingSeasons) return;
    let cancelled = false;
    void enrichVodItemOnOpen(kind, itemProp, provider)
      .then((enriched) => {
        if (cancelled || !enriched) return;
        setEnrichedItem(enriched);
        onItemEnriched?.(enriched);
      })
      .catch(() => { /* a naplóban már ott az ok; az adatlap nyitva marad */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, itemProp.id, provider?.id, provider?.serverUrl]);
  const series = kind === 'series' ? item as Series : null;
  const movie = kind === 'movie' ? item as Movie : null;
  const season = series?.seasons.find((s) => s.seasonNumber === seasonNumber) || series?.seasons[0];

  /* Távirányítós lépegetés a fókuszálható elemek (gombok) között fel/le. */
  const handleDetailKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const key = normalizeTvKey(e);
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const container = panelRef.current;
      if (!container) return;
      const nodes = Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
      if (!nodes.length) return;
      const current = nodes.indexOf(document.activeElement as HTMLElement);
      const nextIndex = current < 0 ? (key === 'ArrowDown' ? 0 : nodes.length - 1) : key === 'ArrowDown' ? Math.min(current + 1, nodes.length - 1) : Math.max(current - 1, 0);
      if (nextIndex !== current) {
        e.preventDefault(); e.stopPropagation();
        const next = nodes[nextIndex];
        next?.focus({ preventScroll: true });
        next?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      }
    } else handleKeyDown(e);
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 md:p-10" onClick={handleBackdropClick}>
      <div
        ref={setPanelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${item.title} adatlap`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDetailKeyDown}
        className="relative flex h-[84vh] w-full max-w-[1120px] flex-col overflow-hidden rounded-3xl border border-cyan-700/50 shadow-2xl"
      >
        {/* Háttérkép: kitölti a teljes adatlapot, nagy méretben (tartós tárolóból vagy URL-ről). */}
        <PosterImage
          src={item.backdrop || item.poster}
          title={item.title}
          kind={kind === 'movie' ? 'movie' : 'tv'}
          className="absolute inset-0 h-full w-full object-cover"
          alt=""
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/45 to-black/60" />

        {/* 2.5.255: kisebb, jól látható X a doboz saját sarkában (a kisebb
            doboz miatt nincs többé a képernyő szélére tolva/takarva). */}
        <button type="button" onClick={onClose} aria-label="Adatlap bezárása" className="absolute right-3 top-3 z-20 rounded-full bg-black/60 p-2.5 text-white border border-white/30 hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
          <X className="h-5 w-5" />
        </button>

        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          {/*
            Fejléc: bal kisebb poszter, jobb cím + év + játékidő (+ LEJÁTSZÁS filmnél).
            2.5.251/2.5.253 (#5/#6 képernyőképek): a fejléc tartalma függőlegesen
            KÖZÉPRE kerül (my-auto), a poszter kisebb – így nincs a bal felső
            sarokban, nem lóg a háttér fölé, és a bezáró X gomb nem takarja.
            (Mozi és Sorozat közös adatlap: ez az EGYETLEN hely, ahol kell állítani.)
          */}
          <div className="my-auto flex items-center gap-5 p-5 pt-14 md:gap-8 md:p-8 md:pt-16">
            <div className="h-[20vh] md:h-[28vh] aspect-[2/3] shrink-0 overflow-hidden rounded-2xl border-2 border-cyan-400/50 shadow-2xl bg-slate-900">
              <PosterImage src={item.poster} title={item.title} kind={kind === 'movie' ? 'movie' : 'tv'} className="h-full w-full object-cover" />
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <h2 className="truncate text-3xl md:text-5xl xl:text-6xl font-black leading-tight text-white drop-shadow-lg">{item.title}</h2>
              <div className="mt-3 flex flex-wrap items-center gap-4 text-lg md:text-2xl font-bold">
                {(() => { const y = item.year > 0 ? item.year : yearFromTitle(item.title); return y > 0 ? <span className="text-amber-300">{y}</span> : null; })()}
                {formatRuntime(item.durationMinutes) && (
                  <span className="flex items-center gap-1.5 text-cyan-200">
                    <Clock className="h-5 w-5 shrink-0" />
                    {formatRuntime(item.durationMinutes)}
                  </span>
                )}
              </div>
              {movie && (
                <button
                  type="button"
                  data-dialog-primary
                  data-vod-detail-action="play"
                  onClick={() => onPlayMovie?.(movie)}
                  className="mt-5 flex w-full max-w-md items-center justify-center gap-3 rounded-2xl bg-cyan-500 px-8 py-4 text-2xl font-black uppercase tracking-wide text-slate-950 transition-colors hover:bg-cyan-400 focus:outline-none focus-visible:ring-4 focus-visible:ring-white/70"
                >
                  <Play className="h-7 w-7 fill-current" /> Lejátszás
                </button>
              )}
              {/* 2.5.298: törlés a TV memóriájából – távirányítóval is elérhető. */}
              {onDelete && (
                <button
                  type="button"
                  data-vod-delete-action=""
                  onClick={() => onDelete()}
                  className="mt-3 flex w-full max-w-md items-center justify-center gap-2.5 rounded-2xl border-2 border-rose-400/80 bg-rose-950/90 px-6 py-3 text-lg font-black uppercase tracking-wide text-rose-100 transition-colors hover:bg-rose-900 focus:outline-none focus-visible:ring-4 focus-visible:ring-rose-300"
                >
                  <Trash2 className="h-5 w-5" /> Törlés a memóriából
                </button>
              )}
            </div>
          </div>

          {/* Sorozat: évadok és epizódok külön dobozokban, görgethetően. */}
          {series && (
            <div data-scroll-keep className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pb-5 md:px-8 md:pb-8">
              <section className="rounded-2xl border border-cyan-950/70 bg-black/60 p-4 backdrop-blur-sm md:p-5">
                <h3 className="mb-3 text-xl font-black text-white md:text-2xl">Évadok</h3>
                {series.seasons.length === 0 ? (
                  <p className="text-slate-300">Ehhez a sorozathoz még nincs mentett évadlista.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {series.seasons.map((s) => (
                      <button
                        key={s.seasonNumber}
                        type="button"
                        data-vod-detail-action="season"
                        onClick={() => setSeasonNumber(s.seasonNumber)}
                        className={`rounded-xl border px-4 py-2 font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${season?.seasonNumber === s.seasonNumber ? 'border-cyan-300 bg-cyan-400 text-slate-950' : 'border-slate-700 bg-[#0e1d3a] text-slate-200 hover:bg-[#142850]'}`}
                      >
                        {s.name} ({s.episodeCount})
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-cyan-950/70 bg-black/60 p-4 backdrop-blur-sm md:p-5">
                <h3 className="mb-3 text-xl font-black text-white md:text-2xl">
                  Epizódok{season ? ` – ${season.name}` : ''}
                </h3>
                {!season || season.episodes.length === 0 ? (
                  <p className="text-slate-300">Ehhez az évadhoz nincs mentett epizód.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {season.episodes.map((episode) => (
                      <div key={episode.id} data-vod-episode={episode.id} className="flex items-center gap-4 rounded-2xl border border-cyan-950/70 bg-[#081329]/90 p-4">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-lg font-bold text-white md:text-xl">{episode.title}</div>
                          <div className="mt-0.5 text-sm font-bold text-cyan-200 md:text-base">
                            S{String(episode.seasonNumber).padStart(2, '0')}E{String(episode.episodeNumber).padStart(2, '0')}
                          </div>
                        </div>
                        <button
                          type="button"
                          data-dialog-primary={season.episodes[0] === episode ? true : undefined}
                          data-vod-detail-action="episode-play"
                          onClick={() => onPlayEpisode?.(series, episode)}
                          className="flex shrink-0 items-center gap-2 rounded-xl bg-cyan-500 px-5 py-3 text-lg font-black uppercase text-slate-950 transition-colors hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                        >
                          <Play className="h-5 w-5 fill-current" /> Lejátszás
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
