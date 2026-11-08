import { ReleaseDocsPrepHelpOutputSchema } from '@aom/shared';
import { Link } from 'react-router';

/** The output of the 'Update Help articles' prep step for one repository: sections updated and added, or why not. */
export function HelpStepOutput({ output }: { output: unknown }) {
  const p = ReleaseDocsPrepHelpOutputSchema.safeParse(output);
  if (!p.success) return null;
  const o = p.data;
  if (o.skipped)
    return (
      <p className="text-xs text-subtle" data-testid="help-output-skipped">
        Skipped: no Help articles in this repository.
      </p>
    );
  const none = o.changed.length === 0 && o.added.length === 0;
  return (
    <div className="mt-1 flex flex-col gap-1 text-xs" data-testid="help-output">
      {none && (
        <p className="text-subtle" data-testid="help-output-none">
          {o.nothing === 'no new changes' ? 'No new changes.' : 'No Help article needed changes.'}
        </p>
      )}
      {o.changed.length > 0 && (
        <div>
          <span className="font-medium">Help sections updated</span>
          <ul className="ml-4 list-disc" data-testid="help-output-changed">
            {o.changed.map((c) => (
              <li key={`${c.article}#${c.section}`} className="break-words">
                <Link className="underline" to={`/help/${c.article}#${c.section}`}>
                  <strong>{c.title}</strong> › {c.heading}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {o.added.length > 0 && (
        <div>
          <span className="font-medium">Help sections added</span>
          <ul className="ml-4 list-disc" data-testid="help-output-added">
            {o.added.map((c) => (
              <li key={`${c.article}#${c.section}`} className="break-words">
                <Link className="underline" to={`/help/${c.article}#${c.section}`}>
                  <strong>{c.title}</strong> › {c.heading}
                </Link>{' '}
                <span className="text-subtle">(after #{c.after})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {o.skippedChanges.length > 0 && (
        <p className="text-subtle">
          {o.skippedChanges.length} {o.skippedChanges.length === 1 ? 'change is' : 'changes are'} not
          user-visible.
        </p>
      )}
      {[...o.errors, ...o.warnings, ...o.notes].length > 0 && (
        <ul className="ml-4 list-disc">
          {o.errors.map((e) => (
            <li key={`e-${e}`} className="break-words text-danger-soft-fg">
              {e}
            </li>
          ))}
          {[...o.warnings, ...o.notes].map((w) => (
            <li key={`w-${w}`} className="break-words text-subtle">
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
