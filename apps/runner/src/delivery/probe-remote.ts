/**
 * The fixed, read-only probe script sent to a server over `ssh <alias> sh -s -- <dirs>` (docs/design/deploy-run-ux-design.md
 * section 6.2). It only reads: no temporary files, nothing is written, started or stopped. Output is a line protocol the runner
 * parses (`probe.ts`); compose files are printed between markers so the runner reduces them to structure and drops the text.
 * `.env` files are never printed: only key names, and the value of a key that names an image (the runner checks its charset).
 */

/**
 * Apps that run directly on the machine (no Docker): running systemd units (system and `--user`) whose working folder is under a
 * home folder, /opt, /srv or /var/www, pm2 processes, listening processes of the same places, and folders that look like apps.
 * Read-only; it prints names, folders, states and ports (the runner shortens and masks the command lines).
 */
export const SERVICES_PROBE_SCRIPT = `
allowed() { case "$1" in "$HOME"/*|/opt/*|/srv/*|/var/www/*|/home/*) return 0 ;; esac; return 1; }
ports_of() { command -v ss >/dev/null 2>&1 || return 0; ss -ltnpH 2>/dev/null | grep "pid=$1," | awk '{print $4}' | sed 's/.*://' | sort -un | tr '\\n' ',' | sed 's/,$//'; }
sd_units() {
  command -v systemctl >/dev/null 2>&1 || return 0
  tag=$2
  systemctl $1 list-units --type=service --state=running --no-legend --plain --no-pager 2>/dev/null | awk '{print $1}' | head -n 80 | while IFS= read -r u; do
    info=$(systemctl $1 show "$u" -p WorkingDirectory -p User -p MainPID -p ExecStart --no-pager 2>/dev/null)
    wd=$(printf '%s\\n' "$info" | sed -n 's/^WorkingDirectory=//p' | head -n 1)
    allowed "$wd" || continue
    usr=$(printf '%s\\n' "$info" | sed -n 's/^User=//p' | head -n 1)
    pid=$(printf '%s\\n' "$info" | sed -n 's/^MainPID=//p' | head -n 1)
    argv=$(printf '%s\\n' "$info" | sed -n 's/^ExecStart=.*argv\\[\\]=\\([^;]*\\);.*/\\1/p' | head -n 1)
    layout=0; [ -d "$(dirname -- "$wd")/releases" ] && layout=1
    printf 'SERVICE\\t%s\\t%s\\trunning\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$tag" "$u" "$wd" "$usr" "$(ports_of "$pid")" "$layout" "$argv"
  done
}
sd_units "" systemd
if [ -n "\${XDG_RUNTIME_DIR:-}" ] || [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  sd_units "--user" systemd_user
fi
if command -v pm2 >/dev/null 2>&1; then
  printf 'PM2JSON\\t%s\\n' "$(pm2 jlist 2>/dev/null | head -c 30000 | tr -d '\\n')"
fi
if command -v ss >/dev/null 2>&1; then
  ss -ltnpH 2>/dev/null | head -n 60 | while read -r st rq sq la pa rest; do
    port=\${la##*:}
    pid=$(printf '%s %s' "$pa" "$rest" | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -n 1)
    [ -n "$pid" ] || continue
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
    allowed "$cwd" || continue
    cmd=$(tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-200)
    [ -n "$cmd" ] || cmd=$(printf '%s' "$rest" | sed -n 's/.*(("\\([^"]*\\)".*/\\1/p')
    printf 'PROCESS\\t%s\\t%s\\t%s\\t%s\\n' "$port" "$pid" "$cwd" "$cmd"
  done
fi
roots="\${AOM_PROBE_APP_ROOTS:-}"; [ -n "$roots" ] || roots="/var/www /srv /opt $HOME/apps $HOME"
for r in $roots; do
  for d in "$r"/*; do
    [ -d "$d" ] || continue
    case "$d" in */.*) continue ;; esac
    for m in package.json requirements.txt pyproject.toml Gemfile composer.json go.mod pom.xml Procfile manage.py releases; do
      if [ -e "$d/$m" ]; then printf 'APPDIR\\t%s\\n' "$d"; break; fi
    done
  done
done 2>/dev/null | head -n 30
`;

