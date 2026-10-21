import type { ProjectDto } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { crumbsFor } from '../components/shell/Breadcrumbs.tsx';

const TOY_ID = '11111111-1111-4111-8111-111111111111';
const B2X9_ID = '22222222-2222-4222-8222-222222222222';
const projects = [
  { id: TOY_ID, key: 'TOY', name: 'Toy' },
  { id: B2X9_ID, key: 'B2X9', name: 'Other' },
] as unknown as ProjectDto[];
const UUID = '0b8f3c1e-5a7d-4e29-9c41-7d2a6e8f1b30';

describe('crumbsFor on a card page', () => {
  it('links to the board of the loaded card when the URL carries an id', () => {
    expect(crumbsFor(`/cards/${UUID}`, '', projects, { ref: 'TOY-3', projectId: TOY_ID })).toEqual([
      { label: 'Toy', to: '/p/TOY/board' },
      { label: 'TOY-3' },
    ]);
    expect(crumbsFor(`/cards/${UUID}`, '', projects, { ref: 'B2X9-12', projectId: B2X9_ID })).toEqual([
      { label: 'Other', to: '/p/B2X9/board' },
      { label: 'B2X9-12' },
    ]);
  });

  it('falls back to the ref prefix when the project is not in the list', () => {
    expect(crumbsFor(`/cards/${UUID}`, '', [], { ref: 'ZZ-1', projectId: B2X9_ID })[0]?.to).toBe(
      '/p/ZZ/board',
    );
  });

  it('never builds a board link from a card id before the card has loaded', () => {
    expect(crumbsFor(`/cards/${UUID}`, '', projects)[0]).toEqual({ label: 'Home', to: '/' });
  });

  it('still reads the project from a ref URL', () => {
    expect(crumbsFor('/cards/TOY-3', '', projects)).toEqual([
      { label: 'Toy', to: '/p/TOY/board' },
      { label: 'TOY-3' },
    ]);
  });

  it('leaves the new card page alone', () => {
    expect(crumbsFor('/cards/new', '?project=TOY', projects)).toEqual([
      { label: 'Toy', to: '/p/TOY/board' },
      { label: 'New card' },
    ]);
  });
});
