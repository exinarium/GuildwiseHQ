import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { DeviceStore, signedText } from '../../../apps/runner/src/window/pairing.ts';

/**
 * A client of the runner's real approvals page (apps/runner/src/window/server.ts): the same device-key sign-in a browser
 * does (ECDSA P-256, a nonce signed over `gw-approvals|<instance>|<port>|<nonce>`). The one step a person does at the
 * keyboard, `guildwise-runner approvals pair <code>` + typing "yes", is the product's own `DeviceStore.confirmPending`
 * on the same policy dir (the CLI needs a terminal for the typed yes).
 */
export interface PageState {
  header: { instance: string };
  waiting: Array<{
    id: string;
    version: string;
    kind: string;
    summary: string;
    detail: string;
    note?: string;
  }>;
  blocked: Array<{
    requestId: string;
    switch: string;
    switchLabel: string;
    agentName: string;
    summary: string;
    command?: string;
  }>;
  status: { connected: boolean; policyError?: string };
  allows: {
    devopsInstall: boolean;
    devopsRequests: string;
    toolInstall: boolean;
    hygiene: boolean;
    ceiling: { docker: boolean; containerEgress: boolean; mountRoots: string[] };
  };
}

export class ApprovalsPage {
  private token = '';
  private readonly origin: string;

  constructor(
    private readonly port: number,
    private readonly policyDir: string,
  ) {
    this.origin = `http://127.0.0.1:${port}`;
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    auth = true,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${this.origin}${path}`, {
      method,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json', origin: this.origin } : {}),
        ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  /** Pairs this client as a browser and signs in (once). */
  async signIn(): Promise<void> {
    if (this.token) return;
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const pair = await this.call('POST', '/api/pair', { spki: der.toString('base64') }, false);
    if (pair.status !== 200)
      throw new Error(`approvals page pairing: ${pair.status} ${JSON.stringify(pair.json)}`);
    new DeviceStore(this.policyDir).confirmPending(pair.json.code as string);
    const hello = (await this.call('GET', '/api/hello', undefined, false)).json as { instance: string };
    const { nonce } = (await this.call('GET', '/api/challenge', undefined, false)).json as { nonce: string };
    const sig = sign('sha256', Buffer.from(signedText(hello.instance, this.port, nonce)), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64');
    const keyHash = createHash('sha256').update(der).digest('hex');
    const session = await this.call('POST', '/api/session', { keyHash, nonce, sig }, false);
    if (session.status !== 200)
      throw new Error(`approvals page sign-in: ${session.status} ${JSON.stringify(session.json)}`);
    this.token = session.json.token as string;
  }

  async state(): Promise<PageState> {
    await this.signIn();
    const r = await this.call('GET', '/api/state');
    if (r.status !== 200) throw new Error(`approvals page state: ${r.status}`);
    return r.json as PageState;
  }

  async change(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    await this.signIn();
    return this.call('POST', '/api/change', body);
  }

  /** Approves the version of the item as the page shows it now (a yes is bound to what was shown), or `version` when given. */
  approve = async (id: string, version?: string) => {
    const v = version ?? (await this.state()).waiting.find((w) => w.id === id)?.version ?? '';
    return this.change({ action: 'held.approve', id, version: v });
  };
  deny = (id: string) => this.change({ action: 'held.deny', id });
}
