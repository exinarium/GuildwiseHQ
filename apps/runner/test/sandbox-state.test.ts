import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { sandboxDoctorLines, sandboxState } from '../src/adapters/claude-policy.ts';
import { applyOverrides, RunnerConfigSchema } from '../src/config.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

function binDir(...names: string[]): string {
  const d = tmp();
  mkdirSync(d, { recursive: true });
  for (const n of names) writeFileSync(join(d, n), '');
  return d;
}
const WITH = binDir('bwrap', 'socat');
const WITHOUT = binDir();

describe('sandboxState (platform x config)', () => {
  it('required: enforced where the sandbox works, unavailable where it does not', () => {
    expect(sandboxState({ sandbox: 'required' }, 'darwin').state).toBe('enforced');
    expect(sandboxState({ sandbox: 'required' }, 'linux', WITH).state).toBe('enforced');
    const noBwrap = sandboxState({ sandbox: 'required' }, 'linux', WITHOUT);
    expect(noBwrap.state).toBe('unavailable');
    expect(noBwrap.reason).toContain('bwrap and socat not installed');
    const win = sandboxState({ sandbox: 'required' }, 'win32');
    expect(win.state).toBe('unavailable');
    expect(win.reason).toContain('Native Windows: install the runner in WSL2');
  });

  it('allowUnsandboxed does not matter for required', () => {
    expect(sandboxState({ sandbox: 'required', allowUnsandboxed: true }, 'win32').state).toBe('unavailable');
  });

  it('best_effort: enforced when possible; unsandboxed only with the acknowledgement', () => {
    expect(sandboxState({ sandbox: 'best_effort' }, 'linux', WITH).state).toBe('enforced');
    expect(sandboxState({ sandbox: 'best_effort', allowUnsandboxed: true }, 'darwin').state).toBe('enforced');
    const refused = sandboxState({ sandbox: 'best_effort' }, 'win32');
    expect(refused.state).toBe('unavailable');
    expect(refused.reason).toContain('WSL2');
    expect(refused.reason).toContain('allowUnsandboxed');
    const noBwrap = sandboxState({ sandbox: 'best_effort' }, 'linux', WITHOUT);
    expect(noBwrap.state).toBe('unavailable');
    const optedIn = sandboxState({ sandbox: 'best_effort', allowUnsandboxed: true }, 'win32');
    expect(optedIn.state).toBe('unsandboxed');
    expect(optedIn.reason).toContain('allowUnsandboxed');
    expect(sandboxState({ sandbox: 'best_effort', allowUnsandboxed: true }, 'linux', WITHOUT).state).toBe(
      'unsandboxed',
    );
  });

  it('off: unsandboxed on every platform', () => {
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      const s = sandboxState({ sandbox: 'off' }, p, WITH);
      expect(s.state).toBe('unsandboxed');
      expect(s.reason).toContain('off');
    }
  });

  it('the config flag defaults to false', () => {
    expect(RunnerConfigSchema.shape.runtimes.parse({})['claude-code'].allowUnsandboxed).toBe(false);
  });
});

describe('ClaudeCodeAdapter.sandboxStatus and start', () => {
  const cfg = (o: object) => RunnerConfigSchema.shape.runtimes.parse({ 'claude-code': o })['claude-code'];

  it('uses the injected platform', () => {
    const a = new ClaudeCodeAdapter(cfg({}), undefined, { platform: 'win32' });
    expect(a.sandboxStatus().state).toBe('unavailable');
    const b = new ClaudeCodeAdapter(cfg({ sandbox: 'best_effort', allowUnsandboxed: true }), undefined, {
      platform: 'win32',
    });
    expect(b.sandboxStatus().state).toBe('unsandboxed');
  });
});

describe('doctor lines', () => {
  it('native Windows gets the WSL2 recommendation with the exact steps', () => {
    const lines = sandboxDoctorLines(sandboxState({ sandbox: 'required' }, 'win32'), 'win32');
    const text = lines.map((l) => l.detail).join('\n');
    expect(lines[0]).toMatchObject({ ok: false, name: 'sandbox' });
    expect(text).toContain('wsl --install -d Ubuntu');
    expect(text).toContain('bubblewrap socat');
    expect(text).toContain('systemd user service');
    expect(text).toContain('allowUnsandboxed');
  });

  it('Linux and macOS get just the state line', () => {
    expect(sandboxDoctorLines(sandboxState({ sandbox: 'required' }, 'darwin'), 'darwin')).toEqual([
      { ok: true, name: 'sandbox', detail: 'enforced (macOS Seatbelt)' },
    ]);
    const unsandboxed = sandboxDoctorLines(sandboxState({ sandbox: 'off' }, 'linux'), 'linux');
    expect(unsandboxed).toHaveLength(1);
    expect(unsandboxed[0]?.ok).toBe('warn');
  });
});

describe('mock runtime override', () => {
  it('AOM_RUNNER_MOCK_SANDBOX makes the mock runtime report the state', () => {
    const c = RunnerConfigSchema.parse({ serverUrl: 'http://x', workstationId: 'w', runnerToken: 't' });
    process.env.AOM_RUNNER_MOCK_SANDBOX = 'unsandboxed';
    try {
      expect(applyOverrides(c, { mock: true }).runtimes.mock).toMatchObject({
        enabled: true,
        sandbox: 'unsandboxed',
        sandboxReason: 'test override: AOM_RUNNER_MOCK_SANDBOX=unsandboxed',
      });
      expect(applyOverrides(c, { mock: true }).runtimes.mock?.sandboxReason).not.toMatch(/windows/i);
    } finally {
      delete process.env.AOM_RUNNER_MOCK_SANDBOX;
    }
    expect(applyOverrides(c, { mock: true }).runtimes.mock?.sandbox).toBeUndefined();
  });
});
