import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { DeviceStore } from '../../../apps/runner/src/window/pairing.ts';
import { q, waitFor } from '../../support/db.ts';
import { BASE_URL, E2E_DIR } from '../../support/env.ts';
import { deleteMailFor, waitForMail } from '../../support/mail.ts';
import { pairRunner } from '../../support/runner.ts';
import { stepUp } from '../../support/step-up.ts';
import { makeRemote } from '../fixtures/remotes.ts';
import { ApprovalsPage } from '../support/approvals-page.ts';
import { newOwner, pairingCode, person } from '../support/flow.ts';
import { type Host, startHost } from '../support/host.ts';
import { respawnServer } from '../support/server-control.ts';

// Group E: live checks of the release audit (O4) that were BLOCKED on UAT. The ones the harness can drive are here; the
// rest are owner/machine items in COMBINED-QA.md (scenarios.ts lists each with its reason).
test.describe.configure({ mode: 'serial' });

const pairOnly = async (api: APIRequestContext, password: string, name: string): Promise<string> => {
  const code = await pairingCode(api, password);
  pairRunner(BASE_URL, code, name, join(E2E_DIR, `runner-${name}`));
  const ws = await waitFor(
    `workstation ${name}`,
    () => q<{ id: string }>(`SELECT id FROM workstations WHERE name=$1`, [name]),
    (r) => r.length === 1,
    30_000,
  );
  return ws[0]?.id as string;
};
const orgOf = async (email: string): Promise<string> =>
  (
    await q<{ id: string }>(
      `SELECT o.id FROM organizations o JOIN users u ON u.id=o.owner_user_id WHERE u.email=$1`,
      [email],
    )
  )[0]?.id as string;
const devopsFor = async (wsId: string, orgId: string): Promise<number> =>
  (
    await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM agents WHERE is_devops AND status='active' AND workstation_id=$1 AND org_id=$2`,
      [wsId, orgId],
    )
  )[0]?.n ?? 0;
const serving = async (wsId: string, orgId: string): Promise<boolean> =>
  ((
    await q<{ serving: boolean }>(
      `SELECT serving FROM workstation_org_serving WHERE workstation_id=$1 AND org_id=$2`,
      [wsId, orgId],
    )
  )[0]?.serving ?? false) === true;

async function invite(owner: APIRequestContext, ownerPassword: string, email: string): Promise<string> {
  await deleteMailFor(email);
  await stepUp(owner, { password: ownerPassword });
  const res = await owner.post('/api/org/invitations', { data: { email, role: 'member' } });
  expect(res.status(), await res.text()).toBe(201);
  const mail = await waitForMail(email, 20_000);
  const token = /\/invite\/([A-Za-z0-9_-]{16,})/.exec(mail.text)?.[1];
  expect(token, mail.text).toBeTruthy();
  return token as string;
}

test('[E1] F4: accepting a membership without consent gives no hire; a later pairing of the member does not serve the joined organization; with consent it does', async () => {
  const A = person('e1owner');
  const M = person('e1member');
  const C = person('e1consent');
  const apiA = await newOwner(A);
  const apiM = await newOwner(M);
  const apiC = await newOwner(C);
  const orgA = await orgOf(A.email);
  const wsM = await pairOnly(apiM, M.password, 'e1-m-box');
  const wsC = await pairOnly(apiC, C.password, 'e1-c-box');
  // without consent: nothing is asked of M's workstation
  const t1 = await invite(apiA, A.password, M.email);
  const acc = await apiM.post(`/api/invitations/${t1}/accept-existing`, { data: {} });
  expect(acc.status(), await acc.text()).toBe(201);
  const member = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM org_members WHERE org_id=$1 AND status='active' AND user_id=(SELECT id FROM users WHERE email=$2)`,
    [orgA, M.email],
  );
  expect(member[0]?.n).toBe(1);
  expect(await devopsFor(wsM, orgA), 'DevOps engineers of the joined org on the member workstation').toBe(0);
  expect(await serving(wsM, orgA)).toBe(false);
  // a workstation M pairs AFTER joining works for M's own organization only
  const wsM2 = await pairOnly(apiM, M.password, 'e1-m-box2');
  expect(await serving(wsM2, orgA)).toBe(false);
  expect(await devopsFor(wsM2, orgA)).toBe(0);
  expect(await serving(wsM2, await orgOf(M.email))).toBe(true);
  // with consent (the explicit list): serving is on and the joined organization's DevOps engineer is hired, once
  const t2 = await invite(apiA, A.password, C.email);
  const acc2 = await apiC.post(`/api/invitations/${t2}/accept-existing`, {
    data: { serveWorkstationIds: [wsC] },
  });
  expect(acc2.status(), await acc2.text()).toBe(201);
  expect(await serving(wsC, orgA)).toBe(true);
  expect(await devopsFor(wsC, orgA)).toBe(1);
});

let host: Host;
let page: ApprovalsPage;
test.afterAll(async () => {
  await host?.stop();
});

