# Database functions (RPC)

Postgres functions in the `public` schema are API endpoints. Call them from your app with `keel.rpc()` when a job doesn't fit a single query: several writes that must happen together, a calculation, a search with custom logic, or a counter that users may bump but not edit.

```sql
create or replace function public.add_numbers(a int, b int)
returns int
language sql immutable
as $$
  select a + b;
$$;
```

::: code-group

```js [JavaScript]
const { data, error } = await keel.rpc('add_numbers', { a: 2, b: 40 })
console.log(data) // 42
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/rpc/add_numbers' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"a": 2, "b": 40}'
```

:::

## Create a function

Run `create function` in the [SQL editor](/studio/sql-editor). The function is callable through the API a moment later: Keel reloads the API's schema after every change.

```sql
create or replace function public.recipe_stats(min_servings int default 1)
returns jsonb
language sql stable
as $$
  select jsonb_build_object(
    'recipes', count(*),
    'avg_prep_min', round(avg(prep_min))
  )
  from public.recipes
  where servings >= min_servings;
$$;
```

```js
const { data } = await keel.rpc('recipe_stats', { min_servings: 4 })
// { recipes: 5, avg_prep_min: 42 }
```

The function runs with the caller's permissions, so with the anon key it only counts the public recipes that row level security lets visitors see.

- **Arguments are passed by name.** The keys of the object you pass to `rpc()` match the function's parameter names. Parameters with a `default` are optional.
- **The return type shapes the response.** A scalar (`int`, `text`, `boolean`) or `json`/`jsonb` comes back as that value; `setof` a table or `returns table (...)` comes back as an array of rows; `void` returns no data.
- **Mark functions that only read as `stable`** (or `immutable` if the result depends only on the arguments). It tells Postgres it can run them in a read-only transaction, and lets you call them with GET.
- **Names are lowercased** by Postgres unless you quote them. Use `snake_case` names.
- **Overloads** with different parameter names are fine. Two versions with the same parameter names and different types can't be called through the API (error `PGRST203`).

A function with a single unnamed `json` or `jsonb` parameter receives the whole request body as that argument.

## Call a function

`keel.rpc(name, args)` sends a POST request to `/rest/v1/rpc/name` with the arguments as JSON. Options:

| Option | What it does |
|---|---|
| `get: true` | Sends a GET request with the arguments in the query string. Only works for functions that don't write: GET requests run in a read-only transaction, and a write fails with error `25006` (HTTP 405). |
| `head: true` | Returns no data, only the count (with `count`). |
| `count: 'exact'` | Counts the rows a set-returning function produced (`planned` and `estimated` work too). |

::: code-group

```js [JavaScript]
const { data } = await keel.rpc('add_numbers', { a: 2, b: 40 }, { get: true })
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/rpc/add_numbers?a=2&b=40' \
  -H "apikey: YOUR_ANON_KEY"
```

:::

