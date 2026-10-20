/**
 * Secret redaction. A secret registered here (the sudo password) is replaced by `***` in every log line the runner
 * writes and in the output of every command it runs for the DevOps engineer. The registry is process-wide on purpose:
 * the logger, the executor and the progress batches all pass their text through `redact`.
 */
const secrets = new Set<string>();

export function registerSecret(secret: string): void {
  if (secret.length >= 3) secrets.add(secret);
}

export function unregisterSecret(secret: string): void {
  secrets.delete(secret);
}

export function redact(text: string): string {
  if (secrets.size === 0 || !text) return text;
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join('***');
  return out;
}

/** Shapes of secrets that no registry knows: private keys, cloud and forge tokens, JWTs, bearer headers, `password=` values. */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|aomr_[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*)?)/g,
];
const URL_CREDENTIALS = /(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g;
const KEYED_SECRET =
  /((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credentials?)[\w-]*["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;

/**
 * `redact` plus the common secret shapes. For text that leaves the runner for the server (a deploy's log tail): the script's
 * output may print a secret nobody registered.
 */
export function redactSecrets(text: string): string {
  let out = redact(text);
  if (!out) return out;
  for (const re of PATTERNS) out = out.replace(re, '***');
  return out.replace(URL_CREDENTIALS, '$1***@').replace(KEYED_SECRET, '$1***');
}
