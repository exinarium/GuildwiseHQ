import { createHash } from 'node:crypto';
import {
  BRIEF_PLAYBOOKS,
  documentSlug,
  getJourneyTemplate,
  INDUSTRY_BUNDLES,
  type IndustryBundle,
  type IndustryBundleInstallResult,
  type IndustryBundlePreview,
  type IndustryBundleRemoveResult,
  type IndustryBundleSummary,
  type InstallIndustryBundleRequest,
  industryBundleById,
  industryDocumentTags,
  rulePackById,
  streamId,
} from '@aom/shared';
import { orgRoleOf, type Who } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx, withTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { installBriefPlaybookIn, installedMap, resolvePlaybookProject } from './brief-playbooks.ts';
import { orgScope, userActor } from './common.ts';
import { archiveDocumentIn, createDocumentIn } from './documents.ts';
import {
  assertManager,
  assertMember,
  installedPackIds,
  installRulePackTx,
  previewRulePackTx,
  removeRulePackTx,
} from './rule-packs.ts';
import { deleteScheduleIn, type OrgCtx } from './schedules.ts';

type User = AuthSession['user'];

const MANAGER_ONLY = 'only the organization Owner and Admins can install or remove industry bundles';

const bundleOf = (id: string): IndustryBundle => {
  const b = industryBundleById(id);
  if (!b) throw notFound('industry bundle not found');
  return b;
};

interface StoredItems {
  rulePack: { packId: string; installedByBundle: boolean };
  playbooks: Array<{ key: string; scheduleId: string; fingerprint: string }>;
  documents: Array<{ memberId: string; docId: string; kind: 'template' | 'sample'; tags: string[] }>;
  journeyTemplates: string[];
}

interface BundleRow {
  bundle_version: number;
  items: StoredItems;
  installed_at: Date;
  removed_at: Date | null;
}

async function bundleRow(db: Tx, orgId: string, bundleId: string): Promise<BundleRow | null> {
  return (await one(db, 'SELECT * FROM org_industry_bundles WHERE org_id=$1 AND bundle_id=$2', [
    orgId,
    bundleId,
  ])) as BundleRow | null;
}

const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  return v;
};

/**
 * sha-256 of the parts of a playbook schedule the organization can change (name, switch, trigger, action), without
 * secrets. Taken from the stored row on both sides, so install and uninstall read the same shape.
 */
export function scheduleFingerprint(
  row:
    | Row
    | {
        name: unknown;
        enabled: unknown;
        trigger: unknown;
        action: unknown;
      },
): string {
  const trigger = { ...((row.trigger ?? {}) as Record<string, unknown>) };
  delete trigger.secretHash;
  const action = { ...((row.action ?? {}) as Record<string, unknown>) };
  delete action.secretEnc;
  if (action.deliverOutput && typeof action.deliverOutput === 'object') {
    const d = { ...(action.deliverOutput as Record<string, unknown>) };
    delete d.secretEnc;
    action.deliverOutput = d;
  }
  const text = JSON.stringify(sortKeys({ name: row.name, enabled: row.enabled, trigger, action }));
  return createHash('sha256').update(text).digest('hex');
}

const sameTags = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

function summaryOf(b: IndustryBundle, row: BundleRow | null): IndustryBundleSummary {
  const live = row && !row.removed_at ? row : null;
  return {
    id: b.id,
    industry: b.industry,
    name: b.name,
    description: b.description,
    version: b.version,
    installed: !!live,
    installedAt: live ? iso(live.installed_at) : null,
    counts: {
      rules: rulePackById(b.rulePackId)?.rules.length ?? 0,
      playbooks: b.playbookKeys.length,
      knowledgeTemplates: b.knowledgeTemplates.length,
      sampleData: b.sampleData.length,
      journeyTemplates: b.journeyTemplateIds.length,
    },
  };
}

/** The bundles with their installed flag. Any member of the organization may read it. */
export async function listIndustryBundles(
  ctx: Ctx,
  user: User,
  orgId: string,
): Promise<IndustryBundleSummary[]> {
  return withTx(ctx.pool, async (tx) => {
    await assertMember(tx, user, orgId);
    const r = await rows(tx, 'SELECT * FROM org_industry_bundles WHERE org_id=$1', [orgId]);
    const byId = new Map(r.map((x) => [x.bundle_id as string, x as unknown as BundleRow]));
    return INDUSTRY_BUNDLES.map((b) => summaryOf(b, byId.get(b.id) ?? null));
  });
}

