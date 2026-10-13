import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs/promises';
import net from 'node:net';
import { Readable } from 'node:stream';
import { normalizeIp } from './net.js';

/**
 * A small client for S3-compatible storage (AWS S3, Backblaze B2, Cloudflare
 * R2, MinIO, Wasabi, ...): just the calls backups need, signed with AWS
 * Signature Version 4 over fetch. Uploads go in parts of PART_SIZE, so
 * memory use stays at about one part however large the backup is.
 *
 * Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 */

export type S3Config = {
  /** https://s3.us-east-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, http://minio:9000, ... */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** https://endpoint/bucket/key (true) or https://bucket.endpoint/key (false). */
  pathStyle: boolean;
};

export type S3Object = { key: string; size: number; lastModified: string };

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

const EMPTY_SHA256 = crypto.createHash('sha256').digest('hex');
export const PART_SIZE = 16 * 1024 * 1024;
/** S3 allows 10,000 parts; leave room. */
const MAX_PARTS = 9000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;

const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as SigV4 wants it ("/" kept in paths when asked). */
function uriEncode(s: string, keepSlash = false): string {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? e.replace(/%2F/g, '/') : e;
}

export type SignInput = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  now: Date;
};

/** The headers to add to a request: x-amz-date, x-amz-content-sha256 and Authorization. */
export function signV4(i: SignInput): Record<string, string> {
  const amzDate = i.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  headers.host = i.url.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = i.payloadHash;
  const names = Object.keys(headers).sort();
  const query = [...i.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    i.method,
    // The path is already encoded once (S3 doesn't encode twice).
    i.url.pathname || '/',
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    i.payloadHash,
  ].join('\n');
  const scope = `${day}/${i.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': i.payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

const xmlText = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
    if (named[e.toLowerCase()]) return named[e.toLowerCase()];
    return String.fromCodePoint(e[1].toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)));
  });
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlText(m[1]) : '';
};

/** Checks the settings and returns a reason they can't work, or null. */
export function s3ConfigProblem(c: Partial<S3Config>): string | null {
  let u: URL;
  try {
    u = new URL(String(c.endpoint || ''));
  } catch {
    return 'The endpoint must be a URL, such as https://s3.us-east-1.amazonaws.com.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The endpoint must start with https:// (or http:// on your own network).';
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) return 'The endpoint is only the address, without a path, such as https://s3.us-east-1.amazonaws.com.';
  if (!c.bucket || !/^[a-z0-9][a-z0-9.\-_]{1,62}$/i.test(c.bucket)) return 'Enter the bucket name (3-63 letters, digits, dots and dashes).';
  if (!c.region || !/^[a-z0-9-]{1,40}$/i.test(c.region)) return 'Enter the region (such as us-east-1, or auto for Cloudflare R2).';
  if (!c.accessKeyId || !c.secretAccessKey) return 'Enter the access key ID and the secret access key.';
  return null;
}

/**
 * Addresses a backup target may never be: this container (loopback, "this
 * network"), link-local (cloud metadata at 169.254.169.254), multicast and
 * reserved ranges. Private LAN addresses are allowed: a MinIO or NAS on the
 * home network is a common target.
 */
const BLOCKED = new net.BlockList();
for (const [a, bits] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) BLOCKED.addSubnet(a, bits, 'ipv4');
for (const [a, bits] of [['::', 128], ['::1', 128], ['fe80::', 10], ['ff00::', 8]] as const) BLOCKED.addSubnet(a, bits, 'ipv6');

/** Keel's own services, by their names on its Docker networks: never a backup target. */
export const KEEL_SERVICES = ['keel-db', 'keel-db-tls', 'keel-docker', 'keel-gateway', 'keel-auth', 'keel-rest', 'keel-storage', 'keel-realtime', 'keel-functions', 'keel-imgproxy', 'keel-studio', 'keel-tunnel', 'keel-migrate', 'keel-secret'];

export type Lookup = (name: string) => Promise<string[]>;
const dnsLookup: Lookup = async (name) => (await dns.promises.lookup(name, { all: true })).map((a) => a.address);

const blocked = (ip: string) => {
  const a = normalizeIp(ip);
  return net.isIPv4(a) ? BLOCKED.check(a, 'ipv4') : net.isIPv6(a) ? BLOCKED.check(a, 'ipv6') : false;
};

/**
 * Why requests to this host are refused, or null. Checked before every
 * request, so a name can't be pointed somewhere else after the settings were
 * saved (short of a DNS answer changing between this check and the connection).
 */
export async function endpointProblem(hostname: string, lookup: Lookup = dnsLookup): Promise<string | null> {
  const host = normalizeIp(hostname).toLowerCase().replace(/\.$/, '');
  const refused = `Can't reach ${hostname}: backups are never sent to this machine's loopback or link-local addresses, or to Keel's own services.`;
  if (host === 'localhost' || host.endsWith('.localhost')) return refused;
  let addrs: string[];
  try {
    addrs = net.isIP(host) ? [host] : await lookup(host);
  } catch {
    return null; // the request itself reports that the name doesn't resolve
  }
  if (addrs.some(blocked)) return refused;
  // With a trailing dot the resolver doesn't try search domains.
  const own = (await Promise.all(KEEL_SERVICES.map((n) => lookup(`${n}.`).catch(() => [] as string[])))).flat().map(normalizeIp);
  if (addrs.some((a) => own.includes(normalizeIp(a)))) return refused;
  return null;
}

