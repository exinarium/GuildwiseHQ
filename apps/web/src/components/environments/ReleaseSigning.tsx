import type { ReleaseSigningStatus, ReleaseSigningTarget } from '@aom/shared';
import { useId } from 'react';
import {
  manifestUrl,
  usePrepareRelease,
  useSignOnWorkstation,
  useUploadSignature,
} from '../../api/queries/release-signing.ts';
import { Button, ErrorBox, Spinner } from '../ui.tsx';

/** A target that takes only a signed runner and has no signature for this release yet (the Release button waits for it). */
export const waitsForSignature = (t: ReleaseSigningTarget) => !!t.signing?.required && t.state !== 'signed';

const short = (sha: string | null) => (sha ? `${sha.slice(0, 12)}…` : '');

/** The one-line state of a target's runner, in the words of R30. */
export function runnerLine(t: ReleaseSigningTarget): string {
  switch (t.state) {
    case 'not_required':
      return 'Runner: not required';
    case 'signed':
      return `Runner: signed by ${t.signature?.keyId ?? t.signing?.keyId}`;
    case 'no_release':
      return 'Runner: waiting for signature. Only a shipped release can be signed: ship a release of this commit first.';
    case 'not_prepared':
      return 'Runner: waiting for signature. Package the runner for this place first.';
    case 'preparing':
      return 'Runner: waiting for signature. Packaging the runner on the workstation…';
    case 'prepare_failed':
      return `Runner: waiting for signature. Packaging failed${t.error ? `: ${t.error}` : ''}.`;
    case 'signing':
      return 'Runner: waiting for signature. Approve it on the workstation that holds the key: guildwise-runner approve.';
    case 'sign_failed':
      return `Runner: waiting for signature. Not signed on the workstation${t.error ? `: ${t.error}` : ''}.`;
    default:
      return `Runner: waiting for signature by key ${t.signing?.keyId}.`;
  }
}

/**
 * Release-flow signing (R30) on the release sheet: per place, whether its runner must be signed, and if so the two ways to
 * do it: on the workstation that holds the key (with a local yes there), or by signing the downloaded manifest offline and
 * uploading the `.minisig`. The server verifies every signature; the secret key never comes here.
 */
export function ReleaseSigning({
  projectId,
  commit,
  status,
  only,
}: {
  projectId: string;
  commit: string | null;
  status: ReleaseSigningStatus;
  /** The places being released (by name); all of the environment's when absent. */
  only?: string[] | undefined;
}) {
  const targets = status.targets.filter((t) => !only || only.includes(t.targetName));
  if (targets.length === 0 || targets.every((t) => !t.signing?.required)) return null;
  return (
    <section aria-label="Runner signature" className="flex flex-col gap-3" data-testid="release-signing">
      <h3 className="font-semibold text-fg">Runner signature</h3>
      {targets.map((t) => (
        <TargetSigning
          key={t.targetId}
          projectId={projectId}
          commit={commit}
          releaseId={status.release?.releaseId ?? null}
          version={status.release?.version ?? null}
          target={t}
        />
      ))}
    </section>
  );
}

function TargetSigning({
  projectId,
  commit,
  releaseId,
  version,
  target: t,
}: {
  projectId: string;
  commit: string | null;
  releaseId: string | null;
  version: string | null;
  target: ReleaseSigningTarget;
}) {
  const prepare = usePrepareRelease(projectId);
  const sign = useSignOnWorkstation(projectId);
  const upload = useUploadSignature(projectId);
  const fileId = useId();
  const tid = `release-signing-${t.targetName}`;
  const canPrepare = !!commit && ['not_prepared', 'prepare_failed'].includes(t.state);
  const canSign = !!releaseId && ['waiting_signature', 'sign_failed'].includes(t.state);
  const tone =
    t.state === 'signed' || t.state === 'not_required'
      ? 'text-success'
      : t.state === 'prepare_failed' || t.state === 'sign_failed'
        ? 'text-danger'
        : 'text-warning';
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid={tid}>
      <p className="font-medium text-fg">
        {t.targetName}
        {version ? <span className="text-muted"> · {version}</span> : null}
      </p>
      <p className={`text-sm ${tone}`} data-testid={`${tid}-state`}>
        {(t.state === 'preparing' || t.state === 'signing') && <Spinner inline label="" />} {runnerLine(t)}
      </p>
      {canPrepare && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={prepare.isPending}
            onClick={() => commit && prepare.mutate({ targetId: t.targetId, commit })}
            data-testid={`${tid}-prepare`}
          >
            Package the runner for {t.targetName}
          </Button>
        </div>
      )}
      {t.state === 'signed' && commit && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted">
            This signed runner is kept for a rollback of {t.targetName}. Package it again only if the
            workstation that deploys {t.targetName} lost its files: it then needs a new signature before it
            deploys.
          </p>
          <div>
            <Button
              variant="secondary"
              size="sm"
              loading={prepare.isPending}
              onClick={() =>
                window.confirm(
                  `Package the runner of ${version ?? 'this release'} for ${t.targetName} again? Its signature no longer counts, and it waits for a new one.`,
                ) && prepare.mutate({ targetId: t.targetId, commit, repackage: true })
              }
              data-testid={`${tid}-repackage`}
            >
              Package again (needs a new signature)
            </Button>
          </div>
        </div>
      )}
      {canSign && releaseId && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">
            Sign it with key <span className="font-mono">{t.signing?.keyId}</span> in one of two ways:
          </p>
          <div>
            <Button
              variant="secondary"
              size="sm"
              loading={sign.isPending}
              onClick={() => sign.mutate({ releaseId, targetId: t.targetId })}
              data-testid={`${tid}-sign`}
            >
              Sign on the workstation
            </Button>
            <span className="ml-2 text-xs text-muted">
              then approve it there with guildwise-runner approve
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <a
              className="text-accent underline"
              href={manifestUrl(projectId, releaseId, t.targetId)}
              download="manifest.json"
              data-testid={`${tid}-download`}
            >
              Download manifest.json (sha256 {short(t.artefactSha256)})
            </a>
            <label htmlFor={fileId} className="cursor-pointer text-accent underline">
              Upload signature
            </label>
            <input
              id={fileId}
              type="file"
              accept=".minisig,text/plain"
              className="sr-only"
              data-testid={`${tid}-upload`}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                upload.mutate({
                  releaseId,
                  targetId: t.targetId,
                  minisig: await file.text(),
                  ...(t.artefactSha256 ? { artefactSha256: t.artefactSha256 } : {}),
                });
              }}
            />
          </div>
          <p className="text-xs text-muted">
            Offline: <span className="font-mono">minisign -S -s &lt;your key&gt; -m manifest.json</span>, then
            upload manifest.json.minisig.
          </p>
        </div>
      )}
      <ErrorBox error={prepare.error ?? sign.error ?? upload.error} />
    </div>
  );
}
