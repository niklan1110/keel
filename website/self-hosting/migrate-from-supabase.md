# Migrate from Supabase

Keel can copy a Supabase project into a Keel project: your tables and data, users (their passwords keep working), policies, storage buckets and files. The copy is one-way: Supabase is only read, and nothing there changes.

```bash
./keel import-supabase --project my-app \
  --db-url 'postgresql://postgres.abcd1234:YOUR_DB_PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres' \
  --url https://abcd1234.supabase.co \
  --service-key YOUR_SUPABASE_SERVICE_ROLE_KEY
```

You can run the same import from Studio, without a terminal.

## What's copied

| Copied | Not copied |
|---|---|
| Your schemas (`public` and any others you created): tables, data, views, functions, triggers, types, indexes and policies. Row level security stays exactly as it was. | Supabase's own schemas, such as `graphql`, `vault`, `cron`, `net`, `pgsodium`, `supabase_functions` and `supabase_migrations` |
| Common extensions: `vector` (pgvector), `postgis`, `pgcrypto`, `uuid-ossp`, `pg_trgm`, `citext`, `hstore`, `ltree`, `unaccent`, `fuzzystrmatch`, `btree_gin`, `btree_gist` and a few more | Other extensions, including `postgis_topology`, `pg_graphql`, `pg_net`, `pgsodium`, `supabase_vault`, `pg_cron` and `wrappers` |
| Auth users with their password hashes, their identities (GitHub, Google…) and MFA factors (authenticator apps and phone) | Sessions and refresh tokens, so users sign in again |
| Triggers on `auth.users`, such as "create a profile on sign-up" | Auth settings: site URL, redirect URLs, SMTP, OAuth providers, SMS |
| Storage buckets, file metadata and the files themselves (needs the project URL and `service_role` key) | Edge functions and their secrets |
| Policies on `storage.objects`, `storage.buckets` and `realtime.messages` | The project's API keys and JWT secret: the Keel project keeps its own |
| Which tables had realtime turned on (the `supabase_realtime` publication) | Grants to Supabase's internal roles |

`vector` and `postgis` need Keel's `keel-postgres` database image, which installs made after 0.2.0 use; an older install gets it when you run the installer again (see [Updating](/self-hosting/updating)). PostGIS raster (`postgis_raster`) isn't available. Anything that uses a missing extension can't be recreated. The importer lists every object it couldn't import, so you can recreate or replace it by hand. See [Supabase compatibility](/reference/compatibility) for the features Keel doesn't have.

## Before you start

- **Create an empty project** in Keel Studio (**New project** in the project switcher). Importing into a project that already has tables works, but same-named objects clash.
- The Keel server needs internet access to reach Supabase.
- Keel runs Postgres 17. A source on a newer major version is refused.

## Get the values from Supabase

