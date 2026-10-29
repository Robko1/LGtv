import React, { useRef } from 'react';
import { createPortal } from 'react-dom';

export type TvDoctorStatusPhase =
  | 'loading'
  | 'buffering'
  | 'repair'
  | 'retry'
  | 'error'
  | 'verifying';

export interface TvDoctorActiveStatus {
  phase: TvDoctorStatusPhase;
  title: string;
  detail: string;
}

export interface TvDoctorIconProps {
  /**
   * Igaz, ha a TV Doktor az adott élő csatornát, filmet vagy sorozatot
   * már ténylegesen kezelte, megvizsgálta vagy megjegyezte (zöld 3D megjelenés).
   */
  handled?: boolean;
  /** Igaz, ha a TV Doktor éppen most avatkozik be / tölt / javít. */
  active?: boolean;
  /** Igaz, ha a TV Doktor ki van kapcsolva a Rendszer menüben. */
  disabled?: boolean;
  className?: string;
}

let nextIconInstanceId = 0;

/**
 * Háromdimenziós, aranyos kis TV Doktor figura, amely a két kezében egy
 * televíziót tart. Vektoros 3D árnyékolással (fényfoltok, térbeli gradiensek,
 * mélységárnyékok), külső hálózati kérés és képfájldekódolás nélkül.
 *
 * - `handled = true`: élénk 3D smaragdzöld / mentazöld orvosi sapka, köpeny,
 *   érme-glória és világító zöld TV-képernyő.
 * - `handled = false`: hűvös 3D ezüst-pala készenléti megjelenés (teljes
 *   képernyőn az első vizsgálat előtt vagy kikapcsolt állapotban).
 */
