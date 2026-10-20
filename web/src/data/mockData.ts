import { AppSettings } from '../types/iptv';

/**
 * Alapértékek valódi szolgáltatói adatok nélkül.
 * Szándékosan nincs demócsatorna, próbasugárzás, Unsplash-kép vagy előre
 * beállított szolgáltatói fiók. A logókat kizárólag az importált szolgáltató
 * stream_icon / tvg-logo mezőjéből szabad megjeleníteni.
 */
export const INITIAL_SETTINGS: AppSettings = {
  bufferMode: 'stable',
  playerEngine: 'html5',
  zappingDelay: 600,
  autoPlayLastChannel: true,
  closeListOnZap: true,
  swipeToZap: true,
  alwaysShowBlueClock: true,
  osdHideDelay: 5,
  // Fekvő teljes képernyőben a kép vízszintesen kitöltse a képernyőt – alapértelmezés Nyújtás (fill),
  // ugyanúgy, mint állóban a telefon széléig. Minden csatornaváltáskor automatikusan újra alkalmazva.
  aspectRatio: 'fill',
  seekStep: 10,
  autoNextEpisode: true,
  preferredAudioLang: 'Magyar',
  preferredSubtitle: 'Magyar',
  subtitleSize: '100%',
  activeProviderId: '',
  corsProxy: 'https://api.allorigins.win/raw?url=',
};
