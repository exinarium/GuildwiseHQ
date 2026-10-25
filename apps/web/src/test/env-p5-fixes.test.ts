import { type ProbeReport, ProbeReportSchema, type SetupEnv } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  firstAnswering,
  guessAppService,
  guessImageName,
  healthCandidates,
  normPath,
  ORIGIN_MISMATCH,
  originMismatchSentence,
  publishedPort,
  runningFileFor,
  serverAppBase,
  stacksFromReport,
} from '../components/environments/answers.ts';

const at = '2026-10-20T10:00:00.000Z';
const RUN = '/home/user/projects/p5-run-trial/deploy/local/docker-compose.yml';
const OTHER = '/home/user/projects/mm-fixes-wt/deploy/local/docker-compose.yml';
const copy = (path: string) => ({
  path,
  project: 'demo-flow-local',
  services: [{ name: 'demo-server', image: '192.168.1.11:5000/demo-server:showcase-cd30f7bb33' }],
  volumes: [],
});
const report = (over: Record<string, unknown> = {}): ProbeReport =>
  ProbeReportSchema.parse({
    scope: 'local',
    at,
    docker: { installed: true, usable: true },
    composeFiles: [copy(OTHER), copy(RUN)],
    containers: [
      {
        name: 'demo-flow-local-demo-server-1',
        project: 'demo-flow-local',
        service: 'demo-server',
        image: '192.168.1.11:5000/demo-server:showcase-cd30f7bb33',
        state: 'running',
        ports: [{ host: 5500, container: 500, bind: '0.0.0.0' }],
        composeFile: RUN,
        workingDir: '/home/user/projects/p5-run-trial/deploy/local',
      },
    ],
    ...over,
  });

describe('case 1: the running copy wins when several checkouts share a compose project', () => {
  it('the stack with running containers takes its file from the container labels; the other copy is "not running"', () => {
    const stacks = stacksFromReport(report());
    expect(stacks.map((s) => s.path)).toEqual([RUN, OTHER]);
    const [running, other] = stacks;
    expect(running?.running).toBe(true);
    expect(running?.workingDir).toBe('/home/user/projects/p5-run-trial/deploy/local');
    expect(running?.containers).toHaveLength(1);
    expect(running?.copyOf).toBeUndefined();
    expect(other?.running).toBe(false);
    expect(other?.containers).toHaveLength(0);
    expect(other?.copyOf).toBe(RUN);
    expect(other?.mustPick).toBeUndefined();
  });

  it('nine copies and one running: the eight others are copies of the running one', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      copy(`/home/user/projects/wt-${i}/deploy/local/docker-compose.yml`),
    );
    const stacks = stacksFromReport(report({ composeFiles: [...many, copy(RUN)] }));
    expect(stacks[0]?.path).toBe(RUN);
    expect(stacks.filter((s) => s.copyOf === RUN)).toHaveLength(8);
  });

  it('a running stack whose file the probe did not list still wins (labels, not the project name)', () => {
    const stacks = stacksFromReport(report({ composeFiles: [copy(OTHER)] }));
    expect(stacks[0]).toMatchObject({ path: RUN, running: true });
    expect(stacks[1]).toMatchObject({ path: OTHER, copyOf: RUN });
  });

  it('several copies and none running: the person must pick, nothing is marked running', () => {
    const stacks = stacksFromReport(report({ containers: [] }));
    expect(stacks.some((s) => s.running)).toBe(false);
    expect(stacks.every((s) => s.mustPick)).toBe(true);
    expect(stacks.every((s) => !s.copyOf)).toBe(true);
  });

  it('a single copy that is not running needs no pick', () => {
    const stacks = stacksFromReport(report({ containers: [], composeFiles: [copy(OTHER)] }));
    expect(stacks[0]?.mustPick).toBeUndefined();
  });

  it('~ and the absolute home folder name the same file', () => {
    expect(normPath('~/src/x.yml', '/home/user')).toBe('/home/user/src/x.yml');
    expect(normPath('/home/user/src/x.yml', '/home/user')).toBe('/home/user/src/x.yml');
    const stacks = stacksFromReport(
      report({ composeFiles: [copy(RUN.replace('/home/user', '~')), copy(OTHER)] }),
    );
    // the container label is absolute, the listed file starts with ~: it is still the running one
    expect(stacks.filter((s) => s.running)).toHaveLength(1);
    expect(stacks.find((s) => s.running)?.containers).toHaveLength(1);
  });

  it('runningFileFor names the file the app runs from when the setup points at another copy', () => {
    const env = {
      app: { composeFile: OTHER, service: 'demo-server', composeProject: 'demo-flow-local' },
    } as unknown as SetupEnv;
    expect(runningFileFor(env, report())).toBe(RUN);
    const same = {
      app: { ...env.app, composeFile: RUN.replace('/home/user', '~') },
    } as unknown as SetupEnv;
    expect(runningFileFor(same, report())).toBeNull();
    expect(runningFileFor(env, null)).toBeNull();
  });
});

