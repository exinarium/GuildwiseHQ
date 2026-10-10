import { randomUUID } from 'node:crypto';
import {
  type CloudAuthMode,
  type CloudProvider,
  type CloudState,
  type CloudWorkstation,
  type CreateCodespaceRequest,
  type CreateVpsRequest,
  estimateMonthlyCost,
  type OfficeHours,
  officeHoursPerMonth,
  type PatchCloudWorkstationRequest,
  type RunnerEnrollRequest,
  streamId,
} from '@aom/shared';
import { decryptSecret, encryptSecret } from '../auth/secrets.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { createInstallerSession } from '../commands/installer.ts';
import { createPairingCode, pairRunner, unlinkWorkstation } from '../commands/workstations.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, HttpError, notFound, unprocessable } from '../errors.ts';
import { GithubError } from './github.ts';
import { cloudProblemMail } from './mail.ts';
import { SshError } from './ssh.ts';

/** The services behind cloud workstations; tests replace `ssh` and `github` with stubs (no real network). */
export interface CloudServices {
  ssh: import('./ssh.ts').SshConnector;
  github: import('./github.ts').GithubApi;
  /** Installs running in the background; tests await them. */
  pending: Set<Promise<unknown>>;
}

export const DEFAULT_DEVCONTAINER_PATH = '.devcontainer/guildwise/devcontainer.json';

type User = Pick<AuthSession['user'], 'id'> & Partial<AuthSession['user']>;

// ------------------------------------------------------------------------------------------------ reading

const BASE_SQL = `
  SELECT cw.*, w.connected AS ws_connected
    FROM cloud_workstations cw LEFT JOIN workstations w ON w.id = cw.workstation_id
   WHERE cw.removed_at IS NULL`;

function locationOf(r: Row): string {
  const c = r.config as Record<string, any>;
  return r.provider === 'ssh'
    ? `${c.username}@${c.host}:${c.port}`
    : `${c.repo} (${c.machine ?? 'default machine'})`;
}

export function toDto(r: Row): CloudWorkstation {
  const hours = (r.office_hours ?? null) as OfficeHours | null;
  const est =
    r.provider === 'ssh'
      ? estimateMonthlyCost({
          provider: 'ssh',
          monthlyPriceUsd: r.monthly_price_usd === null ? null : Number(r.monthly_price_usd),
        })
      : estimateMonthlyCost({
          provider: 'codespaces',
          machine: String((r.config as Row).machine ?? ''),
          hoursPerMonth: officeHoursPerMonth(hours),
        });
  return {
    id: r.id,
    provider: r.provider as CloudProvider,
    name: r.name,
    projectId: r.project_id ?? null,
    state: r.state as CloudState,
    stateDetail: r.state_detail ?? '',
    workstationId: r.workstation_id ?? null,
    connected: r.ws_connected === true,
    idleMinutes: r.idle_minutes,
    officeHours: hours,
    authMode: r.auth_mode as CloudAuthMode,
    location: locationOf(r),
    manualPower: r.provider === 'ssh',
    canDeployDocker: r.provider === 'ssh',
    monthlyEstimateUsd: est.monthlyUsd,
    estimateBasis: est.basis,
    lastActivityAt: iso(r.last_activity_at),
    createdAt: iso(r.created_at) as string,
  };
}

export async function listCloud(
  ctx: Ctx,
  orgId: string,
): Promise<{ cloudWorkstations: CloudWorkstation[]; hasDockerCapableWorkstation: boolean }> {
  const list = await rows(ctx.pool, `${BASE_SQL} AND cw.org_id=$1 ORDER BY cw.created_at`, [orgId]);
  // A Docker deploy needs a workstation or VPS: any active paired workstation of an organization member that is not a
  // Codespace counts.
  const docker = await one(
    ctx.pool,
    `SELECT 1 FROM workstations w JOIN org_members om ON om.user_id = w.user_id AND om.org_id=$1 AND om.status='active'
      WHERE w.status='active'
        AND NOT EXISTS (SELECT 1 FROM cloud_workstations c WHERE c.workstation_id = w.id AND c.provider='codespaces')
      LIMIT 1`,
    [orgId],
  );
  return { cloudWorkstations: list.map(toDto), hasDockerCapableWorkstation: !!docker };
}

