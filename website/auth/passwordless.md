# Magic links and email codes

Let users sign in with nothing but their email address. Keel sends an email with a sign-in link and a 6-digit code; the user clicks the link or types the code, and they're in.

```js
const { error } = await keel.auth.signInWithOtp({
  email: 'ada@example.com',
  options: { emailRedirectTo: 'http://localhost:5173/welcome' },
})
```

You need a [mail server](/auth/email). Without one, the email isn't sent, and the link and code aren't logged either. While you develop, use [Mailpit](/auth/email#testing-with-mailpit) to receive them.

## Link or code?

Every email contains both, so you decide what to tell your users:

| | Magic link | Email code |
|---|---|---|
| The user | Clicks the button in the email | Types 6 digits into your app |
| The session arrives | In the redirect to your app, picked up by supabase-js | From `verifyOtp` |
| Other devices | Signs in whichever browser opens the link | Works anywhere, the app asks for the code |
| Needs | A Site URL or allowed `emailRedirectTo` | Nothing extra |

Codes work well in mobile apps and when users read email on a different device from the one they're signing in on.

## Signing in with the link

The link points at Keel's `/auth/v1/verify`. Keel checks it, then redirects to `emailRedirectTo` (or your Site URL) with the session in the URL fragment:

```text
http://localhost:5173/welcome#access_token=eyJ...&expires_at=1791025200&expires_in=3600&refresh_token=...&token_type=bearer&type=magiclink
```

In the browser, supabase-js reads the fragment when the page loads, stores the session and fires `SIGNED_IN`:

```js
keel.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN') console.log('Signed in as', session.user.email)
})
```

`emailRedirectTo` must be on your Site URL's origin or in the allow list, otherwise Keel uses the Site URL. See [Site URL and redirect URLs](/auth/overview#site-url-and-redirect-urls).

## Signing in with the code

```js
const { data, error } = await keel.auth.verifyOtp({
  email: 'ada@example.com',
  token: '482913',
  type: 'email',
})
// data.session is the new session; a wrong or old code fails with otp_expired
```

### verifyOtp types

| `type` | Accepts codes from | Use it for |
|---|---|---|
| `email` | Magic link, sign-up confirmation and invite emails | Email sign-in codes (recommended) |
| `magiclink` | Magic link and sign-up confirmation emails | Older code that still uses it |
| `signup` | Sign-up confirmation emails | [Confirming a new account](/auth/passwords#confirming-email-addresses) |
| `invite` | Invite emails | Accepting an invite |
| `recovery` | Password reset emails | [Resetting a password](/auth/passwords#resetting-a-password) |
| `email_change` | Email-change emails (pass the new address) | [Changing the email address](/auth/passwords#changing-the-email-address) |
| `sms`, `phone_change` | SMS codes | [Phone sign-in](/auth/phone) |

Instead of `email` and `token`, you can pass `token_hash`, for example the `hashed_token` that the admin API's [`generateLink`](/auth/managing-users#generating-links) returns:

```js
await keel.auth.verifyOtp({ token_hash: 'a8f3…', type: 'magiclink' })
```

## New users and shouldCreateUser

By default, `signInWithOtp` with an unknown address creates the account. The first email is titled "Confirm your signup", and using its link or code confirms the address and signs the user in. To store profile data on new accounts, pass `options.data`; it becomes `user_metadata`.

The first magic link used for an account whose address nobody had proven before (for example one that was confirmed automatically because **Confirm email addresses** was off) also removes the account's password, phone number, other sign-in methods and sessions, in case someone else registered the address first. See [Accounts and identities](/auth/oauth#accounts-and-identities).

To sign in existing users only, set `shouldCreateUser: false`:

```js
const { error } = await keel.auth.signInWithOtp({
  email: 'ada@example.com',
  options: { shouldCreateUser: false },
})
// error.code === 'otp_disabled' when there's no account with this address
```

New accounts are also refused (`otp_disabled`) when **Allow new sign-ups** is off.

::: info Pre-registered accounts
If someone signed up with an address and a password but never confirmed it, the first magic link or code the real owner uses removes that password. Nobody can register someone else's address in advance and keep a way in.
:::

## PKCE flow

With the PKCE flow, the link returns a one-time `code` in the query string instead of tokens in the URL. Your app exchanges the code for a session, which also works on a server. Turn it on when creating the client:

```js
const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY', {
  auth: { flowType: 'pkce' },
})

await keel.auth.signInWithOtp({
  email: 'ada@example.com',
  options: { emailRedirectTo: 'http://localhost:5173/auth/callback' },
})
```

The link then ends at `http://localhost:5173/auth/callback?code=...`. In a browser, supabase-js exchanges the code automatically when the page loads. In a server route, do it yourself:

```js
const code = new URL(request.url).searchParams.get('code')
const { data, error } = await keel.auth.exchangeCodeForSession(code)
```

- The link must be opened in the same browser that requested it, because supabase-js keeps the PKCE secret (the code verifier) there.
- The `code` works once, within 10 minutes. The link itself must be used within an hour of the request.
- Codes typed into your app with `verifyOtp` don't involve PKCE and work with either flow.

## Expiry and limits

| | |
|---|---|
| Link and code lifetime | 1 hour, single use |
| Requesting a new email | Replaces the previous link and code; only the newest works |
| Between two emails to the same user | 60 seconds (`over_email_send_rate_limit`) |
| Emails to one address | 6 per hour, counting every kind of auth email (`over_email_send_rate_limit`) |
| Emails per project | 100 per hour through your mail server (`over_email_send_rate_limit`) |
| `signInWithOtp` requests | 30 per hour per IP address, ten times that from your own network (`over_request_rate_limit`) |
| Code attempts | 10 per hour per address, right or wrong (`over_request_rate_limit`) |
| Verification requests | 30 per 5 minutes per IP address (`over_request_rate_limit`) |

The email code length and lifetime are fixed. The counters live in memory, so they reset when `keel-auth` restarts.

## Without a mail server

`signInWithOtp` still answers as usual, but no email goes out. The link and code are never written to a log: anyone can ask for a sign-in link for any address, so a logged link would let whoever reads the logs into that account. The `keel-auth` log only notes that the email wasn't sent, with the address masked.

To try magic links while you develop, run [Mailpit](/auth/email#testing-with-mailpit) and point the project's mail server at it, or create a link on your server with the admin API (`auth.admin.generateLink({ type: 'magiclink', email })` with the service role key). [Email setup](/auth/email) shows how to send real emails.
