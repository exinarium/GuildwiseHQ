import { randomUUID } from 'node:crypto';
import { BUILTIN_ROLES, streamId } from '@aom/shared';
import { hashPassword } from '../../src/auth/password.ts';
import type { TestApp } from './app.ts';
import { PASSWORD } from './app.ts';
import { q } from './db.ts';

/**
 * Puts the database in the shape the live database has before `orgs-2026-10` ran: events written by the old
 * code (every `org_id` is a user id, no organization rows), and the org foreign keys of migration 1311 present
 * but unvalidated. Returns the ids so a test can assert on them.
 */
export interface LegacyWorld {
  admin: { id: string; email: string };
  member: { id: string; email: string };
  /** A user that never owned anything: gets an empty organization (owner decision 14). */
  lonely: { id: string; email: string };
  projectId: string;
  repoId: string;
  workstationId: string;
  devopsAgentId: string;
  builderAgentId: string;
  vaultId: string;
  pendingInvitationId: string;
}

const SYSTEM = { kind: 'system', id: null } as const;

export async function dropOrgForeignKeys(): Promise<Array<{ table: string; name: string }>> {
  const cons = await q<{ tbl: string; name: string }>(
    `SELECT con.conrelid::regclass::text AS tbl, con.conname AS name FROM pg_constraint con
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE con.contype = 'f' AND con.confrelid = 'organizations'::regclass AND att.attname = 'org_id'`,
  );
  for (const c of cons) await q(`ALTER TABLE ${c.tbl} DROP CONSTRAINT "${c.name}"`);
  return cons.map((c) => ({ table: c.tbl, name: c.name }));
}

export async function restoreOrgForeignKeys(cons: Array<{ table: string; name: string }>): Promise<void> {
  for (const c of cons)
    await q(
      `ALTER TABLE ${c.table} ADD CONSTRAINT "${c.name}" FOREIGN KEY (org_id) REFERENCES organizations(id)
         DEFERRABLE INITIALLY DEFERRED NOT VALID`,
    );
}

