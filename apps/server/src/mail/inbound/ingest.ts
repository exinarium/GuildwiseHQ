import { randomBytes, randomUUID } from 'node:crypto';
import {
  isOrgOperational,
  type MailAuthVerdict,
  normaliseSubject,
  parseAddress,
  senderAllowed,
  splitPlusAddress,
  streamId,
} from '@aom/shared';
import { orgScope, SYSTEM_ACTOR } from '../../commands/common.ts';
import type { Ctx } from '../../context.ts';
import { one, type Queryable, type Row, rows } from '../../db/sql.ts';
import { withAppendTx } from '../../db/tx.ts';
import { bodyText, headerText } from './sanitize.ts';
import type { NormalizedInbound } from './types.ts';

/** Stored body text per message, in characters. */
export const BODY_MAX_CHARS = 100_000;

export type IngestStatus = 'received' | 'skipped' | 'duplicate' | 'dropped';

export interface IngestOutcome {
  inboxId: string | null;
  orgId: string | null;
  messageId: string | null;
  status: IngestStatus;
  reason?: string;
}

/** Bumps a day counter for what has no organisation (unknown address, bad credentials, flood). */
export async function countInbound(db: Queryable, kind: string, by = 1): Promise<void> {
  await db.query(
    `INSERT INTO inbound_counters (day, kind, n) VALUES (CURRENT_DATE, $1, $2)
     ON CONFLICT (day, kind) DO UPDATE SET n = inbound_counters.n + EXCLUDED.n`,
    [kind, by],
  );
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** `len` random characters without look-alikes (no 0/o, 1/l/i). */
export function randomToken(len: number): string {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  return s;
}

/** `Acme Ltd.` -> `acme-ltd` (at most 20 characters; `org` when nothing is left). */
export function orgSlug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/g, '');
  return s || 'org';
}

/** The verdict on who sent it: a passing SPF or DKIM is `pass`; a failing DKIM without a passing SPF is `fail`. */
export function authVerdict(m: Pick<NormalizedInbound, 'spf' | 'dkim'>): MailAuthVerdict {
  if (m.dkim === 'pass' || m.spf === 'pass') return 'pass';
  if (m.dkim === 'fail') return 'fail';
  return 'unknown';
}

interface Route {
  address: string;
  active: boolean;
  inboxId: string;
  orgId: string;
  enabled: boolean;
  allowList: string[];
  token: string | null;
}

/** The inboxes the message was sent to (an address of an organisation, current or retired). Unknown addresses match nothing. */
async function routesOf(db: Queryable, m: NormalizedInbound): Promise<Route[]> {
  const split = m.recipients.map(splitPlusAddress);
  if (split.length === 0) return [];
  const found = await rows(
    db,
    `SELECT a.address, a.active, a.inbox_id, i.org_id, i.enabled, i.allow_list
       FROM mail_addresses a JOIN mail_inboxes i ON i.id = a.inbox_id
      WHERE a.address = ANY($1::text[])`,
    [split.map((s) => s.base)],
  );
  const byInbox = new Map<string, Route>();
  for (const r of found) {
    const s = split.find((x) => x.base === r.address);
    const route: Route = {
      address: r.address,
      active: r.active,
      inboxId: r.inbox_id,
      orgId: r.org_id,
      enabled: r.enabled,
      allowList: r.allow_list ?? [],
      token: s?.token ?? null,
    };
    // One copy per inbox; the current address wins over a retired one.
    const prior = byInbox.get(route.inboxId);
    if (!prior || (!prior.active && route.active)) byInbox.set(route.inboxId, route);
  }
  return [...byInbox.values()];
}

/** The thread a message belongs to, inside this inbox only: the plus-address token, then In-Reply-To / References. */
async function findThread(db: Queryable, route: Route, m: NormalizedInbound): Promise<Row | undefined> {
  if (route.token) {
    const t = await one(db, 'SELECT * FROM mail_threads WHERE token=$1 AND inbox_id=$2', [
      route.token,
      route.inboxId,
    ]);
    if (t) return t;
  }
  const ids = [...(m.inReplyTo ? [m.inReplyTo] : []), ...[...m.references].reverse()];
  if (ids.length === 0) return undefined;
  return one(
    db,
    `SELECT t.* FROM mail_messages x JOIN mail_threads t ON t.id = x.thread_id
      WHERE x.inbox_id=$1 AND t.inbox_id=$1 AND x.message_id = ANY($2::text[])
      ORDER BY x.received_at DESC LIMIT 1`,
    [route.inboxId, ids],
  );
}

/**
 * One message into one inbox. Always answers (a webhook that errors is retried by the provider for hours): policy
 * problems are recorded as skipped messages the organisation can see, not as errors.
 */
