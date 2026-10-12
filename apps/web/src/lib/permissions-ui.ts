import { type AgentPermissions, COMMON_DENIED_SHELL } from '@aom/shared';

/**
 * The role builder's "What it may do" switches (docs/design/workflow-builder.md section 3): plain-language toggles
 * that map to `AgentPermissions`, each with a risk badge and a note. Pure, so the mapping is tested without a DOM.
 * `checkPermissions` (shared) stays the gate for hires and the Owner stays the only one who widens (`ownerOnly`).
 */
export type Risk = 'low' | 'medium' | 'high';

export type ToggleId = 'read' | 'edit' | 'shell' | 'web' | 'commit' | 'browser' | 'readOrgRepos';

export interface PermissionToggle {
  id: ToggleId;
  label: string;
  /** What switching it on gives the role, in plain words. */
  does: string;
  risk: Risk;
  /** Why it matters. */
  riskNote: string;
  /** Always on and not changeable. */
  fixed?: boolean;
  /** Only the organization Owner may switch it on (or off) in a role. */
  ownerOnly?: boolean;
}

export const PERMISSION_TOGGLES: readonly PermissionToggle[] = [
  {
    id: 'read',
    label: 'Read files',
    does: 'Look at the project files in its card copy.',
    risk: 'low',
    riskNote: 'Low risk: reading changes nothing. Every role can read.',
    fixed: true,
  },
  {
    id: 'edit',
    label: 'Change files',
    does: 'Create, edit and delete files in its own copy of the project.',
    risk: 'medium',
    riskNote:
      'Medium risk: it can change the files of the card copy. Nothing reaches the main branch without review.',
  },
  {
    id: 'shell',
    label: 'Run commands',
    does: 'Run programs such as tests and builds on the workstation, inside the sandbox.',
    risk: 'high',
    riskNote:
      'High risk: it can run programs on the workstation (sandboxed). Pushing, rebasing, switching branches and sudo stay blocked.',
  },
  {
    id: 'web',
    label: 'Search the web',
    does: 'Look things up and read web pages.',
    risk: 'medium',
    riskNote: 'Medium risk: web pages are untrusted and may try to instruct the agent (prompt injection).',
  },
  {
    id: 'commit',
    label: 'Save its work (commit)',
    does: 'Save its changes as commits on the card branch.',
    risk: 'medium',
    riskNote: 'Medium risk: commits are kept on the card branch; nothing is pushed.',
  },
  {
    id: 'browser',
    label: 'Run browsers',
    does: 'Start a browser, for example to test a web page.',
    risk: 'high',
    riskNote:
      'High risk: the sandbox lets it create Unix sockets so the browser can start. Docker, SSH agent and similar sockets stay hidden.',
  },
  {
    id: 'readOrgRepos',
    label: 'Read all organization repositories',
    does: 'Read (never change) every repository of the organization on the workstation.',
    risk: 'high',
    riskNote:
      'High risk: read only, but wide. The role sees code of projects it is not working on. Only the Owner can switch this on.',
    ownerOnly: true,
  },
];

export const RISK_TONE: Record<Risk, 'green' | 'amber' | 'red'> = {
  low: 'green',
  medium: 'amber',
  high: 'red',
};
export const RISK_LABEL: Record<Risk, string> = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };

/** Whether a toggle is on for these permissions. */
export function toggleOn(p: AgentPermissions, id: ToggleId): boolean {
  switch (id) {
    case 'read':
      return true;
    case 'edit':
    case 'shell':
    case 'web':
      return p.allowedTools.includes(id);
    case 'commit':
      return p.mayCommit;
    case 'browser':
      return p.browser ?? false;
    case 'readOrgRepos':
      return p.readOrgRepos ?? false;
  }
}

/** The permissions after switching a toggle: `read` is always kept, `shell` brings the standard denied patterns. */
export function applyToggle(p: AgentPermissions, id: ToggleId, on: boolean): AgentPermissions {
  const tools = new Set(p.allowedTools);
  tools.add('read');
  const next: AgentPermissions = { ...p };
  switch (id) {
    case 'read':
      break;
    case 'edit':
    case 'web':
    case 'shell':
      if (on) tools.add(id);
      else tools.delete(id);
      if (id === 'shell' && on && p.deniedShellPatterns.length === 0)
        next.deniedShellPatterns = [...COMMON_DENIED_SHELL];
      break;
    case 'commit':
      next.mayCommit = on;
      break;
    case 'browser':
      next.browser = on;
      break;
    case 'readOrgRepos':
      next.readOrgRepos = on;
      break;
  }
  // Keep the order stable: the four basic tools first, MCP tools after.
  const order = ['read', 'edit', 'shell', 'web'];
  next.allowedTools = [...tools].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return next;
}

/** Names of the external (MCP) tools a role may use. */
export const mcpToolsOf = (p: AgentPermissions): string[] =>
  p.allowedTools.filter((t) => t.startsWith('mcp:')).map((t) => t.slice(4));

export function withMcpTools(p: AgentPermissions, names: readonly string[]): AgentPermissions {
  const base = p.allowedTools.filter((t) => !t.startsWith('mcp:'));
  const mcp = [...new Set(names.map((n) => n.trim()).filter(Boolean))].map((n) => `mcp:${n}`);
  return { ...p, allowedTools: [...base, ...mcp] };
}

/** The folders a role is limited to (`writableGlobs`); null: the whole card copy. */
export function withFolderLimit(p: AgentPermissions, globs: string[] | null): AgentPermissions {
  return { ...p, writableGlobs: globs };
}

/** "This role can: ... It cannot: ..." from the definition (plain sentences). */
export function permissionSummary(p: AgentPermissions): { can: string[]; cannot: string[] } {
  const can: string[] = ['read the project files'];
  const cannot: string[] = [];
  const has = (id: ToggleId) => toggleOn(p, id);
  const pick = (id: ToggleId, yes: string, no: string) => (has(id) ? can.push(yes) : cannot.push(no));
  if (has('edit'))
    can.push(p.writableGlobs?.length ? `change files in ${p.writableGlobs.join(', ')}` : 'change files');
  else cannot.push('change files');
  pick('shell', 'run commands (sandboxed)', 'run commands');
  pick('web', 'search the web', 'search the web');
  pick('commit', 'commit its work', 'commit');
  pick('browser', 'run browsers', 'run browsers');
  if (has('readOrgRepos')) can.push('read every repository of the organization');
  const mcp = mcpToolsOf(p);
  if (mcp.length) can.push(`use external tools: ${mcp.join(', ')}`);
  // Always true for every role (the runner enforces it).
  cannot.push('push, rebase or switch branches');
  return { can, cannot };
}
