# What is Keel?

Keel is a backend for your apps that runs on a computer you own: a home server, a NAS, a mini PC or a Raspberry Pi. It gives every app a **Postgres database with an instant API**, **user accounts**, **file storage**, **realtime updates** and **edge functions**, plus a dashboard called **Studio** to manage it all.

Keel speaks the same HTTP and WebSocket APIs as [Supabase](https://supabase.com). That means you build your app with the regular, open-source [`@supabase/supabase-js`](https://github.com/supabase/supabase-js) client (or the Supabase clients for Flutter, Swift and Kotlin) and point it at your own server:

```js
import { createClient } from '@supabase/supabase-js'

const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY')

const { data, error } = await keel.from('recipes').select('title, author:profiles(display_name)')
```

Keel is independent software. It doesn't use Supabase's servers or code, and it never contacts Supabase unless you use the [importer](/self-hosting/migrate-from-supabase) to move a project over.

## What you get

| | |
|---|---|
| **Database** | Postgres 17 with pgvector and PostGIS. One database per project, with a REST API generated from your tables ([PostgREST](https://postgrest.org)). Row level security decides who sees what. |
| **Auth** | Email and password, magic links and one-time codes, SMS, GitHub, Google, Discord, GitLab, Microsoft and your own OpenID Connect provider, anonymous users, two-factor authentication, an admin API. |
| **Storage** | Public and private buckets, signed URLs, resumable uploads, on-the-fly image resizing, access rules in SQL. |
| **Realtime** | Database change streams, broadcast and presence over WebSockets, private channels. |
| **Edge functions** | TypeScript functions on Deno with secrets, logs and a test runner. |
| **Jobs and webhooks** | Scheduled jobs with `cron.schedule`, and HTTP requests and database webhooks from SQL, with the same functions as Supabase. |
| **Studio** | A web dashboard for all of the above, plus container logs, accounts with two-factor sign-in, and backups. |
| **Backups** | Nightly backups of every project, and encrypted full backups of the whole server copied to an S3-compatible bucket. |
| **Projects** | Run many apps side by side. Each has its own database, keys, users and files. |

## How it fits together

```
   your apps (web, mobile, scripts)              you, in a browser
                │                                       │
         :8000  ▼                                :3000  ▼
       ┌──────────────┐                         ┌──────────────┐
       │   gateway    │                         │    Studio    │
       └──────┬───────┘                         └──────────────┘
  /<project>/rest · auth · storage · realtime · functions
              ▼
     REST · Auth · Storage · Realtime · Functions
              ▼
       Postgres 17 (one database per project)
```

Every app talks to one address, the **gateway** on port 8000, under its project's path: `http://<server>:8000/<project>`. The [core concepts](/guide/concepts) page explains projects, keys and row level security, which are worth five minutes before you build.

## When to use Keel

Keel is a good fit when you want:

- **Your data at home.** Family apps, side projects, internal tools, home automation, learning projects.
- **No usage bills or limits** beyond your own hardware.
- **The Supabase developer experience** without an account or an internet connection.
- **A way off Supabase** for a project, with the same client code.

It's not trying to be a hosting company: there's one server, no automatic scaling and no global edge network. For most personal and small-team apps, that's plenty.

## Next steps

<div class="cards">
  <a class="card" href="./quickstart"><strong>Quickstart</strong><span>Run Keel with Docker and make your first query in ten minutes.</span></a>
  <a class="card" href="../self-hosting/platforms"><strong>Choose a platform</strong><span>Linux, Windows, macOS, ZimaOS, Unraid, TrueNAS SCALE, Synology or a Raspberry Pi.</span></a>
  <a class="card" href="./coming-from-supabase"><strong>Coming from Supabase</strong><span>What stays the same, what's different, and how to move a project.</span></a>
  <a class="card" href="./concepts"><strong>Core concepts</strong><span>Projects, API keys and row level security.</span></a>
</div>
