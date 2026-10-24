export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** A line diff of two texts (longest common subsequence): what the instructions of a role lose and gain in a new version. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: length of the common subsequence of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] as string });
      i++;
      j++;
    } else if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number)) {
      out.push({ kind: 'del', text: a[i++] as string });
    } else out.push({ kind: 'add', text: b[j++] as string });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] as string });
  while (j < m) out.push({ kind: 'add', text: b[j++] as string });
  return out;
}
