import {
  isOrgManager,
  RULE_PACKS,
  type RulePack,
  type RulePackInstallResult,
  type RulePackPreview,
  type RulePackRemoveResult,
  type RulePackSummary,
  rulePackById,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { type Tx, withAppendTx, withTx } from '../db/tx.ts';
import { forbidden, notFound } from '../errors.ts';
import { assertBusinessOrg } from '../orgs/mode.ts';
import { orgScope, userActor } from './common.ts';
import { addLedgerEntryTx, liveOrdersFor } from './ledger.ts';
import { findContradictions, findNearDuplicate } from './ledger-checks.ts';
import { retireLedgerEntryTx } from './ledger-retire.ts';

export const RULE_PACKS_BUSINESS_ONLY = 'Rule packs are available in business organizations.';

const pack = (packId: string): RulePack => {
  const p = rulePackById(packId);
  if (!p) throw notFound('rule pack not found');
  return p;
};

interface Linked {
  id: string;
  rule_pack_rule_id: string;
  version: number;
  title: string;
}

/** The live entries of this organization that came from this pack. */
async function linkedRows(db: Tx, orgId: string, packId: string): Promise<Linked[]> {
  return rows<Linked>(
    db,
    `SELECT id, rule_pack_rule_id, COALESCE(version, 1) AS version, title FROM ledger_entries
      WHERE org_id=$1 AND rule_pack_id=$2 AND rule_pack_rule_id IS NOT NULL
        AND retired_at IS NULL AND superseded_by IS NULL
      ORDER BY created_at, id`,
    [orgId, packId],
  );
}

async function installedPackIds(db: Tx, orgId: string): Promise<Set<string>> {
  const r = await rows<{ pack_id: string }>(
    db,
    'SELECT pack_id FROM org_rule_packs WHERE org_id=$1 AND removed_at IS NULL',
    [orgId],
  );
  return new Set(r.map((x) => x.pack_id));
}

const summary = (p: RulePack, installed: boolean): RulePackSummary => ({
  id: p.id,
  name: p.name,
  description: p.description,
  kind: p.kind,
  industry: p.industry ?? null,
  ruleCount: p.rules.length,
  installed,
});

async function assertMember(db: Tx, user: AuthSession['user'], orgId: string): Promise<void> {
  if (!(await orgRoleOf(db, user.id, orgId))) throw forbidden('you do not belong to this organization');
}

async function assertManager(db: Tx, user: AuthSession['user'], orgId: string): Promise<void> {
  if (!isOrgManager({ orgRole: await orgRoleOf(db, user.id, orgId) }))
    throw forbidden('only the organization Owner and Admins can install or remove rule packs');
}

/** The packs with their installed flag. Business organizations only. */
export async function listRulePacks(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
): Promise<RulePackSummary[]> {
  return withTx(ctx.pool, async (tx) => {
    await assertBusinessOrg(tx, orgId, RULE_PACKS_BUSINESS_ONLY);
    await assertMember(tx, user, orgId);
    const installed = await installedPackIds(tx, orgId);
    return RULE_PACKS.map((p) => summary(p, installed.has(p.id)));
  });
}

/** What installing would do, rule by rule. Any member of a business organization may read it. */
export async function previewRulePack(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  packId: string,
): Promise<RulePackPreview> {
  return withTx(ctx.pool, async (tx) => {
    await assertBusinessOrg(tx, orgId, RULE_PACKS_BUSINESS_ONLY);
    await assertMember(tx, user, orgId);
    const p = pack(packId);
    const linked = new Map((await linkedRows(tx, orgId, p.id)).map((l) => [l.rule_pack_rule_id, l]));
    const live = await liveOrdersFor(tx, orgId, undefined);
    const installed = (await installedPackIds(tx, orgId)).has(p.id);
    return {
      ...summary(p, installed),
      rules: p.rules.map((r) => {
        const base = { id: r.id, title: r.title, body: r.body, enforcedBy: r.enforcedBy };
        const l = linked.get(r.id);
        if (l)
          return {
            ...base,
            status: l.version > 1 ? ('edited' as const) : ('installed' as const),
            existing: [],
          };
        const dup = findNearDuplicate(r, live);
        if (dup) return { ...base, status: 'covered' as const, existing: [{ id: dup.id, title: dup.title }] };
        const clashes = findContradictions(r, live);
        if (clashes.length)
          return {
            ...base,
            status: 'may_conflict' as const,
            existing: clashes.map((c) => ({ id: c.id, title: c.title })),
          };
        return { ...base, status: 'new' as const, existing: [] };
      }),
    };
  });
}

/**
 * Installs the pack's rules as organization-wide standing orders, through the same checks as a hand-written one
 * (permissions, near-duplicate, contradiction and desk alert). Idempotent: a rule already installed (edited or not) is
 * kept, and a rule the organization already has in its own words is skipped. One transaction.
 */
export async function installRulePack(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  packId: string,
): Promise<RulePackInstallResult> {
  return withAppendTx(ctx.pool, async (tx) => {
    await assertBusinessOrg(tx, orgId, RULE_PACKS_BUSINESS_ONLY);
    await assertManager(tx, user, orgId);
    const p = pack(packId);
    const existing = await linkedRows(tx, orgId, p.id);
    const have = new Set(existing.map((l) => l.rule_pack_rule_id));
    const out: RulePackInstallResult = {
      added: [],
      kept: existing.map((l) => l.id),
      skipped: [],
      flagged: [],
    };
    for (const r of p.rules) {
      if (have.has(r.id)) continue;
      // No review date: the owner can set one afterwards, like on any rule.
      const res = await addLedgerEntryTx(
        ctx,
        tx,
        user,
        orgId,
        { scope: r.scope, title: r.title, body: r.body, tags: [] },
        { rulePack: { packId: p.id, ruleId: r.id, packVersion: p.version }, onDuplicate: 'skip' },
      );
      if (res.kind === 'added') {
        out.added.push(res.result.entryId);
        if (res.result.conflictsWith.length > 0) out.flagged.push(res.result.entryId);
      } else if (res.kind === 'skipped')
        out.skipped.push({ ruleId: r.id, existingId: res.existing.id, existingTitle: res.existing.title });
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.rulePack(orgId, p.id),
          event: {
            type: 'RulePackInstalled',
            payload: {
              packId: p.id,
              packVersion: p.version,
              added: out.added,
              kept: out.kept,
              skipped: out.skipped.map((s) => ({ ruleId: s.ruleId, existingId: s.existingId })),
            },
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

/** Retires the pack's rules whose wording was never edited; edited ones stay as the organization's own. */
export async function removeRulePack(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  packId: string,
): Promise<RulePackRemoveResult> {
  return withAppendTx(ctx.pool, async (tx) => {
    await assertBusinessOrg(tx, orgId, RULE_PACKS_BUSINESS_ONLY);
    await assertManager(tx, user, orgId);
    const p = pack(packId);
    const retired: string[] = [];
    const kept: string[] = [];
    for (const l of await linkedRows(tx, orgId, p.id)) {
      if (l.version > 1) {
        kept.push(l.id);
        continue;
      }
      await retireLedgerEntryTx(
        ctx,
        tx,
        l.id,
        { reason: `Removed with the rule pack "${p.name}"` },
        { actor: userActor(user.id), label: 'owner', orgId },
      );
      retired.push(l.id);
    }
    const wasInstalled = (await installedPackIds(tx, orgId)).has(p.id);
    if (retired.length === 0 && kept.length === 0 && !wasInstalled) return { retired, kept };
    await ctx.store.append(
      [
        {
          streamId: streamId.rulePack(orgId, p.id),
          event: { type: 'RulePackRemoved', payload: { packId: p.id, retired, kept } },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
    return { retired, kept };
  });
}
