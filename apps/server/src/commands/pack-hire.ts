import { randomUUID } from 'node:crypto';
import {
  type HirablePacksResponse,
  type HireFromPackRequest,
  isOrgManager,
  PACK_AUTHORING_CAPABILITY,
  type PackHireStatus,
  type PackItem,
  PackPersonaReadResultSchema,
  type PackPersonasResponse,
  type PackProvenance,
  type PackSnapshot,
  type PersonaRoleInput,
  permissionsForPersona,
  provenanceLabel,
  type RoleDefinition,
  RoleDefinitionSchema,
  type RoleOfferDto,
  type RoleOfferReview,
  roleFromPersona,
  roleKeyForPackPersona,
  type Seniority,
  streamId,
  validateRoleDefinition,
} from '@aom/shared';
import { orgRoleOf, type Who } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadRole } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { rebaseAgentsToCurrentRoles } from '../hr/follow-role.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { hireAgent } from './agents.ts';
import { orgScope, userActor } from './common.ts';
import { BUILTIN_ROLE_KEYS, BUILTIN_WORKFLOW_KEYS, nextVersion } from './designer.ts';
import { HOLDS_PACK_SQL, isTrustedRow, packEvent } from './pack-support.ts';
import { deliver } from './workstation-setup.ts';

/**
 * Hire from pack (docs/ARCHITECTURE.md section 38.8). A persona of a trusted organization pack, or of the caller's own private
 * pack, becomes a role (its text the instructions, its declared tool profile the permissions, read only when it declares none,
 * never wider than the hiring user may grant) and an agent with a provenance tag (`BMAD · analyst · v6.12.4`). The persona text is
 * read from a workstation that holds the pack (`pack.persona.read`, hash-checked against what the owner approved); the server
 * uses it only to write the role. "Add all agents from this pack" is the same call with every persona.
 *
 * A later pack update that changes a persona offers a new role version (`RolePackUpdateOffered`), with the diff of the
 * instructions, and never applies it by itself. A pack whose approval is withdrawn (or that is removed) flags the agents hired
 * from it; they keep their role version.
 */

const PERSONA_READ_TTL_MS = 10 * 60_000;

/** A pack the user may use: an organization pack, or their own private pack. */
async function usablePackFor(db: Queryable, userId: string, orgId: string, packId: string): Promise<Row> {
  const p = await one(
    db,
    `SELECT * FROM packs WHERE id=$1 AND org_id=$2 AND removed_at IS NULL AND (visibility='org' OR owner_user_id=$3)`,
    [packId, orgId, userId],
  );
  if (!p) throw notFound('pack not found');
  return p;
}

const shortKey = (packName: string, key: string): string =>
  key.startsWith(`${packName}:`) ? key.slice(packName.length + 1) : key;

const personaItems = (p: Row): PackItem[] =>
  ((p.snapshot as PackSnapshot | null)?.items ?? []).filter((i) => i.kind === 'persona');

function provenanceOf(p: Row, item: PackItem): PackProvenance {
  const snap = p.snapshot as PackSnapshot;
  return {
    packId: p.id,
    packName: p.name,
    capability: shortKey(p.name, item.key),
    ref: snap.ref ?? null,
    sha: p.pinned_sha,
    hash: item.hash,
    visibility: p.visibility,
  };
}

// ------------------------------------------------------------------------------------------------ the list

/**
 * The packs a member can hire from on the HR page (Q60): approved organization packs and their own private packs that carry
 * personas. Names and counts only; a member's hire is bound by the same rule as any hire of theirs (a project they are on).
 */
export async function listHirablePacks(ctx: Ctx, who: Who): Promise<HirablePacksResponse> {
  const r = await rows(
    ctx.pool,
    `SELECT * FROM packs WHERE org_id=$1 AND removed_at IS NULL AND snapshot IS NOT NULL AND pinned_sha IS NOT NULL
        AND (visibility='org' OR owner_user_id=$2) ORDER BY name`,
    [who.orgId, who.userId],
  );
  return {
    packs: r
      .filter((p) => isTrustedRow(p))
      .map((p) => ({
        id: p.id as string,
        name: p.name as string,
        personaCount: personaItems(p).length,
        visibility: p.visibility as 'org' | 'private',
      }))
      .filter((p) => p.personaCount > 0),
  };
}

