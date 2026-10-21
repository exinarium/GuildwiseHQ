import { type ChildProcess, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import {
  DEPLOY_KEY_COMMENT_PREFIX,
  type DeployMovePayload,
  type DeployMoveResult,
  type MoveCheck,
  type MoveError,
  type MoveFacts,
  type MoveSpec,
  type MoveStep,
} from '@aom/shared';
import { type Logger, nullLogger } from '../log.ts';
import { remoteCommand } from './connect.ts';
import { type DeployKeys, userSshArgs } from './deploy-keys.ts';
import { classifySsh, parseComposeStructure, type Ran, run } from './probe.ts';

/**
 * `deploy.move` (docs/design/deploy-run-ux-design.md J6, v3): one step of moving an app to a new server per command. The computer
 * signs in to BOTH servers with the sign-ins it already has (a dedicated key, or the person's own for an existing alias), so a
 * settings file, an image or a database backup travels old server -> this computer (in memory, as a stream) -> new server. Nothing
 * is written on this computer, nothing is logged or returned except counts and plain-words facts.
 *
 * Safety rules, enforced here and in the fixed scripts:
 * - Every script is fixed; values are positional arguments, single-quoted, and were checked by the schema.
 * - The old server is only changed by `stop_and_backup` (the app part is stopped, a dated dump is saved) and `restart_old`
 *   (the app part is started again). Nothing is deleted there; no `down`, `rm`, `-v`, prune.
 * - A step that stops the old app puts it back by itself when its own work fails.
 * - The new server's files are never overwritten (a different file there is a refusal), and a database is only restored into an
 *   empty one, in one transaction (so a failed restore applies nothing).
 * - `retire_keys` removes lines whose comment starts with `guildwise-deploy:` and nothing else, after a dated copy.
 */

export interface MoverDeps {
  keys: DeployKeys;
  env?: NodeJS.ProcessEnv;
  /** The person's own ssh config for aliases without a dedicated key (`-F`); tests give a file of their own. */
  userSshConfig?: string;
  home?: string;
  connectSec?: number;
  /** Per-step budgets in ms (tests shorten them). */
  stepMs?: Partial<Record<MoveStep, number>>;
  /** How long the new app has to answer (seconds, default 90). */
  healthWaitSec?: number;
  log?: Logger;
}

const DEFAULT_MS: Record<MoveStep, number> = {
  check: 90_000,
  copy_config: 90_000,
  copy_image: 30 * 60_000,
  start_database: 150_000,
  stop_and_backup: 20 * 60_000,
  restore: 60 * 60_000,
  start_app: 180_000,
  restart_old: 120_000,
  retire_keys: 60_000,
};

const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;
const SAFE_REL = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,120}$/;
const MAX_FILE = 200_000;

// ------------------------------------------------------------------------------------------------ scripts

/** Every script starts with this. `$1` is the compose file, `$2` the compose project (`-` for none). */
const HEADER = `set -eu
FILE=$1; PROJECT=$2
if [ "$PROJECT" = - ]; then PROJECT=; fi
dc() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif docker-compose version >/dev/null 2>&1; then docker-compose "$@"
  else echo "AOM_ERR blocked this server has neither docker compose nor docker-compose"; exit 4; fi
}
dcf() { if [ -n "$PROJECT" ]; then dc -p "$PROJECT" -f "$FILE" "$@"; else dc -f "$FILE" "$@"; fi; }
err() { echo "AOM_ERR $1 $2"; exit 4; }
chk() { echo "AOM_CHECK $1 $2 $3"; }
# the number of tables in the app's database ($USERNAME and $DBNAME may be empty: the container's own defaults)
tables() {
  echo "select count(*) from information_schema.tables where table_schema='public'" |
    dcf exec -T "$DB" sh -c 'psql -A -t -U "\${1:-$POSTGRES_USER}" -d "\${2:-$POSTGRES_DB}"' sh "$DBUSER" "$DBNAME" | tr -d ' \\r\\n'
}
`;

