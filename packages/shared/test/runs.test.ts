import { describe, expect, it } from 'vitest';
import {
  DevopsRunSchema,
  type DevopsShift,
  DomainEventSchema,
  formatCommandLine,
  formatRunHealth,
  formatRunPort,
  isAckedFromRunner,
  isSafeRelativeDir,
  makeEnvelope,
  parseCommandLine,
  parseRunHealth,
  parseRunPort,
  RunnerToServerSchema,
  RunPlanSchema,
  RunRestartPayloadSchema,
  RunSettingsSchema,
  RunStartPayloadSchema,
  renderDevopsPrompt,
  renderRunSection,
  runOrder,
  ServerToRunnerSchema,
  validateRunPlan,
  validateRunSettings,
  withDependencies,
} from '../src/index.ts';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const svc = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  repoId: ID(1),
  cmd: ['node', 'x.js'],
  ...over,
});

describe('run plans', () => {
  it('fills in the defaults of a plan', () => {
    const plan = RunPlanSchema.parse({ services: [svc('web')] });
    expect(plan).toMatchObject({
      version: 1,
      setup: [],
      notes: '',
      services: [
        {
          cwd: '.',
          env: {},
          ports: [],
          health: { kind: 'none', graceSec: 3 },
          startTimeoutSec: 300,
          after: [],
          docker: false,
        },
      ],
    });
  });

  it('validates names, dependencies, cycles, paths and env files', () => {
    const ok = RunPlanSchema.parse({ services: [svc('db'), svc('api', { after: ['db'] })] });
    expect(validateRunPlan(ok)).toEqual([]);
    expect(validateRunPlan(RunPlanSchema.parse({ services: [svc('a'), svc('A')] }))).toEqual([
      'service "A" appears twice',
    ]);
    expect(validateRunPlan(RunPlanSchema.parse({ services: [svc('a', { after: ['b'] })] }))[0]).toMatch(
      /after "b" is not a service/,
    );
    expect(
      validateRunPlan(
        RunPlanSchema.parse({ services: [svc('a', { after: ['b'] }), svc('b', { after: ['a'] })] }),
      ),
    ).toContain('the "after" dependencies of the services form a cycle');
    expect(validateRunPlan(RunPlanSchema.parse({ services: [svc('a', { cwd: '../x' })] }))[0]).toMatch(
      /inside the repository/,
    );
    expect(validateRunPlan(RunPlanSchema.parse({ services: [svc('a', { envFile: 'rel.env' })] }))[0]).toMatch(
      /absolute path/,
    );
    expect(
      validateRunPlan(
        RunPlanSchema.parse({
          services: [
            svc('a', {
              ports: [
                { name: 'p', default: 1 },
                { name: 'P', default: 2 },
              ],
            }),
          ],
        }),
      ),
    ).toEqual(['service "a": port "P" appears twice']);
    expect(() => RunPlanSchema.parse({ services: [svc('bad name')] })).toThrow();
    expect(() => RunPlanSchema.parse({ services: [svc('a', { cmd: [] })] })).toThrow();
    expect(() => RunPlanSchema.parse({ services: [svc('a', { env: { 'bad-name': 'x' } })] })).toThrow();
  });

  it('orders services by their dependencies and adds what a chosen service needs', () => {
    const list = [
      { name: 'web', after: ['api'] },
      { name: 'api', after: ['db'] },
      { name: 'db', after: [] as string[] },
      { name: 'docs', after: [] as string[] },
    ];
    expect(runOrder(list)?.map((s) => s.name)).toEqual(['db', 'api', 'web', 'docs']);
    expect(withDependencies(list, ['web']).map((s) => s.name)).toEqual(['db', 'api', 'web']);
    expect(withDependencies(list, ['docs', 'DB']).map((s) => s.name)).toEqual(['db', 'docs']);
    expect(
      runOrder([
        { name: 'a', after: ['b'] },
        { name: 'b', after: ['a'] },
      ]),
    ).toBeNull();
  });

  it('accepts only relative folders that stay inside', () => {
    for (const ok of ['.', 'src/Api', 'a/b/c', './x']) expect(isSafeRelativeDir(ok)).toBe(true);
    for (const bad of ['/etc', '../x', 'a/../../b', 'C:\\x', '\\x', 'a\0b'])
      expect(isSafeRelativeDir(bad)).toBe(false);
  });
});

