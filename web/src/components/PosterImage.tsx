import React, { useEffect, useState } from 'react';
import { loadContentImageUrl, saveContentImageUrl } from '../services/contentStore';

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

/*
 * 2.5.245: a poszter/háttérkép először a TARTÓS IndexedDB-tárból jön
 * (contentStore képtár), és csak ha onnan nincs, töltődik a szolgáltatói
 * URL-ről – ekkor viszont azonnal el is mentjük oda, hogy legközelebb már
 * ne kelljen újra letölteni. Így minden megjelenítés a már elmentett
 * adatokból dolgozik.
 */
async function mirrorImageToStore(url: string): Promise<void> {
  try {
    if (!/^https?:\/\//i.test(url)) return;
    if (await loadContentImageUrl(url)) return;
    // Csak akkor mentünk, ha a szerver engedi a CORS-os olvasást; a sima
    // <img> megjelenítés ettől függetlenül működik CORS nélkül is.
    const response = await fetch(url, { mode: 'cors' });
    if (response.ok && response.type !== 'opaque') {
      const blob = await response.blob();
      if (blob.size > 0) await saveContentImageUrl(url, blob);
    }
  } catch {
    // A mentés hibája nem akadályozhatja a megjelenítést.
  }
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

  // 2.5.245: ha már tartósan el van mentve, egyáltalán nincs hálózati kérés.
  if (await loadContentImageUrl(imageUrl)) return;

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
  // Betöltés után tartósan is elmentjük (háttérben, nem blokkol).
  void mirrorImageToStore(imageUrl);
}

export const PosterImage: React.FC<PosterImageProps> = ({ src, title, className = '', alt }) => {
  const providerSrc = typeof src === 'string' ? src.trim() : '';
  const [localUrl, setLocalUrl] = useState('');

  // 2.5.245: először a tartós tárból próbáljuk (blob URL), aztán a szolgáltatói URL.
  useEffect(() => {
    let cancelled = false;
    setLocalUrl('');
    if (!providerSrc) return;
    void loadContentImageUrl(providerSrc).then((blob) => {
      if (cancelled || !blob) return;
      try {
        setLocalUrl(URL.createObjectURL(blob));
      } catch { /* jsdom/öreg böngésző: marad a szolgáltatói URL */ }
    });
    return () => { cancelled = true; };
  }, [providerSrc]);

  useEffect(() => () => {
    if (localUrl.startsWith('blob:')) URL.revokeObjectURL(localUrl);
  }, [localUrl]);

  return (
    <img
      src={localUrl || providerSrc || FALLBACK_POSTER}
      alt={alt || title}
      className={className}
      loading="lazy"
      onLoad={() => { if (providerSrc) void mirrorImageToStore(providerSrc); }}
      onError={(event) => {
        event.currentTarget.onerror = null;
        event.currentTarget.src = FALLBACK_POSTER;
      }}
    />
  );
};
