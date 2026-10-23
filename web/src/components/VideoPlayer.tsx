import React, { useRef, useEffect, useState, useCallback } from 'react';
import { AudioTrack, Channel, AppSettings, SubtitleTrack } from '../types/iptv';
import { Rewind, FastForward, Clock } from 'lucide-react';
import { appLog } from '../services/appLog';
import { ChannelLogo } from './ChannelLogo';
import { normalizeTvKey } from '../utils/tvKeys';
import { VodOsd } from './VodOsd';
import {
  VodSubtitleSource,
  SubtitleCue,
  resolveVodSubtitles,
  loadSubtitleCues,
  cueAt,
} from '../services/subtitleService';
import { formatClockTime, normalizeClockOffset } from '../utils/clock';
import {
  alternativeUrl,
  formatOfUrl,
  forgetFormatFor,
  rememberFormatFor,
  rememberGlobalFormat,
  rememberedFormatFor,
  rememberedGlobalFormat,
} from '../services/liveFormatMemory';

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
 * A filmbe muxolt feliratok (HTML5 `textTracks`) kiolvasása.
 * A `mode` értékkel lehet be- és kikapcsolni őket.
 */
function readHtmlSubtitleTracks(video: HTMLVideoElement | null): SubtitleTrack[] {
  if (!video) return [];
  try {
    return Array.from(video.textTracks || []).map((track, index) => ({
      id: index,
      name: track.label || track.language || `Felirat ${index + 1}`,
      lang: track.language || '',
      selected: track.mode === 'showing',
    }));
  } catch {
    return [];
  }
}

/**
 * A beállításokban megadott nyelvhez (alapból Magyar) tartozó sáv megkeresése.
 * A nyelvkódokat és a sávneveket is összeveti, mert a szolgáltatók hol `hu`,
 * hol `hun`, hol `Magyar` alakban adják meg ugyanazt.
 */
const VOD_LANGUAGE_ALIASES: Record<string, string[]> = {
  magyar: ['hu', 'hun', 'magyar', 'hungarian'],
  angol: ['en', 'eng', 'english', 'original'],
  német: ['de', 'deu', 'ger', 'german', 'deutsch'],
  nemet: ['de', 'deu', 'ger', 'german', 'deutsch'],
  francia: ['fr', 'fra', 'fre', 'french', 'francais'],
  olasz: ['it', 'ita', 'italian', 'italiano'],
  spanyol: ['es', 'spa', 'spanish', 'espanol'],
};

function findPreferredVodTrack<T extends { lang?: string; name?: string }>(
  tracks: T[],
  preferred: string,
): T | null {
  const normalize = (value: unknown) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const wanted = normalize(preferred);
  if (!wanted || wanted === 'kikapcsolva' || wanted === 'off') return null;
  const aliases = VOD_LANGUAGE_ALIASES[wanted] || [wanted];
  return tracks.find((track) => [track.lang, track.name].some((value) => {
    const text = normalize(value);
    if (!text) return false;
    const words = text.split(/[^a-z]+/).filter(Boolean);
    return aliases.some((alias) => text === alias || text.includes(alias) || words.includes(alias));
  })) || null;
}

