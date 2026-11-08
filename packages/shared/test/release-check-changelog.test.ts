import { describe, expect, it } from 'vitest';
import { checkChangelog } from '../src/release/changelog-rewrite.ts';

const head = '# Changelog\n\nAll notable changes.\n\n## [Unreleased]\n\n';
const undated = `${head}## [1.2.0]\n\n### Added\n- A\n\n## [1.1.0]\n\n### Added\n- B\n`;
const dated = `${head}## [1.2.0] - 2026-01-02\n\n### Added\n- A\n\n## [1.1.0] - 2026-01-01\n\n### Added\n- B\n`;
const mixed = `${head}## [1.2.0] - 2026-01-02\n\n### Added\n- A\n\n## [1.1.0]\n\n### Added\n- B\n`;
const undatedAbove = `${head}## [1.2.0]\n\n### Added\n- A\n\n## [1.1.0] - 2026-01-01\n\n### Added\n- B\n`;
const cloud = `# Changelog\n\nAll notable changes to this project.\n\n## [Unreleased]\n\n## [0.2.3] - 2026-11-05\n\n### Fixed\n- X\n\n## [0.1.0] - 2026-11-03\n\n### Added\n- Y\n`;

describe('checkChangelog undated versions', () => {
  it('accepts all undated', () => expect(checkChangelog(undated).errors).toEqual([]));
  it('accepts all dated', () => expect(checkChangelog(dated).errors).toEqual([]));
  it('accepts dated on top and undated below', () => expect(checkChangelog(mixed).errors).toEqual([]));
  it('accepts a guildwise-cloud shaped file', () => expect(checkChangelog(cloud).errors).toEqual([]));
  it('accepts only Unreleased', () => expect(checkChangelog(`${head}`).errors).toEqual([]));
  it('keeps the error for an undated heading above a dated one', () => {
    const r = checkChangelog(undatedAbove);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('without a date');
  });
  it('rejects the version being shipped when its heading is undated', () => {
    expect(checkChangelog(undated).errors).toEqual([]);
    const r = checkChangelog(undated, { version: '1.2.0' });
    expect(r.errors.some((e) => e.includes('[1.2.0] section without a date'))).toBe(true);
    expect(checkChangelog(undated, { version: '1.3.0' }).errors).toEqual([]);
  });
  it('rejects a file without changelog structure with the same reason', () => {
    expect(checkChangelog('just some text').errors).toEqual(['CHANGELOG.md has no ## [Unreleased] section.']);
  });
});
