import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CARD_BRANCH_PREFIXES, type DevopsAuditEntry, normalizeRemoteUrl } from '@aom/shared';
import { redactSecrets } from '../redact.ts';
import { HOME_SECRET_ENTRIES } from './home-secrets.ts';

/**
 * Guardrails of the DevOps engineer (the one agent that runs outside the OS sandbox, as the user). Enforced by a Claude
 * Code PreToolUse hook on every Bash command (`aom devops-guard`, wired in claude-policy.ts):
 *
 * - always refused: deleting outside the worktrees and the runner's data folders, disk and partition tools, user, sudo
 *   and password changes (nothing on the runner runs as root since 1.10.0), force-pushing a protected branch, dropping a database;
 * - refused unless the manager approved that exact command: anything that leaves this workstation (ssh, scp, rsync to a
 *   remote, docker against another host, kubectl, cloud CLIs): the message says to ask with `aom devops-approval`;
 * - every command, allowed or refused, is appended to an audit log on the workstation and reported to the server.
 *
 * This is a guardrail for an agent that follows instructions, not a security boundary against one that is trying to get
 * around it (`python -c`, a script it wrote itself). The classifier reads the shell command line: pipes, `&&`, `;`,
 * `$( )`, backticks, `bash -c`, `eval` and common wrappers (`env`, `nohup`, `timeout`, `xargs`) are looked through.
 */

export interface GuardConfig {
  sessionRef: string;
  kind: 'shift' | 'chat';
  /** Folders deleting is allowed in (strictly inside): the worktrees and the runner's data folders, the OS temp dir. */
  deleteRoots: string[];
  home: string;
  /** Besides main and master: branches that may never be force-pushed (the projects' working branches). */
  protectedBranches: string[];
  /** Commands the manager approved (`devops.approval.commands`): allowed although they leave the workstation. */
  approvedCommands: string[];
  /** Local copy of the audit log, appended by the hook itself when the runner cannot be reached. */
  auditFile?: string;
  /** A "Scan with DevOps" shift: read-only. Commands that start, build, install, connect or write are refused (`scanVerdict`). */
  readOnlyScan?: boolean;
  /** Folders a scan may not read at all (the runner's secrets and keys), besides the user's own credential folders. */
  secretRoots?: string[];
  /** For a shift: its kind, copied into every audit entry. */
  shiftKind?: 'devops' | 'release_prep';
  /** Branches this session may not change at all (release prep: the release branch). Empty for devops shifts and chats. */
  frozenBranches?: string[];
  /**
   * Repositories of the shift's plan that post as an app (normalized remote, app label, bot e-mail; no secret). Raw
   * network git, `gh` writes and commits not made as the bot are refused there (`app_repo`). Absent or empty (projects
   * without an app): no refusal of this kind at all.
   */
  appRepos?: Array<{ remote: string; label: string; botEmail: string }>;
  /** The commit e-mail of the session's environment (the bot's on a card request for an app repository). */
  identityEmail?: string;
  /**
   * uat-runner-fixes-3 finding 2: the card worktrees folder (`<runner root>/worktrees`). The DevOps engineer never writes
   * or commits there and never moves a card branch, whatever a request, a prompt or an approval says: a command that runs
   * in a card worktree or names a path in it is refused unless it only reads (`card_worktree`). The runner also checks
   * the card worktrees after the shift and reverts what changed (devops/card-fence.ts); this is the early refusal.
   */
  cardWorktreesRoot?: string;
  /**
   * T4: installs in this session run with scripts off (devops/install-env.ts). Yarn 1, Bun and Composer have no safe
   * environment switch, so their install commands need the script-free flag (`install_scripts`).
   */
  installScriptsOff?: boolean;
  /**
   * T2: the local authority's folder (`~/.config/aom-runner`). Nothing may be read from, written to or run in it, and the
   * runner's own CLI runs only its read-only verbs (`policyFence`). An approval never lifts this.
   */
  policyRoot?: string;
  /**
   * runner-authority-fixes T10: the workstation's DevOps access switches, already narrowed by the local policy. Set for
   * DevOps shifts and chats (a chat without `devopsAccess` from the server gets every switch off). Absent (release prep,
   * old configuration): the switches are not enforced here.
   */
  access?: { allowInstall: boolean; allowDocker: boolean; allowedPaths: string[] };
  /**
   * gate-fixes-1 F3 (outer box): Docker is opened only by the switch, never by the approval of a command. The socket is the
   * authority (with it, any script reaches the whole proxied API), so `docker_off` is not lifted by `approvedCommands`.
   */
  dockerSwitchOnly?: boolean;
  /**
   * gate-fixes-1 F3: Docker cannot be reached in this session at all (no daemon, or off on this computer), with the reason.
   * Docker commands are refused as `docker_unavailable`, which no switch and no approval opens (no website ask follows).
   */
  dockerUnavailable?: string;
  /**
   * T10 `paths`: where this session may write without the paths switch (scratch, the agent's tmp and home, the OS temp
   * folders; with installs on also the toolchain detection roots). `access.allowedPaths` are added to these.
   */
  writeRoots?: string[];
  /**
   * gate-fixes-3 (c, S3): an approved outside run with the local "download tools" tick. `roots`: the Guildwise tool folder
   * (every spelling); `dirs`: its `devops` folder, where new `<tool>/<version>` folders may be written; `pinned`: the DevOps
   * subroots already pinned (read-only). Any other write in `roots` is `toolchain_fixed`, which no switch and no approval
   * opens. Absent: the tool folder is like any other path (the paths switch).
   */
  toolchainWrite?: { roots: string[]; dirs: string[]; pinned: string[] };
}

/** Lookups the classifier needs from the machine, injected so `classifyCommand` stays pure. */
export interface GuardDeps {
  /** The branch checked out in a directory: null when detached or not a repository, 'unknown' when it cannot be told. */
  headBranch?: (dir: string) => string | null | 'unknown';
  /** The normalized origin URL of the repository a directory is in; null when none or not a repository. */
  originUrl?: (dir: string) => string | null;
}

export interface GuardVerdict {
  decision: 'allowed' | 'refused';
  /** The rule that refused it, or the class an allowed command fell in (`ok`, `aom`, `off_workstation_approved`). */
  rule: string;
  /** For the agent, on a refusal. */
  reason?: string;
  /** T10 `paths`: the path the refused command writes (the runner offers its folder for "Always allow"). */
  target?: string;
}

/** The runner's data folders a DevOps command may delete in (relative to the runner root). */
export const DELETE_ROOT_DIRS = [
  'worktrees',
  'integration',
  'cache',
  'agents',
  'vaults',
  'logs',
  'mock-state',
  'outbound',
];

export function deleteRootsFor(runnerRoot: string, osTmp: string = tmpdir()): string[] {
  return [...DELETE_ROOT_DIRS.map((d) => join(runnerRoot, d)), osTmp, '/tmp', '/var/tmp'];
}

export const PROTECTED_BRANCHES = ['main', 'master', 'develop', 'trunk'];

// ------------------------------------------------------------------------------------------ shell parsing

interface Segment {
  /** The words of the simple command, quotes removed. */
  words: string[];
  /** The text of the segment as written (for matching approvals and the audit). */
  raw: string;
  /** Targets of `>`, `>>`, `2>`, `&>` redirects. */
  redirects: string[];
}

/** Splits a command line into simple commands at `;`, `&&`, `||`, `|`, `&` and newlines (quotes and escapes respected). */
export function splitSegments(line: string): Segment[] {
  const segs: Segment[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let cur = '';
  let curQuoted = false;
  let raw = '';
  let q: '"' | "'" | null = null;
  let redirectNext = false;
  const endWord = () => {
    if (cur !== '' || curQuoted) {
      if (redirectNext) redirects.push(cur);
      else words.push(cur);
      redirectNext = false;
    }
    cur = '';
    curQuoted = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length > 0 || redirects.length > 0) segs.push({ words, raw: raw.trim(), redirects });
    words = [];
    redirects = [];
    raw = '';
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (q) {
      raw += c;
      if (c === q) q = null;
      else if (q === '"' && c === '\\' && i + 1 < line.length) {
        cur += line[i + 1];
        raw += line[i + 1];
        i++;
      } else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      curQuoted = true;
      raw += c;
      continue;
    }
    if (c === '\\' && i + 1 < line.length) {
      cur += line[i + 1];
      raw += c + line[i + 1];
      i++;
      continue;
    }
    if (c === '\n' || c === ';') {
      endSeg();
      continue;
    }
    if (c === '|' || c === '&') {
      // `&&`, `||`, `|&`, `&>` and `2>&1`
      const next = line[i + 1];
      if (c === '&' && next === '>') {
        endWord();
        redirectNext = true;
        i += next === '>' && line[i + 2] === '>' ? 2 : 1;
        continue;
      }
      if (c === '&' && cur.endsWith('>')) {
        cur += c; // `2>&1`
        raw += c;
        continue;
      }
      if (next === c || (c === '|' && next === '&')) i++;
      endSeg();
      continue;
    }
    if (c === '>' || c === '<') {
      if (c === '>') {
        // `2>`, `>>`: the digit before belongs to the redirect, not to a word
        if (/^\d+$/.test(cur)) cur = '';
        endWord();
        if (line[i + 1] === '>') i++;
        if (line[i + 1] === '&') {
          i++;
          raw += '>&';
          // `>&2` and `>&-` name a descriptor; `>&out.txt` writes a FILE (bash treats it like `&>out.txt`)
          if (/[\d-]/.test(line[i + 1] ?? '')) {
            while (/\d|-/.test(line[i + 1] ?? '')) i++;
          } else redirectNext = true;
          continue;
        }
        redirectNext = true;
        raw += c;
        continue;
      }
      endWord();
      raw += c;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      raw += c;
      continue;
    }
    cur += c;
    raw += c;
  }
  endSeg();
  return segs;
}

/** Command substitutions (`$( )` and backticks) of a line: each inner command line, recursively flat. */
export function substitutions(line: string): string[] {
  const out: string[] = [];
  let inSingle = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === "'") inSingle = !inSingle;
    if (inSingle) continue;
    if (c === '$' && line[i + 1] === '(' && line[i + 2] !== '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < line.length && depth > 0; j++) {
        if (line[j] === '(') depth++;
        else if (line[j] === ')') depth--;
      }
      const inner = line.slice(i + 2, j - 1);
      out.push(inner, ...substitutions(inner));
      i = j - 1;
    } else if (c === '`') {
      const end = line.indexOf('`', i + 1);
      if (end > i) {
        const inner = line.slice(i + 1, end);
        out.push(inner, ...substitutions(inner));
        i = end;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------- the rules

const DISK_TOOLS = new Set([
  'fdisk',
  'sfdisk',
  'cfdisk',
  'parted',
  'gparted',
  'partprobe',
  'mkswap',
  'wipefs',
  'resize2fs',
  'tune2fs',
  'e2fsck',
  'fsck',
  'lvremove',
  'lvreduce',
  'lvresize',
  'vgremove',
  'pvremove',
  'lvcreate',
  'vgcreate',
  'pvcreate',
  'cryptsetup',
  'blkdiscard',
  'diskpart',
  'format',
  'mount',
  'umount',
  'losetup',
  'sgdisk',
  'gdisk',
  'zpool',
  'zfs',
  'btrfs',
  'mdadm',
]);
const USER_TOOLS = new Set([
  'useradd',
  'userdel',
  'usermod',
  'adduser',
  'deluser',
  'groupadd',
  'groupdel',
  'groupmod',
  'addgroup',
  'delgroup',
  'passwd',
  'chpasswd',
  'chsh',
  'chfn',
  'visudo',
  'vipw',
  'vigr',
  'newusers',
  'gpasswd',
  'sudoedit',
]);
const PRIVILEGE_WRAPPERS = new Set(['sudo', 'su', 'doas', 'pkexec', 'run0']);
const REMOTE_TOOLS = new Set([
  'ssh',
  'scp',
  'sftp',
  'sshfs',
  'sshpass',
  'mosh',
  'autossh',
  'kubectl',
  'kubectx',
  'helm',
  'k9s',
  'oc',
  'eksctl',
  'aws',
  'az',
  'gcloud',
  'gsutil',
  'bq',
  'doctl',
  'heroku',
  'fly',
  'flyctl',
  'vercel',
  'netlify',
  'terraform',
  'tofu',
  'pulumi',
  'ansible',
  'ansible-playbook',
  'linode-cli',
  'hcloud',
  'scw',
  'ibmcloud',
  'oci',
  'aliyun',
  'railway',
  'supabase',
  'firebase',
  'wrangler',
]);
const DOCKER_LIKE = new Set(['docker', 'docker-compose', 'podman', 'nerdctl']);
const DB_DROP =
  /\bdrop\s+(database|schema)\b|\bdropDatabase\b|\bflushall\b|\bflushdb\b|\bmysqladmin\b.*\bdrop\b/i;
/** Tools that run a statement against a database: the drop rule looks at the statement only when one is in the command. */
const DB_TOOLS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'mongo',
  'mongosh',
  'redis-cli',
  'sqlcmd',
  'cockroach',
  'clickhouse-client',
  'dropdb',
  'mysqladmin',
  'pg_ctl',
]);
const SYSTEM_FILES = /^\/etc\/(sudoers(\.d(\/.*)?)?|passwd|shadow|group|gshadow|subuid|subgid)$/;
const BLOCK_DEVICE = /^\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|loop|dm-|md|mapper\/|disk\/)/;
/** Words that only wrap another command; the wrapped command is judged. */
const WRAPPERS = new Set([
  'env',
  'nohup',
  'time',
  'command',
  'exec',
  'nice',
  'ionice',
  'timeout',
  'stdbuf',
  'setsid',
  'builtin',
  'xargs',
  'chronic',
  'unbuffer',
]);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

