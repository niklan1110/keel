# Cloudflare Tunnel

A Cloudflare Tunnel puts Keel on the internet at your own domain, for example `https://api.example.com`, without opening any port on your router and without revealing your home's IP address. Keel runs the tunnel itself: you create it in Cloudflare, paste one line into Studio, and pick the address. No terminal needed.

What you end up with:

- **Your API** (and these docs) at `https://api.example.com`, for apps anywhere.
- **Studio** stays on your home network. You can also [put it online](#put-studio-online) behind a Cloudflare login and Keel's two-factor sign-in.
- **Nothing else.** The tunnel can only reach Keel's API and Studio: not Postgres, not your other apps, not the rest of your network.

## Before you start

1. **Keel installed and up to date.** Open Studio, click **Connect**, then **Internet access**. If the Cloudflare Tunnel section says the tunnel service isn't included yet, [update Keel](/self-hosting/updating) first.
2. **A free Cloudflare account**: sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
3. **A domain on Cloudflare.** Either:
   - **Buy one in Cloudflare**: in the dashboard, open **Domain Registration > Register Domains**, search for a name and buy it (Cloudflare charges what the registry charges, often around $10 a year). It's set up for you.
   - **Or use a domain you already own**: click **Add a domain**, enter it, pick the **Free** plan, and change the nameservers at your current registrar to the two that Cloudflare shows. Wait until Cloudflare marks the domain **Active** (usually minutes, sometimes a few hours).

The examples use `example.com`; use your own domain everywhere.

## 1. Create the tunnel in Cloudflare

1. In the Cloudflare dashboard, open **Zero Trust** in the left sidebar.
   The first time, Cloudflare asks for a team name (anything) and a plan: choose **Free**. It may ask for a payment method even for the free plan; it isn't charged.
2. Go to **Networks > Tunnels** and click **Create a tunnel**.
3. Choose **Cloudflared** and click **Next**.
4. Name it `keel` and click **Save tunnel**.
5. Under **Choose your environment**, click **Docker**. Cloudflare shows a command like:

   ```text
   docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJhIjoiNmE...
   ```

   Copy the whole command. Don't run it.

Leave the Cloudflare page open.

## 2. Start it in Studio

1. In Studio, click **Connect** (top right), then **Internet access**.
2. Under **Cloudflare Tunnel**, paste the command into the box and click **Start tunnel**. Keel keeps only the token from it, on your server.
3. After a few seconds the badge next to the heading turns **Connected**, and in Cloudflare the tunnel shows **Healthy**. Click **Next** there.

::: warning Keep the token secret
Anyone with the token can connect a server to your tunnel. If it leaks, open the tunnel in Cloudflare, use **Refresh token**, and paste the new command into Studio.
:::

## 3. Publish the API in Cloudflare

On the tunnel's **Public Hostname** tab (called **Published application routes** in newer dashboards), click **Add a public hostname** and fill in:

| Field | Value |
|---|---|
| Subdomain | `api` |
| Domain | `example.com` |
| Path | leave empty |
| Service type | `HTTP` |
| URL | `keel-gateway:8000` |

Click **Save**. Cloudflare creates the DNS record for `api.example.com` by itself. (Studio shows the URL with a copy button.)

## 4. Use the address in Studio

Back in Studio's **Internet access**, enter `api.example.com` under step 5 and click **Use it**. Keel:

- makes `https://api.example.com` its public address, used in email links, OAuth callbacks, the **Connect** panel and the AI agent prompt, everywhere at once and without a restart;
- checks that the address reaches your Keel and shows the result.

You can also change the address any time under **Public address** (and go back to the one from your server's settings).

Then, once you have apps:

1. Use `https://api.example.com/<project>` as their Keel address. Their anon key stays the same.
2. Set each project's **Site URL** and redirect URLs under **Users > Sign-in settings** to your app's address.
3. If you use sign-in with GitHub, Google or another provider, copy the new callback URL from that page into those OAuth apps and clients.

Devices on your home network can keep using `http://<server-ip>:8000`. Postgres connection strings in Studio keep your server's home-network address, since the tunnel doesn't carry database connections.

## Put Studio online

Studio isn't routed through the tunnel, so by default it's only reachable on your home network (and over Tailscale or a VPN if you use one). That's the safest choice. If you need it from outside, it gets two locks: a Cloudflare login in front, and Keel's two-factor sign-in behind it.

1. **Turn on two-factor first.** From your home network, open Studio, then **Account and security > Set up two-factor**. Keel refuses sign-ins from the internet for accounts without it (see [Accounts and sign-in](/studio/accounts#sign-ins-from-the-internet)).
2. **Create the Cloudflare login before the route**, so Studio is never online unprotected:
   1. In Zero Trust, open **Access > Applications** and click **Add an application**, then **Self-hosted**.
   2. **Application name**: `Keel Studio`. **Session duration**: `24 hours`.
   3. Under **Public hostname** (or **Application domain**), enter subdomain `studio` and domain `example.com`.
   4. Add a policy: name `Me`, action **Allow**, and under **Include** choose **Emails** and enter your email address (add others who need Studio).
   5. Keep the default login method, **One-time PIN**, and save.
3. **Add the route**: back in **Networks > Tunnels > keel > Public Hostname**, add subdomain `studio`, domain `example.com`, type `HTTP`, URL `keel-studio:3000`.
4. **Test it**: open `https://studio.example.com`. Cloudflare asks for your email and sends a code; then Studio asks for your password and your two-factor code.

## What the tunnel can reach

The tunnel runs in Keel's `keel-tunnel` container, which joins only the `keel-public` Docker network. Keel puts just two services on it: `keel-gateway` (the API, port 8000) and `keel-studio` (port 3000). So even a mistyped route in Cloudflare can't reach Postgres, Keel's other services, your other apps or your home network. The container runs read-only, without Linux capabilities, and holds no Keel passwords.

Some things to know:

- **Cloudflare sees your traffic.** HTTPS ends at Cloudflare, which forwards requests to Keel through the tunnel. That's how every Cloudflare proxy works; if that's not acceptable, use [Tailscale](/self-hosting/remote-access#tailscale-private) instead.
- **Limits on the free plan**: one upload request can be at most 100 MB (use [resumable uploads](/storage/resumable-uploads) for bigger files), and a request that takes longer than about 100 seconds is cut off.
- **Real addresses**: Keel trusts the tunnel container and reads each visitor's address from the `CF-Connecting-IP` header Cloudflare sets, so rate limits and Studio's internet sign-in rule apply per visitor. Nothing to configure. Anything that came through Cloudflare counts as the internet, even if the visitor's address was removed on the way. Leave Cloudflare's **Remove visitor IP headers** setting (under **Rules > Settings**) off: with it on, every visitor shares the tunnel's address and one set of limits, so one person could block sign-ins for everyone.
- **Studio's host check** doesn't apply to requests through the tunnel, so Studio works under whatever hostname you route to it.
- **No open ports needed**: the tunnel reaches Keel over Docker's network, not through the ports on your server. Studio and Postgres can stay on the server itself (`KEEL_STUDIO_BIND=127.0.0.1` and `KEEL_DB_BIND=127.0.0.1`, the defaults except for Studio on a NAS), off your home network entirely.
- **Where the token lives**: in the `tunnel` folder next to Keel's data (`/DATA/AppData/keel/tunnel` on ZimaOS), readable only by Keel's user. It's not in the database or in backups.

## Turn it off

- **Take one hostname offline**: delete it from the tunnel's **Public Hostname** tab in Cloudflare.
- **Stop the tunnel**: Studio > **Connect > Internet access > Turn off the tunnel**. Keel keeps running on your home network.
- **Remove it completely**: also delete the tunnel in Cloudflare (**Networks > Tunnels**), and under **Public address** click **Use the server setting**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Studio says the tunnel service isn't included | Your install predates it. [Update Keel](/self-hosting/updating), then open **Internet access** again. |
| "That doesn't look like a Cloudflare tunnel token" | Copy the whole command from the tunnel's **Docker** tab; it ends with `--token eyJ…`. |
| Badge says **Not connected**, with `Unauthorized` or `not valid` | The token is wrong or was refreshed. Turn the tunnel off and paste the current command. Open **Tunnel log** in Studio for details. |
| Cloudflare error **1033** | The tunnel isn't connected. Check the badge and the tunnel log in Studio. |
| **502 Bad Gateway** | Check the route's URL in Cloudflare: `keel-gateway:8000`, type `HTTP` (not HTTPS). |
| **Check** says it couldn't reach the address | The public hostname isn't saved in Cloudflare yet, or the DNS record is still new (wait a minute). |
| Studio: "Sign-ins from the internet need two-factor authentication" | Expected. Turn on two-factor from your home network first. |
| Big uploads fail at 100 MB | Cloudflare's limit; use resumable uploads. |
| Realtime never connects | In the Cloudflare dashboard for your domain, check **Network > WebSockets** is on (it is by default). |

## Run the tunnel yourself (advanced)

If you'd rather manage `cloudflared` as its own container, Keel's website has a compose file for it, [`cloudflare-tunnel.yml`](@@SITE@@/cloudflare-tunnel.yml). It joins the same `keel-public` network and reads the token from `TUNNEL_TOKEN` in a `.env` next to it:

```bash
mkdir -p ~/keel-tunnel && cd ~/keel-tunnel
curl -fsSL @@SITE@@/cloudflare-tunnel.yml -o docker-compose.yml
(umask 077; printf 'TUNNEL_TOKEN=%s\n' 'PASTE-YOUR-TOKEN-HERE' > .env)
docker compose up -d
```

For a second Keel on the same machine, whose `.env` sets `KEEL_PUBLIC_NETWORK`, replace `keel-public` in the file with that name; otherwise the tunnel joins the first Keel's network.

Then publish the API as in step 3, and set the public address in Studio as in step 4. Don't run both: use either Studio's tunnel or this one. The compose file gives the container the name `keel-tunnel` on Keel's network, which is how Keel knows to trust the visitor addresses it passes on; keep that if you write your own.
