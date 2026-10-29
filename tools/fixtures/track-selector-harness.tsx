import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VodOsd } from '../../web/src/components/VodOsd';
import { AudioSubtitlesModal } from '../../web/src/components/AudioSubtitlesModal';
import { INITIAL_SETTINGS } from '../../web/src/data/mockData';
import { trackLabel, trackMeta, trackLanguage } from '../../web/src/utils/trackLabels';
import type { AudioTrack, SubtitleTrack } from '../../web/src/types/iptv';

declare global { interface Window { trackTest: any; } }
const audio: AudioTrack[] = [
  { id: 'af', name: 'fr', lang: 'fr', codec: 'AAC', channels: '2.0', selected: true },
  { id: 'ad', name: 'Audio 2', lang: 'de-DE', codec: 'AC3', channels: '5.1' },
  { id: 'ae', name: 'Rendezői kommentár', lang: 'en_US' },
  { id: 'long', name: 'Rendkívülhosszúszóköznélküliszolgáltatóihangsávelnevezés'.repeat(2), lang: 'hu' },
  ...Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, name: `Hangsáv ${i + 5}`, lang: 'eng' })),
];
const subtitles: SubtitleTrack[] = [
  { id: 'sf', name: 'fre', lang: 'fr', selected: true },
  { id: 'sd', name: 'de', lang: 'de' },
  { id: 'se', name: 'English', lang: 'en' },
  { id: 'slong', name: 'Rendkívülhosszúszóköznélkülifeliratsávelnevezés'.repeat(2), lang: 'hu' },
  ...Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, name: `Felirat ${i + 5}`, lang: 'hun' })),
];
const calls: { audio: string[]; subtitle: Array<string | null>; closed: number } = { audio: [], subtitle: [], closed: 0 };

function VodHarness({ initialMenu }: { initialMenu: 'audio' | 'subtitle' }) {
  const [menu, setMenu] = useState<'audio' | 'subtitle' | null>(initialMenu);
  return <VodOsd title="Teszt" currentTime={0} duration={100} isPlaying volume={0.5} seekStep={10}
    audioTracks={audio} subtitleTracks={subtitles} activeSubtitleId="sf" menu={menu} onMenuChange={setMenu}
    onTogglePlay={() => {}} onSeekBy={() => {}} onSeekTo={() => {}}
    onSelectAudio={track => calls.audio.push(String(track.id))}
    onSelectSubtitle={track => calls.subtitle.push(track ? String(track.id) : null)}
    onClose={() => {}} onToggleMute={() => {}} />;
}
function LiveHarness({ mode }: { mode: 'live' | 'audio' | 'subtitle' }) {
  const [open, setOpen] = useState(true);
  const [audioTracks, setAudioTracks] = useState(audio);
  const [subtitleTracks, setSubtitleTracks] = useState(subtitles);
  return <AudioSubtitlesModal isOpen={open} mode={mode} settings={INITIAL_SETTINGS} onUpdateSettings={() => {}}
    onClose={() => { calls.closed++; setOpen(false); }} audioTracks={audioTracks} subtitleTracks={subtitleTracks}
    onSelectAudioTrack={track => { calls.audio.push(String(track.id)); setAudioTracks(items => items.map(item => ({ ...item, selected: item.id === track.id }))); }}
    onSelectSubtitleTrack={track => { calls.subtitle.push(track ? String(track.id) : null); setSubtitleTracks(items => items.map(item => ({ ...item, selected: item.id === track?.id }))); }} />;
}
const root = createRoot(document.getElementById('root')!);
let generation = 0;
window.trackTest = {
  trackLabel, trackMeta, trackLanguage, calls,
  show(view: 'vod-audio' | 'vod-subtitle' | 'live' | 'audio' | 'subtitle') {
    calls.audio.length = 0; calls.subtitle.length = 0; calls.closed = 0;
    generation++;
    root.render(view === 'vod-audio' || view === 'vod-subtitle'
      ? <VodHarness key={generation} initialMenu={view === 'vod-audio' ? 'audio' : 'subtitle'} />
      : <LiveHarness key={generation} mode={view} />);
  },
  unmount() { root.unmount(); },
};