export async function listPackPersonas(ctx: Ctx, who: Who, packId: string): Promise<PackPersonasResponse> {
  const p = await usablePackFor(ctx.pool, who.userId, who.orgId, packId);
  const trusted = !!p.pinned_sha && isTrustedRow(p);
  // an organization pack that is not approved is for the managers to review; others see nothing to hire from it yet
  const mayWiden = isOrgManager({ orgRole: who.role });
  const hired = await rows(
    ctx.pool,
    `SELECT id, provenance->>'capability' AS cap FROM agents WHERE org_id=$1 AND status <> 'retired' AND provenance->>'packId' = $2`,
    [who.orgId, packId],
  );
  const roles = await rows(
    ctx.pool,
    `SELECT DISTINCT ON (key) key, version, definition FROM role_definitions
      WHERE org_id=$1 AND status='active' AND definition->'source'->>'packId' = $2
      ORDER BY key, version DESC`,
    [who.orgId, packId],
  );
  const reader = trusted ? await readerFor(ctx, p, undefined) : null;
  return {
    packId,
    packName: p.name,
    trusted,
    readableNow: !!reader,
    personas:
      trusted || mayWiden
        ? personaItems(p).map((i) => {
            const cap = shortKey(p.name, i.key);
            const prov = provenanceOf(p, i);
            const m = permissionsForPersona(i.tools, { mayWiden });
            const roleKey = roleKeyForPackPersona(p.name, cap);
            const role = roles.find((r) => r.key === roleKey);
            return {
              key: cap,
              name: i.name,
              description: i.description,
              icon: i.icon ?? null,
              declaredTools: i.tools ?? [],
              permissions: m.permissions,
              withheld: m.withheld,
              provenanceLabel: provenanceLabel(prov),
              roleKey,
              role: role
                ? { version: role.version, upToDate: role.definition?.source?.hash === i.hash }
                : null,
              hiredAgentIds: hired.filter((h) => h.cap === cap).map((h) => h.id as string),
            };
          })
        : [],
  };
}

// ------------------------------------------------------------------------------------------------ reading a persona

/** An online workstation that holds the pack and can read it (the hire's own workstation first). */
async function readerFor(ctx: Ctx, p: Row, prefer: string | undefined): Promise<string | null> {
  const list = await rows(
    ctx.pool,
    `SELECT w.id FROM packs p JOIN workstations w ON true
       JOIN workstation_capabilities wc ON wc.workstation_id = w.id AND $2 = ANY(wc.capabilities)
      WHERE p.id = $1 AND ${HOLDS_PACK_SQL}
      ORDER BY (w.id = $3::uuid) DESC, w.id`,
    [p.id, PACK_AUTHORING_CAPABILITY, prefer ?? null],
  );
  return list.map((w) => w.id as string).find((id) => ctx.services.runners.isOnline(id)) ?? null;
}

async function queueReads(
  ctx: Ctx,
  tx: Queryable,
  reader: string,
  packId: string,
  requestId: string,
  keys: string[],
) {
  for (const key of keys)
    await enqueueRunnerCommand(
      tx,
      reader,
      'pack.persona.read',
      { packId, requestId, key },
      new Date(Date.now() + PERSONA_READ_TTL_MS),
    );
  void ctx;
}

// ------------------------------------------------------------------------------------------------ hire