const normWs = (s: string): string => s.trim().replace(/\s+/g, ' ');
const baseName = (w: string): string => w.slice(w.lastIndexOf('/') + 1);
const isAssign = (w: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

/** What a refused root step says since 1.10.0 (no `aom sudo`, no sudo grant). */
const OWNER_TEXT = 'this runner has no root (1.10.0): tell the machine owner the exact command to run';

interface Ctx {
  cfg: GuardConfig;
  cwd: string;
  usedApproval: boolean;
  deps: GuardDeps;
  /** T10 (R3-B2): the whole line was approved: only the rules in APPROVAL_LIFTS are lifted. */
  lift?: boolean;
}

/**
 * runner-authority-fixes T10 (R3-B2): the only guard rules a manager's approval of an exact command lifts. Never the card
 * worktrees, the policy fence, secrets, the delete floor, protected or frozen branches, app repositories or user admin.
 */
export const APPROVAL_LIFTS: ReadonlySet<string> = new Set([
  'off_workstation',
  'install_off',
  'docker_off',
  'paths',
]);

/** T10: the guard rule of each switch, and the `aom devops-approval --switch` word. */
export const SWITCH_OF_RULE: Readonly<
  Record<string, { word: 'install' | 'docker' | 'paths'; label: string }>
> = {
  install_off: { word: 'install', label: 'installs are off' },
  docker_off: { word: 'docker', label: 'Docker is off' },
  paths: { word: 'paths', label: 'writing outside the allowed folders is off' },
};

const inside = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

/** The absolute path an argument means, or null when it cannot be known (variables, command substitution). */
export function resolveArg(arg: string, cwd: string, home: string): string | null {
  let a = arg;
  if (a === '~' || a.startsWith('~/')) a = join(home, a.slice(1));
  a = a.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (/[$`]/.test(a)) return null;
  return resolve(cwd, a);
}

/** Is deleting `arg` allowed: strictly inside a delete root (a glob that lands on the root itself counts as inside). */
function deletable(arg: string, c: Ctx): boolean {
  const glob = /[*?[]/.test(arg);
  // the literal part before the first glob segment
  let literal = arg;
  if (glob) {
    const parts = arg.split('/');
    const keep: string[] = [];
    for (const p of parts) {
      if (/[*?[]/.test(p)) break;
      keep.push(p);
    }
    literal = keep.join('/') || (arg.startsWith('/') ? '/' : '.');
  }
  const abs = resolveArg(literal, c.cwd, c.cfg.home);
  if (abs === null) return false;
  return c.cfg.deleteRoots.some((root) => {
    const r = resolve(root);
    return inside(abs, r) || (glob && abs === r);
  });
}

function refuse(rule: string, reason: string): GuardVerdict {
  return { decision: 'refused', rule, reason };
}
const ok = (rule = 'ok'): GuardVerdict => ({ decision: 'allowed', rule });

const ASK =
  'Ask for approval with `aom devops-approval --action "<what>" --reason "<why>" --command "<the exact command>"`; the shift then ends and resumes after the manager approves, with that command allowed.';

/** The segment itself was approved (or the whole line, `c.lift`): a lift-able rule lets it pass. */
function approvedHere(c: Ctx, seg: Segment): boolean {
  const norm = normWs(seg.raw);
  if (c.lift || c.cfg.approvedCommands.some((a) => normWs(a) === norm)) {
    c.usedApproval = true;
    return true;
  }
  return false;
}

/**
 * T10 (D5): a switch the owner turned off refuses, and the refusal asks: in a shift with `aom devops-approval --switch`,
 * which the runner checks against this refusal before the Desk item reads "installs are off on this computer".
 */
function switchRefusal(
  c: Ctx,
  seg: Segment,
  rule: 'install_off' | 'docker_off' | 'paths',
  what: string,
  target?: string,
): GuardVerdict {
  const sw = SWITCH_OF_RULE[rule] as { word: string; label: string };
  const cmd = normWs(seg.raw).replace(/"/g, '\\"');
  const ask =
    c.cfg.kind === 'chat'
      ? `In a chat, tell the owner the exact command (\`${normWs(seg.raw)}\`): they file it as a DevOps request to allow it once, or turn the switch on to always allow it.`
      : `Ask with \`aom devops-approval --switch ${sw.word} --command "${cmd}" --action "<what>" --reason "<why>"\`; the owner allows it once or always.`;
  return { ...refuse(rule, `${what}: ${sw.label} on this computer. ${ask}`), ...(target ? { target } : {}) };
}

/**
 * gate-fixes-1 F3: `docker_off` in the outer box. An approval of the single command cannot open Docker (the socket gives the
 * whole proxied API), so the refusal asks for the switch: the owner turns Docker on for this workstation, once.
 */
function dockerSwitchRefusal(c: Ctx, seg: Segment, cmd: string): GuardVerdict {
  const line = normWs(seg.raw).replace(/"/g, '\\"');
  return refuse(
    'docker_off',
    `\`${cmd}\`: Docker is off on this computer for this workstation. Only the Docker switch opens it (an approval of one command cannot). Ask with \`aom devops-approval --switch docker --command "${line}" --action "<what>" --reason "<why>"\`; the owner turns Docker on for this workstation and the request continues with Docker through the runner's gatekeeper.`,
  );
}

/** Package managers and installers (T10 `install_off`); `toolchain.add` is not one (the D2 pin gates it). */
const SYSTEM_PMS = new Set([
  'apt',
  'apt-get',
  'aptitude',
  'dnf',
  'yum',
  'zypper',
  'pacman',
  'apk',
  'snap',
  'flatpak',
  'port',
]);
const JS_PMS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cnpm']);
function installVerdict(cmd: string, words: string[], c: Ctx, seg: Segment): GuardVerdict | null {
  const args = words.slice(1);
  const sub = args.find((a) => !a.startsWith('-'));
  let what: string | null = null;
  if (SYSTEM_PMS.has(cmd) && sub && /^(install|reinstall|add|upgrade|dist-upgrade|refresh|update)$/.test(sub))
    what = `\`${cmd} ${sub}\``;
  else if (cmd === 'brew' && sub && /^(install|reinstall|upgrade|tap)$/.test(sub)) what = `\`brew ${sub}\``;
  else if (/^(pip|pip3|pipx)$/.test(cmd) && sub && /^(install|inject|upgrade)$/.test(sub))
    what = `\`${cmd} ${sub}\``;
  else if (
    /^python3?$/.test(cmd) &&
    args[0] === '-m' &&
    /^pip/.test(args[1] ?? '') &&
    args.includes('install')
  )
    what = '`python -m pip install`';
  else if (
    cmd === 'uv' &&
    (args.slice(0, 2).join(' ') === 'tool install' || args.slice(0, 2).join(' ') === 'pip install')
  )
    what = `\`uv ${args.slice(0, 2).join(' ')}\``;
  else if (
    JS_PMS.has(cmd) &&
    (sub === undefined ? cmd === 'yarn' : /^(add|a|install|i|in|ci|global|upgrade|up|update)$/.test(sub))
  )
    what = `\`${cmd} ${sub ?? 'install'}\``;
  else if (JS_PMS.has(cmd) && args.some((a) => a === '-g' || a === '--global')) what = `\`${cmd} --global\``;
  else if (
    /^(cargo|go|gem|dotnet)$/.test(cmd) &&
    (sub === 'install' || (cmd === 'dotnet' && args.slice(0, 2).join(' ') === 'tool install'))
  )
    what = `\`${cmd} install\``;
  if (!what) return null;
  return approvedHere(c, seg) ? ok('install_approved') : switchRefusal(c, seg, 'install_off', what);
}

/** Commands that write the path(s) they name (T10 `paths`): which arguments are targets. */
const WRITE_LAST = new Set(['cp', 'mv', 'ln', 'install', 'rsync']);
const WRITE_ALL = new Set(['tee', 'touch', 'mkdir', 'truncate']);

/** T10: may this session write `abs` without the paths switch (its own folders, plus allowed paths that are safe)? */
function writable(abs: string, c: Ctx): boolean {
  const roots = [
    ...(c.cfg.writeRoots ?? []),
    ...(c.cfg.access?.allowedPaths ?? []).filter(
      (p) =>
        isAbsolute(p) &&
        alwaysPathRefusal(p, {
          home: c.cfg.home,
          policyRoot: c.cfg.policyRoot,
          worktrees: c.cfg.cardWorktreesRoot,
          runnerRoot: c.cfg.cardWorktreesRoot ? dirname(resolve(c.cfg.cardWorktreesRoot)) : undefined,
        }) === null,
    ),
  ];
  if (
    abs === '/dev/null' ||
    abs.startsWith('/dev/fd/') ||
    abs === '/dev/stdout' ||
    abs === '/dev/stderr' ||
    abs === '/dev/tty'
  )
    return true;
  return roots.some((r) => abs === resolve(r) || inside(abs, resolve(r)));
}

function pathsVerdict(cmd: string, words: string[], c: Ctx, seg: Segment): GuardVerdict | null {
  const targets: string[] = [...seg.redirects];
  const args = words.slice(1).filter((a) => !a.startsWith('-'));
  if (WRITE_LAST.has(cmd) && args.length >= 2) targets.push(args[args.length - 1] as string);
  else if (WRITE_ALL.has(cmd)) targets.push(...args);
  else if (cmd === 'sed' && words.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place')))
    targets.push(...args.slice(1));
  else if (cmd === 'dd') for (const w of words) if (w.startsWith('of=')) targets.push(w.slice(3));
  for (const t of targets) {
    const abs = resolveArg(t, c.cwd, c.cfg.home);
    if (abs === null) continue;
    const tc = toolchainVerdict(abs, t, c);
    if (tc === 'ok') continue;
    if (tc) return tc;
    if (writable(abs, c)) continue;
    if (approvedHere(c, seg)) return ok('paths_approved');
    return switchRefusal(c, seg, 'paths', `Writing ${t}`, abs);
  }
  return null;
}

/**
 * gate-fixes-3 (S3): a write in the Guildwise tool folder of an outside run with `toolchainWrite`: 'ok' inside its `devops`
 * folder but outside every pinned subroot, `toolchain_fixed` (a hard refusal, no switch) anywhere else in the tool folder;
 * null when the path is not in the tool folder at all (the usual rules).
 */
function toolchainVerdict(abs: string, written: string, c: Ctx): GuardVerdict | 'ok' | null {
  const tw = c.cfg.toolchainWrite;
  if (!tw) return null;
  const within = (p: string, r: string): boolean => p === resolve(r) || inside(p, resolve(r));
  if (!tw.roots.some((r) => within(abs, r))) return null;
  if (tw.dirs.some((d) => within(abs, d)) && !tw.pinned.some((p) => within(abs, p))) return 'ok';
  return refuse('toolchain_fixed', toolchainFixedReason(written, tw.dirs[0]));
}

/** gate-fixes-3: the `toolchain_fixed` message (the guard's and the runner's own check of an approval ask). */
export function toolchainFixedReason(written: string, devopsDir: string | undefined): string {
  const dir = devopsDir ?? 'the DevOps tools folder';
  return `Writing ${written}: the Guildwise tool folder is fixed outside ${dir}, and an approved tool version there is read-only. No approval opens it (do not ask with \`aom devops-approval\`): install into a new ${dir}/<tool>/<version> folder, then register it with \`aom toolchain add\`.`;
}

/**
 * gate-fixes-3 (REVIEW S-2): a path in the Guildwise tool folder outside the writable DevOps folder (or in a pinned version)
 * that a command NAMES anywhere, also where the guard does not parse a write target (`curl -o`, `tar -C`, `unzip -d`). The
 * runner rejects an approval ask naming one: the box refuses the write and no click can open it. Null when none.
 */
export function toolchainFixedPath(
  command: string,
  cfg: Pick<GuardConfig, 'home' | 'toolchainWrite'>,
): string | null {
  const tw = cfg.toolchainWrite;
  if (!tw) return null;
  const within = (p: string, r: string): boolean => p === resolve(r) || inside(p, resolve(r));
  const text = command
    .replace(/(^|[\s='"(:])~(?=\/|$|[\s'"])/g, `$1${cfg.home}`)
    .replace(/\$\{?HOME\}?(?=\/|$|[\s'"])/g, cfg.home);
  for (const root of tw.roots) {
    const r = resolve(root);
    let at = text.indexOf(r);
    while (at !== -1) {
      const m = /^[^\s'"`;|&<>()]*/.exec(text.slice(at));
      const p = resolve(m?.[0] ?? r);
      if (within(p, r) && !(tw.dirs.some((d) => within(p, d)) && !tw.pinned.some((x) => within(p, x))))
        return m?.[0] ?? r;
      at = text.indexOf(r, at + 1);
    }
  }
  return null;
}

/** The T10 switches for one segment (after the hard fences, before everything else): null when none applies. */
function switchVerdict(cmd: string, words: string[], c: Ctx, seg: Segment): GuardVerdict | null {
  if (c.cfg.dockerUnavailable && DOCKER_LIKE.has(cmd))
    return refuse(
      'docker_unavailable',
      `\`${cmd}\`: Docker cannot be used here: ${c.cfg.dockerUnavailable}. Do not ask for it with \`aom devops-approval\` (no approval opens it); finish what works without Docker and say in your report what needs it.`,
    );
  const access = c.cfg.access;
  if (!access) return null;
  if (!access.allowInstall) {
    const v = installVerdict(cmd, words, c, seg);
    if (v && v.decision === 'refused') return v;
  }
  if (!access.allowDocker && DOCKER_LIKE.has(cmd)) {
    // gate-fixes-1 F3: in the outer box only the switch opens Docker (checked before any approval of the command)
    if (c.cfg.dockerSwitchOnly) return dockerSwitchRefusal(c, seg, cmd);
    return approvedHere(c, seg) ? null : switchRefusal(c, seg, 'docker_off', `\`${cmd}\``);
  }
  return pathsVerdict(cmd, words, c, seg);
}

/** Folders "Always allow" never adds (R4-S2 and the round 5 nit): they or their contents hold secrets or settings. */
const SHELL_STARTUP = [
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.config/fish',
];

/**
 * Why `dir` may not be added to the allowed paths for good (null: it may). Never the home folder itself or `/`, a parent of
 * the runner's folder, the policy folder, the card worktrees, a credential store, a shell start-up file, or a folder that
 * CONTAINS any of those (for example `~/.config`, which holds `.config/gh` and the policy folder).
 */
export function alwaysPathRefusal(
  dir: string,
  o: {
    home: string;
    policyRoot?: string | undefined;
    worktrees?: string | undefined;
    runnerRoot?: string | undefined;
  },
): string | null {
  const d = resolve(dir);
  const home = resolve(o.home);
  if (d === '/' || d === home) return 'the home folder or / as a whole';
  const sensitive = [
    ...(o.runnerRoot ? [resolve(o.runnerRoot)] : []),
    ...(o.policyRoot ? [resolve(o.policyRoot)] : []),
    ...(o.worktrees ? [resolve(o.worktrees)] : []),
    ...HOME_SECRET_ENTRIES.map((e) => join(home, e)),
    ...SHELL_STARTUP.map((e) => join(home, e)),
  ];
  for (const p of sensitive) {
    if (d === p || inside(d, p)) return `${p} holds secrets or settings`;
    if (inside(p, d)) return `it contains ${p}`;
  }
  return null;
}

function offWorkstation(c: Ctx, seg: Segment, what: string): GuardVerdict {
  if (approvedHere(c, seg)) return ok('off_workstation_approved');
  return refuse(
    'off_workstation',
    `${what} leaves this workstation, which needs the manager's approval. ${c.cfg.kind === 'chat' ? 'In a chat, tell the owner what you need and file a DevOps request (`aom devops "<request>"`) so it can be approved on the desk.' : ASK}`,
  );
}

/** git subcommands that talk to a remote, and those that make or move commits (HEAD). */
const GIT_NETWORK = new Set(['push', 'fetch', 'pull', 'ls-remote', 'clone']);
const GIT_HEAD_MOVING = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull']);
const looksLikeUrl = (w: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(w) || /^[^\s/@]+@[^\s:]+:/.test(w);

function appFor(cfg: GuardConfig, normalized: string | null | undefined) {
  if (!normalized) return undefined;
  const n = normalized.toLowerCase().replace(/\.git$/, '');
  return cfg.appRepos?.find((a) => a.remote.toLowerCase().replace(/\.git$/, '') === n);
}

const appRepoRefusal = (label: string, repo: string, what: string): GuardVerdict =>
  refuse('app_repo', `${repo} posts as the app '${label}': ${what}`);

/**
 * `app_repo`: in a repository that posts as an app, the engineer's own git must not reach origin with the user's
 * credentials, nor make commits under another identity. Network git goes through `aom git push|fetch --repo <dir>`
 * (the runner uses the app's token); commits are made as the app (a card request runs with the bot identity).
 */
function appRepoGit(words: string[], c: Ctx): GuardVerdict | null {
  if (!c.cfg.appRepos?.length) return null;
  let i = 1;
  let dir = c.cwd;
  while (i < words.length) {
    const w = words[i] as string;
    if (w === '-C') {
      dir = resolve(c.cwd, (words[i + 1] as string) ?? '.');
      i += 2;
    } else if (w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') i += 2;
    else if (w.startsWith('-')) i++;
    else break;
  }
  const sub = words[i];
  if (!sub) return null;
  const positional = words.slice(i + 1).filter((a) => !a.startsWith('-'));
  const urlArg = positional.find(looksLikeUrl);
  const origin = (): string | null => c.deps.originUrl?.(dir) ?? null;
  if (GIT_NETWORK.has(sub)) {
    const target = urlArg ? normalizeRemoteUrl(urlArg) : sub === 'clone' ? null : origin();
    const app = appFor(c.cfg, target);
    if (app) {
      if (sub === 'clone')
        return appRepoRefusal(app.label, app.remote, 'the runner keeps its clone; work in it.');
      const use =
        sub === 'push'
          ? `use \`aom git push --repo ${shellQuote(dir)} <refspec>...\` (add --delete or --tags as needed)`
          : `use \`aom git fetch --repo ${shellQuote(dir)}\`${sub === 'pull' ? ' and then merge or rebase locally' : ''}`;
      return appRepoRefusal(app.label, app.remote, `${use}; the runner reaches origin with the app's token.`);
    }
  }
  if (GIT_HEAD_MOVING.has(sub)) {
    const app = appFor(c.cfg, origin());
    if (app && (c.cfg.identityEmail ?? '').toLowerCase() !== app.botEmail.toLowerCase())
      return appRepoRefusal(
        app.label,
        app.remote,
        'commits here must be made as the app; ask for this as a card request (it runs as the app); the daily tidy-up commits as the app by itself.',
      );
  }
  return null;
}

const GH_WRITES: Record<string, Set<string>> = {
  pr: new Set(['create', 'edit', 'comment', 'merge', 'close', 'reopen', 'review', 'ready']),
  issue: new Set(['create', 'edit', 'comment', 'close', 'reopen', 'delete', 'transfer', 'lock', 'unlock']),
  release: new Set(['create', 'edit', 'delete', 'upload', 'delete-asset']),
  label: new Set(['create', 'edit', 'delete', 'clone']),
};

/** `app_repo` for `gh`: a write aimed at an app repository (`-R/--repo`, else the directory's origin) is refused. */
function appRepoGh(words: string[], c: Ctx): GuardVerdict | null {
  if (!c.cfg.appRepos?.length) return null;
  const [group, action] = words.slice(1).filter((w) => !w.startsWith('-'));
  let write = !!(group && action && GH_WRITES[group]?.has(action));
  if (group === 'api') {
    const m = words.findIndex((w) => w === '-X' || w === '--method');
    const method = m >= 0 ? (words[m + 1] ?? '').toUpperCase() : '';
    write =
      (method !== '' && method !== 'GET') ||
      words.some(
        (w) => w === '-f' || w === '-F' || w === '--field' || w === '--raw-field' || w === '--input',
      );
  }
  if (!write) return null;
  const r = words.findIndex((w) => w === '-R' || w === '--repo');
  const named = r >= 0 ? words[r + 1] : words.find((w) => w.startsWith('--repo='))?.slice(7);
  let target: string | null;
  if (named)
    target =
      named.includes('/') && named.split('/').length === 2
        ? `github.com/${named}`
        : normalizeRemoteUrl(named);
  else target = c.deps.originUrl?.(c.cwd) ?? null;
  const app = appFor(c.cfg, target);
  if (!app) return null;
  return appRepoRefusal(
    app.label,
    app.remote,
    'pull requests, merges, comments and releases there are made by the runner as the app (the card finishes through it), not with your gh login.',
  );
}

function gitPush(words: string[], cfg: GuardConfig): GuardVerdict | null {
  // skip git's global options up to the subcommand
  let i = 1;
  while (i < words.length) {
    const w = words[i] as string;
    if (w === '-C' || w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') i += 2;
    else if (w.startsWith('-')) i++;
    else break;
  }
  if (words[i] !== 'push') return null;
  const args = words.slice(i + 1);
  const flags = args.filter((a) => a.startsWith('-') && a !== '-');
  const positional = args.filter((a) => !a.startsWith('-') || a === '-');
  const force =
    flags.some((f) => f === '-f' || f.startsWith('--force') || f === '--mirror') ||
    flags.some((f) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f)) ||
    positional.slice(1).some((r) => r.startsWith('+'));
  const del =
    flags.some((f) => f === '--delete' || f === '-d') || positional.slice(1).some((r) => r.startsWith(':'));
  if (!force && !del) return null;
  const protectedSet = new Set([...PROTECTED_BRANCHES, ...cfg.protectedBranches]);
  const refspecs = positional.slice(1);
  const fail = (why: string) =>
    refuse(
      'force_push_protected',
      `${why}. Force-pushing or deleting main, master and the working branches is never allowed; push a normal commit, or ask the owner.`,
    );
  if (flags.includes('--mirror') || flags.includes('--all') || flags.includes('--prune'))
    return fail('A forced push of every branch (--mirror/--all/--prune) can rewrite protected branches');
  if (refspecs.length === 0)
    return fail('A forced push without a named branch would rewrite the current branch');
  for (const spec of refspecs) {
    const s = spec.replace(/^\+/, '');
    const dst = (s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s).replace(/^refs\/heads\//, '');
    if (dst === 'HEAD' || dst === '')
      return fail('A forced push of HEAD does not name its branch; name the branch to push to');
    if (protectedSet.has(dst)) return fail(`Branch "${dst}" is protected`);
  }
  return null;
}

/** The git subcommand of a words list, with its arguments and the directory it acts on (null: cannot be known). */
function gitSubcommand(
  words: string[],
  cwd: string,
  home: string,
): { sub: string | undefined; args: string[]; dir: string | null } {
  let i = 1;
  let dir: string | null = cwd;
  while (i < words.length) {
    const w = words[i] as string;
    if (w === '-C') {
      const v = words[i + 1];
      dir = dir === null || v === undefined ? null : resolveArg(v, dir, home);
      i += 2;
    } else if (w === '--git-dir' || w === '--work-tree') {
      dir = null;
      i += 2;
    } else if (w.startsWith('--git-dir=') || w.startsWith('--work-tree=')) {
      dir = null;
      i++;
    } else if (w === '-c' || w === '--namespace') i += 2;
    else if (w.startsWith('-')) i++;
    else break;
  }
  return { sub: words[i], args: words.slice(i + 1), dir };
}

const frozenRefusal = (b: string, shiftKind?: GuardConfig['shiftKind']): GuardVerdict =>
  refuse(
    'frozen_branch',
    shiftKind === 'release_prep'
      ? `Branch "${b}" is the release branch of this release prep and may not be pushed, reset, moved, checked out or deleted here. Release prep never pushes: write your files and finish with \`aom prep done\`.`
      : `Branch "${b}" may not be pushed, reset, moved, checked out or deleted in this request. Resolve on your conflict/ branch in a scratch worktree and finish with \`aom devops-done --summary "Resolved: ..."\`: the runner then moves ${b} forward itself.`,
  );

/** Commands that move the branch checked out in their directory. */
const HEAD_MOVING = new Set(['commit', 'merge', 'rebase', 'pull', 'cherry-pick', 'revert', 'am']);

/**
 * The release branch of a release prep is frozen: nothing may push it, delete it, move it or check it out, and no command
 * may move a branch that is checked out where the command runs when that branch is a frozen one (or cannot be told).
 */
function frozenGit(words: string[], c: Ctx): GuardVerdict | null {
  const frozen = new Set((c.cfg.frozenBranches ?? []).map((b) => b.replace(/^refs\/heads\//, '')));
  if (frozen.size === 0) return null;
  const first = [...frozen][0] as string;
  const { sub, args, dir } = gitSubcommand(words, c.cwd, c.cfg.home);
  if (sub === undefined) return null;
  const dd = args.indexOf('--');
  const beforeDd = dd === -1 ? args : args.slice(0, dd);
  const flags = beforeDd.filter((a) => a.startsWith('-') && a !== '-');
  const positional = beforeDd.filter((a) => !a.startsWith('-') || a === '-');
  const hit = (name: string): string | null => {
    const n = name.replace(/^\+/, '').replace(/^refs\/heads\//, '');
    return frozen.has(n) ? n : null;
  };

  if (sub === 'push') {
    if (flags.some((f) => f === '--all' || f === '--mirror' || f === '--prune'))
      return frozenRefusal(first, c.cfg.shiftKind);
    const refspecs = positional.slice(1);
    if (refspecs.length === 0) return frozenRefusal(first, c.cfg.shiftKind);
    for (const spec of refspecs) {
      const s = spec.replace(/^\+/, '');
      const dst = (s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s).replace(/^refs\/heads\//, '');
      if (dst === 'HEAD' || dst === '') return frozenRefusal(first, c.cfg.shiftKind);
      const h = hit(dst);
      if (h) return frozenRefusal(h, c.cfg.shiftKind);
    }
    return null;
  }
  if (sub === 'branch') {
    const changes = flags.some(
      (f) => /^--(delete|force|move|copy)$/.test(f) || /^-[a-zA-Z]*[dDfmMcC][a-zA-Z]*$/.test(f),
    );
    if (!changes) return null;
    for (const p of positional) {
      const h = hit(p);
      if (h) return frozenRefusal(h, c.cfg.shiftKind);
    }
    return null;
  }
  if (sub === 'update-ref') {
    for (const a of args) {
      const h = hit(a);
      if (h) return frozenRefusal(h, c.cfg.shiftKind);
    }
    return null;
  }
  if (sub === 'checkout' || sub === 'switch') {
    let creating = false;
    let target: string | undefined;
    for (let i = 0; i < beforeDd.length; i++) {
      const a = beforeDd[i] as string;
      if (/^(-b|-B|-c|-C|--orphan)$/.test(a)) {
        creating = true;
        const h = hit(beforeDd[i + 1] ?? '');
        if (h) return frozenRefusal(h, c.cfg.shiftKind);
        i++;
      } else if (a === '--detach' || a === '-d') creating = true;
      else if (a.startsWith('-') && a !== '-') continue;
      else if (target === undefined) target = a;
    }
    // `git checkout <branch> -- <paths>` only reads the branch
    const h = target === undefined ? null : hit(target);
    if (h && !creating && !(sub === 'checkout' && dd !== -1)) return frozenRefusal(h, c.cfg.shiftKind);
    return null;
  }
  if (sub === 'worktree') {
    if (positional[0] !== 'add') return null;
    const named = beforeDd.findIndex((a) => a === '-b' || a === '-B');
    if (named !== -1) {
      const h = hit(beforeDd[named + 1] ?? '');
      return h ? frozenRefusal(h, c.cfg.shiftKind) : null;
    }
    for (const p of positional.slice(1)) {
      const h = hit(p);
      if (h) return frozenRefusal(h, c.cfg.shiftKind);
    }
    return null;
  }
  let moves = HEAD_MOVING.has(sub);
  if (sub === 'reset') {
    if (flags.some((f) => /^--(hard|soft|mixed|keep|merge)$/.test(f))) moves = true;
    else if (positional.length > 0) {
      // `git reset HEAD <paths>` only unstages
      moves = positional[0] !== 'HEAD';
    }
  }
  if (!moves) return null;
  // null (detached) must stay null: only a missing lookup counts as unknown
  const head = dir === null || !c.deps.headBranch ? 'unknown' : c.deps.headBranch(dir);
  if (head === null) return null;
  if (head === 'unknown') return frozenRefusal(first, c.cfg.shiftKind);
  return frozen.has(head) ? frozenRefusal(head, c.cfg.shiftKind) : null;
}

const CARD_FENCE_TEXT =
  'The DevOps engineer never writes, installs or commits in a card worktree and never moves a card branch, whoever asks and whatever was approved (the runner reverts it after the shift). A builder that needs a package asks the runner with `aom devops install <npm|pnpm|yarn|bun> ...` from its own shift; tell the requester that, and report.';

/** Commands that only read: allowed in a card worktree (with their read-only flags; `find` without -delete/-exec). */
const READ_ONLY_CMDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  'wc',
  'stat',
  'file',
  'du',
  'tree',
  'pwd',
  'echo',
  'printf',
  'test',
  '[',
  'diff',
  'cmp',
  'sha256sum',
  'sha1sum',
  'md5sum',
  'realpath',
  'readlink',
  'basename',
  'dirname',
  'jq',
  'true',
  'false',
  'aom',
  'which',
  'type',
  'command',
]);
/** git subcommands that only read. */
const GIT_READ_ONLY = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'rev-list',
  'cat-file',
  'ls-files',
  'ls-tree',
  'merge-base',
  'describe',
  'for-each-ref',
  'show-ref',
  'blame',
  'shortlog',
  'grep',
  'reflog',
  'symbolic-ref',
  'name-rev',
]);

export const isCardBranch = (name: string): boolean => {
  const n = name.replace(/^\+/, '').replace(/^refs\/heads\//, '');
  return CARD_BRANCH_PREFIXES.some((p) => n.startsWith(p));
};

/**
 * uat-runner-fixes-3 finding 2: refuses a DevOps command that writes in a card worktree or moves a card branch. The
 * request text, a prompt or a manager's approval cannot change it (it is configuration of the runner, not of the agent).
 */
function cardFence(cmd: string, words: string[], seg: Segment, c: Ctx): GuardVerdict | null {
  const root = c.cfg.cardWorktreesRoot;
  if (!root) return null;
  const r = resolve(root);
  const inCard = (p: string | null): boolean => p !== null && (p === r || inside(p, r));
  const refuseFence = (what: string) => refuse('card_worktree', `${what}. ${CARD_FENCE_TEXT}`);
  for (const t of seg.redirects)
    if (inCard(resolveArg(t, c.cwd, c.cfg.home))) return refuseFence(`Writing ${t} (a card worktree)`);
  if (cmd === 'git') {
    const { sub, args, dir } = gitSubcommand(words, c.cwd, c.cfg.home);
    if (sub === undefined) return null;
    const flags = args.filter((a) => a.startsWith('-'));
    const positional = args.filter((a) => !a.startsWith('-'));
    const head = dir === null ? 'unknown' : (c.deps.headBranch?.(dir) ?? 'unknown');
    // T7: no exception for a conflict request any more; the runner moves the card branch after "Resolved:"
    // a card branch named anywhere (the clone too): pushed, moved, deleted or re-pointed
    if (
      sub === 'push' &&
      positional.slice(1).some((spec) => isCardBranch(spec.slice(spec.lastIndexOf(':') + 1)))
    )
      return refuseFence('Pushing a card branch');
    if (sub === 'update-ref' && args.some(isCardBranch)) return refuseFence('Moving a card branch');
    if (
      sub === 'branch' &&
      flags.some((f) => /^--(delete|force|move|copy)$/.test(f) || /^-[a-zA-Z]*[dDfmMcC][a-zA-Z]*$/.test(f)) &&
      positional.some(isCardBranch)
    )
      return refuseFence('Changing a card branch');
    if (GIT_READ_ONLY.has(sub)) return null;
    if (
      sub === 'branch' &&
      flags.every((f) =>
        /^-(a|r|v|vv|l|-list|-all|-remotes|-show-current|-contains|-merged|-no-merged)$/.test(f),
      )
    )
      return null;
    if (
      sub === 'config' &&
      flags.some((f) => f === '--get' || f === '--get-all' || f === '--list' || f === '-l')
    )
      return null;
    if (sub === 'worktree') {
      // listing and scratch worktrees OUTSIDE the card folder (the conflict brief's step 1) are fine
      if (positional[0] === 'list' || positional[0] === 'prune') return null;
      if (positional[0] === 'add' || positional[0] === 'remove') {
        const named = new Set<string>();
        for (let i = 0; i < args.length; i++)
          if (/^-(b|B)$/.test(args[i] as string)) named.add(args[++i] as string);
        const target = args.slice(1).find((a) => !a.startsWith('-') && !named.has(a));
        const abs = target === undefined ? null : resolveArg(target, dir ?? c.cwd, c.cfg.home);
        if (abs !== null && !inCard(abs)) return null;
        return refuseFence('A worktree in the card worktrees folder');
      }
    }
    if (inCard(dir) || isCardBranch(head === null || head === 'unknown' ? '' : head))
      return refuseFence(`\`git ${sub}\` in a card worktree`);
    return null;
  }
  if (READ_ONLY_CMDS.has(cmd)) {
    if (cmd === 'find' && words.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(w)))
      return words.slice(1).some((w) => inCard(resolveArg(w, c.cwd, c.cfg.home))) || inCard(c.cwd)
        ? refuseFence('`find` that changes files in a card worktree')
        : null;
    return null;
  }
  if (inCard(c.cwd)) return refuseFence(`\`${cmd}\` in a card worktree`);
  for (const w of words.slice(1)) {
    const v = w.includes('=') && w.startsWith('-') ? w.slice(w.indexOf('=') + 1) : w;
    if (!v.startsWith('-') && inCard(resolveArg(v, c.cwd, c.cfg.home)))
      return refuseFence(`\`${cmd}\` on ${v} (a card worktree)`);
  }
  return null;
}

const INSTALL_SCRIPTS_TEXT =
  'Install scripts are off in DevOps sessions on this workstation (a builder may have written them). Add the script-free flag';

/** Bun subcommands that install, update or link packages (and so run lifecycle scripts unless `--ignore-scripts`). */
const BUN_INSTALLING = new Set(['install', 'i', 'add', 'a', 'update', 'upgrade', 'remove', 'rm', 'link']);
/** Yarn subcommands that install (a bare `yarn` installs too). */
const YARN_INSTALLING = new Set(['install', 'add', 'upgrade', 'up', 'upgrade-interactive', 'import', 'link']);
const COMPOSER_INSTALLING = new Set([
  'install',
  'update',
  'upgrade',
  'require',
  'create-project',
  'reinstall',
]);

/**
 * T4 (S-A, S-B): while install scripts are off, the package managers without a safe environment switch must carry the
 * script-free flag: Bun `--ignore-scripts` (and never `bun pm trust`, which runs dependency scripts on purpose), Yarn 1
 * `--ignore-scripts` or Yarn 2+ `--mode=skip-build`, Composer `--no-scripts --no-plugins`. npm and pnpm are covered by
 * the environment. Bundler and pip still run code (residual, stated in the design).
 */
function installScriptGuard(cmd: string, words: string[]): GuardVerdict | null {
  const args = words.slice(1);
  const sub = args.find((a) => !a.startsWith('-'));
  if (cmd === 'bun') {
    if (sub === 'pm' && args[args.indexOf('pm') + 1] === 'trust')
      return refuse(
        'install_scripts',
        '`bun pm trust` runs dependency install scripts, which are off in DevOps sessions on this workstation.',
      );
    if (sub && BUN_INSTALLING.has(sub) && !args.includes('--ignore-scripts'))
      return refuse('install_scripts', `${INSTALL_SCRIPTS_TEXT}: \`bun ${sub} --ignore-scripts ...\`.`);
    return null;
  }
  if (cmd === 'yarn') {
    const installing =
      sub === undefined || YARN_INSTALLING.has(sub) || (sub === 'global' && args.includes('add'));
    if (installing && !args.includes('--ignore-scripts') && !args.includes('--mode=skip-build'))
      return refuse(
        'install_scripts',
        `${INSTALL_SCRIPTS_TEXT}: \`yarn ${sub ?? 'install'} --ignore-scripts\` (Yarn 1) or \`--mode=skip-build\` (Yarn 2+).`,
      );
    return null;
  }
  if (cmd === 'composer' || cmd === 'composer.phar') {
    if (
      sub &&
      COMPOSER_INSTALLING.has(sub) &&
      !(args.includes('--no-scripts') && args.includes('--no-plugins'))
    )
      return refuse(
        'install_scripts',
        `${INSTALL_SCRIPTS_TEXT}: \`composer ${sub} --no-scripts --no-plugins\`.`,
      );
  }
  return null;
}

/** The runner CLI's verbs that only read (T2, S3): `policy` prints (`policy accept` is refused), the rest list. */
const RUNNER_CLI_READ_ONLY = new Set([
  'policy',
  'pending',
  'status',
  'version',
  'help',
  '--version',
  '--help',
  '-h',
  '-V',
]);
const RUNNER_CLIS = new Set(['guildwise-runner', 'aom-runner']);
const POLICY_FENCE_TEXT =
  "The local approval settings of this computer are the owner's alone: no agent reads, changes or approves them, whatever it is asked. Tell the requester the owner must do it on this computer.";

/**
 * T2: refuses a command that reads, writes or runs in the local authority's folder, or runs the runner CLI beyond its
 * read-only verbs (`guildwise-runner approve`, `policy accept`, `devops grant`, `approvals pair`, ...). Direct commands
 * only: a script the agent wrote is the recorded D1 leftover.
 */
function policyFence(cmd: string, words: string[], seg: Segment, c: Ctx): GuardVerdict | null {
  const root = c.cfg.policyRoot;
  if (RUNNER_CLIS.has(cmd)) {
    const args = words.slice(1);
    const verb = args[0];
    const printOnly =
      verb !== undefined && RUNNER_CLI_READ_ONLY.has(verb) && (verb !== 'policy' || args.length === 1);
    if (!printOnly)
      return refuse(
        'policy_fence',
        `\`${cmd} ${args.join(' ')}\` changes or approves local settings. ${POLICY_FENCE_TEXT}`,
      );
  }
  if (!root) return null;
  const r = resolve(root);
  const inPolicy = (p: string | null): boolean => p !== null && (p === r || inside(p, r));
  for (const t of seg.redirects)
    if (inPolicy(resolveArg(t, c.cwd, c.cfg.home)))
      return refuse('policy_fence', `Writing ${t} (the local approval settings). ${POLICY_FENCE_TEXT}`);
  if (inPolicy(resolve(c.cwd)))
    return refuse('policy_fence', `\`${cmd}\` in the local approval settings folder. ${POLICY_FENCE_TEXT}`);
  for (const w of words.slice(1)) {
    const v = w.includes('=') ? w.slice(w.indexOf('=') + 1) : w;
    if (v && !v.startsWith('-') && inPolicy(resolveArg(v, c.cwd, c.cfg.home)))
      return refuse('policy_fence', `\`${cmd}\` on ${v} (the local approval settings). ${POLICY_FENCE_TEXT}`);
  }
  return null;
}

/** The verdict for one simple command. */
function judgeSegment(seg: Segment, c: Ctx): GuardVerdict {
  const words = [...seg.words];
  // writing to a block device or a system account file by redirect
  for (const t of seg.redirects) {
    if (BLOCK_DEVICE.test(t))
      return refuse('disk_tools', `Writing to the block device ${t} is never allowed.`);
    if (SYSTEM_FILES.test(t))
      return refuse('user_admin', `${t} holds accounts or sudo rules; ${OWNER_TEXT}.`);
  }
  // variable assignments in front of the command (DOCKER_HOST=tcp://remote docker ps)
  while (words.length > 0 && isAssign(words[0] as string)) {
    const w = words.shift() as string;
    const m = /^(DOCKER_HOST|DOCKER_CONTEXT|KUBECONFIG)=(.*)$/.exec(w);
    if (
      m &&
      !(m[1] === 'DOCKER_HOST' && m[2]?.startsWith('unix://')) &&
      m[2] !== '' &&
      !/^(default|desktop-linux)$/.test(m[2] ?? '')
    )
      return offWorkstation(c, seg, `Pointing ${m[1]} elsewhere`);
  }
  if (words.length === 0) return ok();
  let cmd = baseName(words[0] as string);

  // `export DOCKER_HOST=tcp://...`
  if (cmd === 'export' || cmd === 'declare' || cmd === 'set') {
    for (const w of words.slice(1)) {
      const m = /^(DOCKER_HOST|DOCKER_CONTEXT)=(.*)$/.exec(w);
      if (
        m &&
        !(m[1] === 'DOCKER_HOST' && m[2]?.startsWith('unix://')) &&
        !/^(default|desktop-linux|)$/.test(m[2] ?? '')
      )
        return offWorkstation(c, seg, `Pointing ${m[1]} elsewhere`);
    }
    return ok();
  }

  // look through wrappers
  let guard = 0;
  while (WRAPPERS.has(cmd) && guard++ < 6) {
    const wrapper = cmd;
    let rest = words.slice(1);
    // `env -i VAR=x cmd`, `timeout 30 cmd`, `nice -n 5 cmd`, `xargs -n1 cmd`
    while (
      rest.length > 0 &&
      (rest[0]?.startsWith('-') ||
        isAssign(rest[0] as string) ||
        (wrapper === 'timeout' && /^\d/.test(rest[0] as string)))
    ) {
      if (
        (wrapper === 'nice' && rest[0] === '-n') ||
        (wrapper === 'xargs' && ['-n', '-I', '-P', '-d', '-L', '-s'].includes(rest[0] as string))
      )
        rest = rest.slice(2);
      else rest = rest.slice(1);
    }
    if (rest.length === 0) return ok();
    if (wrapper === 'xargs') {
      // the arguments come from a pipe: a delete or a remote command cannot be checked
      const inner = judgeSegment({ words: rest, raw: rest.join(' '), redirects: [] }, { ...c, cwd: c.cwd });
      if (inner.decision === 'refused') return inner;
      if (['rm', 'rmdir', 'unlink', 'shred'].includes(baseName(rest[0] as string)))
        return refuse(
          'delete_outside',
          'Deleting paths that come from a pipe (xargs rm) cannot be checked; delete named paths inside a worktree or data folder.',
        );
      return inner;
    }
    words.splice(0, words.length, ...rest);
    cmd = baseName(words[0] as string);
  }

  const policyFenced = policyFence(cmd, words, seg, c);
  if (policyFenced) return policyFenced;
  const fenced = cardFence(cmd, words, seg, c);
  if (fenced) return fenced;
  if (c.cfg.installScriptsOff) {
    const scripts = installScriptGuard(cmd, words);
    if (scripts) return scripts;
  }
  // T10: the owner's switches (installs, Docker, paths); a refusal asks
  const switched = switchVerdict(cmd, words, c, seg);
  if (switched && switched.decision === 'refused') return switched;

  // `aom sudo` was removed in 1.10.0 (no standing root path): refused like raw sudo
  if (cmd === 'aom') {
    if (words[1] === 'sudo') return refuse('user_admin', `aom sudo was removed in 1.10.0; ${OWNER_TEXT}.`);
    return ok('aom');
  }
  if (PRIVILEGE_WRAPPERS.has(cmd))
    return refuse(
      'user_admin',
      `sudo/su is not available in your shell; install stack tools in your own home, and for a system package ${OWNER_TEXT}.`,
    );
  if (USER_TOOLS.has(cmd))
    return refuse('user_admin', `${cmd} changes users, groups or passwords on this machine; ${OWNER_TEXT}.`);
  if (DISK_TOOLS.has(cmd) || /^mkfs(\.|$)/.test(cmd) || /^(mke2fs|mkntfs|mkdosfs)$/.test(cmd))
    return refuse(
      'disk_tools',
      `${cmd} changes disks or partitions; that is never allowed from this session.`,
    );
  if (cmd === 'dd' && words.some((w) => w.startsWith('of=') && BLOCK_DEVICE.test(w.slice(3))))
    return refuse('disk_tools', 'dd to a block device is never allowed from this session.');
  if (cmd === 'shred' || cmd === 'blkdiscard') {
    // shred of a plain file is a delete
    if (words.slice(1).some((w) => BLOCK_DEVICE.test(w)))
      return refuse('disk_tools', `${cmd} of a device is never allowed.`);
  }
  if (
    ['tee', 'sed', 'cp', 'mv', 'install', 'ln', 'truncate', 'rm'].includes(cmd) &&
    words.slice(1).some((w) => SYSTEM_FILES.test(w))
  )
    return refuse('user_admin', `Accounts and sudo rules are not edited from this session; ${OWNER_TEXT}.`);

  // dropping databases: any command that carries the statement or the tool
  if (
    words.some((w) => w === 'dropdb') ||
    (words.some((w) => DB_TOOLS.has(baseName(w))) && DB_DROP.test(seg.raw))
  )
    return refuse(
      'drop_database',
      'Dropping a database or schema is never allowed from this session; ask the owner to do it.',
    );

  // deleting
  if (['rm', 'rmdir', 'unlink', 'shred', 'trash', 'trash-put'].includes(cmd)) {
    const targets = words.slice(1).filter((w) => !w.startsWith('-') || w === '-');
    for (const t of targets) {
      if (!deletable(t, c))
        return refuse(
          'delete_outside',
          `Deleting "${t}" is outside the worktrees and the runner's data folders (${c.cfg.deleteRoots.slice(0, 3).join(', ')}, ...). Delete only inside a worktree or data folder.`,
        );
    }
    return ok('delete_inside');
  }
  if (
    cmd === 'find' &&
    (words.includes('-delete') ||
      words.some((w, i) => w === '-exec' && ['rm', 'rmdir', 'shred'].includes(baseName(words[i + 1] ?? ''))))
  ) {
    const starts: string[] = [];
    for (const w of words.slice(1)) {
      if (w.startsWith('-') || w === '(' || w === '!') break;
      starts.push(w);
    }
    if (starts.length === 0) starts.push('.');
    for (const s of starts)
      if (!deletable(s, c))
        return refuse(
          'delete_outside',
          `find -delete under "${s}" is outside the worktrees and the runner's data folders.`,
        );
    return ok('delete_inside');
  }
  if (cmd === 'git') {
    const app = appRepoGit(words, c);
    if (app) return app;
    const push = gitPush(words, c.cfg);
    if (push) return push;
    if (c.cfg.frozenBranches?.length) {
      const frozen = frozenGit(words, c);
      if (frozen) return frozen;
    }
    // `git clean` and `git rm -r` act on the working copy: only inside a worktree or data folder
    let dir = c.cwd;
    for (let i = 1; i < words.length - 1; i++)
      if (words[i] === '-C') dir = resolve(c.cwd, words[i + 1] as string);
    const sub = words.slice(1).find((w) => !w.startsWith('-') && w !== dir && !/^(.*\/.*|.*=.*)$/.test(w));
    if (sub === 'clean' && !c.cfg.deleteRoots.some((r) => inside(dir, resolve(r)) || dir === resolve(r)))
      return refuse('delete_outside', 'git clean outside a worktree or data folder is not allowed.');
    return ok();
  }

  if (cmd === 'gh') {
    const app = appRepoGh(words, c);
    if (app) return app;
  }

  // leaving the workstation
  if (REMOTE_TOOLS.has(cmd)) return offWorkstation(c, seg, `\`${cmd}\``);
  if (cmd === 'rsync') {
    const remote = words
      .slice(1)
      .some(
        (w) =>
          !w.startsWith('-') &&
          ((/^[\w.@-]+:(?!\/\/)/.test(w) && !w.startsWith('/')) || w.startsWith('rsync://')),
      );
    if (remote) return offWorkstation(c, seg, '`rsync` to or from a remote host');
    return ok();
  }
  if (DOCKER_LIKE.has(cmd)) {
    const args = words.slice(1);
    for (let i = 0; i < args.length; i++) {
      const w = args[i] as string;
      if (!w.startsWith('-')) break; // the subcommand: global options are over
      if (w === '--config' || w === '--log-level' || w === '-l') {
        i++;
        continue;
      }
      const m = /^(--host|-H|--context|-c|--url|--connection|-r|--remote)(?:=(.*))?$/.exec(w);
      if (m) {
        const value = m[2] ?? args[i + 1] ?? '';
        const flag = m[1] ?? '';
        if (
          flag === '-r' ||
          flag === '--remote' ||
          (flag !== '-r' && !/^(default|desktop-linux|unix:\/\/.*)$/.test(value))
        )
          return offWorkstation(c, seg, `\`${cmd} ${flag}\` against another host or context`);
      }
    }
    if (args[0] === 'context' && ['use', 'create', 'import', 'update'].includes(args[1] ?? ''))
      return offWorkstation(c, seg, '`docker context` (it changes where docker commands go)');
    return ok();
  }

  // a shell or eval: judge what it runs
  if (SHELLS.has(cmd)) {
    const ci = words.indexOf('-c');
    const cflag = words.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
    const at = ci >= 0 ? ci : cflag;
    if (at >= 0 && words[at + 1] !== undefined) return judgeLine(words[at + 1] as string, c);
  }
  if (cmd === 'eval') return judgeLine(words.slice(1).join(' '), c);
  return ok();
}

const shellQuote = (w: string): string => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

function judgeLine(line: string, c: Ctx): GuardVerdict {
  const nested = substitutions(line);
  for (const inner of nested) {
    const v = judgeLine(inner, c);
    if (v.decision === 'refused') return v;
  }
  let verdict: GuardVerdict = ok();
  // `cd x && rm -rf y`: the following commands run where the `cd` went (unknown places count as outside)
  const here: Ctx = { ...c };
  for (const seg of splitSegments(line)) {
    const first = baseName(seg.words[0] ?? '');
    if ((first === 'cd' || first === 'pushd') && seg.words[1] !== undefined) {
      here.cwd = resolveArg(seg.words[1], here.cwd, c.cfg.home) ?? '/nonexistent-unknown';
      continue;
    }
    const v = judgeSegment(seg, here);
    if (v.decision === 'refused') return v;
    if (v.rule !== 'ok') verdict = v;
  }
  return verdict;
}

/** Classifies a Bash command line. `cwd` is where it runs (relative paths resolve against it). */
export function classifyCommand(
  command: string,
  cfg: GuardConfig,
  cwd: string = process.cwd(),
  deps: GuardDeps = {},
): GuardVerdict {
  if (cfg.readOnlyScan) {
    const scan = scanVerdict(command, cfg, cwd);
    if (scan) return scan;
  }
  // T10 (R3-B2): `curl ... | sh` installs
  if (
    cfg.access &&
    !cfg.access.allowInstall &&
    /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(command)
  ) {
    const whole = normWs(command);
    if (!cfg.approvedCommands.some((a) => normWs(a) === whole))
      return switchRefusal(
        { cfg, cwd, usedApproval: false, deps },
        { words: [], raw: command, redirects: [] },
        'install_off',
        'Running a downloaded installer (`curl | sh`)',
      );
  }
  // a whole-command approval matches however the line is built: the line is judged again with only the lift-able rules
  // lifted, and passes only when nothing else refuses it
  const c: Ctx = { cfg, cwd, usedApproval: false, deps };
  const whole = normWs(command);
  const v = judgeLine(command, c);
  if (
    v.decision === 'refused' &&
    APPROVAL_LIFTS.has(v.rule) &&
    cfg.approvedCommands.some((a) => normWs(a) === whole)
  ) {
    const again = judgeLine(command, { cfg, cwd, usedApproval: false, deps, lift: true });
    return again.decision === 'allowed' ? ok(`${v.rule}_approved`) : again;
  }
  return v;
}

// ------------------------------------------------------------------------------------- read-only scans

/**
 * A scan is an ALLOWLIST at the level of single flags: a segment is allowed only when its command is one of these and EVERY
 * flag is on that command's list (an unknown flag is refused, so an abbreviation such as `--out=` or a flag added by a
 * newer version never slips through). Everything else is refused: shells and interpreters, wrappers (env, xargs, nohup,
 * timeout), scripts (`./x`), package scripts, anything that builds, starts, installs, connects or writes.
 *
 * Also refused, wherever they appear outside single quotes: `$` (variables, `$( )`), backticks, `<( )` and `>( )` (a command
 * hidden in an argument). Pipes are fine between allowed commands; redirections to files are not (the proposal is written
 * with the Write tool, which is limited to the scratch folder). And secrets cannot be read: ssh, cloud and git credentials,
 * `.env` files (not `.env.example`), key files, the runner's private folders, process environments.
 */
interface FlagSpec {
  /** Boolean short flags, as one string of letters. */
  shorts?: string;
  /** Short flags that take a value. */
  valueShorts?: string;
  /** Boolean long flags (without `--`). */
  longs?: string[];
  /** Long flags that take a value (`--name value` or `--name=value`). */
  valueLongs?: string[];
  /** Long flags that take a value only as `--name=value`. */
  optionalValueLongs?: string[];
  /** `-5` style count flags. */
  numeric?: boolean;
  /** At most this many positionals (after the command). */
  maxPositionals?: number;
  /** The command searches folders below its path arguments (or the current folder). */
  recursiveShorts?: string;
  recursiveLongs?: string[];
  alwaysRecursive?: boolean;
}

interface ParsedFlags {
  positionals: string[];
  values: string[];
  flags: string[];
  bad?: string;
}

function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const out: ParsedFlags = { positionals: [], values: [], flags: [] };
  let done = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (done || a === '-' || !a.startsWith('-')) {
      out.positionals.push(a);
      continue;
    }
    if (a === '--') {
      done = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (spec.valueLongs?.includes(name)) {
        out.flags.push(name);
        if (eq >= 0) out.values.push(a.slice(eq + 1));
        else if (i + 1 < args.length) out.values.push(args[++i] as string);
        else return { ...out, bad: a };
      } else if (spec.optionalValueLongs?.includes(name)) {
        out.flags.push(name);
        if (eq >= 0) out.values.push(a.slice(eq + 1));
      } else if (spec.longs?.includes(name) && eq < 0) out.flags.push(name);
      else return { ...out, bad: a };
      continue;
    }
    // a cluster of short flags: -la, -n5, -A3
    const cluster = a.slice(1);
    if (spec.numeric && /^\d+$/.test(cluster)) continue;
    for (let k = 0; k < cluster.length; k++) {
      const ch = cluster[k] as string;
      if (spec.valueShorts?.includes(ch)) {
        out.flags.push(ch);
        const rest = cluster.slice(k + 1);
        if (rest) out.values.push(rest);
        else if (i + 1 < args.length) out.values.push(args[++i] as string);
        else return { ...out, bad: a };
        break;
      }
      if (spec.shorts?.includes(ch)) {
        out.flags.push(ch);
        continue;
      }
      if (spec.numeric && /\d/.test(ch)) continue;
      return { ...out, bad: `-${ch}` };
    }
  }
  if (spec.maxPositionals !== undefined && out.positionals.length > spec.maxPositionals)
    return { ...out, bad: out.positionals[spec.maxPositionals] as string };
  return out;
}

const SCAN_SPECS: Record<string, FlagSpec> = {
  ls: {
    shorts: 'aAlh1RtrSdFipsLCx',
    longs: ['all', 'almost-all', 'human-readable', 'recursive', 'directory', 'classify', 'reverse', 'size'],
    recursiveShorts: 'R',
    recursiveLongs: ['recursive'],
  },
  cat: { shorts: 'nbsAETv', longs: ['number', 'number-nonblank', 'squeeze-blank', 'show-all'] },
  head: {
    shorts: 'qv',
    valueShorts: 'nc',
    longs: ['quiet', 'verbose'],
    valueLongs: ['lines', 'bytes'],
    numeric: true,
  },
  tail: {
    shorts: 'qv',
    valueShorts: 'nc',
    longs: ['quiet', 'verbose'],
    valueLongs: ['lines', 'bytes'],
    numeric: true,
  },
  wc: { shorts: 'lwcmL', longs: ['lines', 'words', 'bytes', 'chars'] },
  grep: {
    shorts: 'ivwxclLnhHrRoqsEFPaIzZT',
    valueShorts: 'ABCmefd',
    longs: [
      'ignore-case',
      'invert-match',
      'word-regexp',
      'line-regexp',
      'count',
      'files-with-matches',
      'files-without-match',
      'line-number',
      'no-filename',
      'with-filename',
      'recursive',
      'dereference-recursive',
      'only-matching',
      'quiet',
      'no-messages',
      'extended-regexp',
      'fixed-strings',
      'perl-regexp',
      'text',
      'binary',
      'null',
      'initial-tab',
      'no-color',
    ],
    optionalValueLongs: ['color'],
    valueLongs: [
      'after-context',
      'before-context',
      'context',
      'max-count',
      'regexp',
      'include',
      'exclude',
      'exclude-dir',
      'binary-files',
      'directories',
    ],
    recursiveShorts: 'rR',
    recursiveLongs: ['recursive', 'dereference-recursive'],
  },
  rg: {
    // no -u/--hidden/--no-ignore/--unrestricted/--follow: they make `rg` read the hidden and ignored files, `.env` among them
    shorts: 'inlcwvFsUaHhoqNI',
    valueShorts: 'egtTABCmdf',
    longs: [
      'ignore-case',
      'smart-case',
      'case-sensitive',
      'line-number',
      'no-line-number',
      'files-with-matches',
      'files-without-match',
      'count',
      'word-regexp',
      'invert-match',
      'fixed-strings',
      'files',
      'json',
      'heading',
      'no-heading',
      'only-matching',
      'no-filename',
      'with-filename',
      'quiet',
      'no-messages',
      'text',
      'no-config',
      'multiline',
      'pcre2',
      'stats',
      'type-list',
    ],
    optionalValueLongs: ['color'],
    valueLongs: [
      'regexp',
      'glob',
      'type',
      'type-not',
      'after-context',
      'before-context',
      'context',
      'max-count',
      'max-depth',
      'max-filesize',
      'file',
    ],
    alwaysRecursive: true,
  },
  echo: { shorts: 'n' },
  pwd: { maxPositionals: 0 },
  true: { maxPositionals: 0 },
  stat: { shorts: 'L', valueShorts: 'c', longs: ['dereference'], valueLongs: ['format'] },
  file: { shorts: 'biL', longs: ['brief', 'mime', 'dereference'] },
  du: {
    shorts: 'hsackx',
    valueShorts: 'd',
    longs: ['human-readable', 'summarize', 'all', 'total', 'apparent-size'],
    valueLongs: ['max-depth'],
    alwaysRecursive: true,
  },
  sort: {
    shorts: 'nrufbdghVsc',
    valueShorts: 'kt',
    longs: ['numeric-sort', 'reverse', 'unique', 'ignore-case'],
  },
  uniq: { shorts: 'cduiD', valueShorts: 'fsw', maxPositionals: 1 },
  cut: { shorts: 's', valueShorts: 'dfcb', longs: ['complement'], valueLongs: ['output-delimiter'] },
  tr: { shorts: 'dsct' },
  basename: { shorts: 'as', maxPositionals: 2 },
  dirname: { maxPositionals: 20 },
  realpath: { shorts: 'sme' },
  readlink: { shorts: 'fme' },
  which: { shorts: 'a' },
  jq: {
    shorts: 'rceMSsajRnC',
    longs: [
      'raw-output',
      'compact-output',
      'exit-status',
      'monochrome-output',
      'sort-keys',
      'slurp',
      'ascii-output',
      'join-output',
      'raw-input',
      'null-input',
      'tab',
    ],
    valueLongs: ['indent'],
  },
};

/** Reads that would leak a credential, as path rules. */
const SECRET_HOME_DIRS = [
  '.ssh',
  '.aws',
  '.azure',
  '.kube',
  '.gnupg',
  '.docker',
  '.config/gcloud',
  '.config/gh',
  '.config/helm',
  '.config/doctl',
  '.config/rclone',
  '.terraform.d',
  '.vault-token',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.gem/credentials',
  '.config/git/credentials',
  '.pgpass',
  '.my.cnf',
  '.claude',
  '.claude.json',
];
const SECRET_FILE_NAMES =
  /(^|\/)(\.env(\.[^/]*)?|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(pem|key|p12|pfx|keystore|jks|kdbx)|credentials(\.json)?|secrets?\.(env|json|ya?ml)|secret\.env|\.netrc|\.pgpass|\.htpasswd|known_hosts|authorized_keys|service-?account[^/]*\.json)$/i;
const ENV_TEMPLATES = /(^|\/)\.env\.(example|sample|template|dist|defaults)$/i;

function secretDirs(cfg: GuardConfig): string[] {
  return [
    ...SECRET_HOME_DIRS.map((d) => join(cfg.home, d)),
    ...(cfg.secretRoots ?? []),
    '/proc/self/environ',
    '/etc/shadow',
    '/etc/sudoers',
    '/etc/ssh',
    '/root/.ssh',
  ];
}

/** A word that names (or sits below) a credential, or - when `recursive` - a folder that contains one. */
function secretPath(word: string, cwd: string, cfg: GuardConfig, recursive: boolean): string | null {
  const parts = word.includes(':') && !word.includes('://') ? word.split(':') : [word];
  for (const part of parts) {
    if (!part) continue;
    const eq = part.startsWith('-') ? part.indexOf('=') : -1;
    const w = eq >= 0 ? part.slice(eq + 1) : part;
    if (!w || w.startsWith('-')) continue;
    const abs = resolveArg(w, cwd, cfg.home);
    if (abs === null) continue;
    const p = abs.replace(/\/+$/, '') || '/';
    if (/^\/proc\/[^/]+\/environ$/.test(p) || /^\/proc\/[^/]+\/(cmdline|fd)(\/|$)/.test(p)) return p;
    if (SECRET_FILE_NAMES.test(p) && !ENV_TEMPLATES.test(p)) return p;
    for (const d of secretDirs(cfg)) {
      if (p === d || p.startsWith(`${d}/`)) return p;
      // searching a folder that contains a credential folder
      if (recursive && (d.startsWith(`${p}/`) || p === '/')) return p;
    }
    if (/(^|\/)\.env(\.[^/]*)?$/.test(p) && !ENV_TEMPLATES.test(p)) return p;
    // /proc/<pid>/environ below a recursive search of /proc
    if (recursive && (p === '/proc' || p === '/')) return p;
  }
  return null;
}

/** `$`, backticks, `<( )` and `>( )` outside single quotes: a command or a secret hidden in an argument. */
export function hiddenExpansion(command: string): string | null {
  let q: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (q === "'") {
      if (c === "'") q = null;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      i++;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '$' || c === '`') return c === '$' ? '`$`' : 'a backtick';
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      continue;
    }
    if (c === '$') return '`$` (a variable or a command substitution)';
    if (c === '`') return 'a backtick (a command substitution)';
    if ((c === '<' || c === '>') && command[i + 1] === '(') return `\`${c}(\` (a process substitution)`;
  }
  return null;
}

const refuseScan = (what: string): GuardVerdict =>
  refuse(
    'scan_read_only',
    `${what} is not allowed in a scan: this is a READ-ONLY look at the project. Read files instead (cat, ls, grep, git log), then submit your findings with \`aom setup propose\`.`,
  );
const refuseSecret = (p: string): GuardVerdict =>
  refuse(
    'scan_read_only',
    `Reading ${p} is not allowed in a scan: credentials and settings files stay private (read .env.example for the names a project needs). This is a READ-ONLY look at the project.`,
  );

const GIT_FLAGS: Record<string, FlagSpec> = {
  log: {
    shorts: 'p',
    valueShorts: 'nSG',
    numeric: true,
    longs: [
      'oneline',
      'stat',
      'shortstat',
      'numstat',
      'graph',
      'decorate',
      'all',
      'no-merges',
      'merges',
      'first-parent',
      'reverse',
      'name-only',
      'name-status',
      'patch',
      'no-color',
      'abbrev-commit',
      'follow',
      'no-patch',
      'date-order',
      'topo-order',
      'branches',
      'tags',
      'remotes',
      'full-history',
      'simplify-by-decoration',
    ],
    valueLongs: [
      'max-count',
      'since',
      'until',
      'author',
      'committer',
      'grep',
      'date',
      'format',
      'pretty',
      'skip',
    ],
  },
  show: {
    shorts: 's',
    longs: [
      'stat',
      'shortstat',
      'numstat',
      'name-only',
      'name-status',
      'no-color',
      'oneline',
      'patch',
      'no-patch',
      'abbrev-commit',
    ],
    valueLongs: ['format', 'pretty', 'date'],
  },
  status: {
    shorts: 'sb',
    longs: ['short', 'branch'],
    optionalValueLongs: ['porcelain', 'untracked-files', 'ignored'],
  },
  diff: {
    shorts: 'w',
    valueShorts: 'U',
    longs: [
      'stat',
      'shortstat',
      'numstat',
      'name-only',
      'name-status',
      'cached',
      'staged',
      'no-color',
      'ignore-all-space',
      'ignore-space-change',
      'summary',
      'patch',
      'no-patch',
      'check',
    ],
    valueLongs: ['unified', 'diff-filter'],
  },
  'ls-files': {
    shorts: 'comd',
    longs: ['cached', 'others', 'modified', 'deleted', 'exclude-standard', 'full-name'],
  },
  'rev-parse': {
    longs: [
      'show-toplevel',
      'abbrev-ref',
      'show-prefix',
      'git-dir',
      'is-inside-work-tree',
      'verify',
      'symbolic-full-name',
    ],
    optionalValueLongs: ['short'],
  },
  remote: { shorts: 'v', longs: ['verbose'], maxPositionals: 0 },
  branch: {
    shorts: 'lavr',
    longs: ['list', 'all', 'remotes', 'verbose', 'show-current'],
    maxPositionals: 0,
  },
  tag: { shorts: 'l', valueShorts: 'n', longs: ['list'] },
};

function scanGit(args: string[], cwd: string, cfg: GuardConfig): GuardVerdict | null {
  let i = 0;
  let dir = cwd;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '-C') {
      const p = args[i + 1];
      if (p === undefined) return refuseScan('`git -C`');
      const bad = secretPath(p, dir, cfg, false);
      if (bad) return refuseSecret(bad);
      dir = resolveArg(p, dir, cfg.home) ?? dir;
      i += 2;
    } else if (a === '--no-pager' || a === '--no-optional-locks') i++;
    else if (a.startsWith('-')) return refuseScan(`\`git ${a}\``);
    else break;
  }
  const verb = args[i];
  const spec = verb ? GIT_FLAGS[verb] : undefined;
  if (!verb || !spec) return refuseScan(`\`git ${verb ?? ''}\``.trim());
  const p = parseFlags(args.slice(i + 1), spec);
  if (p.bad) return refuseScan(`\`git ${verb} ${p.bad}\``);
  if (verb === 'tag' && p.positionals.length > 0 && !p.flags.includes('l') && !p.flags.includes('list'))
    return refuseScan('Changing tags');
  if (verb === 'tag' && p.flags.includes('n') === false && p.positionals.length > 1)
    return refuseScan('Changing tags');
  for (const w of [...p.positionals, ...p.values]) {
    if (/[*?[]/.test(w) && verb !== 'log' && verb !== 'tag')
      return refuseScan(`A pattern in a path (\`${w}\`)`);
    if (/[*?[]/.test(w) && p.positionals.includes(w) && verb === 'log')
      return refuseScan(`A pattern in a path (\`${w}\`)`);
    const bad = secretPath(w, dir, cfg, false);
    if (bad) return refuseSecret(bad);
  }
  return null;
}

/** `docker inspect` prints the environment of a container; only named, harmless fields are allowed. */
const INSPECT_FORMAT =
  /^\{\{\s*(json\s+)?\.(Name|Id|Image|Created|State(\.[A-Za-z]+)?|Config\.Image|Config\.Labels|NetworkSettings\.Ports|HostConfig\.PortBindings|Mounts|RepoTags|Size|Os|Architecture)\s*\}\}$/;

function scanDocker(first: string, args: string[], cwd: string, cfg: GuardConfig): GuardVerdict | null {
  // global options before the verb: only the compose file / project name, and only for compose
  let i = 0;
  const composeOpts: string[] = [];
  const isCompose = first === 'docker-compose';
  let words = args;
  if (first === 'docker' && words[0] === 'compose') {
    words = words.slice(1);
    i = 0;
  } else if (first === 'docker') {
    // `docker -H x ps`, `docker --context x ps`, `docker -c x ps`: refused with every other leading option
    if (words[0]?.startsWith('-')) return refuseScan(`\`docker ${words[0]}\` (another host or option)`);
  }
  const compose = isCompose || args[0] === 'compose';
  if (compose) {
    while (i < words.length && words[i]?.startsWith('-')) {
      const a = words[i] as string;
      if (/^(-f|--file|-p|--project-name|--project-directory)$/.test(a) && i + 1 < words.length) {
        composeOpts.push(words[i + 1] as string);
        i += 2;
      } else return refuseScan(`\`${first} compose ${a}\``);
    }
    const sub = words[i];
    if (!sub || !['ls', 'ps', 'version'].includes(sub))
      return refuseScan(`\`${first} compose ${sub ?? ''}\``.trim());
    const p = parseFlags(words.slice(i + 1), {
      shorts: 'aq',
      longs: ['all', 'quiet', 'short', 'services'],
      valueLongs: ['format', 'filter'],
      valueShorts: 'f',
      maxPositionals: 3,
    });
    if (p.bad) return refuseScan(`\`${first} compose ${sub} ${p.bad}\``);
    for (const w of [...composeOpts, ...p.positionals]) {
      const bad = secretPath(w, cwd, cfg, false);
      if (bad) return refuseSecret(bad);
    }
    return null;
  }
  const verb = words[0];
  if (!verb) return refuseScan(`\`${first}\``);
  let group: string | undefined;
  let rest = words.slice(1);
  if (['image', 'volume', 'network', 'container'].includes(verb)) {
    group = rest[0];
    if (!group || !['ls', 'inspect'].includes(group))
      return refuseScan(`\`${first} ${verb} ${group ?? ''}\``.trim());
    rest = rest.slice(1);
  } else if (!['version', 'info', 'ps', 'images', 'inspect'].includes(verb))
    return refuseScan(`\`${first} ${verb}\``);
  const sub = group ?? verb;
  const p = parseFlags(rest, {
    shorts: 'aqs',
    valueShorts: 'f',
    longs: ['all', 'quiet', 'no-trunc', 'size', 'digests'],
    valueLongs: ['format', 'filter', 'last'],
    maxPositionals: 10,
  });
  if (p.bad) return refuseScan(`\`${first} ${verb} ${p.bad}\``);
  if (sub === 'inspect') {
    // `-f`/`--format` is the only way to see a container, and only the harmless fields
    // EVERY format is checked: a second `--format` would otherwise print what the first one left out
    if (p.values.length === 0 || !p.values.every((f) => INSPECT_FORMAT.test(f)))
      return refuseScan(
        `\`${first} inspect\` without a --format naming a harmless field (a container's settings include its secrets)`,
      );
  }
  return null;
}

/** Everything `find` may be asked: names, types, sizes and times. Never an action. */
const FIND_TESTS_WITH_VALUE = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-wholename',
  '-regex',
  '-iregex',
  '-type',
  '-maxdepth',
  '-mindepth',
  '-size',
  '-mtime',
  '-mmin',
  '-atime',
  '-newer',
  '-user',
  '-group',
  '-perm',
]);
const FIND_PLAIN = new Set([
  '-empty',
  '-not',
  '!',
  '-and',
  '-or',
  '-a',
  '-o',
  '-prune',
  '-print',
  '-print0',
  '-true',
  '-false',
  '(',
  ')',
  '-readable',
  '-writable',
  '-executable',
  '-xdev',
  '-depth',
  '-mount',
]);

function scanFind(args: string[], cwd: string, cfg: GuardConfig): GuardVerdict | null {
  let i = 0;
  while (i < args.length && /^-[HLP]$/.test(args[i] as string)) i++;
  const paths: string[] = [];
  while (
    i < args.length &&
    !(args[i] as string).startsWith('-') &&
    !['!', '(', ')'].includes(args[i] as string)
  )
    paths.push(args[i++] as string);
  for (const p of paths.length ? paths : ['.']) {
    if (/[*?[{]/.test(p)) return refuseScan(`A pattern in a path (\`${p}\`)`);
    const bad = secretPath(p, cwd, cfg, true);
    if (bad) return refuseSecret(bad);
  }
  while (i < args.length) {
    const a = args[i] as string;
    if (FIND_PLAIN.has(a)) i++;
    else if (FIND_TESTS_WITH_VALUE.has(a) && i + 1 < args.length) {
      if (a === '-newer') {
        const bad = secretPath(args[i + 1] as string, cwd, cfg, false);
        if (bad) return refuseSecret(bad);
      }
      i += 2;
    } else return refuseScan(`\`find ${a}\``);
  }
  return null;
}

const AOM_SPECS: Array<{ path: string[]; spec: FlagSpec }> = [
  { path: ['setup', 'propose'], spec: { valueLongs: ['area', 'file'], maxPositionals: 0 } },
  {
    path: ['deploy', 'probe'],
    spec: {
      longs: ['local', 'ssh-hosts'],
      // `--target <name>` probes that deploy target's OWN host; an arbitrary `--host` (any alias in ~/.ssh/config) is not offered
      valueLongs: ['target', 'compose-file', 'dir', 'url'],
      maxPositionals: 0,
    },
  },
  { path: ['deploy', 'status'], spec: { valueLongs: ['project', 'run'], maxPositionals: 0 } },
  { path: ['devops-done'], spec: { valueLongs: ['summary', 'message', 'note'], maxPositionals: 6 } },
  { path: ['devops-question'], spec: { valueLongs: ['question', 'message'], maxPositionals: 6 } },
];

function scanAom(args: string[], cwd: string, cfg: GuardConfig): GuardVerdict | null {
  const m = AOM_SPECS.find((s) => s.path.every((x, i) => args[i] === x));
  if (!m) return refuseScan(`\`aom ${args[0] ?? ''}\``.trim());
  const p = parseFlags(args.slice(m.path.length), m.spec);
  if (p.bad) return refuseScan(`\`aom ${m.path.join(' ')} ${p.bad}\``);
  for (const w of p.values) {
    const bad = secretPath(w, cwd, cfg, false);
    if (bad) return refuseSecret(bad);
  }
  return null;
}

function scanSegment(seg: Segment, cwd: string, cfg: GuardConfig): GuardVerdict | null {
  const words = seg.words;
  const w0 = words[0];
  if (w0 === undefined) return null;
  if (isAssign(w0)) return refuseScan('Setting a variable in front of a command');
  const first = w0.includes('/') ? `./${baseName(w0)}` : w0;
  const args = words.slice(1);
  if (SHELLS.has(first))
    return refuseScan(
      args.some((a) => /^-[a-z]*c[a-z]*$/.test(a))
        ? `\`${first} -c\` (a shell inside a shell)`
        : `\`${first}\``,
    );
  const spec = SCAN_SPECS[first];
  if (spec) {
    const p = parseFlags(args, spec);
    if (p.bad) return refuseScan(`\`${first} ${p.bad}\``);
    const recursive =
      !!spec.alwaysRecursive ||
      p.flags.some((f) =>
        f.length === 1 ? !!spec.recursiveShorts?.includes(f) : !!spec.recursiveLongs?.includes(f),
      );
    // a shell expands `*`, `?`, `[..]` and `{a,b}` in a path before the command sees it: `cat .e*` would read .env. Refused in
    // every path word (the pattern of grep/rg and the program of jq are not paths).
    if (!['echo', 'tr', 'true', 'pwd', 'basename', 'dirname'].includes(first)) {
      const patternFirst =
        (first === 'grep' || first === 'rg' || first === 'jq') &&
        !(first === 'rg' && p.flags.includes('files')) &&
        !p.flags.some((f) => ['e', 'f', 'regexp', 'file'].includes(f));
      const glob = (patternFirst ? p.positionals.slice(1) : p.positionals).find((w) => /[*?[{]/.test(w));
      if (glob) return refuseScan(`A pattern in a path (\`${glob}\`)`);
    }
    if (first === 'grep' && (recursive || p.values.includes('recurse'))) {
      // a recursive grep reads hidden files too: it has to say that `.env` is not one of them
      if (
        !p.values.some((v) => v.includes('.env') && /^\.env(\*|\.\*)?$|^\*\.env$/.test(v.replace(/^\//, '')))
      )
        return refuseScan('A recursive `grep` that does not exclude settings files (add `--exclude=.env*`)');
    }
    if (
      first === 'rg' &&
      p.flags.some((f) => f === 'g' || f === 'glob') &&
      p.values.some((v) => !v.startsWith('!') && /env/i.test(v))
    )
      return refuseScan('An `rg --glob` that names settings files');
    // the first positional of grep/rg/jq is the pattern or program, not a path; checking it too only costs false alarms
    const checked = [...p.positionals, ...p.values];
    for (const w of checked) {
      const bad = secretPath(w, cwd, cfg, recursive);
      if (bad) return refuseSecret(bad);
    }
    if (
      recursive &&
      checked.length === p.values.length + p.positionals.length &&
      (first === 'rg' || first === 'du')
    ) {
      const bad = secretPath('.', cwd, cfg, true);
      if (bad) return refuseSecret(bad);
    }
    if (
      first === 'jq' &&
      /\benv\b|\$ENV|\bENV\b|input_filename|\$__|get_search_list|\binput\b|\bdebug\b|\bstderr\b|\bhalt_error\b/.test(
        p.positionals[0] ?? '',
      )
    )
      return refuseScan('`jq` reading the environment or other input');
    if (first === 'grep' && p.flags.includes('f')) {
      // a pattern FILE is read: its path was checked above like any other
    }
    return null;
  }
  if (first === 'find') return scanFind(args, cwd, cfg);
  if (first === 'git') return scanGit(args, cwd, cfg);
  if (DOCKER_LIKE.has(first) && first !== 'podman' && first !== 'nerdctl')
    return scanDocker(first, args, cwd, cfg);
  if (first === 'npm' || first === 'pnpm') {
    const sub = args[0];
    if (args.length === 1 && (sub === '--version' || sub === '-v')) return null;
    if ((first === 'npm' && sub === 'ls') || (first === 'pnpm' && (sub === 'ls' || sub === 'why'))) {
      const p = parseFlags(args.slice(1), {
        shorts: 'arlpg',
        longs: ['all', 'json', 'long', 'production', 'prod', 'dev', 'global', 'parseable', 'recursive'],
        valueLongs: ['depth'],
        maxPositionals: 3,
      });
      return p.bad ? refuseScan(`\`${first} ${sub} ${p.bad}\``) : null;
    }
    return refuseScan(`\`${first} ${sub ?? ''}\``.trim());
  }
  if (first === 'aom') return scanAom(args, cwd, cfg);
  return refuseScan(`\`${w0}\``);
}

/**
 * The verdict of a read-only scan on a command line, or null when it is fine. Not a security boundary against an agent that
 * is trying hard to get around it, but it fails closed: only the commands and flags above pass.
 */
export function scanVerdict(command: string, cfg: GuardConfig, cwd: string, _depth = 0): GuardVerdict | null {
  const hidden = hiddenExpansion(command);
  if (hidden) return refuseScan(`${hidden}`);
  for (const seg of splitSegments(command)) {
    const v = scanSegment(seg, cwd, cfg);
    if (v) return v;
    for (const target of seg.redirects) {
      if (target === '/dev/null' || /^&\d$/.test(target)) continue;
      return refuseScan(`Writing to ${target}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- audit

/** Secrets a command line may carry, masked before the line is stored or sent. */
export function redactCommand(command: string): string {
  return redactSecrets(command).slice(0, 2000);
}

export function auditEntry(
  cfg: Pick<GuardConfig, 'sessionRef' | 'kind' | 'shiftKind'>,
  command: string,
  v: GuardVerdict,
  now: Date,
): DevopsAuditEntry {
  return {
    at: now.toISOString(),
    sessionRef: cfg.sessionRef.slice(0, 100),
    kind: cfg.kind,
    ...(cfg.shiftKind ? { shiftKind: cfg.shiftKind } : {}),
    decision: v.decision,
    rule: v.rule,
    command: redactCommand(command),
    ...(v.target ? { target: v.target.slice(0, 4000) } : {}),
  };
}

export function appendAuditFile(file: string, entry: DevopsAuditEntry): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // an audit file that cannot be written must not stop the command: the server copy is the other record
  }
}

// ------------------------------------------------------------------------------------------------ hook

/** The branch checked out in `dir` (`git symbolic-ref`): null when detached or not a repository, 'unknown' on any other error. */
/** The normalized origin URL of the repository `dir` is in (read only); null when there is none. */
export function gitOriginUrl(dir: string): string | null {
  try {
    const r = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    const url = r.status === 0 ? r.stdout.trim() : '';
    return url ? normalizeRemoteUrl(url) : null;
  } catch {
    return null;
  }
}

export function gitHeadBranch(dir: string): string | null | 'unknown' {
  try {
    const r = spawnSync('git', ['-C', dir, 'symbolic-ref', '-q', '--short', 'HEAD'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    if (r.error || r.signal) return 'unknown';
    if (r.status === 0) return r.stdout.trim() || 'unknown';
    if (r.status === 1) return null;
    return /not a git repository/i.test(r.stderr ?? '') ? null : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function defaultGuardConfig(kind: 'shift' | 'chat' = 'shift'): GuardConfig {
  return {
    sessionRef: 'unknown',
    kind,
    deleteRoots: ['/tmp', tmpdir(), '/var/tmp'],
    home: homedir(),
    protectedBranches: [],
    approvedCommands: [],
    frozenBranches: [],
  };
}

export function loadGuardConfig(file: string | undefined): GuardConfig {
  if (!file) return defaultGuardConfig();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<GuardConfig>;
    return { ...defaultGuardConfig(raw.kind), ...raw };
  } catch {
    // fail closed: the built-in defaults refuse everything but deleting in the OS temp dir
    return defaultGuardConfig();
  }
}

export interface HookResult {
  stdout: string;
  code: number;
}

/**
 * The PreToolUse hook: reads Claude Code's hook input (JSON on stdin), classifies a Bash command, records it (runner
 * first, the local file when the runner cannot be reached) and answers with Claude Code's permission decision.
 */
export async function runGuardHook(opts: {
  stdin: string;
  cfg: GuardConfig;
  now?: () => Date;
  /** Sends the entry to the runner (which forwards it to the server); false when it could not. */
  report: (entries: DevopsAuditEntry[]) => Promise<boolean>;
  deps?: GuardDeps;
}): Promise<HookResult> {
  let input: { tool_name?: string; tool_input?: { command?: unknown }; cwd?: string };
  try {
    input = JSON.parse(opts.stdin);
  } catch {
    return { stdout: '', code: 0 };
  }
  if (input.tool_name !== undefined && input.tool_name !== 'Bash') return { stdout: '', code: 0 };
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  if (!command.trim()) return { stdout: '', code: 0 };
  const verdict = classifyCommand(command, opts.cfg, input.cwd ?? process.cwd(), opts.deps);
  const entry = auditEntry(opts.cfg, command, verdict, (opts.now ?? (() => new Date()))());
  let sent = false;
  try {
    sent = await opts.report([entry]);
  } catch {
    sent = false;
  }
  if (!sent && opts.cfg.auditFile) appendAuditFile(opts.cfg.auditFile, entry);
  if (verdict.decision === 'allowed') return { stdout: '', code: 0 };
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Refused by the DevOps guard (${verdict.rule}): ${verdict.reason ?? 'not allowed'}`,
      },
    }),
    code: 0,
  };
}
