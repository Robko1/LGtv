import React, { useMemo, useState } from 'react';
import { Clock, Heart, Mic2, Play, Star, Subtitles, X } from 'lucide-react';
import { Episode, Movie, Series } from '../types/iptv';
import { useTvModalNavigation } from '../hooks/useTvModalNavigation';
import { formatRuntime, joinLanguages, visibleLanguages } from '../utils/vodDisplay';
import { PosterImage } from './PosterImage';

type VodItem = Movie | Series;

const FIELD_LABELS: Record<string, string> = {
  name: 'Cím', title: 'Cím', original_name: 'Eredeti cím', original_title: 'Eredeti cím',
  releasedate: 'Megjelenés', release_date: 'Megjelenés', releaseDate: 'Megjelenés', year: 'Év',
  duration: 'Játékidő', duration_secs: 'Játékidő (mp)', episode_run_time: 'Epizód játékidő', runtime: 'Játékidő',
  director: 'Rendező', actors: 'Szereplők', cast: 'Szereplők', plot: 'Tartalom', description: 'Leírás',
  genre: 'Műfaj', genres: 'Műfajok', country: 'Ország', age: 'Korhatár', mpaa_rating: 'Korhatár-besorolás',
  rating: 'Értékelés', rating_5based: 'Értékelés (5ös skála)', tmdb: 'TMDB azonosító', tmdb_id: 'TMDB azonosító',
  kinopoisk_url: 'Kinopoisk', trailer: 'Előzetes', youtube_trailer: 'YouTube előzetes',
  backdrop_path: 'Háttérkép', cover: 'Borító', stream_icon: 'Poszter', movie_image: 'Epizód kép',
  audio: 'Hang', audio_tracks: 'Hangsávok', subtitles: 'Feliratok', subtitle_tracks: 'Feliratsávok',
  video: 'Videó', bitrate: 'Bitráta', codec_name: 'Kodek', codec_type: 'Sáv típusa', channels: 'Csatornák',
  channel_layout: 'Csatornakiosztás', sample_rate: 'Mintavételezés', language: 'Nyelv', lang: 'Nyelv',
  added: 'Hozzáadva', last_modified: 'Utoljára módosítva', category_id: 'Kategória azonosító',
  category_ids: 'Kategória azonosítók', stream_id: 'Stream azonosító', series_id: 'Sorozat azonosító',
  container_extension: 'Formátum', season: 'Évad', episode_num: 'Epizód száma', info: 'Részletes adatok',
  movie_data: 'Stream adatok', seasons: 'Évadok', episodes: 'Epizódok', tags: 'Címkék',
};

