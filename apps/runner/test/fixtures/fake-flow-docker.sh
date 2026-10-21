#!/bin/bash
# A fake of the parts of docker / docker compose that the generated deploy scripts and the probe use, for the e2e journey and the
# tests. It runs on a "server" (inside a throwaway sshd container) and on "this computer" (first on the runner's PATH); each has a
# state folder (FAKE_STATE, default /var/fakedocker):
#   c/<service>        one running container: line 1 its id, line 2 its image, line 3 the project, line 4 the compose file(s)
#   images/<name>      an image that exists here (a name with / : @ is stored with _)
#   calls.log          every call, for the tests
# The compose files are READ (a literal `image:`, the project directory), never written. A real image whose name starts with a
# registry host named in FAKE_REAL_REGISTRY (for example 127.0.0.1:5050) is handed to the real docker: that is how the journey
# talks to its throwaway registry. FAKE_REGISTRY_MAP="127.0.0.1:5050=host.docker.internal:5050" lets a pull on the "server" reach
# that registry from inside the container. Failure switches (files in the state folder): fail-dump, unhealthy, no-pull.
S="${FAKE_STATE:-/var/fakedocker}"
# a fake ssh runs the "server" side with FAKE_SIDE=remote: that side has its own state folder
[ "${FAKE_SIDE:-}" = remote ] && S="${FAKE_STATE_REMOTE:-$S}"
mkdir -p "$S/images" "$S/c" "$S/www"
echo "docker $*" >> "$S/calls.log"

