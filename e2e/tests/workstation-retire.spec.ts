import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { pool, q } from '../support/db.ts';
import { ADMIN, BASE_URL, paths } from '../support/env.ts';
import { deleteMailFor, waitForMail } from '../support/mail.ts';
import { pairRunner } from '../support/runner.ts';

// Retiring a workstation hands its agents over: move them all to another workstation, or mark them as needing a new
// home. A retired workstation is unpaired, holds no agent and is no longer offered as a target. Refused while one of its
// agents is in a shift (the dialog names them). Owner/Admin only: a Member gets 403 and sees no Retire action.
// Standalone: one Owner with paired mock workstations (no runner process), an Admin and a Member invited by mail.
test.describe.configure({ mode: 'serial' });

const RETIRER = { email: 'retirer@e2e.test', name: 'E2E Retirer', password: 'retirer-password-12345' };
const RETADMIN = { email: 'retadmin@e2e.test', name: 'E2E RetAdmin', password: 'retadmin-password-12345' };
const RETMEM = { email: 'retmem@e2e.test', name: 'E2E RetMem', password: 'retmem-password-12345' };

let page: Page;
let api: APIRequestContext;
let orgId: string;
const ws = {} as Record<'old' | 'target' | 'spare' | 'busy' | 'empty' | 'gone', string>;
const agents = {} as Record<'alder' | 'aspen' | 'cedar' | 'cypress' | 'elm' | 'fir', string>;

async function pair(as: APIRequestContext, name: string): Promise<string> {
  const code = (await (await as.post('/api/workstations/pairing-codes', { data: {} })).json()).code as string;
  pairRunner(BASE_URL, code, name, paths.runnerHome(`retire-${name.replace(/\W+/g, '-').toLowerCase()}`));
  const list = (await (await as.get('/api/workstations')).json()).workstations as Array<{ id: string; name: string }>;
  const id = list.find((w) => w.name === name)?.id;
  expect(id, `paired ${name}`).toBeTruthy();
  return id as string;
}

async function hire(as: APIRequestContext, name: string, workstationId: string): Promise<string> {
  const r = await as.post('/api/agents', {
    data: { name, roleKey: 'builder', seniority: 'junior', workstationId, runtime: 'mock' },
  });
  expect(r.status(), await r.text()).toBe(201);
  const body = await r.json();
  return (body.agent?.id ?? body.id) as string;
}

/** Invites `who` into the Retirer's organization by mail and accepts with a new account; returns their API client. */
async function join(who: typeof RETMEM, role: 'admin' | 'member'): Promise<APIRequestContext> {
  await deleteMailFor(who.email);
  const inv = await api.post('/api/org/invitations', { data: { email: who.email, role } });
  expect(inv.ok(), await inv.text()).toBeTruthy();
  const mail = await waitForMail(who.email);
  const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] as string;
  expect(token).toBeTruthy();
  const ctx = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } });
  const acc = await ctx.post(`/api/invitations/${token}/accept`, {
    data: { displayName: who.name, password: who.password },
  });
  expect(acc.status(), await acc.text()).toBe(201);
  return ctx;
}

const agentRow = async (id: string) =>
  (await q<{ status: string; workstation_id: string | null }>('SELECT status, workstation_id FROM agents WHERE id=$1', [id]))[0]!;
const wsStatus = async (id: string) =>
  (await q<{ status: string }>('SELECT status FROM workstations WHERE id=$1', [id]))[0]!.status;
