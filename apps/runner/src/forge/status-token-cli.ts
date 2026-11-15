import type { StatusTokenStore } from './status-tokens.ts';

/** What to create on GitHub: printed before the token is asked for. */
export const STATUS_TOKEN_SETTINGS_LINES = [
  'Create a fine-grained personal access token on GitHub with exactly these settings:',
  '  Resource owner:         the owner of the project repositories',
  '  Repository access:      only the project repositories',
  '  Repository permissions: Commit statuses = Read and write (nothing else)',
  'Note its expiry date: when it expires, the size check stops being posted.',
];

/** `status` lines: which hosts have a token, never the value. */
export function statusTokenStatusLines(store: StatusTokenStore): string[] {
  const problem = store.problem();
  if (problem) return [problem];
  const l = store.list();
  return l.length ? l.map((t) => `${t.key}: present (saved ${t.savedAt})`) : ['no status tokens saved'];
}

/** Saves the token for a host. The token goes into the sealed store and nowhere else. */
export function saveStatusToken(input: {
  store: StatusTokenStore;
  host: string;
  token: string;
}): { ok: true } | { ok: false; error: string } {
  const host = input.host.trim().toLowerCase();
  if (!host || /[/\s]/.test(host)) return { ok: false, error: 'not a usable host name' };
  const token = input.token.trim();
  if (!token) return { ok: false, error: 'no token entered' };
  input.store.set('github', host, token);
  return { ok: true };
}
