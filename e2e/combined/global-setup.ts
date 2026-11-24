import globalSetup from '../global-setup.ts';
import { assertIsolation } from './support/guards.ts';

/** Refuses to start unless the temp dir, database, ports and SMTP are the combined run's own, then the normal setup. */
export default async function combinedSetup(): Promise<() => Promise<void>> {
  assertIsolation();
  return globalSetup();
}
