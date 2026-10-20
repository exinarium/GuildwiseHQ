import type { CeoActionName } from '@aom/shared';
import { z } from 'zod';
import { one } from '../db/sql.ts';
import { requestDeployRun } from '../delivery/runs.ts';
import { refuse, truncate } from './actions.ts';
import type { ActionDef } from './types.ts';

/**
 * `aom ceo act deploy --project KEY --env NAME [--commit SHA] [--target NAME]` (docs/design/ceo-front-door.md 9.6 and 14.2).
 * The model's only deploy action: a local call that asks Guildwise. It carries no credential and runs no deploy command; the
 * server checks the approved recipe and the gate, and the RECIPE decides who releases. The CEO releases only when the
 * recipe names it; otherwise the release waits in the queue for the Owner or an Admin. An Owner who accepted a
 * recommendation to deploy is the releaser himself.
 */
const DeployP = z.object({
  project: z.string().min(2).max(10),
  env: z.string().min(1).max(40),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  target: z.string().max(80).optional(),
});

const deploy: ActionDef<z.infer<typeof DeployP>> = {
  cls: 'deploy.run',
  schema: DeployP,
  describe: (p) => `Deploy ${p.project.toUpperCase()} ${p.env}${p.target ? ` to ${p.target}` : ''}`,
  async prepare(env, p) {
    const project = await one(
      env.ctx.pool,
      'SELECT id, key, delivery_mode FROM projects WHERE org_id=$1 AND key=upper($2)',
      [env.orgId, p.project],
    );
    if (!project) return refuse(`project ${p.project.toUpperCase()} not found`);
    return {
      subjectKind: 'project',
      subjectId: project.id as string,
      subjectLabel: truncate(`${project.key} ${p.env}`, 120),
      // The recipe, approved by the Owner's button, is the delegation: no separate owner-reserved key applies.
      data: { project },
    };
  },
  async execute(env, p, pr) {
    const project = pr.data?.project as { id: string };
    const requester = env.acceptedFrom
      ? ({ kind: 'owner', id: env.owner.id, name: env.owner.displayName, provenance: 'session' } as const)
      : ({
          kind: 'ceo',
          id: env.agentId,
          name: env.agentName,
          provenance: env.originKind ?? 'wake',
          untrusted: env.untrusted === true,
          ...(env.turnId ? { turnId: env.turnId } : {}),
          ...(env.batchId ? { wakeBatchId: env.batchId } : {}),
        } as const);
    const r = await requestDeployRun(env.ctx, {
      projectId: project.id,
      env: p.env,
      commit: p.commit,
      targets: p.target ? [p.target] : undefined,
      trigger: 'request',
      requester,
    });
    const refused = r.runs.every((x) => x.status === 'refused');
    return {
      message: r.message,
      result: { runs: r.runs, ...(refused ? { refused: true } : {}) },
    };
  },
};

export const ACTIONS4: Partial<Record<CeoActionName, ActionDef>> = { deploy };
