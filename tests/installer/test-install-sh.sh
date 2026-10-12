#!/usr/bin/env bash
# Runs install.sh end to end with a stand-in docker (tests/installer/fake-docker),
# so it works on CI runners without Docker, such as macOS. Checks a new
# install, the .env it writes, that a tampered download is refused, and the
# default install folder.
#
#   tests/installer/test-install-sh.sh            # with the bash on PATH
#   BASH_UNDER_TEST=/bin/bash tests/installer/test-install-sh.sh   # macOS: bash 3.2
#
# Needs Node 22.18 or newer (to write the install files) and curl.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
bash_under_test=${BASH_UNDER_TEST:-bash}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/keel-installer-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

# The installer and the files it downloads, served from a folder (file:// URLs).
files=$tmp/files
KEEL_FILES_URL="file://$files" KEEL_RELEASE_VERSION=0.0.1-test KEEL_IMAGE_PREFIX=ghcr.io/example \
  KEEL_SITE_URL=https://keel.example.com node "$root/tests/installer/install-files.mjs" "$files" >/dev/null
chmod 755 "$here/fake-docker/docker"
export PATH="$here/fake-docker:$PATH"
export FAKE_DOCKER_LOG=$tmp/docker.log
unset KEEL_DIR KEEL_VERSION KEEL_PUBLIC_URL KEEL_HOST KEEL_LAN KEEL_DB_LAN KEEL_YES
# shellcheck disable=SC2016 # expanded by the bash under test
echo "bash under test: $("$bash_under_test" -c 'echo $BASH_VERSION')"

"$bash_under_test" -n "$files/install.sh" || fail "install.sh doesn't parse"
"$bash_under_test" -n "$root/keel" || fail "keel doesn't parse"
pass "install.sh and keel parse"

# 1. A new install.
dir=$tmp/keel
if ! "$bash_under_test" "$files/install.sh" --dir "$dir" --yes --no-lan --host keel-test.local >"$tmp/out.txt" 2>&1; then
  cat "$tmp/out.txt"; fail "install failed"
fi
grep -q 'Keel is running' "$tmp/out.txt" || { cat "$tmp/out.txt"; fail "no success message"; }
grep -q 'admin / FakePassword12345678' "$tmp/out.txt" || fail "the login isn't shown"
for key in KEEL_PUBLIC_URL KEEL_VERSION POSTGRES_PASSWORD KEEL_SERVICE_PASSWORD KEEL_SECRET KEEL_FUNCTIONS_TOKEN \
           KEEL_DASHBOARD_PASSWORD IMGPROXY_KEY IMGPROXY_SALT KEEL_STUDIO_BIND KEEL_DB_BIND KEEL_DB_GATEWAY; do
  grep -q "^$key=." "$dir/.env" || fail ".env has no $key"
done
grep -qx 'KEEL_VERSION=0.0.1-test' "$dir/.env" || fail "KEEL_VERSION isn't the release's version"
grep -qx 'KEEL_PUBLIC_URL=http://keel-test.local:8000' "$dir/.env" || fail "KEEL_PUBLIC_URL doesn't use --host"
grep -qx 'KEEL_STUDIO_BIND=127.0.0.1' "$dir/.env" || fail "--no-lan didn't keep Studio on this machine"
grep -qx 'KEEL_DB_BIND=127.0.0.1' "$dir/.env" || fail "Postgres isn't on this machine only"
# shellcheck disable=SC2012 # one known file; ls -l is the portable way to read its mode
[ "$(ls -l "$dir/.env" | cut -c1-10)" = "-rw-------" ] || fail ".env is readable by others: $(ls -l "$dir/.env")"
cmp -s "$dir/docker-compose.yml" "$files/docker-compose.yml" || fail "docker-compose.yml differs from the published one"
[ -x "$dir/keel" ] || fail "the keel command isn't executable"
for d in db storage backups functions tunnel; do [ -d "$dir/$d" ] || fail "no $d folder"; done
grep -q '^docker compose up -d$' "$FAKE_DOCKER_LOG" || fail "Keel wasn't started"
ls "$dir"/*.download >/dev/null 2>&1 && fail "a partial download was left behind"
pass "new install"

# 2. A download that doesn't match SHA256SUMS is refused, and nothing is written.
printf '\n# tampered\n' >> "$files/docker-compose.yml"
if "$bash_under_test" "$files/install.sh" --dir "$tmp/tampered" --yes --no-lan >"$tmp/out2.txt" 2>&1; then
  fail "a tampered docker-compose.yml was accepted"
fi
grep -q "docker-compose.yml doesn't match its published checksum" "$tmp/out2.txt" || { cat "$tmp/out2.txt"; fail "wrong error for a tampered file"; }
if [ -e "$tmp/tampered/docker-compose.yml" ] || [ -e "$tmp/tampered/.env" ]; then fail "files were written despite the bad checksum"; fi
pass "tampered download refused"
KEEL_FILES_URL="file://$files" KEEL_RELEASE_VERSION=0.0.1-test KEEL_IMAGE_PREFIX=ghcr.io/example \
  KEEL_SITE_URL=https://keel.example.com node "$root/tests/installer/install-files.mjs" "$files" >/dev/null

# 3. Without --dir, as a normal user: ~/keel (on macOS and on Linux without root).
if [ "$(id -u)" -ne 0 ]; then
  mkdir -p "$tmp/home"
  if ! HOME=$tmp/home "$bash_under_test" "$files/install.sh" --yes --no-lan >"$tmp/out3.txt" 2>&1; then
    cat "$tmp/out3.txt"; fail "install into the default folder failed"
  fi
  [ -f "$tmp/home/keel/.env" ] || { cat "$tmp/out3.txt"; fail "the default folder isn't ~/keel"; }
  pass "default folder ~/keel"
fi

echo "all installer tests passed"
