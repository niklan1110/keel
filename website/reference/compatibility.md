# Supabase compatibility

Keel implements the HTTP and WebSocket APIs that the Supabase client libraries use, so most apps only need a new URL and key. This page lists, area by area, what works, what works with differences, and what Keel doesn't have yet.

| Status | Meaning |
|---|---|
| **Supported** | Works like on Supabase, with the same client calls. |
| **Partial** | Works, with the limits described in the notes. |
| **Untested** | Should work because it uses the same endpoints, but Keel's test suite doesn't cover it. |
| **Not yet** | Not available in Keel today. |

Keel's own end-to-end tests drive a running server with `@supabase/supabase-js` v2, `tus-js-client` and plain HTTP, so anything listed as Supported for supabase-js is exercised on every change.

## Database and REST API

| Feature | Status | Notes |
|---|---|---|
| REST API: select, filters, embedding through foreign keys, inserts, upserts, updates, deletes, counts, pagination | Supported | Each project runs its own [PostgREST](https://postgrest.org) 12 process, the same engine Supabase uses. |
| RPC (calling Postgres functions) | Supported | `keel.rpc('fn', args)` |
| Row level security with `auth.uid()`, `auth.role()`, `auth.jwt()` | Supported | Same helpers and claims as Supabase. |
| Statement timeouts for API roles | Supported | 3 s for `anon`, 8 s for `authenticated`, as on Supabase. |
| Exposed schemas | Partial | The REST API serves `public`. Other schemas can be added in the project's settings in the control database; Studio has no setting for it yet. See [Exposing other schemas](/database/overview#exposing-other-schemas). |
| Realtime publication `supabase_realtime` | Supported | `alter publication supabase_realtime add table ...` from Supabase migrations works unchanged. |
| Triggers on `auth.users` | Supported | `auth` tables use GoTrue's column names, so Supabase's `handle_new_user` pattern works. |
| Direct Postgres connections | Supported | Port 5432 as the `postgres` superuser. See [Connecting directly](/database/connecting-directly). |
| Connection pooler (Supavisor, port 6543) | Not yet | Connect to Postgres directly. |
| Extensions | Partial | `pgvector` and PostGIS, the standard Postgres contrib extensions (`pgcrypto`, `uuid-ossp`, `pg_trgm`, `citext`, `hstore`, `ltree`, `unaccent` and more) and `pg_stat_statements`, in the `extensions` schema as on Supabase. No `pg_graphql`, `pgsodium` or Vault. `pg_cron` and `pg_net` aren't installed, but their SQL functions are built in (below). See [Extensions](/database/extensions). |
| Vector search (`pgvector`) | Supported | `create extension vector with schema extensions`, `vector` columns, HNSW and IVFFlat indexes, and `match_documents`-style RPC functions work as in Supabase's guides. The project's owner role can enable it. |
| PostGIS | Partial | `geometry`, `geography`, spatial indexes and `.geojson()`. Enabled by the superuser (Studio's SQL editor), not the owner role. No raster support (`postgis_raster`). |
| GraphQL (`pg_graphql`) | Not yet | |
| Scheduled jobs (`pg_cron`): `cron.schedule`, `cron.unschedule`, `cron.alter_job`, `cron.job`, `cron.job_run_details` | Partial | Same SQL functions and tables, in every project without `create extension`. Schedules are UTC; jobs run as the project's owner role, with a time limit. No `@reboot`. See [Scheduled jobs](/database/cron). |
| HTTP from SQL (`pg_net`): `net.http_get`, `net.http_post`, `net.http_delete`, `net._http_response` | Partial | Same functions and tables. Private and LAN addresses are refused (as for edge functions), redirects aren't followed and responses are limited to 1 MB. See [Webhooks and HTTP requests](/database/webhooks). |
| Database webhooks (`supabase_functions.http_request` triggers) | Supported | Triggers created by Supabase's dashboard or migrations work unchanged, including calls to the project's own edge functions. |
| TypeScript types with `supabase gen types --db-url` | Supported | See [Connecting your app](/guide/connecting). |

## Auth

| Feature | Status | Notes |
|---|---|---|
| Email and password sign-up and sign-in | Supported | |
| Email confirmation, magic links, email codes (OTP), invites, password recovery, email change | Supported | Without a mail server, accounts are confirmed automatically and other emails aren't sent. See [Email setup](/auth/email). |
| Phone sign-in: SMS codes, phone and password, phone change, test numbers | Supported | Providers: Twilio (SMS or WhatsApp), Vonage, MessageBird, or a webhook to your own gateway. |
| Anonymous sign-ins | Supported | Off by default; turn on in **Users**, **Sign-in settings**. |
| PKCE flow (`exchangeCodeForSession`) | Supported | |
| Sessions, refresh token rotation, sign-out (`global`, `local`, `others`) | Supported | A rotated refresh token can be reused for 10 seconds. |
| OAuth sign-in: GitHub, Google, Discord, GitLab (including self-hosted), Microsoft (`azure`) | Supported | See [Social sign-in](/auth/oauth). |
| Custom OpenID Connect providers (`custom:<id>`) | Supported | Discovery, PKCE and a checked ID token. Configured in Studio, not through the Management API. Plain OAuth 2 custom providers (without OpenID Connect) aren't supported. See [OpenID Connect providers](/auth/oidc). |
| Other OAuth providers (Apple, Slack, Twitter/X and others) | Not yet | Keycloak, Zitadel and other OpenID Connect servers work as custom providers. |
| `signInWithIdToken` (native Google or Apple sign-in) | Not yet | |
| Identity linking (`linkIdentity`, `unlinkIdentity`) | Not yet | |
| `reauthenticate()` | Not yet | |
| MFA: authenticator apps (TOTP) and SMS factors, `aal2` sessions | Supported | See [Two-factor authentication](/auth/mfa). |
| Admin API: list, create, get, update, ban, delete users, `inviteUserByEmail`, `generateLink`, MFA factors | Supported | Needs the service role key. |
| SAML SSO, passkeys (WebAuthn), Web3 sign-in, MFA recovery codes | Not yet | |
| Auth hooks (custom access token, send email, send SMS) | Not yet | For SMS, the webhook provider sends codes to any URL you choose. |
| Custom email templates | Not yet | Emails use Keel's built-in wording. |
| CAPTCHA | Not yet | |
| Rate limits | Partial | Built in and not configurable. See [Limits](/reference/limits). |
| JWT signing | Partial | HS256 with a secret per project. Asymmetric signing keys and JWKS (`/.well-known/jwks.json` returns no keys) aren't supported. |
| New-style API keys (`sb_publishable_...`, `sb_secret_...`) | Not yet | Keel uses the JWT `anon` and `service_role` keys. |

## Storage

| Feature | Status | Notes |
|---|---|---|
| Buckets: create, list, get, update, empty, delete; public and private; size limits and allowed MIME types | Supported | |
| Objects: upload, upsert, update, download, list, move, copy, remove, info | Supported | |
| Public URLs, signed URLs, signed upload URLs | Supported | Signed upload URLs are valid for 2 hours. |
| Range requests and ETags | Supported | |
| Access control with policies on `storage.objects`, `storage.foldername()` and friends | Supported | See [Access control](/storage/access-control). |
| Resumable uploads (TUS) | Supported | Any chunk size works (Supabase requires 6 MB chunks). Unfinished uploads expire after 24 hours. See [Resumable uploads](/storage/resumable-uploads). |
| Image transformations: `width`, `height`, `resize`, `quality`, `format` | Supported | Served by imgproxy. Images are converted to WebP when the browser accepts it, unless `format=origin`. |
| S3 protocol | Not yet | |
| Vector buckets and analytics buckets | Not yet | |

## Realtime

| Feature | Status | Notes |
|---|---|---|
| Database changes (`postgres_changes`) for inserts, updates and deletes | Supported | Events respect row level security. |
| Change filters: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in` | Supported | One filter per listener, as on Supabase. |
| Delete events on tables with RLS | Partial | Need `REPLICA IDENTITY FULL` (Studio sets it when you switch on realtime for a table). Without it, Keel withholds these events instead of sending primary keys only. |
| Broadcast, including `self`, `ack`, binary payloads and the HTTP send endpoint | Supported | Binary payloads only over the WebSocket, not with `httpSend()` |
| Presence | Supported | |
| Private channels (Realtime Authorization with policies on `realtime.messages`) | Supported | See [Private channels](/realtime/authorization). |
| Broadcast from the database: `realtime.send()`, `realtime.broadcast_changes()` | Supported | See [Broadcast from the database](/realtime/database-broadcast). |
| "Private channels only" project setting | Supported | In **Project settings**. |
| Broadcast replay | Not yet | |

## Edge functions

| Feature | Status | Notes |
|---|---|---|
| `Deno.serve`, a default export with `fetch`, and the old `serve` from `deno.land/std` | Supported | |
| `npm:`, `jsr:` and URL imports, `deno.json` and import maps, shared `_shared` folders | Supported | |
| Secrets, and `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` set for you | Supported | `SUPABASE_DB_URL` isn't set, and functions can't connect to Keel's Postgres directly; use `supabase-js`. |
| `verify_jwt` per function, including from `supabase/config.toml` | Supported | |
| WebSockets (`Deno.upgradeWebSocket`) | Supported | |
| `EdgeRuntime.waitUntil` for background work | Supported | |
| Bundled static files | Partial | Only text files are deployed; binary files in a function's folder are skipped. |
| `Supabase.ai` (built-in embeddings) | Not yet | |
| Deploying with the Supabase CLI | Not yet | Use `./keel functions deploy`, which reads the same `supabase/functions` folder. See [Deploying](/functions/deploying). |

## Studio and platform

| Feature | Status | Notes |
|---|---|---|
| Table editor, policies, SQL editor with saved queries | Supported | See the [Studio tour](/studio/tour). |
| User management, storage browser, edge function editor with logs and a test runner | Supported | |
| Logs | Partial | Container logs for each service, not the searchable Logs Explorer. See [Logs and services](/studio/logs). |
| Backups | Partial | Nightly and on-demand `pg_dump` per project with download and restore, plus encrypted full backups (every database, Keel's settings and the uploaded files) copied to an S3-compatible bucket and restored with `./keel restore`. No point-in-time recovery. |
| Multiple projects | Supported | On one server, each with its own database, keys and users. |
| Importing a Supabase project | Supported | See [Migrate from Supabase](/self-hosting/migrate-from-supabase). |
| Team members, organizations, roles in Studio | Partial | Studio has several accounts with optional two-factor authentication, but every account is a full admin of every project: no organizations or roles. See [Accounts and sign-in](/studio/accounts). |
| Branching, read replicas, point-in-time recovery | Not yet | |
| Management API and the Supabase CLI's platform commands (`link`, `functions deploy`, `secrets`) | Not yet | Use the [keel CLI](/self-hosting/cli). |
| Security and performance advisors, usage reports | Not yet | |
| Cron jobs and webhook requests in Studio | Partial | Studio's **Jobs** tool lists jobs, recent runs and responses; create and change them with SQL. |

## Client libraries

| Library | Status | Notes |
|---|---|---|
| `@supabase/supabase-js` v2 (browser, Node.js, Deno, Bun, React Native) | Supported | Keel's tests use it. |
| `tus-js-client` and Uppy for resumable uploads | Supported | |
| Flutter/Dart, Swift, Kotlin, Python and C# clients | Untested | They call the same endpoints. Pass the full API URL including the project path. |
| Any HTTP client | Supported | See the [API reference](/api/overview). |

## Things that work differently

- **The API URL has a project path.** On Supabase each project has its own host (`https://abcd.supabase.co`); on Keel all projects share one address and are told apart by the first part of the path: `http://<server>:8000/my-app`. Always pass the full URL to `createClient`. OAuth callbacks follow the same pattern: `<KEEL_PUBLIC_URL>/my-app/auth/v1/callback`.
- **One server.** Everything runs on your machine: no automatic scaling, no global edge network, and edge functions run next to the database. A function's first request after it has been idle starts its process, which takes a moment longer.
- **Keys are rolled, not set.** Each project's anon and service role keys are signed with the project's own signing key and are valid for 10 years. Roll them in Studio (**Connect**) or with `./keel keys roll`: old keys keep working for a grace period, or stop at once in an emergency. See [API keys and rotation](/guide/api-keys). You can't set your own JWT secret.
- **Imported users sign in again.** Because Keel issues tokens with its own per-project secret, sessions from Supabase don't carry over. Passwords keep working.
- **New tables get row level security automatically**, including tables created with SQL or migrations. On Supabase, only tables created in the dashboard do. Turn this off per project with `alter database my_app set keel.auto_rls = 'off';`.
- **Sign-up works without a mail server.** Without SMTP, new accounts are confirmed immediately; magic links, password resets and codes aren't sent, and never logged. Studio shows invite and reset links on screen. Add SMTP to send real emails and require confirmation. New projects on a public URL start with sign-ups off until then.
- **Studio is a superuser.** Studio's SQL editor and table editor run as `postgres`, and every Studio account has access to every project: there are no organizations or per-project roles.
- **Rate limits are fixed.** Auth's limits on emails, SMS and sign-in attempts are built in. See [Limits](/reference/limits).
- **Backups are nightly, not continuous.** Keel takes a nightly dump of each project and, with `KEEL_BACKUP_PASSPHRASE` set, an encrypted full backup of everything including uploaded files, so you can lose up to a day of changes; there is no point-in-time recovery. See [Backups and restore](/self-hosting/backups).

## Not available yet

These Supabase features aren't in Keel today. Some may come later; none are needed for the APIs above to work.

- GraphQL (`pg_graphql`)
- Queues (`pgmq`)
- Vault and `pgsodium`
- `Supabase.ai` and vector buckets (`pgvector` itself is [supported](/database/extensions))
- PostGIS raster (`postgis_raster`)
- The S3 protocol for storage, analytics buckets
- SAML SSO, passkeys (WebAuthn), Web3 sign-in, MFA recovery codes
- Apple, Slack, Twitter/X and other built-in OAuth providers, plain OAuth 2 custom providers, `signInWithIdToken`, identity linking
- Auth hooks, custom email templates, CAPTCHA
- Asymmetric JWT signing keys and the new publishable and secret API keys
- Branching, read replicas, point-in-time recovery, a connection pooler
- The Management API, organizations and team members