async function load(ctx: Ctx, orgId: string, id: string): Promise<Row> {
  const r = await one(ctx.pool, `${BASE_SQL} AND cw.id=$1 AND cw.org_id=$2`, [id, orgId]);
  if (!r) throw notFound('cloud workstation not found');
  return r;
}

export async function getCloud(ctx: Ctx, orgId: string, id: string): Promise<CloudWorkstation> {
  return toDto(await load(ctx, orgId, id));
}

async function assertSlotFree(ctx: Ctx, orgId: string, projectId: string | null): Promise<void> {
  const taken = await one(
    ctx.pool,
    `SELECT 1 FROM cloud_workstations WHERE org_id=$1 AND removed_at IS NULL
        AND project_id IS NOT DISTINCT FROM $2::uuid LIMIT 1`,
    [orgId, projectId],
  );
  if (taken)
    throw conflict(
      'cloud_workstation_exists',
      projectId
        ? 'this project already has a cloud workstation'
        : 'this organization already has a cloud workstation (choose a project to add one for it, or remove the existing one)',
    );
  if (projectId) {
    const p = await one(ctx.pool, `SELECT 1 FROM projects WHERE id=$1 AND org_id=$2`, [projectId, orgId]);
    if (!p) throw notFound('project not found');
  }
}

async function setState(
  ctx: Ctx,
  id: string,
  state: CloudState,
  detail = '',
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = ctx.clock.now();
  const sets = ['state=$2', 'state_detail=$3', 'updated_at=$4'];
  const params: unknown[] = [id, state, detail.slice(0, 600), now];
  for (const [k, v] of Object.entries(extra)) {
    params.push(v);
    sets.push(`${k}=$${params.length}`);
  }
  if (state === 'running') sets.push('problem_notified_at=NULL');
  await exec(ctx.pool, `UPDATE cloud_workstations SET ${sets.join(', ')} WHERE id=$1`, params);
}

// ------------------------------------------------------------------------------------------------ VPS over SSH

