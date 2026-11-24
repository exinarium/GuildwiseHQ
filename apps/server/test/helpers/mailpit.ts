// Mailpit is shared with other projects: always filter by recipient (use unique addresses per test).
const API = process.env.MAILPIT_API ?? 'http://127.0.0.1:8025/api/v1';

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
  Created: string;
}

export async function messagesTo(email: string): Promise<MailpitMessage[]> {
  const res = await fetch(`${API}/search?query=${encodeURIComponent(`to:${email}`)}`);
  const body = (await res.json()) as { messages?: MailpitMessage[] };
  return (body.messages ?? []).filter((m) =>
    m.To.some((t) => t.Address.toLowerCase() === email.toLowerCase()),
  );
}

export async function waitForMessages(email: string, count = 1, timeoutMs = 5000): Promise<MailpitMessage[]> {
  const start = Date.now();
  for (;;) {
    const msgs = await messagesTo(email);
    if (msgs.length >= count) return msgs;
    if (Date.now() - start > Math.max(timeoutMs, 30_000))
      throw new Error(`timed out waiting for ${count} mail(s) to ${email}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function messageText(id: string): Promise<string> {
  const res = await fetch(`${API}/message/${id}`);
  const body = (await res.json()) as { Text: string };
  return body.Text;
}

/** The subject of the new-workstation notice (`newWorkstationMail`). */
export const NEW_WORKSTATION_SUBJECT = 'A new workstation was added to your account';

/** The invitation token from the newest mail to `email` (not counting new-workstation notices). */
export async function latestInviteToken(email: string, origin: string, count = 1): Promise<string> {
  const link = new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/invite/([A-Za-z0-9_-]+)`);
  const start = Date.now();
  for (;;) {
    const msgs = await waitForMessages(email, count);
    // every pairing mails the account too (release-readiness O3): that notice is never the invitation, and it may
    // arrive before the invitation does
    const newest = [...msgs]
      .filter((m) => m.Subject !== NEW_WORKSTATION_SUBJECT)
      .sort((a, b) => b.Created.localeCompare(a.Created))[0];
    const text = newest ? await messageText(newest.ID) : '';
    const m = link.exec(text);
    if (m) return m[1] as string;
    if (Date.now() - start > 30_000) throw new Error(`no invite link in mail: ${text}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The Reply-To addresses of a stored message. */
export async function replyToOf(id: string): Promise<string[]> {
  const res = await fetch(`${API}/message/${id}`);
  const body = (await res.json()) as { ReplyTo?: Array<{ Address: string }> };
  return (body.ReplyTo ?? []).map((a) => a.Address);
}
