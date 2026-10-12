#!/usr/bin/env bash
# Keel installer: sets up Keel with the published images on Linux, macOS
# (Docker Desktop, OrbStack or Colima), Windows (WSL 2) and NAS systems with
# Docker (ZimaOS, CasaOS, Synology, Unraid, TrueNAS SCALE, Raspberry Pi OS, ...).
# On Windows without WSL, use install.ps1 instead. Works in bash 3.2 (macOS).
#
#   curl -fsSL @@SITE@@/install.sh | sudo bash
#   curl -fsSL @@SITE@@/install.sh | sudo bash -s -- --lan --version 0.2.0
#
# Or download it, check it and then run it (see the install guide):
#   curl -fsSLO @@SITE@@/install.sh && curl -fsSLO @@SITE@@/install.sh.sha256
#   sha256sum -c install.sh.sha256 && sudo bash install.sh
#
# It checks every file it downloads against SHA256SUMS, published next to them.
#
# Run it again to update an existing install: it backs up every database
# first, and --rollback goes back to the version before. Options, as flags or
# as environment variables:
#   --dir DIR        KEEL_DIR         where to install (default: depends on the
#                                     system, e.g. /opt/keel, ~/keel, /volume1/docker/keel)
#   --version V      KEEL_VERSION     version to install or update to, e.g. 0.2.0
#                                     (default: the newest release)
#   --url URL        KEEL_PUBLIC_URL  how apps reach the API (default: http://<this machine's IP>:8000)
#   --host HOST      KEEL_HOST        just the address part of that, e.g. nas.local
#   --lan            KEEL_LAN=yes     open Studio to your network
#   --no-lan         KEEL_LAN=no      keep Studio on this machine only
#   --lan-db         KEEL_DB_LAN=yes  open Postgres to your network too
#   --yes            KEEL_YES=1       don't ask questions; use the defaults
#   --rollback                        go back to the version before the last update
#   --restore                         with --rollback: also restore the databases
#                                     from the backup taken before that update
#
# Studio and Postgres listen on this machine only unless you choose otherwise.
# On a NAS, Studio is opened to your network by default. On a cloud server
# (detected from the provider's metadata service or the machine's firmware),
# both always stay on this machine unless you pass --lan.
set -euo pipefail

SITE="@@SITE@@"
IMAGES="@@IMAGES@@"
# Where the compose file and the keel command come from: the website, or for
# the installer attached to a GitHub release, that release (whose version is
# then the default).
FILES="@@FILES@@"
RELEASE="@@RELEASE@@"

say() { printf '%s\n' "$*"; }
warn() { printf 'keel: %s\n' "$*" >&2; }
die() { printf 'keel: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Keel installer. Options (or the environment variables in brackets):
  --dir DIR      where to install [KEEL_DIR]
  --version V    version, e.g. 0.2.0 (default: the newest release) [KEEL_VERSION]
  --url URL      how apps reach the API [KEEL_PUBLIC_URL]
  --host HOST    just the address part of that [KEEL_HOST]
  --lan          open Studio to your network [KEEL_LAN=yes]
  --no-lan       keep Studio on this machine only [KEEL_LAN=no]
  --lan-db       open Postgres to your network too [KEEL_DB_LAN=yes]
  --yes          don't ask questions [KEEL_YES=1]
  --rollback     go back to the version before the last update
  --restore      with --rollback: also restore the databases backed up before it
USAGE
}

# --- Options ------------------------------------------------------------------
dir=${KEEL_DIR:-}
version=${KEEL_VERSION:-}
url=${KEEL_PUBLIC_URL:-}
host=${KEEL_HOST:-}
lan=${KEEL_LAN:-}
db_lan=${KEEL_DB_LAN:-}
assume_yes=${KEEL_YES:-}
rollback=""
restore=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir=${2:-}; shift 2 ;;
    --version) version=${2:-}; shift 2 ;;
    --url) url=${2:-}; shift 2 ;;
    --host) host=${2:-}; shift 2 ;;
    --lan) lan=yes; shift ;;
    --no-lan) lan=no; shift ;;
    --lan-db) db_lan=yes; shift ;;
    --yes|-y) assume_yes=1; shift ;;
    --rollback) rollback=1; shift ;;
    --restore) restore=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1 (see the top of this script for the options)" ;;
  esac
