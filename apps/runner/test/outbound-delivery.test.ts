import { generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GoogleSheetsIntegration } from '../src/integrations/google-sheets.ts';
import { WhatsappIntegration } from '../src/integrations/whatsapp.ts';
import { appendSheetRow, clearTokenCache, signJwt } from '../src/outbound-delivery/google-sheets.ts';
import { OutboundDelivery, sheetsStore, whatsappStore } from '../src/outbound-delivery/send.ts';
import { sendWhatsapp, whatsappBody } from '../src/outbound-delivery/whatsapp.ts';
import { redact } from '../src/secrets/redact.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'gw-sealed-'));
const TOKEN = 'EAAGm0PX4ZCpsBAEXAMPLEtokenvalue1234567890';
type Call = { url: string; init: RequestInit };
const authOf = (c: Call | undefined): string | undefined =>
  c ? (c.init.headers as Record<string, string>).authorization : undefined;
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const fake = (answers: Array<Response | Error>) => {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answers.shift() ?? reply(200);
    if (a instanceof Error) throw a;
    return a;
  };
  return { calls, fn };
};

describe('WhatsApp sender', () => {
  const m = { to: ['+27821234567'], text: 'Result · https://hq/cards/X-1' };
  const creds = { phoneNumberId: '1055', accessToken: TOKEN };

  it('sends a template (one body variable) when a template is set, else plain text', () => {
    const t = whatsappBody('+27821234567', {
      ...m,
      template: { name: 'result_ready', language: 'en_US' },
    }) as any;
    expect(t.to).toBe('27821234567');
    expect(t.type).toBe('template');
    expect(t.template.language.code).toBe('en_US');
    expect(t.template.components[0].parameters).toEqual([{ type: 'text', text: m.text }]);
    expect((whatsappBody('+27821234567', m) as any).type).toBe('text');
  });

  it('ok on 200, with the bearer token and no text in the URL', async () => {
    const f = fake([reply(200, { messages: [{ id: 'w' }] })]);
    expect(await sendWhatsapp(creds, m, f.fn)).toEqual({ ok: true, retryable: false });
    expect(f.calls[0]?.url).toContain('/1055/messages');
    expect(authOf(f.calls[0])).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[0]?.url).not.toContain('Result');
  });

  it('outside the 24-hour window (131047) is final with a clear reason', async () => {
    const f = fake([reply(400, { error: { code: 131047, message: 'Re-engagement message' } })]);
    const r = await sendWhatsapp(creds, m, f.fn);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.error).toContain('outside the 24-hour window');
  });

  it('429 and 5xx and network errors are retryable; other 4xx is final; 401 says reconnect', async () => {
    expect((await sendWhatsapp(creds, m, fake([reply(429)]).fn)).retryable).toBe(true);
    expect((await sendWhatsapp(creds, m, fake([reply(503)]).fn)).retryable).toBe(true);
    expect((await sendWhatsapp(creds, m, fake([new Error('ECONNRESET')]).fn)).retryable).toBe(true);
    expect((await sendWhatsapp(creds, m, fake([reply(400, { error: { code: 100 } })]).fn)).retryable).toBe(
      false,
    );
    const r = await sendWhatsapp(
      creds,
      m,
      fake([reply(401, { error: { code: 190, message: 'Invalid OAuth' } })]).fn,
    );
    expect(r.retryable).toBe(false);
    expect(r.error).toContain('reconnect on the Integrations page');
  });

  it('a partly delivered message is not retried (it would send twice)', async () => {
    const two = { ...m, to: ['+27821234567', '+27829999999'] };
    const r = await sendWhatsapp(creds, two, fake([reply(200), reply(503)]).fn);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.error).toContain('1 of 2 numbers failed');
  });

  it('an error text never holds the token or the message text', async () => {
    const r = await sendWhatsapp(creds, m, fake([new Error(`fetch failed Bearer ${TOKEN}`)]).fn);
    expect(r.error).not.toContain(TOKEN);
    expect(r.error).not.toContain('Result');
  });
});

