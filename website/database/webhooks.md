# Database webhooks and HTTP requests

Send an HTTP request from SQL: when a row changes (a database webhook), from a [scheduled job](/database/cron), or from a database function. Keel has the same functions as Supabase's `pg_net` extension and the trigger function Supabase's **Database Webhooks** create, so those triggers and migrations work unchanged.

```sql
select net.http_post(
  url := 'https://hooks.example.com/new-order',
  body := jsonb_build_object('order_id', 42),
  headers := '{"Content-Type": "application/json", "Authorization": "Bearer my-token"}'::jsonb
);
```

Requests are sent after the transaction commits, by `keel-egress`, a container that does nothing else: it has no access to your tables or Keel's secrets, only to the request queues. Each call returns a request id, and the response lands in `net._http_response`:

```sql
select id, status_code, content, timed_out, error_msg
  from net._http_response
 order by created desc
 limit 10;
```

## Database webhooks

A webhook is a trigger that calls `supabase_functions.http_request` with the URL, method (`POST` or `GET`), headers, query parameters and timeout in milliseconds:

```sql
create trigger new_order_webhook
  after insert on public.orders
  for each row
  execute function supabase_functions.http_request(
    'https://hooks.example.com/new-order',
    'POST',
    '{"Content-Type": "application/json"}',
    '{}',
    '5000'
  );
```

A `POST` sends the same body as Supabase:

```json
{ "type": "INSERT", "table": "orders", "schema": "public", "record": { "id": 42, "...": "..." }, "old_record": null }
```

The trigger fires for changes made through the API too (as `anon` or a signed-in user): it runs as the project's owner role, so callers don't need any rights on the `net` schema. Each request is also noted in `supabase_functions.hooks`.

## Calling your edge functions

Point the URL at the function as your apps reach it, `<KEEL_PUBLIC_URL>/<project>/functions/v1/<name>`, or at the gateway inside Keel, `http://keel-gateway:8000/<project>/functions/v1/<name>`:

```sql
select net.http_post(
  url := 'http://keel-gateway:8000/my-app/functions/v1/send-welcome',
  body := '{"user_id": "..."}'::jsonb,
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer <service role key>'
  )
);
```

Keel recognises its own address and the project's path and sends these requests straight to the gateway, so they work even though Keel's addresses are private. Only the project's own `/functions/v1/` paths are routed this way. Functions with `verify_jwt` on need an `Authorization` header with the anon or service role key, as on Supabase.

## Functions

```sql
net.http_get(url text, params jsonb default '{}', headers jsonb default '{}',
             timeout_milliseconds int default 5000) returns bigint
net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
              headers jsonb default '{"Content-Type": "application/json"}',
              timeout_milliseconds int default 5000) returns bigint
net.http_delete(url text, params jsonb default '{}', headers jsonb default '{}',
                timeout_milliseconds int default 5000, body jsonb default null) returns bigint
```

`params` are added to the URL as a query string. `net._http_response` has `id`, `status_code`, `content_type`, `headers`, `content`, `timed_out`, `error_msg` and `created`, as in `pg_net`; a request that couldn't be sent has a null `status_code` and the reason in `error_msg`.

## Which addresses can be reached

The URL comes from your SQL, so Keel holds these requests to the same rules as [edge functions](/functions/overview#network-access):

- **The internet only.** Private, loopback, link-local and other special addresses (IPv4 and IPv6) are refused: your LAN, this server, Keel's own containers and Postgres, the Docker host and cloud metadata (`169.254.169.254`). `error_msg` starts with `refused:`.
- **This server's public address, when Keel knows it.** Keel refuses the addresses in `KEEL_HOST_ADDRESSES`, and `KEEL_PUBLIC_URL` or the Postgres host when they are IP addresses. On a cloud server whose public IP isn't on its network interface, or when `KEEL_PUBLIC_URL` is a domain name pointing straight at the server, add that IP to `KEEL_FUNCTIONS_DENY_NET`: otherwise a request can reach ports the server publishes only to its own network or firewall, such as Postgres or Studio when they listen on every address.
- **The name is checked where it leads.** Every address a host name resolves to is checked, and the request goes to the checked address, so a name can't switch to a private address in between.
- **LAN addresses you allow.** Addresses in `KEEL_FUNCTIONS_ALLOW_LAN` can be reached, as they can from functions. This server's own addresses stay closed.
- **No redirects.** A `3xx` response is recorded as it is; the redirect isn't followed.
- **`http` and `https` only**, and no user name or password in the URL (send an `Authorization` header).

## Limits

| Limit | Default | Setting |
|---|---|---|
| Longest request | 60 s, or less with `timeout_milliseconds` | `KEEL_NET_MAX_TIMEOUT_MS` |
| Largest response kept | 1 MB (the request fails above it) | `KEEL_NET_MAX_RESPONSE_BYTES` |
| Requests of a project in flight at once | 8 | `KEEL_NET_CONCURRENCY` |
| Requests waiting to be sent, per project | 10,000 (further `net.http_*` calls raise an error; webhooks skip the request) | |
| Responses kept in `net._http_response` | 6 hours | `KEEL_NET_TTL_HOURS` |

A request is sent at most once: if `keel-egress` stops while it is in flight, it isn't retried, and when it starts again the request gets a response row with `error_msg` saying so. Requests queued while `keel-egress` is stopped are sent when it starts again.

A full queue never fails the change that fired a webhook: the trigger raises a warning, skips the request and records the hook in `supabase_functions.hooks` with no `request_id`. Direct calls to `net.http_*` raise an error instead.

## Who can send requests

The project's owner role and the `postgres` superuser, and triggers using `supabase_functions.http_request`. The API roles (`anon`, `authenticated`, `service_role`) have no access to the `net` schema. Request bodies and headers are never written to Keel's logs.

## Differences from pg_net

- The `pg_net` extension isn't installed: the `net` schema is in every project already, and `create extension pg_net` isn't needed.
- Private addresses are refused (see above), and responses are size limited.
- Redirects aren't followed.
- `net.http_collect_response` and the `pg_net.*` settings aren't available; use `net._http_response` and the settings above.
