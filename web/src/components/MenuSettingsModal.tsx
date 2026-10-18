import { ChannelLogo } from './ChannelLogo';
import React, { useEffect, useRef, useState } from 'react';
import { AppSettings, Channel, FavoriteFolder, ProviderAccount, BufferMode, SubtitleSize, WatchHistoryItem } from '../types/iptv';
import {
  SlidersHorizontal,
  X,
  Tv,
  FolderPlus,
  Play,
  RefreshCw,
  Plus,
  Film,
  Trash2,
  Check,
  Bug,
  Copy,
  Edit3,
  Smartphone,
  Heart,
  Star,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  Waves,
  PanelsTopLeft,
  Clock,
  Cast,
  ListOrdered,
  MousePointerClick
} from 'lucide-react';
import { storageService } from '../services/storageService';
import { clearAppLog, getAppLogText, logMemory } from '../services/appLog';
import { WEB_VERSION, WEB_VERSION_HISTORY } from '../appVersion';

interface MenuSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: 'lists' | 'favorites' | 'system';
  setActiveTab: (tab: 'lists' | 'favorites' | 'system') => void;
  channels: Channel[];
  settings: AppSettings;
  onUpdateSettings: (newSettings: Partial<AppSettings>) => void;
  providers: ProviderAccount[];
  onOpenAddProvider: () => void;
  onEditProvider: (provider: ProviderAccount) => void;
  onDeleteProvider: (id: string) => void;
  onRefreshProvider: (id: string) => void;
  onOpenImportDiagnostic: (provider: ProviderAccount) => void;
  folders: FavoriteFolder[];
  onOpenAddFolder: () => void;
  onDeleteFolder: (folderId: string) => void;
  onToggleFavorite: (channelId: string) => void;
  onMoveFavoriteChannel: (folderId: string, channelId: string, direction: 'up' | 'down') => void;
  onRemoveChannelFromFolder: (folderId: string, channelId: string) => void;
  onOpenEpgModal: () => void;
  onOpenQrProvision?: () => void;
  watchHistory: WatchHistoryItem[];
  onContinueWatching: (item: WatchHistoryItem) => void;
  onRemoveWatchHistoryItem: (id: string) => void;
}

