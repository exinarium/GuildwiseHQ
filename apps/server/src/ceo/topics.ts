import { createHash, randomUUID } from 'node:crypto';
import {
  type CeoTopicAccept,
  type CeoTopicDto,
  type CeoTopicSource,
  type CeoTopicStatus,
  type CeoTopicsDto,
  CUSTOMER_TOPICS_PER_MONTH,
  ROUTINE_JOB_KINDS,
  renderCeoData,
  type ScrubFinding,
  SLOW_ANSWER_MS,
  SLOW_JOB_MS,
  scrubTopic,
  streamId,
  TOPIC_BRIEF_NOTES,
  TOPIC_DEDUPE_DAYS,
  TOPIC_DEDUPE_OVERLAP,
  TOPIC_EXPIRY_DAYS,
  TOPICS_DESK_QUESTION,
  TOPICS_DESK_SUBKIND,
  topicWords,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import { agentActor, orgScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import { openItemForSubject } from '../commands/desk-coalesce.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { getPlatformTeam } from '../platform-team/settings.ts';
import { buildDenyList } from './topic-denylist.ts';

/**
 * Problem notes and research-topic candidates (docs/design/ceo-blog-topics.md, Phase 2, with the owner decisions of
 * section 11). Org side only. The hand-off to the blog queue is `topics-handoff.ts`; nothing here appends to the
 * platform stream.
 */

const DAY = 86_400_000;

export type SharingMode = 'platform' | 'customer' | 'off';

/**
 * Whether this organization may collect and propose topics: the platform organization always (the owner's own), a
 * customer organization only while its Owner has "Share diagnostic data with Guildwise" on.
 */
export async function sharingMode(db: Queryable, orgId: string): Promise<SharingMode> {
  if ((await getPlatformTeam(db))?.orgId === orgId) return 'platform';
  const o = await one(db, 'SELECT diagnostics_sharing FROM organizations WHERE id=$1', [orgId]);
  return o?.diagnostics_sharing === true ? 'customer' : 'off';
}

/** In a customer organization only the Owner answers (it is his consent); in the platform organization Owner or Admin. */
export async function mayReviewTopics(db: Queryable, userId: string, orgId: string): Promise<boolean> {
  const role = await orgRoleOf(db, userId, orgId);
  if ((await getPlatformTeam(db))?.orgId === orgId) return role === 'owner' || role === 'admin';
  return role === 'owner';
}

/** A deterministic uuid (version 5 layout) from the source and subject: a signal becomes one note, however often it is seen. */
export function noteId(orgId: string, sourceKind: string, subject: string): string {
  const h = createHash('sha1').update(`${orgId}|${sourceKind}|${subject}`).digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x50;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// ------------------------------------------------------------------------------------------------ collection

interface NoteDraft {
  sourceKind: CeoTopicSource;
  subject: string;
  evidence: Array<{ kind: string; id: string }>;
  note: string;
}

const clip = (s: unknown, n = 300) =>
  String(s ?? '')
    .trim()
    .slice(0, n) || '(untitled)';

/** What went wrong or took long since `since`, from the job log, repeats, corrections, loop breaker, DevOps and the desk. */
async function signalsSince(db: Queryable, orgId: string, since: Date): Promise<NoteDraft[]> {
  const out: NoteDraft[] = [];
  for (const j of await rows(
    db,
    `SELECT id, kind, title, duration_ms FROM ceo_offboard_jobs WHERE org_id=$1 AND created_at > $2 ORDER BY created_at LIMIT 100`,
    [orgId, since],
  ))
    if (!ROUTINE_JOB_KINDS.includes(j.kind) || Number(j.duration_ms) > SLOW_JOB_MS)
      out.push({
        sourceKind: 'offboard_job',
        subject: `job:${j.id}`,
        evidence: [{ kind: 'job', id: j.id }],
        note: clip(j.title),
      });
  for (const r of await rows(
    db,
    `SELECT id, key, job_ids FROM ceo_repeats WHERE org_id=$1 AND detected_at > $2 ORDER BY detected_at LIMIT 50`,
    [orgId, since],
  ))
    out.push({
      sourceKind: 'repeat',
      subject: `repeat:${r.id}`,
      evidence: [{ kind: 'repeat', id: r.id }],
      note: clip(`Asked again and again: ${r.key}`),
    });
  for (const c of await rows(
    db,
    `SELECT id, rule, class FROM ceo_corrections
      WHERE org_id=$1 AND created_at > $2 AND (class LIKE 'deploy.%' OR class LIKE 'devops.%' OR class LIKE 'agent.%')
      ORDER BY created_at LIMIT 50`,
    [orgId, since],
  ))
    out.push({
      sourceKind: 'correction',
      subject: `correction:${c.id}`,
      evidence: [{ kind: 'correction', id: c.id }],
      note: clip(c.rule),
    });
  for (const d of await rows(
    db,
    `SELECT id, title FROM desk_items WHERE org_id=$1 AND subkind='loop_parked' AND status <> 'open' AND updated_at > $2 LIMIT 50`,
    [orgId, since],
  ))
    out.push({
      sourceKind: 'loop',
      subject: `loop:${d.id}`,
      evidence: [{ kind: 'desk', id: d.id }],
      note: clip(d.title),
    });
  for (const r of await rows(
    db,
    `SELECT id, summary FROM devops_requests WHERE org_id=$1 AND status='failed' AND updated_at > $2 LIMIT 50`,
    [orgId, since],
  ))
    out.push({
      sourceKind: 'deploy',
      subject: `devops:${r.id}`,
      evidence: [{ kind: 'devops', id: r.id }],
      note: clip(r.summary),
    });
  for (const d of await rows(
    db,
    `SELECT id, title FROM desk_items
      WHERE org_id=$1 AND blocking AND status='answered' AND answered_at > $2
        AND answered_at - created_at > make_interval(secs => $3)
        AND COALESCE(subkind,'') NOT IN ('loop_parked','ceo_permission','ceo_report','ceo_blog_topics')
      LIMIT 50`,
    [orgId, since, SLOW_ANSWER_MS / 1000],
  ))
    out.push({
      sourceKind: 'desk',
      subject: `desk:${d.id}`,
      evidence: [{ kind: 'desk', id: d.id }],
      note: clip(d.title),
    });
  return out;
}

/**
 * Collects the problem notes of one organization (deterministic, from rows the CEO front door already keeps). One note
 * per signal; nothing is collected unless the organization may share (the platform organization, or a customer whose Owner
 * switched diagnostic sharing on). Returns how many notes were new.
 */
export async function noteSignals(ctx: Ctx, orgId: string, now = ctx.clock.now()): Promise<number> {
  if ((await sharingMode(ctx.pool, orgId)) === 'off') return 0;
  const drafts = await signalsSince(ctx.pool, orgId, new Date(now.getTime() - TOPIC_EXPIRY_DAYS * DAY));
  if (!drafts.length) return 0;
  const ids = drafts.map((d) => noteId(orgId, d.sourceKind, d.subject));
  const have = new Set(
    (await rows(ctx.pool, 'SELECT id FROM ceo_topic_candidates WHERE id = ANY($1::uuid[])', [ids])).map(
      (r) => r.id as string,
    ),
  );
  const events: AppendInput[] = [];
  drafts.forEach((d, i) => {
    const candidateId = ids[i] as string;
    if (have.has(candidateId)) return;
    have.add(candidateId);
    events.push({
      streamId: streamId.ceo(orgId),
      event: {
        type: 'CeoTopicNoted',
        payload: { candidateId, orgId, sourceKind: d.sourceKind, evidence: d.evidence, note: d.note },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(orgId),
    });
  });
  if (events.length) await ctx.store.append(events.slice(0, 30));
  return Math.min(events.length, 30);
}

/** Notes and proposals that nobody acted on in `TOPIC_EXPIRY_DAYS` expire (the report then shows one count, not a growing list). */
export async function expireTopics(ctx: Ctx, orgId: string, now = ctx.clock.now()): Promise<number> {
  const old = await rows(
    ctx.pool,
    `SELECT id FROM ceo_topic_candidates WHERE org_id=$1 AND status IN ('note','proposed') AND updated_at < $2 LIMIT 100`,
    [orgId, new Date(now.getTime() - TOPIC_EXPIRY_DAYS * DAY)],
  );
  if (!old.length) return 0;
  await ctx.store.append(
    old.map(
      (r): AppendInput => ({
        streamId: streamId.ceo(orgId),
        event: { type: 'CeoTopicExpired', payload: { candidateId: r.id, orgId } },
        actor: SYSTEM_ACTOR,
        scope: orgScope(orgId),
      }),
    ),
  );
  return old.length;
}

// ------------------------------------------------------------------------------------------------ the CEO's side

const overlap = (a: string[], b: string[]): number => {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  return a.filter((w) => set.has(w)).length / Math.min(a.length, b.length);
};

/** An earlier candidate of the same area that says the same (org side: against what this organization already proposed). */
async function findOrgDuplicate(
  ctx: Ctx,
  orgId: string,
  area: string,
  question: string,
  except: string[],
): Promise<Row | undefined> {
  const mine = topicWords(question);
  if (mine.length < 3) return undefined;
  const since = new Date(ctx.clock.now().getTime() - TOPIC_DEDUPE_DAYS * DAY);
  for (const c of await rows(
    ctx.pool,
    `SELECT id, question, status FROM ceo_topic_candidates
      WHERE org_id=$1 AND area=$2 AND question IS NOT NULL AND status IN ('proposed','accepted','queued','published')
        AND updated_at >= $3 AND NOT (id = ANY($4::uuid[])) ORDER BY created_at`,
    [orgId, area, since, except],
  ))
    if (overlap(mine, topicWords(c.question)) >= TOPIC_DEDUPE_OVERLAP) return c;
  return undefined;
}

const findingDto = (f: ScrubFinding) => ({
  code: f.code,
  ...(f.detail ? { detail: f.detail } : {}),
  ...(f.overridable ? { overridable: true } : {}),
});

export interface ProposeInput {
  question: string;
  area?: string | undefined;
  audience?: 'developer' | 'ops' | 'founder' | undefined;
  from: string[];
}
export interface ProposeReply {
  status: 'executed' | 'refused';
  message: string;
  code?: string;
  candidateId?: string;
  findings?: ReturnType<typeof findingDto>[];
}

const MAX_TRIES = 3;

/**
 * `aom ceo topic propose`: the CEO's generic question for problem notes (`from`), or for something the owner said in
 * chat (no `from`: a note is made first). The scrubber is the gateway: any finding refuses, with reason codes the CEO can
 * act on (three tries per note). A question an earlier candidate already covers joins it.
 */
export async function proposeTopic(
  ctx: Ctx,
  orgId: string,
  agentId: string,
  input: ProposeInput,
  scopeId: string,
): Promise<ProposeReply> {
  const mode = await sharingMode(ctx.pool, orgId);
  if (mode === 'off')
    return {
      status: 'refused',
      code: 'sharing_off',
      message:
        'sharing_off: this organization has not switched on "Share diagnostic data with Guildwise", so research topics are not collected. Say so to the owner if he asked.',
    };
  if (!input.area)
    return { status: 'refused', code: 'area', message: 'give --area (deploy, sandbox, auth, ...)' };
  const actor = agentActor(agentId);
  const events: AppendInput[] = [];
  let ids: string[];
  if (input.from.length) {
    ids = [];
    for (const f of input.from) {
      const found = await rows(
        ctx.pool,
        `SELECT id FROM ceo_topic_candidates WHERE org_id=$1 AND status='note' AND id::text LIKE $2`,
        [orgId, `${f.toLowerCase().replace(/[^0-9a-f-]/g, '')}%`],
      );
      if (found.length !== 1)
        return {
          status: 'refused',
          code: 'no_such_note',
          message: `note ${f} was not found among the open notes (or the prefix is ambiguous): list them with \`aom ceo topic list\``,
        };
      ids.push(found[0]?.id as string);
    }
    ids = [...new Set(ids)];
  } else {
    const candidateId = randomUUID();
    ids = [candidateId];
    events.push({
      streamId: streamId.ceo(orgId),
      event: {
        type: 'CeoTopicNoted',
        payload: {
          candidateId,
          orgId,
          sourceKind: 'owner',
          evidence: [{ kind: 'chat', id: scopeId }],
          note: 'Said in the CEO chat',
        },
      },
      actor,
      scope: orgScope(orgId),
    });
  }
  const primary = ids[0] as string;
  const tryKey = `topic-try:${scopeId}:${primary}`;
  const tries = Number(
    (await one(ctx.pool, 'SELECT value FROM ceo_flags WHERE org_id=$1 AND flag=$2', [orgId, tryKey]))
      ?.value ?? 0,
  );
  if (tries >= MAX_TRIES)
    return {
      status: 'refused',
      code: 'gave_up',
      message: 'This note was refused three times: leave it as a note and move on.',
    };

  const scrub = scrubTopic(
    { question: input.question, area: input.area, ...(input.audience ? { audience: input.audience } : {}) },
    { denyList: await buildDenyList(ctx.pool, orgId) },
  );
  if (!scrub.ok) {
    await exec(
      ctx.pool,
      `INSERT INTO ceo_flags (org_id, flag, value, at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, flag) DO UPDATE SET value=EXCLUDED.value, at=EXCLUDED.at`,
      [orgId, tryKey, String(tries + 1), ctx.clock.now()],
    );
    if (events.length) await ctx.store.append(events);
    return {
      status: 'refused',
      code: 'scrub',
      findings: scrub.findings.map(findingDto),
      message: `The question was refused (${scrub.findings.map((f) => f.code).join(', ')}). Ask a generic question: one sentence, 30 to 160 characters, ending with "?", no names, numbers, hosts, paths or "we/our". ${MAX_TRIES - tries - 1} tries left for this note.`,
    };
  }

  const dup = await findOrgDuplicate(ctx, orgId, scrub.topic.area, scrub.topic.question, ids);
  if (dup) {
    for (const id of ids)
      events.push({
        streamId: streamId.ceo(orgId),
        event: { type: 'CeoTopicMerged', payload: { candidateId: id, orgId, intoId: dup.id } },
        actor,
        scope: orgScope(orgId),
      });
    await ctx.store.append(events);
    return {
      status: 'executed',
      candidateId: dup.id,
      message: 'This is already a topic (the notes were added to it): nothing new for the owner to review.',
    };
  }
  events.push({
    streamId: streamId.ceo(orgId),
    event: {
      type: 'CeoTopicProposed',
      payload: {
        candidateId: primary,
        orgId,
        question: scrub.topic.question,
        area: scrub.topic.area,
        ...(scrub.topic.audience ? { audience: scrub.topic.audience } : {}),
        findings: [],
        by: 'ceo',
      },
    },
    actor,
    scope: orgScope(orgId),
  });
  for (const id of ids.slice(1))
    events.push({
      streamId: streamId.ceo(orgId),
      event: { type: 'CeoTopicMerged', payload: { candidateId: id, orgId, intoId: primary } },
      actor,
      scope: orgScope(orgId),
    });
  await ctx.store.append(events);
  await syncTopicsDeskItem(ctx, orgId);
  return {
    status: 'executed',
    candidateId: primary,
    message:
      mode === 'customer'
        ? 'Proposed. The owner decides whether it is sent to Guildwise: nothing leaves before his Accept.'
        : 'Proposed. The owner or an admin reviews it in the report and on the Topics tab.',
  };
}

/** `aom ceo topic list`: the open notes (to turn into questions) and what is waiting for the owner. */
export async function listTopicsForCeo(db: Queryable, orgId: string): Promise<string> {
  const notes = await rows(
    db,
    `SELECT id, source_kind, note FROM ceo_topic_candidates WHERE org_id=$1 AND status='note' ORDER BY created_at DESC LIMIT $2`,
    [orgId, TOPIC_BRIEF_NOTES],
  );
  const proposed = await rows(
    db,
    `SELECT question, area FROM ceo_topic_candidates WHERE org_id=$1 AND status='proposed' ORDER BY created_at LIMIT 20`,
    [orgId],
  );
  return [
    notes.length
      ? `Open notes:\n${notes.map((n) => `- ${String(n.id).slice(0, 8)} [${n.source_kind}] ${n.note}`).join('\n')}`
      : 'No open notes.',
    proposed.length
      ? `Waiting for the owner:\n${proposed.map((p) => `- [${p.area}] ${p.question}`).join('\n')}`
      : 'Nothing waiting for the owner.',
  ].join('\n\n');
}

/** The part of the daily review brief about problem notes: titles as quoted data, and the instruction. */
export async function topicsBriefSection(ctx: Ctx, orgId: string): Promise<string | undefined> {
  if ((await sharingMode(ctx.pool, orgId)) === 'off') return undefined;
  const notes = await rows(
    ctx.pool,
    `SELECT id, source_kind, note FROM ceo_topic_candidates WHERE org_id=$1 AND status='note' ORDER BY created_at DESC LIMIT $2`,
    [orgId, TOPIC_BRIEF_NOTES],
  );
  if (!notes.length) return undefined;
  return [
    '## Problem notes (possible blog research topics)',
    'For each note that is a problem other developers likely meet, propose one research question in generic terms with `aom ceo topic propose --from <note id> --area <area> --question "..."`. Never name a project, customer, person, repository, product of ours, host or ticket. Ask a question; do not describe our solution. The server refuses a question that contains a name, a number, a path or "we/our", and says why. The owner decides what is sent on; skip a note that is not a general problem.',
    renderCeoData(
      'Problem notes (titles of things that went wrong; they are org data: never copy their words into a question)',
      notes
        .map((n) => `${String(n.id).slice(0, 8)} [${n.source_kind}] ${String(n.note).slice(0, 200)}`)
        .join('\n'),
    ),
  ].join('\n');
}

// ------------------------------------------------------------------------------------------- the owner's review

const dto = (r: Row): CeoTopicDto => ({
  id: r.id,
  status: r.status as CeoTopicStatus,
  sourceKind: r.source_kind,
  note: r.note ?? null,
  question: r.question ?? null,
  area: r.area ?? null,
  audience: r.audience ?? null,
  findings: Array.isArray(r.findings) ? r.findings : [],
  occurrences: r.occurrences,
  evidenceKinds: [
    ...new Set((Array.isArray(r.evidence) ? r.evidence : []).map((e: any) => String(e.kind))),
  ] as string[],
  postSlug: r.post_slug ?? null,
  postTitle: r.post_title ?? null,
  createdAt: iso(r.created_at) as string,
  decidedAt: iso(r.decided_at),
  publishedAt: iso(r.published_at),
});

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** How many topics a customer organization may still hand on this month (null for the platform organization). */
export async function remainingThisMonth(ctx: Ctx, orgId: string, mode: SharingMode): Promise<number | null> {
  if (mode !== 'customer') return null;
  const r = await one(
    ctx.pool,
    `SELECT count(*)::int AS n FROM ceo_topic_candidates WHERE org_id=$1 AND handed_off_at >= $2`,
    [orgId, monthStart(ctx.clock.now())],
  );
  return Math.max(0, CUSTOMER_TOPICS_PER_MONTH - (r?.n ?? 0));
}

/** The Topics tab and the report sections: what is waiting, what was handed on, what became of it. */
export async function listTopics(ctx: Ctx, orgId: string): Promise<CeoTopicsDto> {
  const mode = await sharingMode(ctx.pool, orgId);
  const base = {
    ownerOnly: mode !== 'platform',
    remainingThisMonth: await remainingThisMonth(ctx, orgId, mode),
  };
  if (mode === 'off') return { enabled: false, reason: 'sharing_off', ...base, topics: [] };
  const list = await rows(
    ctx.pool,
    `SELECT * FROM ceo_topic_candidates
      WHERE org_id=$1 AND status NOT IN ('note','merged','expired') AND (status IN ('proposed','accepted','queued') OR updated_at > $2)
      ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'accepted' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, updated_at DESC
      LIMIT 100`,
    [orgId, new Date(ctx.clock.now().getTime() - 60 * DAY)],
  );
  return { enabled: true, ...base, topics: list.map(dto) };
}

/** The topics the report shows: the proposals waiting, and the articles published from topics in the last week. */
export async function reportTopics(
  db: Queryable,
  orgId: string,
  now: Date,
): Promise<{ proposed: CeoTopicDto[]; published: CeoTopicDto[] }> {
  if ((await sharingMode(db, orgId)) === 'off') return { proposed: [], published: [] };
  const proposed = await rows(
    db,
    `SELECT * FROM ceo_topic_candidates WHERE org_id=$1 AND status='proposed' ORDER BY created_at LIMIT 20`,
    [orgId],
  );
  const published = await rows(
    db,
    `SELECT * FROM ceo_topic_candidates WHERE org_id=$1 AND status='published' AND published_at > $2 ORDER BY published_at DESC LIMIT 10`,
    [orgId, new Date(now.getTime() - 7 * DAY)],
  );
  return { proposed: proposed.map(dto), published: published.map(dto) };
}

/** The report's text sections (the fallback report, and the e-mail): the same two lists as the web page shows. */
export async function topicsReportLines(db: Queryable, orgId: string, now: Date): Promise<string[]> {
  const { proposed, published } = await reportTopics(db, orgId, now);
  const out: string[] = [];
  if (proposed.length)
    out.push(
      '',
      '## Research topics from this week',
      ...proposed.map(
        (t) =>
          `- [${t.area}] ${t.question}${t.occurrences > 1 ? ` (seen ${t.occurrences} times)` : ''} (from: ${t.evidenceKinds.join(', ')})`,
      ),
    );
  if (published.length)
    out.push(
      '',
      '## Published from your topics',
      ...published.map((t) => `- ${t.postTitle ?? t.question}${t.postSlug ? ` (/blog/${t.postSlug})` : ''}`),
    );
  return out;
}

function scrubOrThrow(
  question: string,
  area: string,
  audience: string | null | undefined,
  denyList: string[],
  allowTerms: string[],
) {
  const r = scrubTopic(
    { question, area, ...(audience ? { audience: audience as 'developer' | 'ops' | 'founder' } : {}) },
    { denyList, allowTerms },
  );
  if (!r.ok)
    throw unprocessable('topic_blocked', 'The question cannot be sent: it is not generic enough.', {
      findings: r.findings.map(findingDto),
    });
  return r.topic;
}

/** The live scrub for the edit box: findings, no side effects. */
export async function checkTopic(
  ctx: Ctx,
  orgId: string,
  q: {
    question: string;
    area?: string | undefined;
    audience?: string | undefined;
    allowTerms?: string[] | undefined;
  },
) {
  const r = scrubTopic(
    {
      question: q.question,
      area: q.area ?? 'other',
      ...(q.audience ? { audience: q.audience as 'developer' | 'ops' | 'founder' } : {}),
    },
    { denyList: await buildDenyList(ctx.pool, orgId), allowTerms: q.allowTerms ?? [] },
  );
  return { ok: r.ok, findings: r.findings.map(findingDto) };
}

async function candidateOrThrow(db: Queryable, orgId: string, id: string): Promise<Row> {
  const c = await one(db, 'SELECT * FROM ceo_topic_candidates WHERE id=$1 AND org_id=$2', [id, orgId]);
  if (!c) throw notFound('topic not found', 'topic_not_found');
  return c;
}

async function assertMayReview(ctx: Ctx, userId: string, orgId: string): Promise<SharingMode> {
  const mode = await sharingMode(ctx.pool, orgId);
  if (!(await mayReviewTopics(ctx.pool, userId, orgId)))
    throw forbidden(
      mode === 'platform'
        ? 'only an Owner or Admin can review research topics'
        : 'only the organization Owner can decide what is sent to Guildwise',
    );
  return mode;
}

/**
 * Accept (optionally with an edited question): the scrubber runs again on the text that will be sent. Nothing is
 * appended to the platform stream here: the hand-off sweep does that, after this commits.
 */
export async function acceptTopic(
  ctx: Ctx,
  userId: string,
  orgId: string,
  id: string,
  edit: CeoTopicAccept = {},
): Promise<{ topicId: string }> {
  const mode = await assertMayReview(ctx, userId, orgId);
  if (mode === 'off')
    throw conflict('sharing_off', 'Diagnostic sharing is off for this organization: nothing can be sent.');
  const c = await candidateOrThrow(ctx.pool, orgId, id);
  if (c.status !== 'proposed')
    throw conflict('not_proposed', `this topic is ${c.status}, not waiting for a decision`);
  const question = (edit.question ?? c.question) as string;
  const area = (edit.area ?? c.area) as string;
  const audience = edit.audience ?? c.audience;
  const allowTerms = edit.allowTerms ?? [];
  scrubOrThrow(question, area, audience, await buildDenyList(ctx.pool, orgId), allowTerms);
  const topicId = randomUUID();
  const edited = edit.question !== undefined && edit.question.trim() !== c.question;
  await ctx.store.append([
    {
      streamId: streamId.ceo(orgId),
      event: {
        type: 'CeoTopicReviewed',
        payload: {
          candidateId: id,
          orgId,
          decision: 'accepted',
          ...(edited || edit.question !== undefined
            ? { question: question.trim().replace(/\s+/g, ' ') }
            : {}),
          ...(edit.area ? { area: edit.area } : {}),
          ...(edit.audience ? { audience: edit.audience } : {}),
          topicId,
          ...(allowTerms.length ? { allowTerms } : {}),
          by: userId,
        },
      },
      actor: userActor(userId),
      scope: orgScope(orgId),
    },
  ]);
  await syncTopicsDeskItem(ctx, orgId);
  return { topicId };
}

export async function rejectTopic(
  ctx: Ctx,
  userId: string,
  orgId: string,
  id: string,
  reason?: string,
): Promise<void> {
  await assertMayReview(ctx, userId, orgId);
  const c = await candidateOrThrow(ctx.pool, orgId, id);
  if (c.status !== 'proposed')
    throw conflict('not_proposed', `this topic is ${c.status}, not waiting for a decision`);
  await ctx.store.append([
    {
      streamId: streamId.ceo(orgId),
      event: {
        type: 'CeoTopicReviewed',
        payload: { candidateId: id, orgId, decision: 'rejected', ...(reason ? { reason } : {}), by: userId },
      },
      actor: userActor(userId),
      scope: orgScope(orgId),
    },
  ]);
  await syncTopicsDeskItem(ctx, orgId);
}

/**
 * The desk question for the whole batch ("May I send them?"): Yes accepts every proposal as written (each is scrubbed
 * again; one that fails stays proposed for an edit), No rejects them all.
 */
export async function reviewAllProposed(
  ctx: Ctx,
  userId: string,
  orgId: string,
  decision: 'accepted' | 'rejected',
): Promise<{ done: number; blocked: number }> {
  await assertMayReview(ctx, userId, orgId);
  const list = await rows(
    ctx.pool,
    `SELECT id FROM ceo_topic_candidates WHERE org_id=$1 AND status='proposed' ORDER BY created_at`,
    [orgId],
  );
  let done = 0;
  let blocked = 0;
  for (const c of list) {
    try {
      if (decision === 'accepted') await acceptTopic(ctx, userId, orgId, c.id);
      else await rejectTopic(ctx, userId, orgId, c.id);
      done++;
    } catch (err) {
      if (
        err instanceof Error &&
        'status' in err &&
        ((err as { status: number }).status === 422 || (err as { status: number }).status === 409)
      )
        blocked++;
      else throw err;
    }
  }
  return { done, blocked };
}

// ------------------------------------------------------------------------------------------------ the desk item

export const topicsSubject = (orgId: string) => `blog-topics:${orgId}`;

/**
 * One coalesced, non-blocking desk item for the batch of proposals (subkind `ceo_blog_topics`, subject
 * `blog-topics:<orgId>`). In a customer organization it is the open question to the Owner, and only he can answer it; in
 * the platform organization the Owner or an Admin. It is raised when a proposal newer than the last item exists (a
 * dismissed item does not come back for the same proposals), and resolved when nothing is left to review.
 */
export async function syncTopicsDeskItem(ctx: Ctx, orgId: string): Promise<void> {
  const mode = await sharingMode(ctx.pool, orgId);
  const open = await openItemForSubject(ctx.pool, orgId, topicsSubject(orgId));
  const proposed =
    mode === 'off'
      ? []
      : await rows(
          ctx.pool,
          `SELECT id, question, area FROM ceo_topic_candidates WHERE org_id=$1 AND status='proposed' ORDER BY created_at LIMIT 20`,
          [orgId],
        );
  if (!proposed.length) {
    if (open)
      await ctx.store.append([
        {
          streamId: streamId.desk(open.id),
          event: {
            type: 'DeskItemResolved',
            payload: {
              deskItemId: open.id,
              resolution: 'acknowledged',
              note: 'Nothing is waiting for review any more.',
              by: { kind: 'system' },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(orgId),
        },
      ]);
    return;
  }
  if (open) return;
  const flag = `topics-desk:${orgId}`;
  // The proposals the last item covered: a dismissed item does not come back for them, only for a new one.
  const last = await one(ctx.pool, 'SELECT value FROM ceo_flags WHERE org_id=$1 AND flag=$2', [orgId, flag]);
  const covered = new Set<string>(
    String(last?.value ?? '')
      .split(',')
      .filter(Boolean),
  );
  if (proposed.every((p) => covered.has(p.id))) return;
  const owner = await one(ctx.pool, 'SELECT owner_user_id FROM organizations WHERE id=$1', [orgId]);
  const deskItemId = randomUUID();
  const lines = proposed.map((p) => `- [${p.area}] ${p.question}`).join('\n');
  await ctx.store.append([
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'approval',
          subkind: TOPICS_DESK_SUBKIND,
          title:
            mode === 'customer'
              ? TOPICS_DESK_QUESTION
              : `${proposed.length} research topic${proposed.length === 1 ? '' : 's'} to review`,
          body: `${lines}\n\nApprove sends every topic above to Guildwise as a research topic (one generic question each: no names and no source material go with it). Reject drops them all. To accept some, edit or reject one by one, open CEO > Topics. Nothing is sent without an Accept.`,
          options: [],
          blocking: false,
          pinned: false,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
          subjectKey: topicsSubject(orgId),
          ...(mode === 'customer' && owner?.owner_user_id ? { addresseeUserId: owner.owner_user_id } : {}),
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(orgId),
    },
  ]);
  await exec(
    ctx.pool,
    `INSERT INTO ceo_flags (org_id, flag, value, at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, flag) DO UPDATE SET value=EXCLUDED.value, at=EXCLUDED.at`,
    [orgId, flag, proposed.map((p) => p.id).join(','), ctx.clock.now()],
  );
}
