# Broadcast

Broadcast sends short messages from one client to everyone else on a channel, with low latency. Messages go through Keel's realtime server only: nothing is written to your database, and only clients connected at that moment receive them.

```js
const channel = keel.channel('room-1')

channel
  .on('broadcast', { event: 'cursor' }, ({ payload }) => {
    console.log('cursor moved', payload) // { x: 120, y: 80 }
  })
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      channel.send({ type: 'broadcast', event: 'cursor', payload: { x: 120, y: 80 } })
    }
  })
```

## Sending and receiving

A message has an **event** name, which you choose, and a **payload**, any JSON value. Send it with `channel.send()` once the channel is subscribed:

```js
await channel.send({
  type: 'broadcast',
  event: 'typing',
  payload: { name: 'Ada' },
})
```

Listen with `.on('broadcast', { event }, callback)` before you subscribe. Use `event: '*'` to get every event on the channel. The callback receives the whole message:

```js
channel.on('broadcast', { event: '*' }, (message) => {
  // { type: 'broadcast', event: 'typing', payload: { name: 'Ada' } }
  console.log(message.event, message.payload)
})
```

Every client subscribed to the same channel name in the same project receives the message, except the sender (see `self` below).

## Options

Set broadcast options when you create the channel:

```js
const channel = keel.channel('room-1', {
  config: {
    broadcast: { self: true, ack: true },
  },
})
```

| Option | Default | Description |
|---|---|---|
| `broadcast.self` | `false` | Also deliver your own messages back to you. Handy for testing with one browser tab, or when every client renders from the same stream of events. |
| `broadcast.ack` | `false` | Have the server confirm each message. `send()` then resolves when Keel has handled it. |

`send()` resolves to `'ok'`, `'error'` or `'timed out'`. Without `ack`, it resolves to `'ok'` right away, even if the server then rejects the message. With `ack`, you get `'error'` when you're not allowed to send on the channel, which is useful on [private channels](/realtime/authorization):

```js
const channel = keel.channel('room:42', { config: { private: true, broadcast: { ack: true } } })
// ...after SUBSCRIBED:
const status = await channel.send({ type: 'broadcast', event: 'message', payload: { text: 'hi' } })
if (status !== 'ok') console.warn('not sent:', status)
```

## Sending over HTTP

Servers, scripts and edge functions can broadcast without opening a WebSocket. Use `httpSend()`, or post to the broadcast endpoint:

::: code-group

```js [JavaScript]
const channel = keel.channel('room-1')

const { success } = await channel.httpSend('announcement', { text: 'Back in 5 minutes' })

// The channel was only needed to send: clean it up.
await keel.removeChannel(channel)
```

```bash [curl]
curl -X POST 'http://localhost:8000/my-app/realtime/v1/api/broadcast' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "topic": "room-1", "event": "announcement", "payload": { "text": "Back in 5 minutes" } }
    ]
  }'
```

:::

Keel answers `202 Accepted` with `{}`. Each message reaches everyone subscribed to that topic at that moment. One request can carry up to 100 messages (for at most 20 different private topics); a bigger request is refused with `400` and nothing is sent. The endpoint is described in the [API reference](/api/realtime#http-broadcast).

For a private channel, `httpSend()` is authorized like a WebSocket send: the caller (a user's token, or the service role key) needs an `insert` policy on `realtime.messages` for that topic, and the message reaches only the private channel. Messages the caller isn't allowed to send are dropped, and the response is still `202`. Binary payloads (`ArrayBuffer`) can't be sent over HTTP; use a subscribed channel for those.

If you call `send()` on a channel that isn't subscribed, supabase-js posts the message to this endpoint for you and logs a warning that this fallback will go away. Prefer `httpSend()` or a subscribed channel.

## Payloads

- A payload can be any JSON value. Keep it small: everything on the channel receives every message.
- A single WebSocket message can be at most 1 MB; a bigger one closes the connection. The HTTP endpoint accepts requests up to 1 MB.
- Each connection can send 100 messages per second, with bursts of up to 200. Messages over the limit are refused (`send()` with `ack` resolves to `'error'`), and a client that keeps flooding is disconnected. To stream something fast, such as cursor positions, send at most 30 to 60 updates a second.
- Over the WebSocket, supabase-js can also send binary payloads (`ArrayBuffer`). They reach clients that use supabase-js's default protocol version (2.0.0) as binary. The HTTP endpoint only accepts JSON.
- Nothing is stored. A client that joins later doesn't see earlier messages. Keep anything that must survive in a table.

## Who can send and receive

On a **public** channel, anyone with your anon key who knows the channel name can send and receive. That suits shared cursors and public lobbies.

For anything else, use a [private channel](/realtime/authorization). Policies on `realtime.messages` then decide who receives (`select`) and who sends (`insert`), and you can give some users read-only access.

## Examples

### Typing indicator

Throttle the event so a fast typist doesn't send a message per keystroke:

```js
const room = keel.channel(`room:${roomId}`)
let lastSent = 0

room
  .on('broadcast', { event: 'typing' }, ({ payload }) => showTyping(payload.name))
  .subscribe()

input.addEventListener('input', () => {
  if (Date.now() - lastSent < 2000) return
  lastSent = Date.now()
  room.send({ type: 'broadcast', event: 'typing', payload: { name: me.name } })
})
```

### Live cursors

Send at most one position per animation frame, and tag it with the sender so each client can draw the others:

```js
const board = keel.channel('board:launch-plan')
let pending = null

board
  .on('broadcast', { event: 'cursor' }, ({ payload }) => drawCursor(payload.id, payload.x, payload.y))
  .subscribe()

window.addEventListener('pointermove', (e) => {
  if (pending) return
  pending = requestAnimationFrame(() => {
    pending = null
    board.send({ type: 'broadcast', event: 'cursor', payload: { id: me.id, x: e.clientX, y: e.clientY } })
  })
})
```

### Game moves

Broadcast moves for speed, and save the game in a table so a player who reloads can catch up:

```js
const game = keel.channel(`game:${gameId}`, { config: { broadcast: { self: true } } })

game
  .on('broadcast', { event: 'move' }, ({ payload }) => applyMove(payload))
  .subscribe()

async function play(move) {
  await game.send({ type: 'broadcast', event: 'move', payload: move })
  await keel.from('moves').insert({ game_id: gameId, ...move })
}
```

With `self: true`, the player who moved gets the event too, so every client updates the board in the same place.

## Not supported

Broadcast replay (`config: { broadcast: { replay } }`), which re-sends recent messages to a joining client on Supabase, isn't supported. Keel ignores the option.
