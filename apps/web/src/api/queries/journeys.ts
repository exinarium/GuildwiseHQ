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

export const useJourneyInstances = (f: {
  projectId?: string;
  journeyId?: string;
  status?: string;
  stepId?: string;
}) =>
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

// ---------------------------------------------------------------------------- waits, gates, calls and hooks

export interface InstanceWait {
  id: string;
  visit: number;
  stepId: string;
  kind: string;
  status: string;
  startedAt: string | null;
  deadlineAt: string | null;
  nextFireAt: string | null;
  remindersSent: number;
  remindersMax: number | null;
  linkUrl: string | null;
  linkExpiresAt: string | null;
  fellBack: boolean;
  resolution: string | null;
  resolvedAt: string | null;
  events: Array<{ at: string; type: string; text: string }>;
  /** The client tried the form while the firm's runner was offline (a sub-state of this form wait). */
  offline: null | {
    requestId: string;
    status: string;
    since: string;
    linkSentAt: string | null;
    linkExpiresAt: string | null;
  };
}
export interface InstanceCall {
  id: string;
  visit: number;
  stepId: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  finishedAt: string | null;
}

export const useInstanceWaits = (id: string | undefined, active = true) =>
  useQuery({
    enabled: !!id,
    queryKey: ['journey-instance', id, 'waits'],
    refetchInterval: active ? 5_000 : false,
    queryFn: () => get<{ waits: InstanceWait[]; calls: InstanceCall[] }>(`/journey-instances/${id}/waits`),
  });

function useWaitMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['journey-instance'] });
      void qc.invalidateQueries({ queryKey: ['journey-instances'] });
      void qc.invalidateQueries({ queryKey: ['desk'] });
    },
  });
}
export const useWaitAction = () =>
  useWaitMutation(
    (v: {
      waitId: string;
      action: 'continue' | 'cancel' | 'resend-link' | 'extend' | 'goto';
      body?: Record<string, unknown>;
    }) => post(`/journey-waits/${v.waitId}/${v.action}`, v.body ?? {}),
  );
export const useDecideGate = () =>
  useWaitMutation((v: { waitId: string; decision: 'approved' | 'rejected'; note?: string }) =>
    post(`/journey-gates/${v.waitId}/decide`, { decision: v.decision, ...(v.note ? { note: v.note } : {}) }),
  );

export interface HookTriggerItem {
  id: string;
  name: string;
  purpose: 'start' | 'resume';
  scheme: string;
  mapping: { externalId: string; displayName?: string };
  onNoMatch: string;
  enabled: boolean;
  createdAt: string;
  recentCalls: Array<{ at: string; status: string; outcome: string | null; sizeBytes: number | null }>;
}
export const useJourneyHooks = (journeyId: string | undefined) =>
  useQuery({
    enabled: !!journeyId,
    queryKey: ['journey-hooks', journeyId],
    queryFn: () => get<HookTriggerItem[]>(`/journeys/${journeyId}/hooks`),
  });
export function useCreateJourneyHook(journeyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      name: string;
      purpose: 'start' | 'resume';
      mapping: { externalId: string; displayName?: string };
    }) => post<{ id: string; url: string; secret: string }>(`/journeys/${journeyId}/hooks`, v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['journey-hooks', journeyId] }),
  });
}
export function useRotateJourneyHook(journeyId: string) {
  return useMutation({
    mutationFn: (hookId: string) =>
      post<{ id: string; url: string; secret: string }>(`/journeys/${journeyId}/hooks/${hookId}/rotate`, {}),
  });
}
