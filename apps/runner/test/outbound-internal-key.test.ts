import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutboundPostPayload } from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Exec, ExternalAdapters } from '../src/external/index.ts';
import { OutboundExecutor } from '../src/external/outbound.ts';

const payload = (over: Partial<OutboundPostPayload> = {}): OutboundPostPayload => ({
  draftId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
  cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c2',
  cardRef: 'GWP-123',
  ref: { system: 'github', key: 'acme/toy#3' },
  kind: 'comment',
  body: 'The export now includes archived items.',
  agentNames: [],
  ...over,
});

function fakeGh() {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: 'https://github.com/acme/toy/issues/3#issuecomment-1', stderr: '' };
  };
  return { calls, exec };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aom-outbound-key-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the outbound executor refuses the internal card key', () => {
  it('a body that names the card ref is refused before posting and nothing is posted', async () => {
    const f = fakeGh();
    const ex = new OutboundExecutor({ dir, adapters: ExternalAdapters.defaults({ exec: f.exec }) });
    const r = await ex.run(payload({ body: 'Fixed in GWP-123: the export works.' }));
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/refused before posting.*GWP-123.*name the ticket acme\/toy#3 instead/);
    expect(f.calls).toHaveLength(0);
  });
  it('a body that names the ticket is posted', async () => {
    const f = fakeGh();
    const ex = new OutboundExecutor({ dir, adapters: ExternalAdapters.defaults({ exec: f.exec }) });
    const r = await ex.run(payload({ body: 'Fixed for acme/toy#3: the export works.' }));
    expect(r).toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(1);
  });
});