/** args: FILE PROJECT APP DB IMGVAR SIDE */
const CHECK = `${HEADER}
APP=$3; DB=$4; IMGVAR=$5; SIDE=$6
dir=$(dirname "$FILE")
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then chk docker ok "Docker works on the $SIDE server"; else chk docker bad "Docker is not installed on the $SIDE server, or this user may not use it"; exit 0; fi
if docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1; then chk compose ok "Docker Compose is available"; else chk compose bad "Docker Compose is not installed on the $SIDE server"; exit 0; fi
if [ "$SIDE" = old ]; then
  if [ -f "$FILE" ]; then chk composefile ok "The compose file is there ($FILE)"; else chk composefile bad "The compose file $FILE is not on the old server"; exit 0; fi
  if [ -f "$dir/.env" ]; then chk settings ok "The settings file is there ($dir/.env)"; else chk settings bad "The settings file $dir/.env is not on the old server"; exit 0; fi
  if [ -n "$(dcf ps -q "$DB" 2>/dev/null | head -n 1)" ]; then chk database ok "The database ($DB) is running"; else chk database bad "The database ($DB) is not running on the old server"; exit 0; fi
  id=$(dcf ps -q "$APP" 2>/dev/null | head -n 1) || id=
  if [ -n "$id" ]; then chk app ok "The app ($APP) is running"; else chk app bad "The app ($APP) is not running on the old server"; fi
  img=$(sed -n "s/^$IMGVAR=//p" "$dir/.env" | tail -n 1 | tr -d "\\"'" | tr -d '\\r') || img=
  if [ -z "$img" ] && [ -n "$id" ]; then img=$(docker inspect --format '{{.Config.Image}}' "$id" 2>/dev/null) || img=; fi
  if [ -n "$img" ]; then echo "AOM_FACT image $img"; fi
  if [ -n "$id" ]; then
    port=$(docker inspect --format '{{range $p,$c := .NetworkSettings.Ports}}{{range $c}}{{.HostPort}} {{end}}{{end}}' "$id" 2>/dev/null | awk '{print $1}') || port=
    if [ -n "$port" ]; then echo "AOM_FACT port $port"; fi
  fi
else
  if [ -f "$FILE" ] && [ -n "$(dcf ps -q "$APP" 2>/dev/null | head -n 1)" ]; then chk fresh bad "The new server already runs this app, so it is not a new, empty server"; exit 0; fi
  chk fresh ok "The new server does not run the app yet"
  if [ -d "$dir" ]; then chk folder ok "The folder $dir exists on the new server"; else chk folder ok "The folder $dir will be created on the new server"; fi
fi
`;

/** args: PATH — prints the file */
const READ_FILE = 'cat -- "$1"';

/** args: PATH MODE; the content arrives on stdin. An identical file is fine, a different one is never overwritten. */
const WRITE_FILE = `set -eu
f=$1; mode=$2
dir=$(dirname "$f")
mkdir -p -- "$dir" 2>/dev/null || { echo "AOM_ERR blocked cannot create the folder $dir"; exit 4; }
umask 077
tmp="$f.aom-new.$$"
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp"
if [ -e "$f" ]; then
  if [ "$(cksum < "$tmp")" = "$(cksum < "$f")" ]; then echo "AOM_RESULT same"; exit 0; fi
  echo "AOM_ERR config_differs $f"; exit 4
fi
chmod "$mode" "$tmp"
mv -- "$tmp" "$f"
echo "AOM_RESULT written"
`;

const IMAGE_PRESENT = `if docker image inspect "$1" >/dev/null 2>&1; then echo "AOM_RESULT present"; else echo "AOM_RESULT missing"; fi`;
const IMAGE_SAVE = 'docker save "$1" | gzip -1';
const IMAGE_LOAD = `set -eu
gunzip | docker load >/dev/null
if docker image inspect "$1" >/dev/null 2>&1; then echo "AOM_RESULT loaded"; else echo "AOM_ERR image_missing the image did not arrive"; exit 4; fi
`;

/** args: FILE PROJECT DB DBUSER DBNAME */
const START_DB = `${HEADER}
DB=$3; DBUSER=$4; DBNAME=$5
if [ -z "$(dcf ps -q "$DB" 2>/dev/null | head -n 1)" ]; then
  dcf up -d --no-deps "$DB" >/dev/null 2>&1 || err database_not_ready "docker compose could not start $DB"
fi
i=0
while [ "$i" -lt 60 ]; do
  if dcf exec -T "$DB" sh -c 'pg_isready -q -U "\${1:-$POSTGRES_USER}" -d "\${2:-$POSTGRES_DB}"' sh "$DBUSER" "$DBNAME" </dev/null >/dev/null 2>&1; then echo "AOM_RESULT ready"; exit 0; fi
  i=$((i + 1)); sleep 1
done
err database_not_ready "the database did not accept connections within 60 seconds"
`;

