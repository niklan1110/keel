# Coming from Supabase

Keel speaks the same HTTP and WebSocket APIs as Supabase, so an app built on Supabase usually moves to Keel by changing two values: the API URL and the anon key. This page shows what stays the same, what's different, and the steps to move a live project, data and users included.

```diff
- const supabase = createClient('https://abcd1234.supabase.co', SUPABASE_ANON_KEY)
+ const supabase = createClient('http://192.168.1.20:8000/my-app', KEEL_ANON_KEY)
```

## What stays the same

- **Your client code.** `@supabase/supabase-js` v2 and the Flutter, Swift, Kotlin and Python clients call the same endpoints. Queries, `rpc()`, auth, storage, realtime channels and `functions.invoke()` work unchanged.
- **Your SQL.** Each project is a Postgres 17 database with the same `auth`, `storage` and `realtime` schemas, the same roles (`anon`, `authenticated`, `service_role`) and the same helpers (`auth.uid()`, `auth.jwt()`, `storage.foldername()`). Row level security policies carry over as they are.
- **Your migrations and functions folder.** Keep `supabase/migrations` and `supabase/functions` in your repository. Apply migrations with `psql` and deploy functions with [`./keel functions deploy`](/functions/deploying), which reads the same folder layout.
- **Scheduled jobs and webhooks.** `cron.schedule`, `net.http_post` and Database Webhooks triggers use the same functions as on Supabase. See [Scheduled jobs](/database/cron) and [Database webhooks](/database/webhooks).
- **Extensions you're likely to use.** pgvector, PostGIS and the common contrib extensions are installed. See [Extensions](/database/extensions).

## What's different

| | Supabase | Keel |
|---|---|---|
| **API URL** | One host per project: `https://<ref>.supabase.co` | One address for all projects, with the project in the path: `http://<server>:8000/<project>` |
| **Where it runs** | Supabase's cloud | Your own machine, with Docker. No scaling, no edge network. |
| **Dashboard** | Supabase Studio, with organizations and team roles | Keel Studio. Every Studio account is a full admin of every project. |
| **API keys** | JWT keys, or the newer publishable and secret keys | JWT anon and service role keys, rolled in Studio or with `./keel keys roll` ([API keys](/guide/api-keys)) |
| **Row level security** | On for tables made in the dashboard | On for every new table in `public`, including ones made with SQL |
| **Email** | A built-in mail service with low sending limits | No email until you add your own SMTP server ([Email setup](/auth/email)) |
| **Backups** | Managed by Supabase, depending on your plan | Nightly project backups and encrypted full backups to your own S3 bucket, no point-in-time recovery ([Backups](/self-hosting/backups)) |
| **CLI** | `supabase link`, `db push`, `functions deploy` | The [`keel` command](/self-hosting/cli) on the server, or `psql` and the Keel image from your computer |

The [compatibility table](/reference/compatibility) goes through every feature, area by area, and lists what Keel doesn't have yet, such as GraphQL, Vault, the S3 protocol, SAML SSO and some OAuth providers.

## Move a project

1. **Install Keel** with the [Quickstart](/guide/quickstart) and create an empty project in Studio (**New project** in the project switcher).
2. **Copy the project over.** The [importer](/self-hosting/migrate-from-supabase) copies your schemas, data, policies, users (their passwords keep working), storage buckets and files, from Studio (**Project settings > Move from Supabase**) or with `./keel import-supabase`. Supabase is only read.
3. **Finish what the importer can't copy:** deploy your edge functions and set their secrets, set up sign-in providers, the mail server and SMS under **Users > Sign-in settings**, and schedule your cron jobs again. [After the import](/self-hosting/migrate-from-supabase#after-the-import) has the details.
4. **Point your app at Keel** with the project's API URL and anon key from **Connect**.
5. **Tell your users to sign in again.** Sessions don't carry over; passwords and linked provider accounts do.

::: tip Try it side by side first
The importer never changes your Supabase project, so you can import, test your app against Keel, and import again into a fresh project when you're ready to switch. A web page can even talk to both while you migrate: see [Several projects in one app](/guide/connecting#several-projects-in-one-app).
:::

## Coding agents

Agents that know Supabase can build on Keel too. The prompt in [Build with AI agents](/guide/ai-agents) tells them your server's address and the few ways Keel differs.

## Next steps

<div class="cards">
  <a class="card" href="../self-hosting/migrate-from-supabase"><strong>Migrate from Supabase</strong><span>Run the importer, in Studio or from the command line.</span></a>
  <a class="card" href="../reference/compatibility"><strong>Supabase compatibility</strong><span>Every feature, what works, what differs and what's missing.</span></a>
  <a class="card" href="./connecting"><strong>Connecting your app</strong><span>API URL, keys and client libraries.</span></a>
</div>
