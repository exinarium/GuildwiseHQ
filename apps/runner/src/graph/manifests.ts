import { basename } from 'node:path/posix';
import { sanitizeLabel } from './sanitize.ts';
import type { Manifest } from './modules.ts';

/** Reads the facts the graph needs from a package manifest. Never throws: a manifest it cannot read gives no facts. */
export function parseManifest(path: string, content: string): Manifest | null {
  const file = basename(path);
  try {
    if (file === 'package.json') return npm(path, content);
    if (file === 'go.mod') return goMod(path, content);
    if (file.endsWith('.csproj')) return dotnet(path, content);
    if (file === 'pyproject.toml') return pyproject(path, content);
    if (file === 'Cargo.toml') return cargo(path, content);
  } catch {
    return null;
  }
  return null;
}

function entryStrings(v: unknown, out: string[], depth = 0): void {
  if (depth > 4 || v == null) return;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) entryStrings(x, out, depth + 1);
  else if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) entryStrings(x, out, depth + 1);
}

function npm(path: string, content: string): Manifest {
  const j = JSON.parse(content) as Record<string, unknown>;
  const deps = new Set<string>();
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
    for (const d of Object.keys((j[k] as Record<string, unknown> | undefined) ?? {})) deps.add(d);
  const entries: string[] = [];
  for (const k of ['main', 'module', 'types', 'typings']) if (typeof j[k] === 'string') entries.push(j[k] as string);
  const exp = j.exports as Record<string, unknown> | string | undefined;
  if (typeof exp === 'string') entries.push(exp);
  else if (exp && typeof exp === 'object') entryStrings((exp as Record<string, unknown>)['.'] ?? exp, entries);
  const name = typeof j.name === 'string' ? sanitizeLabel(j.name, 128) : undefined;
  return { path, kind: 'npm', ...(name ? { name } : {}), deps: [...deps].sort(), entries };
}

function goMod(path: string, content: string): Manifest {
  const name = /^\s*module\s+(\S+)/m.exec(content)?.[1];
  const deps = new Set<string>();
  for (const m of content.matchAll(/^\s*(?:require\s+)?([A-Za-z0-9._~-]+\.[A-Za-z]{2,}\/[^\s]+)\s+v[0-9]/gm)) deps.add(m[1] as string);
  return { path, kind: 'go', ...(name ? { name: sanitizeLabel(name, 200) } : {}), deps: [...deps].sort(), entries: [] };
}

function dotnet(path: string, content: string): Manifest {
  const deps = new Set<string>();
  for (const m of content.matchAll(/<PackageReference\s+[^>]*Include="([^"]+)"/g)) deps.add(m[1] as string);
  for (const m of content.matchAll(/<ProjectReference\s+[^>]*Include="([^"]+)"/g))
    deps.add(basename((m[1] as string).replace(/\\/g, '/')).replace(/\.csproj$/, ''));
  return { path, kind: 'dotnet', name: basename(path).replace(/\.csproj$/, ''), deps: [...deps].sort(), entries: [] };
}

function pyproject(path: string, content: string): Manifest {
  const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(content)?.[1];
  const deps = new Set<string>();
  const block = /dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(content)?.[1] ?? '';
  for (const m of block.matchAll(/["']\s*([A-Za-z0-9_.-]+)/g)) deps.add((m[1] as string).toLowerCase());
  return { path, kind: 'python', ...(name ? { name: sanitizeLabel(name, 128) } : {}), deps: [...deps].sort(), entries: [] };
}

function cargo(path: string, content: string): Manifest {
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(content)?.[1];
  const deps = new Set<string>();
  const sec = /\[dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(content)?.[1] ?? '';
  for (const m of sec.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) deps.add(m[1] as string);
  return { path, kind: 'cargo', ...(name ? { name: sanitizeLabel(name, 128) } : {}), deps: [...deps].sort(), entries: [] };
}
