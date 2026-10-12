# Querying with the API

Read and write your tables from any app with `supabase-js`. Each call becomes one HTTP request to your project's REST API ([PostgREST](https://postgrest.org) 12.2), and [row level security](/database/row-level-security) decides which rows it can see and change.

```js
import { createClient } from '@supabase/supabase-js'

const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY')

const { data, error } = await keel
  .from('recipes')
  .select('title, prep_min, ingredients(name)')
  .eq('is_public', true)
  .lte('prep_min', 30)
  .order('prep_min')
  .limit(10)
```

Reads use the tables of the [recipe-box example](/database/tables#load-example-data); writes use the `todos` table from the [Quickstart](/guide/quickstart). The curl tabs show the same request over HTTP: the anon key goes in `apikey`, and a user's access token, when there is one, in `Authorization: Bearer`. The full HTTP reference is in [REST (database)](/api/rest).

## Results and errors

Every call resolves to an object with `data` and `error`. It doesn't throw when the database refuses a request, so check `error`:

```js
const { data, error, count, status } = await keel.from('recipes').select('title')

if (error) {
  console.error(error.code, error.message) // e.g. "42P01", 'relation "public.recipe" does not exist'
} else {
  console.log(data) // [{ title: 'Charred leek & white bean stew' }, …]
}
```

A request that row level security filters out completely isn't an error: it returns an empty array.

## Select columns

::: code-group

```js [JavaScript]
const { data } = await keel.from('recipes').select('id, title, servings')
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/recipes?select=id,title,servings' \
  -H "apikey: YOUR_ANON_KEY"
```

:::

```json
[
  { "id": 1, "title": "Charred leek & white bean stew", "servings": 4 },
  { "id": 2, "title": "Miso butter noodles", "servings": 2 }
]
```

- `select('*')` (or `select()`) returns every column.
- Rename a column in the result with `alias:column`: `select('id, name:title')`.
- Cast with `::`: `select('id::text, title')`.
- Pick fields out of `json` and `jsonb` columns with `->` (as JSON) and `->>` (as text): `select('id, settings->theme')`.

A request returns at most **1,000 rows**. Use [`range()`](#sort-and-paginate) to fetch more.

## Join related tables

When two tables are linked by a foreign key, select the related table by name with its columns in parentheses. Keel follows the foreign key for you:

::: code-group

```js [JavaScript]
const { data } = await keel
  .from('recipes')
  .select('title, author:profiles(display_name), recipe_ingredients(quantity, ingredients(name, unit))')
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/recipes?select=title,author:profiles(display_name),recipe_ingredients(quantity,ingredients(name,unit))' \
  -H "apikey: YOUR_ANON_KEY"
```

:::

```json
[
  {
    "title": "Charred leek & white bean stew",
    "author": null,
    "recipe_ingredients": [
      { "quantity": 600, "ingredients": { "name": "leek", "unit": "g" } },
      { "quantity": 480, "ingredients": { "name": "cannellini beans", "unit": "g" } }
    ]
  }
]
```

- A **many-to-one** relation (each recipe has one author) comes back as an object, or `null`.
- A **one-to-many** relation (a recipe has many `recipe_ingredients`) comes back as an array.
- A **many-to-many** relation works directly when a join table holds foreign keys to both sides as its primary key: `select('title, ingredients(name)')` goes through `recipe_ingredients` for you.
- `author:` renames the embedded result, like a column alias.
- `...profiles(display_name)` (spread) puts the related columns at the top level instead of in a nested object. It works for many-to-one relations.

If two foreign keys point to the same table, say which one to use with `!`: `select('title, author:profiles!author_id(display_name)')`. Without it, the request fails with code `PGRST201`.

Tables in the `auth` schema aren't part of the API, so you can't join to `auth.users`. Join to a `profiles` table instead ([Tables and data](/database/tables#foreign-keys-and-relationships)).

### Filter by a related table

A filter on an embedded table only filters the embedded rows. Add `!inner` to keep only the parent rows that have a match:

::: code-group

```js [JavaScript]
// Recipes that use leek, with only the matching ingredient listed
const { data } = await keel
  .from('recipes')
  .select('title, ingredients!inner(name)')
  .eq('ingredients.name', 'leek')
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/recipes?select=title,ingredients!inner(name)&ingredients.name=eq.leek' \
  -H "apikey: YOUR_ANON_KEY"
```

:::

Order and limit embedded rows with `referencedTable`:

```js
const { data } = await keel
  .from('recipes')
  .select('title, recipe_ingredients(quantity, note)')
  .order('quantity', { referencedTable: 'recipe_ingredients', ascending: false })
  .limit(3, { referencedTable: 'recipe_ingredients' })
```

## Filter rows

Chain filters after `select()`, `update()` or `delete()`. Several filters combine with AND.

| `supabase-js` | Query string | Matches rows where |
|---|---|---|
| `.eq('servings', 4)` | `servings=eq.4` | equal |
| `.neq('servings', 4)` | `servings=neq.4` | not equal |
| `.gt('prep_min', 30)` | `prep_min=gt.30` | greater than (`gte`: or equal) |
| `.lt('prep_min', 30)` | `prep_min=lt.30` | less than (`lte`: or equal) |
| `.like('title', '%Soup%')` | `title=like.*Soup*` | matches a pattern, case-sensitive |
| `.ilike('title', '%soup%')` | `title=ilike.*soup*` | matches a pattern, any case |
| `.in('id', [1, 2, 3])` | `id=in.(1,2,3)` | is one of the values |
| `.is('servings', null)` | `servings=is.null` | is `null` (also `true`, `false`) |
| `.contains('recipe_ids', [1, 2])` | `recipe_ids=cs.{1,2}` | array, `jsonb` or range contains the value |
| `.containedBy('recipe_ids', [1, 2, 3])` | `recipe_ids=cd.{1,2,3}` | is contained in the value |
| `.overlaps('recipe_ids', [1, 2])` | `recipe_ids=ov.{1,2}` | has an element in common |
| `.textSearch('title', 'leek')` | `title=fts.leek` | full-text search, see [below](#full-text-search) |
| `.match({ is_public: true, servings: 4 })` | `is_public=eq.true&servings=eq.4` | every column equals its value |
| `.not('servings', 'is', null)` | `servings=not.is.null` | the opposite of any operator |
| `.or('prep_min.lt.20,servings.gte.6')` | `or=(prep_min.lt.20,servings.gte.6)` | any condition is true |
| `.filter('title', 'ilike', '%soup%')` | `title=ilike.*soup*` | any operator, by name |

In URLs, `*` can stand in for `%` in `like` patterns, which saves you from URL-encoding it.

::: code-group

```js [JavaScript]
const { data } = await keel
  .from('recipes')
  .select('title, servings, prep_min')
  .ilike('title', '%soup%')
  .gte('servings', 4)
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/recipes?select=title,servings,prep_min&title=ilike.*soup*&servings=gte.4' \
  -H "apikey: YOUR_ANON_KEY"
```

:::

### Or, and, not

`or()` takes PostgREST's filter syntax, `column.operator.value`, separated by commas. Nest `and()` inside it:

::: code-group

```js [JavaScript]
// Quick recipes, or big ones that are still under an hour
const { data } = await keel
  .from('recipes')
  .select('title')
  .or('prep_min.lt.20,and(servings.gte.6,prep_min.lt.60)')
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/recipes?select=title&or=(prep_min.lt.20,and(servings.gte.6,prep_min.lt.60))' \
  -H "apikey: YOUR_ANON_KEY"
```

:::

If a value contains a comma, period, colon or parentheses, wrap it in double quotes: `.or('title.eq."Soup, tomato",title.eq.Pancakes')`.

### JSON columns

Filter on a field inside a `json` or `jsonb` column with the same arrows as in `select`. `->>` compares as text. For a `notes` table with a `meta` column:

```js
const { data } = await keel.from('notes').select('body, meta->status').eq('meta->>status', 'draft')
```

### Full-text search

`textSearch()` uses Postgres's full-text search, which matches words regardless of their form ("stews" finds "stew"):

::: code-group

```js [JavaScript]
const { data } = await keel
  .from('recipes')
  .select('title')
  .textSearch('title', 'leek stew', { type: 'websearch', config: 'english' })
```

```bash [curl]
curl -G 'http://localhost:8000/my-app/rest/v1/recipes' \
  --data-urlencode 'select=title' \
  --data-urlencode 'title=wfts(english).leek stew' \
  -H "apikey: YOUR_ANON_KEY"
```

:::

`type` is `websearch` (Google-like syntax: quotes, `or`, `-word`), `plain` (all the words) or `phrase` (the words in order). Without a `type`, the query uses Postgres's `to_tsquery` syntax, such as `'leek & stew'`.

On bigger tables, search a stored `tsvector` column with an index instead of a text column:

```sql
alter table recipes
  add column fts tsvector generated always as (to_tsvector('english', title)) stored;
create index recipes_fts_idx on recipes using gin (fts);
```

```js
await keel.from('recipes').select('title').textSearch('fts', 'leek stew', { type: 'websearch', config: 'english' })
```

## Sort and paginate

::: code-group

```js [JavaScript]
const { data } = await keel
  .from('recipes')
  .select('title, prep_min')
  .order('prep_min', { ascending: false, nullsFirst: false })
  .order('title')
  .range(0, 9) // rows 0 to 9: the first 10
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/recipes?select=title,prep_min&order=prep_min.desc.nullslast,title.asc&offset=0&limit=10' \
  -H "apikey: YOUR_ANON_KEY"
```

:::

- `order()` sorts ascending unless you pass `ascending: false`. Call it again to add a second sort column.
- `limit(n)` returns at most `n` rows.
- `range(from, to)` returns rows `from` to `to`, counting from 0 and including both ends. Over HTTP, use `offset` and `limit`, or a `Range: 0-9` header.

To show "page 3 of 12", ask for a [count](#count-rows) along with the page. Always sort when you paginate, or Postgres may return rows in a different order on each request.

## Count rows

::: code-group

```js [JavaScript]
// Only the count, no rows
const { count } = await keel
  .from('recipes')
  .select('*', { count: 'exact', head: true })
  .eq('is_public', true)

// A page of rows plus the total
const { data, count: total } = await keel
  .from('recipes')
  .select('id, title', { count: 'exact' })
  .range(0, 4)
```

```bash [curl]
curl -i 'http://localhost:8000/my-app/rest/v1/recipes?select=id,title&limit=5' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Prefer: count=exact"

# HTTP/1.1 206 Partial Content
# Content-Range: 0-4/9
```

:::

`exact` counts every matching row, which gets slow on very large tables. `planned` uses Postgres's statistics instead (fast, approximate), and `estimated` counts exactly up to the 1,000-row limit and uses the statistics above it.

## Get one row

`single()` returns an object instead of an array, and an error if the query matches no rows or more than one. `maybeSingle()` returns `null` when nothing matches:

::: code-group

```js [JavaScript]
const { data: recipe, error } = await keel.from('recipes').select('*').eq('id', 1).single()

const { data: profile } = await keel.from('profiles').select('*').eq('id', userId).maybeSingle()
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/recipes?select=*&id=eq.1' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Accept: application/vnd.pgrst.object+json"
```

:::

When `single()` doesn't find exactly one row, `error.code` is `PGRST116` ("JSON object requested, multiple (or no) rows returned").

## Insert rows

::: code-group

```js [JavaScript]
const { data: todo, error } = await keel
  .from('todos')
  .insert({ task: 'Buy leeks' })
  .select()
  .single()
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/todos?select=*' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"task": "Buy leeks"}'
```

:::

```json
[{ "id": 7, "task": "Buy leeks", "done": false, "user_id": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b", "created_at": "2026-10-03T09:12:44.105+00:00" }]
```

- Columns you leave out get their default: `done` becomes `false`, and `user_id` the signed-in user, from `default auth.uid()`.
- Without `.select()`, an insert returns no data (`data` is `null`). Add it to get the new rows back, including generated IDs. Returning them needs a policy that lets the user **read** the new row, not only insert it.
- If a policy's `with check` rejects the row, `error.code` is `42501` ("new row violates row-level security policy").

### Insert many rows

Pass an array. All rows are inserted in one statement: if one fails, none are saved.

```js
const { data, error } = await keel
  .from('todos')
  .insert(
    [{ task: 'Soak beans' }, { task: 'Char the leeks', done: true }],
    { defaultToNull: false },
  )
  .select()
```

In a bulk insert, a column that some rows leave out is set to `null` in those rows, not to its default. Pass `defaultToNull: false` (as above) to use the default instead. Here it gives the first row `done = false` rather than a `not null` error.

## Update rows

::: code-group

```js [JavaScript]
const { data, error } = await keel
  .from('todos')
  .update({ done: true })
  .eq('id', 7)
  .select()
```

```bash [curl]
curl -X PATCH 'http://localhost:8000/my-app/rest/v1/todos?id=eq.7&select=*' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"done": true}'
```

:::

::: warning Always add a filter
`update()` and `delete()` change **every row the policies allow** when you leave out the filters. Keel doesn't block unfiltered updates and deletes.
:::

An update only reaches rows the user can read. If it changes nothing, check that the table has a `select` policy as well as an `update` policy. Rows that the policies hide are skipped silently: `data` is an empty array, not an error.

## Upsert

`upsert()` inserts rows, or updates them when a row with the same key exists. It needs a primary key or a unique constraint to recognize duplicates; name it with `onConflict` if it isn't the primary key. This example runs on a server with the service role key, because the example's `ingredients` table has no insert policy:

::: code-group

```js [JavaScript]
const admin = createClient('http://localhost:8000/my-app', process.env.KEEL_SERVICE_ROLE_KEY)

const { data, error } = await admin
  .from('ingredients')
  .upsert(
    [
      { name: 'leek', unit: 'g', category: 'vegetable' },
      { name: 'lemon', unit: 'pc', category: 'fruit' },
    ],
    { onConflict: 'name' },
  )
  .select()
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/ingredients?on_conflict=name&select=*' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: resolution=merge-duplicates, return=representation" \
  -d '[{"name": "leek", "unit": "g", "category": "vegetable"}, {"name": "lemon", "unit": "pc", "category": "fruit"}]'
```

:::

- `ignoreDuplicates: true` keeps the existing row and skips the new one (`Prefer: resolution=ignore-duplicates`).
- With row level security, an upsert needs policies for both `insert` and `update` (and `select` to return the rows).

## Delete rows

::: code-group

```js [JavaScript]
const { error } = await keel.from('todos').delete().eq('id', 7)
```

```bash [curl]
curl -X DELETE 'http://localhost:8000/my-app/rest/v1/todos?id=eq.7' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

:::

Add `.select()` to get the deleted rows back. As with updates, a delete only reaches rows the user can read.

## Call database functions

Postgres functions in the `public` schema are API endpoints too:

```js
const { data, error } = await keel.rpc('add_numbers', { a: 2, b: 40 }) // 42
```

Functions that return rows can be filtered, sorted and paginated like tables. See [Database functions](/database/functions).

## Download as CSV

`csv()` returns the result as CSV text instead of JSON:

::: code-group

```js [JavaScript]
const { data: csv } = await keel.from('recipes').select('id, title, servings').csv()
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/recipes?select=id,title,servings' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Accept: text/csv"
```

:::

```text
id,title,servings
1,Charred leek & white bean stew,4
2,Miso butter noodles,2
```

## Common errors

| `error.code` | Meaning |
|---|---|
| `42501` | Row level security or missing privileges stopped the request, for example an insert that no policy allows. |
| `PGRST116` | `single()` found no rows or more than one. |
| `PGRST200` | No foreign key between the tables you tried to join. Check the names, or the schema cache if you added it a moment ago. |
| `PGRST201` | More than one foreign key between the tables. Pick one with `!`. |
| `42P01` | The table doesn't exist in `public` (check the spelling, or whether it's in another schema). |
| `42703` | A column doesn't exist. |
| `23505` | The row would duplicate a unique value. |
| `23503` | A foreign key points to a row that doesn't exist, or a delete would leave rows pointing nowhere. |
| `57014` | The query hit its statement timeout (3 seconds for `anon`, 8 for signed-in users). |

The [REST reference](/api/rest#errors) lists the HTTP status codes for each.

## Not available

These PostgREST and `supabase-js` features are switched off in Keel:

- **Aggregate functions** in `select`, such as `select('count(), category')` or `amount.sum()`. Use a [view or a function](/database/functions) for grouped results.
- **`explain()`**, the query plan in the response. Run `explain analyze` in the [SQL editor](/studio/sql-editor) instead.

The API also only serves the `public` schema unless you [expose more](/database/overview#exposing-other-schemas).
