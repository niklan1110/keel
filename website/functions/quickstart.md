# Your first function

Create a function that answers with a greeting, test it, call it from your app and read its logs. You can do this entirely in Studio, or write the code in your editor and deploy it with the `keel` command. Both take about five minutes.

## Create it in Studio

1. Open Studio at `http://localhost:3000` and click **Functions** in the dock at the bottom.
2. Click **New function**.
3. Enter `hello` as the **Name**. It becomes part of the URL: `/functions/v1/hello`.
4. Leave **Require a valid JWT** on. Callers then have to send your anon key or a user's token.
5. The **index.ts** editor starts with this template:

   ```ts
   // Runs on Deno, like Supabase Edge Functions.
   // Secrets: Deno.env.get('MY_SECRET'). Your project: Deno.env.get('SUPABASE_URL').

   Deno.serve(async (req) => {
     const { name } = await req.json().catch(() => ({ name: 'world' }));
     return new Response(JSON.stringify({ message: `Hello ${name}!` }), {
       headers: { 'Content-Type': 'application/json' },
     });
   });
   ```

6. Click **Deploy**.

Studio opens the function with its URL at the top (use the copy button next to it) and four tabs: **Code**, **Test**, **Logs** and **Settings**.

## Test it

Open the **Test** tab. It sends a real request through the gateway, the same way your app would:

1. Keep the method on **POST** and leave the path empty. (The path field is for sub-paths such as `/orders/42?x=1`.)
2. Choose who sends it: **anon key** or **service role**.
3. The **Body** already contains `{ "name": "Keel" }`.
4. Click **Send request**.

You get the status, the time it took and the response:

```json
{
  "message": "Hello Keel!"
}
```

The first request takes a little longer because Keel starts a Deno process for the function. Requests after that reuse it.

## Call it from your app

::: code-group

```js [JavaScript]
import { createClient } from '@supabase/supabase-js'

const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY')

const { data, error } = await keel.functions.invoke('hello', {
  body: { name: 'Ada' },
})
console.log(data) // { message: 'Hello Ada!' }
```

```bash [curl]
curl -X POST 'http://localhost:8000/my-app/functions/v1/hello' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada"}'
```

:::

`keel.functions.invoke` sends `POST` with a JSON body by default and parses a JSON response for you. When a user is signed in, it sends their access token instead of the anon key, so the function can tell who's calling. See [Auth and calling Keel](/functions/auth).

Without an `Authorization` header, the request is rejected before your code runs:

```json
{ "code": 401, "message": "Missing authorization header" }
```

## Check the logs

Open the **Logs** tab. It refreshes every few seconds and shows:

- **Recent requests:** status code, method, path, duration and time of the last few calls.
- **Console output:** everything the function writes with `console.log()` (labeled `LOG`) and `console.error()` (labeled `ERROR`), plus Keel's own messages (labeled `KEEL`), such as `Starting v1`, `Booted v1 in 412ms` and `Stopping (idle)`.

Add a line to your code, deploy, and call the function again to see it:

```ts
console.log('greeting', name)
```

## Edit and redeploy

On the **Code** tab, pick a file from the list (the entrypoint is marked `(entrypoint)`), edit it and click **Deploy changes**. The button then reads `v2 deployed`. Requests that are already running finish on the old version; the next request starts the new one.

## Use a secret

Keep API keys and other settings out of your code with secrets. Go back to the function list (**All functions**), click **Secrets**, enter this under **Add or update** and click **Save 1 secret**:

```text
GREETING=Howdy
```

Then read it in the function and deploy again:

```ts
const greeting = Deno.env.get('GREETING') ?? 'Hello'
return new Response(JSON.stringify({ message: `${greeting} ${name}!` }), {
  headers: { 'Content-Type': 'application/json' },
});
```

Secrets belong to the project, so every function in it can read them. Changing one restarts the project's running functions with the new values. See [Secrets](/functions/secrets).

## Or write it in your editor

Keel uses the same folder layout as the Supabase CLI. In your app's repository, create:

```text
my-app/
└── supabase/
    └── functions/
        └── hello/
            └── index.ts
```

```ts
// supabase/functions/hello/index.ts
Deno.serve(async (req) => {
  const { name } = await req.json().catch(() => ({ name: 'world' }))
  return Response.json({ message: `Hello ${name}!` })
})
```

If you have the Supabase CLI, `supabase functions new hello` creates this layout for you.

Then deploy from the `my-app` folder by running the `keel` script from wherever you installed Keel (here `~/keel`):

```bash
cd ~/code/my-app
~/keel/keel functions deploy hello --project my-app
```

```text
Deployed hello v1 (1 files, 0.1 KB)
  http://localhost:8000/my-app/functions/v1/hello
```

The command looks for `supabase/functions` (or `functions`) in the folder you run it from. It talks to the running stack through Docker Compose, so run it on the machine where Keel runs. To deploy from a laptop or CI, see [Deploying](/functions/deploying#deploy-from-another-computer-or-ci).

The deployed code shows up in Studio too, and the same console output is in the `keel-functions` container's log, tagged with the project and function name:

```bash
~/keel/keel logs keel-functions
```

## Next steps

<div class="cards">
  <a class="card" href="./deploying"><strong>Deploying</strong><span>Shared code, imports, config.toml and size limits.</span></a>
  <a class="card" href="./secrets"><strong>Secrets</strong><span>Give your function an API key without putting it in the code.</span></a>
  <a class="card" href="./auth"><strong>Auth and calling Keel</strong><span>Read the signed-in user and query your tables.</span></a>
  <a class="card" href="./examples"><strong>Examples</strong><span>Copy a webhook, email or scheduled-job function.</span></a>
</div>
