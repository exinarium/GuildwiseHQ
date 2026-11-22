/**
 * Copy-paste commands for local approvals (easy-runner-setup, 1.10.0). The runner renders every command itself
 * (`apps/runner/src/policy/local-command.ts`) and sends it with each held item and each local step; the server and the
 * web only show it, after checking it against this grammar. The web never builds command text and never approves
 * (R18): the command is pasted on the machine, where the CLI shows the item and asks again.
 *
 * The grammar is strict on purpose [S3]: an anchored CLI part (an absolute `guildwise-runner` path, optionally behind
 * `sudo -u guildwise-runner[-<instance>] -H ` or `wsl -d <distro> [-u guildwise-runner[-<instance>]] -- `), then a verb from a fixed table whose arguments
 * are typed per verb. No argument may start with `-` (the literal `--agent` of `devops grant` is the only option token).
 * Nothing a shell would interpret (quotes, `;`, `|`, `$`, backticks, redirections) can pass.
 */

/** Path characters of the CLI part: no spaces, quotes or shell metacharacters. */
const PATH_RE = /^\/[A-Za-z0-9._/-]*\/guildwise-runner$/;
const RUNNER_USER_RE = /^guildwise-runner(?:-[a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?)?$/;
const WSL_DISTRO_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The CLI part of a local command: `[sudo -u <runner user> -H |wsl -d <distro> -- ]<absolute path>/guildwise-runner`,
 * or the bare `guildwise-runner` (the fallback when the path is not known).
 */
export const LOCAL_CLI_RE =
  /^(?:(?:sudo -u guildwise-runner(?:-[a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?)? -H )|(?:wsl -d [A-Za-z0-9._-]{1,64} (?:-u guildwise-runner(?:-[a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?)? )?-- ))?(?:\/[A-Za-z0-9._/-]*\/guildwise-runner|guildwise-runner)$/;

const HELD_ID_RE = /^[a-z0-9]{6,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const B64URL_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,1023}$/;
/** `K7M2-Q9`: no 0/O, 1/I. */
export const PAIR_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/;
/**
 * An `https://` or `ssh://` repository URL with no characters a shell would interpret. A user part may be a bare name
 * (`ssh://git@host/...`); a `user:password@` part is refused ([`urlHasPassword`]).
 */
const REPO_URL_RE =
  /^(?:https|ssh):\/\/(?:[A-Za-z0-9._~%+-]+@)?[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%+:/-]{0,480})?$/;

/**
 * Does this repository or remote address carry a password (`scheme://user:secret@host`, or scp-style
 * `user:secret@host:path`)? Such an address is refused everywhere: never shown, stored, logged or put in a command.
 */
export function urlHasPassword(url: string): boolean {
  if (typeof url !== 'string') return false;
  const s = url.trim();
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s?#]*:[^/@\s?#]*@/i.test(s) || /^[^@/\s:]+:[^@/\s]*@[^\s]+$/.test(s);
}

/** The same address with any password replaced by `***` (for text that must still name it). */
export function redactUrlPassword(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^/@\s?#:]*):[^/@\s?#]*@/gi, '$1:***@')
    .replace(/(^|[\s"'])([^@/\s:"']+):[^@/\s"']*@(?=[A-Za-z0-9.-]+:)/g, '$1$2:***@');
}
/** The one placeholder a command may keep: the signing key file cannot be known (Overnight decision 12). */
export const KEY_FILE_PLACEHOLDER = '<key-file>';

type ArgCheck = (a: string) => boolean;
const re =
  (r: RegExp): ArgCheck =>
  (a) =>
    r.test(a);
const lit =
  (v: string): ArgCheck =>
  (a) =>
    a === v;

/** The verbs a copy-paste command may carry, each with its typed arguments (DESIGN "Local commands" table). */
const VERBS: ReadonlyArray<{ verb: readonly string[]; args: readonly ArgCheck[] }> = [
  { verb: ['approve'], args: [re(HELD_ID_RE)] },
  { verb: ['deny'], args: [re(HELD_ID_RE)] },
  { verb: ['devops', 'grant'], args: [re(UUID_RE), lit('--agent'), re(UUID_RE)] },
  { verb: ['repo', 'allow-scripts'], args: [re(REPO_URL_RE)] },
  { verb: ['formatter', 'pin'], args: [re(SHA256_RE)] },
  { verb: ['passkey', 'trust'], args: [re(B64URL_RE)] },
  { verb: ['approvals', 'pair'], args: [re(PAIR_CODE_RE)] },
  { verb: ['extras', 'install'], args: [lit('yt-dlp')] },
  { verb: ['devops', 'install'], args: [re(/^(?:on|off)$/)] },
  {
    verb: ['signing', 'add-key'],
    args: [lit('--key-id'), re(/^[0-9A-F]{16}$/), lit('--key-file'), lit(KEY_FILE_PLACEHOLDER)],
  },
  { verb: ['setup'], args: [] },
  { verb: ['pending'], args: [] },
  { verb: ['approvals', 'devices'], args: [] },
];

/** Option tokens a verb may carry literally; every other argument starting with `-` is refused. */
const OPTION_TOKENS = new Set(['--agent', '--key-id', '--key-file']);

/** Splits a command into its CLI part and the rest; null when the CLI part does not match LOCAL_CLI_RE. */
function splitCli(tokens: readonly string[]): { cli: string; rest: string[] } | null {
  let n: number;
  if (tokens[0] === 'sudo') {
    if (tokens[1] !== '-u' || !RUNNER_USER_RE.test(tokens[2] ?? '') || tokens[3] !== '-H') return null;
    n = 5;
  } else if (tokens[0] === 'wsl') {
    if (tokens[1] !== '-d' || !WSL_DISTRO_RE.test(tokens[2] ?? '')) return null;
    // `wsl -d <distro> -- <path>`, or with the runner user: `wsl -d <distro> -u <runner user> -- <path>`
    if (tokens[3] === '--') n = 5;
    else if (tokens[3] === '-u' && RUNNER_USER_RE.test(tokens[4] ?? '') && tokens[5] === '--') n = 7;
    else return null;
  } else n = 1;
  const path = tokens[n - 1] ?? '';
  if (path !== 'guildwise-runner' && !PATH_RE.test(path)) return null;
  if (path.split('/').some((s) => s === '..' || s === '.')) return null;
  const cli = tokens.slice(0, n).join(' ');
  if (!LOCAL_CLI_RE.test(cli)) return null;
  return { cli, rest: tokens.slice(n) };
}

/** Is this the CLI part of a local command (`localCli()` output)? */
export function localCliOk(cli: string): boolean {
  if (typeof cli !== 'string' || cli.length > 400 || /\s{2,}|^\s|\s$/.test(cli)) return false;
  const s = splitCli(cli.split(' '));
  return !!s && s.rest.length === 0;
}

/**
 * Does `cmd` match the strict local-command grammar [S3]? Single spaces only, no leading or trailing space, no newline.
 */
export function localCommandOk(cmd: string): boolean {
  if (typeof cmd !== 'string' || cmd.length === 0 || cmd.length > 900) return false;
  if (!/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(cmd)) return false;
  const s = splitCli(cmd.split(' '));
  if (!s) return false;
  for (const v of VERBS) {
    if (s.rest.length !== v.verb.length + v.args.length) continue;
    if (!v.verb.every((w, i) => s.rest[i] === w)) continue;
    const args = s.rest.slice(v.verb.length);
    if (args.some((a) => a.startsWith('-') && !OPTION_TOKENS.has(a))) return false;
    if (args.every((a, i) => v.args[i]?.(a) ?? false)) return true;
  }
  return false;
}

/** The kinds of local steps that are not held items (DESIGN "approvals.ts" steps list). */
export const LOCAL_STEP_KINDS = [
  'devops.grant',
  'repo.scripts',
  'formatter.pin',
  'passkey.trust',
  'setup',
  'signing.key',
  'extras.ytdlp',
  'devops.install',
] as const;
export type LocalStepKind = (typeof LOCAL_STEP_KINDS)[number];

/**
 * One plain sentence per step kind (and for held items), shown above the command. Written for non-developers: what it
 * allows, and that it is typed on the workstation.
 */
export const LOCAL_STEP_TEXT: Readonly<Record<LocalStepKind | 'held', string>> = {
  held: 'This waits for your yes on the workstation. Paste the command there; it shows exactly what will run and asks you once more.',
  'devops.grant':
    'This lets the DevOps helper of this organisation install tools and run commands on the workstation, outside the safety box.',
  'repo.scripts':
    'This lets this code project run its own install scripts on the workstation. They run outside the safety box.',
  'formatter.pin': 'This approves the release formatting settings of this project on the workstation.',
  'passkey.trust':
    'This lets your passkey approve routine items from the website, after you trust it once on the workstation.',
  setup: 'The workstation has not finished its first-time questions. Run this once on the workstation.',
  'signing.key':
    'This registers your release signing key on the workstation. Replace <key-file> with the path of the key file.',
  'extras.ytdlp': 'This installs the video transcript tool (yt-dlp) in the runner’s own folder.',
  'devops.install':
    'This lets the DevOps helpers install the tools your projects need, in the runner’s own folder. It turns on “Install packages and tools” for this workstation.',
};

/** The sentence for a held item or a step kind (unknown kinds get the held sentence). */
export function localStepText(kind: string): string {
  return (LOCAL_STEP_TEXT as Record<string, string>)[kind] ?? LOCAL_STEP_TEXT.held;
}
