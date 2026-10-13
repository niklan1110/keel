# Examples

Complete functions for common jobs. Each one is a single `index.ts` you can drop into `supabase/functions/<name>/` and deploy with `./keel functions deploy <name>`, or paste into Studio's **New function** editor. They use the `todos` table from the [quickstart](/guide/quickstart) where they need data.

## A JSON API on your tables

A small REST-style endpoint with validation. It acts as the caller, so [row level security](/database/row-level-security) decides what each user sees. Sub-paths reach the function too: a request to `/functions/v1/todos-api/42` arrives with the path `/todos-api/42`.

```ts
// supabase/functions/todos-api/index.ts
import { createClient } from 'npm:@supabase/supabase-js@2'

const fail = (status: number, message: string) => Response.json({ message }, { status })

Deno.serve(async (req) => {
  const keel = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const [, , id] = new URL(req.url).pathname.split('/') // "/todos-api/42" -> "42"

  if (req.method === 'GET' && !id) {
    const { data, error } = await keel.from('todos').select('id, task, done').order('created_at')
    return error ? fail(500, error.message) : Response.json(data)
  }

  if (req.method === 'POST' && !id) {
    const { task } = await req.json().catch(() => ({}))
    if (typeof task !== 'string' || !task.trim()) return fail(400, 'task is required')
    const { data, error } = await keel.from('todos').insert({ task: task.trim() }).select().single()
    return error ? fail(400, error.message) : Response.json(data, { status: 201 })
  }

  if (req.method === 'PATCH' && id) {
    const { done } = await req.json().catch(() => ({}))
    const { data, error } = await keel.from('todos').update({ done: !!done }).eq('id', id).select().maybeSingle()
    if (error) return fail(400, error.message)
    return data ? Response.json(data) : fail(404, 'No such todo')
  }

  return fail(404, 'Not found')
})
```

```js
await keel.functions.invoke('todos-api', { body: { task: 'Buy milk' } })
await keel.functions.invoke('todos-api/42', { method: 'PATCH', body: { done: true } })
const { data: todos } = await keel.functions.invoke('todos-api', { method: 'GET' })
```

## Stripe webhook

Stripe calls this function when a payment completes. It checks Stripe's signature, then marks the order as paid with the service role key. It assumes an `orders` table with `stripe_session_id`, `status` and `paid_at` columns.

```ts
// supabase/functions/stripe-webhook/index.ts
import Stripe from 'npm:stripe@17'
import { createClient } from 'npm:@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  httpClient: Stripe.createFetchHttpClient(),
})
const cryptoProvider = Stripe.createSubtleCryptoProvider()
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

Deno.serve(async (req) => {
  const signature = req.headers.get('Stripe-Signature') ?? ''
  const body = await req.text() // the raw body: the signature covers these exact bytes

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!,
      undefined,
      cryptoProvider,
    )
  } catch (err) {
    return new Response(`Invalid signature: ${(err as Error).message}`, { status: 400 })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const { error } = await admin
      .from('orders')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('stripe_session_id', session.id)
    // A 5xx answer makes Stripe retry later.
    if (error) return new Response(error.message, { status: 500 })
  }

  return Response.json({ received: true })
})
```

Stripe can't send a Keel JWT, so turn the check off and add the two keys as secrets:

```toml
# supabase/config.toml
[functions.stripe-webhook]
verify_jwt = false
```

```bash
./keel secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_... --project my-app
./keel functions deploy stripe-webhook --project my-app
```

In Stripe's dashboard, add a webhook endpoint pointing at your function's public HTTPS address, such as `https://api.example.com/my-app/functions/v1/stripe-webhook` (see [Internet access and HTTPS](/self-hosting/remote-access)). To test on your own network first, the Stripe CLI can forward events to it and prints a webhook secret to use:

```bash
stripe listen --forward-to localhost:8000/my-app/functions/v1/stripe-webhook
```

## Send an email

