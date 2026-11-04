import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import pg from 'pg';
import { E2E_DIR, HOSTED_URL, MAILPIT_API, PG_ADMIN_URL, PORT, RESULTS_DIR, ROOT, TLS_PORT } from './env.ts';
import { declaredServices, TEST_SERVICES_SETTING } from './test-services.ts';

export type CheckResult = { ok: boolean; skipped?: string; detail: string; fix?: string };
export type Check = { name: string; target: string; run: () => Promise<CheckResult> };
export type Line = { name: string; target: string; status: 'ready' | 'NOT READY' | 'skipped'; detail: string; fix?: string };

const withTimeout = <T>(p: Promise<T>, ms = 3000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

export function tcpReady(host: string, port: number, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export async function httpOk(url: string): Promise<boolean> {
  try {
    return (await withTimeout(fetch(url))).ok;
  } catch {
    return false;
  }
}

export function canBind(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

const devops = 'ask DevOps (aom devops "<what is down>")';

export function buildChecks(opts: { noDocker?: boolean; noHosted?: boolean } = {}): Check[] {
  const hostedPort = Number(new URL(HOSTED_URL).port || 80);
  const hostedHost = new URL(HOSTED_URL).hostname === 'localhost' ? '127.0.0.1' : new URL(HOSTED_URL).hostname;
  const need = [5433, 8025, 1025, ...(opts.noHosted ? [] : [hostedPort])];
  const checks: Check[] = [
    {
      name: 'node',
      target: process.version,
      run: async () => ({
        ok: Number(process.versions.node.split('.')[0]) >= 22,
        detail: `node ${process.version}`,
        fix: 'use the node-nvm 22.23.4 toolchain',
      }),
    },
    {
      name: 'dependencies',
      target: 'playwright, pg',
      run: async () => {
        const missing = ['@playwright/test', 'pg'].filter((m) => {
          try {
            execFileSync('node', ['-e', `require.resolve('${m}')`], { cwd: join(ROOT, 'e2e'), stdio: 'ignore' });
            return false;
          } catch {
            return true;
          }
        });
        return {
          ok: missing.length === 0,
          detail: missing.length ? `missing: ${missing.join(', ')}` : 'resolved',
          fix: 'run: bash e2e/scripts/copy-cached-deps.sh; if the lockfile differs, ask DevOps to refresh the gwp-core cache',
        };
      },
    },
    {
      name: 'build',
      target: 'server, runner, web dist',
      run: async () => {
        const missing = ['apps/server/dist/main.mjs', 'apps/runner/dist/aom-runner.mjs', 'apps/web/dist/index.html'].filter(
          (f) => !existsSync(join(ROOT, f)),
        );
        return {
          ok: missing.length === 0,
          detail: missing.length ? `missing: ${missing.join(', ')}` : 'built',
          fix: 'run: pnpm_config_verify_deps_before_run=false pnpm build',
        };
      },
    },
    {
      name: 'scratch',
      target: `${E2E_DIR}, ${RESULTS_DIR}`,
      run: async () => {
        const dirs = [E2E_DIR, RESULTS_DIR, ...(process.env.AOM_AGENT_TMP_ROOT ? [process.env.AOM_AGENT_TMP_ROOT] : [])];
        const bad: string[] = [];
        for (const d of dirs) {
          try {
            mkdirSync(d, { recursive: true });
            const probe = join(d, `.preflight-${process.pid}`);
            writeFileSync(probe, 'x');
            rmSync(probe);
          } catch {
            bad.push(d);
          }
        }
        return {
          ok: bad.length === 0,
          detail: bad.length ? `not writable: ${bad.join(', ')}` : 'writable',
          fix: 'in a tester shift the runner sets AOM_E2E_DIR: ask DevOps to check the runner version; outside a shift set AOM_E2E_DIR',
        };
      },
    },
    {
      name: 'test services',
      target: `${need.join(', ')} declared; ${PORT}, ${TLS_PORT} not`,
      run: async () => {
        const d = declaredServices();
        if (!d.inShift) return { ok: true, detail: 'not in a tester shift: nothing to check' };
        const undeclared = need.filter((p) => !d.connect.has(p));
        const wrong = [PORT, TLS_PORT].filter((p) => d.connect.has(p));
        const parts = [
          ...undeclared.map((p) => `${p} is not declared`),
          ...wrong.map((p) => `${p} is declared but the harness listens on it`),
        ];
        return {
          ok: parts.length === 0,
          detail: parts.length ? parts.join('; ') : 'declaration matches',
          fix: `ask the project Owner to add or remove those ports in ${TEST_SERVICES_SETTING} (applies from the next shift)`,
        };
      },
    },
    {
      name: 'postgres',
      target: PG_ADMIN_URL.replace(/\/\/[^@]*@/, '//'),
      run: async () => {
        const c = new pg.Client({ connectionString: PG_ADMIN_URL, connectionTimeoutMillis: 3000 });
        try {
          await c.connect();
          await c.query('SELECT 1');
          return { ok: true, detail: 'SELECT 1 answered' };
        } catch (e) {
          return { ok: false, detail: String((e as Error).message), fix: `${devops} to start the dev Postgres on 5433` };
        } finally {
          await c.end().catch(() => {});
        }
      },
    },
    {
      name: 'mailpit',
      target: MAILPIT_API,
      run: async () => ({
        ok: await httpOk(`${MAILPIT_API}/api/v1/info`),
        detail: `${MAILPIT_API}/api/v1/info`,
        fix: `${devops} to start Mailpit (8025/1025)`,
      }),
    },
    {
      name: 'smtp',
      target: '127.0.0.1:1025',
      run: async () => ({
        ok: await tcpReady('127.0.0.1', 1025),
        detail: 'tcp connect',
        fix: `${devops} to start Mailpit (8025/1025)`,
      }),
    },
    {
      name: 'app port',
      target: `127.0.0.1:${PORT}`,
      run: async () => ({
        ok: await canBind(PORT),
        detail: `${PORT} can be bound`,
        fix: `a stale E2E server still runs (see pids.json in ${E2E_DIR}) or ${PORT} is declared as a test service: remove it`,
      }),
    },
  ];
  checks.push(
    opts.noHosted
      ? {
          name: 'hosted build',
          target: HOSTED_URL,
          run: async () => ({ ok: true, skipped: '--no-hosted', detail: 'skipped' }),
        }
      : {
          name: 'hosted build',
          target: HOSTED_URL,
          run: async () => ({
            ok: await httpOk(`${HOSTED_URL}/api/health`),
            detail: `${HOSTED_URL}/api/health`,
            fix: `${devops} to start the hosted build (toolchain gwp98-hosted-app) on ${hostedPort}`,
          }),
        },
    opts.noHosted
      ? { name: 'tls proxy', target: `127.0.0.1:${TLS_PORT}`, run: async () => ({ ok: true, skipped: '--no-hosted', detail: 'skipped' }) }
      : {
          name: 'tls proxy',
          target: `127.0.0.1:${TLS_PORT}`,
          run: async () => {
            const { startTlsProxy } = await import('./tls-proxy.ts');
            const dir = join(E2E_DIR, `preflight-tls-${process.pid}`);
            try {
              const p = await startTlsProxy({ target: HOSTED_URL, port: TLS_PORT, certDir: dir });
              try {
                const ok = await new Promise<boolean>((resolve) => {
                  import('node:https').then(({ default: https }) => {
                    https
                      .get(`${p.url}/api/health`, { ca: readCa(p.caPath), timeout: 3000 }, (r) => {
                        r.resume();
                        resolve(r.statusCode === 200);
                      })
                      .on('error', () => resolve(false));
                  });
                });
                return { ok, detail: `https://localhost:${TLS_PORT}/api/health over TLS`, fix: `needs the hosted build up (${devops}) and openssl` };
              } finally {
                await p.close();
              }
            } catch (e) {
              return { ok: false, detail: (e as Error).message, fix: `port ${TLS_PORT} must be free and not declared; openssl must be installed` };
            }
          },
        },
    opts.noDocker
      ? {
          name: 'docker',
          target: 'docker daemon',
          run: async () => ({
            ok: true,
            skipped: 'no Docker in tester shifts: DevOps runs pnpm -C e2e docker',
            detail: 'skipped',
          }),
        }
      : {
          name: 'docker',
          target: 'docker daemon, registry:2, alpine:3.20',
          run: async () => {
            try {
              execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore', timeout: 5000 });
              const imgs = execFileSync('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' });
              const miss = ['registry:2'].filter((i) => !imgs.includes(i));
              if (!imgs.includes('alpine:3.20') && !imgs.includes('aom-test-sshd:1')) miss.push('alpine:3.20');
              return {
                ok: miss.length === 0,
                detail: miss.length ? `images missing: ${miss.join(', ')}` : 'daemon reachable, images present',
                fix: `${devops} to pull the missing images`,
              };
            } catch {
              return { ok: false, detail: 'docker daemon not reachable', fix: `${devops} to run pnpm -C e2e docker outside the sandbox` };
            }
          },
        },
  );
  return checks;
}

import { readFileSync } from 'node:fs';
const readCa = (p: string) => readFileSync(p);

export async function runChecks(checks: Check[]): Promise<Line[]> {
  const out: Line[] = [];
  for (const c of checks) {
    let r: CheckResult;
    try {
      r = await c.run();
    } catch (e) {
      r = { ok: false, detail: (e as Error).message, fix: c.name };
    }
    out.push({
      name: c.name,
      target: c.target,
      status: r.skipped ? 'skipped' : r.ok ? 'ready' : 'NOT READY',
      detail: r.skipped ? `skipped (${r.skipped})` : r.detail,
      fix: r.ok ? undefined : r.fix,
    });
  }
  return out;
}

export function formatReport(lines: Line[]): string {
  return lines
    .map((l) => {
      const head = `${l.status.padEnd(9)} ${l.name.padEnd(14)} ${l.target}`;
      if (l.status === 'NOT READY') return `${head}\n          ${l.detail}\n          fix: ${l.fix ?? ''}`;
      if (l.status === 'skipped') return `${head}  (${l.detail})`;
      return head;
    })
    .join('\n');
}

export const exitCodeOf = (lines: Line[]): number => (lines.some((l) => l.status === 'NOT READY') ? 1 : 0);

if (import.meta.url === `file://${process.argv[1]}`) {
  const lines = await runChecks(
    buildChecks({ noDocker: process.argv.includes('--no-docker'), noHosted: process.argv.includes('--no-hosted') }),
  );
  if (process.argv.includes('--json')) console.log(JSON.stringify(lines, null, 2));
  else console.log(formatReport(lines));
  const code = exitCodeOf(lines);
  console.log(code === 0 ? '\nready' : '\nNOT READY: fix the lines above before running the suite');
  process.exit(code);
}
