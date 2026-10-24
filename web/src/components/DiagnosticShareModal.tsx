import React, { useEffect, useRef, useState } from 'react';
import { QrCode, RefreshCw, RotateCcw, AlertTriangle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  appLog,
  getAppLogText,
  measurementSnapshot,
  resetMeasurements,
  type MeasurementSnapshot,
} from '../services/appLog';
import {
  createDiagnosticShare,
  revokeDiagnosticShare,
  type DiagnosticShare,
} from '../services/diagnosticShareService';
import { useTvModalNavigation } from '../hooks/useTvModalNavigation';
import { normalizeTvKey } from '../utils/tvKeys';

interface DiagnosticShareModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DiagnosticShareModal: React.FC<DiagnosticShareModalProps> = ({ isOpen, onClose }) => {
  const [share, setShare] = useState<DiagnosticShare | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /*
   * MÉRÉS-ABLAK: a dobozban látható mért értékek. A „Frissítés” gomb ezeket
   * nullázza (0), és új, látható kezdő időponttal indít mérést – így a
   * távirányítóval is ellenőrizhető, hogy a nullázás megtörtént.
   */
  const [measure, setMeasure] = useState<MeasurementSnapshot>(() => measurementSnapshot());
  const generationRef = useRef(0);
  const shareRef = useRef<DiagnosticShare | null>(null);
  const { modalRef, handleKeyDown } = useTvModalNavigation(isOpen, onClose);
  shareRef.current = share;

  const createNewQr = async (trigger: string = 'automatikus (megnyitás)') => {
    appLog(`QR-diagnózis: új QR-kód kérése – ${trigger}.`);
    const generation = ++generationRef.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      appLog('Diagnosztikai napló QR-kód létrehozása.');
      const created = await createDiagnosticShare(getAppLogText().slice(-59000));
      if (generation !== generationRef.current) {
        void revokeDiagnosticShare(created.token);
        return;
      }
      const previous = shareRef.current;
      setShare(created);
      shareRef.current = created;
      if (previous?.token) void revokeDiagnosticShare(previous.token);
      setNotice('Új QR-kód elkészült. A hivatkozás 1 óráig érvényes.');
    } catch (cause) {
      if (generation === generationRef.current) setError('Nem sikerült létrehozni a QR-kódot. Ellenőrizd a TV internetkapcsolatát, majd próbáld újra.');
      appLog('Diagnosztikai QR-kód létrehozása sikertelen: ' + String(cause).slice(0, 180));
      console.warn('[diagnostic-qr] create failed', cause);
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  };

  const closeModal = () => {
    appLog('QR-diagnózis bezárva.');
    onClose();
  };