const leftOn = async (id: string) =>
  Number(
    (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM agents WHERE workstation_id=$1 AND status <> 'retired'`,
        [id],
      )
    )[0]!.n,
  );
const eventsOf = (type: string, stream: string) =>
  q<{ org_id: string; actor_id: string; payload: any }>(
    'SELECT org_id, actor_id, payload FROM events WHERE type=$1 AND stream_id=$2 ORDER BY seq',
    [type, stream],
  );

async function openRetire(name: string) {
  await page.goto('/workstations');
  await page.getByRole('button', { name: `Retire ${name}`, exact: true }).click();
  const form = page.getByRole('form', { name: 'Retire workstation' });
  await expect(form).toBeVisible();
  return form;
}

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, RETIRER);
  api = await apiAs(RETIRER.email, RETIRER.password);
  orgId = (await (await api.get('/api/org')).json()).id;
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  ws.old = await pair(api, 'Ret Old');
  ws.target = await pair(api, 'Ret New');
  ws.spare = await pair(api, 'Ret Spare');
  ws.busy = await pair(api, 'Ret Busy');
  ws.empty = await pair(api, 'Ret Empty');
  ws.gone = await pair(api, 'Ret Gone');
  agents.alder = await hire(api, 'Alder', ws.old);
  agents.aspen = await hire(api, 'Aspen', ws.old);
  agents.cedar = await hire(api, 'Cedar', ws.spare);
  agents.cypress = await hire(api, 'Cypress', ws.spare);
  agents.elm = await hire(api, 'Elm', ws.busy);
  agents.fir = await hire(api, 'Fir', ws.gone);
});
test.afterAll(async () => {
  await pool.end();
});

test('AC6: a Member sees no Retire action and gets 403 from the preview and the retirement', async ({ browser }) => {
  const member = await join(RETMEM, 'member');
  const own = await pair(member, 'Mem Box');
  const mp = await (await browser.newContext({ storageState: await member.storageState() })).newPage();
  await mp.goto('/workstations');
  await expect(mp.getByRole('button', { name: 'Unpair Mem Box' })).toBeVisible();
  await expect(mp.getByRole('button', { name: /^Retire / })).toHaveCount(0);
  for (const id of [own, ws.old]) {
    expect((await member.get(`/api/workstations/${id}/retire-preview`)).status()).toBe(403);
    const r = await member.post(`/api/workstations/${id}/retire`, { data: { handover: 'needs_rehome' } });
    expect(r.status()).toBe(403);
  }
  expect(await wsStatus(ws.old)).toBe('active');
  expect((await agentRow(agents.alder)).workstation_id).toBe(ws.old);
});

test('an Admin may not retire a paired machine of another person: 403 workstation_not_yours, nothing changes', async () => {
  const adminApi = await join(RETADMIN, 'admin');
  const adminBox = await pair(adminApi, 'Adm Box');
  const birch = await hire(adminApi, 'Birch', adminBox);
  // the Owner is not the machine's user: may look, may not unpair
  const pv = await api.get(`/api/workstations/${adminBox}/retire-preview`);
  expect(pv.status(), await pv.text()).toBe(200);
  expect((await pv.json()).canUnpair).toBe(false);
  const r = await api.post(`/api/workstations/${adminBox}/retire`, { data: { handover: 'needs_rehome' } });
  expect(r.status()).toBe(403);
  expect((await r.json()).error.code).toBe('workstation_not_yours');
  expect(await wsStatus(adminBox)).toBe('active');
  expect(await agentRow(birch)).toMatchObject({ status: 'active', workstation_id: adminBox });
});

test('AC4: retiring is refused while an agent is in a running shift, and the dialog and the API name it', async () => {
  const shiftId = crypto.randomUUID();
  await q(
    `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
     VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now())`,
    [shiftId, orgId, agents.elm, ws.busy],
  );
  try {
    const form = await openRetire('Ret Busy');
    const alert = form.getByTestId('retire-working');
    await expect(alert).toContainText('Retiring is not possible while these agents are working');
    await expect(alert).toContainText('Elm');
    await expect(form.getByRole('button', { name: 'Retire', exact: true })).toBeDisabled();

    const r = await api.post(`/api/workstations/${ws.busy}/retire`, { data: { handover: 'needs_rehome' } });
    expect(r.status()).toBe(409);
    const { error } = await r.json();
    expect(error.code).toBe('agents_working');
    expect((error.details.agents as Array<{ id: string; name: string }>).map((a) => a.name)).toEqual(['Elm']);
    expect(await wsStatus(ws.busy)).toBe('active');
    expect(await agentRow(agents.elm)).toMatchObject({ status: 'active', workstation_id: ws.busy });
    expect(await eventsOf('WorkstationRetired', `workstation-${ws.busy}`)).toHaveLength(0);
    await form.getByRole('button', { name: 'Cancel' }).click();
  } finally {
    await q(`UPDATE shifts SET status='ended', ended_at=now() WHERE id=$1`, [shiftId]);
  }
  // once the shift ended the same workstation retires
  const ok = await api.post(`/api/workstations/${ws.busy}/retire`, { data: { handover: 'needs_rehome' } });
  expect(ok.status(), await ok.text()).toBe(200);
  expect((await agentRow(agents.elm)).status).toBe('needs_rehome');
});

test('AC1/AC2/AC5: retire with "move to Y" in the dialog: every agent is on Y, the old workstation holds none', async () => {
  const form = await openRetire('Ret Old');
  await expect(form.getByTestId('retire-unpair-note')).toBeVisible();
  const list = form.getByTestId('retire-agents');
  await expect(list).toContainText('2 agents to hand over');
  await expect(list).toContainText('Alder');
  await expect(list).toContainText('Aspen');
  await expect(form.getByRole('radio', { name: /Move its agents to another workstation/ })).toBeChecked();
  const select = form.getByLabel('Move to');
  const offered = (await select.locator('option').allInnerTexts()).join('\n');
  expect(offered).toContain('Ret New');
  expect(offered).not.toContain('Ret Old');
  expect(offered).not.toContain('Ret Busy'); // retired in the test before
  await select.selectOption(ws.target);
  await form.getByRole('button', { name: 'Retire', exact: true }).click();
  await expect(page.getByText('Ret Old retired: 2 agents moved to Ret New')).toBeVisible();
  await expect(form).toBeHidden();

  for (const id of [agents.alder, agents.aspen])
    expect(await agentRow(id)).toMatchObject({ status: 'active', workstation_id: ws.target });
  expect(await wsStatus(ws.old)).toBe('unlinked');
  expect(await leftOn(ws.old)).toBe(0);
  await expect(page.getByRole('button', { name: 'Retire Ret Old', exact: true })).toHaveCount(0);
});

test('AC1/AC2/AC5: retire with "needs a new home": every agent is needs_rehome and shows Re-home', async () => {
  const form = await openRetire('Ret Spare');
  await form.getByRole('radio', { name: /Mark its agents as needing a new home/ }).check();
  await expect(form.getByLabel('Move to')).toHaveCount(0);
  await form.getByRole('button', { name: 'Retire', exact: true }).click();
  await expect(page.getByText('Ret Spare retired: 2 agents need a new home')).toBeVisible();

  for (const id of [agents.cedar, agents.cypress])
    expect(await agentRow(id)).toMatchObject({ status: 'needs_rehome', workstation_id: null });
  expect(await wsStatus(ws.spare)).toBe('unlinked');
  expect(await leftOn(ws.spare)).toBe(0);

  await page.goto('/agents');
  for (const name of ['Cedar', 'Cypress'])
    await expect(page.getByRole('button', { name: `Re-home ${name}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-home Alder', exact: true })).toHaveCount(0);
});