describe('command lines, ports and health checks', () => {
  it('round-trips a command line without a shell', () => {
    expect(parseCommandLine(`dotnet run --project "src/My Api" -- --urls 'http://x:5000'`)).toEqual([
      'dotnet',
      'run',
      '--project',
      'src/My Api',
      '--',
      '--urls',
      'http://x:5000',
    ]);
    expect(parseCommandLine('a  b\\ c "" d')).toEqual(['a', 'b c', '', 'd']);
    const argv = ['npm', 'run', 'dev', '--', '--name=a b', 'say "hi"'];
    expect(parseCommandLine(formatCommandLine(argv))).toEqual(argv);
  });

  it('parses and prints ports', () => {
    expect(parseRunPort('http:5000:ASPNETCORE_HTTP_PORTS')).toEqual({
      name: 'http',
      default: 5000,
      envVar: 'ASPNETCORE_HTTP_PORTS',
      url: 'http://localhost:${port}/',
    });
    expect(parseRunPort('db:5432')).toEqual({ name: 'db', default: 5432 });
    expect(formatRunPort(parseRunPort('web:5173:PORT'))).toBe('web:5173:PORT');
    for (const bad of ['5000', 'http:x', 'http:0', 'http:70000', 'a:1:B:c'])
      expect(() => parseRunPort(bad)).toThrow(/name:number/);
  });

  it('parses and prints health checks', () => {
    expect(parseRunHealth('http://localhost:${port}/health')).toEqual({
      kind: 'http',
      url: 'http://localhost:${port}/health',
      expect: '2xx',
    });
    expect(parseRunHealth('tcp:5432')).toEqual({ kind: 'tcp', port: 5432 });
    expect(parseRunHealth('tcp:http')).toEqual({ kind: 'tcp', port: 'http' });
    expect(parseRunHealth('log:Now listening')).toEqual({ kind: 'log', regex: 'Now listening' });
    expect(parseRunHealth('none')).toEqual({ kind: 'none', graceSec: 3 });
    expect(parseRunHealth('none:10')).toEqual({ kind: 'none', graceSec: 10 });
    for (const h of ['http://x/', 'tcp:80', 'log:x', 'none:4'] as const)
      expect(formatRunHealth(parseRunHealth(h))).toBe(h);
    expect(() => parseRunHealth('ping')).toThrow(/health check/);
  });
});

describe('run settings', () => {
  it('has the owner decisions as defaults: 8 hours, Docker off', () => {
    expect(RunSettingsSchema.parse({})).toEqual({
      ttlHours: 8,
      allowDocker: false,
      services: [],
      buildGuides: [],
    });
    expect(() => RunSettingsSchema.parse({ ttlHours: 0 })).toThrow();
    expect(() => RunSettingsSchema.parse({ ttlHours: 73 })).toThrow();
  });

  it('checks the declared services', () => {
    const base = { ttlHours: 8, allowDocker: false };
    const decl = (name: string, over: Record<string, unknown> = {}) => ({
      name,
      repoId: ID(1),
      cwd: '.',
      ports: [],
      after: [],
      ...over,
    });
    expect(
      validateRunSettings(
        RunSettingsSchema.parse({ ...base, services: [decl('a'), decl('b', { after: ['a'] })] }),
      ),
    ).toEqual([]);
    expect(
      validateRunSettings(RunSettingsSchema.parse({ ...base, services: [decl('a', { after: ['x'] })] }))[0],
    ).toMatch(/not a service/);
    expect(
      validateRunSettings(RunSettingsSchema.parse({ ...base, services: [decl('a', { envFile: 'x' })] }))[0],
    ).toMatch(/absolute path/);
    expect(
      validateRunSettings(
        RunSettingsSchema.parse({
          ...base,
          services: [decl('a', { after: ['b'] }), decl('b', { after: ['a'] })],
        }),
      ),
    ).toContain('the "after" dependencies form a cycle');
  });
});

