#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CONNECTABLE_FORGES,
  type ConnectableForge,
  devcontainerText,
  FORGE_LABELS,
  INTEGRATION_STATE_LABELS,
  RunnerPairRequestSchema,
  RunnerPairResponseSchema,
} from '@aom/shared';
import { Command } from 'commander';
import { execa } from 'execa';
import { sandboxDoctorLines, sandboxState } from './adapters/claude-policy.ts';
import { loadConfig, type RunnerConfig, RunnerConfigSchema, saveConfig } from './config.ts';
import { toWsUrl, UNPAIRED_MESSAGE } from './connection/client.ts';
import { requestRotatedToken } from './connection/rotate.ts';
import { JiraCredentialStore, jiraFile } from './external/jira-store.ts';
import { connectSteps, describeConnection, sshUploadHelp, touchRecheck } from './forge/connect.ts';
import { AzureDevOpsForge, defaultHost, FileTokenStore, gitConnections } from './forge/index.ts';
import { runSshAction, SshSettingsStore } from './forge/ssh.ts';
import { gitVersion } from './git/git.ts';
import { scanRepos } from './git/repo-scan.ts';
import { installErrorHandlers } from './health/runner-error.ts';
import { RunnerHost } from './host.ts';
import { ClaudeCredentialStore, claudeFile } from './integrations/claude-store.ts';
import { headlessAdapters, headlessEnv } from './integrations/headless.ts';
import { JiraIntegration } from './integrations/jira.ts';
import { isFailure, type Outcome } from './integrations/types.ts';
import { createLogger } from './log.ts';
import { changeOrgFolder, ORG_ID_RE } from './org-folder.ts';
import {
  addPairing,
  entryConfigPath,
  entryDir,
  findPairing,
  isMachinePrimary,
  loadIndex,
  type PairingEntry,
  removePairing,
  saveIndex,
} from './pairings.ts';
import { resolveDataDir, runnerPaths } from './paths.ts';
import { RunnerKeys } from './secrets/keys.ts';
import { detectStacks, viewOf } from './toolchain/detect.ts';
import { realExecutor } from './toolchain/exec.ts';
import { preparePairing } from './up.ts';
import { detectServiceMode, scheduleRestart } from './update/apply.ts';
import { detectLayout } from './update/layout.ts';
import { Updater } from './update/updater.ts';
import { RUNNER_VERSION } from './version.ts';

const dataDirOpt = [
  '--data-dir <path>',
  'runner data directory (default: $AOM_RUNNER_HOME or ~/.aom-runner)',
] as const;
const mockEnabled = (flag?: boolean) => flag === true || process.env.AOM_RUNNER_MOCK === '1';

const pairingOpt = [
  '--pairing <id|name>',
  'which pairing of this machine (see `aom-runner pairings`); default: the first, or all for `repos add`',
] as const;

/** The pairings a command works on: the one named by --pairing, else all of them. */
function selectPairings(opts: { dataDir?: string; pairing?: string }): {
  root: string;
  entries: PairingEntry[];
} {
  const root = resolveDataDir(opts.dataDir);
  const index = loadIndex(root);
  if (index.pairings.length === 0)
    throw new Error(`No runner config at ${runnerPaths(root).config}. Run \`aom-runner pair\` first.`);
  return { root, entries: opts.pairing ? [findPairing(index, opts.pairing)] : index.pairings };
}

/** The data directory of the one pairing a command works on (--pairing, else the first). */
function pairingPaths(opts: { dataDir?: string; pairing?: string }) {
  const { root, entries } = selectPairings(opts);
  const first = entries[0] as PairingEntry;
  return runnerPaths(entryDir(root, first));
}

async function pair(opts: {
  server: string;
  code: string;
  name?: string;
  dataDir?: string;
  mock?: boolean;
}): Promise<void> {
  const root = resolveDataDir(opts.dataDir);
  const name = opts.name ?? hostname();
  const body = RunnerPairRequestSchema.parse({
    code: opts.code,
    name,
    platform: platform(),
    hostname: hostname(),
    runnerVersion: RUNNER_VERSION,
  });
  const url = new URL('/api/runner/pair', opts.server).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`pairing failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  const paired = RunnerPairResponseSchema.parse(await res.json());
  const r = addPairing(root, {
    serverUrl: opts.server,
    label: name,
    workstationId: paired.workstationId,
    runnerToken: paired.runnerToken,
    mock: mockEnabled(opts.mock),
  });
  console.log(
    `Paired as workstation ${paired.workstationId}. Config written to ${r.configPath} (mode 0600).`,
  );
  if (r.count > 1)
    console.log(
      `${r.replaced ? 'Replaced the earlier pairing for' : 'Added next to the existing pairings:'} ${r.entry.id} (${r.count} pairing${r.count === 1 ? '' : 's'} on this machine; the others are untouched). A running runner starts it within a few seconds.`,
    );
  console.log('Next: `aom-runner repos add <path>` for your code folders, then `aom-runner start`.');
}

/** Pair if needed (idempotent), then run. For servers and containers nobody sits at. */
async function up(opts: {
  server?: string;
  code?: string;
  name?: string;
  dataDir?: string;
  mock?: boolean;
}): Promise<void> {
  const r = await preparePairing(opts);
  console.log(
    r.paired === 'already'
      ? `Already paired (workstation ${r.workstationId}); starting.`
      : `Paired as workstation ${r.workstationId} (${r.paired}); starting.`,
  );
  if (r.authApplied)
    console.log(`Claude credential from the environment stored in this machine's config (${r.authApplied}).`);
  await start(opts);
}

