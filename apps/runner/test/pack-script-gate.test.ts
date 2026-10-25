import { indexCapabilityTree } from '@aom/shared';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry, makePackScriptGate, skillRpc } from '../src/capabilities/registry.ts';

/** An approved pack with a skill that ships a script (the pack's owner enabled scripts, so the file is in the entry). */
function registry(): CapabilityRegistry {
  const parsed = indexCapabilityTree({
    'skills/lint/SKILL.md': '---\nname: lint\ndescription: Lint things\n---\n\nRun the script.\n',
    'skills/lint/scripts/run.sh': '#!/bin/sh\necho lint\n',
    'skills/lint/references/notes.md': 'Notes.\n',
  }).entries.map((e) => ({ ...e, key: `pk:${e.key}`, pack: { name: 'pk', sha: 'abc123' } }));
  const reg = new CapabilityRegistry();
  reg.setPacks({ entries: () => parsed, scriptsEnabled: () => true } as never);
  return reg;
}

describe('the pack-scripts gate in the runner', () => {
  it('hands out a script only when the server allows it, and asks once per script file', async () => {
    const reg = registry();
    const rpc = vi.fn(async () => ({ ok: true }));
    const gate = makePackScriptGate(rpc, 'shift-1');
    const r = await skillRpc(
      reg,
      'skill.show',
      { ref: 'skill:pk:lint', file: 'scripts/run.sh' },
      undefined,
      undefined,
      undefined,
      gate,
    );
    expect(r.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('shift-1', 'pack.script.gate', {
      pack: 'pk',
      capability: 'skill:pk:lint',
      file: 'scripts/run.sh',
    });
  });

  it("refuses the script with the server's message when it is not approved", async () => {
    const reg = registry();
    const gate = makePackScriptGate(
      async () => ({ ok: false, error: 'approval_required: ask the manager' }),
      'shift-1',
    );
    const r = await skillRpc(
      reg,
      'skill.show',
      { ref: 'skill:pk:lint', file: 'scripts/run.sh' },
      undefined,
      undefined,
      undefined,
      gate,
    );
    expect(r).toEqual({ ok: false, error: 'approval_required: ask the manager' });
  });

  it('fails closed when the server cannot be asked', async () => {
    const reg = registry();
    const gate = makePackScriptGate(async () => Promise.reject(new Error('offline')), 'shift-1');
    const r = await skillRpc(
      reg,
      'skill.show',
      { ref: 'skill:pk:lint', file: 'scripts/run.sh' },
      undefined,
      undefined,
      undefined,
      gate,
    );
    expect(r.ok).toBe(false);
  });

  it('does not ask for text files or for the main file, and not at all without the gate', async () => {
    const reg = registry();
    const rpc = vi.fn(async () => ({ ok: true }));
    const gate = makePackScriptGate(rpc, 'shift-1');
    expect(
      (
        await skillRpc(
          reg,
          'skill.show',
          { ref: 'skill:pk:lint', file: 'references/notes.md' },
          undefined,
          undefined,
          undefined,
          gate,
        )
      ).ok,
    ).toBe(true);
    expect(
      (await skillRpc(reg, 'skill.show', { ref: 'skill:pk:lint' }, undefined, undefined, undefined, gate)).ok,
    ).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    expect((await skillRpc(reg, 'skill.show', { ref: 'skill:pk:lint', file: 'scripts/run.sh' })).ok).toBe(
      true,
    );
  });

  it('leaves scripts out of the folder it materialises for a gated agent', () => {
    const reg = registry();
    const open = reg.grantedSkills(['skill:pk:lint']);
    expect(Object.keys(open[0]?.files ?? {})).toContain('scripts/run.sh');
    const gated = reg.grantedSkills(['skill:pk:lint'], undefined, undefined, undefined, {
      packScriptsGated: true,
    });
    expect(Object.keys(gated[0]?.files ?? {})).not.toContain('scripts/run.sh');
    expect(Object.keys(gated[0]?.files ?? {})).toContain('references/notes.md');
  });
});
