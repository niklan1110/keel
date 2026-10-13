// Keel edge function bootstrap (runs under Deno, one process per function).
//
// Loads the function's module, captures the handler it passes to Deno.serve()
// (or its default export's fetch()), and serves that handler on the unix
// socket keel-functions gave us. Function code is the same as on Supabase:
//
//   Deno.serve(async (req) => new Response('hello'))

const socket = Deno.env.get('KEEL_WORKER_SOCKET');
const entry = Deno.env.get('KEEL_WORKER_ENTRY');
Deno.env.delete('KEEL_WORKER_SOCKET');
Deno.env.delete('KEEL_WORKER_ENTRY');
if (!socket || !entry) {
  console.error('keel bootstrap: KEEL_WORKER_SOCKET and KEEL_WORKER_ENTRY are required');
  Deno.exit(70);
}

// Function code may not connect to private addresses (--deny-net), which
// include the gateway. Requests to SUPABASE_URL's origin go through a unix
// socket instead, which keel-functions forwards to the gateway for this
// function's project only. fetch() and WebSocket cover supabase-js.
const gatewaySocket = Deno.env.get('KEEL_GATEWAY_SOCKET');
const gatewayOrigin = Deno.env.get('KEEL_GATEWAY_ORIGIN');
Deno.env.delete('KEEL_GATEWAY_SOCKET');
Deno.env.delete('KEEL_GATEWAY_ORIGIN');
if (gatewaySocket && gatewayOrigin) {
  const client = Deno.createHttpClient({ proxy: { transport: 'unix', path: gatewaySocket } });
  const gatewayHost = new URL(gatewayOrigin).host;
  const toGateway = (url) => {
    try {
      const u = new URL(url);
      return (u.protocol === 'http:' || u.protocol === 'ws:') && u.host === gatewayHost;
    } catch {
      return false;
    }
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = function fetch(input, init) {
    const url = input instanceof Request ? input.url : String(input);
    return toGateway(url) ? realFetch(input, { ...init, client }) : realFetch(input, init);
  };
  const RealWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class WebSocket extends RealWebSocket {
    constructor(url, protocols) {
      if (!toGateway(String(url))) {
        super(url, protocols);
        return;
      }
      const opts = protocols === undefined ? {} : typeof protocols === 'object' && !Array.isArray(protocols) ? protocols : { protocols };
      super(url, { ...opts, client });
    }
  };
}

const realServe = Deno.serve.bind(Deno);
let handler = null;
let onError = null;

function fakeServer(opts) {
  const addr = { transport: 'tcp', hostname: '0.0.0.0', port: 8000 };
  try {
    opts?.onListen?.(addr);
  } catch (err) {
    console.error(err);
  }
  const done = new Promise(() => {});
  return {
    addr,
    finished: done,
    ref() {},
    unref() {},
    shutdown: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
}

Deno.serve = function serve(a, b) {
  let opts = {};
  let h = null;
  if (typeof a === 'function') {
    h = a;
    if (b && typeof b === 'object') opts = b;
  } else if (typeof b === 'function') {
    opts = a || {};
    h = b;
  } else if (a && typeof a.handler === 'function') {
    opts = a;
    h = a.handler;
  }
  if (!h) throw new TypeError('Deno.serve() needs a handler function');
  if (handler) console.warn('Deno.serve() was called more than once; the last handler wins');
  handler = h;
  onError = typeof opts.onError === 'function' ? opts.onError : null;
  return fakeServer(opts);
};

// Supabase's runtime global: keep background work going after the response.
const background = new Set();
globalThis.EdgeRuntime = {
  waitUntil(promise) {
    const p = Promise.resolve(promise).catch((err) => console.error(err));
    background.add(p);
    p.finally(() => background.delete(p));
    return p;
  },
};

// One failing request must not take the whole function down.
globalThis.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled promise rejection:', e.reason);
  e.preventDefault();
});
globalThis.addEventListener('error', (e) => {
  console.error('Uncaught error:', e.error ?? e.message);
  e.preventDefault();
});

let mod;
try {
  mod = await import(entry);
} catch (err) {
  console.error('Could not load the function:', err);
  Deno.exit(72);
}
if (!handler && mod?.default && typeof mod.default.fetch === 'function') {
  handler = (req, info) => mod.default.fetch(req, info);
}
if (!handler) {
  console.error('This function never called Deno.serve(). Wrap your code in Deno.serve(async (req) => { ... }).');
  Deno.exit(71);
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

realServe(
  {
    path: socket,
    onListen() {
      console.log('__KEEL_READY__');
    },
    onError(err) {
      console.error(err);
      return json(500, { code: 'WORKER_ERROR', message: 'Function threw an error' });
    },
  },
  async (req, info) => {
    try {
      return await handler(req, info);
    } catch (err) {
      if (onError) {
        try {
          return await onError(err);
        } catch (inner) {
          console.error(inner);
        }
      }
      console.error(err);
      return json(500, { code: 'WORKER_ERROR', message: 'Function threw an error' });
    }
  },
);
