/**
 * quiet-approvals phase B, S5: the macOS DevOps profiles (`devops-inner.sb`, `devops-outer.sb`) for `sandbox-exec`. Both
 * are `(deny default)` and allow only:
 * - their mount-plan paths (read; write only where the Linux plan is writable);
 * - a `mach-lookup` allowlist, which leaves out launchd job submission, LaunchServices `open`, AppleEvents and
 *   SecurityServer (the keychain);
 * - network to the egress proxy (a loopback port), and the runner's IPC socket.
 * Both deny writes to `~/Library/LaunchAgents`. The outer profile reads git credentials (`~/.ssh`, `~/.gitconfig`), never the
 * AI login (the model proxy adds it). Seatbelt checks the resolved path, so no fd bind is needed there (round 6).
 *
 * Not tested on a Mac here (no Mac on the DevBox): unit tests check the generated text only; Mac QA is required.
 */

export interface MacProfileInput {
  level: 'inner' | 'outer';
  home: string;
  readPaths: string[];
  writePaths: string[];
  proxyPort: number;
  ipcSocket?: string;
  /** The Docker gatekeeper's socket (outer box with Docker allowed): the only Docker the box can reach. */
  dockerSocket?: string;
}

/** Services a CLI and its tools need; nothing that starts jobs, opens apps, sends AppleEvents or reaches the keychain. */
export const MACH_ALLOW: readonly string[] = [
  'com.apple.system.logger',
  'com.apple.system.notification_center',
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration',
  'com.apple.trustd',
  'com.apple.trustd.agent',
  'com.apple.FSEvents',
  'com.apple.logd',
  'com.apple.diagnosticd',
];

/** Never allowed, whatever the input says (checked by the tests). */
export const MACH_NEVER: readonly string[] = [
  'com.apple.launchd',
  'com.apple.coreservices.launchservicesd',
  'com.apple.coreservices.appleevents',
  'com.apple.SecurityServer',
  'com.apple.securityd',
];

const lit = (p: string): string => JSON.stringify(p);

export function macDevopsProfile(i: MacProfileInput): string {
  const sys = [
    '/usr',
    '/bin',
    '/sbin',
    '/System',
    '/Library/Apple',
    '/private/etc',
    '/dev',
    '/private/var/db/timezone',
  ];
  const read = [
    ...sys,
    ...i.readPaths,
    ...(i.level === 'outer' ? [`${i.home}/.ssh`, `${i.home}/.gitconfig`] : []),
  ];
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec (subpath "/usr") (subpath "/bin") (subpath "/sbin"))',
    ...i.readPaths.map((p) => `(allow process-exec (subpath ${lit(p)}))`),
    '(allow sysctl-read)',
    '(allow signal (target same-sandbox))',
    `(allow file-read* ${read.map((p) => `(subpath ${lit(p)})`).join(' ')})`,
    '(allow file-read-metadata (literal "/") (literal "/private") (literal "/var") (literal "/tmp"))',
    `(allow file-write* ${i.writePaths.map((p) => `(subpath ${lit(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty"))`,
    `(deny file-write* (subpath ${lit(`${i.home}/Library/LaunchAgents`)}))`,
    `(deny file-read* (subpath ${lit(`${i.home}/.claude`)}) (literal ${lit(`${i.home}/.claude.json`)}) (subpath ${lit(`${i.home}/Library/Keychains`)}))`,
    `(allow mach-lookup ${MACH_ALLOW.map((n) => `(global-name ${lit(n)})`).join(' ')})`,
    `(allow network-outbound (remote ip "localhost:${i.proxyPort}"))`,
    ...(i.ipcSocket ? [`(allow network-outbound (literal ${lit(i.ipcSocket)}))`] : []),
    ...(i.dockerSocket ? [`(allow network-outbound (literal ${lit(i.dockerSocket)}))`] : []),
  ];
  return `${lines.join('\n')}\n`;
}
