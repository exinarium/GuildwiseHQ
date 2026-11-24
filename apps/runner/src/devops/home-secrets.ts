/**
 * Credential stores in the real home that no agent has any business reading (claude-policy.ts `HOME_SECRETS`). Kept in a
 * module of its own so the DevOps guard hook (devops/guard.ts) can use it without loading the policy builder.
 */
export const HOME_SECRET_ENTRIES: readonly string[] = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.config/gh',
  '.config/gcloud',
  '.claude',
  '.claude.json',
  // browser profiles (cookies, saved logins), R18-L
  '.mozilla',
  '.config/google-chrome',
  '.config/chromium',
  '.config/BraveSoftware',
  '.config/microsoft-edge',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox',
  'Library/Application Support/BraveSoftware',
];
