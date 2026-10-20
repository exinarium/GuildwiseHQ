import { randomUUID } from 'node:crypto';
import { DESK_SUBKIND, McpServerInfoSchema, mcpSignInInstruction, streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { accountUsageNotices, type ClaudeRuntimeReport } from './claude-account-notices.ts';
import { orgScope, SYSTEM_ACTOR } from './common.ts';

/**
 * Notices a workstation raises about itself (a desk alert for its owner, cleared by the system when the problem is
 * gone): the Claude login expired, a granted plugin MCP server needs a sign-in. One open notice per (key, organization);
 * `key` lives in the item's `data`. A notice is raised once (and e-mailed once) and closed when the condition clears.
 */

export interface WsRef {
  id: string;
  userId: string;
}

interface Mail {
  subject: string;
  text: string;
}

export interface Notice {
  key: string;
  subkind: string;
  title: string;
  body: string;
  /** Organizations the notice goes to (those whose agents or projects use the workstation). */
  orgIds: string[];
  /** Mail the workstation's owner when a notice is created. */
  mail?: Mail;
}

/** Organizations that have an active agent on the workstation. */
export async function agentOrgs(tx: Tx, workstationId: string): Promise<string[]> {
  const r = await rows<{ org_id: string }>(
    tx,
    `SELECT DISTINCT org_id FROM agents WHERE workstation_id=$1 AND status='active'`,
    [workstationId],
  );
  return r.map((x) => x.org_id);
}

/** Raises `wanted` notices that are not open yet; closes the open ones of `subkind` + `keyPrefix` not in `wanted`. */
export async function reconcile(
  ctx: Ctx,
  tx: Tx,
  ws: WsRef,
  subkind: string,
  keyPrefix: string,
  wanted: Notice[],
): Promise<Mail[]> {
  const open = await rows<{ id: string; org_id: string; key: string }>(
    tx,
    `SELECT id, org_id, data->>'key' AS key FROM desk_items
      WHERE subkind=$1 AND status='open' AND addressee_user_id=$2 AND starts_with(data->>'key', $3)`,
    [subkind, ws.userId, keyPrefix],
  );
  const events: AppendInput[] = [];
  const mails: Mail[] = [];
  const wantedKeys = new Set<string>();
  for (const n of wanted) {
    for (const orgId of n.orgIds) {
      wantedKeys.add(`${n.key}|${orgId}`);
      if (open.some((o) => o.key === n.key && o.org_id === orgId)) continue;
      const deskItemId = randomUUID();
      events.push({
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'alert',
            subkind: n.subkind,
            title: n.title,
            body: n.body,
            options: [],
            blocking: false,
            pinned: false,
            affectedCardIds: [],
            askedBy: { kind: 'system' },
            addresseeUserId: ws.userId,
            data: { key: n.key, workstationId: ws.id },
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(orgId),
      });
      if (n.mail && !mails.includes(n.mail)) mails.push(n.mail);
    }
  }
  for (const o of open) {
    if (wantedKeys.has(`${o.key}|${o.org_id}`)) continue;
    events.push({
      streamId: streamId.desk(o.id),
      event: {
        type: 'DeskItemResolved',
        payload: {
          deskItemId: o.id,
          resolution: 'acknowledged',
          note: 'Fixed: this no longer needs attention.',
          by: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(o.org_id),
    });
  }
  if (events.length > 0) await ctx.store.append(events, { tx });
  return mails;
}

export async function sendMails(ctx: Ctx, ws: WsRef, mails: Mail[]): Promise<void> {
  if (mails.length === 0) return;
  const user = await one<{ email: string }>(ctx.pool, 'SELECT email FROM users WHERE id=$1', [ws.userId]);
  if (!user) return;
  for (const m of mails) {
    try {
      await ctx.mailer.send({ to: user.email, subject: m.subject, text: m.text });
    } catch {
      // a mail that cannot be sent never stops the report: the notice is on the desk
    }
  }
}

export const claudeAuthText = (workstation: string): { title: string; body: string } => ({
  title: `Claude login expired on ${workstation}`,
  body: `Agents on ${workstation} cannot work until Claude Code is signed in again. On that machine run \`claude\` and then \`/login\` (or \`claude setup-token\` and set the token in the runner config, which does not expire the same way). Work waiting for ${workstation} is paused, not failed, and resumes by itself once the login works.`,
});

/** After a runtimes report or hello: raise or clear the "Claude login expired" notice of the workstation. */
export async function syncClaudeAuthNotice(
  ctx: Ctx,
  ws: WsRef,
  runtimes: Array<{ id: string; auth?: string | undefined }>,
): Promise<void> {
  const expired = runtimes.some((r) => r.id === 'claude-code' && r.auth === 'expired');
  const w = await one<{ name: string }>(ctx.pool, 'SELECT name FROM workstations WHERE id=$1', [ws.id]);
  if (!w) return;
  const text = claudeAuthText(w.name);
  const key = `claude_auth:${ws.id}`;
  const mails = await withAppendTx(ctx.pool, async (tx) =>
    reconcile(
      ctx,
      tx,
      ws,
      DESK_SUBKIND.claudeAuthExpired,
      key,
      expired
        ? [
            {
              key,
              subkind: DESK_SUBKIND.claudeAuthExpired,
              ...text,
              orgIds: await agentOrgs(tx, ws.id),
              mail: { subject: text.title, text: `${text.body}\n` },
            },
          ]
        : [],
    ),
  );
  await sendMails(ctx, ws, mails);
}

export const claudeUsageText = (workstation: string, resumes: string): { title: string; body: string } => ({
  title: `Claude usage limit reached on ${workstation}`,
  body: `The Claude subscription on ${workstation} has hit its usage limit; work resumes at ${resumes}. Work waiting for ${workstation} is paused, not failed: cards stay in the queue without penalty and the project continues by itself once the limit resets. Nothing needs doing.`,
});

/** Formats a reset time for a notice when the runner sent none of its own: UTC. */
const utcLabel = (iso: string): string => `${new Date(iso).toISOString().slice(11, 16)} UTC`;

/**
 * After a runtimes report or hello: raise or clear the "Claude usage limit reached" notice of the workstation (backlog #73).
 * One notice per workstation and organization, mailed once, closed when the runtime is no longer limited.
 */
export async function syncClaudeUsageNotice(
  ctx: Ctx,
  ws: WsRef,
  runtimes: ClaudeRuntimeReport[],
): Promise<void> {
  const now = ctx.clock.now();
  const lim = runtimes.find(
    (r) =>
      r.id === 'claude-code' &&
      r.usage === 'limited' &&
      r.limitedUntil &&
      new Date(r.limitedUntil).getTime() > now.getTime(),
  );
  const w = await one<{ name: string }>(ctx.pool, 'SELECT name FROM workstations WHERE id=$1', [ws.id]);
  if (!w) return;
  const key = `claude_usage:${ws.id}`;
  const mails = await withAppendTx(ctx.pool, async (tx) => {
    const orgs = await agentOrgs(tx, ws.id);
    const text = lim?.limitedUntil
      ? claudeUsageText(w.name, lim.limitedLabel ?? utcLabel(lim.limitedUntil))
      : undefined;
    // The main account's notice (as before), plus one per limited project account (docs/design/claude-accounts.md 2.5).
    const wanted: Notice[] = text
      ? [
          {
            key,
            subkind: DESK_SUBKIND.claudeUsageLimit,
            ...text,
            orgIds: orgs,
            mail: { subject: text.title, text: `${text.body}\n` },
          },
        ]
      : [];
    wanted.push(
      ...(await accountUsageNotices(
        tx,
        w.name,
        runtimes.find((r) => r.id === 'claude-code'),
        orgs,
        now,
        key,
        utcLabel,
      )),
    );
    return reconcile(ctx, tx, ws, DESK_SUBKIND.claudeUsageLimit, key, wanted);
  });
  await sendMails(ctx, ws, mails);
}

/** After an `mcp.servers` report: a notice per granted server of the workstation that needs a sign-in. */
export async function syncMcpSignInNotices(ctx: Ctx, ws: WsRef, report: unknown): Promise<void> {
  const servers = ((report as { servers?: unknown[] } | null)?.servers ?? []).flatMap((s) => {
    const p = McpServerInfoSchema.safeParse(s);
    return p.success ? [p.data] : [];
  });
  const need = servers.filter((s) => s.authState === 'needs_sign_in');
  const w = await one<{ name: string }>(ctx.pool, 'SELECT name FROM workstations WHERE id=$1', [ws.id]);
  if (!w) return;
  await withAppendTx(ctx.pool, async (tx) => {
    const wanted: Notice[] = [];
    if (need.length > 0) {
      const orgs = await agentOrgs(tx, ws.id);
      for (const s of need) {
        const granted = await rows<{ org_id: string }>(
          tx,
          `SELECT DISTINCT org_id FROM projects WHERE status='active' AND $1 = ANY(mcp_servers) AND org_id = ANY($2::uuid[])`,
          [s.name, orgs],
        );
        if (granted.length === 0) continue;
        wanted.push({
          key: `mcp_signin:${ws.id}:${s.name}`,
          subkind: DESK_SUBKIND.mcpNeedsSignIn,
          title: `${s.server} needs sign-in on ${w.name}`,
          body: `The ${s.plugin} plugin's ${s.server} server is granted to a project but is not signed in on ${w.name}, so agents there cannot use it. ${mcpSignInInstruction(s.server, w.name)}`,
          orgIds: granted.map((g) => g.org_id),
        });
      }
    }
    await reconcile(ctx, tx, ws, DESK_SUBKIND.mcpNeedsSignIn, `mcp_signin:${ws.id}:`, wanted);
  });
}
