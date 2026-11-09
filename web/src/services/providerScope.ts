/**
 * Közös szolgáltató-névtér a szolgáltatófüggő helyi emlékezethez.
 *
 * A régi, egyetlen szolgáltatóhoz tartozó adatok kulcsait változatlanul hagyjuk:
 * az első aktív szolgáltató lesz a visszafelé kompatibilis tulajdonos. Minden
 * további szolgáltató külön névteret kap, így a régi mentés nem vész el, de
 * két azonos nevű / azonos stream-ID-jű csatorna sem osztozik az emlékezeten.
 */
const LEGACY_OWNER_KEY = 'iptv_rt_provider_scope_legacy_owner_v1';

let activeProviderId = '';
let legacyOwnerId: string | null = null;

function readLegacyOwner(): string | null {
  if (legacyOwnerId) return legacyOwnerId;
  try {
    const value = typeof localStorage !== 'undefined'
      ? String(localStorage.getItem(LEGACY_OWNER_KEY) || '').trim()
      : '';
    legacyOwnerId = value || null;
  } catch {
    legacyOwnerId = null;
  }
  return legacyOwnerId;
}

export function setActiveProviderScope(providerId: string | null | undefined): void {
  const next = String(providerId || '').trim();
  activeProviderId = next;
  if (!next || readLegacyOwner()) return;
  legacyOwnerId = next;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LEGACY_OWNER_KEY, next);
  } catch {
    // A névtér memóriában akkor is működik, ha a webOS tárhelye nem írható.
  }
}

/** Az aktív szolgáltató prefixe; a régi tulajdonos prefix nélkül marad. */
export function providerScopePrefix(providerId?: string | null): string {
  const id = String(providerId === undefined ? activeProviderId : providerId || '').trim();
  if (!id) return '';
  const owner = readLegacyOwner();
  if (!owner || id === owner) return '';
  return `provider:${encodeURIComponent(id)}:`;
}

/** A provider-specifikus tár kulcsa. */
export function scopedProviderKey(key: string, providerId?: string | null): string {
  return providerScopePrefix(providerId) + key;
}

/** Teszteknek és explicit alkalmazás-visszaállításnak. */
export function activeProviderScopeId(): string {
  return activeProviderId;
}
