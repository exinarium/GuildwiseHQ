/**
 * Text written by other people (messages, notes, names, answers) that is put into a model prompt. None of it may pass for
 * the prompt's own structure: bodies are fenced and their structural lines neutralised, names and one-line fields are
 * reduced to one plain line, and the JSON header comment cannot be closed from inside. Pure.
 */

const clipTo = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One plain line: every run of whitespace (newlines included) becomes one space. */
export function oneLine(s: string, max = 600): string {
  return clipTo(s.replace(/\s+/g, ' ').trim(), max);
}

/** A person's or seat's name as it is shown in a prompt: one line, none of the characters that give text structure. */
export function safeName(s: string, max = 60): string {
  return oneLine(s.replace(/[*_`<>[\]|:#"\\]/g, ''), max) || 'someone';
}

/** Defuses lines that would pass for the prompt's structure (a heading, a `**Name:**` speaker line, a comment) and our tags. */
export function neutralizeBody(body: string): string {
  return body
    .replace(/<(\/?)(message|transcript)\b/gi, '&lt;$1$2')
    .replace(/<!--/g, '&lt;!--')
    .split('\n')
    .map((line) =>
      /^\s*(#{1,6}(\s|$)|\*\*[^*\n]{1,100}:\*\*|-{3,}\s*$|={3,}\s*$)/.test(line) ? `\\${line}` : line,
    )
    .join('\n');
}

/** One message of a transcript, fenced so the model can tell where it begins and ends and who wrote it. */
export function fenceMessage(author: string, role: string | undefined, body: string): string {
  return `<message from="${safeName(author)}"${role ? ` role="${safeName(role)}"` : ''}>\n${neutralizeBody(body.trim())}\n</message>`;
}

/** JSON for the `<!--...-->` header of a prompt: `<` and `>` are escaped, so no value can close the comment. */
export function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}