/** Stores the customer's own Claude credential (read from stdin so it never lands in shell history). */
async function authSet(
  kind: 'api-key' | 'oauth-token',
  opts: { dataDir?: string; pairing?: string },
): Promise<void> {
  let value = '';
  for await (const chunk of process.stdin) value += String(chunk);
  value = value.trim();
  if (!value)
    throw new Error(`Pipe the ${kind} in: \`read -rs K; printf %s "$K" | aom-runner auth ${kind}\``);
  const { root, entries } = selectPairings(opts);
  for (const e of entries) {
    // secrets/claude.json (mode 0600): a running runner reads it at the next session start, so no restart is needed
    const store = new ClaudeCredentialStore(claudeFile(runnerPaths(entryDir(root, e)).secrets));
    store.save(
      kind === 'api-key'
        ? { authMode: 'api_key', apiKey: value, via: 'cli', method: 'api_key' }
        : { authMode: 'oauth', oauthToken: value, via: 'cli', method: 'oauth_token' },
    );
    touchRecheck(runnerPaths(entryDir(root, e)).secrets);
  }
  console.log(
    'Saved on this machine only (mode 0600, secrets/claude.json). A running runner uses it from the next session; no restart is needed.',
  );
}

/** Prints a devcontainer.json for a repository, from the toolchain detection. */
function devcontainer(path: string | undefined, opts: { server: string; name?: string }): void {
  const dir = resolve(path ?? '.');
  const stacks = detectStacks(viewOf(dir)).map((d) => ({ id: d.id, params: d.params }));
  process.stdout.write(
    devcontainerText({ name: opts.name ?? 'Guildwise workstation', serverUrl: opts.server, stacks }),
  );
}

async function start(opts: { dataDir?: string; mock?: boolean }): Promise<void> {
  const paths = runnerPaths(resolveDataDir(opts.dataDir));
  const log = createLogger(paths.runnerLog);
  const override = process.env.AOM_RUNNER_MAX_SHIFT_MS
    ? Number(process.env.AOM_RUNNER_MAX_SHIFT_MS)
    : undefined;
  const mock = mockEnabled(opts.mock);
  let updater: Updater | undefined;
  let finish: (code: number) => void = () => undefined;
  const layout = mock ? null : detectLayout(process.argv[1]);
  const serviceMode = layout ? detectServiceMode(layout) : null;
  /** The safe-mode pin the server sent before the updater existed (welcome comes first). */
  let pendingPin: string | null = null;
  const host = new RunnerHost({
    root: paths.root,
    log,
    mock,
    maxShiftMsOverride: override,
    // `aom runner restart` (after the reply was acknowledged): only where something starts the runner again.
    requestRestart: () => {
      if (!layout || !serviceMode) {
        log.warn(
          'a restart was requested, but nothing here would start the runner again (no service): ignored',
        );
        return;
      }
      log.info('restarting as asked from a conversation');
      scheduleRestart(layout, serviceMode);
      finish(0);
    },
    onConnected: () => updater?.noteConnected(),
    onRunnerPin: (v) => {
      pendingPin = v;
      updater?.setPin(v);
    },
  });
  // Unhandled errors go to the server (sanitised) so the platform team can see them; see health/runner-error.ts.
  const removeErrorHandlers = installErrorHandlers({
    report: (e) => host.reportError(e),
    version: RUNNER_VERSION,
    log,
  });
  await host.start();
  log.info(
    `aom-runner ${RUNNER_VERSION} started (${host.running.size} pairing(s): ${[...host.running.keys()].join(', ')})`,
  );

  const ended = new Promise<number>((done) => {
    finish = done;
  });
  // Self-update (docs/RUNNER.md "Updates"): never with the mock runtime (tests, demos) or with no pairing to ask.
  if (!mock && host.running.size > 0) {
    updater = new Updater({
      layout,
      version: RUNNER_VERSION,
      serverUrl: () => host.serverUrl(),
      isIdle: () => host.isIdle(),
      restart: () => {
        log.info('restarting to finish the update');
        finish(0);
      },
      report: (s) => host.setUpdateStatus(s),
      log,
      mode: serviceMode,
      disabled: process.env.AOM_RUNNER_AUTO_UPDATE === '0',
    });
    host.setUpdateStatus(updater.current);
    updater.start();
    if (pendingPin) updater.setPin(pendingPin);
  }
  process.once('SIGINT', () => {
    log.info('SIGINT received, shutting down');
    finish(0);
  });
  process.once('SIGTERM', () => {
    log.info('SIGTERM received, shutting down');
    finish(0);
  });
  void host.fatal.then(finish);
  const code = await ended;
  updater?.stop();
  removeErrorHandlers();
  await host.stop();
  if (host.unpaired) console.log(`aom-runner: ${UNPAIRED_MESSAGE}`);
  process.exit(code);
}

function printStatus(root: string, entry: PairingEntry, heading: boolean): void {
  const paths = runnerPaths(entryDir(root, entry));
  const config = loadConfig(entryConfigPath(root, entry));
  if (heading)
    console.log(
      `pairing:      ${entry.id} (${entry.label})${entry.disabled ? `, ${entry.disabled} by the server` : ''}`,
    );
  console.log(`data dir:     ${paths.root}`);
  console.log(`server:       ${config.serverUrl}`);
  console.log(`workstation:  ${config.workstationId}`);
  console.log(`repo roots:   ${config.repoRoots.join(', ') || '(none; use `aom-runner repos add <path>`)'}`);
  console.log(`mock runtime: ${config.runtimes.mock?.enabled ? 'enabled' : 'disabled'}`);
  if (existsSync(paths.status)) {
    const s = JSON.parse(readFileSync(paths.status, 'utf8')) as {
      pid: number;
      connected: boolean;
      updatedAt: string;
      activeShifts: number;
      outboxPending: number;
    };
    let alive = false;
    try {
      process.kill(s.pid, 0);
      alive = true;
    } catch {
      // not running
    }
    console.log(
      alive
        ? `process:      running (pid ${s.pid}), ${s.connected ? 'connected' : 'not connected'}, ${s.activeShifts} active shifts, ${s.outboxPending} outbox entries`
        : 'process:      not running',
    );
  } else console.log('process:      not running');
}

