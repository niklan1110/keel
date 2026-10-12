import dns from 'node:dns/promises';
import net from 'node:net';
import { isLocalAddress, parseNetworks } from '../lib/net.js';
import { isPrivateUrl } from './settings.js';

/**
 * Requests keel-auth makes to sign-in providers (discovery, keys, tokens,
 * user info). The URLs come from project settings and from the provider's
 * discovery document, so they are held to a few rules:
 * - https only. Plain http is allowed only when the admin turned on
 *   `allowHttp` for that provider, and only to an address on your own
 *   network (a homelab identity provider on the LAN).
 * - No user:password@ in URLs.
 * - Redirects are followed only for GET, at most twice, and only within the
 *   same origin.
 * - A short timeout and a size cap on the response.
 */

export class ProviderFetchError extends Error {}

export type FetchPolicy = { allowHttp: boolean };

export const FETCH_TIMEOUT_MS = 8000;
export const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 2;

const privateNetworks = parseNetworks('private');
/**
 * Link-local addresses are on your own network too, but that's where cloud
 * instance metadata lives (169.254.169.254, also behind names such as
 * instance-data.ec2.internal), which no identity provider needs.
 */
const linkLocal = parseNetworks('169.254.0.0/16,fe80::/10');

/** True when every address the name resolves to is on your own network, and none is link-local. */
async function onOwnNetwork(url: URL): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs: string[];
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      // Unresolvable here: the request itself will fail. A LAN-only name still counts as yours.
      return isPrivateUrl(url.href);
    }
  }
  if (!addrs.length || addrs.some((a) => isLocalAddress(a, linkLocal))) return false;
  return isPrivateUrl(url.href) || addrs.every((a) => isLocalAddress(a, privateNetworks));
}

/** Checks a URL the browser is sent to (no DNS lookup: the browser resolves it, not us). */
export function checkBrowserUrl(raw: unknown, policy: FetchPolicy, what: string): URL {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new ProviderFetchError(`${what} is not a valid URL`);
  }
  if (u.username || u.password) throw new ProviderFetchError(`${what} must not contain a user name or password`);
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && policy.allowHttp) return u;
  throw new ProviderFetchError(`${what} must use https`);
}

/** Checks a URL keel-auth itself requests. */
export async function checkFetchUrl(raw: unknown, policy: FetchPolicy, what: string): Promise<URL> {
  const u = checkBrowserUrl(raw, policy, what);
  if (u.protocol === 'http:' && !(await onOwnNetwork(u))) {
    throw new ProviderFetchError(`${what} uses plain http but is not on your own network; use https`);
  }
  return u;
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) throw new ProviderFetchError('provider response is too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ProviderFetchError('provider response is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type ProviderResponse = { status: number; ok: boolean; body: any };

/** Fetches JSON from a provider under the rules above. The body is null when it isn't JSON. */
export async function providerFetch(
  raw: string,
  policy: FetchPolicy,
  what: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string | URLSearchParams } = {},
): Promise<ProviderResponse> {
  let target = await checkFetchUrl(raw, policy, what);
  for (let hops = 0; ; hops++) {
    let res: Response;
    try {
      res = await fetch(target, {
        method: init.method || 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'keel-auth', ...(init.headers || {}) },
        body: init.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      const reason = (e as Error).name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      throw new ProviderFetchError(`${what} ${reason}`);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      if ((init.method && init.method !== 'GET') || hops >= MAX_REDIRECTS) throw new ProviderFetchError(`${what} redirected`);
      const next = new URL(location, target);
      if (next.origin !== target.origin) throw new ProviderFetchError(`${what} redirected to another host`);
      target = await checkFetchUrl(next.href, policy, what);
      continue;
    }
    const text = await readCapped(res);
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, ok: res.ok, body };
  }
}
