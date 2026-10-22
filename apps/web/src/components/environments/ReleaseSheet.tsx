import type { DeployResult } from '@aom/shared';
import { useState } from 'react';
import { useDeploy, useRelease } from '../../api/queries/delivery.ts';
import { useEnvStatus } from '../../api/queries/environments.ts';
import { Button, Dialog, ErrorBox, Spinner, useToast } from '../ui.tsx';

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
  const go = () => {
    setRefused(null);
    if (w && places.length > 0)
      release.mutate(
        chosen.map((p) => p.runId),
        { onSuccess: answered },
      );
    else deploy.mutate({ env, ...(w?.commit ? { commit: w.commit } : {}) }, { onSuccess: answered });
  };
  const reason = blocked
    ? `Waiting for: ${w?.waitingFor.join('; ') || 'the rules to hold'}.`
    : several && chosen.length === 0
      ? 'Tick at least one place to release to.'
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
            disabled={!!reason || status.isPending}
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
            <section aria-label="Version">
              <h3 className="font-semibold text-fg">Version</h3>
              <p className="font-mono text-base text-fg" data-testid="release-version">
                {w?.version ?? (w?.commit ? w.commit.slice(0, 7) : 'the latest approved version')}
              </p>
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
