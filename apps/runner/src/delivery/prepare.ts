import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type DeployPreparePayload,
  type DeployPrepareResult,
  describePrepareAction,
  findSecret,
  type PrepareAction,
  type PrepareStepResult,
} from '@aom/shared';
import { remoteCommand } from './connect.ts';
import type { DeployKeys } from './deploy-keys.ts';
import { classifySsh, run } from './probe.ts';

/**
 * `deploy.prepare` (docs/design/deploy-run-ux-design.md section 7.4): bring a server (or a folder on this computer) to a state the
 * guided deploy can adopt, with a CLOSED list of idempotent actions and only after the person confirmed the list. Every action
 * checks first and does nothing when the thing is there: an existing folder, compose file, Docker or Caddy site is left as it is
 * ("adopt"), a file is never overwritten, a Caddyfile only gets one site appended after a dated copy and a successful validation
 * (and is put back when validation fails), and nothing is ever stopped, removed or restarted other than reloading Caddy.
 *
 * Server actions are fixed POSIX shell scripts run through `ssh` as an argument (no value is interpolated: arguments are quoted
 * and the script sees them as `$1 $2`). `dryRun` reports what would be done and changes nothing.
 */

export interface PrepareDeps {
  keys: DeployKeys;
  /** The checkout of a project repository on this computer, by its normalized remote address. */
  repoPath: (remote: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  connectSec?: number;
  commandMs?: number;
}

const MAX_COMPOSE_BYTES = 200_000;

const REMOTE_HEADER = `set -eu
SUDO=
if [ "$(id -u)" != 0 ]; then SUDO="sudo -n"; fi
step() { echo "AOM_STEP $1 $2"; }
die() { echo "AOM_ERROR $1 $2"; exit 3; }
`;

const INSTALL_DOCKER = `${REMOTE_HEADER}
dry=$1
if command -v docker >/dev/null 2>&1; then step skipped "Docker is already installed"; exit 0; fi
if [ "$dry" = 1 ]; then step would "install Docker with the system packages"; exit 0; fi
osr="\${AOM_OS_RELEASE:-/etc/os-release}"
[ -r "$osr" ] || die unsupported_os "cannot tell which system this is"
. "$osr"
case "\${ID:-} \${ID_LIKE:-}" in *debian*|*ubuntu*) ;; *) die unsupported_os "automatic install supports Debian and Ubuntu only (this is \${ID:-unknown})" ;; esac
if [ "$(id -u)" != 0 ]; then $SUDO true 2>/dev/null || die needs_root "installing Docker needs root or passwordless sudo"; fi
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -y >/dev/null 2>&1 || true
$SUDO apt-get install -y docker.io >/dev/null 2>&1 || die failed "apt could not install docker.io"
$SUDO apt-get install -y docker-compose-v2 >/dev/null 2>&1 || $SUDO apt-get install -y docker-compose-plugin >/dev/null 2>&1 || $SUDO apt-get install -y docker-compose >/dev/null 2>&1 || true
if command -v systemctl >/dev/null 2>&1; then $SUDO systemctl enable --now docker >/dev/null 2>&1 || true; fi
if [ "$(id -u)" != 0 ]; then $SUDO usermod -aG docker "$(id -un)" >/dev/null 2>&1 || true; fi
step done "Docker installed"
`;

const CREATE_DIR = `${REMOTE_HEADER}
dir=$1; dry=$2
if [ -d "$dir" ]; then step skipped "$dir already exists"; exit 0; fi
if [ "$dry" = 1 ]; then step would "create $dir"; exit 0; fi
if mkdir -p -- "$dir" 2>/dev/null; then step done "created $dir"; exit 0; fi
if [ "$(id -u)" != 0 ] && $SUDO mkdir -p -- "$dir" 2>/dev/null; then
  $SUDO chown "$(id -u):$(id -g)" "$dir" || die failed "could not take over $dir"
  step done "created $dir"; exit 0
fi
die needs_root "cannot create $dir (needs root or passwordless sudo)"
`;

/** The new file's content arrives on stdin; `noclobber` makes the create exclusive, so an existing file is never overwritten. */
const WRITE_FILE = `${REMOTE_HEADER}
file=$1; dry=$2
if [ -e "$file" ]; then step skipped "$file already exists and is kept"; exit 0; fi
if [ "$dry" = 1 ]; then step would "write $file"; exit 0; fi
mkdir -p -- "$(dirname "$file")" 2>/dev/null || die needs_root "cannot create the folder of $file"
( set -C; cat > "$file" ) 2>/dev/null || die failed "could not write $file"
step done "wrote $file"
`;

const CADDY_SITE = `${REMOTE_HEADER}
domain=$1; port=$2; dry=$3
site_in() { [ -f "$1" ] && grep -Eq "^[[:space:]]*$domain[[:space:]]*(,|\\\\{|\\$)" "$1"; }
caddy_cmd() { if command -v caddy >/dev/null 2>&1; then echo caddy; fi; }
block() {
  printf '\\n# added by Guildwise\\n%s {\\n\\treverse_proxy %s:%s\\n}\\n' "$domain" "$1" "$port"
}
upstream_ip=127.0.0.1
file=
mode=
name=
# an existing Caddy: a container first (its mounted Caddyfile), then a system service
if command -v docker >/dev/null 2>&1; then
  name=$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk '$2 ~ /caddy/ { print $1; exit }') || name=
  if [ -n "$name" ]; then
    file=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$name" 2>/dev/null) || file=
    nm=$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$name" 2>/dev/null) || nm=
    if [ "$nm" != host ]; then upstream_ip=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null) || upstream_ip=172.17.0.1; fi
    [ -n "$file" ] && mode=container
  fi
fi
if [ -z "$mode" ] && command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet caddy 2>/dev/null; then
  file="\${AOM_CADDYFILE:-/etc/caddy/Caddyfile}"; mode=system
fi
if [ -n "$mode" ]; then
  [ -f "$file" ] || die failed "Caddy runs but its Caddyfile $file cannot be found"
  if site_in "$file"; then step skipped "$domain is already served by Caddy and is kept as it is"; exit 0; fi
  if [ "$dry" = 1 ]; then step would "add $domain to $file (a dated copy is made first)"; exit 0; fi
  bak="$file.guildwise-bak-$(date +%Y%m%d%H%M%S)"
  $SUDO cp -p -- "$file" "$bak" || die needs_root "cannot copy $file"
  { block "$upstream_ip"; } | $SUDO tee -a "$file" >/dev/null || { $SUDO cp -p -- "$bak" "$file"; die failed "cannot write $file"; }
  if [ "$mode" = container ]; then
    if ! docker exec "$name" caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then $SUDO cp -p -- "$bak" "$file"; die failed "Caddy did not accept the new site; the Caddyfile was put back"; fi
    docker exec "$name" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die failed "Caddy could not reload"
  else
    if [ -n "$(caddy_cmd)" ] && ! $SUDO caddy validate --config "$file" >/dev/null 2>&1; then $SUDO cp -p -- "$bak" "$file"; die failed "Caddy did not accept the new site; the Caddyfile was put back"; fi
    $SUDO systemctl reload caddy >/dev/null 2>&1 || die failed "Caddy could not reload"
  fi
  step done "added $domain to $file (copy: $bak)"; exit 0
fi
# no Caddy: start our own, only when nothing else answers on 80 and 443
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq ':(80|443)$'; then die port_in_use "something else already uses port 80 or 443"; fi
command -v docker >/dev/null 2>&1 || die failed "Docker is needed to start Caddy"
if [ "$dry" = 1 ]; then step would "start Caddy in a container for $domain (folder \${AOM_CADDY_DIR:-/opt/caddy})"; exit 0; fi
cdir="\${AOM_CADDY_DIR:-/opt/caddy}"
if [ ! -d "$cdir" ]; then mkdir -p "$cdir" 2>/dev/null || { $SUDO mkdir -p "$cdir" && $SUDO chown "$(id -u):$(id -g)" "$cdir"; } || die needs_root "cannot create $cdir"; fi
if [ ! -e "$cdir/Caddyfile" ]; then block 127.0.0.1 | sed '1{/^$/d}' > "$cdir/Caddyfile"; fi
docker run -d --name guildwise-caddy --restart unless-stopped --network host -v "$cdir/Caddyfile:/etc/caddy/Caddyfile" -v guildwise_caddy_data:/data caddy:2 >/dev/null 2>&1 || die failed "could not start Caddy"
step done "started Caddy for $domain"
`;

const START_SERVICES = `${REMOTE_HEADER}
file=$1; project=$2; dry=$3; shift 3
dc() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi; }
command -v docker >/dev/null 2>&1 || die failed "Docker is not installed"
if dc ls --all --format json 2>/dev/null | grep -q "\\"Name\\":\\"$project\\""; then step skipped "the project $project already exists and is not touched"; exit 0; fi
svcs=$(dc -p "$project" -f "$file" config --services 2>/dev/null) || die failed "the compose file $file is not valid"
want=
for s in $svcs; do skip=0; for e in "$@"; do [ "$s" = "$e" ] && skip=1; done; [ "$skip" = 1 ] || want="$want $s"; done
[ -n "$want" ] || { step skipped "nothing to start"; exit 0; }
if [ "$dry" = 1 ]; then step would "start$want"; exit 0; fi
dc -p "$project" -f "$file" up -d $want </dev/null || die failed "could not start$want"
step done "started$want"
`;

interface Out {
  steps: PrepareStepResult[];
  error?: { code: NonNullable<DeployPrepareResult['error']>; detail: string };
}

const ERROR_CODES = new Set(['needs_root', 'unsupported_os', 'port_in_use', 'failed']);

export class DeployPreparer {
  constructor(private readonly deps: PrepareDeps) {}

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  async run(p: DeployPreparePayload): Promise<DeployPrepareResult> {
    const out: Out = { steps: [] };
    for (const a of p.actions) {
      const step =
        p.hosting === 'ssh' ? await this.remoteAction(p, a, p.dryRun) : await this.localAction(a, p.dryRun);
      out.steps.push(step.result);
      if (step.error) {
        out.error = step.error;
        break;
      }
    }
    const failed = !!out.error;
    return {
      ok: !failed,
      ...(out.error ? { error: out.error.code, detail: out.error.detail.slice(0, 380) } : {}),
      steps: out.steps,
    };
  }

