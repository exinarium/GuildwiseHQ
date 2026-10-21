import { describe, expect, it } from 'vitest';
import { DeliveryService } from '../src/delivery/service.ts';

// A scan may look at its project's own servers only: never at an alias that merely exists in ~/.ssh/config. The refusals below
// happen before anything is run, so no ssh is started.
const svc = new DeliveryService({
  vaults: {} as never,
  rpc: async () => ({ ok: true }),
});
const targets = [
  { name: 'Live site', host: 'prod-server' },
  { name: 'Test copy', host: null },
];

describe('aom deploy probe in a scan', () => {
  it('refuses an arbitrary --host', async () => {
    const r = await svc.probeFor({ host: 'some-other-server' }, undefined, targets);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('not the server of one of this project');
  });
  it('refuses a target that is not in the project, and one that is not a server', async () => {
    expect(await svc.probeFor({ target: 'Nope' }, undefined, targets)).toMatchObject({ ok: false });
    const r = await svc.probeFor({ target: 'Test copy' }, undefined, targets);
    expect((r as { error: string }).error).toContain('not on a server');
  });
  it('refuses any host when the shift has no targets', async () => {
    expect(await svc.probeFor({ host: 'prod-server' }, undefined, [])).toMatchObject({ ok: false });
  });
});
