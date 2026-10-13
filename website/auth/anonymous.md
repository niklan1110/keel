# Anonymous users

Anonymous sign-in gives visitors a real user account without asking for an email or password. They can save data under their own user ID straight away, and you can upgrade them to a permanent account later without losing anything.

```js
const { data, error } = await keel.auth.signInAnonymously()
// data.user.is_anonymous === true, data.session is a normal session
```

Use it for guest checkouts, trying an app before signing up, or games and polls where accounts would get in the way.

## Turning it on

In Studio, open **Users**, click the gear icon (**Sign-in settings**) and switch on **Anonymous sign-ins** under **Email sign-in**. It's off by default. While it's off, `signInAnonymously` fails with `anonymous_provider_disabled`.

**Allow new sign-ups** doesn't affect anonymous sign-ins: to stop them, switch off **Anonymous sign-ins** itself.

To store data on the new user, pass `options.data`; it becomes their `user_metadata`:

```js
await keel.auth.signInAnonymously({ options: { data: { nickname: 'Guest 42' } } })
```

## What an anonymous user is

- A row in `auth.users` with `is_anonymous = true` and no email, phone or password.
- A signed-in user with the `authenticated` role. **Policies written `to authenticated` include anonymous users.**
- Their access token has `"is_anonymous": true`, and the `amr` claim lists the method `anonymous`.
- In Studio they're listed as "Anonymous user" with an **Anonymous** badge.

The session refreshes like any other. But if the user signs out, clears their browser storage or switches devices, there's no way back into the account. Encourage people to convert before that happens.

## Row level security

Check the `is_anonymous` claim when guests should be able to do less:

```sql
-- Everyone who is signed in, guests included, can read posts.
create policy "Signed-in users read posts" on posts
  for select to authenticated
  using (true);

-- Only permanent users can write them.
create policy "Permanent users create posts" on posts
  for insert to authenticated
  with check (
    (select (auth.jwt() ->> 'is_anonymous')::boolean) is false
    and author_id = auth.uid()
  );
```

To keep guests out of a table entirely, add a restrictive policy. Postgres combines it with `and` on top of your other policies:

```sql
create policy "No guests" on invoices
  as restrictive
  for all to authenticated
  using ((select (auth.jwt() ->> 'is_anonymous')::boolean) is false);
```

The same check works in [storage policies](/storage/access-control) and [private realtime channels](/realtime/authorization).

## Converting to a permanent account

The user keeps their ID, so every row they own stays theirs.

### With an email address

```js
const { data, error } = await keel.auth.updateUser({ email: 'ada@example.com' })
```

- With **Confirm email addresses** off, the email is saved immediately and the user is no longer anonymous. You can set a password in the same call: `updateUser({ email, password })`.
- With it on, Keel emails a link and a code to the address. The user stays anonymous until they use one of them (or `verifyOtp({ email, token, type: 'email_change' })`). Then set a password with `updateUser({ password })`.

If the address already belongs to another account, the call fails with `email_exists`. Keel doesn't merge accounts: sign the person in to their existing account and copy over anything you want to keep.

### With a phone number

```js
await keel.auth.updateUser({ phone: '+15555550100' })
await keel.auth.verifyOtp({ phone: '+15555550100', token: '123456', type: 'phone_change' })
```

This needs [phone sign-in](/auth/phone) to be set up. With **Confirm phone numbers** off, the number is saved without a code.

### Refresh the token afterwards

The access token the user already holds still says `"is_anonymous": true` until it's replaced. Refresh it so your policies see the change straight away:

```js
await keel.auth.refreshSession()
```

Linking a provider account (GitHub, Google, an OpenID Connect provider...) to an anonymous user (`linkIdentity`) isn't supported.

## Cleaning up old guests

Anonymous accounts pile up. Delete the ones that haven't been used for a while, for example from Studio's **SQL** editor. This removes guests created more than 30 days ago whose sessions haven't refreshed in that time:

```sql
delete from auth.users u
where u.is_anonymous
  and u.created_at < now() - interval '30 days'
  and not exists (
    select 1 from auth.sessions s
    where s.user_id = u.id
      and coalesce(s.refreshed_at, s.created_at) > now() - interval '30 days'
  );
```

Deleting a user also removes rows in your tables that reference `auth.users` with `on delete cascade`. Keel has no built-in scheduler, so run this by hand or from a scheduled script that [connects to Postgres directly](/database/connecting-directly).

## Abuse

Every call to `signInAnonymously` creates a user. Keel allows 30 anonymous sign-ins per hour from one IP address (`over_request_rate_limit`; ten times that from your own network), but doesn't support CAPTCHA (`captchaToken` is ignored), so a script spread over many addresses could still create many accounts. Leave the switch off unless you need it, and use policies to limit what guests can write.