test('[E6] the approvals page refuses a second browser until it is paired (and a wrong host, a form post, a forged sign-in)', async () => {
  const owner = person('e6owner');
  const api = await newOwner(owner);
  const remote = makeRemote('e-live', { 'README.md': '# toy\n' });
  host = await startHost(api, { password: owner.password, name: 'e67-box', repoRoot: remote.repoRoot });
  page = new ApprovalsPage(host.approvalsPort, host.policyDir);
  // the first browser: paired by the person at the keyboard
  await waitFor(
    'the runner shows as connected on its page',
    async () => (await page.state()).status.connected,
    (c) => c === true,
    30_000,
  );
  const origin = `http://127.0.0.1:${host.approvalsPort}`;
  // a second browser, no session: everything but the sign-in page is refused
  expect((await fetch(`${origin}/api/state`)).status).toBe(401);
  expect(
    (await fetch(`${origin}/api/state`, { headers: { authorization: 'Bearer not-a-session' } })).status,
  ).toBe(401);
  // it can ask to pair, which only produces a code that waits for the person at the machine
  const { generateKeyPairSync, sign, createHash } = await import('node:crypto');
  const { signedText } = await import('../../../apps/runner/src/window/pairing.ts');
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const asked = await fetch(`${origin}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ spki: der.toString('base64') }),
  });
  expect(asked.status).toBe(200);
  const code = ((await asked.json()) as { code: string }).code;
  const signIn = async () => {
    const hello = (await (await fetch(`${origin}/api/hello`)).json()) as { instance: string };
    const { nonce } = (await (await fetch(`${origin}/api/challenge`)).json()) as { nonce: string };
    const sig = sign('sha256', Buffer.from(signedText(hello.instance, host.approvalsPort, nonce)), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64');
    return fetch(`${origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ keyHash: createHash('sha256').update(der).digest('hex'), nonce, sig }),
    });
  };
  const before = await signIn();
  expect(before.status, 'a browser that was never paired').toBe(401);
  expect(JSON.stringify(await before.json())).toContain('not paired');
  // a wrong Host (DNS rebinding) and a cross-site form post are refused too
  // (undici's fetch refuses to set Host, so a raw request names the wrong host)
  const rebindStatus = await new Promise<number>((resolve, reject) => {
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port: host.approvalsPort,
        path: '/api/hello',
        headers: { host: `localhost:${host.approvalsPort}` },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    r.once('error', reject);
    r.end();
  });
  expect(rebindStatus, 'a request that names another host (DNS rebinding)').toBe(421);
  const form = await fetch(`${origin}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'http://evil.example' },
    body: '{}',
  });
  expect(form.status).toBe(403);
  // only after the person at the machine confirms the code does the second browser get in
  new DeviceStore(host.policyDir).confirmPending(code);
  const after = await signIn();
  expect(after.status).toBe(200);
});

test('[E7] the runner reconnects by itself after the server restarts, and a re-run of the pairing by the same account keeps the workstation', async () => {
  const before =
    (await q<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE type='WorkstationConnected'`))[0]
      ?.n ?? 0;
  await respawnServer();
  await waitFor(
    'the runner connected again',
    async () =>
      (await q<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE type='WorkstationConnected'`))[0]
        ?.n ?? 0,
    (n) => n > before,
    120_000,
  );
  // re-link: the same data dir pairs again with a fresh code from the same account
  const api = await (await import('../../support/api.ts')).apiAs(
    person('e6owner').email,
    person('e6owner').password,
  );
  const wsBefore = await q<{ id: string }>(`SELECT id FROM workstations WHERE name='e67-box'`);
  const agentsBefore = (
    await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM agents WHERE workstation_id=$1 AND status='active'`,
      [wsBefore[0]?.id],
    )
  )[0]?.n;
  const code = await pairingCode(api, person('e6owner').password);
  const out = pairRunner(BASE_URL, code, 'e67-box', host.home);
  expect(out.toLowerCase()).toMatch(/re-?link|same workstation|paired/);
  const wsAfter = await q<{ id: string }>(
    `SELECT id FROM workstations WHERE user_id=(SELECT id FROM users WHERE email=$1) AND status='active'`,
    [person('e6owner').email],
  );
  expect(wsAfter.map((w) => w.id)).toEqual([wsBefore[0]?.id]);
  expect(
    (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM agents WHERE workstation_id=$1 AND status='active'`,
        [wsBefore[0]?.id],
      )
    )[0]?.n,
  ).toBe(agentsBefore);
  // a link from ANOTHER account does not take the workstation over
  const other = await newOwner(person('e7other'));
  const otherCode = await pairingCode(other, person('e7other').password);
  let refused = '';
  try {
    pairRunner(BASE_URL, otherCode, 'e67-box', host.home);
  } catch (e) {
    refused = String((e as { stderr?: string }).stderr ?? e);
  }
  expect(refused.toLowerCase(), 'a link from another account must be refused').toMatch(
    /another account|new workstation|relink/,
  );
  expect(
    (
      await q<{ id: string }>(`SELECT id FROM workstations WHERE id=$1 AND status='active'`, [
        wsBefore[0]?.id,
      ])
    ).length,
  ).toBe(1);
});