export class S3 {
  constructor(
    private c: S3Config,
    /** Tries per request; network errors and 5xx answers are retried. */
    private attempts = 4,
    /** Refuses hosts a backup must not go to (see endpointProblem). */
    private checkHost: (hostname: string) => Promise<string | null> = endpointProblem,
  ) {}

  private url(key: string, query: Record<string, string> = {}): URL {
    const base = new URL(this.c.endpoint);
    const path = key ? `/${uriEncode(key, true)}` : '/';
    const u = this.c.pathStyle ? new URL(`${base.origin}/${uriEncode(this.c.bucket)}${key ? path : ''}`) : new URL(`${base.protocol}//${this.c.bucket}.${base.host}${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  private async send(method: string, key: string, opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: Buffer } = {}): Promise<Response> {
    const url = this.url(key, opts.query);
    const problem = await this.checkHost(url.hostname);
    if (problem) throw new S3Error(problem, 403, 'endpoint_refused');
    const headers = { ...(opts.headers ?? {}) };
    const signed = signV4({
      method,
      url,
      headers,
      payloadHash: opts.body ? sha256(opts.body) : EMPTY_SHA256,
      accessKeyId: this.c.accessKeyId,
      secretAccessKey: this.c.secretAccessKey,
      region: this.c.region,
      now: new Date(),
    });
    let res: Response;
    try {
      // Redirects aren't followed: they could lead past the host check above.
      res = await fetch(url, { method, headers: { ...headers, ...signed }, body: opts.body as Uint8Array<ArrayBuffer> | undefined, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new S3Error(`Could not reach ${url.host}: ${cause?.code || cause?.message || (err as Error).message}`, 0, 'network');
    }
    if (res.status >= 300 && res.status < 400) {
      await res.arrayBuffer().catch(() => {});
      throw new S3Error(`The storage answered with a redirect (HTTP ${res.status}): check the endpoint and region.`, res.status, 'redirect');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = tag(text, 'Code') || `HTTP ${res.status}`;
      const msg = tag(text, 'Message');
      throw new S3Error(`${code}${msg ? `: ${msg}` : ''} (HTTP ${res.status})`, res.status, code);
    }
    return res;
  }

  /** Retries network errors and 5xx answers a few times. */
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const s = err instanceof S3Error ? err.status : 0;
        if (attempt >= this.attempts || (s !== 0 && s < 500)) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.retry(async () => void (await this.send('PUT', key, { body })).arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.retry(async () => void (await this.send('DELETE', key)).arrayBuffer());
  }

  /** Every object under the prefix. */
  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token = '';
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const xml = await this.retry(async () => (await this.send('GET', '', { query })).text());
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        out.push({ key: tag(m[1], 'Key'), size: Number(tag(m[1], 'Size')), lastModified: tag(m[1], 'LastModified') });
      }
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : '';
    } while (token);
    return out;
  }

  /** The object's bytes as a stream. */
  async get(key: string): Promise<Readable> {
    const res = await this.retry(() => this.send('GET', key));
    if (!res.body) throw new S3Error('Empty answer', res.status, 'empty');
    return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  }

  /** Uploads a file, in parts when it's large. */
  async uploadFile(key: string, file: string): Promise<void> {
    const fh = await fs.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const partSize = Math.max(PART_SIZE, Math.ceil(size / MAX_PARTS));
      const read = async (pos: number, len: number) => {
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, pos);
        if (bytesRead !== len) throw new Error('The backup file changed while it was uploaded.');
        return buf;
      };
      if (size <= partSize) return await this.put(key, await read(0, size));

      const created = await this.retry(async () => (await this.send('POST', key, { query: { uploads: '' } })).text());
      const uploadId = tag(created, 'UploadId');
      if (!uploadId) throw new S3Error('The storage did not start a multipart upload', 0, 'no_upload_id');
      try {
        const etags: string[] = [];
        for (let n = 1, pos = 0; pos < size; n++, pos += partSize) {
          const body = await read(pos, Math.min(partSize, size - pos));
          const res = await this.retry(async () => {
            const r = await this.send('PUT', key, { query: { partNumber: String(n), uploadId }, body });
            await r.arrayBuffer();
            return r;
          });
          etags.push(res.headers.get('etag') || '');
        }
        const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
        const done = await this.retry(async () => (await this.send('POST', key, { query: { uploadId }, body: Buffer.from(xml) })).text());
        // A 200 answer can still carry an error.
        if (/<Error>/.test(done)) throw new S3Error(`${tag(done, 'Code')}: ${tag(done, 'Message')}`, 200, tag(done, 'Code'));
      } catch (err) {
        await this.send('DELETE', key, { query: { uploadId } }).then((r) => r.arrayBuffer()).catch(() => {});
        throw err;
      }
    } finally {
      await fh.close();
    }
  }
}
