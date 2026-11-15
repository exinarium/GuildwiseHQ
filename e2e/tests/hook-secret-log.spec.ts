import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { paths } from '../support/env.ts';

// AC3: a real POST /api/hooks/<id>/<secret> reaches the server request log with the id and without the secret.
test('hook call in the path form: the request log keeps the id and never shows the secret', async ({
  request,
}) => {
  const id = '3f2b8c1e-0000-4000-8000-00000000abcd';
  const secret = 'dummy-hook-secret_value.9~zz';
  const res = await request.post(`/api/hooks/${id}/${secret}?x=1`, { data: {}, failOnStatusCode: false });
  expect(res.status()).toBeLessThan(500);
  await expect
    .poll(() => readFileSync(paths.serverLog, 'utf8'), { timeout: 15_000 })
    .toContain(`/api/hooks/${id}/[redacted]`);
  const log = readFileSync(paths.serverLog, 'utf8');
  expect(log).not.toContain(secret);
});