describe('protocol additions', () => {
  const start = {
    envId: ID(2),
    projectId: ID(3),
    projectKey: 'TOY',
    projectName: 'Toy',
    purpose: 'manual',
    requestId: ID(4),
    sources: [{ repoId: ID(1), name: 'toy', remoteUrlNormalized: 'github.com/acme/toy', branch: 'main' }],
    services: [],
    portRange: { from: 20000, to: 29999 },
    ttlAt: '2026-10-14T20:00:00.000Z',
    allowDocker: false,
  };

  it('knows run.start, run.stop and run.extend as commands', () => {
    expect(RunStartPayloadSchema.parse(start)).toMatchObject({ allowDocker: false });
    const cmd = makeEnvelope('command', { commandId: 'c1', command: 'run.start', payload: start });
    expect(ServerToRunnerSchema.safeParse(cmd).success).toBe(true);
    expect(
      ServerToRunnerSchema.safeParse(makeEnvelope('run.follow', { envId: ID(2), follow: true })).success,
    ).toBe(true);
    expect(RunStartPayloadSchema.safeParse({ ...start, sources: [] }).success).toBe(false);
  });

  it('carries a saved plan to replay in run.start, and knows run.restart and run.replay.failed', () => {
    const start = {
      envId: ID(2),
      projectId: ID(3),
      projectKey: 'TOY',
      projectName: 'Toy',
      purpose: 'manual',
      requestId: null,
      sources: [{ repoId: ID(1), name: 'toy', remoteUrlNormalized: 'github.com/acme/toy', branch: 'main' }],
      portRange: { from: 20000, to: 29999 },
      ttlAt: '2026-10-15T10:00:00.000Z',
      replay: {
        planId: ID(9),
        version: 3,
        plan: { services: [svc('web')] },
        buildHash: 'abc',
      },
    };
    const parsed = RunStartPayloadSchema.parse(start);
    expect(parsed.replay?.plan.services[0]?.name).toBe('web');
    expect(
      RunStartPayloadSchema.safeParse({ ...start, replay: { ...start.replay, version: 0 } }).success,
    ).toBe(false);
    expect(RunRestartPayloadSchema.parse({ envId: ID(2), ttlAt: '2026-10-15T10:00:00.000Z' })).toEqual({
      envId: ID(2),
      update: false,
      revive: false,
      ttlAt: '2026-10-15T10:00:00.000Z',
    });
    const cmd = makeEnvelope('command', {
      commandId: 'c2',
      command: 'run.restart',
      payload: { envId: ID(2), update: true, ttlAt: '2026-10-15T10:00:00.000Z' },
    });
    expect(ServerToRunnerSchema.safeParse(cmd).success).toBe(true);
    expect(
      RunnerToServerSchema.safeParse(
        makeEnvelope('run.replay.failed', { envId: ID(2), reason: 'service "web" failed', logTail: 'x' }),
      ).success,
    ).toBe(true);
    // the failure is acked: it is persisted and resent until the server has filed the DevOps request
    expect(isAckedFromRunner('run.replay.failed')).toBe(true);
  });

  it('has the events of a stale plan and a restart', () => {
    const ok = (type: string, payload: unknown) => DomainEventSchema.safeParse({ type, payload }).success;
    expect(
      ok('RunPlanMarkedStale', {
        planId: ID(9),
        projectId: ID(3),
        workstationId: ID(5),
        reason: 'build_doc',
      }),
    ).toBe(true);
    expect(
      ok('RunPlanMarkedStale', { planId: ID(9), projectId: ID(3), workstationId: ID(5), reason: 'whatever' }),
    ).toBe(false);
    expect(ok('RunEnvironmentRestarted', { envId: ID(2), by: ID(6), update: true })).toBe(true);
    expect(
      ok('RunPlanSaved', {
        planId: ID(9),
        projectId: ID(3),
        workstationId: ID(5),
        version: 2,
        plan: { services: [svc('web')] },
        fingerprint: 'f',
        requestId: null,
        buildHash: 'b',
        settingsHash: 's',
      }),
    ).toBe(true);
  });

  it('puts the failed replay and the sandbox in the DevOps brief', () => {
    const run = DevopsRunSchema.parse({
      envId: ID(2),
      purpose: 'manual',
      projectKey: 'TOY',
      projectName: 'Toy',
      sources: [{ repoId: ID(1), name: 'toy', branch: 'main' }],
      portRange: { from: 20000, to: 29999 },
      replayFailure: 'step "build" failed (exit 3)\n\nLast output:\nBOOM',
    });
    const text = renderRunSection(run);
    expect(text).toContain('The saved plan was replayed first and failed');
    expect(text).toContain('BOOM');
    expect(text).toMatch(/Sandbox: steps and services run in the runner/);
  });

  it('knows run.status, run.log and run.plan.saved from the runner, and hello capabilities', () => {
    const status = makeEnvelope('run.status', {
      envId: ID(2),
      state: 'healthy',
      services: [
        {
          name: 'web',
          state: 'healthy',
          ports: [{ name: 'http', port: 5173, url: 'http://localhost:5173/' }],
          urls: [],
          health: 'passing',
          restarts: 0,
        },
      ],
    });
    expect(RunnerToServerSchema.safeParse(status).success).toBe(true);
    expect(
      RunnerToServerSchema.safeParse(
        makeEnvelope('run.status', { envId: ID(2), state: 'weird', services: [] }),
      ).success,
    ).toBe(false);
    expect(
      RunnerToServerSchema.safeParse(makeEnvelope('run.log', { envId: ID(2), service: 'web', lines: ['a'] }))
        .success,
    ).toBe(true);
    const saved = makeEnvelope('run.plan.saved', {
      envId: ID(2),
      plan: RunPlanSchema.parse({ services: [svc('web')] }),
      buildHash: 'h',
    });
    expect(RunnerToServerSchema.safeParse(saved).success).toBe(true);
    const hello = makeEnvelope('hello', {
      runnerVersion: '1',
      protocol: 1,
      platform: 'linux',
      hostname: 'h',
      runtimes: [],
      repos: [],
      activeShifts: [],
      outboxPending: 0,
      capabilities: ['runs:1'],
      maxRunEnvironments: 2,
    });
    expect(RunnerToServerSchema.parse(hello)).toMatchObject({
      capabilities: ['runs:1'],
      maxRunEnvironments: 2,
    });
    // an old runner says nothing: still valid
    const { capabilities: _c, maxRunEnvironments: _m, ...old } = hello as Record<string, unknown>;
    expect(RunnerToServerSchema.safeParse(old).success).toBe(true);
  });

  it('has the events of a run environment', () => {
    const ok = (type: string, payload: unknown) => DomainEventSchema.safeParse({ type, payload }).success;
    expect(
      ok('RunEnvironmentRequested', {
        envId: ID(2),
        projectId: ID(3),
        workstationId: ID(5),
        purpose: 'manual',
        sources: [{ repoId: ID(1), branch: 'main' }],
        services: [],
        requestedBy: ID(6),
        requestId: ID(4),
        expiresAt: null,
      }),
    ).toBe(true);
    expect(ok('RunEnvironmentStopRequested', { envId: ID(2), by: null })).toBe(true);
    expect(ok('RunEnvironmentEnded', { envId: ID(2), reason: 'ttl' })).toBe(true);
    expect(ok('RunEnvironmentEnded', { envId: ID(2), reason: 'whatever' })).toBe(false);
    expect(
      ok('ProjectRunSettingsSet', {
        projectId: ID(3),
        runInstructions: '',
        repoInstructions: [],
        settings: { ttlHours: 8, allowDocker: false, services: [] },
        by: ID(6),
      }),
    ).toBe(true);
  });
});

