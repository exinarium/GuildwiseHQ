/** One standing order as the prompts carry it. */
export interface PromptStandingOrder {
  title: string;
  body: string;
}

/**
 * The "Standing orders" section of an agent prompt that is not a card shift (DevOps, chats, BA tasks). They bind the
 * agent: they override the role's defaults and its own habits, and only the manager's current instruction in the same
 * conversation can outrank them. Card shifts render theirs in `renderInstructions` (backlog #75).
 */
export function renderBindingStandingOrders(
  orders: readonly PromptStandingOrder[] | undefined,
  heading = '# Standing orders',
): string {
  if (!orders || orders.length === 0) return `${heading}\n\nNone.`;
  return [
    heading,
    "These are the owner's binding rules for this organization and the projects involved. Follow them in everything you do here. Where one conflicts with your role instructions or your usual way of working, the standing order wins; if a request would break one, say so instead of breaking it. Do not ask the owner again for something a standing order already decides.",
    orders.map((s) => `## ${s.title}\n${s.body.trim()}`).join('\n\n'),
  ].join('\n\n');
}
