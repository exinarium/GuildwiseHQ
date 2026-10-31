import { randomUUID } from 'node:crypto';
import {
  type CardOutput,
  isBriefWorkflowKey,
  isOrgOperational,
  type OutputDestination,
  outputEmail,
  outputTarget,
  outputWebhookBody,
  type ScheduleAction,
  type ScheduleDelivery,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { SYSTEM_ACTOR } from './common.ts';
import { scheduleScope } from './schedule-actions.ts';

/**
 * Delivering what the agent produced (docs/investigations/GWP-32-*.md). A `create_card` schedule with `deliverOutput`
 * sends the result of its card when the card is done, to up to five destinations. Each destination is one run in the
 * schedule's history, so tries, backoff and failures look like those of a webhook digest.
 */

export const deliverOutputOf = (a: ScheduleAction | null | undefined) =>
  a && a.kind === 'create_card' ? a.deliverOutput : undefined;

/** The card's result: the last agent handoff note, or the investigation summary for an investigation-only card. */
export async function cardOutput(ctx: Ctx, db: Queryable, cardId: string): Promise<CardOutput | null> {
  const o = await baseCardOutput(ctx, db, cardId);
  return o ? briefLinks(ctx, db, cardId, o) : o;
}

/** Brief cards only: the cards and rules the brief cites, as links. Any other card is returned as it is. */
async function briefLinks(ctx: Ctx, db: Queryable, cardId: string, o: CardOutput): Promise<CardOutput> {
  const c = await one(
    db,
    `SELECT c.org_id, v.key FROM cards c LEFT JOIN workflow_versions v ON v.id = c.workflow_version_id WHERE c.id=$1`,
    [cardId],
  );
  if (!c || !isBriefWorkflowKey(c.key as string | null)) return o;
  const origin = ctx.config.publicOrigin;
  const links: Array<{ label: string; url: string }> = [];
  const refs = [...new Set(o.text.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? [])];
  if (refs.length) {
    const found = await rows(
      db,
      'SELECT ref, title FROM cards WHERE org_id=$1 AND ref = ANY($2::text[]) AND id <> $3',
      [c.org_id, refs, cardId],
    );
    const byRef = new Map(found.map((r) => [r.ref as string, r.title as string]));
    for (const ref of refs) {
      const title = byRef.get(ref);
      if (title !== undefined)
        links.push({ label: `${ref} ${title}`, url: `${origin}/cards/${encodeURIComponent(ref)}` });
    }
  }
  const ids = [...new Set([...o.text.matchAll(/\brule ([0-9a-f]{8})\b/gi)].map((m) => (m[1] as string).toLowerCase()))];
  if (ids.length) {
    const found = await rows(
      db,
      `SELECT id, title FROM ledger_entries WHERE org_id=$1 AND left(id::text, 8) = ANY($2::text[])`,
      [c.org_id, ids],
    );
    for (const r of found)
      links.push({ label: `Rule: ${r.title}`, url: `${origin}/ledger?entry=${r.id}` });
  }
  return links.length ? { ...o, links } : o;
}

async function baseCardOutput(ctx: Ctx, db: Queryable, cardId: string): Promise<CardOutput | null> {
  const c = await one(db, 'SELECT id, ref, title, investigation, investigation_only FROM cards WHERE id=$1', [
    cardId,
  ]);
  if (!c) return null;
  const link = `${ctx.config.publicOrigin}/cards/${encodeURIComponent(c.ref as string)}`;
  const report = (c.investigation as { summary?: string } | null)?.summary?.trim() ?? '';
  if (c.investigation_only && report)
    return { ref: c.ref, title: c.title, text: report, source: 'report', link };
  const h = await one(
    db,
    `SELECT m.body FROM thread_messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.card_id=$1 AND t.kind='card' AND m.kind='handoff' AND m.author_kind='agent'
      ORDER BY m.created_at DESC, m.event_seq DESC LIMIT 1`,
    [cardId],
  );
  const text = String(h?.body ?? '').trim();
  if (!text && report) return { ref: c.ref, title: c.title, text: report, source: 'report', link };
  return { ref: c.ref, title: c.title, text, source: 'handoff', link };
}

/** The sample a "send test" uses: the newest done card of the schedule, or a fixed text. */
export async function sampleOutput(ctx: Ctx, db: Queryable, s: Row): Promise<CardOutput> {
  const c = await one(
    db,
    `SELECT id FROM cards WHERE schedule_id=$1 AND status='done' ORDER BY updated_at DESC LIMIT 1`,
    [s.id],
  );
  const real = c ? await cardOutput(ctx, db, c.id as string) : null;
  if (real && real.text) return real;
  return {
    ref: real?.ref ?? 'TEST-1',
    title: real?.title ?? 'Test delivery',
    text: `Test delivery from the automation "${s.name}". The agent's result appears here.`,
    source: 'handoff',
    link: real?.link ?? `${ctx.config.publicOrigin}/automations`,
  };
}

/** What the run record of one destination holds. No message text for the runner channels. */
export function outputDelivery(
  ctx: Ctx,
  s: Row,
  dest: OutputDestination,
  index: number,
  o: CardOutput,
  cardId: string,
  opts: { at: Date; test?: boolean },
): ScheduleDelivery {
  switch (dest.kind) {
    case 'email': {
      const m = outputEmail(o, s.name, dest);
      return { kind: 'email', to: m.to, subject: m.subject, text: m.text };
    }
    case 'webhook':
      return {
        kind: 'webhook',
        url: dest.url,
        body: JSON.stringify(
          outputWebhookBody(dest.format, o, {
            scheduleId: s.id,
            scheduleName: s.name,
            at: opts.at.toISOString(),
            ...(opts.test ? { test: true } : {}),
          }),
        ),
        event: opts.test ? 'schedule.test' : 'schedule.output',
        secret: 'output',
      };
    case 'whatsapp':
    case 'google_sheet':
      return {
        kind: 'runner',
        channel: dest.kind,
        destination: index,
        cardId,
        workstationId: dest.workstationId,
      };
  }
}

export const runLabel = (o: CardOutput, dest: OutputDestination): string =>
  `Result of ${o.ref} to ${outputTarget(dest)}`.slice(0, 300);

/** The `ScheduleRunRecorded` of one destination (pending, with its delivery). */
export function outputRunEvent(
  s: Row,
  dest: OutputDestination,
  o: CardOutput,
  delivery: ScheduleDelivery,
  cardId: string | undefined,
  spec: { runId: string; trigger: 'event' | 'test'; sourceKey?: string; now: Date; byUserId?: string },
): AppendInput {
  const test = spec.trigger === 'test';
  return {
    streamId: streamId.schedule(s.id),
    event: {
      type: 'ScheduleRunRecorded',
      payload: {
        runId: spec.runId,
        scheduleId: s.id,
        trigger: spec.trigger,
        ...(spec.sourceKey ? { sourceKey: spec.sourceKey } : {}),
        label: test ? `Test to ${outputTarget(dest)}` : runLabel(o, dest),
        status: 'pending',
        summary:
          `${test ? 'Test: ' : ''}${dest.kind === 'google_sheet' ? 'Sheet row' : dest.kind === 'whatsapp' ? 'WhatsApp' : dest.kind === 'email' ? 'E-mail' : 'Webhook'} to ${outputTarget(dest)}`.slice(
            0,
            1900,
          ),
        ...(cardId ? { result: { outputCardId: cardId } } : {}),
        delivery,
        // A test is sent now and never retried.
        ...(test ? {} : { nextAttemptAt: spec.now.toISOString() }),
      },
    },
    actor: SYSTEM_ACTOR,
    scope: scheduleScope(s),
  };
}

/**
 * The card `cardId`, made by schedule `scheduleId`, is done: records one pending delivery run per destination (once:
 * `output:<cardId>:<index>` is the dedupe key) and returns the run ids. The caller makes the first try after the commit.
 * `allowed` throws when the schedule's owner may no longer run it.
 */
export async function queueOutputDeliveries(
  ctx: Ctx,
  scheduleId: string,
  cardId: string,
  allowed: (tx: Tx, s: Row) => Promise<void>,
): Promise<string[]> {
  return withAppendTx(ctx.pool, async (tx) => {
    const s = await one(tx, 'SELECT * FROM schedules WHERE id=$1 AND enabled FOR UPDATE', [scheduleId]);
    const out = s ? deliverOutputOf(s.action as ScheduleAction) : undefined;
    if (!s || !out) return [];
    const org = await one(tx, 'SELECT status FROM organizations WHERE id=$1', [s.org_id]);
    if (org && !isOrgOperational(org.status)) return [];
    await allowed(tx, s);
    const o = await cardOutput(ctx, tx, cardId);
    if (!o) return [];
    const now = ctx.clock.now();
    const events: AppendInput[] = [];
    const ids: string[] = [];
    for (const [i, dest] of out.destinations.entries()) {
      const sourceKey = `output:${cardId}:${i}`;
      if (
        await one(tx, 'SELECT 1 FROM schedule_runs WHERE schedule_id=$1 AND source_key=$2', [s.id, sourceKey])
      )
        continue;
      const runId = randomUUID();
      events.push(
        outputRunEvent(s, dest, o, outputDelivery(ctx, s, dest, i, o, cardId, { at: now }), cardId, {
          runId,
          trigger: 'event',
          sourceKey,
          now,
        }),
      );
      ids.push(runId);
    }
    if (events.length) await ctx.store.append(events, { tx });
    return ids;
  });
}
