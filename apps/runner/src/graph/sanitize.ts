import { redact } from '../secrets/redact.ts';

/**
 * Text that comes out of a repository (symbol names, markdown headings, file names) is untrusted data and may hold a
 * secret. It is cleaned before it is written to a shard, put in a brief, or answered to an agent
 * (docs/design/project-graphs.md sections 5 and 14).
 */

const SECRET_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  // a long unbroken run of hex or base64: a key, a hash of a secret, a token
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{48,}={0,2}/g,
];

/** Replaces anything that looks like a credential, and anything in the runner's secrets registry. */
export function scrubSecrets(text: string): string {
  let out = redact(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

// Matching control characters is the point of this pattern.
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips control and bidi characters from labels
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** A label for a node: control and bidi characters removed, whitespace collapsed, secrets scrubbed, at most 256 characters. */
export function sanitizeLabel(text: string, max = 256): string {
  const clean = scrubSecrets(text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim());
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Wraps untrusted repository text for a prompt: fenced, labelled as data, with the fence made impossible to close from
 * inside (a run of backticks in the text is broken up).
 */
export function fenceUntrusted(label: string, text: string): string {
  const body = text
    .replace(/<\/?untrusted-data/gi, '[tag removed]')
    .replace(/`{3,}/g, (m) => m.split('').join('\u200b'));
  return `<untrusted-data source="${label}">\n${body}\n</untrusted-data>`;
}
