import type { ProjectDto } from '@aom/shared';
import { Callout } from './ui.tsx';

/** "18:00", or "Thu 22 Oct 18:00" when the reset is not today; in the viewer's own time zone. */
export function formatUntil(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${hm}`;
}

/** The runtime whose subscription is out, in words (Claude Code unless the server names another, S-A). */
const RUNTIME_WORD: Record<string, string> = { codex: 'Codex', gemini: 'Gemini CLI' };

/**
 * Backlog #73: the model subscription's usage limit was hit on the workstation(s) that run this project. Work is paused,
 * not failed, and resumes by itself; nothing for the viewer to do. With per-project Claude accounts
 * (docs/design/claude-accounts.md) the banner names the account, and says so when the project runs on the main account
 * meanwhile (`mode: 'fallback'`).
 */
export function UsageLimitBanner({ limit }: { limit: ProjectDto['usageLimit'] }) {
  if (!limit) return null;
  const account = limit.accountKey && limit.accountKey !== 'main' ? limit.accountKey : null;
  const who = (limit.scope && RUNTIME_WORD[limit.scope]) || 'Claude';
  if (limit.mode === 'fallback')
    return (
      <Callout
        tone="info"
        role="status"
        data-testid="usage-limit-banner"
        title={`Running on the main account while ${account ?? 'the project account'} is out until ${formatUntil(limit.until)}`}
        className="mb-3"
      >
        The {who} account {account ? <code className="font-mono">{account}</code> : 'of this project'} reached
        its usage limit on {limit.workstationName}. Tickets use the workstation's main account until it
        resets, then go back by themselves.
      </Callout>
    );
  return (
    <Callout
      tone="warning"
      role="status"
      data-testid="usage-limit-banner"
      title={`Paused until ${formatUntil(limit.until)} (${account ? `account ${account}: ` : ''}usage limit on ${limit.workstationName})`}
      className="mb-3"
    >
      {account ? (
        <>
          The {who} account <code className="font-mono">{account}</code> behind this project hit its usage
          limit.
        </>
      ) : (
        `The ${who} subscription behind this project hit its usage limit.`
      )}{' '}
      Cards stay in the queue without penalty and work resumes by itself when the limit resets.
    </Callout>
  );
}
