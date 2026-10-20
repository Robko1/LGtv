import { ChannelLogo } from './ChannelLogo';
import { APP_ICON_DATA_URL } from '../generatedIcon';
import React, { useEffect, useRef, useState } from 'react';
import { AppSettings, Channel, FavoriteFolder, ProviderAccount, BufferMode, PlayerEngine, SubtitleSize, WatchHistoryItem } from '../types/iptv';
import {
  SlidersHorizontal,
  Tv,
  FolderPlus,
  Play,
  RefreshCw,
  Plus,
  Film,
  Trash2,
  Check,
  Edit3,
  Smartphone,
  Heart,
  Star,
  ArrowUp,
  ArrowDown,
  Waves,
  PanelsTopLeft,
  Clock,
  Cast,
  ListOrdered,
  MousePointerClick
} from 'lucide-react';
import { storageService } from '../services/storageService';
import { normalizeTvKey } from '../utils/tvKeys';
import { WEB_VERSION, WEB_VERSION_HISTORY } from '../appVersion';
import { checkLatestWebOSRelease, type WebOSReleaseInfo } from '../services/webosUpdateService';

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
  onOpenQrProvision: () => void;
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
  onOpenQrProvision,
  folders,
  onOpenAddFolder,
  onDeleteFolder,
  onMoveFavoriteChannel,
  onRemoveChannelFromFolder,
  watchHistory,
  onContinueWatching,
  onRemoveWatchHistoryItem,
}) => {
  const [releaseInfo, setReleaseInfo] = useState<WebOSReleaseInfo | null>(null);
  const [releaseCheckLoading, setReleaseCheckLoading] = useState(false);
  const [releaseCheckStatus, setReleaseCheckStatus] = useState('');
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const showApplicationBox = true; // állandó rész, nem csukható
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

  const checkWebOSUpdate = async () => {
    setReleaseCheckLoading(true);
    setReleaseCheckStatus('A nyilvános LG webOS kiadás ellenőrzése…');
    try {
      const result = await checkLatestWebOSRelease();
      setReleaseInfo(result);
      setReleaseCheckStatus(result.updateAvailable
        ? `Új verzió érhető el: ${result.latestVersion}. Az IPK telepítését webOS fejlesztői eszközzel kell elvégezni.`
        : result.latestVersion === result.currentVersion
          ? `Naprakész: ${result.currentVersion}.`
          : `A legfrissebb kiadás (${result.latestVersion}) nem újabb a telepített ${result.currentVersion} verziónál.`);
    } catch (error) {
      setReleaseCheckStatus(error instanceof Error ? error.message : 'A frissítés ellenőrzése sikertelen.');
    } finally {
      setReleaseCheckLoading(false);
    }
  };

  // Valós idejű képesség-ellenőrzések: csak akkor jelenik meg zöld pipa,
  // ha az adott lejátszási mód ténylegesen elérhető az aktuális környezetben.
  const pictureInPictureAvailable = Boolean((document as any).pictureInPictureEnabled);

  // TV / stick / egér: D-pad + egér támogatás a beállítások modalban
  const modalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const focusModal = () => {
      try {
        const container = modalRef.current;
        if (!container) return;
        // FÓKUSZRABLÁS TILTVA: ha a fókusz már a modalBAN van (a néző épp a
        // füleken vagy egy dobozban navigál), NEM nyúlunk hozzá. Korábban az
        // első gombra – a bezáró X-re! – rántotta vissza az időzítő, ezért
        // ugrált a kijelölés "magától" az X-re.
        const ae = document.activeElement as HTMLElement | null;
        // Ha a fókusz egy MÁSIK (felettünk nyitott) ablakban van – pl. QR
        // vagy Új mappa –, SOHA nem rabolhatjuk el. Korábban ez okozta,
        // hogy a kijelölés "kiugrott a háttérbe".
        const aeDlg = (ae && ae.closest ? ae.closest('[role="dialog"]') : null) as HTMLElement | null;
        const myDlg = (container.closest('[role="dialog"]') || container.querySelector('[role="dialog"]') || container) as HTMLElement;
        if (aeDlg && aeDlg !== myDlg && !myDlg.contains(aeDlg)) return;
        // Első fókusz: alapgomb (data-tv-default, pl. Telefon) → doboz
        // (data-tv-box) → fülek → bármi, de NEM az X.
        const def = container.querySelector<HTMLElement>('[data-tv-default]');
        if (ae && container.contains(ae) && ae !== container) {
          // Fülváltás után a kijelölés a fül TARTALMÁRA ugrik (Listák →
          // Telefon gomb, Rendszer → első doboz); minden más esetben nem
          // nyúlunk a fókuszhoz.
          const onTab = !!(ae.closest && ae.closest('[data-tv-tabs]'));
          if (!onTab) return;
          const jump = def || container.querySelector<HTMLElement>('[data-tv-box]');
          if (jump) jump.focus({ preventScroll: true } as any);
          return;
        }
        // Nyitáskor az ÉPP AKTÍV fül pillje kapja a kijelölést (alapból a
        // Kedvencek, mert a menü azzal nyílik) – így a sárga jelölő és a
        // kék aktív fül mindig ugyanott van.
        const opener = container.querySelector<HTMLElement>(`[data-tv-tabid="${activeTab}"]`)
          || container.querySelector<HTMLElement>('[data-tv-open-focus]');
        const box = opener || def || container.querySelector<HTMLElement>('[data-tv-box]');
        const buttons = Array.from(container.querySelectorAll<HTMLElement>('button'));
        const focusable = container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        const target = box || buttons[1] || buttons[0] || focusable[0] || container;
        target?.focus({ preventScroll: true } as any);
      } catch {}
    };
    const t1 = window.setTimeout(focusModal, 100);
    const t2 = window.setTimeout(focusModal, 500);
    const t3 = window.setTimeout(focusModal, 1000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [isOpen, activeTab]);

  const handleModalKeyDown = (e: React.KeyboardEvent) => {
    // TV távirányító: D-pad navigáció a modalban.
    // LG webOS: régi kulcsnév ('Up') vagy csak keyCode (37-40, VISSZA=461) is jöhet.
    const key = normalizeTvKey(e);
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      try {
        const container = modalRef.current;
        if (!container) return;
        const focusable = Array.from(container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(el => !el.hasAttribute('disabled') && (el as HTMLElement).offsetParent !== null);
        if (focusable.length === 0) return;
        const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        e.stopPropagation();
        if (key === 'ArrowDown') {
          const next = focusable[(currentIndex + 1) % focusable.length];
          next?.focus();
          next?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else {
          const prev = focusable[(currentIndex - 1 + focusable.length) % focusable.length];
          prev?.focus();
          prev?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      } catch {}
    } else if (key === 'Escape' || key === 'Backspace') {
      // TV Back / Esc: modal bezárás
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'INPUT' && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
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
          {/* Az X gombot a TV-s kérés alapján eltávolítottuk – bezárás a
              VISSZA gombbal vagy a háttérre kattintva. */}
        </div>

        {/* 4 Navigation Tabs Pills */}
        <div data-tv-tabs="" className="px-3 py-2 bg-[#081329] border-b border-cyan-950/60 flex items-center gap-1.5 overflow-x-auto no-scrollbar">


          <button
            data-tv-tabid="lists"
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
            data-tv-open-focus=""
            data-tv-tabid="favorites"
            onClick={() => setActiveTab('favorites')}
            className={`flex-1 min-w-[85px] py-2 px-2.5 rounded-xl text-xs font-black transition-all text-center truncate ${
              activeTab === 'favorites'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                : 'bg-[#0f2144] text-slate-300 hover:bg-[#152e5c]'
            }`}
          >
            Kedvencek
          </button>

          <button
            data-tv-tabid="system"
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
                    data-tv-default=""
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
                <div data-tv-box="" tabIndex={0} className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400">
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

                {/* Lejátszómotor: HTML5 vagy a TV natív médiacsatornája */}
                <div data-tv-box="" tabIndex={0} className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400">
                  <label className="flex items-center gap-2 text-xs font-bold text-white">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/10">📺</span>
                    <span>Lejátszó</span>
                  </label>
                  <p className="text-[11px] text-slate-400 leading-tight">
                    HTML5 = beépített videólejátszó. Natív = a TV saját médiacsatornája (webOS).
                    Ha az egyik akadozik, próbáld a másikat – a választás mentésre kerül.
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 pt-1">
                    {(['html5', 'native'] as PlayerEngine[]).map((engine) => (
                      <button
                        key={engine}
                        onClick={() => onUpdateSettings({ playerEngine: engine })}
                        className={`py-2 rounded-xl text-xs font-black transition-all ${
                          settings.playerEngine === engine
                            ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                            : 'bg-[#0e1f3f] text-slate-300 border border-slate-700/60 hover:bg-[#142b56]'
                        }`}
                      >
                        {engine === 'html5' ? 'HTML5' : 'Natív (TV)'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* OSD automatikus elrejtése */}
                <div data-tv-box="" tabIndex={0} className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400">
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
                <div data-tv-box="" tabIndex={0} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm focus:outline-none focus:ring-2 focus:ring-amber-400">
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
                <div data-tv-box="" tabIndex={0} className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400">
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
                <div data-tv-box="" tabIndex={0} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm focus:outline-none focus:ring-2 focus:ring-amber-400">
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
                <div data-tv-box="" tabIndex={0} className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400">
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
                <div data-tv-box="" tabIndex={0} className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400">
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
                <div data-tv-box="" tabIndex={0} className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400">
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

                {/* A CORS proxy beállítás kérésre eltávolítva. */}
              </div>

              {/* SECTION: LG WEBOS ALKALMAZÁS */}
              <div data-tv-box="" tabIndex={0} className="p-3.5 rounded-2xl bg-[#0a1630] border border-cyan-900/40 space-y-3.5 shadow-md focus:outline-none focus:ring-2 focus:ring-amber-400">
                <div className="w-full flex items-center justify-between text-left rounded-xl py-1.5">
                  <span className="text-xs font-black text-cyan-400 flex items-center gap-1.5 uppercase tracking-wider">
                    <Smartphone className="w-3.5 h-3.5" />
                    <span>LG webOS alkalmazás</span>
                  </span>
                </div>

{showApplicationBox && (
                  <>
                {/* LG webOS GitHub kiadásellenőrzés */}
                <div className="space-y-3">
                  <h3 className="text-xs font-black text-cyan-400 flex items-center gap-1.5 uppercase tracking-wider">
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>LG webOS frissítés</span>
                  </h3>
                  <div className="p-3 rounded-xl bg-[#081329] border border-cyan-900/30 space-y-2.5">
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Ez a gomb a Robko1/LGtv nyilvános GitHub Release-ét ellenőrzi. A webOS alkalmazás nem telepíthet csendben IPK-t; az új csomagot a TV-hez csatlakozó webOS fejlesztői eszközzel kell telepíteni.
                    </p>
                    <button type="button" onClick={checkWebOSUpdate} disabled={releaseCheckLoading} className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-bold active:scale-95 transition-all disabled:opacity-60">
                      <RefreshCw className={releaseCheckLoading ? "w-3.5 h-3.5 animate-spin" : "w-3.5 h-3.5"} />
                      {releaseCheckLoading ? 'Ellenőrzés…' : 'Frissítés ellenőrzése'}
                    </button>
                    {releaseInfo && (
                      <div className="rounded-lg border border-cyan-900/40 bg-slate-950/50 p-3 space-y-1">
                        <p className="text-[11px] text-slate-300">Telepített verzió: <strong>{releaseInfo.currentVersion}</strong></p>
                        <p className="text-[11px] text-slate-300">Legfrissebb kiadás: <strong>{releaseInfo.latestVersion}</strong></p>
                        {releaseInfo.ipkUrl ? <p className="text-[11px] text-emerald-300">A kiadás tartalmaz IPK-csomagot.</p> : <p className="text-[11px] text-amber-300">A kiadásban nem található IPK-fájl.</p>}
                        <a href={releaseInfo.releaseUrl} target="_blank" rel="noreferrer" className="inline-block pt-2 text-xs font-bold text-cyan-300 underline">GitHub Release megnyitása</a>
                      </div>
                    )}
                    {releaseCheckStatus && <p role="status" className="text-[11px] text-slate-300">{releaseCheckStatus}</p>}
                  </div>
                </div>

                {/* App Brand Badge */}
                <div className="flex items-center gap-3 p-3 rounded-xl bg-[#0e1e3e] border border-cyan-800/40">
                  <div className="w-12 h-12 rounded-xl bg-[#071124] border border-cyan-800/40 flex items-center justify-center overflow-hidden shadow-lg shadow-blue-500/20">
                    <img
                      src={APP_ICON_DATA_URL}
                      width={48}
                      height={48}
                      alt="TV"
                      className="w-full h-full object-contain"
                    />
                  </div>
                  <div>
                    <h4 className="text-white font-black text-base flex items-center gap-1.5">
                      <span>TV</span>
                      <button
                        onClick={() => setShowVersionHistory((value) => !value)}
                        className="text-xs text-slate-400 font-mono font-normal hover:text-amber-300 transition-colors"
                        title="Verzióelőzmények"
                      >
                        v{WEB_VERSION}
                      </button>
                    </h4>
                    <p className="text-xs text-cyan-300 font-semibold">
                      LG webOS TV mód
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

                {/* A Vissza és a Gyorsítótár törlése gomb kérésre eltávolítva. */}

                  </>
                )}
              </div>

              {/* Látható lezárás: innen nincs tovább lefelé */}
              <div className="rounded-2xl border-2 border-dashed border-cyan-900/70 py-3 text-center text-[11px] font-bold tracking-widest text-slate-500">
                ─── A BEÁLLÍTÁSOK VÉGE ───
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
