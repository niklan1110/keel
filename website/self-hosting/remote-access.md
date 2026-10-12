# Internet access and HTTPS

Keel serves plain HTTP on your home network. This page shows how to reach it from anywhere: privately over Tailscale, or publicly on the internet so that anyone can use the apps you build.

## What to put online

| Part | Port | Put it on the internet? |
|---|---|---|
| **API** (your apps talk to it) | 8000 | Yes, if people outside your home use your apps. The [documentation](/guide/introduction) comes with it at `/docs`. |
| **Studio** (your admin dashboard) | 3000 | Best kept private: reach it over Tailscale. If you publish it, use two-factor authentication (Keel insists on it by default) and ideally an extra login such as Cloudflare Access. |
| **Postgres** | 5432 | Never. It listens on the server only by default. See [Keep Postgres private](#keep-postgres-private). |

The API is built to face the internet: every request needs your project's key, and your [row level security](/database/row-level-security) policies decide what each user can do. Studio is different: it can run any SQL on every project, so treat its login like a root password.

## Pick an option

| Option | Who can reach it | You need |
|---|---|---|
| [Cloudflare Tunnel](#cloudflare-tunnel) | Anyone, at your own domain (`https://api.example.com`) | A domain on Cloudflare (free plan). No open ports. |
| [Tailscale Funnel](#tailscale-funnel) | Anyone, at `https://<server>.<tailnet>.ts.net` | Tailscale. No domain, no open ports. |
| [Tailscale](#tailscale-private) | Only your own devices | Tailscale on the server and on each device |
| [Caddy](#caddy) | Anyone, at your own domain | A domain, and ports 80 and 443 forwarded to the server |
| [nginx](#nginx) | Anyone, at your own domain | A domain, open ports and your own certificates |
| [Traefik](#traefik) | Anyone, at your own domain | A domain, ports 80 and 443 forwarded, Traefik in Docker |

For a home server, **Cloudflare Tunnel** (if you have or buy a domain) or **Tailscale Funnel** (if you don't) are the safest public options: your router stays closed and your home IP address stays hidden. Keep Studio on [Tailscale](#tailscale-private) either way.

## After any of these

1. **Set the public address** to the new HTTPS address of the API, for example `https://api.example.com`: in Studio, **Connect > Internet access > Public address**. It applies right away. (Or set `KEEL_PUBLIC_URL` in your settings and restart Keel; see [Configuration](/self-hosting/configuration#keel-public-url).) Keel uses it in email links, OAuth callbacks, the **Connect** panel and the AI agent prompt.
2. **Update OAuth apps.** The callback URL changes to `<KEEL_PUBLIC_URL>/<project>/auth/v1/callback`. Copy the new one from Studio (**Users > Sign-in settings**) into your OAuth apps and OpenID Connect clients.
3. **Update your apps** to the new API URL, and set each project's **Site URL** and allowed redirect URLs (**Users > Sign-in settings**) to your app's new address.

The gateway allows requests from any origin (CORS `*`), so web apps on other domains work without extra settings.


## Cloudflare Tunnel

A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) is a small program on your server (`cloudflared`) that connects out to Cloudflare. Visitors reach `https://api.example.com` at Cloudflare, which passes the requests through the tunnel to Keel. You open no ports, your home IP address stays hidden, and Cloudflare handles the certificates.

Keel runs the tunnel itself, in a container that can reach Keel's API (and Studio, if you choose) and nothing else on your server or home network. Follow the step-by-step guide: **[Put Keel online with Cloudflare Tunnel](/self-hosting/cloudflare-tunnel)**.

In short:

1. Create a tunnel in Cloudflare (**Zero Trust > Networks > Tunnels**) and copy the Docker command it shows.
2. In Studio, open **Connect > Internet access**, paste it and click **Start tunnel**.
3. In Cloudflare, add a public hostname `api.example.com` with URL `keel-gateway:8000`.
4. Back in Studio, enter `api.example.com` and click **Use it**.

## Tailscale Funnel

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) publishes a port of your server on the internet at its Tailscale name, for example `https://nas.tail1234.ts.net`, with a real certificate. It needs no domain and no open ports. Funnel works on ports 443, 8443 and 10000 only.

1. **Allow Funnel for the server.** In the [Tailscale admin console](https://login.tailscale.com/admin), make sure **MagicDNS** and **HTTPS certificates** are on (under **DNS**). Then open **Access controls** and add the `funnel` attribute for your server, for example:

   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```

2. **Publish the API** on the server:

   ```bash
   sudo tailscale funnel --bg --https=443 http://127.0.0.1:8000
   sudo tailscale funnel status
   ```

   On ZimaOS, Tailscale usually runs in a container, so run the commands inside it: `docker exec tailscale tailscale funnel --bg --https=443 http://127.0.0.1:8000` (use your Tailscale container's name, see `docker ps`).
3. **Tell Keel its new address**: `KEEL_PUBLIC_URL=https://nas.tail1234.ts.net`, then restart Keel (see [After any of these](#after-any-of-these)). Funnel connects from the server itself, so for visitor addresses to count, also set `KEEL_TRUSTED_PROXIES=host` (or bind the port with `KEEL_GATEWAY_BIND=127.0.0.1` if nothing on your LAN uses it directly); see [Visitor addresses and proxies](#visitor-addresses-and-proxies). Funnel marks the requests it brings in from the internet (`Tailscale-Funnel-Request`), and Keel never counts those as your network, even though they come from the server itself. Your apps use `https://nas.tail1234.ts.net/my-app`, and the docs are at `https://nas.tail1234.ts.net/docs`.
4. **Keep Studio private**: publish it with `tailscale serve` (not `funnel`), so only your devices reach it.

To take the API off the internet again: `sudo tailscale funnel --https=443 off`.

## Tailscale (private)

[Tailscale](https://tailscale.com) gives every device on your tailnet a private address and a name like `server.tail1234.ts.net`, and `tailscale serve` adds HTTPS with a real certificate. Nothing is reachable from the internet. Turn on MagicDNS and HTTPS certificates in the Tailscale admin console first.

On the Keel server:

```bash
# API on https://server.tail1234.ts.net
sudo tailscale serve --bg --https=443 http://127.0.0.1:8000
# Studio on https://server.tail1234.ts.net:8443
sudo tailscale serve --bg --https=8443 http://127.0.0.1:3000

sudo tailscale serve status
```

Then set `KEEL_PUBLIC_URL=https://server.tail1234.ts.net` and `KEEL_TRUSTED_PROXIES=host` (so your devices count as your network, by their Tailscale addresses) and restart Keel. Your apps use `https://server.tail1234.ts.net/my-app`. To remove an entry, run `sudo tailscale serve --https=8443 off`.

LAN access keeps working at `http://<server>:8000`, but links that Keel generates now point at the Tailscale address, so the devices that open them need Tailscale.

## Caddy

[Caddy](https://caddyserver.com) gets and renews certificates from Let's Encrypt by itself and handles WebSockets without extra settings. Point two DNS names at your server, forward ports 80 and 443 to it, and use this `Caddyfile`:

```text
api.example.com {
	reverse_proxy localhost:8000
}

studio.example.com {
	reverse_proxy localhost:3000
}
```

Set `KEEL_PUBLIC_URL=https://api.example.com` and `KEEL_GATEWAY_BIND=127.0.0.1` and restart Keel. Binding the gateway to `127.0.0.1` means only Caddy can reach it, and makes Keel trust the visitor addresses Caddy passes on (see [Visitor addresses and proxies](#visitor-addresses-and-proxies)). Leave out the `studio` block to keep Studio on your LAN (recommended, see [Studio on the internet](#studio-on-the-internet)); Caddy on the same machine still reaches Studio when it listens on this machine only (`KEEL_STUDIO_BIND=127.0.0.1`, the default); if you do add a `studio` block, put its domain in `KEEL_STUDIO_HOSTS`.

## nginx

nginx needs a few settings that Caddy applies by default: WebSocket upgrade headers for realtime, a larger upload limit, and the forwarded scheme and host.

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name api.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    # Allow uploads up to Keel's own limit (KEEL_STORAGE_MAX_FILE_SIZE: 500 MB with the
    # installer and on ZimaOS, 50 MB in a source checkout).
    client_max_body_size 500m;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;

        # Realtime uses WebSockets.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Without the `Upgrade` and `Connection` headers, realtime subscriptions never connect. Resumable uploads are handed URLs under `KEEL_PUBLIC_URL`, so set it to the `https://` address or browsers on an HTTPS page refuse them. nginx's default `client_max_body_size` is 1 MB, which would reject most file uploads. For Studio, add a second `server` block for `studio.example.com` that proxies to `http://127.0.0.1:3000` the same way.

As with Caddy, set `KEEL_GATEWAY_BIND=127.0.0.1` (and `KEEL_STUDIO_BIND=127.0.0.1` for Studio) so Keel trusts the visitor addresses nginx passes on.

## Traefik

[Traefik](https://doc.traefik.io/traefik/) is common on Unraid, TrueNAS and homelab servers. It runs in Docker and finds its routes in container labels, so it doesn't need Keel's ports at all: it joins Keel's `keel-public` network, which holds only the gateway and Studio, and talks to them there.

If you don't run Traefik yet, a minimal setup in its own folder (`docker compose up -d` there, after Keel is running, since Keel creates the network):

```yaml
# traefik/docker-compose.yml
services:
  traefik:
    image: traefik:v3
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.tlschallenge=true
      - --certificatesresolvers.letsencrypt.acme.email=admin@example.com
      - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
    networks: [keel-public]

networks:
  keel-public:
    external: true
```

Then give Keel's gateway its route with a `docker-compose.override.yml` next to Keel's `docker-compose.yml` (Compose reads it automatically, and updates leave it alone):

```yaml
# docker-compose.override.yml in Keel's install folder
services:
  keel-gateway:
    labels:
      traefik.enable: "true"
      traefik.docker.network: keel-public
      traefik.http.routers.keel-api.rule: Host(`api.example.com`)
      traefik.http.routers.keel-api.entrypoints: websecure
      traefik.http.routers.keel-api.tls.certresolver: letsencrypt
      traefik.http.services.keel-api.loadbalancer.server.port: "8000"
```

Run `./keel up`, set `KEEL_PUBLIC_URL=https://api.example.com` (or **Connect > Internet access > Public address** in Studio). Traefik passes WebSockets, `X-Forwarded-For` and `X-Forwarded-Proto` by default and doesn't limit upload sizes, so realtime and large uploads work as they are. To publish Studio as well (see the next section first), add the same labels to `keel-studio` with another router name, such as `keel-studio`, its own host name and port `3000`.

If you already run Traefik with another network, add `keel-public` to its `networks` (as an external network) rather than publishing Keel's ports. For a second Keel on the same machine, use the network named by `KEEL_PUBLIC_NETWORK` in its `.env` instead of `keel-public`, in both files. On Windows, where `.env` sets `COMPOSE_FILE`, Compose doesn't read `docker-compose.override.yml` by itself: add `;docker-compose.override.yml` to the end of that line.

## Studio on the internet

If you publish Studio, Keel protects its sign-in like this (details in [Accounts and sign-in](/studio/accounts)):

- **Two-factor authentication is required for sign-ins from the internet** (`KEEL_STUDIO_INTERNET_LOGIN=2fa`, the default). Accounts without it can only sign in from your home network or Tailscale. Set it to `off` to refuse internet sign-ins entirely, or `on` to allow them with only a password (not recommended).
- **Failed sign-ins are limited** to 10 per address per 15 minutes, and to 20 per account per hour for internet addresses, so a stranger can't lock you out at home.
- **Sessions can be ended** from **Account and security**, and every account's sessions end when its password changes.

Keel decides what "the internet" is from the visitor's address (see [Visitor addresses and proxies](#visitor-addresses-and-proxies)). Anything that came through Cloudflare counts as the internet, even if the visitor's address was removed on the way, and so does anything a proxy Keel doesn't trust passed on. Two things follow:

- **Use an HTTP proxy or tunnel, not a TCP one.** A TCP port forwarder (for example a game-server tunnel such as playit.gg, or a raw port relay) makes every visitor look like they're on your network, so the internet rules wouldn't apply. Don't put Studio behind one.
- **Your network** means private addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), Tailscale (`100.64.0.0/10`) and the server itself. Change it with `KEEL_LOCAL_NETWORKS`, for example `KEEL_LOCAL_NETWORKS=192.168.1.0/24` to trust only your LAN. See [Configuration](/self-hosting/configuration).

Studio also checks the name it's opened under. From your network it answers to IP addresses, `localhost`, names that only exist on your network (`nas`, `nas.local`, `*.lan`, `*.home.arpa`, `*.ts.net`) and the public address. That stops a web page from pointing its own name at your server (DNS rebinding) and signing in from a browser on your LAN. If you open Studio under another name on your network, for example a domain your router resolves to the server, add it to `KEEL_STUDIO_HOSTS` in `.env`; until then Studio answers `421` with a message saying so. The same goes for a reverse proxy on the server (Caddy, nginx): if you serve Studio through it under a domain, add that domain to `KEEL_STUDIO_HOSTS`. Only Cloudflare Tunnel is exempt, since it serves just the names you set up in Cloudflare.

## Visitor addresses and proxies

Rate limits and Studio's internet sign-in rule work per visitor. A proxy or tunnel passes the visitor's address in the `X-Forwarded-For` header, but anyone can write that header, so Keel believes it only from proxies it trusts:

- **Keel's own**, always: the gateway, and Cloudflare Tunnel run from Studio (or [your own `cloudflared`](/self-hosting/cloudflare-tunnel#run-the-tunnel-yourself-advanced) from Keel's compose file). Through the tunnel, the visitor's address is Cloudflare's `CF-Connecting-IP`.
- **A proxy on the server itself** (Caddy, nginx, `tailscale serve` or Funnel), when the port it connects to is bound to `127.0.0.1` (`KEEL_GATEWAY_BIND=127.0.0.1`, `KEEL_STUDIO_BIND=127.0.0.1`). That's the recommended setup anyway: then only the proxy can reach the port.
- **Anything in `KEEL_TRUSTED_PROXIES`**: `host` for a proxy on the server with the port still on all interfaces, the name of a proxy container on Keel's networks, or the address of a proxy on another machine, for example `KEEL_TRUSTED_PROXIES=host` or `KEEL_TRUSTED_PROXIES=192.168.1.5`. A name counts only while it points at a container on one of Keel's own Docker networks, so a device on your network that happens to carry the same name is never trusted; give a proxy on another machine by its address.

A request forwarded by anyone else counts as the internet, under the address of whoever connected to Keel. So if your proxy isn't trusted, every visitor shares one set of limits and one sign-in rule (the internet's): add the proxy as above. Keel logs a warning (once an hour) when a device on your network sends `X-Forwarded-For` without being trusted, naming its address. Don't trust a proxy that also lets strangers connect to Keel directly, and don't use `KEEL_TRUSTED_PROXIES=private`, which trusts every device on your network and lets any of them claim to be someone else.

Docker Desktop (Windows and macOS), rootless Docker, and IPv6 connections to a port Docker forwards from IPv4 hide the visitor's address: Keel sees Docker's own address for everyone, which is on your network. On such a setup, publish ports on `127.0.0.1` behind a proxy, or keep them off the internet.

Don't put HTTP basic authentication in front of Studio: Studio sends its own `Authorization` header, so basic auth breaks its requests. Use Cloudflare Access or a VPN for an extra layer instead.

## Keep Postgres private

**Postgres** (port 5432) should never be reachable from the internet. None of the setups above expose it, and by default it listens on the server only:

```bash
KEEL_DB_BIND=127.0.0.1    # the default
```

To connect from other machines, use an SSH tunnel (`ssh -L 5432:127.0.0.1:5432 you@server`) or Tailscale to the server. If you open Postgres to your network instead (`KEEL_DB_BIND=0.0.0.0`), connections from other machines need TLS (`sslmode=require`) and the `postgres` superuser is refused unless `KEEL_DB_REMOTE_SUPERUSER=on`; see [Postgres connections](/self-hosting/security#postgres-connections). Docker-published ports bypass host firewalls such as `ufw`, so a firewall rule alone may not block them: never do this on a server with a public address. For the same reason, keep `KEEL_STUDIO_BIND=127.0.0.1` when Studio is only reached through a proxy or tunnel on the same machine.

See [Security](/self-hosting/security) for the full checklist.


## Next steps

<div class="cards">
  <a class="card" href="./cloudflare-tunnel"><strong>Cloudflare Tunnel</strong><span>Your own domain, without opening a port on your router.</span></a>
  <a class="card" href="./security"><strong>Security checklist</strong><span>What to check before you open Keel to the internet.</span></a>
  <a class="card" href="../auth/oauth"><strong>Social sign-in</strong><span>Register the HTTPS callback URL with each provider.</span></a>
</div>
