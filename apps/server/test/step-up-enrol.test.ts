import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GithubApi, GithubError } from '../src/cloud/github.ts';
import type { SshConnector } from '../src/cloud/ssh.ts';
import { createPairingCode, pairRunner } from '../src/commands/workstations.ts';
import type { MailMessage } from '../src/mail/mailer.ts';
import { PASSWORD } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * Release-readiness O3: every way to add a machine to an account needs "Confirm it's you" (a fresh step-up, R5):
 * pairing codes, installer links, a VPS, a Codespace and connecting the GitHub account that enrols Codespaces. A
 * Codespace enrols only with the GitHub login it was created with. Every new workstation mails its owner (not a
 * re-link of the same workstation, not a simulated one).
 */
let w: World;
const sent: MailMessage[] = [];
const logLines: string[] = [];

const gh = { login: 'octo' };
const fakeGithub: GithubApi = {
  async user(token) {
    if (token === 'bad-token-xxxx') throw new GithubError('auth', 'bad', 401);
    if (token.startsWith('mallory')) return { login: 'mallory' };
    if (token.startsWith('codespace-')) return { login: 'octo' };
    return { login: gh.login };
  },
  async machines() {
    return [{ name: 'basicLinux32gb', displayName: '2 cores' }];
  },
  async fileExists() {
    return true;
  },
  async create() {
    return {
      name: `cs-${Math.random().toString(36).slice(2, 8)}`,
      state: 'Queued',
      machine: 'basicLinux32gb',
    };
  },
  async get(_t, name) {
    return { name, state: 'Available', machine: null };
  },
  async start(_t, name) {
    return { name, state: 'Starting', machine: null };
  },
  async stop(_t, name) {
    return { name, state: 'ShuttingDown', machine: null };
  },
  async remove() {},
};
// A VPS whose SSH login is refused: enough to see the route answer (201) without installing anything.
const refusingSsh: SshConnector = {
  async connect() {
    throw new Error('not in this test');
  },
};

beforeAll(async () => {
  w = await createWorld({
    listen: false,
    env: { LOG_LEVEL: 'info' },
    logStream: { write: (line) => void logLines.push(line) },
  });
  w.t.app.ctx.services.cloud.github = fakeGithub;
  w.t.app.ctx.services.cloud.ssh = refusingSsh;
  w.t.app.ctx.mailer = {
    async send(m) {
      sent.push(m);
    },
    close() {},
  };
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const WINDOW_MS = 10 * 60_000;
const req = (method: string, url: string, body?: unknown) =>
  w.t.req(method as 'POST', url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) });
/** The session's proof (its password sign-in) gets older than the step-up window. */
const goStale = () => w.t.clock.advance(WINDOW_MS + 60_000);
const stepUp = () => ok(req('POST', '/api/auth/step-up', { password: PASSWORD }));
const settle = () => Promise.all([...w.t.app.ctx.services.cloud.pending]);

const ROUTES: Array<[string, string, () => unknown, number]> = [
  ['pairing code', '/api/workstations/pairing-codes', () => undefined, 201],
  ['installer link', '/api/workstations/installers', () => ({ os: 'linux' }), 201],
  ['GitHub connect', '/api/cloud-workstations/github/connect', () => ({ token: 'ghp_octo_token_1234' }), 200],
  [
    'Codespace',
    '/api/cloud-workstations/codespaces',
    () => ({
      name: 'CS',
      repo: 'acme/toy',
      machine: 'basicLinux32gb',
      devcontainerPath: '.devcontainer/guildwise/devcontainer.json',
      authMode: 'api_key',
    }),
    201,
  ],
  [
    'VPS',
    '/api/cloud-workstations/vps',
    () => ({ name: 'VPS', host: '203.0.113.9', port: 22, username: 'deploy', password: 'pw-not-used-here' }),
    201,
  ],
];

describe('O3: adding a machine needs a fresh step-up', () => {
  it.each(ROUTES)(
    '%s: a stale session gets 403 step_up_required, a fresh one goes through',
    async (_n, url, body, status) => {
      goStale();
      const stale = await req('POST', url, body());
      expect(stale.status).toBe(403);
      expect(stale.body.error.code).toBe('step_up_required');
      expect(stale.body.error.details ?? stale.body.error).toMatchObject({ method: 'password' });
      await stepUp();
      const fresh = await req('POST', url, body());
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(status);
      // remove what the fresh call made, so the next route has a free slot
      if (url.includes('/codespaces') || url.includes('/vps')) {
        await settle();
        await ok(req('DELETE', `/api/cloud-workstations/${fresh.body.id}`));
      }
    },
  );

  it('a stolen session replayed without the step-up cannot pair: no code, so nothing to pair with', async () => {
    goStale();
    const before = (await q('SELECT count(*)::int AS n FROM pairing_codes'))[0]!.n;
    expect((await req('POST', '/api/workstations/pairing-codes')).status).toBe(403);
    expect((await req('POST', '/api/workstations/installers', { os: 'linux' })).status).toBe(403);
    expect((await q('SELECT count(*)::int AS n FROM pairing_codes'))[0]!.n).toBe(before);
  });
});

