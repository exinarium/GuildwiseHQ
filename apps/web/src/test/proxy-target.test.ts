import { describe, expect, it } from 'vitest';
import { DEFAULT_API_PROXY_TARGET, resolveProxyTarget } from '../proxy-target.ts';

describe('resolveProxyTarget', () => {
  it('defaults to 127.0.0.1:4600 when unset or empty', () => {
    expect(resolveProxyTarget({})).toEqual({ target: DEFAULT_API_PROXY_TARGET });
    expect(resolveProxyTarget({ API_PROXY_TARGET: '  ' })).toEqual({ target: 'http://127.0.0.1:4600' });
  });
  it('uses API_PROXY_TARGET without rewriting Origin', () => {
    expect(resolveProxyTarget({ API_PROXY_TARGET: 'http://localhost:24150' })).toEqual({
      target: 'http://localhost:24150',
    });
  });
  it('accepts a trailing slash and https', () => {
    expect(resolveProxyTarget({ API_PROXY_TARGET: 'https://api.test:8443/' }).target).toBe(
      'https://api.test:8443',
    );
  });
  it.each(['not-a-url', 'ftp://x:1', 'http://x:1/api', 'http://u:p@x:1', 'http://x:1?a=1', 'http://x:1/#h'])(
    'rejects %s naming the variable',
    (value) => {
      expect(() => resolveProxyTarget({ API_PROXY_TARGET: value })).toThrow(/^API_PROXY_TARGET /);
    },
  );
  it('keeps the legacy alias with its Origin rewrite', () => {
    expect(resolveProxyTarget({ AOM_API_TARGET: 'http://127.0.0.1:9999' })).toEqual({
      target: 'http://127.0.0.1:9999',
      headers: { Origin: 'http://127.0.0.1:9999' },
    });
    expect(() => resolveProxyTarget({ AOM_API_TARGET: 'nope' })).toThrow(/^AOM_API_TARGET /);
  });
  it('prefers API_PROXY_TARGET when both are set', () => {
    expect(resolveProxyTarget({ API_PROXY_TARGET: 'http://a:1', AOM_API_TARGET: 'http://b:2' })).toEqual({
      target: 'http://a:1',
    });
  });
});