done
case "$lan" in ''|yes|no) ;; 1|true|on) lan=yes ;; 0|false|off) lan=no ;; *) die "KEEL_LAN must be yes or no" ;; esac
case "$db_lan" in ''|no|0|false|off) db_lan="" ;; yes|1|true|on) db_lan=yes ;; *) die "KEEL_DB_LAN must be yes or no" ;; esac
if [ -n "$version" ]; then
  version=${version#v}
  [[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "--version: use a tag such as 0.2.0 or latest"
fi
if [ -n "$url" ] && ! [[ "$url" =~ ^https?://[^[:space:]]+$ ]]; then
  die "--url must look like http://192.168.1.20:8000 or https://api.example.com"
fi

# Questions go to the terminal even when this script arrives through a pipe.
tty_ok=""
if [ -z "$assume_yes" ] && [ -t 1 ] && { : </dev/tty; } 2>/dev/null; then tty_ok=1; fi
ask() { # ask "question" default(y|n) -> 0 for yes
  local answer=""
  if [ -z "$tty_ok" ]; then [ "$2" = y ]; return; fi
  printf '%s [%s] ' "$1" "$([ "$2" = y ] && echo Y/n || echo y/N)" >/dev/tty
  read -r answer </dev/tty || answer=""
  case "${answer:-$2}" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# --- Platform -----------------------------------------------------------------
os=$(uname -s)
platform=linux
if [ "$os" = Darwin ]; then platform=macos
elif [ -d /DATA/AppData ]; then platform=zimaos   # ZimaOS and CasaOS
elif [ -f /etc/synoinfo.conf ] || [ -d /var/packages/ContainerManager ] || [ -d /var/packages/Docker ]; then platform=synology
elif [ -f /etc/unraid-version ]; then platform=unraid
elif grep -qi truenas /etc/version 2>/dev/null || command -v midclt >/dev/null 2>&1; then platform=truenas
elif [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then platform=wsl
fi
is_nas() { case "$platform" in zimaos|synology|unraid|truenas) return 0 ;; *) return 1 ;; esac; }

command -v docker >/dev/null 2>&1 || case "$platform" in
  macos) die "Docker is required: install Docker Desktop or OrbStack, start it, then run this again (without sudo)." ;;
  wsl) die "Docker is required: install Docker Desktop for Windows and turn on WSL integration for this distribution (Settings > Resources > WSL integration)." ;;
  *) die "Docker is required: https://docs.docker.com/engine/install/" ;;
esac
if ! docker compose version >/dev/null 2>&1; then
  case "$platform" in
    unraid) die "Docker Compose is required: install the Compose Manager plugin (Apps > Compose Manager), then run this again." ;;
    # Docker Desktop and OrbStack include it; with Colima it comes from Homebrew.
    macos) die "the Docker Compose plugin is required (docker compose version). With Colima: brew install docker-compose, then follow its note on cliPluginsExtraDirs." ;;
    *) die "the Docker Compose plugin is required (docker compose version)" ;;
  esac
fi
if ! docker info >/dev/null 2>&1; then
  case "$platform" in
    macos) die "can't talk to Docker. Start Docker Desktop or OrbStack and run this as your own user (no sudo)." ;;
    *) die "can't talk to Docker. Run this as root (sudo bash) or as a user in the docker group." ;;
  esac
fi
command -v curl >/dev/null 2>&1 || die "curl is required"

# Docker Desktop, rootless Docker and Podman hand containers every outside
# connection from the Docker network's gateway, so Postgres can't tell this
# machine from the rest of the network (KEEL_DB_GATEWAY=remote handles that).
docker_hides_clients() {
  case "$platform" in macos|wsl) return 0 ;; esac
  docker info -f '{{.SecurityOptions}} {{.OperatingSystem}}' 2>/dev/null | grep -qi 'rootless\|docker desktop' && return 0
  docker --version 2>/dev/null | grep -qi podman && return 0
  return 1
}

