import {
  type LocalTestService,
  RESERVED_RUN_PORTS,
  TEST_SERVICE_HOSTS,
  testServiceDomain,
} from '@aom/shared';

/**
 * Local test services of a project (GWP-41, docs/RUNNER.md "Local test services"). The server sends the project's declared
 * loopback host:port pairs with a card shift; this module decides which of them the shift's sandbox may reach and why not
 * for the rest. Pure: nothing here opens a port. The opening itself is one exact `host:port` entry in the Claude Code
 * sandbox's `allowedDomains` (its proxy enforces the port), and `aom-env` tunnels a local listener through that proxy.
 * Nothing is hard-coded: host and port always come from the project's settings.
 */

/** Roles whose shifts may reach a declared test service. Every other role, chat, scan and DevOps gets nothing. */
export const TEST_SERVICE_ROLES: ReadonlySet<string> = new Set(['builder', 'reviewer', 'tester']);

/** The first Claude Code version documented to take port-qualified IP entries (bracketed IPv6 with a port included). */
export const MIN_CLAUDE_FOR_TEST_SERVICES = '2.1.229';

export type TestServiceDecision = LocalTestService &
  ({ state: 'allowed' } | { state: 'refused'; reason: string });

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
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return refuse(s, `port ${s.port} is not valid`);
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

/** The section of the shift's instructions (empty when nothing was declared for this shift). */
export function testServicesNote(d: TestServiceDecision[]): string {
  if (d.length === 0) return '';
  const ok = allowed(d);
  const refused = d.filter((x): x is Extract<TestServiceDecision, { state: 'refused' }> => x.state === 'refused');
  const lines = ['## Local test services'];
  if (ok.length > 0) {
    lines.push(
      'Your shell may connect to these services on this workstation (and to no other local port):',
      ...ok.map((x) => `- ${x.name}: ${testServiceDomain(x)}`),
      'Each Bash call has its own network, so run every command that needs them through aom-env, in the same call:',
      '`aom-env --timeout <minutes> -- <command>` (for example `aom-env --timeout 20 -- pnpm --filter @aom/server test`).',
      "Credentials are in the project's test configuration, not here.",
    );
  } else lines.push('No local test service is reachable in this shift.');
  if (refused.length > 0)
    lines.push(
      `${ok.length > 0 ? 'Not reachable in this shift' : 'Why'}: ${refused
        .map((x) => `${x.name} (${testServiceDomain(x)}): ${x.reason}`)
        .join('; ')}.`,
    );
  return lines.join('\n');
}

/** The progress line for a service that was declared but not opened. */
export function refusedProgress(x: Extract<TestServiceDecision, { state: 'refused' }>): string {
  return `Local test service ${x.name} (${testServiceDomain(x)}) not opened: ${x.reason}.`;
}

/** What the doctor shows for one project: when the runner last saw its declaration and what it decided. */
export interface TestServicesSeen {
  at: string;
  decisions: TestServiceDecision[];
}
