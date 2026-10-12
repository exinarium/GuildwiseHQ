import { parseRemote } from './index.ts';

/** Remote url conversion between https and ssh (SSH as an alternative to API tokens). Pure string work, no I/O. */

export type GitAccessMethod = 'https' | 'ssh';

interface RemoteParts {
  scheme: 'ssh' | 'https';
  host: string;
  /** Without a trailing slash; the `.git` suffix is kept. */
  path: string;
  port?: string;
}

function clean(path: string): string {
  return path
    .replace(/[?#].*$/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/** Splits a remote url keeping the case of the path (`normalizeRemoteUrl` lower-cases it). */
function splitRemote(url: string): RemoteParts | null {
  const s = url.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/\/)(.+)$/.exec(s);
  if (scp) return { scheme: 'ssh', host: (scp[1] as string).toLowerCase(), path: clean(scp[2] as string) };
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.*)$/i.exec(s);
  if (!m) return null;
  const scheme = (m[1] as string).toLowerCase();
  if (scheme !== 'ssh' && scheme !== 'https' && scheme !== 'http') return null;
  return {
    scheme: scheme === 'ssh' ? 'ssh' : 'https',
    host: (m[2] as string).toLowerCase(),
    path: clean(m[4] as string),
    ...(m[3] ? { port: m[3] } : {}),
  };
}

/** True for `git@host:path` and `ssh://` remotes. */
export function isSshRemote(url: string): boolean {
  return splitRemote(url)?.scheme === 'ssh';
}

/**
 * The ssh form of a remote: `git@github.com:acme/web.git`, `git@gitlab.com:group/sub/web.git`,
 * `git@bitbucket.org:ws/repo.git`, `git@ssh.dev.azure.com:v3/org/project/repo`. An ssh remote is returned as it is.
 * Null when it cannot be derived (Bitbucket Data Center: its ssh port is not in the https url; give the ssh url).
 */
export function sshRemoteUrl(url: string): string | null {
  const p = splitRemote(url);
  if (!p) return null;
  if (p.scheme === 'ssh') return url.trim();
  const base = p.path.replace(/\.git$/i, '');
  if (!base) return null;
  if (p.host === 'dev.azure.com') {
    const m = /^([^/]+)\/([^/]+)\/_git\/([^/]+)$/.exec(base);
    return m ? `git@ssh.dev.azure.com:v3/${m[1]}/${m[2]}/${m[3]}` : null;
  }
  if (parseRemote(url)?.kind === 'bitbucket-dc') return null;
  return `git@${p.host}:${base}.git`;
}

/** The https form of a remote (the way back from ssh). An https remote is returned as it is; null when unknown. */
export function httpsRemoteUrl(url: string): string | null {
  const p = splitRemote(url);
  if (!p) return null;
  if (p.scheme === 'https') return url.trim();
  if (p.host === 'ssh.dev.azure.com') {
    const m = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(p.path);
    return m ? `https://dev.azure.com/${m[1]}/${m[2]}/_git/${m[3]}` : null;
  }
  // Bitbucket Data Center over ssh: ssh://git@host:7999/PROJ/repo.git <-> https://host/scm/PROJ/repo.git
  if (p.port && p.path.split('/').length === 2) return `https://${p.host}/scm/${p.path}`;
  return `https://${p.host}/${p.path}`;
}

/** The remote url for an access method; null when the conversion is not possible. */
export function remoteUrlForMethod(url: string, method: GitAccessMethod): string | null {
  return method === 'ssh' ? sshRemoteUrl(url) : httpsRemoteUrl(url);
}

/** The host name `ssh` connects to for a git host (Azure DevOps has its own ssh host). */
export function sshHostFor(host: string): string {
  return host === 'dev.azure.com' ? 'ssh.dev.azure.com' : host;
}

/** The git host a settings entry is keyed by (`ssh.dev.azure.com` -> `dev.azure.com`). */
export function settingsHostFor(host: string): string {
  return host === 'ssh.dev.azure.com' ? 'dev.azure.com' : host.toLowerCase();
}
