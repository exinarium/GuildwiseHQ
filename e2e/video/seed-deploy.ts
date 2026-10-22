import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { type APIRequestContext, expect } from '@playwright/test';
import { localAdoptEnv } from '../../packages/shared/src/index.ts';
import { q, waitFor } from '../support/db.ts';
import { BASE_URL, E2E_DIR, paths, ROOT } from '../support/env.ts';
import { makeVault } from '../support/vault.ts';
import { pairWorkstation } from './seed.ts';

/**
 * Seeding for the videos that show where an app runs (Environments, Releases). Nothing here touches the real Docker of
 * the machine: every demo computer is a mock runner with the fake docker of the runner tests
 * (apps/runner/test/fixtures/fake-flow-docker.sh) first on its PATH and a state folder of its own, so the probe, the
 * dry run and a real release all go through the real server and runner code against throwaway files. The "running
 * app" a fake container publishes is a tiny web server on a free port of 127.0.0.1 (stopped by `stopDemoSites`).
 */

const FAKE_DOCKER = join(ROOT, 'apps/runner/test/fixtures/fake-flow-docker.sh');

export interface DemoComputer {
  id: string;
  name: string;
  /** The runner's HOME: demo stacks live under it, so the page shows them as `~/apps/...`. */
  home: string;
  /** The fake docker's state folder (its containers and images). */
  state: string;
}

export const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

/** Pairs a demo computer (mock runner + fake docker) called `name` and waits until it is connected. */
export async function demoComputer(
  api: APIRequestContext,
  name: string,
  key: string,
  o: { noCompose?: boolean } = {},
): Promise<DemoComputer> {
  const dir = join(E2E_DIR, `computer-${key}`);
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  for (const d of [home, bin, join(state, 'c'), join(state, 'images'), join(state, 'www'), join(dir, 'none')])
    mkdirSync(d, { recursive: true });
  copyFileSync(FAKE_DOCKER, join(bin, 'fake-docker'));
  chmodSync(join(bin, 'fake-docker'), 0o755);
  // `noCompose`: a computer with Docker but without Docker Compose (the probe says so, and the setup cannot be saved)
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/bash\n${o.noCompose ? `[ "$1" = compose ] && { echo "docker: 'compose' is not a docker command." >&2; exit 1; }\n` : ''}exec "${join(bin, 'fake-docker')}" "$@"\n`,
  );
  // the old docker-compose program of the machine is never reached: it is the fake one here, or missing
  writeFileSync(
    join(bin, 'docker-compose'),
    o.noCompose
      ? '#!/bin/sh\necho "docker-compose: command not found" >&2\nexit 127\n'
      : `#!/bin/sh\nexec "${join(bin, 'fake-docker')}" compose "$@"\n`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'docker-compose'), 0o755);
  // the runner's git needs a name for the commits it writes into the project files
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Alex Morgan\n\temail = alex@demo.local\n');
  const id = await pairWorkstation(api, name, paths.runnerHome(key), {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    FAKE_STATE: state,
    AOM_PROBE_APP_ROOTS: join(dir, 'none'),
  });
  return { id, name, home, state };
}

export interface DemoStack {
  /** The compose file as the setup names it (`~/apps/<folder>/docker-compose.yml`). */
  composeFile: string;
  project: string;
  service: string;
  image: string;
  port: number;
}

/**
 * A compose stack that is "already running" on a demo computer: a compose file under ~/apps/<folder>, the app
 * container (built from the folder) and a database next to it, as `docker compose up` would have left them.
 */
