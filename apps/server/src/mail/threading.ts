import { parseAddress } from '@aom/shared';
import type { Config } from '../config.ts';

/**
 * Thread headers of outgoing mail (docs/design/workflow-builder.md D9). A reply to a mail we sent carries our
 * Message-ID in `In-Reply-To`/`References`, which is how the mail program of the recipient groups the conversation and
 * how an inbound reply is matched to the thread it belongs to. The ids are deterministic (a function of ids we store),
 * so a retry sends the same header and nothing has to be remembered.
 */

export interface ThreadHeaders {
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}

/** The domain Message-IDs are made on: the sender's own (`AOM_SUPPORT_FROM` / `AOM_MAIL_FROM`), else the public origin's host. */
export function mailDomain(config: Pick<Config, 'supportFrom' | 'mailFrom' | 'publicOrigin'>): string {
  for (const from of [config.supportFrom, config.mailFrom]) {
    const a = parseAddress(from);
    if (a && !a.endsWith('.local')) return a.slice(a.indexOf('@') + 1);
  }
  try {
    return new URL(config.publicOrigin).hostname;
  } catch {
    return 'guildwise.invalid';
  }
}

const idOf = (kind: string, parts: string[], domain: string): string =>
  `<${kind}.${parts.join('.')}@${domain}>`;

/**
 * Headers for message number `n` of a conversation `key` (a support ticket, a mail thread): the first message is the
 * root, every later one answers the one before and lists all earlier ids in `References`.
 */
export function conversationHeaders(
  domain: string,
  kind: string,
  key: string,
  /** The ids of the messages already sent in this conversation, oldest first (not the root). */
  earlier: string[],
  /** This message's own id; absent: this is the root message of the conversation. */
  own?: string,
): ThreadHeaders {
  const root = idOf(kind, [key], domain);
  if (!own) return { messageId: root };
  const prior = earlier.map((id) => idOf(kind, [key, id], domain));
  return {
    messageId: idOf(kind, [key, own], domain),
    inReplyTo: prior.at(-1) ?? root,
    references: [root, ...prior],
  };
}

/** `acme-x7k2p9m4qd+thr4g8h2j@in.example.com`: the inbox address with the thread token, so a reply finds its thread. */
export function replyAddressFor(inboxAddress: string, token: string): string {
  const at = inboxAddress.lastIndexOf('@');
  return `${inboxAddress.slice(0, at)}+${token}${inboxAddress.slice(at)}`;
}
