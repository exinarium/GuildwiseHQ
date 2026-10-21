import type { DeliverySetup, DeployStep, SetupEnv } from './setup.ts';
import {
  commitChecks,
  commonFunctions,
  curlCheck,
  doneFunction,
  header,
  healthFunctions,
  healthUrlCheck,
  lines,
  lockBlock,
  pathWord,
  sh,
  shq,
  sshHelpers,
  stepNumberComment,
  urlWord,
} from './setup-compile.ts';

/**
 * The script of an environment that runs DIRECTLY on a machine (no Docker): `<appDir>/releases/<12 characters of the commit>`
 * folders, a symlink (`current`) to the one that runs, and a restart by the manager the app was found with (systemd, pm2 or a
 * command of the person's own). The same script shape runs on this computer and, over ssh, on a server: the small scripts that
 * touch the machine are sent to it the same way (`remote`).
 *
 * Safety: nothing outside `<appDir>` is written, only the app is restarted, `sudo` is used only when the person confirmed it
 * (`sudo -n`, never a prompt), a release folder is removed only when it is neither the running one nor the one before it, and a
 * plain folder at the link's place is moved (never deleted) only when the person confirmed turning it into the first release.
 */

const QUIET = 'AOM_REMOTE';

/**
 * A POSIX shell function `aom_state_paths DIR`: the paths (relative to DIR, at most 20, depth 3) that look like data the app
 * writes itself: sqlite files, upload/storage/data/log folders, `.env` files and `*.log` files. The same words are used by the
 * probe (to flag them) and by the first update of a plain folder (to refuse when they are not marked shared).
 */
export const STATE_PATHS_FN = String.raw`aom_state_paths() {
  find "$1" -maxdepth 3 \( -name node_modules -o -name .git -o -name releases -o -name vendor -o -name .venv -o -name venv \) -prune -o \
    \( -type d \( -name uploads -o -name storage -o -name data -o -name logs -o -name log \) -print -prune \) -o \
    \( -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.log' -o -name '.env' -o -name '.env.*' \) ! -name '*.example' ! -name '*.sample' ! -name '*.dist' -print \) 2>/dev/null |
    awk -v p="$1/" 'index($0, p) == 1 { print substr($0, length(p) + 1) }' | LC_ALL=C sort -u |
    awk '{ for (i = 1; i <= n; i++) if (index($0, a[i] "/") == 1) next; a[++n] = $0; print }' | head -n 20
}`;

function localRemote(): string[] {
  return [
    '# a small script, run on this computer with these arguments as $1 $2 ... (the same shape as on a server)',
    'remote() {',
    '  local s',
    '  s="$(cat)"',
    '  # fd 9 is the deploy lock: nothing this starts (a restart that leaves a background process behind) may keep it',
    '  bash -c "$s" aom-direct "$@" </dev/null 9>&-',
    '}',
    'put_tar() { mkdir -p -- "$1" && tar -x -f - -C "$1"; }',
    '',
  ];
}

function sshPut(): string[] {
  return ['put_tar() { rsh "mkdir -p --$(rquote "$1") && tar -x -f - -C$(rquote "$1")"; }', ''];
}