export async function runningStack(
  c: DemoComputer,
  s: { folder: string; project: string; service?: string; withDb?: boolean },
): Promise<DemoStack> {
  const service = s.service ?? 'web';
  const port = await freePort();
  const dir = join(c.home, 'apps', s.folder);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'docker-compose.yml');
  const image = `${s.project}-${service}:current`;
  writeFileSync(
    file,
    `services:\n  ${service}:\n    build: ${dir}\n    image: ${image}\n    ports:\n      - "127.0.0.1:${port}:8080"\n${
      s.withDb === false ? '' : '  db:\n    image: postgres:18\n'
    }`,
  );
  const id = () => Math.random().toString(16).slice(2, 14);
  writeFileSync(join(c.state, 'c', service), `${id()}\n${image}\n${s.project}\n${file}\n${port}\n`);
  if (s.withDb !== false)
    writeFileSync(join(c.state, 'c', 'db'), `${id()}\npostgres:18\n${s.project}\n${file}\n\n`);
  writeFileSync(join(c.state, 'images', image.replace(/[/:@]/g, '_')), image);
  return { composeFile: `~/apps/${s.folder}/docker-compose.yml`, project: s.project, service, image, port };
}

/** The guided environment of a running stack ("use the stack that is already there"). */
export function stackEnv(
  stack: DemoStack,
  e: {
    name: string;
    label: string;
    target: string;
    role: 'test' | 'live' | 'other';
    testEnv?: string | null;
  },
) {
  const live = e.role === 'live';
  return {
    ...localAdoptEnv(
      {
        name: e.name,
        label: e.label,
        target: e.target,
        composeFile: stack.composeFile,
        composeProject: stack.project,
        service: stack.service,
        imageName: stack.image.split(':')[0] as string,
        appUrl: `http://127.0.0.1:${stack.port}`,
        healthUrl: `http://127.0.0.1:${stack.port}/ready`,
        testCopy: !live,
      },
      live ? (e.testEnv ?? null) : null,
    ),
    role: e.role,
  };
}

const json = async (res: Awaited<ReturnType<APIRequestContext['get']>>) => {
  const text = await res.text();
  expect(res.ok(), text).toBeTruthy();
  return text ? JSON.parse(text) : {};
};

/** A place of the project on a demo computer (`production` for a live site). */
export async function computerPlace(
  api: APIRequestContext,
  projectId: string,
  c: DemoComputer,
  o: { appUrl?: string; production?: boolean } = {},
): Promise<string> {
  const r = await json(
    await api.post(`/api/projects/${projectId}/deploy-targets`, {
      data: {
        name: c.name,
        kind: 'local_docker',
        workstationId: c.id,
        notes: '',
        reuseExisting: true,
        ...(o.appUrl ? { appUrl: o.appUrl } : {}),
        ...(o.production ? { production: true } : {}),
      },
    }),
  );
  return r.id as string;
}

/**
 * Gives the project a git vault (a throwaway bare repository), so every demo computer reads the same deploy files: a
 * project's automatic vault is a folder on one computer, and a computer that cannot read it cannot release.
 */
