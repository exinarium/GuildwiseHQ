import { randomUUID } from 'node:crypto';
import { type NotifyKind, streamId } from '@aom/shared';
import { orgOwnerId } from '../auth/org-context.ts';
import { agentActor, orgScope } from '../commands/common.ts';
import { raiseOrCoalesce } from '../commands/desk-coalesce.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { ceoNotifyMail } from '../mail/ceo.ts';
import { loadCeo } from './state.ts';

const EMAIL_WINDOW_MS = 3_600_000;

/** `HH:MM` local time of the owner is inside the quiet hours (which may wrap midnight). */
export function inQuietHours(q: { from: string; to: string } | null, minutes: number): boolean {
  if (!q) return false;
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const from = m(q.from);
  const to = m(q.to);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * An immediate notification to the owner (docs/design/ceo-agent-v2.md section 6): a pinned desk item, an e-mail (one per
 * kind and subject per hour; non-urgent mail waits out the quiet hours for the daily report) and the internal event
 * `CeoNotified` that automations can forward to Slack or Teams.
 */
export async function notifyOwner(
  ctx: Ctx,
  orgId: string,
  input: {
    kind: NotifyKind;
    title: string;
    text: string;
    taskId?: string | undefined;
    deskItemId?: string | undefined;
    subject?: string;
    /**
     * What the notice is about, durably (a card and what is said about it): the same key and state is never raised again
     * until the state changes, whatever the wording. Without it, an open notice of the same subject only gets a counter.
     */
    once?: { key: string; state: string } | undefined;
  },
): Promise<{
  notificationId: string;
  deskItemId?: string;
  emailed: boolean;
  /** The subject was already handled in this state: nothing was raised. */
  suppressed?: boolean;
}> {
  const ceo = await loadCeo(ctx.pool, orgId);
  if (!ceo || !ceo.agentId) return { notificationId: '', emailed: false };
  const ch = ceo.settings.notify[input.kind];
  const onceFlag = input.once ? `once:${input.once.key}` : undefined;
  if (onceFlag) {
    const seen = await one<{ value: string }>(
      ctx.pool,
      'SELECT value FROM ceo_flags WHERE org_id=$1 AND flag=$2',
      [orgId, onceFlag],
    );
    if (seen && seen.value === input.once?.state)
      return { notificationId: '', emailed: false, suppressed: true };
  }
  const notificationId = randomUUID();
  const noticeEvent = (deskItemId?: string): AppendInput => ({
    streamId: streamId.ceoNotice(notificationId),
    event: {
      type: 'CeoNotified',
      payload: {
        notificationId,
        orgId,
        kind: input.kind,
        title: input.title.slice(0, 200),
        text: input.text,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(deskItemId ? { deskItemId } : {}),
        channels: ch,
      },
    },
    actor: agentActor(ceo.agentId as string),
    scope: orgScope(orgId),
  });
  let deskItemId: string | undefined;
  if (ch.desk) {
    // One desk item per subject: while it is open, the same subject only raises its counter.
    const subjectKey = `ceo_notice:${input.kind}:${input.once?.key ?? input.subject ?? input.title.slice(0, 80)}`;
    const r = await raiseOrCoalesce(
      ctx,
      {
        subjectKey,
        orgId,
        kind: 'alert',
        subkind: 'ceo_notice',
        title: input.title,
        body: input.text,
        pinned: input.kind !== 'task_done',
        data: {
          kind: input.kind,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.deskItemId ? { about: input.deskItemId } : {}),
        },
        askedBy: { kind: 'agent', agentId: ceo.agentId, role: 'ceo' },
        actor: agentActor(ceo.agentId),
        scope: orgScope(orgId),
      },
      { extra: (id) => [noticeEvent(id)] },
    );
    deskItemId = r.deskItemId;
  } else await ctx.store.append([noticeEvent()]);
  if (onceFlag && input.once)
    await exec(
      ctx.pool,
      `INSERT INTO ceo_flags (org_id, flag, value, at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, flag) DO UPDATE SET value=EXCLUDED.value, at=EXCLUDED.at`,
      [orgId, onceFlag, input.once.state, ctx.clock.now()],
    );

  let emailed = false;
  if (ch.email) {
    const flag = `mail:${input.kind}:${input.subject ?? input.title.slice(0, 60)}`;
    const last = await one<{ at: Date }>(ctx.pool, 'SELECT at FROM ceo_flags WHERE org_id=$1 AND flag=$2', [
      orgId,
      flag,
    ]);
    const recent = last && ctx.clock.now().getTime() - new Date(last.at).getTime() < EMAIL_WINDOW_MS;
    const owner = await orgOwnerId(ctx.pool, orgId);
    const u = await one(ctx.pool, 'SELECT email, timezone FROM users WHERE id=$1', [owner]);
    const quiet =
      input.kind !== 'urgent' &&
      inQuietHours(ceo.settings.quietHours, localMinutes(ctx.clock.now(), u?.timezone));
    if (!recent && !quiet && u?.email) {
      const name =
        (await one(ctx.pool, 'SELECT name FROM agents WHERE id=$1', [ceo.agentId]))?.name ?? 'Your CEO';
      try {
        await ctx.mailer.send({
          ...ceoNotifyMail({
            to: u.email,
            origin: ctx.config.publicOrigin,
            ceoName: name,
            kind: input.kind,
            title: input.title,
            text: input.text,
          }),
          orgId,
        });
        emailed = true;
        await exec(
          ctx.pool,
          `INSERT INTO ceo_flags (org_id, flag, value, at) VALUES ($1,$2,'sent',$3)
           ON CONFLICT (org_id, flag) DO UPDATE SET at=EXCLUDED.at`,
          [orgId, flag, ctx.clock.now()],
        );
      } catch (err) {
        ctx.log.error({ err }, 'ceo notification mail failed');
      }
    }
  }
  return { notificationId, ...(deskItemId ? { deskItemId } : {}), emailed };
}

function localMinutes(now: Date, tz: string | null | undefined): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return get('hour') * 60 + get('minute');
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}
