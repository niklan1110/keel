# Realtime

The Realtime API is a WebSocket that speaks the [Phoenix channels](https://hexdocs.pm/phoenix/channels.html) protocol, the same protocol as Supabase Realtime, plus an HTTP endpoint for sending broadcasts. Apps normally use it through `keel.channel()` in supabase-js (see the [Realtime guide](/realtime/overview)). This page is for writing your own client, using another language, or debugging.

Paths are relative to your API URL, for example `http://localhost:8000/my-app`.

## Connecting

### <code class="method ws">WS</code> /realtime/v1/websocket

Opens the WebSocket. Use `ws://` with an `http://` API URL and `wss://` with an `https://` one. All channels of one client share this connection.

| Name | Type | Description |
|---|---|---|
| `apikey` | query string | **Required.** The project's anon or service role key. Pass it in the URL: browsers can't set headers on WebSockets. |
| `vsn` | query string | Serializer version: `1.0.0` (JSON objects) or `2.0.0` (JSON arrays plus binary broadcast frames). Defaults to `1.0.0` when left out. supabase-js uses `2.0.0`. |

To act as a signed-in user, don't put their token in `apikey`: send it as `access_token` when you [join a channel](#phx-join).

```bash
npx wscat -c 'ws://localhost:8000/my-app/realtime/v1/websocket?apikey=YOUR_ANON_KEY&vsn=1.0.0'
```

If the handshake fails, the server answers with an HTTP error instead of upgrading:

| Status | Body | Cause |
|---|---|---|
| `401` | `{"error":"No API key found in request"}` | No `apikey`. |
| `401` | `{"error":"Invalid API key"}` | The key isn't this project's anon or service role key, or there's no project with that name (Keel doesn't reveal which project names exist). |
| `401` | `{"error":"API key has expired"}` | The key has expired. |

## Message format

Every message has five parts:

| Field | Description |
|---|---|
| `topic` | `realtime:` followed by the channel name, for example `realtime:room-1`. Heartbeats use `phoenix`. A topic is at most 255 bytes (UTF-8) and can't contain control characters. |
| `event` | What the message is, such as `phx_join` or `broadcast`. |
| `payload` | A JSON object. Its shape depends on the event. |
| `ref` | A string you choose for each message you send. Replies carry the same `ref`. `null` on messages the server pushes. |
| `join_ref` | The `ref` of the `phx_join` that opened the channel. |

With `vsn=1.0.0`, each message is a JSON object:

```json
{ "topic": "realtime:room-1", "event": "phx_join", "payload": { "config": {} }, "ref": "1", "join_ref": "1" }
```

With `vsn=2.0.0`, each message is a JSON array in the order `[join_ref, ref, topic, event, payload]`:

```json
["1", "1", "realtime:room-1", "phx_join", { "config": {} }]
```

Version `2.0.0` also uses binary WebSocket frames for broadcasts: clients send broadcasts as "user broadcast push" frames (kind `3`), and the server sends broadcasts with binary payloads as "user broadcast" frames (kind `4`), in the layout `@supabase/realtime-js` uses. Clients on `1.0.0` receive `null` as the payload of a binary broadcast. The examples below use the `1.0.0` form.

## Joining a channel {#phx-join}

Send `phx_join` on the channel's topic:

```json
{
  "topic": "realtime:room-1",
  "event": "phx_join",
  "ref": "1",
  "join_ref": "1",
  "payload": {
    "config": {
      "broadcast": { "self": false, "ack": true },
      "presence": { "key": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b", "enabled": true },
      "postgres_changes": [
        { "event": "INSERT", "schema": "public", "table": "messages", "filter": "room_id=eq.42" }
      ],
      "private": false
    },
    "access_token": "USER_ACCESS_TOKEN"
  }
}
```

| Name | Type | Description |
|---|---|---|
| `config.broadcast.self` | boolean | Also receive your own broadcasts. Default `false`. |
| `config.broadcast.ack` | boolean | Reply to each broadcast you send with `phx_reply`. Default `false`. |
| `config.presence.key` | string | Your presence key. Default: a random ID for this join. |
| `config.presence.enabled` | boolean | Set to `false` to skip the initial `presence_state`. Default: sent. |
| `config.postgres_changes` | array | [Database change](/realtime/postgres-changes) subscriptions. Each has `event` (`INSERT`, `UPDATE`, `DELETE` or `*`; default `*`), `schema` (default `public`), optional `table` and optional `filter` (`column=op.value` with `eq`, `neq`, `lt`, `lte`, `gt`, `gte` or `in`). |
| `config.private` | boolean | Join the [private channel](/realtime/authorization) of this name. Default `false`. |
| `access_token` | string | A user's access token (or a key). Default: the `apikey` from the URL. Checked against the project's active signing keys. |

