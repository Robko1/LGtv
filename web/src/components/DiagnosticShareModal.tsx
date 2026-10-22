import React, { useEffect, useRef, useState } from 'react';
import { QrCode, RefreshCw, RotateCcw, X, AlertTriangle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { appLog, getAppLogText } from '../services/appLog';
import {
  createDiagnosticShare,
  refreshDiagnosticShare,
  revokeDiagnosticShare,
  type DiagnosticShare,
} from '../services/diagnosticShareService';
import { useTvModalNavigation } from '../hooks/useTvModalNavigation';

interface DiagnosticShareModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DiagnosticShareModal: React.FC<DiagnosticShareModalProps> = ({ isOpen, onClose }) => {
  const [share, setShare] = useState<DiagnosticShare | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generationRef = useRef(0);
  const shareRef = useRef<DiagnosticShare | null>(null);
  const { modalRef, handleKeyDown, handleBackdropClick } = useTvModalNavigation(isOpen, onClose);
  shareRef.current = share;

  const createNewQr = async () => {
    const generation = ++generationRef.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      appLog('Diagnosztikai napló QR-kód létrehozása.');
      const created = await createDiagnosticShare(getAppLogText());
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
      console.warn('[diagnostic-qr] create failed', cause);
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  };

  const refreshLog = async () => {
    const current = shareRef.current;
    if (!current) {
      await createNewQr();
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      appLog('Diagnosztikai napló frissítése a QR-hivatkozáson.');
      const expiresAt = await refreshDiagnosticShare(current.token, getAppLogText());
      const updated = { ...current, expiresAt };
      setShare(updated);
      shareRef.current = updated;
      setNotice('A napló frissült. A QR-kód változatlan, a legfrissebb naplót nyitja meg.');
    } catch (cause) {
      setError('A frissítés nem sikerült. Készíts új QR-kódot.');
      console.warn('[diagnostic-qr] refresh failed', cause);
    } finally {
      setBusy(false);
    }
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
    void createNewQr();
    // A modal minden megnyitáskor új, lejáró QR-hivatkozást készít.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;
  const expiry = share?.expiresAt ? new Date(share.expiresAt).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/85 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Diagnosztikai napló QR-kód"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="w-full max-w-xl max-h-[92vh] overflow-y-auto rounded-2xl border-2 border-cyan-400/70 bg-[#071124] p-5 text-white shadow-2xl focus:outline-none"
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-700 pb-3">
          <div className="flex items-center gap-3">
            <QrCode className="h-7 w-7 text-cyan-300" />
            <div>
              <h2 className="text-xl font-black">HIBAKERESÉSI NAPLÓ QR-KÓD</h2>
              <p className="text-sm text-slate-300">Olvasd be telefonnal a napló megnyitásához.</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-3 text-slate-200 focus:outline-none focus:ring-4 focus:ring-amber-400" aria-label="Bezárás">
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-3 py-5">
          <div className="flex min-h-[280px] w-[280px] max-w-full items-center justify-center rounded-xl bg-white p-3">
            {share?.url ? (
              <QRCodeSVG value={share.url} size={256} level="M" marginSize={4} title="Diagnosztikai napló megosztása QR-kóddal" />
            ) : (
              <div className="flex flex-col items-center gap-3 text-center text-slate-600">
                {error ? <AlertTriangle className="h-10 w-10 text-rose-500" /> : <RefreshCw className="h-10 w-10 animate-spin" />}
                <span className="text-sm">{error ? 'A QR-kód nem készült el' : 'QR-kód készítése…'}</span>
              </div>
            )}
          </div>
          <p className="max-w-lg break-all text-center text-xs text-slate-400">
            {share?.url || (busy ? 'Kapcsolódás a Supabase naplómegosztóhoz…' : 'Nincs aktív QR-hivatkozás.')}
          </p>
          {expiry && <p className="text-sm text-emerald-300">Lejárat: {expiry} (1 órás hivatkozás)</p>}
          {notice && <p role="status" className="text-center text-sm text-emerald-300">{notice}</p>}
          {error && <p role="alert" className="max-w-lg text-center text-sm text-rose-300">{error}</p>}
        </div>

        <div className="grid grid-cols-3 gap-3 border-t border-slate-700 pt-4">
          <button
            onClick={() => void refreshLog()}
            disabled={busy}
            className="flex min-h-[56px] items-center justify-center gap-2 rounded-xl border border-cyan-500/60 bg-cyan-500/15 px-3 py-3 font-bold text-cyan-100 focus:outline-none focus:ring-4 focus:ring-amber-400 disabled:opacity-50"
          >
            <RefreshCw className="h-5 w-5" /> Frissítés
          </button>
          <button
            onClick={() => void createNewQr()}
            disabled={busy}
            className="flex min-h-[56px] items-center justify-center gap-2 rounded-xl border border-amber-400/70 bg-amber-400/15 px-3 py-3 font-bold text-amber-100 focus:outline-none focus:ring-4 focus:ring-amber-400 disabled:opacity-50"
          >
            <RotateCcw className="h-5 w-5" /> Új QR-kód
          </button>
          <button
            onClick={onClose}
            className="flex min-h-[56px] items-center justify-center gap-2 rounded-xl border border-slate-600 bg-white/5 px-3 py-3 font-bold text-slate-100 focus:outline-none focus:ring-4 focus:ring-amber-400"
          >
            <X className="h-5 w-5" /> Bezárás
          </button>
        </div>
        <p className="pt-3 text-center text-xs text-slate-500">A QR-hivatkozás titkos, és egy óra múlva automatikusan lejár.</p>
      </div>
    </div>
  );
};
