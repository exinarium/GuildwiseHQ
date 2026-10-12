import { describe, expect, it } from 'vitest';
import { decideProbation, PROBATION_SEC } from '../src/update/rollback.ts';

const pending = { from: '0.1.0', to: '0.1.1', deadline: 1_000_000 };
const base = { pending, running: '0.1.1', connected: false, nowSec: 1_000_000 - 10, serverReachable: true };

describe('rollback decision', () => {
  it('does nothing without a pending update', () => {
    expect(decideProbation({ ...base, pending: null })).toEqual({ action: 'none' });
  });

  it('confirms the update once the new version has connected', () => {
    expect(decideProbation({ ...base, connected: true })).toEqual({ action: 'confirm' });
    // even if the window has passed: a connection is a connection
    expect(decideProbation({ ...base, connected: true, nowSec: pending.deadline + 999 })).toEqual({
      action: 'confirm',
    });
  });

  it('waits inside the probation window', () => {
    expect(decideProbation(base)).toEqual({
      action: 'wait',
      reason: 'probation',
      untilSec: pending.deadline,
    });
  });

  it('rolls back after the window when the server is reachable and nothing connected', () => {
    expect(decideProbation({ ...base, nowSec: pending.deadline + 1 })).toEqual({ action: 'rollback' });
    expect(decideProbation({ ...base, nowSec: pending.deadline })).toEqual({ action: 'rollback' });
  });

  it('does not blame the update for a server outage', () => {
    const d = decideProbation({ ...base, nowSec: pending.deadline + 5, serverReachable: false });
    expect(d).toEqual({
      action: 'wait',
      reason: 'server_unreachable',
      untilSec: pending.deadline + 5 + PROBATION_SEC,
    });
  });

  it('drops a marker that is about another version (the launcher already rolled back, or it is left over)', () => {
    expect(decideProbation({ ...base, running: '0.1.0' })).toEqual({ action: 'stale' });
    expect(decideProbation({ ...base, running: '0.2.0' })).toEqual({ action: 'stale' });
  });
});