/** The shell words of the manager and a small function that restarts the app (or only checks it can, in a dry run). */
function managerFunctions(env: SetupEnv): string[] {
  const m = env.direct?.manager;
  if (!m) return [];
  const restartArgs = m.kind === 'command' ? m.restart.map(shq).join(' ') : '';
  return [
    '# restart only the app, the way it was found (never any other service)',
    'restart_app() {',
    `  remote "$MANAGER" "$UNIT" "$SCOPE" "$USE_SUDO" "$PM2_NAME" "$1" ${restartArgs} <<'${QUIET}'`,
    'set -eu',
    'mgr=$1; unit=$2; scope=$3; use_sudo=$4; pm=$5; dry=$6; shift 6',
    'S=',
    '[ "$use_sudo" = 1 ] && S=sudo',
    'run() { if [ -n "$S" ]; then sudo -n "$@"; else "$@"; fi; }',
    'case "$mgr" in',
    '  systemd)',
    '    sc=systemctl',
    '    if [ "$scope" = user ]; then',
    '      export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    '      sc="systemctl --user"; S=',
    '    fi',
    '    if [ "$dry" = 1 ]; then',
    '      if [ "$scope" = user ]; then',
    '        $sc show-environment >/dev/null 2>&1 || { echo "AOM: systemctl --user does not work for this user here (no user session is running), so $unit cannot be restarted" >&2; exit 67; }',
    '      fi',
    '      [ "$($sc show -p LoadState --value "$unit" 2>/dev/null)" = loaded ] || { echo "AOM: the service $unit is not known to systemd on this machine" >&2; exit 61; }',
    '      if [ -n "$S" ]; then sudo -n -l systemctl restart "$unit" >/dev/null 2>&1 || { echo "AOM: restarting $unit needs sudo, and sudo asks for a password here, or does not allow this command without one" >&2; exit 62; }; fi',
    '      echo "would restart only $unit" >&2; exit 0',
    '    fi',
    '    run $sc restart "$unit" ;;',
    '  pm2)',
    '    case "$pm" in [Aa][Ll][Ll]) echo "AOM: the pm2 name \\"all\\" would restart every process" >&2; exit 66 ;; esac',
    '    case "$pm" in *[!0-9]*) ;; *) echo "AOM: a pm2 name made of digits only is read as a process number" >&2; exit 66 ;; esac',
    '    command -v pm2 >/dev/null 2>&1 || { echo "AOM: pm2 is not installed for this user" >&2; exit 63; }',
    '    if [ "$dry" = 1 ]; then pm2 describe "$pm" >/dev/null 2>&1 || { echo "AOM: pm2 has no process called $pm" >&2; exit 64; }; echo "would restart only $pm" >&2; exit 0; fi',
    '    pm2 restart "$pm" ;;',
    '  command)',
    '    case "$1" in -*) echo "AOM: the restart command must start with a program, not an option" >&2; exit 65 ;; esac',
    '    if [ "$dry" = 1 ]; then',
    '      if [ -n "$S" ]; then sudo -n -l "$@" >/dev/null 2>&1 || { echo "AOM: the restart command needs sudo, and sudo asks for a password here, or does not allow this command without one" >&2; exit 62; }; fi',
    '      command -v -- "$1" >/dev/null 2>&1 || { echo "AOM: the restart program $1 was not found" >&2; exit 65; }',
    '      echo "would run the restart command" >&2; exit 0',
    '    fi',
    '    run "$@" ;;',
    '  *) echo "AOM: unknown manager" >&2; exit 66 ;;',
    'esac',
    QUIET,
    '}',
    '',
    '# point the link at a release folder in one step (a temporary link is moved over it)',
    'set_link() {',
    '  remote "$CURRENT_LINK" "$1" <<\'AOM_REMOTE\'',
    'set -eu',
    'link=$1; target=$2',
    'tmp="$link.aom-new.$$"',
    `trap 'rm -f -- "$tmp"' EXIT`,
    'ln -s -- "$target" "$tmp"',
    'if mv -T -- "$tmp" "$link" 2>/dev/null; then :; else ln -sfn -- "$target" "$link"; fi',
    'echo "current now points at $target" >&2',
    QUIET,
    '}',
    '',
    ...sharedFunctions(env),
    ...adoptFunctions(env),
  ];
}

/** The same-disk and mounted-inside checks of turning a folder into the first release (shell lines for a remote script). */
const DEVICE_CHECK = [
  'dev() { stat -c %d -- "$1" 2>/dev/null || stat -f %d -- "$1"; }',
  'up="$app/releases"; while [ ! -e "$up" ]; do up=$(dirname -- "$up"); done',
  '[ "$(dev "$link")" = "$(dev "$up")" ] || { echo "AOM: $link is on a different disk than $app, and a move between disks is a copy that the running app would see half of. Choose an app folder on the same disk as $link." >&2; exit 92; }',
  'if [ -r /proc/mounts ] && awk -v p="$link/" \'index($2, p) == 1 { f = 1 } END { exit !f }\' /proc/mounts; then echo "AOM: another disk is mounted inside $link, so the folder cannot be moved in one step" >&2; exit 93; fi',
];

