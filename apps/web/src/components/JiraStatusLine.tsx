import type { WorkstationDto } from '@aom/shared';
import { Link } from 'react-router';
import { integrationsLink } from '../lib/integrations.ts';
import { Badge } from './ui.tsx';

/**
 * Jira on this workstation (docs/RUNNER.md "Jira on the runner"): whether the runner holds credentials that Jira accepts.
 * The page learns the state only; the API token is entered on the workstation with `aom-runner jira-connect`.
 */
export function JiraStatusLine({ w }: { w: WorkstationDto }) {
  const s = w.jira?.status ?? null;
  return (
    <div className="mt-4 border-t border-line pt-3 text-sm" data-testid="jira-status">
      <p className="mb-2 flex items-center gap-3 text-xs font-medium text-subtle">
        Jira
        <Link
          to={integrationsLink(w.id, 'jira', { connect: s?.state !== 'connected' })}
          className="font-normal text-brand-text underline"
          data-testid="jira-open-integrations"
        >
          {s?.state === 'connected' ? 'Open Integrations' : 'Connect on the Integrations page'}
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-40 font-medium text-fg">Ticket attachments</span>
        {!s ? (
          <Badge title="Not reported yet (needs runner 0.1.3 or newer)">Unknown</Badge>
        ) : s.state === 'connected' ? (
          <Badge tone="green" {...(s.baseUrl ? { title: s.baseUrl } : {})}>
            {s.account ? `Connected as ${s.account}` : 'Connected'}
          </Badge>
        ) : s.state === 'refused' ? (
          <Badge tone="amber" {...(s.detail ? { title: s.detail } : {})}>
            Refused
          </Badge>
        ) : (
          <Badge tone="neutral">Not connected</Badge>
        )}
        {s?.state === 'connected' && s.baseUrl && (
          <span className="font-mono text-xs text-subtle">{s.baseUrl.replace(/^https?:\/\//, '')}</span>
        )}
      </div>
      {(!s || s.state !== 'connected') && w.connected && (
        <p className="mt-2 text-subtle">
          {s?.state === 'refused' && s.detail ? `${s.detail}. ` : ''}
          Agents read the files attached to a Jira ticket through this runner. On the workstation run{' '}
          <code className="font-mono text-xs">aom-runner jira-connect</code>; the API token stays there.
        </p>
      )}
    </div>
  );
}