1. **Database connection string.** In your Supabase project, click **Connect** and copy the **Session pooler** connection string. Replace `[YOUR-PASSWORD]` with your database password (reset it under Project Settings > Database if you don't have it). It looks like:

   ```text
   postgresql://postgres.abcd1234:YOUR_DB_PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
   ```

   Use the session pooler (port 5432), not the transaction pooler. The direct connection (`db.<ref>.supabase.co`) only works if your server has IPv6. If the password contains characters such as `@`, `:` or `/`, URL-encode them (`@` becomes `%40`).

2. **For files: project URL and `service_role` key.** Copy the project URL (`https://<ref>.supabase.co`) and the `service_role` key from Project Settings > API. Use the `service_role` key, a JWT that starts with `eyJ` (newer dashboards list it under the legacy API keys). Without these two values, everything except the files is copied.

## Import in Studio

1. In Studio, switch to the empty project and open **Project settings** from the project switcher.
2. Under **Move from Supabase**, click **Import from Supabase**.
3. Fill in:
   - **Database connection string (Session pooler)**, with your database password included. It's only used for this import and isn't stored.
   - **Project URL (for files)**
   - **service_role key (for files)**
4. Click **Start import**.

The import runs on the server and shows its progress as it goes. When it's done, Studio shows how many tables, users and files it imported, and any warnings below.

## Import from the command line

Run `./keel import-supabase` in your Keel install folder. The project must already exist.

```bash
./keel import-supabase --project my-app \
  --db-url 'postgresql://postgres.abcd1234:YOUR_DB_PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres' \
  --url https://abcd1234.supabase.co \
  --service-key YOUR_SUPABASE_SERVICE_ROLE_KEY
```

| Option | Description |
|---|---|
| `--db-url URL` | **Required.** The source's Postgres connection string. Put it in single quotes. |
| `--url URL` | The Supabase project URL. Needed, with `--service-key`, to copy files. |
| `--service-key KEY` | The Supabase `service_role` key. |
| `--project NAME` | The Keel project to import into. Default: `KEEL_DEFAULT_PROJECT` (`my-app`). |
| `--no-schema` | Skip schemas, data, extensions, policies and realtime settings. |
| `--no-auth` | Skip users, identities, MFA factors and triggers on `auth.users`. |
| `--no-storage` | Skip buckets and files. |

Warnings are printed with a `warning:` prefix, and the last line says how many there were.

## After the import

1. **Read the warnings.** They list objects that couldn't be recreated, such as functions that depend on a missing extension.
2. **Deploy your edge functions** from your app's repository (the folder that contains `supabase/functions`), and set their secrets again. Run the `keel` script from your Keel install folder by its path:

   ```bash
   cd ~/code/my-app
   ~/keel/keel functions deploy --project my-app
   ~/keel/keel secrets set --env-file supabase/.env --project my-app
   ```

   See [Deploying](/functions/deploying) and [Secrets](/functions/secrets).
3. **Set up sign-in** under **Users > Sign-in settings**: the Site URL and redirect URLs, the mail server, sign-in providers, and SMS. For OAuth, register Keel's callback URL (`<KEEL_PUBLIC_URL>/my-app/auth/v1/callback`, shown on that screen) with each provider. Custom OpenID Connect providers keep their `custom:<id>` identifiers if you add them under the same id.
4. **Point your app at Keel.** Change the URL and the anon key:

   ```diff
   - const supabase = createClient('https://abcd1234.supabase.co', SUPABASE_ANON_KEY)
   + const supabase = createClient('http://192.168.1.20:8000/my-app', KEEL_ANON_KEY)
   ```

5. **Tell your users to sign in again.** Their passwords and linked provider accounts work as before, but sessions from Supabase aren't valid in Keel.
6. **Schedule your cron jobs again.** The importer doesn't copy Supabase's `cron` schema. List them on Supabase with `select jobname, schedule, command from cron.job;` and run the same `cron.schedule(...)` calls in the Keel project; Keel has the same functions. See [Scheduled jobs](/database/cron) and, for webhooks and `net.http_post`, [Database webhooks](/database/webhooks).

## Who owns the imported objects

The importer treats the Supabase project as untrusted input. It restores your schema as a dedicated role, `keel_import_<database>` (for example `keel_import_my_app`), which isn't a superuser and can only log in while an import runs. That role owns the imported tables and functions, so `SECURITY DEFINER` functions and other code from the source run with its limited rights, never as the Postgres superuser. It can use your project's schemas and read and reference `auth.users`, `auth.identities`, `storage.objects` and `storage.buckets`, much like Supabase's `postgres` role.

Triggers on `auth.users` and policies on the storage and realtime tables are created by the role that owns those tables (`keel_auth_admin`, `keel_storage_admin` or `keel_realtime_admin`), never the superuser, one statement each: a definition that holds more than one statement is refused with the warning `cannot insert multiple commands into a prepared statement`. Keel's own triggers on `auth.users` (named `keel_…`) are never replaced. Files whose bucket or name contains `.` or `..` path segments, backslashes or control characters are skipped with a warning, and the importer doesn't follow redirects from the project URL. A file whose content type isn't a single valid `type/subtype` is stored with the type the source serves it with, or `application/octet-stream`.

You can still change anything from Studio's SQL editor, which runs as the superuser. If an imported `SECURITY DEFINER` function needs more rights, grant them to its owner role there.

### Views

Imported views keep their `security_invoker` setting from Supabase. A view without it runs as its owner, the import role, which owns the tables too, so it skips their row level security, just as it did on Supabase. Views you create in Keel follow the tables' policies by default (see [Row level security](/database/row-level-security#views)). To make an imported view do the same:

```sql
alter view public.my_view set (security_invoker = true);
```

## Running it again

The importer is built for an empty project. If you run it again into the same project:

- Users that already exist (same ID) are left as they are; new ones are added.
- Tables and other objects that already exist clash. The errors appear as warnings, and data for those tables may fail to load or be added twice.
- Files are copied again and overwrite the existing ones. Existing buckets are kept.
- Policies on storage and realtime tables, and triggers on `auth.users`, are replaced with the source's versions.

For a clean second attempt, delete the project (**Project settings > Delete project**), create it again with the same name and import into it. The new project gets new API keys, and uploaded files from the first attempt stay in the storage folder.

To retry only the files, run the CLI with `--no-schema --no-auth`.

## Troubleshooting

| Message | Fix |
|---|---|
| "The database URL should look like postgresql://…" or "Paste the Postgres connection string" | Copy the whole connection string, starting with `postgresql://`. URL-encode special characters in the password. |
| Connection timeouts | Use the session pooler string. The direct connection needs IPv6, and the Keel server needs internet access. |
| "password authentication failed" | The database password in the string is wrong. Reset it in Supabase. |
| "The source runs a newer Postgres (…) than Keel (17). Update Keel first." | The source's Postgres major version is newer than Keel's. |
| "The target project already has N table(s) in public" | Import into a fresh project. |
| "Extensions not available in Keel: …" | Objects that use them won't import. Recreate them without the extension, or leave them out. |
| "Files were not copied: give the project URL and service_role key" | Add both values, then retry the files with `--no-schema --no-auth`. |
| "the service_role key was refused" | You pasted the anon key or a different project's key. Use the `service_role` JWT. |
| "the project URL answered with a redirect" | Use the project URL exactly as Supabase shows it, starting with `https://`. |
| "skipped: the bucket or file name is not allowed" | The file's path has `.` or `..` segments, a backslash or a control character. Download it from Supabase and upload it under another name. |
| `project "my-app" does not exist` (CLI) | Create the project in Studio first, or pass the right `--project`. |
| "An import is already running for this project" | Wait for the running import to finish. |
| "Skipped N grant(s) involving Supabase-internal roles" | Nothing to do. Grants to roles that exist only on Supabase don't apply in Keel. |
