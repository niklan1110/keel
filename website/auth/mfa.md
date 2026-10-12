# Two-factor authentication

Users can protect their account with a second step after signing in: a code from an authenticator app (TOTP) or a code sent by SMS. A session that passed the second step is marked `aal2`, and your row level security policies decide where that's required.

```js
// 1. Add an authenticator app
const { data, error } = await keel.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Phone app' })
// Show data.totp.qr_code (an image URL) or data.totp.secret to the user

// 2. Confirm it with the first code from the app
await keel.auth.mfa.challengeAndVerify({ factorId: data.id, code: '123456' })
// The session is now aal2
```

## Settings

In Studio, open **Users**, click the gear icon (**Sign-in settings**) and go to **Two-factor authentication (MFA)**:

| Setting | Default | Notes |
|---|---|---|
| **Authenticator apps (TOTP)** | On | Google Authenticator, 1Password, Authy and other TOTP apps |
| **SMS codes as a second factor** | Off | Needs an SMS provider, set up under [Phone sign-in](/auth/phone). Phone sign-in itself can stay off. |

A user can have up to 10 factors, counting ones they haven't finished setting up. This limit isn't shown in Studio.

Turning a factor type off stops new enrollments (`mfa_totp_enroll_not_enabled`, `mfa_phone_enroll_not_enabled`) and also stops existing factors of that type from being challenged, so users who rely on them can't reach `aal2` until you turn it back on.

## Adding an authenticator app

```js
const { data, error } = await keel.auth.mfa.enroll({
  factorType: 'totp',
  friendlyName: 'Phone app', // optional, must be unique per user
  issuer: 'My App',          // optional, the name shown in the authenticator app
})
```

The result:

| Field | What it is |
|---|---|
| `data.id` | The factor ID, needed to verify it |
| `data.totp.qr_code` | A QR code as an SVG image URL. Put it in an `img` tag. |
| `data.totp.secret` | The secret in base32, for typing in by hand |
| `data.totp.uri` | The `otpauth://` URI the QR code contains |

The secret is only returned here, once. Keel stores it encrypted (AES-256-GCM, with a key derived from the project's secret, which lives outside the project's database), so a backup or a query on `auth.mfa_factors` doesn't reveal it. Secrets stored by older Keel versions or imported from Supabase are encrypted when `keel-auth` starts.

```jsx
<img src={data.totp.qr_code} alt="Scan this with your authenticator app" />
```

Without `issuer`, the app shows your Site URL's host name, or the project name if there's no Site URL. The account name is the user's email (or phone number).

The factor stays unverified until the user enters a code from the app:

```js
const { data: session, error } = await keel.auth.mfa.challengeAndVerify({ factorId: data.id, code: '123456' })
```

This marks the factor as verified, upgrades the session to `aal2` and returns new tokens (supabase-js stores them). Unfinished factors are cleaned up when they're more than a day old (the next time the user enrolls one), and all of them are removed as soon as another factor is verified.

Codes are standard TOTP: 6 digits, a new one every 30 seconds, SHA-1. Keel accepts the code before and after the current one to allow for clock drift, and each code works only once.

## Adding an SMS factor

```js
const { data: factor } = await keel.auth.mfa.enroll({ factorType: 'phone', phone: '+15555550100' })

const { data: challenge } = await keel.auth.mfa.challenge({ factorId: factor.id })
// An SMS is on its way

await keel.auth.mfa.verify({ factorId: factor.id, challengeId: challenge.id, code: '123456' })
```

The SMS is sent when you call `challenge`, through the project's SMS provider and message template. The code length follows the **Code length** phone setting. Pass `channel: 'whatsapp'` to `challenge` to send it by WhatsApp (Twilio only).

A user can register each number once. A new challenge for the same factor can be requested every 15 seconds, and SMS challenges count toward the [phone rate limits](/auth/phone#rate-limits) (6 per number and 60 per project per hour).

## Signing in with a second factor

Every sign-in starts at `aal1`, whatever the method. After it, check whether the user has a factor to complete:

```js
const { data: aal } = await keel.auth.mfa.getAuthenticatorAssuranceLevel()

if (aal.currentLevel === 'aal1' && aal.nextLevel === 'aal2') {
  // The user has a verified factor: ask for a code
  const { data: factors } = await keel.auth.mfa.listFactors()
  const totp = factors.totp[0]
  const { error } = await keel.auth.mfa.challengeAndVerify({ factorId: totp.id, code: codeFromUser })
}
```

`listFactors()` returns `all` (every factor, including unfinished ones), and `totp` and `phone` with the verified factors of each type.

| | |
|---|---|
| Challenge lifetime | 5 minutes |
| Verification attempts | 10 per 5 minutes per user (`over_request_rate_limit`) |
| Wrong code | `mfa_verification_failed` |

Once verified, the session stays `aal2` when it's refreshed. A new sign-in on another device starts at `aal1` again.

## Assurance levels and the token

| `aal` claim | Meaning |
|---|---|
| `aal1` | Signed in with one method (password, magic link, SMS code, OAuth and so on) |
| `aal2` | Also passed a second factor in this session |

The `amr` claim lists how the session was authenticated, newest first:

```json
{
  "aal": "aal2",
  "amr": [
    { "method": "totp", "timestamp": 1791021712 },
    { "method": "password", "timestamp": 1791021650 }
  ]
}
```

SMS factors appear as `mfa/phone`.

## Requiring MFA with row level security

Keel doesn't hide anything from `aal1` sessions on its own. You decide where a second factor is needed, using the `aal` claim:

```sql
create policy "Billing needs MFA" on billing
  for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2' and owner_id = auth.uid());
```

To require it only from users who have set up a factor, check for one in a helper function. The `authenticated` role can't read `auth.mfa_factors`, so the function runs as its owner (`security definer`):

```sql
create function public.has_verified_factor() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.mfa_factors
    where user_id = auth.uid() and status = 'verified'
  )
$$;

create policy "MFA when enrolled" on documents
  as restrictive
  for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2' or not public.has_verified_factor());
```

The same check works in storage and realtime policies.

## What needs aal2

Once a user has a verified factor, Keel requires an `aal2` session (otherwise `insufficient_aal`) to:

- add or verify another factor,
- remove a verified factor,
- change the email, phone number or password with `updateUser`.

A session from a password reset link is `aal1`, so a user with MFA must complete a challenge before setting a new password.

## Removing a factor

Users remove their own factors with `unenroll` (from an `aal2` session for a verified factor):

```js
await keel.auth.mfa.unenroll({ factorId })
```

When a user loses their phone, remove the factor for them in Studio: open **Users**, select the user and click the trash icon next to the factor under **Two-factor authentication**. From server code with the service role key (see [Managing users](/auth/managing-users#the-admin-api)):

```js
const admin = createClient('http://localhost:8000/my-app', 'YOUR_SERVICE_ROLE_KEY', {
  auth: { persistSession: false, autoRefreshToken: false },
})

const { data } = await admin.auth.admin.mfa.listFactors({ userId })
await admin.auth.admin.mfa.deleteFactor({ userId, id: data.factors[0].id })
```

When a user's last verified factor is gone, their sessions drop back to `aal1`; tokens show it from the next refresh.

## No recovery codes

Keel doesn't support MFA recovery codes. Encourage users to add a second factor (an authenticator app and a phone, for example), and use Studio to remove a lost factor once you've confirmed who you're talking to.