POST calls to `volatile` functions (the default when you don't say) run in a read-write transaction. POST calls to `stable` and `immutable` functions run read-only, like GET.

## Functions that return rows

A function that returns rows of a table can be filtered, sorted, paginated and joined like the table itself:

```sql
create or replace function public.quick_recipes(max_minutes int)
returns setof public.recipes
language sql stable
as $$
  select * from public.recipes where prep_min <= max_minutes;
$$;
```

::: code-group

```js [JavaScript]
const { data } = await keel
  .rpc('quick_recipes', { max_minutes: 30 })
  .select('title, prep_min, author:profiles(display_name)')
  .eq('is_public', true)
  .order('prep_min')
  .limit(5)
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/rpc/quick_recipes?select=title,prep_min,author:profiles(display_name)&is_public=eq.true&order=prep_min.asc&limit=5' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"max_minutes": 30}'
```

:::

The 1,000-row limit applies to functions as it does to tables. Joins (like `author:profiles(...)`) work when the function returns `setof` an existing table; a function with `returns table (...)` can be filtered and sorted but not joined.

## Security invoker and security definer

By default a function runs as **the caller** (`security invoker`): an anon request runs it as `anon`, a signed-in user as `authenticated`. Row level security and table privileges apply inside it exactly as they would to a direct query. Prefer this whenever it works.

A `security definer` function runs as **its owner**. Functions in `public` belong to the project's owner role (`my_app_owner`), also when you create them in Studio's SQL editor or with `./keel psql`. That role owns the project's tables, so their row level security policies don't apply to it, and it can read and write every table in the project, but it isn't a superuser. That's useful for a carefully limited job the caller isn't allowed to do directly, such as bumping a counter:

```sql
alter table recipes add column views int not null default 0;

create or replace function public.count_view(recipe_id bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.recipes set views = views + 1
  where id = recipe_id and is_public;
$$;
```

```js
await keel.rpc('count_view', { recipe_id: 1 })
```

Anyone can now add one view to a public recipe, without having permission to update recipes. When you write one:

- **Set `search_path = ''`** and write every name with its schema (`public.recipes`, `auth.uid()`), so the function never picks up an object from somewhere unexpected.
- **Do only what's needed,** and check the caller yourself where it matters: `auth.uid()` still returns the user who made the request.
- **Keep helpers out of the API.** A `security definer` function that only your policies need (like the [team lookup](/database/row-level-security#teams)) belongs in a schema the API doesn't expose, such as `private`.

## Who can call a function

Postgres lets everyone execute a new function, and Keel grants the API roles (`anon`, `authenticated` and `service_role`) execute permission on functions that `postgres` creates in `public`. So every function in `public` can be called with the anon key, unless you take that away.

To allow only signed-in users, revoke it from both `public` (Postgres's name for "every role") and `anon`:

```sql
revoke execute on function public.count_view(bigint) from public, anon;
grant execute on function public.count_view(bigint) to authenticated;
```

An anon call then fails with error `42501` (HTTP 401). Inside the function you can also refuse callers by hand:

```sql
create or replace function public.leave_team(team bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  delete from public.team_members where team_id = team and user_id = auth.uid();
end;
$$;
```

## Return errors

`raise exception` in a function stops it, rolls back its changes and becomes an error in your app:

```sql
raise exception 'Not enough stock' using detail = 'Only 2 left', hint = 'Lower the quantity';
```

```js
const { error } = await keel.rpc('place_order', { item_id: 7, quantity: 5 })
// error: { code: 'P0001', message: 'Not enough stock', details: 'Only 2 left', hint: 'Lower the quantity' }
```

That's HTTP 400. To answer with another status, raise an error whose code is `PT` plus the status, for example `raise sqlstate 'PT409' using message = 'Already booked';` for HTTP 409.

## Triggers

A trigger runs a function automatically when rows are inserted, updated or deleted. Trigger functions return `trigger` and can't be called through the API. Two you'll likely want:

- **`updated_at` timestamps.** See [Tables and data](/database/tables#timestamps-and-updated-at).
- **Broadcasting changes** to realtime channels with `realtime.broadcast_changes()`. See [Broadcast from the database](/realtime/database-broadcast).

### Create a profile when a user signs up

User accounts live in `auth.users`, which the API doesn't expose. Most apps keep a `profiles` table with the public parts and fill it from a trigger on `auth.users`, exactly as on Supabase:

```sql
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create policy "Profiles are readable" on public.profiles for select using (true);
create policy "Users edit their own profile" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

- `raw_user_meta_data` holds the `data` your app passed to `signUp()`, for example `keel.auth.signUp({ email, password, options: { data: { full_name: 'Ada Lovelace' } } })`.
- The function must be `security definer`: Keel's auth service inserts users with its own database role, which has no access to your tables.
- The trigger runs inside the sign-up. If it fails, the sign-up fails too, so keep it simple.

The [recipe-box example](/database/tables#load-example-data) includes this trigger.