Joining a topic this connection has already joined replaces the earlier join. A connection can be on at most 100 channels at once; joining a 101st fails with `ChannelRateLimitReached: Too many channels`. The topic must start with `realtime:` (otherwise the join fails with `unmatched topic`), be at most 255 bytes and contain no control characters (otherwise `InvalidTopic: ...`).

On success, the server replies with the IDs it gave your `postgres_changes` subscriptions. Each `postgres_changes` event lists the IDs it matches. Keel sends this reply only once the project's database change stream (when you subscribed to changes) and its listener for [broadcasts from the database](/realtime/database-broadcast) are ready, so anything committed after the reply reaches the channel.

```json
{
  "topic": "realtime:room-1",
  "event": "phx_reply",
  "ref": "1",
  "join_ref": "1",
  "payload": {
    "status": "ok",
    "response": {
      "postgres_changes": [
        { "id": 1185290341, "event": "INSERT", "schema": "public", "table": "messages", "filter": "room_id=eq.42" }
      ]
    }
  }
}
```

Then, if you subscribed to database changes, a `system` message:

```json
{ "topic": "realtime:room-1", "event": "system", "ref": null, "join_ref": "1",
  "payload": { "status": "ok", "message": "Subscribed to PostgreSQL", "extension": "postgres_changes", "channel": "room-1" } }
```

And, unless presence is disabled or you may not receive presence, the current `presence_state`.

