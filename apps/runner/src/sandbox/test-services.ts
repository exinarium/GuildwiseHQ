import net from 'node:net';
import { join } from 'node:path';
import {
  type LocalTestService,
  RESERVED_RUN_PORTS,
  TEST_SERVICE_HOSTS,
  testServiceDomain,
} from '@aom/shared';
import { AOM_BRIDGES_FILE } from '../shims.ts';

/**
 * Local test services of a project (GWP-41, docs/RUNNER.md "Local test services"). The server sends the project's declared
 * loopback host:port pairs with a card shift; this module decides which of them the shift's sandbox may reach and why not
 * for the rest. Nothing here opens a port (`probeLocalPort` only connects, from the runner, outside any sandbox). The opening itself is one exact `host:port` entry in the Claude Code
 * sandbox's `allowedDomains` (its proxy enforces the port), and `aom-env` tunnels a local listener through that proxy.
 * Nothing is hard-coded: host and port always come from the project's settings.
 */

/** Roles whose shifts may reach a declared test service. Every other role, chat, scan and DevOps gets nothing. */
export const TEST_SERVICE_ROLES: ReadonlySet<string> = new Set(['builder', 'reviewer', 'tester']);

/** The first Claude Code version documented to take port-qualified IP entries (bracketed IPv6 with a port included). */
export const MIN_CLAUDE_FOR_TEST_SERVICES = '2.1.229';

/** Where the project Owner declares (and so opens) a local test service. Named in every message about a closed port. */
export const TEST_SERVICES_SETTING = 'Project settings > Local test services';

export type TestServiceDecision = LocalTestService &
  (
    | {
        state: 'allowed';
        /** Set by the runner's own connect at shift start: false when nothing answers on this workstation. */
        answering?: boolean;
      }
    | { state: 'refused'; reason: string }
  );

export interface TestServiceInput {
  services: LocalTestService[] | undefined;
  kind: string;
  roleKey: string;
  isDevops: boolean;
  runtime: string;
  hasShell: boolean;
  platform: NodeJS.Platform;
  /** The effective sandbox state of the runtime (`enforced` is the only one that can open a single port). */
  sandbox: 'enforced' | 'unsandboxed' | 'unavailable' | undefined;
  /** `claude --version` of this workstation (absent: unknown). */
  claudeVersion?: string | undefined;
  /** Ports the runner itself owns: its local HTTP port and every port of a run environment. Never opened. */
  runnerPorts: ReadonlySet<number>;
  /** Ports this shift already forwards to its test environment (a tester). The environment wins. */
  envForwardPorts: ReadonlySet<number>;
}

/** True when `version` ("2.1.314") is at least `min`; an unknown or unparsable version is below any minimum. */
export function versionAtLeast(version: string | undefined, min: string): boolean {
  const parse = (v: string) => {
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
  };
  const a = version ? parse(version) : null;
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Which declared services this shift gets, and why not for the rest. Empty: nothing at all is added to the shift. */
export function decideTestServices(i: TestServiceInput): TestServiceDecision[] {
  const services = i.services ?? [];
  if (services.length === 0) return [];
  if (i.kind !== 'card' || i.isDevops || !TEST_SERVICE_ROLES.has(i.roleKey)) return [];
  const refuse = (s: LocalTestService, reason: string): TestServiceDecision => ({
    ...s,
    state: 'refused',
    reason,
  });
  // The shift-wide reasons first, then the per-port ones.
  const shiftWide = !i.hasShell
    ? 'this role has no shell'
    : i.runtime !== 'claude-code'
      ? `not reachable with the ${i.runtime} runtime (no per-port opening there)`
      : i.platform !== 'linux' || i.sandbox !== 'enforced'
        ? "this platform's sandbox cannot open a single loopback port; nothing was opened"
        : !versionAtLeast(i.claudeVersion, MIN_CLAUDE_FOR_TEST_SERVICES)
          ? `Claude Code ${i.claudeVersion ?? '(unknown version)'} cannot limit the sandbox to one port (needs ${MIN_CLAUDE_FOR_TEST_SERVICES} or newer)`
          : null;
  return services.map((s): TestServiceDecision => {
    if (!(TEST_SERVICE_HOSTS as readonly string[]).includes(s.host))
      return refuse(s, 'only 127.0.0.1, ::1 and localhost can be opened');
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)
      return refuse(s, `port ${s.port} is not valid`);
    if (shiftWide) return refuse(s, shiftWide);
    if (i.runnerPorts.has(s.port))
      return refuse(s, `port ${s.port} belongs to the runner (its local HTTP port or a run environment)`);
    if (i.envForwardPorts.has(s.port))
      return refuse(s, `port ${s.port} is already forwarded to the test environment`);
    if (RESERVED_RUN_PORTS.includes(s.port)) return refuse(s, `port ${s.port} is used by the sandbox proxy`);
    return { ...s, state: 'allowed' };
  });
}

