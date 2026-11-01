import { spawnSync } from 'node:child_process';
import { BUSINESS_WORKFLOW_KEY } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

afterAll(async () => {
  await closeAdminPool();
});

describe('admin:create', () => {
  it('a new organization has the business workflows at once: they are built-ins, not organization copies', async () => {
    const email = uniqueEmail('cli-owner');
    const r = spawnSync(
      'npx',
      [
        'tsx',
        'scripts/admin-create.ts',
        '--email',
        email,
        '--name',
        'Cli Owner',
        '--password',
        'a-long-enough-password',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL as string },
        timeout: 90_000,
      },
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const org = (
      await q(
        `SELECT o.id FROM organizations o JOIN org_members m ON m.org_id=o.id JOIN users u ON u.id=m.user_id WHERE lower(u.email)=lower($1)`,
        [email],
      )
    )[0];
    expect(org).toBeTruthy();
    const keys = (
      await q(
        `SELECT DISTINCT key FROM workflow_versions WHERE (org_id IS NULL OR org_id=$1) AND status='active'`,
        [org?.id],
      )
    ).map((x: any) => x.key as string);
    for (const k of Object.values(BUSINESS_WORKFLOW_KEY)) expect(keys).toContain(k);
  });
});