/** A webOS HTMLMediaElement may expose selectable audio tracks through AudioTrackList. */
function readHtmlAudioTracks(video: HTMLVideoElement | null): AudioTrack[] {
  if (!video) return [];
  try {
    const list = (video as HTMLVideoElement & { audioTracks?: ArrayLike<any> }).audioTracks;
    if (!list || typeof list.length !== 'number') return [];
    return Array.from({ length: list.length }, (_, index) => {
      const track = list[index];
      return {
        id: index,
        name: String(track?.label || track?.language || `Hangsáv ${index + 1}`),
        lang: String(track?.language || ''),
        selected: Boolean(track?.enabled),
      };
    });
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
/**
 * SZOLGÁLTATÓI FELIRAT KIRAJZOLÓ.
 *
 * A régi webOS Chromium nem mindig jeleníti meg a `<track>` elemeket, ezért a
 * letöltött feliratot magunk rajzoljuk a kép fölé. Saját, 200 ms-os időzítővel
 * dolgozik, így a másodpercenkénti újrarajzolás nem érinti a teljes lejátszót.
 */
const SubtitleOverlay: React.FC<{
  cues: SubtitleCue[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /**
   * A lejátszás pillanatnyi helyzete másodpercben.
   *
   * NATÍV MOTOR: ilyenkor nem a HTML <video> játssza a filmet, ezért a
   * `video.currentTime` 0 marad – a felirat soha nem jelent volna meg, pedig a
   * sáv be van kapcsolva. A szülő ezért a natív lejátszó pozícióját is ide írja.
   */
  positionRef?: React.RefObject<number>;
  scalePercent: number;
  raised: boolean;
}> = ({ cues, videoRef, positionRef, scalePercent, raised }) => {
  const [text, setText] = useState('');
  useEffect(() => {
    if (cues.length === 0) {
      setText('');
      return;
    }
    const update = () => {
      const reported = positionRef ? Math.max(0, Number(positionRef.current || 0)) : 0;
      const time = reported > 0 ? reported : Number(videoRef.current?.currentTime || 0);
      const next = cueAt(cues, time);
      setText((previous) => (previous === next ? previous : next));
    };
    update();
    const timer = window.setInterval(update, 200);
    return () => window.clearInterval(timer);
  }, [cues, videoRef, positionRef]);

  if (!text) return null;
  const fontSize = Math.max(16, Math.round(22 * (scalePercent / 100)));
  return (
    <div
      data-subtitle-overlay=""
      className={`absolute inset-x-0 z-30 flex justify-center px-6 pointer-events-none transition-all duration-200 ${
        raised ? 'bottom-[22%]' : 'bottom-[8%]'
      }`}
    >
      <div
        className="max-w-[90%] rounded-lg bg-black/70 px-3 py-1.5 text-center font-semibold leading-snug text-white"
        style={{ fontSize: `${fontSize}px`, textShadow: '0 2px 6px rgba(0,0,0,0.95)' }}
      >
        {text.split('\n').map((line, index) => (
          <span key={index} className="block">{line}</span>
        ))}
      </div>
    </div>
  );
};

const BlueClock: React.FC<{ className?: string; offsetHours?: number }> = ({ className, offsetHours = 0 }) => {
  const [time, setTime] = useState('');
  const offset = normalizeClockOffset(offsetHours);
  useEffect(() => {
    const update = () => {
      const next = formatClockTime(offset);
      setTime((previous) => (previous === next ? previous : next));
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
  }, [offset]);
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
   * Az ÉLŐ nézet aktív-e (a főoldal látszik).
   *
   * Ha a felhasználó Mozi/Sorozat nézetben van, az élő adás NEM indulhat el a
   * háttérben (sem kép, sem hang) – korábban a stream betöltése után a
   * lejátszó automatikusan elindult, és film bezárása után a háttérben már
   * szólt is az élő TV.
   */
  playbackActive?: boolean;
  /** A most játszott film/sorozat azonosítói a szolgáltatói FELIRAT (CC) kereséshez. */
  subtitleSource?: VodSubtitleSource | null;
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
  playbackActive = true,
  subtitleSource,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoSurfaceRef = useRef<HTMLDivElement | null>(null);
  const htmlVideoRef = useRef<HTMLVideoElement | null>(null);
  const isVodRef = useRef(Boolean(customStreamUrl));
  isVodRef.current = Boolean(customStreamUrl);
  const playbackActiveRef = useRef(playbackActive);
  playbackActiveRef.current = playbackActive;

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
  // Élő adásnál gyors, soros próbálkozás: eredeti MPEG-TS → HLS → utolsó MPEG-TS.
  // Amint a lejátszás elindul, a watchdog és minden ütemezett újrapróba leáll.
  const autoRetryTimerRef = useRef<number | null>(null);
  const retryStreamRef = useRef<(() => void) | null>(null);
  const pendingStreamUrlRef = useRef('');
  const retryPlanRef = useRef<{ originalUrl: string; stage: 'primary' | 'hls' | 'final-ts' }>({
    originalUrl: '',
    stage: 'primary',
  });
  const bufferWatchdogRef = useRef<number | null>(null);
  const playbackStartedRef = useRef(false);
  /*
   * ÉLŐ: csatornánkénti formátum-tartalék (a napló „Format error” hibáihoz).
   * A `liveFallbackRef` a MÁSIK formátum címe, a `liveFallbackUsedRef` pedig
   * azt jelzi, hogy ebben a csatornaváltásban már megpróbáltuk-e.
   */
  const liveFallbackRef = useRef<{ url: string; format: 'ts' | 'hls' } | null>(null);
  const liveFallbackUsedRef = useRef(false);
  /** Két élő betöltés között legalább ennyi ms teljen el (dekóder-felszabadítás). */
  const lastLiveLoadAtRef = useRef(0);
  const pendingLiveLoadTimerRef = useRef<number | null>(null);
  // Csatornaváltási generáció: a régi stream későn érkező eseményei ne írják felül az új csatorna állapotát.
  const streamLoadGenerationRef = useRef(0);
  const channelSwitchDiagnosticRef = useRef<{
    generation: number;
    startedAt: number;
    channelName: string;
    waitingLogged: boolean;
    canPlayLogged: boolean;
    completed: boolean;
  } | null>(null);
  const videoDiagnosticState = (video: HTMLVideoElement, reason: string): string => {
    const rect = video.getBoundingClientRect();
    const error = video.error;
    return `${reason}; viewport=${Math.round(window.innerWidth)}x${Math.round(window.innerHeight)}; ` +
      `videoBox=${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}; ` +
      `videoSize=${video.videoWidth}x${video.videoHeight}; readyState=${video.readyState}; networkState=${video.networkState}; ` +
      `paused=${video.paused}; currentTime=${Number(video.currentTime || 0).toFixed(2)}; ` +
      `error=${error ? `${error.code}:${error.message || 'nincs részlet'}` : 'nincs'}`;
  };
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
  /** Az éppen kiválasztott csatorna (a hibakezeléshez, dependency nélkül). */
  const channelRef = useRef<typeof channel>(channel);
  channelRef.current = channel;
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
    // Élő TV-n a kézzel kiválasztott formátumot tiszteletben tartjuk:
    // hiba esetén nem váltunk át csendben a másikra. A másik formátum
    // a Rendszer beállításában választható ki.
    if (!isVodRef.current) {
      /*
       * ÉLŐ TV – FORMÁTUM-VISSZAESÉS.
       *
       * Korábban itt AZONNAL hibaüzenet jött („a Rendszer beállításában
       * próbáld ki a másik formátumot”), ezért az a csatorna, amelyik az
       * egyik formátummal nem indult, minden váltásnál ugyanúgy elhalt
       * (a naplóban: „[HU] ATV … Format error” háromszor egymás után).
       * Most a lejátszó MAGA próbálja ki a másik formátumot (TS ↔ HLS),
       * csatornánként EGYSZER; ha az sem megy, akkor jelez hibát.
       */
      const fallback = liveFallbackRef.current;
      if (fallback && !liveFallbackUsedRef.current) {
        liveFallbackUsedRef.current = true;
        const channelName = channelSwitchDiagnosticRef.current?.channelName || 'élő adás';
        retryPlanRef.current = { originalUrl: fallback.url, stage: 'primary' };
        pendingStreamUrlRef.current = fallback.url;
        setHasError(false);
        setErrorMessage('');
        setIsLoading(true);
        setIsPlaying(false);
        appLog(`FORMÁTUM-VISSZAESÉS; csatorna=${channelName}; ${fallback.format === 'hls' ? 'HLS (.m3u8)' : 'MPEG-TS (.ts)'} próba következik.`);
        autoRetryTimerRef.current = window.setTimeout(() => {
          autoRetryTimerRef.current = null;
          retryStreamRef.current?.();
        }, 200);
        return;
      }
      // Egyik formátum sem indult el: a csatorna emlékét töröljük, hogy a
      // következő próba a beállított (alap) formátummal induljon.
      const failedChannel = channelRef.current;
      const hadAlternative = Boolean(liveFallbackRef.current);
      const triedFormats = hadAlternative
        ? (liveFallbackRef.current?.format === 'hls' ? 'MPEG-TS + HLS' : 'HLS + MPEG-TS')
        : 'MPEG-TS';
      if (failedChannel?.id) forgetFormatFor(failedChannel.id);
      /*
       * A napló eddig csak a két CSATORNAVÁLTÁS HIBA sort tartalmazta; abból
       * nem derült ki, hogy a tartalék formátum is lefutott-e. A 2026-10-22-i
       * naplóban („HU - PAX TV”) így utólag kellett kitalálni, hogy mindkét
       * formátum hibás volt. Mostantól egyértelmű sor jelzi a lezárást.
       */
      appLog(
        `MINDKÉT FORMÁTUM SIKERTELEN; csatorna=${String(failedChannel?.name || channelSwitchDiagnosticRef.current?.channelName || 'élő adás').slice(0, 100)}; ` +
        `próbált formátumok=${triedFormats}; a csatorna jelenleg nem indítható. Formátum-emlék törölve.`
      );
      setIsLoading(false);
      setHasError(true);
      setErrorMessage('Ez a csatorna egyik streamformátummal sem indult el. Válassz másik csatornát, vagy állítsd át a formátumot a Rendszer beállításában.');
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

  // LG webOS TV: kizárólag fekvő, 16:9-es nézet. Nincs mobilos
  // tájolásfigyelés vagy késleltetett viewport-ellenőrzés.
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
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
  const [showFullscreenEpg, setShowFullscreenEpg] = useState<boolean>(false);
  const osdHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [vodTrackMenu, setVodTrackMenu] = useState<'audio' | 'subtitle' | null>(null);
  /**
   * Film/sorozat OSD: minden felhasználói művelet (gombnyomás, tekerés)
   * újraindítja az eltűnési időzítőt – így nem tűnik el a kezünk alól.
   */
  const [vodOsdActivity, setVodOsdActivity] = useState<number>(0);
  const handleVodOsdActivity = useCallback(() => {
    setShowControlsOverlay(true);
    setVodOsdActivity((value) => value + 1);
  }, []);

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

  /**
   * TELJES KÉPERNYŐ: a doboz KÉNYSZERÍTETT teljes kijelzős geometriája.
   *
   * MIÉRT KELL: a főoldali 16:9-es keret mérése (`syncMainPageLayout`)
   * INLINE `position: relative`, `inset: auto` és `aspectRatio: 16/9`
   * értékeket ír a dobozra. Az inline stílus erősebb a `fixed` osztálynál,
   * ezért a teljes képernyőre váltás után a doboz a régi helyén maradt (a
   * fejléc alatt), és a kép nem töltötte ki a kijelzőt. Itt minden szükséges
   * értéket felülírunk – a webOS régi Chromiumán is érvényes `vh` egységgel.
   */
  useEffect(() => {
    if (!isFullscreen) return;
    const container = containerRef.current;
    if (!container) return;
    Object.assign(container.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      right: '0px',
      bottom: '0px',
      width: '100vw',
      height: '100vh',
      minWidth: '0px',
      minHeight: '0px',
      maxWidth: 'none',
      maxHeight: 'none',
      margin: '0px',
      padding: '0px',
      border: '0px',
      transform: 'none',
      aspectRatio: 'auto',
      zIndex: '2147483000',
    });
    // Egyetlen kényszerített újramérés: a videóréteg a webOS-on későn frissül.
    void container.offsetHeight;
  }, [isFullscreen]);

  /**
   * A fókusz a teljes képernyős dobozon MARAD.
   *
   * Ha a főoldal egy későbbi újrarajzolása (pl. a csatornalista frissülése)
   * elviszi a fókuszt, a távirányító nyilai a rejtett listára mennének, és a
   * csatornaváltás nem működne. Ezért a belépés után néhányszor ellenőrzünk:
   * ha a fókusz nincs a dobozon (és nem is az OSD egy gombján), visszavisszük.
   */
  useEffect(() => {
    if (!isFullscreen) return;
    const assertFocus = () => {
      const container = containerRef.current;
      if (!container) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== container && container.contains(active)) return; // OSD gomb – marad
      try {
        container.focus({ preventScroll: true } as any);
      } catch {
        /* régi motor */
      }
    };
    const timers = [0, 80, 260, 600].map((delay) => window.setTimeout(assertFocus, delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [isFullscreen]);

  // Teljes képernyőn a fókusz a lejátszóra kerül (így az OK/Vissza azonnal
  // kilép), kilépés után pedig a KIVÁLASZTOTT csatorna sora kapja a fókuszt.
  //
  // FONTOS (a visszatérés hibái): korábban a kilépés után a fókusz a listára
  // került, de a lejátszó doboz megtartotta a kék fókuszkeretét, az OSD pedig
  // eltűnt. Most kilépéskor:
  //   1. a lejátszó elveszti a fókuszt (nincs kék keret a nagy dobozon),
  //   2. az OSD azonnal láthatóvá válik,
  //   3. a csatornalista a kiválasztott sorra állítja a sárga kijelölést.
  const wasFullscreenRef = useRef(false);
  useEffect(() => {
    if (isFullscreen) {
      wasFullscreenRef.current = true;
      window.requestAnimationFrame(() => {
        containerRef.current?.focus({ preventScroll: true } as any);
      });
    } else if (wasFullscreenRef.current) {
      wasFullscreenRef.current = false;
      try { (containerRef.current as HTMLElement | null)?.blur?.(); } catch { /* régi motor */ }
      setShowControlsOverlay(true);
      // Egyetlen következő képkockás fókuszjelzés elég; nincs késleltetett ismétlés.
      window.requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('iptv-focus-selected-channel'));
      });
    }
  }, [isFullscreen]);
  // A webOS TV kizárólag fekvő nézetet használ.
  const isLiveLandscapeFullscreen = isLive && isFullscreen;
  const isVodLandscapeFullscreen = isVod && isFullscreen;
  const landscapeLiveFullscreen = isLiveLandscapeFullscreen;
  const canToggleOsd = isVod && isFullscreen;

  useEffect(() => {
    if (isVod && isFullscreen) {
      setShowControlsOverlay(true);
    } else if (isLiveLandscapeFullscreen) {
      setShowControlsOverlay(false);
    } else {
      setShowControlsOverlay(true);
    }
  }, [isLiveLandscapeFullscreen, isFullscreen, isVod, streamUrl]);

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
  }, [isFullscreen, isVod, settings.aspectRatio, streamUrl]);
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
    if (vodTrackMenu !== null) return;
    if (settings.osdHideDelay > 0 && showControlsOverlay) {
      osdHideTimerRef.current = setTimeout(() => {
        setShowControlsOverlay(false);
        osdHideTimerRef.current = null;
        // Rejtett OSD után a fókusz visszakerül a lejátszóra, hogy OK-val
        // ismét előhívható legyen a panel.
        containerRef.current?.focus({ preventScroll: true } as any);
      }, settings.osdHideDelay * 1000);
    }
    return () => {
      if (osdHideTimerRef.current) {
        clearTimeout(osdHideTimerRef.current);
        osdHideTimerRef.current = null;
      }
    };
  }, [canToggleOsd, showControlsOverlay, settings.osdHideDelay, vodTrackMenu, vodOsdActivity]);

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
    // Film/sorozat: egy kattintás/OK előhozza az OSD-t mindkét tájolásban.
    if (isVod && isFullscreen) {
      setShowControlsOverlay(true);
      return;
    }
    // Élő fekvő: egy kattintásra semmi
    if (isLiveLandscapeFullscreen) return;
    // Élő főoldal (nem fullscreen): egy kattintásra semmi
  }, [isVod, isFullscreen, isLiveLandscapeFullscreen]);

  // Dupla gyors kattintás kezelése
  const handleDoubleTap = useCallback(() => {
    // Film/sorozat: dupla kattintás sem zárja be a lejátszót.
    if (isVod && isFullscreen) {
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
  }, [isVod, isFullscreen, isLive]);

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
    // A lejátszási hiba nem zárhatja csapdába a távirányítót:
    // a Vissza/OK és a csatornaváltó nyilak hibaüzenet mellett is működjenek.
    // LG webOS: régi kulcsnév ('Up') vagy csak keyCode (37-40, OK=13, VISSZA=461) is jöhet.
    const key = normalizeTvKey(e);
    /*
     * FILM / SOROZAT: ha az OSD rejtve van (vagy a fókusz nem az OSD-n van),
     * a távirányító bármelyik nyila hozza elő a vezérlőket. Korábban ilyenkor
     * semmi nem történt, és a felhasználó nem tudta „megfogni” az idővonalat.
     */
    if (isVod && isFullscreen && !vodTrackMenu
        && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown')) {
      const osdRoot = vodOsdRef.current;
      const focusInsideOsd = Boolean(osdRoot && document.activeElement && osdRoot.contains(document.activeElement));
      if (!focusInsideOsd) {
        e.preventDefault();
        e.stopPropagation();
        setShowControlsOverlay(true);
        window.requestAnimationFrame(() => {
          vodOsdRef.current?.querySelector<HTMLElement>('[data-vod-osd-play]')
            ?.focus({ preventScroll: true } as any);
        });
        return;
      }
    }
    if (key === 'Enter' && isVod && isFullscreen) {
      // Az OK előhozza az OSD-t, és az első vezérlőre helyezi a fókuszt.
      // Ha már egy OSD-gombon áll a fókusz, az OSD belső kezelője kapja az OK-t.
      e.preventDefault();
      e.stopPropagation();
      setShowControlsOverlay(true);
      window.requestAnimationFrame(() => {
        const first = vodOsdRef.current?.querySelector<HTMLElement>('[data-vod-osd-play]');
        first?.focus({ preventScroll: true } as any);
      });
    } else if (key === ' ' || key === 'Enter') {
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
      // Film/sorozat teljes képernyőjén a Vissza egyből a megfelelő
      // könyvtárnézetbe tér vissza; ne álljon meg egy köztes ablakos állapotban.
      if (isVod) onCloseVod?.();
      else if (isFullscreen) setIsFullscreen(false);
    } else if (key === 'f' || key === 'F') {
      e.preventDefault();
      e.stopPropagation();
      if (isLive) {
        if (!isFullscreen) setIsFullscreen(true);
        else setIsFullscreen(false);
      }
    }
  }, [hasError, isLive, isVod, isFullscreen, onPrevChannel, onNextChannel, onCloseVod]);
  const [nativeHandoff, setNativeHandoff] = useState<boolean>(false);
  /*
   * Az első képkocka megérkezett-e.
   *
   * A főoldal takaréképe addig marad a képernyőn, amíg ez be nem áll (lásd
   * main.tsx: videoSettled) – így nem villan fel a FEKETE TV-terület a
   * rendszerindítás végén. Amíg ide nem ér, a doboz a csatorna logóját
   * mutatja a fekete kép helyett.
   */
  const [firstFrameShown, setFirstFrameShown] = useState<boolean>(false);
  const [, setNativeMessage] = useState<string>('');

  const [vodCurrentTime, setVodCurrentTime] = useState(0);
  const [vodDuration, setVodDuration] = useState(0);
  /** A film pillanatnyi helyzete a felirat kirajzolásához (natív motornál is). */
  const vodSubtitleClockRef = useRef(0);
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
  /** Film/sorozat: a felhasználó kézzel választott hang- és feliratsávja. */
  const userVodAudioChoiceRef = useRef<string | null>(null);
  const userVodSubtitleChoiceRef = useRef<string | null>(null);
  /**
   * Szolgáltatói (saját kirajzolású) felirat van-e kiválasztva.
   *
   * A filmhez muxolt `<track>` lista 1,5 másodpercenként újraolvasódik; enélkül
   * a jelölő nélkül az olvasás a szolgáltatói feliratot „kikapcsolta” (az aktív
   * azonosítót nullára állította), pedig a felirat a képen látszott – az OSD
   * így azt mutatta, hogy a felirat ki van kapcsolva.
   */
  const providerSubtitleActiveRef = useRef(false);
  /** Egyszer futó automatikus (preferált nyelv) kiválasztás streamenként. */
  const vodTrackAutoSelectKeyRef = useRef<string>('');
  const [, setShowTvAudioMenu] = useState(false);
  const [vodSubtitleTracks, setVodSubtitleTracks] = useState<SubtitleTrack[]>(providedSubtitleTracks || []);
  const [tvSubtitleTracks, setTvSubtitleTracks] = useState<SubtitleTrack[]>([]);
  /**
   * SZOLGÁLTATÓI FELIRATOK (CC).
   *
   * A webOS csak a streambe muxolt feliratokat látja; a filmekhez tartozó
   * külön feliratfájlokat az Xtream válasza sorolja fel. Ezeket itt töltjük
   * be, és a lejátszó maga rajzolja ki (SubtitleOverlay) – így a régi webOS
   * Chromiumon is működik a felirat.
   */
  const [providerSubtitleTracks, setProviderSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [vodSubtitleCues, setVodSubtitleCues] = useState<SubtitleCue[]>([]);
  const providerSubtitleRequestRef = useRef('');
  /**
   * Kézi újrapróbálkozás a szolgáltatói feliratkeresésre.
   *
   * A keresés streamenként egyszer fut (a szolgáltató válasza lassú lehet, és
   * nem akarjuk minden OSD-nyitásnál terhelni). Ha a néző kinyitja a FELIRAT
   * választót, és még nincs egyetlen sáv sem, ez a számláló újraindítja a
   * keresést – így egy időtúllépéssel elvesztett próba nem marad végleges.
   */
  const [subtitleSearchNonce, setSubtitleSearchNonce] = useState(0);

  /*
   * Az új film/sorozat OSD a referenciához hasonlóan a KÉP FÖLÖTT úszik
   * (átmenetes sötétítéssel), ezért nem kell helyet hagyni alatta: a kép
   * végig kitölti a rendelkezésre álló területet. Korábban az OSD egy külön
   * panelsáv volt a kép alatt, és a natív videót ennyivel rövidítettük –
   * erre a felépítésre már nincs szükség.
   */
  const nativeOsdReserve = 0;

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
  // HTML5/webOS élő TV-n kézi feliratválasztás után ne írja felül azt az automata nyelvválasztás.
  const userTvSubtitleChoiceRef = useRef<string | null>(null);
  const nativeSubtitleTrackSignatureRef = useRef('');
  const nativeSubtitleAutoSelectionKeyRef = useRef('');
  const pendingTvSubtitleSelectionRef = useRef<{ id: number | null; startedAt: number } | null>(null);
  const nativeAudioTrackSignatureRef = useRef('');
  const pendingTvAudioSelectionRef = useRef<{ index: number; startedAt: number } | null>(null);
  // HTML5/webOS hangsávváltáskor megőrizzük a kiválasztott sáv sorszámát,
  // hogy ha a TV csak újratöltés után érvényesíti, ugyanazt a sávot állítsuk vissza.
  const pendingHtmlAudioIndexRef = useRef<number | null>(null);
  const htmlAudioReloadingRef = useRef(false);
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
  }, [nativeHandoff, isFullscreen, nativeOsdReserve]);

  // Élő TV fekvő teljes képernyő jelzése és képarány mindig fill (nyújtás)
  useEffect(() => {
    const api = nativeApi();
    if (!api) return;
    // Mindig jelezzük a natívnak hogy fekvő élő fullscreen-e van
    api.setLiveLandscapeFullscreen?.(isLiveLandscapeFullscreen);
    // Mindig fill, mert a beállításokból kivettük a képméret választást
    api.setAspectRatio?.('fill');
  }, [nativeHandoff, isLiveLandscapeFullscreen, isFullscreen, isVod, streamUrl]);

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
    // Új filmnél a kézi sávválasztás is újraindul, hogy a Beállítások →
    // Mozi & Sorozat szerinti alapértelmezett (magyar) nyelv érvényesüljön.
    userVodAudioChoiceRef.current = null;
    userVodSubtitleChoiceRef.current = null;
    providerSubtitleActiveRef.current = false;
    vodTrackAutoSelectKeyRef.current = '';
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
      // A felirat kirajzolója ezt használja (natív motornál a videóé 0 marad).
      vodSubtitleClockRef.current = position;
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

  /**
   * HTML5 hangsávváltás film/sorozat közben.
   *
   * A webOS a legtöbb többnyelvű VOD-streamnél az `audioTracks` listát teszi
   * közzé; a kiválasztott sávot az `enabled` beállításával lehet átkapcsolni.
   * FONTOS: itt szándékosan NINCS forrás-újranyitás (azt az élő TV-nél kell),
   * mert a film újratöltése a lejátszási helyzetet vesztené el.
   */
  const switchHtmlVodAudio = useCallback((index: number) => {
    const video = htmlVideoRef.current as (HTMLVideoElement & { audioTracks?: ArrayLike<any> }) | null;
    const list = video?.audioTracks;
    if (!video || !list || !Number.isInteger(index) || index < 0 || index >= list.length) return false;
    const applyEnabled = (target: (HTMLVideoElement & { audioTracks?: ArrayLike<any> }) | null) => {
      const current = target?.audioTracks;
      if (!current) return;
      for (let i = 0; i < current.length; i++) {
        const enabled = i === index;
        if (Boolean(current[i]?.enabled) !== enabled) current[i].enabled = enabled;
      }
    };
    try {
      applyEnabled(video);
      setVodAudioTracks(readHtmlAudioTracks(video));
      /*
       * AZ ÉLŐ TV LOGIKÁJA (ez működik a TV-n): a webOS a hangsávot gyakran
       * csak a MÉDIAFORRÁS ÚJRANYITÁSÁVAL hajlandó ténylegesen átkapcsolni –
       * a `enabled` beállítása önmagában „látszólag” sikerül, de a hang nem
       * vált. Ilyenkor a forrást újratöltjük, majd a MEGŐRZÖTT pozícióra
       * visszaállunk, és folytatjuk a lejátszást (filmnél ez a lényeg).
       */
      window.setTimeout(() => {
        const active = video.audioTracks;
        const applied = Boolean(active && active[index] && active[index].enabled);
        if (applied) return;
        const url = video.currentSrc || video.src || streamUrl;
        if (!url) return;
        const position = Number(video.currentTime || 0);
        const wasPlaying = !video.paused;
        const restore = () => {
          applyEnabled(video);
          try { video.currentTime = position; } catch { /* a TV motorja később állítja be */ }
          if (wasPlaying) void video.play().catch(() => undefined);
          setVodAudioTracks(readHtmlAudioTracks(video));
        };
        video.addEventListener('loadedmetadata', restore, { once: true });
        video.src = url;
        video.load();
        appLog(`Film hangsávváltás forrás-újranyitással: sáv=${index}, pozíció=${Math.round(position)} mp.`);
      }, 350);
      return true;
    } catch (error) {
      appLog('Film hangsávváltási hiba: ' + String(error));
      return false;
    }
  }, [streamUrl]);

  const selectVodAudio = (track: AudioTrack) => {
    // A hangsávlista lejátszóazonosítót tartalmaz; a selectTrack indexet várna,
    // ami eltérhet, ezért a HTML5 videó-azonosító szerinti API-t használjuk.
    const mpvId = typeof track.id === 'number' ? track.id : Number(track.id);
    const nativeIndex = Number((track as AudioTrack & { nativeIndex?: number }).nativeIndex);
    const api = nativeApi();
    // A kézi választás felülírja az automatikus (preferált nyelv) választást.
    userVodAudioChoiceRef.current = String(track.id);
    if (nativeHandoff && Number.isFinite(mpvId)) {
      api?.selectTrackById?.('audio', mpvId, Number.isFinite(nativeIndex) ? nativeIndex : undefined);
      appLog(`Film/sorozat hangsáv kiválasztva: track id=${mpvId}`
        + (Number.isFinite(nativeIndex) ? `, sorszám=${nativeIndex}` : ''));
    } else if (Number.isFinite(mpvId)) {
      const switched = switchHtmlVodAudio(mpvId);
      appLog(`Film/sorozat hangsáv kiválasztva (HTML5): sáv=${mpvId}, siker=${switched}.`);
      if (!switched) nativeApi()?.toast?.('A lejátszó nem tudta átkapcsolni a hangsávot.');
    }
    setVodTrackMenu(null);
  };

  const selectTvAudio = useCallback((track: AudioTrack) => {
    const mpvId = typeof track.id === 'number' ? track.id : Number(track.id);
    const api = nativeApi();
    if (!api) {
      // LG webOS HTML5 motor: próbáljuk közvetlenül a TV által közzétett
      // AudioTrackList-et vezérelni. A listában az index a webes sávazonosító.
      const video = htmlVideoRef.current as (HTMLVideoElement & { audioTracks?: ArrayLike<any> }) | null;
      const list = video?.audioTracks;
      const index = Number(track.id);
      if (!video || !list || !Number.isInteger(index) || index < 0 || index >= list.length) {
        appLog('A webOS nem tett közzé vezérelhető HTML5 hangsávlistát.');
        setShowTvAudioMenu(false);
        return;
      }
      try {
        pendingHtmlAudioIndexRef.current = index;
        let switched = false;
        for (let i = 0; i < list.length; i++) {
          const enabled = i === index;
          if (Boolean(list[i]?.enabled) !== enabled) switched = true;
          list[i].enabled = enabled;
        }
        const mapped = readHtmlAudioTracks(video);
        setTvAudioTracks(mapped);
        if (!switched || mapped[index]?.selected) {
          pendingHtmlAudioIndexRef.current = null;
          appLog(`webOS HTML5 hangsávváltás azonnal érvényesítve: sáv=${index}.`);
        } else {
          // Egyes webOS változatok csak a médiaforrás újranyitásakor alkalmazzák.
          // Ugyanazt a csatornát töltjük újra, majd visszaállítjuk a kért indexet.
          htmlAudioReloadingRef.current = true;
          const url = video.currentSrc || video.src || streamUrl;
          if (url) {
            video.addEventListener('loadedmetadata', () => {
              const current = video.audioTracks;
              const requested = pendingHtmlAudioIndexRef.current;
              if (current && requested !== null && requested < current.length) {
                for (let i = 0; i < current.length; i++) current[i].enabled = i === requested;
              }
              pendingHtmlAudioIndexRef.current = null;
              htmlAudioReloadingRef.current = false;
              setTvAudioTracks(readHtmlAudioTracks(video));
            }, { once: true });
            video.src = url;
            video.load();
            void video.play().catch(() => undefined);
            appLog(`webOS HTML5 hangsávváltás: csatorna újratöltése, kért sáv=${index}.`);
          } else {
            pendingHtmlAudioIndexRef.current = null;
            htmlAudioReloadingRef.current = false;
          }
        }
      } catch (error) {
        pendingHtmlAudioIndexRef.current = null;
        htmlAudioReloadingRef.current = false;
        appLog('webOS hangsávváltási hiba: ' + String(error));
      }
      setShowTvAudioMenu(false);
      return;
    }
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
    if (nativeHandoff && native) {
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
      return;
    }

    // LG webOS: élő adásnál a HTML5 TextTrackList a tényleges feliratsáv-forrás.
    const video = htmlVideoRef.current;
    if (!video) return;
    const list = video.textTracks;
    const index = track && Number.isInteger(Number(track.id)) ? Number(track.id) : null;
    if (index !== null && (index < 0 || index >= list.length)) {
      appLog(`Élő feliratváltás sikertelen: érvénytelen HTML5 sávindex=${index}.`);
      return;
    }
    userTvSubtitleChoiceRef.current = track ? String(track.id) : 'off';
    try {
      for (let i = 0; i < list.length; i++) {
        list[i].mode = index !== null && i === index ? 'showing' : 'disabled';
      }
      const mapped = readHtmlSubtitleTracks(video);
      setTvSubtitleTracks(mapped);
      const active = mapped.find((item) => item.selected === true);
      activeTvSubtitleIdRef.current = active?.id ?? null;
      appLog(index === null
        ? 'LG webOS élő felirat kikapcsolva.'
        : `LG webOS élő felirat kiválasztva: sáv=${index}; ${track?.lang || track?.name || 'Felirat'}.`);
    } catch (error) {
      appLog('LG webOS élő feliratváltási hiba: ' + String(error));
    }
  }, [nativeHandoff, streamUrl]);

  useEffect(() => {
    onSubtitleTracksChange?.(tvSubtitleTracks);
  }, [tvSubtitleTracks, onSubtitleTracksChange]);

  useEffect(() => {
    onRegisterSubtitleTrackSelector?.(selectTvSubtitle);
    return () => onRegisterSubtitleTrackSelector?.(null);
  }, [onRegisterSubtitleTrackSelector, selectTvSubtitle]);

  /**
   * HTML5 feliratsávok (a filmbe muxolt feliratok) kiolvasása.
   * A böngésző `textTracks` listája a `mode` értékkel kapcsolható.
   */
  const switchHtmlVodSubtitle = (index: number | null) => {
    const video = htmlVideoRef.current;
    if (!video) return false;
    try {
      const list = video.textTracks;
      for (let i = 0; i < list.length; i++) {
        list[i].mode = index !== null && i === index ? 'showing' : 'disabled';
      }
      setVodSubtitleTracks(readHtmlSubtitleTracks(video));
      return true;
    } catch (error) {
      appLog('Film feliratváltási hiba: ' + String(error));
      return false;
    }
  };

  /** A muxolt + szolgáltatói feliratok együtt (ezt látja az OSD). */
  const availableVodSubtitleTracks: SubtitleTrack[] = [
    ...vodSubtitleTracks,
    ...providerSubtitleTracks.filter((provider) =>
      !vodSubtitleTracks.some((track) => String(track.id) === String(provider.id))),
  ];

  const selectVodSubtitleRef = useRef<((track: SubtitleTrack | null) => void) | null>(null);
  const selectVodSubtitle = (track: SubtitleTrack | null) => {
    userVodSubtitleChoiceRef.current = track ? String(track.id) : 'off';
    // SZOLGÁLTATÓI FELIRAT: letöltjük, és a lejátszó rajzolja ki.
    if (track?.url) {
      providerSubtitleActiveRef.current = true;
      switchHtmlVodSubtitle(null);
      setActiveVodSubtitleId(track.id);
      setVodSubtitleCues([]);
      setVodTrackMenu(null);
      appLog(`Film felirat kiválasztva: szolgáltatói sáv=${track.name || track.lang || track.id}.`);
      void loadSubtitleCues(track.url).then((cues) => {
        // Csak akkor tesszük ki, ha közben nem váltottunk másikra.
        setVodSubtitleCues((previous) => (userVodSubtitleChoiceRef.current === String(track.id) ? cues : previous));
        if (userVodSubtitleChoiceRef.current === String(track.id) && cues.length === 0) {
          appLog(`A kiválasztott felirat üres vagy nem olvasható: ${track.name || track.lang || track.id}.`);
        }
      });
      return;
    }
    providerSubtitleActiveRef.current = false;
    if (!track) setVodSubtitleCues([]);
    if (nativeHandoff) {
      const current = activeVodSubtitleId != null ? Number(activeVodSubtitleId) : NaN;
      if (track && Number.isFinite(Number(track.id))) {
        nativeApi()?.selectTrack?.('subtitle', Number(track.id));
        setActiveVodSubtitleId(track.id);
      } else {
        nativeApi()?.deselectTrack?.('subtitle', Number.isFinite(current) ? current : -1);
        setActiveVodSubtitleId(null);
      }
    } else {
      const index = track && Number.isFinite(Number(track.id)) ? Number(track.id) : null;
      switchHtmlVodSubtitle(index);
      setActiveVodSubtitleId(index);
      setVodSubtitleCues([]);
      appLog(index === null ? 'Film felirat kikapcsolva.' : `Film felirat kiválasztva: sáv=${index}.`);
    }
    setVodTrackMenu(null);
  };

  // A feliratválasztó mindig a legfrissebb állapotot látja (az automatikus
  // magyar feliratválasztás ezen keresztül hívja).
  selectVodSubtitleRef.current = selectVodSubtitle;

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

  // HTML5/webOS: folyamatosan figyeljük a TV által ténylegesen közzétett
  // hangsávokat. A ChannelControls ebből számolja a zöld/piros Audio állapotot.
  // Ha a webOS motor nem biztosít AudioTrackList-et, nem találgatunk sávszámot.
  useEffect(() => {
    if (nativeHandoff) return;
    const video = htmlVideoRef.current;
    if (!video) return;
    const refreshHtmlAudioTracks = () => {
      if (htmlAudioReloadingRef.current) return;
      const mapped = readHtmlAudioTracks(video);
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
      const requested = pendingHtmlAudioIndexRef.current;
      if (requested !== null && mapped[requested]?.selected) pendingHtmlAudioIndexRef.current = null;
    };
    refreshHtmlAudioTracks();
    video.addEventListener('loadedmetadata', refreshHtmlAudioTracks);
    video.addEventListener('canplay', refreshHtmlAudioTracks);
    const timer = window.setInterval(refreshHtmlAudioTracks, 1000);
    return () => {
      window.clearInterval(timer);
      video.removeEventListener('loadedmetadata', refreshHtmlAudioTracks);
      video.removeEventListener('canplay', refreshHtmlAudioTracks);
    };
  }, [nativeHandoff, streamUrl]);

  /*
   * FILM / SOROZAT – HTML5 feliratsávok figyelése.
   *
   * A filmbe muxolt feliratok a böngésző `textTracks` listájában jelennek meg
   * (ezek kapcsolhatók be a CC gombbal). A lista késve is érkezhet, ezért a
   * metaadat és az első képkockák után is újraolvassuk.
   */
  useEffect(() => {
    if (!isVod || nativeHandoff) return;
    const video = htmlVideoRef.current;
    if (!video) return;
    const textTracks = video.textTracks;
    const refresh = () => {
      // webOS néha csak később teszi közzé a feliratsávokat, ezért újraolvassuk őket.
      const mapped = readHtmlSubtitleTracks(video);
      setVodSubtitleTracks((previous) => (
        previous.length === mapped.length && previous.every((track, index) =>
          String(track.id) === String(mapped[index]?.id) &&
          track.name === mapped[index]?.name &&
          track.lang === mapped[index]?.lang &&
          track.selected === mapped[index]?.selected
        ) ? previous : mapped
      ));
      const active = mapped.find((track) => track.selected === true);
      // A szolgáltatói felirat aktív azonosítóját ne írjuk felül.
      if (!providerSubtitleActiveRef.current) {
        setActiveVodSubtitleId((previous) => {
          const next = active ? active.id : null;
          return String(previous ?? '') === String(next ?? '') ? previous : next;
        });
      }
    };
    refresh();
    video.addEventListener('loadedmetadata', refresh);
    video.addEventListener('canplay', refresh);
    try {
      textTracks?.addEventListener?.('addtrack', refresh);
      textTracks?.addEventListener?.('removetrack', refresh);
      textTracks?.addEventListener?.('change', refresh);
    } catch { /* régebbi webOS: marad az időzített frissítés */ }
    const timer = window.setInterval(refresh, 750);
    return () => {
      window.clearInterval(timer);
      video.removeEventListener('loadedmetadata', refresh);
      video.removeEventListener('canplay', refresh);
      try {
        textTracks?.removeEventListener?.('addtrack', refresh);
        textTracks?.removeEventListener?.('removetrack', refresh);
        textTracks?.removeEventListener?.('change', refresh);
      } catch { /* régebbi webOS */ }
    };
  }, [isVod, nativeHandoff, streamUrl]);

  /*
   * TÁVIRANYÍTÓ: ZÖLD (hangsáv) / KÉK (felirat) gomb film közben.
   *
   * A webos.js a színes gombot minden fókuszhelyzetben elkapja, ezért a
   * lejátszó külön eseményt kap – így a kék választó doboz akkor is kinyílik,
   * ha az OSD éppen rejtve volt, és a fókusz rögtön a kiválasztott sorra kerül.
   */
  useEffect(() => {
    if (!isVod) return;
    const onVodMenu = (event: Event) => {
      const menu = (event as CustomEvent)?.detail?.menu;
      if (menu !== 'audio' && menu !== 'subtitle') return;
      setVodTrackMenu(menu);
      setShowControlsOverlay(true);
      setVodOsdActivity((value) => value + 1);
      /*
       * FELIRAT választó megnyitása üres listával = kézi újrapróbálkozás.
       * Előfordulhat, hogy az induló keresés hálózati időtúllépésbe futott;
       * ilyenkor a néző ne maradjon felirat nélkül task nélkül.
       */
      if (menu === 'subtitle' && vodSubtitleTracks.length === 0 && providerSubtitleTracks.length === 0) {
        appLog('Felirat választó: nincs sáv – a szolgáltatói feliratkeresés újraindul.');
        providerSubtitleRequestRef.current = '';
        setSubtitleSearchNonce((value) => value + 1);
      }
    };
    window.addEventListener('iptv-vod-menu', onVodMenu);
    return () => window.removeEventListener('iptv-vod-menu', onVodMenu);
  }, [isVod, vodSubtitleTracks.length, providerSubtitleTracks.length]);

  /*
   * SZOLGÁLTATÓI FELIRATOK (CC) keresése a film/sorozat indításakor.
   *
   * Csak akkor indul, ha a stream NEM tesz közzé muxolt feliratot – ilyenkor
   * a szolgáltatótól (Xtream) kérjük le a filmhez tartozó feliratfájlokat.
   * Streamenként egyszer fut, és hálózati hiba esetén csendben feladja.
   */
  useEffect(() => {
    if (!isVod) return;
    if (!subtitleSource) {
      /*
       * Nincs honnan feliratot kérni (nem Xtream szolgáltató, vagy a film /
       * epizód azonosítója nem állapítható meg). Ezt a naplóban jelezzük, hogy
       * a következő hibajegyből kiderüljön: nem a letöltés hibázott.
       */
      const noSourceKey = `nincs-forras|${streamUrl}`;
      if (providerSubtitleRequestRef.current !== noSourceKey) {
        providerSubtitleRequestRef.current = noSourceKey;
        appLog('Feliratkeresés (CC): nincs szolgáltatói forrás ehhez a filmhez (nem Xtream lista vagy hiányzó film/epizód azonosító).');
      }
      setProviderSubtitleTracks([]);
      setVodSubtitleCues([]);
      return;
    }
    const key = `${streamUrl}|${subtitleSource.vodId || ''}|${subtitleSource.seriesId || ''}|${subtitleSource.episodeId || ''}`;
    if (providerSubtitleRequestRef.current === key) return;
    providerSubtitleRequestRef.current = key;
    let cancelled = false;
    setProviderSubtitleTracks([]);
    setVodSubtitleCues([]);
    const timer = window.setTimeout(() => {
      appLog(`Feliratkeresés (CC) indul: ${subtitleSource.vodId ? `vod=${subtitleSource.vodId}` : `sorozat=${subtitleSource.seriesId}, epizód=${subtitleSource.episodeId}`}.`);
      void resolveVodSubtitles(subtitleSource).then((tracks) => {
        if (cancelled || tracks.length === 0) return;
        setProviderSubtitleTracks(tracks);
      });
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isVod, streamUrl, subtitleSource, subtitleSearchNonce]);

  /*
   * FILM / SOROZAT – ALAPÉRTELMEZETT NYELV (Beállítások → Mozi & Sorozat).
   *
   * A felhasználó kérése: a film alap hangja és felirata MAGYAR legyen, ha a
   * stream kínál ilyet. A választás egyszer fut le streamenként, és csak
   * addig, amíg a felhasználó kézzel nem választott sávot az OSD-ben.
   *
   * FONTOS (a CC „ki van kapcsolva” hiba): korábban ez a hatás korán kilépett,
   * ha a lejátszó NEM tett közzé muxolt sávot, illetve ha a natív motor futott.
   * Egy egyszerű (egy hangsávos, muxolt felirat nélküli) filmnél ezért a
   * szolgáltatótól letölthető felirat SOHA nem kapcsolódott be: az OSD-ben a
   * „Felirat kikapcsolva” sor maradt kijelölve, a CC gombon nem volt jelzés.
   */
  useEffect(() => {
    if (!isVod) return;
    const audioSignature = vodAudioTracks.map((track) => `${track.id}:${track.lang}:${track.name}`).join('|');
    const subtitleSignature = vodSubtitleTracks.map((track) => `${track.id}:${track.lang}:${track.name}`).join('|');
    const providerSignature = providerSubtitleTracks.map((track) => `${track.id}:${track.lang}:${track.name}`).join('|');
    if (!audioSignature && !subtitleSignature && !providerSignature) return;
    const key = [
      streamUrl, settings.preferredAudioLang, settings.preferredSubtitle,
      audioSignature, subtitleSignature, providerSignature, nativeHandoff ? 'n' : 'h',
    ].join('~');
    if (key === vodTrackAutoSelectKeyRef.current) return;
    vodTrackAutoSelectKeyRef.current = key;

    // 1) HANGSÁV: itt csak a HTML5 motor sávjait váltjuk. A natív lejátszó
    //    maga választja ki az alapértelmezett hangsávot – azt nem piszkáljuk
    //    (a hang jelenleg hibátlanul működik).
    if (!nativeHandoff
        && userVodAudioChoiceRef.current === null && vodAudioTracks.length > 1) {
      const activeAudio = vodAudioTracks.find((track) => track.selected === true);
      const preferredAudio = findPreferredVodTrack(vodAudioTracks, settings.preferredAudioLang || 'Magyar');
      if (preferredAudio && String(preferredAudio.id) !== String(activeAudio?.id)) {
        switchHtmlVodAudio(Number(preferredAudio.id));
        appLog(`Automatikus film-hangsáv: ${preferredAudio.lang || preferredAudio.name} (beállítás: ${settings.preferredAudioLang}).`);
        return; // a frissült sávlista alapján a felirat a következő körben jön
      }
    }

    // 2) FELIRAT: a kézi választást és a már bekapcsolt feliratot nem írjuk felül.
    const preferredSubtitle = (settings.preferredSubtitle || 'Magyar').trim();
    const subtitlesOff = preferredSubtitle.toLowerCase() === 'kikapcsolva';
    if (subtitlesOff || userVodSubtitleChoiceRef.current !== null) return;
    if (providerSubtitleActiveRef.current || vodSubtitleCues.length > 0) return;
    if (vodSubtitleTracks.some((track) => track.selected === true)) return;

    // 2a) A streambe MUXOLT (a lejátszó saját sávlistájában szereplő) felirat.
    const preferredTrack = findPreferredVodTrack(vodSubtitleTracks, preferredSubtitle);
    if (preferredTrack) {
      if (nativeHandoff) {
        // Natív motor: a sávot a lejátszó kapcsolja be, nem a HTML <track>.
        selectVodSubtitleRef.current?.(preferredTrack);
        appLog(`Automatikus film-felirat (natív): ${preferredTrack.lang || preferredTrack.name} (beállítás: ${preferredSubtitle}).`);
      } else {
        switchHtmlVodSubtitle(Number(preferredTrack.id));
        appLog(`Automatikus film-felirat: ${preferredTrack.lang || preferredTrack.name} (beállítás: ${preferredSubtitle}).`);
      }
      return;
    }

    // 2b) Nincs (megfelelő) muxolt felirat: a szolgáltatótól letöltött CC.
    //     Ha a beállított nyelven nincs, de csak EGY felirat van, azt kapcsoljuk
    //     be – a felhasználó kérése, hogy a CC ne maradjon kikapcsolva.
    const providerTrack = findPreferredVodTrack(providerSubtitleTracks, preferredSubtitle)
      || (providerSubtitleTracks.length === 1 ? providerSubtitleTracks[0] : null);
    if (providerTrack) {
      selectVodSubtitleRef.current?.(providerTrack);
      appLog(`Automatikus szolgáltatói felirat: ${providerTrack.lang || providerTrack.name} (beállítás: ${preferredSubtitle}).`);
    } else if (providerSubtitleTracks.length > 1) {
      appLog(`Szolgáltatói felirat: nincs „${preferredSubtitle}” sáv (${providerSubtitleTracks.map((track) => track.lang || track.name).join(', ')}); a CC gombbal választható.`);
    }
  }, [
    isVod, nativeHandoff, streamUrl, vodAudioTracks, vodSubtitleTracks,
    providerSubtitleTracks, vodSubtitleCues.length,
    settings.preferredAudioLang, settings.preferredSubtitle, switchHtmlVodAudio,
  ]);

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

  /*
   * LG webOS – élő TV feliratsávok, ugyanazzal a nyelvpreferenciás és
   * visszaellenőrző logikával, mint Androidon, a webOS HTML5 TextTrack API-jára
   * illesztve. A TV késve is közzéteheti a sávokat, ezért esemény + polling fut.
   */
  useEffect(() => {
    if (nativeHandoff || isVod) return;
    const video = htmlVideoRef.current;
    if (!video) return;
    const textTracks = video.textTracks;

    const refreshHtmlTvSubtitleTracks = () => {
      const mapped = readHtmlSubtitleTracks(video);
      const signature = mapped.map((item) => `${item.id}:${item.lang}:${item.name}`).join('|');
      nativeSubtitleTrackSignatureRef.current = signature;
      setTvSubtitleTracks((previous) => (
        previous.length === mapped.length && previous.every((item, index) =>
          String(item.id) === String(mapped[index]?.id) &&
          item.name === mapped[index]?.name &&
          item.lang === mapped[index]?.lang &&
          item.selected === mapped[index]?.selected
        ) ? previous : mapped
      ));
      const active = mapped.find((item) => item.selected === true);
      activeTvSubtitleIdRef.current = active?.id ?? null;

      // Kézi választás (a felirat kikapcsolását is beleértve) maradjon érvényben
      // az adott csatornán; automatikusan csak új csatorna/sávlista esetén választunk.
      if (userTvSubtitleChoiceRef.current !== null) return;
      const preferred = (settings.preferredSubtitle || 'Magyar').trim();
      const selectionKey = `${streamUrl}|${signature}|${preferred.toLowerCase()}`;
      if (selectionKey === nativeSubtitleAutoSelectionKeyRef.current) return;
      nativeSubtitleAutoSelectionKeyRef.current = selectionKey;

      if (preferred.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase() === 'kikapcsolva') {
        for (let i = 0; i < textTracks.length; i++) textTracks[i].mode = 'disabled';
        setTvSubtitleTracks(readHtmlSubtitleTracks(video));
        activeTvSubtitleIdRef.current = null;
        return;
      }
      const target = findPreferredVodTrack(mapped, preferred) || mapped[0] || null;
      if (target && target.selected !== true) {
        const targetIndex = Number(target.id);
        for (let i = 0; i < textTracks.length; i++) {
          textTracks[i].mode = i === targetIndex ? 'showing' : 'disabled';
        }
        const refreshed = readHtmlSubtitleTracks(video);
        setTvSubtitleTracks(refreshed);
        activeTvSubtitleIdRef.current = target.id;
        appLog(`Automatikus LG élő feliratválasztás: ${target.lang || target.name} (beállítás: ${preferred}).`);
      }
    };

    refreshHtmlTvSubtitleTracks();
    video.addEventListener('loadedmetadata', refreshHtmlTvSubtitleTracks);
    video.addEventListener('canplay', refreshHtmlTvSubtitleTracks);
    try {
      textTracks?.addEventListener?.('addtrack', refreshHtmlTvSubtitleTracks);
      textTracks?.addEventListener?.('removetrack', refreshHtmlTvSubtitleTracks);
      textTracks?.addEventListener?.('change', refreshHtmlTvSubtitleTracks);
    } catch { /* régebbi webOS: az időzített frissítés megmarad */ }
    const timer = window.setInterval(refreshHtmlTvSubtitleTracks, 750);
    return () => {
      window.clearInterval(timer);
      video.removeEventListener('loadedmetadata', refreshHtmlTvSubtitleTracks);
      video.removeEventListener('canplay', refreshHtmlTvSubtitleTracks);
      try {
        textTracks?.removeEventListener?.('addtrack', refreshHtmlTvSubtitleTracks);
        textTracks?.removeEventListener?.('removetrack', refreshHtmlTvSubtitleTracks);
        textTracks?.removeEventListener?.('change', refreshHtmlTvSubtitleTracks);
      } catch { /* régebbi webOS */ }
    };
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
    /*
     * ZAPPOLÁSI KORLÁT (fagyás-védelem).
     *
     * A napló szerint a néző ~3 perc alatt kb. 40 csatornát váltott. A webOS
     * médiamotorja minden váltásnál új dekódert nyit, a régit pedig csak
     * később engedi el; sűrű váltásnál ez a TV-n az egész app lefagyásához
     * vezethet. Ezért két élő betöltés között legalább 300 ms telik el, és a
     * közben érkező kéréseket ÖSSZEVONJUK (mindig a legfrissebb cím indul).
     */
    if (!isVodRef.current && !customStreamUrl) {
      const now = Date.now();
      const since = now - lastLiveLoadAtRef.current;
      if (since >= 0 && since < 300) {
        if (pendingLiveLoadTimerRef.current !== null) {
          window.clearTimeout(pendingLiveLoadTimerRef.current);
        }
        const wait = 300 - since;
        pendingLiveLoadTimerRef.current = window.setTimeout(() => {
          pendingLiveLoadTimerRef.current = null;
          loadStreamRef.current?.(url);
        }, wait);
        appLog(`VÁLTÁS ÖSSZEVONÁS: ${wait} ms várakozás a dekóder felszabadítására.`);
        return;
      }
      lastLiveLoadAtRef.current = now;
    }
    const loadGeneration = ++streamLoadGenerationRef.current;
    const isCurrentLoad = () => loadGeneration === streamLoadGenerationRef.current;
    clearZapWatchdog();
    clearBufferWatchdog();
    playbackStartedRef.current = false;
    setTvAudioTracks([]);
    setTvSubtitleTracks([]);
    activeTvSubtitleIdRef.current = null;
    userTvSubtitleChoiceRef.current = null;
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
    // Élő adás csak akkor indul, ha a főoldal (élő nézet) látszik.
    if (!isVod && !playbackActiveRef.current) return;
    if (!video) {
      setIsLoading(false);
      setHasError(true);
      setErrorMessage('Az LG webOS videóelem még nem áll készen.');
      return;
    }
    try {
      if (!customStreamUrl) {
        channelSwitchDiagnosticRef.current = {
          generation: loadGeneration,
          startedAt: Date.now(),
          channelName: String(channel?.name || 'Ismeretlen csatorna'),
          waitingLogged: false,
          canPlayLogged: false,
          completed: false,
        };
        const channelMemory = rememberedFormatFor(channel?.id);
        const globalMemory = rememberedGlobalFormat();
        appLog(`CSATORNAVÁLTÁS START; csatorna=${String(channel?.name || 'Ismeretlen csatorna').slice(0, 100)}; stream=${/\.m3u8(?=([?#]|$))/i.test(url) ? 'HLS' : /\.ts(?=([?#]|$))/i.test(url) ? 'MPEG-TS' : 'egyéb'}; formátum-emlék=${channelMemory || 'nincs (alap)'}${channelMemory ? '' : `; globális-emlék=${globalMemory || 'nincs'}`}; tartalék=${liveFallbackRef.current ? liveFallbackRef.current.format.toUpperCase() : 'nincs'}; ${videoDiagnosticState(video, 'betöltés előtt')}`);
      }
      video.pause();
      /*
       * HIBAÁLLAPOT TÖRLÉSE.
       *
       * A naplóban a következő csatorna indítása így nézett ki:
       *   „paused=true; error=4:MEDIA_ELEMENT_ERROR: Format error”
       * vagyis a videóelem MEGTARTOTTA az előző csatorna hibáját, és a
       * következő `src` beállítása ezzel a hibával indult. Ilyenkor (és csak
       * ilyenkor) teljesen lebontjuk a forrást, mert különben a webOS a
       * hibás állapotot viszi tovább az új adásra.
       */
      if (video.error) {
        try {
          video.removeAttribute('src');
          video.load();
          appLog('Lejátszó hibaállapot törlése a csatornaváltás előtt (a forrás lebontása).');
        } catch { /* régi motor */ }
      }
      // GYORS VÁLTÁS: korábban itt `removeAttribute('src')` + `load()` állt,
      // ami a lejátszó teljes lebontását és újraindítását kényszerítette
      // (webOS-on 0,3-1 másodperc). A `src` felülírása ugyanúgy megszakítja a
      // régi adást, csak a dekóder újraindítása marad el.
      // Korábbi <source> gyerekek eltakarítása (motorváltásnál is tiszta lap).
      while (video.firstChild) video.removeChild(video.firstChild);
      // CSATORNAVÁLTÁS MINDKÉT MOTORRAL:
      // A videóelem `src`-jét mindig felülírjuk. Korábban a natív mód
      // <source mediaOption=...> elemet fűzött be, ami a TV-n nem indította
      // el az adást (a csatornaváltás „nem történt meg”), ezért a natív mód is
      // a közvetlen címet kapja: a szolgáltató EREDETI URL-jét, formátum-átírás
      // nélkül, a TV hardveres dekóderén. A két motor között a különbség a
      // címválasztás és a hibakezelés (natívnál nincs formátumváltás), nem a
      // lejátszás útja.
      video.src = url;
      // A src beállítása elindítja a HTML5 betöltést; a külön load() újabb resetet okozhat.
      video.volume = Math.max(0, Math.min(1, volume));
      video.muted = volume <= 0;
      const playPromise = video.play();
      setIsPlaying(true);
      // ZAP-ŐR: ha az élő adás nem indul el időben (a HLS-próba csak "lóg",
      // se hiba, se kép), nem várunk a végtelenségig pörgő töltésre -
      // automatikusan a következő formátumra (MPEG-TS) váltunk.
      if (!customStreamUrl) {
        const { watchdogMs } = bufferTiming();
        zapWatchdogRef.current = window.setTimeout(() => {
          zapWatchdogRef.current = null;
          if (isCurrentLoad() && !playbackStartedRef.current) {
            appLog('Zap-őr: nem indult el az adás időben, automatikus formátumváltás.');
            scheduleAutoRetry();
          }
        }, watchdogMs);
      }
      if (playPromise && typeof playPromise.catch === 'function') {
        void playPromise.catch((error: unknown) => {
          if (!isCurrentLoad() || video.error) return;
          appLog('A lejátszásindítási ígéret hibázott; automatikus streampróba indul.');
          scheduleAutoRetry();
          if (!autoRetryTimerRef.current) {
            setIsLoading(false);
            setHasError(true);
            setErrorMessage(error instanceof Error && error.name === 'NotAllowedError'
              ? 'A TV lejátszási indítást blokkolta. Nyomj az Újrapróbálás gombra.'
              : 'A TV nem tudta elindítani ezt az adatfolyamot. Ellenőrizd az URL-t és a stream formátumát.');
          }
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
    //
    // FONTOS (a csatornaváltás lassúsága): korábban az első próba MINDIG a
    // szolgáltató címéből átírt .m3u8 volt. Az átírás egy plusz kérést és egy
    // lejátszási lista feldolgozását jelentette minden váltásnál, ami webOS-on
    // fél-egy másodperc. Most a szolgáltató által adott cím megy először
    // (általában .ts), és csak ha az nem indul el, váltunk .m3u8-ra. Ha a
    // legutóbb sikeres formátum HLS volt, azt használjuk elsőként.
    // A kézi formátumválasztás elsőbbséget élvez a korábbi sikeres formátummal szemben.
    // A .ts/.m3u8 kiterjesztést a választott formátumhoz igazítjuk, ha lehetséges.
    const hlsUrl = streamUrl.replace(/\.ts(?=([?#]|$))/i, '.m3u8');
    const tsUrl = /\.ts(?=([?#]|$))/i.test(streamUrl)
      ? streamUrl
      : streamUrl.replace(/\.m3u8(?=([?#]|$))/i, '.ts');
    const selectedFormat = settings.streamFormat === 'hls' ? 'hls' : 'ts';
    // Gyors csatornaváltás: mindkét LG lejátszó-beállításnál ugyanazt a
    // legutóbb sikeresen elindult élő formátumot próbáljuk először.
    // A beállított formátum csak akkor az elsődleges, ha még nincs sikeres
    // korábbi próba eltárolva. Hibánál a meglévő zap-őr próbálkozik tovább.
    let rememberedFormat: 'ts' | 'hls' | null = null;
    if (!isVod) {
      /*
       * CSATORNÁNKÉNTI EMLÉKEZET elsőbbséggel: ha ezt a csatornát legutóbb
       * HLS-sel sikerült elindítani, most is azzal kezdünk (és fordítva).
       * Csak ha a csatornához még nincs bejegyzés, a globális emlékezet jön.
       */
      rememberedFormat = rememberedFormatFor(channel?.id);
      if (!rememberedFormat) rememberedFormat = rememberedGlobalFormat();
    }
    const primaryFormat = rememberedFormat || selectedFormat;
    const primaryUrl = isVod
      ? streamUrl
      : (primaryFormat === 'hls' ? hlsUrl : tsUrl);
    pendingStreamUrlRef.current = primaryUrl;
    retryPlanRef.current = { originalUrl: primaryUrl, stage: 'primary' };
    // A MÁSIK formátum címe: hibánál ezt próbálja ki a lejátszó egyszer.
    liveFallbackRef.current = isVod ? null : alternativeUrl(primaryUrl);
    liveFallbackUsedRef.current = false;
    /*
     * HÁTTÉR-BENNENTARTÁS: ha nem az élő nézet látszik (Mozi/Sorozat), az élő
     * adást el sem indítjuk – sem kép, sem hang nem megy a háttérben.
     */
    if (!isVod && !playbackActive) {
      const video = htmlVideoRef.current;
      if (video) {
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
        } catch { /* régi motor */ }
      }
      playbackStartedRef.current = false;
      setIsLoading(false);
      setIsPlaying(false);
      return;
    }
    if (primaryUrl) {
      loadStreamRef.current(primaryUrl);
    }
    return () => {
      clearBufferWatchdog();
      playbackStartedRef.current = false;
      clearAutoRetry(false);
      // A következő csatorna már úgyis indul: a várakozó (összevont) betöltést
      // eldobjuk, nehogy a lecserélt csatornát indítsa el később.
      if (pendingLiveLoadTimerRef.current !== null) {
        window.clearTimeout(pendingLiveLoadTimerRef.current);
        pendingLiveLoadTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey, clearAutoRetry, clearBufferWatchdog, settings.streamFormat, playbackActive]);

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

  // Teljes képernyőből VISSZATÉRÉSKOR csak a főoldali lejátszó méretét
  // állítjuk helyre. A teljes képernyős megjelenítés logikáját szándékosan
  // nem módosítjuk. WebOS-en a fullscreenből kilépés után a régi viewport
  // néha megmarad, ezért több képkockán és a tényleges konténer méretváltozásán
  // keresztül is újramérjük a 16:9-es főoldali keretet.
  useEffect(() => {
    if (isVod || isFullscreen) return;

    let frame1 = 0;
    const settleTimers: number[] = [];
    const syncMainPageLayout = () => {
      if (isFullscreen) return;
      // Biztonsági háló: a teljes képernyős állapot a body-osztályon is látszik,
      // így egy korábban ütemezett (elavult) hívás sem teheti vissza a 16:9-es
      // keretet a teljes képernyős dobozra.
      try {
        if (document.body.classList.contains('iptv-tv-fullscreen')) return;
      } catch { /* régi motor */ }
      const container = containerRef.current;
      const video = htmlVideoRef.current;
      if (!container || !video) return;

      Object.assign(container.style, {
        position: 'relative',
        inset: 'auto',
        left: 'auto',
        right: 'auto',
        top: 'auto',
        bottom: 'auto',
        width: '100%',
        height: 'auto',
        minHeight: '0',
        maxHeight: 'none',
        aspectRatio: '16 / 9',
        zIndex: 'auto',
        transform: 'none',
      });
      Object.assign(video.style, {
        display: 'block',
        position: 'absolute',
        inset: '0px',
        width: '100%',
        height: '100%',
        minWidth: '0',
        minHeight: '0',
        maxWidth: 'none',
        maxHeight: 'none',
        aspectRatio: 'auto',
        // A főoldali élő videó KITÖLTSE a keretet (nincs üres sáv), de
        // tartsa meg a forrás képarányát (nincs torzítás): a `cover`
        // pontosan ezt teszi, a `contain` üres sávot hagyna.
        objectFit: 'cover',
      });
      // Egyetlen kényszerített újramérés a webOS Chromium későn frissülő
      // videórétegéhez. A korábbi két egymást követő mérés ugyanazt a
      // kényszerített elrendezést verte ki – a második felesleges volt.
      void container.offsetHeight;
    };
    /*
     * Teljesítmény: minden csatornaváltáskor NINEZ kényszerített
     * újramérés futott (4 időzítő + 4 animációs kép), és mindegyik
     * újrarajzolta a teljes 16:9-es keretet. Ez feleslegesen lassította a
     * csatornaváltást a tévén.
     *
     * Most: egy azonnali szinkron, egy animációs kép (a böngésző akkor
     * végzi el az elrendezést) és EGY időzítő késői elrendezés-változásra.
     * A ResizeObserver szintén csak akkor hívja meg, ha tényleg változott a
     * méret – nem minden képkockánál.
     */
    const syncAfterLayout = () => {
      syncMainPageLayout();
      frame1 = window.requestAnimationFrame(() => {
        syncMainPageLayout();
      });
      settleTimers.forEach((timer) => window.clearTimeout(timer));
      settleTimers.length = 0;
      settleTimers.push(window.setTimeout(syncMainPageLayout, 250) as unknown as number);
    };

    syncAfterLayout();
    const parent = containerRef.current?.parentElement;
    const observer = typeof ResizeObserver !== 'undefined' && parent
      ? new ResizeObserver(syncAfterLayout)
      : null;
    if (parent) observer?.observe(parent);
    window.addEventListener('resize', syncAfterLayout);
    window.addEventListener('orientationchange', syncAfterLayout);
    window.visualViewport?.addEventListener('resize', syncAfterLayout);
    document.addEventListener('fullscreenchange', syncAfterLayout);
    document.addEventListener('visibilitychange', syncAfterLayout);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame1);
      settleTimers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener('resize', syncAfterLayout);
      window.removeEventListener('orientationchange', syncAfterLayout);
      window.visualViewport?.removeEventListener('resize', syncAfterLayout);
      document.removeEventListener('fullscreenchange', syncAfterLayout);
      document.removeEventListener('visibilitychange', syncAfterLayout);
    };
  }, [isFullscreen, isVod, streamUrl]);

  /**
   * Teljes képernyő: PURE CSS-ÁTFEDÉS, soha nem a böngésző Fullscreen API-ja.
   *
   * A referenciához (sharktie/lg-iptv) igazodva a teljes képernyő ugyanaz az
   * oldal, ugyanaz a <video> elem és ugyanaz a stream: csak a `body`
   * osztálya és a konténer mérete változik. Nincs új oldal, nincs új
   * kapcsolat, nincs új dekóler – a váltás azonnali.
   *
   * A natív Fullscreen API webOS-on két okból rossz:
   *   • az 5.40-es webOS-on félig tölti ki a képernyőt a videó, és a GUI
   *     látható marad, miközben a teljes képernyőt JELENTI – vagyis
   *     nem kimutatható és nem mérhető;
   *   • a Chromium :fullscreen UA stíluslapja `transform: none !important`
   *     kényszerít a teljes képernyős elemre, ami újraépíti a videó
   *     kompozíciós rétegét és NULLÁZZA a hardveres dekódolót (a lejátszás
   *     ~10 mp után "nem játszik" hibával leáll).
   * A CSS-átfedés csak a pozíciót és a méretet változtatja, így a
   * videóréteg sosem épül újra.
   */
  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;

    // Natív kép (a webOS hardveres lejátszója): a webes konténer lesz
    // teljes képernyős, a natív videó téglalapja a videóelemhez igazodik.
    // Az OSD ilyenkor is ugyanaz a kezelőfelület marad.
    setIsFullscreen((previous) => !previous);
    setShowControlsOverlay(true);
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
      /* Film/sorozat alatt ez a jelölés mondja meg a webos.js-nek, hogy a
         ZÖLD/KÉK gomb a lejátszó kék OSD-jét nyitja (hangsáv / felirat). */
      data-vod-active={isVod ? '1' : undefined}
      data-player-engine={playerEngine}
      tabIndex={isFullscreen ? 0 : -1}
      onKeyDown={handleKeyDown}
      onMouseMove={handleMouseMove}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onClick={handleSurfaceTap}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      className={`relative w-full ${isFullscreen ? 'h-screen max-h-none aspect-auto fixed inset-0 z-[9999]' : 'flex-1 min-h-0 max-h-none'} ${nativeHandoff ? 'bg-transparent' : 'bg-black'} overflow-hidden group select-none focus:outline-none focus-visible:outline-none ${isFullscreen ? '' : 'shadow-2xl border-b border-cyan-900/30'}`}
      /*
       * TELJES KÉPERNYŐ: a geometria INLINE, `vh` egységgel.
       *
       * A `100dvh` a régi webOS Chrome-on (webOS 3/4/5) nem létezik, a
       * Tailwind `inset` shorthandje szintén újabb – ilyenkor a doboz nem
       * töltötte ki a kijelzőt. A `position: fixed` és a bal/felső/alsó/jobb
       * érték itt közvetlenül, minden motortól függetlenül érvényes.
       */
      style={isFullscreen
        ? {
            position: 'fixed',
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            width: '100vw',
            height: '100vh',
            minWidth: 0,
            minHeight: 0,
            maxWidth: 'none',
            maxHeight: 'none',
            margin: 0,
            padding: 0,
            border: 0,
            transform: 'none',
            aspectRatio: 'auto',
            zIndex: 2147483000,
          }
        : { width: '100%', height: '100%', minHeight: 0, maxHeight: 'none', aspectRatio: 'auto' }}
    >
      {/* Három külön elrendezés: főoldali 16:9, álló teljes képernyőn 16:9 keret (élő TV és VOD is), fekvőben teljes kijelző. */}
      {/* Amíg az első képkocka meg nem érkezik, a doboz NEM fekete: a
          csatorna nevét és logóját mutatja. Így a rendszerindítás végén nem
          villan fel üres fekete TV-terület. */}
      {!isVod && !firstFrameShown && (
        <div
          data-player-poster=""
          className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-3 bg-[#0a1220] pointer-events-none"
        >
          <div className="h-16 w-16 md:h-24 md:w-24 flex items-center justify-center overflow-hidden rounded-xl border border-cyan-800/50 bg-[#0e1e3e]">
            <ChannelLogo url={channel?.logo} name={channel?.name || ''} retryKey={channel?.id} />
          </div>
          <div className="max-w-[80%] truncate text-center text-lg font-bold text-slate-300 md:text-2xl">
            {channel?.name || 'Kapcsolódás…'}
          </div>
        </div>
      )}

      <div
        ref={videoSurfaceRef}
        className="absolute inset-0 bg-transparent pointer-events-none"
      >
        {!nativeApi()?.play && (
          <video
            ref={htmlVideoRef}
            data-iptv-player="true"
            className="block h-full w-full bg-black"
            // Élő TV: a kép KITÖLTI a területet (nincs üres sáv) és megtartja
            // a stream saját arányát (nincs torzítás) – a `cover` vágja
            // le a kilógó részt. A VOD viselkedését változatlanul hagyjuk.
            style={{ objectFit: isVod ? (isFullscreen ? 'fill' : 'contain') : 'cover' }}
            playsInline
            preload="auto"
            onPlaying={(event) => {
              playbackStartedRef.current = true;
              // A főoldal ebből tudja, hogy a TV-kép kész (nincs fekete doboz).
              try {
                (window as any).__IPTV_VIDEO_READY__ = true;
              } catch { /* nincs window */ }
              setFirstFrameShown((previous) => previous || true);
              if (!isVod) {
                const diagnostic = channelSwitchDiagnosticRef.current;
                if (diagnostic && diagnostic.generation === streamLoadGenerationRef.current && !diagnostic.completed) {
                  diagnostic.completed = true;
                  appLog(`CSATORNAVÁLTÁS KÉP ELINDULT; csatorna=${diagnostic.channelName}; idő=${Date.now() - diagnostic.startedAt} ms; ${videoDiagnosticState(htmlVideoRef.current || event.currentTarget, 'playing')}`);
                }
              }
              nativeRetryCountRef.current = 0;
              // A sikeresen elindult élő formátumot megjegyezzük a gyors zappoláshoz.
              if (!isVod && !customStreamUrl) {
                /*
                 * SIKERES FORMÁTUM MEGJEGYZÉSE – csatornánként ÉS globálisan.
                 * A csatornánkénti bejegyzés miatt a következő váltásnál
                 * rögtön a működő formátummal indul (nincs újabb hiba).
                 */
                const url = pendingStreamUrlRef.current || '';
                const format = formatOfUrl(url);
                if (format) {
                  const target = channelRef.current;
                  const previousFormat = target?.id ? rememberedFormatFor(target.id) : null;
                  rememberGlobalFormat(format);
                  if (target?.id) rememberFormatFor(target.id, format);
                  /*
                   * Csak VÁLTOZÁSKOR naplózzuk (nem minden zappolásnál): így a
                   * következő hibajegyből látszik, hogy a csatornánkénti
                   * formátumemlékezet valóban elmentődött, és visszatéréskor
                   * „formátum-emlék=…” jelenik meg a CSATORNAVÁLTÁS START sorban.
                   */
                  if (target?.id && previousFormat !== format) {
                    appLog(
                      `FORMÁTUM-EMLÉK MENTVE; csatorna=${String(target.name || '').slice(0, 100)}; ` +
                      `formátum=${format.toUpperCase()}; előző=${previousFormat ? previousFormat.toUpperCase() : 'nem volt'}.`
                    );
                  }
                }
              }
              clearZapWatchdog();
              clearAutoRetry();
              setIsLoading(false);
              setHasError(false);
              setIsPlaying(true);
            }}
            onLoadedMetadata={(event) => {
              if (!isVod) {
                const diagnostic = channelSwitchDiagnosticRef.current;
                if (diagnostic && diagnostic.generation === streamLoadGenerationRef.current && !diagnostic.completed) {
                  appLog(`CSATORNAVÁLTÁS METAADAT; csatorna=${diagnostic.channelName}; eltelt=${Date.now() - diagnostic.startedAt} ms; ${videoDiagnosticState(event.currentTarget, 'loadedmetadata')}`);
                }
              }
            }}
            onCanPlay={(event) => {
              setIsLoading(false);
              setHasError(false);
              if (!isVod) {
                const diagnostic = channelSwitchDiagnosticRef.current;
                if (diagnostic && diagnostic.generation === streamLoadGenerationRef.current && !diagnostic.canPlayLogged) {
                  diagnostic.canPlayLogged = true;
                  appLog(`CSATORNAVÁLTÁS CANPLAY; csatorna=${diagnostic.channelName}; eltelt=${Date.now() - diagnostic.startedAt} ms; ${videoDiagnosticState(event.currentTarget, 'canplay')}`);
                }
              }
            }}
            onWaiting={(event) => {
              if (playbackStartedRef.current) setIsLoading(true);
              if (!isVod) {
                const diagnostic = channelSwitchDiagnosticRef.current;
                if (diagnostic && diagnostic.generation === streamLoadGenerationRef.current && !diagnostic.waitingLogged && !diagnostic.completed) {
                  diagnostic.waitingLogged = true;
                  appLog(`CSATORNAVÁLTÁS VÁRAKOZÁS; csatorna=${diagnostic.channelName}; eltelt=${Date.now() - diagnostic.startedAt} ms; ${videoDiagnosticState(event.currentTarget, 'waiting')}`);
                }
              }
            }}
            onError={(event) => {
              if (!isVod) {
                const diagnostic = channelSwitchDiagnosticRef.current;
                if (diagnostic && diagnostic.generation === streamLoadGenerationRef.current) {
                  appLog(`CSATORNAVÁLTÁS HIBA; csatorna=${diagnostic.channelName}; eltelt=${Date.now() - diagnostic.startedAt} ms; ${videoDiagnosticState(event.currentTarget, 'error')}`);
                }
              }
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
        <div
          onClick={(e) => {
            e.stopPropagation();
            // Hibás élő adásnál egy képernyőkoppintás is adjon kiutat a fullscreenből.
            if (isLive && isFullscreen) setIsFullscreen(false);
          }}
          className="absolute inset-0 flex flex-col items-center justify-center bg-black z-20 p-4 text-center"
        >
          <h4 className="text-white font-bold text-sm sm:text-base whitespace-pre-line">A csatornát nem lehet be tölteni !{"\n"}kapcsolj másik csatornára...{"\n"}ez a sz@r le fagyott 😂</h4>

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
          offsetHours={settings.clockOffsetHours}
          className={`absolute top-3 z-40 box-border max-w-[calc(100%-1.5rem)] flex items-center gap-2 rounded-full border border-cyan-400/40 bg-[#061329]/85 px-4 py-2 font-mono text-2xl font-semibold tracking-wider text-cyan-200 shadow-lg pointer-events-none ${isVod || landscapeLiveFullscreen ? 'right-3' : 'right-14'}`}
        />
      )}

      {/* Szolgáltatói felirat (CC) – a kép fölött, az OSD alatt. */}
      {isVod && vodSubtitleCues.length > 0 && (
        <SubtitleOverlay
          cues={vodSubtitleCues}
          videoRef={htmlVideoRef}
          positionRef={vodSubtitleClockRef}
          scalePercent={Number(String(settings.subtitleSize || '100%').replace('%', '')) || 100}
          raised={showControlsOverlay}
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
        className={`absolute inset-0 transition-opacity duration-300 flex flex-col justify-between pointer-events-none ${
          isVod ? '' : 'bg-linear-to-t from-black/80 via-transparent to-black/40 p-3'
        } ${showControlsOverlay ? 'opacity-100 visible' : 'opacity-0 invisible'}`}
      >
        {isVod ? (
          /*
            FILM / SOROZAT OSD – a referencia VOD-OSD felépítése KÉK kiemeléssel.
            A cím az OSD felső sávjában van (ezért az OSD-vel együtt tűnik el,
            a Beállításokban megadott OSD-idő után), a „sebesség” gomb helyén
            pedig a PIROS ✕ áll, ami visszalép a filmválasztáshoz.
          */
          <VodOsd
            title={customTitle || 'Film / Sorozat'}
            currentTime={vodCurrentTime}
            duration={vodDuration}
            isPlaying={isPlaying}
            volume={volume}
            seekStep={settings.seekStep}
            audioTracks={vodAudioTracks}
            subtitleTracks={availableVodSubtitleTracks}
            activeSubtitleId={activeVodSubtitleId}
            menu={vodTrackMenu}
            onMenuChange={setVodTrackMenu}
            onTogglePlay={togglePlay}
            onSeekBy={seekVodByConfiguredStep}
            onSeekTo={seekVod}
            onSelectAudio={selectVodAudio}
            onSelectSubtitle={selectVodSubtitle}
            onClose={() => onCloseVod?.()}
            onVolumeChange={onVolumeChange}
            onToggleMute={onToggleMute}
            onActivity={handleVodOsdActivity}
            rootRef={vodOsdRef}
          />

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
