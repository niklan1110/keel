# API keys and rotation

Each project has a public anon key and a secret service role key. This page explains what each one may do, how to roll them when one may have leaked, and how to check tokens on your own server. You find both keys in Studio under **Connect**:

| Key | Who uses it | Secret? |
|---|---|---|
| **anon key** | Browsers and apps, with row level security deciding what they may do | No. It ships in your app |
| **service role key** | Your servers, scripts and edge functions. It bypasses row level security and can manage users | Yes. Never put it in a browser, an app or a repository |

Both keys are JWTs (HS256) signed with the project's **signing key**, the same kind of key that signs your users' access tokens. They carry the project's name (`ref`), so a key from one project doesn't work on another. Like Supabase's keys they're long-lived (10 years): an app ships with its anon key. You replace them by rolling the keys instead.

## Rolling keys

Roll the keys when a key may have leaked (a service role key in a commit, a log, a chat), when someone with access leaves, or on a schedule.

**In Studio:** open **Connect**, choose how long the old keys keep working, and click **Roll keys**.

**On the server:**

```bash
./keel keys roll my-app              # old keys keep working for 24 hours
./keel keys roll my-app --grace 72   # ... or 72 hours (1 to 720)
./keel keys list my-app              # keys, and who rolled or stopped them when
```

A roll makes a new signing key and new anon and service role keys signed with it. Then:

- **The old keys keep working for the grace period** (24 hours unless you choose another), so apps and servers with the old anon or service role key carry on while you update them.
- **Signed-in users stay signed in.** Their access tokens keep working until they expire, and the next refresh gives them a token signed with the new key. Refresh tokens aren't tied to a signing key.
- **Edge functions get the new keys** (`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) on their next request.
- When the grace period ends, the old keys stop working by themselves.

Update your apps with the new keys from **Connect** (or the output of `keel keys roll`), then stop the old keys early if you like: **Stop old keys now** in Studio, or `./keel keys revoke-old my-app`. Wait at least as long as access tokens last (`jwt_exp`, an hour by default) after rolling, or users whose token was issued before the roll get "invalid JWT" until their app refreshes it.

## Emergency roll

If a key is being misused, don't wait: **Emergency roll** in Studio (type the project name to confirm), or

```bash
./keel keys roll my-app --emergency --yes
```

This makes new keys and stops every old key at once. It also ends every user session of the project, because a refresh token would otherwise get a fresh access token signed with the new key. Everyone signs in again, and your apps fail until they have the new anon key.

## How it works

- A project can have several signing keys at once. New tokens are signed with the newest one and name it in the `kid` field of their header. Keel's services (gateway, auth, REST, storage, realtime, functions) accept a token signed by any key that hasn't expired or been stopped; a token naming a key that's gone is refused. Tokens from before keys had ids (no `kid`) are checked against every active key.
- PostgREST gets all active keys as a JSON Web Key Set while a grace period runs, and restarts (for a second or two) when the set changes.
- Signed storage URLs and other short-lived links are signed with the signing key too, so a link made before a roll stops working when its key does.
- Each roll, stop and emergency sign-out is recorded with who did it (`studio:<account>` or `cli`) and when, in `keel.project_key_events`, and shown under **Connect**.
- The project also has an internal secret (`jwt_secret` in `keel.projects`) that seals two-factor secrets and derives refresh tokens and one-time codes. It never signs tokens and isn't rolled. Projects created before key rotation existed used it as their first signing key, which shows as `legacy`; once you've rolled and the grace period is over, it no longer signs or verifies anything.

## Verifying tokens in your own server

To check a user's token without asking Keel, verify it with the project's signing keys. Read the active ones from the control database:

```bash
./keel psql keel
```

```sql
select kid, secret, expires_at from keel.project_jwt_keys
 where project = 'my-app' and (expires_at is null or expires_at > now())
 order by created_at desc;
```

Pick the key whose `kid` matches the token's header (a token without `kid` comes from the `legacy` key). After a roll, fetch the keys again. The simplest alternative, which also notices signed-out sessions, is to ask Keel: `GET /my-app/auth/v1/user` with the token (see [Sessions and tokens](/auth/sessions#verifying-tokens-on-your-own-server)).


## Next steps

<div class="cards">
  <a class="card" href="../auth/sessions"><strong>Sessions and tokens</strong><span>What is in a user token and how long it lasts.</span></a>
  <a class="card" href="../self-hosting/security"><strong>Security checklist</strong><span>Keep the service role key and the server safe.</span></a>
</div>
