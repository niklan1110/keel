/**
 * Resource limits and input checks for keel-realtime. One process serves every
 * project, so a single client must not be able to exhaust it. The values are
 * close to Supabase Realtime's defaults and documented in website/reference/limits.md.
 */
export const LIMITS = {
  /** Largest WebSocket frame a client may send. */
  maxFrameBytes: 1024 * 1024,
  /** Topics (`realtime:` + channel name), in UTF-8 bytes. Binary frames carry the length in one byte. */
  maxTopicBytes: 255,
  /** Channels one connection may have joined at once. */
  maxChannelsPerConnection: 100,
  /**
   * postgres_changes bindings in one join. Each binding is checked against
   * every change in the project, so without a cap one join could hold
   * hundreds of thousands of them and stall realtime for every project.
   */
  maxBindingsPerChannel: 100,
  /** One tracked presence entry: key and state, serialized as JSON. */
  maxPresenceBytes: 64 * 1024,
  /** Channels one connection may track presence on at once (each channel holds one entry per connection). */
  maxPresencePerConnection: 10,
  /** Sustained rate of messages per connection, and the burst allowed on top of it. */
  messagesPerSecond: 100,
  messageBurst: 200,
  /** Messages (and bytes) waiting to be handled on one connection, e.g. behind a slow authorization check. */
  maxPendingMessages: 500,
  maxPendingBytes: 8 * 1024 * 1024,
  /** Unsent data queued for a client that doesn't read; past this the connection is dropped. */
  maxBufferedBytes: 16 * 1024 * 1024,
  /** HTTP broadcast: messages per request, and distinct private topics checked per request. */
  httpMaxMessages: 100,
  httpMaxPrivateTopics: 20,
  /** How long a socket let in over the project's cap for anonymous sockets has to join a channel with a user's token. */
  signInGraceMs: 10_000,
} as const;

/** Why a join's postgres_changes list is refused, or null when it is fine. */
export function bindingsProblem(list: unknown): string | null {
  // Anything but a list is ignored, as before (no bindings).
  if (Array.isArray(list) && list.length > LIMITS.maxBindingsPerChannel) return `TooManyBindings: a channel may listen to at most ${LIMITS.maxBindingsPerChannel} postgres_changes`;
  return null;
}

/**
 * The room a join belongs to. Public and private channels with the same topic
 * are separate rooms, and the prefix keeps every public key distinct from every
 * private key whatever the topic contains.
 */
export const roomKey = (topic: string, isPrivate: boolean): string => `${isPrivate ? 'priv' : 'pub'}:${topic}`;

// C0/C1 control characters (including NUL) and unpaired surrogates.
const BAD_CHARS = /[\p{Cc}\p{Cs}]/u;

/**
 * Checks a channel topic (`realtime:<name>`). Returns the reason for rejecting
 * it, or null when it's fine.
 */
export function topicProblem(topic: unknown): string | null {
  if (typeof topic !== 'string' || !topic.startsWith('realtime:')) return 'unmatched topic';
  if (Buffer.byteLength(topic) > LIMITS.maxTopicBytes) return `InvalidTopic: Topic is longer than ${LIMITS.maxTopicBytes} bytes`;
  if (BAD_CHARS.test(topic)) return 'InvalidTopic: Topic contains control characters';
  return null;
}

/** Size of a presence entry as it is sent to other clients. */
export function presenceBytes(key: string, meta: unknown): number {
  return Buffer.byteLength(JSON.stringify([key, meta]) ?? '');
}

export type RateDecision = 'ok' | 'drop' | 'close';

/**
 * Token bucket: `rate` messages per second with bursts of up to `burst`.
 * Messages over the limit are dropped; a client that keeps sending well past
 * it (another full burst while limited) should be disconnected.
 */
export class RateLimiter {
  private tokens: number;
  private overflow = 0;
  private last: number;

  constructor(
    private rate: number = LIMITS.messagesPerSecond,
    private burst: number = LIMITS.messageBurst,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  hit(now = Date.now()): RateDecision {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    this.overflow = Math.max(0, this.overflow - elapsed * this.rate);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 'ok';
    }
    this.overflow += 1;
    return this.overflow > this.burst ? 'close' : 'drop';
  }
}

/** A connection's place under ConnectionLimits. */
export type Admission = {
  /** Over the project's cap for anonymous sockets: it must sign in on a channel soon or be closed. */
  probation: boolean;
  /** A channel was joined with a user's token: the socket no longer counts towards the project's cap. */
  signedIn(): void;
  /** The socket closed (safe to call more than once). */
  close(): void;
};

/**
 * Open realtime connections per client address and per project. The anon
 * key is public, so the per-project cap only counts sockets that haven't
 * signed in: someone holding thousands of idle anonymous sockets can't keep
 * out signed-in users or the app's own server (service role). Past the cap a
 * new anonymous socket is let in on probation instead of being refused.
 */
export class ConnectionLimits {
  private open = new Map<string, number>();
  constructor(
    private perAddress: number,
    private perProject: number,
  ) {}

  private get(key: string): number {
    return this.open.get(key) || 0;
  }
  private add(key: string, by: number): void {
    const n = this.get(key) + by;
    if (n > 0) this.open.set(key, n);
    else this.open.delete(key);
  }

  /** Open sockets for a project and for one address in it (for logs). */
  usage(project: string, address: string): { project: number; address: number } {
    return { project: this.get(`project:${project}`), address: this.get(`address:${project}:${address}`) };
  }

  /** Lets a socket in, or null when its address already has too many. */
  admit(project: string, address: string, service: boolean): Admission | null {
    const byAddress = `address:${project}:${address}`;
    const byProject = `project:${project}`;
    if (this.get(byAddress) >= this.perAddress) return null;
    this.add(byAddress, 1);
    let counted = !service && this.get(byProject) < this.perProject;
    if (counted) this.add(byProject, 1);
    let closed = false;
    const release = () => {
      if (!counted) return;
      counted = false;
      this.add(byProject, -1);
    };
    const ticket: Admission = {
      probation: !service && !counted,
      signedIn: () => {
        release();
        ticket.probation = false;
      },
      close: () => {
        if (closed) return;
        closed = true;
        release();
        this.add(byAddress, -1);
      },
    };
    return ticket;
  }
}
