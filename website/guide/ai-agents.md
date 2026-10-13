# Build with AI agents

Coding agents such as Claude Code, Cursor, Codex, GitHub Copilot and Windsurf already know Supabase well. Since Keel speaks the same APIs, they can build on it too, once they know your server's address and the few ways Keel differs. Paste the prompt below into your agent at the start of a project and it will:

- connect with `@supabase/supabase-js` to your project's API URL and anon key,
- read Keel's documentation from your own server (as Markdown made for agents),
- write schema changes as SQL migrations with row level security policies,
- use Auth, Storage, Realtime and Edge Functions the way Keel supports them,
- tell you what to apply, deploy or switch on in Studio.

## Get the prompt for your project

The quickest way: in Studio, open **Connect** and choose the **AI agent** tab. It shows this prompt with your project's API URL, anon key and server address already filled in. Click **Copy** and paste it into your agent.

![Studio's Connect panel with the AI agent tab open, showing the filled-in prompt and a Copy button](/images/studio-connect-agent.png)

To write it by hand, copy the template and replace `YOUR-SERVER` (your server's address, for example `192.168.1.20`), `my-app` and `my_app` (your project and its database name) and `YOUR_ANON_KEY`:

<div class="prompt-block">

<<< @/snippets/agent-prompt.txt{md}

</div>

The prompt contains no secrets: the anon key is public by design. The service role key and the database password stay in your project's `.env`, where the agent reads them only if you add them (see [Giving the agent server access](#giving-the-agent-server-access)).

## Keep it in your project

Agents forget a pasted prompt when the conversation ends. To make the instructions permanent, save the prompt as the rules file your agent reads at the start of every session:

| Agent | File |
|---|---|
| Claude Code | `CLAUDE.md` in the project root |
| OpenAI Codex, Jules, Amp, and others that follow the AGENTS.md convention | `AGENTS.md` in the project root |
| Cursor | `.cursor/rules/keel.mdc` (or `AGENTS.md`) |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Windsurf | `.windsurf/rules/keel.md` |
| Gemini CLI | `GEMINI.md` |

If the file already exists, add the prompt as a new section at the end. Commit it with your code so everyone working on the project, people and agents, gets the same instructions.

## Documentation for agents

Every Keel server publishes its documentation in plain Markdown next to the website, following the [llms.txt](https://llmstxt.org) convention:

| URL | Contents |
|---|---|
| `http://YOUR-SERVER:8000/docs/llms.txt` | An index: every page with a one-line summary and a link to its Markdown |
| `http://YOUR-SERVER:8000/docs/llms-full.txt` | The whole documentation in one file, for reading in one go |
| `http://YOUR-SERVER:8000/docs/<page>.md` | Any single page as Markdown, for example `/docs/auth/mfa.md` |

These files are served without a login, like the rest of the docs, and they always match the Keel version you're running. They're on the API's address (port 8000, the same address as your API URL), so an agent that can reach your API can read the docs too; Studio (port 3000) serves the same files.

Agents that run in the cloud (rather than on your computer) can't reach a server on your home network. In that case, download the docs into the project once and point the agent at the file:

```bash
mkdir -p .keel && curl -s http://YOUR-SERVER:8000/docs/llms-full.txt -o .keel/docs.md
```

## Giving the agent server access

With only the API URL and anon key, an agent can build your whole front end, and it hands you the SQL and functions to apply yourself. To let it apply migrations and deploy functions on its own, add these to the project's `.env` (and make sure `.env` is in `.gitignore`):

```bash
# Server-side only. Never ship these in a browser or app.
KEEL_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
KEEL_DB_URL=postgresql://my_app_owner:OWNER_PASSWORD@192.168.1.20:5432/my_app?sslmode=require
```

You find both in Studio under **Connect**. The copy button next to **Postgres connection** copies the connection string with its password.

`KEEL_DB_URL` connects as the project's owner role, `<database>_owner`. It owns the project's `public` schema, so it can apply migrations, generate types and deploy functions, but it isn't a superuser and can't reach other projects or the server itself (see [The project owner role](/self-hosting/security#the-project-owner-role)). If the agent runs on the Keel server itself, use `localhost` as the host. From another computer, Postgres must be open to your network (`KEEL_DB_BIND=0.0.0.0`), and the connection uses TLS; or forward the port over SSH (`ssh -L 5432:127.0.0.1:5432 you@server`) and use `localhost`. See [Postgres connections](/self-hosting/security#postgres-connections).

::: warning These are powerful keys
`KEEL_DB_URL` can read and change everything in its project, including users and files, and the service role key bypasses row level security for its project. Give them to an agent on a development server, or when you review what it runs. Many agents can be set to ask before running a command; keep that on for anything that touches `KEEL_DB_URL`. The `postgres` superuser (`POSTGRES_PASSWORD` in Keel's `.env`) is for server admins: don't give it to agents.
:::

With `KEEL_DB_URL` set, the agent can:

- **Apply migrations**: `psql "$KEEL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260101120000_init.sql`
- **Generate TypeScript types**: `npx supabase gen types typescript --db-url "$KEEL_DB_URL" --schema public > src/database.types.ts`
- **Deploy edge functions** with the Keel image, from the project folder:

  ```bash
  docker run --rm -e KEEL_DB_URL="$KEEL_DB_URL" \
    -v "$PWD/supabase/functions:/src/functions:ro" \
    @@IMAGES@@/keel:latest fn deploy hello --project my-app
  ```

- **Set function secrets**: the same `docker run` line with `secrets set STRIPE_KEY=sk_live_... --project my-app` in place of `fn deploy hello --project my-app`.

The `docker run` lines need Docker on the computer where the agent works and the Keel image (`docker pull @@IMAGES@@/keel:latest`). They connect to the database at `KEEL_DB_URL` and do what [`./keel functions deploy`](/self-hosting/cli) does on the server. If Keel runs on the same computer, `localhost` inside the container is the container itself: use `host.docker.internal` in `KEEL_DB_URL` on macOS and Windows, or add `--network host` on Linux.

## Tips for working with agents

- **Ask for a plan first.** "Plan the tables, policies and functions for X, then wait" gives you a chance to catch a missing policy before any code exists.
- **Review policies.** RLS policies decide who sees what. Read them like you'd read a firewall rule, and ask the agent to explain each one in a sentence.
- **Test as a user.** Ask the agent to write a small script that signs in as two different test users and checks that each sees only their own rows.
- **One migration per change.** Small, named migration files are quicker to review and to apply again on a fresh server.
- **Keep secrets out of chats.** Paste keys into `.env`, not into the conversation: whatever you paste is sent to the agent's provider.

## Related

<div class="cards">
  <a class="card" href="./connecting"><strong>Connecting your app</strong><span>API URL, keys and client libraries.</span></a>
  <a class="card" href="../database/row-level-security"><strong>Row level security</strong><span>Policy patterns your agent should follow.</span></a>
  <a class="card" href="../functions/deploying"><strong>Deploying functions</strong><span>Folder layout and deploy options.</span></a>
  <a class="card" href="../reference/compatibility"><strong>Supabase compatibility</strong><span>What works, and what doesn't yet.</span></a>
</div>
