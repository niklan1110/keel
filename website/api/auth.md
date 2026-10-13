# Auth

`keel-auth` serves a GoTrue-compatible API under `/auth/v1`, the same API supabase-js's `auth` client calls. Paths below are relative to the project's API URL, `http://localhost:8000/my-app`. For guides, see [Auth overview](/auth/overview).

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/token?grant_type=password' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"a-long-password"}'
```

## Keys and tokens

| Endpoints | Headers |
|---|---|
| Most endpoints | `apikey: YOUR_ANON_KEY` (or the service role key). Missing or wrong keys get a 401 from the gateway. |
| The current user (`/user`, `/logout`, `/factors`) | `apikey` plus `Authorization: Bearer USER_ACCESS_TOKEN` |
| Admin endpoints, marked **Service role** | `apikey` plus `Authorization: Bearer YOUR_SERVICE_ROLE_KEY`. Other tokens get `403 not_admin`. |
| `GET /verify`, `GET /authorize`, `GET /callback`, `GET /.well-known/jwks.json` | None. Browsers open these directly. |

Request bodies are JSON (`application/x-www-form-urlencoded` is accepted too).

## Errors

Errors from `keel-auth` look like this, with the HTTP status repeated in `code`:

```json
{ "code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials" }
```

supabase-js exposes `error_code` as `error.code`. Errors from the gateway, such as a missing API key, have a different shape: `{ "message": "No API key found in request" }`. See [Errors](/api/errors) for codes shared across services.

Endpoints that send email (`/signup`, `/otp`, `/recover`, `/resend`, `/invite`, `PUT /user`) answer `500` with `unexpected_failure` and the message `Error sending email` when the mail server refuses the message. The reason is in the `keel-auth` log.

## Rate limits

Limits are per project and kept in memory, so they reset when `keel-auth` restarts. Over a limit, requests get status 429.

| What | Limit | `error_code` |
|---|---|---|
| `POST /token`, per IP address | 120 per 5 minutes | `over_request_rate_limit` |
| Password sign-ins, per IP address and email or phone | 10 per 5 minutes | `over_request_rate_limit` |
| Password sign-ins, per email or phone from all addresses | 20 per hour, then a wait that doubles with each attempt (1 second up to 5 minutes); a successful sign-in resets it | `over_request_rate_limit` |
| `POST /signup` with an email or phone, per IP address | 30 per hour | `over_request_rate_limit` |
| Anonymous sign-ins (`POST /signup` without credentials), per IP address | 30 per hour | `over_request_rate_limit` |
| `POST /otp`, `POST /recover` and `POST /resend`, per IP address | 30 per hour each | `over_request_rate_limit` |
| `GET /authorize`, per IP address | 60 per 5 minutes | `over_request_rate_limit` |
| `POST /verify` and `GET /verify`, per IP address | 30 per 5 minutes | `over_request_rate_limit` |
| Code attempts, per email address or phone number | 10 per hour | `over_request_rate_limit` |
| Emails, per address | 6 per hour | `over_email_send_rate_limit` |
| Emails sent through SMTP, per project | 100 per hour | `over_email_send_rate_limit` |
| The same kind of email or SMS to one user | 1 per 60 seconds | `over_email_send_rate_limit` (email) or `over_sms_send_rate_limit` (SMS) |
| `POST /recover` and `POST /resend`, per email address or phone number | 1 per 60 seconds, whether or not it has an account | `over_email_send_rate_limit` or `over_sms_send_rate_limit` |
| SMS codes per IP address, per number, per project | 10, 6 and 60 per hour | `over_sms_send_rate_limit` |
| Phone MFA challenges, per factor | 1 per 15 seconds | `over_sms_send_rate_limit` |
| MFA verifications, per user | 10 per 5 minutes | `over_request_rate_limit` |

IPv6 addresses count per `/64`. Callers on your own network (`KEEL_LOCAL_NETWORKS`: LAN, Tailscale, the machine itself) get ten times the per-IP allowances, since one address there is usually you or a test suite. Behind a reverse proxy or tunnel, Keel sees the real client address only from proxies it trusts (see [Visitor addresses and proxies](/self-hosting/remote-access#visitor-addresses-and-proxies)); a request any other proxy passed on counts as the internet, under that proxy's address. Test phone numbers skip the SMS sending limits.

Endpoints that must not reveal whether an address has an account (`/signup` with confirmation on, `/recover`, `/resend`) count their per-address limits before looking the address up, and skip per-account limits (such as the 60 seconds between two emails to one user) without an error.

## Objects

### User

Returned by `/user`, `/signup` (when confirmation is needed), `/invite` and the admin endpoints. Fields without a value are left out.

```json
{
  "id": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b",
  "aud": "authenticated",
  "role": "authenticated",
  "email": "ada@example.com",
  "email_confirmed_at": "2026-10-03T09:12:44.120Z",
  "phone": "",
  "confirmed_at": "2026-10-03T09:12:44.120Z",
  "last_sign_in_at": "2026-10-03T09:12:44.180Z",
  "app_metadata": { "provider": "email", "providers": ["email"] },
  "user_metadata": { "display_name": "Ada" },
  "identities": [
    {
      "identity_id": "b1e0d7c4-2f7a-4d2e-9c51-0a6f3e8b9d12",
      "id": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b",
      "user_id": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b",
      "identity_data": { "sub": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b", "email": "ada@example.com", "email_verified": true, "phone_verified": false },
      "provider": "email",
      "last_sign_in_at": "2026-10-03T09:12:44.180Z",
      "created_at": "2026-10-03T09:12:44.110Z",
      "updated_at": "2026-10-03T09:12:44.110Z",
      "email": "ada@example.com"
    }
  ],
  "created_at": "2026-10-03T09:12:44.110Z",
  "updated_at": "2026-10-03T09:12:44.180Z",
  "is_anonymous": false
}
```

Other fields that appear when set: `phone_confirmed_at`, `confirmation_sent_at`, `recovery_sent_at`, `new_email` and `email_change_sent_at` (pending email change), `new_phone` and `phone_change_sent_at`, `invited_at`, and `factors` (only when the user has MFA factors). Admin endpoints add `banned_until` and `deleted_at`. Phone numbers are digits without a `+`.

### Session

Returned by every sign-in and by refreshes:

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer",
  "expires_in": 3600,
  "expires_at": 1791025200,
  "refresh_token": "q3Vx9P0mJ8cS2bKfT7wLzY1nR4eH6aDo",
  "user": { "id": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b", "...": "..." }
}
```

After sign-in with a provider (`signInWithOAuth`) it also has `provider_token` and, when the provider sends one, `provider_refresh_token`. The access token's claims are listed in [Sessions and tokens](/auth/sessions#access-token-claims).

## Sign-up and sign-in

### <code class="method post">POST</code> /auth/v1/signup

Creates a user with an email or phone number and a password. With no email, phone or password, creates an [anonymous user](/auth/anonymous) instead.

| Name | Type | Description |
|---|---|---|
| `email` | string | The email address. Required unless `phone` is given. |
| `phone` | string | Phone number in E.164 format. Needs phone sign-in to be on. |
| `password` | string | Required with `email` or `phone`. |
| `data` | object | Stored as `user_metadata` |
| `channel` | string | Phone only: `sms` (default) or `whatsapp` |
| `code_challenge`, `code_challenge_method` | string | Email only: start a PKCE flow (`s256` or `plain`) |
| `redirect_to` | string | Query parameter (or body field). Where the confirmation link leads. |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/signup' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"a-long-password","data":{"display_name":"Ada"}}'
```

Returns a [session](#session) when no confirmation is needed, otherwise the [user](#user) (and sends the confirmation email or SMS). Errors: `user_already_exists`, `weak_password`, `signup_disabled`, `validation_failed`, `anonymous_provider_disabled`, `phone_provider_disabled` (all 4xx), `over_request_rate_limit`, `over_email_send_rate_limit`, `over_sms_send_rate_limit` (429).

Sign-up never changes an existing account. When the address or number already has one:

- Without confirmation (autoconfirm on), it fails with `user_already_exists`.
- With confirmation on, it answers like a new sign-up: a user object with a random `id`, the `email` or `phone` you sent, your `data` as `user_metadata` and an empty `identities` array, as GoTrue does. Nothing in it comes from the existing account. An unconfirmed account gets a new confirmation email or SMS (at most one a minute). If the password differs from the one stored, the stored password is removed, since nobody can tell which sign-up the owner made: confirming then signs the owner in, and they set a password afterwards.

### <code class="method post">POST</code> /auth/v1/token?grant_type=password

Signs in with a password.

| Name | Type | Description |
|---|---|---|
| `email` | string | Required unless `phone` is given |
| `phone` | string | Phone number |
| `password` | string | **Required** |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/token?grant_type=password' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"a-long-password"}'
```

Returns a [session](#session). Errors (400): `invalid_credentials`, `email_not_confirmed`, `phone_not_confirmed`, `user_banned`, `phone_provider_disabled`.

### <code class="method post">POST</code> /auth/v1/token?grant_type=refresh_token

Exchanges a refresh token for a new session. For 10 seconds after a refresh token is used, it still works, but returns the session's current refresh token instead of a new one (two tabs refreshing at once end up with the same token). Reusing it after that ends the session.

| Name | Type | Description |
|---|---|---|
| `refresh_token` | string | **Required** |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/token?grant_type=refresh_token' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"refresh_token":"q3Vx9P0mJ8cS2bKfT7wLzY1nR4eH6aDo"}'
```

Returns a [session](#session) with a new refresh token. Errors (400): `refresh_token_not_found`, `refresh_token_already_used`, `user_banned`.

### <code class="method post">POST</code> /auth/v1/token?grant_type=pkce

Exchanges the `code` from a PKCE redirect for a session. Codes work once, within 10 minutes. A failed attempt, such as a wrong `code_verifier`, uses the code up too.

| Name | Type | Description |
|---|---|---|
| `auth_code` | string | **Required.** The `code` query parameter from the redirect. |
| `code_verifier` | string | **Required.** The verifier whose hash was sent as `code_challenge`. |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/token?grant_type=pkce' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"auth_code":"5d1c7f0e-8a43-4b8e-9b5a-2f6c0d9e1a37","code_verifier":"N2vT0rX..."}'
```

Returns a [session](#session). Errors: `flow_state_not_found` (404), `flow_state_expired` (400), `bad_code_verifier` (403). Any other `grant_type` fails with `unsupported_grant_type` (400).

### <code class="method post">POST</code> /auth/v1/otp

Sends a magic link and code by email, or a code by SMS. Creates the user if needed.

| Name | Type | Description |
|---|---|---|
| `email` | string | Required unless `phone` is given |
| `phone` | string | Phone number. Needs phone sign-in to be on. |
| `create_user` | boolean | Default `true`. With `false`, unknown addresses get `otp_disabled`. |
| `data` | object | `user_metadata` for a new user |
| `channel` | string | Phone only: `sms` (default) or `whatsapp` (Twilio) |
| `code_challenge`, `code_challenge_method` | string | Email only: start a PKCE flow |
| `redirect_to` | string | Query parameter (or body field). Where the link leads. |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/otp?redirect_to=http://localhost:5173/welcome' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com"}'
```

```json
{}
```

For phone numbers the response is `{ "message_id": "SM8f1c..." }`, the provider's message ID. Errors: `otp_disabled`, `phone_provider_disabled`, `validation_failed` (4xx), `over_email_send_rate_limit`, `over_sms_send_rate_limit` (429), `sms_send_failed`, `unexpected_failure` (500).

### <code class="method post">POST</code> /auth/v1/verify

Checks a code or token hash and signs the user in.

| Name | Type | Description |
|---|---|---|
| `type` | string | **Required.** `email`, `magiclink`, `signup`, `invite`, `recovery`, `email_change`, `sms` or `phone_change` |
| `email` + `token` | string | An email address and the 6-digit code sent to it |
| `phone` + `token` | string | A phone number and its SMS code. The only option for `sms` and `phone_change`. |
| `token_hash` | string | The token hash from an email link or `generate_link` |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/verify' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"email","email":"ada@example.com","token":"482913"}'
```

Returns a [session](#session). Errors: `otp_expired` (403, wrong, used or expired), `validation_failed` (400), `over_request_rate_limit` (429).

### <code class="method get">GET</code> /auth/v1/verify

The target of the links in Keel's emails. Browsers open it directly, without an API key.

| Name | Type | Description |
|---|---|---|
| `token` | string | **Required.** The token hash |
| `type` | string | **Required.** `signup`, `invite`, `magiclink`, `recovery`, `email_change` (or `email`) |
| `redirect_to` | string | Where to send the browser. Falls back to the Site URL if it isn't allowed. |

```bash
curl -i 'http://localhost:8000/my-app/auth/v1/verify?token=5be1...&type=magiclink&redirect_to=http://localhost:5173/welcome'
```

```text
HTTP/1.1 303 See Other
Location: http://localhost:5173/welcome#access_token=eyJ...&expires_at=1791025200&expires_in=3600&refresh_token=q3Vx...&token_type=bearer&type=magiclink
```

When the request started a PKCE flow, the redirect carries `?code=...` instead. Without a Site URL or `redirect_to`, Keel confirms the address and shows a short HTML page. A bad or expired link redirects with `#error=access_denied&error_code=...&error_description=...`, or shows an error page. SMS codes can't be verified here.

### <code class="method post">POST</code> /auth/v1/resend

Sends a confirmation email or SMS again. Does nothing (and still succeeds) when there's nothing pending. A second request for the same address or number within 60 seconds fails with `over_email_send_rate_limit` (or `over_sms_send_rate_limit`) whether or not there was anything to send.

| Name | Type | Description |
|---|---|---|
| `type` | string | **Required.** `signup`, `email_change`, `sms` or `phone_change` |
| `email` | string | For `signup` and `email_change`: the user's current address |
| `phone` | string | For `sms`: the number to confirm. For `phone_change`: the new number. |
| `redirect_to` | string | Query parameter. Where the link leads. |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/resend' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"signup","email":"ada@example.com"}'
```

```json
{ "message_id": null }
```

### <code class="method post">POST</code> /auth/v1/recover

Sends a password reset email. Always returns `{}`, whether or not the account exists. A second request for the same address within 60 seconds fails with `over_email_send_rate_limit`, also whether or not the account exists.

| Name | Type | Description |
|---|---|---|
| `email` | string | **Required** |
| `code_challenge`, `code_challenge_method` | string | Start a PKCE flow |
| `redirect_to` | string | Query parameter (or body field). Where the link leads. |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/recover?redirect_to=http://localhost:5173/update-password' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com"}'
```

```json
{}
```

### <code class="method post">POST</code> /auth/v1/logout

Ends sessions of the user who owns the access token. Needs `Authorization: Bearer USER_ACCESS_TOKEN`.

| Name | Type | Description |
|---|---|---|
| `scope` | string | Query parameter: `global` (default, every session), `local` (this session) or `others` (every other session) |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/logout?scope=local' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

Returns `204 No Content`.

## The current user

### <code class="method get">GET</code> /auth/v1/user

Returns the user who owns the access token, after checking that the session still exists. Use it to verify tokens on your own server.

```bash
curl 'http://localhost:8000/my-app/auth/v1/user' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

Returns the [user](#user). Errors: `no_authorization` (401), `bad_jwt`, `session_not_found`, `user_not_found` (403).

### <code class="method put">PUT</code> /auth/v1/user

Updates the signed-in user. Needs `Authorization: Bearer USER_ACCESS_TOKEN`.

| Name | Type | Description |
|---|---|---|
| `data` | object | Merged into `user_metadata`; keys set to `null` are removed |
| `password` | string | New password. Ends the user's other sessions; the one making the change stays signed in. |
| `email` | string | New email. Changes at once, or after confirming a link sent to the new address when confirmation is on. |
| `phone` | string | New phone number. Changes after verifying an SMS code (`type: phone_change`) unless phone confirmation is off. |
| `channel` | string | For `phone`: `sms` or `whatsapp` |
| `redirect_to` | string | Query parameter. Where the email-change link leads. |

```bash
curl -X PUT 'http://localhost:8000/my-app/auth/v1/user' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"data":{"display_name":"Ada L."}}'
```

Returns the updated [user](#user). Errors: `insufficient_aal` (401, the user has MFA and the session isn't `aal2`; applies to `email`, `phone` and `password`), `email_exists`, `phone_exists`, `weak_password` (422).

## OAuth

### <code class="method get">GET</code> /auth/v1/authorize

Starts sign-in with a provider. Open it in the browser; no API key. Sets a cookie, `keel-oauth-PROJECT` (HttpOnly, `SameSite=Lax`, 10 minutes, `Secure` when `KEEL_PUBLIC_URL` is https), that ties the sign-in to this browser.

| Name | Type | Description |
|---|---|---|
| `provider` | string | **Required.** `github`, `google`, `discord`, `gitlab`, `azure`, or `custom:<id>` for an [OpenID Connect provider](/auth/oidc) |
| `redirect_to` | string | Where to return after sign-in |
| `scopes` | string | Extra provider scopes, separated by spaces |
| `code_challenge`, `code_challenge_method` | string | Start a PKCE flow |

```bash
curl -i 'http://localhost:8000/my-app/auth/v1/authorize?provider=github&redirect_to=http://localhost:5173/welcome'
```

```text
HTTP/1.1 302 Found
Location: https://github.com/login/oauth/authorize?client_id=...&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fmy-app%2Fauth%2Fv1%2Fcallback&state=...&scope=read%3Auser+user%3Aemail
Set-Cookie: keel-oauth-my-app=...; Path=/; Max-Age=600; HttpOnly; SameSite=Lax
```

A provider that isn't switched on fails with `validation_failed` (400). For GitLab, Microsoft and OpenID Connect providers, Keel first reads the provider's discovery document; if it can't, `/authorize` fails with `bad_oauth_callback` (502).

### <code class="method get">GET</code> /auth/v1/callback

Where providers send the browser back. You register this URL with the provider and never call it yourself. Keel finishes the sign-in and redirects to `redirect_to` with the session in the URL fragment, or with `?code=` for PKCE. On failure it redirects with `#error=...&error_code=...&error_description=...`. The sign-in must finish within 10 minutes of `/authorize`, in the same browser (it needs the cookie `/authorize` set), and each callback URL works once; otherwise Keel shows an error page instead of redirecting.

## Multi-factor authentication

All MFA endpoints need `Authorization: Bearer USER_ACCESS_TOKEN`. See [Two-factor authentication](/auth/mfa).

### <code class="method post">POST</code> /auth/v1/factors

Enrolls a new, unverified factor.

| Name | Type | Description |
|---|---|---|
| `factor_type` | string | **Required.** `totp` or `phone` |
| `friendly_name` | string | Optional name, unique per user |
| `issuer` | string | TOTP: name shown in the authenticator app |
| `phone` | string | Phone factors: the number, **required** |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/factors' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"factor_type":"totp","friendly_name":"Phone app"}'
```

```json
{
  "id": "0f6b2c1e-7d3a-4b9f-8e21-6c5d4a3b2e10",
  "type": "totp",
  "friendly_name": "Phone app",
  "totp": {
    "qr_code": "<svg ...>...</svg>",
    "secret": "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    "uri": "otpauth://totp/localhost%3A5173%3Aada%40example.com?secret=JBSW...&issuer=localhost%3A5173&algorithm=SHA1&digits=6&period=30"
  }
}
```

`qr_code` is SVG markup (supabase-js turns it into a `data:` URL). Phone factors return `{ id, type, friendly_name, phone }`. Errors (422 unless noted): `validation_failed` (400), `session_not_found` (403), `mfa_totp_enroll_not_enabled`, `mfa_phone_enroll_not_enabled`, `insufficient_aal`, `too_many_enrolled_mfa_factors`, `mfa_factor_name_conflict`, `phone_factor_already_exists`.

### <code class="method post">POST</code> /auth/v1/factors/:id/challenge

Creates a challenge for a factor. For phone factors, this sends the SMS.

| Name | Type | Description |
|---|---|---|
| `id` | string | **Required.** Path parameter: the factor ID |
| `channel` | string | Phone factors: `sms` (default) or `whatsapp` |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/factors/0f6b2c1e-7d3a-4b9f-8e21-6c5d4a3b2e10/challenge' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

```json
{ "id": "c2a7e9d4-1b3f-4e8a-9d6c-5f0b2a1e7d39", "type": "totp", "expires_at": 1791021900 }
```

Challenges expire after 5 minutes. Errors: `mfa_factor_not_found` (404), `mfa_totp_verify_not_enabled`, `mfa_phone_verify_not_enabled` (422), `over_sms_send_rate_limit` (429).

### <code class="method post">POST</code> /auth/v1/factors/:id/verify

Verifies a code against a challenge. Marks the factor verified, upgrades the session to `aal2` and returns new tokens.

| Name | Type | Description |
|---|---|---|
| `id` | string | **Required.** Path parameter: the factor ID |
| `challenge_id` | string | **Required** |
| `code` | string | **Required.** The code from the app or SMS |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/factors/0f6b2c1e-7d3a-4b9f-8e21-6c5d4a3b2e10/verify' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"challenge_id":"c2a7e9d4-1b3f-4e8a-9d6c-5f0b2a1e7d39","code":"123456"}'
```

Returns a [session](#session) whose access token has `"aal": "aal2"`. Errors: `mfa_challenge_not_found` (404), `mfa_challenge_expired`, `mfa_verification_failed`, `insufficient_aal` (422), `over_request_rate_limit` (429).

### <code class="method delete">DELETE</code> /auth/v1/factors/:id

Removes one of the user's factors. Removing a verified factor needs an `aal2` session.

```bash
curl -X DELETE 'http://localhost:8000/my-app/auth/v1/factors/0f6b2c1e-7d3a-4b9f-8e21-6c5d4a3b2e10' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

```json
{ "id": "0f6b2c1e-7d3a-4b9f-8e21-6c5d4a3b2e10" }
```

## Admin

Every endpoint in this section is **Service role**: send `Authorization: Bearer YOUR_SERVICE_ROLE_KEY`. Only call them from servers you control.

### <code class="method post">POST</code> /auth/v1/invite

**Service role.** Creates a user if needed and emails an invite link.

| Name | Type | Description |
|---|---|---|
| `email` | string | **Required** |
| `data` | object | `user_metadata` for a new user |
| `redirect_to` | string | Query parameter (or body field). Where the link leads. |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/invite' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"grace@example.com","data":{"team":"design"}}'
```

Returns the [user](#user). An address with a confirmed account fails with `email_exists` (422).

### <code class="method get">GET</code> /auth/v1/admin/users

**Service role.** Lists users, newest first. The `X-Total-Count` response header holds the total number of users, and a `Link` header has the `next` and `last` pages, as in GoTrue. supabase-js's `listUsers()` returns them as `total`, `nextPage` and `lastPage`.

| Name | Type | Description |
|---|---|---|
| `page` | number | Query parameter. Default 1. |
| `per_page` | number | Query parameter. Default 50, maximum 1000. |

```bash
curl 'http://localhost:8000/my-app/auth/v1/admin/users?page=1&per_page=50' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY"
```

```json
{ "users": [{ "id": "8d2b6f2e-...", "email": "ada@example.com", "...": "..." }], "aud": "authenticated" }
```

### <code class="method post">POST</code> /auth/v1/admin/users

**Service role.** Creates a user. No email or SMS is sent.

| Name | Type | Description |
|---|---|---|
| `email` | string | Required unless `phone` is given |
| `phone` | string | Phone number |
| `password` | string | Optional |
| `email_confirm`, `phone_confirm` | boolean | `true` marks the address or number as confirmed |
| `user_metadata`, `app_metadata` | object | Initial metadata |
| `role` | string | Postgres role for the user's tokens. Default `authenticated`. |
| `ban_duration` | string | Create the user banned, for example `24h` |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/admin/users' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"grace@example.com","password":"a-long-password","email_confirm":true,"app_metadata":{"role":"editor"}}'
```

Returns the [user](#user). Errors: `email_exists`, `phone_exists`, `weak_password` (422).

### <code class="method get">GET</code> /auth/v1/admin/users/:id

**Service role.** Returns one [user](#user), including `banned_until` and `deleted_at`.

```bash
curl 'http://localhost:8000/my-app/auth/v1/admin/users/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY"
```

An unknown ID fails with `user_not_found` (404).

### <code class="method put">PUT</code> /auth/v1/admin/users/:id

**Service role.** Updates a user. Changes apply immediately, without confirmation emails.

| Name | Type | Description |
|---|---|---|
| `email` | string | New email. Counts as unproven (see [OAuth accounts](/auth/oauth#accounts-and-identities)) unless `email_confirm` is `true`. |
| `phone` | string | New phone number (unconfirmed until `phone_confirm`). An empty string removes it. |
| `password` | string | New password. Ends all of the user's sessions. |
| `email_confirm`, `phone_confirm` | boolean | `true` marks the address or number as confirmed (and the email as proven) |
| `user_metadata`, `app_metadata` | object | Merged into the existing metadata; `null` values remove keys |
| `role` | string | Postgres role for the user's tokens |
| `ban_duration` | string | `24h`, `90m`, `1h30m` and so on (units `h`, `m`, `s`, `ms`), or `none` to lift a ban. Banning ends all sessions. |

```bash
curl -X PUT 'http://localhost:8000/my-app/auth/v1/admin/users/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ban_duration":"24h"}'
```

Returns the updated [user](#user). Errors: `user_not_found` (404), `email_exists`, `phone_exists`, `weak_password` (422), `validation_failed` (400, bad `ban_duration`).

### <code class="method delete">DELETE</code> /auth/v1/admin/users/:id

**Service role.** Deletes a user with their sessions and identities.

| Name | Type | Description |
|---|---|---|
| `should_soft_delete` | boolean | Body. `true` keeps the row with `deleted_at` set and clears the email, phone, password and `user_metadata`. |

```bash
curl -X DELETE 'http://localhost:8000/my-app/auth/v1/admin/users/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY"
```

```json
{}
```

A hard delete fails with `foreign_key_violation` (409) when one of your tables references the user without `on delete cascade` or `set null`.

### <code class="method post">POST</code> /auth/v1/admin/generate_link

**Service role.** Creates an email link and code without sending anything.

| Name | Type | Description |
|---|---|---|
| `type` | string | **Required.** `signup`, `invite`, `magiclink`, `recovery`, `email_change_current` or `email_change_new` |
| `email` | string | **Required.** The user's address. `magiclink`, `recovery` and email changes need an existing user. |
| `password` | string | `signup`: password for the new user |
| `data` | object | `signup` and `invite`: `user_metadata` for a new user |
| `new_email` | string | Email changes: the new address |
| `redirect_to` | string | Body field or query parameter. Where the link leads. |

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/admin/generate_link' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"magiclink","email":"ada@example.com","redirect_to":"http://localhost:5173/welcome"}'
```

```json
{
  "id": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b",
  "email": "ada@example.com",
  "...": "...",
  "action_link": "http://localhost:8000/my-app/auth/v1/verify?token=5be1...&type=magiclink&redirect_to=http%3A%2F%2Flocalhost%3A5173%2Fwelcome",
  "email_otp": "482913",
  "hashed_token": "5be1...",
  "verification_type": "magiclink",
  "redirect_to": "http://localhost:5173/welcome"
}
```

The response is the [user](#user) plus the link fields. Errors: `user_not_found` (404), `email_exists` (422), `validation_failed` (400).

### <code class="method get">GET</code> /auth/v1/admin/users/:id/factors

**Service role.** Lists a user's MFA factors.

```bash
curl 'http://localhost:8000/my-app/auth/v1/admin/users/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/factors' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY"
```

```json
[
  {
    "id": "0f6b2c1e-7d3a-4b9f-8e21-6c5d4a3b2e10",
    "friendly_name": "Phone app",
    "factor_type": "totp",
    "status": "verified",
    "created_at": "2026-10-03T09:20:01.512Z",
    "updated_at": "2026-10-03T09:20:31.004Z",
    "last_challenged_at": "2026-10-03T09:20:30.871Z"
  }
]
```

Phone factors also have `phone`.

### <code class="method put">PUT</code> /auth/v1/admin/users/:id/factors/:factor_id

**Service role.** Renames a factor.

| Name | Type | Description |
|---|---|---|
| `friendly_name` | string | The new name |

```bash
curl -X PUT 'http://localhost:8000/my-app/auth/v1/admin/users/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/factors/0f6b2c1e-7d3a-4b9f-8e21-6c5d4a3b2e10' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"friendly_name":"Work phone"}'
```

Returns the factor. An unknown factor fails with `mfa_factor_not_found` (404).

### <code class="method delete">DELETE</code> /auth/v1/admin/users/:id/factors/:factor_id

**Service role.** Removes a factor, for example when a user lost their device. If it was their last verified factor, their sessions drop to `aal1`.

```bash
curl -X DELETE 'http://localhost:8000/my-app/auth/v1/admin/users/8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b/factors/0f6b2c1e-7d3a-4b9f-8e21-6c5d4a3b2e10' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY"
```

Returns the removed factor.

## Service

### <code class="method get">GET</code> /auth/v1/settings

Which sign-in methods are on. Needs the anon key, like supabase-js sends.

```bash
curl 'http://localhost:8000/my-app/auth/v1/settings' \
  -H "apikey: YOUR_ANON_KEY"
```

```json
{
  "external": { "anonymous_users": false, "email": true, "phone": true, "github": true, "google": false, "discord": false, "gitlab": false, "azure": false, "custom:authentik": true },
  "disable_signup": false,
  "mailer_autoconfirm": false,
  "phone_autoconfirm": false,
  "sms_provider": "twilio",
  "saml_enabled": false
}
```

### <code class="method get">GET</code> /auth/v1/health

Checks that `keel-auth` is running. It doesn't say which version.

```bash
curl 'http://localhost:8000/my-app/auth/v1/health' \
  -H "apikey: YOUR_ANON_KEY"
```

```json
{ "status": "ok" }
```

### <code class="method get">GET</code> /auth/v1/.well-known/jwks.json

Returns `{ "keys": [] }`. Keel signs tokens with a shared secret (HS256), so there are no public keys to publish; verify tokens with `GET /auth/v1/user` (see [The current user](#the-current-user)) instead.

## Not supported

These GoTrue endpoints don't exist in Keel and return `404 not_found`:

| Endpoint | Used by |
|---|---|
| `POST /token?grant_type=id_token` | `signInWithIdToken` (returns `unsupported_grant_type`) |
| `GET /reauthenticate` | `reauthenticate` |
| `GET /user/identities/authorize`, `DELETE /user/identities/:id` | `linkIdentity`, `unlinkIdentity` |
| `POST /sso` | `signInWithSSO` |
| `POST /magiclink` | Old clients; use `POST /otp` |
| `/admin/audit`, `/admin/sso/*`, `/admin/oauth/*` | Audit log, SSO and OAuth server administration |