/** Shared files: linked into the new release before the build when they exist, copied from the running version at switch time. */
function sharedFunctions(env: SetupEnv): string[] {
  const shared = env.direct?.shared ?? [];
  if (!shared.length) return [];
  const args = shared.map(shq).join(' ');
  return [
    '# shared files that already exist are linked into the new release (so the build can see them)',
    'link_shared() {',
    `  remote "$APP_DIR" "$RELEASE" ${args} <<'${QUIET}'`,
    'set -eu',
    'app=$1; rel=$2; shift 2',
    'for p in "$@"; do',
    '  case "$p" in /*|*..*) echo "AOM: a shared path must stay inside the app folder" >&2; exit 81 ;; esac',
    '  [ -e "$app/shared/$p" ] || continue',
    '  mkdir -p -- "$rel/$(dirname -- "$p")"',
    '  rm -rf -- "${rel:?}/$p"',
    '  ln -s -- "$app/shared/$p" "$rel/$p"',
    'done',
    QUIET,
    '}',
    '',
    '# At switch time (not earlier, so what is copied is what runs now): a shared path that is not in $APP_DIR/shared yet is copied from',
    '# the running version; a sqlite database is copied with sqlite3 .backup (a plain copy of a database in use can be torn). $1 = 1: only check.',
    'sync_shared() {',
    `  remote "$APP_DIR" "$RELEASE" "$CURRENT_LINK" "$1" ${args} <<'${QUIET}'`,
    'set -eu',
    'app=$1; rel=$2; cur=$3; dry=$4; shift 4',
    'for p in "$@"; do',
    '  case "$p" in /*|*..*) echo "AOM: a shared path must stay inside the app folder" >&2; exit 81 ;; esac',
    'done',
    String.raw`dbfind() { find "$1" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) 2>/dev/null; }`,
    'is_db() { case "$1" in *.db|*.sqlite|*.sqlite3) return 0 ;; esac; return 1; }',
    'need_sqlite=0',
    'for p in "$@"; do',
    '  [ ! -e "$app/shared/$p" ] || continue',
    '  [ -e "$cur/$p" ] || { echo "AOM: the shared file $p does not exist in $app/shared yet and the running version has none to copy" >&2; exit 82; }',
    '  if is_db "$p"; then need_sqlite=1; elif [ -d "$cur/$p" ] && [ -n "$(dbfind "$cur/$p" | head -n 1)" ]; then need_sqlite=1; fi',
    'done',
    'if [ "$need_sqlite" = 1 ] && ! command -v sqlite3 >/dev/null 2>&1; then',
    '  echo "AOM: a database file would be copied while the app runs, and sqlite3 is not installed to copy it safely. Install sqlite3, or put the file into $app/shared by hand while the app is stopped." >&2',
    '  exit 83',
    'fi',
    '[ "$dry" = 1 ] && exit 0',
    'copy_db() { sqlite3 "$1" ".backup \'$2.aom-part\'" </dev/null && mv -- "$2.aom-part" "$2"; }',
    'for p in "$@"; do',
    '  if [ ! -e "$app/shared/$p" ]; then',
    '    mkdir -p -- "$app/shared/$(dirname -- "$p")"',
    '    if is_db "$p"; then',
    '      copy_db "$cur/$p" "$app/shared/$p" || { rm -f -- "$app/shared/$p.aom-part"; echo "AOM: could not copy the database $p safely" >&2; exit 84; }',
    '    else',
    '      cp -a -- "$cur/$p" "$app/shared/$p"',
    '      if [ -d "$cur/$p" ]; then',
    '        dbfind "$cur/$p" | while IFS= read -r f; do',
    '          r=${f#"$cur/$p"/}',
    '          rm -f -- "$app/shared/$p/$r" "$app/shared/$p/$r-wal" "$app/shared/$p/$r-shm"',
    '          copy_db "$f" "$app/shared/$p/$r" || { echo "AOM: could not copy the database $p/$r safely" >&2; exit 84; }',
    '        done',
    '      fi',
    '    fi',
    '  fi',
    '  mkdir -p -- "$rel/$(dirname -- "$p")"',
    '  rm -rf -- "${rel:?}/$p"',
    '  ln -s -- "$app/shared/$p" "$rel/$p"',
    'done',
    QUIET,
    '}',
    '',
  ];
}

