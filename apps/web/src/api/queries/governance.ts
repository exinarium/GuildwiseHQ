import {
  type AgentMayDo,
  AgentMayDoSchema,
  type AuditExportQuery,
  type DeskActionApplied,
  type DeskActionPreview,
  DeskActionPreviewSchema,
  type SetAgentGateRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getActiveOrgId } from '../../lib/activeOrg.ts';
import { ApiError, get, post, put, qs } from '../client.ts';

/** `/m/desk/:token`: what the one-tap link would do. Opening it changes nothing. */
export function useDeskActionPreview(token: string) {
  return useQuery({
    queryKey: ['desk-action', token],
    queryFn: () => get<DeskActionPreview>(`/m/desk/${encodeURIComponent(token)}`, DeskActionPreviewSchema),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

/** Applies the link's action (POST): once, for the person it was made for. */
export function useApplyDeskAction(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<DeskActionApplied>(`/m/desk/${encodeURIComponent(token)}/apply`, {}),
    onSuccess: () => {
      for (const key of ['desk', 'board', 'card']) void qc.invalidateQueries({ queryKey: [key] });
      void qc.invalidateQueries({ queryKey: ['desk-action', token] });
    },
  });
}

/** One agent's "What it may do": tools, repos, data, provider, grants, spend, gates. */
export function useMayDo(agentId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['may-do', agentId],
    queryFn: () => get<AgentMayDo>(`/agents/${agentId}/may-do`, AgentMayDoSchema),
  });
}

export function useSetAgentGate(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: SetAgentGateRequest) => put<AgentMayDo>(`/agents/${agentId}/gates`, v),
    onSuccess: (data) => qc.setQueryData(['may-do', agentId], data),
  });
}

/** The details of a refused grant (409 `scopes_missing`): what the capability needs and what the agent lacks. */
export function scopesMissing(
  e: unknown,
): { required: Array<{ scope: string; label: string; has: boolean }>; missing: string[] } | null {
  if (e instanceof ApiError && e.status === 409 && e.code === 'scopes_missing') {
    const d = e.details as
      | { required?: Array<{ scope: string; label: string; has: boolean }>; missing?: string[] }
      | undefined;
    return { required: d?.required ?? [], missing: d?.missing ?? [] };
  }
  return null;
}

/**
 * Downloads the audit export through a normal fetch (the organization travels in a header, which a plain link cannot send) and
 * hands the browser the file. Returns the file name.
 */
export async function downloadAuditExport(q: Partial<AuditExportQuery>): Promise<string> {
  const headers: Record<string, string> = {};
  const org = getActiveOrgId();
  if (org) headers['x-aom-org'] = org;
  const res = await fetch(
    `/api/org/audit/export${qs({ format: q.format ?? 'csv', from: q.from, to: q.to, actorUserId: q.actorUserId, type: q.type })}`,
    { credentials: 'include', headers },
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let code = 'http_error';
    try {
      const j = (await res.json()) as { error?: { message?: string; code?: string } };
      msg = j.error?.message ?? msg;
      code = j.error?.code ?? code;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, code, msg);
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
    `audit.${q.format ?? 'csv'}`;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
