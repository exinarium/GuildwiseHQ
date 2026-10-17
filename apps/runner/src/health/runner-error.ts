import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { maskText as sharedMaskText, sanitizeStack as sharedSanitizeStack } from '@aom/shared';

/**
 * Errors of the runner itself, reported to the server as `runner.error` (Lean Team v3: the platform team turns them into
 * bug cards). What leaves the machine is sanitised here: the error's name, a message with paths, ids and anything that
 * looks like a secret masked, a stack of function names with file BASENAMES and line numbers, the runner version and a
 * short context label. Never a prompt, a card text, a command line or client code; an error message can quote those
 * (a failed `git` call prints its arguments), so messages are cut at the first line and masked.
 */

export interface RunnerErrorPayload {
  signature: string;
  message: string;
  stack?: string;
  version: string;
  context?: string;
}

/** Masks paths, ids, secrets and e-mail addresses (the one definition lives in `@aom/shared`, also used by the server). */
export function maskText(text: string, home: string = homedir()): string {
  return sharedMaskText(text, home);
}

/** `at fn (/abs/dir/file.ts:12:3)` -> `at fn (file.ts:12:3)`; frames that are not code locations are dropped. */
export const sanitizeStack = sharedSanitizeStack;

/** The message normalised for grouping: numbers, quoted values and ids no longer tell two occurrences apart. */
function groupingText(message: string): string {
  return message
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '"…"')
    .replace(/\b0x[0-9a-f]+\b/gi, '#')
    .replace(/\d+/g, '#')
    .slice(0, 200);
}

export function errorSignature(name: string, topFrame: string | undefined, message: string): string {
  const hash = createHash('sha1').update(groupingText(message)).digest('hex').slice(0, 10);
  return `${name}:${topFrame ?? 'no-frame'}:${hash}`.slice(0, 200);
}

export function sanitizeError(
  err: unknown,
  opts: { version: string; context?: string; home?: string },
): RunnerErrorPayload {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : safeJson(err));
  const name = (e.name || 'Error').slice(0, 60);
  const firstLine = (e.message || String(err)).split('\n')[0] ?? '';
  const message = maskText(firstLine, opts.home).slice(0, 500);
  const stack = sanitizeStack(e.stack);
  // the top frame without line and column: the same fault keeps its signature when the code around it moves
  const top = stack
    ?.split('\n')[0]
    ?.replace(/^at /, '')
    .replace(/:\d+:\d+\)$/, ')');
  return {
    signature: errorSignature(name, top, message),
    message,
    ...(stack ? { stack } : {}),
    version: opts.version,
    ...(opts.context ? { context: opts.context.slice(0, 200) } : {}),
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * Process-wide handlers: an unhandled rejection is reported and logged and the runner keeps running (one shift's stray
 * promise should not take the others down); an uncaught exception is reported and then the process exits (its state is
 * unknown; the service manager starts it again and the outbox delivers what was queued).
 */
export function installErrorHandlers(opts: {
  report: (e: RunnerErrorPayload) => void;
  version: string;
  log: { error(msg: string, err?: unknown): void };
  exit?: (code: number) => void;
  /** At most this many reports per hour; the rest are only logged (a crash loop must not flood the server). */
  maxPerHour?: number;
  proc?: Pick<NodeJS.Process, 'on' | 'off'>;
  now?: () => number;
}): () => void {
  const proc = opts.proc ?? process;
  const now = opts.now ?? Date.now;
  const sent: number[] = [];
  const cap = opts.maxPerHour ?? 20;
  const send = (err: unknown, context: string): void => {
    const t = now();
    while (sent.length > 0 && (sent[0] as number) < t - 3_600_000) sent.shift();
    if (sent.length >= cap) return;
    sent.push(t);
    try {
      opts.report(sanitizeError(err, { version: opts.version, context }));
    } catch {
      // reporting must never throw out of a handler
    }
  };
  const onRejection = (reason: unknown): void => {
    opts.log.error('unhandled promise rejection', reason);
    send(reason, 'unhandledRejection');
  };
  const onException = (err: Error): void => {
    opts.log.error('uncaught exception', err);
    send(err, 'uncaughtException');
    // let the outbox write the report to disk, then stop like an unhandled exception would
    const exit = opts.exit ?? ((c: number) => process.exit(c));
    setTimeout(() => exit(1), 1_000).unref?.();
  };
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.off('unhandledRejection', onRejection);
    proc.off('uncaughtException', onException);
  };
}
