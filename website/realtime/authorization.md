# Private channels

Private channels let you decide in SQL who may join a channel and who may send on it. You write [row level security](/database/row-level-security) policies on the `realtime.messages` table, and Keel checks them when a client joins. This works the same way as Supabase Realtime Authorization.

```sql
-- Signed-in users can receive and send on their own channel, "user:<their id>".
create policy "own channel: receive" on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'user:' || auth.uid()::text);

create policy "own channel: send" on realtime.messages
  for insert to authenticated
  with check (realtime.topic() = 'user:' || auth.uid()::text);
```

```js
const { data: { user } } = await keel.auth.getUser()

const channel = keel
  .channel(`user:${user.id}`, { config: { private: true } })
  .on('broadcast', { event: 'notification' }, ({ payload }) => console.log(payload))
  .subscribe((status, err) => {
    if (status === 'CHANNEL_ERROR') console.error(err.message)
  })
```

## Joining a private channel

Pass `private: true` in the channel's config. The client acts as the signed-in user: supabase-js sends their access token when it joins and again whenever the session is refreshed. Without a session, the channel uses the anon key and is checked as the `anon` role.

When a client joins, Keel works out four permissions for that user and topic by asking Postgres, as that user:

| Permission | Granted by | Lets the client |
|---|---|---|
| Receive broadcasts | a `select` policy that allows `extension = 'broadcast'` | Join and receive broadcast messages |
| Receive presence | a `select` policy that allows `extension = 'presence'` | Join and receive presence state and changes |
| Send broadcasts | an `insert` policy that allows `extension = 'broadcast'` | Send broadcast messages |
| Track presence | an `insert` policy that allows `extension = 'presence'` | Call `track()` and `untrack()` |

A client needs at least one of the two receive permissions to join. Otherwise the join fails and `subscribe()` reports `CHANNEL_ERROR` with:

```text
Unauthorized: You do not have permissions to read from this Channel topic: user:8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b
```

A client that joined but may not send gets an error when it tries: `send()` resolves to `'error'` if the channel has `broadcast: { ack: true }`, and `track()` resolves to `'error'`. Without `ack`, `send()` resolves to `'ok'` and the message is dropped.

[Database changes](/realtime/postgres-changes) on a private channel need the same receive permission to join. The change events themselves are still filtered by the table's own policies.

Public and private channels with the same name are separate rooms: a message sent on the public `room:42` never reaches subscribers of the private `room:42`, and the other way round.

## Writing policies

Policies go on `realtime.messages`, which has row level security switched on. Until you add a policy, nobody can join a private channel except clients using the service role key, which bypasses row level security.

| In your policy | What it is |
|---|---|
| `realtime.topic()` | The channel name being checked, such as `room:42` (without the `realtime:` prefix that supabase-js adds on the wire). |
| `realtime.messages.extension` | `'broadcast'` or `'presence'`. Check it to give different rights to each. If you don't, the policy covers both. |
| `auth.uid()`, `auth.jwt()` | The user's ID and token claims, as in any other policy. |
| `for select` | Who may **receive** (and therefore join). |
| `for insert` | Who may **send** broadcasts or track presence. |
| `to authenticated`, `to anon` | Which roles the policy applies to. |

Policies are checked once per join, against an empty message. They can't look at the payload or the event name of individual messages.

### Room membership

The most common pattern: a table says who belongs to which room, and the channel `room:<id>` is open to members only.

```sql
create table public.rooms (
  id bigint generated always as identity primary key,
  name text not null
);

create table public.room_members (
  room_id bigint not null references public.rooms on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  primary key (room_id, user_id)
);

-- Users can see their own memberships. The realtime policies below rely on it,
-- because their subqueries run as the user, with row level security applied.
create policy "see own memberships" on public.room_members
  for select to authenticated
  using (user_id = auth.uid());

create policy "room members can receive" on realtime.messages
  for select to authenticated
  using (
    exists (
      select 1 from public.room_members m
      where m.user_id = auth.uid()
        and realtime.topic() = 'room:' || m.room_id
    )
  );

create policy "room members can send" on realtime.messages
  for insert to authenticated
  with check (
    exists (
      select 1 from public.room_members m
      where m.user_id = auth.uid()
        and realtime.topic() = 'room:' || m.room_id
    )
  );
```

