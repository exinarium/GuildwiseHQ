#!/bin/bash
echo "docker $*" >> "$FAKE_ROOT/calls.log"
side="${FAKE_SIDE:-local}"
S="$FAKE_ROOT/state-$side"; mkdir -p "$S"
forbid() { echo "docker $*" >> "$FAKE_ROOT/forbidden.log"; }
args=("$@")
case "$*" in
  *" down"*|*" rm "*|*" stop"*|*" kill"*|*" -v"*|*"--remove-orphans"*|*"prune"*) case "$*" in "image rm "*) ;; *) forbid "$@" ;; esac ;;
esac
# strip global compose options
if [ "$1" = compose ]; then
  # like the real labels: the first -f file is the one the stack was started from
  for ((i=0;i<${#args[@]};i++)); do
    if [ "${args[$i]}" = "-f" ]; then echo "${args[$((i+1))]}" > "$S/first-file"; break; fi
  done
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      -p|-f) shift 2 ;;
      *) break ;;
    esac
  done
  # the override files are visible while the command runs
  all=("${args[@]}")
  for ((i=0;i<${#all[@]};i++)); do
    if [ "${all[$i]}" = "-f" ] && [[ "${all[$((i+1))]}" == */override.yml || "${all[$((i+1))]}" == */rollback.yml ]]; then
      cp "${all[$((i+1))]}" "$FAKE_ROOT/$(basename "${all[$((i+1))]}")" 2>/dev/null
    fi
  done
  case "$1" in
    version)
      # a server with only the old docker-compose program: `docker compose` is not there, `docker-compose` (via the wrapper) is
      if [ -f "$FAKE_ROOT/v1only" ] && [ -z "${FAKE_VIA_V1:-}" ] && [ "$side" = remote ]; then echo "docker: 'compose' is not a docker command." >&2; exit 1; fi
      echo 2.40.0 ;;
    config) if [ "${2:-}" = --services ]; then printf 'postgres\napp\nmailpit\n'; fi ;;
    ps) [ "${2:-}" = -q ] && { case "$3" in app) [ -f "$S/running" ] && echo cid-app ;; postgres) echo cid-pg ;; esac; } ;;
    exec)
      # like the real thing, `exec -T` reads standard input: anything it finds there is gone
      cat >/dev/null
      [ -f "$FAKE_ROOT/backup-fails" ] && { echo "pg_dump: error" >&2; exit 1; }
      head -c "${FAKE_DUMP_BYTES:-4000}" /dev/zero | tr '\0' 'x' ;;
    up)
      if [ -f "$FAKE_ROOT/up-fails" ]; then echo "up failed" >&2; exit 1; fi
      if [ -f "$FAKE_ROOT/up-fails-once" ]; then rm -f "$FAKE_ROOT/up-fails-once"; echo "up failed" >&2; exit 1; fi
      if [ -f "$FAKE_ROOT/up-hangs-once" ]; then rm -f "$FAKE_ROOT/up-hangs-once"; touch "$FAKE_ROOT/up-hanging"; /bin/sleep 30; fi
      echo "$*" >> "$FAKE_ROOT/up.log"
      if [[ "$*" == *rollback* ]]; then :; fi
      # the new image is the one in the override file, if any
      img=$(sed -n 's/.*image: "\(.*\)"/\1/p' "$FAKE_ROOT/override.yml" 2>/dev/null | tail -n 1)
      if [ -f "$FAKE_ROOT/rollback.yml" ] && [[ "$*" == *--no-build* ]]; then img=$(sed -n 's/.*image: "\(.*\)"/\1/p' "$FAKE_ROOT/rollback.yml" | tail -n 1); fi
      if [ -z "$img" ]; then img=$(sed -n 's/^\(export \)\{0,1\}GUILDWISE_IMAGE=//p' "$PWD/.env" 2>/dev/null | tail -n 1 | tr -d '\r"' | sed 's/ *#.*//'); fi
      echo "$img" > "$S/running"
      echo "$img" >> "$FAKE_ROOT/up-images.log" ;;
    *) ;;
  esac
  exit 0
fi
case "$1" in
  version) echo 29.1.2 ;;
  info) exit 0 ;;
  inspect)
    case "$*" in
      *Labels*)
        # config_files|working_dir|project|environment_file; a test can write its own line to $FAKE_ROOT/labels
        if [ -f "$FAKE_ROOT/labels" ]; then cat "$FAKE_ROOT/labels"
        else f=$(cat "$S/first-file" 2>/dev/null); echo "$f|$(dirname -- "$f")||"; fi ;;
      *) cat "$S/running" 2>/dev/null ;;
    esac ;;
  image)
    case "$2" in
      inspect) if [ -f "$S/image-$3" ]; then exit 0; else exit 1; fi ;;
      ls) [ -f "$FAKE_ROOT/tags" ] && cat "$FAKE_ROOT/tags" ;;
      rm) echo "$3" >> "$FAKE_ROOT/removed.log" ;;
    esac ;;
  build) touch "$S/image-$3" 2>/dev/null; touch "$FAKE_ROOT/built-$4"; shift; [ "$1" = -t ] && touch "$S/image-$2" ;;
  save) echo "$2" > "$FAKE_ROOT/saved-tag"; echo IMAGEDATA ;;
  load) cat >/dev/null; t=$(cat "$FAKE_ROOT/saved-tag"); touch "$S/image-$t" ;;
esac
exit 0
