import { readFileSync } from 'node:fs';
import { splitUnreleased } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { parseUnreleased } from '../src/blog/releases.ts';

const real = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');

const CASES: Record<string, string> = {
  real,
  'no intro': '## [Unreleased]\n\n### Added\n\n- A.\n\n## [1.0.0] - 2026-01-01\n',
  'intro over two lines': '## [Unreleased]\n\nRunner 0.1.63.\nMore words.\n\n### Fixed\n\n- A.\n',
  'unknown headings':
    '## [Unreleased]\n\nIntro.\n\n### Deprecated\n\n- X.\n\n### Removed\n\n- Y.\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- Z.\n',
  'empty block': '## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n',
  crlf: '## [Unreleased]\r\n\r\nIntro.\r\n\r\n### Added\r\n\r\n- A.\r\n\r\n## [1.0.0] - 2026-01-01\r\n',
  'case of the heading': '## [unreleased]\n\n### Added\n\n- A.\n',
};

describe('the release rewrite reads Unreleased like the /releases scanner', () => {
  for (const [name, md] of Object.entries(CASES))
    it(name, () => {
      const server = parseUnreleased(md);
      const shared = splitUnreleased(md);
      expect(shared?.intro).toBe(server?.intro);
      expect(shared?.body).toBe(server?.body);
    });
});
