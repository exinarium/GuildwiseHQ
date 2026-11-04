import { join } from 'node:path';
import { E2E_DIR, HOSTED_URL, TLS_PORT } from './support/env.ts';
import { defaultAccounts, seedE2eAccounts } from './support/seed.ts';
import { requireDeclared } from './support/test-services.ts';
import { startTlsProxy } from './support/tls-proxy.ts';

/**
 * Global setup for a hosted-build Playwright config: waits for the hosted build, seeds the E2E accounts into its database
 * (when AOM_E2E_HOSTED_APP names the built app folder), starts the transparent TLS proxy in front of it and trusts its
 * certificate for the test workers.
 */
export default async function hostedGlobalSetup(): Promise<() => Promise<void>> {
  requireDeclared(Number(new URL(HOSTED_URL).port || 80), 'hosted build');
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${HOSTED_URL}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`the hosted build at ${HOSTED_URL} did not become healthy`);
    await new Promise((r) => setTimeout(r, 500));
  }
  if (process.env.AOM_E2E_HOSTED_APP && process.env.DATABASE_URL) {
    await seedE2eAccounts(defaultAccounts(), {
      appDir: process.env.AOM_E2E_HOSTED_APP,
      databaseUrl: process.env.DATABASE_URL,
    });
  } else {
    console.log('hosted setup: AOM_E2E_HOSTED_APP / DATABASE_URL not set, accounts are not seeded');
  }
  const proxy = await startTlsProxy({
    target: HOSTED_URL,
    port: TLS_PORT,
    certDir: join(E2E_DIR, 'hosted-tls'),
  });
  process.env.NODE_EXTRA_CA_CERTS = proxy.caPath;
  process.env.HOSTED_TLS_URL = proxy.url;
  return () => proxy.close();
}
