import { type CardDto, SIZE_UNIT_WORDS, type StoredDesignSizing } from '@aom/shared';
import { safeHref } from '../lib/links.ts';
import { useOrgTerms } from '../lib/terms.ts';
import { Badge, Callout, Panel } from './ui.tsx';

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
        {inv.sizing && !card.investigationOnly && <DesignSizing sizing={inv.sizing} />}
      </div>
    </Panel>
  );
}

const unitWords = (unit: string | null): string =>
  unit && unit in SIZE_UNIT_WORDS ? SIZE_UNIT_WORDS[unit as keyof typeof SIZE_UNIT_WORDS] : (unit ?? '');

/** The design's size estimate, the size verdict against the project's budget and the risk class (read only). */
export function DesignSizing({ sizing }: { sizing: StoredDesignSizing }) {
  const budget = sizing.budget != null ? ` (budget ${sizing.budget})` : '';
  return (
    <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2" data-testid="design-sizing">
      <div>
        <dt className="text-xs text-subtle">Size estimate</dt>
        <dd className="text-fg" data-testid="design-size-estimate">
          {sizing.estimate != null ? `${sizing.estimate} ${unitWords(sizing.unit)}` : 'None'}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-subtle">Size verdict</dt>
        <dd data-testid="design-size-verdict">
          {sizing.verdict === 'over_budget' ? (
            <Badge tone="amber">Over budget{budget}</Badge>
          ) : sizing.verdict === 'within_budget' ? (
            <Badge tone="green">Within budget{budget}</Badge>
          ) : (
            <span className="text-muted">{sizing.verdictText}</span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-subtle">Risk class</dt>
        <dd className="text-fg" data-testid="design-risk-class">
          {sizing.risk.status
            ? `None: ${sizing.risk.status}`
            : sizing.risk.class
              ? `${sizing.risk.class}${sizing.risk.raisedByDeclaration ? " (raised by the architect's declaration)" : ''}`
              : 'None (no named path is in the path-to-risk map)'}
        </dd>
      </div>
      {sizing.folderScope.length > 0 && (
        <div>
          <dt className="text-xs text-subtle">Folder scope</dt>
          <dd className="break-all font-mono text-xs text-muted">{sizing.folderScope.join(', ')}</dd>
        </div>
      )}
      {sizing.seams.length > 0 && (
        <div className="sm:col-span-2">
          <dt className="text-xs text-subtle">Proposed split seams</dt>
          <dd>
            <ul className="list-disc pl-5 text-muted">
              {sizing.seams.map((s) => (
                <li key={`${s.title}-${s.folders.join(',')}`}>
                  {s.title}: <span className="break-all font-mono text-xs">{s.folders.join(', ')}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
    </dl>
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
