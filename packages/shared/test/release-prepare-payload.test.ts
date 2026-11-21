import { describe, expect, it } from 'vitest';
import { CommandPayloadSchemas, ReleasePreparePayloadSchema } from '../src/index.ts';

/** `release.prepare` (R30, W14): the repo's normalised remote URL is optional and additive, so older payloads still parse. */
const base = {
  releaseId: '0192f3a0-0000-7000-8000-000000000001',
  targetId: '0192f3a0-0000-7000-8000-000000000002',
  targetName: 'uat',
  projectName: 'Guildwise',
  version: '1.10.0',
  repoId: '0192f3a0-0000-7000-8000-000000000003',
  commit: 'abc1234def5678abc1234def5678abc1234def56',
  keyId: '515674AC008F1CF3',
  publicKey: `RW${'A'.repeat(54)}`,
  artefact: 'release/uat/manifest.json',
};

describe('release.prepare payload', () => {
  it('carries the normalised remote URL when given, and is the registered schema of the command', () => {
    const p = ReleasePreparePayloadSchema.parse({
      ...base,
      remoteUrlNormalized: 'github.com/acme/guildwise',
    });
    expect(p.remoteUrlNormalized).toBe('github.com/acme/guildwise');
    expect(CommandPayloadSchemas['release.prepare']).toBe(ReleasePreparePayloadSchema);
  });

  it('still parses without it (additive), and refuses an over-long one', () => {
    expect(ReleasePreparePayloadSchema.parse(base).remoteUrlNormalized).toBeUndefined();
    expect(
      ReleasePreparePayloadSchema.safeParse({ ...base, remoteUrlNormalized: 'x'.repeat(501) }).success,
    ).toBe(false);
  });
});
