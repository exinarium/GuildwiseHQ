import { appendFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../log.ts';
import { windowDir } from './pairing.ts';

/**
 * The approvals page's local record of changes (DESIGN "Logging"): one JSON line per change in `window/audit.log` (600)
 * and a line in the runner log. Pairing, forgetting and port moves are recorded too. Never a session token, a nonce or
 * a pairing code: a browser is named by the first 12 characters of its key hash.
 */

export interface AuditEntry {
  /** What was done (`devops.grant`, `held.approve`, `pair`, `forget`, `port`, `refused`, ...). */
  action: string;
  /** What it was done to (an organization id, a held item id, a repository, a fingerprint, ...). */
  target: string;
  /** The browser's key hash (only its prefix is written), or `cli` for a terminal command. */
  device?: string;
  before?: unknown;
  after?: unknown;
}

export const AUDIT_FILE = 'audit.log';
const PREFIX = 12;

export const devicePrefix = (keyHash: string | undefined): string =>
  !keyHash ? 'cli' : /^[0-9a-f]{64}$/.test(keyHash) ? keyHash.slice(0, PREFIX) : 'cli';

export function auditFile(policyRoot: string): string {
  return join(windowDir(policyRoot), AUDIT_FILE);
}

/** Appends one line (and logs it). Never throws: a failed audit write is logged as an error. */
export function audit(
  policyRoot: string,
  log: Logger | null,
  e: AuditEntry,
  now: () => number = Date.now,
): void {
  const line = {
    time: new Date(now()).toISOString(),
    device: devicePrefix(e.device),
    action: e.action,
    target: e.target,
    ...(e.before !== undefined ? { before: e.before } : {}),
    ...(e.after !== undefined ? { after: e.after } : {}),
  };
  const file = auditFile(policyRoot);
  try {
    mkdirSync(windowDir(policyRoot), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (err) {
    log?.error(`approvals page: could not write ${file}: ${String(err)}`);
  }
  log?.info(`approvals page: ${line.action} ${line.target} (browser ${line.device})`);
}

/** The audit lines (tests and `approvals devices`). */
export function readAudit(policyRoot: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(auditFile(policyRoot), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}