export async function buildLegacyWorld(t: TestApp): Promise<LegacyWorld> {
  const cons = await dropOrgForeignKeys();
  const hash = await hashPassword(PASSWORD);
  const store = t.app.ctx.store;
  const id = () => randomUUID();
  const admin = { id: id(), email: 'ada@legacy.test' };
  const member = { id: id(), email: 'sam@legacy.test' };
  const lonely = { id: id(), email: 'lone@legacy.test' };
  const projectId = id();
  const repoId = id();
  const workstationId = id();
  const devopsAgentId = id();
  const builderAgentId = id();
  const vaultId = id();
  const pendingInvitationId = id();
  const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
  if (!builder) throw new Error('builder role missing');
  const permissions = builder.permissions;
  const ev = (stream: string, event: any, scope: any, actor: any = SYSTEM) => ({
    streamId: stream,
    event,
    actor,
    scope,
  });
  const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;
  const orgScope = { orgId: admin.id, projectId: null, audience: 'org' } as const;
  const projScope = { orgId: admin.id, projectId, audience: 'project' } as const;
  const invId = id();
  await store.append([
    ev(
      streamId.user(admin.id),
      {
        type: 'UserBootstrapped',
        payload: {
          userId: admin.id,
          email: admin.email,
          displayName: 'Ada Legacy',
          passwordHash: hash,
          role: 'admin',
        },
      },
      adminScope,
    ),
    ev(
      streamId.invitation(invId),
      {
        type: 'UserInvited',
        payload: {
          invitationId: invId,
          email: member.email,
          role: 'member',
          tokenHash: `legacy-token-${invId}`,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          invitedBy: admin.id,
        },
      },
      adminScope,
    ),
    ev(
      streamId.user(member.id),
      {
        type: 'InvitationAccepted',
        payload: {
          invitationId: invId,
          userId: member.id,
          email: member.email,
          displayName: 'Sam Legacy',
          passwordHash: hash,
          role: 'member',
        },
      },
      adminScope,
    ),
    ev(
      streamId.user(lonely.id),
      {
        type: 'UserBootstrapped',
        payload: {
          userId: lonely.id,
          email: lonely.email,
          displayName: 'Lone Legacy',
          passwordHash: hash,
          role: 'admin',
        },
      },
      adminScope,
    ),
    ev(
      streamId.invitation(pendingInvitationId),
      {
        type: 'UserInvited',
        payload: {
          invitationId: pendingInvitationId,
          email: 'pending@legacy.test',
          role: 'member',
          tokenHash: `legacy-token-${pendingInvitationId}`,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          invitedBy: admin.id,
        },
      },
      adminScope,
    ),
    ev(
      streamId.workstation(workstationId),
      {
        type: 'WorkstationPaired',
        payload: {
          workstationId,
          userId: admin.id,
          name: 'Desk',
          platform: 'linux',
          hostname: 'desk',
          runnerVersion: '0.0.0',
          tokenHash: `ws-token-${workstationId}`,
        },
      },
      { orgId: admin.id, projectId: null, audience: 'org' },
    ),
    ev(
      streamId.project(projectId),
      {
        type: 'ProjectCreated',
        payload: {
          projectId,
          orgId: admin.id,
          key: 'TEST01',
          name: 'Test project',
          domain: 'work',
          workflowKey: 'code',
          priorityTier: 2,
          branchPrefix: 'aom/',
          workingBranch: 'main',
          subCategories: [],
          vaultFolder: null,
        },
      },
      projScope,
      { kind: 'user', id: admin.id },
    ),
    ev(
      streamId.project(projectId),
      {
        type: 'ProjectRepoAdded',
        payload: {
          projectId,
          repoId,
          name: 'notes-app',
          remoteUrl: 'https://github.com/acme/notes-app.git',
          remoteUrlNormalized: 'github.com/acme/notes-app',
        },
      },
      projScope,
      { kind: 'user', id: admin.id },
    ),
    ev(
      streamId.agent(devopsAgentId),
      {
        type: 'AgentHired',
        payload: {
          agentId: devopsAgentId,
          orgId: admin.id,
          hiredByUserId: admin.id,
          workstationId,
          name: 'Dev',
          roleKey: 'devops',
          roleVersion: 1,
          seniority: 'senior',
          runtime: 'mock',
          model: 'mock',
          skills: [],
          permissions,
          capacity: 1,
          isDevops: true,
        },
      },
      orgScope,
    ),
    ev(
      streamId.agent(builderAgentId),
      {
        type: 'AgentHired',
        payload: {
          agentId: builderAgentId,
          orgId: admin.id,
          hiredByUserId: admin.id,
          workstationId,
          name: 'Una',
          roleKey: 'builder',
          roleVersion: 1,
          seniority: 'junior',
          runtime: 'mock',
          model: 'mock',
          skills: [],
          permissions,
          capacity: 1,
          isDevops: false,
        },
      },
      orgScope,
      { kind: 'user', id: admin.id },
    ),
    ev(
      streamId.vault(vaultId),
      {
        type: 'VaultRegistered',
        payload: {
          vaultId,
          orgId: admin.id,
          kind: 'work',
          name: 'Work vault',
          remoteUrl: 'https://github.com/acme/vault.git',
          syncIntervalSec: 600,
        },
      },
      orgScope,
      { kind: 'user', id: admin.id },
    ),
    ev(
      streamId.project(projectId),
      { type: 'ProjectShared', payload: { projectId, userId: member.id, invitedBy: admin.id } },
      projScope,
      { kind: 'user', id: admin.id },
    ),
    ev(
      streamId.project(projectId),
      { type: 'ProjectShareAccepted', payload: { projectId, userId: member.id } },
      projScope,
      { kind: 'user', id: member.id },
    ),
    ev(
      streamId.ledger(id()),
      {
        type: 'LedgerEntryAdded',
        payload: {
          entryId: id(),
          scope: 'standing_order',
          title: 'Use pnpm',
          body: 'This organization builds with pnpm.',
          tags: [],
        },
      },
      orgScope,
      { kind: 'user', id: admin.id },
    ),
  ]);
  await restoreOrgForeignKeys(cons);
  await q('DELETE FROM data_migrations');
  return {
    admin,
    member,
    lonely,
    projectId,
    repoId,
    workstationId,
    devopsAgentId,
    builderAgentId,
    vaultId,
    pendingInvitationId,
  };
}
