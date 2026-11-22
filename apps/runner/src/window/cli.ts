import { rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { policyDir } from '../policy/store.ts';
import { instanceOfUser } from '../setup/admin-command.ts';
import { audit } from './audit.ts';
import { DeviceStore, readPort, writePort } from './pairing.ts';
import { instanceLabel } from './server.ts';

/**
 * `guildwise-runner approvals ...` (DESIGN "Approvals window"): pairing a browser with this runner's approvals page,
 * listing and forgetting paired browsers, and moving the page to another port. Pairing and the port move need a person
 * at a terminal (stdin a TTY), run as the runner user, like `approve`.
 */

export interface ApprovalsCliDeps {
  /** The policy dir of this runner (per instance). */
  dir: string;
  /** The instance name the prompt names (`uat`, `prod`, `default`). */
  instance: string;
  out: (line: string) => void;
  /** Asks at the terminal. Absent when stdin is not a terminal: pairing and port moves are refused. */
  ask?: (question: string) => Promise<string>;
  now?: () => number;
}

export function defaultApprovalsCliDeps(): ApprovalsCliDeps {
  return {
    dir: policyDir(),
    instance: instanceLabel(instanceOfUser(userInfo().username)),
    out: (l) => console.log(l),
    ...(process.stdin.isTTY
      ? {
          ask: async (q: string) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              return await rl.question(q);
            } finally {
              rl.close();
            }
          },
        }
      : {}),
  };
}

const needTty = (d: ApprovalsCliDeps): ((q: string) => Promise<string>) => {
  if (!d.ask) throw new Error('this needs a person at a terminal (stdin must be a terminal)');
  return d.ask;
};

/** `approvals pair <code>`: shows the waiting browser and, after a typed yes, pairs it. */
export async function approvalsPair(d: ApprovalsCliDeps, code: string): Promise<void> {
  const ask = needTty(d);
  const devices = new DeviceStore(d.dir, d.now);
  const p = devices.findPending(code);
  if (!p)
    throw new Error(
      `no browser waits with code ${code}: open the approvals page again and use the code it shows (codes last 10 minutes)`,
    );
  // review S2: on macOS other local programs (agents included) can ask for a code too; this confirmation is the guard
  const ageSec = Math.max(0, Math.round(((d.now?.() ?? Date.now()) - p.createdAt) / 1000));
  const age = ageSec < 90 ? `${ageSec} seconds ago` : `${Math.round(ageSec / 60)} minutes ago`;
  d.out(`A browser asked to pair ${age}: fingerprint ${p.fingerprint}`);
  d.out(`The browser says it is: ${p.userAgent} (the asking program writes this itself; do not rely on it)`);
  d.out(
    'Only pair a code that your own browser page on this computer showed you. Never one that came from the website, an e-mail, a chat or an agent: that would let someone else change what this computer allows.',
  );
  const answer = await ask(
    `Did you click "Pair this browser" on this computer in the last few minutes, and does that page show fingerprint ${p.fingerprint}? If so, type "yes" to pair it with ${d.instance}: `,
  );
  if (answer.trim() !== 'yes') throw new Error('not paired');
  const dev = devices.confirmPending(p.code);
  audit(d.dir, null, { action: 'pair', target: `fingerprint ${dev.fingerprint}` }, d.now);
  d.out(`Paired. The page signs in by itself within a few seconds (fingerprint ${dev.fingerprint}).`);
}

/** `approvals devices`: the paired browsers. */
export function approvalsDevices(d: ApprovalsCliDeps): void {
  const list = new DeviceStore(d.dir, d.now).devices();
  const port = readPort(d.dir);
  d.out(port ? `Approvals page: http://127.0.0.1:${port}/` : 'The approvals page has not started yet.');
  if (!list.length) {
    d.out('No browser is paired with this runner.');
    return;
  }
  for (const x of list) d.out(`${x.fingerprint}  paired ${x.pairedAt}  ${x.userAgent}`);
}

/** `approvals forget <fingerprint>|--all`. */
export function approvalsForget(d: ApprovalsCliDeps, fingerprint: string | undefined, all: boolean): void {
  if (!all && !(fingerprint && /^[0-9a-f]{8}$/i.test(fingerprint)))
    throw new Error(
      'use: approvals forget <fingerprint> (8 characters, `approvals devices` shows them) or --all',
    );
  const gone = new DeviceStore(d.dir, d.now).forget(all ? 'all' : (fingerprint as string));
  if (!gone.length) throw new Error(`no paired browser has fingerprint ${fingerprint}`);
  for (const g of gone)
    audit(d.dir, null, { action: 'forget', target: `fingerprint ${g.fingerprint}` }, d.now);
  d.out(
    `Forgot ${gone.length} browser${gone.length === 1 ? '' : 's'}; ${gone.length === 1 ? 'it' : 'they'} must pair again.`,
  );
}

/**
 * `approvals port <new>` [R2-B1]: every paired browser is forgotten and an audit line written BEFORE the new port is
 * saved, so a key made under the old origin (which another program may now serve) never works on the moved page.
 */
export async function approvalsPort(d: ApprovalsCliDeps, value: string): Promise<void> {
  const ask = needTty(d);
  const port = Number(value);
  if (!/^\d{4,5}$/.test(value) || port < 1024 || port > 65535)
    throw new Error('use: approvals port <number between 1024 and 65535> (47600-47699 is the usual range)');
  const old = readPort(d.dir);
  if (old === port) {
    d.out(`The approvals page already uses port ${port}.`);
    return;
  }
  d.out(`Moving the approvals page from port ${old ?? '(none yet)'} to ${port}.`);
  d.out('Every paired browser is forgotten and must pair again.');
  if ((await ask('Move it? Type "yes": ')).trim() !== 'yes') throw new Error('not changed');
  const devices = new DeviceStore(d.dir, d.now);
  const gone = devices.devices().length;
  devices.writeDevices([]);
  rmSync(devices.pendingDir, { recursive: true, force: true });
  audit(
    d.dir,
    null,
    {
      action: 'port',
      target: `port ${port}`,
      before: { port: old, devices: gone },
      after: { port, devices: 0 },
    },
    d.now,
  );
  writePort(d.dir, port);
  d.out(
    `Done. Restart the runner, then open http://127.0.0.1:${port}/ and pair this browser again (${gone} forgotten).`,
  );
}

const run =
  <A extends unknown[]>(fn: (...a: A) => unknown | Promise<unknown>) =>
  async (...a: A) => {
    try {
      await fn(...a);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  };

/** Registers `approvals pair|devices|forget|port` on the runner CLI. */
export function registerApprovalsCommands(
  program: Command,
  make: () => ApprovalsCliDeps = defaultApprovalsCliDeps,
): void {
  const a = program
    .command('approvals')
    .description('Approvals on this computer: the local page and its paired browsers');
  a.command('pair <code>')
    .description('pair the browser that shows this code with this runner (needs a terminal)')
    .action(run((code: string) => approvalsPair(make(), code)));
  a.command('devices')
    .description('list the browsers paired with this runner')
    .action(run(() => approvalsDevices(make())));
  a.command('forget [fingerprint]')
    .description('forget a paired browser (or every one with --all)')
    .option('--all', 'forget every paired browser')
    .action(run((fp: string | undefined, o: { all?: boolean }) => approvalsForget(make(), fp, !!o.all)));
  a.command('port <port>')
    .description('move the approvals page to another port; every browser must pair again (needs a terminal)')
    .action(run((p: string) => approvalsPort(make(), p)));
}
