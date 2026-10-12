# OpenID Connect providers

Let users sign in with your own identity provider: Authentik, Keycloak, Authelia, Pocket ID, Zitadel, or any other server that speaks OpenID Connect. You can add several per project. Each gets an identifier that starts with `custom:`, as in Supabase, and apps sign in with it:

```js
const { error } = await keel.auth.signInWithOAuth({
  provider: 'custom:authentik',
  options: { redirectTo: 'http://localhost:5173/welcome' },
})
```

## Adding a provider

1. **Copy the callback URL.** In Studio, open **Users**, click the gear icon (**Sign-in settings**) and find **Sign in with other providers**. The callback URL looks like `http://localhost:8000/my-app/auth/v1/callback`.
2. **Create a client** in your identity provider: a confidential client (one with a secret) for the authorization code flow, with the callback URL as its redirect URI and the scopes `openid email profile`. See the sections below for each provider.
3. **Add it in Studio.** Under **OpenID Connect providers**, click **Add** and fill in:

   | Field | What to enter |
   |---|---|
   | Identifier | `custom:` and lowercase letters, digits or hyphens, at most 50 characters, for example `custom:authentik`. Apps use it as `provider`. It can't be changed once saved. |
   | Display name | Shown in Studio, for example `Authentik`. Optional. |
   | Issuer URL | The provider's issuer. Keel reads `<issuer>/.well-known/openid-configuration` to find everything else. |
   | Scopes | Space separated, `email profile` by default. `openid` is always added. |
   | Client ID, Client secret | From the client you created. The secret is encrypted before it's stored and never shown again; leave the field empty later to keep it. If you change the Issuer URL, enter the secret again. |
   | Icon URL | Optional, `https://` only. For your own sign-in buttons. |
   | Allow plain http on your own network | Off by default. See below. |

4. Click **Save settings**, and set the **Site URL** if you haven't.

Removing a provider in Studio stops new sign-ins with it at once. Users who signed in with it keep their accounts and can still use other ways in, such as a password or a magic link.

`GET /auth/v1/settings` lists each switched-on provider under `external`, for example `"custom:authentik": true`, so an app can decide which buttons to show.

## How Keel checks the provider

Keel uses the authorization code flow with PKCE (`S256`), a `state` tied to the browser that started the sign-in, and a `nonce`. When the provider sends the user back, Keel exchanges the code (with the client secret in an HTTP Basic header, or in the request body if the provider only supports that) and checks the ID token before it trusts anything in it:

- **Signature:** with the provider's published keys (`jwks_uri`), cached for an hour and fetched again when a token names a key Keel hasn't seen, so key rotation just works. Only RS, PS, ES and EdDSA signatures are accepted; `none` and HMAC (`HS256` and the like) are refused.
- **Issuer and audience:** `iss` must be the issuer from the discovery document (which must itself match the Issuer URL you entered, give or take a trailing slash), and `aud` must contain your client ID (with `azp` equal to it when there are several audiences).
- **Time:** `exp`, `iat` and `nbf`, allowing one minute of clock difference.
- **Nonce**, and **`at_hash`** when the token has one.

If the provider has a user info endpoint, Keel also asks it for claims missing from the ID token (Authelia, for one, keeps email and profile there), for the same `sub` only. The ID token always wins.

