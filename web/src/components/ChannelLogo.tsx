import React, { useEffect, useRef, useState } from 'react';
import { APP_ICON_SMALL_DATA_URL } from '../generatedIcon';
import { normalizeLogoUrl } from '../services/logoUrl';
import { getHuChannelLogo, getHuLogoCachedImage, cacheHuLogoDataUrl } from '../services/huChannelLogos';
import { appLog } from '../services/appLog';

/* 2.5.247: végleges logóbetöltési hiba naplózása (korlátosan) – a #3 napló még
   csak azt mutatta, hogy a tárolóban MEGVAN a logó; a képernyőn mégsem jelent
   meg. A következő kézi naplóból látszik majd, mely címek hibáznak. */
let logoFailLogCount = 0;

/*
 * 2.5.264 (#11-es napló): a BEÉPÍTETT (data-URL) logók betöltése. A #11 napló
 * szerint a 6 beépített data-URL logó (Travel Channel, Xtreme Sport, Duck TV,
 * Disney Jr/Channel, Discovery) „beragadt” – a PNG formátumuk hibátlan (8 bites
 * palettás), tehát nem a kódolás, hanem a BETÖLTÉSI ÚT a gond: a `loading="lazy"`
 * a virtuális listában a nem látható soroknál soha nem indítja el a képet,
 * így a 8 mp-es watchdog előbb „hibásnak” minősít. Ezért:
 *   - data:/blob: forrásnál MINDIG eager betöltés;
 *   - a data: URL-t module-szintű gyorsítótárral blob: objektum-URL-lé
 *     alakítjuk (atob → Blob → createObjectURL) – a blob: útvonal ezen a TV-n
 *     már bizonyítottan működik (a logó-kép gyorsítótár is blob: URL-t használ),
 *     és a data: közvetlen használata helyett kisebb a feldolgozási út.
 */
const dataUrlBlobCache = new Map<string, string>();

function dataUrlToBlobUrl(dataUrl: string): string {
  const cached = dataUrlBlobCache.get(dataUrl);
  if (cached) return cached;
  try {
    const comma = dataUrl.indexOf(',');
    const meta = dataUrl.slice(0, comma);
    const base64 = dataUrl.slice(comma + 1);
    const mime = /^data:([^;,]+)/i.exec(meta)?.[1] || 'image/png';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    // A cache kulcsa a teljes data-URL; a beépített logók élettartama az appéval
    // azonos, így nem revoke-oljuk (a kis képek nem foglalnak sokat).
    dataUrlBlobCache.set(dataUrl, blobUrl);
    return blobUrl;
  } catch {
    return dataUrl;
  }
}

/** Megjelenítési forrás: data: URL → blob: objektum-URL (gyorsabb, biztosabb betöltés). */
function displaySource(source: string): string {
  if (source.startsWith('data:')) return dataUrlToBlobUrl(source);
  return source;
}

/** retryKey: bármilyen stabil érték (pl. csatorna-azonosító) – változására újratölt. */
interface Props { url?: string; name: string; retryKey?: unknown; countryCode?: string }

/*
 * A szolgáltatói logót közvetlenül tölti be, majd sikertelenségnél a
 * gyorsítótárból próbálja visszaolvasni.
 *
 * 2.5.245: magyar (HU) csatornánál a SAJÁT tárolóból (huChannelLogos) is
 * kaphat logót. CSAK countryCode==='HU' esetén – más ország csatornája
 * soha nem kap magyar tárolós logót.
 *
 * 2.5.253 (#6 képernyőképek): magyar csatornánál a SAJÁT logót használjuk,
 * és a szolgáltatói logót EGYÁLTALÁN NEM kérjük le – a picons szerver a
 * magyar logóknál beragad (8 mp-es watchdog után sem érkezik válasz), ami a
 * főoldalon várakozást és lassulást okozott. Ha nincs saját logó, rögtön az
 * app-ikon jelenik meg, hálózati kérés és várakozás nélkül.
 */
