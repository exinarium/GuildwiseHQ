import { randomUUID } from 'node:crypto';
import {
  applyMaxItems,
  type CandidatesData,
  type DigestData,
  type DigestItem,
  feedMaxItems,
  isSameStory,
  normalizeUrl,
  streamId,
} from '@aom/shared';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentActor, cardMessage, projectScope } from './common.ts';
import { deliveryEvents, type HeldItem, heldItems } from './interest-runs.ts';

/** The scout's candidates for a card: the data of its latest `scan` handoff (undefined when there was none). */
export async function scoutCandidates(
  db: Queryable,
  cardId: string,
): Promise<CandidatesData['items'] | undefined> {
  const h = await one(
    db,
    `SELECT data FROM card_handoffs WHERE card_id=$1 AND stage='scan' ORDER BY created_at DESC, event_seq DESC LIMIT 1`,
    [cardId],
  );
  if (!h) return undefined;
  const items = (h.data as { items?: CandidatesData['items'] } | null)?.items;
  return Array.isArray(items) ? items : [];
}

/** Normalized URLs already logged for the project (newest first), for the scout's brief. */
export async function seenUrls(db: Queryable, projectId: string, limit = 300): Promise<string[]> {
  return (
    await rows<{ url_normalized: string }>(
      db,
      'SELECT url_normalized FROM feed_seen WHERE project_id=$1 ORDER BY first_seen_at DESC, url_normalized LIMIT $2',
      [projectId, limit],
    )
  ).map((r) => r.url_normalized);
}

/**
 * The manager's explicit taste rules for a feed card (docs/design/restructure.md section 5.5): the rules built into the
 * card's interest. A card of no interest (old history) falls back to the rules of its project's first model
 * (`taste_seeds`, read only).
 */
export async function tasteSeedFor(
  db: Queryable,
  projectId: string,
  interestId: string | null | undefined,
): Promise<string[]> {
  if (interestId) {
    const i = await one(db, 'SELECT taste_rules FROM interests WHERE id=$1', [interestId]);
    return ((i?.taste_rules as string[] | undefined) ?? []).filter((x) => typeof x === 'string');
  }
  const r = await one(db, 'SELECT rules FROM taste_seeds WHERE project_id=$1', [projectId]);
  const rules = (r?.rules as Array<{ text: string; interestId: string | null }> | undefined) ?? [];
  return rules.filter((x) => !x.interestId).map((x) => x.text);
}

export type DigestResult =
  | { ok: true; events: AppendInput[]; summary: string }
  | { ok: false; error: string };

/**
 * Turns a curator's digest into events (docs/SPEC.md "Feed and research rules"): items must be among the scout's
 * candidates (real pages), duplicates (seen URL or the same story already listed or inside the digest) are skipped,
 * at most the card's maximum number of items (the best overall, whatever the kind) is kept in the curator's order, and a digest with nothing left logs nothing.
 * The first event is the `DigestPosted`; the rest are the desk items and the card thread note that go with it.
 */
