import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFFICIAL_RUNNER_RELEASE_KEY_ID, OFFICIAL_RUNNER_RELEASE_PUBKEY } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

/**
 * R21/R27: the served installer carries the server's "Only signed runners" value and the release key it trusts, so the
 * script refuses an unsigned release and replaces an old runner only where the setting is on.
 */
const TEST_PUB =
  readFileSync(join(__dirname, '../../runner/test/fixtures/minisign/test.pub'), 'utf8').split('\n')[1] ?? '';
const dir = mkdtempSync(join(tmpdir(), 'release-'));
writeFileSync(join(dir, 'aom-runner-1.10.0.tgz'), randomBytes(64));
const apps: TestApp[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
  rmSync(dir, { recursive: true, force: true });
  await closeAdminPool();
});

async function scripts(env: Record<string, string>) {
  const t = await createTestApp({ env: { AOM_RUNNER_RELEASE_DIR: dir, ...env } });
  apps.push(t);
  const user = await t.userSession(uniqueEmail('insthdr'));
  const get = async (os: 'linux' | 'windows') => {
    const s = await ok<any>(
      t.req('POST', '/api/workstations/installers', { cookie: user.cookie, body: { os } }),
      201,
    );
    const url = new URL(/'([^']+)'/.exec(s.oneLiner)?.[1] as string);
    return (await t.app.inject({ method: 'GET', url: url.pathname })).body;
  };
  return { sh: await get('linux'), ps: await get('windows') };
}

describe('the served installer header', () => {
  it("self-hosted default: setting off, and the official key (the owner's 0403EF6CE164E7D8)", async () => {
    const { sh, ps } = await scripts({});
    expect(OFFICIAL_RUNNER_RELEASE_KEY_ID).toBe('0403EF6CE164E7D8');
    expect(sh).toContain('\nREQUIRE_SIGNED_RUNNERS=0\n');
    expect(sh).toContain(`\nRELEASE_PUBKEY='${OFFICIAL_RUNNER_RELEASE_PUBKEY}'\n`);
    expect(ps).toContain('$RequireSignedRunners = $false');
  });

  it('setting on with an own release key: both reach the scripts', async () => {
    const { sh, ps } = await scripts({
      AOM_REQUIRE_SIGNED_RUNNERS: 'true',
      AOM_RUNNER_RELEASE_PUBKEY: TEST_PUB,
    });
    expect(sh).toContain('\nREQUIRE_SIGNED_RUNNERS=1\n');
    expect(sh).toContain(`\nRELEASE_PUBKEY='${TEST_PUB}'\n`);
    expect(ps).toContain('$RequireSignedRunners = $true');
  });
});
