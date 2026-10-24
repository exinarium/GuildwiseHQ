import { diffPackTrees, type TreeFileChange } from '@aom/shared';
import { useMemo } from 'react';
import { diffLines } from '../../lib/diff-lines.ts';
import { Badge, Disclosure } from '../ui.tsx';

const TONE = { added: 'green', removed: 'red', changed: 'blue', unchanged: 'neutral' } as const;

function FileText({ change }: { change: TreeFileChange }) {
  if (change.status === 'added' || change.status === 'unchanged')
    return (
      <pre className="max-h-96 overflow-auto rounded-control bg-sunken p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
        {change.after}
      </pre>
    );
  if (change.status === 'removed')
    return (
      <pre className="max-h-96 overflow-auto rounded-control bg-sunken p-2 text-xs whitespace-pre-wrap text-danger-soft-fg [overflow-wrap:anywhere]">
        {change.before}
      </pre>
    );
  const lines = diffLines(change.before ?? '', change.after ?? '');
  return (
    <pre
      className="max-h-96 overflow-auto rounded-control bg-sunken p-2 text-xs [overflow-wrap:anywhere]"
      data-testid="text-diff"
    >
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff is positional
          key={i}
          data-kind={l.kind}
          className={
            l.kind === 'add'
              ? 'bg-success-soft text-success-soft-fg'
              : l.kind === 'del'
                ? 'bg-danger-soft text-danger-soft-fg'
                : 'text-muted'
          }
        >
          {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

/**
 * The files of a pack revision, and what changed since another one: a file-level list (added, removed, changed, unchanged) and,
 * per file, the text (the whole file when it is new, a line diff when it changed). `before` null: there is no earlier version, so
 * every file is shown whole. Used by the reviewer (Q57) and by the author against the approved version.
 */
export function PackVersionDiff({
  before,
  after,
  beforeLabel,
}: {
  before: Record<string, string> | null | undefined;
  after: Record<string, string>;
  beforeLabel?: string;
}) {
  const changes = useMemo(() => diffPackTrees(before, after), [before, after]);
  const n = (s: TreeFileChange['status']) => changes.filter((c) => c.status === s).length;
  const shown = changes.filter((c) => c.status !== 'unchanged');
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="pack-version-diff">
      <p className="text-muted" data-testid="version-diff-summary">
        {before
          ? `Compared with ${beforeLabel ?? 'the approved version'}: ${n('added')} added, ${n('changed')} changed, ${n('removed')} removed, ${n('unchanged')} unchanged.`
          : `${changes.length} files.`}
      </p>
      <ul className="flex flex-col gap-1">
        {(before ? shown : changes).map((c) => (
          <li key={c.path} data-testid={`version-file-${c.path}`} data-status={c.status}>
            <Disclosure
              summary={
                <span className="flex items-center gap-2">
                  <code className="text-xs text-fg">{c.path}</code>
                  {before && <Badge tone={TONE[c.status]}>{c.status}</Badge>}
                </span>
              }
            >
              <FileText change={c} />
            </Disclosure>
          </li>
        ))}
      </ul>
      {before && n('unchanged') > 0 && (
        <p className="text-xs text-subtle">{n('unchanged')} files did not change.</p>
      )}
    </div>
  );
}
