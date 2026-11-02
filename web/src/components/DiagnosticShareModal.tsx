import React, { useEffect, useState } from 'react';
import { Bug, Circle, Clock3, History, Loader2, Send } from 'lucide-react';
import {
  appLogKindLabel,
  dateTimeText,
  discardSentAppLog,
  discardSentTvDoctorLog,
  getAppLogText,
  getTvDoctorLogText,
  manualLogSnapshot,
  manualTvDoctorLogSnapshot,
  startManualLogging,
  startTvDoctorLogging,
  stopManualLogging,
  stopTvDoctorLogging,
  type ManualLogSnapshot,
  type TvDoctorLogSnapshot,
} from '../services/appLog';
import {
  getLocalDiagnosticHistory,
  listDiagnosticLogHistory,
  listTvDoctorLogHistory,
  rememberDiagnosticLog,
  sendDiagnosticLog,
  sendTvDoctorLog,
  type DiagnosticLogKind,
  type DiagnosticLogRecord,
} from '../services/diagnosticShareService';
import {
  formatDoctorBytes,
  getTvDoctorMemoryStats,
  getTvDoctorOperationHealth,
  subscribeTvDoctorUpdates,
} from '../services/tvDoctor';
import { getTvDoctorCloudStatus } from '../services/tvDoctorCloud';
import { useTvModalNavigation } from '../hooks/useTvModalNavigation';
import { normalizeTvKey } from '../utils/tvKeys';

interface DiagnosticShareModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatRecordDate(value: string): string {
  const at = Date.parse(value);
  return Number.isFinite(at) ? dateTimeText(at) : value || 'ismeretlen időpont';
}

function formatElapsed(elapsedMs: number): string {
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  return `${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`;
}

interface StatTileProps {
  value: React.ReactNode;
  label: string;
  accent?: boolean;
}

const StatTile: React.FC<StatTileProps> = ({ value, label, accent = false }) => (
  <div className="flex h-[68px] min-w-0 flex-col items-center justify-center rounded-xl border border-slate-700 bg-[#0b1730] px-1.5 py-1 text-center">
    <div className={`text-2xl font-black leading-none ${accent ? 'text-cyan-200' : 'text-white'}`}>{value}</div>
    <div className="mt-1 text-xs font-bold leading-tight tracking-wide text-slate-300">{label}</div>
  </div>
);

interface LogPanelProps {
  kind: DiagnosticLogKind;
  snap: ManualLogSnapshot | TvDoctorLogSnapshot;
}

/** Egy naplófajta állapotsora: fajta-címke + sorszám + kezdési időpont. */
const LogStatusBar: React.FC<LogPanelProps> = ({ kind, snap }) => {
  const enabled = snap.enabled;
  const statusColor = enabled ? 'text-emerald-300' : 'text-rose-300';
  const statusBg = enabled ? 'border-emerald-400/60 bg-emerald-500/10' : 'border-rose-400/60 bg-rose-500/10';
  return (
    <div className={`flex shrink-0 items-center justify-between gap-3 rounded-xl border-2 px-3 py-2 ${statusBg}`}>
      <div className="flex min-w-0 items-center gap-2">
        <Circle className={`h-4 w-4 shrink-0 fill-current ${statusColor}`} />
        <div className="min-w-0">
          <div className={`text-sm font-black leading-tight ${statusColor}`}>
            {enabled ? 'NAPLÓZÁS BEKAPCSOLVA' : 'NAPLÓZÁS KIKAPCSOLVA'}
            <span className={`ml-2 rounded-md px-2 py-0.5 align-middle text-[10px] font-black uppercase tracking-wide ${kind === 'tv-doctor' ? 'bg-blue-500/25 text-blue-200' : 'bg-amber-500/20 text-amber-200'}`}>
              {appLogKindLabel(kind)}
            </span>
          </div>
          <div className="text-[11px] leading-tight text-slate-400">
            {kind === 'tv-doctor'
              ? (enabled ? 'A TV Doktor döntései és elakadásai most rögzülnek.' : 'A nagy napló nélkül is bekapcsolható.')
              : (enabled ? 'A lejátszó eseményei most rögzülnek.' : 'Normál tévézés közben nincs diagnosztikai naplózás.')}
          </div>
        </div>
      </div>
      <div className="shrink-0 text-right font-mono text-xs leading-tight text-slate-300">
        {/* 2.5.264: a naplószám mellett mindig ott a fajta is (NAGY NAPLÓ / TV DR). */}
        <div>Napló: <strong className="text-white">#{snap.number ?? '—'}</strong> <span className="text-[10px] font-bold text-slate-400">· {appLogKindLabel(kind)}</span></div>
        <div>{snap.startedAt ? formatRecordDate(new Date(snap.startedAt).toISOString()) : 'Nincs aktív napló'}</div>
      </div>
    </div>
  );
};

