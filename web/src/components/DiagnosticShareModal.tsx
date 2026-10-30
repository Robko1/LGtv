import React, { useEffect, useState } from 'react';
import { Bug, Circle, Clock3, History, Loader2, Send } from 'lucide-react';
import {
  dateTimeText,
  discardSentAppLog,
  getAppLogText,
  manualLogSnapshot,
  startManualLogging,
  stopManualLogging,
  type ManualLogSnapshot,
} from '../services/appLog';
import {
  getLocalDiagnosticHistory,
  listDiagnosticLogHistory,
  rememberDiagnosticLog,
  sendDiagnosticLog,
  type DiagnosticLogRecord,
} from '../services/diagnosticShareService';
import {
  formatDoctorBytes,
  getTvDoctorMemoryStats,
  getTvDoctorOperationHealth,
  isTvDoctorDiagLoggingEnabled,
  setTvDoctorDiagLoggingEnabled,
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

/**
 * KÉZI HIBAKERESÉSI NAPLÓ.
 *
 * A SÁRGA/teletext gomb csak ezt az ablakot nyitja meg. A naplózás itt is
 * alapból KI van kapcsolva: sem induláskor, sem az ablak megnyitásakor nem
 * készül napló és nem megy adat a Supabase-re. A két látható művelet:
 *   1. Naplózás indítása / leállítása
 *   2. Küldés Supabase-re
 */
export const DiagnosticShareModal: React.FC<DiagnosticShareModalProps> = ({ isOpen, onClose }) => {
  const [snapshot, setSnapshot] = useState<ManualLogSnapshot>(() => manualLogSnapshot());
  const [history, setHistory] = useState<DiagnosticLogRecord[]>(() => getLocalDiagnosticHistory());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [sentRecord, setSentRecord] = useState<DiagnosticLogRecord | null>(null);
  const [doctorDiagEnabled, setDoctorDiagEnabled] = useState<boolean>(() => isTvDoctorDiagLoggingEnabled());
  const [, setDoctorRefreshTick] = useState(0);
  const { modalRef, handleKeyDown } = useTvModalNavigation(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return undefined;
    setDoctorDiagEnabled(isTvDoctorDiagLoggingEnabled());
    return subscribeTvDoctorUpdates(() => {
      setDoctorDiagEnabled(isTvDoctorDiagLoggingEnabled());
      setDoctorRefreshTick((n) => n + 1);
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setSnapshot(manualLogSnapshot());
    setHistory(getLocalDiagnosticHistory());
    setNotice('');
    setError('');
    setSentRecord(null);
    // A szerverről csak az utolsó öt azonosítót és dátumot kérjük le, a naplók
    // teljes tartalma nem kerül vissza a TV-re.
    void listDiagnosticLogHistory()
      .then((records) => setHistory(records))
      .catch(() => { /* a helyi ötös lista offline is látható marad */ });
  }, [isOpen]);

  /**
   * AZ ELTELT IDŐ CSAK AKTÍV NAPLÓZÁSNÁL SZÁMOL.
   *
   * Korábban a számláló feltétel nélkül ketyegett: leállított (vagy el sem
   * indított) naplózásnál is nőtt az „ELTELT IDŐ”, ami azt sugallta, hogy a
   * naplózás még fut. Most az óra csak akkor frissül, amíg a naplózás aktív;
   * leállításkor a napló-réteg a leállítás pillanatában megállítja az időt,
   * és itt a rendszeres frissítés is leáll.
   */
  const loggingActive = snapshot.enabled;
  useEffect(() => {
    if (!isOpen || !loggingActive) return undefined;
    const timer = window.setInterval(() => setSnapshot(manualLogSnapshot()), 500);
    return () => window.clearInterval(timer);
  }, [isOpen, loggingActive]);

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
      ? `Napló #${next.number} elindult. Mostantól a lejátszó hibái és a csatornaváltások bekerülnek.`
      : `Napló #${next.number ?? 'ismeretlen'} leállt. Küldés előtt ellenőrizd a sorszámot és az időpontot.`);
  };

  const sendLog = async () => {
    setError('');
    setNotice('');
    let current = manualLogSnapshot();
    if (!current.number || !current.startedAt || current.charCount <= 0) {
      setError('Nincs elküldhető napló. Előbb indítsd el a naplózást, majd próbáld ki a hibát.');
      return;
    }
    const logNumber = current.number;
    const startedAt = current.startedAt;
    setBusy(true);
    // Küldéskor mindig lezárjuk a munkamenetet. Hiba esetén a kész tartalom
    // memóriában marad, így a gombbal újra elküldhető; új indítás új sorszámot kap.
    if (current.enabled) current = stopManualLogging('küldés előtti automatikus leállítás');
    try {
      const record = await sendDiagnosticLog(
        logNumber,
        startedAt,
        getAppLogText(),
        current.charCount,
        current.lineCount,
      );
      rememberDiagnosticLog(record);
      setSentRecord(record);
      setHistory((previous) => [record, ...previous.filter((item) => item.logNumber !== record.logNumber)].slice(0, 5));
      /*
       * SIKERES KÜLDÉS: a napló tartalma már a szerveren van, ezért a TV-n
       * nem maradhat: a RAM-ból (akár 1 MB) és a localStorage-ból is
       * törlődik, így felszabadul a memória és a szűk tárhely. A következő
       * naplózás tiszta adatokkal indul.
       *
       * SIKERTELEN küldésnél ez NEM fut le (a hibaágban marad a napló), hogy
       * a gombbal újra elküldhető legyen.
       */
      setSnapshot(discardSentAppLog());
      setNotice(`Elküldve: napló #${record.logNumber} – ${formatRecordDate(record.createdAt)}. A naplózás automatikusan leállt, a napló tartalma törlődött a TV-ről.`);
    } catch (cause) {
      setError(`A napló küldése nem sikerült: ${String(cause).slice(0, 180)}`);
      setSnapshot(manualLogSnapshot());
    } finally {
      setBusy(false);
    }
  };

  const toggleDoctorDiag = () => {
    const nextVal = !doctorDiagEnabled;
    setTvDoctorDiagLoggingEnabled(nextVal);
    setDoctorDiagEnabled(nextVal);
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
      const active = document.activeElement as HTMLElement | null;
      const toggleBtn = modalRef.current?.querySelector<HTMLElement>('[data-diagnostic-toggle]');
      const sendBtn = modalRef.current?.querySelector<HTMLElement>('[data-diagnostic-send]');
      if (active === toggleBtn && key === 'ArrowRight' && sendBtn && !sendBtn.hasAttribute('disabled')) {
        event.preventDefault();
        event.stopPropagation();
        sendBtn.focus({ preventScroll: true } as any);
        return;
      }
      if (active === sendBtn && key === 'ArrowLeft' && toggleBtn && !toggleBtn.hasAttribute('disabled')) {
        event.preventDefault();
        event.stopPropagation();
        toggleBtn.focus({ preventScroll: true } as any);
        return;
      }
    }
    handleKeyDown(event);
  };

  if (!isOpen) return null;
  const doctorMem = getTvDoctorMemoryStats();
  const doctorOp = getTvDoctorOperationHealth();
  const doctorCloud = getTvDoctorCloudStatus();
  const statusColor = snapshot.enabled ? 'text-emerald-300' : 'text-rose-300';
  const statusBg = snapshot.enabled ? 'border-emerald-400/60 bg-emerald-500/10' : 'border-rose-400/60 bg-rose-500/10';
  const elapsedSeconds = Math.floor(snapshot.elapsedMs / 1000);
  const elapsed = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`;

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
            <p className="mt-0.5 text-xs text-slate-400">A SÁRGA gomb csak ezt az ablakot nyitja meg. Naplózás és küldés kizárólag kézzel indul.</p>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 py-2">
          <div className={`flex shrink-0 items-center justify-between gap-3 rounded-xl border-2 px-3 py-2 ${statusBg}`}>
            <div className="flex min-w-0 items-center gap-2">
              <Circle className={`h-4 w-4 shrink-0 fill-current ${statusColor}`} />
              <div className="min-w-0">
                <div className={`text-sm font-black leading-tight ${statusColor}`}>{snapshot.enabled ? 'NAPLÓZÁS BEKAPCSOLVA' : 'NAPLÓZÁS KIKAPCSOLVA'}</div>
                <div className="text-[11px] leading-tight text-slate-400">{snapshot.enabled ? 'A lejátszó eseményei most rögzülnek.' : 'Normál tévézés közben nincs diagnosztikai naplózás.'}</div>
              </div>
            </div>
            <div className="shrink-0 text-right font-mono text-xs leading-tight text-slate-300">
              <div>Napló: <strong className="text-white">#{snapshot.number ?? '—'}</strong></div>
              <div>{snapshot.startedAt ? formatRecordDate(new Date(snapshot.startedAt).toISOString()) : 'Nincs aktív napló'}</div>
            </div>
          </div>

          <div className="grid shrink-0 grid-cols-5 gap-2">
            <div className="flex h-[68px] min-w-0 flex-col items-center justify-center rounded-xl border border-slate-700 bg-[#0b1730] px-1.5 py-1 text-center">
              <div className="text-2xl font-black leading-none text-white">{snapshot.lineCount}</div>
              <div className="mt-1 text-xs font-bold leading-tight tracking-wide text-slate-300">SOR</div>
            </div>
            <div className="flex h-[68px] min-w-0 flex-col items-center justify-center rounded-xl border border-slate-700 bg-[#0b1730] px-1.5 py-1 text-center">
              <div className="text-2xl font-black leading-none text-white">{Math.round(snapshot.charCount / 1024)} KB</div>
              <div className="mt-1 text-xs font-bold leading-tight tracking-wide text-slate-300">MÉRET / 1 MB</div>
            </div>
            <div className="flex h-[68px] min-w-0 flex-col items-center justify-center rounded-xl border border-slate-700 bg-[#0b1730] px-1.5 py-1 text-center">
              <div className="text-2xl font-black leading-none text-cyan-200">{elapsed}</div>
              <div className="mt-1 text-xs font-bold leading-tight tracking-wide text-slate-300">ELTELT IDŐ</div>
            </div>
            <div className="flex h-[68px] min-w-0 flex-col items-center justify-center rounded-xl border border-slate-700 bg-[#0b1730] px-1.5 py-1 text-center">
              <div className="text-lg font-black leading-none text-white">{snapshot.startedAt ? formatRecordDate(new Date(snapshot.startedAt).toISOString()).slice(0, 10) : '—'}</div>
              <div className="mt-1 text-xs font-bold leading-tight tracking-wide text-slate-300">KEZDETE</div>
            </div>
            <button
              data-diagnostic-tv-doctor-toggle=""
              type="button"
              role="switch"
              aria-checked={doctorDiagEnabled}
              aria-label="TV Doktor naplózás be- és kikapcsolása"
              onClick={toggleDoctorDiag}
              className={`flex h-[68px] min-w-0 flex-col items-center justify-center rounded-xl border-2 px-1.5 py-1 text-center text-sm font-black leading-tight transition-all focus:outline-none focus:ring-4 focus:ring-amber-400 ${
                doctorDiagEnabled
                  ? 'border-cyan-300 bg-cyan-400/20 text-cyan-100'
                  : 'border-slate-600 bg-slate-800/80 text-slate-200'
              }`}
            >
              <span>TV DOKTOR</span>
              <span>NAPLÓ: {doctorDiagEnabled ? 'BE' : 'KI'}</span>
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-cyan-500/35 bg-[#081329] p-2">
            <div className="mb-1 flex items-center gap-2 text-sm font-black tracking-wide text-cyan-200"><History className="h-5 w-5 shrink-0" /> UTOLSÓ 5 ELKÜLDÖTT NAPLÓ</div>
            {history.length ? (
              <div className="space-y-1">
                {history.slice(0, 5).map((record) => (
                  <div
                    key={`${record.logNumber}-${record.createdAt}`}
                    data-diagnostic-history-row=""
                    className={`flex min-h-[72px] w-full flex-wrap items-center justify-between gap-x-5 gap-y-1 overflow-hidden rounded-xl border-2 px-4 py-3 ${sentRecord?.logNumber === record.logNumber ? 'border-emerald-400/70 bg-emerald-500/10' : 'border-slate-700/80 bg-[#0b1730]'}`}
                  >
                    <span
                      data-diagnostic-history-number=""
                      className="shrink-0 whitespace-nowrap text-3xl font-black leading-none tracking-tight text-white tabular-nums sm:text-[34px]"
                    >
                      Napló #{record.logNumber}
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
                ))}
              </div>
            ) : <p className="text-base text-slate-500">Még nincs elküldött napló.</p>}
          </div>

          <div
            data-diagnostic-tv-doctor-box=""
            className="flex shrink-0 items-center gap-3 rounded-xl border border-cyan-500/40 bg-[#08152d] px-3 py-2"
          >
            <span className={`shrink-0 text-cyan-300 ${doctorDiagEnabled ? 'opacity-100' : 'text-slate-400'}`}>
              <span className="text-xl font-black">✚</span>
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-black leading-tight tracking-wide text-white">TV Doktor működés- és elakadás-naplózás</div>
              <p className="text-[11px] leading-tight text-slate-300">
                Rögzíti a TV Doktor döntéseit, az elakadásokat/lassulásokat, a TV memóriáját és a Supabase kapcsolati hibákat, majd a meglévő hibakeresési naplóval együtt elküldi.
              </p>
              <div className="flex flex-wrap items-center gap-x-2 text-[11px] font-semibold leading-tight text-cyan-300/90">
                <span>Memória: {formatDoctorBytes(doctorMem.doctorTotalBytes)}</span>
                <span>•</span>
                <span>Supabase: {doctorCloud.connected ? 'Kapcsolódva' : (doctorCloud.lastErrorLocation ? `Hiba (${doctorCloud.lastErrorLocation})` : 'Helyi mód')}</span>
                <span>•</span>
                <span>Elakadás/lassulás: {doctorOp.slowOpsCount + doctorOp.confirmedFreezesCount} db</span>
              </div>
            </div>
            <span className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-black uppercase ${doctorDiagEnabled ? 'bg-emerald-500/20 text-emerald-200' : 'bg-slate-800 text-slate-400'}`}>
              {doctorDiagEnabled ? 'Naplóba kerül' : 'Kikapcsolva'}
            </span>
          </div>

          {notice && <p role="status" className="shrink-0 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-center text-xs font-bold leading-tight text-emerald-200">{notice}</p>}
          {error && <p role="alert" className="shrink-0 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-1.5 text-center text-xs font-bold leading-tight text-rose-200">{error}</p>}
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-3 border-t border-slate-700 pt-2">
          <button
            data-diagnostic-toggle=""
            type="button"
            onClick={toggleLogging}
            disabled={busy}
            className={`flex min-h-[56px] items-center justify-center gap-2 rounded-xl border-2 px-3 py-2 text-base font-black focus:outline-none focus:ring-4 focus:ring-amber-400 disabled:opacity-50 ${snapshot.enabled ? 'border-emerald-300 bg-emerald-400/20 text-emerald-100' : 'border-rose-300 bg-rose-400/15 text-rose-100'}`}
          >
            <Circle className="h-5 w-5 fill-current" />
            {snapshot.enabled ? 'Naplózás leállítása' : 'Naplózás indítása'}
          </button>
          <button
            data-diagnostic-send=""
            type="button"
            onClick={() => void sendLog()}
            disabled={busy || Boolean(sentRecord) || !snapshot.number || snapshot.charCount <= 0}
            className="flex min-h-[56px] items-center justify-center gap-2 rounded-xl border-2 border-cyan-300 bg-cyan-400/15 px-3 py-2 text-base font-black text-cyan-100 focus:outline-none focus:ring-4 focus:ring-amber-400 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            Küldés Supabase-re
          </button>
        </div>
        <p className="shrink-0 pt-1 text-center text-[10px] leading-tight text-slate-500">Kilépéskor a naplózás automatikusan leáll. A naplók Supabase-en legfeljebb öt legfrissebb sorszámmal maradnak meg.</p>
      </div>
    </div>
  );
};
