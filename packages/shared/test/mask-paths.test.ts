import { describe, expect, it } from 'vitest';
import { maskText } from '../src/platform/sanitize.ts';

describe('maskText paths', () => {
  it('a lone path keeps its last two segments', () => {
    expect(maskText('cannot open /home/u/src/app/deploy/local/docker-compose.yml now')).toBe(
      'cannot open …/local/docker-compose.yml now',
    );
  });

  it('two checkouts of the same file stay distinguishable (the P5 message read "…/local/docker-compose.yml, not from …/local/docker-compose.yml")', () => {
    const out = maskText(
      'the app was started from /home/user/projects/p5-run-trial/deploy/local/docker-compose.yml, not from /home/user/projects/mm-fixes-wt/deploy/local/docker-compose.yml. Nothing was changed',
    );
    expect(out).toContain('from …/p5-run-trial/deploy/local/docker-compose.yml,');
    expect(out).toContain('not from …/mm-fixes-wt/deploy/local/docker-compose.yml.');
  });

  it('paths with nothing in common up front are shown in full', () => {
    const out = maskText('started from /opt/a/deploy/f.yml, not from /srv/b/deploy/f.yml');
    expect(out).toBe('started from …/opt/a/deploy/f.yml, not from …/srv/b/deploy/f.yml');
  });

  it('the same path twice is still shortened as one path', () => {
    expect(maskText('/home/u/x/y/f.yml and /home/u/x/y/f.yml')).toBe('…/y/f.yml and …/y/f.yml');
  });
});
