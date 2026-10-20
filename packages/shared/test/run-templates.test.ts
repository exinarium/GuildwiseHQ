import { describe, expect, it } from 'vitest';
import {
  buildFromTemplate,
  DOCKER_IMAGE_PRESETS,
  describeService,
  describeStep,
  healthToReady,
  RunPlanSchema,
  readyToHealth,
  templateParams,
  uniqueServiceName,
  validateRunPlanPlain,
  whenFromString,
  whenToString,
} from '../src/index.ts';

const repoId = '11111111-1111-4111-8111-111111111111';

describe('run step templates', () => {
  it('install_packages: a labelled setup step that reruns when the lockfile changes', () => {
    const r = buildFromTemplate({
      template: 'install_packages',
      params: { repoId, folder: 'web/', manager: 'npm' },
    });
    expect(r.kind).toBe('step');
    expect(r.item).toMatchObject({
      name: 'Install packages',
      label: 'Install packages (web)',
      template: 'install_packages',
      cwd: 'web',
      cmd: ['npm', 'ci'],
      when: 'changed:web/package-lock.json',
    });
  });

  it('the top folder means ".": no prefix on the lockfile pattern', () => {
    const r = buildFromTemplate({
      template: 'install_packages',
      params: { repoId, folder: '', manager: 'pnpm' },
    });
    expect(r.item).toMatchObject({
      cwd: '.',
      when: 'changed:pnpm-lock.yaml',
      cmd: ['pnpm', 'install', '--frozen-lockfile'],
    });
  });

  it('build and prepare_db split the command line without a shell', () => {
    const b = buildFromTemplate({
      template: 'build',
      params: { repoId, folder: '.', command: 'npm run build -- --mode "dev server"' },
    });
    expect(b.item).toMatchObject({
      cmd: ['npm', 'run', 'build', '--', '--mode', 'dev server'],
      template: 'build',
    });
    expect(() =>
      buildFromTemplate({ template: 'prepare_db', params: { repoId, folder: '.', command: '   ' } }),
    ).toThrow(/command/);
  });

  it('web_app: port, env var, ready check and after', () => {
    const r = buildFromTemplate({
      template: 'web_app',
      params: {
        name: 'web',
        repoId,
        folder: 'web',
        command: 'npm run dev',
        port: 5173,
        portEnvVar: 'PORT',
        ready: { kind: 'page', path: '/health' },
        after: ['db'],
      },
    });
    expect(r.kind).toBe('service');
    expect(r.item).toMatchObject({
      name: 'web',
      template: 'web_app',
      ports: [{ name: 'http', default: 5173, envVar: 'PORT', url: 'http://localhost:${port}/' }],
      health: { kind: 'http', url: 'http://localhost:${port}/health', expect: '2xx' },
      after: ['db'],
      docker: false,
    });
    expect(() =>
      buildFromTemplate({
        template: 'web_app',
        params: {
          name: 'web',
          repoId,
          folder: '.',
          command: 'x',
          port: 70000,
          ready: { kind: 'port' },
          after: [],
        },
      }),
    ).toThrow(/port/);
  });

  it('docker_service builds a docker run with the preset env and flags docker', () => {
    const pg = DOCKER_IMAGE_PRESETS[0]!;
    const r = buildFromTemplate({
      template: 'docker_service',
      params: {
        name: 'db',
        repoId,
        image: pg.image,
        containerPort: pg.containerPort,
        env: pg.env,
        after: [],
      },
    });
    expect(r.item).toMatchObject({
      docker: true,
      cmd: ['docker', 'run', '--rm', '-p', '${port}:5432', '-e', 'POSTGRES_PASSWORD=postgres', 'postgres:16'],
      health: { kind: 'tcp', port: 'tcp' },
    });
    expect(() =>
      buildFromTemplate({
        template: 'docker_service',
        params: { name: 'db', repoId, image: 'bad image; rm -rf /', containerPort: 1, after: [] },
      }),
    ).toThrow(/image/);
  });

  it('compose_stack uses its own throwaway project name and a plain down', () => {
    const r = buildFromTemplate({
      template: 'compose_stack',
      params: { name: 'stack', repoId, folder: '.', composeFile: 'docker-compose.yml', services: ['db'] },
    });
    expect(r.item).toMatchObject({
      docker: true,
      cmd: ['docker', 'compose', '-p', 'aom-run-stack', '-f', 'docker-compose.yml', 'up', 'db'],
      stopCmd: ['docker', 'compose', '-p', 'aom-run-stack', '-f', 'docker-compose.yml', 'down'],
    });
    expect((r.item as { stopCmd: string[] }).stopCmd).not.toContain('-v');
  });

  it('every built item is a valid plan item', () => {
    const items = [
      buildFromTemplate({ template: 'install_packages', params: { repoId, folder: '.', manager: 'npm' } }),
      buildFromTemplate({
        template: 'web_app',
        params: {
          name: 'web',
          repoId,
          folder: '.',
          command: 'npm start',
          port: 3000,
          ready: { kind: 'wait', seconds: 5 },
          after: [],
        },
      }),
    ];
    const plan = RunPlanSchema.parse({
      repos: [],
      setup: items.filter((i) => i.kind === 'step').map((i) => i.item),
      services: items.filter((i) => i.kind === 'service').map((i) => i.item),
    });
    expect(validateRunPlanPlain(plan)).toEqual([]);
  });
});

