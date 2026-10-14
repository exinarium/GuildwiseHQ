import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from '../secrets/redact.ts';

export interface AuditEntry {
  kind: string;
  instance: string;
  op: 'connect' | 'session' | 'input' | 'cancel' | 'test' | 'remove';
  method?: string;
  /** `web:<userId>` is not known to the runner; `web` or `cli`. */
  via: 'web' | 'cli';
  result: 'ok' | 'failed' | 'refused';
  /** Why, in a short sentence. Never a value. */
  detail?: string;
}

/** `logs/integrations.jsonl`: who changed which integration, when and how. No secrets: time, kind, op, method, result. */
export class AuditLog {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(e: AuditEntry): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const line = {
        at: this.now().toISOString(),
        ...e,
        ...(e.detail ? { detail: redact(e.detail).slice(0, 200) } : {}),
      };
      appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch {
      // the log is advisory
    }
  }
}
