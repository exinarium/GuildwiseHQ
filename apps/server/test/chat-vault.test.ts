import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vaultForConversation } from '../src/commands/vaults.ts';
import { shiftVault } from '../src/runner-gateway/brief.ts';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember, type Member } from './helpers/members.ts';
import { createWorld, ok, pairWorkstation, type World } from './helpers/world.ts';

/**
 * Agents read the knowledge vault (read-only) in chats and in question / BA task shifts: the project's vault, else the
 * organization vault (only on the workstations of its Owner and Admins); never another organization's.
 */
let w: World;
let orgVaultId: string;
let orgId: string;
let member: Member;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id;
  orgVaultId = (
    await ok<any>(
      w.t.req('POST', '/api/vaults', {
        cookie: w.owner.cookie,
        body: { kind: 'org', remoteUrl: 'git@example.test:me/work.git' },
      }),
      201,
    )
  ).id;
  member = await addMember(w, 'vault-member');
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const db = () => w.t.app.ctx.pool;

describe('vaultForConversation', () => {
  it('a project without its own vault reads the organization vault on a manager workstation, in the project folder', async () => {
    const v = await vaultForConversation(db(), {
      orgId,
      projectId: w.projectId,
      workstationId: w.workstationId,
    });
    expect(v).toMatchObject({ vaultId: orgVaultId, kind: 'org' });
    expect(v?.folder).toMatch(/^projects\//);
  });

  it('a chat with no project reads the whole organization vault (no folder) on a manager workstation', async () => {
    const v = await vaultForConversation(db(), { orgId, workstationId: w.workstationId });
    expect(v).toEqual({ vaultId: orgVaultId, kind: 'org' });
  });

  it('a non-manager workstation gets no organization vault, with or without a project', async () => {
    expect(
      await vaultForConversation(db(), {
        orgId,
        projectId: w.projectId,
        workstationId: member.workstationId,
      }),
    ).toBeNull();
    expect(await vaultForConversation(db(), { orgId, workstationId: member.workstationId })).toBeNull();
  });

  it('never crosses organizations', async () => {
    const stranger = await w.t.userSession(uniqueEmail('vault-stranger'));
    const ws = await pairWorkstation(w.t, stranger, 'stranger-box');
    const [strangerOrg] = await q('SELECT org_id FROM org_members WHERE user_id=$1 LIMIT 1', [stranger.id]);
    expect(strangerOrg?.org_id).not.toBe(orgId);
    // the stranger's workstation, this organization's project or organization vault
    expect(
      await vaultForConversation(db(), { orgId, projectId: w.projectId, workstationId: ws.workstationId }),
    ).toBeNull();
    expect(await vaultForConversation(db(), { orgId, workstationId: ws.workstationId })).toBeNull();
    // the organization's workstation, the other organization's scope
    expect(
      await vaultForConversation(db(), {
        orgId: strangerOrg?.org_id,
        projectId: w.projectId,
        workstationId: w.workstationId,
      }),
    ).toBeNull();
    expect(
      await vaultForConversation(db(), { orgId: strangerOrg?.org_id, workstationId: w.workstationId }),
    ).toBeNull();
  });

  it('question and BA task shifts: the organization vault only on a manager workstation', async () => {
    expect(await shiftVault(w.t.app.ctx, { workstation_id: w.workstationId }, w.projectId)).toMatchObject({
      vaultId: orgVaultId,
    });
    expect(await shiftVault(w.t.app.ctx, { workstation_id: member.workstationId }, w.projectId)).toBeNull();
    expect(await shiftVault(w.t.app.ctx, {}, w.projectId)).toBeNull();
  });

  it('the project vault wins, for everyone on the project including a member workstation', async () => {
    const pv = await ok<any>(
      w.t.req('POST', '/api/vaults', {
        cookie: w.owner.cookie,
        body: { kind: 'project', projectId: w.projectId, remoteUrl: 'git@example.test:me/toy.git' },
      }),
      201,
    );
    for (const workstationId of [w.workstationId, member.workstationId]) {
      const v = await vaultForConversation(db(), { orgId, projectId: w.projectId, workstationId });
      expect(v).toMatchObject({ vaultId: pv.id, kind: 'project' });
    }
    const s = await shiftVault(w.t.app.ctx, { workstation_id: member.workstationId }, w.projectId);
    expect(s).toMatchObject({ vaultId: pv.id, kind: 'project' });
    await q('DELETE FROM vaults WHERE id=$1', [pv.id]);
  });
});

describe('chat.start', () => {
  it('carries the vault of a project chat and of a chat with no project', async () => {
    const r = await w.connectRunner();
    const agent = await w.hire('Reader', 'builder', 'junior');
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    const open = async (extra: Record<string, unknown>) =>
      (
        await ok<any>(
          w.t.req('POST', '/api/chats', { cookie: w.owner.cookie, body: { agentId: agent.id, ...extra } }),
          201,
        )
      ).chat;
    const projectChat = await open({ projectId: w.projectId });
    b.send({ type: 'chat.send', threadId: projectChat.threadId, body: 'project', clientMsgId: 'v1' });
    const p = await r.waitFor('chat.start', (f) => f.message === 'project');
    expect(p.context.vault).toMatchObject({ vaultId: orgVaultId, kind: 'org' });
    expect(p.context.vault?.folder).toMatch(/^projects\//);
    r.send('chat.done', {
      chatId: p.chatId,
      threadId: p.threadId,
      messageText: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await b.until(() => b.of('chat.done').length === 1);
    const plain = await open({});
    b.send({ type: 'chat.send', threadId: plain.threadId, body: 'plain', clientMsgId: 'v2' });
    const g = await r.waitFor('chat.start', (f) => f.message === 'plain');
    expect(g.context.vault).toEqual({ vaultId: orgVaultId, kind: 'org' });
    b.close();
    r.close();
  });
});
