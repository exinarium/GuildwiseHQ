import { readFileSync } from 'node:fs';
import { APP_ERROR_TEXT, APP_PROVIDER_IDS, type AppProviderId } from '@aom/shared';
import type { AutomatedAppIntegration } from '../integrations/automated-app.ts';

/** `apps connect <provider>`: `github` is the short name of `github-app`. */
export function appProviderOf(name: string): AppProviderId {
  const id = name.endsWith('-app') ? name : `${name}-app`;
  if (!(APP_PROVIDER_IDS as readonly string[]).includes(id))
    throw new Error(
      `Unknown app provider "${name}". Supported: ${APP_PROVIDER_IDS.map((p) => p.replace(/-app$/, '')).join(', ')}.`,
    );
  return id as AppProviderId;
}

export interface AppsConnectOptions {
  appId: string;
  installation?: string;
  host?: string;
  keyFile?: string;
  keyStdin?: boolean;
}

/** Reads the private key from a file, stdin or a hidden prompt; it is never an argument value and never echoed. */
export async function readAppKey(
  opts: Pick<AppsConnectOptions, 'keyFile' | 'keyStdin'>,
  io: { stdin: () => Promise<string>; prompt: () => Promise<string>; isTTY: boolean },
): Promise<string> {
  if (opts.keyFile) return readFileSync(opts.keyFile, 'utf8');
  if (opts.keyStdin || !io.isTTY) return io.stdin();
  return io.prompt();
}

/** Connects an app from a terminal (a copy marked local); returns the lines to print and whether it worked. */
export async function appsConnect(
  adapter: AutomatedAppIntegration,
  opts: AppsConnectOptions,
  privateKey: string,
): Promise<{ ok: boolean; lines: string[] }> {
  if (!/PRIVATE KEY-----/.test(privateKey))
    return { ok: false, lines: ['That is not a PEM private key (BEGIN … PRIVATE KEY). Nothing was saved.'] };
  const r = await adapter.connectApp(
    {
      host: opts.host || 'github.com',
      appRef: opts.appId,
      ...(opts.installation ? { installationId: opts.installation } : {}),
      privateKey,
    },
    { local: true },
  );
  if (!r.ok) {
    const lines = [`${r.message ?? APP_ERROR_TEXT[r.code ?? 'unexpected']} Nothing was saved.`];
    for (const i of r.installations ?? [])
      lines.push(
        `  --installation ${i.id}  ${i.account}${i.accountType ? ` (${i.accountType})` : ''}${i.suspended ? ' suspended' : ''}`,
      );
    return { ok: false, lines };
  }
  const id = r.identity;
  return {
    ok: true,
    lines: [
      `Connected ${id?.appName ?? 'the app'} (${r.instance}) on this workstation; the key is sealed with this runner's key.`,
      `Acts as ${id?.botLogin}; commits as "${id?.commitName} <${id?.commitEmail}>".`,
      ...(id?.missingPermissions.length
        ? [`The installation does not grant: ${id.missingPermissions.join(', ')}.`]
        : []),
      'Add it to your organization in Settings > Automated apps. You can now delete the downloaded .pem file.',
    ],
  };
}

/** `apps list`: one line per stored app (no key, no token). */
export async function appsList(adapters: AutomatedAppIntegration[]): Promise<string[]> {
  const lines: string[] = [];
  for (const a of adapters)
    for (const i of await a.instances()) {
      const app = a.broker().store.get(i);
      const st = await a.status(i);
      lines.push(
        `${a.kind} ${i}: ${st.state}${app ? ` as ${app.identity.botLogin} (${app.identity.account})` : ''}${app?.local ? ', connected here' : ''}${st.detail ? `. ${st.detail}` : ''}`,
      );
    }
  return lines.length ? lines : ['No automated apps on this workstation.'];
}

/** Reads a PEM without echoing it: lines until the `-----END … PRIVATE KEY-----` line. */
export function readHiddenPem(input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<string> {
  output.write('Paste the private key (it is not shown); it ends at the -----END … PRIVATE KEY----- line:\n');
  return new Promise((resolve) => {
    let buf = '';
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');
    const finish = () => {
      input.setRawMode?.(false);
      input.pause();
      input.off('data', onData);
      output.write('\n');
      resolve(buf);
    };
    const onData = (chunk: string) => {
      if (chunk === '\u0003') {
        buf = '';
        finish();
        return;
      }
      buf += chunk.replace(/\r/g, '\n');
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(buf)) finish();
    };
    input.on('data', onData);
  });
}
