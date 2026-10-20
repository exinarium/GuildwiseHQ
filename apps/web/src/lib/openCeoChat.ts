/**
 * Opens the CEO chat with a message waiting in the composer-to-send (docs/design/ceo-front-door.md sections 4.3 and 8): the
 * prefill and context chips ride in the navigation state and `CeoChatLauncher` / the chat page send them once.
 */
export interface OpenCeoChatOptions {
  /** The message to send (or put in the composer). */
  prefill?: string;
  /** Context lines (page, project, card...) added under the message. */
  context?: string[];
}

export interface CeoChatLocationState {
  ceoPrefill?: string;
}

/** The message text with its context lines. */
export function prefillMessage(o: OpenCeoChatOptions): string {
  const text = (o.prefill ?? '').trim();
  if (!o.context || o.context.length === 0) return text;
  return `${text}\n\nContext (from the page I was on):\n${o.context.map((c) => `- ${c}`).join('\n')}`;
}

/** Every CEO thread lives on the CEO chat page (`/chat/:id` redirects CEO threads here). */
export const ceoChatPath = (threadId: string) => `/ceo-chat/${threadId}`;

/** Navigates to the CEO thread with the prefill in the router state. */
export function openCeoChat(
  nav: (to: string, opts?: { state?: CeoChatLocationState }) => void,
  threadId: string,
  o: OpenCeoChatOptions = {},
): void {
  const msg = prefillMessage(o);
  nav(ceoChatPath(threadId), msg ? { state: { ceoPrefill: msg } } : {});
}
