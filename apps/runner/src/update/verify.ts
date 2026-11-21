import { type RunnerReleaseManifest, RunnerReleaseManifestSchema } from '@aom/shared';
import type { Policy } from '../policy/schema.ts';
import { atOrAboveFloor, belowFloor, MIN_TRUSTED_RUNNER } from './floor.ts';
import { verifyMinisign } from './minisign.ts';
import { compareVersions } from './semver.ts';

/** True when installing `version` over `current` would be a downgrade (allowed only for a pin at or above the floor). */
export function isDowngrade(version: string, current: string): boolean {
  try {
    return compareVersions(version, current) < 0;
  } catch {
    return true;
  }
}

/**
 * The runner verifies what it installs (R18-U, always, on every install): the minisign signature over `manifest.json`
 * (which carries the tgz sha256; the download is checked against it), then the floor, and it refuses a downgrade. An
 * unsigned manifest is accepted only from an origin in local `allowUnsignedUpdatesFrom` [rv5-6], or from the pairing
 * origin recorded as `legacyUpdateOrigin` for a runner that reached 1.10.0 through the old in-place update (R29): exactly
 * what that runner trusted before.
 */

export interface FetchedRelease {
  /** `manifest.json` as the server served it (raw text: the signature covers the bytes). */
  manifestText: string;
  /** `manifest.json.minisig`, or null when the server has none (an unsigned build). */
  minisig: string | null;
  /** The exact origin it came from. */
  origin: string;
}

export type UpdateVerdict =
  | { ok: true; manifest: RunnerReleaseManifest; signed: boolean; keyId: string | null }
  | { ok: false; reason: string };

export function verifyUpdate(i: {
  fetched: FetchedRelease;
  /** The version of this process. */
  current: string;
  /** Safe mode: the platform team pinned this version (it may be older than the current one, never below the floor). */
  pin: string | null;
  trustedKey: string;
  policy: Pick<Policy, 'allowUnsignedUpdatesFrom' | 'legacyUpdateOrigin'>;
}): UpdateVerdict {
  const { fetched, policy } = i;
  let signed = false;
  let keyId: string | null = null;
  if (fetched.minisig) {
    const v = verifyMinisign(fetched.manifestText, fetched.minisig, i.trustedKey);
    // a signature that does not verify is a tampered or foreign release: refused, whatever the origin
    if (!v.ok) return { ok: false, reason: `the release signature does not verify: ${v.reason}` };
    signed = true;
    keyId = v.keyId;
  } else {
    const allowed =
      policy.allowUnsignedUpdatesFrom.includes(fetched.origin) ||
      (!!policy.legacyUpdateOrigin && policy.legacyUpdateOrigin === fetched.origin);
    if (!allowed)
      return {
        ok: false,
        reason: `the release from ${fetched.origin} is not signed, and this origin is not allowed to serve unsigned updates on this machine`,
      };
  }
  let manifest: RunnerReleaseManifest;
  try {
    manifest = RunnerReleaseManifestSchema.parse(JSON.parse(fetched.manifestText));
  } catch (err) {
    return {
      ok: false,
      reason: `the release manifest is not valid (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (manifest.file !== `aom-runner-${manifest.version}.tgz`)
    return { ok: false, reason: `the manifest names ${manifest.file} for version ${manifest.version}` };
  if (!atOrAboveFloor(manifest.version)) return { ok: false, reason: belowFloor(manifest.version, 'runner') };
  // the manifest's own floor may raise ours, never lower it
  if (!atOrAboveFloor(manifest.version, atOrAboveFloor(manifest.floor) ? manifest.floor : MIN_TRUSTED_RUNNER))
    return {
      ok: false,
      reason: `runner ${manifest.version} is below the floor ${manifest.floor} its manifest names`,
    };
  try {
    compareVersions(manifest.version, i.current);
  } catch {
    return { ok: false, reason: `not a version: ${manifest.version}` };
  }
  // An older or equal release is never installed by the normal cycle (it installs only a newer one); only a safe-mode pin,
  // at or above the floor, may name an older version.
  if (i.pin && i.pin !== manifest.version)
    return { ok: false, reason: `the server offered ${manifest.version}, not the pinned ${i.pin}` };
  return { ok: true, manifest, signed, keyId };
}

/** A safe-mode pin (`runner.pin`, `welcome.runnerPin`) below the floor is refused, even while updates are paused. */
export function acceptablePin(version: string | null): { ok: true } | { ok: false; reason: string } {
  if (version === null) return { ok: true };
  return atOrAboveFloor(version) ? { ok: true } : { ok: false, reason: belowFloor(version, 'the pin') };
}