const LogStats: React.FC<{ snap: ManualLogSnapshot | TvDoctorLogSnapshot }> = ({ snap }) => (
  <div className="grid shrink-0 grid-cols-4 gap-2">
    <StatTile value={snap.lineCount} label="SOR" />
    <StatTile value={`${Math.round(snap.charCount / 1024)} KB`} label="MÉRET / 1 MB" />
    <StatTile value={formatElapsed(snap.elapsedMs)} label="ELTELT IDŐ" accent />
    <StatTile value={snap.startedAt ? formatRecordDate(new Date(snap.startedAt).toISOString()).slice(0, 10) : '—'} label="KEZDETE" />
  </div>
);

/**
 * KÉZI HIBAKERESÉSI NAPLÓ – KÉT KÜLÖN NAPLÓ EGY ABLAKBAN (2.5.264).
 *
 * A SÁRGA/teletext gomb csak ezt az ablakot nyitja meg. Mindkét napló alapból
 * KI van kapcsolva, és külön-külön kézzel indul:
 *   1. NAGY NAPLÓ (rendszer): a lejátszó, csatornaváltás, import stb. eseményei;
 *   2. TV DR (TV Doktor): CSAK a TV Doktor működése/elakadásai – a nagy napló
 *      nélkül is bekapcsolható, és a nagy naplóba soha nem kerül TV Doktor adat.
 * Mindkettő külön sorszámot kap (a közös számlálóból, fajta-címkével), külön
 * küldőgombbal megy a saját Supabase funkciójára (tv-diagnostic-share /
 * tv-doctor-log), és sikeres küldés után az adott napló leáll és nullázódik.
 */