export const TvDoctorIcon: React.FC<TvDoctorIconProps> = ({
  handled = true,
  active = false,
  disabled = false,
  className = 'w-7 h-7',
}) => {
  const uidRef = useRef<string>('');
  if (!uidRef.current) {
    nextIconInstanceId += 1;
    uidRef.current = `tvdoc3d-${nextIconInstanceId}`;
  }
  const id = uidRef.current;
  const isGreen = handled && !disabled;

  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      data-tv-doctor-svg=""
      data-doctor-handled={isGreen ? 'true' : 'false'}
      data-doctor-color={isGreen ? 'green' : 'neutral'}
      data-doctor-active={active ? 'true' : 'false'}
      className={`pointer-events-none select-none shrink-0 ${disabled ? 'opacity-65' : ''} ${className}`}
    >
      <defs>
        {/* 3D háttér-medál gradiens (zöld kezelt vs. ezüst-pala készenlét) */}
        <radialGradient id={`${id}-medal`} cx="32%" cy="24%" r="74%">
          <stop offset="0%" stopColor={isGreen ? '#6ee7b7' : '#94a3b8'} />
          <stop offset="42%" stopColor={isGreen ? '#10b981' : '#475569'} />
          <stop offset="82%" stopColor={isGreen ? '#047857' : '#1e293b'} />
          <stop offset="100%" stopColor={isGreen ? '#022c22' : '#0f172a'} />
        </radialGradient>

        {/* Medál külső 3D peremfény */}
        <linearGradient id={`${id}-rim`} x1="12" y1="6" x2="54" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={isGreen ? '#d1fae5' : '#e2e8f0'} />
          <stop offset="48%" stopColor={isGreen ? '#34d399' : '#64748b'} />
          <stop offset="100%" stopColor={isGreen ? '#065f46' : '#0f172a'} />
        </linearGradient>

        {/* Aranyos 3D arc térbeli bőrtónus */}
        <radialGradient id={`${id}-face`} cx="36%" cy="30%" r="68%">
          <stop offset="0%" stopColor="#fff7ed" />
          <stop offset="55%" stopColor="#fed7aa" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.88" />
        </radialGradient>

        {/* 3D orvosi sapka */}
        <linearGradient id={`${id}-cap`} x1="20" y1="7" x2="44" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={isGreen ? '#ecfdf5' : '#f1f5f9'} />
          <stop offset="45%" stopColor={isGreen ? '#34d399' : '#94a3b8'} />
          <stop offset="100%" stopColor={isGreen ? '#047857' : '#334155'} />
        </linearGradient>

        {/* Homloktükör 3D csillogás */}
        <radialGradient id={`${id}-mirror`} cx="35%" cy="30%" r="65%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="58%" stopColor={isGreen ? '#a7f3d0' : '#cbd5e1'} />
          <stop offset="100%" stopColor={isGreen ? '#059669' : '#475569'} />
        </radialGradient>

        {/* 3D orvosi köpeny */}
        <linearGradient id={`${id}-coat`} x1="18" y1="31" x2="46" y2="57" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={isGreen ? '#ecfdf5' : '#f8fafc'} />
          <stop offset="52%" stopColor={isGreen ? '#6ee7b7' : '#cbd5e1'} />
          <stop offset="100%" stopColor={isGreen ? '#059669' : '#64748b'} />
        </linearGradient>

        {/* Kezében tartott 3D televízió háza */}
        <linearGradient id={`${id}-tvcase`} x1="17" y1="34" x2="47" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={isGreen ? '#34d399' : '#94a3b8'} />
          <stop offset="45%" stopColor={isGreen ? '#065f46' : '#334155'} />
          <stop offset="100%" stopColor={isGreen ? '#022c22' : '#0f172a'} />
        </linearGradient>

        {/* 3D televízió világító képernyője */}
        <radialGradient id={`${id}-tvscreen`} cx="38%" cy="32%" r="72%">
          <stop offset="0%" stopColor={isGreen ? '#ecfdf5' : active ? '#bae6fd' : '#e2e8f0'} />
          <stop offset="45%" stopColor={isGreen ? '#34d399' : active ? '#38bdf8' : '#64748b'} />
          <stop offset="100%" stopColor={isGreen ? '#047857' : active ? '#0369a1' : '#1e293b'} />
        </radialGradient>

        {/* 3D kis kezek */}
        <radialGradient id={`${id}-hand`} cx="35%" cy="32%" r="68%">
          <stop offset="0%" stopColor={isGreen ? '#ecfdf5' : '#fff7ed'} />
          <stop offset="62%" stopColor={isGreen ? '#6ee7b7' : '#fed7aa'} />
          <stop offset="100%" stopColor={isGreen ? '#059669' : '#d97706'} />
        </radialGradient>
      </defs>

      {/* Alsó lágy 3D vetett árnyék */}
      <ellipse cx="32" cy="59.2" rx="20" ry="3.2" fill="#000000" fillOpacity="0.42" />

      {/* 3D domború érme-háttér és perem */}
      <circle
        cx="32"
        cy="32"
        r="28.2"
        fill={`url(#${id}-medal)`}
        stroke={`url(#${id}-rim)`}
        strokeWidth="2.4"
      />
      {/* Felső üveges 3D csillanás az érmén */}
      <path
        d="M12.5 22C15.5 11.8 24.8 6.4 35.5 7.2C42.2 7.7 47.6 10.8 50.8 15.2C45.4 11.9 37.8 10.6 29.8 11.9C21.2 13.3 15.3 17.3 12.5 22Z"
        fill="#ffffff"
        fillOpacity="0.28"
      />

      {/* Doktor vállak és 3D orvosi köpeny */}
      <path
        d="M14.5 52.5C15.2 41.2 21.8 35.2 32 35.2C42.2 35.2 48.8 41.2 49.5 52.5C45.2 56.4 39 58.6 32 58.6C25 58.6 18.8 56.4 14.5 52.5Z"
        fill={`url(#${id}-coat)`}
        stroke={isGreen ? '#064e3b' : '#1e293b'}
        strokeWidth="1.2"
      />
      {/* Köpeny gallér V-kivágás */}
      <path
        d="M26.2 35.4L32 41.2L37.8 35.4"
        stroke={isGreen ? '#047857' : '#334155'}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Sztetoszkóp a nyak körül */}
      <path
        d="M23.5 34.8C22.4 38.2 23.2 41.2 25.8 42.6M40.5 34.8C41.6 38.2 40.8 41.2 38.2 42.6"
        stroke={isGreen ? '#064e3b' : '#0f172a'}
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* Aranyos kis fülek */}
      <circle cx="19.2" cy="24.8" r="3.1" fill={`url(#${id}-face)`} stroke="#9a3412" strokeOpacity="0.28" strokeWidth="0.8" />
      <circle cx="44.8" cy="24.8" r="3.1" fill={`url(#${id}-face)`} stroke="#9a3412" strokeOpacity="0.28" strokeWidth="0.8" />

      {/* 3D gömbölyű doktorfej */}
      <ellipse
        cx="32"
        cy="24.2"
        rx="12.6"
        ry="11.4"
        fill={`url(#${id}-face)`}
        stroke="#7c2d12"
        strokeOpacity="0.32"
        strokeWidth="1"
      />

      {/* Pirosas 3D pofik */}
      <ellipse cx="23.6" cy="27.2" rx="2.5" ry="1.45" fill="#fb7185" fillOpacity="0.48" />
      <ellipse cx="40.4" cy="27.2" rx="2.5" ry="1.45" fill="#fb7185" fillOpacity="0.48" />

      {/* Csillogó 3D szemek dupla fényfolttal */}
      <ellipse cx="27.2" cy="24.2" rx="2.15" ry="2.45" fill="#0f172a" />
      <circle cx="26.5" cy="23.3" r="0.85" fill="#ffffff" />
      <circle cx="27.9" cy="25.0" r="0.42" fill="#ffffff" fillOpacity="0.85" />

      <ellipse cx="36.8" cy="24.2" rx="2.15" ry="2.45" fill="#0f172a" />
      <circle cx="36.1" cy="23.3" r="0.85" fill="#ffffff" />
      <circle cx="37.5" cy="25.0" r="0.42" fill="#ffffff" fillOpacity="0.85" />

      {/* Kedves mosoly */}
      <path
        d="M28.8 28.4C30 30.1 34 30.1 35.2 28.4"
        stroke="#7c2d12"
        strokeWidth="1.55"
        strokeLinecap="round"
      />

      {/* 3D orvosi sapka + homlokpánt */}
      <path
        d="M19.4 19.2C19.8 11.4 25.1 7.6 32 7.6C38.9 7.6 44.2 11.4 44.6 19.2C40.8 17.3 36.5 16.5 32 16.5C27.5 16.5 23.2 17.3 19.4 19.2Z"
        fill={`url(#${id}-cap)`}
        stroke={isGreen ? '#064e3b' : '#1e293b'}
        strokeWidth="1.15"
      />
      {/* Sapka csúcsfény */}
      <path
        d="M23.5 13.2C26.1 10.3 30.2 9.3 35.2 10.1"
        stroke="#ffffff"
        strokeOpacity="0.65"
        strokeWidth="1.6"
        strokeLinecap="round"
      />

      {/* 3D orvosi homloktükör + kereszt */}
      <circle
        cx="32"
        cy="14.2"
        r="4.7"
        fill={`url(#${id}-mirror)`}
        stroke={isGreen ? '#064e3b' : '#1e293b'}
        strokeWidth="1.15"
      />
      <path
        d="M32 11.7V16.7M29.5 14.2H34.5"
        stroke={isGreen ? '#047857' : '#dc2626'}
        strokeWidth="1.75"
        strokeLinecap="round"
      />

      {/* 3D kis televízió antennái (V-alakú nyuszifül antenna gömbvégekkel) */}
      <path
        d="M28.2 36.2L24.2 31.6M35.8 36.2L39.8 31.6"
        stroke={isGreen ? '#a7f3d0' : '#cbd5e1'}
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="24" cy="31.4" r="1.45" fill={isGreen ? '#6ee7b7' : '#e2e8f0'} />
      <circle cx="40" cy="31.4" r="1.45" fill={isGreen ? '#6ee7b7' : '#e2e8f0'} />

      {/* A doktor kezében tartott 3D televízió vetett árnyéka a köpenyen */}
      <rect x="18.2" y="37.2" width="27.6" height="19.2" rx="5.2" fill="#000000" fillOpacity="0.32" />

      {/* 3D televízió külső készülékház */}
      <rect
        x="17.5"
        y="35.6"
        width="29"
        height="19.4"
        rx="5.2"
        fill={`url(#${id}-tvcase)`}
        stroke={isGreen ? '#a7f3d0' : '#cbd5e1'}
        strokeWidth="1.35"
      />

      {/* Televízió világító 3D képernyője */}
      <rect
        x="20.3"
        y="38.2"
        width="20.4"
        height="14.2"
        rx="3.1"
        fill={`url(#${id}-tvscreen)`}
        stroke={isGreen ? '#ecfdf5' : '#94a3b8'}
        strokeOpacity="0.7"
        strokeWidth="0.9"
      />
      {/* Képernyő átlós 3D üvegfénye */}
      <path
        d="M21.4 42.8L26.8 38.8H23.2C22.1 38.8 21.4 39.5 21.4 40.6V42.8Z"
        fill="#ffffff"
        fillOpacity="0.38"
      />
      {/* Élő EKG / egészség-jel a TV képernyőjén */}
      <path
        d="M22.2 45.6H25.7L27.5 41.7L30.2 49.1L32.8 43.0L34.5 45.6H38.6"
        stroke="#ffffff"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Oldalsó 3D gombok a mini TV-n */}
      <circle cx="43.5" cy="42.4" r="1.25" fill={isGreen ? '#a7f3d0' : '#e2e8f0'} />
      <circle cx="43.5" cy="46.6" r="1.25" fill={isGreen ? '#6ee7b7' : '#94a3b8'} />

      {/* Két aranyos 3D kis kéz, amellyel a doktor két oldalról fogja a TV-t */}
      <ellipse
        cx="17.4"
        cy="46.2"
        rx="3.5"
        ry="3.1"
        fill={`url(#${id}-hand)`}
        stroke={isGreen ? '#064e3b' : '#7c2d12'}
        strokeOpacity="0.65"
        strokeWidth="1.05"
      />
      <ellipse
        cx="46.6"
        cy="46.2"
        rx="3.5"
        ry="3.1"
        fill={`url(#${id}-hand)`}
        stroke={isGreen ? '#064e3b' : '#7c2d12'}
        strokeOpacity="0.65"
        strokeWidth="1.05"
      />
    </svg>
  );
};

