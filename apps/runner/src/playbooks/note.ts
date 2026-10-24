/**
 * The paragraph of an agent's instructions about `aom playbook run`: written only when the agent was granted playbooks (the
 * server sends the keys with the shift or chat start; it checks the grant again for every call). Empty without a grant, so an
 * agent that was never granted one is not even told the verb exists.
 */
export function playbookNote(grants: readonly string[] | undefined): string {
  if (!grants?.length) return '';
  return [
    '# Starting a playbook',
    `You were granted these playbooks: ${grants.map((g) => `\`${g}\``).join(', ')}. When the work calls for one, start it with \`aom playbook run <key> [--input "<what you want from it>"]\`. It opens a guided session for the owner (question cards, a panel, drafts) and puts it on their desk; the owner's answers are needed, so do not wait for it and do not answer for them. You may start a playbook that is not in this list: the server refuses it.`,
  ].join('\n');
}
