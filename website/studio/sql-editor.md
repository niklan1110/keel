# SQL editor

The SQL editor runs any SQL against the current project's database, straight from Studio. Open it with **SQL** in the dock, with **Open SQL editor** in the palette (<kbd>⌘K</kbd>), or with the terminal icon in a table's drawer, which starts a `select` on that table.

```sql
create table notes (
  id bigint generated always as identity primary key,
  body text not null,
  created_at timestamptz not null default now()
);
insert into notes (body) values ('first'), ('second');
select * from notes order by id;
```

Press **Run** or <kbd>⌘↵</kbd> (<kbd>Ctrl+Enter</kbd> on Windows and Linux). To run only part of what you've written, select it first: Studio runs the selection and ignores the rest.

## How your SQL runs

- **As the Postgres superuser** (`postgres`), in the project's own database (`my_app` for the project `my-app`). Row level security doesn't apply, and there's nothing you can't do: create extensions, change roles, drop tables.
- **On a fresh connection for every run.** Settings made with `set`, temporary tables and open transactions end when the run finishes. A `begin` without a `commit` is rolled back, so it can't leave anything locked.
- **With a 60-second statement timeout.** Longer statements are canceled with an error. For long migrations or bulk loads, connect with `psql` instead (`./keel psql my-app`, see [Connecting directly](/database/connecting-directly)).
- **Up to 2 MB of SQL** per run.

::: warning The editor bypasses your policies
Because queries run as the superuser, a `select` in the editor returns every row, whatever your row level security policies say. To see what a user would see, switch roles inside a transaction, as shown in [Testing row level security](#testing-row-level-security).
:::

## Several statements at once

Separate statements with semicolons. Studio sends them together and shows one tab per statement, such as **1. CREATE**, **2. INSERT** and **3. SELECT**, and opens the last one that returned rows.

Statements sent together run in a single transaction unless you add your own `begin` and `commit`: if one fails, none of them take effect. A few commands refuse to run inside a transaction, such as `vacuum`, `create index concurrently` and `create database`. Run those on their own.

## Results

Rows appear in a grid under the editor, with the column names as headers. Hover a cell to see its full value. The line under the editor says how many rows came back and how long the query took, for example "2 rows in 3.4 ms". For statements that don't return rows it shows the command and the number of rows affected, such as "INSERT 2".

The grid shows at most the first 1,000 rows of a result. Add `limit` and `offset` to look at a specific range.

When a statement changes the schema (`create`, `alter`, `drop`, `comment`, `grant`, `revoke` or `truncate`), the canvas and the project's numbers refresh, so new tables appear right away.

## Errors

If Postgres reports an error, Studio shows its message, the line it points to (also highlighted in the editor, and counted from the top of the editor even when you ran only a selection), and any detail and hint:

```text
column "titel" does not exist (line 2)
Hint: Perhaps you meant to reference the column "notes.title".
```

## Saved queries

Your work in progress is kept in this browser, per project, so it's still there when you come back.

To keep a query for later, click **Save** and give it a name (the first line of the query is suggested). Saved queries are stored in Keel itself, per project, so they're available in any browser you sign in from. Saving again updates the open query.

The menu on the left of the toolbar (**Saved queries**, or the name of the open query) lists them. Pick one to load it, use **New query** for a blank editor, or the trash icon to delete one. There is no automatic history of the queries you've run.

## Tips

### Testing row level security

Switch to an API role inside a transaction and set the same claims a user's access token would carry. `auth.uid()`, `auth.role()` and `auth.jwt()` read them, so your policies behave exactly as they do for API requests:

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b", "role": "authenticated"}';

select * from todos;            -- only this user's rows
insert into todos (task) values ('test');   -- checked against your policies

rollback;
```

- Copy a real user ID from **Users** (click the user, then the copy button next to **User ID**).
- `set local` only lasts until the end of the transaction, and `rollback` undoes any test writes.
- To test as a signed-out visitor, use `set local role anon;` and leave out the claims.
- To test policies that require two-factor authentication, add `"aal": "aal2"` to the claims.

The [row level security guide](/database/row-level-security) has policy patterns to test this way.

### Explaining a slow query

`explain analyze` runs a query and shows the plan Postgres chose, with real timings:

```sql
explain analyze
select * from todos where user_id = '8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b';
```

Look for `Seq Scan` on large tables: an index on the filtered column usually helps (`create index on todos (user_id);`). Because `explain analyze` really runs the statement, wrap an `insert`, `update` or `delete` in `begin` and `rollback`. You can combine it with the role switch above to see the cost of your policies.

### Finding slow queries

Postgres writes every statement that takes longer than `KEEL_SLOW_QUERY_MS` milliseconds (200 by default) to the `keel-db` log. Open **Logs**, pick `keel-db`, and filter for `duration` to see them. In a source checkout, set `KEEL_SLOW_QUERY_MS` in `.env` and run `./keel up` to change the threshold; `-1` turns the log off and `0` logs every statement. The installer's and ZimaOS compose files have it fixed at 200 ms in the `keel-db` command.

For totals across many runs, Keel preloads the `pg_stat_statements` extension. Create it once per project and ask for the slowest queries:

```sql
create extension if not exists pg_stat_statements with schema extensions;

select calls, round(mean_exec_time::numeric, 1) as avg_ms, query
from extensions.pg_stat_statements
where dbid = (select oid from pg_database where datname = current_database())
order by mean_exec_time desc
limit 10;
```

Creating it in the `extensions` schema keeps it out of your REST API.

### psql commands

Backslash commands such as `\d` or `\copy` belong to the `psql` program and don't work in the editor. Use `./keel psql my-app` on the server, or query the catalog instead (`select * from information_schema.columns where table_name = 'todos';`).
