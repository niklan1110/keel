# Logs and services

Keel runs as a handful of Docker containers, one per service. Studio shows whether each one is running, lets you read its logs, and can restart, stop and start it. The same logs are available from the command line with `./keel logs`.

```bash
./keel logs keel-auth      # follow one service
./keel logs                # follow everything
```

## The services

Every container's name starts with `keel-`. The **Stack** card in Studio's side panel lists them with their state (all except `keel-migrate` and `keel-docker`):

| Service | Role | What it does |
|---|---|---|
| `keel-db` | Database | Postgres 17. Holds one database per project plus Keel's own control database, `keel`. |
| `keel-migrate` | Migrations | Runs on every start: creates roles, upgrades each project's database and creates the first project, then stays running, idle (in a source checkout it exits). The other services wait for it. |
| `keel-rest` | REST API | Runs one [PostgREST](https://postgrest.org) process per project for `/rest/v1`. |
| `keel-auth` | Auth | Sign-up, sign-in, sessions, users, MFA and auth emails and SMS for every project (`/auth/v1`). |
| `keel-realtime` | Realtime | The WebSocket server for database changes, broadcast and presence (`/realtime/v1`). |
| `keel-storage` | Storage | Buckets and files (`/storage/v1`). Files live in the storage folder. |
| `keel-functions` | Edge functions | Runs each edge function in its own Deno process, started on demand (`/functions/v1`). |
| `keel-imgproxy` | Image resize | Resizes images for storage's image transformation URLs. Reads the storage folder read-only. |
| `keel-gateway` | Gateway | The entry point on port 8000. Routes `/<project>/...` to the right service and checks API keys. |
| `keel-studio` | Studio | The dashboard on port 3000, its management API, scheduled backups and these docs. |
| `keel-docker` | Docker proxy | A locked-down window onto Docker that lets Studio list containers, read logs and start, stop or restart them. |

[Architecture](/reference/architecture) explains how they fit together.

## Reading logs in Studio

Open **Logs** in the dock, or click a service in the stack card (on a phone, tap its chip). The drawer shows:

- the service name, its role and its state, with the image it runs and Docker's status line (for example "Up 3 hours"),
- the **last 300 lines** of the container's output, refreshed every 3 seconds,
- a menu to switch to another service.

While you're scrolled to the bottom, new lines keep the view at the bottom, so it follows the log live. Scroll up to read something and the view stays put; scroll back down to follow again.

Each line has a time, a level and the message. Studio recognizes the levels written by Keel's services, Postgres and imgproxy (**DEBUG**, **INFO**, **LOG**, **WARN**, **ERROR**), and marks other lines that mention "error" as **ERROR** and "warning" as **WARN**.

Type in **Filter log lines (or WARN, ERROR)** to show only lines containing that text, or a level name to show only lines at that level.

For anything older than the last 300 lines, use `./keel logs` (below).

### Where to look

| You're looking for | Service |
|---|---|
| Every API request, with status code and time | `keel-gateway` |
| Sign-in problems, and emails and SMS sent or skipped (with the address masked; links and codes are never logged) | `keel-auth` |
| REST API startup and errors, tagged with the project name (`[my-app]`) | `keel-rest` |
| Slow queries and database errors | `keel-db` |
| Uploads (`PUT avatars/me.png 1.2 MB`) | `keel-storage` |
| Function crashes and `console.log` output | `keel-functions`, or the function's **Logs** tab |
| Scheduled and manual backups | `keel-studio` |
| Problems during startup and upgrades | `keel-migrate` (only with `./keel logs keel-migrate`) |

## Restart, stop and start

The drawer has **Restart** and **Stop** buttons for a running service, and **Start** for a stopped one.

- **Stop** is disabled for `keel-db` and `keel-studio`: Studio can't stop itself, and the database should be stopped with `./keel down` so nothing is cut off mid-write.
- Stopping or restarting `keel-gateway` asks for confirmation first, because apps lose access to every project until it's back.
- Docker gives a container 10 seconds to shut down cleanly before it's killed.
- A container you stop stays stopped until you start it again in Studio or run `./keel up`.

::: tip Restart doesn't reload .env
**Restart** restarts the existing container with the settings it was created with. After changing `.env`, run `./keel up`, which recreates the containers whose settings changed.
:::

## Edge function logs

Each function has its own logs in Studio: open **Functions**, pick the function and choose the **Logs** tab.

- **Recent requests** lists the last few calls with their status code, method, path, duration and time.
- **Console output** shows what the function wrote with `console.log` (as **LOG**) and `console.error` (as **ERROR**), plus Keel's own notes as **KEEL**, such as when the function starts, how long it took to boot and when it stops. If a function can't start, the reason is shown as an **ERROR**.

These are kept in memory by `keel-functions`, up to the last 1,000 lines and 200 requests per function, and are cleared when that container restarts. Everything is also written to the `keel-functions` container log with the project and function name in front, so `./keel logs keel-functions` has the full history:

```text
2026-10-02T14:02:11.123Z INFO  [my-app/hello] Booted v3 in 812ms
2026-10-02T14:02:11.410Z INFO  [my-app/hello] sending welcome email to ada@example.com
```

## Logs from the command line

`./keel logs` follows the logs of one service, or of all of them, starting with the last 200 lines. Press <kbd>Ctrl+C</kbd> to stop.

```bash
./keel logs keel-auth
./keel logs keel-db keel-rest
```

It's a shortcut for `docker compose logs -f --tail=200`, so you can also use Docker Compose directly from the install folder for other options:

```bash
docker compose logs --since 30m keel-gateway    # the last 30 minutes, then exit
docker compose logs --tail 1000 keel-functions > functions.log
```

On a ZimaOS App Store install, which doesn't have the `keel` script, run the same `docker compose logs` commands from the folder that holds its compose file.

Docker keeps a container's logs until the container is removed or recreated, for example by `./keel up` after a settings change or an update. To keep logs longer or limit their size, configure log rotation in Docker itself.

## Log level

`KEEL_LOG_LEVEL` in `.env` sets how much Keel's own services write: `debug`, `info` (the default), `warn` or `error`. Run `./keel up` after changing it.

| Level | What you get |
|---|---|
| `debug` | Everything, including a line for every request that the auth and storage services and Studio's API handle. Useful while chasing a problem. |
| `info` | Startup messages, one line per API request from the gateway, sign-ups, uploads, backups. |
| `warn` | Only warnings and errors. |
| `error` | Only errors. |

It applies to the Keel services (gateway, REST, auth, storage, realtime, functions, Studio and migrations). Postgres, imgproxy and the Docker proxy log on their own terms. Function console output is always kept.

## Personal data in logs

Sign-in links, password reset links and one-time codes (email and SMS) are never written to the logs, with or without a mail server. Email addresses and phone numbers are masked (`a***@example.com`, `+15*******00`), a failed Studio sign-in names the account only when it exists (people sometimes type their password into the username field), and the gateway logs the route of each request rather than its full path: storage object names hold user IDs and file names, so `/my-app/storage/v1/object/avatars/<user-id>/me.png` is logged as `/my-app/storage/v1/object/avatars/*`.

While you chase a problem, `KEEL_LOG_PII=on` in `.env` writes full addresses, numbers and paths. Run `./keel up` after changing it, and turn it off again afterwards. Links and codes stay out of the logs either way.

## The Docker proxy

Studio doesn't get the Docker socket itself. It talks to `keel-docker`, a small proxy that's part of Keel. It only lists this install's containers, reads their logs and starts, stops or restarts them; other apps' containers are invisible to it, and it never passes on environment variables. It can't create containers, change them or run commands inside them. It sits on a private network that only Studio can reach, and it isn't exposed on any port.

### Turning container controls off

If you'd rather Studio had no access to Docker at all, turn it off and keep `keel-docker` from starting with a `docker-compose.override.yml`, as described in [Security](/self-hosting/security#the-docker-proxy). An override file leaves `docker-compose.yml` untouched, so updates keep working.

Studio then can't reach Docker and falls back to health checks: the stack card shows each service as **Running** or **Stopped** depending on whether it answers, and the Logs drawer explains that logs and controls need `keel-docker`. Use `./keel logs` and `./keel ps` on the server instead.

::: info
To keep the service running but cut Studio off from it, only set `KEEL_DOCKER_HOST=off` (or leave it empty: `KEEL_DOCKER_HOST=`) in `.env` and run `./keel up`.
:::
