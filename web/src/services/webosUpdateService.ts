export interface WebOSReleaseInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  ipkUrl: string | null;
}

import { WEB_VERSION } from '../appVersion';

const CURRENT_WEBOS_VERSION = WEB_VERSION;
const RELEASE_API = 'https://api.github.com/repos/Robko1/LGtv/releases/latest';

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
 * Public release check only. LG webOS apps cannot silently install an IPK
 * from JavaScript; installation must be performed through a supported
 * webOS developer/deployment tool.
 */
export async function checkLatestWebOSRelease(): Promise<WebOSReleaseInfo> {
  const response = await fetch(RELEASE_API, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'Még nincs nyilvános GitHub Release ehhez az alkalmazáshoz.'
        : `A GitHub frissítés-ellenőrzése sikertelen (HTTP ${response.status}).`,
    );
  }

  const release = await response.json() as {
    tag_name?: string;
    html_url?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  };

  const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
  if (!latestVersion || !release.html_url) {
    throw new Error('A GitHub Release válasza hiányos.');
  }

  const ipk = (release.assets || []).find((asset) =>
    String(asset.name || '').toLowerCase().endsWith('.ipk'),
  );

  return {
    currentVersion: CURRENT_WEBOS_VERSION,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, CURRENT_WEBOS_VERSION) > 0,
    releaseUrl: release.html_url,
    ipkUrl: ipk?.browser_download_url || null,
  };
}
