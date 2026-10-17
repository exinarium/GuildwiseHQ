import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyCommand,
  deleteRootsFor,
  type GuardConfig,
  loadGuardConfig,
  redactCommand,
  runGuardHook,
  splitSegments,
  substitutions,
} from '../src/devops/guard.ts';
import { tmp } from './helpers.ts';

const ROOT = '/home/u/.aom-runner';
const cfg = (over: Partial<GuardConfig> = {}): GuardConfig => ({
  sessionRef: 'shift-1',
  kind: 'shift',
  deleteRoots: deleteRootsFor(ROOT, '/tmp'),
  home: '/home/u',
  protectedBranches: ['dev-working'],
  approvedCommands: [],
  ...over,
});
const CWD = `${ROOT}/worktrees/TOY-ab12cd34/TOY-1`;

type Row = [string, string, 'allowed' | 'refused', string?];
const rows: Row[] = [
  // ---- allowed: everyday DevOps work
  ['docker ps', 'plain docker', 'allowed'],
  ['docker compose up -d', 'compose', 'allowed'],
  ['docker -H unix:///var/run/docker.sock ps', 'docker host that is this machine', 'allowed'],
  ['docker --context default ps', 'default context', 'allowed'],
  ['git push origin agent/TOY-1', 'normal push', 'allowed'],
  ['git push --force-with-lease origin agent/TOY-1', 'force push of a feature branch', 'allowed'],
  ['git status && git log --oneline | head', 'pipes', 'allowed'],
  ['npm install && npm run build', 'build', 'allowed'],
  ['aom devops-done --summary "ok"', 'aom verb', 'allowed', 'aom'],
  [
    'aom devops-approval --action "deploy to uat" --reason "needed" --command "ssh uat ls"',
    'aom approval',
    'allowed',
    'aom',
  ],
  ['ssh-keygen -t ed25519 -f /tmp/k', 'ssh-keygen is local', 'allowed'],
  ['rsync -a ./a/ ./b/', 'local rsync', 'allowed'],
  [`rm -rf ${CWD}/node_modules`, 'delete inside a worktree', 'allowed', 'delete_inside'],
  ['rm -rf /tmp/build-123', 'delete in tmp', 'allowed', 'delete_inside'],
  [`rm -rf ${ROOT}/cache/npm/*`, 'delete cache content', 'allowed', 'delete_inside'],
  ['rm -rf node_modules dist', 'relative paths in a worktree', 'allowed', 'delete_inside'],
  ['curl -s https://example.com/health', 'curl is not remote-admin', 'allowed'],
  ['echo "do not drop database users"', 'text about dropping a database', 'allowed'],
  ['git commit -m "drop schema migration"', 'commit message', 'allowed'],
  ['aom sudo -- apt-get install -y jq', 'privileged work through aom sudo', 'allowed', 'aom_sudo'],
  ['aom sudo -- useradd builder', 'user admin through aom sudo', 'allowed'],
  ['cat /etc/passwd', 'reading accounts', 'allowed'],

  // ---- refused: deleting outside worktrees and data folders
  ['rm -rf /', 'root', 'refused', 'delete_outside'],
  ['rm -rf /*', 'root glob', 'refused', 'delete_outside'],
  ['rm -rf ~', 'home', 'refused', 'delete_outside'],
  ['rm -rf ~/*', 'home glob', 'refused', 'delete_outside'],
  ['rm -rf $HOME/projects', 'home subfolder via variable', 'refused', 'delete_outside'],
  ['rm -rf $SOMEWHERE', 'unknown variable', 'refused', 'delete_outside'],
  ['rm -rf /home/u/src/my-repo', 'a repository clone', 'refused', 'delete_outside'],
  [`rm -rf ${ROOT}/secrets`, 'runner secrets', 'refused', 'delete_outside'],
  [`rm -rf ${ROOT}/worktrees`, 'the worktrees root itself', 'refused', 'delete_outside'],
  ['rm -rf ../../..', 'escaping upward', 'refused', 'delete_outside'],
  ['cd /home/u && rm -rf src', 'a cd out of the worktree is followed', 'refused', 'delete_outside'],
  ['cd $SOMEWHERE && rm -rf src', 'a cd to an unknown place', 'refused', 'delete_outside'],
  [`cd ${CWD}/sub && rm -rf build`, 'a cd inside the worktree', 'allowed', 'delete_inside'],
  ['find / -name "*.log" -delete', 'find -delete from root', 'refused', 'delete_outside'],
  ['find /home/u -type f -exec rm {} +', 'find -exec rm', 'refused', 'delete_outside'],
  ['ls | xargs rm -rf', 'xargs rm', 'refused', 'delete_outside'],
  ['sh -c "rm -rf /var/lib/docker"', 'inside sh -c', 'refused', 'delete_outside'],
  ['echo $(rm -rf /home/u/x)', 'inside command substitution', 'refused', 'delete_outside'],
  ['rmdir /home/u/Documents', 'rmdir', 'refused', 'delete_outside'],
  ['git -C /home/u/src/repo clean -fdx', 'git clean outside', 'refused', 'delete_outside'],
  ['aom sudo -- rm -rf /var/lib/postgresql', 'delete outside through aom sudo', 'refused', 'delete_outside'],

  // ---- refused: disk tools
  ['fdisk /dev/sda', 'fdisk', 'refused', 'disk_tools'],
  ['parted /dev/sda mklabel gpt', 'parted', 'refused', 'disk_tools'],
  ['mkfs.ext4 /dev/sdb1', 'mkfs', 'refused', 'disk_tools'],
  ['dd if=/dev/zero of=/dev/sda bs=1M', 'dd to a disk', 'refused', 'disk_tools'],
  ['echo x > /dev/sda', 'redirect to a disk', 'refused', 'disk_tools'],
  ['wipefs -a /dev/sdb', 'wipefs', 'refused', 'disk_tools'],
  ['aom sudo -- mkfs.ext4 /dev/sdb1', 'disk tool through aom sudo', 'refused', 'disk_tools'],
  ['dd if=/dev/zero of=/tmp/file bs=1M count=10', 'dd to a file', 'allowed'],

  // ---- refused: users, sudo, passwords
  ['sudo apt-get install jq', 'bare sudo', 'refused', 'user_admin'],
  ['sudo -u postgres psql', 'sudo -u', 'refused', 'user_admin'],
  ['su - root', 'su', 'refused', 'user_admin'],
  ['useradd evil', 'useradd', 'refused', 'user_admin'],
  ['passwd', 'passwd', 'refused', 'user_admin'],
  ['usermod -aG sudo me', 'usermod', 'refused', 'user_admin'],
  ['echo "me ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/me', 'sudoers redirect', 'refused', 'user_admin'],
  ['echo "me ALL=(ALL) NOPASSWD:ALL" | tee /etc/sudoers.d/me', 'sudoers tee', 'refused', 'user_admin'],
  ['env FOO=1 sudo ls', 'sudo behind env', 'refused', 'user_admin'],
  ['nohup sudo reboot', 'sudo behind nohup', 'refused', 'user_admin'],
  ['bash -c "sudo rm x"', 'sudo in bash -c', 'refused', 'user_admin'],
  ['visudo', 'visudo', 'refused', 'user_admin'],

  // ---- refused: force-push of protected branches
  ['git push --force origin main', 'force main', 'refused', 'force_push_protected'],
  ['git push -f origin master', 'force master', 'refused', 'force_push_protected'],
  ['git push origin +main', 'plus refspec', 'refused', 'force_push_protected'],
  ['git push --force-with-lease origin HEAD:main', 'lease to main', 'refused', 'force_push_protected'],
  [
    'git push --force origin dev-working',
    'a working branch from the config',
    'refused',
    'force_push_protected',
  ],
  ['git push --force', 'no branch named', 'refused', 'force_push_protected'],
  ['git push --force origin HEAD', 'HEAD does not name a branch', 'refused', 'force_push_protected'],
  ['git push origin --delete main', 'delete main', 'refused', 'force_push_protected'],
  ['git push origin :master', 'delete master by refspec', 'refused', 'force_push_protected'],
  ['git push --mirror origin', 'mirror', 'refused', 'force_push_protected'],
  ['git -C /x push -f origin main', 'git -C', 'refused', 'force_push_protected'],
  ['git push origin main', 'a normal push to main is not a force push', 'allowed'],

  // ---- refused: dropping databases
  ['psql -c "DROP DATABASE app"', 'psql drop database', 'refused', 'drop_database'],
  [
    'docker exec db psql -U postgres -c "drop database app;"',
    'drop database in a container',
    'refused',
    'drop_database',
  ],
  ['dropdb app', 'dropdb', 'refused', 'drop_database'],
  ['mysql -e "DROP SCHEMA app"', 'mysql drop schema', 'refused', 'drop_database'],
  ['redis-cli flushall', 'flushall', 'refused', 'drop_database'],
  ['mongosh --eval "db.dropDatabase()"', 'mongo dropDatabase', 'refused', 'drop_database'],
  ['psql -c "SELECT 1"', 'a normal query', 'allowed'],

  // ---- refused: off the workstation
  ['ssh uat-server ls', 'ssh', 'refused', 'off_workstation'],
  ['scp ./dist uat:/srv/app', 'scp', 'refused', 'off_workstation'],
  ['rsync -av ./dist/ deploy@uat:/srv/app/', 'rsync to a remote', 'refused', 'off_workstation'],
  ['rsync -av deploy@uat:/srv/app/ ./pull/', 'rsync from a remote', 'refused', 'off_workstation'],
  ['docker -H tcp://10.0.0.5:2375 ps', 'docker -H remote', 'refused', 'off_workstation'],
  ['docker --host=ssh://uat ps', 'docker --host', 'refused', 'off_workstation'],
  ['docker --context uat ps', 'docker --context', 'refused', 'off_workstation'],
  ['docker -c uat ps', 'docker -c', 'refused', 'off_workstation'],
  ['docker context use prod', 'docker context use', 'refused', 'off_workstation'],
  ['DOCKER_HOST=tcp://x:2375 docker ps', 'DOCKER_HOST prefix', 'refused', 'off_workstation'],
  ['export DOCKER_HOST=ssh://prod', 'DOCKER_HOST export', 'refused', 'off_workstation'],
  ['kubectl get pods', 'kubectl', 'refused', 'off_workstation'],
  ['helm upgrade app ./chart', 'helm', 'refused', 'off_workstation'],
  ['aws s3 ls', 'aws', 'refused', 'off_workstation'],
  ['gcloud compute instances list', 'gcloud', 'refused', 'off_workstation'],
  ['az vm list', 'az', 'refused', 'off_workstation'],
  ['terraform apply', 'terraform', 'refused', 'off_workstation'],
  ['timeout 30 ssh uat true', 'ssh behind timeout', 'refused', 'off_workstation'],
  ['echo hi && ssh uat true', 'ssh after &&', 'refused', 'off_workstation'],
  ['bash -c "scp a b:/c"', 'scp in bash -c', 'refused', 'off_workstation'],
  ['echo $(ssh uat hostname)', 'ssh in a substitution', 'refused', 'off_workstation'],
];

