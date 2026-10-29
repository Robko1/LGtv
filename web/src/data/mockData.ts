import { AppSettings } from '../types/iptv';

/**
 * Alapértékek valódi szolgáltatói adatok nélkül.
 * Szándékosan nincs demócsatorna, próbasugárzás, Unsplash-kép vagy előre
 * beállított szolgáltatói fiók. A logókat kizárólag az importált szolgáltató
 * stream_icon / tvg-logo mezőjéből szabad megjeleníteni.
 */
export const INITIAL_SETTINGS: AppSettings = {
  bufferMode: 'balanced',
  // Alapértelmezés: beépített HTML5 lejátszó (ez a legmegbízhatóbb minden TV-n).
  playerEngine: 'html5',
  streamFormat: 'ts',
  // Csatornalista: Xtream API (JSON) az alapértelmezés.
  channelLoadMode: 'api',
  zappingDelay: 0,
  // 0 = a készülék órája (kézi eltolás a Beállításokban állítható).
  clockOffsetHours: 0,
  autoPlayLastChannel: true,
  closeListOnZap: true,
  alwaysShowBlueClock: true,
  // Az eltűnő OSD ideje: 6 / 8 / 10 / 12 másodperc választható (alap: 8).
  osdHideDelay: 8,
  // Alapból normál (nem tükrözött) elrendezés; a PIROS gomb kapcsolja.
  mirrorLayout: false,
  // Fekvő teljes képernyőben a kép vízszintesen kitöltse a képernyőt – alapértelmezés Nyújtás (fill),
  // A beállítás csatornaváltáskor is érvényben marad.
  aspectRatio: 'fill',
  seekStep: 10,
  autoNextEpisode: true,
  preferredAudioLang: 'Magyar',
  preferredSubtitle: 'Magyar',
  subtitleSize: '100%',
  activeProviderId: '',
  corsProxy: 'https://api.allorigins.win/raw?url=',
  tvDoctorEnabled: true,
};
