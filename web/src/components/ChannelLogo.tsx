import React, { useEffect, useState } from 'react';
import { APP_ICON_SMALL_DATA_URL } from '../generatedIcon';
import { normalizeLogoUrl } from '../services/logoUrl';

/** retryKey: bármilyen stabil érték (pl. csatorna-azonosító) – változására újratölt. */
interface Props { url?: string; name: string; retryKey?: unknown }

/** A szolgáltatói logót közvetlenül tölti be, majd sikertelenségnél a gyorsítótárból próbálja visszaolvasni. */
export const ChannelLogo: React.FC<Props> = ({ url, name, retryKey }) => {
  const normalizedUrl = normalizeLogoUrl(url);
  return <LogoImage key={normalizedUrl} url={normalizedUrl} name={name} retryKey={retryKey} />;
};

const LogoImage: React.FC<Props> = ({ url = '', name, retryKey }) => {
  const [source, setSource] = useState(url);
  const [failed, setFailed] = useState(false);
  const [cachedSource, setCachedSource] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [schemeAttempt, setSchemeAttempt] = useState(0);

  useEffect(() => {
    setSource(url);
    setFailed(false);
    setCachedSource('');
    setSchemeAttempt(0);
    const retry = () => {
      setSource(url);
      setFailed(false);
      setCachedSource('');
      setSchemeAttempt(0);
      setAttempt((value) => value + 1);
    };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [url, retryKey]);

  useEffect(() => {
    return () => {
      if (cachedSource.startsWith('blob:')) URL.revokeObjectURL(cachedSource);
    };
  }, [cachedSource]);

  const loadCachedLogo = async (failedUrl: string) => {
    try {
      if (!('caches' in window)) return;
      const cache = await window.caches.open('iptv-channel-logos-v1');
      const response = await cache.match(failedUrl);
      if (!response) return;
      const blob = await response.blob();
      if (!blob.size) return;
      const objectUrl = URL.createObjectURL(blob);
      setCachedSource(objectUrl);
      setFailed(false);
    } catch {
      // A cache hiba ne akadályozza a semleges TV ikon megjelenítését.
    }
  };

  if (!url || (failed && !cachedSource)) {
    // Beégetett app-ikon tartalékként (keresés felugrókban is), megfelelő méretre kicsinyítve.
    return <img src={APP_ICON_SMALL_DATA_URL} width={20} height={20} className="w-5 h-5 rounded object-contain opacity-80" alt="" aria-label={`A(z) ${name} logója nem érhető el`} />;
  }

  return (
    <img
      key={`${cachedSource || source}:${attempt}`}
      src={cachedSource || source}
      alt={name}
      className="relative z-10 w-full h-full object-contain"
      // FONTOS (memória/fagyás): lusta betöltés. Korábban minden sor logója
      // azonnal letöltődött – 20 000 csatornánál ez több ezer egyidejű kérést
      // és akkora memóriát jelentett, hogy a rendszer leállította a beágyazott böngészőt.
      loading="lazy"
      decoding="async"
      onError={() => {
        // HTTP → HTTPS → eredeti HTTP; csak ezután próbáljuk a mentett logót.
        if (schemeAttempt === 0 && /^http:\/\//i.test(source)) {
          setSchemeAttempt(1);
          setSource(source.replace(/^http:\/\//i, 'https://'));
        } else if (schemeAttempt === 1 && /^https:\/\//i.test(source) && /^http:\/\//i.test(url)) {
          setSchemeAttempt(2);
          setSource(url);
        } else if (cachedSource) {
          setCachedSource('');
          setFailed(true);
        } else {
          setFailed(true);
          void loadCachedLogo(source);
        }
      }}
    />
  );
};
