import type { ReactNode } from 'react';
import { SANDBOX_DOCS_URL } from '../lib/sandbox.ts';

/**
 * Amber warning for a runtime that runs agents without an OS sandbox. Never dismissable: it shows for as long as the
 * runner reports the state. The prefix word and the icon mean the meaning does not rest on colour alone.
 */
export function SandboxWarning({
  children,
  testId = 'sandbox-warning',
  role = 'note',
  docs = true,
  lead = 'Warning: no OS sandbox.',
}: {
  children: ReactNode;
  testId?: string;
  role?: 'note' | 'alert';
  docs?: boolean;
  lead?: string;
}) {
  return (
    <div
      role={role}
      data-testid={testId}
      className="flex gap-2 rounded-md border border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100"
    >
      <span aria-hidden="true">&#9888;</span>
      <p className="min-w-0">
        <strong>{lead}</strong> {children}
        {docs && (
          <>
            {' '}
            <a
              href={SANDBOX_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline"
              data-testid="sandbox-docs-link"
            >
              How to run the runner in WSL2
            </a>
          </>
        )}
      </p>
    </div>
  );
}

/** A runtime that cannot run agents at all, and why (for example native Windows: install the runner in WSL2). */
export function SandboxUnavailable({ runtime, reason }: { runtime: string; reason?: string }) {
  return (
    <p
      className="rounded-md border border-zinc-400 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
      data-testid="sandbox-unavailable"
    >
      <strong>{runtime} is unavailable:</strong> {reason ?? 'the OS sandbox cannot start'}.{' '}
      <a href={SANDBOX_DOCS_URL} target="_blank" rel="noreferrer" className="font-medium underline">
        Setup guide
      </a>
    </p>
  );
}