If the join is refused, the reply has `"status": "error"` and a reason (see [Errors](#errors)):

```json
{ "topic": "realtime:room-1", "event": "phx_reply", "ref": "1", "join_ref": "1",
  "payload": { "status": "error", "response": { "reason": "PrivateOnly: This project only allows private channels" } } }
```

## Messages you send

| Event | Topic | Payload | Reply |
|---|---|---|---|
| `phx_join` | `realtime:<channel>` | See [Joining a channel](#phx-join). | `ok` or `error` |
| `phx_leave` | `realtime:<channel>` | `{}` | `ok`, then `phx_close` |
| `broadcast` | `realtime:<channel>` | `{ "type": "broadcast", "event": "cursor", "payload": { "x": 1 } }` | `ok` when the channel has `ack`. `error` when you may not send (only if the message has a `ref`). |
| `presence` | `realtime:<channel>` | `{ "type": "presence", "event": "track", "payload": { "name": "Ada" } }` or `{ "type": "presence", "event": "untrack" }` | `ok`, or `error` when you may not track presence |
| `access_token` | `realtime:<channel>` | `{ "access_token": "USER_ACCESS_TOKEN" }` | `ok` (if the message has a `ref`), or `error` for an invalid token |
| `heartbeat` | `phoenix` | `{}` | `ok` |

Send `access_token` on every joined channel when the user's token is refreshed. Keel switches the channel to the new token, and checks private channels again: if the user may no longer receive, it sends a `system` error and closes the channel.

Sending on a topic you haven't joined gets an `error` reply with the reason `unmatched topic`.

### Limits per connection {#limits}

| Limit | Value | What happens |
|---|---|---|
| Message size | 1 MB per WebSocket message | The connection is closed with code `1009`. |
| Message rate | 100 messages per second, with bursts of up to 200 | Messages over the limit are dropped. Those with a `ref` get an `error` reply: `RateLimitReached: Too many messages per second`. A client that keeps sending at well over the limit (another 200 messages while limited) is disconnected with close code `1008`. |
| Messages waiting | 500 messages or 8 MB queued behind a slow one (such as a join that waits for its authorization check) | Further messages are dropped with `RateLimitReached: Too many messages waiting to be handled`. |
| Channels | 100 | `ChannelRateLimitReached: Too many channels` |
| Presence state | 64 KB per tracked entry (key and state as JSON) | `track` gets `PayloadTooLarge: Presence state is larger than 64 KB`. |
| Presence entries | Tracked on at most 10 channels at once (one entry per channel) | `track` on an 11th channel gets `TooManyPresences: ...`. Tracking again on a channel where you already track is fine. |
| Unread data | 16 MB queued for a client that doesn't read its messages | The connection is dropped. |

supabase-js resolves `send()` (with `ack`), `track()` and `untrack()` to `'error'` when they're refused, and reconnects on its own after a disconnect.

## Messages you receive

| Event | Payload |
|---|---|
| `phx_reply` | `{ "status": "ok", "response": { ... } }`: the answer to a message you sent, with the same `ref`. `status` is `"ok"` or `"error"`. |
| `phx_close` | `{}`: the channel was closed, after a `phx_leave` or by the server. |
| `postgres_changes` | A database change. See below. |
| `broadcast` | `{ "type": "broadcast", "event": "cursor", "payload": { "x": 1 } }` |
| `presence_state` | The full presence state, sent once after joining. |
| `presence_diff` | `{ "joins": { ... }, "leaves": { ... } }`: who tracked, changed or left since. |
| `system` | `{ "status": "error", "message": "Token has expired", "extension": "system", "channel": "room-1" }`: subscription status (`"ok"`) and errors such as an expired token (`"error"`). |

Keel never sends `phx_error`. Phoenix clients raise it themselves when the connection drops.

### postgres_changes

```json
{
  "topic": "realtime:room-1",
  "event": "postgres_changes",
  "ref": null,
  "join_ref": null,
  "payload": {
    "ids": [1185290341],
    "data": {
      "schema": "public",
      "table": "messages",
      "commit_timestamp": "2026-10-03T09:41:12.512Z",
      "type": "INSERT",
      "columns": [
        { "name": "id", "type": "int8" },
        { "name": "room_id", "type": "int8" },
        { "name": "body", "type": "text" }
      ],
      "record": { "id": 12, "room_id": 42, "body": "Hello" },
      "errors": null
    }
  }
}
```

`record` is the new row (left out for `DELETE`), `old_record` the old row (left out for `INSERT`). On tables with row level security, the `old_record` of an `UPDATE` only holds the primary key columns (the full old row for service role subscribers). `columns` lists each column's Postgres type name. Numbers, booleans and JSON columns are already JSON values; other values are strings in Postgres's text format. supabase-js converts the payload into `{ eventType, new, old, ... }`. Which events you get, and how much of the old row they carry, is explained in [Database changes](/realtime/postgres-changes).

### Presence

`presence_state` and both halves of `presence_diff` map presence keys to their tracked entries:

```json
{
  "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b": {
    "metas": [{ "phx_ref": "Yq3l0k1v2bQ9", "name": "Ada" }]
  }
}
```

Tracking again sends a `presence_diff` with your new entry in `joins` and the previous one in `leaves`.

### Heartbeats and connection health

Send a heartbeat every 25 to 30 seconds to check that the connection is alive:

```json
{ "topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": "7" }
```

Keel replies with `phx_reply` and `"status": "ok"`. It also sends a WebSocket ping every 30 seconds and closes connections that neither answered the previous ping nor sent anything since. Browsers and most WebSocket libraries answer pings automatically.

Channels are tied to their access token's expiry. Within about 15 seconds after it expires, Keel sends a `system` message with `"status": "error"` and `"message": "Token has expired"`, then `phx_close`. Send a fresh token with `access_token` before then to keep the channel open.

## HTTP broadcast

Send broadcast messages without a WebSocket. These are the endpoints that supabase-js's `httpSend()`, and `send()` on an unsubscribed channel, use.

### <code class="method post">POST</code> /realtime/v1/api/broadcast

Sends one or more broadcast messages.

| Name | Type | Description |
|---|---|---|
| `apikey` | header | **Required.** The anon or service role key. |
| `Authorization` | header | `Bearer <token>`: a user's access token or the service role key. Used to check private channels. Default: the `apikey`. |
| `messages` | array | **Required.** The messages to send. |
| `messages[].topic` | string | **Required.** The channel name, without the `realtime:` prefix. |
| `messages[].event` | string | The event name. |
| `messages[].payload` | any JSON | The message body. |
| `messages[].private` | boolean | Send to the private channel of this name. Default `false`. |

```bash
curl -X POST 'http://localhost:8000/my-app/realtime/v1/api/broadcast' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "topic": "room-1", "event": "announcement", "payload": { "text": "Back in 5 minutes" } },
      { "topic": "room:42", "event": "message", "payload": { "text": "hi" }, "private": true }
    ]
  }'
```

```json
{}
```

One request can carry at most 100 messages, for at most 20 different private topics. Topics follow the WebSocket rules: at most 255 bytes including the `realtime:` prefix (so 246 for the channel name) and no control characters. A request that breaks one of these is refused as a whole with `400`, and nothing is sent.

Otherwise the response is `202 Accepted`. Messages are dropped without an error when:

- `private` is `true` and the caller's `insert` policies on `realtime.messages` don't allow sending broadcasts on that topic (the service role may always send);
- `private` is `false` and the project has **Private channels only** switched on.

### <code class="method post">POST</code> /realtime/v1/api/broadcast/:topic/events/:event

Sends one message. The request body is the payload. `httpSend()` in supabase-js calls this endpoint.

| Name | Type | Description |
|---|---|---|
| `apikey` | header | **Required.** The anon or service role key. |
| `Authorization` | header | `Bearer <token>`. Optional. |
| `topic` | path | **Required.** The channel name, URL-encoded. |
| `event` | path | **Required.** The event name, URL-encoded. |
| body | any JSON | The payload. |

```bash
curl -X POST 'http://localhost:8000/my-app/realtime/v1/api/broadcast/room-1/events/announcement' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "text": "Back in 5 minutes" }'
```

```json
{}
```

Add `?private=true` to send to the private channel of that name (this is what `httpSend()` does on a private channel). The caller then needs an `insert` policy on `realtime.messages` for the topic; otherwise the message is dropped.

The body must be JSON (binary payloads aren't accepted) and at most 1 MB on both endpoints.

| Status | Body | Cause |
|---|---|---|
| `202` | `{}` | Accepted. |
| `400` | `{"message":"Invalid JSON body"}` | The body isn't JSON, is `null` or is larger than 1 MB. |
| `400` | `{"message":"Too many messages: at most 100 per request"}` | More than 100 messages. |
| `400` | `{"message":"Too many private topics: at most 20 per request"}` | Messages for more than 20 different private topics. |
| `400` | `{"message":"InvalidTopic: Topic is longer than 255 bytes"}` | A topic is too long (`realtime:` plus the channel name). |
| `400` | `{"message":"InvalidTopic: Topic contains control characters"}` | A topic contains control characters. |
| `400` | `{"message":"Invalid message: topic must be a string"}` | A message isn't an object with a string `topic`. |
| `400` | `{"message":"Malformed URL encoding"}` | The topic or event in the path isn't valid URL encoding. |
| `401` | `{"message":"No API key found in request"}` | No `apikey`. |
| `401` | `{"message":"Invalid API key"}` | The `apikey` isn't this project's anon or service role key. |
| `401` | `{"message":"API key has expired"}` | The `apikey` has expired. |
| `401` | `{"message":"Invalid token"}` | The bearer token is malformed, expired or from another project. |

## Errors

Reasons in `phx_reply` and messages in `system` events:

| Message | When |
|---|---|
| `Unauthorized: You do not have permissions to read from this Channel topic: <topic>` | Joining a private channel without a `select` policy on `realtime.messages` that allows receiving broadcast or presence. |
| `Unauthorized: You do not have permissions to read from this Channel topic` | `system` error after a new access token loses read access. The channel is closed. |
| `Unauthorized: You do not have permissions to write to this Channel topic` | Sending a broadcast without permission on a private channel. |
| `Unauthorized: You do not have permissions to track presence on this Channel topic` | Tracking presence without permission on a private channel. |
| `PrivateOnly: This project only allows private channels` | Joining a public channel when **Private channels only** is on. |
| `Invalid token: <detail>` | `access_token` in `phx_join` or an `access_token` message is invalid. `<detail>` is one of `missing access token`, `malformed token`, `invalid token signature`, `unsupported token algorithm`, `token has expired`, `token is for another project`. |
| `invalid filter "<filter>"` | A `postgres_changes` filter isn't `column=op.value` with a supported operator. |
| `unmatched topic` | A message for a topic this connection hasn't joined, or a join whose topic doesn't start with `realtime:`. |
| `InvalidTopic: Topic is longer than 255 bytes` | Joining a topic longer than 255 bytes (UTF-8). |
| `InvalidTopic: Topic contains control characters` | Joining a topic with control characters (such as a NUL byte or a newline). |
| `ChannelRateLimitReached: Too many channels` | Joining a 101st channel on one connection. |
| `PayloadTooLarge: Presence state is larger than 64 KB` | Tracking presence state that's too big. |
| `TooManyPresences: A connection can track presence on at most 10 channels` | Tracking presence on an 11th channel on one connection. |
| `RateLimitReached: Too many messages per second` | The connection sent more than 100 messages per second (after a burst of 200). The message was dropped. |
| `RateLimitReached: Too many messages waiting to be handled` | Too many messages queued on the connection. The message was dropped. |
| `Token has expired` | `system` error when the channel's token expires. The channel is closed. |

A WebSocket message larger than 1 MB closes the connection (code `1009`), and so does sending far above the message rate limit (code `1008`). See [Limits per connection](#limits).
