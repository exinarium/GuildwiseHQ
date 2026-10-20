import { CUSTOMER_TOPICS_PER_MONTH, scrubTopic, streamId } from '@aom/shared';
import { queueBlogTopic, withdrawTopics } from '../blog/topics.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Row, rows } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { getPlatformTeam } from '../platform-team/settings.ts';
import { buildDenyList } from './topic-denylist.ts';
import { expireTopics, monthStart, noteSignals, sharingMode, syncTopicsDeskItem } from './topics.ts';

/**
 * The one-way hand-off (docs/design/ceo-blog-topics.md sections 2 and 3.2). Runs from the signal sweep (`ceo/signals.ts`), after the
 * Owner's Accept has committed. It lives outside `blog/**` because it reads organization data (the candidates and the
 * organization's names): the blog side only ever receives a scrubbed question, an area and a bucket.
 *
 * - A customer organization hands on only while "Share diagnostic data with Guildwise" is on, at most
 *   `CUSTOMER_TOPICS_PER_MONTH` a month; the platform organization needs no consent.
 * - The scrubber runs a third time here (defence in depth), with the organization's deny-list.
 * - `BlogTopicQueued` is appended on its own, by the system actor, with no causation id and no org id: the platform
 *   stream carries nothing of the Accept (the user, the org event).
 * - Turning the consent off withdraws what the writer has not taken yet.
 * - What became of a handed-on topic (published, declined, removed) is read back here, so the report can show it.
 */

const COLLECT_EVERY_MS = 5 * 60_000;

const ev = (orgId: string, type: 'CeoTopicHandedOff' | 'CeoTopicOutcome', payload: Record<string, unknown>) =>
  ({
    streamId: streamId.ceo(orgId),
    event: { type, payload: { orgId, ...payload } },
    actor: SYSTEM_ACTOR,
    scope: orgScope(orgId),
  }) as AppendInput;

/** Accepted topics go to the blog queue. */
export async function handOffTopics(ctx: Ctx): Promise<number> {
  const accepted = await rows(
    ctx.pool,
    `SELECT * FROM ceo_topic_candidates WHERE status='accepted' AND topic_id IS NOT NULL ORDER BY decided_at, id LIMIT 50`,
  );
  let n = 0;
  for (const c of accepted) {
    const mode = await sharingMode(ctx.pool, c.org_id);
    if (mode === 'off') continue; // the withdrawal pass settles these
    if (mode === 'customer') {
      const used = await one(
        ctx.pool,
        `SELECT count(*)::int AS n FROM ceo_topic_candidates WHERE org_id=$1 AND handed_off_at >= $2`,
        [c.org_id, monthStart(ctx.clock.now())],
      );
      if ((used?.n ?? 0) >= CUSTOMER_TOPICS_PER_MONTH) continue; // stays accepted until next month
    }
    const scrub = scrubTopic(
      { question: c.question ?? '', area: c.area ?? '', ...(c.audience ? { audience: c.audience } : {}) },
      { denyList: await buildDenyList(ctx.pool, c.org_id), allowTerms: c.allow_terms ?? [] },
    );
    if (!scrub.ok) {
      await ctx.store.append([
        ev(c.org_id, 'CeoTopicOutcome', {
          candidateId: c.id,
          outcome: 'blocked',
          reason: scrub.findings
            .map((f) => f.code)
            .join(', ')
            .slice(0, 300),
        }),
      ]);
      continue;
    }
    // Its own append: a system actor, no causation id, and nothing of the organization.
    const queued = await queueBlogTopic(ctx, scrub.topic, mode === 'platform' ? 'platform' : 'customer', {
      topicId: c.topic_id,
    });
    const after: AppendInput[] = [
      ev(c.org_id, 'CeoTopicHandedOff', {
        candidateId: c.id,
        topicId: queued.topicId,
        status: queued.status,
      }),
    ];
    if (queued.status === 'duplicate') {
      const cover = await one(
        ctx.pool,
        `SELECT p.slug, p.title FROM blog_topics t JOIN blog_posts p ON p.id = t.post_id WHERE t.id=$1`,
        [queued.topicId],
      );
      after.push(
        ev(c.org_id, 'CeoTopicOutcome', {
          candidateId: c.id,
          outcome: 'duplicate',
          ...(cover ? { postSlug: cover.slug, postTitle: cover.title } : {}),
        }),
      );
    }
    await ctx.store.append(after);
    n++;
  }
  return n;
}

