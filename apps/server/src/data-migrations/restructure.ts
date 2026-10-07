import { randomUUID } from 'node:crypto';
import {
  ALL_INTEREST_KINDS,
  type DeliverySpec,
  defaultWindowHours,
  type FeedVerdict,
  feedMaxItems,
  IMMEDIATE_DELIVERY,
  INTEREST_DOC_FILE,
  INTEREST_SECTION_ID,
  type InterestAgents,
  type InterestBody,
  interestBackingKey,
  interestSlug,
  interestVaultDir,
  projectVaultFolder,
  renderInterestDoc,
  renderTasteEntry,
  renderTasteSeedSection,
  type ScanSpec,
  streamId,
  TASTE_FILE,
  TASTE_HEADER,
  TASTE_SEED_SECTION_ID,
} from '@aom/shared';
import { rankInOrg } from '../auth/org-context.ts';
import { orgScope, projectScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import { chooseVaultWriteTarget } from '../commands/vaults.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `restructure-2026-10` (docs/design/restructure.md section 5.4 and the owner decisions): every feed project becomes the
 * backing project of an interest. One-off, idempotent and rebuild-safe: it appends events (`ProjectKindChanged`,
 * `InterestCreated` / `InterestUpdated`, `InterestMigrated`, `InterestTasteSet`, `ScheduleDeleted`), so a projection
 * rebuild reproduces its result. Each organization runs in its own transaction; a feed project that is already an
 * interest is skipped, so a crash or a second run changes nothing more.
 */
export const RESTRUCTURE_MIGRATION = 'restructure-2026-10';
const LOCK_ID = 7331;

export interface RestructureProjectPlan {
  key: string;
  name: string;
  status: string;
  domain: string;
  /** Interests that point at it (the first becomes its own backing project, the others get new ones). */
  interests: string[];
  /** Feed schedules that no interest owns: each becomes an interest. */
  unlinkedSchedules: string[];
  /** Feed schedules that are removed (every feed schedule of the project). */
  schedulesToRemove: number;
  cards: number;
  digestItems: number;
  ratedItems: number;
  transcripts: number;
  members: number;
  /** Where its vault folder moves. */
  folder: { from: string; to: string; vault: boolean };
}
export interface RestructurePlan {
  alreadyDone: boolean;
  orgs: Array<{ orgId: string; name: string; projects: RestructureProjectPlan[]; researchOnly: string[] }>;
}
export interface RestructureOrgReport {
  orgId: string;
  feedProjects: number;
  interests: number;
  newProjects: number;
  schedulesRemoved: number;
  transcriptsCopied: number;
  vaultMoves: number;
  warnings: string[];
}
export interface RestructureReport {
  dryRun: boolean;
  plan: RestructurePlan;
  orgs: RestructureOrgReport[];
}

const feedProjects = (db: Queryable, orgId: string) =>
  rows(
    db,
    `SELECT * FROM projects WHERE org_id=$1 AND workflow_key='feed' AND kind='project' ORDER BY created_at, id`,
    [orgId],
  );

const researchOnlyInterests = (db: Queryable, orgId: string) =>
  rows(
    db,
    `SELECT * FROM interests WHERE org_id=$1 AND project_id IS NULL AND legacy_feed_project_id IS NULL
        AND legacy_research_project_id IS NOT NULL ORDER BY created_at, id`,
    [orgId],
  );

async function hasInterestSchema(db: Queryable): Promise<boolean> {
  return Boolean((await one<{ t: string | null }>(db, `SELECT to_regclass('interest_runs') AS t`))?.t);
}

/** What the migration would do, read only (the `--dry-run` of the CLI). */
export async function planRestructure(db: Queryable): Promise<RestructurePlan> {
  if (!(await hasInterestSchema(db))) return { alreadyDone: false, orgs: [] };
  const done = await one(db, 'SELECT 1 FROM data_migrations WHERE name=$1', [RESTRUCTURE_MIGRATION]);
  const orgs: RestructurePlan['orgs'] = [];
  for (const o of await rows(db, 'SELECT id, name FROM organizations ORDER BY created_at, id')) {
    const projects: RestructureProjectPlan[] = [];
    const taken = new Set<string>(
      (
        await rows<{ slug: string }>(db, 'SELECT slug FROM interests WHERE org_id=$1 AND slug IS NOT NULL', [
          o.id,
        ])
      ).map((r) => r.slug),
    );
    for (const p of await feedProjects(db, o.id)) {
      const interests = await rows(
        db,
        'SELECT name FROM interests WHERE legacy_feed_project_id=$1 AND project_id IS NULL ORDER BY created_at, id',
        [p.id],
      );
      const unlinked = await rows(
        db,
        `SELECT name, card_template FROM schedules WHERE project_id=$1 AND kind='feed' AND interest_id IS NULL ORDER BY created_at, id`,
        [p.id],
      );
      const count = async (sql: string) => Number((await one<{ n: string }>(db, sql, [p.id]))?.n ?? 0);
      const first =
        interests[0]?.name ?? unlinked[0]?.card_template?.fields?.topic ?? unlinked[0]?.name ?? p.name;
      const slug = interestSlug(String(first), taken);
      taken.add(slug);
      const vault = await projectVaultTarget(db, p);
      projects.push({
        key: p.key,
        name: p.name,
        status: p.status,
        domain: p.domain,
        interests: interests.map((i) => i.name),
        unlinkedSchedules: unlinked.map((s) => s.name),
        schedulesToRemove: await count(
          `SELECT count(*) AS n FROM schedules WHERE project_id=$1 AND kind='feed'`,
        ),
        cards: await count(`SELECT count(*) AS n FROM cards WHERE project_id=$1 AND card_type='feed'`),
        digestItems: await count(`SELECT count(*) AS n FROM digest_items WHERE project_id=$1`),
        ratedItems: await count(
          `SELECT count(*) AS n FROM digest_items WHERE project_id=$1 AND verdict IS NOT NULL`,
        ),
        transcripts: await count(`SELECT count(*) AS n FROM transcripts WHERE project_id=$1`),
        members: await count(
          `SELECT count(*) AS n FROM project_members WHERE project_id=$1 AND status='active'`,
        ),
        folder: { from: vault.folder, to: interestVaultDir(slug), vault: vault.vaultId !== undefined },
      });
    }
    const ro = await researchOnlyInterests(db, o.id);
    if (projects.length || ro.length)
      orgs.push({ orgId: o.id, name: o.name, projects, researchOnly: ro.map((i) => i.name) });
  }
  return { alreadyDone: Boolean(done), orgs };
}

export function formatRestructurePlan(r: RestructurePlan): string {
  const lines = [
    r.alreadyDone ? `${RESTRUCTURE_MIGRATION} has already run.` : `${RESTRUCTURE_MIGRATION} has not run yet.`,
  ];
  if (r.orgs.length === 0) lines.push('No feed project and no research-only interest to migrate.');
  for (const o of r.orgs) {
    lines.push(`Organization ${o.name} (${o.orgId}):`);
    for (const p of o.projects) {
      lines.push(
        `  feed project ${p.key} "${p.name}" (${p.status}, ${p.domain}): ${p.cards} feed cards, ${p.digestItems} items (${p.ratedItems} rated), ${p.transcripts} transcripts, ${p.members} members`,
      );
      lines.push(
        `    becomes the backing project of its first interest; folder ${p.folder.from} -> ${p.folder.to}${p.folder.vault ? '' : ' (no vault registered: nothing to move)'}`,
      );
      for (const [n, name] of p.interests.entries())
        lines.push(
          `    interest "${name}"${n === 0 ? ' (first: keeps this project)' : ' (gets a new backing project)'}`,
        );
      for (const name of p.unlinkedSchedules) lines.push(`    feed schedule "${name}" becomes an interest`);
      if (p.interests.length === 0 && p.unlinkedSchedules.length === 0)
        lines.push(
          '    no interest and no feed schedule: one paused, manual interest named after the project',
        );
      lines.push(
        `    ${p.schedulesToRemove} feed schedule(s) are removed (their history stays on the cards)`,
      );
    }
    for (const name of o.researchOnly)
      lines.push(`  research-only interest "${name}" gets a backing project`);
  }
  return lines.join('\n');
}

/** The vault a project's files are in, and its current folder (`projects/<folder>`). */
async function projectVaultTarget(
  db: Queryable,
  p: Row,
): Promise<{ vaultId: string | undefined; row?: Row; folder: string }> {
  const vault =
    (await one(db, 'SELECT id, org_id, project_id FROM vaults WHERE project_id=$1', [p.id])) ??
    (await one(
      db,
      'SELECT id, org_id, project_id FROM vaults WHERE org_id=$1 AND kind=$2 AND project_id IS NULL',
      [p.org_id, p.domain],
    ));
  return {
    vaultId: vault?.id as string | undefined,
    ...(vault ? { row: vault } : {}),
    folder: projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir }),
  };
}

