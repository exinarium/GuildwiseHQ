import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type ComponentBump,
  componentBumps,
  hasReleaseSection,
  newChangelog,
  releaseChangelog,
  releaseSectionOf,
  splitUnreleased,
} from '../src/index.ts';

const rule = {
  name: 'runner',
  paths: ['apps/runner/**'],
  versionFile: 'apps/runner/src/version.ts',
  pattern: "RUNNER_VERSION = '(.*)'",
};
const file = (v: string) => `export const RUNNER_VERSION = '${v}';\n`;
const bumpsFor = (changed: number, head: string, tag: string): ComponentBump[] =>
  componentBumps(
    [rule],
    [{ name: 'runner', changedCount: changed, contentAtHead: file(head), contentAtTag: file(tag) }],
  );

const MD = `# Changelog

Intro text.

## [Unreleased]

### Added

- One.
- Two.

### Fixed

- Three.

## [1.3.0] - 2026-10-29

Runner 0.1.62 (unchanged). Old intro.

### Added

- Old.
`;

describe('releaseChangelog', () => {
  it('moves Unreleased under the version, keeps an empty Unreleased, bumps the intro', () => {
    const out = releaseChangelog(MD, {
      version: '1.4.0',
      date: '2026-11-01',
      bumps: bumpsFor(5, '0.1.62', '0.1.62'),
    });
    expect(out.kind).toBe('rewritten');
    if (out.kind !== 'rewritten') return;
    expect(out.md).toContain(
      '## [Unreleased]\n\n## [1.4.0] - 2026-11-01\n\nRunner 0.1.63.\n\n### Added\n\n- One.\n- Two.\n\n### Fixed\n\n- Three.\n\n## [1.3.0] - 2026-10-29',
    );
    // everything outside the Unreleased block is untouched
    expect(out.md.startsWith('# Changelog\n\nIntro text.\n\n## [Unreleased]')).toBe(true);
    expect(out.md.endsWith('- Old.\n')).toBe(true);
    expect(out.section.startsWith('## [1.4.0] - 2026-11-01')).toBe(true);
  });

  it('writes "(unchanged)" when no files changed', () => {
    const out = releaseChangelog(MD, {
      version: '1.4.0',
      date: '2026-11-01',
      bumps: bumpsFor(0, '0.1.62', '0.1.62'),
    });
    expect(out.kind === 'rewritten' && out.section).toContain('Runner 0.1.62 (unchanged).');
  });

  it('keeps a hand-written intro, says the version once when raised by hand', () => {
    const md = MD.replace('## [Unreleased]\n', '## [Unreleased]\n\nRunner 0.1.63. Some words.\n');
    const out = releaseChangelog(md, {
      version: '1.4.0',
      date: '2026-11-01',
      bumps: bumpsFor(3, '0.1.63', '0.1.62'),
    });
    expect(out.kind === 'rewritten' && out.section).toContain('\n\nRunner 0.1.63. Some words.\n\n### Added');
    expect(out.kind === 'rewritten' && out.section.match(/Runner 0\.1\.63/g)).toHaveLength(1);
  });

  it('works without component rules and without an intro', () => {
    const out = releaseChangelog(MD, { version: '2.0.0', date: '2026-11-01', bumps: [] });
    expect(out.kind === 'rewritten' && out.section).toBe(
      '## [2.0.0] - 2026-11-01\n\n### Added\n\n- One.\n- Two.\n\n### Fixed\n\n- Three.',
    );
  });

  it('keeps CRLF line endings', () => {
    const out = releaseChangelog(MD.replace(/\n/g, '\r\n'), {
      version: '1.4.0',
      date: '2026-11-01',
      bumps: [],
    });
    expect(out.kind).toBe('rewritten');
    if (out.kind !== 'rewritten') return;
    expect(out.md.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out.md).toContain('## [1.4.0] - 2026-11-01\r\n');
  });

  it('keeps unknown ### headings (Deprecated, Removed)', () => {
    const md = '# C\n\n## [Unreleased]\n\n### Deprecated\n\n- Old API.\n\n### Removed\n\n- Gone.\n';
    const out = releaseChangelog(md, { version: '1.0.1', date: '2026-11-01', bumps: [] });
    expect(out.kind === 'rewritten' && out.md).toBe(
      '# C\n\n## [Unreleased]\n\n## [1.0.1] - 2026-11-01\n\n### Deprecated\n\n- Old API.\n\n### Removed\n\n- Gone.\n',
    );
  });

  it('reports a version section that exists, and a file without Unreleased', () => {
    const again = releaseChangelog(MD, { version: '1.3.0', date: '2026-11-01', bumps: [] });
    expect(again.kind).toBe('already');
    expect(hasReleaseSection(MD, '1.3.0')).toBe(true);
    expect(hasReleaseSection(MD, '1.3')).toBe(false);
    expect(releaseSectionOf(MD, '1.3.0')).toContain('Old intro.');
    const none = releaseChangelog('# C\n\n## [1.0.0] - 2026-01-01\n', {
      version: '1.0.1',
      date: 'x',
      bumps: [],
    });
    expect(none).toEqual({ kind: 'error', message: 'CHANGELOG.md has no ## [Unreleased] section' });
  });

  it('stops the block at a link reference and leaves the references alone', () => {
    const md = '## [Unreleased]\n\n### Added\n\n- A.\n\n[Unreleased]: https://x/compare/v1.0.0...HEAD\n';
    const out = releaseChangelog(md, { version: '1.1.0', date: '2026-11-01', bumps: [] });
    expect(out.kind === 'rewritten' && out.md).toBe(
      '## [Unreleased]\n\n## [1.1.0] - 2026-11-01\n\n### Added\n\n- A.\n\n[Unreleased]: https://x/compare/v1.0.0...HEAD\n',
    );
  });

  it('splits the real CHANGELOG.md head and releases it with the runner already set', () => {
    const real = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
    const split = splitUnreleased(real);
    expect(split).not.toBeNull();
    expect(split?.intro.startsWith('Runner 0.1.')).toBe(true);
    const out = releaseChangelog(real, {
      version: '99.0.0',
      date: '2026-11-01',
      bumps: bumpsFor(4, '0.1.63', '0.1.62'),
    });
    expect(out.kind === 'rewritten' && out.section.split('\n\n')[1]).toMatch(/^Runner 0\.1\.63\.( |$)/);
    expect(out.kind === 'rewritten' && out.section.split('\n\n')[1]?.match(/Runner 0\.1\.63/g)).toHaveLength(
      1,
    );
  });
});

describe('newChangelog', () => {
  it('writes a Keep a Changelog file from the notes', () => {
    const { md, section } = newChangelog('Acme', {
      version: '0.1.0',
      date: '2026-11-01',
      bumps: [],
      notes: '- First thing.\n- Second thing.',
    });
    expect(md).toBe(
      '# Changelog\n\nAll notable changes to Acme are documented in this file.\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-01\n\n### Changed\n\n- First thing.\n- Second thing.\n',
    );
    expect(section.startsWith('## [0.1.0] - 2026-11-01')).toBe(true);
  });
});
