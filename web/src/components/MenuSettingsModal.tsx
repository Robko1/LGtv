import { ChannelLogo } from './ChannelLogo';
import { APP_ICON_DATA_URL } from '../generatedIcon';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppSettings, Channel, FavoriteFolder, ProviderAccount, BufferMode, SubtitleSize, WatchHistoryItem } from '../types/iptv';
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
  onRemoveChannelFromFolder: (folderId: string, channelId: string) => void;
  onOpenEpgModal: () => void;
  onOpenQrProvision: () => void;
  /**
   * Diagnosztika megosztása QR-kóddal.
   *
   * A PIROS (Record) gomb a felhasználó kérésére a TÜKRÖZÖTT elrendezést
   * kapcsolja, ezért a diagnosztika-megosztás ide, a Rendszer fülre került –
   * így a funkció nem veszett el.
   */
  onOpenDiagnosticShare?: () => void;
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
  onOpenDiagnosticShare,
  folders,
  onOpenAddFolder,
  onDeleteFolder,
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
  /*
   * TV-n a window.confirm() NEM működik: a webOS böngészője nem jelenít meg
   * natív párbeszédablakot (a hívás azonnal false-szal tér vissza), ezért a
   * kedvenc mappa TÖRLÉSE és a gyorsítótár törlése hatástalan volt.
   * Helyette a felületen belüli, távirányítóval is elérhető kérdés jelenik meg.
   */
  const [pendingDeleteFolderId, setPendingDeleteFolderId] = useState<string | null>(null);
  const [pendingClearCache, setPendingClearCache] = useState(false);
  // A kék teletextgomb a Kedvencek fülön nem indíthat csatornamozgatást.
  // A globális távirányító-kezelés más nézetekben változatlan marad.

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

  // Csatorna-kereső térkép: a kedvenc mappák listája korábban minden egyes
  // csatornánál végigfutott a teljes (akár 20-60 ezer elemes) listán
  // (`f.channelIds.map(id => channels.find(...))`), ami a menü minden
  // kirajzolásakor több százezer összehasonlítást jelentett.
  const channelById = useMemo(() => {
    const map = new Map<string, Channel>();
    for (const channel of channels) map.set(channel.id, channel);
    return map;
  }, [channels]);

  const resumableHistory = useMemo(
    () => watchHistory.filter((item) => item.mediaType === 'movie' || item.mediaType === 'series'),
    [watchHistory],
  );

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
        const def = container.querySelector<HTMLElement>('[data-tv-default]');
        const tab = container.querySelector<HTMLElement>(`[data-tv-tabid="${activeTab}"]`)
          || container.querySelector<HTMLElement>('[data-tv-open-focus]');
        if (ae && container.contains(ae) && ae !== container) {
          // Fülváltás után a fókusz a fül tartalmára kerül; nyitáskor viszont
          // először maga az aktív fül (Kedvencek) kapja a sárga kijelölést.
          const onTab = !!(ae.closest && ae.closest('[data-tv-tabs]'));
          if (!onTab) return;
          const jump = def || container.querySelector<HTMLElement>('[data-tv-box]');
          if (jump) jump.focus({ preventScroll: true } as any);
          return;
        }
        tab?.focus({ preventScroll: true } as any);
      } catch {}
    };
    const timer = window.setTimeout(focusModal, 100);
    return () => clearTimeout(timer);
  }, [isOpen, activeTab]);

  const handleTabDpad = (event: React.KeyboardEvent<HTMLButtonElement>, current: 'lists' | 'favorites' | 'system') => {
    const key = normalizeTvKey(event);
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    const order: Array<'lists' | 'favorites' | 'system'> = ['lists', 'favorites', 'system'];
    const index = order.indexOf(current);
    const next = order[index + (key === 'ArrowRight' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    // A nyílgomb csak a fül fókuszát mozgatja; OK aktiválja a fület.
    modalRef.current?.querySelector<HTMLElement>(`[data-tv-tabid="${next}"]`)?.focus({ preventScroll: true } as any);
  };

  const handleModalKeyDown = (e: React.KeyboardEvent) => {
    // A fel/le navigáció mindig az éppen aktív fülön belül marad.
    // Csak az adott fül legfelső dobozáról lehet visszalépni a saját fülére.
    const key = normalizeTvKey(e);
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      try {
        const container = modalRef.current;
        if (!container) return;

        const activeElement = document.activeElement as HTMLElement | null;
        const onTabs = !!activeElement?.closest('[data-tv-tabs]');
        const activeTabButton = container.querySelector<HTMLElement>(`[data-tv-tabid="${activeTab}"]`);
        const selector = activeTab === 'system'
          ? '[data-tv-box]'
          : activeTab === 'favorites'
            ? '[data-tv-default], [data-favorite-folder], [data-favorite-channel], [data-tv-box]'
            : '[data-tv-default], [data-tv-box], [data-resume-item]';
        const focusable = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter((el) => {
          if (el.hasAttribute('disabled') || el.offsetParent === null) return false;
          if (el.closest('[data-view-hidden]')) return false;
          return true;
        });

        e.preventDefault();
        e.stopPropagation();

        if (onTabs) {
          if (key === 'ArrowDown') {
            focusable[0]?.focus({ preventScroll: true } as any);
            focusable[0]?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
          }
          return;
        }

        // Ha egy gomb fókuszban van a dobozon belül, fel/le esetén a teljes
        // dobozt tekintjük kijelöltnek.
        const logicalCurrent = activeElement?.closest<HTMLElement>(
          activeTab === 'system' ? '[data-tv-box]'
            : activeTab === 'favorites' ? '[data-tv-default], [data-favorite-folder], [data-favorite-channel], [data-tv-box]'
              : '[data-tv-default], [data-tv-box], [data-resume-item]'
        ) || activeElement;
        let currentIndex = focusable.indexOf(logicalCurrent as HTMLElement);
        if (currentIndex < 0 && activeElement) {
          currentIndex = focusable.findIndex((el) => el.contains(activeElement));
        }

        if (key === 'ArrowUp' && currentIndex <= 0) {
          activeTabButton?.focus({ preventScroll: true } as any);
          activeTabButton?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
          return;
        }

        const nextIndex = key === 'ArrowDown'
          ? Math.min(focusable.length - 1, currentIndex < 0 ? 0 : currentIndex + 1)
          : Math.max(0, currentIndex - 1);
        const target = focusable[nextIndex];
        target?.focus({ preventScroll: true } as any);
        target?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      } catch {}
    } else if (key === 'Escape' || key === 'Backspace') {
      // TV Back / Esc: először a függő törlés-megerősítést vonja vissza,
      // csak utána zárja be a teljes ablakot.
      if (pendingDeleteFolderId) {
        e.preventDefault();
        e.stopPropagation();
        setPendingDeleteFolderId(null);
        return;
      }
      if (pendingClearCache) {
        e.preventDefault();
        e.stopPropagation();
        setPendingClearCache(false);
        return;
      }
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
    storageService.clearCache();
    window.location.reload();
  };

  /**
   * A PANEL MÉRETE MINDKÉT OLDALON AZONOS.
   *
   * Korábban a tükrözött (bal oldali) menü „szétcsúszott”: a panel a
   * tükrözött soron belüli ősöktől örökölt geometriát kapott. A megoldás:
   *  • a menü PORTÁLBAN, közvetlenül a <body> alá kerül (nincs örökölt
   *    flex/transform beállítás),
   *  • a szélesség egyetlen, mindkét oldalon UGYANAZOKKAL az osztályokkal
   *    megadott érték, `shrink-0`-val, hogy a flex ne nyújtsa/nyomja össze.
   */
  const panelSizeClass = 'w-full max-w-lg md:max-w-xl lg:max-w-2xl xl:max-w-3xl 2xl:max-w-4xl h-full shrink-0 min-w-0 bg-[#071124] flex flex-col shadow-2xl overflow-hidden focus:outline-none';

  const modal = (
    <div
      data-mirror-menu={settings.mirrorLayout ? '1' : undefined}
      className={`fixed inset-0 z-50 flex bg-black/75 backdrop-blur-xs select-none lg:select-auto ${settings.mirrorLayout ? 'justify-start' : 'justify-end'}`}
      role="dialog"
      aria-modal="true"
      aria-label="Menü és beállítások"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/*
        TÜKRÖZÖTT ELRENDEZÉS: a menü a BAL oldalon nyílik ki (a csatornalista
        oldalán), nem a jobbon – a panel MÉRETE viszont pontosan ugyanaz,
        mint a jobb oldalon (lásd a panelSizeClass magyarázatát).
      */}
      <div
        ref={modalRef}
        data-tv-navigation-owner="settings"
        tabIndex={-1}
        onKeyDown={handleModalKeyDown}
        data-mirror-panel={settings.mirrorLayout ? '1' : undefined}
        className={`${panelSizeClass} ${
          settings.mirrorLayout ? 'border-r border-cyan-900/40' : 'border-l border-cyan-900/40'
        }`}
      >
        
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
            onKeyDown={(event) => handleTabDpad(event, 'lists')}
            onClick={() => setActiveTab('lists')}
            className={`flex-1 min-w-[80px] py-2 px-2.5 rounded-xl text-sm font-black transition-all text-center truncate ${
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
            onKeyDown={(event) => handleTabDpad(event, 'favorites')}
            onClick={() => setActiveTab('favorites')}
            className={`flex-1 min-w-[85px] py-2 px-2.5 rounded-xl text-sm font-black transition-all text-center truncate ${
              activeTab === 'favorites'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                : 'bg-[#0f2144] text-slate-300 hover:bg-[#152e5c]'
            }`}
          >
            Kedvencek
          </button>

          <button
            data-tv-tabid="system"
            onKeyDown={(event) => handleTabDpad(event, 'system')}
            onClick={() => setActiveTab('system')}
            className={`flex-1 min-w-[80px] py-2 px-2.5 rounded-xl text-sm font-black transition-all text-center truncate ${
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
                <h3 className="text-base font-black text-slate-100 tracking-wider uppercase">
                  M3U / Xtream Listák
                </h3>
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <button
                    data-tv-default=""
                    onClick={onOpenQrProvision}
                    className="flex-1 min-w-0 flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 text-base font-black active:scale-95 transition-all shadow-md shadow-amber-400/25"
                    title="Telefonnal beállítás QR kóddal – nem kell TV-n pötyögni"
                  >
                    <Smartphone className="w-6 h-6 shrink-0" />
                    <span>📱 Telefon</span>
                  </button>
                  <button
                    onClick={onOpenAddProvider}
                    className="flex-1 min-w-0 flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-base font-black active:scale-95 transition-all shadow-md shadow-cyan-400/25"
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
                      data-tv-box=""
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        const key = normalizeTvKey(event);
                        if (key === 'Enter' || key === ' ') {
                          const firstAction = event.currentTarget.querySelector<HTMLElement>('button');
                          if (firstAction) {
                            event.preventDefault();
                            firstAction.focus({ preventScroll: true } as any);
                          }
                        }
                      }}
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
                      <div className="mt-1 text-sm text-slate-300 font-medium">
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
              {!pendingClearCache ? (
                <button
                  onClick={() => setPendingClearCache(true)}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-rose-950/30 hover:bg-rose-950/60 text-rose-300 border border-rose-800/40 text-xs font-bold active:scale-95 transition-all"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Összes lista és tesztcsatorna törlése</span>
                </button>
              ) : (
                <div className="rounded-xl border border-rose-800/50 bg-rose-950/25 p-3 space-y-2">
                  <p className="text-xs font-bold text-rose-200">
                    Biztosan törlöd a gyorsítótárat és visszaállítod az alapértelmezett állapotot?
                  </p>
                  <div className="flex gap-2">
                    <button
                      autoFocus
                      onClick={handleClearCache}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-rose-600 text-white text-xs font-black active:scale-95"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>Igen, törlés</span>
                    </button>
                    <button
                      onClick={() => setPendingClearCache(false)}
                      className="flex-1 py-2.5 rounded-xl bg-[#0f2042] border border-slate-600 text-slate-200 text-xs font-bold active:scale-95"
                    >
                      Mégse
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ================= TAB 3: KEDVENCEK ================= */}
          {activeTab === 'favorites' && (
            <div className="space-y-4 animate-fadeIn">
              {/* Header with [Új mappa] button (Screenshot 3) */}
              <div className="flex items-center justify-between">
                <h3 className="text-base font-black text-slate-100 tracking-wider uppercase">
                  Kedvenc Mappák
                </h3>
                <button
                  data-tv-default=""
                  onClick={onOpenAddFolder}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 text-base font-black active:scale-95 transition-all shadow-md shadow-amber-400/25"
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
                    .map((id) => channelById.get(id))
                    .filter((channel): channel is Channel => Boolean(channel));
                  const expanded = expandedFavoriteFolderId === f.id;
                  return (
                    <div key={f.id} data-favorite-folder={f.id} tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        const key = normalizeTvKey(event);
                        if (key === 'Enter' || key === ' ') {
                          event.preventDefault();
                          const folderElement = event.currentTarget;
                          setExpandedFavoriteFolderId(expanded ? null : f.id);
                          setMovingFavoriteChannelId(null);
                          if (!expanded) {
                            window.setTimeout(() => {
                              folderElement.querySelector<HTMLElement>('[data-favorite-channel]')?.focus({ preventScroll: true } as any);
                            }, 0);
                          }
                        } else if (key === 'ArrowRight') {
                          event.preventDefault();
                          event.stopPropagation();
                          event.currentTarget.querySelector<HTMLElement>('button[title="Mappa törlése"]')?.focus();
                        } else if (key === 'ArrowDown' && expanded) {
                          const firstChannel = event.currentTarget.querySelector<HTMLElement>('[data-favorite-channel]');
                          if (firstChannel) { event.preventDefault(); event.stopPropagation(); firstChannel.focus(); }
                        }
                      }}
                      className={`rounded-2xl bg-[#0d1d3d] border-2 shadow-md overflow-hidden focus:outline-none focus:ring-2 focus:ring-amber-400 focus-within:ring-2 focus-within:ring-amber-400 ${folderIndex % 2 === 0 ? 'border-cyan-500/80' : 'border-amber-400/80'}`}>
                      <div className="p-3.5 flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedFavoriteFolderId(expanded ? null : f.id);
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
                          onKeyDown={(event) => {
                            const key = normalizeTvKey(event);
                            if (key === 'ArrowUp') {
                              event.preventDefault();
                              event.stopPropagation();
                              event.currentTarget.closest<HTMLElement>('[data-favorite-folder]')?.focus({ preventScroll: true } as any);
                            } else if (key === 'ArrowDown') {
                              const folder = event.currentTarget.closest<HTMLElement>('[data-favorite-folder]');
                              const firstChannel = folder?.querySelector<HTMLElement>('[data-favorite-channel]');
                              event.preventDefault();
                              event.stopPropagation();
                              (firstChannel || folder)?.focus({ preventScroll: true } as any);
                            }
                          }}
                          onClick={() => setPendingDeleteFolderId(pendingDeleteFolderId === f.id ? null : f.id)}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-950/30 border border-rose-800/50 text-rose-300 hover:bg-rose-900/50 text-xs font-bold shrink-0"
                          title="Mappa törlése"
                        >
                          <Trash2 className="w-4 h-4" />
                          <span>Törlés</span>
                        </button>
                      </div>
                      {/* Törlés megerősítése – a távirányítóval is működik (nincs window.confirm). */}
                      {pendingDeleteFolderId === f.id && (
                        <div className="border-t border-rose-800/50 bg-rose-950/25 p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <p className="text-xs font-bold text-rose-200">
                            Biztosan törlöd ezt a mappát: „{f.name}”?
                          </p>
                          <div className="flex gap-2 shrink-0">
                            <button
                              autoFocus
                              onClick={() => {
                                onDeleteFolder(f.id);
                                setPendingDeleteFolderId(null);
                                if (expandedFavoriteFolderId === f.id) setExpandedFavoriteFolderId(null);
                                  }}
                              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-600 text-white text-xs font-black active:scale-95"
                            >
                              <Trash2 className="w-4 h-4" />
                              <span>Igen, törlés</span>
                            </button>
                            <button
                              onClick={() => setPendingDeleteFolderId(null)}
                              className="px-3 py-2 rounded-xl bg-[#0f2042] border border-slate-600 text-slate-200 text-xs font-bold active:scale-95"
                            >
                              Mégse
                            </button>
                          </div>
                        </div>
                      )}
                      {expanded && (
                        <div className={`border-t p-2 space-y-1.5 ${folderIndex % 2 === 0 ? 'border-cyan-500/50' : 'border-amber-400/50'}`}>
                          {folderChannels.length === 0 ? (
                            <p className="p-4 text-center text-xs text-slate-400">Ez a kedvenc mappa üres.</p>
                          ) : folderChannels.map((channel, index) => {
                            return (
                              <div
                                key={channel.id}
                                data-favorite-channel={channel.id}
                                tabIndex={0}
                                onKeyDown={(event) => {
                                  if (event.target !== event.currentTarget) return;
                                  const key = normalizeTvKey(event);
                                  if (key === 'ArrowUp') {
                                    if (index === 0) {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      const folderElement = event.currentTarget.closest<HTMLElement>('[data-favorite-folder]');
                                      setExpandedFavoriteFolderId(null);
                                      folderElement?.focus({ preventScroll: true } as any);
                                    } else {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[data-favorite-channel]')[index - 1]?.focus({ preventScroll: true } as any);
                                    }
                                  } else if (key === 'ArrowDown') {
                                    const rows = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[data-favorite-channel]');
                                    if (rows && index < rows.length - 1) {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      rows[index + 1]?.focus({ preventScroll: true } as any);
                                    }
                                  } else if (key === 'ArrowRight') {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    event.currentTarget.querySelector<HTMLElement>('button[title="Eltávolítás a kedvenc mappából"]')?.focus();
                                  }
                                }}
                                onContextMenu={(event) => event.preventDefault()}
                                className="flex items-center gap-2 rounded-xl p-2 border transition-colors bg-[#09152b] border-slate-700"
                              >
                                <div className="w-9 h-7 rounded-md bg-black/20 border border-slate-700 p-0.5 shrink-0 flex items-center justify-center overflow-hidden">
                                  <ChannelLogo url={channel.logo} name={channel.name} retryKey={channel.id} />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="text-xs font-bold text-slate-100 truncate">{channel.name}</div>
                                  <div className="text-[10px] text-slate-400 truncate">{channel.num ? `#${channel.num}` : 'Csatorna'}</div>
                                </div>

                                <button
                                  type="button"
                                  onKeyDown={(event) => {
                                    const key = normalizeTvKey(event);
                                    if (key === 'ArrowLeft') {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      event.currentTarget.closest<HTMLElement>('[data-favorite-channel]')?.focus({ preventScroll: true } as any);
                                    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
                                      const rows = Array.from(event.currentTarget.closest<HTMLElement>('[data-favorite-folder]')?.querySelectorAll<HTMLElement>('[data-favorite-channel]') || []);
                                      const row = event.currentTarget.closest<HTMLElement>('[data-favorite-channel]');
                                      const index = rows.indexOf(row as HTMLElement);
                                      const next = key === 'ArrowUp' ? index - 1 : index + 1;
                                      if (key === 'ArrowUp' && index === 0) {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        const folderElement = event.currentTarget.closest<HTMLElement>('[data-favorite-folder]');
                                        setExpandedFavoriteFolderId(null);
                                        folderElement?.focus({ preventScroll: true } as any);
                                      } else if (next >= 0 && next < rows.length) {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        rows[next]?.querySelector<HTMLElement>('button[title="Eltávolítás a kedvenc mappából"]')?.focus({ preventScroll: true } as any);
                                      }
                                    }
                                  }}
                                  onPointerDown={(event) => event.stopPropagation()}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    const folderElement = event.currentTarget.closest<HTMLElement>('[data-favorite-folder]');
                                    onRemoveChannelFromFolder(f.id, channel.id);
                                    setExpandedFavoriteFolderId(null);
                                            window.setTimeout(() => folderElement?.focus({ preventScroll: true } as any), 0);
                                  }}
                                  className="p-1.5 rounded-xl text-amber-400 hover:text-amber-300 active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300"
                                  title="Eltávolítás a kedvenc mappából"
                                  aria-label={`${channel.name} eltávolítása a kedvenc mappából`}
                                ><Star className="w-4 h-4 fill-amber-400" /></button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Folytatás: a félbehagyott filmek és sorozatrészek listája */}
              <section data-tv-box="" tabIndex={0} className="rounded-2xl border border-cyan-500/70 bg-[#0d1c3a] p-4 space-y-3 shadow-lg shadow-cyan-950/20 focus:outline-none focus:ring-2 focus:ring-amber-400">
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

                {resumableHistory.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-cyan-800/70 bg-black/10 px-3 py-5 text-center">
                    <Film className="w-7 h-7 text-slate-500 mx-auto mb-2" />
                    <p className="text-sm font-bold text-slate-200">Még nincs mit folytatni</p>
                    <p className="text-xs text-slate-400 mt-1">Kezdj el nézni egy filmet vagy sorozatot, és itt megjelenik.</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {resumableHistory.map((item, itemIndex) => (
                        <div
                          key={item.id}
                          role="group"
                          tabIndex={0}
                          data-resume-item={item.id}
                          onKeyDown={(event) => {
                            const key = normalizeTvKey(event);
                            const row = event.currentTarget;
                            const items = Array.from(row.parentElement?.querySelectorAll<HTMLElement>('[data-resume-item]') || []);
                            const continueButton = row.querySelector<HTMLElement>('[data-resume-continue]');
                            const removeButton = row.querySelector<HTMLElement>('[data-resume-remove]');
                            const onRemove = !!(event.target as HTMLElement).closest('[data-resume-remove]');
                            if (key === 'Enter' || key === ' ') {
                              if (event.target === row) {
                                event.preventDefault();
                                event.stopPropagation();
                                continueButton?.focus({ preventScroll: true } as any);
                              }
                            } else if (key === 'ArrowRight') {
                              event.preventDefault();
                              event.stopPropagation();
                              removeButton?.focus({ preventScroll: true } as any);
                            } else if (key === 'ArrowLeft' && onRemove) {
                              event.preventDefault();
                              event.stopPropagation();
                              continueButton?.focus({ preventScroll: true } as any);
                            } else if (key === 'ArrowUp' || key === 'ArrowDown') {
                              event.preventDefault();
                              event.stopPropagation();
                              if (key === 'ArrowUp' && onRemove) {
                                continueButton?.focus({ preventScroll: true } as any);
                              } else {
                                const nextIndex = itemIndex + (key === 'ArrowDown' ? 1 : -1);
                                const targetRow = items[nextIndex];
                                if (targetRow) targetRow.querySelector<HTMLElement>('[data-resume-continue]')?.focus({ preventScroll: true } as any);
                              }
                            } else if (key === 'Escape' || key === 'Backspace') {
                              event.preventDefault();
                              event.stopPropagation();
                              row.focus({ preventScroll: true } as any);
                            }
                          }}
                          className="rounded-xl border border-cyan-900/60 bg-[#071329]/80 p-3 focus:outline-none focus:ring-2 focus:ring-amber-400">
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
                              data-resume-continue=""
                              onClick={() => { onContinueWatching(item); onClose(); }}
                              className="min-h-11 flex items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-black shadow-md shadow-blue-950/40 active:scale-[0.99] transition-all"
                            >
                              <Play className="w-4 h-4 fill-current" />
                              Folytatás
                            </button>
                            <button
                              data-resume-remove=""
                              onClick={(event) => {
                                const row = event.currentTarget.closest<HTMLElement>('[data-resume-item]');
                                const rows = Array.from(row?.parentElement?.querySelectorAll<HTMLElement>('[data-resume-item]') || []);
                                const index = rows.indexOf(row as HTMLElement);
                                const nextRow = rows[index + 1];
                                const previousRow = rows[index - 1];
                                onRemoveWatchHistoryItem(item.id);
                                window.setTimeout(() => {
                                  const target = nextRow?.querySelector<HTMLElement>('[data-resume-continue]')
                                    || previousRow?.querySelector<HTMLElement>('[data-resume-continue]');
                                  target?.focus({ preventScroll: true } as any);
                                }, 0);
                              }}
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
                <div data-tv-default="" data-tv-box="" tabIndex={0} className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400">
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

                {/* Lejátszó motor: beépített HTML5 vagy natív TV-dekóder */}
                <div data-tv-box="" tabIndex={0}
                  onKeyDown={(event) => {
                    const key = normalizeTvKey(event);
                    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
                    if (key === 'ArrowLeft' || key === 'ArrowRight') {
                      event.preventDefault();
                      event.stopPropagation();
                      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
                      const next = current < 0
                        ? (settings.streamFormat === 'hls' ? 1 : 0)
                        : (current + (key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
                      buttons[next]?.focus({ preventScroll: true });
                    } else if (key === 'Enter' && event.target === event.currentTarget) {
                      event.preventDefault();
                      buttons[settings.streamFormat === 'hls' ? 1 : 0]?.click();
                    }
                  }}
                  className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-amber-400/60 shadow-sm space-y-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400">
                  <label className="flex items-center gap-2 text-xs font-bold text-white">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-400/10"><Cast className="h-4 w-4 text-amber-300" /></span>
                    <span>Lejátszó motor</span>
                  </label>
                  <p className="text-[11px] text-slate-400 leading-tight">
                    Válaszd ki, melyik lejátszó fusson. A választás megmarad újraindítás után is.
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 pt-1">
                    <button
                      onClick={() => onUpdateSettings({ playerEngine: 'html5' })}
                      className={`py-2 px-1 rounded-xl text-xs font-black transition-all ${
                        (settings.playerEngine || 'html5') === 'html5'
                          ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                          : 'bg-[#0e1f3f] text-slate-300 border border-slate-700/60 hover:bg-[#142b56]'
                      }`}
                    >
                      Beépített (HTML5)
                    </button>
                    <button
                      onClick={() => onUpdateSettings({ playerEngine: 'native' })}
                      className={`py-2 px-1 rounded-xl text-xs font-black transition-all ${
                        settings.playerEngine === 'native'
                          ? 'bg-emerald-400 text-slate-950 shadow-md shadow-emerald-400/30'
                          : 'bg-[#0e1f3f] text-slate-300 border border-slate-700/60 hover:bg-[#142b56]'
                      }`}
                    >
                      Natív (TV dekóder)
                    </button>
                  </div>
                  <p className="text-[11px] text-cyan-300 leading-tight pt-1">
                    {(settings.playerEngine || 'html5') === 'html5'
                      ? 'Beépített: HLS, automatikus MPEG-TS váltás, teljes OSD. Ez a legbiztonságosabb.'
                      : 'Natív: a szolgáltató eredeti MPEG-TS címe a TV hardveres dekóderén, formátumváltás nélkül, visszafogott felülettel.'}
                  </p>
                </div>

                {/* Élő adás streamformátuma – ugyanaz a beállítás mindkét lejátszómódban. */}
                <div data-tv-box="" tabIndex={0} className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-amber-400/60 shadow-sm space-y-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400">
                  <label className="flex items-center gap-2 text-xs font-bold text-white">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-400/10"><Tv className="h-4 w-4 text-amber-300" /></span>
                    <span>Élő adás formátuma</span>
                  </label>
                  <p className="text-[11px] text-slate-400 leading-tight">
                    Válaszd ki, milyen formátummal próbálja lejátszani az élő csatornákat. A választás mindkét lejátszómódra érvényes, és csatornaváltáskor is megmarad.
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => onUpdateSettings({ streamFormat: 'ts' })}
                      className={`py-2 px-1 rounded-xl text-xs font-black transition-all ${(settings.streamFormat || 'ts') === 'ts' ? 'bg-amber-400 text-slate-950 shadow-md shadow-amber-400/30' : 'bg-[#0e1f3f] text-slate-300 border border-slate-700/60 hover:bg-[#142b56]'}`}
                      aria-pressed={(settings.streamFormat || 'ts') === 'ts'}
                    >
                      MPEG-TS (.ts)
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdateSettings({ streamFormat: 'hls' })}
                      className={`py-2 px-1 rounded-xl text-xs font-black transition-all ${settings.streamFormat === 'hls' ? 'bg-amber-400 text-slate-950 shadow-md shadow-amber-400/30' : 'bg-[#0e1f3f] text-slate-300 border border-slate-700/60 hover:bg-[#142b56]'}`}
                      aria-pressed={settings.streamFormat === 'hls'}
                    >
                      HLS (.m3u8)
                    </button>
                  </div>
                  <p className="text-[11px] text-cyan-300 leading-tight pt-1">
                    {settings.streamFormat === 'hls' ? 'HLS van kiválasztva. A lejátszó nem vált át automatikusan MPEG-TS-re.' : 'MPEG-TS van kiválasztva. A lejátszó nem vált át automatikusan HLS-re.'}
                  </p>
                </div>

                {/* OSD automatikus elrejtése */}
                <div data-tv-box="" tabIndex={0} className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400">
                  <label className="flex items-center gap-2 text-xs font-bold text-white">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/10"><PanelsTopLeft className="h-4 w-4 text-cyan-300" /></span>
                    <span>OSD automatikus elrejtése</span>
                  </label>
                  <p className="text-[11px] text-slate-400 leading-tight">
                    A lejátszó vezérlőmenüje (és a teljes képernyős OSD) ennyi idő után automatikusan eltűnik.
                  </p>
                  <div className="grid grid-cols-4 gap-1.5 pt-1">
                    {/* Kérés szerint: 6 / 8 / 10 / 12 másodperc választható. */}
                    {[6, 8, 10, 12].map((seconds) => (
                      <button
                        key={seconds}
                        onClick={() => onUpdateSettings({ osdHideDelay: seconds })}
                        className={`py-2 rounded-xl text-xs font-black transition-all ${
                          settings.osdHideDelay === seconds
                            ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                            : 'bg-[#0e1f3f] text-slate-300 border border-slate-700/60 hover:bg-[#142b56]'
                        }`}
                      >
                        {seconds} mp
                      </button>
                    ))}
                  </div>
                </div>

                {/*
                  A tükrözés-sor a Rendszer fülről ELTÁVOLÍTVA (a felhasználó
                  kérése: vizuálisan ne legyen ott). A funkció változatlanul
                  működik: a PIROS (Record) gomb kapcsolja, és a beállítás
                  továbbra is a tárolóban marad.
                */}

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
                    Alap hangsáv (film / sorozat)
                  </label>
                  <p className="text-[11px] text-slate-400 leading-tight">
                    A film indításakor automatikusan ezt a hangsávot választja, ha a stream
                    kínál ilyet. A lejátszó OSD Audio gombjával bármikor átváltható – a gomb
                    ZÖLD, ha több hangsáv közül lehet választani.
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
                    Alap felirat (film / sorozat)
                  </label>
                  <p className="text-[11px] text-slate-400 leading-tight">
                    A film indításakor ezt a feliratot kapcsolja be. A lejátszó OSD CC gombja
                    ZÖLD, ha van választható felirat; ott bármikor átváltható vagy kikapcsolható.
                  </p>
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
                    <Smartphone className="w-5 h-5 shrink-0" />
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

                {onOpenDiagnosticShare && (
                  <button
                    data-tv-default=""
                    onClick={onOpenDiagnosticShare}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#0e1f3f] hover:bg-[#142b56] text-cyan-200 border border-cyan-800/50 text-xs font-bold active:scale-95 transition-all"
                    title="Diagnosztika megosztása QR-kóddal (korábban a PIROS gomb)"
                  >
                    <Smartphone className="w-6 h-6 shrink-0" />
                    <span>Diagnosztika megosztása (QR)</span>
                  </button>
                )}

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

  // A portál a <body>-ba teszi a menüt: így a Mozi/Sorozat tükrözött
  // elrendezése (flex-row-reverse) nem tudja eltorzítani a panel méretét.
  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
};