export async function gitProjectVault(
  api: APIRequestContext,
  projectId: string,
  key: string,
  computers: DemoComputer[],
): Promise<void> {
  const v = makeVault(`project-${key}`, { 'README.md': '# Project notes\n' });
  const r = await api.post('/api/vaults', {
    data: { kind: 'project', projectId, remoteUrl: v.origin, syncIntervalSec: 2 },
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
  await waitFor(
    'the computers cloned the project vault',
    () =>
      q<{ workstation_id: string }>(
        `SELECT wv.workstation_id FROM workstation_vaults wv JOIN vaults v ON v.id = wv.vault_id
          WHERE v.project_id=$1 AND v.storage='git' AND wv.local_path IS NOT NULL`,
        [projectId],
      ),
    (rs) => computers.every((c) => rs.some((x) => x.workstation_id === c.id)),
    60_000,
  );
}

export const setupState = async (api: APIRequestContext, projectId: string) =>
  json(await api.get(`/api/projects/${projectId}/delivery/setup`));

/** Saves the setup the way the page does (draft, preview, publish) and waits until the computer wrote the files. */
export async function saveSetup(api: APIRequestContext, projectId: string, setup: unknown): Promise<void> {
  const base = `/api/projects/${projectId}`;
  await json(await api.put(`${base}/delivery/setup`, { data: { setup } }));
  const prev = await json(await api.post(`${base}/delivery/setup/preview`, { data: { setup } }));
  expect(prev.ok, JSON.stringify(prev.issues)).toBe(true);
  const pub = await api.post(`${base}/delivery/setup/publish`, { data: { setup, setupHash: prev.hash } });
  expect(pub.status(), await pub.text()).toBe(202);
  await waitFor(
    'the computer wrote the files',
    async () => (await setupState(api, projectId)).publish?.status,
    (s) => s === 'written' || s === 'failed',
    90_000,
  );
  const st = await setupState(api, projectId);
  expect(st.publish.status, st.publish.error).toBe('written');
}

/** "Try it without changing anything" for every saved environment, then the Owner approves and turns Releases on. */
export async function tryApproveAndTurnOn(api: APIRequestContext, projectId: string): Promise<void> {
  const base = `/api/projects/${projectId}`;
  const st = await setupState(api, projectId);
  for (const env of st.current.dryRunMissing ?? [])
    await json(await api.post(`${base}/delivery/setup/dry-run`, { data: { env } }));
  await waitFor(
    'the dry runs',
    async () => (await setupState(api, projectId)).current.dryRunMissing,
    (m) => Array.isArray(m) && m.length === 0,
    240_000,
  );
  const hash = (await setupState(api, projectId)).current.observedHash;
  await json(await api.post(`${base}/delivery/approve`, { data: { hash } }));
  await json(await api.put(`${base}/delivery/mode`, { data: { mode: 'recipe' } }));
}

/** A release by the Owner (a real run on the demo computer); waits until it finished and expects it to succeed. */
export async function release(api: APIRequestContext, projectId: string, env: string, commit: string) {
  const res = await json(
    await api.post(`/api/projects/${projectId}/delivery/deploy`, { data: { env, commit } }),
  );
  const run = res.runs[0];
  expect(run.status, JSON.stringify(res)).not.toBe('refused');
  await waitFor(
    `the release of ${env}`,
    async () => {
      const s = await json(await api.get(`/api/projects/${projectId}/environments/status`));
      return s.environments.find((e: { env: string }) => e.env === env);
    },
    (e) => e?.current?.commit === commit && e.state !== 'updating',
    180_000,
  );
}

/** A new commit on the toy repository (pushed to its origin); returns its sha. */
export function demoCommit(message: string): string {
  const g = (...a: string[]) =>
    execFileSync(
      'git',
      ['-C', paths.toyClone, '-c', 'user.name=Alex Morgan', '-c', 'user.email=alex@demo.local', ...a],
      { encoding: 'utf8' },
    ).trim();
  writeFileSync(join(paths.toyClone, 'index.js'), `console.log(${JSON.stringify(message)});\n`);
  g('add', '-A');
  g('commit', '-m', message);
  g('push', 'origin', 'main');
  return g('rev-parse', 'HEAD');
}

export const headCommit = (): string =>
  execFileSync('git', ['-C', paths.toyClone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

/** Moves the server's test clock forward (the live site's rule waits for the test site to be healthy for 10 minutes). */
export async function advanceClock(ms: number): Promise<void> {
  const r = await fetch(`${BASE_URL}/api/test/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify({ advanceMs: ms }),
  });
  expect(r.ok, `test clock: ${r.status}`).toBe(true);
}

/** Stops the little web servers the fake docker started for the demo sites. */
export function stopDemoSites(computers: DemoComputer[]): void {
  for (const c of computers) {
    if (!existsSync(c.state)) continue;
    for (const f of readdirSync(c.state).filter((x) => /^www\.\d+\.pid$/.test(x))) {
      try {
        process.kill(Number(readFileSync(join(c.state, f), 'utf8').trim()), 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
}
