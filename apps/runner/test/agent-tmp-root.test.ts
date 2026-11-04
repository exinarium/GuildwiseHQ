import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import {
  agentTmpDir,
  agentTmpRoot,
  cleanAgentTmp,
  ensureSandbox,
  wipeAgent,
} from '../src/sandbox/sandbox.ts';
import { testerShiftEnv } from '../src/sandbox/test-services.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const posix = process.platform !== 'win32';

/** The runner reads `AOM_AGENT_TMP_ROOT` from its own env: each test sets it and puts the caller's value back. */
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AOM_AGENT_TMP_ROOT;
});
afterEach(() => {
  if (saved === undefined) delete process.env.AOM_AGENT_TMP_ROOT;
  else process.env.AOM_AGENT_TMP_ROOT = saved;
});

describe('agentTmpRoot (a runner started inside a tester shift)', () => {
  it('is /tmp unless an absolute AOM_AGENT_TMP_ROOT is set', () => {
    expect(agentTmpRoot({})).toBe('/tmp');
    expect(agentTmpRoot({ AOM_AGENT_TMP_ROOT: '' })).toBe('/tmp');
    expect(agentTmpRoot({ AOM_AGENT_TMP_ROOT: 'relative/dir' })).toBe('/tmp');
    expect(agentTmpRoot({ AOM_AGENT_TMP_ROOT: '/tmp/aom-0123456789/e2e/agent-tmp' })).toBe(
      '/tmp/aom-0123456789/e2e/agent-tmp',
    );
    expect(agentTmpRoot({ AOM_AGENT_TMP_ROOT: '/x/y//' })).toBe('/x/y');
  });

  it.runIf(posix)(
    'production keeps /tmp/aom-<10 hex>; the override only moves the root, not the name',
    () => {
      const paths = runnerPaths(tmp());
      delete process.env.AOM_AGENT_TMP_ROOT;
      const plain = agentTmpDir(paths, A);
      expect(plain).toMatch(/^\/tmp\/aom-[0-9a-f]{10}$/);
      const root = tmp();
      process.env.AOM_AGENT_TMP_ROOT = root;
      expect(agentTmpDir(paths, A)).toBe(join(root, plain.slice('/tmp/'.length)));
    },
  );

  it.runIf(posix)('ensureSandbox creates the agent TMPDIR under the root and wipe removes it', async () => {
    const root = tmp();
    process.env.AOM_AGENT_TMP_ROOT = root;
    const paths = runnerPaths(tmp());
    const sb = await ensureSandbox(paths, A, 'A');
    expect(sb.tmp.startsWith(`${root}/aom-`)).toBe(true);
    expect(statSync(sb.tmp).isDirectory()).toBe(true);
    expect(statSync(sb.tmp).mode & 0o777).toBe(0o700);
    await wipeAgent(paths, A);
    expect(existsSync(sb.tmp)).toBe(false);
  });
});

describe('tester E2E scratch', () => {
  it.runIf(posix)('lives in the shift TMPDIR and is swept at shift end, the compile cache kept', async () => {
    const root = tmp();
    process.env.AOM_AGENT_TMP_ROOT = root;
    const sb = await ensureSandbox(runnerPaths(tmp()), A, 'A');
    const env = testerShiftEnv({ isTester: true, autoBridged: false, tmp: sb.tmp, binDir: '/bin-dir' });
    for (const k of ['AOM_E2E_DIR', 'AOM_AGENT_TMP_ROOT', 'PLAYWRIGHT_HTML_OUTPUT_DIR'] as const)
      expect(env[k]?.startsWith(`${sb.tmp}/`)).toBe(true);
    // what the suite and a nested runner leave behind
    const nested = join(env.AOM_AGENT_TMP_ROOT as string, 'aom-0123456789');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(env.AOM_E2E_DIR as string, 'test-results'), { recursive: true });
    writeFileSync(join(env.AOM_E2E_DIR as string, 'test-results', 'trace.zip'), 'z');
    mkdirSync(join(sb.tmp, 'node-compile-cache'), { recursive: true });
    await cleanAgentTmp(sb.tmp);
    expect(existsSync(env.AOM_E2E_DIR as string)).toBe(false);
    expect(existsSync(join(sb.tmp, 'node-compile-cache'))).toBe(true);
  });
});