/** args: FILE PROJECT APP DB DBUSER DBNAME BACKUPDIR. Stops the app, dumps the database to a dated file. A failure starts the app again. */
const STOP_AND_BACKUP = `${HEADER}
APP=$3; DB=$4; DBUSER=$5; DBNAME=$6; BACKUPDIR=$7
back() { dcf up -d --no-deps "$APP" >/dev/null 2>&1 || true; }
dcf stop "$APP" >/dev/null 2>&1 || err failed "could not stop $APP"
umask 077
mkdir -p -- "$BACKUPDIR" 2>/dev/null || { back; err backup_failed "cannot create $BACKUPDIR"; }
out="$BACKUPDIR/move-$(date +%Y%m%d-%H%M%S).sql.gz"
if ! dcf exec -T "$DB" sh -c 'pg_dump -U "\${1:-$POSTGRES_USER}" -d "\${2:-$POSTGRES_DB}"' sh "$DBUSER" "$DBNAME" </dev/null | gzip > "$out.part"; then
  rm -f -- "$out.part"; back; err backup_failed "pg_dump failed"
fi
if [ "$(gzip -dc "$out.part" | wc -c)" -lt 512 ]; then rm -f -- "$out.part"; back; err backup_failed "the backup is too small to be real"; fi
if ! gzip -dc "$out.part" | tail -n 5 | grep -q 'dump complete'; then rm -f -- "$out.part"; back; err backup_failed "the backup is cut short"; fi
mv -- "$out.part" "$out"
[ -s "$out" ] || { back; err backup_failed "the backup file is missing after it was saved"; }
echo "AOM_FACT backupFile $out"
echo "AOM_FACT backupBytes $(wc -c < "$out" | tr -d ' ')"
echo "AOM_FACT tablesOld $(tables)"
echo "AOM_RESULT stopped"
`;

/** args: FILE PROJECT DB DBUSER DBNAME; the gzip'd dump arrives on stdin. Empty database only; one transaction. */
const RESTORE = `${HEADER}
DB=$3; DBUSER=$4; DBNAME=$5
n=$(tables) || err database_not_ready "the new database does not answer"
if [ "$n" != 0 ]; then err new_database_not_empty "the new database already has $n tables"; fi
if ! gunzip | dcf exec -T "$DB" sh -c 'psql -q -v ON_ERROR_STOP=1 --single-transaction -U "\${1:-$POSTGRES_USER}" -d "\${2:-$POSTGRES_DB}" >/dev/null' sh "$DBUSER" "$DBNAME"; then
  err restore_failed "the database refused the backup (nothing was applied)"
fi
echo "AOM_FACT tablesNew $(tables)"
echo "AOM_RESULT restored"
`;

/** args: FILE PROJECT DB DBUSER DBNAME — table count of the old database (read-only). */
const TABLES_ONLY = `${HEADER}
DB=$3; DBUSER=$4; DBNAME=$5
echo "AOM_FACT tablesOld $(tables)"
`;

/** args: FILE PROJECT APP PORT HPATH WAITSEC. */
const START_APP = `${HEADER}
APP=$3; PORT=$4; HPATH=$5; WAIT=$6
if [ "$PORT" = - ]; then PORT=; fi
dcf up -d --no-deps "$APP" >/dev/null 2>&1 || { dcf stop "$APP" >/dev/null 2>&1 || true; err app_not_healthy "docker compose could not start $APP"; }
ask() {
  if command -v curl >/dev/null 2>&1; then curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$PORT$HPATH" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then wget -q -T 5 -O /dev/null "http://127.0.0.1:$PORT$HPATH" >/dev/null 2>&1
  else return 2; fi
}
i=0; state=waiting; up=0
while [ "$i" -lt "$WAIT" ]; do
  if [ -n "$(dcf ps -q "$APP" 2>/dev/null | head -n 1)" ]; then up=$((up + 1)); else up=0; fi
  if [ -n "$PORT" ]; then
    set +e; ask; rc=$?; set -e
    if [ "$rc" = 0 ]; then state=healthy; break; fi
    if [ "$rc" = 2 ] && [ "$up" -ge 5 ]; then state=unknown; break; fi
  elif [ "$up" -ge 5 ]; then state=unknown; break; fi
  i=$((i + 1)); sleep 1
done
if [ "$state" = waiting ]; then
  dcf stop "$APP" >/dev/null 2>&1 || true
  err app_not_healthy "it did not answer within $WAIT seconds"
fi
if [ "$state" = healthy ]; then echo "AOM_FACT healthy true"; else echo "AOM_FACT healthy null"; fi
echo "AOM_RESULT started"
`;

/** args: FILE PROJECT APP */
const START_ONLY = `${HEADER}
APP=$3
dcf up -d --no-deps "$APP" >/dev/null 2>&1 || err failed "docker compose could not start $APP"
echo "AOM_RESULT started"
`;
/** args: FILE PROJECT APP */
const STOP_ONLY = `${HEADER}
APP=$3
dcf stop "$APP" >/dev/null 2>&1 || true
echo "AOM_RESULT stopped"
`;

/** args: PREFIX — removes every line Guildwise made (comment starts with the prefix), after a dated copy. */
export const REVOKE_ALL_SCRIPT = `set -eu
p=$1
f="$HOME/.ssh/authorized_keys"
if [ ! -f "$f" ]; then echo "AOM_RESULT 0"; exit 0; fi
n=$(awk -v p="$p" '{ if (index($3, p) == 1) c++ } END { print c + 0 }' "$f")
if [ "$n" = 0 ]; then echo "AOM_RESULT 0"; exit 0; fi
bak="$f.guildwise-bak-$(date +%Y%m%d%H%M%S)"
cp -p -- "$f" "$bak"
tmp="$f.aom-tmp.$$"
trap 'rm -f -- "$tmp"' EXIT
cp -p -- "$f" "$tmp"
awk -v p="$p" '{ if (index($3, p) == 1) next; print }' "$f" > "$tmp"
mv -- "$tmp" "$f"
echo "AOM_RESULT $n $bak"
`;

