import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DevopsAuditEntry } from '@aom/shared';
import { redactSecrets } from '../redact.ts';

/**
 * Guardrails of the DevOps engineer (the one agent that runs outside the OS sandbox, as the user). Enforced by a Claude
 * Code PreToolUse hook on every Bash command (`aom devops-guard`, wired in claude-policy.ts):
 *
 * - always refused: deleting outside the worktrees and the runner's data folders, disk and partition tools, user, sudo
 *   and password changes (privileged work goes through `aom sudo`), force-pushing a protected branch, dropping a database;
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
}

export interface GuardVerdict {
  decision: 'allowed' | 'refused';
  /** The rule that refused it, or the class an allowed command fell in (`ok`, `aom`, `off_workstation_approved`). */
  rule: string;
  /** For the agent, on a refusal. */
  reason?: string;
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
          // `>&2`: a descriptor, not a file
          i++;
          while (/\d|-/.test(line[i + 1] ?? '')) i++;
          raw += '>&';
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

interface Ctx {
  cfg: GuardConfig;
  cwd: string;
  /** Inside `aom sudo -- <cmd>`: the user/sudo rule does not apply (that is how privileged work is done). */
  viaAomSudo: boolean;
  usedApproval: boolean;
}

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

function offWorkstation(c: Ctx, seg: Segment, what: string): GuardVerdict {
  const norm = normWs(seg.raw);
  if (c.cfg.approvedCommands.some((a) => normWs(a) === norm)) {
    c.usedApproval = true;
    return ok('off_workstation_approved');
  }
  return refuse(
    'off_workstation',
    `${what} leaves this workstation, which needs the manager's approval. ${c.cfg.kind === 'chat' ? 'In a chat, tell the owner what you need and file a DevOps request (`aom devops "<request>"`) so it can be approved on the desk.' : ASK}`,
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

/** The verdict for one simple command. */
function judgeSegment(seg: Segment, c: Ctx): GuardVerdict {
  const words = [...seg.words];
  // writing to a block device or a system account file by redirect
  for (const t of seg.redirects) {
    if (BLOCK_DEVICE.test(t))
      return refuse('disk_tools', `Writing to the block device ${t} is never allowed.`);
    if (SYSTEM_FILES.test(t) && !c.viaAomSudo)
      return refuse(
        'user_admin',
        `${t} holds accounts or sudo rules; change them through \`aom sudo -- <command>\`.`,
      );
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

  // privileged work goes through `aom sudo -- <command>`: the inner command is judged, the user rule is lifted
  if (cmd === 'aom') {
    if (words[1] === 'sudo') {
      const inner = words.slice(2)[0] === '--' ? words.slice(3) : words.slice(2);
      if (inner.length === 0) return ok('aom');
      const v = judgeLine(inner.map(shellQuote).join(' '), { ...c, viaAomSudo: true });
      return v.decision === 'allowed' && v.rule === 'ok' ? ok('aom_sudo') : v;
    }
    return ok('aom');
  }
  if (PRIVILEGE_WRAPPERS.has(cmd))
    return refuse(
      'user_admin',
      'sudo/su is not available in your shell. Run privileged commands as `aom sudo -- <command> [args]` (the runner supplies the password; the manager must have granted sudo).',
    );
  if (USER_TOOLS.has(cmd) && !c.viaAomSudo)
    return refuse(
      'user_admin',
      `${cmd} changes users, groups or passwords on this machine; if it is part of the request, run it as \`aom sudo -- ${cmd} ...\`.`,
    );
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
    !c.viaAomSudo &&
    words.slice(1).some((w) => SYSTEM_FILES.test(w))
  )
    return refuse(
      'user_admin',
      'Accounts and sudo rules are not edited from this session; use `aom sudo -- <command>`.',
    );

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
    const push = gitPush(words, c.cfg);
    if (push) return push;
    // `git clean` and `git rm -r` act on the working copy: only inside a worktree or data folder
    let dir = c.cwd;
    for (let i = 1; i < words.length - 1; i++)
      if (words[i] === '-C') dir = resolve(c.cwd, words[i + 1] as string);
    const sub = words.slice(1).find((w) => !w.startsWith('-') && w !== dir && !/^(.*\/.*|.*=.*)$/.test(w));
    if (sub === 'clean' && !c.cfg.deleteRoots.some((r) => inside(dir, resolve(r)) || dir === resolve(r)))
      return refuse('delete_outside', 'git clean outside a worktree or data folder is not allowed.');
    return ok();
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
): GuardVerdict {
  if (cfg.readOnlyScan) {
    const scan = scanVerdict(command, cfg, cwd);
    if (scan) return scan;
  }
  // a whole-command approval matches however the line is built
  const c: Ctx = { cfg, cwd, viaAomSudo: false, usedApproval: false };
  const whole = normWs(command);
  const v = judgeLine(command, c);
  if (
    v.decision === 'refused' &&
    v.rule === 'off_workstation' &&
    cfg.approvedCommands.some((a) => normWs(a) === whole)
  )
    return ok('off_workstation_approved');
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
    shorts: 'inlcwvFsuUaHhoqNI',
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
      'hidden',
      'no-ignore',
      'unrestricted',
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
      'follow',
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
    const fmt = p.values[0];
    if (!fmt || !INSPECT_FORMAT.test(fmt))
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
      valueLongs: ['host', 'compose-file', 'dir', 'url'],
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
  cfg: Pick<GuardConfig, 'sessionRef' | 'kind'>,
  command: string,
  v: GuardVerdict,
  now: Date,
): DevopsAuditEntry {
  return {
    at: now.toISOString(),
    sessionRef: cfg.sessionRef.slice(0, 100),
    kind: cfg.kind,
    decision: v.decision,
    rule: v.rule,
    command: redactCommand(command),
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

export function defaultGuardConfig(kind: 'shift' | 'chat' = 'shift'): GuardConfig {
  return {
    sessionRef: 'unknown',
    kind,
    deleteRoots: ['/tmp', tmpdir(), '/var/tmp'],
    home: homedir(),
    protectedBranches: [],
    approvedCommands: [],
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
  const verdict = classifyCommand(command, opts.cfg, input.cwd ?? process.cwd());
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
