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
    'docker compose -f docker-compose.yml ps',
    'docker compose ls --format json',
    'docker ps -a',
    'docker image ls',
    'npm ls --depth=0',
    'npm --version',
    'aom setup propose --area run --file proposal.json',
    'find . -name "*.csproj" -not -path "./node_modules/*"',
    'git tag --list',
    'git remote -v',
    "docker inspect --format '{{.State.Status}}' web",
    'grep -rn "TODO" src',
    "grep -n 'foo$' README.md",
    'git log --oneline --max-count=5 -- src',
    'git show HEAD:README.md',
    'cat .env.example',
    'sort -u names.txt | uniq -c',
    'rg -n "listen" --glob "*.ts"',
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

  // the review's second round: every one of these is a way to write, run, or read a secret in a read-only scan
  const bypasses = [
    // a command hidden in an argument
    'cat <(rm x)',
    'cat >(tee /tmp/x)',
    'ls $(rm x)',
    'ls `rm x`',
    'echo "$(id)"',
    'echo $HOME',
    'echo ${AWS_SECRET_ACCESS_KEY}',
    'jq -n env',
    "jq -n '$ENV'",
    "jq -n '[env]'",
    // flags that write or run
    'sort --out=x a',
    'sort -Ro x a',
    'sort --compress-program=sh a',
    'sort -T /tmp a',
    'uniq in OUT',
    'uniq a b',
    'docker compose config -o /tmp/x',
    'docker compose config',
    'docker -Hssh://h ps',
    'docker --host=tcp://h ps',
    'docker -c prod ps',
    'rg --hostname-bin=x foo',
    'rg --pre=x foo',
    'rg --pre x foo',
    'rg -z foo',
    'rg --search-zip foo',
    'git log --out=/tmp/x',
    'git diff --ext=x',
    'git diff --no-index ~/.ssh/id_rsa /dev/null',
    'git log --exec-path=/tmp',
    'git -C /tmp log --output=/tmp/x',
    'git grep foo',
    'git show --textconv HEAD',
    'ls --color=always --block-size=1',
    'cat --bogus',
    'head -f x',
    'tail -f x',
    'find . -fprint x',
    'find . -ok rm {} ;',
    'find . -newer /tmp -delete',
    'du --files0-from=x',
    'grep --exclude-from=x foo',
    'tr -d a --bogus',
    // secrets
    'cat ~/.ssh/id_ed25519',
    'cat /home/u/.ssh/config',
    'ls /home/u/.ssh',
    'cat ~/.aws/credentials',
    'cat ~/.config/gcloud/application_default_credentials.json',
    'cat .env',
    'cat web/.env.production',
    'cat apps/server/.env.local',
    'head -3 /home/u/.config/aom-uat/secret.env',
    'cat /home/u/.aom-runner/secrets/deploy.json',
    'cat /home/u/.aom-runner/keys/deploy/abc/id_ed25519',
    'cat /proc/self/environ',
    'cat /proc/1234/environ',
    'grep -r password /home/u',
    'grep -r password ~',
    'grep -r password /',
    'rg password /home/u',
    'find /home/u -name "*.pem"',
    'find / -name id_rsa',
    'git show HEAD:.env',
    'git log -p -- .env',
    'git -C /home/u/.ssh status',
    'docker inspect web',
    "docker inspect --format '{{.Config.Env}}' web",
    "docker inspect -f '{{json .Config}}' web",
    'docker image inspect img',
    'cat id_rsa',
    'cat server.pem',
    'wc -l /home/u/.netrc',
    'ls ~/.docker',
    'cat ~/.docker/config.json',
    'cat ~/.npmrc',
    'cat ~/.git-credentials',
    'aom setup propose --file ~/.ssh/id_rsa',
    'aom setup propose --area run --bogus x',
    'aom deploy probe --local --bogus',
    'aom deploy run --env production',
    'aom sudo run x',
    'npm view left-pad',
    'npm outdated',
    'npm ls --prefix /tmp',
    'cat a | tee b',
  ];
  it.each(bypasses)('refuses the bypass %s', (command) => {
    const v = run(command, cfg({ secretRoots: ['/home/u/.aom-runner/secrets', '/home/u/.aom-runner/keys'] }));
    expect(v.decision, command).toBe('refused');
    expect(v.rule).toBe('scan_read_only');
  });

  it('still reads the project: templates, manifests, logs and its own scratch folder', () => {
    const c = cfg({ secretRoots: ['/home/u/.aom-runner/secrets', '/home/u/.aom-runner/keys'] });
    for (const command of [
      'cat package.json',
      'cat .env.example',
      'cat .env.sample',
      'ls /home/u/src/toy',
      'grep -rn listen /home/u/src/toy/src',
      'find /home/u/src/toy -name "*.yml" -not -path "*/node_modules/*"',
      'git -C /home/u/src/toy log --oneline -5',
      'cat /home/u/.aom-runner/agents/devops/scratch/notes.txt',
    ])
      expect(run(command, c).decision, command).toBe('allowed');
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

  it('has no web tools (nothing to send a secret to) and cannot Read credential folders', () => {
    const s = settings(true);
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
    expect(s.permissions.allow).not.toContain('WebFetch');
    expect(s.permissions.allow).not.toContain('WebSearch');
    const reads = s.permissions.deny.filter((d) => d.startsWith('Read('));
    for (const dir of ['.ssh', '.aws', '.config/gcloud', '.kube', '.gnupg', '.docker'])
      expect(reads.some((d) => d.includes(`/${dir}/`) || d.includes(`/${dir})`))).toBe(true);
    expect(reads.some((d) => d.includes('.env'))).toBe(true);
    // an ordinary DevOps shift keeps the web
    expect(settings(false).permissions.allow).toContain('WebFetch');
  });

  it('an ordinary DevOps shift keeps its full Edit', () => {
    const s = settings(false);
    expect(s.permissions.allow).toContain('Edit');
    expect(s.permissions.deny).not.toContain('NotebookEdit');
  });
});
