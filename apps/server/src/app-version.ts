import { loadReleases } from './blog/releases.ts';

/**
 * This build's application version: the newest dated release in the bundled CHANGELOG.md (null without one). The app,
 * the video worker and the artifact push all read it, so a worker and a server compare the same kind of value. Every
 * package.json says 0.0.0, so never read the version from there.
 */
export const appVersion = (): string | null => loadReleases()[0]?.version ?? null;
