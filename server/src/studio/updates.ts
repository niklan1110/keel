import { config } from '../lib/config.js';
import { log } from '../lib/log.js';

/**
 * "A new version is available" for Studio. Asks GitHub's public API for the
 * latest release of the repository the image was built from, at most once a
 * day and only while someone uses Studio. The request carries no cookie, token,
 * version, host name or ID: GitHub only sees that this server's address asked.
 * KEEL_UPDATE_CHECK=off turns it off. Development and edge builds don't check.
 */

const DAY_MS = 24 * 3600 * 1000;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export type UpdateStatus = {
  /** off: turned off; unavailable: not a release build; on: checking daily. */
  check: 'on' | 'off' | 'unavailable';
  latest: string | null;
  url: string | null;
};

/** [major, minor, patch] of a release version such as 0.2.0 or v0.2.0; null for anything else. */
export function releaseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = releaseVersion(candidate);
  const b = releaseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

let checkedAt = 0;
let found: { latest: string; url: string } | null = null;
let running = false;

async function check(repo: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'keel' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
  const url = typeof body.html_url === 'string' ? body.html_url : '';
  // Only a plain release with a link to its own page on GitHub is shown.
  if (body.draft || body.prerelease || !releaseVersion(tag) || !url.startsWith(`https://github.com/${repo}/releases/`)) {
    found = null;
    return;
  }
  found = isNewer(tag, config.version) ? { latest: tag.replace(/^v/, ''), url } : null;
}

/** What Studio shows. Starts a check in the background when one is due. */
export function updateStatus(now = Date.now()): UpdateStatus {
  const repo = config.release.sourceRepo;
  if (!config.release.updateCheck) return { check: 'off', latest: null, url: null };
  if (!REPO_RE.test(repo) || !releaseVersion(config.version)) return { check: 'unavailable', latest: null, url: null };
  if (!running && now - checkedAt >= DAY_MS) {
    running = true;
    checkedAt = now;
    check(repo)
      .catch((err) => log.warn('update check failed', { error: (err as Error).message }))
      .finally(() => {
        running = false;
      });
  }
  return { check: 'on', latest: found?.latest ?? null, url: found?.url ?? null };
}
