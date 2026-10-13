# REST (database)

Every project serves the tables, views and functions of its `public` schema over HTTP, through [PostgREST](https://postgrest.org) 12.2. This page is the reference for the raw HTTP API. For a guided tour with `supabase-js`, see [Querying with the API](/database/querying).

```text
http://localhost:8000/my-app/rest/v1/
```

Paths below are relative to the API URL, `http://localhost:8000/my-app`.

## Authentication

Every request needs the project's anon or service role key in the `apikey` header. To act as a signed-in user, add their access token in `Authorization`:

```bash
curl 'http://localhost:8000/my-app/rest/v1/todos?select=*' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

| Header | Description |
|---|---|
| `apikey` | **Required.** The project's anon key or service role key. The gateway rejects anything else with `401`. You can send it as an `apikey` query parameter instead; the gateway removes it from the query string before PostgREST sees it, so it isn't read as a filter. |
| `Authorization` | Optional. `Bearer` followed by a JWT. Its `role` claim picks the Postgres role the request runs as: a user's access token runs as `authenticated`. Without this header, the gateway sends the `apikey` as the token, so the anon key runs as `anon` and the service role key as `service_role`. |

The service role bypasses row level security. Use it only from servers. See [Core concepts](/guide/concepts#api-keys).

## Headers

Request headers PostgREST understands:

| Header | Values | Use |
|---|---|---|
| `Prefer` | `return=minimal` (default), `return=representation`, `return=headers-only` | What a write returns: nothing, the affected rows, or only a `Location` header. |
| `Prefer` | `count=exact`, `count=planned`, `count=estimated` | Add the total number of matching rows to `Content-Range`. |
| `Prefer` | `resolution=merge-duplicates`, `resolution=ignore-duplicates` | Turn a `POST` into an upsert. |
| `Prefer` | `missing=default` | In bulk inserts and updates with `columns`, use column defaults for missing keys instead of `null`. |
| `Prefer` | `handling=strict`, `handling=lenient` (default) | With `strict`, unknown or impossible preferences return an error instead of being ignored. |
| `Prefer` | `max-affected=n` | With `handling=strict`: fail an update or delete that would change more than `n` rows. |
| `Prefer` | `timezone=Europe/Berlin` | Time zone for `timestamptz` values in the response. |
| `Accept` | `application/json` (default), `text/csv`, `application/vnd.pgrst.object+json` | Response format. The last returns one object instead of an array, and fails unless exactly one row matches. |
| `Content-Type` | `application/json`, `text/csv`, `application/x-www-form-urlencoded` | Request body format. |
| `Range` | `0-9` | Rows to return, counting from 0, both ends included. An alternative to `offset` and `limit`. |
| `Accept-Profile`, `Content-Profile` | A schema name | Schema to read from or write to. Only `public` is exposed unless you [add schemas](/database/overview#exposing-other-schemas). |

Combine preferences in one header, separated by commas: `Prefer: return=representation, count=exact`.

Response headers:

| Header | Description |
|---|---|
| `Content-Range` | The rows returned and the total, for example `0-24/312`. The total is `*` unless you asked for a count; the range is `*` when nothing was returned. |
| `Preference-Applied` | The preferences that were honored. |
| `Location` | With `return=headers-only` on an insert: a path that selects the new row by primary key. |

## Endpoints

### <code class="method get">GET</code> /rest/v1/table_name

Reads rows from a table or view.

| Name | Type | Description |
|---|---|---|
| `select` | query | Columns and related tables to return, comma-separated. Default `*`. See [Selecting](#selecting-columns) and [Embedding](#embedding-related-tables). |
| `column` | query | A filter on a column: `column=operator.value`, for example `servings=gte.4`. See [Operators](#operators). |
| `or`, `and` | query | Combine filters: `or=(prep_min.lt.20,servings.gte.6)`. |
| `order` | query | Sort: `order=prep_min.desc,title`. |
| `limit`, `offset` | query | Pagination. At most 1,000 rows are returned per request. |

```bash
curl 'http://localhost:8000/my-app/rest/v1/recipes?select=id,title,prep_min&is_public=eq.true&order=prep_min&limit=2' \
  -H "apikey: YOUR_ANON_KEY"
```

```json
[
  { "id": 9, "title": "Quick pickled red onions", "prep_min": 10 },
  { "id": 6, "title": "Cold sesame soba", "prep_min": 15 }
]
```

Returns `200`, or `206 Partial Content` when you asked for a count and only part of the rows came back.

### <code class="method head">HEAD</code> /rest/v1/table_name

Same as `GET` without a body. Use it with `Prefer: count=exact` to count rows:

```bash
curl -I 'http://localhost:8000/my-app/rest/v1/recipes?is_public=eq.true' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Prefer: count=exact"
```

The total is the number after the `/` in `Content-Range`.

### <code class="method post">POST</code> /rest/v1/table_name

Inserts one row (a JSON object), several rows (a JSON array of objects), or CSV with column names on the first line. With a `resolution` preference, it's an upsert.

| Name | Type | Description |
|---|---|---|
| body | JSON object, array or CSV | **Required.** The rows. Keys are column names. |
| `select` | query | Columns to return with `Prefer: return=representation`. |
| `columns` | query | Only insert these keys from the body: `columns=task,done`. Missing keys become `null`, or the default with `Prefer: missing=default`. |
| `on_conflict` | query | For upserts: the unique column(s) that identify a duplicate. Default: the primary key. |
| `Prefer` | header | `return=representation` to get the rows back; `resolution=merge-duplicates` or `resolution=ignore-duplicates` for upserts; `missing=default`. |

```bash
curl 'http://localhost:8000/my-app/rest/v1/todos?select=id,task,done' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"task": "Buy leeks"}'
```

```json
[{ "id": 7, "task": "Buy leeks", "done": false }]
```

Returns `201 Created` (with an empty body unless you asked for the rows). An upsert that only updated existing rows returns `200`.

Upsert on a unique column:

```bash
curl 'http://localhost:8000/my-app/rest/v1/ingredients?on_conflict=name' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: resolution=merge-duplicates" \
  -d '[{"name": "leek", "unit": "kg"}, {"name": "lemon", "unit": "pc"}]'
