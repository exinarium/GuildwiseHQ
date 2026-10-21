#!/bin/bash
# A tiny fake of the parts of docker / docker compose that `deploy.move` uses, for the tests (a "server" is a state folder):
#   FAKE_STATE   the state folder of this server (default /var/fakedocker, inside a throwaway sshd container)
# State: up-<svc> (running), db.sql (the "database"), images/<name>, port, calls.log. Failure switches (files): fail-dump,
# fail-restore, fail-count (psql cannot answer a count), unhealthy, no-docker-compose. Real tools are never touched.
S="${FAKE_STATE:-/var/fakedocker}"
mkdir -p "$S/images"
echo "docker $*" >> "$S/calls.log"
[ -f "$S/port" ] || echo 3000 > "$S/port"

img_file() { echo "$S/images/$(printf %s "$1" | tr '/:@' '___')"; }

app_image() {
  local f; f=$(cat "$S/last-file" 2>/dev/null) || return 0
  sed -n 's/^SHOP_IMAGE=//p' "$(dirname "$f")/.env" 2>/dev/null | tail -n 1 | tr -d "\"'"
}

stop_http() { command -v pkill >/dev/null 2>&1 && pkill -f 'httpd -p' 2>/dev/null; return 0; }

# a tiny web server answers /ready: busybox's httpd (the sshd test image has it as an applet), when there is one
start_http() {
  if command -v httpd >/dev/null 2>&1; then web=httpd
  elif command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx httpd; then web="busybox httpd"
  else return 0; fi
  mkdir -p "$S/www"
  rm -f "$S/www/ready"
  [ -f "$S/unhealthy" ] || echo ok > "$S/www/ready"
  $web -p "$(cat "$S/port")" -h "$S/www" 2>/dev/null || true
}

cmd=$1; shift
case "$cmd" in
  info) exit 0 ;;
  version) echo "Docker version 26.0.0"; exit 0 ;;
  inspect)
    fmt=; [ "$1" = --format ] && { fmt=$2; shift 2; }
    case "$fmt" in
      *Labels*) f=$(cat "$S/last-file" 2>/dev/null); echo "$f|$(dirname -- "$f")||" ;;
      *Config.Image*) app_image; echo ;;
      *HostPort*) echo "$(cat "$S/port") " ;;
    esac
    exit 0 ;;
  image)
    [ "$1" = inspect ] && { [ -f "$(img_file "$2")" ] && exit 0 || exit 1; }
    exit 0 ;;
  save)
    [ -f "$(img_file "$1")" ] || { echo "Error: No such image: $1" >&2; exit 1; }
    echo "FAKEIMAGE $1"; head -c 4000 /dev/zero | tr '\0' 'x'; echo; exit 0 ;;
  load)
    first=$(head -n 1); name=${first#FAKEIMAGE }
    cat > /dev/null
    [ "$name" != "$first" ] || { echo "invalid tar header" >&2; exit 1; }
    touch "$(img_file "$name")"; echo "Loaded image: $name"; exit 0 ;;
  compose)
    if [ "$1" = version ]; then [ -f "$S/no-docker-compose" ] && exit 1; echo "Docker Compose version v2.20.0"; exit 0; fi
    while [ "$1" = -p ] || [ "$1" = -f ]; do
      [ "$1" = -f ] && echo "$2" > "$S/last-file"
      shift 2
    done
    action=$1; shift
    case "$action" in
      ps) [ "$1" = -q ] && shift; svc=$1; [ -f "$S/up-$svc" ] && echo "cid-$svc"; exit 0 ;;
      up)
        svc=${*: -1}
        if [ "$svc" = app ]; then
          want=$(app_image)
          if [ -n "$want" ] && [ ! -f "$(img_file "$want")" ]; then echo "pull access denied for $want" >&2; exit 1; fi
          touch "$S/up-app"; start_http
        else touch "$S/up-$svc"; fi
        exit 0 ;;
      start) touch "$S/up-$1"; [ "$1" = app ] && start_http; exit 0 ;;
      stop) rm -f "$S/up-$1"; [ "$1" = app ] && stop_http; exit 0 ;;
      exec)
        [ "$1" = -T ] && shift
        svc=$1; shift; shift; shift  # svc, sh, -c
        script=$1; shift; shift      # script, "sh"
        [ -f "$S/up-$svc" ] || { echo "service $svc is not running" >&2; exit 1; }
        case "$script" in
          *pg_isready*) exit 0 ;;
          *pg_dump*)
            [ -f "$S/fail-dump" ] && { echo "pg_dump: error: connection failed" >&2; exit 1; }
            echo "-- PostgreSQL database dump"; cat "$S/db.sql" 2>/dev/null
            for i in $(seq 1 12); do echo "-- padding line $i to make the fake dump look like a real one, which is never tiny"; done
            echo "-- PostgreSQL database dump complete"; exit 0 ;;
          *psql*)
            input=$(cat)
            case "$input" in
              *"select count"*)
                echo "sql: $input" >> "$S/calls.log"
                [ -f "$S/fail-count" ] && { echo "psql: error: connection to server failed" >&2; exit 2; }
                n=$(grep -c '^CREATE TABLE' "$S/db.sql" 2>/dev/null); echo "${n:-0}"; exit 0 ;;
            esac
            [ -f "$S/fail-restore" ] && { echo "ERROR: syntax error" >&2; exit 3; }
            printf '%s\n' "$input" > "$S/db.sql"; exit 0 ;;
        esac
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
