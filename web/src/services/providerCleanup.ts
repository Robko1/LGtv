/*
 * EGY TÖRÖLT SZOLGÁLTATÓ MINDEN ADATÁNAK ELTÁVOLÍTÁSA.
 *
 * Korábban a szolgáltató törlése csak az ÉPPEN AKTÍV szolgáltató katalógusát
 * törölte. Egy nem aktív szolgáltató törlésekor a több tíz MB-os csatorna-,
 * film- és sorozatlista, a nyers M3U, a kedvencek, a csatornasorrend, a
 * TV Doktor tanult memóriája és a műsorújság is a készüléken maradt – a
 * tárhely fogyott, a felület pedig semmit nem mutatott belőle.
 *
 * Itt minden szolgáltatóhoz kötött adat EGY helyen, a szolgáltató SAJÁT
 * azonosítójával törlődik. A művelet soha nem nyúl más szolgáltató adataihoz
 * és a készülékszintű beállításokhoz (párosítás, nyelv, megjelenés).
 */
import { clearContentAsync, removeRawPlaylist } from './contentStore';
import { clearProviderGuideStorage } from './epgGuide';
import { providerScopePrefix } from './providerScope';
import { storageService } from './storageService';
import { clearTvDoctorMemory } from './tvDoctor';
import { clearTvDoctorCloudQueue } from './tvDoctorCloud';
import { clearRemovedVod } from './vodRemovals';

/**
 * A szolgáltatói névtérben tárolt kulcsok (előtag nélkül).
 *
 * A legelső szolgáltató („régi tulajdonos”) kulcsai ELŐTAG NÉLKÜL vannak a
 * tárban, ezért ott nem lehet előtag alapján söpörni: a készülékszintű
 * kulcsok (beállítások, párosítás) ugyanott élnek. Náluk ezt a tételes
 * listát töröljük.
 */
const PROVIDER_SCOPED_KEYS = [
  'iptv_rt_tv_doctor_v2',
  'iptv_rt_tv_doctor_sync_v2',
  'iptv_rt_tv_doctor_baseline_v1',
  'iptv_rt_tv_doctor_recent_v1',
  'iptv_rt_tv_doctor_hu_scope_v1',
  'iptv_rt_tv_doctor_central_profiles_v1',
  'iptv_rt_live-format-memory-v1',
  'iptv_rt_live-format',
  'iptv_rt_folders_v1',
  'iptv_rt_history_v1',
  'iptv_rt_ui_state_v1',
];

function removeScopedLocalKeys(providerId: string): void {
  if (typeof localStorage === 'undefined') return;
  const prefix = providerScopePrefix(providerId);
  try {
    for (const key of PROVIDER_SCOPED_KEYS) localStorage.removeItem(prefix + key);
  } catch { /* a tárhely hibája nem akadályozhatja a törlést */ }
  if (!prefix) return;
  // Saját előtagú névtér: minden, ami ezzel kezdődik, ehhez a szolgáltatóhoz tartozik.
  try {
    const contentPrefix = `iptv_rt_${prefix}`;
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key && (key.startsWith(prefix) || key.startsWith(contentPrefix))) localStorage.removeItem(key);
    }
  } catch { /* nem kritikus */ }
}

/**
 * A törölt szolgáltató összes adatának eltávolítása.
 *
 * FONTOS A SORREND: a hívó ELŐBB vált át a megmaradó szolgáltatóra (vagy az
 * üres állapotra), és csak utána hívja ezt. A névtér-váltás ugyanis a régi
 * szolgáltató függő írásait még kiüríti a saját kulcsaiba – ha előbb
 * törölnénk, a váltás visszaírná a törölt adatot.
 */
export async function purgeProviderData(providerId: string): Promise<void> {
  const id = String(providerId || '').trim();
  if (!id) return;
  /*
   * Ha a törölt szolgáltató névtere megegyezik a jelenlegivel (az utolsó
   * szolgáltató törlése után a „nincs szolgáltató” állapot ugyanazt az
   * előtag nélküli névteret látja), a MEMÓRIÁBAN lévő tanult adatot is el
   * kell dobni, különben a következő mentés visszaírná.
   */
  if (providerScopePrefix() === providerScopePrefix(id)) {
    try { clearTvDoctorMemory(); } catch { /* nem kritikus */ }
    try { clearTvDoctorCloudQueue(); } catch { /* nem kritikus */ }
  }
  storageService.clearLastChannel(id);
  storageService.clearProviderSettings(id);
  storageService.clearChannelOrder(id);
  storageService.clearDeletedChannels(id);
  try { clearRemovedVod(id); } catch { /* nem kritikus */ }
  removeScopedLocalKeys(id);
  // A nagy listák (IndexedDB) – megvárva, hogy a hívó tudja, mikor végzett.
  try { await clearContentAsync(id); } catch { /* a naplóban ott a valódi ok */ }
  try { await removeRawPlaylist(id); } catch { /* nem kritikus */ }
  try { await clearProviderGuideStorage(id); } catch { /* nem kritikus */ }
  // A katalógus törlése közben létrejött jelzők is ehhez a névtérhez tartoznak.
  removeScopedLocalKeys(id);
}
