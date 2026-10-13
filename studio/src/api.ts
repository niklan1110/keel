export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public body?: any,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

// The session is an HttpOnly cookie that scripts can't read. Older Studio
// versions kept a token in localStorage; it's no longer used.
try {
  localStorage.removeItem('keel.studio.token');
} catch {
  /* storage unavailable */
}

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { raw?: BodyInit; contentType?: string } = {}): Promise<T> {
  // Studio refuses API calls without this header: other sites can't send it
  // along with the session cookie (cross-site request forgery).
  const headers: Record<string, string> = { 'X-Keel-Studio': '1' };
  let payload: BodyInit | undefined;
  if (opts.raw !== undefined) {
    payload = opts.raw;
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Studio is unreachable. Check that keel-studio is running.', 'network');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.endsWith('/login')) onUnauthorized();
    throw new ApiError(res.status, data?.message || `Request failed (${res.status})`, data?.error, data);
  }
  return data as T;
}

export const get = <T = any>(path: string) => api<T>('GET', path);
export const post = <T = any>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const put = <T = any>(path: string, body?: unknown) => api<T>('PUT', path, body ?? {});
export const patch = <T = any>(path: string, body?: unknown) => api<T>('PATCH', path, body ?? {});
export const del = <T = any>(path: string, body?: unknown) => api<T>('DELETE', path, body ?? {});

export const enc = encodeURIComponent;
