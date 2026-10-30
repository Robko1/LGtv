import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { AudioTrack, Channel, AppSettings, SubtitleTrack } from '../types/iptv';
import {
  appLog,
  appLogCritical,
  isVerbosePlaybackLogging,
  logPlaybackQuality,
  logPlaybackQualityEvent,
  logPlaybackQualitySummary,
  resolutionClassOf,
} from '../services/appLog';
import { tvDeviceText } from '../services/tvDevice';
import { fsFinish, fsNow, fsPerfTimed, fsStart, fsStep } from '../services/fullscreenPerf';
import { speedAttemptObserver, speedChannelCommit, speedLoad, speedStep } from '../services/speedDiagnostics';
import {
  BufferProfileTiming,
  MediaProgressSample,
  StallDetector,
  bufferProfileTiming,
  bufferedAheadSeconds,
  isPrematureVodEnd,
  isUnexpectedLiveEnd,
  liveRecoveryDelayMs,
  liveRecoveryUrl,
  mediaProgressed,
  readMediaProgress,
  vodRecoveryDelayMs,
} from '../services/playbackRecovery';
import {
  DOCTOR_BUFFER_CONFIGS,
  DOCTOR_VERIFY_STABLE_MS,
  MAX_DOCTOR_REPAIR_STEPS,
  DoctorBufferProfileId,
  DoctorRepairProposal,
  DoctorStreamStateSnapshot,
  DoctorTriggerReason,
  VodDoctorTarget,
  collectDoctorDiagnostics,
  evaluateSmartFreeze,
  isChannelHandledByDoctor,
  isVodHandledByDoctor,
  normalizeChannelDoctorKey,
  normalizeVodDoctorKey,
  planDoctorRepairStep,
  planVodDoctorRepairStep,
  recordDoctorChannelFailure,
  recordDoctorChannelSuccess,
  recordDoctorVodSuccess,
  selectChannelLaunchPlan,
  selectVodLaunchPlan,
  subscribeTvDoctorUpdates,
} from '../services/tvDoctor';
import { TvDoctorActiveStatus, TvDoctorFullscreenHud } from './TvDoctorIcon';
import { ChannelLogo } from './ChannelLogo';
import { normalizeTvKey } from '../utils/tvKeys';
import { VodOsd } from './VodOsd';
import { LiveAudioCcSelector } from './AudioSubtitlesModal';
import {
  VodSubtitleSource,
  SubtitleCue,
  loadSubtitleCues,
  cueAt,
} from '../services/subtitleService';
import {
  EmbeddedSubtitle,
  probeEmbeddedSubtitles,
  selectEmbeddedSubtitle,
  disableEmbeddedSubtitle,
  subscribeSourceInfoSubtitles,
  probeMatroskaVideoInfo,
  probeSourceInfoQuality,
} from '../services/embeddedSubtitleService';
import {
  selectLiveSubtitle,
  disableLiveSubtitle,
  subscribeLiveSubtitleTracks,
  probeLiveSubtitles,
  probeLiveStreamCodecs,
  probeHlsPlaylist,
  canonicalLiveLang,
  LiveSubtitleRequest,
} from '../services/liveSubtitleService';
import { formatClockTime, normalizeClockOffset } from '../utils/clock';
import {
  alternativeUrl,
  formatOfUrl,
  forgetFormatFor,
  rememberFormatFor,
  rememberGlobalFormat,
  rememberedFormatFor,
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
    // A CC-listába csak tényleges feliratsáv kerülhet; a chapter/metadata/
    // description trackek nem választható feliratok.
    return Array.from(video.textTracks || [])
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => track.kind === 'subtitles' || track.kind === 'captions')
      .map(({ track, index }) => ({
        id: index,
        name: track.label || track.language || `Felirat ${index + 1}`,
        lang: track.language || '',
        selected: track.mode !== 'disabled',
      }));
  } catch {
    return [];
  }
}

/**
 * A fájlba muxolt (Luna) feliratsáv átalakítása a közös sávlistához.
 * Az azonosító `luna:` előtagot kap (a szolgáltatói `cc:` és a HTML
 * számsorszám mellé), így a három feliratforrás sosem ütközik.
 */
function embeddedToSubtitleTrack(track: EmbeddedSubtitle): SubtitleTrack {
  return {
    id: `luna:${track.lunaIndex}`,
    name: track.name || track.lang || `Felirat ${track.lunaIndex + 1}`,
    lang: track.lang || '',
  };
}

