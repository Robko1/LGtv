/**
 * 2.5.397: a SÁRGA gombos kézi hiba napló az IPK/app indulásakor
 * AUTOMATIKUSAN elkezd gyűjteni – nem kell előtte megnyitni az ablakot.
 *
 * A 2026-11-08 18:41-es TV-fotó utáni kérés: „a kézi hiba napló automatikusan
 * kezdje gyűjteni az adatokat miután IPK-t indítom, hogy lássuk mi az ami
 * sokáig fent tartsa a takaró képet, és az LG TV / webOS mit ellenőriz
 * pontosan”. A `diagnosticsBootstrap.ts` ezért már a fő modulok importja ELŐTT
 * elindítja a naplózást; a `startupDiagnostics.ts` és a `main.tsx` ettől
 * kezdve az IPK első milliszekundumaitól írja a lépéseket.
 *
 * A napló továbbra is a SÁRGA ablakból küldhető el; sikeres küldés után az
 * adott munkamenetben nem indul újra magától (`discardSentAppLog`).
 */
export const TEST_STARTUP_DIAGNOSTICS = true;
