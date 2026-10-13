# Database changes

Subscribe to inserts, updates and deletes on a table and your app gets each change a moment after it's committed. Changes made anywhere count: through the REST API, in Studio, from a trigger or over a direct Postgres connection. Each subscriber only receives rows that [row level security](/database/row-level-security) lets them read.

```js
const channel = keel
  .channel('todos-changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'todos' }, (payload) => {
    console.log(payload.eventType, payload.new, payload.old)
  })
  .subscribe()
```

## Turn on realtime for a table

Realtime is off for new tables. A table streams changes once it's in the `supabase_realtime` publication (a publication is Postgres's list of tables whose changes are sent out).

**In Studio:** when you create a table, switch on **Realtime** in the **New table** panel. For an existing table, click it on the canvas, open **Policies** and switch on **Realtime**. Studio also switches on **Send old values on update and delete** for you (see [Old values](#old-values-on-update-and-delete)).

**In SQL:**

```sql
alter publication supabase_realtime add table public.todos;

-- Recommended: include the full old row in update and delete events.
alter table public.todos replica identity full;
```

To stop streaming a table:

```sql
alter publication supabase_realtime drop table public.todos;
```

To see which tables stream:

```sql
select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime';
```

::: tip Same name as Supabase
The publication is called `supabase_realtime`, as on Supabase, so migrations that run `alter publication supabase_realtime add table ...` work unchanged. Studio's **Realtime** switch and the [importer](/self-hosting/migrate-from-supabase) use the same publication. Installs that used the older name `keel_realtime` are renamed automatically when you update.
:::

If you subscribe to a table that isn't in the publication, the subscription still succeeds, but no events arrive.

## Subscribing

Add one `.on('postgres_changes', ...)` listener per kind of change you want, then call `subscribe()`:

```js
const channel = keel
  .channel('shop')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, (payload) => {
    console.log('new order', payload.new)
  })
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'products' }, (payload) => {
    console.log('product changed', payload.new)
  })
  .subscribe()
```

| Option | Description |
|---|---|
| `event` | `'INSERT'`, `'UPDATE'`, `'DELETE'`, or `'*'` for all three. |
| `schema` | The table's schema. Usually `'public'`. `'*'` matches every schema. |
| `table` | The table name. Leave it out to get changes from every streaming table in the schema. |
| `filter` | Only send rows that match one condition, such as `'room_id=eq.42'`. See [Filters](#filters). |

`TRUNCATE` isn't sent as an event.

## Filters

A filter has the form `column=operator.value`, like the REST API's query parameters:

```js
keel
  .channel('room-42')
  .on(
    'postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages', filter: 'room_id=eq.42' },
    (payload) => console.log(payload.new),
  )
  .subscribe()
```

| Operator | Matches when the column is | Example |
|---|---|---|
| `eq` | equal to the value | `status=eq.open` |
| `neq` | not equal to the value | `status=neq.archived` |
| `lt` | less than the value | `price=lt.100` |
| `lte` | less than or equal to the value | `priority=lte.2` |
| `gt` | greater than the value | `score=gt.9000` |
| `gte` | greater than or equal to the value | `stock=gte.10` |
| `in` | one of the listed values | `status=in.(open,pending)` |

Good to know:

- Each listener takes **one** filter. To combine conditions, filter on the most selective one and check the rest in your callback.
- `eq`, `neq` and `in` compare the value as text: `id=eq.42`, `done=eq.true` and `id=in.(1,2,3)` all work.
- `lt`, `lte`, `gt` and `gte` compare as numbers when both sides are numbers, and as text otherwise.
- For updates, the filter is checked against the new row. For deletes, it's checked against the old row, which only holds the primary key unless the table has [replica identity full](#old-values-on-update-and-delete).
- Filters only narrow what you receive: every event is still checked against your [policies](#row-level-security).
- Any other operator makes the subscription fail with `invalid filter "..."`.

## The payload

Your callback receives one object per change:

```js
{
  schema: 'public',
  table: 'todos',
  commit_timestamp: '2026-10-03T09:41:12.512Z',
  eventType: 'UPDATE',
  new: { id: 7, task: 'Try Keel', done: true, user_id: '8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b' },
  old: { id: 7 }, // only the primary key: todos has row level security
  errors: null
}
```

| Field | Description |
|---|---|
| `eventType` | `'INSERT'`, `'UPDATE'` or `'DELETE'`. |
| `new` | The row after the change. `{}` for deletes. |
| `old` | The row before the change, for updates and deletes. `{}` for inserts. How much it contains depends on the table's [replica identity](#old-values-on-update-and-delete) and, for updates, on row level security (only the primary key when it's on). |
| `commit_timestamp` | When the transaction committed (ISO 8601, UTC). |
| `schema`, `table` | Where the change happened. |
| `errors` | Always `null` in Keel. |

Integers, floats, numerics, booleans and `json`/`jsonb` columns arrive as JSON values, and array columns as arrays. Other types, such as `uuid`, `text`, dates and timestamps, arrive as strings.

## Old values on update and delete

Postgres only writes as much of the old row to its log as the table's **replica identity** asks for:

| Replica identity | `old` on update | `old` on delete |
|---|---|---|
| default | `{}` (or the old primary key, if the key changed) | Only the primary key columns |
| full | The whole old row | The whole old row |

On tables with row level security, subscribers other than the service role only get the primary key in `old` for updates, whatever the replica identity (as on Supabase): your policies are checked against the new row, so the old one could hold data they may no longer see. Delete events carry the old row your policies were checked against.

Full is what you want for most realtime tables: delete events can be checked against your policies (see below), and tables without row level security send the whole old row on updates. It makes Postgres log a bit more data per update and delete. Turn it on in Studio (table > **Policies** > **Send old values on update and delete**) or in SQL:

```sql
alter table public.todos replica identity full;
```

## Row level security

Every event is checked as the subscriber, with their access token, before it's sent:

1. The subscriber's role (`anon` or `authenticated`) needs the `select` privilege on the table.
2. If the table has row level security on, Keel evaluates the table's `select` policies for the subscriber's role, as the subscriber and with their access token, against the row **as the change wrote it**, not against what the table holds by the time the check runs:
   - **Inserts and updates:** the new row. A row that belonged to someone else when it was written isn't sent to the user it was handed to later, and the other way round.
   - **Deletes:** the old row. That needs `replica identity full`: without it the old row only has the primary key, a policy like `user_id = auth.uid()` can't match, and the delete isn't sent.
   - Some values aren't in the change: generated columns, and on updates large (TOASTed) values the update didn't touch, unless the table has `replica identity full`. Keel then takes them from the current row, found by primary key, which the subscriber must also be allowed to see. Such tables need a primary key; without one these changes aren't sent.
   - If a policy fails to run (for example, it reads system columns such as `ctid`, which a copy of the row doesn't have), the change isn't sent and `realtime policy check failed` is logged.
3. Subscribers using the service role key receive every change, with the full old row.

With the quickstart's `todos` table and its "own todos" policy, each signed-in user receives changes to their own todos only:

```js
await keel.auth.signInWithPassword({ email: 'ada@example.com', password: 'a-long-password' })

keel
  .channel('my-todos')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'todos' }, (payload) => {
    // Only Ada's todos arrive here.
  })
  .subscribe()
```

supabase-js sends the signed-in user's access token when the channel joins and sends the new one each time the session is refreshed. Without a signed-in user, the channel uses the anon key and gets what the `anon` role can read. To use a token from somewhere else, set it yourself before subscribing:

```js
keel.realtime.setAuth('USER_ACCESS_TOKEN')
```

::: tip Busy tables
Keel runs one permission check per change and per signed-in subscriber. For a table that changes many times a second with many people watching, [broadcast from the database](/realtime/database-broadcast) scales better: it checks access once, when a client joins.
:::

## When events start and stop

The first subscription to database changes in a project starts the project's change stream, which takes a moment. Keel confirms the subscription (`SUBSCRIBED`) only once the stream is running, so every change committed after that point is delivered. The stream stops about a minute after the last subscriber leaves.

Events aren't stored or replayed. If the connection drops, supabase-js reconnects and rejoins the channel, but changes made in between are lost: reload the data when the channel subscribes again.

## Unsubscribing

```js
// Leave one channel and stop its listeners.
await keel.removeChannel(channel)

// Leave every channel (for example on sign-out).
await keel.removeAllChannels()
```

`channel.unsubscribe()` also leaves the channel but keeps it registered on the client, so you can call `subscribe()` again later.

## React example

Subscribe when the component mounts, load the current rows once the channel is ready, and remove the channel in the effect's cleanup so you don't leak subscriptions when the component unmounts or `roomId` changes:

```jsx
import { useEffect, useState } from 'react'
import { keel } from './keel' // your createClient(...) instance

export function Messages({ roomId }) {
  const [messages, setMessages] = useState([])

  useEffect(() => {
    const channel = keel
      .channel(`messages:${roomId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` },
        (payload) => setMessages((prev) => [...prev, payload.new]),
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` },
        (payload) => setMessages((prev) => prev.filter((m) => m.id !== payload.old.id)),
      )
      .subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return
        // Load (or reload, after a reconnect) what's already there.
        const { data } = await keel
          .from('messages')
          .select('*')
          .eq('room_id', roomId)
          .order('created_at')
        setMessages(data ?? [])
      })

    return () => {
      keel.removeChannel(channel)
    }
  }, [roomId])

  return (
    <ul>
      {messages.map((m) => (
        <li key={m.id}>{m.body}</li>
      ))}
    </ul>
  )
}
```

The delete listener filters on `room_id`, so the `messages` table needs `replica identity full`.
