import { HelloSchema, MAX_HELLO_CAPABILITIES } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

type RunnerInternals = {
  buildHello(): Promise<Record<string, unknown>>;
  opts: { config: { ceo?: { fullPower: boolean }; runtimes: { mock?: { enabled?: boolean } } } };
};

describe('hello the server accepts', () => {
  it('the hello on the wire passes the server schema and announces app integrations', async () => {
    h = await startHarness();
    expect(h.server.invalid).toEqual([]);
    const [hello] = h.server.of('hello');
    expect(hello?.capabilities).toContain('app-integrations:1');
  });

  it('the longest capability list the runner can announce still passes the server schema', async () => {
    h = await startHarness();
    const runner = h.runner as unknown as RunnerInternals;
    // Every switch that adds capabilities: a real (non-mock) runtime and the CEO full-power opt-in.
    runner.opts.config.runtimes.mock = undefined;
    runner.opts.config.ceo = { fullPower: true };
    const built = await runner.buildHello();
    const capabilities = built.capabilities as string[];
    const [wire] = h.server.of('hello');
    const parsed = HelloSchema.safeParse({ ...wire, capabilities });
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    expect(capabilities).toContain('ceo-full-power:1');
    expect(capabilities).toContain('app-integrations:1');
    // The list outgrew the old bound of 50: the bound has to keep room for it.
    expect(capabilities.length).toBeGreaterThan(50);
    expect(capabilities.length).toBeLessThanOrEqual(MAX_HELLO_CAPABILITIES);
  });
});