describe('case 2: the mismatch failure is translated', () => {
  it('recognises the script message, with shortened or full paths', () => {
    expect(
      ORIGIN_MISMATCH.test(
        'the app was started from …/p5-run-trial/deploy/local/docker-compose.yml, not from …/mm-fixes-wt/deploy/local/docker-compose.yml. Guildwise only',
      ),
    ).toBe(true);
    expect(ORIGIN_MISMATCH.test('the health check failed')).toBe(false);
  });
  it('the plain sentence names both files when the probe knows the running one', () => {
    const env = { app: { composeFile: OTHER } } as unknown as SetupEnv;
    const t = originMismatchSentence(env, RUN);
    expect(t).toContain(RUN);
    expect(t).toContain(OTHER);
    expect(t).toContain('Nothing was changed');
    expect(originMismatchSentence(env, null)).toContain(OTHER);
  });
});

describe('case 3: the image name keeps the registry port out of the name', () => {
  it('192.168.1.11:5000/demo-server:showcase-cd30f7bb33 is demo-server, never 192.168.1.11', () => {
    const stack = stacksFromReport(report())[0];
    if (!stack) throw new Error('no stack');
    expect(guessAppService(stack)).toBe('demo-server');
    expect(guessImageName(stack, 'demo-server')).toBe('demo-server');
    expect(guessImageName(stack, 'demo-server', 'localhost:5000/x:1')).toBe('x');
    expect(guessImageName(stack, 'demo-server', 'ghcr.io/acme/api@sha256:abcdef')).toBe('acme/api');
    expect(guessImageName(stack, 'demo-server', 'guildwise-hq:4f2c1ab')).toBe('guildwise-hq');
  });
});

describe('case 4: the health address of a server comes from its address, the published port and the usual paths', () => {
  it('reads the published port of the running app part (0.0.0.0:5500->500)', () => {
    const stack = stacksFromReport(report())[0];
    expect(publishedPort(stack, 'demo-server')).toBe(5500);
    expect(publishedPort(stack, 'other')).toBeNull();
  });
  it('a port bound to loopback only is not reachable from outside', () => {
    const r = report({
      containers: [
        {
          name: 'a',
          project: 'demo-flow-local',
          service: 'demo-server',
          image: 'x',
          state: 'running',
          ports: [{ host: 5500, container: 500, bind: '127.0.0.1' }],
          composeFile: RUN,
        },
      ],
    });
    expect(publishedPort(stacksFromReport(r)[0], 'demo-server')).toBeNull();
  });
  it('candidates are /ready, /api/health, /health and the root, in that order', () => {
    expect(healthCandidates(serverAppBase('192.168.1.13', 5500))).toEqual([
      'http://192.168.1.13:5500/ready',
      'http://192.168.1.13:5500/api/health',
      'http://192.168.1.13:5500/health',
      'http://192.168.1.13:5500',
    ]);
    expect(serverAppBase(undefined, 5500)).toBe('');
    expect(healthCandidates('')).toEqual([]);
  });
  it('only an address that answered 2xx becomes the default; none answering leaves it empty', () => {
    const cands = healthCandidates('http://192.168.1.13:5500');
    const answered = report({
      urls: [
        { url: cands[0], status: 404 },
        { url: cands[1], status: 200 },
      ],
    });
    expect(firstAnswering(answered, cands)).toBe('http://192.168.1.13:5500/api/health');
    expect(firstAnswering(report({ urls: [{ url: cands[0], status: 404 }] }), cands)).toBe('');
    expect(firstAnswering(null, cands)).toBe('');
  });
});