[ -z "${FAKE_REGISTRY_MAP:-}" ] && [ -f "$S/registry-map" ] && FAKE_REGISTRY_MAP=$(cat "$S/registry-map")
real_docker() { PATH="${FAKE_REAL_PATH:-/usr/bin:/bin}" exec docker "$@"; }
if [ -n "${FAKE_REAL_REGISTRY:-}" ]; then
  for a in "$@"; do
    case "$a" in "$FAKE_REAL_REGISTRY"/*) real_docker "$@" ;; esac
  done
fi

img_file() { echo "$S/images/$(printf %s "$1" | tr '/:@' '___')"; }
newid() { head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# the `image:` of a service in a compose file (the first match under the service's name), nothing when there is none
file_image() { # $1 file, $2 service
  awk -v svc="$2" '
    /^services:/ { ins = 1; next }
    ins && /^[^ #]/ { ins = 0 }
    ins && match($0, /^  [A-Za-z0-9._-]+:/) { cur = substr($0, 3, RLENGTH - 3); next }
    ins && cur == svc && /^    image:/ { v = $0; sub(/^    image:[ ]*/, "", v); gsub(/["\x27]/, "", v); print v; exit }
  ' "$1" 2>/dev/null
}
file_build_ctx() { # $1 file, $2 service: build.context or a plain build:
  awk -v svc="$2" '
    /^services:/ { ins = 1; next }
    ins && /^[^ #]/ { ins = 0 }
    ins && match($0, /^  [A-Za-z0-9._-]+:/) { cur = substr($0, 3, RLENGTH - 3); inb = 0; next }
    ins && cur == svc && /^    build:/ { v = $0; sub(/^    build:[ ]*/, "", v); gsub(/["\x27]/, "", v); if (v != "") { print v; exit } inb = 1; next }
    ins && cur == svc && inb && /^      context:/ { v = $0; sub(/^      context:[ ]*/, "", v); gsub(/["\x27]/, "", v); print v; exit }
  ' "$1" 2>/dev/null
}
file_port() { # $1 file, $2 service: the published port of the first `- "X:Y"` under ports:
  awk -v svc="$2" '
    /^services:/ { ins = 1; next }
    ins && /^[^ #]/ { ins = 0 }
    ins && match($0, /^  [A-Za-z0-9._-]+:/) { cur = substr($0, 3, RLENGTH - 3); inp = 0; next }
    ins && cur == svc && /^    ports:/ { inp = 1; next }
    ins && cur == svc && inp && /^      - / { v = $0; sub(/^      - /, "", v); gsub(/["\x27]/, "", v); n = split(v, p, ":"); print (n >= 3 ? p[2] : p[1]); exit }
  ' "$1" 2>/dev/null
}

# which compose files and project this call named
COMPOSE_FILES=(); PROJECT=
parse_compose_args() {
  while [ "${1:-}" = -p ] || [ "${1:-}" = -f ]; do
    if [ "$1" = -p ]; then PROJECT=$2; else COMPOSE_FILES+=("$2"); fi
    shift 2
  done
  REST=("$@")
}
effective_image() { # $1 service: the last file that names an image wins (an override file comes after the compose file)
  local f img out=
  for f in "${COMPOSE_FILES[@]}"; do img=$(file_image "$f" "$1"); [ -n "$img" ] && out=$img; done
  printf %s "$out"
}

serve() { # the app answers /ready on its published port, from a tiny web server (busybox httpd, else python)
  local port=$1
  [ -n "$port" ] || return 0
  if [ -f "$S/www.$port.pid" ]; then kill "$(cat "$S/www.$port.pid")" 2>/dev/null; rm -f "$S/www.$port.pid"; fi
  rm -f "$S/www/ready"
  [ -f "$S/unhealthy" ] || echo ok > "$S/www/ready"
  if command -v httpd >/dev/null 2>&1; then
    httpd -f -p "$port" -h "$S/www" </dev/null >/dev/null 2>&1 &
    echo $! > "$S/www.$port.pid"
  elif command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx httpd; then
    busybox httpd -f -p "$port" -h "$S/www" </dev/null >/dev/null 2>&1 &
    echo $! > "$S/www.$port.pid"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m http.server "$port" --bind 0.0.0.0 --directory "$S/www" </dev/null >/dev/null 2>&1 &
    echo $! > "$S/www.$port.pid"
  fi
  sleep 1
  return 0
}

cmd=${1:-}; shift
case "$cmd" in
  info) exit 0 ;;
  version) echo "29.1.2"; exit 0 ;;
  inspect)
    fmt=; [ "$1" = --format ] && { fmt=$2; shift 2; }
    id=$1
    for f in "$S"/c/*; do
      if [ -f "$f" ] && [ "$(sed -n 1p "$f")" = "$id" ]; then
        case "$fmt" in
          # config_files|working_dir|project|environment_file (the labels `docker compose` writes)
          *Labels*)
            if [ -f "$S/labels" ]; then cat "$S/labels"
            else files=$(sed -n 4p "$f"); echo "$files|$(dirname -- "${files%%,*}")|$(sed -n 3p "$f")|"; fi ;;
          *) sed -n 2p "$f" ;;
        esac
        exit 0
      fi
    done
    exit 1 ;;
  image)
    case "$1" in
      inspect) [ -f "$(img_file "$2")" ] && exit 0 || exit 1 ;;
      ls) for f in "$S"/images/*; do [ -f "$f" ] && cat "$f"; done; exit 0 ;;
      rm) shift; for n in "$@"; do rm -f "$(img_file "$n")"; done; exit 0 ;;
    esac
    exit 0 ;;
  build)
    # this computer: `docker build -t TAG CONTEXT`
    tag=; while [ $# -gt 1 ]; do [ "$1" = -t ] && tag=$2; shift; done
    ctx=$1
    [ -d "$ctx" ] || { echo "build: no such folder $ctx" >&2; exit 1; }
    printf %s "$tag" > "$(img_file "$tag")"
    echo "built $tag from $ctx"; exit 0 ;;
  save)
    [ -f "$(img_file "$1")" ] || { echo "Error: No such image: $1" >&2; exit 1; }
    echo "FAKEIMAGE $1"; head -c 4000 /dev/zero | tr '\0' 'x'; echo; exit 0 ;;
  load)
    first=$(head -n 1); name=${first#FAKEIMAGE }
    cat > /dev/null
    [ "$name" != "$first" ] || { echo "invalid tar header" >&2; exit 1; }
    printf %s "$name" > "$(img_file "$name")"; echo "Loaded image: $name"; exit 0 ;;
  push)
    [ -f "$(img_file "$1")" ] || { echo "An image does not exist locally with the tag: $1" >&2; exit 1; }
    [ -n "${FAKE_REGISTRY_FILE:-}" ] && echo "$1" >> "$FAKE_REGISTRY_FILE"
    echo "pushed $1"; exit 0 ;;
  pull)
    name=$1
    [ -f "$S/no-pull" ] && { echo "Error response from daemon: pull access denied for $name" >&2; exit 1; }
    host=${name%%/*}; rest=${name#*/}; repo=${rest%:*}; tag=${rest##*:}
    to=$host
    if [ -n "${FAKE_REGISTRY_MAP:-}" ] && [ "${FAKE_REGISTRY_MAP%%=*}" = "$host" ]; then to=${FAKE_REGISTRY_MAP#*=}; fi
    if [ -n "${FAKE_REGISTRY_FILE:-}" ]; then
      grep -qx -- "$name" "$FAKE_REGISTRY_FILE" 2>/dev/null || { echo "Error response from daemon: manifest for $name not found" >&2; exit 1; }
      printf %s "$name" > "$(img_file "$name")"; echo "Status: Downloaded newer image for $name"; exit 0
    fi
    wget -q -O /dev/null --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' "http://$to/v2/$repo/manifests/$tag" 2>/dev/null \
      || { echo "Error response from daemon: manifest for $name not found" >&2; exit 1; }
    printf %s "$name" > "$(img_file "$name")"; echo "Status: Downloaded newer image for $name"; exit 0 ;;
  volume) [ "$1" = ls ] && { for f in "$S"/c/*; do [ -f "$f" ] && echo "VOLUME $(basename "$f")_data"; done; }; exit 0 ;;
  ps)
    # the probe's line protocol: CONTAINER\tname\timage\tstate\tstatus\tports\tproject\tservice\tconfig_files\tworking_dir
    for f in "$S"/c/*; do
      [ -f "$f" ] || continue
      svc=$(basename "$f"); proj=$(sed -n 3p "$f"); files=$(sed -n 4p "$f"); port=$(sed -n 5p "$f")
      wd=; [ -n "$files" ] && wd=$(dirname "${files%%,*}")
      ports=; [ -n "$port" ] && ports="0.0.0.0:$port->500/tcp"
      printf 'CONTAINER\t%s\t%s\trunning\tUp 3 days\t%s\t%s\t%s\t%s\t%s\n' "${proj:+$proj-}$svc-1" "$(sed -n 2p "$f")" "$ports" "$proj" "${proj:+$svc}" "$files" "$wd"
    done
    exit 0 ;;
  compose)
    if [ "${1:-}" = version ]; then echo "2.40.0"; exit 0; fi
    parse_compose_args "$@"
    set -- "${REST[@]}"
    action=${1:-}; shift
    first=${COMPOSE_FILES[0]:-}
    case "$action" in
      config)
        if [ "${1:-}" = --services ]; then
          awk '/^services:/ { ins = 1; next } ins && /^[^ #]/ { ins = 0 } ins && match($0, /^  [A-Za-z0-9._-]+:/) { print substr($0, 3, RLENGTH - 3) }' "${COMPOSE_FILES[@]}"; exit 0
        fi
        for f in "${COMPOSE_FILES[@]}"; do [ -f "$f" ] || { echo "no such file: $f" >&2; exit 1; }; done; exit 0 ;;
      ps) [ "${1:-}" = -q ] && shift; svc=${1:-}; [ -f "$S/c/$svc" ] && sed -n 1p "$S/c/$svc"; exit 0 ;;
      build)
        svc=${*: -1}
        ctx=; for f in "${COMPOSE_FILES[@]}"; do c=$(file_build_ctx "$f" "$svc"); [ -n "$c" ] && ctx=$c; done
        img=$(effective_image "$svc")
        [ -n "$ctx" ] && [ -d "$ctx" ] || { echo "build: no build context for $svc" >&2; exit 1; }
        [ -n "$img" ] || { echo "build: no image name for $svc" >&2; exit 1; }
        printf %s "$img" > "$(img_file "$img")"; echo "built $img from $ctx"; exit 0 ;;
      up)
        svc=${*: -1}
        img=$(effective_image "$svc")
        build=0; for a in "$@"; do [ "$a" = --build ] && build=1; done
        if [ "$build" = 1 ]; then
          ctx=; for f in "${COMPOSE_FILES[@]}"; do c=$(file_build_ctx "$f" "$svc"); [ -n "$c" ] && ctx=$c; done
          [ -n "$ctx" ] && printf %s "$img" > "$(img_file "$img")"
        fi
        if [ -n "$img" ] && [ ! -f "$(img_file "$img")" ] && ! [ -f "$S/c/$svc" -a "$(sed -n 2p "$S/c/$svc" 2>/dev/null)" = "$img" ]; then
          echo "pull access denied for $img, repository does not exist or may require 'docker login'" >&2; exit 1
        fi
        port=
        for f in "${COMPOSE_FILES[@]}"; do p=$(file_port "$f" "$svc"); [ -n "$p" ] && port=$p; done
        cur=$(sed -n 2p "$S/c/$svc" 2>/dev/null)
        # a new container only when the image changed (or there was none): the others are never touched
        if [ "$cur" != "$img" ] || [ ! -f "$S/c/$svc" ]; then
          printf '%s\n%s\n%s\n%s\n%s\n' "$(newid)" "$img" "${PROJECT:-$(basename "$(dirname "$first")")}" "$(IFS=,; echo "${COMPOSE_FILES[*]}")" "$port" > "$S/c/$svc"
        fi
        [ -n "$port" ] && serve "$port"
        exit 0 ;;
      exec)
        [ "${1:-}" = -T ] && shift
        svc=$1; shift; shift; shift   # svc, sh, -c
        script=$1
        [ -f "$S/c/$svc" ] || { echo "service $svc is not running" >&2; exit 1; }
        case "$script" in
          *pg_dump*)
            [ -f "$S/fail-dump" ] && { echo "pg_dump: error: connection failed" >&2; exit 1; }
            echo "-- PostgreSQL database dump"
            for i in $(seq 1 14); do echo "-- padding line $i to make the fake dump look like a real one, which is never tiny"; done
            echo "-- PostgreSQL database dump complete"; exit 0 ;;
        esac
        exit 0 ;;
    esac
    exit 0 ;;
  volume) exit 0 ;;
esac
exit 0
