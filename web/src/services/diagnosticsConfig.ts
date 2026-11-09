/**
 * 2.5.406 – A KÉZI HIBA NAPLÓ CSAK KÉZI INDÍTÁSRA INDUL.
 *
 * A felhasználó kifejezett kérése: „az automatikus kézi hiba naplózást
 * állítsd le, csak kézi indítás legyen”. A 2.5.397 óta bekapcsolt
 * `TEST_STARTUP_DIAGNOSTICS` (IPK-induláskor automatikusan gyűjtő napló)
 * ezért KI van kapcsolva. A SÁRGA gombos kézi napló, a TV Doktor napló és
 * minden hibakezelés változatlanul működik; az automata boot-diagnosztikai
 * figyelők (`startupDiagnostics.ts`) sem futnak, ha a napló nincs kézzel
 * elindítva – ez az IPK indulását is gyorsítja.
 *
 * A `diagnosticsBootstrap.ts` már NEM is hívja a
 * `startAutomaticTestLogging()`-ot; csak a passzív crash-handlereket
 * telepíti, amelyek naplózás nélkül nem írnak semmit.
 */
export const TEST_STARTUP_DIAGNOSTICS = false;
