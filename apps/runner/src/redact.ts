/**
 * Secret redaction for text that is stored or shown: Bash commands (audit log, chat tool lines) and every other tool's
 * one-line summary (MCP tool input as JSON, WebFetch URLs). Apply it BEFORE cutting a summary to its display length, or
 * a secret that straddles the cut leaves its first characters behind.
 */
const KEY = String.raw`(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|auth(?:orization)?|credential|private[_-]?key|client[_-]?secret)`;

export function redactSecrets(text: string): string {
  return (
    text
      .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
      // JSON: "password":"x", "api_key": 123
      .replace(
        new RegExp(String.raw`("[\w-]*${KEY}[\w-]*"\s*:\s*)("(?:[^"\\]|\\.)*"?|[^,}\s]+)`, 'gi'),
        '$1"***"',
      )
      // URL query parameters
      .replace(
        /([?&](?:token|access_token|key|api[_-]?key|secret|client_secret|password|pass|sig|signature|auth|code)=)[^&\s"'#]+/gi,
        '$1***',
      )
      .replace(new RegExp(String.raw`(${KEY}[\w-]*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)`, 'gi'), '$1***')
      .replace(/(--?(?:p|pass(?:word)?)\s+)\S+/gi, '$1***')
      .replace(
        /\b(sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|xox[abp]-[A-Za-z0-9-]{10,})\b/g,
        '***',
      )
  );
}
