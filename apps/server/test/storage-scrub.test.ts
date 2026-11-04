import { describe, expect, it } from 'vitest';
import { scrubTokens } from '../src/commands/storage-connections.ts';

describe('scrubTokens', () => {
  it.each([
    'access_token=abc123',
    'refresh_token: 1//0gSecret',
    'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'got ya29.a0AfH6SMB-secret back',
    'code 1//0gRefreshSecret failed',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx.abc',
  ])('removes token shapes from %s', (text) => {
    const out = scrubTokens(text);
    expect(out).toContain('[removed]');
    expect(out).not.toMatch(/abc123|0gSecret|ya29|0gRefreshSecret|eyJ/);
  });
  it('leaves an ordinary sentence alone', () => {
    expect(scrubTokens('The folder does not exist and could not be created')).toBe(
      'The folder does not exist and could not be created',
    );
  });
});
