import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { lookupBin } from '../../../apps/runner/src/adapters/bin-lookup.ts';
import { ClaudeCodeAdapter } from '../../../apps/runner/src/adapters/claude-code.ts';
import type { RuntimeAdapter } from '../../../apps/runner/src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../../../apps/runner/src/config.ts';
import { RunnerHost } from '../../../apps/runner/src/host.ts';
import { createLogger } from '../../../apps/runner/src/log.ts';
import { entryDir, loadIndex } from '../../../apps/runner/src/pairings.ts';
import { runnerPaths } from '../../../apps/runner/src/paths.ts';
import { defaultAuthority } from '../../../apps/runner/src/policy/authority.ts';
import { HeldStore } from '../../../apps/runner/src/policy/held.ts';
import { PasskeyStore } from '../../../apps/runner/src/policy/passkey-store.ts';
import { PolicyStore, policyDir } from '../../../apps/runner/src/policy/store.ts';
import { instanceOfUser } from '../../../apps/runner/src/setup/admin-command.ts';
import { RUNNER_VERSION } from '../../../apps/runner/src/version.ts';
import { localWindowOffers } from '../../../apps/runner/src/window/api.ts';
import { startApprovalsWindow } from '../../../apps/runner/src/window/server.ts';
import { gateDirOf, initGates } from './gates.ts';
import { ScenarioAdapter } from './scenario-adapter.ts';

/**
 * The scripted runner host of the combined e2e harness. A near-copy of `start()` in apps/runner/src/cli.ts (core
 * 7282ad12, lines 271-430) on the product's own `RunnerHost`, with exactly these deliberate differences:
 *  - `AOM_RUNNER_MOCK=1` stays on (a real Claude is impossible: `realClaudeBlocked()`), and the agent runtime is the
 *    `ScenarioAdapter` (the product's MockAdapter plus scripted scenario shifts), registered under the id `mock`;
 *  - the approvals page IS started (the product never starts it in mock mode), with the same `startApprovalsWindow`
 *    arguments as cli.ts;
 *  - no `startupCheck` (a dev user in the docker group would be refused), no self-updater, no legacy-sudo clean-up,
 *    no `requestRestart` (nothing here would start the runner again).
 * The policy dir comes from AOM_RUNNER_POLICY_DIR, as in the product. It prints one JSON line: {pid, approvalsPort}.
 */