describe('the DevOps prompt of a run request', () => {
  const run = DevopsRunSchema.parse({
    envId: ID(2),
    purpose: 'manual',
    projectKey: 'TOY',
    projectName: 'Toy',
    sources: [{ repoId: ID(1), name: 'web', branch: 'feature/login', commit: 'abcdef0123456789' }],
    runInstructions: 'Start the API first.',
    repoInstructions: [{ repoId: ID(1), name: 'web', text: 'Use pnpm.' }],
    declared: [
      {
        name: 'web',
        repoId: ID(1),
        cwd: '.',
        cmd: ['pnpm', 'dev'],
        ports: [{ name: 'http', default: 5173, envVar: 'PORT' }],
        after: [],
      },
    ],
    portRange: { from: 20000, to: 29999 },
    ttlAt: '2026-10-14T20:00:00.000Z',
    buildDocs: [{ repoId: ID(1), path: 'BUILD.md', content: 'Run pnpm dev.' }],
  });
  const devops = (over: Partial<DevopsShift> = {}): DevopsShift => ({
    requestId: ID(4),
    threadId: ID(4),
    summary: 'Run web@feature/login of Toy',
    requestedBy: { kind: 'user', id: ID(6), name: 'Pieter' },
    workstationName: 'Desk',
    access: { allowInstall: false, allowDocker: false, allowedPaths: [], sudo: false },
    history: [],
    run,
    ...over,
  });

  it('carries the environment id, BUILD.md, the instructions, the declared services and the steps', () => {
    const text = renderDevopsPrompt(devops());
    expect(text).toContain('Run request: Toy (TOY)');
    expect(text).toContain(`--env ${ID(2)}`);
    expect(text).toContain('web (repo id');
    expect(text).toContain('branch feature/login at abcdef0123');
    expect(text).toContain('Start the API first.');
    expect(text).toContain('Use pnpm.');
    expect(text).toContain('### BUILD.md of web (BUILD.md)');
    expect(text).toContain('Run pnpm dev.');
    expect(text).toContain('do not contradict them');
    expect(text).toContain('20000-29999');
    expect(text).toContain('Docker: NOT allowed');
    expect(text).toContain('aom run ready');
    expect(text).toContain('This is a run request');
    expect(text).not.toContain('hygiene');
  });

  it('lists the guides above the repositories with their absolute paths, tells DevOps to map paths, and how to ask when blocked', () => {
    const text = renderDevopsPrompt(
      devops({
        run: DevopsRunSchema.parse({
          ...run,
          buildGuides: [
            {
              path: '/home/u/src/dcode/sources/BUILD.md',
              content: 'Use the embedded server of the webconsole.',
              origin: 'parent',
              repoIds: [ID(1)],
            },
          ],
          pathMap: [
            {
              repoId: ID(1),
              clonePath: '/home/u/src/dcode/sources/web',
              worktreePath: '/home/u/.aom-runner/worktrees/run-1/web',
            },
          ],
        }),
      }),
    );
    expect(text).toContain(
      'Build guide above the repositories: /home/u/src/dcode/sources/BUILD.md (for web)',
    );
    expect(text).toContain('Use the embedded server of the webconsole.');
    expect(text).toContain('follow them first, and literally');
    expect(text).toContain(
      "Map every path in a guide that points into the owner's checkout to its run worktree equivalent: /home/u/src/dcode/sources/web => /home/u/.aom-runner/worktrees/run-1/web",
    );
    expect(text).toContain('follow the guide and say so in your summary');
    expect(text).toContain('appsettings.{Environment}.json');
    expect(text).toContain('ASPNETCORE_ENVIRONMENT=Development');
    expect(text).toContain('private IP');
    expect(text).toContain('aom devops-approval --action "Question:');
    // the repository's own BUILD.md is still there, and the "no BUILD.md" hint is not
    expect(text).toContain('### BUILD.md of web (BUILD.md)');
    expect(text).not.toContain('no BUILD.md and no run instructions');
    const settings = RunSettingsSchema.parse({ buildGuides: ['/abs/BUILD.md'] });
    expect(validateRunSettings(settings)).toEqual([]);
    expect(validateRunSettings(RunSettingsSchema.parse({ buildGuides: ['relative/BUILD.md'] }))[0]).toMatch(
      /absolute path/,
    );
    expect(RunSettingsSchema.parse({}).buildGuides).toEqual([]);
  });

  it('says what to do without any instructions, and shows the saved plan', () => {
    const bare = renderDevopsPrompt(
      devops({
        run: DevopsRunSchema.parse({
          ...run,
          runInstructions: '',
          repoInstructions: [],
          buildDocs: [],
          declared: [],
          currentPlan: RunPlanSchema.parse({ services: [svc('web')], notes: 'old' }),
          planStatus: 'stale',
        }),
      }),
    );
    expect(bare).toContain('no BUILD.md and no run instructions');
    expect(bare).toContain('plan saved earlier (stale)');
    expect(bare).toContain('"notes": "old"');
  });

  it('a request without a run is unchanged', () => {
    expect(renderDevopsPrompt(devops({ run: undefined }))).not.toContain('Run request');
  });
});