export async function hireFromPack(
  ctx: Ctx,
  user: AuthSession['user'],
  who: Who,
  packId: string,
  req: HireFromPackRequest,
): Promise<{ requestId: string }> {
  const p = await usablePackFor(ctx.pool, who.userId, who.orgId, packId);
  if (!p.pinned_sha || !isTrustedRow(p))
    throw conflict('pack_not_trusted', 'the pack has to be approved before agents can be hired from it');
  // Members hire only for a project they are on (the normal hire rule); said now, not after the persona was read.
  if (!isOrgManager({ orgRole: who.role }) && !req.allowedProjectIds?.length)
    throw forbidden('you cannot hire agents here: choose a project you are on, or ask an Owner or Admin');
  const items = personaItems(p);
  for (const it of req.items)
    if (!items.some((i) => shortKey(p.name, i.key) === it.key))
      throw badRequest('unknown_persona', `the pack has no persona "${it.key}"`);
  const names = req.items.map((i) => i.name.toLowerCase());
  if (new Set(names).size !== names.length)
    throw badRequest('duplicate_name', 'give every agent its own name');
  const reader = await readerFor(ctx, p, req.workstationId);
  if (!reader)
    throw conflict(
      'no_workstation',
      'no workstation that holds this pack is online: start your runner (the persona text is read from it)',
    );
  const requestId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    await exec(
      tx,
      `INSERT INTO pack_requests (id, org_id, pack_id, kind, requested_by, params, created_at, updated_at)
       VALUES ($1,$2,$3,'hire',$4,$5,$6,$6)`,
      [requestId, who.orgId, packId, who.userId, JSON.stringify(req), ctx.clock.now()],
    );
    await ctx.store.append(
      [
        packEvent(
          'PackHireRequested',
          {
            requestId,
            packId,
            orgId: who.orgId,
            requestedBy: who.userId,
            kind: 'hire',
            items: req.items.map((i) => ({ key: i.key, agentName: i.name })),
            workstationId: req.workstationId,
          },
          p,
          who.userId,
        ),
      ],
      { tx },
    );
    await queueReads(
      ctx,
      tx,
      reader,
      packId,
      requestId,
      req.items.map((i) => i.key),
    );
  });
  deliver(ctx, [reader]);
  void user;
  return { requestId };
}

export async function getHireStatus(ctx: Ctx, who: Who, requestId: string): Promise<PackHireStatus> {
  const r = await one(
    ctx.pool,
    `SELECT * FROM pack_requests WHERE id=$1 AND org_id=$2 AND requested_by=$3 AND kind='hire'`,
    [requestId, who.orgId, who.userId],
  );
  if (!r) throw notFound('request not found');
  return {
    requestId,
    status: r.status,
    error: r.error ?? null,
    agents: ((r.results as { agents?: PackHireStatus['agents'] })?.agents ?? []) as PackHireStatus['agents'],
  };
}

