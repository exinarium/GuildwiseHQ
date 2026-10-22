/**
 * Applying an accepted proposal to a markdown document: replace the body of the section whose heading matches
 * `heading` (case-insensitive, ignoring leading `#`s and numbering such as `3.`), or append the section when there is
 * none. Without a heading the change is appended. Pure.
 */
const headingText = (line: string): string =>
  line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\d+(\.\d+)*[.)]?\s+/, '')
    .trim()
    .toLowerCase();

export function applyDocSection(content: string, heading: string | undefined | null, change: string): string {
  const body = change.replace(/\s+$/, '');
  if (!heading?.trim()) return `${content.replace(/\s+$/, '')}\n\n${body}\n`;
  const want = headingText(heading);
  const lines = content.split('\n');
  let fence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+\S/.exec(line);
    if (m && headingText(line) === want) {
      start = i;
      level = (m[1] as string).length;
      break;
    }
  }
  if (start === -1) {
    const title = heading.replace(/^#+\s*/, '').trim();
    return `${content.replace(/\s+$/, '')}\n\n## ${title}\n\n${body}\n`;
  }
  let end = lines.length;
  fence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+\S/.exec(line);
    if (m && (m[1] as string).length <= level) {
      end = i;
      break;
    }
  }
  const head = lines.slice(0, start + 1).join('\n');
  const tail = lines.slice(end).join('\n');
  return `${head}\n\n${body}\n${tail ? `\n${tail}` : ''}`.replace(/\n*$/, '\n');
}
