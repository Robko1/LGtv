import React, { useEffect, useRef, useState } from 'react';

type PosterKind = 'movie' | 'tv';

interface PosterImageProps {
  src?: string | null;
  title: string;
  kind: PosterKind;
  className?: string;
  alt?: string;
}

/**
 * Uses the provider's poster first. If it is missing or returns an image error,
 * search TMDB for a matching real poster. Configure VITE_TMDB_API_KEY at build
 * time; without a key the component safely falls back instead of spamming requests.
 */
const TMDB_STORAGE_KEY = 'iptv.tmdb.api-key.v1';

function getTmdbApiKey(): string {
  try {
    const saved = localStorage.getItem(TMDB_STORAGE_KEY)?.trim();
    if (saved) return saved;
  } catch {
    // Embedded browser storage may be unavailable.
  }
  return String((import.meta as any).env?.VITE_TMDB_API_KEY || '').trim();
}
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const CACHE_KEY = 'iptv.tmdb.poster-cache.v1';
const memoryCache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
let activeLookups = 0;
const lookupQueue: Array<() => void> = [];
const MAX_LOOKUPS = 3;

const FALLBACK_POSTER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='450' viewBox='0 0 300 450'%3E%3Crect width='300' height='450' fill='%2309152e'/%3E%3Crect x='24' y='24' width='252' height='402' rx='18' fill='none' stroke='%230e7490' stroke-width='4'/%3E%3Cpath d='M125 175 L190 225 L125 275 Z' fill='%2367e8f9' opacity='.8'/%3E%3Ctext x='150' y='330' text-anchor='middle' fill='%23cbd5e1' font-family='Arial,sans-serif' font-size='18'%3EPOSTER NEM ELERHETO%3C/text%3E%3C/svg%3E";

function normalizeTitle(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(4k|uhd|fhd|hd|1080p|720p|2160p|h264|h265|hevc|web-dl|bluray|x264|x265)\b/gi, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function cachedPoster(key: string): string | null | undefined {
  if (memoryCache.has(key)) return memoryCache.get(key);
  try {
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, string | null>;
    if (Object.prototype.hasOwnProperty.call(stored, key)) {
      memoryCache.set(key, stored[key]);
      return stored[key];
    }
  } catch {
    // Storage may be unavailable in a private or embedded browser context.
  }
  return undefined;
}

function savePoster(key: string, value: string | null): void {
  memoryCache.set(key, value);
  try {
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, string | null>;
    stored[key] = value;
    const entries = Object.entries(stored);
    // Keep the cache bounded on long-running TV sessions.
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries.slice(-1500))));
  } catch {
    // In-memory cache still works if storage is unavailable.
  }
}

function scheduleLookup<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activeLookups++;
      task().then(resolve, reject).finally(() => {
        activeLookups--;
        const next = lookupQueue.shift();
        if (next) next();
      });
    };
    if (activeLookups < MAX_LOOKUPS) run();
    else lookupQueue.push(run);
  });
}

async function lookupTmdbPoster(title: string, kind: PosterKind): Promise<string | null> {
  const normalized = normalizeTitle(title);
  const apiKey = getTmdbApiKey();
  if (!apiKey || !normalized) return null;
  const cacheKey = `${kind}:${normalized}`;
  const cached = cachedPoster(cacheKey);
  if (cached !== undefined) return cached;
  const existing = pending.get(cacheKey);
  if (existing) return existing;

  const request = scheduleLookup(async () => {
    try {
      const endpoint = kind === 'movie' ? 'movie' : 'tv';
      const url = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('query', title.trim());
      url.searchParams.set('include_adult', 'false');
      const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
      const data = await response.json() as { results?: Array<Record<string, unknown>> };
      const candidates = Array.isArray(data.results) ? data.results : [];
      const exact = candidates.find((item) => {
        const candidate = normalizeTitle(String(kind === 'movie' ? item.title || item.original_title || '' : item.name || item.original_name || ''));
        return candidate && candidate === normalized && typeof item.poster_path === 'string' && item.poster_path;
      });
      const chosen = exact || candidates.find((item) => {
        const candidate = normalizeTitle(String(kind === 'movie' ? item.title || item.original_title || '' : item.name || item.original_name || ''));
        const tokens = normalized.split(' ').filter(Boolean);
        const overlap = tokens.filter((token) => candidate.split(' ').includes(token)).length;
        return candidate && typeof item.poster_path === 'string' && item.poster_path && tokens.length > 0 && overlap / tokens.length >= 0.8;
      });
      const posterPath = chosen && typeof chosen.poster_path === 'string' ? chosen.poster_path : '';
      const result = posterPath.startsWith('/') ? `${IMAGE_BASE}${posterPath}` : null;
      savePoster(cacheKey, result);
      return result;
    } catch (error) {
      console.warn('A TMDB-poszter keresése nem sikerült:', title, error);
      // Do not cache network errors; a later image retry can try again.
      return null;
    }
  });
  pending.set(cacheKey, request);
  try {
    return await request;
  } finally {
    pending.delete(cacheKey);
  }
}