export interface TvDoctorFullscreenHudProps {
  isFullscreen: boolean;
  doctorEnabled: boolean;
  handled: boolean;
  status: TvDoctorActiveStatus | null;
  showClock: boolean;
  clockNode: React.ReactNode;
}

const PHASE_STYLES: Record<
  TvDoctorStatusPhase,
  { border: string; dot: string; titleColor: string }
> = {
  loading: {
    border: 'border-cyan-400/50',
    dot: 'bg-cyan-300',
    titleColor: 'text-cyan-200',
  },
  buffering: {
    border: 'border-amber-400/55',
    dot: 'bg-amber-300',
    titleColor: 'text-amber-200',
  },
  repair: {
    border: 'border-emerald-400/55',
    dot: 'bg-emerald-300',
    titleColor: 'text-emerald-200',
  },
  retry: {
    border: 'border-amber-400/60',
    dot: 'bg-amber-300',
    titleColor: 'text-amber-200',
  },
  error: {
    border: 'border-rose-400/60',
    dot: 'bg-rose-400',
    titleColor: 'text-rose-200',
  },
  verifying: {
    border: 'border-emerald-400/60',
    dot: 'bg-emerald-300',
    titleColor: 'text-emerald-200',
  },
};

/**
 * Teljes képernyős jobb felső sarok HUD:
 *  - Az óra ELŐTT (bal oldalán), az órával pontosan AZONOS méretben (`h-14`)
 *    mindig megjelenik a 3D TV Doktor ikon (zöldben, ha a tartalmat már kezelte).
 *  - Közvetlenül a doktorikon ALATT kisméretű, részben átlátszó állapotablak
 *    nyílik ki kizárólag akkor, amikor a TV Doktor ténylegesen dolgozik, majd
 *    a feladat végeztével automatikusan eltűnik.
 */
