import { type CardSearchResponse, CardSearchResponseSchema } from '@aom/shared';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '../client.ts';

/** Cards of the viewer's projects matching `q` (ref prefix or title text); idle below two characters. */
export function useCardSearch(q: string) {
  const text = q.trim();
  return useQuery({
    queryKey: ['card-search', text],
    enabled: text.length >= 2,
    staleTime: 15_000,
    queryFn: async () =>
      (await get<CardSearchResponse>(`/search/cards${qs({ q: text, limit: 8 })}`, CardSearchResponseSchema))
        .cards,
  });
}