interface Source {
  existing?: Row;
  schedule?: Row;
  name: string;
  description: string;
  subCategory: string | null;
  preferredSites: string[];
  scan: ScanSpec;
  status: 'active' | 'paused';
  nextScanAt: string | null;
  createdBy: string | null;
  createdByRank: number | null;
  /** The interest id (existing, or minted now). */
  id: string;
}

const MANUAL_SCAN: ScanSpec = {
  cron: '0 7 * * *',
  timezone: 'UTC',
  windowHours: 24,
  maxItems: 10,
  manual: true,
};

/** A unique name in the organization: `name`, `name (2)` ... (names are unique per organization, ignoring case). */
function uniqueName(taken: Set<string>, base: string): string {
  const clean = base.trim().slice(0, 110) || 'Interest';
  let candidate = clean;
  for (let n = 2; n < 500 && taken.has(candidate.toLowerCase()); n++) candidate = `${clean} (${n})`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

interface OrgCtx {
  env: DataMigrationEnv;
  orgId: string;
  ownerId: string;
  slugs: Set<string>;
  keys: Set<string>;
  names: Set<string>;
  report: RestructureOrgReport;
  events: AppendInput[];
  /** Vault commands, queued after the events in the order given. */
  vaultMoves: Array<{ row: Row; from: string; to: string }>;
  /** Operational rows (not projections) to copy once the events created the new projects. */
  transcriptCopies: Array<{ from: string; to: string }>;
  vaultWrites: Array<{
    row: Row;
    path: string;
    mode: 'section';
    section: { id: string; version: number };
    content: string;
    header: string;
    commitMessage: string;
  }>;
}

function fileWrite(
  c: OrgCtx,
  vault: Row | undefined,
  folder: string,
  file: string,
  sectionId: string,
  version: number,
  content: string,
  header: string,
  commitMessage: string,
): void {
  if (!vault) return;
  c.vaultWrites.push({
    row: vault,
    path: `${folder}/${file}`,
    mode: 'section',
    section: { id: sectionId, version },
    content,
    header,
    commitMessage,
  });
}

async function migrateFeedProject(tx: Queryable, c: OrgCtx, p: Row): Promise<void> {
  const { orgId } = c;
  const archived = p.status !== 'active';
  const vault = await projectVaultTarget(tx, p);
  const members = await rows(
    tx,
    `SELECT pm.user_id, pm.role, pm.org_grant FROM project_members pm
      WHERE pm.project_id=$1 AND pm.status='active' AND pm.direct`,
    [p.id],
  );
  const extraMembers = members
    .filter((m) => !m.org_grant)
    .map((m) => ({
      userId: m.user_id as string,
      role: (m.role === 'owner' ? 'owner' : 'manager') as 'owner' | 'manager',
    }));
  const seed = await one(tx, 'SELECT version, rules FROM taste_seeds WHERE project_id=$1', [p.id]);
  const seedRules = (
    (seed?.rules as Array<{ text: string; interestId: string | null }> | undefined) ?? []
  ).filter((r) => r.text?.trim());
  const seedVersion = Number(seed?.version ?? 0);
  const agents = await rows(
    tx,
    `SELECT id, role_key FROM agents WHERE org_id=$1 AND status <> 'retired' AND $2::uuid = ANY(focus_project_ids)`,
    [orgId, p.id],
  );
  const pick = (role: string): string | undefined => {
    const m = agents.filter((a) => a.role_key === role);
    return m.length === 1 ? (m[0]?.id as string) : undefined;
  };
  const prefer: InterestAgents = {
    ...(pick('scout') ? { scout: pick('scout') as string } : {}),
    ...(pick('curator') ? { curator: pick('curator') as string } : {}),
  };
  const creator = (p.created_by as string | null) ?? c.ownerId;
  const creatorRank = (await rankInOrg(tx, creator, orgId)) || 4;

  // 1. The sources, in order: the interests that point at the project, its unlinked feed schedules, else a paused one.
  const sources: Source[] = [];
  const linked = await rows(
    tx,
    'SELECT * FROM interests WHERE legacy_feed_project_id=$1 AND project_id IS NULL ORDER BY created_at, id',
    [p.id],
  );
  for (const i of linked) {
    const schedule = i.legacy_schedule_id
      ? await one(tx, 'SELECT * FROM schedules WHERE id=$1', [i.legacy_schedule_id])
      : undefined;
    sources.push({
      existing: i,
      ...(schedule ? { schedule } : {}),
      name: i.name,
      description: i.description ?? '',
      subCategory: i.sub_category ?? null,
      preferredSites: i.preferred_sites ?? [],
      scan: (i.scan as ScanSpec | null) ?? MANUAL_SCAN,
      status: i.status,
      nextScanAt:
        schedule?.enabled && schedule.next_fire_at && i.status === 'active'
          ? new Date(schedule.next_fire_at).toISOString()
          : null,
      createdBy: i.created_by ?? null,
      createdByRank: i.created_by_rank ?? null,
      id: i.id,
    });
  }
  const unlinked = await rows(
    tx,
    `SELECT * FROM schedules WHERE project_id=$1 AND kind='feed' AND interest_id IS NULL ORDER BY created_at, id`,
    [p.id],
  );
  for (const s of unlinked) {
    const fields = ((s.card_template as { fields?: Record<string, unknown> } | null)?.fields ?? {}) as Record<
      string,
      unknown
    >;
    const topic = typeof fields.topic === 'string' && fields.topic.trim() ? fields.topic : undefined;
    const sites = Array.isArray(fields.preferredSites)
      ? (fields.preferredSites as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const windowHours =
      typeof fields.windowHours === 'number' && fields.windowHours >= 1
        ? Math.min(720, Math.floor(fields.windowHours))
        : defaultWindowHours(s.cron ?? '0 7 * * *');
    const scan: ScanSpec = {
      cron: s.cron ?? '0 7 * * *',
      timezone: s.timezone ?? 'UTC',
      windowHours,
      maxItems: Math.min(100, feedMaxItems(fields)),
      manual: false,
    };
    sources.push({
      schedule: s,
      name: uniqueName(c.names, topic ?? s.name),
      description: typeof fields.description === 'string' ? fields.description : '',
      subCategory:
        typeof fields.subCategory === 'string' && fields.subCategory.trim() ? fields.subCategory : null,
      preferredSites: sites,
      scan,
      status: s.enabled ? 'active' : 'paused',
      nextScanAt: s.enabled && s.next_fire_at ? new Date(s.next_fire_at).toISOString() : null,
      createdBy: s.owner_user_id ?? p.created_by ?? null,
      createdByRank: null,
      id: randomUUID(),
    });
  }
  if (sources.length === 0)
    sources.push({
      name: uniqueName(c.names, p.name),
      description: '',
      subCategory: null,
      preferredSites: [],
      scan: MANUAL_SCAN,
      status: 'paused',
      nextScanAt: null,
      createdBy: p.created_by ?? null,
      createdByRank: null,
      id: randomUUID(),
    });
  for (const s of sources.filter((x) => x.existing)) c.names.add(s.name.toLowerCase());

  // 2. A slug and a backing project for each. The first keeps the feed project itself.
  const plans = sources.map((s, n) => {
    const slug = interestSlug(s.name, c.slugs);
    c.slugs.add(slug);
    let projectId = p.id as string;
    let key = p.key as string;
    if (n > 0) {
      projectId = randomUUID();
      key = interestBackingKey(slug, c.keys);
      c.keys.add(key);
    }
    return { s, slug, projectId, key, n };
  });

  const created: AppendInput[] = [];
  const bodies: AppendInput[] = [];
  const migrated: AppendInput[] = [];
  const first = plans[0];
  for (const { s, slug, projectId, n } of plans) {
    if (n > 0) {
      created.push({
        streamId: streamId.project(projectId),
        event: {
          type: 'ProjectCreated',
          payload: {
            projectId,
            orgId,
            createdByUserId: c.ownerId,
            key: plans[n]?.key as string,
            name: s.name,
            domain: p.domain,
            workflowKey: 'feed',
            priorityTier: 2,
            branchPrefix: 'aom/',
            workingBranch: 'main',
            subCategories: [],
            vaultFolder: null,
            kind: 'interest',
            vaultDir: interestVaultDir(slug),
            ...(extraMembers.length ? { members: extraMembers } : {}),
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(orgId, projectId),
      });
      if (archived)
        created.push({
          streamId: streamId.project(projectId),
          event: { type: 'ProjectArchived', payload: { projectId } },
          actor: SYSTEM_ACTOR,
          scope: projectScope(orgId, projectId),
        });
      c.report.newProjects++;
    }
    const body: InterestBody = {
      interestId: s.id,
      orgId,
      ...(s.createdByRank
        ? { creatorRank: s.createdByRank as 1 | 2 | 3 | 4 }
        : { creatorRank: (s.existing ? 2 : creatorRank) as 1 | 2 | 3 | 4 }),
      name: s.name,
      description: s.description,
      subCategory: s.subCategory,
      preferredSites: s.preferredSites,
      scan: s.scan,
      status: s.status,
      projectId,
      slug,
      domain: p.domain,
      kinds: [...ALL_INTEREST_KINDS],
      agents: prefer,
      delivery: IMMEDIATE_DELIVERY as DeliverySpec,
      nextScanAt: s.nextScanAt,
      nextDeliveryAt: null,
    };
    const scope = projectScope(orgId, projectId);
    bodies.push({
      streamId: streamId.interest(s.id),
      event: { type: s.existing ? 'InterestUpdated' : 'InterestCreated', payload: body },
      actor: s.existing ? SYSTEM_ACTOR : userActor(s.createdBy ?? creator),
      scope,
    });
    // Taste: the project-wide rules plus the rules tagged with this interest, mirrored to taste.md (its section version is
    // above the one already in the file, so the runner replaces the old block).
    const rules = [
      ...seedRules.filter((r) => !r.interestId).map((r) => r.text),
      ...seedRules.filter((r) => r.interestId === s.id).map((r) => r.text),
    ].map((t) => t.replace(/\s+/g, ' ').trim());
    const dedup = [...new Set(rules.filter(Boolean))];
    if (dedup.length > 0 || seedVersion > 0)
      bodies.push({
        streamId: streamId.interest(s.id),
        event: {
          type: 'InterestTasteSet',
          payload: { interestId: s.id, version: seedVersion + 1, rules: dedup },
        },
        actor: SYSTEM_ACTOR,
        scope,
      });
    if (archived)
      bodies.push({
        streamId: streamId.interest(s.id),
        event: { type: 'InterestArchived', payload: { interestId: s.id, by: c.ownerId } },
        actor: SYSTEM_ACTOR,
        scope,
      });
    migrated.push({
      streamId: streamId.interest(s.id),
      event: {
        type: 'InterestMigrated',
        payload: {
          interestId: s.id,
          projectId,
          slug,
          domain: p.domain,
          fromFeedProjectId: p.id,
          ...(s.schedule ? { fromScheduleId: s.schedule.id } : {}),
          cardFilter:
            n === 0
              ? {
                  projectId: p.id,
                  ...(s.schedule ? { scheduleId: s.schedule.id } : {}),
                  untaggedFeedCards: true,
                }
              : {
                  projectId: p.id,
                  ...(s.schedule ? { scheduleId: s.schedule.id } : {}),
                  untaggedFeedCards: false,
                },
          ...(n > 0 ? { copySeenFrom: p.id } : {}),
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    });
    c.report.interests++;

    // Vault files: INTEREST.md and the taste section of every interest; the history of the old project-wide ratings
    // (the taste the interest ran under) goes into the `imported` section of a new folder.
    const folder = interestVaultDir(slug);
    fileWrite(
      c,
      vault.row,
      folder,
      INTEREST_DOC_FILE,
      INTEREST_SECTION_ID,
      1,
      renderInterestDoc({ ...body, agents: {} }),
      '',
      `aom: interest ${s.name}`.slice(0, 100),
    );
    if (dedup.length > 0 || seedVersion > 0)
      fileWrite(
        c,
        vault.row,
        folder,
        TASTE_FILE,
        TASTE_SEED_SECTION_ID,
        seedVersion + 1,
        renderTasteSeedSection(dedup.map((text) => ({ text, interestId: null }))),
        TASTE_HEADER,
        `aom: taste rules v${seedVersion + 1}`,
      );
    if (n > 0) {
      const rated = await rows(
        tx,
        `SELECT kind, title, source, url, verdict, verdict_reason FROM digest_items
          WHERE project_id=$1 AND verdict IS NOT NULL ORDER BY rated_at, event_seq, position`,
        [p.id],
      );
      if (rated.length)
        fileWrite(
          c,
          vault.row,
          folder,
          TASTE_FILE,
          'imported',
          1,
          [
            '## Earlier ratings (imported)',
            '',
            ...rated.map((r) =>
              renderTasteEntry({
                verdict: r.verdict as FeedVerdict,
                kind: r.kind,
                title: r.title,
                source: r.source,
                url: r.url,
                reason: r.verdict_reason,
              }).trimEnd(),
            ),
          ].join('\n'),
          TASTE_HEADER,
          'aom: imported ratings',
        );
    }
  }

  // 3. The project itself: it is hidden from now on, keeps its key, cards, history and transcripts; the first interest
  // moves its vault folder to interests/<slug>/. A new folder for the others.
  const firstPlan = first as NonNullable<typeof first>;
  const kindChanged: AppendInput[] = [
    {
      streamId: streamId.project(p.id),
      event: {
        type: 'ProjectKindChanged',
        payload: {
          projectId: p.id,
          kind: 'interest',
          interestId: firstPlan.s.id,
          vaultDir: interestVaultDir(firstPlan.slug),
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(orgId, p.id),
    },
    {
      streamId: streamId.project(p.id),
      event: { type: 'ProjectUpdated', payload: { projectId: p.id, changes: { name: firstPlan.s.name } } },
      actor: SYSTEM_ACTOR,
      scope: projectScope(orgId, p.id),
    },
  ];
  // 4. The feed schedules go (events keep them); non-feed schedules of the project stay with a warning.
  const feedSchedules = await rows(tx, `SELECT * FROM schedules WHERE project_id=$1 AND kind='feed'`, [p.id]);
  const removed: AppendInput[] = feedSchedules.map((s) => ({
    streamId: streamId.schedule(s.id),
    event: { type: 'ScheduleDeleted', payload: { scheduleId: s.id } },
    actor: SYSTEM_ACTOR,
    scope: projectScope(orgId, p.id),
  }));
  c.report.schedulesRemoved += feedSchedules.length;
  const others = await one<{ n: string }>(
    tx,
    `SELECT count(*) AS n FROM schedules WHERE project_id=$1 AND kind <> 'feed'`,
    [p.id],
  );
  if (Number(others?.n ?? 0) > 0)
    c.report.warnings.push(
      `${p.key}: ${others?.n} schedule(s) that are not feeds stay on a project that is now an interest`,
    );

  // The first interest's InterestMigrated goes last so the cards of the other interests' schedules are claimed first.
  const orderedMigrated = [...migrated.slice(1), migrated[0] as AppendInput];
  c.events.push(...created, ...kindChanged, ...bodies, ...removed, ...orderedMigrated);
  c.report.feedProjects++;

  // The vault: the folder of the first interest is moved (history kept), the writes follow.
  if (vault.row && vault.vaultId) {
    c.vaultMoves.push({ row: vault.row, from: vault.folder, to: interestVaultDir(firstPlan.slug) });
    c.report.vaultMoves++;
  } else
    c.report.warnings.push(
      `${p.key}: no vault is registered for it, so no folder was moved and no file written`,
    );

  // Operational copies (not projections): the transcripts of the project go to the new backing projects too.
  for (const pl of plans.slice(1)) c.transcriptCopies.push({ from: p.id, to: pl.projectId });
}

async function migrateResearchOnly(tx: Queryable, c: OrgCtx, i: Row): Promise<void> {
  const { orgId } = c;
  const r = await one(tx, 'SELECT * FROM projects WHERE id=$1', [i.legacy_research_project_id]);
  if (!r) {
    c.report.warnings.push(`research-only interest "${i.name}" lost its research project`);
    return;
  }
  const slug = interestSlug(i.name, c.slugs);
  c.slugs.add(slug);
  const projectId = randomUUID();
  const key = interestBackingKey(slug, c.keys);
  c.keys.add(key);
  const members = await rows(
    tx,
    `SELECT pm.user_id, pm.role, pm.org_grant FROM project_members pm WHERE pm.project_id=$1 AND pm.status='active' AND pm.direct`,
    [r.id],
  );
  const extra = members
    .filter((m) => !m.org_grant)
    .map((m) => ({
      userId: m.user_id as string,
      role: (m.role === 'owner' ? 'owner' : 'manager') as 'owner' | 'manager',
    }));
  const scope = projectScope(orgId, projectId);
  const body: InterestBody = {
    interestId: i.id,
    orgId,
    ...(i.created_by_rank ? { creatorRank: i.created_by_rank as 1 | 2 | 3 | 4 } : {}),
    name: i.name,
    description: i.description ?? '',
    subCategory: i.sub_category ?? null,
    preferredSites: i.preferred_sites ?? [],
    scan: MANUAL_SCAN,
    status: i.status,
    projectId,
    slug,
    domain: r.domain,
    kinds: [...ALL_INTEREST_KINDS],
    agents: {},
    delivery: IMMEDIATE_DELIVERY as DeliverySpec,
    nextScanAt: null,
    nextDeliveryAt: null,
  };
  c.events.push(
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'ProjectCreated',
        payload: {
          projectId,
          orgId,
          createdByUserId: c.ownerId,
          key,
          name: i.name,
          domain: r.domain,
          workflowKey: 'feed',
          priorityTier: 2,
          branchPrefix: 'aom/',
          workingBranch: 'main',
          subCategories: [],
          vaultFolder: null,
          kind: 'interest',
          vaultDir: interestVaultDir(slug),
          ...(extra.length ? { members: extra } : {}),
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
    {
      streamId: streamId.interest(i.id),
      event: { type: 'InterestUpdated', payload: body },
      actor: SYSTEM_ACTOR,
      scope,
    },
    {
      streamId: streamId.interest(i.id),
      event: {
        type: 'InterestMigrated',
        payload: {
          interestId: i.id,
          projectId,
          slug,
          domain: r.domain,
          cardFilter: { projectId: null, untaggedFeedCards: false },
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    },
  );
  c.report.newProjects++;
  c.report.interests++;
}

/**
 * Runs the migration (or, with `dryRun`, only reports what it would do). Safe to run again: a feed project that is
 * already an interest is skipped, and the completion is recorded in `data_migrations`.
 */
export async function migrateRestructure(
  env: DataMigrationEnv,
  opts: { dryRun?: boolean } = {},
): Promise<RestructureReport> {
  const { pool, store, log } = env;
  const plan = await planRestructure(pool);
  if (opts.dryRun || !(await hasInterestSchema(pool))) return { dryRun: true, plan, orgs: [] };

  const lock = await pool.connect();
  const reports: RestructureOrgReport[] = [];
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    for (const o of plan.orgs) {
      const report: RestructureOrgReport = {
        orgId: o.orgId,
        feedProjects: 0,
        interests: 0,
        newProjects: 0,
        schedulesRemoved: 0,
        transcriptsCopied: 0,
        vaultMoves: 0,
        warnings: [],
      };
      try {
        await withAppendTx(pool, async (tx) => {
          const org = await one(tx, 'SELECT id, owner_user_id FROM organizations WHERE id=$1', [o.orgId]);
          if (!org) return;
          const c: OrgCtx = {
            env,
            orgId: o.orgId,
            ownerId: org.owner_user_id,
            slugs: new Set(
              (
                await rows<{ slug: string }>(
                  tx,
                  'SELECT slug FROM interests WHERE org_id=$1 AND slug IS NOT NULL',
                  [o.orgId],
                )
              ).map((r) => r.slug),
            ),
            keys: new Set(
              (await rows<{ key: string }>(tx, 'SELECT key FROM projects WHERE org_id=$1', [o.orgId])).map(
                (r) => r.key.toUpperCase(),
              ),
            ),
            names: new Set(
              (await rows<{ name: string }>(tx, 'SELECT name FROM interests WHERE org_id=$1', [o.orgId])).map(
                (r) => r.name.toLowerCase(),
              ),
            ),
            report,
            events: [],
            vaultMoves: [],
            transcriptCopies: [],
            vaultWrites: [],
          };
          for (const p of await feedProjects(tx, o.orgId)) await migrateFeedProject(tx, c, p);
          for (const i of await researchOnlyInterests(tx, o.orgId)) await migrateResearchOnly(tx, c, i);
          if (c.events.length === 0) return;
          // The desk report: one alert for the Owner (and the Admins) naming what changed.
          const deskItemId = randomUUID();
          const lines = [
            `${report.feedProjects} feed project${report.feedProjects === 1 ? '' : 's'} became ${report.interests} interest${report.interests === 1 ? '' : 's'}.`,
            'Interests are organization-wide now, and their projects are hidden. The Interests page (under Knowledge) holds them with their run log, run schedule, delivery schedule and taste rules.',
            report.schedulesRemoved
              ? `${report.schedulesRemoved} feed schedule${report.schedulesRemoved === 1 ? '' : 's'} were removed: each lives on as the run schedule of its interest. Their history stays on the cards.`
              : '',
            report.vaultMoves ? `Vault folders moved to interests/<name>/ (${report.vaultMoves}).` : '',
            ...report.warnings.map((w) => `Note: ${w}`),
          ].filter(Boolean);
          c.events.push({
            streamId: streamId.desk(deskItemId),
            event: {
              type: 'DeskItemCreated',
              payload: {
                deskItemId,
                kind: 'alert',
                subkind: 'restructure_migrated',
                title: report.feedProjects
                  ? 'Feed projects became interests'
                  : 'Research interests were migrated',
                body: lines.join('\n\n'),
                options: [],
                blocking: false,
                pinned: false,
                affectedCardIds: [],
                askedBy: { kind: 'system' },
                addresseeUserId: c.ownerId,
              },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(o.orgId),
          });
          await store.append(c.events, { tx });
          for (const t of c.transcriptCopies)
            report.transcriptsCopied += await exec(
              tx,
              `INSERT INTO transcripts (project_id, url_normalized, url, title, language, auto_generated, vault_path, chars, truncated, text, created_at)
               SELECT $2, url_normalized, url, title, language, auto_generated, vault_path, chars, truncated, text, created_at
                 FROM transcripts WHERE project_id=$1 ON CONFLICT DO NOTHING`,
              [t.from, t.to],
            );
          // Vault commands, durable and in order: the moves first, so the files written into the new folders land in it.
          for (const m of c.vaultMoves) {
            const ws = await chooseVaultWriteTarget(tx, m.row as never);
            if (!ws) {
              report.warnings.push(`no workstation could move ${m.from}; move it by hand to ${m.to}`);
              continue;
            }
            await enqueueRunnerCommand(tx, ws, 'vault.move', {
              vaultId: m.row.id,
              from: m.from,
              to: m.to,
              commitMessage: `aom: move ${m.from} to ${m.to}`,
              push: true,
            });
          }
          for (const w of c.vaultWrites) {
            const ws = await chooseVaultWriteTarget(tx, w.row as never);
            if (!ws) continue;
            await enqueueRunnerCommand(tx, ws, 'vault.write', {
              vaultId: w.row.id,
              path: w.path,
              mode: w.mode,
              section: w.section,
              content: w.content,
              header: w.header,
              commitMessage: w.commitMessage,
              push: true,
            });
          }
        });
      } catch (err) {
        report.warnings.push(
          `the organization was not migrated: ${err instanceof Error ? err.message : String(err)}`,
        );
        log(`${RESTRUCTURE_MIGRATION}: organization ${o.orgId} failed: ${String(err)}`);
      }
      reports.push(report);
    }
    const failed = reports.filter((r) =>
      r.warnings.some((w) => w.startsWith('the organization was not migrated')),
    );
    if (failed.length === 0)
      await exec(
        pool,
        `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3)
         ON CONFLICT (name) DO UPDATE SET completed_at=EXCLUDED.completed_at, summary=EXCLUDED.summary`,
        [RESTRUCTURE_MIGRATION, env.clock.now(), JSON.stringify({ orgs: reports })],
      );
    log(
      `${RESTRUCTURE_MIGRATION}: ${reports.reduce((n, r) => n + r.feedProjects, 0)} feed project(s) and ${reports.reduce((n, r) => n + r.interests, 0)} interest(s) migrated`,
    );
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    } finally {
      lock.release();
    }
  }
  return { dryRun: false, plan, orgs: reports };
}