async function main(): Promise<void> {
  const dataDir = process.env.AOM_RUNNER_HOME;
  if (!dataDir) throw new Error('AOM_RUNNER_HOME is required');
  if (process.env.AOM_RUNNER_MOCK !== '1') throw new Error('AOM_RUNNER_MOCK=1 is required (no real Claude)');
  if (!process.env.AOM_RUNNER_POLICY_DIR) throw new Error('AOM_RUNNER_POLICY_DIR is required');
  const paths = runnerPaths(dataDir);
  const log = createLogger(paths.runnerLog, true);
  const gateDir = gateDirOf(dataDir);
  initGates(gateDir);
  mkdirSync(policyDir(), { recursive: true });
  const policyStore = new PolicyStore();
  let hostRef: RunnerHost | undefined;
  let windowState: { port?: number; error?: string } | undefined;
  const window = await startApprovalsWindow({
    instance: instanceOfUser(userInfo().username),
    serverOrigins: (() => {
      try {
        return [...new Set(loadIndex(paths.root).pairings.map((e) => new URL(e.serverUrl).origin))];
      } catch {
        return [];
      }
    })(),
    version: RUNNER_VERSION,
    status: () => {
      const running = [...(hostRef?.running.values() ?? [])];
      return {
        connected: Object.fromEntries(
          running.map((r) => [new URL(r.serverUrl).origin, r.runner.client.isReady]),
        ),
        shifts: running.flatMap((r) =>
          r.runner
            .runningShifts()
            .map((s) => ({ title: `shift ${s.shiftId.slice(0, 8)}`, startedAt: s.startedAt })),
        ),
        runnerUser: userInfo().username,
      };
    },
    held: new HeldStore(policyDir()),
    policy: policyStore,
    passkeys: new PasskeyStore(policyDir()),
    offers: () => localWindowOffers(paths.root),
    blocked: () => [...(hostRef?.running.values() ?? [])].flatMap((r) => r.runner.blockedDevops()),
    log,
    decide: (id, state, extra) => new HeldStore(policyDir()).decide(id, state, 'local', extra),
    portRange: [47700, 47799],
  });
  if (window.port && !window.windowError) windowState = { port: window.port };
  else windowState = { port: window.port, error: window.windowError ?? 'not started' };

  const adapter = new ScenarioAdapter({ enabled: true }, paths, gateDir);
  const adapters = new Map<string, RuntimeAdapter>([['mock', adapter]]);
  const claude = realBoxAdapter(paths);
  if (claude) adapters.set('claude-code', claude);
  const host = new RunnerHost({
    root: paths.root,
    log,
    mock: true,
    runnerOptions: {
      windowState: () => windowState,
      authority: defaultAuthority(),
      adapters,
      approvalsPollMs: 200,
    },
  });
  hostRef = host;
  await host.start();
  process.stdout.write(
    `${JSON.stringify({ pid: process.pid, approvalsPort: window.port, error: window.windowError ?? null })}\n`,
  );
  const stop = async () => {
    await host.stop().catch(() => undefined);
    await window.close().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  void host.fatal.then(() => void stop());
  void entryDir;
}

/**
 * runner-bare-bin [A11]: with AOM_COMBINED_CLAUDE_BOX=1 the real `ClaudeCodeAdapter` is registered as `claude-code`, configured
 * with the BARE bin "claude" (blocker 1), an API key that is a dummy, and its constructor test hooks: the model upstream is the
 * spec's fake API on 127.0.0.1 (AOM_COMBINED_FAKE_API), the boxes' proxy may reach loopback for it, and every model request's
 * capture event goes to AOM_COMBINED_CAPTURE. It refuses to start unless "claude" on this host's PATH is the harness's own fake
 * under AOM_COMBINED_TOOLS, or (AOM_COMBINED_REAL_CLAUDE=1, [A11-L2]) exactly the real Claude Code AOM_COMBINED_REAL_CLAUDE_BIN
 * names; AOM_COMBINED_TOOLCHAIN is its one configured toolchain folder. The product never reads these variables; `registry.ts`
 * never passes the hooks.
 */
function realBoxAdapter(paths: ReturnType<typeof runnerPaths>): ClaudeCodeAdapter | undefined {
  if (process.env.AOM_COMBINED_CLAUDE_BOX !== '1') return undefined;
  const upstream = process.env.AOM_COMBINED_FAKE_API ?? '';
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(upstream))
    throw new Error('AOM_COMBINED_FAKE_API must be a 127.0.0.1 URL');
  const found = lookupBin('claude', process.env.PATH ?? '', { uid: process.geteuid?.() ?? null });
  if (!found.ok) throw new Error(`no claude for the real box: ${found.reason}`);
  const tools = process.env.AOM_COMBINED_TOOLS ? realpathSync(process.env.AOM_COMBINED_TOOLS) : '';
  const real =
    process.env.AOM_COMBINED_REAL_CLAUDE === '1' ? process.env.AOM_COMBINED_REAL_CLAUDE_BIN : undefined;
  const ok = real ? found.real === realpathSync(real) : !!tools && found.real.startsWith(`${tools}${sep}`);
  if (!ok)
    throw new Error(`refusing to start ${found.real}: not the harness's fake (or the named real claude)`);
  const capture = process.env.AOM_COMBINED_CAPTURE;
  return new ClaudeCodeAdapter(
    ClaudeRuntimeConfigSchema.parse({
      bin: 'claude',
      sandbox: 'required',
      authMode: 'api_key',
      apiKey: 'sk-ant-api03-combined-harness-dummy',
      // devops-box-access [A11-L2]: a toolchain folder the boxes mount read-only (the spec lists it with `ls`)
      ...(process.env.AOM_COMBINED_TOOLCHAIN ? { toolchainPaths: [process.env.AOM_COMBINED_TOOLCHAIN] } : {}),
    }),
    paths,
    {
      modelUpstream: upstream,
      proxyTest: { allowPrivate: true },
      ...(capture ? { modelCapture: (e) => appendFileSync(capture, `${JSON.stringify(e)}\n`) } : {}),
    },
  );
}

main().catch((err) => {
  process.stderr.write(
    `scripted runner host failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
