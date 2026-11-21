/**
 * Pinned versions for the user-space stack installs (`user-install.ts`). The checksum of each download comes from the
 * vendor at install time (a `.sha256`/`.sha512` beside the file, or a SHASUMS file), except where the vendor publishes
 * none: then the sha256 is pinned here, read at pin time.
 *
 * Re-pin by reading the vendor's release page; never copy a checksum from a mirror.
 */

/** github.com/astral-sh/uv/releases (read 2026-11-21). */
export const UV_VERSION = '0.13.9';

/** github.com/oven-sh/bun/releases (read 2026-11-21). */
export const BUN_VERSION = '1.4.5';

/** maven.apache.org/download.cgi (read 2026-11-21). */
export const MAVEN_VERSION = '3.10.1';

/** gradle.org/releases (read 2026-11-21). */
export const GRADLE_VERSION = '9.9.2';

/**
 * Android command-line tools: Google publishes the sha256 only on developer.android.com/studio ("Command line tools
 * only"), so build and checksums are pinned (read 2026-11-21). sdkmanager verifies every later package itself.
 */
export const ANDROID_CMDLINE_TOOLS = {
  build: '15859902',
  files: {
    linux: {
      file: 'commandlinetools-linux-15859902_latest.zip',
      sha256: '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583',
    },
    'darwin-x64': {
      file: 'commandlinetools-mac_x86_64-15859902_latest.zip',
      sha256: 'c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3',
    },
    'darwin-arm64': {
      file: 'commandlinetools-mac_arm64-15859902_latest.zip',
      sha256: '835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e',
    },
  },
} as const;
