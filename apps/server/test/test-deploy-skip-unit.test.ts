import { IntegrationTestsSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { testDeploySkipReason } from '../src/commands/integration-tests.ts';

// A suite card tests a target and needs no environment. A bug card spawned by a suite keeps the suite origin for
// lineage, but it is an ordinary card: it tests its own commit in a per-card environment.

const local = IntegrationTestsSchema.parse({ mode: 'local' });
const project = { test_without_environment: false };

describe('testDeploySkipReason', () => {
  it('skips a suite card', () => {
    for (const origin of ['full_suite', 'regression']) {
      expect(testDeploySkipReason({ card_type: 'regression', origin, fields: {} }, project, local)).toMatch(
        /suite card/,
      );
    }
  });
  it('does not skip a bug card spawned by a suite (local mode)', () => {
    for (const origin of ['full_suite', 'regression']) {
      expect(testDeploySkipReason({ card_type: 'bug', origin, fields: {} }, project, local)).toBeNull();
    }
  });
});