describe('Google Sheets sender', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = {
    clientEmail: 'rep@proj.iam.gserviceaccount.com',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  const row = [
    '2026-10-30T10:00:00.000Z',
    'Weekly',
    'X-1',
    'Title',
    '=HYPERLINK("x")\n\nhttps://hq/cards/X-1',
  ];
  const m = { spreadsheetId: '1AbCdEfGhIjKlMnOpQrStUv', sheet: 'Sheet1', row };
  beforeEach(clearTokenCache);

  it('signs an RS256 JWT with the service account claims', () => {
    const jwt = signJwt(sa, 1_000);
    const [h, c, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
      iss: sa.clientEmail,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_000,
      exp: 4_600,
    });
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('appends one row with valueInputOption=RAW and caches the token', async () => {
    const f = fake([reply(200, { access_token: 'ya29.tok', expires_in: 3600 }), reply(200), reply(200)]);
    expect((await appendSheetRow(sa, m, f.fn, () => 1_000_000)).ok).toBe(true);
    expect((await appendSheetRow(sa, m, f.fn, () => 1_000_500)).ok).toBe(true);
    expect(f.calls).toHaveLength(3); // one token exchange, two appends
    const append = f.calls[1] as Call;
    expect(append.url).toContain('/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUv/values/Sheet1!A%3AE:append');
    expect(append.url).toContain('valueInputOption=RAW');
    expect(JSON.parse(String(append.init.body))).toEqual({ values: [row] });
    expect(String(f.calls[0]?.init.body)).toContain(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer',
    );
  });

  it('403 tells to share the sheet; 429 retries; a refused key is final', async () => {
    const tok = reply(200, { access_token: 't', expires_in: 3600 });
    const r403 = await appendSheetRow(sa, m, fake([tok, reply(403, { error: { message: 'no' } })]).fn);
    expect(r403.retryable).toBe(false);
    expect(r403.error).toContain(`share it with ${sa.clientEmail}`);
    clearTokenCache();
    expect(
      (
        await appendSheetRow(
          sa,
          m,
          fake([reply(200, { access_token: 't', expires_in: 3600 }), reply(429)]).fn,
        )
      ).retryable,
    ).toBe(true);
    clearTokenCache();
    const bad = await appendSheetRow(sa, m, fake([reply(400, { error: 'invalid_grant' })]).fn);
    expect(bad.retryable).toBe(false);
    expect(bad.error).toContain('reconnect');
  });
});

describe('credentials at rest', () => {
  const key = randomBytes(32);
  const keyOf = () => key;

  it('the file is not plaintext, is mode 0600, and decrypts back; another key reads nothing', () => {
    const d = dir();
    const store = whatsappStore(d, keyOf);
    store.save({ accounts: { '1055': { accessToken: TOKEN } } });
    const raw = readFileSync(join(d, 'whatsapp.json'), 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain('1055');
    expect(statSync(join(d, 'whatsapp.json')).mode & 0o777).toBe(0o600);
    expect(store.load()?.accounts['1055']?.accessToken).toBe(TOKEN);
    expect(whatsappStore(d, () => randomBytes(32)).load()).toBeUndefined();
    expect(redact(`oops ${TOKEN}`)).not.toContain(TOKEN); // registered on load
    store.remove();
    expect(store.load()).toBeUndefined();
  });

  it('the Sheets private key is also encrypted', () => {
    const d = dir();
    sheetsStore(d, keyOf).save({
      accounts: { 'a@b': { clientEmail: 'a@b', privateKey: 'PRIVATE-KEY-MATERIAL' } },
    });
    expect(readFileSync(join(d, 'google-sheets.json'), 'utf8')).not.toContain('PRIVATE-KEY-MATERIAL');
  });
});

describe('delivery.send on the runner', () => {
  it('says so when the channel is not connected here (final), and logs no text', async () => {
    const lines: string[] = [];
    const d = new OutboundDelivery({
      secretsDir: dir(),
      keyOf: () => randomBytes(32),
      log: (l) => lines.push(l),
    });
    const r = await d.run({
      runId: crypto.randomUUID(),
      attempt: 1,
      test: false,
      channel: 'whatsapp',
      instance: '1055',
      whatsapp: { to: ['+27821234567'], text: 'SECRET BODY' },
    });
    expect(r).toEqual({
      ok: false,
      error: 'WhatsApp is not connected on this workstation',
      retryable: false,
    });
    expect(lines.join('\n')).not.toContain('SECRET BODY');
    expect(lines[0]).toMatch(/^delivery\.send channel=whatsapp run=/);
  });

  it('sends with the stored credential', async () => {
    const secretsDir = dir();
    const key = randomBytes(32);
    whatsappStore(secretsDir, () => key).save({ accounts: { '1055': { accessToken: TOKEN } } });
    const f = fake([reply(200)]);
    const d = new OutboundDelivery({ secretsDir, keyOf: () => key, fetch: f.fn });
    const r = await d.run({
      runId: crypto.randomUUID(),
      attempt: 1,
      test: false,
      channel: 'whatsapp',
      instance: '1055',
      whatsapp: { to: ['+27821234567'], text: 'hi' },
    });
    expect(r.ok).toBe(true);
    expect(authOf(f.calls[0])).toBe(`Bearer ${TOKEN}`);
  });
});

describe('integration adapters', () => {
  const env = (d: string) =>
    ({
      paths: { secrets: d },
      sealKey: () => Buffer.alloc(32, 7),
      fetch: globalThis.fetch,
      now: () => new Date('2026-10-30T10:00:00Z'),
      touchRecheck: () => undefined,
    }) as never;

  it('WhatsApp saves only after Meta accepted the token, and its status shows no token', async () => {
    const d = dir();
    const bad = new WhatsappIntegration(env(d), { fetch: fake([reply(400, { error: { code: 190 } })]).fn });
    const refused = await bad.connect('106540352242922', 'token', { token: TOKEN });
    expect('error' in refused && refused.error).toContain('Nothing was saved');
    expect(await bad.instances()).toEqual([]);

    const good = new WhatsappIntegration(env(d), {
      fetch: fake([
        reply(200, { display_phone_number: '+27 82 123 4567' }),
        reply(200, { display_phone_number: '+27 82 123 4567' }),
      ]).fn,
    });
    const st = await good.connect('106540352242922', 'token', { token: TOKEN });
    expect(st).toMatchObject({ state: 'connected', account: '+27 82 123 4567' });
    expect(JSON.stringify(st)).not.toContain(TOKEN);
    expect(await good.instances()).toEqual(['106540352242922']);
  });

  it('Sheets refuses a key that is not a service account or belongs to another e-mail', async () => {
    const d = dir();
    const a = new GoogleSheetsIntegration(env(d), { fetch: fake([]).fn });
    expect(
      'error' in (await a.connect('x@y', 'service_account', { keyJson: '{"type":"authorized_user"}' })),
    ).toBe(true);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyJson = JSON.stringify({
      type: 'service_account',
      client_email: 'real@p.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    const wrong = await a.connect('other@p.iam.gserviceaccount.com', 'service_account', { keyJson });
    expect('error' in wrong && wrong.error).toContain('real@p.iam.gserviceaccount.com');
    expect(await a.instances()).toEqual([]);
  });
});
