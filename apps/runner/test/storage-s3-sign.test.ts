import { describe, expect, it } from 'vitest';
import { signV4, uriEncode } from '../src/storage/s3-sign.ts';

describe('SigV4', () => {
  // The AWS documentation example "GET Object" (Signature Version 4 for S3, examples: GET Object with Range).
  it('signs the documented GET Object example', () => {
    const h = signV4({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(h.authorization).toContain('Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
    expect(h.authorization).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date');
    expect(h.authorization).toContain(
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
  it('encodes reserved characters but keeps slashes in paths', () => {
    expect(uriEncode('a b/c+d', true)).toBe('a%20b/c%2Bd');
    expect(uriEncode('a/b')).toBe('a%2Fb');
  });
  it('adds the session token to the signed headers', () => {
    const h = signV4({
      method: 'PUT',
      host: 'h',
      path: '/k',
      payloadHash: 'x'.repeat(64),
      region: 'r',
      accessKeyId: 'a',
      secretAccessKey: 's',
      sessionToken: 'tok',
      now: new Date('2020-01-01T00:00:00Z'),
    });
    expect(h['x-amz-security-token']).toBe('tok');
    expect(h.authorization).toContain('x-amz-security-token');
  });
});
