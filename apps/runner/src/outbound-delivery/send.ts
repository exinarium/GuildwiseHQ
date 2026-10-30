import { join } from 'node:path';
import { type DeliverySendPayload, type DeliverySendResult } from '@aom/shared';
import { z } from 'zod';
import { SealedFile } from '../secrets/sealed-file.ts';
import { appendSheetRow, type ServiceAccount } from './google-sheets.ts';
import { sendWhatsapp } from './whatsapp.ts';

/** `secrets/whatsapp.json` (encrypted): the connected phone numbers. GWP-37's inbound fields join the same file. */
export const WhatsappSecretsSchema = z.object({
  accounts: z.record(z.string(), z.object({ accessToken: z.string() }).passthrough()).default({}),
});
export type WhatsappSecrets = z.infer<typeof WhatsappSecretsSchema>;

/** `secrets/google-sheets.json` (encrypted): the connected service accounts, by e-mail. */
export const SheetsSecretsSchema = z.object({
  accounts: z.record(z.string(), z.object({ clientEmail: z.string(), privateKey: z.string() })).default({}),
});
export type SheetsSecrets = z.infer<typeof SheetsSecretsSchema>;

export const whatsappStore = (secretsDir: string, keyOf: (name: string) => Buffer) =>
  new SealedFile<WhatsappSecrets>(join(secretsDir, 'whatsapp.json'), keyOf, WhatsappSecretsSchema, (v) =>
    Object.values(v.accounts).map((a) => a.accessToken),
  );
export const sheetsStore = (secretsDir: string, keyOf: (name: string) => Buffer) =>
  new SealedFile<SheetsSecrets>(join(secretsDir, 'google-sheets.json'), keyOf, SheetsSecretsSchema, (v) =>
    Object.values(v.accounts).map((a) => a.privateKey),
  );

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Runs a `delivery.send` command with the credential kept on this workstation. Never throws; never logs the text. */
export class OutboundDelivery {
  constructor(
    private readonly deps: {
      secretsDir: string;
      keyOf: (name: string) => Buffer;
      fetch?: Fetch;
      now?: () => number;
      log?: (line: string) => void;
    },
  ) {}

  async run(p: DeliverySendPayload): Promise<DeliverySendResult> {
    const started = Date.now();
    const result = await this.dispatch(p).catch(
      (): DeliverySendResult => ({ ok: false, error: 'the workstation could not send', retryable: true }),
    );
    // Channel, run, status and duration only.
    this.deps.log?.(
      `delivery.send channel=${p.channel} run=${p.runId} ${result.ok ? 'ok' : 'failed'} ${Date.now() - started}ms`,
    );
    return result;
  }

  private async dispatch(p: DeliverySendPayload): Promise<DeliverySendResult> {
    if (p.channel === 'whatsapp') {
      const acct = whatsappStore(this.deps.secretsDir, this.deps.keyOf).load()?.accounts[p.instance];
      if (!acct)
        return { ok: false, error: 'WhatsApp is not connected on this workstation', retryable: false };
      if (!p.whatsapp) return { ok: false, error: 'the command has no WhatsApp message', retryable: false };
      return sendWhatsapp(
        { phoneNumberId: p.instance, accessToken: acct.accessToken },
        p.whatsapp,
        this.deps.fetch,
      );
    }
    const sa: ServiceAccount | undefined = sheetsStore(this.deps.secretsDir, this.deps.keyOf).load()?.accounts[
      p.instance
    ];
    if (!sa) return { ok: false, error: 'Google Sheets is not connected on this workstation', retryable: false };
    if (!p.sheet) return { ok: false, error: 'the command has no row', retryable: false };
    return appendSheetRow(sa, p.sheet, this.deps.fetch, this.deps.now);
  }
}
