import type { ClientError } from '@aom/shared';

/**
 * A small ring buffer of the browser's recent errors, attached to a Contact us request so that support sees what went
 * wrong without asking. Kept in memory only (never persisted), ten entries of at most 300 characters, with anything
 * that looks like a secret removed first. The person sees the list in the form and can leave it out.
 */
const MAX = 10;
const buffer: ClientError[] = [];
let installed = false;

const SECRET = /\b(token|key|secret|password|authorization|bearer|cookie|code)(["'\s:=]+)[^\s"',;&]{4,}/gi;

export function redact(text: string): string {
  return text.replace(SECRET, '$1$2[removed]').replace(/\baom[a-z]?_[A-Za-z0-9_-]{8,}/g, '[removed]');
}

export function recordClientError(message: unknown, source?: string): void {
  const raw =
    message instanceof Error ? `${message.name}: ${message.message}` : String(message ?? 'unknown error');
  const entry: ClientError = {
    at: new Date().toISOString(),
    message: redact(raw.replace(/\s+/g, ' ')).slice(0, 300),
    ...(source ? { source: source.slice(0, 200) } : {}),
  };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
}

export const getClientErrors = (): ClientError[] => buffer.map((e) => ({ ...e }));
export const clearClientErrors = (): void => {
  buffer.length = 0;
};

/** Starts listening (once): uncaught errors, unhandled promise rejections and `console.error`. */
export function installClientErrorBuffer(target: Window = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener('error', (e) => {
    const where = e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : 'window.onerror';
    recordClientError(e.error ?? e.message, where);
  });
  target.addEventListener('unhandledrejection', (e) => recordClientError(e.reason, 'unhandledrejection'));
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      recordClientError(
        args
          .map((a) =>
            a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a),
          )
          .join(' '),
        'console.error',
      );
    } catch {
      /* never let the recorder break logging */
    }
    original(...args);
  };
}