function lunaIndexFromTrack(track: SubtitleTrack | null | undefined): number | null {
  const id = track ? String(track.id) : '';
  if (!id.startsWith('luna:')) return null;
  const index = Number(id.slice('luna:'.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * Élő adás feliratsávja a közös élő listához – saját `luna-tv:` névtérrel,
 * hogy az élő és a VOD (film/sorozat) feliratkezelés semmiben ne keveredjen.
 */
function lunaTvToSubtitleTrack(track: EmbeddedSubtitle): SubtitleTrack {
  return {
    id: `luna-tv:${track.lunaIndex}`,
    name: track.name || track.lang || `Felirat ${track.lunaIndex + 1}`,
    lang: track.lang || '',
    selected: false,
  };
}

function lunaTvIndexFromTrack(track: SubtitleTrack | null | undefined): number | null {
  const id = track ? String(track.id) : '';
  if (!id.startsWith('luna-tv:')) return null;
  const index = Number(id.slice('luna-tv:'.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
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

/* ════════════════════════════════════════════════════════════════════════
 * KÉPMINŐSÉG-DIAGNOSZTIKA – segédek a mintavevőhöz (lásd lejjebb).
 *
 * Minden adat a futó videóelemből és a stream saját fejlécéből jön; amit
 * a TV nem tesz mérhetővé, azt nem találjuk ki (a naplóban „nem
 * mérhető" szerepel).
 * ════════════════════════════════════════════════════════════════════════ */

interface PlaybackFrameStats {
  total: number;
  dropped: number;
  corrupted: number;
}

/** Dekódolt/eldobott képkocka-számlálók kiolvasása (webOS Chrome / webkit alakok). */
function readPlaybackFrameStats(video: HTMLVideoElement | null): PlaybackFrameStats | null {
  if (!video) return null;
  const qualityVideo = video as HTMLVideoElement & {
    getVideoPlaybackQuality?: () => { totalVideoFrames?: number; droppedVideoFrames?: number; corruptedVideoFrames?: number };
    webkitDecodedFrameCount?: number;
    webkitDroppedFrameCount?: number;
  };
  try {
    if (typeof qualityVideo.getVideoPlaybackQuality === 'function') {
      const stats = qualityVideo.getVideoPlaybackQuality();
      if (stats && Number.isFinite(Number(stats.totalVideoFrames))) {
        return {
          total: Number(stats.totalVideoFrames) || 0,
          dropped: Number(stats.droppedVideoFrames) || 0,
          corrupted: Number(stats.corruptedVideoFrames) || 0,
        };
      }
    }
    if (typeof qualityVideo.webkitDecodedFrameCount === 'number') {
      return {
        total: Number(qualityVideo.webkitDecodedFrameCount) || 0,
        dropped: Number(qualityVideo.webkitDroppedFrameCount) || 0,
        corrupted: 0,
      };
    }
  } catch { /* a motor nem ad képkocka-statisztikát */ }
  return null;
}

/** A stream konténer/formátum neve a cím kiterjesztéséből. */
function qualityFormatLabel(url: string): string {
  const clean = String(url || '').split(/[?#]/)[0].toLowerCase();
  if (/\.m3u8$/.test(clean)) return 'HLS (.m3u8)';
  if (/\.ts$/.test(clean)) return 'MPEG-TS (.ts)';
  if (/\.mkv$/.test(clean)) return 'Matroska (.mkv)';
  if (/\.webm$/.test(clean)) return 'WebM (.webm)';
  if (/\.mp4$/.test(clean) || /\.m4v$/.test(clean)) return 'MP4 (.mp4)';
  if (/\.mov$/.test(clean)) return 'QuickTime (.mov)';
  if (/\.avi$/.test(clean)) return 'AVI (.avi)';
  if (/\.mpd$/.test(clean)) return 'DASH (.mpd)';
  return 'ismeretlen formátum';
}

/** A HLS variáns RESOLUTION attribútumából szám (pl. '1920x1080' → 1920 × 1080). */
function hlsVariantSize(variant: { resolution: string }): { width: number; height: number } | null {
  const match = String(variant?.resolution || '').match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** A HLS CODECS attribútumából emberi kodeknév ('avc1…' → H.264/AVC). */
function hlsCodecLabels(codecs: string): { video: string; audio: string } {
  let video = '';
  let audio = '';
  for (const raw of String(codecs || '').split(',')) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token.startsWith('avc1') || token.startsWith('avc3')) video = video || 'H.264/AVC';
    else if (token.startsWith('hvc1') || token.startsWith('hev1') || token.startsWith('dvh1') || token.startsWith('dvhe')) video = video || 'H.265/HEVC';
    else if (token.startsWith('vp09')) video = video || 'VP9';
    else if (token.startsWith('vp08')) video = video || 'VP8';
    else if (token.startsWith('av01')) video = video || 'AV1';
    else if (token.startsWith('mp4a')) audio = audio || 'AAC';
    else if (token.startsWith('ac-3')) audio = audio || 'AC-3';
    else if (token.startsWith('ec-3')) audio = audio || 'E-AC-3';
    else if (token.startsWith('mp3')) audio = audio || 'MP3';
  }
  return { video, audio };
}

/** A panel HDR-jelzése a böngésző médialekérdezése szerint (`null` = a motor nem ismeri). */
function hdrPanelSupported(): boolean | null {
  try {
    if (typeof window.matchMedia !== 'function') return null;
    const dynamic = window.matchMedia('(dynamic-range: high)');
    if (dynamic.matches) return true;
    if (window.matchMedia('(dynamic-range: standard)').matches) return false;
    return null;
  } catch {
    return null;
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
  const firstVisibleLoggedRef = useRef(false);
  useEffect(() => {
    firstVisibleLoggedRef.current = false;
    if (cues.length === 0) {
      setText('');
      return;
    }
    const update = () => {
      const reported = positionRef ? Math.max(0, Number(positionRef.current || 0)) : 0;
      const time = reported > 0 ? reported : Number(videoRef.current?.currentTime || 0);
      const next = cueAt(cues, time);
      if (next && !firstVisibleLoggedRef.current) {
        firstVisibleLoggedRef.current = true;
        appLog(`FELIRAT MEGJELENIK: az első feliratsor kirajzolódott; videóidő=${time.toFixed(2)} s; cue-k=${cues.length}.`);
      }
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

/**
 * Beépített VOD-feliratok kirajzolása saját rétegen.
 * A webOS régebbi HTML5 lejátszója nem mindig rajzolja ki megbízhatóan
 * a TextTrack feliratot. A kiválasztott sáv hidden módban marad, így a cue-k
 * olvashatók, de a böngésző nem rajzolja ki őket kétszer.
 */
const HtmlVodSubtitleOverlay: React.FC<{
  videoRef: React.RefObject<HTMLVideoElement | null>;
  trackId: string | number | null;
  scalePercent: number;
  raised: boolean;
}> = ({ videoRef, trackId, scalePercent, raised }) => {
  const [text, setText] = useState('');
  useEffect(() => {
    const update = () => {
      const video = videoRef.current;
      const index = trackId == null ? -1 : Number(trackId);
      const track = video?.textTracks && Number.isInteger(index) ? video.textTracks[index] : null;
      const cues = track?.activeCues;
      const next = cues ? Array.from(cues).map((cue) => {
        const raw = String((cue as TextTrackCue & { text?: string }).text || '');
        return raw.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
      }).filter(Boolean).join('\n') : '';
      setText((previous) => previous === next ? previous : next);
    };
    update();
    const timer = window.setInterval(update, 200);
    const video = videoRef.current;
    video?.addEventListener('timeupdate', update);
    video?.addEventListener('seeked', update);
    return () => {
      window.clearInterval(timer);
      video?.removeEventListener('timeupdate', update);
      video?.removeEventListener('seeked', update);
    };
  }, [videoRef, trackId]);

  if (!text || trackId == null) return null;
  const fontSize = Math.max(16, Math.round(22 * (scalePercent / 100)));
  return (
    <div
      data-subtitle-overlay="html-vod"
      className={`absolute inset-x-0 z-30 flex justify-center px-6 pointer-events-none transition-all duration-200 ${
        raised ? 'bottom-[22%]' : 'bottom-[8%]'
      }`}
    >
      <div
        className="max-w-[90%] rounded-lg bg-black/70 px-3 py-1.5 text-center font-semibold leading-snug text-white"
        style={{ fontSize: `${fontSize}px`, textShadow: '0 2px 6px rgba(0,0,0,0.95)' }}
      >
        {text.split('\n').map((line, index) => <span key={index} className="block">{line}</span>)}
      </div>
    </div>
  );
};

const BlueClock: React.FC<{ className?: string; offsetHours?: number; accent?: 'yellow' | 'red' | 'blue' | 'pink' | 'green' | 'white'; inDoctorHud?: boolean }> = ({ className, offsetHours = 0, accent = 'yellow', inDoctorHud = false }) => {
  const accentTextClass: Record<NonNullable<typeof accent>, string> = {
    yellow: 'text-amber-300',
    red: 'text-red-400',
    blue: 'text-blue-400',
    pink: 'text-pink-400',
    green: 'text-green-400',
    white: 'text-white',
  };
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
      data-in-doctor-hud={inDoctorHud ? '' : undefined}
      className={className}
      aria-label={`Pontos idő: ${time}`}
    >
      <span className={accentTextClass[accent]}>{time || '00:00'}</span>
    </div>
  );
};

interface VideoPlayerProps {
  liveAccent?: 'yellow' | 'red' | 'blue' | 'pink' | 'green' | 'white';
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

/*
 * A főoldali (nem teljes képernyős) lejátszó-keret inline stílusa.
 *
 * SZÁNDÉKOSAN állandó objektum: a React így SOHA nem írja újra a stílust egy
 * újrarenderelésnél, és a teljes képernyő váltásakor sem történik inline
 * stílusírás (a geometriát a `.iptv-fs` CSS-osztály adja). A 16:9-es keretet
 * a `syncMainPageLayout` mérése egészíti ki egyszer, a DOM-ban.
 */
/*
 * HANGZÁR AZ INDULÁS ALATT (2.5.147).
 *
 * A webOS-on a <video> a SAJÁT hardveres síkján szól: hiába van fölötte a
 * takarókép, a hang akkor is hallatszik. A 24. TV-napló pontosan ezt mutatta:
 * az első csatorna 19:45:22,166-kor már lejátszott, a takarókép pedig csak
 * 19:45:26,049-kor tűnt el – 3,3 másodpercig szólt a hang egy
 * betöltőképernyő alatt.
 *
 * Ezért amíg a html `__IPTV_AUDIO_GATE__` jelzője igaz, a lejátszó NÉMÁN fut.
 * A zár a REVEAL után nyílik (a kész főoldal első kirajzolt képkockája után):
 * ekkor jön az `iptv-audio-open` esemény, és a hangerő visszaáll.
 */
function startupAudioGateClosed(): boolean {
  // Nincs egyedi HTML-es indítóképernyő; a régi audio-gate nem némíthatja
  // el a lejátszást, mert a hozzá tartozó reveal esemény már nem létezik.
  return false;
}
/** A néma állapot EGYETLEN helyen dől el: hangerő + indulási hangzár. */
function applyMuteState(video: HTMLVideoElement, volume: number): void {
  try {
    video.muted = volume <= 0 || startupAudioGateClosed();
  } catch { /* a médiaelem már lebomlott */ }
}

const PLAYER_HOME_STYLE: React.CSSProperties = {
  width: '100%',
  // A főoldali keret 16:9-es (ezt a `syncMainPageLayout` mérése is ebben az
  // alakban írja le) – így már az ELSŐ kifestett képkocka is helyes, és a
  // teljes képernyő váltásakor nincs mit „visszaállítani”.
  height: 'auto',
  minHeight: 0,
  maxHeight: 'none',
  aspectRatio: '16 / 9',
};

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  liveAccent = 'yellow',
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
  useLayoutEffect(() => {
    if (!customStreamUrl) speedChannelCommit('lejátszó React commit', channel?.id);
  }, [channel?.id, customStreamUrl]);

  /*
   * BELSŐ FORRÁSVÁLTÁS JELZÉSE.
   *
   * A `video.pause()` a csatornaváltás / újracsatlakozás első lépése. A
   * médiaelem `pause` eseménye azonban KÉSŐBB, külön feladatban érkezik –
   * gyakran már az új stream play()-e után. A régi kód ilyenkor
   * `setIsPlaying(false)`-t hívott, amire az alábbi effektus LEÁLLÍTOTTA az
   * éppen elindult új adást (ez volt a „film 22 ms után megáll, csak kilépés
   * után indul újra” hiba). A jelző alatt a belső események nem írják át a
   * felhasználói szándékot; a `playing` esemény (vagy a 8 mp-es biztonsági
   * időkorlát) oldja fel.
   */
  const switchInProgressRef = useRef(false);
  const switchResetTimerRef = useRef<number | null>(null);
  /** A felhasználó / App által KÉRT lejátszási állapot (a belső eseményektől független). */
  const desiredPlayingRef = useRef(isPlaying);
  desiredPlayingRef.current = isPlaying;

  /*
   * Egyetlen hely, ahol a kért állapotot a videóelemre alkalmazzuk.
   * Forrásváltás közben nem nyúlunk hozzá; a váltás végén (endSwitch)
   * viszont újra ellenőrizzük, így a váltás alatt megnyomott Play/Pause
   * sem vész el.
   */
  const applyDesiredPlayback = useCallback(() => {
    const video = htmlVideoRef.current;
    if (!video || nativeApi()?.play || !video.currentSrc) return;
    if (switchInProgressRef.current) return;
    if (desiredPlayingRef.current && video.paused) {
      void video.play().catch(() => {
        if (switchInProgressRef.current) return;
        setIsLoading(false);
        setHasError(true);
        setErrorMessage('A TV nem engedélyezte a lejátszás indítását.');
      });
    } else if (!desiredPlayingRef.current && !video.paused) {
      video.pause();
    }
  }, []);
  const beginSwitch = useCallback(() => {
    switchInProgressRef.current = true;
    if (switchResetTimerRef.current !== null) {
      window.clearTimeout(switchResetTimerRef.current);
      switchResetTimerRef.current = null;
    }
    switchResetTimerRef.current = window.setTimeout(() => {
      switchResetTimerRef.current = null;
      switchInProgressRef.current = false;
      applyDesiredPlayback();
    }, 8000);
  }, [applyDesiredPlayback]);
  const endSwitch = useCallback(() => {
    switchInProgressRef.current = false;
    if (switchResetTimerRef.current !== null) {
      window.clearTimeout(switchResetTimerRef.current);
      switchResetTimerRef.current = null;
    }
    // Ha a néző a váltás közben nyomott Play/Pause-t, most érvényesítjük.
    applyDesiredPlayback();
  }, [applyDesiredPlayback]);
  useEffect(() => () => {
    if (switchResetTimerRef.current !== null) {
      window.clearTimeout(switchResetTimerRef.current);
      switchResetTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const video = htmlVideoRef.current;
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, volume));
    applyMuteState(video, volume);
  }, [volume]);

  /*
   * A HANGZÁR KINYITÁSA (2.5.147). A HTML hídja a takarókép lekerülése után
   * eseményt küld; ekkor a hangerő azonnal visszaáll a beállított értékre.
   * Ugyanitt egy rövid késleltetett ellenőrzés is fut, mert a webOS
   * médiamotorja néha később érvényesíti a `muted` jelzőt.
   */
  useEffect(() => {
    const restore = () => {
      const video = htmlVideoRef.current;
      if (!video) return;
      video.volume = Math.max(0, Math.min(1, volume));
      applyMuteState(video, volume);
    };
    window.addEventListener('iptv-audio-open', restore);
    let lateTimer: number | null = null;
    if (!startupAudioGateClosed()) restore();
    else {
      lateTimer = window.setTimeout(restore, 400);
    }
    return () => {
      window.removeEventListener('iptv-audio-open', restore);
      if (lateTimer !== null) window.clearTimeout(lateTimer);
    };
  }, [volume]);

  useEffect(() => {
    applyDesiredPlayback();
  }, [isPlaying, applyDesiredPlayback]);
  const vodOsdRef = useRef<HTMLDivElement | null>(null);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasError, setHasError] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  // Élő adásnál legfeljebb két külön formátumot indítunk, az elsődleges címet
  // pedig egyetlen gyors, azonos című újrapróbával védjük. Ezután csak
  // kontrollált, fokozatos újracsatlakozás indulhat, nem formátum-ciklus.
  const autoRetryTimerRef = useRef<number | null>(null);
  const retryStreamRef = useRef<(() => void) | null>(null);
  const pendingStreamUrlRef = useRef('');
  /** Az első formátumhibánál gyors, azonos című újrapróbát engedélyez. */
  const initialFormatRetryRef = useRef(false);
  const bufferWatchdogRef = useRef<number | null>(null);
  const playbackStartedRef = useRef(false);

  /*
   * FOLYAMATOS ÚJRACSATLAKOZÁS – nincs többé végleges fekete hibaképernyő.
   * A `recoveryTimerRef` az egyetlen újrapróbálkozás-időzítő, az
   * `recoveryAttemptRef` a visszalépéshez (exponenciális, de korlátos),
   * az `isRecovering` pedig egy KIS, átlátszó jelző a kép sarkában: a
   * legutolsó képkocka közben látható marad, a hang nem szakad meg.
   */
  const [isRecovering, setIsRecovering] = useState(false);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryAttemptRef = useRef(0);
  /** A webOS által véges VOD-ként lezárt live TS után két azonos újrapróba,
   * majd a másik formátum következhet – így nem ragadunk ugyanazon a címen. */
  const liveEndRecoveryAttemptRef = useRef(0);
  const liveDurationRecoveryTimerRef = useRef<number | null>(null);
  /**
   * A két külön formátum-próba után a további próbálkozás már kontrollált
   * újracsatlakozás. Ezzel egy későn érkező hiba nem indíthat új TS → HLS →
   * TS → HLS kört ugyanazon csatorna indulásakor.
   */
  const liveRecoveryOnlyRef = useRef(false);
  /** Az aktuális src azonosítója: a régi elem-esemény ne indítsa újra az új src-t. */
  const activeMediaUrlRef = useRef('');
  const stallDetectorRef = useRef<StallDetector | null>(null);
  const requestRecoveryRef = useRef<(reason: string) => void>(() => {});
  const vodRecoveryRef = useRef<(reason: string) => void>(() => {});
  const vodRestoreTimerRef = useRef<number | null>(null);
  /** A VOD-visszaállítás ideiglenes eseményfigyelőjének eltávolítása. */
  const vodRestoreCleanupRef = useRef<(() => void) | null>(null);
  /** A legutolsó ismert film-pozíció – újratöltéskor innen folytatjuk. */
  const vodLastPositionRef = useRef(0);
  /** Érkezett-e már timeupdate? (0 mp-re tekerésnél se ugorjunk vissza a folytatáshoz.) */
  const vodPositionKnownRef = useRef(false);
  /** Csak a FELHASZNÁLÓ által kért hangsávváltás nyithassa újra a forrást. */
  const vodAutoAudioSwitchRef = useRef(false);
  const clearRecovery = useCallback(() => {
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    if (vodRestoreTimerRef.current !== null) {
      window.clearTimeout(vodRestoreTimerRef.current);
      vodRestoreTimerRef.current = null;
    }
    if (liveDurationRecoveryTimerRef.current !== null) {
      window.clearTimeout(liveDurationRecoveryTimerRef.current);
      liveDurationRecoveryTimerRef.current = null;
    }
    // Csatorna-/filmváltáskor a régi visszaállító nem ugrathatja vissza
    // az ÚJ stream idejét a régi film pozíciójára.
    vodRestoreCleanupRef.current?.();
    vodRestoreCleanupRef.current = null;
    if (doctorSessionRef.current.verifyTimer !== null) {
      window.clearTimeout(doctorSessionRef.current.verifyTimer);
      doctorSessionRef.current.verifyTimer = null;
    }
    setIsRecovering(false);
  }, []);
  /*
   * ÉLŐ: csatornánkénti formátum-tartalék (a napló „Format error” hibáihoz).
   * A `liveFallbackRef` a másik formátum címét, a `liveRetrySequenceRef`
   * pedig legfeljebb két külön indítási próbálkozás állapotát tárolja.
   */
  const liveFallbackRef = useRef<{ url: string; format: 'ts' | 'hls' } | null>(null);
  const liveRetrySequenceRef = useRef<{ urls: string[]; index: number }>({ urls: [], index: 0 });
  /** Esetleges korábbi, késleltetett betöltés törlése – csatornaváltás nem várhat rá. */
  const pendingLiveLoadTimerRef = useRef<number | null>(null);
  // Csatornaváltási generáció: a régi stream későn érkező eseményei ne írják felül az új csatorna állapotát.
  const streamLoadGenerationRef = useRef(0);
  const channelSwitchDiagnosticRef = useRef<{
    generation: number;
    startedAt: number;
    attemptStartedAt: number;
    attemptNumber: number;
    loadCount: number;
    channelId: string;
    channelName: string;
    waitingLogged: boolean;
    canPlayLogged: boolean;
    completed: boolean;
    firstFrameLogged: boolean;
    lastProgressAt: number;
    lastBufferedEnd: number;
    lastTimelineLogAt: number;
    lastTimelineTime: number | null;
    lastTimelineDuration: number | null;
    timelineEvents: number;
    summaryLogged: boolean;
  } | null>(null);
  /**
   * A kézi diagnosztika erőforrás-pillanatképe szándékosan nem készül el
   * minden gyors médiaeseménynél. A #15 naplóban egyetlen zappolás alatt is
   * több, nagy localStorage-bejárást láttunk; ez maga is felesleges főszál-
   * terhelést okozhat a TV-n. A részletes mérés ritkítható, a médiaesemények
   * ettől változatlanul bekerülnek a naplóba.
   */
  // Csak a lejátszás állapota: nincs layout-mérés vagy erőforrás-bejárás.
  const videoDiagnosticState = (video: HTMLVideoElement, reason: string): string => {
    const ahead = bufferedAheadSeconds(video);
    return `${reason}; readyState=${video.readyState}; networkState=${video.networkState}; ` +
      `paused=${video.paused}; currentTime=${Number(video.currentTime || 0).toFixed(2)}; ` +
      `puffer-előre=${ahead === null ? 'n/a' : ahead.toFixed(2)} s; ` +
      `error=${video.error ? `${video.error.code}:${video.error.message || 'nincs részlet'}` : 'nincs'}`;
  };

  /**
   * Egyetlen HTMLVideoElement későn is kiküldheti az előző src eseményét.
   * Az URL-t a próba indulásakor rögzítjük, és a régi forrás eseményeit nem
   * engedjük az új csatorna loading/error állapotát átírni.
   */
  const isActiveMediaEvent = (video: HTMLVideoElement): boolean => {
    const expected = activeMediaUrlRef.current;
    const actual = video.currentSrc || video.src;
    if (!expected || !actual) return true;
    if (expected === actual) return true;
    try {
      return new URL(expected, window.location.href).href === new URL(actual, window.location.href).href;
    } catch {
      return false;
    }
  };

  /* ══════════════════════════════════════════════════════════════════════
   * KÉPMINŐSÉG-MINTAVEVŐ – a kézi hibakeresési napló része.
   *
   * Amíg a részletes naplózás fut (SÁRGA gomb → Naplózás indítása – ugyanaz
   * a kapu, mint az ÉLŐ MÉDIAESEMÉNY / IDŐVONAL soroknál), a mintavevő
   * 4 másodpercenként KÉPMINŐSÉG sort ír ugyanabba a kézi naplóba
   * (appLog.ts): a DEKÓDOLT tényleges felbontást, a megjelenítési dobozt
   * fizikai képpontban (így a felskálázás mértéke is látszik), a mért
   * képkockasebességet, az eldobott képkockákat, a puffert és a
   * pufferelések számát/idejét. Streamenként egyszer a fejlécből is
   * kiolvassa, mit KÍNÁL a szolgáltató: HLS-nél a master lista
   * variánsait, MPEG-TS-nél a PMT kodektípusait, MKV filmnél a fejléc
   * képsávját, plusz a TV médiaszolgáltatásának (sourceInfo) adatait.
   *
   * Naplózás nélkül semmi nem fut: az 1 mp-es őr csak egy logikai
   * kapcsolót olvas (ugyanaz a minta, mint a fagyásfigyelő indítása).
   * Normál tévézésnél a mintavevő nincs elindítva, a csatornaváltást
   * és a dekódolást semmivel nem terheli.
   * ══════════════════════════════════════════════════════════════════════ */
  type QualityFrameBase = PlaybackFrameStats & { at: number };
  type QualitySamplerState = {
    timer: number | null;
    probeTimer: number | null;
    streamStartedAt: number;
    url: string;
    probedUrl: string;
    summaryLogged: boolean;
    lastFrames: QualityFrameBase | null;
    streamFrames: QualityFrameBase | null;
    rvfcId: number;
    rvfcCount: number;
    lastRvfc: { count: number; at: number } | null;
    streamRvfc: { count: number; at: number } | null;
    waitingCount: number;
    bufferingMs: number;
    waitingSince: number;
    sizesSeen: string[];
    lastSizeKey: string;
    /** Az utolsó naplózott minta ideje (dupla sorok kiszűrése). */
    lastSampleAt: number;
    videoCodec: string;
    audioCodec: string;
    codecSource: string;
    hdrStream: string;
    bitrateKbps: number | null;
    bitrateSource: string;
    /** A szolgáltató által kínált LEGJOBB felbontás (HLS master / fejléc), ha ismert. */
    bestOffered: { width: number; height: number; source: string } | null;
    /** Már figyelmeztettünk-e, hogy a mért kép a kínáltnál gyengébb. */
    lowQualityWarned: boolean;
    resourceCursor: number;
    detach: () => void;
  };
  const qualityRef = useRef<QualitySamplerState | null>(null);

  const qualityTitle = (): string => (
    isVodRef.current
      ? String(customTitleRef.current || 'film/sorozat').slice(0, 100)
      : String(channelRef.current?.name || 'élő adás').slice(0, 100)
  );

  const qualityCurrentUrl = (video: HTMLVideoElement): string => (
    pendingStreamUrlRef.current || activeMediaUrlRef.current || video.currentSrc || video.src || ''
  );

  const resetQualityStream = (state: QualitySamplerState, url: string, video: HTMLVideoElement): void => {
    const now = Date.now();
    const frames = readPlaybackFrameStats(video);
    state.streamStartedAt = now;
    state.url = url;
    state.summaryLogged = false;
    state.lastFrames = frames ? { ...frames, at: now } : null;
    state.streamFrames = state.lastFrames;
    state.lastRvfc = { count: state.rvfcCount, at: now };
    state.streamRvfc = state.lastRvfc;
    state.waitingCount = 0;
    state.bufferingMs = 0;
    state.waitingSince = 0;
    state.sizesSeen = [];
    state.lastSizeKey = '';
    state.lastSampleAt = 0;
    state.videoCodec = '';
    state.audioCodec = '';
    state.codecSource = '';
    state.hdrStream = '';
    state.bitrateKbps = null;
    state.bitrateSource = '';
    state.bestOffered = null;
    state.lowQualityWarned = false;
    try { state.resourceCursor = performance.now(); } catch { state.resourceCursor = 0; }
  };

  /** A stream záró összesítése – csatorna/filmváltáskor és a naplózás leállításakor is lefut. */
  const summarizeQualityStream = (video: HTMLVideoElement | null): void => {
    const state = qualityRef.current;
    if (!state || !state.url || state.streamStartedAt <= 0 || state.summaryLogged) return;
    state.summaryLogged = true;
    const now = Date.now();
    const seconds = (now - state.streamStartedAt) / 1000;
    let avgFps: number | null = null;
    let framesTotal: number | null = null;
    let dropped: number | null = null;
    let droppedPercent: number | null = null;
    const frames = video ? readPlaybackFrameStats(video) : null;
    if (frames && state.streamFrames && seconds >= 1) {
      const totalDelta = frames.total - state.streamFrames.total;
      const droppedDelta = frames.dropped - state.streamFrames.dropped;
      if (totalDelta > 0) {
        avgFps = totalDelta / seconds;
        framesTotal = totalDelta;
        dropped = droppedDelta;
        droppedPercent = (droppedDelta / Math.max(1, totalDelta + Math.max(0, droppedDelta))) * 100;
      }
    } else if (state.streamRvfc && seconds >= 1 && state.rvfcCount > state.streamRvfc.count) {
      framesTotal = state.rvfcCount - state.streamRvfc.count;
      avgFps = framesTotal / seconds;
    }
    const bufferingMs = state.bufferingMs + (state.waitingSince ? now - state.waitingSince : 0);
    logPlaybackQualitySummary({
      mode: isVodRef.current ? 'VOD' : 'élő',
      title: qualityTitle(),
      format: qualityFormatLabel(state.url),
      seconds,
      resolutionsSeen: state.sizesSeen.length
        ? state.sizesSeen.map((size) => {
            const [w, h] = size.split('x').map(Number);
            return `${size} (${resolutionClassOf(w || 0, h || 0)})`;
          }).join(' → ')
        : 'nem indult el kép',
      avgFps,
      framesTotal,
      droppedFrames: dropped,
      droppedPercent,
      bufferingEvents: state.waitingCount,
      bufferingMs,
      bitrateKbps: state.bitrateKbps,
      bitrateSource: state.bitrateSource,
      videoCodec: state.videoCodec,
      codecSource: state.codecSource,
      hdrStream: state.hdrStream,
    });
  };

  /** A hálózati átvitel mérése a Resource Timing bejegyzésekből, ha a TV ad méretet. */
  const measureNetworkBitrateKbps = (cursorBefore: number, windowSeconds: number): number | null => {
    try {
      if (typeof performance.getEntriesByType !== 'function' || windowSeconds <= 0) return null;
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      let bytes = 0;
      for (const entry of entries) {
        if (!entry || entry.startTime <= cursorBefore) continue;
        const name = String(entry.name || '');
        const initiator = String(entry.initiatorType || '');
        const isMedia = initiator === 'video' || /\.(ts|m4s|mp4|mkv|webm|aac|mp3|m3u8)([?#]|$)/i.test(name);
        if (!isMedia) continue;
        bytes += Number(entry.transferSize) || Number(entry.encodedBodySize) || 0;
      }
      return bytes > 0 ? (bytes * 8) / windowSeconds / 1000 : null;
    } catch {
      return null;
    }
  };

  const sampleQuality = useCallback((): void => {
    const state = qualityRef.current;
    const video = htmlVideoRef.current;
    if (!state || !video) return;
    const now = Date.now();
    const url = qualityCurrentUrl(video);
    if (url && state.url && url !== state.url) {
      summarizeQualityStream(video);
      resetQualityStream(state, url, video);
    } else if (url && !state.url) {
      resetQualityStream(state, url, video);
    }
    if (!state.url) return;
    // Szüneteltetett/befejezett lejátszásról nincs értelme mintát írni –
    // csak a képkocka-alapokat frissítjük, hogy a folytatáskor ne legyen
    // hamis sebességugrás a naplóban.
    if (video.paused || video.ended || video.readyState < 2) {
      const framesNow = readPlaybackFrameStats(video);
      if (framesNow) state.lastFrames = { ...framesNow, at: now };
      state.lastRvfc = { count: state.rvfcCount, at: now };
      try { state.resourceCursor = performance.now(); } catch { /* régi motor */ }
      return;
    }

    const width = Number(video.videoWidth || 0);
    const height = Number(video.videoHeight || 0);
    if (width > 0 && height > 0) {
      const key = `${width}x${height}`;
      if (key !== state.lastSizeKey) {
        state.lastSizeKey = key;
        if (!state.sizesSeen.includes(key)) state.sizesSeen.push(key);
      }
      /*
       * GYENGE KÉP JELZÉSE (streamenként egyszer).
       *
       * A napló célja, hogy a képminőség-beállítást NE találgatásra lehessen
       * alapozni. Ha a dekódolt kép kisebb, mint amit a szolgáltató kínál
       * (HLS master variáns / MKV fejléc / TV sourceInfo), vagy ha Full HD
       * alatti, azt külön sor mondja meg – így egyértelmű, hogy a gyengébb
       * kép a szolgáltatói stream tulajdonsága, nem a lejátszóé.
       */
      if (!state.lowQualityWarned) {
        const measuredArea = width * height;
        const offered = state.bestOffered;
        const smallerThanOffered = Boolean(offered && measuredArea > 0 && measuredArea < (offered.width * offered.height) * 0.81);
        const belowFullHd = width < 1920 && height < 1080;
        if (smallerThanOffered || belowFullHd) {
          state.lowQualityWarned = true;
          logPlaybackQualityEvent(
            `FIGYELMEZTETÉS; cím=${qualityTitle()}; a dekódolt kép=${width}x${height} (${resolutionClassOf(width, height)}); ` +
            (offered
              ? `a szolgáltató által kínált legjobb szint=${offered.width}x${offered.height} (${resolutionClassOf(offered.width, offered.height)}) [${offered.source}]; `
              : 'a szolgáltató nem jelzi a kínált felbontást; ') +
            (smallerThanOffered
              ? 'a most játszott változat gyengébb a kínáltnál – ha a csatorna/Sorozat listában van külön UHD/HD változat, azt kell választani; a lejátszó a vett streamet nem tudja feljavítani.'
              : 'a csatorna Full HD alatti (SD) képet ad; ez a szolgáltatói stream tulajdonsága, nem a lejátszó beállítása.')
          );
        }
      }
    }

    let fps: number | null = null;
    let droppedWindow: number | null = null;
    let droppedPercent: number | null = null;
    let corruptedWindow: number | null = null;
    const frames = readPlaybackFrameStats(video);
    if (frames && state.lastFrames) {
      const dtSeconds = (now - state.lastFrames.at) / 1000;
      const totalDelta = frames.total - state.lastFrames.total;
      const droppedDelta = frames.dropped - state.lastFrames.dropped;
      if (dtSeconds >= 1 && totalDelta >= 0 && droppedDelta >= 0) {
        fps = totalDelta / dtSeconds;
        droppedWindow = droppedDelta;
        corruptedWindow = Math.max(0, frames.corrupted - state.lastFrames.corrupted);
        droppedPercent = (droppedDelta / Math.max(1, totalDelta + droppedDelta)) * 100;
      }
    }
    if (frames) state.lastFrames = { ...frames, at: now };
    if (fps === null && state.lastRvfc) {
      const dtSeconds = (now - state.lastRvfc.at) / 1000;
      const countDelta = state.rvfcCount - state.lastRvfc.count;
      if (dtSeconds >= 1 && countDelta > 0) fps = countDelta / dtSeconds;
      state.lastRvfc = { count: state.rvfcCount, at: now };
    }

    try {
      const cursorBefore = state.resourceCursor;
      state.resourceCursor = performance.now();
      const measured = measureNetworkBitrateKbps(cursorBefore, Math.max(0.1, (state.resourceCursor - cursorBefore) / 1000));
      if (measured !== null) {
        state.bitrateKbps = measured;
        state.bitrateSource = 'hálózati mérés';
      }
    } catch { /* a bitráta nem mérhető ezen a motoron */ }

    /*
     * NINCS DUPLA SOR (2.5.158).
     *
     * A 9. naplóban ugyanaz a minta kétszer-háromszor egymás után került a
     * naplóba (a `playing` esemény és a 4 mp-es időzítő ugyanabban a
     * pillanatban futott). 1,2 mp-en belül legfeljebb egy minta készül: alatta
     * nincs új információ, csak a napló hízik tőle.
     */
    if (now - state.lastSampleAt < 1200) return;
    state.lastSampleAt = now;

    const rect = video.getBoundingClientRect();
    logPlaybackQuality({
      mode: isVodRef.current ? 'VOD' : 'élő',
      title: qualityTitle(),
      format: qualityFormatLabel(state.url),
      width,
      height,
      boxWidth: Math.round(rect.width),
      boxHeight: Math.round(rect.height),
      devicePixelRatio: Number(window.devicePixelRatio) || 1,
      fps,
      droppedFrames: droppedWindow,
      droppedPercent,
      corruptedFrames: corruptedWindow,
      bufferedAheadSeconds: bufferedAheadSeconds(video),
      bufferingEvents: state.waitingCount,
      bufferingMs: state.bufferingMs + (state.waitingSince ? now - state.waitingSince : 0),
      bitrateKbps: state.bitrateKbps,
      bitrateSource: state.bitrateSource,
      videoCodec: state.videoCodec,
      audioCodec: state.audioCodec,
      codecSource: state.codecSource,
      hdrStream: state.hdrStream || 'nem jelzett',
      hdrPanel: hdrPanelSupported(),
      readyState: video.readyState,
      networkState: video.networkState,
    });
  }, []);

  const sampleQualityRef = useRef(sampleQuality);
  sampleQualityRef.current = sampleQuality;

  /**
   * Streamenként egyszeri fejléc-próbák: mit KÍNÁL a szolgáltató.
   * Csak a mintavevő futása alatt (kézi naplózás), a lejátszás elindulása
   * után – ugyanaz a kíméletes minta, mint a felirat-fejlécpróbáknál.
   */
  const runQualityProbes = useCallback(async (url: string): Promise<void> => {
    const state = qualityRef.current;
    const video = htmlVideoRef.current;
    if (!state || !video || state.url !== url) return;
    const title = qualityTitle();
    try {
      if (isVodRef.current) {
        const matroska = await probeMatroskaVideoInfo(url);
        if (!qualityRef.current || qualityRef.current.url !== url) return;
        if (matroska && (matroska.video || matroska.audioCodecs.length)) {
          if (matroska.video?.codec && !state.videoCodec) {
            state.videoCodec = matroska.video.codec;
            state.codecSource = 'MKV fejléc';
          }
          if (matroska.audioCodecs.length && !state.audioCodec) {
            state.audioCodec = matroska.audioCodecs.join('/');
          }
          if (matroska.video?.hdr && !state.hdrStream) state.hdrStream = matroska.video.hdr;
          if (matroska.video && matroska.video.width > 0 && matroska.video.height > 0) {
            state.bestOffered = { width: matroska.video.width, height: matroska.video.height, source: 'MKV fejléc' };
          }
          const duration = Number(video.duration || 0);
          if (matroska.fileBytes && duration > 0 && state.bitrateKbps === null) {
            state.bitrateKbps = (matroska.fileBytes * 8) / duration / 1000;
            state.bitrateSource = 'fájlméret/hossz átlag';
          }
          logPlaybackQualityEvent(
            `FEJLÉC (MKV); cím=${title}; deklarált=${matroska.video ? `${matroska.video.width}x${matroska.video.height} (${resolutionClassOf(matroska.video.width, matroska.video.height)})` : 'nincs képsáv-adat'}; ` +
            `kodek=${matroska.video ? `${matroska.video.codec} [${matroska.video.codecId}]` : 'ismeretlen'}; hang=${matroska.audioCodecs.join('/') || 'ismeretlen'}; ` +
            `HDR-szín=${matroska.video?.hdr || 'nincs jelölve'}; fájlméret=${matroska.fileBytes ? `${(matroska.fileBytes / 1048576).toFixed(0)} MB` : 'nem derül ki'}`
          );
        }
      } else if (formatOfUrl(url) === 'hls') {
        const playlist = await probeHlsPlaylist(url);
        if (!qualityRef.current || qualityRef.current.url !== url) return;
        if (!playlist) {
          logPlaybackQualityEvent(`FEJLÉC (HLS); csatorna=${title}; a lejátszási lista nem olvasható ki külön.`);
        } else if (playlist.variants.length > 0) {
          const variantText = playlist.variants
            .slice(0, 6)
            .map((variant) => {
              const codecs = hlsCodecLabels(variant.codecs);
              return `${variant.resolution || '?'} ${variant.bandwidth ? `${(variant.bandwidth / 1000000).toFixed(1)} Mbps` : '? Mbps'} ${codecs.video || variant.codecs || ''}${variant.frameRate ? ` ${variant.frameRate} fps` : ''}${variant.videoRange ? ` ${variant.videoRange}` : ''}`;
            })
            .join(' | ');
          logPlaybackQualityEvent(`FEJLÉC (HLS master); csatorna=${title}; kínált szintek=[${variantText}]${playlist.variants.length > 6 ? ` (+${playlist.variants.length - 6} további)` : ''}.`);
          const bestVariant = playlist.variants.reduce<(typeof playlist.variants)[number] | null>((best, variant) => {
            const size = hlsVariantSize(variant);
            const bestSize = best ? hlsVariantSize(best) : null;
            if (!size) return best;
            if (!bestSize) return variant;
            return size.width * size.height > bestSize.width * bestSize.height ? variant : best;
          }, null);
          const bestSize = bestVariant ? hlsVariantSize(bestVariant) : null;
          if (bestSize) state.bestOffered = { ...bestSize, source: 'HLS master lista' };
          const currentKey = `${Number(video.videoWidth || 0)}x${Number(video.videoHeight || 0)}`;
          const matching = playlist.variants.find((variant) => variant.resolution === currentKey)
            || playlist.variants.reduce<(typeof playlist.variants)[number] | null>(
              (best, variant) => ((variant.bandwidth || 0) > (best?.bandwidth || 0) ? variant : best),
              null,
            );
          if (matching) {
            const codecs = hlsCodecLabels(matching.codecs);
            if (codecs.video && !state.videoCodec) {
              state.videoCodec = codecs.video;
              state.codecSource = 'HLS lista';
            }
            if (codecs.audio && !state.audioCodec) state.audioCodec = codecs.audio;
            if (matching.bandwidth && state.bitrateKbps === null) {
              state.bitrateKbps = matching.bandwidth / 1000;
              state.bitrateSource = 'HLS lista (deklarált)';
            }
            if (matching.videoRange && !state.hdrStream) state.hdrStream = matching.videoRange;
          }
        } else {
          logPlaybackQualityEvent(
            `FEJLÉC (HLS media lista); csatorna=${title}; egy minőségi szint (nincs master variánslista); szegmensek=${playlist.segmentCount}; céltartam=${playlist.targetDuration ?? 'n/a'} s.`
          );
        }
      } else {
        const codecs = await probeLiveStreamCodecs(url);
        if (!qualityRef.current || qualityRef.current.url !== url) return;
        if (codecs && (codecs.video || codecs.audio.length)) {
          if (codecs.video && !state.videoCodec) {
            state.videoCodec = codecs.video;
            state.codecSource = 'PMT';
          }
          if (codecs.audio.length && !state.audioCodec) state.audioCodec = codecs.audio.join('/');
          logPlaybackQualityEvent(
            `FEJLÉC (PMT); csatorna=${title}; képsáv=${codecs.video || 'ismeretlen típus'}; hangsávok=${codecs.audio.join('/') || 'ismeretlen'}; streamtípusok=[${codecs.streamTypes}].`
          );
        } else {
          logPlaybackQualityEvent(`FEJLÉC (PMT); csatorna=${title}; a stream elejéből nem olvasható ki a kodek.`);
        }
      }

      const sourceInfo = await probeSourceInfoQuality(htmlVideoRef.current);
      if (!qualityRef.current || qualityRef.current.url !== url) return;
      if (sourceInfo) {
        if (sourceInfo.videoCodec && !state.videoCodec) {
          state.videoCodec = sourceInfo.videoCodec;
          state.codecSource = 'TV sourceInfo';
        }
        if (sourceInfo.audioCodec && !state.audioCodec) state.audioCodec = sourceInfo.audioCodec;
        if (sourceInfo.bitrateKbps && state.bitrateKbps === null) {
          state.bitrateKbps = sourceInfo.bitrateKbps;
          state.bitrateSource = 'TV sourceInfo';
        }
        if (sourceInfo.hdr && !state.hdrStream) state.hdrStream = sourceInfo.hdr;
        if (sourceInfo.width > 0 && sourceInfo.height > 0 && !state.bestOffered) {
          state.bestOffered = { width: sourceInfo.width, height: sourceInfo.height, source: 'TV sourceInfo' };
        }
        logPlaybackQualityEvent(
          `TV (sourceInfo); cím=${title}; képsáv=${sourceInfo.videoCodec || 'nincs adat'} ` +
          `${sourceInfo.width}x${sourceInfo.height}${sourceInfo.frameRate ? ` @${sourceInfo.frameRate}` : ''}; ` +
          `bitráta=${sourceInfo.bitrateKbps ? `${(sourceInfo.bitrateKbps / 1000).toFixed(1)} Mbps` : 'nincs adat'}; HDR=${sourceInfo.hdr || 'nincs adat'}.`
        );
      }
    } catch {
      /* a fejléc-diagnosztika hibája sosem érintheti a lejátszást */
    }
  }, []);

  /** A panel és a böngészőmotor képességeinek egyszeri sora mintavétel-kezdetenként. */
  const logQualityCapability = useCallback((): void => {
    try {
      const probeVideo = document.createElement('video');
      const can = (type: string): string => {
        try { return probeVideo.canPlayType(type) || 'nem'; } catch { return 'ismeretlen'; }
      };
      const dpr = Number(window.devicePixelRatio) || 1;
      const gamut = (() => {
        try {
          if (window.matchMedia('(color-gamut: p3)').matches) return 'P3';
          if (window.matchMedia('(color-gamut: srgb)').matches) return 'sRGB';
        } catch { /* régi motor */ }
        return 'ismeretlen';
      })();
      logPlaybackQualityEvent(
        `KÉPESSÉG; TV=${tvDeviceText()}; képernyő=${window.screen?.width || 0}x${window.screen?.height || 0} CSS px; DPR=${dpr} (fizikai panel≈${Math.round((window.screen?.width || 0) * dpr)}x${Math.round((window.screen?.height || 0) * dpr)}); ` +
        `ablak=${window.innerWidth}x${window.innerHeight}; színtér=${gamut}; panel HDR=${hdrPanelSupported() === true ? 'igen (dynamic-range: high)' : hdrPanelSupported() === false ? 'nem jelzett' : 'a motor nem árulja el'}; ` +
        `canPlayType: H264="${can('video/mp4; codecs="avc1.640033"')}", HEVC="${can('video/mp4; codecs="hvc1.2.4.L150.B0"')}", VP9="${can('video/webm; codecs="vp09.00.51.08"')}", AV1="${can('video/mp4; codecs="av01.0.31M.10"')}", HLS="${can('application/vnd.apple.mpegurl')}", TS="${can('video/mp2t')}".`
      );
      const capabilities = (navigator as Navigator & {
        mediaCapabilities?: { decodingInfo?: (config: unknown) => Promise<{ supported?: boolean; smooth?: boolean; powerEfficient?: boolean }> };
      }).mediaCapabilities;
      if (capabilities?.decodingInfo) {
        const configs: Array<[string, unknown]> = [
          ['H.264 1080p', { type: 'file', video: { contentType: 'video/mp4; codecs="avc1.640033"', width: 1920, height: 1080, bitrate: 8000000, framerate: 50 } }],
          ['HEVC 2160p Main10', { type: 'file', video: { contentType: 'video/mp4; codecs="hvc1.2.4.L150.B0"', width: 3840, height: 2160, bitrate: 20000000, framerate: 60 } }],
          ['VP9 2160p', { type: 'file', video: { contentType: 'video/webm; codecs="vp09.02.51.10.01.09.16.09.01"', width: 3840, height: 2160, bitrate: 20000000, framerate: 60 } }],
          ['AV1 2160p', { type: 'file', video: { contentType: 'video/mp4; codecs="av01.0.31M.10"', width: 3840, height: 2160, bitrate: 16000000, framerate: 60 } }],
        ];
        void Promise.all(configs.map(async ([label, config]) => {
          try {
            const info = await capabilities.decodingInfo!(config);
            return `${label}=${info.supported ? 'támogatott' : 'NEM támogatott'} (sima=${info.smooth ? 'igen' : 'nem'}, energiatakarékos=${info.powerEfficient ? 'igen' : 'nem'})`;
          } catch {
            return `${label}=nem kérdezhető le`;
          }
        })).then((lines) => {
          logPlaybackQualityEvent(`KÉPESSÉG (mediaCapabilities); ${lines.join('; ')}.`);
        });
      }
    } catch {
      /* a képesség-sor sem hibázhat a lejátszás fölött */
    }
  }, []);

  const startQualitySampler = useCallback((): void => {
    if (qualityRef.current) return;
    const video = htmlVideoRef.current;
    if (!video) return;
    const state: QualitySamplerState = {
      timer: null,
      probeTimer: null,
      streamStartedAt: 0,
      url: '',
      probedUrl: '',
      summaryLogged: false,
      lastFrames: null,
      streamFrames: null,
      rvfcId: 0,
      rvfcCount: 0,
      lastRvfc: null,
      streamRvfc: null,
      waitingCount: 0,
      bufferingMs: 0,
      waitingSince: 0,
      sizesSeen: [],
      lastSizeKey: '',
      lastSampleAt: 0,
      videoCodec: '',
      audioCodec: '',
      codecSource: '',
      hdrStream: '',
      bitrateKbps: null,
      bitrateSource: '',
      bestOffered: null,
      lowQualityWarned: false,
      resourceCursor: 0,
      detach: () => undefined,
    };
    qualityRef.current = state;
    resetQualityStream(state, qualityCurrentUrl(video), video);

    const scheduleProbes = () => {
      const url = state.url || qualityCurrentUrl(video);
      if (!url || state.probedUrl === url) return;
      state.probedUrl = url;
      if (state.probeTimer !== null) window.clearTimeout(state.probeTimer);
      state.probeTimer = window.setTimeout(() => {
        state.probeTimer = null;
        void runQualityProbes(url);
      }, 1200);
    };
    const onWaitingLike = () => {
      if (!state.waitingSince) {
        state.waitingSince = Date.now();
        state.waitingCount += 1;
      }
    };
    const onPlaying = () => {
      if (state.waitingSince) {
        state.bufferingMs += Date.now() - state.waitingSince;
        state.waitingSince = 0;
      }
      scheduleProbes();
      sampleQualityRef.current();
    };
    const onResize = () => {
      const next = `${Number(video.videoWidth || 0)}x${Number(video.videoHeight || 0)}`;
      if (state.lastSizeKey && next !== state.lastSizeKey && !next.startsWith('0x')) {
        logPlaybackQualityEvent(`FELBONTÁS VÁLTOZOTT; cím=${qualityTitle()}; ${state.lastSizeKey} → ${next}.`);
      }
      sampleQualityRef.current();
    };
    try {
      video.addEventListener('waiting', onWaitingLike);
      video.addEventListener('stalled', onWaitingLike);
      video.addEventListener('playing', onPlaying);
      video.addEventListener('resize', onResize);
    } catch { /* régi motor */ }

    // Képkockasebesség tartalék-mérés, ha a motor nem ad számlálót:
    // a requestVideoFrameCallback minden kirajzolt képkockánál hívódik.
    if (!readPlaybackFrameStats(video)) {
      const rvfcVideo = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
        cancelVideoFrameCallback?: (id: number) => void;
      };
      if (typeof rvfcVideo.requestVideoFrameCallback === 'function') {
        const loop = () => {
          if (qualityRef.current !== state) return;
          state.rvfcCount += 1;
          try { state.rvfcId = rvfcVideo.requestVideoFrameCallback!(loop); } catch { /* már nem él */ }
        };
        try { state.rvfcId = rvfcVideo.requestVideoFrameCallback(loop); } catch { state.rvfcId = 0; }
      }
    }

    state.detach = () => {
      try {
        video.removeEventListener('waiting', onWaitingLike);
        video.removeEventListener('stalled', onWaitingLike);
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('resize', onResize);
      } catch { /* régi motor */ }
      const rvfcVideo = video as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void };
      try { if (state.rvfcId) rvfcVideo.cancelVideoFrameCallback?.(state.rvfcId); } catch { /* régi motor */ }
      state.rvfcId = 0;
    };

    logQualityCapability();
    state.timer = window.setInterval(() => sampleQualityRef.current(), 4000);
    if (!video.paused && video.readyState >= 2) {
      scheduleProbes();
      sampleQualityRef.current();
    }
  }, [logQualityCapability, runQualityProbes]);

  const stopQualitySampler = useCallback((): void => {
    const state = qualityRef.current;
    if (!state) return;
    // Ha a naplózás még él (pl. nézetváltás szerel le minket), a záró
    // összesítés most még bekerül; leállított naplónál a kapu elnyeli.
    summarizeQualityStream(htmlVideoRef.current);
    qualityRef.current = null;
    if (state.timer !== null) window.clearInterval(state.timer);
    if (state.probeTimer !== null) window.clearTimeout(state.probeTimer);
    state.detach();
  }, []);

  // A meglévő képminőségi diagnosztika nincs elindítva a sebességtesztben.
  void startQualitySampler;
  void stopQualitySampler;
  // Hibaképernyőn a sárga kijelölés automatikusan az Újrapróbálás gombra
  // ugrik - eddig távirányítóval nem lehetett elérni (a gomb hiányzott).
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  // isFullscreen a useState-ek között később jön deklarálódni, ezért a TDZ
  // elkerülése után a ref-en keresztül olvassuk (a useLayoutEffect szinkronizálja).
  const isFullscreenRef = useRef(false);
  useEffect(() => {
    if (!hasError) return;
    // Főoldali előnézetben NE vegyük el a sárga fókuszt a csatornalistától,
    // különben egy nem működő csatornánál megállna a Fel/Le böngészés!
    const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    const focusInsidePlayer = Boolean(active && containerRef.current?.contains(active));
    if (!isFullscreenRef.current && !focusInsidePlayer) return;
    const timer = window.setTimeout(() => {
      try { retryButtonRef.current?.focus({ preventScroll: true }); }
      catch { retryButtonRef.current?.focus(); }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [hasError]);
  // PUFFERELÉS BEKÖTVE (Rendszer menü: Gyors/Kiegyensúlyozott/Stabil):
  // a zap-őr és az automatikus formátumváltás időzítése ehhez igazodik.
  const bufferModeRef = useRef(settings.bufferMode);
  bufferModeRef.current = settings.bufferMode;
  const tvDoctorEnabledRef = useRef(settings.tvDoctorEnabled !== false);
  tvDoctorEnabledRef.current = settings.tvDoctorEnabled !== false;
  const subtitleSourceRef = useRef(subtitleSource);
  subtitleSourceRef.current = subtitleSource;
  const customStreamUrlLocalRef = useRef(customStreamUrl);
  customStreamUrlLocalRef.current = customStreamUrl;
  const [doctorStatus, setDoctorStatus] = useState<TvDoctorActiveStatus | null>(null);
  const doctorStatusHideTimerRef = useRef<number | null>(null);
  const [doctorStoreRevision, setDoctorStoreRevision] = useState<number>(0);

  useEffect(() => {
    return subscribeTvDoctorUpdates(() => {
      setDoctorStoreRevision((rev) => rev + 1);
    });
  }, []);

  const clearDoctorStatusTimer = useCallback(() => {
    if (doctorStatusHideTimerRef.current !== null) {
      window.clearTimeout(doctorStatusHideTimerRef.current);
      doctorStatusHideTimerRef.current = null;
    }
  }, []);

  const showDoctorStatus = useCallback((next: TvDoctorActiveStatus | null, autoHideMs?: number) => {
    clearDoctorStatusTimer();
    if (!tvDoctorEnabledRef.current || !next) {
      setDoctorStatus(null);
      return;
    }
    setDoctorStatus((prev) => (
      prev && prev.phase === next.phase && prev.title === next.title && prev.detail === next.detail
        ? prev
        : next
    ));
    if (typeof autoHideMs === 'number' && autoHideMs > 0) {
      doctorStatusHideTimerRef.current = window.setTimeout(() => {
        doctorStatusHideTimerRef.current = null;
        setDoctorStatus(null);
      }, autoHideMs);
    }
  }, [clearDoctorStatusTimer]);

  const scheduleClearDoctorStatus = useCallback((delayMs = 600) => {
    clearDoctorStatusTimer();
    doctorStatusHideTimerRef.current = window.setTimeout(() => {
      doctorStatusHideTimerRef.current = null;
      setDoctorStatus(null);
    }, Math.max(0, delayMs));
  }, [clearDoctorStatusTimer]);

  useEffect(() => () => {
    clearDoctorStatusTimer();
  }, [clearDoctorStatusTimer]);

  useEffect(() => {
    if (settings.tvDoctorEnabled === false) {
      clearDoctorStatusTimer();
      setDoctorStatus(null);
      setVodSessionAssisted(false);
    }
  }, [settings.tvDoctorEnabled, clearDoctorStatusTimer]);

  // VOD (film / sorozat) lejátszássegítés kizárólag az aktuális munkamenetben,
  // memória- vagy naplómentés nélkül (bezáráskor / forrásváltáskor törlődik).
  const [vodSessionAssisted, setVodSessionAssisted] = useState(false);
  useEffect(() => {
    setVodSessionAssisted(false);
  }, [customStreamUrl]);

  const doctorSessionRef = useRef<{
    channelKey: string;
    hasLearnedProfile: boolean;
    directFastStart: boolean;
    maxRepairSteps: number;
    channelHaltedDead: boolean;
    lastProposal: DoctorRepairProposal | null;
    activeBufferProfile: DoctorBufferProfileId;
    activeBufferTiming: BufferProfileTiming | null;
    vodStartupWatchdogMs: number;
    vodLoadStartedAt: number;
    vodStartupRecorded: boolean;
    repairStep: number;
    repairInFlight: boolean;
    waitingOrStalledFlag: boolean;
    consecutiveStallTicks: number;
    verifyTimer: number | null;
    fallbackUrlOverride: string | null;
  }>({
    channelKey: '',
    hasLearnedProfile: false,
    directFastStart: false,
    maxRepairSteps: MAX_DOCTOR_REPAIR_STEPS,
    channelHaltedDead: false,
    lastProposal: null,
    activeBufferProfile: settings.bufferMode || 'balanced',
    activeBufferTiming: null,
    vodStartupWatchdogMs: 8500,
    vodLoadStartedAt: 0,
    vodStartupRecorded: false,
    repairStep: 0,
    repairInFlight: false,
    waitingOrStalledFlag: false,
    consecutiveStallTicks: 0,
    verifyTimer: null,
    fallbackUrlOverride: null,
  });
  /**
   * LG webOS TV-n a támogatott webes lejátszási út a HTMLVideoElement.
   * Ez a TV platform médiamotorját használja; nincs külön, általánosan
   * támogatott AVPlay-szerű JavaScript videó-API. A régi „native” beállítás
   * kompatibilitásból megmarad, de nem jelent külön lejátszási útvonalat.
   */
  const playerEngine: 'html5' = 'html5';
  /** Az éppen kiválasztott csatorna (a hibakezeléshez, dependency nélkül). */
  const channelRef = useRef<typeof channel>(channel);
  channelRef.current = channel;
  /** A játszott film/sorozat címe a képminőség-naplóhoz (ref, hogy a mintavevő mindig frisset lásson). */
  const customTitleRef = useRef(customTitle);
  customTitleRef.current = customTitle;
  const buildVodDoctorTarget = useCallback((overrideUrl?: string): VodDoctorTarget => {
    const srcInfo = subtitleSourceRef.current;
    const targetUrl = overrideUrl || customStreamUrlLocalRef.current || '';
    const isSeriesKind = Boolean(srcInfo?.episodeId) || /\/series\//i.test(targetUrl);
    return {
      id: srcInfo?.episodeId
        ? `ep:${srcInfo.episodeId}`
        : srcInfo?.vodId
          ? `vod:${srcInfo.vodId}`
          : undefined,
      title: customTitleRef.current || undefined,
      streamUrl: targetUrl || undefined,
      mediaKind: isSeriesKind ? 'series' : 'movie',
    };
  }, []);
  /** Natív módban hányszor próbáltuk újraindítani ugyanazt a címet. */
  const nativeRetryCountRef = useRef(0);
  const bufferTiming = (): BufferProfileTiming => {
    if (tvDoctorEnabledRef.current && doctorSessionRef.current.activeBufferTiming) {
      return doctorSessionRef.current.activeBufferTiming;
    }
    return bufferProfileTiming(bufferModeRef.current);
  };
  const readDoctorStreamState = (video: HTMLVideoElement | null): DoctorStreamStateSnapshot => {
    if (!video) {
      return {
        readyState: 0,
        networkState: 0,
        paused: true,
        ended: false,
        currentTime: 0,
        duration: null,
        bufferedAheadSeconds: 0,
        decodedFrames: null,
        droppedFrames: null,
        videoWidth: 0,
        videoHeight: 0,
        waitingOrStalled: doctorSessionRef.current.waitingOrStalledFlag,
      };
    }
    const frames = readPlaybackFrameStats(video);
    const ahead = bufferedAheadSeconds(video);
    const dur = Number(video.duration);
    return {
      readyState: Number(video.readyState || 0),
      networkState: Number(video.networkState || 0),
      paused: Boolean(video.paused),
      ended: Boolean(video.ended),
      currentTime: Number(video.currentTime || 0),
      duration: Number.isFinite(dur) ? dur : null,
      bufferedAheadSeconds: ahead !== null && Number.isFinite(ahead) ? Math.max(0, ahead) : 0,
      decodedFrames: frames ? frames.total : null,
      droppedFrames: frames ? frames.dropped : null,
      videoWidth: Number(video.videoWidth || 0),
      videoHeight: Number(video.videoHeight || 0),
      waitingOrStalled: doctorSessionRef.current.waitingOrStalledFlag,
    };
  };
  const notifyTvDoctorIncident = (
    trigger: DoctorTriggerReason,
    video: HTMLVideoElement | null,
    errorCode?: string | null,
    errorDetail?: string | null,
    stallMs?: number,
  ): void => {
    if (!tvDoctorEnabledRef.current) return;
    try {
      const docState = doctorSessionRef.current;
      if (docState.verifyTimer !== null) {
        window.clearTimeout(docState.verifyTimer);
        docState.verifyTimer = null;
      }
      const streamSnapshot = readDoctorStreamState(video);

      const statusTitleForTrigger = (vodMode: boolean): string => {
        if (trigger === 'startup_timeout') return vodMode ? 'Lassú VOD-betöltés' : 'Lassú csatornaindulás';
        if (trigger === 'buffer_stall') return 'Pufferelési probléma';
        if (trigger === 'playback_stall') return 'Akadás javítása';
        if (trigger === 'unexpected_end' || trigger === 'unexpected_pause') return 'Megszakadt adatfolyam';
        return 'Adatfolyam-hiba kezelése';
      };

      if (isVodRef.current) {
        const vodTarget = buildVodDoctorTarget();
        const vodUrl = customStreamUrlLocalRef.current || activeMediaUrlRef.current || pendingStreamUrlRef.current || '';
        if (!vodUrl && !vodTarget.title) return;
        // VOD (Mozi / Sorozat): a TV Doktor valós időben segíti a folyamatos lejátszást,
        // de NEM menti el memóriába / naplóba, hogy melyik film vagy sorozat hol akadt el.
        setVodSessionAssisted(true);
        const resumePos = Math.max(
          0,
          Number(vodPositionKnownRef.current ? vodLastPositionRef.current : initialPositionSeconds) || 0,
        );
        docState.repairStep += 1;
        const proposal = planVodDoctorRepairStep({
          target: vodTarget,
          trigger,
          step: docState.repairStep,
          currentBufferProfile: docState.activeBufferProfile,
          streamUrl: vodUrl,
          resumePositionSeconds: resumePos,
        });
        docState.activeBufferProfile = proposal.nextBufferProfile;
        docState.activeBufferTiming = proposal.nextBufferTiming;
        docState.repairInFlight = !proposal.exhausted;
        docState.fallbackUrlOverride = null;
        showDoctorStatus({
          phase: trigger === 'media_error' || trigger === 'play_rejected' ? 'error' : 'repair',
          title: statusTitleForTrigger(true),
          detail: proposal.exhausted
            ? 'Kímélő újrapróbálkozás a mentett pozíciótól…'
            : `Újrapróbálkozás (${proposal.description})…`,
        });
        return;
      }

      const targetChannel = channelRef.current;
      if (!targetChannel) return;
      if (docState.channelHaltedDead) return;
      const activeUrl = activeMediaUrlRef.current || pendingStreamUrlRef.current || targetChannel.streamUrl || '';
      const currentFmt = formatOfUrl(activeUrl) || 'ts';
      const diag = channelSwitchDiagnosticRef.current;
      const loadElapsedMs = diag ? Math.max(0, Date.now() - diag.attemptStartedAt) : 0;

      collectDoctorDiagnostics({
        channel: targetChannel,
        trigger,
        format: currentFmt,
        bufferProfile: docState.activeBufferProfile,
        loadElapsedMs,
        errorCode,
        errorDetail,
        streamState: streamSnapshot,
      });

      recordDoctorChannelFailure({
        channel: targetChannel,
        format: currentFmt,
        bufferProfile: docState.activeBufferProfile,
        trigger,
        errorCode,
        errorDetail,
        stallMs,
      });

      const baseStreamUrl = targetChannel.streamUrl || activeUrl;
      const tsCandidate = /\.ts(?=([?#]|$))/i.test(baseStreamUrl)
        ? baseStreamUrl
        : baseStreamUrl.replace(/\.m3u8(?=([?#]|$))/i, '.ts');
      const hlsCandidate = baseStreamUrl.replace(/\.ts(?=([?#]|$))/i, '.m3u8');

      docState.repairStep += 1;
      const proposal = planDoctorRepairStep({
        channel: targetChannel,
        trigger,
        step: docState.repairStep,
        maxStepsOverride: docState.maxRepairSteps,
        currentFormat: currentFmt,
        currentBufferProfile: docState.activeBufferProfile,
        streamUrl: baseStreamUrl,
        tsUrl: tsCandidate,
        hlsUrl: hlsCandidate,
      });

      docState.activeBufferProfile = proposal.nextBufferProfile;
      docState.activeBufferTiming = proposal.nextBufferTiming;
      docState.fallbackUrlOverride = proposal.useFallbackUrl ? proposal.nextUrl : null;

      if (proposal.stopRetrying || proposal.exhausted) {
        // A csatorna valóban nem működik: leállítunk minden automatikus újrapróbálást,
        // hogy SOHA ne pörögjön végtelen ciklusban!
        docState.channelHaltedDead = true;
        docState.repairInFlight = false;
        docState.lastProposal = null;
        if (autoRetryTimerRef.current !== null) {
          window.clearTimeout(autoRetryTimerRef.current);
          autoRetryTimerRef.current = null;
        }
        if (bufferWatchdogRef.current !== null) {
          window.clearTimeout(bufferWatchdogRef.current);
          bufferWatchdogRef.current = null;
        }
        clearRecovery();
        if (video) {
          try {
            video.pause();
            video.removeAttribute('src');
            video.load();
          } catch {
            /* ignore */
          }
        }
        activeMediaUrlRef.current = '';
        playbackStartedRef.current = false;
        endSwitch();
        logChannelSwitchSummary(
          'SIKERTELEN',
          `a csatorna nem működik (${proposal.maxSteps}/${proposal.maxSteps} beállítás sikertelen) – újrapróbálás leállítva`,
          video || undefined,
        );
        appLogCritical(
          `CSATORNA NEM MŰKÖDIK – ÚJRAPRÓBÁLÁS LEÁLLÍTVA; csatorna=${String(targetChannel.name || 'élő adás').slice(0, 100)}; ` +
          `kipróbált-beállítások=${proposal.maxSteps}; utolsó-ok=${trigger}.`,
        );
        setIsLoading(false);
        setIsRecovering(false);
        setIsPlaying(false);
        setHasError(true);
        setErrorMessage('A csatorna jelenleg nem működik – az automatikus újrapróbálás leállt.');
        showDoctorStatus({
          phase: 'error',
          title: 'Csatorna nem működik',
          detail: `${proposal.maxSteps} beállítás sikertelen – újrapróbálás leállítva.`,
        });
        scheduleClearDoctorStatus(4200);
        return;
      }

      docState.repairInFlight = true;
      docState.lastProposal = proposal;
      showDoctorStatus({
        phase: trigger === 'media_error' || trigger === 'play_rejected' ? 'error' : 'repair',
        title: statusTitleForTrigger(false),
        detail: `${proposal.description}…`,
      });
    } catch {
      /* Belső hiba esetén csendben visszaáll a meglévő lejátszási mechanizmusra. */
    }
  };
  // Egyetlen lezáró naplósor minden élő csatornaváltásról.
  const logChannelSwitchSummary = (
    result: 'SIKERES' | 'SIKERTELEN',
    reason: string,
    video?: HTMLVideoElement,
  ) => {
    const diagnostic = channelSwitchDiagnosticRef.current;
    if (!diagnostic || diagnostic.summaryLogged) return;
    diagnostic.summaryLogged = true;
    const sequence = liveRetrySequenceRef.current;
    const triedFormats = sequence.urls
      .slice(0, Math.max(1, sequence.index + 1))
      .map((streamUrl) => /\.m3u8(?=([?#]|$))/i.test(streamUrl) ? 'HLS' :
        /\.ts(?=([?#]|$))/i.test(streamUrl) ? 'MPEG-TS' : 'egyéb')
      .join(' → ') || 'ismeretlen';
    const activeFormat = video
      ? (/\.m3u8(?=([?#]|$))/i.test(video.currentSrc || video.src) ? 'HLS' :
        /\.ts(?=([?#]|$))/i.test(video.currentSrc || video.src) ? 'MPEG-TS' : 'ismeretlen')
      : 'nincs';
    appLog(
      `CSATORNAVÁLTÁS ÖSSZESÍTÉS; eredmény=${result}; csatorna=${diagnostic.channelName}; teljes-idő=${Date.now() - diagnostic.startedAt} ms; utolsó-próba-idő=${Date.now() - diagnostic.attemptStartedAt} ms; formátum-próba=${Math.max(1, sequence.index + 1)}/${Math.max(1, sequence.urls.length)}; összes-betöltés=${diagnostic.loadCount}; próbált-formátumok=${triedFormats}; aktív-formátum=${activeFormat}; ok=${reason}`
    );
  };
  const scheduleAutoRetry = useCallback(() => {
    if (autoRetryTimerRef.current !== null) return;
    // Élő TV-n először a kézzel kiválasztott formátum fut; ha az nem indul,
    // egyszer automatikusan kipróbáljuk a másik TS/HLS változatot.
    if (!isVodRef.current) {
      if (tvDoctorEnabledRef.current && doctorSessionRef.current.channelHaltedDead) {
        return;
      }
      // Ha a TV Doktor aktív, közvetlenül végrehajtjuk a gyors, több-beállításos javítási tervét!
      if (tvDoctorEnabledRef.current && doctorSessionRef.current.lastProposal) {
        const proposal = doctorSessionRef.current.lastProposal;
        doctorSessionRef.current.lastProposal = null;
        if (!proposal.exhausted && !proposal.stopRetrying) {
          const channelName = channelSwitchDiagnosticRef.current?.channelName || 'élő adás';
          const sequence = liveRetrySequenceRef.current;
          const idx = sequence.urls.indexOf(proposal.nextUrl);
          if (idx >= 0) sequence.index = idx;
          pendingStreamUrlRef.current = proposal.nextUrl;
          setHasError(false);
          setErrorMessage('');
          setIsLoading(false);
          setIsRecovering(true);
          const delayMs = Math.max(40, Math.min(400, proposal.delayMs));
          appLog(
            `TV DOKTOR BEÁLLÍTÁSVÁLTÁS ÜTEMEZVE; csatorna=${channelName}; lépés=${proposal.step}/${proposal.maxSteps}; ` +
            `formátum=${proposal.nextFormat.toUpperCase()}; puffer=${proposal.nextBufferProfile} (${proposal.nextBufferTiming.minBufferAheadSeconds}mp); ` +
            `várakozás=${delayMs} ms; stratégia=${proposal.strategyId}.`,
          );
          // Az első lépésű gyors tiszta újraindítás (quick_primary_retry) ugyanazt
          // teszi, mint az „ELSŐ FORMÁTUM GYORS ÚJRAPRÓBÁJA” útvonal: újrapróbálja
          // az elsődleges célt teljes újratöltéssel. A zurückgeféle naplóbejegyzés
          // a csatornaváltási diagnosztikai tesztben is követendő.
          if (proposal.strategyId === 'quick_primary_retry') {
            appLog(`ELSŐ FORMÁTUM GYORS ÚJRAPRÓBÁJA; csatorna=${channelName}; formátum=${proposal.nextFormat.toUpperCase()}; várakozás=${delayMs} ms.`);
          }
          if (proposal.strategyId === 'format_switch_probe') {
            const altLabel = proposal.nextFormat === 'hls' ? 'HLS (.m3u8)' : 'MPEG-TS (.ts)';
            appLog(`FORMÁTUM-VISSZAESÉS; csatorna=${channelName}; ${altLabel} próba következik.`);
          }
          autoRetryTimerRef.current = window.setTimeout(() => {
            autoRetryTimerRef.current = null;
            if (doctorSessionRef.current.channelHaltedDead) return;
            loadStreamRef.current(proposal.nextUrl, proposal.forceCleanReset);
          }, delayMs);
          return;
        }
      }
      const sequence = liveRetrySequenceRef.current;
      // A #18 M2 UHD-mérése szerint az első, átmeneti Format error után a
      // felesleges azonnali formátumváltás lassíthatja a visszatérést. Az
      // elsődleges címet ezért egyszer újra teljes load()-dal kérjük; csak a
      // második sikertelen indulás után jöhet a másik formátum. Ez az első
      // használatnál is működik, nem csak a már emlékezett csatornánál.
      if (initialFormatRetryRef.current && sequence.index === 0 && sequence.urls.length > 1) {
        initialFormatRetryRef.current = false;
        const currentUrl = sequence.urls[0];
        const channelName = channelSwitchDiagnosticRef.current?.channelName || 'élő adás';
        pendingStreamUrlRef.current = currentUrl;
        setHasError(false);
        setErrorMessage('');
        setIsLoading(false);
        setIsRecovering(true);
        const retryDelayMs = Math.min(100, Math.max(30, bufferTiming().retryMs));
        showDoctorStatus({
          phase: 'retry',
          title: 'Újrapróbálkozás',
          detail: 'Elsődleges adás gyors újracsatlakoztatása…',
        });
        appLog(`ELSŐ FORMÁTUM GYORS ÚJRAPRÓBÁJA; csatorna=${channelName}; formátum=${formatOfUrl(currentUrl)?.toUpperCase() || 'ismeretlen'}; várakozás=${retryDelayMs} ms.`);
        autoRetryTimerRef.current = window.setTimeout(() => {
          autoRetryTimerRef.current = null;
          loadStreamRef.current(currentUrl, true);
        }, retryDelayMs);
        return;
      }
      // A két külön formátum egyszeri próbája után már nem váltunk vissza
      // azonnal a másik címre. A recovery saját, ritkuló időzítésével
      // újrapróbálja az adást, így egy késői régi hiba nem indít ciklust.
      if (liveRecoveryOnlyRef.current) {
        setHasError(false);
        setIsLoading(false);
        setIsRecovering(true);
        showDoctorStatus({
          phase: 'retry',
          title: 'Újrapróbálkozás',
          detail: 'Kontrollált adás-helyreállítás…',
        });
        requestRecoveryRef.current('indítási próba sikertelen – kontrollált újrapróba');
        return;
      }
      const nextIndex = sequence.index + 1;
      if (nextIndex < sequence.urls.length) {
        sequence.index = nextIndex;
        const nextUrl = sequence.urls[nextIndex];
        const nextFormat = formatOfUrl(nextUrl);
        const channelName = channelSwitchDiagnosticRef.current?.channelName || 'élő adás';
        pendingStreamUrlRef.current = nextUrl;
        setHasError(false);
        setErrorMessage('');
        // NEM takarjuk el a képet: a tartalék formátum próbája alatt a
        // legutolsó képkocka és a hang is megmarad (csak egy kis jelző megy ki).
        setIsLoading(false);
        setIsRecovering(true);
        showDoctorStatus({
          phase: 'retry',
          title: 'Formátumváltás és újrapróba',
          detail: `${nextFormat === 'hls' ? 'HLS (.m3u8)' : 'MPEG-TS (.ts)'} tartalék indítása…`,
        });
        if (nextIndex === 1) {
          appLog(`FORMÁTUM-VISSZAESÉS; csatorna=${channelName}; ${nextFormat === 'hls' ? 'HLS (.m3u8)' : 'MPEG-TS (.ts)'} próba következik.`);
        }
        // A következő formátumot rövid késleltetéssel próbáljuk; az ismétlések fokozatosan várnak többet.
        const retryDelayMs = Math.min(100 * (2 ** Math.max(0, nextIndex - 1)), 400);
        appLog(`ÚJRAPRÓBA ÜTEMEZVE; csatorna=${channelName}; próba=${nextIndex + 1}/${sequence.urls.length}; formátum=${nextFormat?.toUpperCase() || 'ismeretlen'}; várakozás=${retryDelayMs} ms; ok=előző próba nem indult el.`);
        autoRetryTimerRef.current = window.setTimeout(() => {
          autoRetryTimerRef.current = null;
          retryStreamRef.current?.();
        }, retryDelayMs);
        return;
      }
      const failedChannel = channelRef.current;
      const hadAlternative = Boolean(liveFallbackRef.current);
      const triedFormats = hadAlternative
        ? (liveFallbackRef.current?.format === 'hls' ? 'MPEG-TS + HLS' : 'HLS + MPEG-TS')
        : 'MPEG-TS';
      appLogCritical(
        `MINDKÉT FORMÁTUM SIKERTELEN; csatorna=${String(failedChannel?.name || channelSwitchDiagnosticRef.current?.channelName || 'élő adás').slice(0, 100)}; ` +
        `próbált formátumok=${triedFormats}; a csatorna jelenleg nem indítható. Az utolsó sikeres formátum emléke megőrizve.`
      );
      logChannelSwitchSummary('SIKERTELEN', `minden indítási próba sikertelen; formátumok=${triedFormats}`);
      // Ha a csatornánként megjegyzett forma most mindkét próbán elbukott,
      // ne kényszerítsük a következő váltást ugyanabba a hibás sorrendbe.
      forgetFormatFor(channelRef.current?.id);
      /*
       * NINCS többé végleges fekete hibaképernyő. Ha a szolgáltató épp
       * elérhetetlen, a lejátszó fokozatos visszalépéssel addig próbálkozik,
       * amíg a csatorna vissza nem jön (vagy a néző másik csatornát választ).
       */
      setIsLoading(false);
      setHasError(false);
      liveRecoveryOnlyRef.current = true;
      sequence.index = 0;
      showDoctorStatus({
        phase: 'retry',
        title: 'Szolgáltatói hiba kezelése',
        detail: 'Fokozatos újracsatlakozás a csatornára…',
      });
      requestRecoveryRef.current('mindkét formátum sikertelen');
      return;
    }
    /*
     * FILM / SOROZAT: itt NINCS TS → HLS formátum-átírás. A VOD `.ts` / `.mkv`
     * címek valódi fájlok, az átírás másik (nem létező) fájlra mutatna.
     * Helyette ugyanazt a címet töltjük újra, a megőrzött pozícióról.
     */
    setHasError(false);
    setIsLoading(false);
    setIsRecovering(true);
    showDoctorStatus({
      phase: 'retry',
      title: 'VOD újrapróbálkozás',
      detail: 'Film / sorozat újracsatlakoztatása a mentett pozíciótól…',
    });
    autoRetryTimerRef.current = window.setTimeout(() => {
      autoRetryTimerRef.current = null;
      vodRecoveryRef.current('VOD újrapróba');
    }, bufferTiming().retryMs);
  }, [showDoctorStatus]);
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
    // Többször érkező waiting/stalled esemény ne tolja ki folyton a határidőt.
    if (bufferWatchdogRef.current !== null) return;
    const video = htmlVideoRef.current;
    // Már elindult élő adás ÉS (aktív TV Doktor mellett) film/sorozat
    // beragadt pufferelését is felügyeljük; VOD esetén türelmesebb ablakkal.
    if (!video || !playbackStartedRef.current || video.paused) return;
    if (isVodRef.current && !tvDoctorEnabledRef.current) return;
    const generation = streamLoadGenerationRef.current;
    const startedAt = Date.now();
    const startSample = readMediaProgress(video, startedAt);
    let confirmationUsed = false;
    const effectiveWatchdogMs = (): number => {
      const base = bufferTiming().bufferWatchdogMs;
      return isVodRef.current ? Math.max(5500, base + 1500) : base;
    };
    // A módváltás nem indítja újra a forrást. A következő ellenőrzés ezért
    // mindig újraolvassa a profilt, és nem engedi, hogy egy régi, rövidebb
    // időzítő mégis a frissen kiválasztott Stabil/Kiegyensúlyozott mód előtt
    // újratöltse az adást.
    const scheduleCheck = (delayMs: number): void => {
      bufferWatchdogRef.current = window.setTimeout(() => {
        bufferWatchdogRef.current = null;
        if (
          generation !== streamLoadGenerationRef.current ||
          video !== htmlVideoRef.current ||
          video.paused ||
          !playbackStartedRef.current
        ) return;
        const timing = bufferTiming();
        const limitMs = effectiveWatchdogMs();
        const elapsed = Date.now() - startedAt;
        if (elapsed < limitMs) {
          scheduleCheck(limitMs - elapsed);
          return;
        }
        const currentSample = readMediaProgress(video, Date.now());
        // A haladó idővonal vagy egy új dekódolt képkocka önmagában elég
        // bizonyíték: webOS-en a readyState közben röviden HAVE_CURRENT_DATA
        // (2) értékre is visszaeshet. A már futó adásnál a puszta puffer-
        // növekedést szándékosan nem fogadjuk el haladásnak.
        const advanced = mediaProgressed(startSample, currentSample);
        if (advanced) return;
        const ahead = bufferedAheadSeconds(video);
        const mediaLabel = isVodRef.current
          ? (customTitleRef.current || 'VOD')
          : (channelSwitchDiagnosticRef.current?.channelName || channelRef.current?.name || 'élő adás');
        // Ha még van valódi, a lejátszási ponthoz viszonyított tartalék, egy
        // rövid megerősítő ablakot adunk a dekódernek. A korábbi 1,2/2,0 mp-es
        // profilidőzítők a #12-ben túl korán indítottak forráscserét egy
        // pillanatnyi HLS/TS szegmensváltás miatt.
        if (!confirmationUsed && ahead !== null && ahead >= timing.minBufferAheadSeconds && video.readyState >= 2) {
          confirmationUsed = true;
          const confirmMs = Math.max(750, Math.min(1500, timing.retryMs));
          appLog(
            `PUFFERELÉSI ŐR HALASZTVA; csatorna=${mediaLabel}; ` +
            `puffer-előre=${ahead.toFixed(2)} s; minimum=${timing.minBufferAheadSeconds.toFixed(1)} s; ` +
            `megerősítés=${confirmMs} ms.`
          );
          scheduleCheck(confirmMs);
          return;
        }
        appLog(
          `PUFFERELÉSI WATCHDOG; csatorna=${mediaLabel}; ` +
          `eltelt=${elapsed} ms; időkorlát=${limitMs} ms; haladt=${advanced}; ` +
          `puffer-előre=${ahead === null ? 'n/a' : ahead.toFixed(2)} s; ${videoDiagnosticState(video, 'buffer-watchdog')}`
        );
        notifyTvDoctorIncident('buffer_stall', video, 'BUFFER_STALL', 'pufferelés elakadt', elapsed);
        // Először UGYANAZT a címet próbáljuk újra, nem ugrunk rögtön a másik
        // formátumra: így a hang és a kép nem csúszik szét feleslegesen.
        requestRecoveryRef.current('pufferelés elakadt');
      }, Math.max(0, delayMs));
    };
    scheduleCheck(effectiveWatchdogMs());
  }, [scheduleAutoRetry]);

  /*
   * EGYSÉGES LEJÁTSZÁSFIGYELŐ (élő TV + film/sorozat).
   *
   * A régi élő watchdog kizárólag a `currentTime` változását nézte, 2 mp
   * után pedig azonnal formátumot váltott. webOS-en az élő MPEG-TS
   * idővonala gyakran 0 marad, miközben a képkockák érkeznek – ezért a
   * figyelő feleslegesen újratöltötte a stream-et (eltűnt a kép, a hang
   * viszont ment tovább). Most a képkocka-számláló, az idővonal és a
   * puffer együtt dönt, és a VOD-ra is ugyanez a (türelmesebb) őr vigyáz.
   */
  useEffect(() => {
    if (!isPlaying) return;
    const video = htmlVideoRef.current;
    if (!video) return;
    const detector = new StallDetector(isVod ? 7000 : bufferTiming().stallDetectorMs);
    stallDetectorRef.current = detector;
    let previousSample: MediaProgressSample | null = null;
    const generation = streamLoadGenerationRef.current;
    const timer = window.setInterval(() => {
      if (
        generation !== streamLoadGenerationRef.current ||
        video !== htmlVideoRef.current ||
        video.paused ||
        video.ended ||
        !playbackStartedRef.current ||
        switchInProgressRef.current
      ) {
        detector.reset();
        previousSample = null;
        return;
      }
      const now = Date.now();
      const sample = readMediaProgress(video, now);
      /*
       * Ha a régi webOS egyáltalán NEM ad mérhető jelet (sem képkockát, sem
       * puffert, sem idővonalat), akkor nem találgatunk: ilyenkor a
       * `waiting` / `stalled` / `error` események és a puffer-őr döntenek.
       * Így egy olyan élő MPEG-TS adást sem töltünk újra feleslegesen,
       * amelynek az idővonala a TV-n mindig 0 marad.
       */
      const hasAnySignal = sample.frames !== null || sample.bufferedEnd !== null || sample.time > 0;
      const prevSnapshot = previousSample;
      // Keresés (előre/tekerés) nem megakadás.
      if (previousSample && Math.abs(sample.time - previousSample.time) > 2) {
        detector.reset();
        doctorSessionRef.current.consecutiveStallTicks = 0;
      } else if (previousSample && mediaProgressed(previousSample, sample)) {
        doctorSessionRef.current.consecutiveStallTicks = 0;
        doctorSessionRef.current.waitingOrStalledFlag = false;
      }
      previousSample = sample;
      if (!detector.observe(sample, now)) return;
      detector.reset();
      if (!hasAnySignal) return;
      if (tvDoctorEnabledRef.current) {
        doctorSessionRef.current.consecutiveStallTicks += 1;
        const freezeDecision = evaluateSmartFreeze({
          prevSnapshot,
          currentSnapshot: sample,
          streamState: readDoctorStreamState(video),
          consecutiveStallTicks: doctorSessionRef.current.consecutiveStallTicks,
          minBufferAheadSeconds: bufferTiming().minBufferAheadSeconds,
        });
        if (!freezeDecision.intervene) {
          appLog(`TV DOKTOR FAGYÁSFIGYELŐ MEGERŐSÍTÉSRE VÁR; ok=${freezeDecision.reason}`);
          return;
        }
        doctorSessionRef.current.consecutiveStallTicks = 0;
        notifyTvDoctorIncident(
          'playback_stall',
          video,
          'PLAYBACK_STALL',
          freezeDecision.reason,
          isVod ? 7000 : bufferTiming().stallDetectorMs,
        );
      }
      appLog(
        `LEJÁTSZÁS MEGAKADT; mód=${isVod ? 'VOD' : 'élő'}; ok=${isVod ? 7 : 4} mp alatt egyetlen haladási jel sem volt; ` +
        `${videoDiagnosticState(video, 'playback-stall-watchdog')}`
      );
      requestRecoveryRef.current('idővonal megakadt');
    }, 1000);
    return () => {
      window.clearInterval(timer);
      if (stallDetectorRef.current === detector) stallDetectorRef.current = null;
    };
  }, [isVod, isPlaying, channel?.id, customStreamUrl, settings.bufferMode]);

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
  const [vodTrackMenu, setVodTrackMenu] = useState<'audio' | 'subtitle' | 'combined' | null>(null);
  /**
   * Film/sorozat OSD: minden felhasználói művelet (gombnyomás, tekerés)
   * újraindítja az eltűnési időzítőt – így nem tűnik el a kezünk alól.
   */
  const [vodOsdActivity, setVodOsdActivity] = useState<number>(0);
  const handleVodOsdActivity = useCallback(() => {
    setShowControlsOverlay(true);
    setVodOsdActivity((value) => value + 1);
  }, []);

  // TV: élő adáson az OK/VISSZA vált képernyőt, VOD alatt az OK nyitja az OSD-t.
  const isLive = !isVod;
  // TV: a csatornalistáról érkező kérés (OK a már futó csatornán) indítja a
  // teljes képernyős nézetet - a lejátszó dobozból indítás megszűnt.
  useEffect(() => {
    const enterFs = () => {
      if (!isLive) return;
      // 2.5.166: a mérés az OK-tól indul; ez a lépés a valódi késleltetést
      // mutatja meg az OK és a lejátszó állapotváltása között.
      fsStep('esemény a lejátszónál', 'a csatornalista OK-ja megérkezett');
      setIsFullscreen(true);
      fsStep('lejátszó állapota beállítva', 'setIsFullscreen(true) – React commit következik');
    };
    window.addEventListener('iptv-enter-fullscreen', enterFs);
    return () => window.removeEventListener('iptv-enter-fullscreen', enterFs);
  }, [isLive]);

  // Teljes képernyőn body-osztály jelzi a TV-s CSS-nek, hogy a főoldali
  // elemek (fejléc, óra doboz) teljesen tűnjenek el - a bal felső sarokban
  // átlátszó kék doboz ikon ennek a hiánya miatt látszott.
  //
  // TELJESÍTMÉNY: ez `useLayoutEffect`, hogy az osztály MÉG A KIFESTÉS ELŐTT
  // felkerüljön. Korábban (passzív effektként) a képkocka először a régi
  // osztálykészlettel festődött ki, majd az osztályváltás egy MÁSODIK
  // stílus-újraszámolást és újrafestést indított – ez volt a váltásnál
  // látható „villanás”. Így egyetlen elrendezés/festés történik.
  useLayoutEffect(() => {
    try {
      document.body.classList.toggle('iptv-tv-fullscreen', isFullscreen);
      isFullscreenRef.current = isFullscreen;
    } catch { /* SSR/teszt környezet */ }
    return () => {
      try { document.body.classList.remove('iptv-tv-fullscreen'); } catch {}
    };
  }, [isFullscreen]);

  /**
   * TELJES KÉPERNYŐ: a geometria KIZÁRÓLAG a `.iptv-fs` CSS-osztályból jön.
   *
   * KORÁBBAN itt egy `Object.assign(container.style, …)` írt fel ~18 inline
   * stílust, majd egy `offsetHeight`-olvasás SZINKRON, teljes oldalas
   * újrarendezést kényszerített – a TV lassú processzorán ez volt a
   * látható akadás. Ráadásul ugyanezeket az inline értékeket a kilépéskor a
   * `syncMainPageLayout` mérésének kellett visszaállítania (újabb írások és
   * újabb kényszerített újrarendezés).
   *
   * MOST a React csak az osztálynevet teszi fel/le a commitban; a böngésző a
   * képkockát EGY elrendezéssel festi ki. Kilépéskor az osztály eltávolítása
   * magától visszaadja a főoldali 16:9-es keretet, mert a teljes képernyő
   * alatt semmi nem írta felül az inline stílusokat.
   *
   * Az itteni effekt már csak a célzott teljesítménynaplózást végzi (kézi
   * naplózás alatt), és a belépés első kifestett képkockáját méri.
   */
  const fsModeRef = useRef(false);
  useEffect(() => {
    if (fsModeRef.current === isFullscreen) return;
    fsModeRef.current = isFullscreen;
    if (!isVerbosePlaybackLogging()) return;
    const started = fsNow();
    fsStep('React commit kész', isFullscreen ? 'teljes képernyős CSS-osztály' : 'főoldali CSS-geometria');
    // Az első rAF festés ELŐTT fut. A második a köztes festés utáni
    // renderelési lehetőség becslése, nem a panel tényleges megjelenítése.
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        fsPerfTimed(isFullscreen ? 'BE: festés utáni renderelési lehetőség' : 'KI: festés utáni renderelési lehetőség', started);
        fsFinish('második rAF; a tényleges kijelző-festés nem igazolható');
      });
    });
    return () => window.cancelAnimationFrame(frame);
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
    /*
     * TELJESÍTMÉNY: korábban négy időzítő (0/80/260/600 ms) futott, és minden
     * `focus()` a fókusz körüli görgetést/elrendezést is kiválthatott.
     * A főoldal a váltás alatt már nem rajzolódik újra (a lejátszó doboza a
     * commitban kapja meg a `.iptv-fs` osztályt), ezért egy azonnali és egy
     * késői ellenőrzés bőven elég – a fókuszt így sem veszítheti el a doboz.
     */
    const timers = [0, 200].map((delay) => window.setTimeout(assertFocus, delay));
    if (isVerbosePlaybackLogging()) {
      const started = fsNow();
      timers.push(window.setTimeout(() => {
        const container = containerRef.current;
        const active = document.activeElement as HTMLElement | null;
        const ok = !!container && (active === container || !!container.contains(active));
        fsPerfTimed('BE: fókusz ellenőrizve', started, ok ? 'a lejátszón maradt' : 'a fókusz visszakerült a lejátszóra');
        fsStep('fókusz ellenőrizve', ok ? 'a lejátszón maradt' : 'visszakerült a lejátszóra');
      }, 260));
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [isFullscreen]);

  /*
   * A TELJES KÉPERNYŐ ÁLLAPOTA A FŐOLDALNAK – ELSŐKÉNT (2.5.168).
   *
   * A #38–#42 naplók: a KILÉPÉS 158–215 ms volt, miközben a lejátszó commitja
   * 6–10 ms alatt kész volt. A különbség a két egymás utáni újrarajzolásé:
   * előbb a lejátszó renderelte újra magát (OSD vissza), és csak az UTÁNA
   * tudta meg a főoldal, hogy kiléptünk – így az OSD, az oldalsáv és a
   * csatornalista külön körben rajzolódott. Ez az effekt ezért a többi
   * teljes képernyős effekt ELŐTT fut: a két állapotváltozás egy React-körbe
   * kerül, vagyis EGY újrarajzolás történik.
   */
  useEffect(() => {
    onFullscreenChange?.(isFullscreen);
    nativeApi()?.setFullscreen?.(isFullscreen);
  }, [isFullscreen, onFullscreenChange]);

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
    let focusFrame = 0;
    let restoreFrame = 0;
    if (isFullscreen) {
      wasFullscreenRef.current = true;
      window.dispatchEvent(new CustomEvent('iptv-fullscreen-entered'));
      focusFrame = window.requestAnimationFrame(() => {
        containerRef.current?.focus({ preventScroll: true } as any);
      });
    } else if (wasFullscreenRef.current) {
      wasFullscreenRef.current = false;
      try { (containerRef.current as HTMLElement | null)?.blur?.(); } catch { /* régi motor */ }
      setShowControlsOverlay(true);
      focusFrame = window.requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('iptv-focus-selected-channel'));
      });
      // Az EPG továbbra is csak két renderelési lehetőség után indul újra.
      // Újabb belépés/unmount esetén a régi visszatérés nem indíthatja el.
      restoreFrame = window.requestAnimationFrame(() => {
        restoreFrame = window.requestAnimationFrame(() => {
          const started = fsNow();
          window.dispatchEvent(new CustomEvent('iptv-player-restored'));
          if (isVerbosePlaybackLogging()) {
            fsPerfTimed('KI: OSD/EPG újraindult', started, 'a lejátszó már a főoldali helyén');
            fsStep('OSD/EPG újraindult', 'a háttérmunka a helyreállás UTÁN kapott engedélyt');
          }
        });
      });
    }
    return () => {
      if (focusFrame) window.cancelAnimationFrame(focusFrame);
      if (restoreFrame) window.cancelAnimationFrame(restoreFrame);
    };
  }, [isFullscreen]);
  // A webOS TV kizárólag fekvő nézetet használ.
  const isLiveLandscapeFullscreen = isLive && isFullscreen;
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
    // Élő teljes képernyőn a lejátszó SAJÁT overlaye rejtett, de ez nem a
    // főoldali OSD láthatósága. Ha false-t küldenénk, az App display:none-nal
    // kivenné az OSD-t a flexből, majd kilépés után később tenné vissza.
    // A VOD saját OSD-jének állapotjelentése változatlan.
    onOverlayVisibilityChange?.(isVod ? showControlsOverlay : true);
  }, [isVod, showControlsOverlay, onOverlayVisibilityChange]);

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
        // 2.5.166: a kilépés mérése is innen, az OK lenyomásától indul.
        fsStart('KI', 'OK a teljes képernyőn');
        setIsFullscreen(false);
        fsStep('lejátszó állapota beállítva', 'setIsFullscreen(false) – React commit következik');
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
      else if (isFullscreen) {
        fsStart('KI', 'VISSZA a teljes képernyőn');
        setIsFullscreen(false);
        fsStep('lejátszó állapota beállítva', 'setIsFullscreen(false) – React commit következik');
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
  /**
   * Volt-e már képkocka az AKTUÁLIS streamből?
   * Ha igen, a pufferelés / újracsatlakozás jelzője NEM takarhatja el a
   * képet egy teljes képernyős fekete réteggel (ez volt a „hang megy, kép
   * nincs” jelenség). Új csatorna / új film indításakor visszaáll false-ra,
   * ilyenkor a megszokott „Gyors kapcsolódás...” képernyő látszik.
   */
  const [currentStreamHasFrame, setCurrentStreamHasFrame] = useState<boolean>(false);
  const [, setNativeMessage] = useState<string>('');

  const [vodCurrentTime, setVodCurrentTime] = useState(0);
  const [vodDuration, setVodDuration] = useState(0);
  /** A film pillanatnyi helyzete a felirat kirajzolásához (natív motornál is). */
  const vodSubtitleClockRef = useRef(0);
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
   * Élő adás feliratsávjai a TV médiaszolgáltatásától / a stream fejlécéből.
   * A HTML5 textTracks az élő DVB/teletext feliratot nem teszi közzé, ezért
   * ez a külön lista tölti meg a zöld gombos élő CC-választót – és ettől vált
   * zöldre az élő OSD CC ikonja is (a VOD felirattól teljesen külön út).
   */
  const [lunaTvSubtitleTracks, setLunaTvSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const lunaTvActiveRef = useRef(false);
  const userTvSubtitleChoiceRef = useRef<string | null>(null);
  const liveAutoSubtitleKeyRef = useRef<string>('');
  /** Az élő Luna-sávok részletei (nyelv/fajta) azonosítónként, a TV-listához illesztéshez. */
  const lunaTvTrackInfoRef = useRef<Map<string, EmbeddedSubtitle>>(new Map());
  /** A néző által kért élő felirat (nyelv szerint), hogy a TV listájának megérkeztekor újra érvényesíthessük. */
  const desiredLiveSubRef = useRef<{ id: string; lang: string; codec: string; ordinalInLang: number } | null>(null);
  const liveSubApplyingRef = useRef(false);
  /** A feliratméret refje (az élő újraérvényesítésből is elérhető). */
  const subtitleScaleRef = useRef(100);
  /**
   * SZOLGÁLTATÓI FELIRATOK (CC).
   *
   * A webOS csak a streambe muxolt feliratokat látja; a filmekhez tartozó
   * külön feliratfájlokat az Xtream válasza sorolja fel. Ezeket itt töltjük
   * be, és a lejátszó maga rajzolja ki (SubtitleOverlay) – így a régi webOS
   * Chromiumon is működik a felirat.
   */
  const [providerSubtitleTracks, setProviderSubtitleTracks] = useState<SubtitleTrack[]>(providedSubtitleTracks || []);
  /**
   * A fájlba muxolt (beágyazott) feliratsávok: MKV fejlécből / a TV
   * médiaszolgáltatásából. A webOS ezeket a `textTracks` listában nem teszi
   * közzé – ez volt az üres CC lista fő oka filmeknél.
   */
  const [embeddedSubtitleTracks, setEmbeddedSubtitleTracks] = useState<SubtitleTrack[]>([]);
  /** A TV (Luna) által kirajzolt beágyazott felirat van-e bekapcsolva. */
  const lunaSubtitleActiveRef = useRef(false);
  /** A beágyazott felirat automatikus (preferált nyelv) kiválasztása egyszer fut streamenként. */
  const embeddedAutoSelectKeyRef = useRef<string>('');
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
  // A React állapotát is a kilépett módhoz igazítjuk.
  useEffect(() => {
    const api = nativeApi();
    if (!api?.on) return;
    const handler = (event: { type?: string; mode?: string }) => {
      if (event?.type !== 'pip-mode' || event.mode !== 'exited') return;
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

  const [activeVodSubtitleId, setActiveVodSubtitleId] = useState<string | number | null>(null);
  const activeTvSubtitleIdRef = useRef<string | number | null>(null);
  // HTML5/webOS élő TV-n kézi feliratválasztás után ne írja felül azt az automata nyelvválasztás.
  const nativeAudioTrackSignatureRef = useRef('');
  const pendingTvAudioSelectionRef = useRef<{ index: number; startedAt: number } | null>(null);
  // HTML5/webOS hangsávváltáskor megőrizzük a kiválasztott sáv sorszámát,
  // hogy ha a TV csak újratöltés után érvényesíti, ugyanazt a sávot állítsuk vissza.
  const pendingHtmlAudioIndexRef = useRef<number | null>(null);
  const htmlAudioReloadingRef = useRef(false);
  /*
   * TÖRÖLT HALOTT KÓD: a Cast-állapot 2,5 másodpercenkénti lekérdezése.
   * A `nativeApi()` LG webOS-en mindig null (csak HTML5 videó van), így ez
   * az időzítő sosem futott, mégis minden újrarajzoláskor új state-et
   * tartott fenn. A Cast gomb ettől függetlenül megmaradt.
   */

  // A kék óra saját, izolált komponens (lásd BlueClock a fájl elején), hogy a
  // másodpercenkénti frissítése NE rajzolja újra az egész lejátszó felületet.
  //
  // Az EPG-haladássáv időzítője itt korábban másodpercenként futott, de az
  // értékét a felület sem használta - csak felesleges újrarajzolást okozott
  // másodpercenként, ezért megszűnt.

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
  // teljes képernyős váltáskor.
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
    /*
     * EGY MÉRÉS-LÁNC EGYSZERRE (2.5.141).
     *
     * A `syncAfterLayout` egy teljes láncot indít: azonnali mérés, majd három
     * további képkocka-mérés és négy késleltetett (80/180/350/600 ms) mérés.
     * Görgetéskor ez eddig MINDEN eseményre újraindult – a lista görgetése
     * közben másodpercenként több tucatszor futott le ugyanaz a nyolc
     * geometria-mérés, miközben az első lánc úgyis a végleges helyzetet
     * méri. Mostantól egy lánc van folyamatban; a futás közben érkező
     * kérések összeolvadnak vele.
     */
    let syncPending = false;
    const syncAfterLayout = () => {
      if (syncPending) return;
      syncPending = true;
      retryCount = 0;
      syncBounds();
      frame = window.requestAnimationFrame(() => {
        syncBounds();
        secondFrame = window.requestAnimationFrame(() => {
          syncBounds();
          thirdFrame = window.requestAnimationFrame(() => {
            syncBounds();
            syncPending = false;
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
    window.visualViewport?.addEventListener('resize', syncAfterLayout);
    /*
     * GÖRGETÉS: csak az OLDAL görgetése mozdíthatja a lejátszót. A
     * csatornalista a saját görgetőjében mozog, mégis – a rögzítési fázisú
     * (capture) figyelő miatt – eddig minden görgetett képkocka lefuttatta a
     * teljes geometria-mérést. Ez volt a főoldali lista görgetésének egyik
     * rejtett költsége; a belső görgetőket most kihagyjuk.
     */
    const onPageScroll = (event: Event) => {
      const target = event.target;
      if (target && target !== document && target !== document.documentElement && target !== document.body) return;
      syncAfterLayout();
    };
    window.addEventListener('scroll', onPageScroll, true);
    document.addEventListener('fullscreenchange', syncAfterLayout);
    document.addEventListener('visibilitychange', syncAfterLayout);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(secondFrame);
      window.cancelAnimationFrame(thirdFrame);
      settleTimers.forEach((t) => window.clearTimeout(t));
      syncPending = false;
      window.removeEventListener('resize', syncAfterLayout);
      window.visualViewport?.removeEventListener('resize', syncAfterLayout);
      window.removeEventListener('scroll', onPageScroll, true);
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
    setProviderSubtitleTracks(providedSubtitleTracks || []);
    setVodSubtitleTracks([]);
    setVodTrackMenu(null);
    setActiveVodSubtitleId(null);
    // Új filmnél a kézi sávválasztás is újraindul, hogy a Beállítások →
    // Mozi & Sorozat szerinti alapértelmezett (magyar) nyelv érvényesüljön.
    userVodAudioChoiceRef.current = null;
    userVodSubtitleChoiceRef.current = null;
    providerSubtitleActiveRef.current = false;
    lunaSubtitleActiveRef.current = false;
    embeddedAutoSelectKeyRef.current = '';
    setEmbeddedSubtitleTracks([]);
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
      setVodCurrentTime(position);
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
       * A forrás-újranyitás CSAK a felhasználó kézi hangsávváltásánál
       * engedélyezett. Az automatikus (magyar alapnyelv) választás korábban
       * minden többnyelvű filmnél 350 ms után újratöltötte a stream-et –
       * a play() ígéret emiatt AbortError-ral szakadt meg, a film pedig
       * percekre megállt. Az automata választásnál a sávlista `enabled`
       * bitinget használjuk, és NEM bontjuk le a futó lejátszást.
       */
      const allowReload = !vodAutoAudioSwitchRef.current;
      const generation = streamLoadGenerationRef.current;
      window.setTimeout(() => {
        if (!allowReload) return;
        if (generation !== streamLoadGenerationRef.current || video !== htmlVideoRef.current) return;
        const active = video.audioTracks;
        const applied = Boolean(active && active[index] && active[index].enabled);
        if (applied) return;
        const url = video.currentSrc || video.src || streamUrl;
        if (!url) return;
        const position = Math.max(Number(video.currentTime || 0), Number(vodLastPositionRef.current || 0));
        const wasPlaying = !video.paused;
        let restored = false;
        const restore = () => {
          if (restored) return;
          restored = true;
          try { video.removeEventListener('loadedmetadata', restore); } catch { /* régi motor */ }
          applyEnabled(video);
          try { video.currentTime = position; } catch { /* a TV motorja később állítja be */ }
          if (wasPlaying) void video.play().catch(() => undefined);
          setVodAudioTracks(readHtmlAudioTracks(video));
          endSwitch();
        };
        beginSwitch();
        video.addEventListener('loadedmetadata', restore);
        // Ha a webOS nem küld metaadatot, a lejátszás akkor se ragadjon le.
        window.setTimeout(() => {
          restore();
          try { video.removeEventListener('loadedmetadata', restore); } catch { /* régi motor */ }
        }, 6000);
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

  /*
   * Az élő feliratválasztás érvényesítése a TV médiaszolgáltatásán. A
   * szolgáltatás a TV saját listája alapján, nyelv szerint keresi meg a
   * sorszámot és köröket ismétel, amíg a TV vissza nem igazolja. Ha végül
   * sem sikerül, a választó ne mutassa bekapcsoltnak a sávot.
   */
  const applyLiveSubtitleSelection = (
    videoElement: HTMLVideoElement,
    request: LiveSubtitleRequest,
    selectionId: string,
  ) => {
    liveSubApplyingRef.current = true;
    void selectLiveSubtitle(videoElement, request, subtitleScaleRef.current).then((applied) => {
      liveSubApplyingRef.current = false;
      if (applied) return;
      if (desiredLiveSubRef.current?.id !== selectionId) return; // közben más kérés érkezett
      desiredLiveSubRef.current = null;
      lunaTvActiveRef.current = false;
      if (userTvSubtitleChoiceRef.current === selectionId) {
        userTvSubtitleChoiceRef.current = null;
        activeTvSubtitleIdRef.current = null;
      }
      setLunaTvSubtitleTracks((previous) => previous.map((item) => ({ ...item, selected: false })));
    });
  };

  const selectTvSubtitleRef = useRef<((track: SubtitleTrack | null) => void) | null>(null);
  const selectTvSubtitle = useCallback((track: SubtitleTrack | null) => {
    userTvSubtitleChoiceRef.current = track ? String(track.id) : 'off';
    const native = nativeApi();
    if (nativeHandoff && native) {
      const current = activeTvSubtitleIdRef.current != null ? Number(activeTvSubtitleIdRef.current) : NaN;
      if (track && Number.isFinite(Number(track.id))) {
        const targetId = Number(track.id);
        native.selectTrack?.('subtitle', targetId);
        appLog(`Élő felirat kiválasztása: sáv=${targetId}; visszaigazolásra vár.`);
      } else {
        native.deselectTrack?.('subtitle', Number.isFinite(current) ? current : -1);
        activeTvSubtitleIdRef.current = null;
        appLog('Élő felirat kikapcsolása kérve.');
      }
      return;
    }

    // LG webOS: élő adásnál a HTML5 TextTrackList a tényleges feliratsáv-forrás.
    const video = htmlVideoRef.current;
    if (!video) return;

    /*
     * TV ÁLTAL KIRAJZOLT ÉLŐ FELIRAT (Luna): a DVB/teletext feliratsávokat a
     * HTML5 textTracks nem sorolja fel – ezeket a TV médiaszolgáltatása
     * kapcsolja be és választja ki. A film/sorozat (VOD) úttól külön ág.
     */
    const lunaTvIndex = lunaTvIndexFromTrack(track);
    if (track && lunaTvIndex !== null) {
      try {
        const htmlList = video.textTracks;
        for (let i = 0; i < htmlList.length; i++) htmlList[i].mode = 'disabled';
        setTvSubtitleTracks(readHtmlSubtitleTracks(video));
      } catch { /* a HTML lista ürítése nem kritikus */ }
      lunaTvActiveRef.current = true;
      activeTvSubtitleIdRef.current = track.id;
      setLunaTvSubtitleTracks((previous) => previous.map((item) => ({
        ...item,
        selected: String(item.id) === String(track.id),
      })));
      appLog(`LG webOS élő felirat kiválasztva (TV): ${track?.lang || track?.name || 'Felirat'}.`);
      /*
       * A TV a saját listáját más sorrendben/sorszámozással ismerheti, mint
       * a stream fejlécéből olvasott (PMT) lista – ezért a választást nyelv
       * + nyelv szerinti sorszám alapján adjuk át, a szolgáltatás ebből
       * számolja a TV-beli sorszámot. A kérés megmarad, hogy a TV
       * listájának megérkeztekor újra érvényesíthető legyen.
       */
      const info = lunaTvTrackInfoRef.current.get(String(track.id));
      const wantLang = canonicalLiveLang(info?.lang || track.lang || '');
      let ordinalInLang = 0;
      [...lunaTvTrackInfoRef.current.values()]
        .sort((a, b) => a.lunaIndex - b.lunaIndex)
        .forEach((item) => {
          if (item.lunaIndex < lunaTvIndex && wantLang && canonicalLiveLang(item.lang) === wantLang) {
            ordinalInLang += 1;
          }
        });
      const request: LiveSubtitleRequest = {
        lang: info?.lang || track.lang || '',
        codec: info?.codec || '',
        indexHint: lunaTvIndex,
        ordinalInLang,
      };
      desiredLiveSubRef.current = {
        id: String(track.id),
        lang: request.lang || '',
        codec: request.codec || '',
        ordinalInLang,
      };
      applyLiveSubtitleSelection(video, request, String(track.id));
      return;
    }
    // Más választásnál (HTML sáv vagy kikapcsolás) a TV feliratát lekapcsoljuk.
    if (lunaTvActiveRef.current || desiredLiveSubRef.current) {
      lunaTvActiveRef.current = false;
      desiredLiveSubRef.current = null;
      setLunaTvSubtitleTracks((previous) => previous.map((item) => (
        item.selected ? { ...item, selected: false } : item
      )));
      void disableLiveSubtitle(video);
    }
    const list = video.textTracks;
    const index = track && Number.isInteger(Number(track.id)) ? Number(track.id) : null;
    if (index !== null && (index < 0 || index >= list.length)) {
      appLog(`Élő feliratváltás sikertelen: érvénytelen HTML5 sávindex=${index}.`);
      return;
    }
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
  selectTvSubtitleRef.current = selectTvSubtitle;
  subtitleScaleRef.current = Number(String(settings.subtitleSize || '100%').replace('%', '')) || 100;

  /*
   * Az élő CC-választó (zöld gomb) és az élő OSD CC ikon közös listája:
   * a HTML-feliratok és a TV által kirajzolt (DVB/teletext) feliratok együtt.
   * Ha van benne elem, az App élő OSD CC ikonja zöldre vált.
   */
  useEffect(() => {
    const combined: SubtitleTrack[] = [];
    const seenIds = new Set<string>();
    [...tvSubtitleTracks, ...lunaTvSubtitleTracks].forEach((item) => {
      const key = String(item.id);
      if (!seenIds.has(key)) {
        seenIds.add(key);
        combined.push(item);
      }
    });
    onSubtitleTracksChange?.(combined);
  }, [tvSubtitleTracks, lunaTvSubtitleTracks, onSubtitleTracksChange]);

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
        list[i].mode = index !== null && i === index ? 'hidden' : 'disabled';
      }
      setVodSubtitleTracks(readHtmlSubtitleTracks(video));
      return true;
    } catch (error) {
      appLog('Film feliratváltási hiba: ' + String(error));
      return false;
    }
  };

  /** A muxolt (HTML) + beágyazott (Luna) + szolgáltatói feliratok együtt (ezt látja az OSD). */
  const availableVodSubtitleTracks = useMemo<SubtitleTrack[]>(() => [
    ...vodSubtitleTracks,
    ...embeddedSubtitleTracks.filter((embedded) =>
      !vodSubtitleTracks.some((track) => String(track.id) === String(embedded.id))),
    ...providerSubtitleTracks.filter((provider) =>
      !vodSubtitleTracks.some((track) => String(track.id) === String(provider.id))
      && !embeddedSubtitleTracks.some((track) => String(track.id) === String(provider.id))),
  ].map((track) => ({ ...track, selected: activeVodSubtitleId != null && String(track.id) === String(activeVodSubtitleId) })),
  [vodSubtitleTracks, embeddedSubtitleTracks, providerSubtitleTracks, activeVodSubtitleId]);

  const selectVodSubtitleRef = useRef<((track: SubtitleTrack | null) => void) | null>(null);
  const selectVodSubtitle = (track: SubtitleTrack | null) => {
    userVodSubtitleChoiceRef.current = track ? String(track.id) : 'off';
    /*
     * BEÁGYAZOTT FELIRAT (a fájlba muxolt sáv): a TV médiaszolgáltatása
     * kapcsolja be és rajzolja ki – a HTML <video> ezeket a sávokat nem
     * teszi közzé, ezért a textTracks kapcsolása itt nem működne.
     */
    const lunaIndex = lunaIndexFromTrack(track);
    if (track && lunaIndex !== null) {
      providerSubtitleActiveRef.current = false;
      lunaSubtitleActiveRef.current = true;
      switchHtmlVodSubtitle(null);
      setActiveVodSubtitleId(track.id);
      setVodSubtitleCues([]);
      setVodTrackMenu(null);
      appLog(`Film felirat kiválasztva: beágyazott sáv=${track.name || track.lang || track.id}.`);
      const scalePercent = Number(String(settings.subtitleSize || '100%').replace('%', '')) || 100;
      const selectionVideo = htmlVideoRef.current;
      const selectionGeneration = streamLoadGenerationRef.current;
      void selectEmbeddedSubtitle(selectionVideo, lunaIndex, scalePercent).then((applied) => {
        if (selectionGeneration !== streamLoadGenerationRef.current || selectionVideo !== htmlVideoRef.current) return;
        // Egy korábbi, még folyamatban lévő Luna-bekapcsolás a kikapcsolás
        // után érhet célba. Ilyenkor ismét tiltsuk le, de csak ugyanazon filmnél.
        if (!lunaSubtitleActiveRef.current) {
          void disableEmbeddedSubtitle(selectionVideo);
        }
        if (!applied && userVodSubtitleChoiceRef.current === String(track.id)) {
          // A TV nem kapcsolta be: az OSD ne mutassa bekapcsoltnak, és a
          // sikertelen próbálkozás ne zárja el a többi feliratforrást sem.
          lunaSubtitleActiveRef.current = false;
          userVodSubtitleChoiceRef.current = null;
          setActiveVodSubtitleId(null);
        }
      });
      return;
    }
    // Bármilyen más választásnál a TV beágyazott feliratát ki kell kapcsolni,
    // különben a kép felett tovább látszana az előző sáv.
    if (lunaSubtitleActiveRef.current) {
      lunaSubtitleActiveRef.current = false;
      void disableEmbeddedSubtitle(htmlVideoRef.current);
    }
    // SZOLGÁLTATÓI FELIRAT: letöltjük, és a lejátszó rajzolja ki.
    if (track?.url) {
      providerSubtitleActiveRef.current = true;
      switchHtmlVodSubtitle(null);
      setActiveVodSubtitleId(track.id);
      setVodSubtitleCues([]);
      setVodTrackMenu(null);
      appLog(`Film felirat kiválasztva: szolgáltatói sáv=${track.name || track.lang || track.id}.`);
      void loadSubtitleCues(track.urls && track.urls.length > 0 ? track.urls : track.url).then((cues) => {
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
      if (event.type && /^(playing|buffering-start|buffering-end|error|closed)$/.test(event.type)) speedStep('natív média ' + event.type, `playing=${event.playing ?? 'n/a'}; hiba=${event.type === 'error' ? (event.message || 'ismeretlen') : 'nincs'}`);
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
    video.addEventListener('loadeddata', refreshHtmlAudioTracks);
    video.addEventListener('durationchange', refreshHtmlAudioTracks);
    video.addEventListener('canplay', refreshHtmlAudioTracks);
    video.addEventListener('playing', refreshHtmlAudioTracks);
    // Az AudioTrackList esemény támogatása webOS-verziónként eltérő. A
    // korábbi 1 mp-es, állandó polling ezért fölöslegesen futott akkor is,
    // amikor a TV egyáltalán nem adott hangsávlistát. Események + négy
    // egyszeri indulási ellenőrzés ugyanazt a későn érkező listát kezeli,
    // de nem terheli a dekódert a teljes adás alatt.
    const delayedChecks = [250, 750, 1500, 3000].map((delay) => window.setTimeout(refreshHtmlAudioTracks, delay));
    return () => {
      delayedChecks.forEach((timer) => window.clearTimeout(timer));
      video.removeEventListener('loadedmetadata', refreshHtmlAudioTracks);
      video.removeEventListener('loadeddata', refreshHtmlAudioTracks);
      video.removeEventListener('durationchange', refreshHtmlAudioTracks);
      video.removeEventListener('canplay', refreshHtmlAudioTracks);
      video.removeEventListener('playing', refreshHtmlAudioTracks);
    };
  }, [nativeHandoff, streamUrl]);

  /*
   * FILM / SOROZAT – HTML5 feliratsávok figyelése.
   * Kizárólag a VOD saját textTracks listáját frissíti, az élő TV CC-jétől külön.
   * Eseményvezérelt, pár egyszeri késleltetett ellenőrzéssel; nincs 750 ms-os polling.
   */
  useEffect(() => {
    if (!isVod || nativeHandoff) return;
    const video = htmlVideoRef.current;
    if (!video) return;
    const textTracks = video.textTracks;
    const refresh = () => {
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
      // Bekapcsolt beágyazott (Luna) feliratnál se írja felül az aktív jelölést.
      if (!lunaSubtitleActiveRef.current) {
      if (!providerSubtitleActiveRef.current) {
        setActiveVodSubtitleId((previous) => {
          const next = active ? active.id : null;
          return String(previous ?? '') === String(next ?? '') ? previous : next;
        });
      }
      }
    };
    refresh();
    video.addEventListener('loadedmetadata', refresh);
    video.addEventListener('loadeddata', refresh);
    video.addEventListener('canplay', refresh);
    video.addEventListener('playing', refresh);
    const delayedChecks = [250, 750, 1500, 3000].map((delay) => window.setTimeout(refresh, delay));
    try {
      textTracks?.addEventListener?.('addtrack', refresh);
      textTracks?.addEventListener?.('removetrack', refresh);
      textTracks?.addEventListener?.('change', refresh);
    } catch { /* régebbi webOS: az egyszeri késleltetett ellenőrzések megmaradnak */ }
    return () => {
      delayedChecks.forEach((timer) => window.clearTimeout(timer));
      video.removeEventListener('loadedmetadata', refresh);
      video.removeEventListener('loadeddata', refresh);
      video.removeEventListener('canplay', refresh);
      video.removeEventListener('playing', refresh);
      try {
        textTracks?.removeEventListener?.('addtrack', refresh);
        textTracks?.removeEventListener?.('removetrack', refresh);
        textTracks?.removeEventListener?.('change', refresh);
      } catch { /* régebbi webOS */ }
    };
  }, [isVod, nativeHandoff, streamUrl]);



  /*
   * TÁVIRÁNYÍTÓ: ZÖLD – közös hangsáv- és feliratválasztó film közben.
   *
   * A webos.js a színes gombot minden fókuszhelyzetben elkapja, ezért a
   * lejátszó külön eseményt kap – az egyesített választó akkor is kinyílik,
   * ha az OSD éppen rejtve volt.
   */
  useEffect(() => {
    if (!isVod) return;
    const onVodMenu = (event: Event) => {
      const menu = (event as CustomEvent)?.detail?.menu;
      if (menu !== 'combined') return;
      setVodTrackMenu(menu);
      setShowControlsOverlay(true);
      setVodOsdActivity((value) => value + 1);
      /*
       * FELIRAT választó megnyitása üres listával = kézi újrapróbálkozás.
       * Előfordulhat, hogy az induló keresés hálózati időtúllépésbe futott;
       * ilyenkor a néző ne maradjon felirat nélkül task nélkül.
       */
      if (vodSubtitleTracks.length === 0 && providerSubtitleTracks.length === 0) {
        appLog('Felirat választó: nincs sáv – a szolgáltatói feliratkeresés újraindul.');
        providerSubtitleRequestRef.current = '';
        setSubtitleSearchNonce((value) => value + 1);
      }
    };
    window.addEventListener('iptv-vod-menu', onVodMenu);
    return () => window.removeEventListener('iptv-vod-menu', onVodMenu);
  }, [isVod, vodSubtitleTracks.length, providerSubtitleTracks.length]);

  /*
   * VOD-feliratok: kizárólag a már letöltött és mentett sávlista használható.
   * Lejátszás indításakor NEM kérünk új get_vod_info / get_series_info választ.
   * A mentett feliratfájlt a néző kiválasztásakor tölti be a felirat-olvasó.
   */
  useEffect(() => {
    if (!isVod) return;
    setVodSubtitleCues([]);
  }, [isVod, streamUrl, subtitleSource, subtitleSearchNonce]);

  /*
   * BEÁGYAZOTT FELIRATOK (CC) felderítése a film fájljából.
   *
   * A VOD fájlok felirata szinte mindig a konténerben (MKV) van, amit a
   * webOS HTML5 lejátszója nem tesz közzé – ezért a fejlécből olvassuk ki a
   * sávokat. Ha a fejlécből nem derül ki semmi, a TV médiaszolgáltatásának
   * sourceInfo eseménye a tartalék. A keresés kézi újraindítását ugyanaz a
   * nonce végzi, mint a szolgáltatói feliratokét (üres CC-menü megnyitása).
   */
  useEffect(() => {
    if (!isVod) return;
    let cancelled = false;
    let cancelSourceInfo: (() => void) | null = null;
    setEmbeddedSubtitleTracks([]);
    const timer = window.setTimeout(() => {
      void probeEmbeddedSubtitles(streamUrl).then((list) => {
        if (cancelled) return;
        if (list.length > 0) {
          setEmbeddedSubtitleTracks(list.map(embeddedToSubtitleTrack));
          return;
        }
        cancelSourceInfo = subscribeSourceInfoSubtitles(htmlVideoRef.current, (tracks) => {
          if (!cancelled && tracks.length > 0) {
            setEmbeddedSubtitleTracks(tracks.map(embeddedToSubtitleTrack));
          }
        });
      });
    }, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      cancelSourceInfo?.();
    };
  }, [isVod, streamUrl, subtitleSearchNonce]);

  /*
   * BEÁGYAZOTT FELIRAT – automatikus kiválasztás a beállított nyelv szerint.
   * Külön, egyszer futó lépés, hogy a muxolt/szolgáltatói automatikus
   * választás meglévő menete változatlan maradjon; kézi választást sosem
   * ír felül, és csak akkor lép, ha még semmilyen felirat nem aktív.
   */
  useEffect(() => {
    if (!isVod || embeddedSubtitleTracks.length === 0) return;
    const signature = embeddedSubtitleTracks.map((track) => `${track.id}:${track.lang}:${track.name}`).join('|');
    const key = `${streamUrl}~${settings.preferredSubtitle}~${signature}`;
    if (key === embeddedAutoSelectKeyRef.current) return;
    embeddedAutoSelectKeyRef.current = key;
    if (userVodSubtitleChoiceRef.current !== null) return;
    if (lunaSubtitleActiveRef.current || providerSubtitleActiveRef.current || vodSubtitleCues.length > 0) return;
    if (vodSubtitleTracks.some((track) => track.selected === true)) return;
    const savedSubtitlePreference = (settings.preferredSubtitle || 'Magyar').trim();
    const preferred = /^kikapcsolva$/i.test(savedSubtitlePreference) ? 'Magyar' : savedSubtitlePreference;
    const preferredTrack = findPreferredVodTrack(embeddedSubtitleTracks, preferred)
      || (embeddedSubtitleTracks.length === 1 ? embeddedSubtitleTracks[0] : null);
    if (preferredTrack) {
      selectVodSubtitleRef.current?.(preferredTrack);
      appLog(`Automatikus beágyazott felirat: ${preferredTrack.lang || preferredTrack.name} (beállítás: ${preferred}).`);
    } else if (embeddedSubtitleTracks.length > 1) {
      appLog(`Beágyazott felirat: nincs „${preferred}” sáv (${embeddedSubtitleTracks.map((track) => track.lang || track.name).join(', ')}); a CC gombbal választható.`);
    }
  }, [isVod, streamUrl, embeddedSubtitleTracks, vodSubtitleTracks, vodSubtitleCues.length, settings.preferredSubtitle]);

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
        // Automatikus választás: a hangsávlista közvetlen kapcsolása, a
        // lejátszás újranyitása NÉLKÜL (a film nem állhat meg).
        vodAutoAudioSwitchRef.current = true;
        try { switchHtmlVodAudio(Number(preferredAudio.id)); }
        finally { vodAutoAudioSwitchRef.current = false; }
        appLog(`Automatikus film-hangsáv: ${preferredAudio.lang || preferredAudio.name} (beállítás: ${settings.preferredAudioLang}).`);
        return; // a frissült sávlista alapján a felirat a következő körben jön
      }
    }

    // 2) FELIRAT: a kézi választást és a már bekapcsolt feliratot nem írjuk felül.
    // Régi mentett „Kikapcsolva” alapbeállítást továbbra is Magyar nyelvként
    // kezelünk; a lejátszás közben kézzel kért kikapcsolást nem írjuk felül.
    const savedSubtitlePreference = (settings.preferredSubtitle || 'Magyar').trim();
    const preferredSubtitle = /^kikapcsolva$/i.test(savedSubtitlePreference)
      ? 'Magyar'
      : savedSubtitlePreference;
    if (userVodSubtitleChoiceRef.current !== null) return;
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

    // 2b) A mentett szolgáltatói feliratfájlt NEM töltjük le automatikusan
    // lejátszás indításakor. A néző a CC menüben választhatja ki; a fájletöltés
    // csak ekkor, kézi választásra indul.
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

  // Natív tartalékút: az aktuális feliratsávokat beolvassuk, de nem választunk automatikusan.
  // A lejátszó állapot-eseményei frissítik a listát; nincs folyamatos CC-lekérdezés.
  useEffect(() => {
    if (!nativeHandoff || isVod) return;
    const api = nativeApi();
    if (!api?.mediaTracks) return;
    const tracks = readNativeMediaTracks(api).filter((track) => track.type === 'subtitle');
    const mapped: SubtitleTrack[] = tracks.map((track) => ({
      id: track.index,
      name: track.name || track.lang || 'Felirat',
      lang: track.lang || '',
      selected: track.selected === true,
    }));
    setTvSubtitleTracks((previous) => previous.length === mapped.length && previous.every((track, index) =>
      String(track.id) === String(mapped[index]?.id) && track.name === mapped[index]?.name &&
      track.lang === mapped[index]?.lang && track.selected === mapped[index]?.selected
    ) ? previous : mapped);
    activeTvSubtitleIdRef.current = mapped.find((track) => track.selected === true)?.id ?? null;
  }, [nativeHandoff, isVod, streamUrl]);

  /*
   * LG webOS – élő TV feliratsávok.
   * Csak az elérhető sávokat olvassuk; nincs automatikus nyelvválasztás és polling.
   * Események + néhány egyszeri késleltetett ellenőrzés kezelik a későn megjelenő listát.
   */
  useEffect(() => {
    if (nativeHandoff || isVod) return;
    const video = htmlVideoRef.current;
    if (!video) return;
    const textTracks = video.textTracks;
    const refresh = () => {
      const mapped = readHtmlSubtitleTracks(video);
      setTvSubtitleTracks((previous) => previous.length === mapped.length && previous.every((track, index) =>
        String(track.id) === String(mapped[index]?.id) &&
        track.name === mapped[index]?.name &&
        track.lang === mapped[index]?.lang &&
        track.selected === mapped[index]?.selected
      ) ? previous : mapped);
      activeTvSubtitleIdRef.current = mapped.find((track) => track.selected === true)?.id ?? null;
    };
    refresh();
    video.addEventListener('loadedmetadata', refresh);
    video.addEventListener('loadeddata', refresh);
    video.addEventListener('canplay', refresh);
    video.addEventListener('playing', refresh);
    try {
      textTracks?.addEventListener?.('addtrack', refresh);
      textTracks?.addEventListener?.('removetrack', refresh);
      textTracks?.addEventListener?.('change', refresh);
    } catch { /* régebbi webOS */ }
    const delayedChecks = [250, 750, 1500, 3000].map((delay) => window.setTimeout(refresh, delay));
    return () => {
      delayedChecks.forEach((timer) => window.clearTimeout(timer));
      video.removeEventListener('loadedmetadata', refresh);
      video.removeEventListener('loadeddata', refresh);
      video.removeEventListener('canplay', refresh);
      video.removeEventListener('playing', refresh);
      try {
        textTracks?.removeEventListener?.('addtrack', refresh);
        textTracks?.removeEventListener?.('removetrack', refresh);
        textTracks?.removeEventListener?.('change', refresh);
      } catch { /* régebbi webOS */ }
    };
  }, [nativeHandoff, isVod, streamUrl]);

  /*
   * ÉLŐ ADÁS FELIRATSÁVJAINAK LISTÁZÁSA (TV médiaszolgáltatás + stream fejléc).
   *
   * A HTML5 textTracks az élő DVB/teletext feliratot nem sorolja fel – ugyanaz
   * a hiba, mint filmeknél volt: üres a CC-lista, választani sem lehet. Itt
   * előbb a TV médiaszolgáltatását kérdezzük (extra hálózati forgalom nélkül),
   * ha néhány másodpercen belül nincs válasz, a stream elejéből olvassuk ki a
   * feliratsávokat. Csak élő TV-n fut, a film/sorozat út érintetlen.
   */
  useEffect(() => {
    if (isVod || nativeHandoff || !streamUrl) return undefined;
    const video = htmlVideoRef.current;
    if (!video) return undefined;
    let cancelled = false;
    setLunaTvSubtitleTracks([]);
    lunaTvTrackInfoRef.current = new Map();
    const registerLunaTvTrackInfo = (tracks: EmbeddedSubtitle[]) => {
      const infoMap = new Map<string, EmbeddedSubtitle>();
      tracks.forEach((track) => infoMap.set(`luna-tv:${track.lunaIndex}`, track));
      lunaTvTrackInfoRef.current = infoMap;
    };
    const unsubscribe = subscribeLiveSubtitleTracks(video, (tracks) => {
      if (cancelled) return;
      registerLunaTvTrackInfo(tracks);
      const desired = desiredLiveSubRef.current;
      setLunaTvSubtitleTracks((previous) => tracks.map((track, position) => {
        let selected = previous.some((item) => item.selected
          && lunaTvIndexFromTrack(item) === track.lunaIndex);
        if (!selected && desired) {
          // A kért feliratot nyelv + nyelv szerinti sorszám alapján jelöljük
          // az új listában is (a TV sorrendje eltérhet a fejléc-listáétól).
          const want = canonicalLiveLang(desired.lang);
          if (want && canonicalLiveLang(track.lang) === want) {
            const ordinal = tracks
              .slice(0, position)
              .filter((item) => canonicalLiveLang(item.lang) === want).length;
            selected = ordinal === desired.ordinalInLang;
          }
        }
        return { ...lunaTvToSubtitleTrack(track), selected };
      }));
      /*
       * Ha a néző már választott (például a fejlécből olvasott listából),
       * a TV saját listájának megérkeztekor a választást újra
       * érvényesítjük – ekkor már a TV számozása alapján.
       */
      if (desired && !liveSubApplyingRef.current) {
        const want = canonicalLiveLang(desired.lang);
        const matches = tracks.filter((track) => want && canonicalLiveLang(track.lang) === want);
        const pick = matches.length > 0
          ? matches[Math.min(desired.ordinalInLang, matches.length - 1)]
          : null;
        applyLiveSubtitleSelection(video, {
          lang: desired.lang,
          codec: desired.codec,
          indexHint: pick ? pick.lunaIndex : 0,
          ordinalInLang: desired.ordinalInLang,
        }, desired.id);
      }
    });
    const probeTimer = window.setTimeout(() => {
      // Csak akkor indítjuk el a hálózati sávfejléc-beolvasást, ha a lejátszás elindult,
      // így a probe kérés nem verseng az első videószegmensek letöltésével.
      if (!playbackStartedRef.current) return;
      setLunaTvSubtitleTracks((previous) => {
        if (previous.length === 0) {
          void probeLiveSubtitles(streamUrl).then((tracks) => {
            if (cancelled || tracks.length === 0) return;
            setLunaTvSubtitleTracks((current) => {
              if (current.length !== 0) return current;
              registerLunaTvTrackInfo(tracks);
              return tracks.map(lunaTvToSubtitleTrack);
            });
          }).catch(() => { /* a fejléc nem olvasható: marad a HTML lista */ });
        }
        return previous;
      });
    }, 3500);
    return () => {
      cancelled = true;
      window.clearTimeout(probeTimer);
      if (unsubscribe) try { unsubscribe(); } catch { /* ignore */ }
    };
  }, [nativeHandoff, isVod, streamUrl]);

  /*
   * Élő adás alapértelmezett felirata: a beállításokbeli nyelv (magyar, ha a
   * beállítás kikapcsolt) egyszer, csatornánként – csak akkor, ha a néző még
   * nem választott magának ezen a legutóbbi csatornaváltáson.
   */
  useEffect(() => {
    if (isVod || nativeHandoff || !streamUrl) return;
    if (userTvSubtitleChoiceRef.current !== null) return;
    const available = [...lunaTvSubtitleTracks, ...tvSubtitleTracks];
    if (available.length === 0 || available.some((item) => item.selected)) return;
    const key = `${streamUrl}|${available.map((item) => String(item.id)).join(',')}`;
    if (liveAutoSubtitleKeyRef.current === key) return;
    const preferred = (settings.preferredSubtitle || '').trim();
    const effectivePreferred = !preferred || preferred.toLowerCase() === 'kikapcsolva'
      ? 'Magyar'
      : preferred;
    const choice = findPreferredVodTrack(available, effectivePreferred);
    liveAutoSubtitleKeyRef.current = key;
    if (!choice) return;
    appLog(`LG webOS élő felirat: alapértelmezett nyelv kiválasztva: ${choice.lang || choice.name || 'Felirat'}.`);
    selectTvSubtitleRef.current?.(choice);
  }, [isVod, nativeHandoff, streamUrl, lunaTvSubtitleTracks, tvSubtitleTracks, settings.preferredSubtitle]);

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
  /*
   * FUTÓ ADÁS VÉDELME (2.5.165).
   *
   * A 21. napló: a [HU] EPIC DRAMA UHD már JÁTSZOTT (2753 ms), majd 1,5 mp
   * múlva a lejátszó `abort` + `emptied` eseményt adott, és ugyanaz a
   * csatorna teljesen újraindult – összesen 23 069 ms lett a váltás. Az ok:
   * a teljes élő lista háttér-visszatöltése kicserélte a csatornaobjektumot,
   * amiből a lejátszó új stream-címet kapott. Egy MÁR FUTÓ adást nem szabad
   * újraindítani csak azért, mert a lista frissült: a `lastPlayedRef` a
   * tényleg elindult adást tartja nyilván, és a betöltő hatás ezt kihagyja.
   */
  const lastLoadRef = useRef<{ channelId?: string; url: string } | null>(null);
  const lastPlayedRef = useRef<{ channelId?: string; url: string } | null>(null);

  const clearZapWatchdog = useCallback(() => {
    if (zapWatchdogRef.current !== null) {
      window.clearTimeout(zapWatchdogRef.current);
      zapWatchdogRef.current = null;
    }
  }, []);

  // Egyetlen lejátszómotor: LG webOS-en a TV HTML5/HLS videóeleme játssza le az adatfolyamot.
  const loadStream = useCallback((url: string, forceReload = false) => {
    // A lejátszási szándékot a forrásváltás végéig zároljuk.
    beginSwitch();
    // Az előző adást azonnal megállítjuk, és elvetjük az esetleges régi időzítőt.
    // Nincs fix 300 ms-os csatornaváltási késleltetés: a legfrissebb kérés indul.
    if (pendingLiveLoadTimerRef.current !== null) {
      window.clearTimeout(pendingLiveLoadTimerRef.current);
      pendingLiveLoadTimerRef.current = null;
    }
    // Élő csatornaváltáskor nem állítjuk le külön a régi videót:
    // az új src közvetlen beállítása megszakítja a régi forrást. A külön
    // pause() fölösleges médiaállapot-váltást és késői pause eseményt okozhat
    // a webOS-en, ezért a gyors zap útvonalból kihagyjuk.
    const loadGeneration = ++streamLoadGenerationRef.current;
    const isCurrentLoad = () => loadGeneration === streamLoadGenerationRef.current;
    clearZapWatchdog();
    clearBufferWatchdog();
    playbackStartedRef.current = false;
    setTvAudioTracks([]);
    setTvSubtitleTracks([]);
    setLunaTvSubtitleTracks([]);
    activeTvSubtitleIdRef.current = null;
    lunaTvActiveRef.current = false;
    userTvSubtitleChoiceRef.current = null;
    liveAutoSubtitleKeyRef.current = '';
    lunaTvTrackInfoRef.current = new Map();
    desiredLiveSubRef.current = null;
    liveSubApplyingRef.current = false;
    nativeAudioTrackSignatureRef.current = '';
    userAudioChoiceRef.current = null;
    setShowTvAudioMenu(false);
    setIsLoading(true);
    setHasError(false);
    setErrorMessage('');
    setNativeHandoff(false);
    activeMediaUrlRef.current = url;
    lastLoadRef.current = { channelId: channelRef.current?.id, url };
    if (!url) {
      activeMediaUrlRef.current = '';
      endSwitch();
      setIsLoading(false);
      setHasError(true);
      setErrorMessage('Nincs lejátszható adatfolyam.');
      return;
    }
    const api = nativeApi();
    if (api?.play) {
      handOverToNative(url);
      endSwitch();
      return;
    }

    // LG webOS: lejátszás a TV HTML5/HLS videóelemével.
    const video = htmlVideoRef.current;
    // Élő adás csak akkor indul, ha a főoldal (élő nézet) látszik. A korábbi
    // ág itt hagyta az isLoading=true állapotot, ezért nézetváltás vagy import
    // közben végtelen töltő maradhatott a lejátszón.
    const livePlaybackInactive = !isVod && !playbackActiveRef.current;
    if (livePlaybackInactive) {
      activeMediaUrlRef.current = '';
      setIsLoading(false);
      setIsRecovering(false);
    }
    if (!isVod && !playbackActiveRef.current) { endSwitch(); return; }
    if (!video) {
      endSwitch();
      setIsLoading(false);
      setHasError(true);
      setErrorMessage('Az LG webOS videóelem még nem áll készen.');
      return;
    }
    try {
      if (!customStreamUrl) {
        const channelName = String(channel?.name || 'Ismeretlen csatorna');
        const channelId = String(channel?.id ?? channelName);
        const previousDiagnostic = channelSwitchDiagnosticRef.current;
        const sequence = liveRetrySequenceRef.current;
        // A recovery/fallback ugyanahhoz a nézői csatornaváltáshoz tartozik.
        // Ne jelenjen meg minden automatikus src-újratöltés új „START”-ként:
        // a #15-ben ez 64 indítási sort és felesleges logzajt adott, miközben
        // a néző ennél jóval kevesebb csatornaváltást kért.
        const isRecoveryAttempt = Boolean(
          !isVodRef.current && (forceReload || liveRecoveryOnlyRef.current || sequence.index > 0)
        );
        const isSameSwitch = Boolean(
          previousDiagnostic &&
          previousDiagnostic.channelId === channelId &&
          !previousDiagnostic.completed &&
          !previousDiagnostic.summaryLogged
        );
        const now = Date.now();
        const diagnostic = {
          generation: loadGeneration,
          startedAt: isSameSwitch ? previousDiagnostic!.startedAt : now,
          attemptStartedAt: now,
          attemptNumber: Math.max(1, liveRetrySequenceRef.current.index + 1),
          loadCount: isSameSwitch ? previousDiagnostic!.loadCount + 1 : 1,
          channelId,
          channelName,
          waitingLogged: false,
          canPlayLogged: false,
          completed: false,
          firstFrameLogged: false,
          lastProgressAt: 0,
          lastBufferedEnd: 0,
          lastTimelineLogAt: 0,
          lastTimelineTime: null,
          lastTimelineDuration: null,
          timelineEvents: 0,
          summaryLogged: false,
        };
        channelSwitchDiagnosticRef.current = diagnostic;

      } else {
        doctorSessionRef.current.vodLoadStartedAt = Date.now();
      }
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
      const hadMediaError = Boolean(video.error);
      if (hadMediaError) {
        try {
          // A régi hibás forrást leválasztjuk, de a fallbacknél nem hívunk
          // külön load()-ot: az alternatív címmel együtt egyetlen teljes
          // újratöltés elég, így a webOS nem kap két egymás utáni resetet.
          video.removeAttribute('src');
          appLog('Lejátszó hibaállapot törlése a csatornaváltás előtt (a forrás lebontása).');
        } catch { /* régi motor */ }
      }
      // GYORS VÁLTÁS: a `src` felülírása megszakítja a régi adást, csak
      // a valóban szükséges fallback/recovery esetén indítunk teljes load()-ot.
      // A webOS HTML5 videóelemét használjuk. Élő adásnál legfeljebb két
      // külön formátum-próba van; a további indításokat a recovery időzíti.
      video.src = url;
      // UGYANAZ a cím az újracsatlakozásnál: a TV médiamotorja ilyenkor nem
      // mindig indít új kérést, ezért kifejezetten újratöltjük. Ha egy régi
      // hibaállapotot bontottunk le, az új címhez ugyanígy teljes reset kell.
      if (forceReload || hadMediaError) video.load();
      // A src beállítása elindítja a HTML5 betöltést; a külön load() újabb resetet okozhat.
      video.volume = Math.max(0, Math.min(1, volume));
      applyMuteState(video, volume);
      const playObserver = speedAttemptObserver();
      const playPromise = video.play();
      // A stream indítása elsőbbséget kap; a naplózás csak a play() meghívása után fut.
      speedLoad(isVodRef.current ? 'VOD' : 'élő', `forceReload=${forceReload}; formátum=${formatOfUrl(url) || 'egyéb'}`, url);
      speedStep('src beállítva', `load()=${forceReload || hadMediaError ? 'igen' : 'nem'}`);
      speedStep('play() meghívva');
      if (!customStreamUrl) {
        const channelName = String(channel?.name || 'Ismeretlen csatorna');
        const diagnostic = channelSwitchDiagnosticRef.current;
        const sequence = liveRetrySequenceRef.current;
        const isRecoveryAttempt = Boolean(
          !isVodRef.current && (forceReload || liveRecoveryOnlyRef.current || sequence.index > 0)
        );
        const channelMemory = rememberedFormatFor(channel?.id);
        const timing = bufferTiming();
        const startLabel = isRecoveryAttempt ? 'ÉLŐ ÚJRACSATLAKOZÁSI PRÓBA' : 'CSATORNAVÁLTÁS START';
        const verboseStartLabel = isRecoveryAttempt ? 'ÉLŐ ÚJRACSATLAKOZÁSI PRÓBA START' : 'CSATORNAVÁLTÁS PRÓBA START';
        appLog(`${startLabel}; csatorna=${channelName.slice(0, 100)}; stream=${/\\.m3u8(?=([?#]|$))/i.test(url) ? 'HLS' : /\\.ts(?=([?#]|$))/i.test(url) ? 'MPEG-TS' : 'egyéb'}; beállított-lejátszó=${playerEngine}; tényleges-lejátszó=${api?.play ? 'natív híd' : 'HTML5 video (natív híd nem elérhető)'}; pufferprofil=${bufferModeRef.current}; indulási-őr=${timing.startupWatchdogMs} ms; lejátszás-őr=${timing.bufferWatchdogMs} ms; puffer-cél=${timing.minBufferAheadSeconds.toFixed(1)} s; formátum-emlék=${channelMemory || 'nincs'}; kézi-formátum=${settings.streamFormat || 'ts'}; tartalék=${liveFallbackRef.current ? liveFallbackRef.current.format.toUpperCase() : 'nincs'}; ${videoDiagnosticState(video, 'betöltés után')}`);
        if (diagnostic && isVerbosePlaybackLogging()) {
          appLog(`${verboseStartLabel}; csatorna=${channelName.slice(0, 100)}; próba=${diagnostic.attemptNumber}/${Math.max(1, sequence.urls.length)}; formátum=${formatOfUrl(url)?.toUpperCase() || 'ismeretlen'}; teljes-eltelt=${Date.now() - diagnostic.startedAt} ms; ${videoDiagnosticState(video, 'próba betöltés után')}`);
        }
      }
      if (playObserver && playPromise && typeof playPromise.then === 'function') {
        void playPromise.then(
          () => playObserver('play() ígéret teljesült'),
          (error: unknown) => {
            const name = error && typeof error === 'object' && 'name' in error ? String(error.name).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) : 'ismeretlen';
            playObserver('play() ígéret elutasítva', `hiba=${name}`);
          },
        );
      }
      setIsPlaying(true);
      if (!customStreamUrl) {
        const isRecAttempt = Boolean(
          !isVodRef.current && (forceReload || liveRecoveryOnlyRef.current || liveRetrySequenceRef.current.index > 0)
        );
        if (!isRecAttempt && !doctorSessionRef.current.repairInFlight) {
          const docState = doctorSessionRef.current;
          const fmtLabel = formatOfUrl(url)?.toUpperCase() || 'MPEG-TS';
          const chTitle = String(channel?.name || 'Csatorna').slice(0, 34);
          showDoctorStatus({
            phase: 'loading',
            title: 'Csatorna betöltése',
            detail: docState.hasLearnedProfile
              ? `Mentett profil (${DOCTOR_BUFFER_CONFIGS[docState.activeBufferProfile].label}, ${fmtLabel})…`
              : `${chTitle} vizsgálata és indítása…`,
          });
        }
      } else if (!doctorSessionRef.current.repairInFlight) {
        const docState = doctorSessionRef.current;
        const vodTarget = buildVodDoctorTarget(url);
        const vodKindLabel = vodTarget.mediaKind === 'series' ? 'Sorozat betöltése' : 'Film betöltése';
        showDoctorStatus({
          phase: 'loading',
          title: vodKindLabel,
          detail: docState.hasLearnedProfile
            ? `Mentett stabil profil (${DOCTOR_BUFFER_CONFIGS[docState.activeBufferProfile].label})…`
            : 'Adatfolyam vizsgálata és indítása…',
        });
      }
      // ZAP-ŐR: ha az élő adás nem indul el időben (a HLS-próba csak "lóg",
      // se hiba, se kép), nem várunk a végtelenségig pörgő töltésre -
      // automatikusan a következő formátumra (MPEG-TS) váltunk.
      if (!customStreamUrl) {
        const { startupWatchdogMs } = bufferTiming();
        const attemptTimeoutMs = Math.min(startupWatchdogMs, 2000);
        zapWatchdogRef.current = window.setTimeout(() => {
          zapWatchdogRef.current = null;
          if (isCurrentLoad() && !playbackStartedRef.current) {
            // A webOS néha a `playing` eseményt később küldi, miközben már
            // van metaadat/puffer. Ilyenkor nem szabad félbeszakítani az épp
            // dekódolás alatt álló címet egy új formátummal.
            let hasStartupData = video.readyState >= 3;
            try { hasStartupData = hasStartupData || video.buffered.length > 0; } catch { /* régi motor */ }
            if (hasStartupData) {
              // Egyszer adunk még egy rövid türelmi ablakot a webOS-nek;
              // a `playing` nélküli végtelen várakozás viszont nem maradhat.
            const graceMs = Math.max(1000, Math.min(startupWatchdogMs, 2000));
            appLog(`Zap-őr: már van metaadat/puffer, türelmi idő indul (${graceMs} ms).`);
              zapWatchdogRef.current = window.setTimeout(() => {
                zapWatchdogRef.current = null;
                if (isCurrentLoad() && !playbackStartedRef.current) {
                  appLog('Zap-őr: a türelmi idő után sem indult el az adás, formátumpróba következik.');
                  notifyTvDoctorIncident('startup_timeout', video, 'STARTUP_TIMEOUT', 'türelmi idő lejárt');
                  scheduleAutoRetry();
                }
              }, graceMs);
              return;
            }
            appLog('Zap-őr: nem indult el az adás időben, automatikus formátumváltás.');
            notifyTvDoctorIncident('startup_timeout', video, 'STARTUP_TIMEOUT', 'indulási időtúllépés');
            scheduleAutoRetry();
          }
        }, attemptTimeoutMs);
      } else if (tvDoctorEnabledRef.current) {
        // VOD INDULÁSI ŐR: ha a film vagy sorozat HTTP-kapcsolata némán
        // beragad induláskor, a TV Doktor türelmes ablak után (≥ 8,5 mp)
        // automatikusan újracsatlakoztatja ugyanazt a fájlt.
        const vodStartupLimitMs = Math.max(8500, doctorSessionRef.current.vodStartupWatchdogMs || 8500);
        zapWatchdogRef.current = window.setTimeout(() => {
          zapWatchdogRef.current = null;
          if (isCurrentLoad() && !playbackStartedRef.current && isVodRef.current) {
            let hasVodData = video.readyState >= 2;
            try { hasVodData = hasVodData || video.buffered.length > 0; } catch { /* régi motor */ }
            if (hasVodData) {
              const vodGraceMs = 3500;
              appLog(`VOD indulási őr: már érkezik metaadat/puffer, türelmi idő indul (${vodGraceMs} ms).`);
              zapWatchdogRef.current = window.setTimeout(() => {
                zapWatchdogRef.current = null;
                if (isCurrentLoad() && !playbackStartedRef.current && isVodRef.current) {
                  appLog('VOD indulási őr: a türelmi idő után sem indult el a VOD lejátszás, visszaállítás indul.');
                  notifyTvDoctorIncident('startup_timeout', video, 'VOD_STARTUP_TIMEOUT', 'VOD türelmi idő lejárt');
                  vodRecoveryRef.current('VOD indulási időtúllépés');
                }
              }, vodGraceMs);
              return;
            }
            appLog('VOD indulási őr: nem indult el a film/sorozat időben, automatikus újracsatlakozás.');
            notifyTvDoctorIncident('startup_timeout', video, 'VOD_STARTUP_TIMEOUT', 'VOD indulási időtúllépés');
            vodRecoveryRef.current('VOD indulási időtúllépés');
          }
        }, vodStartupLimitMs);
      }
      if (playPromise && typeof playPromise.catch === 'function') {
        void playPromise.catch((error: unknown) => {
          if (!isCurrentLoad() || video.error) return;
          const name = error instanceof Error ? error.name : '';
          /*
           * AbortError NEM hiba: a gyors csatornaváltás / újracsatlakozás
           * szakította félbe az előző play() ígéretet. Korábban ez is
           * hibaképernyőt (vagy formátumváltást) indított, és a film
           * néhány ms után végleg megállt.
           */
          if (name === 'AbortError') {
            appLog('LEJÁTSZÁSINDÍTÁS MEGSZAKÍTVA; ok=gyors forrásváltás (AbortError), nem hiba.');
            return;
          }
          appLogCritical(`LEJÁTSZÁSINDÍTÁSI ÍGÉRET HIBA; csatorna=${channelRef.current?.name || 'élő adás'}; próba=${channelSwitchDiagnosticRef.current?.attemptNumber || 1}; hiba=${error instanceof Error ? error.name + ': ' + error.message : String(error)}; ${videoDiagnosticState(video, 'play-promise-rejection')}`);
          endSwitch();
          if (isVodRef.current) {
            // Film/sorozat: ugyanaz a cím, a megőrzött pozícióról – SOHA
            // nem végleges hibaképernyő, és nem formátum-átírás.
            setHasError(false);
            setIsLoading(false);
            notifyTvDoctorIncident('play_rejected', video, name || 'VOD_PLAY_REJECTED', error instanceof Error ? error.message : String(error));
            vodRecoveryRef.current('play() ígéret hiba');
            return;
          }
          notifyTvDoctorIncident('play_rejected', video, name || 'PLAY_REJECTED', error instanceof Error ? error.message : String(error));
          scheduleAutoRetry();
          if (!autoRetryTimerRef.current) {
            setIsLoading(false);
            setHasError(true);
            setErrorMessage(name === 'NotAllowedError'
              ? 'A TV lejátszási indítást blokkolta. Nyomj az Újrapróbálás gombra.'
              : 'A TV nem tudta elindítani ezt az adatfolyamot. Ellenőrizd az URL-t és a stream formátumát.');
          }
        });
      }
    } catch (error) {
      endSwitch();
      const diagnostic = channelSwitchDiagnosticRef.current;
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (!isVodRef.current && diagnostic && diagnostic.generation === loadGeneration) {
        appLogCritical(`CSATORNAVÁLTÁS SZINKRON HIBA; csatorna=${diagnostic.channelName}; próba=${diagnostic.attemptNumber}; teljes-eltelt=${Date.now() - diagnostic.startedAt} ms; próba-eltelt=${Date.now() - diagnostic.attemptStartedAt} ms; hiba=${detail}`);
        scheduleAutoRetry();
        if (autoRetryTimerRef.current !== null) return;
        logChannelSwitchSummary('SIKERTELEN', `szinkron indítási hiba: ${detail}`);
      } else {
        appLogCritical(`VOD/LEJÁTSZÓ INDÍTÁSI HIBA; ${detail}`);
        notifyTvDoctorIncident('play_rejected', video, 'VOD_SYNC_START_ERROR', detail);
        vodRecoveryRef.current('szinkron indítási hiba');
        return;
      }
      setIsLoading(false);
      setHasError(true);
      setErrorMessage(error instanceof Error ? error.message : 'A webOS videó indítása sikertelen.');
    }
  }, [clearZapWatchdog, clearBufferWatchdog, handOverToNative, setIsPlaying, volume, customStreamUrl, scheduleAutoRetry, beginSwitch, endSwitch, buildVodDoctorTarget, showDoctorStatus]);

  retryStreamRef.current = () => {
    // A TS → HLS formátumváltásnál a webOS régi hibás médiaállapota nem
    // maradhat az elemen: az alternatív címet teljes `load()`-dal indítjuk.
    const isFormatFallback = !isVodRef.current && liveRetrySequenceRef.current.index > 0;
    loadStream(pendingStreamUrlRef.current || streamUrl, isFormatFallback);
  };

  // A streamhez tartozó újratöltés. FONTOS: csak akkor indul újra a lejátszás,
  // ha a stream címe vagy egy lejátszást tényleg befolyásoló beállítás
  // változott. Korábban minden beállítás-változás (pl. OSD-idő, képmód)
  // újraindította a lejátszást – ez volt a „ne méretezzen/ugráljon össze-vissza”.
  const loadStreamRef = useRef(loadStream);
  loadStreamRef.current = loadStream;

  /*
   * FOLYAMATOS ÉLŐ ÚJRACSATLAKOZÁS.
   *
   * Ha egy már futó adás megakad vagy a szolgáltató elvágja a kapcsolatot,
   * először UGYANAZT a címet töltjük be újra (a hang nem szakad meg), majd
   * csak több sikertelen próba után próbáljuk a másik formátumot. A próbák
   * fokozatosan ritkulnak, de soha nem állnak le maguktól: nincs többé
   * olyan állapot, ahol a kép fekete marad, a hang meg megy tovább.
   */
  requestRecoveryRef.current = (reason: string) => {
    if (isVodRef.current) {
      vodRecoveryRef.current(reason);
      return;
    }
    if (!playbackActiveRef.current || recoveryTimerRef.current !== null) return;
    if (tvDoctorEnabledRef.current && doctorSessionRef.current.channelHaltedDead) {
      return;
    }
    const sequence = liveRetrySequenceRef.current;
    const urls = sequence.urls.length ? sequence.urls : [streamUrl];
    const primaryUrl = urls[0] || streamUrl;
    if (!primaryUrl) return;

    // Ha a TV Doktor aktív és készített következő különböző beállítást, azt azonnal alkalmazzuk!
    if (tvDoctorEnabledRef.current && doctorSessionRef.current.lastProposal) {
      const proposal = doctorSessionRef.current.lastProposal;
      doctorSessionRef.current.lastProposal = null;
      if (!proposal.exhausted && !proposal.stopRetrying) {
        const delayMs = Math.max(50, Math.min(500, proposal.delayMs));
        const generation = streamLoadGenerationRef.current;
        clearAutoRetry();
        clearBufferWatchdog();
        setHasError(false);
        setIsLoading(false);
        setIsRecovering(true);
        appLog(
          `ÉLŐ ÚJRACSATLAKOZÁS (TV DOKTOR ${proposal.step}/${proposal.maxSteps}); csatorna=${channelRef.current?.name || 'élő adás'}; ` +
          `várakozás=${delayMs} ms; mód=${proposal.nextFormat.toUpperCase()}; puffer=${proposal.nextBufferProfile}; ok=${reason}.`,
        );
        recoveryTimerRef.current = window.setTimeout(() => {
          recoveryTimerRef.current = null;
          if (generation !== streamLoadGenerationRef.current) return;
          if (isVodRef.current || !playbackActiveRef.current || doctorSessionRef.current.channelHaltedDead) return;
          pendingStreamUrlRef.current = proposal.nextUrl;
          const idx = urls.indexOf(proposal.nextUrl);
          sequence.index = idx >= 0 && idx < urls.length ? idx : 0;
          loadStreamRef.current(proposal.nextUrl, proposal.forceCleanReset);
        }, delayMs);
        return;
      }
    }

    const fallbackUrl = liveFallbackRef.current?.url || (urls[1] !== primaryUrl ? urls[1] : undefined);
    // Egy átmeneti stall saját backoff-sorozatot kap. A webOS által véges
    // VOD-ként lezárt live TS viszont több, egymást követő indulás után sem
    // indulhat mindig ugyanazon a címen: két friss azonos próba után a
    // tartalék formátum következik.
    const terminalLiveEnd = /^élő (?:adás )?(?:vége|véges idővonal)/i.test(reason);
    const attempt = terminalLiveEnd
      ? liveEndRecoveryAttemptRef.current++
      : recoveryAttemptRef.current++;

    // Kikapcsolt TV Doktornál is megakadályozzuk a valóban nem működő csatornák végtelen ciklusát!
    if (attempt >= 5) {
      clearAutoRetry();
      clearBufferWatchdog();
      endSwitch();
      setIsLoading(false);
      setIsRecovering(false);
      setIsPlaying(false);
      setHasError(true);
      setErrorMessage('A csatorna jelenleg nem működik – az automatikus újrapróbálás leállt.');
      appLogCritical(
        `ÉLŐ ÚJRACSATLAKOZÁS LEÁLLÍTVA; csatorna=${channelRef.current?.name || 'élő adás'}; ` +
        `próbák=${attempt}; ok=a csatorna nem működik, végtelen ciklus megelőzve.`,
      );
      return;
    }
    // Indulási hiba után az emlékezett/elsődleges címet próbáljuk újra;
    // már futó adásnál viszont az éppen működő src-et tartjuk meg. A másik
    // formátum csak a recovery saját, ritkuló sorozatában jelenhet meg.
    const recoveryPrimaryUrl = playbackStartedRef.current
      ? (activeMediaUrlRef.current || pendingStreamUrlRef.current || primaryUrl)
      : primaryUrl;
    const recoveryFallbackUrl = recoveryPrimaryUrl === primaryUrl ? fallbackUrl : primaryUrl;
    liveRecoveryOnlyRef.current = true;
    const baseRecoveryUrl = liveRecoveryUrl(attempt, recoveryPrimaryUrl, recoveryFallbackUrl);
    const doctorFallbackOverride = tvDoctorEnabledRef.current ? doctorSessionRef.current.fallbackUrlOverride : null;
    const nextUrl = attempt >= 3 && doctorFallbackOverride ? doctorFallbackOverride : baseRecoveryUrl;
    if (doctorFallbackOverride && nextUrl === doctorFallbackOverride) {
      doctorSessionRef.current.fallbackUrlOverride = null;
    }
    const delayMs = liveRecoveryDelayMs(attempt, Math.max(50, bufferTiming().retryMs));
    const generation = streamLoadGenerationRef.current;
    clearAutoRetry();
    clearBufferWatchdog();
    setHasError(false);
    // A kép NEM tűnhet el: a teljes képernyős fekete töltőréteget nem
    // engedjük a videó fölé, csak egy kis „újracsatlakozás” jelzőt mutatunk.
    setIsLoading(false);
    setIsRecovering(true);
    showDoctorStatus({
      phase: 'retry',
      title: 'Újracsatlakozás',
      detail: nextUrl === recoveryPrimaryUrl
        ? `Adás frissítése (${attempt + 1}. próba)…`
        : 'Tartalék formátummal újraindítás…',
    });
    appLog(
      `ÉLŐ ÚJRACSATLAKOZÁS; csatorna=${channelRef.current?.name || 'élő adás'}; próba=${attempt + 1}; ` +
      `várakozás=${delayMs} ms; cím=${nextUrl === recoveryPrimaryUrl ? 'aktuális/elsődleges' : 'tartalék formátum'}; ok=${reason}.`
    );
    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = null;
      if (generation !== streamLoadGenerationRef.current) return; // közben másik csatorna
      if (isVodRef.current || !playbackActiveRef.current) return;
      pendingStreamUrlRef.current = nextUrl;
      const index = urls.indexOf(nextUrl);
      sequence.index = index >= 0 && index < urls.length ? index : 0;
      loadStreamRef.current(nextUrl, true);
    }, delayMs);
  };

  /*
   * FILM / SOROZAT VISSZAÁLLÍTÁSA.
   *
   * A stream megszakadásakor a TV `ended` / `error` / `stalled` eseményt ad.
   * Ilyenkor ugyanazt a címet töltjük újra, és a legutolsó ismert
   * időpontról folytatjuk – nem ugrunk a következő részre, nem kell
   * kilépni és újra belépni a filmbe.
   */
  vodRecoveryRef.current = (reason: string) => {
    if (!isVodRef.current || recoveryTimerRef.current !== null) return;
    const video = htmlVideoRef.current;
    const url = streamUrl;
    if (!video || !url) return;
    const attempt = recoveryAttemptRef.current++;
    speedStep('VOD újraindítás ütemezése', `ok=${reason}; kísérlet=${attempt + 1}`);
    const delayMs = vodRecoveryDelayMs(attempt, Math.max(150, bufferTiming().retryMs));
    // Ha még nem jött timeupdate, a folytatási pozícióról indulunk; ha már
    // igen, akkor a VALÓDI utolsó helyről (a 0 mp-re tekerést is tiszteletben tartva).
    const position = Math.max(0, Number(
      vodPositionKnownRef.current ? vodLastPositionRef.current : initialPositionSeconds
    ) || 0);
    const generation = streamLoadGenerationRef.current;
    clearAutoRetry();
    clearBufferWatchdog();
    setHasError(false);
    setIsLoading(false);
    setIsRecovering(true);
    const resumeMin = Math.floor(position / 60);
    const resumeSec = String(Math.floor(position % 60)).padStart(2, '0');
    showDoctorStatus({
      phase: 'retry',
      title: 'VOD visszaállítás',
      detail: position > 1
        ? `Folytatás ${resumeMin}:${resumeSec} pozíciótól (${attempt + 1}. próba)…`
        : `Adatfolyam újracsatlakoztatása (${attempt + 1}. próba)…`,
    });
    appLog(
      `VOD VISSZAÁLLÍTÁS; cím=${String(customTitle || 'film').slice(0, 80)}; próba=${attempt + 1}; ` +
      `várakozás=${delayMs} ms; folytatás=${Math.round(position)} mp; ok=${reason}.`
    );
    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = null;
      if (generation !== streamLoadGenerationRef.current) return;
      if (!isVodRef.current || video !== htmlVideoRef.current) return;
      speedLoad('VOD', `visszaállítás; ok=${reason}; pozíció=${position.toFixed(2)} s`, url);
      beginSwitch();
      let restored = false;
      const dropRestoreListener = () => {
        try { video.removeEventListener('loadedmetadata', restore); } catch { /* régi motor */ }
        if (vodRestoreTimerRef.current !== null) {
          window.clearTimeout(vodRestoreTimerRef.current);
          vodRestoreTimerRef.current = null;
        }
      };
      const restore = () => {
        if (restored) return;
        restored = true;
        dropRestoreListener();
        if (position > 1) {
          try { video.currentTime = position; } catch { /* a motor később engedi */ }
        }
        void video.play().catch(() => undefined);
        endSwitch();
      };
      vodRestoreCleanupRef.current = () => {
        restored = true;
        dropRestoreListener();
      };
      video.addEventListener('loadedmetadata', restore);
      // Ha a TV nem küld metaadatot, akkor se maradjon a lejátszó félkész
      // állapotban: a biztonsági időkorlát is elindítja a lejátszást.
      vodRestoreTimerRef.current = window.setTimeout(restore, 6000);
      try {
        video.pause();
        video.src = url;
        // Azonos címnél a `load()` kell a tényleges újracsatlakozáshoz.
        video.load();
        void video.play().catch(() => undefined);
      } catch {
        restore();
      }
    }, delayMs);
  };

  // A pufferprofil élő lejátszás közben is váltható. Nem indítjuk újra a
  // forrást pusztán a módváltás miatt: a következő watchdog/recovery már az
  // új policy-t használja, így a menü tesztelése nem okoz mesterséges akadozást.
  const loadKey = streamUrl;
  useEffect(() => {
    clearAutoRetry();
    clearRecovery();
    recoveryAttemptRef.current = 0;
    liveEndRecoveryAttemptRef.current = 0;
    stallDetectorRef.current?.reset();
    // Új filmnél az előző film pozíciója NEM öröklődhet (sem a felirat órája,
    // sem az előzménybe írt helyzet, sem a folytatás-jelző).
    vodLastPositionRef.current = 0;
    vodPositionKnownRef.current = false;
    vodSubtitleClockRef.current = 0;
    lastReportedProgressRef.current = -1;
    resumeAppliedForUrlRef.current = '';
    nativeRetryCountRef.current = 0;
    setActiveUrlIndex(0);
    setCurrentStreamHasFrame(false);
    const directLiveStreamUrl = streamUrl;
    // Élő adásnál először a csatornán korábban sikeres formátumot használjuk.
    // Ha nincs emlék, a korábbi alapértelmezés (MPEG-TS) marad. Hiba esetén
    // a másik formátum következik; a generációs őr védi az új csatornát
    // a régi betöltés későn érkező eseményeitől.
    /*
     * FUTÓ ADÁS: NINCS ÚJRAINDÍTÁS (2.5.165).
     *
     * Ha ugyanaz a csatorna már játszik, és a cím FORMÁTUMA sem változott,
     * akkor a hatás (a lista háttér-frissítése miatt) nem indíthat új
     * betöltést. A formátumváltás (TS ↔ HLS a beállításokból) viszont
     * továbbra is azonnal érvényesül.
     */
    if (!isVod && playbackActive && channel?.id && lastPlayedRef.current
        && lastPlayedRef.current.channelId === channel.id
        && formatOfUrl(lastPlayedRef.current.url) === formatOfUrl(directLiveStreamUrl)) {
      const playing = htmlVideoRef.current;
      // Csak akkor maradhat minden, ha a forrás TÉNYLEG a videóelemen van
      // (a Mozi/Sorozat nézet eltávolítja a forrást – akkor újra kell tölteni).
      if (playing && !playing.error && Boolean(playing.currentSrc || playing.src)) {
        appLog(`Csatorna-lista frissült – a futó adás változatlanul megy tovább, nincs újraindítás (${channel.name || 'élő adás'}).`);
        return undefined;
      }
    }
    const hlsUrl = streamUrl.replace(/\.ts(?=([?#]|$))/i, '.m3u8');
    const tsUrl = /\.ts(?=([?#]|$))/i.test(streamUrl)
      ? streamUrl
      : streamUrl.replace(/\.m3u8(?=([?#]|$))/i, '.ts');
    const channelMemory = isVod ? null : rememberedFormatFor(channel?.id);
    const sourceFormat = isVod ? null : formatOfUrl(streamUrl);
    const doctorPlan = !isVod && tvDoctorEnabledRef.current
      ? selectChannelLaunchPlan(channel, streamUrl, settings)
      : null;
    if (!isVod) {
      doctorSessionRef.current.channelKey = doctorPlan?.channelKey || normalizeChannelDoctorKey(channel);
      doctorSessionRef.current.hasLearnedProfile = Boolean(doctorPlan?.hasLearnedProfile);
      doctorSessionRef.current.directFastStart = Boolean(doctorPlan?.directFastStart);
      doctorSessionRef.current.maxRepairSteps = doctorPlan?.maxRepairSteps || MAX_DOCTOR_REPAIR_STEPS;
      doctorSessionRef.current.channelHaltedDead = false;
      doctorSessionRef.current.lastProposal = null;
      doctorSessionRef.current.activeBufferProfile = doctorPlan?.bufferProfileId || settings.bufferMode || 'balanced';
      doctorSessionRef.current.activeBufferTiming = doctorPlan?.enabled ? doctorPlan.bufferTiming : null;
      doctorSessionRef.current.vodStartupRecorded = false;
      doctorSessionRef.current.repairStep = 0;
      doctorSessionRef.current.repairInFlight = false;
      doctorSessionRef.current.waitingOrStalledFlag = false;
      doctorSessionRef.current.consecutiveStallTicks = 0;
      doctorSessionRef.current.fallbackUrlOverride = null;
    } else {
      const vodTarget = buildVodDoctorTarget(streamUrl);
      const vodPlan = tvDoctorEnabledRef.current
        ? selectVodLaunchPlan(vodTarget, settings)
        : null;
      doctorSessionRef.current.channelKey = vodPlan?.vodKey || normalizeVodDoctorKey(vodTarget);
      doctorSessionRef.current.hasLearnedProfile = Boolean(vodPlan?.hasLearnedProfile);
      doctorSessionRef.current.directFastStart = false;
      doctorSessionRef.current.maxRepairSteps = MAX_DOCTOR_REPAIR_STEPS;
      doctorSessionRef.current.channelHaltedDead = false;
      doctorSessionRef.current.lastProposal = null;
      doctorSessionRef.current.activeBufferProfile = vodPlan?.bufferProfileId || settings.bufferMode || 'balanced';
      doctorSessionRef.current.activeBufferTiming = vodPlan?.hasLearnedProfile ? vodPlan.bufferTiming : null;
      doctorSessionRef.current.vodStartupWatchdogMs = vodPlan?.startupWatchdogMs || 8500;
      doctorSessionRef.current.vodLoadStartedAt = Date.now();
      doctorSessionRef.current.vodStartupRecorded = false;
      doctorSessionRef.current.repairStep = 0;
      doctorSessionRef.current.repairInFlight = false;
      doctorSessionRef.current.waitingOrStalledFlag = false;
      doctorSessionRef.current.consecutiveStallTicks = 0;
      doctorSessionRef.current.fallbackUrlOverride = null;
    }
    // Ha a TV Doktor már igazoltan megtanulta a csatorna leggyorsabb, működő
    // formátumát, közvetlenül azt indítjuk (akkor is, ha az általános alapbeállítás más!).
    // Még nem tanult csatornánál a kézi beállítás / formátumemlék dönt.
    const configuredFormat = settings.streamFormat === 'hls' ? 'hls' : 'ts';
    const primaryFormat = doctorPlan?.hasLearnedProfile
      ? doctorPlan.primaryFormat
      : (configuredFormat === 'hls' ? 'hls' : (channelMemory || sourceFormat || 'ts'));
    const primaryUrl = isVod ? streamUrl : (primaryFormat === 'hls' ? hlsUrl : tsUrl);
    pendingStreamUrlRef.current = primaryUrl;
    liveFallbackRef.current = isVod ? null : alternativeUrl(primaryUrl);
    const alternative = liveFallbackRef.current;
    // Aktív TV Doktornál nem vesztegetünk időt dupla azonos formátumpróbára, mert a
    // TV Doktor 5-lépcsős gyors beállításváltója azonnal átvált a következő beállításra.
    initialFormatRetryRef.current = Boolean(!isVod && alternative && !doctorPlan?.skipSameFormatRetry);
    liveRecoveryOnlyRef.current = false;
    liveRetrySequenceRef.current = isVod
      ? { urls: [], index: 0 }
      : {
          // Ugyanazt a formátumot nem indítjuk újra azonnal a másik után;
          // a recovery réteg később, ritkuló időzítéssel próbálkozik.
          urls: alternative ? [primaryUrl, alternative.url] : [primaryUrl],
          index: 0,
        };
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
      activeMediaUrlRef.current = '';
      playbackStartedRef.current = false;
      // A nézet elhagyásakor a védett „futó adás” emléket eldobjuk: élő
      // nézetbe visszatérve a forrás újra betöltődik.
      lastPlayedRef.current = null;
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
      clearRecovery();
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
      // A következő pause/play eseményt már a távirányító szándéka szerint
      // kezeljük, még azelőtt, hogy React újrarenderelné az állapotot.
      desiredPlayingRef.current = true;
      void video.play().then(() => setIsPlaying(true)).catch(() => {
        setHasError(true);
        setErrorMessage('A TV lejátszási indítást blokkolta. Nyomj az Újrapróbálás gombra.');
      });
    } else {
      desiredPlayingRef.current = false;
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

  /*
   * FŐOLDALI 16:9-ES KERET (a nem teljes képernyős lejátszó mérete).
   *
   * MI VÁLTOZOTT (2.5.119) ÉS MIÉRT:
   * Korábban ez az effekt a `[isFullscreen, isVod, streamUrl]` függőségek
   * MINDEN változására lefutott, és a teljes képernyőből visszatéréskor egy
   * szinkron stílusírással + `offsetHeight`-olvasással kényszerített
   * újrarendezéssel állította helyre a keretet, majd egy animációs képben és
   * egy 250 ms-os időzítőben MÉG KÉTSZER megismételte. Egyetlen váltás így
   * három teljes oldalas elrendezést indított – ez volt a látható akadás.
   *
   * Most a teljes képernyő geometriája a `.iptv-fs` CSS-osztályból jön
   * (web/src/index.css), ezért a kilépéskor NINCS mit helyreállítani: az
   * osztály eltávolítása magától visszaadja a főoldali keretet, mert a teljes
   * képernyő alatt egyetlen inline stílus sem változott meg.
   *
   * Ez az effekt tehát csak akkor ír stílust, ha a keret mérete TÉNYLEG
   * megváltozott (új csatorna, átméretezés, elforgatás), és a mérést
   * animációs képkockába teszi – így a váltás közben nem kényszerít
   * szinkron újrarendezést.
   */
  const appliedLayoutKeyRef = useRef<string>('');
  const layoutStreamRef = useRef<string | null>(null);
  useEffect(() => {
    if (isVod || isFullscreen) return;

    const container = containerRef.current;
    const video = htmlVideoRef.current;
    if (!container || !video) return;

    const writeHomeGeometry = () => {
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
        imageRendering: 'auto',
        filter: 'none',
        backfaceVisibility: 'hidden',
      });
    };

    let frame = 0;
    // A csatorna-/filmváltás után a stílust már szinkron beírtuk; az első
    // mérés ilyenkor csak a méret-kulcsot rögzíti (nincs második írás).
    let geometryWrittenSync = false;
    const applyMeasuredLayout = () => {
      frame = 0;
      if (isFullscreen) return;
      // Biztonsági háló: a teljes képernyős állapot a body-osztályon is
      // látszik, így egy korábban ütemezett (elavult) hívás sem teheti
      // vissza a 16:9-es keretet a teljes képernyős dobozra.
      try {
        if (document.body.classList.contains('iptv-tv-fullscreen')) return;
      } catch { /* régi motor */ }
      const host = container.parentElement;
      const width = host ? host.clientWidth : 0;
      const height = host ? host.clientHeight : 0;
      const key = `${width}x${height}|${streamUrl}`;
      // A teljes képernyőről visszatérés UGYANEKKORA keretet ad – ilyenkor
      // nincs stílusírás és nincs kényszerített újramérés.
      if (key === appliedLayoutKeyRef.current) return;
      appliedLayoutKeyRef.current = key;
      if (geometryWrittenSync) { geometryWrittenSync = false; return; }
      writeHomeGeometry();
    };
    const scheduleLayout = () => {
      if (frame) return; // egy képkockán belül legfeljebb egyszer mérünk
      frame = window.requestAnimationFrame(applyMeasuredLayout);
    };

    /*
     * Új csatorna / új film: az első képkockának már a 16:9-es keretben kell
     * megjelennie, ezért ilyenkor egyszer, szinkron írunk. Kényszerített
     * újramérés NINCS – a böngésző a képkockát úgyis kiszámolja.
     * Teljes képernyőről visszatéréskor viszont ide nem lépünk be.
     */
    if (layoutStreamRef.current !== streamUrl) {
      layoutStreamRef.current = streamUrl;
      appliedLayoutKeyRef.current = '';
      geometryWrittenSync = true;
      writeHomeGeometry();
    }
    scheduleLayout();

    const parent = container.parentElement;
    const observer = typeof ResizeObserver !== 'undefined' && parent
      ? new ResizeObserver(scheduleLayout)
      : null;
    if (parent) observer?.observe(parent);
    window.addEventListener('resize', scheduleLayout);
    window.visualViewport?.addEventListener('resize', scheduleLayout);
    document.addEventListener('fullscreenchange', scheduleLayout);
    document.addEventListener('visibilitychange', scheduleLayout);
    return () => {
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleLayout);
      window.visualViewport?.removeEventListener('resize', scheduleLayout);
      document.removeEventListener('fullscreenchange', scheduleLayout);
      document.removeEventListener('visibilitychange', scheduleLayout);
    };
  }, [isFullscreen, isVod, streamUrl]);

  return (
    <div
      ref={containerRef}
      data-tv-player=""
      /* Film/sorozat alatt ez a jelölés mondja meg a webos.js-nek, hogy a
         ZÖLD gomb a közös sávválasztót nyitja, KÉK nem végez műveletet. */
      data-vod-active={isVod ? '1' : undefined}
      data-player-engine={playerEngine}
      tabIndex={isFullscreen ? 0 : -1}
      onKeyDown={handleKeyDown}
      /* A TELJES KÉPERNYŐ geometriája a `.iptv-fs` CSS-osztályból jön
         (web/src/index.css), nem inline stílusból: így a váltás egyetlen
         attribútum-írás, a kilépéskor pedig az osztály eltávolítása magától
         visszaadja a főoldali 16:9-es keretet. A `fixed` osztály a webos.js
         TV-s szabályaihoz kell (a lejátszó OSD-jének elrejtése a főoldalon). */
      /* 2.5.165 – A CSATORNAVÁLTÁS KÖZÖTTI HÁTTÉR FEKETE (felhasználói kérés).
         Korábban a lejátszó doboza világos türkiz (#0d2630) volt, ezért a
         váltás alatt – amíg az új adás első képkockája meg nem jön – a
         képernyő világoskéknek látszott. Most fekete, mint a videó maga. */
      className={`relative w-full ${isFullscreen ? 'iptv-fs h-screen max-h-none aspect-auto fixed inset-0 z-[9999]' : 'flex-1 min-h-0 max-h-none'} ${nativeHandoff ? 'bg-transparent' : 'bg-black'} overflow-hidden group select-none focus:outline-none focus-visible:outline-none ${isFullscreen ? '' : 'shadow-2xl border-b border-cyan-900/30'}`}
      /* Állandó főoldali stílus: teljes képernyőn a CSS-osztály írja felül
         `!important`-tal, ezért a React itt SOHA nem ír stílust a váltáskor. */
      style={PLAYER_HOME_STYLE}
    >
      {/* Három külön elrendezés: főoldali 16:9, álló teljes képernyőn 16:9 keret (élő TV és VOD is), fekvőben teljes kijelző. */}
      {/* Amíg az első képkocka meg nem érkezik, a csatorna nevét és logóját
          mutatjuk – FEKETE alapon (2.5.165). A korábbi türkiz alap volt a
          „világoskék csatornaváltási háttér”, amit a felhasználó kifogásolt. */}
      {!isVod && !firstFrameShown && (
        <div
          data-player-poster=""
          className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-3 bg-black pointer-events-none"
        >
          {/* 2.5.135 – FOLYAMATOS INDULÁS.
              Üres IPK-n nincs csatorna: a logó-doboz és a „Kapcsolódás…”
              felirat csak egy sötét, majdnem fekete téglalapot adott volna a
              képernyő közepére (ez volt a „fekete felvillanás”). A HTML
              fejlécéből injektált CSS ilyenkor a webOS indítóképét teszi a
              doboz hátterére, ezért a REVEAL után is UGYANAZ a kép látszik –
              csak a kezelőfelület épül köré. Ha már van csatorna, a logó és
              a csatornanév változatlanul megjelenik. */}
          {channel && (
            <>
              <div className="h-16 w-16 md:h-24 md:w-24 flex items-center justify-center overflow-hidden rounded-xl border border-cyan-800/50 bg-[#0e1e3e]">
                <ChannelLogo url={channel.logo} name={channel.name || ''} retryKey={channel.id} />
              </div>
              <div className="max-w-[80%] truncate text-center text-lg font-bold text-slate-300 md:text-2xl">
                {channel.name || 'Kapcsolódás…'}
              </div>
            </>
          )}
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
            data-iptv-mode={isVod ? 'VOD' : 'élő'}
            className="block h-full w-full bg-black"
            // KÉPMINŐSÉG (2.5.156): teljes képernyőn `contain` – se nyújtás, se vágás.
            // Korábban a VOD `fill` módban a 16:9-es területre NYÚJTOTTA a
            // 2.39:1-es filmeket (torz, „megnyúlt" kép), az élő `cover` pedig
            // nem-16:9 forrásnál belezoomolt és levágta a széleket – mindkettő
            // rontja a ténylegesen látható élességet. 16:9 forrásnál a contain
            // és a cover azonos, így a megszokott kép nem változik.
            // A főoldali kis előnézet-dobozban az élő kép továbbra is `cover`
            // (ott a kitöltés a cél, a dobozt a geometria-effekt is így írja).
            style={{ objectFit: isVod || isFullscreen ? 'contain' : 'cover', imageRendering: 'auto', filter: 'none', backfaceVisibility: 'hidden' }}
            playsInline
            preload="auto"


            onDurationChange={(event) => {
              const video = event.currentTarget;

              if (isVod || !isActiveMediaEvent(video)) return;
              const duration = Number(video.duration);
              if (!Number.isFinite(duration) || duration <= 2) {
                if (liveDurationRecoveryTimerRef.current !== null) {
                  window.clearTimeout(liveDurationRecoveryTimerRef.current);
                  liveDurationRecoveryTimerRef.current = null;
                }
                return;
              }
              if (!playbackStartedRef.current) return;
              const endState = {
                ended: video.ended,
                paused: video.paused,
                desiredPlaying: desiredPlayingRef.current,
                playbackStarted: playbackStartedRef.current,
                currentTime: Number(video.currentTime || 0),
                duration,
              };
              if (isUnexpectedLiveEnd(endState)) {
                appLog(`ÉLŐ VÉGES IDŐVONAL; csatorna=${channelRef.current?.name || 'élő adás'}; ` +
                  `t=${endState.currentTime.toFixed(2)} s; duration=${duration.toFixed(2)} s; ` +
                  `ended=${video.ended}; paused=${video.paused}; ${videoDiagnosticState(video, 'durationchange')}`);
                notifyTvDoctorIncident('unexpected_end', video, 'FINITE_LIVE_END', `durationchange ${duration.toFixed(1)}s`);
                requestRecoveryRef.current(`élő véges idővonal – durationchange/ended`);
                return;
              }
              // Egy véges duration önmagában lehet rövid webOS átmeneti állapot.
              // Csak akkor vizsgáljuk újra, ha másfél másodperc múlva is megmarad.
              if (liveDurationRecoveryTimerRef.current === null) {
                const generation = streamLoadGenerationRef.current;
                liveDurationRecoveryTimerRef.current = window.setTimeout(() => {
                  liveDurationRecoveryTimerRef.current = null;
                  if (generation !== streamLoadGenerationRef.current || video !== htmlVideoRef.current) return;
                  const currentDuration = Number(video.duration);
                  const currentState = {
                    ended: video.ended,
                    paused: video.paused,
                    desiredPlaying: desiredPlayingRef.current,
                    playbackStarted: playbackStartedRef.current,
                    currentTime: Number(video.currentTime || 0),
                    duration: currentDuration,
                  };
                  if (isUnexpectedLiveEnd(currentState)) {
                    appLog(`ÉLŐ VÉGES IDŐVONAL; csatorna=${channelRef.current?.name || 'élő adás'}; ` +
                      `t=${currentState.currentTime.toFixed(2)} s; duration=${currentDuration.toFixed(2)} s; ` +
                      `ended=${video.ended}; paused=${video.paused}; ${videoDiagnosticState(video, 'tartós durationchange')}`);
                    notifyTvDoctorIncident('unexpected_end', video, 'FINITE_LIVE_END', `tartós durationchange ${currentDuration.toFixed(1)}s`);
                    requestRecoveryRef.current(`élő véges idővonal – durationchange/ended`);
                  }
                }, 1500);
              }
            }}






            onPlaying={(event) => {

              // Ez az adás TÉNYLEG elindult: ez védi meg a későbbi
              // lista-frissítéstől (lásd `lastPlayedRef`).
              lastPlayedRef.current = lastLoadRef.current;
              if (!isActiveMediaEvent(event.currentTarget)) {
                appLog('CSATORNAVÁLTÁS RÉGI MÉDIAESEMÉNY KIHAGYVA; ok=az előző src playing eseménye nem zárhatja le az új próbát.');
                return;
              }
              playbackStartedRef.current = true;
              initialFormatRetryRef.current = false;
              doctorSessionRef.current.channelHaltedDead = false;
              doctorSessionRef.current.lastProposal = null;
              if (!isVod) {
                try {
                  window.dispatchEvent(new CustomEvent('iptv-live-playing'));
                } catch {
                  /* ignore */
                }
              }
              if (liveDurationRecoveryTimerRef.current !== null) {
                window.clearTimeout(liveDurationRecoveryTimerRef.current);
                liveDurationRecoveryTimerRef.current = null;
              }
              // Sikeres képkocka: a belső forrásváltás véget ért, a régi
              // pause/play események többé nem zavarhatják össze az állapotot.
              endSwitch();
              stallDetectorRef.current?.reset();
              recoveryAttemptRef.current = 0;
              liveRecoveryOnlyRef.current = false;
              if (recoveryTimerRef.current !== null) {
                window.clearTimeout(recoveryTimerRef.current);
                recoveryTimerRef.current = null;
              }
              setIsRecovering(false);
              clearBufferWatchdog();
              // A főoldal ebből tudja, hogy a TV-kép kész (nincs fekete doboz).
              try {
                (window as any).__IPTV_VIDEO_READY__ = true;
              } catch { /* nincs window */ }
              /*
               * AZ ELSŐ KIRAJZOLT KÉPKOCKA (2.5.147).
               *
               * A `playing` esemény csak azt jelenti, hogy a lejátszás
               * elindult – a képkocka ilyenkor még a kompozitor előtt lehet.
               * A takarókép levétele pont ebben a pillanatban villantott be
               * fekete/festetlen videó-területet. A `requestVideoFrameCallback`
               * viszont akkor hívódik meg, amikor a képkocka tényleg
               * megjelent: ezt a jelzőt várja meg a felfedés (korlátozott
               * ideig). Ha a motor nem támogatja, marad a `playing` jelzés.
               */
              try {
                const gateVideo = event.currentTarget as HTMLVideoElement & {
                  requestVideoFrameCallback?: (callback: () => void) => number;
                };
                if (typeof gateVideo.requestVideoFrameCallback === 'function'
                    && (window as any).__IPTV_VIDEO_PAINTED__ !== true) {
                  gateVideo.requestVideoFrameCallback(() => {
                    try {
                      (window as any).__IPTV_VIDEO_PAINTED__ = true;
                      window.dispatchEvent(new CustomEvent('iptv-video-painted'));
                    } catch { /* nincs window */ }
                  });
                }
              } catch { /* régi motor */ }
              setFirstFrameShown((previous) => previous || true);
              setCurrentStreamHasFrame(true);
              if (!isVod) {
                const diagnostic = channelSwitchDiagnosticRef.current;
                const video = event.currentTarget as HTMLVideoElement & {
                  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime?: number; presentedFrames?: number }) => void) => number;
                };
                if (diagnostic && diagnostic.generation === streamLoadGenerationRef.current && !diagnostic.completed) {
                  diagnostic.completed = true;
                  appLog(`CSATORNAVÁLTÁS LEJÁTSZÁS ELINDULT; csatorna=${diagnostic.channelName}; teljes-eltelt=${Date.now() - diagnostic.startedAt} ms; próba-eltelt=${Date.now() - diagnostic.attemptStartedAt} ms; próba=${diagnostic.attemptNumber}; ${videoDiagnosticState(video, 'playing')}`);
                  logChannelSwitchSummary('SIKERES', 'a lejátszás elindult', video);
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
                  if (tvDoctorEnabledRef.current && target) {
                    const docState = doctorSessionRef.current;
                    docState.waitingOrStalledFlag = false;
                    docState.consecutiveStallTicks = 0;
                    const diag = channelSwitchDiagnosticRef.current;
                    const measuredStartupMs = diag
                      ? Math.max(20, Date.now() - diag.attemptStartedAt)
                      : 250;
                    const verifyGen = streamLoadGenerationRef.current;
                    const verifyVideo = event.currentTarget;
                    if (docState.verifyTimer !== null) {
                      window.clearTimeout(docState.verifyTimer);
                      docState.verifyTimer = null;
                    }
                    if (docState.repairInFlight) {
                      const verifiedProfile = docState.activeBufferProfile;
                      showDoctorStatus({
                        phase: 'verifying',
                        title: 'Javítás ellenőrzése',
                        detail: 'Stabil adás visszaigazolása…',
                      });
                      docState.verifyTimer = window.setTimeout(() => {
                        docState.verifyTimer = null;
                        if (
                          verifyGen !== streamLoadGenerationRef.current ||
                          verifyVideo !== htmlVideoRef.current ||
                          verifyVideo.paused ||
                          verifyVideo.ended ||
                          Boolean(verifyVideo.error)
                        ) {
                          return;
                        }
                        recordDoctorChannelSuccess({
                          channel: target,
                          format,
                          bufferProfile: verifiedProfile,
                          startupMs: measuredStartupMs,
                          wasRepair: true,
                        });
                        docState.repairInFlight = false;
                        docState.repairStep = 0;
                        scheduleClearDoctorStatus(350);
                      }, DOCTOR_VERIFY_STABLE_MS);
                    } else {
                      recordDoctorChannelSuccess({
                        channel: target,
                        format,
                        bufferProfile: docState.activeBufferProfile,
                        startupMs: measuredStartupMs,
                        wasRepair: false,
                      });
                      scheduleClearDoctorStatus(650);
                    }
                  }
                } else if (tvDoctorEnabledRef.current && channelRef.current) {
                  const target = channelRef.current;
                  const docState = doctorSessionRef.current;
                  docState.waitingOrStalledFlag = false;
                  docState.consecutiveStallTicks = 0;
                  recordDoctorChannelSuccess({
                    channel: target,
                    format: 'ts',
                    bufferProfile: docState.activeBufferProfile,
                    startupMs: 250,
                    wasRepair: false,
                  });
                  scheduleClearDoctorStatus(650);
                }
              } else if (isVod && tvDoctorEnabledRef.current) {
                const docState = doctorSessionRef.current;
                docState.waitingOrStalledFlag = false;
                docState.consecutiveStallTicks = 0;
                const vodTarget = buildVodDoctorTarget(customStreamUrl);
                const measuredVodStartupMs = docState.vodLoadStartedAt > 0
                  ? Math.max(25, Date.now() - docState.vodLoadStartedAt)
                  : 300;
                const verifyGen = streamLoadGenerationRef.current;
                const verifyVideo = event.currentTarget;
                if (docState.verifyTimer !== null) {
                  window.clearTimeout(docState.verifyTimer);
                  docState.verifyTimer = null;
                }
                if (docState.repairInFlight) {
                  const verifiedProfile = docState.activeBufferProfile;
                  showDoctorStatus({
                    phase: 'verifying',
                    title: 'VOD javítás ellenőrzése',
                    detail: 'Folyamatos lejátszás visszaigazolása…',
                  });
                  docState.verifyTimer = window.setTimeout(() => {
                    docState.verifyTimer = null;
                    if (
                      verifyGen !== streamLoadGenerationRef.current ||
                      verifyVideo !== htmlVideoRef.current ||
                      verifyVideo.paused ||
                      verifyVideo.ended ||
                      Boolean(verifyVideo.error)
                    ) {
                      return;
                    }
                    docState.vodStartupRecorded = true;
                    recordDoctorVodSuccess({
                      target: vodTarget,
                      bufferProfile: verifiedProfile,
                      startupMs: measuredVodStartupMs,
                      wasRepair: true,
                    });
                    docState.repairInFlight = false;
                    docState.repairStep = 0;
                    scheduleClearDoctorStatus(350);
                  }, DOCTOR_VERIFY_STABLE_MS);
                } else if (!docState.vodStartupRecorded) {
                  docState.vodStartupRecorded = true;
                  recordDoctorVodSuccess({
                    target: vodTarget,
                    bufferProfile: docState.activeBufferProfile,
                    startupMs: measuredVodStartupMs,
                    wasRepair: false,
                  });
                  scheduleClearDoctorStatus(650);
                } else {
                  scheduleClearDoctorStatus(450);
                }
              }
              clearZapWatchdog();
              clearAutoRetry();
              setIsLoading(false);
              setHasError(false);
              setIsPlaying(true);
            }}
            onLoadedMetadata={(event) => {

              if (!isVod && isVerbosePlaybackLogging()) {
                const diagnostic = channelSwitchDiagnosticRef.current;
                if (diagnostic && diagnostic.generation === streamLoadGenerationRef.current && !diagnostic.completed) {
                  appLog(`CSATORNAVÁLTÁS METAADAT; csatorna=${diagnostic.channelName}; teljes-eltelt=${Date.now() - diagnostic.startedAt} ms; próba-eltelt=${Date.now() - diagnostic.attemptStartedAt} ms; próba=${diagnostic.attemptNumber}; ${videoDiagnosticState(event.currentTarget, 'loadedmetadata')}`);
                }
              }
            }}
            onCanPlay={(event) => {

              if (!isActiveMediaEvent(event.currentTarget)) return;
              setIsLoading(false);
              setHasError(false);
              if (!isVod && isVerbosePlaybackLogging()) {
                const diagnostic = channelSwitchDiagnosticRef.current;
                if (diagnostic && diagnostic.generation === streamLoadGenerationRef.current && !diagnostic.canPlayLogged) {
                  diagnostic.canPlayLogged = true;
                  appLog(`CSATORNAVÁLTÁS CANPLAY; csatorna=${diagnostic.channelName}; teljes-eltelt=${Date.now() - diagnostic.startedAt} ms; próba-eltelt=${Date.now() - diagnostic.attemptStartedAt} ms; próba=${diagnostic.attemptNumber}; ${videoDiagnosticState(event.currentTarget, 'canplay')}`);
                }
              }
            }}
            onWaiting={(event) => {
              if (!isActiveMediaEvent(event.currentTarget)) return;
              doctorSessionRef.current.waitingOrStalledFlag = true;
              if (playbackStartedRef.current) {
                setIsLoading(true);
                showDoctorStatus({
                  phase: 'buffering',
                  title: 'Pufferelési probléma',
                  detail: isVod
                    ? 'Film / sorozat pufferének feltöltése…'
                    : 'Élő adás pufferének stabilizálása…',
                });
                armBufferWatchdog();
              }
              if (!isVod && isVerbosePlaybackLogging()) {
                const diagnostic = channelSwitchDiagnosticRef.current;
                if (diagnostic && diagnostic.generation === streamLoadGenerationRef.current && !diagnostic.waitingLogged && !diagnostic.completed) {
                  diagnostic.waitingLogged = true;
                  appLog(`CSATORNAVÁLTÁS VÁRAKOZÁS; csatorna=${diagnostic.channelName}; teljes-eltelt=${Date.now() - diagnostic.startedAt} ms; próba-eltelt=${Date.now() - diagnostic.attemptStartedAt} ms; próba=${diagnostic.attemptNumber}; ${videoDiagnosticState(event.currentTarget, 'waiting')}`);
                }
              }
            }}
            onStalled={(event) => {
              if (!isActiveMediaEvent(event.currentTarget)) return;
              doctorSessionRef.current.waitingOrStalledFlag = true;
              if (playbackStartedRef.current) {
                setIsLoading(true);
                showDoctorStatus({
                  phase: 'buffering',
                  title: 'Pufferelési probléma',
                  detail: isVod
                    ? 'Adatfolyam várakozik, hálózati felügyelet…'
                    : 'Akadozó jel felügyelete…',
                });
                armBufferWatchdog();
              }
              if (!isVod && isVerbosePlaybackLogging()) {
                const diagnostic = channelSwitchDiagnosticRef.current;
                if (diagnostic && diagnostic.generation === streamLoadGenerationRef.current) {
                  appLog(`CSATORNAVÁLTÁS STALLED; csatorna=${diagnostic.channelName}; teljes-eltelt=${Date.now() - diagnostic.startedAt} ms; próba-eltelt=${Date.now() - diagnostic.attemptStartedAt} ms; próba=${diagnostic.attemptNumber}; ${videoDiagnosticState(event.currentTarget, 'stalled')}`);
                }
              }
            }}
            onError={(event) => {
              const video = event.currentTarget;
              if (!isActiveMediaEvent(video)) {
                appLog('CSATORNAVÁLTÁS RÉGI MÉDIAESEMÉNY KIHAGYVA; ok=az előző src error eseménye nem írhatja át az új próbát.');
                return;
              }
              clearBufferWatchdog();
              const diagnostic = channelSwitchDiagnosticRef.current;
              if (!isVod && (!diagnostic || diagnostic.generation !== streamLoadGenerationRef.current)) return;
              if (!isVod && diagnostic) {
                appLogCritical(`CSATORNAVÁLTÁS HIBA; csatorna=${diagnostic.channelName}; teljes-eltelt=${Date.now() - diagnostic.startedAt} ms; próba-eltelt=${Date.now() - diagnostic.attemptStartedAt} ms; próba=${diagnostic.attemptNumber}; ${videoDiagnosticState(event.currentTarget, 'error')}`);
              }
              setIsLoading(false);
              setErrorMessage('A TV nem tudta lejátszani az adatfolyamot. HLS/codec vagy stream URL hiba lehet.');
              const mediaErrCode = video.error ? `MEDIA_ERR_${video.error.code}` : 'MEDIA_ERR_UNKNOWN';
              const mediaErrMsg = video.error?.message || 'médiaelem hiba';
              if (isVod) {
                // Film/sorozat: NEM végleges hibaképernyő. Ugyanaz a cím,
                // ugyanarról a pozícióról, automatikusan.
                setHasError(false);
                notifyTvDoctorIncident('media_error', video, mediaErrCode, mediaErrMsg);
                vodRecoveryRef.current('videó elem hiba');
                return;
              }
              notifyTvDoctorIncident('media_error', video, mediaErrCode, mediaErrMsg);
              if (playbackStartedRef.current) {
                // Már volt kép: először az eredeti címet próbáljuk újra,
                // nem kezdjük elölről a formátum-sorozatot.
                setHasError(false);
                requestRecoveryRef.current('stream hiba lejátszás közben');
                return;
              }
              scheduleAutoRetry();
            }}
            onPause={(event) => {

              if (!isActiveMediaEvent(event.currentTarget)) return;
              // A belső forrásváltás pause eseménye késve is megérkezhet:
              // ilyenkor NEM szabad leállítani az új, már futó streamet.
              if (switchInProgressRef.current) return;
              const video = event.currentTarget;
              if (!video.paused || video.ended) return;
              // A webOS néha a pause eseményt küldi előbb, és csak utána
              // állítja be az ended flaget. A véges idővonal végét ilyenkor is
              // terminális live-endként kezeljük, különben az ismételt M2/Moziverzum
              // lezárás mindig nulláról kezdené a recovery-sorozatot.
              const pausedEndState = {
                ended: video.ended,
                paused: video.paused,
                desiredPlaying: desiredPlayingRef.current,
                playbackStarted: playbackStartedRef.current,
                currentTime: Number(video.currentTime || 0),
                duration: Number(video.duration || 0),
              };
              if (isUnexpectedLiveEnd(pausedEndState)) {
                appLog(`ÉLŐ VÉGE (pause); csatorna=${channelRef.current?.name || 'élő adás'}; ` +
                  `t=${pausedEndState.currentTime.toFixed(2)} s; duration=${pausedEndState.duration.toFixed(2)} s; ` +
                  `${videoDiagnosticState(video, 'pause/ended')}`);
                setIsLoading(true);
                setHasError(false);
                notifyTvDoctorIncident('unexpected_end', video, 'LIVE_PAUSED_END', `pause/duration=${pausedEndState.duration.toFixed(1)}s`);
                requestRecoveryRef.current(`élő adás vége – pause/duration=${pausedEndState.duration.toFixed(2)} s`);
                return;
              }
              // Ritka webOS-fagyásnál a médiaelem maga áll le, miközben a
              // néző továbbra is lejátszást kér. A korábbi kód ilyenkor
              // `isPlaying=false`-ra váltott, ezért a figyelő is leállt, és
              // csak másik csatorna kiválasztása indította újra. Most a
              // váratlan pause azonnal ugyanazon a címen helyreállítást kér.
              if (desiredPlayingRef.current && playbackActiveRef.current && playbackStartedRef.current) {
                setIsLoading(true);
                setHasError(false);
                notifyTvDoctorIncident('unexpected_pause', video, 'UNEXPECTED_PAUSE', 'váratlan pause esemény');
                requestRecoveryRef.current('váratlan pause esemény – automatikus újraindítás');
                return;
              }
              setIsPlaying(false);
            }}
            onPlay={(event) => {

              if (!isActiveMediaEvent(event.currentTarget)) return;
              if (switchInProgressRef.current) return;
              if (event.currentTarget.paused) return;
              setIsPlaying(true);
            }}
            onEnded={(event) => {
              const video = event.currentTarget;
              if (!isActiveMediaEvent(video)) return;
              if (isVod) {
                const position = Math.max(0, Number(video.currentTime || 0));
                const duration = Number(video.duration || 0);
                // A szolgáltató gyakran egyszerűen elvágja a kapcsolatot:
                // ilyenkor a HTML5 `ended` eseményt küld a film VÉGE nélkül.
                // Ne ugorjunk a következő részre – álljunk vissza a pozícióra.
                if (isPrematureVodEnd(position, duration)) {
                  appLog(`VOD KORAI VÉG; pozíció=${Math.round(position)} mp; hossz=${Math.round(duration)} mp; ok=a kapcsolat megszakadt, visszaállítás.`);
                  notifyTvDoctorIncident('unexpected_end', video, 'VOD_PREMATURE_END', `korai ended ${Math.round(position)}/${Math.round(duration)}s`);
                  vodRecoveryRef.current('korai ended esemény');
                  return;
                }
                onEndedRef.current?.();
                return;
              }
              // Élő TV-n az ended soha nem jelenthet „következő műsort” vagy
              // csatornaelhagyást. A #13 M2 UHD-nél a webOS 85,778 mp után
              // véges VOD-ként zárta le a raw TS-t; ugyanazon a csatornán
              // kell újracsatlakozni, majd két igazolt ismétlés után a másik
              // formátumot is kipróbálni.
              const endState = {
                ended: video.ended,
                paused: video.paused,
                desiredPlaying: desiredPlayingRef.current,
                playbackStarted: playbackStartedRef.current,
                currentTime: Number(video.currentTime || 0),
                duration: Number(video.duration || 0),
              };
              if (isUnexpectedLiveEnd(endState)) {
                appLog(`ÉLŐ VÉGE; csatorna=${channelRef.current?.name || 'élő adás'}; ` +
                  `t=${endState.currentTime.toFixed(2)} s; duration=${Number(endState.duration).toFixed(2)} s; ` +
                  `paused=${video.paused}; ended=${video.ended}; ${videoDiagnosticState(video, 'ended')}`);
                notifyTvDoctorIncident('unexpected_end', video, 'LIVE_ENDED', `ended duration=${Number(endState.duration).toFixed(1)}s`);
                requestRecoveryRef.current(`élő adás vége – duration=${Number(endState.duration).toFixed(2)} s`);
              } else if (desiredPlayingRef.current && playbackActiveRef.current && !playbackStartedRef.current) {
                // Indulás közbeni ended: a normál TS/HLS indítási próbák
                // következő, kontrollált lépése döntsön.
                notifyTvDoctorIncident('unexpected_end', video, 'STARTUP_ENDED', 'indulás közbeni ended');
                scheduleAutoRetry();
              }
            }}
            onTimeUpdate={(event) => {
              const video = event.currentTarget as HTMLVideoElement;
              if (!isActiveMediaEvent(video)) return;
              if (!isVod) {

                return;
              }
              const position = Math.max(0, Number(video.currentTime || 0));
              const duration = Math.max(0, Number(video.duration || 0));
              vodLastPositionRef.current = position;
              vodPositionKnownRef.current = true;
              // Az idővonal állapotát csak akkor írjuk ki, ha az OSD látszik
              // (a rejtett csúszka nem látszik, felesleges másodpercenként
              // újrarajzolni a teljes lejátszót).
              if (showControlsOverlay) {
                setVodDuration(duration);
                setVodCurrentTime(position);
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

      {/*
        TÖLTÉS / ÚJRACSATLAKOZÁS JELZŐ.
        Az indulásnál (még nincs képkocka) a megszokott teljes képernyős
        „Gyors kapcsolódás...” látszik. Ha viszont már VAN kép, a réteg NEM
        lehet fekete és NEM takarhatja el a videót: csak egy kis, áttetsző
        jelző megy a sarokba. Így a hang és a kép együtt marad.
      */}
      {(isLoading || isRecovering) && (currentStreamHasFrame ? (
        <div
          data-playback-status=""
          className={`${isFullscreen && settings.tvDoctorEnabled !== false ? 'hidden ' : ''}absolute flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 pointer-events-none ${
            isFullscreen
              ? (settings.alwaysShowBlueClock ? 'top-[4.75rem] right-3 bottom-auto left-auto z-[80]' : 'top-3 right-3 bottom-auto left-auto z-[80]')
              : 'bottom-3 left-3 z-30'
          }`}
        >
          <div className="h-4 w-4 shrink-0 rounded-full border-2 border-cyan-400/40 border-t-cyan-300 animate-spin" />
          <span className="text-[11px] font-semibold text-cyan-100 tracking-wide">
            {isRecovering ? 'Újracsatlakozás…' : 'Pufferelés…'}
          </span>
        </div>
      ) : (
        /* A „Gyors kapcsolódás...” felirat háttere is FEKETE (2.5.165). */
        <div data-playback-loading="" className="absolute inset-0 flex flex-col items-center justify-center bg-black z-10 pointer-events-none">
          <div className="relative w-12 h-12 flex items-center justify-center">
            <div className="w-12 h-12 rounded-full border-3 border-cyan-500/30 border-t-cyan-400 animate-spin" />
            <div className="absolute w-6 h-6 rounded-full bg-cyan-400/20 animate-ping" />
          </div>
          <span className="mt-2 text-xs font-semibold text-cyan-200 tracking-wider">
            Gyors kapcsolódás...
          </span>
        </div>
      ))}

      {/* Stream Error Overlay with fallback launcher */}
      {hasError && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center bg-black z-20 p-4 text-center"
        >
          <h4 className="text-white font-bold text-sm sm:text-base whitespace-pre-line">
            {errorMessage || "A csatornát nem lehet be tölteni !\nkapcsolj másik csatornára...\nez a sz@r le fagyott 😂"}
          </h4>
          {/* A távirányító OK gombjával is elérhető kézi újrapróbálás.
              A webos.js a fókuszban lévő BUTTON-t Enterre aktiválja. */}
          <button
            ref={retryButtonRef}
            type="button"
            data-player-retry=""
            onClick={(e) => {
              e.stopPropagation();
              clearRecovery();
              recoveryAttemptRef.current = 0;
              liveEndRecoveryAttemptRef.current = 0;
              liveRecoveryOnlyRef.current = false;
              doctorSessionRef.current.channelHaltedDead = false;
              doctorSessionRef.current.repairStep = 0;
              doctorSessionRef.current.lastProposal = null;
              endSwitch();
              setHasError(false);
              setErrorMessage('');
              setIsLoading(false);
              loadStreamRef.current(pendingStreamUrlRef.current || streamUrl, true);
            }}
            className="mt-4 rounded-xl border-2 border-amber-400/70 bg-amber-400/15 px-5 py-2 text-sm font-bold text-amber-200"
          >
            Újrapróbálás
          </button>
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

      {/* Teljes képernyős jobb felső sáv: 3D TV Doktor ikon az óra előtt (azonos méretben), kék óra és aktív állapotablak. */}
      {isFullscreen && (() => {
        const tvDoctorEnabled = settings.tvDoctorEnabled !== false;
        const isCurrentContentHandled =
          doctorStoreRevision >= 0 &&
          tvDoctorEnabled &&
          (isVod
            ? Boolean(vodSessionAssisted || isVodHandledByDoctor(buildVodDoctorTarget(customStreamUrl)))
            : isChannelHandledByDoctor(channel));
        return (
          <TvDoctorFullscreenHud
            isFullscreen={isFullscreen}
            doctorEnabled={tvDoctorEnabled}
            handled={isCurrentContentHandled}
            status={doctorStatus}
            showClock={Boolean(settings.alwaysShowBlueClock)}
            clockNode={
              <BlueClock
                inDoctorHud
                // A teljes képernyős óra is ugyanazt a 1–6 távirányítós színt követi,
                // nem marad mindig kék a fejléc színváltása után.
                accent={liveAccent}
                offsetHours={settings.clockOffsetHours}
                className="box-border flex h-14 w-40 items-center justify-center rounded-full border border-transparent bg-black/65 p-0 font-mono text-5xl font-black tracking-wider shadow-none pointer-events-none"
              />
            }
          />
        );
      })()}

      {/* VOD CC: a muxolt felirat is az OSD-hez kötött saját rétegen jelenik meg. */}
      {isVod && vodSubtitleCues.length === 0 && !providerSubtitleActiveRef.current && (
        <HtmlVodSubtitleOverlay
          videoRef={htmlVideoRef}
          trackId={activeVodSubtitleId}
          scalePercent={Number(String(settings.subtitleSize || '100%').replace('%', '')) || 100}
          raised={showControlsOverlay}
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
          <>
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
              menu={vodTrackMenu === 'combined' ? null : vodTrackMenu}
              onMenuChange={setVodTrackMenu}
              onTogglePlay={togglePlay}
              onSeekBy={seekVodByConfiguredStep}
              onSeekTo={seekVod}
              onSelectAudio={selectVodAudio}
              onSelectSubtitle={selectVodSubtitle}
              onClose={() => onCloseVod?.()}
              onToggleMute={onToggleMute}
              onActivity={handleVodOsdActivity}
              rootRef={vodOsdRef}
            />
            <LiveAudioCcSelector
              isOpen={vodTrackMenu === 'combined'}
              preferOffWhenUnselected
              onClose={() => setVodTrackMenu(null)}
              audioTracks={vodAudioTracks}
              onSelectAudioTrack={selectVodAudio}
              subtitleTracks={availableVodSubtitleTracks}
              onSelectSubtitleTrack={selectVodSubtitle}
            />
          </>
        ) : null}
      </div>
    </div>
  );
};
