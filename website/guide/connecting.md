# Connecting your app

Your app needs two values from Studio's **Connect** panel: the **API URL** (`http://<server>:8000/<project>`) and the **anon key**. Pass them to a Supabase client library and use it as you would with Supabase.

## JavaScript and TypeScript

```bash
npm install @supabase/supabase-js
```

```js
import { createClient } from '@supabase/supabase-js'

export const keel = createClient(
  import.meta.env.VITE_KEEL_URL,      // http://192.168.1.20:8000/my-app
  import.meta.env.VITE_KEEL_ANON_KEY,
)
```

This works in browsers, Node.js, Deno, Bun, React Native and Expo. Keel's own test suite uses `@supabase/supabase-js` v2, so everything in these docs is shown with it.

Keep the values in environment variables rather than in code, so you can point the same app at a different server or project:

::: code-group

```bash [.env (Vite)]
VITE_KEEL_URL=http://192.168.1.20:8000/my-app
VITE_KEEL_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

```bash [.env.local (Next.js)]
NEXT_PUBLIC_KEEL_URL=http://192.168.1.20:8000/my-app
NEXT_PUBLIC_KEEL_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

:::

### TypeScript types for your tables

Generate types from your schema with the Supabase CLI, pointed at the project's Postgres database (the connection string is under **Connect** in Studio). From another computer, Postgres must be reachable from it; see [Postgres from other machines](/self-hosting/configuration#postgres-from-other-machines):

```bash
npx supabase gen types typescript \
  --db-url 'postgresql://my_app_owner:PASSWORD@192.168.1.20:5432/my_app' \
  --schema public > database.types.ts
```

```ts
import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const keel = createClient<Database>(url, anonKey)
```

`supabase gen types` with `--db-url` starts a small helper container, so it needs Docker on the machine where you run it.

## Other languages

The official Supabase clients for Flutter/Dart, Swift, Kotlin and Python call the same endpoints, so give them the same API URL and anon key:

::: code-group

```dart [Flutter]
await Supabase.initialize(
  url: 'http://192.168.1.20:8000/my-app',
  anonKey: 'YOUR_ANON_KEY',
);
final keel = Supabase.instance.client;
```

```swift [Swift]
let keel = SupabaseClient(
  supabaseURL: URL(string: "http://192.168.1.20:8000/my-app")!,
  supabaseKey: "YOUR_ANON_KEY"
)
```

```python [Python]
from supabase import create_client

keel = create_client("http://192.168.1.20:8000/my-app", "YOUR_ANON_KEY")
```

:::

Any HTTP library works too. Every endpoint is documented in the [API reference](/api/overview).

## Server-side code

Scripts, backends and cron jobs that need full access use the **service role key**, which bypasses row level security:

```js
import { createClient } from '@supabase/supabase-js'

const admin = createClient(process.env.KEEL_URL, process.env.KEEL_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const { data: users } = await admin.auth.admin.listUsers()
```

::: warning
Never ship the service role key in a browser, a mobile app or a public repository. Anyone who has it can read and change everything in the project. If it leaks, [roll the keys](/guide/api-keys#rolling-keys).
:::

For migrations, ORMs (Prisma, Drizzle, Kysely) and analytics tools, connect to Postgres directly. See [Connecting directly](/database/connecting-directly).

## Reaching Keel from other devices

The API URL has to be an address that **the device running your app** can reach:

| Where the app runs | Use |
|---|---|
| The same machine as Keel | `http://localhost:8000/my-app` |
| A phone or laptop on your home network | `http://<server-lan-ip>:8000/my-app`, for example `http://192.168.1.20:8000/my-app` |
| Anywhere, through Tailscale | `https://<server>.<tailnet>.ts.net/...` (see [remote access](/self-hosting/remote-access)) |
| Anywhere, through your own domain | `https://api.example.com/my-app` |

Set `KEEL_PUBLIC_URL` to the address you use most, so that email links, OAuth callbacks and Studio's Connect panel match it. See [Configuration](/self-hosting/configuration).

::: tip HTTPS sites need an HTTPS API
A web app served over `https://` can't call `http://192.168.1.20:8000`: browsers block mixed content. Put Keel behind HTTPS (Tailscale or a reverse proxy) when your front end is on HTTPS. Plain `http://` is fine for local development and apps on your own network.
:::

The gateway allows cross-origin requests from any origin (CORS `*`), so web apps on other ports and domains can call it without extra setup. Who may do what is controlled by your keys and policies, not by the origin.

## Several projects in one app

A web page can talk to more than one Keel project (or to Keel and Supabase while you migrate). Give each client its own storage key so their sessions don't overwrite each other:

```js
const app = createClient('http://192.168.1.20:8000/my-app', APP_KEY, {
  auth: { storageKey: 'keel-my-app' },
})
const crm = createClient('http://192.168.1.20:8000/crm', CRM_KEY, {
  auth: { storageKey: 'keel-crm' },
})
```

## Moving an existing Supabase app

Change two values and you're done:

```diff
- const supabase = createClient('https://abcd1234.supabase.co', SUPABASE_ANON_KEY)
+ const supabase = createClient('http://192.168.1.20:8000/my-app', KEEL_ANON_KEY)
```

To bring your tables, users and files with you, use the [importer](/self-hosting/migrate-from-supabase). Features that Keel doesn't have yet are listed under [Supabase compatibility](/reference/compatibility).


## Next steps

<div class="cards">
  <a class="card" href="../database/querying"><strong>Querying with the API</strong><span>Filters, joins, pagination, inserts and upserts.</span></a>
  <a class="card" href="../auth/overview"><strong>Auth</strong><span>Sign users up and in.</span></a>
  <a class="card" href="./api-keys"><strong>API keys and rotation</strong><span>Roll keys when one may have leaked.</span></a>
  <a class="card" href="../self-hosting/remote-access"><strong>Internet access and HTTPS</strong><span>Reach Keel from phones away from home and from HTTPS sites.</span></a>
</div>
