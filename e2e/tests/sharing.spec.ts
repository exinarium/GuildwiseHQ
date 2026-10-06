import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, GUEST, paths, SHARER } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// Two users, two browser contexts, two runners (docs/PLAN.md M3: sharing and member removal).
test.describe.configure({ mode: 'serial' });

const OWNER_HOME = paths.runnerHome('sharer');
const GUEST_HOME = paths.runnerHome('guest');
const GUEST_REPOS = join(paths.runnerHome('guest'), '..', 'repos-guest');

let owner: APIRequestContext;
let guest: APIRequestContext;
let ownerPage: Page;
let guestPage: Page;
let ownerWs: string;
let guestWs: string;
let projectId: string;
let repoId: string;
let cardRef: string;
let cardId: string;
let giaId: string;
let reyId: string;
let guestCardId: string;

const SPEC = {
  context: 'The toy project needs a feature.',
  requirements: 'Add the thing.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the tests',
};

const json = async (r: { json(): Promise<any> }) => r.json();

async function pairUser(
  api: APIRequestContext,
  name: string,
  home: string,
  repoRoot: string,
): Promise<string> {
  const { code } = await json(await api.post('/api/workstations/pairing-codes', { data: {} }));
  pairRunner(BASE_URL, code, name, home);
  addRepoRoot(repoRoot, home);
  startRunner({}, home);
  const ws = await waitFor(
    `${name} connected`,
    async () => (await json(await api.get('/api/workstations'))).workstations,
    (l) => l[0]?.connected === true,
    30_000,
  );
  // The DevOps engineer defaults to the real runtime installed on the machine; CI must never start a real session.
  const devops = (await json(await api.get('/api/agents'))).agents.find(
    (a: { isDevops: boolean }) => a.isDevops,
  );
  const r = await api.patch(`/api/agents/${devops.id}`, { data: { runtime: 'mock', model: 'mock' } });
  expect(r.status(), await r.text()).toBe(200);
  return ws[0].id as string;
}

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, SHARER);
  await inviteAndAccept(admin, GUEST);
  owner = await apiAs(SHARER.email, SHARER.password);
  guest = await apiAs(GUEST.email, GUEST.password);
  ownerPage = await (await browser.newContext({ storageState: await owner.storageState() })).newPage();
  guestPage = await (await browser.newContext({ storageState: await guest.storageState() })).newPage();
});