function labelFor(key: string): string {
  return FIELD_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function scalarText(value: unknown): string | null {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.trim() || '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

const LazyBranch: React.FC<{ label: string; defaultOpen?: boolean; children: React.ReactNode }> = ({ label, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-cyan-950/70 bg-[#081329] p-3">
      <button type="button" onClick={() => setOpen(!open)} className="w-full text-left text-base md:text-lg font-bold text-cyan-300 outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 rounded">
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
};

/** Minden letöltött nyers mező elérhető; a mély objektumok csak kinyitáskor épülnek fel. */
const RawValue: React.FC<{ value: unknown; depth?: number }> = ({ value, depth = 0 }) => {
  const scalar = scalarText(value);
  if (scalar !== null) return <span className="break-words text-slate-100">{scalar}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-slate-500">üres lista</span>;
    return (
      <div className="flex flex-col gap-2">
        {value.map((item, index) => (
          <div key={index} className="rounded-xl border border-cyan-950/70 bg-[#081329] p-3">
            <div className="mb-1 text-xs font-bold uppercase tracking-wider text-cyan-500">{index + 1}.</div>
            <RawValue value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <span className="text-slate-500">üres objektum</span>;
  return (
    <div className="flex flex-col gap-2">
      {entries.map(([key, item]) => {
        const text = scalarText(item);
        if (text !== null) {
          return (
            <div key={key} className="grid grid-cols-[minmax(120px,220px)_1fr] gap-3 border-b border-white/5 py-1.5 text-base md:text-lg">
              <span className="font-semibold text-cyan-300">{labelFor(key)}</span>
              <span className="break-words text-slate-100">{text}</span>
            </div>
          );
        }
        return (
          <LazyBranch key={key} label={labelFor(key)} defaultOpen={depth === 0 && (key === 'info' || key === 'movie_data')}>
            <RawValue value={item} depth={depth + 1} />
          </LazyBranch>
        );
      })}
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="rounded-2xl border border-cyan-950/70 bg-[#0b162f] p-4 md:p-5">
    <h3 className="mb-3 text-xl md:text-2xl font-black text-white">{title}</h3>
    {children}
  </section>
);

function trackLine(name: string, lang: string, codec?: string, channels?: string): string {
  return [name || lang, lang && lang !== name ? lang : '', codec, channels].filter(Boolean).join(' • ');
}

interface Props {
  kind: 'movie' | 'series';
  item: VodItem;
  isFavorite: boolean;
  onClose: () => void;
  onToggleFavorite: () => void;
  onPlayMovie?: (movie: Movie) => void;
  onPlayEpisode?: (series: Series, episode: Episode) => void;
}

/** Nagy, TV-ről is olvasható adatlap. Kizárólag mentett adatot jelenít meg. */
export const VodDetailSheet: React.FC<Props> = ({ kind, item, isFavorite, onClose, onToggleFavorite, onPlayMovie, onPlayEpisode }) => {
  const { modalRef: panelRef, handleKeyDown, handleBackdropClick } = useTvModalNavigation(true, onClose, [item.id]);
  const [seasonNumber, setSeasonNumber] = useState<number>(() => (item as Series).seasons?.[0]?.seasonNumber || 1);
  const [expandedEpisode, setExpandedEpisode] = useState<string | null>(null);
  const series = kind === 'series' ? item as Series : null;
  const movie = kind === 'movie' ? item as Movie : null;
  const season = series?.seasons.find((s) => s.seasonNumber === seasonNumber) || series?.seasons[0];
  const audio = visibleLanguages(item.audioLanguages);
  const subtitles = visibleLanguages(item.subtitleLanguages);
  const raw = useMemo(() => ({
    list: item.providerData,
    detail: item.detailProviderData,
  }), [item.providerData, item.detailProviderData]);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/85 p-3 md:p-6 backdrop-blur-sm" onClick={handleBackdropClick}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${item.title} adatlap`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="flex h-[94vh] w-full max-w-[1600px] flex-col overflow-hidden rounded-3xl border border-cyan-700/50 bg-[#070e1e] shadow-2xl"
      >
        <div className="relative min-h-[260px] h-[36vh] shrink-0 overflow-hidden bg-[#09152e]">
          {item.backdrop ? <img src={item.backdrop} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" /> : null}
          <div className="absolute inset-0 bg-gradient-to-t from-[#070e1e] via-[#070e1e]/60 to-black/20" />
          <button type="button" onClick={onClose} aria-label="Adatlap bezárása" className="absolute right-4 top-4 z-10 rounded-full bg-black/70 p-3 text-white border border-white/20 hover:bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
            <X className="h-6 w-6" />
          </button>
          <div className="relative flex h-full items-end gap-5 p-5 md:p-8">
            <div className="hidden sm:block h-[85%] aspect-[2/3] shrink-0 overflow-hidden rounded-2xl border-2 border-cyan-400/50 shadow-2xl bg-slate-900">
              <PosterImage src={item.poster} title={item.title} kind={kind === 'movie' ? 'movie' : 'tv'} localOnly className="h-full w-full object-cover" />
            </div>
            <div className="min-w-0 flex-1 pb-2">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm md:text-base font-bold text-cyan-200">
                <span className="rounded-full bg-cyan-500/20 px-3 py-1 border border-cyan-400/40">{kind === 'movie' ? 'Film' : 'Sorozat'}</span>
                <span>{item.categoryName}</span>
              </div>
              <h2 className="text-3xl md:text-5xl xl:text-6xl font-black leading-tight text-white drop-shadow-lg">{item.title}</h2>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-lg md:text-2xl font-bold text-slate-100">
                {item.year > 0 && <span className="text-amber-300">{item.year}</span>}
                {item.rating > 0 && <span className="flex items-center gap-1 text-amber-300"><Star className="h-5 w-5 fill-amber-300" />{item.rating}</span>}
                {formatRuntime(item.durationMinutes) && <span className="flex items-center gap-1 text-cyan-200"><Clock className="h-5 w-5" />{formatRuntime(item.durationMinutes)}</span>}
                {series && series.seasonsCount > 0 && <span>{series.seasonsCount} évad • {series.episodesCount} rész</span>}
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                {movie && onPlayMovie && (
                  <button type="button" data-dialog-primary onClick={() => onPlayMovie(movie)} className="flex items-center gap-2 rounded-xl bg-cyan-400 px-6 py-3 text-lg md:text-xl font-black text-slate-950 hover:bg-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-white">
                    <Play className="h-6 w-6 fill-current" /> Lejátszás
                  </button>
                )}
                <button type="button" onClick={onToggleFavorite} className={`flex items-center gap-2 rounded-xl px-5 py-3 text-lg font-bold border focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${isFavorite ? 'bg-rose-500/20 border-rose-400 text-rose-200' : 'bg-white/10 border-white/20 text-white'}`}>
                  <Heart className={`h-5 w-5 ${isFavorite ? 'fill-current' : ''}`} /> {isFavorite ? 'Kedvenc' : 'Kedvencekhez'}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div data-scroll-keep className="flex-1 overflow-y-auto p-4 md:p-6 flex flex-col gap-4 text-base md:text-lg leading-relaxed">
          {item.plot && <Section title="Tartalom"><p className="whitespace-pre-wrap text-slate-100 text-lg md:text-xl">{item.plot}</p></Section>}
          <div className="grid gap-4 lg:grid-cols-2">
            {item.genres.length > 0 && <Section title="Műfajok"><div className="flex flex-wrap gap-2">{item.genres.map((g) => <span key={g} className="rounded-full bg-cyan-500/15 border border-cyan-500/30 px-3 py-1 text-cyan-100">{g}</span>)}</div></Section>}
            {item.director && <Section title="Rendező"><p className="text-slate-100">{item.director}</p></Section>}
            {item.cast && item.cast.length > 0 && <Section title="Szereplők"><p className="text-slate-100">{item.cast.join(', ')}</p></Section>}
            <Section title="Hang és felirat">
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-2"><Mic2 className="mt-1 h-5 w-5 shrink-0 text-rose-300" /><div><div className="font-bold text-rose-200">Hangnyelvek</div><div className="text-slate-100">{joinLanguages(audio) || 'Nincs mentett adat'}</div></div></div>
                {item.audioTracks && item.audioTracks.length > 0 && <ul className="ml-7 list-disc text-slate-200">{item.audioTracks.map((t) => <li key={String(t.id)}>{trackLine(t.name, t.lang, t.codec, t.channels)}</li>)}</ul>}
                <div className="flex items-start gap-2"><Subtitles className="mt-1 h-5 w-5 shrink-0 text-cyan-300" /><div><div className="font-bold text-cyan-200">Feliratnyelvek</div><div className="text-slate-100">{joinLanguages(subtitles) || 'Nincs mentett adat'}</div></div></div>
                {item.subtitleTracks && item.subtitleTracks.length > 0 && <ul className="ml-7 list-disc text-slate-200">{item.subtitleTracks.map((t) => <li key={String(t.id)}>{trackLine(t.name, t.lang)}</li>)}</ul>}
              </div>
            </Section>
          </div>

          {series && (
            <Section title="Évadok és epizódok">
              {series.seasons.length === 0 ? (
                <p className="text-slate-400">Ehhez a sorozathoz még nincs mentett epizódlista. Az adatlap nem indít új letöltést.</p>
              ) : (
                <>
                  <div className="mb-4 flex flex-wrap gap-2">
                    {series.seasons.map((s) => (
                      <button key={s.seasonNumber} type="button" onClick={() => setSeasonNumber(s.seasonNumber)} className={`rounded-xl px-4 py-2 font-bold border ${season?.seasonNumber === s.seasonNumber ? 'bg-cyan-400 text-slate-950 border-cyan-300' : 'bg-[#0e1d3a] text-slate-200 border-slate-700'}`}>
                        {s.name} ({s.episodeCount})
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-col gap-3">
                    {season?.episodes.map((episode) => (
                      <div key={episode.id} data-vod-episode={episode.id} className="rounded-2xl border border-cyan-950/70 bg-[#081329] p-4">
                        <div className="flex flex-wrap items-center gap-3">
                          <button type="button" onClick={() => onPlayEpisode?.(series, episode)} className="flex items-center gap-2 rounded-xl bg-cyan-500/20 border border-cyan-400/50 px-4 py-2 font-black text-cyan-100 hover:bg-cyan-500/30">
                            <Play className="h-5 w-5" /> {episode.episodeNumber}. rész
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="text-lg md:text-xl font-bold text-white">{episode.title}</div>
                            <div className="text-sm md:text-base text-slate-400">{formatRuntime(episode.durationMinutes)}{episode.watched ? ' • Megnézve' : ''}</div>
                          </div>
                          <button type="button" onClick={() => setExpandedEpisode(expandedEpisode === episode.id ? null : episode.id)} className="rounded-lg border border-slate-600 px-3 py-2 text-sm font-bold text-slate-200">
                            {expandedEpisode === episode.id ? 'Adatok elrejtése' : 'Összes adat'}
                          </button>
                        </div>
                        {expandedEpisode === episode.id && (
                          <div className="mt-4 flex flex-col gap-3">
                            {episode.plot && <p className="text-slate-100">{episode.plot}</p>}
                            <RawValue value={episode.providerData || episode} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Section>
          )}

          <Section title="Összes letöltött szolgáltatói adat">
            <div className="flex flex-col gap-4">
              {raw.detail ? <div><h4 className="mb-2 font-bold text-cyan-300">Részletes válasz</h4><RawValue value={raw.detail} /></div> : null}
              {raw.list ? <div><h4 className="mb-2 font-bold text-cyan-300">Listaelem</h4><RawValue value={raw.list} /></div> : null}
              {!raw.detail && !raw.list && <p className="text-slate-400">Ehhez az elemhez csak a korábban mentett, fenti adatok állnak rendelkezésre.</p>}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
};
