import type { CardDto } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DependenciesPanel, dependencyLine } from '../components/DependenciesPanel.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const dep = (over: Partial<CardDto['dependencies'][number]>): CardDto['dependencies'][number] => ({
  cardId: ID(1),
  ref: 'P5-14',
  title: 'Base work',
  status: 'queued',
  landed: false,
  ...over,
});
const card = (dependencies: CardDto['dependencies'], designReview?: CardDto['designReview']) =>
  ({ dependencies, designReview: designReview ?? null }) as CardDto;

describe('dependencies on the card page', () => {
  it('says what a card waits for, and which dependencies have landed', () => {
    expect(dependencyLine(dep({}))).toEqual({ text: 'waiting for P5-14 to land', landed: false });
    expect(dependencyLine(dep({ status: 'waiting', stage: 'qa_steps', landed: true }))).toEqual({
      text: 'P5-14 landed (in manual QA)',
      landed: true,
    });
    expect(dependencyLine(dep({ status: 'done', landed: true })).text).toBe('P5-14 landed');
  });

  it('renders the lines', () => {
    render(
      <DependenciesPanel
        card={card([
          dep({}),
          dep({ cardId: ID(2), ref: 'P5-20', status: 'waiting', stage: 'qa_steps', landed: true }),
        ])}
      />,
    );
    const lines = screen.getAllByTestId('dependency-line').map((l) => l.textContent);
    expect(lines[0]).toContain('waiting for P5-14 to land');
    expect(lines[1]).toContain('P5-20 landed (in manual QA)');
  });

  it('shows the design made before the dependencies landed, then the review', () => {
    const assumptions = [{ assumption: 'greet() is sync', dependency: 'P5-14', ifWrong: 'await it' }];
    const { rerender } = render(
      <DependenciesPanel
        card={card([dep({})], { state: 'waiting', dependencies: ['P5-14'], assumptions, result: null })}
      />,
    );
    expect(screen.getByTestId('design-review')).toHaveTextContent(
      'Design made before P5-14 landed: assumptions to review',
    );
    expect(screen.getByTestId('design-review')).toHaveTextContent('greet() is sync');
    rerender(
      <DependenciesPanel
        card={card([dep({ landed: true, status: 'done' })], {
          state: 'reviewed',
          dependencies: ['P5-14'],
          assumptions,
          result: { confirmed: 3, revised: 1, note: '' },
        })}
      />,
    );
    expect(screen.getByTestId('design-review')).toHaveTextContent(
      'Assumptions reviewed: 3 confirmed, 1 revised.',
    );
  });

  it('renders nothing for a card without dependencies', () => {
    const { container } = render(<DependenciesPanel card={card([])} />);
    expect(container).toBeEmptyDOMElement();
  });
});
