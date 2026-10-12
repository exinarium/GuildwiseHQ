import { randomUUID } from 'node:crypto';
import {
  type CreateMailInboxRequest,
  type InboundHealth,
  MAIL_SKIP_REASONS,
  type MailInboxDto,
  type MailInboxesResponse,
  type MailMessageDto,
  type MailSkipReason,
  normaliseAllowEntry,
  type PatchMailInboxRequest,
  streamId,
} from '@aom/shared';
import type { OrgAccess } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { orgSlug, randomToken } from '../mail/inbound/ingest.ts';
import { configuredProvider } from '../mail/inbound/providers.ts';
import { orgScope, userActor } from './common.ts';

/** Inboxes an organisation can have. */
export const MAX_INBOXES_PER_ORG = 5;

const domainOf = (ctx: Ctx): string | null =>
  configuredProvider(ctx.config) && ctx.config.inbound.domain ? ctx.config.inbound.domain : null;

/** `<slug>-<random>@<inbound domain>`: the random part is what stops anyone guessing an address. */
async function newAddress(ctx: Ctx, db: Queryable, orgId: string, domain: string): Promise<string> {
  const org = await one(db, 'SELECT name FROM organizations WHERE id=$1', [orgId]);
  const slug = orgSlug(org?.name ?? 'org');
  for (let i = 0; i < 5; i++) {
    const address = `${slug}-${randomToken(10)}@${domain}`;
    if (!(await one(db, 'SELECT 1 FROM mail_addresses WHERE address=$1', [address]))) return address;
  }
  throw conflict('address_unavailable', 'could not make a free address; try again');
}

async function dtoOf(db: Queryable, id: string): Promise<MailInboxDto | undefined> {
  return (await dtos(db, 'i.id = $1', [id]))[0];
}

async function dtos(db: Queryable, where: string, params: unknown[]): Promise<MailInboxDto[]> {
  const list = await rows(
    db,
    `SELECT i.*, a.address,
            (SELECT max(received_at) FROM mail_messages m WHERE m.inbox_id = i.id AND m.direction='in') AS last_received,
            (SELECT count(*) FROM mail_messages m WHERE m.inbox_id = i.id AND m.direction='in'
                AND m.status <> 'skipped' AND m.received_at > now() - interval '24 hours') AS received,
            (SELECT count(*) FROM mail_messages m WHERE m.inbox_id = i.id AND m.direction='in'
                AND m.status = 'skipped' AND m.received_at > now() - interval '24 hours') AS skipped
       FROM mail_inboxes i JOIN mail_addresses a ON a.inbox_id = i.id AND a.active
      WHERE ${where} ORDER BY i.created_at, i.id`,
    params,
  );
  return list.map((r) => ({
    id: r.id,
    label: r.label,
    address: r.address,
    enabled: r.enabled,
    projectId: r.project_id ?? null,
    allowList: r.allow_list ?? [],
    createdAt: iso(r.created_at) as string,
    lastReceivedAt: iso(r.last_received),
    last24h: { received: Number(r.received), skipped: Number(r.skipped) },
  }));
}

export async function listInboxes(ctx: Ctx, orgId: string): Promise<MailInboxesResponse> {
  return {
    configured: domainOf(ctx) !== null,
    domain: domainOf(ctx),
    inboxes: await dtos(ctx.pool, 'i.org_id = $1', [orgId]),
  };
}

