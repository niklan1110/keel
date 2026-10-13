# Managing users

Look after your users in Studio's **Users** panel, or from your own server code with the admin API. Both act on one project at a time.

```js
import { createClient } from '@supabase/supabase-js'

const admin = createClient('http://localhost:8000/my-app', process.env.KEEL_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const { data, error } = await admin.auth.admin.createUser({
  email: 'grace@example.com',
  password: 'a-long-password',
  email_confirm: true,
})
```

## In Studio

Open **Users** in the dock. The header shows how many users the project has and which sign-in methods are on. The list shows the 100 newest users; use the search box to find others by email, phone number or user ID.

Each row shows the user's email or phone (or "Anonymous user"), their last sign-in, a shield icon if they use two-factor authentication, and a status badge:

| Badge | Meaning |
|---|---|
| **Confirmed** | Email or phone confirmed |
| **Unconfirmed** | Signed up but hasn't confirmed yet |
| **Invited** | Invited and hasn't accepted yet |
| **Anonymous** | A [guest account](/auth/anonymous) |
| **Banned** | Banned by you |

### Adding and inviting users

- **Add** creates a user with an email or phone number and a password. The account is confirmed right away, so they can sign in immediately.
- **Invite** sends an invite email. Without a [mail server](/auth/email), Studio shows the invite link instead, for you to send yourself. The link works once, for an hour.

An invite link signs the user in and sends them to your Site URL with `type=invite` in the URL. Your app should then ask them to choose a password:

```js
const { error } = await keel.auth.updateUser({ password: 'their-new-password' })
```

### A user's details

Click a user to see their **User ID**, **Email**, **Phone**, **Sign-in methods**, **Created**, **Last sign-in**, **Confirmed** and, if set, **User metadata**. From there:

