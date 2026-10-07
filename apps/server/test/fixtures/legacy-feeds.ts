import { randomUUID } from 'node:crypto';
import { cardRef, DomainEventSchema, streamId } from '@aom/shared';
import { resolveWorkflow } from '../../src/catalogue/loader.ts';
import type { Pool } from '../../src/db/pool.ts';
import { exec } from '../../src/db/sql.ts';
import type { PgEventStore } from '../../src/eventstore/pg-event-store.ts';

/**
 * A realistic database of the model before Part D (docs/design/restructure.md): a feed project with two interests that own
 * feed schedules, a feed schedule nobody adopted, a research-only interest, project-wide and interest-tagged taste rules,
 * scans with digests, ratings, a desk rating item, a manual feed card, transcripts, a guest on the feed project and a
 * research card. Every row is made by appending the events the old code wrote, so `restructure-2026-10` meets exactly
 * what a live installation holds, and a projection rebuild reproduces it.
 */
export interface LegacyFeeds {
  newsId: string;
  researchId: string;
  interests: { reloading: string; optics: string; powders: string };
  schedules: { reloading: string; optics: string; shotguns: string };
  cards: { reloading: string; shotguns: string; manual: string; optics: string; research: string };
  deskItemId: string;
}

const SYSTEM = { kind: 'system', id: null } as const;

