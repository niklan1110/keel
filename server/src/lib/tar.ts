/**
 * Just enough of the POSIX tar format (ustar, with pax headers for long names
 * and large files) to stream a backup set in and out without holding it in
 * memory, and so a decrypted backup opens with any tar program.
 */

const BLOCK = 512;
const MAX_OCTAL_SIZE = 0o77777777777;

export type TarSource = {
  name: string;
  size: number;
  mtime?: Date;
  mode?: number;
  /** The file's bytes. Fewer than `size` are padded with zeros, more are cut off. */
  body: () => AsyncIterable<Buffer> | Iterable<Buffer>;
};

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, type: string, mtime: Date, mode: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(Math.min(size, MAX_OCTAL_SIZE), 12), 124, 'ascii');
  h.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  return h;
}

/** A pax record "<len> key=value\n", where len counts the whole record. */
function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  const restLen = Buffer.byteLength(rest);
  let len = restLen + 1;
  while (restLen + String(len).length !== len) len = restLen + String(len).length;
  return `${len}${rest}`;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** The tar stream of the given files, written one after the other. */
export async function* tarStream(files: AsyncIterable<TarSource> | Iterable<TarSource>): AsyncGenerator<Buffer> {
  for await (const f of files) {
    const mtime = f.mtime ?? new Date();
    const mode = f.mode ?? 0o600;
    const longName = Buffer.byteLength(f.name) > 99;
    if (longName || f.size > MAX_OCTAL_SIZE) {
      const pax = Buffer.from((longName ? paxRecord('path', f.name) : '') + (f.size > MAX_OCTAL_SIZE ? paxRecord('size', String(f.size)) : ''));
      yield header('PaxHeader', pax.length, 'x', mtime, 0o644);
      yield pax;
      yield padding(pax.length);
    }
    yield header(longName ? f.name.slice(-99).replace(/^[^/]*\//, '') : f.name, f.size, '0', mtime, mode);
    let left = f.size;
    for await (const chunk of f.body()) {
      if (left <= 0) break;
      const piece = chunk.length > left ? chunk.subarray(0, left) : chunk;
      left -= piece.length;
      yield piece;
    }
    while (left > 0) {
      const z = Buffer.alloc(Math.min(left, 64 * 1024));
      left -= z.length;
      yield z;
    }
    yield padding(f.size);
  }
  yield Buffer.alloc(2 * BLOCK);
}

/** Reads exact byte counts from a stream of chunks. */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  constructor(private it: AsyncIterator<Buffer>) {}

  /** Up to `max` bytes (at least one), or null at the end. */
  async some(max: number): Promise<Buffer | null> {
    if (!this.buf.length) {
      if (this.done) return null;
      const r = await this.it.next();
      if (r.done) {
        this.done = true;
        return null;
      }
      this.buf = Buffer.from(r.value);
      if (!this.buf.length) return this.some(max);
    }
    const out = this.buf.subarray(0, max);
    this.buf = this.buf.subarray(out.length);
    return out;
  }

  /** Exactly n bytes, or null when the stream ends first. */
  async exact(n: number): Promise<Buffer | null> {
    const parts: Buffer[] = [];
    let got = 0;
    while (got < n) {
      const b = await this.some(n - got);
      if (!b) return null;
      parts.push(b);
      got += b.length;
    }
    return Buffer.concat(parts);
  }
}

export type TarEntry = {
  name: string;
  size: number;
  /** '0' file, '5' folder, others as in tar. */
  type: string;
  /** Permission bits from the header. */
  mode: number;
  /** The entry's bytes; read it (or not) before asking for the next entry. */
  body: AsyncIterable<Buffer>;
};

function parseOctal(b: Buffer): number {
  const s = b.toString('ascii').replace(/[\0 ]+$/, '').trim();
  if (!/^[0-7]*$/.test(s)) throw new Error('This is not a tar archive (bad number).');
  return s ? Number.parseInt(s, 8) : 0;
}

/** Largest pax header read; Keel's own hold one path and one size. */
export const MAX_PAX_HEADER = 64 * 1024;

export function parsePax(data: Buffer): Record<string, string> {
  const bad = () => new Error('This is not a tar archive (bad pax header).');
  const out: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    if (sp < 0) break;
    const digits = data.subarray(at, sp).toString('ascii');
    if (!/^[1-9]\d{0,5}$/.test(digits)) throw bad();
    const len = Number(digits);
    if (sp + 1 >= at + len || at + len > data.length || data[at + len - 1] !== 0x0a) throw bad();
    const rec = data.subarray(sp + 1, at + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    at += len;
  }
  if (out.size !== undefined && (!/^\d{1,16}$/.test(out.size) || !Number.isSafeInteger(Number(out.size)))) throw bad();
  if (out.path !== undefined && (!out.path || out.path.includes('\0'))) throw bad();
  return out;
}

/** The entries of a tar stream, one at a time. */
export async function* readTar(src: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  const r = new ByteReader(src[Symbol.asyncIterator]());
  let pax: Record<string, string> = {};
  for (;;) {
    const h = await r.exact(BLOCK);
    if (!h) throw new Error('The archive ends without its end marker (cut short?).');
    if (h.every((b) => b === 0)) return;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== parseOctal(h.subarray(148, 156))) throw new Error('This is not a tar archive (bad header checksum).');
    const type = String.fromCharCode(h[156] || 0x30);
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    let name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (prefix && h.subarray(257, 262).toString('ascii') === 'ustar') name = `${prefix}/${name}`;
    let size = parseOctal(h.subarray(124, 136));
    if (pax.path) name = pax.path;
    if (pax.size) size = Number(pax.size);
    pax = {};

    let left = size;
    const body = (async function* () {
      while (left > 0) {
        const b = await r.some(Math.min(left, 64 * 1024));
        if (!b) throw new Error('The archive is cut short.');
        left -= b.length;
        yield b;
      }
    })();

    if (type === 'x') {
      if (size > MAX_PAX_HEADER) throw new Error('This is not a tar archive (pax header too large).');
      const data: Buffer[] = [];
      for await (const b of body) data.push(b);
      pax = parsePax(Buffer.concat(data));
    } else if (type !== 'g') {
      yield { name, size, type, mode: parseOctal(h.subarray(100, 108)) & 0o7777, body };
    }
    // Skip what the caller didn't read, and the padding.
    while (left > 0) {
      const b = await r.some(Math.min(left, 64 * 1024));
      if (!b) throw new Error('The archive is cut short.');
      left -= b.length;
    }
    if (size % BLOCK && !(await r.exact(BLOCK - (size % BLOCK)))) throw new Error('The archive is cut short.');
  }
}
