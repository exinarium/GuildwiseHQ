/**
 * A unified diff (`git diff` output) split into files and lines for the diff view of the owner approval (lean team). No
 * dependency: the view only needs the file headers, the hunks and what each line is (added, removed, context, hunk header).
 */

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line numbers in the old and the new file (context and hunk lines of a hunk). */
  oldNo?: number;
  newNo?: number;
}

export interface DiffFile {
  /** The path shown: the new name, or the old one for a deletion. */
  path: string;
  oldPath: string | null;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';
  added: number;
  removed: number;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Splits a unified diff into files with classified lines. Unknown text before the first file is kept as one `meta` file. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const start = (path: string, oldPath: string | null): DiffFile => {
    const f: DiffFile = { path, oldPath, status: 'modified', added: 0, removed: 0, lines: [] };
    files.push(f);
    return f;
  };
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  for (const raw of all) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (header) {
      cur = start(header[2] as string, header[1] === header[2] ? null : (header[1] as string));
      cur.lines.push({ kind: 'meta', text: raw });
      inHunk = false;
      continue;
    }
    if (!cur) {
      // a note before the first file (or a diff that does not start with `diff --git`)
      if (raw.trim() === '') continue;
      cur = start('(diff)', null);
    }
    if (!inHunk) {
      if (raw.startsWith('new file mode')) cur.status = 'added';
      else if (raw.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (raw.startsWith('rename from ') || raw.startsWith('rename to ')) cur.status = 'renamed';
      else if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch')) cur.status = 'binary';
    }
    const h = HUNK.exec(raw);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      inHunk = true;
      cur.lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (!inHunk) {
      if (raw !== '') cur.lines.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      cur.added++;
      cur.lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith('-')) {
      cur.removed++;
      cur.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ });
    } else if (raw.startsWith('\\')) {
      cur.lines.push({ kind: 'meta', text: raw });
    } else {
      cur.lines.push({
        kind: 'ctx',
        text: raw.startsWith(' ') ? raw.slice(1) : raw,
        oldNo: oldNo++,
        newNo: newNo++,
      });
    }
  }
  return files;
}

/** Totals over a list of files. */
export function diffTotals(files: readonly DiffFile[]): { files: number; added: number; removed: number } {
  return {
    files: files.length,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
  };
}
