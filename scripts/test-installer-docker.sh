#!/usr/bin/env bash
# Runs the Linux installer for real inside a throwaway Docker container against a running server, as a normal user
# with sudo (like a fresh desktop), with the mock runtime and no Claude sign-in. Docker only: nothing runs on this host.
#
#   AOM_SERVER=http://127.0.0.1:4655 AOM_EMAIL=you@example.com AOM_PASSWORD=... \
#     scripts/test-installer-docker.sh [image ...]        (default: ubuntu:24.04 debian:12)
#
# The server must be reachable from the container (it runs with --network host, so 127.0.0.1 works) and publish a runner
# release (`pnpm package:runner`, AOM_RUNNER_RELEASE_DIR). Each image gets a fresh wizard session (a fresh one-time
# code). Without systemd in the container the installer takes its documented fallback (it says so and starts the runner
# in the background). Pass IMAGE=jrei/systemd-ubuntu:24.04 with SYSTEMD=1 to exercise the real systemd user service.
set -euo pipefail
SERVER="${AOM_SERVER:?set AOM_SERVER}"
EMAIL="${AOM_EMAIL:?set AOM_EMAIL}"
PASSWORD="${AOM_PASSWORD:?set AOM_PASSWORD}"
IMAGES=("$@")
[ "${#IMAGES[@]}" -gt 0 ] || IMAGES=(ubuntu:24.04 debian:12)
status=0

one_liner() {
  local jar
  jar="$(mktemp)"
  curl -fsS -c "$jar" -H "Origin: $SERVER" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$SERVER/api/auth/login" >/dev/null
  curl -fsS -b "$jar" -H "Origin: $SERVER" -H 'content-type: application/json' \
    -d '{"os":"linux","name":"Container workstation"}' "$SERVER/api/workstations/installers" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).oneLiner))'
  rm -f "$jar"
}

for image in "${IMAGES[@]}"; do
  echo "=== $image"
  ONE="$(one_liner)"
  extra=()
  [ "${SYSTEMD:-}" = 1 ] && extra=(--privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock)
  if ! docker run --rm --network host "${extra[@]}" -e ONE_LINER="$ONE" "$image" bash -c '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq curl sudo ca-certificates >/dev/null
    useradd -m -s /bin/bash tester
    echo "tester ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/tester
    printf "export GUILDWISE_YES=1 GUILDWISE_MOCK=1 GUILDWISE_SKIP_CLAUDE=1\n%s\n" "$ONE_LINER" >/home/tester/run.sh
    su - tester -c "bash /home/tester/run.sh"
    # run it again: an upgrade/repair must succeed, keep the pairing and report the spent code instead of failing
    printf "export GUILDWISE_YES=1 GUILDWISE_MOCK=1 GUILDWISE_SKIP_CLAUDE=1\n%s\n" "$ONE_LINER" >/home/tester/run2.sh
    su - tester -c "bash /home/tester/run2.sh" | grep -q "keeping the existing pairing"
    test -f /home/tester/.config/systemd/user/aom-runner.service
  '; then
    echo "FAILED on $image" >&2
    status=1
  fi
done
exit "$status"
