import { type APIRequestContext, expect } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../../support/api.ts';
import { q, waitFor } from '../../support/db.ts';
import { ADMIN, BASE_URL } from '../../support/env.ts';
import { stepUp } from '../../support/step-up.ts';

export interface Person {
  email: string;
  name: string;
  password: string;
}
export const person = (slug: string): Person => ({
  email: `${slug}@e2e.test`,
  name: `Combined ${slug}`,
  password: `${slug}-password-12345`,
});

/** A fresh Owner of an organization of their own (the server's own `admin:create` CLI), signed in over the API. */
export async function newOwner(p: Person): Promise<APIRequestContext> {
  await inviteAndAccept(await apiAs(ADMIN.email, ADMIN.password), p);
  return apiAs(p.email, p.password);
}

export const SPEC = {
  context: 'The toy project needs a feature.',
  requirements: 'Add the thing.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the tests',
};

export async function createProject(
  api: APIRequestContext,
  key: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await api.post('/api/projects', { data: { key, name, ...extra } });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).project.id as string;
  // cards of these projects run to Done: no manual QA gate after Finalize
  await api.put(`/api/projects/${id}/manual-qa`, { data: { enabled: false } });
  return id;
}

export async function addRepo(
  api: APIRequestContext,
  projectId: string,
  origin: string,
  name: string,
  workingBranch = 'main',
): Promise<string> {
  const res = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name, remoteUrl: origin, workingBranch },
  });
  expect(res.status(), await res.text()).toBe(201);
  const repos = (await res.json()).repos as Array<{ id: string; name: string }>;
  return (repos.find((r) => r.name === name) ?? repos[0])?.id as string;
}

export async function hire(
  api: APIRequestContext,
  o: { name: string; roleKey: string; seniority?: string; workstationId: string; projectId: string },
): Promise<string> {
  const res = await api.post('/api/agents', {
    data: { seniority: 'junior', runtime: 'mock', ...o },
  });
  expect(res.status(), `${o.name}: ${await res.text()}`).toBe(201);
  return (await res.json()).id as string;
}

