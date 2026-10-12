# Accounts and sign-in

Studio has its own accounts, separate from the users of your apps. Every Studio account is a full admin of every project on the server. This page covers the owner account, adding people, two-factor authentication, sessions, sign-ins from the internet, and how to get back in if you're locked out.

Open it all from the project switcher: **Account and security** (also in the ⌘K palette).

## The owner account

The first account comes from your `.env` file: `KEEL_DASHBOARD_USERNAME` (`admin` unless you changed it) and `KEEL_DASHBOARD_PASSWORD`. Studio creates it on its first start and marks it as the **owner**.

- **Change its password in Studio** under **Account and security > Password**. The new password stays until you change it again.
- **Or change it in `.env`.** Whenever `KEEL_DASHBOARD_PASSWORD` in `.env` changes, Studio sets the owner's password to the new value on its next start and signs the owner out everywhere. This is your way back in if you forget the password:

  ```bash
  # In the install folder (add sudo if you installed with it)
  sed -i 's/^KEEL_DASHBOARD_PASSWORD=.*/KEEL_DASHBOARD_PASSWORD=<your-new-password>/' .env
  ./keel up
  ```

  Put your own password in place of `<your-new-password>` (at least 8 characters). Studio refuses to start with the placeholder, or with a password that appeared in these docs as an example.

  On a ZimaOS App Store install, change `KEEL_DASHBOARD_PASSWORD` in the compose file's `x-keel-env` block and run `docker compose up -d keel-studio` in its folder.

Other accounts can't remove the owner or change its password. Changing `KEEL_DASHBOARD_USERNAME` renames the owner.

## Adding people

Under **Studio accounts**, click **Add account**, choose a username and a starting password, and share it with them privately. They can change it and turn on two-factor authentication under **Account and security**.

Each account can:

- set a **new password** for another account (that person is signed out),
- **reset two-factor** for someone who lost their phone (they're signed out, and can set it up again after signing in with their password),
- **remove** an account (it's signed out at once).

Because every account has full control over every project, only add people you'd give your server's root password to. Usernames are case-insensitive; passwords need at least 8 characters.

## Two-factor authentication

Two-factor authentication adds a 6-digit code from an authenticator app (Google Authenticator, Apple Passwords, 1Password, Authy, Bitwarden, …) to your password.

1. Open **Account and security** and click **Set up two-factor**.
2. Scan the QR code with your app, or type the key shown under it.
3. Enter the code the app shows and click **Turn on**.

From then on, Studio asks for a code after your password. Each code works once. To turn it off, enter your password under **Two-factor authentication > Turn off two-factor**.

Keep a way back in: another Studio account that can reset yours, or access to the server's command line (see [Locked out](#locked-out)).

## Sessions

A sign-in lasts 12 hours. **Where you're signed in** lists your sessions with their device, address, and whether they came from your network or the internet. Sign out one of them, or click **Sign out everywhere else**.

Sessions live on the server: signing out ends the session for real, and changing your password ends all your other sessions. The browser keeps the session in a cookie that page scripts can't read (`HttpOnly`, `SameSite=Strict`, and `Secure` over HTTPS), and Studio only accepts API calls made by its own pages. After upgrading from a version that kept the session in the browser's local storage, sign in once more.

## Sign-ins from the internet

If you publish Studio on the internet (see [Internet access and HTTPS](/self-hosting/remote-access#studio-on-the-internet)), `KEEL_STUDIO_INTERNET_LOGIN` in `.env` decides what happens:

| Value | Sign-ins from the internet |
|---|---|
| `2fa` (default) | Allowed only for accounts with two-factor authentication. Others see "Sign-ins from the internet need two-factor authentication". |
| `off` | Refused. Studio only accepts sign-ins from your network. |
| `on` | Allowed with only a password. Not recommended. |

Sign-ins from your network (the server itself, your LAN and Tailscale) always work with the password, plus the code if you've turned on two-factor. **Account and security** shows which one you're connected from.

"Your network" is `KEEL_LOCAL_NETWORKS`: private addresses, Tailscale's `100.64.0.0/10` and the server itself by default. Behind a proxy or tunnel, Keel reads the visitor's real address from the headers the proxy adds, but only from proxies it trusts: its own Cloudflare Tunnel always, a proxy on the server when the port is bound to `127.0.0.1`, and those in `KEEL_TRUSTED_PROXIES`. A request any other proxy passed on counts as the internet. See [Visitor addresses and proxies](/self-hosting/remote-access#visitor-addresses-and-proxies). A TCP port forwarder doesn't pass the address on, so every visitor would look local: don't put Studio behind one.

From your network, Studio only answers to IP addresses, `localhost`, local names (`nas`, `nas.local`, `*.lan`, `*.ts.net`) and the public address, which keeps other websites from signing in through your browser (DNS rebinding). To open it under another name, add that name to `KEEL_STUDIO_HOSTS` in `.env`.

## Attempt limits

| Limit | Applies to |
|---|---|
| 10 failed sign-ins per 15 minutes | Each address |
| 20 failed sign-ins per hour | Each account, counting only attempts from the internet |
| 100 failed sign-ins per hour | Each account, from anywhere |

A successful sign-in resets the count for its address. The per-account limit ignores your own network, so someone on the internet can't lock you out at home.

## Locked out

**Forgot the owner password?** Change `KEEL_DASHBOARD_PASSWORD` in `.env` and restart Studio, as shown under [The owner account](#the-owner-account).

**Lost your phone, or need to fix any account?** Use `studio-user` on the server:

```bash
# In the install folder (add sudo if you installed with it)
./keel studio-user list
./keel studio-user reset-2fa admin
./keel studio-user reset-password alex          # prints a new password
./keel studio-user add alex --password 'a-long-password'
./keel studio-user remove alex

# ZimaOS App Store install (no keel script), in the compose file's folder
docker compose run --rm --no-deps -T keel-migrate studio-user reset-2fa admin
```

Resetting a password or two-factor ends that account's sessions. See the [keel CLI](/self-hosting/cli#studio-user) for all options.

**"Too many sign-in attempts"?** Wait 15 minutes, or sign in from another device on your network.
