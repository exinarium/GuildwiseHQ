import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customWorkstation, deployWorkstations } from '../src/commands/phase-followups.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember, type Member } from './helpers/members.ts';
import { createWorld, type World } from './helpers/world.ts';

/**
 * O8 (release-readiness audit): "deploy to the local stack" goes to the organization owner's workstation first, and a
 * custom follow-up falls back to the owner's workstation. An organization's id is not its owner's user id (organizations
 * created since the 2026-10 split), so both queries must compare with the owner's user id, not the organization id.
 */
let w: World;
let member: Member;
let orgId: string;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  member = await addMember(w, 'o8');
  // an organization whose id is not its owner's id
  orgId = await w.t.createOrg(w.owner.id, 'O8 org');
  // the owner's workstation was paired after the member's
  await q(`UPDATE workstations SET paired_at = now() - interval '1 day' WHERE id=$1`, [member.workstationId]);
  await q(`UPDATE workstations SET paired_at = now() WHERE id=$1`, [w.workstationId]);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('O8: the owner of the organization comes first', () => {
  it("deployWorkstations puts the owner's own workstation first, even when it was paired later", async () => {
    expect(orgId).not.toBe(w.owner.id);
    const list = await deployWorkstations(
      w.t.app.ctx.pool,
      { id: w.projectId, org_id: orgId },
      { kind: 'local_docker', workstation_id: null },
      new Date(),
    );
    expect(list.map((x) => x.id)).toEqual([w.workstationId, member.workstationId]);
  });

  it("customWorkstation finds the owner's workstation for an organization whose id is not the owner's id", async () => {
    const ws = await customWorkstation(
      w.t.app.ctx.pool,
      { id: w.projectId, org_id: orgId },
      { id: randomUUID() },
    );
    expect(ws?.id).toBe(w.workstationId);
  });
});
