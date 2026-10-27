import {
  type CreateDepartmentRequest,
  DepartmentsResponseSchema,
  type DraftResponse,
  type ExtendRoleRequest,
  OrgCatalogueResponseSchema,
  type RoleDraftInput,
  type RolePreviewRequest,
  RolePreviewResponseSchema,
  type RoleSetStatusResponse,
  RoleSetStatusSchema,
  type SetRoleSetRequest,
  type SubmitResponse,
  SubworkflowTargetsResponseSchema,
  type ValidateResponse,
  type WorkflowDraftInput,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, del, get, post, qs } from '../client.ts';

/** The organization designer's whole view. `projectId`: the organization that owns a shared project. */
export function useOrgCatalogue(projectId?: string) {
  return useQuery({
    queryKey: ['org', 'catalogue', projectId ?? 'own'],
    queryFn: () => get(`/org/catalogue${qs({ projectId })}`, OrgCatalogueResponseSchema),
  });
}

/** What the sub-workflow step editor can start and where (`GET /api/subworkflow-targets`). */
export function useSubworkflowTargets(projectId?: string) {
  return useQuery({
    queryKey: ['org', 'subworkflow-targets', projectId ?? 'own'],
    queryFn: () => get(`/subworkflow-targets${qs({ projectId })}`, SubworkflowTargetsResponseSchema),
  });
}

export function useDepartments(projectId?: string) {
  return useQuery({
    queryKey: ['org', 'departments', projectId ?? 'own'],
    queryFn: async () =>
      (await get(`/departments${qs({ projectId })}`, DepartmentsResponseSchema)).departments,
  });
}

function useOrgMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of ['org', 'roles', 'workflows', 'desk', 'hr', 'agents'])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

type Ctx = { projectId?: string };
const q = (c: Ctx) => qs({ projectId: c.projectId });

export const useSaveRoleDraft = () =>
  useOrgMutation((v: Ctx & { id?: string; input: RoleDraftInput }) =>
    v.id
      ? api<DraftResponse>('PUT', `/roles/${v.id}${q(v)}`, v.input)
      : post<DraftResponse>(`/roles${q(v)}`, v.input),
  );

export const useSaveWorkflowDraft = () =>
  useOrgMutation((v: Ctx & { id?: string; input: WorkflowDraftInput }) =>
    v.id
      ? api<DraftResponse>('PUT', `/workflows/${v.id}${q(v)}`, v.input)
      : post<DraftResponse>(`/workflows${q(v)}`, v.input),
  );

export const useValidateDraft = () =>
  useOrgMutation((v: Ctx & { kind: 'roles' | 'workflows'; id: string }) =>
    post<ValidateResponse>(`/${v.kind}/${v.id}/validate${q(v)}`),
  );

export const useSubmitDraft = () =>
  useOrgMutation((v: Ctx & { kind: 'roles' | 'workflows'; id: string }) =>
    post<SubmitResponse>(`/${v.kind}/${v.id}/submit${q(v)}`),
  );

export const useDiscardDraft = () =>
  useOrgMutation((v: Ctx & { kind: 'roles' | 'workflows'; id: string }) => del(`/${v.kind}/${v.id}${q(v)}`));

export const useExtendRole = () =>
  useOrgMutation((v: Ctx & { roleKey: string; body: ExtendRoleRequest }) =>
    api('PUT', `/roles/${v.roleKey}/extensions${q(v)}`, v.body),
  );

export const useCreateDepartment = () =>
  useOrgMutation((v: Ctx & { body: CreateDepartmentRequest }) => post(`/departments${q(v)}`, v.body));

/** The organization's role set (`GET /api/org/role-set`, docs/bmad-roles.md). */
export function useRoleSet(projectId?: string) {
  return useQuery({
    queryKey: ['org', 'role-set', projectId ?? 'own'],
    queryFn: () => get(`/org/role-set${qs({ projectId })}`, RoleSetStatusSchema),
  });
}

export const useSetRoleSet = () =>
  useOrgMutation((v: Ctx & { body: SetRoleSetRequest }) =>
    api<RoleSetStatusResponse>('PUT', `/org/role-set${q(v)}`, v.body),
  );

/**
 * The prompt preview of a role being built (`POST /api/roles/preview`): the instructions an agent would get on a
 * sample shift. A query, so typing re-renders after a pause and the last text stays on screen meanwhile.
 */
export function useRolePreview(req: RolePreviewRequest | null, projectId?: string) {
  return useQuery({
    queryKey: ['org', 'role-preview', projectId ?? 'own', req],
    enabled: req !== null,
    placeholderData: (previous) => previous,
    queryFn: () => post(`/roles/preview${qs({ projectId })}`, req, RolePreviewResponseSchema),
  });
}