export async function createInbox(
  ctx: Ctx,
  a: OrgAccess,
  req: CreateMailInboxRequest,
): Promise<MailInboxDto> {
  const domain = domainOf(ctx);
  if (!domain)
    throw conflict(
      'inbound_not_configured',
      'inbound e-mail is not set up on this platform yet; ask the platform administrator',
    );
  const id = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    const n = Number((await one(tx, 'SELECT count(*) AS n FROM mail_inboxes WHERE org_id=$1', [a.orgId]))?.n);
    if (n >= MAX_INBOXES_PER_ORG)
      throw conflict('too_many_inboxes', `an organisation can have ${MAX_INBOXES_PER_ORG} inboxes`);
    if (req.projectId) {
      const p = await one(tx, 'SELECT 1 FROM projects WHERE id=$1 AND org_id=$2', [req.projectId, a.orgId]);
      if (!p) throw notFound('project not found');
    }
    const now = ctx.clock.now();
    const address = await newAddress(ctx, tx, a.orgId, domain);
    await tx.query(
      `INSERT INTO mail_inboxes (id, org_id, project_id, label, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [id, a.orgId, req.projectId ?? null, req.label, a.session.user.id, now],
    );
    await tx.query(
      'INSERT INTO mail_addresses (address, inbox_id, org_id, created_at) VALUES ($1,$2,$3,$4)',
      [address, id, a.orgId, now],
    );
    await ctx.store.append(
      [
        {
          streamId: streamId.mailInbox(id),
          event: {
            type: 'MailInboxCreated',
            payload: {
              inboxId: id,
              label: req.label,
              address,
              ...(req.projectId ? { projectId: req.projectId } : {}),
            },
          },
          actor: userActor(a.session.user.id),
          scope: orgScope(a.orgId),
        },
      ],
      { tx },
    );
  });
  return (await dtoOf(ctx.pool, id)) as MailInboxDto;
}

async function ownInbox(db: Queryable, orgId: string, id: string) {
  const i = await one(db, 'SELECT * FROM mail_inboxes WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (!i) throw notFound('inbox not found');
  return i;
}

/** A new address replaces the current one at once; mail to the old address is recorded as skipped and goes nowhere. */
export async function rotateInbox(ctx: Ctx, a: OrgAccess, id: string): Promise<MailInboxDto> {
  const domain = domainOf(ctx);
  if (!domain) throw conflict('inbound_not_configured', 'inbound e-mail is not set up on this platform yet');
  await withAppendTx(ctx.pool, async (tx) => {
    await ownInbox(tx, a.orgId, id);
    const now = ctx.clock.now();
    const old = await one(tx, 'SELECT address FROM mail_addresses WHERE inbox_id=$1 AND active FOR UPDATE', [
      id,
    ]);
    const address = await newAddress(ctx, tx, a.orgId, domain);
    await tx.query('UPDATE mail_addresses SET active=false, retired_at=$2 WHERE inbox_id=$1 AND active', [
      id,
      now,
    ]);
    await tx.query(
      'INSERT INTO mail_addresses (address, inbox_id, org_id, created_at) VALUES ($1,$2,$3,$4)',
      [address, id, a.orgId, now],
    );
    await ctx.store.append(
      [
        {
          streamId: streamId.mailInbox(id),
          event: {
            type: 'MailInboxRotated',
            payload: { inboxId: id, address, previousAddress: old?.address ?? '' },
          },
          actor: userActor(a.session.user.id),
          scope: orgScope(a.orgId),
        },
      ],
      { tx },
    );
  });
  return (await dtoOf(ctx.pool, id)) as MailInboxDto;
}

/** Label and switch: Owner and Admins. The allow-list (who may have cards queued directly): the Owner only. */
export async function patchInbox(
  ctx: Ctx,
  a: OrgAccess,
  id: string,
  patch: PatchMailInboxRequest,
): Promise<MailInboxDto> {
  let entries: string[] | undefined;
  if (patch.allowList) {
    if (a.role !== 'owner') throw forbidden('only the Owner can change who may have cards queued directly');
    const bad: string[] = [];
    entries = [];
    for (const raw of patch.allowList) {
      const n = normaliseAllowEntry(raw);
      if (!n) bad.push(raw);
      else if (!entries.includes(n)) entries.push(n);
    }
    if (bad.length)
      throw badRequest('invalid_allow_list', `not an address or a domain: ${bad.join(', ')}`, {
        entries: bad,
      });
  }
  await withAppendTx(ctx.pool, async (tx) => {
    await ownInbox(tx, a.orgId, id);
    const now = ctx.clock.now();
    const events = [];
    if (patch.label !== undefined || patch.enabled !== undefined) {
      await tx.query(
        'UPDATE mail_inboxes SET label=COALESCE($2,label), enabled=COALESCE($3,enabled), updated_at=$4 WHERE id=$1',
        [id, patch.label ?? null, patch.enabled ?? null, now],
      );
      events.push({
        streamId: streamId.mailInbox(id),
        event: {
          type: 'MailInboxUpdated' as const,
          payload: {
            inboxId: id,
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          },
        },
        actor: userActor(a.session.user.id),
        scope: orgScope(a.orgId),
      });
    }
    if (entries) {
      await tx.query('UPDATE mail_inboxes SET allow_list=$2, updated_at=$3 WHERE id=$1', [id, entries, now]);
      events.push({
        streamId: streamId.mailInbox(id),
        event: { type: 'MailAllowListChanged' as const, payload: { inboxId: id, entries } },
        actor: userActor(a.session.user.id),
        scope: orgScope(a.orgId),
      });
    }
    if (events.length) await ctx.store.append(events, { tx });
  });
  return (await dtoOf(ctx.pool, id)) as MailInboxDto;
}

export async function listMessages(
  ctx: Ctx,
  orgId: string,
  inboxId: string,
  limit: number,
): Promise<MailMessageDto[]> {
  await ownInbox(ctx.pool, orgId, inboxId);
  const list = await rows(
    ctx.pool,
    `SELECT m.*, c.ref AS card_ref, t.card_id AS thread_card
       FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id
       LEFT JOIN cards c ON c.id = COALESCE(m.card_id, t.card_id)
      WHERE m.inbox_id=$1 AND m.org_id=$2 AND m.direction='in'
      ORDER BY m.received_at DESC, m.id LIMIT $3`,
    [inboxId, orgId, limit],
  );
  return list.map((r) => ({
    id: r.id,
    inboxId: r.inbox_id,
    threadId: r.thread_id,
    from: r.from_address,
    fromName: r.from_name ?? null,
    subject: r.subject,
    receivedAt: iso(r.received_at) as string,
    status: r.status,
    reason: r.reason ?? null,
    reasonText: r.reason ? (MAIL_SKIP_REASONS[r.reason as MailSkipReason] ?? r.reason) : null,
    cardId: r.card_id ?? null,
    cardRef: r.card_ref ?? null,
    auth: r.auth,
    allowListed: r.allow_listed,
    attachments: Array.isArray(r.attachments) ? r.attachments.length : 0,
    isReply: r.status === 'comment_added',
  }));
}

/** The super admin's view of the provider: configuration, volumes and what was refused (no organisation data). */
export async function inboundHealth(ctx: Ctx): Promise<InboundHealth> {
  const cfg = ctx.config.inbound;
  const day = await rows<{ status: string; reason: string | null; n: string }>(
    ctx.pool,
    `SELECT status, reason, count(*) AS n FROM mail_messages
      WHERE direction='in' AND received_at > now() - interval '24 hours' GROUP BY status, reason`,
  );
  const skippedByReason: Record<string, number> = {};
  let received = 0;
  let skipped = 0;
  for (const r of day) {
    if (r.status === 'skipped') {
      skipped += Number(r.n);
      skippedByReason[r.reason ?? 'unknown'] = (skippedByReason[r.reason ?? 'unknown'] ?? 0) + Number(r.n);
    } else received += Number(r.n);
  }
  const counter = async (kind: string): Promise<number> =>
    Number(
      (
        await one(
          ctx.pool,
          'SELECT COALESCE(sum(n),0) AS n FROM inbound_counters WHERE kind=$1 AND day >= CURRENT_DATE - 1',
          [kind],
        )
      )?.n ?? 0,
    );
  return {
    provider: cfg.provider ?? null,
    domain: cfg.domain ?? null,
    configured: Boolean(cfg.provider && cfg.domain && cfg.secret),
    secretSet: Boolean(cfg.secret),
    inboxes: Number((await one(ctx.pool, 'SELECT count(*) AS n FROM mail_inboxes'))?.n ?? 0),
    lastReceivedAt: iso(
      (await one(ctx.pool, `SELECT max(received_at) AS t FROM mail_messages WHERE direction='in'`))?.t,
    ),
    last24h: {
      received,
      skipped,
      skippedByReason,
      unknownAddress: await counter('unknown_address'),
      authFailed: await counter('auth_failed'),
    },
    limits: {
      maxMessageBytes: cfg.maxMessageBytes,
      ratePerHourPerOrg: cfg.ratePerHour,
      spamThreshold: cfg.spamThreshold,
    },
  };
}
