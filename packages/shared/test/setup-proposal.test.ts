import { describe, expect, it } from 'vitest';
import {
  checkPointer,
  itemConfidence,
  localAdoptEnv,
  parsePointer,
  resolvePointer,
  SetupProposalSchema,
  setPointer,
} from '../src/index.ts';

const repoId = '11111111-1111-4111-8111-111111111111';
const run = {
  setup: [{ name: 'install', repoId, cmd: ['npm', 'ci'] }],
  services: [{ name: 'web', repoId, cmd: ['npm', 'start'], ports: [{ name: 'http', default: 3000 }] }],
};

describe('JSON pointers', () => {
  it('parse, resolve and set', () => {
    expect(parsePointer('/a/b~1c/0')).toEqual(['a', 'b/c', '0']);
    expect(parsePointer('a')).toBeNull();
    expect(parsePointer('/__proto__/x')).toBeNull();
    expect(
      resolvePointer({ services: [{ ports: [{ default: 3000 }] }] }, '/services/0/ports/0/default'),
    ).toBe(3000);
    expect(resolvePointer({ a: 1 }, '/b')).toBeUndefined();
    expect(resolvePointer({ a: 1 }, '/constructor')).toBeUndefined();
    const before = { services: [{ ports: [{ default: 3000 }] }] };
    const after = setPointer(before, '/services/0/ports/0/default', 8080);
    expect(after.services[0]?.ports[0]?.default).toBe(8080);
    expect(before.services[0]?.ports[0]?.default).toBe(3000);
  });

  it('a missing value is fine for unknown items, but not its missing parent', () => {
    expect(checkPointer({ services: [{}] }, '/services/0/ports', true)).toBeNull();
    expect(checkPointer({ services: [{}] }, '/services/3/ports', true)).not.toBeNull();
    expect(checkPointer({ services: [{}] }, '/services/0/ports', false)).not.toBeNull();
  });
});

describe('SetupProposalSchema', () => {
  it('accepts a run proposal with found, guessed and unknown items and a question', () => {
    const p = SetupProposalSchema.parse({
      area: 'run',
      run,
      items: [
        { path: '/setup/0', confidence: 'found', evidence: [{ file: 'package.json', line: 5 }] },
        { path: '/services/0/ports/0/default', confidence: 'guessed', note: 'usual port' },
        { path: '/services/0/health', confidence: 'unknown' },
      ],
      questions: [
        { path: '/services/0/health', question: 'Which page shows the app is ready?', default: '/' },
      ],
      secretsNeeded: ['SMTP_PASSWORD'],
      notes: 'Read package.json',
    });
    expect(p.items).toHaveLength(3);
    expect(p.run?.services[0]?.health).toEqual({ kind: 'none', graceSec: 3 });
    expect(itemConfidence(p, '/services/0')).toBe('unknown');
    expect(itemConfidence(p, '/services/0/ports')).toBe('guessed');
    expect(itemConfidence(p, '/setup/0')).toBe('found');
    expect(itemConfidence(p, '/setup/9')).toBeNull();
  });

  it('refuses: missing plan, bad pointers, bad secret names, long notes', () => {
    expect(SetupProposalSchema.safeParse({ area: 'run' }).success).toBe(false);
    expect(SetupProposalSchema.safeParse({ area: 'deploy' }).success).toBe(false);
    const bad = SetupProposalSchema.safeParse({
      area: 'run',
      run,
      items: [{ path: '/services/7/cmd', confidence: 'found' }],
    });
    expect(bad.success).toBe(false);
    expect(
      SetupProposalSchema.safeParse({ area: 'run', run, items: [{ path: 'nope', confidence: 'found' }] })
        .success,
    ).toBe(false);
    expect(SetupProposalSchema.safeParse({ area: 'run', run, secretsNeeded: ['lower case'] }).success).toBe(
      false,
    );
    expect(SetupProposalSchema.safeParse({ area: 'run', run, notes: 'x'.repeat(4001) }).success).toBe(false);
    expect(
      SetupProposalSchema.safeParse({ area: 'run', run, items: [{ path: '/setup/0', confidence: 'sure' }] })
        .success,
    ).toBe(false);
  });

  it('a deploy proposal carries a typed delivery setup; pointers into it are checked', () => {
    const env = localAdoptEnv({
      name: 'uat',
      label: 'Test copy',
      target: 'aom-uat',
      composeFile: '~/app/docker-compose.yml',
      service: 'app',
      imageName: 'app',
    });
    const ok = SetupProposalSchema.safeParse({
      area: 'deploy',
      deploy: { environments: [env] },
      items: [{ path: '/environments/0/app/service', confidence: 'guessed' }],
      questions: [
        { path: '/environments/0/app/service', question: 'Which part is your app?', options: ['app', 'web'] },
      ],
    });
    expect(ok.success).toBe(true);
    expect(SetupProposalSchema.safeParse({ area: 'deploy', deploy: { version: 1 } }).success).toBe(false);
    expect(
      SetupProposalSchema.safeParse({
        area: 'deploy',
        deploy: { environments: [env] },
        items: [{ path: '/environments/3/app', confidence: 'found' }],
      }).success,
    ).toBe(false);
    // a value that breaks the strict character sets never gets that far
    expect(
      SetupProposalSchema.safeParse({
        area: 'deploy',
        deploy: { environments: [{ ...env, app: { ...env.app, service: 'a; rm -rf /' } }] },
      }).success,
    ).toBe(false);
  });
});

describe('the scan brief', () => {
  it('a scan shift renders a read-only brief with the repositories, the schema hints and the submit command', async () => {
    const { renderDevopsPrompt } = await import('../src/index.ts');
    const text = renderDevopsPrompt({
      requestId: '22222222-2222-4222-8222-222222222222',
      threadId: '22222222-2222-4222-8222-222222222222',
      summary: 'Scan Toy to find out how to run it (read-only).',
      requestedBy: { kind: 'user', id: 'u', name: 'Mia' },
      workstationName: 'Office PC',
      access: { allowInstall: false, allowDocker: false, allowedPaths: [], sudo: false },
      history: [],
      scan: {
        area: 'run',
        projectKey: 'TOY',
        projectName: 'Toy',
        repos: [
          { repoId, name: 'toy', remoteUrlNormalized: 'github.com/acme/toy', clonePath: '/home/mia/src/toy' },
        ],
        runInstructions: '',
        repoInstructions: [],
        currentPlan: null,
        note: 'the website is in web/',
      },
    } as never);
    expect(text).toContain('READ-ONLY scan');
    expect(text).toContain('aom setup propose --area run --file');
    expect(text).toContain(`toy (repo id ${repoId}): /home/mia/src/toy`);
    expect(text).toContain('the website is in web/');
    expect(text).toContain('found');
    expect(text).toContain('This is a scan request');
    expect(text).not.toContain('This is a run request');
  });
});