describe('DevOps guard: command classifier', () => {
  it.each(rows)('%s (%s)', (command, _why, decision, rule) => {
    const v = classifyCommand(command, cfg(), CWD);
    expect(v.decision, `${command}: ${v.reason ?? v.rule}`).toBe(decision);
    if (rule) expect(v.rule).toBe(rule);
    if (decision === 'refused') expect(v.reason).toBeTruthy();
  });

  it('refusals of off-workstation commands point at aom devops-approval', () => {
    const v = classifyCommand('ssh uat ls', cfg(), CWD);
    expect(v.reason).toMatch(/aom devops-approval/);
  });

  it('an approved command passes; a different one does not', () => {
    const c = cfg({ approvedCommands: ['ssh uat-server  systemctl restart app'] });
    expect(classifyCommand('ssh uat-server systemctl restart app', c, CWD)).toMatchObject({
      decision: 'allowed',
      rule: 'off_workstation_approved',
    });
    expect(classifyCommand('ssh uat-server rm -rf /', c, CWD).decision).toBe('refused');
    expect(classifyCommand('ssh other-server systemctl restart app', c, CWD).decision).toBe('refused');
  });

  it('an approval never lifts an always-refused rule', () => {
    const c = cfg({ approvedCommands: ['sudo rm -rf /', 'git push --force origin main'] });
    expect(classifyCommand('sudo rm -rf /', c, CWD).decision).toBe('refused');
    expect(classifyCommand('git push --force origin main', c, CWD).decision).toBe('refused');
  });

  it('in a chat the message tells it to file a DevOps request instead', () => {
    const v = classifyCommand('ssh uat ls', cfg({ kind: 'chat' }), CWD);
    expect(v.reason).toMatch(/aom devops/);
  });

  it('splits command lines the way the shell does', () => {
    expect(splitSegments('a b && c "d && e" | f; g').map((s) => s.words)).toEqual([
      ['a', 'b'],
      ['c', 'd && e'],
      ['f'],
      ['g'],
    ]);
    expect(splitSegments('echo x > /tmp/out 2>&1')[0]).toMatchObject({
      words: ['echo', 'x'],
      redirects: ['/tmp/out'],
    });
    expect(substitutions("echo $(ls $(pwd)) `whoami` '$(no)'")).toEqual(['ls $(pwd)', 'pwd', 'whoami']);
  });

  it('redacts secrets before a command is stored', () => {
    expect(redactCommand('psql postgres://u:p@h/db --password=hunter2')).not.toContain('hunter2');
    expect(redactCommand('curl -H "Authorization: Bearer abcdefghijkl123456"')).not.toContain(
      'abcdefghijkl123456',
    );
    expect(redactCommand('export API_TOKEN=abc123xyz')).not.toContain('abc123xyz');
    expect(redactCommand('docker ps')).toBe('docker ps');
  });
});

