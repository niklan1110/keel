# Scheduled jobs (cron)

Run SQL on a schedule: clean up old rows every night, refresh a materialized view every hour, or call an [edge function](/functions/overview) every few minutes with [`net.http_post`](/database/webhooks). Keel has the same SQL functions as Supabase's Cron module (the `pg_cron` extension), so Supabase migrations that schedule jobs work unchanged.

```sql
-- Every night at 03:30 (UTC)
select cron.schedule(
  'nightly-cleanup',
  '30 3 * * *',
  $$delete from public.events where created_at < now() - interval '30 days'$$
);

-- Every 10 seconds
select cron.schedule('heartbeat', '10 seconds', $$update public.status set seen_at = now()$$);

-- Stop a job
select cron.unschedule('nightly-cleanup');
```

Run these in Studio's [SQL editor](/studio/sql-editor), in a migration, or connected [directly](/database/connecting-directly) as the project's owner role. Studio's **Jobs** tool lists the jobs and their recent runs.

## Schedules

A schedule is five fields, `minute hour day-of-month month day-of-week`, in UTC:

| Field | Values |
|---|---|
| minute | `0`-`59` |
| hour | `0`-`23` |
| day of month | `1`-`31`, or `$` for the last day of the month |
| month | `1`-`12` or `jan`-`dec` |
| day of week | `0`-`7` (0 and 7 are Sunday) or `sun`-`sat` |

Each field takes `*`, a number, a range (`1-5`), a list (`1,15`), and a step (`*/10`, `8-18/2`). When both day fields are restricted, a job runs when either matches, as in standard cron. `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly` and `@annually` work too.

For jobs more often than once a minute, use `'N seconds'` with N from 1 to 59. It can't be combined with the other fields.

| Schedule | Runs |
|---|---|
| `*/5 * * * *` | every 5 minutes |
| `0 * * * *` | at the start of every hour |
| `0 0 * * 1-5` | at midnight, Monday to Friday |
| `0 9 $ * *` | at 09:00 on the last day of every month |
| `30 seconds` | every 30 seconds |

A schedule that doesn't parse is refused when you set it.

## Functions

```sql
cron.schedule(job_name text, schedule text, command text) returns bigint
cron.schedule(schedule text, command text) returns bigint
cron.unschedule(job_name text) returns boolean
cron.unschedule(job_id bigint) returns boolean
cron.alter_job(job_id bigint, schedule text default null, command text default null,
               database text default null, username text default null, active boolean default null) returns void
cron.schedule_in_database(job_name text, schedule text, command text, database text,
                          username text default null, active boolean default true) returns bigint
```

- `cron.schedule` returns the job's id. Scheduling a name that already exists replaces that job's schedule and command.
- `cron.alter_job(id, active := false)` pauses a job; `active := true` resumes it.
- `cron.schedule_in_database` accepts only the project's own database: each Keel project is its own database.

## Jobs and runs

`cron.job` holds the jobs and `cron.job_run_details` one row per run, with the same columns as `pg_cron`:

```sql
select jobid, jobname, schedule, active from cron.job;

select jobid, status, return_message, start_time, end_time
  from cron.job_run_details
 order by start_time desc
 limit 20;
```

`status` is `starting`, `running`, `succeeded` or `failed`. `return_message` holds the result (`INSERT 0 1`, `3 rows`) or the error.

## How jobs run

- **As the project's owner role.** A job runs on a connection of its own, logged in as `<database>_owner`, the role Studio's **Connect** panel hands out. That's also true for jobs scheduled from Studio's SQL editor, which runs as `postgres`: no job ever runs as a superuser. The command can use anything the owner role can: your tables in `public`, `auth.users`, `storage.objects`, `net.http_post`.
- **One run at a time.** If a job is still running when it's due again, that turn is skipped.
- **Each command is one transaction**, unless it contains its own `begin`/`commit`. Several statements separated by `;` are fine.
- **Time limit.** A run is stopped after `KEEL_CRON_TIMEOUT` seconds (300 by default), even if the command changes its own `statement_timeout`.
- **At most `KEEL_CRON_MAX_RUNNING` jobs of a project run at once** (4 by default). A job that is due while the project is at the limit runs at its next turn.
- **History** in `cron.job_run_details` is kept for `KEEL_CRON_HISTORY_DAYS` days (7 by default).
- **Missed runs aren't caught up.** Jobs are run by `keel-studio`; while it's stopped or restarting, nothing runs, and runs it interrupted are marked `failed`.

## Who can schedule jobs

The project's owner role and the `postgres` superuser, as on Supabase. The API roles (`anon`, `authenticated`, `service_role`) have no access to the `cron` schema, so jobs can't be created or read through the REST API. The owner role sees only its own jobs (row level security on `cron.job`, as in `pg_cron`).

## Differences from pg_cron

- The `pg_cron` extension isn't installed: `create extension pg_cron` isn't needed (and fails). The `cron` schema is in every project already.
- Times are UTC (`pg_cron`'s default); `cron.timezone` can't be changed.
- `@reboot` isn't supported.
- Jobs run in their own project's database, as its owner role.

See [Limits](/reference/limits) and [Configuration](/self-hosting/configuration#scheduled-jobs-and-outgoing-requests) for the settings.