A contact form that emails you through [Resend](https://resend.com)'s HTTP API. Any provider with an HTTP API (Postmark, Mailgun, SendGrid) works the same way.

```ts
// supabase/functions/contact/index.ts
Deno.serve(async (req) => {
  const { name, email, message } = await req.json().catch(() => ({}))
  if (!name || typeof email !== 'string' || !email.includes('@') || !message) {
    return Response.json({ message: 'name, email and message are required' }, { status: 400 })
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Website <hello@example.com>',
      to: [Deno.env.get('CONTACT_TO')],
      reply_to: email,
      subject: `Message from ${name}`,
      text: String(message).slice(0, 5000),
    }),
  })

  if (!res.ok) {
    console.error('Resend failed', res.status, await res.text())
    return Response.json({ message: 'Could not send your message' }, { status: 502 })
  }
  return Response.json({ sent: true })
})
```

```bash
./keel secrets set RESEND_API_KEY=re_... CONTACT_TO=you@example.com --project my-app
```

```js
const { error } = await keel.functions.invoke('contact', {
  body: { name: 'Ada', email: 'ada@example.com', message: 'Hello!' },
})
```

The JWT check stays on, so only your app (with its anon key) can call it. The anon key is public, though, so add a rate limit or a captcha check before using this on a busy public site.

Functions can open outbound connections to any host, so an SMTP library from npm can also send through your own mail server. Keel's sign-up and password-reset emails are configured separately, under [Email setup](/auth/email).

## Run a job on a schedule

Keel has no built-in scheduler, so let the server's cron call the function. This one deletes finished todos older than 30 days. It's protected by a shared secret in a header instead of a JWT, which keeps the cron line short.

```ts
// supabase/functions/nightly-cleanup/index.ts
import { createClient } from 'npm:@supabase/supabase-js@2'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) {
    return Response.json({ message: 'Forbidden' }, { status: 403 })
  }

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { count, error } = await admin
    .from('todos')
    .delete({ count: 'exact' })
    .eq('done', true)
    .lt('created_at', cutoff)
  if (error) return Response.json({ message: error.message }, { status: 500 })

  console.log(`Deleted ${count} finished todos`)
  return Response.json({ deleted: count })
})
```

```toml
# supabase/config.toml
[functions.nightly-cleanup]
verify_jwt = false
```

```bash
CRON_SECRET=$(openssl rand -hex 32)
echo "$CRON_SECRET"   # copy it: Keel won't show it again
./keel secrets set CRON_SECRET=$CRON_SECRET --project my-app
./keel functions deploy nightly-cleanup --project my-app
```

Then add a line to the crontab of the machine running Keel (`crontab -e`):

```text
# Every night at 03:30
30 3 * * * curl -fsS -X POST -H 'x-cron-secret: YOUR_CRON_SECRET' http://localhost:8000/my-app/functions/v1/nightly-cleanup > /dev/null
```

On a NAS without cron, use its task scheduler to run the same `curl` command. Any scheduler that can send an HTTP request works, including one on another machine, as long as it can reach Keel.

A run must finish within the [request time limit](/functions/runtime#limits) (150 seconds by default). Split long jobs into batches and call the function several times.

## Export a table to a CSV file

A signed-in user gets a download link for a CSV of their todos. The function writes the file to a private Storage bucket named `exports` (create it in Studio under **Storage**) and returns a signed URL that works for 10 minutes.

```ts
// supabase/functions/export-todos/index.ts
import { createClient } from 'npm:@supabase/supabase-js@2'

const internalUrl = Deno.env.get('SUPABASE_URL')!
const publicUrl = Deno.env.get('KEEL_PUBLIC_URL')!
const admin = createClient(internalUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const cell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`

Deno.serve(async (req) => {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user) return Response.json({ message: 'Sign in first' }, { status: 401 })

  const { data: rows, error } = await admin
    .from('todos')
    .select('id, task, done, created_at')
    .eq('user_id', user.id)
    .order('created_at')
  if (error) return Response.json({ message: error.message }, { status: 500 })

  const csv = ['id,task,done,created_at', ...rows.map((r) => [r.id, r.task, r.done, r.created_at].map(cell).join(','))].join('\n')

  const path = `${user.id}/todos-${Date.now()}.csv`
  const upload = await admin.storage.from('exports').upload(path, csv, { contentType: 'text/csv' })
  if (upload.error) return Response.json({ message: upload.error.message }, { status: 500 })

  const { data: signed, error: signError } = await admin.storage
    .from('exports')
    .createSignedUrl(path, 600, { download: 'todos.csv' })
  if (signError) return Response.json({ message: signError.message }, { status: 500 })

  // The signed URL starts with Keel's internal address. Give the user the public one.
  return Response.json({ url: signed.signedUrl.replace(internalUrl, publicUrl) })
})
```

```js
const { data } = await keel.functions.invoke('export-todos')
window.location.href = data.url
```

To resize or convert images, you don't need a function: Storage does it on the fly with [image transformations](/storage/image-transformations). Packages that rely on native code, such as `sharp`, can't load in functions, because native libraries are blocked.

## Hide an API key: an LLM proxy

Your app shouldn't contain your OpenAI key. This function lets signed-in users ask questions, adds the key on the server and streams the answer back as it's generated. It works with any service that offers an OpenAI-compatible `/chat/completions` endpoint on the internet. For a server on your own network, such as [Ollama](https://ollama.com), allow its address first with [`KEEL_FUNCTIONS_ALLOW_LAN`](/functions/overview#allowing-addresses-on-your-network).

```ts
// supabase/functions/ask/index.ts
import { createClient } from 'npm:@supabase/supabase-js@2'

const keel = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const baseUrl = Deno.env.get('LLM_BASE_URL') ?? 'https://api.openai.com/v1'

Deno.serve(async (req) => {
  // Only signed-in users may spend your credits.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
  const { data: { user } } = await keel.auth.getUser(token)
  if (!user) return Response.json({ message: 'Sign in first' }, { status: 401 })

  const { question } = await req.json().catch(() => ({}))
  if (typeof question !== 'string' || !question || question.length > 4000) {
    return Response.json({ message: 'Send { "question": "..." } with up to 4000 characters' }, { status: 400 })
  }

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('LLM_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: Deno.env.get('LLM_MODEL'),
      stream: true,
      messages: [
        { role: 'system', content: 'You are a helpful cooking assistant. Answer briefly.' },
        { role: 'user', content: question },
      ],
    }),
  })
  if (!upstream.ok) {
    console.error('LLM request failed', upstream.status, await upstream.text())
    return Response.json({ message: 'The assistant is unavailable' }, { status: 502 })
  }

  // Pass the server-sent events straight through to the app.
  return new Response(upstream.body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
})
```

```bash
./keel secrets set LLM_API_KEY=sk-... LLM_MODEL=your-model-name --project my-app
# For Ollama on another machine (with KEEL_FUNCTIONS_ALLOW_LAN=192.168.1.30:11434 in .env):
# ./keel secrets set LLM_BASE_URL=http://192.168.1.30:11434/v1 LLM_API_KEY=ollama --project my-app
```

In the app, `invoke` returns the raw `Response` for `text/event-stream`, so you can read the answer as it arrives:

```js
const { data: response, error } = await keel.functions.invoke('ask', {
  body: { question: 'How long should I boil an egg?' },
})
const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  console.log(value) // "data: {...}" lines, each with the next piece of the answer
}
```

The whole stream counts toward the [request time limit](/functions/runtime#limits).

## WebSocket echo server

Functions can accept WebSocket connections with `Deno.upgradeWebSocket`. This one echoes every message back:

```ts
// supabase/functions/echo/index.ts
Deno.serve((req) => {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket', { status: 400 })
  }
  const { socket, response } = Deno.upgradeWebSocket(req)
  socket.onopen = () => socket.send('connected')
  socket.onmessage = (e) => socket.send(`echo: ${e.data}`)
  return response
})
```

```js
const ws = new WebSocket('ws://localhost:8000/my-app/functions/v1/echo')
ws.onopen = () => ws.send('ping')
ws.onmessage = (e) => console.log(e.data) // "connected", then "echo: ping"
```

Browsers can't add an `Authorization` header to a WebSocket, so deploy WebSocket functions with **Require a valid JWT** off. To know who's connected, send the user's access token as a query parameter and check it in the function (Keel's logs leave query strings out):

```ts
import { createClient } from 'npm:@supabase/supabase-js@2'

const keel = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const { data: { user } } = await keel.auth.getUser(token)
  if (!user) return new Response('Unauthorized', { status: 401 })

  const { socket, response } = Deno.upgradeWebSocket(req)
  socket.onmessage = (e) => socket.send(`${user.email}: ${e.data}`)
  return response
})
```

```js
const { data: { session } } = await keel.auth.getSession()
const ws = new WebSocket(`ws://localhost:8000/my-app/functions/v1/echo?token=${session.access_token}`)
```

Open WebSockets have no time limit, and a function's process keeps running while any are open. Deploying a new version or changing secrets closes them, after at most the request time limit, so clients should reconnect when a socket closes. For chat, presence and live updates between many users, [Realtime](/realtime/overview) is usually the better fit.
