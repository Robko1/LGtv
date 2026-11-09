import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioSubtitlesModal } from '../../web/src/components/AudioSubtitlesModal';
import { INITIAL_SETTINGS } from '../../web/src/data/mockData';
import {
  clearAudioMemory,
  forgetAudioFor,
  matchSavedAudioTrack,
  normalizeAudioLang,
  rememberAudioFor,
  rememberedAudioFor,
  savedAudioLabel,
} from '../../web/src/services/liveAudioMemory';
import type { AudioTrack, SubtitleTrack } from '../../web/src/types/iptv';

declare global { interface Window { audioMemTest: any; } }

const audio: AudioTrack[] = [
  { id: 1, name: 'hu', lang: 'hu', selected: true },
  { id: 2, name: 'Audio 2', lang: 'de-DE' },
  { id: 3, name: 'Angol', lang: 'eng' },
];
const subtitles: SubtitleTrack[] = [
  { id: 's1', name: 'Német', lang: 'de', selected: true },
];

const calls: { saved: string[]; closed: number } = { saved: [], closed: 0 };

function Harness({ activeAudioTrackId }: { activeAudioTrackId?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <AudioSubtitlesModal
      isOpen={open}
      mode="live"
      settings={INITIAL_SETTINGS}
      onUpdateSettings={() => {}}
      onClose={() => { calls.closed++; setOpen(false); }}
      audioTracks={audio}
      subtitleTracks={subtitles}
      onSelectAudioTrack={() => {}}
      onSelectSubtitleTrack={() => {}}
      onSaveAudioTrack={(track) => { calls.saved.push(String(track.id)); return true; }}
      activeAudioTrackId={activeAudioTrackId}
    />
  );
}

const root = createRoot(document.getElementById('root')!);
let generation = 0;

window.audioMemTest = {
  calls,
  rememberAudioFor,
  rememberedAudioFor,
  matchSavedAudioTrack,
  forgetAudioFor,
  clearAudioMemory,
  normalizeAudioLang,
  savedAudioLabel,
  show(activeAudioTrackId?: string) {
    calls.saved.length = 0;
    calls.closed = 0;
    generation++;
    root.render(<Harness key={generation} activeAudioTrackId={activeAudioTrackId} />);
  },
  unmount() { root.unmount(); },
};
