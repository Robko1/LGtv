import React from 'react';

type PosterKind = 'movie' | 'tv';

interface PosterImageProps {
  src?: string | null;
  title: string;
  kind: PosterKind;
  className?: string;
  alt?: string;
  /** A poszter kizárólag a szolgáltató által megadott URL-ről tölthető be. */
  localOnly?: boolean;
}

const FALLBACK_POSTER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='450' viewBox='0 0 300 450'%3E%3Crect width='300' height='450' fill='%2309152e'/%3E%3Crect x='24' y='24' width='252' height='402' rx='18' fill='none' stroke='%230e7490' stroke-width='4'/%3E%3Cpath d='M125 175 L190 225 L125 275 Z' fill='%2367e8f9' opacity='.8'/%3E%3Ctext x='150' y='330' text-anchor='middle' fill='%23cbd5e1' font-family='Arial,sans-serif' font-size='18'%3EPOSTER NEM ELERHETO%3C/text%3E%3C/svg%3E";

/** A korábbi TMDB-kulcsot és keresési gyorsítótárat eltávolítja az eszközről. */
try {
  localStorage.removeItem('iptv.tmdb.api-key.v1');
  localStorage.removeItem('iptv.tmdb.poster-cache.v1');
} catch {
  // A szolgáltatói poszterek működéséhez nem szükséges a helyi tárhely.
}

/** A szolgáltatói poszter előtöltése; külső keresést vagy API-hívást nem végez. */
export async function preloadPosterImage(
  src: string | null | undefined,
  _title: string,
  _kind: PosterKind,
  _localOnly = true,
): Promise<void> {
  const imageUrl = typeof src === 'string' ? src.trim() : '';
  if (!imageUrl) return;

  await new Promise<void>((resolve) => {
    const image = new Image();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      image.onload = null;
      image.onerror = null;
      resolve();
    };
    image.decoding = 'async';
    image.onload = finish;
    image.onerror = finish;
    image.src = imageUrl;
    if (image.complete) finish();
  });
}

export const PosterImage: React.FC<PosterImageProps> = ({ src, title, className = '', alt }) => {
  const providerSrc = typeof src === 'string' ? src.trim() : '';
  return (
    <img
      src={providerSrc || FALLBACK_POSTER}
      alt={alt || title}
      className={className}
      loading="lazy"
      onError={(event) => {
        event.currentTarget.onerror = null;
        event.currentTarget.src = FALLBACK_POSTER;
      }}
    />
  );
};
