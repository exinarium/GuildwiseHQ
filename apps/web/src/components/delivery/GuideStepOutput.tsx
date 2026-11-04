import { ReleaseDocsPrepGuideOutputSchema } from '@aom/shared';

const PDF = {
  rebuilt: 'PDF guide rebuilt',
  'no change': 'PDF guide not rebuilt (the text did not change)',
  'no PDF build': 'This repository has no PDF guide build',
} as const;

/** The output of the 'Update user guide' prep step for one repository: sections changed and added, or why it skipped. */
export function GuideStepOutput({ output }: { output: unknown }) {
  const p = ReleaseDocsPrepGuideOutputSchema.safeParse(output);
  if (!p.success) return null;
  const o = p.data;
  if (o.skipped)
    return (
      <p className="text-xs text-subtle" data-testid="guide-output-skipped">
        skipped: {o.skipped}
      </p>
    );
  return (
    <div className="mt-1 flex flex-col gap-1 text-xs" data-testid="guide-output">
      {o.nothing && o.changed.length === 0 && o.added.length === 0 && (
        <p className="text-subtle">No guide change: {o.nothing}.</p>
      )}
      {o.changed.length > 0 && (
        <div>
          <span className="font-medium">Sections changed</span>
          <ul className="ml-4 list-disc" data-testid="guide-output-changed">
            {o.changed.map((c) => (
              <li key={c.section} className="break-words">
                {c.section}
              </li>
            ))}
          </ul>
        </div>
      )}
      {o.added.length > 0 && (
        <div>
          <span className="font-medium">Sections added</span>
          <ul className="ml-4 list-disc" data-testid="guide-output-added">
            {o.added.map((c) => (
              <li key={c.section} className="break-words">
                {c.section} <span className="text-subtle">(after {c.after})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(o.changed.length > 0 || o.added.length > 0) && <p className="text-subtle">{PDF[o.pdf]}.</p>}
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