const allowed = (d: TestServiceDecision[]) => d.filter((x) => x.state === 'allowed');

/** The exact `host:port` sandbox allowlist entries of the allowed services (never a bare host). */
export function testServiceDomains(d: TestServiceDecision[]): string[] {
  return allowed(d).map((x) => testServiceDomain(x));
}

/** `AOM_TEST_SERVICES` for `aom-env`: "127.0.0.1:5433,[::1]:6379" (allowed services only). */
export function testServicesSpec(d: TestServiceDecision[]): string {
  return testServiceDomains(d).join(',');
}

/** The one sentence every tester note ends with: what is closed and who opens it. */
const CLOSED_PORTS_LINE = `Any other local port is closed in this shift (connection refused). Only the project Owner can open one, in ${TEST_SERVICES_SETTING}; you cannot open it yourself.`;

export interface TestServicesNoteOptions {
  /**
   * True in a tester shift whose every bash sources the bridges (`BASH_ENV`, GWP-102): any command reaches the services
   * directly. False (builders, reviewers): only a command run through `aom-env` does.
   */
  autoBridged?: boolean;
}

/** The section of the shift's instructions (empty when nothing was declared for this shift). */
export function testServicesNote(d: TestServiceDecision[], opts: TestServicesNoteOptions = {}): string {
  if (d.length === 0) return '';
  const ok = allowed(d);
  const refused = d.filter(
    (x): x is Extract<TestServiceDecision, { state: 'refused' }> => x.state === 'refused',
  );
  const lines = ['## Local test services'];
  if (ok.length > 0) {
    lines.push(
      'Your shell may connect to these services on this workstation (and to no other local port):',
      ...ok.map((x) => `- ${x.name}: ${testServiceDomain(x)}`),
      ...(opts.autoBridged
        ? [
            'Every Bash command of this shift reaches them directly (curl, psql, Node, Playwright and their child processes): no wrapper is needed.',
            '`aom-env --timeout <minutes> -- <command>` still works and adds a hang limit.',
          ]
        : [
            'Each Bash call has its own network, so run every command that needs them through aom-env, in the same call:',
            '`aom-env --timeout <minutes> -- <command>` (for example `aom-env --timeout 20 -- pnpm --filter @aom/server test`).',
          ]),
      "Credentials are in the project's test configuration, not here.",
    );
  } else lines.push('No local test service is reachable in this shift.');
  if (refused.length > 0)
    lines.push(
      `${ok.length > 0 ? 'Not reachable in this shift' : 'Why'}: ${refused
        .map((x) => `${x.name} (${testServiceDomain(x)}): ${x.reason}`)
        .join('; ')}. The project Owner changes this in ${TEST_SERVICES_SETTING}.`,
    );
  const silent = ok.filter((x) => x.answering === false);
  if (silent.length > 0) lines.push(...silent.map(notAnsweringLine));
  if (opts.autoBridged) lines.push(CLOSED_PORTS_LINE);
  return lines.join('\n');
}

/**
 * A tester shift of a project that declared no local test service: what it can reach, and where the Owner opens more.
 */
export function noTestServicesNote(): string {
  return [
    '## Local test services',
    `This project declares no local test service (${TEST_SERVICES_SETTING}), so no workstation port (a database, a mail catcher, a hosted build) is reachable from this shift.`,
    'A server the suite starts itself on 127.0.0.1 is reachable from the same Bash call (the browser included).',
    CLOSED_PORTS_LINE,
  ].join('\n');
}

