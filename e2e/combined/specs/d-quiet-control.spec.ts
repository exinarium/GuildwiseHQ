import { join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { q, waitFor } from '../../support/db.ts';
import { E2E_DIR } from '../../support/env.ts';
import { makeRemote } from '../fixtures/remotes.ts';
import { ApprovalsPage } from '../support/approvals-page.ts';
import { newOwner, person, sendDevopsRequest, shiftsOfRequest } from '../support/flow.ts';
import { type Host, release, setBoxState, startHost, waitReached } from '../support/host.ts';

// The no-change control of D3. D3 shows that a changed job asks again and names the change; this shows the OTHER half: the same
// job, stopped and sent again with NOTHING changed, is not held (e2e-found-fixes D2: the remembered job leaves out the ids that differ
// per dispatch). It has its own runner so a failing D2 in d-quiet.spec.ts cannot hide it by skipping it.
test.describe.configure({ mode: 'serial' });

const OWNER = person('d3cowner');
let api: APIRequestContext;
let host: Host;
let page: ApprovalsPage;
const scratch = join(E2E_DIR, 'combined', 'd-scratch-control');

test.afterAll(async () => {
  await host?.stop();
});

test('[D3] control: the same job sent again with no change is not held', async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(scratch, { recursive: true });
  api = await newOwner(OWNER);
  const remote = makeRemote('d-control', { 'README.md': '# toy\n' });
  host = await startHost(api, {
    password: OWNER.password,
    name: 'd3c-box',
    repoRoot: remote.repoRoot,
    policy: { devopsRequests: 'ask' },
  });
  page = new ApprovalsPage(host.approvalsPort, host.policyDir);
  setBoxState(host, 'none');
  const waiting = async () => (await page.state()).waiting;
  const req = await sendDevopsRequest(
    api,
    host.workstationId,
    `inspect the logs once more [scn:hold=d3c;path=${scratch}]`,
  );
  const held = await waitFor('the first hold', waiting, (w) => w.length === 1, 90_000);
  expect((await page.approve(held[0]?.id as string)).status).toBe(200);
  await waitReached(host.gateDir, 'd3c');
  const shift1 = (
    await waitFor(
      'the live shift',
      () =>
        q<{ id: string }>(
          `SELECT s.id FROM shifts s WHERE s.kind='devops' AND s.status<>'ended' AND s.id::text = ANY(
             SELECT payload->>'shiftId' FROM events WHERE type='DevOpsShiftDispatched' AND payload->>'requestId'=$1)`,
          [req],
        ),
      (r) => r.length === 1,
      90_000,
    )
  )[0]?.id as string;
  expect((await api.post(`/api/shifts/${shift1}/stop`, { data: {} })).status()).toBe(200);
  let max = 0;
  await waitFor(
    'the same job was sent again',
    async () => {
      max = Math.max(max, (await waiting()).length);
      return (await shiftsOfRequest(req)).length;
    },
    (n) => n >= 2,
    120_000,
  );
  // the re-sent shift either started or was held: wait for one of the two before judging
  await waitFor(
    'the re-sent shift started or was held',
    async () => {
      max = Math.max(max, (await waiting()).length);
      const last = (await shiftsOfRequest(req)).slice(-1)[0];
      return q<{ status: string }>(`SELECT status FROM shifts WHERE id=$1`, [last]);
    },
    (r) => max > 0 || r[0]?.status !== 'starting',
    60_000,
  );
  release(host.gateDir, 'd3c');
  expect(max, 'holds for the same job sent again with no change').toBe(0);
});
