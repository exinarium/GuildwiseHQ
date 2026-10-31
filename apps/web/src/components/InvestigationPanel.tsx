import type { CardDto } from '@aom/shared';
import { safeHref } from '../lib/links.ts';
import { Badge, Callout, Panel } from './ui.tsx';
import { useOrgTerms } from '../lib/terms.ts';

/** What the runner did with the latest main branch before work on the card started, in plain words. */
const SYNC_TEXT: Record<string, string> = {
  merged_into_working: 'The latest main branch was merged into the working branch before work started.',
  merged_into_card:
    'The working branch could not take the latest main branch (protected, or it moved), so it was merged into the card branch.',
  conflict_in_card:
    'Merging the latest main branch conflicts; the architect resolves the conflict on the card branch.',
  skipped_conflict:
    'The latest main branch conflicts with the working branch and was not merged; the work went ahead without it.',
};

/** The architect's report on a card: its summary, where it lives, and a link to the file when the forge is known. */
export function InvestigationPanel({ card }: { card: CardDto }) {
  const t = useOrgTerms();
  const inv = card.investigation;
  if (!inv) return null;
  const href = safeHref(inv.url);
  return (
    <Panel>
      <div data-testid="investigation">
        <h2 className="mb-2 flex flex-wrap items-center gap-2 text-lg font-semibold text-fg">
          {card.investigationOnly ? 'Investigation report' : 'Design report'}
          <Badge tone={inv.location === 'vault' ? 'violet' : 'green'}>
            {inv.location === 'vault' ? t.reword('in the vault') : 'in the repository'}
          </Badge>
        </h2>
        <p className="text-sm whitespace-pre-wrap text-muted" data-testid="investigation-summary">
          {inv.summary}
        </p>
        <p className="mt-2 break-all font-mono text-xs text-subtle" data-testid="investigation-path">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer noopener" className="underline">
              {inv.reportPath}
            </a>
          ) : (
            inv.reportPath
          )}
          {inv.commit ? ` @ ${inv.commit.slice(0, 10)}` : ''}
        </p>
      </div>
    </Panel>
  );
}

/** The note about the "merge latest main first" step, shown while it matters (a conflict or a skipped merge). */
export function MainSyncNote({ card }: { card: CardDto }) {
  const sync = card.mainSync;
  if (!sync) return null;
  const warn = sync.result === 'conflict_in_card' || sync.result === 'skipped_conflict';
  return (
    <Callout tone={warn ? 'warning' : 'info'} role="status" data-testid="main-sync">
      {SYNC_TEXT[sync.result] ?? `Main branch: ${sync.result}.`}
      {sync.files.length > 0 && (
        <span className="font-mono text-xs"> {sync.files.slice(0, 6).join(', ')}</span>
      )}
    </Callout>
  );
}
