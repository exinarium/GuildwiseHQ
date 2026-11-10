import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  parseSuiteBugs,
  parseTargetLine,
  SUITE_BUGS_MAX,
  testKey,
  titleKey,
} from '../src/index.ts';

describe('parseSuiteBugs', () => {
  it('a note without sections is one bug with the fallback title and the whole note', () => {
    const r = parseSuiteBugs('Expected redirect to /home\n\n2 failed', 'Checkout total is wrong');
    expect(r).toEqual({
      preamble: '',
      overflow: 0,
      bugs: [
        {
          title: 'Checkout total is wrong',
          body: 'Expected redirect to /home\n\n2 failed',
          failureKey: 'note:checkout total is wrong',
          titleKey: 'title:checkout total is wrong',
        },
      ],
    });
  });

  it('one bug per section, the Test: line as the key, the preamble apart', () => {
    const note = [
      'Ran 120 specs against https://app.example',
      '',
      'Bug: Search returns nothing',
      'Test: search.spec.ts > finds a product',
      'Steps: type "shoe"',
      '',
      '## **Bug:** Cart badge   stays at 0',
      'Expected 1, got 0',
    ].join('\n');
    const r = parseSuiteBugs(note, 'fallback');
    expect(r.preamble).toBe('Ran 120 specs against https://app.example');
    expect(r.overflow).toBe(0);
    expect(r.bugs).toEqual([
      {
        title: 'Search returns nothing',
        test: 'search.spec.ts > finds a product',
        body: 'Steps: type "shoe"',
        failureKey: 'test:search.spec.ts > finds a product',
        titleKey: 'title:search returns nothing',
      },
      {
        title: 'Cart badge   stays at 0',
        body: 'Expected 1, got 0',
        failureKey: 'title:cart badge stays at 0',
        titleKey: 'title:cart badge stays at 0',
      },
    ]);
  });

  it('only the first non-blank line after the header can be the Test: line', () => {
    const r = parseSuiteBugs(
      'Bug: A\n\nTest: a.spec.ts > one\nBug: B\nsome text\nTest: b.spec.ts > two',
      'f',
    );
    expect(r.bugs[0]).toMatchObject({ test: 'a.spec.ts > one', body: '' });
    expect(r.bugs[1]).toMatchObject({ body: 'some text\nTest: b.spec.ts > two', failureKey: 'title:b' });
    expect(r.bugs[1]!.test).toBeUndefined();
  });

  it('sections with the same key become one bug', () => {
    const r = parseSuiteBugs('Bug: Login fails\nfirst\nBug: login   FAILS\nsecond', 'f');
    expect(r.bugs).toHaveLength(1);
    expect(r.bugs[0]!.body).toBe('first\n\nsecond');
  });

  it(`files at most ${SUITE_BUGS_MAX} bugs; the rest go into the last one`, () => {
    const note = Array.from({ length: 23 }, (_, i) => `Bug: Bug number ${i + 1}\ndetail ${i + 1}`).join('\n');
    const r = parseSuiteBugs(note, 'f');
    expect(r.bugs).toHaveLength(SUITE_BUGS_MAX);
    expect(r.overflow).toBe(3);
    expect(r.bugs.at(-1)!.body).toContain('Bug: Bug number 23\ndetail 23');
  });

  it('cuts titles and keys to 300 characters', () => {
    const long = 'x'.repeat(400);
    const r = parseSuiteBugs(`Bug: ${long}`, 'f');
    expect(r.bugs[0]!.title).toHaveLength(300);
    expect(r.bugs[0]!.titleKey).toHaveLength(300);
    expect(testKey(long)).toHaveLength(300);
  });

  it('keys normalize whitespace and case', () => {
    expect(titleKey('  Cart\tBadge  ')).toBe('title:cart badge');
    expect(testKey('a.spec.ts  >  One')).toBe('test:a.spec.ts > one');
  });
});

describe('tester instructions (v12): the multi-bug contract', () => {
  it('runs the whole suite and reports every bug in sections', () => {
    const tester = BUILTIN_ROLES.find((r) => r.key === 'tester');
    expect(tester?.instructions).toContain('never stop at the first failure');
    expect(tester?.instructions).toContain('`Bug: <short title>`');
    expect(tester?.instructions).toContain('`Test: <spec file> > <test name>`');
  });
});

describe('parseTargetLine (P3)', () => {
  it('reads the three forms', () => {
    expect(parseTargetLine('Target commit: abc1234def (contains abc1234)\nBug: x')).toEqual({
      kind: 'match',
      deployed: 'abc1234def',
      line: 'Target commit: abc1234def (contains abc1234)',
    });
    expect(parseTargetLine('  target commit: Unknown, no version endpoint')).toEqual({
      kind: 'unknown',
      deployed: null,
      line: 'target commit: Unknown, no version endpoint',
    });
    expect(parseTargetLine('Target mismatch: 9f8e7d6 from yesterday (tests abc1234)')).toEqual({
      kind: 'mismatch',
      deployed: '9f8e7d6',
      line: 'Target mismatch: 9f8e7d6 from yesterday (tests abc1234)',
    });
    expect(parseTargetLine('Target mismatch: an old build (tests abc1234)')?.deployed).toBe('abc1234');
    expect(parseTargetLine('Target mismatch: the v1.2 image')).toMatchObject({
      kind: 'mismatch',
      deployed: null,
    });
  });
  it('is null without a target line, and the first line wins', () => {
    expect(parseTargetLine('Bug: Search\nTarget is fine')).toBeNull();
    expect(parseTargetLine('Target commit: zzz not a sha')).toBeNull();
    expect(parseTargetLine('Target commit: unknown\nTarget mismatch: 1234567')?.kind).toBe('unknown');
    expect(parseTargetLine('Target mismatch: 1234567\nTarget commit: abcdef1')?.kind).toBe('mismatch');
  });
  it('parseSuiteBugs keeps the target line out of the run notes', () => {
    const r = parseSuiteBugs('Target commit: unknown\nRan 40 specs.\nBug: Search\nnone', 'f');
    expect(r.preamble).toBe('Ran 40 specs.');
  });
});

describe('tester instructions (v13): the target check', () => {
  it('declares the target commit before failures', () => {
    const tester = BUILTIN_ROLES.find((r) => r.key === 'tester');
    expect(tester?.instructions).toContain('`Target commit: unknown`');
    expect(tester?.instructions).toContain('`Target mismatch: <what it runs> (tests <commit under test>)`');
    expect(tester?.instructions).toContain('git merge-base --is-ancestor');
  });
});
