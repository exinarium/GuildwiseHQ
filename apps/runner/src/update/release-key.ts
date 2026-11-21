import {
  isPlaceholderReleaseKey,
  OFFICIAL_RUNNER_RELEASE_KEY_ID,
  OFFICIAL_RUNNER_RELEASE_PUBKEY,
  parseMinisignPublicKey,
} from '@aom/shared';

/**
 * The runner's trust anchor for releases (R18-U). The key itself is generated into packages/shared/src/security/
 * release-key.ts by `scripts/set-runner-release-key.sh` (one source for the runner and the server's proof check); until
 * the owner commits his public key it is the `PLACEHOLDER`, and nothing may be accepted as signed by it.
 *
 * Own-key and per-target builds (R27, R30): `scripts/package-runner.sh --pubkey <file.pub>` bundles the runner with
 * `AOM_RUNNER_BUILD_PUBKEY` set, and tsup compiles that key in place of the official one (`__AOM_RUNNER_RELEASE_PUBKEY__`),
 * so a UAT runner trusts only the UAT key. It is a build-time constant: nothing at run time can change it.
 */
declare const __AOM_RUNNER_RELEASE_PUBKEY__: string | undefined;

const built = typeof __AOM_RUNNER_RELEASE_PUBKEY__ === 'string' ? __AOM_RUNNER_RELEASE_PUBKEY__.trim() : '';
const builtKey = built ? parseMinisignPublicKey(built) : null;

export const RELEASE_PUBKEY: string = builtKey ? built : OFFICIAL_RUNNER_RELEASE_PUBKEY;
export const RELEASE_KEY_ID: string | null = builtKey ? builtKey.keyId : OFFICIAL_RUNNER_RELEASE_KEY_ID;
/** Where the trusted key came from: the official (generated) key, or a key compiled in by `package-runner.sh --pubkey`. */
export const RELEASE_KEY_SOURCE: 'official' | 'build' = builtKey ? 'build' : 'official';
export const releaseKeyIsPlaceholder = (): boolean => isPlaceholderReleaseKey(RELEASE_PUBKEY);
