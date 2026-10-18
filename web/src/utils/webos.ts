/**
 * LG webOS TV detektálás és optimalizáció
 * - Kisebb TV lejátszó
 * - Gyors betöltés (csak élő TV először)
 * - Fekvő splash videó
 */

export function isWebOSTV(): boolean {
  if (typeof window === 'undefined') return false;
  
  // webOS detektálás több módon
  const ua = navigator.userAgent || '';
  const isWebOSUA = /Web0S|webOS|WebOS/i.test(ua);
  const hasWebOS = !!(window as any).webOS;
  const hasWebOSFastLoad = !!(window as any).WEBOS_FAST_LOAD;
  const isWebOSClass = document.body?.classList.contains('webos-tv') || document.body?.classList.contains('lg-webos');
  const isLG = /LG/i.test(ua) && /SmartTV|TV/i.test(ua);
  
  return isWebOSUA || hasWebOS || hasWebOSFastLoad || isWebOSClass || isLG;
}

export function isWebOSFastLoad(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as any).WEBOS_FAST_LOAD || isWebOSTV();
}

export function isWebOSSmallPlayer(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as any).WEBOS_SMALL_PLAYER || isWebOSTV();
}

export function isLandscapeSplash(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as any).WEBOS_LANDSCAPE_SPLASH || isWebOSTV();
}

// webOS TV-n a lejátszó kisebb legyen (1280x720 alapértelmezett, de reszponzív)
export function getWebOSPlayerSize(): { width: number; height: number } {
  if (!isWebOSTV()) return { width: 1920, height: 1080 };
  
  // LG webOS TV-k általában 1920x1080, de a lejátszó lehet kisebb a gyorsabb betöltéshez
  // A kisebb lejátszó kevesebb erőforrást használ és gyorsabban indul
  return { width: 1280, height: 720 };
}

// Gyors betöltés konfig webOS-re
export function getWebOSLoadConfig() {
  if (!isWebOSFastLoad()) {
    return {
      liveOnlyInitially: false,
      vodLazyLoad: false,
      maxConcurrent: 2,
      progressUpdateInterval: 500,
    };
  }
  
  return {
    liveOnlyInitially: true,  // Csak élő TV először, VOD lusta
    vodLazyLoad: true,        // Film/sorozat csak akkor töltődik ha kell
    maxConcurrent: 3,         // webOS-en lehet több concurrent mert erősebb a TV
    progressUpdateInterval: 1000, // Ritkább UI frissítés a gyorsabb betöltéshez
    smallPlayer: true,
  };
}

// webOS Magic Remote gombok
export const WEBOS_KEYS = {
  BACK: 461,
  CHANNEL_UP: 33,
  CHANNEL_DOWN: 34,
  RED: 403,
  GREEN: 404,
  YELLOW: 405,
  BLUE: 406,
  REWIND: 412,
  STOP: 413,
  PLAY: 415,
  PAUSE: 19,
  FAST_FORWARD: 417,
  INFO: 457,
  PROGRAM_LIST: 458,
} as const;