export async function buildLegacyFeeds(i: {
  pool: Pool;
  store: PgEventStore;
  orgId: string;
  ownerId: string;
  /** Someone with active access to the feed project besides the Owner (a guest or a member). */
  guestId?: string;
  /** Schedule fire times (default: tomorrow 07:00 UTC). */
  nextFireAt?: string;
}): Promise<LegacyFeeds> {
  const { store, pool, orgId, ownerId } = i;
  const id = () => randomUUID();
  const newsId = id();
  const researchId = id();
  const reloading = id();
  const optics = id();
  const powders = id();
  const sRel = id();
  const sOpt = id();
  const sShot = id();
  const next = i.nextFireAt ?? new Date(Date.now() + 86_400_000).toISOString();
  const feedWf = await resolveWorkflow(pool, orgId, 'feed');
  const resWf = await resolveWorkflow(pool, orgId, 'research');
  if (!feedWf || !resWf) throw new Error('the built-in workflows are missing');
  const proj = (projectId: string) => ({ orgId, projectId, audience: 'project' }) as const;
  const append = (
    stream: string,
    event: { type: string; payload: Record<string, unknown> },
    projectId: string,
    actor: { kind: string; id: string | null } = SYSTEM,
  ) => ({
    streamId: stream,
    event: DomainEventSchema.parse(event),
    actor: actor as never,
    scope: proj(projectId) as never,
  });
  const owner = { kind: 'user', id: ownerId };

  const projectCreated = (projectId: string, key: string, name: string, workflowKey: string) =>
    append(
      streamId.project(projectId),
      {
        type: 'ProjectCreated',
        payload: {
          projectId,
          orgId,
          createdByUserId: ownerId,
          key,
          name,
          domain: 'personal',
          workflowKey,
          priorityTier: 2,
          branchPrefix: 'aom/',
          workingBranch: 'main',
          subCategories: [],
          vaultFolder: null,
        },
      },
      projectId,
      owner,
    );
  await store.append([
    projectCreated(newsId, 'NEWS', 'Firearm news', 'feed'),
    projectCreated(researchId, 'RES', 'Research', 'research'),
  ]);
  if (i.guestId)
    await store.append([
      append(
        streamId.project(newsId),
        { type: 'ProjectMemberAdded', payload: { projectId: newsId, userId: i.guestId, addedBy: ownerId } },
        newsId,
        owner,
      ),
    ]);

  const scan = { cron: '0 7 * * *', timezone: 'UTC', windowHours: 24, maxItems: 10, manual: false };
  const schedule = (
    scheduleId: string,
    name: string,
    enabled: boolean,
    interestId: string | null,
    fields: Record<string, unknown>,
  ) =>
    append(
      streamId.schedule(scheduleId),
      {
        type: 'ScheduleCreated',
        payload: {
          scheduleId,
          projectId: newsId,
          name,
          kind: 'feed',
          cron: '0 7 * * *',
          timezone: 'UTC',
          cardTemplate: { title: name, cardType: 'feed', fields },
          enabled,
          nextFireAt: enabled ? next : null,
          ...(interestId ? { interestId } : {}),
        },
      },
      newsId,
      owner,
    );
  const interest = (interestId: string, name: string, over: Record<string, unknown>) =>
    append(
      streamId.interest(interestId),
      {
        type: 'InterestCreated',
        payload: {
          interestId,
          orgId,
          name,
          description: `${name}: what the manager wants`,
          subCategory: null,
          preferredSites: [],
          creatorRank: 4,
          feedProjectId: newsId,
          researchProjectId: null,
          scan,
          status: 'active',
          scheduleId: null,
          ...over,
        },
      },
      newsId,
      owner,
    );
  await store.append([
    schedule(sRel, 'Reloading', true, reloading, {
      topic: 'Reloading',
      description: 'Powders and bullets',
      windowHours: 24,
      maxItems: 5,
    }),
    schedule(sOpt, 'Optics', false, optics, { topic: 'Optics', windowHours: 24, maxItems: 8 }),
    // a plain schedule nobody adopted, with the older per-kind maximum
    schedule(sShot, 'Shotgun news', true, null, {
      topic: 'Shotguns',
      description: 'Waterfowl loads only',
      windowHours: 48,
      maxPerKind: { article: 4, video: 2 },
      preferredSites: ['https://shotguns.example.test'],
    }),
    interest(reloading, 'Reloading', {
      subCategory: 'shooting/reloading',
      preferredSites: ['https://reloading.example.test'],
      researchProjectId: researchId,
      scheduleId: sRel,
      scan: { ...scan, maxItems: 5 },
    }),
    interest(optics, 'Optics', { scheduleId: sOpt, status: 'paused', scan: { ...scan, maxItems: 8 } }),
    append(
      streamId.interest(powders),
      {
        type: 'InterestCreated',
        payload: {
          interestId: powders,
          orgId,
          name: 'Powders',
          description: 'Research only',
          subCategory: 'shooting/powders',
          preferredSites: [],
          creatorRank: 4,
          feedProjectId: null,
          researchProjectId: researchId,
          scan: null,
          status: 'active',
          scheduleId: null,
        },
      },
      researchId,
      owner,
    ),
    append(
      streamId.project(newsId),
      {
        type: 'TasteSeedSet',
        payload: {
          projectId: newsId,
          version: 3,
          rules: [
            { text: 'Prefer primary sources', interestId: null },
            { text: 'Skip beginner tutorials', interestId: reloading },
            { text: 'Skip optics reviews of one product', interestId: optics },
          ],
        },
      },
      newsId,
      owner,
    ),
  ]);

  let number = 0;
  const card = (
    cardId: string,
    wf: { id: string },
    projectId: string,
    key: string,
    cardType: string,
    over: Record<string, unknown>,
  ) => {
    number++;
    return append(
      streamId.card(cardId),
      {
        type: 'CardCreated',
        payload: {
          cardId,
          projectId,
          number,
          ref: cardRef(key, number),
          title: `${cardType} ${number}`,
          cardType,
          workflowVersionId: wf.id,
          stage: cardType === 'research' ? 'research' : 'scan',
          status: 'queued',
          fields: { topic: 'x' },
          ownerUserId: ownerId,
          origin: 'schedule',
          scheduled: true,
          ...over,
        },
      },
      projectId,
      SYSTEM,
    );
  };
  const cRel = id();
  const cShot = id();
  const cMan = id();
  const cOpt = id();
  const cRes = id();
  const deskItemId = id();
  const item = (n: number, kind = 'article') => ({
    itemId: id(),
    kind,
    url: `https://news.example.test/legacy-${n}`,
    urlNormalized: `news.example.test/legacy-${n}`,
    title: `Legacy story number ${n} about reloading`,
    source: 'News Example',
    publishedAt: '2026-10-01T00:00:00.000Z',
    summary: `Summary of legacy story ${n}`,
    ...(kind === 'video'
      ? { transcript: { status: 'ok', path: 'projects/news/transcripts/2026-10-01-legacy.md', chars: 40 } }
      : {}),
  });
  const a1 = item(1);
  const a2 = item(2);
  const v3 = item(3, 'video');
  const b1 = item(4);
  const b2 = item(5);
  const digest = (cardId: string, items: unknown[], withDesk: boolean) =>
    append(
      streamId.card(cardId),
      {
        type: 'DigestPosted',
        payload: {
          cardId,
          projectId: newsId,
          items,
          nothingQualified: items.length === 0,
          duplicatesDropped: 0,
          overMaximumDropped: 0,
          ...(withDesk && items.length ? { deskItemId } : {}),
        },
      },
      newsId,
      SYSTEM,
    );
  await store.append([
    card(cRel, feedWf, newsId, 'NEWS', 'feed', { scheduleId: sRel, interestId: reloading }),
    card(cShot, feedWf, newsId, 'NEWS', 'feed', { scheduleId: sShot }),
    card(cMan, feedWf, newsId, 'NEWS', 'feed', { origin: 'manual', scheduled: false }),
    card(cOpt, feedWf, newsId, 'NEWS', 'feed', { scheduleId: sOpt, interestId: optics }),
    card(cRes, resWf, researchId, 'RES', 'research', {
      origin: 'manual',
      scheduled: false,
      interestId: reloading,
      fields: { question: 'q' },
    }),
    append(
      streamId.desk(deskItemId),
      {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'rating',
          subkind: 'digest',
          title: 'Rate the Firearm news digest (3 items)',
          body: '- a\n- b\n- c',
          cardId: cRel,
          projectId: newsId,
        },
      },
      newsId,
      SYSTEM,
    ),
    digest(cRel, [a1, a2, v3], true),
    digest(cShot, [b1, b2], false),
    digest(cOpt, [], false),
  ]);
  await store.append([
    ...[
      [a1.itemId, 'useful', 'Has load data'],
      [a2.itemId, 'irrelevant', 'Not about reloading'],
      [b1.itemId, 'boring', undefined],
    ].map(([itemId, verdict, reason]) =>
      append(
        streamId.card(cRel),
        {
          type: 'ItemRated',
          payload: { itemId, projectId: newsId, verdict, ...(reason ? { reason } : {}), ratedBy: ownerId },
        },
        newsId,
        owner,
      ),
    ),
  ]);
  for (const [n, url] of [
    [1, v3.url],
    [2, 'https://video.example.test/legacy-extra'],
  ] as const)
    await exec(
      pool,
      `INSERT INTO transcripts (project_id, url_normalized, url, title, language, auto_generated, vault_path, chars, truncated, text, created_at)
       VALUES ($1,$2,$3,$4,'en',true,$5,12,false,$6,now())`,
      [
        newsId,
        url.replace('https://', ''),
        url,
        `Talk ${n}`,
        `projects/news/transcripts/legacy-${n}.md`,
        `Transcript text ${n}`,
      ],
    );
  return {
    newsId,
    researchId,
    interests: { reloading, optics, powders },
    schedules: { reloading: sRel, optics: sOpt, shotguns: sShot },
    cards: { reloading: cRel, shotguns: cShot, manual: cMan, optics: cOpt, research: cRes },
    deskItemId,
  };
}
