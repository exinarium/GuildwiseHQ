import { expect, type Locator, type Page } from '@playwright/test';

/** Workstation rows are collapsed by default: open one (if it is not open yet) and return its card. */
export async function expandWorkstation(card: Locator): Promise<Locator> {
  const toggle = card.getByTestId('workstation-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  return card;
}

/** In the Hire form's "Where may this agent work?" editor: allow exactly the given project (untick the default). */
export async function allowOnlyProject(form: import('@playwright/test').Locator, key: string): Promise<void> {
  await form.getByRole('button', { name: 'Selected projects' }).click();
  const boxes = form.getByTestId('hire-projects').getByRole('checkbox');
  for (const box of await boxes.all()) if (await box.isChecked()) await box.uncheck();
  await form.getByRole('checkbox', { name: `Allow ${key}` }).check();
}

/**
 * Save the journey in the designer and wait for the save itself (the PUT /api/journeys/:id response), not for the
 * "Journey saved" toast: a toast of an earlier save stays on screen for seconds and would satisfy (or, with two toasts,
 * break) the wait before this save is stored.
 */
export async function saveJourneyInDesigner(page: Page, trigger: () => Promise<void>): Promise<void> {
  const put = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && /\/api\/journeys\/[^/?]+$/.test(new URL(r.url()).pathname),
  );
  await trigger();
  expect((await put).ok()).toBe(true);
  // the page has taken the save in (dirty cleared): Save is disabled again
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
}