test('an empty workstation retires directly', async () => {
  const form = await openRetire('Ret Empty');
  await expect(form.getByTestId('retire-no-agents')).toContainText('This workstation has no agents');
  await expect(form.getByRole('radio')).toHaveCount(0);
  await form.getByRole('button', { name: 'Retire', exact: true }).click();
  await expect(page.getByText('Ret Empty retired', { exact: true })).toBeVisible();
  expect(await wsStatus(ws.empty)).toBe('unlinked');
  expect(await leftOn(ws.empty)).toBe(0);
});

test('a removed workstation that still holds agents is listed and its agents are handed over from there', async () => {
  const un = await api.post(`/api/workstations/${ws.gone}/unlink`, { data: {} });
  expect(un.ok(), await un.text()).toBeTruthy();
  expect(await agentRow(agents.fir)).toMatchObject({ workstation_id: ws.gone });
  await page.goto('/workstations');
  const section = page.getByTestId('stranded-workstations');
  await expect(section).toContainText('Removed workstations with agents');
  await expect(section).toContainText('Ret Gone');
  await section.getByRole('button', { name: 'Hand over agents of Ret Gone' }).click();
  const form = page.getByRole('form', { name: 'Retire workstation' });
  await expect(form.getByTestId('retire-unpair-note')).toHaveCount(0);
  await expect(form.getByTestId('retire-agents')).toContainText('Fir');
  await form.getByLabel('Move to').selectOption(ws.target);
  await form.getByRole('button', { name: 'Retire', exact: true }).click();
  await expect(page.getByText('Ret Gone retired: 1 agent moved to Ret New')).toBeVisible();
  expect(await agentRow(agents.fir)).toMatchObject({ status: 'active', workstation_id: ws.target });
  expect(await leftOn(ws.gone)).toBe(0);
  await expect(page.getByTestId('stranded-workstations')).toHaveCount(0);
});

