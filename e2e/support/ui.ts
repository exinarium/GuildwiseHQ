import type { Locator } from '@playwright/test';

/** Workstation rows are collapsed by default: open one (if it is not open yet) and return its card. */
export async function expandWorkstation(card: Locator): Promise<Locator> {
  const toggle = card.getByTestId('workstation-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  return card;
}
