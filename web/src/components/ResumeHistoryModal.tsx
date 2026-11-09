import React from 'react';
import { WatchHistoryItem } from '../types/iptv';
import { X, Play, Clock, History, Trash2 } from 'lucide-react';

interface ResumeHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  history: WatchHistoryItem[];
  onPlayItem: (item: WatchHistoryItem) => void;
  onClearHistory: () => void;
}

export const ResumeHistoryModal: React.FC<ResumeHistoryModalProps> = ({
  isOpen,
  onClose,
  history,
  onPlayItem,
  onClearHistory,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-4 lg:p-6 bg-black/80 backdrop-blur-sm animate-fadeIn select-none lg:select-auto">
      <div role="dialog" aria-modal="true" className="bg-[#081329] border border-cyan-800/60 rounded-3xl max-w-lg md:max-w-xl lg:max-w-2xl xl:max-w-3xl w-full max-h-[85dvh] lg:max-h-[80vh] min-h-0 flex flex-col shadow-2xl animate-scaleUp overflow-hidden">
        
        {/* Header */}
        <div className="p-4 bg-[#0a1835] border-b border-cyan-950 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-cyan-400 stroke-[2.5]" />
            <h2 className="text-base sm:text-lg font-black text-white tracking-wide">
              FOLYTATÁS (ELKEZDETT FILMEK ÉS SOROZATOK)
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-slate-300 active:scale-90 transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {history.length === 0 ? (
            <div className="py-12 text-center text-slate-400">
              <History className="w-10 h-10 text-slate-600 mx-auto mb-2" />
              <p className="text-sm font-semibold">Még nincs elkezdett film vagy sorozat.</p>
            </div>
          ) : (
            history.map((item) => (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                data-resume-item={item.id}
                onClick={() => {
                  onPlayItem(item);
                  onClose();
                }}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPlayItem(item); onClose(); } }}
                className="group flex items-center justify-between p-3 rounded-2xl bg-[#0a1630] hover:bg-[#11244c] border border-cyan-900/40 cursor-pointer transition-all active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="relative w-16 h-20 rounded-xl bg-slate-800 overflow-hidden shrink-0 border border-slate-700">
                    <img
                      src={item.poster || 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=200&auto=format&fit=crop&q=80'}
                      alt={item.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    />
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <Play className="w-6 h-6 fill-cyan-400 text-cyan-400" />
                    </div>
                  </div>

                  <div className="min-w-0">
                    <span className="px-2 py-0.5 rounded-md bg-cyan-500/20 text-cyan-300 text-[10px] font-black uppercase tracking-wider border border-cyan-500/30">
                      {item.mediaType === 'movie' ? 'Mozi Film' : 'Sorozat Epizód'}
                    </span>
                    <h3 className="text-white font-bold text-base truncate mt-1 group-hover:text-cyan-300">
                      {item.title}
                    </h3>
                    <p className="text-sm text-amber-400 font-mono mt-0.5 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <span>{item.subtitle || 'Folytatás'}</span>
                    </p>

                    {/* Progress Bar */}
                    <div className="w-32 bg-slate-900 rounded-full h-1.5 overflow-hidden mt-2">
                      <div
                        className="bg-cyan-400 h-full rounded-full"
                        style={{ width: `${item.progressPercent}%` }}
                      />
                    </div>
                  </div>
                </div>

                <button className="shrink-0 p-3 rounded-2xl bg-cyan-400 text-slate-950 font-black flex items-center gap-1 shadow-md shadow-cyan-400/30 group-hover:bg-cyan-300 transition-all ml-2">
                  <Play className="w-4 h-4 fill-current ml-0.5" />
                  <span className="text-xs hidden sm:inline">Folytatás</span>
                </button>
              </div>
            ))
          )}
        </div>

        {history.length > 0 && (
          <div className="p-3 bg-[#0a1835] border-t border-cyan-950 flex justify-end">
            <button
              onClick={onClearHistory}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-950/40 hover:bg-rose-900/60 text-rose-400 text-xs font-bold transition-all"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Előzmények törlése</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
