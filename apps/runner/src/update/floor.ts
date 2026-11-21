import { compareVersions } from './semver.ts';

/**
 * The version floor (R18-U [rv4-1]). Compiled in, never taken from the server or a file: no update, `runner.pin`,
 * `welcome.runnerPin` or rollback goes below it, even while updates are paused, and local copies below it are deleted after
 * a good start. It is the runner version of the 1.10.0 release (the first signed runner) and is raised by hand, never by
 * the release flow: a floor that followed `RUNNER_VERSION` would make every rollback impossible. The server's
 * `MIN_PAIRABLE_RUNNER` (apps/server/src/installer/release.ts) equals it.
 */
export const MIN_TRUSTED_RUNNER = '1.10.0';

/** True when `version` is a valid version at or above the floor. Anything unparseable is below it. */
export function atOrAboveFloor(version: string, floor: string = MIN_TRUSTED_RUNNER): boolean {
  try {
    return compareVersions(version, floor) >= 0;
  } catch {
    return false;
  }
}

/** The refusal text for a version below the floor. */
export const belowFloor = (version: string, what: string): string =>
  `${what} ${version} is below this runner's floor ${MIN_TRUSTED_RUNNER}: refused (a runner never goes back below the 1.10.0 runner)`;
