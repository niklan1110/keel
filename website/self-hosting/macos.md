# macOS

Keel runs on Apple Silicon and Intel Macs with [Docker Desktop](https://www.docker.com/products/docker-desktop/), [OrbStack](https://orbstack.dev) or [Colima](https://github.com/abiosoft/colima). The installer is the same one Linux uses, and works with the bash 3.2 and command-line tools that come with macOS.

```bash
curl -fsSL @@SITE@@/install.sh | bash
```

Run it as yourself, **without `sudo`**: Docker on a Mac belongs to your user, and under `sudo` the installer can't reach it.

When it's done:

| | |
|---|---|
| **Studio** | `http://localhost:3000`, on this Mac only |
| **API for your apps** | `http://<this Mac's IP>:8000/<project>`, open to your network |
| **Postgres** | `localhost:5432`, on this Mac only |
| **Settings** | `~/keel/.env` (readable by you only) |
| **Data** | `~/keel/{db,db-tls,storage,backups,functions,tunnel}` |

## Pick a Docker

| | Good for | Notes |
|---|---|---|
| **OrbStack** | most Macs | Light on memory and battery, fast file sharing. Free for personal use. |
| **Docker Desktop** | if you already use it | Give it 4 GB of memory or more (Settings > Resources). |
| **Colima** | open source, from the command line | Start it with VirtioFS file sharing, which Postgres needs (see below). |

Start whichever you choose before you run the installer, and check that `docker compose version` works in Terminal.

### Colima

Postgres needs file sharing that keeps file owners and permissions, which Colima's older sshfs sharing doesn't. Start Colima with Apple's virtualization and VirtioFS, and enough memory:

```bash
brew install colima docker docker-compose
colima start --vm-type vz --mount-type virtiofs --cpu 2 --memory 4
```

Homebrew's `docker-compose` prints how to make it available as `docker compose` (a `cliPluginsExtraDirs` line for `~/.docker/config.json`); the installer needs that. To start Colima, and with it Keel, after a restart: `brew services start colima`.

## Install

In Terminal:

```bash
curl -fsSL @@SITE@@/install.sh | bash
```

The installer checks Docker, downloads Keel's compose file and the `keel` command into `~/keel` (checking each against the published SHA-256 checksums), downloads the images for one exact version, writes `.env` with random passwords and your Mac's address, starts Keel, waits until Studio answers and prints your login.

To check the installer before running it:

```bash
curl -fsSLO @@SITE@@/install.sh && curl -fsSLO @@SITE@@/install.sh.sha256
shasum -a 256 -c install.sh.sha256 && bash install.sh
```

Options go after `bash -s --`, for example `curl -fsSL @@SITE@@/install.sh | bash -s -- --lan --version 0.2.0`. All of them are in [installer options](/self-hosting/docker#options).

Keel goes into `~/keel`. Don't install it under `/opt` or `/usr/local`: Docker on a Mac shares your home folder (and `/Volumes`) with containers, not those, so Postgres couldn't use its folder there. The installer refuses them.

## Day to day

```bash
cd ~/keel
./keel ps                      # is everything running?
./keel logs keel-auth          # follow a service's logs
./keel down                    # stop Keel (data is kept)
./keel up                      # start it again, and apply changes to .env
./keel update                  # back up, move to the newest release, restart
./keel rollback                # back to the version before the last update
```

See the [keel CLI](/self-hosting/cli) for every command.

- **Studio** opens at `http://localhost:3000` on the Mac. To open it from other devices, run the installer again with `--lan` (it updates the install and keeps your data), or set `KEEL_STUDIO_BIND=0.0.0.0` in `~/keel/.env` and run `./keel up`. macOS may ask whether Docker or OrbStack may accept incoming connections; allow it.
- **The API address** comes from the Mac's Wi-Fi or Ethernet (`en0`, then `en1`). If it picks the wrong one, pass `--host <name>.local`. If the address changes, give the Mac a fixed one in your router (a DHCP reservation) and update `KEEL_PUBLIC_URL`.
- **Postgres** stays on the Mac. Docker on a Mac hides where a connection comes from, so Postgres can't tell the Mac from other devices; if you open it to your network (`--lan-db`), every connection, the Mac's too, needs TLS and can't sign in as `postgres`. An SSH tunnel or Tailscale is simpler. See [Postgres connections](/self-hosting/security#postgres-connections).
- **Sleep:** a sleeping Mac takes your backend with it. Turn off automatic sleep (System Settings > Energy) if other devices rely on Keel.
- **After a restart**, Keel's containers start with Docker. Have Docker Desktop or OrbStack open at login (their settings), or run Colima as a service.

## Uninstall

```bash
cd ~/keel && ./keel down
```

Then delete `~/keel` (it holds the databases, uploads and backups). Keep `.env` and a recent dump from `backups/` if you might come back.

## From the source code

In a copy of the source, run `./keel init` (or `./keel init --lan`) and `./keel up` in Terminal instead. That builds the images on the Mac.

## Troubleshooting

| Problem | Fix |
|---|---|
| **"can't talk to Docker"** | Start Docker Desktop, OrbStack or Colima, and run the installer as yourself, without `sudo`. |
| **"the Docker Compose plugin is required"** | Docker Desktop and OrbStack include it. With Colima, install `docker-compose` with Homebrew and add the `cliPluginsExtraDirs` line it prints. |
| **`keel-db` keeps restarting with "wrong ownership" or "invalid permissions"** | Colima with sshfs file sharing. Recreate its VM with the options in [Colima](#colima) (`colima delete`, then `colima start ...`; Keel's data in `~/keel` stays), then `./keel up`. |
| **Phones can't reach the API** | Allow incoming connections for Docker or OrbStack (System Settings > Network > Firewall), and check that `KEEL_PUBLIC_URL` uses the Mac's network address. |

More in [Troubleshooting](/self-hosting/troubleshooting).


## Next steps

<div class="cards">
  <a class="card" href="../guide/quickstart#_3-open-studio"><strong>Finish the quickstart</strong><span>Open Studio, create a table and query it from your app.</span></a>
  <a class="card" href="./remote-access"><strong>Internet access and HTTPS</strong><span>Reach Keel away from home, privately or publicly.</span></a>
  <a class="card" href="./backups"><strong>Backups and restore</strong><span>Turn on encrypted full backups to a bucket off the machine.</span></a>
  <a class="card" href="./security"><strong>Security checklist</strong><span>What to check before more people rely on your server.</span></a>
</div>