export const MenuSettingsModal: React.FC<MenuSettingsModalProps> = ({
  isOpen,
  onClose,
  activeTab,
  setActiveTab,
  channels,
  settings,
  onUpdateSettings,
  providers,
  onOpenAddProvider,
  onEditProvider,
  onDeleteProvider,
  onRefreshProvider,
  onOpenImportDiagnostic,
  folders,
  onOpenAddFolder,
  onDeleteFolder,
  onMoveFavoriteChannel,
  onRemoveChannelFromFolder,
  watchHistory,
  onContinueWatching,
  onRemoveWatchHistoryItem,
}) => {
  const [githubTokenName, setGithubTokenName] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [githubOwner, setGithubOwner] = useState('Robko1');
  const [githubRepo, setGithubRepo] = useState('LGtv');
  const [githubConfigured, setGithubConfigured] = useState(false);
  const [githubStatus, setGithubStatus] = useState('');
  const [githubUpdating, setGithubUpdating] = useState(false);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const [diagnosisProgress, setDiagnosisProgress] = useState<{
    phase: string; percent: number; step: string; message?: string; runUrl?: string;
  } | null>(null);
  const [diagnosisCountdown, setDiagnosisCountdown] = useState<number | null>(null);
  const [videoDiagnosticOpen, setVideoDiagnosticOpen] = useState(false);
  const [videoDiagnosticLogOpen, setVideoDiagnosticLogOpen] = useState(false);
  const [videoDiagnosticText, setVideoDiagnosticText] = useState('');
  const [videoDiagnosticStatus, setVideoDiagnosticStatus] = useState('');
  const [noWebUpdate, setNoWebUpdate] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showApplicationBox, setShowApplicationBox] = useState(false);
  const [expandedFavoriteFolderId, setExpandedFavoriteFolderId] = useState<string | null>(null);
  const [movingFavoriteChannelId, setMovingFavoriteChannelId] = useState<string | null>(null);
  const favoriteLongPressTimer = useRef<number | null>(null);
  const suppressFavoriteClick = useRef(false);
  const lastFavoriteReorderTapAt = useRef(0);

  const clearFavoriteLongPress = () => {
    if (favoriteLongPressTimer.current !== null) {
      window.clearTimeout(favoriteLongPressTimer.current);
      favoriteLongPressTimer.current = null;
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const api = (window as any).IPTVNative;
    if (!api?.githubConfig) return;
    try {
      const cfg = api.githubConfig();
      setGithubTokenName(cfg?.tokenName || '');
      setGithubOwner('Robko1');
      setGithubRepo('LGtv');
      setGithubConfigured(Boolean(cfg?.configured));
      setGithubToken('');
      setGithubStatus('');
    } catch {
      // Böngészőben vagy régi APK-ban a GitHub beállítás nem érhető el.
    }
  }, [isOpen]);

  useEffect(() => {
    const api = (window as any).IPTVNative;
    if (!api?.on) return;
    const listener = (event: any) => {
      if (event?.type === 'github-test') {
        setGithubStatus(event.ok ? 'Kapcsolat rendben.' : (event.message || 'Kapcsolati hiba.'));
      }
      if (event?.type === 'github-diagnosis-progress') {
        const stepText = String(event.step || '');
        const messageText = String(event.message || '');
        if (/no source changes|nincs változás|nincs új forrásváltozás|naprakész/i.test(stepText + ' ' + messageText)) {
          setNoWebUpdate(true);
          setGithubUpdating(false);
          setDiagnosisOpen(true);
          setDiagnosisProgress({
            phase: 'completed',
            percent: 100,
            step: 'Nincs frissítés – az IPTV naprakész.',
            message: '',
            runUrl: event.runUrl || ''
          });
          setDiagnosisCountdown(3);
          return;
        }
        setDiagnosisOpen(true);
        setDiagnosisProgress({
          phase: event.phase || 'running',
          percent: Math.max(0, Math.min(100, Number(event.percent) || 0)),
          step: event.step || 'Feldolgozás…',
          message: event.message || '',
          runUrl: event.runUrl || ''
        });
        if (event.phase === 'failed') {
          setNoWebUpdate(false);
          setGithubUpdating(false);
          setDiagnosisCountdown(null);
          setGithubStatus(event.message || event.step || 'A webdiagnózis hibával leállt.');
        }
      }
      if (event?.type === 'github-web-update') {
        setGithubUpdating(false);
        setGithubStatus(event.ok ? 'GitHub frissítés kész.' : (event.message || 'Frissítési hiba.'));
        if (event.ok) {
          const unchanged = /nincs frissítés|naprakész/i.test(String(event.message || ''));
          setNoWebUpdate(unchanged);
          setDiagnosisOpen(true);
          setDiagnosisProgress((current) => ({
            phase: 'completed',
            percent: 100,
            step: unchanged ? 'Nincs frissítés – az IPTV naprakész.' : (event.message || 'A webes felület frissítése sikerült.'),
            message: '',
            runUrl: current?.runUrl || ''
          }));
          setDiagnosisCountdown(unchanged ? 3 : 5);
        } else {
          setNoWebUpdate(false);
          setDiagnosisOpen(true);
          setDiagnosisCountdown(null);
          setDiagnosisProgress((current) => ({
            phase: 'failed',
            percent: current?.percent || 0,
            step: 'A kész webes felület letöltése vagy betöltése nem sikerült.',
            message: event.message || 'Ismeretlen frissítési hiba.',
            runUrl: current?.runUrl || ''
          }));
        }
      }
    };
    api.on(listener);
    return () => api.off?.(listener);
  }, []);

  useEffect(() => {
    if (diagnosisCountdown === null) return;
    if (diagnosisCountdown <= 0) {
      setDiagnosisOpen(false);
      setDiagnosisCountdown(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setDiagnosisCountdown((value) => value === null ? null : value - 1);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [diagnosisCountdown]);

  const saveGithubSettings = () => {
    const api = (window as any).IPTVNative;
    if (!api?.githubSaveConfig) {
      setGithubStatus('Ez a beállítás csak Android APK-ban érhető el.');
      return;
    }
    api.githubSaveConfig(githubTokenName, githubToken, 'Robko1', 'LGtv');
    setGithubConfigured(Boolean(githubToken) || githubConfigured);
    setGithubToken('');
    setGithubStatus('Beállítások mentve.');
  };

  const updateGithubWeb = () => {
    const api = (window as any).IPTVNative;
    setDiagnosisOpen(true);
    setDiagnosisCountdown(null);
    setNoWebUpdate(false);
    setDiagnosisProgress({
      phase: 'running',
      percent: 1,
      step: 'IPTV-tesztek és webfrissítés indítása…',
      message: '',
      runUrl: ''
    });
    if (!api?.githubRunWebDiagnosis) {
      setGithubUpdating(false);
      setDiagnosisProgress({
        phase: 'failed',
        percent: 0,
        step: 'Ehhez az új frissítési funkcióhoz APK-frissítés szükséges.',
        message: 'A telepített APK natív hídja még nem tudja elindítani a GitHub Actions diagnózist. Az új APK telepítése után használható.',
        runUrl: ''
      });
      return;
    }
    setGithubUpdating(true);
    setGithubStatus('IPTV-tesztek és webfrissítés indítása…');
    api.githubRunWebDiagnosis();
  };

  const refreshVideoDiagnostics = (clearOld = false) => {
    const api = (window as any).IPTVNative as {
      nativeVideoDiagnostics?: () => string;
      clearNativeVideoDiagnostics?: () => void;
    } | undefined;
    // A webes oldal saját naplója (tartalom betöltése, mentés, memória)
    // mindig a natív napló után jelenik meg: ez mutatja meg, mi történt a
    // felületen a lefagyás vagy az üres lista előtt.
    const webSection = () => {
      try {
        logMemory('naplókérés');
        return '\n\n' + getAppLogText();
      } catch (error) {
        return '\n\n--- WEBES NAPLÓ ---\nA webes napló nem érhető el: ' + String(error);
      }
    };
    if (clearOld) clearAppLog();
    if (clearOld && api?.clearNativeVideoDiagnostics) {
      try {
        api.clearNativeVideoDiagnostics();
      } catch {
        /* régi APK-ban nincs clear */
      }
    }
    if (!api?.nativeVideoDiagnostics) {
      setVideoDiagnosticText(
        'A natív videódiagnosztika ebben a környezetben nem érhető el (Android APK szükséges).'
        + webSection()
      );
      setVideoDiagnosticStatus('Diagnosztikai adatforrás nem érhető el.');
      return;
    }
    try {
      setVideoDiagnosticText(
        String(api.nativeVideoDiagnostics() || 'A natív diagnosztikai napló üres.') + webSection()
      );
      setVideoDiagnosticStatus(
        clearOld
          ? 'A régi napló törölve, új naplózás indul – a vágólap még nem változott.'
          : 'A diagnosztikai adatok frissítve. A vágólap még nem változott.'
      );
    } catch (error) {
      setVideoDiagnosticText('A napló lekérése sikertelen: ' + String(error) + webSection());
      setVideoDiagnosticStatus('Lekérési hiba.');
    }
  };

  const openVideoDiagnostics = () => {
    setVideoDiagnosticOpen(true);
    setVideoDiagnosticLogOpen(false);
    setVideoDiagnosticStatus('');
    refreshVideoDiagnostics(false);
  };

  /**
   * A napló másolása.
   *
   * KIZÁRÓLAG ennek a gombnak a megnyomása írhat a telefon vágólapjára, és
   * pontosan azt a szöveget másolja, ami a naplómezőben látszik (a videó
   * naplóját vagy a TV-re küldés teszt eredményét) – semmi mást.
   */
  const copyVideoDiagnostics = async (event: React.MouseEvent<HTMLButtonElement>) => {
    // Csak valódi, felhasználói kattintás indíthat vágólapműveletet;
    // programozott/szintetikus eseményből soha ne másoljunk diagnosztikát.
    if (!event.nativeEvent.isTrusted) return;
    const api = (window as any).IPTVNative;
    let report = videoDiagnosticText.trim();
    if (!report && api?.nativeVideoDiagnostics) {
      report = String(api.nativeVideoDiagnostics() || '').trim();
      if (report) setVideoDiagnosticText(report);
    }
    if (!report) {
      setVideoDiagnosticStatus('Nincs másolható napló. Nyisd meg a naplót, majd frissítsd az adatokat.');
      return;
    }
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
        copied = true;
      }
    } catch {
      // Android WebView / file:// esetén az execCommand tartalékot próbáljuk.
    }
    if (!copied) {
      const field = document.createElement('textarea');
      field.value = report;
      field.setAttribute('readonly', 'true');
      field.style.position = 'fixed';
      field.style.left = '-10000px';
      field.style.top = '0';
      document.body.appendChild(field);
      field.focus();
      field.select();
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      document.body.removeChild(field);
    }
    setVideoDiagnosticStatus(copied
      ? 'Kész: csak a naplómezőben látható szöveg került a vágólapra.'
      : 'A másolás nem sikerült. Próbáld újra a „Napló másolása” gombbal.');
  };

  const testGithubSettings = () => {
    const api = (window as any).IPTVNative;
    if (!api?.githubSaveConfig || !api?.githubTestConnection) {
      setGithubStatus('Ez a teszt csak Android APK-ban érhető el.');
      return;
    }
    api.githubSaveConfig(githubTokenName, githubToken, githubOwner, githubRepo);
    setGithubConfigured(Boolean(githubToken) || githubConfigured);
    setGithubToken('');
    setGithubStatus('Kapcsolat tesztelése...');
    api.githubTestConnection();
  };

  // Valós idejű képesség-ellenőrzések: csak akkor jelenik meg zöld pipa,
  // ha az adott lejátszási mód ténylegesen elérhető az aktuális környezetben.
  const pictureInPictureAvailable =
    Boolean((document as any).pictureInPictureEnabled) ||
    typeof (window as any).IPTVNative?.pip === 'function';

  // TV / stick / egér: D-pad + egér támogatás a beállítások modalban
  const modalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const focusModal = () => {
      try {
        const container = modalRef.current;
        if (!container) return;
        // Fókusz a modal konténerre vagy első fókuszálható elemre
        const focusable = container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length > 0) {
          // Első nem input legyen fókuszban TV-n (hogy D-pad működjön)
          const firstButton = Array.from(focusable).find(el => el.tagName === 'BUTTON') as HTMLElement | undefined;
          (firstButton || focusable[0])?.focus({ preventScroll: true } as any);
        } else {
          container.focus();
        }
      } catch {}
    };
    const t1 = window.setTimeout(focusModal, 100);
    const t2 = window.setTimeout(focusModal, 500);
    const t3 = window.setTimeout(focusModal, 1000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [isOpen, activeTab]);

  const handleModalKeyDown = (e: React.KeyboardEvent) => {
    // TV távirányító: D-pad navigáció a modalban
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      try {
        const container = modalRef.current;
        if (!container) return;
        const focusable = Array.from(container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(el => !el.hasAttribute('disabled') && (el as HTMLElement).offsetParent !== null);
        if (focusable.length === 0) return;
        const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'ArrowDown') {
          const next = focusable[(currentIndex + 1) % focusable.length];
          next?.focus();
          next?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else {
          const prev = focusable[(currentIndex - 1 + focusable.length) % focusable.length];
          prev?.focus();
          prev?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      } catch {}
    } else if (e.key === 'Escape' || e.key === 'Backspace') {
      // TV Back / Esc: modal bezárás
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'INPUT' && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
      // Enter a fókuszált gombon
      // A natív click már megy, de biztosítjuk
    }
  };

  if (!isOpen) return null;

  const handleClearCache = () => {
    if (confirm('Biztosan törlöd a gyorsítótárat és visszaállítod az alapértelmezett állapotot?')) {
      storageService.clearCache();
      window.location.reload();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/75 backdrop-blur-xs animate-fadeIn select-none lg:select-auto" role="dialog" aria-modal="true" aria-label="Menü és beállítások" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={modalRef} tabIndex={-1} onKeyDown={handleModalKeyDown} className="w-full max-w-lg md:max-w-xl lg:max-w-2xl xl:max-w-3xl 2xl:max-w-4xl h-full bg-[#071124] border-l border-cyan-900/40 flex flex-col shadow-2xl animate-slideLeft overflow-hidden focus:outline-none">
        
        {/* Header Modal Bar (Exact match to screenshot 1/2/3/4/5) */}
        <div className="p-4 bg-[#0a1835] border-b border-cyan-950 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <SlidersHorizontal className="w-5 h-5 text-amber-400 stroke-[2.5]" />
            <h2 className="text-lg font-black text-amber-400 tracking-wider">
              MENÜ & BEÁLLÍTÁSOK
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-slate-300 active:scale-90 transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 4 Navigation Tabs Pills */}
        <div className="px-3 py-2 bg-[#081329] border-b border-cyan-950/60 flex items-center gap-1.5 overflow-x-auto no-scrollbar">


          <button
            onClick={() => setActiveTab('lists')}
            className={`flex-1 min-w-[80px] py-2 px-2.5 rounded-xl text-xs font-black transition-all text-center truncate ${
              activeTab === 'lists'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                : 'bg-[#0f2144] text-slate-300 hover:bg-[#152e5c]'
            }`}
          >
            Listák
          </button>

          <button
            onClick={() => setActiveTab('favorites')}
            className={`flex-1 min-w-[85px] py-2 px-2.5 rounded-xl text-xs font-black transition-all text-center truncate ${
              activeTab === 'favorites'
                ? 'bg-amber-400 text-slate-950 shadow-md shadow-amber-400/30'
                : 'bg-[#0f2144] text-slate-300 hover:bg-[#152e5c]'
            }`}
          >
            Kedvencek
          </button>

          <button
            onClick={() => setActiveTab('system')}
            className={`flex-1 min-w-[80px] py-2 px-2.5 rounded-xl text-xs font-black transition-all text-center truncate ${
              activeTab === 'system'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                : 'bg-[#0f2144] text-slate-300 hover:bg-[#152e5c]'
            }`}
          >
            Rendszer
          </button>
        </div>

        {/* Tab Content Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          
          {/* ================= TAB 2: LISTÁK ================= */}
          {activeTab === 'lists' && (
            <div className="space-y-4 animate-fadeIn">
              {/* Header with [+ Új lista] button (Screenshot 4) */}
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-black text-slate-200 tracking-wider uppercase">
                  M3U / Xtream Listák
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={onOpenQrProvision}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-black active:scale-95 transition-all shadow-md shadow-amber-400/25"
                    title="Telefonnal beállítás QR kóddal – nem kell TV-n pötyögni"
                  >
                    <Smartphone className="w-4 h-4" />
                    <span>📱 Telefon</span>
                  </button>
                  <button
                    onClick={onOpenAddProvider}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-black active:scale-95 transition-all shadow-md shadow-cyan-400/25"
                  >
                    <Plus className="w-4 h-4 stroke-[3]" />
                    <span>Új lista</span>
                  </button>
                </div>
              </div>

              {/* Providers List Cards (Screenshot 4) */}
              <div className="space-y-2.5">
                {providers.map((p) => {
                  return (
                    <div
                      key={p.id}
                      className={`p-3.5 rounded-2xl border transition-all ${
                        p.isActive
                          ? 'bg-[#0d1d3d] border-cyan-500/60 shadow-lg shadow-cyan-950/50 ring-1 ring-cyan-500/20'
                          : 'bg-[#09152b] border-slate-800 opacity-80'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-lg bg-amber-400/20 border border-amber-400/40 flex items-center justify-center text-amber-300 font-bold">
                            <Tv className="w-4 h-4 text-amber-400" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              {p.isActive && (
                                <span className="px-2 py-0.5 rounded-md bg-cyan-400 text-slate-950 text-[10px] font-black tracking-wide">
                                  AKTÍV
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Counts in Bright Cyan */}
                      <div className="mt-2 text-xs font-black text-cyan-300 tracking-tight">
                        {p.channelsCount.toLocaleString()} csatorna • {p.moviesCount.toLocaleString()} film • {p.seriesCount.toLocaleString()} sorozat
                      </div>

                      {/* Type & Date */}
                      <div className="mt-1 text-[11px] text-slate-400 font-medium">
                        {p.type === 'xtream' ? 'Xtream Codes' : 'M3U Lista'} • frissítve {p.lastUpdated}
                      </div>

                      {/* Provider Expiry in Yellow */}
                      <div className="mt-1 text-xs font-bold text-amber-400">
                        Provider lejárata: {p.expireDate} • {p.maxConnections} kapcsolat
                      </div>

                      {/* Action buttons */}
                      <div className="mt-3 pt-2.5 border-t border-cyan-900/40 flex items-center gap-2">
                        <button
                          onClick={() => onRefreshProvider(p.id)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#112347] hover:bg-[#172e5c] text-cyan-300 border border-cyan-600/30 text-xs font-bold active:scale-95 transition-all"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>Frissítés</span>
                        </button>

                        <button
                          onClick={() => onOpenImportDiagnostic(p)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-600/40 text-xs font-bold active:scale-95 transition-all"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Betöltés diagnosztikája</span>
                        </button>
                        <button
                          onClick={() => onEditProvider(p)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#112347] hover:bg-[#172e5c] text-slate-200 border border-slate-700 text-xs font-bold active:scale-95 transition-all"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>Szerkesztés</span>
                        </button>

                        <button
                          onClick={() => onDeleteProvider(p.id)}
                          className="p-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 border border-rose-800/40 ml-auto active:scale-95 transition-all"
                          title="Törlés"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Danger Zone: Clear all lists */}
              <button
                onClick={handleClearCache}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-rose-950/30 hover:bg-rose-950/60 text-rose-300 border border-rose-800/40 text-xs font-bold active:scale-95 transition-all"
              >
                <Trash2 className="w-4 h-4" />
                <span>Összes lista és tesztcsatorna törlése</span>
              </button>
            </div>
          )}

          {/* ================= TAB 3: KEDVENCEK ================= */}
          {activeTab === 'favorites' && (
            <div className="space-y-4 animate-fadeIn">
              {/* Header with [Új mappa] button (Screenshot 3) */}
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-black text-slate-200 tracking-wider uppercase">
                  Kedvenc Mappák
                </h3>
                <button
                  onClick={onOpenAddFolder}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-black active:scale-95 transition-all shadow-md shadow-amber-400/25"
                >
                  <FolderPlus className="w-4 h-4 stroke-[3]" />
                  <span>Új mappa</span>
                </button>
              </div>

              {/* A mappák kinyithatók; a bennük lévő csatornák sorrendje és tagsága itt is kezelhető. */}
              <div className="space-y-2.5">
                {folders.length === 0 ? (
                  <div className="rounded-2xl border-2 border-dashed border-cyan-500/60 p-6 text-center">
                    <FolderPlus className="w-8 h-8 text-slate-500 mx-auto mb-2" />
                    <p className="text-sm font-bold text-slate-300">Még nincs kedvenc mappád</p>
                    <p className="text-xs text-slate-500 mt-1">Az „Új mappa” gombbal létrehozhatod az elsőt.</p>
                  </div>
                ) : folders.map((f, folderIndex) => {
                  const folderChannels = f.channelIds
                    .map((id) => channels.find((channel) => channel.id === id))
                    .filter((channel): channel is Channel => Boolean(channel));
                  const expanded = expandedFavoriteFolderId === f.id;
                  return (
                    <div key={f.id} className={`rounded-2xl bg-[#0d1d3d] border-2 shadow-md overflow-hidden ${folderIndex % 2 === 0 ? 'border-cyan-500/80' : 'border-amber-400/80'}`}>
                      <div className="p-3.5 flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedFavoriteFolderId(expanded ? null : f.id);
                            setMovingFavoriteChannelId(null);
                          }}
                          className="flex items-center gap-3 min-w-0 flex-1 text-left"
                          aria-expanded={expanded}
                        >
                          <div className="w-10 h-10 rounded-xl bg-amber-400/20 border border-amber-400/40 flex items-center justify-center text-xl shrink-0">{f.icon || '📁'}</div>
                          <div className="min-w-0">
                            <h4 className="text-white font-bold text-sm truncate">{f.name}</h4>
                            <p className="text-xs text-slate-400 font-medium">{folderChannels.length} csatorna · {expanded ? 'Bezárás' : 'Megnyitás'}</p>
                          </div>
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`Biztosan törlöd ezt a mappát: „${f.name}”?`)) {
                              onDeleteFolder(f.id);
                              if (expandedFavoriteFolderId === f.id) setExpandedFavoriteFolderId(null);
                            }
                          }}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-950/30 border border-rose-800/50 text-rose-300 hover:bg-rose-900/50 text-xs font-bold shrink-0"
                          title="Mappa törlése"
                        >
                          <Trash2 className="w-4 h-4" />
                          <span>Törlés</span>
                        </button>
                      </div>
                      {expanded && (
                        <div className={`border-t p-2 space-y-1.5 ${folderIndex % 2 === 0 ? 'border-cyan-500/50' : 'border-amber-400/50'}`}>
                          {folderChannels.length === 0 ? (
                            <p className="p-4 text-center text-xs text-slate-400">Ez a kedvenc mappa üres.</p>
                          ) : folderChannels.map((channel, index) => {
                            const moving = movingFavoriteChannelId === channel.id;
                            return (
                              <div
                                key={channel.id}
                                onClick={() => {
                                  if (suppressFavoriteClick.current) {
                                    suppressFavoriteClick.current = false;
                                    return;
                                  }
                                  if (!movingFavoriteChannelId || movingFavoriteChannelId !== channel.id) return;
                                  const now = Date.now();
                                  if (now - lastFavoriteReorderTapAt.current <= 350) {
                                    setMovingFavoriteChannelId(null);
                                    lastFavoriteReorderTapAt.current = 0;
                                  } else {
                                    lastFavoriteReorderTapAt.current = now;
                                  }
                                }}
                                onPointerDown={(event) => {
                                  if ((event.target as HTMLElement).closest('button')) return;
                                  clearFavoriteLongPress();
                                  suppressFavoriteClick.current = false;
                                  favoriteLongPressTimer.current = window.setTimeout(() => {
                                    setMovingFavoriteChannelId(channel.id);
                                    lastFavoriteReorderTapAt.current = 0;
                                    suppressFavoriteClick.current = true;
                                  }, 1000);
                                }}
                                onPointerUp={clearFavoriteLongPress}
                                onPointerCancel={clearFavoriteLongPress}
                                onContextMenu={(event) => event.preventDefault()}
                                className={`flex items-center gap-2 rounded-xl p-2 border transition-colors ${moving ? 'bg-emerald-700/90 border-emerald-300 ring-2 ring-emerald-400/60' : 'bg-[#09152b] border-slate-700'}`}
                              >
                                <div className="w-9 h-7 rounded-md bg-black/20 border border-slate-700 p-0.5 shrink-0 flex items-center justify-center overflow-hidden">
                                  <ChannelLogo url={channel.logo} name={channel.name} retryKey={channel} />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="text-xs font-bold text-slate-100 truncate">{channel.name}</div>
                                  <div className="text-[10px] text-slate-400 truncate">{channel.num ? `#${channel.num}` : 'Csatorna'}</div>
                                </div>
                                {moving && (
                                  <>
                                    <button
                                      type="button"
                                      disabled={index === 0}
                                      onPointerDown={(event) => event.stopPropagation()}
                                      onClick={(event) => { event.stopPropagation(); onMoveFavoriteChannel(f.id, channel.id, 'up'); }}
                                      className="p-1.5 rounded-xl text-white bg-red-800/90 border border-red-400/70 disabled:opacity-20 active:scale-90"
                                      title="Mozgatás felfelé"
                                      aria-label={`${channel.name} mozgatása felfelé`}
                                    ><ArrowUp className="w-4 h-4" /></button>
                                    <button
                                      type="button"
                                      disabled={index === folderChannels.length - 1}
                                      onPointerDown={(event) => event.stopPropagation()}
                                      onClick={(event) => { event.stopPropagation(); onMoveFavoriteChannel(f.id, channel.id, 'down'); }}
                                      className="p-1.5 rounded-xl text-white bg-red-800/90 border border-red-400/70 disabled:opacity-20 active:scale-90"
                                      title="Mozgatás lefelé"
                                      aria-label={`${channel.name} mozgatása lefelé`}
                                    ><ArrowDown className="w-4 h-4" /></button>
                                  </>
                                )}
                                <button
                                  type="button"
                                  onPointerDown={(event) => event.stopPropagation()}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onRemoveChannelFromFolder(f.id, channel.id);
                                    if (movingFavoriteChannelId === channel.id) setMovingFavoriteChannelId(null);
                                  }}
                                  className="p-1.5 rounded-xl text-amber-400 hover:text-amber-300 active:scale-90"
                                  title="Eltávolítás a kedvenc mappából"
                                  aria-label={`${channel.name} eltávolítása a kedvenc mappából`}
                                ><Star className="w-4 h-4 fill-amber-400" /></button>
                              </div>
                            );
                          })}
                          {movingFavoriteChannelId && folderChannels.some((channel) => channel.id === movingFavoriteChannelId) && (
                            <p className="px-2 pb-1 text-[10px] text-emerald-300">Kijelölve rendezéshez · a piros nyilakkal mozgatható</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Folytatás: a félbehagyott filmek és sorozatrészek listája */}
              <section className="rounded-2xl border border-cyan-500/70 bg-[#0d1c3a] p-4 space-y-3 shadow-lg shadow-cyan-950/20">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 shrink-0 rounded-xl bg-cyan-400/15 border border-cyan-400/30 flex items-center justify-center">
                    <Play className="w-5 h-5 text-cyan-300 fill-cyan-300" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-black text-white tracking-wide">Folytasd ott, ahol abbahagytad</h3>
                    <p className="text-xs text-slate-300 leading-relaxed mt-1">
                      Itt találod a félbehagyott filmeket és sorozatrészeket. A Folytatás gombbal onnan nézheted tovább, ahol megálltál.
                    </p>
                  </div>
                </div>

                {watchHistory.filter((item) => item.mediaType === 'movie' || item.mediaType === 'series').length === 0 ? (
                  <div className="rounded-xl border border-dashed border-cyan-800/70 bg-black/10 px-3 py-5 text-center">
                    <Film className="w-7 h-7 text-slate-500 mx-auto mb-2" />
                    <p className="text-sm font-bold text-slate-200">Még nincs mit folytatni</p>
                    <p className="text-xs text-slate-400 mt-1">Kezdj el nézni egy filmet vagy sorozatot, és itt megjelenik.</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {watchHistory
                      .filter((item) => item.mediaType === 'movie' || item.mediaType === 'series')
                      .map((item) => (
                        <div key={item.id} className="rounded-xl border border-cyan-900/60 bg-[#071329]/80 p-3">
                          <div className="flex items-center gap-3">
                            <div className="w-14 h-[72px] shrink-0 rounded-lg overflow-hidden bg-slate-800 border border-slate-700">
                              {item.poster ? (
                                <img src={item.poster} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center"><Film className="w-6 h-6 text-slate-500" /></div>
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <span className="text-[10px] uppercase tracking-wider font-black text-cyan-300">
                                {item.mediaType === 'movie' ? 'Film' : 'Sorozat'}
                              </span>
                              <p className="text-sm font-bold text-white leading-snug break-words">{item.title}</p>
                              <p className="text-xs text-slate-400 mt-1">
                                {Math.max(0, Math.min(100, Math.round(item.progressPercent || 0)))}% megnézve
                              </p>
                              <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden mt-1.5">
                                <div className="h-full rounded-full bg-cyan-400" style={{ width: `${Math.max(0, Math.min(100, item.progressPercent || 0))}%` }} />
                              </div>
                            </div>
                          </div>
                          <div className="grid grid-cols-[1fr_auto] gap-2 mt-3">
                            <button
                              onClick={() => { onContinueWatching(item); onClose(); }}
                              className="min-h-11 flex items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-black shadow-md shadow-blue-950/40 active:scale-[0.99] transition-all"
                            >
                              <Play className="w-4 h-4 fill-current" />
                              Folytatás
                            </button>
                            <button
                              onClick={() => onRemoveWatchHistoryItem(item.id)}
                              className="min-h-11 px-3 flex items-center justify-center gap-1.5 rounded-xl bg-rose-950/40 hover:bg-rose-900/60 border border-rose-800/50 text-rose-300 text-xs font-bold transition-all"
                              title="Eltávolítás a folytatandók közül"
                            >
                              <Trash2 className="w-4 h-4" />
                              Eltávolítás
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* ================= TAB 4: RENDSZER (Exact match to Screenshots 1 & 2) ================= */}
          {activeTab === 'system' && (
            <div className="space-y-5 animate-fadeIn">
              
              {/* SECTION: LEJÁTSZÓ */}
              <div className="p-3.5 rounded-2xl bg-[#0a1630] border border-cyan-900/40 space-y-3.5 shadow-md">
                <h3 className="text-xs font-black text-amber-400 flex items-center gap-1.5 uppercase tracking-wider">
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Lejátszó</span>
                </h3>

                {/* Pufferelés */}
                <div className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5">
                  <label className="flex items-center gap-2 text-xs font-bold text-white">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/10"><Waves className="h-4 w-4 text-cyan-300" /></span>
                    <span>Pufferelés</span>
                  </label>
                  <p className="text-[11px] text-slate-400 leading-tight">
                    Gyors indítás = villámgyors csatornaváltás. Stabil = gyenge netnél kevesebb akadás.
                  </p>
                  <div className="grid grid-cols-3 gap-1.5 pt-1">
                    {(['fast', 'balanced', 'stable'] as BufferMode[]).map((bm) => (
                      <button
                        key={bm}
                        onClick={() => onUpdateSettings({ bufferMode: bm })}
                        className={`py-2 rounded-xl text-xs font-black transition-all ${
                          settings.bufferMode === bm
                            ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                            : 'bg-[#0e1f3f] text-slate-300 border border-slate-700/60 hover:bg-[#142b56]'
                        }`}
                      >
                        {bm === 'fast' ? 'Gyors' : (bm === 'balanced' ? 'Kiegyen...' : 'Stabil')}
                      </button>
                    ))}
                  </div>
                </div>

                {/* OSD automatikus elrejtése */}
                <div className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5">
                  <label className="flex items-center gap-2 text-xs font-bold text-white">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/10"><PanelsTopLeft className="h-4 w-4 text-cyan-300" /></span>
                    <span>OSD automatikus elrejtése</span>
                  </label>
                  <p className="text-[11px] text-slate-400 leading-tight">
                    A lejátszó vezérlőmenüje ennyi idő után automatikusan eltűnik.
                  </p>
                  <div className="grid grid-cols-5 gap-1.5 pt-1">
                    {[0, 2, 3, 4, 5].map((seconds) => (
                      <button
                        key={seconds}
                        onClick={() => onUpdateSettings({ osdHideDelay: seconds })}
                        className={`py-2 rounded-xl text-xs font-black transition-all ${
                          settings.osdHideDelay === seconds
                            ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                            : 'bg-[#0e1f3f] text-slate-300 border border-slate-700/60 hover:bg-[#142b56]'
                        }`}
                      >
                        {seconds === 0 ? 'Ki' : `${seconds} mp`}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Toggle: Kék óra mindig látszódjon */}
                <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm">
                  <div className="flex min-w-0 items-start gap-2.5 pr-3">
                    <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-sky-400/50 bg-sky-500/15 px-1.5 shadow-sm shadow-sky-950/40">
                      <Clock className="h-3.5 w-3.5 text-sky-300" />
                      <span className="font-mono text-[10px] font-black tracking-tight text-sky-200">00:00</span>
                    </span>
                    <div className="min-w-0">
                    <span className="text-xs font-bold text-white block">Kék óra mindig látszódjon</span>
                    <span className="text-[11px] text-slate-400 block">A kék óra az OSD2-ben jelenik meg, és teljes képernyőn az OSD elrejtése után is látható marad.</span>
                    </div>
                  </div>
                  <button
                    onClick={() => onUpdateSettings({ alwaysShowBlueClock: !settings.alwaysShowBlueClock })}
                    className={`w-12 h-6 rounded-full transition-colors relative shrink-0 p-0.5 ${settings.alwaysShowBlueClock ? 'bg-cyan-400' : 'bg-slate-700'}`}
                  >
                    <div className={`w-5 h-5 rounded-full bg-slate-950 shadow-md transition-transform ${settings.alwaysShowBlueClock ? 'translate-x-6' : 'translate-x-0'}`} />
                  </button>
                </div>
              </div>

              {/* SECTION: MOZI & SOROZAT (Screenshot 2) */}
              <div className="p-3.5 rounded-2xl bg-[#0a1630] border border-cyan-900/40 space-y-3.5 shadow-md">
                <h3 className="text-xs font-black text-amber-400 flex items-center gap-1.5 uppercase tracking-wider">
                  <Film className="w-3.5 h-3.5" />
                  <span>Mozi & Sorozat</span>
                </h3>

                {/* Tekerési lépés */}
                <div className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5">
                  <label className="text-xs font-bold text-white block">
                    Tekerési lépés
                  </label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[5, 10, 15, 30].map((s) => (
                      <button
                        key={s}
                        onClick={() => onUpdateSettings({ seekStep: s })}
                        className={`py-2 rounded-xl text-xs font-black transition-all ${
                          settings.seekStep === s
                            ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                            : 'bg-[#0e1f3f] text-slate-300 border border-slate-700/60 hover:bg-[#142b56]'
                        }`}
                      >
                        {s} mp
                      </button>
                    ))}
                  </div>
                </div>

                {/* Következő rész automatikusan */}
                <div className="flex items-center justify-between pt-1">
                  <div>
                    <span className="text-xs font-bold text-white block">
                      Következő rész automatikusan
                    </span>
                  </div>
                  <button
                    onClick={() => onUpdateSettings({ autoNextEpisode: !settings.autoNextEpisode })}
                    className={`w-12 h-6 rounded-full transition-colors relative shrink-0 p-0.5 ${
                      settings.autoNextEpisode ? 'bg-cyan-400' : 'bg-slate-700'
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full bg-slate-950 shadow-md transition-transform ${
                        settings.autoNextEpisode ? 'translate-x-6' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Preferált hangsáv nyelve */}
                <div className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5">
                  <label className="text-xs font-bold text-white block">
                    Preferált hangsáv nyelve
                  </label>
                  <p className="text-[11px] text-slate-400 leading-tight">
                    Ha a stream több nyelvet ad, automatikusan ezt választja.
                  </p>
                  <select
                    value={settings.preferredAudioLang}
                    onChange={(e) => onUpdateSettings({ preferredAudioLang: e.target.value })}
                    className="w-full bg-[#0e1f3f] border border-cyan-900/60 rounded-xl px-3 py-2 text-xs text-white focus:outline-hidden focus:border-cyan-400"
                  >
                    <option value="Magyar">Magyar</option>
                    <option value="Angol">Angol (Original)</option>
                    <option value="Német">Német</option>
                    <option value="Francia">Francia</option>
                    <option value="Olasz">Olasz</option>
                    <option value="Spanyol">Spanyol</option>
                  </select>
                </div>

                {/* Preferált felirat */}
                <div className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5">
                  <label className="text-xs font-bold text-white block">
                    Preferált felirat
                  </label>
                  <select
                    value={settings.preferredSubtitle}
                    onChange={(e) => onUpdateSettings({ preferredSubtitle: e.target.value })}
                    className="w-full bg-[#0e1f3f] border border-cyan-900/60 rounded-xl px-3 py-2 text-xs text-white focus:outline-hidden focus:border-cyan-400"
                  >
                    <option value="Kikapcsolva">Kikapcsolva</option>
                    <option value="Magyar">Magyar</option>
                    <option value="Angol">Angol</option>
                  </select>
                </div>

                {/* Felirat mérete */}
                <div className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5">
                  <label className="text-xs font-bold text-white block">
                    Felirat mérete
                  </label>
                  <div className="grid grid-cols-5 gap-1">
                    {(['75%', '100%', '125%', '150%', '200%'] as SubtitleSize[]).map((sz) => (
                      <button
                        key={sz}
                        onClick={() => onUpdateSettings({ subtitleSize: sz })}
                        className={`py-2 rounded-xl text-xs font-black transition-all ${
                          settings.subtitleSize === sz
                            ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                            : 'bg-[#0e1f3f] text-slate-300 border border-slate-700/60 hover:bg-[#142b56]'
                        }`}
                      >
                        {sz === '100%' ? '10...' : (sz === '125%' ? '12...' : (sz === '150%' ? '15...' : (sz === '200%' ? '20...' : sz)))}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* SECTION: ALKALMAZÁS / APK (Screenshot 1) */}
              <div className="p-3.5 rounded-2xl bg-[#0a1630] border border-cyan-900/40 space-y-3.5 shadow-md">
                <button
                  type="button"
                  onClick={() => setShowApplicationBox((open) => !open)}
                  className="w-full flex items-center justify-between text-left rounded-xl py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                  aria-expanded={showApplicationBox}
                >
                  <span className="text-xs font-black text-cyan-400 flex items-center gap-1.5 uppercase tracking-wider">
                    <Smartphone className="w-3.5 h-3.5" />
                    <span>Alkalmazás / APK</span>
                  </span>
                  <span className={`flex h-8 w-8 items-center justify-center rounded-full border border-cyan-400/50 bg-cyan-400/10 text-cyan-300 shadow-sm transition-colors ${showApplicationBox ? '': 'animate-pulse'}`} aria-hidden="true">
                    <ChevronDown className={`h-5 w-5 transition-transform duration-300 ${showApplicationBox ? 'rotate-180' : 'rotate-0'}`} strokeWidth={2.5} />
                  </span>
                </button>

{showApplicationBox && (
                  <>
                {/* Natív videódiagnosztika: csak a külön másolás gomb ír a vágólapra. */}
                <div className="p-3.5 rounded-2xl bg-[#0a1630] border border-cyan-500/50 space-y-3 shadow-md">
                  <div className="flex items-center gap-2 text-cyan-300">
                    <Bug className="w-4 h-4" />
                    <h3 className="text-xs font-black uppercase tracking-wider">Natív videó hibakeresése</h3>
                  </div>
                  <button
                    type="button"
                    onClick={openVideoDiagnostics}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-cyan-500/15 border border-cyan-400/40 text-cyan-200 text-xs font-black active:scale-95 transition-all"
                  >
                    <Bug className="w-4 h-4" />
                    Hibakeresési napló megnyitása
                  </button>
                </div>
                {/* GitHub web-frissítés */}
                <div className="space-y-3">
                  <h3 className="text-xs font-black text-cyan-400 flex items-center gap-1.5 uppercase tracking-wider">
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>GitHub web-frissítés</span>
                  </h3>
                  <div className="p-3 rounded-xl bg-[#081329] border border-cyan-900/30 space-y-2.5">
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      A „Frissítés most” gomb kézzel elindítja az IPTV-teszteket és webfrissítést, követi a build valódi lépéseit, majd siker esetén letölti a kész webes felületet. APK-buildet nem indít.
                    </p>
                    <input
                      value={githubToken}
                      onChange={(e) => setGithubToken(e.target.value)}
                      placeholder={githubConfigured ? "Mentett token – új tokenhez írd felül" : "Token"}
                      type="password"
                      autoComplete="off"
                      className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-cyan-900/50 text-sm text-white outline-none focus:border-cyan-400"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value="Robko1"
                        readOnly
                        placeholder="GitHub tulajdonos"
                        className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-cyan-900/50 text-sm text-white outline-none focus:border-cyan-400"
                      />
                      <input
                        value="LGtv"
                        readOnly
                        placeholder="Repository"
                        className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-cyan-900/50 text-sm text-white outline-none focus:border-cyan-400"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={saveGithubSettings}
                        className="flex-1 py-2.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-xs font-bold active:scale-95 transition-all"
                      >
                        Mentés
                      </button>
                      <button
                        onClick={testGithubSettings}
                        className="flex-1 py-2.5 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-bold active:scale-95 transition-all"
                      >
                        Kapcsolat tesztelése
                      </button>
                    </div>
                    <button
                      onClick={updateGithubWeb}
                      disabled={githubUpdating}
                      className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-bold active:scale-95 transition-all disabled:opacity-60"
                    >
                      <RefreshCw className={githubUpdating ? "w-3.5 h-3.5 animate-spin" : "w-3.5 h-3.5"} />
                      {githubUpdating ? 'Frissítés...' : 'Frissítés most'}
                    </button>
                    {githubStatus && (
                      <p className="text-[11px] text-slate-300">{githubStatus}</p>
                    )}
                  </div>
                </div>
                  </>
                )}

                {/* App Brand Badge */}
                <div className="flex items-center gap-3 p-3 rounded-xl bg-[#0e1e3e] border border-cyan-800/40">
                  <div className="w-12 h-12 rounded-xl bg-[#071124] border border-cyan-800/40 flex items-center justify-center overflow-hidden shadow-lg shadow-blue-500/20">
                    <img
                      src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAggICAgICAgICAgICAgICAgI
CAgICAgICAgICAgICAgICAgICAgICAgICAoICAgICQkJCAgNDQoIDQgICQgB
AwQEBgUGCgYGCg0NCg0NDQ0NDQ0NDQ0NDQ0NDQ8NDQ0NDQ0NDQ0NDQ0NDQ0N
DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDf/AABEIAgACAAMBEQACEQEDEQH/xAAdAAAC
AQUBAQAAAAAAAAAAAAAAAQIDBAUICQYH/8QAYBAAAQMCAwIICQUKCwQHBwUA
AQACAwQRBRIhMVEGBwgTQWFxkQkUIjKBocHR8EJSdbHhFSMkJVVicoKUtCYz
NTZ0kqKys7XUGFPV8UVlc4STxdMZNENEVGOVFoOkwtL/xAAbAQADAQEBAQEA
AAAAAAAAAAAAAQIDBAUGB//EAD0RAAICAAMEBwcDAwQCAwEBAAABAhEDITEE
EkFRMmFxgZGx8AUTIqHB0eEUM1IjovEVQsLSkrJicuKCQ//aAAwDAQACEQMR
AD8A6ooAaACyABADQAkAQmna0XcQ0DpJsPWgiU4xVydHn67hvE3RgLzv81ve
de5pUOaR5GN7UwoZRzfyMHVcNZneblYOoXPe64/srN4h5OJ7VxZdGkYybGJX
bZH/ANYgdwsPUlvM4J7Xiy1ky1c8naSe0rNs5XJvUSkkExjSASAoEDoEwBAD
QMSBAgVAgReDyG/nuH9Ue8/GxM6f249bCnOZpb0jym+0fG/qQhwe9Fx48CDK
07HDMOvb6CiyY4r0lmPxUO8w6/NO30Hp+NUxvDjLovuLd8ZGhFkGLi1qIFAE
gnYAqKQ7oGMIAYQAKhgqQxtCYDTQDVAXDRmH5zdnWN3oSOqL31XFFEFUYiVG
g00AkMSJhIYNCpDJ2QISZURJFgEASAQNAmUCRI0AXMHkjNrc+aPaepB0R+Bb
xcTYnIMpa9wu0aXNr9Oh09SRq9oxI5plxT8K5Rtyv7RY94sPUUUjaG34i1zM
vScLY3aOBYe9veNe8BTunoYe3YcsnkZmGYOF2kOG8G4UnoRkpK0VEFCQAIAL
IAEABCAEEANADQAIAi5wGp0CBNpZs8vjPDZrbtiAcfnnzR2fO9Q6ys5TrQ8H
avakYfDh5vnwPM4rWOkDHucXEj0XG2w2D0ALJts8HaMaeLUpMx6izhBIAQAI
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
Nhq5xJJ1JJN09cynK9TTHwlXBwGHB625uyoqqEjod4zC2pYT1sFDLb/tHL2/
Z0ulHv8Ap9TfDzTXf9PNo0hbGvaKJiJSMxXCln3k9rfrVRKjqdI/ByY4JeC8
MQNzSV2IU7x810lQa0D0srGO9K+d27DUMTLjn45v5htDuSfUvkq+hs/deecw
8yALmhOtt4ISN8LWi3CoyGmKwulQCVDAIAECsaAsSBgUCsVkDsnFFcgb0ioq
3RVrJLu6hoPQkkXiO2SGrOtp9R+1GjK6UewtlRgCBjBSAxN1VHm0F0xAAlQx
5UUArJUMAlQWXlALXf8ANHrOgUtHRhrWXItiUjnd3YiigIpjGHqaAmHKaaEN
FAJIBIAuYJARkd+qd32H46LTR0QlvLdZSkiINj0JUZyW7qUyFVEWKyVDs048
J7W2wnC47+fi3OW/7KgrWernh3r2vZkLm3yX4+p6OyaTfUv/AGRzrX050F/w
cwM1EzIvk+dIR0Rttm7CbhoPQXA9BWU3SsTdH3KABoDWgNa0AADQAAWAA6AB
oFwnNqb5ciPBWtwd0+v4TV1EpO5sOSlDR1B8Eju1zl8/t7+OvXMiFSd8j7hJ
JcknpXmnLOW87IhOiAQUMIoBgqqA5peEz4VTyY1SULnnxWmw6Gpji+T4xUz1
ccszh8p/NU8UbSfMaH2tzsmb6L2Zhppyaz4evT15nrYC3cK1xbT7qrz8jUmE
lrmvaS17HNfG9pLXxyMN2SRvaQ5j2OsWvaQ5pAIIsCvdcVJU1kWpNaG3vER4
ROuoRHTYyx+J0jbMFWxwGJQtANjIXlsdeB5IvK+CosHOdNUuIYvF2j2apXKG
vLvM5YUZrk/k/s/l2I3+4uONHD8XpxVYdVRVUNw1xjJD4nlodzU8Tg2WCUAg
mKZjH2INrEE/OzwpQdSRxTw5QdSR6sBZmYZkxWF00FlQ6DtVUXoiAKCR5kBY
7qqGjXzl24MJeDlQ/LmdTVVDO3TVpdVR0jnD/wDaqpAeolelsL/q9zNIVefr
1oc32RL6I6Co2NIRheGDbQHrc0eu/sVR1NIam9Xgtqv8U4rH8zF+ct/2lBRN
B9PMnuXh7fh1O+ef0+he06QfV9WbnryziQIoLKtM+zh2hFFwdNEqnRxHWfeh
DmqZSLkyATALooAzooAzooQ86KHYZkUMMyKFY7ooRc0jrZnbhp2nZ8dalo3w
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
29T0IxUVSRUSKBABdABdABdABdAH/9k=
"
                      width={48}
                      height={48}
                      alt="IPTV R.T"
                      className="w-full h-full object-contain"
                    />
                  </div>
                  <div>
                    <h4 className="text-white font-black text-base flex items-center gap-1.5">
                      <span>IPTV</span>
                      <span className="text-amber-400">R.T</span>
                      <button
                        onClick={() => setShowVersionHistory((value) => !value)}
                        className="text-xs text-slate-400 font-mono font-normal hover:text-amber-300 transition-colors"
                        title="Verzióelőzmények"
                      >
                        v{WEB_VERSION}
                      </button>
                    </h4>
                    <p className="text-xs text-cyan-300 font-semibold">
                      Android APK mód
                    </p>
                  </div>
                </div>

                {showVersionHistory && (
                  <div className="p-3 rounded-xl bg-[#081329] border border-amber-400/30 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-amber-400">WEB VERZIÓELŐZMÉNYEK</span>
                      <span className="text-[10px] text-slate-500">automatikus</span>
                    </div>
                    <div className="space-y-2.5">
                      {WEB_VERSION_HISTORY.map((entry) => (
                        <div key={entry.version} className="rounded-lg bg-slate-950/50 border border-slate-800 p-2.5">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-black text-white">v{entry.version}</span>
                            <span className="text-[10px] text-slate-500">{entry.date}</span>
                          </div>
                          <ul className="mt-1.5 space-y-0.5">
                            {entry.changes.map((change) => (
                              <li key={change} className="text-[11px] text-slate-300">• {change}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Rendszerfunkciók – egységes, kétoszlopos kék kockák */}
                <div className="pt-1 grid grid-cols-2 gap-2 text-[11px]">
                  {[
                    { label: 'Kép a képben', icon: PanelsTopLeft, available: pictureInPictureAvailable },
                    { label: 'TV-re küldés', icon: Cast, available: true },
                    { label: 'Kedvencek átrendezése', icon: ListOrdered, available: true },
                    { label: 'Dupla koppintás és hangvezérlés', icon: MousePointerClick, available: true },
                    { label: 'Külön Mozi és Sorozat', icon: Film, available: true },
                    { label: 'Többfunkciós kedvencek', icon: Heart, available: true },
                  ].map(({ label, icon: Icon, available }) => (
                    <div
                      key={label}
                      className="min-h-[76px] rounded-xl border border-cyan-500/50 bg-[#0b1d3b] px-2 py-2.5 flex flex-col items-center justify-center gap-1.5 text-center shadow-sm shadow-cyan-950/30"
                    >
                      <div className="flex items-center gap-1.5 text-cyan-300">
                        <Icon className="h-4 w-4 shrink-0" />
                        {available && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400 stroke-[3]" />}
                      </div>
                      <span className="font-semibold leading-tight text-slate-200">{label}</span>
                    </div>
                  ))}
                </div>

                <button
                  onClick={onClose}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#112347] hover:bg-[#172e5c] text-slate-200 border border-slate-700 text-xs font-bold active:scale-95 transition-all"
                >
                  Vissza
                </button>

                {/* Gyorsítótár törlése gomb (Screenshot 1) */}
                <button
                  onClick={handleClearCache}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-rose-950/20 hover:bg-rose-950/50 text-rose-300 border border-rose-800/40 text-xs font-bold active:scale-95 transition-all"
                >
                  <Trash2 className="w-4 h-4 text-rose-400" />
                  <span>Gyorsítótár törlése</span>
                </button>

              </div>
            </div>
          )}

        </div>
      </div>

      {videoDiagnosticOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/85 backdrop-blur-sm p-3" role="dialog" aria-modal="true" aria-label="Hibakeresési napló">
          <div className="w-full max-w-2xl max-h-[92vh] flex flex-col rounded-2xl border-2 border-cyan-500/70 bg-[#071124] p-4 shadow-2xl">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2 text-cyan-300 min-w-0">
                <Bug className="h-5 w-5 shrink-0" />
                <h3 className="text-sm font-black">Natív videó hibakereső</h3>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button type="button" onClick={() => setVideoDiagnosticLogOpen((open) => !open)} className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs font-bold text-cyan-200 hover:bg-cyan-500/20" aria-expanded={videoDiagnosticLogOpen}>
                  {videoDiagnosticLogOpen ? 'Napló elrejtése' : 'Napló megnyitása'}
                </button>
                <button type="button" onClick={() => setVideoDiagnosticOpen(false)} className="rounded-lg p-2 text-slate-300 hover:bg-white/10" aria-label="Bezárás">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            {/*
              Szándékosan NEM textarea: az Android WebView a fókuszálható
              szövegmező tartalmát a rendszer szövegkijelölő menüjével a
              vágólapra tehette. Ez nem kijelölhető előnézet, ezért érintésre
              semmilyen másolási lehetőség nem jelenik meg.
            */}
            {videoDiagnosticLogOpen && (
              <pre
                aria-label="Napló tartalma (nem kijelölhető)"
                className="min-h-0 flex-1 w-full overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-700 bg-black/50 p-3 font-mono text-[10px] leading-relaxed text-slate-200 select-none"
                style={{ minHeight: '42vh', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
              >
                {videoDiagnosticText || 'A napló üres.'}
              </pre>
            )}
            {videoDiagnosticStatus && <p className="mt-2 text-[11px] text-cyan-200">{videoDiagnosticStatus}</p>}
            <button type="button" onClick={() => refreshVideoDiagnostics(true)} className="mt-3 self-center rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-6 py-3 text-xs font-bold text-cyan-200 active:scale-95" title="Törli a régi naplót és új naplózást kezd, hogy ne legyen tele">
              Videó napló frissítése (töröl és újraindít)
            </button>
            <button type="button" onClick={copyVideoDiagnostics} className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-400/50 bg-emerald-500/15 py-3 text-xs font-black text-emerald-200 active:scale-95">
              <Copy className="h-4 w-4" />
              Napló másolása
            </button>
          </div>
        </div>
      )}

      {diagnosisOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label="IPTV-tesztek és webfrissítés állapota">
          <div className="w-full max-w-md rounded-2xl border border-cyan-800/70 bg-[#071124] p-5 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              {diagnosisProgress?.phase === 'completed' ? (
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 border border-emerald-400/50">
                  <Check className="h-6 w-6 text-emerald-400 stroke-[3]" />
                </div>
              ) : diagnosisProgress?.phase === 'failed' ? (
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-500/15 border border-rose-400/50 text-rose-400 font-black text-xl">!</div>
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/15 border border-amber-400/50">
                  <RefreshCw className="h-5 w-5 animate-spin text-amber-300" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-black text-white">IPTV frissítés</h3>
                <p className={diagnosisProgress?.phase === 'completed' ? "text-xs font-bold text-emerald-400" : diagnosisProgress?.phase === 'failed' ? "text-xs font-bold text-rose-400" : "text-xs text-slate-400"}>
                  {noWebUpdate ? 'Nincs új frissítés' : diagnosisProgress?.phase === 'completed' ? 'Sikeres webfrissítés' : diagnosisProgress?.phase === 'failed' ? 'A frissítés hibával leállt' : 'Frissítés és ellenőrzés folyamatban'}
                </p>
              </div>
              {diagnosisProgress?.phase === 'failed' && (
                <button type="button" onClick={() => setDiagnosisOpen(false)} className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Bezárás">
                  <X className="h-5 w-5" />
                </button>
              )}
            </div>

            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-xs font-semibold text-slate-300">Haladás</span>
              <span className={diagnosisProgress?.phase === 'completed' ? "font-mono text-sm font-black text-emerald-400" : diagnosisProgress?.phase === 'failed' ? "font-mono text-sm font-black text-rose-400" : "font-mono text-sm font-black text-amber-300"}>
                {diagnosisProgress?.percent ?? 0}%
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className={diagnosisProgress?.phase === 'completed' ? "h-full rounded-full bg-emerald-400 transition-all duration-500" : diagnosisProgress?.phase === 'failed' ? "h-full rounded-full bg-rose-400 transition-all duration-500" : "h-full rounded-full bg-amber-400 transition-all duration-500"}
                style={{ width: `${diagnosisProgress?.percent ?? 0}%` }}
              />
            </div>

            <div className="mt-4 rounded-xl border border-slate-800 bg-[#081329] p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Aktuális lépés</p>
              <p className="mt-1 break-words text-sm font-semibold text-slate-100">{diagnosisProgress?.step || 'Előkészítés…'}</p>
              {diagnosisProgress?.phase === 'completed' && diagnosisCountdown !== null && (
                <p className="mt-3 text-center text-sm font-black text-emerald-400">
                  {noWebUpdate ? 'Ablak bezárása' : 'Frissítés és ablakbezárás'}: {diagnosisCountdown}
                </p>
              )}
            </div>

            {diagnosisProgress?.phase === 'failed' && (
              <div className="mt-3 rounded-xl border border-rose-500/40 bg-rose-950/30 p-3">
                <p className="text-xs font-black text-rose-300">Hiba részletei</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-rose-100">
                  {diagnosisProgress.message || diagnosisProgress.step || 'Ismeretlen hiba.'}
                </p>
                {diagnosisProgress.runUrl && (
                  <button
                    type="button"
                    onClick={() => (window as any).IPTVNative?.openExternal?.(diagnosisProgress.runUrl)}
                    className="mt-3 text-xs font-bold text-amber-300 underline"
                  >
                    GitHub Actions napló megnyitása
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDiagnosisOpen(false)}
                  className="mt-3 w-full rounded-lg border border-rose-400/40 bg-rose-500/10 py-2 text-xs font-bold text-rose-200"
                >
                  Bezárás
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
