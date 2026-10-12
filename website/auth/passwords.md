# Email and password

The classic sign-in: users pick a password, you optionally confirm their email address, and they can reset the password by email when they forget it.

```js
// Create an account
const { data, error } = await keel.auth.signUp({
  email: 'ada@example.com',
  password: 'a-long-password',
  options: { data: { display_name: 'Ada' } },
})

// Sign in
const { data: signIn, error: signInError } = await keel.auth.signInWithPassword({
  email: 'ada@example.com',
  password: 'a-long-password',
})

// Sign out
await keel.auth.signOut()
```

## Signing up

`signUp` takes an email, a password and these options:

| Option | What it does |
|---|---|
| `data` | Stored as the user's `user_metadata`, for example a display name. A trigger can copy it into a profile table ([example](/auth/overview#create-a-profile-on-sign-up)). |
| `emailRedirectTo` | Where the confirmation link sends the user. Must be allowed (see [redirect URLs](#redirect-urls)). |

What comes back depends on **Confirm email addresses**:

| Confirm email addresses | `data.user` | `data.session` | Next step |
|---|---|---|---|
| Off | The new user | A session | The user is signed in. |
| On | The new user | `null` | Keel emails a confirmation link. Signing in fails with `email_not_confirmed` until it's used. |

Email addresses are trimmed and lowercased. Addresses with a display name, a list or quoting (such as `Ada <ada@example.com>`, `a@x.com, b@y.com` or `"ada"@example.com`) fail with `validation_failed`.

Signing up never changes an existing account:

- With confirmation off, signing up with an address that already has an account fails with `user_already_exists`.
- With confirmation on, Keel answers as if the account were new: `data.session` is `null` and `data.user` is a stand-in with a random `id` and an empty `identities` array, so the answer doesn't tell anyone whether the address is registered. Check `data.user.identities.length === 0` if you want to tell your user to sign in instead.
- If the account was never confirmed, Keel sends a new confirmation email (at most one a minute). The password and `user_metadata` stay as they were, except that when the new password differs from the stored one, the stored one is removed: nobody can tell which of the two sign-ups the address's owner made. Confirming then signs the owner in, and they can set a password with `updateUser`.

## Confirming email addresses

Find the switch in Studio under **Users** > **Sign-in settings** > **Email sign-in** > **Confirm email addresses**. Until you change it, it follows your mail server: on when [SMTP is set up](/auth/email), off when it isn't, since nobody could receive the email.

::: tip No mail server yet?
New accounts are confirmed right away, so you can build and test without email. If you switch confirmation on anyway, the emails are not sent and not logged either: confirm users with the admin API (`email_confirm: true`, see [Managing users](/auth/managing-users)), or test with [Mailpit](/auth/email#testing-with-mailpit).
:::

::: warning On a server the internet can reach
With sign-ups on and confirmation off, anyone can create an account and is signed in at once, so policies `to authenticated` let them in (see [Row level security](/database/row-level-security#how-it-works)). Studio shows a warning under **Users** when that's the case. New projects on a public URL (one that isn't localhost, a private or Tailscale address, or a `.local`/`.lan` name), or on a server with `KEEL_EXPOSURE=internet` (the installer sets it on a cloud server), start with confirmation on and, without a mail server, with sign-ups off until you set one up and turn them on. Existing projects keep their settings.
:::

The confirmation email has a button and a 6-digit code. Both work once, for one hour.

**The link** opens Keel, which confirms the address and redirects to `emailRedirectTo` (or your Site URL) with a session in the URL. supabase-js picks it up in the browser and signs the user in.

**The code** lets the user confirm inside your app, even on another device:

```js
const { data, error } = await keel.auth.verifyOtp({
  email: 'ada@example.com',
  token: '123456',
  type: 'email',
})
```

To send the email again:

```js
await keel.auth.resend({
  type: 'signup',
  email: 'ada@example.com',
  options: { emailRedirectTo: 'http://localhost:5173/welcome' },
})
```

## Signing in

```js
const { data, error } = await keel.auth.signInWithPassword({
  email: 'ada@example.com',
  password: 'a-long-password',
})
```

| `error.code` | Why |
|---|---|
| `invalid_credentials` | Wrong email or password. Keel doesn't say which, or whether the account exists. |
| `email_not_confirmed` | The user hasn't confirmed the address yet. |
| `user_banned` | You [banned the user](/auth/managing-users). |
| `over_request_rate_limit` | More than 10 attempts in 5 minutes for this email from one IP address, or more than 20 in an hour for this account from anywhere (then each further attempt waits longer, up to 5 minutes). |

## Password requirements

| Rule | Value |
|---|---|
| Minimum length | 8 characters (6 in projects created before Keel made 8 the default). Change it under **Users** > **Sign-in settings** > **Minimum password length** (6 to 72). |
| Maximum length | 72 characters |
| Other rules | None. Keel doesn't require digits or symbols and doesn't check for leaked passwords, so add your own checks in the sign-up form if you want them. |

A password that breaks the rules fails with `weak_password` and a message such as "Password should be at least 8 characters." Passwords are stored as bcrypt hashes with cost 12, the same format Supabase uses, so imported users keep their passwords. Hashes with a lower cost (from an import or an older Keel version) are upgraded the next time the user signs in with their password.

## Resetting a password

Password reset takes two steps. First, send the reset email:

```js
await keel.auth.resetPasswordForEmail('ada@example.com', {
  redirectTo: 'http://localhost:5173/update-password',
})
```

This always succeeds, whether or not the account exists, so it can't be used to find out who has an account. A second request for the same address within a minute fails with `over_email_send_rate_limit`, again whether or not the account exists.

Then, on the page the link opens, the user is signed in with a recovery session. supabase-js reports it as a `PASSWORD_RECOVERY` event. Ask for the new password and save it:

```js
keel.auth.onAuthStateChange(async (event) => {
  if (event === 'PASSWORD_RECOVERY') {
    const password = prompt('Choose a new password')
    const { error } = await keel.auth.updateUser({ password })
  }
})
```

The email also contains a 6-digit code, if you'd rather keep users in your app:

```js
await keel.auth.verifyOtp({ email: 'ada@example.com', token: '123456', type: 'recovery' })
await keel.auth.updateUser({ password: 'a-new-password' })
```

Things to know:

- The link needs somewhere to go. Without a Site URL or an allowed `redirectTo`, it ends on a Keel page that says "Almost there" and the user can't set a password.
- A recovery session hasn't passed [two-factor authentication](/auth/mfa). Users with a verified factor must complete an MFA challenge before `updateUser({ password })` works, otherwise it fails with `insufficient_aal`.
- Setting the new password signs out every other device; the recovery session stays signed in.
- In Studio, a user's detail view has a **Password reset link** button for when someone asks you for help.

## Changing the password

A signed-in user can change their password at any time:

```js
const { error } = await keel.auth.updateUser({ password: 'a-new-password' })
```

Keel doesn't ask for the current password, and `reauthenticate()` isn't supported. If you want that extra check, build it into your app. Users with two-factor authentication need an `aal2` session.

A new password ends the user's other sessions: other devices are signed out at their next request or refresh, while the session that made the change stays signed in. A password set by an admin (in Studio or with `auth.admin.updateUserById`) ends every session.

## Changing the email address

```js
const { data, error } = await keel.auth.updateUser(
  { email: 'ada@example.net' },
  { emailRedirectTo: 'http://localhost:5173/settings' },
)
```

- With **Confirm email addresses** off, the address changes immediately. Nobody has proven it belongs to the user, though, so if its owner later signs in with an email link or with Google or GitHub, the account's password, phone number and sessions are removed (see [Accounts and identities](/auth/oauth#accounts-and-identities)).
- With it on, Keel emails a link and a code to the **new** address only. Until the user confirms, `data.user.new_email` holds the pending address and the old one keeps working. Confirm in the app with the code and the new address:

  ```js
  await keel.auth.verifyOtp({ email: 'ada@example.net', token: '123456', type: 'email_change' })
  ```

- To send the email again, call `resend({ type: 'email_change', email })` with the user's **current** address.
- An address another account uses fails with `email_exists`. Users with two-factor authentication need an `aal2` session.

::: info Email changes and PKCE
The link in an email-change email always returns the session in the URL fragment. A client created with `flowType: 'pkce'` can't use that session (the address still changes). With PKCE, have users confirm with the code, or call `getUser()` afterwards to load the new address.
:::

## Redirect URLs

`emailRedirectTo` and `redirectTo` must point at your Site URL's origin or match an entry in **Other allowed redirect URLs**. Anything else is replaced by the Site URL. See [Site URL and redirect URLs](/auth/overview#site-url-and-redirect-urls) for the wildcard rules.

## Turning off sign-ups

To run an invite-only app, switch off **Allow new sign-ups**. `signUp` then fails with `signup_disabled`, while users you [invite or create](/auth/managing-users) can still sign in.