/**
 * The tester's per-shift E2E scratch (GWP-102): inside the sandbox's write allow-list and swept when the shift ends.
 * Docker is not part of any tester sandbox.
 */
export function testerScratchNote(e2eDir: string): string {
  return [
    '## E2E scratch',
    `Write the suite's working files under \`$AOM_E2E_DIR\` (${e2eDir}): the E2E harness, a nested runner (\`AOM_AGENT_TMP_ROOT\`) and the Playwright HTML report (\`PLAYWRIGHT_HTML_OUTPUT_DIR\`) already use it.`,
    'Pass `--output "$AOM_E2E_DIR/test-results"` to `playwright test` for traces and test results. The folder is removed when the shift ends: copy what must be kept into your report.',
    'Docker is not available in this sandbox: specs that run docker are run by DevOps; ask with `aom devops` and record their result separately.',
  ].join('\n');
}

/** A tester card shift (not DevOps): the one shift that gets the auto-bridge and the E2E scratch (GWP-102). */
export function isTesterShift(kind: string, roleKey: string, isDevops: boolean): boolean {
  return kind === 'card' && roleKey === 'tester' && !isDevops;
}

/** The tester's per-shift E2E scratch: `<agent TMPDIR>/e2e`. */
export const testerE2eDir = (tmp: string): string => join(tmp, 'e2e');

/**
 * The env a tester shift adds on top of everyone's (empty for every other shift, so their env is unchanged):
 * - `BASH_ENV`: the bridges, only when at least one declared service was opened (`autoBridged`);
 * - `AOM_E2E_DIR`, `AOM_AGENT_TMP_ROOT` (a nested runner's agent tmp dirs, since `/tmp` is read-only in the sandbox) and
 *   `PLAYWRIGHT_HTML_OUTPUT_DIR`, all inside the shift's TMPDIR, which is in the write allow-list and swept at shift end.
 */
export function testerShiftEnv(o: {
  isTester: boolean;
  autoBridged: boolean;
  tmp: string;
  binDir: string;
}): Record<string, string> {
  if (!o.isTester) return {};
  const e2e = testerE2eDir(o.tmp);
  return {
    // SHLVL >= 1: bash -c with a socket for stdin (how Node starts a child) and SHLVL < 2 takes the rshd path, which reads
    // ~/.bashrc instead of BASH_ENV. With SHLVL=1 every bash of the shift is level 2 or more and reads BASH_ENV.
    ...(o.autoBridged ? { BASH_ENV: join(o.binDir, AOM_BRIDGES_FILE), SHLVL: '1' } : {}),
    AOM_E2E_DIR: e2e,
    AOM_AGENT_TMP_ROOT: join(e2e, 'agent-tmp'),
    PLAYWRIGHT_HTML_OUTPUT_DIR: join(e2e, 'playwright-report'),
  };
}

/** The line for a declared, opened service that did not answer the runner's own connect at shift start. */
export function notAnsweringLine(x: LocalTestService): string {
  return `Local test service ${x.name} (${testServiceDomain(x)}) is declared in ${TEST_SERVICES_SETTING} but nothing answers on this workstation: start it or ask DevOps (aom devops).`;
}

/** The progress line for a service that was declared but not opened. */
export function refusedProgress(x: Extract<TestServiceDecision, { state: 'refused' }>): string {
  return `Local test service ${x.name} (${testServiceDomain(x)}) not opened: ${x.reason}. The project Owner changes this in ${TEST_SERVICES_SETTING}.`;
}

/** True when something accepts a TCP connection on host:port within `timeoutMs` (run by the runner, outside any sandbox). */
export function probeLocalPort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Marks each allowed service with whether it answers (all probed at once); refused ones are returned as they are. */
export async function withReachability(
  d: TestServiceDecision[],
  probe: (host: string, port: number) => Promise<boolean> = probeLocalPort,
): Promise<TestServiceDecision[]> {
  return Promise.all(
    d.map(async (x) =>
      x.state === 'allowed' ? { ...x, answering: await probe(x.host, x.port).catch(() => false) } : x,
    ),
  );
}

/** What the doctor shows for one project: when the runner last saw its declaration and what it decided. */
export interface TestServicesSeen {
  at: string;
  decisions: TestServiceDecision[];
}
