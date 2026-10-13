# Phone (SMS) sign-in

Users sign in with a code sent to their phone by SMS (or WhatsApp, with Twilio), or with their phone number and a password. Keel sends the codes through Twilio, Vonage, MessageBird or a webhook you run yourself.

```js
// Send a code
const { error } = await keel.auth.signInWithOtp({ phone: '+15555550100' })

// Check it and sign in
const { data, error: verifyError } = await keel.auth.verifyOtp({
  phone: '+15555550100',
  token: '123456',
  type: 'sms',
})
```

## Turning it on

1. In Studio, open **Users**, click the gear icon (**Sign-in settings**) and scroll to **Phone sign-in**.
2. Switch on **Phone sign-in** and choose an **SMS provider**.
3. Fill in the provider's fields and click **Save settings**.

Phone sign-in only counts as on when the switch is on **and** the provider's credentials are filled in. Until then, phone requests fail with `phone_provider_disabled`, and `GET /auth/v1/settings` reports `"phone": false`.

### Providers

| Provider | Fields in Studio | Channels |
|---|---|---|
| Twilio | Account SID, Auth token, and a Messaging Service SID or a From number | SMS and WhatsApp |
| Vonage | API key, API secret, From | SMS |
| MessageBird | Access key, Originator | SMS |
| Webhook (your own gateway) | Webhook URL, Signing secret (optional) | Whatever your endpoint does |
| Testing only (not sent) | None | Nothing is sent and codes aren't logged; only [test numbers](#test-numbers) with fixed codes can sign in. Never use it for real users. |

For WhatsApp, Twilio sends from the **From number**, which must be a WhatsApp-enabled sender in your Twilio account. A Messaging Service SID only works for SMS: without a From number, WhatsApp requests fail with `validation_failed`. Secrets you've saved show as "(saved)" and are never sent back to the browser.

If the provider refuses a message, the app gets a 500 error (`sms_send_failed`) and the provider's answer is written to the `keel-auth` log.

### Webhook

The webhook provider sends each code to a URL of your choice, so you can deliver it any way you like: an SMS gateway app on an old Android phone, a GSM modem, Home Assistant, or an [edge function](/functions/overview) that calls another service. Keel sends a `POST` with this JSON body:

```json
{
  "phone": "+15555550100",
  "otp": "123456",
  "message": "Your code is 123456",
  "channel": "sms",
  "type": "phone_otp",
  "project": "my-app",
  "sent_at": "2026-10-03T09:12:44.120Z"
}
```

| Field | Values |
|---|---|
| `channel` | `sms`, or `whatsapp` when the app asked for it |
| `type` | `phone_otp` (passwordless sign-in), `phone_confirmation` (phone and password sign-up), `phone_change`, `mfa` (a [second factor](/auth/mfa) code) |

Your endpoint must answer with a 2xx status within 10 seconds. It may return `{ "message_id": "..." }`, which supabase-js passes back to your app as `data.messageId`. Any other answer fails the request with `sms_send_failed`.

With a **Signing secret**, every request also carries two headers:

| Header | Value |
|---|---|
| `X-Keel-Timestamp` | Unix time in seconds |
| `X-Keel-Signature` | `sha256=` followed by the hex HMAC-SHA256 of the timestamp, a dot and the raw body, keyed with the secret |

An edge function that checks the signature before forwarding the message:

```ts
// supabase/functions/sms-sender/index.ts
Deno.serve(async (req) => {
  const body = await req.text()
  const ts = req.headers.get('x-keel-timestamp') ?? ''
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(Deno.env.get('SMS_WEBHOOK_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`)))
  const expected = 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (expected !== req.headers.get('x-keel-signature')) {
    return new Response('Invalid signature', { status: 401 })
  }

  const { phone, message } = JSON.parse(body)
  // Hand the message to your SMS gateway here.
  return Response.json({ message_id: crypto.randomUUID() })
})
```

Deploy it with JWT verification turned off, since Keel calls it without a user token, and store the secret as `SMS_WEBHOOK_SECRET` (see [Secrets](/functions/secrets)). The webhook is called from inside the `keel-auth` container, so `localhost` means the container itself. For an edge function in the same project, use the gateway's internal address, for example `http://keel-gateway:8000/my-app/functions/v1/sms-sender`. For a device on your network, use its LAN address.

### Message, code length and expiry

| Setting in Studio | Default | Range |
|---|---|---|
| **Message** | See below | Must contain the code placeholder |
| **Code expires after (seconds)** | 60 | 30 to 3600 |
| **Code length** | 6 digits | 6 to 10 |
| **Confirm phone numbers** | On | Off lets phone and password sign-ups in without a code |

