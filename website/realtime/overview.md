# Overview

Realtime pushes updates to your app over a WebSocket as they happen, so you don't have to poll. It has three features: **database changes** stream inserts, updates and deletes on your tables, **broadcast** sends messages between clients, and **presence** keeps track of who's connected. Keel speaks the same protocol as Supabase Realtime, so you use it through `keel.channel()` in supabase-js.

```js
import { createClient } from '@supabase/supabase-js'

const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY')

const channel = keel
  .channel('room-1')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
    console.log('new message', payload.new)
  })
  .on('broadcast', { event: 'typing' }, ({ payload }) => {
    console.log(payload.name, 'is typing')
  })
  .on('presence', { event: 'sync' }, () => {
    console.log('online now', channel.presenceState())
  })
  .subscribe()
```

## The three features

| Feature | What it does | Good for |
|---|---|---|
| [Database changes](/realtime/postgres-changes) | Sends row changes on tables you've enabled to subscribed clients. Each client only gets rows that [row level security](/database/row-level-security) lets it read. | Live lists, feeds, dashboards, notifications |
| [Broadcast](/realtime/broadcast) | Sends short messages from one client to everyone else on the channel. Nothing is written to the database. | Cursors, typing indicators, game moves |
| [Presence](/realtime/presence) | Keeps a shared list of the clients on a channel and the state each one publishes. | "Who's online", "3 people viewing" |

You can also send broadcast messages [from the database](/realtime/database-broadcast), for example from a trigger.

## Channels and topics

A **channel** is a named room. Clients that join the same channel name in the same project receive each other's broadcasts and presence. The name, also called the **topic**, can be any string of up to 246 bytes without control characters (such as newlines). A `scope:id` pattern such as `room:42` or `user:8d2b…` works well, because your [policies](/realtime/authorization) can match on it later.

One channel can use all three features at once, as in the example above. Projects never share channels: `room-1` in `my-app` and `room-1` in another project are different rooms.

`subscribe()` joins the channel. Pass a callback to find out when it's ready or why it failed:

```js
channel.subscribe((status, err) => {
  if (status === 'SUBSCRIBED') console.log('ready')
  if (status === 'CHANNEL_ERROR') console.error(err.message)
  if (status === 'TIMED_OUT') console.error('the server did not answer')
  if (status === 'CLOSED') console.log('channel closed')
})
```

Leave a channel when you no longer need it, for example when a page or component goes away:

```js
await keel.removeChannel(channel)
```

## The connection

Each client opens **one** WebSocket and runs all of its channels over it. supabase-js opens it when you subscribe to the first channel, at:

```text
ws://localhost:8000/my-app/realtime/v1/websocket
```

When your API URL uses `https://`, the WebSocket uses `wss://`. The anon key goes in the URL, and supabase-js sends the signed-in user's access token when it joins a channel and again whenever the token is refreshed. Realtime then acts as that user. The protocol details are in the [Realtime API reference](/api/realtime).

## Public and private channels

Channels are **public** by default. Anyone with your anon key who knows a channel's name can join it, send broadcasts and see presence. That's fine for cursors on a public page, but not for a team's chat.

**Private channels** are checked against row level security policies on the `realtime.messages` table, so you decide in SQL who may join a topic and who may send to it:

```js
const channel = keel.channel('room:42', { config: { private: true } })
```

A public and a private channel with the same name are separate rooms: messages never cross between them. You can also make a project reject public channels entirely. See [Private channels](/realtime/authorization).

## How row level security applies

| | Who receives what |
|---|---|
| Database changes | Every event is checked against the table's policies as the subscriber. A user only gets changes to rows they could `select`. |
| Broadcast and presence, public channel | No checks. Anyone with the anon key can join, send and receive. |
| Broadcast and presence, private channel | Policies on `realtime.messages` decide who can receive (`select`) and send (`insert`). |
| Service role key | Receives every change and can join every channel. Use it only on servers. |

::: warning
Don't send personal or secret data over public channels. Use a private channel, or database changes on a table with policies.
:::

## Delivery

Realtime delivers to the clients that are connected at that moment. It doesn't store or replay messages: a client that was offline or reconnecting misses what happened in the meantime. When a channel subscribes again (supabase-js rejoins after a network drop), reload the data you show from the database.

## Limits

| Limit | Value |
|---|---|
| Largest message a client can send over the WebSocket | 1 MB. A bigger message closes the connection. |
| Messages per connection | 100 per second, with bursts of up to 200. Extra messages are refused with an error; a client that keeps flooding is disconnected. |
| Channels per connection | 100. Joining a topic that the connection has already joined replaces the earlier join. |
| Channel names | Up to 246 bytes (the topic `realtime:<name>` is at most 255), no control characters |
| Presence | 64 KB of state per tracked entry; a connection can track presence on up to 10 channels at once |
| HTTP broadcast | 1 MB per request, up to 100 messages and 20 different private topics |
| Connections | 200 per client address in one project (`KEEL_REALTIME_MAX_PER_IP`), and 10,000 anonymous sockets per project (`KEEL_REALTIME_MAX_PER_PROJECT`); signed-in users aren't counted toward the second. Beyond that, your server's CPU, memory and network are the limit. See [Limits](/reference/limits). |
| Heartbeat | supabase-js sends one every 25 seconds. Keel also pings each connection every 30 seconds and closes connections that stop answering. |
| Expired tokens | A channel is closed within about 15 seconds after its access token expires, unless the client sent a fresh one. supabase-js does this when it refreshes the session. |
| Database change stream | Starts when the first client in a project subscribes to database changes and stops about a minute after the last one leaves. |
| Messages sent from the database | Kept in `realtime.messages` for 24 hours, then deleted. They aren't replayed. |

## Differences from Supabase

- Broadcast replay (`config.broadcast.replay`) isn't supported.
- There are no quotas or plan limits. The [limits above](#limits) protect the server and apply to every project; see the [API reference](/api/realtime#limits) for the exact errors.

## Next steps

<div class="cards">
  <a class="card" href="./postgres-changes"><strong>Database changes</strong><span>Stream inserts, updates and deletes to your app, filtered by your policies.</span></a>
  <a class="card" href="./broadcast"><strong>Broadcast</strong><span>Send low-latency messages between clients.</span></a>
  <a class="card" href="./presence"><strong>Presence</strong><span>Show who's online and what they're doing.</span></a>
  <a class="card" href="./authorization"><strong>Private channels</strong><span>Decide in SQL who can join and send on a channel.</span></a>
  <a class="card" href="./database-broadcast"><strong>Broadcast from the database</strong><span>Send messages from triggers and SQL functions.</span></a>
  <a class="card" href="../api/realtime"><strong>API reference</strong><span>The WebSocket protocol and the HTTP broadcast endpoint.</span></a>
</div>