// ------------------------------------------------------------------------------------------------ parsing

interface Out {
  code: number | null;
  timedOut: boolean;
  missing: boolean;
  checks: MoveCheck[];
  facts: Record<string, string>;
  err?: { code: string; text: string };
  result?: string[];
  stderr: string;
  /** ssh itself failed (exit 255 or a classified connection problem). */
  sshFailed: boolean;
  sshDetail?: string;
}

export function parseMoveOutput(stdout: string): Pick<Out, 'checks' | 'facts' | 'err' | 'result'> {
  const checks: MoveCheck[] = [];
  const facts: Record<string, string> = {};
  let err: Out['err'];
  let result: string[] | undefined;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m = /^AOM_CHECK (\S+) (ok|bad) (.*)$/.exec(line);
    if (m) {
      checks.push({
        id: (m[1] as string).slice(0, 40),
        ok: m[2] === 'ok',
        text: (m[3] as string).slice(0, 300),
      });
      continue;
    }
    m = /^AOM_FACT (\S+) (.*)$/.exec(line);
    if (m) {
      facts[m[1] as string] = (m[2] as string).trim();
      continue;
    }
    m = /^AOM_ERR (\S+) ?(.*)$/.exec(line);
    if (m) {
      err = { code: m[1] as string, text: (m[2] as string).slice(0, 300) };
      continue;
    }
    m = /^AOM_RESULT ?(.*)$/.exec(line);
    if (m) result = (m[1] as string).split(' ').filter(Boolean);
  }
  return { checks, facts, ...(err ? { err } : {}), ...(result ? { result } : {}) };
}

const MOVE_ERROR_CODES = new Set<string>([
  'blocked',
  'config_differs',
  'image_missing',
  'database_not_ready',
  'backup_failed',
  'new_database_not_empty',
  'restore_failed',
  'app_not_healthy',
  'failed',
]);

type Side = 'from' | 'to';

export class DeployMover {
  private readonly log: Logger;
  constructor(private readonly deps: MoverDeps) {
    this.log = deps.log ?? nullLogger;
  }

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  private ms(step: MoveStep): number {
    return this.deps.stepMs?.[step] ?? DEFAULT_MS[step];
  }

  /** The ssh arguments up to and including the alias (the remote command follows). */
  private sshArgs(spec: MoveSpec, side: Side): string[] {
    const t = spec[side];
    return [
      ...(this.deps.userSshConfig && !this.deps.keys.sshConfigFor(t.targetId, t.alias)
        ? userSshArgs(this.deps.home ?? homedir(), this.deps.userSshConfig)
        : this.deps.keys.sshArgsFor(t.targetId, t.alias)),
      '-o',
      'BatchMode=yes',
      '-o',
      `ConnectTimeout=${this.deps.connectSec ?? 10}`,
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '--',
      t.alias,
    ];
  }

  private async script(
    spec: MoveSpec,
    side: Side,
    script: string,
    args: string[],
    timeoutMs: number,
    input?: string,
  ): Promise<Out> {
    const r: Ran = await run('ssh', [...this.sshArgs(spec, side), remoteCommand(script, ...args)], {
      timeoutMs,
      ...(input !== undefined ? { input } : {}),
      env: this.env,
    });
    return this.out(r);
  }

  private out(r: Ran): Out {
    const parsed = parseMoveOutput(r.stdout);
    // ssh itself exits 255; a remote command that fails exits with its own code
    const ssh = r.code === 255;
    const cls = ssh ? classifySsh(r) : undefined;
    return {
      code: r.code,
      timedOut: r.timedOut,
      missing: r.missing,
      ...parsed,
      stderr: r.stderr,
      sshFailed: !!ssh && !r.timedOut,
      ...(cls?.detail ? { sshDetail: cls.detail } : {}),
    };
  }

  /** Common failure of one script run: unreachable, timeout, or the script's own refusal. */
  private fail(step: MoveStep, side: Side, o: Out, extra: Partial<DeployMoveResult> = {}): DeployMoveResult {
    if (o.missing)
      return {
        ok: false,
        step,
        error: 'failed',
        detail: 'ssh is not installed on this computer',
        checks: [],
        facts: {},
        ...extra,
      };
    if (o.timedOut) return { ok: false, step, error: 'timeout', checks: o.checks, facts: {}, ...extra };
    if (o.err) {
      const error: MoveError = MOVE_ERROR_CODES.has(o.err.code) ? (o.err.code as MoveError) : 'failed';
      return { ok: false, step, error, detail: o.err.text, checks: o.checks, facts: {}, ...extra };
    }
    if (o.sshFailed)
      return {
        ok: false,
        step,
        error: side === 'from' ? 'old_unreachable' : 'new_unreachable',
        ...(o.sshDetail ? { detail: o.sshDetail } : {}),
        checks: [],
        facts: {},
        ...extra,
      };
    return {
      ok: false,
      step,
      error: 'failed',
      detail: o.stderr.split('\n').find(Boolean)?.slice(0, 200) ?? `exit ${o.code}`,
      checks: o.checks,
      facts: {},
      ...extra,
    };
  }

