import { type APIRequestContext, expect } from '@playwright/test';

/**
 * "Confirm it's you" (R5) for an API client: posts a fresh code (two-factor accounts) or the password to
 * `/api/auth/step-up`, so the next guarded request of that session passes. The suite's server runs with
 * `AOM_STEP_UP_WINDOW_SEC=86400`, so a sign-in is fresh for the whole run; call this before a guarded action when the
 * session was started otherwise (an invitation or demo session) or after a clock jump past a day, or when a spec wants
 * the dialog itself not to appear.
 */
export async function stepUp(
  request: APIRequestContext,
  answer: { code: string } | { password: string },
): Promise<{ freshUntil: string }> {
  const res = await request.post('/api/auth/step-up', { data: answer });
  expect(res.ok(), `step-up: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { freshUntil: string };
}
