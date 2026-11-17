import type { DeployCommitPreview as Preview } from '@aom/shared';
import { formatDateTime } from '../../lib/time.ts';
import { CopyButton } from '../delivery/connect/CopyButton.tsx';

/** The source of the commit in words; `waiting` is a release already prepared for this commit. */
export function commitSourceText(p: Preview, waiting: boolean): string {
  if (waiting) return 'Waiting for release';
  const d = p.sourceDetail ? ` (${p.sourceDetail})` : '';
  switch (p.source) {
    case 'release':
      return `Latest release${d}`;
    case 'working-branch':
      return p.branch ? `Working branch tip (${p.branch})` : 'Working branch tip';
    case 'promoted':
      return `What an earlier environment runs${d}`;
    case 'explicit':
      return 'Commit you entered';
    default:
      return 'Chosen by the server';
  }
}

/** The commit a deploy will build: short SHA (full SHA on hover and Copy), subject, date and source. */
export function DeployCommitPreview({ preview: p, sourceText }: { preview: Preview; sourceText: string }) {
  return (
    <div className="flex flex-col gap-1" data-testid="release-commit">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-base text-fg" title={p.sha} data-testid="release-version">
          {p.shortSha || p.sha.slice(0, 7)}
        </span>
        <CopyButton text={p.sha} label="Copy full SHA" testId="release-commit-copy" />
      </div>
      <p className="break-words text-fg" data-testid="release-commit-subject">
        {p.subject ?? <span className="text-muted">No commit message</span>}
      </p>
      <p className="text-xs text-muted">
        {p.committedAt && (
          <>
            <time dateTime={p.committedAt} data-testid="release-commit-date">
              {formatDateTime(p.committedAt)}
            </time>
            {' · '}
          </>
        )}
        <span data-testid="release-commit-source">{sourceText}</span>
        {p.author && <> · {p.author}</>}
      </p>
    </div>
  );
}