```

Bulk insert from CSV:

```bash
curl 'http://localhost:8000/my-app/rest/v1/ingredients' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: text/csv" \
  --data-binary @ingredients.csv
```

In CSV bodies, an empty field is an empty string and `NULL` is a null value.

### <code class="method put">PUT</code> /rest/v1/table_name

Inserts or replaces a single row, identified by its primary key. Filter on every primary key column with `eq`, and send all columns in the body, including the key.

```bash
curl -X PUT 'http://localhost:8000/my-app/rest/v1/tags?id=eq.6' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": 6, "slug": "pantry", "label": "From the pantry"}'
```

### <code class="method patch">PATCH</code> /rest/v1/table_name

Updates the rows that match the filters with the values in the body.

| Name | Type | Description |
|---|---|---|
| body | JSON object | **Required.** The columns to change. |
| `column` | query | Filters that pick the rows. **Without filters, every row the policies allow is updated.** |
| `select` | query | Columns to return with `Prefer: return=representation`. |
| `Prefer` | header | `return=representation` to get the updated rows back. |

```bash
curl -X PATCH 'http://localhost:8000/my-app/rest/v1/todos?id=eq.7' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"done": true}'
```

```json
[{ "id": 7, "task": "Buy leeks", "done": true, "user_id": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b", "created_at": "2026-10-03T09:12:44.105+00:00" }]
```

Returns `204 No Content`, or `200` with the rows. Rows hidden by row level security are skipped, so an update that matches nothing returns `[]`, not an error.

### <code class="method delete">DELETE</code> /rest/v1/table_name

Deletes the rows that match the filters. **Without filters, every row the policies allow is deleted.**

| Name | Type | Description |
|---|---|---|
| `column` | query | Filters that pick the rows. |
| `select` | query | Columns to return with `Prefer: return=representation`. |

```bash
curl -X DELETE 'http://localhost:8000/my-app/rest/v1/todos?id=eq.7' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

Returns `204 No Content`, or `200` with the deleted rows.

### <code class="method post">POST</code> /rest/v1/rpc/function_name

Calls a function in the `public` schema. The body's keys are the function's parameter names. See [Database functions](/database/functions).

| Name | Type | Description |
|---|---|---|
| body | JSON object | The arguments. Parameters with defaults can be left out. A function with a single unnamed `json` or `jsonb` parameter receives the whole body. |
| `select`, filters, `order`, `limit`, `offset` | query | For functions that return rows: shape the result like a table read. |
| `Prefer` | header | `count=exact` to count the returned rows. |

```bash
curl 'http://localhost:8000/my-app/rest/v1/rpc/add_numbers' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"a": 2, "b": 40}'
```

```json
42
```

A function that returns rows returns a JSON array. A `void` function returns `204 No Content`. `volatile` functions run in a read-write transaction, `stable` and `immutable` ones read-only.

### <code class="method get">GET</code> /rest/v1/rpc/function_name

Calls a function with the arguments in the query string. Runs read-only: a function that writes fails with `405` and code `25006`.

```bash
curl 'http://localhost:8000/my-app/rest/v1/rpc/add_numbers?a=2&b=40' \
  -H "apikey: YOUR_ANON_KEY"
```

```json
42
```

### <code class="method get">GET</code> /rest/v1/

Returns an OpenAPI 2.0 (Swagger) description of the API: every table, view and function the key's role has privileges on, with their columns and parameters. Works with the anon key and the service role key.

```bash
curl 'http://localhost:8000/my-app/rest/v1/' \
  -H "apikey: YOUR_ANON_KEY"
```

```json
{
  "swagger": "2.0",
  "host": "localhost:8000",
  "basePath": "/my-app/rest/v1",
  "paths": {
    "/": { "get": { "…": "…" } },
    "/recipes": { "get": { "…": "…" }, "post": { "…": "…" }, "patch": { "…": "…" }, "delete": { "…": "…" } },
    "/rpc/add_numbers": { "get": { "…": "…" }, "post": { "…": "…" } }
  },
  "definitions": {
    "recipes": { "type": "object", "properties": { "id": { "type": "integer", "format": "bigint" }, "…": "…" } }
  }
}
```

The API roles have privileges on every table in `public` by default (row level security, not privileges, protects the rows), so the anon key's description lists all your public tables and columns. `COMMENT ON` a table or column to add descriptions.

## Query syntax

### Selecting columns

| Syntax | Example | Result |
|---|---|---|
| Columns | `select=id,title` | Only these columns. |
| All | `select=*` | Every column (the default). |
| Rename | `select=name:title` | `title` returned as `name`. |
| Cast | `select=id::text` | `id` returned as a string. |
| JSON path | `select=meta->n,meta->>n` | A field of a `json`/`jsonb` column, as JSON (`->`) or text (`->>`). |

### Embedding related tables

Tables linked by a foreign key can be fetched in the same request by putting the related table in `select`:

| Syntax | Meaning |
|---|---|
| `select=title,profiles(display_name)` | Embed the related table. Many-to-one gives an object, one-to-many an array. |
| `select=title,author:profiles(display_name)` | Embed under another name. |
| `select=title,profiles!author_id(display_name)` | Pick the foreign key (by column or constraint name) when there are several. |
| `select=title,ingredients!inner(name)` | Only return parent rows that have a matching related row. |
| `select=title,...profiles(display_name)` | Spread a many-to-one relation's columns into the parent object. |
| `ingredients.name=eq.leek` | Filter the embedded rows. |
| `recipe_ingredients.order=quantity.desc` | Sort the embedded rows (also `.limit` and `.offset`). |
| `profiles=not.is.null` | Keep parent rows whose embedded row exists (`is.null` for the opposite). |
| `order=profiles(display_name).asc` | Sort parent rows by a many-to-one related column. |

Many-to-many relations work through a join table whose primary key is made of foreign keys to both sides: `recipes?select=title,ingredients(name)`.

### Operators

Filters take the form `column=operator.value`. Prefix any operator with `not.` to negate it: `servings=not.is.null`.

| Operator | Meaning | Example |
|---|---|---|
| `eq` | equals | `servings=eq.4` |
| `neq` | not equal | `servings=neq.4` |
| `gt`, `gte` | greater than, or equal | `prep_min=gt.30` |
| `lt`, `lte` | less than, or equal | `prep_min=lte.30` |
| `like` | matches a pattern, case-sensitive (`*` or `%` as wildcard) | `title=like.*Soup*` |
| `ilike` | matches a pattern, any case | `title=ilike.*soup*` |
| `match`, `imatch` | matches a regular expression, case-sensitive or not | `title=imatch.^miso` |
| `in` | one of a list | `id=in.(1,2,3)` |
| `is` | is `null`, `true`, `false` or `unknown` | `servings=is.null` |
| `isdistinct` | not equal, treating `null` as a value | `servings=isdistinct.4` |
| `cs` | contains (arrays, `jsonb`, ranges) | `recipe_ids=cs.{1,2}` |
| `cd` | is contained in | `recipe_ids=cd.{1,2,3}` |
| `ov` | overlaps | `recipe_ids=ov.{1,2}` |
| `fts`, `plfts`, `phfts`, `wfts` | full-text search with `to_tsquery`, `plainto_tsquery`, `phraseto_tsquery` or `websearch_to_tsquery`; add a language as `fts(english)` | `title=wfts(english).leek%20stew` |
| `sl`, `sr`, `nxr`, `nxl`, `adj` | range comparisons: strictly left of, strictly right of, doesn't extend right of, doesn't extend left of, adjacent to | `during=sl.[2026-01-01,2026-02-01)` |

`eq`, `like`, `ilike`, `gt`, `gte`, `lt`, `lte`, `match` and `imatch` accept the `any` and `all` modifiers: `title=ilike(any).{*soup*,*stew*}`.

Values that contain `,` `.` `:` or parentheses must be wrapped in double quotes: `title=in.("Soup, tomato","Pancakes")`. Remember to URL-encode spaces and other special characters, or let curl do it with `-G --data-urlencode`. Pass `-g` to curl when a URL contains `{}` or `[]`.

### Logical operators

```text
or=(prep_min.lt.20,servings.gte.6)
or=(is_public.eq.true,and(servings.gte.4,prep_min.lt.30))
not.or=(servings.is.null,prep_min.is.null)
```

Filters given as separate parameters are combined with AND.

### Ordering

`order=column[.asc|.desc][.nullsfirst|.nullslast]`, comma-separated for several columns: `order=prep_min.desc.nullslast,title`. JSON paths work too: `order=meta->>n.desc`.

### Pagination and counting

Use `limit` and `offset`, or a `Range` header. Ask for the total with `Prefer: count=exact` (or `planned`, `estimated`):

```bash
curl -i 'http://localhost:8000/my-app/rest/v1/recipes?select=id&limit=5&offset=0' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Prefer: count=exact"
```

```text
HTTP/1.1 206 Partial Content
Content-Range: 0-4/9
```

Each response holds at most **1,000 rows**, whatever `limit` asks for. With a count, an `offset` past the last row returns `416` with code `PGRST103`; without one, it returns an empty array.

## Errors

Errors from PostgREST and Postgres have the same JSON shape:

```json
{
  "code": "42501",
  "details": null,
  "hint": null,
  "message": "new row violates row-level security policy for table \"todos\""
}
```

`code` is either a Postgres error code or a PostgREST code starting with `PGRST`. Common ones:

| Status | Code | Meaning |
|---|---|---|
| 400 | `PGRST100` | The query string couldn't be parsed (a typo in a filter, `select` or `order`). |
| 400 | `PGRST102` | The request body isn't valid JSON (or is empty). |
| 400 | `PGRST200` | No relationship between the tables in an embed. |
| 300 | `PGRST201` | More than one relationship: pick one with `!`. |
| 404 | `PGRST202` | No function with that name and those parameters. |
| 300 | `PGRST203` | Several overloaded functions match. |
| 400 | `PGRST204` | A column in `columns` doesn't exist. |
| 401 | `PGRST301` | The `Authorization` token is invalid or expired (`"JWT expired"`). |
| 406 | `PGRST106` | `Accept-Profile` or `Content-Profile` names a schema that isn't exposed. |
| 406 | `PGRST116` | A single object was requested, but zero or several rows matched. |
| 416 | `PGRST103` | An invalid range, such as an `offset` past the end of the results when counting. |
| 401 / 403 | `42501` | Permission denied, or a row failed a policy's `with check`. `401` for the anon role, `403` for signed-in users. |
| 404 | `42P01` | The table doesn't exist (or isn't in an exposed schema). |
| 404 | `42883` | The function doesn't exist. |
| 400 | `42703` | A column doesn't exist. |
| 409 | `23505` | Duplicate value in a unique column. |
| 409 | `23503` | Foreign key violation. |
| 400 | `23502` | A `not null` column got `null`. |
| 400 | `P0001` | A function raised an exception. |
| 405 | `25006` | A GET request tried to write. |
| 500 | `42P17` | Infinite recursion in a policy (see [teams](/database/row-level-security#teams)). |
| 500 | `57014` | The statement timeout was reached (3 s for `anon`, 8 s for `authenticated`). |

The gateway answers some requests before PostgREST sees them, with a shorter body:

| Status | Body | Cause |
|---|---|---|
| 401 | `{"message":"No API key found in request"}` | No `apikey` header or query parameter. |
| 401 | `{"message":"Invalid API key"}` | The key isn't this project's anon or service role key, or there's no project with that name (check the URL). |
| 503 | `{"message":"The REST API for \"my-app\" is starting, try again in a moment."}` | The project's REST server is starting (right after `./keel up` or a settings change). Retry after the `Retry-After` seconds. |

See also [Errors](/api/errors) for the other services.
