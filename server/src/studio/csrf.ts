/**
 * Studio's browser session: an HttpOnly cookie that page scripts can't
 * read, so a script injected into Studio (or into the documentation it
 * serves on the same origin) can't take the session away. Cookies are sent
 * by the browser on its own, so every API call must also carry the
 * X-Keel-Studio header, which another site can't add without a CORS
 * preflight that Studio never allows, and requests whose Origin or
 * Sec-Fetch-Site says they came from another site are refused.
 */

export const SESSION_COOKIE = 'keel_studio_session';
export const STUDIO_HEADER = 'x-keel-studio';

type Headers = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim();

/**
 * Why a request to Studio's API looks forged, or null. `hosts` are the
 * places this request may have been made from: its Host, the name a
 * trusted proxy forwarded (both with any port), and the names Studio is
 * configured to be reached by (KEEL_STUDIO_HOSTS, the public address),
 * which match on any port, for proxies that rewrite the Host header.
 */
export function csrfProblem(req: { method?: string; url?: string; headers: Headers }, hosts: string[]): string | null {
  const path = (req.url || '/').split('?')[0];
  // Download links are opened by the browser itself and carry their own token.
  if (!path.startsWith('/api/') || path.startsWith('/api/download/')) return null;
  if (first(req.headers[STUDIO_HEADER]) !== '1') return 'Studio API requests need the X-Keel-Studio header.';
  const site = first(req.headers['sec-fetch-site']);
  if (site && site !== 'same-origin' && site !== 'none') return 'Requests from another site are not accepted.';
  const origin = first(req.headers.origin);
  if (origin !== undefined) {
    let u: URL | null = null;
    try {
      u = new URL(origin);
    } catch {
      u = null;
    }
    const ok = !!u && hosts.some((h) => {
      const name = h.toLowerCase();
      return name === u!.host.toLowerCase() || (!name.includes(':') && name === u!.hostname.toLowerCase());
    });
    if (!ok) return 'Requests from another site are not accepted.';
  }
  return null;
}

export function sessionCookie(token: string, maxAgeS: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/api; Max-Age=${maxAgeS}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * Whether the browser reached Studio over https (then the cookie is
 * Secure). Plain http on the LAN must work too, where a Secure cookie
 * would be dropped.
 */
export function browserUsesHttps(headers: Headers, trustedProxy: boolean): boolean {
  const origin = first(headers.origin);
  if (origin) return origin.toLowerCase().startsWith('https://');
  return trustedProxy && first(headers['x-forwarded-proto'])?.toLowerCase() === 'https';
}
