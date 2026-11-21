import {
  type DeployExecPayload,
  type DeployTargetSigning,
  DeployTargetSigningSchema,
  RUNNER_SIGNATURE_REQUIRED,
  targetArtefactPath,
} from '@aom/shared';
import { one, type Queryable, type Row } from '../db/sql.ts';

/**
 * The deploy gate of R30: a target with `signing.required` deploys only a shipped release whose runner artefact, packaged
 * for that target, carries a signature by the target's key. The server only refuses early and passes the signature on; the
 * runner verifies it again against the file on disk, and the target environment trusts only its own key.
 */

export { RUNNER_SIGNATURE_REQUIRED };
/** 409 of a server move away from a target that takes only signed runners, onto one without the same key. */
export const RUNNER_SIGNING_KEY_FIRST = 'runner_signing_key_first';

/** A target's signing settings, or null (none, or not readable). */
export function targetSigning(t: Row | undefined | null): DeployTargetSigning | null {
  if (!t?.signing) return null;
  const r = DeployTargetSigningSchema.safeParse(t.signing);
  return r.success ? r.data : null;
}

export interface ShippedRelease {
  id: string;
  version: string;
  tag: string;
  repoId: string;
  commit: string;
}

/**
 * The shipped release of a commit (`releaseId` of R30 = `release_ships.id`, W0): its release commit, the merge that landed
 * it or the commit its tag points at. A short SHA (7+) matches by prefix. Newest first.
 */
export async function releaseForCommit(
  db: Queryable,
  projectId: string,
  commit: string | null | undefined,
  opts: { exact?: boolean } = {},
): Promise<ShippedRelease | null> {
  const c = (commit ?? '').trim().toLowerCase();
  if (!(opts.exact ? /^[0-9a-f]{40}([0-9a-f]{24})?$/ : /^[0-9a-f]{7,64}$/).test(c)) return null;
  const r = await one(
    db,
    `SELECT id, version, tag, repo_id, commit_sha, merge_sha, tag_sha FROM release_ships
      WHERE project_id = $1 AND status IN ('committed','tagged','published')
        AND (commit_sha LIKE $2 || '%' OR merge_sha LIKE $2 || '%' OR tag_sha LIKE $2 || '%')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [projectId, c],
  );
  if (!r) return null;
  const hit = [r.commit_sha, r.merge_sha, r.tag_sha].find(
    (x: string | null) => typeof x === 'string' && x.startsWith(c),
  ) as string;
  return { id: r.id, version: r.version, tag: r.tag, repoId: r.repo_id, commit: hit };
}

/** The newest artefact packaged for a release and target. */
export async function currentArtefact(
  db: Queryable,
  releaseId: string,
  targetId: string,
): Promise<Row | undefined> {
  return one(db, 'SELECT * FROM release_artefacts WHERE release_id=$1 AND target_id=$2', [
    releaseId,
    targetId,
  ]);
}

/** The stored signature by `keyId` over exactly that artefact. */
export async function signatureFor(
  db: Queryable,
  releaseId: string,
  targetId: string,
  keyId: string,
  artefactSha256: string,
): Promise<Row | undefined> {
  return one(
    db,
    `SELECT * FROM release_signatures WHERE release_id=$1 AND target_id=$2 AND key_id=$3 AND artefact_sha256=$4`,
    [releaseId, targetId, keyId, artefactSha256],
  );
}

export type SigningGateAnswer =
  | { required: false }
  | { required: true; refusal: string }
  | { required: true; signing: NonNullable<DeployExecPayload['signing']> };

/** What the deploy of `commit` to target row `t` needs: nothing, a refusal (409 `runner_signature_required`), or the signature. */
export async function signingGate(
  db: Queryable,
  projectId: string,
  t: Row,
  commit: string | null,
): Promise<SigningGateAnswer> {
  const s = targetSigning(t);
  // settings that are there but unreadable fail closed: the target asked for signing, whatever else the row says
  if (t.signing && !s)
    return {
      required: true,
      refusal: `${t.name} has runner signing settings that cannot be read: set its signing key again`,
    };
  if (!s?.required) return { required: false };
  // the gate matches the full commit only: a short prefix must not land on another, signed release
  const release = await releaseForCommit(db, projectId, commit, { exact: true });
  if (!release)
    return {
      required: true,
      refusal: `${t.name} takes only a signed runner, and ${commit ? `commit ${commit.slice(0, 10)}` : 'this commit'} is not a shipped release: ship a release, then sign its runner for ${t.name}`,
    };
  const a = await currentArtefact(db, release.id, t.id);
  if (!a)
    return {
      required: true,
      refusal: `${t.name} takes only a signed runner: package the runner of ${release.version} for ${t.name} and sign it (key ${s.keyId}) first`,
    };
  const sig = await signatureFor(db, release.id, t.id, s.keyId, a.artefact_sha256);
  if (!sig)
    return {
      required: true,
      refusal: `${t.name} takes only a signed runner: the runner of ${release.version} waits for a signature by key ${s.keyId}`,
    };
  return {
    required: true,
    signing: {
      releaseId: release.id,
      keyId: s.keyId,
      publicKey: s.publicKey,
      artefact: targetArtefactPath(s.artefact, t.name),
      artefactSha256: a.artefact_sha256,
      minisig: sig.minisig,
    },
  };
}

/**
 * A server move hands the environment's target name to the new server (`delivery/move.ts`). When the old server takes only
 * runners signed by a key, the new one must already require the same key (set by the Owner with step-up), or the move
 * would drop the gate. Returns the refusal, or null.
 */
export function moveSigningRefusal(from: Row, to: Row): string | null {
  const a = targetSigning(from);
  if (from.signing && !a)
    return `${from.name} has runner signing settings that cannot be read: set them again first`;
  if (!a?.required) return null;
  const b = targetSigning(to);
  if (b?.required && b.keyId === a.keyId && b.publicKey === a.publicKey) return null;
  return `${from.name} takes only runners signed by key ${a.keyId}: set the same runner signing key on ${to.name} first (Owner, with "Confirm it's you"), then move`;
}
