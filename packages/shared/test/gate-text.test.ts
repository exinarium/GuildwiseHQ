import { describe, expect, it } from 'vitest';
import { describeGate, describeWindow } from '../src/index.ts';

describe('describeGate: the rules in sentences', () => {
  it('says each rule in plain words, with the labels of the environments', () => {
    const label = (e: string) => (e === 'test' ? 'The test site' : e);
    expect(
      describeGate(
        {
          requires: [
            { envHealthy: 'test', sameCommit: true, forMinutes: 10 },
            { checksPassed: 'regression', sameCommit: true },
            { phaseDone: true },
          ],
          window: { days: 'mon-fri', hours: '08-16', tz: 'org' },
          freeze: true,
        },
        label,
      ),
    ).toEqual([
      'The test site is healthy on the same version for 10 minutes',
      'Regression tests passed for this version',
      'The version is the result of a finished phase',
      'Only on weekdays between 08:00 and 16:00',
      'Releases are frozen: nothing goes out until the freeze is lifted',
    ]);
  });
  it('no rules, a named rule set, and odd windows', () => {
    expect(describeGate('none')).toEqual([]);
    expect(describeGate({ requires: [] })).toEqual([]);
    expect(describeGate('standard')).toEqual(['Uses the rule set "standard"']);
    expect(describeWindow({ days: 'mon,wed', hours: '22-6', tz: 'utc' })).toBe(
      'Only on Monday, Wednesday between 22:00 and 06:00 (UTC)',
    );
    expect(describeGate({ requires: [{ envHealthy: 'qa', sameCommit: true }] })).toEqual([
      'qa is running the same version and is healthy',
    ]);
  });
});
