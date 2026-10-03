import { MAILPIT_API } from './env.ts';

interface MailSummary {
  ID: string;
  To: { Address: string }[];
  Subject: string;
  Created: string;
}

/** Waits for a message to `to` in the (shared) Mailpit and returns its text body. */
export async function waitForMail(
  to: string,
  timeoutMs = 15_000,
): Promise<{ subject: string; text: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}&limit=5`);
    const body = (await res.json()) as { messages?: MailSummary[] };
    const msg = body.messages?.[0];
    if (msg) {
      const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${msg.ID}`)).json()) as {
        Text: string;
      };
      return { subject: msg.Subject, text: full.Text };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no mail for ${to} within ${timeoutMs} ms`);
}

export async function deleteMailFor(to: string): Promise<void> {
  await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`, { method: 'DELETE' });
}
