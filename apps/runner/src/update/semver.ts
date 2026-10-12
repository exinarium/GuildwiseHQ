/**
 * Semantic version comparison for the self-updater (a plain `a > b` on strings would call 0.1.10 older than 0.1.9).
 * Follows semver 2.0.0 precedence: numeric core, a pre-release sorts below its release, build metadata is ignored.
 */
export interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): ParsedVersion | null {
  const m = PATTERN.exec(text.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  };
}

const isNumeric = (s: string): boolean => /^\d+$/.test(s);

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. Throws on a string that is not a version. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa) throw new Error(`not a version: ${JSON.stringify(a)}`);
  if (!pb) throw new Error(`not a version: ${JSON.stringify(b)}`);
  for (let i = 0; i < 3; i++) {
    const d = (pa.core[i] as number) - (pb.core[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1; // a release is newer than its pre-releases
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (isNumeric(x) && isNumeric(y)) return Number(x) < Number(y) ? -1 : 1;
    if (isNumeric(x)) return -1; // numeric identifiers sort below alphanumeric ones
    if (isNumeric(y)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** True when `candidate` is a valid version strictly newer than `current`. Anything unparseable is "not newer". */
export function isNewer(candidate: string, current: string): boolean {
  try {
    return compareVersions(candidate, current) > 0;
  } catch {
    return false;
  }
}
