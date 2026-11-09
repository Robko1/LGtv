/**
 * 2.5.406 – A KÉZI HIBA NAPLÓ CSAK KÉZI INDÍTÁSRA INDUL.
 *
 * A korábbi, 2.5.397 óta élő automata naplóindítást a felhasználó kérésére
 * KIKAPCSOLTUK: az IPK indulásakor nem gyűjtünk automatikusan, nem írunk
 * localStorage-t és nem futnak boot-diagnosztikai figyelők. A SÁRGA gombos
 * kézi indítás (startManualLogging) változatlan; ekkor a már telepített
 * crash-handlerek a JS-hibákat is a naplóba írják.
 *
 * Ez a modul továbbra is a fő alkalmazásmodulok importja ELŐTT fut, de
 * kizárólag a passzív eseményfigyelőket telepíti – azok naplózás nélkül
 * azonnal visszatérnek (appLogCritical: `if (!loggingEnabled) return;`).
 */
import { installCrashHandlers } from './appLog';

installCrashHandlers();
