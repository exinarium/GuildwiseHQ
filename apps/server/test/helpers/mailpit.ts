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
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${count} mail(s) to ${email}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function messageText(id: string): Promise<string> {
  const res = await fetch(`${API}/message/${id}`);
  const body = (await res.json()) as { Text: string };
  return body.Text;
}

/** The invitation token from the newest mail to `email`. */
export async function latestInviteToken(email: string, origin: string, count = 1): Promise<string> {
  const msgs = await waitForMessages(email, count);
  const newest = [...msgs].sort((a, b) => b.Created.localeCompare(a.Created))[0] as MailpitMessage;
  const text = await messageText(newest.ID);
  const m = new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/invite/([A-Za-z0-9_-]+)`).exec(text);
  if (!m) throw new Error(`no invite link in mail: ${text}`);
  return m[1] as string;
}
