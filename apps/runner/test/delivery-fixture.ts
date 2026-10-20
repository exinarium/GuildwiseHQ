import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DeployExecPayload, DeployExecPayloadSchema } from '@aom/shared';
import { DeployExecutor } from '../src/delivery/exec.ts';
import { runnerPaths } from '../src/paths.ts';
import { VaultManager } from '../src/vaults/manager.ts';
import { sh, tmp } from './helpers.ts';
import { IDENTITY, makeVault } from './vault-fixtures.ts';

/** The P5-shaped recipe of the shared fixtures (docs/design/ceo-front-door.md 9.2): a local Docker target, a log health check. */
export const P5_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'test',
  'fixtures',
  'p5-recipe',
);

export const FOLDER = 'projects/p5';

export interface DeliveryWorld {
  root: string;
  paths: ReturnType<typeof runnerPaths>;
  vaults: VaultManager;
  /** Another workstation's clone: the recipe is committed from here, as the `recipe save` of another machine would. */
  vault: ReturnType<typeof makeVault>;
  sent: Array<{ type: string; payload: unknown }>;
  secrets: Record<string, string>;
  /** Copies the fixture (or a changed one) into `<folder>/delivery/` of the "other" clone, commits and pushes; returns the commit. */
  commitRecipe(edit?: (dir: string) => void): string;
  exec: DeployExecutor;
  payload(over?: Partial<DeployExecPayload>): DeployExecPayload;
}

export async function deliveryWorld(
  opts: { storage?: 'git' | 'local'; fetchImpl?: typeof fetch } = {},
): Promise<DeliveryWorld> {
  const vault = makeVault();
  const root = tmp('aom-delivery-');
  const paths = runnerPaths(join(root, 'data'));
  mkdirSync(paths.vaults, { recursive: true });
  const vaults = new VaultManager({ paths, transport: { send: () => undefined } });
  const storage = opts.storage ?? 'git';
  vaults.configure({
    vaults: [
      {
        vaultId: 'v1',
        kind: 'project',
        name: 'p5',
        remoteUrl: storage === 'git' ? vault.origin : '',
        syncIntervalSec: 3600,
        storage,
      },
    ],
    identity: IDENTITY,
    workstationName: 'Desk',
    resume: [],
  });
  const sent: DeliveryWorld['sent'] = [];
  const secrets: Record<string, string> = {};
  const w: DeliveryWorld = {
    root,
    paths,
    vaults,
    vault,
    sent,
    secrets,
    commitRecipe(edit) {
      const dest = join(vault.other, FOLDER, 'delivery');
      sh(vault.other, 'rm', ['-rf', dest]);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(P5_FIXTURE, dest, { recursive: true });
      edit?.(dest);
      sh(vault.other, 'git', ['add', '-A']);
      sh(vault.other, 'git', ['commit', '-m', 'recipe', '--allow-empty']);
      sh(vault.other, 'git', ['push', 'origin', 'main']);
      return sh(vault.other, 'git', ['rev-parse', 'HEAD']).trim();
    },
    exec: undefined as never,
    payload: () => undefined as never,
  };
  w.exec = new DeployExecutor({
    paths,
    vaults,
    secrets: {
      valuesFor: (_p, wanted) => ({
        values: Object.fromEntries(
          wanted.filter((n) => secrets[n] !== undefined).map((n) => [n, secrets[n] as string]),
        ),
        missing: wanted.filter((n) => secrets[n] === undefined),
      }),
    },
    findRepo: async () => undefined,
    send: (type, payload) => void sent.push({ type, payload }),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    baseEnv: { PATH: process.env.PATH ?? '', HOME: root },
    home: root,
    timing: { healthPollMs: 10, healthTimeoutSec: 1, killGraceMs: 50, graceMs: 0 },
  });
  w.payload = (over = {}) =>
    DeployExecPayloadSchema.parse({
      runId: '019da000-0000-7000-8000-0000000000aa',
      orgId: '019da000-0000-7000-8000-000000000002',
      projectId: '019da000-0000-7000-8000-000000000003',
      projectKey: 'P5',
      vault: { vaultId: 'v1', storage, folder: FOLDER },
      vaultCommit: null,
      hash: 'a'.repeat(64),
      env: 'local',
      target: {
        id: null,
        name: 'p5-local',
        kind: 'local_docker',
        host: null,
        appUrl: 'http://localhost:5500',
      },
      commit: 'abc1234',
      repo: null,
      trial: false,
      dryRun: false,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...over,
    });
  void existsSync;
  void readFileSync;
  void writeFileSync;
  return w;
}
