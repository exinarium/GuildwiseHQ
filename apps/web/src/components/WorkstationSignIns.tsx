import { mcpSignInInstruction, type WorkstationDto } from '@aom/shared';
import { Callout } from './ui.tsx';

/** What on this workstation needs a sign-in the manager must do on the machine: the Claude login, plugin MCP servers. */
export function signInProblems(w: WorkstationDto): {
  claude: boolean;
  mcp: Array<{ name: string; server: string }>;
} {
  return {
    claude: w.runtimes.some((r) => r.id === 'claude-code' && r.auth === 'expired'),
    mcp: (w.mcpServers ?? []).filter((s) => s.authState === 'needs_sign_in'),
  };
}

export function WorkstationSignIns({ w }: { w: WorkstationDto }) {
  const p = signInProblems(w);
  if (!p.claude && p.mcp.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="sign-in-problems">
      {p.claude && (
        <Callout tone="warning" data-testid="claude-login-expired">
          Claude login expired: agents on {w.name} are paused and waiting. On that machine run{' '}
          <code className="font-mono text-xs">claude</code>, then{' '}
          <code className="font-mono text-xs">/login</code> (or{' '}
          <code className="font-mono text-xs">claude setup-token</code>, see the runner help). Work resumes by
          itself once it works.
        </Callout>
      )}
      {p.mcp.map((s) => (
        <Callout key={s.name} tone="warning" data-testid={`mcp-sign-in-${s.name}`}>
          Needs sign-in: {mcpSignInInstruction(s.server, w.name)}
        </Callout>
      ))}
    </div>
  );
}
