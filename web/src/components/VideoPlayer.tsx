import React, { useRef, useEffect, useState, useCallback } from 'react';
import { AudioTrack, Channel, AppSettings, SubtitleTrack } from '../types/iptv';
import { Play, Pause, Volume2, VolumeX, Rewind, FastForward, PictureInPicture2, Languages, Captions, Cast, Clock, Film, X, Mic2, Check } from 'lucide-react';
import { appLog } from '../services/appLog';
import { normalizeTvKey } from '../utils/tvKeys';

interface NativeApi {
  play?: (url: string, title?: string) => void;
  stop?: () => void;
  pause?: () => void;
  togglePause?: () => void;
  setVolume?: (value: number) => void;
  getSystemVolume?: () => number;
  setSystemVolume?: (value: number) => void;
  position?: () => number;
  duration?: () => number;
  seekTo?: (ms: number) => void;
  pip?: () => void;
  toast?: (message: string) => void;
  /** Külön kék, logós felugró kizárólag az automatikus újrapróbálkozásokhoz. */
  retryToast?: (message: string) => void;
  setVideoBounds?: (x: number, y: number, width: number, height: number, viewportWidth?: number) => void;
  setAspectRatio?: (mode: 'contain' | 'cover' | 'fill') => void;
  setLiveLandscapeFullscreen?: (enabled: boolean) => void;
  /** Élő adás vagy film/sorozat fut-e. */
  setLiveStreamHint?: (live: boolean) => void;
  setSubtitleScale?: (scale: number) => void;
  setBufferMode?: (mode: string) => void;
  cast?: (url: string, title?: string, live?: boolean, position?: number) => boolean;
  isCastAvailable?: () => boolean;
  castState?: () => {
    available?: boolean;
    connected?: boolean;
    playing?: boolean;
    device?: string;
    error?: string;
  } | null;
  setFullscreen?: (on: boolean) => void;
  mediaTracks?: () => Array<{ index: number; mpvId?: number; type: 'audio' | 'subtitle'; name: string; lang: string; selected?: boolean }> | string;
  selectTrack?: (type: 'audio' | 'subtitle', index: number) => void;
  selectTrackById?: (type: 'audio', mpvId: number, fallbackIndex?: number) => boolean | void;
  deselectTrack?: (type: 'subtitle', index: number) => void;
  on?: (callback: (event: { type?: string; message?: string; mode?: string; connected?: boolean }) => void) => void;
  /** A natív eseményfigyelő leiratkozása. */
  off?: (callback: (event: { type?: string; message?: string; mode?: string }) => void) => void;
}

function nativeApi(): NativeApi | null {
  // LG webOS-en a régi natív híd nem használható; a lejátszás HTML5 videón fut.
  return null;
}

function readNativeMediaTracks(api: NativeApi | null) {
  try {
    const raw = api?.mediaTracks?.();
    const tracks = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(tracks) ? tracks as Array<{ index: number; mpvId?: number; type: 'audio' | 'subtitle'; name: string; lang: string; selected?: boolean }> : [];
  } catch {
    return [];
  }
}

/**
 * Kék óra a lejátszóban.
 *
 * Saját komponens, saját 1 másodperces időzítővel: így a másodpercenkénti
 * állapotváltozás csak ezt a néhány csomópontot rajzolja újra, nem a teljes
 * (nagy) lejátszó felületet. Korábban ez a lejátszó gyökérállapotában volt,
 * ezért a TV-n másodpercenként újrarajzolódott az egész OSD.
 */
