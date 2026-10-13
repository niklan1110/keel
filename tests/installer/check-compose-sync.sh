#!/usr/bin/env bash
# Keeps Keel's compose files in step (run by CI, or by hand from the repository root):
#   - the main compose file (deploy/compose), the source checkout's and the
#     self-contained NAS/ZimaOS file define the same services;
#   - every third-party image is pinned by digest and the same in all of them;
#   - the NAS file uses the same Keel image repositories (keel, keel-functions,
#     keel-postgres) as the main file;
#   - the override files (small devices, Windows) only touch existing services.
set -euo pipefail

main=deploy/compose/docker-compose.yml
source_file=docker-compose.yml
nas=deploy/zimaos/docker-compose.yml
overrides="deploy/compose/docker-compose.small.yml deploy/compose/docker-compose.windows.yml"
problems=0
problem() { echo "::error file=$1::$2"; problems=$((problems + 1)); }

# Top-level service names, one per line.
services() { awk '/^services:/ { s = 1; next } s && /^[^ #]/ { s = 0 } s && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { sub(/^  /, ""); sub(/:.*/, ""); print }' "$1" | sort; }
# Images that aren't Keel's own, one per line.
third_party() { sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$1" | grep -vE '/keel(-functions|-postgres)?:|^\$\{KEEL_' | sort -u || true; }
keel_repos() { sed -n 's#^[[:space:]]*image:[[:space:]]*\([^$:]*/keel\(-functions\|-postgres\)\{0,1\}\):.*#\1#p' "$1" | sort -u; }

want=$(services "$main")
[ -n "$want" ] || problem "$main" "no services found"
for f in "$source_file" "$nas"; do
  got=$(services "$f")
  if [ "$got" != "$want" ]; then
    problem "$f" "services differ from $main: $(diff <(echo "$want") <(echo "$got") | grep '^[<>]' | tr '\n' ' ')"
  fi
done

images=$(third_party "$main")
for img in $images; do
  [[ "$img" == *@sha256:* ]] || problem "$main" "pin $img by digest"
done
for f in "$source_file" "$nas"; do
  got=$(third_party "$f")
  [ "$got" = "$images" ] || problem "$f" "third-party images differ from $main: $(echo "$got" | tr '\n' ' ') vs $(echo "$images" | tr '\n' ' ')"
done
for img in $(third_party deploy/cloudflare-tunnel/docker-compose.yml); do
  [[ "$img" == *@sha256:* ]] || problem deploy/cloudflare-tunnel/docker-compose.yml "pin $img by digest"
done

[ "$(keel_repos "$nas")" = "$(keel_repos "$main")" ] || problem "$nas" "Keel images differ from $main: $(keel_repos "$nas" | tr '\n' ' ')"

for f in $overrides; do
  for s in $(services "$f"); do
    echo "$want" | grep -qx "$s" || problem "$f" "overrides $s, which $main doesn't have"
  done
done

if [ "$problems" -gt 0 ]; then echo "$problems problem(s) in the compose files"; exit 1; fi
echo "compose files are in step: $(echo "$want" | wc -l | tr -d ' ') services, images: $(echo "$images" | tr '\n' ' ')"
