import type { DiscoveryProposalDto, ResolveDiscoveryProposalRequest } from '@aom/shared';
import { PANEL_SECTION_LABEL, PANEL_SECTIONS, type PanelSection } from '@aom/shared';
import { Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from '../chat/Markdown.tsx';
import { Badge, Button, TextArea } from '../ui.tsx';

/** Where an accepted proposal would land, in words. */
export function proposalTarget(p: Pick<DiscoveryProposalDto, 'docId' | 'section'>): string {
  if (p.docId) return p.section ? `Section "${p.section}" of the draft` : 'The end of the draft';
  const s = (PANEL_SECTIONS as readonly string[]).includes(p.section ?? '')
    ? (p.section as PanelSection)
    : 'decisions';
  return `Panel: ${PANEL_SECTION_LABEL[s]}`;
}

const RESOLVED = { applied: 'Applied', rejected: 'Rejected', redirected: 'Redirected' } as const;

/** The Apply / Reject / Redirect gate: nothing changes until the owner chooses Apply. */
export function ProposalCard({
  p,
  onResolve,
  busy,
  error,
  readOnly,
}: {
  p: DiscoveryProposalDto;
  onResolve: (b: ResolveDiscoveryProposalRequest) => void;
  busy?: boolean;
  error?: string | null;
  readOnly?: boolean;
}) {
  const [redirecting, setRedirecting] = useState(false);
  const [text, setText] = useState('');
  if (p.status !== 'open')
    return (
      <li
        data-testid="proposal-card"
        data-status={p.status}
        className="flex flex-col gap-0.5 rounded-card border border-line bg-sunken/60 px-3 py-2 text-sm"
      >
        <p className="flex items-center gap-2 text-muted">
          <Lightbulb aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{p.title}</span>
          <Badge tone={p.status === 'applied' ? 'success' : 'neutral'}>{RESOLVED[p.status]}</Badge>
        </p>
        {p.resolutionText && <p className="pl-6 text-fg [overflow-wrap:anywhere]">{p.resolutionText}</p>}
      </li>
    );
  return (
    <li
      data-testid="proposal-card"
      data-status="open"
      className="flex flex-col gap-3 rounded-card border border-warning-fill/50 bg-surface p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warning">Proposal</Badge>
        <span className="text-xs text-subtle">
          {p.askedByName} suggests. Nothing changes until you choose Apply.
        </span>
      </div>
      <h3 className="text-base font-semibold text-fg [overflow-wrap:anywhere]">{p.title}</h3>
      <div className="rounded-control border border-line bg-sunken/50 p-3 text-sm">
        <p className="mb-1 text-xs font-medium text-subtle">{proposalTarget(p)}</p>
        <Markdown text={p.change} />
      </div>
      <p className="text-sm text-muted [overflow-wrap:anywhere]">Why: {p.rationale}</p>
      {readOnly ? (
        <p className="text-sm text-muted" data-testid="proposal-readonly">
          Waiting for the session creator to decide.
        </p>
      ) : redirecting ? (
        <form
          className="flex flex-col gap-2"
          aria-label="Redirect the proposal"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onResolve({ resolution: 'redirect', text: text.trim() });
          }}
        >
          <TextArea
            label="What would you rather do?"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={!text.trim() || busy}>
              Send to the facilitator
            </Button>
            <Button onClick={() => setRedirecting(false)}>Back</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => onResolve({ resolution: 'apply' })}
            data-testid="proposal-apply"
          >
            Apply
          </Button>
          <Button
            disabled={busy}
            onClick={() => onResolve({ resolution: 'reject' })}
            data-testid="proposal-reject"
          >
            Reject
          </Button>
          <Button disabled={busy} onClick={() => setRedirecting(true)} data-testid="proposal-redirect">
            Redirect
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  );
}