/** What installing would do. Writes nothing. */
export async function previewIndustryBundle(
  ctx: Ctx,
  user: User,
  orgId: string,
  bundleId: string,
  projectId?: string,
): Promise<IndustryBundlePreview> {
  return withTx(ctx.pool, async (tx) => {
    await assertMember(tx, user, orgId);
    const b = bundleOf(bundleId);
    const pack = rulePackById(b.rulePackId);
    if (!pack) throw conflict('bundle_member_missing', `rule pack '${b.rulePackId}' is missing`);
    const row = await bundleRow(tx, orgId, b.id);
    const installed = await installedMap(tx, orgId);
    const docs = async (list: IndustryBundle['knowledgeTemplates']) => {
      const out = [];
      for (const d of list) {
        const have = await one(
          tx,
          `SELECT id FROM documents WHERE org_id=$1 AND project_id IS NULL AND slug=$2 AND status <> 'archived'`,
          [orgId, documentSlug(d.title)],
        );
        out.push({
          id: d.id,
          title: d.title,
          status: have ? ('present' as const) : ('new' as const),
          existingId: (have?.id as string | undefined) ?? null,
        });
      }
      return out;
    };
    const blockers: IndustryBundlePreview['blockers'] = [];
    try {
      await resolvePlaybookProject(tx, orgId, projectId);
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = (err as Error).message;
      if (code === 'project_required') {
        const any = await one(
          tx,
          `SELECT 1 AS x FROM projects WHERE org_id=$1 AND kind='project' AND status='active' LIMIT 1`,
          [orgId],
        );
        blockers.push({ code: any ? 'project_required' : 'no_project', message });
      } else throw err;
    }
    return {
      ...summaryOf(b, row),
      rulePack: await previewRulePackTx(tx, orgId, pack),
      playbooks: b.playbookKeys.map((k) => ({
        key: k,
        name: BRIEF_PLAYBOOKS[k].name,
        description: BRIEF_PLAYBOOKS[k].description,
        status: installed.has(k) ? ('present' as const) : ('new' as const),
        scheduleId: installed.get(k) ?? null,
      })),
      knowledgeTemplates: await docs(b.knowledgeTemplates),
      sampleData: await docs(b.sampleData),
      journeyTemplates: b.journeyTemplateIds.map((id) => ({
        id,
        name: getJourneyTemplate(id)?.name ?? id,
      })),
      blockers,
    };
  });
}

/**
 * Installs every member of the bundle that is not there yet, in one transaction: if any member fails, nothing is
 * installed. Records only what the bundle created, so uninstall removes exactly that.
 */
