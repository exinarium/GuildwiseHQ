import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type DevopsAuditEntry, DevopsAuditEntrySchema, type IpcRpcResponse } from '@aom/shared';
import { z } from 'zod';

/**
 * `devops.audit` (rpc from the guard hook): appends the commands to the workstation's audit log
 * (`<data dir>/logs/devops-audit.jsonl`) and reports them to the server. Only the DevOps engineer's own sessions may
 * call it. The entries are re-validated and the command text redacted again here: the hook runs next to an agent that
 * can write its own input.
 */
export function recordDevopsAudit(
  params: Record<string, unknown>,
  opts: {
    isDevops: boolean;
    logFile: string;
    send: (entries: DevopsAuditEntry[]) => void;
    redact: (command: string) => string;
  },
): IpcRpcResponse {
  if (!opts.isDevops) return { ok: false, error: 'only the DevOps engineer has an audit log' };
  const parsed = z.array(DevopsAuditEntrySchema).max(50).safeParse(params.entries);
  if (!parsed.success) return { ok: false, error: 'invalid audit entries' };
  const entries = parsed.data.map((e) => ({ ...e, command: opts.redact(e.command) }));
  if (entries.length === 0) return { ok: true, result: { recorded: 0 } };
  try {
    mkdirSync(dirname(opts.logFile), { recursive: true });
    appendFileSync(opts.logFile, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, { mode: 0o600 });
  } catch {
    // the server copy below is still sent
  }
  opts.send(entries);
  return { ok: true, result: { recorded: entries.length } };
}