  async run(p: DeployMovePayload): Promise<DeployMoveResult> {
    try {
      switch (p.step) {
        case 'check':
          return await this.check(p);
        case 'copy_config':
          return await this.copyConfig(p);
        case 'copy_image':
          return await this.copyImage(p);
        case 'start_database':
          return await this.startDatabase(p);
        case 'stop_and_backup':
          return await this.stopAndBackup(p);
        case 'restore':
          return await this.restore(p);
        case 'start_app':
          return await this.startApp(p);
        case 'restart_old':
          return await this.restartOld(p);
        case 'retire_keys':
          return await this.retireKeys(p);
      }
    } catch (err) {
      this.log.warn(`deploy.move ${p.step} failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        ok: false,
        step: p.step,
        error: 'failed',
        detail: String(err).slice(0, 200),
        checks: [],
        facts: {},
      };
    }
  }

  private common(spec: MoveSpec): [string, string] {
    return [spec.composeFile, spec.composeProject ?? '-'];
  }

  // ------------------------------------------------------------------------------------------ check

  private async check(p: DeployMovePayload): Promise<DeployMoveResult> {
    const s = p.spec;
    const [file, project] = this.common(s);
    const [o, n] = await Promise.all([
      this.script(
        s,
        'from',
        CHECK,
        [file, project, s.appService, s.dbService, s.imageVar, 'old'],
        this.ms('check'),
      ),
      this.script(
        s,
        'to',
        CHECK,
        [file, project, s.appService, s.dbService, s.imageVar, 'new'],
        this.ms('check'),
      ),
    ]);
    if (o.sshFailed || o.timedOut || o.missing) return this.fail('check', 'from', o);
    if (n.sshFailed || n.timedOut || n.missing) return this.fail('check', 'to', n);
    const checks: MoveCheck[] = [
      { id: 'old-reach', ok: true, text: 'This computer can sign in to the old server' },
      { id: 'new-reach', ok: true, text: 'This computer can sign in to the new server' },
      ...o.checks,
      ...n.checks,
    ];
    const facts: MoveFacts = {};
    if (o.facts.image && IMAGE_RE.test(o.facts.image)) facts.image = o.facts.image;
    const port = Number(o.facts.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) facts.appPort = port;
    if (!facts.image)
      checks.push({
        id: 'image',
        ok: false,
        text: 'Guildwise could not tell which version of the app is running on the old server',
      });
    const bad = checks.filter((c) => !c.ok);
    if (bad.length)
      return {
        ok: false,
        step: 'check',
        error: 'blocked',
        detail: (bad[0] as MoveCheck).text,
        checks,
        facts,
      };
    return { ok: true, step: 'check', checks, facts };
  }

  // ------------------------------------------------------------------------------------------ copy the settings

  private async readOld(
    spec: MoveSpec,
    path: string,
  ): Promise<{ ok: true; text: string } | { ok: false; out: Out }> {
    const r = await run('ssh', [...this.sshArgs(spec, 'from'), remoteCommand(READ_FILE, path)], {
      timeoutMs: this.ms('copy_config'),
      env: this.env,
      raw: true,
    });
    if (r.code !== 0) return { ok: false, out: this.out(r) };
    if (Buffer.byteLength(r.stdout) > MAX_FILE)
      return {
        ok: false,
        out: { ...this.out(r), err: { code: 'blocked', text: `${path} is too big to copy` } },
      };
    return { ok: true, text: r.stdout };
  }

  private async copyConfig(p: DeployMovePayload): Promise<DeployMoveResult> {
    const s = p.spec;
    const dir = dirname(s.composeFile);
    const compose = await this.readOld(s, s.composeFile);
    if (!compose.ok) return this.fail('copy_config', 'from', compose.out);
    // the settings file(s) the compose file names (`env_file`) next to it, plus `.env`
    const rel = new Set<string>(['.env']);
    const structure = parseComposeStructure(s.composeFile, compose.text);
    for (const svc of structure.services)
      for (const f of svc.envFiles) {
        const clean = f.replace(/^\.\//, '');
        if (SAFE_REL.test(clean) && !clean.split('/').includes('..') && !clean.startsWith('/'))
          rel.add(clean);
      }
    const files: Array<{ path: string; text: string; mode: string }> = [
      { path: s.composeFile, text: compose.text, mode: '644' },
    ];
    let settings = 0;
    for (const r of [...rel].slice(0, 6)) {
      const path = `${dir}/${r}`;
      const got = await this.readOld(s, path);
      if (!got.ok) {
        // a named settings file that is not there is skipped; `.env` has to be there
        if (r === '.env') return this.fail('copy_config', 'from', got.out);
        continue;
      }
      settings += got.text.split('\n').filter((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)).length;
      files.push({ path, text: got.text, mode: '600' });
    }
    let written = 0;
    for (const f of files) {
      const o = await this.script(s, 'to', WRITE_FILE, [f.path, f.mode], this.ms('copy_config'), f.text);
      if (o.err || o.sshFailed || o.timedOut || o.code !== 0) return this.fail('copy_config', 'to', o);
      if (o.result?.[0] === 'written') written++;
    }
    return {
      ok: true,
      step: 'copy_config',
      checks: [
        {
          id: 'files',
          ok: true,
          text: `${files.length} file${files.length === 1 ? '' : 's'} (the compose file and ${files.length - 1} settings file${files.length === 2 ? '' : 's'}, ${settings} settings) ${written ? 'copied' : 'were already there'}; nothing is shown`,
        },
      ],
      facts: { settingsCount: settings },
      skipped: written === 0,
    };
  }

  // ------------------------------------------------------------------------------------------ copy the image

  /** The image the old server runs: its settings file first, else the running container. */
  private async oldImage(p: DeployMovePayload): Promise<string | null> {
    const s = p.spec;
    const [file, project] = this.common(s);
    const o = await this.script(
      s,
      'from',
      CHECK,
      [file, project, s.appService, s.dbService, s.imageVar, 'old'],
      this.ms('check'),
    );
    const img = o.facts.image;
    return img && IMAGE_RE.test(img) ? img : null;
  }

  private async copyImage(p: DeployMovePayload): Promise<DeployMoveResult> {
    const s = p.spec;
    const image = await this.oldImage(p);
    if (!image)
      return {
        ok: false,
        step: 'copy_image',
        error: 'image_missing',
        detail: 'the version of the app could not be found',
        checks: [],
        facts: {},
      };
    const have = await this.script(s, 'to', IMAGE_PRESENT, [image], this.ms('check'));
    if (have.sshFailed || have.timedOut) return this.fail('copy_image', 'to', have);
    if (have.result?.[0] === 'present')
      return {
        ok: true,
        step: 'copy_image',
        checks: [{ id: 'image', ok: true, text: `The app (${image}) is already on the new server` }],
        facts: { image },
        skipped: true,
      };
    const onOld = await this.script(s, 'from', IMAGE_PRESENT, [image], this.ms('check'));
    if (onOld.result?.[0] !== 'present')
      return {
        ok: false,
        step: 'copy_image',
        error: 'image_missing',
        detail: `${image} is not on the old server`,
        checks: [],
        facts: {},
      };
    const piped = await this.pipe(
      [...this.sshArgs(s, 'from'), remoteCommand(IMAGE_SAVE, image)],
      [...this.sshArgs(s, 'to'), remoteCommand(IMAGE_LOAD, image)],
      this.ms('copy_image'),
    );
    if (piped.timedOut) return { ok: false, step: 'copy_image', error: 'timeout', checks: [], facts: {} };
    const dst = parseMoveOutput(piped.dstOut);
    if (piped.srcCode !== 0 || piped.dstCode !== 0 || dst.result?.[0] !== 'loaded')
      return {
        ok: false,
        step: 'copy_image',
        error: 'image_missing',
        detail: (
          dst.err?.text ??
          piped.dstErr.split('\n').find(Boolean) ??
          piped.srcErr.split('\n').find(Boolean) ??
          'the copy failed'
        ).slice(0, 200),
        checks: [],
        facts: {},
      };
    return {
      ok: true,
      step: 'copy_image',
      checks: [{ id: 'image', ok: true, text: `The app (${image}) was copied to the new server` }],
      facts: { image },
    };
  }

  // ------------------------------------------------------------------------------------------ database

  private dbArgs(p: DeployMovePayload): string[] {
    const s = p.spec;
    return [...this.common(s), s.dbService, s.dbUser ?? '', s.dbName ?? ''];
  }

  private async startDatabase(p: DeployMovePayload): Promise<DeployMoveResult> {
    const o = await this.script(p.spec, 'to', START_DB, this.dbArgs(p), this.ms('start_database'));
    if (o.result?.[0] !== 'ready') return this.fail('start_database', 'to', o);
    return {
      ok: true,
      step: 'start_database',
      checks: [
        { id: 'db', ok: true, text: 'The database on the new server is running and ready (still empty)' },
      ],
      facts: {},
    };
  }

  private async stopAndBackup(p: DeployMovePayload): Promise<DeployMoveResult> {
    const s = p.spec;
    const o = await this.script(
      s,
      'from',
      STOP_AND_BACKUP,
      [...this.common(s), s.appService, s.dbService, s.dbUser ?? '', s.dbName ?? '', s.backupDir],
      this.ms('stop_and_backup'),
    );
    if (o.result?.[0] !== 'stopped') {
      // the script puts the app back by itself on a backup failure; when ssh failed we cannot tell
      return this.fail('stop_and_backup', 'from', o, {
        oldAppRunning: o.err ? o.err.code === 'backup_failed' : undefined,
      });
    }
    const facts: MoveFacts = {};
    const bytes = Number(o.facts.backupBytes);
    const old = Number(o.facts.tablesOld);
    if (o.facts.backupFile && o.facts.backupFile.startsWith(`${s.backupDir}/`))
      facts.backupFile = o.facts.backupFile;
    if (Number.isFinite(bytes)) facts.backupBytes = bytes;
    if (Number.isFinite(old)) facts.tablesOld = old;
    return {
      ok: true,
      step: 'stop_and_backup',
      checks: [
        {
          id: 'stopped',
          ok: true,
          text: 'The app on the old server is stopped (the site is down until the new one answers)',
        },
        {
          id: 'backup',
          ok: true,
          text: `A last backup is saved on the old server${facts.backupFile ? ` (${facts.backupFile})` : ''}`,
        },
      ],
      facts,
      oldAppRunning: false,
    };
  }

  private async restore(p: DeployMovePayload): Promise<DeployMoveResult> {
    const s = p.spec;
    const file = p.context.backupFile;
    if (!file)
      return {
        ok: false,
        step: 'restore',
        error: 'bad_request',
        detail: 'the backup file is not known',
        checks: [],
        facts: {},
      };
    const piped = await this.pipe(
      [...this.sshArgs(s, 'from'), remoteCommand(READ_FILE, file)],
      [...this.sshArgs(s, 'to'), remoteCommand(RESTORE, ...this.dbArgs(p))],
      this.ms('restore'),
    );
    const dst = parseMoveOutput(piped.dstOut);
    if (piped.timedOut || piped.dstCode !== 0 || piped.srcCode !== 0 || dst.result?.[0] !== 'restored') {
      // nothing was applied (one transaction): the site comes back on the old server
      const back = await this.startOld(p);
      const detail = (
        dst.err?.text ??
        piped.dstErr.split('\n').find(Boolean) ??
        piped.srcErr.split('\n').find(Boolean) ??
        ''
      ).slice(0, 200);
      const error: MoveError = piped.timedOut
        ? 'timeout'
        : dst.err && MOVE_ERROR_CODES.has(dst.err.code)
          ? (dst.err.code as MoveError)
          : 'restore_failed';
      return {
        ok: false,
        step: 'restore',
        error,
        ...(detail ? { detail } : {}),
        checks: [],
        facts: {},
        oldAppRunning: back,
      };
    }
    const tablesNew = Number(dst.facts.tablesNew);
    const tables = await this.script(s, 'from', TABLES_ONLY, this.dbArgs(p), this.ms('check'));
    const tablesOld = Number(tables.facts.tablesOld);
    if (Number.isFinite(tablesNew) && Number.isFinite(tablesOld) && tablesNew !== tablesOld) {
      return {
        ok: false,
        step: 'restore',
        error: 'restore_failed',
        detail: `the new database has ${tablesNew} tables, the old one ${tablesOld}`,
        checks: [],
        facts: { tablesOld, tablesNew },
        oldAppRunning: false,
      };
    }
    return {
      ok: true,
      step: 'restore',
      checks: [
        {
          id: 'restore',
          ok: true,
          text: `The data is on the new server (${Number.isFinite(tablesNew) ? `${tablesNew} tables, like the old database` : 'restored'})`,
        },
      ],
      facts: {
        ...(Number.isFinite(tablesNew) ? { tablesNew } : {}),
        ...(Number.isFinite(tablesOld) ? { tablesOld } : {}),
      },
      oldAppRunning: false,
    };
  }

  private async startApp(p: DeployMovePayload): Promise<DeployMoveResult> {
    const s = p.spec;
    const wait = String(this.deps.healthWaitSec ?? 90);
    const o = await this.script(
      s,
      'to',
      START_APP,
      [
        ...this.common(s),
        s.appService,
        p.context.appPort ? String(p.context.appPort) : '-',
        s.healthPath ?? '/',
        wait,
      ],
      this.ms('start_app'),
    );
    if (o.result?.[0] !== 'started') return this.fail('start_app', 'to', o, { oldAppRunning: false });
    const healthy = o.facts.healthy === 'true' ? true : null;
    return {
      ok: true,
      step: 'start_app',
      checks: [
        {
          id: 'app',
          ok: true,
          text: healthy
            ? `The app on the new server answers${s.healthPath ? ` (${s.healthPath})` : ''}`
            : 'The app on the new server is running (its address could not be asked from the server itself)',
        },
      ],
      facts: { healthy },
      oldAppRunning: false,
    };
  }

  /** Starts the app on the old server again. Returns whether it is running. */
  private async startOld(p: DeployMovePayload): Promise<boolean> {
    const s = p.spec;
    const o = await this.script(
      s,
      'from',
      START_ONLY,
      [...this.common(s), s.appService],
      this.ms('restart_old'),
    );
    return o.result?.[0] === 'started';
  }

  private async restartOld(p: DeployMovePayload): Promise<DeployMoveResult> {
    const s = p.spec;
    // the new app is stopped first, so two copies never write to two databases; an unreachable new server does not stop the way back
    const stopped = await this.script(
      s,
      'to',
      STOP_ONLY,
      [...this.common(s), s.appService],
      this.ms('restart_old'),
    );
    const o = await this.script(
      s,
      'from',
      START_ONLY,
      [...this.common(s), s.appService],
      this.ms('restart_old'),
    );
    if (o.result?.[0] !== 'started') return this.fail('restart_old', 'from', o, { oldAppRunning: false });
    return {
      ok: true,
      step: 'restart_old',
      checks: [
        { id: 'old', ok: true, text: 'The app on the old server is running again' },
        {
          id: 'new',
          ok: stopped.result?.[0] === 'stopped',
          text:
            stopped.result?.[0] === 'stopped'
              ? 'The app on the new server is stopped'
              : 'The new server could not be reached to stop its app',
        },
      ],
      facts: {},
      oldAppRunning: true,
    };
  }

  // ------------------------------------------------------------------------------------------ retire

  private async retireKeys(p: DeployMovePayload): Promise<DeployMoveResult> {
    const o = await this.script(
      p.spec,
      'from',
      REVOKE_ALL_SCRIPT,
      [DEPLOY_KEY_COMMENT_PREFIX],
      this.ms('retire_keys'),
    );
    const n = Number(o.result?.[0]);
    if (o.code !== 0 || !Number.isFinite(n)) return this.fail('retire_keys', 'from', o);
    return {
      ok: true,
      step: 'retire_keys',
      checks: [
        {
          id: 'keys',
          ok: true,
          text: n
            ? `${n} Guildwise key${n === 1 ? '' : 's'} removed from the old server`
            : 'No Guildwise key was left on the old server',
        },
      ],
      facts: { removedKeys: n, ...(o.result?.[1] ? { keysBackup: o.result[1] } : {}) },
    };
  }

  // ------------------------------------------------------------------------------------------ the pipe

  /** `src | dst` through this computer: a stream, never a file. Both exit codes and (bounded) stderr are returned. */
  private pipe(
    srcArgs: string[],
    dstArgs: string[],
    timeoutMs: number,
  ): Promise<{
    srcCode: number | null;
    dstCode: number | null;
    srcErr: string;
    dstErr: string;
    dstOut: string;
    timedOut: boolean;
  }> {
    return new Promise((resolve) => {
      const src = spawn('ssh', srcArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: this.env });
      const dst = spawn('ssh', dstArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env });
      let srcErr = '';
      let dstErr = '';
      let dstOut = '';
      let srcCode: number | null = null;
      let dstCode: number | null = null;
      let doneSrc = false;
      let doneDst = false;
      let timedOut = false;
      const cap = (s: string, add: Buffer) => (s.length < 4000 ? s + add.toString('utf8') : s);
      const finish = () => {
        if (!doneSrc || !doneDst) return;
        clearTimeout(timer);
        resolve({
          srcCode,
          dstCode,
          srcErr: srcErr.slice(0, 600),
          dstErr: dstErr.slice(0, 600),
          dstOut: dstOut.slice(0, 4000),
          timedOut,
        });
      };
      const kill = (c: ChildProcess) => {
        try {
          c.kill('SIGKILL');
        } catch {
          // already gone
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill(src);
        kill(dst);
      }, timeoutMs);
      src.stderr?.on('data', (b: Buffer) => void (srcErr = cap(srcErr, b)));
      dst.stderr?.on('data', (b: Buffer) => void (dstErr = cap(dstErr, b)));
      dst.stdout?.on('data', (b: Buffer) => void (dstOut = cap(dstOut, b)));
      dst.stdin?.on('error', () => undefined);
      src.stdout?.pipe(dst.stdin as NodeJS.WritableStream);
      src.on('error', () => {
        doneSrc = true;
        srcCode = 127;
        kill(dst);
        finish();
      });
      dst.on('error', () => {
        doneDst = true;
        dstCode = 127;
        kill(src);
        finish();
      });
      src.on('close', (c) => {
        doneSrc = true;
        srcCode = c;
        finish();
      });
      dst.on('close', (c) => {
        doneDst = true;
        dstCode = c;
        // the destination gave up: stop reading from the source
        if (!doneSrc && c !== 0) kill(src);
        finish();
      });
    });
  }
}