describe('O3: a Codespace enrols only with the GitHub login it was created with', () => {
  const enroll = (codespaceName: string, token: string) =>
    w.t.req('POST', '/api/runner/enroll', {
      body: {
        codespaceName,
        githubToken: token,
        name: 'Codespace',
        platform: 'linux',
        hostname: 'cs',
        runnerVersion: '0.0.0-test',
      },
    });

  it('records the login at creation; a connection swapped afterwards cannot enrol it (401)', async () => {
    await stepUp();
    gh.login = 'octo';
    await ok(req('POST', '/api/cloud-workstations/github/connect', { token: 'ghp_octo_token_1234' }));
    const cw = await ok<any>(
      req('POST', '/api/cloud-workstations/codespaces', {
        name: 'Pinned',
        repo: 'acme/toy',
        machine: 'basicLinux32gb',
        devcontainerPath: '.devcontainer/guildwise/devcontainer.json',
        authMode: 'api_key',
      }),
      201,
    );
    const row = (await q('SELECT config FROM cloud_workstations WHERE id=$1', [cw.id]))[0]!;
    expect(row.config.ghLogin).toBe('octo');
    // the session (stolen, but fresh) connects another GitHub account: the codespace still answers only to octo
    gh.login = 'mallory';
    await ok(req('POST', '/api/cloud-workstations/github/connect', { token: 'mallory-pat-1234' }));
    expect((await enroll(row.config.codespaceName, 'mallory-codespace-token')).status).toBe(401);
    // the account that created it still enrols
    const r = await enroll(row.config.codespaceName, 'codespace-token-ok');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await ok(req('DELETE', `/api/cloud-workstations/${cw.id}`));
    gh.login = 'octo';
  });

  it('a codespace row without a recorded login (from before) is refused with 401', async () => {
    await q(
      `INSERT INTO cloud_workstations (org_id, user_id, provider, name, state, config, created_at, updated_at)
       VALUES ($1,$1,'codespaces','Old','starting','{"codespaceName":"legacy-cs","repo":"a/b","machine":"basicLinux32gb"}',now(),now())`,
      [w.owner.id],
    );
    expect((await enroll('legacy-cs', 'codespace-token-ok')).status).toBe(401);
  });
});

describe('O3: a new workstation mails its owner', () => {
  const pairMails = () => sent.filter((m) => m.subject === 'A new workstation was added to your account');
  /** The mail goes out after the pairing committed, not awaited: wait for it, or give it time before saying "none". */
  const mailsAfter = (n: number, count: number) =>
    until(
      async () => (pairMails().length >= n + count ? pairMails().slice(n) : false),
      5000,
      'the pairing mail',
    );
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const pair = async (name: string) => {
    const { code } = await ok<any>(req('POST', '/api/workstations/pairing-codes'), 201);
    return w.t.req('POST', '/api/runner/pair', {
      body: { code, name, platform: 'linux', hostname: `host-${name}`, runnerVersion: '0.0.0-test' },
    });
  };

  it('one mail per new pairing, with what and when, and none for a re-link', async () => {
    await stepUp();
    const n = pairMails().length;
    const { code } = await ok<any>(req('POST', '/api/workstations/pairing-codes'), 201);
    const paired = await ok<any>(
      w.t.req('POST', '/api/runner/pair', {
        body: { code, name: 'Laptop', platform: 'linux', hostname: 'lap-1', runnerVersion: '0.0.0-test' },
      }),
    );
    const mails = await mailsAfter(n, 1);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe(w.owner.email);
    expect(mails[0]!.text).toContain('Laptop');
    expect(mails[0]!.text).toContain('lap-1');
    expect(mails[0]!.text).toContain('Not you?');
    expect(mails[0]!.text).not.toContain(paired.runnerToken);

    // the same workstation re-linked (installer run again): no new mail
    const again = await ok<any>(req('POST', '/api/workstations/pairing-codes'), 201);
    const relink = await ok<any>(
      w.t.req('POST', '/api/runner/pair', {
        body: {
          code: again.code,
          name: 'Laptop',
          platform: 'linux',
          hostname: 'lap-1',
          runnerVersion: '0.0.0-test',
          previous: { workstationId: paired.workstationId, runnerToken: paired.runnerToken },
        },
      }),
    );
    expect(relink.relinked).toBe(true);
    await settle();
    expect(pairMails().slice(n)).toHaveLength(1);
  });

  it('no mail for a simulated workstation', async () => {
    const org = await w.t.createOrg(w.owner.id, 'Sim mail org');
    await q('UPDATE organizations SET simulation=true WHERE id=$1', [org]);
    const n = pairMails().length;
    const code = await createPairingCode(w.t.app.ctx, { id: w.owner.id } as never, { ttlMs: 60_000 });
    await pairRunner(w.t.app.ctx, {
      code: code.code,
      name: 'Simulated workstation',
      platform: 'linux',
      hostname: 'guildwise-simulation',
      runnerVersion: '0.0.0-simulation',
      simulationOrgId: org,
    });
    await settle();
    expect(pairMails()).toHaveLength(n);
  });

  it('a mail relay that hangs never delays the pairing', async () => {
    await stepUp();
    const real = w.t.app.ctx.mailer;
    let calls = 0;
    w.t.app.ctx.mailer = { send: () => (calls++, new Promise<void>(() => {})), close() {} };
    try {
      const started = Date.now();
      const r = await pair('Hang');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(
        (await q('SELECT status FROM workstations WHERE id=$1', [r.body.workstationId]))[0]?.status,
      ).toBe('active');
      await until(async () => calls > 0, 5000, 'the mail attempt');
    } finally {
      w.t.app.ctx.mailer = real;
    }
  });

  it('a mail relay that fails never fails the pairing, and the failure is logged', async () => {
    await stepUp();
    const real = w.t.app.ctx.mailer;
    w.t.app.ctx.mailer = {
      async send() {
        throw new Error('smtp down');
      },
      close() {},
    };
    try {
      const before = logLines.length;
      const r = await pair('Fail');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.runnerToken).toMatch(/^aomr_/);
      await until(
        async () =>
          logLines
            .slice(before)
            .some(
              (l) =>
                l.includes('notification mail was not sent') &&
                l.includes('A new workstation was added to your account'),
            ),
        5000,
        'the logged mail failure',
      );
    } finally {
      w.t.app.ctx.mailer = real;
    }
  });
});