| Action | What it does |
|---|---|
| **Password reset link** | Emails the user a reset link. Without a mail server, Studio shows the link for you to pass on. |
| **Ban user** / **Unban** | A ban stops the user from signing in or refreshing, and ends all their sessions at once. |
| **Delete user** | Removes the user, their sessions and identities. Rows in your tables that reference them with `on delete cascade` are deleted too. |
| Trash icon under **Two-factor authentication** | Removes a factor, for example when someone has lost their phone ([more](/auth/mfa#removing-a-factor)) |

If one of your tables references `auth.users` without `on delete cascade` or `on delete set null`, deleting a user who still has rows there fails with a foreign key error. Studio doesn't edit emails or metadata; use the admin API or SQL for that.

## The admin API

The admin methods need the **service role key**, which bypasses row level security. Use them only in code you control: servers, scripts and [edge functions](/functions/auth). Never ship the key to a browser or app.

| Method | Does |
|---|---|
| `auth.admin.createUser(attributes)` | Creates a user |
| `auth.admin.listUsers({ page, perPage })` | Lists users, newest first |
| `auth.admin.getUserById(id)` | Gets one user |
| `auth.admin.updateUserById(id, attributes)` | Changes a user |
| `auth.admin.deleteUser(id, shouldSoftDelete)` | Deletes a user |
| `auth.admin.inviteUserByEmail(email, options)` | Creates a user and sends an invite email |
| `auth.admin.generateLink(params)` | Creates a sign-in, invite, recovery or email-change link without sending it |
| `auth.admin.mfa.listFactors({ userId })` | Lists a user's MFA factors |
| `auth.admin.mfa.deleteFactor({ userId, id })` | Removes an MFA factor |

### Creating users

```js
const { data, error } = await admin.auth.admin.createUser({
  email: 'grace@example.com',
  password: 'a-long-password',
  email_confirm: true,
  user_metadata: { display_name: 'Grace' },
  app_metadata: { role: 'editor' },
})
```

| Attribute | Notes |
|---|---|
| `email`, `phone` | At least one. Phone numbers in E.164 format, such as `+15555550100`. |
| `password` | Optional. Must meet the [password rules](/auth/passwords#password-requirements). |
| `email_confirm`, `phone_confirm` | `true` marks the address or number as confirmed, and the email address as proven to be the user's. Otherwise the user can't sign in with a password until they confirm. No email is sent either way. |
| `user_metadata`, `app_metadata` | Initial metadata (see [below](#user-metadata-and-app-metadata)) |
| `ban_duration` | Create the user already banned, for example `'24h'` |

An email or phone number that's already taken fails with `email_exists` or `phone_exists`.

### Listing users

```js
const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 100 })
// data.users
```

`perPage` defaults to 50 and can be up to 1000. The response also has `data.total` (the number of users) and `data.nextPage` (absent on the last page). To search or filter, query `auth.users` with SQL instead.

### Updating users

```js
await admin.auth.admin.updateUserById(userId, {
  email: 'grace@example.net',
  password: 'another-long-password',
  app_metadata: { role: 'admin' },
  ban_duration: '24h',
})
```

`updateUserById` takes the same attributes as `createUser`. Changes apply immediately, with no confirmation emails. Notes:

- Metadata is merged into what's there: keys you send are added or replaced, and a key set to `null` is removed.
- `ban_duration` takes a duration such as `'24h'`, `'90m'` or `'1h30m'`, or `'none'` to lift a ban. Banning ends the user's sessions; while banned, sign-in fails with `user_banned`.
- `phone: ''` removes the user's phone number.
- A new `password` ends all of the user's sessions.
- A new `email` counts as unproven unless you also pass `email_confirm: true` (see [Accounts and identities](/auth/oauth#accounts-and-identities) for what that means).

### Deleting users

```js
await admin.auth.admin.deleteUser(userId)        // removes the row
await admin.auth.admin.deleteUser(userId, true)  // soft delete
```

A soft delete keeps the `auth.users` row, so foreign keys in your tables stay valid, but sets `deleted_at`, clears the email, phone, password and `user_metadata`, and removes the user's sessions and identities. The user can't sign in again.

### Inviting users

```js
const { data, error } = await admin.auth.admin.inviteUserByEmail('grace@example.com', {
  data: { team: 'design' },
  redirectTo: 'http://localhost:5173/welcome',
})
```

This creates the user (if needed) and emails an invite link that works once, for an hour. Without a mail server, nothing is sent and the link isn't logged; invite from Studio, which shows the link for you to pass on, or use `generateLink` below. Inviting an address with a confirmed account fails with `email_exists`.

### Generating links

`generateLink` creates the same links and codes Keel puts in its emails, without sending anything. Use it to send emails through your own mailer or templates, or to sign users in from a trusted backend.

```js
const { data, error } = await admin.auth.admin.generateLink({
  type: 'magiclink',
  email: 'grace@example.com',
  options: { redirectTo: 'http://localhost:5173/welcome' },
})

data.properties.action_link  // http://localhost:8000/my-app/auth/v1/verify?token=...&type=magiclink&redirect_to=...
data.properties.email_otp    // the 6-digit code
data.properties.hashed_token // for verifyOtp({ token_hash, type })
data.user                    // the user
```

| `type` | Notes |
|---|---|
| `signup` | Creates an unconfirmed user if there isn't one. Takes an optional `password` and `options.data`. |
| `invite` | Creates an invited user if there isn't one. Takes `options.data`. |
| `magiclink` | The user must exist. |
| `recovery` | Password reset link. The user must exist. |
| `email_change_current`, `email_change_new` | Needs `newEmail`. Both create a link that confirms the new address. |

Links and codes work once, for an hour, and generating a new one of the same type replaces the previous one.

### MFA factors

```js
const { data } = await admin.auth.admin.mfa.listFactors({ userId })
// data.factors: [{ id, factor_type: 'totp', status: 'verified', friendly_name, ... }]

await admin.auth.admin.mfa.deleteFactor({ userId, id: data.factors[0].id })
```

## User metadata and app metadata

Each user has two JSON objects. Both are copied into the access token, so policies can read them with `auth.jwt()`.

| | `user_metadata` | `app_metadata` |
|---|---|---|
| Column in `auth.users` | `raw_user_meta_data` | `raw_app_meta_data` |
| Who can change it | The user, with `updateUser({ data })`, and the admin API | Only the admin API (service role) |
| Use it for | Display name, avatar, preferences | Roles, plans, tenant IDs: anything you rely on for permissions |
| Set by Keel | Profile data from the sign-in provider (GitHub, Google, an OpenID Connect provider...) | `provider` and `providers` |

```js
// In the app: users edit their own user_metadata
await keel.auth.updateUser({ data: { theme: 'dark', old_setting: null } }) // null removes a key
```

Changes reach the access token on its next refresh. See [custom claims](/auth/sessions#custom-claims).

## With SQL

`auth.users` is an ordinary table in your project's database, so Studio's **SQL** editor can query it:

```sql
select id, email, phone, created_at, last_sign_in_at
from auth.users
where email ilike '%@example.com'
order by created_at desc;
```

Prefer the admin API for changes. It keeps identities, sessions and confirmation fields consistent, and hashes passwords for you.