function status(opts: { dataDir?: string; pairing?: string }): void {
  const { root, entries } = selectPairings(opts);
  entries.forEach((e, i) => {
    if (i > 0) console.log('');
    printStatus(root, e, entries.length > 1 || !!opts.pairing);
  });
}

/** One line per pairing: id, name, server, workstation, state. */
function pairingsList(opts: { dataDir?: string }): void {
  const root = resolveDataDir(opts.dataDir);
  const index = loadIndex(root);
  if (index.pairings.length === 0) {
    console.log('Not paired. Pair with `aom-runner pair --server <url> --code <code>`.');
    return;
  }
  for (const e of index.pairings) {
    const paths = runnerPaths(entryDir(root, e));
    let state = e.disabled ? `${e.disabled} by the server` : 'not running';
    if (!e.disabled && existsSync(paths.status)) {
      try {
        const s = JSON.parse(readFileSync(paths.status, 'utf8')) as { pid: number; connected: boolean };
        process.kill(s.pid, 0);
        state = s.connected ? 'running, connected' : 'running, not connected';
      } catch {
        // stays "not running"
      }
    }
    console.log(`${e.id}\t${e.label}\t${e.serverUrl}\t${e.workstationId}\t${state}\t${entryDir(root, e)}`);
  }
}

function unpair(selector: string, opts: { dataDir?: string; purge?: boolean }): void {
  const root = resolveDataDir(opts.dataDir);
  const e = removePairing(root, selector, opts.purge === true);
  console.log(
    `Forgot pairing ${e.id} (${e.label}) on this machine. A running runner stops it within a few seconds. ` +
      `The workstation stays listed on ${e.serverUrl} until you unlink it in the web app.` +
      (opts.purge
        ? ' Its data was deleted.'
        : ` Its data stays in ${entryDir(root, e)} (use --purge to delete it).`),
  );
}