export const ChannelLogo: React.FC<Props> = ({ url, name, retryKey, countryCode }) => {
  const normalizedUrl = normalizeLogoUrl(url);
  const isHu = countryCode === 'HU';
  const huLogo = isHu ? normalizeLogoUrl(getHuChannelLogo(name)) : '';
  /*
   * 2.5.259 (#9): magyar csatornánál ELSŐ a saját logó; ha nincs saját
   * (a #8 napló szerint mind a 107 HU csatornának van szolgáltatói logója,
   * csak kb. 80-nak van saját), akkor a szolgáltatói logót használjuk –
   * így nem marad app-ikon a "többi" csatornán. HU képeknél a letöltött
   * kép data-URL-ként a helyi tárolóba is kerül, újraindítás után azonnal
   * onnan töltődik. Nem-HU csatornánál az út változatlan.
   */
  const effectiveUrl = isHu ? (huLogo || normalizedUrl) : (normalizedUrl || huLogo);
  return (
    <LogoImage
      key={effectiveUrl}
      url={effectiveUrl}
      name={name}
      retryKey={retryKey}
      huLogo={huLogo}
      fallbackUrl={isHu ? normalizedUrl : ''}
      cacheable={isHu}
    />
  );
};

const LogoImage: React.FC<Props & { huLogo?: string; fallbackUrl?: string; cacheable?: boolean }> = ({ url = '', name, retryKey, huLogo = '', fallbackUrl = '', cacheable = false }) => {
  const [source, setSource] = useState(url);
  const [failed, setFailed] = useState(false);
  const [cachedSource, setCachedSource] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [schemeAttempt, setSchemeAttempt] = useState(0);
  // 2.5.245: a saját HU tárolós logót csak EGYSZER próbáljuk (különben a
  // szolgáltatói URL és a saját logó között végtelen újrapróbálkozás lenne).
  const [huTried, setHuTried] = useState(false);
  // 2.5.249: "beragadt" logókérés – ha a kép se nem töltődik be, se nem hibázik
  // (a picons szerver elfogadja a kapcsolatot, de nem válaszol), a #4 napló
  // szerint a hely örökre üres maradt, és a tartalék lánc (séma → HU tároló →
  // gyorsítótár → app-ikon) soha nem indult el. Időzítővel ez pótoljuk.
  const settledRef = useRef(false);
  const advanceFailureRef = useRef<() => void>(() => {});

  useEffect(() => {
    /*
     * 2.5.257 (#8): ha a saját HU logó képe már a helyi tárolóban
     * (localStorage, data-URL) van, azt használjuk – újraindítás után így
     * rögtön, hálózati kérés és átrendeződés nélkül jelenik meg a logó.
     * Nem-HU csatornánál (huLogo üres) az út változatlan.
     */
    const huCached = cacheable ? getHuLogoCachedImage(url) : undefined;
    setSource(huCached || url);
    setFailed(false);
    setCachedSource('');
    setSchemeAttempt(0);
    setHuTried(false);
    const retry = () => {
      setSource(huCached || url);
      setFailed(false);
      setCachedSource('');
      setSchemeAttempt(0);
      setHuTried(false);
      setAttempt((value) => value + 1);
    };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [url, retryKey, huLogo]);

  useEffect(() => {
    return () => {
      if (cachedSource.startsWith('blob:')) URL.revokeObjectURL(cachedSource);
    };
  }, [cachedSource]);

  // 2.5.249: watchdog – 8 mp után, ha még nincs onLoad/onError, sikertelennek vesszük.
  useEffect(() => {
    settledRef.current = false;
    if (!source) return;
    const timer = window.setTimeout(() => {
      if (!settledRef.current) advanceFailureRef.current();
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [source, attempt]);

  const saveCachedLogo = async (loadedUrl: string) => {
    try {
      if (!loadedUrl || !('caches' in window) || !/^https?:\/\//i.test(loadedUrl)) return;
      const cache = await window.caches.open('iptv-channel-logos-v1');
      if (await cache.match(loadedUrl)) return;
      // Csak akkor mentjük saját gyorsítótárba, ha a szolgáltató engedi a CORS-os olvasást.
      // A normál <img> megjelenítés ettől függetlenül működik CORS nélküli szervereknél is.
      const response = await fetch(loadedUrl, { mode: 'cors' });
      if (response.ok && response.type !== 'opaque') await cache.put(loadedUrl, response.clone());
    } catch {
      // A gyorsítótár mentési hibája nem akadályozhatja a csatornalogó megjelenítését.
    }
  };

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

  const advanceFailure = (): void => {
    /*
     * 2.5.251 (#5 napló): magyar csatornánál, ha a SAJÁT tárolónkban (lásd
     * huChannelLogos) van logó, az ELSŐ hiba után rögtön azt próbáljuk – a
     * szolgáltatói picons szerver (103.176.90.x) több magyar logónál beragad
     * (a #5 naplóban 13 HU csatorna), és a séma-újrapróbálkozás csak tovább
     * késleltetné a megjelenést. A saját logó csak egyszer próbálkozik.
     */
    if (huLogo && !huTried) {
      setHuTried(true);
      if (source !== huLogo) {
        setSchemeAttempt(0);
        setSource(huLogo);
        return;
      }
      // 2.5.253: már a saját logón vagyunk (HU mód) – ha az is beragad, a
      // következő lépések (séma/fail) döntsenek, ne ragadjunk itt.
    }
    /*
     * 2.5.259 (#9): ha a SAJÁT HU logó végleg hibás, még a szolgáltatói
     * logót (fallbackUrl) is megpróbáljuk – így a saját logó nélküli magyar
     * csatornákhoz is kerül kép. Nem-HU módban fallbackUrl üres, az út
     * változatlan.
     */
    if (huLogo && huTried && fallbackUrl && source !== fallbackUrl && /^https?:\/\//i.test(fallbackUrl)) {
      setSchemeAttempt(0);
      setSource(fallbackUrl);
      return;
    }
    // Szolgáltatói URL sémaváltása: http → https → eredeti http.
    if (schemeAttempt === 0 && /^http:\/\//i.test(url)) {
      setSchemeAttempt(1);
      setSource(url.replace(/^http:\/\//i, 'https://'));
      return;
    }
    if (schemeAttempt === 1 && /^http:\/\//i.test(url)) {
      setSchemeAttempt(2);
      setSource(url);
      return;
    }
    if (cachedSource) {
      setCachedSource('');
      setFailed(true);
      return;
    }
    setFailed(true);
    if (logoFailLogCount < 25) {
      logoFailLogCount += 1;
      // 2.5.261: beépített (data-URL) logónál nem írjuk ki a base64 törzset a naplóba.
      const tried = url.startsWith('data:') ? `beépített data-URL (bundle, ${url.length} karakter)` : url;
      appLog(`CSATORNALOGÓ-HIBA: „${name}” – a logó végleg nem tölthető be, ezt próbálta: ${tried}`);
    }
    // A gyorsítótárban az EREDETI szolgáltatói URL alatt keressük a képet.
    void loadCachedLogo(url);
  };
  advanceFailureRef.current = advanceFailure;

  if (!url || (failed && !cachedSource)) {
    // Beégetett app-ikon tartalékként (keresés felugrókban is), megfelelő méretre kicsinyítve.
    return <img src={APP_ICON_SMALL_DATA_URL} width={20} height={20} className="w-5 h-5 rounded object-contain opacity-80" alt="" aria-label={`A(z) ${name} logója nem érhető el`} />;
  }

  // 2.5.264 (#11): helyi (data:/blob:) képeknél eager betöltés – a lazy a
  // virtuális soroknál beragasztotta a beépített logókat (lásd fent).
  const renderedSource = displaySource(cachedSource || source);
  const eagerLocal = renderedSource.startsWith('blob:') || renderedSource.startsWith('data:');

  return (
    <img
      key={`${cachedSource || source}:${attempt}`}
      src={renderedSource}
      alt={name}
      className="relative z-10 w-full h-full object-contain"
      // FONTOS (memória/fagyás): a távoli (http/https) képeknél továbbra is
      // lusta betöltés – 20 000 csatornánál az azonnali betöltés több ezer
      // egyidejű kérést és akkora memóriát jelentett, hogy a rendszer
      // leállította a beágyazott böngészőt. A HELYI (data:/blob:) képekhez
      // viszont nincs hálózati kérés, ott az eager nem árt (2.5.264, #11).
      loading={eagerLocal ? 'eager' : 'lazy'}
      decoding="async"
      // 2.5.257/2.5.259: HU csatornánál (saját VAGY szolgáltatói logó) a képet
      // egyszer letöltve data-URL-ként is elmentjük a localStorage-ba (nem-HU
      // úton változatlan a CacheStorage).
      onLoad={() => {
        settledRef.current = true;
        if (cacheable) void cacheHuLogoDataUrl(source);
        else void saveCachedLogo(source);
      }}
      onError={() => { settledRef.current = true; advanceFailure(); }}
    />
  );
};
