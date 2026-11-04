import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declaredServices, requireBindable, requireDeclared } from './test-services.ts';

const shift = { AOM_TEST_SERVICES: '127.0.0.1:5433,[::1]:6379,127.0.0.1:4710' };

test('parses the declaration', () => {
  assert.deepEqual([...declaredServices(shift).connect].sort(), [4710, 5433, 6379]);
  assert.equal(declaredServices(shift).inShift, true);
  assert.equal(declaredServices({ AOM_AGENT_TMP_ROOT: '/x' }).inShift, true);
  assert.equal(declaredServices({}).inShift, false);
});

test('requireDeclared: a missing port throws in a shift and is allowed outside', () => {
  requireDeclared(4710, 'hosted build', shift);
  assert.throws(() => requireDeclared(8025, 'mailpit', shift), /not declared.*Local test services/);
  requireDeclared(8025, 'mailpit', {});
});

test('requireBindable: a declared port is refused in a shift, an undeclared one allowed', () => {
  assert.throws(() => requireBindable(4710, 'TLS proxy', shift), /declared as a local test service/);
  requireBindable(4711, 'TLS proxy', shift);
  requireBindable(4710, 'TLS proxy', {});
});
