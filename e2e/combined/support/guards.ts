import { resolve } from 'node:path';

/**
 * Isolation guards (DESIGN section 4). The combined run deletes its temp dir and drops its database, so it refuses to
 * start unless both are unmistakably its own, and refuses to run next to a normal e2e run (Mailpit is shared and the
 * normal suite deletes mail for fixed addresses).
 */
export const TMP_PREFIX = '/tmp/aom-combined.';

export function assertIsolation(env: NodeJS.ProcessEnv = process.env): void {
  const dir = env.AOM_E2E_DIR ?? '';
  if (!resolve(dir).startsWith(TMP_PREFIX) || dir.includes('..'))
    throw new Error(`refusing to run: AOM_E2E_DIR must start with ${TMP_PREFIX} (got "${dir}")`);
  const db = env.AOM_E2E_DB ?? '';
  if (!/^aom_combined[a-z0-9_]*$/.test(db))
    throw new Error(`refusing to run: AOM_E2E_DB must be aom_combined* (got "${db}")`);
  const pg = env.AOM_E2E_PG_HOSTPORT ?? '127.0.0.1:5433';
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(pg))
    throw new Error(`refusing to run: Postgres must be on 127.0.0.1 (got "${pg}")`);
  const smtp = env.AOM_E2E_SMTP_URL ?? 'smtp://127.0.0.1:1025';
  if (!/^smtp:\/\/(127\.0\.0\.1|localhost):\d+/.test(smtp))
    throw new Error(`refusing to run: SMTP must be local (got "${smtp}")`);
  const port = Number(env.AOM_E2E_PORT ?? 0);
  if (!port || port === 4601) throw new Error('refusing to run: AOM_E2E_PORT must be set and not 4601');
}

/** The runner may only pair with a loopback server. */
export function assertLoopback(url: string): void {
  const h = new URL(url).hostname;
  if (h !== '127.0.0.1' && h !== 'localhost' && h !== '[::1]')
    throw new Error(`refusing to pair a runner with a non-loopback server: ${h}`);
}
