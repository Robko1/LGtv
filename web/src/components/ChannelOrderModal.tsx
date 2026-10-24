import React, { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeTvKey } from '../utils/tvKeys';
import { FavoriteFolder } from '../types/iptv';
import { X, FolderPlus, Check, Shuffle } from 'lucide-react';

interface ChannelOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  folders: FavoriteFolder[];
  onSaveFolders: (folders: FavoriteFolder[]) => void;
  channelToFavoriteId?: string | null;
  onAssignChannelToFolder?: (channelId: string, folderId: string) => void;
}

const FOLDER_ICONS = [
  '⚽', '🍿', '🎬', '🎮', '🎵', '🎸', '🏎️', '🏆', '🏀', '🏈',
  '🎾', '🥊', '🏊', '🚗', '✈️', '🚀', '🌍', '⭐', '🔥', '💎',
  '🎨', '📚', '📰', '💻', '📱', '🛒', '🍔', '🍕', '☕', '🎭',
  '🎤', '🎧', '📺', '🧸', '🐶', '🐱', '🦁', '🐼', '🌴', '🏖️',
  '🎯', '🎲', '🧩', '❤️', '✨', '🌈', '🌙', '☀️', '🎁', '📁',
];

export const ChannelOrderModal: React.FC<ChannelOrderModalProps> = ({
  isOpen,
  onClose,
  folders,
  onSaveFolders,
  channelToFavoriteId = null,
  onAssignChannelToFolder,
}) => {
  // TV VISSZA gomb / Escape: ez az ablak eddig csak egérrel volt zárható!
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = normalizeTvKey(e as unknown as React.KeyboardEvent);
      if (key === 'Escape' || (e as KeyboardEvent).keyCode === 461) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [newFolderName, setNewFolderName] = useState('');
  const folderNameInputRef = useRef<HTMLInputElement>(null);
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setIsCreatingFolder(!channelToFavoriteId || folders.length === 0);
    const existingFolder = folders.find((folder) => folder.channelIds.includes(channelToFavoriteId || ''));
    setSelectedFolderId(existingFolder?.id || folders[0]?.id || '');
    setNewFolderName('');
    const timer = window.setTimeout(() => folderNameInputRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [isOpen, channelToFavoriteId, folders]);
  const availableIcons = useMemo(() => {
    const used = new Set(folders.map((folder) => folder.icon).filter(Boolean));
    const unused = FOLDER_ICONS.filter((icon) => !used.has(icon));
    return unused.length ? unused : FOLDER_ICONS;
  }, [folders]);
  const [iconOffset, setIconOffset] = useState(0);
  const selectedIcon = availableIcons[iconOffset % availableIcons.length] || '📁';

  if (!isOpen) return null;

  const handleCreateFolder = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;

    const newFolder: FavoriteFolder = {
      id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      icon: selectedIcon,
      channelIds: channelToFavoriteId ? [channelToFavoriteId] : [],
    };
    onSaveFolders([...folders, newFolder]);
    setNewFolderName('');
    setIconOffset(0);
    onClose();
  };

  const chooseAnotherIcon = () => {
    setIconOffset((current) => (current + 1) % availableIcons.length);
  };

  const handleAssignToFolder = () => {
    if (!channelToFavoriteId || !selectedFolderId) return;
    onAssignChannelToFolder?.(channelToFavoriteId, selectedFolderId);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 md:p-6 lg:p-8 bg-black/80 backdrop-blur-sm animate-fadeIn select-none lg:select-auto">
      <div role="dialog" aria-modal="true" className="bg-[#081329] border border-cyan-800/60 rounded-3xl w-full max-w-sm md:max-w-md lg:max-w-lg xl:max-w-xl max-h-[90dvh] lg:max-h-[80vh] overflow-y-auto shadow-2xl overflow-x-hidden">
        <div className="p-4 bg-[#0a1835] border-b border-cyan-950 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderPlus className="w-5 h-5 text-amber-400" />
            <h2 className="text-base font-black text-white">{channelToFavoriteId && !isCreatingFolder ? 'KEDVENC MAPPA KIVÁLASZTÁSA' : channelToFavoriteId ? 'KEDVENC MAPPA LÉTREHOZÁSA' : 'ÚJ KEDVENC MAPPA'}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Bezárás" className="p-2 rounded-full bg-white/5 hover:bg-white/10 text-slate-300">
            <X className="w-5 h-5" />
          </button>
        </div>

        {channelToFavoriteId && !isCreatingFolder ? (
          <div className="p-4 space-y-3">
            <p className="text-sm text-slate-300">Melyik mappába kerüljön ez a csatorna?</p>
            <div className="max-h-64 overflow-y-auto space-y-2">
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  onClick={() => setSelectedFolderId(folder.id)}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left ${selectedFolderId === folder.id ? 'bg-amber-400/15 border-amber-400 text-white' : 'bg-[#0b1836] border-cyan-900/50 text-slate-200'}`}
                >
                  <span className="text-xl">{folder.icon || '📁'}</span>
                  <span className="flex-1 min-w-0 truncate font-bold text-sm">{folder.name}</span>
                  <span className="text-xs text-slate-400">{folder.channelIds.length} csatorna</span>
                  {selectedFolderId === folder.id && <Check className="w-4 h-4 text-amber-300" />}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setIsCreatingFolder(true)} className="flex-1 py-3 rounded-xl bg-[#102448] text-cyan-200 border border-cyan-800/60 font-bold text-sm">Új mappa</button>
              <button type="button" onClick={handleAssignToFolder} disabled={!selectedFolderId} className="flex-1 py-3 rounded-xl bg-amber-400 hover:bg-amber-300 disabled:opacity-40 text-slate-950 font-black text-sm">OK</button>
            </div>
          </div>
        ) : (
        <form onSubmit={handleCreateFolder} className="p-4 space-y-4">
          <div>
            <label htmlFor="favorite-folder-name" className="block text-xs font-bold text-slate-300 mb-2">Mappa neve</label>
            <input
              id="favorite-folder-name"
              ref={folderNameInputRef}
              onTouchEnd={() => folderNameInputRef.current?.focus()}
              onClick={() => folderNameInputRef.current?.focus()}
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Pl. Foci, Filmek, Gyerekek..."
              autoFocus
              maxLength={60}
              required
              className="w-full bg-[#070e1e] border border-cyan-800 rounded-xl px-3 py-3 text-sm text-white focus:outline-none focus:border-cyan-400"
            />
          </div>

          <div className="rounded-2xl bg-[#0b1836] border border-cyan-950 p-4 flex items-center gap-3">
            <div className="w-14 h-14 rounded-2xl bg-amber-400/15 border border-amber-400/40 flex items-center justify-center text-3xl">{selectedIcon}</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-white">Mappa ikonja</p>
              <p className="text-xs text-slate-400">Minden új mappa eltérő ikont kap, amíg van szabad ikon.</p>
            </div>
            <button type="button" onClick={chooseAnotherIcon} title="Másik ikon" aria-label="Másik ikon" className="p-2 rounded-xl bg-[#102448] text-cyan-300 hover:bg-[#17325d]">
              <Shuffle className="w-4 h-4" />
            </button>
          </div>

          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 py-3 rounded-xl bg-slate-800 text-slate-200 font-bold text-sm">Mégse</button>
            <button type="submit" disabled={!newFolderName.trim()} className="flex-1 py-3 rounded-xl bg-amber-400 hover:bg-amber-300 disabled:opacity-40 text-slate-950 font-black text-sm flex items-center justify-center gap-2">
              <Check className="w-4 h-4" /> Létrehozás
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
};
