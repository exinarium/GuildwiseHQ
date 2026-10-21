import { hasBlockers, type planChanges, type SetupPreviewDto } from '@aom/shared';
import { FoundChanges } from '../delivery/setup/FoundChanges.tsx';
import { Button, Callout, ErrorBox, Spinner } from '../ui.tsx';
import { type Answers, plainLint, restartWords, whenText } from './answers.ts';

/** The last step of the Add environment dialog: the steps as plain words, what is kept, then Save. */
export function EnvReview({
  answers,
  preview,
  previewing,
  previewError,
  changes,
  publishError,
  saving,
  written,
  failed,
  onSave,
  onAgain,
  onDone,
  onAdvanced,
  removeFiles,
  onToggleRemove,
}: {
  answers: Answers;
  preview: SetupPreviewDto | undefined;
  previewing: boolean;
  previewError: unknown;
  changes: ReturnType<typeof planChanges>;
  publishError: unknown;
  saving: boolean;
  written: boolean;
  failed: string | null;
  onSave: () => void;
  onAgain: () => void;
  onDone: () => void;
  onAdvanced: () => void;
  removeFiles: string[];
  onToggleRemove: (path: string) => void;
}) {
  const errors = preview?.lint.filter((l) => l.level === 'error') ?? [];
  const warnings = preview?.lint.filter((l) => l.level === 'warn') ?? [];
  const blocked = hasBlockers(preview?.changes?.length ? (preview.changes as never) : changes);
  const native = answers.runtime === 'native';
  return (
    <section className="flex flex-col gap-4" data-testid="env-review">
      <h3 className="text-lg font-semibold text-fg">Review: {answers.label}</h3>
      {previewing && (
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          <Spinner inline label="Preparing" />
          Preparing the steps...
        </div>
      )}
      <ErrorBox error={previewError} />
      {preview && !preview.ok && (
        <Callout tone="danger" title="These steps cannot be saved yet" data-testid="review-issues">
          <ul className="list-disc pl-4">
            {preview.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </Callout>
      )}
      {preview?.ok && (
        <>
          <p className="text-sm text-muted">
            {native
              ? `Each update gets the new version, builds it in a new folder, switches to it and will ${restartWords(answers.native)}. The last ${answers.native.keepReleases} versions are kept.`
              : answers.hosting === 'ssh'
                ? `Each update backs up the database, ${answers.method === 'registry' ? `downloads the new version on ${answers.host}` : answers.method === 'build_on_server' ? `builds the new version on ${answers.host}` : `copies a new version to ${answers.host}`}, switches only the app, checks the site and goes back if it is not healthy.`
                : 'Each update backs up the database, rebuilds only the app from the approved version, checks it and goes back if it is not healthy.'}{' '}
            {whenText(answers.trigger)}.
          </p>
          <FoundChanges items={preview.changes.filter((c) => c.env === answers.name)} />
          {(preview.unmodelled?.length ?? 0) > 0 && (
            <div className="rounded-control border border-line p-3 text-sm" data-testid="review-unmodelled">
              <p className="font-medium text-fg">Other files in the project's deploy folder</p>
              <p className="mt-0.5 text-muted">
                Guildwise does not make these. They stay exactly as they are, unless you tick one to delete
                it.
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {preview.unmodelled?.map((f) => (
                  <li key={f}>
                    <label className="flex min-h-11 items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={removeFiles.includes(f)}
                        onChange={() => onToggleRemove(f)}
                      />
                      <span className="font-mono text-xs [overflow-wrap:anywhere]">{f}</span>
                      <span className="text-xs text-subtle">
                        {removeFiles.includes(f) ? 'will be deleted' : 'kept'}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {errors.length > 0 && (
            <Callout tone="danger" title="Fix this first" data-testid="review-lint-errors">
              <ul className="list-disc pl-4">
                {errors.map((l) => (
                  <li key={l.message}>{plainLint(l)}</li>
                ))}
              </ul>
            </Callout>
          )}
          {warnings.length > 0 && (
            <Callout tone="warning" title="Good to know">
              <ul className="list-disc pl-4">
                {warnings.map((l) => (
                  <li key={l.message}>{plainLint(l)}</li>
                ))}
              </ul>
            </Callout>
          )}
        </>
      )}
      {written ? (
        <Callout tone="success" title="Saved" data-testid="review-saved">
          The steps are in the project's files. Next: <strong>Try it without changing anything</strong>, then
          the Owner approves this version. Nothing runs before that.
        </Callout>
      ) : (
        <>
          {failed && (
            <Callout tone="danger" title="The computer could not save it" data-testid="review-failed">
              {failed}
            </Callout>
          )}
          <ErrorBox error={publishError} />
        </>
      )}
      <div className="sticky bottom-0 -mx-5 flex flex-wrap gap-2 border-t border-line bg-surface px-5 py-3">
        {written ? (
          <Button variant="primary" onClick={onDone} data-testid="review-done">
            Done
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              onClick={onSave}
              loading={saving}
              disabled={!preview?.ok || errors.length > 0 || blocked || saving}
              data-testid="review-save"
            >
              Save
            </Button>
            <Button onClick={onAgain}>Preview again</Button>
            <Button variant="ghost" onClick={onAdvanced}>
              Show technical details
            </Button>
          </>
        )}
      </div>
      {!written && (
        <p className="text-xs text-subtle">
          Saving writes the steps into the project files. The Owner still approves the exact version before
          anything runs.
        </p>
      )}
    </section>
  );
}
