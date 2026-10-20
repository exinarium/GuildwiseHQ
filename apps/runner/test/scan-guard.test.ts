import { describe, expect, it } from 'vitest';
import { classifyCommand, deleteRootsFor, type GuardConfig } from '../src/devops/guard.ts';

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
    'git config --get remote.origin.url',
    'docker version --format json',
    'docker compose ls --all',
    'docker compose -f docker-compose.yml config',
    'docker ps -a',
    'docker image ls',
    'npm ls --depth=0',
    'npm --version',
    'aom setup propose --area run --file proposal.json',
    `cat > ${SCRATCH}/proposal.json <<'EOF'\n{}\nEOF`,
    'echo hi > /tmp/note.txt',
    'find . -name "*.csproj" -not -path "./node_modules/*"',
    'python3 -c "import json,sys; json.load(open(\'p.json\'))"',
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
