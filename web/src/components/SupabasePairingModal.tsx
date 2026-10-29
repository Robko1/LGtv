import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Delete,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Unlink,
  X,
} from 'lucide-react';
import { TvDoctorIcon } from './TvDoctorIcon';
import { dateTimeText } from '../services/appLog';
import { subscribeTvDoctorUpdates } from '../services/tvDoctor';
import {
  getTvDoctorPairingInfo,
  requestTvDoctorPairingCode,
  unpairTvDoctorDevice,
  verifyTvDoctorPairingCode,
} from '../services/tvDoctorCloud';
import { normalizeTvKey } from '../utils/tvKeys';

interface SupabasePairingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function extractDigitFromKeyEvent(e: React.KeyboardEvent): string | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (/^[0-9]$/.test(e.key)) return e.key;
  if (/^Digit[0-9]$/.test(e.code || '')) return e.code.slice(5);
  if (/^Numpad[0-9]$/.test(e.code || '')) return e.code.slice(6);
  const kc = e.keyCode || e.which || 0;
  if (kc >= 48 && kc <= 57) return String(kc - 48);
  if (kc >= 96 && kc <= 105) return String(kc - 96);
  return null;
}

export const SupabasePairingModal: React.FC<SupabasePairingModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    setCode('');
    setLocalError(null);
    const unsubscribe = subscribeTvDoctorUpdates(() => {
      setTick((n) => n + 1);
    });
    const timer = window.setTimeout(() => {
      const defBtn = dialogRef.current?.querySelector<HTMLElement>('[data-tv-default]');
      defBtn?.focus({ preventScroll: true } as any);
    }, 60);
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [isOpen]);

  if (!isOpen || typeof document === 'undefined') return null;

  const pairing = getTvDoctorPairingInfo();
  const busy = pairing.verifyingCode || pairing.requestingCode;

  const appendDigit = (digit: string) => {
    if (busy) return;
    setLocalError(null);
    setCode((prev) => (prev.length < 6 ? `${prev}${digit}` : prev));
  };

  const removeLastDigit = () => {
    if (busy) return;
    setLocalError(null);
    setCode((prev) => prev.slice(0, -1));
  };

  const clearDigits = () => {
    if (busy) return;
    setLocalError(null);
    setCode('');
  };

  const handleVerify = async () => {
    if (busy) return;
    if (!/^[0-9]{6}$/.test(code)) {
      setLocalError('Írd be mind a 6 számjegyet a Párosítás ellenőrzése előtt!');
      return;
    }
    setLocalError(null);
    const res = await verifyTvDoctorPairingCode(code);
    if (res.ok) {
      setCode('');
    }
  };

  const handleRequestCode = async () => {
    if (busy) return;
    setLocalError(null);
    await requestTvDoctorPairingCode();
  };

  const handleUnpair = async () => {
    if (busy) return;
    setLocalError(null);
    setCode('');
    await unpairTvDoctorDevice();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const normalized = normalizeTvKey(e);
    const kc = e.keyCode || e.which || 0;

    if (normalized === 'Escape' || kc === 461) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      if (code.length > 0) {
        removeLastDigit();
      } else {
        onClose();
      }
      return;
    }

    const digit = extractDigitFromKeyEvent(e);
    if (digit !== null) {
      e.preventDefault();
      e.stopPropagation();
      appendDigit(digit);
    }
  };

  // Egyértelmű 4 állapot: nincs párosítva | ellenőrzés folyamatban | sikeres párosítás | hiba
  let displayState: 'unpaired' | 'verifying' | 'paired' | 'error' = pairing.uiState;
  if (localError) {
    displayState = 'error';
  }

  let statusTitle = 'Nincs párosítva';
  let statusDescription =
    pairing.statusMessage
    || 'A TV helyi TV Doktor funkciói korlátozás nélkül működnek. A védett Supabase adatok eléréséhez egyszeri 6 jegyű párosítás szükséges.';
  let statusBoxClass = 'border-amber-400/50 bg-amber-950/35 text-amber-100';

  if (displayState === 'verifying') {
    statusTitle = 'Ellenőrzés folyamatban';
    statusDescription = 'A 6 jegyű párosítási kód biztonságos ellenőrzése folyamatban van…';
    statusBoxClass = 'border-cyan-400/60 bg-cyan-950/45 text-cyan-100';
  } else if (displayState === 'error') {
    statusTitle = 'Hiba';
    statusDescription = localError || pairing.statusMessage || 'Sikertelen párosítás. Ellenőrizd a 6 jegyű kódot vagy igényelj újat.';
    statusBoxClass = 'border-rose-500/65 bg-rose-950/55 text-rose-100';
  } else if (displayState === 'paired' || pairing.paired) {
    statusTitle = 'Sikeres párosítás';
    const pairedAtFormatted = pairing.pairedAt && Number.isFinite(Date.parse(pairing.pairedAt))
      ? dateTimeText(Date.parse(pairing.pairedAt))
      : null;
    statusDescription = pairing.statusMessage
      || `Ez a TV tartósan párosítva van${pairedAtFormatted ? ` (${pairedAtFormatted})` : ''}. A háttérszinkron automatikusan, ismételt kódkérés nélkül működik.`;
    statusBoxClass = 'border-emerald-400/60 bg-emerald-950/45 text-emerald-100';
  }

  const keypadDigits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Supabase-párosítás"
      data-supabase-pairing-modal=""
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 flex items-center justify-center bg-black/80 p-4"
      style={{ zIndex: 2147482500 }}
    >
      <div className="w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-3xl border-2 border-cyan-400/55 bg-[#071328] p-5 sm:p-6 text-white shadow-2xl space-y-4">
        {/* Fejléc */}
        <div className="flex items-center justify-between gap-4 border-b border-cyan-800/50 pb-3.5">
          <div className="flex items-center gap-3.5 min-w-0">
            <TvDoctorIcon handled={true} className="h-12 w-12 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-xl sm:text-2xl font-black tracking-tight text-white">
                Supabase-párosítás
              </h2>
              <p className="text-sm sm:text-base text-slate-300">
                Egyszeri 6 jegyű számkódos hitelesítés ehhez az LG TV-hez
              </p>
            </div>
          </div>
          <button
            type="button"
            data-tv-doctor-pair-close=""
            onClick={onClose}
            aria-label="Bezárás"
            className="flex items-center gap-1.5 rounded-xl border border-slate-600/70 bg-slate-800/80 px-3.5 py-2 text-sm sm:text-base font-bold text-slate-100 hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400"
          >
            <X className="h-5 w-5" />
            <span>Bezárás</span>
          </button>
        </div>

        {/* Állapotjelző sáv + Eszköz azonosítója */}
        <div
          data-tv-doctor-pair-status=""
          data-pair-state={displayState}
          className={`rounded-2xl border-2 p-4 space-y-2 ${statusBoxClass}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-base sm:text-lg font-black">
              {displayState === 'verifying' ? (
                <Loader2 className="h-6 w-6 shrink-0 animate-spin text-cyan-300" />
              ) : displayState === 'paired' ? (
                <ShieldCheck className="h-6 w-6 shrink-0 text-emerald-300" />
              ) : displayState === 'error' ? (
                <AlertTriangle className="h-6 w-6 shrink-0 text-rose-300" />
              ) : (
                <ShieldAlert className="h-6 w-6 shrink-0 text-amber-300" />
              )}
              <span>Állapot: {statusTitle}</span>
            </div>

            <div
              data-tv-doctor-device-id=""
              className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-slate-950/65 px-3 py-1.5 text-sm sm:text-base font-bold text-cyan-200"
            >
              <span className="text-slate-300">Eszköz azonosítója:</span>
              <span className="font-mono font-black tracking-wider text-white">{pairing.deviceId}</span>
            </div>
          </div>

          <p className="text-sm sm:text-base leading-snug text-slate-100 font-medium">
            {statusDescription}
          </p>
        </div>

        {/* 6 jegyű kód + távirányító számgombok és fő műveleti gombok */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-stretch">
          {/* Bal oldal: 6 számjegy + Párosítás ellenőrzése + Új kód igénylése */}
          <div className="md:col-span-7 rounded-2xl border border-cyan-800/50 bg-[#0b1b38] p-4 flex flex-col justify-between space-y-4">
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-base font-black text-cyan-200">
                  <KeyRound className="h-5 w-5 shrink-0 text-amber-300" />
                  <span>6 jegyű párosítási kód</span>
                </span>
                <span className="text-xs sm:text-sm font-semibold text-slate-300">
                  {code.length} / 6 számjegy
                </span>
              </div>

              <div
                data-tv-doctor-code-slots=""
                className="grid grid-cols-6 gap-2 pt-1"
                aria-label={`Beírt párosítási kód: ${code.length} számjegy`}
              >
                {[0, 1, 2, 3, 4, 5].map((idx) => {
                  const ch = code[idx] || '';
                  const isActiveSlot = idx === code.length && code.length < 6;
                  return (
                    <div
                      key={idx}
                      data-code-slot={idx}
                      className={`flex h-14 sm:h-16 items-center justify-center rounded-xl border-2 font-mono text-2xl sm:text-3xl font-black ${
                        ch
                          ? 'border-cyan-400 bg-cyan-500/15 text-white'
                          : isActiveSlot
                            ? 'border-amber-400/80 bg-slate-900/90 text-amber-300'
                            : 'border-slate-700 bg-slate-950/75 text-slate-500'
                      }`}
                    >
                      {ch || '•'}
                    </div>
                  );
                })}
              </div>

              <p className="text-xs sm:text-sm text-slate-300 leading-snug">
                Írd be a távirányító számgombjaival vagy a jobb oldali számbillentyűzettel.
              </p>
            </div>

            <div className="space-y-2.5 pt-1">
              <button
                type="button"
                data-tv-doctor-pair-verify=""
                disabled={busy}
                onClick={() => void handleVerify()}
                className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-emerald-400/80 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-55 py-3 px-4 text-base sm:text-lg font-black text-slate-950 shadow-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
              >
                {pairing.verifyingCode ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-5 w-5" />
                )}
                <span>Párosítás ellenőrzése</span>
              </button>

              <button
                type="button"
                data-tv-default=""
                data-tv-doctor-pair-request=""
                disabled={busy}
                onClick={() => void handleRequestCode()}
                className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-cyan-400/70 bg-cyan-500/15 hover:bg-cyan-500/25 disabled:opacity-55 py-3 px-4 text-base sm:text-lg font-black text-cyan-100 focus:outline-none focus:ring-2 focus:ring-amber-400"
              >
                <RefreshCw className={`h-5 w-5 ${pairing.requestingCode ? 'animate-spin' : ''}`} />
                <span>Új kód igénylése</span>
              </button>

              {pairing.paired && (
                <button
                  type="button"
                  data-tv-doctor-unpair=""
                  disabled={busy}
                  onClick={() => void handleUnpair()}
                  className="w-full flex items-center justify-center gap-2 rounded-xl border border-rose-500/50 bg-rose-950/45 hover:bg-rose-900/55 disabled:opacity-55 py-2 px-3 text-sm font-bold text-rose-200 focus:outline-none focus:ring-2 focus:ring-amber-400"
                >
                  <Unlink className="h-4 w-4" />
                  <span>Párosítás megszüntetése</span>
                </button>
              )}
            </div>
          </div>

          {/* Jobb oldal: távirányítóbarát nagy számbillentyűzet (0–9) */}
          <div className="md:col-span-5 rounded-2xl border border-cyan-800/50 bg-[#0b1b38] p-4 flex flex-col justify-between space-y-2.5">
            <div className="text-sm font-bold text-slate-300 text-center">
              Távirányító számbillentyűzet
            </div>
            <div className="grid grid-cols-3 gap-2 flex-1">
              {keypadDigits.map((digit) => (
                <button
                  key={digit}
                  type="button"
                  data-tv-doctor-digit={digit}
                  disabled={busy}
                  onClick={() => appendDigit(digit)}
                  className="rounded-xl border border-cyan-500/40 bg-[#0f244a] hover:bg-[#163366] disabled:opacity-50 py-2.5 text-xl sm:text-2xl font-black text-white focus:outline-none focus:ring-2 focus:ring-amber-400"
                >
                  {digit}
                </button>
              ))}
              <button
                type="button"
                data-tv-doctor-digit-clear=""
                disabled={busy}
                onClick={clearDigits}
                className="rounded-xl border border-slate-600/60 bg-slate-800/70 hover:bg-slate-700/80 disabled:opacity-50 py-2.5 text-sm font-black text-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-400"
              >
                Ürít
              </button>
              <button
                type="button"
                data-tv-doctor-digit="0"
                disabled={busy}
                onClick={() => appendDigit('0')}
                className="rounded-xl border border-cyan-500/40 bg-[#0f244a] hover:bg-[#163366] disabled:opacity-50 py-2.5 text-xl sm:text-2xl font-black text-white focus:outline-none focus:ring-2 focus:ring-amber-400"
              >
                0
              </button>
              <button
                type="button"
                data-tv-doctor-digit-backspace=""
                disabled={busy}
                onClick={removeLastDigit}
                aria-label="Utolsó számjegy törlése"
                className="flex items-center justify-center gap-1 rounded-xl border border-amber-500/45 bg-amber-950/45 hover:bg-amber-900/55 disabled:opacity-50 py-2.5 text-sm font-black text-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-400"
              >
                <Delete className="h-4 w-4" />
                <span>Töröl</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
