import type { StoredDesignSizing } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DesignSizing } from '../components/InvestigationPanel.tsx';

const base: StoredDesignSizing = {
  estimate: 640,
  unit: 'changed_lines',
  budget: 400,
  verdict: 'over_budget',
  verdictText: 'over budget',
  risk: {
    class: 'high',
    derived: 'high',
    declared: null,
    raisedByDeclaration: false,
    status: null,
    matches: [],
  },
  paths: ['apps/server/src'],
  folderScope: ['apps/server/src', 'apps/web/src'],
  seams: [
    { title: 'Server', folders: ['apps/server/src'] },
    { title: 'Web', folders: ['apps/web/src'] },
  ],
};

describe('DesignSizing on the design report', () => {
  it('AC1/AC2: shows the estimate in the unit, the over-budget verdict, the risk class and the seams', () => {
    render(<DesignSizing sizing={base} />);
    expect(screen.getByTestId('design-size-estimate').textContent).toBe('640 changed lines');
    expect(screen.getByTestId('design-size-verdict').textContent).toBe('Over budget (budget 400)');
    expect(screen.getByTestId('design-risk-class').textContent).toBe('high');
    expect(screen.getByText('apps/server/src, apps/web/src')).toBeTruthy();
    expect(screen.getByText('Web:', { exact: false })).toBeTruthy();
  });
  it('AC3: within budget', () => {
    render(
      <DesignSizing
        sizing={{ ...base, estimate: 100, verdict: 'within_budget', verdictText: 'within budget' }}
      />,
    );
    expect(screen.getByTestId('design-size-verdict').textContent).toBe('Within budget (budget 400)');
  });
  it('AC4: no budget set shows "no size budget set"', () => {
    render(
      <DesignSizing
        sizing={{
          ...base,
          unit: null,
          budget: null,
          verdict: null,
          verdictText: 'no size budget set',
          risk: { ...base.risk, class: null, derived: null, status: 'inactive: no path-to-risk map set' },
          folderScope: [],
          seams: [],
        }}
      />,
    );
    expect(screen.getByTestId('design-size-verdict').textContent).toBe('no size budget set');
    expect(screen.getByTestId('design-risk-class').textContent).toBe(
      'None: inactive: no path-to-risk map set',
    );
  });
});
