# Broadcast from the database

You can send [broadcast](/realtime/broadcast) messages from SQL: from a trigger when a row changes, from a database function, or from a scheduled job. Keel has the same two functions as Supabase: `realtime.send()` for any message and `realtime.broadcast_changes()` for row changes in a trigger.

```sql
select realtime.send(
  jsonb_build_object('text', 'Maintenance tonight at 22:00'),  -- payload
  'announcement',                                              -- event
  'announcements',                                             -- topic (channel name)
  false                                                        -- private?
);
```

```js
keel
  .channel('announcements')
  .on('broadcast', { event: 'announcement' }, ({ payload }) => console.log(payload.text))
  .subscribe()
```

## realtime.send()

```sql
realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
```

| Argument | Description |
|---|---|
| `payload` | The message body. Clients receive it as `payload`. |
| `event` | The event name that clients listen for with `.on('broadcast', { event }, ...)`. |
| `topic` | The channel name, as passed to `keel.channel()`. |
| `private` | `true` (the default) sends to the [private channel](/realtime/authorization) of that name, `false` to the public one. |

How it behaves:

- **It's sent after commit.** The message is stored as a row in `realtime.messages`, and Keel delivers it when the transaction commits. If the transaction rolls back, nothing is sent.
- **It runs with the caller's privileges.** The insert into `realtime.messages` has to pass your `insert` policies on that table, unless the caller bypasses row level security (Studio's SQL editor, the service role, or a `security definer` function, as in the trigger below).
- **It never fails the transaction.** If the message can't be stored, for example because no policy allows it, `realtime.send()` raises a warning (`ErrorSendingBroadcastMessage: ...`) and your statement carries on.

## realtime.broadcast_changes()

Use this in a trigger function to broadcast a row change in the same shape as Supabase:

```sql
realtime.broadcast_changes(
  topic_name   text,    -- channel name
  event_name   text,    -- event clients listen for
  operation    text,    -- usually TG_OP: 'INSERT', 'UPDATE' or 'DELETE'
  table_name   text,    -- usually TG_TABLE_NAME
  table_schema text,    -- usually TG_TABLE_SCHEMA
  new          record,  -- NEW
  old          record,  -- OLD
  level        text default 'ROW'
) returns void
```

Clients receive this payload:

```json
{
  "operation": "UPDATE",
  "table": "messages",
  "schema": "public",
  "record": { "id": 12, "room_id": 42, "body": "Hello again", "user_id": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b" },
  "old_record": { "id": 12, "room_id": 42, "body": "Hello", "user_id": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b" }
}
```

`record` is `null` for deletes and `old_record` is `null` for inserts. With `level => 'STATEMENT'`, the payload only has `operation`, `table` and `schema`.

`broadcast_changes()` always sends to the **private** channel, so subscribers need `private: true` and a `select` policy on `realtime.messages` for the topic.

## Full example: a chat room

A `messages` table whose changes are broadcast to the private channel `room:<room_id>`. This builds on the `room_members` table from [Private channels](/realtime/authorization#room-membership).

**1. The table:**

```sql
create table public.messages (
  id bigint generated always as identity primary key,
  room_id bigint not null references public.rooms on delete cascade,
  user_id uuid not null default auth.uid() references auth.users,
  body text not null,
  created_at timestamptz not null default now()
);

-- Members can read and post messages in their rooms.
create policy "members read messages" on public.messages
  for select to authenticated
  using (exists (
    select 1 from public.room_members m
    where m.room_id = messages.room_id and m.user_id = auth.uid()
  ));

create policy "members post messages" on public.messages
  for insert to authenticated
  with check (user_id = auth.uid() and exists (
    select 1 from public.room_members m
    where m.room_id = messages.room_id and m.user_id = auth.uid()
  ));
```

**2. The trigger:**

```sql
create or replace function public.broadcast_message_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'room:' || coalesce(new.room_id, old.room_id),  -- topic
    tg_op,                                          -- event: INSERT, UPDATE or DELETE
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return null;
end;
$$;

create trigger messages_broadcast
  after insert or update or delete on public.messages
  for each row execute function public.broadcast_message_changes();
```

`security definer` makes the function run as its owner. That's the project's owner role (`my_app_owner`), which a policy on `realtime.messages` lets write every row, so the insert isn't subject to the sender's policies. `set search_path = ''` keeps a `security definer` function from picking up objects from other schemas; that's why every name in it is schema-qualified.

**3. Who may listen:** the "room members can receive" policy from [Private channels](/realtime/authorization#room-membership).

**4. The client:**

```js
const room = keel
  .channel('room:42', { config: { private: true } })
  .on('broadcast', { event: 'INSERT' }, ({ payload }) => addMessage(payload.record))
  .on('broadcast', { event: 'UPDATE' }, ({ payload }) => updateMessage(payload.record))
  .on('broadcast', { event: 'DELETE' }, ({ payload }) => removeMessage(payload.old_record.id))
  .subscribe()

// A member posting through the REST API triggers the broadcast:
await keel.from('messages').insert({ room_id: 42, body: 'Hello' })
```

The table doesn't need to be in the `supabase_realtime` publication for this.

## Why use this instead of database changes

[Database changes](/realtime/postgres-changes) are the quickest to set up. Broadcasting from the database takes a trigger, but:

- **It scales better.** With database changes, Keel checks every change against your table policies once per subscriber. A broadcast is authorized once, when the client joins, and then delivered to everyone in the room.
- **You choose the payload.** Send only the columns clients need, add data from other tables, or send a computed value such as a new unread count.
- **You choose the topic.** Route each row to the channel it belongs to (`room:42`), so clients receive exactly their room without filters.

The trade-off: who receives a message is decided by your policies on `realtime.messages` for the topic, **not** by the table's policies. Make sure the topic policies match who should see the rows. `broadcast_changes()` sends the whole row, so use `realtime.send()` with a hand-picked payload if some columns are private.

## Public or private

`realtime.send()` sends to private channels unless you pass `false` as the fourth argument:

| `private` | Who receives |
|---|---|
| `true` (default) | Clients on the private channel of that name whose `select` policies on `realtime.messages` allow receiving broadcasts |
| `false` | Everyone on the public channel of that name: anyone with your anon key who knows the name |

A message sent to one never reaches the other, even with the same channel name.

## Delivery details

- Only clients connected when the message is delivered receive it. Messages aren't replayed to clients that join later. A channel receives every message committed after it reports `SUBSCRIBED`.
- Stored messages are deleted from `realtime.messages` after 24 hours.
- Only broadcast messages are delivered this way. You can't set presence from SQL.
- Inserting a row into `realtime.messages` yourself (with `extension = 'broadcast'`) works too. `realtime.send()` is the shorter way.
