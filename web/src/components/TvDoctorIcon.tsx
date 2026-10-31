import React from 'react';
import { createPortal } from 'react-dom';
import { TV_DOCTOR_ICON_DATA_URL } from '../generatedMenuIcons';

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

/**
 * TV Doktor ikon (2.5.229): a felhasználó által küldött képből készült kör
 * alakú embléma – a doktor a fejével együtt, körbevágva. A kép beágyazott
 * data-URL, tehát külső hálózati kérés nincs.
 *
 * - `handled = true`: zöld állapotgyűrű és derengés (a TV Doktor már kezelte).
 * - `handled = false`: ezüst-pala gyűrű (készenlét).
 * - `disabled = true`: halvány megjelenés (kikapcsolva a Rendszer menüben).
 */
export const TvDoctorIcon: React.FC<TvDoctorIconProps> = ({
  handled = true,
  active = false,
  disabled = false,
  className = 'w-7 h-7',
}) => {
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
      {/*
        2.5.235: A TV-fotók szerint az állapotgyűrű eddig a kép FÖLÉ került,
        ezért a doktor fejét/vállát (ami a jelvény körén túlnyúlik) a zöld
        gyűrű „elvágta”, a margó nélküli (0–64) kép pedig kilógott a
        főoldali sor lekerekített helyéről. Javítás:
        - a derengés, az állapotgyűrű és a pulzáló kör a kép MÖGÉ kerül,
          így a doktor alakja természetesen takarja őket (a figura a gyűrű
          ELŐTT áll, semmi nem vágja el a fejét);
        - a kép belső margót kap (4px a 64-es dobozban), így az ikon
          hiánytalanul elfér a számára kijelölt helyen.
        A kör középpontja/sugara a 176×176-os emblémaforrás jelvényköréhez
        igazítva: középpont (87, 97), sugár 76 → a 4/3 eltolású, 56-os
        méretű képen cx=31.7, cy=33.9, jelvénysugár≈24.2.
        Az SVG keret és a data-* jelzők változatlanok – a felület és a
        tesztek erre épülnek. Az állapot színe:
        zöld = a TV Doktor már kezelte, ezüst = készenlét, halvány = kikapcsolva.
      */}
      {/* Állapotjelző derengés az embléma köre mögött */}
      <circle
        cx="31.7"
        cy="33.9"
        r="25.8"
        fill={isGreen ? '#10b981' : '#64748b'}
        opacity={active ? 0.55 : 0.3}
      />
      {/* Állapotgyűrű a jelvény pereme körül – a kép MÖGÖTT, hogy a doktor
          feje/válla takarja, ne pedig fordítva */}
      <circle
        cx="31.7"
        cy="33.9"
        r="25.3"
        fill="none"
        stroke={isGreen ? '#34d399' : '#94a3b8'}
        strokeWidth="1.8"
        strokeOpacity="0.95"
      />
      {active && (
        <circle
          cx="31.7"
          cy="33.9"
          r="27"
          fill="none"
          stroke="#38bdf8"
          strokeWidth="1.5"
          className="animate-pulse"
        />
      )}
      <image
        href={TV_DOCTOR_ICON_DATA_URL}
        xlinkHref={TV_DOCTOR_ICON_DATA_URL}
        x="4"
        y="3"
        width="56"
        height="56"
        preserveAspectRatio="xMidYMid meet"
        opacity={disabled ? 0.8 : 1}
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