  // ----------------------------------------------------------------------------------------------- a server

  private sshArgs(p: DeployPreparePayload): string[] {
    const cfg = this.deps.keys.sshConfigFor(p.targetId, p.alias);
    return [
      ...(cfg ? ['-F', cfg] : []),
      '-o',
      `ConnectTimeout=${this.deps.connectSec ?? 10}`,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'LogLevel=ERROR',
      '--',
      p.alias as string,
    ];
  }

  private async remote(
    p: DeployPreparePayload,
    script: string,
    args: string[],
    input?: string,
  ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
    const r = await run('ssh', [...this.sshArgs(p), remoteCommand(script, ...args)], {
      timeoutMs: this.deps.commandMs ?? 600_000,
      env: this.env,
      ...(input !== undefined ? { input } : {}),
    });
    return r;
  }

  private async remoteAction(
    p: DeployPreparePayload,
    a: PrepareAction,
    dry: boolean,
  ): Promise<{ result: PrepareStepResult; error?: Out['error'] }> {
    const d = dry ? '1' : '0';
    let script: string;
    let args: string[];
    let input: string | undefined;
    switch (a.kind) {
      case 'install_docker':
        script = INSTALL_DOCKER;
        args = [d];
        break;
      case 'create_dir':
        script = CREATE_DIR;
        args = [a.path, d];
        break;
      case 'write_compose': {
        const text = await this.repoFile(a);
        if ('error' in text) return this.fail(a, 'repo_file_missing', text.error);
        script = WRITE_FILE;
        args = [a.path, d];
        input = text.content;
        break;
      }
      case 'caddy_site':
        script = CADDY_SITE;
        args = [a.domain, String(a.upstreamPort), d];
        break;
      case 'start_services':
        script = START_SERVICES;
        args = [a.composeFile, a.project, d, ...a.except];
        break;
    }
    if (!p.alias) return this.fail(a, 'bad_request', 'a server name is needed');
    const r = await this.remote(p, script, args, input);
    if (r.timedOut) return this.fail(a, 'timeout', 'the server did not answer in time');
    const step = /AOM_STEP (done|skipped|would) (.*)/.exec(r.stdout);
    const err = /AOM_ERROR (\w+) (.*)/.exec(r.stdout);
    if (err) {
      const code = ERROR_CODES.has(err[1] as string) ? (err[1] as 'failed') : 'failed';
      return this.fail(a, code, err[2] as string);
    }
    if (r.code !== 0 || !step) {
      const c = classifySsh(r as never);
      return c.state === 'reachable'
        ? this.fail(
            a,
            'failed',
            (r.stderr.split('\n').find(Boolean) ?? 'the server gave no answer').slice(0, 200),
          )
        : this.fail(a, 'unreachable', c.detail ?? 'cannot sign in to the server');
    }
    return {
      result: { kind: a.kind, outcome: step[1] as 'done', detail: (step[2] as string).slice(0, 380) },
    };
  }

