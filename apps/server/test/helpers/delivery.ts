import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type BundleEntry,
  bundleHash,
  parseRecipe,
  type Recipe,
  type RecipeInspectResult,
  streamId,
} from '@aom/shared';
import { observeRecipe } from '../../src/delivery/recipes.ts';
import { uniqueEmail } from './app.ts';
import { appoint } from './ceo.ts';
import { q } from './db.ts';
import { createWorld, ok, type Session, type World } from './world.ts';

/** The P5-shaped recipe of the shared fixtures: a local Docker environment and a gated production one. */
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'test',
  'fixtures',
  'p5-recipe',
);
export const P5_RECIPE_YAML = readFileSync(join(FIXTURE, 'recipe.yaml'), 'utf8');

export const parseFixture = (yaml: string = P5_RECIPE_YAML): Recipe => {
  const r = parseRecipe(yaml);
  if (!r.ok) throw new Error(r.error);
  return r.recipe;
};

export interface DeliveryWorld {
  w: World;
  orgId: string;
  vaultId: string;
  folder: string;
  /** The runner pretends it inspected `delivery/` and found this recipe (a local vault: no commit). */
  observe(
    recipe?: Recipe,
    over?: { salt?: string; lint?: unknown[]; commit?: string | null; present?: boolean },
  ): Promise<{ hash: string }>;
  approve(hash: string, cookie?: string): Promise<any>;
  admin(): Promise<Session>;
  member(): Promise<Session>;
  targets: { local: string; prod: string };
}

const owner = (w: World, method: string, url: string, body?: unknown, cookie = w.owner.cookie) =>
  w.t.req(method, url, { cookie, ...(body === undefined ? {} : { body }) });

/**
 * A world with a CEO, a project vault (a local folder on the world's workstation), two deploy targets (`p5-local`, and
 * `p5-prod`, a production remote host) and helpers to put a recipe in front of the Owner.
 */
export async function deliveryWorld(
  over: { env?: Record<string, string>; vault?: 'git' | 'local' | 'none' } = {},
): Promise<DeliveryWorld> {
  const w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', ...over.env } });
  await appoint(w);
  const orgId = (await q(`SELECT id FROM organizations WHERE owner_user_id=$1 LIMIT 1`, [w.owner.id]))[0]!
    .id as string;
  const vaultId = randomUUID();
  const folder = 'projects/toy';
  if (over.vault !== 'none') {
    await w.t.app.ctx.store.append([
      {
        streamId: streamId.vault(vaultId),
        event: {
          type: 'VaultRegistered',
          payload: {
            vaultId,
            orgId,
            projectId: w.projectId,
            kind: 'project',
            name: 'Toy vault',
            remoteUrl: over.vault === 'git' ? 'git@github.com:acme/toy-vault.git' : '',
            syncIntervalSec: 300,
            storage: over.vault === 'git' ? 'git' : 'local',
            ...(over.vault === 'git' ? {} : { localWorkstationId: w.workstationId }),
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId, projectId: w.projectId, audience: 'project' },
      } as never,
    ]);
  }
  const local = randomUUID();
  const prod = randomUUID();
  await q(
    `INSERT INTO deploy_targets (id, org_id, project_id, name, kind, app_url, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,'p5-local','local_docker','http://localhost:5500',$2,now(),now())`,
    [local, orgId, w.projectId],
  );
  await q(
    `INSERT INTO deploy_targets (id, org_id, project_id, name, kind, workstation_id, host, app_url, production, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,'p5-prod','remote_ssh',$4,'prod','https://p5.example.com',true,$2,now(),now())`,
    [prod, orgId, w.projectId, w.workstationId],
  );
  const d: DeliveryWorld = {
    w,
    orgId,
    vaultId,
    folder,
    targets: { local, prod },
    async observe(recipe = parseFixture(), o = {}) {
      const files: BundleEntry[] = [
        { path: 'recipe.yaml', mode: '644', sha256: 'a'.repeat(63) + (o.salt ?? '0').slice(0, 1) },
        ...[...new Set(recipe.environments.flatMap((e) => [e.script, ...(e.smoke ? [e.smoke] : [])]))].map(
          (p): BundleEntry => ({ path: p, mode: '755', sha256: 'b'.repeat(64) }),
        ),
      ];
      const hash = bundleHash(files);
      const inspected: RecipeInspectResult = {
        ok: true,
        present: o.present ?? true,
        vaultCommit: o.commit === undefined ? null : o.commit,
        hash,
        files: files.map((f) => ({ ...f, secret: null })),
        recipe,
        lint: (o.lint ?? []) as never[],
      };
      await observeRecipe(w.t.app.ctx, w.projectId, inspected, w.workstationId);
      return { hash };
    },
    approve: (hash, cookie) =>
      owner(w, 'POST', `/api/projects/${w.projectId}/delivery/approve`, { hash }, cookie),
    async admin() {
      const a = await w.t.userSession(uniqueEmail('admin'));
      await w.t.addOrgMember(orgId, a.id, 'admin');
      return a;
    },
    async member() {
      const m = await w.t.userSession(uniqueEmail('member'));
      await w.t.addOrgMember(orgId, m.id, 'member');
      return m;
    },
  };
  void ok;
  return d;
}

/** Marks a successful, healthy run of an environment on a commit (what a finished local deploy leaves behind). */
export async function healthyRun(
  dw: DeliveryWorld,
  env: string,
  commit: string,
  minutesAgo: number,
): Promise<string> {
  const id = randomUUID();
  const at = new Date(dw.w.t.clock.now().getTime() - minutesAgo * 60_000);
  await q(
    `INSERT INTO deploy_runs (id, org_id, project_id, recipe_id, env, target_name, hash, commit, trigger, requested_by, status, health,
       released_by_policy, created_at, finished_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'p5-local',$6,$7,'request','{"kind":"trigger","id":null}','succeeded','{"ok":true}','auto',$8,$8,$8)`,
    [id, dw.orgId, dw.w.projectId, randomUUID(), env, 'c'.repeat(64), commit, at],
  );
  return id;
}

/** A passed regression run for the project (a card's test run row). */
export async function passedRegression(dw: DeliveryWorld, minutesAgo = 1): Promise<string> {
  const card = await dw.w.card({ title: `Regression ${randomUUID().slice(0, 4)}` });
  const id = randomUUID();
  await q(
    `INSERT INTO test_runs (id, card_id, kind, result, evidence, event_seq, created_at) VALUES ($1,$2,'regression','passed','{}',1,$3)`,
    [id, card.id, new Date(dw.w.t.clock.now().getTime() - minutesAgo * 60_000)],
  );
  return id;
}

/** Puts the server clock on a Wednesday at `hour`:00 UTC (inside the fixture's release window) and keeps sessions alive. */
export async function setWeekday(dw: DeliveryWorld, hour = 10): Promise<void> {
  const now = new Date();
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
  while (t.getUTCDay() !== 3 || t.getTime() < now.getTime()) t.setUTCDate(t.getUTCDate() + 1);
  dw.w.t.clock.setOffset(t.getTime() - Date.now());
  await q(`UPDATE auth_sessions SET last_seen_at=$1, expires_at='2099-01-01'`, [dw.w.t.clock.now()]);
}

/** Moves the server clock forward and keeps sessions alive. */
export async function advance(dw: DeliveryWorld, ms: number): Promise<void> {
  dw.w.t.clock.advance(ms);
  await q(`UPDATE auth_sessions SET last_seen_at=$1, expires_at='2099-01-01'`, [dw.w.t.clock.now()]);
}