The default message, where the placeholder is replaced by the code:

```text
Your code is {{ .Code }}
```

## Passwordless sign-in

```js
const { data, error } = await keel.auth.signInWithOtp({
  phone: '+15555550100',
  options: {
    channel: 'sms',            // or 'whatsapp' (Twilio only)
    shouldCreateUser: true,    // false: only existing users get a code
    data: { display_name: 'Ada' },  // user_metadata for new users
  },
})
// data.messageId is the provider's message ID
```

A number without an account gets one, unless you pass `shouldCreateUser: false` or **Allow new sign-ups** is off; then the call fails with `otp_disabled`. Asking for WhatsApp with Vonage or MessageBird fails with `validation_failed`.

Verify the code with `type: 'sms'`:

```js
const { data, error } = await keel.auth.verifyOtp({ phone: '+15555550100', token: '123456', type: 'sms' })
// data.user.phone === '15555550100', data.session is the new session
```

A wrong or expired code fails with `otp_expired`. SMS codes can only be checked as phone number plus code, never through a link or a `token_hash`.

## Phone and password

```js
// Sign up: sends a confirmation code
const { data, error } = await keel.auth.signUp({ phone: '+15555550100', password: 'a-long-password' })
// data.session is null until the number is confirmed

await keel.auth.verifyOtp({ phone: '+15555550100', token: '123456', type: 'sms' })

// Later
await keel.auth.signInWithPassword({ phone: '+15555550100', password: 'a-long-password' })
```

- Signing in before confirming fails with `phone_not_confirmed`.
- To send the confirmation code again: `keel.auth.resend({ type: 'sms', phone: '+15555550100' })`.
- With **Confirm phone numbers** off, `signUp` returns a session right away and no SMS is sent.
- Signing up never changes an existing account. With **Confirm phone numbers** on, signing up with a number that already has an account answers like a new sign-up (no session, a stand-in user with an empty `identities` array), and an unconfirmed account gets a new code; if the password differs from the stored one, the stored one is removed. With it off, it fails with `user_already_exists`. See [Signing up](/auth/passwords#signing-up) for why.
- Passwords follow the same [rules](/auth/passwords#password-requirements) as for email.

## Phone number format

Use the international E.164 format: a `+`, the country code and the number, such as `+15555550100` or `+447700900123`. Keel removes spaces, dashes, dots, parentheses and the leading `+`, then expects 7 to 15 digits that don't start with 0. It never guesses a country code, so a local number like `07700 900123` fails with `validation_failed` ("Invalid phone number format (E.164 required)").

Numbers are stored, returned and put into tokens **without** the `+`, as Supabase does: `user.phone` is `'15555550100'`. Add the `+` back when you display it.

## Changing the phone number

```js
await keel.auth.updateUser({ phone: '+15555550123' })
await keel.auth.verifyOtp({ phone: '+15555550123', token: '123456', type: 'phone_change' })
```

The code goes to the new number, and the number changes once it's verified. Resend it with `resend({ type: 'phone_change', phone: '+15555550123' })`. With **Confirm phone numbers** off, the number changes immediately without a code. Email users can add a phone number the same way.

A number another account uses fails with `phone_exists`. Users with [two-factor authentication](/auth/mfa) need an `aal2` session.

## Test numbers

Under **Test numbers**, add one `number=code` pair per line:

```text
15555550100=123456
15555550101=654321
```

Test numbers never receive an SMS, always accept their fixed code (4 to 10 digits), and skip the sending limits below (the limit on code attempts still applies). Use them for automated tests and app store reviewers, and remember that anyone who knows a test number and its code can sign in as that user.

## Rate limits

SMS costs money and attracts "SMS pumping" fraud, where bots request codes to premium numbers. Keel limits sending per number, per IP address and per project:

| Limit | Value |
|---|---|
| Between two codes to the same number | 60 seconds (`over_sms_send_rate_limit`) |
| Codes per number | 6 per hour (`over_sms_send_rate_limit`) |
| Codes requested from one IP address | 10 per hour (`over_sms_send_rate_limit`) |
| `resend` for the same number | 1 per 60 seconds, whether or not there's anything to resend (`over_sms_send_rate_limit`) |
| Codes per project | 60 per hour (`over_sms_send_rate_limit`) |
| Code attempts per number | 10 per hour, right or wrong (`over_request_rate_limit`) |

The limits aren't configurable and reset when `keel-auth` restarts. [Second factor](/auth/mfa) SMS codes count toward the per-number and per-project limits.
