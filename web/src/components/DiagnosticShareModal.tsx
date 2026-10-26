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
  const { modalRef, handleKeyDown } = useTvModalNavigation(isOpen, onClose);

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
    handleKeyDown(event);
  };

  if (!isOpen) return null;
  const statusColor = snapshot.enabled ? 'text-emerald-300' : 'text-rose-300';
  const statusBg = snapshot.enabled ? 'border-emerald-400/60 bg-emerald-500/10' : 'border-rose-400/60 bg-rose-500/10';
  const elapsedSeconds = Math.floor(snapshot.elapsedMs / 1000);
  const elapsed = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`;

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/85 p-3" role="dialog" aria-modal="true" aria-label="Kézi hibakeresési napló">
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={onModalKeyDown}
        className="flex min-h-[560px] w-full max-w-4xl flex-col overflow-y-auto rounded-2xl border border-slate-700 bg-[#050b18] p-5 text-white shadow-2xl focus:outline-none"
      >
        <div className="flex items-center gap-4 border-b border-slate-800 pb-4">
          <Bug className="h-10 w-10 shrink-0 text-amber-300" />
          <div>
            <h2 className="text-2xl font-black tracking-wide">KÉZI HIBAKERESÉSI NAPLÓ</h2>
            <p className="mt-1 text-sm text-slate-400">A SÁRGA gomb csak ezt az ablakot nyitja meg. Naplózás és küldés kizárólag kézzel indul.</p>
          </div>
        </div>

        <div className="flex-1 space-y-4 py-5">
          <div className={`flex items-center justify-between gap-4 rounded-xl border-2 px-4 py-3 ${statusBg}`}>
            <div className="flex items-center gap-3">
              <Circle className={`h-5 w-5 fill-current ${statusColor}`} />
              <div>
                <div className={`text-lg font-black ${statusColor}`}>{snapshot.enabled ? 'NAPLÓZÁS BEKAPCSOLVA' : 'NAPLÓZÁS KIKAPCSOLVA'}</div>
                <div className="text-xs text-slate-400">{snapshot.enabled ? 'A lejátszó eseményei most rögzülnek.' : 'Normál tévézés közben nincs diagnosztikai naplózás.'}</div>
              </div>
            </div>
            <div className="text-right font-mono text-sm text-slate-300">
              <div>Napló: <strong className="text-white">#{snapshot.number ?? '—'}</strong></div>
              <div>{snapshot.startedAt ? formatRecordDate(new Date(snapshot.startedAt).toISOString()) : 'Nincs aktív napló'}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-700 bg-[#0b1730] p-3 text-center"><div className="text-2xl font-black text-white">{snapshot.lineCount}</div><div className="text-[10px] font-bold tracking-wider text-slate-400">SOR</div></div>
            <div className="rounded-xl border border-slate-700 bg-[#0b1730] p-3 text-center"><div className="text-2xl font-black text-white">{Math.round(snapshot.charCount / 1024)} KB</div><div className="text-[10px] font-bold tracking-wider text-slate-400">MÉRET / 1 MB</div></div>
            <div className="rounded-xl border border-slate-700 bg-[#0b1730] p-3 text-center"><div className="text-2xl font-black text-cyan-200">{elapsed}</div><div className="text-[10px] font-bold tracking-wider text-slate-400">ELTELT IDŐ</div></div>
            <div className="rounded-xl border border-slate-700 bg-[#0b1730] p-3 text-center"><div className="text-base font-black text-white">{snapshot.startedAt ? formatRecordDate(new Date(snapshot.startedAt).toISOString()).slice(0, 10) : '—'}</div><div className="text-[10px] font-bold tracking-wider text-slate-400">KEZDETE</div></div>
          </div>

          {/*
            UTOLSÓ 5 NAPLÓ – A SORSZÁM ÉS AZ IDŐ AKKORA, AMENNYIT A SAJÁT
            FÜGGŐLEGES DOBOZA ENGED (2.5.131).

            Korábban mindkét felirat `text-sm` (14 px) volt egy alacsony
            sorban, ezért a TV-n kicsi és nehezen olvasható volt. Most minden
            rekord egy legalább 72 px magas doboz: a sorszám 30/34 px, az
            időbélyeg 20/24 px, mindkettő `leading-none`, tehát pontosan a
            saját sorában ül. A `flex-wrap` + `min-w-0` + `break-words` +
            `overflow-hidden` gondoskodik róla, hogy a hosszú
            `ÉÉÉÉ-HH-NN ÓÓ:PP:MM` idő soha ne folyjon ki vagy lógjon túl a
            dobozon – ha kell, a saját sorába tördelődik.
          */}
          <div className="rounded-xl border border-cyan-500/35 bg-[#081329] p-4">
            <div className="mb-3 flex items-center gap-2 text-base font-black tracking-wider text-cyan-200"><History className="h-6 w-6 shrink-0" /> UTOLSÓ 5 ELKÜLDÖTT NAPLÓ</div>
            {history.length ? (
              <div className="space-y-2.5">
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

          {notice && <p role="status" className="rounded-lg border border-emerald-400/40 bg-emerald-500/10 p-3 text-center text-sm font-bold text-emerald-200">{notice}</p>}
          {error && <p role="alert" className="rounded-lg border border-rose-400/40 bg-rose-500/10 p-3 text-center text-sm font-bold text-rose-200">{error}</p>}
        </div>

        <div className="grid grid-cols-2 gap-4 border-t border-slate-700 pt-4">
          <button
            data-diagnostic-toggle=""
            type="button"
            onClick={toggleLogging}
            disabled={busy}
            className={`flex min-h-[64px] items-center justify-center gap-3 rounded-xl border-2 px-4 py-3 text-lg font-black focus:outline-none focus:ring-4 focus:ring-amber-400 disabled:opacity-50 ${snapshot.enabled ? 'border-emerald-300 bg-emerald-400/20 text-emerald-100' : 'border-rose-300 bg-rose-400/15 text-rose-100'}`}
          >
            <Circle className="h-5 w-5 fill-current" />
            {snapshot.enabled ? 'Naplózás leállítása' : 'Naplózás indítása'}
          </button>
          <button
            data-diagnostic-send=""
            type="button"
            onClick={() => void sendLog()}
            disabled={busy || Boolean(sentRecord) || !snapshot.number || snapshot.charCount <= 0}
            className="flex min-h-[64px] items-center justify-center gap-3 rounded-xl border-2 border-cyan-300 bg-cyan-400/15 px-4 py-3 text-lg font-black text-cyan-100 focus:outline-none focus:ring-4 focus:ring-amber-400 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Send className="h-6 w-6" />}
            Küldés Supabase-re
          </button>
        </div>
        <p className="pt-3 text-center text-xs text-slate-500">Kilépéskor a naplózás automatikusan leáll. A naplók Supabase-en legfeljebb öt legfrissebb sorszámmal maradnak meg.</p>
      </div>
    </div>
  );
};
