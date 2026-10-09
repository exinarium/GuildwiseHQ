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
