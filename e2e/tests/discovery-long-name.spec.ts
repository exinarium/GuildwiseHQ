import { expect, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q } from '../support/db.ts';
import { ADMIN } from '../support/env.ts';

// An owner whose display name is longer than 100 characters can create a discovery session; the name stored in the
// session's participant event is clipped (99 characters plus an ellipsis). Names of 100 characters or fewer stay as they are.
const cases = [
  { label: '120 characters', name: 'L'.repeat(120), stored: `${'L'.repeat(99)}…` },
  { label: '101 characters', name: 'M'.repeat(101), stored: `${'M'.repeat(99)}…` },
  { label: '100 characters', name: 'H'.repeat(100), stored: 'H'.repeat(100) },
  { label: 'a short name', name: 'Shorty Short', stored: 'Shorty Short' },
];

for (const [i, c] of cases.entries()) {
  test(`discovery create succeeds for an owner with ${c.label}`, async () => {
    const user = {
      email: `longname${i}@e2e.test`,
      name: c.name,
      password: `longname-password-${i}-12345`,
    };
    await inviteAndAccept(await apiAs(ADMIN.email, ADMIN.password), user);
    const api = await apiAs(user.email, user.password);
    const res = await api.post('/api/discovery', { data: { title: 'Long name', idea: 'Check clipping' } });
    expect(res.status(), await res.text()).toBe(201);
    const threadId = (await res.json()).state.threadId as string;
    const got = await api.get(`/api/discovery/${threadId}`);
    expect(got.status()).toBe(200);
    const rows = await q<{ display_name: string }>(
      `SELECT display_name FROM thread_participants WHERE thread_id=$1 AND kind='user'`,
      [threadId],
    );
    expect(rows.map((r) => r.display_name)).toContain(c.stored);
  });
}
