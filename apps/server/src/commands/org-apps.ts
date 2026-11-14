import { randomUUID } from 'node:crypto';
import {
  type AddOrgAppRequest,
  APP_ERROR_TEXT,
  APP_INTEGRATIONS_CAPABILITY,
  type AppCommandResult,
  AppCommandResultSchema,
  type AppIdentity,
  appInstance,
  ENVELOPE_TTL_MS,
  isOrgOwner,
  type OrgAppDto,
  type OrgAppRequestDto,
  type OrgAppShare,
  type OrgAppsResponse,
  type OrgAppWorkstationDto,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';
import { orgScope, userActor } from './common.ts';
import { deliver } from './workstation-setup.ts';

/**
 * Automated app integrations (docs/ARCHITECTURE.md section 46): an organization Owner registers one installation of one app
 * (a GitHub App first). The private key is sealed in the browser to each chosen workstation; this module relays only those
 * ciphertexts in the durable command queue, empties them once answered and keeps metadata only. The integration exists only
 * after the first runner verified the key with the provider and stored it.
 */
const TEST_TTL_MS = 10 * 60_000;
const REQUEST_TTL_MS = ENVELOPE_TTL_MS + 5 * 60_000;

type User = AuthSession['user'];

/** Owner only (not Admin): 404 for a non-member, 403 for members and Admins. */
export async function requireOrgOwner(db: Queryable, user: User, orgId: string): Promise<void> {
  const role = await orgRoleOf(db, user.id, orgId);
  if (role === null) throw notFound('organization not found');
  if (!isOrgOwner({ orgRole: role }))
    throw forbidden('only the organization Owner can manage automated apps');
}

/** Workstations of active members that serve this organization, with their runner key and the app capability. */
async function targetWorkstations(db: Queryable, orgId: string) {
  return rows<{
    id: string;
    name: string;
    owner_name: string;
    key_id: string | null;
    public_key: string | null;
    supported: boolean;
  }>(
    db,
    `SELECT ws.id, ws.name, u.display_name AS owner_name, k.key_id, k.public_key,
            COALESCE($2 = ANY(c.capabilities), false) AS supported
       FROM workstations ws
       JOIN users u ON u.id = ws.user_id AND u.status = 'active'
       JOIN org_members om ON om.user_id = ws.user_id AND om.org_id = $1 AND om.status = 'active'
       LEFT JOIN workstation_keys k ON k.workstation_id = ws.id
       LEFT JOIN workstation_capabilities c ON c.workstation_id = ws.id
      WHERE ws.status = 'active' AND ${wsServesOrgSql('ws', '$1::uuid')}
      ORDER BY u.display_name, ws.name, ws.id`,
    [orgId, APP_INTEGRATIONS_CAPABILITY],
  );
}

interface AppRow {
  id: string;
  org_id: string;
  provider: string;
  label: string;
  host: string;
  app_id: string;
  app_slug: string;
  app_name: string;
  installation_id: string;
  account: string;
  bot_login: string;
  bot_user_id: string;
  commit_name: string;
  commit_email: string;
  permissions: Record<string, 'read' | 'write'>;
  missing_permissions: string[];
  created_at: Date;
}

async function activeApp(db: Queryable, orgId: string, id: string): Promise<AppRow> {
  const r = await one<AppRow>(
    db,
    `SELECT * FROM org_app_integrations WHERE id=$1 AND org_id=$2 AND status='active'`,
    [id, orgId],
  );
  if (!r) throw notFound('app not found');
  return r;
}

const instanceOf = (a: Pick<AppRow, 'app_id' | 'installation_id'>) =>
  appInstance(a.app_id, a.installation_id);

function stateOf(status: { state?: string } | null): OrgAppWorkstationDto['state'] {
  if (!status?.state) return 'pending';
  if (status.state === 'connected') return 'connected';
  if (status.state === 'refused' || status.state === 'unreachable' || status.state === 'unavailable')
    return 'error';
  return 'missing';
}

/** `GET /api/org/apps`: every member sees the apps and their state; only the Owner sees workstations and targets. */
export async function listOrgApps(ctx: Ctx, user: User, orgId: string): Promise<OrgAppsResponse> {
  const role = await orgRoleOf(ctx.pool, user.id, orgId);
  if (role === null) throw notFound('organization not found');
  const owner = isOrgOwner({ orgRole: role });
  const apps = await rows<AppRow>(
    ctx.pool,
    `SELECT * FROM org_app_integrations WHERE org_id=$1 AND status='active' ORDER BY created_at, id`,
    [orgId],
  );
  const held = await rows<{
    integration_id: string;
    workstation_id: string;
    name: string;
    owner_name: string;
    status: { state?: string; refreshedAt?: string; errorCode?: string; detail?: string } | null;
    checked_at: Date | null;
  }>(
    ctx.pool,
    `SELECT w.integration_id, w.workstation_id, ws.name, u.display_name AS owner_name, wi.status, wi.checked_at
       FROM org_app_integration_workstations w
       JOIN org_app_integrations i ON i.id = w.integration_id
       JOIN workstations ws ON ws.id = w.workstation_id
       JOIN users u ON u.id = ws.user_id
       LEFT JOIN workstation_integrations wi
         ON wi.workstation_id = w.workstation_id AND wi.kind = i.provider AND wi.instance = i.app_id || ':' || i.installation_id
      WHERE i.org_id = $1 AND i.status = 'active'
      ORDER BY u.display_name, ws.name`,
    [orgId],
  );
  const dtos: OrgAppDto[] = apps.map((a) => {
    const ws: OrgAppWorkstationDto[] = held
      .filter((h) => h.integration_id === a.id)
      .map((h) => ({
        id: h.workstation_id,
        name: h.name,
        ownerName: h.owner_name,
        state: stateOf(h.status),
        ...(h.status?.refreshedAt ? { refreshedAt: h.status.refreshedAt } : {}),
        ...(h.status?.errorCode ? { errorCode: h.status.errorCode } : {}),
        ...(h.status?.detail && stateOf(h.status) === 'error'
          ? { message: h.status.detail.slice(0, 300) }
          : {}),
        ...(h.checked_at ? { checkedAt: new Date(h.checked_at).toISOString() } : {}),
      }));
    const state: OrgAppDto['state'] = ws.some((w) => w.state === 'error')
      ? 'error'
      : ws.some((w) => w.state === 'connected')
        ? 'connected'
        : 'pending';
    return {
      id: a.id,
      provider: a.provider as OrgAppDto['provider'],
      label: a.label,
      host: a.host,
      appId: a.app_id,
      appSlug: a.app_slug,
      appName: a.app_name,
      installationId: a.installation_id,
      account: a.account,
      botLogin: a.bot_login,
      commitName: a.commit_name,
      commitEmail: a.commit_email,
      permissions: a.permissions,
      missingPermissions: a.missing_permissions,
      createdAt: new Date(a.created_at).toISOString(),
      state,
      ...(owner ? { workstations: ws } : {}),
    };
  });
  const out: OrgAppsResponse = { apps: dtos, canManage: owner, serverTime: ctx.clock.now().toISOString() };
  if (owner)
    out.targets = (await targetWorkstations(ctx.pool, orgId))
      .filter((t) => t.key_id && t.public_key)
      .map((t) => ({
        id: t.id,
        name: t.name,
        ownerName: t.owner_name,
        keyId: t.key_id as string,
        publicKey: t.public_key as string,
        online: ctx.services.runners.isOnline(t.id),
        supported: t.supported,
      }));
  return out;
}

/** Checks every share against the organization's targets: capability, current runner key, no duplicates. */
async function checkShares(db: Queryable, orgId: string, shares: OrgAppShare[]): Promise<void> {
  const targets = await targetWorkstations(db, orgId);
  const seen = new Set<string>();
  for (const s of shares) {
    const t = targets.find((x) => x.id === s.workstationId);
    if (!t) throw notFound('workstation not found in this organization');
    if (!t.supported)
      throw unprocessable('runner_too_old', `update the runner on ${t.name} to add automated apps to it`);
    if (!t.key_id || t.key_id !== s.keyId || s.envelope.keyId !== t.key_id)
      throw conflict(
        'runner_key_changed',
        `the runner key of ${t.name} changed: reload the page and try again`,
      );
    if (seen.has(s.workstationId)) throw badRequest('duplicate_workstation', 'a workstation appears twice');
    seen.add(s.workstationId);
  }
}

interface ResultEntry {
  workstationId: string;
  commandId: string;
  ok?: boolean;
  code?: string;
  message?: string;
}

async function queueConnects(
  ctx: Ctx,
  tx: Tx,
  a: {
    orgId: string;
    integrationId: string;
    requestId: string;
    provider: string;
    host: string;
    appRef: string;
    installationId?: string;
    expect?: string;
    shares: OrgAppShare[];
  },
): Promise<ResultEntry[]> {
  const out: ResultEntry[] = [];
  const expires = new Date(ctx.clock.now().getTime() + ENVELOPE_TTL_MS);
  for (const s of a.shares) {
    const commandId = await enqueueRunnerCommand(
      tx,
      s.workstationId,
      'app.connect',
      {
        requestId: a.requestId,
        orgId: a.orgId,
        integrationId: a.integrationId,
        provider: a.provider,
        host: a.host,
        appRef: a.appRef,
        ...(a.installationId ? { installationId: a.installationId } : {}),
        ...(a.expect ? { expect: a.expect } : {}),
        ref: s.ref,
        envelope: s.envelope,
      },
      expires,
    );
    out.push({ workstationId: s.workstationId, commandId });
  }
  return out;
}

async function insertRequest(
  ctx: Ctx,
  tx: Tx,
  r: {
    id: string;
    orgId: string;
    integrationId: string;
    userId: string;
    op: string;
    label?: string;
    results: ResultEntry[];
  },
): Promise<void> {
  if (await one(tx, 'SELECT 1 AS x FROM app_integration_requests WHERE id=$1', [r.id]))
    throw conflict('request_exists', 'this request was already sent');
  const now = ctx.clock.now();
  await exec(
    tx,
    `INSERT INTO app_integration_requests (id, org_id, integration_id, user_id, op, label, state, results, created_at, updated_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7::jsonb,$8,$8,$9)`,
    [
      r.id,
      r.orgId,
      r.integrationId,
      r.userId,
      r.op,
      r.label ?? null,
      JSON.stringify(r.results),
      now,
      new Date(now.getTime() + REQUEST_TTL_MS),
    ],
  );
}

/** `POST /api/org/apps`: queue one `app.connect` per chosen workstation. Nothing exists until a runner verified the key. */
export async function addOrgApp(
  ctx: Ctx,
  user: User,
  orgId: string,
  req: AddOrgAppRequest,
): Promise<{ requestId: string }> {
  await withAppendTx(ctx.pool, async (tx) => {
    await requireOrgOwner(tx, user, orgId);
    if (
      req.installationId &&
      (await one(
        tx,
        `SELECT 1 AS x FROM org_app_integrations
          WHERE org_id=$1 AND provider=$2 AND host=$3 AND app_id=$4 AND installation_id=$5 AND status='active'`,
        [orgId, req.provider, req.host, req.appRef, req.installationId],
      ))
    )
      throw conflict('app_exists', 'this app installation is already registered');
    await checkShares(tx, orgId, req.shares);
    const integrationId = randomUUID();
    const results = await queueConnects(ctx, tx, {
      orgId,
      integrationId,
      requestId: req.requestId,
      provider: req.provider,
      host: req.host,
      appRef: req.appRef,
      ...(req.installationId ? { installationId: req.installationId } : {}),
      shares: req.shares,
    });
    await insertRequest(ctx, tx, {
      id: req.requestId,
      orgId,
      integrationId,
      userId: user.id,
      op: 'add',
      label: req.label,
      results,
    });
  });
  deliver(
    ctx,
    req.shares.map((s) => s.workstationId),
  );
  return { requestId: req.requestId };
}

/** `POST /api/org/apps/:id/shares`: seal the key to more workstations or replace it; another app is `app_mismatch`. */
export async function shareOrgApp(
  ctx: Ctx,
  user: User,
  orgId: string,
  id: string,
  req: { requestId: string; shares: OrgAppShare[] },
): Promise<{ requestId: string }> {
  await withAppendTx(ctx.pool, async (tx) => {
    await requireOrgOwner(tx, user, orgId);
    const app = await activeApp(tx, orgId, id);
    await checkShares(tx, orgId, req.shares);
    const results = await queueConnects(ctx, tx, {
      orgId,
      integrationId: id,
      requestId: req.requestId,
      provider: app.provider,
      host: app.host,
      appRef: app.app_id,
      installationId: app.installation_id,
      expect: instanceOf(app),
      shares: req.shares,
    });
    await insertRequest(ctx, tx, {
      id: req.requestId,
      orgId,
      integrationId: id,
      userId: user.id,
      op: 'share',
      results,
    });
  });
  deliver(
    ctx,
    req.shares.map((s) => s.workstationId),
  );
  return { requestId: req.requestId };
}

/** `POST /api/org/apps/:id/test`: `app.test` on each workstation that holds the key (or one). */
export async function testOrgApp(
  ctx: Ctx,
  user: User,
  orgId: string,
  id: string,
  workstationId?: string,
): Promise<{ requestId: string }> {
  const requestId = randomUUID();
  const touched: string[] = [];
  await withAppendTx(ctx.pool, async (tx) => {
    await requireOrgOwner(tx, user, orgId);
    const app = await activeApp(tx, orgId, id);
    const held = await rows<{ workstation_id: string }>(
      tx,
      `SELECT workstation_id FROM org_app_integration_workstations WHERE integration_id=$1`,
      [id],
    );
    const targets = held.map((h) => h.workstation_id).filter((w) => !workstationId || w === workstationId);
    if (targets.length === 0) throw notFound('no workstation holds this app');
    const results: ResultEntry[] = [];
    const expires = new Date(ctx.clock.now().getTime() + TEST_TTL_MS);
    for (const w of targets) {
      const commandId = await enqueueRunnerCommand(
        tx,
        w,
        'app.test',
        { requestId, instance: instanceOf(app), integrationId: id },
        expires,
      );
      results.push({ workstationId: w, commandId });
      touched.push(w);
    }
    await insertRequest(ctx, tx, {
      id: requestId,
      orgId,
      integrationId: id,
      userId: user.id,
      op: 'test',
      results,
    });
  });
  deliver(ctx, touched);
  return { requestId };
}

/** `PATCH /api/org/apps/:id`. */
export async function renameOrgApp(
  ctx: Ctx,
  user: User,
  orgId: string,
  id: string,
  label: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    await requireOrgOwner(tx, user, orgId);
    await activeApp(tx, orgId, id);
    await ctx.store.append(
      [appEvent(orgId, id, user.id, 'OrgAppIntegrationUpdated', { integrationId: id, label, by: user.id })],
      {
        tx,
      },
    );
  });
}

