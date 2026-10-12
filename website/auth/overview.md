# Overview

Keel Auth signs your users in, issues the tokens your app sends with every request, and keeps the accounts in your project's own database. It speaks the Supabase Auth (GoTrue) API, so `keel.auth` in supabase-js works unchanged.

```js
import { createClient } from '@supabase/supabase-js'

const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY')

const { data, error } = await keel.auth.signUp({ email: 'ada@example.com', password: 'a-long-password' })

// From now on, requests carry Ada's access token and row level security sees her user ID.
const { data: todos } = await keel.from('todos').select('*')
```

Every project has its own users, settings and signing keys. A user of `my-app` doesn't exist in any other project.

## Sign-in methods

| Method | supabase-js | What it needs | Guide |
|---|---|---|---|
| Email and password | `signUp`, `signInWithPassword` | Nothing. A mail server if you want confirmation emails. | [Email and password](/auth/passwords) |
| Magic link or 6-digit email code | `signInWithOtp({ email })`, `verifyOtp` | A mail server for real users | [Magic links and email codes](/auth/passwordless) |
| Phone: SMS or WhatsApp code, or phone and password | `signInWithOtp({ phone })`, `signUp({ phone, password })` | An SMS provider or your own webhook | [Phone (SMS) sign-in](/auth/phone) |
| GitHub, Google, Discord, GitLab, Microsoft | `signInWithOAuth` | An OAuth app at the provider | [Social sign-in](/auth/oauth) |
| Your own identity provider (Authentik, Keycloak, Authelia, Pocket ID, Zitadel...) | `signInWithOAuth({ provider: 'custom:<id>' })` | A client in your provider | [OpenID Connect providers](/auth/oidc) |
| Guest accounts | `signInAnonymously` | Turning it on | [Anonymous users](/auth/anonymous) |
| Second factor: authenticator app or SMS | `auth.mfa.*` | Nothing for authenticator apps | [Two-factor authentication](/auth/mfa) |

Email sign-in is always available. The other methods are switched on per project in Studio.

Keel doesn't support SAML single sign-on, passkeys (WebAuthn), Web3 wallets, Apple and other built-in OAuth providers not listed above, `signInWithIdToken`, linking identities (`linkIdentity`), `reauthenticate`, MFA recovery codes, CAPTCHA or auth hooks. See [Supabase compatibility](/reference/compatibility) for the full list.

## Sign-in settings

Open **Users** in Studio's dock and click the gear icon (**Sign-in settings**). Each project has its own settings, and changes apply within a second of clicking **Save settings**, without a restart.

