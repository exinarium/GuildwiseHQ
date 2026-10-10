/**
 * Files that look like secrets. Repository hygiene never copies them into a saved-work branch (owner decision G-Q7):
 * they stay exactly where they are on the user's machine and the notice names them.
 */
const CODE_OR_DOC =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|md|mdx|txt|cs|java|kt|go|rs|c|h|cpp|hpp|css|scss|html|vue|svelte|rb|php|swift|sh|ps1|sql)$/i;
const KEY_MATERIAL = /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg|kdbx)$/i;
const FIXED_NAMES = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.netrc|\.pypirc|\.htpasswd)$/i;
const SECRET_WORDS = /key|secret|token|password|passwd|credential/i;

export function looksLikeSecret(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  if (/^\.env\.(example|sample|template|dist)$/i.test(name)) return false; // templates hold no values
  if (/^\.env($|\.)/i.test(name) || KEY_MATERIAL.test(name) || FIXED_NAMES.test(name)) return true;
  // `keyboard.ts` or `secrets.md` are source or notes, not credentials; `api-key.json` or `token.txt`-like data files are.
  return SECRET_WORDS.test(name) && !CODE_OR_DOC.test(name);
}

/** The saved-work branch of a day: `guildwise/saved-work/2026-10-10`. */
export const SAVED_WORK_PREFIX = 'guildwise/saved-work/';
export const savedWorkBranch = (date: Date, suffix = ''): string =>
  `${SAVED_WORK_PREFIX}${date.toISOString().slice(0, 10)}${suffix}`;
