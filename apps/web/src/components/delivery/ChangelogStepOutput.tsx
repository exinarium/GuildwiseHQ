import { CHANGELOG_HEADINGS, ReleaseChangelogOutputSchema } from '@aom/shared';

/** One-line summary of the 'Write changelog' step output for a repository ("3 entries added (Added 1, Fixed 2)"). */
export function changelogSummary(
  repoName: string,
  state: string,
  output: unknown,
): string | null {
  if (state === 'running') return 'Writing entries…';
  const o = ReleaseChangelogOutputSchema.safeParse(output ?? undefined);
  if (!o.success || output == null) return null;
  const n = o.data.added.length;
  if (n === 0) return `${repoName}: no new changes`;
  const counts = CHANGELOG_HEADINGS.map((h) => [h, o.data.added.filter((e) => e.heading === h).length] as const)
    .filter(([, c]) => c > 0)
    .map(([h, c]) => `${h} ${c}`)
    .join(', ');
  return `${repoName}: ${o.data.created ? 'CHANGELOG.md created, ' : ''}${n} entr${n === 1 ? 'y' : 'ies'} added (${counts})`;
}

/** The entries the step wrote, grouped by heading, plus what was already there or not written. Plain text only. */
export function ChangelogStepOutput({
  repoName,
  state,
  output,
}: {
  repoName: string;
  state: string;
  output: unknown;
}) {
  const summary = changelogSummary(repoName, state, output);
  if (!summary) return null;
  const parsed = ReleaseChangelogOutputSchema.safeParse(output ?? undefined);
  const o = parsed.success && output != null ? parsed.data : null;
  const known = o ? o.duplicates.length + o.covered.length : 0;
  return (
    <details className="mt-1" data-testid={`prep-changelog-${repoName}`}>
      <summary className="min-h-11 cursor-pointer py-2 text-sm sm:min-h-0 sm:py-0">{summary}</summary>
      {o && (
        <div className="mt-1 flex flex-col gap-2 text-xs">
          {CHANGELOG_HEADINGS.map((h) => {
            const list = o.added.filter((e) => e.heading === h);
            if (list.length === 0) return null;
            return (
              <div key={h}>
                <p className="font-medium text-fg">{h}</p>
                <ul className="list-disc pl-5">
                  {list.map((e) => (
                    <li key={e.text} className="break-words">
                      {e.text}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {known > 0 && (
            <p className="text-subtle">
              Already in the changelog: {known} change{known === 1 ? '' : 's'}
            </p>
          )}
          {o.skipped.length > 0 && (
            <div>
              <p className="font-medium text-fg">Not written</p>
              <ul className="list-disc pl-5">
                {o.skipped.map((s) => (
                  <li key={s.source} className="break-words">
                    <span className="font-mono">{s.source.slice(0, 7)}</span>: {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {o.warnings.map((w) => (
            <p key={w} className="text-warning-soft-fg break-words">
              {w}
            </p>
          ))}
        </div>
      )}
    </details>
  );
}