The user is identified by `sub`. Their email is used to find an existing account only when the provider says `email_verified: true`; see [Accounts and identities](/auth/oauth#accounts-and-identities). Check what your provider sends: if it leaves `email_verified` out, or sends `false`, someone signing in with an address that already has an account gets "An account with this email already exists" instead of being linked.

::: warning Every provider you add is trusted with your users' addresses
A provider that says an address is verified signs that person in to the Keel account with that address, whoever created it. Only add providers whose administrators you trust, and that send `email_verified: true` only for addresses they checked. That includes a self-hosted GitLab: its administrators can mark any address as confirmed.
:::

## Plain http on your own network

Keel talks to providers over HTTPS only, with an 8 second timeout, a 256 KB limit on each response, and redirects followed only within the same server. Homelab identity providers often run on the LAN without HTTPS, so for each provider you can switch on **Allow plain http on your own network**. Then:

- The Issuer URL, and the endpoints in the discovery document, may use `http://`.
- Keel itself only connects over http to addresses on your own network: private IPv4 and IPv6 ranges, Tailscale (`100.64.0.0/10`), `localhost`, single-label names (`authentik`, a container name) and LAN-only domains (`.lan`, `.local`, `.internal`, `.home.arpa`). An http URL that resolves to an internet address is refused, and so is a link-local one (`169.254.0.0/16`, `fe80::/10`), where cloud servers keep their instance metadata.

Only switch this on when the provider really can't use HTTPS. Over plain http, anyone on your network who can watch traffic sees the client secret and users' tokens on the way to the provider. If your provider uses HTTPS with a certificate from your own certificate authority, keep this off and make `keel-auth` trust your CA instead: mount the CA certificate into the container and point `NODE_EXTRA_CA_CERTS` at it.

The browser is sent to the provider's authorization endpoint directly, so it has to be an address your users' browsers can reach. `keel-auth` reaches the token, key and user info endpoints from inside Docker; a name like `authentik.lan` must resolve there too.

## Authentik

1. In the admin interface, open **Applications > Providers > Create**, choose **OAuth2/OpenID Provider**, and give it an authorization flow.
2. **Client type:** Confidential. **Redirect URIs:** the callback URL (strict). Keep the default scopes (`openid`, `email`, `profile`).
3. Create an **Application** that uses this provider. Its slug is part of the issuer.
4. In Keel: Issuer URL `https://authentik.example.com/application/o/<application slug>/` (with the trailing slash, as Authentik shows it under **OpenID Configuration Issuer**), and the provider's Client ID and Client Secret.

Authentik's `email` scope decides what it sends as `email_verified`. If you want people to land in their existing Keel accounts by email, make sure it sends `true` only for addresses you trust.

## Keycloak

1. In your realm, open **Clients > Create client**, type **OpenID Connect**, with a client ID such as `keel`.
2. Turn **Client authentication** on, and keep **Standard flow** checked.
3. Add the callback URL to **Valid redirect URIs**.
4. Optional: under **Advanced > Advanced settings**, set **Proof Key for Code Exchange Code Challenge Method** to `S256` so Keycloak requires PKCE.
5. Copy the secret from the **Credentials** tab.
6. In Keel: Issuer URL `https://keycloak.example.com/realms/<realm>` (Keycloak before version 17 adds `/auth`: `.../auth/realms/<realm>`).

Keycloak sends `email_verified` from the user's **Email verified** setting.

## Authelia

Add a client to Authelia's configuration and restart it:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: 'keel'
        client_name: 'Keel'
        client_secret: '$pbkdf2-sha512$...'   # a hash: authelia crypto hash generate pbkdf2
        public: false
        authorization_policy: 'two_factor'
        require_pkce: true
        pkce_challenge_method: 'S256'
        redirect_uris:
          - 'https://keel.example.com/my-app/auth/v1/callback'
        scopes: ['openid', 'email', 'profile']
        token_endpoint_auth_method: 'client_secret_basic'
```

In Keel: Issuer URL is Authelia's address, for example `https://auth.example.com`, and the client secret is the plain value you hashed. Authelia returns email and profile from its user info endpoint, which Keel reads.

## Pocket ID

1. In Pocket ID, open **OIDC Clients > Add OIDC Client**.
2. Add the callback URL as **Callback URL**, and save. Copy the **Client ID** and **Client secret**.
3. In Keel: Issuer URL is Pocket ID's address, for example `https://id.example.com`.

## Zitadel

1. In your project, add a **New application** of type **Web**, with the authentication method **Code**.
2. Add the callback URL as a **Redirect URI**. Zitadel only accepts `http://` redirect URIs with **Development Mode** on.
3. Copy the **Client ID** and **Client Secret**.
4. In Keel: Issuer URL is your instance's address, for example `https://auth.example.com`.

## Other providers

Any provider with OpenID Connect discovery works the same way: create a confidential client for the authorization code flow, register the callback URL, and enter its issuer. Providers that only speak plain OAuth 2 (no ID token, no discovery) can't be added this way.
