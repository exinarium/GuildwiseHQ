import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRuntimeSpec } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import type { ChatStartInput, RuntimeAdapter, RuntimeEvent } from '../src/adapters/types.ts';
import { docsPrepModel, NO_WRITER } from '../src/git/release-docs-prep-model.ts';
import type { DocsPrepModelRequest } from '../src/git/release-docs-prep-steps.ts';
import { runnerPaths } from '../src/paths.ts';
import type { Sandbox } from '../src/sandbox/sandbox.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const WRITER = {
  agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  name: 'Ada',
  roleKey: 'architect',
  seniority: 'senior',
  runtime: 'fake',
  model: 'm',
  skills: [],
  permissions: {},
  isDevops: false,
} as unknown as AgentRuntimeSpec;

function fakeAdapter(
  act: (input: ChatStartInput) => RuntimeEvent[] | 'hang',
  over: Partial<RuntimeAdapter> = {},
): { adapter: RuntimeAdapter; starts: ChatStartInput[]; instructions: string[]; stops: string[] } {
  const starts: ChatStartInput[] = [];
  const instructions: string[] = [];
  const stops: string[] = [];
  const adapter: RuntimeAdapter = {
    id: 'fake',
    capabilities: async () => ({ runtime: 'fake', version: '1', available: true, capabilities: [] }),
    writeInstructions: async (_sb, md) => {
      instructions.push(md);
    },
    start: async () => {
      throw new Error('no shifts');
    },
    startChat: async (input) => {
      starts.push(input);
      const events = act(input);
      let stop: () => void = () => {};
      const stopped = new Promise<void>((r) => {
        stop = r;
      });
      return {
        async *events() {
          if (events === 'hang') {
            await stopped;
            yield { kind: 'exit', code: null, signal: 'SIGTERM' } as RuntimeEvent;
            return;
          }
          for (const e of events) yield e;
        },
        stop: async (reason: string) => {
          stops.push(reason);
          stop();
        },
        usage: () => ({}),
      } as unknown as Awaited<ReturnType<NonNullable<RuntimeAdapter['startChat']>>>;
    },
    ...over,
  };
  return { adapter, starts, instructions, stops };
}

function setup(adapter?: RuntimeAdapter) {
  const root = tmp('aom-docs-prep-model-');
  const paths = runnerPaths(root);
  const scratch = join(root, 'scratch');
  mkdirSync(scratch, { recursive: true });
  const sb = {
    home: root,
    configDir: join(root, 'cfg'),
    scratch,
    tmp: join(root, 'tmp'),
    cacheRoot: undefined,
  } as unknown as Sandbox;
  const outDir = tmp('aom-docs-prep-out-');
  const repo = tmp('aom-docs-prep-repo-');
  const run = docsPrepModel(
    { adapters: new Map(adapter ? [['fake', adapter]] : []), paths, sandbox: async () => sb },
    WRITER,
  );
  const req = (over: Partial<DocsPrepModelRequest> = {}): DocsPrepModelRequest => ({
    instructions: 'Write the guide JSON.',
    prompt: `Write the JSON to ${join(outDir, 'guide.json')}.`,
    readDirs: [repo],
    writeDir: outDir,
    timeoutMs: 60_000,
    ...over,
  });
  return { run, req, outDir, repo, scratch };
}

const writeTarget = (input: ChatStartInput): string =>
  /Write the JSON to (\S+)\./.exec(input.message)?.[1] as string;

describe('release prep model call', () => {
  it('runs one headless call as the writer, writing only in its scratch folder, and hands the file to the step', async () => {
    const f = fakeAdapter((input) => {
      writeFileSync(writeTarget(input), '{"edits":[]}');
      return [
        { kind: 'final', text: 'done' },
        { kind: 'exit', code: 0 },
      ];
    });
    const s = setup(f.adapter);
    const r = await s.run(s.req());
    expect(r).toEqual({ ok: true });
    expect(readFileSync(join(s.outDir, 'guide.json'), 'utf8')).toBe('{"edits":[]}');
    const input = f.starts[0] as ChatStartInput;
    expect(f.starts).toHaveLength(1);
    // writes in a fresh folder of the agent's scratch dir, never in the step folder or the repository
    expect(input.cwd.startsWith(s.scratch)).toBe(true);
    expect(input.message).toContain(input.cwd);
    expect(input.message).not.toContain(s.outDir);
    expect(input.readOnly).toBe(false);
    expect(input.readDirs).toEqual([s.repo]);
    expect(input.agent).toBe(WRITER);
    // no runner connection: the writer cannot run aom
    expect(input.env.AOM_SHIFT_TOKEN).toBeUndefined();
    expect(input.env.AOM_IPC_URL).toBeUndefined();
    expect(f.instructions).toEqual(['Write the guide JSON.\n']);
    // the scratch folder is removed afterwards
    expect(existsSync(input.cwd)).toBe(false);
  });

  it('fails with the reason when there is no writer or its runtime is not here', async () => {
    const s = setup();
    expect(await s.run(s.req())).toMatchObject({ ok: false, error: expect.stringContaining(NO_WRITER) });
    const none = docsPrepModel({ adapters: new Map(), paths: runnerPaths(tmp('aom-x-')) }, undefined);
    expect(await none(s.req())).toEqual({ ok: false, error: NO_WRITER });
    const off = fakeAdapter(() => [], {
      capabilities: async () => ({ runtime: 'fake', version: '1', available: false, capabilities: [] }),
    });
    const s2 = setup(off.adapter);
    expect(await s2.run(s2.req())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not available/),
    });
    expect(off.starts).toHaveLength(0);
    const tools = fakeAdapter(() => [], { instructionStyle: 'tools' });
    const s3 = setup(tools.adapter);
    expect(await s3.run(s3.req())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot write files/),
    });
  });

  it('fails when the call exits with an error, and copies nothing', async () => {
    const f = fakeAdapter((input) => {
      writeFileSync(writeTarget(input), '{}');
      return [{ kind: 'exit', code: 1, usageLimit: { until: '2026-11-04T12:00:00Z' } }];
    });
    const s = setup(f.adapter);
    const r = await s.run(s.req());
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/usage limit/) });
    expect(existsSync(join(s.outDir, 'guide.json'))).toBe(false);
  });

  it('stops the call at its time limit', async () => {
    const f = fakeAdapter(() => 'hang');
    const s = setup(f.adapter);
    const r = await s.run(s.req({ timeoutMs: 50 }));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/did not finish/) });
    expect(f.stops).toEqual(['release-prep.timeout']);
  });
});
