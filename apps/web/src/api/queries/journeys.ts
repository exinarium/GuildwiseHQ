import type {
  JourneyDefinition,
  JourneyInstanceStatus,
  JourneyIssue,
  JourneyRecordDto,
  JourneyTemplate,
  JourneyValidation,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put, qs } from '../client.ts';

export interface JourneyListItem {
  id: string;
  projectId: string;
  name: string;
  recordType: 'client' | 'matter' | 'deal';
  version: number;
  stepCount: number;
  running: number;
  updatedAt: string | null;
}
export interface JourneyView {
  id: string;
  projectId: string;
  status: 'active' | 'archived';
  version: number;
  currentVersion: number;
  canEdit: boolean;
  definition: JourneyDefinition;
  validation: JourneyValidation;
}
export interface InstanceListItem {
  id: string;
  projectId: string;
  journeyId: string;
  journeyName: string;
  recordId: string;
  recordName: string;
  recordType: string;
  status: JourneyInstanceStatus;
  stepId: string;
  stepLabel: string;
  startedAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
}
export interface InstanceView {
  id: string;
  projectId: string;
  journeyId: string;
  journeyName: string;
  journeyVersion: number;
  status: JourneyInstanceStatus;
  currentVisit: number;
  currentStepId: string;
  startedAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  definition: JourneyDefinition;
  record: JourneyRecordDto;
  history: Array<{
    visit: number;
    stepId: string;
    stepLabel: string;
    handoffId: string | null;
    status: string;
    cardId: string | null;
    cardRef: string | null;
    playbookThreadId: string | null;
    enteredAt: string | null;
    startedAt: string | null;
    endedAt: string | null;
  }>;
}
export type { JourneyIssue };

export const useJourneys = (projectId?: string) =>
  useQuery({
    queryKey: ['journeys', projectId ?? null],
    queryFn: async () => (await get<{ items: JourneyListItem[] }>(`/journeys${qs({ projectId })}`)).items,
  });

export const useJourneyTemplates = () =>
  useQuery({
    queryKey: ['journey-templates'],
    staleTime: 300_000,
    queryFn: async () => (await get<{ items: JourneyTemplate[] }>('/journey-templates')).items,
  });

export const useJourney = (id: string | undefined) =>
  useQuery({
    enabled: !!id,
    queryKey: ['journey', id],
    queryFn: () => get<JourneyView>(`/journeys/${id}`),
  });

export function useCreateJourney() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { projectId: string; templateId?: string; definition?: JourneyDefinition }) =>
      post<{ id: string; version: number; validation: JourneyValidation }>('/journeys', v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['journeys'] }),
  });
}

export function useSaveJourney(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { definition: JourneyDefinition; baseVersion: number }) =>
      put<{ id: string; version: number; validation: JourneyValidation }>(`/journeys/${id}`, v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['journey', id] });
      void qc.invalidateQueries({ queryKey: ['journeys'] });
    },
  });
}

export const useJourneyInstances = (f: { projectId?: string; journeyId?: string; status?: string; stepId?: string }) =>
  useQuery({
    queryKey: ['journey-instances', f],
    refetchInterval: 10_000,
    queryFn: async () => (await get<{ items: InstanceListItem[] }>(`/journey-instances${qs(f)}`)).items,
  });

export const useJourneyInstance = (id: string | undefined) =>
  useQuery({
    enabled: !!id,
    queryKey: ['journey-instance', id],
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'completed' || s === 'cancelled' ? false : 5_000;
    },
    queryFn: () => get<InstanceView>(`/journey-instances/${id}`),
  });

function useInstanceMutation<V, R = unknown>(id: string, fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['journey-instance', id] });
      void qc.invalidateQueries({ queryKey: ['journey-instances'] });
    },
  });
}

export function useStartJourneyInstance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      journeyId: string;
      record: { recordId: string } | { type: string; displayName: string; externalId?: string };
    }) => post<{ id: string; recordId: string }>('/journey-instances', v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['journey-instances'] }),
  });
}

export const useContinueJourneyStep = (id: string) =>
  useInstanceMutation(id, (v: { visit: number }) => post(`/journey-instances/${id}/continue`, v));
export const useCancelJourneyInstance = (id: string) =>
  useInstanceMutation(id, () => post(`/journey-instances/${id}/cancel`));
export const useRunJourneyPlaybook = (id: string) =>
  useInstanceMutation(id, (v: { visit: number; workstationId?: string }) =>
    post<{ threadId: string; path: string }>(`/journey-instances/${id}/playbook`, v),
  );
