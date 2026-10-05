/** The browser's IANA time zone (`Europe/Amsterdam`), or null when it cannot tell. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Zones offered in the settings: everything the browser knows, with the current and browser zones always present. */
export function timeZoneOptions(current: string | null): string[] {
  let all: string[] = [];
  try {
    all =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ??
      [];
  } catch {
    all = [];
  }
  const set = new Set(all);
  set.add('UTC');
  for (const z of [current, browserTimeZone()]) if (z) set.add(z);
  return [...set].sort();
}