export async function installIndustryBundle(
  ctx: Ctx,
  user: User,
  orgId: string,
  bundleId: string,
  req: InstallIndustryBundleRequest = {},
): Promise<IndustryBundleInstallResult> {
  return withAppendTx(ctx.pool, async (tx) => {
    await assertManager(tx, user, orgId, MANAGER_ONLY);
    const b = bundleOf(bundleId);
    const row = await bundleRow(tx, orgId, b.id);
    if (row && !row.removed_at)
      return {
        status: 'already_installed',
        rulePack: null,
        playbooks: { added: [], present: [] },
        documents: { added: [], present: [] },
        journeyTemplates: b.journeyTemplateIds,
      };
    const pack = rulePackById(b.rulePackId);
    if (!pack) throw conflict('bundle_member_missing', `rule pack '${b.rulePackId}' is missing`);
    for (const id of b.journeyTemplateIds)
      if (!getJourneyTemplate(id))
        throw conflict('bundle_member_missing', `journey template '${id}' is missing`);
    for (const k of b.playbookKeys)
      if (!BRIEF_PLAYBOOKS[k]) throw conflict('bundle_member_missing', `playbook '${k}' is missing`);

    // A missing project fails before anything is written.
    await resolvePlaybookProject(tx, orgId, req.projectId);

    const role = await orgRoleOf(tx, user.id, orgId);
    if (!role) throw forbidden(MANAGER_ONLY);
    const who: Who = { userId: user.id, orgId, role };
    const org: OrgCtx = { orgId, role };

    const out: IndustryBundleInstallResult = {
      status: 'installed',
      rulePack: null,
      playbooks: { added: [], present: [] },
      documents: { added: [], present: [] },
      journeyTemplates: b.journeyTemplateIds,
    };
    const items: StoredItems = {
      rulePack: { packId: pack.id, installedByBundle: false },
      playbooks: [],
      documents: [],
      journeyTemplates: b.journeyTemplateIds,
    };

    if (!(await installedPackIds(tx, orgId)).has(pack.id)) {
      out.rulePack = await installRulePackTx(ctx, tx, user, orgId, pack);
      items.rulePack.installedByBundle = true;
    }

    const have = await installedMap(tx, orgId);
    for (const key of b.playbookKeys) {
      const existing = have.get(key);
      if (existing) {
        out.playbooks.present.push({ key, scheduleId: existing });
        continue;
      }
      const r = await installBriefPlaybookIn(ctx, tx, user, org, key, {
        ...(req.projectId ? { projectId: req.projectId } : {}),
        ...(req.timezone ? { timezone: req.timezone } : {}),
        enabled: false,
      });
      const sched = await one(tx, 'SELECT name, enabled, trigger, action FROM schedules WHERE id=$1', [
        r.scheduleId,
      ]);
      if (!sched) throw conflict('bundle_member_missing', `playbook '${key}' was not created`);
      items.playbooks.push({ key, scheduleId: r.scheduleId, fingerprint: scheduleFingerprint(sched) });
      out.playbooks.added.push({ key, scheduleId: r.scheduleId });
    }

    for (const [kind, list] of [
      ['template', b.knowledgeTemplates],
      ['sample', b.sampleData],
    ] as const) {
      for (const d of list) {
        const existing = await one(
          tx,
          `SELECT id FROM documents WHERE org_id=$1 AND project_id IS NULL AND slug=$2 AND status <> 'archived'`,
          [orgId, documentSlug(d.title)],
        );
        if (existing) {
          out.documents.present.push({ memberId: d.id, existingId: existing.id as string });
          continue;
        }
        const tags = industryDocumentTags(b, kind);
        const doc = await createDocumentIn(ctx, tx, who, {
          kind,
          title: d.title,
          content: d.content,
          tags,
          sourceThreadIds: [],
        });
        items.documents.push({ memberId: d.id, docId: doc.id, kind, tags });
        out.documents.added.push({ memberId: d.id, docId: doc.id, kind });
      }
    }

    await ctx.store.append(
      [
        {
          streamId: streamId.industryBundle(orgId, b.id),
          event: {
            type: 'IndustryBundleInstalled',
            payload: { bundleId: b.id, bundleVersion: b.version, items },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    return out;
  });
}

/**
 * Removes what the bundle installed and nothing else: rules are retired, playbooks deleted and documents archived,
 * but only while the organization has not changed them. Changed ones are kept and listed.
 */
export async function removeIndustryBundle(
  ctx: Ctx,
  user: User,
  orgId: string,
  bundleId: string,
): Promise<IndustryBundleRemoveResult> {
  return withAppendTx(ctx.pool, async (tx) => {
    await assertManager(tx, user, orgId, MANAGER_ONLY);
    const b = bundleOf(bundleId);
    const row = await bundleRow(tx, orgId, b.id);
    if (!row || row.removed_at)
      throw conflict('bundle_not_installed', `the ${b.name} bundle is not installed`);
    const items = row.items;
    const role = await orgRoleOf(tx, user.id, orgId);
    if (!role) throw forbidden(MANAGER_ONLY);
    const who: Who = { userId: user.id, orgId, role };
    const org: OrgCtx = { orgId, role };

    const out: IndustryBundleRemoveResult = {
      removed: { ruleEntries: [], schedules: [], documents: [] },
      kept: [],
      gone: [],
    };
    const keptEvent: Array<{ kind: string; id: string }> = [];

    if (items.rulePack.installedByBundle) {
      const pack = rulePackById(items.rulePack.packId);
      if (pack) {
        const r = await removeRulePackTx(ctx, tx, user, orgId, pack);
        out.removed.ruleEntries.push(...r.retired);
        for (const id of r.kept) {
          const e = await one(tx, 'SELECT title FROM ledger_entries WHERE id=$1', [id]);
          out.kept.push({
            kind: 'rule',
            id,
            title: (e?.title as string | undefined) ?? '',
            reason: 'edited',
          });
          keptEvent.push({ kind: 'rule', id });
        }
      }
    }

    for (const p of items.playbooks) {
      const s = await one(
        tx,
        'SELECT name, enabled, trigger, action FROM schedules WHERE id=$1 AND org_id=$2',
        [p.scheduleId, orgId],
      );
      if (!s) {
        out.gone.push({ kind: 'playbook', id: p.scheduleId });
        continue;
      }
      if (scheduleFingerprint(s) !== p.fingerprint) {
        out.kept.push({ kind: 'playbook', id: p.scheduleId, title: s.name as string, reason: 'edited' });
        keptEvent.push({ kind: 'playbook', id: p.scheduleId });
        continue;
      }
      await deleteScheduleIn(ctx, tx, user, org, p.scheduleId);
      out.removed.schedules.push(p.scheduleId);
    }

    for (const d of items.documents) {
      const doc = await one(
        tx,
        'SELECT title, status, current_version, tags FROM documents WHERE id=$1 AND org_id=$2',
        [d.docId, orgId],
      );
      if (!doc || doc.status === 'archived') {
        out.gone.push({ kind: 'document', id: d.docId });
        continue;
      }
      const edited =
        Number(doc.current_version) > 1 ||
        doc.status !== 'draft' ||
        !sameTags((doc.tags as string[] | null) ?? [], d.tags);
      if (edited) {
        out.kept.push({ kind: 'document', id: d.docId, title: doc.title as string, reason: 'edited' });
        keptEvent.push({ kind: 'document', id: d.docId });
        continue;
      }
      await archiveDocumentIn(ctx, tx, who, d.docId, `Removed with the industry bundle "${b.name}"`);
      out.removed.documents.push(d.docId);
    }

    await ctx.store.append(
      [
        {
          streamId: streamId.industryBundle(orgId, b.id),
          event: {
            type: 'IndustryBundleRemoved',
            payload: { bundleId: b.id, removed: out.removed, kept: keptEvent },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    return out;
  });
}