| Section | What you set there |
|---|---|
| **URLs** | **Site URL** and **Other allowed redirect URLs**, see [below](#site-url-and-redirect-urls) |
| **Email sign-in** | **Allow new sign-ups**, **Confirm email addresses**, **Anonymous sign-ins**, **Minimum password length**, **Session token lifetime (seconds)** |
| **Phone sign-in** | SMS provider, message, code length and expiry, test numbers |
| **Two-factor authentication (MFA)** | Authenticator apps (TOTP) and SMS codes as a second factor |
| **GitHub**, **Google** | Callback URL, client ID and secret |
| **Mail server** | SMTP for this project (overrides the one in `.env`) |

Your app can check which methods are on with the anon key:

```bash
curl http://localhost:8000/my-app/auth/v1/settings \
  -H "apikey: YOUR_ANON_KEY"
```

```json
{
  "external": { "anonymous_users": false, "email": true, "phone": false, "github": true, "google": false, "discord": false, "gitlab": false, "azure": false, "custom:authentik": true },
  "disable_signup": false,
  "mailer_autoconfirm": true,
  "phone_autoconfirm": false,
  "sms_provider": "",
  "saml_enabled": false
}
```

## Sessions, tokens and row level security

A successful sign-in returns a **session**: a short-lived **access token** (a JWT, valid for one hour by default) and a **refresh token**. supabase-js stores the session (in `localStorage` in browsers), sends the access token as `Authorization: Bearer ...` with every request, and refreshes it before it expires.

Requests without a user token run in Postgres as the `anon` role. Requests with one run as `authenticated`, with the token's claims available to SQL through these helpers:

| Function | Returns |
|---|---|
| `auth.uid()` | The user's ID (the `sub` claim), or `null` |
| `auth.jwt()` | All claims as `jsonb`, for example `auth.jwt() ->> 'aal'` |
| `auth.role()` | `anon`, `authenticated` or `service_role` |
| `auth.email()` | The `email` claim |

That's how [row level security](/database/row-level-security) policies decide what each user sees:

```sql
create policy "Users manage their own notes" on notes for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Editors read every note" on notes for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'editor');
```

The same policies apply to the REST API, realtime change streams and file storage. React to sign-ins and sign-outs in your app with `onAuthStateChange`:

```js
keel.auth.onAuthStateChange((event, session) => {
  // SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED, PASSWORD_RECOVERY, ...
  console.log(event, session?.user.email)
})
```

[Sessions and tokens](/auth/sessions) lists every claim and explains refresh, sign-out and verifying tokens on your own server.

## The auth.users table

Users are rows in `auth.users` in your project's database. The schema matches Supabase's, so existing SQL, triggers and exports work.

| Column | What it holds |
|---|---|
| `id` | The user's UUID, the same value as `auth.uid()` |
| `email`, `phone` | Phone numbers are stored as digits without the `+`, for example `15555550100` |
| `raw_user_meta_data` | `user_metadata`: profile data the user can change |
| `raw_app_meta_data` | `app_metadata`: data only your server can change |
| `email_confirmed_at`, `phone_confirmed_at`, `confirmed_at` | When the address or number was confirmed |
| `last_sign_in_at`, `created_at` | Timestamps |
| `is_anonymous` | `true` for guest accounts |
| `banned_until` | Set when you ban a user |

Next to it are `auth.identities` (one row per sign-in method), `auth.sessions` and `auth.mfa_factors`.

The `anon` and `authenticated` roles can't read the `auth` tables, and the REST API only serves the `public` schema. Keep anything your app displays, such as names and avatars, in your own table that references `auth.users`.

### Create a profile on sign-up

A trigger on `auth.users` runs for every new user, whichever way they signed up (password, magic link, phone, OAuth, anonymous, invite or the admin API). Run this in Studio's **SQL** editor:

```sql
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url text
);

create policy "Signed-in users read profiles" on public.profiles
  for select to authenticated using (true);
create policy "Users update their own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (new.id, new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'avatar_url');
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

Then pass the profile data when signing up:

```js
await keel.auth.signUp({
  email: 'ada@example.com',
  password: 'a-long-password',
  options: { data: { display_name: 'Ada' } },
})
```

A few things to know:

- **Keep `security definer`.** Keel Auth writes to `auth.users` as its own database role, which has no rights on your tables. `security definer` runs the function as its owner (the project's owner role, `my_app_owner`). Without it, sign-ups fail with a `permission_denied` error.
- **The trigger runs inside the sign-up.** If it raises an error, the user isn't created and the app gets an error. Keep it small, and remember that phone and anonymous users have no email.
- `after update` triggers on `auth.users` work too, for example to copy a changed email into your own table.

## Site URL and redirect URLs

Email links and OAuth sign-ins finish by sending the browser back to your app, with the session in the URL. To stop attackers from redirecting sessions to their own sites, Keel only redirects to:

- any page on the **Site URL**'s origin, or
- a URL that matches an entry in **Other allowed redirect URLs**.

A `redirectTo` (or `emailRedirectTo`) that matches neither is replaced with the Site URL. Set both in Studio under **Users** > **Sign-in settings** > **URLs**:

| Setting | Examples |
|---|---|
| Site URL | `http://localhost:5173`, `https://app.example.com` |
| Other allowed redirect URLs (one per line) | `http://192.168.1.20:3000/**`, `https://*.example.com/auth/callback`, `myapp://auth-callback` |

In allow-list entries, `*` in the host matches one name (`*.example.com` matches `app.example.com` but not `a.b.example.com`). In the path, `*` matches one segment and `**` matches anything. Custom schemes such as `myapp://` work for mobile deep links once they're listed.

::: warning Set a Site URL early
Without one, confirmation and magic links still work but end on a plain Keel page instead of your app, and password reset and sign-in with a provider can't hand the session back to your app.
:::

## Turning off sign-ups

Switch off **Allow new sign-ups** to allow only users you invite or create yourself. `signUp` then fails with `signup_disabled`, `signInWithOtp` for an unknown address or number fails with `otp_disabled`, and sign-ins with a provider (GitHub, Google, OpenID Connect...) for new people fail. Existing users sign in as before, and [invites and the admin API](/auth/managing-users) still work.

## Errors

supabase-js returns errors with a `code` you can branch on. The ones you'll see most:

| `error.code` | Meaning |
|---|---|
| `invalid_credentials` | Wrong email, phone or password (also when the account doesn't exist) |
| `email_not_confirmed`, `phone_not_confirmed` | The user hasn't confirmed yet |
| `user_already_exists` | Sign-up with an address or number that already has an account, when confirmation is off (with confirmation on, sign-up answers as for a new user) |
| `weak_password` | Shorter than the minimum length, or longer than 72 characters |
| `otp_expired` | The link or code is wrong, used or expired |
| `over_email_send_rate_limit`, `over_sms_send_rate_limit`, `over_request_rate_limit` | Too many requests, try again later |
| `user_banned` | You banned this user |
| `insufficient_aal` | The action needs a session that passed two-factor authentication |

The [Auth API reference](/api/auth) lists every endpoint and its errors.

## Next steps

<div class="cards">
  <a class="card" href="./passwords"><strong>Email and password</strong><span>Sign-up, confirmation, password reset and email changes.</span></a>
  <a class="card" href="./passwordless"><strong>Magic links and email codes</strong><span>Passwordless sign-in by email, with or without PKCE.</span></a>
  <a class="card" href="./phone"><strong>Phone (SMS) sign-in</strong><span>Codes by SMS or WhatsApp through Twilio, Vonage, MessageBird or a webhook.</span></a>
  <a class="card" href="./oauth"><strong>Social sign-in</strong><span>GitHub, Google, Discord, GitLab and Microsoft with your own OAuth apps.</span></a>
  <a class="card" href="./oidc"><strong>OpenID Connect providers</strong><span>Authentik, Keycloak, Authelia, Pocket ID, Zitadel and others.</span></a>
  <a class="card" href="./anonymous"><strong>Anonymous users</strong><span>Guest accounts that can be upgraded later.</span></a>
  <a class="card" href="./mfa"><strong>Two-factor authentication</strong><span>Authenticator apps and SMS codes, enforced by your policies.</span></a>
  <a class="card" href="./sessions"><strong>Sessions and tokens</strong><span>Token claims, refresh, sign-out and verifying tokens.</span></a>
  <a class="card" href="./managing-users"><strong>Managing users</strong><span>Studio's Users panel and the admin API.</span></a>
  <a class="card" href="./email"><strong>Email setup</strong><span>SMTP, what happens without it, and testing with Mailpit.</span></a>
</div>
