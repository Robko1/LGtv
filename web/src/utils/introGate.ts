import { useEffect, useState } from 'react';

/**
 * INDULÓ (BEJELENTKEZŐ) VIDEÓ – kapu a lejátszás előtt.
 *
 * MIÉRT KELL EZ (a TV-n tapasztalt hiba oka):
 * a főoldal a #root-on belül azonnal felépül, és a VideoPlayer rögtön
 * beállítja a kiválasztott csatorna `video.src`-jét. A webOS TV-n viszont
 * csak 1-2 hardveres videó-dekóder van: amíg az induló videó fut, a csatorna
 * elindítása ELVESZI tőle a dekódert. Ettől az induló videó 3-5 másodpercnél
 * megfagyott/leállt (a TV ilyenkor `ended`/`stalled` állapotba kerül), és a
 * felület „átugrott” a főoldalra – a videó soha nem játszódott végig.
 *
 * Ezért a lejátszás (a stream betöltése) addig NEM indul el, amíg az
 * index.html-ben futó induló videó véget nem ér. A felület közben láthatatlanul
 * felépül a videó alatt, tehát a végén minden készen áll.
 */

export const INTRO_DONE_EVENT = 'iptv-intro-done';

/** Fut-e még az induló videó? (Az index.html állítja be.) */
export function isIntroActive(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as unknown as { __IPTV_INTRO_ACTIVE__?: boolean }).__IPTV_INTRO_ACTIVE__ === true;
}

/**
 * `true`, amikor az induló videó már véget ért (vagy nem is volt).
 * - az index.html eseményt küld (`iptv-intro-done`) az overlay eltűnésekor
 * - biztonsági háló: ha az esemény valamiért elmarad, 15 mp után engedünk
 */
export function useIntroFinished(): boolean {
  const [finished, setFinished] = useState<boolean>(() => !isIntroActive());

  useEffect(() => {
    if (finished) return;
    const done = () => setFinished(true);
    window.addEventListener(INTRO_DONE_EVENT, done);
    const safety = window.setTimeout(done, 15000);
    return () => {
      window.removeEventListener(INTRO_DONE_EVENT, done);
      window.clearTimeout(safety);
    };
  }, [finished]);

  return finished;
}
