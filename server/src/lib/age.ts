import crypto from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Passphrase encryption in the age file format (https://c2sp.org/age), so a
 * backup can also be opened without Keel: `age -d keel-....tar.age > x.tar`.
 *
 *   header   age-encryption.org/v1, one scrypt stanza (the wrapped 16-byte
 *            file key), and an HMAC-SHA-256 over the header
 *   payload  a 16-byte nonce, then 64 KiB chunks sealed with
 *            ChaCha20-Poly1305; each chunk's nonce is its number and a flag
 *            on the last one, so reordering, cutting or appending is noticed
 *
 * Both directions are streams that hold about one chunk in memory.
 */

const VERSION_LINE = 'age-encryption.org/v1';
const SCRYPT_LABEL = 'age-encryption.org/v1/scrypt';
const CHUNK = 64 * 1024;
const TAG = 16;
/** age's own default: 256 MiB of memory and about a second, once per backup. */
export const DEFAULT_WORK_FACTOR = 18;
/** Files asking for more work than Keel itself uses are refused (each step up doubles the memory). */
export const MAX_WORK_FACTOR = DEFAULT_WORK_FACTOR;
const MAX_HEADER = 4096;

export class DecryptError extends Error {
  constructor(message = "The backup can't be decrypted: the passphrase is wrong or the file was changed or cut short.") {
    super(message);
    this.name = 'DecryptError';
  }
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

/** Unpadded base64 that re-encodes to the same text (age rejects anything else). */
function unb64(s: string): Buffer {
  if (!/^[A-Za-z0-9+/]*$/.test(s)) throw new DecryptError('This is not a valid age file (bad base64).');
  const b = Buffer.from(s, 'base64');
  if (b64(b) !== s) throw new DecryptError('This is not a valid age file (bad base64).');
  return b;
}

const hkdf = (ikm: Buffer, salt: Buffer, info: string) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32));