export const TvDoctorFullscreenHud: React.FC<TvDoctorFullscreenHudProps> = ({
  isFullscreen,
  doctorEnabled,
  handled,
  status,
  showClock,
  clockNode,
}) => {
  if (!isFullscreen) return null;

  const activeStatus = doctorEnabled ? status : null;
  const phaseStyle = activeStatus ? (PHASE_STYLES[activeStatus.phase] || PHASE_STYLES.repair) : null;

  const content = (
    <div
      data-fullscreen-top-right=""
      className="fixed top-3 right-3 flex flex-col items-end pointer-events-none select-none"
      style={{ zIndex: 2147483002 }}
    >
      {/* Felső sor: a 3D doktorikon közvetlenül az óra előtt, az órával azonos h-14 méretben */}
      <div data-fullscreen-top-right-row="" className="flex items-center justify-end gap-2">
        <div
          data-fullscreen-doctor-icon=""
          data-doctor-handled={handled && doctorEnabled ? 'true' : 'false'}
          data-doctor-color={handled && doctorEnabled ? 'green' : 'neutral'}
          data-doctor-active={activeStatus ? 'true' : 'false'}
          aria-hidden="true"
          className={`box-border flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-black/65 p-0.5 pointer-events-none ${
            handled && doctorEnabled
              ? 'border border-emerald-400/60 shadow-[0_4px_16px_rgba(16,185,129,0.42)]'
              : 'border border-slate-500/35 shadow-[0_4px_14px_rgba(0,0,0,0.55)]'
          }`}
        >
          <TvDoctorIcon
            handled={handled && doctorEnabled}
            active={Boolean(activeStatus)}
            disabled={!doctorEnabled}
            className="h-full w-full"
          />
        </div>
        {showClock && clockNode}
      </div>

      {/* Kisméretű, részben átlátszó állapotablak közvetlenül az óra előtti doktorikon alatt */}
      {activeStatus && phaseStyle && (
        <div
          data-tv-doctor-status-window=""
          data-doctor-phase={activeStatus.phase}
          role="status"
          aria-live="polite"
          className={`mt-1.5 w-[15.5rem] max-w-[19rem] rounded-2xl border ${phaseStyle.border} bg-[#061226]/78 px-3 py-2 shadow-[0_10px_24px_rgba(0,0,0,0.72),inset_0_1px_0_rgba(255,255,255,0.14)] pointer-events-none`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
              <span className={`h-2.5 w-2.5 rounded-full ${phaseStyle.dot} animate-pulse`} />
            </span>
            <span className={`truncate text-xs font-extrabold tracking-wide ${phaseStyle.titleColor}`}>
              {activeStatus.title}
            </span>
          </div>
          {activeStatus.detail && (
            <p className="mt-0.5 truncate text-[11px] font-semibold leading-snug text-slate-100/95">
              {activeStatus.detail}
            </p>
          )}
        </div>
      )}
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(content, document.body);
  }
  return content;
};