# The home folder of the person running this (also under sudo).
user_home() {
  local h=""
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    h=$(eval "echo ~$SUDO_USER" 2>/dev/null || true)
  fi
  echo "${h:-$HOME}"
}

# TrueNAS: data belongs on a pool under /mnt, never on the boot pool.
truenas_dir() {
  local pools=() p
  for p in /mnt/*/; do
    p=${p%/}
    case "$p" in /mnt/.*|/mnt/'*') continue ;; esac
    [ -d "$p" ] && pools+=("$p")
  done
  if [ ${#pools[@]} -eq 1 ]; then echo "${pools[0]}/apps/keel"; return; fi
  if [ -n "$tty_ok" ] && [ ${#pools[@]} -gt 1 ]; then
    say "Pools found: ${pools[*]}" >/dev/tty
    printf 'Install Keel on which pool? [%s] ' "${pools[0]}" >/dev/tty
    read -r p </dev/tty || p=""
    p=${p:-${pools[0]}}
    p=${p%/}
    [ -d "$p" ] || die "$p doesn't exist"
    echo "$p/apps/keel"; return
  fi
  die "TrueNAS: choose where Keel keeps its data, e.g. --dir /mnt/<pool>/apps/keel"
}

if [ -z "$dir" ]; then
  case "$platform" in
    zimaos) dir=/DATA/AppData/keel ;;
    synology)
      vol=/volume1
      [ -d "$vol" ] || vol=$(find / -maxdepth 1 -name 'volume[0-9]*' -type d 2>/dev/null | sort | head -n 1)
      [ -n "$vol" ] || die "Synology: no /volume1 found; pass --dir /volumeN/docker/keel"
      dir=$vol/docker/keel ;;
    # / is a RAM disk on Unraid: anything outside /mnt is gone after a reboot.
    unraid) dir=/mnt/user/appdata/keel ;;
    truenas) dir=$(truenas_dir) ;;
    # Docker Desktop only shares /Users (and a few others) with containers.
    macos) dir=$(user_home)/keel ;;
    *) if [ "$(id -u)" -eq 0 ]; then dir=/opt/keel; else dir=$HOME/keel; fi ;;
  esac
fi
case "$dir" in /*) ;; *) dir=$PWD/$dir ;; esac
case "$platform:$dir" in
  unraid:/mnt/*) ;;
  unraid:*) die "on Unraid, install under /mnt (e.g. /mnt/user/appdata/keel): everything else is lost on reboot" ;;
  macos:/opt/*|macos:/usr/*) die "Docker Desktop can't share $dir with containers; use a folder in your home (e.g. ~/keel)" ;;
  wsl:/mnt/[a-zA-Z]/*) warn "$dir is on a Windows drive. Postgres there is slow and can lose data; a folder inside WSL (e.g. ~/keel or /opt/keel) is much better." ;;
esac

# SHA-256 of a file: sha256sum on Linux and most NAS systems, shasum on macOS.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"
  else openssl dgst -sha256 -r "$1"
  fi | awk '{ print $1 }'
}

# Downloads a published file, but only keeps it if it matches its checksum in
# SHA256SUMS (published next to it).
sums=""
fetch() {
  local want got
  if [ -z "$sums" ]; then
    sums=$(curl -fsSL "$FILES/SHA256SUMS") || die "could not download $FILES/SHA256SUMS"
  fi
  want=$(printf '%s\n' "$sums" | awk -v f="$1" '$2 == f || $2 == "*" f { print $1; exit }')
  [ -n "$want" ] || die "$1 is not listed in $FILES/SHA256SUMS"
  curl -fsSL "$FILES/$1" -o "$2.download" || { rm -f "$2.download"; die "could not download $FILES/$1"; }
  got=$(sha256_of "$2.download" 2>/dev/null || true)
  if [ "$got" != "$want" ]; then
    rm -f "$2.download"
    die "$1 doesn't match its published checksum (expected $want, got ${got:-nothing}); nothing was changed"
  fi
  mv -f "$2.download" "$2"
}

# Value of a setting in .env (last one wins, like docker compose).
env_get() { grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
# Sets a setting in .env, replacing an existing line (no sed -i: BSD and GNU differ).
env_set() {
  local tmp
  tmp=$(mktemp .env.XXXXXX)
  { grep -vE "^$1=" .env || true; printf '%s=%s\n' "$1" "$2"; } > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" .env
}

# Keeps the last few copies of a file as NAME.bak.<time>, newest first.
backup() {
  local f=$1 keep=5 base name last n old
  [ -f "$f" ] || return 0
  base="$f.bak.$(date +%Y%m%d-%H%M%S)"
  name=$base
  # Several in the same second: number them after the highest one so far.
  if [ -e "$base" ] || ls "$base"-* >/dev/null 2>&1; then
    # shellcheck disable=SC2012
    last=$(ls -1 "$base"-* 2>/dev/null | sort | tail -n 1 || true)
    n=${last##*-}
    n=$((10#${n:-0} + 1))
    name="$base-$(printf %02d "$n")"
  fi
  cp -p "$f" "$name"
  # The names sort by time (cp -p keeps the file's own time, so not ls -t).
  # shellcheck disable=SC2012
  ls -1 "$f".bak.* 2>/dev/null | sort -r | tail -n +$((keep + 1)) | while IFS= read -r old; do rm -f "$old"; done || true
}

# --- Network ------------------------------------------------------------------
looks_like_host() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && return 0
  [ "${#1}" -le 253 ] && [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]
}

# In WSL, Docker Desktop publishes ports on Windows, so phones and other
# computers reach Keel at the Windows machine's address, not WSL's.
windows_lan_ip() {
  command -v powershell.exe >/dev/null 2>&1 || return 0
  # shellcheck disable=SC2016
  powershell.exe -NoProfile -NonInteractive -Command \
    '(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq "Up" } | Select-Object -First 1).IPv4Address.IPAddress' \
    2>/dev/null | tr -d '\r' | head -n 1 || true
}

detect_ip() {
  local ip="" iface
  if [ "$platform" = macos ]; then
    for iface in en0 en1; do
      ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
      [ -n "$ip" ] && break
    done
  else
    if [ "$platform" = wsl ]; then ip=$(windows_lan_ip); fi
    if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
      ip=$( (ip route get 1.1.1.1 2>/dev/null || true) | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')
    fi
    if [ -z "$ip" ] && hostname -I >/dev/null 2>&1; then ip=$(hostname -I | awk '{print $1}'); fi
  fi
  looks_like_host "$ip" || ip=""
  printf '%s' "${ip:-localhost}"
}

# Every IPv4 address of this machine on the network (comma separated), so
# function code can't reach it even inside an allowed LAN range.
host_addresses() {
  {
    detect_ip
    echo
    if [ "$platform" != macos ]; then hostname -I 2>/dev/null | tr ' ' '\n' || true; fi
  } | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' | grep -v '^127\.' | sort -u | paste -sd, - || true
}

is_private() {
  case "$1" in
    10.*|192.168.*|127.*|169.254.*|localhost|*.local|*.lan|*.home|*.home.arpa|*.internal) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;;
    *) return 1 ;;
  esac
}

# A cloud VM usually has a private address behind 1:1 NAT, so the address alone
# says nothing. Ask the firmware and the metadata service instead.
cloud=""
detect_cloud() {
  local f v
  for f in sys_vendor product_name bios_vendor board_vendor chassis_vendor chassis_asset_tag; do
    v=$(cat "/sys/class/dmi/id/$f" 2>/dev/null || true)
    case "$v" in
      *Amazon*|*EC2*|*Google*|*DigitalOcean*|*Hetzner*|*Linode*|*Akamai*|*Vultr*|*Scaleway*|*OVH*|*OpenStack*|*Alibaba*|*Tencent*|*UpCloud*|*Exoscale*|*OracleCloud*|*Oracle\ Cloud*|*IONOS*|*Contabo*|*netcup*|7783-7084-3265-9085-8269-3286-77)
        cloud="$v"; return 0 ;;
    esac
  done
  # Any HTTP answer from the link-local metadata address means a cloud provider.
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 1 -m 2 http://169.254.169.254/ 2>/dev/null || true)
  if [ -n "$code" ] && [ "$code" != 000 ]; then cloud="metadata service"; return 0; fi
  return 1
}
if [ "$platform" = linux ]; then detect_cloud || true; fi

# Decides whether Studio listens on the network (0.0.0.0) or this machine only.
choose_studio_bind() {
  if [ "$lan" = yes ]; then echo 0.0.0.0; return; fi
  if [ "$lan" = no ]; then echo 127.0.0.1; return; fi
  if [ -n "$cloud" ]; then echo 127.0.0.1; return; fi
  if ! is_private "$(detect_ip)"; then echo 127.0.0.1; return; fi
  if is_nas; then
    if ask "Open Studio (the dashboard) to your local network?" y; then echo 0.0.0.0; else echo 127.0.0.1; fi
    return
  fi
  if ask "Open Studio (the dashboard) to your local network? (No: only this machine can open it)" n; then echo 0.0.0.0; else echo 127.0.0.1; fi
}

# --- Waiting for Keel -----------------------------------------------------------
# Healthy when Studio answers on its port (read from .env) or Docker reports
# keel-studio and keel-gateway healthy. Fails loudly otherwise.
container_health() {
  local id
  id=$(docker compose ps -q "$1" 2>/dev/null | head -n 1)
  [ -n "$id" ] || { echo missing; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing
}
wait_for_keel() {
  local port studio gateway
  port=$(env_get KEEL_STUDIO_PORT)
  port=${port:-3000}
  say "Waiting for Keel to start (up to 5 minutes)..."
  for _ in $(seq 1 100); do
    if curl -fs -m 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then return 0; fi
    studio=$(container_health keel-studio)
    gateway=$(container_health keel-gateway)
    if [ "$studio" = healthy ] && [ "$gateway" = healthy ]; then return 0; fi
    sleep 3
  done
  warn "Keel didn't start: Studio never answered on port $port."
  docker compose ps -a >&2 || true
  warn "Last log lines of the database, migrations and Studio:"
  docker compose logs --tail 20 keel-db keel-migrate keel-studio >&2 || true
  return 1
}

# --- Update -------------------------------------------------------------------
if [ -n "$rollback" ]; then
  if [ ! -f "$dir/.env" ] || [ ! -x "$dir/keel" ]; then die "no Keel install in $dir to roll back"; fi
  cd "$dir"
  args=()
  [ -z "$restore" ] || args+=(--restore)
  [ -z "$assume_yes" ] || args+=(--yes)
  exec ./keel rollback ${args[@]+"${args[@]}"}
fi
[ -z "$restore" ] || die "--restore goes with --rollback"

# The folder holds .env, nightly dumps and uploaded files: only its owner may
# look inside (containers reach their own mounts regardless). An existing
# folder is tightened only when it's a Keel install, never someone else's.
if [ ! -d "$dir" ]; then
  mkdir -p "$dir"
  chmod 700 "$dir"
elif [ -f "$dir/docker-compose.yml" ] && [ -f "$dir/.env" ]; then
  chmod 700 "$dir"
fi
cd "$dir"

if [ -f docker-compose.yml ]; then
  [ -f .env ] || die "$dir has a docker-compose.yml but no .env; not touching it"
  say "Keel is already installed in $dir: updating it."
  backup .env
  backup docker-compose.yml
  fetch keel-cli.sh keel && chmod 755 keel
  # Older compose files had no fixed project name: keep the one the containers use.
  project=$(docker ps -a --filter "label=com.docker.compose.project.working_dir=$PWD" --format '{{.Label "com.docker.compose.project"}}' | head -n 1)
  if [ -n "$project" ] && [ "$project" != keel ] && [ -z "$(env_get COMPOSE_PROJECT_NAME)" ]; then
    env_set COMPOSE_PROJECT_NAME "$project"
  fi
  # Studio and Postgres used to listen on every interface unless the .env said
  # otherwise; they now default to this machine only. Keep Studio where it
  # was (except on a cloud server), and say what changed.
  if [ -n "$lan" ]; then
    env_set KEEL_STUDIO_BIND "$([ "$lan" = yes ] && echo 0.0.0.0 || echo 127.0.0.1)"
  elif [ -z "$(env_get KEEL_STUDIO_BIND)" ]; then
    if [ -n "$cloud" ]; then
      env_set KEEL_STUDIO_BIND 127.0.0.1
      say "Studio now listens on this machine only (cloud server: $cloud). Reach it over SSH or a tunnel, or run this again with --lan."
    else
      env_set KEEL_STUDIO_BIND 0.0.0.0
      say "Studio stays open to your network (KEEL_STUDIO_BIND=0.0.0.0 in .env)."
    fi
  fi
  if [ -z "$(env_get KEEL_HOST_ADDRESSES)" ]; then env_set KEEL_HOST_ADDRESSES "$(host_addresses)"; fi
  if [ -n "$cloud" ] && [ -z "$(env_get KEEL_EXPOSURE)" ]; then
    env_set KEEL_EXPOSURE internet
    say "New projects start with sign-ups off or confirmed by email (cloud server: KEEL_EXPOSURE=internet in .env)."
  fi
  if [ -n "$db_lan" ]; then
    env_set KEEL_DB_BIND 0.0.0.0
  elif [ -z "$(env_get KEEL_DB_BIND)" ]; then
    env_set KEEL_DB_BIND 127.0.0.1
    say "Postgres now listens on this machine only. To reach it from other machines, set KEEL_DB_BIND=0.0.0.0"
    say "in .env (connections then need TLS; add KEEL_DB_REMOTE_SUPERUSER=on to sign in as postgres)."
  fi
  if [ "$(env_get KEEL_DB_BIND)" = 0.0.0.0 ] && [ -z "$(env_get KEEL_DB_GATEWAY)" ] && docker_hides_clients; then
    env_set KEEL_DB_GATEWAY remote
    say "Postgres is open to your network and Docker here hides where connections come from: connections"
    say "to it, from this machine too, now need TLS and can't sign in as postgres (KEEL_DB_GATEWAY=remote in .env)."
  fi

  # The new compose file goes in place after the databases are backed up.
  fetch docker-compose.yml docker-compose.yml.new
  # ./keel update backs up every database, moves to the new version (the
  # newest release unless --version says otherwise), records the previous one
  # for ./keel rollback, restarts Keel and waits until it answers.
  args=(--compose docker-compose.yml.new)
  [ "$version" != latest ] || version=""
  version=${version:-$RELEASE}
  [ -z "$version" ] || args+=(--version "$version")
  [ -z "$assume_yes" ] || args+=(--yes)
  ./keel update "${args[@]}" || die "update failed. To go back to the previous version: cd $dir && ./keel rollback
(earlier settings are in $dir/.env.bak.*, earlier compose files in $dir/docker-compose.yml.bak.*)"
  say "Done. Your settings and data were kept; the databases were backed up to $dir/backups/pre-update first."
  exit 0
fi

# --- New install --------------------------------------------------------------
if [ -n "$(ls -A db 2>/dev/null)" ]; then
  die "$dir/db already holds a database but there are no Keel settings here. If Keel was installed from the ZimaOS App Store, update it there; otherwise move the folder away first."
fi

# Install a version, never a moving tag: the newest release unless chosen.
tag=${version:-$RELEASE}
if [ -z "$tag" ]; then
  docker pull -q "$IMAGES/keel:latest" >/dev/null || die "could not download $IMAGES/keel:latest"
  tag=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGES/keel:latest" 2>/dev/null || true)
  [[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || tag=latest
fi
[ -n "$host" ] || host=$(detect_ip)
looks_like_host "$host" || die "--host must be an IP address or a host name"
[ -n "$url" ] || url="http://$host:8000"
studio_bind=$(choose_studio_bind)
db_bind=127.0.0.1
[ -z "$db_lan" ] || db_bind=0.0.0.0
db_gateway=local
if [ "$db_bind" = 0.0.0.0 ] && docker_hides_clients; then
  db_gateway=remote
  say "Docker here hides where connections come from, so Postgres treats every connection to its port"
  say "as coming from your network, this machine's too: TLS is required and postgres can't sign in."
fi

say "Installing Keel $tag into $dir"
[ -z "$cloud" ] || say "This looks like a cloud server ($cloud): Studio and Postgres stay on this machine unless you pass --lan / --lan-db."
fetch docker-compose.yml docker-compose.yml
fetch keel-cli.sh keel && chmod 755 keel

say "Downloading the images (the first time takes a few minutes)..."
docker pull -q "$IMAGES/keel:$tag" >/dev/null || die "could not download $IMAGES/keel:$tag"
secrets=$(docker run --rm "$IMAGES/keel:$tag" generate-env) || die "could not generate passwords"
pw=$(printf '%s\n' "$secrets" | sed -n 's/^KEEL_DASHBOARD_PASSWORD=//p')

umask 077
{
  echo "# Keel settings. Keep a copy somewhere safe: the passwords can't be recovered from the database."
  echo "KEEL_PUBLIC_URL=$url"
  echo "KEEL_VERSION=$tag"
  printf '%s\n' "$secrets"
  echo "# 127.0.0.1: this machine only; 0.0.0.0: your network too."
  echo "KEEL_STUDIO_BIND=$studio_bind"
  echo "KEEL_DB_BIND=$db_bind"
  echo "KEEL_DB_GATEWAY=$db_gateway"
  echo "KEEL_HOST_ADDRESSES=$(host_addresses)"
  # A cloud server's own address is private behind 1:1 NAT: say it's on the internet.
  [ -z "$cloud" ] || echo "KEEL_EXPOSURE=internet"
} > .env
chmod 600 .env
umask 022
mkdir -p db storage backups functions tunnel

docker compose up -d
wait_for_keel || die "Keel was installed in $dir but didn't start. Fix the problem above, then run: cd $dir && docker compose up -d"

# macOS under sudo: hand the folder to the user whose Docker Desktop runs it.
if [ "$platform" = macos ] && [ -n "${SUDO_USER:-}" ]; then chown -R "$SUDO_USER" "$dir" 2>/dev/null || true; fi

studio_port=$(env_get KEEL_STUDIO_PORT)
studio_port=${studio_port:-3000}
if [ "$studio_bind" = 0.0.0.0 ]; then
  studio="http://$host:$studio_port"
elif [ "$platform" = macos ] || [ "$platform" = wsl ]; then
  studio="http://localhost:$studio_port   (this computer only; run again with --lan to open it to your network)"
else
  studio="http://localhost:$studio_port after: ssh -L $studio_port:127.0.0.1:$studio_port <you>@$host
                       (Studio listens on this machine only; run again with --lan to open it
                        to your network, or see the Cloudflare Tunnel guide)"
fi

cat <<MSG

Keel is running.

  Studio (dashboard):  $studio
  Sign in:             admin / $pw
  API for your apps:   $url/my-app
  Settings:            $dir/.env   (passwords; keep a copy somewhere safe)
  Data:                $dir/{db,db-tls,storage,backups,functions,tunnel}

Next: open Studio, change your password and turn on two-factor authentication
under "Account and security". Manage Keel with $dir/keel (./keel help);
update with ./keel update. Guides: $SITE
MSG
[ -z "$cloud" ] || say "
Cloud server: set KEEL_PUBLIC_URL in $dir/.env to your public address or domain
(it is $url now) and run ./keel up."