/** Turning a plain folder into the first release: what is checked first, and how an interrupted move is undone. */
function adoptFunctions(env: SetupEnv): string[] {
  const d = env.direct;
  if (!d?.adoptFolder) return [];
  const shared = d.shared.map(shq).join(' ');
  return [
    "# before a plain folder is moved: same disk, nothing mounted inside, and nothing that looks like the app's own data left out of the shared files",
    'adopt_preflight() {',
    '  local found',
    `  found="$(remote "$APP_DIR" "$CURRENT_LINK"${shared ? ` ${shared}` : ''} <<'${QUIET}'`,
    'set -eu',
    STATE_PATHS_FN,
    'app=$1; link=$2; shift 2',
    ...DEVICE_CHECK,
    'aom_state_paths "$link" | while IFS= read -r p; do',
    '  covered=0',
    '  for s in "$@"; do case "$p" in "$s"|"$s"/*) covered=1 ;; esac; done',
    '  [ "$covered" = 1 ] || printf \'%s\\n\' "$p"',
    'done',
    QUIET,
    '  )" || die "the folder $CURRENT_LINK cannot be turned into the first release; nothing was changed"',
    '  if [ -n "$found" ]; then',
    "    found=\"$(printf '%s' \"$found\" | LC_ALL=C tr -c 'A-Za-z0-9._/+@=\\n-' '?' | tr '\\n' ' ')\"",
    '    die "these look like data the app keeps itself, and they are not marked as shared: $found. Mark them as shared files in the setup first (otherwise the new version would start with empty copies); nothing was changed"',
    '  fi',
    '}',
    '',
    '# an interrupted move: the folder goes back to its own place (only the link made by Guildwise is removed)',
    'undo_adopt() {',
    `  remote "$APP_DIR" "$CURRENT_LINK" <<'${QUIET}'`,
    'set -eu',
    'app=$1; link=$2; init="$app/releases/initial"',
    'if [ -d "$init" ] && [ ! -L "$init" ]; then',
    '  if [ -L "$link" ]; then rm -f -- "$link"; fi',
    '  if [ ! -e "$link" ]; then mv -- "$init" "$link"; echo "the folder $link is back in its place" >&2; fi',
    'fi',
    QUIET,
    '}',
    '',
  ];
}

