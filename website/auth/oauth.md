# Social sign-in

Let users sign in with GitHub, Google, Discord, GitLab or Microsoft. You create an OAuth app at the provider, paste its client ID and secret into Studio, and call `signInWithOAuth`. For your own identity provider (Authentik, Keycloak, Authelia, Pocket ID, Zitadel and any other OpenID Connect server), see [OpenID Connect providers](/auth/oidc).

```js
const { error } = await keel.auth.signInWithOAuth({
  provider: 'github', // 'google', 'discord', 'gitlab', 'azure' or 'custom:<id>'
  options: { redirectTo: 'http://localhost:5173/welcome' },
})
```

## Setting up a provider

1. **Copy the callback URL.** In Studio, open **Users**, click the gear icon (**Sign-in settings**) and scroll to **Sign in with other providers**. Copy the callback URL. Every provider uses the same one:

   ```text
   http://localhost:8000/my-app/auth/v1/callback
   ```

2. **Create an OAuth app** at the provider with that callback URL (details for each provider below).
3. **Paste the credentials.** Back in Studio, switch the provider on, fill in **Client ID** and **Client secret**, and click **Save settings**. Keel encrypts the secret before storing it and never shows it again; leave the field empty later to keep it. If you change the GitLab or tenant URL, enter the secret again.
4. **Set the Site URL** (and any other redirect URLs your app uses) in the **URLs** section, so Keel knows where to send users back. See [Site URL and redirect URLs](/auth/overview#site-url-and-redirect-urls).

The callback URL is built from `KEEL_PUBLIC_URL`, and your users' browsers are sent to it after they approve. It has to be an address their browsers can reach, so set `KEEL_PUBLIC_URL` before you register it (see [Configuration](/self-hosting/configuration)).

### GitHub

Go to [Settings > Developer settings > OAuth Apps](https://github.com/settings/developers) and click **New OAuth App**. Use your app's address as the Homepage URL and the callback URL as the **Authorization callback URL**. GitHub accepts plain `http://` callback URLs.

### Google

In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), choose **Create credentials > OAuth client ID** with the application type **Web application**, and add the callback URL under **Authorized redirect URIs**. Google asks you to set up the OAuth consent screen first if you haven't.

::: warning Google needs HTTPS
Google only accepts redirect URIs that use HTTPS and a domain name, with `localhost` as the exception. To use Google sign-in from other devices, put Keel behind HTTPS first: see [Internet access and HTTPS](/self-hosting/remote-access).
:::

### Discord

In the [Discord Developer Portal](https://discord.com/developers/applications), create an application, open **OAuth2**, add the callback URL under **Redirects**, and copy the **Client ID** and **Client Secret** (reset it once to see it).

### GitLab

On gitlab.com or your own GitLab, open **User settings > Applications** (or a group's or the instance's **Applications** page), add an application with the callback URL as **Redirect URI**, keep **Confidential** checked and select the scopes `openid`, `email` and `profile`. Copy the **Application ID** (Client ID) and **Secret**.

For your own GitLab, enter its address under **GitLab URL**, for example `https://gitlab.example.com`. If it runs on your network without HTTPS, also switch on **Allow plain http on your own network** (see [Plain http on your own network](/auth/oidc#plain-http-on-your-own-network)). GitLab sign-in uses OpenID Connect, so Keel checks GitLab's signed ID token.

### Microsoft (Azure / Entra ID)

In the [Microsoft Entra admin center](https://entra.microsoft.com), open **App registrations > New registration**. Choose who can sign in, and add the callback URL as a **Web** redirect URI. Under **Certificates & secrets**, create a client secret and copy its **Value**. The **Application (client) ID** is on the overview page.

Leave **Tenant URL** empty to accept any Microsoft account (`https://login.microsoftonline.com/common`), or set it to `https://login.microsoftonline.com/<tenant id>` for your organization only. Keel checks Microsoft's signed ID token, including that it comes from the tenant it names.

Microsoft doesn't check that the `email` claim belongs to the user. Keel treats a Microsoft address as verified only when the token also says the email domain's owner is verified (the optional claim `xms_edov`; add it under **Token configuration > Add optional claim > ID**). Without it, a Microsoft sign-in never takes over an existing account with the same address. With an empty Tenant URL anyone can create a Microsoft tenant and sign in, so set your tenant when only your organization should get in.

## Signing in

`signInWithOAuth` sends the browser to the provider. After the user approves, the provider sends them to Keel's callback, and Keel redirects to `redirectTo` with the session in the URL. supabase-js picks it up when the page loads and fires `SIGNED_IN`.

| Option | What it does |
|---|---|
| `redirectTo` | Where to land after sign-in. Must be on the Site URL's origin or in the allow list, otherwise the Site URL is used. |
| `scopes` | Extra provider scopes, separated by spaces, for example `'repo'`. They're added to the defaults below. |
| `skipBrowserRedirect` | Return the URL in `data.url` instead of navigating, for apps that open it themselves. |
| `queryParams` | Not passed on to the provider by Keel. |

| Provider | `provider` | Default scopes |
|---|---|---|
| GitHub | `github` | `read:user user:email` |
| Google | `google` | `openid email profile`, with offline access so Google returns a refresh token |
| Discord | `discord` | `identify email` |
| GitLab | `gitlab` | `openid email profile` |
| Microsoft | `azure` | `openid email profile` |
| Your own | `custom:<id>` | `openid` plus what you set (by default `email profile`) |

The whole round trip must finish within 10 minutes, in the same browser: Keel sets a short-lived cookie (`keel-oauth-` plus the project name) when the sign-in starts and checks it when the provider sends the user back, and each return URL works once. That stops someone from finishing their own sign-in in another person's browser. If the user cancels or something fails, Keel redirects to `redirectTo` with `error`, `error_code` and `error_description` in the URL fragment, and supabase-js returns the error. A missing cookie or a reused return URL shows a Keel error page instead.

With GitLab, Microsoft and OpenID Connect providers, Keel also uses PKCE and a nonce with the provider, and checks the provider's signed ID token. See [How Keel checks the provider](/auth/oidc#how-keel-checks-the-provider).

### The provider's own tokens

The session returned right after sign-in includes `provider_token` (and `provider_refresh_token` when the provider sends one, as Google does on first consent): the provider's access token, which you can use to call the provider's API for that user. Keel doesn't store them for later, and refreshed sessions don't include them, so save them yourself if you need them.

```js
const { data: { session } } = await keel.auth.getSession()
const res = await fetch('https://api.github.com/user/repos', {
  headers: { Authorization: `Bearer ${session.provider_token}` },
})
```

## PKCE flow

With `flowType: 'pkce'`, Keel redirects with a one-time `?code=` instead of tokens in the URL fragment, which suits server-rendered apps:

```js
const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY', {
  auth: { flowType: 'pkce' },
})

await keel.auth.signInWithOAuth({
  provider: 'google',
  options: { redirectTo: 'http://localhost:5173/auth/callback' },
})
```

In the browser, supabase-js exchanges the code by itself. In a server route, call `exchangeCodeForSession(code)`. The code works once, within 10 minutes, and only in the browser that started the sign-in.

## Accounts and identities

The first time someone signs in with a provider, Keel creates a user:

- **Email:** the address the provider gives: GitHub's primary verified address (or the public one), the Google, Discord, GitLab or Microsoft account's address, or the `email` claim of an OpenID Connect provider.
- **`user_metadata`:** the provider's profile, including `full_name`, `name`, `avatar_url`, `email` and `email_verified`. GitHub, Discord and OpenID Connect providers add `user_name` and `preferred_username` when they have one; Google and OpenID Connect providers add `picture`.
- **`app_metadata`:** `provider` and `providers`, for example `{ "provider": "github", "providers": ["github"] }` or `{ "provider": "custom:authentik", ... }`.
- **Identity:** one row in `auth.identities` with the provider's user id (`sub` for OpenID Connect providers) as `provider_id`.

When the provider reports a **verified** email that already belongs to a Keel user, the sign-in goes to that existing account, and the provider is added to its `app_metadata.providers`. Verified means: GitHub's verified addresses, Google's and OpenID Connect providers' `email_verified: true`, Discord's `verified` flag, and for Microsoft the `xms_edov` claim (see above).

A new account gets the provider's address only when the provider verified it, or when **Confirm email addresses** is off (then anyone could sign up with that address and a password anyway). Otherwise the account starts without an email, so an address nobody proved never reaches the `email` claim of a session; the address is still in the identity and `user_metadata`.

If nobody had proven that the address belongs to the account's owner, whoever created the account may have been someone else who registered the address first. Proof means using a link or code emailed to the address, signing in with a provider that verified it, or an admin creating the user with `email_confirm` (or setting it later). Accounts confirmed automatically (with **Confirm email addresses** off, the default without a mail server) or never confirmed have no proof. For those, before linking, Keel removes the password, the phone number, identities of other providers, pending email or phone changes and every session, and logs a warning in `keel-auth`. The same happens the first time someone signs in to such an account with a magic link, recovery link or invite. MFA factors stay. To keep using a password afterwards, the user sets a new one with `updateUser` or a password reset.

If the email matches an existing account but the provider doesn't report it as verified, sign-in fails with "An account with this email already exists. Sign in with your password first." Keel doesn't support linking identities to an existing account (`linkIdentity`), so the user has to keep using their original sign-in method.

With **Allow new sign-ups** off, existing users can still sign in with a provider, but new people are turned away with `signup_disabled`.

## Mobile apps

Use a deep link as `redirectTo`, for example `myapp://auth-callback`, and add it to **Other allowed redirect URLs**. Native "Sign in with Google" or "Sign in with Apple" buttons that use `signInWithIdToken` aren't supported, so mobile apps go through the browser flow above.

## Not supported

- Apple, Slack, Twitter/X and other built-in providers not listed above. Asking for one fails with "Unsupported provider: Provider is not enabled", as does a provider you haven't switched on. Apple sends users back with a form POST and needs a client secret you re-sign every six months, so it isn't offered yet. Providers that speak OpenID Connect can be added as [OpenID Connect providers](/auth/oidc).
- `signInWithIdToken`, `linkIdentity` and `unlinkIdentity`.
- SAML single sign-on (`signInWithSSO`).
