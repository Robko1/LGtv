import { ChannelLogo } from './ChannelLogo';
import { APP_ICON_DATA_URL } from '../generatedIcon';
// A Beállítások füleinek nagy ikonjai: fogaskerék a takaróképről,
// szív és jel-pajzs a felhasználó által beküldött képekből (2.5.230).
import { KEDVENCEK_ICON_DATA_URL, LISTAK_ICON_DATA_URL, MENU_GEAR_ICON_DATA_URL } from '../generatedMenuIcons';
// Kép alapú kedvencmappa-ikonok (Mr Bean, HBO Max) megjelenítése a mappalistában.
import { getFolderImageIcon } from '../folderImageIcons';
import { TvDoctorIcon } from './TvDoctorIcon';
import { SupabasePairingModal } from './SupabasePairingModal';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppSettings, Channel, FavoriteFolder, ProviderAccount, SubtitleSize, WatchHistoryItem } from '../types/iptv';
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
  Star,
  PanelsTopLeft,
  Clock,
  KeyRound,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import { storageService } from '../services/storageService';
import {
  getTvDoctorMemoryStats,
  subscribeTvDoctorUpdates,
} from '../services/tvDoctor';
import {
  getTvDoctorCloudStatus,
  getTvDoctorPairingInfo,
} from '../services/tvDoctorCloud';
import { normalizeTvKey } from '../utils/tvKeys';
import { WEB_VERSION } from '../appVersion';
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
  /** A meglévő általános diagnosztikai megosztási útvonal bekötése megmarad. */
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
  const [showReleaseDetails, setShowReleaseDetails] = useState(false);
  const showApplicationBox = true; // állandó rész, nem csukható
  const [expandedFavoriteFolderId, setExpandedFavoriteFolderId] = useState<string | null>(null);
  /*
   * TV-n a window.confirm() NEM működik: a webOS böngészője nem jelenít meg
   * natív párbeszédablakot (a hívás azonnal false-szal tér vissza), ezért a
   * kedvenc mappa TÖRLÉSE és a gyorsítótár törlése hatástalan volt.
   * Helyette a felületen belüli, távirányítóval is elérhető kérdés jelenik meg.
   */
  const [pendingDeleteFolderId, setPendingDeleteFolderId] = useState<string | null>(null);
  /*
   * SZOLGÁLTATÓ TÖRLÉSE – saját megerősítés.
   *
   * A piros kuka eddig `window.confirm`-ot hívott, ami a webOS TV
   * böngészőjében nem jelenik meg (azonnal `false`-t ad), ezért a törlés
   * hatástalan volt. A megerősítés most ugyanaz a sáv, mint a mappáknál:
   * távirányítóval is elérhető, és nem hagyja el a felületet.
   */
  const [pendingDeleteProviderId, setPendingDeleteProviderId] = useState<string | null>(null);
  const [pendingClearCache, setPendingClearCache] = useState(false);
  const [isSupabasePairingOpen, setIsSupabasePairingOpen] = useState(false);
  const pairingBoxRef = useRef<HTMLDivElement | null>(null);
  const [, setDoctorUiTick] = useState(0);

  useEffect(() => {
    if (!isOpen || activeTab !== 'system') return undefined;
    return subscribeTvDoctorUpdates(() => {
      setDoctorUiTick((n) => n + 1);
    });
  }, [isOpen, activeTab]);
  // A kék teletextgomb a Kedvencek fülön nem indíthat csatornamozgatást.
  // A globális távirányító-kezelés más nézetekben változatlan marad.

  const checkWebOSUpdate = async () => {
    setReleaseCheckLoading(true);
    setReleaseCheckStatus('A nyilvános webOS kiadás ellenőrzése…');
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

  // A Kedvencek fül minden távirányítós nyílkezelése itt van központosítva.
  // A kártyákon és gombokon nincs külön nyílkezelő, így nem írhatják felül egymást.
  const handleFavoritesNavigation = (e: React.KeyboardEvent): boolean => {
    const key = normalizeTvKey(e);
    const root = modalRef.current;
    if (!root) return false;
    const target = e.target as HTMLElement;
    const folder = target.closest<HTMLElement>('[data-favorite-folder]');
    const channel = target.closest<HTMLElement>('[data-favorite-channel]');
    const resumeSection = target.closest<HTMLElement>('[data-resume-section]');
    const resumeItem = target.closest<HTMLElement>('[data-resume-item]');
    const isNewFolder = !!target.closest('[data-tv-default]');
    const onTabs = !!target.closest('[data-tv-tabs]');
    if (onTabs && (key === 'ArrowUp' || key === 'ArrowDown')) {
      if (key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        root.querySelector<HTMLElement>('[data-tv-default]')?.focus({ preventScroll: true } as any);
      } else {
        e.preventDefault();
        e.stopPropagation();
      }
      return true;
    }
    // Enter a mappakártyán a mappa műveleteire visz; a Folytatás szekción
    // Enter az első Folytatás gombra visz. A tényleges gombok kattintása natív marad.
    if ((key === 'Enter' || key === ' ') && folder && target === folder) {
      e.preventDefault();
      e.stopPropagation();
      folder.querySelector<HTMLElement>('button[title="Mappa törlése"]')?.focus({ preventScroll: true } as any);
      return true;
    }
    if ((key === 'Enter' || key === ' ') && resumeSection && target === resumeSection) {
      e.preventDefault();
      e.stopPropagation();
      resumeSection.querySelector<HTMLElement>('[data-resume-continue]')?.focus({ preventScroll: true } as any);
      return true;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return false;
    const focus = (el?: HTMLElement | null) => {
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      el.focus({ preventScroll: true } as any);
      el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    };
    const block = () => { e.preventDefault(); e.stopPropagation(); };
    const folders = Array.from(root.querySelectorAll<HTMLElement>('[data-favorite-folder]')).filter(el => el.offsetParent !== null);
    const channels = folder ? Array.from(folder.querySelectorAll<HTMLElement>('[data-favorite-channel]')) : [];
    const resumeItems = Array.from(root.querySelectorAll<HTMLElement>('[data-resume-item]'));
    const continueButton = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-resume-continue]');
    const removeButton = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-resume-remove]');
    const currentResumeButton = target.closest<HTMLElement>('[data-resume-continue], [data-resume-remove]');

    if (isNewFolder) {
      if (key === 'ArrowUp') focus(root.querySelector<HTMLElement>('[data-tv-tabid="favorites"]'));
      else if (key === 'ArrowDown') focus(folders[0] || root.querySelector<HTMLElement>('[data-resume-section]'));
      else block();
      return true;
    }
    if (channel) {
      const index = channels.indexOf(channel);
      if (target.closest('[title="Eltávolítás a kedvenc mappából"]')) {
        if (key === 'ArrowLeft') focus(channel);
        else if (key === 'ArrowUp') {
          if (index > 0) focus(channels[index - 1].querySelector<HTMLElement>('[title="Eltávolítás a kedvenc mappából"]'));
          else focus(folder);
        } else if (key === 'ArrowDown') {
          if (index < channels.length - 1) focus(channels[index + 1].querySelector<HTMLElement>('[title="Eltávolítás a kedvenc mappából"]'));
          else focus(root.querySelector<HTMLElement>('[data-resume-section]'));
        } else block();
        return true;
      }
      if (key === 'ArrowUp') {
        if (index === 0) { setExpandedFavoriteFolderId(null); focus(folder); }
        else focus(channels[index - 1]);
      } else if (key === 'ArrowDown') {
        if (index < channels.length - 1) focus(channels[index + 1]);
        else focus(root.querySelector<HTMLElement>('[data-resume-section]'));
      } else if (key === 'ArrowRight') focus(channel.querySelector<HTMLElement>('[title="Eltávolítás a kedvenc mappából"]'));
      else if (key === 'ArrowLeft') focus(folder);
      return true;
    }
    if (folder) {
      if (target.closest('button[title="Mappa törlése"]')) {
        if (key === 'ArrowLeft' || key === 'ArrowUp') focus(folder);
        else block(); // Jobbra és lefelé a Törlés gombon maradunk: nem léphet ki a mappából.
        return true;
      }
      const folderIndex = folders.indexOf(folder);
      const isExpanded = expandedFavoriteFolderId === folder.dataset.favoriteFolder;
      const folderChannels = Array.from(folder.querySelectorAll<HTMLElement>('[data-favorite-channel]'));
      if (key === 'ArrowUp') {
        focus(folderIndex > 0 ? folders[folderIndex - 1] : root.querySelector<HTMLElement>('[data-tv-default]'));
      } else if (key === 'ArrowDown') {
        // Az utolsó mappáról lefelé a Folytatás teljes dobozára kell lépni.
        if (isExpanded && folderChannels.length) focus(folderChannels[0]);
        else if (folderIndex < folders.length - 1) focus(folders[folderIndex + 1]);
        else focus(root.querySelector<HTMLElement>('[data-resume-section]'));
      } else if (key === 'ArrowRight' || key === 'ArrowLeft') {
        // A teljes mappadoboz vízszintesen nem vált másik szekcióra,
        // és nem nyit/zár mappát. OK-val külön a Törlés gomb érhető el.
        block();
      } else block();
      return true;
    }
    if (currentResumeButton && resumeItem) {
      const index = resumeItems.indexOf(resumeItem);
      const isRemove = currentResumeButton.hasAttribute('data-resume-remove');
      if (key === 'ArrowLeft') {
        if (isRemove) focus(continueButton(resumeItem)); else block();
      } else if (key === 'ArrowRight') {
        if (!isRemove) focus(removeButton(resumeItem)); else block();
      } else if (key === 'ArrowUp' || key === 'ArrowDown') {
        const next = index + (key === 'ArrowDown' ? 1 : -1);
        if (next >= 0 && next < resumeItems.length) focus(isRemove ? removeButton(resumeItems[next]) : continueButton(resumeItems[next]));
        else if (key === 'ArrowUp') focus(root.querySelector<HTMLElement>('[data-resume-section]'));
        else block();
      }
      return true;
    }
    if (resumeItem) {
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        const index = resumeItems.indexOf(resumeItem);
        const next = index + (key === 'ArrowDown' ? 1 : -1);
        if (next >= 0 && next < resumeItems.length) focus(continueButton(resumeItems[next]));
        else if (key === 'ArrowUp') focus(root.querySelector<HTMLElement>('[data-resume-section]'));
        else block();
      } else block();
      return true;
    }
    if (resumeSection) {
      // A Folytatás teljes dobozáról lefelé nincs továbblépés.
      if (key === 'ArrowDown') block();
      else if (key === 'ArrowUp') focus(folders[folders.length - 1] || root.querySelector<HTMLElement>('[data-tv-default]'));
      else block();
      return true;
    }
    return false;
  };

  const handleModalKeyDown = (e: React.KeyboardEvent) => {
    // A Rendszer fül dobozaiba OK-val belépve a nyilak nem ugorhatnak át
    // közvetlenül egy másik dobozra. A doboz saját vezérlői között maradunk;
    // vízszintes szélen a fókusz visszatér a saját doboz keretére.
    if (activeTab === 'system') {
      const key = normalizeTvKey(e);
      const target = e.target as HTMLElement;
      const box = target.closest<HTMLElement>('[data-tv-box]');
      const active = document.activeElement as HTMLElement | null;
      // Az LG webOS alkalmazás teljes kockáján a JOBBRA nyíl nem végez műveletet.
      // Az OK-val történő belépést és a többi nyíl működését változatlanul hagyjuk.
      if (box?.hasAttribute('data-system-app-container') && active === box && key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (box && (
        ['ArrowLeft', 'ArrowRight'].includes(key) ||
        (['ArrowUp', 'ArrowDown'].includes(key) && active !== box) ||
        (key === 'Enter' && active === box)
      )) {
        const controls = Array.from(box.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [role="button"]:not([aria-disabled="true"])'
        )).filter((el) => el.getClientRects().length > 0);
        e.preventDefault();
        e.stopPropagation();
        if (key === 'Enter' && active === box) {
          if (controls.length === 1) {
            controls[0].click();
            return;
          }
          const boxDef = box.querySelector<HTMLElement>('[data-tv-box-default]');
          const enterTarget = boxDef && controls.includes(boxDef) ? boxDef : controls[0];
          enterTarget?.focus({ preventScroll: true } as any);
          enterTarget?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
          return;
        }
        if (key === 'ArrowUp' || key === 'ArrowDown') {
          if (box.hasAttribute('data-tv-doctor-box') && active !== box) {
            const index = controls.indexOf(active as HTMLElement);
            if (index >= 0) {
              const next = index + (key === 'ArrowDown' ? 1 : -1);
              if (next >= 0 && next < controls.length) {
                controls[next]?.focus({ preventScroll: true } as any);
                controls[next]?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
              } else {
                box.focus({ preventScroll: true } as any);
              }
              return;
            }
            box.focus({ preventScroll: true } as any);
          }
          return;
        }
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
          const index = controls.indexOf(active as HTMLElement);
          if (index < 0) {
            if (key === 'ArrowRight') controls[0]?.focus({ preventScroll: true } as any);
            return;
          } else {
            const next = index + (key === 'ArrowRight' ? 1 : -1);
            if (next >= 0 && next < controls.length) {
              controls[next]?.focus({ preventScroll: true } as any);
              controls[next]?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            } else {
              box.focus({ preventScroll: true } as any);
            }
          }
          return;
        }
      }
    }
    // A Listák fül fejlécének helyi D-pad útvonala. Megállítjuk az eseményt,
    // hogy az általános fel/le navigáció ne írja felül a kijelölést.
    if (activeTab === 'lists') {
      const key = normalizeTvKey(e);
      const target = e.target as HTMLElement;
      const headerAction = target.closest<HTMLElement>('[data-tv-list-action]');
      if (headerAction && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
        e.preventDefault();
        e.stopPropagation();
        const action = headerAction.dataset.tvListAction;
        const root = modalRef.current;
        if (key === 'ArrowDown') {
          root?.querySelector<HTMLElement>('[data-tv-box]')?.focus({ preventScroll: true } as any);
          return;
        }
        if (key === 'ArrowUp') {
          if (action === 'phone') {
            root?.querySelector<HTMLElement>('[data-tv-tabid="lists"]')?.focus({ preventScroll: true } as any);
          }
          return;
        }
        if (key === 'ArrowRight') {
          if (action === 'phone') {
            root?.querySelector<HTMLElement>('[data-tv-list-action="new"]')?.focus({ preventScroll: true } as any);
          }
          return;
        }
        if (key === 'ArrowLeft') {
          if (action === 'new') {
            root?.querySelector<HTMLElement>('[data-tv-list-action="phone"]')?.focus({ preventScroll: true } as any);
          }
          return;
        }
      }

      // A teljes törlés gomb külön fókuszpont: fel vissza a Provider dobozára,
      // le nem mozdul; a jobbra nyíl jelenlegi működését nem módosítjuk.
      const clearAll = target.closest<HTMLElement>('[data-tv-clear-all]');
      if (clearAll && (key === 'ArrowUp' || key === 'ArrowDown')) {
        e.preventDefault();
        e.stopPropagation();
        if (key === 'ArrowUp') {
          modalRef.current?.querySelector<HTMLElement>('[data-tv-box]')?.focus({ preventScroll: true } as any);
        }
        return;
      }

      // A Provider doboz és a belső műveleti gombok külön fókuszterületet alkotnak.
      const box = target.closest<HTMLElement>('[data-tv-box]');
      const active = document.activeElement as HTMLElement | null;
      if (box && (
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key) ||
        (key === 'Enter' && active === box)
      )) {
        const controls = Array.from(box.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [role="button"]:not([aria-disabled="true"])'
        )).filter((el) => el.getClientRects().length > 0);
        e.preventDefault();
        e.stopPropagation();
        if (key === 'Enter' && active === box) {
          controls[0]?.focus({ preventScroll: true } as any);
          controls[0]?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
          return;
        }
        if (active !== box) {
          // A belső műveletek csak balra/jobbra járhatók; minden más nyíl
          // visszaadja a fókuszt a Provider teljes dobozának.
          if (key === 'ArrowLeft' || key === 'ArrowRight') {
            const index = controls.indexOf(active as HTMLElement);
            if (index >= 0) {
              const next = index + (key === 'ArrowRight' ? 1 : -1);
              if (next >= 0 && next < controls.length) {
                controls[next]?.focus({ preventScroll: true } as any);
                controls[next]?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
              } else {
                box.focus({ preventScroll: true } as any);
              }
            } else {
              box.focus({ preventScroll: true } as any);
            }
          } else {
            box.focus({ preventScroll: true } as any);
          }
          return;
        }
        if (key === 'ArrowUp') {
          modalRef.current?.querySelector<HTMLElement>('[data-tv-list-action="phone"]')?.focus({ preventScroll: true } as any);
          return;
        }
        if (key === 'ArrowDown') {
          modalRef.current?.querySelector<HTMLElement>('[data-tv-clear-all]')?.focus({ preventScroll: true } as any);
          return;
        }
        // A teljes Provider dobozon balra/jobbra nem történik semmi.
        return;
      }
    }
    if (activeTab === 'favorites') {
      if (handleFavoritesNavigation(e)) return;
      const key = normalizeTvKey(e);
      if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
        // A Kedvencek fülön egyetlen hely dönt a nyilakról; az általános
        // modal-navigáció nem veheti át a kezelést.
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
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
      if (pendingDeleteProviderId) {
        e.preventDefault();
        e.stopPropagation();
        setPendingDeleteProviderId(null);
        return;
      }
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

        {/* 3 fül – nagy, egyforma ikonokkal (a felhasználó képeiből), alattuk a felirat (2.5.230) */}
        <div data-tv-tabs="" className="px-3 py-2 bg-[#081329] border-b border-cyan-950/60 flex items-center gap-1.5 overflow-x-auto no-scrollbar">


          <button
            data-tv-tabid="lists"
            onKeyDown={(event) => handleTabDpad(event, 'lists')}
            onClick={() => setActiveTab('lists')}
            className={`flex-1 min-w-[96px] h-24 px-2.5 pt-1 pb-1.5 rounded-xl text-sm font-black transition-all flex flex-col items-center ${
              activeTab === 'lists'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                : 'bg-[#0f2144] text-slate-300 hover:bg-[#152e5c]'
            }`}
          >
            {/* 2.5.236: nagyobb ikon (a doboz mérete rögzítve változatlan),
                a felirat a doboz legaljára került. Háttér itt nem kell. */}
            <span aria-hidden="true" className="flex-1 min-h-0 w-full flex items-center justify-center pointer-events-none select-none">
              <img src={LISTAK_ICON_DATA_URL} alt="" className="h-full w-auto max-w-full object-contain" />
            </span>
            <span className="truncate leading-tight">Listák</span>
          </button>

          <button
            data-tv-open-focus=""
            data-tv-tabid="favorites"
            onKeyDown={(event) => handleTabDpad(event, 'favorites')}
            onClick={() => setActiveTab('favorites')}
            className={`flex-1 min-w-[96px] h-24 px-2.5 pt-1 pb-1.5 rounded-xl text-sm font-black transition-all flex flex-col items-center ${
              activeTab === 'favorites'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                : 'bg-[#0f2144] text-slate-300 hover:bg-[#152e5c]'
            }`}
          >
            <span aria-hidden="true" className="flex-1 min-h-0 w-full flex items-center justify-center pointer-events-none select-none">
              <img src={KEDVENCEK_ICON_DATA_URL} alt="" className="h-full w-auto max-w-full object-contain" />
            </span>
            <span className="truncate leading-tight">Kedvencek</span>
          </button>

          <button
            data-tv-tabid="system"
            onKeyDown={(event) => handleTabDpad(event, 'system')}
            onClick={() => setActiveTab('system')}
            className={`flex-1 min-w-[96px] h-24 px-2.5 pt-1 pb-1.5 rounded-xl text-sm font-black transition-all flex flex-col items-center ${
              activeTab === 'system'
                ? 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-400/30'
                : 'bg-[#0f2144] text-slate-300 hover:bg-[#152e5c]'
            }`}
          >
            <span aria-hidden="true" className="flex-1 min-h-0 w-full flex items-center justify-center pointer-events-none select-none">
              <img src={MENU_GEAR_ICON_DATA_URL} alt="" className="h-full w-auto max-w-full object-contain" />
            </span>
            <span className="truncate leading-tight">Rendszer</span>
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
                    data-tv-list-action="phone"
                    onClick={onOpenQrProvision}
                    className="flex-1 min-w-0 flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 text-base font-black active:scale-95 transition-all shadow-md shadow-amber-400/25"
                    title="Telefonnal beállítás QR kóddal – nem kell TV-n pötyögni"
                  >
                    <Smartphone className="w-6 h-6 shrink-0" />
                    <span>📱 Telefon</span>
                  </button>
                  <button
                    data-tv-list-action="new"
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
                {providers.map((p, providerIndex) => {
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
                      <div className="mt-2 text-sm font-black text-cyan-300 tracking-tight">
                        {p.channelsCount.toLocaleString()} csatorna • {p.moviesCount.toLocaleString()} film • {p.seriesCount.toLocaleString()} sorozat
                      </div>

                      {/* Type & Date */}
                      <div className="mt-1 text-base text-slate-300 font-medium">
                        {p.type === 'xtream' ? 'Xtream Codes' : 'M3U Lista'} • frissítve {p.lastUpdated}
                      </div>

                      {/* Provider Expiry in Yellow */}
                      <div className="mt-1 text-sm font-bold text-amber-400">
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
                          onClick={() => setPendingDeleteProviderId(
                            pendingDeleteProviderId === p.id ? null : p.id
                          )}
                          aria-expanded={pendingDeleteProviderId === p.id}
                          className="p-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 border border-rose-800/40 ml-auto active:scale-95 transition-all"
                          title="Törlés"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      {/* Törlés megerősítése – a távirányítóval is működik (nincs window.confirm). */}
                      {pendingDeleteProviderId === p.id && (
                        <div className="mt-2.5 rounded-xl border border-rose-800/50 bg-rose-950/30 p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <p className="text-xs font-bold text-rose-200">
                            Biztosan törlöd ezt a listát: „{p.name}”?
                          </p>
                          <div className="flex gap-2 shrink-0">
                            <button
                              autoFocus
                              onClick={() => {
                                onDeleteProvider(p.id);
                                setPendingDeleteProviderId(null);
                                /*
                                 * Törlés után a fókusz ne a semmibe kerüljön:
                                 * a következő lista doboza (ha nincs, az
                                 * „Új lista” gomb) kapja a kijelölést.
                                 */
                                window.setTimeout(() => {
                                  const remaining = Array.from(
                                    modalRef.current?.querySelectorAll<HTMLElement>('[data-tv-box]') || []
                                  );
                                  const nextBox = remaining[Math.min(providerIndex, remaining.length - 1)]
                                    || modalRef.current?.querySelector<HTMLElement>('[data-tv-list-action="new"]');
                                  nextBox?.focus({ preventScroll: true } as any);
                                }, 0);
                              }}
                              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-600 text-white text-xs font-black active:scale-95"
                            >
                              <Trash2 className="w-4 h-4" />
                              <span>Igen, törlés</span>
                            </button>
                            <button
                              onClick={(event) => {
                                const card = event.currentTarget.closest('[data-tv-box]');
                                setPendingDeleteProviderId(null);
                                // A megerősítés bezárása után a kuka maradjon kijelölve.
                                window.setTimeout(() => {
                                  card?.querySelector<HTMLElement>('button[title="Törlés"]')
                                    ?.focus({ preventScroll: true } as any);
                                }, 0);
                              }}
                              className="px-3 py-2 rounded-xl bg-[#0f2042] border border-slate-600 text-slate-200 text-xs font-bold active:scale-95"
                            >
                              Mégse
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Danger Zone: Clear all lists */}
              {!pendingClearCache ? (
                <button
                  data-tv-clear-all=""
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
                      className={`rounded-2xl bg-[#0d1d3d] border-2 shadow-md overflow-hidden focus:outline-none focus:ring-2 focus:ring-amber-400 focus-within:ring-2 focus-within:ring-amber-400 ${folderIndex % 2 === 0 ? 'border-cyan-500/80' : 'border-amber-400/80'}`}>
                      <div className="p-3.5 flex items-center justify-between gap-3">
                        <div
                          aria-hidden="true"
                          className="flex items-center gap-3 min-w-0 flex-1 text-left pointer-events-none"
                        >
                          {(() => {
                            // Kép ikonos mappánál (Mr Bean, HBO Max) a kép jelenik meg, nagyobb méretben.
                            const imageIcon = getFolderImageIcon(f.icon);
                            return imageIcon ? (
                              <img src={imageIcon.dataUrl} alt={imageIcon.name} className="w-14 h-14 rounded-xl object-cover shrink-0 pointer-events-none select-none border border-amber-400/40" />
                            ) : (
                              <div className="w-10 h-10 rounded-xl bg-amber-400/20 border border-amber-400/40 flex items-center justify-center text-xl shrink-0">{f.icon || '📁'}</div>
                            );
                          })()}
                          <div className="min-w-0">
                            <h4 className="text-white font-bold text-sm truncate">{f.name}</h4>
                            <p className="text-xs text-slate-400 font-medium">{folderChannels.length} csatorna</p>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            onDeleteFolder(f.id);
                            setPendingDeleteFolderId(null);
                            if (expandedFavoriteFolderId === f.id) setExpandedFavoriteFolderId(null);
                            // Törlés után a következő mappa maradjon fókuszban; ha nincs,
                            // az Új mappa gomb legyen a következő célpont.
                            window.setTimeout(() => {
                              const remaining = Array.from(modalRef.current?.querySelectorAll<HTMLElement>('[data-favorite-folder]') || []);
                              (remaining[Math.min(folderIndex, remaining.length - 1)] || modalRef.current?.querySelector<HTMLElement>('[data-tv-default]'))?.focus({ preventScroll: true } as any);
                            }, 0);
                          }}
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
                          ) : folderChannels.map((channel) => {
                            return (
                              <div
                                key={channel.id}
                                data-favorite-channel={channel.id}
                                tabIndex={0}
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
                                  onPointerDown={(event) => event.stopPropagation()}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    const folderElement = event.currentTarget.closest<HTMLElement>('[data-favorite-folder]');
                                    onRemoveChannelFromFolder(f.id, channel.id);
                                    setExpandedFavoriteFolderId(null);
                                            window.setTimeout(() => folderElement?.focus({ preventScroll: true } as any), 0);
                                  }}
                                  className="shrink-0 flex items-center justify-center w-8 h-8 rounded-xl border transition-all bg-amber-400/20 text-amber-300 border-amber-400/50 active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300"
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
              <section data-tv-box="" data-resume-section="" tabIndex={0}
                className="rounded-2xl border border-cyan-500/70 bg-[#0d1c3a] p-4 space-y-3 shadow-lg shadow-cyan-950/20 focus:outline-none focus:ring-2 focus:ring-amber-400">
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
                    {resumableHistory.map((item) => (
                        <div
                          key={item.id}
                          role="group"
                          data-resume-item={item.id}
                          className="rounded-xl border border-cyan-900/60 bg-[#071329]/80 p-3">
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
                              onClick={() => {
                                onRemoveWatchHistoryItem(item.id);
                                // Törlés után ne ugorjon át automatikusan egy másik filmre.
                                // A Folytatás szekció maradjon kijelölve.
                                window.setTimeout(() => {
                                  modalRef.current?.querySelector<HTMLElement>('[data-resume-section]')?.focus({ preventScroll: true } as any);
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

          {/* ================= TAB 4: RENDSZER ================= */}
          {activeTab === 'system' && (
            <div className="space-y-5 animate-fadeIn">

              {/* 1. SECTION: TV DOKTOR (legelső a Rendszer felsorolásban) */}
              {(() => {
                const tvDoctorEnabled = settings.tvDoctorEnabled !== false;
                const doctorMem = getTvDoctorMemoryStats();
                const doctorCloud = getTvDoctorCloudStatus();
                const pairingInfo = getTvDoctorPairingInfo();

                const hasStorageError = Boolean(doctorMem.lastStorageError);

                let overallBadgeText = 'Kikapcsolva';
                let overallBadgeClass = 'bg-slate-800 text-slate-300 border-slate-600/60';
                if (tvDoctorEnabled) {
                  if (hasStorageError || doctorCloud.connectionState === 'error') {
                    overallBadgeText = 'Hiba észlelve';
                    overallBadgeClass = 'bg-rose-500/20 text-rose-200 border-rose-400/60';
                  } else if (doctorCloud.connectionState === 'offline') {
                    overallBadgeText = 'Offline gyorsítótár';
                    overallBadgeClass = 'bg-amber-500/20 text-amber-200 border-amber-400/60';
                  } else {
                    overallBadgeText = 'Minden rendben';
                    overallBadgeClass = 'bg-emerald-500/20 text-emerald-200 border-emerald-400/55';
                  }
                }

                return (
                  <div
                    data-tv-doctor-section=""
                    className="p-4 rounded-2xl bg-[#0a1630] border border-cyan-900/50 space-y-3.5 shadow-md"
                  >
                    <h3 className="text-base font-black text-amber-400 flex items-center gap-2.5 uppercase tracking-wider">
                      <TvDoctorIcon handled={true} className="h-7 w-7 shrink-0" />
                      <span>TV Doktor</span>
                    </h3>

                    {/* Fő TV Doktor doboz: kizárólag a Ki/Be kapcsoló és a feliratok (az állapot, napló és Memória: 0 a 0-ás gombon érhető el) */}
                    <div
                      data-tv-default=""
                      data-tv-box=""
                      data-tv-doctor-box=""
                      tabIndex={0}
                      className="p-4 rounded-xl bg-[#0e1d3b]/95 border-2 border-cyan-500/65 shadow-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                    >
                      <div data-tv-doctor-header="" className="flex items-center justify-between gap-4">
                        <div className="flex min-w-0 flex-1 items-start gap-3.5">
                          <span data-tv-doctor-menu-icon="" className="shrink-0">
                            <TvDoctorIcon
                              handled={tvDoctorEnabled}
                              disabled={!tvDoctorEnabled}
                              className="h-14 w-14 mt-0.5"
                            />
                          </span>
                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-2.5">
                              <span className="text-base sm:text-lg font-black text-white leading-tight">
                                Intelligens hibajavítás
                              </span>
                              <span
                                data-tv-doctor-status-badge=""
                                className={`inline-flex items-center rounded-lg border px-2.5 py-0.5 text-xs sm:text-sm font-black uppercase tracking-wide ${overallBadgeClass}`}
                              >
                                {overallBadgeText}
                              </span>
                            </div>

                            <p
                              data-tv-doctor-short-desc=""
                              className="line-clamp-2 text-sm sm:text-base text-slate-200 font-medium leading-snug"
                            >
                              Automatikus élő adás- és lejátszásfelügyelet, pufferoptimalizálás és öngyógyító hibajavítás. Részletes állapot és napló: 0 gomb élő TV közben.
                            </p>
                          </div>
                        </div>

                        <div data-tv-doctor-controls="" className="shrink-0">
                          <button
                            type="button"
                            role="switch"
                            data-tv-doctor-toggle=""
                            aria-checked={tvDoctorEnabled}
                            aria-label="TV Doktor be- és kikapcsolása"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              onUpdateSettings({ tvDoctorEnabled: !tvDoctorEnabled });
                            }}
                            className={`w-14 h-7 rounded-full transition-colors relative shrink-0 p-0.5 focus:outline-none focus:ring-2 focus:ring-amber-400 ${
                              tvDoctorEnabled ? 'bg-cyan-400' : 'bg-slate-700'
                            }`}
                          >
                            <div
                              className={`w-6 h-6 rounded-full bg-slate-950 shadow-md transition-transform ${
                                tvDoctorEnabled ? 'translate-x-7' : 'translate-x-0'
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Különálló Supabase-párosítás menüpont a TV Doktor alatt */}
                    <div
                      ref={pairingBoxRef}
                      data-tv-box=""
                      data-tv-doctor-pairing-box=""
                      tabIndex={0}
                      className="p-4 rounded-xl bg-[#0e1d3b]/95 border-2 border-cyan-500/65 shadow-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                    >
                      <button
                        type="button"
                        data-tv-doctor-pairing-menu=""
                        onClick={() => setIsSupabasePairingOpen(true)}
                        className="w-full flex flex-wrap items-center justify-between gap-3 text-left focus:outline-none rounded-lg"
                      >
                        <div className="flex min-w-0 items-center gap-3.5">
                          <span
                            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 ${
                              pairingInfo.paired
                                ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-300'
                                : 'border-amber-400/55 bg-amber-500/15 text-amber-300'
                            }`}
                          >
                            {pairingInfo.paired ? (
                              <ShieldCheck className="h-6 w-6" />
                            ) : (
                              <KeyRound className="h-6 w-6" />
                            )}
                          </span>
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2.5">
                              <span className="text-base sm:text-lg font-black text-white">
                                Supabase-párosítás
                              </span>
                              <span
                                data-tv-doctor-pairing-badge=""
                                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-0.5 text-xs sm:text-sm font-black uppercase tracking-wide ${
                                  pairingInfo.paired
                                    ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200'
                                    : 'border-amber-400/55 bg-amber-500/20 text-amber-200'
                                }`}
                              >
                                {pairingInfo.paired ? (
                                  <>
                                    <ShieldCheck className="h-3.5 w-3.5" />
                                    <span>Párosítva</span>
                                  </>
                                ) : (
                                  <>
                                    <ShieldAlert className="h-3.5 w-3.5" />
                                    <span>Nincs párosítva</span>
                                  </>
                                )}
                              </span>
                            </div>
                            <span className="block text-sm text-slate-200 font-medium leading-snug">
                              {pairingInfo.paired
                                ? `Eszköz azonosítója: ${pairingInfo.deviceId} • Védett Supabase szinkron aktív`
                                : `Egyszeri 6 jegyű számkód megadása ehhez a TV-hez (${pairingInfo.deviceId})`}
                            </span>
                          </div>
                        </div>

                        <span className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/60 bg-cyan-500/20 px-4 py-2 text-sm sm:text-base font-black text-cyan-100 shrink-0">
                          <KeyRound className="h-4 w-4" />
                          <span>Megnyitás</span>
                        </span>
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* 2. OSD ÉS ÓRA BEÁLLÍTÁSOK (a sárga Lejátszó felirat és a Pufferelés doboz vizuálisan eltávolítva) */}
              <div className="p-3.5 rounded-2xl bg-[#0a1630] border border-cyan-900/40 space-y-3.5 shadow-md">
                {/* OSD automatikus elrejtése */}
                <div data-tv-box="" tabIndex={0} className="p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm space-y-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400">
                  <label className="flex items-center gap-2 text-xs font-bold text-white">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/10"><PanelsTopLeft className="h-4 w-4 text-cyan-300" /></span>
                    <span>OSD automatikus elrejtése</span>
                  </label>
                  <p className="text-[11px] text-slate-400 leading-tight truncate">
                    Az OSD ennyi idő után eltűnik.
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

                {/* Toggle: Kék óra mindig látszódjon */}
                <div data-tv-box="" tabIndex={0} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#0e1d3b]/90 border-2 border-cyan-500/60 shadow-sm focus:outline-none focus:ring-2 focus:ring-amber-400">
                  <div className="flex min-w-0 items-start gap-2.5 pr-3">
                    <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-sky-400/50 bg-sky-500/15 px-1.5 shadow-sm shadow-sky-950/40">
                      <Clock className="h-3.5 w-3.5 text-sky-300" />
                      <span className="font-mono text-[10px] font-black tracking-tight text-sky-200">00:00</span>
                    </span>
                    <div className="min-w-0">
                      <span className="text-xs font-bold text-white block">Kék óra mindig látszódjon</span>
                      <span className="block truncate whitespace-nowrap text-[11px] text-slate-400">Teljes képernyőn az OSD után is látható.</span>
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
                  <p className="text-[11px] text-slate-400 leading-tight truncate whitespace-nowrap">
                    Indításkor ezt a hangsávot választja, ha elérhető.
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
                  <p className="text-[11px] text-slate-400 leading-tight truncate whitespace-nowrap">
                    Indításkor ezt a feliratot választja, ha elérhető.
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
              <div data-tv-box="" data-system-app-container="" tabIndex={0} className="p-3.5 rounded-2xl bg-[#0a1630] border border-cyan-900/40 space-y-3.5 shadow-md focus:outline-none focus:ring-2 focus:ring-amber-400">
                <div className="w-full flex items-center justify-between text-left rounded-xl py-1.5">
                  <span className="text-xs font-black text-cyan-400 flex items-center gap-1.5 uppercase tracking-wider">
                    <Smartphone className="w-5 h-5 shrink-0" />
                    <span>LG webOS alkalmazás</span>
                  </span>
                </div>

                {/* webOS kiadás ellenőrzése */}
                {showApplicationBox && (
                  <div className="space-y-3">
                    <div className="p-3 rounded-xl bg-[#081329] border border-cyan-900/30 space-y-2.5">
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        A nyilvános webOS Release ellenőrzése. Az új IPK telepítéséhez webOS fejlesztői eszköz szükséges.
                      </p>
                      <button type="button" data-system-refresh="" disabled={releaseCheckLoading} onKeyDown={(event) => {
                        const key = normalizeTvKey(event);
                        if (key === 'ArrowLeft' || key === 'ArrowRight') {
                          event.preventDefault();
                          event.stopPropagation();
                        } else if (key === 'ArrowUp' || key === 'ArrowDown') {
                          event.preventDefault();
                          event.stopPropagation();
                          modalRef.current?.querySelector<HTMLElement>('[data-system-app-container]')?.focus({ preventScroll: true } as any);
                        }
                      }} onClick={() => {
                        if (showReleaseDetails) {
                          setShowReleaseDetails(false);
                        } else {
                          setShowReleaseDetails(true);
                          void checkWebOSUpdate();
                        }
                      }} className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-bold active:scale-95 transition-all disabled:opacity-60">
                        <RefreshCw className={releaseCheckLoading ? "w-3.5 h-3.5 animate-spin" : "w-3.5 h-3.5"} />
                        {showReleaseDetails ? 'Ellenőrzés bezárása' : releaseCheckLoading ? 'Ellenőrzés…' : 'Frissítés ellenőrzése'}
                      </button>
                      {showReleaseDetails && releaseInfo && (
                        <div className="rounded-lg border border-cyan-900/40 bg-slate-950/50 p-3 space-y-1">
                          <p className="text-[11px] text-slate-300">Telepített verzió: <strong>{releaseInfo.currentVersion}</strong></p>
                          <p className="text-[11px] text-slate-300">Legfrissebb kiadás: <strong>{releaseInfo.latestVersion}</strong></p>
                          {releaseInfo.ipkUrl ? <p className="text-[11px] text-emerald-300">A kiadás tartalmaz IPK-csomagot.</p> : <p className="text-[11px] text-amber-300">A kiadásban nem található IPK-fájl.</p>}
                        </div>
                      )}
                      {showReleaseDetails && releaseCheckStatus && <p role="status" className="text-[11px] text-slate-300">{releaseCheckStatus}</p>}
                    </div>
                  </div>
                )}

                {/* App Brand Badge */}
                <div data-system-app-box="" className="flex items-center gap-3 p-3 rounded-xl bg-[#0e1e3e] border border-cyan-800/40">
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
                      <span data-system-version="" className="text-xs text-slate-400 font-mono font-normal">
                        v{WEB_VERSION}
                      </span>
                    </h4>
                    <p className="text-xs text-cyan-300 font-semibold">
                      LG webOS TV mód
                    </p>
                  </div>
                </div>
              </div>

            </div>
          )}
        </div>
      </div>
      <SupabasePairingModal
        isOpen={isSupabasePairingOpen}
        onClose={() => {
          setIsSupabasePairingOpen(false);
          window.setTimeout(() => {
            pairingBoxRef.current?.focus({ preventScroll: true } as any);
          }, 40);
        }}
      />
    </div>
  );

  // A portál a <body>-ba teszi a menüt: így a Mozi/Sorozat tükrözött
  // elrendezése (flex-row-reverse) nem tudja eltorzítani a panel méretét.
  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
};