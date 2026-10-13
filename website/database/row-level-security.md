# Row level security

Your tables can be reached from any browser with the anon key, so something has to decide which rows each request may read and change. In Keel, as in Supabase, that's Postgres itself: **row level security** (RLS) policies are rules attached to a table, checked on every row of every request.

```sql
create policy "Users read their own notes" on notes
  for select to authenticated
  using (user_id = (select auth.uid()));
```

With this policy, `keel.from('notes').select('*')` returns only the signed-in user's notes, with no filter in your app code.

## How it works

Every API request runs as a Postgres role, chosen from the token it carries:

| Request carries | Runs as | Row level security |
|---|---|---|
| Only the anon key | `anon` | Applies |
| A signed-in user's access token | `authenticated` | Applies |
| The service role key | `service_role` | Bypassed |

The token's claims are available to SQL, and helpers such as `auth.uid()` read them. On a table with RLS switched on:

- **No policy means no access.** The `anon` and `authenticated` roles see no rows and can't write any.
- **Policies grant access.** A row is visible if any policy for the command allows it.
- **Restrictive policies narrow it down.** A policy created `as restrictive` must also pass, on top of the others. Use them for rules that always apply, such as "needs two-factor authentication".

::: warning "authenticated" can mean anyone
`to authenticated` only means "has an account". When **Allow new sign-ups** is on and **Confirm email addresses** is off, anyone who can reach your server can create an account and is signed in at once, without proving an email address, and every `to authenticated using (true)` policy lets them in. Confirmation is off by default when there's no mail server. Studio warns about this under **Users**.

New projects on a server whose public URL isn't on your own network (not localhost, a private or Tailscale address, or a `.local`/`.lan` name) start with confirmation on, and without a mail server with sign-ups off. Existing projects keep their settings. Either way, write policies that check who the user is (`auth.uid()`, a membership table, a claim in `app_metadata`) rather than just that they're signed in.
:::

The same policies apply wherever a request touches the table: REST queries, [realtime change streams](/realtime/postgres-changes), and functions that run as the caller. Storage files and private realtime channels use policies on `storage.objects` and `realtime.messages` in the same way (see [Storage access control](/storage/access-control) and [Private channels](/realtime/authorization)).

## Turn it on

