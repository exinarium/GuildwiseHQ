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
import type { DeliverySetup, DeployStep, SetupEnv } from './setup.ts';

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

function localRemote(): string[] {
  return [
    '# a small script, run on this computer with these arguments as $1 $2 ... (the same shape as on a server)',
    'remote() {',
    '  local s',
    '  s="$(cat)"',
    '  bash -c "$s" aom-direct "$@" </dev/null',
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
    '      [ "$($sc show -p LoadState --value "$unit" 2>/dev/null)" = loaded ] || { echo "AOM: the service $unit is not known to systemd on this machine" >&2; exit 61; }',
    '      if [ -n "$S" ]; then sudo -n true 2>/dev/null || { echo "AOM: restarting $unit needs sudo, and sudo asks for a password here" >&2; exit 62; }; fi',
    '      echo "would restart only $unit" >&2; exit 0',
    '    fi',
    '    run $sc restart "$unit" ;;',
    '  pm2)',
    '    command -v pm2 >/dev/null 2>&1 || { echo "AOM: pm2 is not installed for this user" >&2; exit 63; }',
    '    if [ "$dry" = 1 ]; then pm2 describe "$pm" >/dev/null 2>&1 || { echo "AOM: pm2 has no process called $pm" >&2; exit 64; }; echo "would restart only $pm" >&2; exit 0; fi',
    '    pm2 restart "$pm" ;;',
    '  command)',
    '    if [ "$dry" = 1 ]; then',
    '      if [ -n "$S" ]; then sudo -n true 2>/dev/null || { echo "AOM: the restart command needs sudo, and sudo asks for a password here" >&2; exit 62; }; fi',
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
        '  if git -C "$CHECKOUT" rev-parse --git-dir >/dev/null 2>&1; then',
        '    git -C "$CHECKOUT" archive --format=tar "$COMMIT" | put_tar "$RELEASE"',
        '  else',
        '    (cd "$CHECKOUT" && tar -c -f - --exclude=.git .) | put_tar "$RELEASE"',
        '  fi',
        '  # shared files (settings, uploads) live in $APP_DIR/shared and are linked into every release; a missing one is copied once from the running release',
        d.shared.length
          ? `  remote "$APP_DIR" "$RELEASE" "$CURRENT_LINK" ${d.shared.map(shq).join(' ')} <<'${QUIET}'`
          : "  remote \"$APP_DIR\" \"$RELEASE\" \"$CURRENT_LINK\" <<'AOM_REMOTE'",
        'set -eu',
        'app=$1; rel=$2; cur=$3; shift 3',
        'for p in "$@"; do',
        '  case "$p" in /*|*..*) echo "AOM: a shared path must stay inside the app folder" >&2; exit 81 ;; esac',
        '  mkdir -p -- "$app/shared/$(dirname -- "$p")"',
        '  if [ ! -e "$app/shared/$p" ] && [ -e "$cur/$p" ]; then cp -a -- "$cur/$p" "$app/shared/$p"; fi',
        '  [ -e "$app/shared/$p" ] || { echo "AOM: the shared file $p does not exist in $app/shared yet and the running version has none to copy" >&2; exit 82; }',
        '  mkdir -p -- "$rel/$(dirname -- "$p")"',
        '  rm -rf -- "${rel:?}/$p"',
        '  ln -s -- "$app/shared/$p" "$rel/$p"',
        'done',
        QUIET,
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
        '  restart_app 1',
        'else',
        '  if [ "$LINK_KIND" = folder ]; then',
        '    [ "$ADOPT" = 1 ] || die "$CURRENT_LINK is a plain folder; confirm in the setup that its first update may turn it into the first release"',
        '    remote "$APP_DIR" "$CURRENT_LINK" <<\'AOM_REMOTE\'',
        'set -eu',
        'app=$1; link=$2',
        'mkdir -p -- "$app/releases"',
        '[ ! -e "$app/releases/initial" ] || { echo "AOM: $app/releases/initial exists already" >&2; exit 91; }',
        'mv -- "$link" "$app/releases/initial"',
        'ln -s -- "$app/releases/initial" "$link"',
        'echo "the folder $link is now the first release: $app/releases/initial" >&2',
        QUIET,
        '    PREVIOUS_TARGET="$APP_DIR/releases/initial"',
        '  fi',
        '  SWITCHED=1',
        '  set_link "$RELEASE"',
        '  restart_app 0',
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
    '# what runs now: where the link points, or what is at the link\'s place',
    `STATE="$(remote "$APP_DIR" "$CURRENT_LINK" <<'${QUIET}'`,
    'set -eu',
    'dir=$1; link=$2',
    '[ -d "$dir" ] || { echo "AOM: there is no folder $dir on this machine" >&2; exit 21; }',
    'kind=none',
    'if [ -L "$link" ]; then kind=link; elif [ -d "$link" ]; then kind=folder; elif [ -e "$link" ]; then kind=file; fi',
    'target=',
    '[ "$kind" = link ] && target=$(readlink -f -- "$link" 2>/dev/null || true)',
    `printf 'kind=%s\\ntarget=%s\\n' "$kind" "$target"`,
    QUIET,
    ')" || die "could not look at the app folder"',
    `LINK_KIND="$(printf '%s\\n' "$STATE" | sed -n 's/^kind=//p' | head -n 1)"`,
    `PREVIOUS_TARGET="$(printf '%s\\n' "$STATE" | sed -n 's/^target=//p' | head -n 1)"`,
    sh`case "$PREVIOUS_TARGET" in *[!A-Za-z0-9._/+@=-]*) PREVIOUS_TARGET="" ;; esac`,
    'RUNNING_RELEASE=""',
    sh`case "$PREVIOUS_TARGET" in "$(readlink -f -- "$APP_DIR" 2>/dev/null || printf %s "$APP_DIR")"/releases/*) RUNNING_RELEASE="@{PREVIOUS_TARGET##*/}" ;; esac`,
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
    'SWITCHED=0',
    'FINISHED=0',
    'on_exit() {',
    '  local rc=$?',
    '  trap - EXIT',
    '  if [ "$SWITCHED" = 1 ] && [ "$FINISHED" != 1 ]; then',
    ...(env.rollback
      ? [
          '    if [ -n "$PREVIOUS_TARGET" ] && [ "$PREVIOUS_TARGET" != "$RELEASE" ]; then',
          '      say "putting the previous version back: $PREVIOUS_TARGET"',
          '      if set_link "$PREVIOUS_TARGET" && restart_app 0; then',
          '        if wait_healthy 60; then say "rolled back to $PREVIOUS_TARGET"; else say "still not healthy after going back to $PREVIOUS_TARGET"; fi',
          '      else',
          '        say "ROLLBACK FAILED: the app may still be running $SHORT. Point $CURRENT_LINK back at $PREVIOUS_TARGET and restart $UNIT_LABEL by hand."',
          '      fi',
          '      [ -z "$BACKUP_FILE" ] || say "the database was NOT rolled back; the backup made before this update is $BACKUP_FILE"',
          '    else',
          '      say "there is no previous version to go back to; the app may be running $SHORT"',
          '    fi',
        ]
      : ['    say "automatic rollback is switched off; the app may be running $SHORT"']),
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
    'now=$(readlink -f -- "$link" 2>/dev/null || true)',
    'ls -1t -- "$app/releases" 2>/dev/null | grep -E \'^[0-9a-f]{12}$\' | tail -n +$((keep + 1)) | while IFS= read -r old; do',
    '  p="$app/releases/$old"',
    '  [ "$p" != "$cur" ] && [ "$p" != "$prev" ] && [ "$(readlink -f -- "$p")" != "$now" ] || continue',
    '  rm -rf -- "$p"',
    'done',
    QUIET,
    '',
    'done_line',
  );
  return lines(out);
}
