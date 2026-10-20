import { describe, expect, it } from 'vitest';
import { buildShiftSettings } from '../src/adapters/claude-policy.ts';
import { classifyCommand, deleteRootsFor, type GuardConfig } from '../src/devops/guard.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

// "Scan with DevOps" is read-only (docs/design/deploy-run-ux-design.md section 5.2): the guard refuses what starts, builds,
// installs, connects or writes, and lets reading through.
const ROOT = '/home/u/.aom-runner';
const SCRATCH = `${ROOT}/agents/devops/scratch`;
const cfg = (over: Partial<GuardConfig> = {}): GuardConfig => ({
  sessionRef: 'shift-1',
  kind: 'shift',
  deleteRoots: deleteRootsFor(ROOT, '/tmp'),
  home: '/home/u',
  protectedBranches: [],
  approvedCommands: [],
  readOnlyScan: true,
  ...over,
});
const run = (command: string, c = cfg()) => classifyCommand(command, c, SCRATCH);

describe('a read-only scan', () => {
  const allowed = [
    'ls -la /home/u/src/toy',
    'cat package.json | jq .scripts',
    'grep -rn "listen(" src',
    'head -50 README.md',
    'git log --oneline -20',
    'git -C /home/u/src/toy status --short',
    'git diff HEAD~1 --stat',
    'git branch --list',
    'docker version --format json',
    'docker compose ls --all',
    'docker compose -f docker-compose.yml config',
    'docker ps -a',
    'docker image ls',
    'npm ls --depth=0',
    'npm --version',
    'aom setup propose --area run --file proposal.json',
    'find . -name "*.csproj" -not -path "./node_modules/*"',
    'git tag --list',
    'git remote -v',
    'docker inspect web',
    'pnpm ls --depth 0',
    'aom deploy probe --local',
    'echo hi 2>/dev/null',
  ];
  it.each(allowed)('lets %s through', (command) => {
    expect(run(command).decision, JSON.stringify(run(command))).toBe('allowed');
  });

  const refused = [
    'npm ci',
    'npm install',
    'npm run build',
    'pnpm install --frozen-lockfile',
    'yarn start',
    'npx vite',
    'pip install -r requirements.txt',
    'cargo build',
    'make',
    'dotnet run',
    'docker compose up -d',
    'docker compose down',
    'docker run --rm postgres:16',
    'docker rm -f x',
    'docker build .',
    'docker system prune -af',
    'ssh root@host ls',
    'scp a b:c',
    'rsync -a . host:/x',
    'curl https://example.com',
    'git push origin main',
    'git commit -am x',
    'git checkout -b x',
    'git reset --hard',
    'git clean -fd',
    'git branch -D old',
    'git config user.name x',
    'git config --get remote.origin.url',
    'git tag -d v1',
    'rm -rf node_modules',
    'mv a b',
    'cp a b',
    'mkdir x',
    'touch x',
    'chmod +x run.sh',
    'sed -i s/a/b/ file',
    'sudo apt-get install x',
    'kill 123',
    'systemctl restart x',
    'echo x > /home/u/src/toy/file',
    'cat a >> /etc/hosts',
    // looked through
    'env FOO=1 npm ci',
    'timeout 5 docker compose up',
    'bash -c "npm ci"',
    'ls $(npm ci)',
    'ls && docker compose down',
    'cat x | xargs rm',
    // the review's bypass list
    'bash -lc "npm ci"',
    'sh -ec "ls"',
    'npm version patch',
    'npm pkg set scripts.x=y',
    'git -c core.pager="rm -rf x" log',
    "git grep -O'rm x' foo",
    'git diff --output=/home/u/x',
    'git branch x',
    'git tag x',
    'find . -delete',
    'find . -exec rm {} ;',
    'ls | xargs -I{} rm {}',
    'env -u X rm y',
    'cat x | sh',
    './x',
    'node -e 1',
    'python3 -c 1',
    'perl -e 1',
    'awk BEGIN{system(1)}',
    'eval ls',
    'source x',
    'echo hi > /tmp/note.txt',
    'cat x > /dev/tcp/h/1',
    'FOO=1 ls',
    'rg --pre ./x foo',
    'sort -o a b',
    'docker -H ssh://h ps',
    'docker compose up',
    'docker run x',
  ];
  it.each(refused)('refuses %s', (command) => {
    const v = run(command);
    expect(v.decision, command).toBe('refused');
    expect(v.rule).toBe('scan_read_only');
    expect(v.reason).toContain('READ-ONLY');
  });

  it('is only on for scan shifts: the same commands pass the ordinary DevOps guard', () => {
    expect(run('npm ci', cfg({ readOnlyScan: false })).decision).toBe('allowed');
    expect(run('docker compose up -d', cfg({ readOnlyScan: false })).decision).toBe('allowed');
  });

  it('keeps the ordinary guard rules on top (a destructive command is refused either way)', () => {
    const v = run('cat x', cfg());
    expect(v.decision).toBe('allowed');
    expect(run('dropdb prod', cfg()).decision).toBe('refused');
  });
});

describe('the scan profile of the DevOps settings', () => {
  const settings = (scan: boolean) =>
    buildShiftSettings(
      {
        allowedTools: ['read', 'edit', 'shell'],
        deniedShellPatterns: [],
        writableGlobs: null,
        mayCommit: true,
      } as never,
      policyCtx(scan ? { readOnlyScan: true } : {}),
      POLICY_PATHS,
      'devops',
      true,
    );

  it('writes only inside the scratch folder (Edit outside it is not allowed, NotebookEdit is denied)', () => {
    const s = settings(true);
    expect(s.permissions.allow).not.toContain('Edit');
    expect(s.permissions.allow).toContain('Edit(//data/agents/a1/scratch/**)');
    expect(s.permissions.allow).toContain('Write(//data/agents/a1/scratch/**)');
    expect(s.permissions.deny).toContain('NotebookEdit');
    expect(s.permissions.defaultMode).toBe('dontAsk');
  });

  it('an ordinary DevOps shift keeps its full Edit', () => {
    const s = settings(false);
    expect(s.permissions.allow).toContain('Edit');
    expect(s.permissions.deny).not.toContain('NotebookEdit');
  });
});