test('AC3: retired workstations are no longer offered as targets of the move dialog, the bulk move or a move', async () => {
  const retired = [ws.old, ws.spare, ws.empty, ws.busy, ws.gone];
  const names = ['Ret Old', 'Ret Spare', 'Ret Empty', 'Ret Busy', 'Ret Gone'];
  const single = (await (await api.get(`/api/agents/${agents.alder}/move-targets`)).json()).workstations as Array<{
    id: string;
  }>;
  const bulk = (await (await api.get(`/api/workstations/${ws.target}/move-targets`)).json()).workstations as Array<{
    id: string;
  }>;
  for (const id of retired) {
    expect(single.map((w) => w.id)).not.toContain(id);
    expect(bulk.map((w) => w.id)).not.toContain(id);
  }
  // a move straight to a retired workstation is refused
  const to = await api.post(`/api/agents/${agents.alder}/rehome`, {
    data: { workstationId: ws.old, runtime: 'mock', model: 'mock' },
  });
  expect(to.status()).toBe(409);
  expect(await to.text()).toContain('workstation_unpaired');
  // the Re-home dialog of a needs_rehome agent does not list them either
  await page.goto('/agents');
  await page.getByRole('button', { name: 'Re-home Cedar', exact: true }).click();
  const dialog = page.getByRole('form', { name: 'Re-home agent' });
  await expect(dialog).toBeVisible();
  const options = await dialog.locator('option').allInnerTexts();
  expect(options.join('\n')).toContain('Ret New');
  for (const n of names) expect(options.join('\n')).not.toContain(n);
  // and the needs_rehome agent can be re-homed one by one onto a live workstation
  const back = await api.post(`/api/agents/${agents.cedar}/rehome`, {
    data: { workstationId: ws.target, runtime: 'mock', model: 'mock' },
  });
  expect(back.status(), await back.text()).toBe(200);
  expect(await agentRow(agents.cedar)).toMatchObject({ status: 'active', workstation_id: ws.target });
});

test('AC7: the retirement and every agent handover are in the audit log', async () => {
  const moved = await eventsOf('WorkstationRetired', `workstation-${ws.old}`);
  expect(moved).toHaveLength(1);
  expect(moved[0]).toMatchObject({ org_id: orgId });
  expect(moved[0]!.payload).toMatchObject({ handover: 'move', targetWorkstationId: ws.target, unlinked: true });
  for (const id of [agents.alder, agents.aspen]) {
    const ev = await eventsOf('AgentRehomed', `agent-${id}`);
    expect(ev.length, `AgentRehomed for ${id}`).toBeGreaterThanOrEqual(1);
  }
  const marked = await eventsOf('WorkstationRetired', `workstation-${ws.spare}`);
  expect(marked).toHaveLength(1);
  expect(marked[0]!.payload).toMatchObject({ handover: 'needs_rehome', targetWorkstationId: null });
  expect([...marked[0]!.payload.needsRehomeAgentIds].sort()).toEqual([agents.cedar, agents.cypress].sort());
  for (const id of [agents.cedar, agents.cypress]) {
    const ev = await eventsOf('AgentNeedsRehome', `agent-${id}`);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ fromWorkstationId: ws.spare, reason: 'workstation_retired' });
  }
  expect(await eventsOf('WorkstationRetired', `workstation-${ws.empty}`)).toHaveLength(1);
  expect(await eventsOf('WorkstationRetired', `workstation-${ws.gone}`)).toHaveLength(1);
  expect(await eventsOf('WorkstationRetired', `workstation-${ws.busy}`)).toHaveLength(1);
  // the actor is the Owner who retired them
  const ownerId = (await q<{ id: string }>('SELECT id FROM users WHERE lower(email)=$1', [RETIRER.email]))[0]!.id;
  for (const e of [...moved, ...marked]) expect(e.actor_id).toBe(ownerId);
});