export interface VpsCredentials {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/** Creates the record and starts the install in the background; the credentials live only in that closure. */
export async function createVps(
  ctx: Ctx,
  user: User,
  orgId: string,
  input: CreateVpsRequest,
): Promise<CloudWorkstation> {
  await assertSlotFree(ctx, orgId, input.projectId);
  const id = randomUUID();
  const now = ctx.clock.now();
  await ctx.pool.query(
    `INSERT INTO cloud_workstations
       (id, org_id, project_id, user_id, provider, name, state, state_detail, config, auth_mode,
        monthly_price_usd, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'ssh',$5,'installing','Connecting to the server',$6,$7,$8,$9,$9)`,
    [
      id,
      orgId,
      input.projectId,
      user.id,
      input.name,
      JSON.stringify({
        host: input.host,
        port: input.port,
        username: input.username,
        hostFingerprint: input.hostFingerprint ?? null,
      }),
      input.authMode,
      input.monthlyPriceUsd,
      now,
    ],
  );
  const creds: VpsCredentials = {
    password: input.password,
    privateKey: input.privateKey,
    passphrase: input.passphrase,
  };
  const job = installVps(ctx, user, id, input, creds)
    .catch((err) => {
      ctx.log.error({ err: String(err?.message ?? err) }, 'cloud workstation install crashed');
      return setState(ctx, id, 'failed', 'The install stopped unexpectedly. Try again.');
    })
    .finally(() => ctx.services.cloud.pending.delete(job));
  ctx.services.cloud.pending.add(job);
  return getCloud(ctx, orgId, id);
}

const sshMessage = (e: unknown): string =>
  e instanceof SshError
    ? e.kind === 'auth'
      ? 'The server refused the login. Check the user name and the password or key.'
      : e.message
    : 'Could not connect.';

async function installVps(
  ctx: Ctx,
  user: User,
  id: string,
  input: CreateVpsRequest,
  creds: VpsCredentials,
): Promise<void> {
  const orgRow = await one(ctx.pool, 'SELECT config FROM cloud_workstations WHERE id=$1', [id]);
  const prior = (orgRow?.config ?? {}) as { hostFingerprint?: string | null };
  let session: import('./ssh.ts').SshSession | undefined;
  try {
    session = await ctx.services.cloud.ssh.connect({
      host: input.host,
      port: input.port,
      username: input.username,
      ...creds,
      expectedFingerprint: prior.hostFingerprint ?? undefined,
    });
  } catch (e) {
    await setState(ctx, id, 'failed', sshMessage(e));
    return;
  }
  try {
    // Remember the host key we saw: the next connection must present the same one.
    await exec(
      ctx.pool,
      `UPDATE cloud_workstations SET config = config || jsonb_build_object('hostFingerprint', $2::text) WHERE id=$1`,
      [id, session.fingerprint],
    );
    await setState(ctx, id, 'installing', 'Installing the runner (this takes a few minutes)');
    // The same installer a person would paste into a terminal, run unattended with a fresh one-time pairing code.
    const inst = await createInstallerSession(ctx, user as AuthSession['user'], {
      os: 'linux',
      name: input.name,
    });
    const url = inst.downloadUrl.replace(/\?download=1$/, '');
    const env = [
      'GUILDWISE_YES=1',
      'GUILDWISE_SKIP_CLAUDE=1',
      input.username === 'root' ? 'GUILDWISE_ALLOW_ROOT=1' : '',
      `GUILDWISE_NAME=${shellQuote(input.name)}`,
    ]
      .filter(Boolean)
      .join(' ');
    const res = await session.exec(`curl -fsSL ${shellQuote(url)} | ${env} bash 2>&1`);
    if (res.code !== 0) {
      await setState(
        ctx,
        id,
        'failed',
        `The installer stopped (exit ${res.code}). ${tail(res.stdout || res.stderr)}`,
      );
      return;
    }
    const paired = await one(
      ctx.pool,
      `SELECT c.workstation_id FROM installer_sessions i JOIN pairing_codes c ON c.id = i.pairing_code_id
        WHERE i.id=$1`,
      [inst.id],
    );
    if (!paired?.workstation_id) {
      await setState(ctx, id, 'failed', 'The runner was installed but did not pair. Try again.');
      return;
    }
    const now = ctx.clock.now();
    await setState(
      ctx,
      id,
      'running',
      input.authMode === 'api_key'
        ? 'Installed and paired. Last step: sign in to your Anthropic API key on the server (see the instructions).'
        : 'Installed and paired. Last step: sign in to Claude on the server (see the instructions).',
      { workstation_id: paired.workstation_id, last_activity_at: now, last_wake_at: now },
    );
  } catch (e) {
    await setState(
      ctx,
      id,
      'failed',
      e instanceof SshError ? sshMessage(e) : 'The install failed. Try again.',
    );
  } finally {
    session.close(); // the credentials go with the session
  }
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const tail = (s: string): string => s.trim().split('\n').slice(-3).join(' ').slice(-300);

// ------------------------------------------------------------------------------------------------ GitHub

export async function connectGithub(ctx: Ctx, user: User, token: string): Promise<{ login: string }> {
  let login: string;
  try {
    login = (await ctx.services.cloud.github.user(token)).login;
  } catch (e) {
    if (e instanceof GithubError && e.kind === 'auth')
      throw unprocessable('github_token_invalid', 'GitHub did not accept this token');
    throw unprocessable('github_unreachable', 'Could not reach GitHub to check the token');
  }
  await ctx.pool.query(
    `INSERT INTO cloud_github_connections (user_id, login, token_enc, updated_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET login=$2, token_enc=$3, updated_at=$4`,
    [user.id, login, await encryptSecret(ctx, token), ctx.clock.now()],
  );
  return { login };
}

export async function githubConnection(
  ctx: Ctx,
  userId: string,
): Promise<{ connected: boolean; login: string | null }> {
  const r = await one(ctx.pool, 'SELECT login FROM cloud_github_connections WHERE user_id=$1', [userId]);
  return { connected: !!r, login: r?.login ?? null };
}

export async function disconnectGithub(ctx: Ctx, userId: string): Promise<void> {
  await exec(ctx.pool, 'DELETE FROM cloud_github_connections WHERE user_id=$1', [userId]);
}

async function tokenOf(ctx: Ctx, userId: string): Promise<string> {
  const r = await one(ctx.pool, 'SELECT token_enc FROM cloud_github_connections WHERE user_id=$1', [userId]);
  if (!r) throw conflict('github_not_connected', 'connect your GitHub account first');
  return decryptSecret(ctx, r.token_enc);
}

function mapGithub(e: unknown): never {
  if (e instanceof GithubError) {
    if (e.kind === 'auth')
      throw new HttpError(
        409,
        'github_token_invalid',
        'GitHub no longer accepts your saved token: connect again',
      );
    if (e.kind === 'billing')
      throw new HttpError(
        402,
        'github_billing',
        `GitHub says: ${e.message}. Check your Codespaces billing and credits.`,
      );
    if (e.kind === 'missing')
      throw notFound('GitHub does not know that repository or codespace (or the token cannot see it)');
    throw unprocessable('github_error', `GitHub: ${e.message}`);
  }
  throw e;
}

export async function codespaceMachines(ctx: Ctx, user: User, repo: string) {
  try {
    return await ctx.services.cloud.github.machines(await tokenOf(ctx, user.id), repo);
  } catch (e) {
    return mapGithub(e);
  }
}

export async function createCodespace(
  ctx: Ctx,
  user: User,
  orgId: string,
  input: CreateCodespaceRequest,
): Promise<CloudWorkstation> {
  await assertSlotFree(ctx, orgId, input.projectId);
  const token = await tokenOf(ctx, user.id);
  const gh = ctx.services.cloud.github;
  let info: Awaited<ReturnType<typeof gh.create>>;
  try {
    if (!(await gh.fileExists(token, input.repo, input.devcontainerPath, input.ref)))
      throw unprocessable(
        'devcontainer_missing',
        `${input.repo} has no ${input.devcontainerPath}. Add the file we generate for you to the repository first.`,
      );
    info = await gh.create(token, {
      repo: input.repo,
      machine: input.machine,
      ref: input.ref,
      devcontainerPath: input.devcontainerPath,
      idleMinutes: 240, // GitHub's own limit is the maximum; Guildwise stops it sooner (idle_minutes)
    });
  } catch (e) {
    return mapGithub(e);
  }
  const id = randomUUID();
  const now = ctx.clock.now();
  await ctx.pool.query(
    `INSERT INTO cloud_workstations
       (id, org_id, project_id, user_id, provider, name, state, state_detail, config, auth_mode, last_wake_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'codespaces',$5,'starting','GitHub is creating the codespace',$6,$7,$8,$8,$8)`,
    [
      id,
      orgId,
      input.projectId,
      user.id,
      input.name,
      JSON.stringify({
        repo: input.repo,
        machine: input.machine,
        ref: input.ref ?? null,
        devcontainerPath: input.devcontainerPath,
        codespaceName: info.name,
      }),
      input.authMode,
      now,
    ],
  );
  return getCloud(ctx, orgId, id);
}

/**
 * `aom-runner up` inside a codespace we created. The proof is the codespace's name plus the codespace's own GitHub
 * token, which must belong to the GitHub account that created it. Nothing secret is in the devcontainer file.
 */
export async function enrollCodespace(ctx: Ctx, input: RunnerEnrollRequest) {
  const deny = () => new HttpError(401, 'invalid_enrollment', 'this codespace is not known here');
  const cw = await one(
    ctx.pool,
    `SELECT cw.*, g.login AS gh_login FROM cloud_workstations cw
       LEFT JOIN cloud_github_connections g ON g.user_id = cw.user_id
      WHERE cw.provider='codespaces' AND cw.removed_at IS NULL AND cw.config->>'codespaceName' = $1`,
    [input.codespaceName],
  );
  if (!cw?.gh_login) throw deny();
  let login: string;
  try {
    login = (await ctx.services.cloud.github.user(input.githubToken)).login;
  } catch {
    throw deny();
  }
  if (login.toLowerCase() !== String(cw.gh_login).toLowerCase()) throw deny();
  // A second enrollment (the codespace was rebuilt) replaces the old workstation, but only while it is not connected.
  if (cw.workstation_id) {
    const ws = await one(ctx.pool, 'SELECT connected FROM workstations WHERE id=$1', [cw.workstation_id]);
    if (ws?.connected) throw conflict('already_enrolled', 'this codespace is already connected');
    await unlinkWorkstation(ctx, { id: cw.user_id } as AuthSession['user'], cw.workstation_id).catch(
      () => {},
    );
  }
  const code = await createPairingCode(ctx, { id: cw.user_id } as AuthSession['user'], { ttlMs: 2 * 60_000 });
  const paired = await pairRunner(ctx, {
    code: code.code,
    name: input.name,
    platform: input.platform,
    hostname: input.hostname,
    runnerVersion: input.runnerVersion,
  });
  const now = ctx.clock.now();
  await setState(ctx, cw.id, 'running', '', {
    workstation_id: paired.workstationId,
    enroll_done_at: now,
    last_activity_at: now,
  });
  return paired;
}

// ------------------------------------------------------------------------------------------------ power

export async function wake(ctx: Ctx, orgId: string, id: string): Promise<CloudWorkstation> {
  const r = await load(ctx, orgId, id);
  if (r.provider === 'ssh')
    throw conflict(
      'manual_power',
      'A VPS is always on; start it at your VPS company if it was switched off.',
    );
  await wakeRow(ctx, r);
  return getCloud(ctx, orgId, id);
}

export async function wakeRow(ctx: Ctx, r: Row): Promise<boolean> {
  if (r.state === 'running' || r.state === 'starting') return true;
  try {
    const token = await tokenOf(ctx, r.user_id);
    await ctx.services.cloud.github.start(token, (r.config as Row).codespaceName);
    await setState(ctx, r.id, 'starting', 'Waking the codespace', { last_wake_at: ctx.clock.now() });
    return true;
  } catch (e) {
    await problem(ctx, r, e);
    return false;
  }
}

export async function stop(ctx: Ctx, orgId: string, id: string): Promise<CloudWorkstation> {
  const r = await load(ctx, orgId, id);
  if (r.provider === 'ssh')
    throw conflict('manual_power', 'Guildwise cannot switch a VPS off. Stop it at your VPS company.');
  await stopRow(ctx, r, 'Stopped');
  return getCloud(ctx, orgId, id);
}

export async function stopRow(ctx: Ctx, r: Row, detail: string): Promise<boolean> {
  try {
    const token = await tokenOf(ctx, r.user_id);
    await ctx.services.cloud.github.stop(token, (r.config as Row).codespaceName);
    await setState(ctx, r.id, 'stopped', detail);
    return true;
  } catch (e) {
    if (e instanceof GithubError && e.kind === 'missing') {
      await problem(ctx, r, e);
      return false;
    }
    ctx.log.warn({ id: r.id, err: String((e as Error)?.message ?? e) }, 'could not stop the codespace');
    return false;
  }
}

export async function patchCloud(
  ctx: Ctx,
  orgId: string,
  id: string,
  p: PatchCloudWorkstationRequest,
): Promise<CloudWorkstation> {
  await load(ctx, orgId, id);
  const sets: string[] = ['updated_at=$2'];
  const params: unknown[] = [id, ctx.clock.now()];
  const add = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col}=$${params.length}`);
  };
  if (p.name !== undefined) add('name', p.name);
  if (p.idleMinutes !== undefined) add('idle_minutes', p.idleMinutes);
  if (p.officeHours !== undefined)
    add('office_hours', p.officeHours === null ? null : JSON.stringify(p.officeHours));
  if (p.monthlyPriceUsd !== undefined) add('monthly_price_usd', p.monthlyPriceUsd);
  await exec(ctx.pool, `UPDATE cloud_workstations SET ${sets.join(', ')} WHERE id=$1`, params);
  return getCloud(ctx, orgId, id);
}

/** Forgets the cloud workstation and unlinks its runner. The machine itself stays (and keeps costing money) until you delete it at the provider. */
export async function removeCloud(ctx: Ctx, orgId: string, id: string): Promise<void> {
  const r = await load(ctx, orgId, id);
  if (r.provider === 'codespaces' && r.state === 'running') await stopRow(ctx, r, 'Stopped').catch(() => {});
  await exec(ctx.pool, 'UPDATE cloud_workstations SET removed_at=$2, updated_at=$2 WHERE id=$1', [
    id,
    ctx.clock.now(),
  ]);
  if (r.workstation_id)
    await unlinkWorkstation(ctx, { id: r.user_id } as AuthSession['user'], r.workstation_id).catch(() => {});
}

// ------------------------------------------------------------------------------------------------ problems

/**
 * Codespaces billing or credits ran out, the token stopped working, or the codespace cannot start: mark it, and tell
 * the user once (a desk notice and an email) until it runs again.
 */
export async function problem(ctx: Ctx, r: Row, e: unknown): Promise<void> {
  let kind: 'billing' | 'auth' | 'missing' | 'other' = 'other';
  let text = 'The codespace could not be started.';
  if (e instanceof GithubError) {
    kind = e.kind;
    text =
      e.kind === 'billing'
        ? `GitHub refused to start it: ${e.message}. Your Codespaces credits or spending limit may have run out.`
        : e.kind === 'auth'
          ? 'GitHub no longer accepts your saved token. Connect GitHub again.'
          : e.kind === 'missing'
            ? 'GitHub cannot find the codespace any more. It may have been deleted.'
            : `GitHub could not start it: ${e.message}`;
  } else if (e instanceof HttpError) text = e.message;
  await setState(ctx, r.id, 'needs_attention', text);
  await notifyProblem(ctx, r, kind, text);
}

export async function notifyProblem(ctx: Ctx, r: Row, kind: string, text: string): Promise<void> {
  const claimed = await one(
    ctx.pool,
    `UPDATE cloud_workstations SET problem_notified_at=$2 WHERE id=$1 AND problem_notified_at IS NULL RETURNING id`,
    [r.id, ctx.clock.now()],
  );
  if (!claimed) return;
  const title =
    kind === 'billing'
      ? `Codespaces credits ran out for "${r.name}"`
      : `The cloud workstation "${r.name}" needs attention`;
  const body = `${text} Agents cannot use this workstation until it runs again. You pay GitHub for Codespaces, not Guildwise: check your GitHub billing, then press "Wake" on the Workstations page.`;
  const deskId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    await ctx.store.append(
      [
        {
          streamId: streamId.desk(deskId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId: deskId,
              kind: 'alert',
              subkind: 'cloud_workstation_problem',
              title,
              body,
              options: [],
              blocking: false,
              pinned: true,
              affectedCardIds: [],
              askedBy: { kind: 'system' },
              addresseeUserId: r.user_id,
              data: {
                fingerprint: `cloud:${r.id}:${kind}:${ctx.clock.now().toISOString()}`,
                cloudWorkstationId: r.id,
              },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(r.org_id),
        },
      ],
      { tx },
    );
  });
  const u = await one(ctx.pool, `SELECT email FROM users WHERE id=$1 AND status='active'`, [r.user_id]);
  if (u?.email) {
    try {
      await ctx.mailer.send({
        ...cloudProblemMail({
          to: u.email,
          name: r.name,
          title,
          text: body,
          origin: ctx.config.publicOrigin,
        }),
        orgId: r.org_id,
      });
    } catch (err) {
      ctx.log.warn({ err: String((err as Error)?.message ?? err) }, 'cloud workstation mail failed');
    }
  }
}