describe('reading a plan item back as a template', () => {
  it('round-trips web_app, docker_service, compose_stack, install and build', () => {
    const cases = [
      { template: 'install_packages', params: { repoId, folder: 'web', manager: 'yarn' } },
      { template: 'build', params: { repoId, folder: '.', command: 'make all' } },
      {
        template: 'web_app',
        params: {
          name: 'web',
          repoId,
          folder: 'web',
          command: 'npm run dev',
          port: 5173,
          portEnvVar: 'PORT',
          ready: { kind: 'log', text: 'ready on' },
          after: ['db'],
        },
      },
      {
        template: 'docker_service',
        params: { name: 'cache', repoId, image: 'redis:7', containerPort: 6379, env: {}, after: [] },
      },
      {
        template: 'compose_stack',
        params: { name: 'stack', repoId, folder: '.', composeFile: 'compose.yml', services: ['a', 'b'] },
      },
    ] as const;
    for (const c of cases) {
      const built = buildFromTemplate(c as never);
      const back = templateParams(built.kind, built.item);
      expect(back?.template).toBe(c.template);
      const again = buildFromTemplate(back as never);
      expect(again.item).toEqual(built.item);
    }
  });

  it('an item without a template reads back as a custom command', () => {
    const back = templateParams('step', {
      name: 'seed',
      repoId,
      cwd: 'api',
      cmd: ['node', 'seed.js'],
      timeoutSec: 60,
      when: 'first',
    });
    expect(back).toMatchObject({
      template: 'custom_step',
      params: { folder: 'api', command: 'node seed.js', when: { kind: 'first' } },
    });
  });
});

describe('plain words', () => {
  it('describes a step and a service', () => {
    const step = buildFromTemplate({
      template: 'install_packages',
      params: { repoId, folder: 'web', manager: 'npm' },
    }).item;
    expect(describeStep(step as never)).toBe('Runs npm ci in web. Again when web/package-lock.json changes.');
    const svc = buildFromTemplate({
      template: 'web_app',
      params: {
        name: 'web',
        repoId,
        folder: '.',
        command: 'npm start',
        port: 3000,
        ready: { kind: 'page', path: '/' },
        after: [],
      },
    }).item;
    expect(describeService(svc as never)).toBe('Runs npm start, on port 3000. Ready when the page opens.');
  });

  it('rewrites validation messages and asks for a running part', () => {
    const plan = RunPlanSchema.parse({
      setup: [{ name: 's', repoId, cwd: '../x', cmd: ['a'] }],
      services: [
        { name: 'a', repoId, cmd: ['x'], after: ['ghost'] },
        { name: 'a', repoId, cmd: ['x'] },
      ],
    });
    const msgs = validateRunPlanPlain(plan);
    expect(msgs).toContain('Two parts are both called "a". Give each part its own name.');
    expect(msgs).toContain('"a" is set to start after "ghost", but there is no part with that name.');
    expect(msgs).toContain('The folder of the step "s" must be inside the project.');
    expect(validateRunPlanPlain(RunPlanSchema.parse({}))).toEqual([
      'Add at least one part that keeps running (the website or app).',
    ]);
  });

  it('when and ready conversions are inverse', () => {
    for (const w of ['always', 'first', 'changed:a/b.lock']) expect(whenToString(whenFromString(w))).toBe(w);
    expect(healthToReady(readyToHealth({ kind: 'page', path: '/x' }, true))).toEqual({
      kind: 'page',
      path: '/x',
    });
    expect(healthToReady(readyToHealth({ kind: 'log', text: 'listening on 3000' }, true))).toEqual({
      kind: 'log',
      text: 'listening on 3000',
    });
    // a page check needs a port: without one it falls back to a short wait
    expect(readyToHealth({ kind: 'page', path: '/' }, false)).toMatchObject({ kind: 'none' });
  });

  it('uniqueServiceName', () => {
    expect(uniqueServiceName('Web app', [])).toBe('web-app');
    expect(uniqueServiceName('web', ['web', 'web-2'])).toBe('web-3');
  });
});
