# Tables and data

Create tables in Studio or with SQL. A new table in the `public` schema shows up in the REST API right away, with row level security switched on so nothing is exposed until you add a policy.

```sql
create table bookmarks (
  id bigint generated always as identity primary key,
  url text not null,
  title text,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create policy "Users manage their own bookmarks" on bookmarks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
```

```js
await keel.from('bookmarks').insert({ url: 'https://postgresql.org', title: 'Postgres' })
```

## Create a table in Studio

1. Open the **New table** panel: click the **+** button (New table) in the tools at the bottom right of the canvas, or press <kbd>⌘K</kbd> (<kbd>Ctrl+K</kbd>) and pick **New table**. In a project without tables, the canvas shows a **New table** button.
2. Enter a **Table name**. Use lowercase letters, digits and underscores (other characters turn into `_`).
3. Set up the **Columns**. Every new table starts with:
   - `id`, type `int8`, default `identity`, primary key: a number that counts up by itself.
   - `created_at`, type `timestamptz`, default `now()`: when the row was added.
4. Add more with **Add column**, or **Owner column** for a `user_id` that's filled in with the signed-in user's ID.
5. Leave **Row level security** on (see [below](#row-level-security-on-new-tables)). Switch on **Realtime** if apps should receive changes to this table live.
6. Click **Create table**. Studio opens the new table.

For each column you set:

| Field | What it does |
|---|---|
| Name | Letters, digits and underscores. |
| Type | Pick a suggestion (`int8`, `int4`, `text`, `varchar(255)`, `bool`, `numeric`, `float8`, `uuid`, `timestamptz`, `date`, `jsonb`, `text[]`, `int8[]`, `bytea`) or type any other Postgres type. |
| Default | The value used when an insert leaves the column out. Suggestions depend on the type: `identity` for numbers, `gen_random_uuid()` or `auth.uid()` for `uuid`, `now()` for `timestamptz`, `current_date`, `true`, `false`, `'{}'`. Other text is stored as a fixed value, so use SQL for any other expression. |
| **Primary key** | Identifies each row. Tick it on several columns for a composite key. Studio needs a primary key to edit and delete rows. |
| **Required** | `not null`: the column must always have a value. |
| **Unique** | No two rows may have the same value. |
| Reference | A foreign key to `auth.users.id` (the signed-in user) or to the primary key of another table in the schema. Studio creates it with `on delete cascade`: deleting the referenced row deletes this row too. |

Studio doesn't edit the columns of an existing table yet. Use SQL for that, in the [SQL editor](/studio/sql-editor):

```sql
alter table bookmarks add column notes text;
alter table bookmarks rename column title to name;
alter table bookmarks drop column notes;
```

## Create a table with SQL

Open **SQL** in the dock and run a `create table` statement. Some choices that work well with the API:

```sql
create table projects (
  id bigint generated always as identity primary key,  -- or: id uuid primary key default gen_random_uuid()
  name text not null check (char_length(name) <= 100),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  settings jsonb not null default '{}',
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create index on projects (owner_id);
```

- **Primary keys.** `bigint generated always as identity` is compact and ordered. Use `uuid` with `gen_random_uuid()` when clients create IDs themselves or IDs must not be guessable.
- **Times.** Use `timestamptz`. It stores an exact moment, and the API returns it in ISO 8601 with a time zone.
- **Text.** Use `text`, with a `check` constraint if you need a maximum length.
- **Owner columns.** `default auth.uid()` fills in the signed-in user, so clients don't have to send it, and your policies can check it.

Tables appear on Studio's canvas and in the API as soon as the statement finishes.

## Row level security on new tables

Keel switches row level security (RLS) on for every table created in the `public` schema, however you create it: in Studio, in the SQL editor, with `psql`, an ORM or a migration tool. Until you add a policy:

- requests with the anon key or a user's token get no rows, and can't insert, update or delete;
- the service role key and Studio still see and change everything.

Add policies in Studio (click the table, then **Policies**) or with `create policy`. The [row level security guide](/database/row-level-security) has the common patterns.

To turn RLS off for one table, switch off **Row level security** under **Policies**, or run:

```sql
alter table bookmarks disable row level security;
```

::: danger
A table without row level security can be read **and changed** by anyone who has your anon key, which is public. Only turn it off for data that's meant to be world-writable, or for tables in a schema the API doesn't expose.
:::

To stop Keel from switching RLS on automatically, for the whole project:

```sql
alter database my_app set keel.auto_rls = 'off';
-- back on:
alter database my_app reset keel.auto_rls;
```

The change applies to new connections. To skip it for a single statement, set it in the same session first, for example in one SQL editor run:

```sql
set keel.auto_rls = 'off';
create table public_counters (name text primary key, hits int not null default 0);
```

In the **New table** panel, switching off **Row level security** does the same for that table. Tables in schemas other than `public` are never changed.

## Browse and edit rows in Studio

Click a table on the canvas to open it. You get its rows, 50 at a time, with **Previous** and **Next** to page through them.

- **Sort** by clicking a column header (ascending, descending, off).
- **Filter** with conditions such as equals, not equal, `>`, `≥`, `<`, `≤`, contains, in list, is null and is not null. Click **Apply**; filters combine with AND.
- **Insert row** opens a form. Fields you don't touch get the column's default; tick **NULL** to store a null value.
- Click a row to edit it, then **Save changes**. **Delete row** removes it.
- The terminal icon opens the SQL editor with a `select` on the table. The trash icon deletes the table, after you type its name to confirm.

Rows can only be edited and deleted in Studio when the table has a primary key. Views are read-only here.

::: warning Studio bypasses your policies
Studio works as the database superuser. It shows every row and saves every change, whatever your row level security policies say. To check what a user can see, test your policies as described in [Row level security](/database/row-level-security#test-your-policies).
:::

## Foreign keys and relationships

A foreign key says that a column points to a row in another table. It keeps your data consistent (a recipe can't point to a profile that doesn't exist), and it's what lets the API join tables:

```sql
create table comments (
  id bigint generated always as identity primary key,
  bookmark_id bigint not null references bookmarks on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create index on comments (bookmark_id);
```

```js
const { data } = await keel.from('bookmarks').select('url, title, comments(body, created_at)')
```

- **Index foreign key columns.** Postgres indexes primary keys but not the columns that point to them. An index on `comments (bookmark_id)` makes joins and cascading deletes fast.
- **Choose what happens on delete.** `on delete cascade` deletes the child rows, `on delete set null` keeps them with an empty reference, and the default (`no action`) refuses to delete a row that's still referenced.
- **Referencing users.** You can point a foreign key at `auth.users`, but the `auth` schema isn't in the API, so you can't join to it from a query. Keep public user details in a `profiles` table whose `id` references `auth.users`, filled in by a trigger when someone signs up. See [Database functions](/database/functions#create-a-profile-when-a-user-signs-up).

The canvas draws a line for each foreign key between two tables, and [Querying with the API](/database/querying#join-related-tables) shows the join syntax.

## Timestamps and updated_at

`created_at timestamptz not null default now()` covers when a row was added. To track the last change too, add an `updated_at` column and a trigger that sets it on every update:

```sql
alter table bookmarks add column updated_at timestamptz not null default now();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger bookmarks_set_updated_at
  before update on bookmarks
  for each row execute function public.set_updated_at();
```

Reuse `set_updated_at()` for every table that needs it: one `create trigger` per table. The `moddatetime` extension does the same job if you prefer:

```sql
create extension if not exists moddatetime with schema extensions;

create trigger bookmarks_set_updated_at
  before update on bookmarks
  for each row execute function extensions.moddatetime(updated_at);
```

## Schema changes and the API

The REST API keeps a cached copy of your schema (tables, columns, foreign keys and functions). Keel refreshes it after every schema change, so a new table, column or function is usable within about a second, without restarts.

If a request right after a change fails with "Could not find a relationship" (`PGRST200`) or "Could not find the function" (`PGRST202`), wait a moment and retry. To force a refresh, run:

```sql
notify pgrst, 'reload schema';
```

Renaming or dropping a column changes your API too: deploy app changes that stop using it first.

## Load example data

Keel's repository includes a sample schema, `examples/recipe-box.sql`: a small recipe app with `profiles`, `recipes`, `ingredients`, `recipe_ingredients`, `tags` and `meal_plans`, their policies, a trigger that creates a profile for each new user, and some recipes. The examples in these docs use it.

1. Create a project named `recipe-box` in Studio (project switcher, **New project**), or use any existing project.
2. Open the file, copy everything into the **SQL** editor, and click **Run**.

Or load it from the `keel` folder on your server:

```bash
./keel psql recipe-box < examples/recipe-box.sql
```

The script uses `if not exists` and `on conflict do nothing`, so running it again doesn't create duplicates of the tables, ingredients or tags. (Recipes are inserted again each time.) Then try it:

```js
const keel = createClient('http://localhost:8000/recipe-box', 'YOUR_ANON_KEY')

const { data } = await keel
  .from('recipes')
  .select('title, prep_min, ingredients(name)')
  .order('prep_min')
```

## Import and export CSV

Studio doesn't import or export CSV files yet. Two ways that work today:

**With `psql` on your computer,** using the connection string from Studio's **Connect** panel. `\copy` reads and writes files on the machine where `psql` runs:

```bash
psql 'postgresql://my_app_owner:PASSWORD@192.168.1.20:5432/my_app' \
  -c "\copy ingredients (name, unit, category) from 'ingredients.csv' with (format csv, header true)"

psql 'postgresql://my_app_owner:PASSWORD@192.168.1.20:5432/my_app' \
  -c "\copy (select * from recipes) to 'recipes.csv' with (format csv, header true)"
```

**Through the REST API,** which accepts and returns CSV. Use the service role key to import into a table whose policies don't allow inserts:

```bash
# Import: the first line holds the column names
curl 'http://localhost:8000/my-app/rest/v1/ingredients' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: text/csv" \
  --data-binary @ingredients.csv

# Export
curl 'http://localhost:8000/my-app/rest/v1/recipes?select=id,title,servings' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Accept: text/csv" > recipes.csv
```

In a CSV import, an empty field becomes an empty string and the word `NULL` becomes a null value. An export returns at most 1,000 rows per request (page through with `offset` and `limit`), so use `\copy` for large tables.