function scryptKey(passphrase: string, salt: Buffer, logN: number): Promise<Buffer> {
  const N = 2 ** logN;
  return new Promise((resolve, reject) =>
    crypto.scrypt(
      Buffer.from(passphrase, 'utf8'),
      Buffer.concat([Buffer.from(SCRYPT_LABEL), salt]),
      32,
      { N, r: 8, p: 1, maxmem: 2 * 128 * N * 8 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

function seal(key: Buffer, nonce: Buffer, plain: Buffer): Buffer {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function open(key: Buffer, nonce: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < TAG) throw new DecryptError();
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  try {
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
  } catch {
    throw new DecryptError();
  }
}

function chunkNonce(counter: number, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  n.writeUIntBE(counter, 5, 6); // bytes 0-10 are the counter; 2^48 chunks is plenty
  n[11] = last ? 1 : 0;
  return n;
}

/** Throws unless the passphrase is usable. */
export function checkPassphrase(passphrase: string | undefined): string {
  if (!passphrase) throw new Error('No backup passphrase is set (KEEL_BACKUP_PASSPHRASE or KEEL_BACKUP_PASSPHRASE_FILE).');
  if ([...passphrase].length < 12) throw new Error('The backup passphrase must be at least 12 characters.');
  return passphrase;
}

/** A stream that turns plaintext into an age file encrypted with the passphrase. */
export function encryptStream(passphrase: string, workFactor = DEFAULT_WORK_FACTOR): Transform {
  let payloadKey: Buffer;
  let pending: Buffer = Buffer.alloc(0);
  let counter = 0;
  return new Transform({
    construct(cb) {
      const fileKey = crypto.randomBytes(16);
      const salt = crypto.randomBytes(16);
      scryptKey(passphrase, salt, workFactor).then((wrapKey) => {
        const body = seal(wrapKey, Buffer.alloc(12), fileKey);
        const head = `${VERSION_LINE}\n-> scrypt ${b64(salt)} ${workFactor}\n${b64(body)}\n---`;
        const mac = crypto.createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(head).digest();
        const nonce = crypto.randomBytes(16);
        payloadKey = hkdf(fileKey, nonce, 'payload');
        this.push(Buffer.from(`${head} ${b64(mac)}\n`));
        this.push(nonce);
        cb();
      }, cb);
    },
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      // Keep at least one byte back: the last chunk is only known at the end.
      let at = 0;
      while (pending.length - at > CHUNK) {
        this.push(seal(payloadKey, chunkNonce(counter++, false), pending.subarray(at, at + CHUNK)));
        at += CHUNK;
      }
      pending = at ? Buffer.from(pending.subarray(at)) : pending;
      cb();
    },
    flush(cb: TransformCallback) {
      this.push(seal(payloadKey, chunkNonce(counter++, true), pending));
      cb();
    },
  });
}

/** Parses the header text (up to and including "--- <mac>"). */
function parseHeader(text: string) {
  const lines = text.split('\n');
  if (lines[0] !== VERSION_LINE) throw new DecryptError('This is not an age-encrypted Keel backup.');
  const stanza = lines[1]?.split(' ') ?? [];
  if (stanza[0] !== '->' || stanza[1] !== 'scrypt' || stanza.length !== 4) {
    throw new DecryptError('This backup was not encrypted with a passphrase (age scrypt), so Keel cannot open it.');
  }
  const salt = unb64(stanza[2]);
  if (salt.length !== 16 || !/^[1-9][0-9]?$/.test(stanza[3])) throw new DecryptError('This is not a valid age file.');
  const logN = Number(stanza[3]);
  if (logN > MAX_WORK_FACTOR) throw new DecryptError(`This backup asks for too much work to open (scrypt work factor ${logN}).`);
  // The body: full 64-column lines, then one shorter line.
  const bodyLines: string[] = [];
  let i = 2;
  for (; i < lines.length; i++) {
    if (lines[i].startsWith('---') || lines[i].startsWith('->')) break;
    bodyLines.push(lines[i]);
    if (lines[i].length < 64) {
      i++;
      break;
    }
  }
  const body = unb64(bodyLines.join(''));
  if (body.length !== 32) throw new DecryptError('This is not a valid age file.');
  const macLine = lines[i] ?? '';
  if (i !== lines.length - 1 || !macLine.startsWith('--- ')) {
    throw new DecryptError('This backup has more than one way to open it; Keel only opens passphrase-encrypted backups.');
  }
  const mac = unb64(macLine.slice(4));
  const macked = text.slice(0, text.length - macLine.length + 3);
  return { salt, logN, body, mac, macked };
}

/** A stream that turns an age file encrypted with the passphrase back into plaintext. */
export function decryptStream(passphrase: string): Transform {
  let head: Buffer = Buffer.alloc(0);
  let headerDone = false;
  let payloadKey: Buffer | null = null;
  let pending: Buffer = Buffer.alloc(0);
  let counter = 0;

  const drain = (t: Transform) => {
    if (!payloadKey) return;
    let at = 0;
    // A full chunk with more after it is never the last one.
    while (pending.length - at > CHUNK + TAG) {
      t.push(open(payloadKey, chunkNonce(counter++, false), pending.subarray(at, at + CHUNK + TAG)));
      at += CHUNK + TAG;
    }
    pending = at ? Buffer.from(pending.subarray(at)) : pending;
  };

  let fileKey: Buffer | null = null;
  const readHeader = async (): Promise<void> => {
    const nl = head.indexOf('\n---');
    const end = nl < 0 ? -1 : head.indexOf('\n', nl + 1);
    if (end < 0) {
      if (head.length > MAX_HEADER) throw new DecryptError('This is not an age-encrypted Keel backup.');
      return;
    }
    const h = parseHeader(head.subarray(0, end).toString('latin1'));
    const wrapKey = await scryptKey(passphrase, h.salt, h.logN);
    try {
      fileKey = open(wrapKey, Buffer.alloc(12), h.body);
    } catch {
      throw new DecryptError('Wrong backup passphrase.');
    }
    const expect = crypto.createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(h.macked, 'latin1').digest();
    if (h.mac.length !== expect.length || !crypto.timingSafeEqual(h.mac, expect)) throw new DecryptError('The backup header was changed.');
    headerDone = true;
    pending = Buffer.from(head.subarray(end + 1));
    head = Buffer.alloc(0);
  };

  const startPayload = () => {
    if (payloadKey || !fileKey || pending.length < 16) return;
    payloadKey = hkdf(fileKey, pending.subarray(0, 16), 'payload');
    pending = Buffer.from(pending.subarray(16));
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      (async () => {
        if (!headerDone) {
          head = head.length ? Buffer.concat([head, chunk]) : chunk;
          await readHeader();
        } else {
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        }
        if (headerDone) {
          startPayload();
          drain(this);
        }
      })().then(() => cb(), (err) => cb(err));
    },
    flush(cb: TransformCallback) {
      try {
        if (!headerDone || !payloadKey) throw new DecryptError('The backup file is cut short.');
        // The last chunk may only be empty when the whole payload is.
        if (pending.length < TAG || (pending.length === TAG && counter > 0)) throw new DecryptError('The backup file is cut short.');
        this.push(open(payloadKey, chunkNonce(counter++, true), pending));
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}