test("setup: two users, two workstations with runners, the owner's project with the toy repo", async () => {
  mkdirSync(GUEST_REPOS, { recursive: true });
  execFileSync('git', ['clone', paths.origin, join(GUEST_REPOS, 'toy')], { stdio: 'ignore' });
  ownerWs = await pairUser(owner, 'Owner Box', OWNER_HOME, paths.repoRoot);
  guestWs = await pairUser(guest, 'Guest Box', GUEST_HOME, GUEST_REPOS);

  const proj = await owner.post('/api/projects', { data: { key: 'SHR', name: 'Shared project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await json(proj)).project.id;
  const add = await owner.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status()).toBe(201);
  repoId = (await json(add)).repos[0].id;
});

test('AC6a: the owner invites an existing user by email; nothing is visible until it is accepted', async () => {
  await ownerPage.goto(`/projects/${projectId}/settings`);
  const form = ownerPage.getByRole('form', { name: 'Invite member' });
  await form.getByLabel('Invite by email').fill('nobody@e2e.test');
  await form.getByRole('button', { name: 'Send invitation' }).click();
  await expect(ownerPage.getByRole('alert').first()).toContainText(/no active account/i);
  await form.getByLabel('Invite by email').fill(GUEST.email);
  await form.getByRole('button', { name: 'Send invitation' }).click();
  const row = ownerPage.getByTestId(`member-${GUEST.email}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-status', 'invited');
  await expect(row).toContainText('pending');

  // the invitee cannot see the project yet, but has the invitation in the inbox
  expect((await json(await guest.get('/api/projects'))).projects).toEqual([]);
  expect((await guest.get(`/api/projects/${projectId}`)).status()).toBe(404);
  await guestPage.goto('/projects');
  const invitation = guestPage.getByTestId('invitation-SHR');
  await expect(invitation).toContainText('invited you to manage');
  await guestPage.screenshot({ path: join(paths.vaults, 'sharing-invitation.png') });
  await invitation.getByRole('button', { name: 'Accept invitation to SHR' }).click();
  await expect(guestPage.getByRole('main').getByText('Shared project')).toBeVisible();
  await expect(guestPage.getByTestId('invitation-SHR')).toHaveCount(0);
  await guestPage.goto('/p/SHR/board');
  await expect(guestPage.getByTestId('board')).toBeVisible();
  await expect(ownerPage.getByTestId(`member-${GUEST.email}`)).toBeVisible();
});

test('AC6b: the member keeps their own projects private from the owner', async () => {
  const own = await guest.post('/api/projects', { data: { key: 'GOWN', name: 'Guest private' } });
  expect(own.status()).toBe(201);
  const ownId = (await json(own)).project.id;
  expect((await json(await owner.get('/api/projects'))).projects.map((p: { key: string }) => p.key)).toEqual([
    'SHR',
  ]);
  expect((await owner.get(`/api/projects/${ownId}`)).status()).toBe(404);
  await ownerPage.goto('/projects');
  await expect(ownerPage.getByText('Guest private')).toHaveCount(0);
  await guestPage.goto('/projects');
  await expect(guestPage.getByRole('main').getByText('Guest private')).toBeVisible();
  await expect(guestPage.getByRole('main').getByText('Shared project')).toBeVisible();
});

test("AC6c: the member hires a project-scoped agent onto their own workstation from the owner's catalogue", async () => {
  await guestPage.goto('/agents');
  await guestPage.getByRole('button', { name: 'Hire agent' }).first().click();
  const form = guestPage.getByRole('form', { name: 'Hire agent' });
  await form.getByLabel('Role', { exact: true }).selectOption({ label: 'Builder' });
  await form.getByLabel('Project').selectOption({ label: 'SHR' });
  await form.getByLabel('Workstation').selectOption({ index: 0 });
  await form.getByLabel('Runtime').selectOption('mock');
  await form.getByLabel('Name', { exact: true }).fill('Gia');
  await form.getByRole('button', { name: 'Hire', exact: true }).click();
  await expect(guestPage.getByTestId('agent-Gia')).toBeVisible();
  const agents = (await json(await guest.get('/api/agents'))).agents;
  const gia = agents.find((a: { name: string }) => a.name === 'Gia');
  giaId = gia.id;
  expect(gia).toMatchObject({ projectId, workstationId: guestWs, hiredByUserId: expect.any(String) });
  // she belongs to the owner's organization (the owner's catalogue and name space apply)
  const me = await json(await owner.get('/api/auth/me'));
  expect(gia.orgId).toBe(me.user.id);
  const rey = await guest.post('/api/agents', {
    data: {
      name: 'Rey',
      roleKey: 'reviewer',
      seniority: 'senior',
      workstationId: guestWs,
      projectId,
      runtime: 'mock',
    },
  });
  expect(rey.status(), await rey.text()).toBe(201);
  reyId = (await json(rey)).id;
});

test("AC6d: that agent claims any card of the project, including the owner's, and runs it on its own workstation", async () => {
  const res = await owner.post('/api/cards', {
    data: {
      projectId,
      title: 'Owner card, member agent',
      cardType: 'feature',
      repoId,
      completionAction: 'push_branch',
      // build round 0 ok, review bounces once, rework round hangs: Gia holds the card when the owner removes her manager
      fields: { ...SPEC, mock: { build: ['ok', 'hang'], review: ['changes'] } },
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await json(res);
  cardRef = body.card.ref;
  cardId = body.card.id;
  await waitFor(
    'rework build shift running on the guest workstation',
    () =>
      q<{ rework_round: number; ws: string; agent: string; status: string }>(
        `SELECT c.rework_round, s.workstation_id AS ws, c.claimed_by_agent_id AS agent, s.status
           FROM cards c JOIN shifts s ON s.id = c.claim_shift_id WHERE c.id=$1`,
        [cardId],
      ),
    (r) => r[0]?.rework_round === 1 && r[0]?.status === 'running',
    120_000,
  );
  const row = (
    await q<{ ws: string; agent: string }>(
      `SELECT s.workstation_id AS ws, c.claimed_by_agent_id AS agent FROM cards c JOIN shifts s ON s.id = c.claim_shift_id WHERE c.id=$1`,
      [cardId],
    )
  )[0];
  expect(row).toEqual({ ws: guestWs, agent: giaId });
  // the owner's card shows on the member's board
  await guestPage.goto('/p/SHR/board');
  await expect(guestPage.getByTestId(`card-tile-${cardRef}`)).toBeVisible();
  await guestPage.screenshot({ path: join(paths.vaults, 'sharing-guest-board.png') });
});

test('AC6e: HR rights: the owner changes or fires any agent, a member only their own hires', async () => {
  const oli = await owner.post('/api/agents', {
    data: {
      name: 'Oli',
      roleKey: 'builder',
      seniority: 'junior',
      workstationId: ownerWs,
      projectId,
      runtime: 'mock',
    },
  });
  expect(oli.status(), await oli.text()).toBe(201);
  const oliId = (await json(oli)).id;

  await guestPage.goto('/agents');
  await expect(guestPage.getByTestId('agent-Gia')).toHaveAttribute('data-editable', 'true');
  await expect(guestPage.getByTestId('agent-Gia').getByRole('button', { name: 'Fire Gia' })).toBeVisible();
  const oliTile = guestPage.getByTestId('agent-Oli');
  await expect(oliTile).toHaveAttribute('data-editable', 'false');
  await expect(oliTile.getByTestId('agent-readonly')).toContainText('another manager');
  await expect(oliTile.getByRole('button', { name: 'Fire Oli' })).toHaveCount(0);
  await guestPage.screenshot({ path: join(paths.vaults, 'sharing-guest-agents.png') });

  await ownerPage.goto('/agents');
  await expect(ownerPage.getByTestId('agent-Gia')).toHaveAttribute('data-editable', 'true');
  await expect(ownerPage.getByTestId('agent-Gia').getByRole('button', { name: 'Fire Gia' })).toBeVisible();

  expect((await guest.patch(`/api/agents/${oliId}`, { data: { model: 'opus' } })).status()).toBe(403);
  expect((await guest.post(`/api/agents/${oliId}/fire`, { data: {} })).status()).toBe(403);
  expect((await owner.patch(`/api/agents/${giaId}`, { data: { effort: 'high' } })).status()).toBe(200);
  expect((await guest.patch(`/api/agents/${giaId}`, { data: { effort: 'medium' } })).status()).toBe(200);
  // Oli must not take Gia's card: fire him again (the owner may fire any agent)
  expect((await owner.post(`/api/agents/${oliId}/fire`, { data: {} })).status()).toBe(200);
});

test('decision policy: only the card owner opens the card to every manager', async () => {
  await guestPage.goto(`/cards/${cardRef}`);
  await expect(guestPage.getByTestId('decision-policy')).toHaveText('Only the card owner');
  await ownerPage.goto(`/cards/${cardRef}`);
  await ownerPage.getByLabel('Decision policy').selectOption('any_manager');
  await expect(guestPage.getByTestId('decision-policy')).toHaveText('Any manager of the project', {
    timeout: 15_000,
  });
  const rows = await q<{ decision_policy: string }>('SELECT decision_policy FROM cards WHERE id=$1', [
    cardId,
  ]);
  expect(rows[0]?.decision_policy).toBe('any_manager');
  expect(
    (await guest.post(`/api/cards/${cardId}/decision-policy`, { data: { policy: 'owner_only' } })).status(),
  ).toBe(403);
});

test('AC7a: removing the member: agents need a new home, claims are released with the last handoff, cards move to the owner', async () => {
  // a card the member owns
  const mine = await guest.post('/api/cards', {
    data: { projectId, title: 'Guest-owned card', cardType: 'feature', fields: {} },
  });
  expect(mine.status()).toBe(201);
  guestCardId = (await json(mine)).card.id;

  await ownerPage.goto(`/projects/${projectId}/settings`);
  await ownerPage.getByRole('button', { name: `Remove ${GUEST.name}` }).click();
  const preview = ownerPage.getByTestId('removal-preview');
  await expect(preview).toContainText('Agents you inherit (2)');
  await expect(preview).toContainText('Gia');
  await expect(preview).toContainText(`holds ${cardRef}`);
  await expect(preview).toContainText('Cards released to the queue (1)');
  await expect(preview).toContainText('Guest-owned card');
  await ownerPage.screenshot({ path: join(paths.vaults, 'sharing-removal-preview.png') });
  await ownerPage.getByRole('button', { name: 'Confirm removal' }).click();
  await expect(ownerPage.getByTestId(`member-${GUEST.email}`)).toHaveCount(0);

  const agents = await q<{
    id: string;
    status: string;
    manager_user_id: string;
    workstation_id: string | null;
    hired_by_user_id: string;
  }>('SELECT id, status, manager_user_id, workstation_id, hired_by_user_id FROM agents WHERE id = ANY($1)', [
    [giaId, reyId],
  ]);
  const ownerId = (await json(await owner.get('/api/auth/me'))).user.id;
  const guestId = (await json(await guest.get('/api/auth/me'))).user.id;
  for (const a of agents) {
    expect(a).toMatchObject({
      status: 'needs_rehome',
      manager_user_id: ownerId,
      workstation_id: null,
      hired_by_user_id: guestId,
    });
  }
  const released = (
    await q<{ status: string; claim_id: string | null; home_workstation_id: string | null }>(
      'SELECT status, claim_id, home_workstation_id FROM cards WHERE id=$1',
      [cardId],
    )
  )[0];
  expect(released).toEqual({ status: 'queued', claim_id: null, home_workstation_id: null });
  const rel = (
    await q<{ reason: string; last: string | null }>(
      `SELECT payload->>'reason' AS reason, payload->>'lastHandoffId' AS last FROM events
      WHERE type='ClaimReleased' AND stream_id=$1 ORDER BY seq DESC LIMIT 1`,
      [`card-${cardId}`],
    )
  )[0];
  expect(rel?.reason).toBe('member_removed');
  expect(rel?.last).toBeTruthy();
  expect(
    (await q<{ owner_user_id: string }>('SELECT owner_user_id FROM cards WHERE id=$1', [guestCardId]))[0]
      ?.owner_user_id,
  ).toBe(ownerId);

  // the member lost the project; their own project is untouched; their runner stopped the hung shift
  expect((await json(await guest.get('/api/projects'))).projects.map((p: { key: string }) => p.key)).toEqual([
    'GOWN',
  ]);
  expect((await guest.get(`/api/cards/${cardRef}`)).status()).toBe(404);
  await waitFor(
    "the member's hung shift was stopped",
    () =>
      q<{ status: string; outcome: string | null }>(
        `SELECT status, outcome FROM shifts WHERE agent_id=$1 AND status='ended' AND outcome='stopped'`,
        [giaId],
      ),
    (r) => r.length === 1,
    60_000,
  );
});

test("AC7b: re-homing onto the owner's workstation keeps name, history and the track record; she picks up her card again", async () => {
  const shiftsBefore = (
    await q<{ n: number }>('SELECT count(*)::int AS n FROM shifts WHERE agent_id=$1', [giaId])
  )[0]!.n;
  expect(shiftsBefore).toBeGreaterThanOrEqual(2);
  await ownerPage.goto('/agents');
  await expect(ownerPage.getByTestId('agent-Gia')).toContainText('needs rehome');
  await ownerPage.screenshot({ path: join(paths.vaults, 'sharing-needs-rehome.png') });
  await ownerPage.getByRole('button', { name: 'Re-home Gia' }).click();
  const form = ownerPage.getByRole('form', { name: 'Re-home agent' });
  await form.getByLabel('Workstation').selectOption({ index: 0 });
  await form.getByLabel('Runtime').selectOption('mock');
  await form.getByLabel('Model').fill('mock');
  await form.getByRole('button', { name: 'Re-home', exact: true }).click();
  await expect(ownerPage.getByTestId('agent-Gia')).not.toContainText('needs rehome');

  const gia = (
    await q<{ name: string; status: string; workstation_id: string; hired_by_user_id: string }>(
      'SELECT name, status, workstation_id, hired_by_user_id FROM agents WHERE id=$1',
      [giaId],
    )
  )[0];
  expect(gia).toMatchObject({ name: 'Gia', status: 'active', workstation_id: ownerWs });
  const events = await q<{ type: string }>(`SELECT type FROM events WHERE stream_id=$1 ORDER BY seq`, [
    `agent-${giaId}`,
  ]);
  expect(events.map((e) => e.type)).toEqual(
    expect.arrayContaining(['AgentHired', 'AgentChanged', 'AgentRehomed']),
  );
  // her earlier shifts are still hers
  expect(
    (await q<{ n: number }>('SELECT count(*)::int AS n FROM shifts WHERE agent_id=$1', [giaId]))[0]!.n,
  ).toBeGreaterThanOrEqual(shiftsBefore);

  // the released card is hers again, now on the owner's machine (rework goes to the original builder first)
  const claim = await waitFor(
    "Gia claims the released card on the owner's workstation",
    () =>
      q<{ workstation_id: string }>(
        `SELECT workstation_id FROM shifts WHERE agent_id=$1 AND card_id=$2 ORDER BY started_at DESC LIMIT 1`,
        [giaId, cardId],
      ),
    (r) => r[0]?.workstation_id === ownerWs,
    90_000,
  );
  expect(claim[0]?.workstation_id).toBe(ownerWs);
  // never held by two agents at once
  const dup = await q(
    `SELECT card_id FROM card_transitions WHERE to_status='claimed' GROUP BY card_id, event_seq HAVING count(*) > 1`,
  );
  expect(dup).toHaveLength(0);
});