export async function buildDigestEvents(
  tx: Queryable,
  a: { card: Row; agent: Row; project: Row; note: string; data: DigestData; now?: Date },
): Promise<DigestResult> {
  const { card, agent, project, data } = a;
  const candidates = await scoutCandidates(tx, card.id);
  if (candidates) {
    const known = new Set(candidates.map((c) => normalizeUrl(c.url)));
    const stray = data.items.filter((i) => !known.has(normalizeUrl(i.url)));
    if (stray.length > 0)
      return {
        ok: false,
        error: `digest items must come from the scout's candidates (pages that were opened); not a candidate: ${stray.map((s) => s.url).join(', ')}`,
      };
  }

  const seen = new Set(
    (
      await rows<{ url_normalized: string }>(tx, 'SELECT url_normalized FROM feed_seen WHERE project_id=$1', [
        project.id,
      ])
    ).map((r) => r.url_normalized),
  );
  const listed = await rows<{ title: string; url_normalized: string }>(
    tx,
    'SELECT title, url_normalized FROM digest_items WHERE project_id=$1 ORDER BY event_seq DESC, position DESC LIMIT 1000',
    [project.id],
  );

  // An interest that wants only some kinds of item: the others are dropped here, whatever the agents sent.
  const wantedKinds = Array.isArray(card.fields?.kinds) ? (card.fields.kinds as string[]) : null;
  const candidatesOfKind = wantedKinds ? data.items.filter((i) => wantedKinds.includes(i.kind)) : data.items;

  const accepted: typeof data.items = [];
  let duplicatesDropped = 0;
  for (const item of candidatesOfKind) {
    const norm = normalizeUrl(item.url);
    const dup =
      seen.has(norm) ||
      accepted.some((x) => normalizeUrl(x.url) === norm || isSameStory(x.title, item.title)) ||
      listed.some((l) => isSameStory(l.title, item.title));
    if (dup) duplicatesDropped++;
    else accepted.push(item);
  }

  const { kept, dropped } = applyMaxItems(accepted, feedMaxItems(card.fields));
  // The transcript reference is the runner's record on the scout's candidate, not whatever the curator wrote.
  const transcriptOf = new Map((candidates ?? []).map((c) => [normalizeUrl(c.url), c.transcript] as const));
  const items: DigestItem[] = kept.map((i) => ({
    ...i,
    ...(transcriptOf.get(normalizeUrl(i.url)) ? { transcript: transcriptOf.get(normalizeUrl(i.url)) } : {}),
    itemId: randomUUID(),
    urlNormalized: normalizeUrl(i.url),
    publishedAt: new Date(i.publishedAt).toISOString(),
  }));
  const nothingQualified = items.length === 0;
  // A card of an interest posts its items as held: they reach the desk at the interest's delivery time (or at once
  // for an interest that delivers immediately), within the organization's quiet cap.
  const interest = card.interest_id
    ? await one(tx, 'SELECT * FROM interests WHERE id=$1 AND project_id IS NOT NULL', [card.interest_id])
    : undefined;
  const viaInterest = Boolean(interest && card.interest_run_id);
  const deskItemId = nothingQualified || viaInterest ? undefined : randomUUID();
  const scope = projectScope(card.org_id, card.project_id);
  const cardStream = streamId.card(card.id);

  const events: AppendInput[] = [
    {
      streamId: cardStream,
      event: {
        type: 'DigestPosted',
        payload: {
          cardId: card.id,
          projectId: card.project_id,
          items,
          nothingQualified,
          duplicatesDropped,
          overMaximumDropped: dropped.length,
          ...(deskItemId ? { deskItemId } : {}),
          held: viaInterest,
        },
      },
      actor: agentActor(agent.id),
      scope,
    },
  ];
  let delivered = 0;
  if (viaInterest && interest) {
    events.push({
      streamId: streamId.interest(interest.id),
      event: {
        type: 'InterestRunDone',
        payload: {
          runId: card.interest_run_id,
          interestId: interest.id,
          cardId: card.id,
          kind: 'scan',
          status: nothingQualified ? 'nothing' : 'published',
          ...(candidates ? { found: candidates.length } : {}),
          published: items.length,
          duplicatesDropped,
          overMaximumDropped: dropped.length,
          itemIds: items.map((i) => i.itemId),
        },
      },
      actor: agentActor(agent.id),
      scope,
    });
    const delivery = (interest.delivery ?? { mode: 'immediate' }) as { mode: string };
    if (delivery.mode === 'immediate' && !nothingQualified) {
      const mine: HeldItem[] = items.map((i) => ({
        id: i.itemId,
        title: i.title,
        kind: i.kind,
        source: i.source,
        cardId: card.id,
      }));
      const plan = await deliveryEvents(
        tx,
        interest,
        [...(await heldItems(tx, interest.id)), ...mine],
        a.now ?? new Date(),
        'schedule',
      );
      events.push(...plan.events);
      delivered = plan.delivered;
    }
  }

  const left = [
    duplicatesDropped ? `${duplicatesDropped} duplicate(s) skipped` : '',
    dropped.length ? `${dropped.length} over the maximum number of items left out` : '',
  ].filter(Boolean);
  const heldNote =
    viaInterest && !nothingQualified && delivered < items.length ? ' Held for the next delivery.' : '';
  const summary = nothingQualified
    ? `Nothing qualified in this run; nothing was logged.${left.length ? ` (${left.join(', ')})` : ''}`
    : `Digest posted: ${items.length} new item(s) logged to the running list.${left.length ? ` (${left.join(', ')})` : ''}${heldNote}`;
  events.push(
    cardMessage(card, { kind: 'agent', agentId: agent.id }, 'system', `${summary}\n\n${a.note}`.trim()),
  );

  if (deskItemId) {
    events.push({
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'rating',
          subkind: 'digest',
          title: `Rate the ${project.name} digest (${items.length} item${items.length === 1 ? '' : 's'})`,
          body: items.map((i) => `- ${i.title} (${i.kind}, ${i.source})`).join('\n'),
          cardId: card.id,
          projectId: card.project_id,
          blocking: false,
          pinned: false,
          options: [],
          affectedCardIds: [],
          askedBy: { kind: 'agent', agentId: agent.id, role: 'curator' },
        },
      },
      actor: agentActor(agent.id),
      scope,
    });
  }

  const proposal = data.tasteRuleProposal;
  if (proposal) {
    const open = await one(
      tx,
      `SELECT 1 FROM desk_items WHERE project_id=$1 AND subkind='taste_rule' AND status='open' AND lower(body)=lower($2)`,
      [project.id, proposal.rule.trim()],
    );
    if (!open) {
      const urls = proposal.evidenceUrls.map(normalizeUrl);
      const earlier = await rows<{ id: string }>(
        tx,
        'SELECT id FROM digest_items WHERE project_id=$1 AND url_normalized = ANY($2::text[])',
        [project.id, urls],
      );
      // Evidence may be items of this very digest, or rated items of earlier ones.
      const evidence = [
        ...items.filter((i) => urls.includes(i.urlNormalized)).map((i) => ({ id: i.itemId })),
        ...earlier,
      ];
      const proposalItemId = randomUUID();
      events.push(
        {
          streamId: streamId.desk(proposalItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId: proposalItemId,
              kind: 'approval',
              subkind: 'taste_rule',
              title: `Add a taste rule for ${project.name}?`,
              body: proposal.rule.trim(),
              cardId: card.id,
              projectId: card.project_id,
              blocking: false,
              pinned: false,
              options: [],
              affectedCardIds: [],
              askedBy: { kind: 'agent', agentId: agent.id, role: 'curator' },
            },
          },
          actor: agentActor(agent.id),
          scope,
        },
        {
          streamId: streamId.desk(proposalItemId),
          event: {
            type: 'TasteRuleProposed',
            payload: {
              projectId: card.project_id,
              deskItemId: proposalItemId,
              rule: proposal.rule.trim(),
              evidenceItemIds: evidence.map((e) => e.id),
            },
          },
          actor: agentActor(agent.id),
          scope,
        },
      );
    }
  }
  return { ok: true, events, summary };
}