function directStep(s: DeployStep, i: number, env: SetupEnv): string[] {
  const d = env.direct;
  if (!d) return [`die "this environment has no settings for an app that runs directly"`];
  switch (s.kind) {
    case 'direct_db_backup': {
      const dir = env.hosting === 'ssh' ? shq(s.dir) : pathWord(s.dir);
      const file = s.sqliteFile ? (env.hosting === 'ssh' ? shq(s.sqliteFile) : pathWord(s.sqliteFile)) : "''";
      return [
        ...stepNumberComment(i, 'back up the database'),
        `BACKUP_DIR=${dir}`,
        `DB_ENGINE=${shq(s.engine)}`,
        `DB_NAME=${shq(s.database ?? '')}`,
        `DB_FILE=${file}`,
        `KEEP_BACKUPS=${s.keep}`,
        `BACKUP_FILE="$(remote "$DB_ENGINE" "$DB_NAME" "$DB_FILE" "$BACKUP_DIR" "$ENV_NAME" "$SHORT" "$KEEP_BACKUPS" "$DRY_RUN" <<'${QUIET}'`,
        'set -euo pipefail',
        'engine=$1; db=$2; file=$3; bdir=$4; env=$5; short=$6; keep=$7; dry=$8',
        'case "$engine" in',
        '  postgres) command -v pg_dump >/dev/null 2>&1 || { echo "AOM: pg_dump is not installed on this machine" >&2; exit 71; } ;;',
        '  mysql) command -v mysqldump >/dev/null 2>&1 || { echo "AOM: mysqldump is not installed on this machine" >&2; exit 72; } ;;',
        '  sqlite) command -v sqlite3 >/dev/null 2>&1 || { echo "AOM: sqlite3 is not installed, so a safe copy of the database cannot be made" >&2; exit 73; }',
        '          [ -f "$file" ] || { echo "AOM: there is no database file $file" >&2; exit 74; } ;;',
        'esac',
        'if [ "$dry" = 1 ]; then echo "would: back up the $engine database to $bdir, keeping the newest $keep" >&2; exit 0; fi',
        'umask 077',
        'mkdir -p -- "$bdir"',
        'out="$bdir/$env-before-$short-$(date +%Y%m%d-%H%M%S).sql.gz"',
        'min=200',
        'case "$engine" in',
        '  postgres) pg_dump "$db" </dev/null | gzip > "$out.part" || { rm -f -- "$out.part"; echo "AOM: the database backup failed" >&2; exit 75; } ;;',
        '  mysql) mysqldump --single-transaction "$db" </dev/null | gzip > "$out.part" || { rm -f -- "$out.part"; echo "AOM: the database backup failed" >&2; exit 75; } ;;',
        '  sqlite) min=40; sqlite3 -readonly "$file" .dump </dev/null | gzip > "$out.part" || { rm -f -- "$out.part"; echo "AOM: the database backup failed" >&2; exit 75; } ;;',
        'esac',
        'if [ "$(gzip -dc "$out.part" | wc -c)" -lt "$min" ]; then rm -f -- "$out.part"; echo "AOM: the database backup is too small to be real" >&2; exit 76; fi',
        'mv -- "$out.part" "$out"',
        '[ -s "$out" ] || { echo "AOM: the database backup file is missing after it was saved" >&2; exit 77; }',
        'if [ "$keep" -gt 0 ]; then',
        sh`  ls -1t -- "$bdir"/"$env"-before-*.sql.gz 2>/dev/null | tail -n +$((keep + 1)) | while IFS= read -r old; do rm -f -- "$old"; done || true`,
        'fi',
        `printf '%s\\n' "$out"`,
        QUIET,
        `)" || die "the database backup failed; nothing was changed"`,
        '[ "$DRY_RUN" = 1 ] || [ -n "$BACKUP_FILE" ] || die "the database backup did not report a file; nothing was changed"',
        '[ "$DRY_RUN" = 1 ] || say "backup saved: $BACKUP_FILE"',
      ];
    }
    case 'direct_prepare':
      return [
        ...stepNumberComment(i, 'put the approved version in its own new folder and build it there'),
        'RELEASE="$APP_DIR/releases/$SHORT"',
        'if remote "$RELEASE" <<\'AOM_REMOTE\' >/dev/null 2>&1',
        '[ -f "$1/.aom-complete" ]',
        QUIET,
        'then',
        '  say "the files of $SHORT are already in $RELEASE"',
        'elif [ "$DRY_RUN" = 1 ]; then',
        '  would "copy the approved version to $RELEASE and build it there; the running app is not touched"',
        'else',
        '  [ -d "$CHECKOUT" ] || die "AOM_DEPLOY_CHECKOUT is not a folder"',
        '  git -C "$CHECKOUT" rev-parse --git-dir >/dev/null 2>&1 || die "the approved files are not a git checkout, so they cannot be sent safely (a plain folder can hold settings and secrets that are not part of the version); nothing was changed"',
        '  git -C "$CHECKOUT" archive --format=tar "$COMMIT" | put_tar "$RELEASE"',
        ...(d.shared.length
          ? [
              '  # shared files that exist already are linked in now; the rest is copied at the switch, from what runs then',
              '  link_shared',
            ]
          : []),
        ...d.build.flatMap((b, n) => [
          `  say ${shq(`build step ${n + 1}: ${b.label.replace(/[\r\n]+/g, ' ')}`)}`,
          `  remote "$RELEASE" ${b.argv.map(shq).join(' ')} <<'${QUIET}' || die ${shq(`the build step "${b.label.replace(/["\r\n]+/g, ' ')}" failed; the running app was not touched`)}`,
          'set -eu',
          'rel=$1; shift',
          'cd "$rel"',
          'exec bash -lc \'exec "$@"\' aom-build "$@"',
          QUIET,
        ]),
        '  remote "$RELEASE" <<\'AOM_REMOTE\'',
        'touch "$1/.aom-complete"',
        QUIET,
        'fi',
      ];
    case 'direct_switch':
      return [
        ...stepNumberComment(i, 'switch to the new version and restart only the app'),
        'if [ "$DRY_RUN" = 1 ]; then',
        '  would "point $CURRENT_LINK at $RELEASE (now: ${PREVIOUS_TARGET:-nothing}) and restart only $UNIT_LABEL"',
        '  [ "$LINK_KIND" != folder ] || [ "$ADOPT" = 1 ] || die "$CURRENT_LINK is a plain folder; confirm in the setup that its first update may turn it into the first release"',
        ...(d.adoptFolder ? ['  [ "$LINK_KIND" != folder ] || adopt_preflight'] : []),
        ...(d.shared.length ? ['  sync_shared 1'] : []),
        '  restart_app 1',
        'else',
        ...(d.shared.length ? ['  sync_shared 0'] : []),
        '  if [ "$LINK_KIND" = folder ]; then',
        '    [ "$ADOPT" = 1 ] || die "$CURRENT_LINK is a plain folder; confirm in the setup that its first update may turn it into the first release"',
        ...(d.adoptFolder
          ? [
              '    adopt_preflight',
              '    # from here an interruption puts the folder back where it was',
              '    PREVIOUS_TARGET="$APP_DIR/releases/initial"',
              '    SWITCHED=1',
              '    ADOPT_STARTED=1',
              '    remote "$APP_DIR" "$CURRENT_LINK" <<\'AOM_REMOTE\'',
              'set -eu',
              'app=$1; link=$2',
              'mkdir -p -- "$app/releases"',
              ...DEVICE_CHECK,
              '[ ! -e "$app/releases/initial" ] || { echo "AOM: $app/releases/initial exists already" >&2; exit 91; }',
              'mv -- "$link" "$app/releases/initial"',
              'ln -s -- "$app/releases/initial" "$link"',
              'echo "the folder $link is now the first release: $app/releases/initial" >&2',
              QUIET,
              '    ADOPT_DONE=1',
            ]
          : []),
        '  fi',
        '  SWITCHED=1',
        '  FLIPPED=1',
        '  set_link "$RELEASE"',
        '  restart_app 0 || { RESTART_FAILED=1; die "restarting $UNIT_LABEL failed; the previous version is put back"; }',
        'fi',
      ];
    case 'custom_command':
      return [
        ...stepNumberComment(i, s.label),
        'if [ "$DRY_RUN" = 1 ]; then',
        `  would ${shq(s.label)}`,
        'else',
        `  ${s.argv.map(shq).join(' ')}`,
        'fi',
      ];
    default:
      return [
        `# step ${i + 1}: ${s.kind} is not available for an app that runs directly`,
        'die "this step is not available here"',
      ];
  }
}

