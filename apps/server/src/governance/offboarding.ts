import { randomUUID } from 'node:crypto';
import { OFFBOARDING_GRACE_DAYS, type OffboardingReport, type OffboardingStep, streamId } from '@aom/shared';
import { orgScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import { queueClear } from '../commands/org-provider-keys.ts';
import { unlinkWorkstationIn } from '../commands/workstations.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';

/** What the offboarding of one member would touch, counted without changing anything (the removal dialog shows it). */
export interface OffboardingFacts {
  /** Other organizations the person belongs to: as a member, or as a guest on a project another organization shared with them. */
  otherOrgs: number;
  /** Of those, organizations where they are only a guest on a shared project. */
  guestOrgs: number;
  sessions: number;
  pairingCodes: number;
  deskLinks: number;
  workstations: Row[];
  orgPacksHeld: Row[];
  privatePackShares: number;
  keyShares: Row[];
  orgKeysSet: string[];
  ownedSessions: Row[];
  ownedOrgPacks: Row[];
  privateChats: Row[];
  privatePacks: Row[];
  pushDevices: number;
  authoredOnTheirStation: string[];
}

export async function offboardingFacts(
  db: Queryable,
  orgId: string,
  userId: string,
): Promise<OffboardingFacts> {
  const n = async (sql: string, params: unknown[]): Promise<number> =>
    Number((await one<{ n: string }>(db, sql, params))?.n ?? 0);
  const workstations = await rows(
    db,
    `SELECT id, name FROM workstations WHERE user_id=$1 AND status='active' ORDER BY paired_at`,
    [userId],
  );
  const wsIds = workstations.map((w) => w.id as string);
  const orgPacksHeld = await rows(
    db,
    `SELECT p.* FROM packs p WHERE p.org_id=$1 AND p.removed_at IS NULL AND p.visibility='org' AND p.workstation_ids && $2::uuid[]`,
    [orgId, wsIds],
  );
  const privatePacks = await rows(
    db,
    `SELECT id, name, workstation_ids FROM packs WHERE org_id=$1 AND owner_user_id=$2 AND visibility='private' AND removed_at IS NULL`,
    [orgId, userId],
  );
  const authoredOnTheirStation = orgPacksHeld
    .filter(
      (p) => p.source === 'authored' && wsIds.includes(((p.workstation_ids as string[]) ?? [])[0] as string),
    )
    .map((p) => p.name as string);
  const memberOrgs = await n(
    `SELECT count(*) AS n FROM org_members WHERE user_id=$1 AND org_id<>$2 AND status='active'`,
    [userId, orgId],
  );
  const guestOrgs = await n(
    `SELECT count(DISTINCT p.org_id) AS n FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE pm.user_id=$1 AND pm.status='active' AND p.org_id<>$2
        AND NOT EXISTS (SELECT 1 FROM org_members om WHERE om.user_id=$1 AND om.org_id = p.org_id AND om.status='active')`,
    [userId, orgId],
  );
  return {
    otherOrgs: memberOrgs + guestOrgs,
    guestOrgs,
    sessions: await n('SELECT count(*) AS n FROM auth_sessions WHERE user_id=$1', [userId]),
    pairingCodes: await n('SELECT count(*) AS n FROM pairing_codes WHERE user_id=$1 AND used_at IS NULL', [
      userId,
    ]),
    deskLinks: await n(
      'SELECT count(*) AS n FROM desk_action_tokens WHERE user_id=$1 AND org_id=$2 AND used_at IS NULL',
      [userId, orgId],
    ),
    workstations,
    orgPacksHeld,
    privatePackShares: await n(
      `SELECT count(*) AS n FROM pack_credential_shares s JOIN packs p ON p.id = s.pack_id
        WHERE p.org_id=$1 AND p.visibility='private' AND p.owner_user_id=$2`,
      [orgId, userId],
    ),
    keyShares: await rows(
      db,
      `SELECT provider, workstation_id, status FROM org_provider_key_shares WHERE org_id=$1 AND workstation_id = ANY($2::uuid[])`,
      [orgId, wsIds],
    ),
    orgKeysSet: (
      await rows(db, 'SELECT provider FROM org_providers WHERE org_id=$1 AND set_by=$2 AND configured', [
        orgId,
        userId,
      ])
    ).map((r) => r.provider as string),
    ownedSessions: await rows(
      db,
      `SELECT id FROM threads WHERE org_id=$1 AND created_by=$2 AND kind IN ('discovery','boardroom') AND deleted_at IS NULL`,
      [orgId, userId],
    ),
    ownedOrgPacks: await rows(
      db,
      `SELECT id, name FROM packs WHERE org_id=$1 AND owner_user_id=$2 AND visibility='org' AND removed_at IS NULL`,
      [orgId, userId],
    ),
    privateChats: await rows(
      db,
      `SELECT id FROM threads WHERE org_id=$1 AND created_by=$2 AND kind='chat' AND deleted_at IS NULL`,
      [orgId, userId],
    ),
    privatePacks,
    pushDevices: await n('SELECT count(*) AS n FROM push_subscriptions WHERE user_id=$1', [userId]),
    authoredOnTheirStation,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The checklist as the removal dialog previews it (nothing is changed). */
export function previewSteps(
  f: OffboardingFacts,
  counts: { agents: number; cards: number },
): OffboardingStep[] {
  const last = f.otherOrgs === 0;
  return buildSteps(f, counts, { last, applied: false, signOut: f.otherOrgs === 0 });
}

function buildSteps(
  f: OffboardingFacts,
  c: { agents: number; cards: number },
  o: { last: boolean; applied: boolean; signOut: boolean },
): OffboardingStep[] {
  const tense = (done: string, will: string) => (o.applied ? done : will);
  const step = (
    key: OffboardingStep['key'],
    label: string,
    count: number,
    detail: string,
    status?: OffboardingStep['status'],
  ): OffboardingStep => ({ key, label, count, status: status ?? (count > 0 ? 'done' : 'nothing'), detail });
  const pushCount = o.last ? f.pushDevices : 0;
  return [
    o.signOut
      ? step(
          'sessions',
          'Sign-in sessions',
          f.sessions,
          `${tense('Signed out', 'Will be signed out')} everywhere (${plural(f.sessions, 'session')}); they sign in again for any other organization.`,
        )
      : step(
          'sessions',
          'Sign-in sessions',
          f.sessions,
          f.guestOrgs > 0
            ? 'Kept: this person is still a member of another organization or a guest on a project another organization shared with them (those are untouched). They can no longer open this one.'
            : 'Kept: this person is still a member of another organization (their other organizations are untouched). They can no longer open this one.',
          'kept',
        ),
    step(
      'tokens',
      'Links, codes and tokens',
      f.deskLinks + (o.last ? f.pairingCodes : 0),
      `${tense('Revoked', 'Will revoke')} ${plural(f.deskLinks, 'notification link')}${o.last ? ` and ${plural(f.pairingCodes, 'pairing code')}` : ''}. Runner tokens end with the workstation. There are no personal API tokens.`,
    ),
    o.last
      ? step(
          'workstations',
          'Workstation pairings',
          f.workstations.length,
          `${tense('Unlinked', 'Will unlink')} ${plural(f.workstations.length, 'workstation')}${f.workstations.length ? `: ${f.workstations.map((w) => w.name).join(', ')}` : ''}.`,
        )
      : step(
          'workstations',
          'Workstation pairings',
          f.workstations.length,
          'Kept: they are still used for the other organization or a shared project. Nothing of this organization stays on them (see packs and keys).',
          'kept',
        ),
    step(
      'pack_credentials',
      'Pack credentials',
      f.privatePackShares,
      `${tense('Deleted', 'Will delete')} ${plural(f.privatePackShares, 'sealed pack credential')} held for their private packs.`,
    ),
    step(
      'pack_assignments',
      'Pack assignments',
      f.orgPacksHeld.length,
      `${tense('Taken', 'Will take')} ${plural(f.orgPacksHeld.length, 'organization pack')} off their workstations${f.authoredOnTheirStation.length ? `; kept where the files are authored on their workstation: ${f.authoredOnTheirStation.join(', ')}` : ''}.`,
    ),
    step(
      'org_key_shares',
      'Organization key copies',
      f.keyShares.length,
      `${tense('Cleared', 'Will clear')} ${plural(f.keyShares.length, 'copy', 'copies')} of the organization key on their workstations.`,
    ),
    step(
      'agents',
      'Their agents',
      c.agents,
      `${plural(c.agents, 'agent')} ${tense('handed', 'will be handed')} to the Owner to re-home (their claims go back to the queue).`,
    ),
    step(
      'cards',
      'Their cards',
      c.cards,
      `${plural(c.cards, 'card')} ${tense('moved', 'will move')} to the Owner.`,
    ),
    step(
      'owned_sessions',
      'Discovery and Boardroom sessions',
      f.ownedSessions.length,
      `${plural(f.ownedSessions.length, 'session')} ${tense('moved', 'will move')} to the Owner.`,
    ),
    step(
      'org_packs',
      'Organization packs they own',
      f.ownedOrgPacks.length,
      `${plural(f.ownedOrgPacks.length, 'pack')} ${tense('moved', 'will move')} to the Owner.`,
    ),
    step(
      'private_items',
      'Private items',
      f.privateChats.length + f.privatePacks.length,
      `${plural(f.privateChats.length, 'private chat')} and ${plural(f.privatePacks.length, 'private pack')} ${tense('are flagged', 'will be flagged')} and ${tense('deleted', 'deleted')} after ${OFFBOARDING_GRACE_DAYS} days.`,
      f.privateChats.length + f.privatePacks.length > 0 ? 'flagged' : 'nothing',
    ),
    step(
      'push_devices',
      'Notification devices',
      pushCount,
      o.last
        ? `${tense('Removed', 'Will remove')} ${plural(f.pushDevices, 'phone or browser')} from push notifications.`
        : 'Kept: they are still a member of another organization or a guest on a shared project.',
      o.last ? undefined : 'kept',
    ),
  ];
}

export interface OffboardingRun {
  report: OffboardingReport;
  /** Their sessions were deleted: their open browser connections must be closed after the commit. */
  signedOutUserId?: string;
  /** Workstations that must be told after the commit (queued commands, pack sync). */
  deliver: string[];
  sync: string[];
}

/**
 * The checklist of taking a member out of an organization, inside the removal's transaction (before `OrgMemberRemoved`). Every
 * step is idempotent on its own tables; the events it appends are the audit record (and `MemberOffboarded` carries the report).
 */
export async function runOffboardingIn(
  ctx: Ctx,
  tx: Tx,
  a: {
    actorId: string;
    orgId: string;
    userId: string;
    transferTo: string;
    counts: { agents: number; cards: number };
  },
): Promise<OffboardingRun> {
  const { orgId, userId, actorId } = a;
  const f = await offboardingFacts(tx, orgId, userId);
  const last = f.otherOrgs === 0;
  const now = ctx.clock.now();
  const events: AppendInput[] = [];
  const deliver = new Set<string>();
  const sync = new Set<string>();
  const wsIds = f.workstations.map((w) => w.id as string);
  const name = (
    await one<{ display_name: string }>(tx, 'SELECT display_name FROM users WHERE id=$1', [userId])
  )?.display_name;

  // 1. sessions + 2. tokens + push devices
  await exec(tx, 'DELETE FROM desk_action_tokens WHERE user_id=$1 AND org_id=$2', [userId, orgId]);
  const signOut = last;
  if (signOut) await exec(tx, 'DELETE FROM auth_sessions WHERE user_id=$1', [userId]);
  if (last) {
    await exec(tx, 'DELETE FROM pairing_codes WHERE user_id=$1 AND used_at IS NULL', [userId]);
    await exec(tx, 'DELETE FROM push_subscriptions WHERE user_id=$1', [userId]);
  }

  // 4. org packs off their workstations (credentials and pending assignments go with them)
  for (const p of f.orgPacksHeld) {
    const current = ((p.workstation_ids as string[]) ?? []) as string[];
    const author = p.source === 'authored' ? current[0] : undefined;
    if (author && wsIds.includes(author)) continue; // the files are authored there: kept, flagged in the report
    const remaining = current.filter((id) => !wsIds.includes(id));
    events.push({
      streamId: streamId.pack(p.id),
      event: {
        type: 'PackWorkstationsChanged',
        payload: { packId: p.id, orgId, workstationIds: remaining, changedBy: actorId },
      },
      actor: userActor(actorId),
      scope: orgScope(orgId),
    } as AppendInput);
    const pending = await rows(
      tx,
      `SELECT desk_item_id, workstation_id FROM pack_assignments WHERE pack_id=$1 AND workstation_id = ANY($2::uuid[]) AND status='pending'`,
      [p.id, wsIds],
    );
    for (const x of pending)
      if (x.desk_item_id)
        events.push({
          streamId: streamId.desk(x.desk_item_id),
          event: {
            type: 'DeskItemResolved',
            payload: {
              deskItemId: x.desk_item_id,
              resolution: 'dismissed',
              note: 'The person left the organization.',
              by: { kind: 'system' },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(orgId),
        } as AppendInput);
    await exec(
      tx,
      'DELETE FROM pack_credential_shares WHERE pack_id=$1 AND workstation_id = ANY($2::uuid[])',
      [p.id, wsIds],
    );
    for (const w of wsIds) sync.add(w);
  }
  // their private packs: the sealed credentials go now, the packs after the grace period
  await exec(
    tx,
    `DELETE FROM pack_credential_shares WHERE pack_id IN
       (SELECT id FROM packs WHERE org_id=$1 AND owner_user_id=$2 AND visibility='private')`,
    [orgId, userId],
  );

  // 5. the organization's key on their workstations
  const gens = new Map<string, number>(
    (await rows(tx, 'SELECT provider, key_generation FROM org_providers WHERE org_id=$1', [orgId])).map(
      (r) => [r.provider as string, Number(r.key_generation ?? 0)],
    ),
  );
  for (const s of f.keyShares) {
    await queueClear(tx, orgId, s.provider, s.workstation_id, gens.get(s.provider) ?? 0);
    deliver.add(s.workstation_id);
  }
  if (f.keyShares.length)
    await exec(
      tx,
      'DELETE FROM org_provider_key_shares WHERE org_id=$1 AND workstation_id = ANY($2::uuid[])',
      [orgId, wsIds],
    );

  // A stored copy of the organization key on a workstation that is about to be unlinked can never be told to forget it: the key
  // generation is raised (every share and page bound to the old one is stale, an Owner or Admin must enter a new key) and the
  // Owner and Admins get a notice on the desk to rotate the key at the provider.
  const strandedProviders = last
    ? [...new Set(f.keyShares.filter((s) => s.status === 'stored').map((s) => s.provider as string))]
    : [];
  for (const provider of strandedProviders) {
    events.push({
      streamId: streamId.org(orgId),
      event: {
        type: 'OrgProviderKeyGenerationBumped',
        payload: {
          orgId,
          provider,
          by: actorId,
          reason: `a copy sits on the unlinked workstation of ${name ?? 'a removed member'}`,
        },
      },
      actor: userActor(actorId),
      scope: orgScope(orgId),
    } as AppendInput);
    const deskItemId = randomUUID();
    events.push({
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: 'org_key_rotate',
          title: `Rotate the organization ${provider} key`,
          body: `${name ?? 'A removed member'} had a copy of the organization ${provider} key on a workstation that was unlinked, so it could not be told to forget it. Create a new key at the provider, revoke the old one there, and enter the new key on the Integrations page (the old copy is refused by the server from now on).`,
          options: [],
          blocking: false,
          pinned: true,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
          data: { provider, userId },
          subjectKey: `org_key_rotate:${orgId}:${provider}:${userId}`,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(orgId),
    } as AppendInput);
  }

  // 3. workstation pairings (when this was their last organization)
  if (last)
    for (const w of f.workstations)
      await unlinkWorkstationIn(ctx, tx, actorId, w.id as string, userId, 'admin');

  // 8-9. ownership: sessions and organization packs go to the Owner (not the Admin who removes them)
  if (f.ownedSessions.length || f.ownedOrgPacks.length)
    events.push({
      streamId: streamId.org(orgId),
      event: {
        type: 'OwnedItemsTransferred',
        payload: {
          orgId,
          fromUserId: userId,
          toUserId: a.transferTo,
          sessionIds: f.ownedSessions.map((s) => s.id),
          packIds: f.ownedOrgPacks.map((p) => p.id),
        },
      },
      actor: userActor(actorId),
      scope: orgScope(orgId),
    } as AppendInput);

  // 10. private items: flagged, deleted after the grace period
  const chatIds = f.privateChats.map((c) => c.id as string);
  const packIds = f.privatePacks.map((p) => p.id as string);
  const purgeAfter =
    chatIds.length + packIds.length > 0
      ? new Date(now.getTime() + OFFBOARDING_GRACE_DAYS * 86_400_000)
      : null;

  const steps = buildSteps(f, a.counts, { last, applied: true, signOut });
  const notes: string[] = [];
  if (strandedProviders.length)
    notes.push(
      `The organization key (${strandedProviders.join(', ')}) was stored on workstations of this person. The clear commands are queued, but a workstation that is unlinked never receives them: the key generation was raised so it must be entered again, and a notice asks the Owner and Admins to rotate it at the provider.`,
    );
  else if (f.keyShares.some((s) => s.status === 'stored'))
    notes.push(
      'Clear commands for the organization key are queued for their workstations; they run when the workstation next connects.',
    );
  if (f.orgKeysSet.length)
    notes.push(
      `They set the organization key for ${f.orgKeysSet.join(', ')}. Rotate it if you do not trust the person.`,
    );
  if (f.authoredOnTheirStation.length)
    notes.push(
      `The pack${f.authoredOnTheirStation.length === 1 ? '' : 's'} ${f.authoredOnTheirStation.join(', ')} ${f.authoredOnTheirStation.length === 1 ? 'is' : 'are'} authored on their workstation and stay${f.authoredOnTheirStation.length === 1 ? 's' : ''} there: copy ${f.authoredOnTheirStation.length === 1 ? 'it' : 'them'} to another workstation.`,
    );
  if (!last)
    notes.push(
      f.guestOrgs > 0 && f.otherOrgs === f.guestOrgs
        ? 'They are still a guest on a project another organization shared with them, so their account, workstations and notification devices stay.'
        : 'They are still a member of another organization, so their account, workstations and notification devices stay.',
    );
  const report: OffboardingReport = {
    orgId,
    userId,
    userName: name ?? 'the member',
    transferredTo: a.transferTo,
    privatePurgeAfter: purgeAfter ? purgeAfter.toISOString() : null,
    steps,
    notes,
  };
  events.push({
    streamId: streamId.org(orgId),
    event: {
      type: 'MemberOffboarded',
      payload: {
        orgId,
        userId,
        by: actorId,
        transferredTo: a.transferTo,
        privatePurgeAfter: report.privatePurgeAfter,
        report: { steps: steps.map((s) => ({ key: s.key, count: s.count, status: s.status })) },
        purge: { chatIds, packIds },
      },
    },
    actor: userActor(actorId),
    scope: orgScope(orgId),
  } as AppendInput);
  await ctx.store.append(events, { tx });
  return { report, deliver: [...deliver], sync: [...sync], ...(signOut ? { signedOutUserId: userId } : {}) };
}

/**
 * Deletes what the grace period of a removed member's private items covered: due `offboarding_purges` run (a person who came back
 * to the organization first keeps their items: the purge is cancelled). Idempotent; called from the scheduler.
 */
export async function runDueOffboardingPurges(ctx: Ctx): Promise<number> {
  const due = await rows(
    ctx.pool,
    `SELECT * FROM offboarding_purges WHERE status='pending' AND purge_after <= $1 ORDER BY purge_after LIMIT 50`,
    [ctx.clock.now()],
  );
  let ran = 0;
  for (const p of due) {
    const back = await one(
      ctx.pool,
      `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
      [p.org_id, p.user_id],
    );
    const events: AppendInput[] = [];
    const holders = new Set<string>();
    if (!back) {
      const chats = await rows(
        ctx.pool,
        `SELECT id FROM threads WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [p.chat_ids],
      );
      for (const c of chats)
        events.push({
          streamId: streamId.thread(c.id),
          event: { type: 'ChatDeleted', payload: { threadId: c.id, deletedBy: p.user_id } },
          actor: SYSTEM_ACTOR,
          scope: orgScope(p.org_id),
        } as AppendInput);
      const packs = await rows(
        ctx.pool,
        `SELECT * FROM packs WHERE id = ANY($1::uuid[]) AND removed_at IS NULL`,
        [p.pack_ids],
      );
      for (const k of packs) {
        for (const w of (k.workstation_ids as string[]) ?? []) holders.add(w);
        events.push({
          streamId: streamId.pack(k.id),
          event: { type: 'PackRemoved', payload: { packId: k.id, orgId: p.org_id, removedBy: p.user_id } },
          actor: SYSTEM_ACTOR,
          scope:
            k.visibility === 'private'
              ? { orgId: null, projectId: null, audience: 'user', userId: k.owner_user_id }
              : orgScope(p.org_id),
        } as AppendInput);
      }
    }
    events.push({
      streamId: streamId.org(p.org_id),
      event: {
        type: 'OffboardingPurgeRan',
        payload: {
          purgeId: p.id,
          orgId: p.org_id,
          userId: p.user_id,
          outcome: back ? 'cancelled' : 'done',
          chatIds: back ? [] : p.chat_ids,
          packIds: back ? [] : p.pack_ids,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(p.org_id),
    } as AppendInput);
    await ctx.store.append(events);
    if (holders.size) {
      const { syncWorkstations } = await import('../commands/packs.ts');
      await syncWorkstations(ctx, [...holders]);
    }
    ran++;
  }
  return ran;
}

/** Housekeeping the scheduler runs: due purges and old notification links. */
export async function governanceTick(ctx: Ctx): Promise<void> {
  await runDueOffboardingPurges(ctx);
  const { sweepDeskActionTokens } = await import('../push/desk-actions.ts');
  await sweepDeskActionTokens(ctx);
}
