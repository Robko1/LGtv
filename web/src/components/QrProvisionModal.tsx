import React, { useEffect, useState, useRef } from 'react';
import { Smartphone, QrCode, RefreshCw, Check, Clock, Tv } from 'lucide-react';
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

  const { modalRef, handleKeyDown } = useTvModalNavigation(isOpen, onClose, [code]);

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
        // A QR payload tartalmazhat Xtream belépési adatot; ne kerüljön
        // konzolra vagy diagnosztikai naplóba.
        setReceivedData(data);
        setStatus('received');
        if (pollRef.current) window.clearInterval(pollRef.current);
        if (countdownRef.current) window.clearInterval(countdownRef.current);
        /*
         * AZ IMPORT AZONNAL INDUL (2.5.165).
         *
         * Korábban 1,5 mp-et vártunk: a telefonon már „kész” volt, a TV-n
         * viszont semmi nem történt, majd hirtelen felugrott a
         * diagnosztikai ablak. Most az adat azonnal átadódik, a QR-ablak
         * bezárul, és a diagnosztika rögtön a betöltés elején megnyílik.
         */
        onProviderReceived(data);
        setReceivedData(null);
        clearProvision(tvId, channel, token);
        onClose();
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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black p-2"
      role="dialog"
      aria-modal="true"
      aria-label="Telefonnal beállítás QR kóddal"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="w-full max-w-3xl max-h-[96vh] overflow-hidden rounded-xl border border-slate-700 bg-black p-2 md:p-3 text-white focus:outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-2">
          <div className="flex items-center gap-3">
            <Smartphone className="h-7 w-7 text-slate-400" />
            <h2 className="text-xl font-black text-white">TELEFONNAL BEÁLLÍTÁS</h2>
          </div>
        </div>

        <div className="space-y-1.5 overflow-hidden py-1.5">
          {/* Kód kijelző */}
          <div className="flex flex-col items-center gap-1.5">
            <div className="flex items-center gap-2 text-amber-300">
              <Tv className="w-5 h-5" />
              <span className="text-xs font-black tracking-widest">TV KÓD</span>
            </div>
            <div className="rounded-xl border border-amber-400/70 bg-amber-400/10 px-3 py-1.5">
              <span className="font-mono text-xl sm:text-2xl font-black tracking-[0.1em] text-amber-300">{code || '------'}</span>
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
            <div className="flex items-center gap-2 text-slate-300">
              <QrCode className="w-5 h-5" />
              <span className="text-sm font-bold uppercase tracking-wider">Olvasd be telefonnal</span>
            </div>
            <div className="flex h-[min(42vh,300px)] w-[min(42vh,300px)] max-w-full items-center justify-center rounded-lg border border-slate-700 bg-black p-1 shrink-0">
              {provisionUrl ? (
                <QRCodeSVG
                  value={provisionUrl}
                  size={280}
                  level="M"
                  boostLevel={false}
                  marginSize={4}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  title="IPTV telefonos párosítás QR-kód"
                  style={{ display: 'block', width: '100%', height: 'auto', maxWidth: '100%', maxHeight: '100%' }}
                />
              ) : (
                <div className="w-full max-w-full aspect-square flex items-center justify-center bg-white text-slate-500 text-sm">QR generálás...</div>
              )}
            </div>
            <p className="max-w-lg text-center text-sm text-slate-400 leading-relaxed">
              Olvasd be a kódot a telefon kamerájával. Tartsd a telefont kb. 20–40 cm-re.
            </p>
          </div>

          {/* Státusz */}
          {status === 'waiting' && (
            <div className="flex items-center justify-center gap-2 py-3 text-sm text-slate-300">
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span>Várakozás telefonos adatokra... (3 másodpercenként ellenőrzés)</span>
            </div>
          )}
          {status === 'received' && receivedData && (
            <div className="rounded-xl border border-emerald-500/50 bg-emerald-950/40 p-4 flex items-center gap-3 text-emerald-300">
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
            <div className="rounded-xl border border-rose-500/50 bg-rose-950/40 p-4 text-center">
              <p className="text-xs font-bold text-rose-300">A kód lejárt (5 perc)</p>
              <p className="text-[11px] text-rose-200 mt-1">Nyomd meg a Frissítés gombot új kódért</p>
            </div>
          )}
          {status === 'error' && (
            <div className="rounded-xl border border-rose-500/50 bg-rose-950/40 p-4 text-sm text-rose-300 space-y-2">
              <p className="font-bold">A Supabase QR-párosító szolgáltatás nem érhető el.</p>
              <p className="text-[11px] leading-relaxed break-words">Részletek (v{WEB_VERSION}): {getProvisionDiag() || 'nincs adat'}</p>
              <p className="text-[11px] text-rose-200/80">Ellenőrizd a TV internetkapcsolatát, majd próbáld az Új kód gombot, vagy add meg az adatokat kézzel az Új lista gombbal.</p>
            </div>
          )}

          {/* Gombok */}
          <div className="flex justify-center border-t border-slate-700 pt-2">
            <button
              onClick={handleRefresh}
              className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-cyan-500/60 bg-cyan-500/15 px-3 py-2 font-bold text-cyan-100 focus:outline-none focus:ring-4 focus:ring-amber-400"
            >
              <RefreshCw className="h-5 w-5" />
              Új kód
            </button>
          </div>

          {/* Alternatíva – manuális */}
          <p className="pt-1 text-center text-[10px] text-slate-500">
            Nincs okostelefon? A Beállítások → Listák → Új lista gombbal továbbra is beírhatod kézzel a TV-n.
          </p>
        </div>
      </div>
    </div>
  );
};