async function doctor(opts: { dataDir?: string; pairing?: string }): Promise<void> {
  const root = resolveDataDir(opts.dataDir);
  let paths = runnerPaths(root);
  let others: PairingEntry[] = [];
  try {
    const sel = selectPairings(opts);
    paths = runnerPaths(entryDir(sel.root, sel.entries[0] as PairingEntry));
    others = sel.entries.slice(1);
  } catch {
    // not paired: the config check below reports it
  }
  let failed = false;
  const line = (ok: boolean | 'warn', name: string, detail: string) => {
    if (ok === false) failed = true;
    console.log(`${ok === true ? 'ok  ' : ok === 'warn' ? 'warn' : 'FAIL'}  ${name}: ${detail}`);
  };
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  line(nodeMajor >= 22, 'node', process.version);
  const g = await gitVersion();
  line(
    !!g && (g.major > 2 || (g.major === 2 && g.minor >= 40)),
    'git',
    g ? `${g.raw} (need >= 2.40)` : 'not found',
  );

  let config: RunnerConfig | undefined;
  try {
    config = loadConfig(paths.config);
    line(true, 'config', paths.config);
  } catch (err) {
    line(false, 'config', err instanceof Error ? err.message : String(err));
  }
  const claudeBin = config?.runtimes['claude-code'].bin ?? 'claude';
  const c = await execa(claudeBin, ['--version'], { reject: false, stdin: 'ignore', timeout: 10_000 }).catch(
    () => undefined,
  );
  line(
    c && c.exitCode === 0 ? true : 'warn',
    'claude',
    c && c.exitCode === 0
      ? String(c.stdout).trim()
      : `\`${claudeBin}\` not found (only needed for the claude-code runtime)`,
  );
  const sbCfg = config?.runtimes['claude-code'] ?? RunnerConfigSchema.shape.runtimes.parse({})['claude-code'];
  for (const l of sandboxDoctorLines(sandboxState(sbCfg), platform())) line(l.ok, l.name, l.detail);
  const d = await execa('docker', ['--version'], { reject: false, stdin: 'ignore', timeout: 10_000 }).catch(
    () => undefined,
  );
  line(
    d && d.exitCode === 0 ? true : 'warn',
    'docker',
    d && d.exitCode === 0 ? String(d.stdout).trim() : 'not found (optional)',
  );
  const y = await execa('yt-dlp', ['--version'], { reject: false, stdin: 'ignore', timeout: 10_000 }).catch(
    () => undefined,
  );
  line(
    y && y.exitCode === 0 ? true : 'warn',
    'yt-dlp',
    y && y.exitCode === 0
      ? String(y.stdout).trim()
      : 'not found (optional: `aom transcript` needs it for YouTube and other video sites; ask DevOps to install it)',
  );
  // The key the sudo password is encrypted with: compare this id with the one shown on the Workstations page.
  try {
    const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
    line(
      true,
      'sudo key',
      `${keys.publicKey.keyId} (the Workstations page shows the same id next to the sudo password; password ${existsSync(join(paths.secrets, 'sudo.enc')) ? 'stored' : 'not stored'})`,
    );
  } catch (err) {
    line('warn', 'sudo key', err instanceof Error ? err.message : String(err));
  }
  if (config) {
    const repos = await scanRepos(config.repoRoots);
    line(
      repos.length > 0 ? true : 'warn',
      'repos',
      `${repos.length} found under ${config.repoRoots.length} root(s)`,
    );
    try {
      const res = await fetch(new URL('/api/health', config.serverUrl), {
        signal: AbortSignal.timeout(8000),
      });
      line(res.ok, 'server', `${config.serverUrl} /api/health -> HTTP ${res.status}`);
    } catch (err) {
      line(
        false,
        'server',
        `${config.serverUrl} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const o of others) {
      const oc = (() => {
        try {
          return loadConfig(entryConfigPath(root, o));
        } catch {
          return undefined;
        }
      })();
      if (!oc) {
        line(false, `pairing ${o.id}`, `no readable config in ${entryDir(root, o)}`);
        continue;
      }
      try {
        const res = await fetch(new URL('/api/health', oc.serverUrl), { signal: AbortSignal.timeout(8000) });
        line(
          res.ok,
          `server (${o.label})`,
          `${oc.serverUrl} /api/health -> HTTP ${res.status}${o.disabled ? `; ${o.disabled} by the server` : ''}`,
        );
      } catch (err) {
        line(
          false,
          `server (${o.label})`,
          `${oc.serverUrl} unreachable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  if (failed) process.exitCode = 1;
}

function runnerAlive(statusFile: string): boolean {
  if (!existsSync(statusFile)) return false;
  try {
    process.kill((JSON.parse(readFileSync(statusFile, 'utf8')) as { pid: number }).pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Replaces the runner token. The runner must be stopped: a second connection would supersede the running one. */
async function rotateToken(opts: { dataDir?: string; pairing?: string }): Promise<void> {
  const { root, entries } = selectPairings(opts);
  if (entries.length > 1)
    throw new Error('this machine has several pairings: name one with --pairing <id|name>');
  const entry = entries[0] as PairingEntry;
  const paths = runnerPaths(entryDir(root, entry));
  const config = loadConfig(paths.config);
  if (runnerAlive(paths.status))
    throw new Error(
      'the runner is running: stop it first (`aom-runner rotate-token` replaces its credentials)',
    );
  const token = await requestRotatedToken({ url: toWsUrl(config.serverUrl), token: config.runnerToken });
  saveConfig(paths.config, { ...config, runnerToken: token });
  console.log(
    `Runner token rotated. The new token is stored in ${paths.config} (mode 0600); start the runner again.`,
  );
}

/** Code folders are machine-level: without --pairing a folder is added to every pairing. */
function reposAdd(path: string, opts: { dataDir?: string; pairing?: string }): void {
  const { root, entries } = selectPairings(opts);
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`${abs} does not exist`);
  for (const e of entries) {
    const file = entryConfigPath(root, e);
    const config = loadConfig(file);
    if (!config.repoRoots.includes(abs)) config.repoRoots.push(abs);
    saveConfig(file, config);
  }
  console.log(`Added ${abs}. Restart is not needed: repos are re-scanned on connect and every 10 minutes.`);
}

/**
 * `aom-runner org-folder set <organization-id> <path>`: the architect of that organization may read every
 * repository under the folder (read-only, secret files blocked). The folder must sit inside one of the repo roots. The
 * rules are the ones the app's "Organisation source folder" control uses (`org-folder.ts`).
 */
function orgFolderSet(orgId: string, path: string, opts: { dataDir?: string; pairing?: string }): void {
  if (!ORG_ID_RE.test(orgId)) throw new Error(`'${orgId}' is not an organization id (a UUID)`);
  const { root, entries } = selectPairings(opts);
  for (const e of entries) {
    const file = entryConfigPath(root, e);
    const changed = changeOrgFolder(loadConfig(file), orgId, path, root);
    if (!changed.ok) throw new Error(changed.error);
    saveConfig(file, changed.config);
    console.log(
      `Organization ${orgId}: ${changed.path} (read-only for its architect). Restart the runner to apply.`,
    );
  }
}

function orgFolderClear(orgId: string, opts: { dataDir?: string; pairing?: string }): void {
  const { root, entries } = selectPairings(opts);
  for (const e of entries) {
    const file = entryConfigPath(root, e);
    const changed = changeOrgFolder(loadConfig(file), orgId, null, root);
    if (changed.ok) saveConfig(file, changed.config);
  }
  console.log(`Organization ${orgId}: source folder cleared. Restart the runner to apply.`);
}

function orgFolderList(opts: { dataDir?: string; pairing?: string }): void {
  const config = loadConfig(pairingPaths(opts).config);
  const list = Object.entries(config.orgSourceFolders);
  if (list.length === 0)
    console.log(
      'No organization source folder is set. Use `aom-runner org-folder set <organization-id> <path>`.',
    );
  for (const [org, folder] of list) console.log(`${org}\t${folder}`);
}

async function reposList(opts: { dataDir?: string; pairing?: string }): Promise<void> {
  const config = loadConfig(pairingPaths(opts).config);
  const repos = await scanRepos(config.repoRoots);
  if (repos.length === 0)
    console.log('No repositories found. Add a folder with `aom-runner repos add <path>`.');
  for (const r of repos) console.log(`${r.localPath}\t${r.remoteUrl}\t${r.headBranch ?? '(detached)'}`);
}

/** Reads one line from the terminal without echoing it (a token); from a pipe when stdin is not a terminal. */
async function promptSecret(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const out = process.stdout;
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) return line.trim();
    return '';
  }
  out.write(question);
  return new Promise((done) => {
    let buf = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          out.write('\n');
          done(buf.trim());
          return;
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function promptLine(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

interface JiraConnectOpts {
  dataDir?: string;
  pairing?: string;
  baseUrl?: string;
  email?: string;
  status?: boolean;
  disconnect?: boolean;
}

/**
 * `aom-runner jira-connect`: saves this workstation's Jira credentials for downloading ticket attachments and posting
 * approved updates. Asks for the base URL, your e-mail and an API token (hidden; or piped on stdin), checks them against
 * Jira and stores them in `secrets/jira.json` (mode 0600), never in config.json. The token is never shown to an agent
 * and never sent to the server (it only learns "connected / not connected / refused").
 */
async function jiraConnect(opts: JiraConnectOpts): Promise<void> {
  const { root, entries } = selectPairings(opts);
  // The same adapter the Integrations page uses: one path, one set of checks, one place the credentials are stored.
  const targets = entries.map((e) => {
    const paths = runnerPaths(entryDir(root, e));
    return {
      paths,
      store: new JiraCredentialStore(jiraFile(paths.secrets)),
      config: loadConfig(entryConfigPath(root, e)),
      jira: new JiraIntegration(headlessEnv(paths)),
    };
  });
  const first = targets[0] as (typeof targets)[number];
  const done = () => {
    for (const t of targets) touchRecheck(t.paths.secrets);
    console.log('A running runner reports the new status to the server within a minute.');
  };
  const current = first.store.load() ?? first.config.jira;
  if (opts.disconnect) {
    for (const t of targets) t.store.remove();
    console.log(
      'Saved Jira credentials removed. (A "jira" block in config.json, if you still have one, is not touched.)',
    );
    return done();
  }
  if (opts.status) {
    const s = await first.jira.status();
    if (s.state === 'not_connected' && !current) {
      console.log('Jira: not connected. Run `aom-runner jira-connect`.');
      process.exitCode = 1;
      return;
    }
    console.log(
      s.state === 'connected'
        ? `Jira: connected to ${s.site}${s.account ? ` as ${s.account}` : ''}.`
        : `Jira: ${s.state === 'refused' ? 'refused' : 'not connected'}${s.detail ? ` (${s.detail})` : ''}.`,
    );
    process.exitCode = s.state === 'connected' ? 0 : 1;
    return;
  }
  console.log(
    'Connecting this workstation to Jira. Nothing leaves this machine except the calls to your Jira site.\n' +
      'Jira Cloud: create an API token at https://id.atlassian.com/manage-profile/security/api-tokens and use your Atlassian e-mail.\n' +
      'Jira Data Center: leave the e-mail empty and use a personal access token.\n',
  );
  const askedUrl =
    opts.baseUrl ??
    (await promptLine(
      `Jira base URL${current ? ` [${current.baseUrl}]` : ' (https://yourcompany.atlassian.net)'}: `,
    ));
  const baseUrl = askedUrl || current?.baseUrl || '';
  const askedMail =
    opts.email ??
    (await promptLine(
      `E-mail address${current?.email ? ` [${current.email}]` : ' (empty for a Data Center token)'}: `,
    ));
  const mail = (askedMail || (opts.email === undefined ? current?.email : '') || '').trim();
  const token = await promptSecret('API token (hidden): ');
  if (!token) throw new Error('an API token is required');
  let result: Awaited<ReturnType<JiraIntegration['connect']>> | undefined;
  for (const t of targets) {
    result = await t.jira.connect('', 'token', { baseUrl, email: mail, token });
    if (isFailure(result)) break;
  }
  if (!result || isFailure(result)) {
    console.error(result?.error ?? 'Jira did not accept these credentials. Nothing was saved.');
    process.exitCode = 1;
    return;
  }
  console.log(
    `Connected to ${result.site}${result.account ? ` as ${result.account}` : ''}. Saved on this machine only (mode 0600).`,
  );
  done();
}

interface GitConnectOpts {
  dataDir?: string;
  pairing?: string;
  host?: string;
  user?: string;
  organization?: string;
  sshKey?: boolean;
  ssh?: boolean;
  keyFile?: string;
  agent?: boolean;
  default?: string;
  check?: string | boolean;
  status?: boolean;
  disconnect?: boolean;
}

/**
 * `aom-runner git-connect <provider>`: sets up (or checks) this workstation's login to a git host. Credentials stay on
 * this machine: `gh`/`glab` hold their own logins, tokens go to secrets/git-tokens.json (mode 0600). The server only
 * ever learns "connected / not connected" (`git.report`).
 */
async function gitConnect(providerArg: string, opts: GitConnectOpts): Promise<void> {
  if (!(CONNECTABLE_FORGES as readonly string[]).includes(providerArg))
    throw new Error(`unknown provider "${providerArg}": use one of ${CONNECTABLE_FORGES.join(', ')}`);
  const provider = providerArg as ConnectableForge;
  const host = opts.host ?? defaultHost(provider);
  const { root, entries } = selectPairings(opts);
  const stores = entries.map((e) => {
    const paths = runnerPaths(entryDir(root, e));
    return { paths, store: new FileTokenStore(`${paths.secrets}/git-tokens.json`) };
  });
  const first = stores[0] as (typeof stores)[number];
  const env = { exec: realExecutor, fetch, tokens: first.store };
  const show = async () => {
    for (const c of (await gitConnections(env, { [provider]: [host] })).filter(
      (c) => c.provider === provider,
    ))
      console.log(describeConnection(c));
  };
  const done = () => {
    for (const s of stores) touchRecheck(s.paths.secrets);
    console.log('A running runner reports the new status to the server within a minute.');
  };
  if (opts.disconnect) {
    for (const s of stores) s.store.remove(provider, host);
    console.log(
      'Saved token removed. (Logins held by gh or glab are removed with `gh auth logout` / `glab auth logout`.)',
    );
    return done();
  }
  if (opts.status) return show();

  if (opts.ssh || opts.sshKey || opts.check !== undefined || opts.keyFile || opts.agent || opts.default) {
    process.exitCode = await gitConnectSsh(provider, host, opts, stores, done);
    return;
  }

  console.log(`Connecting this workstation to ${provider} (${host}). Nothing leaves this machine.\n`);
  for (const l of connectSteps(provider, host)) console.log(l);
  console.log('');
  if (provider === 'github') {
    const r = await realExecutor.run('gh', ['--version']);
    if (r.exitCode === 127) throw new Error('the GitHub CLI (gh) is not installed: https://cli.github.com');
    const { execa: ex } = await import('execa');
    await ex('gh', ['auth', 'login', '--web', '--hostname', host, '--git-protocol', 'https'], {
      stdio: 'inherit',
      reject: false,
    });
    await ex('gh', ['auth', 'setup-git', '--hostname', host], { stdio: 'inherit', reject: false });
    await show();
    return done();
  }
  if (provider === 'gitlab') {
    const g = await realExecutor.run('glab', ['--version']);
    if (g.exitCode === 0) {
      const { execa: ex } = await import('execa');
      await ex('glab', ['auth', 'login', '--hostname', host], { stdio: 'inherit', reject: false });
      await show();
      return done();
    }
  }
  if (provider === 'azure-devops' && !opts.organization) {
    const sp = await new AzureDevOpsForge({ ...env, processEnv: process.env }, host).status();
    if (sp.state === 'connected' && sp.method === 'service-principal') {
      console.log(
        'A Microsoft Entra service principal is set in the environment (AZURE_TENANT_ID, AZURE_CLIENT_ID, ...); using it.',
      );
      console.log(describeConnection(sp));
      return done();
    }
    const az = await realExecutor.run('az', ['account', 'show', '--query', 'user.name', '-o', 'tsv']);
    if (az.exitCode === 0) {
      console.log(`Signed in to the Azure CLI as ${az.stdout.trim()}; using that sign-in.`);
      await show();
      return done();
    }
  }
  let user = opts.user;
  if (provider === 'bitbucket-cloud' && !user) user = await promptLine('Atlassian e-mail address: ');
  let organization = opts.organization;
  if (provider === 'azure-devops' && !organization)
    organization = await promptLine('Azure DevOps organization: ');
  const token = await promptSecret('Paste the token (it is not shown): ');
  if (!token) throw new Error('no token entered');
  // The adapters the Integrations page uses: one path, one set of checks.
  const instance =
    provider === 'azure-devops' ? (organization ?? '') : provider === 'bitbucket-cloud' ? '' : host;
  let outcome: Outcome | undefined;
  for (const s of stores) {
    const { adapters } = headlessAdapters(s.paths);
    const adapter = adapters.get(provider);
    if (!adapter?.connect) throw new Error(`${provider} cannot be connected with a token here`);
    outcome = await adapter.connect(instance, 'token', {
      token,
      ...(user ? { email: user } : {}),
    });
    if (isFailure(outcome)) break;
  }
  if (!outcome || isFailure(outcome)) {
    const why = outcome && isFailure(outcome) ? outcome.error : '';
    console.error(`The token was not accepted${why ? `: ${why}` : ''}. Nothing was saved.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `${FORGE_LABELS[provider]} (${host}): connected${outcome.account ? ` as ${outcome.account}` : ''}`,
  );
  done();
}

/**
 * `aom-runner git-connect <provider> --ssh [--key-file <path> | --agent] [--default https|ssh] [--check [repo-url]]`:
 * SSH instead of an API token. Creates (or reuses) the key `~/.ssh/aom_<provider>` and prints the PUBLIC key with where
 * to add it, or records a key of your own / the ssh-agent; records ssh as this workstation's default for the host
 * (`--default https` keeps tokens as the default); `--check` verifies that ssh works and says why when it does not.
 * Returns the exit code.
 */
async function gitConnectSsh(
  provider: ConnectableForge,
  host: string,
  opts: GitConnectOpts,
  stores: Array<{ paths: ReturnType<typeof runnerPaths> }>,
  done: () => void,
): Promise<number> {
  const envs = stores.map((s) => ({
    settings: new SshSettingsStore(`${s.paths.secrets}/git-ssh.json`),
    knownHosts: `${s.paths.secrets}/known_hosts`,
  }));
  const first = envs[0] as (typeof envs)[number];
  const checking = opts.check !== undefined && !opts.ssh && !opts.sshKey && !opts.keyFile && !opts.agent;
  let code = 0;
  if (!checking) {
    const defaultMethod =
      opts.default === 'https'
        ? 'https'
        : opts.default === 'ssh' || opts.ssh || opts.sshKey
          ? 'ssh'
          : undefined;
    if (opts.default && opts.default !== 'https' && opts.default !== 'ssh')
      throw new Error('--default is https or ssh');
    const key = opts.agent ? 'agent' : opts.keyFile ? 'path' : 'generated';
    for (const e of envs) {
      const r = await runSshAction(realExecutor, e, {
        provider,
        host,
        action: key === 'generated' ? 'prepare' : 'save',
        key,
        ...(opts.keyFile ? { keyPath: opts.keyFile } : {}),
        ...(defaultMethod ? { defaultMethod } : {}),
      });
      if (e !== first) continue;
      if (key === 'generated')
        console.log(
          `${r.detail}. Add this public key to your ${FORGE_LABELS[provider]} account:\n\n${r.publicKey}\n\n${sshUploadHelp(provider, host)}`,
        );
      else
        console.log(
          key === 'agent'
            ? 'Using your ssh-agent (SSH_AUTH_SOCK) for this host.'
            : `Using the key ${opts.keyFile}.`,
        );
    }
    if (defaultMethod)
      console.log(
        `\nNew repositories on ${host} are cloned over ${defaultMethod === 'ssh' ? 'SSH' : 'https'} on this workstation. A repository can override this in its project settings.`,
      );
    console.log(
      'SSH covers git (clone, fetch, push). Pull requests, branch rules and the repository list still need the API token or CLI login (aom-runner git-connect ' +
        provider +
        ').',
    );
  }
  if (opts.check !== undefined || opts.ssh || opts.sshKey) {
    if (!checking) console.log('\nChecking ssh ...');
    for (const e of envs) {
      const r = await runSshAction(realExecutor, e, {
        provider,
        host,
        action: 'check',
        ...(typeof opts.check === 'string' ? { repoUrl: opts.check } : {}),
      });
      if (e === first) console.log(`${r.state === 'ok' ? 'OK' : `Not working (${r.state})`}: ${r.detail}`);
      if (r.state !== 'ok' && e === first) code = opts.check !== undefined ? 1 : 0;
    }
  }
  done();
  return code;
}

/** `aom-runner integrations`: every integration of this workstation, as the Integrations page shows them. */
async function integrationsList(opts: { dataDir?: string; pairing?: string }): Promise<void> {
  const { root, entries } = selectPairings(opts);
  const index = loadIndex(root);
  for (const e of entries) {
    const paths = runnerPaths(entryDir(root, e));
    const config = loadConfig(entryConfigPath(root, e));
    console.log(
      `${entries.length > 1 ? `${e.id}: ` : ''}web connect ${config.integrations.allowWeb ? 'on' : 'OFF'}; machine-wide logins from the web: ${
        config.integrations.machineScopeFromWeb === 'never'
          ? 'never'
          : isMachinePrimary(index, e)
            ? 'allowed (primary pairing)'
            : 'not allowed (not the primary pairing)'
      }`,
    );
    const { adapters } = headlessAdapters(paths);
    for (const a of adapters.values()) {
      for (const i of await a.instances()) {
        const st = await a.status(i);
        console.log(
          `  ${a.kind}${i ? ` ${i}` : ''}: ${INTEGRATION_STATE_LABELS[st.state]}${st.account ? ` as ${st.account}` : ''}${st.method ? ` (${st.method})` : ''}${st.detail ? `. ${st.detail}` : ''}`,
        );
      }
    }
  }
}

/** `aom-runner integrations allow-web on|off`: the local switch for credentials and sign-ins submitted from the web. */
function integrationsAllowWeb(value: string, opts: { dataDir?: string; pairing?: string }): void {
  if (value !== 'on' && value !== 'off') throw new Error('use: aom-runner integrations allow-web on|off');
  const { root, entries } = selectPairings(opts);
  for (const e of entries) {
    const file = entryConfigPath(root, e);
    const config = loadConfig(file);
    saveConfig(file, { ...config, integrations: { ...config.integrations, allowWeb: value === 'on' } });
    touchRecheck(runnerPaths(entryDir(root, e)).secrets);
  }
  console.log(
    value === 'on'
      ? 'Credentials and sign-ins submitted from the web are accepted on this workstation.'
      : 'Credentials and sign-ins submitted from the web are now refused on this workstation. Use the terminal commands instead.',
  );
}

/** `aom-runner ceo full-power on|off|status`: the local switch for the CEO's full-power turns (the Owner's own Claude Code). */
function ceoFullPower(value: string, opts: { dataDir?: string; pairing?: string }): void {
  if (value !== 'on' && value !== 'off' && value !== 'status')
    throw new Error('use: aom-runner ceo full-power on|off|status');
  const { root, entries } = selectPairings(opts);
  for (const e of entries) {
    const file = entryConfigPath(root, e);
    const config = loadConfig(file);
    if (value !== 'status')
      saveConfig(file, { ...config, ceo: { ...config.ceo, fullPower: value === 'on' } });
    const now = value === 'status' ? config.ceo.fullPower : value === 'on';
    console.log(
      `${entries.length > 1 ? `${e.id}: ` : ''}CEO full power is ${now ? 'ON' : 'off'}${
        now
          ? ': the CEO chat with the Owner runs as your own Claude Code (your ~/.claude, your home directory, no sandbox).'
          : '.'
      }`,
    );
  }
  if (value !== 'status')
    console.log(
      'Restart the runner (`aom-runner start`, or restart its service) so the server learns the change; until then the old state is announced.',
    );
}

/** `aom-runner integrations machine-admin <pairing>`: which pairing may change machine-wide logins from the web. */
function integrationsMachineAdmin(selector: string, opts: { dataDir?: string }): void {
  const root = resolveDataDir(opts.dataDir);
  const index = loadIndex(root);
  const entry = findPairing(index, selector);
  saveIndex(root, { ...index, machineAdmin: entry.id });
  console.log(`${entry.id} may now change machine-wide logins (~/.claude, gh, MCP sign-ins) from the web.`);
}

export function buildProgram(): Command {
  const program = new Command('aom-runner').description('Guildwise HQ runner').version(RUNNER_VERSION);
  program
    .command('pair')
    .description(
      'pair this machine with a server using a code from the Workstations page; an already paired machine gets an additional pairing',
    )
    .requiredOption('--server <url>', 'server URL, e.g. https://aom.example.com')
    .requiredOption('--code <code>', 'pairing code XXXX-XXXX')
    .option('--name <name>', 'workstation name (default: hostname)')
    .option('--mock', 'enable the mock runtime (CI and development)')
    .option(...dataDirOpt)
    .action(pair);
  program
    .command('up')
    .description(
      'pair if this machine is not paired yet (GUILDWISE_PAIR_CODE, or a Codespace), then connect and run; safe to run at every boot',
    )
    .option('--server <url>', 'server URL (or GUILDWISE_SERVER)')
    .option('--code <code>', 'pairing code (or GUILDWISE_PAIR_CODE); ignored when already paired')
    .option('--name <name>', 'workstation name (or GUILDWISE_NAME; default: hostname)')
    .option('--mock', 'enable the mock runtime (CI and development)')
    .option(...dataDirOpt)
    .action(up);
  const auth = program
    .command('auth')
    .description('store your own Claude credential on this machine (the server never sees it)');
  for (const [name, text] of [
    ['api-key', 'your Anthropic API key (recommended for cloud workstations), read from stdin'],
    ['oauth-token', 'a subscription token from `claude setup-token` (individual use only), read from stdin'],
  ] as const)
    auth
      .command(name)
      .description(text)
      .option(...pairingOpt)
      .option(...dataDirOpt)
      .action((opts) => authSet(name, opts));
  program
    .command('devcontainer [path]')
    .description(
      'print a devcontainer.json for the repository at path (default .) from its detected toolchain',
    )
    .requiredOption('--server <url>', 'server URL, e.g. https://aom.example.com')
    .option('--name <name>', 'name for the dev container')
    .action(devcontainer);
  program
    .command('start')
    .description('connect to the server and run shifts (foreground)')
    .option('--mock', 'enable the mock runtime for this process (also AOM_RUNNER_MOCK=1)')
    .option(...dataDirOpt)
    .action(start);
  program
    .command('status')
    .description('show configuration and process state (of every pairing)')
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(status);
  program
    .command('doctor')
    .description('check git, node, claude, docker and server connectivity')
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(doctor);
  program
    .command('rotate-token')
    .description('replace the runner token with a freshly issued one (stop the runner first)')
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(rotateToken);
  program
    .command('pairings')
    .description('list the workstations this machine is paired with (one per account or organization)')
    .option(...dataDirOpt)
    .action(pairingsList);
  program
    .command('unpair <pairing>')
    .description('forget one pairing on this machine (id, name or workstation id); the others keep running')
    .option('--purge', "also delete that pairing's data directory (worktrees, clones, logs)")
    .option(...dataDirOpt)
    .action(unpair);
  program
    .command('git-connect <provider>')
    .description(
      `set up this workstation's login to a git host (${CONNECTABLE_FORGES.join(', ')}); the credential stays on this machine`,
    )
    .option('--host <host>', 'a self-managed host (GitHub Enterprise, GitLab)')
    .option('--user <email>', 'Bitbucket Cloud: your Atlassian e-mail address')
    .option('--organization <name>', 'Azure DevOps organization')
    .option(
      '--ssh',
      'use SSH instead of a token: create (or reuse) a key, print the public key to add, make SSH the default',
    )
    .option('--ssh-key', 'alias of --ssh')
    .option('--key-file <path>', 'with --ssh: use this private key file instead of generating one')
    .option('--agent', 'with --ssh: use your ssh-agent / ~/.ssh/config instead of a key file')
    .option('--default <method>', 'the default for new clones on this host: https or ssh')
    .option(
      '--check [repo-url]',
      'check that ssh works (git ls-remote on the repository when given, else ssh -T)',
    )
    .option('--status', 'only show whether it is connected')
    .option('--disconnect', 'remove the token saved by this command')
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(gitConnect);
  program
    .command('jira-connect')
    .description(
      "set up this workstation's Jira login (to download ticket attachments for agents and post approved updates); the API token stays on this machine",
    )
    .option('--base-url <url>', 'your Jira site, e.g. https://yourcompany.atlassian.net')
    .option('--email <address>', 'your Atlassian e-mail address (empty for a Data Center token)')
    .option('--status', 'only show whether it is connected')
    .option('--disconnect', 'remove the saved credentials')
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(jiraConnect);
  const integrations = program
    .command('integrations')
    .description(
      'the integrations of this workstation (what the Integrations page shows) and the local policy',
    );
  integrations
    .command('list', { isDefault: true })
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(integrationsList);
  integrations
    .command('allow-web <on|off>')
    .description('accept (on) or refuse (off) credentials and sign-ins submitted from the web app')
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(integrationsAllowWeb);
  integrations
    .command('machine-admin <pairing>')
    .description('the pairing that may change machine-wide logins (~/.claude, gh, MCP) from the web')
    .option(...dataDirOpt)
    .action(integrationsMachineAdmin);
  const ceo = program.command('ceo').description('the CEO on this workstation');
  ceo
    .command('full-power <on|off|status>')
    .description(
      "let the CEO's chat with the Owner run as your own Claude Code on this machine (on), refuse it (off), or show the state",
    )
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(ceoFullPower);
  program
    .command('graph-check <repo>')
    .description(
      'index a clone into a scratch folder and print the counts (checks the bundled parser and grammars; writes nothing to a vault)',
    )
    .option('--out <dir>', 'write the graph here instead of a temporary folder')
    .action(async (repo: string, opts: { out?: string }) => {
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { graphRepoKey } = await import('@aom/shared');
      const { indexRepository } = await import('./graph/indexer.ts');
      const out = opts.out ? resolve(opts.out) : mkdtempSync(join(tmpdir(), 'aom-graph-check-'));
      const r = await indexRepository({
        repoPath: resolve(repo),
        repoKey: graphRepoKey(resolve(repo)),
        repoName: 'check',
        graphDir: join(out, 'graph'),
        cacheDir: join(out, 'cache'),
        indexerVersion: RUNNER_VERSION,
      });
      console.log(
        `indexed ${r.files} files into ${r.nodes} nodes and ${r.edges} edges (${r.modules} modules) in ${r.durationMs} ms at ${r.commit.slice(0, 12)}; output in ${out}`,
      );
      if (r.parseFailures > 0) {
        console.error(`the parser failed on ${r.parseFailures} files: ${r.firstParseFailure}`);
        process.exitCode = 1;
      }
    });
  const repos = program.command('repos').description('manage the folders scanned for git repositories');
  repos
    .command('add <path>')
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(reposAdd);
  repos
    .command('list')
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(reposList);
  const orgFolder = program
    .command('org-folder')
    .description("the folder whose git repositories an organization's architect may read (read-only)");
  orgFolder
    .command('set <organization-id> <path>')
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(orgFolderSet);
  orgFolder
    .command('clear <organization-id>')
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(orgFolderClear);
  orgFolder
    .command('list')
    .option(...pairingOpt)
    .option(...dataDirOpt)
    .action(orgFolderList);
  return program;
}

// `pnpm run dev -- --data-dir x` forwards the literal `--`; drop it so the options still parse.
const argv = [...process.argv];
const dashdash = argv.indexOf('--');
if (dashdash > 1) argv.splice(dashdash, 1);

buildProgram()
  .parseAsync(argv)
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
