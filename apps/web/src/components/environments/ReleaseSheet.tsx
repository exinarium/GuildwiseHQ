import type { DeployResult } from '@aom/shared';
import { useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { useDeploy, useDeployPreview, useRelease } from '../../api/queries/delivery.ts';
import { useEnvStatus } from '../../api/queries/environments.ts';
import { useReleaseSigning } from '../../api/queries/release-signing.ts';
import { useDebounced } from '../../lib/useDebounced.ts';
import { Button, Dialog, ErrorBox, Spinner, TextInput, useToast } from '../ui.tsx';
import { commitSourceText, DeployCommitPreview } from './DeployCommitPreview.tsx';
import { ReleaseSigning, waitsForSignature } from './ReleaseSigning.tsx';

/**
 * Releasing to a site (docs/design/environments-ux.md journey I): the version, what changed, which places, the facts (a backup
 * comes first) and the rules by name. A refused release says which rule is missing; the button stays off with that reason on
 * screen. Owner or Admin only (the server checks it again).
 */
export function ReleaseSheet({
  projectId,
  env,
  label,
  onClose,
}: {
  projectId: string;
  env: string;
  label: string;
  onClose: () => void;
}) {
  const status = useEnvStatus(projectId);
  const release = useRelease();
  const deploy = useDeploy(projectId);
  const toast = useToast();
  const w = status.data?.find((s) => s.env === env)?.waitingRelease ?? null;
  const [refused, setRefused] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean> | null>(null);
  const places = w?.places ?? [];
  const pick = picked ?? Object.fromEntries(places.map((p) => [p.runId, places.length === 1]));
  const chosen = places.filter((p) => pick[p.runId]);
  const several = places.length > 1;
  const blocked = w ? !w.rulesMet : false;
  const pending = release.isPending || deploy.isPending;
  const done = () => {
    toast.success(`Releasing to ${label}`);
    onClose();
  };
  // What the server said: nothing refused closes the sheet; everything refused stays with its reason; some of each starts the
  // ones that were accepted and keeps the refused ones on screen with their reasons (the sheet is not closed over them).
  const answered = (r: DeployResult) => {
    const no = r.runs.filter((x) => x.status === 'refused');
    if (no.length === 0) return done();
    if (no.length === r.runs.length) return setRefused([r.message]);
    const started = r.runs.filter((x) => x.status !== 'refused').map((x) => x.target);
    toast.success(`Releasing to ${started.join(', ')}`);
    setRefused(no.map((x) => `${x.target || label}: ${x.detail ?? x.refusal ?? 'refused'}`));
  };
  // (A) a run waits for release: its commit is fixed. (B) otherwise a deploy, where the owner may enter a commit.
  const releasePath = !!w && places.length > 0;
  const waitingCommit = w?.commit || null;
  const [typed, setTyped] = useState('');
  const entered = typed.replace(/\s+/g, '').toLowerCase() || null;
  const [settled, flush] = useDebounced(entered, 400);
  const settling = !releasePath && entered !== settled;
  const asked = releasePath ? waitingCommit : (settled ?? waitingCommit);
  const preview = useDeployPreview(projectId, env, asked, !status.isPending);
  const showsWaiting = !!asked && asked === waitingCommit && !settled;
  // R30: a place that takes only a signed runner waits for its signature (the server refuses it as well).
  const signing = useReleaseSigning(
    projectId,
    env,
    preview.data?.sha ?? asked,
    !status.isPending && !settling,
  );
  const signingFor = releasePath ? chosen.map((p) => p.name) : undefined;
  const unsigned = (signing.data?.targets ?? []).filter(
    (t) => waitsForSignature(t) && (!signingFor || signingFor.includes(t.targetName)),
  );
  const previewBlocked =
    status.isPending || settling || preview.isPending || preview.isError || signing.isLoading;
  const pe = preview.error;
  const retryable = pe instanceof ApiError ? pe.status >= 500 || pe.status === 409 : !!pe;
  const go = () => {
    setRefused(null);
    if (releasePath) {
      release.mutate(
        chosen.map((p) => p.runId),
        { onSuccess: answered },
      );
      return;
    }
    const p = preview.data;
    if (!p) return;
    const body = settled
      ? { env, commit: p.sha }
      : waitingCommit
        ? { env, commit: waitingCommit }
        : { env, expectCommit: p.sha };
    deploy.mutate(body, {
      onSuccess: answered,
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'commit_moved') void preview.refetch();
      },
    });
  };
  const reason = blocked
    ? `Waiting for: ${w?.waitingFor.join('; ') || 'the rules to hold'}.`
    : several && chosen.length === 0
      ? 'Tick at least one place to release to.'
      : unsigned.length > 0
        ? `Waiting for a signed runner for ${unsigned.map((t) => t.targetName).join(', ')}.`
        : null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Release to ${label}`}
      description="The Owner-approved setup puts this version on the site."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={go}
            loading={pending}
            disabled={!!reason || previewBlocked}
            data-testid="release-now"
          >
            Release now
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm" data-testid="release-sheet">
        {status.isPending ? (
          <Spinner label="Loading" />
        ) : (
          <>
            <section aria-label="Version" className="flex flex-col gap-2">
              <h3 className="font-semibold text-fg">Version</h3>
              {preview.isPending && <Spinner inline label="Checking the commit" />}
              {preview.data && (
                <DeployCommitPreview
                  preview={preview.data}
                  sourceText={commitSourceText(preview.data, showsWaiting)}
                />
              )}
              {!releasePath && (
                <TextInput
                  label="Commit (optional)"
                  hint="Leave empty to build the commit shown above. Enter a SHA to build that commit instead."
                  value={typed}
                  onChange={(e) => {
                    setTyped(e.target.value);
                    setRefused(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      flush();
                      e.currentTarget.blur();
                    }
                  }}
                  className="font-mono"
                  inputMode="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="done"
                  maxLength={64}
                  aria-describedby={preview.isError ? 'release-commit-error' : undefined}
                  aria-invalid={preview.isError && settled ? true : undefined}
                  data-testid="release-commit-input"
                />
              )}
              {preview.isError && (
                <div id="release-commit-error" data-testid="release-commit-error">
                  <ErrorBox error={pe} onRetry={retryable ? () => void preview.refetch() : undefined} />
                </div>
              )}
              {releasePath && (
                <p className="text-xs text-muted" data-testid="release-commit-fixed">
                  This release was prepared for this commit. To build another one, cancel it under Releases,
                  then deploy again.
                </p>
              )}
            </section>
            {w && w.cards.length > 0 && (
              <section aria-label="What changed">
                <h3 className="font-semibold text-fg">What changed</h3>
                <p className="text-muted">
                  From {w.cards.length} merged {w.cards.length === 1 ? 'card' : 'cards'}:
                </p>
                <ul className="mt-1 list-disc pl-5 text-fg" data-testid="release-cards">
                  {w.cards.map((c) => (
                    <li key={c.ref}>
                      <span className="font-mono text-xs text-muted">{c.ref}</span> {c.title}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {places.length > 0 && (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="font-semibold text-fg">Where to</legend>
                {places.map((p) =>
                  several ? (
                    <label key={p.runId} className="flex min-h-11 items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={!!pick[p.runId]}
                        onChange={(e) => setPicked({ ...pick, [p.runId]: e.target.checked })}
                        data-testid={`release-place-${p.name}`}
                      />
                      <span className="font-medium text-fg">{p.name}</span>
                    </label>
                  ) : (
                    <p key={p.runId} className="font-medium text-fg">
                      {p.name}
                    </p>
                  ),
                )}
              </fieldset>
            )}
            {signing.data && (
              <ReleaseSigning
                projectId={projectId}
                commit={preview.data?.sha ?? asked}
                status={signing.data}
                only={signingFor}
              />
            )}
            <p className="text-muted" data-testid="release-backup">
              A backup of the database is taken first. If the new version does not answer afterwards, the
              previous one is put back.
            </p>
            {w && (
              <section aria-label="Rules">
                <h3 className="font-semibold text-fg">Rules</h3>
                {w.rulesMet ? (
                  <p className="text-success" data-testid="release-rules-met">
                    All rules hold.
                  </p>
                ) : (
                  <p className="text-warning" data-testid="release-waiting-for">
                    Waiting for: {w.waitingFor.join('; ')}
                  </p>
                )}
              </section>
            )}
            {!reason && previewBlocked && !preview.isError && (
              <p role="status" className="text-xs text-subtle">
                Checking which commit will be built…
              </p>
            )}
            {reason && (
              <p role="status" className="text-xs text-subtle" data-testid="release-disabled-reason">
                {reason} The button turns on by itself when it holds.
              </p>
            )}
            {refused && (
              <div role="alert" className="text-sm text-danger" data-testid="release-refused">
                {refused.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            )}
            <ErrorBox error={release.error ?? deploy.error} />
          </>
        )}
      </div>
    </Dialog>
  );
}