/**
 * Consent off: topics the writer has not taken are withdrawn from the queue (`BlogTopicRejected{withdrawn}`, passing topic
 * ids only), and accepted ones that never left are dropped. `orgId` limits the pass to one organization (the command that
 * turned the consent off calls it at once); the sweep calls it for all.
 */
export async function withdrawTopicsOfOrgs(ctx: Ctx, orgId?: string): Promise<number> {
  const platform = (await getPlatformTeam(ctx.pool))?.orgId ?? null;
  const list = await rows(
    ctx.pool,
    `SELECT c.id, c.org_id, c.status, c.topic_id FROM ceo_topic_candidates c JOIN organizations o ON o.id = c.org_id
      WHERE c.status IN ('accepted','queued') AND NOT o.diagnostics_sharing AND ($1::uuid IS NULL OR c.org_id = $1)
        AND ($2::uuid IS NULL OR c.org_id <> $2)`,
    [orgId ?? null, platform],
  );
  if (!list.length) return 0;
  await withdrawTopics(
    ctx,
    list.filter((c) => c.status === 'queued' && c.topic_id).map((c) => c.topic_id as string),
  );
  await ctx.store.append(
    list.map((c) =>
      ev(c.org_id, 'CeoTopicOutcome', {
        candidateId: c.id,
        outcome: 'withdrawn',
        reason: 'sharing turned off',
      }),
    ),
  );
  return list.length;
}

/** What became of the topics in the queue, read back onto the candidate (status back: "Published from your topics"). */
export async function syncTopicOutcomes(ctx: Ctx): Promise<number> {
  const list = await rows(
    ctx.pool,
    `SELECT c.id AS candidate_id, c.org_id, t.status, t.reason, p.slug, p.title
       FROM ceo_topic_candidates c JOIN blog_topics t ON t.id = c.topic_id LEFT JOIN blog_posts p ON p.id = t.post_id
      WHERE c.status = 'queued' AND t.status IN ('published','declined','rejected','duplicate') LIMIT 100`,
  );
  if (!list.length) return 0;
  await ctx.store.append(
    list.map((r: Row) =>
      ev(r.org_id, 'CeoTopicOutcome', {
        candidateId: r.candidate_id,
        outcome: r.status,
        ...(r.status === 'published' && r.slug ? { postSlug: r.slug, postTitle: r.title } : {}),
        ...(r.reason ? { reason: String(r.reason).slice(0, 300) } : {}),
      }),
    ),
  );
  return list.length;
}

/** Notes, expiry and the desk item for the organizations whose CEO works, then the hand-off, the withdrawal and the read-back. */
export async function sweepTopics(ctx: Ctx, now = ctx.clock.now()) {
  const orgs = await rows<{ org_id: string }>(
    ctx.pool,
    `SELECT s.org_id FROM ceo_settings s JOIN organizations o ON o.id = s.org_id AND o.status IN ('trial','active')
      WHERE s.enabled AND s.agent_id IS NOT NULL`,
  );
  let noted = 0;
  for (const { org_id: orgId } of orgs) {
    if ((await sharingMode(ctx.pool, orgId)) === 'off') {
      await syncTopicsDeskItem(ctx, orgId); // resolves an item left over from before the consent was withdrawn
      continue;
    }
    const flag = await one(ctx.pool, `SELECT at FROM ceo_flags WHERE org_id=$1 AND flag='topics:collect'`, [
      orgId,
    ]);
    if (!flag || now.getTime() - new Date(flag.at).getTime() >= COLLECT_EVERY_MS) {
      await exec(
        ctx.pool,
        `INSERT INTO ceo_flags (org_id, flag, value, at) VALUES ($1,'topics:collect','1',$2)
         ON CONFLICT (org_id, flag) DO UPDATE SET at=EXCLUDED.at`,
        [orgId, now],
      );
      noted += await noteSignals(ctx, orgId, now);
      await expireTopics(ctx, orgId, now);
    }
    await syncTopicsDeskItem(ctx, orgId);
  }
  const withdrawn = await withdrawTopicsOfOrgs(ctx);
  const handedOff = await handOffTopics(ctx);
  const outcomes = await syncTopicOutcomes(ctx);
  return { noted, handedOff, withdrawn, outcomes };
}
