import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.ts';
import { addPairing, entryDir, loadIndex } from '../src/pairings.ts';
import { DEVOPS_MARKER } from '../src/sandbox/sandbox.ts';
import { clearUnpairedState } from '../src/unpaired.ts';
import { cleanupTmp, makeConfig, tmp } from './helpers.ts';

cleanupTmp();

function seed(dir: string) {
  mkdirSync(join(dir, 'active-shifts'), { recursive: true });
  writeFileSync(join(dir, 'active-shifts', 's1.json'), '{}');
  mkdirSync(join(dir, 'outbox'), { recursive: true });
  writeFileSync(join(dir, 'outbox', '1.json'), '{}');
  mkdirSync(join(dir, 'agents', 'devops-1'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'devops-1', DEVOPS_MARKER), '');
  mkdirSync(join(dir, 'agents', 'builder-1'), { recursive: true });
}

describe('clearUnpairedState', () => {
  it('removes active shifts, the outbox and marked DevOps agent dirs, and keeps other agents', () => {
    const dir = tmp();
    seed(dir);
    clearUnpairedState(dir);
    expect(existsSync(join(dir, 'active-shifts'))).toBe(false);
    expect(existsSync(join(dir, 'outbox'))).toBe(false);
    expect(existsSync(join(dir, 'agents', 'devops-1'))).toBe(false);
    expect(existsSync(join(dir, 'agents', 'builder-1'))).toBe(true);
  });

  it('is safe on an empty directory', () => {
    expect(() => clearUnpairedState(tmp())).not.toThrow();
  });

  it('re-pairing the same machine to a new workstation clears the old state', () => {
    const root = tmp();
    saveConfig(join(root, 'config.json'), makeConfig('http://aom.example.com/'));
    const first = loadIndex(root).pairings[0];
    seed(entryDir(root, first));
    addPairing(root, {
      serverUrl: 'http://aom.example.com/',
      label: first.label,
      workstationId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
      runnerToken: 'aomr_new',
    } as never);
    const dir = entryDir(root, loadIndex(root).pairings[0]);
    expect(existsSync(join(dir, 'active-shifts'))).toBe(false);
    expect(existsSync(join(dir, 'agents', 'devops-1'))).toBe(false);
    expect(existsSync(join(dir, 'agents', 'builder-1'))).toBe(true);
  });
});