  private fail(
    a: PrepareAction,
    code: NonNullable<DeployPrepareResult['error']>,
    detail: string,
  ): { result: PrepareStepResult; error: Out['error'] } {
    return {
      result: { kind: a.kind, outcome: 'failed', detail: detail.slice(0, 380) },
      error: { code, detail: `${describePrepareAction(a).slice(0, 90)} ${detail}`.slice(0, 380) },
    };
  }

  /** The file from the project's checkout on this computer: inside the repository, small, no secrets. */
  private async repoFile(
    a: Extract<PrepareAction, { kind: 'write_compose' }>,
  ): Promise<{ content: string } | { error: string }> {
    if (!a.remote) return { error: 'the project’s code is not known to this computer' };
    const root = await this.deps.repoPath(a.remote);
    if (!root) return { error: 'the project’s code is not on this computer' };
    const file = resolve(root, a.repoPath);
    const rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) return { error: 'that file is outside the project' };
    try {
      if (!existsSync(file)) return { error: `${a.repoPath} is not in the project` };
      if (lstatSync(file).isSymbolicLink() || realpathSync(file) !== join(realpathSync(root), rel))
        return { error: `${a.repoPath} is a link; Guildwise only copies plain files` };
      if (statSync(file).size > MAX_COMPOSE_BYTES) return { error: `${a.repoPath} is too big` };
      const content = readFileSync(file, 'utf8');
      const secret = findSecret(content);
      if (secret) return { error: `${a.repoPath} contains ${secret}: it will not be copied to a server` };
      return { content };
    } catch (err) {
      return {
        error: `could not read ${a.repoPath}: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          200,
        ),
      };
    }
  }

  // ----------------------------------------------------------------------------------------------- this computer

  private async localAction(
    a: PrepareAction,
    dry: boolean,
  ): Promise<{ result: PrepareStepResult; error?: Out['error'] }> {
    const home = this.deps.home ?? homedir();
    const abs = (x: string) => (x.startsWith('~/') ? join(home, x.slice(2)) : x);
    switch (a.kind) {
      case 'install_docker':
      case 'caddy_site':
        return this.fail(a, 'bad_request', 'this is only done on a server');
      case 'create_dir': {
        const dir = abs(a.path);
        if (existsSync(dir))
          return { result: { kind: a.kind, outcome: 'skipped', detail: `${dir} already exists` } };
        if (dry) return { result: { kind: a.kind, outcome: 'would', detail: `create ${dir}` } };
        try {
          mkdirSync(dir, { recursive: true });
        } catch (err) {
          return this.fail(a, 'failed', `could not create ${dir}: ${String(err).slice(0, 120)}`);
        }
        return { result: { kind: a.kind, outcome: 'done', detail: `created ${dir}` } };
      }
      case 'write_compose': {
        const dest = abs(a.path);
        if (existsSync(dest))
          return {
            result: { kind: a.kind, outcome: 'skipped', detail: `${dest} already exists and is kept` },
          };
        const text = await this.repoFile(a);
        if ('error' in text) return this.fail(a, 'repo_file_missing', text.error);
        if (dry) return { result: { kind: a.kind, outcome: 'would', detail: `write ${dest}` } };
        try {
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, text.content, { flag: 'wx', mode: 0o644 });
        } catch (err) {
          return this.fail(a, 'failed', `could not write ${dest}: ${String(err).slice(0, 120)}`);
        }
        return { result: { kind: a.kind, outcome: 'done', detail: `wrote ${dest}` } };
      }
      case 'start_services': {
        const file = abs(a.composeFile);
        const ls = await run('docker', ['compose', 'ls', '--all', '--format', 'json'], {
          timeoutMs: 15_000,
          env: this.env,
        });
        if (ls.missing) return this.fail(a, 'failed', 'Docker is not installed on this computer');
        if (ls.stdout.includes(`"Name":"${a.project}"`))
          return {
            result: {
              kind: a.kind,
              outcome: 'skipped',
              detail: `the project ${a.project} already exists and is not touched`,
            },
          };
        const cfg = await run('docker', ['compose', '-p', a.project, '-f', file, 'config', '--services'], {
          timeoutMs: 20_000,
          env: this.env,
        });
        if (cfg.code !== 0) return this.fail(a, 'failed', `the compose file ${file} is not valid`);
        const want = cfg.stdout
          .split('\n')
          .map((x) => x.trim())
          .filter((x) => x && !a.except.includes(x));
        if (!want.length) return { result: { kind: a.kind, outcome: 'skipped', detail: 'nothing to start' } };
        if (dry) return { result: { kind: a.kind, outcome: 'would', detail: `start ${want.join(', ')}` } };
        const up = await run('docker', ['compose', '-p', a.project, '-f', file, 'up', '-d', ...want], {
          timeoutMs: 600_000,
          env: this.env,
        });
        if (up.code !== 0)
          return this.fail(a, 'failed', `could not start ${want.join(', ')}: ${up.stderr.slice(0, 150)}`);
        return { result: { kind: a.kind, outcome: 'done', detail: `started ${want.join(', ')}` } };
      }
    }
  }
}