export const REMOTE_PROBE_SCRIPT = `set -u
echo "OS $(uname -sm 2>/dev/null)"
echo "UID $(id -u 2>/dev/null)"
if command -v docker >/dev/null 2>&1; then
  echo "DOCKER_VERSION $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  if docker info >/dev/null 2>&1; then echo "DOCKER_USABLE 1"; else echo "DOCKER_USABLE 0"; fi
  cv=$(docker compose version --short 2>/dev/null) || cv=$(docker-compose version --short 2>/dev/null) || cv=
  echo "COMPOSE_VERSION $cv"
  docker ps --all --format 'CONTAINER	{{.Names}}	{{.Image}}	{{.State}}	{{.Status}}	{{.Ports}}	{{.Label "com.docker.compose.project"}}	{{.Label "com.docker.compose.service"}}	{{.Label "com.docker.compose.project.config_files"}}	{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null
  docker volume ls --format 'VOLUME {{.Name}}' 2>/dev/null
else
  echo "DOCKER_MISSING"
fi
safe() { case "$1" in ""|*[!A-Za-z0-9._/+@=-]*) return 1 ;; /*) return 0 ;; *) return 1 ;; esac; }
LABELS=
if command -v docker >/dev/null 2>&1; then
  LABELS=$(docker ps --all --format '{{.Label "com.docker.compose.project.working_dir"}}	{{.Label "com.docker.compose.project.config_files"}}' 2>/dev/null | head -n 60)
fi
DIRS=$(printf '%s\n' "$@")
FILES=
addf() { [ -f "$1" ] && FILES="$FILES
$1"; }
addd() { [ -d "$1" ] && DIRS="$DIRS
$1"; }
for d in "$@"; do for n in docker-compose.yml docker-compose.yaml compose.yaml compose.yml; do addf "$d/$n"; done; done
for f in /opt/*/docker-compose.y*ml /opt/*/compose.y*ml /srv/*/docker-compose.y*ml /srv/*/compose.y*ml; do addf "$f"; done
for f in "$HOME"/*/docker-compose.y*ml "$HOME"/*/compose.y*ml "$HOME"/*/*/docker-compose.y*ml "$HOME"/*/*/compose.y*ml; do
  if safe "$f" && [ -f "$f" ]; then FILES="$FILES
$f"; DIRS="$DIRS
\${f%/*}"; fi
done
OLDIFS=$IFS
IFS='
'
for l in $LABELS; do
  wd=\${l%%	*}
  cf=\${l#*	}
  if safe "$wd" && [ -d "$wd" ]; then
    DIRS="$DIRS
$wd"
    for n in docker-compose.yml docker-compose.yaml compose.yaml compose.yml; do addf "$wd/$n"; done
  fi
  IFS=,
  for f in $cf; do
    if safe "$f" && [ -f "$f" ]; then FILES="$FILES
$f"; DIRS="$DIRS
\${f%/*}"; fi
  done
  IFS='
'
done
DIRS=$(printf '%s\n' "$DIRS" | awk 'NF && !seen[$0]++' | head -n 16)
FILES=$(printf '%s\n' "$FILES" | awk 'NF && !seen[$0]++' | head -n 16)
for r in "/opt/*" "/srv/*" "$HOME/*" "$HOME/*/*"; do echo "CHECKED $r"; done
for d in $DIRS; do echo "CHECKED $d"; done
for f in $FILES; do echo "COMPOSEFILE $f"; done
for d in $DIRS; do
  if [ -d "$d" ]; then
    echo "DIR $d"
    ls -1 "$d" 2>/dev/null | head -n 40 | while IFS= read -r e; do echo "ENTRY $d	$e"; done
    if [ -f "$d/.env" ]; then
      sed -n 's/^[[:space:]]*\\(export[[:space:]]\\{1,\\}\\)\\{0,1\\}\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\2/p' "$d/.env" | head -n 100 | while IFS= read -r k; do echo "ENVKEY $d	$k"; done
      sed -n 's/^\\([A-Z_][A-Z0-9_]*IMAGE[A-Z0-9_]*\\)=\\(.*\\)$/\\1\\t\\2/p' "$d/.env" | head -n 10 | while IFS="	" read -r k v; do echo "IMAGEVAR $d	$k	$v"; done
    fi
    if [ -d "$d/backups" ]; then
      echo "BACKUPS $d/backups	$(ls -1 "$d/backups" 2>/dev/null | wc -l)"
      n=$(ls -1t "$d/backups" 2>/dev/null | head -n 1)
      [ -n "$n" ] && echo "NEWEST $d/backups	$n	$(date -r "$d/backups/$n" +%Y-%m-%dT%H:%M:%S 2>/dev/null)"
    fi
    [ -f "$d/Caddyfile" ] && sed -n 's/^\\([^[:space:]#{}][^[:space:]{}]*\\)[[:space:]]*{[[:space:]]*$/\\1/p' "$d/Caddyfile" | head -n 20 | while IFS= read -r s; do echo "SITE caddy	$s"; done
    echo "DISK $(df -Pm "$d" 2>/dev/null | tail -n 1 | awk '{print $4}')"
  else
    echo "NODIR $d"
  fi
done
for f in /opt/*/Caddyfile /srv/*/Caddyfile /etc/caddy/Caddyfile; do
  [ -f "$f" ] && sed -n 's/^\\([^[:space:]#{}][^[:space:]{}]*\\)[[:space:]]*{[[:space:]]*$/\\1/p' "$f" | head -n 20 | while IFS= read -r s; do echo "SITE caddy	$s"; done
done
grep -rhoE 'server_name[[:space:]]+[^;]+' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sed 's/server_name[[:space:]]*//' | head -n 20 | while IFS= read -r s; do echo "SITE nginx	$s"; done
for u in caddy nginx traefik; do
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$u" 2>/dev/null; then echo "SYSTEMD $u"; fi
done
if command -v ss >/dev/null 2>&1; then
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':(80|443)$' | sed 's/.*://' | sort -u | while IFS= read -r p; do echo "LISTEN $p"; done
fi
IFS=$OLDIFS
for f in $FILES; do
  echo "@@COMPOSE $f"
  head -c 200000 "$f" 2>/dev/null
  echo
  echo "@@ENDCOMPOSE"
done
${SERVICES_PROBE_SCRIPT}
echo "@@DONE"
`;