describe('DevOps guard: hook', () => {
  const hookInput = (command: string, tool = 'Bash') =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd: CWD });

  it('allows silently and audits an allowed command', async () => {
    const sent: unknown[] = [];
    const r = await runGuardHook({
      stdin: hookInput('docker ps'),
      cfg: cfg(),
      now: () => new Date('2026-10-17T10:00:00Z'),
      report: async (e) => {
        sent.push(...e);
        return true;
      },
    });
    expect(r).toEqual({ stdout: '', code: 0 });
    expect(sent).toEqual([
      {
        at: '2026-10-17T10:00:00.000Z',
        sessionRef: 'shift-1',
        kind: 'shift',
        decision: 'allowed',
        rule: 'ok',
        command: 'docker ps',
      },
    ]);
  });

  it('denies a refused command with the permission decision and audits it', async () => {
    const sent: any[] = [];
    const r = await runGuardHook({
      stdin: hookInput('sudo reboot'),
      cfg: cfg(),
      report: async (e) => {
        sent.push(...e);
        return true;
      },
    });
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/aom sudo/);
    expect(sent[0]).toMatchObject({ decision: 'refused', rule: 'user_admin' });
  });

  it('writes the local audit file when the runner cannot be reached', async () => {
    const dir = tmp('guard-audit-');
    mkdirSync(dir, { recursive: true });
    const auditFile = join(dir, 'logs', 'devops-audit.jsonl');
    await runGuardHook({
      stdin: hookInput('ssh uat ls'),
      cfg: cfg({ auditFile }),
      report: async () => false,
    });
    expect(existsSync(auditFile)).toBe(true);
    expect(JSON.parse(readFileSync(auditFile, 'utf8').trim())).toMatchObject({
      decision: 'refused',
      rule: 'off_workstation',
    });
  });

  it('does not write the file when the runner took the entry', async () => {
    const dir = tmp('guard-audit-');
    const auditFile = join(dir, 'a.jsonl');
    await runGuardHook({ stdin: hookInput('docker ps'), cfg: cfg({ auditFile }), report: async () => true });
    expect(existsSync(auditFile)).toBe(false);
  });

  it('ignores other tools and unreadable input', async () => {
    const report = async () => true;
    expect(await runGuardHook({ stdin: hookInput('x', 'Read'), cfg: cfg(), report })).toEqual({
      stdout: '',
      code: 0,
    });
    expect(await runGuardHook({ stdin: 'not json', cfg: cfg(), report })).toEqual({ stdout: '', code: 0 });
  });

  it('a missing or broken config file fails closed to the defaults', () => {
    const c = loadGuardConfig('/nonexistent/guard.json');
    expect(classifyCommand('rm -rf /home/u/src', c, '/tmp').decision).toBe('refused');
    expect(classifyCommand('rm -rf /tmp/x', c, '/tmp').decision).toBe('allowed');
  });
});
