import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRuntimeSpec } from '@aom/shared';
import type { RuntimeAdapter, RuntimeEvent } from '../adapters/types.ts';
import type { RunnerPaths } from '../paths.ts';
import { ensureSandbox, holdAgentTmp, type Sandbox, sandboxEnv } from '../sandbox/sandbox.ts';
import { agentPath, type ResolvedToolchains } from '../toolchain/registry.ts';
import { resolveCommitIdentity } from './identity.ts';
import type { DocsPrepModelRequest, DocsPrepStepContext } from './release-docs-prep-steps.ts';

export interface DocsPrepModelDeps {
  adapters: Map<string, RuntimeAdapter>;
  paths: RunnerPaths;
  toolchains?: { resolve(): ResolvedToolchains };
  /** Test seam: the agent's sandbox (default: `ensureSandbox`). */
  sandbox?: (writer: AgentRuntimeSpec) => Promise<Sandbox>;
}

export const NO_WRITER = 'no agent on this workstation can write the release documentation';

type ModelResult = Awaited<ReturnType<DocsPrepStepContext['runModel']>>;

/**
 * The model call of the model-backed Release prep steps: one headless call as the writer the server chose (an agent on
 * this workstation), the same kind of call as a chat turn. It reads the folders it is given; the only place it may write
 * is a fresh folder in the agent's own scratch directory, which is copied to the step's `writeDir` afterwards. It gets no
 * runner connection (no `aom`), no web and no repository write access.
 */
export function docsPrepModel(
  deps: DocsPrepModelDeps,
  writer: AgentRuntimeSpec | undefined,
): DocsPrepStepContext['runModel'] {
  return async (req) => {
    if (!writer) return { ok: false, error: NO_WRITER };
    const adapter = deps.adapters.get(writer.runtime);
    const caps = adapter ? await adapter.capabilities().catch(() => undefined) : undefined;
    if (!adapter?.startChat || !caps?.available)
      return { ok: false, error: `${NO_WRITER}: the runtime ${writer.runtime} is not available here` };
    if (adapter.instructionStyle === 'tools')
      return { ok: false, error: `${NO_WRITER}: the runtime ${writer.runtime} cannot write files` };
    const sandbox = deps.sandbox
      ? await deps.sandbox(writer)
      : await ensureSandbox(
          deps.paths,
          writer.agentId,
          writer.name,
          await resolveCommitIdentity(deps.paths.root),
        );
    const release = holdAgentTmp(sandbox);
    const work = join(sandbox.scratch, 'release-prep', randomUUID());
    try {
      await mkdir(work, { recursive: true });
      return await runIn(deps, adapter, writer, sandbox, work, req);
    } catch (err) {
      return {
        ok: false,
        error: `the writer could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
      release();
    }
  };
}

async function runIn(
  deps: DocsPrepModelDeps,
  adapter: RuntimeAdapter,
  writer: AgentRuntimeSpec,
  sandbox: Sandbox,
  work: string,
  req: DocsPrepModelRequest,
): Promise<ModelResult> {
  await adapter.writeInstructions(sandbox, `${req.instructions.trim()}\n`);
  const tc = deps.toolchains?.resolve();
  const id = `docs-prep-${randomUUID()}`;
  const session = await (adapter.startChat as NonNullable<RuntimeAdapter['startChat']>)({
    chatId: id,
    // The step names its own write folder; the writer sees the folder it may write instead.
    message: req.prompt.split(req.writeDir).join(work),
    cwd: work,
    sandbox,
    agent: writer,
    env: {
      ...sandboxEnv(sandbox, undefined, tc?.env),
      PATH: tc ? agentPath(tc, deps.paths.bin) : (process.env.PATH ?? ''),
    },
    // Edit only in the scratch folder (the cwd here); the repositories are read-only folders.
    readOnly: false,
    readDirs: req.readDirs,
    ...(tc ? { toolchainReadDirs: tc.readDirs } : {}),
    logFile: join(deps.paths.shiftLogs, `${id}.jsonl`),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void session.stop('release-prep.timeout');
  }, req.timeoutMs);
  let exit: Extract<RuntimeEvent, { kind: 'exit' }> | undefined;
  try {
    for await (const e of session.events()) if (e.kind === 'exit') exit = e;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut)
    return { ok: false, error: `the writer did not finish within ${Math.round(req.timeoutMs / 60_000)} min` };
  if (!exit || exit.code !== 0) {
    const why = exit?.usageLimit
      ? `the usage limit was hit (resets ${exit.usageLimit.until})`
      : exit?.authFailed
        ? 'the runtime login does not work'
        : (exit?.error ?? `it exited with ${exit?.code ?? 'no code'}`);
    return { ok: false, error: `the writer failed: ${why}` };
  }
  await mkdir(req.writeDir, { recursive: true });
  for (const name of await readdir(work))
    await cp(join(work, name), join(req.writeDir, name), { recursive: true, force: true });
  return { ok: true };
}
