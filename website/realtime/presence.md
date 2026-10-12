# Presence

Presence keeps a shared list of the clients on a channel. Each client publishes a small piece of state, such as a name or a status, and everyone on the channel sees it appear, change and disappear. Use it for "who's online" lists, avatars on a shared document or a "3 people viewing" badge.

```js
const room = keel.channel('lobby', { config: { presence: { key: user.id } } })

room
  .on('presence', { event: 'sync' }, () => {
    console.log('online:', room.presenceState())
  })
  .subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await room.track({ name: 'Ada', online_at: new Date().toISOString() })
    }
  })
```

## Tracking and untracking

`track(state)` publishes your state on the channel. The state is any JSON object. Call it after the channel is subscribed:

```js
await room.track({ name: 'Ada', status: 'available' })
```

Calling `track()` again replaces your previous state, so you can use it for status changes:

```js
await room.track({ name: 'Ada', status: 'in a meeting' })
```

`untrack()` removes your state while staying on the channel:

```js
await room.untrack()
```

You don't need to untrack when you leave. Your state is removed when you remove the channel or close the page. If a client disappears without closing its connection (a laptop lid closes, a phone loses signal), Keel notices within about a minute, when the connection stops answering pings, and removes its state then.

`track()` and `untrack()` resolve to `'ok'`, `'error'` or `'timed out'`. You get `'error'` on a [private channel](/realtime/authorization) where you're not allowed to track presence, when the state is larger than 64 KB (as JSON, with the presence key), or when the connection already tracks presence on 10 other channels.

## Presence events

Listen with `.on('presence', { event }, callback)` before subscribing:

| Event | When | Callback receives |
|---|---|---|
| `sync` | After the initial state arrives and after every change | Nothing. Read `channel.presenceState()`. |
| `join` | Someone tracked state (or changed it) | `{ key, currentPresences, newPresences }` |
| `leave` | Someone untracked, changed state or left | `{ key, currentPresences, leftPresences }` |

```js
room
  .on('presence', { event: 'join' }, ({ key, newPresences }) => {
    console.log(key, 'joined:', newPresences)
  })
  .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
    console.log(key, 'left:', leftPresences)
  })
  .subscribe()
```

Most apps only need `sync` and rebuild their list from `presenceState()` each time.

## Reading the state

`channel.presenceState()` returns an object keyed by presence key. Each value is a list, because the same key can be tracked from several places at once, such as two browser tabs:

```js
{
  '8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b': [
    { presence_ref: 'Yq3l0k1v2bQ9', name: 'Ada', status: 'available' },
    { presence_ref: 'b7Kx2mPq0aZ4', name: 'Ada', status: 'available' }
  ],
  'f1c0a3e4-7b2d-4c55-8e19-2a6d9b0c4e11': [
    { presence_ref: 'Zp8sQ1rT6uW3', name: 'Grace', status: 'in a meeting' }
  ]
}
```

`presence_ref` identifies one tracked entry. The rest is the state that client passed to `track()`.

## The presence key

The key groups entries in `presenceState()`. Set it when you create the channel:

```js
keel.channel('lobby', { config: { presence: { key: user.id } } })
```

Without a key, Keel gives every channel join a random one, so each tab counts as a separate person. Use the user's ID to group a person's tabs and devices under one key.

::: warning
The key and the state come from the client. Anyone on the channel can track any key and any state, so don't treat presence as proof of who someone is. To control who can see and publish presence at all, use a [private channel](/realtime/authorization) with a policy for the `presence` extension.
:::

## Example: who's online

A React hook that returns the people currently on a page, one entry per user:

```jsx
import { useEffect, useState } from 'react'
import { keel } from './keel' // your createClient(...) instance

export function useOnlineUsers(pageId, user) {
  const [online, setOnline] = useState([])

  useEffect(() => {
    const channel = keel.channel(`page:${pageId}`, {
      config: { presence: { key: user.id } },
    })

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        setOnline(
          Object.entries(state).map(([id, entries]) => ({
            id,
            name: entries[0].name,
            tabs: entries.length,
          })),
        )
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ name: user.name })
        }
      })

    return () => {
      keel.removeChannel(channel)
    }
  }, [pageId, user.id, user.name])

  return online
}
```

```jsx
function Viewers({ pageId, user }) {
  const online = useOnlineUsers(pageId, user)
  return <p>{online.map((u) => u.name).join(', ')} {online.length === 1 ? 'is' : 'are'} here</p>
}
```

## Good to know

- Keep the state small. It's sent to everyone on the channel each time it changes, and to every client that joins. Each entry is limited to 64 KB.
- One connection (one `createClient()` in a browser tab) can track presence on up to 10 channels at once.
- A client receives the current state when it joins only if the channel has a presence listener at that point. Add your `.on('presence', ...)` calls before `subscribe()`.
- Presence state lives in memory on the realtime server, so it's lost when a connection drops or `keel-realtime` restarts. Call `track()` each time the channel reports `SUBSCRIBED`, as the examples do, and your state comes back when supabase-js reconnects.
- Presence works on the same channel as broadcast and database changes, so one channel per room is usually enough.
