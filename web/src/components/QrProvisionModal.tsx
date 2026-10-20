import React, { useEffect, useState, useRef } from 'react';
import { X, Smartphone, QrCode, RefreshCw, Check, Clock, Tv } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { WEB_VERSION } from '../appVersion';
import { createProvisionSession, getProvisionUrl, pollForProvider, clearProvision, ensureProvisionChannel, getProvisionDiag, ProvisionChannel, QrProviderPayload } from '../services/qrProvisioningService';
import { useTvModalNavigation } from '../hooks/useTvModalNavigation';

interface QrProvisionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProviderReceived: (payload: QrProviderPayload) => void;
}

export const QrProvisionModal: React.FC<QrProvisionModalProps> = ({ isOpen, onClose, onProviderReceived }) => {
  const [tvId, setTvId] = useState<string>('');
  const [channel, setChannel] = useState<ProvisionChannel | null>(null);
  const [code, setCode] = useState<string>('');
  const [token, setToken] = useState<string>('');
  const [provisionUrl, setProvisionUrl] = useState<string>('');
  const [status, setStatus] = useState<'idle' | 'waiting' | 'received' | 'error' | 'expired'>('idle');
  const [countdown, setCountdown] = useState<number>(300); // 5 perc
  const [receivedData, setReceivedData] = useState<QrProviderPayload | null>(null);
  const pollRef = useRef<number | null>(null);
  const countdownRef = useRef<number | null>(null);

  const { modalRef, handleKeyDown, handleBackdropClick } = useTvModalNavigation(isOpen, onClose, [code]);

  const initSession = async () => {
    let session: { tvId: string; code: string; token: string; expiresAt: number };
    try {
      session = await createProvisionSession();
    } catch (e) {
      console.error('[QR] Supabase session creation failed', e);
      setStatus('error');
      return;
    }
    setTvId(session.tvId);
    setCode(session.code);
    setToken(session.token);
    setProvisionUrl('');
    setStatus('waiting');
    setCountdown(300);
    setReceivedData(null);
    // A párosítási munkamenet a különálló Supabase-projektben jön létre.
    // A QR tartalmazza a munkamenet-azonosítót és a véletlen, titkos tokent.
    const ch = await ensureProvisionChannel();
    setChannel(ch);
    const url = getProvisionUrl(session.tvId, session.code, ch, session.token);
    setProvisionUrl(url);
    if (!ch) {
      // Biztonsági tartalék: ne mutassunk működő QR-kódot, ha a backend nem kész.
      setStatus('error');
      return;
    }
    console.log('[QR] Supabase pairing session created', session.tvId, 'expires in 5 minutes');
  };

  useEffect(() => {
    if (!isOpen) {
      // Cleanup
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (countdownRef.current) window.clearInterval(countdownRef.current);
      pollRef.current = null;
      countdownRef.current = null;
      return;
    }
    initSession();
  }, [isOpen]);

  // Countdown
  useEffect(() => {
    if (!isOpen || status !== 'waiting') return;
    countdownRef.current = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          setStatus('expired');
          if (pollRef.current) window.clearInterval(pollRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (countdownRef.current) window.clearInterval(countdownRef.current);
    };
  }, [isOpen, status]);

  // Polling
  useEffect(() => {
    if (!isOpen || status !== 'waiting' || !tvId) return;
    pollRef.current = window.setInterval(async () => {
      const data = await pollForProvider(tvId, channel, token);
      if (data) {
        console.log('[QR] Provider received', data);
        setReceivedData(data);
        setStatus('received');
        if (pollRef.current) window.clearInterval(pollRef.current);
        if (countdownRef.current) window.clearInterval(countdownRef.current);
        // Auto import 1.5s után
        setTimeout(() => {
          onProviderReceived(data);
          clearProvision(tvId, channel, token);
          onClose();
        }, 1500);
      }
    }, 3000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [isOpen, status, tvId, channel, token, onProviderReceived, onClose]);

  const handleRefresh = () => {
    if (tvId) clearProvision(tvId, channel, token);
    initSession();
  };

  if (!isOpen) return null;

  const minutes = Math.floor(countdown / 60);
  const seconds = countdown % 60;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm p-4 animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-label="Telefonnal beállítás QR kóddal"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="w-full max-w-md md:max-w-lg lg:max-w-xl bg-[#071124] border-2 border-cyan-500/70 rounded-3xl shadow-2xl flex flex-col overflow-hidden focus:outline-none animate-scaleUp"
      >
        {/* Header */}
        <div className="p-4 bg-[#0a1835] border-b border-cyan-950 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Smartphone className="w-5 h-5 text-cyan-400" />
            <h2 className="text-base font-black text-white tracking-wide">TELEFONNAL BEÁLLÍTÁS</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-slate-300 active:scale-90"
            aria-label="Bezárás"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Kód kijelző */}
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2 text-amber-400">
              <Tv className="w-5 h-5" />
              <span className="text-xs font-black tracking-widest">TV KÓD</span>
            </div>
            <div className="px-6 py-3 rounded-2xl bg-[#0d1d3d] border-2 border-amber-400/70 shadow-lg">
              <span className="text-4xl font-black tracking-[0.3em] text-amber-300 font-mono">{code || '------'}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <Clock className="w-3.5 h-3.5" />
              <span>
                Lejár: {minutes}:{seconds.toString().padStart(2, '0')} – {status === 'expired' ? 'Lejárt' : status === 'waiting' ? 'Várakozás telefonra' : status === 'received' ? 'Megérkezett!' : '...'}
              </span>
            </div>
          </div>

          {/* QR kód */}
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2 text-cyan-300">
              <QrCode className="w-5 h-5" />
              <span className="text-xs font-bold uppercase tracking-wider">Olvasd be telefonnal</span>
            </div>
            <div className="p-4 rounded-2xl bg-white border-2 border-cyan-400/50 shadow-lg">
              {provisionUrl ? (
                <QRCodeSVG value={provisionUrl} size={320} level="M" includeMargin={false} />
              ) : (
                <div className="w-[320px] h-[320px] flex items-center justify-center bg-slate-100 text-slate-500 text-xs">QR generálás...</div>
              )}
            </div>
            <p className="text-[11px] text-slate-400 text-center max-w-xs leading-relaxed break-all">
              {provisionUrl || 'URL generálás...'}
            </p>
          </div>

          {/* Státusz */}
          {status === 'waiting' && (
            <div className="flex items-center justify-center gap-2 py-2 text-xs text-cyan-300">
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span>Várakozás telefonos adatokra... (3 másodpercenként ellenőrzés)</span>
            </div>
          )}
          {status === 'received' && receivedData && (
            <div className="rounded-xl bg-emerald-950/40 border border-emerald-500/50 p-3 flex items-center gap-2 text-emerald-300">
              <Check className="w-5 h-5" />
              <div className="text-xs">
                <p className="font-bold">Adatok megérkeztek!</p>
                <p className="text-[11px] text-emerald-200">
                  {receivedData.type === 'xtream'
                    ? `Xtream: ${receivedData.host} – ${receivedData.username}`
                    : `M3U: ${receivedData.url?.slice(0, 40)}...`}
                </p>
                <p className="text-[11px] mt-1">Automatikus importálás...</p>
              </div>
            </div>
          )}
          {status === 'expired' && (
            <div className="rounded-xl bg-rose-950/40 border border-rose-500/50 p-3 text-center">
              <p className="text-xs font-bold text-rose-300">A kód lejárt (5 perc)</p>
              <p className="text-[11px] text-rose-200 mt-1">Nyomd meg a Frissítés gombot új kódért</p>
            </div>
          )}
          {status === 'error' && (
            <div className="rounded-xl bg-rose-950/40 border border-rose-500/50 p-3 text-xs text-rose-300 space-y-1.5">
              <p className="font-bold">A Supabase QR-párosító szolgáltatás nem érhető el.</p>
              <p className="text-[11px] leading-relaxed break-words">Részletek (v{WEB_VERSION}): {getProvisionDiag() || 'nincs adat'}</p>
              <p className="text-[11px] text-rose-200/80">Ellenőrizd a TV internetkapcsolatát, majd próbáld az Új kód gombot, vagy add meg az adatokat kézzel az Új lista gombbal.</p>
            </div>
          )}

          {/* Gombok */}
          <div className="grid grid-cols-2 gap-2 pt-2">
            <button
              onClick={handleRefresh}
              className="flex items-center justify-center gap-2 py-3 rounded-xl bg-[#112347] hover:bg-[#172e5c] text-slate-200 border border-slate-700 text-xs font-bold active:scale-95"
            >
              <RefreshCw className="w-4 h-4" />
              Új kód
            </button>
            <button
              onClick={onClose}
              className="flex items-center justify-center gap-2 py-3 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/50 text-cyan-200 text-xs font-black active:scale-95"
            >
              <X className="w-4 h-4" />
              Bezárás
            </button>
          </div>

          {/* Alternatíva – manuális */}
          <p className="text-[10px] text-slate-500 text-center pt-2">
            Nincs okostelefon? A Beállítások → Listák → Új lista gombbal továbbra is beírhatod kézzel a TV-n.
          </p>
        </div>
      </div>
    </div>
  );
};
