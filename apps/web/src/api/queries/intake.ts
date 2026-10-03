import {
  type CreateIntakeRequest,
  CreateIntakeResponseSchema,
  type IntakeDto,
  IntakeResponseSchema,
  IntakesResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';

export function useIntakes() {
  return useQuery({
    queryKey: ['intakes'],
    queryFn: async () => (await get('/intakes', IntakesResponseSchema)).intakes,
  });
}

export function useIntake(id: string | undefined) {
  return useQuery({
    queryKey: ['intakes', id],
    enabled: !!id,
    queryFn: async () => (await get(`/intakes/${id}`, IntakeResponseSchema)).intake as IntakeDto,
  });
}

export function useCreateIntake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: CreateIntakeRequest) =>
      (await post('/intakes', b, CreateIntakeResponseSchema)).intake as IntakeDto,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intakes'] }),
  });
}