export function directScript(setup: DeliverySetup, env: SetupEnv): string {
  const d = env.direct;
  const server = env.hosting === 'ssh';
  const out: Array<string | null> = [...header(setup, env)];
  const m = d?.manager;
  const appDir = d?.appDir ?? '/';
  const link = d?.currentLink ?? `${appDir}/current`;
  const path = (p: string) => (server ? shq(p) : pathWord(p));
  out.push(
    `ENV_NAME=${shq(env.name)}`,
    `IMAGE=${shq(env.app.imageName)}`,
    `UNIT_LABEL=${shq(m?.kind === 'systemd' ? m.unit : m?.kind === 'pm2' ? m.name : 'the app')}`,
    `APP_DIR=${path(appDir)}`,
    `CURRENT_LINK=${path(link)}`,
    `KEEP_RELEASES=${d?.keep ?? 5}`,
    `ADOPT=${d?.adoptFolder ? 1 : 0}`,
    `MANAGER=${shq(m?.kind ?? '')}`,
    `UNIT=${shq(m?.kind === 'systemd' ? m.unit : '')}`,
    `SCOPE=${shq(m?.kind === 'systemd' ? m.scope : '')}`,
    `USE_SUDO=${m && m.kind !== 'pm2' && m.sudo && !(m.kind === 'systemd' && m.scope === 'user') ? 1 : 0}`,
    `PM2_NAME=${shq(m?.kind === 'pm2' ? m.name : '')}`,
    env.health.kind === 'http' ? `HEALTH_URL=${urlWord(env.health.url)}` : null,
    `HEALTH_TIMEOUT=${env.healthTimeoutSec}`,
    '',
  );
  out.push(...commonFunctions());
  out.push(...healthFunctions(env));
  out.push(...doneFunction());
  out.push(
    ...commitChecks(),
    ...healthUrlCheck(env),
    ...lockBlock(`${env.app.imageName}-${env.name}`),
    '',
    ...curlCheck(env),
  );
  if (server) {
    out.push(...sshHelpers());
    out.push(...sshPut());
    out.push(
      `rsh 'true' </dev/null || die "cannot sign in to $HOST without a password: check the sign-in of this computer"`,
    );
  } else {
    out.push(
      sh`case "$CHECKOUT" in /*) ;; *) die "AOM_DEPLOY_CHECKOUT must be a full path" ;; esac`,
      ...localRemote(),
    );
  }
  out.push(
    ...managerFunctions(env),
    "# what runs now: where the link points, or what is at the link's place",
    `STATE="$(remote "$APP_DIR" "$CURRENT_LINK" <<'${QUIET}'`,
    'set -eu',
    'dir=$1; link=$2',
    "# the real places: ~ is this user's home, and the folder is named by where it really is (so that what is compared and removed later is the same)",
    'case "$dir" in "~/"*) dir="$HOME/${dir#"~/"}" ;; esac',
    'case "$link" in "~/"*) link="$HOME/${link#"~/"}" ;; esac',
    'canon() { if [ -d "$1" ]; then (cd -P -- "$1" && pwd -P); else printf \'%s\\n\' "$1"; fi; }',
    'inside() { local up; up=$(dirname -- "$1"); if [ -d "$up" ]; then printf \'%s/%s\\n\' "$(canon "$up")" "$(basename -- "$1")"; else printf \'%s\\n\' "$1"; fi; }',
    "# the app folder is made by the first update when only its parent exists (one new folder next to the person's own)",
    '[ -d "$dir" ] || [ -d "$(dirname -- "$dir")" ] || { echo "AOM: there is no folder $(dirname -- "$dir") on this machine" >&2; exit 21; }',
    'if [ -d "$dir" ]; then dir=$(canon "$dir"); else dir=$(inside "$dir"); fi',
    'link=$(inside "$link")',
    'kind=none',
    'if [ -L "$link" ]; then kind=link; elif [ -d "$link" ]; then kind=folder; elif [ -e "$link" ]; then kind=file; fi',
    'target=',
    '[ "$kind" = link ] && target=$(readlink -f -- "$link" 2>/dev/null || true)',
    `printf 'kind=%s\\ntarget=%s\\nappdir=%s\\nlink=%s\\n' "$kind" "$target" "$dir" "$link"`,
    QUIET,
    ')" || die "could not look at the app folder"',
    `LINK_KIND="$(printf '%s\\n' "$STATE" | sed -n 's/^kind=//p' | head -n 1)"`,
    `PREVIOUS_TARGET="$(printf '%s\\n' "$STATE" | sed -n 's/^target=//p' | head -n 1)"`,
    `APP_DIR="$(printf '%s\\n' "$STATE" | sed -n 's/^appdir=//p' | head -n 1)"`,
    `CURRENT_LINK="$(printf '%s\\n' "$STATE" | sed -n 's/^link=//p' | head -n 1)"`,
    sh`case "$PREVIOUS_TARGET" in *[!A-Za-z0-9._/+@=-]*) PREVIOUS_TARGET="" ;; esac`,
    sh`case "$APP_DIR$CURRENT_LINK" in ''|*[!A-Za-z0-9._/+@=-]*) die "the app folder or its link has unusual characters in its real name" ;; esac`,
    'RUNNING_RELEASE=""',
    sh`case "$PREVIOUS_TARGET" in "$APP_DIR"/releases/*) RUNNING_RELEASE="@{PREVIOUS_TARGET##*/}" ;; esac`,
    'say "running now: ${RUNNING_RELEASE:-${PREVIOUS_TARGET:-nothing}}"',
    '[ "$LINK_KIND" != file ] || die "$CURRENT_LINK is a file, not a folder or a link"',
    '',
    'if [ "$RUNNING_RELEASE" = "$SHORT" ] && healthy; then',
    '  say "already deployed: $SHORT is running and healthy"',
    '  done_line',
    '  exit 0',
    'fi',
    '[ "$DRY_RUN" = 1 ] && say "dry run: only checking, nothing will be changed"',
    'BACKUP_FILE=""',
    'RELEASE="$APP_DIR/releases/$SHORT"',
    '',
    '# if anything ends this script after the link was switched, point it back and restart the app',
    '# (always when the restart itself failed or a plain folder was being moved; otherwise when automatic rollback is on)',
    'SWITCHED=0',
    'FLIPPED=0',
    'FINISHED=0',
    'ADOPT_STARTED=0',
    'ADOPT_DONE=0',
    'RESTART_FAILED=0',
    `ROLLBACK_ON=${env.rollback ? 1 : 0}`,
    'restore_previous() {',
    ...(d?.adoptFolder
      ? [
          '  if [ "$ADOPT_STARTED" = 1 ] && [ "$ADOPT_DONE" != 1 ]; then',
          '    undo_adopt || return 1',
          '  else',
          '    set_link "$PREVIOUS_TARGET" || return 1',
          '  fi',
        ]
      : ['  set_link "$PREVIOUS_TARGET" || return 1']),
    '  if [ "$FLIPPED" = 1 ]; then restart_app 0 || return 1; fi',
    '}',
    'on_exit() {',
    '  local rc=$?',
    '  trap - EXIT',
    '  if [ "$SWITCHED" = 1 ] && [ "$FINISHED" != 1 ]; then',
    '    if [ "$ROLLBACK_ON" = 1 ] || [ "$ADOPT_STARTED" = 1 ] || [ "$RESTART_FAILED" = 1 ]; then',
    '      if [ -n "$PREVIOUS_TARGET" ] && [ "$PREVIOUS_TARGET" != "$RELEASE" ]; then',
    '        say "putting the previous version back: $PREVIOUS_TARGET"',
    '        if restore_previous; then',
    '          if [ "$FLIPPED" != 1 ]; then say "the previous version is back"',
    '          elif wait_healthy 60; then say "rolled back to $PREVIOUS_TARGET"; else say "still not healthy after going back to $PREVIOUS_TARGET"; fi',
    '        else',
    '          say "ROLLBACK FAILED: the app may still be running $SHORT. Point $CURRENT_LINK back at $PREVIOUS_TARGET and restart $UNIT_LABEL by hand."',
    '        fi',
    '        [ -z "$BACKUP_FILE" ] || say "the database was NOT rolled back; the backup made before this update is $BACKUP_FILE"',
    '      else',
    '        say "there is no previous version to go back to; the app may be running $SHORT"',
    '      fi',
    '    else',
    '      say "automatic rollback is switched off; the app may be running $SHORT"',
    '    fi',
    '  fi',
    '  if [ "$rc" -eq 0 ] && [ "$SWITCHED" = 1 ] && [ "$FINISHED" != 1 ]; then rc=1; fi',
    '  exit "$rc"',
    '}',
    'trap on_exit EXIT',
    "trap 'exit 143' TERM",
    "trap 'exit 130' INT",
  );
  env.steps.forEach((s, i) => {
    out.push(...directStep(s, i, env));
  });
  // the end: check, tidy up
  out.push(
    '',
    '# the end: check, go back if needed, tidy up',
    'if [ "$DRY_RUN" = 1 ]; then',
    env.health.kind === 'http'
      ? '  would "check $HEALTH_URL answers, and point the link back at the previous version if it does not"'
      : '  would "let Guildwise check the site"',
    '  say "dry run finished: nothing was changed"',
    '  exit 0',
    'fi',
  );
  if (env.health.kind === 'http')
    out.push(
      'if ! wait_healthy "$HEALTH_TIMEOUT"; then',
      '  say "the site did not become healthy within ${HEALTH_TIMEOUT}s"',
      '  die "the update failed (the previous version is put back when it can be)"',
      'fi',
    );
  out.push(
    'FINISHED=1',
    '',
    '# remove old release folders: never the one that runs, the one before it, or anything that is not a release of Guildwise',
    `remote "$APP_DIR" "$CURRENT_LINK" "$KEEP_RELEASES" "$RELEASE" "$PREVIOUS_TARGET" <<'${QUIET}' || true`,
    'set -eu',
    'app=$1; link=$2; keep=$3; cur=$4; prev=$5',
    '# every path is compared by where it really is (symlinks and a different spelling of the same folder cannot get past it)',
    'rp() { readlink -f -- "$1" 2>/dev/null || printf \'%s\\n\' "$1"; }',
    'now=$(rp "$link"); cur=$(rp "$cur"); prev=$(rp "$prev"); app=$(rp "$app")',
    'ls -1t -- "$app/releases" 2>/dev/null | grep -E \'^[0-9a-f]{12}$\' | tail -n +$((keep + 1)) | while IFS= read -r old; do',
    '  p=$(rp "$app/releases/$old")',
    '  [ "$p" != "$cur" ] && [ "$p" != "$prev" ] && [ "$p" != "$now" ] || continue',
    '  case "$p" in "$app"/releases/*) ;; *) continue ;; esac',
    '  rm -rf -- "$app/releases/$old"',
    'done',
    QUIET,
    '',
    'done_line',
  );
  return lines(out);
}
