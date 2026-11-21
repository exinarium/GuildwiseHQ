import { createInterface } from 'node:readline/promises';

/**
 * The password of the account CLIs (R13): `--password-stdin` reads it from standard input (one line, the trailing
 * newline dropped), so it never shows in the process list or the shell history. `--password` still works but warns
 * for that reason; then `AOM_ADMIN_PASSWORD`, then a prompt.
 */
export async function readPassword(
  opts: { password?: string | undefined; passwordStdin?: boolean | undefined; prompt: string },
  io: {
    stdin?: AsyncIterable<string | Buffer>;
    env?: Record<string, string | undefined>;
    warn?: (m: string) => void;
    ask?: (q: string) => Promise<string>;
  } = {},
): Promise<string> {
  if (opts.passwordStdin) {
    let text = '';
    for await (const chunk of io.stdin ?? process.stdin) text += chunk.toString();
    return text.replace(/\r?\n$/, '');
  }
  if (opts.password !== undefined) {
    (io.warn ?? console.warn)(
      'WARN: --password is visible in the process list and the shell history: use --password-stdin',
    );
    return opts.password;
  }
  const env = io.env ?? process.env;
  if (env.AOM_ADMIN_PASSWORD) return env.AOM_ADMIN_PASSWORD;
  return (io.ask ?? ask)(opts.prompt);
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

/** The `parseArgs` option of the flag. */
export const PASSWORD_STDIN_OPTION = { 'password-stdin': { type: 'boolean', default: false } } as const;
