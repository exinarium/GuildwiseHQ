import {
  type CardDetailResponse,
  NEEDS_SPLIT_REASON_TEXT,
  type NeedsSplitReason,
  type NeedsSplitState,
  type StoredNeedsSplitProposal,
  StoredNeedsSplitProposalSchema,
} from '@aom/shared';
import { Link } from 'react-router';
import { Badge, Panel } from './ui.tsx';

const STATE_LABEL: Record<NeedsSplitState, string> = {
  with_ba: 'With the BA to split',
  owner: 'Waiting for the owner',
  split: 'Split',
  continued: 'Kept as one card',
  cancelled: 'Cancelled',
  dropped: 'Not split: the BA task ended',
};
const STATE_TONE = {
  with_ba: 'warning',
  owner: 'warning',
  split: 'success',
  continued: 'info',
  cancelled: 'danger',
  dropped: 'info',
} as const;

/** Folders as wrapping chips: long paths break instead of overflowing a phone screen. */
function FolderChips({ folders }: { folders: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {folders.map((f) => (
        <li
          key={f}
          data-testid="needs-split-folder"
          className="max-w-full break-all rounded border border-line bg-subtle/10 px-2 py-0.5 font-mono text-xs"
        >
          {f}
        </li>
      ))}
    </ul>
  );
}

/** The architect's proposal: the reason, the estimate, the folder scope and the numbered seams. Read-only. */
export function NeedsSplitProposalView({
  proposal,
  compact = false,
}: {
  proposal: StoredNeedsSplitProposal;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      {!compact && <p className="break-words">{proposal.reason}</p>}
      {proposal.estimate && (
        <p className="text-muted" data-testid="needs-split-estimate">
          {proposal.estimate.size} {proposal.estimate.unit.replace(/_/g, ' ')}, budget{' '}
          {proposal.estimate.budget}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <h4 className="font-medium text-fg">Folder scope</h4>
        <FolderChips folders={proposal.folderScope} />
      </div>
      <div className="flex flex-col gap-1.5">
        <h4 className="font-medium text-fg">Proposed seams</h4>
        <ol className="flex flex-col gap-2">
          {proposal.seams.map((s, i) => (
            <li
              key={`${s.title}|${s.folders.join(',')}`}
              data-testid="needs-split-seam"
              className="flex flex-col gap-1"
            >
              <span className="break-words font-medium">
                {i + 1}. {s.title}
                {s.repo ? <span className="text-muted"> ({s.repo})</span> : null}
              </span>
              {!compact && <FolderChips folders={s.folders} />}
              {!compact && s.note && <span className="break-words text-muted">{s.note}</span>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Card detail: the needs-split record of an over-budget card. Nothing is shown for a card that never took the route. */
export function NeedsSplitPanel({ needsSplit }: { needsSplit: CardDetailResponse['needsSplit'] }) {
  if (!needsSplit) return null;
  return (
    <Panel title="Needs split" data-testid="needs-split-panel">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={STATE_TONE[needsSplit.state]}>{STATE_LABEL[needsSplit.state]}</Badge>
          <span className="text-muted">{NEEDS_SPLIT_REASON_TEXT[needsSplit.reason as NeedsSplitReason]}</span>
        </div>
        <NeedsSplitProposalView proposal={needsSplit.proposal} />
        {needsSplit.state === 'owner' && needsSplit.deskItemId && (
          <Link
            to="/desk"
            data-testid="needs-split-desk-link"
            className="inline-flex min-h-11 items-center font-medium underline"
          >
            Decide on your desk
          </Link>
        )}
        {needsSplit.state === 'split' && (
          <p className="text-sm text-muted">The new cards are listed under "Split into".</p>
        )}
        {needsSplit.note && <p className="break-words text-sm text-muted">{needsSplit.note}</p>}
      </div>
    </Panel>
  );
}

/** Desk: a compact view of the proposal on a `needs_split_decision` item (folder scope and seam titles). */
export function NeedsSplitSummary({ data }: { data: unknown }) {
  const proposal = StoredNeedsSplitProposalSchema.safeParse(
    (data as { proposal?: unknown } | null)?.proposal,
  );
  if (!proposal.success) return null;
  return (
    <div data-testid="needs-split-summary" className="mt-2">
      <NeedsSplitProposalView proposal={proposal.data} compact />
    </div>
  );
}
