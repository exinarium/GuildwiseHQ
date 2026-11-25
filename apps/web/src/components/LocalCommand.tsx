import { localCommandOk, localStepText } from '@aom/shared';
import { ExternalLink } from 'lucide-react';
import { CopyButton } from './delivery/connect/CopyButton.tsx';

/**
 * A local approval as a copy-paste command (easy-runner-setup): one plain sentence, the exact command the runner rendered
 * in a mono box, a copy button, and the link to the approvals page on that computer. The web never builds command text
 * and never approves: a command that fails the shared grammar is not shown, and the fallback text appears instead.
 */
export function LocalCommand({
  command,
  kind,
  windowPort,
  heldId,
  anchor,
  fallback,
  testId = 'local-command',
}: {
  command: string | null | undefined;
  /** A held item (`held`, or its kind) or a local step kind: picks the sentence. */
  kind: string;
  windowPort?: number | null | undefined;
  /** quiet-approvals: the held item this command approves; the link then opens the page at that item. */
  heldId?: string | null | undefined;
  /** quiet-approvals: open the page at its section instead (`ceiling`: "The most DevOps may get"). */
  anchor?: 'ceiling';
  /** Shown instead when there is no valid command (an older runner). */
  fallback?: React.ReactNode;
  testId?: string;
}) {
  const ok = !!command && localCommandOk(command);
  if (!ok) return fallback ? <>{fallback}</> : null;
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <p className="text-sm text-muted">{localStepText(kind)}</p>
      <div className="flex flex-wrap items-start gap-2">
        <code
          className="min-w-0 flex-1 rounded-md border border-line bg-sunken px-3 py-2 font-mono text-xs break-all text-fg"
          data-testid={`${testId}-text`}
        >
          {command}
        </code>
        <CopyButton text={command} label="Copy" testId={`${testId}-copy`} />
      </div>
      {windowPort ? <ApprovalsLink port={windowPort} heldId={heldId} anchor={anchor} /> : null}
    </div>
  );
}

/** A held item id as the runner writes it; anything else never goes into a link. */
export const HELD_ID_RE = /^[a-z0-9]{6,32}$/;

/** The page address, at one held item when its id is well-formed (`/#held=<id>`: the page only marks it, never approves). */
export function approvalsHref(port: number, heldId?: string | null, anchor?: 'ceiling'): string {
  if (anchor === 'ceiling') return `http://127.0.0.1:${port}/#ceiling`;
  return `http://127.0.0.1:${port}/${heldId && HELD_ID_RE.test(heldId) ? `#held=${heldId}` : ''}`;
}

/** "Open Approvals on this computer": a plain link to the runner's page (no secret in it). Works on that computer only. */
export function ApprovalsLink({
  port,
  heldId,
  anchor,
  testId = 'approvals-link',
}: {
  port: number;
  heldId?: string | null | undefined;
  anchor?: 'ceiling' | undefined;
  testId?: string;
}) {
  return (
    <a
      href={approvalsHref(port, heldId, anchor)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-sm text-brand-text hover:underline"
      data-testid={testId}
      title="Opens only on the workstation itself"
    >
      <ExternalLink aria-hidden="true" className="size-4" />
      Open Approvals on this computer
    </a>
  );
}
