/**
 * A tesztidőszaki napló indítása a fő alkalmazásmodulok (különösen az App)
 * kiértékelése ELŐTT. Így az import közben keletkező JavaScript-hibák is
 * bekerülnek a naplóba, a korábbi HTML-indulási jeleket pedig a startup
 * diagnosztika később hozzáolvassa.
 */
import { installCrashHandlers, startAutomaticTestLogging } from './appLog';

installCrashHandlers();
startAutomaticTestLogging();