export const PosterSettingsButton: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem(TMDB_STORAGE_KEY) || ''; } catch { return ''; }
  });
  const [saved, setSaved] = useState(false);

  const save = () => {
    try {
      const trimmed = apiKey.trim();
      if (trimmed) localStorage.setItem(TMDB_STORAGE_KEY, trimmed);
      else localStorage.removeItem(TMDB_STORAGE_KEY);
      setApiKey(trimmed);
      setSaved(true);
      window.dispatchEvent(new Event('iptv-poster-key-updated'));
    } catch {
      setSaved(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true); setSaved(false); }}
        className="px-2.5 py-1.5 rounded-lg bg-[#0d1d3d] border border-cyan-900/60 text-cyan-200 hover:border-cyan-500/60 text-[11px] font-bold"
        title="Filmposzter-keresés beállítása"
      >
        Poszterek
      </button>
      {open && (
        <div role="dialog" aria-modal="true" aria-label="Poszter információ" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }} className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-cyan-700/60 bg-[#09152e] p-4 shadow-2xl">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h3 className="text-white font-bold">Valódi film- és sorozatposzterek</h3>
              <button type="button" onClick={() => setOpen(false)} className="text-slate-300 hover:text-white px-2 py-1" aria-label="Bezárás">✕</button>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed mb-3">
              A program először a szolgáltató képét használja. Ha az hiányzik vagy hibás, a TMDB-ben keres megfelelő posztert. Ehhez TMDB API-kulcs szükséges.
            </p>
            <label className="block text-xs text-cyan-200 mb-1" htmlFor="tmdb-api-key">TMDB API-kulcs</label>
            <input
              id="tmdb-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => { setApiKey(event.target.value); setSaved(false); }}
              placeholder="Illeszd be a TMDB API-kulcsot"
              className="w-full rounded-xl border border-cyan-900 bg-[#0d1d3d] px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
            />
            <p className="mt-2 text-[11px] text-slate-400">
              Kulcs igénylése: <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer" className="text-cyan-300 underline">TMDB API beállítások</a>. A kulcs ezen az eszközön, helyben kerül mentésre.
            </p>
            <p className="mt-2 text-[11px] text-slate-400">
              This product uses the TMDB API but is not endorsed or certified by TMDB.
            </p>
            {saved && <p className="mt-2 text-xs text-emerald-300">A kulcs elmentve. A poszterkeresés ezután használja.</p>}
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" onClick={() => { setApiKey(''); }} className="rounded-lg px-3 py-2 text-xs text-slate-300 hover:bg-white/5">Törlés</button>
              <button type="button" onClick={save} className="rounded-lg px-4 py-2 text-xs font-bold bg-cyan-600 hover:bg-cyan-500 text-white">Mentés</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export const PosterImage: React.FC<PosterImageProps> = ({ src, title, kind, className = '', alt }) => {
  const providerSrc = typeof src === 'string' ? src.trim() : '';
  const [imageSrc, setImageSrc] = useState(providerSrc || FALLBACK_POSTER);
  const [usingFallback, setUsingFallback] = useState(!providerSrc);
  const lookupStarted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    lookupStarted.current = false;
    setImageSrc(providerSrc || FALLBACK_POSTER);
    setUsingFallback(!providerSrc);

    const search = async () => {
      if (lookupStarted.current) return;
      lookupStarted.current = true;
      const result = await lookupTmdbPoster(title, kind);
      if (cancelled) return;
      if (result) {
        setImageSrc(result);
        setUsingFallback(false);
      } else if (!providerSrc) {
        setImageSrc(FALLBACK_POSTER);
        setUsingFallback(true);
      }
    };

    if (!providerSrc) void search();
    return () => { cancelled = true; };
  }, [providerSrc, title, kind]);

  useEffect(() => {
    const onKeyUpdated = () => {
      if (!providerSrc || usingFallback || imageSrc === FALLBACK_POSTER) {
        lookupStarted.current = false;
        void lookupTmdbPoster(title, kind).then((result) => {
          if (result) {
            setImageSrc(result);
            setUsingFallback(false);
          }
        });
      }
    };
    window.addEventListener('iptv-poster-key-updated', onKeyUpdated);
    return () => window.removeEventListener('iptv-poster-key-updated', onKeyUpdated);
  }, [providerSrc, title, kind, usingFallback, imageSrc]);

  const handleError = () => {
    if (imageSrc === FALLBACK_POSTER) return;
    // A TMDB CDN image can itself be unavailable; do not retry the same cached URL forever.
    if (imageSrc.startsWith(IMAGE_BASE)) {
      setImageSrc(FALLBACK_POSTER);
      setUsingFallback(true);
      return;
    }
    if (usingFallback) {
      setImageSrc(FALLBACK_POSTER);
      return;
    }
    setUsingFallback(true);
    void lookupTmdbPoster(title, kind).then((result) => {
      if (result) {
        setImageSrc(result);
        setUsingFallback(false);
      } else {
        setImageSrc(FALLBACK_POSTER);
      }
    });
  };

  return (
    <img
      src={imageSrc}
      alt={alt || title}
      className={className}
      loading="lazy"
      onError={handleError}
    />
  );
};
