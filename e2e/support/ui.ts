import type { Locator } from '@playwright/test';

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
