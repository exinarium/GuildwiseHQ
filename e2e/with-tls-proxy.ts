import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { E2E_DIR, HOSTED_URL, TLS_PORT } from './support/env.ts';
import { startTlsProxy } from './support/tls-proxy.ts';

/** `node with-tls-proxy.ts [--target <url>] [--port <n>] -- <command...>`: runs the command with the TLS proxy up. */
const args = process.argv.slice(2);
const sep = args.indexOf('--');
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 && (sep < 0 || i < sep) ? args[i + 1] : undefined;
};
const cmd = sep >= 0 ? args.slice(sep + 1) : [];
if (cmd.length === 0) {
  console.error('usage: with-tls-proxy.ts [--target <url>] [--port <n>] -- <command...>');
  process.exit(2);
}
const proxy = await startTlsProxy({
  target: opt('--target') ?? HOSTED_URL,
  port: Number(opt('--port') ?? TLS_PORT),
  certDir: join(E2E_DIR, `tls-${process.pid}`),
});
const child = spawn(cmd[0] as string, cmd.slice(1), {
  stdio: 'inherit',
  env: { ...process.env, NODE_EXTRA_CA_CERTS: proxy.caPath, HOSTED_TLS_URL: proxy.url },
});
const stop = async (code: number) => {
  await proxy.close();
  process.exit(code);
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => void stop(code ?? 1));