const BlueClock: React.FC<{ className?: string }> = ({ className }) => {
  const [time, setTime] = useState('');
  useEffect(() => {
    const update = () => {
      const now = new Date();
      setTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
    };
    update();
    const timer = window.setInterval(update, 1000);
    const onVisibility = () => {
      if (!document.hidden) update();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return (
    <div
      data-blue-clock
      className={className}
      aria-label={`Pontos idő: ${time}`}
    >
      <Clock className="h-7 w-7 shrink-0 text-cyan-300" />
      <span>{time || '00:00'}</span>
    </div>
  );
};

interface VideoPlayerProps {
  channel: Channel | null;
  customStreamUrl?: string;
  customTitle?: string;
  audioTracks?: AudioTrack[];
  subtitleTracks?: SubtitleTrack[];
  settings: AppSettings;
  onNextChannel?: () => void;
  onPrevChannel?: () => void;
  onOpenSettings?: () => void;
  onOverlayVisibilityChange?: (visible: boolean) => void;
  isPlaying: boolean;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  volume: number;
  onVolumeChange: (value: number) => void;
  onToggleMute: () => void;
  onRegisterTogglePlay?: (togglePlay: (() => void) | null) => void;
  onRegisterCast?: (castToTv: (() => void) | null) => void;
  onRegisterPip?: (togglePip: (() => void) | null) => void;
  onAudioTracksChange?: (tracks: AudioTrack[]) => void;
  onRegisterAudioTrackSelector?: (selector: ((track: AudioTrack) => void) | null) => void;
  onSubtitleTracksChange?: (tracks: SubtitleTrack[]) => void;
  onRegisterSubtitleTrackSelector?: (selector: ((track: SubtitleTrack | null) => void) | null) => void;
  /** Teljes képernyő be/ki – a főoldali, teljes képernyős OSD-hez. */
  onFullscreenChange?: (fullscreen: boolean) => void;
  /** Az OSD ki-/bekapcsolása (a teljes képernyős OSD ✕ gombjához). */
  onRegisterOsdToggle?: (toggle: (() => void) | null) => void;
  /** Film/sorozat lejátszásának bezárása és visszatérés a kiválasztási kategóriához. */
  onCloseVod?: () => void;
  /**
   * A lejátszás végének jelzése (film/sorozat vége).
   *
   * A natív lejátszó a lejátszás végén `ended` eseményt küld, és bezárja a
   * saját ablakát. Korábban ezt senki nem figyelte, ezért a „következő rész
   * automatikus indítása” beállítás nem működött – ez most helyreállt.
   */
  onEnded?: () => void;
  initialPositionSeconds?: number;
  onProgress?: (positionSeconds: number, durationSeconds: number) => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  channel,
  customStreamUrl,
  customTitle,
  audioTracks: providedAudioTracks,
  subtitleTracks: providedSubtitleTracks,
  settings,
  onNextChannel,
  onPrevChannel,
  onOverlayVisibilityChange,
  isPlaying,
  setIsPlaying,
  volume,
  onVolumeChange,
  onToggleMute,
  onRegisterTogglePlay,
  onRegisterCast,
  onRegisterPip,
  onFullscreenChange,
  onRegisterOsdToggle,
  onCloseVod,
  onAudioTracksChange,
  onRegisterAudioTrackSelector,
  onSubtitleTracksChange,
  onRegisterSubtitleTrackSelector,
  initialPositionSeconds = 0,
  onProgress,
  onEnded,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoSurfaceRef = useRef<HTMLDivElement | null>(null);
  const htmlVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = htmlVideoRef.current;
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, volume));
    video.muted = volume <= 0;
  }, [volume]);

  useEffect(() => {
    const video = htmlVideoRef.current;
    if (!video || nativeApi()?.play || !video.currentSrc) return;
    if (isPlaying && video.paused) {
      void video.play().catch(() => {
        setIsLoading(false);
        setHasError(true);
        setErrorMessage('A TV nem engedélyezte a lejátszás indítását.');
      });
    } else if (!isPlaying && !video.paused) {
      video.pause();
    }
  }, [isPlaying]);
  const vodOsdRef = useRef<HTMLDivElement | null>(null);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasError, setHasError] = useState<boolean>(false);
  const [, setErrorMessage] = useState<string>('');
  // Lejátszáskor először MPEG-TS, hiba esetén egyszer HLS, majd még egyszer MPEG-TS.
  // Ha a második MPEG-TS-próba is hibázik, nincs további automatikus váltogatás.
  const autoRetryTimerRef = useRef<number | null>(null);
  const retryStreamRef = useRef<(() => void) | null>(null);
  const pendingStreamUrlRef = useRef('');
  const retryPlanRef = useRef<{ originalUrl: string; stage: 'primary' | 'hls' | 'final-ts' }>({
    originalUrl: '',
    stage: 'primary',
  });
  const bufferWatchdogRef = useRef<number | null>(null);
  const playbackStartedRef = useRef(false);
  // Hibaképernyőn a sárga kijelölés automatikusan az Újrapróbálás gombra
  // ugrik - eddig távirányítóval nem lehetett elérni.
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  // PUFFERELÉS BEKÖTVE (Rendszer menü: Gyors/Kiegyensúlyozott/Stabil):
  // a zap-őr és az automatikus formátumváltás időzítése ehhez igazodik.
  const bufferModeRef = useRef(settings.bufferMode);
  bufferModeRef.current = settings.bufferMode;
  /**
   * LEJÁTSZÓ MOTOR (Beállítások → Rendszer → Lejátszó).
   *
   *  - 'html5'  : a beépített lejátszó. Élő adásnál először HLS-t próbál,
   *               hiba/elakadás esetén magától MPEG-TS-re vált (zap-őr).
   *  - 'native' : a TV hardveres dekóderére támaszkodó közvetlen mód: a
   *               szolgáltató által adott URL-t változtatás nélkül játssza
   *               (MPEG-TS), nem írja át .m3u8-ra és nem váltogatja a
   *               formátumot, a felület pedig visszafogott (nincs
   *               elmosás/animáció a kép fölött).
   *
   * A választás a beállításokban tárolódik, így újraindítás után is megmarad.
   */
  const playerEngine: 'html5' | 'native' = settings.playerEngine === 'native' ? 'native' : 'html5';
  const playerEngineRef = useRef(playerEngine);
  playerEngineRef.current = playerEngine;
  /** Natív módban hányszor próbáltuk újraindítani ugyanazt a címet. */
  const nativeRetryCountRef = useRef(0);
  const bufferTiming = () => {
    const mode = bufferModeRef.current;
    if (mode === 'fast') return { watchdogMs: 2500, retryMs: 150 };
    if (mode === 'stable') return { watchdogMs: 7000, retryMs: 450 };
    return { watchdogMs: 4000, retryMs: 250 };
  };
  const scheduleAutoRetry = useCallback(() => {
    if (autoRetryTimerRef.current !== null) return;
    // Natív mód: a TV dekódere a szolgáltató eredeti URL-jét kapja, ezért itt
    // nincs formátumváltás (az csak a beépített HLS-lejátszó sajátja). Rövid
    // elakadásnál viszont ugyanazt a címet még kétszer újraindítjuk, hogy egy
    // pillanatnyi hálózati hiba ne dobjon hibaképernyőre.
    if (playerEngineRef.current === 'native') {
      if (nativeRetryCountRef.current >= 2) {
        setIsLoading(false);
        setHasError(true);
        setErrorMessage('A natív lejátszó nem tudta megnyitni az adást. Próbáld újraindítani, vagy válts vissza a beépített lejátszóra a Beállításokban.');
        return;
      }
      nativeRetryCountRef.current += 1;
      pendingStreamUrlRef.current = retryPlanRef.current.originalUrl || pendingStreamUrlRef.current;
      setHasError(false);
      setIsLoading(true);
      autoRetryTimerRef.current = window.setTimeout(() => {
        autoRetryTimerRef.current = null;
        retryStreamRef.current?.();
      }, bufferTiming().retryMs);
      return;
    }
    const plan = retryPlanRef.current;
    let nextUrl = '';
    let nextStage: 'hls' | 'final-ts' | null = null;

    if (plan.stage === 'primary' && /\.ts(?=([?#]|$))/i.test(plan.originalUrl)) {
      nextUrl = plan.originalUrl.replace(/\.ts(?=([?#]|$))/i, '.m3u8');
      nextStage = 'hls';
    } else if (plan.stage === 'hls') {
      nextUrl = plan.originalUrl;
      nextStage = 'final-ts';
    }

    if (!nextUrl || !nextStage) {
      setIsLoading(false);
      setHasError(true);
      setErrorMessage('A TV böngészője nem tudta lejátszani ezt az adatfolyamot.');
      return;
    }

    retryPlanRef.current = { ...plan, stage: nextStage };
    pendingStreamUrlRef.current = nextUrl;
    nativeApi()?.retryToast?.(nextStage === 'hls' ? 'MPEG-TS sikertelen – HLS próba' : 'HLS sikertelen – MPEG-TS újrapróba');
    setHasError(false);
    setIsLoading(true);
    autoRetryTimerRef.current = window.setTimeout(() => {
      autoRetryTimerRef.current = null;
      retryStreamRef.current?.();
    }, bufferTiming().retryMs);
  }, []);
  useEffect(() => {
    if (!hasError) return;
    const timer = window.setTimeout(() => {
      try { retryButtonRef.current?.focus({ preventScroll: true }); } catch { /* fókusz nélkül is kattintható */ }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [hasError]);
  const clearAutoRetry = useCallback((_resetCount = true) => {
    if (autoRetryTimerRef.current !== null) {
      window.clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }
  }, []);
  // A VOD/live állapotot az azt használó callbackek előtt deklaráljuk.
  const isVod = Boolean(customStreamUrl);
  const clearBufferWatchdog = useCallback(() => {
    if (bufferWatchdogRef.current !== null) {
      window.clearTimeout(bufferWatchdogRef.current);
      bufferWatchdogRef.current = null;
    }
  }, []);
  const armBufferWatchdog = useCallback(() => {
    // Pufferelés közben ne indítsunk automatikus újracsatlakozást:
    // ez élő adásnál végtelen újratöltési ciklust okozhat. A lejátszó
    // kapjon időt a saját pufferének feltöltésére és a folytatásra.
    // A watchdog csak a korábban ütemezett időzítőt törli.
    clearBufferWatchdog();
  }, [clearBufferWatchdog]);
  const isMuted = volume <= 0;

  // A HTML5 videót a React-komponens eltűnésekor nézetváltáskor
  // ténylegesen leállítjuk, és elrejtjük a natív videófelületet. Visszatéréskor
  // a komponens az App által megőrzött utolsó élő csatornát tölti be újra.
  useEffect(() => {
    return () => {
      const api = nativeApi();
      api?.stop?.();
      api?.setVideoBounds?.(0, 0, 0, 0);
      api?.setFullscreen?.(false);
    };
  }, []);

  const supportsPictureInPicture = Boolean(
    (document as any).pictureInPictureEnabled &&
    htmlVideoRef.current &&
    typeof (htmlVideoRef.current as any).requestPictureInPicture === 'function'
  );
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isPortrait, setIsPortrait] = useState<boolean>(false);
  useEffect(() => {
    let frame = 0;
    let settleTimer: number | null = null;
    const updateOrientation = () => {
      const viewport = window.visualViewport;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      setIsPortrait(height >= width);
    };
    const scheduleOrientationUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        updateOrientation();
        frame = window.requestAnimationFrame(updateOrientation);
      });
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      // webOS TV viewport-váltás reports its final viewport a little later.
      settleTimer = window.setTimeout(updateOrientation, 180);
    };
    updateOrientation();
    window.addEventListener('resize', scheduleOrientationUpdate);
    window.addEventListener('orientationchange', scheduleOrientationUpdate);
    window.visualViewport?.addEventListener('resize', scheduleOrientationUpdate);
    return () => {
      window.cancelAnimationFrame(frame);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      window.removeEventListener('resize', scheduleOrientationUpdate);
      window.removeEventListener('orientationchange', scheduleOrientationUpdate);
      window.visualViewport?.removeEventListener('resize', scheduleOrientationUpdate);
    };
  }, []);
  const [showControlsOverlay, setShowControlsOverlay] = useState<boolean>(true);
  const [activeUrlIndex, setActiveUrlIndex] = useState<number>(0);

  // A kiválasztott adás URL-je. FONTOS: minden felhasználó (a lenti
  // useEffect-ek és a castToTv) előtt kell szerepelnie, különben a React
  // renderelés közben "Cannot access 'streamUrl' before initialization"
  // hibával elhasal, és üres (fekete) képernyő marad.
  const streamUrl = customStreamUrl || (channel ? (activeUrlIndex === 0 ? channel.streamUrl : (channel.fallbackUrl || channel.streamUrl)) : '');

  // Film/sorozat indításakor teljes képernyőre váltunk. Bezáráskor
  // visszaállítjuk a normál nézetet is, hogy az App felső menüsora újra megjelenjen.
  useEffect(() => {
    if (isVod) {
      setIsFullscreen(true);
      setShowControlsOverlay(true);
    } else {
      setIsFullscreen(false);
      setShowControlsOverlay(true);
    }
  }, [isVod]);
  const [vodOsdHeight, setVodOsdHeight] = useState<number>(0);
  const [showFullscreenEpg, setShowFullscreenEpg] = useState<boolean>(false);
  const osdHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [vodTrackMenu, setVodTrackMenu] = useState<'audio' | 'subtitle' | null>(null);

  /**
   * Az OSD viselkedése új specifikáció szerint:
   * - Élő TV főoldal (nem fullscreen): dupla gyors kattintás -> álló teljes képernyő (16:9 keret)
   * - Élő TV álló fullscreen: egy kattintás -> OSD fel és eltűnik beállítás szerint, dupla -> vissza főoldal
   * - Élő TV fekvő fullscreen: egy kattintás semmi, dupla -> vissza főoldal
   * - Mozi/sorozat álló: egy kattintás -> OSD fel és eltűnik beállítás szerint, semmi más
   * - Mozi/sorozat fekvő: semmilyen kattintásra semmi funkció
   */
  const isLive = !isVod;
  // TV: a csatornalistáról érkező kérés (OK a már futó csatornán) indítja a
  // teljes képernyős nézetet - a lejátszó dobozból indítás megszűnt.
  useEffect(() => {
    const enterFs = () => {
      if (isLive) setIsFullscreen(true);
    };
    window.addEventListener('iptv-enter-fullscreen', enterFs);
    return () => window.removeEventListener('iptv-enter-fullscreen', enterFs);
  }, [isLive]);

  // Teljes képernyőn body-osztály jelzi a TV-s CSS-nek, hogy a főoldali
  // elemek (fejléc, óra doboz) teljesen tűnjenek el - a bal felső sarokban
  // átlátszó kék doboz ikon ennek a hiánya miatt látszott.
  useEffect(() => {
    try {
      document.body.classList.toggle('iptv-tv-fullscreen', isFullscreen);
    } catch { /* SSR/teszt környezet */ }
    return () => {
      try { document.body.classList.remove('iptv-tv-fullscreen'); } catch {}
    };
  }, [isFullscreen]);

  // Teljes képernyőn a fókusz a lejátszóra kerül (így az OK/Vissza azonnal
  // kilép), kilépés után pedig visszatér a csatornalistára.
  const wasFullscreenRef = useRef(false);
  useEffect(() => {
    if (isFullscreen) {
      wasFullscreenRef.current = true;
      window.requestAnimationFrame(() => {
        containerRef.current?.focus({ preventScroll: true } as any);
      });
    } else if (wasFullscreenRef.current) {
      wasFullscreenRef.current = false;
      window.requestAnimationFrame(() => {
        const list = document.querySelector<HTMLElement>('[role="listbox"]');
        if (list) list.focus({ preventScroll: true } as any);
      });
    }
  }, [isFullscreen]);
  const isLivePortraitFullscreen = isLive && isFullscreen && isPortrait;
  const isLiveLandscapeFullscreen = isLive && isFullscreen && !isPortrait;
  const isVodPortraitFullscreen = isVod && isFullscreen && isPortrait;
  const isVodLandscapeFullscreen = isVod && isFullscreen && !isPortrait;
  // Régi név kompatibilitáshoz megtartva, de most csak live landscape
  const landscapeLiveFullscreen = isLiveLandscapeFullscreen;
  // OSD csak álló fullscreenben jelenhet meg (élő és VOD is)
  const canToggleOsd = isLivePortraitFullscreen || isVodPortraitFullscreen;

  useEffect(() => {
    // Álló teljes képernyőben induláskor látszódjon az OSD, majd tűnjön el beállítás szerint
    if (isLivePortraitFullscreen || isVodPortraitFullscreen) {
      setShowControlsOverlay(true);
    } else if (isLiveLandscapeFullscreen || isVodLandscapeFullscreen) {
      // Fekvőben alapból rejtett, és nem is hozható elő kattintásra
      setShowControlsOverlay(false);
    } else if (isFullscreen && !isVod) {
      // Biztonsági fallback
      setShowControlsOverlay(true);
    }
  }, [isLivePortraitFullscreen, isVodPortraitFullscreen, isLiveLandscapeFullscreen, isVodLandscapeFullscreen, isFullscreen, isVod]);

  // Képarány mindig fill (nyújtás) – a beállításokból kivettük, de a natív rétegnek mindig fill kell
  useEffect(() => {
    const api = nativeApi();
    if (!api?.setAspectRatio) return;
    // Minden esetben fill, hogy a kép kitöltse a 16:9 keretet állóban és a teljes képernyőt fekvőben
    api.setAspectRatio('fill');
    // Ha a mentett beállítás nem fill, frissítjük csendben
    if (settings.aspectRatio !== 'fill') {
      window.dispatchEvent(new CustomEvent('iptv-native-aspect-ratio', { detail: 'fill' }));
    }
  }, [isFullscreen, isPortrait, isVod, settings.aspectRatio, streamUrl]);
  useEffect(() => {
    if (osdHideTimerRef.current) {
      clearTimeout(osdHideTimerRef.current);
      osdHideTimerRef.current = null;
    }
    if (!canToggleOsd) {
      // A normál főoldali nézeten az OSD maradjon úgy, ahogy korábban működött.
      if (!isFullscreen && !isVod) {
        setShowControlsOverlay(true);
      } else if (showControlsOverlay) {
        setShowControlsOverlay(false);
      }
      return;
    }
    if (isVodPortraitFullscreen && vodTrackMenu !== null) return;
    if (settings.osdHideDelay > 0 && showControlsOverlay) {
      osdHideTimerRef.current = setTimeout(() => {
        setShowControlsOverlay(false);
        osdHideTimerRef.current = null;
      }, settings.osdHideDelay * 1000);
    }
    return () => {
      if (osdHideTimerRef.current) {
        clearTimeout(osdHideTimerRef.current);
        osdHideTimerRef.current = null;
      }
    };
  }, [canToggleOsd, showControlsOverlay, settings.osdHideDelay, isVodPortraitFullscreen, vodTrackMenu]);

  useEffect(() => {
    onOverlayVisibilityChange?.(showControlsOverlay);
  }, [showControlsOverlay, onOverlayVisibilityChange]);

  // A teljes képernyő állapotát a főoldal is megkapja (teljes képernyős OSD),
  // a natív réteg pedig ilyenkor teljes képernyős (immersive) üzemmódba kerül.
  useEffect(() => {
    onFullscreenChange?.(isFullscreen);
    nativeApi()?.setFullscreen?.(isFullscreen);
  }, [isFullscreen, onFullscreenChange]);

  // Új érintés/kattintás logika a felhasználó kérése szerint
  const suppressNextClickRef = useRef(false);
  const singleTapTimerRef = useRef<number | null>(null);
  const lastTapTimeRef = useRef(0);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const mouseDragStartRef = useRef<{ x: number; y: number } | null>(null);

  const cancelPendingTap = () => {
    if (singleTapTimerRef.current !== null) {
      window.clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
    }
  };
  useEffect(() => () => cancelPendingTap(), []);

  // Egyszeri kattintás kezelése
  const handleSingleTap = useCallback(() => {
    // VOD fekvő: semmilyen kattintásra semmi
    if (isVodLandscapeFullscreen) return;
    // VOD álló: egy kattintás OSD fel és beállítás szerint eltűnik
    if (isVodPortraitFullscreen) {
      setShowControlsOverlay(true);
      return;
    }
    // Élő fekvő: egy kattintásra semmi
    if (isLiveLandscapeFullscreen) return;
    // Élő álló fullscreen: egy kattintás OSD fel
    if (isLivePortraitFullscreen) {
      setShowControlsOverlay(true);
      if (osdHideTimerRef.current) clearTimeout(osdHideTimerRef.current);
      osdHideTimerRef.current = settings.osdHideDelay > 0
        ? setTimeout(() => {
            setShowControlsOverlay(false);
            osdHideTimerRef.current = null;
          }, settings.osdHideDelay * 1000)
        : null;
      return;
    }
    // Élő főoldal (nem fullscreen): egy kattintásra semmi
  }, [isVodLandscapeFullscreen, isVodPortraitFullscreen, isLiveLandscapeFullscreen, isLivePortraitFullscreen, settings.osdHideDelay]);

  // Dupla gyors kattintás kezelése
  const handleDoubleTap = useCallback(() => {
    // VOD fekvő: semmi
    if (isVodLandscapeFullscreen) return;
    // VOD álló: dupla kattintásra semmi extra, csak OSD maradjon (ne lépjen ki)
    if (isVodPortraitFullscreen) {
      setShowControlsOverlay(true);
      return;
    }
    // Élő: dupla kattintás vált a főoldal és az álló teljes képernyő között, fekvőben is vissza főoldalra
    if (isLive) {
      if (!isFullscreen) {
        // Főoldalról dupla kattintás -> álló teljes képernyő (portrait 16:9 keret)
        setIsFullscreen(true);
      } else {
        // Teljes képernyőből (álló vagy fekvő) dupla kattintás -> vissza főoldalra.
        // Fekvő fullscreenben az OSD rejtve van; kilépéskor explicit visszaállítjuk,
        // hogy a főoldali ChannelControls azonnal újra megjelenjen.
        setShowControlsOverlay(true);
        setIsFullscreen(false);
      }
      return;
    }
  }, [isVodLandscapeFullscreen, isVodPortraitFullscreen, isLive, isFullscreen]);

  const handleSurfaceTap = (event?: React.MouseEvent | React.KeyboardEvent) => {
    event?.stopPropagation();
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    const now = Date.now();
    const diff = now - lastTapTimeRef.current;
    if (diff > 0 && diff < 300) {
      // Dupla gyors kattintás
      if (singleTapTimerRef.current !== null) {
        window.clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      lastTapTimeRef.current = 0;
      handleDoubleTap();
      return;
    }
    lastTapTimeRef.current = now;
    singleTapTimerRef.current = window.setTimeout(() => {
      singleTapTimerRef.current = null;
      lastTapTimeRef.current = 0;
      handleSingleTap();
    }, 300) as unknown as number;
  };

  // Egér mozgásra csak álló fullscreenben mutassuk az OSD-t (desktop), fekvőben semmi
  const handleMouseMove = useCallback(() => {
    if (isLiveLandscapeFullscreen || isVodLandscapeFullscreen) return;
    if (canToggleOsd && !showControlsOverlay) {
      // Csak álló fullscreenben egér mozgásra is jöjjön OSD
      setShowControlsOverlay(true);
    }
  }, [isLiveLandscapeFullscreen, isVodLandscapeFullscreen, canToggleOsd, showControlsOverlay]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // LG webOS: régi kulcsnév ('Up') vagy csak keyCode (37-40, OK=13, VISSZA=461) is jöhet.
    const key = normalizeTvKey(e);
    if (key === ' ' || key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (key === ' ' && isLive) {
        const api = nativeApi();
        const video = htmlVideoRef.current;
        if (api?.togglePause) api.togglePause();
        else if (video?.paused) void video.play().catch(() => undefined);
        else video?.pause();
      } else if (key === 'Enter' && isLive && isFullscreen) {
        // TV: teljes képernyőben EGYETLEN OK gomb visszalép a főoldalra
        // (a Vissza gomb mellett). A dobozból indítás funkció megszűnt.
        setIsFullscreen(false);
      } else {
        // Enter = OSD vagy dupla logika szerint
        handleSurfaceTap(e);
      }
    } else if ((key === 'ArrowLeft' || key === 'ArrowRight') && !isFullscreen) {
      // A fókusz NE ragadjon be a lejátszó felületén: balra/jobbra nyíllal
      // vissza lehet lépni a csatornalistára.
      e.preventDefault();
      e.stopPropagation();
      const list = document.querySelector<HTMLElement>('[role="listbox"]');
      if (list) list.focus({ preventScroll: true } as any);
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (isLive) onPrevChannel?.();
    } else if (key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (isLive) onNextChannel?.();
    } else if (key === 'Escape' || key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      if (isFullscreen) setIsFullscreen(false);
      else if (isVod) onCloseVod?.();
    } else if (key === 'f' || key === 'F') {
      e.preventDefault();
      e.stopPropagation();
      if (isLive) {
        if (!isFullscreen) setIsFullscreen(true);
        else setIsFullscreen(false);
      }
    }
  }, [isLive, isVod, isFullscreen, onPrevChannel, onNextChannel, onCloseVod]);
  const [nativeHandoff, setNativeHandoff] = useState<boolean>(false);
  const [, setNativeMessage] = useState<string>('');

  const [vodCurrentTime, setVodCurrentTime] = useState(0);
  const [vodDuration, setVodDuration] = useState(0);
  // Csúsztatás közben a 250 ms-os időzítő ne rángassa vissza a csúszkát.
  const vodSeekDraggingRef = useRef(false);
  const lastReportedProgressRef = useRef(-1);
  const resumeAppliedForUrlRef = useRef('');
  const [vodAudioTracks, setVodAudioTracks] = useState<AudioTrack[]>(providedAudioTracks || []);
  const [tvAudioTracks, setTvAudioTracks] = useState<AudioTrack[]>([]);
  /**
   * A felhasználó kézzel kiválasztott hangsávja.
   *
   * Amíg meg van adva, az automatikus (preferált nyelv szerinti) kiválasztás
   * nem írhatja felül – korábban előfordult, hogy egy háttérben frissülő
   * sávlista visszaváltotta a kért nyelvet.
   */
  // A legfrissebb lejátszás-vége kezelő (a natív eseményfigyelő egyszer kötődik be).
  const onEndedRef = useRef<(() => void) | undefined>(undefined);
  onEndedRef.current = onEnded;
  const userAudioChoiceRef = useRef<number | null>(null);
  const [, setShowTvAudioMenu] = useState(false);
  // A főoldali OSD-vel egyező hangerőgomb: egy kattintás némít, dupla kattintás csúszkát nyit.
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const volumeControlRef = useRef<HTMLDivElement | null>(null);
  const volumeClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (volumeClickTimer.current) clearTimeout(volumeClickTimer.current); }, []);
  useEffect(() => {
    if (!showVolumeSlider) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (volumeControlRef.current && !volumeControlRef.current.contains(event.target as Node)) {
        setShowVolumeSlider(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [showVolumeSlider]);
  const handleVolumeButtonClick = () => {
    if (showVolumeSlider) {
      if (volumeClickTimer.current) {
        clearTimeout(volumeClickTimer.current);
        volumeClickTimer.current = null;
      }
      setShowVolumeSlider(false);
      return;
    }
    if (volumeClickTimer.current) {
      clearTimeout(volumeClickTimer.current);
      volumeClickTimer.current = null;
      setShowVolumeSlider(true);
      return;
    }
    volumeClickTimer.current = setTimeout(() => {
      volumeClickTimer.current = null;
      onToggleMute();
    }, 260);
  };
  const [vodSubtitleTracks, setVodSubtitleTracks] = useState<SubtitleTrack[]>(providedSubtitleTracks || []);
  const [tvSubtitleTracks, setTvSubtitleTracks] = useState<SubtitleTrack[]>([]);

  // A film/sorozat OSD panel magassága. Natív lejátszásnál a natív videó
  // ennyivel rövidebb lesz, hogy az OSD – pontosan a főoldali kinézet –
  // látható maradjon a kép alatt (a natív kép egyébként elfedi a webes
  // felületet a videóablak területén).
  useEffect(() => {
    if (!isVod) {
      setVodOsdHeight(0);
      return;
    }
    const element = vodOsdRef.current;
    if (!element) return;
    const measure = () => {
      const height = Math.round(element.getBoundingClientRect().height);
      setVodOsdHeight((current) => (Math.abs(current - height) > 1 ? height : current));
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [isVod, streamUrl, showControlsOverlay, vodTrackMenu]);

  /**
   * A videóablak alján szabadon hagyott sáv (film/sorozat nem teljes képernyős nézetében).
   * Teljes képernyőben (álló és fekvő) az OSD a képen kívülre kerül vagy fölötte úszik,
   * ezért nem méretezzük át a képet – így álló teljes képernyőben is 16:9 keret marad
   * mint élő TV-nél (a felhasználó kérése).
   */
  const osdReserveForNative = Math.round(vodOsdHeight + 8);
  /**
   * Csak a film/sorozat NEM teljes képernyős nézetében hagyunk helyet az OSD-nek.
   * Teljes képernyőben (álló és fekvő) a kép kitölti a rendelkezésre álló területet:
   *  - állóban 16:9 keret középen (élő TV-vel azonos),
   *  - fekvőben teljes kijelző.
   */
  const nativeOsdReserve = nativeHandoff && showControlsOverlay && isVod && !isFullscreen
    ? Math.max(0, osdReserveForNative)
    : 0;

  // PiP-ből visszatéréskor a böngésző helyreállíthatja a lejátszó felületét,
  // de a React teljesképernyő-állapota különben a PiP előtti értéken maradhat.
  // Ez eltüntetheti a teljes képernyő gombot és a dupla koppintást is elronthatja.
  useEffect(() => {
    const api = nativeApi();
    if (!api?.on) return;
    const handler = (event: { type?: string; mode?: string }) => {
      if (event?.type !== 'pip-mode' || event.mode !== 'exited') return;
      cancelPendingTap();
      if (document.fullscreenElement) {
        const exitFullscreen = document.exitFullscreen?.();
        if (exitFullscreen) void exitFullscreen.catch(() => undefined);
      }
      setIsFullscreen(false);
      setShowControlsOverlay(true);
      setShowFullscreenEpg(false);
      window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    };
    api.on(handler);
    return () => {
      try { api.off?.(handler); } catch { /* leiratkozás nem támogatott */ }
    };
  }, []);

  // A natív videóra koppintva a webes OSD jelenik meg/elrejtődik – ugyanaz a
  // panel, mint a főoldalon (a natív lejátszó nem rajzol saját OSD-t).
  useEffect(() => {
    const api = nativeApi();
    if (!api?.on) return;
    const handler = (event: { type?: string }) => {
      if (!event || event.type !== 'osd-toggle') return;
      if (!canToggleOsd) return;
      setShowControlsOverlay((visible) => !visible);
    };
    api.on(handler);
    return () => {
      try {
        api.off?.(handler);
      } catch {
        /* leiratkozás nem támogatott */
      }
    };
  }, [canToggleOsd]);
  const [activeVodSubtitleId, setActiveVodSubtitleId] = useState<string | number | null>(null);
  const activeTvSubtitleIdRef = useRef<string | number | null>(null);
  const nativeSubtitleTrackSignatureRef = useRef('');
  const nativeSubtitleAutoSelectionKeyRef = useRef('');
  const pendingTvSubtitleSelectionRef = useRef<{ id: number | null; startedAt: number } | null>(null);
  const nativeAudioTrackSignatureRef = useRef('');
  const pendingTvAudioSelectionRef = useRef<{ index: number; startedAt: number } | null>(null);
  const [castStatus, setCastStatus] = useState<{ available: boolean; connected: boolean; device: string }>({
    available: false,
    connected: false,
    device: '',
  });

  // A kék óra saját, izolált komponens (lásd BlueClock a fájl elején), hogy a
  // másodpercenkénti frissítése NE rajzolja újra az egész lejátszó felületet.
  //
  // Az EPG-haladássáv időzítője itt korábban másodpercenként futott, de az
  // értékét a felület sem használta - csak felesleges újrarajzolást okozott
  // másodpercenként, ezért megszűnt.

  // A Cast állapotát (csatlakozva van-e TV, melyik) a natív hídtól kérdezzük.
  // Így a TV gomb nem „dísz”: látszik, hogy éppen melyik eszközre megy a kép.
  useEffect(() => {
    const api = nativeApi();
    if (!api?.castState) return;
    const update = () => {
      const state = api.castState?.();
      if (!state) return;
      setCastStatus({
        available: Boolean(state.available),
        connected: Boolean(state.connected),
        device: String(state.device || ''),
      });
    };
    update();
    const timer = window.setInterval(update, 2500);
    return () => window.clearInterval(timer);
  }, []);

  const castToTv = async () => {
    const url = streamUrl;
    if (!url) return;
    const native = nativeApi();
    if (!native?.cast) { native?.toast?.('A natív TV-küldés nem érhető el.'); return; }
    const currentTime = Number(native.position?.() || 0) / 1000;
    const started = native.cast(url, customTitle || channel?.name || 'IPTV R.T', !isVod, currentTime);
    if (!started) { native.toast?.('Nem sikerült elindítani a TV-küldést.'); return; }
    setShowControlsOverlay(true);
  };
  const showCastButton = Boolean(nativeApi());

  const castToTvRef = useRef(castToTv);
  castToTvRef.current = castToTv;
  useEffect(() => {
    if (!onRegisterCast) return;
    onRegisterCast(() => { void castToTvRef.current(); });
    return () => onRegisterCast(null);
  }, [onRegisterCast]);

  // Az OSD ki-/bekapcsolása a főoldal felé (teljes képernyős panel ✕ gombja).
  const osdToggleRef = useRef<() => void>(() => {});
  osdToggleRef.current = () => setShowControlsOverlay((previous) => !previous);
  useEffect(() => {
    if (!onRegisterOsdToggle) return;
    onRegisterOsdToggle(() => osdToggleRef.current());
    return () => onRegisterOsdToggle(null);
  }, [onRegisterOsdToggle]);

  // A webes felület normál hátterű; a HTML5 videó és az OSD ugyanabban a rétegben van.
  useEffect(() => {
    const root = document.getElementById('root');
    const appRoot = root?.firstElementChild as HTMLElement | null;
    const previousRootBackground = root?.style.backgroundColor || '';
    const previousAppBackground = appRoot?.style.backgroundColor || '';
    const previousBodyBackground = document.body.style.backgroundColor;
    if (nativeHandoff) {
      document.documentElement.setAttribute('data-native-player', '1');
      if (root) root.style.backgroundColor = 'transparent';
      if (appRoot) appRoot.style.backgroundColor = 'transparent';
      document.body.style.backgroundColor = 'transparent';
    } else {
      document.documentElement.removeAttribute('data-native-player');
      if (root) root.style.backgroundColor = previousRootBackground;
      if (appRoot) appRoot.style.backgroundColor = previousAppBackground;
      document.body.style.backgroundColor = previousBodyBackground;
    }
    return () => {
      document.documentElement.removeAttribute('data-native-player');
      if (root) root.style.backgroundColor = previousRootBackground;
      if (appRoot) appRoot.style.backgroundColor = previousAppBackground;
      document.body.style.backgroundColor = previousBodyBackground;
    };
  }, [nativeHandoff]);

  // A natív videófelület a konténer méretét követi – javítva a fekete képernyő hibára
  // amikor főoldalról dupla kattintással álló fullscreenbe váltunk, vagy forgatunk.
  useEffect(() => {
    const api = nativeApi();
    if (!api?.setVideoBounds) return;

    let lastX = Number.NaN;
    let lastY = Number.NaN;
    let lastWidth = Number.NaN;
    let lastHeight = Number.NaN;
    let lastViewport = Number.NaN;
    let lastHidden = false;
    let retryCount = 0;

    const syncBounds = () => {
      if (!nativeHandoff) {
        if (!lastHidden) {
          api.setVideoBounds?.(0, 0, 0, 0);
          lastHidden = true;
        }
        return;
      }
      const video = videoSurfaceRef.current;
      if (!video) return;
      const rect = video.getBoundingClientRect();
      // Ha 0 a méret, ne adjuk fel azonnal – próbáljuk újra később (fullscreen váltáskor átmeneti)
      if (rect.width <= 0 || rect.height <= 0) {
        if (retryCount < 8) {
          retryCount++;
          window.setTimeout(syncBounds, 80 + retryCount * 40);
        }
        return;
      }
      retryCount = 0;
      const viewport = window.innerWidth || document.documentElement.clientWidth || 0;
      const reserve = Math.max(0, Math.min(nativeOsdReserve, Math.round(rect.height * 0.3)));
      const expectedHeight = Math.max(1, rect.height - reserve);
      // Mindig frissítünk ha fullscreen változott, ne csak ha méret változott – ez javítja a fekete képernyőt
      const isSame =
        !lastHidden &&
        Math.abs(rect.left - lastX) < 1 &&
        Math.abs(rect.top - lastY) < 1 &&
        Math.abs(rect.width - lastWidth) < 1 &&
        Math.abs(expectedHeight - lastHeight) < 1 &&
        viewport === lastViewport;
      // Ha ugyanaz, de fullscreen állapot változott, akkor is küldjük újra
      if (isSame && retryCount === 0) {
        // Ne spameljük, de ha 500ms-nál régebbi, küldjük újra
        return;
      }
      const boundsHeight = expectedHeight;
      lastX = rect.left;
      lastY = rect.top;
      lastWidth = rect.width;
      lastHeight = boundsHeight;
      lastViewport = viewport;
      lastHidden = false;
      api.setVideoBounds?.(rect.left, rect.top, rect.width, boundsHeight, viewport);
    };

    let frame = 0;
    let secondFrame = 0;
    let thirdFrame = 0;
    let settleTimers: number[] = [];
    const syncAfterLayout = () => {
      retryCount = 0;
      syncBounds();
      frame = window.requestAnimationFrame(() => {
        syncBounds();
        secondFrame = window.requestAnimationFrame(() => {
          syncBounds();
          thirdFrame = window.requestAnimationFrame(() => {
            syncBounds();
          });
          // Több lépcsőben újra mérjük, mert webOS böngésző forgatáskor késve adja a végleges viewportot
          settleTimers.forEach((t) => window.clearTimeout(t));
          settleTimers = [];
          [80, 180, 350, 600].forEach((delay) => {
            const timer = window.setTimeout(syncBounds, delay) as unknown as number;
            settleTimers.push(timer);
          });
        });
      });
    };

    syncAfterLayout();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncAfterLayout) : null;
    if (videoSurfaceRef.current) observer?.observe(videoSurfaceRef.current);
    if (document.documentElement) observer?.observe(document.documentElement);
    window.addEventListener('resize', syncAfterLayout);
    window.addEventListener('orientationchange', syncAfterLayout);
    window.visualViewport?.addEventListener('resize', syncAfterLayout);
    window.addEventListener('scroll', syncAfterLayout, true);
    document.addEventListener('fullscreenchange', syncAfterLayout);
    document.addEventListener('visibilitychange', syncAfterLayout);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(secondFrame);
      window.cancelAnimationFrame(thirdFrame);
      settleTimers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener('resize', syncAfterLayout);
      window.removeEventListener('orientationchange', syncAfterLayout);
      window.visualViewport?.removeEventListener('resize', syncAfterLayout);
      window.removeEventListener('scroll', syncAfterLayout, true);
      document.removeEventListener('fullscreenchange', syncAfterLayout);
      document.removeEventListener('visibilitychange', syncAfterLayout);
    };
  }, [nativeHandoff, isFullscreen, isPortrait, nativeOsdReserve]);

  // Élő TV fekvő teljes képernyő jelzése és képarány mindig fill (nyújtás)
  useEffect(() => {
    const api = nativeApi();
    if (!api) return;
    // Mindig jelezzük a natívnak hogy fekvő élő fullscreen-e van
    api.setLiveLandscapeFullscreen?.(isLiveLandscapeFullscreen);
    // Mindig fill, mert a beállításokból kivettük a képméret választást
    api.setAspectRatio?.('fill');
  }, [nativeHandoff, isLiveLandscapeFullscreen, isFullscreen, isPortrait, isVod, streamUrl]);

  // A natív lejátszó saját „Kép” gombja ugyanazt a mentett webes beállítást módosítja.
  useEffect(() => {
    const api = nativeApi();
    if (!api?.on) return;
    const listener = (event: { type?: string; mode?: string }) => {
      if (event.type === 'aspect-ratio-changed' &&
          (event.mode === 'contain' || event.mode === 'cover' || event.mode === 'fill')) {
        window.dispatchEvent(new CustomEvent('iptv-native-aspect-ratio', { detail: event.mode }));
      }
      if (event.type === 'ended') {
        appLog('A lejátszás véget ért (natív jelzés).');
        onEndedRef.current?.();
      }
    };
    api.on(listener);
    return () => api.off?.(listener);
  }, []);

  useEffect(() => {
    setVodAudioTracks(providedAudioTracks || []);
    setVodSubtitleTracks(providedSubtitleTracks || []);
    setVodTrackMenu(null);
    setActiveVodSubtitleId(null);
  }, [providedAudioTracks, providedSubtitleTracks, customStreamUrl]);

  // Film/sorozat idővonal: natív motorból vagy HTML5 videóból olvassuk.
  useEffect(() => {
    if (!isVod) {
      setVodCurrentTime(0);
      setVodDuration(0);
      return;
    }
    const update = () => {
      const api = nativeApi();
      const video = htmlVideoRef.current;
      let position = api ? Math.max(0, Number(api.position?.() || 0) / 1000) : Math.max(0, Number(video?.currentTime || 0));
      const duration = api ? Math.max(0, Number(api.duration?.() || 0) / 1000) : Math.max(0, Number(video?.duration || 0));
      if (!vodSeekDraggingRef.current) setVodCurrentTime(position);
      setVodDuration(duration);
      if (initialPositionSeconds > 0 && duration > 0 && resumeAppliedForUrlRef.current !== streamUrl) {
        const target = Math.min(initialPositionSeconds, Math.max(0, duration - 1));
        if (api?.seekTo) api.seekTo(Math.round(target * 1000));
        else if (video) video.currentTime = target;
        resumeAppliedForUrlRef.current = streamUrl;
        position = target;
        setVodCurrentTime(target);
      }
      if (Math.floor(position) !== lastReportedProgressRef.current) {
        lastReportedProgressRef.current = Math.floor(position);
        onProgress?.(position, duration);
      }
    };
    update();
    // Látható OSD mellett 500 ms, rejtve 1 másodperc: a csúszka úgyis csak
    // az OSD-ben látszik, a lejátszási helyzet mentése 1 másodperces
    // pontossággal bőven elég.
    const timer = window.setInterval(update, showControlsOverlay ? 500 : 1000);
    return () => window.clearInterval(timer);
  }, [isVod, nativeHandoff, streamUrl, onProgress, initialPositionSeconds, showControlsOverlay]);

  const formatVodTime = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const seekVod = (seconds: number) => {
    const target = Math.max(0, Math.min(vodDuration || Infinity, seconds));
    const api = nativeApi();
    if (api?.seekTo) api.seekTo(Math.round(target * 1000));
    else if (htmlVideoRef.current) htmlVideoRef.current.currentTime = target;
    setVodCurrentTime(target);
    setShowControlsOverlay(true);
  };

  // Film/sorozat OSD gyors tekerése mindig a natív lejátszó aktuális
  // pozíciójából indul, és a Rendszer beállításban kiválasztott lépést használja.
  const seekVodByConfiguredStep = (direction: -1 | 1) => {
    const api = nativeApi();
    const nativePositionMs = Number(api?.position?.());
    const currentSeconds = Number.isFinite(nativePositionMs) && nativePositionMs >= 0
      ? nativePositionMs / 1000
      : vodCurrentTime;
    seekVod(currentSeconds + direction * settings.seekStep);
  };

  const selectVodAudio = (track: AudioTrack) => {
    // A hangsávlista lejátszóazonosítót tartalmaz; a selectTrack indexet várna,
    // ami eltérhet, ezért a HTML5 videó-azonosító szerinti API-t használjuk.
    const mpvId = typeof track.id === 'number' ? track.id : Number(track.id);
    const nativeIndex = Number((track as AudioTrack & { nativeIndex?: number }).nativeIndex);
    const api = nativeApi();
    if (nativeHandoff && Number.isFinite(mpvId)) {
      api?.selectTrackById?.('audio', mpvId, Number.isFinite(nativeIndex) ? nativeIndex : undefined);
      appLog(`Film/sorozat hangsáv kiválasztva: track id=${mpvId}`
        + (Number.isFinite(nativeIndex) ? `, sorszám=${nativeIndex}` : ''));
    }
    setVodTrackMenu(null);
  };

  const selectTvAudio = useCallback((track: AudioTrack) => {
    const mpvId = typeof track.id === 'number' ? track.id : Number(track.id);
    const api = nativeApi();
    if (!api) return;
    const nativeIndex = Number((track as AudioTrack & { nativeIndex?: number }).nativeIndex);
    pendingTvAudioSelectionRef.current = { index: mpvId, startedAt: Date.now() };
    if (Number.isFinite(mpvId)) {
      // A kiválasztás azonnal látszik a felületen (a hangsávmenü rögtön zárul),
      // a kért sáv pedig a natív lejátszó azonnali váltási útvonalára kerül.
      // A natív oldal ellenőrzi a váltást, és szükség esetén maga javítja.
      userAudioChoiceRef.current = mpvId;
      setTvAudioTracks((previous) => previous.map((item) => ({
        ...item,
        selected: Number(item.id) === Number(track.id),
      })));
    }
    const handled = Number.isFinite(mpvId)
      ? api.selectTrackById?.('audio', mpvId, Number.isFinite(nativeIndex) ? nativeIndex : undefined)
      : false;
    if (handled === false && Number.isFinite(nativeIndex) && api.selectTrack) {
      api.selectTrack('audio', nativeIndex);
    } else if (handled === false) {
      pendingTvAudioSelectionRef.current = null;
      userAudioChoiceRef.current = null;
      api.toast?.('A hangsávváltás nem érhető el ebben a lejátszóban.');
    }
    appLog(`Élő hangsáv kiválasztva: track id=${mpvId}`
      + (Number.isFinite(nativeIndex) ? `, sorszám=${nativeIndex}` : '')
      + `, átadva=${handled !== false}.`);
    setShowTvAudioMenu(false);
  }, []);

  useEffect(() => {
    onAudioTracksChange?.(tvAudioTracks);
  }, [tvAudioTracks, onAudioTracksChange]);

  useEffect(() => {
    onRegisterAudioTrackSelector?.(selectTvAudio);
    return () => onRegisterAudioTrackSelector?.(null);
  }, [onRegisterAudioTrackSelector, selectTvAudio]);

  const selectTvSubtitle = useCallback((track: SubtitleTrack | null) => {
    const native = nativeApi();
    if (!nativeHandoff || !native) return;
    const current = activeTvSubtitleIdRef.current != null ? Number(activeTvSubtitleIdRef.current) : NaN;
    if (track && Number.isFinite(Number(track.id))) {
      const targetId = Number(track.id);
      nativeSubtitleAutoSelectionKeyRef.current = `${streamUrl}|${nativeSubtitleTrackSignatureRef.current}|${String(track.lang || track.name || track.id).toLowerCase()}`;
      pendingTvSubtitleSelectionRef.current = { id: targetId, startedAt: Date.now() };
      native.selectTrack?.('subtitle', targetId);
      appLog(`Élő felirat kiválasztása: sáv=${targetId}; visszaigazolásra vár.`);
    } else {
      pendingTvSubtitleSelectionRef.current = { id: null, startedAt: Date.now() };
      native.deselectTrack?.('subtitle', Number.isFinite(current) ? current : -1);
      activeTvSubtitleIdRef.current = null;
      appLog('Élő felirat kikapcsolása kérve.');
    }
  }, [nativeHandoff, streamUrl]);

  useEffect(() => {
    onSubtitleTracksChange?.(tvSubtitleTracks);
  }, [tvSubtitleTracks, onSubtitleTracksChange]);

  useEffect(() => {
    onRegisterSubtitleTrackSelector?.(selectTvSubtitle);
    return () => onRegisterSubtitleTrackSelector?.(null);
  }, [onRegisterSubtitleTrackSelector, selectTvSubtitle]);

  const selectVodSubtitle = (track: SubtitleTrack | null) => {
    if (nativeHandoff) {
      const current = activeVodSubtitleId != null ? Number(activeVodSubtitleId) : NaN;
      if (track && Number.isFinite(Number(track.id))) {
        nativeApi()?.selectTrack?.('subtitle', Number(track.id));
        setActiveVodSubtitleId(track.id);
      } else {
        nativeApi()?.deselectTrack?.('subtitle', Number.isFinite(current) ? current : -1);
        setActiveVodSubtitleId(null);
      }
    }
    setVodTrackMenu(null);
  };

  // A natív lejátszó eseményei: ha bezárul vagy hibázik, a felület is kövesse.
  useEffect(() => {
    const api = nativeApi();
    if (!api?.on) return;

    // A VideoPlayer többször is fel- és leszerelhető (Live/Filmek/Sorozatok
    // váltáskor). A korábbi listener eltávolítása nélkül minden visszatérés új
    // natív eseményfigyelőt hagyott maga után, és sok tesztelés után több régi
    // komponens egyszerre módosította az aktuális lejátszó állapotát.
    const handleNativeEvent = (event: { type?: string; message?: string; playing?: boolean; connected?: boolean }) => {
      if (event.type === 'cast-session') {
        if (event.connected === true) {
          // Csak sikeres Cast session után állítjuk le a helyi adást.
          // Mindkét motor leállítható biztonságosan: amelyik épp nem fut, az nem csinál semmit.
          nativeApi()?.pause?.();
          setIsPlaying(false);
          setShowControlsOverlay(true);
        }
      } else if (event.type === 'closed') {
        clearBufferWatchdog();
        playbackStartedRef.current = false;
        setNativeHandoff(false);
        setIsLoading(false);
        setIsPlaying(false);
      } else if (event.type === 'buffering-start') {
        if (playbackStartedRef.current) {
          setIsLoading(true);
          armBufferWatchdog();
        }
      } else if (event.type === 'buffering-end') {
        clearBufferWatchdog();
        setIsLoading(false);
      } else if (event.type === 'playing' || event.type === 'state') {
        if (event.type === 'playing' || event.playing === true) {
          playbackStartedRef.current = true;
          clearBufferWatchdog();
        }
        clearAutoRetry();
        setNativeHandoff(true);
        setIsLoading(false);
        if (nativeApi()?.mediaTracks) {
          const tracks = readNativeMediaTracks(nativeApi());
          const nativeAudioInfo = tracks.filter((t) => t.type === 'audio');
          const nativeAudioTracks = nativeAudioInfo
            .map((t) => {
              const mpvId = Number.isFinite(Number(t.mpvId)) ? Number(t.mpvId) : t.index;
              return { id: mpvId, nativeIndex: t.index, name: t.name || t.lang || '', lang: t.lang || '', selected: t.selected === true };
            });
          setVodAudioTracks(nativeAudioTracks);
          setTvAudioTracks(nativeAudioTracks);
          // Az alapértelmezett élő TV-hangsáv kiválasztását kizárólag a
          // refreshNativeAudioTracks kezeli, hogy ne legyen két versengő parancs.
          const nativeSubtitleTracks = tracks
            .filter((t) => t.type === 'subtitle')
            .map((t) => ({ id: t.index, name: t.name || t.lang || 'Felirat', lang: t.lang || '', selected: t.selected === true }));
          setVodSubtitleTracks(nativeSubtitleTracks);
          setTvSubtitleTracks(nativeSubtitleTracks);
        }
        if (typeof event.playing === 'boolean') {
          setIsPlaying(event.playing);
        } else {
          setIsPlaying(true);
        }
      } else if (event.type === 'error') {
        clearBufferWatchdog();
        setNativeMessage(event.message || 'A natív lejátszó hibát jelzett.');
        setNativeHandoff(false);
        setHasError(true);
        setErrorMessage(event.message || 'A natív lejátszó nem tudta megnyitni az adást.');
        scheduleAutoRetry();
      }
    };

    api.on(handleNativeEvent);
    return () => {
      api.off?.(handleNativeEvent);
    };
  }, [clearAutoRetry, clearBufferWatchdog, armBufferWatchdog, scheduleAutoRetry, settings.preferredSubtitle]);

  // A natív track-list késve is megérkezhet (csatornánként eltérő időben).
  // Amíg a natív motor fut, rendszeresen újraolvassuk, hogy a gomb és a lista
  // ne az előző csatorna vagy az indulás pillanatának adatait mutassa.
  useEffect(() => {
    if (!nativeHandoff) return;
    const api = nativeApi();
    if (!api?.mediaTracks) return;
    const refreshNativeAudioTracks = () => {
      const tracks = readNativeMediaTracks(api);
      const audio = tracks.filter((track) => track.type === 'audio');
      const audioSignature = audio
        .map((track) => `${track.mpvId ?? track.index}:${track.lang}:${track.name}`)
        .join('|');
      const preferredAudioLang = (settings.preferredAudioLang || 'Magyar').trim();
      const selectionSignature = preferredAudioLang + '|' + audioSignature;
      if (!isVod && audio.length > 0 && selectionSignature !== nativeAudioTrackSignatureRef.current
          && userAudioChoiceRef.current === null) {
        nativeAudioTrackSignatureRef.current = selectionSignature;
        const normalize = (value: unknown) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const aliases: Record<string, string[]> = {
          Magyar: ['hu', 'hun', 'magyar', 'hungarian'],
          Angol: ['en', 'eng', 'english', 'original'],
          Német: ['de', 'deu', 'ger', 'german', 'deutsch'],
          Francia: ['fr', 'fra', 'fre', 'french', 'francais'],
          Olasz: ['it', 'ita', 'italian', 'italiano'],
          Spanyol: ['es', 'spa', 'spanish', 'espanol'],
        };
        const wanted = (aliases[preferredAudioLang] || [preferredAudioLang]).map(normalize);
        const preferredTrack = audio.find((track) => {
          const lang = normalize(track.lang);
          const name = normalize(track.name);
          const words = name.split(/[^a-z]+/).filter(Boolean);
          return wanted.some((alias) =>
            lang === alias || (alias.length > 3 && (lang.includes(alias) || name.includes(alias))) ||
            words.includes(alias)
          );
        });
        const activeTrack = audio.find((track) => track.selected === true);
        const targetTrack = preferredTrack || (!activeTrack ? audio[0] : null);
        if (targetTrack && targetTrack.selected !== true) {
          api.selectTrackById?.('audio', Number(targetTrack.mpvId ?? targetTrack.index), targetTrack.index);
        }
      }
      const mapped = audio.map((track) => ({
        id: Number.isFinite(Number(track.mpvId)) ? Number(track.mpvId) : track.index,
        nativeIndex: track.index,
        name: track.name || track.lang || '',
        lang: track.lang || '',
        selected: track.selected === true,
      }));
      const pending = pendingTvAudioSelectionRef.current;
      if (pending) {
        if (audio.some((track) => Number(track.mpvId ?? track.index) === pending.index && track.selected === true)) {
          pendingTvAudioSelectionRef.current = null;
        } else if (Date.now() - pending.startedAt >= 6000) {
          // Élő adásnál a váltás hosszabb is lehet (a lejátszó a hangsáv
          // azonnali érvényesítéséhez újratölti a streamet), ezért 6 másodperc
          // után jelezzük csak, hogy nem sikerült.
          api.toast?.('A lejátszó nem igazolta vissza a kiválasztott hangsáv váltását.');
          pendingTvAudioSelectionRef.current = null;
        }
      }
      setTvAudioTracks((previous) =>
        previous.length === mapped.length && previous.every((track, index) =>
          String(track.id) === String(mapped[index]?.id) &&
          track.name === mapped[index]?.name && track.lang === mapped[index]?.lang &&
          track.selected === mapped[index]?.selected
        ) ? previous : mapped
      );
      setVodAudioTracks((previous) =>
        previous.length === mapped.length && previous.every((track, index) =>
          String(track.id) === String(mapped[index]?.id) &&
          track.name === mapped[index]?.name && track.lang === mapped[index]?.lang &&
          track.selected === mapped[index]?.selected
        ) ? previous : mapped
      );
    };
    refreshNativeAudioTracks();
    const timer = window.setInterval(refreshNativeAudioTracks, 1000);
    return () => window.clearInterval(timer);
  }, [nativeHandoff, streamUrl, isVod, settings.preferredAudioLang]);

  // Élő TV-feliratok: a natív lejátszó visszaigazolt állapotát folyamatosan olvassuk.
  // Új csatornánál a Rendszer beállítás szerinti nyelvet (alapból Magyar) választjuk,
  // de kézi váltás után nem írjuk felül ugyanazon a csatornán.
  useEffect(() => {
    if (!nativeHandoff || isVod) return;
    const api = nativeApi();
    if (!api?.mediaTracks) return;

    const refreshNativeSubtitleTracks = () => {
      const tracks = readNativeMediaTracks(api).filter((track) => track.type === 'subtitle');
      const mapped: SubtitleTrack[] = tracks.map((track) => ({
        id: track.index,
        name: track.name || track.lang || 'Felirat',
        lang: track.lang || '',
        selected: track.selected === true,
      }));
      const signature = mapped.map((track) => `${track.id}:${track.lang}:${track.name}`).join('|');
      nativeSubtitleTrackSignatureRef.current = signature;
      setTvSubtitleTracks((previous) =>
        previous.length === mapped.length && previous.every((track, index) =>
          String(track.id) === String(mapped[index]?.id) &&
          track.name === mapped[index]?.name && track.lang === mapped[index]?.lang &&
          track.selected === mapped[index]?.selected
        ) ? previous : mapped
      );

      const selectedTrack = mapped.find((track) => track.selected === true);
      activeTvSubtitleIdRef.current = selectedTrack?.id ?? null;
      const pending = pendingTvSubtitleSelectionRef.current;
      if (pending) {
        const confirmed = pending.id === null
          ? !selectedTrack
          : mapped.some((track) => Number(track.id) === pending.id && track.selected === true);
        if (confirmed) {
          pendingTvSubtitleSelectionRef.current = null;
        } else if (Date.now() - pending.startedAt >= 6000) {
          api.toast?.('A lejátszó nem igazolta vissza a kiválasztott felirat váltását.');
          pendingTvSubtitleSelectionRef.current = null;
        }
      }

      const preferred = (settings.preferredSubtitle || 'Magyar').trim();
      const selectionKey = `${streamUrl}|${signature}|${preferred.toLowerCase()}`;
      if (selectionKey === nativeSubtitleAutoSelectionKeyRef.current) return;
      nativeSubtitleAutoSelectionKeyRef.current = selectionKey;

      if (preferred.toLowerCase() === 'kikapcsolva') {
        if (selectedTrack) api.deselectTrack?.('subtitle', Number(selectedTrack.id));
        return;
      }
      const normalize = (value: unknown) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const wanted = normalize(preferred);
      const aliases: Record<string, string[]> = {
        magyar: ['hu', 'hun', 'magyar', 'hungarian'],
        angol: ['en', 'eng', 'english'],
        német: ['de', 'deu', 'ger', 'german', 'deutsch'],
        nemet: ['de', 'deu', 'ger', 'german', 'deutsch'],
        francia: ['fr', 'fra', 'fre', 'french', 'francais'],
        olasz: ['it', 'ita', 'italian', 'italiano'],
        spanyol: ['es', 'spa', 'spanish', 'espanol'],
      };
      const wantedAliases = aliases[wanted] || [wanted];
      const target = mapped.find((track) => [track.lang, track.name].some((value) => {
        const normalized = normalize(value);
        return wantedAliases.some((alias) =>
          normalized === alias || normalized.includes(alias) ||
          normalized.split(/[^a-z]+/).includes(alias)
        );
      }));
      if (target && target.selected !== true) {
        pendingTvSubtitleSelectionRef.current = { id: Number(target.id), startedAt: Date.now() };
        api.selectTrack?.('subtitle', Number(target.id));
        appLog(`Automatikus élő feliratválasztás: ${target.lang || target.name} (beállítás: ${preferred}).`);
      }
    };

    refreshNativeSubtitleTracks();
    const timer = window.setInterval(refreshNativeSubtitleTracks, 1000);
    return () => window.clearInterval(timer);
  }, [nativeHandoff, isVod, streamUrl, settings.preferredSubtitle]);

  // Determine active stream URL
  // (A streamUrl már feljebb, a felhasználói előtt definiálva van – lásd a
  // komponens elején a megjegyzést.)

  /** Átadás a natív lejátszónak (az alkalmazáson belüli teljes képernyős réteg). */
  const handOverToNative = useCallback(
    (url: string, note = '') => {
      const api = nativeApi();
      if (!api?.play || !url) return false;
      if (zapWatchdogRef.current !== null) {
        window.clearTimeout(zapWatchdogRef.current);
        zapWatchdogRef.current = null;
      }
      // A natív lejátszó csak így tudja biztosan, hogy élő adás vagy film fut:
      // élő adásnál rövid demuxer-gyorsítótár kell, különben a hangsávváltás
      // csak a 20+ másodpercnyi puffer lejátszása után hallatszana.
      api.setLiveStreamHint?.(!isVod);
      // A Rendszer menü pufferelés beállítása a natív lejátszóra is érvényes.
      try { api.setBufferMode?.(bufferModeRef.current); } catch { /* opcionális híd */ }
      api.play(url, channel?.name || customTitle || 'IPTV R.T');
      setNativeMessage(note);
      setNativeHandoff(true);
      setHasError(false);
      setIsLoading(false);
      return true;
    },
    [channel, customTitle, isVod]
  );

  // A lejátszó LG webOS-en HTML5/HLS videót használ.
  const zapWatchdogRef = useRef<number | null>(null);

  const clearZapWatchdog = useCallback(() => {
    if (zapWatchdogRef.current !== null) {
      window.clearTimeout(zapWatchdogRef.current);
      zapWatchdogRef.current = null;
    }
  }, []);

  // Egyetlen lejátszómotor: LG webOS-en a TV HTML5/HLS videóeleme játssza le az adatfolyamot.
  const loadStream = useCallback((url: string) => {
    clearZapWatchdog();
    clearBufferWatchdog();
    playbackStartedRef.current = false;
    setTvAudioTracks([]);
    setTvSubtitleTracks([]);
    activeTvSubtitleIdRef.current = null;
    nativeSubtitleTrackSignatureRef.current = '';
    nativeSubtitleAutoSelectionKeyRef.current = '';
    pendingTvSubtitleSelectionRef.current = null;
    nativeAudioTrackSignatureRef.current = '';
    userAudioChoiceRef.current = null;
    setShowTvAudioMenu(false);
    setIsLoading(true);
    setHasError(false);
    setErrorMessage('');
    setNativeHandoff(false);
    if (!url) {
      setIsLoading(false);
      setHasError(true);
      setErrorMessage('Nincs lejátszható adatfolyam.');
      return;
    }
    const api = nativeApi();
    if (api?.play) {
      handOverToNative(url);
      return;
    }

    // LG webOS: lejátszás a TV HTML5/HLS videóelemével.
    const video = htmlVideoRef.current;
    if (!video) {
      setIsLoading(false);
      setHasError(true);
      setErrorMessage('Az LG webOS videóelem még nem áll készen.');
      return;
    }
    try {
      video.pause();
      video.removeAttribute('src');
      // Korábbi <source> gyerekek eltakarítása (motorváltásnál is tiszta lap).
      while (video.firstChild) video.removeChild(video.firstChild);
      if (playerEngineRef.current === 'native') {
        // NATÍV MOTOR: a webOS a <source> type mezőjében kapott mediaOption
        // JSON-nal a TV saját (UMS) médiacsatornáján indítja az adást.
        const isHls = /\.m3u8(?=([?#]|$))/i.test(url);
        const mime = isHls ? 'application/vnd.apple.mpegurl' : (/\.ts(?=([?#]|$))/i.test(url) ? 'video/mp2t' : 'video/mp4');
        const mediaOption = encodeURIComponent(JSON.stringify({
          mediaTransportType: 'URI',
          option: { htmlMediaOption: { useUMSMediaInfo: true } },
        }));
        const sourceEl = document.createElement('source');
        sourceEl.setAttribute('src', url);
        sourceEl.setAttribute('type', `${mime};mediaOption=${mediaOption}`);
        // A <source> hibája nem mindig jut el a videóelemig - továbbadjuk,
        // hogy a formátumváltó/zap-őr lánc ugyanúgy működjön, mint HTML5-nél.
        sourceEl.onerror = () => {
          try { video.dispatchEvent(new Event('error')); } catch { /* régi motor */ }
        };
        video.appendChild(sourceEl);
      } else {
        video.src = url;
      }
      video.volume = Math.max(0, Math.min(1, volume));
      video.muted = volume <= 0;
      video.load();
      const playPromise = video.play();
      setIsPlaying(true);
      // ZAP-ŐR: ha az élő adás nem indul el időben (a HLS-próba csak "lóg",
      // se hiba, se kép), nem várunk a végtelenségig pörgő töltésre -
      // automatikusan a következő formátumra (MPEG-TS) váltunk.
      if (!customStreamUrl) {
        const { watchdogMs } = bufferTiming();
        zapWatchdogRef.current = window.setTimeout(() => {
          zapWatchdogRef.current = null;
          if (!playbackStartedRef.current) {
            appLog('Zap-őr: nem indult el az adás időben, automatikus formátumváltás.');
            scheduleAutoRetry();
          }
        }, watchdogMs);
      }
      if (playPromise && typeof playPromise.catch === 'function') {
        void playPromise.catch((error: unknown) => {
          if (video.error) return;
          setIsLoading(false);
          setHasError(true);
          setErrorMessage(error instanceof Error && error.name === 'NotAllowedError'
            ? 'A TV lejátszási indítást blokkolta. Nyomj az Újrapróbálás gombra.'
            : 'A TV nem tudta elindítani ezt az adatfolyamot. Ellenőrizd az URL-t és a stream formátumát.');
        });
      }
    } catch (error) {
      setIsLoading(false);
      setHasError(true);
      setErrorMessage(error instanceof Error ? error.message : 'A webOS videó indítása sikertelen.');
    }
  }, [clearZapWatchdog, clearBufferWatchdog, handOverToNative, setIsPlaying, volume, customStreamUrl, scheduleAutoRetry]);

  retryStreamRef.current = () => loadStream(pendingStreamUrlRef.current || streamUrl);

  // A streamhez tartozó újratöltés. FONTOS: csak akkor indul újra a lejátszás,
  // ha a stream címe vagy egy lejátszást tényleg befolyásoló beállítás
  // változott. Korábban minden beállítás-változás (pl. OSD-idő, képmód)
  // újraindította a lejátszást – ez volt a „ne méretezzen/ugráljon össze-vissza”.
  const loadStreamRef = useRef(loadStream);
  loadStreamRef.current = loadStream;
  const loadKey = `${streamUrl}|${settings.bufferMode}|${playerEngine}`;
  useEffect(() => {
    clearAutoRetry();
    nativeRetryCountRef.current = 0;
    setActiveUrlIndex(0);
    // GYORS ZAPPOLÁS: megjegyezzük, melyik formátum (HLS vagy MPEG-TS) indult
    // el legutóbb sikeresen, és csatornaváltásnál rögtön azzal próbálkozunk -
    // így nem megy el másodpercekig tartó zap-őr várakozás minden váltásnál.
    let preferTs = false;
    try { preferTs = window.localStorage.getItem('iptv_rt_live-format') === 'ts'; } catch { /* tároló nélkül HLS marad */ }
    const hlsUrl = streamUrl.replace(/\.ts(?=([?#]|$))/i, '.m3u8');
    const tsUrl = /\.ts(?=([?#]|$))/i.test(streamUrl)
      ? streamUrl
      : streamUrl.replace(/\.m3u8(?=([?#]|$))/i, '.ts');
    // Kiterjesztés nélküli élő URL-nél nincs mit cserélni - marad a HLS-út.
    const canPreferTs = preferTs && tsUrl !== hlsUrl;
    // Natív mód: a szolgáltatótól kapott cím változatlanul megy a TV dekóderének.
    const nativeMode = playerEngineRef.current === 'native';
    const primaryUrl = nativeMode
      ? streamUrl
      : (!isVod ? (canPreferTs ? tsUrl : hlsUrl) : streamUrl);
    pendingStreamUrlRef.current = primaryUrl;
    if (nativeMode) {
      retryPlanRef.current = { originalUrl: streamUrl, stage: 'primary' };
    } else if (!isVod) {
      retryPlanRef.current = canPreferTs
        ? { originalUrl: tsUrl, stage: 'primary' }
        : { originalUrl: tsUrl, stage: 'hls' };
    } else {
      retryPlanRef.current = { originalUrl: primaryUrl, stage: 'primary' };
    }
    if (primaryUrl) {
      loadStreamRef.current(primaryUrl);
    }
    return () => {
      clearBufferWatchdog();
      playbackStartedRef.current = false;
      clearAutoRetry(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey, clearAutoRetry, clearBufferWatchdog]);

  // Play/pause: natív hídon vagy LG webOS HTML5 videón keresztül.
  const togglePlay = () => {
    const api = nativeApi();
    if (api?.togglePause) {
      api.togglePause();
      setIsPlaying((prev) => !prev);
      return;
    }
    const video = htmlVideoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().then(() => setIsPlaying(true)).catch(() => {
        setHasError(true);
        setErrorMessage('A TV lejátszási indítást blokkolta. Nyomj az Újrapróbálás gombra.');
      });
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  // Keep the main-page OSD connected to the real player control.
  useEffect(() => {
    onRegisterTogglePlay?.(togglePlay);
    return () => onRegisterTogglePlay?.(null);
  }, [onRegisterTogglePlay, nativeHandoff]);

  // A fő OSD és a lejátszó saját vezérlője ugyanazt a hangerőállapotot használja.
  // A rendszer hangerőt SOHA nem állítjuk automatikusan (a bejelentkező videó
  // végén és csatornánként sem). Csak akkor hívunk setSystemVolume-t, amikor
  // a felhasználó kézzel mozgatja a csúszkát – azt az App.tsx kezeli.

  // A telefon fizikai hangerőgombjainak változását is visszatükrözzük az OSD csúszkájára.
  useEffect(() => {
    const api = nativeApi();
    if (!api?.getSystemVolume) return;
    const timer = window.setInterval(() => {
      const next = Math.max(0, Math.min(1, Number(api.getSystemVolume?.() ?? volume)));
      if (Math.abs(next - volume) > 0.015) onVolumeChange(next);
    }, 350);
    return () => window.clearInterval(timer);
  }, [volume, onVolumeChange]);

  // Felirat méretének alkalmazása a natív lejátszón (mozi/sorozat beállítás összekötése)
  useEffect(() => {
    const api = nativeApi() as any;
    if (!api?.setSubtitleScale) return;
    const sizeStr = settings.subtitleSize || '100%';
    const percent = Number(String(sizeStr).replace('%', '')) || 100;
    const scale = Math.max(0.5, Math.min(3.0, percent / 100));
    try { api.setSubtitleScale(scale); } catch { /* native may be unavailable */ }
  }, [settings.subtitleSize]);

  // Handle Fullscreen
  const togglePictureInPicture = async () => {
    const api = nativeApi();
    if (api?.pip) {
      api.pip();
      return;
    }
    const video = htmlVideoRef.current as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
    if (video?.requestPictureInPicture && (document as any).pictureInPictureEnabled) {
      try { await video.requestPictureInPicture(); } catch { /* a TV böngészője elutasíthatja a PiP-t */ }
    }
  };

  const togglePipRef = useRef(togglePictureInPicture);
  togglePipRef.current = togglePictureInPicture;
  useEffect(() => {
    if (!onRegisterPip) return;
    onRegisterPip(() => { void togglePipRef.current(); });
    return () => onRegisterPip(null);
  }, [onRegisterPip]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const fullscreen = document.fullscreenElement === containerRef.current;
      setIsFullscreen(fullscreen);
      if (!fullscreen) setShowFullscreenEpg(false);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;

    // LG webOS-en a videó a webes konténerben van, ezért a böngésző Fullscreen API-ja
    // közvetlenül a videó elrendezését kezeli. A webes konténert
    // méretezzük teljes képernyőre, és a bounds effect követi a natív képet.
    if (nativeHandoff) {
      // Natív kép: a webes konténer lesz teljes képernyős, a natív videó
      // téglalapja a videóelemhez igazodik. Az OSD ilyenkor is ugyanaz a
      // kezelőfelület marad (nem váltunk más kinézetre).
      setIsFullscreen((previous) => !previous);
      setShowControlsOverlay(true);
      return;
    }

    if (!document.fullscreenElement) {
      const request = container.requestFullscreen?.();
      if (request) request.then(() => setIsFullscreen(true)).catch(() => {
        // Fullscreen API hiányában is legyen használható a teljes képernyős nézet.
        setIsFullscreen(true);
      });
      else setIsFullscreen(true);
    } else {
      const exit = document.exitFullscreen?.();
      if (exit) exit.then(() => setIsFullscreen(false)).catch(() => setIsFullscreen(false));
      else setIsFullscreen(false);
    }
  };

  // Csatornaváltás csak egyértelmű, határozott függőleges húzásra történik – érintés + egér húzás
  const handleTouchStart = (e: React.TouchEvent) => {
    suppressNextClickRef.current = false;
    if (e.touches.length !== 1) {
      touchStartRef.current = null;
      return;
    }
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || e.changedTouches.length === 0) return;

    const endY = e.changedTouches[0].clientY;
    const endX = e.changedTouches[0].clientX;
    const diffY = start.y - endY;
    const diffX = start.x - endX;
    const absY = Math.abs(diffY);
    const absX = Math.abs(diffX);

    // Már a kisebb elmozdulás is húzásnak számít a kattintás/OSD elnyomásához,
    // de csatornát csak legalább 85 px-es, egyértelműen függőleges húzás vált.
    if (Math.hypot(diffX, diffY) > 12) {
      suppressNextClickRef.current = true;
    }
    if (
      !isVod &&
      settings.swipeToZap &&
      absY >= 85 &&
      absY > absX * 1.35
    ) {
      if (diffY > 0) {
        onNextChannel?.();
      } else {
        onPrevChannel?.();
      }
    }
  };

  // Egér húzás csatornaváltáshoz – laptop/desktop
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    mouseDragStartRef.current = { x: e.clientX, y: e.clientY };
  };
  const handleMouseUp = (e: React.MouseEvent) => {
    const start = mouseDragStartRef.current;
    mouseDragStartRef.current = null;
    if (!start) return;
    const diffY = start.y - e.clientY;
    const diffX = start.x - e.clientX;
    const absY = Math.abs(diffY);
    const absX = Math.abs(diffX);
    if (Math.hypot(diffX, diffY) > 12) suppressNextClickRef.current = true;
    if (!isVod && settings.swipeToZap && absY >= 85 && absY > absX * 1.35) {
      if (diffY > 0) onNextChannel?.();
      else onPrevChannel?.();
    }
  };

  return (
    <div
      ref={containerRef}
      data-tv-player=""
      data-player-engine={playerEngine}
      tabIndex={isFullscreen ? 0 : -1}
      onKeyDown={handleKeyDown}
      onMouseMove={handleMouseMove}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onClick={handleSurfaceTap}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      className={`relative w-full ${isFullscreen ? 'h-[100dvh] max-h-none aspect-auto fixed inset-0 z-[9999]' : 'aspect-video max-h-none md:aspect-video lg:aspect-video'} ${nativeHandoff ? 'bg-transparent' : 'bg-black'} overflow-hidden group select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${isFullscreen ? '' : 'shadow-2xl border-b border-cyan-900/30'}`}
      style={isFullscreen ? { width: '100vw', height: '100dvh', maxHeight: 'none', aspectRatio: 'auto' } : { width: '100%', aspectRatio: '16 / 9', height: 'auto' }}
    >
      {/* Három külön elrendezés: főoldali 16:9, álló teljes képernyőn 16:9 keret (élő TV és VOD is), fekvőben teljes kijelző. */}
      <div
        ref={videoSurfaceRef}
        className={`absolute bg-transparent pointer-events-none ${isFullscreen && isPortrait ? 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2' : 'inset-0'}`}
        style={isFullscreen && isPortrait
          ? { width: '100vw', height: '56.25vw', maxHeight: '100dvh' }
          : undefined}
      >
        {!nativeApi()?.play && (
          <video
            ref={htmlVideoRef}
            data-iptv-player="true"
            className="block h-full w-full bg-black"
            style={{ objectFit: 'contain' }}
            playsInline
            preload="auto"
            onPlaying={() => {
              playbackStartedRef.current = true;
              nativeRetryCountRef.current = 0;
              // A sikeresen elindult élő formátumot megjegyezzük a gyors zappoláshoz.
              if (!isVod && !customStreamUrl && playerEngineRef.current !== 'native') {
                try {
                  const url = pendingStreamUrlRef.current || '';
                  window.localStorage.setItem('iptv_rt_live-format', /\.ts(?=([?#]|$))/i.test(url) ? 'ts' : 'hls');
                } catch { /* tároló nélkül is működik */ }
              }
              clearZapWatchdog();
              clearAutoRetry();
              setIsLoading(false);
              setHasError(false);
              setIsPlaying(true);
            }}
            onCanPlay={() => { setIsLoading(false); setHasError(false); }}
            onWaiting={() => { if (playbackStartedRef.current) setIsLoading(true); }}
            onError={() => {
              setIsLoading(false);
              setErrorMessage('A TV nem tudta lejátszani az adatfolyamot. HLS/codec vagy stream URL hiba lehet.');
              scheduleAutoRetry();
            }}
            onPause={() => setIsPlaying(false)}
            onPlay={() => setIsPlaying(true)}
            onEnded={() => onEndedRef.current?.()}
            onTimeUpdate={(event) => {
              if (!isVod) return;
              const video = event.currentTarget;
              const position = Math.max(0, Number(video.currentTime || 0));
              const duration = Math.max(0, Number(video.duration || 0));
              // Az idővonal állapotát csak akkor írjuk ki, ha az OSD látszik
              // (a rejtett csúszka nem látszik, felesleges másodpercenként
              // újrarajzolni a teljes lejátszót).
              if (showControlsOverlay) {
                setVodDuration(duration);
                if (!vodSeekDraggingRef.current) setVodCurrentTime(position);
              }
              if (Math.floor(position) !== lastReportedProgressRef.current) {
                lastReportedProgressRef.current = Math.floor(position);
                onProgress?.(position, duration);
              }
            }}
          />
        )}
      </div>

      {/* A videó a TV HTML5 videóelemében fut; az OSD fölötte marad. */}
      {nativeHandoff && <div className="absolute inset-0 bg-transparent pointer-events-none" />}

      {/* Melyik lejátszó motor fut - csak a felületen, rövid jelzés. */}
      {showControlsOverlay && playerEngine === 'native' && !isLoading && !hasError && (
        <div className="absolute top-3 left-3 z-30 rounded-full border border-emerald-400/50 bg-black/70 px-3 py-1 text-[11px] font-black tracking-widest text-emerald-300 pointer-events-none">
          NATÍV LEJÁTSZÓ
        </div>
      )}

      {/* Buffering Loading Indicator */}
      {isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black z-10 pointer-events-none">
          <div className="relative w-12 h-12 flex items-center justify-center">
            <div className="w-12 h-12 rounded-full border-3 border-cyan-500/30 border-t-cyan-400 animate-spin" />
            <div className="absolute w-6 h-6 rounded-full bg-cyan-400/20 animate-ping" />
          </div>
          <span className="mt-2 text-xs font-semibold text-cyan-200 tracking-wider">
            Gyors kapcsolódás...
          </span>
        </div>
      )}

      {/* Stream Error Overlay with fallback launcher */}
      {hasError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black z-20 p-4 text-center">
          <h4 className="text-white font-bold text-sm sm:text-base whitespace-pre-line">A csatornát nem lehet be tölteni !{"\n"}kapcsolj másik csatornára...{"\n"}ez a sz@r le fagyott 😂</h4>
          <p className="mt-2 text-[11px] text-slate-400">Puffer: {settings.bufferMode} • koppints újrapróbálkozáshoz</p>
          <div className="flex items-center justify-center mt-3 w-full">
            <button
              onClick={(e) => {
                e.stopPropagation();
                const api = nativeApi();
                // A mostani pufferelési beállítás (Stabil) alapján töltse újra
                // – ez segít, ha többször újra kell pufferelni.
                try { api?.setBufferMode?.(settings.bufferMode); } catch {}
                // Visszaállítjuk az eredeti retry tervet (primary .ts) és
                // a jelenlegi beállításokkal indítjuk újra.
                try {
                  const original = retryPlanRef.current?.originalUrl || pendingStreamUrlRef.current || streamUrl;
                  if (original) {
                    pendingStreamUrlRef.current = original;
                    retryPlanRef.current = { originalUrl: original, stage: 'primary' };
                  }
                } catch {}
                clearAutoRetry();
                setHasError(false);
                setIsLoading(true);
                appLog(`Újrapróbálás: puffer=${settings.bufferMode}, url=${pendingStreamUrlRef.current || streamUrl}`);
                api?.retryToast?.(`Újrapróbálás ${settings.bufferMode} pufferrel`);
                // A loadKey már tartalmazza a bufferMode-ot, de itt közvetlenül
                // is újratöltjük a jelenlegi beállítással.
                if (pendingStreamUrlRef.current) loadStream(pendingStreamUrlRef.current);
                else if (streamUrl) loadStream(streamUrl);
                else retryStreamRef.current?.();
              }}
              ref={retryButtonRef}
              className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold transition-all shadow-md active:scale-95 focus:outline-none focus-visible:ring-4 focus-visible:ring-amber-400"
            >
              Újrapróbálás ({settings.bufferMode})
            </button>
          </div>
        </div>
      )}

      {/* Teljes képernyős EPG sáv – az OSD EPG gombjával kapcsolható. */}
      {!isVod && isFullscreen && showFullscreenEpg && (
        <div className="absolute left-3 right-3 bottom-3 z-40 rounded-2xl bg-black/85 backdrop-blur-md border border-cyan-400/30 px-4 py-3 pointer-events-auto shadow-2xl">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] text-cyan-300 font-black uppercase tracking-wider truncate">
                {channel?.name || customTitle || 'EPG MŰSORÚJSÁG'}
              </div>
              <div className="mt-1 text-sm text-white font-bold truncate">
                {channel?.epgNow?.title || 'Aktuális műsor'}
                <span className="text-slate-500 mx-2">•</span>
                <span className="text-amber-300">Következő: {channel?.epgNext?.title || 'Nincs adat'}</span>
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); setShowFullscreenEpg(false); }}
              className="shrink-0 px-2.5 py-1.5 rounded-lg bg-white/10 text-slate-200 text-xs font-bold"
            >
              Bezár
            </button>
          </div>
        </div>
      )}

      {/* Kék óra az OSD2-ben; teljes képernyőn az OSD elrejtése után is megmarad, ha a beállítás be van kapcsolva. */}
      {(settings.alwaysShowBlueClock || landscapeLiveFullscreen) && isFullscreen && (
        <BlueClock
          className={`absolute top-3 z-40 box-border max-w-[calc(100%-1.5rem)] flex items-center gap-2 rounded-full border border-cyan-400/40 bg-[#061329]/85 px-4 py-2 font-mono text-2xl font-semibold tracking-wider text-cyan-200 shadow-lg pointer-events-none ${isVod || landscapeLiveFullscreen || (isFullscreen && isPortrait && !isVod) ? 'right-3' : 'right-14'}`}
        />
      )}

      {/*
        Hover / koppintásra megjelenő OSD. Elrejtéskor nem csak áttetsző:
        a láthatatlan gombok sem foghatják el a koppintást (különben nem
        lehetne visszahozni az OSD-t). A `invisible` (visibility: hidden) a
        gyerekelemekre is érvényes, így a koppintás a videóra jut.
      */}
      <div
        data-player-osd=""
        className={`absolute inset-0 bg-linear-to-t from-black/80 via-transparent to-black/40 transition-opacity duration-300 flex flex-col justify-between p-3 pointer-events-none ${
          showControlsOverlay ? 'opacity-100 visible' : 'opacity-0 invisible'
        }`}
      >
        {isVod ? (
          /* Film/sorozat OSD: pontosan a főoldalon megszokott kék panel-kinézet,
             de filmnézéshez való vezérlőkkel (csúsztatható idővonal, tekerés,
             hangválasztás, felirat, TV-re küldés, PiP, teljes képernyő). */
          <div ref={vodOsdRef} className="absolute inset-x-2 bottom-2 z-40 pointer-events-auto">
            {vodTrackMenu && (
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Hang és felirat választó"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setVodTrackMenu(null); } }}
                onClick={() => setVodTrackMenu(null)}
                className="fixed inset-0 z-[10000] flex items-center justify-center p-3 md:p-4 bg-black/80 backdrop-blur-sm pointer-events-auto"
                style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
              >
                <div onClick={(e) => e.stopPropagation()} className="bg-[#081329] border-2 border-cyan-500/60 rounded-xl w-full max-w-md max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
                  <div className="p-4 bg-[#0a1835] border-b border-cyan-950 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {vodTrackMenu === 'audio'
                        ? <Mic2 className="w-5 h-5 text-rose-400 stroke-[2.5]" />
                        : <Captions className="w-5 h-5 text-cyan-300 stroke-[2.5]" />}
                      <h2 className="text-base sm:text-lg font-black text-white tracking-wide">
                        {vodTrackMenu === 'audio' ? 'HANGSÁV' : 'FELIRAT'}
                      </h2>
                    </div>
                    <button
                      onClick={() => setVodTrackMenu(null)}
                      aria-label="Bezárás"
                      className="p-1.5 rounded-full border-2 border-cyan-500/60 bg-[#0e1d3b] hover:bg-[#16274b] text-cyan-300 active:scale-90 transition-all"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {vodTrackMenu === 'subtitle' && (
                      <div className="space-y-2">
                        <h3 className="text-xs font-black text-cyan-300 uppercase tracking-wider flex items-center gap-1.5">
                          <Captions className="w-3.5 h-3.5" />
                          <span>Felirat választása</span>
                        </h3>
                        <button
                          onClick={() => selectVodSubtitle(null)}
                          className="p-3 w-full rounded-2xl flex items-center justify-between cursor-pointer border border-slate-800 bg-[#0a152d] text-slate-300 hover:bg-[#102042] transition-all"
                        >
                          <span className="text-xs sm:text-sm font-bold">Felirat kikapcsolva</span>
                        </button>
                      </div>
                    )}
                    {vodTrackMenu === 'audio' && (
                      <div className="space-y-2">
                        <h3 className="text-xs font-black text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
                          <Mic2 className="w-3.5 h-3.5" />
                          <span>Hangsáv választása</span>
                        </h3>
                        <div className="space-y-1.5">
                          {vodAudioTracks.length === 0 ? (
                            <p className="rounded-xl border border-slate-700 bg-[#0a152d] p-3 text-xs text-slate-400">
                              A lejátszó nem jelzett választható hangsávot ehhez a filmhez vagy sorozathoz.
                            </p>
                          ) : vodAudioTracks.map((track) => {
                            const languageNames: Record<string, string> = {
                              hu: 'Magyar', hun: 'Magyar', magyar: 'Magyar', hungarian: 'Magyar',
                              en: 'Angol', eng: 'Angol', english: 'Angol', original: 'Eredeti hangsáv',
                              fr: 'Francia', fra: 'Francia', fre: 'Francia', french: 'Francia',
                              de: 'Német', deu: 'Német', ger: 'Német', german: 'Német', deutsch: 'Német',
                              es: 'Spanyol', spa: 'Spanyol', spanish: 'Spanyol',
                              it: 'Olasz', ita: 'Olasz', italian: 'Olasz',
                              pl: 'Lengyel', pol: 'Lengyel', pt: 'Portugál', por: 'Portugál',
                              ro: 'Román', ron: 'Román', rus: 'Orosz', ru: 'Orosz',
                              uk: 'Ukrán', ukr: 'Ukrán', nl: 'Holland', nld: 'Holland',
                              cs: 'Cseh', ces: 'Cseh', sk: 'Szlovák', slk: 'Szlovák',
                              hr: 'Horvát', hrv: 'Horvát', sr: 'Szerb', srp: 'Szerb',
                              sv: 'Svéd', swe: 'Svéd', da: 'Dán', dan: 'Dán',
                              no: 'Norvég', nor: 'Norvég', fi: 'Finn', fin: 'Finn',
                              tr: 'Török', tur: 'Török', ar: 'Arab', ara: 'Arab',
                              el: 'Görög', ell: 'Görög', ja: 'Japán', jpn: 'Japán',
                              ko: 'Koreai', kor: 'Koreai', zh: 'Kínai', zho: 'Kínai',
                            };
                            const rawName = String(track.name || '').trim();
                            const rawLang = String(track.lang || '').trim();
                            const normalize = (value: string) => value.toLowerCase().replace(/_/g, '-');
                            const languageKey = normalize(rawLang);
                            const nameKey = normalize(rawName);
                            const isShortLanguageCode = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(rawName);
                            const isGenericTrackName = /^(?:hangsáv|audio|track|sáv)\\s*#?\\s*\\d+$/i.test(rawName);
                            const displayName = (rawName && !isShortLanguageCode && !isGenericTrackName
                              ? rawName
                              : languageNames[languageKey] || languageNames[languageKey.split('-')[0]] ||
                                languageNames[nameKey] || languageNames[nameKey.split('-')[0]] ||
                                (!isGenericTrackName ? rawName : '') || rawLang || 'Eredeti hangsáv');
                            const hasNativeSelection = vodAudioTracks.some((item) => item.selected === true);
                            const isSelected = track.selected === true
                              || (!hasNativeSelection && String(track.id) === String(vodAudioTracks[0]?.id));
                            const audioMeta = [
                              rawLang && rawLang.toLowerCase() !== displayName.toLowerCase() ? rawLang.toUpperCase() : '',
                              (track as AudioTrack).codec,
                              (track as AudioTrack).channels,
                            ].filter(Boolean).join(' / ');
                            return (
                              <button
                                key={String(track.id)}
                                onClick={() => selectVodAudio(track)}
                                className={`p-3 w-full rounded-2xl flex items-center justify-between cursor-pointer border transition-all ${
                                  isSelected
                                    ? 'bg-[#0f244a] border-cyan-400 text-white shadow-md ring-1 ring-cyan-400/40'
                                    : 'bg-[#0a152d] border-slate-800 text-slate-300 hover:bg-[#102042]'
                                }`}
                              >
                                <div className="min-w-0 text-left">
                                  <span className="block text-xs sm:text-sm font-bold">{displayName}</span>
                                  <span className="block text-[11px] text-slate-400 font-mono mt-0.5">
                                    {audioMeta || 'Elérhető hangsáv'}
                                  </span>
                                </div>
                                {isSelected && <span className="w-6 h-6 rounded-full bg-cyan-400 text-slate-950 flex items-center justify-center shrink-0"><Check className="w-4 h-4 stroke-[3]" /></span>}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {vodTrackMenu === 'subtitle' && (
                      <div className="space-y-1.5">
                        {vodSubtitleTracks.length === 0 ? (
                          <p className="rounded-xl border border-slate-700 bg-[#0a152d] p-3 text-xs text-slate-400">
                            A lejátszó nem jelzett választható feliratsávot ehhez a filmhez vagy sorozathoz.
                          </p>
                        ) : vodSubtitleTracks.map((track) => {
                          const langCode = String(track.lang || '').trim().toLowerCase();
                          const languageNames: Record<string, string> = {
                            hu: 'Magyar', hun: 'Magyar', magyar: 'Magyar', en: 'Angol', eng: 'Angol', english: 'Angol',
                            fr: 'Francia', fra: 'Francia', fre: 'Francia', french: 'Francia', de: 'Német', deu: 'Német',
                            ger: 'Német', german: 'Német', es: 'Spanyol', spa: 'Spanyol', spanish: 'Spanyol',
                            it: 'Olasz', ita: 'Olasz', italian: 'Olasz', pl: 'Lengyel', pol: 'Lengyel',
                            pt: 'Portugál', por: 'Portugál', ro: 'Román', ron: 'Román', ru: 'Orosz', rus: 'Orosz',
                            uk: 'Ukrán', ukr: 'Ukrán', nl: 'Holland', nld: 'Holland', cs: 'Cseh', ces: 'Cseh',
                            sk: 'Szlovák', slk: 'Szlovák', hr: 'Horvát', hrv: 'Horvát', sr: 'Szerb', srp: 'Szerb',
                            sv: 'Svéd', swe: 'Svéd', da: 'Dán', dan: 'Dán', no: 'Norvég', nor: 'Norvég',
                            fi: 'Finn', fin: 'Finn', tr: 'Török', tur: 'Török', ar: 'Arab', ara: 'Arab',
                            el: 'Görög', ell: 'Görög', ja: 'Japán', jpn: 'Japán', ko: 'Koreai', kor: 'Koreai',
                            zh: 'Kínai', zho: 'Kínai',
                          };
                          const rawName = String(track.name || '').trim();
                          const displayName = rawName && !/^[a-z]{2,3}$/i.test(rawName)
                            ? rawName
                            : languageNames[langCode] || languageNames[rawName.toLowerCase()] || rawName || 'Felirat';
                          return (
                            <button
                              key={String(track.id)}
                              onClick={() => selectVodSubtitle(track)}
                              className="p-3 w-full rounded-2xl flex items-center justify-between cursor-pointer border border-slate-800 bg-[#0a152d] text-slate-300 hover:bg-[#102042] transition-all"
                            >
                              <div className="min-w-0 text-left">
                                <span className="block text-xs sm:text-sm font-bold text-white">{displayName}</span>
                                <span className="block text-[11px] text-slate-400 font-mono mt-0.5">
                                  {String(track.lang || '').trim() && String(track.lang).toLowerCase() !== displayName.toLowerCase() ? String(track.lang).toUpperCase() : 'Lejátszó feliratsáv'}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="bg-[#0e1d3b]/95 border-2 border-cyan-500/60 rounded-xl p-3 flex flex-col gap-2.5 shadow-2xl select-none">
              {/* Fejléc */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5 overflow-hidden min-w-0">
                  <div className="shrink-0 w-11 h-9 rounded-lg bg-[#0e1e3e] border border-cyan-800/40 flex items-center justify-center overflow-hidden shadow-inner">
                    <Film className="w-5 h-5 text-cyan-300" />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <h2 className="text-white font-black text-sm sm:text-base truncate tracking-tight">
                      {customTitle || 'Film / Sorozat'}
                    </h2>
                    <div className="flex items-center gap-1.5 text-xs min-w-0">
                      <span className="text-cyan-300 font-bold shrink-0">Film / Sorozat</span>
                      <span className="text-slate-500 shrink-0">•</span>
                      <span className="text-slate-200 font-mono truncate">
                        {formatVodTime(vodCurrentTime)} / {formatVodTime(vodDuration)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); onCloseVod?.(); }}
                    className="w-10 h-10 rounded-xl border border-red-500/60 bg-[#35121b] hover:bg-[#571824] text-red-400 hover:text-red-300 flex items-center justify-center active:scale-90 transition-all shadow-md"
                    title="Film / sorozat bezárása"
                    aria-label="Film / sorozat bezárása"
                  >
                    <X className="w-4 h-4 text-red-400" />
                  </button>
                </div>
              </div>

              {/* Csúsztatható időválasztó */}
              <div className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-right text-[11px] font-mono text-slate-200">
                  {formatVodTime(vodCurrentTime)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(vodDuration, 0.1)}
                  step="0.5"
                  value={Math.min(vodCurrentTime, Math.max(vodDuration, 0.1))}
                  onClick={(e) => e.stopPropagation()}
                  onInput={(e) => seekVod(Number((e.target as HTMLInputElement).value))}
                  onChange={(e) => seekVod(Number(e.target.value))}
                  onPointerDown={(e) => { e.stopPropagation(); vodSeekDraggingRef.current = true; }}
                  onPointerUp={(e) => { e.stopPropagation(); vodSeekDraggingRef.current = false; setShowControlsOverlay(true); }}
                  onPointerCancel={() => { vodSeekDraggingRef.current = false; }}
                  className="h-2 flex-1 cursor-pointer accent-cyan-400 touch-none"
                  aria-label="Film idővonala"
                />
                <span className="w-14 shrink-0 text-[11px] font-mono text-slate-200">
                  {formatVodTime(vodDuration)}
                </span>
              </div>

              {/* Fő vezérlősor: tekerés/lejátszás és hangerő, a főoldali OSD mintájára */}
              <div className="flex items-center gap-1.5 pt-0.5">
                <div className="flex flex-1 items-center justify-center gap-1.5 sm:gap-2 min-w-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); seekVodByConfiguredStep(-1); }}
                    className="w-10 h-10 rounded-xl bg-[#0f1d3a] hover:bg-[#16274b] text-slate-200 border border-slate-700/60 flex items-center justify-center active:scale-90 transition-all shadow-md"
                    title={`Vissza ${settings.seekStep} mp`}
                  >
                    <Rewind className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                    className="w-10 h-10 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 flex items-center justify-center active:scale-95 transition-all shadow-lg shadow-cyan-400/25"
                    title={isPlaying ? 'Szünet' : 'Lejátszás'}
                    aria-label={isPlaying ? 'Szünet' : 'Lejátszás'}
                  >
                    {isPlaying ? <Pause className="w-4 h-4 fill-current stroke-[2.5]" /> : <Play className="w-4 h-4 fill-current stroke-[2.5]" />}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); seekVodByConfiguredStep(1); }}
                    className="w-10 h-10 rounded-xl bg-[#0f1d3a] hover:bg-[#16274b] text-slate-200 border border-slate-700/60 flex items-center justify-center active:scale-90 transition-all shadow-md"
                    title={`Előre ${settings.seekStep} mp`}
                  >
                    <FastForward className="w-4 h-4" />
                  </button>
                </div>
                <div className="relative" ref={volumeControlRef}>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleVolumeButtonClick(); }}
                    className={`w-10 h-10 rounded-xl border flex items-center justify-center active:scale-90 transition-all shadow-md ${isMuted ? 'bg-red-600/20 text-red-400 border-red-500/60' : 'bg-[#0f1d3a] hover:bg-[#16274b] text-slate-200 border-slate-700/60'}`}
                    title={isMuted ? "Dupla kattintás: hangerőcsúszka" : "Egy kattintás: némítás; dupla kattintás: hangerőcsúszka"}
                    aria-label={isMuted ? 'Hang bekapcsolása' : 'Hang némítása'}
                  >
                    {isMuted ? <VolumeX className="w-5 h-5 text-red-400" /> : <Volume2 className="w-5 h-5 text-cyan-300" />}
                  </button>
                  {showVolumeSlider && (
                    <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-[120] min-w-[68px] rounded-xl border border-cyan-700/60 bg-[#081226] px-4 py-3 shadow-2xl" onClick={(event) => event.stopPropagation()}>
                      <input type="range" min="0" max="1" step="0.01" value={volume}
                        onChange={(event) => onVolumeChange(Number(event.target.value))}
                        className="h-24 w-2 cursor-pointer accent-cyan-400" style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                        aria-label="Hangerő" />
                      <div className="mt-1 text-center text-[10px] text-slate-300">{Math.round(volume * 100)}%</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Legalsó sor: Audio + CC + PiP + TV – Kép gomb eltávolítva minden OSD-ből */}
              <div className="grid grid-cols-4 gap-1.5 pt-0.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (vodAudioTracks.length <= 1) {
                      nativeApi()?.toast?.('Ehhez a filmhez nincs másik hangsáv.');
                      return;
                    }
                    setVodTrackMenu(vodTrackMenu === 'audio' ? null : 'audio');
                  }}
                  className={`flex items-center justify-center gap-1 py-2 px-1 rounded-xl text-xs font-bold active:scale-95 transition-all shadow-sm border ${vodAudioTracks.length > 1 ? 'bg-emerald-950/60 hover:bg-emerald-900/70 text-emerald-300 border-emerald-500/50' : 'bg-[#121f3d] hover:bg-[#17274c] text-rose-300 border-rose-500/30'}`}
                  title={vodAudioTracks.length > 1 ? `${vodAudioTracks.length} hangsáv (nyelv) választható` : 'Nincs több hangsáv ennél a filmnél'}
                  aria-label="Hangsáv választása"
                >
                  <Languages className="w-3.5 h-3.5" />
                  <span>Audio</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (vodSubtitleTracks.length === 0) {
                      nativeApi()?.toast?.('Ehhez a filmhez nincs felirat.');
                      return;
                    }
                    setVodTrackMenu(vodTrackMenu === 'subtitle' ? null : 'subtitle');
                  }}
                  className={`flex items-center justify-center gap-1 py-2 px-1 rounded-xl bg-[#121f3d] hover:bg-[#17274c] text-slate-200 border border-slate-700/60 text-xs font-bold active:scale-95 transition-all shadow-sm ${vodSubtitleTracks.length > 0 ? '' : 'text-slate-500 border-slate-800'}`}
                  title={vodSubtitleTracks.length > 0 ? 'Felirat választása' : 'Nincs felirat ehhez a filmhez'}
                  aria-label="Felirat választása"
                >
                  <Captions className="w-3.5 h-3.5 text-cyan-300" />
                  <span>CC</span>
                </button>
                {supportsPictureInPicture && (
                  <button
                    onClick={(e) => { e.stopPropagation(); void togglePictureInPicture(); }}
                    className="w-full flex items-center justify-center gap-1 py-2 px-1 rounded-xl bg-[#121f3d] hover:bg-[#17274c] text-slate-200 border border-slate-700/60 text-xs font-bold active:scale-95 transition-all shadow-sm"
                    title="Kép a képben"
                    aria-label="Kép a képben"
                  >
                    <PictureInPicture2 className="w-3.5 h-3.5 text-slate-300" />
                    <span>PiP</span>
                  </button>
                )}
                {showCastButton && (
                  <button
                    onClick={(e) => { e.stopPropagation(); void castToTv(); }}
                    className="w-full flex items-center justify-center gap-1 py-2 px-1 rounded-xl bg-[#121f3d] hover:bg-[#17274c] text-slate-200 border border-slate-700/60 text-xs font-bold active:scale-95 transition-all shadow-sm"
                    title={castStatus.connected
                      ? `A kép a TV-n megy${castStatus.device ? ' (' + castStatus.device + ')' : ''} – koppints az eszközválasztáshoz`
                      : 'Aktuális film küldése TV-re (Google Cast)'}
                    aria-label="Küldés TV-re"
                  >
                    <Cast className="w-3.5 h-3.5 text-cyan-300" />
                    <span>TV</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Fekvő teljes képernyős élő TV – érintésre semmi ne jelenjen meg, teljesen inaktív */}
            {landscapeLiveFullscreen ? null : (
              /* Normál nézet – alsó gyorsgombok (Kép gomb eltávolítva) */
              <div className="flex items-center justify-between pointer-events-auto">
                <div className="flex items-center gap-2">
                  {!isVod && customStreamUrl && (
                    <>
                      <button onClick={(e) => { e.stopPropagation(); const api = nativeApi(); const pos = api?.position?.() || 0; api?.seekTo?.(Math.max(0, pos - settings.seekStep * 1000)); }} className="p-2 rounded-full bg-black/60 hover:bg-black/90 text-white backdrop-blur-md transition-all active:scale-95" title={'Vissza ' + settings.seekStep + ' mp'}><Rewind className="w-4 h-4" /></button>
                      <button onClick={(e) => { e.stopPropagation(); const api = nativeApi(); const pos = api?.position?.() || 0; const dur = api?.duration?.() || 0; api?.seekTo?.(dur > 0 ? Math.min(dur, pos + settings.seekStep * 1000) : pos + settings.seekStep * 1000); }} className="p-2 rounded-full bg-black/60 hover:bg-black/90 text-white backdrop-blur-md transition-all active:scale-95" title={'Előre ' + settings.seekStep + ' mp'}><FastForward className="w-4 h-4" /></button>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-2" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
