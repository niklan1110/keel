/**
 * Content types of stored files. What an uploader declares is untrusted, so
 * Keel keeps only a well-formed `type/subtype` (RFC 6838 names, lowercased),
 * plus a charset for text types, and stores, checks and serves exactly that
 * value. Anything else is refused: lists such as `image/png, text/html`,
 * control characters, or malformed parameters. Other parameters are dropped.
 */

/** RFC 6838 restricted-name, lowercased. */
const NAME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
/** RFC 9110 token (parameter names and unquoted values). */
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Quoted parameter value without escapes. */
const QUOTED_RE = /^"([\x20\x21\x23-\x5b\x5d-\x7e]*)"$/;
/** IANA charset names: letters, digits and a little punctuation. */
const CHARSET_RE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,39}$/;

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export type ContentType = {
  /** `type/subtype`, lowercased. */
  essence: string;
  type: string;
  subtype: string;
  charset: string | null;
  /** What Keel stores and serves: the essence, plus `;charset=…` for text types. */
  value: string;
};

export function parseContentType(raw: unknown): ContentType | null {
  if (typeof raw !== 'string' || raw.length > 255) return null;
  // Visible ASCII, spaces and tabs only. A comma would make it a list of types.
  if (/[^\x20-\x7e\t]/.test(raw) || raw.includes(',')) return null;
  const [head, ...params] = raw.split(';');
  const m = /^[ \t]*([^/]+)\/([^/]+?)[ \t]*$/.exec(head);
  if (!m) return null;
  const type = m[1].toLowerCase();
  const subtype = m[2].toLowerCase();
  if (!NAME_RE.test(type) || !NAME_RE.test(subtype)) return null;
  let charset: string | null = null;
  for (const p of params) {
    if (!p.trim()) continue; // "text/plain;" is allowed
    const eq = p.indexOf('=');
    if (eq < 0) return null;
    const name = p.slice(0, eq).trim();
    let value = p.slice(eq + 1).trim();
    if (!TOKEN_RE.test(name)) return null;
    const quoted = QUOTED_RE.exec(value);
    if (quoted) value = quoted[1];
    else if (!TOKEN_RE.test(value)) return null;
    if (type === 'text' && charset === null && name.toLowerCase() === 'charset' && CHARSET_RE.test(value)) charset = value;
  }
  const essence = `${type}/${subtype}`;
  return { essence, type, subtype, charset, value: charset ? `${essence};charset=${charset}` : essence };
}

/** The normalized content type, or null if it isn't a single valid one. */
export function normalizeContentType(raw: unknown): string | null {
  return parseContentType(raw)?.value ?? null;
}

/** Whether a bucket's allow list (exact types or `type/*`) accepts the type. Invalid types never match. */
export function mimeAllowed(allowed: string[] | null, contentType: string): boolean {
  const ct = parseContentType(contentType);
  if (!ct) return false;
  if (!allowed || !allowed.length) return true;
  return allowed.some((a) => {
    const p = String(a).split(';')[0].trim().toLowerCase();
    return p === ct.essence || (p.endsWith('/*') && p.slice(0, -2) === ct.type);
  });
}

/** Types a browser displays (or downloads) without running anything from the file. */
const PASSIVE_TYPES = new Set([
  'text/plain',
  'text/csv',
  'application/json',
  'application/pdf',
  'application/octet-stream',
  // fonts
  'application/font-woff',
  'application/font-woff2',
  'application/x-font-woff',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/font-sfnt',
  'application/vnd.ms-fontobject',
  // archives
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-bzip2',
  'application/x-xz',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/zstd',
]);
const PASSIVE_FAMILIES = new Set(['image', 'audio', 'video', 'font']);

/**
 * Whether a file of this type is safe to serve as-is from the API's origin.
 * Everything else (HTML, SVG, XML, scripts, and any type Keel doesn't know)
 * is served with SANDBOX_CSP.
 */
export function isPassiveType(contentType: unknown): boolean {
  const ct = parseContentType(contentType);
  if (!ct) return false;
  if (PASSIVE_TYPES.has(ct.essence)) return true;
  // Images, audio, video and fonts, except the ones that are really markup (SVG and other XML).
  return PASSIVE_FAMILIES.has(ct.type) && !/svg|xml|html|script/.test(ct.subtype);
}

/** No script, no plugins, no forms, nothing loaded: a file opened directly can only display. */
export const SANDBOX_CSP = "sandbox; default-src 'none'";