async function ingestOne(ctx: Ctx, route: Route, m: NormalizedInbound, now: Date): Promise<IngestOutcome> {
  const base = { inboxId: route.inboxId, orgId: route.orgId };
  const org = await one(ctx.pool, 'SELECT status FROM organizations WHERE id=$1', [route.orgId]);
  if (!org || !isOrgOperational(org.status)) {
    await countInbound(ctx.pool, 'org_not_running');
    return { ...base, messageId: null, status: 'dropped', reason: 'org_not_running' };
  }
  if (m.messageId) {
    const dup = await one(ctx.pool, 'SELECT id FROM mail_messages WHERE inbox_id=$1 AND message_id=$2', [
      route.inboxId,
      m.messageId,
    ]);
    if (dup) return { ...base, messageId: dup.id, status: 'duplicate', reason: 'duplicate' };
  }

  // Per-organisation rate: over the limit the message is recorded (without text) as skipped; far over it, only counted.
  const cfg = ctx.config.inbound;
  const recent = Number(
    (
      await one(
        ctx.pool,
        `SELECT count(*) AS n FROM mail_messages WHERE org_id=$1 AND direction='in' AND received_at > $2`,
        [route.orgId, new Date(now.getTime() - 3_600_000)],
      )
    )?.n ?? 0,
  );
  if (recent >= cfg.ratePerHour * 2) {
    await countInbound(ctx.pool, 'rate_limited_dropped');
    return { ...base, messageId: null, status: 'dropped', reason: 'rate_limited' };
  }

  const auth = authVerdict(m);
  let reason: string | undefined;
  if (!route.active) reason = 'address_retired';
  else if (!route.enabled) reason = 'inbox_disabled';
  else if (recent >= cfg.ratePerHour) reason = 'rate_limited';
  else if (m.bytes > cfg.maxMessageBytes) reason = 'too_large';
  else if (m.automatic) reason = 'automatic';
  else if (m.spamScore !== null && m.spamScore >= cfg.spamThreshold) reason = 'spam';
  else if (auth === 'fail') reason = 'sender_check_failed';

  const subject = headerText(m.subject, 300) || '(no subject)';
  const fromName = headerText(m.fromName, 120) || null;
  const body = reason ? { text: '', truncated: false } : bodyText(m.text, m.html, BODY_MAX_CHARS);
  const messageId = randomUUID();
  const allowListed = senderAllowed(m.from, route.allowList);

  const result = await withAppendTx(ctx.pool, async (tx) => {
    // A skipped message never joins a conversation: it gets a thread of its own that nothing links to.
    const thread = reason ? undefined : await findThread(tx, route, m);
    let threadId: string;
    if (thread) {
      threadId = thread.id;
      await tx.query('UPDATE mail_threads SET last_message_at=$2 WHERE id=$1', [threadId, now]);
    } else {
      threadId = randomUUID();
      await tx.query(
        `INSERT INTO mail_threads (id, org_id, inbox_id, token, subject_norm, created_at, last_message_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [threadId, route.orgId, route.inboxId, randomToken(10), normaliseSubject(subject), now],
      );
    }
    const inserted = await tx.query(
      `INSERT INTO mail_messages (id, org_id, inbox_id, thread_id, direction, message_id, in_reply_to, refs,
         from_address, from_name, to_address, subject, body_text, body_truncated, received_at, status, reason, auth,
         spam_score, allow_listed, attachments)
       VALUES ($1,$2,$3,$4,'in',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (inbox_id, message_id) WHERE message_id IS NOT NULL DO NOTHING`,
      [
        messageId,
        route.orgId,
        route.inboxId,
        threadId,
        m.messageId,
        m.inReplyTo,
        m.references.slice(0, 50),
        m.from,
        fromName,
        route.address,
        subject,
        body.text,
        body.truncated,
        now,
        reason ? 'skipped' : 'received',
        reason ?? null,
        auth,
        m.spamScore,
        allowListed,
        JSON.stringify(m.attachments.slice(0, 20)),
      ],
    );
    if (inserted.rowCount === 0) return 'duplicate' as const;
    await ctx.store.append(
      [
        {
          streamId: streamId.mailInbox(route.inboxId),
          event: {
            type: 'MailReceived',
            payload: {
              inboxId: route.inboxId,
              messageId,
              threadId,
              from: m.from.slice(0, 254),
              subject,
              status: reason ? 'skipped' : 'received',
              ...(reason ? { reason } : {}),
              ...(thread?.card_id ? { replyToCardId: thread.card_id } : {}),
              auth,
              ...(m.spamScore !== null ? { spamScore: m.spamScore } : {}),
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(route.orgId),
        },
      ],
      { tx },
    );
    return 'stored' as const;
  });
  if (result === 'duplicate') return { ...base, messageId: null, status: 'duplicate', reason: 'duplicate' };
  return {
    ...base,
    messageId,
    status: reason ? 'skipped' : 'received',
    ...(reason ? { reason } : {}),
  };
}

/**
 * A message from the provider webhook: routed by address to the inboxes it was sent to (each organisation gets its own
 * copy; an address that belongs to nobody is dropped and counted), checked and stored. Mail for one organisation is
 * only ever looked up, threaded and stored under that organisation's inbox.
 */
export async function ingestInbound(ctx: Ctx, m: NormalizedInbound): Promise<IngestOutcome[]> {
  const from = parseAddress(m.from);
  if (!from) {
    await countInbound(ctx.pool, 'unparsable');
    return [{ inboxId: null, orgId: null, messageId: null, status: 'dropped', reason: 'unparsable' }];
  }
  const routes = await routesOf(ctx.pool, m);
  if (routes.length === 0) {
    await countInbound(ctx.pool, 'unknown_address');
    return [{ inboxId: null, orgId: null, messageId: null, status: 'dropped', reason: 'unknown_address' }];
  }
  const now = ctx.clock.now();
  const out: IngestOutcome[] = [];
  for (const r of routes) out.push(await ingestOne(ctx, r, { ...m, from }, now));
  return out;
}