export async function createCard(
  api: APIRequestContext,
  o: {
    projectId: string;
    repoId: string;
    title: string;
    fields?: Record<string, unknown>;
    mock?: Record<string, string[]>;
    extra?: Record<string, unknown>;
  },
): Promise<string> {
  const res = await api.post('/api/cards', {
    data: {
      projectId: o.projectId,
      title: o.title,
      cardType: 'feature',
      repoId: o.repoId,
      completionAction: 'merge',
      fields: { ...SPEC, ...(o.fields ?? {}), ...(o.mock ? { mock: o.mock } : {}) },
      specify: true,
      ...(o.extra ?? {}),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).card.ref as string;
}

export interface CardRow {
  id: string;
  ref: string;
  stage: string;
  status: string;
}
export const cardRow = async (ref: string): Promise<CardRow | undefined> =>
  (await q<CardRow>('SELECT id, ref, stage, status FROM cards WHERE ref=$1', [ref]))[0];
export const waitCard = (
  ref: string,
  what: string,
  pred: (c: CardRow | undefined) => boolean,
  ms = 180_000,
) => waitFor(`${ref} ${what}`, () => cardRow(ref), pred, ms);

/** How many events of this type exist (optionally whose payload text contains `like`). */
export async function eventCount(type: string, like?: string): Promise<number> {
  const r = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM events WHERE type=$1 ${like ? `AND payload::text LIKE $2` : ''}`,
    like ? [type, `%${like}%`] : [type],
  );
  return r[0]?.n ?? 0;
}

export interface DeskRow {
  id: string;
  kind: string;
  subkind: string | null;
  title: string;
  body: string;
  status: string;
  data: Record<string, unknown>;
}
export const deskItems = (subkind?: string, projectId?: string): Promise<DeskRow[]> =>
  q<DeskRow>(
    `SELECT id, kind, subkind, title, body, status, data FROM desk_items
      WHERE ($1::text IS NULL OR subkind=$1) AND ($2::uuid IS NULL OR project_id=$2) ORDER BY created_at`,
    [subkind ?? null, projectId ?? null],
  );

export interface DevopsRequestRow {
  id: string;
  status: string;
  summary: string;
  shift_id: string | null;
  approval: { resolution?: string | null; blockedBy?: string } | null;
}
export const devopsRequest = async (id: string): Promise<DevopsRequestRow | undefined> =>
  (
    await q<DevopsRequestRow>(
      'SELECT id, status, summary, shift_id, approval FROM devops_requests WHERE id=$1',
      [id],
    )
  )[0];

/** Sends a DevOps request (what the CEO chat and the Workstations form send) and returns its id. */
export async function sendDevopsRequest(
  api: APIRequestContext,
  workstationId: string,
  summary: string,
): Promise<string> {
  const res = await api.post('/api/devops/requests', { data: { workstationId, summary } });
  expect(res.status(), await res.text()).toBeLessThan(300);
  const body = await res.json();
  return (body.id ?? body.request?.id) as string;
}

export async function waitRequest(
  id: string,
  what: string,
  pred: (r: DevopsRequestRow | undefined) => boolean,
  ms = 120_000,
): Promise<DevopsRequestRow | undefined> {
  const r = await waitFor(`devops request ${what}`, () => devopsRequest(id), pred, ms);
  if (r?.status === 'done' || r?.status === 'failed') {
    // the request is done when the agent reports; the runner's last card-worktree check and `shift.ended` come a moment
    // later. The next scenario must not start (or write in a worktree) before that, or it would be swept into this shift.
    await waitFor(
      'every devops shift ended',
      () => q<{ n: number }>(`SELECT count(*)::int AS n FROM shifts WHERE kind='devops' AND status<>'ended'`),
      (x) => x[0]?.n === 0,
      ms,
    );
  }
  return r;
}

/** The workstation's DevOps engineer and the organization it serves (for the local grant in policy.json). */
export async function devopsAgentOf(workstationId: string): Promise<{ agentId: string; orgId: string }> {
  const r = await waitFor(
    'the DevOps engineer of the workstation',
    () =>
      q<{ id: string; org_id: string }>(
        `SELECT id, org_id FROM agents WHERE is_devops AND status='active' AND workstation_id=$1`,
        [workstationId],
      ),
    (x) => x.length === 1,
    60_000,
  );
  return { agentId: r[0]?.id as string, orgId: r[0]?.org_id as string };
}

/** The ShiftEnded guard violations of a shift (what the runner refused or reverted), from the event log. */
export async function guardViolations(shiftId: string): Promise<Array<{ rule: string; detail: string }>> {
  const r = await q<{ payload: { guardViolations?: Array<{ rule: string; detail: string }> } }>(
    `SELECT payload FROM events WHERE type='ShiftEnded' AND payload->>'shiftId'=$1`,
    [shiftId],
  );
  return r.flatMap((x) => x.payload.guardViolations ?? []);
}

/** The card has left the build step for the review step (or further): its builder shift ended and handed off. */
export async function waitBuilt(ref: string, ms = 180_000): Promise<void> {
  await waitCard(
    ref,
    'built (in review or later)',
    (c) => !!c && (['review', 'test', 'finalize'].includes(c.stage) || c.status === 'done'),
    ms,
  );
  // the report moves the card at once; the shift itself (and its progress, its leftovers commit) ends a moment later
  await waitFor(
    `the build shift of ${ref} ended`,
    () =>
      q<{ n: number }>(
        `SELECT count(*)::int AS n FROM shifts s JOIN cards c ON c.id=s.card_id WHERE c.ref=$1 AND s.stage='build' AND s.status<>'ended'`,
        [ref],
      ),
    (r) => r[0]?.n === 0,
    ms,
  );
}

/** What the shifts of a card (or DevOps request) said while they ran (the progress tails the runner reported). */
export async function progressText(ref: string): Promise<string> {
  const r = await q<{ progress_tail: Array<{ text: string }> }>(
    `SELECT s.progress_tail FROM shifts s JOIN cards c ON c.id=s.card_id WHERE c.ref=$1`,
    [ref],
  );
  return r.flatMap((x) => x.progress_tail.map((t) => t.text)).join('\n');
}

/** The shifts a DevOps request got, oldest first (the request's own shift_id is cleared when it ends). */
export async function shiftsOfRequest(reqId: string): Promise<string[]> {
  const r = await q<{ id: string }>(
    `SELECT payload->>'shiftId' AS id FROM events WHERE type='DevOpsShiftDispatched' AND payload->>'requestId'=$1 ORDER BY created_at, id`,
    [reqId],
  );
  return r.map((x) => x.id);
}

/**
 * A pairing code the way a person gets one: after "Confirm it's you" (step-up). The run's server keeps a sign-in fresh for a
 * day (AOM_STEP_UP_WINDOW_SEC=86400), but doing the step-up here means the harness also covers a server that asks for it on
 * pairing-code and installer-link creation (task final-gaps) without any change.
 */
export async function pairingCode(api: APIRequestContext, password: string): Promise<string> {
  await stepUp(api, { password });
  const res = await api.post('/api/workstations/pairing-codes', { data: {} });
  expect(res.status(), await res.text()).toBeLessThan(300);
  return (await res.json()).code as string;
}

/** The server's test clock moves forward (AOM_TEST_CLOCK): leases lapse, limits end, without a real wait. */
export async function advanceClock(ms: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify({ advanceMs: ms }),
  });
  expect(res.ok).toBe(true);
}
