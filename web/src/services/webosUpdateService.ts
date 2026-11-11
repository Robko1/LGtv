export interface WebOSReleaseInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  ipkUrl: string | null;
}

import { WEB_VERSION } from '../appVersion';

const CURRENT_WEBOS_VERSION = WEB_VERSION;
// Nyilvánosan csak a verziószám olvasható; az IPK és a Release privát marad.
const VERSION_URL = 'https://raw.githubusercontent.com/Robko1/LGtv/main/version.txt';

function compareVersions(a: string, b: string): number {
  const left = a.replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * A TV csak a publikus version.txt fájl egyetlen verziószámát olvassa.
 * Az IPK és a privát Robko1/Ipk Release nem kerül nyilvánosságra.
 */
export async function checkLatestWebOSRelease(): Promise<WebOSReleaseInfo> {
  const response = await fetch(VERSION_URL, {
    method: 'GET',
    headers: { Accept: 'text/plain' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'A nyilvános verziófájl még nem érhető el. Futtasd le sikeresen az IPK buildet.'
        : `A verzióellenőrzés sikertelen (HTTP ${response.status}).`,
    );
  }

  const latestVersion = (await response.text()).trim().replace(/^v/i, '');
  // Pontosan három, csak számjegyekből álló verziórész engedélyezett.
  if (!/^\d+\.\d+\.\d+$/.test(latestVersion)) {
    throw new Error('A nyilvános verziófájl tartalma hibás; csak háromrészes verziószám lehet benne.');
  }

  return {
    currentVersion: CURRENT_WEBOS_VERSION,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, CURRENT_WEBOS_VERSION) > 0,
    // Nincs nyilvános Release vagy IPK-hivatkozás.
    releaseUrl: 'https://github.com/Robko1/LGtv',
    ipkUrl: null,
  };
}