  const refreshLog = async () => {
    const current = shareRef.current;
    setBusy(true);
    setError('');
    setNotice('');

    // A Frissítés azonnal, a gombnyomáskor törli az előző mérési ablakot,
    // majd nullázott számlálókkal indít újat. Az egy napos automatikus
    // naplómegőrzési mechanizmust nem módosítjuk.
    const fresh = resetMeasurements('QR-hibadiagnózis: Frissítés gomb');
    setMeasure(fresh);
    try {
      appLog('QR-diagnózis: új mérési ablak indult; az előző napló törölve.');
      // Mindig ÚJ megosztási tokent és URL-t készítünk. Így a telefon nem
      // olvashatja vissza a korábbi QR-hivatkozás tartalmát; az új linkbe
      // kizárólag a reset után összegyűlt teljes mérési napló kerül.
      appLog('Diagnosztikai QR: új hivatkozás készítése a nullázás utáni naplóból.');
      const created = await createDiagnosticShare(getAppLogText().slice(-59000));
      setShare(created);
      shareRef.current = created;
      if (current?.token) void revokeDiagnosticShare(current.token);
      setNotice(`Az előzmények törölve. Új mérés kezdete: ${fresh.startedAtText}; a QR csak az azóta keletkezett naplót tartalmazza`);
    } catch (cause) {
      setError('A frissítés nem sikerült. A mérés elindult, próbáld újra a QR frissítését.');
      appLog('Diagnosztikai QR-napló frissítése sikertelen: ' + String(cause).slice(0, 180));
      console.warn('[diagnostic-qr] refresh failed', cause);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const onRedKey = (event: Event) => {
      if ((event as CustomEvent)?.detail?.action === 'diagnostic-share') void createNewQr('SÁRGA gomb (újrakérés)');
    };
    window.addEventListener('iptv-tv-action', onRedKey);
    return () => window.removeEventListener('iptv-tv-action', onRedKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // A mérés-ablak élő kijelzése: amíg a doboz nyitva van, másodpercenként
  // frissül az eltelt idő (a kezdő időpont és a mért értékek láthatók maradnak).
  useEffect(() => {
    if (!isOpen) return;
    const opened = measurementSnapshot();
    appLog(
      `QR-diagnózis megnyitva; mérés kezdete=${opened.startedAtText}, ` +
      `naplósorok=${opened.logLines}, hibák=${opened.errors}, hosszú feladatok=${opened.longTasks}.`
    );
    setMeasure(opened);
    const timer = window.setInterval(() => setMeasure(measurementSnapshot()), 1000);
    return () => window.clearInterval(timer);
  }, [isOpen]);

  /*
   * TÁVIRANYÍTÓ: a fő művelet (FRISSÍTÉS = mérések nullázása) kapja a fókuszt.
   *
   * A napló tanúsága szerint a QR-ablak 7 percig nyitva volt anélkül, hogy
   * bármilyen gombnyomás látszana – a nézőnek nem volt egyértelmű, melyik
   * gombon áll a kijelölő. Most nyitáskor egy OK már a Frissítést indítja.
   */
  useEffect(() => {
    if (!isOpen) return;
    const focusRefresh = () => {
      try {
        const button = modalRef.current?.querySelector<HTMLElement>('[data-diagnostic-refresh]');
        button?.focus({ preventScroll: true } as any);
      } catch { /* régi motor */ }
    };
    const timers = [160, 700].map((delay) => window.setTimeout(focusRefresh, delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [isOpen, modalRef]);

  /*
   * A távirányító OK gombja a fókuszált gombot aktiválja. A webos.js is
   * kezeli, de a React kezelője hamarabb fut – itt végezzük el, hogy a
   * naplóba is bekerüljön, melyik gombot nyomta meg a néző.
   */
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

  useEffect(() => {
    if (!isOpen) {
      generationRef.current += 1;
      setBusy(false);
      setError('');
      setNotice('');
      setShare(null);
      shareRef.current = null;
      return;
    }
    void createNewQr('ablak megnyitása');
    // A modal minden megnyitáskor új, lejáró QR-hivatkozást készít.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;
  const expiry = share?.expiresAt ? new Date(share.expiresAt).toLocaleTimeString('hu-HU', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit' }) : '';
  // Eltelt idő a mérés kezdetétől (mm:ss) – a nullázás óta mérve.
  const elapsedSeconds = Math.max(0, Math.floor(measure.elapsedMs / 1000));
  const elapsedText = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`;
  const measuredCells = [
    { label: 'NAPLÓSOR', value: measure.logLines },
    { label: 'HIBA', value: measure.errors },
    { label: 'HOSSZÚ FELADAT', value: measure.longTasks },
  ];

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black p-2"
      role="dialog"
      aria-modal="true"
      aria-label="Diagnosztikai napló QR-kód"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={onModalKeyDown}
        className="w-full max-w-3xl max-h-[96vh] overflow-y-auto rounded-xl border border-slate-700 bg-black p-3 text-white focus:outline-none"
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-3">
            <QrCode className="h-7 w-7 text-slate-400" />
            <div>
              <h2 className="text-xl font-black">HIBAKERESÉSI NAPLÓ QR-KÓD</h2>
              <p className="text-sm text-slate-400">Olvasd be telefonnal a napló megnyitásához.</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center gap-3 py-5">
          {/* SÖTÉTEBB, KISEBB QR: a TV-n nem vakít, és kisebb helyet foglal.
              A kód TARTALMA (share.url) és a hibaszint (M) VÁLTOZATLAN, a
              csendes zóna (marginSize=4) megmarad – a beolvasás nem sérül. */}
          <div className="flex min-h-[500px] w-[500px] max-w-full items-center justify-center rounded-lg border border-slate-700 bg-black p-2">
            {share?.url ? (
              <QRCodeSVG
                value={share.url}
                size={480}
                level="L"
                boostLevel={false}
                marginSize={4}
                bgColor="#ffffff"
                fgColor="#05080f"
                title="Diagnosztikai napló megosztása QR-kóddal"
              />
            ) : (
              <div className="flex flex-col items-center gap-3 text-center text-slate-600">
                {error ? <AlertTriangle className="h-10 w-10 text-rose-500" /> : <RefreshCw className="h-10 w-10 animate-spin" />}
                <span className="text-sm">{error ? 'A QR-kód nem készült el' : 'QR-kód készítése…'}</span>
              </div>
            )}
          </div>
          <p className="max-w-lg text-center text-xs text-slate-500">A fekete-fehér kód maradjon mozdulatlanul a képernyőn a beolvasásig.</p>
          {expiry && <p className="text-sm text-emerald-300">Lejárat: {expiry} (1 órás hivatkozás)</p>}

          {/* MÉRÉS-ABLAK: a Frissítés gomb ezt nullázza (0), és új kezdő
              időponttal indít mérést – a nullázás itt láthatóan ellenőrizhető. */}
          <div data-diagnostic-measure="" className="w-full rounded-xl border border-cyan-500/40 bg-[#0a152d] px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="text-[11px] font-black tracking-widest text-cyan-300">MÉRÉS</span>
              <span className="font-mono text-[11px] text-slate-300">
                kezdete: <span data-diagnostic-measure-start="" className="font-bold text-cyan-200">{measure.startedAtText}</span>
                {' · '}eltelt: {elapsedText}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {measuredCells.map((cell) => (
                <div key={cell.label} className="rounded-lg border border-slate-700/70 bg-[#081226] py-1.5 text-center">
                  <div data-diagnostic-measure-value="" className="font-mono text-lg font-black leading-none text-white">{cell.value}</div>
                  <div className="mt-1 text-[9px] font-bold tracking-wider text-slate-400">{cell.label}</div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-center text-[10px] leading-snug text-slate-500">
              A „Frissítés” a mért értékeket 0-ra állítja, és új mérést indít a fenti kezdő időponttól.
            </p>
          </div>

          {notice && <p role="status" className="text-center text-sm text-emerald-300">{notice}</p>}
          {error && <p role="alert" className="max-w-lg text-center text-sm text-rose-300">{error}</p>}
        </div>

        <div className="grid grid-cols-3 gap-3 border-t border-slate-700 pt-4">
          <button
            data-diagnostic-refresh=""
            onClick={() => void refreshLog()}
            disabled={busy}
            className="flex min-h-[56px] items-center justify-center gap-2 rounded-xl border border-cyan-500/60 bg-cyan-500/15 px-3 py-3 font-bold text-cyan-100 focus:outline-none focus:ring-4 focus:ring-amber-400 disabled:opacity-50"
          >
            <RefreshCw className="h-5 w-5" /> Frissítés
          </button>
          <button
            data-diagnostic-newqr=""
            onClick={() => void createNewQr('Új QR-kód gomb')}
            disabled={busy}
            className="flex min-h-[56px] items-center justify-center gap-2 rounded-xl border border-amber-400/70 bg-amber-400/15 px-3 py-3 font-bold text-amber-100 focus:outline-none focus:ring-4 focus:ring-amber-400 disabled:opacity-50"
          >
            <RotateCcw className="h-5 w-5" /> Új QR-kód
          </button>
        </div>
        <p className="pt-3 text-center text-xs text-slate-500">A QR-hivatkozás titkos, és egy óra múlva automatikusan lejár.</p>
      </div>
    </div>
  );
};