export const DiagnosticShareModal: React.FC<DiagnosticShareModalProps> = ({ isOpen, onClose }) => {
  const [snapshot, setSnapshot] = useState<ManualLogSnapshot>(() => manualLogSnapshot());
  const [doctorSnapshot, setDoctorSnapshot] = useState<TvDoctorLogSnapshot>(() => manualTvDoctorLogSnapshot());
  const [history, setHistory] = useState<DiagnosticLogRecord[]>(() => [
    ...getLocalDiagnosticHistory('system'),
    ...getLocalDiagnosticHistory('tv-doctor'),
  ]);
  const [busy, setBusy] = useState<DiagnosticLogKind | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [sentRecord, setSentRecord] = useState<{ logNumber: number; kind: DiagnosticLogKind } | null>(null);
  /**
   * A szerveri lista frissítése látható állapot. Az ablak nyitásakor mindkét
   * fajtára indul szerveri frissítés, ezért az induló érték igaz.
   */
  const [historyRefreshing, setHistoryRefreshing] = useState(true);
  const [, setDoctorRefreshTick] = useState(0);
  const { modalRef, handleKeyDown } = useTvModalNavigation(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return undefined;
    return subscribeTvDoctorUpdates(() => {
      setDoctorSnapshot(manualTvDoctorLogSnapshot());
      setDoctorRefreshTick((n) => n + 1);
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setSnapshot(manualLogSnapshot());
    setDoctorSnapshot(manualTvDoctorLogSnapshot());
    setHistory([
      ...getLocalDiagnosticHistory('system'),
      ...getLocalDiagnosticHistory('tv-doctor'),
    ]);
    setNotice('');
    setError('');
    setSentRecord(null);
    // Mindkét naplófajta szerveri előzménye frissül; a helyi lista már a nyitás
    // pillanatában látszik, a szerveri válasz csak kiegészíti (egyesítés).
    setHistoryRefreshing(true);
    const mergeServer = (records: DiagnosticLogRecord[]) => {
      if (!records.length) return;
      setHistory((previous) => {
        const known = new Set(previous.map((item) => `${item.kind || 'system'}-${item.logNumber}-${item.createdAt}`));
        const merged = [...records.filter((item) => !known.has(`${item.kind || 'system'}-${item.logNumber}-${item.createdAt}`)), ...previous];
        merged.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
        return merged.slice(0, 5);
      });
    };
    void Promise.allSettled([
      listDiagnosticLogHistory('system').then(mergeServer),
      listTvDoctorLogHistory().then(mergeServer),
    ]).then(() => setHistoryRefreshing(false));
  }, [isOpen]);

  /**
   * AZ ELTELT IDŐ CSAK AKTÍV NAPLÓZÁSNÁL SZÁMOL (mindkét naplónál külön).
   */
  const anyLoggingActive = snapshot.enabled || doctorSnapshot.enabled;
  useEffect(() => {
    if (!isOpen || !anyLoggingActive) return undefined;
    const timer = window.setInterval(() => {
      setSnapshot(manualLogSnapshot());
      setDoctorSnapshot(manualTvDoctorLogSnapshot());
    }, 500);
    return () => window.clearInterval(timer);
  }, [isOpen, anyLoggingActive]);

  useEffect(() => {
    if (!isOpen) return;
    const focus = () => {
      try { modalRef.current?.querySelector<HTMLElement>('[data-diagnostic-toggle]')?.focus({ preventScroll: true } as any); } catch { /* régi webOS */ }
    };
    const timers = [120, 650].map((delay) => window.setTimeout(focus, delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [isOpen, modalRef]);

  const toggleLogging = () => {
    setError('');
    setNotice('');
    const next = snapshot.enabled
      ? stopManualLogging('kézi leállítás')
      : startManualLogging();
    if (next.enabled) setSentRecord(null);
    setSnapshot(next);
    setNotice(next.enabled
      ? `Nagy napló #${next.number} elindult. Mostantól a lejátszó hibái és a csatornaváltások bekerülnek.`
      : `Nagy napló #${next.number ?? 'ismeretlen'} leállt. Küldés előtt ellenőrizd a sorszámot és az időpontot.`);
  };

  const toggleDoctorLog = () => {
    setError('');
    setNotice('');
    const next = doctorSnapshot.enabled
      ? stopTvDoctorLogging('kézi leállítás')
      : startTvDoctorLogging();
    if (next.enabled) setSentRecord(null);
    setDoctorSnapshot(next);
    setNotice(next.enabled
      ? `TV DR napló #${next.number} elindult – a nagy napló nélkül is rögzül a TV Doktor működése.`
      : `TV DR napló #${next.number ?? 'ismeretlen'} leállt.`);
  };

  /**
   * Egy naplófajta elküldése a saját funkciójára. Küldéskor mindig lezárjuk az
   * adott munkamenetet; sikeres küldés után az adott napló leáll és nullázódik
   * (RAM + localStorage), a másik napló érintetlen marad. Hiba esetén a kész
   * tartalom megmarad, így a gombbal újra elküldhető.
   */
  const sendLog = async (kind: DiagnosticLogKind) => {
    setError('');
    setNotice('');
    const isSystem = kind === 'system';
    let current = isSystem ? manualLogSnapshot() : manualTvDoctorLogSnapshot();
    if (!current.number || !current.startedAt || current.charCount <= 0) {
      setError(isSystem
        ? 'Nincs elküldhető nagy napló. Előbb indítsd el a naplózást, majd próbáld ki a hibát.'
        : 'Nincs elküldhető TV DR napló. Előbb kapcsold be a TV Doktor naplózást, majd próbáld ki a hibát.');
      return;
    }
    const logNumber = current.number;
    const startedAt = current.startedAt;
    setBusy(kind);
    if (current.enabled) {
      current = isSystem
        ? stopManualLogging('küldés előtti automatikus leállítás')
        : stopTvDoctorLogging('küldés előtti automatikus leállítás');
    }
    try {
      const record = isSystem
        ? await sendDiagnosticLog(logNumber, startedAt, getAppLogText(), current.charCount, current.lineCount, 'system')
        : await sendTvDoctorLog(logNumber, startedAt, getTvDoctorLogText(), current.charCount, current.lineCount);
      rememberDiagnosticLog(record);
      setSentRecord({ logNumber: record.logNumber, kind: record.kind || kind });
      setHistory((previous) => [
        record,
        ...previous.filter((item) => !(item.logNumber === record.logNumber && (item.kind || 'system') === (record.kind || 'system'))),
      ].slice(0, 5));
      // SIKERES KÜLDÉS: az adott napló tartalma törlődik a TV-ről, a naplózás
      // leáll és az értékek nullázódnak – a következő indítás tiszta.
      if (isSystem) setSnapshot(discardSentAppLog());
      else setDoctorSnapshot(discardSentTvDoctorLog());
      setNotice(`Elküldve: ${appLogKindLabel(record.kind || kind)} #${record.logNumber} – ${formatRecordDate(record.createdAt)}. A naplózás automatikusan leállt, a napló tartalma törlődött a TV-ről.`);
    } catch (cause) {
      setError(`A(z) ${kind === 'tv-doctor' ? 'TV DR ' : ''}napló küldése nem sikerült: ${String(cause).slice(0, 180)}`);
      if (isSystem) setSnapshot(manualLogSnapshot());
      else setDoctorSnapshot(manualTvDoctorLogSnapshot());
    } finally {
      setBusy(null);
    }
  };

  const onModalKeyDown = (event: React.KeyboardEvent) => {
    const key = normalizeTvKey(event);
    if (key === 'Enter' || key === ' ') {
      const active = document.activeElement as HTMLElement | null;
      if (active && modalRef.current?.contains(active) && active.tagName === 'BUTTON') {
        event.preventDefault();
        event.stopPropagation();
        active.click();
        return;
      }
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      // A négy gomb (nagy indítás, nagy küldés, TV Dr indítás, TV Dr küldés)
      // között balra/jobbra lépkedünk, a letiltottakat átugorjuk.
      const buttons = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>('[data-diagnostic-toggle], [data-diagnostic-send], [data-diagnostic-tv-doctor-toggle], [data-diagnostic-tv-doctor-send]') || [],
      ).filter((btn) => !btn.hasAttribute('disabled'));
      const active = document.activeElement as HTMLElement | null;
      const index = buttons.indexOf(active as HTMLElement);
      if (index >= 0) {
        const delta = key === 'ArrowRight' ? 1 : -1;
        const next = buttons[(index + delta + buttons.length) % buttons.length];
        if (next) {
          event.preventDefault();
          event.stopPropagation();
          next.focus({ preventScroll: true } as any);
          return;
        }
      }
    }
    handleKeyDown(event);
  };

  if (!isOpen) return null;
  const doctorMem = getTvDoctorMemoryStats();
  const doctorOp = getTvDoctorOperationHealth();
  const doctorCloud = getTvDoctorCloudStatus();

  const renderSendButton = (kind: DiagnosticLogKind) => {
    const isSystem = kind === 'system';
    const snap = isSystem ? snapshot : doctorSnapshot;
    const alreadySent = Boolean(sentRecord && sentRecord.kind === kind);
    return (
      <button
        data-diagnostic-send={isSystem ? '' : undefined}
        data-diagnostic-tv-doctor-send={!isSystem ? '' : undefined}
        type="button"
        onClick={() => void sendLog(kind)}
        disabled={busy !== null || alreadySent || !snap.number || snap.charCount <= 0}
        className="flex min-h-[56px] items-center justify-center gap-2 rounded-xl border-2 border-cyan-300 bg-cyan-400/15 px-3 py-2 text-base font-black text-cyan-100 focus:outline-none focus:ring-4 focus:ring-amber-400 disabled:opacity-40"
      >
        {busy === kind ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
        {isSystem ? 'Nagy napló küldése' : 'TV DR küldése'}
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/85 p-2" role="dialog" aria-modal="true" aria-label="Kézi hibakeresési napló">
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={onModalKeyDown}
        className="flex h-[calc(100vh-16px)] max-h-[900px] min-h-0 w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-[#050b18] p-3 text-white shadow-2xl focus:outline-none"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-800 pb-2">
          <Bug className="h-8 w-8 shrink-0 text-amber-300" />
          <div className="min-w-0">
            <h2 className="text-xl font-black tracking-wide">KÉZI HIBAKERESÉSI NAPLÓ</h2>
            <p className="mt-0.5 text-xs text-slate-400">A SÁRGA gomb csak ezt az ablakot nyitja meg. Két külön napló: nagy (rendszer) és TV DR – külön kapcsolható, külön küldhető. Naplózás és küldés kizárólag kézzel indul.</p>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto py-2">
          <LogStatusBar kind="system" snap={snapshot} />
          <LogStats snap={snapshot} />

          <LogStatusBar kind="tv-doctor" snap={doctorSnapshot} />
          <LogStats snap={doctorSnapshot} />

          <div
            data-diagnostic-tv-doctor-box=""
            className="flex shrink-0 items-start gap-3 rounded-xl border border-cyan-500/40 bg-[#08152d] px-3 py-2"
          >
            <span className={`mt-0.5 shrink-0 text-cyan-300 ${doctorSnapshot.enabled ? 'opacity-100' : 'text-slate-400'}`}>
              <span className="text-2xl font-black">✚</span>
            </span>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className={`rounded-md px-2 py-1 text-xs font-black uppercase ${doctorSnapshot.enabled ? 'bg-emerald-500/20 text-emerald-200' : 'bg-slate-800 text-slate-300'}`}>
                  {doctorSnapshot.enabled ? 'Külön naplóba kerül' : 'Kikapcsolva'}
                </span>
                <div className="text-base font-black leading-tight tracking-wide text-white">TV Doktor működés- és elakadás-napló (külön, a nagy napló nélkül is)</div>
              </div>
              <p className="text-sm leading-snug text-slate-200">
                Rögzíti a TV Doktor döntéseit, az elakadásokat/lassulásokat, a TV memóriáját és a Supabase kapcsolati hibákat – a nagy naplóba ezek NEM kerülnek be, és külön (tv-doctor-log) funkcióra küldhetők.
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold leading-snug text-cyan-200">
                <span>Memória: {formatDoctorBytes(doctorMem.doctorTotalBytes)}</span>
                <span>•</span>
                <span>Supabase: {doctorCloud.connected ? 'Kapcsolódva' : (doctorCloud.lastErrorLocation ? `Hiba (${doctorCloud.lastErrorLocation})` : 'Helyi mód')}</span>
                <span>•</span>
                <span>Elakadás/lassulás: {doctorOp.slowOpsCount + doctorOp.confirmedFreezesCount} db</span>
              </div>
            </div>
          </div>

          <div className="shrink-0 overflow-hidden rounded-xl border border-cyan-500/35 bg-[#081329] p-2">
            <div className="mb-1 flex items-center gap-2 text-sm font-black tracking-wide text-cyan-200">
              <History className="h-5 w-5 shrink-0" /> UTOLSÓ 5 ELKÜLDÖTT NAPLÓ (MINDKÉT FAJTA)
              {historyRefreshing && <span className="ml-auto animate-pulse text-xs font-bold text-slate-400">Frissítés a szerverről…</span>}
            </div>
            {history.length ? (
              <div className="space-y-1">
                {history.slice(0, 5).map((record) => {
                  const kind = record.kind || 'system';
                  const isSent = sentRecord?.logNumber === record.logNumber && sentRecord?.kind === kind;
                  return (
                    <div
                      key={`${kind}-${record.logNumber}-${record.createdAt}`}
                      data-diagnostic-history-row=""
                      className={`flex min-h-[72px] w-full flex-wrap items-center justify-between gap-x-5 gap-y-1 overflow-hidden rounded-xl border-2 px-4 py-3 ${isSent ? 'border-emerald-400/70 bg-emerald-500/10' : 'border-slate-700/80 bg-[#0b1730]'}`}
                    >
                      <span
                        data-diagnostic-history-number=""
                        className="flex shrink-0 items-center gap-2 whitespace-nowrap text-3xl font-black leading-none tracking-tight text-white tabular-nums sm:text-[34px]"
                      >
                        Napló #{record.logNumber}
                        {/* 2.5.264: a naplószám mellett a fajta címkéje is ott van. */}
                        <span
                          data-diagnostic-history-kind=""
                          className={`rounded-md px-2 py-1 text-xs font-black uppercase tracking-wide ${kind === 'tv-doctor' ? 'bg-blue-500/25 text-blue-200' : 'bg-amber-500/20 text-amber-200'}`}
                        >
                          {appLogKindLabel(kind)}
                        </span>
                      </span>
                      <span
                        data-diagnostic-history-date=""
                        title={formatRecordDate(record.createdAt)}
                        className="flex min-w-0 max-w-full items-center gap-2 font-mono text-xl font-bold leading-none text-slate-100 tabular-nums sm:text-2xl"
                      >
                        <Clock3 className="h-5 w-5 shrink-0 text-cyan-300" />
                        <span className="min-w-0 break-words">{formatRecordDate(record.createdAt)}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-base text-slate-500">
                {historyRefreshing ? 'A lista letöltése a szerverről folyamatban…' : 'Még nincs elküldött napló.'}
              </p>
            )}
          </div>

          {notice && <p role="status" className="shrink-0 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-center text-xs font-bold leading-tight text-emerald-200">{notice}</p>}
          {error && <p role="alert" className="shrink-0 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-1.5 text-center text-xs font-bold leading-tight text-rose-200">{error}</p>}
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-3 border-t border-slate-700 pt-2">
          <button
            data-diagnostic-toggle=""
            type="button"
            onClick={toggleLogging}
            disabled={busy !== null}
            className={`flex min-h-[56px] items-center justify-center gap-2 rounded-xl border-2 px-3 py-2 text-base font-black focus:outline-none focus:ring-4 focus:ring-amber-400 disabled:opacity-50 ${snapshot.enabled ? 'border-emerald-300 bg-emerald-400/20 text-emerald-100' : 'border-rose-300 bg-rose-400/15 text-rose-100'}`}
          >
            <Circle className="h-5 w-5 fill-current" />
            {snapshot.enabled ? 'Nagy napló leállítása' : 'Nagy napló indítása'}
          </button>
          {renderSendButton('system')}
          <button
            data-diagnostic-tv-doctor-toggle=""
            type="button"
            role="switch"
            aria-checked={doctorSnapshot.enabled}
            aria-label="TV Doktor naplózás be- és kikapcsolása (külön napló)"
            onClick={toggleDoctorLog}
            disabled={busy !== null}
            className={`flex min-h-[56px] items-center justify-center gap-2 rounded-xl border-2 px-3 py-2 text-base font-black focus:outline-none focus:ring-4 focus:ring-amber-400 disabled:opacity-50 ${
              doctorSnapshot.enabled
                ? 'border-blue-300 bg-blue-600 text-white'
                : 'border-blue-500/70 bg-blue-950 text-blue-100'
            }`}
          >
            <span>✚</span>
            {doctorSnapshot.enabled ? 'TV DR napló leállítása' : 'TV DR napló indítása'}
          </button>
          {renderSendButton('tv-doctor')}
        </div>
        <p className="shrink-0 pt-1 text-center text-[10px] leading-tight text-slate-500">Kilépéskor a naplózás automatikusan leáll. A naplók Supabase-en fajtánként legfeljebb öt legfrissebb sorszámmal maradnak meg.</p>
      </div>
    </div>
  );
};