/** `app.remove` never expires: the key must be deleted even when the runner is offline for days. */
async function queueRemove(
  tx: Tx,
  workstationId: string,
  orgId: string,
  integrationId: string,
  instance: string,
) {
  await enqueueRunnerCommand(tx, workstationId, 'app.remove', { orgId, integrationId, instance });
}

/** `DELETE /api/org/apps/:id/workstations/:wsId`. */
export async function unshareOrgApp(
  ctx: Ctx,
  user: User,
  orgId: string,
  id: string,
  workstationId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    await requireOrgOwner(tx, user, orgId);
    const app = await activeApp(tx, orgId, id);
    await queueRemove(tx, workstationId, orgId, id, instanceOf(app));
    await ctx.store.append(
      [
        appEvent(orgId, id, user.id, 'OrgAppIntegrationUnshared', {
          integrationId: id,
          workstationId,
          by: user.id,
        }),
      ],
      { tx },
    );
  });
  deliver(ctx, [workstationId]);
}

/** `DELETE /api/org/apps/:id`: gone from the list, `app.remove` everywhere, pending sealed commands emptied. */
export async function removeOrgApp(ctx: Ctx, user: User, orgId: string, id: string): Promise<void> {
  const touched = new Set<string>();
  await withAppendTx(ctx.pool, async (tx) => {
    await requireOrgOwner(tx, user, orgId);
    const app = await activeApp(tx, orgId, id);
    const instance = instanceOf(app);
    const held = await rows<{ workstation_id: string }>(
      tx,
      `SELECT workstation_id FROM org_app_integration_workstations WHERE integration_id=$1
       UNION
       SELECT workstation_id FROM workstation_integrations WHERE kind=$2 AND instance=$3
          AND workstation_id IN (SELECT ws.id FROM workstations ws JOIN org_members om ON om.user_id = ws.user_id AND om.org_id = $4)`,
      [id, app.provider, instance, orgId],
    );
    for (const h of held) {
      await queueRemove(tx, h.workstation_id, orgId, id, instance);
      touched.add(h.workstation_id);
    }
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', last_error='removed', payload='{}'::jsonb
        WHERE type IN ('app.connect','app.test') AND status='pending' AND payload->>'integrationId' = $1`,
      [id],
    );
    await ctx.store.append(
      [appEvent(orgId, id, user.id, 'OrgAppIntegrationRemoved', { integrationId: id, by: user.id })],
      {
        tx,
      },
    );
  });
  deliver(ctx, [...touched]);
}

function appEvent(
  orgId: string,
  integrationId: string,
  by: string,
  type: string,
  payload: Record<string, unknown>,
): AppendInput {
  return {
    streamId: streamId.appIntegration(integrationId),
    event: { type, payload } as AppendInput['event'],
    actor: userActor(by),
    scope: orgScope(orgId),
  };
}

interface RequestRow {
  id: string;
  org_id: string;
  integration_id: string;
  user_id: string;
  op: string;
  label: string | null;
  state: string;
  results: ResultEntry[];
  installations: OrgAppRequestDto['installations'] | null;
}

/** `GET /api/org/apps/requests/:rid`: the requester (the Owner) polls it. */
export async function readOrgAppRequest(
  ctx: Ctx,
  user: User,
  orgId: string,
  rid: string,
): Promise<OrgAppRequestDto> {
  await requireOrgOwner(ctx.pool, user, orgId);
  const r = await one<RequestRow>(
    ctx.pool,
    `SELECT * FROM app_integration_requests WHERE id=$1 AND org_id=$2`,
    [rid, orgId],
  );
  if (!r || r.user_id !== user.id) throw notFound('request not found');
  const app =
    r.state === 'done'
      ? await one<AppRow>(ctx.pool, `SELECT * FROM org_app_integrations WHERE id=$1`, [r.integration_id])
      : null;
  return {
    id: r.id,
    state: r.state as OrgAppRequestDto['state'],
    ...(app ? { integrationId: app.id } : {}),
    ...(app
      ? {
          identity: {
            provider: app.provider as AppIdentity['provider'],
            host: app.host,
            appId: app.app_id,
            appSlug: app.app_slug,
            appName: app.app_name,
            installationId: app.installation_id,
            account: app.account,
            botLogin: app.bot_login,
            botUserId: app.bot_user_id,
            commitName: app.commit_name,
            commitEmail: app.commit_email,
            permissions: app.permissions,
            missingPermissions: app.missing_permissions,
          },
        }
      : {}),
    ...(r.installations ? { installations: r.installations } : {}),
    results: r.results.map(({ commandId: _c, ...rest }) => rest),
  };
}

const sameApp = (i: AppIdentity, a: Pick<AppRow, 'app_id' | 'installation_id'>) =>
  i.appId === a.app_id && i.installationId === a.installation_id;

const identityEvent = (
  orgId: string,
  integrationId: string,
  label: string,
  by: string,
  i: AppIdentity,
): AppendInput =>
  appEvent(orgId, integrationId, by, 'OrgAppIntegrationAdded', { ...i, integrationId, orgId, label, by });

/**
 * `command.result` of `app.connect` / `app.test`. The sealed payload is already emptied by the caller. Parsed strictly: an
 * answer with an unknown field (a token) is treated as `unexpected` and nothing of it is kept.
 */
export async function applyAppCommandResult(
  ctx: Ctx,
  workstationId: string,
  commandId: string,
  type: string,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
): Promise<void> {
  const requestId = String(payload.requestId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return;
  const parsed = AppCommandResultSchema.safeParse(result);
  const r: AppCommandResult =
    ok && parsed.success
      ? parsed.data
      : { ok: false, code: 'unexpected', message: APP_ERROR_TEXT.unexpected };
  const touched: string[] = [];
  await withAppendTx(ctx.pool, async (tx) => {
    const req = await one<RequestRow>(tx, `SELECT * FROM app_integration_requests WHERE id=$1 FOR UPDATE`, [
      requestId,
    ]);
    if (!req) return;
    const entry = req.results.find((e) => e.commandId === commandId);
    if (!entry) return;
    let outcome: Pick<ResultEntry, 'ok' | 'code' | 'message'> = r.ok
      ? { ok: true }
      : {
          ok: false,
          code: r.code ?? 'unexpected',
          message: (r.message ?? APP_ERROR_TEXT[r.code ?? 'unexpected']).slice(0, 300),
        };
    let state = req.state;
    if (type === 'app.connect' && r.ok && r.identity) {
      const app = await one<AppRow>(tx, `SELECT * FROM org_app_integrations WHERE id=$1`, [
        req.integration_id,
      ]);
      const events: AppendInput[] = [];
      if (!app) {
        const dup = await one(
          tx,
          `SELECT 1 AS x FROM org_app_integrations
            WHERE org_id=$1 AND provider=$2 AND host=$3 AND app_id=$4 AND installation_id=$5 AND status='active'`,
          [req.org_id, r.identity.provider, r.identity.host, r.identity.appId, r.identity.installationId],
        );
        if (dup)
          outcome = {
            ok: false,
            code: 'app_mismatch',
            message: 'This app installation is already registered.',
          };
        else
          events.push(
            identityEvent(
              req.org_id,
              req.integration_id,
              req.label ?? r.identity.appName,
              req.user_id,
              r.identity,
            ),
          );
      } else if (!sameApp(r.identity, app)) {
        outcome = { ok: false, code: 'app_mismatch', message: APP_ERROR_TEXT.app_mismatch };
      }
      if (outcome.ok)
        events.push(
          appEvent(req.org_id, req.integration_id, req.user_id, 'OrgAppIntegrationShared', {
            integrationId: req.integration_id,
            workstationId,
            via: 'browser',
            by: req.user_id,
          }),
        );
      else {
        // the runner stored a key the organization does not use: it forgets this organization's ref again
        await queueRemove(
          tx,
          workstationId,
          req.org_id,
          req.integration_id,
          appInstance(r.identity.appId, r.identity.installationId),
        );
        touched.push(workstationId);
      }
      if (events.length) await ctx.store.append(events, { tx });
    }
    if (type === 'app.test' && r.ok && r.identity) {
      const app = await one<AppRow>(
        tx,
        `SELECT * FROM org_app_integrations WHERE id=$1 AND status='active'`,
        [req.integration_id],
      );
      if (
        app &&
        sameApp(r.identity, app) &&
        (app.bot_login !== r.identity.botLogin ||
          JSON.stringify(app.permissions) !== JSON.stringify(r.identity.permissions))
      )
        await ctx.store.append(
          [
            appEvent(req.org_id, app.id, req.user_id, 'OrgAppIntegrationUpdated', {
              integrationId: app.id,
              identity: r.identity,
              by: req.user_id,
            }),
          ],
          { tx },
        );
    }
    Object.assign(entry, outcome);
    if (state === 'pending' || state === 'needs_choice') {
      if (req.results.some((e) => e.ok)) state = 'done';
      else if (req.results.every((e) => e.ok === false))
        state = req.results.some((e) => e.code === 'choose_installation') ? 'needs_choice' : 'failed';
    }
    const installations =
      !r.ok && r.code === 'choose_installation' ? (r.installations ?? []) : req.installations;
    await exec(
      tx,
      `UPDATE app_integration_requests SET results=$2::jsonb, state=$3, installations=$4::jsonb, updated_at=$5 WHERE id=$1`,
      [
        requestId,
        JSON.stringify(req.results),
        state,
        installations ? JSON.stringify(installations) : null,
        ctx.clock.now(),
      ],
    );
  });
  deliver(ctx, touched);
}

/** After `welcome`: the apps the server still has for the organizations this workstation's user belongs to. */
export async function sendAppSync(ctx: Ctx, workstationId: string): Promise<void> {
  const cap = await one(
    ctx.pool,
    `SELECT 1 AS x FROM workstation_capabilities WHERE workstation_id=$1 AND $2 = ANY(capabilities)`,
    [workstationId, APP_INTEGRATIONS_CAPABILITY],
  );
  if (!cap) return;
  const orgs = await rows<{ org_id: string }>(
    ctx.pool,
    `SELECT om.org_id FROM org_members om JOIN workstations ws ON ws.user_id = om.user_id
      WHERE ws.id=$1 AND om.status='active'`,
    [workstationId],
  );
  const apps = await rows<{ org_id: string; id: string; app_id: string; installation_id: string }>(
    ctx.pool,
    `SELECT i.org_id, i.id, i.app_id, i.installation_id FROM org_app_integrations i
       JOIN org_app_integration_workstations w ON w.integration_id = i.id
      WHERE w.workstation_id=$1 AND i.status='active'`,
    [workstationId],
  );
  // A share answered while the runner was away is not in the projection yet: keep refs of requests still in flight.
  const pending = await rows<{
    org_id: string;
    integration_id: string;
    payload: { appRef?: string; installationId?: string };
  }>(
    ctx.pool,
    `SELECT r.org_id, r.integration_id, '{}'::jsonb AS payload FROM app_integration_requests r
      WHERE r.state IN ('pending','needs_choice') AND r.results @> $2::jsonb AND r.expires_at > $3`,
    [workstationId, JSON.stringify([{ workstationId }]), ctx.clock.now()],
  );
  if (pending.length) return; // reconcile on the next welcome, once the in-flight shares are answered
  await exec(
    ctx.pool,
    `UPDATE runner_commands SET status='failed', last_error='replaced'
      WHERE workstation_id=$1 AND type='app.sync' AND status='pending'`,
    [workstationId],
  );
  await enqueueRunnerCommand(ctx.pool, workstationId, 'app.sync', {
    orgIds: orgs.map((o) => o.org_id),
    apps: apps.map((a) => ({
      orgId: a.org_id,
      integrationId: a.id,
      instance: appInstance(a.app_id, a.installation_id),
    })),
  });
  deliver(ctx, [workstationId]);
}

/** Expires what ran out and deletes requests older than a day. */
export async function pruneAppRequests(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  await exec(
    ctx.pool,
    `UPDATE app_integration_requests SET state='expired', updated_at=$1 WHERE expires_at < $1 AND state IN ('pending','needs_choice')`,
    [now],
  );
  await exec(ctx.pool, `DELETE FROM app_integration_requests WHERE created_at < $1`, [
    new Date(now.getTime() - 24 * 3_600_000),
  ]);
}