```js
const room = keel
  .channel('room:42', { config: { private: true, broadcast: { ack: true } } })
  .on('broadcast', { event: 'message' }, ({ payload }) => showMessage(payload))
  .subscribe()
```

If your membership table is more locked down than this, put the check in a `security definer` function (for example `public.is_room_member(room_id)`) and call it from the policies.

### Read-only announcements

Signed-in users can listen on `announcements`, but there's no `insert` policy, so only your server (service role key) and [the database](/realtime/database-broadcast) can send:

```sql
create policy "announcements: receive" on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'announcements');
```

### Different rights for presence and broadcast

Everyone signed in can see who's in the lobby and show up there, but only users with `"role": "staff"` in their `app_metadata` can broadcast:

```sql
create policy "lobby: receive" on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'lobby');

create policy "lobby: presence" on realtime.messages
  for insert to authenticated
  with check (realtime.topic() = 'lobby' and realtime.messages.extension = 'presence');

create policy "lobby: staff broadcast" on realtime.messages
  for insert to authenticated
  with check (
    realtime.topic() = 'lobby'
    and realtime.messages.extension = 'broadcast'
    and auth.jwt() -> 'app_metadata' ->> 'role' = 'staff'
  );
```

## When policies are checked

- **When the client joins.** The result applies for as long as the client stays on the channel.
- **When the client sends a new access token.** supabase-js does this after the session refreshes and when the user signs in or out. Keel checks again with the new token. If the user may no longer receive, Keel closes the channel with a `system` message: `Unauthorized: You do not have permissions to read from this Channel topic`.
- **Not on every message.** If you remove someone from a room, they keep receiving until they rejoin or their token is refreshed, which happens within the token lifetime (one hour by default). If that's too long, shorten **Session token lifetime (seconds)** under **Users** > **Sign-in settings** in Studio.

When an access token expires without being replaced, Keel closes the channel with the system message `Token has expired`, within about 15 seconds. supabase-js refreshes sessions before they expire, so you only see this when auto-refresh is off or the device was asleep.

## Require private channels

To stop anyone from using public channels in a project, open the project switcher in Studio's header, choose **Project settings**, and under **Realtime** switch on **Private channels only**.

With it on:

- Joining a public channel fails with `PrivateOnly: This project only allows private channels`. That includes channels used only for database changes, so give those a `select` policy on `realtime.messages` and join them with `private: true`.
- Messages sent to public channels through the [HTTP broadcast endpoint](/api/realtime#http-broadcast) are dropped.
- Clients already on a public channel stay connected until they leave or reconnect.

## Errors

| Message | Cause |
|---|---|
| `Unauthorized: You do not have permissions to read from this Channel topic: <topic>` | No `select` policy lets this user receive broadcast or presence on the topic. Returned when joining. |
| `Unauthorized: You do not have permissions to write to this Channel topic` | The user sent a broadcast without an `insert` policy for `broadcast`. Only reported when the channel uses `ack`. |
| `Unauthorized: You do not have permissions to track presence on this Channel topic` | The user called `track()` or `untrack()` without an `insert` policy for `presence`. |
| `PrivateOnly: This project only allows private channels` | The project has **Private channels only** on and the client joined without `private: true`. |
| `Invalid token: ...` | The access token is malformed, expired, signed with another project's secret or for another project. |

If a policy itself fails (for example, it references a table that doesn't exist), Keel treats it as "not allowed". Errors in `select` policies are also logged as `realtime authorization check failed` in the `keel-realtime` logs. See [Logs and services](/studio/logs).