Keel switches RLS on for every new table in the `public` schema ([Tables and data](/database/tables#row-level-security-on-new-tables)), and makes new views there follow the policies of the tables they read ([Views](#views)). For other tables, or if you've turned that off:

```sql
alter table notes enable row level security;
```

In Studio, click the table on the canvas, open **Policies** and use the **Row level security** switch.

::: danger
With RLS off, anyone who has your anon key, which ships inside your app, can read and change every row of the table through the API.
:::

## Write a policy

```sql
create policy "policy name" on table_name
  as permissive              -- or restrictive
  for select                 -- insert, update, delete or all
  to authenticated           -- anon, authenticated, or both; leave out for every role
  using (...)                -- which existing rows the policy covers
  with check (...);          -- which new or changed rows are allowed
```

`using` filters the rows a command can see or touch. `with check` validates the rows it writes. Which ones a command uses:

| Command | `using` | `with check` |
|---|---|---|
| `select` | rows the user can read | |
| `insert` | | rows the user can add |
| `update` | rows the user can change | what the changed rows must look like (defaults to the `using` expression) |
| `delete` | rows the user can delete | |
| `all` | all of the above | inserts and updates |

A row that fails `using` is skipped silently. A row that fails `with check` makes the whole request fail with error `42501`, "new row violates row-level security policy".

::: tip Updates and deletes need a select policy too
Postgres only lets a statement update or delete rows it can read. If an update from your app changes nothing, add a `select` policy for the same rows. An upsert needs `insert` and `update` policies (and `select` to return the rows).
:::

To change a policy, use `alter policy` (it can change the roles and expressions, but not the command), or drop it and create it again:

```sql
alter policy "Users read their own notes" on notes
  to authenticated
  using (user_id = (select auth.uid()));

drop policy "Users read their own notes" on notes;
```

## Helper functions

Policies identify the caller with these functions, which read the request's token:

| Function | Returns |
|---|---|
| `auth.uid()` | The user's ID (`sub` claim) as a `uuid`. `null` for anon requests. |
| `auth.role()` | `anon`, `authenticated` or `service_role`. |
| `auth.email()` | The user's email address. |
| `auth.jwt()` | All the token's claims as `jsonb`. |

Useful claims in `auth.jwt()`: `app_metadata` and `user_metadata` (objects), `aal` (`aal1`, or `aal2` after two-factor authentication), `is_anonymous`, `phone`, `session_id`. See [Sessions and tokens](/auth/sessions) for the full token.

::: warning Don't authorize with user_metadata
Users can change their own `user_metadata` with `keel.auth.updateUser({ data })`. Only the service role can change `app_metadata`, so put roles and permissions there.
:::

The API roles can't read the `auth.users` table directly. Use the token's claims, or your own tables such as `profiles`, in policies.

## Common patterns

### Owner-only rows

Each row belongs to one user, who can do anything with it:

```sql
create table notes (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  body text not null
);
create index on notes (user_id);

create policy "Owners manage their notes" on notes for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
```

`default auth.uid()` fills in the owner on insert, and `with check` stops users from inserting or moving rows into someone else's name.

### Public read, owner write

Anyone can read published posts; authors write their own:

```sql
create table posts (
  id bigint generated always as identity primary key,
  author_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  published boolean not null default false
);
create index on posts (author_id);

create policy "Anyone reads published posts" on posts for select to anon, authenticated
  using (published);

create policy "Authors read their drafts" on posts for select to authenticated
  using (author_id = (select auth.uid()));

create policy "Authors add posts" on posts for insert to authenticated
  with check (author_id = (select auth.uid()));

create policy "Authors edit their posts" on posts for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));

create policy "Authors delete their posts" on posts for delete to authenticated
  using (author_id = (select auth.uid()));
```

### Teams

Members of a team share its rows. Membership lives in its own table:

```sql
create table teams (
  id bigint generated always as identity primary key,
  name text not null
);

create table team_members (
  team_id bigint not null references teams on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null default 'member',
  primary key (team_id, user_id)
);
create index on team_members (user_id);

create table documents (
  id bigint generated always as identity primary key,
  team_id bigint not null references teams on delete cascade,
  title text not null
);
create index on documents (team_id);
```

The policies need "the teams I belong to", which means reading `team_members`. A policy on `team_members` that queries `team_members` checks its own policy again, and Postgres stops with `infinite recursion detected in policy`. Put the lookup in a `security definer` function instead: it runs as its owner, which isn't subject to RLS. Keep it in a schema the API doesn't expose:

```sql
create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.my_team_ids()
returns setof bigint
language sql stable security definer
set search_path = ''
as $$
  select team_id from public.team_members where user_id = auth.uid();
$$;

create policy "Members read their teams" on teams for select to authenticated
  using (id in (select private.my_team_ids()));

create policy "Members see their teammates" on team_members for select to authenticated
  using (team_id in (select private.my_team_ids()));

create policy "Members work with team documents" on documents for all to authenticated
  using (team_id in (select private.my_team_ids()))
  with check (team_id in (select private.my_team_ids()));
```

Who may add members is up to you, for example an `insert` policy on `team_members` that requires the caller's own `role` to be `'owner'`, checked through a second helper function in the same way.

### Admins

Give some users an `admin` role in their `app_metadata`, then let it through in a policy:

```sql
create policy "Admins manage all documents" on documents for all to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
```

Set the role from a server with the service role key, or in the SQL editor:

::: code-group

```js [JavaScript]
await admin.auth.admin.updateUserById(userId, { app_metadata: { role: 'admin' } })
```

```sql [SQL]
update auth.users
set raw_app_meta_data = raw_app_meta_data || '{"role": "admin"}'
where email = 'ada@example.com';
```

:::

Claims are copied into the access token when it's issued, so the change takes effect at the user's next sign-in or token refresh (within an hour by default).

### Require two-factor authentication

After a user verifies a second factor, their token has `aal` set to `aal2`. A restrictive policy adds that requirement on top of the table's other policies:

```sql
create policy "Requires two-factor authentication" on invoices
  as restrictive
  for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');
```

Users who haven't set up a second factor can't pass it. See [Two-factor authentication](/auth/mfa) for enrolling and verifying factors.

### Anonymous users

[Anonymous users](/auth/anonymous) sign in without an email or phone, and they get the `authenticated` role like everyone else. Their token has `is_anonymous` set to `true`, so you can hold back some actions until they create a real account:

```sql
create policy "Only permanent users can post" on posts
  as restrictive
  for insert to authenticated
  with check ((select (auth.jwt() ->> 'is_anonymous')::boolean) is false);
```

## Performance

Policies run for every row a query looks at, so they're worth a little care on big tables:

- **Index the columns your policies use**, such as `user_id` and `team_id`.
- **Wrap the helpers in `select`**: `(select auth.uid())` instead of `auth.uid()`. Postgres then works the value out once per query instead of once per row.
- **Name the roles** with `to authenticated` or `to anon`, so Postgres skips policies that can't apply to the caller.
- **Filter in your queries too.** `.eq('user_id', user.id)` alongside the policy helps Postgres pick the index.
- **Look up memberships in a function that returns a set**, as in the [teams pattern](#teams), instead of a join inside the policy.

To see what a policy costs, run `explain analyze` on the query in the SQL editor while switched to the user's role (next section).

## Test your policies

Studio's SQL editor runs as the superuser, which ignores policies. Switch to an API role inside a transaction and set the claims a user's token would carry:

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b", "role": "authenticated"}';

select * from notes;                    -- only this user's rows
insert into notes (body) values ('hi'); -- checked against with check

rollback;
```

Take a real user ID from **Users** in Studio. Use `set local role anon;` without claims to test as a signed-out visitor, and add `"aal": "aal2"` or `"app_metadata": {"role": "admin"}` to the claims to test those patterns. More in [SQL editor](/studio/sql-editor#testing-row-level-security).

From your app, the quickest check is to sign in as two different users and confirm that neither sees the other's rows, and that a request with only the anon key gets an empty array.

## What bypasses row level security

- **The service role key.** The `service_role` role has `bypassrls`. Use it only on servers you control.
- **The `postgres` superuser:** Studio (SQL editor and table views) and `./keel psql`.
- **The project's owner role** (`my_app_owner`): [direct connections](/database/connecting-directly), migrations, ORMs and coding agents connected with the connection string from Studio. It owns the tables in `public`, so their policies don't apply to it, and policies give it every row of storage and realtime. Code that connects this way has to do its own authorization.
- **`security definer` functions.** They run as their owner, which is the project's owner role (`my_app_owner`) for functions in `public`, also when you create them in Studio. See [Database functions](/database/functions#security-invoker-and-security-definer).
- **Views that run as their owner**: views created with `security_invoker = false`, views outside `public`, older or imported views without `security_invoker`, and all materialized views. See [Views](#views).

## Views

Postgres normally runs a view with its owner's rights, which for views in `public` is the project's owner role, the owner of the tables, so the view would skip the policies of the tables it reads. Keel sets `security_invoker` on every view you create (or replace) in the `public` schema, so the view reads its tables as the caller and their policies apply:

```sql
create view public_post_titles as
  select id, title from posts;
-- Signed-out visitors see only published posts' titles, as the policies on posts allow.
```

- **To opt out** for a view that should show more than the caller could read, such as a public summary, say so when you create it, and grant it only to the roles that should see it: `create view post_counts with (security_invoker = false) as …`. Keel keeps an explicit setting. `alter view … set (security_invoker = false)` also works, until the view is replaced.
- **Materialized views can't do this.** They store their rows when they're refreshed, so anyone allowed to select from one sees all of it. Keep them out of the API: create them in another schema, or `revoke select on my_matview from anon, authenticated`.
- **Older views.** Views created before Keel did this, views [imported from Supabase](/self-hosting/migrate-from-supabase) and views in other schemas keep their setting. Switch one with `alter view my_view set (security_invoker = true);`.
- The same setting as automatic RLS turns this off: `alter database my_app set keel.auto_rls = 'off';` (see [Tables and data](/database/tables#row-level-security-on-new-tables)).

## Policies in Studio

Click a table on the canvas and open **Policies** (the button shows how many the table has). The panel has the table's **Row level security** and **Realtime** switches and its list of policies, with a trash icon to delete each one.

**New policy** opens a form:

| Field | |
|---|---|
| Templates | **Everyone can read**, **Signed-in users can read**, and **Users manage their own rows** (offered when the table has a column referencing `auth.users`, or one named `user_id`). A template fills in the form. |
| **Name** | Shown in Studio and in error messages. |
| **Command** | `SELECT`, `INSERT`, `UPDATE`, `DELETE` or `ALL`. |
| **Applies to** | `anon`, `authenticated`, or both. With neither ticked, the policy applies to every role. |
| **Using (which existing rows)** | The `using` expression, for every command except `INSERT`. |
| **With check (which new rows)** | The `with check` expression, for `INSERT`, `UPDATE` and `ALL`. |

Click **Create policy** to save it. Studio creates permissive policies and can't edit existing ones: use `alter policy` in the SQL editor, or delete the policy and create it again.
