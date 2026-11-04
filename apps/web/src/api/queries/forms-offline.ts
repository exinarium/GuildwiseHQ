import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post } from '../client.ts';

/** The desk side of the runner-offline flow (Owner and Admin): show the held address, send the link again, cancel. */
export const useShowOfflineEmail = () =>
  useMutation({
    mutationFn: (id: string) => post<{ email: string }>(`/forms/offline-requests/${id}/email`, {}),
  });

export const useResendOfflineLink = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<{ resends: number }>(`/forms/offline-requests/${id}/resend`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['desk'] }),
  });
};

export const useCancelOfflineRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/forms/offline-requests/${id}/cancel`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['desk'] });
      void qc.invalidateQueries({ queryKey: ['journey-instance'] });
    },
  });
};
