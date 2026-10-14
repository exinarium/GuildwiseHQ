import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/** Parses a dotenv file: `KEY=value`, `export KEY=value`, quotes, `#` comments. No expansion. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = (m[2] as string).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      const q = v[0];
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = v.search(/\s#/);
      if (hash !== -1) v = v.slice(0, hash).trim();
    }
    out[m[1] as string] = v;
  }
  return out;
}

/**
 * Reads an env file for a service. The file must be an absolute path outside every worktree and the runner's data
 * directory (a secret file never lives in a repository); returns its variables or throws with the reason.
 */
export function readEnvFile(path: string, forbiddenRoots: string[]): Record<string, string> {
  if (!isAbsolute(path))
    throw new Error(`the env file must be an absolute path on this workstation: ${path}`);
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new Error(`the env file does not exist: ${path}`);
  }
  for (const root of forbiddenRoots) {
    let r: string;
    try {
      r = realpathSync(root);
    } catch {
      r = resolve(root);
    }
    if (real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))
      throw new Error(
        `the env file must be outside the repositories' worktrees and the runner's data folder: ${path}`,
      );
  }
  return parseDotenv(readFileSync(real, 'utf8'));
}

/**
 * `${port}`, `${<port name>}`, `${<service>.port}` and `${<service>.<port name>}` templates. `own` is the service being
 * started. Unknown templates are left as they are.
 */
export function substitute(
  text: string,
  own: { ports: Array<{ name: string; port: number }> },
  services: ReadonlyMap<string, { ports: Array<{ name: string; port: number }> }>,
): string {
  return text.replace(/\$\{([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?\}/g, (whole, a: string, b?: string) => {
    if (b === undefined) {
      if (a === 'port') return own.ports[0] ? String(own.ports[0].port) : whole;
      const p = own.ports.find((x) => x.name.toLowerCase() === a.toLowerCase());
      return p ? String(p.port) : whole;
    }
    const svc = services.get(a.toLowerCase());
    if (!svc) return whole;
    if (b === 'port') return svc.ports[0] ? String(svc.ports[0].port) : whole;
    const p = svc.ports.find((x) => x.name.toLowerCase() === b.toLowerCase());
    return p ? String(p.port) : whole;
  });
}

/** Replaces every known secret value in a log line. Values shorter than 6 characters are too ambiguous to hide. */
export function redactValues(line: string, secrets: ReadonlySet<string>): string {
  let out = line;
  for (const s of secrets) if (s.length >= 6 && out.includes(s)) out = out.split(s).join('***');
  return out;
}
