import { useMemo, useState } from 'react';
import { type DiffFile, type DiffLine, diffTotals, parseUnifiedDiff } from '../lib/diff.ts';
import { Badge, Button } from './ui.tsx';

const LINE_CLS: Record<DiffLine['kind'], string> = {
  add: 'bg-success-soft text-success-soft-fg',
  del: 'bg-danger-soft text-danger-soft-fg',
  ctx: 'text-fg',
  hunk: 'bg-info-soft text-info-soft-fg',
  meta: 'text-subtle',
};
const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '-', ctx: ' ', hunk: '', meta: '' };

const STATUS_LABEL: Record<DiffFile['status'], string> = {
  modified: 'modified',
  added: 'new file',
  deleted: 'deleted',
  renamed: 'renamed',
  binary: 'binary',
};

/** Files with more lines than this start collapsed (a big generated file does not push the rest off the page). */
const COLLAPSE_OVER = 400;

function FileDiff({ file, open, onToggle }: { file: DiffFile; open: boolean; onToggle: () => void }) {
  return (
    <section className="overflow-hidden rounded-md border border-line" data-testid="diff-file">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-sunken px-3 py-1.5 text-left text-sm"
        data-testid="diff-file-toggle"
      >
        <span aria-hidden="true" className="w-3 text-subtle">
          {open ? '▾' : '▸'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-fg" title={file.path}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <Badge tone={file.status === 'added' ? 'success' : file.status === 'deleted' ? 'danger' : 'neutral'}>
          {STATUS_LABEL[file.status]}
        </Badge>
        <span className="font-mono text-xs text-success">+{file.added}</span>
        <span className="font-mono text-xs text-danger">-{file.removed}</span>
      </button>
      {open && (
        <div className="overflow-x-auto" data-testid="diff-file-body">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {file.lines.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a diff are static and never reordered
                <tr key={`${i}-${l.kind}`} className={LINE_CLS[l.kind]} data-kind={l.kind}>
                  <td className="w-10 select-none px-2 text-right text-subtle">{l.oldNo ?? ''}</td>
                  <td className="w-10 select-none px-2 text-right text-subtle">{l.newNo ?? ''}</td>
                  <td className="w-4 select-none text-center">{SIGN[l.kind]}</td>
                  <td className="whitespace-pre pr-3">{l.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * A unified diff for the owner approval (code-v6): one block per file with its counts, collapsible, added lines green,
 * removed lines red, hunk headers blue. No dependency: the parser is `lib/diff.ts`.
 */
export function DiffView({ diff, truncated = false }: { diff: string; truncated?: boolean }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const totals = diffTotals(files);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const isOpen = (f: DiffFile) =>
    closed[f.path] === undefined ? f.lines.length <= COLLAPSE_OVER : !closed[f.path];
  const setAll = (open: boolean) => setClosed(Object.fromEntries(files.map((f) => [f.path, !open])));
  if (files.length === 0)
    return (
      <p className="text-sm text-subtle" data-testid="diff-empty">
        The diff is empty.
      </p>
    );
  return (
    <div className="flex flex-col gap-2" data-testid="diff-view">
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span data-testid="diff-totals">
          {totals.files} file{totals.files === 1 ? '' : 's'} changed,{' '}
          <span className="text-success">+{totals.added}</span>{' '}
          <span className="text-danger">-{totals.removed}</span>
        </span>
        <Button variant="ghost" onClick={() => setAll(true)} data-testid="diff-expand-all">
          Expand all
        </Button>
        <Button variant="ghost" onClick={() => setAll(false)} data-testid="diff-collapse-all">
          Collapse all
        </Button>
      </div>
      {truncated && (
        <p
          className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-soft-fg"
          data-testid="diff-truncated"
        >
          This diff is larger than 2 MB and was cut: the rest is not shown here. Open the branch comparison on
          the git host to read all of it.
        </p>
      )}
      {files.map((f) => (
        <FileDiff
          key={f.path}
          file={f}
          open={isOpen(f)}
          onToggle={() => setClosed((c) => ({ ...c, [f.path]: isOpen(f) }))}
        />
      ))}
    </div>
  );
}