/** `command.result` of `pack.persona.read`: when every persona of a request is in, the request is carried out. */
export async function applyPersonaReadResult(
  ctx: Ctx,
  workstationId: string,
  _commandId: string,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
): Promise<void> {
  const requestId = String(payload.requestId ?? '');
  const key = String(payload.key ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return;
  const parsed = ok ? PackPersonaReadResultSchema.safeParse(result) : undefined;
  const good = parsed?.success && parsed.data.ok && parsed.data.text && parsed.data.hash && parsed.data.sha;
  // the workstation must be one that holds the pack, and the request must still be open
  const req = await one(ctx.pool, `SELECT * FROM pack_requests WHERE id=$1 AND status='pending'`, [
    requestId,
  ]);
  if (!req) return;
  const holds = await one(
    ctx.pool,
    `SELECT 1 FROM packs p JOIN workstations w ON w.id=$2 WHERE p.id=$1 AND p.removed_at IS NULL AND ${HOLDS_PACK_SQL}`,
    [req.pack_id, workstationId],
  );
  if (!holds) return fail(ctx, req, 'that workstation does not hold the pack');
  if (!good) {
    const msg =
      (parsed?.success ? parsed.data.error : undefined) ?? 'the workstation could not read the persona';
    return fail(ctx, req, msg);
  }
  const data = parsed.data;
  const next = await withAppendTx(ctx.pool, async (tx) => {
    const cur = await one(tx, 'SELECT * FROM pack_requests WHERE id=$1 FOR UPDATE', [requestId]);
    if (cur?.status !== 'pending') return undefined;
    const results = { ...(cur.results as Record<string, unknown>) };
    const reads = {
      ...((results.reads as Record<string, unknown>) ?? {}),
      [key]: { text: data.text, hash: data.hash, sha: data.sha },
    };
    results.reads = reads;
    await exec(tx, 'UPDATE pack_requests SET results=$2, updated_at=$3 WHERE id=$1', [
      requestId,
      JSON.stringify(results),
      ctx.clock.now(),
    ]);
    return { ...cur, results } as Row;
  });
  if (!next) return;
  const wanted =
    next.kind === 'hire'
      ? ((next.params as HireFromPackRequest).items ?? []).map((i) => i.key)
      : [String((next.params as { key?: string }).key ?? '')];
  const reads = (next.results as { reads?: Record<string, unknown> }).reads ?? {};
  if (!wanted.every((k) => k in reads)) return;
  if (next.kind === 'hire') await completeHire(ctx, next);
  else await completeReview(ctx, next);
}

async function fail(ctx: Ctx, req: Row, error: string): Promise<void> {
  await exec(
    ctx.pool,
    `UPDATE pack_requests SET status='failed', error=$2, updated_at=$3 WHERE id=$1 AND status='pending'`,
    [req.id, error.slice(0, 500), ctx.clock.now()],
  );
  const p = await one(ctx.pool, 'SELECT * FROM packs WHERE id=$1', [req.pack_id]);
  if (p)
    await ctx.store.append([
      packEvent(
        'PackHireResolved',
        {
          requestId: req.id,
          packId: req.pack_id,
          orgId: req.org_id,
          status: 'failed',
          error: error.slice(0, 500),
        },
        p,
        req.requested_by,
      ),
    ]);
}

/** Registers the role version for a persona unless an active version already carries exactly this content. */
async function ensureRole(
  ctx: Ctx,
  tx: Queryable & { query: unknown },
  orgId: string,
  userId: string,
  p: Row,
  item: PackItem,
  read: { text: string; hash: string; sha: string },
): Promise<RoleDefinition> {
  const snap = p.snapshot as PackSnapshot;
  const cap = shortKey(p.name, item.key);
  const key = roleKeyForPackPersona(p.name, cap);
  if ((BUILTIN_ROLE_KEYS as readonly string[]).includes(key))
    throw badRequest('builtin_key', `'${key}' is a built-in role: rename the pack`);
  const existing = await loadRole(tx as never, orgId, key);
  if (existing?.definition.source?.hash === read.hash && existing.definition.source.packId === p.id)
    return existing.definition;
  const version = await nextVersion(tx as never, 'role_definitions', orgId, key);
  const input: PersonaRoleInput = {
    packId: p.id,
    packName: p.name,
    capability: cap,
    text: read.text,
    hash: read.hash,
    sha: read.sha,
    ref: snap.ref ?? null,
    visibility: p.visibility,
    version,
    packSkills: snap.items.filter((i) => i.kind === 'skill').map((i) => i.key),
  };
  let def: RoleDefinition;
  try {
    def = roleFromPersona(input);
  } catch (err) {
    throw badRequest(
      'invalid_persona',
      `the persona "${cap}" cannot become a role: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const issues = validateRoleDefinition(def, {
    builtinRoleKeys: BUILTIN_ROLE_KEYS,
    builtinWorkflowKeys: BUILTIN_WORKFLOW_KEYS,
    departments: [],
  }).filter((i) => i.severity === 'error');
  if (issues.length)
    throw badRequest('invalid_persona', `the persona "${cap}" cannot become a role: ${issues[0]?.message}`);
  await ctx.store.append(
    [
      {
        streamId: streamId.role(orgId, key),
        event: {
          type: 'RoleVersionRegistered',
          payload: {
            roleVersionId: randomUUID(),
            orgId,
            key,
            version,
            definition: RoleDefinitionSchema.parse(def),
            status: 'active',
            draftedBy: { kind: 'user', id: userId },
          },
        },
        actor: userActor(userId),
        scope: orgScope(orgId),
      } as AppendInput,
    ],
    { tx: tx as never },
  );
  return def;
}

async function completeHire(ctx: Ctx, req: Row): Promise<void> {
  const p = await one(ctx.pool, 'SELECT * FROM packs WHERE id=$1 AND removed_at IS NULL', [req.pack_id]);
  const params = req.params as HireFromPackRequest;
  const reads = (req.results as { reads: Record<string, { text: string; hash: string; sha: string }> }).reads;
  const user = await one(ctx.pool, 'SELECT id, display_name FROM users WHERE id=$1', [req.requested_by]);
  const role = await orgRoleOf(ctx.pool, req.requested_by, req.org_id);
  if (!p || !user || !role) return fail(ctx, req, 'the pack or the requesting user is no longer available');
  const snap = p.snapshot as PackSnapshot | null;
  const agents: PackHireStatus['agents'] = [];
  try {
    // The persona text must be the content the owner approved: the item hash in the pinned snapshot.
    for (const it of params.items) {
      const item = personaItems(p).find((i) => shortKey(p.name, i.key) === it.key);
      const read = reads[it.key];
      if (!item || !read || read.hash !== item.hash || read.sha !== p.pinned_sha || !isTrustedRow(p))
        throw conflict('pack_changed', 'the pack changed while it was being read: try again');
      const def = await withAppendTx(ctx.pool, async (tx) =>
        ensureRole(ctx, tx, req.org_id, req.requested_by, p, item, read),
      );
      const provenance = provenanceOf(p, item);
      const mapped = permissionsForPersona(item.tools, { mayWiden: isOrgManager({ orgRole: role }) });
      const agentId = await hireAgent(
        ctx,
        { id: user.id, displayName: user.display_name } as AuthSession['user'],
        { id: req.org_id },
        {
          name: it.name,
          roleKey: def.key,
          seniority: (it.seniority ?? 'senior') as Seniority,
          workstationId: params.workstationId,
          ...(params.allowedProjectIds !== undefined ? { allowedProjectIds: params.allowedProjectIds } : {}),
          ...(params.runtime ? { runtime: params.runtime } : {}),
          ...(params.model ? { model: params.model } : {}),
          ...(params.effort ? { effort: params.effort } : {}),
          capacity: params.capacity,
          ...(params.acknowledgeUnsandboxed ? { acknowledgeUnsandboxed: true } : {}),
        },
        { provenance, permissions: mapped.permissions },
      );
      agents.push({ agentId, name: it.name, roleKey: def.key });
    }
  } catch (err) {
    const msg = err instanceof HttpError || err instanceof Error ? err.message : String(err);
    // the agents hired before the failure stay (each is a normal hire); the rest is reported
    await exec(ctx.pool, `UPDATE pack_requests SET results=$2 WHERE id=$1`, [
      req.id,
      JSON.stringify({ agents }),
    ]);
    return fail(ctx, req, msg);
  }
  void snap;
  // the persona texts are not kept
  await exec(ctx.pool, `UPDATE pack_requests SET status='done', results=$2, updated_at=$3 WHERE id=$1`, [
    req.id,
    JSON.stringify({ agents }),
    ctx.clock.now(),
  ]);
  await ctx.store.append([
    packEvent(
      'PackHireResolved',
      { requestId: req.id, packId: p.id, orgId: req.org_id, status: 'done', error: null },
      p,
      req.requested_by,
    ),
  ]);
}

// ------------------------------------------------------------------------------------------------ updates: offers

/**
 * After an update of a pack was accepted: roles made from a persona whose content changed get an offer for a new version. Agents
 * keep the role version they run until someone accepts the offer.
 */
export async function offerRoleUpdates(
  _ctx: Ctx,
  tx: Queryable,
  pack: Row,
  oldSnap: PackSnapshot | null,
  newSnap: PackSnapshot,
): Promise<AppendInput[]> {
  if (!oldSnap) return [];
  const out: AppendInput[] = [];
  const hired = await rows(
    tx,
    `SELECT DISTINCT a.role_key, a.org_id, a.provenance->>'capability' AS cap FROM agents a
      WHERE a.org_id=$1 AND a.status <> 'retired' AND a.provenance->>'packId' = $2`,
    [pack.org_id, pack.id],
  );
  for (const h of hired) {
    const before = oldSnap.items.find((i) => i.kind === 'persona' && shortKey(pack.name, i.key) === h.cap);
    const after = newSnap.items.find((i) => i.kind === 'persona' && shortKey(pack.name, i.key) === h.cap);
    if (!before || !after || before.hash === after.hash) continue;
    const role = await loadRole(tx, pack.org_id, h.role_key);
    if (!role) continue;
    const prov: PackProvenance = {
      packId: pack.id,
      packName: pack.name,
      capability: h.cap,
      ref: newSnap.ref ?? null,
      sha: newSnap.sha,
      hash: after.hash,
      visibility: pack.visibility,
    };
    out.push(
      packEvent(
        'RolePackUpdateOffered',
        {
          orgId: pack.org_id,
          roleKey: h.role_key,
          fromVersion: role.version,
          packId: pack.id,
          capability: h.cap,
          sha: newSnap.sha,
          hash: after.hash,
          provenance: prov,
        },
        pack,
      ),
    );
  }
  return out;
}

export async function listRoleOffers(ctx: Ctx, who: Who): Promise<RoleOfferDto[]> {
  if (!isOrgManager({ orgRole: who.role })) return [];
  const r = await rows(
    ctx.pool,
    `SELECT o.*, p.name AS pack_name,
            (SELECT count(*)::int FROM agents a WHERE a.org_id = o.org_id AND a.role_key = o.role_key AND a.status <> 'retired') AS agent_count,
            (SELECT definition->>'name' FROM role_definitions d WHERE d.org_id = o.org_id AND d.key = o.role_key AND d.status='active' ORDER BY version DESC LIMIT 1) AS role_name
       FROM role_pack_offers o JOIN packs p ON p.id = o.pack_id AND p.removed_at IS NULL
      WHERE o.org_id=$1 AND o.status='open' AND (p.visibility = 'org' OR p.owner_user_id = $2)
      ORDER BY o.offered_at`,
    [who.orgId, who.userId],
  );
  return r.map((o) => ({
    roleKey: o.role_key,
    roleName: o.role_name ?? o.role_key,
    fromVersion: o.from_version,
    packId: o.pack_id,
    packName: o.pack_name,
    capability: o.capability,
    provenance: o.provenance,
    newLabel: provenanceLabel(o.provenance),
    offeredAt: iso(o.offered_at) as string,
    agentCount: Number(o.agent_count ?? 0),
  }));
}

async function loadOffer(db: Queryable, who: Who, roleKey: string): Promise<Row> {
  if (!isOrgManager({ orgRole: who.role }))
    throw forbidden('only the organization Owner and Admins review role updates');
  const o = await one(
    db,
    `SELECT * FROM role_pack_offers WHERE org_id=$1 AND role_key=$2 AND status='open'`,
    [who.orgId, roleKey],
  );
  if (!o) throw notFound('no update on offer for that role');
  return o;
}

/** Reads the new persona text from the pack so the diff of the instructions can be shown. */
export async function startRoleReview(ctx: Ctx, who: Who, roleKey: string): Promise<{ requestId: string }> {
  const o = await loadOffer(ctx.pool, who, roleKey);
  const p = await usablePackFor(ctx.pool, who.userId, who.orgId, o.pack_id);
  if (!isTrustedRow(p) || p.pinned_sha !== o.sha)
    throw conflict('offer_stale', 'the pack changed again: this offer is out of date');
  const reader = await readerFor(ctx, p, undefined);
  if (!reader) throw conflict('no_workstation', 'no workstation that holds this pack is online');
  const requestId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    await exec(
      tx,
      `INSERT INTO pack_requests (id, org_id, pack_id, kind, requested_by, params, created_at, updated_at)
       VALUES ($1,$2,$3,'role_review',$4,$5,$6,$6)`,
      [
        requestId,
        who.orgId,
        p.id,
        who.userId,
        JSON.stringify({ roleKey, key: o.capability }),
        ctx.clock.now(),
      ],
    );
    await queueReads(ctx, tx, reader, p.id, requestId, [o.capability]);
  });
  deliver(ctx, [reader]);
  return { requestId };
}

async function completeReview(ctx: Ctx, req: Row): Promise<void> {
  const read = Object.values(
    (req.results as { reads: Record<string, { text: string; hash: string; sha: string }> }).reads,
  )[0];
  await exec(ctx.pool, `UPDATE pack_requests SET status='done', results=$2, updated_at=$3 WHERE id=$1`, [
    req.id,
    JSON.stringify({ proposed: read }),
    ctx.clock.now(),
  ]);
}

export async function getRoleReview(
  ctx: Ctx,
  who: Who,
  roleKey: string,
  requestId: string,
): Promise<RoleOfferReview> {
  const o = await loadOffer(ctx.pool, who, roleKey);
  const r = await one(
    ctx.pool,
    `SELECT * FROM pack_requests WHERE id=$1 AND org_id=$2 AND requested_by=$3 AND kind='role_review'`,
    [requestId, who.orgId, who.userId],
  );
  if (!r) throw notFound('request not found');
  const cur = await loadRole(ctx.pool, who.orgId, roleKey);
  const proposed = (r.results as { proposed?: { text: string; hash: string; sha: string } }).proposed;
  let proposedInstructions: string | null = null;
  if (r.status === 'done' && proposed && cur?.definition.source) {
    const p = await one(ctx.pool, 'SELECT * FROM packs WHERE id=$1', [o.pack_id]);
    const snap = p?.snapshot as PackSnapshot | null;
    proposedInstructions = roleFromPersona({
      packId: o.pack_id,
      packName: cur.definition.source.packName,
      capability: o.capability,
      text: proposed.text,
      hash: proposed.hash,
      sha: proposed.sha,
      ref: snap?.ref ?? null,
      visibility: cur.definition.source.visibility,
      version: cur.version + 1,
    }).instructions;
  }
  return {
    requestId,
    status: r.status,
    error: r.error ?? null,
    current: cur?.definition.instructions ?? null,
    proposed: proposedInstructions,
  };
}

/**
 * Accepts the offer: a new role version is registered and the agents of the role follow it, as agents follow any role
 * (`rebaseAgentsToCurrentRoles` keeps what the owner narrowed on an agent). Nothing happens before this call.
 */
export async function acceptRoleOffer(
  ctx: Ctx,
  user: AuthSession['user'],
  who: Who,
  roleKey: string,
  requestId: string,
): Promise<{ version: number; movedAgents: number }> {
  const o = await loadOffer(ctx.pool, who, roleKey);
  const r = await one(
    ctx.pool,
    `SELECT * FROM pack_requests WHERE id=$1 AND org_id=$2 AND requested_by=$3 AND kind='role_review' AND status='done'`,
    [requestId, who.orgId, who.userId],
  );
  const proposed = (r?.results as { proposed?: { text: string; hash: string; sha: string } } | undefined)
    ?.proposed;
  if (!r || !proposed) throw conflict('review_first', 'review the new version first');
  if (proposed.hash !== o.hash || proposed.sha !== o.sha)
    throw conflict('offer_stale', 'the pack changed again: review the new version');
  return withAppendTx(ctx.pool, async (tx) => {
    const p = await one(tx, 'SELECT * FROM packs WHERE id=$1 AND removed_at IS NULL', [o.pack_id]);
    if (!p || !isTrustedRow(p) || p.pinned_sha !== o.sha)
      throw conflict('offer_stale', 'the pack is no longer approved at that revision');
    const item = personaItems(p).find((i) => shortKey(p.name, i.key) === o.capability);
    if (!item || item.hash !== o.hash) throw conflict('offer_stale', 'the pack changed again');
    const def = await ensureRole(ctx, tx, who.orgId, who.userId, p, item, proposed);
    await ctx.store.append(
      [
        {
          streamId: streamId.role(who.orgId, roleKey),
          event: {
            type: 'RolePackUpdateResolved',
            payload: { orgId: who.orgId, roleKey, packId: p.id, accepted: true, by: user.id },
          },
          actor: userActor(user.id),
          scope: orgScope(who.orgId),
        } as AppendInput,
      ],
      { tx },
    );
    const movedAgents = await rebaseAgentsToCurrentRoles(ctx, { orgId: who.orgId, roleKey, tx });
    return { version: def.version, movedAgents };
  });
}

export async function dismissRoleOffer(
  ctx: Ctx,
  user: AuthSession['user'],
  who: Who,
  roleKey: string,
): Promise<void> {
  const o = await loadOffer(ctx.pool, who, roleKey);
  await ctx.store.append([
    {
      streamId: streamId.role(who.orgId, roleKey),
      event: {
        type: 'RolePackUpdateResolved',
        payload: { orgId: who.orgId, roleKey, packId: o.pack_id, accepted: false, by: user.id },
      },
      actor: userActor(user.id),
      scope: orgScope(who.orgId),
    } as AppendInput,
  ]);
}
